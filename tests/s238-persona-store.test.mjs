// SPDX-License-Identifier: Apache-2.0
// INIT-028 S246: unified persona content and preset overlay behavior.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeWorkspace, derivePersonaId } from "../dist/build/packages/core/src/index.js";

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
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s246-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: `FIXTURE-S246-${suffix}`, createdAt: instant(0) });
  const workspace = join(base, "workspace");
  const version = async () => (await json(["status", "--workspace", workspace])).version;
  return { workspace, version };
}

const write = (command, workspace, version, at, args) => [command, "--workspace", workspace, "--expected-version", String(version), "--at", instant(at), ...args, "--actor", "agent:test"];
const customArgs = (workspace, version, at, name, fields) => write("persona-set", workspace, version, at, ["--name", name, "--role", fields.role, "--job-title", fields.jobTitle, "--mission", fields.mission, "--refusals", fields.refusals, "--authority-boundary", fields.authorityBoundary, "--contact-when", fields.contactWhen, "--required-inputs", fields.requiredInputs, "--deliverables", fields.deliverables, "--success-criteria", fields.successCriteria]);

test("S246: custom persona readback is the unified schema, with stable derived identity", async (t) => {
  const { workspace, version } = await fixture(t, "custom");
  const fields = { role: "reviewer", jobTitle: "Verification reviewer", mission: "Review evidence", refusals: "No publication", authorityBoundary: "Owner decides", contactWhen: "When evidence conflicts", requiredInputs: "Scope and receipts", deliverables: "Review note", successCriteria: "All claims trace" };
  const first = await json(customArgs(workspace, await version(), 1, "审计员", fields));
  assert.equal(first.reasonCode, "PERSONA_WRITE_COMMITTED");
  assert.equal(first.record.id, derivePersonaId("审计员"));
  assert.equal(first.record.revision, 1);
  const readback = await json(["persona-list", "--workspace", workspace]);
  const custom = readback.personas.find((persona) => persona.name === "审计员");
  assert.deepEqual({ role: custom.role, jobTitle: custom.jobTitle, mission: custom.mission, prompt: custom.prompt, description: custom.description }, { role: "reviewer", jobTitle: "Verification reviewer", mission: "Review evidence", prompt: undefined, description: undefined });
  assert.equal(custom.readOnly, false);

  const updated = await json(customArgs(workspace, await version(), 2, "审计员", { ...fields, mission: "Review updated evidence" }));
  assert.equal(updated.record.revision, 2);
  assert.equal((await json(["persona-list", "--workspace", workspace])).personas.find((persona) => persona.name === "审计员").mission, "Review updated evidence");
  assert.equal(readback.personas.filter((persona) => persona.source === "core-reference").length, 8);
});

test("S246: preset override accepts non-name fields, restores factory data, and tombstones safely", async (t) => {
  const { workspace, version } = await fixture(t, "preset");
  const override = await json(write("persona-preset-override", workspace, await version(), 1, ["--name", "Verity", "--fields", JSON.stringify({ role: "gatekeeper", mission: "Owner-facing review" })]));
  assert.equal(override.reasonCode, "PERSONA_WRITE_COMMITTED");
  let verity = (await json(["persona-list", "--workspace", workspace])).personas.find((persona) => persona.name === "Verity");
  assert.equal(verity.role, "gatekeeper");
  assert.equal(verity.mission, "Owner-facing review");
  assert.deepEqual(verity.overriddenFields, ["mission", "role"]);
  assert.equal(verity.factory.mission === verity.mission, false);

  const restoredField = await json(write("persona-preset-restore", workspace, await version(), 2, ["--name", "Verity", "--field", "mission"]));
  assert.equal(restoredField.reasonCode, "PERSONA_WRITE_COMMITTED");
  verity = (await json(["persona-list", "--workspace", workspace])).personas.find((persona) => persona.name === "Verity");
  assert.equal(verity.mission, verity.factory.mission);
  assert.equal(verity.role, "gatekeeper");

  const restored = await json(write("persona-preset-restore", workspace, await version(), 3, ["--name", "Verity"]));
  assert.equal(restored.reasonCode, "PERSONA_WRITE_COMMITTED");
  verity = (await json(["persona-list", "--workspace", workspace])).personas.find((persona) => persona.name === "Verity");
  assert.equal(verity.role, "reviewer");
  assert.equal(verity.overridden, false);

  await json(write("model-plan-set", workspace, await version(), 4, ["--host", "codex", "--name", "review", "--default-model", "m"]));
  await json(write("model-plan-assign", workspace, await version(), 5, ["--host", "codex", "--plan", "review", "--persona", "Verity", "--model", "m2"]));
  const inUse = await refusal(write("persona-remove", workspace, await version(), 6, ["--name", "Verity"]));
  assert.equal(inUse.reasonCode, "PERSONA_PRESET_IN_USE");
  await json(write("model-plan-unassign", workspace, await version(), 7, ["--host", "codex", "--plan", "review", "--persona", "Verity"]));
  const removed = await json(write("persona-remove", workspace, await version(), 8, ["--name", "Verity"]));
  assert.equal(removed.reasonCode, "PERSONA_REMOVE_COMMITTED");
  assert.equal((await json(["persona-list", "--workspace", workspace])).personas.some((persona) => persona.name === "Verity"), false);
  const revived = await json(write("persona-preset-restore", workspace, await version(), 9, ["--name", "Verity"]));
  assert.equal(revived.reasonCode, "PERSONA_WRITE_COMMITTED");
  assert.equal((await json(["persona-list", "--workspace", workspace])).personas.some((persona) => persona.name === "Verity"), true);
});

