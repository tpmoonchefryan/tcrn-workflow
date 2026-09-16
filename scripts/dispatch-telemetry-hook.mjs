#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-372 — fail-open SubagentStart/SubagentStop telemetry hook.
//
// The hook records a bounded fact envelope only. It never stores the hook body,
// transcript, prompt, tool output, or model response. A host that cannot provide a
// fact leaves that field null; requested configuration is never copied into the
// observed model field.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  activeBinding,
  appendTelemetryRecord,
  createTelemetryRecord,
  materializeWorkspace,
} from "../dist/build/packages/core/src/index.js";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const PLATFORM_ROOT = resolve(SCRIPT_DIRECTORY, "../../..");
export const DEFAULT_PARTITION = "cross-project";
export const TELEMETRY_EVENTS = Object.freeze({ SubagentStart: "subagent-start", SubagentStop: "subagent-stop" });
export const UNKNOWN_VALUES = Object.freeze(["unknown", "unavailable", "unidentified", "unidentified-model", "redacted", "n/a", "none"]);
const CHAIN_DIRECTORY = [".tcrn", "workspace"].join("-");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value, maximum = 256, { preserveUnknown = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\u0000") || !value.isWellFormed()) return null;
  if (!preserveUnknown && UNKNOWN_VALUES.includes(value.trim().toLowerCase())) return null;
  return value;
}

function boundedUtf8(value, maximum) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length <= maximum) return bytes.toString("utf8");
  let end = maximum;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function inputScopes(input) {
  return [
    input,
    input?.payload,
    input?.subagent,
    input?.agent,
    input?.lifecycle,
    input?.agentLifecycle,
    input?.payload?.lifecycle,
    input?.payload?.agentLifecycle,
  ].filter(isRecord);
}

// Configuration is allowed to describe the requested lifecycle, but it is not
// an observation of what a host actually ran.  Keep an explicit observation
// view for fields such as observedModel so requested values cannot accidentally
// promote themselves into observed telemetry.
function observationScopes(input) {
  return [
    input,
    input?.payload,
    input?.subagent,
    input?.agent,
    input?.observation,
    input?.observed,
    input?.actual,
    input?.observationEnvelope,
    input?.payload?.observation,
    input?.payload?.observed,
    input?.payload?.actual,
    input?.payload?.observationEnvelope,
  ].filter(isRecord);
}

function declarationScopes(input) {
  return [
    input?.lifecycle,
    input?.agentLifecycle,
    input?.payload?.lifecycle,
    input?.payload?.agentLifecycle,
  ].filter(isRecord);
}

function inputField(input, names, env, envName, maximum = 256, { scope = "all", preserveUnknown = false } = {}) {
  const values = [];
  const scopes = scope === "observation" ? observationScopes(input) : scope === "declaration" ? declarationScopes(input) : inputScopes(input);
  for (const candidate of scopes) {
    for (const name of names) values.push(candidate[name]);
  }
  for (const name of Array.isArray(envName) ? envName : [envName]) values.push(env?.[name]);
  return boundedText(firstDefined(...values), maximum, { preserveUnknown });
}

function observedModelObservation(input, env) {
  const explicit = [];
  const generic = [];
  for (const scope of observationScopes(input)) {
    for (const name of ["observed_model", "observedModel"]) explicit.push(scope[name]);
    for (const name of ["model", "model_name", "modelName"]) generic.push(scope[name]);
  }
  explicit.push(env?.TCRN_TELEMETRY_OBSERVED_MODEL, env?.TCRN_OBSERVED_MODEL);
  const bounded = (values) => values
    .filter((value) => value !== undefined && value !== null)
    .map((value) => boundedText(value, 256, { preserveUnknown: true }))
    .filter((value) => value !== null);
  const explicitValues = bounded(explicit);
  const genericValues = bounded(generic);
  const explicitKnown = [...new Set(explicitValues.filter((value) => !unknownText(value)))];
  const genericKnown = [...new Set(genericValues.filter((value) => !unknownText(value)))];
  if (explicitKnown.length > 1 || genericKnown.length > 1 || (explicitKnown.length > 0 && genericKnown.length > 0 && explicitKnown[0] !== genericKnown[0])) {
    return {
      value: null,
      status: "ambiguous",
      candidates: { explicit: explicitValues, generic: genericValues },
    };
  }
  const value = explicitValues[0] ?? genericValues[0] ?? null;
  return {
    value,
    status: value === null || unknownText(value) ? "unknown" : "available",
    candidates: { explicit: explicitValues, generic: genericValues },
  };
}

