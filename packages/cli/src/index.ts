// SPDX-License-Identifier: Apache-2.0

import {
  acquireWorkspaceLease,
  breakWorkspaceLease,
  breakWorkspaceRecoveryClaim,
  inspectWorkspaceLease,
  openConferenceInWorkspace,
  appendConferencePositionInWorkspace,
  closeConferenceInWorkspace,
  cancelConferenceInWorkspace,
  distillConferenceKnowledge,
  listConferencesByWorkItem,
  createGateInWorkspace,
  transitionGateInWorkspace,
  readGateIdentityAuthority,
  deleteGateInWorkspace,
  listGatesByWorkItem,
  applyArtifactArchive,
  artifactArchiveDryRun,
  artifactCompactDryRun,
  artifactDoctor,
  artifactSizeReport,
  createKnowledgeUnit,
  createProject,
  createWork,
  deleteProject,
  deleteWork,
  enableActorAttestation,
  evaluateKnowledgeFreshness,
  exportKnowledgeCheckpoint,
  exportWorkspace,
  generateCorePersonaBundle,
  renderPersonaAuthoritySummary,
  authorizeGenericProfileOperation,
  generateGenericStarterBundle,
  initializeKnowledgeStore,
  initializeWorkspace,
  knowledgeContextCandidates,
  listKnowledgeMetadata,
  materializeWorkspace,
  planWorkspaceMigration,
  executeMigration,
  verifyMigration,
  rollbackMigration,
  readGenericProfileAdmissionReceipt,
  readContextRouteAuthorityReceipt,
  readKnowledgeBody,
  readKnowledgeSnippet,
  rebaseKnowledgeStore,
  retireKnowledgeUnit,
  reverifyKnowledgeUnit,
  recoverWorkspace,
  createSnapshotManifest,
  readSnapshotManifestFile,
  verifySnapshotManifest,
  restoreArtifactArchive,
  resolveGenericProfile,
  routeContext,
  transitionKnowledgePromotion,
  transitionWork,
  annotateWork,
  updateProject,
  validateKnowledgeStore,
  validateCorePersonaBundle,
  validateContextRouteResult,
  validateGenericStarterBundle,
  validateWorkspace,
  codexAdapterAuthorityEmptyFallback,
  claudeAdapterAuthorityEmptyFallback,
  executeClaudeAdapterRollback,
  generateClaudeAdapterActivationFragment,
  generateClaudeAdapterBundle,
  generateClaudeAdapterSettingsFragment,
  generateSessionStartScript,
  installClaudeAdapterActivation,
  admitClaudeAdapterInstallationRoot,
  installClaudeAdapterBundle,
  mergeClaudeAdapterActivationFragment,
  mergeClaudeAdapterSettingsFragment,
  removeClaudeAdapterActivationFragment,
  sessionStartScriptDigest,
  planClaudeAdapterRollback,
  readClaudeAdapterInstallationReceipt,
  removeClaudeAdapterSettingsFragment,
  simulateClaudeAdapterLifecycle,
  validateClaudeAdapterBundle,
  dryRunCanonicalExchange,
  dryRunCompatibilityMode,
  generateCodexAdapterBundle,
  planCanonicalExchange,
  planCompatibilityMode,
  planCodexAdapterRollback,
  readCodexAdapterInstallationReceipt,
  readCodexActivationInstallationReceipt,
  readCodexHostActivationObservation,
  installCodexAdapterBundle,
  installCodexAdapterActivation,
  admitCodexAdapterInstallationRoot,
  executeCodexAdapterRollback,
  uninstallCodexAdapterActivation,
  assessCodexActivationTrust,
  createCodexHostActivationReceipt,
  generateCodexActivationArtifacts,
  generateCodexSessionSummary,
  createAdapterBaseline,
  validateAdapterSurface,
  collectCodexAppServerExecutions,
  generateClaudeAdapterActivationRollbackPlan,
  readClaudeAdapterActivationReceipt,
  simulateCodexAdapterLifecycle,
  validateCodexAdapterBundle,
  validateCanonicalExchangeBundle,
  validateCompatibilityRequest,
  unavailableCompatibilityCapability,
  readCompatibilityAdmissionReceipt,
  parsePublicAosRequirementsLedger,
  publicAosRequirementsReadback,
  publicAosRequirementsValidReason,
  readOperatorAuthority,
  abortWorkspaceRelocation,
  adoptWorkspace,
  inspectWorkspaceRelocation,
  planWorkspaceRelocation,
  readGovernedDocumentFile,
  readRelocationAuthority,
  vacateWorkspace,
  readStorageHomeDeclaration,
  sealStorageHomeDeclaration,
  readSettingsCatalog,
  removeHostConfigurationInWorkspace,
  removePersonaBindingInWorkspace,
  setHostConfigurationInWorkspace,
  setHostDefaultInWorkspace,
  setPersonaBindingInWorkspace,
  setWorkspaceSetting,
  admitTemplateInWorkspace,
  readTemplateDocumentFile,
  templateBindingFromWorkRecord,
  validateTemplateDocument,
  withStoreBackendFactory,
  withStorageBackendFactory,
} from "../../core/src/index.js";
import type {
  ConferenceRequest,
  ConferenceMinutes,
  GateRecord,
  GateIdentityAuthorityFileIdentity,
  CodexAdapterActivationHostContext,
  CodexAdapterHostContext,
  CodexAdapterInstallationFileIdentity,
  CodexHostActivationObservationContext,
  CodexHostActivationObservationFileIdentity,
  CodexHostActivationObservationFreshness,
  ClaudeAdapterHostContext,
  ClaudeAdapterActivationHostContext,
  ClaudeAdapterInstallationFileIdentity,
  ExplicitRoot,
  ContextRouteAuthorityFileIdentity,
  GenericProfileAdmissionAuthority,
  KnowledgeCategory,
  KnowledgeFreshnessState,
  KnowledgeKind,
  KnowledgePromotionState,
  CompatibilityAdmissionAuthority,
  RelocationAuthorityFileIdentity,
  RelocationDestination,
} from "../../core/src/index.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { assertStrictInstant, canonicalExternalKey, canonicalJson, canonicalSha256, deriveStableId } from "../../protocol/src/index.js";
import { isWorkStatus } from "../../protocol/src/index.js";
import type { PlannedDeliveryKind, WorkRecord, WorkStatus } from "../../protocol/src/index.js";
// ProjectRecord is a core type, not a protocol one. The protocol package never exported
// it, so this import resolved to nothing; import elision hid the mistake from every
// runtime check the repo had.
import type { ProjectRecord } from "../../core/src/index.js";

export const RELEASE_REQUIRED_ARGUMENTS = [
  "trust-root",
  "bundle",
  "subject",
  "repository",
  "workflow",
  "now",
] as const;

export type ReleaseRequiredArgument =
  (typeof RELEASE_REQUIRED_ARGUMENTS)[number];

export function missingReleaseArguments(
  supplied: Readonly<Record<string, string | undefined>>,
): readonly ReleaseRequiredArgument[] {
  return RELEASE_REQUIRED_ARGUMENTS.filter((name) => !supplied[name]);
}

export class WorkflowCliError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "WorkflowCliError";
    this.reasonCode = reasonCode;
  }
}

export interface CliIo {
  write(value: string): void;
  // WSE-4: an injectable wall-clock reader, present only when the invoking process
  // chooses to. The production bin supplies () => new Date().toISOString() at the
  // outermost layer; hermetic runs inject a fixed instant or omit it entirely.
  // --attest-dir with no clock fails closed (CLI_ARGUMENT_MISSING) so library code
  // can never fall through to an implicit Date. It is ADVISORY local-clock evidence,
  // never a real-time guarantee, and never reaches the engine (the chain proves
  // ordering, not wall-clock truth — see specs/time-attestation-v1.md).
  readonly clock?: () => string;
  readonly profileAdmissionAuthority?: GenericProfileAdmissionAuthority;
  readonly contextRouteAuthority?: ContextRouteAuthorityFileIdentity;
  readonly codexAdapterHost?: CodexAdapterHostContext;
  readonly codexAdapterActivationHost?: CodexAdapterActivationHostContext;
  readonly codexAdapterInstallationAuthority?: CodexAdapterInstallationFileIdentity;
  readonly codexHostActivationObservation?: CodexHostActivationObservationContext;
  readonly codexHostActivationObservationAuthority?: CodexHostActivationObservationFileIdentity;
  // INC-017: the freshness bound travels with the pinned observation identity. It is
  // authority supply, not a convenience, so it joins AUTHORITY_IO_FIELDS below and a
  // caller mixing it with operator pins is ambiguous like every other authority.
  readonly codexHostActivationObservationFreshness?: CodexHostActivationObservationFreshness;
  readonly claudeAdapterHost?: ClaudeAdapterHostContext;
  readonly claudeAdapterActivationHost?: ClaudeAdapterActivationHostContext;
  readonly claudeAdapterInstallationAuthority?: ClaudeAdapterInstallationFileIdentity;
  readonly compatibilityAdmissionAuthority?: CompatibilityAdmissionAuthority;
}

const AUTHORITY_IO_FIELDS = Object.freeze([
  "profileAdmissionAuthority",
  "contextRouteAuthority",
  "codexAdapterHost",
  "codexAdapterActivationHost",
  "codexAdapterInstallationAuthority",
  "codexHostActivationObservation",
  "codexHostActivationObservationAuthority",
  "codexHostActivationObservationFreshness",
  "claudeAdapterHost",
  "claudeAdapterActivationHost",
  "claudeAdapterInstallationAuthority",
  "compatibilityAdmissionAuthority",
] as const);

function fail(reasonCode: string, message: string): never {
  throw new WorkflowCliError(reasonCode, message);
}

// A pins-track authority is an out-of-band constant the caller already holds, so the
// caller states it at the call site and the reader verifies it against the bytes on
// disk -- the shape --expected-plan-digest already uses. That is what terminates the
// trust regress: no registry and no trusted config to bootstrap, because the chain
// ends at whoever read the published digest.
//
// Injected and flag-supplied authority are mutually exclusive. Two sources for one
// authority is ambiguity, and picking a winner would silently ignore the other.
//
// Under flag supply the reader's path cross-check is vacuous by construction (both
// strings come from the same caller); the digest comparison is what binds, and the
// reader still enforces absoluteness and canonicality on the path it is handed.
function suppliedAuthority<T extends { readonly expectedCanonicalPath: string; readonly expectedFileSha256: string }>(
  injected: T | undefined,
  path: string | undefined,
  digest: string | undefined,
): T | undefined {
  if (digest === undefined) return injected;
  if (injected !== undefined) fail("CLI_AUTHORITY_AMBIGUOUS", "authority supplied by both host and flag");
  if (!/^[a-f0-9]{64}$/u.test(digest)) fail("CLI_ARGUMENT_MALFORMED", "authority digest");
  return { expectedCanonicalPath: path ?? "", expectedFileSha256: digest } as unknown as T;
}

function parseArguments(arguments_: readonly string[], allowed: readonly string[]): Readonly<Record<string, string>> {
  if (arguments_.some((value) => value.length > 65_536)) {
    fail("CLI_INPUT_OVERSIZED", "CLI arguments exceed the local input limit");
  }
  const values: Record<string, string> = {};
  let index = 0;
  while (index < arguments_.length) {
    const token = arguments_[index];
    let name: string;
    let value: string;
    if (token !== undefined && token.startsWith("--") && token.includes("=")) {
      // Attached form --flag=value: split on the FIRST "=" so the value may itself
      // contain "=" or legitimately begin with "--" (unrepresentable in two-token form).
      const equalsAt = token.indexOf("=");
      name = token.slice(2, equalsAt);
      value = token.slice(equalsAt + 1);
      index += 1;
    } else {
      const next = arguments_[index + 1];
      // Two-token form is unchanged: a value beginning with "--" is still rejected,
      // which doubles as missing-value (undefined next) detection.
      if (!token?.startsWith("--") || next === undefined || next.startsWith("--")) {
        fail("CLI_ARGUMENT_MALFORMED", String(token ?? "missing"));
      }
      name = token.slice(2);
      value = next;
      index += 2;
    }
    if (!allowed.includes(name)) {
      fail("CLI_ARGUMENT_UNKNOWN", name);
    }
    if (Object.hasOwn(values, name)) {
      fail("CLI_ARGUMENT_DUPLICATE", name);
    }
    values[name] = value;
  }
  return values;
}

function required(values: Readonly<Record<string, string>>, names: readonly string[]): void {
  const missing = names.filter((name) => !values[name]);
  if (missing.length > 0) {
    fail("CLI_ARGUMENT_MISSING", missing.join(","));
  }
}

function expectedVersion(values: Readonly<Record<string, string>>): number {
  const version = Number(values["expected-version"]);
  if (!Number.isSafeInteger(version) || version < 0) {
    fail("CLI_ARGUMENT_MALFORMED", "expected-version");
  }
  return version;
}

// CQ-05(c): the single arbiter for integer-valued flags. A syntactically malformed value
// now fails at the CLI boundary with CLI_ARGUMENT_MALFORMED naming the offending flag,
// instead of reaching core as NaN and being reported under a semantic reason code —
// `migration-plan --target-version abc` used to answer WORKSPACE_MIGRATION_DOWNGRADE with
// the message "NaN", i.e. a syntax error reported as a semantic downgrade refusal. This
// also removes the asymmetry where --expected-version failed as CLI_ARGUMENT_MALFORMED
// while its sibling --expected-revision failed as KNOWLEDGE_INPUT_INVALID without naming
// the flag at all.
// The minimum is deliberately optional and defaults to Number.MIN_SAFE_INTEGER: 0 and
// negative target-versions are LEGITIMATE downgrade requests that planWorkspaceMigration
// must still judge (workspace.ts compares against WORKSPACE_STORAGE_VERSION), so passing
// a positive minimum here would pre-empt the very judgement this patch protects. Only
// non-integers are rejected at the CLI; every integer still reaches core.
function integerValue(values: Readonly<Record<string, string>>, name: string, minimum: number = Number.MIN_SAFE_INTEGER): number {
  const value = Number(values[name]);
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("CLI_ARGUMENT_MALFORMED", name);
  }
  return value;
}

// STORY-178: the file↔pg migration target. Only `file` and `pg` are legal; the
// migration verbs refuse anything else by derivation rather than a hard-coded
// list of typo'd backends.
function migrationTarget(value: string): "file" | "pg" {
  if (value === "file" || value === "pg") {
    return value;
  }
  fail("CLI_ARGUMENT_MALFORMED", `to: ${value}`);
}

// STORY-178/INC-072: build the migration backend options. The file side needs
// none (the migration defaults to FileBackend); the PG side lazily imports the
// pg-backend package (a separate workspace package) and constructs a
// PgBackend/PgStoreBackend from $TCRN_PG_CONNECTION and the target schema.
async function migrationOptions(to: string, schemaFlag?: string): Promise<Parameters<typeof executeMigration>[2]> {
  if (to !== "pg") {
    return {};
  }
  const schema = schemaFlag ?? process.env.TCRN_PG_SCHEMA;
  if (typeof schema !== "string" || schema.length === 0) {
    fail("CLI_ARGUMENT_MALFORMED", "schema: --schema or $TCRN_PG_SCHEMA is required for a pg migration");
  }
  const connection = process.env.TCRN_PG_CONNECTION;
  if (typeof connection !== "string" || connection.length === 0) {
    fail("CLI_ARGUMENT_MALFORMED", "connection: $TCRN_PG_CONNECTION is required for a pg migration");
  }
  const { PgBackend, PgStoreBackend } = await import("../../pg-backend/src/index.js");
  const backend = new PgBackend({ schema, connection });
  const storeBackend = new PgStoreBackend({ schema, connection });
  await backend.connect();
  await storeBackend.connect();
  // INC-074: carry the schema + a caller-stamped migratedAt so executeMigration can
  // write the storage-home sentinel into the source file tree after a file→pg move.
  return {
    backend: () => backend,
    storeBackend: () => storeBackend,
    schema,
    migratedAt: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
  };
}

// Close the PG backends the migration opened, so the CLI process exits (a live
// pg client keeps the event loop running and the process would otherwise hang).
// close() is called as a method (this bound) — reading `candidate.close` into a
// variable and invoking it detaches this, which would throw on the pg client's
// `this.client.end()`. Close failures are swallowed: a close must not mask the
// migration result the caller is returning, and it must not leave the sibling
// backend unclosed (which would keep the process alive).
async function closeMigrationBackends(options: Parameters<typeof executeMigration>[2] | undefined): Promise<void> {
  const backend = options?.backend?.("");
  const storeBackend = options?.storeBackend?.("");
  const closeIfPresent = async (candidate: unknown): Promise<void> => {
    const maybe = candidate as { close?: unknown } | undefined;
    if (maybe && typeof maybe.close === "function") {
      try {
        await (maybe.close as () => Promise<void>).call(maybe);
      } catch {
        // best-effort close; never mask the migration outcome or the sibling close
      }
    }
  };
  await closeIfPresent(backend);
  await closeIfPresent(storeBackend);
}

// WSB-7: opt-in lease-scoped expected-version derivation. The literal "head"
// resolves, under the already-held workspace lease, to the current materialized
// version. Lease acquisition plus the mutation claim serialize writers, so this
// single in-lease read cannot race the append that follows it — derivation is
// exact and needs no retry loop. Valid ONLY on the six workspace-event mutation
// verbs (project-*/work-*); knowledge-marker mutations keep numeric-only
// expectedVersion() and so reject "head" with CLI_ARGUMENT_MALFORMED by
// construction. head forfeits intent-level lost-update detection (see WSB-6),
// so numeric stays the documented default; cross-writer CAS is unweakened.
async function resolveExpectedVersion(values: Readonly<Record<string, string>>, workspace: string): Promise<number> {
  if (values["expected-version"] === "head") {
    return (await materializeWorkspace(workspace)).version;
  }
  return expectedVersion(values);
}

function boundedInteger(values: Readonly<Record<string, string>>, name: string): number | undefined {
  const raw = values[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("CLI_ARGUMENT_MALFORMED", name);
  }
  return value;
}

function listValue(value: string | undefined): readonly string[] {
  if (!value || value === "-") return [];
  const values = value.split(",");
  if (values.some((entry) => entry.length === 0)) fail("CLI_ARGUMENT_MALFORMED", "list");
  return values;
}

