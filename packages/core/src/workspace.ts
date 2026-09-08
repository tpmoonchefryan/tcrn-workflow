// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { deflateSync, inflateSync } from "node:zlib";
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
  WORK_SUMMARY_MAX_BYTES,
  assertCanonicalJson,
  assertProtocolId,
  assertStrictInstant,
  assertWorkTransition,
  canonicalExternalKey,
  canonicalByteLength,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  createEvent,
  deriveStableId,
  isWorkSummary,
  parseStrictInstant,
  validateEventChain,
  validateWorkGraph,
} from "../../protocol/src/index.js";
import type {
  EventRecord,
  ExtensionRegistration,
  JsonValue,
  WorkKind,
  WorkRecord,
  WorkStatus,
} from "../../protocol/src/index.js";
import { assertDistinctRootShape, assertDistinctRoots, rootPortableIdentity } from "./root-identity.js";
import { FileBackend, StorageError } from "./storage-backend.js";
import type { StorageBackend, StorageDirectoryEntry } from "./storage-backend.js";
import { SegmentedBackend } from "./segmented-backend.js";
import { readStorageHomeDeclaration } from "./storage-home.js";
import { consumeQuarantineReplacementTestInstrumentation } from "./workspace-test-instrumentation.js";
import { recordClosureValidation, recordCollectionScan, recordExtensionClosureValidation, recordFullMaterialize, recordSnapshotMaterialize, recordTerminalGraphValidation } from "./workspace-perf-instrumentation.js";
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
  CONFERENCE_EXECUTION_FORMS,
  independenceFloorCovers,
  validateConferenceMinutes,
  validateConferencePosition,
  validateConferenceRequest,
} from "./conference.js";
import { AssignmentGateError, GATE_VERSION, validateGateRecord } from "./assignment-gate.js";
import type { ConferenceMinutes, ConferencePosition, ConferenceRequest } from "./conference.js";
import {
  EMPTY_EXECUTION_CONFIG,
  applyHostConfigDefault,
  applyHostConfigRemove,
  applyHostConfigSet,
  applyLegacyCustomPersonaSet,
  applyCustomPersonaRemove,
  applyCustomPersonaSet,
  applyModelPlanAssignInExecutionConfig,
  applyModelPlanRemoveInExecutionConfig,
  applyModelPlanSetInExecutionConfig,
  applyModelPlanUnassignInExecutionConfig,
  applyPersonaPresetOverrideInExecutionConfig,
  applyPersonaPresetRemoveInExecutionConfig,
  applyPersonaPresetRestoreInExecutionConfig,
  applyPersonaBindingRemove,
  applyPersonaBindingSet,
  assertExecutionHost,
  validateConfigurationName,
  validateModel,
  validateNote,
} from "./execution-config.js";
import type { ExecutionConfigState, ExecutionHost } from "./execution-config.js";
import type { GateRecord } from "./assignment-gate.js";
import { GateIdentityError, gateIdentityDecision, permitsGateOutcome, validateGateIdentityDecision } from "./gate-identity.js";
import type { GateIdentityAuthorityContext, GateIdentityDecision } from "./gate-identity.js";
import type { CanonicalRoot } from "./root-identity.js";
import { FRAMEWORK_VERSION } from "./index.js";
import type { ExplicitRoot } from "./index.js";
import { describeStoryScopeProblems, deriveWorkSummary, storyScopeFromRecord, storyScopeNamesOwnerDecider, validateStoryRecord } from "./story-scope-compliance.js";
import {
  TemplateAdmissionError,
  admitTemplate,
  createTemplateAdmissionRecord,
  templateBindingFromReceipt,
  templateBindingFromWorkRecord,
  templateRecordMatchesBinding,
  templateRecordForBinding,
  templateRegistry,
  validateBoundTemplateWork,
  validateTemplateAdmissionRecord,
  validateTemplateAdmissionReceipt,
} from "./template-admission.js";
import type { TemplateAdmissionRecord } from "./template-admission.js";
import {
  SETTINGS_LAYER_KIND,
  SettingsError,
  compareEngineVersions,
  createWorkspaceSettingRecord,
  settingsCatalogEntry,
  sortWorkspaceSettings,
  validateWorkspaceSettingRecord,
} from "./settings.js";
import type { WorkspaceSettingRecord } from "./settings.js";

export const WORKSPACE_SCHEMA_VERSION = "tcrn.workspace.v1" as const;
export const WORKSPACE_STORAGE_VERSION = 2 as const;
export const WORKSPACE_LEGACY_STORAGE_VERSION = 1 as const;
export const WORKSPACE_SEGMENT_BYTES_DEFAULT = 16_777_216 as const;
export const WORKSPACE_SEGMENT_BYTES_MIN = 4_096 as const;
export const WORKSPACE_SEGMENT_BYTES_MAX = 67_108_864 as const;
export const WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES = 4_194_304 as const;
export const WORKSPACE_CONTROL_DIRECTORY = ".tcrn-workflow" as const;
export const WORKSPACE_REASON_CODES = Object.freeze([
  "WORKSPACE_ACTOR_INVALID",
  "WORKSPACE_ACTOR_REQUIRED",
  "WORKSPACE_ALREADY_EXISTS",
  "WORKSPACE_CAS_MISMATCH",
  "CONFERENCE_INDEPENDENCE_REQUIRED",
  "EXECUTION_PERSONA_IN_USE",
  "EXECUTION_PERSONA_UNKNOWN",
  "MODEL_PLAN_ASSIGNMENT_INVALID",
  "MODEL_PLAN_DEFAULT_MODEL_INVALID",
  "MODEL_PLAN_HOST_UNKNOWN",
  "MODEL_PLAN_IN_USE",
  "MODEL_PLAN_NAME_INVALID",
  "MODEL_PLAN_NOT_FOUND",
  "MODEL_PLAN_PERSONA_UNKNOWN",
  "MODEL_PLAN_RECORD_INVALID",
  "PERSONA_CONTENT_INVALID",
  "PERSONA_DESCRIPTION_INVALID",
  "PERSONA_FIELD_INVALID",
  "PERSONA_NAME_INVALID",
  "PERSONA_NAME_CONFLICT",
  "PERSONA_NOT_FOUND",
  "PERSONA_PRESET_IN_USE",
  "PERSONA_PRESET_NOT_FOUND",
  "PERSONA_PRESET_TOMBSTONED",
  "PERSONA_PROMPT_INVALID",
  "PERSONA_RECORD_INVALID",
  "PERSONA_ROLE_INVALID",
  "WORKSPACE_CONFERENCE_NOT_OPEN",
  "WORKSPACE_EVENT_CORRUPT",
  "WORKSPACE_FAULT_INJECTED",
  "WORKSPACE_FILESYSTEM_UNSUPPORTED",
  "WORKSPACE_ENGINE_VERSION_MISMATCH",
  "WORKSPACE_GATE_EVIDENCE_UNRESOLVED",
  "WORKSPACE_GATE_IDENTITY_REFUSED",
  "WORKSPACE_GATE_IDENTITY_REQUIRED",
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
  "WORKSPACE_STORAGE_MIGRATION_IN_PROGRESS",
  "WORKSPACE_STORAGE_MIGRATION_LIMIT_INVALID",
  "WORKSPACE_STORAGE_MIGRATION_MISMATCH",
  "WORKSPACE_STORAGE_MIGRATION_NOT_APPLIED",
  "WORKSPACE_STORAGE_MIGRATION_VERIFIED",
  "WORKSPACE_PATH_ESCAPE",
  "WORKSPACE_PATH_INVALID",
  "WORKSPACE_RECORD_LIMIT",
  // WSR-1 (relocation): the four STATE codes live here, not in
  // workspace-relocation.ts, because validateMetadata/readMetadata raise them and
  // fail() is typed to WorkspaceReasonCode. Every other relocation code is owned by
  // the relocation module's own frozen list.
  "WORKSPACE_RELOCATION_ADOPTION_REQUIRED",
  "WORKSPACE_RELOCATION_FOREIGN_ADDRESS",
  "WORKSPACE_RELOCATION_LEDGER_INVALID",
  "WORKSPACE_RELOCATION_VACATED",
  "WORKSPACE_SCHEMA_INVALID",
  "WORKSPACE_SNAPSHOT_INVALID",
  // INC-074: a workspace whose chain has been migrated to Postgres carries a
  // storage-home sentinel (`.tcrn-workflow/storage-home.json`). The file backend
  // refuses every mutating verb on such a workspace — the write door is closed, so
  // a caller driving the engine without TCRN_PG_* (the ceremony.mjs fork mechanism)
  // can no longer fork the chain. Read-only verbs stay open so the tree remains a
  // forensible archive. Named here because acquireWorkspaceLease raises it and
  // fail() is typed to WorkspaceReasonCode.
  "WORKSPACE_STORAGE_RELOCATED",
  "WORKSPACE_STORY_SCOPE_REQUIRED",
  "WORKSPACE_STORY_SCOPE_INVALID",
  "WORKSPACE_OWNER_ACCEPTANCE_REQUIRED",
  "WORKSPACE_VIEW_STALE",
  // STORY-299. Two codes, two different moments, deliberately not one code.
  // BUDGET_EXCEEDED is raised while nothing has been written: the projection was
  // measured before the segment was committed and does not fit, so the command
  // fails with the chain untouched and must not be retried unchanged.
  // UNWRITTEN is the opposite case and never appears as a command's reason code:
  // the fact is committed and durable, only the derived view could not be
  // persisted. It rides on a successful receipt so the caller learns the truth
  // without being told its write failed -- the defect INC-198 recorded.
  "WORKSPACE_VIEW_BUDGET_EXCEEDED",
  "WORKSPACE_VIEW_UNWRITTEN",
  // STORY-300 slice 3: a batch is refused for its shape before any state is consulted,
  // or by the first member that fails against accumulated state. The two are separate
  // codes because they answer different questions about whose fault it is.
  "WORK_BATCH_MALFORMED",
  "WORK_BATCH_REFUSED",
] as const);

export type WorkspaceReasonCode = typeof WORKSPACE_REASON_CODES[number];
export type WorkspaceCrashPoint =
  | "before-write"
  | "after-temp-sync"
  | "after-event-commit"
  | "before-view-commit";

export class WorkspaceError extends Error {
  readonly reasonCode: WorkspaceReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: WorkspaceReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "WorkspaceError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

// WSR-1: the relocation ledger. An APPEND-ONLY record of address rebindings that
// travels inside the control tree it describes. It is a TENTH, OPTIONAL metadata
// field: absent on every workspace that never relocates, so those files stay
// byte-identical to 0.8.0 (see the T25 byte-neutrality proof). Absent, not empty —
// emitting `relocations: []` unconditionally would change every existing
// workspace.json digest and turn an additive change into a migration.
export const WORKSPACE_RELOCATION_ENTRY_VERSION = "tcrn.workspace-relocation.v1" as const;
export const WORKSPACE_RELOCATION_IDENTITY_VERSION = "tcrn.workspace-relocation-identity.v1" as const;
// OD-B (Owner ruling): sixteen. A workspace that has moved house sixteen times has
// an operational problem a cap does not fix, and each entry carries ten root paths
// in a file that is re-read on EVERY workspace operation. Picked deliberately so it
// does not become an accidental constant.
export const WORKSPACE_RELOCATION_LEDGER_LIMIT = 16 as const;

export type WorkspaceRelocationStage = "vacated" | "adopted" | "aborted";

export interface WorkspaceRelocationBasis {
  readonly controlManifestSha256: string;
  readonly headEventHash: string | null;
  readonly version: number;
}

export interface WorkspaceRelocationAuthorityRecord {
  readonly actorId: string;
  readonly authorityFileSha256: string;
}

export interface WorkspaceRelocationEntry {
  readonly schemaVersion: typeof WORKSPACE_RELOCATION_ENTRY_VERSION;
  readonly sequence: number;
  readonly relocationId: string;
  readonly stage: WorkspaceRelocationStage;
  readonly at: string;
  readonly from: readonly CanonicalRoot[];
  readonly to: readonly CanonicalRoot[];
  readonly basis: WorkspaceRelocationBasis;
  readonly authority: WorkspaceRelocationAuthorityRecord;
}

// The three-state discriminator plus the ordinary case. Computed from ONE file and
// the address the reader is standing at — no network, no registry, no side channel.
export type WorkspaceRelocationState =
  | "live"
  | "vacated"
  | "adoption-required"
  | "foreign-address";

// Admission modes for readMetadata. The DEFAULT MUST be the strict value: a
// permissive default breaks nothing visible and silently disables the whole
// mechanism, which is why guard G1 exists and why T4 asserts the default refuses.
export type WorkspaceAdmission = "live" | "adoption" | "abort" | "any";

export interface WorkspaceMetadata {
  readonly schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  readonly storageVersion: 1 | 2;
  readonly minimumStorageVersion: 1;
  readonly maximumStorageVersion: 1 | 2;
  readonly workspaceId: string;
  readonly externalKey: string;
  readonly createdAt: string;
  readonly segmentEventLimit: number;
  readonly roots: readonly CanonicalRoot[];
  readonly relocations?: readonly WorkspaceRelocationEntry[];
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
  readonly settings: readonly WorkspaceSettingRecord[];
  readonly executionConfig: ExecutionConfigState;
  readonly templates: readonly TemplateAdmissionRecord[];
  readonly events: readonly EventRecord[];
  // WSE-2: the sequence of the attestation.actor.enabled event once one has been
  // replayed, else null. From this sequence onward (the enabling event itself
  // included), every mutation payload MUST carry a valid actor; before it, and
  // for every workspace that never enables attestation, actor stays absent and
  // the derived state and export bytes are byte-identical to rc.4.
  readonly attestationEnabledAtSequence: number | null;
}

// STORY-337: this is a read-path replay checkpoint, not the backup snapshot
// manifest owned by workspace-snapshot.ts. It contains the reducer's derived
// collections at one event boundary and never replaces the append-only event
// history. The event prefix is supplied by the event reader when the public
// WorkspaceState is assembled, so callers keep the existing state shape.
const WORKSPACE_REPLAY_SNAPSHOT_VERSION = "tcrn.workspace-replay-snapshot.v1" as const;
const WORKSPACE_REPLAY_SNAPSHOT_MANIFEST_VERSION = "tcrn.workspace-replay-snapshot-manifest.v1" as const;
const WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY = "snapshots" as const;
const WORKSPACE_REPLAY_SNAPSHOT_MANIFEST = "manifest.json" as const;
const WORKSPACE_REPLAY_SNAPSHOT_INTERVAL_DEFAULT = 512 as const;
const WORKSPACE_REPLAY_SNAPSHOT_INTERVAL_MIN = 1 as const;
const WORKSPACE_REPLAY_SNAPSHOT_INTERVAL_MAX = 20_000 as const;

interface ReplaySnapshotState {
  readonly schemaVersion: typeof WORKSPACE_REPLAY_SNAPSHOT_VERSION;
  readonly metadata: WorkspaceMetadata;
  readonly version: number;
  readonly headEventHash: string | null;
  readonly projects: readonly ProjectRecord[];
  readonly work: readonly WorkRecord[];
  readonly conferences: readonly ConferenceRequest[];
  readonly conferencePositions: readonly ConferencePosition[];
  readonly conferenceMinutes: readonly ConferenceMinutes[];
  readonly gates: readonly GateRecord[];
  readonly settings: readonly WorkspaceSettingRecord[];
  readonly executionConfig: ExecutionConfigState;
  readonly templates: readonly TemplateAdmissionRecord[];
  readonly attestationEnabledAtSequence: number | null;
  readonly stateDigest: string;
}

interface ReplaySnapshotSegmentDigest {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface ReplaySnapshotManifest {
  readonly schemaVersion: typeof WORKSPACE_REPLAY_SNAPSHOT_MANIFEST_VERSION;
  readonly workspaceId: string;
  readonly version: number;
  readonly headEventHash: string | null;
  readonly snapshot?: string;
  readonly snapshotParts?: readonly string[];
  readonly stateDigest: string;
  readonly eventPrefixDigest?: string;
  readonly segments: readonly ReplaySnapshotSegmentDigest[];
}

interface ReplaySnapshotSeed extends ReplaySnapshotState {
  readonly manifest: ReplaySnapshotManifest;
  readonly prefixEvents: readonly EventRecord[];
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
  // STORY-299: a test-facing knob for the pre-commit view budget, the same shape
  // and the same purpose as crashAt above. It only ever narrows -- a caller cannot
  // raise the protocol ceiling with it -- so the refusal it exercises is the same
  // refusal a real chain gets, reachable without first building a chain large
  // enough to fill a megabyte.
  readonly viewBudgetBytes?: number;
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
  readonly applyAvailable: boolean;
  readonly basisDigest: string;
}

export interface WorkspaceStorageMigrationResult {
  readonly schemaVersion: "tcrn.workspace-storage-migration.v1";
  readonly reasonCode: "WORKSPACE_STORAGE_MIGRATION_VERIFIED";
  readonly ok: true;
  readonly fromVersion: 1;
  readonly toVersion: 2;
  readonly workspaceId: string;
  readonly eventCount: number;
  readonly headEventHash: string | null;
  readonly segmentBytes: number;
  readonly segmentCount: number;
  readonly stateDigest: string;
}

export interface WorkspaceStorageMigrationVerification {
  readonly schemaVersion: "tcrn.workspace-storage-migration-verify.v1";
  readonly ok: boolean;
  readonly reasonCode: string;
  readonly fromVersion: 1;
  readonly toVersion: 2;
  readonly workspaceId: string;
  readonly eventCount: number;
  readonly headEventHash: string | null;
  readonly segmentBytes: number | null;
  readonly segmentCount: number;
  readonly stateDigest: string | null;
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
// work.annotated (E05): an additive operation that attaches non-binding advisory
// extensions to a live work record without changing its status. It follows the WSD-1
// contract -- a workspace that uses it is unreadable by a binary predating it, while
// workspaces that never annotate stay fully readable and storageVersion stays 1.
const workOperations = new Set(["work.created", "work.updated", "work.deleted", "work.annotated"]);
// WSD-1: conference/gate records persist as additive event-log operations. A
// workspace that contains one of these events is unreadable by pre-WSD-1
// binaries (they fail closed at the unknown-operation check below); workspaces
// that never use them stay fully readable, and storageVersion stays 1.
const conferenceOperations = new Set(["conference.created", "conference.updated", "conference.position.appended", "conference.closed"]);
const gateOperations = new Set(["gate.created", "gate.updated", "gate.deleted"]);
const settingsOperations = new Set(["settings.updated", "settings.removed"]);
const executionOperations = new Set([
  "execution.configuration.set",
  "execution.configuration.removed",
  "execution.default.set",
  "execution.binding.set",
  "execution.binding.removed",
  "execution.persona.set",
  "execution.persona.removed",
  "execution.model-plan.set",
  "execution.model-plan.assigned",
  "execution.model-plan.unassigned",
  "execution.model-plan.removed",
  "execution.persona-preset.override",
  "execution.persona-preset.restore",
  "execution.persona-preset.removed",
]);
const templateOperations = new Set(["template.admitted"]);
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
// WSR-1: the ten-field form. Kept as a second closed list rather than making
// `relocations` optional inside exactFields, so a workspace that carries the field
// is checked just as exactly as one that does not — an "optional" arm inside the
// exactness check is how a closed schema stops being closed.
const metadataFieldsWithRelocations = [...metadataFields, "relocations"];
const relocationEntryFields = ["schemaVersion", "sequence", "relocationId", "stage", "at", "from", "to", "basis", "authority"];
const relocationBasisFields = ["controlManifestSha256", "headEventHash", "version"];
const relocationAuthorityFields = ["actorId", "authorityFileSha256"];
const relocationStages = new Set<string>(["vacated", "adopted", "aborted"]);
// f8: the metadata root order. resolveWorkspace compares INDEX-WISE, so every
// relocation `from`/`to` array must preserve it exactly.
const relocationRootKindOrder = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];

// STORY-174: the data-plane IO rides through a StorageBackend. The file backend
// is the converged implementation of the four former private helpers
// (boundDirectory/boundFile/ensureDirectory/atomicWrite); its temporary-sequence
// counter must persist across consecutive atomicWrites in one process, so one
// instance is cached per workspace root.
const fileBackends = new Map<string, FileBackend>();
const segmentedBackends = new Map<string, SegmentedBackend>();

// STORY-176: a package-private backend-factory override so the equivalence gate
// can run the SAME engine verbs against the PG backend and compare byte output
// to the file backend. Scope is one async operation (AsyncLocalStorage), like
// workspace-test-instrumentation; production callers never arm it.
const backendFactoryOverride = new AsyncLocalStorage<() => StorageBackend>();

export function withStorageBackendFactory<T>(factory: () => StorageBackend, operation: () => Promise<T>): Promise<T> {
  if (backendFactoryOverride.getStore() !== undefined) {
    throw new Error("storage backend factory nesting is unsupported");
  }
  return backendFactoryOverride.run(factory, operation);
}

function backendFor(workspaceRoot: string): StorageBackend {
  const factory = backendFactoryOverride.getStore();
  if (factory !== undefined) {
    return factory();
  }
  let backend = fileBackends.get(workspaceRoot);
  if (backend === undefined) {
    backend = new FileBackend(workspaceRoot);
    fileBackends.set(workspaceRoot, backend);
  }
  return backend;
}

function backendForStorage(workspaceRoot: string, storageVersion: WorkspaceMetadata["storageVersion"], requestedKind?: "file" | "file-segmented"): StorageBackend {
  const factory = backendFactoryOverride.getStore();
  if (factory !== undefined) return factory();
  if (storageVersion === WORKSPACE_STORAGE_VERSION && requestedKind !== "file") {
    let backend = segmentedBackends.get(workspaceRoot);
    if (backend === undefined) {
      backend = new SegmentedBackend(workspaceRoot);
      segmentedBackends.set(workspaceRoot, backend);
    }
    return backend;
  }
  return backendFor(workspaceRoot);
}

function activeOverrideBackendKind(): StorageBackend["backendKind"] | undefined {
  const factory = backendFactoryOverride.getStore();
  return factory?.().backendKind;
}

function fail(reasonCode: WorkspaceReasonCode, message: string): never {
  throw new WorkspaceError(reasonCode, message);
}

// WSA-1 typing: JsonValue's object arm is an index-signature type, and the
// built-in Array.isArray guard only removes the mutable-array form, so an
// inline `typeof v === "object" && !Array.isArray(v)` chain leaves the readonly
// array arm in the union and every field read fails. This predicate states the
// same runtime test once and reports the narrowing the test really proves.
function isJsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

// WSA-1 typing: the record interfaces are structurally JSON objects, but
// TypeScript grants an implicit index signature only to anonymous object types,
// so an interface never satisfies JsonValue by plain assignment. This
// homomorphic mapped type restates a record's own fields as an anonymous type,
// which does carry that index signature. Nothing is asserted away: the compiler
// still checks every field of T against JsonValue at the use site, and a record
// that gained a non-JSON field would still be rejected. The recursion covers the
// nested case (ExtensionValue inside WorkRecord.extensions has the same missing
// index signature); a field that already is a JsonValue is kept verbatim rather
// than restated, so its check is the compiler's, not this type's.
type JsonFields<T> = T extends JsonValue ? T : { readonly [K in keyof T]: JsonFields<T[K]> };

// These two are identity at run time. They exist so the restatement above is
// instantiated at a concrete record type, where the compiler verifies the record
// really does satisfy it -- no assertion is involved, and a record field that
// stopped being JSON would fail here.
function projectJsonFields(record: ProjectRecord): JsonFields<ProjectRecord> {
  return record;
}

function workJsonFields(record: WorkRecord): JsonFields<WorkRecord> {
  return record;
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

// TCRN-CROSS-INC-224: this is the chain's LIFETIME event bound and it is the only caller
// of maxChainEvents. Every other use of the old shared constant bounds the shape of one
// document or call; conflating the two meant a year of accumulated governance was
// measured against the same number as a single canonical array's length.
export function assertWorkspaceRecordCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > PROTOCOL_LIMITS.maxChainEvents) {
    fail("WORKSPACE_RECORD_LIMIT", String(count));
  }
}

// STORY-174 (174.3): the data-plane copies of boundFile/boundDirectory/
// ensureDirectory/atomicWrite moved into FileBackend (storage-backend.ts). The
// three filesystem helpers below remain here DELIBERATELY for the lease, recovery
// and mutation-claim machinery, which is filesystem-specific (dev/ino identity,
// O_EXCL claims, rename-verify-remove quarantine) and is NOT part of the
// data-plane abstraction — the PG backend (STORY-175) reimplements single-writer
// with advisory locks instead. This is the deliberate-duplication exemption:
// a second copy kept in place with the reason stated, same as
// workspace-snapshot.ts's boundReadDirectory/boundReadFileBytes precedent.
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

function crash(point: WorkspaceCrashPoint, selected?: WorkspaceCrashPoint): void {
  if (point === selected) {
    fail("WORKSPACE_FAULT_INJECTED", `injected crash at ${point}`);
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

// WSR-1: the relocation identity. Derived, never random (determinism constraint 6),
// and derived from the VACATED entry's own position so the same hop always names
// itself the same way on both hosts. The adopted/aborted counterpart restates it
// rather than re-deriving from its own sequence.
export function deriveRelocationId(input: {
  readonly workspaceId: string;
  readonly sequence: number;
  readonly from: readonly CanonicalRoot[];
  readonly to: readonly CanonicalRoot[];
  readonly basis: WorkspaceRelocationBasis;
}): string {
  return `relocation:${canonicalSha256({
    schemaVersion: WORKSPACE_RELOCATION_IDENTITY_VERSION,
    workspaceId: input.workspaceId,
    sequence: input.sequence,
    from: input.from,
    to: input.to,
    basis: input.basis,
  }).slice(0, 24)}`;
}

function relocationRootArray(value: unknown, label: string): readonly CanonicalRoot[] {
  if (!Array.isArray(value) || value.length !== 5) {
    fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `${label} must hold five roots`);
  }
  const roots: CanonicalRoot[] = [];
  for (const [index, entry] of value.entries()) {
    exactFields(entry, rootFields, "WORKSPACE_RELOCATION_LEDGER_INVALID", `${label}[${index}]`);
    if (typeof entry.kind !== "string" || typeof entry.path !== "string" ||
      typeof entry.canonicalPath !== "string" || typeof entry.portableIdentity !== "string") {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `${label}[${index}] types are invalid`);
    }
    if (entry.kind !== relocationRootKindOrder[index]) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `${label}[${index}] must be ${String(relocationRootKindOrder[index])}`);
    }
    if (entry.portableIdentity !== rootPortableIdentity(entry.canonicalPath)) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `${label}[${index}] portableIdentity is not derived from its canonicalPath`);
    }
    roots.push(entry as unknown as CanonicalRoot);
  }
  try {
    assertDistinctRootShape(roots);
  } catch (error) {
    fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `${label}: ${String((error as { message?: string }).message ?? error)}`);
  }
  return roots;
}

