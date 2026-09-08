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

function readStdin() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return {}; }
}

function runInject(prompt) {
  const result = spawnSync(process.execPath, [INJECT_SCRIPT, "--prompt", prompt], {
    encoding: "utf8", timeout: 25_000
  });
  try { return JSON.parse(result.stdout); } catch { return { ok: false, reasonCode: "INJECT_OUTPUT_UNPARSEABLE" }; }
}

export function buildHookResponse(input) {
  const event = input.hook_event_name ?? "";
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  // The host contract requires additionalContext to be a STRING (a JSON array is
  // schema-invalid and the whole hook output is dropped — verified against the Claude
  // Code hooks documentation, INC-044). Empty string when nothing matches.
  const chunks = [];

  const inject = (p) => {
    const result = runInject(p);
    if (result.ok === true && result.injected === true && typeof result.injection === "string" && result.injection.length > 0) {
      chunks.push(`[平台知识注入 · ${result.candidateCount} 条 · 来源 cross-project 知识面]${result.injection}`);
    }
    return result;
  };

  if (event === "SessionStart") {
    // Baseline, once per session: query with a single broad term (the "lesson" tag is on
    // every curated card), no trigger gate, budget-capped. TCRN-CROSS-STORY-362 replaced
    // the AND-token substring scan behind this with bm25 recall, so a multi-term query no
    // longer pulls to zero; the single broad term stays because a session with no prompt
    // yet has nothing more specific to ask, and recall's own floor decides what it returns.
    inject("lesson", "");
  } else if (event === "UserPromptSubmit") {
    const result = inject(prompt);
    // A prompt with no query tokens still gets the baseline (metadata-only, budgeted).
    if (result.injected === false && result.reason === "NO_QUERY_TOKENS") inject("lesson", "");
  }

  return { hookSpecificOutput: { hookEventName: event, additionalContext: chunks.join("\n") } };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.stdout.write(`${JSON.stringify(buildHookResponse(readStdin()))}\n`);
}
