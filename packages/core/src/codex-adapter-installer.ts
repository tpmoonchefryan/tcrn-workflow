// SPDX-License-Identifier: Apache-2.0
//
// INIT-009 EPIC-023 Step 1: the Codex adapter's project-local INERT installer.
//
// This is the Codex peer of installClaudeAdapterBundle (claude-adapter-installer.ts)
// and deliberately inherits its hardening rather than inventing a second discipline:
// an absolute, already-canonical, real (non-symlink) installation root that carries
// no host segment; every file written O_EXCL 0o600 so an existing file is a refusal
// (INSTALLER_TARGET_EXISTS) and never an overwrite; a receipt that pins each file by
// content digest AND stat identity; and a fail-closed cleanup that leaves zero new
// bytes behind when any step fails.
//
// What this step deliberately does NOT do, and why the ladder has a step at all:
// nothing here touches Codex host configuration. No config.toml is read or written,
// no hook is registered, no plugin is installed, and no Codex process is started.
// The four files are inert JSON data under <root>/.codex/tcrn-workflow/, exactly the
// bytes generateCodexAdapterBundle produced. Activation — registering a hook command
// and passing Codex's per-hash trust-and-approval ceremony — is a later step that
// requires a real host and the operator's approval, and is out of scope here.
//
// Uninstall reuses the existing planCodexAdapterRollback planner plus the executor
// below, which removes only files whose bytes and stat identity still match the
// receipt: a tampered file fails INSTALLER_ROLLBACK_MISMATCH and NOTHING is removed.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { assertProtocolId, canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import {
  CODEX_ADAPTER_INSTALLATION_VERSION,
  validateCodexAdapterBundle,
} from "./codex-adapter.js";
import type {
  CodexAdapterBundle,
  CodexAdapterInstallationEntry,
  CodexAdapterInstallationFileIdentity,
  CodexAdapterInstallationReceipt,
} from "./codex-adapter.js";

export const CODEX_ADAPTER_INSTALLER_REASON_CODES = Object.freeze([
  "INSTALLER_ROOT_INVALID",
  "INSTALLER_TARGET_EXISTS",
  "INSTALLER_WRITE_FAILED",
  "INSTALLER_ROLLBACK_MISMATCH",
  "INSTALLER_ROLLBACK_EXECUTED",
] as const);

export type CodexAdapterInstallerReasonCode = typeof CODEX_ADAPTER_INSTALLER_REASON_CODES[number];

export interface CodexAdapterInstallOptions {
  readonly installationRoot: string;
  readonly generationId: string;
  readonly receiptPath: string;
}

export interface CodexAdapterInstallResult {
  readonly receipt: CodexAdapterInstallationReceipt;
  readonly authority: CodexAdapterInstallationFileIdentity;
}

export interface CodexAdapterRollbackResult {
  readonly reasonCode: "INSTALLER_ROLLBACK_EXECUTED";
  readonly planDigest: string;
  readonly removedCount: number;
}

const exclusiveWriteFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const shaPattern = /^[a-f0-9]{64}$/u;
const ROLLBACK_PLAN_VERSION = "tcrn.codex-adapter-rollback-plan.v1";

