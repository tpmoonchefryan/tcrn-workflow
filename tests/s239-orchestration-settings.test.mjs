// SPDX-License-Identifier: Apache-2.0
// INIT-027 S239: the three orchestration settings are closed and semantic.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeWorkspace } from "../dist/build/packages/core/src/index.js";

const instant = (second) => new Date(Date.UTC(2026, 0, 2) + second * 1000).toISOString().replace(/\.\d+Z$/u, "Z");

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

async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s239-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: "FIXTURE-S239-SETTINGS", createdAt: instant(0) });
  const workspace = join(base, "workspace");
  const version = async () => (await json(["status", "--workspace", workspace])).version;
  return { workspace, version };
}

test("S239: defaults, closed enum, and bounded numeric strings are catalog-backed", async (t) => {
  const { workspace, version } = await fixture(t);
  const catalog = await json(["settings-catalog", "--workspace", workspace]);
  const entries = new Map(catalog.settings.map((entry) => [entry.key, entry]));
  assert.deepEqual(entries.get("execution.maxConcurrentSubagents"), {
    key: "execution.maxConcurrentSubagents", type: "string", layer: "workspace_configuration", defaultValue: "8", currentValue: "8",
  });
  assert.deepEqual(entries.get("execution.maxDispatchDepth"), {
    key: "execution.maxDispatchDepth", type: "string", layer: "workspace_configuration", defaultValue: "1", currentValue: "1",
  });
  assert.deepEqual(entries.get("execution.personalessDispatch"), {
    key: "execution.personalessDispatch", type: "enum", layer: "workspace_configuration", defaultValue: "allowed", currentValue: "allowed", allowedValues: ["allowed", "forbidden"],
  });

  const first = await json(["settings-set", "--workspace", workspace, "--expected-version", String(await version()), "--at", instant(1),
    "--key", "execution.maxConcurrentSubagents", "--value", "32", "--actor", "agent:test"]);
  assert.equal(first.setting.value, "32");
  const second = await json(["settings-set", "--workspace", workspace, "--expected-version", String(await version()), "--at", instant(2),
    "--key", "execution.maxDispatchDepth", "--value", "4", "--actor", "agent:test"]);
  assert.equal(second.setting.value, "4");
  const third = await json(["settings-set", "--workspace", workspace, "--expected-version", String(await version()), "--at", instant(3),
    "--key", "execution.personalessDispatch", "--value", "forbidden", "--actor", "agent:test"]);
  assert.equal(third.setting.value, "forbidden");
  assert.equal((await json(["settings-catalog", "--workspace", workspace])).settings.find((entry) => entry.key === "execution.personalessDispatch").currentValue, "forbidden");
});

test("S239: semantic refusals identify the setting and leave the head unchanged", async (t) => {
  const { workspace, version } = await fixture(t);
  const cases = [
    ["execution.maxConcurrentSubagents", "0", /1 to 32/u],
    ["execution.maxConcurrentSubagents", "33", /1 to 32/u],
    ["execution.maxConcurrentSubagents", "1.0", /1 to 32/u],
    ["execution.maxDispatchDepth", "0", /1 to 4/u],
    ["execution.maxDispatchDepth", "5", /1 to 4/u],
    ["execution.personalessDispatch", "review-only", /allowed, forbidden/u],
  ];
  for (const [key, value, message] of cases) {
    const stable = await version();
    const error = await refusal(["settings-set", "--workspace", workspace, "--expected-version", String(stable), "--at", instant(10),
      "--key", key, "--value", value, "--actor", "agent:test"]);
    assert.equal(error.reasonCode, "SETTINGS_VALUE_INVALID", `${key}=${value}`);
    assert.match(error.message, message);
    assert.equal(await version(), stable);
  }
});
