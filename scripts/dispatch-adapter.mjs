#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Host-neutral native dispatch resolution.
//
// The engine owns the current workspace configuration and work record.  A host
// adapter asks for one resolution immediately before its native call, forwards
// the returned model/effort, and may retain the host call log as factual
// evidence.  No JSON handoff, receipt, generated task name, or host identity
// is required to start a valid task.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  materializeWorkspace,
  readDispatchConfig,
  resolveDispatch,
} from "../dist/build/packages/core/src/index.js";

export const DISPATCH_ADAPTER_VERSION = "tcrn.dispatch-adapter.v2";
export const DISPATCH_ADAPTER_HOSTS = Object.freeze(["claude-code", "codex"]);
export const AGENT_LIFECYCLE_SCHEMA_VERSION = "tcrn.agent-lifecycle.v1";
export const AGENT_LIFECYCLE_PHASES = Object.freeze(["task-pack", "rework", "decision", "acceptance", "clarification"]);
export const AGENT_LIFECYCLE_FRESH_PHASES = Object.freeze(["task-pack", "rework", "decision", "acceptance"]);

const PHASE_ALIASES = Object.freeze({
  "epic-pack": "task-pack",
  "story-pack": "task-pack",
  "new-pack": "task-pack",
  "new-task": "task-pack",
  "new-instance": "task-pack",
  "rework-round": "rework",
  "decision-round": "decision",
  "acceptance-round": "acceptance",
  clarify: "clarification",
});
const RUNNING_STATUSES = new Set(["running", "active", "in-progress", "in_progress"]);

const ENGINE_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const ENGINE_CLI = resolve(ENGINE_ROOT, "scripts/tcrn-workflow.mjs");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value, active = new Set()) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("number must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || active.has(value)) throw new TypeError("value is not a finite JSON object");
  active.add(value);
  const encoded = Array.isArray(value)
    ? `[${value.map((entry) => stableJson(entry, active) ?? "null").join(",")}]`
    : `{${Object.keys(value).sort().flatMap((key) => {
      const child = stableJson(value[key], active);
      return child === undefined ? [] : [`${JSON.stringify(key)}:${child}`];
    }).join(",")}}`;
  active.delete(value);
  return encoded;
}

function digest(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function digestBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function failure(reasonCode, error, details = {}) {
  return {
    schemaVersion: DISPATCH_ADAPTER_VERSION,
    ok: false,
    status: "rejected",
    executable: false,
    reasonCode,
    error,
    ...details,
  };
}

/** Read the authoritative scope from the native `work-show` envelope. */
export function storyScopeFromWorkShow(workShow) {
  const scope = workShow?.advisory?.scope;
  if (typeof scope !== "string" || scope.trim().length === 0) {
    return failure("DISPATCH_WORK_SCOPE_INVALID", "work-show did not expose a non-empty Story scope");
  }
  return { ok: true, scope, source: "work-show.advisory.scope" };
}

function reasonCode(error, fallback = "DISPATCH_RESOLUTION_FAILED") {
  return typeof error?.reasonCode === "string" ? error.reasonCode : fallback;
}

function text(value, field, maximum = 512) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum
    || value.includes("\u0000") || !value.isWellFormed()) {
    throw Object.assign(new Error(`${field} must be non-empty bounded text`), { reasonCode: "DISPATCH_INPUT_INVALID" });
  }
  return value;
}

function workspacePath(value) {
  const path = text(value, "workspace", 2_048);
  if (!isAbsolute(path)) throw Object.assign(new Error("workspace must be absolute"), { reasonCode: "DISPATCH_WORKSPACE_NOT_ABSOLUTE" });
  return resolve(path);
}

function field(value, names) {
  if (!isRecord(value)) return undefined;
  for (const name of names) if (Object.hasOwn(value, name)) return value[name];
  return undefined;
}

function lifecyclePhase(value) {
  const raw = field(value, ["phase", "roundType", "lifecyclePhase"]);
  return typeof raw === "string" ? PHASE_ALIASES[raw] ?? raw : raw;
}

