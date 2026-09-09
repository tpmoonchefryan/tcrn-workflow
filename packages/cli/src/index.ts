// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";

import {
  acquireWorkspaceLease,
  applyMachineSettingRemove,
  applyMachineSettingSet,
  deleteLegacyAttestations,
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
  createKnowledgeArticle,
  transitionGateInWorkspace,
  readGateIdentityAuthority,
  deleteGateInWorkspace,
  listGatesByWorkItem,
  createKnowledgeUnit,
  checkKnowledgeSources,
  createProject,
  applyKnowledgeBatch,
  applyWorkBatch,
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
  captureKnowledgeUnit,
  knowledgeContextCandidates,
  listKnowledgeMetadata,
  consumeViewWriteFailure,
  materializeWorkspace,
  migrateAttestationDirectory,
  migrateKnowledgeBodies,
  workBatchReceipt,
  workspaceBudgets,
  planWorkspaceMigration,
  migrateWorkspaceStorage,
  readGenericProfileAdmissionReceipt,
  readContextRouteAuthorityReceipt,
  readKnowledgeBody,
  readKnowledgeStoreMarker,
  readKnowledgeSnippet,
  rebaseKnowledgeStore,
  retireKnowledgeUnit,
  refreshKnowledgeArticle,
  reverifyKnowledgeUnit,
  recoverWorkspace,
  createSnapshotManifest,
  readSnapshotManifestFile,
  rebuildReplaySnapshot,
  verifySnapshotManifest,
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
  reportAttestationDirectory,
  writeAttestationReceipt,
  readOperatorAuthority,
  assertGeneratedArtifactsRoot,
  validateSettingValue,
  listArtifacts,
  putArtifact,
  verifyArtifacts,
  readStorageHomeDeclaration,
  readSettingsCatalog,
  readInstallManifest,
  readMachineSettingsCatalog,
  readVocabulary,
  STORY_SCOPE_HEADINGS,
  machineSettingsPath,
  FRAMEWORK_VERSION,
  assertModelPlanHost,
  allPersonaReadback,
  SETTINGS_CATALOG,
  assignModelPlanInWorkspace,
  removeModelPlanInWorkspace,
  removePersonaInWorkspace,
  overridePersonaPresetInWorkspace,
  restorePersonaPresetInWorkspace,
  setModelPlanInWorkspace,
  unassignModelPlanInWorkspace,
  removeWorkspaceSetting,
  setCustomPersonaInWorkspace,
  setWorkspaceSetting,
  admitTemplateInWorkspace,
  readTemplateDocumentFile,
  RECALL_CANDIDATE_LIMIT,
  expansionsText,
  KNOWLEDGE_LANGUAGE_BUNDLE_FALLBACK_KEY,
  languageProviderFromBundle,
  parseLanguageBundle,
  RECALL_DEFAULT_TAU,
  recall,
  readKnowledgeLanguagePolicy,
  recallDocuments,
  resolveQueryLanguage,
  templateBindingFromWorkRecord,
  validateTemplateDocument,
} from "../../core/src/index.js";
import type { KnowledgeLanguageBundle, KnowledgeLanguageProvider } from "../../core/src/index.js";
import type {
  ConferenceRequest,
  ConferenceMinutes,
  GateRecord,
  GateIdentityAuthorityFileIdentity,
  ExplicitRoot,
  ContextRouteAuthorityFileIdentity,
  GenericProfileAdmissionAuthority,
  KnowledgeCategory,
  KnowledgeFreshnessState,
  KnowledgeKind,
  KnowledgePromotionState,
  RecallKnowledgeInput,
  RecallMinutesInput,
  RecallWorkInput,
} from "../../core/src/index.js";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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
}

const AUTHORITY_IO_FIELDS = Object.freeze([
  "profileAdmissionAuthority",
  "contextRouteAuthority",
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

/**
 * Outcome classes this write path will no longer mint (TCRN-CROSS-MIN-102 裁定三).
 *
 * The five-class vocabulary stays in the schema and in replay, so every record ever
 * written still validates and every chain still reads. What changes is what a new
 * record may be born as. On a gate, three of the five were pure labels — only
 * `owner_intent_required` reaches any engine behaviour, and across this platform's
 * 35 gates none was ever created with the other three. On a conference,
 * `discussion_only` is kept: minutes are the record of a deliberation, and a
 * deliberation that reached no ruling has to have a truthful class to close under.
 * `blocked` is retired on both — it names a state, not an outcome, and it has never
 * been used on either surface.
 */
const RETIRED_OUTCOME_CLASSES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "gate-create": Object.freeze(["blocked", "discussion_only", "recommendation"]),
  "conference-close": Object.freeze(["blocked"]),
});

