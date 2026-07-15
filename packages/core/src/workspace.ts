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
  readonly afterMutationClaimForTest?: () => Promise<void>;
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
const rootFields = ["kind", "path", "canonicalPath", "portableIdentity"];
const projectOperations = new Set(["project.created", "project.updated", "project.deleted"]);
const workOperations = new Set(["work.created", "work.updated", "work.deleted"]);
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

function sameIdentity(left: { readonly dev: number | bigint; readonly ino: number | bigint }, right: { readonly dev: number | bigint; readonly ino: number | bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
  for (const root of value.roots) {
    exactFields(root, rootFields, "WORKSPACE_SCHEMA_INVALID", "workspace root entry");
    if (typeof root.kind !== "string" || typeof root.path !== "string" || typeof root.canonicalPath !== "string" ||
      typeof root.portableIdentity !== "string") {
      fail("WORKSPACE_SCHEMA_INVALID", "workspace root entry types are invalid");
    }
    try {
      canonicalJson(root);
    } catch (error) {
      if (error instanceof ProtocolError) {
        fail("WORKSPACE_SCHEMA_INVALID", error.message);
      }
      throw error;
    }
  }
  return value as unknown as WorkspaceMetadata;
}

function workspaceStreamId(metadata: WorkspaceMetadata): string {
  return `stream:${canonicalSha256({
    schemaVersion: "tcrn.workspace-stream-identity.v1",
    workspaceId: metadata.workspaceId,
    createdAt: metadata.createdAt,
  }).slice(0, 24)}`;
}

function workspaceEventId(streamId: string, sequence: number): string {
  return `event:${canonicalSha256({
    schemaVersion: "tcrn.workspace-event-identity.v1",
    streamId,
    sequence,
  }).slice(0, 24)}`;
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
  const expectedStreamId = workspaceStreamId(metadata);
  for (const event of events) {
    if (event.streamId !== expectedStreamId || event.id !== workspaceEventId(expectedStreamId, event.sequence)) {
      fail("WORKSPACE_EVENT_CORRUPT", `event ${event.id} is not bound to Workspace ${metadata.workspaceId}`);
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
  const validateRelationships = (): void => {
    let ordered: readonly WorkRecord[];
    try {
      ordered = validateWorkGraph([...work.values()]);
    } catch (error) {
      if (error instanceof ProtocolError) {
        fail("WORKSPACE_EVENT_CORRUPT", `${error.reasonCode}:${error.message}`);
      }
      throw error;
    }
    for (const record of ordered) {
      const project = projects.get(record.projectId);
      if (!project || (project.tombstone && !record.tombstone)) {
        fail("WORKSPACE_EVENT_CORRUPT", `work ${record.id} references an unavailable project`);
      }
    }
  };
  for (const event of events) {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload) || typeof payload.operation !== "string") {
      fail("WORKSPACE_EVENT_CORRUPT", `event ${event.id} payload is invalid`);
    }
    if (projectOperations.has(payload.operation)) {
      const record = validateProject(payloadRecord(payload, payload.operation));
      const current = projects.get(record.id);
      if (record.updatedAt !== event.occurredAt) {
        fail("WORKSPACE_EVENT_CORRUPT", `project ${record.id} timestamp is not event-bound`);
      }
      if (payload.operation === "project.created") {
        if (current || record.revision !== 1 || record.tombstone) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid project create ${record.id}`);
        }
      } else if (!current || current.tombstone || record.revision !== current.revision + 1 || record.externalKey !== current.externalKey ||
        (payload.operation === "project.updated" && record.tombstone) || (payload.operation === "project.deleted" && !record.tombstone)) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid project mutation ${record.id}`);
      }
      if (payload.operation === "project.deleted" && [...work.values()].some((entry) => entry.projectId === record.id && !entry.tombstone)) {
        fail("WORKSPACE_EVENT_CORRUPT", `project ${record.id} deletion precedes its live work`);
      }
      projects.set(record.id, record);
      validateRelationships();
      continue;
    }
    if (workOperations.has(payload.operation)) {
      const record = payloadRecord(payload, payload.operation) as unknown as WorkRecord;
      const current = work.get(record.id);
      if (record.updatedAt !== event.occurredAt) {
        fail("WORKSPACE_EVENT_CORRUPT", `work ${record.id} timestamp is not event-bound`);
      }
      if (payload.operation === "work.created") {
        if (current || record.revision !== 1 || record.tombstone) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid work create ${record.id}`);
        }
      } else if (!current || current.tombstone || record.revision !== current.revision + 1 || record.externalKey !== current.externalKey ||
        record.projectId !== current.projectId || record.kind !== current.kind || record.parentId !== current.parentId ||
        (payload.operation === "work.updated" && record.tombstone) || (payload.operation === "work.deleted" && !record.tombstone)) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid work mutation ${record.id}`);
      }
      if (payload.operation === "work.updated" && current) {
        try {
          assertWorkTransition(current.status, record.status);
        } catch (error) {
          if (error instanceof ProtocolError) {
            fail("WORKSPACE_EVENT_CORRUPT", `${error.reasonCode}:${error.message}`);
          }
          throw error;
        }
      }
      work.set(record.id, record);
      validateRelationships();
      continue;
    }
    fail("WORKSPACE_EVENT_CORRUPT", `unknown operation ${payload.operation}`);
  }
  const projectRecords = [...projects.values()].sort((left, right) => compareCanonicalText(left.id, right.id));
  const workRecords = validateWorkGraph([...work.values()]);
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
  if (owner.schemaVersion !== "tcrn.workspace-lease.v1" || owner.token !== lease.token ||
    typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || typeof owner.acquiredAt !== "string" ||
    typeof owner.expiresAtNanoseconds !== "string" || !/^[0-9]+$/u.test(owner.expiresAtNanoseconds)) {
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

interface RecoveryClaim {
  readonly path: string;
  readonly token: string;
  readonly identity: { readonly dev: number | bigint; readonly ino: number | bigint };
}

interface MutationClaim {
  readonly path: string;
  readonly token: string;
  readonly leaseToken: string;
  readonly identity: { readonly dev: number | bigint; readonly ino: number | bigint };
}

interface LeaseObservation {
  readonly directoryIdentity: { readonly dev: number | bigint; readonly ino: number | bigint };
  readonly directoryModifiedMilliseconds: number;
  readonly owner: Readonly<Record<string, JsonValue>> | null;
  readonly ownerIdentity: { readonly dev: number | bigint; readonly ino: number | bigint } | null;
}

async function parseRecoveryClaim(path: string): Promise<{ readonly owner: Readonly<Record<string, JsonValue>>; readonly identity: { readonly dev: number | bigint; readonly ino: number | bigint } }> {
  let before;
  try {
    before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      fail("WORKSPACE_LEASE_INVALID", "recovery claim must be a single-link regular file");
    }
    const content = await boundFile(path, 16_384);
    const after = await lstat(path);
    if (!sameIdentity(before, after) || after.nlink !== 1 || !after.isFile() || after.isSymbolicLink()) {
      fail("WORKSPACE_LEASE_INVALID", "recovery claim identity changed");
    }
    const owner = assertCanonicalJson(content.toString("utf8"));
    exactFields(owner, ["schemaVersion", "token", "pid", "acquiredAt", "expiresAtNanoseconds"], "WORKSPACE_LEASE_INVALID", "recovery claim");
    if (owner.schemaVersion !== "tcrn.workspace-lease-recovery.v1" || typeof owner.token !== "string" ||
      !/^[a-f0-9]{48}$/u.test(owner.token) || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) ||
      typeof owner.acquiredAt !== "string" || typeof owner.expiresAtNanoseconds !== "string" ||
      !/^[0-9]+$/u.test(owner.expiresAtNanoseconds)) {
      fail("WORKSPACE_LEASE_INVALID", "recovery claim fields are invalid");
    }
    assertStrictInstant(owner.acquiredAt);
    return { owner, identity: { dev: after.dev, ino: after.ino } };
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    if (error instanceof ProtocolError) {
      fail("WORKSPACE_LEASE_INVALID", error.message);
    }
    fail("WORKSPACE_LEASE_INVALID", String(error));
  }
}

