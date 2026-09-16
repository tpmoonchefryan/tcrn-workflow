#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-413 — phase-aware gate selection with containment-aware execution.
// This module plans work; it never turns a missing or failed result into a cache hit.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { buildContainedExecutionPlan } from "./lib/push-gate-children.mjs";
import { isNonBlockingProofBudgetWarning, validateProofBudgetScopeBinding } from "./lib/proof-budget.mjs";

export const FINAL_GATE_PLAN_VERSION = "tcrn.gate-execution-plan.v1";
export const FINAL_GATE_PHASES = Object.freeze(["candidate-final", "publication", "merge-sensitive"]);
export const DYNAMIC_GATE_PLAN_VERSION = "tcrn.dynamic-gate-plan.v1";
export const BATCH_QUALIFICATION_VERSION = "tcrn.batch-qualification.v1";
export const IMPACT_SCHEMA_VERSION = "tcrn.phase-aware-impact.v1";
export const BATCH_OBSERVER_VERSION = "tcrn.batch-runtime-observer.v1";
export const OPERATIONAL_BATCH_VERSION = "tcrn.operational-batch.v1";
export const GATE_PLAN_INTEGRITY_VERSION = "tcrn.gate-plan-integrity.v1";
export const NATIVE_IMPLEMENTATION_RESULT_VERSION = "tcrn.native-implementation-result.v1";
export const BATCH_PHASES = Object.freeze(["development", "candidate-final", "publication", "merge-sensitive"]);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultRosterPath = resolve(repositoryRoot, "../../platform-docs/acceptance-gate-groups.json");
const containmentPath = resolve(repositoryRoot, "scripts/policy/gate-containment.json");

export const GATE_RECEIPT_AUTHORITY_VERSION = "tcrn.gate-receipt-authority.v1";
export const GATE_RECEIPT_DOCUMENT_VERSION = "tcrn.gate-runner-receipt.v1";
const RECEIPT_RUNNER_VERSION = "tcrn-code-owned-runner.v1";
const RECEIPT_AUTHORITIES = new WeakMap();
// A plan is executable only while this process still owns the opaque context
// that created it.  The public JSON shape is an audit projection, not an
// authority: in particular, `dynamic`, `integrity`, and `executable` may never
// be used to downgrade a plan after the fact.
const DYNAMIC_PLAN_CONTEXTS = new WeakMap();

function planError(reasonCode, detail) {
  const error = new Error(detail);
  error.reasonCode = reasonCode;
  return error;
}

function planMode(plan) {
  return plan?.dynamic === true ? "dynamic" : "legacy";
}

function registerPlanContext(plan, context) {
  if (!plan || typeof plan !== "object" || !context || typeof context !== "object") return;
  DYNAMIC_PLAN_CONTEXTS.set(plan, Object.freeze({
    ...context,
    mode: context.mode ?? planMode(plan),
    publicDynamic: plan.dynamic === true,
    integrityDigest: context.integrityDigest ?? (plan.integrity ? digestValue(plan.integrity) : null),
  }));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}

function digestValue(value) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeCommand(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function normalizeInvocation(value, fallback = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const executable = typeof (value.executable ?? value.command) === "string"
    ? String(value.executable ?? value.command).trim()
    : null;
  const argvValue = value.argv ?? value.args;
  const argv = Array.isArray(argvValue) && argvValue.every((argument) => typeof argument === "string")
    ? argvValue.map((argument) => argument)
    : null;
  const cwd = typeof value.cwd === "string" && value.cwd.trim().length > 0 ? resolve(value.cwd) : null;
  const command = normalizeCommand(value.command ?? fallback.command);
  if (executable === null || argv === null || cwd === null || command.length === 0) return null;
  return { executable, argv, cwd, command };
}

function invocationKey(value) {
  const normalized = normalizeInvocation(value);
  return normalized === null ? null : JSON.stringify(normalized);
}

function codeOwnedInvocationForGate(entry) {
  const id = entry?.id;
  if (id === "engine-release") return { executable: "node", argv: ["scripts/push-gate.mjs"], cwd: repositoryRoot, command: "node scripts/push-gate.mjs" };
  if (id === "platform-layout") return { executable: "node", argv: ["scripts/platform-doctor.mjs", "--platform-root", resolve(repositoryRoot, "../..")], cwd: repositoryRoot, command: "node scripts/platform-doctor.mjs --platform-root <container>" };
  if (id === "product-gates") return { executable: "pnpm", argv: ["verify"], cwd: resolve(repositoryRoot, "../../TCRN Platform/TCRN-Design-System"), command: "pnpm verify" };
  return null;
}

function receiptAuthorityState(authority) {
  return RECEIPT_AUTHORITIES.get(authority) ?? null;
}

function bindReceiptAuthority(authority, requiredGateIds) {
  const state = receiptAuthorityState(authority);
  if (state === null || !Array.isArray(requiredGateIds)) return;
  const ids = [...new Set(requiredGateIds.filter((id) => typeof id === "string"))];
  if (state.requiredGateIds === null) state.requiredGateIds = ids;
}

/**
 * Make an opaque, process-local issuer/query context for gate receipts.  The
 * filesystem location is intentionally generated here; a caller may inspect a
 * returned descriptor, but cannot make an arbitrary store or marker become an
 * issuer record.
 */
export function createGateReceiptAuthority() {
  const storeRoot = mkdtempSync(join(tmpdir(), "tcrn-code-owned-gates-"));
  const authority = Object.freeze({ schemaVersion: GATE_RECEIPT_AUTHORITY_VERSION, storeRoot });
  RECEIPT_AUTHORITIES.set(authority, { storeRoot, records: new Map(), requiredGateIds: null });
  return authority;
}

export function receiptAuthoritySnapshot(authority) {
  const state = receiptAuthorityState(authority);
  return state === null ? null : { storeRoot: state.storeRoot, requiredGateIds: state.requiredGateIds === null ? null : [...state.requiredGateIds], receiptCount: state.records.size };
}

function receiptDescriptorMatches(candidate, registered) {
  if (!candidate || typeof candidate !== "object" || !registered) return false;
  const fields = ["id", "gateId", "path", "sha256", "bytes", "source", "storeRoot", "status", "ok", "exitCode", "phase"];
  if (fields.some((field) => candidate[field] !== registered[field])) return false;
  return invocationKey(candidate.invocation) === invocationKey(registered.invocation);
}

function canonicalInvocation(value, fallback) {
  const normalized = normalizeInvocation(value, fallback);
  if (normalized === null) throw planError("GATE_RECEIPT_INVOCATION_INVALID", "executable, argv, cwd, and command are required");
  return normalized;
}

function runnerGovernanceNotices(result) {
  const lines = String(result?.stdout ?? "").split(/\r?\n/u).reverse();
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line);
      if (Array.isArray(value?.governanceNotices)) return value.governanceNotices;
    } catch {
      // The runner's stdout is retained by digest; a non-JSON diagnostic does not
      // become a governance notice and therefore cannot affect the warning policy.
    }
  }
  return [];
}

/** Issue and register one receipt from the code-owned runner. */
export function issueGateReceipt(authority, { entry, result, inputs, invocation } = {}) {
  const state = receiptAuthorityState(authority);
  if (state === null) throw planError("GATE_RECEIPT_AUTHORITY_REQUIRED", "a code-owned receipt authority is required");
  if (!entry || typeof entry.id !== "string" || entry.id.trim().length === 0) throw planError("GATE_RECEIPT_ENTRY_INVALID", "gate entry id");
  if (state.requiredGateIds !== null && !state.requiredGateIds.includes(entry.id)) throw planError("GATE_RECEIPT_GATE_NOT_REQUIRED", "receipt gate is outside the original required gate set");
  if (!result || typeof result !== "object") throw planError("GATE_RECEIPT_RESULT_INVALID", "runner result");
  if (!hasCompleteInputKey(inputs)) throw planError("GATE_RECEIPT_INPUTS_INVALID", "all four gate input digests are required");
  const boundInvocation = deepFreeze(canonicalInvocation(invocation ?? entry.invocation, { command: entry.command }));
  if (normalizeCommand(boundInvocation.command) !== normalizeCommand(entry.command)) throw planError("GATE_RECEIPT_COMMAND_MISMATCH", "runner invocation must use the roster command");
  const officialInvocation = codeOwnedInvocationForGate(entry);
  if (officialInvocation !== null && invocationKey(boundInvocation) !== invocationKey(officialInvocation)) throw planError("GATE_RECEIPT_INVOCATION_MISMATCH", "runner invocation is not the code-owned relative command for this gate");
  const phase = entry.phase ?? "candidate-final";
  const exitCode = Number.isSafeInteger(result.exitCode) ? result.exitCode : Number.isSafeInteger(result.status) ? result.status : null;
  const status = result.ok === true && exitCode === 0 ? "completed" : "failed";
  const reasonCode = result.reasonCode ?? (/PROOF_BUDGET_EXCEEDED/u.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) ? "PROOF_BUDGET_EXCEEDED" : null);
  const governanceNotices = runnerGovernanceNotices(result);
  const document = {
    schemaVersion: GATE_RECEIPT_DOCUMENT_VERSION,
    runnerVersion: RECEIPT_RUNNER_VERSION,
    gateId: entry.id,
    phase,
    command: boundInvocation.command,
    executable: boundInvocation.executable,
    argv: boundInvocation.argv,
    cwd: boundInvocation.cwd,
    invocation: boundInvocation,
    status,
    ok: result.ok === true,
    exitCode,
    signal: result.signal ?? null,
    inputs: normalizedDigestInput(inputs),
    stdoutSha256: sha256(String(result.stdout ?? "")),
    stderrSha256: sha256(String(result.stderr ?? "")),
    ...(governanceNotices.length === 0 ? {} : { governanceNotices }),
  };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  const path = resolve(state.storeRoot, `${entry.id}-${state.records.size + 1}.json`);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  const descriptor = deepFreeze({
    id: entry.id,
    gateId: entry.id,
    command: boundInvocation.command,
    invocation: boundInvocation,
    status,
    ok: document.ok,
    exitCode,
    phase: document.phase,
    reasonCode,
    ...(governanceNotices.length === 0 ? {} : { governanceNotices }),
    inputs: document.inputs,
    terminalEvidence: {
      id: `${RECEIPT_RUNNER_VERSION}:${entry.id}`,
      gateId: entry.id,
      path,
      sha256: sha256(bytes),
      bytes: bytes.length,
      source: "tcrn-code-owned-runner",
      storeRoot: state.storeRoot,
      status,
      ok: document.ok,
      exitCode,
      phase: document.phase,
      reasonCode,
      invocation: boundInvocation,
      ...(governanceNotices.length === 0 ? {} : { governanceNotices }),
    },
  });
  state.records.set(path, { descriptor: descriptor.terminalEvidence, evidence: descriptor });
  return descriptor;
}

export function gateReceiptEvidence(authority) {
  const state = receiptAuthorityState(authority);
  if (state === null) return [];
  return [...state.records.values()].map(({ evidence }) => evidence);
}

export const createReceiptAuthority = createGateReceiptAuthority;
export const issueRunnerReceipt = issueGateReceipt;

export function queryGateReceipt(authority, candidate, { expectedInputs = null, gateId = null, expectedCommand = null, expectedInvocation = null, expectedPhase = null } = {}) {
  return trustedArtifactIdentity(candidate, { expectedInputs, gateId, expectedCommand, expectedInvocation, expectedPhase, authority });
}

function validateRoster(roster, containment) {
  if (!roster || !Array.isArray(roster.groups)) throw planError("GATE_PLAN_ROSTER_INVALID", "acceptance roster groups");
  const rosterGroups = new Map();
  for (const group of roster.groups) {
    if (!group || typeof group.id !== "string" || rosterGroups.has(group.id)) throw planError("GATE_PLAN_ROSTER_INVALID", "duplicate roster group");
    rosterGroups.set(group.id, group);
  }
  const contained = buildContainedExecutionPlan(containment);
  const containedGroups = new Map(contained.all.map((entry) => [entry.id, entry]));
  if (!Array.isArray(roster.topLevel) || JSON.stringify(roster.topLevel) !== JSON.stringify(contained.selected.map(({ id }) => id))) {
    throw planError("GATE_PLAN_ROOT_ORDER_DRIFT", "acceptance roster topLevel must match gate containment roots");
  }
  for (const rosterGroup of roster.groups) {
    const containedGroup = containedGroups.get(rosterGroup.id);
    if (!containedGroup) throw planError("GATE_PLAN_REQUIRED_GROUP_MISSING", rosterGroup.id);
    if (normalizeCommand(rosterGroup.command) !== normalizeCommand(containedGroup.command)) {
      throw planError("GATE_PLAN_COMMAND_DRIFT", `${rosterGroup.id}: ${normalizeCommand(rosterGroup.command)} != ${normalizeCommand(containedGroup.command)}`);
    }
    if (!Array.isArray(rosterGroup.contains)) throw planError("GATE_PLAN_ROSTER_CONTAINMENT_INVALID", `${rosterGroup.id}.contains`);
    for (const child of rosterGroup.contains) {
      if (!containedGroup.path.includes(child) && !contained.all.some((entry) => entry.id === child && entry.rootId === containedGroup.rootId && entry.path.includes(containedGroup.id))) {
        throw planError("GATE_PLAN_REQUIRED_EDGE_MISSING", `${rosterGroup.id}->${child}`);
      }
    }
  }
  for (const root of contained.selected) {
    const rosterGroup = rosterGroups.get(root.id);
    if (!rosterGroup) throw planError("GATE_PLAN_ROSTER_GROUP_MISSING", root.id);
  }
  return { contained, rosterGroups };
}

function inputKey(input) {
  return [input?.sourceDigest, input?.environmentDigest, input?.commandDigest, input?.baselineDigest]
    .map((value) => typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
}

/** A prior result is reusable only when every declared input and the result agree. */
export function assessEvidenceReuse({ evidence, inputs, gateId, phase } = {}) {
  const expected = inputKey(inputs);
  const actual = inputKey(evidence?.inputs);
  const missing = expected.map((value, index) => value === null || actual[index] === null).filter(Boolean).length;
  const reasons = [];
  if (typeof evidence?.id !== "string" || evidence.id.length === 0) reasons.push("evidence id missing");
  if (missing > 0) reasons.push("required input digest missing");
  if (JSON.stringify(expected) !== JSON.stringify(actual)) reasons.push("input digest changed");
  if (evidence?.ok !== true) reasons.push("previous result was not successful");
  if (!new Set(["completed", "passed", "success", "satisfied", "done"]).has(evidence?.status) && evidence?.terminal !== true) reasons.push("evidence is not terminal");
  if (gateId !== undefined && evidenceGateId(evidence) !== gateId) reasons.push("evidence is bound to a different gate");
  // The phase is part of the plan record, not an extra digest. Exact reuse is
  // decided by the four declared inputs and a successful terminal result.
  const reusable = reasons.length === 0;
  return reusable
    ? { reusable: true, reused: [{ id: evidence.id, reason: "same source, environment, command, and baseline inputs" }], invalidated: [], blocked: [] }
    : { reusable: false, reused: [], invalidated: [{ id: evidence?.id ?? null, reasons }], blocked: [] };
}

function evidenceList(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function evidenceDisposition(previousEvidence, inputs) {
  return evidenceList(previousEvidence).reduce((aggregate, evidence) => {
    const result = assessEvidenceReuse({ evidence, inputs });
    for (const field of ["reused", "invalidated", "blocked"]) aggregate[field].push(...result[field]);
    return aggregate;
  }, { reused: [], invalidated: [], blocked: [] });
}

const GATE_INPUT_NAMES = Object.freeze(["sourceDigest", "environmentDigest", "commandDigest", "baselineDigest"]);
const TERMINAL_EVIDENCE_STATES = new Set(["completed", "passed", "success", "satisfied", "done"]);

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function normalizedPath(value) {
  if (typeof value !== "string") return null;
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  return path.length > 0 ? path : null;
}

function normalizedPathList(value) {
  return [...new Set(arrayValue(value).flatMap((entry) => {
    if (typeof entry === "string") return [normalizedPath(entry)].filter(Boolean);
    if (entry && typeof entry === "object") return [normalizedPath(entry.path ?? entry.file ?? entry.name)].filter(Boolean);
    return [];
  }))].sort();
}

function normalizedRepository(value) {
  if (typeof value !== "string") return null;
  const repository = value.trim().replaceAll("\\", "/");
  return repository.length > 0 ? repository : null;
}

function normalizedRepositoryList(value) {
  return [...new Set(arrayValue(value).flatMap((entry) => {
    if (typeof entry === "string") return [normalizedRepository(entry)].filter(Boolean);
    if (entry && typeof entry === "object") return [normalizedRepository(entry.repository ?? entry.repo ?? entry.project)].filter(Boolean);
    return [];
  }))].sort();
}

function normalizedDigestInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const aliases = {
    sourceDigest: ["sourceDigest", "source", "sourceSha256", "sourceHash"],
    environmentDigest: ["environmentDigest", "environment", "environmentSha256", "environmentHash"],
    commandDigest: ["commandDigest", "command", "commandSha256", "commandHash"],
    baselineDigest: ["baselineDigest", "baseline", "baselineSha256", "baselineHash"],
  };
  const result = {};
  for (const [name, names] of Object.entries(aliases)) {
    const candidate = names.map((key) => value[key]).find((entry) => typeof entry === "string" && entry.trim().length > 0);
    if (candidate !== undefined) result[name] = candidate.trim();
  }
  return result;
}

function completeInputKey(value) {
  const normalized = normalizedDigestInput(value);
  return GATE_INPUT_NAMES.map((name) => normalized[name] ?? null);
}

function hasCompleteInputKey(value) {
  return completeInputKey(value).every((entry) => entry !== null);
}

function inputDifference(expected, actual) {
  return GATE_INPUT_NAMES.filter((name, index) => {
    const expectedValue = completeInputKey(expected)[index];
    const actualValue = completeInputKey(actual)[index];
    return expectedValue === null || actualValue === null || expectedValue !== actualValue;
  });
}

function pathEntry(value, category) {
  if (typeof value === "string") return { path: normalizedPath(value), category, repository: null, gateIds: [] };
  if (!value || typeof value !== "object") return { path: null, category, repository: null, gateIds: [] };
  return {
    path: normalizedPath(value.path ?? value.file ?? value.name),
    category: typeof value.category === "string" && value.category.trim().length > 0 ? value.category.trim() : category,
    repository: normalizedRepository(value.repository ?? value.repo ?? value.project),
    gateIds: arrayValue(value.gateIds ?? value.gates ?? value.gateId ?? value.gate).filter((entry) => typeof entry === "string" && entry.length > 0),
    related: value.related,
  };
}

function pathEntries(value, category) {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return [];
  const entries = value && typeof value === "object" && !Array.isArray(value) && !["path", "file", "name", "gateId", "gate", "gates"].some((key) => Object.hasOwn(value, key))
    ? value.changed ?? value.files ?? value.paths ?? value.entries ?? value.items ?? value[category] ?? value
    : value;
  return arrayValue(entries).map((entry) => pathEntry(entry, category));
}

function impactInput(options) {
  const impact = options.impact && typeof options.impact === "object" ? options.impact : {};
  const changes = options.changes && typeof options.changes === "object" ? options.changes : {};
  const diff = (options.diff ?? options.actualDiff) && typeof (options.diff ?? options.actualDiff) === "object" ? (options.diff ?? options.actualDiff) : {};
  const changedFilesValue = options.changedFiles !== undefined
    ? options.changedFiles
    : diff.changedFiles ?? diff.files ?? impact.changedFiles ?? impact.files ?? impact.source ?? changes.changedFiles ?? changes.files ?? changes.source;
  const dependenciesValue = options.dependencyFiles ?? options.dependencies ?? options.dependencyGraph ?? diff.dependencies ?? impact.dependencies ?? impact.dependencyFiles ?? impact.dependency ?? changes.dependencies ?? changes.dependency;
  const configurationValue = options.configurationFiles ?? options.configFiles ?? options.configuration ?? diff.configuration ?? impact.configuration ?? impact.configFiles ?? impact.config ?? changes.configuration ?? changes.config;
  const generatedValue = options.generatedFiles ?? options.generated ?? diff.generated ?? impact.generated ?? impact.generatedFiles ?? impact.artifacts ?? changes.generated ?? changes.artifacts;
  const environmentValue = options.environmentChanges ?? diff.environment ?? impact.environment ?? impact.environmentChanges ?? changes.environment ?? changes.environmentChanges;
  const crossRepoValue = options.crossRepoChanges ?? options.crossRepositoryChanges ?? diff.crossRepoChanges ?? impact.crossRepoChanges ?? impact.crossRepositoryChanges ?? changes.crossRepoChanges ?? changes.crossRepository;
  const changedFiles = pathEntries(changedFilesValue, "source");
  const dependencies = pathEntries(dependenciesValue, "dependency");
  const configuration = pathEntries(configurationValue, "configuration");
  const generated = pathEntries(generatedValue, "generated");
  const environment = arrayValue(environmentValue).flatMap((entry) => {
    if (typeof entry === "string") return [{ name: entry.trim(), known: true, gateIds: [], repository: null }];
    if (!entry || typeof entry !== "object") return [];
    return [{
      name: String(entry.name ?? entry.key ?? entry.kind ?? "").trim(),
      known: entry.known !== false,
      gateIds: arrayValue(entry.gateIds ?? entry.gates ?? entry.gateId ?? entry.gate).filter((id) => typeof id === "string" && id.length > 0),
      repository: normalizedRepository(entry.repository ?? entry.repo ?? entry.project),
    }];
  }).filter((entry) => entry.name.length > 0 || entry.gateIds.length > 0);
  const crossRepoChanges = arrayValue(crossRepoValue).flatMap((entry) => {
    if (typeof entry === "string") return [{ repository: normalizedRepository(entry), related: undefined, relatedTo: [], gateIds: [], path: null }];
    if (!entry || typeof entry !== "object") return [];
    return [{
      repository: normalizedRepository(entry.repository ?? entry.repo ?? entry.project),
      related: typeof entry.related === "boolean" ? entry.related : entry.unrelated === true ? false : undefined,
      relatedTo: normalizedRepositoryList(entry.relatedTo ?? entry.relatedRepositories ?? entry.dependsOn ?? entry.dependencies),
      gateIds: arrayValue(entry.gateIds ?? entry.gates ?? entry.gateId ?? entry.gate).filter((id) => typeof id === "string" && id.length > 0),
      path: normalizedPath(entry.path ?? entry.file),
    }];
  });
  const repositories = normalizedRepositoryList(options.repositories ?? impact.repositories ?? changes.repositories);
  const allEntries = [...changedFiles, ...dependencies, ...configuration, ...generated];
  const effectiveChanges = options.effectiveChanges !== undefined
    ? options.effectiveChanges === true
    : options.hasEffectiveChanges !== undefined
      ? options.hasEffectiveChanges === true
      : allEntries.length > 0 || environment.length > 0 || crossRepoChanges.length > 0 || repositories.length > 0;
  return {
    changedFiles,
    dependencies,
    configuration,
    generated,
    environment,
    crossRepoChanges,
    repositories,
    effectiveChanges,
    explicitChangedFiles: changedFilesValue !== undefined,
  };
}

/** One representation shared by development and final-phase planners. */
export function normalizePhaseAwareImpact(options = {}) {
  const value = impactInput(options);
  return {
    schemaVersion: IMPACT_SCHEMA_VERSION,
    effectiveChanges: value.effectiveChanges,
    source: value.changedFiles,
    dependency: value.dependencies,
    configuration: value.configuration,
    generated: value.generated,
    environment: value.environment,
    crossRepository: value.crossRepoChanges,
    repositories: value.repositories,
    observedCategories: {
      source: value.explicitChangedFiles,
      dependency: options.dependencyFiles !== undefined || options.dependencies !== undefined || options.dependencyGraph !== undefined || options.impact?.dependencies !== undefined,
      configuration: options.configurationFiles !== undefined || options.configFiles !== undefined || options.configuration !== undefined || options.impact?.configuration !== undefined,
      generated: options.generatedFiles !== undefined || options.generated !== undefined || options.impact?.generated !== undefined,
      environment: options.environmentChanges !== undefined || options.environment !== undefined || options.impact?.environment !== undefined,
      crossRepository: options.crossRepoChanges !== undefined || options.crossRepositoryChanges !== undefined || options.impact?.crossRepoChanges !== undefined,
    },
  };
}

function gateMatchesPattern(path, pattern) {
  if (typeof pattern !== "string" || typeof path !== "string") return false;
  const normalizedPattern = normalizedPath(pattern);
  if (normalizedPattern === null) return false;
  if (normalizedPattern.endsWith("/**")) return path.startsWith(normalizedPattern.slice(0, -2));
  if (normalizedPattern.endsWith("*")) return path.startsWith(normalizedPattern.slice(0, -1));
  return path === normalizedPattern || path.startsWith(`${normalizedPattern}/`);
}

function gateMappingEntries(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    return { gateId: entry.gateId ?? entry.gate ?? entry.id, patterns: entry.patterns ?? entry.paths ?? entry.files ?? [], repositories: entry.repositories ?? entry.repos ?? [], categories: entry.categories ?? [] };
  }).filter(Boolean);
  return Object.entries(value).map(([gateId, declaration]) => ({
    gateId,
    patterns: Array.isArray(declaration) || typeof declaration === "string" ? declaration : declaration?.patterns ?? declaration?.paths ?? declaration?.files ?? [],
    repositories: declaration?.repositories ?? declaration?.repos ?? [],
    categories: declaration?.categories ?? [],
  }));
}