// INIT-008: a sprint member reference is a qualified cross-partition pointer. The CLI
// accepts the ergonomic `workspace:<id>#work:<id>` spelling on one flag and parses it
// into the {workspaceId, workId} object the core stores (# is only the input delimiter,
// never the stored form). Both halves are whole protocol ids; the core re-validates them.
function sprintReference(value: string): { readonly workspaceId: string; readonly workId: string } {
  const hash = value.indexOf("#");
  if (hash < 0) fail("CLI_ARGUMENT_MALFORMED", "sprint must be workspace:<id>#work:<id>");
  const workspaceId = value.slice(0, hash);
  const workId = value.slice(hash + 1);
  if (!/^workspace:[a-f0-9]{24}$/u.test(workspaceId) || !/^work:[a-z0-9][a-z0-9._-]{0,127}$/u.test(workId)) {
    fail("CLI_ARGUMENT_MALFORMED", "sprint must be workspace:<id>#work:<id>");
  }
  return { workspaceId, workId };
}

// Unified nullable-flag spelling: "-" is the canonical null sentinel and an omitted
// flag is null; "null" is a deprecated alias accepted this release for external
// compatibility (see COMMAND_CATALOG deprecatedAliases and the agent-integration doc).
function nullableValue(value: string | undefined): string | null {
  return value === undefined || value === "-" || value === "null" ? null : value;
}

function booleanValue(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  fail("CLI_ARGUMENT_MALFORMED", name);
}

function jsonValue(value: string | undefined, name: string): unknown {
  try {
    return JSON.parse(value ?? "");
  } catch {
    fail("PROFILE_INPUT_INVALID", name);
  }
}

function exchangeJson(value: string | undefined, name: string): unknown {
  try {
    return JSON.parse(value ?? "");
  } catch {
    fail("EXCHANGE_INPUT_INVALID", name);
  }
}

function compatibilityJson(value: string | undefined, name: string): unknown {
  try {
    return JSON.parse(value ?? "");
  } catch {
    fail("COMPATIBILITY_INPUT_INVALID", name);
  }
}

function aosRequirementsJson(value: string | undefined, name: string): string {
  if (typeof value !== "string") fail("CLI_ARGUMENT_MALFORMED", name);
  return value;
}

// WSR-1: the relocation authority is a pins-track authority like every other, so the
// caller states the digest it already holds and the reader checks it against the
// bytes on disk. Read BEFORE any lease is taken — a filesystem refusal should not
// have held a workspace lock while it happened (T16).
async function relocationAuthorityFor(values: Readonly<Record<string, string>>): Promise<Awaited<ReturnType<typeof readRelocationAuthority>>> {
  const identity = suppliedAuthority<RelocationAuthorityFileIdentity>(
    undefined, values["relocation-authority"], values["relocation-authority-digest"],
  );
  if (identity === undefined) {
    fail("CLI_ARGUMENT_MISSING", "relocation-authority-digest");
  }
  return readRelocationAuthority(values["relocation-authority"] ?? "", identity);
}

function relocationDestination(values: Readonly<Record<string, string>>, prefix: "to-" | ""): RelocationDestination {
  return {
    framework: values[`${prefix}framework`] ?? "",
    workspace: prefix === "to-" ? values["to-workspace-root"] ?? "" : values.workspace ?? "",
    transient: values[`${prefix}transient`] ?? "",
    "evidence-locator": values[`${prefix}evidence-locator`] ?? "",
    "release-trust": values[`${prefix}release-trust`] ?? "",
  };
}

// WSR-1: the advisory sidecar is keyed by relocationId, NOT by headEventHash.
// Relocation does not advance the head, so the existing --attest-dir key would
// collide across hops — every hop of a workspace would overwrite the last one's
// receipt. Same fail-closed rules as emitTimeAttestation: no implicit clock, and
// never inside the workspace root.
async function emitRelocationAttestation(
  io: CliIo,
  values: Readonly<Record<string, string>>,
  receipt: Readonly<Record<string, unknown>>,
): Promise<void> {
  const attestDir = values["attest-dir"];
  if (attestDir === undefined) return;
  if (io.clock === undefined) fail("CLI_ARGUMENT_MISSING", "--attest-dir requires an injected clock; refusing an implicit local Date");
  const workspaceRoot = resolve(values.workspace ?? "");
  const directory = resolve(attestDir);
  if (insideWorkspace(workspaceRoot, directory)) fail("CLI_ARGUMENT_MALFORMED", "--attest-dir must resolve outside the workspace root");
  const relocationId = typeof receipt.relocationId === "string" ? receipt.relocationId : "";
  const stage = typeof receipt.stage === "string" ? receipt.stage : "";
  if (!/^relocation:[a-f0-9]{24}$/u.test(relocationId) || stage.length === 0) {
    fail("CLI_ARGUMENT_MALFORMED", "relocation attestation key");
  }
  assertStrictInstant(values.at ?? "");
  const observedAt = io.clock();
  assertStrictInstant(observedAt);
  const body = canonicalJson({
    schemaVersion: "tcrn.relocation-attestation.v1",
    observedAt,
    occurredAt: values.at ?? "",
    relocationId,
    stage,
  });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${relocationId.slice("relocation:".length)}-${stage}.json`), body);
}

async function withLease<T>(workspace: string, at: string, operation: (lease: Awaited<ReturnType<typeof acquireWorkspaceLease>>) => Promise<T>): Promise<T> {
  const lease = await acquireWorkspaceLease(workspace, { now: at });
  try {
    return await operation(lease);
  } finally {
    await lease.release();
  }
}

// WSB-1: the mutated record's identity, projected additively so agents never have
// to read views/index.json off-disk to learn the id they just created.
function projectSummary(record: ProjectRecord): Readonly<Record<string, string | number | boolean>> {
  return { id: record.id, revision: record.revision, tombstone: record.tombstone };
}

// INIT-014 (TCRN-AOS-INC-004): the summary carries `externalKey`.
//
// It did not, and `export` — the only read that did — refuses any workspace whose
// canonical form exceeds one MiB, which two of this platform's four chains
// already do. A record id is a one-way digest of its key, so a consumer on the
// paginated path could show a whole work tree and name nothing in it; the one
// downstream reader resorted to re-deriving keys by brute-force digest match,
// which only works for records that follow the naming convention and silently
// leaves the rest anonymous. Returning the key the record already holds costs
// one field and removes that entire class of workaround.
function workSummary(record: WorkRecord): Readonly<Record<string, unknown>> {
  const templateBinding = templateBindingFromWorkRecord(record);
  return {
    id: record.id,
    externalKey: record.externalKey,
    kind: record.kind,
    status: record.status,
    projectId: record.projectId,
    parentId: record.parentId,
    revision: record.revision,
    tombstone: record.tombstone,
    ...(templateBinding === null ? {} : { templateBinding }),
  };
}

// E05 read surface: project the non-binding advisory fields off a work record for
// work-show. Returns null when the record carries neither, so an un-annotated record's
// work-show output stays byte-identical to before this verb existed.
function workAdvisory(record: WorkRecord): Readonly<Record<string, unknown>> | null {
  const scope = record.extensions["advisory:scope"] as { readonly value: unknown } | undefined;
  const decidedBy = record.extensions["advisory:decided-by"] as { readonly value: unknown } | undefined;
  const sprint = record.extensions["advisory:sprint"] as { readonly value: unknown } | undefined;
  if (scope === undefined && decidedBy === undefined && sprint === undefined) return null;
  return {
    ...(scope !== undefined ? { scope: scope.value } : {}),
    ...(decidedBy !== undefined ? { decidedBy: decidedBy.value } : {}),
    ...(sprint !== undefined ? { sprint: sprint.value } : {}),
  };
}

// WSB-2: governed, budgeted read window over already-materialized, view-verified
// state. offset is >=0, limit >=1; both fail closed with the flag name on malformed input.
function paginate(state: Awaited<ReturnType<typeof validateWorkspace>>, kind: string, records: readonly unknown[], values: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
  const limit = boundedInteger(values, "limit");
  let offset = 0;
  if (values.offset !== undefined) {
    const parsed = Number(values.offset);
    if (!Number.isSafeInteger(parsed) || parsed < 0) fail("CLI_ARGUMENT_MALFORMED", "offset");
    offset = parsed;
  }
  const windowed = limit === undefined ? records.slice(offset) : records.slice(offset, offset + limit);
  return {
    reasonCode: "WORKSPACE_LIST_READY",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    kind,
    total: records.length,
    truncated: offset + windowed.length < records.length,
    records: windowed,
  };
}

// INC-027 (TCRN-CROSS-INC-027): the default window for `event-list`.
//
// 64 is the engine's own default segment size (initializeWorkspace's
// segmentEventLimit). The storage layer already reads a segment of that many
// events back through the one-MiB bound on a single file, so a default page asks
// for the same granularity the chain is already stored at rather than a number
// invented here. Measured across the four live chains on the platform that filed
// this, the largest single event is 7,008 bytes and the 95th percentile is 3,575,
// which puts a default page around 100 KiB and would need a 16 KiB mean event to
// reach the ceiling.
const EVENT_PAGE_DEFAULT_LIMIT = 64;

// INC-027: the event page — and the one list verb that can outgrow its own receipt.
//
// Every other list projects a summary, so its records are small by construction.
// This one returns each EventRecord verbatim (sequence, id, streamId, occurredAt,
// priorHash, payload, payloadHash, eventHash) because a consumer that re-derives
// the chain has to hash exactly the bytes the engine hashed; a projection would
// break that by definition. Verbatim records mean page size is the payloads'
// business, not the engine's, so a page CAN exceed the one-MiB canonical ceiling.
//
// When it does, this refuses. That refusal is the entire reason paging exists
// here: a silently short page is indistinguishable from the end of the chain,
// which is the exact failure INC-004/INC-005 were filed for — a limit expressing
// itself as absence. CLI_EVENT_PAGE_OVERSIZED is deliberately NOT the protocol's
// INPUT_OVERSIZED that `export` raises on the same ceiling: that code says "this
// chain cannot be read this way" and leaves the caller nowhere to go, while this
// one says "this page cannot" and names the flag that fixes it.
function eventPage(state: Awaited<ReturnType<typeof validateWorkspace>>, values: Readonly<Record<string, string>>): string {
  // The default applies only when the flag is ABSENT. A supplied value still goes
  // through boundedInteger inside paginate, so `--limit 0` stays
  // CLI_ARGUMENT_MALFORMED instead of being quietly replaced by the default.
  const windowed = values.limit === undefined
    ? { ...values, limit: String(EVENT_PAGE_DEFAULT_LIMIT) }
    : values;
  const page = paginate(state, "event", state.events, windowed);
  try {
    return canonicalJson(page);
  } catch (error) {
    if ((error as { readonly reasonCode?: string }).reasonCode === "INPUT_OVERSIZED") {
      fail("CLI_EVENT_PAGE_OVERSIZED", `${(page.records as readonly unknown[]).length} events do not fit one canonical page; lower --limit`);
    }
    throw error;
  }
}

// WSE-4: lowercase SHA-256 digest shape, duplicated locally rather than imported
// from the protocol internals (assertSha256 is unexported), matching the adapter
// duplication discipline.
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

// WSE-4: the workspace-root containment idiom, duplicated from workspace.ts (never
// imported from codex-adapter). A time-attestation receipt directory MUST resolve
// OUTSIDE the workspace root so the advisory, unauthenticated receipt can never be
// mistaken for an in-workspace attested artifact.
function insideWorkspace(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
}

// WSE-4: the receipt shape. schemaVersion is a CLI artifact tag, NOT a registered
// protocol extension: it is deliberately kept out of extension-registration and out
// of the workspace trust boundary. Both instants are validated (occurredAt is the
// caller-asserted event time; observedAt is the local clock reading) and eventHash
// is checked against the digest shape before one byte is written. It carries no path
// or hostname (GAP-5 privacy): only a digest and two instants.
function buildTimeAttestationReceipt(eventHash: string, occurredAt: string, observedAt: string): string {
  if (!SHA256_PATTERN.test(eventHash)) fail("CLI_ARGUMENT_MALFORMED", "time-attestation eventHash is not a sha-256 digest");
  assertStrictInstant(occurredAt);
  assertStrictInstant(observedAt);
  return canonicalJson({ schemaVersion: "tcrn.time-attestation.v1", eventHash, observedAt, occurredAt });
}

// WSE-4: opt-in advisory time attestation. Runs AFTER a successful mutation. When
// --attest-dir is absent this is a no-op, so every legacy invocation stays exactly
// byte-identical to rc.4 (the engine never sees a clock). When set: fail closed if
// no clock was injected (never an implicit Date), fail closed if the directory
// resolves inside the workspace root, then write one canonical receipt named
// <eventHash>.json. The write is best-effort local-clock evidence outside the
// lease/mutation claim: the event is already committed, so a failure here loses only
// the advisory receipt, never workspace state.
async function emitTimeAttestation(io: CliIo, values: Readonly<Record<string, string>>, headEventHash: string | null): Promise<void> {
  const attestDir = values["attest-dir"];
  if (attestDir === undefined) return;
  if (io.clock === undefined) fail("CLI_ARGUMENT_MISSING", "--attest-dir requires an injected clock; refusing an implicit local Date");
  const workspaceRoot = resolve(values.workspace ?? "");
  const directory = resolve(attestDir);
  if (insideWorkspace(workspaceRoot, directory)) fail("CLI_ARGUMENT_MALFORMED", "--attest-dir must resolve outside the workspace root");
  // headEventHash is null only on a workspace whose chain holds no events; every
  // caller here runs after a committed mutation, so the head is always a digest.
  // Retained as an explicit closed failure with the same reason code and message
  // the digest-shape check below would have produced, keeping behaviour unchanged.
  if (headEventHash === null) fail("CLI_ARGUMENT_MALFORMED", "time-attestation eventHash is not a sha-256 digest");
  const receipt = buildTimeAttestationReceipt(headEventHash, values.at ?? "", io.clock());
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${headEventHash}.json`), receipt);
}

function writeState(io: CliIo, state: Awaited<ReturnType<typeof validateWorkspace>>, record?: Readonly<Record<string, unknown>>): void {
  io.write(canonicalJson({
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    projects: state.projects.filter((entry) => !entry.tombstone).length,
    work: state.work.filter((entry) => !entry.tombstone).length,
    ...(record ? { record } : {}),
  }));
}

// WSD-2: sibling receipt for the conference/gate event-log mutation verbs. It is
// deliberately NOT writeState: those verbs mutate extension collections, not the
// project/work counts writeState projects (whose shape existing tests pin), so the
// receipt carries the mutated extension record's id as recordId instead. Every
// mutation flows through withLease + the engine's expectedVersion CAS, so version
// and headEventHash here are the post-append head.
function writeExtensionState(io: CliIo, state: Awaited<ReturnType<typeof materializeWorkspace>>, recordId: string): void {
  io.write(canonicalJson({
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    recordId,
  }));
}

function writeExecutionConfigState(io: CliIo, state: Awaited<ReturnType<typeof materializeWorkspace>>): void {
  io.write(canonicalJson({
    reasonCode: "EXECUTION_CONFIG_COMMITTED",
    schemaVersion: "tcrn.execution-config-write-receipt.v1",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    configurations: state.executionConfig.configurations,
    defaults: state.executionConfig.defaults,
    bindings: state.executionConfig.bindings,
  }));
}

function writeSettingsState(io: CliIo, state: Awaited<ReturnType<typeof materializeWorkspace>>, key: string): void {
  const setting = state.settings.find((entry) => entry.key === key);
  if (setting === undefined) fail("CLI_COMMAND_FAILED", `setting ${key} was not materialized after write`);
  const receipt = {
    schemaVersion: "tcrn.settings-write-receipt.v1",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    recordId: key,
    setting,
  } as const;
  io.write(canonicalJson({
    reasonCode: "SETTINGS_WRITE_COMMITTED",
    ...receipt,
    receiptDigest: canonicalSha256(receipt),
  }));
}

function writeTemplateAdmissionState(
  io: CliIo,
  state: Awaited<ReturnType<typeof materializeWorkspace>>,
  templateId: string,
  templateVersion: number,
): void {
  const admitted = state.templates.find((entry) => entry.template.id === templateId && entry.template.version === templateVersion);
  if (admitted === undefined) fail("CLI_COMMAND_FAILED", `template ${templateId}@${templateVersion} was not materialized after admission`);
  io.write(canonicalJson({
    reasonCode: "TEMPLATE_ADMISSION_COMMITTED",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    registrationId: admitted.registrationId,
    templateId: admitted.template.id,
    templateVersion: admitted.template.version,
    templateDigest: admitted.receipt.templateDigest,
    receipt: admitted.receipt,
  }));
}