// WSR-1: the post-read ledger validator. Runs inside validateMetadata, so a
// malformed or spliced ledger is refused at the same choke point a malformed root
// array is — before any caller sees the metadata at all.
function validateRelocationLedger(value: unknown, roots: readonly CanonicalRoot[], workspaceId: string): readonly WorkspaceRelocationEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("WORKSPACE_RELOCATION_LEDGER_INVALID", "relocations must be a non-empty array when present");
  }
  if (value.length > WORKSPACE_RELOCATION_LEDGER_LIMIT) {
    fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations exceed the ${String(WORKSPACE_RELOCATION_LEDGER_LIMIT)} entry cap`);
  }
  const entries: WorkspaceRelocationEntry[] = [];
  // The binding in force before the entry being read. It starts at `roots` and only
  // an `adopted` entry moves it. This is what makes a hop unspliceable: a `vacated`
  // entry must restate the exact binding that preceded it, byte for byte.
  let binding: readonly CanonicalRoot[] = roots;
  for (const [index, raw] of value.entries()) {
    exactFields(raw, relocationEntryFields, "WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}]`);
    if (raw.schemaVersion !== WORKSPACE_RELOCATION_ENTRY_VERSION) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].schemaVersion`);
    }
    if (raw.sequence !== index + 1) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].sequence is not contiguous`);
    }
    if (typeof raw.stage !== "string" || !relocationStages.has(raw.stage)) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].stage`);
    }
    if (typeof raw.relocationId !== "string" || !/^relocation:[a-f0-9]{24}$/u.test(raw.relocationId)) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].relocationId`);
    }
    try {
      assertStrictInstant(raw.at);
    } catch {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].at`);
    }
    const from = relocationRootArray(raw.from, `relocations[${index}].from`);
    const to = relocationRootArray(raw.to, `relocations[${index}].to`);
    exactFields(raw.basis, relocationBasisFields, "WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].basis`);
    const basisValue = raw.basis as Readonly<Record<string, unknown>>;
    if (typeof basisValue.controlManifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(basisValue.controlManifestSha256) ||
      !(basisValue.headEventHash === null || (typeof basisValue.headEventHash === "string" && /^[a-f0-9]{64}$/u.test(basisValue.headEventHash))) ||
      !Number.isSafeInteger(basisValue.version) || Number(basisValue.version) < 0) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].basis is invalid`);
    }
    const basis: WorkspaceRelocationBasis = {
      controlManifestSha256: basisValue.controlManifestSha256,
      headEventHash: basisValue.headEventHash as string | null,
      version: basisValue.version as number,
    };
    exactFields(raw.authority, relocationAuthorityFields, "WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].authority`);
    const authorityValue = raw.authority as Readonly<Record<string, unknown>>;
    if (typeof authorityValue.authorityFileSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(authorityValue.authorityFileSha256)) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].authority.authorityFileSha256`);
    }
    try {
      assertProtocolId(authorityValue.actorId);
    } catch {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].authority.actorId`);
    }
    const entry = raw as unknown as WorkspaceRelocationEntry;
    const previous = entries[index - 1];
    if (entry.stage === "vacated") {
      if (previous !== undefined && previous.stage === "vacated") {
        fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}] follows an uncompleted hop`);
      }
      if (canonicalJson(from) !== canonicalJson(binding)) {
        fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].from is not the binding it replaced`);
      }
      if (entry.relocationId !== deriveRelocationId({ workspaceId, sequence: entry.sequence, from, to, basis })) {
        fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].relocationId is not derived from its own content`);
      }
    } else {
      if (previous === undefined || previous.stage !== "vacated") {
        fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}] does not complete a vacated hop`);
      }
      if (entry.relocationId !== previous.relocationId ||
        canonicalJson(from) !== canonicalJson(previous.from) ||
        canonicalJson(to) !== canonicalJson(previous.to) ||
        canonicalJson(basis) !== canonicalJson(previous.basis)) {
        fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}] does not restate its hop`);
      }
      if (entry.stage === "adopted") {
        binding = to;
      }
    }
    entries.push(entry);
  }
  return entries;
}

// WSR-1: the binding in force. `relocations` absent means `roots`; otherwise the
// `to` of the newest hop an `adopted` completed, and an `aborted` pair reverts to
// the binding before it.
//
// `roots` is NEVER rewritten. The synthesised design had adopt overwrite it, which
// contradicts the ledger's own chaining rule one line later: the first hop's `from`
// must equal `roots` byte for byte, so overwriting `roots` makes the ledger
// self-invalidating on the very next read. Keeping `roots` as the immutable
// original binding is what makes this accessor load-bearing rather than cosmetic —
// after an adopt the two genuinely differ, which is why the four call sites below
// are the complete change set and why T5/T6/T7 can actually go red.
export function activeBinding(metadata: WorkspaceMetadata): readonly CanonicalRoot[] {
  let binding: readonly CanonicalRoot[] = metadata.roots;
  for (const entry of metadata.relocations ?? []) {
    if (entry.stage === "adopted") {
      binding = entry.to;
    }
  }
  return binding;
}

export function activeWorkspaceRoot(metadata: WorkspaceMetadata): string | undefined {
  return activeBinding(metadata).find((root) => root.kind === "workspace")?.canonicalPath;
}

function relocationWorkspaceRoot(roots: readonly CanonicalRoot[]): string | undefined {
  return roots.find((root) => root.kind === "workspace")?.canonicalPath;
}

// WSR-1: the three-state discriminator. Computed from the file alone plus the
// address the caller is standing at.
export function relocationStateAt(metadata: WorkspaceMetadata, address: string): WorkspaceRelocationState {
  const entries = metadata.relocations ?? [];
  const trailing = entries[entries.length - 1];
  if (trailing === undefined) {
    // The address is compared even here. Returning "live" for ANY address whenever
    // the ledger is absent made relocation-inspect answer `live` at a stale
    // pre-vacate copy, a restored backup and a tree whose `relocations` field had
    // been stripped — all of which every other verb refuses to open at all
    // (WORKSPACE_SCHEMA_INVALID, "stored roots do not match their current
    // filesystem identities"). The inspection is the mandated close-out's verdict
    // word, so a detector that reads "this file's ledger does not say otherwise"
    // while printing itself as "this address is the live authority" produces a
    // false fork alarm on every stale copy left on disk.
    return address === relocationWorkspaceRoot(metadata.roots) ? "live" : "foreign-address";
  }
  const vacatedAddresses = new Set<string>();
  for (const entry of entries) {
    if (entry.stage === "adopted") {
      const previous = relocationWorkspaceRoot(entry.from);
      if (previous !== undefined) vacatedAddresses.add(previous);
    }
  }
  if (trailing.stage === "vacated") {
    if (address === relocationWorkspaceRoot(trailing.from)) return "vacated";
    if (address === relocationWorkspaceRoot(trailing.to)) return "adoption-required";
    return "foreign-address";
  }
  if (address === relocationWorkspaceRoot(activeBinding(metadata))) {
    return "live";
  }
  return vacatedAddresses.has(address) ? "vacated" : "foreign-address";
}

function admitRelocationState(state: WorkspaceRelocationState, admit: WorkspaceAdmission, address: string): void {
  if (admit === "any") return;
  if (state === "live") return;
  if (admit === "adoption" && state === "adoption-required") return;
  if (admit === "abort" && state === "vacated") return;
  if (state === "vacated") {
    fail("WORKSPACE_RELOCATION_VACATED", `${address} was vacated by a governed relocation and is no longer a live workspace`);
  }
  if (state === "adoption-required") {
    fail("WORKSPACE_RELOCATION_ADOPTION_REQUIRED", `${address} is a relocated copy whose relocation ledger has not been adopted at this address`);
  }
  fail("WORKSPACE_RELOCATION_FOREIGN_ADDRESS", `${address} is not an address this relocation ledger names`);
}

function validateMetadata(value: unknown): WorkspaceMetadata {
  // WSR-1: the ten-field form is admitted only when the field is actually present.
  // A workspace without it is checked against the identical nine-field closed list
  // it has always been checked against.
  const relocationsPresent = value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.hasOwn(value, "relocations");
  exactFields(value, relocationsPresent ? metadataFieldsWithRelocations : metadataFields, "WORKSPACE_SCHEMA_INVALID", "workspace metadata");
  if (typeof value.storageVersion === "number" && value.storageVersion > WORKSPACE_STORAGE_VERSION) {
    fail("WORKSPACE_MIGRATION_FUTURE", String(value.storageVersion));
  }
  if (typeof value.storageVersion === "number" && value.storageVersion < WORKSPACE_LEGACY_STORAGE_VERSION) {
    fail("WORKSPACE_MIGRATION_DOWNGRADE", String(value.storageVersion));
  }
  const legacyStorage = value.storageVersion === WORKSPACE_LEGACY_STORAGE_VERSION && value.minimumStorageVersion === 1 &&
    value.maximumStorageVersion === 1 && Number.isSafeInteger(value.segmentEventLimit) &&
    Number(value.segmentEventLimit) >= 2 && Number(value.segmentEventLimit) <= 1024;
  const segmentedStorage = value.storageVersion === WORKSPACE_STORAGE_VERSION && value.minimumStorageVersion === 1 &&
    value.maximumStorageVersion === WORKSPACE_STORAGE_VERSION && Number.isSafeInteger(value.segmentEventLimit) &&
    Number(value.segmentEventLimit) >= WORKSPACE_SEGMENT_BYTES_MIN && Number(value.segmentEventLimit) <= WORKSPACE_SEGMENT_BYTES_MAX;
  if (value.schemaVersion !== WORKSPACE_SCHEMA_VERSION || (!legacyStorage && !segmentedStorage) ||
    typeof value.workspaceId !== "string" || typeof value.externalKey !== "string" ||
    typeof value.createdAt !== "string" || !Array.isArray(value.roots) || value.roots.length !== 5) {
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
  if (relocationsPresent) {
    validateRelocationLedger(value.relocations, value.roots as unknown as readonly CanonicalRoot[], value.workspaceId);
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

function replaySnapshotStateValue(state: WorkspaceState): Omit<ReplaySnapshotState, "stateDigest"> {
  return {
    schemaVersion: WORKSPACE_REPLAY_SNAPSHOT_VERSION,
    metadata: state.metadata,
    version: state.version,
    headEventHash: state.headEventHash,
    projects: state.projects,
    work: state.work,
    conferences: state.conferences,
    conferencePositions: state.conferencePositions,
    conferenceMinutes: state.conferenceMinutes,
    gates: state.gates,
    settings: state.settings,
    executionConfig: state.executionConfig,
    templates: state.templates,
    attestationEnabledAtSequence: state.attestationEnabledAtSequence,
  };
}

function snapshotIntervalForState(state: WorkspaceState): number {
  const configured = state.settings.find((entry) => entry.key === "storage.snapshotEveryEvents")?.value;
  const value = configured === undefined ? WORKSPACE_REPLAY_SNAPSHOT_INTERVAL_DEFAULT : Number(configured);
  if (!Number.isSafeInteger(value) || value < WORKSPACE_REPLAY_SNAPSHOT_INTERVAL_MIN || value > WORKSPACE_REPLAY_SNAPSHOT_INTERVAL_MAX) {
    fail("WORKSPACE_SCHEMA_INVALID", "storage.snapshotEveryEvents is outside its declared bounds");
  }
  return value;
}

function isMissingStoragePath(error: unknown): boolean {
  return error instanceof StorageError && /\bENOENT\b/u.test(error.message);
}

function replaySnapshotFail(message: string): never {
  fail("WORKSPACE_SNAPSHOT_INVALID", message);
}

function sha256Bytes(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function unboundedCanonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => unboundedCanonicalValue(entry)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort(compareCanonicalText).map((key) => `${JSON.stringify(key)}:${unboundedCanonicalValue(object[key])}`).join(",")}}`;
  }
  throw new Error("WORKSPACE_SNAPSHOT_INVALID: non-JSON snapshot value");
}

function unboundedCanonicalJson(value: unknown): string {
  return `${unboundedCanonicalValue(value)}\n`;
}

function replaySnapshotDigest(value: unknown): string {
  return sha256Bytes(Buffer.from(unboundedCanonicalJson(value), "utf8"));
}

function validateLegacyReplaySnapshotPrefix(events: readonly EventRecord[], manifest: ReplaySnapshotManifest): void {
  if (manifest.eventPrefixDigest !== undefined && replaySnapshotDigest(events.slice(0, manifest.version)) !== manifest.eventPrefixDigest) {
    replaySnapshotFail("snapshot event prefix digest mismatch");
  }
}

function assertReplaySnapshotManifest(value: unknown): asserts value is ReplaySnapshotManifest {
  const manifest = value as Record<string, unknown>;
  const legacySnapshot = manifest !== null && typeof manifest === "object" && Object.hasOwn(manifest, "snapshot");
  const legacyPrefixDigest = manifest !== null && typeof manifest === "object" && Object.hasOwn(manifest, "eventPrefixDigest");
  const fields = ["headEventHash", "schemaVersion", "segments", legacySnapshot ? "snapshot" : "snapshotParts", "stateDigest", "version", "workspaceId"];
  if (legacyPrefixDigest) fields.push("eventPrefixDigest");
  exactFields(value, fields, "WORKSPACE_SNAPSHOT_INVALID", "replay snapshot manifest");
  if (manifest.schemaVersion !== WORKSPACE_REPLAY_SNAPSHOT_MANIFEST_VERSION || typeof manifest.workspaceId !== "string" ||
    !Number.isSafeInteger(manifest.version) || Number(manifest.version) < 1 ||
    (legacySnapshot ? (typeof manifest.snapshot !== "string" || !/^\d{12}\.json$/u.test(manifest.snapshot)) :
      (!Array.isArray(manifest.snapshotParts) || manifest.snapshotParts.length === 0 || manifest.snapshotParts.some((part) => typeof part !== "string" || !/^\d{12}\.part\d{4}$/u.test(part)))) ||
    typeof manifest.stateDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.stateDigest) ||
    (legacyPrefixDigest && (typeof manifest.eventPrefixDigest !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.eventPrefixDigest))) ||
    (manifest.headEventHash !== null && (typeof manifest.headEventHash !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.headEventHash))) ||
    !Array.isArray(manifest.segments)) {
    replaySnapshotFail("replay snapshot manifest fields are invalid");
  }
  let previousName: string | null = null;
  for (const entry of manifest.segments) {
    exactFields(entry, ["bytes", "name", "sha256"], "WORKSPACE_SNAPSHOT_INVALID", "replay snapshot segment digest");
    const digest = entry as Record<string, unknown>;
    if (typeof digest.name !== "string" || !/^\d{6}\.(?:json|ndjson)$/u.test(digest.name) ||
      (previousName !== null && compareCanonicalText(previousName, digest.name) >= 0) ||
      !Number.isSafeInteger(digest.bytes) || Number(digest.bytes) < 0 || typeof digest.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(digest.sha256)) {
      replaySnapshotFail("replay snapshot segment digest is invalid");
    }
    previousName = digest.name;
  }
}

function assertReplaySnapshotState(value: unknown, metadata: WorkspaceMetadata, manifest: ReplaySnapshotManifest): asserts value is ReplaySnapshotState {
  exactFields(value, ["attestationEnabledAtSequence", "conferences", "conferenceMinutes", "conferencePositions", "executionConfig", "gates", "headEventHash", "metadata", "projects", "schemaVersion", "settings", "stateDigest", "templates", "version", "work"], "WORKSPACE_SNAPSHOT_INVALID", "replay snapshot state");
  const snapshot = value as Record<string, unknown>;
  if (snapshot.schemaVersion !== WORKSPACE_REPLAY_SNAPSHOT_VERSION || canonicalJson(snapshot.metadata) !== canonicalJson(metadata) ||
    snapshot.version !== manifest.version || snapshot.headEventHash !== manifest.headEventHash ||
    !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.work) || !Array.isArray(snapshot.conferences) ||
    !Array.isArray(snapshot.conferencePositions) || !Array.isArray(snapshot.conferenceMinutes) || !Array.isArray(snapshot.gates) ||
    !Array.isArray(snapshot.settings) || !Array.isArray(snapshot.templates) ||
    !isJsonObject(snapshot.executionConfig as JsonValue | undefined) ||
    (snapshot.attestationEnabledAtSequence !== null && !Number.isSafeInteger(snapshot.attestationEnabledAtSequence)) ||
    typeof snapshot.stateDigest !== "string" || !/^[a-f0-9]{64}$/u.test(snapshot.stateDigest)) {
    replaySnapshotFail("replay snapshot state fields are invalid");
  }
  const stateWithoutDigest = { ...snapshot };
  delete stateWithoutDigest.stateDigest;
  if (replaySnapshotDigest(stateWithoutDigest) !== snapshot.stateDigest || snapshot.stateDigest !== manifest.stateDigest) {
    replaySnapshotFail("replay snapshot state digest mismatch");
  }
  try {
    for (const project of snapshot.projects) validateProject(project, "WORKSPACE_SNAPSHOT_INVALID");
    validateWorkGraph(snapshot.work as unknown as readonly WorkRecord[], templateRegistry(snapshot.templates as unknown as readonly TemplateAdmissionRecord[]));
  } catch (error) {
    if (error instanceof WorkspaceError && error.reasonCode === "WORKSPACE_SNAPSHOT_INVALID") throw error;
    if (error instanceof ProtocolError) replaySnapshotFail(`${error.reasonCode}:${error.message}`);
    throw error;
  }
}

async function readReplaySnapshot(workspaceRoot: string, metadata: WorkspaceMetadata): Promise<ReplaySnapshotSeed | null> {
  const backend = backendForStorage(workspaceRoot, metadata.storageVersion);
  let entries: readonly StorageDirectoryEntry[];
  try {
    entries = await backend.listControlEntries(WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY);
  } catch (error) {
    if (isMissingStoragePath(error)) return null;
    replaySnapshotFail(`snapshot directory is unreadable: ${String(error)}`);
  }
  const names = entries.filter((entry) => entry.isFile && !entry.isSymbolicLink && !entry.name.startsWith(".tmp-")).map((entry) => entry.name);
  if (names.length === 0) return null;
  if (!names.includes(WORKSPACE_REPLAY_SNAPSHOT_MANIFEST)) {
    replaySnapshotFail("snapshot manifest is missing");
  }
  let manifestValue: JsonValue;
  try {
    manifestValue = assertCanonicalJson((await backend.readControlFile(`${WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY}/${WORKSPACE_REPLAY_SNAPSHOT_MANIFEST}`, 65_536)).toString("utf8"));
  } catch (error) {
    replaySnapshotFail(`snapshot manifest cannot be parsed: ${String(error)}`);
  }
  assertReplaySnapshotManifest(manifestValue);
  if (manifestValue.workspaceId !== metadata.workspaceId || manifestValue.version > PROTOCOL_LIMITS.maxChainEvents) {
    replaySnapshotFail("snapshot manifest is not bound to this workspace");
  }
  let stateValue: JsonValue;
  if (manifestValue.snapshotParts !== undefined) {
    try {
      const compressed = Buffer.concat(await Promise.all(manifestValue.snapshotParts.map((part) => backend.readControlFile(`${WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY}/${part}`, 1_048_576))));
      const decompressed = inflateSync(compressed).toString("utf8");
      const decoded = JSON.parse(decompressed) as unknown;
      if (unboundedCanonicalJson(decoded) !== decompressed) replaySnapshotFail("replay snapshot payload is not canonical");
      stateValue = decoded as JsonValue;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      replaySnapshotFail(`replay snapshot payload cannot be decoded: ${String(error)}`);
    }
  } else {
    let snapshotBytes: Buffer;
    try {
      snapshotBytes = await backend.readControlFile(`${WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY}/${manifestValue.snapshot ?? ""}`, 67_108_864);
    } catch (error) {
      replaySnapshotFail(`snapshot envelope cannot be read: ${String(error)}`);
    }
    const snapshotValue = assertCanonicalJson(snapshotBytes.toString("utf8"));
    // A short-lived pre-compression checkpoint may exist on disk from the
    // migration window. It is still verified against its digest.
    if (isJsonObject(snapshotValue) && snapshotValue.schemaVersion === WORKSPACE_REPLAY_SNAPSHOT_VERSION) {
      assertReplaySnapshotState(snapshotValue, metadata, manifestValue);
      return { ...(snapshotValue as ReplaySnapshotState), manifest: manifestValue, prefixEvents: [] };
    }
    exactFields(snapshotValue, ["encoding", "payload", "schemaVersion", "stateDigest"], "WORKSPACE_SNAPSHOT_INVALID", "replay snapshot envelope");
    const envelope = snapshotValue as Readonly<Record<string, unknown>>;
    if (envelope.schemaVersion !== "tcrn.workspace-replay-snapshot-envelope.v1" || envelope.encoding !== "deflate-base64" ||
      typeof envelope.stateDigest !== "string" || envelope.stateDigest !== manifestValue.stateDigest || !/^[a-f0-9]{64}$/u.test(envelope.stateDigest) ||
      !Array.isArray(envelope.payload) || envelope.payload.some((chunk) => typeof chunk !== "string" || chunk.length > 8_192 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(chunk))) {
      replaySnapshotFail("replay snapshot envelope fields are invalid");
    }
    try {
      const encodedPayload = (envelope.payload as readonly unknown[]).join("");
      const decompressed = inflateSync(Buffer.from(encodedPayload, "base64")).toString("utf8");
      const decoded = JSON.parse(decompressed) as unknown;
      if (unboundedCanonicalJson(decoded) !== decompressed) replaySnapshotFail("replay snapshot payload is not canonical");
      stateValue = decoded as JsonValue;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      replaySnapshotFail(`replay snapshot payload cannot be decoded: ${String(error)}`);
    }
  }
  stateValue = { ...(stateValue as Readonly<Record<string, JsonValue>>), stateDigest: manifestValue.stateDigest };
  assertReplaySnapshotState(stateValue, metadata, manifestValue);
  return { ...(stateValue as ReplaySnapshotState), manifest: manifestValue, prefixEvents: [] };
}

