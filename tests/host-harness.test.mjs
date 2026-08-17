// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-INC-220 — the harness is one roster rendered per host.
//
// Owner ruled that a host is under the harness from the moment it installs its adapter,
// that capabilities line up across hosts, and that a capability a host cannot express
// needs a workaround rather than a silent omission. Before this, the harness existed only
// as hand-kept JSON inside `.claude/settings.json`, so Codex ran under nothing at all.
//
// The event names, payload fields and blocking contracts asserted here come from the two
// official references, not from what the repository happened to already do:
//   https://learn.chatgpt.com/docs/hooks and https://code.claude.com/docs/en/hooks

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HARNESS_CAPABILITIES,
  HOSTS,
  capabilityGaps,
  claudeHarnessDrift,
  claudeHookSettings,
  codexHookDocument,
  hookEntriesFor,
  nonHookCapabilitiesFor,
} from "../scripts/host-harness.mjs";
import { applyHostHarness, harnessBytes } from "../scripts/host-harness-apply.mjs";
import { guardDecision, responseFor, stringsIn } from "../scripts/chain-write-guard.mjs";

// Codex's documented event set. Every event the harness uses must be in it, and Codex's
// set is a strict subset of Claude Code's, so membership here settles both directions.
const CODEX_EVENTS = new Set([
  "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact",
  "UserPromptSubmit", "SubagentStop", "Stop", "SessionStart", "SessionEnd", "SubagentStart",
]);

test("INC-220 every capability is claimed by every host", () => {
  assert.deepEqual(capabilityGaps(), [], "a capability blank for one host is how the harness became Claude-only");
  assert.ok(HARNESS_CAPABILITIES.length >= 5);
});

test("INC-220 a host that reaches a capability without a hook must say how", () => {
  // This is the workaround requirement, made checkable. Claude's declarative deny list has
  // no Codex equivalent; the roster has to record what Codex does instead.
  for (const host of HOSTS) {
    for (const entry of nonHookCapabilitiesFor(host)) {
      assert.equal(typeof entry.note, "string");
      assert.ok(entry.note.length > 40, `${host}/${entry.id} needs a real explanation, not a label`);
    }
  }
});

test("INC-220 every rostered event exists on Codex", () => {
  for (const entry of hookEntriesFor("codex")) {
    assert.ok(CODEX_EVENTS.has(entry.event), `${entry.event} is not a documented Codex hook event`);
  }
});

test("INC-220 the two renderings carry the same handlers for the same capabilities", () => {
  // Rendering differences are legitimate — file shape, command form, one host-specific
  // Stop handler. A capability present on one host and absent on the other is not.
  const claude = new Set(hookEntriesFor("claude").map((entry) => entry.id));
  const codex = new Set(hookEntriesFor("codex").map((entry) => entry.id));
  const claudeOnly = [...claude].filter((id) => !codex.has(id));
  assert.deepEqual(claudeOnly, [], "Codex would be missing a capability Claude has");
  for (const id of [...codex].filter((entry) => !claude.has(entry))) {
    const capability = HARNESS_CAPABILITIES.find((entry) => entry.id === id);
    assert.notEqual(capability.claude.mechanism, "hook", `${id} is a hook on Codex only`);
    assert.equal(typeof capability.claude.note, "string", `${id} needs Claude's mechanism stated`);
  }
});

test("INC-220 the Codex document is shaped the way the host documents it", () => {
  const document = codexHookDocument("/repo");
  assert.equal(typeof document.description, "string");
  for (const [event, groups] of Object.entries(document.hooks)) {
    assert.ok(CODEX_EVENTS.has(event));
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, "command", "only type:command runs on Codex");
        // Codex resolves no project-dir variable; a template would be written literally.
        assert.ok(!hook.command.includes("${CLAUDE_PROJECT_DIR}"), "Codex commands must be absolute");
        assert.ok(hook.command.startsWith("node \"/repo/"));
      }
    }
  }
});

