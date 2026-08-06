// SPDX-License-Identifier: Apache-2.0
// STORY-178 — the file↔pg bidirectional migration verb family.
//
// Positive leg: a scratch file chain (with a knowledge store and an artifact
// store) is planned, executed to PG, verified green, rolled back to file, and
// verified green again — the round trip, byte-equivalent on every STORY-176
// criterion. Red leg: tampering one PG event's payload_hash (the append-only
// trigger is disabled for the single tamper, then re-enabled) makes verify red.
// Bypass refusal: a PG target that already holds a different chain is refused
// by both execute and verify with WORKSPACE_MIGRATION_FUTURE.
//
// Runs against the local Docker PG (tcrn-postgres); CI supplies an equivalent
// PG the same way. This test is in the pg-backend package so `pg` resolves.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import {
  acquireWorkspaceLease,
  createKnowledgeUnit,
  createProject,
  createWork,
  executeMigration,
  initializeArtifactStore,
  initializeKnowledgeStore,
  initializeWorkspace,
  planMigration,
  rollbackMigration,
  transitionWork,
  updateProject,
  verifyMigration,
} from "../../../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../../../dist/build/packages/protocol/src/index.js";
import { PgBackend, PgStoreBackend } from "../../../dist/build/packages/pg-backend/src/index.js";

const CONNECTION = process.env.TCRN_PG_TEST_CONNECTION
  ?? "postgresql://history-user@198.51.100.1:5432/tcrn_governance";
const SCHEMA = "chain_cross";

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

async function clearAllPgTables() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: CONNECTION });
  await client.connect();
  try {
    await client.query(
      `truncate ${SCHEMA}.events, ${SCHEMA}.metadata, ${SCHEMA}.views, ` +
      `${SCHEMA}.knowledge_marker, ${SCHEMA}.knowledge_metadata, ${SCHEMA}.knowledge_bodies, ` +
      `${SCHEMA}.knowledge_views, ${SCHEMA}.artifact_marker, ${SCHEMA}.artifact_records`,
    );
  } finally {
    await client.end();
  }
}

beforeEach(clearAllPgTables);

async function workspaceFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s178-")));
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

function fixtureRoots(workspace) {
  const base = workspace.slice(0, workspace.lastIndexOf("/"));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  return kinds.map((kind) => ({ kind, path: join(base, kind) }));
}