function validateReplaySnapshotTail(events: readonly EventRecord[], snapshot: ReplaySnapshotManifest): void {
  const tail = events.slice(snapshot.version);
  let priorHash = snapshot.headEventHash;
  for (const event of tail) {
    try {
      const expected = createEvent({
        id: event.id,
        streamId: event.streamId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        priorHash: event.priorHash,
        payload: event.payload,
      });
      if (event.payloadHash !== expected.payloadHash || event.eventHash !== expected.eventHash || event.priorHash !== priorHash) {
        replaySnapshotFail(`tail event ${event.id} is not bound to the snapshot`);
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (error instanceof ProtocolError) replaySnapshotFail(`${error.reasonCode}:${error.message}`);
      throw error;
    }
    priorHash = event.eventHash;
  }
  const actualHead = events.at(-1)?.eventHash ?? null;
  if (actualHead !== (tail.at(-1)?.eventHash ?? snapshot.headEventHash)) {
    replaySnapshotFail("snapshot tail head does not match the event log");
  }
}

// WSR-1: readMetadata is the universal choke point — resolveWorkspace is NOT. Six
// callers reach it, and acquireWorkspaceLease is one of them, so EVERY mutation
// passes through here too. That is why the relocation admission check lives here
// and not in resolveWorkspace: lease-break, lease-recovery-break and the lease
// acquisition itself never touch resolveWorkspace at all.
//
// `admit` DEFAULTS TO THE STRICT VALUE. A permissive default would break nothing
// visible and would silently disable the entire mechanism; guard G1 mutates it and
// T4 is the test that must go red.
async function readMetadata(workspaceRoot: string, admit: WorkspaceAdmission = "live"): Promise<WorkspaceMetadata> {
  const content = await backendFor(workspaceRoot).readMetadataBytes();
  let metadata: WorkspaceMetadata;
  try {
    metadata = validateMetadata(assertCanonicalJson(content.toString("utf8")));
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    if (error instanceof ProtocolError) {
      fail("WORKSPACE_SCHEMA_INVALID", error.message);
    }
    fail("WORKSPACE_SCHEMA_INVALID", String(error));
  }
  if (metadata.relocations !== undefined) {
    admitRelocationState(relocationStateAt(metadata, workspaceRoot), admit, workspaceRoot);
  }
  return metadata;
}

async function readSegmentEvents(workspaceRoot: string, metadata: WorkspaceMetadata, options: { readonly snapshot?: ReplaySnapshotSeed } = {}): Promise<readonly EventRecord[]> {
  // STORY-174: enumeration and byte reads ride through the storage backend; the
  // shape/gap validation stays at the engine layer so both backends enforce the
  // same segment contract. A non-conforming entry (e.g. `special-entry`) fails
  // WORKSPACE_EVENT_CORRUPT exactly as before.
  const backend = backendForStorage(workspaceRoot, metadata.storageVersion);
  const entries = await backend.listSegmentNames();
  const segmentedStorage = metadata.storageVersion === WORKSPACE_STORAGE_VERSION;
  const suffix = segmentedStorage ? "ndjson" : "json";
  const segmentNames: string[] = [];
  for (const name of entries) {
    if (!(new RegExp(`^\\d{6}\\.${suffix}$`, "u")).test(name)) {
      fail("WORKSPACE_EVENT_CORRUPT", `unexpected event entry ${name}`);
    }
    segmentNames.push(name);
  }
  const events: EventRecord[] = [];
  const segmentBytes = new Map<string, Buffer>();
  const segmentLastSequence = new Map<string, number>();
  for (const [index, name] of segmentNames.entries()) {
    if (name !== `${String(index + 1).padStart(6, "0")}.${suffix}`) {
      fail("WORKSPACE_EVENT_CORRUPT", `event segment gap at ${name}`);
    }
    const content = await backend.readSegment(name);
    segmentBytes.set(name, content);
    if (segmentedStorage) {
      const text = content.toString("utf8");
      if (!text.endsWith("\n") || text.endsWith("\n\n")) {
        fail("WORKSPACE_EVENT_CORRUPT", `${name} is not canonical NDJSON`);
      }
      for (const line of text.split("\n").slice(0, -1)) {
        try {
          const parsed = assertCanonicalJson(`${line}\n`);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            fail("WORKSPACE_EVENT_CORRUPT", `${name} contains a non-event record`);
          }
          const event = parsed as unknown as EventRecord;
          events.push(event);
          segmentLastSequence.set(name, event.sequence);
        } catch (error) {
          if (error instanceof WorkspaceError) throw error;
          fail("WORKSPACE_EVENT_CORRUPT", String((error as { message?: string }).message ?? error));
        }
      }
      if (text.length === 1) {
        fail("WORKSPACE_EVENT_CORRUPT", `${name} is empty`);
      }
    } else {
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
        const storedEvent = event as unknown as EventRecord;
        events.push(storedEvent);
        segmentLastSequence.set(name, storedEvent.sequence);
      }
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
  const snapshot = options.snapshot;
  if (snapshot !== undefined) {
    if (snapshot.version > events.length || snapshot.version < 1) {
      replaySnapshotFail("snapshot version is outside the event log");
    }
    const expectedSegments = new Map(snapshot.manifest.segments.map((entry) => [entry.name, entry]));
    for (const expected of snapshot.manifest.segments) {
      const content = segmentBytes.get(expected.name);
      if (content === undefined) replaySnapshotFail(`snapshot segment ${expected.name} is missing`);
      const lastSequence = segmentLastSequence.get(expected.name) ?? 0;
      // NDJSON appends preserve the exact bytes that were present at the
      // checkpoint. Hashing only the recorded segment prefix covers an active
      // segment after it receives post-snapshot events without parsing the
      // checkpoint prefix a second time. Legacy JSON snapshots retain their
      // event-prefix digest as a compatibility path until they are rebuilt.
      const checkpointBytes = expected.name.endsWith(".ndjson") && content.length >= expected.bytes
        ? content.subarray(0, expected.bytes)
        : content;
      if (lastSequence <= snapshot.version || expected.name.endsWith(".ndjson")) {
        if (checkpointBytes.length !== expected.bytes || sha256Bytes(checkpointBytes) !== expected.sha256) {
          replaySnapshotFail(`snapshot segment ${expected.name} changed before the checkpoint`);
        }
      }
    }
    for (const [name, content] of segmentBytes) {
      if (expectedSegments.has(name)) continue;
      const firstSequence = events.find((event) => event.sequence === (segmentLastSequence.get(name) ?? 0))?.sequence ?? 0;
      if (firstSequence <= snapshot.version) replaySnapshotFail(`unexpected pre-snapshot segment ${name}`);
      void content;
    }
    validateLegacyReplaySnapshotPrefix(events, snapshot.manifest);
    validateReplaySnapshotTail(events, snapshot.manifest);
    return events;
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
  const record = payload.record;
  if (!isJsonObject(record)) {
    fail("WORKSPACE_EVENT_CORRUPT", `${operation} record is invalid`);
  }
  return record;
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
    if (error instanceof ConferenceError || error instanceof AssignmentGateError || error instanceof GateIdentityError || error instanceof SettingsError || error instanceof TemplateAdmissionError) {
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

// WSA-2: per-event relationship validation. Validates only the mutated record's
// closure (record + ancestor chain) instead of the whole work graph, which
// removes the per-event full validateWorkGraph that made materialize quadratic.
// The terminal validateWorkGraph over the full set still runs once. This catches
// prefix-invalid intermediate states (a child before its parent, a live child of
// a just-tombstoned parent) that a terminal-only check would miss.
// CQ-10b correction: the ancestor walk is O(delta), but the delete arm below is a
// full scan of the work map, so this function is NOT O(delta) on a work.deleted
// event. The scan is counted by recordCollectionScan so the proof can bound it.
function validateWorkClosure(work: Map<string, WorkRecord>, projects: Map<string, ProjectRecord>, record: WorkRecord, registry: readonly ExtensionRegistration[] = []): void {
  const project = projects.get(record.projectId);
  if (!project || (project.tombstone && !record.tombstone)) {
    fail("WORKSPACE_EVENT_CORRUPT", `work ${record.id} references an unavailable project`);
  }
  const closure = collectWorkClosure(work, record);
  recordClosureValidation(closure.length);
  try {
    validateWorkGraph(closure, registry);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("WORKSPACE_EVENT_CORRUPT", `${error.reasonCode}:${error.message}`);
    }
    throw error;
  }
  if (record.tombstone) {
    // CQ-10b: this is a full scan of the work map, not part of the ancestor-bounded
    // closure above, and it runs once per work delete. It is counted separately so
    // the proof sees it; measurement (4% of replay at the reachable ceiling) says
    // leave it as a scan rather than trade a fail-closed corruption check for an
    // incrementally maintained live-children index.
    recordCollectionScan(work.size);
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
// gate-v1: what the identity check decided, written down so an auditor can see which
// roster was in force when this gate closed. It is deliberately self-contained -- the
// acting actor and the roster's digest, nothing that has to be fetched to be read.
//
// Replay checks this entry's shape and never re-reads the roster. That is the whole
// point: a chain whose readability depended on an external file still being present
// would brick on ordinary key rotation, or on a restore onto a machine that never had
// it. The digest here is a record of what was checked, not something to check against.
const GATE_IDENTITY_KEY = "gate-identity:decision";
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

function gateIdentityExtensions(base: Readonly<Record<string, unknown>>, decision: GateIdentityDecision): Readonly<Record<string, unknown>> {
  return { ...base, [GATE_IDENTITY_KEY]: { required: false, value: { actorId: decision.actorId, authorityFileSha256: decision.authorityFileSha256 } } };
}

function readGateEvidenceLocator(extensions: Readonly<Record<string, unknown>>): string | undefined {
  const entry = extensions[GATE_EVIDENCE_KEY];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const value = (entry as Readonly<Record<string, unknown>>).value;
  return typeof value === "string" ? value : undefined;
}

// E05 (advisory scope-on-record): advisory fields on a work record, written by the
// additive work.annotated operation. Both are required:false extensions -- no registry
// row; Story scope gates execution and Owner-decided completion, while a binary
// predating them still reads any workspace that never annotates. advisory:scope is an
// authoritative one-line scope/intent statement; advisory:decided-by backlinks the
// governing conference minutes, so an executor reads a work item's scope off the record
// itself rather than reconstructing it from a compressed external key.
const ADVISORY_SCOPE_KEY = "advisory:scope";
const ADVISORY_DECIDED_BY_KEY = "advisory:decided-by";
const WORK_SCOPE_REFERENCE_VERSION = "tcrn.work-scope-reference.v1" as const;
// INIT-008: advisory:sprint is the member-side tag that puts a work record on a
// sprint / release-train batch. Its value is a QUALIFIED reference to the sprint
// (a Release record) -- {workspaceId, workId} of full protocol ids -- so a member
// on one partition can point at a sprint on another (the cross partition). It is
// additive exactly like the other advisory keys: no new operation, no registry
// row, and a workspace that never sprints is byte-identical. The one caveat is the
// same as every advisory key and work.annotated itself -- a binary predating this
// key fails the closed anti-smuggling replay guard on a chain that USES it, which
// is why it ships in a minor release (0.5.0) that readers of such chains must pin.
const ADVISORY_SPRINT_KEY = "advisory:sprint";
const ADVISORY_KEYS: readonly string[] = [ADVISORY_SCOPE_KEY, ADVISORY_DECIDED_BY_KEY, ADVISORY_SPRINT_KEY];

// A sprint reference is a qualified cross-partition pointer: the workspaceId (derived,
// so `workspace:` + 24 hex) plus the work id of the sprint's Release record. Both halves
// are whole protocol ids re-validatable on their own -- the advisory:decided-by
// convention of carrying full ids, never a packed/compressed form.
export interface SprintReference {
  readonly workspaceId: string;
  readonly workId: string;
}

function isSprintReference(value: unknown): value is SprintReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  // Membership check without a comparator: compareCanonicalText throws
  // CanonicalOrderError on an ill-formed-Unicode key, and this predicate must return
  // false for any bad shape rather than throw a foreign error at a direct caller.
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 2 || !Object.hasOwn(value as object, "workId") || !Object.hasOwn(value as object, "workspaceId")) return false;
  const { workspaceId, workId } = value as { readonly workspaceId: unknown; readonly workId: unknown };
  if (typeof workspaceId !== "string" || !/^workspace:[a-f0-9]{24}$/u.test(workspaceId)) return false;
  if (typeof workId !== "string" || workId.slice(0, workId.indexOf(":")) !== "work") return false;
  try {
    assertProtocolId(workId);
  } catch {
    return false;
  }
  return true;
}

function workAdvisoryExtensions(base: Readonly<Record<string, unknown>>, advisory: {
  readonly scope?: string;
  readonly decidedBy?: readonly string[];
  readonly sprint?: SprintReference;
}): Readonly<Record<string, unknown>> {
  const next: Record<string, unknown> = { ...base };
  if (advisory.scope !== undefined) {
    next[ADVISORY_SCOPE_KEY] = { required: false, value: advisory.scope };
  }
  if (advisory.decidedBy !== undefined) {
    next[ADVISORY_DECIDED_BY_KEY] = { required: false, value: [...advisory.decidedBy] };
  }
  if (advisory.sprint !== undefined) {
    next[ADVISORY_SPRINT_KEY] = { required: false, value: { workspaceId: advisory.sprint.workspaceId, workId: advisory.sprint.workId } };
  }
  return next;
}

function workExtensionsDigest(extensions: Readonly<Record<string, unknown>>): string {
  return canonicalSha256(extensions as JsonValue);
}

function workScopeReference(digest: string): Readonly<Record<string, unknown>> {
  return { required: false, value: { schemaVersion: WORK_SCOPE_REFERENCE_VERSION, digest } };
}

function workEventExtensions(record: WorkRecord, deduplicateScope: boolean): WorkRecord["extensions"] {
  if (!deduplicateScope || typeof record.extensions[ADVISORY_SCOPE_KEY]?.value !== "string" || record.scopeDigest === null || record.scopeDigest === undefined) {
    return record.extensions;
  }
  return {
    ...record.extensions,
    [ADVISORY_SCOPE_KEY]: workScopeReference(record.scopeDigest),
  } as unknown as WorkRecord["extensions"];
}

function normalizeWorkRecord(record: WorkRecord, reasonCode: WorkspaceReasonCode = "WORKSPACE_EVENT_CORRUPT"): WorkRecord {
  const currentFields = ["scopeDigest", "title", "createdAt", "labels"];
  const present = currentFields.filter((field) => Object.hasOwn(record, field)).length;
  if (present === 0) {
    return { ...record, scopeDigest: null, title: null, createdAt: null, labels: [] };
  }
  if (present !== currentFields.length ||
    (record.scopeDigest !== null && (typeof record.scopeDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.scopeDigest))) ||
    (record.title !== null && typeof record.title !== "string") ||
    (record.createdAt !== null && (typeof record.createdAt !== "string" || (() => { try { assertStrictInstant(record.createdAt); return false; } catch { return true; } })())) ||
    !Array.isArray(record.labels) || record.labels.some((label) => typeof label !== "string") || new Set(record.labels).size !== record.labels.length) {
    fail(reasonCode, `work ${String(record.id)} field upgrade is invalid`);
  }
  // TCRN-CROSS-STORY-363. The summary is checked only where it is present. It is
  // deliberately NOT filled in for the records that predate it: this function runs
  // on every replayed event, and adding a field here would change the bytes every
  // derived view digests without any event having changed -- eight partitions'
  // views stale at once, for a field nobody wrote.
  if (Object.hasOwn(record, "summary") && !isWorkSummary(record.summary)) {
    fail(reasonCode, `work ${String(record.id)} summary is invalid`);
  }
  return record;
}

function normalizeWorkLabels(value: unknown, reasonCode: WorkspaceReasonCode = "WORKSPACE_INPUT_INVALID"): readonly string[] {
  if (!Array.isArray(value) || value.some((label) => typeof label !== "string" || label.length === 0 || label.length > 128) || new Set(value).size !== value.length) {
    fail(reasonCode, "work labels must be unique bounded strings");
  }
  return [...value].sort(compareCanonicalText);
}

function normalizeWorkTitle(value: unknown, reasonCode: WorkspaceReasonCode = "WORKSPACE_INPUT_INVALID"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || [...value].length > 512) {
    fail(reasonCode, "work title must be a non-empty bounded string");
  }
  try {
    canonicalJson(value);
  } catch (error) {
    if (error instanceof ProtocolError) fail(reasonCode, error.message);
    throw error;
  }
  return value;
}

// TCRN-CROSS-STORY-363. The write-path bound on a caller-supplied summary. It
// shares isWorkSummary with replay so the rule has one statement, and it reports
// the byte budget in the message because "too long" is unactionable when the
// budget is bytes and the author counted characters.
function normalizeWorkSummary(value: unknown, reasonCode: WorkspaceReasonCode = "WORKSPACE_INPUT_INVALID"): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isWorkSummary(value)) {
    fail(reasonCode, `work summary must be a non-empty string of at most ${String(WORK_SUMMARY_MAX_BYTES)} UTF-8 bytes`);
  }
  return value as string;
}

function workFieldsForWrite(record: WorkRecord): WorkRecord {
  const normalized = normalizeWorkRecord(record);
  return {
    ...normalized,
    scopeDigest: workExtensionsDigest(normalized.extensions),
    title: normalized.title ?? null,
    createdAt: normalized.createdAt ?? null,
    labels: normalized.labels ?? [],
  };
}

function resolveWorkRecord(raw: WorkRecord, current: WorkRecord | undefined, reasonCode: WorkspaceReasonCode): WorkRecord {
  const record = normalizeWorkRecord(raw, reasonCode);
  const scopeEntry = record.extensions[ADVISORY_SCOPE_KEY];
  const scopeValue = scopeEntry?.value;
  if (scopeValue !== null && typeof scopeValue === "object" && !Array.isArray(scopeValue)) {
    exactFields(scopeValue, ["digest", "schemaVersion"], reasonCode, "work scope reference");
    const reference = scopeValue as Readonly<Record<string, unknown>>;
    if (reference.schemaVersion !== WORK_SCOPE_REFERENCE_VERSION || typeof reference.digest !== "string" || !/^[a-f0-9]{64}$/u.test(reference.digest) || record.scopeDigest !== reference.digest || current === undefined) {
      fail(reasonCode, `work ${record.id} scope reference is not resolvable`);
    }
    const previousScope = current.extensions[ADVISORY_SCOPE_KEY];
    if (previousScope === undefined || typeof previousScope.value !== "string" || workExtensionsDigest(current.extensions) !== reference.digest) {
      fail(reasonCode, `work ${record.id} scope reference does not match its predecessor`);
    }
    const extensions = { ...record.extensions, [ADVISORY_SCOPE_KEY]: previousScope } as WorkRecord["extensions"];
    if (workExtensionsDigest(extensions) !== record.scopeDigest) {
      fail(reasonCode, `work ${record.id} scope reference would change extensions`);
    }
    return { ...record, extensions };
  }
  if (record.scopeDigest !== null && record.scopeDigest !== undefined && record.scopeDigest !== workExtensionsDigest(record.extensions)) {
    fail(reasonCode, `work ${record.id} scope digest does not match extensions`);
  }
  return record;
}

function isMinutesId(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const separator = value.indexOf(":");
  if (separator < 0 || value.slice(0, separator) !== "minutes") {
    return false;
  }
  try {
    assertProtocolId(value);
  } catch {
    return false;
  }
  return true;
}

function advisoryHasMinutes(record: Pick<WorkRecord, "extensions">): boolean {
  const entry = record.extensions[ADVISORY_DECIDED_BY_KEY];
  return Array.isArray(entry?.value) && entry.value.length > 0 && entry.value.every((item) => isMinutesId(item));
}

function assertStoryCompletionAdmission(record: WorkRecord, targetStatus: WorkStatus): void {
  if (record.kind !== "Story" || targetStatus !== "done") return;
  const scope = storyScopeFromRecord(record);
  if (storyScopeNamesOwnerDecider(scope) && !advisoryHasMinutes(record)) {
    fail("WORKSPACE_OWNER_ACCEPTANCE_REQUIRED", "Owner-decided Story requires a decided-by minutes backlink before done");
  }
}

// Defence in depth on the advisory value shape. The terminal validateWorkGraph over the
// whole materialized set already proves each advisory entry is a required:false
// {required, value} pair under a valid protocol-id key (a required:true key would fail
// UNKNOWN_REQUIRED_EXTENSION because advisory keys carry no registry row); this adds the
// value semantics the extension map is deliberately agnostic about.
function assertAdvisoryEntryShape(key: string, entry: unknown, id: string, reasonCode: WorkspaceReasonCode): void {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail(reasonCode, `work ${id} advisory ${key} is malformed`);
  }
  const value = (entry as Readonly<Record<string, unknown>>).value;
  if (key === ADVISORY_SCOPE_KEY) {
    if (typeof value !== "string" || value.length === 0) {
      fail(reasonCode, `work ${id} advisory scope must be a non-empty string`);
    }
    return;
  }
  if (key === ADVISORY_SPRINT_KEY) {
    if (!isSprintReference(value)) {
      fail(reasonCode, `work ${id} advisory sprint must be a {workspaceId, workId} qualified reference`);
    }
    return;
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => isMinutesId(item))) {
    fail(reasonCode, `work ${id} advisory decided-by must be a non-empty list of minutes ids`);
  }
}

// The work.annotated guard: only the annotatable fields may differ from the prior
// revision, and at least one must. Every other extension entry stays byte-identical, so
// an annotation can neither introduce a foreign extension, drop one, nor alter it -- the
// same anti-smuggling shape the gate evidence path enforces with an exact comparison.
//
// TCRN-CROSS-INC-269: this was a replay-only guard, and the verb had no counterpart to
// it. The verb's own no-op check compared title and labels as well, so an annotation
// that moved only those -- neither is an extension -- passed the verb, appended, and
// then failed every later read of that workspace as WORKSPACE_EVENT_CORRUPT. Like
// assertGateClearance, the predicate now takes its reason code from the caller and runs
// on both paths: WORKSPACE_INPUT_INVALID on the verb, WORKSPACE_EVENT_CORRUPT in replay.
// One predicate, so the two cannot drift apart again.
//
// TCRN-CROSS-STORY-363 finishes that repair from the other end. INC-269 closed the hole
// by refusing a title-only annotation on both paths, which left title, labels and now
// summary writable only in the company of an advisory change -- and a summary backfill
// has no advisory change to make: it is not allowed to touch the scope it reads. So the
// "at least one moved" test now counts the three top-level annotatable fields alongside
// the advisory keys. This is a widening in the safe direction only: every event that
// replayed before still replays, an empty delta is still refused because nothing moved,
// and the non-advisory extension comparison below is untouched, so nothing new can be
// smuggled through. What becomes legal is exactly the write the verb was already the
// only producer of.
interface WorkAnnotationFields {
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly title: string | null;
  readonly summary: string | null;
  readonly labels: readonly string[];
}