async function createRecoveryClaim(workspaceRoot: string, now: string, nowNanoseconds: bigint, ttl: number): Promise<RecoveryClaim> {
  const path = controlPath(workspaceRoot, "lease-recovery.claim");
  const token = randomBytes(24).toString("hex");
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(canonicalJson({
      schemaVersion: "tcrn.workspace-lease-recovery.v1",
      token,
      pid: process.pid,
      acquiredAt: now,
      expiresAtNanoseconds: (nowNanoseconds + BigInt(ttl) * 1_000_000n).toString(),
    }));
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.nlink !== 1) {
      fail("WORKSPACE_LEASE_INVALID", "recovery claim descriptor is unsafe");
    }
    await handle.close();
    handle = undefined;
    const named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameIdentity(written, named)) {
      fail("WORKSPACE_LEASE_INVALID", "recovery claim path does not bind the created file");
    }
    return { path, token, identity: { dev: named.dev, ino: named.ino } };
  } catch (error) {
    await handle?.close();
    if ((error as { code?: string }).code === "EEXIST") {
      await parseRecoveryClaim(path);
      fail("WORKSPACE_LOCKED", "another lease recovery owns the Workspace");
    }
    if (error instanceof WorkspaceError) {
      throw error;
    }
    fail("WORKSPACE_LEASE_INVALID", String(error));
  }
}