// WSB-3: the declarative command catalog — the machine-readable source of truth
// for every dispatched verb and its flags, emitted by the `commands` discovery
// verb. New verbs MUST ship a catalog entry (SDC-1); the p3-cli-catalog parity
// test enforces two-way name equality with the dispatcher.
export const COMMAND_CATALOG = Object.freeze([
  { name: "adapter-activate", availability: "cli", mutates: true, flags: [{ name: "request", required: true, valueKind: "json" }, { name: "installation-root", required: true, valueKind: "string" }, { name: "generation-id", required: true, valueKind: "string" }, { name: "installation-receipt", required: true, valueKind: "string" }, { name: "installation-receipt-digest", required: false, valueKind: "string" }, { name: "receipt-out", required: true, valueKind: "string" }, { name: "capability-manifest-digest", required: true, valueKind: "string" }, { name: "step3", required: false, valueKind: "boolean" }, { name: "observe-events", required: false, valueKind: "json" }] },
  { name: "adapter-activation-assess", availability: "cli", mutates: false, flags: [{ name: "binding", required: true, valueKind: "json" }, { name: "approved-definition-digests", required: true, valueKind: "json" }] },
  { name: "adapter-activation-record", availability: "cli", mutates: false, authorityBearing: true, flags: [{ name: "activation-receipt", required: true, valueKind: "string" }, { name: "activation-receipt-digest", required: false, valueKind: "string" }, { name: "observation-file", required: false, valueKind: "string" }] },
  { name: "adapter-deactivate", availability: "cli", mutates: true, flags: [{ name: "activation-receipt", required: true, valueKind: "string" }, { name: "activation-receipt-digest", required: true, valueKind: "string" }] },
  { name: "adapter-fallback", availability: "cli", mutates: false, flags: [{ name: "input", required: true, valueKind: "string" }] },
  { name: "adapter-generate", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }] },
  { name: "adapter-install", availability: "cli", mutates: true, flags: [{ name: "request", required: true, valueKind: "json" }, { name: "installation-root", required: true, valueKind: "string" }, { name: "generation-id", required: true, valueKind: "string" }, { name: "receipt-out", required: true, valueKind: "string" }] },
  { name: "adapter-rollback-plan", availability: "cli", mutates: false, flags: [{ name: "bundle", required: true, valueKind: "json" }, { name: "installation-receipt", required: true, valueKind: "string" }, { name: "installation-receipt-digest", required: false, valueKind: "string" }] },
  { name: "adapter-simulate", availability: "cli", mutates: false, flags: [{ name: "lifecycle", required: true, valueKind: "json" }] },
  { name: "adapter-uninstall", availability: "cli", mutates: true, flags: [{ name: "bundle", required: true, valueKind: "json" }, { name: "installation-receipt", required: true, valueKind: "string" }, { name: "installation-receipt-digest", required: false, valueKind: "string" }] },
  { name: "adapter-validate", availability: "cli", mutates: false, flags: [{ name: "bundle", required: true, valueKind: "json" }, { name: "baseline", required: false, valueKind: "json" }, { name: "settings", required: false, valueKind: "string" }] },
  { name: "aos-requirements-readback", availability: "cli", mutates: false, flags: [{ name: "ledger", required: true, valueKind: "string" }] },
  { name: "aos-requirements-validate", availability: "cli", mutates: false, flags: [{ name: "ledger", required: true, valueKind: "string" }] },
  { name: "artifact-archive-apply", availability: "fixture-only", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-plan-digest", required: true, valueKind: "string" }] },
  { name: "artifact-archive-dry-run", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "artifact-archive-restore", availability: "fixture-only", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "archive-id", required: true, valueKind: "string" }, { name: "expected-plan-digest", required: true, valueKind: "string" }] },
  { name: "artifact-compact-dry-run", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "artifact-doctor", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "warning-bytes", required: false, valueKind: "integer" }, { name: "critical-bytes", required: false, valueKind: "integer" }, { name: "warning-count", required: false, valueKind: "integer" }, { name: "critical-count", required: false, valueKind: "integer" }] },
  { name: "artifact-size", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "attestation-enable", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "actor", required: true, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "claude-adapter-activation-fragment", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }, { name: "installation-root", required: true, valueKind: "string" }] },
  { name: "claude-adapter-activation-merge", availability: "cli", mutates: true, flags: [{ name: "settings", required: true, valueKind: "string" }, { name: "fragment", required: true, valueKind: "string" }] },
  { name: "claude-adapter-activation-remove", availability: "cli", mutates: true, flags: [{ name: "settings", required: true, valueKind: "string" }, { name: "fragment", required: true, valueKind: "string" }] },
  { name: "claude-adapter-activation-uninstall", availability: "cli", mutates: true, flags: [{ name: "activation-receipt", required: true, valueKind: "string" }, { name: "activation-receipt-digest", required: true, valueKind: "string" }] },
  { name: "claude-adapter-fallback", availability: "cli", mutates: false, flags: [{ name: "input", required: true, valueKind: "string" }] },
  { name: "claude-adapter-generate", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }] },
  { name: "claude-adapter-install", availability: "cli", mutates: true, flags: [{ name: "request", required: true, valueKind: "json" }, { name: "installation-root", required: true, valueKind: "string" }, { name: "generation-id", required: true, valueKind: "string" }, { name: "receipt-out", required: true, valueKind: "string" }, { name: "step2", required: false, valueKind: "boolean" }, { name: "step3", required: false, valueKind: "boolean" }] },
  { name: "claude-adapter-rollback-plan", availability: "cli", mutates: false, flags: [{ name: "bundle", required: true, valueKind: "json" }, { name: "installation-receipt", required: true, valueKind: "string" }, { name: "installation-receipt-digest", required: false, valueKind: "string" }] },
  { name: "claude-adapter-settings-fragment", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }] },
  { name: "claude-adapter-settings-merge", availability: "cli", mutates: true, flags: [{ name: "settings", required: true, valueKind: "string" }, { name: "fragment", required: true, valueKind: "string" }] },
  { name: "claude-adapter-settings-remove", availability: "cli", mutates: true, flags: [{ name: "settings", required: true, valueKind: "string" }, { name: "fragment", required: true, valueKind: "string" }] },
  { name: "claude-adapter-simulate", availability: "cli", mutates: false, flags: [{ name: "lifecycle", required: true, valueKind: "json" }] },
  { name: "claude-adapter-uninstall", availability: "cli", mutates: true, flags: [{ name: "bundle", required: true, valueKind: "json" }, { name: "installation-receipt", required: true, valueKind: "string" }, { name: "installation-receipt-digest", required: false, valueKind: "string" }] },
  { name: "claude-adapter-validate", availability: "cli", mutates: false, flags: [{ name: "bundle", required: true, valueKind: "json" }] },
  { name: "codex-execution-observe", availability: "cli", mutates: false, flags: [{ name: "input", required: true, valueKind: "json" }] },
  { name: "commands", availability: "cli", mutates: false, flags: [] },
  { name: "compatibility-dry-run", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }] },
  { name: "compatibility-plan", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }] },
  { name: "compatibility-unavailable", availability: "cli", mutates: false, flags: [{ name: "surface", required: true, valueKind: "string" }] },
  { name: "compatibility-validate", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }] },
  { name: "conference-append-position", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "conference-id", required: true, valueKind: "string" }, { name: "external-key", required: true, valueKind: "string" }, { name: "actor-id", required: true, valueKind: "string" }, { name: "position", required: true, valueKind: "string" }, { name: "risks", required: true, valueKind: "list" }, { name: "recommendations", required: true, valueKind: "list" }, { name: "evidence-ids", required: true, valueKind: "list" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "conference-cancel", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "conference-id", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "conference-close", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "conference-id", required: true, valueKind: "string" }, { name: "minutes-external-key", required: true, valueKind: "string" }, { name: "summary", required: true, valueKind: "string" }, { name: "outcome-class", required: true, valueKind: "string" }, { name: "decisions", required: true, valueKind: "list" }, { name: "unresolved-issues", required: true, valueKind: "list" }, { name: "actor", required: false, valueKind: "string" }, { name: "distill", required: false, valueKind: "boolean" }, { name: "accountable-owner-id", required: false, valueKind: "string" }, { name: "stale-days", required: false, valueKind: "integer" }, { name: "evidence-ids", required: false, valueKind: "list" }, { name: "attest-dir", required: false, valueKind: "string" }, { name: "execution-form", required: false, valueKind: "string" }] },
  { name: "conference-list-by-work", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "work-id", required: true, valueKind: "string" }] },
  { name: "conference-minutes-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "conference-id", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "conference-open", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "external-key", required: true, valueKind: "string" }, { name: "project-id", required: true, valueKind: "string" }, { name: "type", required: true, valueKind: "string" }, { name: "title", required: true, valueKind: "string" }, { name: "work-ids", required: true, valueKind: "list" }, { name: "desired-outcome", required: true, valueKind: "string" }, { name: "participant-ids", required: true, valueKind: "list" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "conference-position-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "conference-id", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "context-route", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }, { name: "profile-receipt", required: true, valueKind: "string" }, { name: "authority", required: true, valueKind: "string" }, { name: "profile-receipt-digest", required: false, valueKind: "string" }, { name: "authority-digest", required: false, valueKind: "string" }] },
  { name: "context-validate", availability: "cli", mutates: false, flags: [{ name: "result", required: true, valueKind: "string" }] },
  { name: "event-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "exchange-dry-run", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }, { name: "output", required: true, valueKind: "string" }] },
  { name: "exchange-plan", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }] },
  { name: "exchange-validate", availability: "cli", mutates: false, flags: [{ name: "bundle", required: true, valueKind: "string" }] },
  { name: "execution-config", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "host", required: false, valueKind: "string" }] },
  { name: "export", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "gate-create", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "external-key", required: true, valueKind: "string" }, { name: "project-id", required: true, valueKind: "string" }, { name: "work-id", required: true, valueKind: "string", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "title", required: true, valueKind: "string" }, { name: "outcome-class", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "gate-delete", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "gate-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "work-id", required: true, valueKind: "string" }] },
  { name: "gate-transition", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "status", required: true, valueKind: "string" }, { name: "minutes-locator", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }, { name: "identity-authority", required: false, valueKind: "string" }, { name: "identity-authority-digest", required: false, valueKind: "string" }] },
  { name: "host-config-default", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "host", required: true, valueKind: "string" }, { name: "name", required: false, valueKind: "string" }, { name: "clear", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "host-config-remove", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "host", required: true, valueKind: "string" }, { name: "name", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "host-config-set", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "host", required: true, valueKind: "string" }, { name: "name", required: true, valueKind: "string" }, { name: "model", required: true, valueKind: "string" }, { name: "note", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "init", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "framework", required: true, valueKind: "string" }, { name: "transient", required: true, valueKind: "string" }, { name: "evidence-locator", required: true, valueKind: "string" }, { name: "release-trust", required: true, valueKind: "string" }, { name: "external-key", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "segment-events", required: false, valueKind: "integer" }] },
  { name: "knowledge-body", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "id", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "allow-unpromoted", required: false, valueKind: "boolean" }, { name: "allow-stale", required: false, valueKind: "boolean" }] },
  { name: "knowledge-candidates", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "selection", required: false, valueKind: "string" }, { name: "project-id", required: false, valueKind: "string" }, { name: "role-scope", required: false, valueKind: "string" }, { name: "category", required: false, valueKind: "string" }, { name: "kind", required: false, valueKind: "string" }, { name: "tag", required: false, valueKind: "string" }, { name: "freshness", required: false, valueKind: "string" }, { name: "promotion", required: false, valueKind: "string" }, { name: "search", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "knowledge-checkpoint", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "knowledge-create", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "external-key", required: true, valueKind: "string" }, { name: "scope", required: true, valueKind: "string" }, { name: "project-id", required: true, valueKind: "string", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "role-scopes", required: true, valueKind: "list" }, { name: "category", required: true, valueKind: "string" }, { name: "kind", required: true, valueKind: "string" }, { name: "tags", required: true, valueKind: "list" }, { name: "subject", required: true, valueKind: "string" }, { name: "summary", required: true, valueKind: "string" }, { name: "snippet", required: true, valueKind: "string" }, { name: "accountable-owner-id", required: true, valueKind: "string" }, { name: "source-references", required: true, valueKind: "list" }, { name: "source-digest", required: true, valueKind: "string" }, { name: "work-ids", required: true, valueKind: "list" }, { name: "decision-ids", required: true, valueKind: "list" }, { name: "gate-ids", required: true, valueKind: "list" }, { name: "evidence-ids", required: true, valueKind: "list" }, { name: "lifecycle", required: true, valueKind: "string" }, { name: "retrieval", required: true, valueKind: "string" }, { name: "freshness", required: true, valueKind: "string" }, { name: "last-verified", required: true, valueKind: "instant", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "stale-days", required: true, valueKind: "integer" }, { name: "export", required: true, valueKind: "string" }, { name: "body", required: true, valueKind: "string" }] },
  { name: "knowledge-freshness", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "knowledge-init", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "acknowledge-disposable", required: false, valueKind: "boolean" }] },
  { name: "knowledge-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "selection", required: false, valueKind: "string" }, { name: "project-id", required: false, valueKind: "string" }, { name: "role-scope", required: false, valueKind: "string" }, { name: "category", required: false, valueKind: "string" }, { name: "kind", required: false, valueKind: "string" }, { name: "tag", required: false, valueKind: "string" }, { name: "freshness", required: false, valueKind: "string" }, { name: "promotion", required: false, valueKind: "string" }, { name: "search", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "knowledge-promote", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer" }, { name: "expected-revision", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "state", required: true, valueKind: "string" }] },
  { name: "knowledge-rebase", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "retire-invalid", required: false, valueKind: "boolean" }] },
  { name: "knowledge-retire", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer" }, { name: "expected-revision", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }] },
  { name: "knowledge-reverify", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer" }, { name: "expected-revision", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }] },
  { name: "knowledge-snippet", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "id", required: true, valueKind: "string" }] },
  { name: "knowledge-validate", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "lease-break", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "owner-token", required: true, valueKind: "string" }] },
  { name: "lease-inspect", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "lease-recovery-break", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "claim-token", required: true, valueKind: "string" }] },
  // STORY-178/INC-072: the file↔pg migration verb family, in canonical name
  // order (execute/plan/rollback/verify). `to` names the target backend; `schema`
  // (optional) names the PG chain schema (e.g. `chain_cross`); it defaults to
  // $TCRN_PG_SCHEMA, and the PG connection defaults to $TCRN_PG_CONNECTION.
  { name: "migration-execute", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "to", required: true, valueKind: "string" }, { name: "schema", required: false, valueKind: "string" }] },
  { name: "migration-plan", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "target-version", required: true, valueKind: "integer" }, { name: "dry-run", required: true, valueKind: "boolean" }] },
  { name: "migration-rollback", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "schema", required: false, valueKind: "string" }] },
  { name: "migration-verify", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "to", required: true, valueKind: "string" }, { name: "schema", required: false, valueKind: "string" }] },
  { name: "persona-binding-remove", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "profile-id", required: true, valueKind: "string" }, { name: "host", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "persona-binding-set", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "profile-id", required: true, valueKind: "string" }, { name: "host", required: true, valueKind: "string" }, { name: "name", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "persona-generate", availability: "cli", mutates: false, flags: [{ name: "set", required: true, valueKind: "string" }] },
  { name: "persona-render", availability: "cli", mutates: false, flags: [{ name: "profile-id", required: true, valueKind: "string" }] },
  { name: "persona-validate", availability: "cli", mutates: false, flags: [{ name: "bundle", required: true, valueKind: "json" }] },
  { name: "profile-authorize", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }, { name: "receipt", required: true, valueKind: "string" }, { name: "operation", required: true, valueKind: "string" }, { name: "workspace-id", required: true, valueKind: "string", nullSentinel: "-" }, { name: "project-id", required: true, valueKind: "string", nullSentinel: "-" }, { name: "command", required: true, valueKind: "string", nullSentinel: "-" }, { name: "receipt-digest", required: false, valueKind: "string" }] },
  { name: "profile-generate", availability: "cli", mutates: false, flags: [{ name: "mode", required: true, valueKind: "string" }] },
  { name: "profile-resolve", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }, { name: "receipt", required: true, valueKind: "string" }, { name: "receipt-digest", required: false, valueKind: "string" }] },
  { name: "profile-validate", availability: "cli", mutates: false, flags: [{ name: "bundle", required: true, valueKind: "json" }] },
  { name: "project-create", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "external-key", required: true, valueKind: "string" }, { name: "name", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "project-delete", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "project-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "project-update", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "name", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "recover", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "relocation-abort", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "actor", required: true, valueKind: "string" }, { name: "relocation-id", required: true, valueKind: "string" }, { name: "acknowledge-fork-risk", required: true, valueKind: "boolean" }, { name: "relocation-authority", required: true, valueKind: "string" }, { name: "relocation-authority-digest", required: true, valueKind: "string" }, { name: "target-inspection", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "relocation-adopt", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "framework", required: true, valueKind: "string" }, { name: "transient", required: true, valueKind: "string" }, { name: "evidence-locator", required: true, valueKind: "string" }, { name: "release-trust", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "actor", required: true, valueKind: "string" }, { name: "relocation-id", required: true, valueKind: "string" }, { name: "control-manifest", required: true, valueKind: "string" }, { name: "relocation-authority", required: true, valueKind: "string" }, { name: "relocation-authority-digest", required: true, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "relocation-inspect", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "relocation-plan", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "to-framework", required: true, valueKind: "string" }, { name: "to-workspace-root", required: true, valueKind: "string" }, { name: "to-transient", required: true, valueKind: "string" }, { name: "to-evidence-locator", required: true, valueKind: "string" }, { name: "to-release-trust", required: true, valueKind: "string" }, { name: "control-manifest-out", required: false, valueKind: "string" }] },
  { name: "relocation-vacate", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "actor", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "to-framework", required: true, valueKind: "string" }, { name: "to-workspace-root", required: true, valueKind: "string" }, { name: "to-transient", required: true, valueKind: "string" }, { name: "to-evidence-locator", required: true, valueKind: "string" }, { name: "to-release-trust", required: true, valueKind: "string" }, { name: "relocation-authority", required: true, valueKind: "string" }, { name: "relocation-authority-digest", required: true, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }, { name: "control-manifest-out", required: false, valueKind: "string" }] },
  { name: "settings-catalog", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "settings-set", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "key", required: true, valueKind: "string" }, { name: "value", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "snapshot-manifest", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "snapshot-verify", availability: "cli", mutates: false, flags: [{ name: "root", required: true, valueKind: "string" }, { name: "manifest", required: true, valueKind: "string" }] },
  { name: "status", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  // INC-074/INC-081: seal a retained file archive to an already authoritative
  // PG chain. This is deliberately separate from migration-execute: a divergent
  // archive must not be overwritten or treated as a resumable prefix. The PG
  // wrapper proves the live chain first; this verb writes only the engine-owned
  // storage-home declaration and is idempotent for the same declaration.
  { name: "storage-home-seal", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "schema", required: true, valueKind: "string" }] },
  { name: "storage-home-status", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "template-admit", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "template", required: true, valueKind: "string" }, { name: "owner", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "template-validate", availability: "cli", mutates: false, flags: [{ name: "template", required: true, valueKind: "string" }] },
  { name: "validate", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "work-annotate", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "scope", required: false, valueKind: "string" }, { name: "decided-by", required: false, valueKind: "list" }, { name: "sprint", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "work-create", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "project-id", required: true, valueKind: "string" }, { name: "external-key", required: true, valueKind: "string" }, { name: "kind", required: true, valueKind: "string" }, { name: "parent-id", required: false, valueKind: "string", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "status", required: false, valueKind: "string" }, { name: "scope", required: false, valueKind: "string" }, { name: "decided-by", required: false, valueKind: "list" }, { name: "template-receipt", required: false, valueKind: "json" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "work-delete", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "work-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "project-id", required: false, valueKind: "string" }, { name: "kind", required: false, valueKind: "string" }, { name: "status", required: false, valueKind: "string" }, { name: "parent-id", required: false, valueKind: "string" }, { name: "sprint", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "work-show", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "id", required: true, valueKind: "string" }] },
  { name: "work-transition", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "status", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
] as const);

