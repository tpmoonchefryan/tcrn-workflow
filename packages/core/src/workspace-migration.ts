// SPDX-License-Identifier: Apache-2.0
// STORY-178 — the file↔pg bidirectional migration verb family. Moves the whole
// workspace data plane (event segments, workspace metadata, and the two derived
// stores) from one backend to the other, byte-preserving, so the migration
// criterion matches the STORY-176 equivalence gate: per-event byte equality,
// version continuity, head hash equality, and store-marker equality.
//
// A bypass copy is refused, never overwritten: when the target already holds a
// workspace whose identity/version/head do not match the source, execute and
// verify both fail closed with WORKSPACE_MIGRATION_FUTURE. An unreachable target
// surfaces the backend's own WORKSPACE_MIGRATION_APPLY_UNAVAILABLE.

import { resolve } from "node:path";

import { canonicalJson } from "../../protocol/src/index.js";
import { ARTIFACT_LIMITS } from "./artifact-lifecycle.js";
import { KNOWLEDGE_LIMITS } from "./knowledge-core.js";
import { FileBackend, StorageError, WORKSPACE_CONTROL_DIRECTORY } from "./storage-backend.js";
import type { StorageBackend } from "./storage-backend.js";
import { acquireWorkspaceLease } from "./workspace.js";
import {
  STORAGE_HOME_VERSION,
  readStorageHomeDeclaration,
  removeStorageHomeDeclaration,
  writeStorageHomeDeclaration,
} from "./storage-home.js";
import { FileStoreBackend, StoreBackendError } from "./store-backend.js";
import type { FileStoreBackendProfile, StoreBackend } from "./store-backend.js";

/** The backend the migration writes to. "file" is the production track. */
export type MigrationDirection = "file" | "pg";

export interface MigrationPlan {
  readonly schemaVersion: "tcrn.workspace-migration-plan.v1";
  readonly direction: MigrationDirection;
  readonly source: MigrationDirection;
  readonly eventCount: number;
  readonly workspaceId: string;
  readonly version: number;
  readonly headEventHash: string | null;
  readonly steps: readonly string[];
}

export interface MigrationVerification {
  readonly ok: boolean;
  readonly reasonCode: string;
  readonly eventCount: number;
  readonly headEventHash: string | null;
}

export interface MigrationOptions {
  /** The PG-side storage backend factory. Absent for a file↔file degenerate run. */
  readonly backend?: (root: string) => StorageBackend;
  /** The PG-side store backend factory. Absent for a file↔file degenerate run. */
  readonly storeBackend?: (root: string) => StoreBackend;
  /**
   * INC-074: the PG schema the chain is being migrated to. A file→pg migration
   * writes it into the storage-home sentinel in the source file workspace, so the
   * file backend thereafter refuses mutating verbs and a PG-facing path must name
   * the same schema. Required for a pg target; ignored for a file target.
   */
  readonly schema?: string;
  /**
   * INC-074: the instant the migration completed, stamped into the sentinel. The
   * engine has no clock (determinism constraint); the CLI supplies it at the
   * boundary, the same way mutating verbs take `--at`.
   */
  readonly migratedAt?: string;
}

export const WORKSPACE_MIGRATION_REASON_CODES = Object.freeze([
  "WORKSPACE_MIGRATION_APPLY_UNAVAILABLE",
  "WORKSPACE_MIGRATION_FUTURE",
  "WORKSPACE_MIGRATION_INVALID",
  "WORKSPACE_MIGRATION_NOT_APPLIED",
  "WORKSPACE_MIGRATION_VERIFY_MISMATCH",
  "WORKSPACE_MIGRATION_VERIFY_STORE_MISMATCH",
] as const);

export type WorkspaceMigrationReasonCode = typeof WORKSPACE_MIGRATION_REASON_CODES[number];

export const WORKSPACE_MIGRATION_VERIFIED = "WORKSPACE_MIGRATION_VERIFIED" as const;

export class WorkspaceMigrationError extends Error {
  readonly reasonCode: WorkspaceMigrationReasonCode;

  constructor(reasonCode: WorkspaceMigrationReasonCode, message: string) {
    super(message);
    this.name = "WorkspaceMigrationError";
    this.reasonCode = reasonCode;
  }
}

interface MigratedSegment {
  readonly name: string;
  readonly bytes: Buffer;
}

interface MigratedRecord {
  readonly id: string;
  readonly bytes: Buffer;
}

