// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  SETTINGS_CATALOG,
  SETTINGS_LAYER_KIND,
  acquireWorkspaceLease,
  appendEvents,
  initializeWorkspace,
  materializeWorkspace,
  setWorkspaceSetting,
  validateSettingValue,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import {
  isRetiredSettingKey,
  settingsCatalogEntry,
} from "../dist/build/packages/core/src/settings.js";

const instant = (second) => `2026-08-11T00:00:${String(second).padStart(2, "0")}Z`;

async function fixture(context, suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s213-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: `FIXTURE-S213-${suffix}`, createdAt: instant(0), segmentEventLimit: 64 });
  return { workspace };
}

async function runRaw(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function errorReason(args) {
  return runCli(args, { write() {} }).then(() => null, (error) => error?.reasonCode);
}

async function appendRetiredHistory(workspace, lease) {
  const record = {
    schemaVersion: "tcrn.workspace-setting.v1",
    key: "execution.personalessDispatch",
    layerKind: "workspace_configuration",
    value: "legacy-value",
    revision: 1,
    updatedAt: instant(2),
    tombstone: false,
  };
  // Use appendEvents with a hand-built delta so the real createEvent hash path
  // constructs the synthetic history while createWorkspaceSettingRecord is bypassed.
  return appendEvents(workspace, lease, [
    (state) => ({
      payload: { operation: "settings.updated", record },
      projects: state.projects,
      work: state.work,
      settings: state.settings,
    }),
  ], { expectedVersion: 0, occurredAt: instant(2) });
}

test("INIT-022 S213: catalog exposes every engine-consumed workspace setting", async (t) => {
  const { workspace } = await fixture(t, "catalog");
  const readback = await runRaw(["settings-catalog", "--workspace", workspace]);
  assert.equal(readback.reasonCode, "SETTINGS_CATALOG_READY");
  assert.equal(readback.layerKind, SETTINGS_LAYER_KIND);
  assert.deepEqual(readback.settings.map((entry) => entry.key), SETTINGS_CATALOG.map((entry) => entry.key));
  assert.deepEqual(readback.settings.map((entry) => entry.layer), SETTINGS_CATALOG.map((entry) => entry.layerKind));
  assert.deepEqual(readback.settings.map((entry) => entry.currentValue), SETTINGS_CATALOG.map((entry) => entry.defaultValue));
  assert.deepEqual(readback.settings.map((entry) => entry.type), SETTINGS_CATALOG.map((entry) => entry.type));
});

test("INIT-022 S213: unknown keys fail closed and registered writes receipt plus replay readback", async (t) => {
  const { workspace } = await fixture(t, "write");
  const baseArgs = ["settings-set", "--workspace", workspace, "--expected-version", "0", "--at", instant(1), "--actor", "agent:codex"];
  assert.equal(await errorReason([...baseArgs, "--key", "settings.not-registered", "--value", "manual"]), "SETTINGS_KEY_UNREGISTERED");
  assert.equal((await materializeWorkspace(workspace)).version, 0, "a rejected key must not append an event");

  const receipt = await runRaw([...baseArgs, "--key", "backup.cadence", "--value", "manual"]);
  assert.equal(receipt.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(receipt.setting.key, "backup.cadence");
  assert.equal(receipt.setting.value, "manual");
  assert.equal(receipt.setting.layerKind, SETTINGS_LAYER_KIND);
  assert.equal(receipt.setting.revision, 1);
  assert.equal(receipt.version, 1);

  const state = await validateWorkspace(workspace);
  assert.equal(state.settings.length, 1);
  assert.equal(state.settings[0].value, "manual");
  assert.equal(state.events[0].payload.operation, "settings.updated");
  const catalog = await runRaw(["settings-catalog", "--workspace", workspace]);
  assert.equal(catalog.settings.find((entry) => entry.key === "backup.cadence").currentValue, "manual");

  const lease = await acquireWorkspaceLease(workspace, { now: instant(2) });
  try {
    await assert.rejects(
      setWorkspaceSetting(workspace, lease, {
        expectedVersion: 1,
        occurredAt: instant(3),
        key: "backup.destination",
        value: workspace,
        actorId: "agent:codex",
      }),
      (error) => error?.reasonCode === "SETTINGS_VALUE_INVALID",
    );
  } finally {
    await lease.release();
  }
  assert.equal((await materializeWorkspace(workspace)).version, 1, "a rejected path must not append an event");
});

test("STORY-366: article directories are workspace-relative by default and cannot target the control tree", async (t) => {
  const { workspace } = await fixture(t, "articles-path");
  const catalog = await runRaw(["settings-catalog", "--workspace", workspace]);
  const entry = catalog.settings.find((setting) => setting.key === "knowledge.articlesPath");
  assert.equal(entry.defaultValue, "docs/knowledge/articles");
  assert.equal(entry.currentValue, "docs/knowledge/articles");
  assert.equal(validateSettingValue("knowledge.articlesPath", "docs/knowledge/articles", workspace), "docs/knowledge/articles");
  assert.equal(validateSettingValue("knowledge.articlesPath", "/tmp/tcrn-article-root", workspace), "/tmp/tcrn-article-root");
  assert.throws(() => validateSettingValue("knowledge.articlesPath", "../outside", workspace), (error) => error?.reasonCode === "SETTINGS_VALUE_INVALID");
  assert.throws(() => validateSettingValue("knowledge.articlesPath", ".tcrn-workflow/articles", workspace), (error) => error?.reasonCode === "SETTINGS_VALUE_INVALID");
  assert.throws(() => validateSettingValue("knowledge.articlesPath", `${workspace}/.tcrn-workflow/articles`, workspace), (error) => error?.reasonCode === "SETTINGS_VALUE_INVALID");
});

test("INC-321 S3: a retired settings.updated event replays from genesis and stays out of current settings", async (t) => {
  const { workspace } = await fixture(t, "retired-replay");
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  try {
    await appendRetiredHistory(workspace, lease);
    const state = await materializeWorkspace(workspace);
    assert.equal(state.version, 1);
    assert.equal(state.events.length, 1);
    assert.equal(state.settings.length, 0, "retired values are not materialized as current settings");
    assert.equal(isRetiredSettingKey("execution.personalessDispatch"), true);
    assert.equal(isRetiredSettingKey("backup.cadence"), false);
    assert.equal(isRetiredSettingKey("settings.random"), false);
  } finally {
    await lease.release();
  }
});

test("INC-321 S3: the normal settings write path still rejects the retired key", async (t) => {
  const { workspace } = await fixture(t, "retired-write");
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  try {
    await appendRetiredHistory(workspace, lease);
    await assert.rejects(
      setWorkspaceSetting(workspace, lease, {
        key: "execution.personalessDispatch",
        value: "new-value",
        expectedVersion: 1,
        occurredAt: instant(3),
      }),
      (error) => error?.reasonCode === "SETTINGS_KEY_UNREGISTERED",
    );
    assert.throws(
      () => settingsCatalogEntry("execution.personalessDispatch"),
      (error) => error?.reasonCode === "SETTINGS_KEY_UNREGISTERED",
    );
    const state = await materializeWorkspace(workspace);
    assert.equal(state.version, 1, "the rejected write does not append an event");
    assert.equal(state.settings.length, 0);
  } finally {
    await lease.release();
  }
});
