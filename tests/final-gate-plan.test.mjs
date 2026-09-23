// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-433 — production terminal replay and bounded rerun diagnosis.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildGateImpactMap, createGateReceiptAuthority, executeQualifiedBatch, issueGateReceipt, qualifyBatch } from "../scripts/final-gate-plan.mjs";
import * as finalGatePlan from "../scripts/final-gate-plan.mjs";

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

// TCRN-CROSS-STORY-460 (SUB-237). B1: a change under specs/ had no gate mapping, so the
// dynamic plan reported unknown impact and ran nothing. Specs are an engine-release face and
// rc1 inputs, as are schemas/ and extensions/. Red leg: drop the mapping.
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINMENT = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "scripts/policy/gate-containment.json"), "utf8"));

test("STORY-460 AC2: a change to specs/ and a test selects engine-release with no unknown impact", () => {
  const impact = buildGateImpactMap({ containment: CONTAINMENT, changedFiles: ["specs/time-attestation-v1.md", "tests/inc378-attestation-repair.test.mjs"] });
  assert.deepEqual(impact.unknown, []);
  assert.deepEqual(impact.affected, ["engine-release"]);
  for (const path of ["schemas/cli-catalog-v1.schema.json", "extensions/aos-requirements-v1.json"]) {
    const other = buildGateImpactMap({ containment: CONTAINMENT, changedFiles: [path] });
    assert.deepEqual([other.unknown, other.affected], [[], ["engine-release"]], path);
  }
});

// B2: platform-doctor exits 1 while launchd is red, which the roster accepts for
// platform-layout, and the runner judged the root by exit code alone. A red root now passes
// only when every failing check carries a reason code its roster group accepts; any other red
// fails it. Red leg: take the exception judgement out and the launchd-only case fails.
const ROSTER = { groups: [{ id: "platform-layout", acceptedExceptions: [{ acceptedAt: "2026-08-15", reasonCode: "PLATFORM_LAUNCHD_NOT_ON_DUTY", reason: "OWNER_RULING_BACKUP_LAYERS_STOPPED" }] }, { id: "engine-release" }] };
const doctor = (checks) => ({ ok: false, status: 1, signal: null, stdout: `${JSON.stringify({ ok: false, checks })}\n`, stderr: "" });

test("STORY-460 AC3: a doctor root red only for a roster exception passes and names it; another red fails", () => {
  const apply = finalGatePlan.applyRosterExceptions ?? ((_id, result) => ({ result, acceptedExceptions: [] }));
  const launchdOnly = doctor([{ name: "launchd", ok: false, reasonCode: "PLATFORM_LAUNCHD_NOT_ON_DUTY" }, { name: "hooks", ok: true }]);
  const accepted = apply("platform-layout", launchdOnly, ROSTER);
  assert.equal(accepted.result.ok, true);
  assert.deepEqual(accepted.acceptedExceptions, ["PLATFORM_LAUNCHD_NOT_ON_DUTY"]);
  const twoReds = doctor([{ name: "launchd", ok: false, reasonCode: "PLATFORM_LAUNCHD_NOT_ON_DUTY" }, { name: "proofBudget", ok: false, reasonCode: "PLATFORM_PROOF_BUDGET_EXCEEDED" }]);
  assert.equal(apply("platform-layout", twoReds, ROSTER).result.ok, false);
  assert.equal(apply("engine-release", launchdOnly, ROSTER).result.ok, false, "another group's exception is not this group's");
  assert.equal(apply("platform-layout", { ...launchdOnly, stdout: "not json" }, ROSTER).result.ok, false, "an unreadable result is not an exception");

  const entry = { id: "platform-layout", command: "node scripts/platform-doctor.mjs --platform-root <container>" };
  const invocation = { executable: "node", argv: ["scripts/platform-doctor.mjs", "--platform-root", resolve(REPOSITORY_ROOT, "../..")], cwd: REPOSITORY_ROOT, command: entry.command };
  const inputs = { sourceDigest: "source-460", environmentDigest: "environment-460", commandDigest: "command-460", baselineDigest: "baseline-460" };
  const receipt = issueGateReceipt(createGateReceiptAuthority(), { entry, invocation, inputs, result: launchdOnly, roster: ROSTER });
  assert.equal(receipt.status, "completed");
  assert.deepEqual(receipt.acceptedExceptions, ["PLATFORM_LAUNCHD_NOT_ON_DUTY"]);
  assert.equal(receipt.exitCode, 1, "the exit code stays what the root returned");
  const failed = issueGateReceipt(createGateReceiptAuthority(), { entry, invocation, inputs, result: twoReds, roster: ROSTER });
  assert.equal(failed.status, "failed");
});
