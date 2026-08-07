#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INC-086/INC-079 — provision the PG test schema without touching a production
// chain. The test suite is deliberately serial because each test file owns the
// same isolated schema and clears it at its boundary; the important invariant is
// that the schema name is never chain_cross/chain_aos (or another live chain).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pgTestConnection } from "./pg-test-connection.mjs";

// This root support script consumes the driver through the workspace package
// that owns it. Keeping the dependency there preserves the frozen dependency
// graph's direct-dependency boundary while still making a clean pnpm install
// sufficient for the root command.
const pg = createRequire(new URL("../packages/pg-backend/package.json", import.meta.url))("pg");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DDL_PATH = resolve(ROOT, "packages/pg-backend/schema/chain-ddl.sql");
const CONNECTION = pgTestConnection();
const schema = process.env.TCRN_PG_TEST_SCHEMA ?? "chain_test_cross";

if (!/^chain_test_[a-z0-9_]{1,40}$/u.test(schema)) {
  throw new Error(`TCRN_PG_TEST_SCHEMA must match chain_test_<suffix>, got ${JSON.stringify(schema)}`);
}

const source = readFileSync(DDL_PATH, "utf8");
const declarations = /create schema if not exists chain_aos;\ncreate schema if not exists chain_cross;\ncreate schema if not exists chain_ds;\ncreate schema if not exists chain_tms;\ncreate schema if not exists chain_joi;/u;
const chainArray = /array\['chain_aos','chain_cross','chain_ds','chain_tms','chain_joi'\]/gu;
const testDdl = source
  .replace(declarations, `create schema if not exists ${schema};`)
  .replace(chainArray, `array['${schema}']`);
if (!testDdl.includes(`create schema if not exists ${schema};`) || (testDdl.match(/array\['chain_test_/gu) ?? []).length !== 2) {
  throw new Error("test DDL template did not reduce to one isolated chain schema");
}

const client = new pg.Client({ connectionString: CONNECTION });
await client.connect();
try {
  await client.query(testDdl);
  process.stdout.write(`${JSON.stringify({ ok: true, reasonCode: "PG_TEST_SCHEMA_APPLIED", schema })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: "PG_TEST_SCHEMA_APPLY_FAILED", schema, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
