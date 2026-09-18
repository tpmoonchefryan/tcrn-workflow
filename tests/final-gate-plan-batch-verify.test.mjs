// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activeBinding,
  initializeWorkspace,
  materializeWorkspace,
  readTelemetryRecords,
} from "../dist/build/packages/core/src/index.js";
import { executeQualifiedBatch, qualifyBatch } from "../scripts/final-gate-plan.mjs";

const createdAt = "2026-08-19T18:00:00Z";
const boundaryPrefix = "telemetry:observation-collector:";

async function workspace(key) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-batch-verify-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: key, createdAt, segmentEventLimit: 64 });
  return { base, root: join(base, "workspace") };
}

function batchInput(workspaceRoot) {
  return {
    ...(workspaceRoot === undefined ? {} : { workspace: workspaceRoot }),
    series: "EPIC135",
    pack: "CHAIN-NATIVE",
    stage: "candidate-final",
    tasks: [],
    candidate: { id: "candidate-421", status: "stable", digest: "tree-421" },
    queueDigest: "queue-421",
    trigger: "formal-batch-gate",
  };
}

async function nonBoundaryVerifyRecords(fixture) {
  const state = await materializeWorkspace(fixture.root);
  const transient = activeBinding(state.metadata).find((entry) => entry.kind === "transient");
  assert.ok(transient);
  const read = await readTelemetryRecords(transient.path, { kind: "verify", limit: Number.MAX_SAFE_INTEGER, preserveOrder: true });
  return read.records.filter((record) => typeof record.payload?.source === "string" && !record.payload.source.startsWith(boundaryPrefix));
}

test("successful qualified batch writes one real verify telemetry record", async (context) => {
  const fixture = await workspace("batch-verify-pass");
  context.after(() => rm(fixture.base, { recursive: true, force: true }));

  const result = await executeQualifiedBatch(batchInput(fixture.root), async () => ({ ok: true }));

  assert.equal(result.status, "completed");
  const records = await nonBoundaryVerifyRecords(fixture);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "verify");
  assert.equal(records[0].payload.source.startsWith(boundaryPrefix), false);
  assert.equal(records[0].payload.source, "final-gate-plan:batch-verify");
  assert.equal(records[0].payload.availability, "available");
  assert.equal(records[0].payload.passed, true);
});

test("failed formal runner does not write verify telemetry", async (context) => {
  const fixture = await workspace("batch-verify-fail");
  context.after(() => rm(fixture.base, { recursive: true, force: true }));

  const result = await executeQualifiedBatch(batchInput(fixture.root), async () => ({ ok: false, reasonCode: "X" }));

  assert.equal(result.status, "failed");
  assert.equal(result.reasonCode, "X");
  assert.equal((await nonBoundaryVerifyRecords(fixture)).length, 0);
});

test("post-execution recheck failure does not write verify telemetry", async (context) => {
  const fixture = await workspace("batch-verify-recheck");
  context.after(() => rm(fixture.base, { recursive: true, force: true }));
  const input = batchInput(fixture.root);
  const qualified = qualifyBatch(input);
  let rechecks = 0;

  // This case pins the emitter after the post-execution recheck: moving the call
  // above that block would leave a verify record despite this invalidation.
  const result = await executeQualifiedBatch(input, async () => ({ ok: true }), {
    recheck: async () => {
      rechecks += 1;
      return rechecks === 1 ? qualified : { ...qualified, status: "not-ready", eligible: false, formalGateAllowed: false };
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reasonCode, "BATCH_RECHECK_NOT_ELIGIBLE");
  assert.equal((await nonBoundaryVerifyRecords(fixture)).length, 0);
});

test("missing or unusable workspace leaves the qualified batch result unchanged", async () => {
  const missing = await executeQualifiedBatch(batchInput(), async () => ({ ok: true }));
  assert.equal(missing.status, "completed");
  assert.equal(missing.reasonCode, "BATCH_FORMAL_GATE_COMPLETED");

  const nonexistent = await executeQualifiedBatch(
    batchInput(join(tmpdir(), `tcrn-batch-verify-missing-${process.pid}-${Date.now()}`)),
    async () => ({ ok: true }),
  );
  assert.equal(nonexistent.status, "completed");
  assert.equal(nonexistent.reasonCode, "BATCH_FORMAL_GATE_COMPLETED");
});
