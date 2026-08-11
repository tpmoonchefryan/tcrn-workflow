// SPDX-License-Identifier: Apache-2.0
//
// INIT-009 EPIC-023: the Codex adapter's project-local installer.
//
// This is the Codex peer of installClaudeAdapterBundle (claude-adapter-installer.ts)
// and deliberately inherits its hardening rather than inventing a second discipline:
// an absolute, already-canonical, real (non-symlink) installation root that carries
// no host segment; every file written O_EXCL 0o600 so an existing file is a refusal
// (INSTALLER_TARGET_EXISTS) and never an overwrite; a receipt that pins each file by
// content digest AND stat identity; and a fail-closed cleanup that leaves zero new
// bytes behind when any step fails.
//
// installCodexAdapterBundle is Step 1 and deliberately touches no Codex host
// configuration: the four files are inert JSON data under
// <root>/.codex/tcrn-workflow/. installCodexAdapterActivation is the additive
// S066/S067 rung lower in this file: it requires a descriptor-bound Step-1 receipt,
// writes one SessionStart definition plus its handler/summary, and still cannot
// approve itself. Codex's /hooks review remains an operator/host action and only a
// separate observed receipt may claim that the exact definition fired.
//
// Uninstall reuses the existing planCodexAdapterRollback planner plus the executor
// below, which removes only files whose bytes and stat identity still match the
// receipt: a tampered file fails INSTALLER_ROLLBACK_MISMATCH and NOTHING is removed.

