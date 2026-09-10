// SPDX-License-Identifier: Apache-2.0
// INIT-028 S244/S245: dispatch settings, historical model-plan replay, and retired writes.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeWorkspace, validateWorkspace } from "../dist/build/packages/core/src/index.js";

const instant = (second) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString().replace(/\.\d+Z$/u, "Z");

async function json(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(args) {
  try { await runCli(args, { write() {} }); } catch (error) { return error; }
  assert.fail(`expected ${args[0]} to refuse`);
}

async function fixture(context, suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s244-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: `FIXTURE-S244-${suffix}`, createdAt: instant(0) });
  const workspace = join(base, "workspace");
  const version = async () => (await json(["status", "--workspace", workspace])).version;
  return { workspace, version };
}

const write = (command, workspace, version, at, args) => [command, "--workspace", workspace, "--expected-version", String(version), "--at", instant(at), ...args, "--actor", "agent:test"];

test("S369: dispatch writes preserve CAS, actor, settings.updated, and exact round-trip values", async (t) => {
  const { workspace, version } = await fixture(t, "dispatch-writes");
  const enabled = await json(["attestation-enable", "--workspace", workspace, "--expected-version", "0", "--at", instant(1), "--actor", "agent:attester"]);
  assert.equal(enabled.version, 1);

  const tiers = JSON.stringify({ flagship: null, main: { model: "main-model", effort: "xhigh2" }, economy: { model: "economy-model", effort: "" } });
  const first = await json(write("dispatch-tiers-set", workspace, await version(), 2, ["--host", "gemini", "--tiers", tiers]));
  assert.equal(first.reasonCode, "DISPATCH_CONFIG_WRITE_COMMITTED");
  assert.equal(first.version, 2);
  assert.equal(first.tiers.gemini.main.effort, "xhigh2");

  const classes = await json(write("dispatch-classes-set", workspace, await version(), 3, ["--classes", JSON.stringify({ "review-visual": { dispatch: true, verify: false } })]));
  assert.equal(classes.version, 3);
  assert.deepEqual(classes.classes["review-visual"], { dispatch: true, verify: false });

  const modes = await json(write("dispatch-mode-set", workspace, await version(), 4, ["--name", "custom", "--mapping", JSON.stringify({ "review-visual": "main" })]));
  assert.equal(modes.version, 4);
  const resolved = await json(["dispatch-mode-list", "--workspace", workspace, "--host", "gemini", "--class", "review-visual", "--mode", "custom"]);
  assert.deepEqual(resolved.resolution, {
    taskClass: "review-visual",
    host: "gemini",
    mode: "custom",
    dispatch: true,
    verify: false,
    requestedTier: "main",
    resolvedTier: "main",
    value: { model: "main-model", effort: "xhigh2" },
  });

  const replayed = await validateWorkspace(workspace);
  const settingsEvents = replayed.events.filter((event) => event.payload.operation === "settings.updated");
  assert.equal(settingsEvents.length, 3);
  assert.deepEqual(settingsEvents.map((event) => event.payload.actor), ["agent:test", "agent:test", "agent:test"]);
  assert.ok(settingsEvents.every((event) => event.payload.record.key.startsWith("execution.dispatch")));
  assert.equal(replayed.version, 4);
  assert.equal((await json(["validate", "--workspace", workspace])).reasonCode, "WORKSPACE_COMMAND_COMPLETED");

  const stale = await refusal(write("dispatch-mode-set", workspace, 2, 5, ["--name", "stale", "--mapping", JSON.stringify({ implement: "main" })]));
  assert.notEqual(stale.reasonCode, undefined);
  assert.equal(await version(), 4);
  const headed = await json(write("dispatch-mode-set", workspace, "head", 6, ["--name", "headed", "--mapping", JSON.stringify({ implement: "main" })]));
  assert.equal(headed.version, 5);
});