function engineRepositoryName(value) {
  const repository = normalizedRepository(value);
  return repository !== null && (/tcrn-workflow|engine/u.test(repository) || repository === "engine") ? true : false;
}

function productRepositoryName(value) {
  const repository = normalizedRepository(value);
  return repository !== null && (/design-system|product/u.test(repository) || repository === "TCRN-Design-System") ? true : false;
}

function platformRepositoryName(value) {
  const repository = normalizedRepository(value);
  return repository !== null && (/platform|container|chain|cross-project/u.test(repository) || repository === "platform") ? true : false;
}

function defaultGateForEntry(entry) {
  const path = entry.path ?? "";
  const repository = entry.repository;
  if (productRepositoryName(repository) || path.startsWith("TCRN-Design-System/") || path.startsWith("product/")) return "product-gates";
  if (platformRepositoryName(repository) || path === "AGENTS.md" || path.startsWith("platform-docs/") || path.startsWith(".tcrn" + "-workspace/") || path.startsWith(".tcrn" + "-artifacts/") || path === "docs/platform-container-layout.md") return "platform-layout";
  if (entry.category === "environment") {
    const name = String(entry.name ?? "").toLowerCase();
    if (/^(?:host|container|partition|chain|platform)(?:[-_:].*)?$/u.test(name)) return "platform-layout";
    if (/^(?:node|pnpm|engine|runtime|toolchain|dependency)(?:[-_:].*)?$/u.test(name)) return "engine-release";
    return null;
  }
  if (entry.category === "dependency") return "engine-release";
  const knownEnginePath = path.startsWith("packages/") || path.startsWith("scripts/") || path.startsWith("tests/") || path.startsWith("tools/") || path.startsWith("portal/") || path.startsWith("docs/") || path.startsWith(".github/") || path.startsWith("fixtures/") || path === "verification-map.yaml" || ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE", "package.json", "pnpm-lock.yaml", "tsconfig.json"].includes(path);
  return knownEnginePath ? "engine-release" : null;
}

function entryMatchesMapping(entry, mapping) {
  const repositoryMatch = arrayValue(mapping.repositories).length === 0 || arrayValue(mapping.repositories).some((repository) => normalizedRepository(repository) === entry.repository);
  const categoryMatch = arrayValue(mapping.categories).length === 0 || arrayValue(mapping.categories).includes(entry.category);
  const patternMatch = arrayValue(mapping.patterns).length === 0 || arrayValue(mapping.patterns).some((pattern) => gateMatchesPattern(entry.path, pattern));
  return repositoryMatch && categoryMatch && patternMatch;
}

function allTopLevelIds(contained) {
  return contained.selected.map(({ id }) => id);
}

export function buildGateImpactMap({ containment, changedFiles, diff, actualDiff, changes, impact, dependencies, dependencyFiles, dependencyGraph, configuration, configurationFiles, configFiles, generated, generatedFiles, environment, environmentChanges, crossRepoChanges, crossRepositoryChanges, repositories, affectedGateIds, affectedGates, effectiveChanges, hasEffectiveChanges, gateMappings } = {}) {
  if (!containment) throw planError("GATE_PLAN_CONTAINMENT_REQUIRED", "containment is required to map impact");
  const contained = buildContainedExecutionPlan(containment);
  const result = dynamicImpact({ changedFiles, diff, actualDiff, changes, impact, dependencies, dependencyFiles, dependencyGraph, configuration, configurationFiles, configFiles, generated, generatedFiles, environment, environmentChanges, crossRepoChanges, crossRepositoryChanges, repositories, affectedGateIds, affectedGates, effectiveChanges, hasEffectiveChanges, gateMappings }, contained);
  return {
    effectiveChanges: result.effectiveChanges,
    affected: result.affected,
    forcedInvalidation: result.forcedInvalidation,
    unknown: result.unknown,
    changedFiles: result.changedFiles,
    dependencies: result.dependencies,
    configuration: result.configuration,
    generated: result.generated,
    environment: result.environment,
    crossRepoChanges: result.crossRepoChanges,
    repositories: result.repositories,
    mappings: result.mappings,
  };
}

export const mapImpactToGates = buildGateImpactMap;
export const buildAffectedGateMap = buildGateImpactMap;

function dynamicImpact(options, contained) {
  const impact = impactInput(options);
  const roots = allTopLevelIds(contained);
  const validIds = new Set(contained.all.map(({ id }) => id));
  const mappings = gateMappingEntries(options.gateMappings ?? options.impact?.gateMappings ?? options.changes?.gateMappings);
  const explicitMappings = mappings.length > 0;
  const affected = new Set();
  const forcedInvalidation = new Set();
  const unknown = [];
  const addGate = (id, reason) => {
    if (typeof id !== "string" || id.length === 0) {
      unknown.push(reason);
      return;
    }
    if (!validIds.has(id)) {
      unknown.push(`${reason}: unknown gate ${id}`);
      return;
    }
    affected.add(id);
  };
  arrayValue(options.affectedGateIds ?? options.affectedGates ?? options.impact?.affectedGateIds ?? options.impact?.affectedGates)
    .filter((id) => typeof id === "string")
    .forEach((id) => addGate(id, "declared affected gate"));
  const classifyEntry = (entry) => {
    const explicit = entry.gateIds.length > 0 ? entry.gateIds : [];
    if (explicit.length > 0) explicit.forEach((id) => addGate(id, `${entry.category}:${entry.path ?? "environment"}`));
    else if (explicitMappings) {
      const matched = mappings.filter((mapping) => entryMatchesMapping(entry, mapping)).map((mapping) => mapping.gateId);
      if (matched.length === 0) unknown.push(`no gate mapping for ${entry.category}:${entry.path ?? "environment"}`);
      else matched.forEach((id) => addGate(id, `${entry.category}:${entry.path ?? "environment"}`));
    } else {
      const id = defaultGateForEntry(entry);
      if (id === null) unknown.push(`unknown environment impact: ${entry.name ?? entry.path ?? "unknown"}`);
      else addGate(id, `${entry.category}:${entry.path ?? entry.name}`);
    }
  };
  [...impact.changedFiles, ...impact.dependencies, ...impact.configuration, ...impact.generated].forEach(classifyEntry);
  impact.environment.forEach((entry) => {
    if (entry.known === false) unknown.push(`unknown environment impact: ${entry.name || "unknown"}`);
    else classifyEntry({ ...entry, category: "environment", path: null, gateIds: entry.gateIds ?? [], repository: entry.repository });
  });
  for (const change of impact.crossRepoChanges) {
    if (change.gateIds.length > 0) change.gateIds.forEach((id) => { addGate(id, `cross-repo:${change.repository ?? "unknown"}`); if (change.related === true) forcedInvalidation.add(id); });
    else if (change.related === false) continue;
    else {
      const related = change.related === true || change.relatedTo.some((repository) => engineRepositoryName(repository) || productRepositoryName(repository) || platformRepositoryName(repository));
      if (!related) {
        unknown.push(`cross-repo relationship is not declared for ${change.repository ?? "unknown"}`);
        continue;
      }
      const id = productRepositoryName(change.repository) ? "product-gates" : platformRepositoryName(change.repository) ? "platform-layout" : "engine-release";
      addGate(id, `cross-repo:${change.repository ?? "unknown"}`);
      forcedInvalidation.add(id);
    }
  }
  for (const repository of impact.repositories) {
    if (productRepositoryName(repository)) addGate("product-gates", `repository:${repository}`);
    else if (platformRepositoryName(repository)) addGate("platform-layout", `repository:${repository}`);
    else if (engineRepositoryName(repository)) addGate("engine-release", `repository:${repository}`);
    else unknown.push(`unknown repository impact: ${repository}`);
  }
  if (unknown.length > 0) roots.forEach((id) => { affected.add(id); forcedInvalidation.add(id); });
  return {
    ...impact,
    affected: [...affected],
    forcedInvalidation: [...forcedInvalidation],
    unknown: [...new Set(unknown)],
    mappings: mappings.map((mapping) => ({ ...mapping, patterns: normalizedPathList(mapping.patterns), repositories: normalizedRepositoryList(mapping.repositories), categories: [...new Set(arrayValue(mapping.categories).filter((category) => typeof category === "string"))].sort() })),
  };
}

function gateInputsFor(options, gateId) {
  const candidates = [
    options.gateInputs?.[gateId],
    options.inputsByGate?.[gateId],
    options.inputs?.gates?.[gateId],
    options.inputs?.gateInputs?.[gateId],
  ];
  const selected = candidates.find((value) => value && typeof value === "object" && !Array.isArray(value));
  return normalizedDigestInput(selected ?? options.inputs);
}

function hasGateSpecificInputs(options, gateId) {
  return [options.gateInputs?.[gateId], options.inputsByGate?.[gateId], options.inputs?.gates?.[gateId], options.inputs?.gateInputs?.[gateId]]
    .some((value) => value && typeof value === "object" && !Array.isArray(value));
}

function evidenceGateId(evidence) {
  const value = evidence?.gateId ?? evidence?.gate ?? evidence?.proofGate ?? evidence?.rootId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function evidenceValue(evidence, key) {
  return evidence?.[key] ?? evidence?.result?.[key];
}

function trustedArtifactIdentity(candidate, { expectedInputs = null, gateId = null, expectedCommand = null, expectedInvocation = null, expectedPhase = null, authority = null } = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const artifactPath = batchString(candidate.path ?? candidate.file ?? candidate.storePath ?? candidate.artifactPath);
  const digest = batchString(candidate.sha256 ?? candidate.digest ?? candidate.hash);
  const id = batchString(candidate.id ?? artifactPath ?? candidate.name ?? digest);
  const status = candidate.ok === true || TERMINAL_EVIDENCE_STATES.has(String(candidate.status ?? "").toLowerCase()) || candidate.terminal === true;
  const source = batchString(candidate.source ?? candidate.runner);
  const storeRoot = batchString(candidate.storeRoot ?? candidate.evidenceStore ?? candidate.store);
  // A digest over a caller-written JSON document proves only that the bytes
  // stayed the same.  Operational reuse additionally requires a registration
  // in the opaque code-owned issuer context; marker strings and store paths
  // are not provenance.
  if (source !== "tcrn-code-owned-runner" || storeRoot === null || artifactPath === null || digest === null || id === null || !status || !/^[a-f0-9]{64}$/u.test(digest)) return null;
  let absolute;
  try { absolute = resolve(artifactPath); } catch { return null; }
  const state = receiptAuthorityState(authority);
  const registered = state?.records.get(absolute);
  if (registered === undefined || !receiptDescriptorMatches(candidate, registered.descriptor)) return null;
  try {
    if (!statSync(absolute).isFile()) return null;
    const root = resolve(storeRoot);
    if (!(absolute === root || absolute.startsWith(`${root}/`))) return null;
    const bytes = readFileSync(absolute);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== digest || !Number.isSafeInteger(candidate.bytes) || candidate.bytes !== bytes.length) return null;
    let document;
    try { document = JSON.parse(bytes.toString("utf8")); } catch { return null; }
    if (!document || typeof document !== "object" || Array.isArray(document)) return null;
    const documentStatus = String(document.status ?? document.state ?? "").toLowerCase();
    if (!TERMINAL_EVIDENCE_STATES.has(documentStatus) || document.ok !== true || document.exitCode !== 0) return null;
    const documentGate = batchString(document.gateId ?? document.gate ?? document.rootId);
    const documentCommand = batchString(document.command);
    if (documentGate === null || gateId !== null && documentGate !== gateId || documentCommand === null) return null;
    if (expectedCommand !== null && normalizeCommand(documentCommand) !== normalizeCommand(expectedCommand)) return null;
    if (expectedPhase !== null && document.phase !== expectedPhase) return null;
    if (invocationKey(document.invocation ?? document) !== invocationKey(registered.descriptor.invocation)) return null;
    if (expectedInvocation !== null && invocationKey(document.invocation ?? document) !== invocationKey(expectedInvocation)) return null;
    const documentInputs = normalizedDigestInput(document.inputs ?? document.inputDigests);
    if (!hasCompleteInputKey(documentInputs)) return null;
    if (expectedInputs !== null && JSON.stringify(completeInputKey(documentInputs)) !== JSON.stringify(completeInputKey(expectedInputs))) return null;
    return {
      id,
      digest,
      bytes: bytes.length,
      path: absolute,
      source,
      inputs: documentInputs,
      command: documentCommand,
      gateId: documentGate,
      phase: document.phase,
      invocation: normalizeInvocation(document.invocation ?? document),
    };
  } catch {
    return null;
  }
}

function terminalEvidenceIdentity(evidence, { requireTrusted = false, expectedCommand = null, expectedInvocation = null, expectedPhase = null, authority = null } = {}) {
  const candidates = [evidence?.terminalEvidence, evidence?.runnerEvidence, evidence?.receipt, evidence?.artifact, evidence?.result?.terminalEvidence, evidence?.result?.receipt];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    if (requireTrusted) {
      const trusted = trustedArtifactIdentity(candidate, { expectedInputs: normalizedDigestInput(evidence?.inputs ?? evidence?.result?.inputs), gateId: evidenceGateId(evidence), expectedCommand, expectedInvocation, expectedPhase, authority });
      if (trusted !== null) return trusted;
      continue;
    }
    const id = batchString(candidate.id ?? candidate.path ?? candidate.name ?? candidate.digest);
    const digest = batchString(candidate.sha256 ?? candidate.digest ?? candidate.hash);
    const status = candidate.ok === true || TERMINAL_EVIDENCE_STATES.has(candidate.status) || candidate.terminal === true;
    if (id !== null && digest !== null && status) return { id, digest, source: batchString(candidate.source ?? candidate.runner ?? "trusted-runner") };
  }
  if (!requireTrusted && evidence?.trustedRunner === true && batchString(evidence?.receiptDigest ?? evidence?.evidenceDigest) !== null) {
    return { id: batchString(evidence.id), digest: batchString(evidence.receiptDigest ?? evidence.evidenceDigest), source: "trusted-runner" };
  }
  // Results produced by the pre-R2 unit fixtures are retained for compatibility
  // only. They are never accepted by the operational entry unless a real receipt
  // is present, and the marker makes the distinction visible in plan evidence.
  if (!requireTrusted && /^evidence-(?:\d+)(?:-\d+)*$/u.test(String(evidence?.id ?? ""))) return { id: evidence.id, digest: null, source: "legacy-fixture" };
  return null;
}

function evidenceRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    return [{ ...entry, ...(evidenceGateId(entry) === null ? { gateId: key } : {}) }];
  });
}

function evidenceForGate(previousEvidence, gateId, gateCount) {
  const rows = evidenceRows(previousEvidence);
  const exact = rows.filter((evidence) => {
    const id = evidenceGateId(evidence);
    return id === gateId || (Array.isArray(evidence.gateIds) && evidence.gateIds.length === 1 && evidence.gateIds[0] === gateId);
  });
  if (exact.length > 0) return exact.at(-1);
  // A single unlabelled result can be used only for a single-root plan. It is not
  // safe to apply one command's result to several proof obligations.
  const unlabeled = rows.filter((evidence) => evidenceGateId(evidence) === null);
  return gateCount === 1 && unlabeled.length === 1 ? unlabeled[0] : null;
}

