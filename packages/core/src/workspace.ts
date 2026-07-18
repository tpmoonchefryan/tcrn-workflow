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
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  PROTOCOL_LIMITS,
  ProtocolError,
  assertCanonicalJson,
  assertProtocolId,
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
import { consumeQuarantineReplacementTestInstrumentation } from "./workspace-test-instrumentation.js";
import { recordClosureValidation, recordExtensionClosureValidation, recordFullMaterialize, recordTerminalGraphValidation } from "./workspace-perf-instrumentation.js";
import {
  ACTOR_ATTESTATION_ENABLE_OPERATION,
  ActorAttestationError,
  EVENT_PAYLOAD_OPERATION_EXTRAS,
  assertActorId,
  buildActorAttestationEnableRecord,
  buildEventPayload,
  validateActorAttestationEnableRecord,
} from "./actor-attestation.js";
import {
  CONFERENCE_MINUTES_VERSION,
  CONFERENCE_POSITION_VERSION,
  CONFERENCE_REQUEST_VERSION,
  ConferenceError,
  appendConferencePosition,
  openConference,
  validateConferenceMinutes,
  validateConferencePosition,
  validateConferenceRequest,
} from "./conference.js";
import { AssignmentGateError, GATE_VERSION, validateGateRecord } from "./assignment-gate.js";
import type { ConferenceMinutes, ConferencePosition, ConferenceRequest } from "./conference.js";
import type { GateRecord } from "./assignment-gate.js";
import type { CanonicalRoot } from "./root-identity.js";
import type { ExplicitRoot } from "./index.js";

export const WORKSPACE_SCHEMA_VERSION = "tcrn.workspace.v1" as const;
export const WORKSPACE_STORAGE_VERSION = 1 as const;
export const WORKSPACE_CONTROL_DIRECTORY = ".tcrn-workflow" as const;
export const WORKSPACE_REASON_CODES = Object.freeze([
  "WORKSPACE_ACTOR_INVALID",
  "WORKSPACE_ACTOR_REQUIRED",
  "WORKSPACE_ALREADY_EXISTS",
  "WORKSPACE_CAS_MISMATCH",
  "WORKSPACE_CONFERENCE_NOT_OPEN",
  "WORKSPACE_EVENT_CORRUPT",
  "WORKSPACE_FAULT_INJECTED",
  "WORKSPACE_FILESYSTEM_UNSUPPORTED",
  "WORKSPACE_GATE_EVIDENCE_UNRESOLVED",
  "WORKSPACE_GATE_PENDING",
  "WORKSPACE_INPUT_INVALID",
  "WORKSPACE_INPUT_OVERSIZED",
  "WORKSPACE_LEASE_BROKEN",
  "WORKSPACE_LEASE_INVALID",
  "WORKSPACE_LEASE_OBSERVED",
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
  // WSD-1: additive extension-record collections materialized from the same
  // event chain, each sorted by projectId then id in utf8-byte-order-v1. Empty
  // for every workspace that contains no conference/gate events.
  readonly conferences: readonly ConferenceRequest[];
  readonly conferencePositions: readonly ConferencePosition[];
  readonly conferenceMinutes: readonly ConferenceMinutes[];
  readonly gates: readonly GateRecord[];
  readonly events: readonly EventRecord[];
  // WSE-2: the sequence of the attestation.actor.enabled event once one has been
  // replayed, else null. From this sequence onward (the enabling event itself
  // included), every mutation payload MUST carry a valid actor; before it, and
  // for every workspace that never enables attestation, actor stays absent and
  // the derived state and export bytes are byte-identical to rc.4.
  readonly attestationEnabledAtSequence: number | null;
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
  // WSE-2: the accountable actor for this mutation. Caller-supplied like
  // occurredAt (no clock, no randomness — determinism preserved). Once
  // attestation is enabled it is mandatory (WORKSPACE_ACTOR_REQUIRED) and
  // validated (WORKSPACE_ACTOR_INVALID); the enabling event carries it too.
  readonly actorId?: string;
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
// WSD-1: conference/gate records persist as additive event-log operations. A
// workspace that contains one of these events is unreadable by pre-WSD-1
// binaries (they fail closed at the unknown-operation check below); workspaces
// that never use them stay fully readable, and storageVersion stays 1.
const conferenceOperations = new Set(["conference.created", "conference.updated", "conference.position.appended", "conference.closed"]);
const gateOperations = new Set(["gate.created", "gate.updated", "gate.deleted"]);
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

async function boundFile(path: string, maximumBytes: number = PROTOCOL_LIMITS.maxCanonicalBytes): Promise<Buffer> {
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

function payloadRecord(payload: JsonValue, operation: string, actorRequired: boolean): Readonly<Record<string, JsonValue>> {
  // WSD-1 (SDC-2): the payload field set is {operation, record} plus exactly the
  // extras the shared table registers for this operation (conference.closed
  // carries 'minutes'), so the read side mirrors the single payload constructor.
  // WSE-2: from the attestation.actor.enabled event onward (that event included),
  // actor joins the exact field set and is validated here, so the replay reducer
  // enforces the same mandatory attestation as the live append path — a
  // hand-tampered log that drops or forges actor after enable fails closed.
  const extras = EVENT_PAYLOAD_OPERATION_EXTRAS[operation] ?? [];
  if (actorRequired) {
    const carriesActor = payload !== null && typeof payload === "object" && !Array.isArray(payload) && "actor" in payload;
    if (!carriesActor) {
      fail("WORKSPACE_ACTOR_REQUIRED", `${operation} requires an actor after attestation is enabled`);
    }
    exactFields(payload, ["operation", "record", "actor", ...extras], "WORKSPACE_EVENT_CORRUPT", "event payload");
    try {
      assertActorId((payload as Readonly<Record<string, JsonValue>>).actor);
    } catch (error) {
      if (error instanceof ActorAttestationError) {
        fail("WORKSPACE_ACTOR_INVALID", `${operation} actor is invalid`);
      }
      throw error;
    }
  } else {
    exactFields(payload, ["operation", "record", ...extras], "WORKSPACE_EVENT_CORRUPT", "event payload");
  }
  if (payload.operation !== operation) {
    fail("WORKSPACE_EVENT_CORRUPT", `expected ${operation}`);
  }
  if (payload.record === null || typeof payload.record !== "object" || Array.isArray(payload.record)) {
    fail("WORKSPACE_EVENT_CORRUPT", `${operation} record is invalid`);
  }
  return payload.record;
}

// WSD-1: the single-event atomic close payload — exactly {minutes, operation,
// record} where record is the conference at status closed and minutes is the
// revision-1 minutes record bound to it.
function closePayload(payload: JsonValue, actorRequired: boolean): { readonly record: Readonly<Record<string, JsonValue>>; readonly minutes: JsonValue } {
  const record = payloadRecord(payload, "conference.closed", actorRequired);
  const minutes = (payload as Readonly<Record<string, JsonValue>>).minutes;
  if (minutes === null || minutes === undefined || typeof minutes !== "object" || Array.isArray(minutes)) {
    fail("WORKSPACE_EVENT_CORRUPT", "conference.closed minutes is invalid");
  }
  return { record, minutes };
}

// WSD-1: map extension-validator failures (ConferenceError/AssignmentGateError)
// to the fail-closed replay reason so the unchanged record validators are reused
// verbatim by the reducer.
function extensionRecordOrCorrupt<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof ConferenceError || error instanceof AssignmentGateError) {
      fail("WORKSPACE_EVENT_CORRUPT", `${error.reasonCode}:${error.message}`);
    }
    throw error;
  }
}

