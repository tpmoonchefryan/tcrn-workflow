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
  transitionWork,
  withStorageBackendFactory,
} from "../../../dist/build/packages/core/src/index.js";
import {
  executeMigration,
  verifyMigration,
} from "../../../dist/build/packages/core/src/index.js";
import { PgBackend } from "../../../dist/build/packages/pg-backend/src/index.js";

const CONNECTION = process.env.TCRN_PG_TEST_CONNECTION
  ?? "postgresql://history-user@198.51.100.1:5432/tcrn_governance";
const SCHEMA = "chain_cross";
const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

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
    const options = { backend: () => pg, storeBackend: undefined };
    await executeMigration(workspace, "pg", options);
    const verified = await verifyMigration(workspace, "pg", options);
    assert.equal(verified.ok, true, `verify must pass despite layout difference: ${verified.reasonCode}`);
  } finally {
    await pg.close();
    await rm(base, { recursive: true, force: true });
  }
});
