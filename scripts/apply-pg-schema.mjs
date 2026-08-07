#!/usr/bin/env node
// TCRN-CROSS-INIT-020 INC-079 — apply the chain DDL to a Postgres so the PG
// backend tests can run against a real schema + append-only trigger. CI's
// `verify-pg` job runs this after the postgres service starts; the VM applies the
// same DDL out of band. Idempotent (the DDL uses create-if-not-exists / create or
// replace function).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DDL_PATH = resolve(ROOT, "packages/pg-backend/schema/chain-ddl.sql");
const CONNECTION = process.env.TCRN_PG_TEST_CONNECTION
  ?? "postgresql://history-user@198.51.100.1:5432/tcrn_governance";

const client = new pg.Client({ connectionString: CONNECTION });
await client.connect();
try {
  await client.query(readFileSync(DDL_PATH, "utf8"));
  process.stdout.write(JSON.stringify({ ok: true, reasonCode: "PG_SCHEMA_APPLIED", ddl: DDL_PATH }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, reasonCode: "PG_SCHEMA_APPLY_FAILED", error: String(error?.message ?? error) }) + "\n");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
