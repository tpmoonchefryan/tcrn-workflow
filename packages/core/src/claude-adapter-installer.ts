// SPDX-License-Identifier: Apache-2.0

// WSG-2 Step-1 governed project-local installer (activation ladder v1, Step 1;
// docs/activation/activation-ladder-v1.md). This module is the missing producer
// for the TOCTOU-hardened consumers in claude-adapter.ts
// (readClaudeAdapterInstallationReceipt / planClaudeAdapterRollback): it writes
// the four inert bundle templates under <projectRoot>/.claude/tcrn-workflow/ and
// emits the existing tcrn.claude-adapter-installation-generation.v1 receipt that
// those readers accept unmodified. It never touches .claude/settings.json (that
// is WSG-3, Step 2), registers no hook, and runs nothing — the install is inert
// data on disk, exactly the ladder's Step-1 intent. Reason codes live in this
// module's own frozen list so claude-adapter.ts stays byte-identical; the private
// identityDigest machinery is duplicated per the duplicate-machinery discipline.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import {
  CLAUDE_ADAPTER_INSTALLATION_VERSION,
  CLAUDE_ADAPTER_TEMPLATE_PATHS,
  assertNoForbiddenClaudePaths,
  validateClaudeAdapterBundle,
} from "./claude-adapter.js";
import type {
  ClaudeAdapterBundle,
  ClaudeAdapterInstallationEntry,
  ClaudeAdapterInstallationFileIdentity,
  ClaudeAdapterInstallationReceipt,
} from "./claude-adapter.js";
import {
  CLAUDE_ADAPTER_INSTALLATION_V2_VERSION,
  CLAUDE_ADAPTER_PERSONA_RENDER_PATH,
  CLAUDE_ADAPTER_SESSION_START_PATH,
  mergeClaudeAdapterActivationFragment,
  validateClaudeAdapterActivationFragment,
} from "./claude-adapter-activation.js";
import type {
  ClaudeAdapterActivationInstallationEntry,
  ClaudeAdapterActivationInstallationReceipt,
} from "./claude-adapter-activation.js";

export const CLAUDE_ADAPTER_INSTALLER_REASON_CODES = Object.freeze([
  "INSTALLER_ACTIVATION_PRECONDITION",
  "INSTALLER_RECEIPT_WRITTEN",
  "INSTALLER_ROLLBACK_EXECUTED",
  "INSTALLER_ROLLBACK_MISMATCH",
  "INSTALLER_ROOT_INVALID",
  "INSTALLER_TARGET_EXISTS",
  "INSTALLER_WRITE_FAILED",
] as const);

export type ClaudeAdapterInstallerReasonCode = typeof CLAUDE_ADAPTER_INSTALLER_REASON_CODES[number];

export interface ClaudeAdapterInstallOptions {
  readonly installationRoot: string;
  readonly generationId: string;
  readonly receiptPath: string;
}

export interface ClaudeAdapterInstallResult {
  readonly receipt: ClaudeAdapterInstallationReceipt;
  readonly authority: ClaudeAdapterInstallationFileIdentity;
}

export interface ClaudeAdapterRollbackResult {
  readonly reasonCode: "INSTALLER_ROLLBACK_EXECUTED";
  readonly planDigest: string;
  readonly removedCount: number;
}

export interface ClaudeAdapterActivationInstallOptions {
  readonly installationRoot: string;
  readonly generationId: string;
  readonly receiptPath: string;
  readonly bundleDigest: string;
  readonly fragment: unknown;
  readonly scriptSource: string;
  // WSG-4 Step-3: the canonical persona render document. When present it is written
  // to .claude/tcrn-workflow/persona-render.json (O_EXCL 0o600) and recorded as an
  // additional receipt entry so the render rides the v2 receipt and WSG-2 rollback
  // removes it byte-inverse; when absent the install is byte-identical to Step-2.
  readonly renderSource?: string;
  // Fires between the settings merge and the rename that commits it, so the
  // interference recheck below has an executable window to be tested through.
  readonly beforeSettingsCommitForTest?: () => Promise<void>;
}

