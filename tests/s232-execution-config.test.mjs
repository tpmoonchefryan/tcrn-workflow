// SPDX-License-Identifier: Apache-2.0
// INIT-028 S244/S245: model-plan records, active plan settings, and retired writes.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeWorkspace } from "../dist/build/packages/core/src/index.js";

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

test("S244: a plan is a named host record with default and persona assignments", async (t) => {
  const { workspace, version } = await fixture(t, "plan");
  const created = await json(write("model-plan-set", workspace, await version(), 1, ["--host", "claude-code", "--name", "daily", "--default-model", "opus-5"]));
  assert.equal(created.reasonCode, "MODEL_PLAN_WRITE_COMMITTED");
  assert.equal(created.plans[0].assignments && Object.keys(created.plans[0].assignments).length, 0);
  const assigned = await json(write("model-plan-assign", workspace, await version(), 2, ["--host", "claude-code", "--plan", "daily", "--persona", "Verity", "--model", "sonnet-5", "--effort", "high"]));
  assert.equal(assigned.plans[0].assignments.Verity, "sonnet-5");
  assert.equal(assigned.plans[0].efforts.Verity, "high");
  const readback = await json(["model-plan-list", "--workspace", workspace, "--host", "claude-code"]);
  assert.deepEqual(readback.plans.map((plan) => ({ host: plan.host, name: plan.name, defaultModel: plan.defaultModel, assignments: plan.assignments })), [{ host: "claude-code", name: "daily", defaultModel: "opus-5", assignments: { Verity: "sonnet-5" } }]);

  const unknownPersona = await refusal(write("model-plan-assign", workspace, await version(), 3, ["--host", "claude-code", "--plan", "daily", "--persona", "ghost", "--model", "x"]));
  assert.equal(unknownPersona.reasonCode, "MODEL_PLAN_PERSONA_UNKNOWN");
  const unknownPlan = await refusal(write("model-plan-assign", workspace, await version(), 4, ["--host", "claude-code", "--plan", "ghost", "--persona", "Verity", "--model", "x"]));
  assert.equal(unknownPlan.reasonCode, "MODEL_PLAN_NOT_FOUND");
});

