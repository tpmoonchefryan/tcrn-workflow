// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  PROTOCOL_LIMITS,
  ProtocolError,
  assertCanonicalJson,
  assertStrictInstant,
  assertWorkTransition,
  canonicalExternalKey,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  createEvent,
  deriveStableId,
  parseStrictInstant,
  validateEventChain,
  validateWorkGraph,
} from "../../protocol/src/index.js";
import type {
  EventRecord,
  JsonValue,
  PlannedDeliveryKind,
  WorkRecord,
  WorkStatus,
} from "../../protocol/src/index.js";
import { assertDistinctRoots } from "./root-identity.js";
import type { CanonicalRoot } from "./root-identity.js";
import type { ExplicitRoot } from "./index.js";

export const WORKSPACE_SCHEMA_VERSION = "tcrn.workspace.v1" as const;
export const WORKSPACE_STORAGE_VERSION = 1 as const;
export const WORKSPACE_CONTROL_DIRECTORY = ".tcrn-workflow" as const;
export const WORKSPACE_REASON_CODES = Object.freeze([
  "WORKSPACE_ALREADY_EXISTS",
  "WORKSPACE_CAS_MISMATCH",
  "WORKSPACE_EVENT_CORRUPT",
  "WORKSPACE_FAULT_INJECTED",
  "WORKSPACE_FILESYSTEM_UNSUPPORTED",
  "WORKSPACE_INPUT_INVALID",
  "WORKSPACE_INPUT_OVERSIZED",
  "WORKSPACE_LEASE_INVALID",
  "WORKSPACE_LOCKED",
  "WORKSPACE_MIGRATION_APPLY_UNAVAILABLE",
  "WORKSPACE_MIGRATION_DOWNGRADE",
  "WORKSPACE_MIGRATION_FUTURE",
  "WORKSPACE_PATH_ESCAPE",
  "WORKSPACE_PATH_INVALID",
  "WORKSPACE_RECORD_LIMIT",
  "WORKSPACE_SCHEMA_INVALID",
  "WORKSPACE_VIEW_STALE",
] as const);

export type WorkspaceReasonCode = typeof WORKSPACE_REASON_CODES[number];
export type WorkspaceCrashPoint =
  | "before-write"
  | "after-temp-sync"
  | "after-event-commit"
  | "before-view-commit";

export class WorkspaceError extends Error {
  readonly reasonCode: WorkspaceReasonCode;

  constructor(reasonCode: WorkspaceReasonCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.reasonCode = reasonCode;
  }
}

export interface WorkspaceMetadata {
  readonly schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  readonly storageVersion: 1;
  readonly minimumStorageVersion: 1;
  readonly maximumStorageVersion: 1;
  readonly workspaceId: string;
  readonly externalKey: string;
  readonly createdAt: string;
  readonly segmentEventLimit: number;
  readonly roots: readonly CanonicalRoot[];
}

export interface ProjectRecord {
  readonly schemaVersion: "tcrn.project.v1";
  readonly id: string;
  readonly externalKey: string;
  readonly name: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
}

export interface WorkspaceState {
  readonly metadata: WorkspaceMetadata;
  readonly version: number;
  readonly headEventHash: string | null;
  readonly projects: readonly ProjectRecord[];
  readonly work: readonly WorkRecord[];
  readonly events: readonly EventRecord[];
}

export interface WorkspaceLease {
  readonly workspaceRoot: string;
  readonly token: string;
  readonly acquiredAt: string;
  release(): Promise<void>;
}

export interface WorkspaceMutationOptions {
  readonly expectedVersion: number;
  readonly occurredAt: string;
  readonly crashAt?: WorkspaceCrashPoint;
}

export interface WorkspaceMigrationPlan {
  readonly schemaVersion: "tcrn.workspace-migration-plan.v1";
  readonly dryRun: true;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly steps: readonly string[];
  readonly backupRequired: true;
  readonly rollback: "restore-exact-pre-migration-backup-then-validate";
  readonly postValidation: "validate-exact-target-schema-and-full-event-chain";
  readonly applyAvailable: false;
  readonly basisDigest: string;
}

const supportedFilesystemTypes = new Set([
  0x1a,
  0x482b,
  0xef53,
  0x58465342,
  0x01021994,
  0x794c7630,
  0x9123683e,
  0x2fc12fc1,
]);
const projectFields = ["schemaVersion", "id", "externalKey", "name", "revision", "updatedAt", "tombstone"];
const metadataFields = [
  "schemaVersion",
  "storageVersion",
  "minimumStorageVersion",
  "maximumStorageVersion",
  "workspaceId",
  "externalKey",
  "createdAt",
  "segmentEventLimit",
  "roots",
];
let temporarySequence = 0;

