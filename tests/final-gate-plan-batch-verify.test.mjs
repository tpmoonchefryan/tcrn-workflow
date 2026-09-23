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
import * as finalGatePlan from "../scripts/final-gate-plan.mjs";
import * as telemetryCore from "../dist/build/packages/core/src/telemetry.js";

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

// TCRN-CROSS-STORY-452 R1 (SUB-225): the verify channel's self-check comes from the batch
// entry's own verify emitter, in a mode that runs no gate and writes no verify record. Red
// leg: no self-check mode, or one that writes a passing verify record instead.
test("STORY-452 SUB-225: the batch verify emitter self-checks the verify channel without running a gate", async (context) => {
  const fixture = await workspace("batch-verify-self-check");
  context.after(() => rm(fixture.base, { recursive: true, force: true }));
  const state = await materializeWorkspace(fixture.root);
  const transient = activeBinding(state.metadata).find((entry) => entry.kind === "transient").path;
  for (const expected of ["TELEMETRY_SELF_CHECK_RECORDED", "TELEMETRY_SELF_CHECK_ALREADY_RECORDED"]) {
    const receipt = await finalGatePlan.emitBatchVerifyTelemetry?.({ root: transient, sessionId: "self-check-session", selfCheck: { host: "claude" } });
    assert.equal(receipt?.reasonCode, expected, "one ok self-check per session, UTC day and channel");
  }
  assert.deepEqual(await nonBoundaryVerifyRecords(fixture), [], "a self-check is not a verify record");
  const checks = (await readTelemetryRecords(transient, { kind: "collector-self-check", limit: 10 })).records;
  assert.equal(checks.length, 1);
  assert.deepEqual({ ...checks[0].payload }, { source: "final-gate-plan:batch-verify", channel: "verify", host: "claude", verdict: "ok", reasonCode: null, availability: "available" });
  const reading = (await telemetryCore.readObservationChannelDays(transient, checks[0].at.slice(0, 10))).channels.find((entry) => entry.channel === "verify");
  assert.equal(reading.reading, "observed-zero");
});
