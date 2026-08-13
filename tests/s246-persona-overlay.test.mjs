// SPDX-License-Identifier: Apache-2.0
// INIT-028 INC-145/147: named persona conflict and overlay guard coverage.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeWorkspace } from "../dist/build/packages/core/src/index.js";

const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString().replace(/\.\d+Z$/u, "Z");

async function invoke(args) {
  let output = "";
  try {
    await runCli(args, { write: (value) => { output += value; } });
    return JSON.parse(output);
  } catch (error) {
    return error;
  }
}

async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc145-persona-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: "FIXTURE-INC145-PERSONA", createdAt: at(0) });
  return { workspace: join(base, "workspace"), version: async () => (await invoke(["status", "--workspace", join(base, "workspace")])).version };
}

const write = (command, workspace, version, second, args) => [command, "--workspace", workspace, "--expected-version", String(version), "--at", at(second), ...args, "--actor", "agent:test"];

test("INC-145 PERSONA_NAME_CONFLICT names the custom-versus-preset route", async (t) => {
  const { workspace, version } = await fixture(t);
  const custom = await invoke(write("persona-set", workspace, await version(), 1, [
    "--name", "Audit", "--role", "reviewer", "--job-title", "Review", "--mission", "Evidence",
  ]));
  assert.equal(custom.reasonCode, "PERSONA_WRITE_COMMITTED");
  const conflict = await invoke(write("persona-preset-override", workspace, await version(), 2, [
    "--name", "Audit", "--fields", JSON.stringify({ mission: "wrong route" }),
  ]));
  assert.equal(conflict.reasonCode, "PERSONA_NAME_CONFLICT");
  assert.match(conflict.message, /persona-set/u);
});

test("INC-152 PERSONA_NAME_CONFLICT rejects active and tombstoned preset names", async (t) => {
  const { workspace, version } = await fixture(t);
  const active = await invoke(write("persona-set", workspace, await version(), 1, [
    "--name", "Verity", "--role", "reviewer", "--job-title", "Wrong route", "--mission", "Evidence",
  ]));
  assert.equal(active.reasonCode, "PERSONA_NAME_CONFLICT");
  assert.match(active.message, /reserved by a preset persona/u);

  const removed = await invoke(write("persona-remove", workspace, await version(), 2, ["--name", "Verity"]));
  assert.equal(removed.reasonCode, "PERSONA_REMOVE_COMMITTED");
  const tombstoned = await invoke(write("persona-set", workspace, await version(), 3, [
    "--name", "Verity", "--role", "reviewer", "--job-title", "Wrong route", "--mission", "Evidence",
  ]));
  assert.equal(tombstoned.reasonCode, "PERSONA_NAME_CONFLICT");
  assert.match(tombstoned.message, /tombstoned preset persona/u);
});

test("INC-145 PERSONA_PRESET_IN_USE explains how to release a named assignment", async (t) => {
  const { workspace, version } = await fixture(t);
  await invoke(write("model-plan-set", workspace, await version(), 1, ["--host", "codex", "--name", "review", "--default-model", "model-a"]));
  await invoke(write("model-plan-assign", workspace, await version(), 2, ["--host", "codex", "--plan", "review", "--persona", "Verity", "--model", "model-b"]));
  const refused = await invoke(write("persona-remove", workspace, await version(), 3, ["--name", "Verity"]));
  assert.equal(refused.reasonCode, "PERSONA_PRESET_IN_USE");
  assert.match(refused.message, /model plan codex\/review/u);
  assert.match(refused.message, /remove that assignment first/u);
});