function fail(reasonCode: WorkspaceReasonCode, message: string): never {
  throw new WorkspaceError(reasonCode, message);
}

function exactFields(value: unknown, expected: readonly string[], reasonCode: WorkspaceReasonCode, label: string): asserts value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(reasonCode, `${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareCanonicalText);
  const required = [...expected].sort(compareCanonicalText);
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    fail(reasonCode, `${label} fields are not exact`);
  }
}

function inside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
}

export function assertWorkspaceRelativePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || isAbsolute(value) || value.includes("\\")) {
    fail("WORKSPACE_PATH_ESCAPE", String(value));
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("WORKSPACE_PATH_ESCAPE", value);
  }
  try {
    canonicalJson(value);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("WORKSPACE_PATH_INVALID", error.message);
    }
    throw error;
  }
}

export async function assertSupportedWorkspaceFilesystem(root: string, detectedTypeForTest?: number): Promise<number> {
  const detected = detectedTypeForTest ?? Number((await statfs(root)).type);
  if (!Number.isSafeInteger(detected) || !supportedFilesystemTypes.has(detected)) {
    fail("WORKSPACE_FILESYSTEM_UNSUPPORTED", `filesystem type ${String(detected)} is not in the pinned local-filesystem set`);
  }
  return detected;
}

export function assertWorkspaceRecordCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > PROTOCOL_LIMITS.maxRecords) {
    fail("WORKSPACE_RECORD_LIMIT", String(count));
  }
}

async function boundDirectory(path: string, workspaceRoot?: string): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    fail("WORKSPACE_PATH_INVALID", `${path}: ${String((error as { code?: string }).code ?? error)}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("WORKSPACE_PATH_INVALID", `${path} must be a real directory`);
  }
  const resolved = await realpath(path);
  if (workspaceRoot && !inside(workspaceRoot, resolved)) {
    fail("WORKSPACE_PATH_ESCAPE", path);
  }
  const after = await lstat(resolved);
  if (!after.isDirectory() || metadata.dev !== after.dev || metadata.ino !== after.ino) {
    fail("WORKSPACE_PATH_INVALID", `${path} changed while resolving`);
  }
  return resolved;
}

async function boundFile(path: string, maximumBytes = PROTOCOL_LIMITS.maxCanonicalBytes): Promise<Buffer> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    fail("WORKSPACE_PATH_INVALID", `${path}: ${String((error as { code?: string }).code ?? error)}`);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    fail("WORKSPACE_PATH_INVALID", `${path} must be a single-link regular file`);
  }
  if (before.size > maximumBytes) {
    fail("WORKSPACE_INPUT_OVERSIZED", path);
  }
  if (typeof constants.O_NOFOLLOW !== "number") {
    fail("WORKSPACE_FILESYSTEM_UNSUPPORTED", "O_NOFOLLOW is unavailable");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail("WORKSPACE_PATH_INVALID", `${path} changed while opening`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 || content.length > maximumBytes) {
      fail("WORKSPACE_PATH_INVALID", `${path} changed while reading`);
    }
    return content;
  } finally {
    await handle?.close();
  }
}

async function ensureDirectory(path: string, workspaceRoot: string): Promise<string> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") {
      throw error;
    }
  }
  return boundDirectory(path, workspaceRoot);
}

function crash(point: WorkspaceCrashPoint, selected?: WorkspaceCrashPoint): void {
  if (point === selected) {
    fail("WORKSPACE_FAULT_INJECTED", `injected crash at ${point}`);
  }
}