interface MigratedKnowledgeStore {
  readonly marker: Buffer;
  readonly metadata: readonly MigratedRecord[];
  readonly bodies: readonly MigratedRecord[];
  readonly view: Buffer;
}

interface MigratedArtifactStore {
  readonly marker: Buffer;
  readonly records: readonly MigratedRecord[];
}

interface MigratedView {
  readonly name: string;
  readonly bytes: Buffer;
}

interface WorkspaceSnapshot {
  readonly workspaceId: string;
  readonly metadataBytes: Buffer;
  readonly segments: readonly MigratedSegment[];
  readonly version: number;
  readonly headEventHash: string | null;
  readonly views: readonly MigratedView[];
  readonly knowledge: MigratedKnowledgeStore | null;
  readonly artifact: MigratedArtifactStore | null;
}

interface TargetProbe {
  readonly present: boolean;
  readonly workspaceId: string | null;
  readonly version: number | null;
  readonly headEventHash: string | null;
}

// The file-store profiles the migration constructs its default file store
// backends with. They mirror the two stores' private profiles exactly (same
// reason codes, same byte bounds), so a file-side read during a migration
// enforces the identical contract the engine's own store verbs do.
const knowledgeStoreProfile: FileStoreBackendProfile = {
  reasonCodes: {
    pathInvalid: "KNOWLEDGE_PATH_INVALID",
    linkUnsafe: "KNOWLEDGE_LINK_UNSAFE",
    specialFile: "KNOWLEDGE_SPECIAL_FILE",
    limitExceeded: "KNOWLEDGE_LIMIT_EXCEEDED",
    sourceChanged: "KNOWLEDGE_SOURCE_CHANGED",
    alreadyExists: "KNOWLEDGE_ALREADY_EXISTS",
  },
  limits: {
    markerBytes: 16_384,
    metadataBytes: KNOWLEDGE_LIMITS.maximumMetadataBytes,
    bodyBytes: KNOWLEDGE_LIMITS.maximumBodyBytes,
    viewBytes: KNOWLEDGE_LIMITS.maximumAggregateBytes + KNOWLEDGE_LIMITS.maximumMetadataBytes,
    recordBytes: 0,
  },
};

const artifactStoreProfile: FileStoreBackendProfile = {
  reasonCodes: {
    pathInvalid: "ARTIFACT_PATH_INVALID",
    linkUnsafe: "ARTIFACT_LINK_UNSAFE",
    specialFile: "ARTIFACT_SPECIAL_FILE",
    limitExceeded: "ARTIFACT_LIMIT_EXCEEDED",
    sourceChanged: "ARTIFACT_SOURCE_CHANGED",
    alreadyExists: "ARTIFACT_RESTORE_CONFLICT",
  },
  limits: {
    markerBytes: 16_384,
    metadataBytes: 0,
    bodyBytes: 0,
    viewBytes: 0,
    recordBytes: ARTIFACT_LIMITS.maximumSourceBytes,
  },
};

// An absent store reports a "missing" reason code from its marker read: the
// file backends raise *_PATH_INVALID on a missing store.json, and the PG store
// backend raises KNOWLEDGE_RECORD_INVALID on a missing marker row.
const ABSENT_STORE_REASON_CODES = new Set<string>([
  "KNOWLEDGE_PATH_INVALID",
  "ARTIFACT_PATH_INVALID",
  "KNOWLEDGE_RECORD_INVALID",
]);

function isAbsentStoreError(error: unknown): boolean {
  return error instanceof StoreBackendError && ABSENT_STORE_REASON_CODES.has(error.reasonCode);
}

function opposite(direction: MigrationDirection): MigrationDirection {
  return direction === "pg" ? "file" : "pg";
}

function assertDirection(value: MigrationDirection): asserts value is MigrationDirection {
  if (value !== "file" && value !== "pg") {
    throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_INVALID", `target must be "file" or "pg"`);
  }
}

function assertTargetSchema(target: MigrationDirection, options: MigrationOptions): void {
  if (target === "pg" && (typeof options.schema !== "string" || options.schema.trim().length === 0)) {
    throw new WorkspaceMigrationError(
      "WORKSPACE_MIGRATION_INVALID",
      "target pg requires a named schema; refusing to copy without a storage-home binding",
    );
  }
}

function assertMigrationInstant(options: MigrationOptions): void {
  // The migration lease uses the caller-stamped instant as its clock. The old
  // epoch fallback made every lease immediately expired against a real clock,
  // so a missing stamp must be rejected before any target or lease mutation.
  if (typeof options.migratedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/u.test(options.migratedAt)) {
    throw new WorkspaceMigrationError(
      "WORKSPACE_MIGRATION_INVALID",
      "migration requires migratedAt as a strict UTC instant; refusing to use an expired epoch lease",
    );
  }
}