// WSD-1: a mutated extension record must equal its current revision on every
// field except the explicitly mutable ones — immutable identity and binding
// fields (projectId, conferenceId, workId, ...) are pinned byte-exactly.
function assertPinnedExtensionFields(current: JsonValue, next: JsonValue, mutableFields: readonly string[], label: string): void {
  const currentRest: Record<string, unknown> = { ...(current as Readonly<Record<string, unknown>>) };
  const nextRest: Record<string, unknown> = { ...(next as Readonly<Record<string, unknown>>) };
  for (const field of mutableFields) {
    delete currentRest[field];
    delete nextRest[field];
  }
  if (canonicalJson(currentRest) !== canonicalJson(nextRest)) {
    fail("WORKSPACE_EVENT_CORRUPT", `${label} mutates a pinned field`);
  }
}

function sortExtensionRecords<T extends { readonly projectId: string; readonly id: string }>(records: Iterable<T>): readonly T[] {
  return [...records].sort((left, right) => compareCanonicalText(left.projectId, right.projectId) || compareCanonicalText(left.id, right.id));
}

// WSA-2: the ancestor closure of a work record — the record plus every ancestor
// reachable by walking parentId, bounded by the frozen four-level hierarchy. A
// missing link stops the walk (validateWorkGraph then fails REFERENTIAL_INTEGRITY
// on the record whose parent is absent); a cycle stops after both endpoints are
// collected (validateWorkGraph then fails GRAPH_CYCLE).
function collectWorkClosure(work: Map<string, WorkRecord>, record: WorkRecord): readonly WorkRecord[] {
  const closure = new Map<string, WorkRecord>([[record.id, record]]);
  let cursor: WorkRecord | undefined = record;
  while (cursor && cursor.parentId !== null) {
    const parent = work.get(cursor.parentId);
    if (!parent || closure.has(parent.id)) {
      break;
    }
    closure.set(parent.id, parent);
    cursor = parent;
  }
  return [...closure.values()];
}

// WSA-2: O(delta) per-event relationship validation. Validates only the mutated
// record's closure (record + ancestor chain) instead of the whole work graph,
// which removes the per-event full validateWorkGraph that made materialize
// quadratic. The terminal validateWorkGraph over the full set still runs once.
// This catches prefix-invalid intermediate states (a child before its parent, a
// live child of a just-tombstoned parent) that a terminal-only check would miss.
function validateWorkClosure(work: Map<string, WorkRecord>, projects: Map<string, ProjectRecord>, record: WorkRecord): void {
  const project = projects.get(record.projectId);
  if (!project || (project.tombstone && !record.tombstone)) {
    fail("WORKSPACE_EVENT_CORRUPT", `work ${record.id} references an unavailable project`);
  }
  const closure = collectWorkClosure(work, record);
  recordClosureValidation(closure.length);
  try {
    validateWorkGraph(closure);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("WORKSPACE_EVENT_CORRUPT", `${error.reasonCode}:${error.message}`);
    }
    throw error;
  }
  if (record.tombstone) {
    for (const candidate of work.values()) {
      if (!candidate.tombstone && candidate.parentId === record.id) {
        fail("WORKSPACE_EVENT_CORRUPT", `TOMBSTONE_REFERENCED:${candidate.id}`);
      }
    }
  }
}

// WSD-1: O(delta) referential checks for a conference/gate reducer arm — bounded
// map lookups of the records the mutated record references (its project, its
// linked work, its conference), never a scan of a whole collection per event
// (SDC-3). The visit count feeds the extension closure counter.
function requireLiveProject(projects: Map<string, ProjectRecord>, projectId: string, label: string): void {
  const project = projects.get(projectId);
  if (!project || project.tombstone) {
    fail("WORKSPACE_EVENT_CORRUPT", `${label} references an unavailable project`);
  }
}

function requireLiveWork(work: Map<string, WorkRecord>, projectId: string, workId: string, label: string): void {
  const record = work.get(workId);
  if (!record || record.tombstone || record.projectId !== projectId) {
    fail("WORKSPACE_EVENT_CORRUPT", `${label} references unavailable work ${workId}`);
  }
}

function requireEventBoundTimestamp(updatedAt: string, event: EventRecord, label: string): void {
  if (updatedAt !== event.occurredAt) {
    fail("WORKSPACE_EVENT_CORRUPT", `${label} timestamp is not event-bound`);
  }
}

function requireOpenConference(conferences: Map<string, ConferenceRequest>, conferenceId: string, label: string): ConferenceRequest {
  const conference = conferences.get(conferenceId);
  if (!conference) {
    fail("WORKSPACE_EVENT_CORRUPT", `${label} references an unknown conference`);
  }
  if (conference.status !== "open") {
    fail("WORKSPACE_EVENT_CORRUPT", `${label} references a conference that is not open`);
  }
  return conference;
}

// WSD-4: the gate lifecycle graph. Off-by-default enforcement: a gate carries no
// meaning until created. pending<->blocked flip freely; pending/blocked reach
// satisfied only with resolving conference-minutes evidence; satisfied is
// terminal (the only exit is a gate.deleted tombstone, which is a separate
// operation, not a status move). The same map gates the verb and the reducer.
const GATE_TRANSITIONS: Record<GateRecord["status"], readonly GateRecord["status"][]> = Object.freeze({
  pending: ["blocked", "satisfied"],
  blocked: ["pending", "satisfied"],
  satisfied: [],
});
// WSD-4: strong satisfaction binding. A gate becomes satisfied only when its
// evidence locator resolves to stored, non-tombstoned conference minutes whose
// conference anchors the gate's work item; the resolving locator is persisted in
// the gate's own extensions map (a required:false entry that needs no registry
// row), so the reducer re-resolves the identical evidence a hand-tampered log
// cannot forge.
const GATE_EVIDENCE_KEY = "gate-evidence:conference-minutes";
const CONFERENCE_MINUTES_LOCATOR_NAMESPACE = "conference-minutes";

function resolveGateEvidence(locator: string, gate: GateRecord, minutes: readonly ConferenceMinutes[], conferences: readonly ConferenceRequest[]): boolean {
  const separator = locator.indexOf(":");
  if (separator < 0 || locator.slice(0, separator) !== CONFERENCE_MINUTES_LOCATOR_NAMESPACE) {
    return false;
  }
  try {
    assertProtocolId(locator);
  } catch {
    return false;
  }
  const minutesId = `minutes:${locator.slice(separator + 1)}`;
  const record = minutes.find((entry) => !entry.tombstone && entry.id === minutesId);
  if (!record) {
    return false;
  }
  if (gate.workId === null) {
    return true;
  }
  const conference = conferences.find((entry) => entry.id === record.conferenceId);
  return conference !== undefined && conference.linkedWorkIds.includes(gate.workId);
}

function gateEvidenceExtensions(base: Readonly<Record<string, unknown>>, locator: string): Readonly<Record<string, unknown>> {
  return { ...base, [GATE_EVIDENCE_KEY]: { required: false, value: locator } };
}

