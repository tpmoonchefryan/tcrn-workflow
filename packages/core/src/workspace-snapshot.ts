// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  PROTOCOL_LIMITS,
  ProtocolError,
  assertCanonicalJson,
  canonicalJson,
  compareCanonicalText,
} from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { WORKSPACE_CONTROL_DIRECTORY, validateWorkspace } from "./workspace.js";
import type { WorkspaceLease } from "./workspace.js";
import { validateKnowledgeStore } from "./knowledge-core.js";

// WSF-2: the read-only snapshot witness. It computes a deterministic manifest over
// the workspace control tree so a copy can be proved byte-identical after restore,
// and it never mutates the workspace it inspects. The buildable half of ADR 0002's
// hybrid make-vs-teach verdict — the copy itself is taught (OS tools), only the
// manifest and its verification are made.
export const SNAPSHOT_MANIFEST_SCHEMA_VERSION = "tcrn.workspace-snapshot-manifest.v1" as const;
export const SNAPSHOT_VERIFY_SCHEMA_VERSION = "tcrn.workspace-snapshot-verify.v1" as const;

// New frozen reason-code list, sorted, owned by this module. WORKSPACE_REASON_CODES
// is not edited (protocol-sensitivity: the witness is additive).
export const SNAPSHOT_REASON_CODES = Object.freeze([
  "SNAPSHOT_INPUT_INVALID",
  "SNAPSHOT_MANIFEST_INVALID",
  "SNAPSHOT_MISMATCH",
  "SNAPSHOT_PATH_INVALID",
  "SNAPSHOT_RESIDUE_PRESENT",
  "SNAPSHOT_VERIFIED",
] as const);

export type SnapshotReasonCode = typeof SNAPSHOT_REASON_CODES[number];

export class SnapshotError extends Error {
  readonly reasonCode: SnapshotReasonCode;

  constructor(reasonCode: SnapshotReasonCode, message: string) {
    super(message);
    this.name = "SnapshotError";
    this.reasonCode = reasonCode;
  }
}

interface SnapshotFileEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

function fail(reasonCode: SnapshotReasonCode, message: string): never {
  throw new SnapshotError(reasonCode, message);
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// SDC-9 control-tree residue taxonomy. Exact relative paths under the control root
// that a live, leased workspace legitimately carries but that are NOT part of the
// backup content: the held lease directory, the lease-recovery claim, and the
// knowledge/artifact in-flight mutation claims. Excluding them keeps the manifest
// stable across the claim churn of normal operation.
const EXCLUDED_RELATIVE_PATHS = Object.freeze([
  "lease",
  "lease-recovery.claim",
  "knowledge/mutation.claim",
  "artifacts/restore.claim",
]);

// Crashed-session quarantine residue. reclaimObservedLease/release can leave these
// behind between a rename and its removal, and the engine never cleans control-root
// quarantines (recover only removes .tmp- files under events/ and views/). A backup
// over such residue would bake partial state into the receipt, so the witness fails
// closed: the runbook says remove the quarantine manually, then re-snapshot. The
// prefix set covers stale-lease-*, released-*/released-lease-*/released-recovery-*/
// released-restore-* (workspace, knowledge, artifact release quarantines), and the
// attempt-owned-* test quarantine. released-mutation-* lives INSIDE lease/, which is
// excluded whole, so it is never reached.
const RESIDUE_PREFIX = /^(?:stale-lease-|released-|attempt-owned-)/u;

// Atomic-write temporaries. atomicWrite stages under .tmp-<pid>-<seq> and renames
// into place, so a live snapshot can momentarily observe one; it is never content.
const TEMPORARY_PREFIX = ".tmp-";

// Minimal bound-read helpers, re-implemented locally per the duplicate-machinery
// discipline (ADR-precedent: adapters duplicate rather than export workspace
// internals). These mirror boundDirectory/boundFile semantics — symlink rejection,
// single-link (nlink === 1) enforcement, and double-stat identity checks — without
// importing workspace.ts private helpers.
async function boundReadDirectory(path: string): Promise<string> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    fail("SNAPSHOT_PATH_INVALID", `${path}: ${String((error as { code?: string }).code ?? error)}`);
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    fail("SNAPSHOT_PATH_INVALID", `${path} must be a real directory`);
  }
  const resolved = await realpath(path);
  const after = await lstat(resolved);
  if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
    fail("SNAPSHOT_PATH_INVALID", `${path} changed while resolving`);
  }
  return resolved;
}