function workAnnotationFields(record: WorkRecord): WorkAnnotationFields {
  return {
    extensions: record.extensions,
    title: record.title ?? null,
    summary: record.summary ?? null,
    labels: record.labels ?? [],
  };
}

function assertWorkAnnotation(
  current: WorkAnnotationFields,
  next: WorkAnnotationFields,
  id: string,
  reasonCode: WorkspaceReasonCode,
): void {
  const advisory = new Set(ADVISORY_KEYS);
  const keys = new Set([...Object.keys(current.extensions), ...Object.keys(next.extensions)]);
  let changed = current.title !== next.title || current.summary !== next.summary ||
    canonicalJson(current.labels as JsonValue) !== canonicalJson(next.labels as JsonValue);
  for (const key of keys) {
    const before = canonicalJson((current.extensions[key] ?? null) as JsonValue);
    const after = canonicalJson((next.extensions[key] ?? null) as JsonValue);
    if (!advisory.has(key)) {
      if (before !== after) {
        fail(reasonCode, `work ${id} annotation changed non-advisory extension ${key}`);
      }
      continue;
    }
    if (before !== after) {
      changed = true;
    }
    if (Object.hasOwn(next.extensions, key)) {
      assertAdvisoryEntryShape(key, next.extensions[key], id, reasonCode);
    }
  }
  if (!changed) {
    fail(reasonCode, `work ${id} annotation changed no annotatable field`);
  }
}

// WSD-4: the designated set is exactly "a transition whose target is done".
// cancelled/blocked/ready targets are exempt so cleanup can never wedge. A
// non-tombstoned unsatisfied gate anchored to the work item blocks the move. The
// identical predicate runs on the verb (WORKSPACE_GATE_PENDING) and in replay
// (WORKSPACE_EVENT_CORRUPT), so a hand-tampered log cannot bypass the live check.
//
// TCRN-CROSS-MIN-102 裁定一: this counted `pending` alone, while GATE_TRANSITIONS
// lets a gate move pending↔blocked freely and without evidence. Flipping a gate to
// blocked therefore *released* the work item — two legal commands took an
// unsatisfied gate out of the way of done, in a state whose name says the opposite.
// The predicate is now "not satisfied", which is what a gate means: satisfied is
// the only state reached by citing resolving minutes, and it is terminal. The
// documented deadlock escape is unchanged and is still the tombstone route, not
// blocked. No gate on this platform has ever held blocked, so the reducer side of
// this tightening is retroactive over an empty set here; for a foreign chain that
// did use it, replay now refuses a work record that was driven to done past a
// blocked gate, which is the defect being named rather than a new rule.
function assertGateClearance(gates: Iterable<GateRecord>, workId: string, targetStatus: string, reasonCode: WorkspaceReasonCode): void {
  if (targetStatus !== "done") {
    return;
  }
  const candidates = [...gates];
  // CQ-10b: counted full scan of the gate collection. The early return above means
  // it runs only on a transition whose target is done, and done is terminal, so it
  // fires at most once per work record rather than once per work.updated.
  recordCollectionScan(candidates.length);
  const blocking = candidates
    .filter((gate) => !gate.tombstone && gate.status !== "satisfied" && gate.workId === workId)
    .map((gate) => gate.id)
    .sort(compareCanonicalText);
  if (blocking.length > 0) {
    fail(reasonCode, `work ${workId} is blocked by pending gate(s) ${blocking.join(",")}`);
  }
}