async function releaseRecoveryClaim(workspaceRoot: string, claim: RecoveryClaim): Promise<void> {
  const current = await lstat(claim.path).catch(() => fail("WORKSPACE_LEASE_INVALID", "recovery claim disappeared"));
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameIdentity(current, claim.identity)) {
    fail("WORKSPACE_LEASE_INVALID", "recovery claim ownership changed");
  }
  const quarantine = controlPath(workspaceRoot, `released-recovery-${claim.token}`);
  try {
    await rename(claim.path, quarantine);
  } catch {
    fail("WORKSPACE_LEASE_INVALID", "recovery claim release was not exclusive");
  }
  const moved = await lstat(quarantine);
  if (!sameIdentity(moved, claim.identity) || !moved.isFile() || moved.nlink !== 1) {
    fail("WORKSPACE_LEASE_INVALID", "released recovery claim identity changed");
  }
  await rm(quarantine);
}

async function parseMutationClaim(path: string): Promise<{
  readonly owner: Readonly<Record<string, JsonValue>>;
  readonly identity: { readonly dev: number | bigint; readonly ino: number | bigint };
}> {
  let before;
  try {
    before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      fail("WORKSPACE_LEASE_INVALID", "mutation claim must be a single-link regular file");
    }
    const content = await boundFile(path, 16_384);
    const after = await lstat(path);
    if (!sameIdentity(before, after) || after.nlink !== 1 || !after.isFile() || after.isSymbolicLink()) {
      fail("WORKSPACE_LEASE_INVALID", "mutation claim identity changed");
    }
    const owner = assertCanonicalJson(content.toString("utf8"));
    exactFields(owner, ["schemaVersion", "leaseToken", "token", "pid"], "WORKSPACE_LEASE_INVALID", "mutation claim");
    if (owner.schemaVersion !== "tcrn.workspace-mutation-claim.v1" || typeof owner.leaseToken !== "string" ||
      !/^[a-f0-9]{48}$/u.test(owner.leaseToken) || typeof owner.token !== "string" ||
      !/^[a-f0-9]{48}$/u.test(owner.token) || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid)) {
      fail("WORKSPACE_LEASE_INVALID", "mutation claim fields are invalid");
    }
    return { owner, identity: { dev: after.dev, ino: after.ino } };
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    if (error instanceof ProtocolError) {
      fail("WORKSPACE_LEASE_INVALID", error.message);
    }
    fail("WORKSPACE_LEASE_INVALID", String(error));
  }
}