async function boundReadFileBytes(path: string, maximumBytes = PROTOCOL_LIMITS.maxCanonicalBytes): Promise<Buffer> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    fail("SNAPSHOT_PATH_INVALID", `${path}: ${String((error as { code?: string }).code ?? error)}`);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    fail("SNAPSHOT_PATH_INVALID", `${path} must be a single-link regular file`);
  }
  if (before.size > maximumBytes) {
    fail("SNAPSHOT_PATH_INVALID", `${path} exceeds the snapshot read limit`);
  }
  if (typeof constants.O_NOFOLLOW !== "number") {
    fail("SNAPSHOT_PATH_INVALID", "O_NOFOLLOW is unavailable");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail("SNAPSHOT_PATH_INVALID", `${path} changed while opening`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 || content.length > maximumBytes) {
      fail("SNAPSHOT_PATH_INVALID", `${path} changed while reading`);
    }
    return content;
  } finally {
    await handle?.close();
  }
}

// Public bounded reader for the manifest receipt file, so the CLI verb can read a
// saved manifest under the same governed read discipline (no plain readFile, no
// symlink follow) before handing the text to verifySnapshotManifest.
export async function readSnapshotManifestFile(path: string): Promise<string> {
  if (typeof path !== "string" || path.length === 0) {
    fail("SNAPSHOT_INPUT_INVALID", "manifest path");
  }
  const content = await boundReadFileBytes(path);
  return content.toString("utf8");
}

// Deterministic walk of the control tree under `controlRoot`, applying the SDC-9
// exclusions and failing closed on residue. Returns files sorted by posix relative
// path in utf8-byte order so two runs on an unchanged tree are byte-identical.
async function walkControlTree(controlRoot: string): Promise<readonly SnapshotFileEntry[]> {
  const collected: SnapshotFileEntry[] = [];
  const walk = async (directory: string, relativeBase: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      const relativePath = relativeBase === "" ? name : `${relativeBase}/${name}`;
      const full = resolve(directory, name);
      if (name.startsWith(TEMPORARY_PREFIX)) {
        continue;
      }
      if (EXCLUDED_RELATIVE_PATHS.includes(relativePath)) {
        continue;
      }
      if (RESIDUE_PREFIX.test(name)) {
        fail("SNAPSHOT_RESIDUE_PRESENT", relativePath);
      }
      const metadata = await lstat(full);
      if (metadata.isSymbolicLink()) {
        fail("SNAPSHOT_PATH_INVALID", `${relativePath} is a symbolic link`);
      }
      if (metadata.isDirectory()) {
        await walk(full, relativePath);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        fail("SNAPSHOT_PATH_INVALID", `${relativePath} must be a single-link regular file`);
      }
      const content = await boundReadFileBytes(full);
      collected.push({
        path: relativePath,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.length,
      });
    }
  };
  await walk(controlRoot, "");
  return [...collected].sort((left, right) => compareCanonicalText(left.path, right.path));
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Assert the passed lease still owns the workspace, mirroring assertLease's
// owner.json read (workspace.ts) rather than exporting it. In the CLI path the lease
// is always held (acquisition already fail-closed WORKSPACE_LOCKED on contention);
// this is defense in depth for direct programmatic callers.
async function assertHeldLease(workspaceRoot: string, lease: WorkspaceLease): Promise<void> {
  if (lease === null || typeof lease !== "object" || typeof lease.token !== "string" || lease.workspaceRoot !== workspaceRoot) {
    fail("SNAPSHOT_INPUT_INVALID", "lease does not hold this workspace");
  }
  const ownerPath = resolve(workspaceRoot, WORKSPACE_CONTROL_DIRECTORY, "lease", "owner.json");
  const content = await boundReadFileBytes(ownerPath, 16_384);
  let owner: JsonValue;
  try {
    owner = assertCanonicalJson(content.toString("utf8"));
  } catch (error) {
    fail("SNAPSHOT_INPUT_INVALID", String(error));
  }
  if (!isJsonObject(owner) || owner.schemaVersion !== "tcrn.workspace-lease.v1" || owner.token !== lease.token) {
    fail("SNAPSHOT_INPUT_INVALID", "lease token no longer owns the workspace");
  }
}

// Build a canonical snapshot manifest for a quiesced, leased workspace. The lease
// is the quiesce proof (only one holder can own it). Emits sorted per-file sha256,
// the workspace headEventHash/version/workspaceId, and the embedded validate result
// for both stores. No Date.now, no randomness — determinism constraint 6.
export async function createSnapshotManifest(workspaceRootInput: string, lease: WorkspaceLease): Promise<string> {
  if (typeof workspaceRootInput !== "string" || workspaceRootInput.length === 0) {
    fail("SNAPSHOT_INPUT_INVALID", "workspace root");
  }
  const root = await boundReadDirectory(workspaceRootInput);
  await assertHeldLease(root, lease);
  const state = await validateWorkspace(root);
  const controlRoot = resolve(root, WORKSPACE_CONTROL_DIRECTORY);
  let knowledgeStatus: "valid" | "absent" = "absent";
  if (await directoryExists(resolve(controlRoot, "knowledge"))) {
    await validateKnowledgeStore(root);
    knowledgeStatus = "valid";
  }
  const files = await walkControlTree(controlRoot);
  return canonicalJson({
    schemaVersion: SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    validate: { workspace: "valid", knowledge: knowledgeStatus },
    files,
  });
}