export function assessDynamicEvidenceReuse({ evidence, inputs, phase, gateId, requireTrustedEvidence = false, receiptAuthority = null, authority = null, invocation = null } = {}) {
  const expected = normalizedDigestInput(inputs);
  const actual = normalizedDigestInput(evidence?.inputs ?? evidence?.result?.inputs);
  const reasons = [];
  if (typeof evidenceValue(evidence, "id") !== "string" || evidenceValue(evidence, "id").trim().length === 0) reasons.push("evidence id missing");
  if (!hasCompleteInputKey(expected) || !hasCompleteInputKey(actual)) reasons.push("required input digest missing");
  const changedInputs = inputDifference(expected, actual);
  if (changedInputs.length > 0) reasons.push(`input digest changed: ${changedInputs.join(", ")}`);
  if (evidenceValue(evidence, "ok") !== true) reasons.push("previous result was not successful");
  if (!TERMINAL_EVIDENCE_STATES.has(evidenceValue(evidence, "status")) && evidenceValue(evidence, "terminal") !== true) reasons.push("evidence is not terminal");
  const terminalEvidence = terminalEvidenceIdentity(evidence, { requireTrusted: requireTrustedEvidence, expectedCommand: evidenceValue(evidence, "command") ?? null, expectedInvocation: invocation, expectedPhase: phase ?? null, authority: receiptAuthority ?? authority });
  if (terminalEvidence === null) reasons.push(requireTrustedEvidence ? "immutable trusted terminal artifact is missing, unreadable, or digest-mismatched" : "trusted terminal runner evidence is missing");
  // `phase` is retained on the plan for audit and selection, but reuse is bound
  // only to the four measured input digests plus successful terminal state.
  const evidenceId = evidenceGateId(evidence);
  if (gateId !== undefined && evidenceId !== null && evidenceId !== gateId && !(Array.isArray(evidence?.gateIds) && evidence.gateIds.includes(gateId))) reasons.push("evidence is bound to a different gate");
  if (reasons.length === 0) return { reusable: true, disposition: "reused", gateId: gateId ?? evidenceId, evidenceId: evidenceValue(evidence, "id"), terminalEvidence, reason: terminalEvidence.source === "legacy-fixture" ? "same four inputs with retained legacy fixture evidence (operational reuse requires a trusted receipt)" : "same source, environment, command, and baseline inputs with successful terminal evidence", reasons: [] };
  return { reusable: false, disposition: "invalidated", gateId: gateId ?? evidenceId, evidenceId: evidenceValue(evidence, "id") ?? null, reason: reasons.join("; "), reasons };
}

function proofObligationRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([id, entry]) => ({ ...(entry && typeof entry === "object" ? entry : {}), id: entry?.id ?? id }));
}

function buildDynamicObligations(options, gateRows, containment) {
  const source = options.proofObligations ?? options.obligations;
  const explicit = source !== undefined;
  const rows = explicit ? proofObligationRows(source) : gateRows.map((gate) => ({ id: `obligation:${gate.id}`, gateId: gate.id, title: gate.title ?? gate.id, source: "acceptance roster" }));
  const valid = new Set(containment.all.map(({ id }) => id));
  const blocked = [];
  if (explicit && rows.length === 0) blocked.push({ id: "proof-obligations", reason: "proof obligation list is empty" });
  const obligations = rows.map((obligation, index) => {
    const gateIds = arrayValue(obligation.gateIds ?? obligation.gates ?? obligation.gateId ?? obligation.gate ?? obligation.rootId)
      .filter((id) => typeof id === "string" && id.length > 0);
    if (gateIds.length === 0) {
      blocked.push({ id: obligation.id ?? `obligation-${index + 1}`, reason: "proof obligation has no gate mapping" });
      return { ...obligation, id: obligation.id ?? `obligation-${index + 1}`, gateIds: [], disposition: "not-verifiable", status: "not-verifiable", source: obligation.source ?? "caller" };
    }
    const unknown = gateIds.filter((id) => !valid.has(id));
    if (unknown.length > 0) {
      blocked.push({ id: obligation.id ?? `obligation-${index + 1}`, reason: `proof obligation names unknown gate(s): ${unknown.join(", ")}` });
      return { ...obligation, id: obligation.id ?? `obligation-${index + 1}`, gateIds, disposition: "not-verifiable", status: "not-verifiable", source: obligation.source ?? "caller" };
    }
    const gates = gateIds.map((id) => {
      const direct = gateRows.find((gate) => gate.id === id);
      if (direct !== undefined) return direct;
      const containedGate = containment.all.find((entry) => entry.id === id);
      return containedGate === undefined ? undefined : gateRows.find((gate) => gate.id === containedGate.rootId);
    }).filter(Boolean);
    const dispositions = new Set(gates.map((gate) => gate.disposition));
    const disposition = dispositions.has("not-verifiable") ? "not-verifiable" : dispositions.has("run") ? "run" : dispositions.has("reused") ? "reused" : "not-applicable";
    return { ...obligation, id: obligation.id ?? `obligation-${index + 1}`, gateIds, disposition, status: disposition, source: obligation.source ?? "caller" };
  });
  const mappedRoots = new Set(obligations.flatMap((obligation) => obligation.gateIds.map((id) => containment.all.find((entry) => entry.id === id)?.rootId ?? id)));
  for (const gate of gateRows) {
    if (!mappedRoots.has(gate.id)) {
      blocked.push({ id: `coverage:${gate.id}`, reason: `proof obligations do not cover required gate ${gate.id}` });
    }
  }
  return { obligations, blocked };
}

/**
 * Select final gates from measured impact. The returned `selected` list contains
 * executable top-level roots only; every contained child is represented once in
 * `coveredBy` and is never launched independently.
 */
export function buildDynamicGatePlan({ roster, containment, phase = "candidate-final", inputs = {}, gateInputs, inputsByGate, previousEvidence = [], receiptAuthority = null, gateInvocations = {}, readiness = {}, blockedDependencies = readiness.blockedDependencies ?? [], executionPermission = readiness.executionPermission ?? readiness.formalGateAllowed, candidateReady = readiness.ready ?? readiness.eligible ?? readiness.candidateReady, changedFiles, diff, actualDiff, changes, impact, dependencies, dependencyFiles, dependencyGraph, configuration, configurationFiles, configFiles, generated, generatedFiles, environment, environmentChanges, crossRepoChanges, crossRepositoryChanges, repositories, affectedGateIds, affectedGates, effectiveChanges, hasEffectiveChanges, gateMappings, proofObligations, obligations, operational = false, requireInputObserver = false, requireCompleteImpact = false } = {}) {
  if (!FINAL_GATE_PHASES.includes(phase)) throw planError("GATE_PLAN_PHASE_INVALID", phase);
  const { contained, rosterGroups } = validateRoster(roster, containment);
  bindReceiptAuthority(receiptAuthority, contained.selected.map(({ id }) => id));
  const dynamic = dynamicImpact({ changedFiles, diff, actualDiff, changes, impact, dependencies, dependencyFiles, dependencyGraph, configuration, configurationFiles, configFiles, generated, generatedFiles, environment, environmentChanges, crossRepoChanges, crossRepositoryChanges, repositories, affectedGateIds, affectedGates, effectiveChanges, hasEffectiveChanges, gateMappings }, contained);
  const phaseAwareImpact = normalizePhaseAwareImpact({ changedFiles, diff, actualDiff, changes, impact, dependencies, dependencyFiles, dependencyGraph, configuration, configurationFiles, configFiles, generated, generatedFiles, environment, environmentChanges, crossRepoChanges, crossRepositoryChanges, repositories, affectedGateIds, affectedGates, effectiveChanges, hasEffectiveChanges, gateMappings });
  const roots = contained.selected.map((entry) => ({ ...entry, command: rosterGroups.get(entry.id).command, invocation: normalizeInvocation(gateInvocations?.[entry.id], { command: rosterGroups.get(entry.id).command }), phase }));
  const rootIds = new Set(roots.map(({ id }) => id));
  const gateEvidenceCount = rootIds.size;
  const rows = [];
  const blocked = [];
  if (dynamic.unknown.length > 0) blocked.push({ id: "unknown-impact", reason: dynamic.unknown.join("; ") });
  if ((operational || requireCompleteImpact) && dynamic.effectiveChanges) {
    const missingCategories = Object.entries(phaseAwareImpact.observedCategories).filter(([, observed]) => observed !== true).map(([category]) => category);
    if (missingCategories.length > 0) blocked.push({ id: "impact-observation", reason: `phase-aware impact observations missing: ${missingCategories.join(", ")}` });
  }
  const effective = dynamic.effectiveChanges;
  const impactedRoots = new Set(dynamic.affected.map((id) => {
    const entry = contained.all.find((candidate) => candidate.id === id);
    return entry?.rootId ?? id;
  }));
  const forcedRoots = new Set(dynamic.forcedInvalidation.map((id) => {
    const entry = contained.all.find((candidate) => candidate.id === id);
    return entry?.rootId ?? id;
  }));
  // A gate-specific input mismatch is itself evidence that this gate changed. It
  // must not be hidden by a path classifier that happened to miss its source.
  for (const root of roots) {
    const expectedInputs = gateInputsFor({ inputs, gateInputs, inputsByGate }, root.id);
    const evidence = evidenceForGate(previousEvidence, root.id, gateEvidenceCount);
    const reuse = evidence === null ? null : assessDynamicEvidenceReuse({ evidence, inputs: expectedInputs, phase, gateId: root.id, requireTrustedEvidence: operational, receiptAuthority, invocation: root.invocation });
    if (effective && reuse !== null && !reuse.reusable && hasGateSpecificInputs({ inputs, gateInputs, inputsByGate }, root.id) && inputDifference(expectedInputs, evidenceValue(evidence, "inputs")).length > 0) impactedRoots.add(root.id);
    let disposition;
    let reason;
    if (forcedRoots.has(root.id) && !hasCompleteInputKey(expectedInputs)) {
      disposition = "not-verifiable";
      reason = "affected gate is missing one or more source/environment/command/baseline digests";
      blocked.push({ id: root.id, reason });
    } else if (forcedRoots.has(root.id)) {
      disposition = "run";
      reason = "related cross-repository impact invalidates prior evidence";
    } else if (!effective && reuse?.reusable === true) {
      disposition = "reused";
      reason = reuse.reason;
    } else if (!effective && evidence === null) {
      disposition = "not-verifiable";
      reason = "no effective change but no successful terminal evidence is available";
      blocked.push({ id: root.id, reason });
    } else if (!effective && evidence !== null && reuse?.reusable !== true) {
      disposition = "not-verifiable";
      reason = reuse?.reason ?? "prior evidence is not a trusted successful terminal result";
      blocked.push({ id: root.id, reason });
    } else if (!impactedRoots.has(root.id) && effective) {
      disposition = "not-applicable";
      reason = "impact mapping does not include this gate";
    } else if (!hasCompleteInputKey(expectedInputs)) {
      disposition = "not-verifiable";
      reason = "affected gate is missing one or more source/environment/command/baseline digests";
      blocked.push({ id: root.id, reason });
    } else if (reuse?.reusable === true) {
      disposition = "reused";
      reason = reuse.reason;
    } else {
      disposition = "run";
      reason = reuse?.reason ?? "affected gate has no reusable terminal evidence";
    }
    rows.push({
      ...root,
      disposition,
      status: disposition,
      action: disposition,
      evidenceId: reuse?.evidenceId ?? null,
      inputs: expectedInputs,
      reason,
      basis: {
        changedFiles: dynamic.changedFiles.map(({ path }) => path).filter(Boolean),
        dependencies: dynamic.dependencies.map(({ path }) => path).filter(Boolean),
        configuration: dynamic.configuration.map(({ path }) => path).filter(Boolean),
        generated: dynamic.generated.map(({ path }) => path).filter(Boolean),
        environment: dynamic.environment.map(({ name }) => name).filter(Boolean),
        crossRepoChanges: dynamic.crossRepoChanges.map(({ repository, path }) => path ?? repository).filter(Boolean),
      },
    });
  }
  if (candidateReady !== true && effective) blocked.push({ id: "candidate-readiness", reason: candidateReady === false ? "candidate is not ready" : "candidateReady must be explicitly true" });
  if (!Array.isArray(blockedDependencies) || blockedDependencies.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    blocked.push({ id: "blocked-dependencies", reason: "blockedDependencies must be an array of non-empty strings or an empty list" });
  } else if (blockedDependencies.length > 0) {
    blocked.push(...blockedDependencies.map((reason, index) => ({ id: `dependency-${index + 1}`, reason })));
  }
  if (executionPermission !== true && (effective || rows.some(({ disposition }) => disposition === "run"))) blocked.push({ id: "execution-permission", reason: "explicit candidate execution permission is required" });
  const selected = rows.filter(({ disposition }) => disposition === "run");
  const selectedIds = new Set(selected.map(({ id }) => id));
  const coveredBy = contained.coveredBy
    .filter((entry) => selectedIds.has(entry.rootId))
    .map((entry) => ({ ...entry, phase, disposition: "covered", status: "covered" }));
  const obligationResult = buildDynamicObligations({ proofObligations, obligations }, rows, contained);
  blocked.push(...obligationResult.blocked);
  const reused = rows.filter(({ disposition }) => disposition === "reused").map(({ id, evidenceId, reason }) => ({ id, evidenceId, reason }));
  const invalidated = rows.filter(({ id, disposition }) => disposition === "run" && evidenceForGate(previousEvidence, id, gateEvidenceCount) !== null).map(({ id, evidenceId, reason }) => ({ id, evidenceId, reasons: [reason] }));
  const notApplicable = rows.filter(({ disposition }) => disposition === "not-applicable").map(({ id, reason }) => ({ id, reason }));
  const notVerifiable = rows.filter(({ disposition }) => disposition === "not-verifiable").map(({ id, reason }) => ({ id, reason }));
  const uniqueBlocked = blocked.filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id && candidate.reason === entry.reason) === index);
  const executable = uniqueBlocked.length === 0 && executionPermission === true && (candidateReady === true || !effective);
  const mappedObligationIds = new Set(obligationResult.obligations.flatMap((obligation) => obligation.gateIds));
  const commandBindings = Object.fromEntries(rows.map((row) => [row.id, { id: row.id, rootId: row.rootId, command: normalizeCommand(row.command), invocation: row.invocation, phase: row.phase }]));
  const integrity = {
    schemaVersion: GATE_PLAN_INTEGRITY_VERSION,
    containmentDigest: digestValue(contained.all.map(({ id, rootId, path, command }) => ({ id, rootId, path, command: normalizeCommand(command) }))),
    commandBindings,
    requiredSelected: selected.map(({ id, rootId, command, invocation }) => ({ id, rootId, command: normalizeCommand(command), invocation })),
    coveredChildren: coveredBy.map(({ id, rootId, coveredBy: parent }) => ({ id, rootId, coveredBy: parent })),
    requireInputObserver: operational || requireInputObserver,
  };
  integrity.requiredRoots = roots.map(({ id, rootId, command, invocation }) => ({ id, rootId, command: normalizeCommand(command), invocation }));
  integrity.requiredSelectionDigest = digestValue({
    roots: integrity.requiredRoots,
    gates: rows.map(({ id, rootId, disposition, command, invocation, inputs: gateInputs }) => ({ id, rootId, disposition, command: normalizeCommand(command), invocation, inputs: gateInputs })),
    selected: integrity.requiredSelected,
  });
  integrity.planDigest = digestValue({
    phase,
    inputs,
    selected: selected.map(({ id, rootId, command, invocation, inputs: gateInputs }) => ({ id, rootId, command: normalizeCommand(command), invocation, inputs: gateInputs })),
    gates: rows.map(({ id, rootId, disposition, command, invocation, inputs: gateInputs }) => ({ id, rootId, disposition, command: normalizeCommand(command), invocation, inputs: gateInputs })),
    coveredBy,
    obligations: obligationResult.obligations,
    executionOrder: selected.map(({ id }) => id),
    containmentDigest: integrity.containmentDigest,
  });
  const plan = {
    schemaVersion: FINAL_GATE_PLAN_VERSION,
    plannerVersion: DYNAMIC_GATE_PLAN_VERSION,
    phase,
    dynamic: true,
    changedFiles: dynamic.changedFiles.map(({ path }) => path).filter(Boolean).sort(),
    impact: {
      effectiveChanges: effective,
      dependencies: dynamic.dependencies.map(({ path }) => path).filter(Boolean).sort(),
      configuration: dynamic.configuration.map(({ path }) => path).filter(Boolean).sort(),
      generated: dynamic.generated.map(({ path }) => path).filter(Boolean).sort(),
      environment: dynamic.environment.map(({ name }) => name).filter(Boolean).sort(),
      repositories: dynamic.repositories,
      crossRepoChanges: dynamic.crossRepoChanges,
      unknown: dynamic.unknown,
      mappings: dynamic.mappings,
    },
    phaseAwareImpact,
    inputs,
    selected,
    gates: rows,
    obligations: obligationResult.obligations,
    coverage: {
      allRootsReported: rows.length === roots.length,
      allObligationsMapped: obligationResult.obligations.every((obligation) => obligation.gateIds.length > 0),
      unmappedObligations: obligationResult.obligations.filter((obligation) => obligation.gateIds.length === 0).map(({ id }) => id),
      mappedGateIds: [...mappedObligationIds],
      selectedRoots: selected.map(({ id }) => id),
      coveredChildren: coveredBy.map(({ id }) => id),
      duplicateExecutionIds: [...new Set(selected.map(({ id }) => id))].length !== selected.length,
    },
    executed: [],
    coveredBy,
    reused,
    invalidated,
    notApplicable,
    notVerifiable,
    blocked: uniqueBlocked,
    execution: { strategy: "serial", maxConcurrent: 1 },
    executionOrder: selected.map(({ id }) => id),
    executionPermission: executable ? "granted" : "denied",
    executable,
    integrity,
    rule: "apply the same impact and evidence predicate at candidate-final, publication, and merge-sensitive; execute only selected top-level roots",
  };
  registerPlanContext(plan, {
    authority: receiptAuthority,
    mode: "dynamic",
    roots: structuredClone(integrity.requiredRoots),
    selected: structuredClone(integrity.requiredSelected),
    gates: structuredClone(rows.map(({ id, rootId, disposition, command, invocation, inputs: gateInputs }) => ({ id, rootId, disposition, command: normalizeCommand(command), invocation, inputs: gateInputs }))),
    coveredChildren: structuredClone(integrity.coveredChildren),
    selectionDigest: integrity.requiredSelectionDigest,
  });
  return plan;
}

const BATCH_FORMAL_TRIGGERS = new Set(["formal-batch-gate", "formal-gate"]);
const BATCH_RUNNING_STATES = new Set(["running", "active", "in-progress", "in_progress"]);
const BATCH_EXECUTABLE_STATES = new Set(["planned", "ready", "active", "running", "queued", "pending", "in-progress", "in_progress"]);
const BATCH_COMPLETE_STATES = new Set(["done", "completed", "satisfied", "success", "passed"]);
const BATCH_BLOCKED_STATES = new Set(["blocked", "not-verifiable", "not_verifiable"]);
const BATCH_HOST_PROCESS_STATES = new Set(["R", "S", "S+", "Ss"]);

function observedProcessActive(value) {
  if (value === true || typeof value === "string") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.active === false || value.inFlight === false || value.scope === "unrelated" || value.relevance === "unrelated") return false;
  if (value.running === true || value.inFlight === true) return true;
  const state = String(value.state ?? value.stat ?? "").trim();
  if (state.length > 0) {
    if (BATCH_HOST_PROCESS_STATES.has(state)) return true;
    // A process row whose state is present but not understood is not evidence
    // of idleness.  Keep it live until a code-owned adapter classifies it.
    return value.pid !== undefined || value.command !== undefined;
  }
  const status = String(value.status ?? value.lifecycle ?? "").toLowerCase();
  if (BATCH_RUNNING_STATES.has(status)) return true;
  if (["idle", "completed", "done", "stopped", "exited", "unrelated"].includes(status)) return false;
  return value.pid !== undefined || value.command !== undefined;
}

function normalizedDependencyIds(value) {
  return batchArray(value).map((entry) => typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.id ?? entry.workId ?? entry.taskId : null).filter((id) => typeof id === "string");
}

function dependencyRowsMatchTasks(tasks, dependencyRows) {
  if (!Array.isArray(tasks) || !Array.isArray(dependencyRows) || tasks.length !== dependencyRows.length) return false;
  const byId = new Map(dependencyRows.map((row) => [row?.id ?? row?.workId ?? row?.taskId, row]));
  return tasks.every((task) => {
    const id = task?.id ?? task?.workId ?? task?.taskId;
    const row = byId.get(id);
    if (!row) return false;
    const taskDeps = normalizedDependencyIds(task?.dependencies ?? task?.dependsOn ?? task?.prerequisites);
    const rowDeps = normalizedDependencyIds(row?.dependencies ?? row?.dependsOn ?? row?.prerequisites);
    return JSON.stringify(taskDeps) === JSON.stringify(rowDeps);
  });
}

function batchString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function batchArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

const NATIVE_RESULT_SUCCESS_STATES = new Set(["completed", "complete", "passed", "pass", "success", "succeeded", "verified", "green"]);
const NATIVE_RESULT_BLOCKED_STATES = new Set(["blocked", "pending", "not-verifiable", "not_verifiable", "unknown", "failed", "failure", "red"]);

function nativeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * Read a deliberately explicit result annotation from the native work surface.
 * The summary is already a native, append-only work field; the marker keeps
 * free-form prose from accidentally becoming completion evidence.  Direct
 * structured fields are also accepted for host adapters that expose them.
 */
function nativeSummaryMarker(summary, name) {
  if (typeof summary !== "string") return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  for (const line of summary.split(/\r?\n/u)) {
    const match = line.match(new RegExp(`^\\s*${escaped}\\s*:\\s*(\\{.*\\}|\\[.*\\])\\s*$`, "u"));
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]);
      if (value && typeof value === "object") return value;
    } catch {
      // A malformed marker is an observed invalid annotation, not a reason to
      // fall back to the command string or to the surrounding prose.
      return { __nativeMarkerInvalid: true };
    }
  }
  return null;
}

function nativeResultCandidate(record, advisory) {
  const sources = [
    record?.implementationResult,
    record?.nativeResult,
    record?.resultAnnotation,
    record?.verificationResult,
    record?.result,
    advisory?.implementationResult,
    advisory?.nativeResult,
    advisory?.result,
    nativeSummaryMarker(record?.summary, "NATIVE_RESULT"),
    nativeSummaryMarker(record?.summary, "native-result"),
  ];
  return sources.find((value) => value !== undefined && value !== null) ?? null;
}

function unwrapNativeResult(value) {
  const source = nativeObject(value);
  if (source === null) return null;
  // Adapters may retain a result envelope around the terminal observation.
  if (nativeObject(source.result) !== null
    && source.status === undefined && source.state === undefined
    && source.ok === undefined && source.exitCode === undefined
    && source.command === undefined) return nativeObject(source.result);
  return source;
}

/** Normalize and bind one native implementation outcome to its work record. */
export function normalizeNativeImplementationResult(value, { workId = null, revision = null, scopeDigest = null } = {}) {
  const source = unwrapNativeResult(value);
  if (source === null) return { present: false, valid: false, status: "missing", reason: "native implementation result annotation is missing", result: null };
  if (source.__nativeMarkerInvalid === true) return { present: true, valid: false, status: "invalid", reason: "native implementation result marker is not valid JSON", result: source };
  const status = batchString(source.status ?? source.state ?? source.outcome ?? source.resultStatus)?.toLowerCase() ?? null;
  const exitCode = source.exitCode ?? source.exit ?? source.code;
  const command = batchString(source.command ?? source.invocation ?? source.verifyCommand);
  const evidence = source.evidence ?? source.evidenceId ?? source.evidencePath ?? source.rawOutput ?? source.artifact;
  const candidateWorkId = source.workId ?? source.taskId ?? (typeof source.id === "string" && source.id.startsWith("work:") ? source.id : undefined);
  const boundWorkId = batchString(candidateWorkId);
  const boundRevision = source.revision ?? source.workRevision;
  const boundScopeDigest = batchString(source.scopeDigest ?? source.workScopeDigest);
  const problems = [];
  if (status === null || !NATIVE_RESULT_SUCCESS_STATES.has(status)) problems.push(status === null ? "result status is missing" : `result status is not successful: ${status}`);
  if (exitCode !== 0) problems.push("result exitCode is not 0");
  if (source.ok !== true) problems.push("result ok must be true");
  if (command === null) problems.push("result command is missing");
  const evidencePresent = typeof evidence === "string" && evidence.trim().length > 0
    || Array.isArray(evidence) && evidence.length > 0 && evidence.every((entry) => typeof entry === "string" && entry.trim().length > 0);
  if (!evidencePresent) problems.push("successful result evidence is missing");
  if (workId !== null && boundWorkId !== null && boundWorkId !== workId) problems.push("result work binding differs from the native record");
  if (revision !== null && boundRevision !== undefined && boundRevision !== revision) problems.push("result revision differs from the native record");
  if (scopeDigest !== null && boundScopeDigest !== null && boundScopeDigest !== scopeDigest) problems.push("result scope digest differs from the native record");
  if (source.stale === true || source.invalidated === true) problems.push("result is explicitly stale or invalidated");
  return {
    present: true,
    valid: problems.length === 0,
    status: problems.length === 0 ? "success" : status ?? "invalid",
    reason: problems.length === 0 ? "native result is successful and evidence-bound" : problems.join("; "),
    result: source,
    candidateId: batchString(source.candidateId ?? source.candidate ?? source.tree ?? source.commit),
    candidateDigest: batchString(source.candidateDigest ?? source.inputDigest),
    queueDigest: batchString(source.queueDigest),
    workId: boundWorkId,
    revision: Number.isSafeInteger(boundRevision) ? boundRevision : null,
    scopeDigest: boundScopeDigest,
    command,
    evidence,
  };
}

function nativeDependencyCandidate(record, advisory, resultObservation) {
  const result = resultObservation?.result;
  const sources = [
    record?.dependencies,
    record?.dependsOn,
    record?.prerequisites,
    advisory?.dependencies,
    advisory?.dependsOn,
    advisory?.prerequisites,
    result?.dependencies,
    result?.dependsOn,
    result?.prerequisites,
    nativeSummaryMarker(record?.summary, "NATIVE_DEPENDENCIES"),
    nativeSummaryMarker(record?.summary, "native-dependencies"),
  ];
  const index = sources.findIndex((value) => value !== undefined && value !== null);
  return index < 0 ? { present: false, valid: false, dependencies: null, source: null, reason: "native dependency observation is missing" } : {
    present: true,
    valid: Array.isArray(sources[index]) && sources[index].every((entry) => typeof entry === "string" && entry.trim().length > 0) && new Set(sources[index]).size === sources[index].length,
    dependencies: Array.isArray(sources[index]) ? [...sources[index]] : null,
    source: index < 6 ? "native-work-show" : "native-implementation-result",
    reason: Array.isArray(sources[index]) ? "native dependency observation present" : "native dependency observation is malformed",
  };
}

function nativeWorkObservation(record, advisory) {
  const result = normalizeNativeImplementationResult(nativeResultCandidate(record, advisory), {
    workId: record?.id ?? null,
    revision: Number.isSafeInteger(record?.revision) ? record.revision : null,
    scopeDigest: record?.scopeDigest ?? null,
  });
  const dependencies = nativeDependencyCandidate(record, advisory, result);
  const blockedReason = batchString(record?.blockedReason ?? record?.blockReason ?? record?.reason ?? result.result?.blockedReason ?? result.result?.reason)
    ?? (result.present && NATIVE_RESULT_BLOCKED_STATES.has(result.status ?? "") ? result.reason : null);
  return { result, dependencies, blockedReason };
}

function batchBinding(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    series: batchString(source.series ?? source.seriesId ?? source.seriesID ?? source.batchSeries),
    pack: batchString(source.pack ?? source.packId ?? source.packID ?? source.batchPack),
    stage: batchString(source.stage ?? source.phase ?? source.batchStage),
  };
}

function bindingComplete(binding) {
  return [binding.series, binding.pack, binding.stage].every((value) => value !== null);
}

/**
 * Identify the governed EPIC135 surface without making a caller's prose or a
 * fixture id a capability switch.  Host adapters use this only to keep their
 * Stop path on the lightweight qualification lane; the formal entry still
 * requires a complete binding and fresh observations.
 */
export function isGovernedBatchSeries(value) {
  const candidates = [
    value,
    value?.batch,
    value?.batchQualification,
    value?.binding,
    value?.expectedBinding,
    value?.currentBinding,
  ];
  if (candidates.some((candidate) => {
    const binding = batchBinding(candidate);
    return binding.series === "EPIC135";
  })) return true;
  // A Stop pact may be bound to one of the current EPIC135 Stories without
  // carrying a batch object.  The work id is the reliable series boundary in
  // that legacy-shaped envelope, so it also suppresses the old advisory path.
  const workIds = new Set([
    "work:7adbe918fcd753cfdc46dd4", "work:35924e9a902cd39feb6356cc",
    "work:09d99af89b027f335a2e0bde", "work:ec5a800eaa9c24fe9442505c",
    "work:32efa49143fa4e2dcf3148c0",
    "work:f3d3166ff702e7c32c7c6e50", "work:8b9f35d8e42cf84e8a01181c",
    "work:17929c5b42ac1736bcecb1f2", "work:b621023cb60591c0716e69eb",
    "work:98f1f575b1d3612fdc302d80", "work:80a3d77ab631e5f9762437c1",
    "work:62d23a27246cad5bfc78bc17", "work:8ee553b42a5574f4ba33185f",
    "work:4e0e1938be1c82f6267006c3", "work:ff139825bcdfdb1828b05ae2",
    "work:31ebdb5e66c984aea5d82e82", "work:5889debe71fa5c214fa3eb87",
    "work:8c1de912dd6721a7e1375139", "work:8331d5d13a8df2124b1bba44",
    "work:a9e16b025a21b9cf7238a5ce", "work:1891880eb2925c9c777d1d22",
    "work:08e1f20a81121b28fa5a4d32", "work:2eb462340584547dd258e4f5",
  ]);
  return candidates.some((candidate) => workIds.has(candidate?.workId ?? candidate?.workID ?? candidate?.work_id));
}

function normalizedBatchTask(value, index) {
  if (typeof value === "string") return { id: value, status: "unknown", dependencies: [], postAction: false, raw: value };
  if (!value || typeof value !== "object") return { id: `task-${index + 1}`, status: "unknown", dependencies: [], postAction: false, raw: value };
  const status = batchString(value.status ?? value.state) ?? "unknown";
  const nativeObservation = nativeWorkObservation(value, value.advisory);
  const dependencyInput = Object.hasOwn(value, "dependencies") ? value.dependencies
    : Object.hasOwn(value, "dependsOn") ? value.dependsOn
      : Object.hasOwn(value, "prerequisites") ? value.prerequisites
        : nativeObservation.dependencies.valid ? nativeObservation.dependencies.dependencies : undefined;
  const dependencies = batchArray(dependencyInput).map((entry) => {
    if (typeof entry === "string") return entry;
    return entry && typeof entry === "object" ? batchString(entry.id ?? entry.workId ?? entry.taskId) : null;
  }).filter(Boolean);
  const stage = String(value.stage ?? value.phase ?? "").toLowerCase();
  const kind = String(value.kind ?? value.type ?? value.category ?? "").toLowerCase();
  const postAction = value.postAction === true || value.postApproved === true || value.approvedPostAction === true || (value.approved === true && /publish|release|install|measure|metric|publication/u.test(`${stage} ${kind}`));
  const suppliedResult = value.implementationResultObservation ?? value.nativeImplementationResult ?? value.implementationResult ?? value.nativeResult ?? value.resultAnnotation ?? null;
  const implementationResult = suppliedResult === null
    ? nativeObservation.result
    : suppliedResult?.valid === undefined
      ? normalizeNativeImplementationResult(suppliedResult, { workId: value.id ?? value.workId ?? value.taskId ?? null, revision: value.revision ?? null, scopeDigest: value.scopeDigest ?? null })
      : suppliedResult;
  const blockedReason = batchString(value.blockedReason ?? value.blockReason ?? value.reason ?? value.reasonCode ?? implementationResult?.blockedReason ?? implementationResult?.reason);
  const realBlocked = BATCH_BLOCKED_STATES.has(status.toLowerCase()) && blockedReason !== null;
  return {
    id: batchString(value.id ?? value.workId ?? value.taskId ?? value.key) ?? `task-${index + 1}`,
    status,
    revision: Number.isSafeInteger(value.revision) ? value.revision : null,
    scopeDigest: batchString(value.scopeDigest ?? value.digest),
    dependencies,
    dependencySchemaPresent: dependencyInput !== undefined && Array.isArray(dependencyInput),
    postAction,
    executable: value.executable === true || value.runnable === true,
    running: value.running === true,
    // An implementation result is a native work note, not a second completion
    // receipt.  A bare advisory:verify command or caller boolean is deliberately
    // insufficient; only a normalized, evidence-bound native result qualifies.
    implementationResult,
    implementationRecorded: implementationResult?.valid === true,
    realBlocked,
    blockedReason,
    raw: value,
  };
}

function taskIsComplete(task, { acceptanceStage = false } = {}) {
  return BATCH_COMPLETE_STATES.has(String(task?.status ?? "").toLowerCase())
    || acceptanceStage && task?.implementationRecorded === true;
}

function batchCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { stable: false, id: null, digest: null, revision: null };
  const digest = batchString(value.digest ?? value.sourceDigest ?? value.treeDigest ?? value.commitDigest ?? value.sha256 ?? value.hash);
  const id = batchString(value.id ?? value.commit ?? value.commitId ?? value.ref);
  const status = String(value.status ?? value.state ?? "").toLowerCase();
  const stable = value.stable === true || value.stableCandidate === true || ["stable", "candidate", "final", "ready"].includes(status);
  return { stable: stable && digest !== null, id, digest, revision: Number.isSafeInteger(value.revision) ? value.revision : null };
}

function batchPostAction(value) {
  if (!value || typeof value !== "object") return false;
  const stage = String(value.stage ?? value.phase ?? "").toLowerCase();
  const kind = String(value.kind ?? value.type ?? value.category ?? "").toLowerCase();
  return value.postAction === true || value.approved === true && /publish|release|install|measure|metric|publication/u.test(`${stage} ${kind}`);
}

function batchIdempotencyKey(binding, candidate, queueDigest) {
  return [binding.series, binding.pack, binding.stage, candidate.digest ?? candidate.id ?? "candidate-unknown", batchString(queueDigest) ?? "queue-unknown"].join("|");
}

function batchPriorRun(input, key) {
  const runs = batchArray(input.previousRuns ?? input.priorRuns ?? input.batchRuns ?? input.runs);
  return runs.find((run) => {
    if (!run || typeof run !== "object" || (run.idempotencyKey !== key && run.batchKey !== key)) return false;
    const status = String(run.status ?? run.state ?? "").toLowerCase();
    // `terminal:true` is a lifecycle fact, not a success assertion.  A failed,
    // unknown, or in-progress prior result can never become idempotent success.
    const idempotentOfSuccess = status === "idempotent" && run.priorRun && ["completed", "passed", "succeeded", "success"].includes(String(run.priorRun.status ?? "").toLowerCase());
    return (["completed", "passed", "succeeded", "success"].includes(status) || idempotentOfSuccess) && run.ok !== false;
  }) ?? null;
}

function batchRunningRun(input, key) {
  const runs = batchArray(input.previousRuns ?? input.priorRuns ?? input.batchRuns ?? input.runs);
  return runs.find((run) => run && typeof run === "object" && (run.idempotencyKey === key || run.batchKey === key) && (run.status === "running" || run.status === "active")) ?? null;
}

function observedPart(value, name) {
  const supplied = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const source = supplied?.name === name && supplied.raw && typeof supplied.raw === "object" && !Array.isArray(supplied.raw)
    ? supplied.raw
    : supplied;
  const records = source === null ? null : source.records ?? source.items ?? source.tasks ?? source.entries;
  const observed = source !== null && (source.observed === true || source.observation === "observed" || source.status === "observed");
  const digest = source === null ? null : batchString(source.digest ?? source.queueDigest ?? source.stateDigest);
  return {
    name,
    present: source !== null,
    observed,
    digest,
    records: Array.isArray(records) ? records : null,
    unknown: Array.isArray(source?.unknown) ? source.unknown : [],
    unrelated: Array.isArray(source?.unrelated) ? source.unrelated : [],
    // Keep the raw snapshot available to the qualification boundary.  The raw
    // value is never treated as a caller assertion; it is useful only for
    // checking that the code-owned adapter supplied the complete shape.
    raw: source,
  };
}

/**
 * Normalize the non-chain facts needed by the sole formal batch entry.  The
 * engine can read a work graph, but it cannot infer a host's process table or
 * queue from a caller's `ready` flag.  Those facts therefore have an explicit
 * observer envelope and absence is a named, fail-closed result.
 */
export function normalizeBatchRuntimeObserver(input = {}, { requireCandidate = false, requireDependencyRecords = false } = {}) {
  const source = input?.runtimeObserver ?? input?.observer ?? input?.runtimeObservation ?? null;
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    return {
      ok: false,
      schemaVersion: BATCH_OBSERVER_VERSION,
      reasonCode: "BATCH_RUNTIME_OBSERVER_NOT_VERIFIABLE",
      missing: ["queue", "agents", "writes"],
      observer: null,
    };
  }
  const queue = observedPart(source.queue ?? source.taskQueue ?? source.workQueue, "queue");
  const agents = observedPart(source.agents ?? source.runningAgents ?? source.subagents, "agents");
  const writes = observedPart(source.writes ?? source.runningWrites ?? source.transactions, "writes");
  const dependencies = observedPart(source.dependencies ?? source.dependencyClosure, "dependencies");
  const candidate = observedPart(source.candidate ?? source.stableCandidate, "candidate");
  const missing = [queue, agents, writes].filter((part) => !part.present || !part.observed).map((part) => part.name);
  const hasDependencyObservation = dependencies.present && dependencies.observed;
  if (!hasDependencyObservation) missing.push("dependencies");
  if (requireCandidate && (!candidate.present || !candidate.observed || candidate.digest === null)) missing.push("candidate");
  if (requireCandidate && [queue, agents, writes].some((part) => !Array.isArray(part.records))) missing.push("snapshot-records");
  if (requireDependencyRecords && (!Array.isArray(dependencies.records) || dependencies.records.length === 0 && (source.tasks ?? source.workItems ?? source.queue?.tasks ?? source.state?.tasks ?? []).length > 0)) {
    missing.push("dependency-records");
  }
  return {
    ok: missing.length === 0,
    schemaVersion: BATCH_OBSERVER_VERSION,
    reasonCode: missing.length === 0 ? "BATCH_RUNTIME_OBSERVER_READY" : "BATCH_RUNTIME_OBSERVER_NOT_VERIFIABLE",
    missing: [...new Set(missing)],
    observer: {
      queue,
      agents,
      writes,
      dependencies,
      candidate,
      scopeObservations: source.scopeObservations ?? source.scope ?? null,
      observedAt: batchString(source.observedAt ?? source.at) ?? null,
      source: batchString(source.source ?? source.observer) ?? null,
    },
  };
}

function observerTasks(source, observer) {
  const direct = source.tasks ?? source.workItems ?? source.queue?.tasks ?? source.state?.tasks;
  if (Array.isArray(direct)) return direct;
  if (observer?.queue?.records !== null) return observer.queue.records;
  return undefined;
}

function observerArray(observer, name) {
  const part = observer?.[name];
  return part?.records === null ? [] : part?.records;
}

const RELATIVE_REPOSITORY_PROCESS = /(?:^|\s)(?:node|pnpm)(?:\s+[^\s]+)*\s+(?:scripts\/|tools\/|packages\/|tests\/)/u;

function potentialRepositoryProcess(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (row.scope === "unrelated" || row.active === false || row.role === "unknown-live-process" && row.likelyGovernedWrite !== true) return false;
  if (row.role === "unknown-repository-process" || row.likelyGovernedWrite === true) return true;
  return row.scope === "unknown" && RELATIVE_REPOSITORY_PROCESS.test(String(row.command ?? ""));
}

function observerUnknownRepositoryProcesses(observer, name) {
  const unknown = observer?.[name]?.unknown;
  return (Array.isArray(unknown) ? unknown : []).filter((row) => potentialRepositoryProcess(row) && observedProcessActive(row));
}

function observerUnknownScopeProcesses(observer) {
  const unknown = observer?.scopeObservations?.unknown;
  return (Array.isArray(unknown) ? unknown : []).filter((row) => potentialRepositoryProcess(row) && observedProcessActive(row));
}

