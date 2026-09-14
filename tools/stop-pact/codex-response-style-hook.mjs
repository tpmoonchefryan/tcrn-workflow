#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Codex Stop adapter for TCRN-CROSS-STORY-357 — the response-style check ported to
// Codex's Stop payload shape.
//
// This is a shape adapter, not a second rule set: `checkResponseText` and
// `responseStyleReason` are imported unchanged from ./response-style-hook.mjs. It is
// the same pattern codex-executor.mjs uses for decide.mjs — one decider, one thin
// per-host adapter, the rule never copied.
//
// Why a straight port of response-style-hook.mjs would not have worked: its
// `inspectTranscript` reads `input.transcript_path`, a Claude Code Stop field, and
// resolves the assistant text by reading that path as a transcript file. Codex's
// real Stop event carries no `transcript_path` at all — the assistant text arrives
// inline, as `last_assistant_message` (confirmed against the real-payload fixture
// in tests/codex-stop-pact.test.mjs). Reading `transcript_path` against a Codex
// payload would leave `path` as `""` on every real Codex Stop event, which makes
// `inspectTranscript` report `skipped:true` unconditionally — a check that always
// passes and never errors. That silent-pass shape is exactly what this file exists
// to avoid.
//
// Fail-open, unconditionally: an advisory style check must never make a Codex
// session un-stoppable. Every path below is wrapped so a throw here exits 0 with no
// block — the same posture ./response-style-hook.mjs takes for Claude Code.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { responseAudienceCheck, responseStyleReason } from "./response-style-hook.mjs";

/**
 * Codex's real Stop payload carries the assistant text inline, not as a file path.
 * `stop_hook_active` is the same loop guard Claude's Stop payload uses; a missing or
 * empty `last_assistant_message` is an observation gap, not a violation, so it is
 * skipped rather than treated as compliant or non-compliant text.
 */
export function inspectCodexStopInput(input) {
  if (input?.stop_hook_active === true) return { ok: true, skipped: true, text: "" };
  const text = typeof input?.last_assistant_message === "string" ? input.last_assistant_message : "";
  return text.length === 0 ? { ok: true, skipped: true, text: "" } : { ok: true, skipped: false, text };
}

export function checkCodexStopInput(input, options = {}) {
  const inspected = inspectCodexStopInput(input);
  if (inspected.skipped) return { ok: true, skipped: true, violations: [] };
  // An explicit audience is authoritative for routing.  Legacy callers without
  // a field retain the old direct-library behaviour; internal/unknown bindings
  // never receive Owner-only lexical enforcement.
  return responseAudienceCheck(inspected.text, input, options);
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = checkCodexStopInput(readStdin(), { legacyMissing: false });
    if (!result.ok) process.stdout.write(`${JSON.stringify({ decision: "block", reason: responseStyleReason(result) })}\n`);
  } catch {
    // Stop checks are advisory enforcement. Any failure is explicitly fail-open.
    process.exitCode = 0;
  }
}