async function atomicWrite(path: string, content: string | Buffer, workspaceRoot: string, crashAt?: WorkspaceCrashPoint): Promise<void> {
  crash("before-write", crashAt);
  const parent = await boundDirectory(dirname(path), workspaceRoot);
  if (!inside(parent, resolve(path))) {
    fail("WORKSPACE_PATH_ESCAPE", path);
  }
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
      fail("WORKSPACE_PATH_INVALID", `${path} is not a safe replaceable file`);
    }
  } catch (error) {
    if (error instanceof WorkspaceError || (error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
  const temporary = resolve(parent, `.tmp-${process.pid}-${temporarySequence += 1}`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(content);
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.nlink !== 1) {
      fail("WORKSPACE_PATH_INVALID", `${temporary} is not a single-link file`);
    }
    crash("after-temp-sync", crashAt);
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const committed = await lstat(path);
    if (!committed.isFile() || committed.isSymbolicLink() || committed.nlink !== 1 || committed.dev !== written.dev || committed.ino !== written.ino) {
      fail("WORKSPACE_PATH_INVALID", `${path} does not name the committed descriptor-written file`);
    }
    const directoryHandle = await open(parent, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

function validateProject(record: unknown, reasonCode: WorkspaceReasonCode = "WORKSPACE_EVENT_CORRUPT"): ProjectRecord {
  exactFields(record, projectFields, reasonCode, "project record");
  if (record.schemaVersion !== "tcrn.project.v1" || typeof record.id !== "string" || typeof record.externalKey !== "string" ||
    typeof record.name !== "string" || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1 ||
    typeof record.updatedAt !== "string" || typeof record.tombstone !== "boolean") {
    fail(reasonCode, "project record types are invalid");
  }
  try {
    if (record.externalKey !== canonicalExternalKey(record.externalKey) || record.id !== deriveStableId("project", record.externalKey)) {
      fail(reasonCode, "project identity is invalid");
    }
    assertStrictInstant(record.updatedAt);
    canonicalJson(record.name);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail(reasonCode, error.message);
    }
    throw error;
  }
  if ([...record.name].length < 1 || [...record.name].length > 512) {
    fail("WORKSPACE_INPUT_OVERSIZED", "project name limit exceeded");
  }
  return record as unknown as ProjectRecord;
}

function validateMetadata(value: unknown): WorkspaceMetadata {
  exactFields(value, metadataFields, "WORKSPACE_SCHEMA_INVALID", "workspace metadata");
  if (typeof value.storageVersion === "number" && value.storageVersion > WORKSPACE_STORAGE_VERSION) {
    fail("WORKSPACE_MIGRATION_FUTURE", String(value.storageVersion));
  }
  if (typeof value.storageVersion === "number" && value.storageVersion < WORKSPACE_STORAGE_VERSION) {
    fail("WORKSPACE_MIGRATION_DOWNGRADE", String(value.storageVersion));
  }
  if (value.schemaVersion !== WORKSPACE_SCHEMA_VERSION || value.storageVersion !== 1 || value.minimumStorageVersion !== 1 ||
    value.maximumStorageVersion !== 1 || typeof value.workspaceId !== "string" || typeof value.externalKey !== "string" ||
    typeof value.createdAt !== "string" || !Number.isSafeInteger(value.segmentEventLimit) || Number(value.segmentEventLimit) < 2 ||
    Number(value.segmentEventLimit) > 1024 || !Array.isArray(value.roots) || value.roots.length !== 5) {
    fail("WORKSPACE_SCHEMA_INVALID", "workspace metadata is not V1");
  }
  try {
    if (value.externalKey !== canonicalExternalKey(value.externalKey) || value.workspaceId !== deriveStableId("workspace", value.externalKey)) {
      fail("WORKSPACE_SCHEMA_INVALID", "workspace identity is invalid");
    }
    assertStrictInstant(value.createdAt);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("WORKSPACE_SCHEMA_INVALID", error.message);
    }
    throw error;
  }
  return value as unknown as WorkspaceMetadata;
}

function controlPath(workspaceRoot: string, relativePath = ""): string {
  assertWorkspaceRelativePath(relativePath === "" ? WORKSPACE_CONTROL_DIRECTORY : `${WORKSPACE_CONTROL_DIRECTORY}/${relativePath}`);
  const candidate = resolve(workspaceRoot, WORKSPACE_CONTROL_DIRECTORY, relativePath);
  if (!inside(workspaceRoot, candidate)) {
    fail("WORKSPACE_PATH_ESCAPE", relativePath);
  }
  return candidate;
}

async function readMetadata(workspaceRoot: string): Promise<WorkspaceMetadata> {
  const content = await boundFile(controlPath(workspaceRoot, "workspace.json"));
  try {
    return validateMetadata(assertCanonicalJson(content.toString("utf8")));
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    if (error instanceof ProtocolError) {
      fail("WORKSPACE_SCHEMA_INVALID", error.message);
    }
    fail("WORKSPACE_SCHEMA_INVALID", String(error));
  }
}

async function readSegmentEvents(workspaceRoot: string, metadata: WorkspaceMetadata): Promise<readonly EventRecord[]> {
  const eventsRoot = await boundDirectory(controlPath(workspaceRoot, "events"), workspaceRoot);
  const entries = await readdir(eventsRoot, { withFileTypes: true });
  entries.sort((left, right) => compareCanonicalText(left.name, right.name));
  const segmentNames: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^\d{6}\.json$/u.test(entry.name)) {
      fail("WORKSPACE_EVENT_CORRUPT", `unexpected event entry ${entry.name}`);
    }
    segmentNames.push(entry.name);
  }
  const events: EventRecord[] = [];
  for (const [index, name] of segmentNames.entries()) {
    if (name !== `${String(index + 1).padStart(6, "0")}.json`) {
      fail("WORKSPACE_EVENT_CORRUPT", `event segment gap at ${name}`);
    }
    const content = await boundFile(resolve(eventsRoot, name));
    let parsed: JsonValue;
    try {
      parsed = assertCanonicalJson(content.toString("utf8"));
    } catch (error) {
      fail("WORKSPACE_EVENT_CORRUPT", String((error as { message?: string }).message ?? error));
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > metadata.segmentEventLimit ||
      (index < segmentNames.length - 1 && parsed.length !== metadata.segmentEventLimit)) {
      fail("WORKSPACE_EVENT_CORRUPT", `${name} has an invalid segment length`);
    }
    for (const event of parsed) {
      events.push(event as unknown as EventRecord);
    }
  }
  assertWorkspaceRecordCount(events.length);
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) {
      fail("WORKSPACE_EVENT_CORRUPT", "on-disk event ordering is not canonical");
    }
  }
  try {
    return validateEventChain(events);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("WORKSPACE_EVENT_CORRUPT", `${error.reasonCode}:${error.message}`);
    }
    throw error;
  }
}

