#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-019 STORY-162.4 — the hook wrapper for knowledge injection.
//
// Claude Code fires a hook with a JSON body on stdin (SessionStart has no prompt;
// UserPromptSubmit carries `prompt`). This wrapper:
//   1. reads stdin;
//   2. runs the injection chain (tcrn-workflow/scripts/knowledge-inject.mjs) with the
//      prompt; ordinary prompts use engine recall, while SubagentStart requires an
//      explicit role/workId/Pack binding and never receives global L0;
//   3. writes the hook protocol response with `additionalContext` = the metadata-level
//      injection (or an empty string when nothing matches — INC-044/060).
//
// The command string registered in .claude/settings.json uses ${CLAUDE_PROJECT_DIR}
// (INC-040: a bare relative path means the hook never starts from a different cwd).

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_STATE_DIRECTORY, acknowledgeInjection } from "./injection-session.mjs";
import { INJECTION_PROTOCOL_VERSION, MAX_INJECTION_PROTOCOL_BYTES, hasChildAgentMarker, parseInjectionProtocol } from "./knowledge-inject.mjs";

export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const INJECT_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "knowledge-inject.mjs");

// This is a placement description, not an installer.  STORY-371 owns the helper archive,
// approval, user-level write and receipt; keeping those acts out of this file means the
// injection path can be fixture-validated without changing a user's persistent settings.
export const InjectionPlacementManifest = Object.freeze({
  schemaVersion: "tcrn.injection-placement-manifest.v1",
  events: Object.freeze({
    claude: Object.freeze(["SessionStart", "UserPromptSubmit", "PostCompact", "PostToolUse", "SubagentStart"]),
    codex: Object.freeze(["SessionStart", "UserPromptSubmit", "PostCompact", "PostToolUse", "SubagentStart"]),
  }),
  commands: Object.freeze({
    claude: 'node "${CLAUDE_PROJECT_DIR}/scripts/knowledge-inject-hook.mjs" --container-root "${CLAUDE_PROJECT_DIR}" --host claude',
    codex: 'node "${CODEX_PROJECT_DIR}/scripts/knowledge-inject-hook.mjs" --container-root "<PLATFORM_ROOT>" --host codex',
  }),
  modelMapping: Object.freeze({
    setting: "execution.dispatchTiers",
    translator: "independent-uninjected-call-before-recall",
    judge: "independent-uninjected-call-after-recall",
    maxCallsPerPrompt: 1,
    timeoutMs: 10_000,
    subagentAuxiliaryModels: false,
    contextBinding: ["role", "workId", "pack"],
  }),
  protocol: Object.freeze({
    version: INJECTION_PROTOCOL_VERSION,
    maxBytes: MAX_INJECTION_PROTOCOL_BYTES,
    acknowledgement: "wrapper-after-parse",
    retryLimit: 1,
  }),
  runtimeState: Object.freeze({
    path: "~/.tcrn-injection/state.json",
    lock: "~/.tcrn-injection/state.lock",
    persisted: ["emittedIds", "pendingIds", "byteAccounting", "promptDecisions", "pullCorrelations", "judgments"],
    excludes: ["hookPayloads", "transcripts", "modelPrompts"],
  }),
  placementOwner: "STORY-371",
  installer: null,
});

export function validateInjectionPlacementManifest(value) {
  const manifest = value ?? {};
  if (manifest.schemaVersion !== "tcrn.injection-placement-manifest.v1") return false;
  for (const host of ["claude", "codex"]) {
    if (!Array.isArray(manifest.events?.[host]) || JSON.stringify(manifest.events[host]) !== JSON.stringify(InjectionPlacementManifest.events[host])) return false;
    if (typeof manifest.commands?.[host] !== "string" || !manifest.commands[host].includes("knowledge-inject-hook.mjs")) return false;
  }
  if (manifest.modelMapping?.setting !== "execution.dispatchTiers" || manifest.modelMapping?.maxCallsPerPrompt !== 1 || manifest.modelMapping?.timeoutMs !== 10_000 || manifest.modelMapping?.subagentAuxiliaryModels !== false || JSON.stringify(manifest.modelMapping?.contextBinding) !== JSON.stringify(["role", "workId", "pack"])) return false;
  if (manifest.protocol?.version !== INJECTION_PROTOCOL_VERSION || manifest.protocol?.maxBytes !== MAX_INJECTION_PROTOCOL_BYTES || manifest.protocol?.acknowledgement !== "wrapper-after-parse" || manifest.protocol?.retryLimit !== 1) return false;
  if (manifest.runtimeState?.path?.includes(".tcrn-workflow") || manifest.runtimeState?.path?.includes(".tcrn-workspace")) return false;
  return manifest.placementOwner === "STORY-371" && manifest.installer === null;
}

function readStdin() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return {}; }
}