test("S238: custom persona set/update/list is one event with a stable derived id", async (t) => {
  const { workspace, version } = await fixture(t, "crud-remediation");
  const fields = { role: "reviewer", jobTitle: "Verification reviewer", mission: "Review evidence", refusals: "No publication", authorityBoundary: "Owner decides", contactWhen: "When evidence conflicts", requiredInputs: "Scope and receipts", deliverables: "Review note", successCriteria: "All claims trace" };
  const first = await json(customArgs(workspace, await version(), 1, "审计员", fields));
  assert.equal(first.reasonCode, "PERSONA_WRITE_COMMITTED");
  assert.equal(first.record.id, derivePersonaId("审计员"));
  assert.equal(first.record.revision, 1);
  assert.equal(first.version, 1);
  const second = await json(customArgs(workspace, await version(), 2, "审计员", { ...fields, mission: "Review updated evidence" }));
  assert.equal(second.record.id, first.record.id);
  assert.equal(second.record.revision, 2);
  assert.equal(second.version, 2);
  const readback = await json(["persona-list", "--workspace", workspace]);
  const custom = readback.personas.find((persona) => persona.name === "审计员" && persona.source === "custom");
  assert.equal(custom.mission, "Review updated evidence");
  assert.equal(custom.readOnly, false);
  assert.equal(readback.personas.filter((persona) => persona.source === "core-reference").length, 8);
});

test("S238: role, prompt, binding, and removal violations are named and do not advance the chain", async (t) => {
  const { workspace, version } = await fixture(t, "integrity-remediation");
  const fields = { role: "reviewer", jobTitle: "Reviewer", mission: "Review", refusals: "No publication", authorityBoundary: "Owner decides", contactWhen: "When needed", requiredInputs: "Receipts", deliverables: "Finding", successCriteria: "Traceable" };
  await json(customArgs(workspace, await version(), 1, "审计员", fields));
  const stable = await version();
  const badRole = await refusal(customArgs(workspace, stable, 2, "坏角色", { ...fields, role: "hacker" }));
  assert.equal(badRole.reasonCode, "PERSONA_ROLE_INVALID");
  assert.match(badRole.message, /orchestrator.*planner.*implementer.*reviewer.*gatekeeper.*steward/u);
  assert.equal(await version(), stable);
  const badPrompt = await refusal(["persona-set", "--workspace", workspace, "--expected-version", String(stable), "--at", instant(3), "--name", "legacy-prompt", "--role", "reviewer", "--prompt", "retired", "--actor", "agent:test"]);
  assert.equal(badPrompt.reasonCode, "CLI_ARGUMENT_UNKNOWN");
  assert.equal(await version(), stable);
  await json(write("model-plan-set", workspace, await version(), 4, ["--host", "codex", "--name", "review", "--default-model", "m"]));
  const assigned = await json(write("model-plan-assign", workspace, await version(), 5, ["--host", "codex", "--plan", "review", "--persona", "审计员", "--model", "m2"]));
  assert.equal(assigned.plans.find((plan) => plan.name === "review").assignments["审计员"], "m2");
  const referenced = await refusal(write("persona-remove", workspace, await version(), 6, ["--name", "审计员"]));
  assert.equal(referenced.reasonCode, "EXECUTION_PERSONA_IN_USE");
  assert.match(referenced.message, /model plan/u);
  await json(write("model-plan-unassign", workspace, await version(), 7, ["--host", "codex", "--plan", "review", "--persona", "审计员"]));
  const removed = await json(write("persona-remove", workspace, await version(), 8, ["--name", "审计员"]));
  assert.equal(removed.reasonCode, "PERSONA_REMOVE_COMMITTED");
  assert.equal((await json(["persona-list", "--workspace", workspace])).personas.some((persona) => persona.name === "审计员"), false);
});