async function createMutationClaim(workspaceRoot: string, lease: WorkspaceLease): Promise<MutationClaim> {
  const leasePath = controlPath(workspaceRoot, "lease");
  const path = resolve(leasePath, "mutation.claim");
  const token = randomBytes(24).toString("hex");
  const directoryBefore = await lstat(leasePath);
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
    fail("WORKSPACE_LEASE_INVALID", "lease directory is unsafe for mutation admission");
  }
  await boundDirectory(leasePath, workspaceRoot);
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(canonicalJson({
      schemaVersion: "tcrn.workspace-mutation-claim.v1",
      leaseToken: lease.token,
      token,
      pid: process.pid,
    }));
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.nlink !== 1) {
      fail("WORKSPACE_LEASE_INVALID", "mutation claim descriptor is unsafe");
    }
    await handle.close();
    handle = undefined;
    const directoryAfter = await lstat(leasePath);
    const named = await lstat(path);
    if (!sameIdentity(directoryBefore, directoryAfter) || !directoryAfter.isDirectory() ||
      !named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameIdentity(written, named)) {
      fail("WORKSPACE_LEASE_INVALID", "mutation claim path does not bind the lease generation");
    }
    return { path, token, leaseToken: lease.token, identity: { dev: named.dev, ino: named.ino } };
  } catch (error) {
    await handle?.close();
    if ((error as { code?: string }).code === "EEXIST") {
      const existing = await parseMutationClaim(path);
      if (existing.owner.leaseToken !== lease.token) {
        fail("WORKSPACE_LEASE_INVALID", "mutation claim belongs to another lease generation");
      }
      fail("WORKSPACE_CAS_MISMATCH", "another mutation owns this lease commit boundary");
    }
    if (error instanceof WorkspaceError) {
      throw error;
    }
    fail("WORKSPACE_LEASE_INVALID", String(error));
  }
}

async function releaseMutationClaim(workspaceRoot: string, lease: WorkspaceLease, claim: MutationClaim): Promise<void> {
  await assertLease(workspaceRoot, lease);
  const current = await parseMutationClaim(claim.path);
  if (!sameIdentity(current.identity, claim.identity) || current.owner.token !== claim.token ||
    current.owner.leaseToken !== claim.leaseToken) {
    fail("WORKSPACE_LEASE_INVALID", "mutation claim ownership changed");
  }
  const quarantine = resolve(dirname(claim.path), `released-mutation-${claim.token}`);
  try {
    await rename(claim.path, quarantine);
  } catch {
    fail("WORKSPACE_LEASE_INVALID", "mutation claim release was not exclusive");
  }
  const moved = await lstat(quarantine);
  if (!sameIdentity(moved, claim.identity) || !moved.isFile() || moved.isSymbolicLink() || moved.nlink !== 1) {
    fail("WORKSPACE_LEASE_INVALID", "released mutation claim identity changed");
  }
  await rm(quarantine);
}