function resolveBackend(side: MigrationDirection, options: MigrationOptions, root: string): StorageBackend {
  if (side === "pg" && options.backend !== undefined) {
    return options.backend(root);
  }
  return new FileBackend(root);
}

function resolveStoreBackend(
  side: MigrationDirection,
  options: MigrationOptions,
  root: string,
  storeSubpath: string,
  profile: FileStoreBackendProfile,
): StoreBackend {
  if (side === "pg" && options.storeBackend !== undefined) {
    return options.storeBackend(root);
  }
  return new FileStoreBackend(resolve(root, storeSubpath), profile);
}

function parseMetadata(metadataBytes: Buffer): { readonly workspaceId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataBytes.toString("utf8"));
  } catch {
    throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_INVALID", "workspace metadata is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_INVALID", "workspace metadata is not an object");
  }
  const workspaceId = (parsed as { readonly workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_INVALID", "workspace metadata has no workspaceId");
  }
  return { workspaceId };
}

function parseSegments(segments: readonly MigratedSegment[]): { readonly version: number; readonly headEventHash: string | null } {
  const events: Array<{ readonly sequence: number; readonly eventHash: string | null }> = [];
  for (const segment of segments) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(segment.bytes.toString("utf8"));
    } catch {
      throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_INVALID", `event segment ${segment.name} is not valid JSON`);
    }
    if (!Array.isArray(parsed)) {
      throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_INVALID", `event segment ${segment.name} is not an array`);
    }
    for (const event of parsed) {
      const record = event as { readonly sequence?: unknown; readonly eventHash?: unknown };
      if (typeof record.sequence !== "number" || !Number.isSafeInteger(record.sequence)) {
        throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_INVALID", `event segment ${segment.name} has a non-integer sequence`);
      }
      events.push({ sequence: record.sequence, eventHash: typeof record.eventHash === "string" ? record.eventHash : null });
    }
  }
  // Version continuity: sequences must run 1..N without gaps or reorderings.
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) {
      throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_INVALID", `event sequence ${String(event.sequence)} is not contiguous`);
    }
  }
  const last = events[events.length - 1];
  return { version: events.length, headEventHash: last === undefined ? null : last.eventHash };
}

async function readKnowledgeStore(store: StoreBackend): Promise<MigratedKnowledgeStore | null> {
  let marker: Buffer;
  try {
    marker = await store.readKnowledgeMarker();
  } catch (error) {
    if (isAbsentStoreError(error)) return null;
    throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_INVALID", `knowledge marker is unreadable: ${String((error as { message?: string }).message ?? error)}`);
  }
  const metadata: MigratedRecord[] = [];
  for (const name of await store.listKnowledgeMetadata()) {
    const id = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
    metadata.push({ id, bytes: await store.readKnowledgeMetadata(id) });
  }
  const bodies: MigratedRecord[] = [];
  for (const name of await store.listKnowledgeBodies()) {
    const id = name.endsWith(".body") ? name.slice(0, -".body".length) : name;
    bodies.push({ id, bytes: await store.readKnowledgeBody(id) });
  }
  const view = await store.readKnowledgeView();
  return { marker, metadata: sortRecords(metadata), bodies: sortRecords(bodies), view };
}

async function readArtifactStore(store: StoreBackend): Promise<MigratedArtifactStore | null> {
  let marker: Buffer;
  try {
    marker = await store.readArtifactMarker();
  } catch (error) {
    if (isAbsentStoreError(error)) return null;
    throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_INVALID", `artifact marker is unreadable: ${String((error as { message?: string }).message ?? error)}`);
  }
  const records: MigratedRecord[] = [];
  for (const name of await store.listArtifactRecords()) {
    const id = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
    records.push({ id, bytes: await store.readArtifactRecord(id) });
  }
  return { marker, records: sortRecords(records) };
}