function payloadRecord(payload: JsonValue, operation: string): Readonly<Record<string, JsonValue>> {
  exactFields(payload, ["operation", "record"], "WORKSPACE_EVENT_CORRUPT", "event payload");
  if (payload.operation !== operation) {
    fail("WORKSPACE_EVENT_CORRUPT", `expected ${operation}`);
  }
  if (payload.record === null || typeof payload.record !== "object" || Array.isArray(payload.record)) {
    fail("WORKSPACE_EVENT_CORRUPT", `${operation} record is invalid`);
  }
  return payload.record;
}

function materialize(metadata: WorkspaceMetadata, events: readonly EventRecord[]): WorkspaceState {
  const projects = new Map<string, ProjectRecord>();
  const work = new Map<string, WorkRecord>();
  for (const event of events) {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload) || typeof payload.operation !== "string") {
      fail("WORKSPACE_EVENT_CORRUPT", `event ${event.id} payload is invalid`);
    }
    if (payload.operation.startsWith("project.")) {
      const record = validateProject(payloadRecord(payload, payload.operation));
      const current = projects.get(record.id);
      if (payload.operation === "project.created") {
        if (current || record.revision !== 1 || record.tombstone) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid project create ${record.id}`);
        }
      } else if (!current || record.revision !== current.revision + 1 || record.externalKey !== current.externalKey ||
        (payload.operation === "project.updated" && record.tombstone) || (payload.operation === "project.deleted" && !record.tombstone)) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid project mutation ${record.id}`);
      }
      projects.set(record.id, record);
      continue;
    }
    if (payload.operation.startsWith("work.")) {
      const record = payloadRecord(payload, payload.operation) as unknown as WorkRecord;
      const current = work.get(record.id);
      if (payload.operation === "work.created") {
        if (current || record.revision !== 1 || record.tombstone) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid work create ${record.id}`);
        }
      } else if (!current || record.revision !== current.revision + 1 || record.externalKey !== current.externalKey ||
        record.projectId !== current.projectId || record.kind !== current.kind || record.parentId !== current.parentId ||
        (payload.operation === "work.updated" && record.tombstone) || (payload.operation === "work.deleted" && !record.tombstone)) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid work mutation ${record.id}`);
      }
      work.set(record.id, record);
      continue;
    }
    fail("WORKSPACE_EVENT_CORRUPT", `unknown operation ${payload.operation}`);
  }
  const projectRecords = [...projects.values()].sort((left, right) => compareCanonicalText(left.id, right.id));
  let workRecords: readonly WorkRecord[];
  try {
    workRecords = validateWorkGraph([...work.values()]);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("WORKSPACE_EVENT_CORRUPT", `${error.reasonCode}:${error.message}`);
    }
    throw error;
  }
  for (const record of workRecords) {
    const project = projects.get(record.projectId);
    if (!project || (project.tombstone && !record.tombstone)) {
      fail("WORKSPACE_EVENT_CORRUPT", `work ${record.id} references an unavailable project`);
    }
  }
  return {
    metadata,
    version: events.length,
    headEventHash: events.at(-1)?.eventHash ?? null,
    projects: projectRecords,
    work: workRecords,
    events,
  };
}

function viewDocuments(state: WorkspaceState): Readonly<Record<string, string>> {
  const activeProjects = state.projects.filter((record) => !record.tombstone);
  const activeWork = state.work.filter((record) => !record.tombstone);
  const graphDigest = canonicalSha256({ projects: activeProjects, work: activeWork });
  const readback = {
    schemaVersion: "tcrn.workspace-readback.v1",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    projectCount: activeProjects.length,
    workCount: activeWork.length,
    graphDigest,
    authority: "derived-rebuildable",
  };
  const status = [
    "# Workspace Status",
    "",
    `- Workspace: \`${state.metadata.workspaceId}\``,
    `- Version: ${state.version}`,
    `- Projects: ${activeProjects.length}`,
    `- Work records: ${activeWork.length}`,
    `- Graph digest: \`${graphDigest}\``,
    "- Authority: derived and rebuildable from the event chain",
    "",
  ].join("\n");
  return {
    "STATUS.md": status,
    "index.json": canonicalJson({ schemaVersion: "tcrn.workspace-index.v1", projects: activeProjects, work: activeWork }),
    "readback.json": canonicalJson(readback),
  };
}