test("S369: two host tier tables stay isolated while a mode switch changes resolution", async (t) => {
  const { workspace, version } = await fixture(t, "mode-isolation");
  const claude = await json(write("dispatch-tiers-set", workspace, await version(), 1, ["--host", "claude-code", "--tiers", JSON.stringify({ flagship: null, main: { model: "claude-main", effort: "high" }, economy: { model: "claude-eco", effort: "low" } })]));
  const codex = await json(write("dispatch-tiers-set", workspace, await version(), 2, ["--host", "codex", "--tiers", JSON.stringify({ flagship: null, main: { model: "codex-main", effort: "medium" }, economy: { model: "codex-eco", effort: "none" } })]));
  await json(write("dispatch-mode-set", workspace, await version(), 3, ["--name", "custom", "--mapping", JSON.stringify({ implement: "economy" })]));

  const frontier = await json(["dispatch-mode-list", "--workspace", workspace, "--host", "claude-code", "--class", "implement"]);
  assert.equal(frontier.resolution.value.model, "claude-main");
  assert.equal(frontier.resolution.dispatch, true);
  assert.equal(frontier.resolution.verify, true);
  const codexRead = await json(["dispatch-mode-list", "--workspace", workspace, "--host", "codex", "--class", "implement"]);
  assert.equal(codexRead.resolution.value.model, "codex-main", "frontier reads the selected host's main row");

  const switched = await json(write("settings-set", workspace, await version(), 4, ["--key", "execution.dispatchMode", "--value", "custom"]));
  assert.equal(switched.version, 4);
  const custom = await json(["dispatch-mode-list", "--workspace", workspace, "--host", "codex", "--class", "implement"]);
  assert.equal(custom.mode, "custom");
  assert.deepEqual(custom.resolution.value, { model: "codex-eco", effort: "none" });
  const reloaded = await validateWorkspace(workspace);
  assert.equal(reloaded.settings.find((entry) => entry.key === "execution.dispatchMode").value, "custom");
  assert.equal(reloaded.settings.find((entry) => entry.key === "execution.dispatchTiers").value.includes("claude-main"), true);
  assert.equal(reloaded.settings.find((entry) => entry.key === "execution.dispatchTiers").value.includes("codex-eco"), true);
  assert.equal(claude.version, 1);
  assert.equal(codex.version, 2);
});