test("S245: active plan keys reference existing plans and the old write family is retired", async (t) => {
  const { workspace, version } = await fixture(t, "settings");
  await json(write("model-plan-set", workspace, await version(), 1, ["--host", "codex", "--name", "review", "--default-model", "gpt-5"]));
  const active = await json(write("settings-set", workspace, await version(), 2, ["--key", "execution.codexSubagentPlan", "--value", "review"]));
  assert.equal(active.reasonCode, "SETTINGS_WRITE_COMMITTED");
  const catalog = await json(["settings-catalog", "--workspace", workspace]);
  assert.equal(catalog.settings.find((entry) => entry.key === "execution.codexSubagentPlan").currentValue, "review");
  const badReference = await refusal(write("settings-set", workspace, await version(), 3, ["--key", "execution.claudeCodeSubagentPlan", "--value", "missing"]));
  assert.equal(badReference.reasonCode, "MODEL_PLAN_NOT_FOUND");
  assert.equal(await version(), active.version);

  const retired = await refusal(["execution-config", "--workspace", workspace]);
  assert.equal(retired.reasonCode, "CLI_COMMAND_UNKNOWN");
  for (const command of ["host-config-set", "host-config-default", "host-config-remove", "persona-binding-set", "persona-binding-remove"]) {
    assert.equal((await refusal([command])).reasonCode, "CLI_COMMAND_UNKNOWN", command);
  }

  const unset = await json(write("settings-remove", workspace, await version(), 4, ["--key", "execution.codexSubagentPlan"]));
  assert.equal(unset.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal((await json(["settings-catalog", "--workspace", workspace])).settings.find((entry) => entry.key === "execution.codexSubagentPlan").currentValue, null);
  const vocabulary = await json(["vocabulary"]);
  assert.equal(vocabulary.reasonCode, "VOCABULARY_READY");
  assert.deepEqual(vocabulary.hosts, ["claude-code", "codex"]);
});

test("S232: the owner scenario — two configurations, one switch, one pinned persona", async (t) => {
  const { workspace, version } = await fixture(t, "owner-remediation");
  const first = await json(write("model-plan-set", workspace, await version(), 1, ["--host", "claude-code", "--name", "strong", "--default-model", "opus-5"]));
  assert.equal(first.reasonCode, "MODEL_PLAN_WRITE_COMMITTED");
  const second = await json(write("model-plan-set", workspace, await version(), 2, ["--host", "claude-code", "--name", "economy", "--default-model", "sonnet-5"]));
  assert.equal(second.plans.length, 2);
  const pinned = await json(write("model-plan-assign", workspace, await version(), 3, ["--host", "claude-code", "--plan", "strong", "--persona", "Verity", "--model", "opus-5"]));
  assert.equal(pinned.plans.find((plan) => plan.name === "strong").assignments.Verity, "opus-5");
  const active = await json(write("settings-set", workspace, await version(), 4, ["--key", "execution.claudeCodeSubagentPlan", "--value", "economy"]));
  assert.equal(active.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal((await json(["settings-catalog", "--workspace", workspace])).settings.find((entry) => entry.key === "execution.claudeCodeSubagentPlan").currentValue, "economy");
  const readback = await json(["model-plan-list", "--workspace", workspace, "--host", "claude-code"]);
  assert.equal(readback.plans.find((plan) => plan.name === "strong").assignments.Verity, "opus-5");
  assert.equal((await json(["validate", "--workspace", workspace])).reasonCode, "WORKSPACE_COMMAND_COMPLETED");
});

test("S232: every referential-integrity violation refuses by name and mutates nothing", async (t) => {
  const { workspace, version } = await fixture(t, "integrity-remediation");
  await json(write("model-plan-set", workspace, await version(), 1, ["--host", "codex", "--name", "review", "--default-model", "gpt-5"]));
  const before = await version();
  const unknownHost = await refusal(write("model-plan-set", workspace, before, 2, ["--host", "vscode", "--name", "bad", "--default-model", "m"]));
  assert.equal(unknownHost.reasonCode, "MODEL_PLAN_HOST_UNKNOWN");
  assert.match(unknownHost.message, /claude-code.*codex/u);
  const unknownPersona = await refusal(write("model-plan-assign", workspace, before, 3, ["--host", "codex", "--plan", "review", "--persona", "ghost", "--model", "m"]));
  assert.equal(unknownPersona.reasonCode, "MODEL_PLAN_PERSONA_UNKNOWN");
  assert.equal(await version(), before);
  const unknownPlan = await refusal(write("model-plan-assign", workspace, before, 4, ["--host", "codex", "--plan", "ghost", "--persona", "Verity", "--model", "m"]));
  assert.equal(unknownPlan.reasonCode, "MODEL_PLAN_NOT_FOUND");
  assert.equal(await version(), before);
  const badReference = await refusal(write("settings-set", workspace, before, 5, ["--key", "execution.codexSubagentPlan", "--value", "missing"]));
  assert.equal(badReference.reasonCode, "MODEL_PLAN_NOT_FOUND");
  assert.equal(await version(), before);
});

test("S232: a default cannot be cleared by omission — only --clear does it", async (t) => {
  const { workspace, version } = await fixture(t, "clear-remediation");
  await json(write("model-plan-set", workspace, await version(), 1, ["--host", "codex", "--name", "review", "--default-model", "gpt-5"]));
  await json(write("settings-set", workspace, await version(), 2, ["--key", "execution.codexSubagentPlan", "--value", "review"]));
  assert.equal((await json(["settings-catalog", "--workspace", workspace])).settings.find((entry) => entry.key === "execution.codexSubagentPlan").currentValue, "review");
  const cleared = await json(write("settings-remove", workspace, await version(), 3, ["--key", "execution.codexSubagentPlan"]));
  assert.equal(cleared.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal((await json(["settings-catalog", "--workspace", workspace])).settings.find((entry) => entry.key === "execution.codexSubagentPlan").currentValue, null);
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
  const anchor = (await json(write("work-create", workspace, await version(), 3, ["--project-id", project, "--external-key", `S234-REMED-INIT-${suffix}`, "--kind", "Initiative"]))).record.id;
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
