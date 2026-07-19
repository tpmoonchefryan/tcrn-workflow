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
  deleteWork,
  initializeWorkspace,
  materializeWorkspace,
  openConferenceInWorkspace,
  transitionGateInWorkspace,
  transitionWork,
} from "../dist/build/packages/core/src/index.js";
import * as publicCore from "../dist/build/packages/core/src/index.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { withWorkspacePerfInstrumentation } from "../dist/build/packages/core/src/workspace-perf-instrumentation.js";

const minutesLocator = (minutesExternalKey) => `conference-minutes:${deriveStableId("minutes", minutesExternalKey).slice("minutes:".length)}`;

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
    // CQ-10b: an append-only history is genuinely scan-free. Every scanning arm is
    // gated on a delete, a done transition, or a gate satisfaction, so this shape
    // is the one where the plain O(delta) claim holds without qualification.
    assert.equal(metrics.collectionScan, 0, "append-only replay performs no full-collection scans");
    assert.equal(metrics.collectionScanRecordsVisited, 0);
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
  assert.equal(publicCore.recordCollectionScan, undefined);
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
      expectedVersion: version, occurredAt: at(), conferenceId, externalKey: "POSITION-COMPLEXITY", authorActorId: "profile:counter-01",
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

// CQ-10b: the three shapes the WSA-5 proof could not see. Before the
// collectionScan counter, the fixtures above were append-only, transitioned their
// gate to "blocked" rather than "satisfied", and never deleted a record — so the
// four full-collection scans in the reducer loop could grow without moving one
// asserted number. Each test below pins the exact closed form of its scan arm, so
// a regression that adds a scan, or widens one, fails here instead of silently
// degrading replay. The scans are retained deliberately: measurement put all four
// at 4% of replay at the reachable ceiling, which does not justify trading
// fail-closed corruption checks for incrementally maintained indices.

test("CQ-10b: the work-delete arm scans the whole work map per delete, and the closure counters cannot see it", async (context) => {
  const chains = 6;
  const fx = await fixture(context, chains);
  try {
    let version = fx.version;
    const at = () => instant(version + 2);
    const idByKey = new Map((await materializeWorkspace(fx.workspace)).work.map((r) => [r.externalKey, r.id]));
    // bottom-up, so no delete ever strands a live child (TOMBSTONE_REFERENCED)
    for (let i = 0; i < chains; i += 1) {
      for (const prefix of ["SUBTASK", "STORY", "EPIC", "INITIATIVE"]) {
        await deleteWork(fx.workspace, fx.lease, { expectedVersion: version, occurredAt: at(), id: idByKey.get(`${prefix}-${i}`) });
        version += 1;
      }
    }
    const records = chains * 4;
    const { metrics } = await withWorkspacePerfInstrumentation(() => materializeWorkspace(fx.workspace));
    assert.equal(metrics.fullMaterialize, 1);
    assert.equal(metrics.terminalGraphValidation, 1);
    assert.equal(metrics.closureValidation, fx.workEvents + records, "one closure validation per work event, creates and deletes alike");
    // The exact quadratic term: one scan per delete, each visiting every work
    // record materialized so far. Tombstones stay in the map, so the scanned size
    // is the full record count throughout the delete run.
    assert.equal(metrics.collectionScan, records, "one full work-map scan per work.deleted event");
    assert.equal(metrics.collectionScanRecordsVisited, records * records, "each delete scan visits every work record: records^2 total");
    // The blindness this counter exists to remove: the closure counters stay
    // ancestor-bounded across the whole delete run and never observe the scan.
    assert.ok(metrics.closureRecordsVisited <= metrics.closureValidation * 4, "closure counters remain ancestor-bounded and blind to the scan");
  } finally {
    await fx.lease.release();
  }
});

