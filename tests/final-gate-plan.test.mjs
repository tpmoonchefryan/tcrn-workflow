// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-433 — production terminal replay and bounded rerun diagnosis.
import assert from "node:assert/strict";
import test from "node:test";
import { executeQualifiedBatch, qualifyBatch } from "../scripts/final-gate-plan.mjs";

const INPUTS = { sourceDigest: "source-433", environmentDigest: "environment-433", commandDigest: "command-433", baselineDigest: "baseline-433" };

function batchInput(overrides = {}) {
  return { ...INPUTS, series: "EPIC135", pack: "CHAIN-NATIVE", stage: "candidate-final", tasks: [], candidate: { id: "candidate-421", status: "stable", digest: "tree-421" }, queueDigest: "queue-421", trigger: "formal-batch-gate", ...overrides };
}

test("433 replays retained production terminal output and rejects an inner failure behind exit 0", async () => {
  const passedCapture = { ok: true, status: "completed", exitCode: 0, signal: null, stdout: JSON.stringify({ ok: true, status: "passed", exitCode: 0 }), stderr: "" };
  const passed = await executeQualifiedBatch(batchInput(), async () => passedCapture);
  assert.equal(passed.status, "completed");
  const innerFailure = { ...passedCapture, stdout: JSON.stringify({ ok: true, status: "completed", childResults: [{ assessment: { ok: false, reasonCode: "P1_DIAGNOSTIC_PRESENT" } }] }) };
  const rejected = await executeQualifiedBatch(batchInput(), async () => innerFailure);
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.reasonCode, "GATE_PLAN_TERMINAL_EVIDENCE_INVALID");
});

test("433 does not blindly rerun the same failed batch, but an explicit rerun marker does", async () => {
  const base = batchInput();
  const idempotencyKey = qualifyBatch(base).idempotencyKey;
  const prior = { id: "run-433-1", gateId: "gate-433", idempotencyKey, status: "failed", ok: false, reasonCode: "GATE_PLAN_TERMINAL_EVIDENCE_INVALID", inputs: INPUTS, stdout: "captured inner failure", stderr: "", exitCode: 0, signal: null };
  const input = batchInput({ gateId: "gate-433", previousRuns: [prior], lastError: { reasonCode: "GATE_PLAN_TERMINAL_EVIDENCE_INVALID" } });
  let calls = 0;
  const skipped = await executeQualifiedBatch(input, async () => {
    calls += 1;
    return { ok: true };
  });
  assert.equal(calls, 0);
  assert.equal(skipped.status, "failed");
  assert.equal(skipped.reasonCode, "BATCH_PRIOR_FAILURE_UNCHANGED");
  assert.equal(skipped.diagnostic.rerunAllowed, false);
  assert.match(skipped.diagnostic.nextAction, /stdout\/stderr\/exit\/signal/u);

  const rerun = await executeQualifiedBatch({ ...input, forceRerun: true }, async () => {
    calls += 1;
    return { ok: true };
  });
  assert.equal(calls, 1);
  assert.equal(rerun.status, "completed");
});
