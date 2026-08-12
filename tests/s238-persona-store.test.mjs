// SPDX-License-Identifier: Apache-2.0
// INIT-027 S238: governed custom persona content and binding integrity.

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
  try {
    await runCli(args, { write() {} });
  } catch (error) {
    return error;
  }
  assert.fail(`expected ${args[0]} to refuse`);
}

async function fixture(context, suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s238-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: `FIXTURE-S238-${suffix}`, createdAt: instant(0) });
  const workspace = join(base, "workspace");
  const version = async () => (await json(["status", "--workspace", workspace])).version;
  return { workspace, version };
}

const setArgs = (workspace, version, at, name = "审计员", prompt = "你是审计员") => [
  "persona-set", "--workspace", workspace, "--expected-version", String(version), "--at", instant(at),
  "--name", name, "--description", "对抗复核细节控", "--role", "reviewer", "--prompt", prompt, "--actor", "agent:test",
];

test("S238: custom persona set/update/list is one event with a stable derived id", async (t) => {
  const { workspace, version } = await fixture(t, "crud");
  const first = await json(setArgs(workspace, await version(), 1));
  assert.equal(first.reasonCode, "PERSONA_WRITE_COMMITTED");
  assert.equal(first.record.revision, 1);
  assert.equal(first.record.id, derivePersonaId("审计员"));
  assert.equal(first.version, 1);

  const second = await json(setArgs(workspace, await version(), 2, "审计员", "更新后的审计提示"));
  assert.equal(second.record.id, first.record.id);
  assert.equal(second.record.revision, 2);
  assert.equal(second.version, 2);

  const readback = await json(["persona-list", "--workspace", workspace]);
  assert.equal(readback.reasonCode, "PERSONA_LIST_READY");
  const custom = readback.personas.find((persona) => persona.name === "审计员" && persona.source === "custom");
  assert.deepEqual({ readOnly: custom.readOnly, role: custom.role, prompt: custom.prompt }, { readOnly: false, role: "reviewer", prompt: "更新后的审计提示" });
  assert.equal(readback.personas.filter((persona) => persona.source === "core-reference").length, 8);
});

test("S238: role, prompt, binding, and removal violations are named and do not advance the chain", async (t) => {
  const { workspace, version } = await fixture(t, "integrity");
  await json(setArgs(workspace, await version(), 1));
  const stable = await version();

  const badRoleArgs = setArgs(workspace, stable, 2, "坏角色");
  badRoleArgs[12] = "hacker";
  const badRole = await refusal(badRoleArgs);
  assert.equal(badRole.reasonCode, "PERSONA_ROLE_INVALID");
  assert.match(badRole.message, /orchestrator.*planner.*implementer.*reviewer.*gatekeeper.*steward/u);
  assert.equal(await version(), stable);

  const badPrompt = await refusal(setArgs(workspace, stable, 3, "超限", "x".repeat(4097)));
  assert.equal(badPrompt.reasonCode, "PERSONA_PROMPT_INVALID");
  assert.equal(await version(), stable);

  await json(["host-config-set", "--workspace", workspace, "--expected-version", String(await version()), "--at", instant(4),
    "--host", "codex", "--name", "review", "--model", "m", "--actor", "agent:test"]);
  const custom = (await json(["persona-list", "--workspace", workspace])).personas.find((persona) => persona.source === "custom");
  const bound = await json(["persona-binding-set", "--workspace", workspace, "--expected-version", String(await version()), "--at", instant(6),
    "--profile-id", custom.id, "--host", "codex", "--name", "review", "--actor", "agent:test"]);
  assert.equal(bound.bindings.length, 1);
  const referenced = await refusal(["persona-remove", "--workspace", workspace, "--expected-version", String(await version()), "--at", instant(7),
    "--name", custom.name, "--actor", "agent:test"]);
  assert.equal(referenced.reasonCode, "EXECUTION_PERSONA_IN_USE");
  assert.match(referenced.message, new RegExp(custom.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  await json(["persona-binding-remove", "--workspace", workspace, "--expected-version", String(await version()), "--at", instant(8),
    "--profile-id", custom.id, "--host", "codex", "--actor", "agent:test"]);
  const removed = await json(["persona-remove", "--workspace", workspace, "--expected-version", String(await version()), "--at", instant(9),
    "--name", custom.name, "--actor", "agent:test"]);
  assert.equal(removed.reasonCode, "PERSONA_REMOVE_COMMITTED");
  assert.equal((await json(["persona-list", "--workspace", workspace])).personas.some((persona) => persona.source === "custom"), false);

  const unknown = await refusal(["persona-binding-set", "--workspace", workspace, "--expected-version", String(await version()), "--at", instant(10),
    "--profile-id", "profile:custom-000000000000000000000000-v1", "--host", "codex", "--name", "review", "--actor", "agent:test"]);
  assert.equal(unknown.reasonCode, "EXECUTION_PERSONA_UNKNOWN");
  const builtin = await json(["persona-binding-set", "--workspace", workspace, "--expected-version", String(await version()), "--at", instant(11),
    "--profile-id", "profile:tcrn-verity-v1", "--host", "codex", "--name", "review", "--actor", "agent:test"]);
  assert.equal(builtin.bindings[0].profileId, "profile:tcrn-verity-v1");
});
