#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-019 STORY-162.4 — the hook wrapper for knowledge injection.
//
// Claude Code fires a hook with a JSON body on stdin (SessionStart has no prompt;
// UserPromptSubmit carries `prompt`). This wrapper:
//   1. reads stdin;
//   2. runs the injection chain (tcrn-workflow/scripts/knowledge-inject.mjs) with the
//      prompt; every prompt reaches relevance search and there is no keyword roster
//      that can silently suppress an otherwise relevant query;
//   3. writes the hook protocol response with `additionalContext` = the metadata-level
//      injection (or an empty string when nothing matches — INC-044/060).
//
// The command string registered in .claude/settings.json uses ${CLAUDE_PROJECT_DIR}
// (INC-040: a bare relative path means the hook never starts from a different cwd).

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const INJECT_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "knowledge-inject.mjs");

// This is a placement description, not an installer.  STORY-371 owns the helper archive,
// approval, user-level write and receipt; keeping those acts out of this file means the
// injection path can be fixture-validated without changing a user's persistent settings.
export const InjectionPlacementManifest = Object.freeze({
  schemaVersion: "tcrn.injection-placement-manifest.v1",
  events: Object.freeze({
    claude: Object.freeze(["SessionStart", "UserPromptSubmit", "PostCompact", "PostToolUse"]),
    codex: Object.freeze(["SessionStart", "UserPromptSubmit", "PostCompact", "PostToolUse"]),
  }),
  commands: Object.freeze({
    claude: 'node "${CLAUDE_PROJECT_DIR}/scripts/knowledge-inject-hook.mjs" --host claude',
    codex: 'node "${CODEX_PROJECT_DIR}/scripts/knowledge-inject-hook.mjs" --host codex',
  }),
  modelMapping: Object.freeze({
    setting: "model.economyTier",
    translator: "independent-uninjected-call-before-recall",
    judge: "independent-uninjected-call-after-recall",
    maxCallsPerPrompt: 1,
    timeoutMs: 10_000,
  }),
  runtimeState: Object.freeze({
    path: "~/.tcrn-injection/state.json",
    lock: "~/.tcrn-injection/state.lock",
    persisted: ["emittedIds", "byteAccounting", "promptDecisions", "pullCorrelations", "judgments"],
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
  if (manifest.modelMapping?.setting !== "model.economyTier" || manifest.modelMapping?.maxCallsPerPrompt !== 1 || manifest.modelMapping?.timeoutMs !== 10_000) return false;
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

export function boundedHookInput(input) {
  const source = input ?? {};
  const raw = JSON.stringify(source);
  if (Buffer.byteLength(raw, "utf8") <= MAX_HOOK_INPUT_BYTES) return raw;
  const { tool_response, toolResponse, ...rest } = source;
  return JSON.stringify({ ...rest, tcrnPayloadTruncated: true });
}

export function inferHost(input = {}, env = process.env) {
  const explicit = input?.host ?? input?.host_name ?? input?.hostName;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  if (typeof env?.TCRN_HOST === "string" && env.TCRN_HOST.length > 0) return env.TCRN_HOST;
  if (env?.CODEX_PROJECT_DIR && !env?.CLAUDE_PROJECT_DIR) return "codex";
  if (env?.CLAUDE_PROJECT_DIR && !env?.CODEX_PROJECT_DIR) return "claude";
  return "unknown-host";
}

export function runInject(input, { stateDirectory, host } = {}) {
  const event = input?.hook_event_name ?? "";
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  const sessionId = input?.session_id ?? input?.sessionId ?? "anonymous";
  const partition = input?.partition ?? process.env.TCRN_INJECTION_PARTITION ?? "cross-project";
  const argv = [
    INJECT_SCRIPT,
    "--prompt", prompt,
    "--partition", partition,
    "--event", event,
    "--session-id", String(sessionId),
    "--hook-input", boundedHookInput(input),
  ];
  if (stateDirectory) argv.push("--state-dir", stateDirectory);
  argv.push("--host", host ?? inferHost(input));
  const result = spawnSync(process.execPath, argv, {
    encoding: "utf8",
    timeout: 25_000,
    env: { ...process.env, ...(host ? { TCRN_HOST: host } : {}) },
  });
  const lines = `${result.stdout ?? ""}`.trim().split("\n").filter(Boolean);
  try { return JSON.parse(lines[lines.length - 1] ?? ""); } catch { return { ok: false, reasonCode: "INJECT_OUTPUT_UNPARSEABLE" }; }
}

export function buildHookResponse(input, { host } = {}) {
  const event = input.hook_event_name ?? "";
  // The host contract requires additionalContext to be a STRING (a JSON array is
  // schema-invalid and the whole hook output is dropped — verified against the Claude
  // Code hooks documentation, INC-044). Empty string when nothing matches.
  const chunks = [];

  const inject = () => {
    const result = runInject(input, { host: host ?? inferHost(input) });
    if (result.ok === true && result.injected === true && typeof result.injection === "string" && result.injection.length > 0) {
      const count = result.candidateCount ?? result.l0?.lines?.length ?? 0;
      chunks.push(`[平台知识注入 · ${count} 条 · 来源 cross-project 知识面]\n${result.injection}`);
    }
    return result;
  };

  if (["SessionStart", "UserPromptSubmit", "PostCompact", "PostToolUse"].includes(event)) inject();

  return { hookSpecificOutput: { hookEventName: event, additionalContext: chunks.join("\n") } };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const hostFlag = process.argv.indexOf("--host");
  const host = hostFlag >= 0 ? process.argv[hostFlag + 1] : undefined;
  process.stdout.write(`${JSON.stringify(buildHookResponse(readStdin(), { host }))}\n`);
}