function assertMintableOutcomeClass(verb: keyof typeof RETIRED_OUTCOME_CLASSES, value: string | undefined): void {
  if (value !== undefined && RETIRED_OUTCOME_CLASSES[verb]?.includes(value)) {
    fail("CLI_ARGUMENT_MALFORMED", `outcome-class=${value}`);
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
// WSB-7: opt-in lease-scoped expected-version derivation. The literal "head"
// resolves, under the already-held workspace lease, to the current materialized
// version. Lease acquisition plus the mutation claim serialize writers, so this
// single in-lease read cannot race the append that follows it — derivation is
// exact and needs no retry loop. Which verbs accept it is declared by the catalog
// (`headSentinel` on their expected-version flag) and asserted behaviourally by
// tests/s300-catalog-behaviour.test.mjs; this comment used to name a count, and the
// count was wrong. Knowledge-marker mutations keep numeric-only
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

function nullableIntegerValue(values: Readonly<Record<string, string>>, name: string): number | null {
  const raw = values[name];
  if (raw === "-" || raw === "null") return null;
  return integerValue(values, name);
}

function booleanValue(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  fail("CLI_ARGUMENT_MALFORMED", name);
}


// TCRN-CROSS-STORY-364 requirement 3: the four card write paths -- knowledge-capture,
// knowledge-create, conference-close --distill and knowledge-batch's create members --
// all reach buildMetadata, which refuses fail-closed on a language-configured workspace
// unless it is handed the economy-tier model's answers. The CLI is where those answers
// enter: --language-bundle names a file the Agent wrote after asking the model recorded
// in model.economyTier. The CLI reads a file and hands over data; it calls no model, and
// the offline leg of verify:p1 still measures that nothing here can.
function readLanguageBundle(path: string): KnowledgeLanguageBundle {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE", `${path}: ${(error as { message?: string }).message ?? "unreadable"}`);
  }
  try {
    return parseLanguageBundle(document);
  } catch (error) {
    fail(String((error as { reasonCode?: unknown }).reasonCode ?? "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE"), String((error as { message?: string }).message ?? path));
  }
}

/** The provider for one card, or none when the caller named no bundle. */
function languageProviderFor(path: string | undefined, cardKey?: string): KnowledgeLanguageProvider | undefined {
  if (path === undefined || path.length === 0) return undefined;
  const bundle = readLanguageBundle(path);
  return cardKey === undefined || cardKey.length === 0
    ? languageProviderFromBundle(bundle)
    : languageProviderFromBundle(bundle, cardKey);
}

/** The mutation options one card write carries: the provider, or nothing at all. */
function languageOptions(path: string | undefined, cardKey?: string): { readonly languageProvider?: KnowledgeLanguageProvider } {
  const provider = languageProviderFor(path, cardKey);
  return provider === undefined ? {} : { languageProvider: provider };
}

/** One provider per card key the bundle carries, for the members of a batch. */
function languageProvidersFor(path: string | undefined): ReadonlyMap<string, KnowledgeLanguageProvider> | undefined {
  if (path === undefined || path.length === 0) return undefined;
  const bundle = readLanguageBundle(path);
  const providers = new Map<string, KnowledgeLanguageProvider>();
  for (const cardKey of Object.keys(bundle.expansions)) providers.set(cardKey, languageProviderFromBundle(bundle, cardKey));
  if (!providers.has(KNOWLEDGE_LANGUAGE_BUNDLE_FALLBACK_KEY)) {
    providers.set(KNOWLEDGE_LANGUAGE_BUNDLE_FALLBACK_KEY, languageProviderFromBundle(bundle));
  }
  return providers;
}

function jsonValue(value: string | undefined, name: string): unknown {
  try {
    return JSON.parse(value ?? "");
  } catch {
    fail("PROFILE_INPUT_INVALID", name);
  }
}

function workspaceHeadOf(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as { readonly headEventHash?: unknown; readonly state?: unknown };
  if (typeof record.headEventHash === "string") return record.headEventHash;
  return workspaceHeadOf(record.state);
}

// INC-244: a successful workspace event must not leave the derived knowledge
// store frozen at the previous high-water. The event is already authoritative,
// so this is deliberately a post-commit repair: a blocked rebase is surfaced to
// the caller with its original reason code, never hidden behind a green write.
// A missing store is a no-op because knowledge is an optional derived surface.
async function autoRebaseKnowledgeAfterWorkspaceWrite(workspace: string, at: string, beforeHead: string | null, result: unknown): Promise<void> {
  const afterHead = workspaceHeadOf(result);
  if (beforeHead === null || afterHead === null || afterHead === beforeHead) return;
  const storeRoot = join(workspace, ".tcrn-workflow", "knowledge");
  if (!existsSync(join(storeRoot, "store.json"))) return;
  const current = await readKnowledgeStoreMarker(workspace);
  if (current.eventHighWaterDigest === afterHead) return;
  await rebaseKnowledgeStore(workspace, { expectedVersion: Number(current.version), at, retireInvalid: false });
}

async function withLease<T>(workspace: string, at: string, operation: (lease: Awaited<ReturnType<typeof acquireWorkspaceLease>>) => Promise<T>): Promise<T> {
  const lease = await acquireWorkspaceLease(workspace, { now: at });
  try {
    let beforeHead: string | null = null;
    try {
      beforeHead = (await materializeWorkspace(workspace)).headEventHash;
    } catch {
      // Recovery verbs deliberately repair residue that makes a pre-read fail.
      // Their own operation remains the authority for whether repair is allowed.
    }
    const result = await operation(lease);
    await autoRebaseKnowledgeAfterWorkspaceWrite(workspace, at, beforeHead, result);
    return result;
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
    scopeDigest: record.scopeDigest ?? null,
    title: record.title ?? null,
    // TCRN-CROSS-STORY-363. Projected as null when the record carries no summary
    // field, so a listing has one column shape whether or not the record predates
    // the field. The absent-vs-null distinction matters on the chain, where it
    // decides whether a view goes stale; it does not matter to a reader.
    summary: record.summary ?? null,
    createdAt: record.createdAt ?? null,
    labels: record.labels ?? [],
    ...(templateBinding === null ? {} : { templateBinding }),
  };
}

function workScope(record: WorkRecord): string {
  const entry = record.extensions["advisory:scope"];
  const value = entry?.value;
  return typeof value === "string" ? value : "";
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

// TCRN-CROSS-STORY-363. One lowercased haystack per record, built from the four
// fields a reader would search by. Labels join on a space so a two-label record
// cannot produce a match that spans two labels.
function workSearchText(record: WorkRecord): string {
  return [
    record.externalKey,
    record.title ?? "",
    record.summary ?? "",
    (record.labels ?? []).join(" "),
    workScope(record),
  ].join("\n").toLowerCase();
}

function workSearchSummary(record: WorkRecord, scopeBytes: number): Readonly<Record<string, unknown>> {
  return { ...workSummary(record), scope: truncateUtf8(workScope(record), scopeBytes) };
}

function workDraft(
  state: Awaited<ReturnType<typeof validateWorkspace>>,
  kind: string,
  projectId: string,
): Readonly<Record<string, unknown>> {
  const headings = kind === "Story" ? [...STORY_SCOPE_HEADINGS] : [];
  const scopeTemplate = headings.map((heading) => `【${heading}】\n<填写 ${heading}>`).join("\n\n");
  const examples = state.work
    .filter((record) => !record.tombstone && record.kind === kind && record.projectId === projectId && workScope(record).length > 0)
    .slice(-3)
    .reverse()
    .map((record) => ({ id: record.id, externalKey: record.externalKey, kind: record.kind, scope: workScope(record) }));
  return {
    schemaVersion: "tcrn.work-draft.v1",
    reasonCode: "WORKSPACE_WORK_DRAFT_READY",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    kind,
    projectId,
    headings,
    scopeTemplate,
    skeleton: scopeTemplate,
    template: scopeTemplate,
    examples,
  };
}

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
  await writeAttestationReceipt(directory, receipt);
}

interface AttestationMigrationTarget {
  readonly partition: string;
  readonly directory: string;
}

async function attestationMigrationTargets(root: string): Promise<readonly AttestationMigrationTarget[]> {
  const direct = resolve(root);
  if (direct.endsWith("/attestations")) return [{ partition: "attestations", directory: direct }];
  const targets: AttestationMigrationTarget[] = [];
  for (const entry of await readdir(direct, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = join(direct, entry.name, "attestations");
    try {
      await readdir(directory);
      targets.push({ partition: entry.name, directory });
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  return targets.sort((left, right) => left.partition < right.partition ? -1 : left.partition > right.partition ? 1 : 0);
}

async function runAttestationMigration(io: CliIo, values: Readonly<Record<string, string>>): Promise<void> {
  const mode = values.mode;
  if (mode !== "report" && mode !== "prepare" && mode !== "delete") fail("CLI_ARGUMENT_MALFORMED", "mode must be report, prepare, or delete");
  if (mode === "delete" && values.baseline === undefined) fail("CLI_ARGUMENT_MISSING", "--baseline");
  const root = values.root ?? "";
  const targets = await attestationMigrationTargets(root);
  const output: Record<string, unknown> = {
    schemaVersion: "tcrn.attestation-migration.v1",
    mode,
    targets: [],
  };
  const rows: Record<string, unknown>[] = [];
  const baselineRows: Record<string, unknown>[] = [];
  if (mode === "delete") {
    let baseline: { readonly schemaVersion?: string; readonly targets?: readonly { readonly partition?: string; readonly report?: unknown }[] };
    try {
      baseline = JSON.parse(await readFile(values.baseline ?? "", "utf8")) as typeof baseline;
    } catch (error) {
      fail("CLI_ARGUMENT_MALFORMED", `baseline is unreadable: ${String((error as { message?: string }).message ?? error)}`);
    }
    if (baseline.schemaVersion !== "tcrn.attestation-migration-baseline.v1" || !Array.isArray(baseline.targets)) fail("CLI_ARGUMENT_MALFORMED", "baseline schema");
    for (const target of targets) {
      const expected = baseline.targets.find((entry) => entry.partition === target.partition)?.report;
      if (expected === undefined) fail("CLI_ARGUMENT_MALFORMED", `baseline does not name ${target.partition}`);
      const report = await deleteLegacyAttestations(target.directory, expected as Awaited<ReturnType<typeof reportAttestationDirectory>>);
      rows.push({ partition: target.partition, report });
    }
  } else {
    for (const target of targets) {
      const before = await reportAttestationDirectory(target.directory);
      baselineRows.push({ partition: target.partition, report: before });
      const after = mode === "prepare" ? await migrateAttestationDirectory(target.directory) : before;
      rows.push({ partition: target.partition, before, after });
    }
  }
  if (values["baseline-out"] !== undefined) {
    await writeFile(resolve(values["baseline-out"]), canonicalJson({
      schemaVersion: "tcrn.attestation-migration-baseline.v1",
      targets: baselineRows,
    }), "utf8");
  }
  output.targets = rows;
  io.write(canonicalJson(output));
}

// STORY-299. A committed fact whose derived view could not be written is still a
// committed fact. The receipt says so in additional fields and keeps its success
// reason code: five checks across the platform compare that string for equality,
// so minting a second success code would read as failure to every one of them.
// The fields appear only on the degraded path; an ordinary receipt is unchanged
// byte for byte.
function viewProjectionFields(): Readonly<Record<string, unknown>> {
  const failure = consumeViewWriteFailure();
  return failure === null ? {} : {
    viewProjection: "unwritten",
    viewFailureReasonCode: failure.reasonCode,
    viewFailureCause: failure.cause,
    remedy: "recover",
  };
}

function writeState(io: CliIo, state: Awaited<ReturnType<typeof validateWorkspace>>, record?: Readonly<Record<string, unknown>>, warning?: Readonly<Record<string, string>> | null): void {
  io.write(canonicalJson({
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    projects: state.projects.filter((entry) => !entry.tombstone).length,
    work: state.work.filter((entry) => !entry.tombstone).length,
    ...viewProjectionFields(),
    ...(record ? { record } : {}),
    ...(warning === undefined || warning === null ? {} : { warning }),
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
    ...viewProjectionFields(),
  }));
}

function writePersonaState(
  io: CliIo,
  state: Awaited<ReturnType<typeof materializeWorkspace>>,
  reasonCode: "PERSONA_WRITE_COMMITTED" | "PERSONA_REMOVE_COMMITTED",
  record?: Readonly<Record<string, unknown>>,
): void {
  io.write(canonicalJson({
    reasonCode,
    schemaVersion: "tcrn.persona-write-receipt.v1",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    ...viewProjectionFields(),
    ...(record === undefined ? {} : { record }),
    personas: allPersonaReadback({ personas: state.executionConfig.personas }, state.executionConfig.personaOverrides, state.executionConfig.personaTombstones),
    modelPlans: state.executionConfig.modelPlans,
  }));
}

function writeSettingsState(io: CliIo, state: Awaited<ReturnType<typeof materializeWorkspace>>, key: string): void {
  const setting = state.settings.find((entry) => entry.key === key);
  const catalogEntry = SETTINGS_CATALOG.find((entry) => entry.key === key);
  if (catalogEntry === undefined) fail("CLI_COMMAND_FAILED", `setting ${key} is not registered`);
  const receipt = {
    schemaVersion: "tcrn.settings-write-receipt.v1",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    recordId: key,
    setting: setting ?? null,
    effectiveValue: setting?.value ?? catalogEntry.defaultValue,
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
  // TCRN-CROSS-STORY-380: the three verbs that make workspace.generatedArtifactsPath a
  // real address. artifact-put mutates the workspace (a blob and a manifest line); the
  // other two only read, which is why neither takes --at.
  { name: "artifact-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "artifact-put", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "file", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "artifact-verify", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "attestation-enable", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "actor", required: true, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "attestation-migrate", availability: "cli", mutates: true, flags: [{ name: "root", required: true, valueKind: "string" }, { name: "mode", required: true, valueKind: "string" }, { name: "baseline", required: false, valueKind: "string" }, { name: "baseline-out", required: false, valueKind: "string" }] },
  { name: "commands", availability: "cli", mutates: false, flags: [] },
  { name: "conference-append-position", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "conference-id", required: true, valueKind: "string" }, { name: "external-key", required: true, valueKind: "string" }, { name: "actor-id", required: true, valueKind: "string" }, { name: "position", required: true, valueKind: "string" }, { name: "risks", required: true, valueKind: "list" }, { name: "recommendations", required: true, valueKind: "list" }, { name: "evidence-ids", required: true, valueKind: "list" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "conference-cancel", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "conference-id", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "conference-close", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "conference-id", required: true, valueKind: "string" }, { name: "minutes-external-key", required: true, valueKind: "string" }, { name: "summary", required: true, valueKind: "string" }, { name: "outcome-class", required: true, valueKind: "string" }, { name: "decisions", required: true, valueKind: "list" }, { name: "unresolved-issues", required: true, valueKind: "list" }, { name: "actor", required: false, valueKind: "string" }, { name: "distill", required: false, valueKind: "boolean" }, { name: "accountable-owner-id", required: false, valueKind: "string" }, { name: "stale-days", required: false, valueKind: "integer" }, { name: "evidence-ids", required: false, valueKind: "list" }, { name: "attest-dir", required: false, valueKind: "string" }, { name: "execution-form", required: false, valueKind: "string" }, { name: "language-bundle", required: false, valueKind: "string" }] },
  { name: "conference-list-by-work", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "work-id", required: true, valueKind: "string" }] },
  { name: "conference-minutes-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "conference-id", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "conference-open", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "external-key", required: true, valueKind: "string" }, { name: "project-id", required: true, valueKind: "string" }, { name: "type", required: true, valueKind: "string" }, { name: "title", required: true, valueKind: "string" }, { name: "work-ids", required: true, valueKind: "list" }, { name: "desired-outcome", required: true, valueKind: "string" }, { name: "participant-ids", required: true, valueKind: "list" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "conference-position-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "conference-id", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "context-route", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }, { name: "profile-receipt", required: true, valueKind: "string" }, { name: "authority", required: true, valueKind: "string" }, { name: "profile-receipt-digest", required: false, valueKind: "string" }, { name: "authority-digest", required: false, valueKind: "string" }] },
  { name: "context-validate", availability: "cli", mutates: false, flags: [{ name: "result", required: true, valueKind: "string" }] },
  { name: "event-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "export", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "gate-create", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "external-key", required: true, valueKind: "string" }, { name: "project-id", required: true, valueKind: "string" }, { name: "work-id", required: true, valueKind: "string", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "title", required: true, valueKind: "string" }, { name: "outcome-class", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "gate-delete", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "gate-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "work-id", required: true, valueKind: "string" }] },
  { name: "gate-transition", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "status", required: true, valueKind: "string" }, { name: "minutes-locator", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }, { name: "identity-authority", required: false, valueKind: "string" }, { name: "identity-authority-digest", required: false, valueKind: "string" }] },
  { name: "init", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "framework", required: true, valueKind: "string" }, { name: "transient", required: true, valueKind: "string" }, { name: "evidence-locator", required: true, valueKind: "string" }, { name: "release-trust", required: true, valueKind: "string" }, { name: "external-key", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "segment-events", required: false, valueKind: "integer" }] },
  { name: "install-manifest", availability: "cli", mutates: false, flags: [] },
  { name: "knowledge-article-create", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "path", required: true, valueKind: "string" }, { name: "category", required: true, valueKind: "string" }, { name: "title", required: true, valueKind: "string" }, { name: "summary", required: true, valueKind: "string" }, { name: "content", required: true, valueKind: "string" }, { name: "accountable-owner-id", required: true, valueKind: "string" }, { name: "evidence-ids", required: true, valueKind: "list" }, { name: "language-bundle", required: false, valueKind: "string" }] },
  { name: "knowledge-article-refresh", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer" }, { name: "expected-revision", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "path", required: true, valueKind: "string" }, { name: "summary", required: true, valueKind: "string" }, { name: "language-bundle", required: false, valueKind: "string" }] },
  { name: "knowledge-batch", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "from-file", required: true, valueKind: "string" }, { name: "align-first", required: false, valueKind: "boolean" }, { name: "language-bundle", required: false, valueKind: "string" }] },
  { name: "knowledge-bodies-migrate", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "segment-bytes", required: false, valueKind: "integer" }] },
  { name: "knowledge-body", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "id", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "allow-unpromoted", required: false, valueKind: "boolean" }, { name: "allow-stale", required: false, valueKind: "boolean" }, { name: "allow-trailing", required: false, valueKind: "boolean" }] },
  { name: "knowledge-candidates", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "selection", required: false, valueKind: "string" }, { name: "project-id", required: false, valueKind: "string" }, { name: "role-scope", required: false, valueKind: "string" }, { name: "category", required: false, valueKind: "string" }, { name: "kind", required: false, valueKind: "string" }, { name: "tag", required: false, valueKind: "string" }, { name: "freshness", required: false, valueKind: "string" }, { name: "promotion", required: false, valueKind: "string" }, { name: "search", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }, { name: "allow-trailing", required: false, valueKind: "boolean" }] },
  { name: "knowledge-capture", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "subject", required: true, valueKind: "string" }, { name: "summary", required: true, valueKind: "string" }, { name: "snippet", required: true, valueKind: "string" }, { name: "tags", required: true, valueKind: "list" }, { name: "accountable-owner-id", required: true, valueKind: "string" }, { name: "body", required: true, valueKind: "string" }, { name: "expected-version", required: false, valueKind: "integer" }, { name: "external-key", required: false, valueKind: "string" }, { name: "role-scopes", required: false, valueKind: "list" }, { name: "category", required: false, valueKind: "string" }, { name: "kind", required: false, valueKind: "string" }, { name: "source-references", required: false, valueKind: "list" }, { name: "evidence-ids", required: false, valueKind: "list" }, { name: "supersedes", required: false, valueKind: "string" }, { name: "coexist", required: false, valueKind: "boolean" }, { name: "allow-trailing", required: false, valueKind: "boolean" }, { name: "language-bundle", required: false, valueKind: "string" }] },
  { name: "knowledge-checkpoint", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "knowledge-create", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "external-key", required: true, valueKind: "string" }, { name: "scope", required: true, valueKind: "string" }, { name: "project-id", required: true, valueKind: "string", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "role-scopes", required: true, valueKind: "list" }, { name: "category", required: true, valueKind: "string" }, { name: "kind", required: true, valueKind: "string" }, { name: "tags", required: true, valueKind: "list" }, { name: "subject", required: true, valueKind: "string" }, { name: "summary", required: true, valueKind: "string" }, { name: "snippet", required: true, valueKind: "string" }, { name: "accountable-owner-id", required: true, valueKind: "string" }, { name: "source-references", required: true, valueKind: "list" }, { name: "source-digest", required: false, valueKind: "string" }, { name: "supersedes", required: false, valueKind: "string", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "work-ids", required: false, valueKind: "list" }, { name: "decision-ids", required: false, valueKind: "list" }, { name: "gate-ids", required: false, valueKind: "list" }, { name: "evidence-ids", required: false, valueKind: "list" }, { name: "coexist", required: false, valueKind: "boolean" }, { name: "lifecycle", required: true, valueKind: "string" }, { name: "retrieval", required: true, valueKind: "string" }, { name: "freshness", required: true, valueKind: "string" }, { name: "last-verified", required: true, valueKind: "instant", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "stale-days", required: true, valueKind: "integer", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "export", required: true, valueKind: "string" }, { name: "body", required: true, valueKind: "string" }, { name: "language-bundle", required: false, valueKind: "string" }] },
  { name: "knowledge-freshness", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "allow-trailing", required: false, valueKind: "boolean" }] },
  { name: "knowledge-init", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "acknowledge-disposable", required: false, valueKind: "boolean" }] },
  { name: "knowledge-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "selection", required: false, valueKind: "string" }, { name: "project-id", required: false, valueKind: "string" }, { name: "role-scope", required: false, valueKind: "string" }, { name: "category", required: false, valueKind: "string" }, { name: "kind", required: false, valueKind: "string" }, { name: "tag", required: false, valueKind: "string" }, { name: "freshness", required: false, valueKind: "string" }, { name: "promotion", required: false, valueKind: "string" }, { name: "search", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }, { name: "allow-trailing", required: false, valueKind: "boolean" }] },
  { name: "knowledge-promote", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer" }, { name: "expected-revision", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "state", required: true, valueKind: "string" }] },
  { name: "knowledge-rebase", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "retire-invalid", required: false, valueKind: "boolean" }] },
  { name: "knowledge-retire", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer" }, { name: "expected-revision", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }] },
  { name: "knowledge-reverify", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer" }, { name: "expected-revision", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }] },
  { name: "knowledge-snippet", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "id", required: true, valueKind: "string" }, { name: "allow-trailing", required: false, valueKind: "boolean" }] },
  { name: "knowledge-source-check", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "allow-trailing", required: false, valueKind: "boolean" }] },
  { name: "knowledge-validate", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "lease-break", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "owner-token", required: true, valueKind: "string" }] },
  { name: "lease-inspect", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "lease-recovery-break", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "claim-token", required: true, valueKind: "string" }] },
  // STORY-281: machine-level portal preferences. No workspace and no expected-version:
  // this layer is not chain-backed, so there is no head to compare against — see
  // packages/core/src/machine-settings.ts for why a laptop's default theme is not
  // governed workspace state. `home` exists so a test can point the verbs at a
  // scratch directory instead of the real machine home.
  { name: "machine-settings-catalog", availability: "cli", mutates: false, flags: [{ name: "home", required: false, valueKind: "string" }] },
  { name: "machine-settings-remove", availability: "cli", mutates: true, flags: [{ name: "at", required: true, valueKind: "instant" }, { name: "key", required: true, valueKind: "string" }, { name: "home", required: false, valueKind: "string" }] },
  { name: "machine-settings-set", availability: "cli", mutates: true, flags: [{ name: "at", required: true, valueKind: "instant" }, { name: "key", required: true, valueKind: "string" }, { name: "value", required: true, valueKind: "string" }, { name: "home", required: false, valueKind: "string" }] },
  // TCRN-CROSS-INC-275: PostgreSQL support removed. migration-verify and
  // migration-rollback removed (pg family verbs). migration-execute retains only
  // the storage-version migration (v1→v2) via migrateWorkspaceStorage.
  { name: "migration-execute", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "migration-plan", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "target-version", required: true, valueKind: "integer" }, { name: "dry-run", required: true, valueKind: "boolean" }] },
  { name: "model-plan-assign", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "host", required: true, valueKind: "string" }, { name: "plan", required: true, valueKind: "string" }, { name: "persona", required: true, valueKind: "string" }, { name: "model", required: true, valueKind: "string" }, { name: "effort", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "model-plan-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "host", required: false, valueKind: "string" }] },
  { name: "model-plan-remove", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "host", required: true, valueKind: "string" }, { name: "name", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "model-plan-set", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "host", required: true, valueKind: "string" }, { name: "name", required: true, valueKind: "string" }, { name: "default-model", required: true, valueKind: "string" }, { name: "default-effort", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "model-plan-unassign", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "host", required: true, valueKind: "string" }, { name: "plan", required: true, valueKind: "string" }, { name: "persona", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "persona-generate", availability: "cli", mutates: false, flags: [{ name: "set", required: true, valueKind: "string" }] },
  { name: "persona-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "persona-preset-override", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "name", required: true, valueKind: "string" }, { name: "fields", required: true, valueKind: "json" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "persona-preset-restore", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "name", required: true, valueKind: "string" }, { name: "field", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "persona-remove", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "name", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "persona-render", availability: "cli", mutates: false, flags: [{ name: "profile-id", required: true, valueKind: "string" }] },
  { name: "persona-set", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "name", required: true, valueKind: "string" }, { name: "role", required: true, valueKind: "string" }, { name: "job-title", required: false, valueKind: "string" }, { name: "mission", required: false, valueKind: "string" }, { name: "refusals", required: false, valueKind: "string" }, { name: "authority-boundary", required: false, valueKind: "string" }, { name: "contact-when", required: false, valueKind: "string" }, { name: "required-inputs", required: false, valueKind: "string" }, { name: "deliverables", required: false, valueKind: "string" }, { name: "success-criteria", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "persona-validate", availability: "cli", mutates: false, flags: [{ name: "bundle", required: true, valueKind: "json" }] },
  { name: "profile-authorize", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }, { name: "receipt", required: true, valueKind: "string" }, { name: "operation", required: true, valueKind: "string" }, { name: "workspace-id", required: true, valueKind: "string", nullSentinel: "-" }, { name: "project-id", required: true, valueKind: "string", nullSentinel: "-" }, { name: "command", required: true, valueKind: "string", nullSentinel: "-" }, { name: "receipt-digest", required: false, valueKind: "string" }] },
  { name: "profile-generate", availability: "cli", mutates: false, flags: [{ name: "mode", required: true, valueKind: "string" }] },
  { name: "profile-resolve", availability: "cli", mutates: false, flags: [{ name: "request", required: true, valueKind: "json" }, { name: "receipt", required: true, valueKind: "string" }, { name: "receipt-digest", required: false, valueKind: "string" }] },
  { name: "profile-validate", availability: "cli", mutates: false, flags: [{ name: "bundle", required: true, valueKind: "json" }] },
  { name: "project-create", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "external-key", required: true, valueKind: "string" }, { name: "name", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "project-delete", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "project-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "project-update", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "name", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "recall", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "query", required: true, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "tau", required: false, valueKind: "string" }, { name: "partition", required: false, valueKind: "string" }, { name: "allow-trailing", required: false, valueKind: "boolean" }] },
  { name: "recover", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "settings-catalog", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "settings-remove", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "key", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "settings-set", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "key", required: true, valueKind: "string" }, { name: "value", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "snapshot-manifest", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "snapshot-replay-rebuild", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "snapshot-verify", availability: "cli", mutates: false, flags: [{ name: "root", required: true, valueKind: "string" }, { name: "manifest", required: true, valueKind: "string" }] },
  { name: "status", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  // INC-074/INC-081: seal a retained file archive to an already authoritative
  // TCRN-CROSS-INC-275: PostgreSQL support removed. storage-home-seal was
  // PG-specific; it is removed.
  { name: "storage-home-status", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "template-admit", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "template", required: true, valueKind: "string" }, { name: "owner", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "template-validate", availability: "cli", mutates: false, flags: [{ name: "template", required: true, valueKind: "string" }] },
  { name: "validate", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }] },
  { name: "vocabulary", availability: "cli", mutates: false, flags: [] },
  { name: "work-annotate", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "scope", required: false, valueKind: "string" }, { name: "decided-by", required: false, valueKind: "list" }, { name: "sprint", required: false, valueKind: "string" }, { name: "title", required: false, valueKind: "string" }, { name: "summary", required: false, valueKind: "string" }, { name: "labels", required: false, valueKind: "list" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "work-batch", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "from-file", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "work-create", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "project-id", required: true, valueKind: "string" }, { name: "external-key", required: true, valueKind: "string" }, { name: "kind", required: true, valueKind: "string" }, { name: "parent-id", required: false, valueKind: "string", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "status", required: false, valueKind: "string" }, { name: "scope", required: false, valueKind: "string" }, { name: "decided-by", required: false, valueKind: "list" }, { name: "title", required: true, valueKind: "string" }, { name: "summary", required: false, valueKind: "string" }, { name: "labels", required: false, valueKind: "list" }, { name: "template-receipt", required: false, valueKind: "json" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "work-delete", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
  { name: "work-draft", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "kind", required: true, valueKind: "string" }, { name: "project-id", required: true, valueKind: "string" }] },
  { name: "work-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "project-id", required: false, valueKind: "string" }, { name: "kind", required: false, valueKind: "string" }, { name: "status", required: false, valueKind: "string" }, { name: "parent-id", required: false, valueKind: "string" }, { name: "sprint", required: false, valueKind: "string" }, { name: "search", required: false, valueKind: "string" }, { name: "scope-bytes", required: false, valueKind: "integer" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "work-show", availability: "cli", mutates: false, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "id", required: true, valueKind: "string" }] },
  { name: "work-transition", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "expected-version", required: true, valueKind: "integer", headSentinel: true }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "status", required: true, valueKind: "string" }, { name: "summary", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }, { name: "attest-dir", required: false, valueKind: "string" }] },
] as const);