test("INC-220 the Claude rendering keeps the project-dir form that host resolves", () => {
  for (const groups of Object.values(claudeHookSettings())) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.ok(hook.command.includes("${CLAUDE_PROJECT_DIR}"));
      }
    }
  }
});

test("INC-220 harness drift is reported when a live Claude hook is gone", () => {
  const root = mkdtempSync(join(tmpdir(), "tcrn-harness-"));
  try {
    const path = join(root, "settings.json");
    writeFileSync(path, JSON.stringify({ hooks: {}, permissions: { deny: [] } }));
    const drift = claudeHarnessDrift(path);
    assert.ok(drift.length >= hookEntriesFor("claude").length, "every missing hook is named");
    assert.ok(drift.some((finding) => finding.capability === "control-tree-write-refusal"), "and the missing deny rules too");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("INC-220 applying the Codex harness is idempotent and atomic", () => {
  const root = mkdtempSync(join(tmpdir(), "tcrn-harness-"));
  try {
    mkdirSync(join(root, ".codex"), { recursive: true });
    const first = applyHostHarness("codex", root, { repoRoot: "/repo" });
    assert.equal(first.reasonCode, "HOST_HARNESS_WRITTEN");
    assert.equal(readFileSync(first.path, "utf8"), harnessBytes("codex", "/repo"));
    const second = applyHostHarness("codex", root, { repoRoot: "/repo" });
    assert.equal(second.reasonCode, "HOST_HARNESS_ALREADY_CURRENT");
    assert.equal(second.wrote, false, "an unchanged harness is not rewritten");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("INC-220 Claude's settings are not writable through the applier", () => {
  // Rewriting a live session's settings underneath it is a worse failure than the drift.
  assert.throws(() => harnessBytes("claude"), (error) => error?.reasonCode === "HOST_HARNESS_NOT_WRITABLE");
});

test("INC-220 the guard REFUSES an edit into a control tree", () => {
  for (const tool of ["Write", "Edit", "apply_patch"]) {
    const decision = guardDecision({ tool_name: tool, tool_input: { file_path: "/x/.tcrn-workspace/cross-project/workspace/head.json" } });
    assert.equal(decision.deny, true, tool);
    const response = responseFor(decision);
    assert.equal(response.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(response.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.ok(response.hookSpecificOutput.permissionDecisionReason.includes(tool));
  }
});

test("INC-220 the guard finds a target nested anywhere in the tool input", () => {
  // apply_patch carries its targets inside patch text, and the host owns that schema. A
  // rule bound to tool_input.file_path would read as coverage while missing it.
  const decision = guardDecision({
    tool_name: "apply_patch",
    tool_input: { changes: [{ patch: "*** Update File: .tcrn-workflow/state.json\n+x" }] },
  });
  assert.equal(decision.deny, true);
  assert.deepEqual(decision.trees, [".tcrn-workflow"]);
  assert.ok(stringsIn({ a: { b: ["deep"] } }).includes("deep"));
});

test("INC-220 the guard does NOT touch Bash, or the engine could not read its own chain", () => {
  // Every governed read names the workspace it reads. A path-substring rule over shell
  // would refuse the engine itself, which is why Bash belongs to the SSH write observer.
  const decision = guardDecision({
    tool_name: "Bash",
    tool_input: { command: "node scripts/tcrn-workflow.mjs status --workspace .tcrn-workspace/cross-project/workspace" },
  });
  assert.equal(decision.deny, false);
});

test("INC-220 the guard leaves ordinary edits and reads alone", () => {
  assert.equal(guardDecision({ tool_name: "Edit", tool_input: { file_path: "/repo/README.md" } }).deny, false);
  assert.equal(guardDecision({ tool_name: "Read", tool_input: { file_path: "/x/.tcrn-workspace/a" } }).deny, false);
  assert.equal(guardDecision({}).deny, false);
  assert.equal(responseFor({ deny: false }), null);
});