async function writeViews(workspaceRoot: string, state: WorkspaceState, crashAt?: WorkspaceCrashPoint): Promise<void> {
  crash("before-view-commit", crashAt);
  const views = viewDocuments(state);
  for (const name of Object.keys(views).sort(compareCanonicalText)) {
    await atomicWrite(controlPath(workspaceRoot, `views/${name}`), views[name] ?? "", workspaceRoot);
  }
}

async function assertLease(workspaceRoot: string, lease: WorkspaceLease): Promise<void> {
  if (lease.workspaceRoot !== workspaceRoot || typeof lease.token !== "string") {
    fail("WORKSPACE_LEASE_INVALID", "lease belongs to another workspace");
  }
  const content = await boundFile(controlPath(workspaceRoot, "lease/owner.json"), 16_384);
  let owner: JsonValue;
  try {
    owner = assertCanonicalJson(content.toString("utf8"));
  } catch (error) {
    fail("WORKSPACE_LEASE_INVALID", String(error));
  }
  exactFields(owner, ["schemaVersion", "token", "pid", "acquiredAt", "expiresAtNanoseconds"], "WORKSPACE_LEASE_INVALID", "lease owner");
  if (owner.schemaVersion !== "tcrn.workspace-lease.v1" || owner.token !== lease.token) {
    fail("WORKSPACE_LEASE_INVALID", "lease token no longer owns the workspace");
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

export async function acquireWorkspaceLease(workspaceRootInput: string, options: { readonly now: string; readonly ttlMilliseconds?: number } ): Promise<WorkspaceLease> {
  assertStrictInstant(options.now);
  const nowNanoseconds = parseStrictInstant(options.now);
  const workspaceRoot = await boundDirectory(workspaceRootInput);
  await readMetadata(workspaceRoot);
  const ttl = options.ttlMilliseconds ?? 30_000;
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 300_000) {
    fail("WORKSPACE_LEASE_INVALID", "lease TTL must be 1-300 seconds");
  }
  const leasePath = controlPath(workspaceRoot, "lease");
  try {
    await mkdir(leasePath, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") {
      throw error;
    }
    const directory = await boundDirectory(leasePath, workspaceRoot);
    const content = await boundFile(resolve(directory, "owner.json"), 16_384).catch(() => fail("WORKSPACE_LOCKED", "existing lease is malformed"));
    let owner: JsonValue;
    try {
      owner = assertCanonicalJson(content.toString("utf8"));
    } catch {
      fail("WORKSPACE_LOCKED", "existing lease is malformed");
    }
    exactFields(owner, ["schemaVersion", "token", "pid", "acquiredAt", "expiresAtNanoseconds"], "WORKSPACE_LOCKED", "lease owner");
    let expiresAtNanoseconds: bigint;
    try {
      expiresAtNanoseconds = typeof owner.expiresAtNanoseconds === "string" && /^-?[0-9]+$/u.test(owner.expiresAtNanoseconds)
        ? BigInt(owner.expiresAtNanoseconds)
        : fail("WORKSPACE_LOCKED", "existing lease expiry is malformed");
    } catch {
      fail("WORKSPACE_LOCKED", "existing lease expiry is malformed");
    }
    const pid = typeof owner.pid === "number" ? owner.pid : Number.NaN;
    if (!Number.isSafeInteger(pid) || expiresAtNanoseconds > nowNanoseconds || processAlive(pid)) {
      fail("WORKSPACE_LOCKED", "workspace already has an active writer");
    }
    const quarantine = controlPath(workspaceRoot, `stale-lease-${randomBytes(8).toString("hex")}`);
    await rename(leasePath, quarantine);
    await rm(quarantine, { recursive: true, force: true });
    await mkdir(leasePath, { mode: 0o700 });
  }
  await boundDirectory(leasePath, workspaceRoot);
  const token = randomBytes(24).toString("hex");
  const expiresAtNanoseconds = (nowNanoseconds + BigInt(ttl) * 1_000_000n).toString();
  await atomicWrite(resolve(leasePath, "owner.json"), canonicalJson({
    schemaVersion: "tcrn.workspace-lease.v1",
    token,
    pid: process.pid,
    acquiredAt: options.now,
    expiresAtNanoseconds,
  }), workspaceRoot);
  let released = false;
  return {
    workspaceRoot,
    token,
    acquiredAt: options.now,
    async release(): Promise<void> {
      if (released) {
        return;
      }
      await assertLease(workspaceRoot, this);
      const quarantine = controlPath(workspaceRoot, `released-lease-${token}`);
      await rename(leasePath, quarantine);
      await rm(quarantine, { recursive: true, force: true });
      released = true;
    },
  };
}

export async function withWorkspaceLease<T>(workspaceRoot: string, now: string, operation: (lease: WorkspaceLease) => Promise<T>): Promise<T> {
  const lease = await acquireWorkspaceLease(workspaceRoot, { now });
  try {
    return await operation(lease);
  } finally {
    await lease.release();
  }
}

export async function initializeWorkspace(options: {
  readonly roots: readonly ExplicitRoot[];
  readonly externalKey: string;
  readonly createdAt: string;
  readonly segmentEventLimit?: number;
  readonly detectedFilesystemTypeForTest?: number;
}): Promise<WorkspaceState> {
  const roots = await assertDistinctRoots(options.roots);
  const workspace = roots.find((root) => root.kind === "workspace");
  if (!workspace) {
    fail("WORKSPACE_SCHEMA_INVALID", "workspace root is missing");
  }
  await assertSupportedWorkspaceFilesystem(workspace.canonicalPath, options.detectedFilesystemTypeForTest);
  const externalKey = canonicalExternalKey(options.externalKey);
  assertStrictInstant(options.createdAt);
  const segmentEventLimit = options.segmentEventLimit ?? 64;
  if (!Number.isSafeInteger(segmentEventLimit) || segmentEventLimit < 2 || segmentEventLimit > 1024) {
    fail("WORKSPACE_SCHEMA_INVALID", "segment event limit must be 2-1024");
  }
  const control = controlPath(workspace.canonicalPath);
  try {
    await mkdir(control, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      fail("WORKSPACE_ALREADY_EXISTS", control);
    }
    throw error;
  }
  await boundDirectory(control, workspace.canonicalPath);
  await ensureDirectory(controlPath(workspace.canonicalPath, "events"), workspace.canonicalPath);
  await ensureDirectory(controlPath(workspace.canonicalPath, "views"), workspace.canonicalPath);
  await ensureDirectory(controlPath(workspace.canonicalPath, "backups"), workspace.canonicalPath);
  const metadata: WorkspaceMetadata = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    storageVersion: 1,
    minimumStorageVersion: 1,
    maximumStorageVersion: 1,
    workspaceId: deriveStableId("workspace", externalKey),
    externalKey,
    createdAt: options.createdAt,
    segmentEventLimit,
    roots,
  };
  await atomicWrite(controlPath(workspace.canonicalPath, "workspace.json"), canonicalJson(metadata), workspace.canonicalPath);
  const state = materialize(metadata, []);
  await writeViews(workspace.canonicalPath, state);
  return state;
}