function materialize(metadata: WorkspaceMetadata, events: readonly EventRecord[], snapshot?: ReplaySnapshotSeed): WorkspaceState {
  if (snapshot === undefined) {
    recordFullMaterialize();
  } else {
    recordSnapshotMaterialize();
  }
  const projects = new Map<string, ProjectRecord>((snapshot?.projects ?? []).map((record) => [record.id, record]));
  const work = new Map<string, WorkRecord>((snapshot?.work ?? []).map((record) => [record.id, record]));
  const conferences = new Map<string, ConferenceRequest>((snapshot?.conferences ?? []).map((record) => [record.id, record]));
  const conferencePositions = new Map<string, ConferencePosition>((snapshot?.conferencePositions ?? []).map((record) => [record.id, record]));
  const conferenceMinutes = new Map<string, ConferenceMinutes>((snapshot?.conferenceMinutes ?? []).map((record) => [record.id, record]));
  const gates = new Map<string, GateRecord>((snapshot?.gates ?? []).map((record) => [record.id, record]));
  const settings = new Map<string, WorkspaceSettingRecord>((snapshot?.settings ?? []).map((record) => [record.key, record]));
  let executionConfig: ExecutionConfigState = snapshot?.executionConfig ?? EMPTY_EXECUTION_CONFIG;
  const templates = new Map<string, TemplateAdmissionRecord>((snapshot?.templates ?? []).map((record) => [record.registrationId, record]));
  const workspaceRoot = metadata.roots.find((root) => root.kind === "workspace")?.path;
  let attestationEnabledAtSequence: number | null = snapshot?.attestationEnabledAtSequence ?? null;
  for (const event of events) {
    const payload = event.payload;
    if (!isJsonObject(payload) || typeof payload.operation !== "string") {
      fail("WORKSPACE_EVENT_CORRUPT", `event ${event.id} payload is invalid`);
    }
    // The operation is bound once so the string narrowing above survives into the
    // extension-record closures below, which re-read it.
    const operation: string = payload.operation;
    // WSE-2: the attestation.actor.enabled chain event turns mandatory actor
    // attestation on for itself and every later event; it is a control event that
    // touches no record graph, and a second one is a corrupt chain. Tracking it
    // inside the single event loop keeps validation one-pass and replay-order
    // exact — the enabling event carries the enabling actor and is the first that
    // requires one, so actorRequired is derived after this branch has run.
    if (operation === ACTOR_ATTESTATION_ENABLE_OPERATION) {
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
    if (templateOperations.has(operation)) {
      const record = extensionRecordOrCorrupt(() => validateTemplateAdmissionRecord(
        payloadRecord(payload, operation, actorRequired),
      ));
      requireEventBoundTimestamp(record.receipt.admittedAt, event, `template ${record.template.id}@${record.template.version}`);
      const key = `${record.template.id}@${record.template.version}`;
      if (templates.has(key)) fail("WORKSPACE_EVENT_CORRUPT", `duplicate template admission ${key}`);
      templates.set(key, record);
      continue;
    }
    if (projectOperations.has(operation)) {
      const record = validateProject(payloadRecord(payload, operation, actorRequired));
      const current = projects.get(record.id);
      if (record.updatedAt !== event.occurredAt) {
        fail("WORKSPACE_EVENT_CORRUPT", `project ${record.id} timestamp is not event-bound`);
      }
      if (operation === "project.created") {
        if (current || record.revision !== 1 || record.tombstone) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid project create ${record.id}`);
        }
      } else if (!current || current.tombstone || record.revision !== current.revision + 1 || record.externalKey !== current.externalKey ||
        (operation === "project.updated" && record.tombstone) || (operation === "project.deleted" && !record.tombstone)) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid project mutation ${record.id}`);
      }
      if (operation === "project.deleted") {
        // CQ-10b: counted full scan. Fires only on project.deleted, which is rare
        // and few in number, so its measured contribution is nil.
        recordCollectionScan(work.size);
        if ([...work.values()].some((entry) => entry.projectId === record.id && !entry.tombstone)) {
          fail("WORKSPACE_EVENT_CORRUPT", `project ${record.id} deletion precedes its live work`);
        }
      }
      projects.set(record.id, record);
      // WSA-2: a project event does not change the work graph; the only work->project
      // invariant it can break (a deleted project with live work) is checked above.
      continue;
    }
    if (workOperations.has(operation)) {
      const rawRecord = payloadRecord(payload, operation, actorRequired) as unknown as WorkRecord;
      const current = work.get(rawRecord.id);
      const record = resolveWorkRecord(rawRecord, current, "WORKSPACE_EVENT_CORRUPT");
      if (record.updatedAt !== event.occurredAt) {
        fail("WORKSPACE_EVENT_CORRUPT", `work ${record.id} timestamp is not event-bound`);
      }
      if (operation === "work.created") {
        if (current || record.revision !== 1 || record.tombstone) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid work create ${record.id}`);
        }
        // The honest createWork writes no advisory extension, but a hand-crafted or
        // tail-appended work.created could plant a malformed advisory:* value that the
        // envelope-only terminal graph validator would admit while the annotate path
        // rejects the identical bytes. Re-run the advisory value-shape check here so
        // create and annotate enforce one invariant and no forged create can smuggle a
        // bad advisory value in through the one door that used to skip it.
        for (const key of ADVISORY_KEYS) {
          if (Object.hasOwn(record.extensions, key)) {
            assertAdvisoryEntryShape(key, (record.extensions as Readonly<Record<string, unknown>>)[key], record.id, "WORKSPACE_EVENT_CORRUPT");
          }
        }
      } else if (!current || current.tombstone || record.revision !== current.revision + 1 || record.externalKey !== current.externalKey ||
        record.projectId !== current.projectId || record.kind !== current.kind || record.parentId !== current.parentId ||
        (operation === "work.updated" && record.tombstone) || (operation === "work.deleted" && !record.tombstone) ||
        (operation === "work.annotated" && record.tombstone)) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid work mutation ${record.id}`);
      }
      if (operation === "work.updated" && current) {
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
      // work.annotated (E05): not a transition -- status is unchanged and the only
      // extension delta is the advisory keys. Both invariants replay as
      // WORKSPACE_EVENT_CORRUPT so a hand-crafted annotation cannot smuggle a status
      // change or a foreign extension past the reducer.
      if (operation === "work.annotated" && current) {
        if (record.status !== current.status) {
          fail("WORKSPACE_EVENT_CORRUPT", `work ${record.id} annotation changed status`);
        }
        assertWorkAnnotation(workAnnotationFields(current), workAnnotationFields(record), record.id, "WORKSPACE_EVENT_CORRUPT");
      }
      extensionRecordOrCorrupt(() => validateBoundTemplateWork(record, [...templates.values()]));
      work.set(record.id, record);
      validateWorkClosure(work, projects, record, templateRegistry([...templates.values()]));
      continue;
    }
    if (conferenceOperations.has(operation)) {
      // WSD-1: conference reducer arms. Every check here is a bounded lookup
      // against the maps materialized so far — O(delta) per event, and no
      // work-closure metrics (the closure counters stay work-only).
      // CQ-10b correction: the gate arm below is not scan-free. A gate.satisfied
      // transition copies the whole conference and minutes maps to resolve its
      // evidence; that copy is counted by recordCollectionScan.
      if (operation === "conference.created") {
        const record = extensionRecordOrCorrupt(() => openConference(payloadRecord(payload, operation, actorRequired)));
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
      if (operation === "conference.updated") {
        const record = extensionRecordOrCorrupt(() => validateConferenceRequest(payloadRecord(payload, operation, actorRequired)));
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
      if (operation === "conference.position.appended") {
        const record = extensionRecordOrCorrupt(() => validateConferencePosition(payloadRecord(payload, operation, actorRequired)));
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
    if (gateOperations.has(operation)) {
      // WSD-1: gate reducer arms, O(delta) like the conference arms above.
      const record = extensionRecordOrCorrupt(() => validateGateRecord(payloadRecord(payload, operation, actorRequired)));
      requireEventBoundTimestamp(record.updatedAt, event, `gate ${record.id}`);
      if (operation === "gate.created") {
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
        (operation === "gate.updated" && record.tombstone) || (operation === "gate.deleted" && !record.tombstone)) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid gate mutation ${record.id}`);
      }
      // WSD-4: a gate.updated must walk the lifecycle graph, and a move to
      // satisfied must carry evidence that re-resolves here (parity with the
      // verb) and whose only extensions delta is the persisted locator entry.
      // gate.deleted keeps mutating tombstone alone; every other move pins
      // extensions, so a non-satisfied transition cannot smuggle in extensions.
      let gateMutableFields: readonly string[] = operation === "gate.updated" ? ["status", "revision", "updatedAt"] : ["tombstone", "revision", "updatedAt"];
      if (operation === "gate.updated") {
        if (!GATE_TRANSITIONS[current.status].includes(record.status)) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid gate transition ${record.id}`);
        }
        if (record.status === "satisfied") {
          const locator = readGateEvidenceLocator(record.extensions);
          // CQ-10b: counted collection copy. Two full copies fed to array .find while
          // the Maps are in hand; runs once per gate-satisfied transition, and only
          // once a locator is present (the undefined case short-circuits before the
          // copies are built, so it must not be counted).
          if (locator !== undefined) {
            recordCollectionScan(conferenceMinutes.size + conferences.size);
          }
          if (locator === undefined || !resolveGateEvidence(locator, current, [...conferenceMinutes.values()], [...conferences.values()])) {
            fail("WORKSPACE_EVENT_CORRUPT", `gate ${record.id} evidence does not resolve`);
          }
          // The identity entry is optional here and stays optional forever: replay has
          // no roster and cannot know whether one was required when this event was
          // written. What it can do without reading anything external is insist the
          // entry is well formed, and that the actor it names is the actor the event
          // was signed with -- a record that disagrees with itself is corrupt whoever
          // wrote it.
          let expectedExtensions = gateEvidenceExtensions(current.extensions, locator);
          const identityEntry = record.extensions[GATE_IDENTITY_KEY];
          if (identityEntry !== undefined) {
            const decision = extensionRecordOrCorrupt(() => validateGateIdentityDecision(
              (identityEntry as { readonly value?: unknown } | null)?.value,
            ));
            const signer = payload !== null && typeof payload === "object" && !Array.isArray(payload)
              ? (payload as Readonly<Record<string, JsonValue>>).actor
              : undefined;
            // Before attestation is enabled the payload carries no actor, so there is
            // nothing to contradict and the entry stands uncorroborated. That is worth
            // knowing rather than papering over: on such a chain the decision names an
            // actor the event itself does not, and only a deployment that enables
            // attestation gets the cross-check. Attestation stays a separate opt-in --
            // gating one irreversible setting behind another would be a worse trade.
            if (signer !== undefined && signer !== decision.actorId) {
              fail("WORKSPACE_EVENT_CORRUPT", `gate ${record.id} identity decision names ${decision.actorId} but the event was signed by ${String(signer)}`);
            }
            expectedExtensions = gateIdentityExtensions(expectedExtensions, decision);
          }
          if (canonicalJson(record.extensions) !== canonicalJson(expectedExtensions)) {
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
    if (settingsOperations.has(operation)) {
      const body = payloadRecord(payload, operation, actorRequired);
      if (operation === "settings.removed") {
        exactFields(body, ["key", "updatedAt"], "WORKSPACE_EVENT_CORRUPT", "setting removal record");
        if (typeof body.key !== "string" || typeof body.updatedAt !== "string") fail("WORKSPACE_EVENT_CORRUPT", "setting removal record is invalid");
        try { assertStrictInstant(body.updatedAt); } catch { fail("WORKSPACE_EVENT_CORRUPT", "setting removal timestamp is invalid"); }
        requireEventBoundTimestamp(body.updatedAt, event, `setting ${body.key}`);
        const current = settings.get(body.key);
        if (current === undefined) fail("WORKSPACE_EVENT_CORRUPT", `cannot remove unknown setting ${body.key}`);
        settings.delete(body.key);
        continue;
      }
      const record = extensionRecordOrCorrupt(() => validateWorkspaceSettingRecord(
        body,
        workspaceRoot,
      ));
      requireEventBoundTimestamp(record.updatedAt, event, `setting ${record.key}`);
      const current = settings.get(record.key);
      if ((current === undefined && record.revision !== 1) ||
        (current !== undefined && record.revision !== current.revision + 1) ||
        record.layerKind !== SETTINGS_LAYER_KIND || record.tombstone !== false) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid setting mutation ${record.key}`);
      }
      settings.set(record.key, record);
      continue;
    }
    if (executionOperations.has(operation)) {
      // INIT-026 S232: replay reuses the same apply functions the write path
      // used, so referential integrity is re-proved on every materialize; an
      // event sequence that violates it is a corrupt chain, not a soft state.
      const body = payloadRecord(payload, operation, actorRequired) as Record<string, unknown>;
      try {
        if (operation === "execution.persona.set") {
          const applied = body.schemaVersion === "tcrn.persona.v1"
            ? applyLegacyCustomPersonaSet(executionConfig, {
                schemaVersion: body.schemaVersion,
                id: body.id,
                name: body.name,
                description: body.description,
                role: body.role,
                prompt: body.prompt,
                revision: body.revision,
                updatedAt: String(body.updatedAt),
                tombstone: body.tombstone,
              })
            : applyCustomPersonaSet(executionConfig, {
                name: body.name,
                role: body.role,
                jobTitle: body.jobTitle,
                mission: body.mission,
                refusals: body.refusals,
                authorityBoundary: body.authorityBoundary,
                contactWhen: body.contactWhen,
                requiredInputs: body.requiredInputs,
                deliverables: body.deliverables,
                successCriteria: body.successCriteria,
                updatedAt: String(body.updatedAt),
              });
          requireEventBoundTimestamp(String(body.updatedAt), event, `persona ${String(body.name)}`);
          if (body.schemaVersion !== "tcrn.persona.v1" && canonicalJson(applied.record) !== canonicalJson(body)) fail("WORKSPACE_EVENT_CORRUPT", `persona ${applied.record.id} mutation record is not canonical`);
          executionConfig = applied.state;
        } else if (operation === "execution.persona.removed") {
          exactFields(body, ["name", "updatedAt"], "WORKSPACE_EVENT_CORRUPT", "persona removal record");
          if (typeof body.updatedAt !== "string") fail("WORKSPACE_EVENT_CORRUPT", "persona removal timestamp is invalid");
          requireEventBoundTimestamp(body.updatedAt, event, `persona ${String(body.name)}`);
          executionConfig = applyCustomPersonaRemove(executionConfig, { name: body.name });
        } else if (operation === "execution.model-plan.set") {
          const applied = applyModelPlanSetInExecutionConfig(executionConfig, {
            host: body.host,
            name: body.name,
            defaultModel: body.defaultModel,
            // STORY-282: replay has to carry every field the write carried, or the
            // reconstructed record differs from the stored body and the canonical
            // comparison below refuses the event as corrupt.
            ...(body.defaultEffort === undefined ? {} : { defaultEffort: body.defaultEffort }),
            updatedAt: String(body.updatedAt),
          });
          requireEventBoundTimestamp(String(body.updatedAt), event, `model plan ${String(body.name)}`);
          if (canonicalJson(applied.record) !== canonicalJson(body)) fail("WORKSPACE_EVENT_CORRUPT", `model plan ${String(body.name)} mutation record is not canonical`);
          executionConfig = applied.state;
        } else if (operation === "execution.model-plan.assigned") {
          const applied = applyModelPlanAssignInExecutionConfig(executionConfig, {
            host: body.host,
            name: body.name,
            persona: body.persona,
            model: body.model,
            ...(body.effort === undefined ? {} : { effort: body.effort }),
            updatedAt: String(body.updatedAt),
          });
          requireEventBoundTimestamp(String(body.updatedAt), event, `model plan assignment ${String(body.persona)}`);
          const canonicalBody = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "persona" && key !== "model" && key !== "effort"));
          if (canonicalJson(applied.record) !== canonicalJson(canonicalBody as unknown as JsonValue)) fail("WORKSPACE_EVENT_CORRUPT", "model plan assignment record is not canonical");
          executionConfig = applied.state;
        } else if (operation === "execution.model-plan.unassigned") {
          const applied = applyModelPlanUnassignInExecutionConfig(executionConfig, {
            host: body.host,
            name: body.name,
            persona: body.persona,
            updatedAt: String(body.updatedAt),
          });
          requireEventBoundTimestamp(String(body.updatedAt), event, `model plan unassignment ${String(body.persona)}`);
          const canonicalBody = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "persona"));
          if (canonicalJson(applied.record) !== canonicalJson(canonicalBody as unknown as JsonValue)) fail("WORKSPACE_EVENT_CORRUPT", "model plan unassignment record is not canonical");
          executionConfig = applied.state;
        } else if (operation === "execution.model-plan.removed") {
          exactFields(body, ["host", "name", "updatedAt"], "WORKSPACE_EVENT_CORRUPT", "model plan removal record");
          requireEventBoundTimestamp(String(body.updatedAt), event, `model plan ${String(body.name)}`);
          executionConfig = applyModelPlanRemoveInExecutionConfig(executionConfig, { host: body.host, name: body.name }, [...settings.values()]);
        } else if (operation === "execution.persona-preset.override") {
          const applied = applyPersonaPresetOverrideInExecutionConfig(executionConfig, {
            name: body.name,
            fields: body.fields as Readonly<Record<string, unknown>>,
            updatedAt: String(body.updatedAt),
          });
          requireEventBoundTimestamp(String(body.updatedAt), event, `persona preset ${String(body.name)}`);
          if (canonicalJson(applied.record) !== canonicalJson(body)) fail("WORKSPACE_EVENT_CORRUPT", "persona preset override is not canonical");
          executionConfig = applied.state;
        } else if (operation === "execution.persona-preset.restore") {
          exactFields(body, ["field", "name", "updatedAt"], "WORKSPACE_EVENT_CORRUPT", "persona preset restore record");
          requireEventBoundTimestamp(String(body.updatedAt), event, `persona preset ${String(body.name)}`);
          executionConfig = applyPersonaPresetRestoreInExecutionConfig(executionConfig, { name: body.name, field: body.field, updatedAt: String(body.updatedAt) });
        } else if (operation === "execution.persona-preset.removed") {
          exactFields(body, ["name", "updatedAt"], "WORKSPACE_EVENT_CORRUPT", "persona preset removal record");
          requireEventBoundTimestamp(String(body.updatedAt), event, `persona preset ${String(body.name)}`);
          executionConfig = applyPersonaPresetRemoveInExecutionConfig(executionConfig, { name: body.name });
        } else if (operation === "execution.configuration.set") {
          executionConfig = applyHostConfigSet(executionConfig, {
            host: body.host as ExecutionHost,
            name: validateConfigurationName(body.name),
            model: validateModel(body.model),
            note: validateNote(body.note),
            updatedAt: String(body.updatedAt),
          }).state;
        } else if (operation === "execution.configuration.removed") {
          executionConfig = applyHostConfigRemove(executionConfig, { host: body.host as ExecutionHost, name: validateConfigurationName(body.name) });
        } else if (operation === "execution.default.set") {
          executionConfig = applyHostConfigDefault(executionConfig, {
            host: body.host as ExecutionHost,
            configurationName: body.configurationName === null ? null : validateConfigurationName(body.configurationName),
            updatedAt: String(body.updatedAt),
          });
        } else if (operation === "execution.binding.set") {
          executionConfig = applyPersonaBindingSet(executionConfig, {
            profileId: String(body.profileId),
            host: body.host as ExecutionHost,
            configurationName: validateConfigurationName(body.configurationName),
            updatedAt: String(body.updatedAt),
          });
        } else {
          executionConfig = applyPersonaBindingRemove(executionConfig, { profileId: String(body.profileId), host: body.host as ExecutionHost });
        }
      } catch (error) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid execution mutation: ${String((error as Error).message ?? error)}`);
      }
      continue;
    }
    fail("WORKSPACE_EVENT_CORRUPT", `unknown operation ${operation}`);
  }
  const projectRecords = [...projects.values()].sort((left, right) => compareCanonicalText(left.id, right.id));
  recordTerminalGraphValidation();
  const templateRecords = [...templates.values()].sort((left, right) => compareCanonicalText(left.registrationId, right.registrationId));
  const workRecords = validateWorkGraph([...work.values()], templateRegistry(templateRecords));
  const settingRecords = sortWorkspaceSettings(settings.values());
  const engineRequirement = settingRecords.find((record) => record.key === "engine.requiredVersion");
  if (engineRequirement !== undefined && compareEngineVersions(FRAMEWORK_VERSION, engineRequirement.value) < 0) {
    throw new WorkspaceError(
      "WORKSPACE_ENGINE_VERSION_MISMATCH",
      `workspace requires engine version ${engineRequirement.value}; current engine version is ${FRAMEWORK_VERSION}`,
      { required: engineRequirement.value, actual: FRAMEWORK_VERSION },
    );
  }
  return {
    metadata,
    version: snapshot === undefined ? events.length : snapshot.version + events.length,
    headEventHash: events.at(-1)?.eventHash ?? snapshot?.headEventHash ?? null,
    projects: projectRecords,
    work: workRecords,
    conferences: sortExtensionRecords(conferences.values()),
    conferencePositions: sortExtensionRecords(conferencePositions.values()),
    conferenceMinutes: sortExtensionRecords(conferenceMinutes.values()),
    gates: sortExtensionRecords(gates.values()),
    settings: settingRecords,
    executionConfig,
    templates: templateRecords,
    events: snapshot === undefined ? events : [...snapshot.prefixEvents, ...events],
    attestationEnabledAtSequence,
  };
}

// INC-198: a view may not grow without bound. Both the graph digest and the index
// used to canonicalise the whole record set in one value, and `canonicalJson`
// refuses past one MiB — so a workspace that simply accumulated enough governed
// prose stopped being readable at all, because every read verifies its views. The
// cross-project chain crossed that line at 611 records (1.55 MiB canonical, 48%
// over) and could no longer validate, list, show, or export.
//
// Both replacements keep full detection power while staying linear in record
// count rather than in prose length. The digest hashes each record first and then
// hashes the vector of hashes: any byte that changes inside any record still
// changes the result. The index keeps every record's identity and status verbatim
// and carries each extension as the digest of its value — the extension's content
// is not lost, because views are derived and rebuildable and no read path sources
// prose from here (reads materialise from the event log). `.v2` marks the shape.
function digestedExtensions(extensions: WorkRecord["extensions"]): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const key of Object.keys(extensions).sort(compareCanonicalText)) {
    digests[key] = canonicalSha256(extensions[key]);
  }
  return digests;
}

// STORY-299. Hash each record, then hash the vector of hashes: any byte that
// changes inside any record still changes the result, and so does reordering two
// records, because the vector is not sorted or deduplicated. Unlike the shape
// above, the result does not grow with the collection -- which is the whole point.
//
// This is the single place the collection-summary shape is written. The work index
// still uses the per-record shape (STORY-302 carries that ceiling); when it moves,
// it moves by calling this, not by growing a second copy of the idea.
function collectionDigest(records: readonly unknown[]): string {
  return canonicalSha256(records.map((record) => canonicalSha256(record)));
}

// STORY-299. Measure, then serialise -- never the other way round. `canonicalJson`
// fails closed at the ceiling, so asking it first turns "this view is 40 KB over
// budget" into a bare refusal carrying no number, and turns the capacity meter
// into something that stops reading exactly when it matters.
function canonicalViewDocument(name: string, value: unknown, budgetBytes: number): string {
  const bytes = canonicalByteLength(value);
  if (bytes > budgetBytes) {
    fail("WORKSPACE_VIEW_BUDGET_EXCEEDED", `${name} projects to ${bytes} bytes against a ${budgetBytes} byte budget`);
  }
  return canonicalJson(value);
}

function summarisedCollection(records: readonly unknown[]): { readonly count: number; readonly digest: string } {
  return { count: records.length, digest: collectionDigest(records) };
}

// STORY-299. One writing of the view shapes, two readers of it: the projection
// below serialises them and enforces the budget, and the meter reports their size
// without enforcing anything. Keeping them apart is what lets `status` still
// answer on a workspace that has crossed the ceiling -- a gauge built out of the
// failing path would go silent exactly when it is needed.
type ViewSource =
  | { readonly name: string; readonly text: string }
  | { readonly name: string; readonly value: unknown };

function viewSources(state: WorkspaceState): readonly ViewSource[] {
  const activeProjects = state.projects.filter((record) => !record.tombstone);
  const activeWork = state.work.filter((record) => !record.tombstone);
  const graphDigest = canonicalSha256({
    projects: activeProjects.map((record) => canonicalSha256(record)),
    work: activeWork.map((record) => canonicalSha256(record)),
  });
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
  const sources: ViewSource[] = [
    { name: "STATUS.md", text: status },
    {
      name: "index.json",
      value: {
        schemaVersion: "tcrn.workspace-index.v2",
        projects: activeProjects,
        work: activeWork.map((record) => ({ ...record, extensions: digestedExtensions(record.extensions) })),
      },
    },
    { name: "readback.json", value: readback },
  ];
  // WSD-1: the extension index is a fourth view emitted ONLY when the workspace
  // holds at least one conference or gate record (positions and minutes cannot
  // exist without their conference), so the three views above and the view set
  // stay byte-identical for every workspace without extension records. STORY-299
  // does not touch that condition: the view set stays four, so no view is ever
  // orphaned and no deletion mechanism is owed.
  if (state.conferences.length + state.gates.length + state.settings.length + state.templates.length > 0) {
    // STORY-299: v2 is a fixed-length verification summary, not an index. v1 carried
    // every conference, position, minutes and gate record whole, so the file grew with
    // the governed prose written into the chain and crossed the one MiB canonical
    // ceiling at 532 records (INC-198), taking eight read verbs down with it.
    //
    // The shape deliberately does NOT copy what 0.11.17 did to the work index. That
    // fix keeps each record's identity and status verbatim and digests only the
    // extension bag, which removes the prose term but keeps the per-record one -- it
    // is linear, and measurement puts its own ceiling eight weeks out (STORY-302).
    // Applied literally here it would not even help: extension-record prose lives in
    // first-class fields rather than in an extension bag, so digesting the bag alone
    // grows this file by 537 bytes on the cross-project chain. What is copied is the
    // method -- hash each record, hash the vector, bump the schema version, keep no
    // compatibility read path -- not the target.
    //
    // Every collection follows the same rule, settings and templates included. An
    // exception for a collection that happens to be small today is how the linear
    // term comes back the day one of its fields grows.
    //
    // Nothing is lost: views are derived and rebuildable, no code anywhere parses
    // this file (its only readers are the byte-equality check in validateWorkspace
    // and an opaque copy in migration), and the prose is served from replay through
    // conference-position-list and conference-minutes-list. What is given up is
    // browsing identities by opening the file, which the helper payload already
    // advises against.
    const collections: Record<string, { readonly count: number; readonly digest: string }> = {
      conferences: summarisedCollection(state.conferences),
      conferencePositions: summarisedCollection(state.conferencePositions),
      conferenceMinutes: summarisedCollection(state.conferenceMinutes),
      gates: summarisedCollection(state.gates),
      ...(state.settings.length === 0 ? {} : { settings: summarisedCollection(state.settings) }),
      ...(state.templates.length === 0 ? {} : { templates: summarisedCollection(state.templates) }),
    };
    const digestsOnly: Record<string, string> = {};
    for (const key of Object.keys(collections).sort(compareCanonicalText)) {
      digestsOnly[key] = collections[key]?.digest ?? "";
    }
    sources.push({
      name: "extensions.json",
      value: {
        schemaVersion: "tcrn.workspace-extension-index.v2",
        ...collections,
        extensionsDigest: canonicalSha256(digestsOnly),
      },
    });
  }
  return sources;
}

function viewDocuments(state: WorkspaceState, budgetBytes: number = PROTOCOL_LIMITS.maxCanonicalBytes): Readonly<Record<string, string>> {
  const documents: Record<string, string> = {};
  for (const source of viewSources(state)) {
    if ("text" in source) {
      if (Buffer.byteLength(source.text, "utf8") > budgetBytes) {
        fail("WORKSPACE_VIEW_BUDGET_EXCEEDED", `${source.name} projects past a ${budgetBytes} byte budget`);
      }
      documents[source.name] = source.text;
      continue;
    }
    documents[source.name] = canonicalViewDocument(source.name, source.value, budgetBytes);
  }
  return documents;
}

export interface WorkspaceBudgetReport {
  readonly views: readonly {
    readonly name: string;
    readonly bytes: number;
    readonly limitBytes: number;
    readonly headroomBytes: number;
  }[];
  readonly maxSegmentBytes: number;
  readonly events: { readonly count: number; readonly limit: number; readonly headroomEvents: number };
}

/**
 * What is left before each ceiling, reported rather than judged.
 *
 * Every number here was a wall someone hit without warning first: the view ceiling
 * that locked eight read verbs (INC-198), the segment ceiling, and the record cap
 * -- which is the hardest of the three, because it is checked inside materialize
 * and so takes `status` and `recover` down with it rather than merely refusing
 * writes. Names only, never a host path.
 */
export function workspaceBudgets(state: WorkspaceState): WorkspaceBudgetReport {
  const limitBytes = PROTOCOL_LIMITS.maxCanonicalBytes;
  const views = viewSources(state).map((source) => {
    const bytes = "text" in source ? Buffer.byteLength(source.text, "utf8") : canonicalByteLength(source.value);
    return { name: source.name, bytes, limitBytes, headroomBytes: limitBytes - bytes };
  });
  let maxSegmentBytes = 0;
  if (state.metadata.storageVersion === WORKSPACE_LEGACY_STORAGE_VERSION) {
    const segmentLimit = state.metadata.segmentEventLimit;
    for (let start = 0; start < state.events.length; start += segmentLimit) {
      const bytes = canonicalByteLength(state.events.slice(start, start + segmentLimit));
      if (bytes > maxSegmentBytes) maxSegmentBytes = bytes;
    }
  } else {
    const segmentLimit = segmentBytesForState(state);
    let segmentBytes = 0;
    let segmentEvents = 0;
    for (const event of state.events) {
      const eventBytes = Buffer.byteLength(canonicalJson(event), "utf8");
      if (segmentEvents > 0 && segmentBytes + eventBytes > segmentLimit) {
        if (segmentBytes > maxSegmentBytes) maxSegmentBytes = segmentBytes;
        segmentBytes = 0;
        segmentEvents = 0;
      }
      segmentBytes += eventBytes;
      segmentEvents += 1;
    }
    if (segmentBytes > maxSegmentBytes) maxSegmentBytes = segmentBytes;
  }
  return {
    views,
    maxSegmentBytes,
    events: {
      count: state.events.length,
      limit: PROTOCOL_LIMITS.maxRecords,
      headroomEvents: PROTOCOL_LIMITS.maxRecords - state.events.length,
    },
  };
}

// STORY-299. The projection is a pure function of state and is now evaluated
// before anything is written; persistence is the half below. Splitting them is
// what lets a projection that cannot fit be refused with the chain untouched,
// while leaving the write loop -- and the crash point that four fault-injection
// cases and three crash tests are anchored on -- exactly where it was.
async function writeViewDocuments(
  workspaceRoot: string,
  documents: Readonly<Record<string, string>>,
  crashAt?: WorkspaceCrashPoint,
): Promise<void> {
  crash("before-view-commit", crashAt);
  const backend = backendFor(workspaceRoot);
  for (const name of Object.keys(documents).sort(compareCanonicalText)) {
    await backend.writeView(name, documents[name] ?? "");
  }
}

async function writeViews(workspaceRoot: string, state: WorkspaceState, crashAt?: WorkspaceCrashPoint): Promise<void> {
  await writeViewDocuments(workspaceRoot, viewDocuments(state), crashAt);
}

// STORY-299. A view that could not be persisted after the event was committed is
// news for the caller, not a failure of the call: the fact is durable, and saying
// otherwise is the defect INC-198 recorded, where a command reported rejection
// while its event sat in the chain and the agent's retry appended a second one.
//
// The signal travels out of band because the mutation path returns WorkspaceState
// and that type is the byte-equality contract with a fresh materialize -- widening
// it to carry an operational note would put a non-state field inside the thing the
// engine proves is pure state. The sink is cleared on entry to every append, and
// consumed exactly once by whichever receipt writer runs next.
interface ViewWriteFailure {
  readonly reasonCode: "WORKSPACE_VIEW_UNWRITTEN";
  readonly cause: string;
}

let pendingViewWriteFailure: ViewWriteFailure | null = null;

export function consumeViewWriteFailure(): ViewWriteFailure | null {
  const failure = pendingViewWriteFailure;
  pendingViewWriteFailure = null;
  return failure;
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
  // The prefix must match RESIDUE_PREFIX (workspace-snapshot.ts) and .gitignore, or a leaked
  // quarantine file is invisible to the residue gate, lands in the backup manifest, and can be
  // committed and shipped on clone. releaseRecoveryClaim already uses this prefix; both recovery
  // quarantines share it deliberately, and their tokens keep them distinct.
  const quarantine = controlPath(workspaceRoot, `released-recovery-${String(existing.owner.token)}`);
  // Re-verify immediately before the rename, as releaseRecoveryClaim does. Without this the
  // identity read that authorized the reclaim can be arbitrarily stale, so a claim recreated by a
  // live writer in the interval would be renamed away on the strength of a dead writer's stat.
  const current = await lstat(path).catch(() => fail("WORKSPACE_LOCKED", "stale recovery claim disappeared before reclaim"));
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameIdentity(current, existing.identity)) {
    fail("WORKSPACE_LOCKED", "recovery claim changed before reclaim");
  }
  try {
    await rename(path, quarantine);
  } catch {
    fail("WORKSPACE_LOCKED", "stale recovery claim was not exclusively reclaimable");
  }
  const moved = await lstat(quarantine);
  if (!sameIdentity(moved, existing.identity) || !moved.isFile() || moved.nlink !== 1) {
    // We renamed something other than the claim we checked -- a live writer recreated it in the
    // window. Put it back and report a lost race, not corruption: leaving a foreign live claim
    // displaced in quarantine under a non-retriable code is the double-reclaim the claim exists
    // to prevent. Restore failure is the genuinely unrecoverable case and keeps the hard code.
    try {
      await rename(quarantine, path);
    } catch {
      fail("WORKSPACE_LEASE_INVALID", "displaced recovery claim could not be restored");
    }
    fail("WORKSPACE_LOCKED", "recovery claim was recreated during reclaim");
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
  // D10: lease-inspect is admitted at a vacated or foreign address. It emits no
  // workspace content and cannot revive anything — it is pure diagnosis, and an
  // operator legitimately needs to see a stale lease on a dead tree. lease-break,
  // lease-recovery-break and lease acquisition are NOT admitted: each mutates the
  // control tree at an address the design has declared dead.
  await readMetadata(workspaceRoot, "any");
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
  // WSR-1 (D4): the relocation verbs need mutual exclusion at an address whose
  // ledger state is not `live` — adopt on an ADOPTION_REQUIRED tree, abort on a
  // VACATED one. They use the lease every other mutating verb uses rather than a
  // new claim file, which would mint a fifth member of EXCLUDED_RELATIVE_PATHS and
  // therefore a fifth thing the snapshot manifest is structurally blind to.
  // Omitted means "live", so no existing caller changes.
  readonly relocationAdmission?: WorkspaceAdmission;
  // INC-074: migration-execute is the one governed path allowed to take the
  // archive-side lease while it lays or removes the storage-home sentinel.
  // Ordinary file-backed mutations keep the strict sentinel refusal below.
  readonly storageHomeAdmission?: "migration";
}): Promise<WorkspaceLease> {
  assertStrictInstant(options.now);
  const nowNanoseconds = parseStrictInstant(options.now);
  const workspaceRoot = await boundDirectory(workspaceRootInput);
  // INC-074 storage-home gate: a workspace whose chain has migrated to Postgres
  // carries a sentinel declaring where the truth lives. When this process is
  // serving it via a file backend, the write door is closed: every mutating
  // verb refuses WORKSPACE_STORAGE_RELOCATED instead of forking the chain the way
  // ceremony.mjs did during the INIT-020 window. A sentinel that declares
  // storage=file stays writable (rollback's declared home); read-only verbs are
  // unaffected (archive forensics keep working, INC-083).
  const overrideBackendKind = activeOverrideBackendKind();
  if (overrideBackendKind !== "pg" && options.storageHomeAdmission !== "migration") {
    const home = await readStorageHomeDeclaration(workspaceRoot);
    if (home !== null && home.storage === "pg") {
      // TCRN-CROSS-INC-275: PostgreSQL support removed. A workspace previously
      // migrated to PG cannot be operated on.
      fail(
        "WORKSPACE_STORAGE_RELOCATED",
        `${workspaceRoot} was migrated to Postgres (storage-home: pg:${home.schema ?? "?"}); ` +
        "PostgreSQL storage is no longer supported. This workspace cannot be operated on.",
      );
    }
  }
  await readMetadata(workspaceRoot, options.relocationAdmission ?? "live");
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
    const token = await createLeaseOwner(leasePath, leaseDirectoryIdentity, options.now, nowNanoseconds, ttl);
    let released = false;
    return {
      workspaceRoot,
      token,
      acquiredAt: options.now,
      // The `this` parameter is erased at run time; it only states what the
      // method already relies on -- release is called as a member of the lease it
      // was returned on, which is what assertLease re-verifies below. Without it
      // `this` picks up the awaited return type's contextual union.
      async release(this: WorkspaceLease): Promise<void> {
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

// WSR-1 relocation kit. Three narrow functions the relocation verbs need and that
// no other caller should reach for. They are exported rather than duplicated
// because the alternative — a second metadata reader and a second atomic writer in
// workspace-relocation.ts — would put the platform's single most load-bearing
// read/write pair in two places, and the drift would be silent.

/** Read metadata at an explicit admission level, returning the bound root with it. */
export async function readWorkspaceMetadataAt(
  workspaceRootInput: string,
  admit: WorkspaceAdmission,
): Promise<{ readonly root: string; readonly metadata: WorkspaceMetadata }> {
  const root = await boundDirectory(workspaceRootInput);
  return { root, metadata: await readMetadata(root, admit) };
}

/**
 * The relocation commit point. Re-validates the metadata it is handed BEFORE
 * writing, so a malformed ledger can never reach disk, then goes through the same
 * atomicWrite (fsync → rename → identity verify → parent-dir sync) every other
 * control-tree write uses. A crash leaves the previous bytes untouched: the ledger
 * is never partially written, so no torn ledger is reachable (T19).
 */
export async function writeWorkspaceMetadataAt(
  workspaceRoot: string,
  metadata: WorkspaceMetadata,
  crashAt?: WorkspaceCrashPoint,
): Promise<string> {
  const text = canonicalJson(metadata);
  validateMetadata(assertCanonicalJson(text));
  await backendForStorage(workspaceRoot, metadata.storageVersion).writeMetadataBytes(Buffer.from(text, "utf8"), crashAt);
  return text;
}

/**
 * MEASURE, do not quote. Replays the whole chain at an address whose `roots` still
 * name another host — resolveWorkspace cannot be used there — and reports what the
 * tree itself says its version and head are.
 */
export async function measureWorkspaceChainAt(
  workspaceRoot: string,
  metadata: WorkspaceMetadata,
): Promise<{ readonly version: number; readonly headEventHash: string | null }> {
  const state = materialize(metadata, await readSegmentEvents(workspaceRoot, metadata));
  return { version: state.version, headEventHash: state.headEventHash };
}

/** The control-tree paths the relocation verbs assert on. */
export function workspaceControlPath(workspaceRoot: string, relativePath = ""): string {
  return controlPath(workspaceRoot, relativePath);
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
  readonly segmentBytes?: number;
  readonly storageVersion?: 1 | 2;
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
  const storageVersion = options.storageVersion ?? (options.segmentEventLimit === undefined ? WORKSPACE_STORAGE_VERSION : WORKSPACE_LEGACY_STORAGE_VERSION);
  const segmentEventLimit = storageVersion === WORKSPACE_LEGACY_STORAGE_VERSION
    ? options.segmentEventLimit ?? 64
    : options.segmentBytes ?? options.segmentEventLimit ?? WORKSPACE_SEGMENT_BYTES_DEFAULT;
  const segmentValid = storageVersion === WORKSPACE_LEGACY_STORAGE_VERSION
    ? Number.isSafeInteger(segmentEventLimit) && segmentEventLimit >= 2 && segmentEventLimit <= 1024
    : Number.isSafeInteger(segmentEventLimit) && segmentEventLimit >= WORKSPACE_SEGMENT_BYTES_MIN && segmentEventLimit <= WORKSPACE_SEGMENT_BYTES_MAX;
  if (!segmentValid) {
    fail("WORKSPACE_SCHEMA_INVALID", storageVersion === WORKSPACE_LEGACY_STORAGE_VERSION
      ? "segment event limit must be 2-1024"
      : `segment byte limit must be ${WORKSPACE_SEGMENT_BYTES_MIN}-${WORKSPACE_SEGMENT_BYTES_MAX}`);
  }
  const backend = backendForStorage(workspace.canonicalPath, storageVersion);
  try {
    await backend.createControlDirectory();
  } catch (error) {
    if (error instanceof StorageError && error.reasonCode === "WORKSPACE_ALREADY_EXISTS") {
      fail("WORKSPACE_ALREADY_EXISTS", controlPath(workspace.canonicalPath));
    }
    throw error;
  }
  await backend.ensureControlDirectory("events");
  await backend.ensureControlDirectory("views");
  await backend.ensureControlDirectory("backups");
  await backend.ensureControlDirectory(WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY);
  const metadata: WorkspaceMetadata = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    storageVersion,
    minimumStorageVersion: 1,
    maximumStorageVersion: storageVersion,
    workspaceId: deriveStableId("workspace", externalKey),
    externalKey,
    createdAt: options.createdAt,
    segmentEventLimit,
    roots,
  };
  await backend.writeMetadataBytes(Buffer.from(canonicalJson(metadata), "utf8"));
  const state = materialize(metadata, []);
  await writeViews(workspace.canonicalPath, state);
  return state;
}

async function resolveWorkspace(workspaceRootInput: string): Promise<{ readonly root: string; readonly metadata: WorkspaceMetadata }> {
  const root = await boundDirectory(workspaceRootInput);
  await assertSupportedWorkspaceFilesystem(root);
  await boundDirectory(controlPath(root), root);
  // INC-088: a PG-homed workspace keeps only its control metadata/sentinel on
  // the file side. Events, views, and backups are data-plane tables in the
  // injected PG backend; requiring their archived directories here made a
  // perfectly valid PG read fail with ENOENT and obscured the actual source of
  // truth. The ordinary file backend retains the original strict filesystem
  // checks. `withStorageBackendFactory` is the same seam used by the facade and
  // the equivalence suite; concrete backend kind, rather than merely an
  // override's presence, decides whether the PG data-plane directories are omitted.
  if (activeOverrideBackendKind() !== "pg") {
    await boundDirectory(controlPath(root, "events"), root);
    await boundDirectory(controlPath(root, "views"), root);
    await boundDirectory(controlPath(root, "backups"), root);
  }
  const metadata = await readMetadata(root);
  // WSR-1: the binding under test is the ACTIVE one, not the raw `roots` field.
  // After an adopt they differ: `roots` still names the host the tree came from,
  // and only the ledger says where it lives now.
  const binding = activeBinding(metadata);
  let canonicalRoots: readonly CanonicalRoot[];
  try {
    canonicalRoots = await assertDistinctRoots(binding.map((entry) => ({ kind: entry.kind, path: entry.path })));
  } catch (error) {
    fail("WORKSPACE_SCHEMA_INVALID", String((error as { message?: string }).message ?? error));
  }
  const storedRootsMatch = canonicalRoots.every((entry, index) => {
    const stored = binding[index];
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
  return materializeResolvedWorkspace(workspace);
}

async function materializeResolvedWorkspace(workspace: { readonly root: string; readonly metadata: WorkspaceMetadata }): Promise<WorkspaceState> {
  const snapshot = await readReplaySnapshot(workspace.root, workspace.metadata);
  if (snapshot === null) {
    return materialize(workspace.metadata, await readSegmentEvents(workspace.root, workspace.metadata));
  }
  const events = await readSegmentEvents(workspace.root, workspace.metadata, { snapshot });
  return materialize(workspace.metadata, events.slice(snapshot.version), { ...snapshot, prefixEvents: events.slice(0, snapshot.version) });
}

export async function validateWorkspace(workspaceRootInput: string, checkViews = true): Promise<WorkspaceState> {
  const state = await materializeWorkspace(workspaceRootInput);
  if (checkViews) {
    const expected = viewDocuments(state);
    const backend = backendForStorage(activeWorkspaceRoot(state.metadata) ?? "", state.metadata.storageVersion);
    for (const name of Object.keys(expected).sort(compareCanonicalText)) {
      let actual: Buffer;
      try {
        actual = await backend.readView(name);
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
export interface MutationDelta {
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
  readonly settings?: readonly WorkspaceSettingRecord[];
  readonly executionConfig?: ExecutionConfigState;
  readonly templates?: readonly TemplateAdmissionRecord[];
}

function segmentBytesForState(state: WorkspaceState): number {
  if (state.metadata.storageVersion === WORKSPACE_LEGACY_STORAGE_VERSION) {
    return state.metadata.segmentEventLimit;
  }
  const configured = state.settings.find((entry) => entry.key === "storage.segmentBytes")?.value;
  const value = configured === undefined ? state.metadata.segmentEventLimit : Number(configured);
  if (!Number.isSafeInteger(value) || value < WORKSPACE_SEGMENT_BYTES_MIN || value > WORKSPACE_SEGMENT_BYTES_MAX) {
    fail("WORKSPACE_SCHEMA_INVALID", "storage.segmentBytes is outside its declared bounds");
  }
  return value;
}

function backendKindForState(state: WorkspaceState): "file" | "file-segmented" {
  const configured = state.settings.find((entry) => entry.key === "storage.backend")?.value;
  if (configured === undefined || configured === "file-segmented") return "file-segmented";
  if (configured === "file") return "file";
  fail("WORKSPACE_SCHEMA_INVALID", `storage.backend has an unsupported value ${configured}`);
}

async function writeReplaySnapshot(state: WorkspaceState, backend: StorageBackend, force = false): Promise<void> {
  if ((!force && (state.version < 1 || state.version % snapshotIntervalForState(state) !== 0)) || backend.backendKind === "pg") return;
  await backend.ensureControlDirectory(WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY);
  const segmentEntries: ReplaySnapshotSegmentDigest[] = [];
  for (const name of await backend.listSegmentNames()) {
    const content = await backend.readSegment(name);
    segmentEntries.push({ name, bytes: content.length, sha256: sha256Bytes(content) });
  }
  const stateValue = replaySnapshotStateValue(state);
  const stateDigest = replaySnapshotDigest(stateValue);
  const compressed = deflateSync(Buffer.from(unboundedCanonicalJson(stateValue), "utf8"));
  const snapshotParts: string[] = [];
  for (let offset = 0; offset < compressed.length; offset += 900_000) {
    const partName = `${String(state.version).padStart(12, "0")}.part${String(snapshotParts.length + 1).padStart(4, "0")}`;
    snapshotParts.push(partName);
    await backend.writeControlFile(`${WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY}/${partName}`, compressed.subarray(offset, offset + 900_000));
  }
  const manifest: ReplaySnapshotManifest = {
    schemaVersion: WORKSPACE_REPLAY_SNAPSHOT_MANIFEST_VERSION,
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    snapshotParts,
    stateDigest,
    segments: segmentEntries,
  };
  // The state is committed first. A crash before the manifest write leaves the
  // old manifest authoritative; the manifest is replaced last and atomically,
  // so it can only name a complete snapshot file.
  await backend.writeControlFile(`${WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY}/${WORKSPACE_REPLAY_SNAPSHOT_MANIFEST}`, canonicalJson(manifest as unknown as JsonValue));
}

export async function rebuildReplaySnapshot(workspaceRootInput: string): Promise<Readonly<Record<string, JsonValue>>> {
  const workspace = await resolveWorkspace(workspaceRootInput);
  const state = await materializeResolvedWorkspace(workspace);
  const backend = backendForStorage(workspace.root, workspace.metadata.storageVersion, backendKindForState(state));
  await writeReplaySnapshot(state, backend, true);
  const checkpoint = await readReplaySnapshot(workspace.root, workspace.metadata);
  return {
    schemaVersion: "tcrn.workspace-replay-snapshot-rebuild.v1",
    version: state.version,
    headEventHash: state.headEventHash,
    ...(checkpoint?.manifest.snapshotParts === undefined ? { snapshot: checkpoint?.manifest.snapshot ?? null } : { snapshotParts: checkpoint.manifest.snapshotParts }),
  };
}

// STORY-300. One append and many appends are the same operation with a different
// count, so there is one implementation of it and `appendEvent` is the N=1 case.
//
// That framing is the point rather than a tidiness preference. A separate batch
// path would be a road only batches travel: it would rot quietly, because every
// existing verb -- all thirty-two of them -- would keep exercising the other one.
// Written this way, a defect in the batch path is a defect in every single write,
// which is the only arrangement that keeps both honest.
function committedFrom(
  prior: WorkspaceState,
  delta: MutationDelta,
  event: EventRecord,
  isEnableEvent: boolean,
  events: readonly EventRecord[],
): WorkspaceState {
  return {
    metadata: prior.metadata,
    version: event.sequence,
    headEventHash: event.eventHash,
    projects: delta.projects,
    work: delta.work,
    conferences: delta.conferences ?? prior.conferences,
    conferencePositions: delta.conferencePositions ?? prior.conferencePositions,
    conferenceMinutes: delta.conferenceMinutes ?? prior.conferenceMinutes,
    gates: delta.gates ?? prior.gates,
    settings: delta.settings ?? prior.settings,
    executionConfig: delta.executionConfig ?? prior.executionConfig,
    templates: delta.templates ?? prior.templates,
    events,
    attestationEnabledAtSequence: isEnableEvent ? event.sequence : prior.attestationEnabledAtSequence,
  };
}

export async function appendEvents(
  workspaceRootInput: string,
  lease: WorkspaceLease,
  buildDeltas: readonly ((state: WorkspaceState) => MutationDelta)[],
  options: WorkspaceMutationOptions,
): Promise<WorkspaceState> {
  // STORY-299: clear before the attempt, so a note left by an earlier command can
  // never be reported against this one.
  pendingViewWriteFailure = null;
  assertStrictInstant(options.occurredAt);
  if (buildDeltas.length === 0) {
    fail("WORKSPACE_INPUT_INVALID", "an append carries at least one event");
  }
  const workspace = await resolveWorkspace(workspaceRootInput);
  await assertLease(workspace.root, lease);
  const claim = await createMutationClaim(workspace.root, lease);
  try {
    await options.afterMutationClaimForTest?.();
    await assertLease(workspace.root, lease);
    // WSA-1: the single full replay per mutation. Input validation runs against
    // this claim-fresh state (via buildDelta), closing the entry-path TOCTOU gap.
    // A batch replays once too -- it is one mutation, so it takes one lease, one
    // claim, one replay, one concurrency decision and one clock reading.
    const state = await materializeResolvedWorkspace(workspace);
    if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion !== state.version) {
      fail("WORKSPACE_CAS_MISMATCH", `expected=${String(options.expectedVersion)} actual=${state.version}`);
    }
    const streamId = workspaceStreamId(workspace.metadata);
    const appended: EventRecord[] = [];
    let current = state;
    for (const [memberIndex, buildDelta] of buildDeltas.entries()) {
      // STORY-300 slice 3: appendEvents owns the member index because it is the only
      // thing that knows it. A caller counting completed members from outside cannot:
      // its counter advances when the closure returns, while actor injection and
      // createEvent below run afterwards and throw too, so a failure there would be
      // blamed on the member after the one that caused it. `phase` separates those,
      // because "the closure refused this member" and "the event this member produced
      // could not be built" are different facts about the same index.
      let phase: "delta" | "actor" | "event" = "delta";
      try {
      // Each member sees the state the members before it produced, which is what
      // makes an ordered batch express a dependency -- a parent created by member
      // one is there for member two.
      const delta = buildDelta(current);
      const sequence = current.version + 1;
      // WSE-2: actor injection is single-sourced here so every mutation verb only
      // forwards options.actorId (like occurredAt — no clock, no randomness). Once
      // attestation is enabled, or on the enabling event itself, a valid actor is
      // mandatory (WORKSPACE_ACTOR_REQUIRED) and validated (WORKSPACE_ACTOR_INVALID),
      // and it joins the hashed payload. Before enablement no actor is written even
      // when one is supplied — the default stays actor-optional and byte-identical
      // to rc.4 — so the enable event is the boundary. The reducer re-derives that
      // boundary and re-enforces the identical rule, so this write path cannot
      // outrun replay. In a batch the boundary is re-evaluated per member, so a
      // batch whose first member enables attestation requires an actor from its
      // second member onward -- the same rule replay will apply.
      phase = "actor";
      const deltaPayload = delta.payload;
      const isEnableEvent = isJsonObject(deltaPayload) && deltaPayload.operation === ACTOR_ATTESTATION_ENABLE_OPERATION;
      const actorRequired = current.attestationEnabledAtSequence !== null || isEnableEvent;
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
      phase = "event";
      const event = createEvent({
        id: workspaceEventId(streamId, sequence),
        streamId,
        sequence,
        occurredAt: options.occurredAt,
        priorHash: current.headEventHash,
        payload,
      });
      appended.push(event);
      current = committedFrom(current, delta, event, isEnableEvent, [...state.events, ...appended]);
      } catch (error) {
        // Attribution is attached, never substituted: the member's own reason code and
        // message are what a caller needs, and a wrapper that replaced them would be the
        // batch reporting its own opinion of a refusal it did not make.
        Object.assign(error as object, { memberIndex, memberPhase: phase });
        throw error;
      }
    }
    assertWorkspaceRecordCount(state.version + buildDeltas.length);
    // STORY-299. The committed state is pure computation over state, delta and the
    // new event, so it can be built -- and its views projected -- before a single
    // byte reaches the disk. Projecting here is what makes an over-budget view a
    // clean refusal: version has not moved, no segment exists, and the caller may
    // fix the cause and retry. Doing it after writeSegment is precisely how
    // INC-198's event seq 3842 came to exist under a command that reported failure.
    // A batch projects once, at its end: an intermediate state can be momentarily
    // over budget while the final one is not, so judging each member would refuse
    // batches that are perfectly legal.
    const documents = viewDocuments(current, options.viewBudgetBytes ?? PROTOCOL_LIMITS.maxCanonicalBytes);
    // Every segment's bytes are canonicalised before any of them is written. The
    // canonical form fails closed at one MiB, so computing them lazily would let
    // the first segment land and the second refuse -- the shape INC-198 recorded,
    // rebuilt one layer down.
    const backend = backendForStorage(workspace.root, workspace.metadata.storageVersion, backendKindForState(current));
    const writes = workspace.metadata.storageVersion === WORKSPACE_LEGACY_STORAGE_VERSION
      ? (() => {
        const limit = workspace.metadata.segmentEventLimit;
        const grouped = new Map<number, EventRecord[]>();
        for (const event of appended) {
          const index = Math.floor((event.sequence - 1) / limit) + 1;
          const list = grouped.get(index) ?? [];
          list.push(event);
          grouped.set(index, list);
        }
        // Ascending segment order is a hard invariant, not a preference: a non-final
        // segment left under-full reads as chain corruption, and that refusal lives
        // inside materialize, so writing a later segment first would take `status` and
        // `recover` down together.
        return [...grouped.keys()].sort((left, right) => left - right).map((index) => ({
          index,
          name: `${String(index).padStart(6, "0")}.json`,
          bytes: canonicalJson([...state.events.slice((index - 1) * limit, index * limit), ...(grouped.get(index) ?? [])]),
        }));
      })()
      : await (async () => {
        const limit = segmentBytesForState(current);
        const existingSegments = await backend.listSegmentNames();
        const lastExistingName = existingSegments.at(-1);
        let nextIndex = lastExistingName === undefined ? 0 : Number(lastExistingName.slice(0, 6));
        let currentName = lastExistingName ?? `${String(nextIndex + 1).padStart(6, "0")}.ndjson`;
        let currentBytes = lastExistingName === undefined ? 0 : (await backend.readSegment(lastExistingName)).length;
        const originalBytes = new Map<string, string>();
        const pending = new Map<string, string>();
        if (lastExistingName !== undefined) {
          originalBytes.set(lastExistingName, (await backend.readSegment(lastExistingName)).toString("utf8"));
        }
        for (const event of appended) {
          const eventBytes = Buffer.byteLength(canonicalJson(event), "utf8");
          if (currentBytes > 0 && currentBytes + eventBytes > limit) {
            nextIndex += 1;
            currentName = `${String(nextIndex).padStart(6, "0")}.ndjson`;
            currentBytes = 0;
          }
          const line = canonicalJson(event);
          pending.set(currentName, `${pending.get(currentName) ?? originalBytes.get(currentName) ?? ""}${line}`);
          currentBytes += eventBytes;
        }
        return [...pending.entries()].sort(([left], [right]) => compareCanonicalText(left, right)).map(([name, bytes]) => ({
          index: Number(name.slice(0, 6)),
          name,
          bytes,
        }));
      })();
    for (const write of writes) {
      await backend.writeSegment(write.name, Buffer.from(write.bytes, "utf8"), options.crashAt);
    }
    crash("after-event-commit", options.crashAt);
    // WSA-1: durability readback bounded to the just-committed segment replaces the
    // full-chain re-materialize; atomicWrite already fsync+rename+identity-verified,
    // and the chain was validated under this claim, so re-reading it wholesale was
    // redundant. The committed state is applied from the validated delta, and equals
    // a fresh materialize by construction.
    for (const write of writes) {
      const readback = await backend.readSegment(write.name);
      if (readback.toString("utf8") !== write.bytes) {
        fail("WORKSPACE_EVENT_CORRUPT", `segment ${write.index} readback mismatch`);
      }
    }
    await writeReplaySnapshot(current, backend);
    try {
      await writeViewDocuments(workspace.root, documents, options.crashAt);
    } catch (error) {
      // The projection already succeeded above, so a ProtocolError here is a bug in
      // this module rather than a capacity fact, and must stay loud. A fault
      // injection is a simulated process death: a dead process returns no receipt,
      // so swallowing it would make the crash tests assert the opposite of what
      // they were written to assert. Everything else -- including the Postgres
      // backend's own write errors, which are not StorageError and would slip
      // through a type-narrowed catch -- is a durable fact with an unwritten view.
      if (error instanceof ProtocolError) throw error;
      if (error instanceof WorkspaceError && error.reasonCode === "WORKSPACE_FAULT_INJECTED") throw error;
      pendingViewWriteFailure = {
        reasonCode: "WORKSPACE_VIEW_UNWRITTEN",
        cause: error instanceof WorkspaceError ? error.reasonCode : "WORKSPACE_VIEW_WRITE_FAILED",
      };
    }
    return current;
  } finally {
    await releaseMutationClaim(workspace.root, lease, claim);
  }
}

async function appendEvent(workspaceRootInput: string, lease: WorkspaceLease, buildDelta: (state: WorkspaceState) => MutationDelta, options: WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvents(workspaceRootInput, lease, [buildDelta], options);
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
    return { payload: { operation: "project.created", record: projectJsonFields(record) }, projects: sortedProjects([...state.projects, record]), work: state.work };
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
    return { payload: { operation: "project.updated", record: projectJsonFields(record) }, projects: sortedProjects(state.projects.map((entry) => entry.id === record.id ? record : entry)), work: state.work };
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
    return { payload: { operation: "project.deleted", record: projectJsonFields(record) }, projects: sortedProjects(state.projects.map((entry) => entry.id === record.id ? record : entry)), work: state.work };
  }, input);
}

// STORY-300 slice 3: createWork's delta, exposed so a batch can compose it. createWork
// already did all its validation inside the closure, so unlike transitionWork nothing
// moves -- this only gives the batch a handle on what the single verb already ran.
export function createWorkDelta(input: {
  readonly projectId: string;
  readonly externalKey: string;
  readonly kind: WorkKind;
  readonly parentId: string | null;
  readonly status?: WorkStatus;
  readonly scope?: string;
  readonly decidedBy?: readonly string[];
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly labels?: readonly string[];
  readonly templateAdmission?: unknown;
  readonly occurredAt: string;
}): (state: WorkspaceState) => MutationDelta {
  return (state) => createWorkReducerDelta(state, input);
}

export async function createWork(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly projectId: string;
  readonly externalKey: string;
  readonly kind: WorkKind;
  readonly parentId: string | null;
  readonly status?: WorkStatus;
  readonly scope?: string;
  readonly decidedBy?: readonly string[];
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly labels?: readonly string[];
  readonly templateAdmission?: unknown;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => createWorkReducerDelta(state, input), input);
}

function createWorkReducerDelta(state: WorkspaceState, input: {
  readonly projectId: string;
  readonly externalKey: string;
  readonly kind: WorkKind;
  readonly parentId: string | null;
  readonly status?: WorkStatus;
  readonly scope?: string;
  readonly decidedBy?: readonly string[];
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly labels?: readonly string[];
  readonly templateAdmission?: unknown;
  readonly occurredAt: string;
}): MutationDelta {
  const externalKey = canonicalExternalKey(input.externalKey);
  const id = deriveStableId("work", externalKey);
  {
    projectById(state, input.projectId);
    if (state.work.some((record) => record.id === id)) {
      fail("WORKSPACE_INPUT_INVALID", `work ${id} already exists`);
    }
    // WSA-3 (write-path admission, create side): a `done` Initiative may not
    // acquire a NEW live child. transitionWork already refuses to close an
    // Initiative that still holds live work; without this mirror the same
    // invariant is enforced only at the closing instant, so re-opening the
    // subtree afterwards is a create away and "done" stops meaning "finished".
    // Like its transition-side twin this lives in the reducer — the write path's
    // input validation — and NOT in validateWorkGraph, which replay runs over
    // every historical event and which therefore fail-closes chains that legally
    // closed an Initiative before the rule existed (TCRN-AOS-INC-048).
    if (input.parentId !== null) {
      const parent = state.work.find((record) => record.id === input.parentId);
      const status = input.status ?? "planned";
      if (parent && parent.kind === "Initiative" && parent.status === "done" && !parent.tombstone
        && status !== "done" && status !== "cancelled") {
        fail("WORKSPACE_INPUT_INVALID",
          `cannot add live work under Initiative ${parent.id}: it is already done`);
      }
    }
    if (input.kind === "Story" && input.scope === undefined) {
      fail("WORKSPACE_STORY_SCOPE_REQUIRED", "a new Story must carry its complete scope atomically");
    }
    if (input.scope !== undefined && input.scope.length === 0) {
      fail("WORKSPACE_STORY_SCOPE_REQUIRED", "Story scope must be a non-empty string");
    }
    if (input.decidedBy !== undefined && (input.decidedBy.length === 0 || !input.decidedBy.every((item) => isMinutesId(item)))) {
      fail("WORKSPACE_INPUT_INVALID", "advisory decided-by must be a non-empty list of minutes ids");
    }
    const title = normalizeWorkTitle(input.title);
    const labels = normalizeWorkLabels(input.labels ?? []);
    // TCRN-CROSS-STORY-363. An explicit --summary wins; otherwise the first
    // sentence of the Goal block, which is where the author already wrote the
    // one-line answer. A record with neither carries summary: null rather than
    // no field, so every record born after this change has one shape.
    const summary = input.summary === undefined
      ? deriveWorkSummary(input.scope, WORK_SUMMARY_MAX_BYTES)
      : normalizeWorkSummary(input.summary);
    const templateReceipt = input.templateAdmission === undefined
      ? undefined
      : validateTemplateAdmissionReceipt(input.templateAdmission);
    const templateRecord = templateReceipt === undefined
      ? undefined
      : templateRecordForBinding(state.templates, templateBindingFromReceipt(templateReceipt));
    if (templateReceipt !== undefined && (templateRecord === undefined || !templateRecordMatchesBinding(templateRecord, templateBindingFromReceipt(templateReceipt)))) {
      throw new TemplateAdmissionError("TEMPLATE_UNKNOWN", `${templateReceipt.templateId}@${templateReceipt.templateVersion}`);
    }
    if (templateRecord !== undefined && !templateRecord.template.appliesTo.includes(input.kind)) {
      throw new TemplateAdmissionError("TEMPLATE_NOT_APPLICABLE", `${templateRecord.template.id}:${input.kind}`);
    }
    const extensions: Record<string, unknown> = workAdvisoryExtensions({}, {
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.decidedBy !== undefined ? { decidedBy: input.decidedBy } : {}),
    });
    if (templateReceipt !== undefined && templateRecord !== undefined) {
      extensions[templateRecord.registrationId] = { required: true, value: templateBindingFromReceipt(templateReceipt) };
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
      extensions: extensions as WorkRecord["extensions"],
      scopeDigest: workExtensionsDigest(extensions),
      title,
      createdAt: input.occurredAt,
      labels,
      summary,
    };
    // A bound Story is governed by the admitted heading data, not by the
    // pre-template ten-heading parser.  Unbound records retain the legacy
    // validator so the pre-era exemption stays byte/replay compatible.
    if (record.kind === "Story" && templateRecord === undefined) {
      const compliance = validateStoryRecord(record);
      if (!compliance.ok) {
        fail("WORKSPACE_STORY_SCOPE_INVALID", describeStoryScopeProblems(compliance.problems));
      }
    }
    validateBoundTemplateWork(record, state.templates);
    assertStoryCompletionAdmission(record, record.status);
    const work = validateWorkGraph([...state.work, record], templateRegistry(state.templates));
    return { payload: { operation: "work.created", record: workJsonFields(record) }, projects: state.projects, work };
  }
}


/**
 * WSA-3 write-path admission: whether the subtree below `recordId` in `work`
 * holds any live non-terminal record, at any depth. Used only by transitionWork
 * when closing an Initiative to done — a tombstoned descendant holds no open
 * work and is skipped. Lives here (not in the protocol graph validator) so the
 * check fires on a live mutation, never on replay.
 */
function hasLiveNonTerminalDescendant(work: readonly WorkRecord[], recordId: string): boolean {
  for (const candidate of work) {
    if (candidate.parentId !== recordId) continue;
    if (candidate.tombstone) continue;
    if (candidate.status !== "done" && candidate.status !== "cancelled") return true;
    if (hasLiveNonTerminalDescendant(work, candidate.id)) return true;
  }
  return false;
}

// STORY-300 slice 3: both of transitionWork's admission rules, evaluated against a
// supplied state rather than against a freshly materialized one.
//
// They used to run before appendEvent, each re-materializing the persisted workspace.
// That is correct for a single transition and wrong inside a batch: a member closing a
// record an earlier member of the same batch created would read a workspace where it does
// not exist yet, and fail indistinguishably from the record genuinely not existing. It was
// also two full replays per transition, so a batch of N transitions built the naive way
// would pay 2N of them -- the batch's O(1) round-trip claim failing quietly inside a verb
// that looks batched from outside.
//
// Moving them into the delta closure is safe, and the safety is specific rather than
// assumed. The closure runs only on the write path: materialize() reconstructs state from
// stored event payloads and never receives or invokes it. What IS shared with replay is
// validateWorkGraph, which materialize calls over the reconstructed set -- and that is
// exactly what the WSA-3 comment below was warning about. A rule placed there would refuse
// a chain that legitimately closed an Initiative before 0.10.0 while descendants were open.
// A rule placed here fires on live mutations only, which is what it always did.
function assertTransitionAdmission(state: WorkspaceState, input: { readonly id: string; readonly status: WorkStatus }): void {
  // Scope is a live write-path admission rule. Historical chains remain replayable;
  // unbound Stories use the legacy ten-block contract, while a bound Story is checked
  // against its admitted template and the same engine floor before it enters an execution
  // or completion state.
  if (["ready", "active", "done"].includes(input.status)) {
    const current = workById(state, input.id);
    const templateBound = templateBindingFromWorkRecord(current) !== null;
    validateBoundTemplateWork(current, state.templates);
    if (current.kind === "Story" && !templateBound) {
      const compliance = validateStoryRecord(current);
      if (!compliance.ok) {
        const hasScope = storyScopeFromRecord(current) !== null;
        fail(hasScope ? "WORKSPACE_STORY_SCOPE_INVALID" : "WORKSPACE_STORY_SCOPE_REQUIRED",
          describeStoryScopeProblems(compliance.problems));
      }
    }
    assertStoryCompletionAdmission(current, input.status);
  }
  // WSA-3 (write-path admission): closing an Initiative to `done` is an act of
  // completion — its whole subtree must already be terminal, or the close is
  // premature. This must never reach validateWorkGraph, which replay runs over every
  // historical event: as write-path admission it fires only on a live "close this INIT"
  // mutation, so historical chains stay readable and the rule still holds going forward.
  // (A tombstoned descendant holds no open work.)
  if (input.status === "done") {
    const current = state.work.find((entry) => entry.id === input.id);
    if (current && current.kind === "Initiative" && !current.tombstone
      && hasLiveNonTerminalDescendant(state.work, current.id)) {
      fail("WORKSPACE_INPUT_INVALID",
        `cannot close Initiative ${input.id} to done: it still holds live non-terminal work`);
    }
  }
}

export function transitionWorkDelta(input: { readonly id: string; readonly status: WorkStatus; readonly summary?: string | null; readonly occurredAt: string }): (state: WorkspaceState) => MutationDelta {
  return (state) => {
    assertTransitionAdmission(state, input);
    return transitionWorkReducerDelta(state, input);
  };
}

export async function transitionWork(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly id: string;
  readonly status: WorkStatus;
  readonly summary?: string | null;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    assertTransitionAdmission(state, input);
    return transitionWorkReducerDelta(state, input);
  }, input);
}

function transitionWorkReducerDelta(state: WorkspaceState, input: { readonly id: string; readonly status: WorkStatus; readonly summary?: string | null; readonly occurredAt: string }): MutationDelta {
  {
    const current = workById(state, input.id);
    assertWorkTransition(current.status, input.status);
    // WSD-4: a non-tombstoned pending gate anchored to this work item blocks a
    // transition whose target is done (the designated set); the reducer replays
    // the identical predicate as WORKSPACE_EVENT_CORRUPT.
    assertGateClearance(state.gates, current.id, input.status, "WORKSPACE_GATE_PENDING");
    // TCRN-CROSS-STORY-363. The closing sentence is written at the transition
    // that closes the record, which is the only moment it can be true. Omitting
    // --summary keeps whatever the record already carries -- including carrying
    // no summary field at all, which is how a pre-363 record stays byte-identical
    // through a transition instead of acquiring a null nobody wrote.
    const summarised: WorkRecord = input.summary === undefined
      ? workFieldsForWrite(current)
      : { ...workFieldsForWrite(current), summary: normalizeWorkSummary(input.summary) };
    const record: WorkRecord = { ...summarised, status: input.status, revision: current.revision + 1, updatedAt: input.occurredAt };
    validateBoundTemplateWork(record, state.templates);
    const work = validateWorkGraph(state.work.map((entry) => entry.id === record.id ? record : entry), templateRegistry(state.templates));
    const storedRecord: WorkRecord = { ...record, extensions: workEventExtensions(record, true) };
    return { payload: { operation: "work.updated", record: workJsonFields(storedRecord) }, projects: state.projects, work };
  }
}

// E05 (scope-on-record): attach advisory fields to a live work record. It never changes
// status and never touches a gate, so an annotation cannot advance, block, or unblock
// work; the transition path separately enforces Story scope and Owner acceptance.
// validateWorkGraph re-validates the merged extensions (rejecting a
// required:true advisory key, which carries no registry row), and the reducer replays
// the advisory-only delta as WORKSPACE_EVENT_CORRUPT.
// STORY-300 slice 3: annotateWork's delta, exposed so a batch can compose it. Like
// createWork and unlike transitionWork, all of its validation already lived inside the
// closure, so nothing moves across the replay boundary here.
export function annotateWorkDelta(input: {
  readonly id: string;
  readonly scope?: string;
  readonly decidedBy?: readonly string[];
  readonly sprint?: SprintReference;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly labels?: readonly string[];
  readonly occurredAt: string;
}): (state: WorkspaceState) => MutationDelta {
  return (state) => annotateWorkReducerDelta(state, input);
}

export async function annotateWork(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly id: string;
  readonly scope?: string;
  readonly decidedBy?: readonly string[];
  readonly sprint?: SprintReference;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly labels?: readonly string[];
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => annotateWorkReducerDelta(state, input), input);
}

