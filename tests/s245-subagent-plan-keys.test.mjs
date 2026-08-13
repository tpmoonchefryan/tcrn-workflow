// SPDX-License-Identifier: Apache-2.0
// INIT-028 INC-145/147: active subagent-plan keys and retirement boundary.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc145-keys-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: "FIXTURE-INC145-KEYS", createdAt: at(0) });
  return join(base, "workspace");
}

test("INC-145 active plan keys are cataloged, sorted, and vocabulary-linked", async (t) => {
  const workspace = await fixture(t);
  const source = await readFile(new URL("../packages/core/src/settings.ts", import.meta.url), "utf8");
  const keyType = source.match(/export type SettingKey =([\s\S]*?);/u)?.[1] ?? "";
  const catalogSource = source.match(/const catalogEntries:[\s\S]*?= \[([\s\S]*?)\];\n\nexport const SETTINGS_CATALOG/u)?.[1] ?? "";
  const sourceTypeKeys = [...keyType.matchAll(/\|\s*"([^"]+)"/gu)].map((match) => match[1]);
  const sourceCatalogKeys = [...catalogSource.matchAll(/\bkey:\s*"([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(sourceTypeKeys, [...sourceTypeKeys].sort(), "SettingKey union must be independently sorted in source");
  assert.deepEqual(sourceCatalogKeys, [...sourceCatalogKeys].sort(), "catalogEntries must be independently sorted in source");
  assert.deepEqual(sourceTypeKeys, sourceCatalogKeys, "SettingKey and catalogEntries must use the same source order");
  const catalog = await invoke(["settings-catalog", "--workspace", workspace]);
  assert.deepEqual(catalog.settings.map((entry) => entry.key), [...catalog.settings.map((entry) => entry.key)].sort());
  for (const [key, host] of [["execution.claudeCodeSubagentPlan", "claude-code"], ["execution.codexSubagentPlan", "codex"]]) {
    const entry = catalog.settings.find((candidate) => candidate.key === key);
    assert.equal(entry.type, "string");
    assert.equal(entry.controlType, "enum");
    assert.equal(entry.defaultValue, null);
    const vocabulary = await invoke(["vocabulary"]);
    const term = vocabulary.settingsEnums.find((candidate) => candidate.key === key);
    assert.equal(term.valueSource, `model-plan-list:${host}`);
    assert.equal(term.type, entry.type);
    assert.equal(term.defaultValue, entry.defaultValue);
  }
});

test("INC-145 model-plan-list rejects an unknown host and legacy writes are explicit", async (t) => {
  const workspace = await fixture(t);
  const unknownHost = await invoke(["model-plan-list", "--workspace", workspace, "--host", "gemini"]);
  assert.equal(unknownHost.reasonCode, "MODEL_PLAN_HOST_UNKNOWN");
  assert.match(unknownHost.message, /claude-code.*codex/u);
  const legacy = await invoke(["execution-config", "--workspace", workspace]);
  assert.equal(legacy.reasonCode, "CLI_COMMAND_UNKNOWN");
  assert.match(legacy.message, /settings-catalog.*persona-list.*model-plan-list.*vocabulary/u);
});
