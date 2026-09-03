// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-266 — every push-gate phase is accounted for without changing stdout.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const timingPath = resolve(repositoryRoot, "dist/evidence/p1/push-gate-timing.json");
const expectedStages = [
  ["git-status-before", 122],
  ["version-badge-and-cjk-emphasis", 137],
  ["stale-version-prose", 165],
  ["failure-pattern-register", 183],
  ["status-version-prose", 223],
  ["translation-mirror-pins", 239],
  ["host-evidence-freshness", 285],
  ["release-prose", 313],
  ["tag-ancestry", 340],
  ["child:verify:p1", 358],
  ["child:verify:p8", 358],
  ["child:guard-check", 358],
  ["git-status-after", 367],
];

test("INC-266 push-gate timing accounts for every phase and keeps the success output contract", async () => {
  const evidence = JSON.parse(await readFile(timingPath, "utf8"));
  assert.equal(evidence.schemaVersion, "tcrn.push-gate-timing.v1");
  assert.equal(evidence.command, "node scripts/push-gate.mjs");
  assert.equal(evidence.ok, true);
  const source = await readFile(resolve(repositoryRoot, "scripts/push-gate.mjs"));
  assert.equal(evidence.sourceDigest, createHash("sha256").update(source).digest("hex"));
  assert.equal(evidence.stdoutContract, JSON.stringify({ ok: true, reasonCode: "PUSH_GATE_VERIFIED", version: "1.0.1" }));
  assert.deepEqual(evidence.stages.map(({ name, line }) => [name, line]), expectedStages);
  assert.ok(evidence.stages.every(({ elapsedMs }) => Number.isFinite(elapsedMs) && elapsedMs >= 0));
  const stageTotalMs = evidence.stages.reduce((sum, stage) => sum + stage.elapsedMs, 0);
  assert.ok(Math.abs(stageTotalMs - evidence.stageTotalMs) < 0.01);
  assert.ok(Math.abs(evidence.attributionGapMs) < 5_000, `timing attribution gap ${evidence.attributionGapMs}ms must be below 5s`);
  assert.equal(evidence.attributionGapMs, Number((evidence.gateElapsedMs - evidence.stageTotalMs).toFixed(3)));
});