test("S369: malformed dispatch shapes and missing behaviour bits refuse without moving the head", async (t) => {
  const { workspace, version } = await fixture(t, "dispatch-refusals");
  const before = await json(["status", "--workspace", workspace]);
  const missingBoth = await refusal(write("dispatch-classes-set", workspace, before.version, 1, ["--classes", JSON.stringify({ "review-visual": {} })]));
  assert.equal(missingBoth.reasonCode, "DISPATCH_CLASS_BEHAVIOUR_REQUIRED");
  assert.match(missingBoth.message, /dispatch.*verify/u);
  const afterMissingBoth = await json(["status", "--workspace", workspace]);
  assert.equal(afterMissingBoth.version, before.version);
  assert.equal(afterMissingBoth.headEventHash, before.headEventHash);
  const missingDispatch = await refusal(write("dispatch-classes-set", workspace, 0, 1, ["--classes", JSON.stringify({ "review-visual": { verify: false } })]));
  assert.equal(missingDispatch.reasonCode, "DISPATCH_CLASS_BEHAVIOUR_REQUIRED");
  assert.match(missingDispatch.message, /dispatch.*verify/u);
  const missingVerify = await refusal(write("dispatch-classes-set", workspace, 0, 1, ["--classes", JSON.stringify({ "review-visual": { dispatch: true } })]));
  assert.equal(missingVerify.reasonCode, "DISPATCH_CLASS_BEHAVIOUR_REQUIRED");
  assert.match(missingVerify.message, /dispatch.*verify/u);
  const cases = [
    ["dispatch-tiers-set", ["--host", "gemini", "--tiers", JSON.stringify({ main: { model: "model" } })]],
    ["dispatch-mode-set", ["--name", "broken", "--mapping", JSON.stringify({ implement: "unknown-tier" })]],
    ["settings-set", ["--key", "execution.dispatchClasses", "--value", JSON.stringify({ "review-visual": { dispatch: true } })]],
  ];
  for (const [command, args] of cases) {
    const error = await refusal(write(command, workspace, await version(), 1, args));
    assert.ok(error.reasonCode);
    assert.equal(await version(), before.version, `${command} must not append on refusal`);
    assert.equal((await json(["status", "--workspace", workspace])).headEventHash, before.headEventHash);
  }
  const missing = await refusal(["dispatch-mode-list", "--workspace", workspace, "--host", "gemini"]);
  assert.equal(missing.reasonCode, "CLI_ARGUMENT_MISSING");
  assert.equal((await json(["status", "--workspace", workspace])).version, 0);
  const shape = { gemini: { flagship: null, main: { model: "", effort: "" }, economy: null } };
  const envelopeOverhead = JSON.stringify(shape).length;
  const atLimit = JSON.stringify({ gemini: { flagship: null, main: { model: "x".repeat(4096 - envelopeOverhead), effort: "" }, economy: null } });
  assert.equal(atLimit.length, 4096);
  const accepted = await json(write("settings-set", workspace, 0, 2, ["--key", "execution.dispatchTiers", "--value", atLimit]));
  assert.equal(accepted.version, 1, "the existing 4096-character setting envelope accepts its boundary");
  const beforeOversized = await json(["status", "--workspace", workspace]);
  const oversized = JSON.stringify({ gemini: { flagship: null, main: { model: "x".repeat(4097 - envelopeOverhead), effort: "" }, economy: null } });
  assert.equal(oversized.length, 4097);
  const rejected = await refusal(write("settings-set", workspace, beforeOversized.version, 3, ["--key", "execution.dispatchTiers", "--value", oversized]));
  assert.equal(rejected.reasonCode, "SETTINGS_VALUE_INVALID");
  assert.equal((await json(["status", "--workspace", workspace])).version, beforeOversized.version);
  assert.equal((await json(["status", "--workspace", workspace])).headEventHash, beforeOversized.headEventHash);
});

test("S369: retired model-plan CLI names refuse while historical records remain readable", async (t) => {
  const { workspace, version } = await fixture(t, "retirement");
  for (const command of ["model-plan-assign", "model-plan-list", "model-plan-remove", "model-plan-set", "model-plan-unassign"]) {
    const error = await refusal([command]);
    assert.equal(error.reasonCode, "CLI_COMMAND_UNKNOWN");
    const withLegacyFlags = await refusal([command, "--workspace", workspace, "--expected-version", "0", "--at", instant(1), "--host", "codex", "--name", "legacy", "--default-model", "model"]);
    assert.equal(withLegacyFlags.reasonCode, "CLI_COMMAND_UNKNOWN");
  }
  assert.equal((await json(["persona-list", "--workspace", workspace])).modelPlans.length, 0);
  assert.equal(await version(), 0);
});

test("S369: selected dispatch mode resets through ordinary settings removal", async (t) => {
  const { workspace, version } = await fixture(t, "mode-clear");
  const changed = await json(write("settings-set", workspace, await version(), 1, ["--key", "execution.dispatchMode", "--value", "eco"]));
  assert.equal(changed.version, 1);
  assert.equal((await json(["dispatch-mode-list", "--workspace", workspace])).mode, "eco");
  const cleared = await json(write("settings-remove", workspace, await version(), 2, ["--key", "execution.dispatchMode"]));
  assert.equal(cleared.version, 2);
  assert.equal((await json(["dispatch-mode-list", "--workspace", workspace])).mode, "frontier");
});