// PostToolUse can carry a `tool_response` large enough to push the whole hook payload
// past the platform's ARG_MAX: spawnSync then fails outright and runInject() silently
// degrades to INJECT_OUTPUT_UNPARSEABLE, with nothing in the result naming the cause.
// Past this many bytes, the response fields are dropped and the payload is marked
// truncated instead, so the child process still starts and the degradation is visible.
export const MAX_HOOK_INPUT_BYTES = 512_000;
export const MAX_HOOK_OUTPUT_BYTES = MAX_INJECTION_PROTOCOL_BYTES;
export const MAX_HOOK_RETRIES = 1;
export const RETRYABLE_INJECTION_REASONS = Object.freeze([
  "INJECT_SPAWN_FAILED",
  "INJECT_PROCESS_TIMEOUT",
  "INJECT_PROCESS_EXIT_NONZERO",
  "INJECT_OUTPUT_UNPARSEABLE",
  "INJECT_OUTPUT_TRUNCATED",
  "INJECT_DELIVERY_ACK_FAILED",
]);

function boundedText(value, maximumBytes) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length <= maximumBytes) return bytes.toString("utf8");
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

export function boundedHookInput(input) {
  const source = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
  let raw;
  try { raw = JSON.stringify(source); } catch { raw = ""; }
  if (typeof raw === "string" && Buffer.byteLength(raw, "utf8") <= MAX_HOOK_INPUT_BYTES) return raw;
  const { tool_response, toolResponse, ...rest } = source;
  let reduced;
  try { reduced = JSON.stringify({ ...rest, tcrnPayloadTruncated: true }); } catch { reduced = ""; }
  if (Buffer.byteLength(reduced, "utf8") <= MAX_HOOK_INPUT_BYTES) return reduced;
  // A malformed/large custom field must not move the truncation problem to a
  // different argv value. Keep the host contract fields and the dispatch
  // binding, then bound prompt text as a final deterministic fallback.
  const safe = {};
  for (const key of ["hook_event_name", "hookEventName", "session_id", "sessionId", "tool_name", "toolName", "role", "workId", "workID", "work_id", "pack", "packId", "packID", "pack_id", "dispatchId", "dispatch_id", "prompt"]) {
    if (source[key] === undefined) continue;
    safe[key] = key === "prompt" ? boundedText(source[key], 64_000) : source[key];
  }
  safe.tcrnPayloadTruncated = true;
  let bounded;
  try { bounded = JSON.stringify(safe); } catch { bounded = JSON.stringify({ tcrnPayloadTruncated: true }); }
  if (Buffer.byteLength(bounded, "utf8") <= MAX_HOOK_INPUT_BYTES) return bounded;
  return JSON.stringify({ hook_event_name: source.hook_event_name ?? source.hookEventName ?? null, tcrnPayloadTruncated: true });
}

export function inferHost(input = {}, env = process.env) {
  const explicit = input?.host ?? input?.host_name ?? input?.hostName;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  if (typeof env?.TCRN_HOST === "string" && env.TCRN_HOST.length > 0) return env.TCRN_HOST;
  if (env?.CODEX_PROJECT_DIR && !env?.CLAUDE_PROJECT_DIR) return "codex";
  if (env?.CLAUDE_PROJECT_DIR && !env?.CODEX_PROJECT_DIR) return "claude";
  return "unknown-host";
}

function bindingArguments(input) {
  const values = (names) => names.map((name) => input?.[name]).find((value) => value !== undefined && value !== null && value !== "");
  const nested = input?.context ?? input?.dispatchContext ?? input?.dispatch ?? input?.task ?? input?.subagent ?? input?.agent ?? {};
  const value = (names) => values(names) ?? names.map((name) => nested?.[name]).find((entry) => entry !== undefined && entry !== null && entry !== "");
  const role = value(["role", "taskRole", "task_role", "agentRole", "agent_role", "dispatchRole", "dispatch_role"]);
  const workId = value(["workId", "workID", "work_id", "workItemId", "work_item_id", "taskId", "task_id"]);
  const rawPack = value(["pack", "packId", "packID", "pack_id", "taskPack", "task_pack", "taskPackId", "task_pack_id", "batch", "batchId", "batchID", "batch_id"]);
  const pack = rawPack !== null && typeof rawPack === "object" ? rawPack.id ?? rawPack.packId ?? rawPack.pack_id ?? rawPack.key : rawPack;
  return { role, workId, pack };
}

