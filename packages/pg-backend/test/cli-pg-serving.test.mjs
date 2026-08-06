// SPDX-License-Identifier: Apache-2.0
// STORY-189 switch window: when the facade serves a PG-backed chain it sets
// TCRN_PG_CONNECTION + TCRN_PG_SCHEMA, and every engine CLI verb that touches a
// workspace must then read that chain from Postgres instead of the file tree.
// This test builds a scratch file chain, migrates it to PG, and asserts the
// `status` verb reads the PG head when the env is set — and the file head when
// it is not.

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
} from "../../../dist/build/packages/core/src/index.js";
import { executeMigration } from "../../../dist/build/packages/core/src/index.js";
import { PgBackend } from "../../../dist/build/packages/pg-backend/src/index.js";
import { runCli } from "../../../dist/build/packages/cli/src/index.js";

const CONNECTION = process.env.TCRN_PG_TEST_CONNECTION
  ?? "postgresql://history-user@198.51.100.1:5432/tcrn_governance";
const SCHEMA = "chain_cross";
const instant = (second) => `2026-07-11T00:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;

before(async () => {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: CONNECTION });
  await client.connect();
  await client.query(`truncate ${SCHEMA}.events, ${SCHEMA}.metadata, ${SCHEMA}.views, ${SCHEMA}.knowledge_marker, ${SCHEMA}.knowledge_metadata, ${SCHEMA}.knowledge_bodies, ${SCHEMA}.knowledge_views, ${SCHEMA}.artifact_marker, ${SCHEMA}.artifact_records`);
  await client.end();
});

test("STORY-189: CLI reads a PG-backed chain when TCRN_PG_* env is set", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s189c-")));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "WORKSPACE-S189C", createdAt: instant(0), segmentEventLimit: 4 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  try {
    let state = await createProject(workspace, lease, { expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-S189C", name: "P" });
    state = await createWork(workspace, lease, { expectedVersion: 1, occurredAt: instant(2), projectId: state.projects[0].id, externalKey: "INIT-S189C", kind: "Initiative", parentId: null });
    await transitionWork(workspace, lease, { expectedVersion: 2, occurredAt: instant(3), id: state.work[0].id, status: "ready" });
  } finally {
    await lease.release();
  }

  // Migrate file → PG; both sides now hold the same chain.
  const pg = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
  await pg.connect();
  await pg.clearForTest();
  try {
    await executeMigration(workspace, "pg", { backend: () => pg, storeBackend: undefined });
  } finally {
    await pg.close();
  }

  const fileHead = (await statusVia(workspace, {})).headEventHash;
  const pgHead = (await statusVia(workspace, {
    TCRN_PG_CONNECTION: CONNECTION,
    TCRN_PG_SCHEMA: SCHEMA,
  })).headEventHash;
  assert.equal(typeof fileHead, "string");
  assert.equal(pgHead, fileHead, "PG-backed status must report the same head as the file chain");
  await rm(base, { recursive: true, force: true });
});

test("STORY-189: migration verbs run correctly with TCRN_PG_* set (explicit backends win over the wrap)", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s189d-")));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "WORKSPACE-S189D", createdAt: instant(0), segmentEventLimit: 4 });

  const pg = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
  await pg.connect();
  await pg.clearForTest();
  await pg.close();

  // Drive the migration verb family through the CLI with the env set: the wrap
  // must not arm a different backend, and execute/verify must still use their
  // explicit PG target.
  const env = { TCRN_PG_CONNECTION: CONNECTION, TCRN_PG_SCHEMA: SCHEMA };
  const execute = JSON.parse(await runCliAndCapture(["migration-execute", "--workspace", workspace, "--to", "pg"], env));
  assert.equal(execute.eventCount, 0, "scratch chain has zero events after init only");
  const verify = JSON.parse(await runCliAndCapture(["migration-verify", "--workspace", workspace, "--to", "pg"], env));
  assert.equal(verify.reasonCode, "WORKSPACE_MIGRATION_VERIFIED");
  await rm(base, { recursive: true, force: true });
});

async function statusVia(workspace, env) {
  const out = await runCliAndCapture(["status", "--workspace", workspace], env);
  return JSON.parse(out);
}

async function runCliAndCapture(args, env) {
  const saved = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    let out = "";
    await runCli(args, { write: (value) => { out += value; } });
    return out;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
