// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  FRAMEWORK_VERSION,
  initializeWorkspace,
} from "../dist/build/packages/core/src/index.js";

const instant = (second) => `2026-08-11T00:00:${String(second).padStart(2, "0")}Z`;

async function fixture(context, suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s222-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({
    roots,
    externalKey: `FIXTURE-S222-${suffix}`,
    createdAt: instant(0),
    segmentEventLimit: 64,
  });
  return { workspace };
}

async function runRaw(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function runError(args) {
  try {
    await runCli(args, { write() {} });
  } catch (error) {
    return error;
  }
  assert.fail(`expected ${args[0]} to refuse`);
}

async function declare(workspace, value) {
  return runRaw([
    "settings-set",
    "--workspace", workspace,
    "--expected-version", "0",
    "--at", instant(1),
    "--key", "engine.requiredVersion",
    "--value", value,
    "--actor", "agent:codex",
  ]);
}

// Derived from the running version rather than written as a literal: a literal
// "newer" version stops being newer the moment the framework reaches it, which
// turned this assertion red during the 0.11.10 release train.
const NEWER_THAN_FRAMEWORK = (() => {
  const [major, ...rest] = FRAMEWORK_VERSION.split(".");
  return [Number(major) + 1, ...rest].join(".");
})();

const literal = (value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");

test("S222: a workspace requiring a newer engine refuses with both versions", async (t) => {
  const { workspace } = await fixture(t, "mismatch");
  const receipt = await declare(workspace, NEWER_THAN_FRAMEWORK);
  assert.equal(receipt.reasonCode, "SETTINGS_WRITE_COMMITTED");

  const error = await runError(["status", "--workspace", workspace]);
  assert.equal(error.reasonCode, "WORKSPACE_ENGINE_VERSION_MISMATCH");
  assert.deepEqual(error.details, { required: NEWER_THAN_FRAMEWORK, actual: FRAMEWORK_VERSION });
  assert.match(error.message, literal(NEWER_THAN_FRAMEWORK));
  assert.match(error.message, literal(FRAMEWORK_VERSION));
});

test("S222: a satisfied declaration opens normally", async (t) => {
  const { workspace } = await fixture(t, "satisfied");
  await declare(workspace, FRAMEWORK_VERSION);
  const status = await runRaw(["status", "--workspace", workspace]);
  assert.equal(status.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(status.version, 1);
});

test("S222: a legacy workspace with no declaration remains exempt", async (t) => {
  const { workspace } = await fixture(t, "legacy");
  const status = await runRaw(["status", "--workspace", workspace]);
  assert.equal(status.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(status.version, 0);
});

test("S222: the declaration is a stable semantic version, not an arbitrary string", async (t) => {
  const { workspace } = await fixture(t, "invalid");
  const error = await runError([
    "settings-set",
    "--workspace", workspace,
    "--expected-version", "0",
    "--at", instant(1),
    "--key", "engine.requiredVersion",
    "--value", "next-release",
    "--actor", "agent:codex",
  ]);
  assert.equal(error.reasonCode, "SETTINGS_VALUE_INVALID");
  const status = await runRaw(["status", "--workspace", workspace]);
  assert.equal(status.version, 0);
});
