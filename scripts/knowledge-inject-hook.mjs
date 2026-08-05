#!/usr/bin/env node
// TCRN-CROSS-INIT-019 STORY-162.4 — the hook wrapper for knowledge injection.
//
// Claude Code fires a hook with a JSON body on stdin (SessionStart has no prompt;
// UserPromptSubmit carries `prompt`). This wrapper:
//   1. reads stdin;
//   2. runs the injection chain (tcrn-workflow/scripts/knowledge-inject.mjs) with the
//      prompt and a curated trigger-keyword list (local, cheap gate — no network when
//      the prompt matches nothing);
//   3. writes the hook protocol response with `additionalContext` = the metadata-level
//      injection (or an empty array when nothing matches).
//
// The command string registered in .claude/settings.json uses ${CLAUDE_PROJECT_DIR}
// (INC-040: a bare relative path means the hook never starts from a different cwd).

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const INJECT_SCRIPT = resolve(PLATFORM_ROOT, "tcrn-workflow/scripts/knowledge-inject.mjs");
export const TRIGGER_KEYWORDS = process.env.TCRN_KNOWLEDGE_TRIGGER_KEYWORDS
  ?? "hook,仪式,rebase,门,探针,复核,证据,判据,CI,验证,CAS,marker,store,SSH,ssh";

function readStdin() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return {}; }
}

function runInject(prompt, triggerKeywords = TRIGGER_KEYWORDS) {
  const result = spawnSync(process.execPath, [INJECT_SCRIPT, "--prompt", prompt, "--trigger-keywords", triggerKeywords], {
    encoding: "utf8", timeout: 25_000
  });
  try { return JSON.parse(result.stdout); } catch { return { ok: false, reasonCode: "INJECT_OUTPUT_UNPARSEABLE" }; }
}

export function buildHookResponse(input) {
  const event = input.hook_event_name ?? "";
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const additionalContext = [];

  const inject = (p, triggers = TRIGGER_KEYWORDS) => {
    const result = runInject(p, triggers);
    if (result.ok === true && result.injected === true && typeof result.injection === "string" && result.injection.length > 0) {
      additionalContext.push(`[平台知识注入 · ${result.candidateCount} 条 · 来源 cross-project 知识面]${result.injection}`);
    }
    return result;
  };

  if (event === "SessionStart") {
    // Baseline, once per session: query with a single broad term (the "lesson" tag is on
    // every curated card), no trigger gate, budget-capped. A multi-term query would be
    // AND-token FTS and pull to zero (measured in STORY-161.5).
    inject("lesson", "");
  } else if (event === "UserPromptSubmit") {
    const result = inject(prompt);
    // A prompt with no query tokens still gets the baseline (metadata-only, budgeted).
    if (result.injected === false && result.reason === "NO_QUERY_TOKENS") inject("lesson", "");
  }

  return { hookSpecificOutput: { hookEventName: event, additionalContext } };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.stdout.write(`${JSON.stringify(buildHookResponse(readStdin()))}\n`);
}