test("CQ-10b: gate clearance scans the gate collection only on a transition whose target is done", async (context) => {
  const fx = await fixture(context, 1);
  try {
    let version = fx.version;
    const at = () => instant(version + 2);
    const anchorId = (await materializeWorkspace(fx.workspace)).work.find((r) => r.externalKey === "INITIATIVE-0").id;
    const gates = 3;
    for (let i = 0; i < gates; i += 1) {
      await createGateInWorkspace(fx.workspace, fx.lease, {
        expectedVersion: version, occurredAt: at(), externalKey: `GATE-SCAN-${i}`, projectId: fx.projectId, workId: anchorId,
        title: `Scan gate ${i}`, outcomeClass: "role_decision",
      }); version += 1;
    }
    // EPIC-0 carries no gate, so it can reach done past the three pending gates
    // anchored to INITIATIVE-0. planned -> ready -> active -> done: three
    // transitions, of which only the last is in the designated set.
    const epicId = (await materializeWorkspace(fx.workspace)).work.find((r) => r.externalKey === "EPIC-0").id;
    for (const status of ["ready", "active", "done"]) {
      await transitionWork(fx.workspace, fx.lease, { expectedVersion: version, occurredAt: at(), id: epicId, status });
      version += 1;
    }
    const { metrics } = await withWorkspacePerfInstrumentation(() => materializeWorkspace(fx.workspace));
    assert.equal(metrics.fullMaterialize, 1);
    // Three work.updated events, one scan: the ready and active targets early-return
    // before the scan. done is terminal, so this arm is once per record, not per update.
    assert.equal(metrics.collectionScan, 1, "only the done transition scans; ready and active early-return");
    assert.equal(metrics.collectionScanRecordsVisited, gates, "the done scan visits every gate materialized so far");
  } finally {
    await fx.lease.release();
  }
});

test("CQ-10b: a gate-satisfied transition copies the whole conference and minutes maps to resolve its evidence", async (context) => {
  const fx = await fixture(context, 1);
  try {
    let version = fx.version;
    const at = () => instant(version + 2);
    const anchorId = (await materializeWorkspace(fx.workspace)).work.find((r) => r.externalKey === "INITIATIVE-0").id;
    const conferences = 2;
    for (let i = 0; i < conferences; i += 1) {
      await openConferenceInWorkspace(fx.workspace, fx.lease, {
        expectedVersion: version, occurredAt: at(), externalKey: `CONF-SAT-${i}`, projectId: fx.projectId, type: "architecture",
        title: `Satisfy ${i}`, linkedWorkIds: [anchorId], desiredOutcome: "resolve evidence", participantIds: [],
      }); version += 1;
      const conferenceId = deriveStableId("conference", `CONF-SAT-${i}`);
      await appendConferencePositionInWorkspace(fx.workspace, fx.lease, {
        expectedVersion: version, occurredAt: at(), conferenceId, externalKey: `POSITION-SAT-${i}`, authorActorId: "profile:counter-01",
        position: "Counted.", risks: [], recommendations: [], evidenceIds: [],
      }); version += 1;
      await closeConferenceInWorkspace(fx.workspace, fx.lease, {
        expectedVersion: version, occurredAt: at(), conferenceId, minutesExternalKey: `MINUTES-SAT-${i}`,
        summary: "Counted.", outcomeClass: "role_decision", decisions: ["count"], unresolvedIssues: [],
      }); version += 1;
    }
    await createGateInWorkspace(fx.workspace, fx.lease, {
      expectedVersion: version, occurredAt: at(), externalKey: "GATE-SAT", projectId: fx.projectId, workId: anchorId,
      title: "Satisfy gate", outcomeClass: "role_decision",
    }); version += 1;
    await transitionGateInWorkspace(fx.workspace, fx.lease, {
      expectedVersion: version, occurredAt: at(), id: deriveStableId("gate", "GATE-SAT"),
      status: "satisfied", minutesLocator: minutesLocator("MINUTES-SAT-0"),
    }); version += 1;
    const { metrics } = await withWorkspacePerfInstrumentation(() => materializeWorkspace(fx.workspace));
    assert.equal(metrics.fullMaterialize, 1);
    // One satisfied transition, one counted copy pair. The gate.created and
    // conference arms stay bounded lookups and contribute no scan.
    assert.equal(metrics.collectionScan, 1, "only the satisfied transition copies the extension maps");
    assert.equal(metrics.collectionScanRecordsVisited, conferences * 2, "the copy spans every conference and every minutes record");
  } finally {
    await fx.lease.release();
  }
});