function numeric(value) {
  if (typeof value === "string" && value.trim().length > 0) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function booleanValue(input, env, names, envNames) {
  const values = [];
  for (const scope of inputScopes(input)) for (const name of names) values.push(scope[name]);
  for (const name of Array.isArray(envNames) ? envNames : [envNames]) values.push(env?.[name]);
  const value = firstDefined(...values);
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function sourceEvidence(input, env) {
  const values = [];
  for (const scope of inputScopes(input)) for (const name of ["sourceEvidence", "source_evidence", "evidence"]) values.push(scope[name]);
  values.push(env?.TCRN_LIFECYCLE_SOURCE_EVIDENCE, env?.TCRN_DISPATCH_SOURCE_EVIDENCE);
  const raw = firstDefined(...values);
  if (!Array.isArray(raw)) return null;
  const bounded = raw.slice(0, 8).map((entry) => {
    if (typeof entry === "string") return boundedText(entry, 512, { preserveUnknown: true });
    if (!isRecord(entry)) return null;
    const kind = boundedText(firstDefined(entry.kind, entry.source, entry.type), 128, { preserveUnknown: true });
    const locator = boundedText(firstDefined(entry.locator, entry.path, entry.ref), 512, { preserveUnknown: true });
    if (kind === null || locator === null || /prompt|self[-_ ]?assert|claim/u.test(`${kind} ${locator}`)) return null;
    const digest = firstDefined(entry.digest, entry.sha256, entry.sourceDigest);
    if (digest !== undefined && digest !== null && digest !== "unknown" && (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest))) return null;
    const status = firstDefined(entry.status, entry.evidenceStatus);
    if (status !== undefined && status !== "verified" && status !== "unknown") return null;
    return {
      kind,
      locator,
      ...(digest === undefined || digest === null ? {} : { digest }),
      ...(status === undefined ? {} : { status }),
    };
  }).filter((entry) => entry !== null);
  return bounded.length === 0 ? null : bounded;
}

function sourceEvidenceStatus(evidence) {
  return sourceEvidenceSummary(evidence).status;
}

function unknownText(value) {
  return typeof value === "string" && UNKNOWN_VALUES.includes(value.trim().toLowerCase());
}

// Availability answers whether a usable locator survived the bounded hook
// envelope.  Verifiability is deliberately separate: a locator without a
// digest, an explicit unknown string/object, or an unknown status cannot be
// promoted to verified lifecycle evidence.
function sourceEvidenceSummary(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return { availability: "unknown", verifiability: "unknown", status: "unknown" };
  let locatorAvailable = true;
  let verified = true;
  for (const entry of evidence) {
    if (typeof entry === "string") {
      if (unknownText(entry) || entry.trim().length === 0) locatorAvailable = false;
      verified = false;
      continue;
    }
    if (!isRecord(entry)) {
      locatorAvailable = false;
      verified = false;
      continue;
    }
    const locator = firstDefined(entry.locator, entry.path, entry.ref);
    const digest = firstDefined(entry.digest, entry.sha256, entry.sourceDigest);
    const status = firstDefined(entry.status, entry.evidenceStatus);
    if (typeof locator !== "string" || locator.length === 0 || unknownText(locator) || unknownText(digest) || status === "unknown") locatorAvailable = false;
    if (unknownText(digest) || typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest) || status === "unknown") verified = false;
  }
  const availability = locatorAvailable ? "available" : "unknown";
  const verifiability = verified ? "verified" : "unknown";
  return { availability, verifiability, status: verified ? "available" : "unknown" };
}

function usageFrom(input, env) {
  const scopes = inputScopes(input);
  const raw = firstDefined(
    ...scopes.flatMap((scope) => [scope.usage, scope.token_usage, scope.tokenUsage, scope.tokenUse]),
  );
  const usage = isRecord(raw) ? raw : {};
  const read = (names, envName) => {
    const values = [];
    for (const scope of scopes) for (const name of names) values.push(scope[name]);
    for (const name of names) values.push(usage[name]);
    values.push(env?.[envName]);
    return numeric(firstDefined(...values));
  };
  const result = {
    inputTokens: read(["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"], "TCRN_TELEMETRY_INPUT_TOKENS"),
    outputTokens: read(["outputTokens", "output_tokens", "completionTokens", "completion_tokens"], "TCRN_TELEMETRY_OUTPUT_TOKENS"),
    totalTokens: read(["totalTokens", "total_tokens"], "TCRN_TELEMETRY_TOTAL_TOKENS"),
  };
  return Object.values(result).some((value) => value !== null) ? result : null;
}