async function observeLease(leasePath: string, workspaceRoot: string): Promise<LeaseObservation> {
  let directory;
  try {
    directory = await lstat(leasePath);
  } catch (error) {
    fail("WORKSPACE_LEASE_INVALID", `${leasePath}: ${String((error as { code?: string }).code ?? error)}`);
  }
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    fail("WORKSPACE_LEASE_INVALID", "lease path must be a real directory");
  }
  await boundDirectory(leasePath, workspaceRoot);
  const ownerPath = resolve(leasePath, "owner.json");
  let ownerBefore;
  try {
    ownerBefore = await lstat(ownerPath);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return {
        directoryIdentity: { dev: directory.dev, ino: directory.ino },
        directoryModifiedMilliseconds: directory.mtimeMs,
        owner: null,
        ownerIdentity: null,
      };
    }
    fail("WORKSPACE_LEASE_INVALID", String(error));
  }
  if (ownerBefore.isSymbolicLink() || !ownerBefore.isFile() || ownerBefore.nlink !== 1) {
    fail("WORKSPACE_LEASE_INVALID", "lease owner must be a single-link regular file");
  }
  let owner: JsonValue;
  try {
    owner = assertCanonicalJson((await boundFile(ownerPath, 16_384)).toString("utf8"));
  } catch (error) {
    fail("WORKSPACE_LEASE_INVALID", String(error));
  }
  const ownerAfter = await lstat(ownerPath);
  if (!sameIdentity(ownerBefore, ownerAfter) || ownerAfter.nlink !== 1 || !ownerAfter.isFile()) {
    fail("WORKSPACE_LEASE_INVALID", "lease owner identity changed");
  }
  exactFields(owner, ["schemaVersion", "token", "pid", "acquiredAt", "expiresAtNanoseconds"], "WORKSPACE_LEASE_INVALID", "lease owner");
  if (owner.schemaVersion !== "tcrn.workspace-lease.v1" || typeof owner.token !== "string" || !/^[a-f0-9]{48}$/u.test(owner.token) ||
    typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || typeof owner.acquiredAt !== "string" ||
    typeof owner.expiresAtNanoseconds !== "string" || !/^[0-9]+$/u.test(owner.expiresAtNanoseconds)) {
    fail("WORKSPACE_LEASE_INVALID", "lease owner fields are invalid");
  }
  try {
    assertStrictInstant(owner.acquiredAt);
  } catch (error) {
    fail("WORKSPACE_LEASE_INVALID", String(error));
  }
  return {
    directoryIdentity: { dev: directory.dev, ino: directory.ino },
    directoryModifiedMilliseconds: directory.mtimeMs,
    owner,
    ownerIdentity: { dev: ownerAfter.dev, ino: ownerAfter.ino },
  };
}

async function reclaimObservedLease(leasePath: string, workspaceRoot: string, observed: LeaseObservation, afterQuarantineForTest?: (value: { readonly leasePath: string; readonly quarantinePath: string; readonly identity: FileIdentity; }) => Promise<void>): Promise<void> {
  const directory = await lstat(leasePath).catch(() => fail("WORKSPACE_LOCKED", "lease changed before reclaim"));
  if (!directory.isDirectory() || directory.isSymbolicLink() || !sameIdentity(directory, observed.directoryIdentity)) {
    fail("WORKSPACE_LOCKED", "lease changed before reclaim");
  }
  const ownerPath = resolve(leasePath, "owner.json");
  if (observed.ownerIdentity) {
    const owner = await lstat(ownerPath).catch(() => fail("WORKSPACE_LOCKED", "lease owner changed before reclaim"));
    if (!owner.isFile() || owner.isSymbolicLink() || owner.nlink !== 1 || !sameIdentity(owner, observed.ownerIdentity)) {
      fail("WORKSPACE_LOCKED", "lease owner changed before reclaim");
    }
  } else {
    try {
      await lstat(ownerPath);
      fail("WORKSPACE_LOCKED", "incomplete lease gained an owner before reclaim");
    } catch (error) {
      if (error instanceof WorkspaceError || (error as { code?: string }).code !== "ENOENT") {
        throw error;
      }
    }
  }
  const suffix = observed.owner ? String(observed.owner.token) : `incomplete-${String(directory.dev)}-${String(directory.ino)}`;
  const quarantine = controlPath(workspaceRoot, `stale-lease-${suffix}`);
  try {
    await rename(leasePath, quarantine);
  } catch {
    fail("WORKSPACE_LOCKED", "lease was concurrently replaced");
  }
  const moved = await lstat(quarantine);
  if (!moved.isDirectory() || !sameIdentity(moved, observed.directoryIdentity)) {
    fail("WORKSPACE_LEASE_INVALID", "quarantined lease identity changed");
  }
  await afterQuarantineForTest?.({ leasePath, quarantinePath: quarantine, identity: observed.directoryIdentity });
  await rm(quarantine, { recursive: true, force: true });
}

