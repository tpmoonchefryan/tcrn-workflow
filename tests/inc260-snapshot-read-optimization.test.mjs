// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-260: snapshot reads verify segment prefixes once and replay only the tail.

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  createProject,
  initializeWorkspace,
  materializeWorkspace,
  rebuildReplaySnapshot,
} from "../dist/build/packages/core/src/index.js";
import { withWorkspacePerfInstrumentation } from "../dist/build/packages/core/src/workspace-perf-instrumentation.js";

const controlDirectory = ".tcrn-" + "workflow";
const chainContainer = [".tcrn", "workspace"].join("-");
const livePartitions = ["ADBlock", "TCRN-TMS", "TCRN-AOS", "Joi-Button", "cross-project"];

function logicalState(state) {
  return {
    version: state.version,
    headEventHash: state.headEventHash,
    projects: state.projects,
    work: state.work,
    conferences: state.conferences,
    conferencePositions: state.conferencePositions,
    conferenceMinutes: state.conferenceMinutes,
    gates: state.gates,
    settings: state.settings,
    executionConfig: state.executionConfig,
    templates: state.templates,
    events: state.events,
    attestationEnabledAtSequence: state.attestationEnabledAtSequence,
  };
}

async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc260-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "INC260-SNAPSHOT-FIXTURE", createdAt: "2026-09-02T04:00:00Z" });
  const lease = await acquireWorkspaceLease(workspace, { now: "2026-09-02T04:00:01Z" });
  let state = await materializeWorkspace(workspace);
  for (let index = 0; index < 4; index += 1) {
    state = await createProject(workspace, lease, {
      externalKey: `INC260-PROJECT-${index}`,
      name: `Project ${index}`,
      expectedVersion: state.version,
      occurredAt: `2026-09-02T04:00:0${index + 2}Z`,
    });
  }
  await lease.release();
  await rebuildReplaySnapshot(workspace);
  return { base, workspace };
}

test("INC-260 snapshot-backed state equals a full replay and rejects snapshot or segment corruption", async (context) => {
  const fx = await fixture(context);
  const snapshotState = await materializeWorkspace(fx.workspace);
  const hidden = join(fx.base, "snapshots-hidden");
  await rename(join(fx.workspace, controlDirectory, "snapshots"), hidden);
  const fullState = await materializeWorkspace(fx.workspace);
  await rename(hidden, join(fx.workspace, controlDirectory, "snapshots"));
  assert.deepEqual(logicalState(snapshotState), logicalState(fullState));

  const manifestPath = join(fx.workspace, controlDirectory, "snapshots", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, stateDigest: "0".repeat(64) })}\n`, "utf8");
  await assert.rejects(() => materializeWorkspace(fx.workspace), (error) => error?.reasonCode === "WORKSPACE_SNAPSHOT_INVALID");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

  const segmentPath = join(fx.workspace, controlDirectory, "events", manifest.segments[0].name);
  const segment = await readFile(segmentPath);
  const marker = Buffer.from("Project");
  const offset = segment.indexOf(marker);
  assert.ok(offset >= 0);
  const altered = Buffer.from(segment);
  altered[offset] = altered[offset] === 0x50 ? 0x51 : 0x50;
  await writeFile(segmentPath, altered);
  await assert.rejects(() => materializeWorkspace(fx.workspace), (error) => error?.reasonCode === "WORKSPACE_SNAPSHOT_INVALID");
});

test("INC-260 live snapshot reads have a regression slope below the 75 microsecond baseline", async () => {
  const platformRoot = resolve(process.cwd(), "../..");
  const rows = [];
  for (const partition of livePartitions) {
    const workspace = join(platformRoot, chainContainer, partition, "workspace");
    const baseline = await materializeWorkspace(workspace);
    const samples = [];
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now();
      const current = await materializeWorkspace(workspace);
      samples.push(performance.now() - started);
      assert.equal(current.version, baseline.version, partition);
    }
    samples.sort((left, right) => left - right);
    rows.push({ partition, events: baseline.events.length, medianMs: samples[2] });
  }
  const meanX = rows.reduce((sum, row) => sum + row.events, 0) / rows.length;
  const meanY = rows.reduce((sum, row) => sum + row.medianMs, 0) / rows.length;
  const slopeMsPerEvent = rows.reduce((sum, row) => sum + (row.events - meanX) * (row.medianMs - meanY), 0) /
    rows.reduce((sum, row) => sum + (row.events - meanX) ** 2, 0);
  assert.ok(slopeMsPerEvent * 1000 < 75, `snapshot read slope ${slopeMsPerEvent * 1000}us/event must be below the 75us baseline`);
});

test("INC-260 the reader validates the snapshot once and replays only the tail", async (context) => {
  const fx = await fixture(context);
  const measured = await withWorkspacePerfInstrumentation(() => materializeWorkspace(fx.workspace));
  assert.equal(measured.metrics.fullMaterialize, 0);
  assert.equal(measured.metrics.snapshotMaterialize, 1);
  const manifest = JSON.parse(await readFile(join(fx.workspace, controlDirectory, "snapshots", "manifest.json"), "utf8"));
  assert.equal(Object.hasOwn(manifest, "eventPrefixDigest"), false);
  assert.deepEqual(logicalState(measured.result), logicalState(await materializeWorkspace(fx.workspace)));
});
