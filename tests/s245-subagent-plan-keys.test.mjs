// SPDX-License-Identifier: Apache-2.0
// INIT-028 INC-145/147: dispatch settings metadata and retirement boundary.

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

const write = (command, workspace, version, second, args) => [command, "--workspace", workspace, "--expected-version", String(version), "--at", at(second), ...args, "--actor", "agent:test"];

test("S369: dispatch settings are cataloged, sorted, and vocabulary-linked", async (t) => {
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
  for (const key of ["execution.dispatchClasses", "execution.dispatchMode", "execution.dispatchModes", "execution.dispatchTiers"]) {
    const entry = catalog.settings.find((candidate) => candidate.key === key);
    assert.equal(entry.type, "string");
    assert.equal(entry.defaultValue.length > 0, true);
  }
  const classes = await invoke(["dispatch-classes-list", "--workspace", workspace]);
  assert.deepEqual(Object.keys(classes.classes).sort(), ["chain-ops", "dispatch-review", "docs", "implement", "knowledge-expand", "plan", "research", "retrieval-gate"]);
  assert.ok(Object.values(classes.classes).every((value) => typeof value.dispatch === "boolean" && typeof value.verify === "boolean"));
  const modes = await invoke(["dispatch-mode-list", "--workspace", workspace]);
  assert.deepEqual(Object.keys(modes.modes).sort(), ["eco", "frontier"]);
  const expectedClasses = Object.keys(classes.classes).sort();
  for (const mapping of Object.values(modes.modes)) assert.deepEqual(Object.keys(mapping).sort(), expectedClasses);

  const vocabulary = await invoke(["vocabulary"]);
  assert.equal(vocabulary.hostValueKind, "string");
  assert.equal(vocabulary.effortValueKind, "string");
  assert.deepEqual(vocabulary.hosts, ["claude-code", "codex"]);
  assert.equal(vocabulary.settingsEnums.find((term) => term.key === "execution.dispatchMode").valueSource, "dispatch-mode-list");
  assert.equal(vocabulary.settingsEnums.find((term) => term.key === "execution.claudeCodeSubagentPlan").valueSource, "legacy-model-plan-history");
  assert.equal(vocabulary.settingsEnums.find((term) => term.key === "execution.codexSubagentPlan").valueSource, "legacy-model-plan-history");
});

test("S369: custom classes and modes merge, while unknown hosts stay absent from renderer hints", async (t) => {
  const workspace = await fixture(t);
  const tiers = await invoke(write("dispatch-tiers-set", workspace, 0, 1, ["--host", "gemini", "--tiers", JSON.stringify({ flagship: null, main: { model: "gemini-main", effort: "xhigh2" }, economy: null })]));
  assert.equal(tiers.reasonCode, "DISPATCH_CONFIG_WRITE_COMMITTED");
  const classes = await invoke(write("dispatch-classes-set", workspace, 1, 2, ["--classes", JSON.stringify({ "review-visual": { dispatch: false, verify: true } })]));
  const mode = await invoke(write("dispatch-mode-set", workspace, 2, 3, ["--name", "visual", "--mapping", JSON.stringify({ "review-visual": "main" })]));
  assert.equal(classes.version, 2);
  assert.equal(mode.version, 3);
  const resolved = await invoke(["dispatch-mode-list", "--workspace", workspace, "--host", "gemini", "--class", "review-visual", "--mode", "visual"]);
  assert.deepEqual(resolved.resolution.value, { model: "gemini-main", effort: "xhigh2" });
  const vocabulary = await invoke(["vocabulary"]);
  assert.equal(vocabulary.hosts.includes("gemini"), false);
  assert.equal(Object.hasOwn(vocabulary, "efforts"), false);

  const bypass = await invoke(write("settings-set", workspace, 3, 4, ["--key", "execution.dispatchClasses", "--value", JSON.stringify({ "bad-class": { dispatch: true } })]));
  assert.equal(bypass.reasonCode, "DISPATCH_CLASS_BEHAVIOUR_REQUIRED");
  assert.equal((await invoke(["status", "--workspace", workspace])).version, 3);
  const retired = await invoke(["model-plan-list", "--workspace", workspace]);
  assert.equal(retired.reasonCode, "CLI_COMMAND_UNKNOWN");
  assert.match(retired.message, /dispatch-classes-list.*dispatch-mode-list.*vocabulary/u);
});
