#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-426/427 — the host-neutral dispatch adapter.
//
// This module is intentionally the small boundary between Workflow and a host's
// native agent tool.  Workflow resolves a real workspace/host/class/mode tuple;
// the caller owns the actual spawn.  No Codex App, Claude Code, or sibling
// repository is imported here.  A caller must re-resolve immediately before the
// native call and compare the configuration source, then compare the actual
// model/effort and lifecycle observation after the call.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  materializeWorkspace,
  readDispatchConfig,
  resolveDispatch,
} from "../dist/build/packages/core/src/index.js";
import {
  validateAgentLifecycle,
  validateAgentLifecycleEvidence,
} from "./dispatch-readiness-compliance.mjs";

export const DISPATCH_ADAPTER_VERSION = "tcrn.dispatch-adapter.v1";
export const DISPATCH_ADAPTER_HOSTS = Object.freeze(["claude-code", "codex"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function nonEmptyText(value, field, maximum = 512) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\u0000") || !value.isWellFormed()) {
    throw Object.assign(new Error(`${field} must be non-empty bounded text`), { reasonCode: "DISPATCH_INPUT_INVALID" });
  }
  return value;
}

function workspacePath(value) {
  const path = nonEmptyText(value, "workspace", 2_048);
  if (!isAbsolute(path)) throw Object.assign(new Error("workspace must be absolute"), { reasonCode: "DISPATCH_WORKSPACE_NOT_ABSOLUTE" });
  return resolve(path);
}

function reasonCode(error, fallback = "DISPATCH_RESOLUTION_FAILED") {
  return typeof error?.reasonCode === "string" ? error.reasonCode : fallback;
}

function failure(code, message, details = {}) {
  return {
    schemaVersion: DISPATCH_ADAPTER_VERSION,
    ok: false,
    status: "rejected",
    executable: false,
    reasonCode: code,
    error: message,
    ...details,
  };
}

function sourceFor(state, config) {
  const dispatchSettings = {
    classes: config.classes,
    tiers: config.tiers,
    modes: config.modes,
    mode: config.mode,
  };
  const configDigest = digest(dispatchSettings);
  return {
    kind: "engine-workspace-dispatch-config",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    configDigest,
  };
}