function sortRecords(records: readonly MigratedRecord[]): readonly MigratedRecord[] {
  return [...records].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

async function readSnapshot(backend: StorageBackend, knowledgeStore: StoreBackend, artifactStore: StoreBackend): Promise<WorkspaceSnapshot> {
  const metadataBytes = await backend.readMetadataBytes();
  const { workspaceId } = parseMetadata(metadataBytes);
  const names = await backend.listSegmentNames();
  const segments: MigratedSegment[] = [];
  for (const name of names) {
    segments.push({ name, bytes: await backend.readSegment(name) });
  }
  const { version, headEventHash } = parseSegments(segments);
  // INC-085/ADR-0004 §9 criterion 4: the derived views are part of the data
  // plane. They are migrated and compared like the events, so a migration whose
  // target then answers WORKSPACE_VIEW_STALE (validate 4/5 red during INIT-020)
  // is a migration defect, not a post-hoc repair.
  const views: MigratedView[] = [];
  for (const name of await backend.listViewNames()) {
    views.push({ name, bytes: await backend.readView(name) });
  }
  const knowledge = await readKnowledgeStore(knowledgeStore);
  const artifact = await readArtifactStore(artifactStore);
  return { workspaceId, metadataBytes, segments, version, headEventHash, views, knowledge, artifact };
}

// An empty target reports its "missing" signal through a reason code that also
// covers real corruption, so the probe distinguishes the two by message: the
// file backend annotates a missing file with ENOENT, and the PG backend reports
// a missing metadata row as "metadata row missing". Only those two are treated
// as absent; anything else is a present-but-unreadable target and is refused.
function isAbsentTargetError(error: unknown): boolean {
  if (!(error instanceof StorageError)) return false;
  const message = error.message;
  return message.includes("ENOENT") || message.includes("metadata row missing");
}

function isApplyUnavailableError(error: unknown): boolean {
  return error instanceof StorageError && error.reasonCode === "WORKSPACE_MIGRATION_APPLY_UNAVAILABLE";
}

async function probeTarget(backend: StorageBackend): Promise<TargetProbe> {
  let names: string[];
  try {
    names = await backend.listSegmentNames();
  } catch (error) {
    if (isApplyUnavailableError(error)) throw error;
    if (isAbsentTargetError(error)) {
      return { present: false, workspaceId: null, version: null, headEventHash: null };
    }
    throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_FUTURE", `target event enumeration failed: ${String((error as { message?: string }).message ?? error)}`);
  }
  if (names.length === 0) {
    // No segments. A workspace that was initialized but never mutated still has
    // a metadata row, so a readable metadata means a present (empty) target;
    // a missing one means the target was never written.
    try {
      const metadataBytes = await backend.readMetadataBytes();
      const { workspaceId } = parseMetadata(metadataBytes);
      return { present: true, workspaceId, version: 0, headEventHash: null };
    } catch (error) {
      if (isApplyUnavailableError(error)) throw error;
      if (isAbsentTargetError(error)) {
        return { present: false, workspaceId: null, version: null, headEventHash: null };
      }
      throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_FUTURE", `target is present but its metadata is unreadable: ${String((error as { message?: string }).message ?? error)}`);
    }
  }
  try {
    const metadataBytes = await backend.readMetadataBytes();
    const { workspaceId } = parseMetadata(metadataBytes);
    const segments: MigratedSegment[] = [];
    for (const name of names) {
      segments.push({ name, bytes: await backend.readSegment(name) });
    }
    const { version, headEventHash } = parseSegments(segments);
    return { present: true, workspaceId, version, headEventHash };
  } catch (error) {
    if (isApplyUnavailableError(error)) throw error;
    throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_FUTURE", `target is present but unreadable: ${String((error as { message?: string }).message ?? error)}`);
  }
}

async function ensureTargetTree(backend: StorageBackend, knowledgePresent: boolean, artifactPresent: boolean): Promise<void> {
  await backend.ensureControlDirectory("");
  await backend.ensureControlDirectory("events");
  if (knowledgePresent) {
    await backend.ensureControlDirectory("knowledge");
    await backend.ensureControlDirectory("knowledge/metadata");
    await backend.ensureControlDirectory("knowledge/bodies");
    await backend.ensureControlDirectory("knowledge/views");
  }
  if (artifactPresent) {
    await backend.ensureControlDirectory("artifacts");
    await backend.ensureControlDirectory("artifacts/records");
    await backend.ensureControlDirectory("artifacts/transient");
    await backend.ensureControlDirectory("artifacts/transient/receipts");
    await backend.ensureControlDirectory("artifacts/transient/cache");
    await backend.ensureControlDirectory("artifacts/archives");
  }
}

async function writeKnowledgeStore(target: StoreBackend, knowledge: MigratedKnowledgeStore): Promise<void> {
  await target.writeKnowledgeMarker(knowledge.marker);
  for (const record of knowledge.metadata) {
    await target.writeKnowledgeMetadata(record.id, record.bytes);
  }
  for (const record of knowledge.bodies) {
    await target.writeKnowledgeBody(record.id, record.bytes);
  }
  await target.writeKnowledgeView(knowledge.view);
}

async function writeArtifactStore(target: StoreBackend, artifact: MigratedArtifactStore): Promise<void> {
  await target.writeArtifactMarker(artifact.marker);
  for (const record of artifact.records) {
    await target.writeArtifactRecord(record.id, record.bytes);
  }
}

function buildPlan(snapshot: WorkspaceSnapshot, direction: MigrationDirection, source: MigrationDirection): MigrationPlan {
  const steps: string[] = [
    `read workspace metadata and ${String(snapshot.version)} event(s) from the ${source} backend`,
    `write ${String(snapshot.version)} event segment(s) and workspace metadata to the ${direction} backend`,
  ];
  if (snapshot.knowledge !== null) {
    steps.push(`copy knowledge store (${String(snapshot.knowledge.metadata.length)} metadata, ${String(snapshot.knowledge.bodies.length)} bodies, view) to the ${direction} backend`);
  } else {
    steps.push(`skip knowledge store (not initialized on the ${source} backend)`);
  }
  if (snapshot.artifact !== null) {
    steps.push(`copy artifact store (${String(snapshot.artifact.records.length)} records) to the ${direction} backend`);
  } else {
    steps.push(`skip artifact store (not initialized on the ${source} backend)`);
  }
  return {
    schemaVersion: "tcrn.workspace-migration-plan.v1",
    direction,
    source,
    eventCount: snapshot.version,
    workspaceId: snapshot.workspaceId,
    version: snapshot.version,
    headEventHash: snapshot.headEventHash,
    steps,
  };
}

function recordsEqual(left: readonly MigratedRecord[], right: readonly MigratedRecord[]): boolean {
  if (left.length !== right.length) return false;
  for (const [index, record] of left.entries()) {
    const other = right[index];
    if (other === undefined || other.id !== record.id || !record.bytes.equals(other.bytes)) return false;
  }
  return true;
}

// Returns the failing reason code, or null when the two snapshots are
// byte-equivalent on every criterion the STORY-176 gate checks.
//
// Event comparison is PER-EVENT, not per-segment: the file backend segments by
// the workspace's segmentEventLimit (typically 64) while the PG backend uses a
// different limit, so the SAME event history lands in different segment
// layouts. Comparing segment bytes would make verify red on any chain with more
// than one file segment — a layout difference, not a data difference (the
// STORY-189 window hit exactly this on Joi-Button v586: 586/586 events
// byte-identical, verify red on segment shape). The criterion is per-event byte
// equivalence; segment boundaries are an implementation detail.
function compareSnapshots(source: WorkspaceSnapshot, target: WorkspaceSnapshot): string | null {
  if (source.workspaceId !== target.workspaceId || source.version !== target.version || source.headEventHash !== target.headEventHash) {
    return "WORKSPACE_MIGRATION_VERIFY_MISMATCH";
  }
  if (!source.metadataBytes.equals(target.metadataBytes)) {
    return "WORKSPACE_MIGRATION_VERIFY_MISMATCH";
  }
  const sourceEvents = flattenEvents(source.segments);
  const targetEvents = flattenEvents(target.segments);
  if (sourceEvents.length !== targetEvents.length) {
    return "WORKSPACE_MIGRATION_VERIFY_MISMATCH";
  }
  for (const [index, event] of sourceEvents.entries()) {
    if (event !== targetEvents[index]) {
      return "WORKSPACE_MIGRATION_VERIFY_MISMATCH";
    }
  }
  if (source.knowledge === null && target.knowledge !== null) return "WORKSPACE_MIGRATION_VERIFY_STORE_MISMATCH";
  if (source.knowledge !== null && target.knowledge === null) return "WORKSPACE_MIGRATION_VERIFY_STORE_MISMATCH";
  if (source.knowledge !== null && target.knowledge !== null) {
    if (!source.knowledge.marker.equals(target.knowledge.marker) || !source.knowledge.view.equals(target.knowledge.view) ||
      !recordsEqual(source.knowledge.metadata, target.knowledge.metadata) || !recordsEqual(source.knowledge.bodies, target.knowledge.bodies)) {
      return "WORKSPACE_MIGRATION_VERIFY_STORE_MISMATCH";
    }
  }
  if (source.artifact === null && target.artifact !== null) return "WORKSPACE_MIGRATION_VERIFY_STORE_MISMATCH";
  if (source.artifact !== null && target.artifact === null) return "WORKSPACE_MIGRATION_VERIFY_STORE_MISMATCH";
  if (source.artifact !== null && target.artifact !== null) {
    if (!source.artifact.marker.equals(target.artifact.marker) || !recordsEqual(source.artifact.records, target.artifact.records)) {
      return "WORKSPACE_MIGRATION_VERIFY_STORE_MISMATCH";
    }
  }
  // INC-085/ADR-0004 §9 criterion 4: the derived views must be byte-identical
  // across backends at the same head. A migration that left the target's views
  // empty or stale reds here instead of passing verify and failing validate.
  if (!viewsEqual(source.views, target.views)) {
    return "WORKSPACE_MIGRATION_VERIFY_MISMATCH";
  }
  return null;
}

function viewsEqual(left: readonly MigratedView[], right: readonly MigratedView[]): boolean {
  // FileBackend and PgBackend are both allowed to choose their own enumeration
  // order.  In particular, the file track's directory order puts `STATUS.md`
  // before lower-case names while PostgreSQL's collation places it after them.
  // The equivalence criterion is the view name + bytes, not backend collation;
  // compare a canonical name order so a healthy migration cannot red merely
  // because the two stores enumerate the same four views differently.
  const sortByName = (views: readonly MigratedView[]) => [...views].sort((leftView, rightView) =>
    leftView.name < rightView.name ? -1 : leftView.name > rightView.name ? 1 : 0);
  const orderedLeft = sortByName(left);
  const orderedRight = sortByName(right);
  if (orderedLeft.length !== orderedRight.length) return false;
  for (const [index, view] of orderedLeft.entries()) {
    const other = orderedRight[index];
    if (other === undefined || other.name !== view.name || !view.bytes.equals(other.bytes)) return false;
  }
  return true;
}

// Flatten a snapshot's segment bytes (each a canonical JSON array of events)
// into an ordered list of per-event canonical bytes. Segment layout is
// backend-dependent; the event stream is the invariant. Each event is the
// canonical JSON of its full record (schemaVersion/id/streamId/sequence/
// occurredAt/priorHash/payload/payloadHash/eventHash), so two events serialize
// to identical bytes — and only then — when every field matches, regardless of
// how their segment array was grouped. Comparing stored eventHash alone would
// miss a target whose payload/payloadHash was tampered but whose eventHash was
// left stale (the PG backend reads eventHash as stored, not recomputed), so the
// per-event comparison is over the canonical event, not a single stored field.
function flattenEvents(segments: readonly { readonly name: string; readonly bytes: Buffer }[]): readonly string[] {
  const events: { readonly sequence: number; readonly canonical: string }[] = [];
  for (const segment of segments) {
    const parsed = JSON.parse(segment.bytes.toString("utf8")) as readonly { readonly sequence: number }[];
    for (const event of parsed) {
      events.push({ sequence: event.sequence, canonical: canonicalJson(event) });
    }
  }
  events.sort((left, right) => left.sequence - right.sequence);
  return events.map((event) => event.canonical);
}

// INC-085: resume safety. A target that is a strict prefix of the source is a
// half-finished migration (each PG segment commits in its own transaction, so an
// interruption leaves complete prefix segments). Resuming is safe ONLY when the
// existing target events are a byte-prefix of the source — otherwise the
// idempotent upsert below would silently overwrite divergent events, which is the
// bypass-copy defect WORKSPACE_MIGRATION_FUTURE exists to refuse.
async function assertTargetIsPrefix(
  snapshot: WorkspaceSnapshot,
  targetBackend: StorageBackend,
  target: MigrationDirection,
  options: MigrationOptions,
  workspaceRoot: string,
): Promise<void> {
  let targetSnapshot: WorkspaceSnapshot;
  try {
    targetSnapshot = await readSnapshot(
      targetBackend,
      resolveStoreBackend(target, options, workspaceRoot, `${WORKSPACE_CONTROL_DIRECTORY}/knowledge`, knowledgeStoreProfile),
      resolveStoreBackend(target, options, workspaceRoot, `${WORKSPACE_CONTROL_DIRECTORY}/artifacts`, artifactStoreProfile),
    );
  } catch (error) {
    throw new WorkspaceMigrationError(
      "WORKSPACE_MIGRATION_FUTURE",
      `target prefix is unreadable; resume refused: ${String((error as { message?: string }).message ?? error)}`,
    );
  }
  if (targetSnapshot.workspaceId !== snapshot.workspaceId) {
    throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_FUTURE", "target prefix has a different workspace identity");
  }
  const sourceEvents = flattenEvents(snapshot.segments);
  const targetEvents = flattenEvents(targetSnapshot.segments);
  if (targetEvents.length > sourceEvents.length) {
    throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_FUTURE", "target prefix is longer than the source");
  }
  for (const [index, event] of targetEvents.entries()) {
    if (event !== sourceEvents[index]) {
      throw new WorkspaceMigrationError("WORKSPACE_MIGRATION_FUTURE", "target prefix diverges from the source; bypass copy refused");
    }
  }
}

export async function planMigration(
  workspaceRoot: string,
  target: MigrationDirection,
  options: MigrationOptions = {},
): Promise<MigrationPlan> {
  assertDirection(target);
  assertTargetSchema(target, options);
  const source = opposite(target);
  const backend = resolveBackend(source, options, workspaceRoot);
  const snapshot = await readSnapshot(
    backend,
    resolveStoreBackend(source, options, workspaceRoot, `${WORKSPACE_CONTROL_DIRECTORY}/knowledge`, knowledgeStoreProfile),
    resolveStoreBackend(source, options, workspaceRoot, `${WORKSPACE_CONTROL_DIRECTORY}/artifacts`, artifactStoreProfile),
  );
  return buildPlan(snapshot, target, source);
}

export async function executeMigration(
  workspaceRoot: string,
  target: MigrationDirection,
  options: MigrationOptions = {},
): Promise<MigrationPlan> {
  assertDirection(target);
  // Validate before acquiring a lease or touching the target. A missing schema
  // used to let the data copy complete while silently omitting the sentinel,
  // reopening the exact file/PG fork this migration is meant to close.
  assertTargetSchema(target, options);
  assertMigrationInstant(options);
  const source = opposite(target);
  // INC-074: migration is itself a governed mutation. Hold the archive-side
  // lease across the source snapshot, target writes, and sentinel change so
  // another process cannot observe a half-migrated binding or remove the
  // declaration out from under the copy. The explicit admission is private to
  // this verb; normal file-backed mutations remain sentinel-closed.
  const lease = await acquireWorkspaceLease(workspaceRoot, {
    now: options.migratedAt as string,
    storageHomeAdmission: "migration",
  });
  try {
    const sourceBackend = resolveBackend(source, options, workspaceRoot);
    const snapshot = await readSnapshot(
      sourceBackend,
      resolveStoreBackend(source, options, workspaceRoot, `${WORKSPACE_CONTROL_DIRECTORY}/knowledge`, knowledgeStoreProfile),
      resolveStoreBackend(source, options, workspaceRoot, `${WORKSPACE_CONTROL_DIRECTORY}/artifacts`, artifactStoreProfile),
    );
    const targetBackend = resolveBackend(target, options, workspaceRoot);
    const probe = await probeTarget(targetBackend);
    if (probe.present &&
      (probe.workspaceId !== snapshot.workspaceId ||
        // INC-085: a target that has ADVANCED beyond the source is a genuine fork —
        // refused as before. A target that is a strict prefix of the source is a
        // half-finished migration: a differing prefix head is expected, and
        // resuming is safe ONLY after proving the existing target events are a
        // byte-prefix of the source (the upsert below would otherwise overwrite
        // divergent events). This is the recovery path a segment-per-transaction
        // interruption previously had no verb for.
        probe.version === null ||
        probe.version > snapshot.version ||
        (probe.version === snapshot.version && probe.headEventHash !== snapshot.headEventHash))) {
      throw new WorkspaceMigrationError(
        "WORKSPACE_MIGRATION_FUTURE",
        "target already holds a workspace that does not match the source; bypass copy refused",
      );
    }
    if (probe.present && probe.version !== null && probe.version < snapshot.version) {
      await assertTargetIsPrefix(snapshot, targetBackend, target, options, workspaceRoot);
    }
    await ensureTargetTree(targetBackend, snapshot.knowledge !== null, snapshot.artifact !== null);
    for (const segment of snapshot.segments) {
      await targetBackend.writeSegment(segment.name, segment.bytes);
    }
    await targetBackend.writeMetadataBytes(snapshot.metadataBytes);
    for (const view of snapshot.views) {
      await targetBackend.writeView(view.name, view.bytes.toString("utf8"));
    }
    if (snapshot.knowledge !== null) {
      await writeKnowledgeStore(
        resolveStoreBackend(target, options, workspaceRoot, `${WORKSPACE_CONTROL_DIRECTORY}/knowledge`, knowledgeStoreProfile),
        snapshot.knowledge,
      );
    }
    if (snapshot.artifact !== null) {
      await writeArtifactStore(
        resolveStoreBackend(target, options, workspaceRoot, `${WORKSPACE_CONTROL_DIRECTORY}/artifacts`, artifactStoreProfile),
        snapshot.artifact,
      );
    }
    // INC-074: lay or lift the storage-home sentinel. Both operations occur
    // while the migration lease is held; a normal file-backed caller still
    // refuses a PG sentinel and cannot reopen the write door.
    if (target === "pg") {
      const declaration = {
        schemaVersion: STORAGE_HOME_VERSION,
        storage: "pg",
        schema: options.schema as string,
        workspaceId: snapshot.workspaceId,
        migratedAt: options.migratedAt as string,
      } as const;
      await writeStorageHomeDeclaration(workspaceRoot, declaration);
      const written = await readStorageHomeDeclaration(workspaceRoot);
      if (written === null || canonicalJson(written) !== canonicalJson(declaration)) {
        throw new WorkspaceMigrationError(
          "WORKSPACE_MIGRATION_VERIFY_MISMATCH",
          "storage-home sentinel did not survive the migration write read-back",
        );
      }
    } else if (target === "file") {
      await removeStorageHomeDeclaration(workspaceRoot);
    }
    return buildPlan(snapshot, target, source);
  } finally {
    await lease.release();
  }
}

export async function verifyMigration(
  workspaceRoot: string,
  target: MigrationDirection,
  options: MigrationOptions = {},
): Promise<MigrationVerification> {
  assertDirection(target);
  assertTargetSchema(target, options);
  const source = opposite(target);
  const sourceBackend = resolveBackend(source, options, workspaceRoot);
  const snapshot = await readSnapshot(
    sourceBackend,
    resolveStoreBackend(source, options, workspaceRoot, `${WORKSPACE_CONTROL_DIRECTORY}/knowledge`, knowledgeStoreProfile),
    resolveStoreBackend(source, options, workspaceRoot, `${WORKSPACE_CONTROL_DIRECTORY}/artifacts`, artifactStoreProfile),
  );
  const targetBackend = resolveBackend(target, options, workspaceRoot);
  const probe = await probeTarget(targetBackend);
  if (probe.present &&
    (probe.workspaceId !== snapshot.workspaceId || probe.version !== snapshot.version || probe.headEventHash !== snapshot.headEventHash)) {
    throw new WorkspaceMigrationError(
      "WORKSPACE_MIGRATION_FUTURE",
      "target holds a workspace that does not match the source; bypass copy refused",
    );
  }
  if (!probe.present) {
    return { ok: false, reasonCode: "WORKSPACE_MIGRATION_NOT_APPLIED", eventCount: snapshot.version, headEventHash: snapshot.headEventHash };
  }
  let targetSnapshot: WorkspaceSnapshot;
  try {
    targetSnapshot = await readSnapshot(
      targetBackend,
      resolveStoreBackend(target, options, workspaceRoot, `${WORKSPACE_CONTROL_DIRECTORY}/knowledge`, knowledgeStoreProfile),
      resolveStoreBackend(target, options, workspaceRoot, `${WORKSPACE_CONTROL_DIRECTORY}/artifacts`, artifactStoreProfile),
    );
  } catch (error) {
    return {
      ok: false,
      reasonCode: error instanceof WorkspaceMigrationError ? error.reasonCode : "WORKSPACE_MIGRATION_VERIFY_MISMATCH",
      eventCount: snapshot.version,
      headEventHash: snapshot.headEventHash,
    };
  }
  const mismatch = compareSnapshots(snapshot, targetSnapshot);
  if (mismatch !== null) {
    return { ok: false, reasonCode: mismatch, eventCount: snapshot.version, headEventHash: snapshot.headEventHash };
  }
  return { ok: true, reasonCode: WORKSPACE_MIGRATION_VERIFIED, eventCount: snapshot.version, headEventHash: snapshot.headEventHash };
}

export async function rollbackMigration(
  workspaceRoot: string,
  options: MigrationOptions = {},
): Promise<MigrationPlan> {
  // Rollback is the reverse hop: the side that was migrated to (pg) becomes the
  // source and the file track becomes the target, with the same execute criteria.
  return executeMigration(workspaceRoot, "file", options);
}