function lifecycleText(value, location, maximum = 512) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !value.includes("\u0000") && value.isWellFormed()
    ? null
    : { field: location, code: "DISPATCH_LIFECYCLE_FIELD_INVALID", message: `${location} must be non-empty bounded text` };
}

function lifecycleBoolean(value, location) {
  return typeof value === "boolean"
    ? null
    : { field: location, code: "DISPATCH_LIFECYCLE_FIELD_INVALID", message: `${location} must be an explicit boolean` };
}

function evidenceEntries(value) {
  const entries = field(value, ["sourceEvidence", "source-evidence", "evidence"]);
  return Array.isArray(entries) ? entries : [];
}

function evidenceProblems(entries) {
  if (entries.length === 0) return { status: "unknown", problems: [], count: 0 };
  const problems = [];
  let unknown = 0;
  for (const [index, entry] of entries.entries()) {
    const location = `agentLifecycle.sourceEvidence[${index}]`;
    if (typeof entry === "string") {
      if (lifecycleText(entry, location, 1_024)) problems.push({ field: location, code: "DISPATCH_LIFECYCLE_EVIDENCE_INVALID", message: "evidence locator is invalid" });
      else unknown += 1;
      continue;
    }
    if (!isRecord(entry)) {
      problems.push({ field: location, code: "DISPATCH_LIFECYCLE_EVIDENCE_INVALID", message: "evidence entry must be an object or locator" });
      continue;
    }
    const kind = field(entry, ["kind", "source", "type"]);
    const locator = field(entry, ["locator", "path", "ref"]);
    const entryDigest = field(entry, ["digest", "sha256", "sourceDigest"]);
    const status = field(entry, ["status", "evidenceStatus"]);
    if (lifecycleText(kind, `${location}.kind`, 128)) problems.push({ field: `${location}.kind`, code: "DISPATCH_LIFECYCLE_EVIDENCE_INVALID", message: "evidence kind is invalid" });
    if (lifecycleText(locator, `${location}.locator`, 1_024)) problems.push({ field: `${location}.locator`, code: "DISPATCH_LIFECYCLE_EVIDENCE_INVALID", message: "evidence locator is invalid" });
    if (typeof kind === "string" && /prompt|self[-_ ]?assert|claim/iu.test(kind)
      || typeof locator === "string" && /prompt|self[-_ ]?assert|claim/iu.test(locator)) {
      problems.push({ field: location, code: "DISPATCH_LIFECYCLE_PROMPT_CLAIM_REJECTED", message: "prompt self-claims are not evidence" });
    }
    if (entryDigest !== undefined && entryDigest !== null && entryDigest !== "unknown"
      && (typeof entryDigest !== "string" || !/^[a-f0-9]{64}$/u.test(entryDigest))) {
      problems.push({ field: `${location}.digest`, code: "DISPATCH_LIFECYCLE_EVIDENCE_INVALID", message: "evidence digest is invalid" });
    }
    if (status !== undefined && status !== "verified" && status !== "unknown") {
      problems.push({ field: `${location}.status`, code: "DISPATCH_LIFECYCLE_EVIDENCE_INVALID", message: "evidence status is invalid" });
    }
    if (typeof entryDigest !== "string" || !/^[a-f0-9]{64}$/u.test(entryDigest) || status === "unknown") unknown += 1;
  }
  return { status: problems.length === 0 && unknown === 0 ? "verified" : "unknown", problems, count: entries.length };
}

/**
 * Validate the small lifecycle declaration used by the native host call.  It
 * checks work/role/Pack/phase and the fresh-instance rule, but does not require
 * a host-native role or provider field that a host may not expose.
 */
