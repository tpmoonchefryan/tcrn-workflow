#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-020 INC-079 — test wiring gate (standalone entry point). The
// shared judgement lives in scripts/lib/test-wiring.mjs; this is the CLI face
// wired into CI's verify job. Plant an unwired test file and this reds.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { judgeTestWiring } from "./lib/test-wiring.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const result = judgeTestWiring({
  repoRoot: ROOT,
  registryPath: resolve(ROOT, "scripts/policy/test-wiring.json"),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
for (const path of result.orphaned ?? []) process.stderr.write(`  ORPHANED: ${path}\n`);
for (const p of result.problems ?? []) process.stderr.write(`  PROBLEM: ${p}\n`);
if (!result.ok) process.exitCode = 1;
