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
  initializeWorkspace,
  materializeWorkspace,
  setWorkspaceSetting,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";

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
