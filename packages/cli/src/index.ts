// SPDX-License-Identifier: Apache-2.0

import {
  acquireWorkspaceLease,
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
  evaluateKnowledgeFreshness,
  exportKnowledgeCheckpoint,
  exportWorkspace,
  generateCorePersonaBundle,
  authorizeGenericProfileOperation,
  generateGenericStarterBundle,
  initializeKnowledgeStore,
  initializeWorkspace,
  listKnowledgeMetadata,
  planWorkspaceMigration,
  readGenericProfileAdmissionReceipt,
  readContextRouteAuthorityReceipt,
  readKnowledgeBody,
  readKnowledgeSnippet,
  rebaseKnowledgeStore,
  recoverWorkspace,
  restoreArtifactArchive,
  resolveGenericProfile,
  routeContext,
  transitionKnowledgePromotion,
  transitionWork,
  updateProject,
  validateKnowledgeStore,
  validateCorePersonaBundle,
  validateContextRouteResult,
  validateGenericStarterBundle,
  validateWorkspace,
  codexAdapterAuthorityEmptyFallback,
  claudeAdapterAuthorityEmptyFallback,
  generateClaudeAdapterBundle,
  generateClaudeAdapterSettingsFragment,
  mergeClaudeAdapterSettingsFragment,
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
  simulateCodexAdapterLifecycle,
  validateCodexAdapterBundle,
  validateCanonicalExchangeBundle,
  validateCompatibilityRequest,
  unavailableCompatibilityCapability,
  readCompatibilityAdmissionReceipt,
  parsePublicAosRequirementsLedger,
  publicAosRequirementsReadback,
  publicAosRequirementsValidReason,
} from "../../core/src/index.js";
import type {
  CodexAdapterHostContext,
  CodexAdapterInstallationFileIdentity,
  ClaudeAdapterHostContext,
  ClaudeAdapterInstallationFileIdentity,
  ExplicitRoot,
  ContextRouteAuthorityFileIdentity,
  GenericProfileAdmissionAuthority,
  KnowledgeCategory,
  KnowledgeFreshnessState,
  KnowledgeKind,
  KnowledgePromotionState,
  CompatibilityAdmissionAuthority,
} from "../../core/src/index.js";
import { canonicalExternalKey, canonicalJson, deriveStableId } from "../../protocol/src/index.js";
import type { PlannedDeliveryKind, ProjectRecord, WorkRecord, WorkStatus } from "../../protocol/src/index.js";

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
  readonly profileAdmissionAuthority?: GenericProfileAdmissionAuthority;
  readonly contextRouteAuthority?: ContextRouteAuthorityFileIdentity;
  readonly codexAdapterHost?: CodexAdapterHostContext;
  readonly codexAdapterInstallationAuthority?: CodexAdapterInstallationFileIdentity;
  readonly claudeAdapterHost?: ClaudeAdapterHostContext;
  readonly claudeAdapterInstallationAuthority?: ClaudeAdapterInstallationFileIdentity;
  readonly compatibilityAdmissionAuthority?: CompatibilityAdmissionAuthority;
}

function fail(reasonCode: string, message: string): never {
  throw new WorkflowCliError(reasonCode, message);
}

function parseArguments(arguments_: readonly string[], allowed: readonly string[]): Readonly<Record<string, string>> {
  if (arguments_.some((value) => value.length > 65_536)) {
    fail("CLI_INPUT_OVERSIZED", "CLI arguments exceed the local input limit");
  }
  const values: Record<string, string> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("CLI_ARGUMENT_MALFORMED", String(flag ?? "missing"));
    }
    const name = flag.slice(2);
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