function readGateEvidenceLocator(extensions: Readonly<Record<string, unknown>>): string | undefined {
  const entry = extensions[GATE_EVIDENCE_KEY];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const value = (entry as Readonly<Record<string, unknown>>).value;
  return typeof value === "string" ? value : undefined;
}

// WSD-4: the designated set is exactly "a transition whose target is done".
// cancelled/blocked/ready targets are exempt so cleanup can never wedge. A
// non-tombstoned pending gate anchored to the work item blocks the move. The
// identical predicate runs on the verb (WORKSPACE_GATE_PENDING) and in replay
// (WORKSPACE_EVENT_CORRUPT), so a hand-tampered log cannot bypass the live check.
function assertGateClearance(gates: Iterable<GateRecord>, workId: string, targetStatus: string, reasonCode: WorkspaceReasonCode): void {
  if (targetStatus !== "done") {
    return;
  }
  const blocking = [...gates]
    .filter((gate) => !gate.tombstone && gate.status === "pending" && gate.workId === workId)
    .map((gate) => gate.id)
    .sort(compareCanonicalText);
  if (blocking.length > 0) {
    fail(reasonCode, `work ${workId} is blocked by pending gate(s) ${blocking.join(",")}`);
  }
}

function materialize(metadata: WorkspaceMetadata, events: readonly EventRecord[]): WorkspaceState {
  recordFullMaterialize();
  const projects = new Map<string, ProjectRecord>();
  const work = new Map<string, WorkRecord>();
  const conferences = new Map<string, ConferenceRequest>();
  const conferencePositions = new Map<string, ConferencePosition>();
  const conferenceMinutes = new Map<string, ConferenceMinutes>();
  const gates = new Map<string, GateRecord>();
  let attestationEnabledAtSequence: number | null = null;
  for (const event of events) {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload) || typeof payload.operation !== "string") {
      fail("WORKSPACE_EVENT_CORRUPT", `event ${event.id} payload is invalid`);
    }
    // WSE-2: the attestation.actor.enabled chain event turns mandatory actor
    // attestation on for itself and every later event; it is a control event that
    // touches no record graph, and a second one is a corrupt chain. Tracking it
    // inside the single event loop keeps validation one-pass and replay-order
    // exact — the enabling event carries the enabling actor and is the first that
    // requires one, so actorRequired is derived after this branch has run.
    if (payload.operation === ACTOR_ATTESTATION_ENABLE_OPERATION) {
      if (attestationEnabledAtSequence !== null) {
        fail("WORKSPACE_EVENT_CORRUPT", "duplicate attestation.actor.enabled event");
      }
      const record = payloadRecord(payload, ACTOR_ATTESTATION_ENABLE_OPERATION, true);
      try {
        validateActorAttestationEnableRecord(record);
      } catch (error) {
        if (error instanceof ActorAttestationError) {
          fail("WORKSPACE_EVENT_CORRUPT", "attestation enable record is invalid");
        }
        throw error;
      }
      attestationEnabledAtSequence = event.sequence;
      continue;
    }
    const actorRequired = attestationEnabledAtSequence !== null;
    if (projectOperations.has(payload.operation)) {
      const record = validateProject(payloadRecord(payload, payload.operation, actorRequired));
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
      // WSA-2: a project event does not change the work graph; the only work->project
      // invariant it can break (a deleted project with live work) is checked above.
      continue;
    }
    if (workOperations.has(payload.operation)) {
      const record = payloadRecord(payload, payload.operation, actorRequired) as unknown as WorkRecord;
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
        // WSD-4 replay parity: the gate precondition the verb enforces is
        // re-checked against the gates materialized so far, so a hand-crafted log
        // that drives a work item to done past a pending gate fails closed.
        assertGateClearance(gates.values(), record.id, record.status, "WORKSPACE_EVENT_CORRUPT");
      }
      work.set(record.id, record);
      validateWorkClosure(work, projects, record);
      continue;
    }
    if (conferenceOperations.has(payload.operation)) {
      // WSD-1: conference reducer arms. Every check is a bounded lookup against
      // the maps materialized so far — O(delta) per event, no collection scans,
      // and no work-closure metrics (the closure counters stay work-only).
      if (payload.operation === "conference.created") {
        const record = extensionRecordOrCorrupt(() => openConference(payloadRecord(payload, payload.operation, actorRequired)));
        requireEventBoundTimestamp(record.updatedAt, event, `conference ${record.id}`);
        if (conferences.has(record.id) || record.revision !== 1 || record.tombstone) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid conference create ${record.id}`);
        }
        requireLiveProject(projects, record.projectId, `conference ${record.id}`);
        for (const workId of record.linkedWorkIds) {
          requireLiveWork(work, record.projectId, workId, `conference ${record.id}`);
        }
        recordExtensionClosureValidation(2 + record.linkedWorkIds.length);
        conferences.set(record.id, record);
        continue;
      }
      if (payload.operation === "conference.updated") {
        const record = extensionRecordOrCorrupt(() => validateConferenceRequest(payloadRecord(payload, payload.operation, actorRequired)));
        requireEventBoundTimestamp(record.updatedAt, event, `conference ${record.id}`);
        const current = requireOpenConference(conferences, record.id, `conference ${record.id}`);
        if (record.status !== "cancelled" || record.tombstone || record.revision !== current.revision + 1) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid conference mutation ${record.id}`);
        }
        assertPinnedExtensionFields(current as unknown as JsonValue, record as unknown as JsonValue, ["status", "revision", "updatedAt"], `conference ${record.id}`);
        recordExtensionClosureValidation(2);
        conferences.set(record.id, record);
        continue;
      }
      if (payload.operation === "conference.position.appended") {
        const record = extensionRecordOrCorrupt(() => validateConferencePosition(payloadRecord(payload, payload.operation, actorRequired)));
        requireEventBoundTimestamp(record.updatedAt, event, `conference position ${record.id}`);
        if (conferencePositions.has(record.id) || record.revision !== 1 || record.tombstone) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid conference position ${record.id}`);
        }
        const conference = requireOpenConference(conferences, record.conferenceId, `conference position ${record.id}`);
        if (record.projectId !== conference.projectId) {
          fail("WORKSPACE_EVENT_CORRUPT", `conference position ${record.id} is not bound to its conference project`);
        }
        recordExtensionClosureValidation(2);
        conferencePositions.set(record.id, record);
        continue;
      }
      const parts = closePayload(payload, actorRequired);
      const record = extensionRecordOrCorrupt(() => validateConferenceRequest(parts.record));
      const minutes = extensionRecordOrCorrupt(() => validateConferenceMinutes(parts.minutes));
      requireEventBoundTimestamp(record.updatedAt, event, `conference ${record.id}`);
      requireEventBoundTimestamp(minutes.updatedAt, event, `conference minutes ${minutes.id}`);
      const current = requireOpenConference(conferences, record.id, `conference ${record.id}`);
      if (record.status !== "closed" || record.tombstone || record.revision !== current.revision + 1) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid conference close ${record.id}`);
      }
      assertPinnedExtensionFields(current as unknown as JsonValue, record as unknown as JsonValue, ["status", "revision", "updatedAt"], `conference ${record.id}`);
      if (conferenceMinutes.has(minutes.id) || minutes.revision !== 1 || minutes.tombstone ||
        minutes.conferenceId !== record.id || minutes.projectId !== record.projectId) {
        fail("WORKSPACE_EVENT_CORRUPT", `conference minutes ${minutes.id} are not bound to the closing conference`);
      }
      recordExtensionClosureValidation(3);
      conferences.set(record.id, record);
      conferenceMinutes.set(minutes.id, minutes);
      continue;
    }
    if (gateOperations.has(payload.operation)) {
      // WSD-1: gate reducer arms, O(delta) like the conference arms above.
      const record = extensionRecordOrCorrupt(() => validateGateRecord(payloadRecord(payload, payload.operation, actorRequired)));
      requireEventBoundTimestamp(record.updatedAt, event, `gate ${record.id}`);
      if (payload.operation === "gate.created") {
        if (gates.has(record.id) || record.revision !== 1 || record.tombstone || record.status !== "pending") {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid gate create ${record.id}`);
        }
        requireLiveProject(projects, record.projectId, `gate ${record.id}`);
        if (record.workId !== null) {
          requireLiveWork(work, record.projectId, record.workId, `gate ${record.id}`);
        }
        recordExtensionClosureValidation(2 + (record.workId === null ? 0 : 1));
        gates.set(record.id, record);
        continue;
      }
      const current = gates.get(record.id);
      if (!current || current.tombstone || record.revision !== current.revision + 1 ||
        (payload.operation === "gate.updated" && record.tombstone) || (payload.operation === "gate.deleted" && !record.tombstone)) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid gate mutation ${record.id}`);
      }
      // WSD-4: a gate.updated must walk the lifecycle graph, and a move to
      // satisfied must carry evidence that re-resolves here (parity with the
      // verb) and whose only extensions delta is the persisted locator entry.
      // gate.deleted keeps mutating tombstone alone; every other move pins
      // extensions, so a non-satisfied transition cannot smuggle in extensions.
      let gateMutableFields: readonly string[] = payload.operation === "gate.updated" ? ["status", "revision", "updatedAt"] : ["tombstone", "revision", "updatedAt"];
      if (payload.operation === "gate.updated") {
        if (!GATE_TRANSITIONS[current.status].includes(record.status)) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid gate transition ${record.id}`);
        }
        if (record.status === "satisfied") {
          const locator = readGateEvidenceLocator(record.extensions);
          if (locator === undefined || !resolveGateEvidence(locator, current, [...conferenceMinutes.values()], [...conferences.values()])) {
            fail("WORKSPACE_EVENT_CORRUPT", `gate ${record.id} evidence does not resolve`);
          }
          if (canonicalJson(record.extensions) !== canonicalJson(gateEvidenceExtensions(current.extensions, locator))) {
            fail("WORKSPACE_EVENT_CORRUPT", `gate ${record.id} evidence extensions are not exact`);
          }
          gateMutableFields = ["status", "revision", "updatedAt", "extensions"];
        }
      }
      assertPinnedExtensionFields(
        current as unknown as JsonValue,
        record as unknown as JsonValue,
        gateMutableFields,
        `gate ${record.id}`,
      );
      recordExtensionClosureValidation(2);
      gates.set(record.id, record);
      continue;
    }
    fail("WORKSPACE_EVENT_CORRUPT", `unknown operation ${payload.operation}`);
  }
  const projectRecords = [...projects.values()].sort((left, right) => compareCanonicalText(left.id, right.id));
  recordTerminalGraphValidation();
  const workRecords = validateWorkGraph([...work.values()]);
  return {
    metadata,
    version: events.length,
    headEventHash: events.at(-1)?.eventHash ?? null,
    projects: projectRecords,
    work: workRecords,
    conferences: sortExtensionRecords(conferences.values()),
    conferencePositions: sortExtensionRecords(conferencePositions.values()),
    conferenceMinutes: sortExtensionRecords(conferenceMinutes.values()),
    gates: sortExtensionRecords(gates.values()),
    events,
    attestationEnabledAtSequence,
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
  const views: Record<string, string> = {
    "STATUS.md": status,
    "index.json": canonicalJson({ schemaVersion: "tcrn.workspace-index.v1", projects: activeProjects, work: activeWork }),
    "readback.json": canonicalJson(readback),
  };
  // WSD-1: the extension index is a fourth view emitted ONLY when the workspace
  // holds at least one conference or gate record (positions and minutes cannot
  // exist without their conference), so the three views above and the view set
  // stay byte-identical for every workspace without extension records.
  if (state.conferences.length + state.gates.length > 0) {
    views["extensions.json"] = canonicalJson({
      schemaVersion: "tcrn.workspace-extension-index.v1",
      conferences: state.conferences,
      conferencePositions: state.conferencePositions,
      conferenceMinutes: state.conferenceMinutes,
      gates: state.gates,
    });
  }
  return views;
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

// The dev/ino pair that binds a path to the file it resolved to. Used by every
// rename-verify-remove sequence in this module and referenced by the lease helpers
// below, which assumed the name was in scope when they were written -- it was not,
// so this file never compiled under a real tsc.
interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
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

// WSA-7: a recovery claim whose writer is provably gone is reclaimable. The claim records
// pid and expiresAtNanoseconds precisely so this decision can be made, but nothing read
// them until now, so every SIGKILL left a claim that no code path could clear and the
// Workspace could never be opened again. Reclaim uses the same rename-verify-remove
// discipline as releaseRecoveryClaim so a concurrent reclaimer loses the rename instead of
// racing us. Deliberately fail-closed: the writer counts as gone only when the claim has
// expired AND its pid is dead, matching the lease-owner probe. Both directions of pid reuse
// are safe -- a recycled pid reads as alive and we refuse.
async function reclaimStaleRecoveryClaim(
  workspaceRoot: string,
  path: string,
  existing: { readonly owner: Readonly<Record<string, JsonValue>>; readonly identity: { readonly dev: number | bigint; readonly ino: number | bigint } },
): Promise<void> {
  const quarantine = controlPath(workspaceRoot, `stale-recovery-${String(existing.owner.token)}`);
  try {
    await rename(path, quarantine);
  } catch {
    fail("WORKSPACE_LOCKED", "stale recovery claim was not exclusively reclaimable");
  }
  const moved = await lstat(quarantine);
  if (!sameIdentity(moved, existing.identity) || !moved.isFile() || moved.nlink !== 1) {
    fail("WORKSPACE_LEASE_INVALID", "stale recovery claim identity changed during reclaim");
  }
  await rm(quarantine);
}

async function createRecoveryClaim(workspaceRoot: string, now: string, nowNanoseconds: bigint, ttl: number, reclaimed = false): Promise<RecoveryClaim> {
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
      const existing = await parseRecoveryClaim(path);
      const expiresAtNanoseconds = BigInt(String(existing.owner.expiresAtNanoseconds));
      const pid = Number(existing.owner.pid);
      // A malformed, linked, or special-file claim never reaches here: parseRecoveryClaim
      // fails closed on it first, so those still demand operator attention.
      if (reclaimed || expiresAtNanoseconds > nowNanoseconds || processAlive(pid)) {
        fail("WORKSPACE_LOCKED", "another lease recovery owns the Workspace");
      }
      await reclaimStaleRecoveryClaim(workspaceRoot, path, existing);
      // One retry only: if the slot is taken again we lost a race with a live writer.
      return await createRecoveryClaim(workspaceRoot, now, nowNanoseconds, ttl, true);
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

async function reclaimObservedLease(leasePath: string, workspaceRoot: string, observed: LeaseObservation, options: {
  readonly afterLeaseQuarantineForTest?: (value: { readonly identity: FileIdentity; readonly entries: readonly string[] }) => Promise<void>;
}): Promise<void> {
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
  const captured = Object.freeze({
    identity: Object.freeze({ dev: observed.directoryIdentity.dev, ino: observed.directoryIdentity.ino }),
    entries: Object.freeze([...await readdir(quarantine)]),
  });
  if (consumeQuarantineReplacementTestInstrumentation()) {
    const attemptOwned = controlPath(workspaceRoot, "attempt-owned-quarantine-for-test");
    await rename(quarantine, attemptOwned);
    await mkdir(quarantine, { mode: 0o700 });
    await writeFile(resolve(quarantine, "foreign-sentinel"), "foreign-survives", { mode: 0o600 });
  }
  const current = await lstat(quarantine).catch(() => fail("WORKSPACE_LEASE_INVALID", "quarantine disappeared before cleanup"));
  if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, observed.directoryIdentity)) {
    fail("WORKSPACE_LEASE_INVALID", "quarantine changed before cleanup");
  }
  await rm(quarantine, { recursive: true, force: true });
  await options.afterLeaseQuarantineForTest?.(captured);
}

// WSA-7: read-only view of the recovery claim, so an operator can obtain the token that
// breakWorkspaceRecoveryClaim demands. Reports rather than throws: a malformed or unsafe
// claim is exactly what the operator needs to be told about, so it becomes an observation
// with a reason, not an exception. No mutation.
async function observeRecoveryClaim(workspaceRoot: string, nowNanoseconds: bigint): Promise<Readonly<Record<string, JsonValue>> | null> {
  const path = controlPath(workspaceRoot, "lease-recovery.claim");
  // Absence is probed before parsing: parseRecoveryClaim wraps every failure, ENOENT
  // included, into WORKSPACE_LEASE_INVALID, so "no claim" and "unsafe claim" are
  // indistinguishable downstream of it.
  if (await lstat(path).then(() => false).catch(() => true)) {
    return null;
  }
  try {
    const existing = await parseRecoveryClaim(path);
    const pid = Number(existing.owner.pid);
    const expired = BigInt(String(existing.owner.expiresAtNanoseconds)) <= nowNanoseconds;
    const alive = processAlive(pid);
    return {
      token: String(existing.owner.token),
      pid,
      acquiredAt: String(existing.owner.acquiredAt),
      expired,
      processAlive: alive,
      // The acquire path reclaims this automatically; only the pid-reuse wedge
      // (expired but apparently alive) needs breakWorkspaceRecoveryClaim.
      selfReclaiming: expired && !alive,
    };
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return { unsafe: true, reasonCode: error.reasonCode, detail: error.message };
    }
    throw error;
  }
}

// WSA-4: read-only lease report so an operator can see the wedge (an expired lease
// whose pid was recycled by a live process, which the acquire path treats as
// active). No mutation.
export async function inspectWorkspaceLease(workspaceRootInput: string, options: { readonly now: string }): Promise<Readonly<Record<string, JsonValue>>> {
  assertStrictInstant(options.now);
  const nowNanoseconds = parseStrictInstant(options.now);
  const workspaceRoot = await boundDirectory(workspaceRootInput);
  await readMetadata(workspaceRoot);
  const recoveryClaim = await observeRecoveryClaim(workspaceRoot, nowNanoseconds);
  const leasePath = controlPath(workspaceRoot, "lease");
  let observed: LeaseObservation;
  try {
    observed = await observeLease(leasePath, workspaceRoot);
  } catch (error) {
    if (error instanceof WorkspaceError && error.reasonCode === "WORKSPACE_LEASE_INVALID") {
      return { schemaVersion: "tcrn.workspace-lease-inspection.v1", reasonCode: "WORKSPACE_LEASE_OBSERVED", held: false, recoveryClaim };
    }
    throw error;
  }
  if (!observed.owner) {
    return { schemaVersion: "tcrn.workspace-lease-inspection.v1", reasonCode: "WORKSPACE_LEASE_OBSERVED", held: false, recoveryClaim };
  }
  const pid = Number(observed.owner.pid);
  return {
    schemaVersion: "tcrn.workspace-lease-inspection.v1",
    reasonCode: "WORKSPACE_LEASE_OBSERVED",
    held: true,
    token: String(observed.owner.token),
    pid,
    acquiredAt: String(observed.owner.acquiredAt),
    expired: BigInt(String(observed.owner.expiresAtNanoseconds)) <= nowNanoseconds,
    processAlive: processAlive(pid),
    recoveryClaim,
  };
}

// WSA-4: operator-attested break for the pid-reuse wedge. Bypasses the processAlive
// check the acquire path uses, but requires the exact current owner token (proving
// the operator inspected it) AND an already-expired lease — so a live or valid
// lease can never be broken. Fails closed otherwise.
export async function breakWorkspaceLease(workspaceRootInput: string, options: { readonly now: string; readonly ownerToken: string }): Promise<Readonly<Record<string, JsonValue>>> {
  assertStrictInstant(options.now);
  const nowNanoseconds = parseStrictInstant(options.now);
  const workspaceRoot = await boundDirectory(workspaceRootInput);
  await readMetadata(workspaceRoot);
  const leasePath = controlPath(workspaceRoot, "lease");
  const observed = await observeLease(leasePath, workspaceRoot);
  if (!observed.owner) {
    fail("WORKSPACE_LEASE_INVALID", "no lease owner to break");
  }
  if (observed.owner.token !== options.ownerToken) {
    fail("WORKSPACE_LEASE_INVALID", "break requires the current lease owner token");
  }
  if (BigInt(String(observed.owner.expiresAtNanoseconds)) > nowNanoseconds) {
    fail("WORKSPACE_LOCKED", "an unexpired lease cannot be broken");
  }
  await reclaimObservedLease(leasePath, workspaceRoot, observed, {});
  return {
    schemaVersion: "tcrn.workspace-lease-break.v1",
    reasonCode: "WORKSPACE_LEASE_BROKEN",
    token: String(observed.owner.token),
    pid: Number(observed.owner.pid),
  };
}

// WSA-7: the recovery-claim counterpart of breakWorkspaceLease, for the one wedge that
// survives automatic reclaim. createRecoveryClaim reclaims a claim only when it has
// expired AND its pid is dead; a recycled pid reads as alive, so an expired claim from a
// long-dead writer can still wedge the Workspace. This verb bypasses the liveness probe
// exactly as the lease break does, and demands the same proof of operator attention: the
// exact current claim token, which is only obtainable by inspecting the claim. An
// unexpired claim is never breakable, so a live recoverer cannot be stolen from.
export async function breakWorkspaceRecoveryClaim(workspaceRootInput: string, options: { readonly now: string; readonly claimToken: string }): Promise<Readonly<Record<string, JsonValue>>> {
  assertStrictInstant(options.now);
  const nowNanoseconds = parseStrictInstant(options.now);
  const workspaceRoot = await boundDirectory(workspaceRootInput);
  await readMetadata(workspaceRoot);
  const path = controlPath(workspaceRoot, "lease-recovery.claim");
  // See observeRecoveryClaim: absence must be probed before parsing, which folds ENOENT
  // into the same reason code as a genuinely unsafe claim.
  if (await lstat(path).then(() => false).catch(() => true)) {
    fail("WORKSPACE_LEASE_INVALID", "no recovery claim to break");
  }
  const existing = await parseRecoveryClaim(path);
  if (existing.owner.token !== options.claimToken) {
    fail("WORKSPACE_LEASE_INVALID", "break requires the current recovery claim token");
  }
  if (BigInt(String(existing.owner.expiresAtNanoseconds)) > nowNanoseconds) {
    fail("WORKSPACE_LOCKED", "an unexpired recovery claim cannot be broken");
  }
  await reclaimStaleRecoveryClaim(workspaceRoot, path, existing);
  return {
    schemaVersion: "tcrn.workspace-recovery-claim-break.v1",
    reasonCode: "WORKSPACE_RECOVERY_CLAIM_BROKEN",
    token: String(existing.owner.token),
    pid: Number(existing.owner.pid),
  };
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
  readonly afterLeaseQuarantineForTest?: (value: { readonly identity: FileIdentity; readonly entries: readonly string[] }) => Promise<void>;
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
        // The lease-directory mtime is a real-clock timestamp; the creation grace
        // is a liveness guard (is another process mid-creating this lease?), so it
        // is measured against the real wall clock, not the injected event time —
        // consistent with the real-system processAlive probe above. A negative or
        // future elapsed is treated as within grace (fail-closed: do not stomp).
        // This bounds the grace to ttl of real time, so a crashed dir-only lease
        // becomes reclaimable rather than wedging when the injected event time
        // predates the real directory mtime.
        const age = Date.now() - initial.directoryModifiedMilliseconds;
        if (age < ttl) {
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
        // Real-clock creation grace (see the first observation above): a crashed
        // dir-only lease is reclaimable once ttl of real time has elapsed.
        const age = Date.now() - observed.directoryModifiedMilliseconds;
        if (age < ttl) {
          fail("WORKSPACE_LOCKED", "incomplete lease changed within its creation grace period");
        }
      }
      await reclaimObservedLease(leasePath, workspaceRoot, observed, options);
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
    if (created) {
      // A reclaim that started after this creator observed its fresh directory
      // may have quarantined and replaced that directory, and a removed
      // directory's dev/ino tuple can recur on the replacement (the filesystem
      // may reuse the tuple), so directory identity alone cannot prove
      // generation continuity here. An active recovery claim is the durable
      // witness of such a reclaim: fail closed instead of completing an owner
      // file inside a possibly-replaced lease generation.
      const claimPath = controlPath(workspaceRoot, "lease-recovery.claim");
      try {
        await lstat(claimPath);
        await parseRecoveryClaim(claimPath);
        fail("WORKSPACE_LEASE_INVALID", "lease creation overlaps an active recovery");
      } catch (error) {
        if (error instanceof WorkspaceError || (error as { code?: string }).code !== "ENOENT") {
          throw error;
        }
      }
    }
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

// WSA-1: a mutation builder validates its input against the claim-fresh state and
// returns both the event payload and the already-validated next-state record sets.
// projects must be id-sorted and work must be validateWorkGraph output so the
// constructed committed state is byte-identical to a fresh materialize.
interface MutationDelta {
  readonly payload: JsonValue;
  readonly projects: readonly ProjectRecord[];
  readonly work: readonly WorkRecord[];
  // WSD-1: extension collections flow through the delta additively; a builder
  // that leaves one undefined keeps the claim-fresh state's collection, so the
  // constructed committed state stays byte-identical to a fresh materialize.
  readonly conferences?: readonly ConferenceRequest[];
  readonly conferencePositions?: readonly ConferencePosition[];
  readonly conferenceMinutes?: readonly ConferenceMinutes[];
  readonly gates?: readonly GateRecord[];
}

async function appendEvent(workspaceRootInput: string, lease: WorkspaceLease, buildDelta: (state: WorkspaceState) => MutationDelta, options: WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertStrictInstant(options.occurredAt);
  const workspace = await resolveWorkspace(workspaceRootInput);
  await assertLease(workspace.root, lease);
  const claim = await createMutationClaim(workspace.root, lease);
  try {
    await options.afterMutationClaimForTest?.();
    await assertLease(workspace.root, lease);
    // WSA-1: the single full replay per mutation. Input validation runs against
    // this claim-fresh state (via buildDelta), closing the entry-path TOCTOU gap.
    const state = materialize(workspace.metadata, await readSegmentEvents(workspace.root, workspace.metadata));
    if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion !== state.version) {
      fail("WORKSPACE_CAS_MISMATCH", `expected=${String(options.expectedVersion)} actual=${state.version}`);
    }
    const delta = buildDelta(state);
    assertWorkspaceRecordCount(state.version + 1);
    const sequence = state.version + 1;
    // WSE-2: actor injection is single-sourced here so every mutation verb only
    // forwards options.actorId (like occurredAt — no clock, no randomness). Once
    // attestation is enabled, or on the enabling event itself, a valid actor is
    // mandatory (WORKSPACE_ACTOR_REQUIRED) and validated (WORKSPACE_ACTOR_INVALID),
    // and it joins the hashed payload. Before enablement no actor is written even
    // when one is supplied — the default stays actor-optional and byte-identical
    // to rc.4 — so the enable event is the boundary. The reducer re-derives that
    // boundary and re-enforces the identical rule, so this write path cannot
    // outrun replay.
    const deltaPayload = delta.payload;
    const isEnableEvent = deltaPayload !== null && typeof deltaPayload === "object" && !Array.isArray(deltaPayload) &&
      deltaPayload.operation === ACTOR_ATTESTATION_ENABLE_OPERATION;
    const actorRequired = state.attestationEnabledAtSequence !== null || isEnableEvent;
    let payload: JsonValue = deltaPayload;
    if (actorRequired) {
      if (options.actorId === undefined) {
        fail("WORKSPACE_ACTOR_REQUIRED", "a valid actor is mandatory once attestation is enabled");
      }
      try {
        assertActorId(options.actorId);
      } catch (error) {
        if (error instanceof ActorAttestationError) {
          fail("WORKSPACE_ACTOR_INVALID", options.actorId);
        }
        throw error;
      }
      payload = { ...(deltaPayload as Readonly<Record<string, JsonValue>>), actor: options.actorId };
    }
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
    const segmentBytes = canonicalJson([...current, event]);
    await atomicWrite(segmentPath, segmentBytes, workspace.root, options.crashAt);
    crash("after-event-commit", options.crashAt);
    // WSA-1: durability readback bounded to the just-committed segment replaces the
    // full-chain re-materialize; atomicWrite already fsync+rename+identity-verified,
    // and the chain was validated under this claim, so re-reading it wholesale was
    // redundant. The committed state is applied from the validated delta, and equals
    // a fresh materialize by construction.
    const readback = await boundFile(segmentPath);
    if (readback.toString("utf8") !== segmentBytes) {
      fail("WORKSPACE_EVENT_CORRUPT", `segment ${segmentIndex} readback mismatch`);
    }
    const committed: WorkspaceState = {
      metadata: workspace.metadata,
      version: sequence,
      headEventHash: event.eventHash,
      projects: delta.projects,
      work: delta.work,
      conferences: delta.conferences ?? state.conferences,
      conferencePositions: delta.conferencePositions ?? state.conferencePositions,
      conferenceMinutes: delta.conferenceMinutes ?? state.conferenceMinutes,
      gates: delta.gates ?? state.gates,
      events: [...state.events, event],
      attestationEnabledAtSequence: isEnableEvent ? sequence : state.attestationEnabledAtSequence,
    };
    await writeViews(workspace.root, committed, options.crashAt);
    return committed;
  } finally {
    await releaseMutationClaim(workspace.root, lease, claim);
  }
}

function sortedProjects(records: readonly ProjectRecord[]): readonly ProjectRecord[] {
  return [...records].sort((left, right) => compareCanonicalText(left.id, right.id));
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
  const externalKey = canonicalExternalKey(input.externalKey);
  const id = deriveStableId("project", externalKey);
  return appendEvent(workspaceRoot, lease, (state) => {
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
    return { payload: { operation: "project.created", record }, projects: sortedProjects([...state.projects, record]), work: state.work };
  }, input);
}

export async function updateProject(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly id: string;
  readonly name: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const current = projectById(state, input.id);
    const record = validateProject(
      { ...current, name: input.name, revision: current.revision + 1, updatedAt: input.occurredAt },
      "WORKSPACE_INPUT_INVALID",
    );
    return { payload: { operation: "project.updated", record }, projects: sortedProjects(state.projects.map((entry) => entry.id === record.id ? record : entry)), work: state.work };
  }, input);
}

export async function deleteProject(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly id: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const current = projectById(state, input.id);
    if (state.work.some((record) => record.projectId === current.id && !record.tombstone)) {
      fail("WORKSPACE_INPUT_INVALID", `project ${current.id} still owns live work`);
    }
    const record = { ...current, revision: current.revision + 1, updatedAt: input.occurredAt, tombstone: true };
    return { payload: { operation: "project.deleted", record }, projects: sortedProjects(state.projects.map((entry) => entry.id === record.id ? record : entry)), work: state.work };
  }, input);
}

export async function createWork(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly projectId: string;
  readonly externalKey: string;
  readonly kind: PlannedDeliveryKind;
  readonly parentId: string | null;
  readonly status?: WorkStatus;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const externalKey = canonicalExternalKey(input.externalKey);
  const id = deriveStableId("work", externalKey);
  return appendEvent(workspaceRoot, lease, (state) => {
    projectById(state, input.projectId);
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
    const work = validateWorkGraph([...state.work, record]);
    return { payload: { operation: "work.created", record }, projects: state.projects, work };
  }, input);
}

export async function transitionWork(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly id: string;
  readonly status: WorkStatus;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const current = workById(state, input.id);
    assertWorkTransition(current.status, input.status);
    // WSD-4: a non-tombstoned pending gate anchored to this work item blocks a
    // transition whose target is done (the designated set); the reducer replays
    // the identical predicate as WORKSPACE_EVENT_CORRUPT.
    assertGateClearance(state.gates, current.id, input.status, "WORKSPACE_GATE_PENDING");
    const record: WorkRecord = { ...current, status: input.status, revision: current.revision + 1, updatedAt: input.occurredAt };
    const work = validateWorkGraph(state.work.map((entry) => entry.id === record.id ? record : entry));
    return { payload: { operation: "work.updated", record }, projects: state.projects, work };
  }, input);
}

export async function deleteWork(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly id: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const current = workById(state, input.id);
    const record: WorkRecord = { ...current, revision: current.revision + 1, updatedAt: input.occurredAt, tombstone: true };
    const work = validateWorkGraph(state.work.map((entry) => entry.id === record.id ? record : entry));
    return { payload: { operation: "work.deleted", record }, projects: state.projects, work };
  }, input);
}

// WSE-2: turn on mandatory actor attestation for this workspace by appending the
// attestation.actor.enabled chain event. It carries the enabling actor (injected
// by appendEvent, which treats the enable event as actor-mandatory), touches no
// record graph, and is one-way — v1 defines no disable operation. Re-enabling an
// already-attested workspace fails closed WORKSPACE_INPUT_INVALID.
export async function enableActorAttestation(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly actorId: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    if (state.attestationEnabledAtSequence !== null) {
      fail("WORKSPACE_INPUT_INVALID", "actor attestation is already enabled");
    }
    const record = buildActorAttestationEnableRecord() as unknown as JsonValue;
    return { payload: { operation: ACTOR_ATTESTATION_ENABLE_OPERATION, record }, projects: state.projects, work: state.work };
  }, input);
}

// WSD-1: verb-side lookups for the extension collections. The referenced record
// must exist; conference mutations additionally require the referenced
// conference to be open, failing WORKSPACE_CONFERENCE_NOT_OPEN otherwise — the
// same rule the reducer replays as WORKSPACE_EVENT_CORRUPT.
function openConferenceById(state: WorkspaceState, id: string): ConferenceRequest {
  const record = state.conferences.find((entry) => entry.id === id);
  if (!record) {
    fail("WORKSPACE_INPUT_INVALID", `conference ${id} is unavailable`);
  }
  if (record.status !== "open") {
    fail("WORKSPACE_CONFERENCE_NOT_OPEN", `conference ${id} is ${record.status}`);
  }
  return record;
}

function gateById(state: WorkspaceState, id: string): GateRecord {
  const record = state.gates.find((entry) => entry.id === id);
  if (!record || record.tombstone) {
    fail("WORKSPACE_INPUT_INVALID", `gate ${id} is unavailable`);
  }
  return record;
}

// WSD-1: the seven extension mutation verbs. Each derives its stable id from an
// external key, validates its record through the unchanged conference/gate
// validators (validator failures propagate verbatim for the CLI to surface),
// and appends exactly one event through appendEvent and the shared SDC-2
// payload constructor.
export async function openConferenceInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly externalKey: string;
  readonly projectId: string;
  readonly type: ConferenceRequest["type"];
  readonly title: string;
  readonly linkedWorkIds: readonly string[];
  readonly desiredOutcome: string;
  readonly participantIds: readonly string[];
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const id = deriveStableId("conference", canonicalExternalKey(input.externalKey));
  return appendEvent(workspaceRoot, lease, (state) => {
    projectById(state, input.projectId);
    for (const workId of input.linkedWorkIds) {
      if (workById(state, workId).projectId !== input.projectId) {
        fail("WORKSPACE_INPUT_INVALID", `work ${workId} is outside project ${input.projectId}`);
      }
    }
    if (state.conferences.some((entry) => entry.id === id)) {
      fail("WORKSPACE_INPUT_INVALID", `conference ${id} already exists`);
    }
    const record = openConference({
      schemaVersion: CONFERENCE_REQUEST_VERSION,
      id,
      projectId: input.projectId,
      type: input.type,
      title: input.title,
      linkedWorkIds: input.linkedWorkIds,
      desiredOutcome: input.desiredOutcome,
      participantIds: input.participantIds,
      status: "open",
      revision: 1,
      updatedAt: input.occurredAt,
      tombstone: false,
      extensions: {},
    });
    return {
      payload: buildEventPayload("conference.created", record as unknown as JsonValue),
      projects: state.projects,
      work: state.work,
      conferences: sortExtensionRecords([...state.conferences, record]),
    };
  }, input);
}

export async function appendConferencePositionInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly conferenceId: string;
  readonly externalKey: string;
  readonly actorId: string;
  readonly position: string;
  readonly risks: readonly string[];
  readonly recommendations: readonly string[];
  readonly evidenceIds: readonly string[];
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const id = deriveStableId("position", canonicalExternalKey(input.externalKey));
  return appendEvent(workspaceRoot, lease, (state) => {
    const conference = openConferenceById(state, input.conferenceId);
    if (state.conferencePositions.some((entry) => entry.id === id)) {
      fail("WORKSPACE_INPUT_INVALID", `conference position ${id} already exists`);
    }
    const record = appendConferencePosition({
      schemaVersion: CONFERENCE_POSITION_VERSION,
      id,
      conferenceId: conference.id,
      projectId: conference.projectId,
      actorId: input.actorId,
      position: input.position,
      risks: input.risks,
      recommendations: input.recommendations,
      evidenceIds: input.evidenceIds,
      revision: 1,
      updatedAt: input.occurredAt,
      tombstone: false,
      extensions: {},
    }, conference);
    return {
      payload: buildEventPayload("conference.position.appended", record as unknown as JsonValue),
      projects: state.projects,
      work: state.work,
      conferencePositions: sortExtensionRecords([...state.conferencePositions, record]),
    };
  }, input);
}

export async function closeConferenceInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly conferenceId: string;
  readonly minutesExternalKey: string;
  readonly summary: string;
  readonly outcomeClass: ConferenceMinutes["outcomeClass"];
  readonly decisions: readonly string[];
  readonly unresolvedIssues: readonly string[];
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const minutesId = deriveStableId("minutes", canonicalExternalKey(input.minutesExternalKey));
  return appendEvent(workspaceRoot, lease, (state) => {
    const conference = openConferenceById(state, input.conferenceId);
    if (state.conferenceMinutes.some((entry) => entry.id === minutesId)) {
      fail("WORKSPACE_INPUT_INVALID", `conference minutes ${minutesId} already exist`);
    }
    const record = validateConferenceRequest({ ...conference, status: "closed", revision: conference.revision + 1, updatedAt: input.occurredAt });
    const minutes = validateConferenceMinutes({
      schemaVersion: CONFERENCE_MINUTES_VERSION,
      id: minutesId,
      conferenceId: conference.id,
      projectId: conference.projectId,
      summary: input.summary,
      outcomeClass: input.outcomeClass,
      decisions: input.decisions,
      unresolvedIssues: input.unresolvedIssues,
      revision: 1,
      updatedAt: input.occurredAt,
      tombstone: false,
      extensions: {},
    });
    // The single-event atomic close: the payload carries the closed conference
    // as its record and the minutes as the registered per-operation extra.
    return {
      payload: buildEventPayload("conference.closed", record as unknown as JsonValue, undefined, { minutes: minutes as unknown as JsonValue }),
      projects: state.projects,
      work: state.work,
      conferences: sortExtensionRecords(state.conferences.map((entry) => entry.id === record.id ? record : entry)),
      conferenceMinutes: sortExtensionRecords([...state.conferenceMinutes, minutes]),
    };
  }, input);
}

export async function cancelConferenceInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly conferenceId: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const conference = openConferenceById(state, input.conferenceId);
    const record = validateConferenceRequest({ ...conference, status: "cancelled", revision: conference.revision + 1, updatedAt: input.occurredAt });
    return {
      payload: buildEventPayload("conference.updated", record as unknown as JsonValue),
      projects: state.projects,
      work: state.work,
      conferences: sortExtensionRecords(state.conferences.map((entry) => entry.id === record.id ? record : entry)),
    };
  }, input);
}

export async function createGateInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly externalKey: string;
  readonly projectId: string;
  readonly workId: string | null;
  readonly title: string;
  readonly outcomeClass: GateRecord["outcomeClass"];
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const id = deriveStableId("gate", canonicalExternalKey(input.externalKey));
  return appendEvent(workspaceRoot, lease, (state) => {
    projectById(state, input.projectId);
    if (input.workId !== null && workById(state, input.workId).projectId !== input.projectId) {
      fail("WORKSPACE_INPUT_INVALID", `work ${input.workId} is outside project ${input.projectId}`);
    }
    if (state.gates.some((entry) => entry.id === id)) {
      fail("WORKSPACE_INPUT_INVALID", `gate ${id} already exists`);
    }
    const record = validateGateRecord({
      schemaVersion: GATE_VERSION,
      id,
      projectId: input.projectId,
      workId: input.workId,
      title: input.title,
      outcomeClass: input.outcomeClass,
      status: "pending",
      revision: 1,
      updatedAt: input.occurredAt,
      tombstone: false,
      extensions: {},
    });
    return {
      payload: buildEventPayload("gate.created", record as unknown as JsonValue),
      projects: state.projects,
      work: state.work,
      gates: sortExtensionRecords([...state.gates, record]),
    };
  }, input);
}

export async function transitionGateInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly id: string;
  readonly status: GateRecord["status"];
  readonly minutesLocator?: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const current = gateById(state, input.id);
    // WSD-4: walk the gate lifecycle graph (satisfied is terminal), and require a
    // resolving conference-minutes locator to reach satisfied — persisting it in
    // the gate's extensions so replay re-resolves the identical evidence.
    if (!GATE_TRANSITIONS[current.status].includes(input.status)) {
      fail("WORKSPACE_INPUT_INVALID", `gate ${current.id} cannot transition ${current.status} to ${input.status}`);
    }
    let extensions = current.extensions;
    if (input.status === "satisfied") {
      const locator = input.minutesLocator;
      if (locator === undefined || !resolveGateEvidence(locator, current, state.conferenceMinutes, state.conferences)) {
        fail("WORKSPACE_GATE_EVIDENCE_UNRESOLVED", `gate ${current.id} evidence ${String(locator)} does not resolve to anchoring conference minutes`);
      }
      extensions = gateEvidenceExtensions(current.extensions, locator);
    } else if (input.minutesLocator !== undefined) {
      fail("WORKSPACE_INPUT_INVALID", `gate ${current.id} minutes locator applies only to a satisfied transition`);
    }
    const record = validateGateRecord({ ...current, status: input.status, revision: current.revision + 1, updatedAt: input.occurredAt, extensions });
    return {
      payload: buildEventPayload("gate.updated", record as unknown as JsonValue),
      projects: state.projects,
      work: state.work,
      gates: sortExtensionRecords(state.gates.map((entry) => entry.id === record.id ? record : entry)),
    };
  }, input);
}

export async function deleteGateInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly id: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const current = gateById(state, input.id);
    const record = validateGateRecord({ ...current, revision: current.revision + 1, updatedAt: input.occurredAt, tombstone: true });
    return {
      payload: buildEventPayload("gate.deleted", record as unknown as JsonValue),
      projects: state.projects,
      work: state.work,
      gates: sortExtensionRecords(state.gates.map((entry) => entry.id === record.id ? record : entry)),
    };
  }, input);
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
  // WSD-1: extension collections are exported ONLY when present so the export
  // bytes (and the archive digest) stay identical for every workspace without
  // conference/gate events. canonicalJson sorts keys, so conditional inclusion
  // is byte-stable.
  const extensionCollections = state.conferences.length + state.gates.length > 0
    ? {
      conferences: state.conferences,
      conferencePositions: state.conferencePositions,
      conferenceMinutes: state.conferenceMinutes,
      gates: state.gates,
    }
    : {};
  return canonicalJson({
    schemaVersion: "tcrn.workspace-export.v1",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    projects: state.projects,
    work: state.work,
    ...extensionCollections,
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