// INC-016: `mutates` and `authorityBearing` name two DIFFERENT authorization
// categories, and the operator bundle keeps their grant lists disjoint
// (validateOperatorAuthorityBundle refuses a command present in both). Nothing
// refused the FLAG pair, and the MCP dispatcher tests `mutates` first -- so an entry
// declaring both would be satisfied by a writeCommands grant alone: a write grant
// carrying authority-bearing output, which operator-authority-v1 forbids
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
// remembered to set. A verb minting host-state output without declaring mutates or
// authorityBearing now reddens at the write boundary below, present or future verb alike.
// These are the field names and the state tokens that make a document readable as
// observed host trust state. TCRN-CROSS-STORY-358 retired the only core modules that ever
// hand-declared them (codex-adapter-activation.ts, codex-adapter-installer.ts) along with
// the test that bound this list two-way against that live declaration
// (tests/act13-authority-output.test.mjs's former vocabulary case; see
// scripts/policy/coverage-waivers.json for its disposition). The list below is now a fixed
// historical allowlist, still enforced by the fail-closed tests that remain in that file.
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
  // S245 retirement boundary: these names remain replay-only historical
  // operations, never callable write/read verbs on the public CLI.
  if (["execution-config", "host-config-default", "host-config-remove", "host-config-set", "persona-binding-remove", "persona-binding-set"].includes(command)) {
    fail("CLI_COMMAND_UNKNOWN", `${command} is a retired replay-only path; use settings-catalog, persona-list, model-plan-list, or vocabulary for read-only state`);
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
  // TCRN-CROSS-INC-275: PostgreSQL support removed. The STORY-189 PG-serving
  // facade is removed entirely.
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
  // STORY-300. The catalog has always carried every flag's name, whether it is
  // required, and what kind of value it takes; there was simply no way to ask it
  // about one verb. So the way to learn a verb's arguments was to run it wrong and
  // read the refusal, or to open the engine -- and `--help`, the thing everyone
  // tries first, was itself refused as a malformed argument 35 times in this
  // chain's history, which makes it the most expensive single refusal in it.
  //
  // This answers from the same array `commands` returns, so the two can never
  // disagree, and reuses that verb's reason code rather than minting one.
  if (rest.includes("--help") || rest.includes("-h")) {
    const entry = COMMAND_CATALOG.find((candidate) => candidate.name === command);
    if (entry === undefined) fail("CLI_COMMAND_UNKNOWN", command);
    io.write(canonicalJson({ reasonCode: "CLI_CATALOG_READY", schemaVersion: "tcrn.cli-catalog.v1", commands: [entry] }));
    return;
  }
  if (command === "commands") {
    parseArguments(rest, []);
    io.write(canonicalJson({ reasonCode: "CLI_CATALOG_READY", schemaVersion: "tcrn.cli-catalog.v1", commands: COMMAND_CATALOG }));
    return;
  }
  if (command === "attestation-migrate") {
    const values = parseArguments(rest, ["root", "mode", "baseline", "baseline-out"]);
    required(values, ["root", "mode"]);
    await runAttestationMigration(io, values);
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
      engineVersion: FRAMEWORK_VERSION,
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
      // STORY-299: headroom belongs on the one verb that still answers past a
      // ceiling. The view-verifying verbs fail closed when a view is over budget,
      // so a gauge hung on any of them would be readable only while it had nothing
      // to report. It covers every view and the record cap, not just the file that
      // happened to fill up first: the work index and the event cap are the next
      // two walls, and both were found by measurement rather than by an incident.
      budgets: workspaceBudgets(state),
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
    // TCRN-CROSS-INC-275: PostgreSQL support removed. Only the storage-version
    // migration (v1→v2) remains.
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await migrateWorkspaceStorage(values.workspace ?? "")));
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
  if (command === "machine-settings-catalog") {
    const values = parseArguments(rest, ["home"]);
    io.write(canonicalJson({ reasonCode: "MACHINE_SETTINGS_CATALOG_READY", ...await readMachineSettingsCatalog(machineSettingsPath(values.home ?? homedir())) }));
    return;
  }
  if (command === "machine-settings-set") {
    const values = parseArguments(rest, ["at", "key", "value", "home"]);
    required(values, ["at", "key", "value"]);
    const file = await applyMachineSettingSet({ key: values.key ?? "", value: values.value ?? "", occurredAt: values.at ?? "", path: machineSettingsPath(values.home ?? homedir()) });
    io.write(canonicalJson({ reasonCode: "MACHINE_SETTINGS_WRITE_COMMITTED", ...file }));
    return;
  }
  if (command === "machine-settings-remove") {
    const values = parseArguments(rest, ["at", "key", "home"]);
    required(values, ["at", "key"]);
    const file = await applyMachineSettingRemove({ key: values.key ?? "", occurredAt: values.at ?? "", path: machineSettingsPath(values.home ?? homedir()) });
    io.write(canonicalJson({ reasonCode: "MACHINE_SETTINGS_WRITE_COMMITTED", ...file }));
    return;
  }
  if (command === "settings-catalog") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    const state = await materializeWorkspace(values.workspace ?? "");
    io.write(canonicalJson({ reasonCode: "SETTINGS_CATALOG_READY", ...readSettingsCatalog(state.metadata.workspaceId, state.settings,
      state.metadata.storageVersion === 2 ? { "storage.segmentBytes": String(state.metadata.segmentEventLimit) } : {}) }));
    return;
  }
  if (command === "install-manifest") {
    parseArguments(rest, []);
    io.write(canonicalJson({ reasonCode: "INSTALL_MANIFEST_READY", ...readInstallManifest() }));
    return;
  }
  if (command === "vocabulary") {
    parseArguments(rest, []);
    io.write(canonicalJson({ reasonCode: "VOCABULARY_READY", ...readVocabulary() }));
    return;
  }
  if (command === "model-plan-list") {
    const values = parseArguments(rest, ["workspace", "host"]);
    required(values, ["workspace"]);
    const state = await materializeWorkspace(values.workspace ?? "");
    const host = values.host;
    if (host !== undefined && host !== "") assertModelPlanHost(host);
    io.write(canonicalJson({
      schemaVersion: "tcrn.model-plan-list-readback.v1",
      reasonCode: "MODEL_PLAN_LIST_READY",
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      plans: state.executionConfig.modelPlans.filter((plan) => host === undefined || host === "" || plan.host === host),
    }));
    return;
  }
  if (command === "model-plan-set" || command === "model-plan-assign" || command === "model-plan-unassign" || command === "model-plan-remove") {
    const names = command === "model-plan-set"
      ? [...shared, "host", "name", "default-model", "default-effort", "actor"]
      : command === "model-plan-assign"
        ? [...shared, "host", "plan", "persona", "model", "effort", "actor"]
        : command === "model-plan-unassign"
          ? [...shared, "host", "plan", "persona", "actor"]
          : [...shared, "host", "name", "actor"];
    const values = parseArguments(rest, names);
    required(values, command === "model-plan-set" ? [...requiredShared, "host", "name", "default-model"] : command === "model-plan-remove" ? [...requiredShared, "host", "name"] : [...requiredShared, "host", "plan", "persona"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => {
      const expectedVersion = await resolveExpectedVersion(values, workspace);
      if (command === "model-plan-set") return setModelPlanInWorkspace(workspace, lease, { expectedVersion, occurredAt: at, host: values.host ?? "", name: values.name ?? "", defaultModel: values["default-model"] ?? "", ...(values["default-effort"] ? { defaultEffort: values["default-effort"] } : {}), ...(values.actor ? { actorId: values.actor } : {}) });
      if (command === "model-plan-assign") return assignModelPlanInWorkspace(workspace, lease, { expectedVersion, occurredAt: at, host: values.host ?? "", name: values.plan ?? "", persona: values.persona ?? "", model: values.model ?? "", ...(values.effort ? { effort: values.effort } : {}), ...(values.actor ? { actorId: values.actor } : {}) });
      if (command === "model-plan-unassign") return unassignModelPlanInWorkspace(workspace, lease, { expectedVersion, occurredAt: at, host: values.host ?? "", name: values.plan ?? "", persona: values.persona ?? "", ...(values.actor ? { actorId: values.actor } : {}) });
      return removeModelPlanInWorkspace(workspace, lease, { expectedVersion, occurredAt: at, host: values.host ?? "", name: values.name ?? "", ...(values.actor ? { actorId: values.actor } : {}) });
    });
    await emitTimeAttestation(io, values, state.headEventHash);
    io.write(canonicalJson({
      schemaVersion: "tcrn.model-plan-write-receipt.v1",
      reasonCode: "MODEL_PLAN_WRITE_COMMITTED",
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      plans: state.executionConfig.modelPlans,
    }));
    return;
  }
  if (command === "persona-preset-override") {
    const values = parseArguments(rest, [...shared, "name", "fields", "actor"]);
    required(values, [...requiredShared, "name", "fields"]);
    const fields = jsonValue(values.fields, "fields");
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) fail("CLI_ARGUMENT_MALFORMED", "fields must be a JSON object");
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => overridePersonaPresetInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace), occurredAt: at, name: values.name ?? "", fields: fields as Readonly<Record<string, unknown>>,
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writePersonaState(io, state, "PERSONA_WRITE_COMMITTED", state.executionConfig.personaOverrides.find((entry) => entry.name === values.name) as unknown as Readonly<Record<string, unknown>> | undefined);
    return;
  }
  if (command === "persona-preset-restore") {
    const values = parseArguments(rest, [...shared, "name", "field", "actor"]);
    required(values, [...requiredShared, "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => restorePersonaPresetInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace), occurredAt: at, name: values.name ?? "", ...(values.field === undefined ? {} : { field: values.field }),
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writePersonaState(io, state, "PERSONA_WRITE_COMMITTED");
    return;
  }
  if (command === "persona-set") {
    const values = parseArguments(rest, [...shared, "name", "role", "job-title", "mission", "refusals", "authority-boundary", "contact-when", "required-inputs", "deliverables", "success-criteria", "actor"]);
    required(values, [...requiredShared, "name", "role"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => setCustomPersonaInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace), occurredAt: at,
      name: values.name ?? "", role: values.role ?? "",
      ...(values["job-title"] === undefined ? {} : { jobTitle: values["job-title"] }),
      ...(values.mission === undefined ? {} : { mission: values.mission }),
      ...(values.refusals === undefined ? {} : { refusals: values.refusals }),
      ...(values["authority-boundary"] === undefined ? {} : { authorityBoundary: values["authority-boundary"] }),
      ...(values["contact-when"] === undefined ? {} : { contactWhen: values["contact-when"] }),
      ...(values["required-inputs"] === undefined ? {} : { requiredInputs: values["required-inputs"] }),
      ...(values.deliverables === undefined ? {} : { deliverables: values.deliverables }),
      ...(values["success-criteria"] === undefined ? {} : { successCriteria: values["success-criteria"] }),
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writePersonaState(io, state, "PERSONA_WRITE_COMMITTED", state.executionConfig.personas.find((entry) => entry.name === values.name) as unknown as Readonly<Record<string, unknown>> | undefined);
    return;
  }
  if (command === "settings-remove") {
    const values = parseArguments(rest, [...shared, "key", "actor"]);
    required(values, [...requiredShared, "key"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => removeWorkspaceSetting(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace), occurredAt: at, key: values.key ?? "", ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeSettingsState(io, state, values.key ?? "");
    return;
  }
  if (command === "persona-remove") {
    const values = parseArguments(rest, [...shared, "name", "actor"]);
    required(values, [...requiredShared, "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => removePersonaInWorkspace(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at,
      name: values.name ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    writePersonaState(io, state, "PERSONA_REMOVE_COMMITTED", { name: values.name ?? "" });
    return;
  }
  if (command === "persona-list") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    const state = await materializeWorkspace(values.workspace ?? "");
    io.write(canonicalJson({
      schemaVersion: "tcrn.persona-list-readback.v1",
      reasonCode: "PERSONA_LIST_READY",
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      personas: allPersonaReadback({ personas: state.executionConfig.personas }, state.executionConfig.personaOverrides, state.executionConfig.personaTombstones),
    }));
    return;
  }
  if (command === "settings-set") {
    const values = parseArguments(rest, [...shared, "key", "value", "actor"]);
    required(values, [...requiredShared, "key", "value"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    // TCRN-CROSS-STORY-380: the half of the artifact-root rule a live filesystem has to
    // answer. It cannot live in validateSettingValue, which also runs on the replay path
    // (settings.ts says why), so it runs here, at the moment an operator declares the
    // address — the moment they can still fix a typo. artifact-put asks again before it
    // writes, because a directory that was real when it was declared is not necessarily
    // real when it is used.
    if (values.key === "workspace.generatedArtifactsPath") {
      // Shape first, filesystem second, and in that order deliberately: the shape rule is
      // the one that also runs on replay, so it is the one whose refusal an operator will
      // meet again later. validateSettingValue is the same pure function setWorkspaceSetting
      // is about to call, so calling it here costs a second pass over one string and buys a
      // stable reason code rather than whichever check happened to be reached first.
      await assertGeneratedArtifactsRoot(workspace, validateSettingValue(values.key, values.value ?? "", workspace));
    }
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
  if (command === "artifact-put") {
    // TCRN-CROSS-STORY-380. The lease is the quiesce proof, the same one snapshot-manifest
    // takes below: two puts appending to one manifest without it each write a manifest
    // missing the other's entry, and the loser's blob sits on disk with nothing pointing
    // at it. No chain event is appended — the manifest is the record, and keeping the put
    // off the chain is what lets the blob root be a directory the engine does not own.
    const values = parseArguments(rest, ["workspace", "file", "at"]);
    required(values, ["workspace", "file", "at"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    io.write(canonicalJson(await withLease(workspace, at, (lease) => putArtifact(workspace, lease, { file: values.file ?? "", at }))));
    return;
  }
  if (command === "artifact-list") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await listArtifacts(values.workspace ?? "")));
    return;
  }
  if (command === "artifact-verify") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await verifyArtifacts(values.workspace ?? "")));
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
  if (command === "snapshot-replay-rebuild") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await rebuildReplaySnapshot(values.workspace ?? "")));
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
  if (command === "knowledge-bodies-migrate") {
    const values = parseArguments(rest, ["workspace", "segment-bytes"]);
    required(values, ["workspace"]);
    const segmentBytes = values["segment-bytes"] === undefined ? undefined : integerValue(values, "segment-bytes");
    io.write(canonicalJson(await migrateKnowledgeBodies(values.workspace ?? "", segmentBytes)));
    return;
  }
  if (command === "knowledge-validate") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await validateKnowledgeStore(values.workspace ?? "")));
    return;
  }
  if (command === "knowledge-article-create") {
    const names = ["workspace", "expected-version", "at", "path", "category", "title", "summary", "content", "accountable-owner-id", "evidence-ids", "language-bundle"];
    const values = parseArguments(rest, names);
    required(values, names.filter((name) => name !== "language-bundle"));
    const categories = ["architecture", "domain", "implementation", "standards", "testing", "workflow", "decision", "evidence"];
    if (!categories.includes(values.category ?? "")) fail("CLI_ARGUMENT_MALFORMED", `category=${values.category ?? ""}`);
    io.write(canonicalJson(await createKnowledgeArticle(values.workspace ?? "", {
      expectedVersion: expectedVersion(values),
      occurredAt: values.at ?? "",
      path: values.path ?? "",
      category: values.category as KnowledgeCategory,
      title: values.title ?? "",
      summary: values.summary ?? "",
      content: values.content ?? "",
      accountableOwnerId: values["accountable-owner-id"] ?? "",
      linkedEvidenceIds: listValue(values["evidence-ids"]),
    }, languageOptions(values["language-bundle"]))));
    return;
  }
  if (command === "knowledge-article-refresh") {
    const names = ["workspace", "expected-version", "expected-revision", "at", "id", "path", "summary", "language-bundle"];
    const values = parseArguments(rest, names);
    required(values, names.filter((name) => name !== "language-bundle"));
    io.write(canonicalJson(await refreshKnowledgeArticle(values.workspace ?? "", {
      expectedVersion: expectedVersion(values),
      expectedRevision: integerValue(values, "expected-revision"),
      occurredAt: values.at ?? "",
      id: values.id ?? "",
      path: values.path ?? "",
      summary: values.summary ?? "",
    }, languageOptions(values["language-bundle"]))));
    return;
  }
  if (command === "knowledge-source-check") {
    const values = parseArguments(rest, ["workspace", "allow-trailing"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await checkKnowledgeSources(values.workspace ?? "", {
      allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"),
    })));
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
      "subject", "summary", "snippet", "accountable-owner-id", "source-references", "source-digest", "supersedes", "work-ids", "decision-ids", "gate-ids", "evidence-ids",
      "coexist", "lifecycle", "retrieval", "freshness", "last-verified", "stale-days", "export", "body", "language-bundle",
    ];
    // TCRN-CROSS-STORY-365: the four backlink lists are optional. They were required with
    // a "-" spelling for "none", which made every card pay four flags to say nothing, and
    // 26 of 28 flags required is what made this verb unusable from a hook.
    const optional = ["source-digest", "supersedes", "work-ids", "decision-ids", "gate-ids", "evidence-ids", "coexist", "language-bundle"];
    const values = parseArguments(rest, names);
    required(values, names.filter((name) => !optional.includes(name)));
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
      sourceDigest: values["source-digest"] ?? null,
      supersedes: nullableValue(values.supersedes),
      linkedWorkIds: listValue(values["work-ids"]),
      linkedDecisionIds: listValue(values["decision-ids"]),
      linkedGateIds: listValue(values["gate-ids"]),
      linkedEvidenceIds: listValue(values["evidence-ids"]),
      lifecycle: values.lifecycle as "candidate" | "active" | "retired",
      retrievalDisposition: values.retrieval as "default" | "explicit-only" | "excluded",
      freshnessState: values.freshness as KnowledgeFreshnessState,
      lastVerified: nullableValue(values["last-verified"]),
      stalenessPolicy: { maximumAgeDays: nullableIntegerValue(values, "stale-days"), unknownDisposition: "fail-closed" },
      exportDisposition: values.export as "metadata-only" | "excluded",
      body: values.body ?? "",
      coexist: booleanValue(values.coexist, "coexist"),
    }, languageOptions(values["language-bundle"], values["external-key"]))));
    return;
  }
  if (command === "knowledge-capture") {
    // TCRN-CROSS-STORY-365: the thin write. Eight required flags -- the store, the
    // instant, the four card fields, the accountable owner, and the body -- and every
    // other shape defaulted in core. Written is retrievable; there is no promotion step.
    const names = [
      "workspace", "at", "subject", "summary", "snippet", "tags", "accountable-owner-id", "body",
      "expected-version", "external-key", "role-scopes", "category", "kind", "source-references", "evidence-ids",
      "supersedes", "coexist", "allow-trailing", "language-bundle",
    ];
    const values = parseArguments(rest, names);
    required(values, ["workspace", "at", "subject", "summary", "snippet", "tags", "accountable-owner-id", "body"]);
    for (const [flag, admitted] of [
      ["category", ["architecture", "domain", "implementation", "standards", "testing", "workflow", "decision", "evidence"]],
      ["kind", ["fact", "guide", "decision", "reference", "summary"]],
    ] as readonly (readonly [string, readonly string[]])[]) {
      const provided = values[flag];
      if (provided !== undefined && !admitted.includes(provided)) fail("CLI_ARGUMENT_MALFORMED", `${flag}=${provided}`);
    }
    io.write(canonicalJson(await captureKnowledgeUnit(values.workspace ?? "", {
      occurredAt: values.at ?? "",
      subject: values.subject ?? "",
      summary: values.summary ?? "",
      snippet: values.snippet ?? "",
      tags: listValue(values.tags),
      accountableOwnerId: values["accountable-owner-id"] ?? "",
      body: values.body ?? "",
      coexist: booleanValue(values.coexist, "coexist"),
      ...(values["expected-version"] !== undefined ? { expectedVersion: expectedVersion(values) } : {}),
      ...(values["external-key"] ? { externalKey: values["external-key"] } : {}),
      ...(values["role-scopes"] ? { roleScopes: listValue(values["role-scopes"]) } : {}),
      ...(values.category ? { category: values.category as KnowledgeCategory } : {}),
      ...(values.kind ? { kind: values.kind as KnowledgeKind } : {}),
      ...(values["source-references"] ? { sourceReferences: listValue(values["source-references"]) } : {}),
      ...(values["evidence-ids"] ? { linkedEvidenceIds: listValue(values["evidence-ids"]) } : {}),
      ...(values.supersedes ? { supersedes: values.supersedes } : {}),
    }, { allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"), ...languageOptions(values["language-bundle"], values["external-key"]) })));
    return;
  }
  if (command === "knowledge-list") {
    const values = parseArguments(rest, ["workspace", "at", "selection", "project-id", "role-scope", "category", "kind", "tag", "freshness", "promotion", "search", "limit", "offset", "allow-trailing"]);
    required(values, ["workspace", "at"]);
    io.write(canonicalJson(await listKnowledgeMetadata(values.workspace ?? "", {
      at: values.at ?? "",
      allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"),
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
      // rule (>= 1, <= the canonical view-byte budget, offset >= 0), and a CLI-side
      // floor would pre-empt half of it while silently keeping the ceiling.
      ...(values.limit !== undefined ? { limit: integerValue(values, "limit") } : {}),
      ...(values.offset !== undefined ? { offset: integerValue(values, "offset") } : {}),
    })));
    return;
  }
  if (command === "knowledge-candidates") {
    // WSC-7: emit the selected knowledge metadata already shaped as
    // tcrn.context-metadata-candidate.v1 records — the output candidates array is
    // consumable directly as a context-route request metadataCandidates entry.
    const values = parseArguments(rest, ["workspace", "at", "selection", "project-id", "role-scope", "category", "kind", "tag", "freshness", "promotion", "search", "limit", "offset", "allow-trailing"]);
    required(values, ["workspace", "at"]);
    io.write(canonicalJson(await knowledgeContextCandidates(values.workspace ?? "", {
      at: values.at ?? "",
      allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"),
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
    const values = parseArguments(rest, ["workspace", "id", "allow-trailing"]);
    required(values, ["workspace", "id"]);
    io.write(canonicalJson(await readKnowledgeSnippet(values.workspace ?? "", values.id ?? "", {
      allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"),
    })));
    return;
  }
  if (command === "knowledge-body") {
    const values = parseArguments(rest, ["workspace", "id", "at", "allow-unpromoted", "allow-stale", "allow-trailing"]);
    required(values, ["workspace", "id", "at"]);
    io.write(canonicalJson(await readKnowledgeBody(values.workspace ?? "", values.id ?? "", {
      at: values.at ?? "",
      allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"),
      allowUnpromoted: booleanValue(values["allow-unpromoted"], "allow-unpromoted"),
      allowStale: booleanValue(values["allow-stale"], "allow-stale"),
    })));
    return;
  }
  if (command === "knowledge-freshness") {
    const values = parseArguments(rest, ["workspace", "at", "allow-trailing"]);
    required(values, ["workspace", "at"]);
    io.write(canonicalJson(await evaluateKnowledgeFreshness(values.workspace ?? "", values.at ?? "", {
      allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"),
    })));
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
  if (command === "knowledge-batch") {
    // Same shape as work-batch: --from-file because a batch is ordinarily generated.
    // --expected-version is the STORE's version (the meaning every knowledge verb gives
    // that flag), and --align-first folds the rebase a chain-written workspace always
    // needs into the same invocation -- N cards, one round trip.
    const values = parseArguments(rest, ["workspace", "expected-version", "at", "from-file", "align-first", "language-bundle"]);
    required(values, ["workspace", "expected-version", "at", "from-file"]);
    const { readFileSync } = await import("node:fs");
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(values["from-file"] ?? "", "utf8"));
    } catch (error) {
      fail("WORK_BATCH_MALFORMED", `${values["from-file"] ?? ""}: ${(error as { message?: string }).message ?? "unreadable"}`);
    }
    const batchProviders = languageProvidersFor(values["language-bundle"]);
    io.write(canonicalJson(await applyKnowledgeBatch(values.workspace ?? "", document, {
      expectedVersion: integerValue(values, "expected-version"),
      occurredAt: values.at ?? "",
      alignFirst: booleanValue(values["align-first"], "align-first"),
      ...(batchProviders === undefined ? {} : { languageProviders: batchProviders }),
    })));
    return;
  }
  // TCRN-CROSS-STORY-362: one bm25 answer over the three record families a session can
  // be reminded of, in place of the substring scan that returned everything a tag named
  // or nothing at all. The verb is workspace-addressed like every other verb; --partition
  // is accepted because the injection hook speaks in partitions, and is checked against
  // the path the caller resolved rather than used to resolve one -- a hook whose path
  // resolution drifts gets a refusal instead of an answer from the wrong chain.
  if (command === "recall") {
    const values = parseArguments(rest, ["workspace", "at", "query", "limit", "tau", "partition", "allow-trailing"]);
    required(values, ["workspace", "at", "query"]);
    const workspace = values.workspace ?? "";
    const query = values.query ?? "";
    if (query.length === 0 || query.length > 4096 || !query.isWellFormed()) fail("CLI_ARGUMENT_MALFORMED", "query");
    const limit = values.limit === undefined ? undefined : integerValue(values, "limit");
    if (limit !== undefined && (limit < 1 || limit > RECALL_CANDIDATE_LIMIT)) fail("CLI_ARGUMENT_MALFORMED", "limit");
    const partition = basename(dirname(resolve(workspace)));
    if (values.partition !== undefined && values.partition !== partition) {
      fail("CLI_ARGUMENT_MALFORMED", `partition=${values.partition}`);
    }
    const state = await validateWorkspace(workspace);
    const settingValue = (key: string): string | undefined => state.settings.find((entry) => entry.key === key)?.value;
    // The flag wins over the setting, the setting over the recorded default: the same
    // order work-list's scope-bytes already uses.
    const configuredTau = Number(settingValue("retrieval.tau") ?? String(RECALL_DEFAULT_TAU));
    const tau = values.tau === undefined
      ? (Number.isFinite(configuredTau) && configuredTau >= 0 ? configuredTau : RECALL_DEFAULT_TAU)
      : Number(values.tau);
    if (!Number.isFinite(tau) || tau < 0) fail("CLI_ARGUMENT_MALFORMED", "tau");
    // TCRN-CROSS-STORY-364 requirement 4: a prompt whose language is outside the recorded
    // prompt languages is answered, and the answer says the translation is owed and which
    // model owes it. The engine calls no model; the hook holding it translates and asks
    // again. Read-side is fail-open, unlike the write path, because a session with no
    // answer is worse than an answer ranked in the wrong language.
    const languageAnswer = resolveQueryLanguage(query, readKnowledgeLanguagePolicy(state.settings));
    const scopeBytes = Number(settingValue("retrieval.scopeExcerptBytes") ?? "512");
    const scopeExcerptBytes = Number.isSafeInteger(scopeBytes) && scopeBytes > 0 ? scopeBytes : 512;
    // A workspace with no knowledge store, or one trailing the chain while the caller did
    // not admit a trailing read, still has work records and minutes to recall. The reason
    // code the read produced is reported rather than swallowed, so "no cards" is never
    // indistinguishable from "no card matched".
    let knowledge: readonly RecallKnowledgeInput[] = [];
    let knowledgeReasonCode = "KNOWLEDGE_STORE_UNREAD";
    let knowledgeDigest = "absent";
    try {
      const answer = await listKnowledgeMetadata(workspace, {
        at: values.at ?? "",
        allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"),
        // Recall is an explicit search surface, so it admits explicit-only article
        // index cards while the context/default selection remains unchanged. The
        // complete corpus is read before FTS scoring so BM25 keeps its baseline.
        includeExplicitOnly: true,
        limit: 1_048_576,
      });
      knowledgeReasonCode = String(answer["reasonCode"] ?? "");
      knowledgeDigest = String(answer["resultDigest"] ?? "");
      knowledge = ((answer["records"] ?? []) as readonly Readonly<Record<string, unknown>>[]).map((record) => ({
        id: String(record["id"] ?? ""),
        externalKey: String(record["externalKey"] ?? ""),
        subject: String(record["subject"] ?? ""),
        summary: String(record["summary"] ?? ""),
        snippet: String(record["snippet"] ?? ""),
        tags: ((record["tags"] ?? []) as readonly unknown[]).map((tag) => String(tag)),
        // The weight-6 column is fed by an author's own restatements of the question a card
        // answers. TCRN-CROSS-STORY-364 writes them: the metadata field is a map from prompt
        // language to phrasings, flattened here by the one helper both sides share. The
        // 2026-09-04 evaluation measured them lifting cards-only recall from 21 of 36 to 36.
        expansions: expansionsText(record["expansions"]),
      }));
    } catch (error) {
      const reasonCode = (error as { readonly reasonCode?: unknown }).reasonCode;
      if (typeof reasonCode !== "string") throw error;
      knowledgeReasonCode = reasonCode;
    }
    const conferenceTitles = new Map(state.conferences.map((entry) => [entry.id, entry]));
    const minutes: readonly RecallMinutesInput[] = state.conferenceMinutes
      .filter((entry) => !entry.tombstone)
      .map((entry) => ({
        id: entry.id,
        conferenceTitle: conferenceTitles.get(entry.conferenceId)?.title ?? "",
        conferenceType: conferenceTitles.get(entry.conferenceId)?.type ?? "",
        summary: entry.summary,
        decisions: entry.decisions,
        outcomeClass: entry.outcomeClass,
      }));
    const work: readonly RecallWorkInput[] = state.work
      .filter((entry) => !entry.tombstone)
      .map((entry) => ({
        id: entry.id,
        externalKey: entry.externalKey,
        kind: entry.kind,
        status: entry.status,
        title: entry.title ?? null,
        summary: entry.summary ?? null,
        scope: workScope(entry),
        labels: entry.labels ?? [],
      }));
    const result = recall({
      cacheKey: resolve(workspace),
      // The storage checkpoint: the chain head the records were replayed from, and the
      // digest of the knowledge answer they were read with. Either one moving is a
      // different corpus, and the index is rebuilt from the rows that actually changed.
      checkpoint: `${state.headEventHash}:${knowledgeDigest}`,
      documents: () => recallDocuments({ knowledge, minutes, work, scopeExcerptBytes }),
      query,
      tau,
      ...(limit === undefined ? {} : { limit }),
    });
    io.write(canonicalJson({
      schemaVersion: "tcrn.recall.v1",
      reasonCode: result.reasonCode,
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      partition,
      at: values.at ?? "",
      knowledgeReasonCode,
      query,
      queryTokens: [...result.tokens],
      // The canonical protocol carries only safe integers, and a bm25 score is not one.
      // These three are spoken the way every numeric setting in this engine is spoken --
      // as a decimal string -- rather than scaled into an integer whose unit a reader
      // would have to be told.
      tau: result.tau.toFixed(4),
      relativeFloor: result.relativeFloor.toFixed(4),
      limit: result.limit,
      scopeExcerptBytes,
      queryLanguage: languageAnswer.queryLanguage,
      queryTranslation: languageAnswer.queryTranslation,
      telemetry: languageAnswer.telemetry,
      indexed: result.indexed,
      rebuilt: result.rebuilt,
      total: result.total,
      records: result.records.map((hit) => ({
        kind: hit.kind, key: hit.key, id: hit.id, status: hit.status,
        title: hit.title, summary: hit.summary, score: hit.score.toFixed(4),
      })),
    }));
    return;
  }
  if (command === "knowledge-checkpoint") {
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    io.write(await exportKnowledgeCheckpoint(values.workspace ?? "", values.at ?? ""));
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
    const values = parseArguments(rest, [...shared, "project-id", "external-key", "kind", "parent-id", "status", "scope", "decided-by", "title", "summary", "labels", "template-receipt", "actor"]);
    // TCRN-CROSS-STORY-363: --title is required on the create path. Measured on the
    // cross-project chain on 2026-09-07, 50 of its 843 live work records carried a
    // title; the other 793 were addressable only by external key, so a listing could
    // show a whole tree and name nothing in it. The protocol keeps title optional --
    // every one of those records still replays -- and the refusal lives here, at the
    // one place a new record is born.
    required(values, [...requiredShared, "project-id", "external-key", "kind", "title"]);
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
      ...(values.title !== undefined ? { title: values.title } : {}),
      ...(values.summary !== undefined ? { summary: values.summary } : {}),
      ...(values.labels !== undefined ? { labels: listValue(values.labels) } : {}),
      ...(values["template-receipt"] !== undefined ? { templateAdmission: jsonValue(values["template-receipt"], "template-receipt") } : {}),
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    const id = deriveStableId("work", canonicalExternalKey(values["external-key"] ?? ""));
    await emitTimeAttestation(io, values, state.headEventHash);
    writeState(io, state, workSummary(state.work.find((entry) => entry.id === id)!));
    return;
  }
  if (command === "work-batch") {
    // STORY-300 slice 3. --from-file rather than an inline argument because a batch is
    // ordinarily generated, and because an argv-sized batch would defeat the point.
    const values = parseArguments(rest, [...shared, "from-file", "actor", "attest-dir"]);
    required(values, [...requiredShared, "from-file"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const { readFileSync } = await import("node:fs");
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(values["from-file"] ?? "", "utf8"));
    } catch (error) {
      fail("WORK_BATCH_MALFORMED", `${values["from-file"] ?? ""}: ${(error as { message?: string }).message ?? "unreadable"}`);
    }
    const members = Array.isArray((document as { members?: unknown }).members) ? (document as { members: unknown[] }).members.length : 0;
    const state = await withLease(workspace, at, async (lease) => applyWorkBatch(workspace, lease, document, {
      expectedVersion: await resolveExpectedVersion(values, workspace),
      occurredAt: at,
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    // One attestation for the batch, not one per member: the specification defines the
    // receipt per mutation, and a batch is one mutation.
    await emitTimeAttestation(io, values, state.headEventHash);
    writeState(io, state, workBatchReceipt(state, members));
    return;
  }
  if (command === "work-transition") {
    const values = parseArguments(rest, [...shared, "id", "status", "summary", "actor"]);
    required(values, [...requiredShared, "id", "status"]);
    if (values.status !== undefined && !isWorkStatus(values.status)) fail("CLI_ARGUMENT_MALFORMED", `status=${values.status}`);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => transitionWork(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace), occurredAt: at, id: values.id ?? "", status: values.status as WorkStatus,
      ...(values.summary !== undefined ? { summary: values.summary } : {}),
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    await emitTimeAttestation(io, values, state.headEventHash);
    const transitioned = state.work.find((entry) => entry.id === (values.id ?? ""))!;
    writeState(io, state, workSummary(transitioned));
    return;
  }
  if (command === "work-annotate") {
    // E05 + INIT-008: attach non-binding advisory fields to a work record. --title,
    // --summary and --labels ride along on the same event and count as moves in their own
    // right since TCRN-CROSS-STORY-363, so what the core still refuses is an annotation
    // that moves nothing at all: it is WORKSPACE_INPUT_INVALID here rather than an
    // appended event no later read can replay (TCRN-CROSS-INC-269).
    const values = parseArguments(rest, [...shared, "id", "scope", "decided-by", "sprint", "title", "summary", "labels", "actor"]);
    required(values, [...requiredShared, "id"]);
    if (values.scope === undefined && values["decided-by"] === undefined && values.sprint === undefined && values.title === undefined && values.summary === undefined && values.labels === undefined) fail("CLI_ARGUMENT_MALFORMED", "annotation-field");
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, async (lease) => annotateWork(workspace, lease, {
      expectedVersion: await resolveExpectedVersion(values, workspace), occurredAt: at, id: values.id ?? "",
      ...(values.scope !== undefined ? { scope: values.scope } : {}),
      ...(values["decided-by"] !== undefined ? { decidedBy: listValue(values["decided-by"]) } : {}),
      ...(values.sprint !== undefined ? { sprint: sprintReference(values.sprint) } : {}),
      ...(values.title !== undefined ? { title: values.title } : {}),
      ...(values.summary !== undefined ? { summary: values.summary } : {}),
      ...(values.labels !== undefined ? { labels: listValue(values.labels) } : {}),
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
    const values = parseArguments(rest, ["workspace", "project-id", "kind", "status", "parent-id", "sprint", "search", "scope-bytes", "limit", "offset"]);
    required(values, ["workspace"]);
    if (values.search !== undefined && (values.search.length === 0 || values.search.length > 256 || !values.search.isWellFormed())) {
      fail("CLI_ARGUMENT_MALFORMED", "search");
    }
    if (values.kind !== undefined && !["Initiative", "Epic", "Story", "Subtask", "Incident", "Release"].includes(values.kind)) fail("CLI_ARGUMENT_MALFORMED", `kind=${values.kind}`);
    if (values.status !== undefined && !isWorkStatus(values.status)) fail("CLI_ARGUMENT_MALFORMED", `status=${values.status}`);
    // INIT-008: filter members of a sprint. The flag carries the qualified reference in the
    // same workspace:<id>#work:<id> spelling used to annotate; we compare the parsed object
    // against the stored advisory:sprint value by canonical bytes so the round trip is closed.
    const sprintFilter = values.sprint === undefined ? undefined : canonicalJson(sprintReference(values.sprint));
    const state = await validateWorkspace(values.workspace ?? "");
    const configuredScopeBytes = state.settings.find((entry) => entry.key === "retrieval.scopeExcerptBytes")?.value;
    const scopeBytes = values["scope-bytes"] === undefined ? Number(configuredScopeBytes ?? "512") : integerValue(values, "scope-bytes");
    if (scopeBytes < 1 || scopeBytes > 65_536) fail("CLI_ARGUMENT_MALFORMED", "scope-bytes");
    const search = values.search?.toLowerCase();
    const records = state.work.filter((entry) => !entry.tombstone &&
      (values["project-id"] === undefined || entry.projectId === values["project-id"]) &&
      (values.kind === undefined || entry.kind === values.kind) &&
      (values.status === undefined || entry.status === values.status) &&
      // TCRN-CROSS-STORY-363: search reaches the four fields a record can be named
      // by. It matched externalKey and scope alone, which meant a keyword present
      // only in the title -- the field a human actually reads -- returned nothing,
      // and the 40 live cross-project records carrying no scope at all (2026-09-07)
      // were reachable by external key and by nothing else.
      (search === undefined || workSearchText(entry).includes(search)) &&
      (sprintFilter === undefined || canonicalJson((entry.extensions["advisory:sprint"] as { readonly value: unknown } | undefined)?.value ?? null) === sprintFilter) &&
      // CQ-05(c2): the null sentinel must be spelled the same on the way in and on the way
      // out. work-create routes --parent-id through nullableValue, which accepts BOTH "-"
      // and the deprecated alias "null"; this filter used a bare === "-" and so treated
      // "null" as a literal parent id. An agent could therefore create a root work item
      // with --parent-id null and then never find it with the identical spelling — a
      // silent wrong answer (total=0), not a cosmetic inconsistency. Sharing nullableValue
      // makes the round trip closed for every spelling the writer accepts, by construction.
      (values["parent-id"] === undefined || (nullableValue(values["parent-id"]) === null ? entry.parentId === null : entry.parentId === values["parent-id"])))
      .map((entry) => search === undefined ? workSummary(entry) : workSearchSummary(entry, scopeBytes));
    io.write(canonicalJson(paginate(state, "work", records, values)));
    return;
  }
  if (command === "work-draft") {
    const values = parseArguments(rest, ["workspace", "kind", "project-id"]);
    required(values, ["workspace", "kind", "project-id"]);
    if (!(values.kind === "Initiative" || values.kind === "Epic" || values.kind === "Story" || values.kind === "Subtask" || values.kind === "Incident" || values.kind === "Release")) {
      fail("CLI_ARGUMENT_MALFORMED", `kind=${values.kind}`);
    }
    const state = await validateWorkspace(values.workspace ?? "");
    if (!state.projects.some((project) => !project.tombstone && project.id === values["project-id"])) {
      fail("WORKSPACE_PROJECT_NOT_FOUND", `project ${values["project-id"] ?? ""} does not exist in this workspace`);
    }
    io.write(canonicalJson(workDraft(state, values.kind, values["project-id"] ?? "")));
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
  //
  // TCRN-CROSS-MIN-102 裁定三 narrows what this path will *mint* without narrowing
  // what the records may *contain*: `assertMintableOutcomeClass` refuses the retired
  // classes here, and everything else — including a garbage value — still travels
  // uncast so the engine keeps answering with its own code. That asymmetry is
  // deliberate: the pass-through contract above is what makes a malformed value
  // diagnosable, and a full CLI whitelist would have taken that away to buy nothing.
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
    const values = parseArguments(rest, [...shared, "conference-id", "minutes-external-key", "summary", "outcome-class", "decisions", "unresolved-issues", "execution-form", "actor", "distill", "accountable-owner-id", "stale-days", "evidence-ids", "language-bundle"]);
    required(values, [...requiredShared, "conference-id", "minutes-external-key", "summary", "outcome-class", "decisions", "unresolved-issues"]);
    assertMintableOutcomeClass("conference-close", values["outcome-class"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const conferenceId = values["conference-id"] ?? "";
    const minutesId = deriveStableId("minutes", canonicalExternalKey(values["minutes-external-key"] ?? ""));
    const distill = booleanValue(values.distill, "distill");
    const distillProviders = languageProvidersFor(values["language-bundle"]);
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
        // TCRN-CROSS-STORY-364 requirement 3: a distilled decision is a card write, so it
        // carries the same answers every other card write carries. The bundle is keyed by
        // the candidate's external key -- the Agent knows those before the close, because
        // distillConferenceKnowledge derives them from the minutes it is about to write.
        const candidateProvider = distillProviders?.get(candidate.externalKey) ?? distillProviders?.get(KNOWLEDGE_LANGUAGE_BUNDLE_FALLBACK_KEY);
        knowledgeUnitIds.push(String((await createKnowledgeUnit(
          workspace,
          candidate,
          candidateProvider === undefined ? {} : { languageProvider: candidateProvider },
        )).id));
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
    assertMintableOutcomeClass("gate-create", values["outcome-class"]);
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
  });
}