export function validateAgentLifecycle(value) {
  if (!isRecord(value)) {
    return {
      ok: false,
      checked: true,
      reasonCode: "DISPATCH_LIFECYCLE_REQUIRED",
      phase: null,
      problems: [{ field: "agentLifecycle", code: "DISPATCH_LIFECYCLE_REQUIRED", message: "agentLifecycle must be an object" }],
      sourceEvidence: { status: "unknown", count: 0 },
    };
  }
  const problems = [];
  const phase = lifecyclePhase(value);
  if (!AGENT_LIFECYCLE_PHASES.includes(phase)) {
    problems.push({ field: "agentLifecycle.phase", code: "DISPATCH_LIFECYCLE_PHASE_INVALID", message: "phase is not supported" });
  }
  const fresh = AGENT_LIFECYCLE_FRESH_PHASES.includes(phase);
  const role = field(value, ["role", "roleId"]);
  const pack = field(value, ["pack", "packId"]);
  const model = field(value, ["model", "requestedModel"]);
  const effort = field(value, ["effort", "reasoningEffort"]);
  for (const [name, candidate] of [["role", role], ["pack", pack], ["workId", field(value, ["workId", "work_id", "taskId", "task_id"])]] ) {
    const problem = lifecycleText(candidate, `agentLifecycle.${name}`, 256);
    if (problem) problems.push(problem);
  }
  if (fresh || !AGENT_LIFECYCLE_PHASES.includes(phase)) {
    for (const [name, candidate] of [["model", model], ["effort", effort]]) {
      const problem = lifecycleText(candidate, `agentLifecycle.${name}`, 256);
      if (problem) problems.push(problem);
    }
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== AGENT_LIFECYCLE_SCHEMA_VERSION) {
    problems.push({ field: "agentLifecycle.schemaVersion", code: "DISPATCH_LIFECYCLE_SCHEMA_INVALID", message: `schemaVersion must be ${AGENT_LIFECYCLE_SCHEMA_VERSION}` });
  }
  if (fresh && value.schemaVersion !== AGENT_LIFECYCLE_SCHEMA_VERSION) {
    problems.push({ field: "agentLifecycle.schemaVersion", code: "DISPATCH_LIFECYCLE_SCHEMA_INVALID", message: "fresh rounds require the lifecycle schema" });
  }
  const newInstance = field(value, ["newInstance", "new-instance"]);
  const forkTurns = field(value, ["forkTurns", "fork_turns", "fork-turns"]);
  const sameTaskRunning = field(value, ["sameTaskRunning", "same-task-running"]);
  const newProblem = lifecycleBoolean(newInstance, "agentLifecycle.newInstance");
  if (newProblem) problems.push(newProblem);
  if (fresh && newInstance !== true) problems.push({ field: "agentLifecycle.newInstance", code: "DISPATCH_LIFECYCLE_NEW_INSTANCE_REQUIRED", message: "fresh rounds require a new instance" });
  if (fresh && forkTurns !== "none") problems.push({ field: "agentLifecycle.forkTurns", code: "DISPATCH_LIFECYCLE_FORK_NONE_REQUIRED", message: "fresh rounds require forkTurns=none" });
  if (forkTurns !== undefined && forkTurns !== "none") problems.push({ field: "agentLifecycle.forkTurns", code: "DISPATCH_LIFECYCLE_FORK_FORBIDDEN", message: "forkTurns must be none" });
  if (fresh && sameTaskRunning === true) problems.push({ field: "agentLifecycle.sameTaskRunning", code: "DISPATCH_LIFECYCLE_RUNNING_TASK_REQUIRES_CLARIFICATION", message: "a fresh round cannot reuse running work" });
  if (phase === "clarification") {
    if (sameTaskRunning !== true) problems.push({ field: "agentLifecycle.sameTaskRunning", code: "DISPATCH_LIFECYCLE_CLARIFICATION_BINDING_REQUIRED", message: "clarification requires sameTaskRunning=true" });
    if (newInstance !== false) problems.push({ field: "agentLifecycle.newInstance", code: "DISPATCH_LIFECYCLE_CLARIFICATION_RESTART_REJECTED", message: "clarification keeps the current instance" });
  }
  const predecessor = field(value, ["predecessor", "previousAgent", "previous_agent"]);
  let predecessorSummary = null;
  if (predecessor !== undefined && predecessor !== null) {
    if (!isRecord(predecessor)) {
      problems.push({ field: "agentLifecycle.predecessor", code: "DISPATCH_LIFECYCLE_PREDECESSOR_INVALID", message: "predecessor must be an object" });
    } else {
      const predecessorId = field(predecessor, ["agentId", "agent_id", "id"]);
      const predecessorStatus = field(predecessor, ["status", "state"]);
      const idProblem = lifecycleText(predecessorId, "agentLifecycle.predecessor.agentId", 256);
      const statusProblem = lifecycleText(predecessorStatus, "agentLifecycle.predecessor.status", 128);
      if (idProblem) problems.push(idProblem);
      if (statusProblem) problems.push(statusProblem);
      if (typeof predecessorId === "string" && predecessorId === field(value, ["agentId", "agent_id", "childAgentId", "child_agent_id"])) {
        problems.push({ field: "agentLifecycle.agentId", code: "DISPATCH_LIFECYCLE_AGENT_REUSED", message: "a fresh round cannot reuse its predecessor agent id" });
      }
      if (fresh && typeof predecessorStatus === "string" && RUNNING_STATUSES.has(predecessorStatus.trim().toLowerCase())) {
        problems.push({ field: "agentLifecycle.predecessor.status", code: "DISPATCH_LIFECYCLE_RUNNING_PREDECESSOR", message: "a running predecessor is not a fresh-round input" });
      }
      predecessorSummary = { agentId: typeof predecessorId === "string" ? predecessorId : null, status: typeof predecessorStatus === "string" ? predecessorStatus : null };
    }
  }
  const evidence = evidenceProblems(evidenceEntries(value));
  problems.push(...evidence.problems);
  return {
    ok: problems.length === 0,
    checked: true,
    reasonCode: problems.length === 0
      ? evidence.status === "verified" ? "DISPATCH_LIFECYCLE_VALID" : "DISPATCH_LIFECYCLE_VALID_EVIDENCE_UNKNOWN"
      : "DISPATCH_LIFECYCLE_INVALID",
    phase,
    freshRound: fresh,
    role: typeof role === "string" ? role : null,
    pack: typeof pack === "string" ? pack : null,
    model: typeof model === "string" ? model : null,
    effort: typeof effort === "string" ? effort : null,
    workId: field(value, ["workId", "work_id", "taskId", "task_id"]) ?? null,
    agentId: field(value, ["agentId", "agent_id", "childAgentId", "child_agent_id"]) ?? null,
    newInstance: typeof newInstance === "boolean" ? newInstance : null,
    forkTurns: typeof forkTurns === "string" ? forkTurns : null,
    sameTaskRunning: typeof sameTaskRunning === "boolean" ? sameTaskRunning : null,
    predecessor: predecessorSummary,
    sourceEvidence: { status: evidence.status, count: evidence.count },
    problems,
  };
}