// A dispatch adapter may attach the engine's resolution to the host hook
// envelope. These are bounded provenance facts, not a model identity claim:
// observedModel remains sourced only from the stop observation path above.
function dispatchResolutionFacts(input, env) {
  const scopes = observationScopes(input);
  const resolution = firstDefined(
    ...scopes.flatMap((scope) => [scope.dispatchResolution, scope.dispatch_resolution, scope.resolution]),
    env?.TCRN_DISPATCH_RESOLUTION,
  );
  const sources = [resolution, resolution?.source, resolution?.resolution, resolution?.currentSource, ...scopes];
  const value = (names) => firstDefined(...sources.flatMap((scope) => names.map((name) => scope?.[name])));
  const version = numeric(value(["configVersion", "configurationVersion", "dispatchConfigVersion", "version"]));
  const configDigest = boundedText(value(["configDigest", "configurationDigest", "dispatchConfigDigest"]), 64, { preserveUnknown: true });
  const resolutionStatus = boundedText(value(["status", "resolutionStatus"]), 64, { preserveUnknown: true });
  const source = boundedText(value(["sourceKind", "resolutionSource", "kind"]), 128, { preserveUnknown: true });
  return {
    configVersion: version,
    configDigest,
    resolutionStatus,
    resolutionSource: source,
  };
}

function hostArgument(argv = process.argv.slice(2)) {
  const index = argv.findIndex((value) => value === "--host");
  if (index < 0) return null;
  const value = argv[index + 1];
  return value === "claude" || value === "codex" ? value : null;
}

function eventName(input, env) {
  return firstDefined(input?.hook_event_name, input?.hookEventName, env?.TCRN_TELEMETRY_EVENT);
}

function eventAt(input, env, now) {
  const candidate = firstDefined(input?.at, input?.timestamp, input?.occurred_at, input?.occurredAt, env?.TCRN_TELEMETRY_AT);
  if (typeof candidate === "string" && !Number.isNaN(Date.parse(candidate))) return candidate;
  return now();
}

export function workspaceForPartition(partition = DEFAULT_PARTITION, containerRoot = PLATFORM_ROOT) {
  return resolve(containerRoot, CHAIN_DIRECTORY, String(partition), "workspace");
}

async function telemetryRoot(input, env, containerRoot) {
  const supplied = boundedText(env?.TCRN_TELEMETRY_ROOT, 1_024);
  if (supplied !== null && supplied.startsWith("/")) return supplied;
  const partition = boundedText(env?.TCRN_TELEMETRY_PARTITION, 128) ?? DEFAULT_PARTITION;
  const workspace = boundedText(env?.TCRN_TELEMETRY_WORKSPACE, 1_024) ?? workspaceForPartition(partition, containerRoot);
  const state = await materializeWorkspace(workspace);
  return activeBinding(state.metadata).find((root) => root.kind === "transient")?.path ?? null;
}

