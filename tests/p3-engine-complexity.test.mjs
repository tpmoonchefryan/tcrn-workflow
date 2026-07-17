// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  appendConferencePositionInWorkspace,
  closeConferenceInWorkspace,
  createGateInWorkspace,
  createProject,
  createWork,
  initializeWorkspace,
  materializeWorkspace,
  openConferenceInWorkspace,
  transitionGateInWorkspace,
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
  assert.equal(publicCore.recordExtensionClosureValidation, undefined);
});

// WSD-1 (SDC-3/CONF-4): conference/gate reducer arms validate O(delta) per event
// through their own counter — bounded lookups of the records each event
// references — and never touch the work-closure counters, so the WSA-2 work-only
// equalities above stay exact on mixed histories.
test("WSD-1: extension reducer arms are O(delta) with exact per-operation counts and leave work-closure counters untouched", async (context) => {
  const fx = await fixture(context, 4);
  try {
    let version = fx.version;
    const at = () => instant(version + 2);
    const anchorId = (await materializeWorkspace(fx.workspace)).work.find((r) => r.externalKey === "INITIATIVE-0").id;
    let state = await openConferenceInWorkspace(fx.workspace, fx.lease, {
      expectedVersion: version, occurredAt: at(), externalKey: "CONF-COMPLEXITY", projectId: fx.projectId, type: "architecture",
      title: "Complexity", linkedWorkIds: [anchorId], desiredOutcome: "prove O(delta)", participantIds: [],
    }); version += 1;
    const conferenceId = state.conferences[0].id;
    state = await appendConferencePositionInWorkspace(fx.workspace, fx.lease, {
      expectedVersion: version, occurredAt: at(), conferenceId, externalKey: "POSITION-COMPLEXITY", actorId: "profile:counter-01",
      position: "Count the visits.", risks: [], recommendations: [], evidenceIds: [],
    }); version += 1;
    state = await closeConferenceInWorkspace(fx.workspace, fx.lease, {
      expectedVersion: version, occurredAt: at(), conferenceId, minutesExternalKey: "MINUTES-COMPLEXITY",
      summary: "Counted.", outcomeClass: "role_decision", decisions: ["count"], unresolvedIssues: [],
    }); version += 1;
    state = await createGateInWorkspace(fx.workspace, fx.lease, {
      expectedVersion: version, occurredAt: at(), externalKey: "GATE-COMPLEXITY", projectId: fx.projectId, workId: anchorId,
      title: "Counter gate", outcomeClass: "role_decision",
    }); version += 1;
    await transitionGateInWorkspace(fx.workspace, fx.lease, {
      expectedVersion: version, occurredAt: at(), id: state.gates[0].id, status: "blocked",
    }); version += 1;
    const { metrics } = await withWorkspacePerfInstrumentation(() => materializeWorkspace(fx.workspace));
    assert.equal(metrics.fullMaterialize, 1);
    assert.equal(metrics.terminalGraphValidation, 1);
    assert.equal(metrics.closureValidation, fx.workEvents, "work-closure counts ignore extension events");
    // Exact closed form: created 2+linked(1)=3, position 2, closed 3, gate
    // created 2+anchor(1)=3, gate updated 2 — one bounded validation per event.
    assert.equal(metrics.extensionClosureValidation, 5);
    assert.equal(metrics.extensionClosureRecordsVisited, 13);
  } finally {
    await fx.lease.release();
  }
});