// Build a scratch chain with four events (one segment, segmentEventLimit 4) and
// return the project/work records a knowledge unit can reference.
async function buildChain(workspace, externalKey, keyPrefix) {
  await initializeWorkspace({ roots: fixtureRoots(workspace), externalKey, createdAt: instant(0), segmentEventLimit: 4 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  try {
    let state = await createProject(workspace, lease, {
      expectedVersion: 0, occurredAt: instant(1), externalKey: `PROJECT-${keyPrefix}`, name: "Alpha",
    });
    state = await updateProject(workspace, lease, {
      expectedVersion: 1, occurredAt: instant(2), id: state.projects[0].id, name: "Beta",
    });
    const projectId = state.projects[0].id;
    state = await createWork(workspace, lease, {
      expectedVersion: 2, occurredAt: instant(3), projectId, externalKey: `INIT-${keyPrefix}`, kind: "Initiative", parentId: null,
    });
    const workId = state.work[0].id;
    state = await transitionWork(workspace, lease, {
      expectedVersion: 3, occurredAt: instant(4), id: workId, status: "ready",
    });
    return { projectId, workId, version: state.version, headEventHash: state.headEventHash };
  } finally {
    await lease.release();
  }
}

// Seed a knowledge unit on the file side so the migration moves marker,
// metadata, body, and view across the backend boundary.
async function seedKnowledgeUnit(workspace, projectId, workId) {
  const owner = deriveStableId("owner", "MIGRATION-OWNER");
  return createKnowledgeUnit(workspace, {
    expectedVersion: 0,
    occurredAt: instant(6),
    externalKey: "MIGRATION-UNIT",
    scope: "project",
    projectId,
    roleScopes: [],
    category: "implementation",
    kind: "guide",
    tags: ["knowledge", "migration"],
    subject: "Migration subject",
    summary: "Migration summary",
    snippet: "Migration snippet",
    accountableOwnerId: owner,
    sourceReferences: ["evidence://fixture/migration-unit"],
    sourceDigest: canonicalSha256({ key: "MIGRATION-UNIT", source: "current-explicit" }),
    linkedWorkIds: [workId],
    linkedDecisionIds: [deriveStableId("decision", "MIGRATION-DECISION")],
    linkedGateIds: [deriveStableId("gate", "MIGRATION-GATE")],
    linkedEvidenceIds: [deriveStableId("evidence", "MIGRATION-EVIDENCE")],
    lifecycle: "active",
    retrievalDisposition: "default",
    freshnessState: "fresh",
    lastVerified: instant(5),
    stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only",
    body: "Migration body",
  });
}

function migrationOptions(pg, pgStore) {
  return { backend: () => pg, storeBackend: () => pgStore };
}

test("STORY-178 positive leg: file→pg→file round trip verifies green", async () => {
  const fixture = await workspaceFixture();
  const pg = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
  const pgStore = new PgStoreBackend({ schema: SCHEMA, connection: CONNECTION });
  await pg.connect();
  await pgStore.connect();
  try {
    const chain = await buildChain(fixture.workspace, "FIXTURE-MIGRATION", "MIG");
    await initializeKnowledgeStore(fixture.workspace);
    await seedKnowledgeUnit(fixture.workspace, chain.projectId, chain.workId);
    await initializeArtifactStore(fixture.workspace, { disposable: true });

    const plan = await planMigration(fixture.workspace, "pg", migrationOptions(pg, pgStore));
    assert.equal(plan.schemaVersion, "tcrn.workspace-migration-plan.v1");
    assert.equal(plan.direction, "pg", "plan direction is the target");
    assert.equal(plan.source, "file", "default source is the file track");
    assert.equal(plan.eventCount, 4, "plan event count");
    assert.equal(plan.version, 4, "plan version");
    assert.equal(plan.headEventHash, chain.headEventHash, "plan head matches the chain head");
    assert.ok(plan.steps.length >= 2, "plan carries steps");

    const executed = await executeMigration(fixture.workspace, "pg", migrationOptions(pg, pgStore));
    assert.equal(executed.eventCount, 4, "execute event count");

    const verified = await verifyMigration(fixture.workspace, "pg", migrationOptions(pg, pgStore));
    assert.equal(verified.ok, true, "verify after execute must be green");
    assert.equal(verified.reasonCode, "WORKSPACE_MIGRATION_VERIFIED");
    assert.equal(verified.eventCount, 4);
    assert.equal(verified.headEventHash, chain.headEventHash);

    // A second execute over the identical target is an idempotent re-run, not a bypass.
    await executeMigration(fixture.workspace, "pg", migrationOptions(pg, pgStore));

    const rolled = await rollbackMigration(fixture.workspace, migrationOptions(pg, pgStore));
    assert.equal(rolled.direction, "file", "rollback targets the file track");
    assert.equal(rolled.source, "pg", "rollback reads the migrated side");

    const reverted = await verifyMigration(fixture.workspace, "file", migrationOptions(pg, pgStore));
    assert.equal(reverted.ok, true, "verify after rollback must be green");
    assert.equal(reverted.eventCount, 4);
  } finally {
    await pg.close();
    await pgStore.close();
    await fixture.close();
  }
});

test("STORY-178 red leg: a tampered PG payload_hash turns verify red", async () => {
  const fixture = await workspaceFixture();
  const pg = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
  const pgStore = new PgStoreBackend({ schema: SCHEMA, connection: CONNECTION });
  await pg.connect();
  await pgStore.connect();
  try {
    await buildChain(fixture.workspace, "FIXTURE-REDLEG", "RED");
    await executeMigration(fixture.workspace, "pg", migrationOptions(pg, pgStore));

    // Tamper one event's payload_hash in the PG target. The append-only trigger
    // would refuse a byte-changing UPDATE, so it is disabled for the single
    // tamper and re-enabled immediately afterwards.
    const { default: pgDriver } = await import("pg");
    const raw = new pgDriver.Client({ connectionString: CONNECTION });
    await raw.connect();
    try {
      await raw.query(`alter table ${SCHEMA}.events disable trigger events_append_only`);
      const { rows } = await raw.query(`select payload_hash from ${SCHEMA}.events where sequence = 2`);
      const current = rows[0].payload_hash;
      const flipped = current.startsWith("f") ? `e${current.slice(1)}` : `f${current.slice(1)}`;
      await raw.query(`update ${SCHEMA}.events set payload_hash = $1 where sequence = 2`, [flipped]);
    } finally {
      await raw.query(`alter table ${SCHEMA}.events enable trigger events_append_only`).catch(() => {});
      await raw.end();
    }

    const result = await verifyMigration(fixture.workspace, "pg", migrationOptions(pg, pgStore));
    assert.equal(result.ok, false, "a tampered target must verify red");
    assert.equal(result.eventCount, 4);
  } finally {
    await pg.close();
    await pgStore.close();
    await fixture.close();
  }
});

test("STORY-178 bypass refusal: a PG target holding a different chain is refused by execute and verify", async () => {
  const first = await workspaceFixture();
  const second = await workspaceFixture();
  const pg = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
  const pgStore = new PgStoreBackend({ schema: SCHEMA, connection: CONNECTION });
  await pg.connect();
  await pgStore.connect();
  try {
    // Seed PG with a legitimate migrated chain.
    await buildChain(first.workspace, "FIXTURE-BYPASS-FIRST", "B1");
    await executeMigration(first.workspace, "pg", migrationOptions(pg, pgStore));

    // A different file chain now targets the same (already populated) PG side.
    await buildChain(second.workspace, "FIXTURE-BYPASS-SECOND", "B2");
    await assert.rejects(
      executeMigration(second.workspace, "pg", migrationOptions(pg, pgStore)),
      (error) => error?.reasonCode === "WORKSPACE_MIGRATION_FUTURE",
      "execute must refuse a divergent target",
    );
    await assert.rejects(
      verifyMigration(second.workspace, "pg", migrationOptions(pg, pgStore)),
      (error) => error?.reasonCode === "WORKSPACE_MIGRATION_FUTURE",
      "verify must refuse a divergent target",
    );
  } finally {
    await pg.close();
    await pgStore.close();
    await first.close();
    await second.close();
  }
});
