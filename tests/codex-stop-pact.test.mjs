// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_STOP_PACT_EXECUTION_VERSION,
  decideCodexStop,
  executeCodexStop,
  hostStopResponse,
  normalizeCodexStopInput,
} from "../tools/stop-pact/codex-executor.mjs";
import {
  buildPact,
  writePact,
} from "../tools/stop-pact/pact.mjs";

const NOW = "2026-08-07T12:00:00.000Z";

function pact(overrides = {}) {
  return {
    ...buildPact({
      scope: "finish the governed change",
      authorizedBy: "owner",
      now: "2026-08-07T00:00:00.000Z",
      boundSession: "codex-session",
    }),
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    schemaVersion: CODEX_STOP_PACT_EXECUTION_VERSION,
    sessionId: "codex-session",
    model: "gpt-5-codex",
    now: NOW,
    workedSinceLastBlock: true,
    ...overrides,
  };
}

test("Codex and Claude judge the same shared pact state, with no second status source", () => {
  const verdict = decideCodexStop(event(), pact());
  assert.equal(verdict.action, "block");
  assert.equal(verdict.reasonCode, "BLOCK_RUNNING");
  assert.equal(verdict.mode, "enforce");
  assert.equal(verdict.governingStatus, "running");

  const terminal = decideCodexStop(
    event({ model: "gpt-5-codex" }),
    pact({ status: "completed", active: false }),
  );
  assert.equal(terminal.action, "allow");
  assert.equal(terminal.reasonCode, "NO_ACTIVE_PACT");
});

test("missing or unidentifiable Codex facts fail toward allow", () => {
  const running = pact();
  assert.equal(decideCodexStop(null, running).action, "allow");
  assert.equal(decideCodexStop(event({ sessionId: "" }), running).reasonCode, "CODEX_STOP_CONTEXT_UNAVAILABLE");
  assert.equal(decideCodexStop(event({ workedSinceLastBlock: undefined }), running).reasonCode, "CODEX_STOP_CONTEXT_UNAVAILABLE");

  const unknown = decideCodexStop(event({ model: null }), running);
  assert.equal(unknown.action, "allow");
  assert.equal(unknown.reasonCode, "OBSERVE_WOULD_BLOCK");
  assert.equal(unknown.mode, "observe");
  assert.equal(unknown.modelKnown, false);
  assert.equal(decideCodexStop(event({ model: "unknown" }), running).mode, "observe");
  assert.equal(decideCodexStop(event({ model: "   " }), running).reasonCode, "CODEX_STOP_CONTEXT_UNAVAILABLE");
});

test("Codex work state, not model identity, decides the enforce branch", () => {
  const running = pact();
  const productive = decideCodexStop(event({ workedSinceLastBlock: true }), running);
  const stalled = decideCodexStop(event({ workedSinceLastBlock: false }), {
    ...running,
    runtime: { ...running.runtime, consecutiveBlocks: 3 },
  });
  assert.equal(productive.reasonCode, "BLOCK_RUNNING");
  assert.equal(stalled.reasonCode, "ESCALATION_RELEASE");
  assert.equal(decideCodexStop(event({ model: "gpt-5-codex" }), {
    ...running,
    status: "blocked",
    active: false,
  }).action, "allow");
});

test("the real Codex Stop payload is accepted without its own schema envelope", () => {
  const hostEvent = {
    hook_event_name: "Stop",
    session_id: "codex-session",
    model: "gpt-5-codex",
    stop_hook_active: false,
    tool_use_count: 9,
    now: NOW,
    cwd: "/workspace",
    last_assistant_message: "I should continue",
  };
  const normalized = normalizeCodexStopInput(hostEvent, pact());
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.sessionId, "codex-session");
  assert.equal(normalized.value.workedSinceLastBlock, true);
  const result = decideCodexStop(hostEvent, pact());
  assert.equal(result.action, "block");
  assert.equal(result.reasonCode, "BLOCK_RUNNING");
  const response = hostStopResponse(result);
  assert.deepEqual(Object.keys(response).sort(), ["decision", "reason"]);
  assert.equal(response.decision, "block");
  assert.ok(response.reason.length > 0);
});