function assertManifestShape(value: JsonValue): asserts value is {
  readonly schemaVersion: string;
  readonly workspaceId: string;
  readonly version: number;
  readonly headEventHash: string | null;
  readonly validate: Readonly<Record<string, JsonValue>>;
  readonly files: readonly JsonValue[];
} {
  if (!isJsonObject(value)) {
    fail("SNAPSHOT_MANIFEST_INVALID", "manifest must be an object");
  }
  if (value.schemaVersion !== SNAPSHOT_MANIFEST_SCHEMA_VERSION) {
    fail("SNAPSHOT_MANIFEST_INVALID", "unexpected manifest schemaVersion");
  }
  if (typeof value.workspaceId !== "string" || typeof value.version !== "number" || !Number.isSafeInteger(value.version) ||
    !(value.headEventHash === null || typeof value.headEventHash === "string")) {
    fail("SNAPSHOT_MANIFEST_INVALID", "manifest header fields are invalid");
  }
  if (!isJsonObject(value.validate)) {
    fail("SNAPSHOT_MANIFEST_INVALID", "manifest validate block is invalid");
  }
  if (!Array.isArray(value.files)) {
    fail("SNAPSHOT_MANIFEST_INVALID", "manifest files must be an array");
  }
}

function assertFileEntry(value: JsonValue): asserts value is { readonly path: string; readonly sha256: string; readonly bytes: number } {
  if (!isJsonObject(value)) {
    fail("SNAPSHOT_MANIFEST_INVALID", "file entry must be an object");
  }
  if (typeof value.path !== "string" || value.path.length === 0 || value.path.includes("\\") || value.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("SNAPSHOT_MANIFEST_INVALID", "file entry path is invalid");
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    fail("SNAPSHOT_MANIFEST_INVALID", "file entry sha256 is invalid");
  }
  if (typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    fail("SNAPSHOT_MANIFEST_INVALID", "file entry bytes is invalid");
  }
}

// Recompute the control tree under `rootDirectory/.tcrn-workflow` and prove it
// matches `manifestJson`. Read-only: no lease, no validate — the target is a copy,
// not a live workspace. Throws SNAPSHOT_MISMATCH naming the first differing path.
export async function verifySnapshotManifest(rootDirectoryInput: string, manifestJson: string): Promise<Readonly<Record<string, JsonValue>>> {
  if (typeof rootDirectoryInput !== "string" || rootDirectoryInput.length === 0) {
    fail("SNAPSHOT_INPUT_INVALID", "root directory");
  }
  if (typeof manifestJson !== "string") {
    fail("SNAPSHOT_MANIFEST_INVALID", "manifest must be a string");
  }
  let manifest: JsonValue;
  try {
    manifest = assertCanonicalJson(manifestJson);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("SNAPSHOT_MANIFEST_INVALID", error.message);
    }
    throw error;
  }
  assertManifestShape(manifest);
  const expected: SnapshotFileEntry[] = [];
  for (const entry of manifest.files) {
    assertFileEntry(entry);
    expected.push({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes });
  }
  expected.sort((left, right) => compareCanonicalText(left.path, right.path));
  const root = await boundReadDirectory(rootDirectoryInput);
  const controlRoot = resolve(root, WORKSPACE_CONTROL_DIRECTORY);
  if (!(await directoryExists(controlRoot))) {
    fail("SNAPSHOT_MISMATCH", WORKSPACE_CONTROL_DIRECTORY);
  }
  const actual = await walkControlTree(controlRoot);
  const bound = Math.max(expected.length, actual.length);
  for (let index = 0; index < bound; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left === undefined) {
      fail("SNAPSHOT_MISMATCH", right?.path ?? "extra entry");
    }
    if (right === undefined) {
      fail("SNAPSHOT_MISMATCH", left.path);
    }
    if (left.path !== right.path || left.sha256 !== right.sha256 || left.bytes !== right.bytes) {
      fail("SNAPSHOT_MISMATCH", compareCanonicalText(left.path, right.path) <= 0 ? left.path : right.path);
    }
  }
  return {
    schemaVersion: SNAPSHOT_VERIFY_SCHEMA_VERSION,
    reasonCode: "SNAPSHOT_VERIFIED",
    files: expected.length,
  };
}
