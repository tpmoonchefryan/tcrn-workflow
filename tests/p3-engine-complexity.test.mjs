// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  createProject,
  createWork,
  initializeWorkspace,
  materializeWorkspace,
} from "../dist/build/packages/core/src/index.js";
import * as publicCore from "../dist/build/packages/core/src/index.js";
import { withWorkspacePerfInstrumentation } from "../dist/build/packages/core/src/workspace-perf-instrumentation.js";

const instant = (second) => `2026-07-11T00:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;

async function fixture(context, chains) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-complexity-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "FIXTURE-COMPLEXITY", createdAt: instant(0), segmentEventLimit: 1024 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  let version = 0;
  let workEvents = 0;
  const at = () => instant(version + 2);
  try {
    let s = await createProject(workspace, lease, { expectedVersion: version, occurredAt: at(), externalKey: "PROJECT-C", name: "C" }); version += 1;
    const projectId = s.projects[0].id;
    for (let i = 0; i < chains; i += 1) {
      s = await createWork(workspace, lease, { expectedVersion: version, occurredAt: at(), projectId, externalKey: `INITIATIVE-${i}`, kind: "Initiative", parentId: null }); version += 1; workEvents += 1;
      const initiativeId = s.work.find((r) => r.externalKey === `INITIATIVE-${i}`).id;
      s = await createWork(workspace, lease, { expectedVersion: version, occurredAt: at(), projectId, externalKey: `EPIC-${i}`, kind: "Epic", parentId: initiativeId }); version += 1; workEvents += 1;
      const epicId = s.work.find((r) => r.externalKey === `EPIC-${i}`).id;
      s = await createWork(workspace, lease, { expectedVersion: version, occurredAt: at(), projectId, externalKey: `STORY-${i}`, kind: "Story", parentId: epicId }); version += 1; workEvents += 1;
      s = await createWork(workspace, lease, { expectedVersion: version, occurredAt: at(), projectId, externalKey: `SUBTASK-${i}`, kind: "Subtask", parentId: s.work.find((r) => r.externalKey === `STORY-${i}`).id }); version += 1; workEvents += 1;
    }
    return { workspace, lease, version, workEvents, projectId };
  } catch (error) {
    await lease.release();
    throw error;
  }
}

test("WSA-1: a committed mutation performs exactly one full event-log replay", async (context) => {
  const fx = await fixture(context, 8);
  try {
    const { metrics } = await withWorkspacePerfInstrumentation(() => createWork(fx.workspace, fx.lease, {
      expectedVersion: fx.version, occurredAt: instant(fx.version + 2), projectId: fx.projectId, externalKey: "INITIATIVE-EXTRA", kind: "Initiative", parentId: null,
    }));
    assert.equal(metrics.fullMaterialize, 1, "one full replay per committed mutation");
  } finally {
    await fx.lease.release();
  }
});

test("WSA-2: replaying an n-event chain runs one terminal full-graph validation and O(delta) per-event closures", async (context) => {
  const fx = await fixture(context, 12);
  try {
    const { metrics } = await withWorkspacePerfInstrumentation(() => materializeWorkspace(fx.workspace));
    assert.equal(metrics.fullMaterialize, 1);
    assert.equal(metrics.terminalGraphValidation, 1, "exactly one full-graph validation per replay, not one per event");
    assert.equal(metrics.closureValidation, fx.workEvents, "one bounded closure validation per work event");
    // each closure is the record plus its ancestor chain, bounded by the four-level hierarchy
    assert.ok(metrics.closureRecordsVisited <= metrics.closureValidation * 4, "closures are ancestor-bounded (<= depth 4)");
  } finally {
    await fx.lease.release();
  }
});

test("WSA-5: the perf instrumentation is absent from the public package surface", () => {
  assert.equal(publicCore.withWorkspacePerfInstrumentation, undefined);
  assert.equal(publicCore.recordFullMaterialize, undefined);
  assert.equal(publicCore.recordClosureValidation, undefined);
  assert.equal(publicCore.recordTerminalGraphValidation, undefined);
});
