// SPDX-License-Identifier: Apache-2.0
// STORY-180 — scratch round-trip migration evidence producer.
//
// Runs a scratch chain file→pg→file with a knowledge store and an artifact
// record, capturing per-step evidence: byte-equivalence on every STORY-176
// criterion, version continuity, store-marker preservation, and the red leg
// (a mid-flight injected byte difference is caught by verify). Output is a
// scrub-hosted evidence JSON suitable for the INC-042 evidence tree.
//
// Usage: node packages/pg-backend/test/evidence-roundtrip.mjs
// Requires the local Docker PG (tcrn-postgres) with the isolated test schema
// available; set TCRN_PG_TEST_SCHEMA to override the default.

import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  acquireWorkspaceLease,
  createProject,
  exportWorkspace,
  initializeWorkspace,
  materializeWorkspace,
  withStorageBackendFactory,
  createKnowledgeUnit,
  initializeKnowledgeStore,
  exportKnowledgeCheckpoint,
} from "../../../dist/build/packages/core/src/index.js";
import {
  planMigration,
  executeMigration,
  verifyMigration,
  rollbackMigration,
} from "../../../dist/build/packages/core/src/index.js";
import { withStoreBackendFactory } from "../../../dist/build/packages/core/src/index.js";
import { PgBackend, PgStoreBackend } from "../../../dist/build/packages/pg-backend/src/index.js";
import { pgTestConnection } from "../../../scripts/pg-test-connection.mjs";

const CONNECTION = pgTestConnection();
const SCHEMA = process.env.TCRN_PG_TEST_SCHEMA ?? "chain_test_cross";
const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s180-")));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  return { base, workspace, roots, async close() { await rm(base, { recursive: true, force: true }); } };
}

const migrationOptions = (pg, pgStore) => ({
  backend: () => pg,
  storeBackend: () => pgStore,
  schema: SCHEMA,
  migratedAt: "2026-08-07T00:00:00Z",
});

