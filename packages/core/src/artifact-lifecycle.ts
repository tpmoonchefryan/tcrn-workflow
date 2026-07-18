// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import {
  ProtocolError,
  assertCanonicalJson,
  assertStrictInstant,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
} from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { materializeWorkspace } from "./workspace.js";

export const ARTIFACT_STORE_SCHEMA_VERSION = "tcrn.artifact-store.v1" as const;
export const ARTIFACT_RECORD_SCHEMA_VERSION = "tcrn.artifact-record.v1" as const;
export const ARTIFACT_ARCHIVE_SCHEMA_VERSION = "tcrn.artifact-archive.v1" as const;
export const ARTIFACT_LIFECYCLE_VERSION = "tcrn.artifact-lifecycle.v1" as const;

export const ARTIFACT_REASON_CODES = Object.freeze([
  "ARTIFACT_ALREADY_EXISTS",
  "ARTIFACT_ARCHIVE_APPLIED",
  "ARTIFACT_ARCHIVE_DRY_RUN_READY",
  "ARTIFACT_ARCHIVE_EXISTS",
  "ARTIFACT_ARCHIVE_INVALID",
  "ARTIFACT_BUDGET_BYTES_CRITICAL",
  "ARTIFACT_BUDGET_BYTES_WARNING",
  "ARTIFACT_BUDGET_COUNT_CRITICAL",
  "ARTIFACT_BUDGET_COUNT_WARNING",
  "ARTIFACT_COMPACT_DRY_RUN_READY",
  "ARTIFACT_DOCTOR_CRITICAL",
  "ARTIFACT_DOCTOR_OK",
  "ARTIFACT_DOCTOR_WARNING",
  "ARTIFACT_FAULT_INJECTED",
  "ARTIFACT_HIGH_WATER_MISMATCH",
  "ARTIFACT_INPUT_INVALID",
  "ARTIFACT_LIMIT_EXCEEDED",
  "ARTIFACT_LINK_UNSAFE",
  "ARTIFACT_PARTIAL_STATE",
  "ARTIFACT_PATH_INVALID",
  "ARTIFACT_REDACTION_REQUIRED",
  "ARTIFACT_RESTORE_CONFLICT",
  "ARTIFACT_ARCHIVE_RESTORED",
  "ARTIFACT_SIZE_REPORT_READY",
  "ARTIFACT_SOURCE_CHANGED",
  "ARTIFACT_SPECIAL_FILE",
  "ARTIFACT_WORKSPACE_NOT_DISPOSABLE",
] as const);

export type ArtifactReasonCode = typeof ARTIFACT_REASON_CODES[number];
export type ArtifactKind =
  | "artifact"
  | "terminal-state"
  | "decision"
  | "gate"
  | "acceptance"
  | "evidence-reference"
  | "receipt"
  | "cache";
export type ArtifactClassification =
  | "authoritative-artifact"
  | "protected-record"
  | "durable-evidence-reference"
  | "transient-receipt"
  | "transient-cache";
export type ArtifactFaultPoint =
  | "after-archive-directory"
  | "after-bundle-sync"
  | "after-bundle-commit"
  | "after-restore-claim"
  | "after-first-restore-write";

export class ArtifactLifecycleError extends Error {
  readonly reasonCode: ArtifactReasonCode;

  constructor(reasonCode: ArtifactReasonCode, message: string) {
    super(message);
    this.name = "ArtifactLifecycleError";
    this.reasonCode = reasonCode;
  }
}

export interface ArtifactRecord {
  readonly schemaVersion: typeof ARTIFACT_RECORD_SCHEMA_VERSION;
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly state: "active" | "terminal";
  readonly reference: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly eventHighWaterDigest: string;
}

export interface ArtifactScanOptions {
  readonly beforeDescriptorReadForTest?: (path: string) => Promise<void>;
  readonly afterDescriptorOpenForTest?: (path: string) => Promise<void>;
  readonly afterDescriptorReadForTest?: (path: string) => Promise<void>;
}

export interface ArtifactDoctorBudgets {
  readonly warningBytes?: number;
  readonly criticalBytes?: number;
  readonly warningCount?: number;
  readonly criticalCount?: number;
}

export interface ArtifactArchiveOptions extends ArtifactScanOptions {
  readonly expectedPlanDigest: string;
  readonly faultAt?: ArtifactFaultPoint;
}

const classificationByKind: Readonly<Record<ArtifactKind, ArtifactClassification>> = Object.freeze({
  artifact: "authoritative-artifact",
  "terminal-state": "protected-record",
  decision: "protected-record",
  gate: "protected-record",
  acceptance: "protected-record",
  "evidence-reference": "durable-evidence-reference",
  receipt: "transient-receipt",
  cache: "transient-cache",
});
const recordFields = [
  "schemaVersion",
  "id",
  "kind",
  "state",
  "reference",
  "byteSize",
  "sha256",
  "createdAt",
  "eventHighWaterDigest",
];
const storeFields = ["schemaVersion", "workspaceId", "eventHighWaterDigest", "disposable", "authority"];
const archiveFields = [
  "schemaVersion",
  "archiveId",
  "workspaceId",
  "eventHighWaterDigest",
  "planDigest",
  "retained",
  "dropped",
  "mutationApplied",
  "entries",
];
const archiveEntryFields = ["path", "size", "sha256", "contentBase64"];
export const ARTIFACT_LIMITS = Object.freeze({
  maximumSourceBytes: 1_048_576,
  maximumStoredBytes: 16_777_216,
  maximumArchiveBytes: 33_554_432,
  maximumEntries: 1_024,
  maximumLogicalBytes: 4_294_967_296,
  maximumArchiveGenerations: 16,
  maximumArchiveFilesPerGeneration: 1,
  maximumArchiveStoredBytes: 33_554_432,
});
const maxSourceBytes = ARTIFACT_LIMITS.maximumSourceBytes;
const maxStoredBytes = ARTIFACT_LIMITS.maximumStoredBytes;
const maxArchiveBytes = ARTIFACT_LIMITS.maximumArchiveBytes;
const maxEntries = ARTIFACT_LIMITS.maximumEntries;
const maxLogicalBytes = ARTIFACT_LIMITS.maximumLogicalBytes;
const maxArchiveGenerations = ARTIFACT_LIMITS.maximumArchiveGenerations;
const maxArchiveFilesPerGeneration = ARTIFACT_LIMITS.maximumArchiveFilesPerGeneration;
const maxArchiveStoredBytes = ARTIFACT_LIMITS.maximumArchiveStoredBytes;

interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface FileAdmissionSnapshot extends FileIdentity {
  readonly size: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface BoundBytes {
  readonly bytes: Buffer;
  readonly identity: FileIdentity;
}

interface ArtifactStoreMarker {
  readonly schemaVersion: typeof ARTIFACT_STORE_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly eventHighWaterDigest: string;
  readonly disposable: boolean;
  readonly authority: "metadata-reference-only";
}

interface ScannedArtifactRecord {
  readonly path: string;
  readonly relativePath: string;
  readonly bytes: Buffer;
  readonly record: ArtifactRecord;
  readonly classification: ArtifactClassification;
}

interface ScannedTransient {
  readonly path: string;
  readonly relativePath: string;
  readonly size: number;
  readonly classification: "transient-receipt" | "transient-cache";
}

interface ArtifactStoreScan {
  readonly workspaceRoot: string;
  readonly workspaceExternalKey: string;
  readonly storeRoot: string;
  readonly marker: ArtifactStoreMarker;
  readonly records: readonly ScannedArtifactRecord[];
  readonly transient: readonly ScannedTransient[];
  readonly archiveStorage: ArchiveStorageSummary;
}

interface ArchiveStorageSummary {
  readonly generationCount: number;
  readonly storedBytes: number;
}

interface ExclusiveFile {
  readonly path: string;
  readonly identity: FileIdentity;
}

function fail(reasonCode: ArtifactReasonCode, message: string): never {
  throw new ArtifactLifecycleError(reasonCode, message);
}

function exactFields(value: unknown, expected: readonly string[], label: string, reasonCode: ArtifactReasonCode): asserts value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(reasonCode, `${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareCanonicalText);
  const required = [...expected].sort(compareCanonicalText);
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    fail(reasonCode, `${label} fields are not exact`);
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function admissionSnapshot(value: FileAdmissionSnapshot): FileAdmissionSnapshot {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mode: value.mode,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function sameAdmissionSnapshot(left: FileAdmissionSnapshot, right: FileAdmissionSnapshot): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function inside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertHexDigest(value: unknown, label: string, reasonCode: ArtifactReasonCode): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(reasonCode, `${label} must be a lowercase SHA-256 digest`);
  }
}

function assertSafeInteger(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("ARTIFACT_LIMIT_EXCEEDED", `${label} must be ${minimum}-${maximum}`);
  }
}

export function assertArtifactRelativePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\\") || value.startsWith("/")) {
    fail("ARTIFACT_PATH_INVALID", String(value));
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || !/^[A-Za-z0-9._:-]{1,160}$/u.test(segment))) {
    fail("ARTIFACT_PATH_INVALID", value);
  }
}

async function boundDirectory(path: string, parent?: string): Promise<string> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    fail("ARTIFACT_PATH_INVALID", `${path}:${String((error as { code?: string }).code ?? error)}`);
  }
  if (before.isSymbolicLink()) {
    fail("ARTIFACT_LINK_UNSAFE", path);
  }
  if (!before.isDirectory()) {
    fail("ARTIFACT_SPECIAL_FILE", path);
  }
  const canonical = await realpath(path);
  if (parent && !inside(parent, canonical)) {
    fail("ARTIFACT_PATH_INVALID", path);
  }
  const after = await lstat(canonical);
  if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) {
    fail("ARTIFACT_SOURCE_CHANGED", path);
  }
  return canonical;
}

async function readBoundRegularFile(path: string, maximumBytes = maxSourceBytes, options: ArtifactScanOptions = {}): Promise<BoundBytes> {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    fail("ARTIFACT_PATH_INVALID", `${path}:${String((error as { code?: string }).code ?? error)}`);
  }
  if (before.isSymbolicLink()) {
    fail("ARTIFACT_LINK_UNSAFE", path);
  }
  if (!before.isFile()) {
    fail("ARTIFACT_SPECIAL_FILE", path);
  }
  if (before.nlink !== 1n) {
    fail("ARTIFACT_LINK_UNSAFE", path);
  }
  const maximum = BigInt(maximumBytes);
  if (before.size > maximum) {
    fail("ARTIFACT_LIMIT_EXCEEDED", `${path}:${before.size}`);
  }
  const beforeSnapshot = admissionSnapshot(before);
  await options.beforeDescriptorReadForTest?.(path);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(beforeSnapshot, opened)) {
      fail("ARTIFACT_SOURCE_CHANGED", path);
    }
    if (opened.size > maximum) {
      fail("ARTIFACT_LIMIT_EXCEEDED", `${path}:${opened.size}`);
    }
    const openedSnapshot = admissionSnapshot(opened);
    if (!sameAdmissionSnapshot(beforeSnapshot, openedSnapshot)) {
      fail("ARTIFACT_SOURCE_CHANGED", path);
    }
    await options.afterDescriptorOpenForTest?.(path);
    const bytes = await handle.readFile();
    await options.afterDescriptorReadForTest?.(path);
    const afterRead = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (BigInt(bytes.length) > maximum || afterRead.size > maximum || named.size > maximum) {
      fail("ARTIFACT_LIMIT_EXCEEDED", `${path}:${bytes.length}:${afterRead.size}:${named.size}`);
    }
    if (BigInt(bytes.length) !== openedSnapshot.size || !sameAdmissionSnapshot(openedSnapshot, afterRead) ||
      !sameAdmissionSnapshot(openedSnapshot, named) || named.isSymbolicLink() || !named.isFile() || named.nlink !== 1n) {
      fail("ARTIFACT_SOURCE_CHANGED", path);
    }
    return { bytes, identity: { dev: opened.dev, ino: opened.ino } };
  } catch (error) {
    if (error instanceof ArtifactLifecycleError) {
      throw error;
    }
    fail("ARTIFACT_SOURCE_CHANGED", `${path}:${String(error)}`);
  } finally {
    await handle?.close();
  }
}

async function writeExclusiveFile(path: string, bytes: Buffer | string): Promise<ExclusiveFile> {
  const parent = await boundDirectory(dirname(path));
  const parentBefore = await lstat(parent);
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      fail("ARTIFACT_LINK_UNSAFE", path);
    }
    await handle.close();
    handle = undefined;
    const parentAfter = await lstat(parent);
    const named = await lstat(path);
    if (!sameIdentity(parentBefore, parentAfter) || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameIdentity(opened, named)) {
      fail("ARTIFACT_SOURCE_CHANGED", path);
    }
    const directoryHandle = await open(parent, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return { path, identity: { dev: named.dev, ino: named.ino } };
  } catch (error) {
    await handle?.close();
    if ((error as { code?: string }).code === "EEXIST") {
      fail("ARTIFACT_RESTORE_CONFLICT", path);
    }
    if (error instanceof ArtifactLifecycleError) {
      throw error;
    }
    fail("ARTIFACT_PATH_INVALID", `${path}:${String(error)}`);
  }
}

async function ensureDirectory(path: string, parent: string): Promise<string> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      fail("ARTIFACT_ALREADY_EXISTS", path);
    }
    fail("ARTIFACT_PATH_INVALID", `${path}:${String(error)}`);
  }
  return boundDirectory(path, parent);
}

function parseCanonicalObject(bytes: Buffer, label: string, reasonCode: ArtifactReasonCode): Readonly<Record<string, JsonValue>> {
  try {
    const parsed = assertCanonicalJson(bytes.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(reasonCode, `${label} must be an object`);
    }
    return parsed as Readonly<Record<string, JsonValue>>;
  } catch (error) {
    if (error instanceof ArtifactLifecycleError) {
      throw error;
    }
    if (error instanceof ProtocolError) {
      fail(reasonCode, error.message);
    }
    fail(reasonCode, String(error));
  }
}

export function classifyArtifact(kind: unknown): ArtifactClassification {
  if (typeof kind !== "string" || !Object.hasOwn(classificationByKind, kind)) {
    fail("ARTIFACT_INPUT_INVALID", `unknown artifact kind ${String(kind)}`);
  }
  return classificationByKind[kind as ArtifactKind];
}

export function redactArtifactReference(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(input)) {
    fail("ARTIFACT_INPUT_INVALID", "artifact reference must be a bounded printable string");
  }
  let value = input.replace(/^ +| +$/gu, "");
  if (/^(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|var\/folders)\/)/u.test(value)) {
    return "[redacted-private-path]";
  }
  try {
    const schemeRelative = value.startsWith("//");
    const url = new URL(schemeRelative ? `https:${value}` : value);
    if (url.host !== "") {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      value = schemeRelative ? `//${url.host}${url.pathname}` : url.toString();
    } else {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/u.test(value)) {
        fail("ARTIFACT_INPUT_INVALID", "unsupported hierarchical URL userinfo");
      }
      value = value.split(/[?#]/u, 1)[0] ?? "";
    }
  } catch (error) {
    if (error instanceof ArtifactLifecycleError) {
      throw error;
    }
    if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/[^/?#]*@/u.test(value)) {
      fail("ARTIFACT_INPUT_INVALID", "malformed hierarchical URL userinfo");
    }
    value = value.split(/[?#]/u, 1)[0] ?? "";
  }
  value = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-private-identifier]")
    .replace(/(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/gu, "[redacted-credential]")
    .replace(/\/(?:Users|home|private|var\/folders)\/[^\s]*/gu, "/[redacted-private-path]");
  if (value.length === 0 || value.length > 512) {
    fail("ARTIFACT_INPUT_INVALID", "redacted artifact reference is empty or oversized");
  }
  try {
    canonicalJson(value);
  } catch (error) {
    fail("ARTIFACT_INPUT_INVALID", String(error));
  }
  return value;
}

function validateArtifactRecord(value: Readonly<Record<string, JsonValue>>, marker: ArtifactStoreMarker): ArtifactRecord {
  exactFields(value, recordFields, "artifact record", "ARTIFACT_INPUT_INVALID");
  if (value.schemaVersion !== ARTIFACT_RECORD_SCHEMA_VERSION || typeof value.id !== "string" ||
    !/^artifact:[a-f0-9]{24}$/u.test(value.id) || typeof value.kind !== "string" ||
    !Object.hasOwn(classificationByKind, value.kind) || (value.state !== "active" && value.state !== "terminal") ||
    typeof value.reference !== "string" || typeof value.byteSize !== "number" || !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 0 || value.byteSize > 1_073_741_824 || typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) || typeof value.createdAt !== "string" ||
    typeof value.eventHighWaterDigest !== "string") {
    fail("ARTIFACT_INPUT_INVALID", "artifact record fields are invalid");
  }
  const kind = value.kind as ArtifactKind;
  if (["terminal-state", "decision", "gate", "acceptance"].includes(kind) && value.state !== "terminal") {
    fail("ARTIFACT_INPUT_INVALID", `${kind} must be terminal`);
  }
  try {
    assertStrictInstant(value.createdAt);
  } catch (error) {
    fail("ARTIFACT_INPUT_INVALID", String(error));
  }
  if (redactArtifactReference(value.reference) !== value.reference) {
    fail("ARTIFACT_REDACTION_REQUIRED", value.id);
  }
  assertHexDigest(value.eventHighWaterDigest, "record event high-water", "ARTIFACT_INPUT_INVALID");
  if (value.eventHighWaterDigest !== marker.eventHighWaterDigest) {
    fail("ARTIFACT_HIGH_WATER_MISMATCH", value.id);
  }
  return value as unknown as ArtifactRecord;
}

function validateStoreMarker(value: Readonly<Record<string, JsonValue>>): ArtifactStoreMarker {
  exactFields(value, storeFields, "artifact store marker", "ARTIFACT_INPUT_INVALID");
  if (value.schemaVersion !== ARTIFACT_STORE_SCHEMA_VERSION || typeof value.workspaceId !== "string" ||
    !/^workspace:[a-f0-9]{24}$/u.test(value.workspaceId) || typeof value.eventHighWaterDigest !== "string" ||
    typeof value.disposable !== "boolean" || value.authority !== "metadata-reference-only") {
    fail("ARTIFACT_INPUT_INVALID", "artifact store marker fields are invalid");
  }
  assertHexDigest(value.eventHighWaterDigest, "store event high-water", "ARTIFACT_INPUT_INVALID");
  return value as unknown as ArtifactStoreMarker;
}

async function readStoreMarker(storeRoot: string, options: ArtifactScanOptions = {}): Promise<ArtifactStoreMarker> {
  const opened = await readBoundRegularFile(resolve(storeRoot, "store.json"), 16_384, options);
  return validateStoreMarker(parseCanonicalObject(opened.bytes, "artifact store marker", "ARTIFACT_INPUT_INVALID"));
}

async function assertNoPartialState(storeRoot: string, options: ArtifactScanOptions = {}): Promise<ArchiveStorageSummary> {
  try {
    await lstat(resolve(storeRoot, "restore.claim"));
    await readBoundRegularFile(resolve(storeRoot, "restore.claim"), 16_384, options);
    fail("ARTIFACT_PARTIAL_STATE", "restore claim is present");
  } catch (error) {
    if (error instanceof ArtifactLifecycleError || (error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
  const archivesRoot = await boundDirectory(resolve(storeRoot, "archives"), storeRoot);
  const archives = await readdir(archivesRoot, { withFileTypes: true });
  archives.sort((left, right) => compareCanonicalText(left.name, right.name));
  if (archives.length > maxArchiveGenerations) {
    fail("ARTIFACT_LIMIT_EXCEEDED", `archive generations ${archives.length}`);
  }
  let storedBytes = 0;
  for (const entry of archives) {
    const path = resolve(archivesRoot, entry.name);
    if (entry.isSymbolicLink()) {
      fail("ARTIFACT_LINK_UNSAFE", path);
    }
    if (!entry.isDirectory() || !/^[a-f0-9]{24}$/u.test(entry.name)) {
      fail("ARTIFACT_SPECIAL_FILE", path);
    }
    await boundDirectory(path, archivesRoot);
    const contents = await readdir(path, { withFileTypes: true });
    contents.sort((left, right) => compareCanonicalText(left.name, right.name));
    if (contents.length > maxArchiveFilesPerGeneration) {
      fail("ARTIFACT_LIMIT_EXCEEDED", `archive generation entries ${path}:${contents.length}`);
    }
    for (const content of contents) {
      const contentPath = resolve(path, content.name);
      const metadata = await lstat(contentPath, { bigint: true });
      if (metadata.isSymbolicLink()) fail("ARTIFACT_LINK_UNSAFE", contentPath);
      if (!metadata.isFile()) fail("ARTIFACT_SPECIAL_FILE", contentPath);
      if (metadata.nlink !== 1n) fail("ARTIFACT_LINK_UNSAFE", contentPath);
      if (metadata.size > BigInt(maxArchiveBytes)) {
        fail("ARTIFACT_LIMIT_EXCEEDED", `archive generation bytes ${contentPath}:${metadata.size}`);
      }
      storedBytes += Number(metadata.size);
      if (storedBytes > maxArchiveStoredBytes) {
        fail("ARTIFACT_LIMIT_EXCEEDED", `archive stored bytes ${storedBytes}`);
      }
    }
    if (JSON.stringify(contents.map((content) => content.name)) !== JSON.stringify(["bundle.json"])) {
      fail("ARTIFACT_PARTIAL_STATE", path);
    }
    // The bundle bytes are deliberately not read here. This is a partial-state check, and
    // the loop above already established every property it can act on -- regular file,
    // single link, not a symlink, within the byte budget. Reading the file only to discard
    // it cost a full pass over every generation on every verb that resolves the store
    // (doctor, size-report, compact, archive, apply, restore): up to 16 generations of
    // 32 MiB each. Content faults surface at the point of use, where restore already
    // performs the same hardened read and can act on what it finds.
  }
  return { generationCount: archives.length, storedBytes };
}

async function resolveArtifactStore(workspaceRootInput: string, options: ArtifactScanOptions = {}): Promise<{
  readonly workspaceRoot: string;
  readonly workspaceExternalKey: string;
  readonly storeRoot: string;
  readonly marker: ArtifactStoreMarker;
  readonly archiveStorage: ArchiveStorageSummary;
}> {
  const state = await materializeWorkspace(workspaceRootInput);
  const workspaceRoot = await boundDirectory(workspaceRootInput);
  const storedWorkspaceRoot = state.metadata.roots.find((root) => root.kind === "workspace")?.canonicalPath;
  if (storedWorkspaceRoot !== workspaceRoot) {
    fail("ARTIFACT_PATH_INVALID", "artifact store root is not the Workspace authority root");
  }
  const storeRoot = await boundDirectory(resolve(workspaceRoot, ".tcrn-workflow/artifacts"), workspaceRoot);
  for (const relativePath of ["records", "transient", "transient/receipts", "transient/cache", "archives"]) {
    await boundDirectory(resolve(storeRoot, relativePath), storeRoot);
  }
  const marker = await readStoreMarker(storeRoot, options);
  if (marker.workspaceId !== state.metadata.workspaceId || marker.eventHighWaterDigest !== state.headEventHash) {
    fail("ARTIFACT_HIGH_WATER_MISMATCH", state.metadata.workspaceId);
  }
  const archiveStorage = await assertNoPartialState(storeRoot, options);
  return { workspaceRoot, workspaceExternalKey: state.metadata.externalKey, storeRoot, marker, archiveStorage };
}

async function scanArtifactStore(workspaceRootInput: string, options: ArtifactScanOptions = {}): Promise<ArtifactStoreScan> {
  const resolved = await resolveArtifactStore(workspaceRootInput, options);
  const recordsRoot = await boundDirectory(resolve(resolved.storeRoot, "records"), resolved.storeRoot);
  const records: ScannedArtifactRecord[] = [];
  const entries = await readdir(recordsRoot, { withFileTypes: true });
  entries.sort((left, right) => compareCanonicalText(left.name, right.name));
  if (entries.length > maxEntries) {
    fail("ARTIFACT_LIMIT_EXCEEDED", `record count ${entries.length}`);
  }
  let storedBytes = 0;
  let logicalBytes = 0;
  for (const entry of entries) {
    const path = resolve(recordsRoot, entry.name);
    if (entry.isSymbolicLink()) {
      fail("ARTIFACT_LINK_UNSAFE", path);
    }
    if (!entry.isFile()) {
      fail("ARTIFACT_SPECIAL_FILE", path);
    }
    if (!/^artifact:[a-f0-9]{24}\.json$/u.test(entry.name)) {
      fail("ARTIFACT_PATH_INVALID", entry.name);
    }
    const opened = await readBoundRegularFile(path, maxSourceBytes, options);
    const value = parseCanonicalObject(opened.bytes, "artifact record", "ARTIFACT_INPUT_INVALID");
    const record = validateArtifactRecord(value, resolved.marker);
    if (`${record.id}.json` !== entry.name) {
      fail("ARTIFACT_PATH_INVALID", entry.name);
    }
    storedBytes += opened.bytes.length;
    logicalBytes += record.byteSize;
    if (storedBytes > maxStoredBytes) fail("ARTIFACT_LIMIT_EXCEEDED", `stored bytes ${storedBytes}`);
    if (logicalBytes > maxLogicalBytes) fail("ARTIFACT_LIMIT_EXCEEDED", `logical bytes ${logicalBytes}`);
    records.push({
      path,
      relativePath: `records/${entry.name}`,
      bytes: opened.bytes,
      record,
      classification: classifyArtifact(record.kind),
    });
  }
  const transient: ScannedTransient[] = [];
  const transientGroups: {
    readonly directoryName: "receipts" | "cache";
    readonly classification: "transient-receipt" | "transient-cache";
    readonly root: string;
    readonly entries: readonly Dirent[];
  }[] = [];
  for (const [directoryName, classification] of [["receipts", "transient-receipt"], ["cache", "transient-cache"]] as const) {
    const root = await boundDirectory(resolve(resolved.storeRoot, `transient/${directoryName}`), resolved.storeRoot);
    const transientEntries = await readdir(root, { withFileTypes: true });
    transientEntries.sort((left, right) => compareCanonicalText(left.name, right.name));
    transientGroups.push({ directoryName, classification, root, entries: transientEntries });
  }
  const transientCount = transientGroups.reduce((total, group) => total + group.entries.length, 0);
  if (records.length + transientCount > maxEntries) {
    fail("ARTIFACT_LIMIT_EXCEEDED", `entry count ${records.length + transientCount}`);
  }
  for (const group of transientGroups) {
    for (const entry of group.entries) {
      const { directoryName, classification, root } = group;
      const path = resolve(root, entry.name);
      if (entry.isSymbolicLink()) {
        fail("ARTIFACT_LINK_UNSAFE", path);
      }
      if (!entry.isFile()) {
        fail("ARTIFACT_SPECIAL_FILE", path);
      }
      if (!/^[A-Za-z0-9._-]{1,128}$/u.test(entry.name)) {
        fail("ARTIFACT_PATH_INVALID", entry.name);
      }
      const opened = await readBoundRegularFile(path, maxSourceBytes, options);
      storedBytes += opened.bytes.length;
      logicalBytes += opened.bytes.length;
      if (storedBytes > maxStoredBytes) fail("ARTIFACT_LIMIT_EXCEEDED", `stored bytes ${storedBytes}`);
      if (logicalBytes > maxLogicalBytes) fail("ARTIFACT_LIMIT_EXCEEDED", `logical bytes ${logicalBytes}`);
      transient.push({
        path,
        relativePath: `transient/${directoryName}/${entry.name}`,
        size: opened.bytes.length,
        classification,
      });
    }
  }
  return { ...resolved, records, transient };
}

export async function initializeArtifactStore(workspaceRootInput: string, options: { readonly disposable: boolean }): Promise<ArtifactStoreMarker> {
  const state = await materializeWorkspace(workspaceRootInput);
  if (!state.headEventHash) {
    fail("ARTIFACT_HIGH_WATER_MISMATCH", "artifact store requires a non-empty event authority");
  }
  if (options.disposable && !state.metadata.externalKey.startsWith("FIXTURE-")) {
    fail("ARTIFACT_WORKSPACE_NOT_DISPOSABLE", state.metadata.externalKey);
  }
  const workspaceRoot = await boundDirectory(workspaceRootInput);
  const storeRoot = await ensureDirectory(resolve(workspaceRoot, ".tcrn-workflow/artifacts"), workspaceRoot);
  await ensureDirectory(resolve(storeRoot, "records"), storeRoot);
  const transientRoot = await ensureDirectory(resolve(storeRoot, "transient"), storeRoot);
  await ensureDirectory(resolve(transientRoot, "receipts"), storeRoot);
  await ensureDirectory(resolve(transientRoot, "cache"), storeRoot);
  await ensureDirectory(resolve(storeRoot, "archives"), storeRoot);
  const marker: ArtifactStoreMarker = {
    schemaVersion: ARTIFACT_STORE_SCHEMA_VERSION,
    workspaceId: state.metadata.workspaceId,
    eventHighWaterDigest: state.headEventHash,
    disposable: options.disposable,
    authority: "metadata-reference-only",
  };
  await writeExclusiveFile(resolve(storeRoot, "store.json"), canonicalJson(marker));
  return marker;
}

function emptyCategory(): { count: number; logicalBytes: number; storedBytes: number } {
  return { count: 0, logicalBytes: 0, storedBytes: 0 };
}

export async function artifactSizeReport(workspaceRoot: string, options: ArtifactScanOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  const scan = await scanArtifactStore(workspaceRoot, options);
  const categories: Record<ArtifactClassification, { count: number; logicalBytes: number; storedBytes: number }> = {
    "authoritative-artifact": emptyCategory(),
    "protected-record": emptyCategory(),
    "durable-evidence-reference": emptyCategory(),
    "transient-receipt": emptyCategory(),
    "transient-cache": emptyCategory(),
  };
  for (const entry of scan.records) {
    const category = categories[entry.classification];
    category.count += 1;
    category.logicalBytes += entry.record.byteSize;
    category.storedBytes += entry.bytes.length;
  }
  for (const entry of scan.transient) {
    const category = categories[entry.classification];
    category.count += 1;
    category.logicalBytes += entry.size;
    category.storedBytes += entry.size;
  }
  const artifactTotals = Object.values(categories).reduce((result, category) => ({
    count: result.count + category.count,
    logicalBytes: result.logicalBytes + category.logicalBytes,
    storedBytes: result.storedBytes + category.storedBytes,
  }), emptyCategory());
  const archiveStorage = {
    generationCount: scan.archiveStorage.generationCount,
    storedBytes: scan.archiveStorage.storedBytes,
    maximumGenerations: maxArchiveGenerations,
    maximumStoredBytes: maxArchiveStoredBytes,
  };
  const totals = {
    count: artifactTotals.count + archiveStorage.generationCount,
    logicalBytes: artifactTotals.logicalBytes + archiveStorage.storedBytes,
    storedBytes: artifactTotals.storedBytes + archiveStorage.storedBytes,
  };
  if (totals.logicalBytes > maxLogicalBytes) {
    fail("ARTIFACT_LIMIT_EXCEEDED", canonicalJson(totals));
  }
  return {
    schemaVersion: "tcrn.artifact-size-report.v1",
    reasonCode: "ARTIFACT_SIZE_REPORT_READY",
    workspaceId: scan.marker.workspaceId,
    eventHighWaterDigest: scan.marker.eventHighWaterDigest,
    categories,
    archiveStorage,
    limits: ARTIFACT_LIMITS,
    totals,
  };
}

function budget(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  assertSafeInteger(selected, 1, maxLogicalBytes, label);
  return selected;
}

export async function artifactDoctor(workspaceRoot: string, budgets: ArtifactDoctorBudgets = {}, options: ArtifactScanOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  const report = await artifactSizeReport(workspaceRoot, options);
  const totals = report.totals as Readonly<Record<string, JsonValue>>;
  const warningBytes = budget(budgets.warningBytes, 1_048_576, "warningBytes");
  const criticalBytes = budget(budgets.criticalBytes, 4_194_304, "criticalBytes");
  const warningCount = budget(budgets.warningCount, 100, "warningCount");
  const criticalCount = budget(budgets.criticalCount, 500, "criticalCount");
  if (warningBytes >= criticalBytes || warningCount >= criticalCount) {
    fail("ARTIFACT_INPUT_INVALID", "warning budgets must be below critical budgets");
  }
  const totalBytes = Number(totals.logicalBytes);
  const totalCount = Number(totals.count);
  const diagnostics: string[] = [];
  if (totalBytes >= criticalBytes) diagnostics.push("ARTIFACT_BUDGET_BYTES_CRITICAL");
  else if (totalBytes >= warningBytes) diagnostics.push("ARTIFACT_BUDGET_BYTES_WARNING");
  if (totalCount >= criticalCount) diagnostics.push("ARTIFACT_BUDGET_COUNT_CRITICAL");
  else if (totalCount >= warningCount) diagnostics.push("ARTIFACT_BUDGET_COUNT_WARNING");
  const severity = diagnostics.some((value) => value.endsWith("CRITICAL")) ? "critical" : diagnostics.length > 0 ? "warning" : "ok";
  const reasonCode = severity === "critical" ? "ARTIFACT_DOCTOR_CRITICAL" : severity === "warning" ? "ARTIFACT_DOCTOR_WARNING" : "ARTIFACT_DOCTOR_OK";
  return {
    schemaVersion: "tcrn.artifact-doctor.v1",
    reasonCode,
    severity,
    diagnostics,
    budgets: { warningBytes, criticalBytes, warningCount, criticalCount },
    sizeReport: report,
    implicitDeletion: false,
  };
}

function publicProjection(scan: ArtifactStoreScan): Readonly<Record<string, JsonValue>> {
  const retained = scan.records
    .filter((entry) => !entry.classification.startsWith("transient-"))
    .map((entry) => ({
      id: entry.record.id,
      kind: entry.record.kind,
      state: entry.record.state,
      classification: entry.classification,
      path: entry.relativePath,
      size: entry.bytes.length,
      sha256: sha256(entry.bytes),
    }));
  const dropped = [
    ...scan.records.filter((entry) => entry.classification.startsWith("transient-")).map((entry) => ({
      path: entry.relativePath,
      classification: entry.classification,
      reason: "transient-by-default",
    })),
    ...scan.transient.map((entry) => ({
      path: entry.relativePath,
      classification: entry.classification,
      reason: "transient-by-default",
    })),
  ].sort((left, right) => compareCanonicalText(left.path, right.path));
  retained.sort((left, right) => compareCanonicalText(left.id, right.id));
  const projection = {
    schemaVersion: "tcrn.artifact-compact-projection.v1",
    workspaceId: scan.marker.workspaceId,
    eventHighWaterDigest: scan.marker.eventHighWaterDigest,
    retained,
    dropped,
    mutationApplied: false,
  };
  return { ...projection, projectionDigest: canonicalSha256(projection) };
}

export async function artifactCompactDryRun(workspaceRoot: string, options: ArtifactScanOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  const scan = await scanArtifactStore(workspaceRoot, options);
  return {
    reasonCode: "ARTIFACT_COMPACT_DRY_RUN_READY",
    ...publicProjection(scan),
  };
}

async function archiveProjection(workspaceRoot: string, options: ArtifactScanOptions = {}): Promise<{
  readonly scan: ArtifactStoreScan;
  readonly plan: Readonly<Record<string, JsonValue>>;
}> {
  const scan = await scanArtifactStore(workspaceRoot, options);
  const projection = publicProjection(scan);
  const base = {
    schemaVersion: "tcrn.artifact-archive-plan.v1",
    workspaceId: scan.marker.workspaceId,
    eventHighWaterDigest: scan.marker.eventHighWaterDigest,
    retained: projection.retained,
    dropped: projection.dropped,
    mutationApplied: false,
  };
  const planDigest = canonicalSha256(base);
  const archiveId = `artifact-archive:${planDigest.slice(0, 24)}`;
  return {
    scan,
    plan: {
      reasonCode: "ARTIFACT_ARCHIVE_DRY_RUN_READY",
      ...base,
      archiveId,
      planDigest,
    },
  };
}

export async function artifactArchiveDryRun(workspaceRoot: string, options: ArtifactScanOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  return (await archiveProjection(workspaceRoot, options)).plan;
}

function assertDisposable(scan: ArtifactStoreScan): void {
  if (!scan.marker.disposable || !scan.workspaceExternalKey.startsWith("FIXTURE-")) {
    fail("ARTIFACT_WORKSPACE_NOT_DISPOSABLE", scan.marker.workspaceId);
  }
}

function crash(point: ArtifactFaultPoint, selected?: ArtifactFaultPoint): void {
  if (point === selected) {
    fail("ARTIFACT_FAULT_INJECTED", point);
  }
}

function canonicalBase64(bytes: Buffer): string {
  return bytes.toString("base64");
}

function decodeCanonicalBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    fail("ARTIFACT_ARCHIVE_INVALID", "archive content must be base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    fail("ARTIFACT_ARCHIVE_INVALID", "archive content base64 is noncanonical");
  }
  return bytes;
}

export async function applyArtifactArchive(workspaceRoot: string, options: ArtifactArchiveOptions): Promise<Readonly<Record<string, JsonValue>>> {
  assertHexDigest(options.expectedPlanDigest, "expected plan", "ARTIFACT_INPUT_INVALID");
  const projected = await archiveProjection(workspaceRoot, options);
  assertDisposable(projected.scan);
  if (projected.plan.planDigest !== options.expectedPlanDigest) {
    fail("ARTIFACT_SOURCE_CHANGED", "archive plan digest changed before apply");
  }
  const archiveId = String(projected.plan.archiveId);
  const retainedIds = new Set((projected.plan.retained as readonly Readonly<Record<string, JsonValue>>[]).map((entry) => String(entry.id)));
  const entries = projected.scan.records.filter((entry) => retainedIds.has(entry.record.id)).map((entry) => ({
    path: entry.relativePath,
    size: entry.bytes.length,
    sha256: sha256(entry.bytes),
    contentBase64: canonicalBase64(entry.bytes),
  }));
  const bundle = {
    schemaVersion: ARTIFACT_ARCHIVE_SCHEMA_VERSION,
    archiveId,
    workspaceId: projected.scan.marker.workspaceId,
    eventHighWaterDigest: projected.scan.marker.eventHighWaterDigest,
    planDigest: options.expectedPlanDigest,
    retained: projected.plan.retained,
    dropped: projected.plan.dropped,
    mutationApplied: false,
    entries,
  };
  const bundleBytes = Buffer.from(canonicalJson(bundle), "utf8");
  if (bundleBytes.length > maxArchiveBytes) {
    fail("ARTIFACT_LIMIT_EXCEEDED", `archive bytes ${bundleBytes.length}`);
  }
  if (projected.scan.archiveStorage.generationCount + 1 > maxArchiveGenerations) {
    fail("ARTIFACT_LIMIT_EXCEEDED", `archive generations ${projected.scan.archiveStorage.generationCount + 1}`);
  }
  if (projected.scan.archiveStorage.storedBytes + bundleBytes.length > maxArchiveStoredBytes) {
    fail("ARTIFACT_LIMIT_EXCEEDED", `archive stored bytes ${projected.scan.archiveStorage.storedBytes + bundleBytes.length}`);
  }
  const archiveDirectory = resolve(projected.scan.storeRoot, `archives/${archiveId.slice("artifact-archive:".length)}`);
  try {
    await mkdir(archiveDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      const existing = await boundDirectory(archiveDirectory, resolve(projected.scan.storeRoot, "archives"));
      const contents = await readdir(existing);
      if (JSON.stringify(contents.sort(compareCanonicalText)) === JSON.stringify(["bundle.json"])) {
        fail("ARTIFACT_ARCHIVE_EXISTS", archiveId);
      }
      fail("ARTIFACT_PARTIAL_STATE", archiveId);
    }
    fail("ARTIFACT_PATH_INVALID", String(error));
  }
  await boundDirectory(archiveDirectory, resolve(projected.scan.storeRoot, "archives"));
  crash("after-archive-directory", options.faultAt);
  const temporaryPath = resolve(archiveDirectory, `.bundle-${randomBytes(12).toString("hex")}.tmp`);
  const temporary = await writeExclusiveFile(temporaryPath, bundleBytes);
  crash("after-bundle-sync", options.faultAt);
  const bundlePath = resolve(archiveDirectory, "bundle.json");
  await rename(temporary.path, bundlePath);
  const named = await lstat(bundlePath);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameIdentity(named, temporary.identity)) {
    fail("ARTIFACT_SOURCE_CHANGED", bundlePath);
  }
  crash("after-bundle-commit", options.faultAt);
  const finalState = await materializeWorkspace(workspaceRoot);
  if (finalState.headEventHash !== projected.scan.marker.eventHighWaterDigest) {
    fail("ARTIFACT_HIGH_WATER_MISMATCH", "Workspace changed during archive apply");
  }
  return {
    schemaVersion: "tcrn.artifact-archive-apply-result.v1",
    reasonCode: "ARTIFACT_ARCHIVE_APPLIED",
    archiveId,
    planDigest: options.expectedPlanDigest,
    bundleDigest: canonicalSha256(bundle),
    entries: entries.length,
    eventHighWaterDigest: projected.scan.marker.eventHighWaterDigest,
    authorityMutated: false,
  };
}

function validateArchiveBundle(value: Readonly<Record<string, JsonValue>>, archiveId: string, marker: ArtifactStoreMarker): readonly {
  path: string;
  size: number;
  sha256: string;
  bytes: Buffer;
}[] {
  exactFields(value, archiveFields, "artifact archive", "ARTIFACT_ARCHIVE_INVALID");
  if (value.schemaVersion !== ARTIFACT_ARCHIVE_SCHEMA_VERSION || value.archiveId !== archiveId ||
    value.workspaceId !== marker.workspaceId || value.eventHighWaterDigest !== marker.eventHighWaterDigest ||
    typeof value.planDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.planDigest) || !Array.isArray(value.retained) ||
    !Array.isArray(value.dropped) || value.mutationApplied !== false || !Array.isArray(value.entries)) {
    fail("ARTIFACT_ARCHIVE_INVALID", archiveId);
  }
  const planBase = {
    schemaVersion: "tcrn.artifact-archive-plan.v1",
    workspaceId: marker.workspaceId,
    eventHighWaterDigest: marker.eventHighWaterDigest,
    retained: value.retained,
    dropped: value.dropped,
    mutationApplied: false,
  };
  if (canonicalSha256(planBase) !== value.planDigest || `artifact-archive:${value.planDigest.slice(0, 24)}` !== archiveId) {
    fail("ARTIFACT_ARCHIVE_INVALID", "archive plan binding is invalid");
  }
  if (value.entries.length > maxEntries) {
    fail("ARTIFACT_LIMIT_EXCEEDED", `archive entries ${value.entries.length}`);
  }
  const entries: { path: string; size: number; sha256: string; bytes: Buffer }[] = [];
  const retainedByPath = new Map<string, Readonly<Record<string, JsonValue>>>();
  for (const raw of value.retained) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || typeof raw.path !== "string") {
      fail("ARTIFACT_ARCHIVE_INVALID", "retained plan entry is invalid");
    }
    if (retainedByPath.has(raw.path)) {
      fail("ARTIFACT_ARCHIVE_INVALID", `duplicate retained path ${raw.path}`);
    }
    retainedByPath.set(raw.path, raw);
  }
  if (retainedByPath.size !== value.entries.length) {
    fail("ARTIFACT_ARCHIVE_INVALID", "archive entry count does not match retained plan");
  }
  let priorPath: string | undefined;
  let decodedBytes = 0;
  for (const raw of value.entries) {
    exactFields(raw, archiveEntryFields, "archive entry", "ARTIFACT_ARCHIVE_INVALID");
    if (typeof raw.path !== "string" || typeof raw.size !== "number" || !Number.isSafeInteger(raw.size) ||
      raw.size < 0 || raw.size > maxSourceBytes || typeof raw.sha256 !== "string") {
      fail("ARTIFACT_ARCHIVE_INVALID", "archive entry fields are invalid");
    }
    assertArtifactRelativePath(raw.path);
    if (!/^records\/artifact:[a-f0-9]{24}\.json$/u.test(raw.path)) {
      fail("ARTIFACT_ARCHIVE_INVALID", raw.path);
    }
    assertHexDigest(raw.sha256, "archive entry", "ARTIFACT_ARCHIVE_INVALID");
    const bytes = decodeCanonicalBase64(raw.contentBase64);
    decodedBytes += bytes.length;
    if (decodedBytes > maxStoredBytes) {
      fail("ARTIFACT_LIMIT_EXCEEDED", `archive decoded bytes ${decodedBytes}`);
    }
    const retained = retainedByPath.get(raw.path);
    if (!retained || retained.size !== raw.size || retained.sha256 !== raw.sha256 || bytes.length !== raw.size ||
      sha256(bytes) !== raw.sha256 || (priorPath && compareCanonicalText(priorPath, raw.path) >= 0)) {
      fail("ARTIFACT_ARCHIVE_INVALID", raw.path);
    }
    const record = validateArtifactRecord(parseCanonicalObject(bytes, "archived artifact record", "ARTIFACT_ARCHIVE_INVALID"), marker);
    if (raw.path !== `records/${record.id}.json`) {
      fail("ARTIFACT_ARCHIVE_INVALID", raw.path);
    }
    priorPath = raw.path;
    entries.push({ path: raw.path, size: raw.size, sha256: raw.sha256, bytes });
  }
  return entries;
}