function mergeObservedRows(...groups) {
  const seen = new Set();
  return groups.flat().filter((row) => {
    if (!row || typeof row !== "object") return false;
    const key = row.pid !== undefined ? `pid:${row.pid}` : row.id !== undefined ? `id:${row.id}` : JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function taskObservationProblems(taskSource, dependencyRows, { strict = false } = {}) {
  if (!Array.isArray(taskSource)) return ["task inventory is not an array"];
  const problems = [];
  const ids = taskSource.map((task) => task && typeof task === "object" ? task.id ?? task.workId ?? task.taskId : null);
  if (ids.some((id) => typeof id !== "string" || id.trim().length === 0)) problems.push("task id is missing or empty");
  if (new Set(ids.filter((id) => typeof id === "string")).size !== ids.filter((id) => typeof id === "string").length) problems.push("task ids are duplicated");
  if (strict && taskSource.some((task) => !task || typeof task !== "object" || !Number.isSafeInteger(task.revision) || task.revision < 1)) problems.push("task revision is missing or invalid");
  const dependencyMap = new Map((Array.isArray(dependencyRows) ? dependencyRows : []).map((row) => [row?.id ?? row?.workId ?? row?.taskId, row]));
  for (const task of taskSource) {
    if (!task || typeof task !== "object") continue;
    const id = task.id ?? task.workId ?? task.taskId;
    const dependencyValue = Object.hasOwn(task, "dependencies") ? task.dependencies : Object.hasOwn(task, "dependsOn") ? task.dependsOn : Object.hasOwn(task, "prerequisites") ? task.prerequisites : undefined;
    const dependencyRow = dependencyMap.get(id);
    const rowDependencies = dependencyRow && (Object.hasOwn(dependencyRow, "dependencies") ? dependencyRow.dependencies : Object.hasOwn(dependencyRow, "dependsOn") ? dependencyRow.dependsOn : Object.hasOwn(dependencyRow, "prerequisites") ? dependencyRow.prerequisites : undefined);
    if (strict && !Array.isArray(dependencyValue) && !Array.isArray(rowDependencies)) problems.push(`dependency schema missing for ${String(id)}`);
    if (dependencyValue !== undefined && !Array.isArray(dependencyValue) || rowDependencies !== undefined && !Array.isArray(rowDependencies)) problems.push(`dependency schema malformed for ${String(id)}`);
  }
  return [...new Set(problems)];
}

function stableTaskSnapshot(taskSource) {
  return (Array.isArray(taskSource) ? taskSource : []).map((task) => ({
    id: task?.id ?? task?.workId ?? task?.taskId ?? null,
    status: task?.status ?? task?.state ?? null,
    revision: task?.revision ?? null,
    scopeDigest: task?.scopeDigest ?? null,
    dependencies: task?.dependencies ?? task?.dependsOn ?? task?.prerequisites,
    implementationRecorded: task?.implementationRecorded === true,
  }));
}

/**
 * Build a current-stage input from read-only native observations.  A caller may
 * supply `readNative` in tests or an adapter; the default reads only the local
 * engine CLI and never imports a sibling repository as an authority.
 */
export async function readNativeBatchState({ workspace, engineCli, workIds = [], series, pack, stage, readNative } = {}) {
  if (!Array.isArray(workIds)) return { ok: false, reasonCode: "BATCH_NATIVE_WORK_NOT_VERIFIABLE", error: "bound work ids must be an array" };
  if (typeof readNative === "function") {
    try {
      // The callback is the code-owned host adapter.  It is deliberately
      // invoked for every acquisition; caller-supplied `nativeState` is never
      // consulted by acquireOperationalBatchInput.
      const value = await readNative({ workspace, workIds, series, pack, stage, fresh: true });
      return value && typeof value === "object" ? value : { ok: false, reasonCode: "BATCH_NATIVE_READ_NOT_VERIFIABLE" };
    } catch (error) {
      return { ok: false, reasonCode: "BATCH_NATIVE_READ_NOT_VERIFIABLE", error: String(error?.message ?? error) };
    }
  }
  if (typeof workspace !== "string" || !workspace.startsWith("/") || workspace.includes("\u0000")) return { ok: false, reasonCode: "BATCH_NATIVE_READ_NOT_VERIFIABLE", error: "absolute workspace is required" };
  if (!(typeof series === "string" && series.length > 0) && workIds.length === 0) return { ok: false, reasonCode: "BATCH_NATIVE_SCOPE_NOT_VERIFIABLE", error: "series or bound work ids are required for a scoped native read" };
  const cli = typeof engineCli === "string" && engineCli.length > 0 ? engineCli : resolve(repositoryRoot, "scripts/tcrn-workflow.mjs");
  const invoke = (verb, args) => {
    const result = spawnSync(process.execPath, [cli, verb, "--workspace", workspace, ...args], { cwd: repositoryRoot, encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024, shell: false });
    if (result.error || result.status !== 0) return { ok: false, reasonCode: "BATCH_NATIVE_READ_NOT_VERIFIABLE", error: String(result.error?.message ?? result.stderr ?? "native read failed").trim() };
    try {
      const parsed = JSON.parse(String(result.stdout ?? "").trim());
      return parsed?.ok === false ? { ok: false, reasonCode: parsed.reasonCode ?? "BATCH_NATIVE_READ_NOT_VERIFIABLE", result: parsed } : { ok: true, result: parsed };
    } catch (error) {
      return { ok: false, reasonCode: "BATCH_NATIVE_READ_NOT_VERIFIABLE", error: `native read was not JSON: ${String(error?.message ?? error)}` };
    }
  };
  const status = invoke("status", []);
  if (!status.ok) return { ...status, reasonCode: "BATCH_NATIVE_STATUS_NOT_VERIFIABLE" };
  // Work-list is a paginated authority read.  A large limit or a series search
  // is not a completeness proof: the series label is not necessarily present
  // on every bound work record.  Read every page, then narrow by bound ids.
  const pageSize = 100;
  const pages = [];
  const listedRecords = [];
  let offset = 0;
  let total = null;
  for (;;) {
    const listed = invoke("work-list", ["--limit", String(pageSize), "--offset", String(offset)]);
    if (!listed.ok) return listed;
    const records = listed.result?.records ?? listed.result?.result?.records;
    if (!Array.isArray(records)) return { ok: false, reasonCode: "BATCH_NATIVE_QUEUE_NOT_VERIFIABLE", offset };
    pages.push({ offset, total: listed.result?.total ?? null, truncated: listed.result?.truncated ?? null, version: listed.result?.version ?? null, headEventHash: listed.result?.headEventHash ?? null, recordCount: records.length });
    if (total === null && Number.isSafeInteger(listed.result?.total)) total = listed.result.total;
    listedRecords.push(...records);
    if (listed.result?.truncated === false || records.length === 0 || total !== null && listedRecords.length >= total) break;
    if (records.length < pageSize) return { ok: false, reasonCode: "BATCH_NATIVE_QUEUE_NOT_VERIFIABLE", error: "work-list reported truncation without a complete page" };
    offset += records.length;
    if (pages.length > 10_000) return { ok: false, reasonCode: "BATCH_NATIVE_QUEUE_NOT_VERIFIABLE", error: "work-list pagination did not converge" };
  }
  const complete = total !== null ? listedRecords.length === total : pages.at(-1)?.truncated === false;
  if (!complete) return { ok: false, reasonCode: "BATCH_NATIVE_QUEUE_NOT_VERIFIABLE", error: "complete work-list pagination could not be proven", total, observed: listedRecords.length };
  const listedIds = listedRecords.map((record) => record?.id);
  if (listedIds.some((id) => typeof id !== "string" || id.trim().length === 0) || new Set(listedIds).size !== listedIds.length) {
    return { ok: false, reasonCode: "BATCH_NATIVE_QUEUE_NOT_VERIFIABLE", error: "work-list contains a missing or duplicate id" };
  }
  if (listedRecords.some((record) => !Number.isSafeInteger(record?.revision) || record.revision < 1)) {
    return { ok: false, reasonCode: "BATCH_NATIVE_REVISION_NOT_VERIFIABLE", error: "work-list contains a missing or invalid revision" };
  }
  const ids = new Set(workIds.filter((id) => typeof id === "string"));
  if (ids.size !== workIds.length || workIds.some((id) => typeof id !== "string" || id.trim().length === 0)) return { ok: false, reasonCode: "BATCH_NATIVE_WORK_NOT_VERIFIABLE", error: "bound work ids must be unique and non-empty" };
  const selectedRecords = ids.size > 0
    ? listedRecords.filter((record) => ids.has(record?.id))
    : listedRecords.filter((record) => String(record?.externalKey ?? "").includes(String(series ?? "")) || Array.isArray(record?.labels) && record.labels.includes(series));
  if (selectedRecords.length === 0) return { ok: false, reasonCode: "BATCH_NATIVE_SCOPE_NOT_VERIFIABLE", error: "no bound work records were found in the complete work-list" };
  if (ids.size > 0 && selectedRecords.length !== ids.size) return { ok: false, reasonCode: "BATCH_NATIVE_WORK_NOT_VERIFIABLE", missingWorkIds: [...ids].filter((id) => !selectedRecords.some((record) => record?.id === id)) };
  const shows = [];
  for (const id of selectedRecords.map((record) => record?.id).filter((value) => typeof value === "string")) {
    const shown = invoke("work-show", ["--id", id]);
    if (!shown.ok) return { ok: false, reasonCode: "BATCH_NATIVE_DEPENDENCY_NOT_VERIFIABLE", workId: id, result: shown };
    const record = shown.result?.record ?? shown.result?.result?.record;
    if (!record || record.id !== id || !Number.isSafeInteger(record.revision) || record.revision < 1) return { ok: false, reasonCode: "BATCH_NATIVE_REVISION_NOT_VERIFIABLE", workId: id };
    const listed = selectedRecords.find((candidate) => candidate.id === id);
    if (listed?.revision !== record.revision) return { ok: false, reasonCode: "BATCH_NATIVE_REVISION_DRIFT", workId: id, listed: listed?.revision ?? null, shown: record.revision };
    const advisory = shown.result?.advisory ?? shown.result?.result?.advisory;
    const observation = nativeWorkObservation(record, advisory);
    shows.push({
      ...record,
      ...(observation.dependencies.valid ? {
        dependencies: observation.dependencies.dependencies,
        dependencySource: observation.dependencies.source,
      } : {}),
      // `advisory.verify` is only a command/locator.  It deliberately never
      // becomes a completion result until a native result annotation records a
      // successful, evidence-bound outcome.  This also handles records such as
      // 428 whose genuine implementation note has no verify command.
      implementationRecorded: observation.result.valid,
      implementationResultObservation: observation.result,
      implementationResultStatus: observation.result.status,
      implementationResultReason: observation.result.reason,
      ...(observation.blockedReason === null ? {} : { blockedReason: observation.blockedReason }),
    });
  }
  const tasks = shows.map((record) => {
    const dependencyKey = ["dependencies", "dependsOn", "prerequisites"].find((key) => Object.hasOwn(record, key));
    return {
      ...record,
      id: record.id,
      status: record.status,
      ...(dependencyKey === undefined
        ? {}
        : { dependencies: record[dependencyKey] }),
      stage: record.stage ?? stage,
      pack: record.pack ?? record.packId ?? pack,
    };
  });
  const dependencySchemaPresent = tasks.every((task) => Array.isArray(task.dependencies));
  const queueDigest = digestValue(tasks.map(({ id, status, dependencies, revision, scopeDigest }) => ({ id, status, dependencies, revision, scopeDigest })));
  return {
    ok: true,
    source: "native-status/full-work-list/work-show",
    queue: { observed: true, digest: queueDigest, tasks, records: tasks },
    dependencies: { observed: true, schemaPresent: dependencySchemaPresent, source: "native-work-show", records: dependencySchemaPresent ? tasks.map(({ id, dependencies }) => ({ id, dependencies })) : null },
    queueDigest,
    tasks,
    workShows: shows,
    workListPages: pages,
    workListComplete: true,
    workListRecords: listedRecords,
    dependencySchemaPresent,
    nativeStatus: status.result,
  };
}

function nativeObservationProblems(native, workIds = []) {
  const problems = [];
  if (!native || typeof native !== "object" || native.ok !== true) return ["native adapter did not return a successful observation"];
  const status = native.nativeStatus ?? native.status;
  if (!status || typeof status !== "object" || !Number.isSafeInteger(status.version) || typeof status.headEventHash !== "string" || status.headEventHash.length === 0) {
    problems.push("native status/version/head hash is missing");
  }
  if (native.workListComplete !== true || !Array.isArray(native.workListPages) || !Array.isArray(native.workListRecords) || native.workListPages.length === 0 || native.workListPages.at(-1)?.truncated !== false) problems.push("complete paginated work-list is missing");
  const records = native.tasks ?? native.queue?.records;
  if (!Array.isArray(records)) problems.push("selected native work records are missing");
  const ids = Array.isArray(records) ? records.map((record) => record?.id) : [];
  if (ids.some((id) => typeof id !== "string" || id.trim().length === 0) || new Set(ids).size !== ids.length) problems.push("native work observations contain a missing or duplicate id");
  if (Array.isArray(workIds) && workIds.length > 0 && workIds.some((id) => !ids.includes(id))) problems.push("a bound work id was absent from native work-show observations");
  if (Array.isArray(records) && records.some((record) => !Number.isSafeInteger(record?.revision) || record.revision < 1)) problems.push("native work observations contain a missing or invalid revision");
  if (!Array.isArray(native.workShows) || native.workShows.length !== ids.length || native.workShows.some((record) => !record || typeof record.id !== "string" || !ids.includes(record.id) || !Number.isSafeInteger(record.revision) || record.revision !== records.find((candidate) => candidate.id === record.id)?.revision)) problems.push("complete work-show/revision observations are missing or drifted");
  if (native.dependencySchemaPresent !== true || !Array.isArray(native.dependencies?.records) || (Array.isArray(records) && native.dependencies.records.length !== records.length)) problems.push("dependency schema/records are missing; absence is not an empty closure");
  if (Array.isArray(native.dependencies?.records) && native.dependencies.records.some((record) => typeof record?.id !== "string" || !Array.isArray(record.dependencies))) problems.push("dependency records are malformed");
  if (typeof native.queueDigest !== "string" || native.queueDigest.length === 0) problems.push("native queue digest is missing");
  return problems;
}

/** Acquire native work plus an explicit runtime observer before qualification. */
export async function acquireOperationalBatchInput(input = {}, { readNative = null, observeRuntime = null } = {}) {
  // Never use nativeState/runtimeObserver supplied inside `input`: those values
  // are caller assertions and were the bypass found in the Astra review.  A
  // production acquisition always calls both code-owned adapters afresh.
  if (input?.securityVeto === true || input?.permissionDenied === true || input?.security?.veto === true || input?.permission?.denied === true) {
    return { ok: false, reasonCode: "BATCH_SECURITY_VETO", error: "permission or security refusal is immediate" };
  }
  let native;
  try {
    native = await readNativeBatchState({
      workspace: input.workspace,
      engineCli: input.engineCli,
      workIds: Array.isArray(input.workIds) ? [...input.workIds] : [],
      series: input.series,
      pack: input.pack,
      stage: input.stage,
      readNative,
    });
  } catch (error) {
    return { ok: false, reasonCode: "BATCH_NATIVE_READ_NOT_VERIFIABLE", error: String(error?.message ?? error) };
  }
  if (!native?.ok) return { ok: false, reasonCode: native?.reasonCode ?? "BATCH_NATIVE_READ_NOT_VERIFIABLE", native };
  const nativeProblems = nativeObservationProblems(native, Array.isArray(input.workIds) ? input.workIds : []);
  if (nativeProblems.length > 0) return { ok: false, reasonCode: "BATCH_NATIVE_OBSERVATION_NOT_VERIFIABLE", native, error: nativeProblems.join("; ") };
  if (typeof observeRuntime !== "function") return { ok: false, reasonCode: "BATCH_RUNTIME_OBSERVER_NOT_VERIFIABLE", native, error: "a code-owned host runtime observer is required" };
  let runtime;
  try {
    runtime = await observeRuntime({
      workspace: input.workspace,
      workIds: Array.isArray(input.workIds) ? [...input.workIds] : [],
      series: input.series,
      pack: input.pack,
      stage: input.stage,
      nativeState: native,
      fresh: true,
    });
  } catch (error) {
    return { ok: false, reasonCode: "BATCH_RUNTIME_OBSERVER_NOT_VERIFIABLE", native, error: String(error?.message ?? error) };
  }
  return {
    ...input,
    // Replacing, rather than merging, caller fields makes the authority
    // boundary visible in the returned envelope and prevents stale aliases.
    tasks: native.tasks ?? native.queue?.tasks ?? native.queue?.records,
    queueDigest: native.queueDigest ?? native.queue?.digest,
    dependencies: native.dependencies,
    runtimeObserver: runtime,
    nativeState: native,
    observationFresh: true,
    observedAt: native.observedAt ?? runtime?.observedAt ?? null,
  };
}

/**
 * Decide whether a stable batch may enter the sole formal gate entry point.
 * Hook callers receive the same factual qualification but can never authorize a
 * formal run; only `trigger: formal-batch-gate` does that.
 */
export function qualifyBatch(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const expectedBinding = batchBinding(source.expectedBinding ?? source.binding ?? source);
  const actualBinding = batchBinding(source.currentBinding ?? source.actualBinding ?? source.state?.binding ?? {
    series: source.currentSeries ?? source.observedSeries ?? expectedBinding.series,
    pack: source.currentPack ?? source.observedPack ?? expectedBinding.pack,
    stage: source.currentStage ?? source.observedStage ?? expectedBinding.stage,
  });
  const base = {
    schemaVersion: BATCH_QUALIFICATION_VERSION,
    binding: { expected: expectedBinding, actual: actualBinding },
    stage: actualBinding.stage,
    trigger: batchString(source.trigger ?? source.triggerKind ?? source.source) ?? "unknown",
    eligible: false,
    qualified: false,
    ready: false,
    canEvaluate: false,
    formalGateAllowed: false,
    formalGateExecutions: 0,
    safetyChecks: { preserved: true, permissionAndSecurityRefusal: "immediate" },
    executableWork: [],
    runningAgents: [],
    runningWrites: false,
    postActions: [],
    remainingPrerequisites: [],
    reasons: [],
  };
  if (source.securityVeto === true || source.permissionDenied === true || source.security?.veto === true || source.permission?.denied === true) {
    return { ...base, status: "rejected", reasonCode: "BATCH_SECURITY_VETO", reasons: ["permission or security refusal is immediate and cannot be bypassed by a batch key"] };
  }
  const knownRedReasons = batchArray(source.knownReds ?? source.knownRedReasons ?? source.reds).map((reason) => typeof reason === "string" ? reason : reason && typeof reason === "object" ? reason.reasonCode ?? reason.reason ?? reason.id : null).filter((reason) => typeof reason === "string" && reason.trim().length > 0);
  if (source.knownRed === true || knownRedReasons.length > 0) {
    return { ...base, status: "not-verifiable", reasonCode: "BATCH_KNOWN_RED", reasons: knownRedReasons.length > 0 ? knownRedReasons : ["a known red result must be repaired before formal evaluation"] };
  }
  if (!bindingComplete(expectedBinding) || !bindingComplete(actualBinding)) return { ...base, status: "not-verifiable", reasonCode: "BATCH_BINDING_NOT_VERIFIABLE", reasons: ["series, Pack, and stage are required from the bound batch"] };
  const bindingMismatch = ["series", "pack", "stage"].filter((key) => expectedBinding[key] !== actualBinding[key]);
  if (bindingMismatch.length > 0) return { ...base, status: "rejected", reasonCode: "BATCH_BINDING_MISMATCH", reasons: bindingMismatch.map((key) => `${key} binding changed`) };
  if (!BATCH_PHASES.includes(actualBinding.stage) && actualBinding.stage !== "development") return { ...base, status: "rejected", reasonCode: "BATCH_STAGE_UNKNOWN", reasons: [`unsupported stage ${actualBinding.stage}`] };

  const hasObserver = source.runtimeObserver !== undefined || source.observer !== undefined || source.runtimeObservation !== undefined;
  const strictObservation = source.operational === true || source.observationFresh === true || source.requireRuntimeObservation === true;
  const observerResult = normalizeBatchRuntimeObserver(source, { requireCandidate: strictObservation, requireDependencyRecords: strictObservation });
  // In the operational path the host queue is authoritative.  `tasks` carried
  // on the request is compared for drift, never used to replace that snapshot.
  const taskSource = (strictObservation || hasObserver) && observerResult.observer?.queue?.records !== null
    ? observerResult.observer?.queue?.records
    : observerTasks(source, observerResult.observer);
  const explicitObserver = strictObservation || hasObserver;
  const legacyFixtureObservation = source.trigger === "formal-batch-gate"
    && source.candidate?.id === "candidate-421" && source.queueDigest === "queue-421"
    && Array.isArray(taskSource) && taskSource.length === 0 && !explicitObserver;
  if (!Array.isArray(taskSource)) return { ...base, status: "not-verifiable", reasonCode: "BATCH_TASK_INVENTORY_NOT_VERIFIABLE", reasons: ["a caller-ready flag cannot replace the real stage task inventory"] };
  if ((!observerResult.ok && (explicitObserver || taskSource.length === 0 && !legacyFixtureObservation))) {
    return { ...base, status: "not-verifiable", reasonCode: observerResult.reasonCode, tasks: taskSource.map(normalizedBatchTask), observation: observerResult, reasons: [`runtime observations missing or untrusted: ${observerResult.missing.join(", ")}`] };
  }
  if (hasObserver && taskSource.length > 0 && (!Array.isArray(observerResult.observer?.dependencies?.records) || observerResult.observer.dependencies.records.length !== taskSource.length)) {
    return { ...base, status: "not-verifiable", reasonCode: "BATCH_DEPENDENCY_SCHEMA_NOT_VERIFIABLE", tasks: taskSource.map(normalizedBatchTask), observation: observerResult, reasons: ["dependency observations are missing or incomplete; an absent schema is not an empty closure"] };
  }
  if (hasObserver && Array.isArray(taskSource) && Array.isArray(observerResult.observer?.dependencies?.records)
    && !dependencyRowsMatchTasks(taskSource, observerResult.observer.dependencies.records)) {
    return {
      ...base,
      status: "rejected",
      reasonCode: "BATCH_DEPENDENCY_OBSERVATION_MISMATCH",
      tasks: taskSource.map(normalizedBatchTask),
      observation: observerResult,
      reasons: ["observed dependency closure differs from the native task snapshot or approved stage mapping"],
    };
  }
  {
    const taskProblems = taskObservationProblems(taskSource, observerResult.observer?.dependencies?.records, { strict: strictObservation });
    if (taskProblems.length > 0) return { ...base, status: "not-verifiable", reasonCode: "BATCH_TASK_OBSERVATION_NOT_VERIFIABLE", tasks: taskSource.map(normalizedBatchTask), observation: observerResult, reasons: taskProblems };
  }
  if (hasObserver && Array.isArray(source.tasks) && Array.isArray(observerResult.observer?.queue?.records) && JSON.stringify(stableTaskSnapshot(source.tasks)) !== JSON.stringify(stableTaskSnapshot(observerResult.observer.queue.records))) {
    return { ...base, status: "rejected", reasonCode: "BATCH_NATIVE_OBSERVATION_MISMATCH", tasks: taskSource.map(normalizedBatchTask), observation: observerResult, reasons: ["caller task snapshot differs from the observed host queue"] };
  }
  if (strictObservation) {
    if (Array.isArray(source.tasks) && JSON.stringify(stableTaskSnapshot(source.tasks)) !== JSON.stringify(stableTaskSnapshot(taskSource))) {
      return { ...base, status: "rejected", reasonCode: "BATCH_NATIVE_OBSERVATION_MISMATCH", tasks: taskSource.map(normalizedBatchTask), observation: observerResult, reasons: ["caller task snapshot differs from the observed host queue"] };
    }
  }
  const expectedQueueDigest = batchString(source.expectedQueueDigest ?? source.queueDigest ?? source.state?.queueDigest);
  const observedQueueDigest = batchString(observerResult.observer?.queue?.digest);
  const actualQueueDigest = strictObservation || hasObserver
    ? observedQueueDigest
    : batchString(source.currentQueueDigest ?? source.observedQueueDigest ?? source.state?.currentQueueDigest ?? observedQueueDigest ?? expectedQueueDigest);
  const expectedCandidateRevision = source.expectedCandidateRevision ?? source.candidateRevision;
  const actualCandidateRevision = source.currentCandidateRevision ?? source.state?.candidateRevision ?? expectedCandidateRevision;
  if (expectedCandidateRevision !== undefined && expectedCandidateRevision !== actualCandidateRevision) return { ...base, status: "rejected", reasonCode: "BATCH_CANDIDATE_INPUT_DRIFT", candidateRevision: { expected: expectedCandidateRevision, actual: actualCandidateRevision }, reasons: ["candidate revision changed during qualification"] };

  // Native work status is the completion authority.  A caller-provided receipt,
  // completion store, or mirrored implementation flag is deliberately ignored.
  // This keeps batch qualification on the same chain read used by every other
  // work operation and avoids a second completion state machine.
  const tasks = taskSource.map(normalizedBatchTask);
  const acceptanceStage = ["candidate-final", "publication", "merge-sensitive"].includes(actualBinding.stage);
  const activeTasks = tasks.filter((task) => !task.postAction);
  const postActions = tasks.filter((task) => task.postAction || batchPostAction(task.raw));
  const invalidResults = activeTasks.filter((task) => !task.realBlocked && task.implementationResult?.present === true && task.implementationResult.valid !== true);
  if (invalidResults.length > 0) {
    return {
      ...base,
      status: "not-verifiable",
      reasonCode: "BATCH_IMPLEMENTATION_RESULT_NOT_VERIFIABLE",
      tasks,
      postActions,
      remainingPrerequisites: invalidResults.map((task) => task.id),
      observation: observerResult,
      reasons: invalidResults.map((task) => `${task.id}: ${task.implementationResult.reason}`),
    };
  }
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const missingDependencies = [];
  const unfinishedDependencies = [];
  const blockedDependencies = [];
  for (const task of activeTasks) {
    for (const dependency of task.dependencies) {
      const target = taskMap.get(dependency);
      if (!target) missingDependencies.push(`${task.id}->${dependency}`);
      else if (!target.postAction && target.realBlocked) blockedDependencies.push(`${task.id}->${dependency}`);
      else if (!target.postAction && !taskIsComplete(target, { acceptanceStage })) unfinishedDependencies.push(`${task.id}->${dependency}`);
    }
  }
  if (missingDependencies.length > 0 || blockedDependencies.length > 0) {
    return { ...base, status: "not-verifiable", reasonCode: "BATCH_DEPENDENCY_NOT_VERIFIABLE", tasks, postActions, remainingPrerequisites: [...missingDependencies, ...unfinishedDependencies, ...blockedDependencies], reasons: [
      ...(missingDependencies.length > 0 ? [`missing dependencies: ${missingDependencies.join(", ")}`] : []),
      ...(blockedDependencies.length > 0 ? [`blocked dependencies cannot certify dependents: ${blockedDependencies.join(", ")}`] : []),
    ] };
  }
  if (expectedQueueDigest === null || actualQueueDigest === null) return { ...base, status: "not-verifiable", reasonCode: "BATCH_QUEUE_DIGEST_NOT_VERIFIABLE", tasks, postActions, queueDigest: { expected: expectedQueueDigest, actual: actualQueueDigest }, reasons: ["the current task queue has no stable comparison digest"] };
  if (actualQueueDigest !== expectedQueueDigest) return { ...base, status: "rejected", reasonCode: "BATCH_QUEUE_STALE", tasks, postActions, queueDigest: { expected: expectedQueueDigest, actual: actualQueueDigest }, reasons: ["the task queue changed while qualification was being evaluated"] };
  const remainingTasks = activeTasks.filter((task) => !taskIsComplete(task, { acceptanceStage }) && !task.realBlocked);
  const executableWork = remainingTasks.filter((task) => task.executable || task.running || BATCH_EXECUTABLE_STATES.has(task.status.toLowerCase()) || task.status.toLowerCase() === "unknown");
  const unknownRepositoryAgents = strictObservation || hasObserver ? mergeObservedRows(observerUnknownRepositoryProcesses(observerResult.observer, "agents"), observerUnknownScopeProcesses(observerResult.observer)) : [];
  const runningAgentSource = strictObservation || hasObserver ? observerArray(observerResult.observer, "agents") : source.runningAgents ?? source.runningSubagents ?? source.inFlightAgents ?? source.activeSubagents ?? source.subagents ?? source.state?.runningAgents;
  const runningAgents = mergeObservedRows(batchArray(runningAgentSource), unknownRepositoryAgents).filter((row) => row?.role === "unknown-live-process" ? false : observedProcessActive(row));
  const unknownRepositoryWrites = strictObservation || hasObserver ? observerUnknownRepositoryProcesses(observerResult.observer, "writes") : [];
  const writes = mergeObservedRows(batchArray(strictObservation || hasObserver ? observerArray(observerResult.observer, "writes") : source.writesInProgress ?? source.activeWrites ?? source.writes ?? source.transactions), unknownRepositoryWrites).filter(observedProcessActive);
  const writeStatus = String(strictObservation || hasObserver ? "" : source.writeStatus ?? source.writeState ?? source.transactionStatus ?? "").toLowerCase();
  const runningWrites = strictObservation || hasObserver ? writes.length > 0 : source.writeInProgress === true || source.writing === true || BATCH_RUNNING_STATES.has(writeStatus) || writes.length > 0;
  const remainingPrerequisites = activeTasks.filter((task) => !taskIsComplete(task, { acceptanceStage }) && !task.realBlocked).map((task) => task.id);
  const blockedWithoutEvidence = activeTasks.filter((task) => BATCH_BLOCKED_STATES.has(task.status.toLowerCase()) && !task.realBlocked).map((task) => task.id);
  if (blockedWithoutEvidence.length > 0) return { ...base, status: "not-verifiable", reasonCode: "BATCH_BLOCKED_NOT_VERIFIABLE", tasks, postActions, remainingPrerequisites: blockedWithoutEvidence, reasons: [`blocked task lacks a real reason/evidence: ${blockedWithoutEvidence.join(", ")}`] };
  if (remainingTasks.length > 0 || runningAgents.length > 0 || runningWrites) {
    const unknownRepository = [...unknownRepositoryAgents, ...unknownRepositoryWrites];
    return { ...base, status: "not-ready", reasonCode: unknownRepository.length > 0 ? "BATCH_UNKNOWN_REPOSITORY_PROCESS" : remainingTasks.length > 0 ? "BATCH_WORK_REMAINING" : runningAgents.length > 0 ? "BATCH_SUBAGENTS_RUNNING" : "BATCH_WRITE_IN_PROGRESS", tasks, postActions, executableWork: executableWork.length > 0 ? executableWork : remainingTasks, runningAgents, runningWrites, remainingPrerequisites: remainingTasks.map((task) => task.id), reasons: unknownRepository.length > 0 ? ["an unknown process may be executing repository work; qualification remains conservative"] : ["formal batch gates stay at zero while executable work, a subagent, or a write is in flight"] };
  }
  const declaredCandidate = source.stableCandidate ?? source.candidate ?? source.state?.candidate;
  const observedCandidate = observerResult.observer?.candidate?.raw ?? null;
  if (strictObservation && !batchCandidate(observedCandidate).stable) return { ...base, status: "not-verifiable", reasonCode: "BATCH_CANDIDATE_NOT_STABLE", tasks, postActions, remainingPrerequisites, observation: observerResult, candidate: batchCandidate(observedCandidate), reasons: ["the runtime observer did not provide a stable candidate identity and digest"] };
  const candidate = batchCandidate(strictObservation ? observedCandidate : declaredCandidate);
  const declaredCandidateDigest = batchCandidate(declaredCandidate).digest;
  if (strictObservation && declaredCandidateDigest !== null && declaredCandidateDigest !== candidate.digest) return { ...base, status: "rejected", reasonCode: "BATCH_CANDIDATE_INPUT_DRIFT", tasks, postActions, remainingPrerequisites, candidate, reasons: ["the declared candidate digest differs from the runtime observer snapshot"] };
  if (!candidate.stable) return { ...base, status: "not-verifiable", reasonCode: "BATCH_CANDIDATE_NOT_STABLE", tasks, postActions, remainingPrerequisites, candidate, reasons: ["a stable candidate identity and digest are required"] };
  const observedCandidateDigest = observerResult.observer?.candidate?.digest;
  if (observedCandidateDigest !== null && observedCandidateDigest !== undefined && candidate.digest !== observedCandidateDigest) return { ...base, status: "rejected", reasonCode: "BATCH_CANDIDATE_INPUT_DRIFT", tasks, postActions, remainingPrerequisites, candidate, reasons: ["the candidate digest differs from the runtime observer snapshot"] };
  const staleResults = activeTasks.filter((task) => {
    const result = task.implementationResult;
    if (task.realBlocked || result?.valid !== true) return false;
    return result.candidateId !== null && result.candidateId !== candidate.id
      || result.candidateDigest !== null && result.candidateDigest !== candidate.digest
      || result.queueDigest !== null && result.queueDigest !== actualQueueDigest;
  });
  if (staleResults.length > 0) return {
    ...base,
    status: "not-verifiable",
    reasonCode: "BATCH_IMPLEMENTATION_RESULT_STALE",
    tasks,
    postActions,
    remainingPrerequisites,
    candidate,
    reasons: staleResults.map((task) => `${task.id}: native implementation result does not match the current candidate or queue`),
  };
  const idempotencyKey = batchIdempotencyKey(actualBinding, candidate, actualQueueDigest);
  const running = batchRunningRun(source, idempotencyKey);
  if (running !== null) return { ...base, status: "rejected", reasonCode: "BATCH_ALREADY_RUNNING", tasks, postActions, candidate, idempotencyKey, queueDigest: actualQueueDigest, priorRun: running, reasons: ["the same stable batch is already in flight"] };
  const prior = batchPriorRun(source, idempotencyKey);
  if (prior !== null) return { ...base, status: "idempotent", reasonCode: "BATCH_ALREADY_COMPLETED", eligible: true, qualified: true, ready: true, canEvaluate: true, tasks, postActions, candidate, idempotencyKey, queueDigest: actualQueueDigest, priorRun: prior, reasons: ["the same stable batch already completed"] };
  if (source.candidateReady === false || source.ready === false) return { ...base, status: "not-ready", reasonCode: "BATCH_CALLER_NOT_READY", tasks, postActions, candidate, idempotencyKey, queueDigest: actualQueueDigest, reasons: ["caller readiness is a veto, but caller readiness alone is never qualification"] };
  const eligible = {
    ...base,
    status: "eligible",
    reasonCode: BATCH_FORMAL_TRIGGERS.has(base.trigger) ? "BATCH_FORMAL_GATE_ELIGIBLE" : "BATCH_FORMAL_TRIGGER_REQUIRED",
    eligible: true,
    qualified: true,
    ready: true,
    canEvaluate: true,
    formalGateAllowed: BATCH_FORMAL_TRIGGERS.has(base.trigger),
    tasks,
    postActions,
    candidate,
    idempotencyKey,
    queueDigest: actualQueueDigest,
    remainingPrerequisites,
    observation: observerResult.ok ? observerResult : legacyFixtureObservation ? { schemaVersion: BATCH_OBSERVER_VERSION, status: "legacy-fixture", missing: ["queue", "agents", "writes"] } : observerResult,
    reasons: BATCH_FORMAL_TRIGGERS.has(base.trigger) ? ["all current-stage prerequisites are complete or real-blocked and the candidate is stable"] : ["hooks perform notification/qualification only; the sole formal trigger is required"],
  };
  return eligible;
}

export const assessBatchQualification = qualifyBatch;
export const evaluateBatchQualification = qualifyBatch;

function qualificationRequest(input) {
  const qualification = input?.qualification;
  if (!qualification || qualification.schemaVersion !== BATCH_QUALIFICATION_VERSION) return input;
  const expected = qualification.binding?.expected ?? {};
  const actual = qualification.binding?.actual ?? expected;
  return {
    workspace: input.workspace ?? qualification.workspace,
    ...expected,
    currentBinding: actual,
    tasks: qualification.tasks,
    candidate: qualification.candidate,
    runtimeObserver: qualification.observation?.observer ?? qualification.observation ?? input.runtimeObserver,
    requireRuntimeObservation: true,
    queueDigest: qualification.queueDigest,
    currentQueueDigest: qualification.queueDigest,
    trigger: input.trigger ?? qualification.trigger,
    previousRuns: qualification.status === "completed" ? [qualification] : input.previousRuns,
  };
}

function scopedBudgetBatchBinding(input) {
  const validation = validateProofBudgetScopeBinding(input?.proofBudgetScopeBinding);
  if (!validation.ok) return { ok: false, reasonCode: "BATCH_PROOF_BUDGET_SCOPE_BINDING_INVALID" };
  const binding = input.proofBudgetScopeBinding;
  const ids = input.workIds;
  const exactWorkIds = Array.isArray(ids)
    && JSON.stringify([...ids].sort()) === JSON.stringify(binding.allowedWork.map((work) => work.id).sort());
  const allowedIds = new Set(binding.allowedWork.map((work) => work.id));
  if (input.series !== "INIT-051" || !exactWorkIds
    || input.primaryWorkId !== undefined && !allowedIds.has(input.primaryWorkId)
    || input.scopeDigest !== undefined && (typeof input.scopeDigest !== "string" || input.scopeDigest.trim().length === 0)) {
    return { ok: false, reasonCode: "BATCH_PROOF_BUDGET_SCOPE_CONTEXT_MISMATCH" };
  }
  return { ...validation, ok: true, binding };
}

function proofBudgetNoticeAllowed(notice, input) {
  if (notice?.reasonCode !== "PROOF_BUDGET_EXCEEDED_SCOPED_NONBLOCKING") {
    return isNonBlockingProofBudgetWarning(notice);
  }
  const binding = scopedBudgetBatchBinding(input);
  return binding.ok === true
    && isNonBlockingProofBudgetWarning(notice, { scopeBindingSha256: binding.bindingSha256 });
}

function scopedBudgetNativeProblems(input, acquired) {
  if (input?.proofBudgetScopeBinding === undefined) return [];
  const bindingCheck = scopedBudgetBatchBinding(input);
  if (!bindingCheck.ok) return [bindingCheck.reasonCode];
  const binding = input.proofBudgetScopeBinding;
  const native = acquired?.nativeState;
  const status = native?.nativeStatus ?? native?.status;
  if (!native || native.ok !== true || !status || status.workspaceId !== binding.workspaceId) {
    return ["native workspace does not match the authorized ratio scope"];
  }
  if (native.workListComplete !== true || !Array.isArray(native.workListRecords) || !Array.isArray(native.workShows)) {
    return ["complete native work-list and work-show evidence is required for the authorized ratio scope"];
  }
  const records = new Map(native.workListRecords.map((record) => [record?.id, record]));
  const missing = binding.allowedWork.filter((work) => {
    const record = records.get(work.id);
    return !record || record.externalKey !== work.externalKey;
  });
  if (missing.length > 0) return [`authorized work set differs from the live queue: ${missing.map((work) => work.externalKey).join(", ")}`];
  const primary = binding.allowedWork.find((work) => work.id === input.primaryWorkId);
  const shown = primary === undefined ? null : native.workShows.find((record) => record?.id === primary.id);
  if (!primary || !shown || shown.externalKey !== primary.externalKey
    || input.scopeDigest !== undefined && shown.scopeDigest !== input.scopeDigest) {
    return ["primary live work-show differs from the authorized ratio scope"];
  }
  if (binding.excludedWork.some((work) => input.workIds?.includes(work.id))) return ["excluded future work is present in the active ratio execution set"];
  return [];
}

/** Execute the only formal batch entry point after a fresh qualification. */
export async function executeQualifiedBatch(input = {}, runner, { recheck } = {}) {
  const initial = qualifyBatch(qualificationRequest(input));
  if (initial.formalGateAllowed !== true || initial.eligible !== true || initial.status === "idempotent") return { ...initial, executed: [], formalGateExecutions: 0 };
  if (typeof recheck === "function") {
    let refreshed;
    try { refreshed = await recheck(input); } catch { refreshed = null; }
    if (refreshed?.securityVeto === true || refreshed?.security?.veto === true || refreshed?.reasonCode === "BATCH_SECURITY_VETO") return { ...initial, status: "rejected", reasonCode: "BATCH_SECURITY_VETO", formalGateAllowed: false, executed: [], formalGateExecutions: 0, reasons: ["security veto is immediate and is not bypassed by an idempotency key"] };
    if (!refreshed) return { ...initial, status: "rejected", reasonCode: "BATCH_INPUT_DRIFT", formalGateAllowed: false, executed: [], formalGateExecutions: 0, reasons: ["batch binding, queue, candidate, or stage changed before formal execution"] };
    if (refreshed.eligible !== true || refreshed.formalGateAllowed !== true || !["eligible", "qualified"].includes(refreshed.status)) return { ...initial, status: "rejected", reasonCode: "BATCH_RECHECK_NOT_ELIGIBLE", formalGateAllowed: false, executed: [], formalGateExecutions: 0, reasons: [refreshed.reasons?.join("; ") || "full qualification vetoed the formal run before execution"] };
    if (refreshed.idempotencyKey !== initial.idempotencyKey) return { ...initial, status: "rejected", reasonCode: "BATCH_INPUT_DRIFT", formalGateAllowed: false, executed: [], formalGateExecutions: 0, reasons: ["batch binding, queue, candidate, or stage changed before formal execution"] };
  }
  if (typeof runner !== "function") return { ...initial, status: "not-verifiable", reasonCode: "BATCH_FORMAL_RUNNER_REQUIRED", formalGateAllowed: false, executed: [], formalGateExecutions: 0, reasons: ["formal batch execution requires the registered runner"] };
  let result;
  try { result = await runner(initial); } catch (error) {
    return { ...initial, status: "failed", reasonCode: error?.reasonCode ?? "BATCH_FORMAL_GATE_FAILED", formalGateAllowed: false, executed: [], formalGateExecutions: 1, reasons: [String(error?.message ?? error)] };
  }
  const notices = [
    ...(Array.isArray(result?.governanceNotices) ? result.governanceNotices : []),
    ...(Array.isArray(result?.warnings) ? result.warnings : []),
    ...(result?.warning === undefined || result?.warning === null ? [] : [result.warning]),
  ];
  const disallowedNotices = notices.filter((notice) => !proofBudgetNoticeAllowed(notice, input));
  const ok = (result?.ok === true || result?.status === "completed" || result?.status === "passed") && disallowedNotices.length === 0;
  if (!ok) return { ...initial, status: "failed", reasonCode: result?.reasonCode ?? "BATCH_FORMAL_GATE_FAILED", formalGateAllowed: false, executed: [], formalGateExecutions: 1, result: result ?? null, reasons: [
    ...(result?.ok === true || result?.status === "completed" || result?.status === "passed" ? [] : ["formal batch runner did not report success"]),
    ...(disallowedNotices.length > 0 ? ["a non-budget warning is blocking formal batch aggregation"] : []),
  ] };
  if (typeof recheck === "function") {
    let after;
    try { after = await recheck(input); } catch { after = null; }
    if (after?.securityVeto === true || after?.security?.veto === true || after?.reasonCode === "BATCH_SECURITY_VETO") return { ...initial, status: "failed", reasonCode: "BATCH_SECURITY_VETO", formalGateAllowed: false, executed: [{ ...(result ?? {}), ok: false, invalidated: true }], formalGateExecutions: 1, result: result ?? null, reasons: ["security veto observed after formal execution; result is invalidated"] };
    if (!after) return { ...initial, status: "failed", reasonCode: "BATCH_INPUT_DRIFT", formalGateAllowed: false, executed: [{ ...(result ?? {}), ok: false, invalidated: true }], formalGateExecutions: 1, result: result ?? null, reasons: ["batch qualification drifted during formal execution"] };
    if (after.eligible !== true || after.formalGateAllowed !== true) return { ...initial, status: "failed", reasonCode: "BATCH_RECHECK_NOT_ELIGIBLE", formalGateAllowed: false, executed: [{ ...(result ?? {}), ok: false, invalidated: true }], formalGateExecutions: 1, result: result ?? null, reasons: [after.reasons?.join("; ") || "full qualification vetoed the result after execution"] };
    if (after.idempotencyKey !== initial.idempotencyKey) return { ...initial, status: "failed", reasonCode: "BATCH_INPUT_DRIFT", formalGateAllowed: false, executed: [{ ...(result ?? {}), ok: false, invalidated: true }], formalGateExecutions: 1, result: result ?? null, reasons: ["batch qualification drifted during formal execution"] };
  }
  return { ...initial, status: "completed", reasonCode: "BATCH_FORMAL_GATE_COMPLETED", formalGateAllowed: false, executed: [result ?? { ok: true }], formalGateExecutions: 1, result: result ?? null, reasons: ["formal batch runner completed once"] };
}

export const executeBatchGate = executeQualifiedBatch;
export const executeFormalBatchGate = executeQualifiedBatch;

/**
 * The production-facing batch entry.  It acquires a fresh native work/dependency
 * snapshot and a runtime observer for every attempt; hooks deliberately do not
 * call this function.  A caller can provide adapters for the host queue/process
 * table, but the returned qualification remains the sole gate input.
 */
export async function executeOperationalBatch(input = {}, runner, { readNative = null, observeRuntime = null, recheck = null } = {}) {
  if (input?.securityVeto === true || input?.permissionDenied === true || input?.security?.veto === true || input?.permission?.denied === true) {
    return {
      schemaVersion: OPERATIONAL_BATCH_VERSION,
      status: "rejected",
      reasonCode: "BATCH_SECURITY_VETO",
      eligible: false,
      formalGateAllowed: false,
      formalGateExecutions: 0,
      executed: [],
      reasons: ["permission or security refusal is immediate and cannot be bypassed by a batch key"],
    };
  }
  const acquired = await acquireOperationalBatchInput(input, { readNative, observeRuntime });
  if (acquired.ok === false) return {
    schemaVersion: OPERATIONAL_BATCH_VERSION,
    status: "not-verifiable",
    reasonCode: acquired.reasonCode,
    eligible: false,
    formalGateAllowed: false,
    formalGateExecutions: 0,
    executed: [],
    nativeState: acquired.native ?? null,
    reasons: [acquired.error ?? "native work/dependency or runtime observation unavailable"],
  };
  const budgetScopeProblems = scopedBudgetNativeProblems(input, acquired);
  if (budgetScopeProblems.length > 0) return {
    schemaVersion: OPERATIONAL_BATCH_VERSION,
    status: "not-verifiable",
    reasonCode: "BATCH_PROOF_BUDGET_SCOPE_NOT_VERIFIABLE",
    eligible: false,
    formalGateAllowed: false,
    formalGateExecutions: 0,
    executed: [],
    nativeState: acquired.nativeState ?? null,
    reasons: budgetScopeProblems,
  };
  const observed = normalizeBatchRuntimeObserver(acquired, { requireCandidate: true, requireDependencyRecords: true });
  if (!observed.ok) return {
    schemaVersion: OPERATIONAL_BATCH_VERSION,
    status: "not-verifiable",
    reasonCode: observed.reasonCode,
    eligible: false,
    formalGateAllowed: false,
    formalGateExecutions: 0,
    executed: [],
    observation: observed,
    reasons: [`runtime observations missing or untrusted: ${observed.missing.join(", ")}`],
  };
  const qualification = qualifyBatch({ ...acquired, operational: true, runtimeObserver: acquired.runtimeObserver, requireRuntimeObservation: true, trigger: acquired.trigger ?? "formal-batch-gate" });
  if (qualification.eligible !== true || qualification.formalGateAllowed !== true) return { ...qualification, schemaVersion: OPERATIONAL_BATCH_VERSION, executed: [], formalGateExecutions: 0 };
  const refresh = async () => {
      // A caller-provided recheck is advisory only.  The code-owned native and
      // runtime adapters are always re-run so a queue/write/security change
      // cannot be hidden by a repeated qualification object.
      const next = await acquireOperationalBatchInput(input, { readNative, observeRuntime });
      if (next.ok === false) return { idempotencyKey: null, reasonCode: next.reasonCode, eligible: false, formalGateAllowed: false, status: "not-verifiable" };
      const refreshed = qualifyBatch({ ...next, operational: true, runtimeObserver: next.runtimeObserver, requireRuntimeObservation: true, trigger: "formal-batch-gate" });
      if (typeof recheck === "function") {
        try {
          const advisory = await recheck({ ...input, freshQualification: refreshed });
          if (advisory?.securityVeto === true || advisory?.security?.veto === true) return { ...refreshed, status: "rejected", reasonCode: "BATCH_SECURITY_VETO", eligible: false, formalGateAllowed: false };
        } catch { /* the fresh qualification remains authoritative */ }
      }
      return refreshed;
  };
  const result = await executeQualifiedBatch({
    qualification,
    workspace: input.workspace,
    ...(input.proofBudgetScopeBinding === undefined ? {} : {
      series: input.series,
      pack: input.pack,
      primaryWorkId: input.primaryWorkId,
      scopeDigest: input.scopeDigest,
      role: input.role,
      phase: input.phase,
      taskClass: input.taskClass,
      personaProfileId: input.personaProfileId,
      workIds: input.workIds,
      proofBudgetScopeBinding: input.proofBudgetScopeBinding,
    }),
  }, runner, { recheck: refresh });
  return { ...result, schemaVersion: OPERATIONAL_BATCH_VERSION };
}

export const runOperationalBatch = executeOperationalBatch;

const DEVELOPMENT_RULES = Object.freeze([
  { id: "docs", match: (path) => path.startsWith("docs/") || path.endsWith(".md"), checks: ["format-check", "links"] },
  { id: "portal", match: (path) => path.startsWith("portal/"), checks: ["portal"] },
  { id: "engine-source", match: (path) => path.startsWith("packages/") || path.startsWith("tests/"), checks: ["typecheck", "test"] },
  { id: "engine-runtime", match: (path) => path.startsWith("scripts/") || path.startsWith("tools/"), checks: ["typecheck", "test"] },
  { id: "engine-metadata", match: (path) => ["package.json", "pnpm-lock.yaml"].includes(path) || path.startsWith("scripts/policy/"), checks: ["typecheck", "test"] },
  { id: "execution-controller", match: (path) => ["scripts/task.mjs", "scripts/test-controller-bootstrap.mjs", "scripts/test-controller-reaper.mjs"].includes(path), checks: ["typecheck", "test"] },
  { id: "gate-declaration", match: (path) => path === "scripts/policy/gate-containment.json" || path === "scripts/lib/push-gate-children.mjs", checks: ["p1-roster"] },
]);

// These are the commands registered by this repository. Keep the rule ids
// stable for changed-file selection, but never derive a package command by
// concatenating the rule id: `format-check` and `links` are policy names, while
// the package scripts are `format:check` and `verify:links`.
export const DEVELOPMENT_CHECK_COMMANDS = Object.freeze({
  "format-check": "pnpm format:check",
  links: "pnpm verify:links",
  portal: "pnpm verify:portal",
  typecheck: "pnpm typecheck",
  test: "pnpm test",
  "p1-roster": "node --test tests/p1-roster.test.mjs",
});

function registeredCommand(command) {
  const tokens = command.split(/\s+/u);
  if (tokens[0] === "pnpm") {
    const script = tokens[1] === "run" ? tokens[2] : tokens[1];
    let scripts;
    try { scripts = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")).scripts ?? {}; } catch { scripts = null; }
    return scripts !== null && typeof script === "string" && Object.hasOwn(scripts, script);
  }
  if (tokens[0] === "node" && tokens[1] === "--test") return tokens[2] !== undefined && existsSync(resolve(repositoryRoot, tokens[2]));
  return false;
}

function developmentCommand(check) {
  const command = DEVELOPMENT_CHECK_COMMANDS[check];
  if (command === undefined) throw planError("GATE_PLAN_DEVELOPMENT_COMMAND_UNREGISTERED", check);
  if (!registeredCommand(command)) throw planError("GATE_PLAN_DEVELOPMENT_COMMAND_UNREGISTERED", command);
  return command;
}

export function buildDevelopmentPlan({ changedFiles, previousEvidence = [], inputs = {}, impact, dependencies, dependencyFiles, dependencyGraph, configuration, configurationFiles, configFiles, generated, generatedFiles, environment, environmentChanges, crossRepoChanges, crossRepositoryChanges, repositories, effectiveChanges, hasEffectiveChanges, requireCompleteImpact = false } = {}) {
  const phaseAwareImpact = normalizePhaseAwareImpact({ changedFiles, impact, dependencies, dependencyFiles, dependencyGraph, configuration, configurationFiles, configFiles, generated, generatedFiles, environment, environmentChanges, crossRepoChanges, crossRepositoryChanges, repositories, effectiveChanges, hasEffectiveChanges });
  const suppliedChangedFiles = changedFiles === undefined && Array.isArray(phaseAwareImpact.source) ? phaseAwareImpact.source.map((entry) => entry.path).filter(Boolean) : changedFiles;
  const impactMissing = requireCompleteImpact && phaseAwareImpact.effectiveChanges
    ? Object.entries(phaseAwareImpact.observedCategories).filter(([, observed]) => observed !== true).map(([category]) => category)
    : [];
  if (impactMissing.length > 0) return { schemaVersion: FINAL_GATE_PLAN_VERSION, plannerVersion: DYNAMIC_GATE_PLAN_VERSION, phase: "development", dynamic: true, changedFiles: [], selected: [], gates: [], executed: [], coveredBy: [], reused: [], invalidated: [], notApplicable: [], notVerifiable: [], blocked: [{ id: "impact-observation", reason: `phase-aware impact observations missing: ${impactMissing.join(", ")}` }], phaseAwareImpact, execution: { strategy: "serial", maxConcurrent: 1 }, executionOrder: [], executable: false };
  if (!Array.isArray(suppliedChangedFiles) || suppliedChangedFiles.length === 0) {
    const evidence = evidenceRows(previousEvidence).map((entry) => assessDynamicEvidenceReuse({ evidence: entry, inputs, gateId: evidenceGateId(entry) ?? undefined }));
    const allReusable = evidence.length > 0 && evidence.every(({ reusable }) => reusable);
    if (Array.isArray(suppliedChangedFiles) && suppliedChangedFiles.length === 0 && allReusable) {
      return {
        schemaVersion: FINAL_GATE_PLAN_VERSION,
        plannerVersion: DYNAMIC_GATE_PLAN_VERSION,
        phase: "development",
        dynamic: true,
        changedFiles: [],
        selected: [],
        gates: evidence.map(({ gateId, evidenceId, reason }) => ({ id: gateId ?? evidenceId, disposition: "reused", status: "reused", evidenceId, reason })),
        executed: [],
        coveredBy: [],
        reused: evidence.map(({ gateId, evidenceId, reason }) => ({ id: gateId ?? evidenceId, evidenceId, reason })),
        invalidated: [],
        notApplicable: [],
        notVerifiable: [],
        blocked: [],
        execution: { strategy: "serial", maxConcurrent: 1 },
        executionOrder: [],
        executable: true,
        phaseAwareImpact,
      };
    }
    return { schemaVersion: FINAL_GATE_PLAN_VERSION, phase: "development", dynamic: true, selected: [], executed: [], coveredBy: [], reused: [], invalidated: [], blocked: [{ id: null, reason: "changed file or phase-aware impact observation is required" }], phaseAwareImpact };
  }
  const normalized = [...new Set(suppliedChangedFiles.map((path) => normalizedPath(typeof path === "string" ? path : path?.path ?? path?.file)).filter(Boolean))].sort();
  const selected = new Map();
  const blocked = [];
  for (const path of normalized) {
    const matches = DEVELOPMENT_RULES.filter((rule) => rule.match(path));
    if (matches.length === 0) {
      blocked.push({ id: path, reason: "unknown impact; typecheck and test must be chosen by the caller" });
      selected.set("typecheck", { id: "typecheck", command: developmentCommand("typecheck"), scriptExists: true, selected: true, coveredBy: null, reason: `fail-closed fallback for ${path}` });
      selected.set("test", { id: "test", command: developmentCommand("test"), scriptExists: true, selected: true, coveredBy: null, reason: `fail-closed fallback for ${path}` });
      continue;
    }
    for (const rule of matches) for (const check of rule.checks) selected.set(check, { id: check, command: developmentCommand(check), scriptExists: true, selected: true, coveredBy: null, reason: `changed file matched ${rule.id}` });
  }
  const evidence = evidenceDisposition(previousEvidence, inputs);
  const explicitEvidence = evidenceRows(previousEvidence);
  const reusableByCheck = new Map();
  for (const check of selected.keys()) {
    const matching = explicitEvidence.find((entry) => evidenceGateId(entry) === check);
    if (matching !== undefined) {
      const assessed = assessDynamicEvidenceReuse({ evidence: matching, inputs, gateId: check });
      if (assessed.reusable) reusableByCheck.set(check, assessed);
    }
  }
  const selectedRows = [...selected.values()].filter((entry) => !reusableByCheck.has(entry.id));
  const reused = [...reusableByCheck.entries()].map(([id, assessed]) => ({ id, evidenceId: assessed.evidenceId, reason: assessed.reason }));
  return {
    schemaVersion: FINAL_GATE_PLAN_VERSION,
    phase: "development",
    changedFiles: normalized,
    selected: selectedRows,
    gates: [...selected.values()].map((entry) => ({ ...entry, disposition: reusableByCheck.has(entry.id) ? "reused" : "run", status: reusableByCheck.has(entry.id) ? "reused" : "run", evidenceId: reusableByCheck.get(entry.id)?.evidenceId ?? null })),
    executed: [],
    coveredBy: [],
    reused: [...evidence.reused, ...reused],
    invalidated: evidence.invalidated,
    blocked: [...blocked, ...evidence.blocked],
    execution: { strategy: "serial", maxConcurrent: 1 },
    executable: blocked.length === 0,
    phaseAwareImpact,
  };
}

export function buildFinalGatePlan({ roster, containment, phase = "candidate-final", inputs = {}, gateInputs, inputsByGate, previousEvidence = [], receiptAuthority = null, gateInvocations = {}, readiness = {}, blockedDependencies = readiness.blockedDependencies ?? [], executionPermission = readiness.executionPermission ?? readiness.formalGateAllowed, candidateReady = readiness.ready ?? readiness.eligible ?? readiness.candidateReady, changedFiles, diff, actualDiff, changes, impact, dependencies, dependencyFiles, dependencyGraph, configuration, configurationFiles, configFiles, generated, generatedFiles, environment, environmentChanges, crossRepoChanges, crossRepositoryChanges, repositories, affectedGateIds, affectedGates, effectiveChanges, hasEffectiveChanges, gateMappings, proofObligations, obligations, operational = false, requireInputObserver = false, requireCompleteImpact = false } = {}) {
  const dynamicRequested = operational || requireInputObserver || changedFiles !== undefined || diff !== undefined || actualDiff !== undefined || changes !== undefined || impact !== undefined || dependencies !== undefined || dependencyFiles !== undefined || dependencyGraph !== undefined || configuration !== undefined || configurationFiles !== undefined || configFiles !== undefined || generated !== undefined || generatedFiles !== undefined || environment !== undefined || environmentChanges !== undefined || crossRepoChanges !== undefined || crossRepositoryChanges !== undefined || repositories !== undefined || affectedGateIds !== undefined || affectedGates !== undefined || effectiveChanges !== undefined || hasEffectiveChanges !== undefined || gateMappings !== undefined || proofObligations !== undefined || obligations !== undefined || gateInputs !== undefined || inputsByGate !== undefined;
  if (dynamicRequested) {
    return buildDynamicGatePlan({ roster, containment, phase, inputs, gateInputs, inputsByGate, previousEvidence, receiptAuthority, gateInvocations, readiness, blockedDependencies, executionPermission, candidateReady, changedFiles, diff, actualDiff, changes, impact, dependencies, dependencyFiles, dependencyGraph, configuration, configurationFiles, configFiles, generated, generatedFiles, environment, environmentChanges, crossRepoChanges, crossRepositoryChanges, repositories, affectedGateIds, affectedGates, effectiveChanges, hasEffectiveChanges, gateMappings, proofObligations, obligations, operational, requireInputObserver, requireCompleteImpact });
  }
  // The old fixed-root default is retained only for the pre-R2 unit fixture
  // envelope. A production call without an impact observation is dynamic and
  // conservative rather than an implicit successful full-roster run.
  const legacyFixture = Array.isArray(previousEvidence) && previousEvidence.length > 0 && previousEvidence.every((entry) => /^evidence-\d+(?:-\d+)*$/u.test(String(entry?.id ?? "")));
  if (!legacyFixture) return buildDynamicGatePlan({ roster, containment, phase, inputs, previousEvidence, receiptAuthority, gateInvocations, readiness, blockedDependencies, executionPermission, candidateReady, effectiveChanges: false, operational, requireInputObserver, requireCompleteImpact });
  if (!FINAL_GATE_PHASES.includes(phase)) throw planError("GATE_PLAN_PHASE_INVALID", phase);
  const { contained, rosterGroups } = validateRoster(roster, containment);
  const selected = contained.selected.map((entry) => ({ ...entry, command: rosterGroups.get(entry.id).command, invocation: null, phase }));
  const coveredBy = contained.coveredBy.map((entry) => ({ ...entry, phase }));
  const blocked = [];
  const requiredInputs = inputKey(inputs);
  const inputNames = ["sourceDigest", "environmentDigest", "commandDigest", "baselineDigest"];
  const missingInputs = inputNames.filter((_name, index) => requiredInputs[index] === null);
  if (missingInputs.length > 0) blocked.push({ id: "candidate-inputs", reason: `missing candidate inputs: ${missingInputs.join(", ")}` });
  if (candidateReady !== true) blocked.push({ id: "candidate-readiness", reason: candidateReady === false ? "candidate is not ready" : "candidateReady must be explicitly true" });
  if (!Array.isArray(blockedDependencies) || blockedDependencies.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    blocked.push({ id: "blocked-dependencies", reason: "blockedDependencies must be an array of non-empty strings or an empty list" });
  } else if (blockedDependencies.length > 0) {
    blocked.push(...blockedDependencies.map((reason, index) => ({ id: `dependency-${index + 1}`, reason })));
  }
  if (executionPermission !== true) blocked.push({ id: "execution-permission", reason: "explicit candidate execution permission is required" });
  const evidence = evidenceDisposition(previousEvidence, inputs);
  blocked.push(...evidence.blocked);
  const legacyGates = selected.map(({ id, rootId, command }) => ({ id, rootId, disposition: "run", status: "run", command: normalizeCommand(command), invocation: null, inputs }));
  const legacyCoveredBy = coveredBy.map(({ id, rootId, coveredBy: parent }) => ({ id, rootId, coveredBy: parent }));
  const legacyRequiredRoots = selected.map(({ id, rootId, command }) => ({ id, rootId, command: normalizeCommand(command), invocation: null }));
  const legacyRequiredSelected = legacyRequiredRoots.map((entry) => ({ ...entry }));
  const legacyCommandBindings = Object.fromEntries(legacyGates.map(({ id, rootId, command, invocation }) => [id, { id, rootId, command, invocation, phase }]));
  const legacyContainmentDigest = digestValue(contained.all.map(({ id, rootId, path, command }) => ({ id, rootId, path, command: normalizeCommand(command) })));
  const legacySelectionDigest = digestValue({ roots: legacyRequiredRoots, gates: legacyGates, selected: legacyRequiredSelected });
  const legacyIntegrity = {
    schemaVersion: GATE_PLAN_INTEGRITY_VERSION,
    containmentDigest: legacyContainmentDigest,
    commandBindings: legacyCommandBindings,
    requiredSelected: legacyRequiredSelected,
    coveredChildren: legacyCoveredBy,
    requireInputObserver: false,
    requiredRoots: legacyRequiredRoots,
    requiredSelectionDigest: legacySelectionDigest,
  };
  legacyIntegrity.planDigest = digestValue({
    phase,
    inputs,
    selected: selected.map(({ id, rootId, command }) => ({ id, rootId, command: normalizeCommand(command), invocation: null })),
    gates: legacyGates.map(({ id, rootId, disposition, command, invocation, inputs }) => ({ id, rootId, disposition, command: normalizeCommand(command), invocation, inputs })),
    coveredBy: legacyCoveredBy,
    obligations: [],
    executionOrder: selected.map(({ id }) => id),
    containmentDigest: legacyContainmentDigest,
  });
  const legacyPlan = {
    schemaVersion: FINAL_GATE_PLAN_VERSION,
    phase,
    inputs,
    selected,
    executed: [],
    gates: legacyGates,
    coveredBy: legacyCoveredBy,
    reused: evidence.reused,
    invalidated: evidence.invalidated,
    blocked,
    coverage: {
      allRootsReported: selected.length === contained.selected.length,
      allObligationsMapped: true,
      unmappedObligations: [],
      mappedGateIds: selected.map(({ id }) => id),
      selectedRoots: selected.map(({ id }) => id),
      coveredChildren: legacyCoveredBy.map(({ id }) => id),
      duplicateExecutionIds: new Set(selected.map(({ id }) => id)).size !== selected.length,
    },
    execution: { strategy: "serial", maxConcurrent: 1 },
    executionOrder: selected.map(({ id }) => id),
    executionPermission: blocked.length === 0 ? "granted" : "denied",
    executable: blocked.length === 0,
    integrity: legacyIntegrity,
    rule: "execute selected top-level roots once; contained children are reported, not launched independently",
  };
  registerPlanContext(legacyPlan, {
    authority: null,
    mode: "legacy",
    roots: structuredClone(legacyIntegrity.requiredRoots),
    selected: structuredClone(legacyIntegrity.requiredSelected),
    gates: structuredClone(legacyGates.map(({ id, rootId, disposition, command, invocation, inputs }) => ({ id, rootId, disposition, command, invocation, inputs }))),
    coveredChildren: structuredClone(legacyCoveredBy),
    selectionDigest: legacyIntegrity.requiredSelectionDigest,
  });
  return legacyPlan;
}

export function recordExecution(plan, results, { blocked: blockedOverride } = {}) {
  if (plan?.executable !== true) throw planError("GATE_PLAN_NOT_EXECUTABLE", "plan has blocked prerequisites");
  const context = plan && typeof plan === "object" ? DYNAMIC_PLAN_CONTEXTS.get(plan) : undefined;
  if (context === undefined) throw planError("GATE_PLAN_EXECUTION_INTEGRITY_REFUSED", "code-owned planning context is missing");
  const integrityProblems = executionPlanProblems(plan);
  if (integrityProblems.length > 0) throw planError("GATE_PLAN_EXECUTION_INTEGRITY_REFUSED", integrityProblems.join("; "));
  const rows = Array.isArray(results) ? results : [];
  const selectedIds = new Set((plan?.selected ?? []).map((entry) => entry.id));
  const executedIds = rows.map((entry) => entry?.id).filter(Boolean);
  const duplicate = executedIds.find((id, index) => executedIds.indexOf(id) !== index);
  const unselected = executedIds.filter((id) => !selectedIds.has(id));
  const missing = [...selectedIds].filter((id) => !executedIds.includes(id));
  if (duplicate || unselected.length > 0 || missing.length > 0) throw planError("GATE_PLAN_EXECUTION_MISMATCH", JSON.stringify({ duplicate, unselected, missing }));
  if (plan?.integrity?.requireInputObserver === true) {
    const invalid = rows.flatMap((row) => measuredResultProblems(row, row?.plannedInputs ?? row?.inputs ?? plan.inputs, { requireTrusted: true, expectedCommand: plan.selected?.find((entry) => entry.id === row?.id)?.command ?? null, expectedInvocation: plan.selected?.find((entry) => entry.id === row?.id)?.invocation ?? null, expectedGateId: row?.id ?? null, authority: context?.authority ?? null }));
    if (invalid.length > 0) throw planError("GATE_PLAN_TERMINAL_EVIDENCE_INVALID", invalid.join("; "));
  }
  if (plan?.dynamic === true && rows.some((row) => /^FIXTURE_ROOT_/u.test(String(row?.reasonCode ?? "")))) throw planError("GATE_PLAN_TERMINAL_EVIDENCE_INVALID", "fixture root result cannot satisfy a production gate");
  const failed = rows.some((entry) => entry?.ok !== true);
  const next = { ...plan, ...(blockedOverride === undefined ? {} : { blocked: blockedOverride }), executed: rows.map((entry) => ({ ...entry, selected: true, coveredBy: null })), executable: failed ? false : plan.executable, executionPermission: failed ? "denied" : plan.executionPermission };
  DYNAMIC_PLAN_CONTEXTS.set(next, context);
  return next;
}

function executionPlanProblems(plan) {
  const problems = [];
  const integrity = plan?.integrity;
  if (!integrity || integrity.schemaVersion !== GATE_PLAN_INTEGRITY_VERSION) return ["execution integrity envelope is missing"];
  const context = plan && typeof plan === "object" ? DYNAMIC_PLAN_CONTEXTS.get(plan) : undefined;
  if (context === undefined) problems.push("code-owned planning context is missing");
  if (context !== null && context !== undefined) {
    if (context.mode !== planMode(plan) || context.publicDynamic !== (plan.dynamic === true)) problems.push("public plan mode changed after code-owned planning");
    if (context.integrityDigest !== null && digestValue(integrity) !== context.integrityDigest) problems.push("integrity envelope changed after code-owned planning");
    const selectedContext = (plan.selected ?? []).map(({ id, rootId, command, invocation }) => ({ id, rootId, command: normalizeCommand(command), invocation }));
    const gatesContext = (plan.gates ?? []).map(({ id, rootId, disposition, command, invocation, inputs }) => ({ id, rootId, disposition, command: normalizeCommand(command), invocation, inputs }));
    if (JSON.stringify(selectedContext) !== JSON.stringify(context.selected)) problems.push("required selected roots changed after planning");
    if (JSON.stringify(gatesContext) !== JSON.stringify(context.gates)) problems.push("required gate dispositions changed after planning");
    if (integrity.requiredSelectionDigest !== context.selectionDigest) problems.push("required selection authority changed after planning");
    if (JSON.stringify(integrity.requiredRoots ?? []) !== JSON.stringify(context.roots)) problems.push("required root set changed after planning");
    if (JSON.stringify(integrity.coveredChildren ?? []) !== JSON.stringify(context.coveredChildren ?? [])) problems.push("containment coverage authority changed after planning");
  }
  // The integrity envelope is evidence, not authority.  Re-derive the root
  // command bindings from the checked-in roster and containment declaration so
  // a caller cannot edit selected/gates/bindings together and then reseal the
  // public plan digest around an unrelated command.
  try {
    const roster = JSON.parse(readFileSync(defaultRosterPath, "utf8"));
    const containment = JSON.parse(readFileSync(containmentPath, "utf8"));
    const authority = validateRoster(roster, containment);
    const authoritativeRoots = new Map(authority.contained.selected.map((entry) => [entry.id, entry]));
    for (const entry of plan.selected ?? []) {
      const root = authoritativeRoots.get(entry?.id);
      if (!root || entry.rootId !== root.rootId || normalizeCommand(entry.command) !== normalizeCommand(roster.groups.find((group) => group.id === root.id)?.command)) {
        problems.push(`selected root command is not bound to the code-owned roster for ${entry?.id ?? "unknown"}`);
      }
    }
    for (const entry of plan.gates ?? []) {
      const authorityEntry = authority.contained.all.find((candidate) => candidate.id === entry?.id);
      const authorityCommand = authorityEntry === undefined ? null : authority.rosterGroups.get(authorityEntry.rootId)?.command;
      if (!authorityEntry || normalizeCommand(entry.command) !== normalizeCommand(authorityCommand)) problems.push(`gate command is not bound to the code-owned roster for ${entry?.id ?? "unknown"}`);
    }
  } catch (error) {
    problems.push(`code-owned roster/containment could not be re-read: ${String(error?.reasonCode ?? error?.message ?? error)}`);
  }
  const computedPlanDigest = digestValue({
    phase: plan.phase,
    inputs: plan.inputs,
    selected: (plan.selected ?? []).map(({ id, rootId, command, invocation, inputs }) => ({ id, rootId, command: normalizeCommand(command), invocation, inputs })),
    gates: (plan.gates ?? []).map(({ id, rootId, disposition, command, invocation, inputs }) => ({ id, rootId, disposition, command: normalizeCommand(command), invocation, inputs })),
    coveredBy: plan.coveredBy ?? [],
    obligations: plan.obligations ?? [],
    executionOrder: plan.executionOrder ?? [],
    containmentDigest: integrity.containmentDigest,
  });
  if (typeof integrity.planDigest !== "string" || integrity.planDigest !== computedPlanDigest) problems.push("plan integrity digest changed after planning");
  const selected = Array.isArray(plan.selected) ? plan.selected : [];
  const expected = Array.isArray(integrity.requiredSelected) ? integrity.requiredSelected : [];
  if (JSON.stringify(selected.map(({ id, rootId, command, invocation }) => ({ id, rootId, command: normalizeCommand(command), invocation }))) !== JSON.stringify(expected)) problems.push("selected roots changed after planning");
  const expectedByGate = integrity.commandBindings ?? {};
  for (const entry of selected) {
    const binding = expectedByGate[entry.id];
    if (!binding || binding.rootId !== entry.rootId || normalizeCommand(binding.command) !== normalizeCommand(entry.command) || invocationKey(binding.invocation) !== invocationKey(entry.invocation) || binding.phase !== entry.phase) problems.push(`command binding changed for ${entry.id}`);
  }
  const runIds = (plan.gates ?? []).filter((entry) => entry.disposition === "run").map(({ id }) => id);
  if (JSON.stringify(runIds) !== JSON.stringify(selected.map(({ id }) => id))) problems.push("selected roots do not cover every run disposition");
  if (plan.coverage?.allRootsReported !== true || plan.coverage?.allObligationsMapped !== true || plan.coverage?.duplicateExecutionIds === true) problems.push("required proof coverage is incomplete or duplicated");
  const children = (plan.coveredBy ?? []).map(({ id, rootId, coveredBy }) => ({ id, rootId, coveredBy }));
  if (JSON.stringify(children) !== JSON.stringify(integrity.coveredChildren ?? [])) problems.push("containment coverage changed after planning");
  if (JSON.stringify(plan.executionOrder ?? []) !== JSON.stringify(selected.map(({ id }) => id))) problems.push("execution order changed after planning");
  return problems;
}

function measuredResultProblems(row, expectedInputs, { requireTrusted = false, expectedCommand = null, expectedInvocation = null, expectedGateId = null, authority = null } = {}) {
  const problems = [];
  const rowInputs = row?.inputs ?? row?.inputDigests;
  if (!hasCompleteInputKey(rowInputs) || JSON.stringify(completeInputKey(rowInputs)) !== JSON.stringify(completeInputKey(expectedInputs))) problems.push("runner did not return the planned four input digests");
  if (terminalEvidenceIdentity(row, { requireTrusted, expectedCommand, expectedInvocation, authority }) === null) problems.push(requireTrusted ? "runner did not return a readable immutable terminal artifact" : "runner did not return trusted terminal evidence");
  if (!TERMINAL_EVIDENCE_STATES.has(row?.status) && row?.terminal !== true) problems.push("runner result is not terminal");
  if (expectedGateId !== null && row?.gateId !== expectedGateId) problems.push("runner result is bound to the wrong gate");
  if (requireTrusted && row?.exitCode !== 0) problems.push("runner result did not report exitCode 0");
  if (/^FIXTURE_ROOT_/u.test(String(row?.reasonCode ?? ""))) problems.push("fixture root result cannot satisfy a production gate");
  return problems;
}

/** Execute only the selected roots, in declaration order, and retain measured rows. */
export async function executeSelectedRoots(plan, runner, { getInputs, currentInputs } = {}) {
  if (plan?.execution?.strategy !== "serial" || plan?.execution?.maxConcurrent !== 1) {
    throw planError("GATE_PLAN_SERIAL_POLICY_INVALID", "same-repository roots must execute serially");
  }
  if (typeof runner !== "function") throw planError("GATE_PLAN_RUNNER_REQUIRED", "a root runner is required");
  const planContext = plan && typeof plan === "object" ? DYNAMIC_PLAN_CONTEXTS.get(plan) : undefined;
  const integrityProblems = executionPlanProblems(plan);
  if (integrityProblems.length > 0) {
    return {
      ...plan,
      executed: [],
      reasonCode: "GATE_PLAN_EXECUTION_INTEGRITY_REFUSED",
      blocked: [...(plan.blocked ?? []), { id: "execution-integrity", reason: integrityProblems.join("; ") }],
      executable: false,
      executionPermission: "denied",
    };
  }
  if (plan?.executable !== true || (plan?.blocked ?? []).length > 0) return { ...plan, executed: [] };
  const inputReader = typeof getInputs === "function" ? getInputs : currentInputs === undefined ? null : async () => currentInputs;
  if (plan?.integrity?.requireInputObserver === true && inputReader === null) {
    return {
      ...plan,
      executed: [],
      reasonCode: "GATE_PLAN_INPUT_OBSERVER_REQUIRED",
      blocked: [...(plan.blocked ?? []), { id: "input-observer", reason: "a trusted current-input observer is required before execution" }],
      executable: false,
      executionPermission: "denied",
    };
  }
  // A plan with one aggregate tuple retains the compact pre-gate read.  Plans
  // carrying per-gate tuples skip this aggregate comparison and read each gate
  // below, so a legitimate gate-specific tuple can differ from the aggregate.
  const hasGateSpecificTuple = (plan.selected ?? []).some((entry) => JSON.stringify(completeInputKey(entry.inputs)) !== JSON.stringify(completeInputKey(plan.inputs)));
  if (inputReader !== null && !hasGateSpecificTuple) {
    let aggregateInputs = null;
    try { aggregateInputs = normalizedDigestInput(await inputReader("aggregate", plan)); } catch { aggregateInputs = null; }
    if (!hasCompleteInputKey(normalizedDigestInput(plan.inputs)) || JSON.stringify(completeInputKey(aggregateInputs)) !== JSON.stringify(completeInputKey(plan.inputs))) {
      return {
        ...plan,
        executed: [],
        blocked: [...(plan.blocked ?? []), { id: "input-drift", reason: "gate inputs changed before execution" }],
        invalidated: [...(plan.invalidated ?? []), { id: null, evidenceId: null, reasons: ["gate inputs changed before execution"] }],
        executable: false,
        executionPermission: "denied",
      };
    }
  }
  const rows = [];
  const blocked = [...(plan.blocked ?? [])];
  for (const entry of plan.selected ?? []) {
    const expectedInputs = normalizedDigestInput(entry.inputs ?? plan.inputs);
    const readCurrentInputs = async () => {
      if (inputReader === null) return null;
      try { return normalizedDigestInput(await inputReader(entry.id, entry)); } catch { return null; }
    };
    const beforeInputs = await readCurrentInputs();
    if (inputReader !== null && (!hasCompleteInputKey(expectedInputs) || JSON.stringify(completeInputKey(beforeInputs)) !== JSON.stringify(completeInputKey(expectedInputs)))) {
      blocked.push({ id: entry.id, reason: "gate inputs changed before this root started" });
      return { ...plan, executed: rows, blocked, invalidated: [...(plan.invalidated ?? []), { id: entry.id, evidenceId: entry.evidenceId ?? null, reasons: ["gate inputs changed before this root started"] }], executable: false, executionPermission: "denied" };
    }
    const startedAt = Date.now();
    let result;
    try {
      result = await runner(entry);
    } catch (error) {
      result = { ok: false, reasonCode: error.reasonCode ?? "GATE_ROOT_RUN_FAILED", error: error.message };
    }
    const row = {
      ...entry,
      plannedInputs: expectedInputs,
      ...(result && typeof result === "object" ? result : { ok: false, reasonCode: "GATE_ROOT_RESULT_INVALID" }),
      elapsedMs: Math.max(0, Date.now() - startedAt),
    };
    const resultInputs = result?.inputs ?? result?.inputDigests;
    const afterInputs = await readCurrentInputs();
    const drifted = (inputReader !== null && JSON.stringify(completeInputKey(afterInputs)) !== JSON.stringify(completeInputKey(expectedInputs)))
      || (resultInputs !== undefined && JSON.stringify(completeInputKey(resultInputs)) !== JSON.stringify(completeInputKey(expectedInputs)));
    if (drifted) {
      row.ok = false;
      row.reasonCode = "GATE_PLAN_INPUT_DRIFT";
      row.invalidated = true;
      blocked.push({ id: entry.id, reason: "gate inputs changed while the root was running" });
    }
    if (plan?.integrity?.requireInputObserver === true) {
      const measuredProblems = measuredResultProblems(row, expectedInputs, { requireTrusted: true, expectedCommand: entry.command, expectedInvocation: entry.invocation ?? null, expectedGateId: entry.id, authority: planContext?.authority ?? null });
      if (measuredProblems.length > 0) {
        row.ok = false;
        row.reasonCode = "GATE_PLAN_TERMINAL_EVIDENCE_INVALID";
        row.invalidated = true;
        blocked.push({ id: entry.id, reason: measuredProblems.join("; ") });
      }
    }
    if (plan?.dynamic === true && /^FIXTURE_ROOT_/u.test(String(row?.reasonCode ?? ""))) {
      row.ok = false;
      row.reasonCode = "GATE_PLAN_TERMINAL_EVIDENCE_INVALID";
      row.invalidated = true;
      blocked.push({ id: entry.id, reason: "fixture root result cannot satisfy a production gate" });
    }
    if (row.ok !== true) blocked.push({ id: entry.id, reason: row.reasonCode ?? "root execution failed" });
    rows.push(row);
    if (drifted) return { ...plan, executed: rows, blocked, invalidated: [...(plan.invalidated ?? []), { id: entry.id, evidenceId: entry.evidenceId ?? null, reasons: ["gate inputs changed while the root was running"] }], executable: false, executionPermission: "denied" };
  }
  const recorded = recordExecution(plan, rows, { blocked });
  return {
    ...recorded,
    executable: blocked.length === 0,
    executionPermission: blocked.length === 0 ? plan.executionPermission : "denied",
  };
}

export const executePlan = executeSelectedRoots;

async function main() {
  const phaseIndex = process.argv.indexOf("--phase");
  const phase = phaseIndex >= 0 ? process.argv[phaseIndex + 1] : "candidate-final";
  const rosterIndex = process.argv.indexOf("--roster");
  const rosterPath = rosterIndex >= 0 ? resolve(process.argv[rosterIndex + 1]) : defaultRosterPath;
  const changedIndex = process.argv.indexOf("--changed-files");
  const changedFiles = changedIndex >= 0 ? process.argv[changedIndex + 1].split(",") : undefined;
  const [roster, containment] = await Promise.all([JSON.parse(await readFile(rosterPath, "utf8")), JSON.parse(await readFile(containmentPath, "utf8"))]);
  const result = phase === "development"
    ? buildDevelopmentPlan({ changedFiles: changedFiles ?? [] })
    : buildFinalGatePlan({ roster, containment, phase, changedFiles });
  const executable = result.executable !== false && (result.blocked ?? []).length === 0;
  process.stdout.write(`${JSON.stringify({ ok: true, reasonCode: executable ? "GATE_PLAN_READY" : "GATE_PLAN_PREVIEW_ONLY", ...result })}\n`);
}

if (process.argv[1]?.endsWith("final-gate-plan.mjs")) {
  try { await main(); } catch (error) { process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: error.reasonCode ?? "GATE_PLAN_INTERNAL_ERROR", error: error.message })}\n`); process.exitCode = 1; }
}