async function resolveWorkspace(workspaceRootInput: string): Promise<{ readonly root: string; readonly metadata: WorkspaceMetadata }> {
  const root = await boundDirectory(workspaceRootInput);
  await assertSupportedWorkspaceFilesystem(root);
  await boundDirectory(controlPath(root), root);
  await boundDirectory(controlPath(root, "events"), root);
  await boundDirectory(controlPath(root, "views"), root);
  await boundDirectory(controlPath(root, "backups"), root);
  const metadata = await readMetadata(root);
  const canonicalRoots = await assertDistinctRoots(metadata.roots.map((entry) => ({ kind: entry.kind, path: entry.path })));
  const storedRootsMatch = canonicalRoots.every((entry, index) => {
    const stored = metadata.roots[index];
    return stored?.kind === entry.kind && stored.path === entry.path && stored.canonicalPath === entry.canonicalPath &&
      stored.portableIdentity === entry.portableIdentity;
  });
  if (!storedRootsMatch || canonicalRoots.find((entry) => entry.kind === "workspace")?.canonicalPath !== root) {
    fail("WORKSPACE_SCHEMA_INVALID", "stored roots do not match their current filesystem identities");
  }
  return { root, metadata };
}

export async function materializeWorkspace(workspaceRootInput: string): Promise<WorkspaceState> {
  const workspace = await resolveWorkspace(workspaceRootInput);
  return materialize(workspace.metadata, await readSegmentEvents(workspace.root, workspace.metadata));
}