test("S233: the two policy keys are in the catalog with their closed value sets", async (t) => {
  const { workspace } = await fixture(t, "policy-keys-remediation");
  const catalog = await json(["settings-catalog", "--workspace", workspace]);
  const policy = catalog.settings.find((entry) => entry.key === "execution.subagentPolicy");
  assert.deepEqual(policy.allowedValues, ["allowed", "review-only", "forbidden"]);
  assert.equal(policy.defaultValue, "allowed");
  assert.equal(policy.currentValue, "allowed");
  const floor = catalog.settings.find((entry) => entry.key === "execution.independenceFloor");
  assert.deepEqual(floor.allowedValues, ["none", "verification", "verification-and-risk", "all"]);
  assert.equal(floor.defaultValue, "none");
  const status = await json(["status", "--workspace", workspace]);
  const bad = await refusal(write("settings-set", workspace, status.version, 1, ["--key", "execution.subagentPolicy", "--value", "not-a-policy"]));
  assert.equal(bad.reasonCode, "SETTINGS_VALUE_INVALID");
});

async function conferenceFixture(context, suffix, floor) {
  const { workspace, version } = await fixture(context, suffix);
  if (floor !== null) await json(write("settings-set", workspace, await version(), 1, ["--key", "execution.independenceFloor", "--value", floor]));
  const project = (await json(write("project-create", workspace, await version(), 2, ["--external-key", `S234-REMED-${suffix}`, "--name", "s234-remediation"]))).record.id;
  const anchor = (await json(write("work-create", workspace, await version(), 3, ["--project-id", project, "--external-key", `S234-REMED-INIT-${suffix}`, "--kind", "Initiative", "--title", "s234-remediation-anchor"]))).record.id;
  const opened = await json(write("conference-open", workspace, await version(), 4, ["--external-key", `S234-REMED-CONF-${suffix}`, "--project-id", project, "--type", "verification", "--title", "acceptance", "--work-ids", anchor, "--desired-outcome", "recommendation", "--participant-ids", "agent:test"]));
  return { workspace, version, conferenceId: opened.recordId ?? opened.record.id };
}

const closeArguments = (workspace, versionValue, conferenceId, extra = []) => [
  "conference-close", "--workspace", workspace, "--expected-version", String(versionValue), "--at", instant(9), "--conference-id", conferenceId,
  "--minutes-external-key", "S234-REMED-MIN", "--summary", "s", "--outcome-class", "recommendation", "--decisions", "d", "--unresolved-issues", "-", "--actor", "agent:test", ...extra,
];

test("S234: a covered close without the declaration refuses; with it, the minutes carry the form", async (t) => {
  const { workspace, version, conferenceId } = await conferenceFixture(t, "floor-remediation", "verification");
  const missing = await refusal(closeArguments(workspace, await version(), conferenceId));
  assert.equal(missing.reasonCode, "CONFERENCE_INDEPENDENCE_REQUIRED");
  const wrong = await refusal(closeArguments(workspace, await version(), conferenceId, ["--execution-form", "single-context"]));
  assert.equal(wrong.reasonCode, "CONFERENCE_INDEPENDENCE_REQUIRED");
  assert.match(wrong.message, /verification/u);
  const closed = await json(closeArguments(workspace, await version(), conferenceId, ["--execution-form", "independent"]));
  assert.equal(closed.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  const minutes = await json(["conference-minutes-list", "--workspace", workspace, "--limit", "5"]);
  const record = (minutes.records ?? minutes.minutes ?? []).find((entry) => entry.conferenceId === conferenceId);
  assert.deepEqual(record.extensions["conference:execution-form"], { required: false, value: "independent" });
});

test("S234: with the floor at its default, a close without the flag behaves exactly as before", async (t) => {
  const { workspace, version, conferenceId } = await conferenceFixture(t, "nofloor-remediation", null);
  const closed = await json(closeArguments(workspace, await version(), conferenceId));
  assert.equal(closed.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal((await json(["conference-minutes-list", "--workspace", workspace, "--limit", "5"])).records.length > 0, true);
});
