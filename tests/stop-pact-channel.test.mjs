// SPDX-License-Identifier: Apache-2.0
// INC-105 — the stop-pact gate must measure the registered command, not the pure decider.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  discoverStopPactRegistration,
  harnessSearchRoots,
  verifyStopPactChannel,
} from "../tools/stop-pact/verify-channel.mjs";

const TOOLS = join(process.cwd(), "tools");

function writeSettings(root, withHook) {
  mkdirSync(join(root, ".claude"), { recursive: true });
  const settings = withHook
    ? { hooks: { Stop: [{ hooks: [{ type: "command", command: "node \"${CLAUDE_PROJECT_DIR}/tools/stop-pact/hook.mjs\"" }] }] } }
    : { hooks: {} };
  writeFileSync(join(root, ".claude", "settings.json"), `${JSON.stringify(settings)}\n`);
}

function makeRoot(withHook = true) {
  const root = mkdtempSync(join(tmpdir(), "stop-pact-gate-"));
  writeSettings(root, withHook);
  symlinkSync(TOOLS, join(root, "tools"));
  return root;
}

/** A workspace root with the harness, and a nested repository without one. */
function makeNestedTree({ atRoot = true, atRepo = false } = {}) {
  const boundary = mkdtempSync(join(tmpdir(), "stop-pact-boundary-"));
  const root = join(boundary, "workspace-root");
  const repo = join(root, "classification", "repo");
  mkdirSync(repo, { recursive: true });
  if (atRoot) {
    writeSettings(root, true);
    symlinkSync(TOOLS, join(root, "tools"));
  }
  if (atRepo) {
    writeSettings(repo, true);
    symlinkSync(TOOLS, join(repo, "tools"));
  }
  return { boundary, root, repo };
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

// TCRN-CROSS-INC-218 — the gate finds the workspace root instead of being told two
// directories. The fixed pair named the repository and its parent; the 2026-08-16 ruling
// put harness at the chosen workspace root and archived the project-local copies, so the
// pair pointed at two places the harness is not and the gate read red on a live channel.

test("INC-218 discovery walks up to the workspace root that holds the harness", () => {
  const tree = makeNestedTree();
  try {
    const result = verifyStopPactChannel({
      discoverFrom: tree.repo,
      stopAt: tree.boundary,
      pactPath: join(tree.boundary, "missing-pact.json"),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "STOP_PACT_CHANNEL_LIVE");
    assert.equal(result.discoveredAt, tree.root, "the registration is two levels above the repository");
    assert.equal(result.roots[0].response.decision, "block", "and it is probed, not merely found");
  } finally {
    rmSync(tree.boundary, { recursive: true, force: true });
  }
});

test("INC-218 discovery prefers the nearest root, because that is the one a session reads", () => {
  const tree = makeNestedTree({ atRoot: true, atRepo: true });
  try {
    const discovery = discoverStopPactRegistration(tree.repo, tree.boundary);
    assert.equal(discovery.found, true);
    assert.equal(discovery.registration.projectDir, tree.repo);
  } finally {
    rmSync(tree.boundary, { recursive: true, force: true });
  }
});

test("INC-218 discovery is red when no ancestor registers the hook", () => {
  const tree = makeNestedTree({ atRoot: false });
  try {
    const result = verifyStopPactChannel({
      discoverFrom: tree.repo,
      stopAt: tree.boundary,
      pactPath: join(tree.boundary, "missing-pact.json"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "STOP_PACT_HOOK_NOT_REGISTERED");
    assert.ok(result.searched.length >= 3, "and it says where it looked");
  } finally {
    rmSync(tree.boundary, { recursive: true, force: true });
  }
});

test("INC-218 the walk stops at the boundary rather than reaching the user settings layer", () => {
  // ~/.claude/settings.json may legitimately register this same hook. It is the user
  // layer, not a workspace root, and counting it would answer a question nobody asked.
  const tree = makeNestedTree({ atRoot: false });
  writeSettings(tree.boundary, true);
  symlinkSync(TOOLS, join(tree.boundary, "tools"));
  try {
    const searched = harnessSearchRoots(tree.repo, tree.root);
    assert.deepEqual(searched.at(-1), tree.root, "the boundary is the last directory looked at");
    assert.ok(!searched.includes(tree.boundary), "and nothing above it is opened");
    const discovery = discoverStopPactRegistration(tree.repo, tree.root);
    assert.equal(discovery.found, false, "a registration above the boundary is not a workspace registration");
  } finally {
    rmSync(tree.boundary, { recursive: true, force: true });
  }
});