function annotateWorkReducerDelta(state: WorkspaceState, input: {
  readonly id: string;
  readonly scope?: string;
  readonly decidedBy?: readonly string[];
  readonly sprint?: SprintReference;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly labels?: readonly string[];
  readonly occurredAt: string;
}): MutationDelta {
  {
    const current = workById(state, input.id);
    if (current.tombstone) {
      fail("WORKSPACE_INPUT_INVALID", `work ${input.id} is deleted`);
    }
    if (input.scope === undefined && input.decidedBy === undefined && input.sprint === undefined && input.title === undefined && input.summary === undefined && input.labels === undefined) {
      fail("WORKSPACE_INPUT_INVALID", "an annotation must set scope, decided-by, sprint, title, summary, or labels");
    }
    if (input.scope !== undefined && input.scope.length === 0) {
      fail("WORKSPACE_INPUT_INVALID", "advisory scope must be a non-empty string");
    }
    if (input.decidedBy !== undefined && (input.decidedBy.length === 0 || !input.decidedBy.every((item) => isMinutesId(item)))) {
      fail("WORKSPACE_INPUT_INVALID", "advisory decided-by must be a non-empty list of minutes ids");
    }
    if (input.sprint !== undefined && !isSprintReference(input.sprint)) {
      fail("WORKSPACE_INPUT_INVALID", "advisory sprint must be a {workspaceId, workId} qualified reference");
    }
    const title = input.title === undefined ? current.title ?? null : normalizeWorkTitle(input.title);
    const labels = input.labels === undefined ? current.labels ?? [] : normalizeWorkLabels(input.labels);
    // TCRN-CROSS-STORY-363. This is the door the historical backfill goes through:
    // an annotation may set the summary of a record that has no summary field, and
    // that is the only way a pre-363 record acquires one -- by an event that says
    // who wrote it and when, not by a replay-time default.
    const summary = input.summary === undefined ? current.summary : normalizeWorkSummary(input.summary);
    const extensions = workAdvisoryExtensions(current.extensions, {
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.decidedBy !== undefined ? { decidedBy: input.decidedBy } : {}),
      ...(input.sprint !== undefined ? { sprint: input.sprint } : {}),
    });
    // TCRN-CROSS-INC-269: the reducer's own predicate, run before the event exists.
    // title, labels and summary are top-level work fields rather than extensions, so an
    // annotation that moved only them once satisfied a separate no-op check here and
    // failed the reducer -- the write returned a complete receipt and every later read of
    // the workspace came back WORKSPACE_EVENT_CORRUPT, with recover no help because the
    // log was intact and the appended record was the damage. There is now one predicate
    // and no second no-op comparison beside it: a duplicate that agreed with the reducer
    // would mask this call's removal, and a duplicate that disagreed would recreate
    // INC-269 exactly. TCRN-CROSS-STORY-363.
    assertWorkAnnotation(
      workAnnotationFields(current),
      { extensions, title, summary: summary ?? null, labels },
      input.id,
      "WORKSPACE_INPUT_INVALID",
    );
    const record: WorkRecord = {
      ...workFieldsForWrite(current),
      extensions: extensions as WorkRecord["extensions"],
      scopeDigest: workExtensionsDigest(extensions),
      title,
      labels,
      ...(summary === undefined ? {} : { summary }),
      revision: current.revision + 1,
      updatedAt: input.occurredAt,
    };
    const templateBound = templateBindingFromWorkRecord(record) !== null;
    if (record.kind === "Story" && input.scope !== undefined && !templateBound) {
      const compliance = validateStoryRecord(record);
      if (!compliance.ok) {
        fail("WORKSPACE_STORY_SCOPE_INVALID", describeStoryScopeProblems(compliance.problems));
      }
    }
    validateBoundTemplateWork(record, state.templates);
    const work = validateWorkGraph(state.work.map((entry) => entry.id === record.id ? record : entry), templateRegistry(state.templates));
    return { payload: { operation: "work.annotated", record: workJsonFields(record) }, projects: state.projects, work };
  }
}


