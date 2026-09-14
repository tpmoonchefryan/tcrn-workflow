// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-357 — the Codex Stop adapter for the response-style check.
//
// The adapter's only job is shape conversion: Codex's real Stop payload carries the
// assistant text inline as `last_assistant_message`, not as a `transcript_path` to
// read from disk the way Claude Code's does. These tests cover the shape-adapter
// behavior directly (the skip conditions, rule delegation) and the CLI bridge's
// host-facing stdout contract. The response-style rules themselves already have
// their own coverage where they are defined, in tests/stop-pact.test.mjs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkCodexStopInput, inspectCodexStopInput } from "../tools/stop-pact/codex-response-style-hook.mjs";

const HOOK_PATH = fileURLToPath(new URL("../tools/stop-pact/codex-response-style-hook.mjs", import.meta.url));

function run(input) {
  return spawnSync(process.execPath, [HOOK_PATH], { input: JSON.stringify(input), encoding: "utf8" });
}

test("STORY-357 a violating last_assistant_message is reported, not silently passed", () => {
  const result = checkCodexStopInput({ hook_event_name: "Stop", last_assistant_message: "前后对比" });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].rule, 5);
});

test("STORY-357 stop_hook_active is a loop guard and is skipped without inspecting the text", () => {
  const inspected = inspectCodexStopInput({ stop_hook_active: true, last_assistant_message: "前后对比" });
  assert.equal(inspected.skipped, true);
  assert.equal(inspected.text, "");
  const result = checkCodexStopInput({ stop_hook_active: true, last_assistant_message: "前后对比" });
  assert.deepEqual(result, { ok: true, skipped: true, violations: [] });
});

test("STORY-357 a missing or empty last_assistant_message is skipped, not an error", () => {
  assert.deepEqual(checkCodexStopInput({ hook_event_name: "Stop" }), { ok: true, skipped: true, violations: [] });
  assert.deepEqual(checkCodexStopInput({ hook_event_name: "Stop", last_assistant_message: "" }), { ok: true, skipped: true, violations: [] });
  assert.deepEqual(checkCodexStopInput({}), { ok: true, skipped: true, violations: [] });
  assert.deepEqual(checkCodexStopInput(null), { ok: true, skipped: true, violations: [] });
});

test("STORY-357 the CLI bridge emits the host block envelope only on a violation", () => {
  const violating = run({ hook_event_name: "Stop", session_id: "codex-session", last_assistant_message: "前后对比", audience: "owner" });
  assert.equal(violating.status, 0);
  const response = JSON.parse(violating.stdout);
  assert.deepEqual(Object.keys(response).sort(), ["decision", "reason"]);
  assert.equal(response.decision, "block");
  assert.ok(response.reason.includes("规则 5"));

  const omittedAudience = run({ hook_event_name: "Stop", session_id: "codex-session", last_assistant_message: "前后对比" });
  assert.equal(omittedAudience.status, 0);
  assert.equal(omittedAudience.stdout, "", "an omitted host binding must not infer Owner mode");

  const compliant = run({ hook_event_name: "Stop", session_id: "codex-session", last_assistant_message: "一切正常" });
  assert.equal(compliant.status, 0);
  assert.equal(compliant.stdout, "", "a compliant response must not emit anything to Codex");
});