function lifecycleMismatch(expected, actual) {
  const problems = [];
  for (const name of ["workId", "phase", "role", "pack", "model", "effort", "newInstance", "forkTurns", "sameTaskRunning"]) {
    const expectedValue = expected?.[name];
    const actualValue = actual?.[name];
    if (expectedValue !== null && expectedValue !== undefined && actualValue !== null && actualValue !== undefined && expectedValue !== actualValue) {
      problems.push({ field: `observedLifecycle.${name}`, code: "DISPATCH_LIFECYCLE_BINDING_MISMATCH", message: `observed ${name} differs from the declaration` });
    }
  }
  if (expected?.predecessor !== null && expected?.predecessor !== undefined
    && actual?.predecessor !== null && actual?.predecessor !== undefined
    && (expected.predecessor.agentId !== actual.predecessor.agentId || expected.predecessor.status !== actual.predecessor.status)) {
    problems.push({ field: "observedLifecycle.predecessor", code: "DISPATCH_LIFECYCLE_BINDING_MISMATCH", message: "observed predecessor differs from the declaration" });
  }
  return problems;
}

/**
 * Compare a lifecycle declaration with an optional host observation.  Missing
 * observations are explicit unknowns.  Native role/provider fields are not
 * required and never turn an otherwise valid dispatch red.
 */
