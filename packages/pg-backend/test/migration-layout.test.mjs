// SPDX-License-Identifier: Apache-2.0
// STORY-189 regression: verify must be per-event, not per-segment.
//
// The file backend segments by segmentEventLimit (here 2, forcing multiple file
// segments) while the PG backend uses its own limit — the SAME event history
// lands in different segment layouts. compareSnapshots must compare per-event
// (eventHash), not per-segment bytes, or verify reds on layout alone.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before } from "node:test";

import {
  acquireWorkspaceLease,
  createProject,
  createWork,
  initializeWorkspace,
  materializeWorkspace,
  transitionWork,
  withStorageBackendFactory,
} from "../../../dist/build/packages/core/src/index.js";
import {
  executeMigration,
  verifyMigration,
} from "../../../dist/build/packages/core/src/index.js";
import { PgBackend } from "../../../dist/build/packages/pg-backend/src/index.js";
import { pgTestConnection } from "../../../scripts/pg-test-connection.mjs";

const CONNECTION = pgTestConnection();
const SCHEMA = process.env.TCRN_PG_TEST_SCHEMA ?? "chain_test_cross";
const instant = (second) => `2026-07-11T00:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;

before(async () => {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: CONNECTION });
  await client.connect();
  await client.query(`truncate ${SCHEMA}.events, ${SCHEMA}.metadata, ${SCHEMA}.views, ${SCHEMA}.knowledge_marker, ${SCHEMA}.knowledge_metadata, ${SCHEMA}.knowledge_bodies, ${SCHEMA}.knowledge_views, ${SCHEMA}.artifact_marker, ${SCHEMA}.artifact_records`);
  await client.end();
});

test("STORY-189: verify passes when file and PG segment layouts differ (per-event compare)", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s189-")));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  // segmentEventLimit=2 forces multiple file segments (4 events → 2 segments),
  // while the PG backend uses a different limit → different layout.
  await initializeWorkspace({ roots, externalKey: "WORKSPACE-S189", createdAt: instant(0), segmentEventLimit: 2 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  try {
    let state = await createProject(workspace, lease, { expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-S189", name: "P" });
    state = await createWork(workspace, lease, { expectedVersion: 1, occurredAt: instant(2), projectId: state.projects[0].id, externalKey: "INIT-S189", kind: "Initiative", parentId: null });
    const workId = state.work[0].id;
    state = await transitionWork(workspace, lease, { expectedVersion: 2, occurredAt: instant(3), id: workId, status: "ready" });
    state = await transitionWork(workspace, lease, { expectedVersion: 3, occurredAt: instant(4), id: workId, status: "active" });
  } finally {
    await lease.release();
  }

  const pg = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
  await pg.connect();
  try {
    const options = { backend: () => pg, storeBackend: undefined, schema: SCHEMA, migratedAt: "2026-08-07T00:00:00Z" };
    await executeMigration(workspace, "pg", options);
    const verified = await verifyMigration(workspace, "pg", options);
    assert.equal(verified.ok, true, `verify must pass despite layout difference: ${verified.reasonCode}`);
  } finally {
    await pg.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("STORY-189: PG backend respects the workspace segmentEventLimit (large-chain layout)", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s189b-")));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  // segmentEventLimit=64, 70 events → 2 file segments; a 1024-limit PG backend
  // would put all 70 in one segment and (past 1 MiB) exceed canonical bounds.
  await initializeWorkspace({ roots, externalKey: "WORKSPACE-S189B", createdAt: instant(0), segmentEventLimit: 64 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  try {
    let state = await createProject(workspace, lease, { expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-S189B", name: "P" });
    const projectId = state.projects[0].id;
    const keys = [];
    // 70 events total: a fresh Initiative + its ready transition each round.
    for (let i = 0; i < 35; i++) {
      const key = `INIT-S189B-${String(i).padStart(2, "0")}`;
      state = await createWork(workspace, lease, { expectedVersion: state.version, occurredAt: instant(2 + i * 2), projectId, externalKey: key, kind: "Initiative", parentId: null });
      keys.push(key);
      const fresh = state.work.find((record) => record.externalKey === key);
      assert.ok(fresh, `work ${key} must exist`);
      state = await transitionWork(workspace, lease, { expectedVersion: state.version, occurredAt: instant(3 + i * 2), id: fresh.id, status: "ready" });
    }
  } finally {
    await lease.release();
  }
  const before = await materializeWorkspace(workspace);
  assert.ok(before.version >= 70, `expected >=70 events, got ${before.version}`);

  const pg = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
  await pg.connect();
  // Isolate from the previous test's migration in the dedicated test schema;
  // the schema still holds events + metadata, which would trip the bypass-copy
  // probe without this explicit clear.
  await pg.clearForTest();
  try {
    const options = { backend: () => pg, storeBackend: undefined, schema: SCHEMA, migratedAt: "2026-08-07T00:00:00Z" };
    await executeMigration(workspace, "pg", options);
    // PG should read segments in the workspace's 64-event layout.
    const pgSegmentNames = await pg.listSegmentNames();
    assert.ok(pgSegmentNames.length >= 2, `expected multiple PG segments, got ${pgSegmentNames.length}`);
    const verified = await verifyMigration(workspace, "pg", options);
    assert.equal(verified.ok, true, `verify must pass for the large chain: ${verified.reasonCode}`);
  } finally {
    await pg.close();
    await rm(base, { recursive: true, force: true });
  }
});
