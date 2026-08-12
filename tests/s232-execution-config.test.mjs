// SPDX-License-Identifier: Apache-2.0
//
// INIT-026 S232/S233/S234.
//
// The execution-configuration surface records the model NAME a user chose —
// a composite judgement of cost, intelligence and feel that no tier vocabulary
// can express — and the engine's half of the bargain is referential integrity,
// never interpretation. These cases prove three properties end to end over the
// real CLI: the owner scenario works and every action is its own event; every
// integrity violation refuses by name while the state stays untouched; and the
// independence floor gives conference-close teeth exactly where it is set.

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
  try {
    await runCli(args, { write() {} });
  } catch (error) {
    return error;
  }
  return assert.fail(`expected ${args[0]} to refuse`);
}

async function fixture(context, suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s232-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: `FIXTURE-S232-${suffix}`, createdAt: instant(0) });
  const workspace = join(base, "workspace");
  const version = async () => (await json(["status", "--workspace", workspace])).version;
  return { workspace, version };
}

test("S232: the owner scenario — two configurations, one switch, one pinned persona", async (t) => {
  const { workspace, version } = await fixture(t, "owner");

  const created = await json(["host-config-set", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(1), "--host", "claude-code", "--name", "默认", "--model", "claude-opus-5", "--actor", "agent:test"]);
  assert.equal(created.reasonCode, "EXECUTION_CONFIG_COMMITTED");

  await json(["host-config-set", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(2), "--host", "claude-code", "--name", "回滚45", "--model", "claude-opus-4-8",
    "--note", "成本、智能与体感的综合选择", "--actor", "agent:test"]);

  // The global rollback is ONE switch, and it is its own event on the chain —
  // an auditor reads "the default moved", never a diff of a rewritten blob.
  const before = await version();
  const switched = await json(["host-config-default", "--workspace", workspace, "--expected-version", String(before),
    "--at", instant(3), "--host", "claude-code", "--name", "回滚45", "--actor", "agent:test"]);
  assert.equal(switched.version, before + 1, "a default switch is exactly one event");
  assert.deepEqual(switched.defaults, [{ configurationName: "回滚45", host: "claude-code", updatedAt: instant(3) }]);

  // The reviewer persona pins the strong model and does not follow the rollback.
  const pinned = await json(["persona-binding-set", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(4), "--profile-id", "profile:tcrn-verity-v1", "--host", "claude-code", "--name", "默认", "--actor", "agent:test"]);
  assert.equal(pinned.bindings.length, 1);
  assert.equal(pinned.bindings[0].configurationName, "默认");

  const readback = await json(["execution-config", "--workspace", workspace, "--host", "claude-code"]);
  assert.equal(readback.reasonCode, "EXECUTION_CONFIG_READY");
  assert.deepEqual(readback.configurations.map((entry) => entry.model).sort(), ["claude-opus-4-8", "claude-opus-5"]);

  // Replay proves the events rebuild the same surface: a fresh status readback
  // materializes from disk, and validate agrees the chain is whole.
  const validated = await json(["validate", "--workspace", workspace]);
  assert.equal(validated.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
});

test("S232: every referential-integrity violation refuses by name and mutates nothing", async (t) => {
  const { workspace, version } = await fixture(t, "integrity");
  await json(["host-config-set", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(1), "--host", "claude-code", "--name", "a", "--model", "m1", "--actor", "agent:test"]);
  await json(["host-config-default", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(2), "--host", "claude-code", "--name", "a", "--actor", "agent:test"]);

  const cases = [
    [["host-config-remove", "--host", "claude-code", "--name", "a"], "EXECUTION_CONFIGURATION_IN_USE"],
    [["host-config-remove", "--host", "claude-code", "--name", "ghost"], "EXECUTION_CONFIGURATION_UNKNOWN"],
    [["host-config-default", "--host", "claude-code", "--name", "ghost"], "EXECUTION_CONFIGURATION_UNKNOWN"],
    [["persona-binding-set", "--profile-id", "profile:tcrn-mara-v1", "--host", "claude-code", "--name", "ghost"], "EXECUTION_CONFIGURATION_UNKNOWN"],
    [["persona-binding-remove", "--profile-id", "profile:tcrn-mara-v1", "--host", "claude-code"], "EXECUTION_BINDING_UNKNOWN"],
    [["host-config-set", "--host", "vscode", "--name", "x", "--model", "y"], "EXECUTION_HOST_UNKNOWN"],
  ];
  for (const [args, expected] of cases) {
    const stable = await version();
    const error = await refusal([args[0], "--workspace", workspace, "--expected-version", String(stable),
      "--at", instant(60), ...args.slice(1), "--actor", "agent:test"]);
    assert.equal(error.reasonCode, expected, args.join(" "));
    assert.equal(await version(), stable, `${args[0]} must not advance the chain on refusal`);
  }
});

test("S232: a default cannot be cleared by omission — only --clear does it", async (t) => {
  const { workspace, version } = await fixture(t, "clear");
  await json(["host-config-set", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(1), "--host", "codex", "--name", "n", "--model", "m", "--actor", "agent:test"]);
  await json(["host-config-default", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(2), "--host", "codex", "--name", "n", "--actor", "agent:test"]);

  const error = await refusal(["host-config-default", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(3), "--host", "codex", "--actor", "agent:test"]);
  assert.equal(error.reasonCode, "CLI_ARGUMENT_MISSING");

  const cleared = await json(["host-config-default", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(4), "--host", "codex", "--clear", "true", "--actor", "agent:test"]);
  assert.equal(cleared.defaults.find((entry) => entry.host === "codex").configurationName, null);
});

test("S233: the two policy keys are in the catalog with their closed value sets", async (t) => {
  const { workspace, version } = await fixture(t, "keys");
  const catalog = await json(["settings-catalog", "--workspace", workspace]);
  const policy = catalog.settings.find((entry) => entry.key === "execution.subagentPolicy");
  assert.deepEqual(policy.allowedValues, ["allowed", "review-only", "forbidden"]);
  // An unset key reads back at its default — the catalog answers "what is in
  // force", not "what was written".
  assert.equal(policy.currentValue, "allowed");
  assert.equal(policy.defaultValue, "allowed");
  const floor = catalog.settings.find((entry) => entry.key === "execution.independenceFloor");
  assert.deepEqual(floor.allowedValues, ["none", "verification", "verification-and-risk", "all"]);
  assert.equal(floor.defaultValue, "none");

  const error = await refusal(["settings-set", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(1), "--key", "execution.subagentPolicy", "--value", "yolo", "--actor", "agent:test"]);
  assert.equal(error.reasonCode, "SETTINGS_VALUE_INVALID");
  assert.match(error.message, /allowed, review-only, forbidden/u);
});

async function conferenceFixture(context, suffix, floor) {
  const { workspace, version } = await fixture(context, suffix);
  if (floor !== null) {
    await json(["settings-set", "--workspace", workspace, "--expected-version", String(await version()),
      "--at", instant(1), "--key", "execution.independenceFloor", "--value", floor, "--actor", "agent:test"]);
  }
  const project = (await json(["project-create", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(2), "--external-key", "S234-PROJ-001", "--name", "s234", "--actor", "agent:test"])).record.id;
  const anchor = (await json(["work-create", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(2), "--project-id", project, "--external-key", "S234-INIT-001", "--kind", "Initiative", "--actor", "agent:test"])).record.id;
  const conference = await json(["conference-open", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(3), "--external-key", `S234-CONF-${suffix}`, "--project-id", project, "--type", "verification",
    "--title", "acceptance", "--work-ids", anchor, "--desired-outcome", "recommendation",
    "--participant-ids", "agent:test", "--actor", "agent:test"]);
  return { workspace, version, conferenceId: conference.recordId ?? conference.record?.id };
}

const closeArguments = (workspace, versionValue, conferenceId, extra) => ([
  "conference-close", "--workspace", workspace, "--expected-version", String(versionValue), "--at", instant(9),
  "--conference-id", conferenceId, "--minutes-external-key", "S234-MIN-001", "--summary", "s",
  "--outcome-class", "recommendation", "--decisions", "d", "--unresolved-issues", "-", "--actor", "agent:test", ...extra,
]);

test("S234: a covered close without the declaration refuses; with it, the minutes carry the form", async (t) => {
  const { workspace, version, conferenceId } = await conferenceFixture(t, "floor", "verification");

  const missing = await refusal(closeArguments(workspace, await version(), conferenceId, []));
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
  const { workspace, version, conferenceId } = await conferenceFixture(t, "nofloor", null);
  const closed = await json(closeArguments(workspace, await version(), conferenceId, []));
  assert.equal(closed.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
});