export function validateAgentLifecycleEvidence(declared, observed) {
  const declaredResult = validateAgentLifecycle(declared);
  if (!declaredResult.ok) return { ok: false, status: "red", reasonCode: "DISPATCH_LIFECYCLE_EVIDENCE_RED", declared: declaredResult, observed: null, missing: [], problems: declaredResult.problems };
  if (!isRecord(observed)) {
    return {
      ok: false,
      status: "unknown",
      reasonCode: "DISPATCH_LIFECYCLE_FACTS_UNKNOWN",
      declared: declaredResult,
      observed: null,
      missing: ["native role/provider/turn context"],
      problems: [],
    };
  }
  const observedResult = validateAgentLifecycle(observed);
  const problems = lifecycleMismatch(declaredResult, observedResult);
  if (!observedResult.ok) {
    const relevant = observedResult.problems.filter((problem) => !/agentLifecycle\.(?:role|pack|model|effort|workId|phase|newInstance|forkTurns|sameTaskRunning)/u.test(problem.field ?? ""));
    problems.push(...relevant);
  }
  if (problems.length > 0) return { ok: false, status: "red", reasonCode: "DISPATCH_LIFECYCLE_EVIDENCE_RED", declared: declaredResult, observed: observedResult, missing: [], problems };
  const missing = ["native role/provider/turn context"].filter(() => field(observed, ["nativeRole", "agentRole", "provider", "providerIdentity"]) === undefined);
  return {
    ok: true,
    status: missing.length === 0 && observedResult.sourceEvidence.status === "verified" ? "green" : "unknown",
    reasonCode: missing.length === 0 && observedResult.sourceEvidence.status === "verified" ? "DISPATCH_LIFECYCLE_EVIDENCE_VERIFIED" : "DISPATCH_LIFECYCLE_FACTS_PARTIAL",
    declared: declaredResult,
    observed: observedResult,
    missing,
    problems: [],
  };
}

function sourceFor(state, config) {
  return {
    kind: "engine-workspace-dispatch-config",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    configDigest: digest({ classes: config.classes, tiers: config.tiers, modes: config.modes, mode: config.mode }),
  };
}

function resolutionFrom(config, source, { host, taskClass, mode }) {
  const selectedMode = mode ?? config.mode;
  const resolution = resolveDispatch(config, host, taskClass, selectedMode);
  const exactTier = resolution.value !== null && resolution.resolvedTier === resolution.requestedTier;
  const executable = resolution.dispatch === true && exactTier;
  const reason = resolution.value === null
    ? "DISPATCH_RESOLUTION_EMPTY"
    : !exactTier
      ? "DISPATCH_TIER_VALUE_MISSING"
      : resolution.dispatch !== true
        ? "DISPATCH_CLASS_NOT_DISPATCHABLE"
        : "DISPATCH_RESOLUTION_READY";
  return {
    schemaVersion: DISPATCH_ADAPTER_VERSION,
    ok: executable,
    status: "resolved",
    executable,
    reasonCode: reason,
    source,
    resolution,
  };
}

export async function resolveDispatchRequest({ workspace, host, taskClass, mode } = {}) {
  let path;
  try {
    path = workspacePath(workspace);
    text(host, "host", 128);
    text(taskClass, "taskClass", 128);
    if (mode !== undefined) text(mode, "mode", 128);
  } catch (error) {
    return failure(reasonCode(error, "DISPATCH_INPUT_INVALID"), String(error?.message ?? error));
  }
  if (!DISPATCH_ADAPTER_HOSTS.includes(host)) {
    return failure("DISPATCH_HOST_UNSUPPORTED", `host ${host} is not supported by the native adapter`, { host, taskClass, mode: mode ?? null });
  }
  try {
    const state = await materializeWorkspace(path);
    const config = readDispatchConfig(state.settings);
    return {
      ...resolutionFrom(config, sourceFor(state, config), { host, taskClass, mode }),
      workspace: path,
      workspaceId: state.metadata.workspaceId,
    };
  } catch (error) {
    return failure(reasonCode(error), String(error?.message ?? error), { workspace: path, host, taskClass, mode: mode ?? null });
  }
}

function invocationValue(value, names) {
  return field(value, names);
}