import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { assertProtocolId, canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import {
  CODEX_ADAPTER_INSTALLATION_VERSION,
  planCodexAdapterRollback,
  validateCodexAdapterBundle,
} from "./codex-adapter.js";
import type {
  CodexAdapterBundle,
  CodexAdapterInstallationContext,
  CodexAdapterInstallationEntry,
  CodexAdapterInstallationFileIdentity,
  CodexAdapterInstallationReceipt,
} from "./codex-adapter.js";
import {
  CODEX_ADAPTER_ACTIVATION_INSTALLATION_VERSION,
  CODEX_ACTIVATION_PATHS,
  CODEX_HOOKS_PATH,
  CODEX_OBSERVE_HANDLER_PATH,
  CODEX_SESSION_START_PATH,
  CODEX_SESSION_SUMMARY_PATH,
  assertCodexAdapterActivationHost,
  assertCodexActivationReceiptContext,
  codexHookDefinitionForDigests,
  removeCodexAdapterHookFragment,
  validateCodexActivationArtifacts,
} from "./codex-adapter-activation.js";
import type {
  CodexAdapterActivationHostContext,
  CodexActivationArtifacts,
  CodexActivationInstallationEntry,
  CodexActivationInstallationReceipt,
  CodexActivationReceiptContext,
} from "./codex-adapter-activation.js";

export const CODEX_ADAPTER_INSTALLER_REASON_CODES = Object.freeze([
  "INSTALLER_ACTIVATION_PRECONDITION",
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

export interface CodexAdapterActivationInstallOptions {
  readonly installationRoot: string;
  readonly generationId: string;
  readonly receiptPath: string;
}

export interface CodexAdapterActivationInstallResult {
  readonly receipt: CodexActivationInstallationReceipt;
  readonly authority: CodexAdapterInstallationFileIdentity;
  readonly sourceIdentityDigest: string;
}

export interface CodexAdapterActivationUninstallResult {
  readonly reasonCode: "INSTALLER_ROLLBACK_EXECUTED";
  readonly receiptDigest: string;
  readonly removedCount: number;
  readonly retainedHostTrustBoundary: string;
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
export async function admitCodexAdapterInstallationRoot(
  installationRoot: string,
): Promise<string> {
  if (typeof installationRoot !== "string" || installationRoot.length === 0 || !installationRoot.isWellFormed()) fail("INSTALLER_ROOT_INVALID", "installation root");
  if (!isAbsolute(installationRoot) || resolve(installationRoot) !== installationRoot) fail("INSTALLER_ROOT_INVALID", "installation root not canonical");
  if (installationRoot.split(sep).some((segment) => segment === ".claude" || segment === ".codex")) fail("INSTALLER_ROOT_INVALID", "installation root carries a host segment");
  // INC-005: the segment check above rejects a root INSIDE a host tree but not the home
  // directory itself, so `--installation-root $HOME` wrote ~/.codex/hooks.json and the
  // handler under the user's own Codex config root -- the one place every boundary
  // statement in this project promises never to touch. The filesystem root is refused
  // for the same reason, plus any ancestor of the home directory, since installing at
  // one still lands the host tree above the user's project space.
  const home = homedir();
  if (installationRoot === home || installationRoot === sep) fail("INSTALLER_ROOT_INVALID", "installation root is the home or filesystem root");
  if (typeof home === "string" && home.length > 0 && home.startsWith(`${installationRoot}${sep}`)) fail("INSTALLER_ROOT_INVALID", "installation root is an ancestor of the home directory");
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
  // INC-005: forbidding the receipt under <root>/.codex left every path OUTSIDE the root
  // admissible, so `--receipt-out ~/.codex/activation-receipt.json` created a file in the
  // user's Codex config root while the install itself stayed project-local. The receipt
  // belongs to the installation, so it must live inside the root it describes.
  if (!receiptPath.startsWith(`${installationRoot}${sep}`)) fail("INSTALLER_ROOT_INVALID", "receipt path is outside the installation root");
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

async function readPinnedInstalledFile(
  entry: CodexAdapterInstallationEntry,
): Promise<void> {
  let stat: StatIdentity;
  try {
    stat = await lstat(entry.realpath);
  } catch {
    fail("INSTALLER_ACTIVATION_PRECONDITION", entry.path);
  }
  if (stat.isSymbolicLink() || stat.nlink !== 1 || !stat.isFile()) {
    fail("INSTALLER_ACTIVATION_PRECONDITION", entry.path);
  }
  let handle;
  try {
    handle = await open(entry.realpath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("INSTALLER_ACTIVATION_PRECONDITION", entry.path);
  }
  try {
    const opened = await handle.stat();
    const content = await handle.readFile();
    const after = await handle.stat();
    const named = await lstat(entry.realpath);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      content.length !== after.size ||
      contentSha256(content) !== entry.contentDigest ||
      identityDigest(stat) !== entry.identityDigest
    ) {
      fail("INSTALLER_ACTIVATION_PRECONDITION", entry.path);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// Step 1. Write the validated inert bundle under <root>/.codex/tcrn-workflow/ and
// emit the canonical installation-generation receipt. No Codex host configuration is
// read or written; no hook is registered; nothing is activated.
export async function installCodexAdapterBundle(bundleValue: unknown, options: CodexAdapterInstallOptions): Promise<CodexAdapterInstallResult> {
  const bundle: CodexAdapterBundle = validateCodexAdapterBundle(bundleValue);
  const installationRoot = await admitCodexAdapterInstallationRoot(
    options.installationRoot,
  );
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

// S066/S067 Step 2/3. The independently-read Step-1 receipt is required and
// rechecked immediately before activation. The handler and summary are written
// first; .codex/hooks.json is the final activation-file commit point. The emitted
// receipt deliberately remains pending_host_approval: only Codex's /hooks ceremony
// followed by an observed fire can produce a host-activation receipt.
export async function installCodexAdapterActivation(
  bundleValue: unknown,
  inertInstallation: CodexAdapterInstallationContext,
  artifactsValue: unknown,
  activationHost: CodexAdapterActivationHostContext | undefined,
  options: CodexAdapterActivationInstallOptions,
): Promise<CodexAdapterActivationInstallResult> {
  const bundle = validateCodexAdapterBundle(bundleValue);
  // planCodexAdapterRollback owns the WeakSet brand for descriptor-bound Step-1
  // receipts. Calling it here verifies both that brand and the bundle binding.
  planCodexAdapterRollback(bundle, inertInstallation);
  const installationRoot = await admitCodexAdapterInstallationRoot(
    options.installationRoot,
  );
  const artifacts: CodexActivationArtifacts =
    validateCodexActivationArtifacts(artifactsValue);
  if (artifacts.installationRoot !== installationRoot) {
    fail("INSTALLER_ACTIVATION_PRECONDITION", "artifact installation root");
  }
  const admittedActivation = assertCodexAdapterActivationHost(
    bundle,
    inertInstallation.receipt,
    artifacts,
    activationHost,
  );
  const receiptPath = admitReceiptPath(installationRoot, options.receiptPath);
  if (inertInstallation.receipt.installationRoot !== installationRoot) {
    fail("INSTALLER_ACTIVATION_PRECONDITION", "installation root");
  }
  const generationId = options.generationId;
  if (
    typeof generationId !== "string" ||
    generationId.length === 0 ||
    !generationId.isWellFormed()
  ) {
    fail("INSTALLER_ROOT_INVALID", "generation id");
  }
  try {
    assertProtocolId(generationId);
  } catch {
    fail("INSTALLER_ROOT_INVALID", "generation id is not a protocol id");
  }
  for (const entry of inertInstallation.receipt.entries) {
    await readPinnedInstalledFile(entry);
  }

  const sources = new Map<string, string>([
    [CODEX_SESSION_START_PATH, artifacts.handlerSource],
    [CODEX_SESSION_SUMMARY_PATH, artifacts.summarySource],
    [CODEX_HOOKS_PATH, artifacts.hooksSource],
  ]);
  const activationPaths: (typeof CODEX_ACTIVATION_PATHS)[number][] = [
    CODEX_SESSION_START_PATH,
    CODEX_SESSION_SUMMARY_PATH,
  ];
  if (artifacts.observeHandlerSource !== null) {
    sources.set(CODEX_OBSERVE_HANDLER_PATH, artifacts.observeHandlerSource);
    activationPaths.push(CODEX_OBSERVE_HANDLER_PATH);
  }
  activationPaths.push(CODEX_HOOKS_PATH);
  const writtenTargets: string[] = [];
  let receiptWritten = false;
  try {
    const entries: CodexActivationInstallationEntry[] = [];
    // Safety order: dependencies before the registration that invokes them.
    for (const path of activationPaths) {
      const target = resolve(installationRoot, path);
      const bytes = Buffer.from(sources.get(path) ?? "", "utf8");
      await writeExclusive(target, bytes, path);
      writtenTargets.push(target);
      const stat = await lstat(target);
      entries.push({
        path,
        realpath: await realpath(target),
        contentDigest: contentSha256(bytes),
        identityDigest: identityDigest(stat),
      });
    }
    entries.sort((left, right) => compareCanonicalPath(left.path, right.path));
    const basis = {
      schemaVersion: CODEX_ADAPTER_ACTIVATION_INSTALLATION_VERSION,
      generationId,
      bundleDigest: bundle.bundleDigest,
      inertInstallationReceiptDigest:
        inertInstallation.receipt.receiptDigest,
      activationAuthorityDigest: admittedActivation.hostDigest,
      installationRoot,
      artifactsDigest: artifacts.artifactsDigest,
      binding: artifacts.binding,
      entries,
      approvedHookDefinitionDigests: Object.freeze([]) as readonly [],
      activationState: "pending_host_approval" as const,
      hostTrustHashRepresentation: "opaque_not_exported" as const,
      installationDoesNotProveActivation: true as const,
    };
    const receipt: CodexActivationInstallationReceipt = {
      ...basis,
      receiptDigest: canonicalSha256(basis),
    };
    const receiptBytes = Buffer.from(canonicalJson(receipt), "utf8");
    await writeExclusive(
      receiptPath,
      receiptBytes,
      "activation installation receipt",
    );
    receiptWritten = true;
    const authority: CodexAdapterInstallationFileIdentity = {
      expectedCanonicalPath: await realpath(receiptPath),
      expectedFileSha256: contentSha256(receiptBytes),
    };
    const sourceIdentityDigest = identityDigest(await lstat(receiptPath));
    return deepFreeze({ receipt, authority, sourceIdentityDigest });
  } catch (error) {
    // Unregister first if the final activation file was reached, then remove the
    // dependencies this call created. The inert Step-1 files remain untouched.
    for (const target of [...writtenTargets].reverse()) {
      await unlink(target).catch(() => undefined);
    }
    if (receiptWritten) await unlink(receiptPath).catch(() => undefined);
    throw error;
  }
}

function compareCanonicalPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function verifyActivationEntry(
  entry: CodexActivationInstallationEntry,
): Promise<void> {
  let stat: StatIdentity;
  try {
    stat = await lstat(entry.realpath);
  } catch {
    fail("INSTALLER_ROLLBACK_MISMATCH", entry.path);
  }
  if (stat.isSymbolicLink() || stat.nlink !== 1 || !stat.isFile()) {
    fail("INSTALLER_ROLLBACK_MISMATCH", entry.path);
  }
  let handle;
  try {
    handle = await open(entry.realpath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("INSTALLER_ROLLBACK_MISMATCH", entry.path);
  }
  try {
    const opened = await handle.stat();
    const content = await handle.readFile();
    const after = await handle.stat();
    const named = await lstat(entry.realpath);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      content.length !== after.size ||
      contentSha256(content) !== entry.contentDigest ||
      identityDigest(stat) !== entry.identityDigest
    ) {
      fail("INSTALLER_ROLLBACK_MISMATCH", entry.path);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function verifyActivationReceiptSource(
  context: CodexActivationReceiptContext,
): Promise<void> {
  let stat: StatIdentity;
  let bigStat: BigIntStats;
  try {
    stat = await lstat(context.sourcePath);
    bigStat = await lstat(context.sourcePath, { bigint: true });
  } catch {
    fail("INSTALLER_ROLLBACK_MISMATCH", "activation receipt");
  }
  const authorityIdentityDigest = canonicalSha256({
    dev: bigStat.dev.toString(),
    ino: bigStat.ino.toString(),
    size: bigStat.size.toString(),
    mode: bigStat.mode.toString(),
    mtimeNs: bigStat.mtimeNs.toString(),
    ctimeNs: bigStat.ctimeNs.toString(),
  });
  if (
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    !stat.isFile() ||
    authorityIdentityDigest !== context.sourceIdentityDigest
  ) {
    fail("INSTALLER_ROLLBACK_MISMATCH", "activation receipt");
  }
  let handle;
  try {
    handle = await open(
      context.sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    fail("INSTALLER_ROLLBACK_MISMATCH", "activation receipt");
  }
  try {
    const opened = await handle.stat();
    const content = await handle.readFile();
    const after = await handle.stat();
    const named = await lstat(context.sourcePath);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      content.length !== after.size ||
      contentSha256(content) !== context.authorityFileSha256
    ) {
      fail("INSTALLER_ROLLBACK_MISMATCH", "activation receipt");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function managedCodexHookFragment(
  receipt: CodexActivationInstallationReceipt,
): Promise<string> {
  const observeEntry = receipt.entries.find((entry) => entry.path === CODEX_OBSERVE_HANDLER_PATH);
  let observeEvents: string[] = [];
  let observeHandlerDigest: string | null = null;
  if (observeEntry !== undefined) {
    const source = await readFile(observeEntry.realpath, "utf8").catch(() => {
      fail("INSTALLER_ROLLBACK_MISMATCH", CODEX_OBSERVE_HANDLER_PATH);
    });
    const match = source.match(/const EVENTS = (\[[^\n]+\]);/u);
    if (match === null) fail("INSTALLER_ROLLBACK_MISMATCH", "observe event manifest");
    try {
      const parsed: unknown = JSON.parse(match[1] ?? "");
      if (!Array.isArray(parsed) || parsed.some((event) => typeof event !== "string")) fail("INSTALLER_ROLLBACK_MISMATCH", "observe event manifest");
      observeEvents = parsed as string[];
    } catch {
      fail("INSTALLER_ROLLBACK_MISMATCH", "observe event manifest");
    }
    observeHandlerDigest = contentSha256(Buffer.from(source, "utf8"));
  }
  return codexHookDefinitionForDigests(
    receipt.installationRoot,
    receipt.binding.handlerDigest,
    receipt.binding.summaryFileDigest,
    observeEvents,
    observeHandlerDigest,
  ).source;
}

// Reverse only the activation rung. Every entry is verified before any unlink.
// hooks.json is removed first, then the handler and summary; the inert Step-1
// bundle stays installed. Codex may retain its host-owned approval for the old
// exact definition, but with no project hook definition there is no active hook.
export async function uninstallCodexAdapterActivation(
  contextValue: CodexActivationReceiptContext,
): Promise<CodexAdapterActivationUninstallResult> {
  const context = assertCodexActivationReceiptContext(contextValue);
  const receipt = context.receipt;
  await verifyActivationReceiptSource(context);
  for (const entry of receipt.entries) {
    // hooks.json is a two-zone document. It may have acquired user-owned hook
    // entries after installation, so its whole-file identity is not a valid
    // rollback precondition. The managed fragment is checked and removed below;
    // every other TCRN-owned file remains byte-and-identity pinned here.
    if (entry.path !== CODEX_HOOKS_PATH) await verifyActivationEntry(entry);
  }
  const hooksEntry = receipt.entries.find(
    (entry) => entry.path === CODEX_HOOKS_PATH,
  );
  if (hooksEntry === undefined) {
    fail("INSTALLER_ROLLBACK_MISMATCH", CODEX_HOOKS_PATH);
  }
  const currentHooks = await readFile(hooksEntry.realpath, "utf8").catch(() => {
    fail("INSTALLER_ROLLBACK_MISMATCH", CODEX_HOOKS_PATH);
  });
  let remainingHooks: string;
  try {
    remainingHooks = removeCodexAdapterHookFragment(
      currentHooks,
      await managedCodexHookFragment(receipt),
    );
  } catch (error) {
    if (error instanceof CodexAdapterInstallerError) throw error;
    fail("INSTALLER_ROLLBACK_MISMATCH", CODEX_HOOKS_PATH);
  }
  // INC-010: count what was actually removed rather than reporting the constant path
  // count. The managed fragment is removed FIRST; a user-owned remainder is written
  // back atomically and survives. If no user zone remains, the empty registration
  // file is removed just as the legacy installer did.
  let removed = 0;
  const remainingDocument = JSON.parse(remainingHooks) as Record<string, unknown>;
  if (Object.keys(remainingDocument).length === 0) {
    await unlink(hooksEntry.realpath);
  } else {
    const temporary = `${hooksEntry.realpath}.tcrn-remove-tmp`;
    try {
      await writeFile(temporary, Buffer.from(remainingHooks, "utf8"), { flag: "wx", mode: 0o600 });
      await rename(temporary, hooksEntry.realpath);
    } catch {
      await unlink(temporary).catch(() => undefined);
      fail("INSTALLER_ROLLBACK_MISMATCH", CODEX_HOOKS_PATH);
    }
  }
  removed += 1;
  for (const entry of receipt.entries) {
    if (entry.path !== CODEX_HOOKS_PATH) {
      await unlink(entry.realpath);
      removed += 1;
    }
  }
  const receiptStat = await lstat(context.sourcePath).catch(() => undefined);
  if (
    receiptStat &&
    !receiptStat.isSymbolicLink() &&
    receiptStat.isFile() &&
    receiptStat.nlink === 1
  ) {
    await unlink(context.sourcePath);
  }
  return deepFreeze({
    reasonCode: "INSTALLER_ROLLBACK_EXECUTED" as const,
    receiptDigest: receipt.receiptDigest,
    removedCount: removed,
    retainedHostTrustBoundary:
      "Codex may retain host-owned approval for the removed exact definition; no project hook remains active",
  });
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
