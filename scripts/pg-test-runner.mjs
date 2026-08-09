// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-INC-121 — single-entry runner for the PG backend suite.
// The offline boundary forbids shell conjunctions in package scripts, so the
// schema apply and the serial test run that `pg:test` used to chain with `&&`
// run here sequentially, with the former shell glob expanded explicitly.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = resolve(root, "packages/pg-backend/test");
const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join(testDir, name));

const steps = [
  [resolve(root, "scripts/apply-pg-test-schema.mjs")],
  ["--test", "--test-concurrency=1", ...testFiles],
];

for (const step of steps) {
  const run = spawnSync(process.execPath, step, { cwd: root, stdio: "inherit" });
  if (run.status !== 0) {
    process.exit(run.status ?? 1);
  }
}