async function createLeaseOwner(
  leasePath: string,
  workspaceRoot: string,
  expectedDirectoryIdentity: FileIdentity,
  now: string,
  nowNanoseconds: bigint,
  ttl: number,
): Promise<string> {
  const directoryBefore = await lstat(leasePath).catch(() => fail("WORKSPACE_LEASE_INVALID", "lease directory disappeared before owner creation"));
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink() || !sameIdentity(directoryBefore, expectedDirectoryIdentity)) {
    fail("WORKSPACE_LEASE_INVALID", "lease owner parent is unsafe");
  }
  const token = randomBytes(24).toString("hex");
  const ownerPath = resolve(leasePath, "owner.json");
  let handle;
  try {
    handle = await open(ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(canonicalJson({
      schemaVersion: "tcrn.workspace-lease.v1",
      token,
      pid: process.pid,
      acquiredAt: now,
      expiresAtNanoseconds: (nowNanoseconds + BigInt(ttl) * 1_000_000n).toString(),
    }));
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.nlink !== 1) {
      fail("WORKSPACE_LEASE_INVALID", "lease owner descriptor is unsafe");
    }
    await handle.close();
    handle = undefined;
    const directoryAfter = await lstat(leasePath);
    const named = await lstat(ownerPath);
    if (!sameIdentity(directoryBefore, directoryAfter) || !directoryAfter.isDirectory() ||
      !named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameIdentity(written, named)) {
      fail("WORKSPACE_LEASE_INVALID", "lease owner creation changed filesystem identity");
    }
    const directoryHandle = await open(leasePath, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return token;
  } catch (error) {
    await handle?.close();
    if ((error as { code?: string }).code === "EEXIST") {
      fail("WORKSPACE_LOCKED", "another writer created the lease owner first");
    }
    if (error instanceof WorkspaceError) {
      throw error;
    }
    fail("WORKSPACE_LEASE_INVALID", String(error));
  }
}