export async function validateWorkspace(workspaceRootInput: string, checkViews = true): Promise<WorkspaceState> {
  const state = await materializeWorkspace(workspaceRootInput);
  if (checkViews) {
    const expected = viewDocuments(state);
    for (const name of Object.keys(expected).sort(compareCanonicalText)) {
      let actual: Buffer;
      try {
        actual = await boundFile(controlPath(state.metadata.roots.find((root) => root.kind === "workspace")?.canonicalPath ?? "", `views/${name}`));
      } catch {
        fail("WORKSPACE_VIEW_STALE", `${name} is missing or unsafe`);
      }
      if (actual.toString("utf8") !== expected[name]) {
        fail("WORKSPACE_VIEW_STALE", `${name} is stale`);
      }
    }
  }
  return state;
}

async function appendEvent(workspaceRootInput: string, lease: WorkspaceLease, payload: JsonValue, options: WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertStrictInstant(options.occurredAt);
  const workspace = await resolveWorkspace(workspaceRootInput);
  await assertLease(workspace.root, lease);
  const state = materialize(workspace.metadata, await readSegmentEvents(workspace.root, workspace.metadata));
  if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion !== state.version) {
    fail("WORKSPACE_CAS_MISMATCH", `expected=${String(options.expectedVersion)} actual=${state.version}`);
  }
  assertWorkspaceRecordCount(state.version + 1);
  const sequence = state.version + 1;
  const event = createEvent({
    id: deriveStableId("event", `EVENT-${sequence}`),
    streamId: deriveStableId("stream", workspace.metadata.externalKey),
    sequence,
    occurredAt: options.occurredAt,
    priorHash: state.headEventHash,
    payload,
  });
  const segmentIndex = Math.floor((sequence - 1) / workspace.metadata.segmentEventLimit) + 1;
  const segmentPath = controlPath(workspace.root, `events/${String(segmentIndex).padStart(6, "0")}.json`);
  const current = sequence % workspace.metadata.segmentEventLimit === 1 && sequence !== 1
    ? []
    : state.events.slice((segmentIndex - 1) * workspace.metadata.segmentEventLimit);
  await atomicWrite(segmentPath, canonicalJson([...current, event]), workspace.root, options.crashAt);
  crash("after-event-commit", options.crashAt);
  const committed = materialize(workspace.metadata, await readSegmentEvents(workspace.root, workspace.metadata));
  await writeViews(workspace.root, committed, options.crashAt);
  return committed;
}

function projectById(state: WorkspaceState, id: string): ProjectRecord {
  const record = state.projects.find((entry) => entry.id === id);
  if (!record || record.tombstone) {
    fail("WORKSPACE_INPUT_INVALID", `project ${id} is unavailable`);
  }
  return record;
}

function workById(state: WorkspaceState, id: string): WorkRecord {
  const record = state.work.find((entry) => entry.id === id);
  if (!record || record.tombstone) {
    fail("WORKSPACE_INPUT_INVALID", `work ${id} is unavailable`);
  }
  return record;
}

export async function createProject(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly externalKey: string;
  readonly name: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const state = await materializeWorkspace(workspaceRoot);
  const externalKey = canonicalExternalKey(input.externalKey);
  const id = deriveStableId("project", externalKey);
  if (state.projects.some((record) => record.id === id)) {
    fail("WORKSPACE_INPUT_INVALID", `project ${id} already exists`);
  }
  const record = validateProject({
    schemaVersion: "tcrn.project.v1",
    id,
    externalKey,
    name: input.name,
    revision: 1,
    updatedAt: input.occurredAt,
    tombstone: false,
  }, "WORKSPACE_INPUT_INVALID");
  return appendEvent(workspaceRoot, lease, { operation: "project.created", record }, input);
}

export async function updateProject(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly id: string;
  readonly name: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const state = await materializeWorkspace(workspaceRoot);
  const current = projectById(state, input.id);
  const record = validateProject(
    { ...current, name: input.name, revision: current.revision + 1, updatedAt: input.occurredAt },
    "WORKSPACE_INPUT_INVALID",
  );
  return appendEvent(workspaceRoot, lease, { operation: "project.updated", record }, input);
}

export async function deleteProject(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly id: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const state = await materializeWorkspace(workspaceRoot);
  const current = projectById(state, input.id);
  if (state.work.some((record) => record.projectId === current.id && !record.tombstone)) {
    fail("WORKSPACE_INPUT_INVALID", `project ${current.id} still owns live work`);
  }
  const record = { ...current, revision: current.revision + 1, updatedAt: input.occurredAt, tombstone: true };
  return appendEvent(workspaceRoot, lease, { operation: "project.deleted", record }, input);
}

