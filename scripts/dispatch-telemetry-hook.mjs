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
  appendTelemetryObservationCheckpoint,
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

function boundedText(value, maximum = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\u0000") || !value.isWellFormed()) return null;
  if (UNKNOWN_VALUES.includes(value.trim().toLowerCase())) return null;
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
  return [input, input?.payload, input?.subagent, input?.agent].filter(isRecord);
}

function inputField(input, names, env, envName, maximum = 256) {
  const values = [];
  for (const scope of inputScopes(input)) {
    for (const name of names) values.push(scope[name]);
  }
  for (const name of Array.isArray(envName) ? envName : [envName]) values.push(env?.[name]);
  return boundedText(firstDefined(...values), maximum);
}

function numeric(value) {
  if (typeof value === "string" && value.trim().length > 0) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
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

function eventName(input, env) {
  return firstDefined(input?.hook_event_name, input?.hookEventName, env?.TCRN_TELEMETRY_EVENT);
}

function eventAt(input, env, now) {
  const candidate = firstDefined(input?.at, input?.timestamp, input?.occurred_at, input?.occurredAt, env?.TCRN_TELEMETRY_AT);
  if (typeof candidate === "string" && !Number.isNaN(Date.parse(candidate))) return candidate;
  return now();
}

function observationCheckpoint(input, env) {
  const direct = firstDefined(input?.observationCheckpoint, input?.observation_checkpoint, input?.coverageCheckpoint);
  if (isRecord(direct)) return direct;
  const encoded = env?.TCRN_TELEMETRY_OBSERVATION_CHECKPOINT;
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  try {
    const parsed = JSON.parse(encoded);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
  const observedModel = kind === "subagent-stop"
    ? inputField(input, ["model", "model_name", "modelName", "observed_model", "observedModel"], env, ["TCRN_TELEMETRY_OBSERVED_MODEL", "TCRN_OBSERVED_MODEL"])
    : null;
  const host = inputField(input, ["host", "host_name", "hostName"], env, ["TCRN_TELEMETRY_HOST", "TCRN_HOST"], 64) ?? "unknown-host";
  const event = kind === "subagent-start" ? "SubagentStart" : "SubagentStop";
  return {
    dispatchId: inputField(input, ["dispatch_id", "dispatchId"], env, ["TCRN_DISPATCH_ID", "TCRN_TELEMETRY_DISPATCH_ID"]),
    parentSession: inputField(input, ["parent_session", "parentSession", "parent_session_id", "parentSessionId", "parent"], env, ["TCRN_TELEMETRY_PARENT_SESSION", "TCRN_PARENT_SESSION"]),
    workId: inputField(input, ["work_id", "workId"], env, ["TCRN_TELEMETRY_WORK_ID", "TCRN_WORK_ID"]),
    taskClass: inputField(input, ["task_class", "taskClass", "dispatch_class", "dispatchClass", "class", "agent_type", "agentType"], env, ["TCRN_TELEMETRY_TASK_CLASS", "TCRN_DISPATCH_CLASS", "TCRN_TASK_CLASS"], 128),
    mode: inputField(input, ["dispatch_mode", "dispatchMode", "mode", "execution_mode", "executionMode"], env, ["TCRN_TELEMETRY_MODE", "TCRN_DISPATCH_MODE"], 128),
    requestedTier: inputField(input, ["requested_tier", "requestedTier", "tier"], env, ["TCRN_TELEMETRY_REQUESTED_TIER", "TCRN_DISPATCH_REQUESTED_TIER"], 128),
    resolvedTier: inputField(input, ["resolved_tier", "resolvedTier", "actual_tier", "actualTier"], env, ["TCRN_TELEMETRY_RESOLVED_TIER", "TCRN_DISPATCH_RESOLVED_TIER"], 128),
    requestedModel,
    observedModel,
    usage: kind === "subagent-stop" ? usageFrom(input, env) : null,
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
    const checkpoint = observationCheckpoint(input, env);
    const checkpointReceipt = checkpoint === null ? null : await appendTelemetryObservationCheckpoint(root, {
      at: typeof checkpoint.at === "string" ? checkpoint.at : record.at,
      channel: checkpoint.channel,
      phase: checkpoint.phase,
      sequence: checkpoint.sequence,
      source: checkpoint.source,
      availability: checkpoint.availability,
      session,
    });
    return {
      ok: true,
      reasonCode: receipt.duplicate ? "TELEMETRY_DUPLICATE" : "TELEMETRY_RECORDED",
      id: receipt.record.id,
      kind: receipt.record.kind,
      path: receipt.path,
      duplicate: receipt.duplicate,
      availability: receipt.record.payload.availability,
      ...(checkpointReceipt === null ? {} : { observationCheckpoint: { id: checkpointReceipt.record.id, duplicate: checkpointReceipt.duplicate } }),
    };
  } catch (error) {
    return { ok: true, reasonCode: "TELEMETRY_FAIL_OPEN", error: String(error?.reasonCode ?? error?.message ?? error) };
  }
}

function readStdin() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return {}; }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const result = await runTelemetryHook(readStdin());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}
