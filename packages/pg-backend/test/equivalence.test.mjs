// SPDX-License-Identifier: Apache-2.0
// STORY-176 — the dual-backend equivalence gate (window-hardware ①).
//
// Same command sequence against the file backend and the PG backend must
// produce byte-identical export, head hash, and reason codes (ADR-0004 §9.1,
// §9.2, and §9.3 / STORY-173 criteria). A one-byte deviation injected at the
// abstraction layer must turn
// the gate red (mutation witness — a gate nobody saw red is not a gate).
//
// Runs against the local Docker PG (tcrn-postgres). CI supplies an equivalent
// PG the same way; this test is in the pg-backend package so `pg` resolves.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before } from "node:test";

import {
  acquireWorkspaceLease,
  createProject,
  createWork,
  exportWorkspace,
  initializeWorkspace,
  transitionWork,
  updateProject,
  validateWorkspace,
  withStorageBackendFactory,
} from "../../../dist/build/packages/core/src/index.js";
import { PgBackend } from "../../../dist/build/packages/pg-backend/src/index.js";

const CONNECTION = process.env.TCRN_PG_TEST_CONNECTION
  ?? "postgresql://history-user@198.51.100.1:5432/tcrn_governance";
const SCHEMA = process.env.TCRN_PG_TEST_SCHEMA ?? "chain_test_cross";

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

// Isolate: the test runner provisions a dedicated chain_test_* schema; clear it
// before the suite so sequence-1 assertions start clean.
before(async () => {
  const pg = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
  await pg.connect();
  try {
    await pg.clearForTest();
  } finally {
    await pg.close();
  }
});

async function workspaceFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s176-")));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  return {
    base,
    workspace,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function commandSequence(workspace) {
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  try {
    let state = await createProject(workspace, lease, {
      expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-EQUIV", name: "Alpha",
    });
    state = await updateProject(workspace, lease, {
      expectedVersion: 1, occurredAt: instant(2), id: state.projects[0].id, name: "Beta",
    });
    const projectId = state.projects[0].id;
    state = await createWork(workspace, lease, {
      expectedVersion: 2, occurredAt: instant(3), projectId, externalKey: "INIT-EQUIV", kind: "Initiative", parentId: null,
    });
    const workId = state.work[0].id;
    state = await transitionWork(workspace, lease, {
      expectedVersion: 3, occurredAt: instant(4), id: workId, status: "ready",
    });
    return state;
  } finally {
    await lease.release();
  }
}

test("STORY-176: file and PG backends produce byte-identical export and head on the same sequence", async () => {
  const fileFixture = await workspaceFixture();
  const pgFixture = await workspaceFixture();
  const pg = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
  await pg.connect();
  try {
    // File backend baseline.
    await initializeWorkspace({
      roots: await fixtureRoots(fileFixture.workspace),
      externalKey: "WORKSPACE-EQUIV",
      createdAt: instant(0),
      segmentEventLimit: 4,
    });
    await commandSequence(fileFixture.workspace);
    const fileExport = await exportWorkspace(fileFixture.workspace);
    const fileState = await validateWorkspace(fileFixture.workspace);

    // PG backend: same sequence, same roots, same external key. The whole
    // lifecycle (init + sequence) runs under the backend-factory override so
    // metadata/segments/views all land in PG.
    await withStorageBackendFactory(() => pg, async () => {
      await initializeWorkspace({
        roots: await fixtureRoots(pgFixture.workspace),
        externalKey: "WORKSPACE-EQUIV",
        createdAt: instant(0),
        segmentEventLimit: 4,
      });
      await commandSequence(pgFixture.workspace);
    });
    const pgExport = await withStorageBackendFactory(() => pg, async () => exportWorkspace(pgFixture.workspace));
    const pgState = await withStorageBackendFactory(() => pg, async () => validateWorkspace(pgFixture.workspace));

    // Criterion 1+3: per-event byte / head-hash equivalence.
    assert.equal(pgExport, fileExport, "export bytes are identical across backends");
    assert.equal(pgState.version, fileState.version, "version identical");
    assert.equal(pgState.headEventHash, fileState.headEventHash, "head hash identical");
    assert.equal(pgState.work.length, fileState.work.length, "work records identical count");
  } finally {
    await pg.close();
    await fileFixture.close();
    await pgFixture.close();
  }
});

test("STORY-176 mutation witness: a one-byte deviation at the PG abstraction turns the gate red", async () => {
  const fileFixture = await workspaceFixture();
  const pgFixture = await workspaceFixture();
  // Deviated PG backend: readSegment returns a one-byte-shifted segment.
  const deviatedPg = new PgBackend({ schema: SCHEMA, connection: CONNECTION, injectSegmentByteDeviation: true });
  await deviatedPg.connect();
  try {
    await initializeWorkspace({
      roots: await fixtureRoots(fileFixture.workspace),
      externalKey: "WORKSPACE-WITNESS",
      createdAt: instant(0),
      segmentEventLimit: 4,
    });
    await commandSequence(fileFixture.workspace);
    const fileExport = await exportWorkspace(fileFixture.workspace);

    // The deviated read must make the chain read fail closed. The deviation is
    // caught either during the writes themselves (appendEvent's durability
    // readback sees non-JSON) or at export; either way the gate REDS.
    let witnessThrown = null;
    let pgExport = null;
    try {
      await withStorageBackendFactory(() => deviatedPg, async () => {
        await initializeWorkspace({
          roots: await fixtureRoots(pgFixture.workspace),
          externalKey: "WORKSPACE-WITNESS",
          createdAt: instant(0),
          segmentEventLimit: 4,
        });
        await commandSequence(pgFixture.workspace);
      });
      pgExport = await withStorageBackendFactory(() => deviatedPg, async () => exportWorkspace(pgFixture.workspace));
    } catch (error) {
      witnessThrown = error;
    }
    // The gate must RED: either the chain read refused (EVENT_CORRUPT from
    // validateEventChain) or the bytes differ from the clean file baseline.
    const red = witnessThrown !== null || pgExport !== fileExport;
    assert.ok(red, "a one-byte deviation must turn the equivalence gate red");
    if (witnessThrown) {
      assert.equal(witnessThrown.reasonCode, "WORKSPACE_EVENT_CORRUPT", "deviation refused by chain validation");
    }
  } finally {
    await deviatedPg.close();
    await fileFixture.close();
    await pgFixture.close();
  }
});

// Rebuild the root array shape from a workspace fixture path.
async function fixtureRoots(workspace) {
  const base = workspace.slice(0, workspace.lastIndexOf("/"));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  return kinds.map((kind) => ({ kind, path: join(base, kind) }));
}