function runInjectAttempt(input, { stateDirectory, host, containerRoot = PLATFORM_ROOT, retryPending = false, spawnImpl = spawnSync } = {}) {
  const event = input?.hook_event_name ?? "";
  const prompt = typeof input?.prompt === "string" ? boundedText(input.prompt, 64_000) : "";
  const sessionId = input?.session_id ?? input?.sessionId ?? "anonymous";
  const partition = input?.partition ?? process.env.TCRN_INJECTION_PARTITION ?? "cross-project";
  const binding = bindingArguments(input);
  const argv = [
    INJECT_SCRIPT,
    "--prompt", prompt,
    "--partition", partition,
    "--event", event,
    "--session-id", String(sessionId),
    "--hook-input", boundedHookInput(input),
    ...(input?.hook_event_name === "SubagentStart" || hasChildAgentMarker(input) || binding.role !== undefined || binding.workId !== undefined || binding.pack !== undefined ? ["--enforce-binding", "true"] : []),
    "--delivery-mode", "pending",
  ];
  if (binding.role !== undefined) argv.push("--role", String(binding.role));
  if (binding.workId !== undefined) argv.push("--work-id", String(binding.workId));
  if (binding.pack !== undefined) argv.push("--pack", typeof binding.pack === "string" ? binding.pack : JSON.stringify(binding.pack));
  if (stateDirectory) argv.push("--state-dir", stateDirectory);
  if (retryPending) argv.push("--retry-pending", "true");
  argv.push("--container-root", containerRoot);
  argv.push("--host", host ?? inferHost(input));
  const started = Date.now();
  let result;
  try {
    result = spawnImpl(process.execPath, argv, {
      encoding: "utf8",
      timeout: 25_000,
      maxBuffer: MAX_HOOK_OUTPUT_BYTES,
      env: { ...process.env, ...(host ? { TCRN_HOST: host } : {}) },
    });
  } catch (error) {
    return { ok: false, reasonCode: "INJECT_SPAWN_FAILED", error: String(error?.message ?? error), elapsedMs: Date.now() - started };
  }
  if (result === null || typeof result !== "object") return { ok: false, reasonCode: "INJECT_SPAWN_FAILED", error: "spawn implementation returned no result", elapsedMs: Date.now() - started };
  const stdout = `${result.stdout ?? ""}`;
  const stderr = `${result.stderr ?? ""}`;
  const outputBytes = Buffer.byteLength(stdout, "utf8");
  if (result.error?.code === "ENOBUFS" || outputBytes > MAX_HOOK_OUTPUT_BYTES) {
    return { ok: false, reasonCode: "INJECT_OUTPUT_TRUNCATED", outputBytes, maximumBytes: MAX_HOOK_OUTPUT_BYTES, elapsedMs: Date.now() - started };
  }
  if (result.error?.code === "ETIMEDOUT" || (result.signal === "SIGTERM" && result.status === null)) {
    return { ok: false, reasonCode: "INJECT_PROCESS_TIMEOUT", outputBytes, error: stderr.slice(-512), elapsedMs: Date.now() - started };
  }
  const parsed = parseInjectionProtocol(stdout, { maxBytes: MAX_HOOK_OUTPUT_BYTES });
  if (parsed.ok !== true) {
    const reasonCode = result.status !== 0 && result.status !== undefined && result.status !== null ? "INJECT_PROCESS_EXIT_NONZERO" : parsed.reasonCode;
    return { ...parsed, ok: false, reasonCode, parseReasonCode: parsed.reasonCode, stderr: stderr.slice(-512), exitCode: result.status, elapsedMs: Date.now() - started };
  }
  const value = parsed.value;
  const status = result.status ?? 0;
  if (status !== 0) {
    return { ...value, ok: false, reasonCode: value.reasonCode ?? "INJECT_PROCESS_EXIT_NONZERO", processExitCode: result.status, stderr: stderr.slice(-512), elapsedMs: Date.now() - started };
  }
  if (typeof value.ok !== "boolean") return { ok: false, reasonCode: "INJECT_OUTPUT_INVALID", processExitCode: status, stderr: stderr.slice(-512), elapsedMs: Date.now() - started };
  if (value.ok === false) return { ...value, processExitCode: result.status, stderr: stderr.slice(-512), elapsedMs: Date.now() - started };
  return { ...value, ok: true, processExitCode: result.status, stderr: stderr.slice(-512), elapsedMs: Date.now() - started, protocol: { version: value.protocolVersion ?? INJECTION_PROTOCOL_VERSION, outputBytes: parsed.outputBytes, legacy: parsed.legacy === true } };
}

function acknowledgeResult(result, sessionId, stateDirectory) {
  const ids = result?.delivery?.state === "pending" ? result.delivery.ids : [];
  if (!Array.isArray(ids) || ids.length === 0) return { ok: true, reasonCode: "INJECTION_DELIVERY_NOT_REQUIRED", acknowledgedIds: [] };
  try {
    const acknowledgement = acknowledgeInjection(sessionId, ids, { directory: stateDirectory ?? DEFAULT_STATE_DIRECTORY });
    return acknowledgement.ok === true ? acknowledgement : { ok: false, reasonCode: "INJECT_DELIVERY_ACK_FAILED", acknowledgement };
  } catch (error) {
    return { ok: false, reasonCode: "INJECT_DELIVERY_ACK_FAILED", error: String(error?.message ?? error) };
  }
}