// INC-016: `mutates` and `authorityBearing` name two DIFFERENT authorization
// categories, and the operator bundle keeps their grant lists disjoint
// (validateOperatorAuthorityBundle refuses a command present in both). Nothing
// refused the FLAG pair, and the MCP dispatcher tests `mutates` first -- so an entry
// declaring both would be satisfied by a writeCommands grant alone: a write grant
// carrying authority-bearing output, which operator-authority-mcp-v1 forbids
// outright ("A write grant never authorizes it").
//
// The exclusion lives at the declaration, not in a consumer. Three sites read the
// pair independently (tool description, tool annotations, grant gate), mcp.ts
// re-types the catalog through its own local interface, and the `commands` verb
// publishes it to third parties. A contradictory catalog must therefore not be
// constructible, rather than merely unusable through one surface.
export function assertCatalogCategoriesExclusive(
  commands: readonly {
    readonly name: string;
    readonly mutates: boolean;
    readonly authorityBearing?: boolean;
  }[],
): void {
  for (const entry of commands) {
    if (entry.mutates && entry.authorityBearing === true) {
      fail(
        "CLI_CATALOG_CATEGORY_AMBIGUOUS",
        `${entry.name}: a command is either a governed write or authority-bearing output, never both`,
      );
    }
  }
}

// Fail at module load, not at first use: the contradiction is a property of the
// declaration above, and mcp.ts imports this module before it can dispatch anything.
assertCatalogCategoriesExclusive(COMMAND_CATALOG);

// INC-012: authority-bearing is a property of what a verb EMITS, not a flag its author
// remembered to set. tests/act13:355 enumerated the flag, so a future verb minting
// host-state output without it reddened nothing. These are the field names and the state
// tokens that make a document readable as observed host trust state; the act13 vocabulary
// test binds this list two-way to the authority documents core actually declares, so a new
// host-state field cannot land without either entering this list or failing that test.
export const AUTHORITY_OUTPUT_FIELDS = Object.freeze([
  "activationState",
  "currentDefinitionApproved",
  "hookFired",
  "trustApprovalObserved",
] as const);

// Retired tokens stay guarded. "approved_current_definition" was withdrawn from the product
// by INC-012 because only the caller-supplied comparison ever minted it; keeping it here
// means re-minting it under any field name still fails closed.
export const AUTHORITY_STATE_TOKENS = Object.freeze([
  "approved_current_definition",
  "host_observed_active",
  "pending_host_approval",
] as const);

const authorityOutputNeedles = Object.freeze([
  ...AUTHORITY_OUTPUT_FIELDS,
  ...AUTHORITY_STATE_TOKENS,
].map((token) => `"${token}"`));

// Only the three properties the boundary judges. The catalog's own literal type carries
// more, and mcp.ts declares its own fuller view of the same rows.
interface CatalogOutputDeclaration {
  readonly name: string;
  readonly mutates: boolean;
  readonly authorityBearing?: boolean;
}

// Object KEYS carry the claim, so caller text that merely mentions a guarded name inside a
// string value is not a finding -- otherwise a knowledge body or a conference position
// quoting these docs would fail a read closed. A guarded token under a differently spelled
// state key is the same claim wearing another name, so the token space is checked too.
export function authorityShapedOutputFields(output: string): readonly string[] {
  if (!authorityOutputNeedles.some((needle) => output.includes(needle))) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Bytes that spell the claim but cannot be read are refused rather than waved through.
    return Object.freeze(authorityOutputNeedles
      .filter((needle) => output.includes(needle))
      .map((needle) => needle.slice(1, -1))
      .sort());
  }
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node as readonly unknown[]) walk(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, child] of Object.entries(node as Readonly<Record<string, unknown>>)) {
      if ((AUTHORITY_OUTPUT_FIELDS as readonly string[]).includes(key)) found.add(key);
      if (typeof child === "string" && /state$/iu.test(key) &&
        (AUTHORITY_STATE_TOKENS as readonly string[]).includes(child)) {
        found.add(key);
      }
      walk(child);
    }
  };
  walk(parsed);
  return Object.freeze([...found].sort());
}

// The write boundary every dispatched verb passes through. The catalog declares which verbs
// may speak about host trust state; this reads the bytes and checks that declaration rather
// than trusting it. A verb absent from the catalog has declared nothing and may not speak.
export function assertDeclaredOutputCategory(command: string, output: string): void {
  const fields = authorityShapedOutputFields(output);
  if (fields.length === 0) return;
  const entry = (COMMAND_CATALOG as readonly CatalogOutputDeclaration[])
    .find((candidate) => candidate.name === command);
  if (entry !== undefined && (entry.mutates || entry.authorityBearing === true)) return;
  fail(
    "CLI_AUTHORITY_OUTPUT_UNDECLARED",
    `${command} emits host trust state (${fields.join(",")}) without a catalog mutates or authorityBearing declaration`,
  );
}

export async function runCli(arguments_: readonly string[], io: CliIo): Promise<void> {
  const command = arguments_[0];
  if (!command || command.startsWith("--")) {
    fail("CLI_COMMAND_REQUIRED", "A governed command is required");
  }
  // INC-012: the dispatcher writes only through this wrapper, so the output-category guard
  // covers every verb -- including ones added later, which is the whole point of moving the
  // check from the flag to the bytes.
  const dispatch = async (): Promise<void> => {
    await dispatchCli(arguments_, {
      ...io,
      write: (value: string): void => {
        assertDeclaredOutputCategory(command, value);
        io.write(value);
      },
    });
  };
  // STORY-189 switch window: a facade serving a PG-backed chain sets TCRN_PG_CONNECTION +
  // TCRN_PG_SCHEMA, and every verb that touches a workspace then reads that chain from
  // Postgres instead of the file tree. The migration verbs are excluded — they carry their
  // own explicit backends (resolveBackend prefers options over the factory), so a wrap here
  // would only add a wasted connection. `commands` is excluded too: it answers from the
  // catalogue, not a workspace, and the facade re-derives the tool table from it every TTL.
  const connection = process.env.TCRN_PG_CONNECTION;
  const schema = process.env.TCRN_PG_SCHEMA;
  const migrationVerbs = new Set(["migration-plan", "migration-execute", "migration-verify", "migration-rollback"]);
  const wrapsWorkspace = (verb: string): boolean => {
    if (verb === "commands" || migrationVerbs.has(verb)) return false;
    const entry = COMMAND_CATALOG.find((candidate) => candidate.name === verb);
    return entry?.flags.some((flag) => flag.name === "workspace") ?? false;
  };
  if (typeof connection === "string" && connection.length > 0 &&
      typeof schema === "string" && schema.length > 0 &&
      wrapsWorkspace(command)) {
    // INC-074: a PG-facing path must name the schema the workspace's storage-home
    // sentinel declares. A config pointing at the wrong schema — or one that would
    // silently serve a different chain — refuses named instead of answering wrong.
    const workspaceValue = arguments_.find((entry, index) => index > 0 && (entry === "--workspace" || entry.startsWith("--workspace=")));
    const workspaceRoot = workspaceValue === undefined
      ? null
      : workspaceValue === "--workspace"
        ? arguments_[arguments_.indexOf("--workspace") + 1] ?? null
        : workspaceValue.slice("--workspace=".length);
    if (typeof workspaceRoot === "string" && workspaceRoot.length > 0) {
      let home;
      try {
        home = await readStorageHomeDeclaration(workspaceRoot);
      } catch (error) {
        // INC-074: malformed or unsafe is not the same as absent. Swallowing
        // this error would reopen the fork path the sentinel closes.
        fail(
          typeof (error as { reasonCode?: unknown }).reasonCode === "string"
            ? String((error as { reasonCode: string }).reasonCode)
            : "STORAGE_HOME_INVALID",
          String((error as { message?: unknown }).message ?? error),
        );
      }
      if (home !== null && home.storage === "pg" && home.schema !== undefined && home.schema !== schema) {
        fail(
          "CLI_SCHEMA_MISMATCH",
          `workspace ${workspaceRoot} declares storage-home pg:${home.schema} but this path is configured for ${schema}; ` +
          "the sentinel schema is the only valid target",
        );
      }
    }
    const { PgBackend, PgStoreBackend } = await import("../../pg-backend/src/index.js");
    const backend = new PgBackend({ schema, connection });
    const storeBackend = new PgStoreBackend({ schema, connection });
    await backend.connect();
    await storeBackend.connect();
    try {
      await withStorageBackendFactory(() => backend, () =>
        withStoreBackendFactory(() => storeBackend, dispatch));
    } finally {
      await closeMigrationBackends({ backend: () => backend, storeBackend: () => storeBackend });
    }
    return;
  }
  await dispatch();
}