async function releaseRestoreClaim(storeRoot: string, claim: ExclusiveFile, token: string): Promise<void> {
  const current = await lstat(claim.path);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameIdentity(current, claim.identity)) {
    fail("ARTIFACT_SOURCE_CHANGED", "restore claim identity changed");
  }
  const quarantine = resolve(storeRoot, `released-restore-${token}`);
  await rename(claim.path, quarantine);
  const moved = await lstat(quarantine);
  if (!sameIdentity(moved, claim.identity) || !moved.isFile() || moved.isSymbolicLink() || moved.nlink !== 1) {
    fail("ARTIFACT_SOURCE_CHANGED", "released restore claim identity changed");
  }
  await rm(quarantine);
}

export async function restoreArtifactArchive(workspaceRoot: string, archiveId: string, options: ArtifactArchiveOptions): Promise<Readonly<Record<string, JsonValue>>> {
  if (!/^artifact-archive:[a-f0-9]{24}$/u.test(archiveId)) {
    fail("ARTIFACT_PATH_INVALID", archiveId);
  }
  assertHexDigest(options.expectedPlanDigest, "expected plan", "ARTIFACT_INPUT_INVALID");
  const scan = await scanArtifactStore(workspaceRoot, options);
  assertDisposable(scan);
  if (scan.records.length !== 0) {
    fail("ARTIFACT_RESTORE_CONFLICT", "record authority is not empty");
  }
  const bundlePath = resolve(scan.storeRoot, `archives/${archiveId.slice("artifact-archive:".length)}/bundle.json`);
  const opened = await readBoundRegularFile(bundlePath, maxArchiveBytes, options);
  const bundle = parseCanonicalObject(opened.bytes, "artifact archive", "ARTIFACT_ARCHIVE_INVALID");
  const entries = validateArchiveBundle(bundle, archiveId, scan.marker);
  if (bundle.planDigest !== options.expectedPlanDigest) {
    fail("ARTIFACT_SOURCE_CHANGED", "archive plan digest does not match restore admission");
  }
  const token = randomBytes(24).toString("hex");
  let claim: ExclusiveFile;
  try {
    claim = await writeExclusiveFile(resolve(scan.storeRoot, "restore.claim"), canonicalJson({
      schemaVersion: "tcrn.artifact-restore-claim.v1",
      workspaceId: scan.marker.workspaceId,
      archiveId,
      token,
    }));
  } catch (error) {
    if (error instanceof ArtifactLifecycleError && error.reasonCode === "ARTIFACT_RESTORE_CONFLICT") {
      fail("ARTIFACT_PARTIAL_STATE", "another or partial restore claim exists");
    }
    throw error;
  }
  crash("after-restore-claim", options.faultAt);
  for (const [index, entry] of entries.entries()) {
    await writeExclusiveFile(resolve(scan.storeRoot, entry.path), entry.bytes);
    if (index === 0) {
      crash("after-first-restore-write", options.faultAt);
    }
  }
  const finalState = await materializeWorkspace(workspaceRoot);
  if (finalState.headEventHash !== scan.marker.eventHighWaterDigest) {
    fail("ARTIFACT_HIGH_WATER_MISMATCH", "Workspace changed during restore");
  }
  await releaseRestoreClaim(scan.storeRoot, claim, token);
  const restored = await scanArtifactStore(workspaceRoot, options);
  const restoredDigest = canonicalSha256(restored.records.map((entry) => ({
    path: entry.relativePath,
    size: entry.bytes.length,
    sha256: sha256(entry.bytes),
  })));
  return {
    schemaVersion: "tcrn.artifact-archive-restore-result.v1",
    reasonCode: "ARTIFACT_ARCHIVE_RESTORED",
    archiveId,
    planDigest: options.expectedPlanDigest,
    restored: restored.records.length,
    restoredDigest,
    eventHighWaterDigest: scan.marker.eventHighWaterDigest,
    exact: true,
  };
}