function liveWorkRead(workspace, workId) {
  const result = spawnSync(process.execPath, [ENGINE_CLI, "work-show", "--workspace", workspace, "--id", workId], {
    cwd: ENGINE_ROOT,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) return failure("DISPATCH_WORK_READ_FAILED", "current work-show could not be read", { stderr: String(result.stderr ?? result.error?.message ?? "") });
  try {
    const envelope = JSON.parse(String(result.stdout ?? ""));
    const record = envelope?.record;
    if (!isRecord(record) || record.id !== workId) return failure("DISPATCH_WORK_BINDING_MISMATCH", "work-show returned a different work item", { expected: workId, actual: record?.id ?? null });
    if (record.tombstone !== false || !["ready", "active"].includes(record.status)) return failure("DISPATCH_WORK_NOT_READY", "the bound work item is not ready for dispatch", { status: record.status ?? null, tombstone: record.tombstone ?? null });
    const scope = storyScopeFromWorkShow(envelope);
    if (!scope.ok) return scope;
    return { ok: true, envelope, record, scope: scope.scope };
  } catch (error) {
    return failure("DISPATCH_WORK_READ_INVALID", "current work-show is not readable JSON", { error: String(error?.message ?? error) });
  }
}

function preparedMatchesCurrent(prepared, current) {
  if (!prepared || prepared.schemaVersion !== DISPATCH_ADAPTER_VERSION || prepared.executable !== true) return { ok: false, reasonCode: "DISPATCH_RESOLUTION_NOT_EXECUTABLE", error: "an executable current resolution is required" };
  if (prepared.workspaceId !== current.workspaceId || prepared.resolution?.host !== current.resolution?.host || prepared.resolution?.taskClass !== current.resolution?.taskClass || prepared.resolution?.mode !== current.resolution?.mode || digest(prepared.resolution) !== digest(current.resolution)) {
    return { ok: false, reasonCode: "DISPATCH_RESOLUTION_DRIFT", error: "the supplied resolution differs from the current engine resolution" };
  }
  if (prepared.source?.workspaceId !== current.source?.workspaceId || prepared.source?.configDigest !== current.source?.configDigest) {
    return { ok: false, reasonCode: "DISPATCH_CONFIG_DRIFT", error: "dispatch configuration changed after resolution" };
  }
  return { ok: true };
}

/** Build the exact model/effort and lifecycle values sent to a native spawn. */
export function buildNativeSpawnInput(prepared, lifecycle) {
  if (!prepared || prepared.schemaVersion !== DISPATCH_ADAPTER_VERSION || prepared.executable !== true || !isRecord(prepared.resolution?.value)) {
    return failure("DISPATCH_RESOLUTION_NOT_EXECUTABLE", "an executable current resolution is required before spawn");
  }
  if (!isRecord(lifecycle)) return failure("DISPATCH_LIFECYCLE_REQUIRED", "a lifecycle declaration is required before spawn");
  const workId = invocationValue(lifecycle, ["workId", "work_id", "taskId", "task_id"]);
  if (typeof workId !== "string" || workId.trim().length === 0) return failure("DISPATCH_WORK_BINDING_REQUIRED", "lifecycle workId is required before spawn");
  const value = prepared.resolution.value;
  const declared = {
    ...lifecycle,
    model: Object.hasOwn(lifecycle, "model") ? lifecycle.model : value.model,
    effort: Object.hasOwn(lifecycle, "effort") ? lifecycle.effort : value.effort,
  };
  const lifecycleResult = validateAgentLifecycle(declared);
  if (!lifecycleResult.ok) return failure("DISPATCH_LIFECYCLE_INVALID", "lifecycle declaration is not dispatchable", { lifecycle: lifecycleResult });
  if (declared.model !== value.model) return failure("DISPATCH_MODEL_MISMATCH", "lifecycle model does not match the engine resolution", { expected: value.model, actual: declared.model });
  if (declared.effort !== value.effort) return failure("DISPATCH_EFFORT_MISMATCH", "lifecycle effort does not match the engine resolution", { expected: value.effort, actual: declared.effort });
  return {
    schemaVersion: DISPATCH_ADAPTER_VERSION,
    ok: true,
    status: "ready",
    reasonCode: "DISPATCH_NATIVE_SPAWN_READY",
    source: prepared.source,
    resolution: prepared.resolution,
    spawn: { model: value.model, effort: value.effort },
    lifecycle: declared,
  };
}

/**
 * Validate a factual native invocation against a fresh engine resolution and
 * relevant live work record.  Version/head observations remain useful log
 * fields, but an unrelated chain append is not a dispatch veto.
 */
export async function validateDispatchInvocation({ prepared, workspace, host, taskClass, mode, invocation, lifecycle, observedLifecycle, workId, scopeDigest } = {}) {
  let current;
  if (prepared !== undefined) {
    if (!prepared || prepared.schemaVersion !== DISPATCH_ADAPTER_VERSION || prepared.executable !== true) return failure("DISPATCH_RESOLUTION_NOT_EXECUTABLE", "an executable current resolution is required");
    current = await resolveDispatchRequest({
      workspace: prepared.workspace,
      host: prepared.resolution?.host,
      taskClass: prepared.resolution?.taskClass,
      mode: prepared.resolution?.mode,
    });
    const preparedCheck = preparedMatchesCurrent(prepared, current);
    if (!preparedCheck.ok) return failure(preparedCheck.reasonCode, preparedCheck.error, { current });
  } else {
    current = await resolveDispatchRequest({ workspace, host, taskClass, mode });
    if (!current.ok || current.executable !== true) return failure("DISPATCH_REPARSE_REFUSED", "the current engine resolution is not executable", { current });
  }
  if (!current.ok || current.executable !== true) return failure("DISPATCH_REPARSE_REFUSED", "the current engine resolution is not executable", { current });

  const actualModel = invocationValue(invocation, ["model", "requestedModel"]);
  const actualEffort = invocationValue(invocation, ["effort", "reasoningEffort", "reasoning_effort"]);
  if (typeof actualModel !== "string" || actualModel.trim().length === 0) return failure("DISPATCH_SPAWN_INPUT_MISSING", "native invocation did not expose model");
  if (typeof actualEffort !== "string" || actualEffort.trim().length === 0) return failure("DISPATCH_SPAWN_INPUT_MISSING", "native invocation did not expose effort");
  if (actualModel !== current.resolution.value.model) return failure("DISPATCH_MODEL_MISMATCH", "native invocation model does not match the engine resolution", { expected: current.resolution.value.model, actual: actualModel });
  if (actualEffort !== current.resolution.value.effort) return failure("DISPATCH_EFFORT_MISMATCH", "native invocation effort does not match the engine resolution", { expected: current.resolution.value.effort, actual: actualEffort });

  if (!isRecord(lifecycle)) return failure("DISPATCH_LIFECYCLE_REQUIRED", "a lifecycle declaration is required for native dispatch");
  const declared = {
    ...lifecycle,
    model: Object.hasOwn(lifecycle, "model") ? lifecycle.model : current.resolution.value.model,
    effort: Object.hasOwn(lifecycle, "effort") ? lifecycle.effort : current.resolution.value.effort,
  };
  const lifecycleResult = validateAgentLifecycle(declared);
  if (!lifecycleResult.ok) return failure("DISPATCH_LIFECYCLE_INVALID", "lifecycle declaration is not dispatchable", { lifecycle: lifecycleResult });
  const boundWorkId = workId ?? invocationValue(lifecycle, ["workId", "work_id", "taskId", "task_id"]) ?? invocationValue(invocation, ["workId", "work_id", "taskId", "task_id"]);
  if (typeof boundWorkId !== "string" || boundWorkId.trim().length === 0) return failure("DISPATCH_WORK_BINDING_REQUIRED", "a work id is required for native dispatch");
  const declaredWorkId = invocationValue(lifecycle, ["workId", "work_id", "taskId", "task_id"]);
  const invocationWorkId = invocationValue(invocation, ["workId", "work_id", "taskId", "task_id"]);
  if (declaredWorkId !== undefined && declaredWorkId !== boundWorkId) return failure("DISPATCH_WORK_BINDING_MISMATCH", "lifecycle work id does not match the bound work", { expected: boundWorkId, actual: declaredWorkId });
  if (invocationWorkId !== undefined && invocationWorkId !== boundWorkId) return failure("DISPATCH_WORK_BINDING_MISMATCH", "native invocation work id does not match the lifecycle binding", { expected: boundWorkId, actual: invocationWorkId });
  const live = liveWorkRead(current.workspace, boundWorkId);
  if (!live.ok) return live;
  const expectedScopeDigest = scopeDigest ?? invocationValue(invocation, ["scopeDigest", "workScopeDigest"]) ?? invocationValue(lifecycle, ["scopeDigest", "workScopeDigest"]);
  if (expectedScopeDigest !== undefined && expectedScopeDigest !== live.record.scopeDigest) {
    return failure("DISPATCH_SCOPE_MISMATCH", "native invocation scope differs from the current work-show", { expected: live.record.scopeDigest ?? null, actual: expectedScopeDigest });
  }
  const expectedScope = invocationValue(invocation, ["scope", "storyScope", "workScope"]) ?? invocationValue(lifecycle, ["scope", "storyScope", "workScope"]);
  const liveScope = live.envelope?.advisory?.scope;
  if (expectedScope !== undefined && (typeof liveScope !== "string" || expectedScope !== liveScope)) {
    return failure("DISPATCH_SCOPE_MISMATCH", "native invocation scope differs from the current work-show", { expected: liveScope ?? null, actual: expectedScope });
  }
  const evidence = validateAgentLifecycleEvidence(declared, observedLifecycle);
  if (evidence.status === "red") return failure("DISPATCH_LIFECYCLE_EVIDENCE_RED", "native lifecycle facts contradict the declaration", { lifecycle: evidence });
  return {
    schemaVersion: DISPATCH_ADAPTER_VERSION,
    ok: true,
    status: "validated",
    reasonCode: "DISPATCH_NATIVE_INVOCATION_VALID",
    source: current.source,
    resolution: current.resolution,
    invocation: { model: actualModel, effort: actualEffort, workId: boundWorkId, scopeDigest: live.record.scopeDigest ?? null },
    lifecycle: evidence,
    work: { id: live.record.id, revision: live.record.revision, scopeDigest: live.record.scopeDigest, scope: live.scope, status: live.record.status },
    observations: {
      nativeRole: invocationValue(observedLifecycle, ["nativeRole", "agentRole"]) ?? null,
      provider: invocationValue(observedLifecycle, ["provider", "providerIdentity"]) ?? null,
      status: evidence.status,
    },
  };
}

function argument(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
}

function jsonFile(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw Object.assign(new Error(`${label} is not readable JSON: ${error?.message ?? error}`), { reasonCode: "DISPATCH_INPUT_INVALID" }); }
}