export async function deleteWork(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly id: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const current = workById(state, input.id);
    const record: WorkRecord = { ...workFieldsForWrite(current), revision: current.revision + 1, updatedAt: input.occurredAt, tombstone: true };
    validateBoundTemplateWork(record, state.templates);
    const work = validateWorkGraph(state.work.map((entry) => entry.id === record.id ? record : entry), templateRegistry(state.templates));
    const storedRecord: WorkRecord = { ...record, extensions: workEventExtensions(record, true) };
    return { payload: { operation: "work.deleted", record: workJsonFields(storedRecord) }, projects: state.projects, work };
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
  // WSE-3 correction: this is the position's author, which is a different thing from the
  // attestation actor that WorkspaceMutationOptions carries. Both used to be spelled
  // actorId, and because this type intersects with those options the two collapsed into
  // one property -- so supplying an attestation actor silently overwrote the author of
  // the record being written, with no error and no way for a caller to express both.
  readonly authorActorId: string;
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
    // MIN-102 裁定四. The deployment's own writing budget for a position, read the way
    // execution.independenceFloor is read: on the write path, from the state this
    // mutation is building on. Replay never consults it — CONFERENCE_POSITION_CEILING_BYTES
    // is the only bound a record's validity depends on — so lowering this setting can
    // never invalidate a position already on the chain, and raising it can never admit
    // one the ceiling would refuse. The reason code is the budget's own, because from
    // the writer's side this is the same event: the position did not fit.
    const positionBudget = Number(
      state.settings.find((entry) => entry.key === "conference.positionBudgetBytes")?.value
        ?? settingsCatalogEntry("conference.positionBudgetBytes").defaultValue,
    );
    if (Buffer.byteLength(input.position, "utf8") > positionBudget) {
      throw new ConferenceError("CONFERENCE_BUDGET_EXCEEDED", `position exceeds conference.positionBudgetBytes=${positionBudget}`);
    }
    const record = appendConferencePosition({
      schemaVersion: CONFERENCE_POSITION_VERSION,
      id,
      conferenceId: conference.id,
      projectId: conference.projectId,
      actorId: input.authorActorId,
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
  readonly executionForm?: string | undefined;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const minutesId = deriveStableId("minutes", canonicalExternalKey(input.minutesExternalKey));
  return appendEvent(workspaceRoot, lease, (state) => {
    const conference = openConferenceById(state, input.conferenceId);
    if (state.conferenceMinutes.some((entry) => entry.id === minutesId)) {
      fail("WORKSPACE_INPUT_INVALID", `conference minutes ${minutesId} already exist`);
    }
    // INIT-026 S234: where the workspace's independence floor covers this
    // conference's type, the close must declare an independent execution form.
    // The declaration is a self-report, validated for presence and value and
    // never for truth — the same authorization-not-authentication ceiling
    // gate-identity states about itself; see CONFERENCE_EXECUTION_FORMS.
    if (input.executionForm !== undefined && !(CONFERENCE_EXECUTION_FORMS as readonly string[]).includes(input.executionForm)) {
      fail("WORKSPACE_INPUT_INVALID", `execution-form must be one of ${CONFERENCE_EXECUTION_FORMS.join(", ")}`);
    }
    const independenceFloor = state.settings.find((entry) => entry.key === "execution.independenceFloor")?.value ?? "none";
    if (independenceFloorCovers(independenceFloor, conference.type) && input.executionForm !== "independent") {
      fail("CONFERENCE_INDEPENDENCE_REQUIRED",
        `execution.independenceFloor=${independenceFloor} covers type=${conference.type}; close requires --execution-form independent`);
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
      // The extension mechanism's native shape: a protocol-id key carrying a
      // {required, value} declaration. required:false so a reader that does not
      // know this key is never forced to interpret it.
      extensions: input.executionForm === undefined ? {} : { "conference:execution-form": { required: false, value: input.executionForm } },
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

// INIT-027 S238. Custom personas are content records on the same governed
// execution surface. Their ids are derived from names inside persona-store.ts;
// callers provide the human name and the event carries the validated record.
export async function setCustomPersonaInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly name: unknown;
  readonly role: unknown;
  readonly jobTitle?: unknown;
  readonly mission?: unknown;
  readonly refusals?: unknown;
  readonly authorityBoundary?: unknown;
  readonly contactWhen?: unknown;
  readonly requiredInputs?: unknown;
  readonly deliverables?: unknown;
  readonly successCriteria?: unknown;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const applied = applyCustomPersonaSet(state.executionConfig, {
      name: input.name,
      role: input.role,
      jobTitle: input.jobTitle,
      mission: input.mission,
      refusals: input.refusals,
      authorityBoundary: input.authorityBoundary,
      contactWhen: input.contactWhen,
      requiredInputs: input.requiredInputs,
      deliverables: input.deliverables,
      successCriteria: input.successCriteria,
      updatedAt: input.occurredAt,
    });
    return {
      payload: buildEventPayload("execution.persona.set", applied.record as unknown as JsonValue),
      projects: state.projects,
      work: state.work,
      executionConfig: applied.state,
    };
  }, input);
}

export async function setModelPlanInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly host: string; readonly name: string; readonly defaultModel: string; readonly defaultEffort?: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const applied = applyModelPlanSetInExecutionConfig(state.executionConfig, { ...input, updatedAt: input.occurredAt });
    return { payload: buildEventPayload("execution.model-plan.set", applied.record as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: applied.state };
  }, input);
}

export async function assignModelPlanInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly host: string; readonly name: string; readonly persona: string; readonly model: string; readonly effort?: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const applied = applyModelPlanAssignInExecutionConfig(state.executionConfig, { ...input, updatedAt: input.occurredAt });
    return { payload: buildEventPayload("execution.model-plan.assigned", { ...applied.record, persona: input.persona, model: input.model, ...(input.effort === undefined ? {} : { effort: input.effort }) } as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: applied.state };
  }, input);
}

export async function unassignModelPlanInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly host: string; readonly name: string; readonly persona: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const applied = applyModelPlanUnassignInExecutionConfig(state.executionConfig, { ...input, updatedAt: input.occurredAt });
    return { payload: buildEventPayload("execution.model-plan.unassigned", { ...applied.record, persona: input.persona } as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: applied.state };
  }, input);
}

export async function removeModelPlanInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly host: string; readonly name: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => ({
    payload: buildEventPayload("execution.model-plan.removed", { host: input.host, name: input.name, updatedAt: input.occurredAt } as unknown as JsonValue),
    projects: state.projects,
    work: state.work,
    executionConfig: applyModelPlanRemoveInExecutionConfig(state.executionConfig, { host: input.host, name: input.name }, state.settings),
  }), input);
}

export async function overridePersonaPresetInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly name: string; readonly fields: Readonly<Record<string, unknown>>;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const applied = applyPersonaPresetOverrideInExecutionConfig(state.executionConfig, { ...input, updatedAt: input.occurredAt });
    return { payload: buildEventPayload("execution.persona-preset.override", applied.record as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: applied.state };
  }, input);
}

export async function restorePersonaPresetInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly name: string; readonly field?: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const field = input.field ?? "";
    const next = applyPersonaPresetRestoreInExecutionConfig(state.executionConfig, { name: input.name, field, updatedAt: input.occurredAt });
    return { payload: buildEventPayload("execution.persona-preset.restore", { name: input.name, field, updatedAt: input.occurredAt } as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: next };
  }, input);
}

export async function removePersonaInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly name: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const isPreset = state.executionConfig.personaTombstones.includes(input.name) || state.executionConfig.personas.every((persona) => persona.name !== input.name);
    if (isPreset) {
      return { payload: buildEventPayload("execution.persona-preset.removed", { name: input.name, updatedAt: input.occurredAt } as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: applyPersonaPresetRemoveInExecutionConfig(state.executionConfig, { name: input.name }) };
    }
    return { payload: buildEventPayload("execution.persona.removed", { name: input.name, updatedAt: input.occurredAt } as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: applyCustomPersonaRemove(state.executionConfig, { name: input.name }) };
  }, input);
}

export async function removeCustomPersonaInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly name: unknown;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => ({
    payload: buildEventPayload("execution.persona.removed", {
      name: input.name as JsonValue,
      updatedAt: input.occurredAt,
    } as JsonValue),
    projects: state.projects,
    work: state.work,
    executionConfig: applyCustomPersonaRemove(state.executionConfig, { name: input.name }),
  }), input);
}

// INIT-026 S232. Five verbs, one event each: an audit trail where "the default
// moved" is one legible line, never a diff of a rewritten blob. Validation and
// referential integrity run in the apply functions, against the claim-fresh
// state, and the SAME functions run again on every replay.
export async function setHostConfigurationInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly host: string; readonly name: string; readonly model: string; readonly note: string | null;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertExecutionHost(input.host);
  return appendEvent(workspaceRoot, lease, (state) => {
    const applied = applyHostConfigSet(state.executionConfig, {
      host: input.host as ExecutionHost,
      name: validateConfigurationName(input.name),
      model: validateModel(input.model),
      note: validateNote(input.note),
      updatedAt: input.occurredAt,
    });
    return {
      payload: buildEventPayload("execution.configuration.set", {
        host: input.host, name: input.name, model: input.model, note: validateNote(input.note), updatedAt: input.occurredAt,
      } as unknown as JsonValue),
      projects: state.projects, work: state.work, executionConfig: applied.state,
    };
  }, input);
}

export async function removeHostConfigurationInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly host: string; readonly name: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertExecutionHost(input.host);
  return appendEvent(workspaceRoot, lease, (state) => ({
    payload: buildEventPayload("execution.configuration.removed", {
      host: input.host, name: input.name, updatedAt: input.occurredAt,
    } as unknown as JsonValue),
    projects: state.projects, work: state.work,
    executionConfig: applyHostConfigRemove(state.executionConfig, { host: input.host as ExecutionHost, name: validateConfigurationName(input.name) }),
  }), input);
}

export async function setHostDefaultInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly host: string; readonly configurationName: string | null;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertExecutionHost(input.host);
  return appendEvent(workspaceRoot, lease, (state) => ({
    payload: buildEventPayload("execution.default.set", {
      host: input.host, configurationName: input.configurationName, updatedAt: input.occurredAt,
    } as unknown as JsonValue),
    projects: state.projects, work: state.work,
    executionConfig: applyHostConfigDefault(state.executionConfig, {
      host: input.host as ExecutionHost,
      configurationName: input.configurationName === null ? null : validateConfigurationName(input.configurationName),
      updatedAt: input.occurredAt,
    }),
  }), input);
}

export async function setPersonaBindingInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly profileId: string; readonly host: string; readonly configurationName: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertExecutionHost(input.host);
  return appendEvent(workspaceRoot, lease, (state) => ({
    payload: buildEventPayload("execution.binding.set", {
      profileId: input.profileId, host: input.host, configurationName: input.configurationName, updatedAt: input.occurredAt,
    } as unknown as JsonValue),
    projects: state.projects, work: state.work,
    executionConfig: applyPersonaBindingSet(state.executionConfig, {
      profileId: input.profileId, host: input.host as ExecutionHost,
      configurationName: validateConfigurationName(input.configurationName), updatedAt: input.occurredAt,
    }),
  }), input);
}

export async function removePersonaBindingInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly profileId: string; readonly host: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertExecutionHost(input.host);
  return appendEvent(workspaceRoot, lease, (state) => ({
    payload: buildEventPayload("execution.binding.removed", {
      profileId: input.profileId, host: input.host, updatedAt: input.occurredAt,
    } as unknown as JsonValue),
    projects: state.projects, work: state.work,
    executionConfig: applyPersonaBindingRemove(state.executionConfig, { profileId: input.profileId, host: input.host as ExecutionHost }),
  }), input);
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
  readonly identityAuthority?: GateIdentityAuthorityContext;
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
      // gate-v1: a gate created as owner_intent_required declares that closing it takes
      // owner intent. Until now that declaration was inert -- whichever actor ran the
      // command could satisfy it. The class is the opt-in: a deployment that does not
      // want identity checked creates the gate as role_decision instead, and the choice
      // is made per gate by whoever creates it, so no chain-wide switch is needed.
      // (This used to say "four other classes". Since TCRN-CROSS-MIN-102 裁定三 the write
      // path mints two, so the opt-out is one named alternative rather than a set. The
      // mechanism is unchanged; the count in the sentence was not.)
      //
      // Enforcement lives here, at the verb, and deliberately not on replay. Replay must
      // rebuild a chain on a machine that has never seen the roster -- a clone, a restore
      // years later, an auditor's laptop -- and a chain whose readability depended on an
      // external file still being present would brick on ordinary key rotation.
      //
      // What that costs is stated rather than implied: this is a decision-point control,
      // not a chain-integrity invariant. Event hashes are unkeyed, so whoever can write
      // the log can append a satisfied gate that replays clean, and no check that reads
      // only the log can tell that from a genuine one.
      if (current.outcomeClass === "owner_intent_required") {
        if (input.identityAuthority === undefined) {
          fail("WORKSPACE_GATE_IDENTITY_REQUIRED", `gate ${current.id} is ${current.outcomeClass} and requires an out-of-band identity authority`);
        }
        if (input.actorId === undefined) {
          // Refusing an unnamed actor is not pedantry: permitting is a statement about
          // who, and there is no who to check.
          fail("WORKSPACE_GATE_IDENTITY_REQUIRED", `gate ${current.id} is ${current.outcomeClass} and requires a named actor`);
        }
      }
      if (input.identityAuthority !== undefined) {
        // Supplied for any class means checked for that class -- asking for the check and
        // then having it skipped would be the worst of both.
        if (input.actorId === undefined) {
          fail("WORKSPACE_GATE_IDENTITY_REQUIRED", `gate ${current.id} identity authority supplied without a named actor`);
        }
        if (!permitsGateOutcome(input.identityAuthority, input.actorId, current.outcomeClass)) {
          fail("WORKSPACE_GATE_IDENTITY_REFUSED", `${input.actorId} may not satisfy ${current.outcomeClass} gate ${current.id}`);
        }
      }
      const locator = input.minutesLocator;
      if (locator === undefined || !resolveGateEvidence(locator, current, state.conferenceMinutes, state.conferences)) {
        fail("WORKSPACE_GATE_EVIDENCE_UNRESOLVED", `gate ${current.id} evidence ${String(locator)} does not resolve to anchoring conference minutes`);
      }
      extensions = gateEvidenceExtensions(current.extensions, locator);
      if (input.identityAuthority !== undefined && input.actorId !== undefined) {
        extensions = gateIdentityExtensions(extensions, gateIdentityDecision(input.identityAuthority, input.actorId));
      }
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

// INIT-022 S212: a template file is inert until this governed admission event
// records its digest, version, owner, and schema in the workspace chain. The
// reducer derives the extension registry from these records; callers cannot
// smuggle a required template extension in through a work payload alone.
export async function admitTemplateInWorkspace(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly template: unknown;
  readonly ownerId: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const receipt = admitTemplate(input.template, { ownerId: input.ownerId, admittedAt: input.occurredAt });
  const record = createTemplateAdmissionRecord(input.template, receipt);
  return appendEvent(workspaceRoot, lease, (state) => {
    if (state.templates.some((entry) => entry.template.id === record.template.id && entry.template.version === record.template.version)) {
      throw new TemplateAdmissionError("TEMPLATE_DUPLICATE", `${record.template.id}@${record.template.version}`);
    }
    const templates = [...state.templates, record].sort((left, right) => compareCanonicalText(left.registrationId, right.registrationId));
    return {
      payload: buildEventPayload("template.admitted", record as unknown as JsonValue),
      projects: state.projects,
      work: state.work,
      templates,
    };
  }, input);
}

