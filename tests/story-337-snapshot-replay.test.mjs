// SPDX-License-Identifier: Apache-2.0
// STORY-337: read from the latest replay snapshot and apply only the tail.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  createProject,
  initializeWorkspace,
  materializeWorkspace,
  setWorkspaceSetting,
} from "../dist/build/packages/core/src/index.js";
import { withWorkspacePerfInstrumentation } from "../dist/build/packages/core/src/workspace-perf-instrumentation.js";

const instant = (second) => `2026-09-02T02:00:${String(second).padStart(2, "0")}Z`;
const controlDirectory = ".tcrn-" + "workflow";

async function fixture(context, suffix = "REPLAY") {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s337-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: `STORY-337-${suffix}`, createdAt: instant(0) });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  return { base, roots, workspace, lease };
}

async function createProjects(fx, count, startVersion = 0) {
  let state = await materializeWorkspace(fx.workspace);
  for (let index = 0; index < count; index += 1) {
    state = await createProject(fx.workspace, fx.lease, {
      externalKey: `STORY-337-PROJECT-${String(startVersion + index).padStart(2, "0")}`,
      name: `Project ${index}`,
      expectedVersion: state.version,
      occurredAt: instant(startVersion + index + 2),
    });
  }
  return state;
}

test("STORY-337 snapshot replay matches full replay and avoids a full materialize", async (context) => {
  const fx = await fixture(context);
  try {
    let state = await setWorkspaceSetting(fx.workspace, fx.lease, {
      key: "storage.snapshotEveryEvents",
      value: "3",
      expectedVersion: 0,
      occurredAt: instant(2),
    });
    state = await createProjects(fx, 4, state.version);
    assert.equal(state.version, 5);

    const snapshotDirectory = join(fx.workspace, controlDirectory, "snapshots");
    const manifest = JSON.parse(await readFile(join(snapshotDirectory, "manifest.json"), "utf8"));
    assert.equal(manifest.version, 3, "the configured interval writes the newest completed checkpoint");

    const measured = await withWorkspacePerfInstrumentation(() => materializeWorkspace(fx.workspace));
    assert.deepEqual(measured.result, await materializeWorkspace(fx.workspace));
    assert.equal(measured.metrics.fullMaterialize, 0);
    assert.equal(measured.metrics.snapshotMaterialize, 1);

    const hidden = join(fx.base, "snapshots-hidden");
    await rename(snapshotDirectory, hidden);
    const full = await materializeWorkspace(fx.workspace);
    await rename(hidden, snapshotDirectory);
    assert.deepEqual(measured.result, full, "snapshot-backed and full replay states must be equal by value");
  } finally {
    await fx.lease.release();
  }
});

test("STORY-337 corrupted replay snapshot fails closed without falling back to full replay", async (context) => {
  const fx = await fixture(context, "CORRUPT");
  try {
    let state = await setWorkspaceSetting(fx.workspace, fx.lease, {
      key: "storage.snapshotEveryEvents",
      value: "2",
      expectedVersion: 0,
      occurredAt: instant(2),
    });
    state = await createProjects(fx, 1, state.version);
    assert.equal(state.version, 2);
    const manifestPath = join(fx.workspace, controlDirectory, "snapshots", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const snapshotPath = join(fx.workspace, controlDirectory, "snapshots", manifest.snapshot);
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    snapshot.stateDigest = "0".repeat(64);
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`, "utf8");
    await assert.rejects(() => materializeWorkspace(fx.workspace), (error) => error?.reasonCode === "WORKSPACE_SNAPSHOT_INVALID");
  } finally {
    await fx.lease.release();
  }
});

test("STORY-337 snapshot interval setting controls checkpoint versions", async (context) => {
  const fx = await fixture(context, "INTERVAL");
  try {
    let state = await setWorkspaceSetting(fx.workspace, fx.lease, {
      key: "storage.snapshotEveryEvents",
      value: "2",
      expectedVersion: 0,
      occurredAt: instant(2),
    });
    state = await createProjects(fx, 3, state.version);
    assert.equal(state.version, 4);
    const manifest = JSON.parse(await readFile(join(fx.workspace, controlDirectory, "snapshots", "manifest.json"), "utf8"));
    assert.equal(manifest.version, 4);
    assert.match(manifest.snapshot, /^000000000004\.json$/u);
  } finally {
    await fx.lease.release();
  }
});

test("STORY-337 snapshot replay source has an explicit fail-closed corruption path", async () => {
  const source = await readFile(new URL("../packages/core/src/workspace.ts", import.meta.url), "utf8");
  assert.match(source, /WORKSPACE_SNAPSHOT_INVALID/u);
  assert.match(source, /return materialize\(workspace\.metadata, events\.slice\(snapshot\.version\)/u);
  assert.match(source, /writeControlFile\(`\$\{WORKSPACE_REPLAY_SNAPSHOT_DIRECTORY\}\/\$\{WORKSPACE_REPLAY_SNAPSHOT_MANIFEST\}`/u);
});