export async function createWork(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly projectId: string;
  readonly externalKey: string;
  readonly kind: PlannedDeliveryKind;
  readonly parentId: string | null;
  readonly status?: WorkStatus;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const state = await materializeWorkspace(workspaceRoot);
  projectById(state, input.projectId);
  const externalKey = canonicalExternalKey(input.externalKey);
  const id = deriveStableId("work", externalKey);
  if (state.work.some((record) => record.id === id)) {
    fail("WORKSPACE_INPUT_INVALID", `work ${id} already exists`);
  }
  const record: WorkRecord = {
    schemaVersion: "tcrn.work.v1",
    id,
    externalKey,
    projectId: input.projectId,
    kind: input.kind,
    parentId: input.parentId,
    status: input.status ?? "planned",
    revision: 1,
    updatedAt: input.occurredAt,
    tombstone: false,
    extensions: {},
  };
  validateWorkGraph([...state.work, record]);
  return appendEvent(workspaceRoot, lease, { operation: "work.created", record }, input);
}

export async function transitionWork(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly id: string;
  readonly status: WorkStatus;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const state = await materializeWorkspace(workspaceRoot);
  const current = workById(state, input.id);
  assertWorkTransition(current.status, input.status);
  const record: WorkRecord = { ...current, status: input.status, revision: current.revision + 1, updatedAt: input.occurredAt };
  validateWorkGraph(state.work.map((entry) => entry.id === record.id ? record : entry));
  return appendEvent(workspaceRoot, lease, { operation: "work.updated", record }, input);
}

export async function deleteWork(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly id: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const state = await materializeWorkspace(workspaceRoot);
  const current = workById(state, input.id);
  const record: WorkRecord = { ...current, revision: current.revision + 1, updatedAt: input.occurredAt, tombstone: true };
  validateWorkGraph(state.work.map((entry) => entry.id === record.id ? record : entry));
  return appendEvent(workspaceRoot, lease, { operation: "work.deleted", record }, input);
}

export async function rebuildWorkspaceViews(workspaceRoot: string, lease: WorkspaceLease): Promise<WorkspaceState> {
  const resolved = await boundDirectory(workspaceRoot);
  await assertLease(resolved, lease);
  const state = await materializeWorkspace(resolved);
  await writeViews(resolved, state);
  return state;
}

export async function recoverWorkspace(workspaceRoot: string, lease: WorkspaceLease): Promise<WorkspaceState> {
  const resolved = await boundDirectory(workspaceRoot);
  await assertLease(resolved, lease);
  for (const directoryName of ["events", "views"]) {
    const directory = await boundDirectory(controlPath(resolved, directoryName), resolved);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".tmp-") && entry.isFile() && !entry.isSymbolicLink()) {
        const path = resolve(directory, entry.name);
        const metadata = await lstat(path);
        if (metadata.nlink !== 1) {
          fail("WORKSPACE_PATH_INVALID", `${path} is not a safe recovery temporary`);
        }
        await rm(path);
      }
    }
  }
  return rebuildWorkspaceViews(resolved, lease);
}

export async function exportWorkspace(workspaceRoot: string): Promise<string> {
  const state = await materializeWorkspace(workspaceRoot);
  return canonicalJson({
    schemaVersion: "tcrn.workspace-export.v1",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    projects: state.projects,
    work: state.work,
    events: state.events,
  });
}

export async function createWorkspaceArchive(workspaceRoot: string): Promise<Buffer> {
  const exported = await exportWorkspace(workspaceRoot);
  return Buffer.from(canonicalJson({
    schemaVersion: "tcrn.workspace-archive.v1",
    mediaType: "application/vnd.tcrn.workspace-archive+json",
    contentSha256: canonicalSha256(assertCanonicalJson(exported)),
    content: assertCanonicalJson(exported),
  }), "utf8");
}

export async function planWorkspaceMigration(workspaceRoot: string, targetVersion: number): Promise<WorkspaceMigrationPlan> {
  const metadata = await readMetadata(await boundDirectory(workspaceRoot));
  if (!Number.isSafeInteger(targetVersion) || targetVersion < WORKSPACE_STORAGE_VERSION) {
    fail("WORKSPACE_MIGRATION_DOWNGRADE", String(targetVersion));
  }
  if (targetVersion > WORKSPACE_STORAGE_VERSION) {
    fail("WORKSPACE_MIGRATION_FUTURE", String(targetVersion));
  }
  const state = await materializeWorkspace(workspaceRoot);
  return {
    schemaVersion: "tcrn.workspace-migration-plan.v1",
    dryRun: true,
    fromVersion: metadata.storageVersion,
    toVersion: targetVersion,
    steps: [],
    backupRequired: true,
    rollback: "restore-exact-pre-migration-backup-then-validate",
    postValidation: "validate-exact-target-schema-and-full-event-chain",
    applyAvailable: false,
    basisDigest: canonicalSha256({ metadata, headEventHash: state.headEventHash, version: state.version }),
  };
}

export async function applyWorkspaceMigration(): Promise<never> {
  fail("WORKSPACE_MIGRATION_APPLY_UNAVAILABLE", "V1 has no real-data migration apply path");
}