// INIT-022 S213: settings are a bounded workspace_configuration overlay, not an
// ungoverned JSON sidecar. Each write is an append-only event and the replay arm
// above enforces the same key, layer, revision, and value contract.
export async function setWorkspaceSetting(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly key: string;
  readonly value: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    if (input.key === "execution.claudeCodeSubagentPlan" || input.key === "execution.codexSubagentPlan") {
      const host = input.key === "execution.claudeCodeSubagentPlan" ? "claude-code" : "codex";
      if (!state.executionConfig.modelPlans.some((plan) => plan.host === host && plan.name === input.value)) {
        fail("MODEL_PLAN_NOT_FOUND", `${input.value} is not a model plan for ${host}`);
      }
    }
    const current = state.settings.find((record) => record.key === input.key);
    const record = createWorkspaceSettingRecord(
      input.key,
      input.value,
      (current?.revision ?? 0) + 1,
      input.occurredAt,
      workspaceRoot,
    );
    return {
      payload: buildEventPayload("settings.updated", record as unknown as JsonValue),
      projects: state.projects,
      work: state.work,
      settings: sortWorkspaceSettings([
        ...state.settings.filter((entry) => entry.key !== record.key),
        record,
      ]),
    };
  }, input);
}

export async function removeWorkspaceSetting(workspaceRoot: string, lease: WorkspaceLease, input: {
  readonly key: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, lease, (state) => {
    const current = state.settings.find((record) => record.key === input.key);
    if (current === undefined) fail("WORKSPACE_INPUT_INVALID", `setting ${input.key} is not set`);
    return {
      payload: buildEventPayload("settings.removed", { key: input.key, updatedAt: input.occurredAt } as unknown as JsonValue),
      projects: state.projects,
      work: state.work,
      settings: sortWorkspaceSettings(state.settings.filter((entry) => entry.key !== input.key)),
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
  const backend = backendFor(resolved);
  for (const directoryName of ["events", "views", WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY]) {
    let entries: readonly StorageDirectoryEntry[];
    try {
      entries = await backend.listControlEntries(directoryName);
    } catch (error) {
      if (isMissingStoragePath(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".tmp-") && entry.isFile && !entry.isSymbolicLink) {
        await backend.removeControlFile(`${directoryName}/${entry.name}`);
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
  const extensionCollections = state.conferences.length + state.gates.length + state.settings.length + state.templates.length > 0
    ? {
      conferences: state.conferences,
      conferencePositions: state.conferencePositions,
      conferenceMinutes: state.conferenceMinutes,
      gates: state.gates,
      ...(state.settings.length === 0 ? {} : { settings: state.settings }),
      ...(state.templates.length === 0 ? {} : { templates: state.templates }),
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
  if (!Number.isSafeInteger(targetVersion) || targetVersion < WORKSPACE_LEGACY_STORAGE_VERSION) {
    fail("WORKSPACE_MIGRATION_DOWNGRADE", String(targetVersion));
  }
  if (targetVersion > WORKSPACE_STORAGE_VERSION) {
    fail("WORKSPACE_MIGRATION_FUTURE", String(targetVersion));
  }
  if (targetVersion < metadata.storageVersion) {
    fail("WORKSPACE_MIGRATION_DOWNGRADE", String(targetVersion));
  }
  const state = await materializeWorkspace(workspaceRoot);
  if (targetVersion === WORKSPACE_STORAGE_VERSION && metadata.storageVersion === WORKSPACE_LEGACY_STORAGE_VERSION) {
    const segments = storageMigrationSegments(state.events, WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES);
    return {
      schemaVersion: "tcrn.workspace-migration-plan.v1",
      dryRun: true,
      fromVersion: metadata.storageVersion,
      toVersion: targetVersion,
      steps: [
        "write an exact pre-migration backup of metadata, legacy event segments, and replay snapshots",
        `rewrite ${String(state.events.length)} event(s) as ${String(segments.length)} byte-bounded NDJSON segment(s)`,
        `set the segmented storage limit to ${String(WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES)} bytes and rebuild sidecar indexes`,
        "validate full event values, views, and the rebuilt replay snapshot",
      ],
      backupRequired: true,
      rollback: "restore-exact-pre-migration-backup-then-validate",
      postValidation: "validate-exact-target-schema-and-full-event-chain",
      applyAvailable: true,
      basisDigest: canonicalSha256({ metadata, headEventHash: state.headEventHash, version: state.version }),
    };
  }
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

const STORAGE_MIGRATION_BACKUP_ROOT = "migration/storage-v1" as const;
const STORAGE_MIGRATION_BACKUP_EVENTS = "migration/storage-v1/events" as const;
const STORAGE_MIGRATION_BACKUP_SNAPSHOTS = "migration/storage-v1/snapshots" as const;
const STORAGE_MIGRATION_MARKER = "migration/storage-v1/marker.json" as const;

interface StorageMigrationMarker {
  readonly schemaVersion: "tcrn.workspace-storage-migration-marker.v1";
  readonly status: "prepared";
  readonly workspaceId: string;
  readonly eventCount: number;
  readonly headEventHash: string | null;
  readonly eventNames: readonly string[];
  readonly snapshotNames: readonly string[];
  readonly stateDigest: string;
  readonly segmentBytes: number;
}

interface StorageMigrationSegment {
  readonly name: string;
  readonly bytes: Buffer;
}

function storageMigrationStateDigest(state: WorkspaceState): string {
  const digest = createHash("sha256");
  const update = (name: string, value: unknown): void => {
    const bytes = Buffer.from(unboundedCanonicalJson(value), "utf8");
    digest.update(Buffer.from(`${name}:${bytes.length}:`, "utf8"));
    digest.update(bytes);
  };
  update("workspaceId", state.metadata.workspaceId);
  update("version", state.version);
  update("headEventHash", state.headEventHash);
  update("projects", state.projects);
  update("work", state.work);
  update("conferences", state.conferences);
  update("conferencePositions", state.conferencePositions);
  update("conferenceMinutes", state.conferenceMinutes);
  update("gates", state.gates);
  update("settings", state.settings);
  update("executionConfig", state.executionConfig);
  update("templates", state.templates);
  update("attestationEnabledAtSequence", state.attestationEnabledAtSequence);
  for (const event of state.events) update("event", event);
  return digest.digest("hex");
}

function storageMigrationLegacyStateDigest(state: WorkspaceState): string | null {
  try {
    return canonicalSha256({
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      projects: state.projects,
      work: state.work,
      conferences: state.conferences,
      conferencePositions: state.conferencePositions,
      conferenceMinutes: state.conferenceMinutes,
      gates: state.gates,
      settings: state.settings,
      executionConfig: state.executionConfig,
      templates: state.templates,
      attestationEnabledAtSequence: state.attestationEnabledAtSequence,
      events: state.events,
    });
  } catch {
    return null;
  }
}

function storageMigrationSegments(events: readonly EventRecord[], limit: number): readonly StorageMigrationSegment[] {
  if (!Number.isSafeInteger(limit) || limit < WORKSPACE_SEGMENT_BYTES_MIN || limit > WORKSPACE_SEGMENT_BYTES_MAX) {
    fail("WORKSPACE_STORAGE_MIGRATION_LIMIT_INVALID", String(limit));
  }
  const segments: StorageMigrationSegment[] = [];
  let index = 1;
  let current = "";
  let currentBytes = 0;
  const flush = (): void => {
    if (currentBytes === 0) return;
    segments.push({ name: `${String(index).padStart(6, "0")}.ndjson`, bytes: Buffer.from(current, "utf8") });
    index += 1;
    current = "";
    currentBytes = 0;
  };
  for (const event of events) {
    const line = canonicalJson(event);
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > limit) {
      fail("WORKSPACE_STORAGE_MIGRATION_LIMIT_INVALID", `event ${event.id} exceeds ${String(limit)} bytes`);
    }
    if (currentBytes > 0 && currentBytes + bytes > limit) flush();
    current += line;
    currentBytes += bytes;
  }
  flush();
  return segments;
}

async function ensureStorageMigrationBackupTree(backend: StorageBackend): Promise<void> {
  for (const directory of ["migration", STORAGE_MIGRATION_BACKUP_ROOT, STORAGE_MIGRATION_BACKUP_EVENTS, STORAGE_MIGRATION_BACKUP_SNAPSHOTS]) {
    await backend.ensureControlDirectory(directory);
  }
}

async function readStorageMigrationMarker(workspaceRoot: string): Promise<StorageMigrationMarker | null> {
  const backend = new FileBackend(workspaceRoot);
  let bytes: Buffer;
  try {
    bytes = await backend.readControlFile(STORAGE_MIGRATION_MARKER, 1_048_576);
  } catch (error) {
    if (isMissingStoragePath(error)) return null;
    throw error;
  }
  let value: unknown;
  try {
    value = assertCanonicalJson(bytes.toString("utf8"));
  } catch (error) {
    fail("WORKSPACE_STORAGE_MIGRATION_IN_PROGRESS", String((error as { message?: string }).message ?? error));
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("WORKSPACE_STORAGE_MIGRATION_IN_PROGRESS", "migration marker is not an object");
  }
  const marker = value as Partial<StorageMigrationMarker>;
  if (marker.schemaVersion !== "tcrn.workspace-storage-migration-marker.v1" || marker.status !== "prepared" ||
    typeof marker.workspaceId !== "string" || !Number.isSafeInteger(marker.eventCount) ||
    (marker.headEventHash !== null && typeof marker.headEventHash !== "string") ||
    !Array.isArray(marker.eventNames) || !Array.isArray(marker.snapshotNames) ||
    typeof marker.stateDigest !== "string" || !/^[a-f0-9]{64}$/u.test(marker.stateDigest) ||
    !Number.isSafeInteger(marker.segmentBytes)) {
    fail("WORKSPACE_STORAGE_MIGRATION_IN_PROGRESS", "migration marker is invalid");
  }
  return marker as StorageMigrationMarker;
}

function storageMigrationNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

async function removeControlFiles(backend: StorageBackend, directory: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await backend.removeControlFile(`${directory}/${name}`);
  }
}

async function cleanupStorageMigrationBackup(workspaceRoot: string): Promise<void> {
  const marker = await readStorageMigrationMarker(workspaceRoot);
  if (marker === null) return;
  const backend = new FileBackend(workspaceRoot);
  const paths = [STORAGE_MIGRATION_MARKER, `${STORAGE_MIGRATION_BACKUP_ROOT}/metadata.json`,
    ...marker.eventNames.map((name) => `${STORAGE_MIGRATION_BACKUP_EVENTS}/${name}`),
    ...marker.snapshotNames.map((name) => `${STORAGE_MIGRATION_BACKUP_SNAPSHOTS}/${name}`)];
  for (const path of paths) {
    try {
      await backend.removeControlFile(path);
    } catch (error) {
      if (!isMissingStoragePath(error)) throw error;
    }
  }
}

function storageMigrationReport(state: WorkspaceState, segments: readonly StorageMigrationSegment[], segmentBytes: number): WorkspaceStorageMigrationResult {
  return {
    schemaVersion: "tcrn.workspace-storage-migration.v1",
    reasonCode: "WORKSPACE_STORAGE_MIGRATION_VERIFIED",
    ok: true,
    fromVersion: 1,
    toVersion: 2,
    workspaceId: state.metadata.workspaceId,
    eventCount: state.version,
    headEventHash: state.headEventHash,
    segmentBytes,
    segmentCount: segments.length,
    stateDigest: storageMigrationStateDigest(state),
  };
}

export async function verifyWorkspaceStorageMigration(workspaceRootInput: string): Promise<WorkspaceStorageMigrationVerification> {
  const root = await boundDirectory(workspaceRootInput);
  const metadata = await readMetadata(root);
  if (metadata.storageVersion !== WORKSPACE_STORAGE_VERSION) {
    return {
      schemaVersion: "tcrn.workspace-storage-migration-verify.v1",
      ok: false,
      reasonCode: "WORKSPACE_STORAGE_MIGRATION_NOT_APPLIED",
      fromVersion: 1,
      toVersion: 2,
      workspaceId: metadata.workspaceId,
      eventCount: 0,
      headEventHash: null,
      segmentBytes: null,
      segmentCount: 0,
      stateDigest: null,
    };
  }
  const marker = await readStorageMigrationMarker(root);
  if (metadata.segmentEventLimit !== WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES) {
    return {
      schemaVersion: "tcrn.workspace-storage-migration-verify.v1",
      ok: false,
      reasonCode: "WORKSPACE_STORAGE_MIGRATION_LIMIT_INVALID",
      fromVersion: 1,
      toVersion: 2,
      workspaceId: metadata.workspaceId,
      eventCount: marker?.eventCount ?? 0,
      headEventHash: marker?.headEventHash ?? null,
      segmentBytes: metadata.segmentEventLimit,
      segmentCount: 0,
      stateDigest: marker?.stateDigest ?? null,
    };
  }
  const state = await materializeWorkspace(root);
  const segmentBytes = segmentBytesForState(state);
  const segments = storageMigrationSegments(state.events, segmentBytes);
  const segmented = new SegmentedBackend(root);
  const names = await segmented.listSegmentNames();
  if (segmentBytes !== WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES) {
    return {
      schemaVersion: "tcrn.workspace-storage-migration-verify.v1",
      ok: false,
      reasonCode: "WORKSPACE_STORAGE_MIGRATION_LIMIT_INVALID",
      fromVersion: 1,
      toVersion: 2,
      workspaceId: state.metadata.workspaceId,
      eventCount: state.version,
      headEventHash: state.headEventHash,
      segmentBytes,
      segmentCount: names.length,
      stateDigest: storageMigrationStateDigest(state),
    };
  }
  const manifest = await segmented.readManifest();
  if (manifest.segments.length !== names.length || manifest.segments.length !== segments.length) {
    return {
      schemaVersion: "tcrn.workspace-storage-migration-verify.v1",
      ok: false,
      reasonCode: "WORKSPACE_STORAGE_MIGRATION_MISMATCH",
      fromVersion: 1,
      toVersion: 2,
      workspaceId: state.metadata.workspaceId,
      eventCount: state.version,
      headEventHash: state.headEventHash,
      segmentBytes,
      segmentCount: names.length,
      stateDigest: storageMigrationStateDigest(state),
    };
  }
  for (const [index, expected] of segments.entries()) {
    const actual = await segmented.readSegment(expected.name);
    const manifestEntry = manifest.segments[index];
    if (manifestEntry?.name !== expected.name || actual.length !== expected.bytes.length || actual.length > segmentBytes ||
      sha256Bytes(actual) !== manifestEntry.sha256 || !actual.equals(expected.bytes)) {
      return {
        schemaVersion: "tcrn.workspace-storage-migration-verify.v1",
        ok: false,
        reasonCode: "WORKSPACE_STORAGE_MIGRATION_MISMATCH",
        fromVersion: 1,
        toVersion: 2,
        workspaceId: state.metadata.workspaceId,
        eventCount: state.version,
        headEventHash: state.headEventHash,
        segmentBytes,
        segmentCount: names.length,
        stateDigest: storageMigrationStateDigest(state),
      };
    }
  }
  const stateDigest = storageMigrationStateDigest(state);
  const legacyStateDigest = marker === null || marker.stateDigest === stateDigest ? null : storageMigrationLegacyStateDigest(state);
  if (marker !== null && (marker.workspaceId !== state.metadata.workspaceId || marker.eventCount !== state.version || marker.headEventHash !== state.headEventHash ||
    (marker.stateDigest !== stateDigest && marker.stateDigest !== legacyStateDigest))) {
    return {
      schemaVersion: "tcrn.workspace-storage-migration-verify.v1",
      ok: false,
      reasonCode: "WORKSPACE_STORAGE_MIGRATION_MISMATCH",
      fromVersion: 1,
      toVersion: 2,
      workspaceId: state.metadata.workspaceId,
      eventCount: state.version,
      headEventHash: state.headEventHash,
      segmentBytes,
      segmentCount: names.length,
      stateDigest,
    };
  }
  return {
    schemaVersion: "tcrn.workspace-storage-migration-verify.v1",
    ok: true,
    reasonCode: "WORKSPACE_STORAGE_MIGRATION_VERIFIED",
    fromVersion: 1,
    toVersion: 2,
    workspaceId: state.metadata.workspaceId,
    eventCount: state.version,
    headEventHash: state.headEventHash,
    segmentBytes,
    segmentCount: names.length,
    stateDigest,
  };
}

export async function migrateWorkspaceStorage(workspaceRootInput: string): Promise<WorkspaceStorageMigrationResult> {
  const root = await boundDirectory(workspaceRootInput);
  const metadata = await readMetadata(root);
  if (metadata.storageVersion === WORKSPACE_STORAGE_VERSION) {
    const verified = await verifyWorkspaceStorageMigration(root);
    if (!verified.ok || verified.segmentBytes !== WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES) {
      fail("WORKSPACE_STORAGE_MIGRATION_LIMIT_INVALID", verified.reasonCode);
    }
    const state = await materializeWorkspace(root);
    await cleanupStorageMigrationBackup(root);
    return storageMigrationReport(state, storageMigrationSegments(state.events, verified.segmentBytes), verified.segmentBytes);
  }
  if (metadata.storageVersion !== WORKSPACE_LEGACY_STORAGE_VERSION) {
    fail("WORKSPACE_STORAGE_MIGRATION_NOT_APPLIED", String(metadata.storageVersion));
  }
  const existingMarker = await readStorageMigrationMarker(root);
  if (existingMarker !== null) {
    fail("WORKSPACE_STORAGE_MIGRATION_IN_PROGRESS", existingMarker.workspaceId);
  }
  const lease = await acquireWorkspaceLease(root, { now: storageMigrationNow() });
  try {
    const workspace = await resolveWorkspace(root);
    const before = await materializeResolvedWorkspace(workspace);
    const beforeDigest = storageMigrationStateDigest(before);
    const legacy = new FileBackend(root);
    const eventNames = (await legacy.listSegmentNames()).sort(compareCanonicalText);
    if (eventNames.some((name) => !/^\d{6}\.json$/u.test(name))) {
      fail("WORKSPACE_EVENT_CORRUPT", "legacy migration source contains a non-JSON event entry");
    }
    const eventBytes = new Map<string, Buffer>();
    for (const name of eventNames) eventBytes.set(name, await legacy.readSegment(name));
    const snapshotEntries = (await legacy.listControlEntries(WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY))
      .filter((entry) => entry.isFile && !entry.isSymbolicLink)
      .map((entry) => entry.name)
      .sort(compareCanonicalText);
    await ensureStorageMigrationBackupTree(legacy);
    await legacy.writeControlFile(`${STORAGE_MIGRATION_BACKUP_ROOT}/metadata.json`, await legacy.readMetadataBytes());
    for (const name of eventNames) {
      await legacy.writeControlFile(`${STORAGE_MIGRATION_BACKUP_EVENTS}/${name}`, eventBytes.get(name) as Buffer);
    }
    for (const name of snapshotEntries) {
      await legacy.writeControlFile(`${STORAGE_MIGRATION_BACKUP_SNAPSHOTS}/${name}`, await legacy.readControlFile(`${WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY}/${name}`, 67_108_864));
    }
    const marker: StorageMigrationMarker = {
      schemaVersion: "tcrn.workspace-storage-migration-marker.v1",
      status: "prepared",
      workspaceId: before.metadata.workspaceId,
      eventCount: before.version,
      headEventHash: before.headEventHash,
      eventNames,
      snapshotNames: snapshotEntries,
      stateDigest: beforeDigest,
      segmentBytes: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES,
    };
    await legacy.writeControlFile(STORAGE_MIGRATION_MARKER, canonicalJson(marker as unknown as JsonValue));
    const segments = storageMigrationSegments(before.events, WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES);
    for (const segment of segments) {
      await legacy.writeControlFile(`events/${segment.name}`, segment.bytes);
    }
    await removeControlFiles(legacy, "events", eventNames);
    await removeControlFiles(legacy, WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY, snapshotEntries);
    const targetMetadata: WorkspaceMetadata = {
      ...before.metadata,
      storageVersion: WORKSPACE_STORAGE_VERSION,
      maximumStorageVersion: WORKSPACE_STORAGE_VERSION,
      segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES,
    };
    await legacy.writeMetadataBytes(Buffer.from(canonicalJson(targetMetadata), "utf8"));
    const segmented = new SegmentedBackend(root);
    await segmented.rebuildIndexes();
    const after = await materializeWorkspace(root);
    if (storageMigrationStateDigest(before) !== storageMigrationStateDigest(after)) {
      fail("WORKSPACE_STORAGE_MIGRATION_MISMATCH", "migration changed materialized values");
    }
    await validateWorkspace(root);
    await writeReplaySnapshot(after, segmented, true);
    await validateWorkspace(root);
    await cleanupStorageMigrationBackup(root);
    return storageMigrationReport(after, segments, WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES);
  } finally {
    await lease.release();
  }
}

export async function hasWorkspaceStorageMigration(workspaceRoot: string): Promise<boolean> {
  return (await readStorageMigrationMarker(workspaceRoot)) !== null;
}

export async function rollbackWorkspaceStorageMigration(workspaceRootInput: string): Promise<Readonly<Record<string, JsonValue>>> {
  const root = await boundDirectory(workspaceRootInput);
  const marker = await readStorageMigrationMarker(root);
  if (marker === null) fail("WORKSPACE_STORAGE_MIGRATION_NOT_APPLIED", "no storage migration backup is present");
  const lease = await acquireWorkspaceLease(root, { now: storageMigrationNow() });
  try {
    const backend = new FileBackend(root);
    const eventEntries = await backend.listControlEntries("events");
    for (const entry of eventEntries) {
      if (entry.isFile && !entry.isSymbolicLink && (/^\d{6}\.ndjson$/u.test(entry.name) || /^\d{6}\.idx$/u.test(entry.name) || ["labels.idx", "time.idx", "manifest.json"].includes(entry.name))) {
        await backend.removeControlFile(`events/${entry.name}`);
      }
    }
    const snapshots = await backend.listControlEntries(WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY);
    for (const entry of snapshots) {
      if (entry.isFile && !entry.isSymbolicLink) await backend.removeControlFile(`${WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY}/${entry.name}`);
    }
    for (const name of marker.eventNames) {
      await backend.writeControlFile(`events/${name}`, await backend.readControlFile(`${STORAGE_MIGRATION_BACKUP_EVENTS}/${name}`, 67_108_864));
    }
    for (const name of marker.snapshotNames) {
      await backend.writeControlFile(`${WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY}/${name}`, await backend.readControlFile(`${STORAGE_MIGRATION_BACKUP_SNAPSHOTS}/${name}`, 67_108_864));
    }
    await backend.writeMetadataBytes(await backend.readControlFile(`${STORAGE_MIGRATION_BACKUP_ROOT}/metadata.json`, 1_048_576));
    const restored = await validateWorkspace(root);
    const markerFiles = [STORAGE_MIGRATION_MARKER, `${STORAGE_MIGRATION_BACKUP_ROOT}/metadata.json`,
      ...marker.eventNames.map((name) => `${STORAGE_MIGRATION_BACKUP_EVENTS}/${name}`),
      ...marker.snapshotNames.map((name) => `${STORAGE_MIGRATION_BACKUP_SNAPSHOTS}/${name}`)];
    for (const path of markerFiles) await backend.removeControlFile(path);
    return {
      schemaVersion: "tcrn.workspace-storage-migration-rollback.v1",
      reasonCode: "WORKSPACE_STORAGE_MIGRATION_ROLLED_BACK",
      ok: true,
      workspaceId: restored.metadata.workspaceId,
      eventCount: restored.version,
      headEventHash: restored.headEventHash,
    } as unknown as Readonly<Record<string, JsonValue>>;
  } finally {
    await lease.release();
  }
}

export async function applyWorkspaceMigration(): Promise<never> {
  fail("WORKSPACE_MIGRATION_APPLY_UNAVAILABLE", "V1 has no real-data migration apply path");
}