export class CodexAdapterInstallerError extends Error {
  readonly reasonCode: CodexAdapterInstallerReasonCode;
  constructor(reasonCode: CodexAdapterInstallerReasonCode, message: string) {
    super(message);
    this.name = "CodexAdapterInstallerError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: CodexAdapterInstallerReasonCode, message: string): never {
  throw new CodexAdapterInstallerError(reasonCode, message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function record(value: unknown, message: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("INSTALLER_ROLLBACK_MISMATCH", message);
  return value as Readonly<Record<string, unknown>>;
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && (value as { code?: unknown }).code === code;
}

type StatIdentity = Awaited<ReturnType<typeof lstat>>;

// Byte-compatible with the reader in codex-adapter.ts (private identityDigest):
// canonical sha256 over the stat identity fields as strings.
function identityDigest(value: StatIdentity): string {
  return canonicalSha256({ dev: String(value.dev), ino: String(value.ino), size: String(value.size), mtimeMs: String(value.mtimeMs), ctimeMs: String(value.ctimeMs) });
}

function contentSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// A governed installation root is absolute, already canonical, a real directory (not
// a symlink), and carries no host segment of its own — the same guard the Claude
// installer applies, so a root like /tmp/x/.codex cannot nest a second host tree.
async function admitInstallationRoot(installationRoot: string): Promise<string> {
  if (typeof installationRoot !== "string" || installationRoot.length === 0 || !installationRoot.isWellFormed()) fail("INSTALLER_ROOT_INVALID", "installation root");
  if (!isAbsolute(installationRoot) || resolve(installationRoot) !== installationRoot) fail("INSTALLER_ROOT_INVALID", "installation root not canonical");
  if (installationRoot.split(sep).some((segment) => segment === ".claude" || segment === ".codex")) fail("INSTALLER_ROOT_INVALID", "installation root carries a host segment");
  let rootReal: string;
  let rootStat: StatIdentity;
  try {
    rootReal = await realpath(installationRoot);
    rootStat = await lstat(installationRoot);
  } catch {
    fail("INSTALLER_ROOT_INVALID", "installation root not present");
  }
  if (rootReal !== installationRoot || rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("INSTALLER_ROOT_INVALID", "installation root not a real directory");
  return installationRoot;
}

// The receipt lives OUTSIDE installationRoot/.codex so the receipt's entry set stays
// the closed set of four templates that readCodexAdapterInstallationReceipt enforces.
function admitReceiptPath(installationRoot: string, receiptPath: string): string {
  if (typeof receiptPath !== "string" || receiptPath.length === 0 || !receiptPath.isWellFormed()) fail("INSTALLER_ROOT_INVALID", "receipt path");
  if (!isAbsolute(receiptPath) || resolve(receiptPath) !== receiptPath) fail("INSTALLER_ROOT_INVALID", "receipt path not canonical");
  const codexDirectory = resolve(installationRoot, ".codex");
  if (receiptPath === codexDirectory || receiptPath.startsWith(`${codexDirectory}${sep}`)) fail("INSTALLER_ROOT_INVALID", "receipt path under .codex");
  return receiptPath;
}

async function writeExclusive(path: string, bytes: Buffer, message: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, exclusiveWriteFlags, 0o600);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) fail("INSTALLER_TARGET_EXISTS", message);
    fail("INSTALLER_WRITE_FAILED", message);
  }
  try {
    await handle.writeFile(bytes);
  } catch {
    fail("INSTALLER_WRITE_FAILED", message);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// Step 1. Write the validated inert bundle under <root>/.codex/tcrn-workflow/ and
// emit the canonical installation-generation receipt. No Codex host configuration is
// read or written; no hook is registered; nothing is activated.
export async function installCodexAdapterBundle(bundleValue: unknown, options: CodexAdapterInstallOptions): Promise<CodexAdapterInstallResult> {
  const bundle: CodexAdapterBundle = validateCodexAdapterBundle(bundleValue);
  const installationRoot = await admitInstallationRoot(options.installationRoot);
  const receiptPath = admitReceiptPath(installationRoot, options.receiptPath);
  const generationId = options.generationId;
  // The receipt reader validates generationId as a protocol id, so the producer must
  // hold the same bar: otherwise an install writes a receipt its own reader refuses,
  // and the installation can never be read back or uninstalled. Caught by act4.
  if (typeof generationId !== "string" || generationId.length === 0 || !generationId.isWellFormed()) fail("INSTALLER_ROOT_INVALID", "generation id");
  try {
    assertProtocolId(generationId);
  } catch {
    fail("INSTALLER_ROOT_INVALID", "generation id is not a protocol id");
  }

  const workflowDirectory = resolve(installationRoot, ".codex", "tcrn-workflow");
  const writtenTargets: string[] = [];
  let createdRoot: string | undefined;
  try {
    createdRoot = await mkdir(workflowDirectory, { recursive: true, mode: 0o700 });
    const entries: CodexAdapterInstallationEntry[] = [];
    for (const file of bundle.files) {
      const target = resolve(installationRoot, file.path);
      await writeExclusive(target, Buffer.from(file.content, "utf8"), file.path);
      writtenTargets.push(target);
      const stat = await lstat(target);
      entries.push({ path: file.path, realpath: await realpath(target), contentDigest: file.contentDigest, identityDigest: identityDigest(stat) });
    }
    const basis = { schemaVersion: CODEX_ADAPTER_INSTALLATION_VERSION, generationId, bundleDigest: bundle.bundleDigest, installationRoot, entries };
    const receipt: CodexAdapterInstallationReceipt = { ...basis, receiptDigest: canonicalSha256(basis) };
    const receiptBytes = Buffer.from(canonicalJson(receipt), "utf8");
    await writeExclusive(receiptPath, receiptBytes, "installation receipt");
    const authority: CodexAdapterInstallationFileIdentity = { expectedCanonicalPath: await realpath(receiptPath), expectedFileSha256: contentSha256(receiptBytes) };
    return deepFreeze({ receipt, authority });
  } catch (error) {
    // Fail closed with zero new files.
    for (const target of writtenTargets.reverse()) await unlink(target).catch(() => undefined);
    if (createdRoot !== undefined) await rm(createdRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

interface RollbackRemoval {
  readonly path: string;
  readonly realpath: string;
  readonly contentDigest: string;
  readonly identityDigest: string;
}

function admitRollbackPlan(planValue: unknown): { readonly planDigest: string; readonly removals: readonly RollbackRemoval[] } {
  const plan = record(planValue, "rollback plan");
  if (plan.schemaVersion !== ROLLBACK_PLAN_VERSION || plan.reasonCode !== "ADAPTER_ROLLBACK_PLANNED" || plan.activation !== false) fail("INSTALLER_ROLLBACK_MISMATCH", "rollback plan header");
  if (!Array.isArray(plan.removals) || plan.removals.length === 0) fail("INSTALLER_ROLLBACK_MISMATCH", "rollback plan removals");
  const removals = plan.removals.map((entry, index) => {
    const item = record(entry, `rollback removal ${index}`);
    const path = item.path;
    const removalRealpath = item.realpath;
    if (typeof path !== "string" || typeof removalRealpath !== "string" || !isAbsolute(removalRealpath) || resolve(removalRealpath) !== removalRealpath) fail("INSTALLER_ROLLBACK_MISMATCH", `rollback removal path ${index}`);
    if (typeof item.contentDigest !== "string" || !shaPattern.test(item.contentDigest) || typeof item.identityDigest !== "string" || !shaPattern.test(item.identityDigest)) fail("INSTALLER_ROLLBACK_MISMATCH", `rollback removal digest ${index}`);
    return { path, realpath: removalRealpath, contentDigest: item.contentDigest, identityDigest: item.identityDigest };
  });
  const basis = {
    generationId: plan.generationId,
    bundleDigest: plan.bundleDigest,
    installationReceiptDigest: plan.installationReceiptDigest,
    installationSourceIdentityDigest: plan.installationSourceIdentityDigest,
    removals: removals.map((removal) => ({ path: removal.path, realpath: removal.realpath, contentDigest: removal.contentDigest, identityDigest: removal.identityDigest })),
  };
  if (typeof plan.planDigest !== "string" || canonicalSha256(basis) !== plan.planDigest) fail("INSTALLER_ROLLBACK_MISMATCH", "rollback plan digest");
  return { planDigest: plan.planDigest, removals };
}

// Consumes planCodexAdapterRollback's output and removes only files whose on-disk
// bytes AND stat identity still exactly match the receipt. Every removal is verified
// BEFORE anything is removed, so a single tampered file fails
// INSTALLER_ROLLBACK_MISMATCH with nothing removed. After the templates are unlinked
// the emptied .codex/tcrn-workflow directory and the receipt file are removed.
export async function executeCodexAdapterRollback(planValue: unknown, receiptPath: string): Promise<CodexAdapterRollbackResult> {
  const { planDigest, removals } = admitRollbackPlan(planValue);
  // Pass one: verify every target.
  for (const removal of removals) {
    let stat: StatIdentity;
    try {
      stat = await lstat(removal.realpath);
    } catch {
      fail("INSTALLER_ROLLBACK_MISMATCH", removal.path);
    }
    if (stat.isSymbolicLink() || stat.nlink !== 1 || !stat.isFile()) fail("INSTALLER_ROLLBACK_MISMATCH", removal.path);
    let handle;
    try {
      handle = await open(removal.realpath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      fail("INSTALLER_ROLLBACK_MISMATCH", removal.path);
    }
    let content: Buffer;
    try {
      const opened = await handle.stat();
      content = await handle.readFile();
      if (!opened.isFile() || opened.nlink !== 1 || content.length !== opened.size) fail("INSTALLER_ROLLBACK_MISMATCH", removal.path);
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (contentSha256(content) !== removal.contentDigest || identityDigest(stat) !== removal.identityDigest) fail("INSTALLER_ROLLBACK_MISMATCH", removal.path);
  }
  // Pass two: every target matched — remove them, then the emptied control directory
  // and the receipt file.
  for (const removal of removals) await unlink(removal.realpath);
  const workflowDirectory = dirname(removals[0]?.realpath ?? "");
  if (workflowDirectory.length > 0) await rmdir(workflowDirectory).catch(() => undefined);
  const receiptStat = await lstat(receiptPath).catch(() => undefined);
  if (receiptStat && !receiptStat.isSymbolicLink() && receiptStat.isFile() && receiptStat.nlink === 1) await unlink(receiptPath).catch(() => undefined);
  return deepFreeze({ reasonCode: "INSTALLER_ROLLBACK_EXECUTED" as const, planDigest, removedCount: removals.length });
}
