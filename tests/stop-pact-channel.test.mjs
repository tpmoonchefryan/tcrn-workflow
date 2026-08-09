// SPDX-License-Identifier: Apache-2.0
// INC-105 — the stop-pact gate must measure the registered command, not the pure decider.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { verifyStopPactChannel } from "../tools/stop-pact/verify-channel.mjs";

const TOOLS = join(process.cwd(), "tools");

function makeRoot(withHook = true) {
  const root = mkdtempSync(join(tmpdir(), "stop-pact-gate-"));
  mkdirSync(join(root, ".claude"), { recursive: true });
  const settings = withHook
    ? { hooks: { Stop: [{ hooks: [{ type: "command", command: "node \"${CLAUDE_PROJECT_DIR}/tools/stop-pact/hook.mjs\"" }] }] } }
    : { hooks: {} };
  writeFileSync(join(root, ".claude", "settings.json"), `${JSON.stringify(settings)}\n`);
  symlinkSync(TOOLS, join(root, "tools"));
  return root;
}

test("INC-105 runs the registered Stop command and validates the host decision", () => {
  const root = makeRoot();
  try {
    const result = verifyStopPactChannel({ projectDirs: [root], pactPath: join(root, "missing-pact.json") });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "STOP_PACT_CHANNEL_LIVE");
    assert.equal(result.roots[0].response.decision, "block");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("INC-105 is red when Stop is not registered", () => {
  const root = makeRoot(false);
  try {
    const result = verifyStopPactChannel({ projectDirs: [root], pactPath: join(root, "missing-pact.json") });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "STOP_PACT_HOOK_NOT_REGISTERED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("INC-105 is red for an active pact that expired without migration", () => {
  const root = makeRoot();
  const pactPath = join(root, "expired.json");
  writeFileSync(pactPath, JSON.stringify({ active: true, status: "running", expiresAt: "2026-08-07T00:00:00.000Z" }));
  try {
    const result = verifyStopPactChannel({ projectDirs: [root], pactPath });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "STOP_PACT_ACTIVE_EXPIRED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