async function dispatchCli(arguments_: readonly string[], io: CliIo): Promise<void> {
  const command = arguments_[0];
  if (!command || command.startsWith("--")) {
    fail("CLI_COMMAND_REQUIRED", "A governed command is required");
  }
  const rest = arguments_.slice(1);
  // requiredShared is the mandatory trio every workspace-event mutation verb demands
  // via required(); shared is the ALLOWED-flag list those verbs pass to parseArguments.
  // WSE-4: --attest-dir joins shared (allowed) but NOT requiredShared, so it is a
  // catalog-OPTIONAL flag on every mutation verb.
  const requiredShared = ["workspace", "expected-version", "at"];
  const shared = [...requiredShared, "attest-dir"];
  if (command === "commands") {
    parseArguments(rest, []);
    io.write(canonicalJson({ reasonCode: "CLI_CATALOG_READY", schemaVersion: "tcrn.cli-catalog.v1", commands: COMMAND_CATALOG }));
    return;
  }
  if (command === "aos-requirements-validate" || command === "aos-requirements-readback") {
    const values = parseArguments(rest, ["ledger"]);
    required(values, ["ledger"]);
    const ledger = parsePublicAosRequirementsLedger(aosRequirementsJson(values.ledger, "ledger"));
    if (command === "aos-requirements-validate") {
      io.write(canonicalJson({ reasonCode: publicAosRequirementsValidReason, ledgerDigest: ledger.ledgerDigest, requirements: ledger.requirements.length }));
    } else {
      io.write(canonicalJson(publicAosRequirementsReadback(ledger)));
    }
    return;
  }
  if (command === "compatibility-validate") {
    const values = parseArguments(rest, ["request"]);
    required(values, ["request"]);
    const request = validateCompatibilityRequest(compatibilityJson(values.request, "request"));
    io.write(canonicalJson({ reasonCode: "COMPATIBILITY_MANIFEST_VALID", requestDigest: request.requestDigest, manifestDigest: request.manifest.manifestDigest }));
    return;
  }
  if (command === "compatibility-plan" || command === "compatibility-dry-run") {
    const values = parseArguments(rest, ["request"]);
    required(values, ["request"]);
    if (!io.compatibilityAdmissionAuthority) fail("COMPATIBILITY_AUTHORITY_REQUIRED", "governed compatibility admission authority is required; compatibility-plan and compatibility-dry-run are programmatic-only from the shipped binary (see docs/architecture/agent-integration-v1.md)");
    const request = compatibilityJson(values.request, "request");
    const admission = await readCompatibilityAdmissionReceipt(io.compatibilityAdmissionAuthority.expectedCanonicalPath, io.compatibilityAdmissionAuthority);
    io.write(canonicalJson(command === "compatibility-plan"
      ? planCompatibilityMode(request, admission)
      : dryRunCompatibilityMode(request, admission)));
    return;
  }
  if (command === "compatibility-unavailable") {
    const values = parseArguments(rest, ["surface"]);
    required(values, ["surface"]);
    io.write(canonicalJson(unavailableCompatibilityCapability(values.surface)));
    return;
  }
  if (command === "exchange-plan") {
    const values = parseArguments(rest, ["request"]);
    required(values, ["request"]);
    io.write(canonicalJson(planCanonicalExchange(exchangeJson(values.request, "request"))));
    return;
  }
  if (command === "exchange-validate") {
    const values = parseArguments(rest, ["bundle"]);
    required(values, ["bundle"]);
    io.write(canonicalJson(await validateCanonicalExchangeBundle(values.bundle ?? "")));
    return;
  }
  if (command === "exchange-dry-run") {
    const values = parseArguments(rest, ["request", "output"]);
    required(values, ["request", "output"]);
    io.write(canonicalJson(dryRunCanonicalExchange(exchangeJson(values.request, "request"), values.output ?? "")));
    return;
  }
  if (command === "profile-generate") {
    const values = parseArguments(rest, ["mode"]);
    required(values, ["mode"]);
    if (values.mode !== "generic") fail("PROFILE_INPUT_INVALID", "mode");
    io.write(canonicalJson({ reasonCode: "PROFILE_BUNDLE_GENERATED", bundle: generateGenericStarterBundle() }));
    return;
  }
  if (command === "persona-generate") {
    const values = parseArguments(rest, ["set"]); required(values, ["set"]);
    if (values.set !== "core-reference") fail("PROFILE_INPUT_INVALID", "set");
    io.write(canonicalJson({ reasonCode: "PERSONA_BUNDLE_GENERATED", bundle: generateCorePersonaBundle() })); return;
  }
  if (command === "persona-render") {
    // Core Reference personas are conference-role reference data. Rendering is a
    // non-mutating stdout-only aid for attributing a conference position; no host
    // adapter consumes this output and no role is selected implicitly.
    const values = parseArguments(rest, ["profile-id"]); required(values, ["profile-id"]);
    io.write(canonicalJson(renderPersonaAuthoritySummary(generateCorePersonaBundle(), values["profile-id"] ?? ""))); return;
  }
  if (command === "persona-validate") {
    const values = parseArguments(rest, ["bundle"]); required(values, ["bundle"]);
    const bundle = validateCorePersonaBundle(jsonValue(values.bundle, "bundle"));
    io.write(canonicalJson({ reasonCode: "PERSONA_VALIDATED", bundleDigest: bundle.bundleDigest, profiles: bundle.profiles.length })); return;
  }
  if (command === "profile-validate") {
    const values = parseArguments(rest, ["bundle"]);
    required(values, ["bundle"]);
    const bundle = validateGenericStarterBundle(jsonValue(values.bundle, "bundle"));
    io.write(canonicalJson({
      reasonCode: "PROFILE_VALIDATED",
      bundleDigest: bundle.bundleDigest,
      layers: bundle.layers.length,
    }));
    return;
  }
  if (command === "profile-resolve") {
    const values = parseArguments(rest, ["request", "receipt", "receipt-digest"]);
    required(values, ["request", "receipt"]);
    const profileAuthority = suppliedAuthority(io.profileAdmissionAuthority, values.receipt, values["receipt-digest"]);
    const admission = await readGenericProfileAdmissionReceipt(values.receipt ?? "",
      profileAuthority ? { authority: profileAuthority } : {});
    io.write(canonicalJson(resolveGenericProfile(jsonValue(values.request, "request"), admission)));
    return;
  }
  if (command === "profile-authorize") {
    const values = parseArguments(rest, ["request", "receipt", "operation", "workspace-id", "project-id", "command", "receipt-digest"]);
    required(values, ["request", "receipt", "operation", "workspace-id", "project-id", "command"]);
    const profileAuthority = suppliedAuthority(io.profileAdmissionAuthority, values.receipt, values["receipt-digest"]);
    const admission = await readGenericProfileAdmissionReceipt(values.receipt ?? "",
      profileAuthority ? { authority: profileAuthority } : {});
    io.write(canonicalJson(authorizeGenericProfileOperation(
      jsonValue(values.request, "request"),
      admission,
      values.operation,
      {
        workspaceId: values["workspace-id"] === "-" ? null : values["workspace-id"],
        projectId: values["project-id"] === "-" ? null : values["project-id"],
        command: values.command === "-" ? null : values.command,
      },
    )));
    return;
  }
  if (command === "context-route") {
    const values = parseArguments(rest, ["request", "profile-receipt", "authority", "profile-receipt-digest", "authority-digest"]);
    required(values, ["request", "profile-receipt", "authority"]);
    const profileAuthority = suppliedAuthority(io.profileAdmissionAuthority, values["profile-receipt"], values["profile-receipt-digest"]);
    const routeAuthority = suppliedAuthority(io.contextRouteAuthority, values.authority, values["authority-digest"]);
    const profileAdmission = await readGenericProfileAdmissionReceipt(values["profile-receipt"] ?? "",
      profileAuthority ? { authority: profileAuthority } : {});
    const contextAuthority = await readContextRouteAuthorityReceipt(values.authority ?? "", routeAuthority);
    io.write(canonicalJson(routeContext(jsonValue(values.request, "request"), profileAdmission, contextAuthority)));
    return;
  }
  if (command === "context-validate") {
    const values = parseArguments(rest, ["result"]);
    required(values, ["result"]);
    const result = validateContextRouteResult(jsonValue(values.result, "result"));
    io.write(canonicalJson({ reasonCode: "CONTEXT_VALIDATED", contextDigest: result.contextDigest }));
    return;
  }
  if (command === "adapter-activate") {
    const values = parseArguments(rest, [
      "request",
      "installation-root",
      "generation-id",
      "installation-receipt",
      "installation-receipt-digest",
      "receipt-out",
      "capability-manifest-digest",
      "step3",
      "observe-events",
    ]);
    required(values, [
      "request",
      "installation-root",
      "generation-id",
      "installation-receipt",
      "receipt-out",
      "capability-manifest-digest",
    ]);
    const request = jsonValue(values.request, "request");
    const bundle = generateCodexAdapterBundle(request, io.codexAdapterHost);
    const installationPath = values["installation-receipt"] ?? "";
    const inertInstallation = await readCodexAdapterInstallationReceipt(
      installationPath,
      suppliedAuthority(
        io.codexAdapterInstallationAuthority,
        installationPath,
        values["installation-receipt-digest"],
      ),
    );
    const stage = booleanValue(values.step3, "step3") ? "step3" : "step2";
    const summary = generateCodexSessionSummary(
      bundle,
      values["capability-manifest-digest"],
      stage,
    );
    const installationRoot = await admitCodexAdapterInstallationRoot(
      values["installation-root"] ?? "",
    );
    const observeEvents = values["observe-events"] === undefined
      ? []
      : jsonValue(values["observe-events"], "observe-events");
    const projectManifest = bundle.files.find(
      (file) => file.path === ".codex/tcrn-workflow/project.json",
    );
    const artifacts = generateCodexActivationArtifacts(
      summary,
      installationRoot,
      observeEvents,
      projectManifest?.contentDigest,
    );
    const installed = await installCodexAdapterActivation(
      bundle,
      inertInstallation,
      artifacts,
      io.codexAdapterActivationHost,
      {
        installationRoot,
        generationId: values["generation-id"] ?? "",
        receiptPath: values["receipt-out"] ?? "",
      },
    );
    io.write(canonicalJson(installed.receipt));
    return;
  }
  if (command === "adapter-activation-assess") {
    const values = parseArguments(rest, [
      "binding",
      "approved-definition-digests",
    ]);
    required(values, ["binding", "approved-definition-digests"]);
    io.write(
      canonicalJson(
        assessCodexActivationTrust(
          jsonValue(values.binding, "binding"),
          jsonValue(
            values["approved-definition-digests"],
            "approved-definition-digests",
          ),
        ),
      ),
    );
    return;
  }
  if (command === "adapter-activation-record") {
    const values = parseArguments(rest, [
      "activation-receipt",
      "activation-receipt-digest",
      "observation-file",
    ]);
    required(values, ["activation-receipt"]);
    const receiptPath = values["activation-receipt"] ?? "";
    const installationContext = await readCodexActivationInstallationReceipt(
      receiptPath,
      suppliedAuthority(
        io.codexAdapterInstallationAuthority,
        receiptPath,
        values["activation-receipt-digest"],
      ),
    );
    const observationPath = values["observation-file"];
    if (
      io.codexHostActivationObservation !== undefined &&
      observationPath !== undefined
    ) {
      fail(
        "CLI_AUTHORITY_AMBIGUOUS",
        "activation observation supplied by both host context and file",
      );
    }
    const observationContext = io.codexHostActivationObservation ??
      await readCodexHostActivationObservation(
        observationPath ?? "",
        io.codexHostActivationObservationAuthority,
        io.codexHostActivationObservationFreshness,
      );
    io.write(
      canonicalJson(
        createCodexHostActivationReceipt(
          installationContext,
          observationContext,
        ),
      ),
    );
    return;
  }
  if (command === "adapter-deactivate") {
    const values = parseArguments(rest, [
      "activation-receipt",
      "activation-receipt-digest",
    ]);
    required(values, [
      "activation-receipt",
      "activation-receipt-digest",
    ]);
    const receiptPath = values["activation-receipt"] ?? "";
    const context = await readCodexActivationInstallationReceipt(receiptPath, {
      expectedCanonicalPath: receiptPath,
      expectedFileSha256: values["activation-receipt-digest"] ?? "",
    });
    io.write(canonicalJson(await uninstallCodexAdapterActivation(context)));
    return;
  }
  if (command === "adapter-generate") {
    const values = parseArguments(rest, ["request"]);
    required(values, ["request"]);
    io.write(canonicalJson(generateCodexAdapterBundle(jsonValue(values.request, "request"), io.codexAdapterHost)));
    return;
  }
  if (command === "adapter-validate") {
    const values = parseArguments(rest, ["bundle", "baseline", "settings"]);
    required(values, ["bundle"]);
    const bundle = validateCodexAdapterBundle(jsonValue(values.bundle, "bundle"));
    const baseline = values.baseline === undefined ? createAdapterBaseline() : jsonValue(values.baseline, "baseline");
    io.write(canonicalJson(validateAdapterSurface(bundle.bundleDigest, baseline, values.settings)));
    return;
  }
  if (command === "adapter-simulate") {
    const values = parseArguments(rest, ["lifecycle"]);
    required(values, ["lifecycle"]);
    io.write(canonicalJson(simulateCodexAdapterLifecycle(jsonValue(values.lifecycle, "lifecycle"))));
    return;
  }
  if (command === "adapter-fallback") {
    const values = parseArguments(rest, ["input"]);
    required(values, ["input"]);
    io.write(canonicalJson(codexAdapterAuthorityEmptyFallback(jsonValue(values.input, "input"))));
    return;
  }
  if (command === "adapter-install") {
    // EPIC-023 Step 1: generate the inert bundle under the independently governed
    // host, write it beneath <root>/.codex/tcrn-workflow/, and emit the canonical
    // installation receipt. No Codex host configuration is read or written and no
    // hook is registered -- activation is a separate step that needs a real host and
    // the operator's per-hash trust approval.
    const values = parseArguments(rest, ["request", "installation-root", "generation-id", "receipt-out"]);
    required(values, ["request", "installation-root", "generation-id", "receipt-out"]);
    const bundle = generateCodexAdapterBundle(jsonValue(values.request, "request"), io.codexAdapterHost);
    const result = await installCodexAdapterBundle(bundle, {
      installationRoot: values["installation-root"] ?? "",
      generationId: values["generation-id"] ?? "",
      receiptPath: values["receipt-out"] ?? "",
    });
    io.write(canonicalJson(result.receipt));
    return;
  }
  if (command === "adapter-rollback-plan") {
    const values = parseArguments(rest, ["bundle", "installation-receipt", "installation-receipt-digest"]);
    required(values, ["bundle", "installation-receipt"]);
    const installation = await readCodexAdapterInstallationReceipt(values["installation-receipt"] ?? "",
      suppliedAuthority(io.codexAdapterInstallationAuthority, values["installation-receipt"], values["installation-receipt-digest"]));
    io.write(canonicalJson(planCodexAdapterRollback(jsonValue(values.bundle, "bundle"), installation)));
    return;
  }
  if (command === "adapter-uninstall") {
    // Reverse of adapter-install. The TOCTOU-hardened reader admits the receipt under
    // the out-of-band authority, the planner derives the identity-gated removal set,
    // and the executor unlinks only files whose bytes still match -- a tampered file
    // fails INSTALLER_ROLLBACK_MISMATCH with nothing removed.
    const values = parseArguments(rest, ["bundle", "installation-receipt", "installation-receipt-digest"]);
    required(values, ["bundle", "installation-receipt"]);
    const installation = await readCodexAdapterInstallationReceipt(values["installation-receipt"] ?? "",
      suppliedAuthority(io.codexAdapterInstallationAuthority, values["installation-receipt"], values["installation-receipt-digest"]));
    const plan = planCodexAdapterRollback(jsonValue(values.bundle, "bundle"), installation);
    const result = await executeCodexAdapterRollback(plan, values["installation-receipt"] ?? "");
    io.write(canonicalJson({ reasonCode: result.reasonCode, planDigest: result.planDigest }));
    return;
  }
  if (command === "codex-execution-observe") {
    const values = parseArguments(rest, ["input"]);
    required(values, ["input"]);
    io.write(
      canonicalJson(
        collectCodexAppServerExecutions(jsonValue(values.input, "input")),
      ),
    );
    return;
  }
  if (command === "claude-adapter-generate") {
    const values = parseArguments(rest, ["request"]);
    required(values, ["request"]);
    io.write(canonicalJson(generateClaudeAdapterBundle(jsonValue(values.request, "request"), io.claudeAdapterHost)));
    return;
  }
  if (command === "claude-adapter-install") {
    // WSG-2 / activation ladder Step 1: generate the inert bundle under the
    // independently governed host, then write it to disk and emit the canonical
    // installation-generation receipt. .claude/settings.json is untouched.
    // WSG-3 --step2: additionally write the SessionStart handler, merge the v2
    // activation fragment into .claude/settings.json (temp O_EXCL then rename), and
    // emit the additive tcrn.claude-adapter-installation-generation.v2 receipt.
    const values = parseArguments(rest, ["request", "installation-root", "generation-id", "receipt-out", "step2", "step3"]);
    required(values, ["request", "installation-root", "generation-id", "receipt-out"]);
    const request = jsonValue(values.request, "request");
    const bundle = generateClaudeAdapterBundle(request, io.claudeAdapterHost);
    // --step3 remains a compatibility alias for the activation rung, but it no
    // longer installs or binds a Core Reference persona. Personas are conference-
    // only position attributions; the main-session handler is identical for Step 2
    // and Step 3 and explicitly preserves ordinary user-authorized repository work.
    const wantStep3 = booleanValue(values.step3, "step3");
    if (wantStep3 || booleanValue(values.step2, "step2")) {
      const scriptSource = generateSessionStartScript();
      const scriptDigest = sessionStartScriptDigest(scriptSource);
      const installationRoot = await admitClaudeAdapterInstallationRoot(
        values["installation-root"] ?? "",
      );
      const fragment = generateClaudeAdapterActivationFragment(
        request,
        io.claudeAdapterActivationHost,
        { scriptDigest, installationRoot },
      );
      const activation = await installClaudeAdapterActivation({
        installationRoot,
        generationId: values["generation-id"] ?? "",
        receiptPath: values["receipt-out"] ?? "",
        bundleDigest: bundle.bundleDigest,
        fragment,
        scriptSource,
      });
      io.write(canonicalJson(activation.receipt));
      return;
    }
    const result = await installClaudeAdapterBundle(bundle, {
      installationRoot: values["installation-root"] ?? "",
      generationId: values["generation-id"] ?? "",
      receiptPath: values["receipt-out"] ?? "",
    });
    io.write(canonicalJson(result.receipt));
    return;
  }
  if (command === "claude-adapter-activation-fragment") {
    // WSG-3 Step-2: emit the v2 activation fragment digest-bound to the governed
    // SessionStart handler under the independently governed activation host.
    const values = parseArguments(rest, ["request", "installation-root"]);
    required(values, ["request", "installation-root"]);
    const scriptDigest = sessionStartScriptDigest(generateSessionStartScript());
    const installationRoot = await admitClaudeAdapterInstallationRoot(
      values["installation-root"] ?? "",
    );
    io.write(canonicalJson(generateClaudeAdapterActivationFragment(jsonValue(values.request, "request"), io.claudeAdapterActivationHost, { scriptDigest, installationRoot })));
    return;
  }
  if (command === "claude-adapter-activation-merge") {
    // Prints the merged canonical settings text only; writing .claude/settings.json
    // stays the installer's action (constraint 7).
    const values = parseArguments(rest, ["settings", "fragment"]);
    required(values, ["settings", "fragment"]);
    io.write(mergeClaudeAdapterActivationFragment(values.settings ?? "", jsonValue(values.fragment, "fragment")));
    return;
  }
  if (command === "claude-adapter-activation-remove") {
    const values = parseArguments(rest, ["settings", "fragment"]);
    required(values, ["settings", "fragment"]);
    io.write(removeClaudeAdapterActivationFragment(values.settings ?? "", jsonValue(values.fragment, "fragment")));
    return;
  }
  if (command === "claude-adapter-activation-uninstall") {
    // S082: the operator entry point the v2 activation ladder was missing. Activated
    // installs emit a tcrn.claude-adapter-installation-generation.v2 receipt covering
    // the four templates plus session-start.mjs,
    // which the v1 uninstall path cannot read -- so an activated project had no way to
    // be uninstalled from a shell. The receipt is read under its out-of-band digest,
    // the plan is bound to the receipt's own on-disk identity, and the shared executor
    // removes only byte-and-identity matching files.
    //
    // Settings are NOT touched here: .claude/settings.json is restored byte-for-byte by
    // claude-adapter-activation-remove, which owns the merge it reverses. Removing the
    // files first would leave the hook pointing at a missing script, so the documented
    // order is activation-remove, then this verb.
    const values = parseArguments(rest, ["activation-receipt", "activation-receipt-digest"]);
    required(values, ["activation-receipt", "activation-receipt-digest"]);
    const receiptPath = values["activation-receipt"] ?? "";
    const context = await readClaudeAdapterActivationReceipt(receiptPath, {
      expectedCanonicalPath: receiptPath,
      expectedFileSha256: values["activation-receipt-digest"] ?? "",
    });
    const plan = generateClaudeAdapterActivationRollbackPlan(context.receipt, context.sourceIdentityDigest);
    const result = await executeClaudeAdapterRollback(plan, receiptPath);
    io.write(canonicalJson({ reasonCode: result.reasonCode, planDigest: result.planDigest, removedCount: result.removedCount }));
    return;
  }
  if (command === "claude-adapter-validate") {
    const values = parseArguments(rest, ["bundle"]);
    required(values, ["bundle"]);
    const bundle = validateClaudeAdapterBundle(jsonValue(values.bundle, "bundle"));
    io.write(canonicalJson({ reasonCode: "ADAPTER_VALIDATED", bundleDigest: bundle.bundleDigest, activation: false }));
    return;
  }
  if (command === "claude-adapter-simulate") {
    const values = parseArguments(rest, ["lifecycle"]);
    required(values, ["lifecycle"]);
    io.write(canonicalJson(simulateClaudeAdapterLifecycle(jsonValue(values.lifecycle, "lifecycle"))));
    return;
  }
  if (command === "claude-adapter-uninstall") {
    // WSG-2: reverse of claude-adapter-install. The TOCTOU-hardened reader admits
    // the receipt under the out-of-band authority, the planner derives the
    // identity-gated removal set, and the executor unlinks only files whose bytes
    // still match — a tampered file fails INSTALLER_ROLLBACK_MISMATCH untouched.
    const values = parseArguments(rest, ["bundle", "installation-receipt", "installation-receipt-digest"]);
    required(values, ["bundle", "installation-receipt"]);
    const installation = await readClaudeAdapterInstallationReceipt(values["installation-receipt"] ?? "",
      suppliedAuthority(io.claudeAdapterInstallationAuthority, values["installation-receipt"], values["installation-receipt-digest"]));
    const plan = planClaudeAdapterRollback(jsonValue(values.bundle, "bundle"), installation);
    const result = await executeClaudeAdapterRollback(plan, values["installation-receipt"] ?? "");
    io.write(canonicalJson({ reasonCode: result.reasonCode, planDigest: result.planDigest }));
    return;
  }
  if (command === "claude-adapter-fallback") {
    const values = parseArguments(rest, ["input"]);
    required(values, ["input"]);
    io.write(canonicalJson(claudeAdapterAuthorityEmptyFallback(jsonValue(values.input, "input"))));
    return;
  }
  if (command === "claude-adapter-rollback-plan") {
    const values = parseArguments(rest, ["bundle", "installation-receipt", "installation-receipt-digest"]);
    required(values, ["bundle", "installation-receipt"]);
    const installation = await readClaudeAdapterInstallationReceipt(values["installation-receipt"] ?? "",
      suppliedAuthority(io.claudeAdapterInstallationAuthority, values["installation-receipt"], values["installation-receipt-digest"]));
    io.write(canonicalJson(planClaudeAdapterRollback(jsonValue(values.bundle, "bundle"), installation)));
    return;
  }
  if (command === "claude-adapter-settings-fragment") {
    const values = parseArguments(rest, ["request"]);
    required(values, ["request"]);
    io.write(canonicalJson(generateClaudeAdapterSettingsFragment(jsonValue(values.request, "request"), io.claudeAdapterHost)));
    return;
  }
  if (command === "claude-adapter-settings-merge") {
    const values = parseArguments(rest, ["settings", "fragment"]);
    required(values, ["settings", "fragment"]);
    io.write(mergeClaudeAdapterSettingsFragment(values.settings ?? "", jsonValue(values.fragment, "fragment")));
    return;
  }
  if (command === "claude-adapter-settings-remove") {
    const values = parseArguments(rest, ["settings", "fragment"]);
    required(values, ["settings", "fragment"]);
    io.write(removeClaudeAdapterSettingsFragment(values.settings ?? "", jsonValue(values.fragment, "fragment")));
    return;
  }
  if (command === "init") {
    const names = ["workspace", "framework", "transient", "evidence-locator", "release-trust", "external-key", "at", "segment-events"];
    const values = parseArguments(rest, names);
    required(values, names.slice(0, 7));
    const roots: ExplicitRoot[] = [
      { kind: "framework", path: values.framework ?? "" },
      { kind: "workspace", path: values.workspace ?? "" },
      { kind: "transient", path: values.transient ?? "" },
      { kind: "evidence-locator", path: values["evidence-locator"] ?? "" },
      { kind: "release-trust", path: values["release-trust"] ?? "" },
    ];
    const state = await initializeWorkspace({
      roots,
      externalKey: values["external-key"] ?? "",
      createdAt: values.at ?? "",
      // WSB-2: the truthy guard dropped `--segment-events=` on the floor and initialized
      // the workspace as if no limit had been asked for; `!== undefined` makes the empty
      // string behave like the 0 it parses to, and integerValue names the flag when the
      // value is not an integer at all. The 2-1024 window stays core's call
      // (WORKSPACE_SCHEMA_INVALID), which is why no minimum is passed here.
      ...(values["segment-events"] !== undefined ? { segmentEventLimit: integerValue(values, "segment-events") } : {}),
    });
    writeState(io, state);
    return;
  }
  if (command === "validate") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    writeState(io, await validateWorkspace(values.workspace ?? ""));
    return;
  }
  if (command === "status") {
    // WSA-3 / SDC-10: status reads authority only and never staleness-fails, so an
    // agent can always observe the head; `validate` and the read verbs remain
    // view-verifying and fail closed with WORKSPACE_VIEW_STALE.
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    const workspace = values.workspace ?? "";
    const state = await materializeWorkspace(workspace);
    const storageHome = await readStorageHomeDeclaration(workspace);
    io.write(canonicalJson({
      reasonCode: "WORKSPACE_COMMAND_COMPLETED",
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      projects: state.projects.filter((entry) => !entry.tombstone).length,
      work: state.work.filter((entry) => !entry.tombstone).length,
      // Identity is metadata-only: no local path is exposed. A sealed archive
      // must tell a reader that its authority is PG and which workspace binding
      // it carries, rather than looking like an ordinary file-backed status.
      storageHome: storageHome === null ? null : {
        schemaVersion: storageHome.schemaVersion,
        storage: storageHome.storage,
        ...(storageHome.schema === undefined ? {} : { schema: storageHome.schema }),
        ...(storageHome.workspaceId === undefined ? {} : { workspaceId: storageHome.workspaceId }),
        migratedAt: storageHome.migratedAt,
      },
    }));
    return;
  }
  if (command === "lease-inspect") {
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    io.write(canonicalJson(await inspectWorkspaceLease(values.workspace ?? "", { now: values.at ?? "" })));
    return;
  }
  if (command === "lease-break") {
    const values = parseArguments(rest, ["workspace", "at", "owner-token"]);
    required(values, ["workspace", "at", "owner-token"]);
    io.write(canonicalJson(await breakWorkspaceLease(values.workspace ?? "", { now: values.at ?? "", ownerToken: values["owner-token"] ?? "" })));
    return;
  }
  if (command === "lease-recovery-break") {
    const values = parseArguments(rest, ["workspace", "at", "claim-token"]);
    required(values, ["workspace", "at", "claim-token"]);
    io.write(canonicalJson(await breakWorkspaceRecoveryClaim(values.workspace ?? "", { now: values.at ?? "", claimToken: values["claim-token"] ?? "" })));
    return;
  }
  if (command === "export") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(await exportWorkspace(values.workspace ?? ""));
    return;
  }
  if (command === "migration-plan") {
    const values = parseArguments(rest, ["workspace", "target-version", "dry-run"]);
    required(values, ["workspace", "target-version", "dry-run"]);
    if (values["dry-run"] !== "true") {
      fail("CLI_MIGRATION_DRY_RUN_REQUIRED", "P3 migration planning is dry-run only");
    }
    io.write(canonicalJson(await planWorkspaceMigration(values.workspace ?? "", integerValue(values, "target-version"))));
    return;
  }
  if (command === "migration-execute") {
    const values = parseArguments(rest, ["workspace", "to", "schema"]);
    required(values, ["workspace", "to"]);
    const options = await migrationOptions(values["to"] ?? "", values["schema"]);
    try {
      io.write(canonicalJson(await executeMigration(values.workspace ?? "", migrationTarget(values["to"] ?? ""), options)));
    } finally {
      await closeMigrationBackends(options);
    }
    return;
  }
  if (command === "migration-verify") {
    const values = parseArguments(rest, ["workspace", "to", "schema"]);
    required(values, ["workspace", "to"]);
    const options = await migrationOptions(values["to"] ?? "", values["schema"]);
    try {
      io.write(canonicalJson(await verifyMigration(values.workspace ?? "", migrationTarget(values["to"] ?? ""), options)));
    } finally {
      await closeMigrationBackends(options);
    }
    return;
  }
  if (command === "migration-rollback") {
    const values = parseArguments(rest, ["workspace", "schema"]);
    required(values, ["workspace"]);
    const options = await migrationOptions("pg", values["schema"]);
    try {
      io.write(canonicalJson(await rollbackMigration(values.workspace ?? "", options)));
    } finally {
      await closeMigrationBackends(options);
    }
    return;
  }
  if (command === "storage-home-seal") {
    const values = parseArguments(rest, ["workspace", "expected-version", "at", "schema"]);
    required(values, ["workspace", "expected-version", "at", "schema"]);
    const schema = values.schema ?? "";
    if (!/^chain_[a-z0-9_]+$/u.test(schema)) {
      fail("CLI_ARGUMENT_MALFORMED", "schema");
    }
    if (process.env.TCRN_PG_SCHEMA !== schema || typeof process.env.TCRN_PG_CONNECTION !== "string" || process.env.TCRN_PG_CONNECTION.length === 0) {
      fail("STORAGE_HOME_PG_REQUIRED", "storage-home-seal requires the named PG schema and connection in the engine environment");
    }
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const expected = expectedVersion(values);
    const lease = await acquireWorkspaceLease(workspace, {
      now: at,
      storageHomeAdmission: "migration",
    });
    try {
      // The PG wrapper has already admitted the named schema and injected the
      // PgBackend. Validate the live chain before sealing so the archive binding
      // cannot be written from a stale or unreadable authority.
      const state = await validateWorkspace(workspace);
      if (state.version !== expected) {
        fail("WORKSPACE_CAS_MISMATCH", `expected PG version ${String(expected)}, observed ${String(state.version)}`);
      }
      const declaration = await sealStorageHomeDeclaration(workspace, {
        schemaVersion: "tcrn.storage-home.v1",
        storage: "pg",
        schema,
        workspaceId: state.metadata.workspaceId,
        migratedAt: at,
      });
      io.write(canonicalJson({
        reasonCode: declaration.migratedAt === at ? "STORAGE_HOME_SEALED" : "STORAGE_HOME_ALREADY_SEALED",
        schemaVersion: declaration.schemaVersion,
        storage: declaration.storage,
        schema: declaration.schema,
        workspaceId: declaration.workspaceId,
        migratedAt: declaration.migratedAt,
        version: state.version,
        headEventHash: state.headEventHash,
      }));
    } finally {
      await lease.release();
    }
    return;
  }
  if (command === "storage-home-status") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    const declaration = await readStorageHomeDeclaration(values.workspace ?? "");
    if (declaration === null) {
      fail("STORAGE_HOME_NOT_DECLARED", "workspace has no storage-home declaration");
    }
    io.write(canonicalJson({ reasonCode: "STORAGE_HOME_READY", declaration }));
    return;
  }
  if (command === "template-validate") {
    const values = parseArguments(rest, ["template"]);
    required(values, ["template"]);
    const template = await readTemplateDocumentFile(values.template ?? "");
    io.write(canonicalJson(validateTemplateDocument(template)));
    return;
  }
  if (command === "template-admit") {
    const values = parseArguments(rest, [...shared, "template", "owner", "actor"]);
    required(values, [...requiredShared, "template", "owner"]);
    // The external edit surface is read and validated before taking the workspace
    // lease. Only the governed admission event below can make its digest effective.
    const template = await readTemplateDocumentFile(values.template ?? "");
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => admitTemplateInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at,
      template,
      ownerId: values.owner ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeTemplateAdmissionState(io, state, template.id, template.version);
    return;
  }
  if (command === "recover") {
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => recoverWorkspace(workspace, lease));
    writeState(io, state);
    return;
  }
  if (command === "relocation-plan") {
    // WSR-1 (post-review). Read-only, and MANDATORY in practice rather than by a
    // flag: a relocation permit now names the exact relocationId, and this is the
    // only route to it that is guaranteed to agree with the vacate — plan and vacate
    // share one preparation function precisely so they cannot drift. It also emits
    // the control manifest, which after the vacate commits is unobtainable at either
    // address while `relocation-adopt` requires its exact text.
    const values = parseArguments(rest, ["workspace", "at", "expected-version", "to-framework", "to-workspace-root", "to-transient", "to-evidence-locator", "to-release-trust", "control-manifest-out"]);
    required(values, ["workspace", "at", "expected-version", "to-framework", "to-workspace-root", "to-transient", "to-evidence-locator", "to-release-trust"]);
    const workspace = values.workspace ?? "";
    io.write(canonicalJson(await planWorkspaceRelocation(workspace, {
      at: values.at ?? "",
      destination: relocationDestination(values, "to-"),
      expectedVersion: await resolveExpectedVersion(values, workspace),
      controlManifestOut: values["control-manifest-out"],
    })));
    return;
  }
  if (command === "relocation-vacate") {
    // WSR-1. Its ONLY effect is to kill the source: it does not copy, does not reach
    // the target, and does not advance the chain. All five destination roots are
    // required — see RelocationDestination for why the terminal verb states the
    // whole destination binding rather than the workspace root alone.
    const values = parseArguments(rest, ["workspace", "at", "actor", "expected-version", "to-framework", "to-workspace-root", "to-transient", "to-evidence-locator", "to-release-trust", "relocation-authority", "relocation-authority-digest", "attest-dir", "control-manifest-out"]);
    required(values, ["workspace", "at", "actor", "expected-version", "to-framework", "to-workspace-root", "to-transient", "to-evidence-locator", "to-release-trust", "relocation-authority", "relocation-authority-digest"]);
    const workspace = values.workspace ?? "";
    const authority = await relocationAuthorityFor(values);
    const receipt = await vacateWorkspace(workspace, {
      at: values.at ?? "",
      actorId: values.actor ?? "",
      destination: relocationDestination(values, "to-"),
      authority,
      expectedVersion: await resolveExpectedVersion(values, workspace),
      controlManifestOut: values["control-manifest-out"],
    });
    await emitRelocationAttestation(io, values, receipt);
    io.write(canonicalJson(receipt));
    return;
  }
  if (command === "relocation-adopt") {
    const values = parseArguments(rest, ["workspace", "framework", "transient", "evidence-locator", "release-trust", "at", "actor", "relocation-id", "control-manifest", "relocation-authority", "relocation-authority-digest", "attest-dir"]);
    required(values, ["workspace", "framework", "transient", "evidence-locator", "release-trust", "at", "actor", "relocation-id", "control-manifest", "relocation-authority", "relocation-authority-digest"]);
    const authority = await relocationAuthorityFor(values);
    // The manifest travels with the operator, but it is not the trust carrier: the
    // ledger inside the copied tree holds its sha256, so a wrong or replayed
    // manifest is refused by the tree itself.
    const controlManifest = await readSnapshotManifestFile(values["control-manifest"] ?? "");
    const receipt = await adoptWorkspace(values.workspace ?? "", {
      at: values.at ?? "",
      actorId: values.actor ?? "",
      relocationId: values["relocation-id"] ?? "",
      roots: relocationDestination(values, ""),
      authority,
      controlManifest,
    });
    await emitRelocationAttestation(io, values, receipt);
    io.write(canonicalJson(receipt));
    return;
  }
  if (command === "relocation-abort") {
    const values = parseArguments(rest, ["workspace", "at", "actor", "relocation-id", "acknowledge-fork-risk", "relocation-authority", "relocation-authority-digest", "target-inspection", "attest-dir"]);
    required(values, ["workspace", "at", "actor", "relocation-id", "acknowledge-fork-risk", "relocation-authority", "relocation-authority-digest"]);
    const authority = await relocationAuthorityFor(values);
    // Optional by design and recorded either way: the legitimate abort (the copy was
    // never made, the destination host is unreachable) has no destination to inspect,
    // and a requirement that cannot be met in the case it exists for gets routed
    // around rather than obeyed. When it IS supplied the engine checks it and refuses
    // the abort outright if the destination already adopted.
    const targetInspection = values["target-inspection"] === undefined
      ? undefined
      : await readGovernedDocumentFile(values["target-inspection"], "target-inspection");
    const receipt = await abortWorkspaceRelocation(values.workspace ?? "", {
      at: values.at ?? "",
      actorId: values.actor ?? "",
      relocationId: values["relocation-id"] ?? "",
      acknowledgeForkRisk: booleanValue(values["acknowledge-fork-risk"], "acknowledge-fork-risk"),
      authority,
      ...(targetInspection === undefined ? {} : { targetInspection }),
    });
    await emitRelocationAttestation(io, values, receipt);
    io.write(canonicalJson(receipt));
    return;
  }
  if (command === "relocation-inspect") {
    // The ONLY instrument that can detect a fork — and only when run at BOTH
    // addresses and compared. Read-only, and admitted at every address including a
    // vacated or foreign one, because that is precisely where it must still answer.
    //
    // `--at` is required and is the caller's declaration of when the observation was
    // taken. It is stamped into the document as `observedAt`, which is what
    // `relocation-abort --target-inspection` bounds against its own `--at`: without it
    // two inspections taken either side of an adopt are byte-identical.
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    io.write(canonicalJson(await inspectWorkspaceRelocation(values.workspace ?? "", { at: values.at ?? "" })));
    return;
  }
  if (command === "settings-catalog") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    const state = await materializeWorkspace(values.workspace ?? "");
    io.write(canonicalJson({ reasonCode: "SETTINGS_CATALOG_READY", ...readSettingsCatalog(state.metadata.workspaceId, state.settings) }));
    return;
  }
  if (command === "host-config-set") {
    const values = parseArguments(rest, [...shared, "host", "name", "model", "note", "actor"]);
    required(values, [...requiredShared, "host", "name", "model"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => setHostConfigurationInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at,
      host: values.host ?? "", name: values.name ?? "", model: values.model ?? "", note: values.note ?? null,
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeExecutionConfigState(io, state);
    return;
  }
  if (command === "host-config-remove") {
    const values = parseArguments(rest, [...shared, "host", "name", "actor"]);
    required(values, [...requiredShared, "host", "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => removeHostConfigurationInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at, host: values.host ?? "", name: values.name ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeExecutionConfigState(io, state);
    return;
  }
  if (command === "host-config-default") {
    // --clear switches the pointer off explicitly; omitting BOTH --name and
    // --clear is refused rather than read as a clear, because an accidental
    // omission must not silently un-default a host.
    const values = parseArguments(rest, [...shared, "host", "name", "clear", "actor"]);
    required(values, [...requiredShared, "host"]);
    const clearing = values.clear === "true";
    if (!clearing && (values.name === undefined || values.name === "")) {
      fail("CLI_ARGUMENT_MISSING", "name (or pass --clear true)");
    }
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => setHostDefaultInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at, host: values.host ?? "",
      configurationName: clearing ? null : values.name ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeExecutionConfigState(io, state);
    return;
  }
  if (command === "persona-binding-set") {
    const values = parseArguments(rest, [...shared, "profile-id", "host", "name", "actor"]);
    required(values, [...requiredShared, "profile-id", "host", "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => setPersonaBindingInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at, profileId: values["profile-id"] ?? "", host: values.host ?? "", configurationName: values.name ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeExecutionConfigState(io, state);
    return;
  }
  if (command === "persona-binding-remove") {
    const values = parseArguments(rest, [...shared, "profile-id", "host", "actor"]);
    required(values, [...requiredShared, "profile-id", "host"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => removePersonaBindingInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at, profileId: values["profile-id"] ?? "", host: values.host ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeExecutionConfigState(io, state);
    return;
  }
  if (command === "execution-config") {
    const values = parseArguments(rest, ["workspace", "host"]);
    required(values, ["workspace"]);
    const state = await materializeWorkspace(values.workspace ?? "");
    const config = state.executionConfig;
    const host = values.host;
    if (host !== undefined && host !== "") {
      io.write(canonicalJson({
        schemaVersion: "tcrn.execution-config-readback.v1",
        reasonCode: "EXECUTION_CONFIG_READY",
        workspaceId: state.metadata.workspaceId,
        configurations: config.configurations.filter((entry) => entry.host === host),
        defaults: config.defaults.filter((entry) => entry.host === host),
        bindings: config.bindings.filter((entry) => entry.host === host),
      }));
      return;
    }
    io.write(canonicalJson({
      schemaVersion: "tcrn.execution-config-readback.v1",
      reasonCode: "EXECUTION_CONFIG_READY",
      workspaceId: state.metadata.workspaceId,
      configurations: config.configurations,
      defaults: config.defaults,
      bindings: config.bindings,
    }));
    return;
  }
  if (command === "settings-set") {
    const values = parseArguments(rest, [...shared, "key", "value", "actor"]);
    required(values, [...requiredShared, "key", "value"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => setWorkspaceSetting(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at,
      key: values.key ?? "",
      value: values.value ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeSettingsState(io, state, values.key ?? "");
    return;
  }
  if (command === "snapshot-manifest") {
    // WSF-2: read-only snapshot witness. The lease is the quiesce proof — withLease
    // acquires it (fail-closed WORKSPACE_LOCKED on contention) and always releases
    // it; the manifest is emitted verbatim to stdout as the receipt.
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const manifest = await withLease(workspace, at, (lease) => createSnapshotManifest(workspace, lease));
    io.write(manifest);
    return;
  }
  if (command === "snapshot-verify") {
    // WSF-2: recompute a copied control tree against a saved manifest receipt. No
    // lease and no mutation — the target is a copy, not a live workspace.
    const values = parseArguments(rest, ["root", "manifest"]);
    required(values, ["root", "manifest"]);
    const manifest = await readSnapshotManifestFile(values.manifest ?? "");
    io.write(canonicalJson(await verifySnapshotManifest(values.root ?? "", manifest)));
    return;
  }
  if (command === "knowledge-init") {
    const values = parseArguments(rest, ["workspace", "acknowledge-disposable"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await initializeKnowledgeStore(values.workspace ?? "", {
      disposableAcknowledged: booleanValue(values["acknowledge-disposable"], "acknowledge-disposable"),
    })));
    return;
  }
  if (command === "knowledge-validate") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await validateKnowledgeStore(values.workspace ?? "")));
    return;
  }
  if (command === "knowledge-rebase") {
    const values = parseArguments(rest, ["workspace", "expected-version", "at", "retire-invalid"]);
    required(values, ["workspace", "expected-version", "at"]);
    io.write(canonicalJson(await rebaseKnowledgeStore(values.workspace ?? "", {
      expectedVersion: expectedVersion(values),
      at: values.at ?? "",
      retireInvalid: booleanValue(values["retire-invalid"], "retire-invalid"),
    })));
    return;
  }
  if (command === "knowledge-create") {
    const names = [
      "workspace", "expected-version", "at", "external-key", "scope", "project-id", "role-scopes", "category", "kind", "tags",
      "subject", "summary", "snippet", "accountable-owner-id", "source-references", "source-digest", "work-ids", "decision-ids", "gate-ids", "evidence-ids",
      "lifecycle", "retrieval", "freshness", "last-verified", "stale-days", "export", "body",
    ];
    const values = parseArguments(rest, names);
    required(values, names);
    // Pre-validate enum-valued flags against their literal unions so an invalid
    // value fails closed here naming the flag, rather than casting uncast into core.
    const enumFlags: readonly (readonly [string, readonly string[]])[] = [
      ["scope", ["workspace", "project", "role"]],
      ["category", ["architecture", "domain", "implementation", "standards", "testing", "workflow", "decision", "evidence"]],
      ["kind", ["fact", "guide", "decision", "reference", "summary"]],
      ["lifecycle", ["candidate", "active", "retired"]],
      ["retrieval", ["default", "explicit-only", "excluded"]],
      ["freshness", ["fresh", "stale", "unknown"]],
      ["export", ["metadata-only", "excluded"]],
    ];
    for (const [flag, admitted] of enumFlags) {
      const provided = values[flag];
      if (provided !== undefined && !admitted.includes(provided)) fail("CLI_ARGUMENT_MALFORMED", `${flag}=${provided}`);
    }
    io.write(canonicalJson(await createKnowledgeUnit(values.workspace ?? "", {
      expectedVersion: expectedVersion(values),
      occurredAt: values.at ?? "",
      externalKey: values["external-key"] ?? "",
      scope: values.scope as "workspace" | "project" | "role",
      projectId: nullableValue(values["project-id"]),
      roleScopes: listValue(values["role-scopes"]),
      category: values.category as KnowledgeCategory,
      kind: values.kind as KnowledgeKind,
      tags: listValue(values.tags),
      subject: values.subject ?? "",
      summary: values.summary ?? "",
      snippet: values.snippet ?? "",
      accountableOwnerId: values["accountable-owner-id"] ?? "",
      sourceReferences: listValue(values["source-references"]),
      sourceDigest: values["source-digest"] ?? "",
      linkedWorkIds: listValue(values["work-ids"]),
      linkedDecisionIds: listValue(values["decision-ids"]),
      linkedGateIds: listValue(values["gate-ids"]),
      linkedEvidenceIds: listValue(values["evidence-ids"]),
      lifecycle: values.lifecycle as "candidate" | "active" | "retired",
      retrievalDisposition: values.retrieval as "default" | "explicit-only" | "excluded",
      freshnessState: values.freshness as KnowledgeFreshnessState,
      lastVerified: nullableValue(values["last-verified"]),
      stalenessPolicy: { maximumAgeDays: integerValue(values, "stale-days"), unknownDisposition: "fail-closed" },
      exportDisposition: values.export as "metadata-only" | "excluded",
      body: values.body ?? "",
    })));
    return;
  }
  if (command === "knowledge-list") {
    const values = parseArguments(rest, ["workspace", "at", "selection", "project-id", "role-scope", "category", "kind", "tag", "freshness", "promotion", "search", "limit", "offset"]);
    required(values, ["workspace", "at"]);
    io.write(canonicalJson(await listKnowledgeMetadata(values.workspace ?? "", {
      at: values.at ?? "",
      ...(values.selection ? { selection: values.selection as "default" | "all" } : {}),
      ...(values["project-id"] ? { projectId: values["project-id"] } : {}),
      ...(values["role-scope"] ? { roleScope: values["role-scope"] } : {}),
      ...(values.category ? { category: values.category as KnowledgeCategory } : {}),
      ...(values.kind ? { kind: values.kind as KnowledgeKind } : {}),
      ...(values.tag ? { tag: values.tag } : {}),
      ...(values.freshness ? { freshness: values.freshness as KnowledgeFreshnessState } : {}),
      ...(values.promotion ? { promotionState: values.promotion as KnowledgePromotionState } : {}),
      ...(values.search ? { search: values.search } : {}),
      // WSB-2: integerValue is the single arbiter of INTEGER-ness here, exactly as it is
      // for target-version. Bare Number() sent NaN into core, which then reported a
      // typo as KNOWLEDGE_INPUT_INVALID "limit" -- a syntax error dressed as a range
      // judgement. The minimum stays unbounded on purpose: core holds the real window
      // rule (>= 1, <= maximumRecords, offset >= 0 at knowledge-core.ts:1262/:1270), and
      // a CLI-side floor would pre-empt half of it while silently keeping the ceiling.
      ...(values.limit !== undefined ? { limit: integerValue(values, "limit") } : {}),
      ...(values.offset !== undefined ? { offset: integerValue(values, "offset") } : {}),
    })));
    return;
  }
  if (command === "knowledge-candidates") {
    // WSC-7: emit the selected knowledge metadata already shaped as
    // tcrn.context-metadata-candidate.v1 records — the output candidates array is
    // consumable directly as a context-route request metadataCandidates entry.
    const values = parseArguments(rest, ["workspace", "at", "selection", "project-id", "role-scope", "category", "kind", "tag", "freshness", "promotion", "search", "limit", "offset"]);
    required(values, ["workspace", "at"]);
    io.write(canonicalJson(await knowledgeContextCandidates(values.workspace ?? "", {
      at: values.at ?? "",
      ...(values.selection ? { selection: values.selection as "default" | "all" } : {}),
      ...(values["project-id"] ? { projectId: values["project-id"] } : {}),
      ...(values["role-scope"] ? { roleScope: values["role-scope"] } : {}),
      ...(values.category ? { category: values.category as KnowledgeCategory } : {}),
      ...(values.kind ? { kind: values.kind as KnowledgeKind } : {}),
      ...(values.tag ? { tag: values.tag } : {}),
      ...(values.freshness ? { freshness: values.freshness as KnowledgeFreshnessState } : {}),
      ...(values.promotion ? { promotionState: values.promotion as KnowledgePromotionState } : {}),
      ...(values.search ? { search: values.search } : {}),
      // WSB-2: same arbiter, same reasoning as knowledge-list above.
      ...(values.limit !== undefined ? { limit: integerValue(values, "limit") } : {}),
      ...(values.offset !== undefined ? { offset: integerValue(values, "offset") } : {}),
    })));
    return;
  }
  if (command === "knowledge-snippet") {
    const values = parseArguments(rest, ["workspace", "id"]);
    required(values, ["workspace", "id"]);
    io.write(canonicalJson(await readKnowledgeSnippet(values.workspace ?? "", values.id ?? "")));
    return;
  }
  if (command === "knowledge-body") {
    const values = parseArguments(rest, ["workspace", "id", "at", "allow-unpromoted", "allow-stale"]);
    required(values, ["workspace", "id", "at"]);
    io.write(canonicalJson(await readKnowledgeBody(values.workspace ?? "", values.id ?? "", {
      at: values.at ?? "",
      allowUnpromoted: booleanValue(values["allow-unpromoted"], "allow-unpromoted"),
      allowStale: booleanValue(values["allow-stale"], "allow-stale"),
    })));
    return;
  }
  if (command === "knowledge-freshness") {
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    io.write(canonicalJson(await evaluateKnowledgeFreshness(values.workspace ?? "", values.at ?? "")));
    return;
  }
  if (command === "knowledge-promote") {
    const values = parseArguments(rest, ["workspace", "expected-version", "expected-revision", "at", "id", "state"]);
    required(values, ["workspace", "expected-version", "expected-revision", "at", "id", "state"]);
    io.write(canonicalJson(await transitionKnowledgePromotion(values.workspace ?? "", {
      expectedVersion: expectedVersion(values),
      expectedRevision: integerValue(values, "expected-revision"),
      occurredAt: values.at ?? "",
      id: values.id ?? "",
      promotionState: values.state as "promoted" | "rejected",
    })));
    return;
  }
  if (command === "knowledge-retire") {
    const values = parseArguments(rest, ["workspace", "expected-version", "expected-revision", "at", "id"]);
    required(values, ["workspace", "expected-version", "expected-revision", "at", "id"]);
    io.write(canonicalJson(await retireKnowledgeUnit(values.workspace ?? "", {
      expectedVersion: expectedVersion(values),
      expectedRevision: integerValue(values, "expected-revision"),
      occurredAt: values.at ?? "",
      id: values.id ?? "",
    })));
    return;
  }
  if (command === "knowledge-reverify") {
    const values = parseArguments(rest, ["workspace", "expected-version", "expected-revision", "at", "id"]);
    required(values, ["workspace", "expected-version", "expected-revision", "at", "id"]);
    io.write(canonicalJson(await reverifyKnowledgeUnit(values.workspace ?? "", {
      expectedVersion: expectedVersion(values),
      expectedRevision: integerValue(values, "expected-revision"),
      occurredAt: values.at ?? "",
      id: values.id ?? "",
    })));
    return;
  }
  if (command === "knowledge-checkpoint") {
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    io.write(await exportKnowledgeCheckpoint(values.workspace ?? "", values.at ?? ""));
    return;
  }
  if (command === "artifact-size") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await artifactSizeReport(values.workspace ?? "")));
    return;
  }
  if (command === "artifact-doctor") {
    const names = ["workspace", "warning-bytes", "critical-bytes", "warning-count", "critical-count"];
    const values = parseArguments(rest, names);
    required(values, ["workspace"]);
    const warningBytes = boundedInteger(values, "warning-bytes");
    const criticalBytes = boundedInteger(values, "critical-bytes");
    const warningCount = boundedInteger(values, "warning-count");
    const criticalCount = boundedInteger(values, "critical-count");
    io.write(canonicalJson(await artifactDoctor(values.workspace ?? "", {
      ...(warningBytes === undefined ? {} : { warningBytes }),
      ...(criticalBytes === undefined ? {} : { criticalBytes }),
      ...(warningCount === undefined ? {} : { warningCount }),
      ...(criticalCount === undefined ? {} : { criticalCount }),
    })));
    return;
  }
  if (command === "artifact-compact-dry-run") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await artifactCompactDryRun(values.workspace ?? "")));
    return;
  }
  if (command === "artifact-archive-dry-run") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await artifactArchiveDryRun(values.workspace ?? "")));
    return;
  }
  if (command === "artifact-archive-apply") {
    const values = parseArguments(rest, ["workspace", "expected-plan-digest"]);
    required(values, ["workspace", "expected-plan-digest"]);
    io.write(canonicalJson(await applyArtifactArchive(values.workspace ?? "", {
      expectedPlanDigest: values["expected-plan-digest"] ?? "",
    })));
    return;
  }
  if (command === "artifact-archive-restore") {
    const values = parseArguments(rest, ["workspace", "archive-id", "expected-plan-digest"]);
    required(values, ["workspace", "archive-id", "expected-plan-digest"]);
    io.write(canonicalJson(await restoreArtifactArchive(
      values.workspace ?? "",
      values["archive-id"] ?? "",
      { expectedPlanDigest: values["expected-plan-digest"] ?? "" },
    )));
    return;
  }
  // WSE-3: attestation-enable appends the one-way attestation.actor.enabled chain
  // event (WSE-2 enableActorAttestation) under a held lease; from that sequence on
  // the engine makes a valid --actor mandatory. --actor itself is catalog-OPTIONAL
  // on every mutation verb (added to each parseArguments allowed list, never to
  // required()): pre-enable it is optional and post-enable the ENGINE enforces it
  // (WORKSPACE_ACTOR_REQUIRED/_INVALID) — the CLI never duplicates that vocabulary,
  // keeping legacy no-actor invocations on non-enabled workspaces byte-identical.
  if (command === "attestation-enable") {
    const values = parseArguments(rest, [...shared, "actor"]);
    required(values, [...requiredShared, "actor"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => enableActorAttestation(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace), occurredAt: at, actorId: values.actor ?? "",
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeState(io, state);
    return;
  }
  if (command === "project-create") {
    const values = parseArguments(rest, [...shared, "external-key", "name", "actor"]);
    required(values, [...requiredShared, "external-key", "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => createProject(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace), occurredAt: at, externalKey: values["external-key"] ?? "", name: values.name ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    const id = deriveStableId("project", canonicalExternalKey(values["external-key"] ?? ""));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeState(io, state, projectSummary(state.projects.find((entry) => entry.id === id)!));
    return;
  }
  if (command === "project-update") {
    const values = parseArguments(rest, [...shared, "id", "name", "actor"]);
    required(values, [...requiredShared, "id", "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => updateProject(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace), occurredAt: at, id: values.id ?? "", name: values.name ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeState(io, state, projectSummary(state.projects.find((entry) => entry.id === (values.id ?? ""))!));
    return;
  }
  if (command === "project-delete") {
    const values = parseArguments(rest, [...shared, "id", "actor"]);
    required(values, [...requiredShared, "id"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => deleteProject(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace), occurredAt: at, id: values.id ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeState(io, state, projectSummary(state.projects.find((entry) => entry.id === (values.id ?? ""))!));
    return;
  }
  if (command === "work-create") {
    const values = parseArguments(rest, [...shared, "project-id", "external-key", "kind", "parent-id", "status", "scope", "decided-by", "template-receipt", "actor"]);
    required(values, [...requiredShared, "project-id", "external-key", "kind"]);
    // Fail closed at the CLI boundary naming the offending flag/value, before the
    // uncast enum reaches core and surfaces as an opaque RECORD_MALFORMED on the id.
    if (values.kind !== undefined && !["Initiative", "Epic", "Story", "Subtask", "Incident", "Release"].includes(values.kind)) fail("CLI_ARGUMENT_MALFORMED", `kind=${values.kind}`);
    if (values.status !== undefined && !isWorkStatus(values.status)) fail("CLI_ARGUMENT_MALFORMED", `status=${values.status}`);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => createWork(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at,
      projectId: values["project-id"] ?? "",
      externalKey: values["external-key"] ?? "",
      kind: values.kind as PlannedDeliveryKind,
      parentId: nullableValue(values["parent-id"]),
      ...(values.status ? { status: values.status as WorkStatus } : {}),
      ...(values.scope !== undefined ? { scope: values.scope } : {}),
      ...(values["decided-by"] !== undefined ? { decidedBy: listValue(values["decided-by"]) } : {}),
      ...(values["template-receipt"] !== undefined ? { templateAdmission: jsonValue(values["template-receipt"], "template-receipt") } : {}),
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    const id = deriveStableId("work", canonicalExternalKey(values["external-key"] ?? ""));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeState(io, state, workSummary(state.work.find((entry) => entry.id === id)!));
    return;
  }
  if (command === "work-transition") {
    const values = parseArguments(rest, [...shared, "id", "status", "actor"]);
    required(values, [...requiredShared, "id", "status"]);
    if (values.status !== undefined && !isWorkStatus(values.status)) fail("CLI_ARGUMENT_MALFORMED", `status=${values.status}`);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => transitionWork(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace), occurredAt: at, id: values.id ?? "", status: values.status as WorkStatus,
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeState(io, state, workSummary(state.work.find((entry) => entry.id === (values.id ?? ""))!));
    return;
  }
  if (command === "work-annotate") {
    // E05 + INIT-008: attach non-binding advisory fields to a work record. At least one of
    // --scope, --decided-by, or --sprint must be present; the core rejects an empty or no-op annotation.
    const values = parseArguments(rest, [...shared, "id", "scope", "decided-by", "sprint", "actor"]);
    required(values, [...requiredShared, "id"]);
    if (values.scope === undefined && values["decided-by"] === undefined && values.sprint === undefined) fail("CLI_ARGUMENT_MALFORMED", "scope-or-decided-by-or-sprint");
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => annotateWork(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace), occurredAt: at, id: values.id ?? "",
      ...(values.scope !== undefined ? { scope: values.scope } : {}),
      ...(values["decided-by"] !== undefined ? { decidedBy: listValue(values["decided-by"]) } : {}),
      ...(values.sprint !== undefined ? { sprint: sprintReference(values.sprint) } : {}),
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeState(io, state, workSummary(state.work.find((entry) => entry.id === (values.id ?? ""))!));
    return;
  }
  if (command === "work-delete") {
    const values = parseArguments(rest, [...shared, "id", "actor"]);
    required(values, [...requiredShared, "id"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => deleteWork(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace), occurredAt: at, id: values.id ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeState(io, state, workSummary(state.work.find((entry) => entry.id === (values.id ?? ""))!));
    return;
  }
  if (command === "project-list") {
    const values = parseArguments(rest, ["workspace", "limit", "offset"]);
    required(values, ["workspace"]);
    const state = await validateWorkspace(values.workspace ?? "");
    const records = state.projects.filter((entry) => !entry.tombstone).map(projectSummary);
    io.write(canonicalJson(paginate(state, "project", records, values)));
    return;
  }
  if (command === "work-list") {
    const values = parseArguments(rest, ["workspace", "project-id", "kind", "status", "parent-id", "sprint", "limit", "offset"]);
    required(values, ["workspace"]);
    if (values.kind !== undefined && !["Initiative", "Epic", "Story", "Subtask", "Incident", "Release"].includes(values.kind)) fail("CLI_ARGUMENT_MALFORMED", `kind=${values.kind}`);
    if (values.status !== undefined && !isWorkStatus(values.status)) fail("CLI_ARGUMENT_MALFORMED", `status=${values.status}`);
    // INIT-008: filter members of a sprint. The flag carries the qualified reference in the
    // same workspace:<id>#work:<id> spelling used to annotate; we compare the parsed object
    // against the stored advisory:sprint value by canonical bytes so the round trip is closed.
    const sprintFilter = values.sprint === undefined ? undefined : canonicalJson(sprintReference(values.sprint));
    const state = await validateWorkspace(values.workspace ?? "");
    const records = state.work.filter((entry) => !entry.tombstone &&
      (values["project-id"] === undefined || entry.projectId === values["project-id"]) &&
      (values.kind === undefined || entry.kind === values.kind) &&
      (values.status === undefined || entry.status === values.status) &&
      (sprintFilter === undefined || canonicalJson((entry.extensions["advisory:sprint"] as { readonly value: unknown } | undefined)?.value ?? null) === sprintFilter) &&
      // CQ-05(c2): the null sentinel must be spelled the same on the way in and on the way
      // out. work-create routes --parent-id through nullableValue, which accepts BOTH "-"
      // and the deprecated alias "null"; this filter used a bare === "-" and so treated
      // "null" as a literal parent id. An agent could therefore create a root work item
      // with --parent-id null and then never find it with the identical spelling — a
      // silent wrong answer (total=0), not a cosmetic inconsistency. Sharing nullableValue
      // makes the round trip closed for every spelling the writer accepts, by construction.
      (values["parent-id"] === undefined || (nullableValue(values["parent-id"]) === null ? entry.parentId === null : entry.parentId === values["parent-id"])))
      .map(workSummary);
    io.write(canonicalJson(paginate(state, "work", records, values)));
    return;
  }
  if (command === "work-show") {
    const values = parseArguments(rest, ["workspace", "id"]);
    required(values, ["workspace", "id"]);
    const state = await validateWorkspace(values.workspace ?? "");
    const record = state.work.find((entry) => entry.id === values.id && !entry.tombstone);
    if (!record) fail("WORKSPACE_INPUT_INVALID", `work ${values.id ?? ""} is unavailable`);
    const advisory = workAdvisory(record);
    io.write(canonicalJson({
      reasonCode: "WORKSPACE_RECORD_READY",
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      kind: "work",
      record: workSummary(record),
      ...(advisory !== null ? { advisory } : {}),
    }));
    return;
  }
  // INC-027 (TCRN-CROSS-INC-027): the event chain itself, read in windows.
  //
  // `export` was the only read that returned events at all, and it refuses any
  // workspace whose canonical form exceeds one MiB — which three of the four
  // chains on this platform already do (1,825,251 / 1,160,601 / 1,134,120
  // canonical event bytes when this was filed). So the one thing a mirror needs in
  // order to reproduce a chain was unreachable precisely on the chains large
  // enough to be worth mirroring. Records come back verbatim, in chain order, so
  // the concatenation of every page is exactly the array `export` would have
  // emitted and feeds validateEventChain unmodified.
  if (command === "event-list") {
    const values = parseArguments(rest, ["workspace", "limit", "offset"]);
    required(values, ["workspace"]);
    const state = await validateWorkspace(values.workspace ?? "");
    io.write(eventPage(state, values));
    return;
  }
  // WSD-2: governed conference/gate verbs. Every mutating verb wraps its WSD-1
  // engine call in withLease and, per SDC-1/SDC-2, appends a workspace event through
  // the shared payload builder; expected-version carries the headSentinel and
  // resolves under the held lease exactly as the project/work verbs do. Enum-valued
  // flags (type/outcome-class/status) are passed through uncast so the engine's
  // schema validators fail closed with their verbatim reason code (e.g.
  // CONFERENCE_SCHEMA_INVALID / GATE_SCHEMA_INVALID). The two list verbs take no
  // lease and read the materialized head, emitting the utf8-byte-ordered record array.
  if (command === "conference-open") {
    const values = parseArguments(rest, [...shared, "external-key", "project-id", "type", "title", "work-ids", "desired-outcome", "participant-ids", "actor"]);
    required(values, [...requiredShared, "external-key", "project-id", "type", "title", "work-ids", "desired-outcome", "participant-ids"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => openConferenceInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at,
      externalKey: values["external-key"] ?? "",
      projectId: values["project-id"] ?? "",
      type: values.type as ConferenceRequest["type"],
      title: values.title ?? "",
      linkedWorkIds: listValue(values["work-ids"]),
      desiredOutcome: values["desired-outcome"] ?? "",
      participantIds: listValue(values["participant-ids"]),
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeExtensionState(io, state, deriveStableId("conference", canonicalExternalKey(values["external-key"] ?? "")));
    return;
  }
  if (command === "conference-append-position") {
    // WSE-3: --actor-id is the position author (a conference-position record field);
    // --actor is the attestation acting identity. These are now separate core fields.
    // They previously shared one actorId slot, so --actor overwrote the author of the
    // record -- a required flag's value discarded in silence. The default path (no
    // --actor) still lets the author stand in as the attestation actor, which keeps
    // existing invocations byte-identical.
    const values = parseArguments(rest, [...shared, "conference-id", "external-key", "actor-id", "position", "risks", "recommendations", "evidence-ids", "actor"]);
    required(values, [...requiredShared, "conference-id", "external-key", "actor-id", "position", "risks", "recommendations", "evidence-ids"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => appendConferencePositionInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at,
      conferenceId: values["conference-id"] ?? "",
      externalKey: values["external-key"] ?? "",
      authorActorId: values["actor-id"] ?? "",
      position: values.position ?? "",
      risks: listValue(values.risks),
      recommendations: listValue(values.recommendations),
      evidenceIds: listValue(values["evidence-ids"]),
      actorId: values.actor ?? values["actor-id"] ?? "",
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeExtensionState(io, state, deriveStableId("position", canonicalExternalKey(values["external-key"] ?? "")));
    return;
  }
  if (command === "conference-close") {
    // WSD-3 (Stage 5) adds the four knowledge-wiring flags to WSD-2's core surface,
    // preserving --actor and every core flag. --distill is opt-in: absent/false is
    // byte-identical to the WSD-2 close (no knowledge access), so a close on a
    // workspace without an initialized knowledge store is never bricked. When set,
    // the close event is appended FIRST, then the governed high-water rebind
    // (rebaseKnowledgeStore) re-binds the disposable knowledge store to the advanced
    // headEventHash — without it every subsequent knowledge call would fail
    // KNOWLEDGE_HIGH_WATER_MISMATCH — then each minutes decision is captured as a
    // knowledge candidate. Provenance stays optional at capture (WSC-3 capture-cheap);
    // the whole flow runs under the held workspace lease so no concurrent append can
    // desync the rebind before capture.
    const values = parseArguments(rest, [...shared, "conference-id", "minutes-external-key", "summary", "outcome-class", "decisions", "unresolved-issues", "execution-form", "actor", "distill", "accountable-owner-id", "stale-days", "evidence-ids"]);
    required(values, [...requiredShared, "conference-id", "minutes-external-key", "summary", "outcome-class", "decisions", "unresolved-issues"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const conferenceId = values["conference-id"] ?? "";
    const minutesId = deriveStableId("minutes", canonicalExternalKey(values["minutes-external-key"] ?? ""));
    const distill = booleanValue(values.distill, "distill");
    const outcome = await withLease(workspace, at, async (lease) => {
      // Read the knowledge marker version BEFORE the close, while the store's
      // high-water still equals the workspace head — a missing/invalid store then
      // fails closed BEFORE the close event is appended (version unchanged). The
      // marker version is untouched by the close (which only appends a workspace
      // event), so it is the exact CAS basis for the post-close rebind.
      let knowledgeVersion = 0;
      if (distill) knowledgeVersion = Number((await validateKnowledgeStore(workspace)).version);
      const state = await closeConferenceInWorkspace(workspace, lease, {
        expectedVersion: await resolveExpectedVersion(values, workspace),
        occurredAt: at,
        conferenceId,
        minutesExternalKey: values["minutes-external-key"] ?? "",
        summary: values.summary ?? "",
        outcomeClass: values["outcome-class"] as ConferenceMinutes["outcomeClass"],
        decisions: listValue(values.decisions),
        unresolvedIssues: listValue(values["unresolved-issues"]),
        executionForm: values["execution-form"],
        ...(values.actor ? { actorId: values.actor } : {}),
      });
      if (!distill) return { state, knowledgeUnitIds: undefined };
      const rebased = await rebaseKnowledgeStore(workspace, { expectedVersion: knowledgeVersion, at });
      const candidates = distillConferenceKnowledge(
        state.conferenceMinutes.find((entry) => entry.id === minutesId),
        state.conferences.find((entry) => entry.id === conferenceId),
        state.conferencePositions.filter((entry) => entry.conferenceId === conferenceId),
        {
          occurredAt: at,
          expectedVersionBase: Number(rebased.version),
          stalenessDays: boundedInteger(values, "stale-days") ?? 365,
          ...(values["accountable-owner-id"] ? { accountableOwnerId: values["accountable-owner-id"] } : {}),
          evidenceIds: listValue(values["evidence-ids"]),
        },
      );
      const knowledgeUnitIds: string[] = [];
      for (const candidate of candidates) {
        knowledgeUnitIds.push(String((await createKnowledgeUnit(workspace, candidate)).id));
      }
      return { state, knowledgeUnitIds };
    });
    await emitTimeAttestation(io, values, outcome.state.headEventHash);
    if (outcome.knowledgeUnitIds === undefined) {
      writeExtensionState(io, outcome.state, minutesId);
      return;
    }
    io.write(canonicalJson({
      reasonCode: "WORKSPACE_COMMAND_COMPLETED",
      workspaceId: outcome.state.metadata.workspaceId,
      version: outcome.state.version,
      headEventHash: outcome.state.headEventHash,
      recordId: minutesId,
      knowledgeUnitIds: outcome.knowledgeUnitIds,
    }));
    return;
  }
  if (command === "conference-cancel") {
    const values = parseArguments(rest, [...shared, "conference-id", "actor"]);
    required(values, [...requiredShared, "conference-id"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => cancelConferenceInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at,
      conferenceId: values["conference-id"] ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeExtensionState(io, state, values["conference-id"] ?? "");
    return;
  }
  // INIT-014 (TCRN-AOS-INC-005): workspace-scoped reads for the deliberation
  // record families.
  //
  // Before these, positions and minutes could be reached only through `export`,
  // which is all-or-nothing and refuses an oversized workspace outright. The
  // consequence was not slow reading but absent reading: a consumer over a large
  // chain could list its conferences and never see a single position, so a
  // deliberation with fifteen arguments in it and one with none rendered
  // identically. Both verbs page like every other list, so a large chain is read
  // in windows rather than refused whole.
  if (command === "conference-position-list") {
    const values = parseArguments(rest, ["workspace", "conference-id", "limit", "offset"]);
    required(values, ["workspace"]);
    const state = await validateWorkspace(values.workspace ?? "");
    const records = state.conferencePositions.filter((entry) => !entry.tombstone &&
      (values["conference-id"] === undefined || entry.conferenceId === values["conference-id"]));
    io.write(canonicalJson(paginate(state, "conference-position", records, values)));
    return;
  }
  if (command === "conference-minutes-list") {
    const values = parseArguments(rest, ["workspace", "conference-id", "limit", "offset"]);
    required(values, ["workspace"]);
    const state = await validateWorkspace(values.workspace ?? "");
    const records = state.conferenceMinutes.filter((entry) => !entry.tombstone &&
      (values["conference-id"] === undefined || entry.conferenceId === values["conference-id"]));
    io.write(canonicalJson(paginate(state, "conference-minutes", records, values)));
    return;
  }
  if (command === "conference-list-by-work") {
    const values = parseArguments(rest, ["workspace", "work-id"]);
    required(values, ["workspace", "work-id"]);
    const state = await materializeWorkspace(values.workspace ?? "");
    io.write(canonicalJson(listConferencesByWorkItem(values["work-id"] ?? "", state.conferences)));
    return;
  }
  if (command === "gate-create") {
    const values = parseArguments(rest, [...shared, "external-key", "project-id", "work-id", "title", "outcome-class", "actor"]);
    required(values, [...requiredShared, "external-key", "project-id", "work-id", "title", "outcome-class"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => createGateInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at,
      externalKey: values["external-key"] ?? "",
      projectId: values["project-id"] ?? "",
      workId: nullableValue(values["work-id"]),
      title: values.title ?? "",
      outcomeClass: values["outcome-class"] as GateRecord["outcomeClass"],
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeExtensionState(io, state, deriveStableId("gate", canonicalExternalKey(values["external-key"] ?? "")));
    return;
  }
  if (command === "gate-transition") {
    // WSD-4: --minutes-locator is required by the engine only when --status is
    // satisfied (a conference-minutes:<suffix> id resolving to anchoring minutes);
    // it is an optional flag here and the engine fails closed on absence/mismatch.
    const values = parseArguments(rest, [...shared, "id", "status", "minutes-locator", "actor", "identity-authority", "identity-authority-digest"]);
    required(values, [...requiredShared, "id", "status"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    // gate-v1: the roster is a pins-track authority like every other, so the caller
    // states the digest it already holds and the reader checks it against the bytes.
    // Read before the lease is taken -- a filesystem refusal should not have held a
    // workspace lock while it happened.
    const identityIdentity = suppliedAuthority<GateIdentityAuthorityFileIdentity>(
      undefined, values["identity-authority"], values["identity-authority-digest"],
    );
    if (values["identity-authority"] !== undefined && identityIdentity === undefined) {
      fail("CLI_ARGUMENT_MISSING", "identity-authority-digest");
    }
    const identityAuthority = identityIdentity === undefined
      ? undefined
      : await readGateIdentityAuthority(values["identity-authority"] ?? "", identityIdentity);
    const state = await withLease(workspace, at, async (lease) => transitionGateInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at,
      id: values.id ?? "",
      status: values.status as GateRecord["status"],
      // The flag is optional; the engine reads minutesLocator as `!== undefined`, so
      // omitting the key when unset is byte-equivalent to passing undefined.
      ...(values["minutes-locator"] === undefined ? {} : { minutesLocator: values["minutes-locator"] }),
      ...(identityAuthority === undefined ? {} : { identityAuthority }),
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeExtensionState(io, state, values.id ?? "");
    return;
  }
  if (command === "gate-delete") {
    // GAP-10: the documented deadlock escape — the only route to tombstone a pending
    // gate whose conference was cancelled, so a work item wedged by WSD-4 enforcement
    // can reach done. Deletion is a revision-advancing tombstone, never a hard delete.
    const values = parseArguments(rest, [...shared, "id", "actor"]);
    required(values, [...requiredShared, "id"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => deleteGateInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at,
      id: values.id ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeExtensionState(io, state, values.id ?? "");
    return;
  }
  if (command === "gate-list") {
    const values = parseArguments(rest, ["workspace", "work-id"]);
    required(values, ["workspace", "work-id"]);
    const state = await materializeWorkspace(values.workspace ?? "");
    // INC-086: a nonexistent work-id must be distinguishable from "no gates". An
    // empty [] answers "this work item has no gates"; a work item that does not
    // exist refuses named instead of being read as "no gates".
    const workId = values["work-id"] ?? "";
    if (!state.work.some((record) => record.id === workId)) {
      fail("WORKSPACE_WORK_NOT_FOUND", `work ${workId} does not exist in this workspace`);
    }
    io.write(canonicalJson(listGatesByWorkItem(workId, state.gates)));
    return;
  }
  fail("CLI_COMMAND_UNKNOWN", command);
}

/**
 * Shipped operator entry point.
 *
 * Global authority flags precede the command:
 *
 *   --authority-pins /absolute/pins.json
 *   --authority-pins-digest <sha256>
 *   <command> ...
 *
 * Both are mandatory together. The digest is the only trust anchor accepted by
 * this function; no environment lookup, prompt field, workspace discovery or
 * default file is consulted. Directly injected programmatic authority remains a
 * separate API and is rejected as ambiguous when pins are also present.
 */
export async function runOperatorCli(
  arguments_: readonly string[],
  io: CliIo,
): Promise<void> {
  if (arguments_[0] !== "--authority-pins" &&
    !arguments_[0]?.startsWith("--authority-pins=") &&
    arguments_[0] !== "--authority-pins-digest" &&
    !arguments_[0]?.startsWith("--authority-pins-digest=")) {
    await runCli(arguments_, io);
    return;
  }

  const global: Record<string, string> = {};
  let index = 0;
  while (index < arguments_.length) {
    const token = arguments_[index];
    if (token === undefined || !token.startsWith("--")) break;
    let name: string;
    let value: string;
    if (token.includes("=")) {
      const equalsAt = token.indexOf("=");
      name = token.slice(2, equalsAt);
      value = token.slice(equalsAt + 1);
      index += 1;
    } else {
      const next = arguments_[index + 1];
      if (next === undefined || next.startsWith("--")) {
        fail("CLI_ARGUMENT_MALFORMED", token);
      }
      name = token.slice(2);
      value = next;
      index += 2;
    }
    if (name !== "authority-pins" && name !== "authority-pins-digest") {
      fail("CLI_ARGUMENT_UNKNOWN", name);
    }
    if (Object.hasOwn(global, name)) {
      fail("CLI_ARGUMENT_DUPLICATE", name);
    }
    global[name] = value;
  }
  const missing = ["authority-pins", "authority-pins-digest"].filter(
    (name) => !global[name],
  );
  if (missing.length > 0) {
    fail("CLI_ARGUMENT_MISSING", missing.join(","));
  }
  if (AUTHORITY_IO_FIELDS.some((field) => io[field] !== undefined)) {
    fail(
      "CLI_AUTHORITY_AMBIGUOUS",
      "authority supplied by both host and operator pins",
    );
  }
  if (!io.clock) {
    fail("CLI_ARGUMENT_MISSING", "clock");
  }
  // INC-017: read the clock ONCE. The same instant has to bound the bundle window and
  // the pinned observation's observedAt; two reads are two different instants, and a
  // receipt could be minted against a moment the bundle was never checked at.
  const verificationTime = io.clock();
  const context = await readOperatorAuthority(
    global["authority-pins"] as string,
    {
      expectedCanonicalPath: global["authority-pins"] as string,
      expectedFileSha256: global["authority-pins-digest"] as string,
    },
    verificationTime,
  );
  await runCli(arguments_.slice(index), {
    ...io,
    ...(context.profileAdmissionAuthority === undefined
      ? {}
      : { profileAdmissionAuthority: context.profileAdmissionAuthority }),
    ...(context.contextRouteAuthority === undefined
      ? {}
      : { contextRouteAuthority: context.contextRouteAuthority }),
    ...(context.codexAdapterHost === undefined
      ? {}
      : { codexAdapterHost: context.codexAdapterHost }),
    ...(context.codexAdapterActivationHost === undefined
      ? {}
      : {
        codexAdapterActivationHost:
          context.codexAdapterActivationHost,
      }),
    ...(context.codexAdapterInstallationAuthority === undefined
      ? {}
      : {
        codexAdapterInstallationAuthority:
          context.codexAdapterInstallationAuthority,
      }),
    ...(context.codexHostActivationObservationAuthority === undefined
      ? {}
      : {
        codexHostActivationObservationAuthority:
          context.codexHostActivationObservationAuthority,
      }),
    // INC-017: notBefore/notAfter are the operator's OWN declared bundle window,
    // already verified above to contain verificationTime. The operator, not a constant
    // in this file, therefore decides how long one captured observation may be
    // presented; rotating the bundle past a fire retires it unless a fresh observation
    // is captured.
    codexHostActivationObservationFreshness: {
      notBefore: context.bundle.issuedAt,
      notAfter: context.bundle.expiresAt,
      verifiedAt: verificationTime,
    },
    ...(context.claudeAdapterHost === undefined
      ? {}
      : { claudeAdapterHost: context.claudeAdapterHost }),
    ...(context.claudeAdapterActivationHost === undefined
      ? {}
      : {
        claudeAdapterActivationHost:
          context.claudeAdapterActivationHost,
      }),
    ...(context.claudeAdapterInstallationAuthority === undefined
      ? {}
      : {
        claudeAdapterInstallationAuthority:
          context.claudeAdapterInstallationAuthority,
      }),
    ...(context.compatibilityAdmissionAuthority === undefined
      ? {}
      : {
        compatibilityAdmissionAuthority:
          context.compatibilityAdmissionAuthority,
      }),
  });
}
