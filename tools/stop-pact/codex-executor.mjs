#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Codex Stop adapter for TCRN-CROSS-STORY-194.
//
// The stdin side of this file speaks the host Stop protocol. It does not invent a
// second pact or a second decider: it normalizes the fields a real Codex Stop event
// supplies, calls the shared decider, and persists only the shared pact runtime
// effects. A diagnostic flag exposes the neutral internal envelope for tests and
// operators; the default stdout is reserved for the host's {decision,reason} object.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { decide } from "./decide.mjs";
import { readPact, writePact, withRuntime } from "./pact.mjs";
import { resolveMode } from "./mode.mjs";

export const CODEX_STOP_PACT_EXECUTION_VERSION = "tcrn.codex-stop-pact-execution.v1";
const DEFAULT_CLI = "node <tcrn-workflow>/tools/stop-pact/cli.mjs";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifiableModel(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  if (/^(?:unknown|unavailable|unidentified|redacted|n\/a)$/iu.test(value.trim())) return null;
  return value;
}

function validInstant(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function integerOrUndefined(value) {
  return value === undefined
    ? undefined
    : Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function contextResult(reasonCode, details = {}) {
  return {
    schemaVersion: CODEX_STOP_PACT_EXECUTION_VERSION,
    reasonCode,
    action: "allow",
    mode: "observe",
    modelKnown: false,
    governingStatus: null,
    wrotePact: false,
    message: "",
    notify: null,
    effects: null,
    ...details,
  };
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

/**
 * Convert either the old test envelope or a real Codex Stop event into the small
 * fact set accepted by the shared decider. Host fields are deliberately not
 * schema-whitelisted: Codex may add fields without making the safety adapter
 * reject the event. Only the fields used for a decision are validated.
 */
export function normalizeCodexStopInput(input, pact) {
  if (!isRecord(input)) return { ok: false, reasonCode: "CODEX_STOP_CONTEXT_UNAVAILABLE" };

  const sessionId = firstDefined(input.session_id, input.sessionId);
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return { ok: false, reasonCode: "CODEX_STOP_CONTEXT_UNAVAILABLE" };
  }

  const model = firstDefined(input.model, input.model_name, input.modelName, null);
  if (model !== null && model !== undefined && (typeof model !== "string" || model.trim().length === 0)) {
    return { ok: false, reasonCode: "CODEX_STOP_CONTEXT_UNAVAILABLE" };
  }

  const stopHookActive = firstDefined(input.stop_hook_active, input.stopHookActive, false);
  if (typeof stopHookActive !== "boolean") {
    return { ok: false, reasonCode: "CODEX_STOP_CONTEXT_UNAVAILABLE" };
  }

  const suppliedNow = firstDefined(input.now, input.timestamp, input.occurred_at);
  if (suppliedNow !== undefined && !validInstant(suppliedNow)) {
    return { ok: false, reasonCode: "CODEX_STOP_CONTEXT_UNAVAILABLE" };
  }
  const now = suppliedNow ?? new Date().toISOString();

  const rawToolUses = firstDefined(input.toolUseCount, input.tool_use_count);
  const toolUseCount = integerOrUndefined(rawToolUses);
  if (toolUseCount === null) return { ok: false, reasonCode: "CODEX_STOP_CONTEXT_UNAVAILABLE" };

  const explicitWorked = firstDefined(input.workedSinceLastBlock, input.worked_since_last_block);
  let workedSinceLastBlock;
  if (explicitWorked !== undefined) {
    if (typeof explicitWorked !== "boolean") return { ok: false, reasonCode: "CODEX_STOP_CONTEXT_UNAVAILABLE" };
    workedSinceLastBlock = explicitWorked;
  } else if (toolUseCount !== undefined) {
    const previous = pact?.runtime?.lastBlockToolUses;
    workedSinceLastBlock = Number.isSafeInteger(previous) && previous >= 0
      ? toolUseCount > previous
      : true;
  } else {
    // A missing work delta is an observation gap. It must not become a real
    // no-progress fact and cause a block.
    return { ok: false, reasonCode: "CODEX_STOP_CONTEXT_UNAVAILABLE" };
  }

  const cliInvocation = firstDefined(input.cliInvocation, input.cli_invocation, DEFAULT_CLI);
  if (typeof cliInvocation !== "string" || cliInvocation.length === 0) {
    return { ok: false, reasonCode: "CODEX_STOP_CONTEXT_UNAVAILABLE" };
  }

  return {
    ok: true,
    value: {
      sessionId,
      model,
      now,
      workedSinceLastBlock,
      toolUseCount,
      stopHookActive,
      cliInvocation,
    },
  };
}

function envelope(verdict, { pact, mode, model, wrotePact = false } = {}) {
  return {
    schemaVersion: CODEX_STOP_PACT_EXECUTION_VERSION,
    reasonCode: verdict.code,
    action: verdict.action,
    mode,
    modelKnown: identifiableModel(model) !== null,
    governingStatus: pact?.status ?? null,
    wrotePact,
    message: verdict.message,
    notify: verdict.notify,
    effects: verdict.effects,
  };
}

/** Judge one old/internal envelope or one real Codex Stop event. */
export function decideCodexStop(input, pact) {
  const normalized = normalizeCodexStopInput(input, pact);
  if (!normalized.ok) return contextResult(normalized.reasonCode);

  const value = normalized.value;
  const model = identifiableModel(value.model);
  const mode = resolveMode(model);
  const verdict = decide({
    pact,
    now: value.now,
    sessionId: value.sessionId,
    stopHookActive: value.stopHookActive,
    mode,
    workedSinceLastBlock: value.workedSinceLastBlock,
    consecutiveBlocks: pact?.runtime?.consecutiveBlocks ?? 0,
    cliInvocation: value.cliInvocation,
  });
  return envelope(verdict, { pact, mode, model });
}

function applyEffects(pact, verdict, currentToolUses, now, path) {
  if (!pact || verdict.code === "OTHER_SESSION" || verdict.code === "NO_ACTIVE_PACT" || verdict.code === "STOP_HOOK_ACTIVE") {
    return false;
  }
  if (verdict.effects.deactivate) {
    const at = new Date(now).toISOString();
    writePact({
      ...pact,
      status: "expired",
      active: false,
      history: [
        ...(pact.history ?? []),
        { at, event: "expired", detail: "TTL reached, enforcement lifted" },
      ],
    }, path);
    return true;
  }
  const runtimePatch = {
    consecutiveBlocks: verdict.effects.setConsecutiveBlocks,
  };
  if (verdict.effects.recordBlockOffset && typeof currentToolUses === "number") {
    runtimePatch.lastBlockToolUses = currentToolUses;
  }
  if (verdict.effects.bindSession) runtimePatch.boundSession = verdict.effects.bindSession;
  const next = withRuntime(pact, runtimePatch);
  if (JSON.stringify(next) === JSON.stringify(pact)) return false;
  writePact(next, path);
  return true;
}

/** Execute one real-host or internal Codex Stop observation using the shared pact. */
export function executeCodexStop(input, { path } = {}) {
  try {
    const pact = readPact(path);
    const normalized = normalizeCodexStopInput(input, pact);
    if (!normalized.ok) return contextResult(normalized.reasonCode);
    const result = decideCodexStop(input, pact);
    const wrotePact = applyEffects(
      pact,
      { ...result, code: result.reasonCode },
      normalized.value.toolUseCount,
      normalized.value.now,
      path,
    );
    return { ...result, wrotePact };
  } catch {
    // A stop adapter must never make the host un-stoppable. This is an allow,
    // but it is named so a diagnostic invocation cannot mistake the failure for
    // a normal terminal decision.
    return contextResult("CODEX_STOP_EXECUTOR_ERROR");
  }
}

/** Translate the neutral envelope to Codex's host Stop-hook stdout protocol. */
export function hostStopResponse(result) {
  if (result?.action !== "block") return null;
  const reason = typeof result.message === "string" && result.message.trim().length > 0
    ? result.message
    : "TCRN stop pact requires this Codex run to continue or record a terminal outcome.";
  return { decision: "block", reason };
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const diagnostic = process.argv.includes("--diagnostic");
  const result = executeCodexStop(readStdin());
  if (diagnostic) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const response = hostStopResponse(result);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