function workSummary(record: WorkRecord): Readonly<Record<string, string | number | boolean | null>> {
  return { id: record.id, kind: record.kind, status: record.status, projectId: record.projectId, parentId: record.parentId, revision: record.revision, tombstone: record.tombstone };
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

export async function runCli(arguments_: readonly string[], io: CliIo): Promise<void> {
  const command = arguments_[0];
  if (!command || command.startsWith("--")) {
    fail("CLI_COMMAND_REQUIRED", "A governed command is required");
  }
  const rest = arguments_.slice(1);
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
    if (!io.compatibilityAdmissionAuthority) fail("COMPATIBILITY_AUTHORITY_REQUIRED", "governed compatibility admission authority is required");
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
    const values = parseArguments(rest, ["request", "receipt"]);
    required(values, ["request", "receipt"]);
    const admission = await readGenericProfileAdmissionReceipt(values.receipt ?? "",
      io.profileAdmissionAuthority ? { authority: io.profileAdmissionAuthority } : {});
    io.write(canonicalJson(resolveGenericProfile(jsonValue(values.request, "request"), admission)));
    return;
  }
  if (command === "profile-authorize") {
    const values = parseArguments(rest, ["request", "receipt", "operation", "workspace-id", "project-id", "command"]);
    required(values, ["request", "receipt", "operation", "workspace-id", "project-id", "command"]);
    const admission = await readGenericProfileAdmissionReceipt(values.receipt ?? "",
      io.profileAdmissionAuthority ? { authority: io.profileAdmissionAuthority } : {});
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
    const values = parseArguments(rest, ["request", "profile-receipt", "authority"]);
    required(values, ["request", "profile-receipt", "authority"]);
    const profileAdmission = await readGenericProfileAdmissionReceipt(values["profile-receipt"] ?? "",
      io.profileAdmissionAuthority ? { authority: io.profileAdmissionAuthority } : {});
    const contextAuthority = await readContextRouteAuthorityReceipt(values.authority ?? "", io.contextRouteAuthority);
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
  if (command === "adapter-generate") {
    const values = parseArguments(rest, ["request"]);
    required(values, ["request"]);
    io.write(canonicalJson(generateCodexAdapterBundle(jsonValue(values.request, "request"), io.codexAdapterHost)));
    return;
  }
  if (command === "adapter-validate") {
    const values = parseArguments(rest, ["bundle"]);
    required(values, ["bundle"]);
    const bundle = validateCodexAdapterBundle(jsonValue(values.bundle, "bundle"));
    io.write(canonicalJson({ reasonCode: "ADAPTER_VALIDATED", bundleDigest: bundle.bundleDigest, activation: false }));
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
  if (command === "adapter-rollback-plan") {
    const values = parseArguments(rest, ["bundle", "installation-receipt"]);
    required(values, ["bundle", "installation-receipt"]);
    const installation = await readCodexAdapterInstallationReceipt(values["installation-receipt"] ?? "", io.codexAdapterInstallationAuthority);
    io.write(canonicalJson(planCodexAdapterRollback(jsonValue(values.bundle, "bundle"), installation)));
    return;
  }
  if (command === "claude-adapter-generate") {
    const values = parseArguments(rest, ["request"]);
    required(values, ["request"]);
    io.write(canonicalJson(generateClaudeAdapterBundle(jsonValue(values.request, "request"), io.claudeAdapterHost)));
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
  if (command === "claude-adapter-fallback") {
    const values = parseArguments(rest, ["input"]);
    required(values, ["input"]);
    io.write(canonicalJson(claudeAdapterAuthorityEmptyFallback(jsonValue(values.input, "input"))));
    return;
  }
  if (command === "claude-adapter-rollback-plan") {
    const values = parseArguments(rest, ["bundle", "installation-receipt"]);
    required(values, ["bundle", "installation-receipt"]);
    const installation = await readClaudeAdapterInstallationReceipt(values["installation-receipt"] ?? "", io.claudeAdapterInstallationAuthority);
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
      ...(values["segment-events"] ? { segmentEventLimit: Number(values["segment-events"]) } : {}),
    });
    writeState(io, state);
    return;
  }
  if (command === "validate" || command === "status") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    writeState(io, await validateWorkspace(values.workspace ?? ""));
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
    io.write(canonicalJson(await planWorkspaceMigration(values.workspace ?? "", Number(values["target-version"]))));
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
    io.write(canonicalJson(await createKnowledgeUnit(values.workspace ?? "", {
      expectedVersion: expectedVersion(values),
      occurredAt: values.at ?? "",
      externalKey: values["external-key"] ?? "",
      scope: values.scope as "workspace" | "project" | "role",
      projectId: values["project-id"] === "null" ? null : values["project-id"] ?? null,
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
      lastVerified: values["last-verified"] === "null" ? null : values["last-verified"] ?? null,
      stalenessPolicy: { maximumAgeDays: Number(values["stale-days"]), unknownDisposition: "fail-closed" },
      exportDisposition: values.export as "metadata-only" | "excluded",
      body: values.body ?? "",
    })));
    return;
  }
  if (command === "knowledge-list") {
    const values = parseArguments(rest, ["workspace", "at", "selection", "project-id", "role-scope", "category", "kind", "tag", "freshness", "promotion"]);
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
      expectedRevision: Number(values["expected-revision"]),
      occurredAt: values.at ?? "",
      id: values.id ?? "",
      promotionState: values.state as "promoted" | "rejected",
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
  const shared = ["workspace", "expected-version", "at"];
  if (command === "project-create") {
    const values = parseArguments(rest, [...shared, "external-key", "name"]);
    required(values, [...shared, "external-key", "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => createProject(workspace, lease, {
      expectedVersion: expectedVersion(values), occurredAt: at, externalKey: values["external-key"] ?? "", name: values.name ?? "",
    }));
    const id = deriveStableId("project", canonicalExternalKey(values["external-key"] ?? ""));
    writeState(io, state, projectSummary(state.projects.find((entry) => entry.id === id)!));
    return;
  }
  if (command === "project-update") {
    const values = parseArguments(rest, [...shared, "id", "name"]);
    required(values, [...shared, "id", "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => updateProject(workspace, lease, {
      expectedVersion: expectedVersion(values), occurredAt: at, id: values.id ?? "", name: values.name ?? "",
    }));
    writeState(io, state, projectSummary(state.projects.find((entry) => entry.id === (values.id ?? ""))!));
    return;
  }
  if (command === "project-delete") {
    const values = parseArguments(rest, [...shared, "id"]);
    required(values, [...shared, "id"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => deleteProject(workspace, lease, {
      expectedVersion: expectedVersion(values), occurredAt: at, id: values.id ?? "",
    }));
    writeState(io, state, projectSummary(state.projects.find((entry) => entry.id === (values.id ?? ""))!));
    return;
  }
  if (command === "work-create") {
    const values = parseArguments(rest, [...shared, "project-id", "external-key", "kind", "parent-id", "status"]);
    required(values, [...shared, "project-id", "external-key", "kind"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => createWork(workspace, lease, {
      expectedVersion: expectedVersion(values),
      occurredAt: at,
      projectId: values["project-id"] ?? "",
      externalKey: values["external-key"] ?? "",
      kind: values.kind as PlannedDeliveryKind,
      parentId: values["parent-id"] ?? null,
      ...(values.status ? { status: values.status as WorkStatus } : {}),
    }));
    const id = deriveStableId("work", canonicalExternalKey(values["external-key"] ?? ""));
    writeState(io, state, workSummary(state.work.find((entry) => entry.id === id)!));
    return;
  }
  if (command === "work-transition") {
    const values = parseArguments(rest, [...shared, "id", "status"]);
    required(values, [...shared, "id", "status"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => transitionWork(workspace, lease, {
      expectedVersion: expectedVersion(values), occurredAt: at, id: values.id ?? "", status: values.status as WorkStatus,
    }));
    writeState(io, state, workSummary(state.work.find((entry) => entry.id === (values.id ?? ""))!));
    return;
  }
  if (command === "work-delete") {
    const values = parseArguments(rest, [...shared, "id"]);
    required(values, [...shared, "id"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => deleteWork(workspace, lease, {
      expectedVersion: expectedVersion(values), occurredAt: at, id: values.id ?? "",
    }));
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
    const values = parseArguments(rest, ["workspace", "project-id", "kind", "status", "parent-id", "limit", "offset"]);
    required(values, ["workspace"]);
    if (values.kind !== undefined && !["Initiative", "Epic", "Story", "Subtask"].includes(values.kind)) fail("CLI_ARGUMENT_MALFORMED", `kind=${values.kind}`);
    if (values.status !== undefined && !["planned", "ready", "active", "blocked", "done", "cancelled"].includes(values.status)) fail("CLI_ARGUMENT_MALFORMED", `status=${values.status}`);
    const state = await validateWorkspace(values.workspace ?? "");
    const records = state.work.filter((entry) => !entry.tombstone &&
      (values["project-id"] === undefined || entry.projectId === values["project-id"]) &&
      (values.kind === undefined || entry.kind === values.kind) &&
      (values.status === undefined || entry.status === values.status) &&
      (values["parent-id"] === undefined || (values["parent-id"] === "-" ? entry.parentId === null : entry.parentId === values["parent-id"])))
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
    io.write(canonicalJson({
      reasonCode: "WORKSPACE_RECORD_READY",
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      kind: "work",
      record: workSummary(record),
    }));
    return;
  }
  fail("CLI_COMMAND_UNKNOWN", command);
}