function resolutionFrom(config, source, { host, taskClass, mode }) {
  const selectedMode = mode ?? config.mode;
  const resolution = resolveDispatch(config, host, taskClass, selectedMode);
  // The legacy resolver intentionally falls through to a lower tier for host
  // rendering. Native dispatch is stricter: a class is entitled only to its
  // configured tier. Downgrading a decision/acceptance/implementation request
  // would hide a missing value and is exactly the silent fallback this adapter
  // is meant to prevent.
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

/**
 * Resolve one task against the current workspace.  This is the only source a
 * native adapter may use for its model and effort.  An empty tier is a
 * structured refusal, not a request to fill flagship; a non-dispatchable
 * compatibility class is reported but is never executable.
 */
export async function resolveDispatchRequest({ workspace, host, taskClass, mode } = {}) {
  let path;
  try {
    path = workspacePath(workspace);
    nonEmptyText(host, "host", 128);
    nonEmptyText(taskClass, "taskClass", 128);
    if (mode !== undefined) nonEmptyText(mode, "mode", 128);
  } catch (error) {
    return failure(reasonCode(error, "DISPATCH_INPUT_INVALID"), String(error?.message ?? error));
  }
  if (!DISPATCH_ADAPTER_HOSTS.includes(host)) {
    return failure("DISPATCH_HOST_UNSUPPORTED", `host ${host} is not supported by the native adapter`, {
      host,
      taskClass,
      mode: mode ?? null,
    });
  }
  try {
    const state = await materializeWorkspace(path);
    const config = readDispatchConfig(state.settings);
    const source = sourceFor(state, config);
    return {
      ...resolutionFrom(config, source, { host, taskClass, mode }),
      workspace: path,
      workspaceId: state.metadata.workspaceId,
    };
  } catch (error) {
    return failure(reasonCode(error), String(error?.message ?? error), {
      workspace: path,
      host,
      taskClass,
      mode: mode ?? null,
    });
  }
}

/**
 * Build exactly the values that may be forwarded to a host's native spawn
 * call.  The returned model/effort are copied from the engine resolution; no
 * provider or flagship fallback exists here.  Lifecycle metadata remains
 * separate so the parent can add the host tool's own fields without making the
 * engine depend on that tool.
 */
export function buildNativeSpawnInput(prepared, lifecycle) {
  if (!prepared || prepared.schemaVersion !== DISPATCH_ADAPTER_VERSION || prepared.executable !== true || prepared.resolution?.value === null) {
    return failure("DISPATCH_RESOLUTION_NOT_EXECUTABLE", "a successful executable resolution is required before spawn");
  }
  if (!isRecord(lifecycle)) return failure("DISPATCH_LIFECYCLE_REQUIRED", "lifecycle binding is required before spawn");
  const value = prepared.resolution.value;
  const declared = { ...lifecycle };
  const lifecycleWorkId = invocationValue(declared, ["workId", "work_id", "taskId", "task_id"]);
  if (typeof lifecycleWorkId !== "string" || lifecycleWorkId.trim().length === 0) {
    return failure("DISPATCH_WORK_BINDING_REQUIRED", "lifecycle workId is required before spawn");
  }
  const lifecycleClass = invocationValue(declared, ["taskClass", "dispatchClass", "class"]);
  if (lifecycleClass !== undefined && lifecycleClass !== prepared.resolution.taskClass) {
    return failure("DISPATCH_CLASS_MISMATCH", "lifecycle class does not match the engine resolution", { expected: prepared.resolution.taskClass, actual: lifecycleClass });
  }
  if (declared.model !== undefined && declared.model !== value.model) {
    return failure("DISPATCH_MODEL_MISMATCH", "lifecycle model does not match the engine resolution", { expected: value.model, actual: declared.model });
  }
  if (declared.effort !== undefined && declared.effort !== value.effort) {
    return failure("DISPATCH_EFFORT_MISMATCH", "lifecycle effort does not match the engine resolution", { expected: value.effort, actual: declared.effort });
  }
  declared.model = value.model;
  declared.effort = value.effort;
  const lifecycleResult = validateAgentLifecycle(declared);
  if (!lifecycleResult.ok) {
    return failure("DISPATCH_LIFECYCLE_INVALID", "lifecycle binding is not dispatchable", { lifecycle: lifecycleResult });
  }
  return {
    schemaVersion: DISPATCH_ADAPTER_VERSION,
    ok: true,
    status: "ready",
    reasonCode: "DISPATCH_NATIVE_SPAWN_READY",
    source: prepared.source,
    resolution: prepared.resolution,
    // `effort` is deliberately host-neutral.  The caller maps it to the
    // native tool's reasoning/effort argument and must retain this input in
    // its dispatch artifact.
    spawn: {
      model: value.model,
      effort: value.effort,
    },
    lifecycle: declared,
  };
}

function compareSource(prepared, current) {
  const expected = prepared?.source;
  const actual = current?.source;
  if (!expected || !actual) return { ok: false, reason: "missing resolution source" };
  for (const field of ["workspaceId", "version", "headEventHash", "configDigest"]) {
    if (expected[field] !== actual[field]) return { ok: false, reason: `${field} changed`, field, expected: expected[field], actual: actual[field] };
  }
  return { ok: true };
}

function invocationValue(invocation, names) {
  for (const name of names) {
    if (invocation && Object.hasOwn(invocation, name)) return invocation[name];
  }
  return undefined;
}

/**
 * Re-resolve and validate the exact native invocation.  This function calls
 * the existing 424 lifecycle evidence validator rather than maintaining a
 * second lifecycle implementation.  Missing host observations remain
 * `not-verifiable`; they are never converted into identity proof.
 */
export async function validateDispatchInvocation({ prepared, invocation, lifecycle, observedLifecycle } = {}) {
  if (!prepared || prepared.schemaVersion !== DISPATCH_ADAPTER_VERSION || prepared.executable !== true) {
    return failure("DISPATCH_RESOLUTION_NOT_EXECUTABLE", "an executable engine resolution is required");
  }
  const request = prepared.resolution;
  const current = await resolveDispatchRequest({
    workspace: prepared.workspace,
    host: request.host,
    taskClass: request.taskClass,
    mode: request.mode,
  });
  if (!current.ok || current.executable !== true) {
    return failure("DISPATCH_REPARSE_REFUSED", "the fresh engine resolution is not executable", { current });
  }
  const sourceComparison = compareSource(prepared, current);
  if (!sourceComparison.ok) {
    return failure("DISPATCH_CONFIG_DRIFT", "dispatch configuration changed after resolution", { sourceComparison, current });
  }
  const actualModel = invocationValue(invocation, ["model", "requestedModel"]);
  const actualEffort = invocationValue(invocation, ["effort", "reasoningEffort", "reasoning_effort"]);
  if (typeof actualModel !== "string" || actualModel.length === 0) {
    return failure("DISPATCH_SPAWN_INPUT_MISSING", "native invocation did not expose model");
  }
  if (typeof actualEffort !== "string" || actualEffort.length === 0) {
    return failure("DISPATCH_SPAWN_INPUT_MISSING", "native invocation did not expose effort");
  }
  if (actualModel !== request.value.model) {
    return failure("DISPATCH_MODEL_MISMATCH", "native invocation model does not match the engine resolution", { expected: request.value.model, actual: actualModel });
  }
  if (actualEffort !== request.value.effort) {
    return failure("DISPATCH_EFFORT_MISMATCH", "native invocation effort does not match the engine resolution", { expected: request.value.effort, actual: actualEffort });
  }
  for (const field of ["workspaceId", "host", "taskClass", "mode"]) {
    const names = field === "taskClass" ? ["taskClass", "dispatchClass", "class"] : [field];
    const actual = invocationValue(invocation, names);
    if (actual !== undefined && actual !== (field === "workspaceId" ? prepared.workspaceId : request[field])) {
      return failure("DISPATCH_INVOCATION_BINDING_MISMATCH", `native invocation ${field} does not match the engine resolution`, { field, expected: field === "workspaceId" ? prepared.workspaceId : request[field], actual });
    }
  }
  if (!isRecord(lifecycle)) return failure("DISPATCH_LIFECYCLE_REQUIRED", "lifecycle binding is required for native dispatch");
  const lifecycleWorkId = invocationValue(lifecycle, ["workId", "work_id", "taskId", "task_id"]);
  if (typeof lifecycleWorkId !== "string" || lifecycleWorkId.trim().length === 0) {
    return failure("DISPATCH_WORK_BINDING_REQUIRED", "lifecycle workId is required for native dispatch");
  }
  const invocationWorkId = invocationValue(invocation, ["workId", "work_id", "taskId", "task_id"]);
  if (invocationWorkId !== undefined && invocationWorkId !== lifecycleWorkId) {
    return failure("DISPATCH_WORK_BINDING_MISMATCH", "native invocation workId does not match the lifecycle binding", { expected: lifecycleWorkId, actual: invocationWorkId });
  }
  const lifecycleClass = invocationValue(lifecycle, ["taskClass", "dispatchClass", "class"]);
  if (lifecycleClass !== undefined && lifecycleClass !== request.taskClass) {
    return failure("DISPATCH_CLASS_MISMATCH", "lifecycle class does not match the engine resolution", { expected: request.taskClass, actual: lifecycleClass });
  }
  const declared = { ...lifecycle, model: lifecycle.model ?? request.value.model, effort: lifecycle.effort ?? request.value.effort };
  const lifecycleEvidence = validateAgentLifecycleEvidence(declared, observedLifecycle);
  if (lifecycleEvidence.status === "red") {
    return failure("DISPATCH_LIFECYCLE_EVIDENCE_RED", "native dispatch lifecycle evidence contradicts the declaration", { lifecycle: lifecycleEvidence });
  }
  if (lifecycleEvidence.status !== "green") {
    return failure("DISPATCH_LIFECYCLE_NOT_VERIFIABLE", "native dispatch lifecycle observation is unavailable or incomplete", { lifecycle: lifecycleEvidence });
  }
  return {
    schemaVersion: DISPATCH_ADAPTER_VERSION,
    ok: true,
    status: "validated",
    reasonCode: "DISPATCH_NATIVE_INVOCATION_VALID",
    source: prepared.source,
    currentSource: current.source,
    resolution: request,
    invocation: { model: actualModel, effort: actualEffort },
    lifecycle: lifecycleEvidence,
  };
}

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
}

function jsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`${label} is not readable JSON: ${error?.message ?? error}`), { reasonCode: "DISPATCH_INPUT_INVALID" });
  }
}

async function main(argv) {
  const workspace = flag(argv, "workspace");
  const host = flag(argv, "host");
  const taskClass = flag(argv, "class");
  const mode = flag(argv, "mode");
  if (!workspace || !host || !taskClass) return failure("DISPATCH_ARGUMENT_MISSING", "--workspace, --host, and --class are required");
  const prepared = await resolveDispatchRequest({ workspace, host, taskClass, mode });
  const lifecyclePath = flag(argv, "lifecycle");
  const observedPath = flag(argv, "observed");
  if (lifecyclePath === undefined && flag(argv, "model") === undefined && flag(argv, "effort") === undefined) return prepared;
  let lifecycle;
  let observed;
  try {
    lifecycle = lifecyclePath === undefined ? undefined : jsonFile(lifecyclePath, "lifecycle");
    observed = observedPath === undefined ? undefined : jsonFile(observedPath, "observed");
  } catch (error) {
    return failure(reasonCode(error, "DISPATCH_INPUT_INVALID"), String(error?.message ?? error));
  }
  return validateDispatchInvocation({
    prepared,
    lifecycle,
    observedLifecycle: observed,
    invocation: { model: flag(argv, "model"), effort: flag(argv, "effort") },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.ok !== true) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failure(reasonCode(error), String(error?.message ?? error)))}\n`);
    process.exitCode = 1;
  }
}
