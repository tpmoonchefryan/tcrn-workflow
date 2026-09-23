// SPDX-License-Identifier: Apache-2.0
// STORY-337: read from the latest replay snapshot and apply only the tail.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  appendEvents,
  applyWorkBatch,
  buildEventPayload,
  createProject,
  createWorkspaceSettingRecord,
  initializeWorkspace,
  materializeWorkspace,
  setWorkspaceSetting,
  sortWorkspaceSettings,
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
    manifest.stateDigest = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
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
    assert.deepEqual(manifest.snapshotParts, ["000000000004.part0001"]);
  } finally {
    await fx.lease.release();
  }
});

test("STORY-337 snapshot replay source has an explicit fail-closed corruption path", async (context) => {
  const fx = await fixture(context, "BEHAVIOR");
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
    assert.equal(manifest.version, 2);
    manifest.stateDigest = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    await assert.rejects(() => materializeWorkspace(fx.workspace), (error) => error?.reasonCode === "WORKSPACE_SNAPSHOT_INVALID");
  } finally {
    await fx.lease.release();
  }
});

// TCRN-CROSS-STORY-451 R3 (#250). appendEvents checks for a checkpoint once, at the end of
// the append, and the old rule wrote one only when that end sat exactly on a multiple of
// the interval. A batch that stepped over the multiple wrote none: cross-project's 8192
// fell inside a thirteen-event batch and every read kept replaying from 7680. Red leg:
// test the final version with the modulo again and the crossing batches write nothing.
async function manifestVersion(fx) {
  return JSON.parse(await readFile(join(fx.workspace, controlDirectory, "snapshots", "manifest.json"), "utf8")).version;
}

function incidents(fx, prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    verb: "work-create", projectId: fx.projectId, externalKey: `${prefix}-${index}`, kind: "Incident", parentId: null, status: "active", title: `${prefix} ${index}`,
  }));
}

test("STORY-451 a work-batch from 510 to 515 writes the replay snapshot at 515", async (context) => {
  const fx = await fixture(context, "CROSS-512");
  try {
    let state = await createProjects(fx, 1);
    fx.projectId = state.projects[0].id;
    const at = instant(10);
    // One append of alternating setting values reaches 510 without a checkpoint: each
    // separate append would replay the whole chain.
    const deltas = Array.from({ length: 510 - state.version }, (_, index) => (current) => {
      const prior = current.settings.find((entry) => entry.key === "injection.budgetBytes");
      const record = createWorkspaceSettingRecord("injection.budgetBytes", index % 2 === 0 ? "24577" : "24576", (prior?.revision ?? 0) + 1, at, fx.workspace);
      return {
        payload: buildEventPayload("settings.updated", record),
        projects: current.projects,
        work: current.work,
        settings: sortWorkspaceSettings([...current.settings.filter((entry) => entry.key !== record.key), record]),
      };
    });
    state = await appendEvents(fx.workspace, fx.lease, deltas, { expectedVersion: state.version, occurredAt: at });
    assert.equal(state.version, 510);
    await assert.rejects(manifestVersion(fx), { code: "ENOENT" }, "precondition: no checkpoint below the first multiple");
    state = await applyWorkBatch(fx.workspace, fx.lease, { schemaVersion: "tcrn.work-batch.v1", members: incidents(fx, "S451-BATCH", 5) }, {
      expectedVersion: state.version, occurredAt: instant(11),
    });
    assert.equal(state.version, 515);
    assert.equal(await manifestVersion(fx), 515, "the batch crossed 512, so the checkpoint is the version the batch landed on");
    assert.deepEqual(await materializeWorkspace(fx.workspace), state, "and the checkpoint replays to the committed state");
  } finally {
    await fx.lease.release();
  }
});

test("STORY-451 a crossing batch writes the checkpoint at a small interval, and a single event on a multiple still does", async (context) => {
  const fx = await fixture(context, "CROSS-SMALL");
  try {
    let state = await setWorkspaceSetting(fx.workspace, fx.lease, {
      key: "storage.snapshotEveryEvents",
      value: "3",
      expectedVersion: 0,
      occurredAt: instant(2),
    });
    state = await createProjects(fx, 1, state.version);
    fx.projectId = state.projects[0].id;
    assert.equal(state.version, 2);
    state = await applyWorkBatch(fx.workspace, fx.lease, { schemaVersion: "tcrn.work-batch.v1", members: incidents(fx, "S451-SMALL", 3) }, {
      expectedVersion: state.version, occurredAt: instant(12),
    });
    assert.equal(state.version, 5);
    assert.equal(await manifestVersion(fx), 5, "2 -> 5 crosses 3");
    state = await createProjects(fx, 1, state.version);
    assert.equal(state.version, 6);
    assert.equal(await manifestVersion(fx), 6, "a single event that lands on a multiple writes the checkpoint as before");
    state = await createProjects(fx, 1, state.version);
    assert.equal(state.version, 7);
    assert.equal(await manifestVersion(fx), 6, "an append that crosses no multiple writes none");
  } finally {
    await fx.lease.release();
  }
});

test("STORY-451 a single event appended onto 512 writes the checkpoint at the default interval", async (context) => {
  const fx = await fixture(context, "SINGLE-512");
  try {
    let state = await createProjects(fx, 1);
    const at = instant(20);
    const deltas = Array.from({ length: 511 - state.version }, (_, index) => (current) => {
      const prior = current.settings.find((entry) => entry.key === "injection.budgetBytes");
      const record = createWorkspaceSettingRecord("injection.budgetBytes", index % 2 === 0 ? "24577" : "24576", (prior?.revision ?? 0) + 1, at, fx.workspace);
      return {
        payload: buildEventPayload("settings.updated", record),
        projects: current.projects,
        work: current.work,
        settings: sortWorkspaceSettings([...current.settings.filter((entry) => entry.key !== record.key), record]),
      };
    });
    state = await appendEvents(fx.workspace, fx.lease, deltas, { expectedVersion: state.version, occurredAt: at });
    assert.equal(state.version, 511);
    state = await createProject(fx.workspace, fx.lease, {
      externalKey: "STORY-451-SINGLE-512",
      name: "Single event onto 512",
      expectedVersion: state.version,
      occurredAt: instant(21),
    });
    assert.equal(state.version, 512);
    assert.equal(await manifestVersion(fx), 512);
  } finally {
    await fx.lease.release();
  }
});