export interface ClaudeAdapterActivationInstallResult {
  readonly receipt: ClaudeAdapterActivationInstallationReceipt;
  readonly authority: ClaudeAdapterInstallationFileIdentity;
  readonly sourceIdentityDigest: string;
  readonly settingsPath: string;
}

const ROLLBACK_PLAN_VERSION = "tcrn.claude-adapter-rollback-plan.v1";
const shaPattern = /^[a-f0-9]{64}$/u;
const exclusiveWriteFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export class ClaudeAdapterInstallerError extends Error {
  readonly reasonCode: ClaudeAdapterInstallerReasonCode;
  constructor(reasonCode: ClaudeAdapterInstallerReasonCode, message: string) {
    super(message);
    this.name = "ClaudeAdapterInstallerError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: ClaudeAdapterInstallerReasonCode, message: string): never {
  throw new ClaudeAdapterInstallerError(reasonCode, message);
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

// Duplicated from claude-adapter.ts (private identityDigest / sameIdentity): the
// canonical sha256 over stat identity fields as strings. Duplicated so the
// producer stays byte-compatible with the reader without exporting the helper.
type StatIdentity = Awaited<ReturnType<typeof lstat>>;

function identityDigest(value: StatIdentity): string {
  return canonicalSha256({ dev: String(value.dev), ino: String(value.ino), size: String(value.size), mtimeMs: String(value.mtimeMs), ctimeMs: String(value.ctimeMs) });
}

function contentSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// A governed installation root must be an absolute, already-canonical, real
// directory (not a symlink) and must not itself live under a .claude or .codex
// segment. This mirrors the root guard in readClaudeAdapterInstallationReceipt and
// the ladder's Step-1 failure mode (INSTALLER_ROOT_INVALID on a segment or
// symlinked root); assertNoForbiddenClaudePaths is applied to the BUNDLE data, not
// to absolute target realpaths (which legitimately contain /.claude/).
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

function admitReceiptPath(installationRoot: string, receiptPath: string): string {
  if (typeof receiptPath !== "string" || receiptPath.length === 0 || !receiptPath.isWellFormed()) fail("INSTALLER_ROOT_INVALID", "receipt path");
  if (!isAbsolute(receiptPath) || resolve(receiptPath) !== receiptPath) fail("INSTALLER_ROOT_INVALID", "receipt path not canonical");
  // The receipt must live OUTSIDE installationRoot/.claude so the receipt's entry
  // set stays the closed set of four templates (matching the reader's length gate).
  const claudeDirectory = resolve(installationRoot, ".claude");
  if (receiptPath === claudeDirectory || receiptPath.startsWith(`${claudeDirectory}${sep}`)) fail("INSTALLER_ROOT_INVALID", "receipt path under .claude");
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

export async function installClaudeAdapterBundle(bundleValue: unknown, options: ClaudeAdapterInstallOptions): Promise<ClaudeAdapterInstallResult> {
  const bundle: ClaudeAdapterBundle = validateClaudeAdapterBundle(bundleValue);
  // Applied to the validated bundle (its embedded template paths are relative
  // .claude/tcrn-workflow/... with no leading slash, so they pass) — this catches
  // every home-anchored or absolute .claude reference smuggled into the data.
  assertNoForbiddenClaudePaths(bundle);
  const installationRoot = await admitInstallationRoot(options.installationRoot);
  const receiptPath = admitReceiptPath(installationRoot, options.receiptPath);
  const generationId = options.generationId;
  if (typeof generationId !== "string" || generationId.length === 0 || !generationId.isWellFormed()) fail("INSTALLER_ROOT_INVALID", "generation id");

  const workflowDirectory = resolve(installationRoot, ".claude", "tcrn-workflow");
  const writtenTargets: string[] = [];
  let createdRoot: string | undefined;
  try {
    createdRoot = await mkdir(workflowDirectory, { recursive: true, mode: 0o700 });
    const entries: ClaudeAdapterInstallationEntry[] = [];
    for (const file of bundle.files) {
      const target = resolve(installationRoot, file.path);
      await writeExclusive(target, Buffer.from(file.content, "utf8"), file.path);
      writtenTargets.push(target);
      const stat = await lstat(target);
      entries.push({ path: file.path, realpath: await realpath(target), contentDigest: file.contentDigest, identityDigest: identityDigest(stat) });
    }
    const basis = { schemaVersion: CLAUDE_ADAPTER_INSTALLATION_VERSION, generationId, bundleDigest: bundle.bundleDigest, installationRoot, entries };
    const receipt: ClaudeAdapterInstallationReceipt = { ...basis, receiptDigest: canonicalSha256(basis) };
    const receiptBytes = Buffer.from(canonicalJson(receipt), "utf8");
    await writeExclusive(receiptPath, receiptBytes, "installation receipt");
    const authority: ClaudeAdapterInstallationFileIdentity = { expectedCanonicalPath: await realpath(receiptPath), expectedFileSha256: contentSha256(receiptBytes) };
    return deepFreeze({ receipt, authority });
  } catch (error) {
    // Fail closed with zero new files: remove every template this call wrote and
    // the directory subtree this call created before re-raising.
    for (const target of writtenTargets.reverse()) await unlink(target).catch(() => undefined);
    if (createdRoot !== undefined) await rm(createdRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

// Read an already-installed Step-1 template file read-only and return its content
// digest and stat identity. A missing or non-regular template means Step 1 was not
// run against this root (INSTALLER_ACTIVATION_PRECONDITION) — no activation without
// installation (OD-32).
async function readInstalledTemplate(target: string, label: string): Promise<{ readonly contentDigest: string; readonly identityDigest: string; readonly realpath: string }> {
  let stat: StatIdentity;
  try {
    stat = await lstat(target);
  } catch {
    fail("INSTALLER_ACTIVATION_PRECONDITION", label);
  }
  if (stat.isSymbolicLink() || stat.nlink !== 1 || !stat.isFile()) fail("INSTALLER_ACTIVATION_PRECONDITION", label);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("INSTALLER_ACTIVATION_PRECONDITION", label);
  }
  let content: Buffer;
  try {
    content = await handle.readFile();
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { contentDigest: contentSha256(content), identityDigest: identityDigest(stat), realpath: await realpath(target) };
}

// WSG-3 Step-2 activation installer. Assumes Step 1 already installed the four
// inert templates under <root>/.claude/tcrn-workflow/. Writes session-start.mjs
// (O_EXCL O_NOFOLLOW 0o600), merges the v2 fragment into <root>/.claude/settings.json
// atomically (temp O_EXCL then rename), and emits the additive
// tcrn.claude-adapter-installation-generation.v2 receipt covering every activation
// file so the Step-2/3 install rolls back byte-inverse. The receipt lives OUTSIDE
// .claude (admitReceiptPath) exactly like the v1 receipt.
export async function installClaudeAdapterActivation(options: ClaudeAdapterActivationInstallOptions): Promise<ClaudeAdapterActivationInstallResult> {
  const fragment = validateClaudeAdapterActivationFragment(options.fragment);
  if (typeof options.scriptSource !== "string" || options.scriptSource.length === 0 || !options.scriptSource.isWellFormed()) fail("INSTALLER_WRITE_FAILED", "session-start script source");
  if (fragment.scriptDigest !== contentSha256(Buffer.from(options.scriptSource, "utf8"))) fail("INSTALLER_ACTIVATION_PRECONDITION", "fragment is not digest-bound to the session-start script");
  const installationRoot = await admitInstallationRoot(options.installationRoot);
  const receiptPath = admitReceiptPath(installationRoot, options.receiptPath);
  const generationId = options.generationId;
  if (typeof generationId !== "string" || generationId.length === 0 || !generationId.isWellFormed()) fail("INSTALLER_ROOT_INVALID", "generation id");
  const bundleDigest = options.bundleDigest;
  if (typeof bundleDigest !== "string" || !shaPattern.test(bundleDigest)) fail("INSTALLER_ROOT_INVALID", "bundle digest");
  const renderSource = options.renderSource;
  if (renderSource !== undefined && (typeof renderSource !== "string" || renderSource.length === 0 || !renderSource.isWellFormed())) fail("INSTALLER_WRITE_FAILED", "persona render source");

  // The four Step-1 templates must already be present; record their current identity.
  const templateEntries: ClaudeAdapterActivationInstallationEntry[] = [];
  for (const templatePath of CLAUDE_ADAPTER_TEMPLATE_PATHS) {
    const target = resolve(installationRoot, templatePath);
    const read = await readInstalledTemplate(target, templatePath);
    templateEntries.push({ path: templatePath, realpath: read.realpath, contentDigest: read.contentDigest, identityDigest: read.identityDigest });
  }

  // Compute the merged settings before writing anything (pure, fail-closed).
  const settingsPath = resolve(installationRoot, ".claude", "settings.json");
  let currentSettings = "{}";
  const existing = await readFile(settingsPath, "utf8").catch((error) => {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    fail("INSTALLER_WRITE_FAILED", "settings read");
  });
  if (typeof existing === "string") currentSettings = existing;
  const mergedSettings = mergeClaudeAdapterActivationFragment(currentSettings, fragment);

  const scriptTarget = resolve(installationRoot, ...CLAUDE_ADAPTER_SESSION_START_PATH.split("/"));
  const renderTarget = resolve(installationRoot, ...CLAUDE_ADAPTER_PERSONA_RENDER_PATH.split("/"));
  const settingsTempPath = `${settingsPath}.tcrn-activation-tmp`;
  let scriptWritten = false;
  let renderWritten = false;
  let receiptWritten = false;
  try {
    await writeExclusive(scriptTarget, Buffer.from(options.scriptSource, "utf8"), CLAUDE_ADAPTER_SESSION_START_PATH);
    scriptWritten = true;
    const scriptStat = await lstat(scriptTarget);
    const scriptEntry: ClaudeAdapterActivationInstallationEntry = {
      path: CLAUDE_ADAPTER_SESSION_START_PATH,
      realpath: await realpath(scriptTarget),
      contentDigest: contentSha256(Buffer.from(options.scriptSource, "utf8")),
      identityDigest: identityDigest(scriptStat),
    };
    const activationEntries = [...templateEntries, scriptEntry];
    // WSG-4 Step-3: persist the persona render sibling and record its entry so it
    // rides the same v2 receipt (reserved path) and rolls back byte-inverse.
    if (renderSource !== undefined) {
      const renderBytes = Buffer.from(renderSource, "utf8");
      await writeExclusive(renderTarget, renderBytes, CLAUDE_ADAPTER_PERSONA_RENDER_PATH);
      renderWritten = true;
      const renderStat = await lstat(renderTarget);
      activationEntries.push({
        path: CLAUDE_ADAPTER_PERSONA_RENDER_PATH,
        realpath: await realpath(renderTarget),
        contentDigest: contentSha256(renderBytes),
        identityDigest: identityDigest(renderStat),
      });
    }
    const entries = activationEntries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const basis = {
      schemaVersion: CLAUDE_ADAPTER_INSTALLATION_V2_VERSION,
      generationId,
      bundleDigest,
      fragmentDigest: fragment.fragmentDigest,
      scriptDigest: fragment.scriptDigest,
      installationRoot,
      entries,
    };
    const receipt: ClaudeAdapterActivationInstallationReceipt = { ...basis, receiptDigest: canonicalSha256(basis) };
    const receiptBytes = Buffer.from(canonicalJson(receipt), "utf8");
    await writeExclusive(receiptPath, receiptBytes, "activation installation receipt");
    receiptWritten = true;
    // Everything that can still fail happens before the commit point. These two reads
    // used to sit after the rename, where a failure left settings.json already carrying
    // the SessionStart hook while the cleanup below deleted the script it points at --
    // an activated install referencing a missing file, with the merge key permanently
    // blocking retries via ACTIVATION_FRAGMENT_CONFLICT and no verb able to undo it.
    // The cleanup can only remove files this call created; it can never put the user's
    // previous settings back, so nothing failable may follow the rename.
    const authority: ClaudeAdapterInstallationFileIdentity = { expectedCanonicalPath: await realpath(receiptPath), expectedFileSha256: contentSha256(receiptBytes) };
    const sourceIdentityDigest = identityDigest(await lstat(receiptPath));
    // Atomic settings replace, and the sole commit point: exclusive temp write then
    // rename over the target. mergedSettings was derived from a read taken before the
    // bundle was written, so re-read first: the rename replaces the file wholesale and
    // would otherwise discard, without a word, whatever the user or another tool wrote
    // in between. Every other reader in this family triple-stats for exactly this class
    // of interference.
    await options.beforeSettingsCommitForTest?.();
    const settingsBeforeCommit = await readFile(settingsPath, "utf8").catch((error) => {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw error;
    });
    if ((settingsBeforeCommit ?? "{}") !== currentSettings) {
      fail("INSTALLER_WRITE_FAILED", "settings.json changed while the activation was being prepared");
    }
    await writeExclusive(settingsTempPath, Buffer.from(mergedSettings, "utf8"), "activation settings temp");
    try {
      await rename(settingsTempPath, settingsPath);
    } catch {
      await unlink(settingsTempPath).catch(() => undefined);
      fail("INSTALLER_WRITE_FAILED", "activation settings rename");
    }
    return deepFreeze({ receipt, authority, sourceIdentityDigest, settingsPath });
  } catch (error) {
    if (scriptWritten) await unlink(scriptTarget).catch(() => undefined);
    if (renderWritten) await unlink(renderTarget).catch(() => undefined);
    if (receiptWritten) await unlink(receiptPath).catch(() => undefined);
    await unlink(settingsTempPath).catch(() => undefined);
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

// Consumes the planClaudeAdapterRollback output and removes only files whose
// on-disk bytes and stat identity still exactly match the receipt
// (identity_digest_match_only). Every removal is verified before removing
// anything, so a single tampered file fails INSTALLER_ROLLBACK_MISMATCH and
// nothing is removed.
// After the four templates are unlinked the now-empty .claude/tcrn-workflow
// directory and the receipt file are removed. receiptPath is supplied out-of-band
// because the rollback plan does not carry the receipt location.
export async function executeClaudeAdapterRollback(planValue: unknown, receiptPath: string): Promise<ClaudeAdapterRollbackResult> {
  const { planDigest, removals } = admitRollbackPlan(planValue);
  // Pass one: verify every target against its recorded content and identity.
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
  // Pass two: every target matched — remove them, then the emptied control
  // directory and the receipt file.
  for (const removal of removals) await unlink(removal.realpath);
  const workflowDirectory = dirname(removals[0]?.realpath ?? "");
  if (workflowDirectory.length > 0) await rmdir(workflowDirectory).catch(() => undefined);
  const receiptStat = await lstat(receiptPath).catch(() => undefined);
  if (receiptStat && !receiptStat.isSymbolicLink() && receiptStat.isFile() && receiptStat.nlink === 1) await unlink(receiptPath).catch(() => undefined);
  return deepFreeze({ reasonCode: "INSTALLER_ROLLBACK_EXECUTED" as const, planDigest, removedCount: removals.length });
}