export async function acquireWorkspaceLease(workspaceRootInput: string, options: {
  readonly now: string;
  readonly ttlMilliseconds?: number;
  readonly beforeClaimForTest?: () => Promise<void>;
  readonly afterLeaseQuarantineForTest?: (value: { readonly leasePath: string; readonly quarantinePath: string; readonly identity: FileIdentity; }) => Promise<void>;
  // Observation-only portability seam: the returned value is never used to
  // authorize the real fresh lease directory.
  readonly freshLeaseIdentityObservationForTest?: (identity: FileIdentity) => FileIdentity;
  readonly afterFreshLeaseForTest?: (value: { readonly observedIdentity: FileIdentity; readonly freshIdentity: FileIdentity }) => Promise<void>;
  readonly beforeLeaseOwnerForTest?: () => Promise<void>;
  readonly crashAfterLeaseDirectoryForTest?: boolean;
}): Promise<WorkspaceLease> {
  assertStrictInstant(options.now);
  const nowNanoseconds = parseStrictInstant(options.now);
  const workspaceRoot = await boundDirectory(workspaceRootInput);
  await readMetadata(workspaceRoot);
  const ttl = options.ttlMilliseconds ?? 30_000;
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 300_000) {
    fail("WORKSPACE_LEASE_INVALID", "lease TTL must be 1-300 seconds");
  }
  const leasePath = controlPath(workspaceRoot, "lease");
  let claim: RecoveryClaim | undefined;
  try {
    let created = false;
    let leaseDirectoryIdentity: FileIdentity | undefined;
    try {
      await mkdir(leasePath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") {
        throw error;
      }
    }
    if (created) {
      const createdDirectory = await lstat(leasePath);
      if (!createdDirectory.isDirectory() || createdDirectory.isSymbolicLink()) {
        fail("WORKSPACE_LEASE_INVALID", "new lease directory is unsafe");
      }
      leaseDirectoryIdentity = { dev: createdDirectory.dev, ino: createdDirectory.ino };
      const claimPath = controlPath(workspaceRoot, "lease-recovery.claim");
      try {
        await lstat(claimPath);
        await parseRecoveryClaim(claimPath);
        fail("WORKSPACE_LOCKED", "lease creation overlaps an active recovery");
      } catch (error) {
        if (error instanceof WorkspaceError || (error as { code?: string }).code !== "ENOENT") {
          throw error;
        }
      }
    } else {
      const initial = await observeLease(leasePath, workspaceRoot);
      if (initial.owner) {
        const expiresAtNanoseconds = BigInt(String(initial.owner.expiresAtNanoseconds));
        const pid = Number(initial.owner.pid);
        if (expiresAtNanoseconds > nowNanoseconds || processAlive(pid)) {
          fail("WORKSPACE_LOCKED", "workspace already has an active writer");
        }
      } else {
        const nowMilliseconds = Number(nowNanoseconds / 1_000_000n);
        const age = nowMilliseconds - initial.directoryModifiedMilliseconds;
        if (age < ttl || age < 0) {
          fail("WORKSPACE_LOCKED", "incomplete lease is still within its creation grace period");
        }
      }
      await options.beforeClaimForTest?.();
      claim = await createRecoveryClaim(workspaceRoot, options.now, nowNanoseconds, ttl);
      const observed = await observeLease(leasePath, workspaceRoot);
      if (observed.owner) {
        const expiresAtNanoseconds = BigInt(String(observed.owner.expiresAtNanoseconds));
        const pid = Number(observed.owner.pid);
        if (expiresAtNanoseconds > nowNanoseconds || processAlive(pid)) {
          fail("WORKSPACE_LOCKED", "workspace gained an active writer before reclaim");
        }
      } else {
        const nowMilliseconds = Number(nowNanoseconds / 1_000_000n);
        const age = nowMilliseconds - observed.directoryModifiedMilliseconds;
        if (age < ttl || age < 0) {
          fail("WORKSPACE_LOCKED", "incomplete lease changed within its creation grace period");
        }
      }
      await reclaimObservedLease(leasePath, workspaceRoot, observed, options.afterLeaseQuarantineForTest);
      await mkdir(leasePath, { mode: 0o700 });
      const freshDirectory = await lstat(leasePath);
      if (!freshDirectory.isDirectory() || freshDirectory.isSymbolicLink()) {
        fail("WORKSPACE_LEASE_INVALID", "recovered lease directory is unsafe");
      }
      leaseDirectoryIdentity = { dev: freshDirectory.dev, ino: freshDirectory.ino };
      await options.afterFreshLeaseForTest?.({
        observedIdentity: observed.directoryIdentity,
        freshIdentity: options.freshLeaseIdentityObservationForTest?.(leaseDirectoryIdentity) ?? leaseDirectoryIdentity,
      });
    }
    await boundDirectory(leasePath, workspaceRoot);
    if (!leaseDirectoryIdentity) fail("WORKSPACE_LEASE_INVALID", "lease generation identity is unavailable");
    if (options.crashAfterLeaseDirectoryForTest) {
      fail("WORKSPACE_FAULT_INJECTED", "injected crash after lease directory creation");
    }
    await options.beforeLeaseOwnerForTest?.();
    const token = await createLeaseOwner(leasePath, workspaceRoot, leaseDirectoryIdentity, options.now, nowNanoseconds, ttl);
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
  } finally {
    if (claim) {
      await releaseRecoveryClaim(workspaceRoot, claim);
    }
  }
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
  let canonicalRoots: readonly CanonicalRoot[];
  try {
    canonicalRoots = await assertDistinctRoots(metadata.roots.map((entry) => ({ kind: entry.kind, path: entry.path })));
  } catch (error) {
    fail("WORKSPACE_SCHEMA_INVALID", String((error as { message?: string }).message ?? error));
  }
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
  const claim = await createMutationClaim(workspace.root, lease);
  try {
    await options.afterMutationClaimForTest?.();
    await assertLease(workspace.root, lease);
    const state = materialize(workspace.metadata, await readSegmentEvents(workspace.root, workspace.metadata));
    if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion !== state.version) {
      fail("WORKSPACE_CAS_MISMATCH", `expected=${String(options.expectedVersion)} actual=${state.version}`);
    }
    assertWorkspaceRecordCount(state.version + 1);
    const sequence = state.version + 1;
    const streamId = workspaceStreamId(workspace.metadata);
    const event = createEvent({
      id: workspaceEventId(streamId, sequence),
      streamId,
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
  } finally {
    await releaseMutationClaim(workspace.root, lease, claim);
  }
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