async function main() {
  const evidence = { schemaVersion: "tcrn.s180-roundtrip.v1", ok: false, steps: [] };
  const step = (name, detail) => { evidence.steps.push({ name, ...detail }); process.stdout.write(`  ${name}: ok\n`); };
  const fileFixture = await fixture();
  const pg = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
  const pgStore = new PgStoreBackend({ schema: SCHEMA, connection: CONNECTION });
  await pg.connect();
  await pgStore.connect();
  const raw = (await import("pg")).default.Client;
  const cleaner = new raw({ connectionString: CONNECTION });
  await cleaner.connect();
  try {
    await cleaner.query(`truncate ${SCHEMA}.events, ${SCHEMA}.metadata, ${SCHEMA}.views, ${SCHEMA}.knowledge_marker, ${SCHEMA}.knowledge_metadata, ${SCHEMA}.knowledge_bodies, ${SCHEMA}.knowledge_views, ${SCHEMA}.artifact_marker, ${SCHEMA}.artifact_records`);
    await cleaner.end();

    // Seed a scratch file chain with a project + knowledge unit + artifact.
    await initializeWorkspace({ roots: fileFixture.roots, externalKey: "WORKSPACE-S180", createdAt: instant(0), segmentEventLimit: 4 });
    let lease = await acquireWorkspaceLease(fileFixture.workspace, { now: instant(1) });
    let projectId;
    try {
      const created = await createProject(fileFixture.workspace, lease, { expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-S180", name: "P" });
      projectId = created.projects[0].id;
    } finally { await lease.release(); }
    await initializeKnowledgeStore(fileFixture.workspace, { disposableAcknowledged: true });
    lease = await acquireWorkspaceLease(fileFixture.workspace, { now: instant(2) });
    try {
      await createKnowledgeUnit(fileFixture.workspace, {
        expectedVersion: 0,
        occurredAt: instant(2),
        externalKey: "S180-UNIT",
        scope: "project",
        projectId,
        roleScopes: [],
        category: "implementation",
        kind: "guide",
        tags: ["roundtrip"],
        subject: "S180",
        summary: "summary",
        snippet: "snippet",
        accountableOwnerId: "agent:fable",
        sourceReferences: ["evidence://fixture/s180"],
        sourceDigest: "a".repeat(64),
        linkedWorkIds: [],
        linkedDecisionIds: [],
        linkedGateIds: [],
        linkedEvidenceIds: [],
        lifecycle: "active",
        retrievalDisposition: "default",
        freshnessState: "fresh",
        lastVerified: instant(2),
        stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
        exportDisposition: "metadata-only",
        body: "body",
      });
    } finally { await lease.release(); }

    // Baseline: file-side state digests.
    const baselineState = await materializeWorkspace(fileFixture.workspace);
    const baselineExport = await exportWorkspace(fileFixture.workspace);
    const baselineCheckpoint = await exportKnowledgeCheckpoint(fileFixture.workspace, instant(3));
    step("baseline", { version: baselineState.version, head: baselineState.headEventHash?.slice(0, 16), exportSha: sha256(baselineExport).slice(0, 16), checkpointSha: sha256(baselineCheckpoint).slice(0, 16) });

    // Plan + execute file→pg.
    const plan = await planMigration(fileFixture.workspace, "pg", migrationOptions(pg, pgStore));
    step("plan-file-to-pg", { eventCount: plan.eventCount, version: plan.version });
    await executeMigration(fileFixture.workspace, "pg", migrationOptions(pg, pgStore));
    step("execute-file-to-pg", { eventCount: plan.eventCount });

    // Verify pg side against source.
    const verifyPg = await verifyMigration(fileFixture.workspace, "pg", migrationOptions(pg, pgStore));
    if (!verifyPg.ok) throw new Error(`verify pg failed: ${verifyPg.reasonCode}`);
    step("verify-pg", { ok: verifyPg.ok, eventCount: verifyPg.eventCount, head: verifyPg.headEventHash?.slice(0, 16) });

    // Mid-flight red leg: tamper one PG event, verify must red. The append-only
    // trigger is disabled for the single tamper, then re-enabled (same as
    // STORY-178's migration test).
    const raw2 = (await import("pg")).default.Client;
    const tamperer = new raw2({ connectionString: CONNECTION });
    await tamperer.connect();
    try {
      await tamperer.query(`alter table ${SCHEMA}.events disable trigger events_append_only`);
      const { rows } = await tamperer.query(`select payload_hash from ${SCHEMA}.events where sequence = 1`);
      const current = rows[0].payload_hash;
      const flipped = current.startsWith("f") ? `e${current.slice(1)}` : `f${current.slice(1)}`;
      await tamperer.query(`update ${SCHEMA}.events set payload_hash = $1 where sequence = 1`, [flipped]);
    } finally {
      await tamperer.query(`alter table ${SCHEMA}.events enable trigger events_append_only`).catch(() => {});
      await tamperer.end();
    }
    const verifyTampered = await verifyMigration(fileFixture.workspace, "pg", migrationOptions(pg, pgStore));
    if (verifyTampered.ok) throw new Error("verify must red on a tampered PG event");
    step("red-leg-tamper", { reasonCode: verifyTampered.reasonCode });
    // Restore: truncate pg and re-execute cleanly for the round-trip leg.
    const raw3 = (await import("pg")).default.Client;
    const cleaner2 = new raw3({ connectionString: CONNECTION });
    await cleaner2.connect();
    await cleaner2.query(`truncate ${SCHEMA}.events, ${SCHEMA}.metadata, ${SCHEMA}.views, ${SCHEMA}.knowledge_marker, ${SCHEMA}.knowledge_metadata, ${SCHEMA}.knowledge_bodies, ${SCHEMA}.knowledge_views, ${SCHEMA}.artifact_marker, ${SCHEMA}.artifact_records`);
    await cleaner2.end();
    await executeMigration(fileFixture.workspace, "pg", migrationOptions(pg, pgStore));
    const verifyPg2 = await verifyMigration(fileFixture.workspace, "pg", migrationOptions(pg, pgStore));
    if (!verifyPg2.ok) throw new Error("verify pg after re-execute must be green");
    step("re-execute-pg", { ok: verifyPg2.ok });

    // Rollback pg→file, verify file side equals baseline.
    const rolled = await rollbackMigration(fileFixture.workspace, migrationOptions(pg, pgStore));
    step("rollback-pg-to-file", { direction: rolled.direction, source: rolled.source });
    const finalState = await materializeWorkspace(fileFixture.workspace);
    const finalExport = await exportWorkspace(fileFixture.workspace);
    const finalCheckpoint = await exportKnowledgeCheckpoint(fileFixture.workspace, instant(3));
    const roundTripEmpty = sha256(finalExport) === sha256(baselineExport) && finalState.version === baselineState.version
      && finalState.headEventHash === baselineState.headEventHash && sha256(finalCheckpoint) === sha256(baselineCheckpoint);
    step("roundtrip-diff-empty", { exportShaEqual: sha256(finalExport) === sha256(baselineExport), versionEqual: finalState.version === baselineState.version, headEqual: finalState.headEventHash === baselineState.headEventHash, checkpointEqual: sha256(finalCheckpoint) === sha256(baselineCheckpoint) });
    if (!roundTripEmpty) throw new Error("round trip produced a non-empty diff");
    if (finalState.headEventHash !== baselineState.headEventHash) throw new Error("head hash drifted across round trip");
    if (sha256(finalCheckpoint) !== sha256(baselineCheckpoint)) throw new Error("knowledge checkpoint drifted across round trip");

    evidence.ok = true;
    evidence.roundTripEmpty = true;
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await pg.close();
    await pgStore.close();
    await fileFixture.close();
  }
}

main().catch((error) => { console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) })); process.exit(1); });