/**
 * Execute the registered production command and acknowledge generated ids only
 * after a complete protocol document has been parsed.  One retry is reserved
 * for transport failures; a generation ledger alone never proves host receipt.
 */
export function runInject(input, { stateDirectory, host, containerRoot = PLATFORM_ROOT, retries = MAX_HOOK_RETRIES, spawnImpl = spawnSync } = {}) {
  const sessionId = input?.session_id ?? input?.sessionId ?? "anonymous";
  const attempts = [];
  const maximumRetries = Number.isSafeInteger(retries) && retries >= 0 ? Math.min(retries, MAX_HOOK_RETRIES) : MAX_HOOK_RETRIES;
  for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
    const result = runInjectAttempt(input, { stateDirectory, host, containerRoot, retryPending: attempt > 0, spawnImpl });
    attempts.push({ attempt: attempt + 1, reasonCode: result.reasonCode ?? null, ok: result.ok === true, outputBytes: result.protocol?.outputBytes ?? result.outputBytes ?? null });
    if (result.ok === true) {
      const acknowledgement = acknowledgeResult(result, sessionId, stateDirectory);
      if (acknowledgement.ok !== true) {
        const failed = { ...result, ok: false, reasonCode: acknowledgement.reasonCode, deliveryAcknowledgement: acknowledgement, attempts };
        if (attempt < maximumRetries) continue;
        return failed;
      }
      return { ...result, attempts, deliveryAcknowledgement: acknowledgement };
    }
    if (!RETRYABLE_INJECTION_REASONS.includes(result.reasonCode) || attempt >= maximumRetries) return { ...result, attempts };
  }
  return { ok: false, reasonCode: "INJECT_PROCESS_FAILED", attempts };
}

function buildHookResponseResult(input, { host, containerRoot = PLATFORM_ROOT } = {}) {
  const event = input.hook_event_name ?? "";
  // The host contract requires additionalContext to be a STRING (a JSON array is
  // schema-invalid and the whole hook output is dropped — verified against the Claude
  // Code hooks documentation, INC-044). Empty string when nothing matches.
  const chunks = [];
  let result = { ok: true, reasonCode: "HOOK_EVENT_IGNORED", injected: false };

  const inject = () => {
    result = runInject(input, { host: host ?? inferHost(input), containerRoot });
    if (result.ok === true && result.injected === true && typeof result.injection === "string" && result.injection.length > 0) {
      const count = result.candidateCount ?? result.l0?.lines?.length ?? 0;
      chunks.push(`[平台知识注入 · ${count} 条 · 来源 cross-project 知识面]\n${result.injection}`);
    }
    return result;
  };

  if (["SessionStart", "UserPromptSubmit", "PostCompact", "PostToolUse", "SubagentStart"].includes(event)) inject();

  return { response: { hookSpecificOutput: { hookEventName: event, additionalContext: chunks.join("\n") } }, result };
}

export function buildHookResponse(input, { host, containerRoot = PLATFORM_ROOT } = {}) {
  return buildHookResponseResult(input, { host, containerRoot }).response;
}

/**
 * Evidence view for tests and closeout artifacts.  The host acknowledgement is
 * intentionally unknown: stdout from a hook proves generation and wrapper
 * parsing, not that the host placed additionalContext in model context.
 */
export function buildHookResponseWithEvidence(input, { host, containerRoot = PLATFORM_ROOT } = {}) {
  const { response, result } = buildHookResponseResult(input, { host, containerRoot });
  return {
    response,
    evidence: {
      generation: {
        status: result?.ok === true ? "ok" : "failed",
        reasonCode: result?.reasonCode ?? null,
        ids: result?.delivery?.ids ?? result?.injectedIds ?? [],
        injectionBytes: result?.injectedBytes ?? 0,
      },
      wrapper: {
        status: result?.deliveryAcknowledgement?.ok === false ? "failed" : result?.ok === true ? "ok" : "failed",
        reasonCode: result?.deliveryAcknowledgement?.reasonCode ?? result?.reasonCode ?? null,
        attempts: result?.attempts ?? [],
      },
      host: { status: "unobserved", reasonCode: "HOST_RECEIPT_NOT_AVAILABLE_FROM_HOOK" },
    },
    result,
  };
}

function cliValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && typeof process.argv[index + 1] === "string" ? process.argv[index + 1] : fallback;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const host = cliValue("--host");
  const containerRoot = cliValue("--container-root", PLATFORM_ROOT);
  process.stdout.write(`${JSON.stringify(buildHookResponse(readStdin(), { host, containerRoot }))}\n`);
}