test("Codex stop_hook_active is a loop guard and never emits another block", () => {
  const result = decideCodexStop({
    hook_event_name: "Stop",
    session_id: "codex-session",
    model: "gpt-5-codex",
    stop_hook_active: true,
    tool_use_count: 10,
    now: NOW,
  }, pact({ runtime: { consecutiveBlocks: 1, lastBlockToolUses: 9 } }));
  assert.equal(result.action, "allow");
  assert.equal(result.reasonCode, "STOP_HOOK_ACTIVE");
  assert.equal(hostStopResponse(result), null);
});

test("Codex terminal and expiry branches are explicit red-leg coverage", () => {
  const expired = decideCodexStop(event({ now: "2026-08-09T00:00:00.000Z" }), pact());
  assert.equal(expired.reasonCode, "PACT_EXPIRED");
  assert.equal(expired.action, "allow");

  const completed = decideCodexStop(event(), pact({ status: "completed", active: true }));
  assert.equal(completed.reasonCode, "STATUS_COMPLETED");
  assert.equal(completed.action, "allow");

  const ownerDirective = decideCodexStop(event(), pact({ status: "owner_directive", active: true }));
  assert.equal(ownerDirective.reasonCode, "STATUS_OWNER_DIRECTIVE");
  assert.equal(ownerDirective.action, "allow");

  const unknownModel = decideCodexStop(event({ model: "brand-new-model" }), pact());
  assert.equal(unknownModel.reasonCode, "OBSERVE_WOULD_BLOCK");
  assert.equal(unknownModel.mode, "observe");
  assert.equal(unknownModel.action, "allow");
});

test("executor updates the shared pact only for the owning Codex session", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-stop-pact-"));
  try {
    const path = join(dir, "current.json");
    writePact(pact({ boundSession: null }), path);
    const blocked = executeCodexStop(event({ toolUseCount: 9 }), { path });
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(blocked.reasonCode, "BLOCK_RUNNING");
    assert.equal(blocked.wrotePact, true);
    assert.equal(after.boundSession, "codex-session");
    assert.equal(after.runtime.consecutiveBlocks, 1);
    assert.equal(after.runtime.lastBlockToolUses, 9);

    const bystander = executeCodexStop(event({ sessionId: "other-session" }), { path });
    const unchanged = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(bystander.reasonCode, "OTHER_SESSION");
    assert.equal(bystander.wrotePact, false);
    assert.equal(unchanged.runtime.consecutiveBlocks, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default stdin bridge speaks only the host protocol; diagnostics are opt-in", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-stop-pact-cli-"));
  try {
    const path = join(dir, "missing.json");
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../tools/stop-pact/codex-executor.mjs", import.meta.url)),
    ], {
      input: JSON.stringify(event()),
      env: { ...process.env, TCRN_STOP_PACT_PATH: path },
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "", "an allow decision must not emit the internal envelope to Codex");

    const diagnostic = spawnSync(process.execPath, [
      fileURLToPath(new URL("../tools/stop-pact/codex-executor.mjs", import.meta.url)),
      "--diagnostic",
    ], {
      input: JSON.stringify(event()),
      env: { ...process.env, TCRN_STOP_PACT_PATH: path },
      encoding: "utf8",
    });
    assert.equal(diagnostic.status, 0);
    const output = JSON.parse(diagnostic.stdout);
    assert.equal(output.schemaVersion, CODEX_STOP_PACT_EXECUTION_VERSION);
    assert.equal(output.reasonCode, "NO_ACTIVE_PACT");
    assert.equal(output.action, "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real-host block is emitted as exactly the Codex decision object", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-stop-pact-host-"));
  try {
    const path = join(dir, "current.json");
    writePact(pact(), path);
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../tools/stop-pact/codex-executor.mjs", import.meta.url)),
    ], {
      input: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "codex-session",
        model: "gpt-5-codex",
        stop_hook_active: false,
        tool_use_count: 9,
        now: NOW,
        extra_host_field: "ignored",
      }),
      env: { ...process.env, TCRN_STOP_PACT_PATH: path },
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    const response = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(response).sort(), ["decision", "reason"]);
    assert.equal(response.decision, "block");
    assert.ok(response.reason.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