function payloadFor(input, env, kind) {
  const requestedModel = inputField(input, ["requested_model", "requestedModel", "model_requested"], env, ["TCRN_TELEMETRY_REQUESTED_MODEL", "TCRN_DISPATCH_REQUESTED_MODEL"]);
  const modelObservation = kind === "subagent-stop" ? observedModelObservation(input, env) : { value: null, status: "unknown", candidates: { explicit: [], generic: [] } };
  const observedModel = modelObservation.value;
  const lifecycleEvidence = sourceEvidence(input, env);
  const evidenceSummary = sourceEvidenceSummary(lifecycleEvidence);
  const configuredHost = boundedText(env?.TCRN_TELEMETRY_HOST ?? env?.TCRN_HOST, 64);
  const host = configuredHost ?? inputField(input, ["host", "host_name", "hostName"], env, [], 64) ?? "unknown-host";
  const event = kind === "subagent-start" ? "SubagentStart" : "SubagentStop";
  const resolutionFacts = dispatchResolutionFacts(input, env);
  return {
    dispatchId: inputField(input, ["dispatch_id", "dispatchId"], env, ["TCRN_DISPATCH_ID", "TCRN_TELEMETRY_DISPATCH_ID"]),
    parentSession: inputField(input, ["parent_session", "parentSession", "parent_session_id", "parentSessionId", "parent"], env, ["TCRN_TELEMETRY_PARENT_SESSION", "TCRN_PARENT_SESSION"]),
    workId: inputField(input, ["work_id", "workId"], env, ["TCRN_TELEMETRY_WORK_ID", "TCRN_WORK_ID"]),
    taskClass: inputField(input, ["task_class", "taskClass", "dispatch_class", "dispatchClass", "class", "agent_type", "agentType"], env, ["TCRN_TELEMETRY_TASK_CLASS", "TCRN_DISPATCH_CLASS", "TCRN_TASK_CLASS"], 128),
    mode: inputField(input, ["dispatch_mode", "dispatchMode", "mode", "execution_mode", "executionMode"], env, ["TCRN_TELEMETRY_MODE", "TCRN_DISPATCH_MODE"], 128),
    requestedTier: inputField(input, ["requested_tier", "requestedTier", "tier"], env, ["TCRN_TELEMETRY_REQUESTED_TIER", "TCRN_DISPATCH_REQUESTED_TIER"], 128),
    resolvedTier: inputField(input, ["resolved_tier", "resolvedTier", "actual_tier", "actualTier"], env, ["TCRN_TELEMETRY_RESOLVED_TIER", "TCRN_DISPATCH_RESOLVED_TIER"], 128),
    configVersion: resolutionFacts.configVersion,
    configDigest: resolutionFacts.configDigest,
    resolutionStatus: resolutionFacts.resolutionStatus,
    resolutionSource: resolutionFacts.resolutionSource,
    requestedModel,
    observedModel,
    observedModelStatus: modelObservation.status,
    observedModelCandidates: modelObservation.candidates,
    usage: kind === "subagent-stop" ? usageFrom(input, env) : null,
    // Lifecycle fields are explicit host facts.  Missing fields remain null;
    // in particular, an agent/session id is never inferred from a prompt or
    // from the model name.  The extra fields intentionally make the payload
    // use the generic bounded telemetry envelope rather than changing the
    // historical twelve-field record contract.
    agentId: inputField(input, ["agent_id", "agentId", "child_agent_id", "childAgentId"], env, ["TCRN_AGENT_ID", "TCRN_TELEMETRY_AGENT_ID"]),
    lifecyclePhase: inputField(input, ["lifecycle_phase", "lifecyclePhase", "phase", "roundType", "round_type"], env, ["TCRN_LIFECYCLE_PHASE", "TCRN_DISPATCH_LIFECYCLE_PHASE"], 128),
    role: inputField(input, ["role", "role_id", "roleId"], env, ["TCRN_AGENT_ROLE", "TCRN_DISPATCH_ROLE"], 128),
    pack: inputField(input, ["pack", "pack_id", "packId"], env, ["TCRN_AGENT_PACK", "TCRN_DISPATCH_PACK"], 256),
    effort: inputField(input, ["effort", "reasoning_effort", "reasoningEffort"], env, ["TCRN_AGENT_EFFORT", "TCRN_DISPATCH_EFFORT"], 128),
    newInstance: booleanValue(input, env, ["new_instance", "newInstance", "new-instance"], ["TCRN_NEW_AGENT_INSTANCE", "TCRN_DISPATCH_NEW_INSTANCE"]),
    forkTurns: inputField(input, ["fork_turns", "forkTurns", "fork-turns"], env, ["TCRN_FORK_TURNS", "TCRN_DISPATCH_FORK_TURNS"], 64, { preserveUnknown: true }),
    sameTaskRunning: booleanValue(input, env, ["same_task_running", "sameTaskRunning", "same-task-running"], ["TCRN_SAME_TASK_RUNNING", "TCRN_DISPATCH_SAME_TASK_RUNNING"]),
    sourceEvidence: lifecycleEvidence,
    sourceEvidenceStatus: sourceEvidenceStatus(lifecycleEvidence),
    sourceEvidenceAvailability: evidenceSummary.availability,
    sourceEvidenceVerifiability: evidenceSummary.verifiability,
    source: boundedUtf8(`hook:${host}:${event}`, 128),
    availability: "available",
  };
}

export async function runTelemetryHook(input, {
  env = process.env,
  containerRoot = PLATFORM_ROOT,
  now = () => new Date().toISOString(),
} = {}) {
  try {
    const event = eventName(input, env);
    const kind = TELEMETRY_EVENTS[event];
    if (kind === undefined) return { ok: true, reasonCode: "TELEMETRY_EVENT_IGNORED", event: event ?? null };
    const root = await telemetryRoot(input, env, containerRoot);
    if (root === null) return { ok: true, reasonCode: "TELEMETRY_UNAVAILABLE", availability: "unavailable", kind };
    const session = inputField(input, ["session_id", "sessionId", "child_session", "childSession", "child_session_id", "childSessionId"], env, ["TCRN_TELEMETRY_SESSION", "TCRN_SESSION_ID"]) ?? "unknown-session";
    const record = createTelemetryRecord({
      at: eventAt(input, env, now),
      kind,
      session,
      payload: payloadFor(input, env, kind),
    });
    const receipt = await appendTelemetryRecord(root, record);
    return {
      ok: true,
      reasonCode: receipt.duplicate ? "TELEMETRY_DUPLICATE" : "TELEMETRY_RECORDED",
      id: receipt.record.id,
      kind: receipt.record.kind,
      path: receipt.path,
      duplicate: receipt.duplicate,
      availability: receipt.record.payload.availability,
    };
  } catch (error) {
    return { ok: true, reasonCode: "TELEMETRY_FAIL_OPEN", error: String(error?.reasonCode ?? error?.message ?? error) };
  }
}

function readStdin() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return {}; }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const host = hostArgument();
  const env = host === null ? process.env : { ...process.env, TCRN_TELEMETRY_HOST: host, TCRN_HOST: host };
  const result = await runTelemetryHook(readStdin(), { env });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}