async function main(argv) {
  const workspace = argument(argv, "workspace");
  const host = argument(argv, "host");
  const taskClass = argument(argv, "class");
  const mode = argument(argv, "mode");
  if (!workspace || !host || !taskClass) return failure("DISPATCH_ARGUMENT_MISSING", "--workspace, --host, and --class are required");
  const prepared = await resolveDispatchRequest({ workspace, host, taskClass, mode });
  const lifecyclePath = argument(argv, "lifecycle");
  const observedPath = argument(argv, "observed");
  const invocation = {
    model: argument(argv, "model"),
    effort: argument(argv, "effort"),
    workId: argument(argv, "work-id"),
    scopeDigest: argument(argv, "scope-digest"),
  };
  const hasValidationInput = Object.values(invocation).some((value) => value !== undefined) || lifecyclePath !== undefined || observedPath !== undefined;
  if (!hasValidationInput) return prepared;
  let lifecycle;
  let observed;
  try {
    lifecycle = lifecyclePath === undefined ? undefined : jsonFile(lifecyclePath, "lifecycle");
    observed = observedPath === undefined ? undefined : jsonFile(observedPath, "observed");
  } catch (error) {
    return failure(reasonCode(error, "DISPATCH_INPUT_INVALID"), String(error?.message ?? error));
  }
  return validateDispatchInvocation({ prepared, invocation, lifecycle, observedLifecycle: observed });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\\n`);
    if (result.ok !== true) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failure(reasonCode(error), String(error?.message ?? error)))}\\n`);
    process.exitCode = 1;
  }
}
