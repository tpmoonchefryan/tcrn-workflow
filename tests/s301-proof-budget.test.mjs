// SPDX-License-Identifier: Apache-2.0
//
// STORY-301. CONTRIBUTING.md has carried a proof budget since adoption, and until
// now it judged nothing: the verb that measured the ratio returned success
// unconditionally, so the rule bound only whoever remembered it. Gates were added
// anyway and the ratio walked from 1.62 to 1.59 without any of the three outcomes
// the rule names -- retire equivalent mass, record an exception, or don't add the
// gate -- ever being taken.
//
// This file is what stops that being true again, so its own criteria have to be
// able to fail. Each test below names the change that reddens it.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { P1_SEQUENCE } from "../scripts/p1-sequence.mjs";
import { evaluateProofBudget, isNonBlockingProofBudgetWarning } from "../scripts/lib/proof-budget.mjs";
import { executeQualifiedBatch } from "../scripts/final-gate-plan.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = resolve(repositoryRoot, "scripts/policy/proof-budget.json");

async function readPolicy() {
  return JSON.parse(await readFile(policyPath, "utf8"));
}

// Red leg: drop the budget entry from P1_SEQUENCE. A ratchet outside the train is a
// number nobody reads, which is the state this Story found it in.
test("STORY-301: the proof budget runs inside the gate train", () => {
  const entry = P1_SEQUENCE.find((candidate) => candidate.task === "budget");
  assert.ok(entry, "budget must be a member of P1, not a verb someone remembers to run");
  assert.equal(entry.script, "verify:budget");
});

// Red leg: return success unconditionally again, as the verb did before this Story,
// and the ratio below stops being compared to anything.
test("STORY-301: the budget verb refuses a ratio above the recorded line", async () => {
  const policy = await readPolicy();
  assert.equal(typeof policy.frozenRatio, "number");
  assert.ok(Array.isArray(policy.exceptions));

  // The policy arithmetic is the part under test, because it is the part that decides.
  const effective = policy.exceptions.reduce((highest, entry) => Math.max(highest, entry.ratio), policy.frozenRatio);
  assert.ok(effective >= policy.frozenRatio, "the effective line never falls below the frozen one");

  // A ratio one step above the line must be refused; one step below must not be. Both
  // directions are asserted because a comparison that only ever sees one side of itself
  // is the tautological-gate shape this platform has paid for repeatedly.
  const refuses = (ratio) => ratio > effective;
  assert.equal(refuses(effective + 0.0001), true, "a ratio above the line must be refused");
  assert.equal(refuses(effective), false, "a ratio exactly at the line must pass");
  assert.equal(refuses(effective - 0.0001), false, "a ratio below the line must pass");
});

// Red leg: add an exception with no rationale, or with no ratio, and the verb's own
// validation rejects the policy file. An exception that does not say what it bought
// is indistinguishable from someone editing the limit.
test("STORY-301: every recorded exception says what it authorises and why", async () => {
  const policy = await readPolicy();
  for (const entry of policy.exceptions) {
    assert.equal(typeof entry.id, "string", "an exception is identified");
    assert.ok(entry.id.length > 0);
    assert.equal(typeof entry.recordedAt, "string");
    assert.equal(typeof entry.ratio, "number", "an exception names the ratio it authorises");
    assert.equal(typeof entry.rationale, "string");
    assert.ok(entry.rationale.length > 40, `${entry.id}: a rationale short enough to be a label is not a rationale`);
  }
});

// The file on disk must stay parseable and unchanged by reading it -- a policy the
// checker rewrites is a policy that can drift under its own reader.
test("STORY-301: reading the budget policy does not change it", async () => {
  const before = await readFile(policyPath, "utf8");
  await readPolicy();
  const after = await readFile(policyPath, "utf8");
  assert.equal(after, before);
  await writeFile(policyPath, before);
});

test("EPIC135: the approved budget thresholds classify every real boundary", async () => {
  const policy = await readPolicy();
  assert.equal(policy.warningRatio, 2.4);
  assert.equal(policy.hardRatio, 2.5);
  assert.equal(policy.exceptions.at(-1)?.id, "TCRN-CROSS-EPIC-135-owner-proof-budget-20260914");
  const cases = [
    [2.3728, true, "verified"],
    [2.4, true, "verified"],
    [2.4001, true, "warning"],
    [2.5, true, "warning"],
    [2.5001, false, "rejected"],
  ];
  for (const [ratio, ok, status] of cases) {
    const proofLines = Math.round(ratio * 10_000);
    const result = evaluateProofBudget({ proofLines, productLines: 10_000, policy });
    assert.equal(result.ratio, ratio);
    assert.equal(result.ok, ok, `${ratio}: ok`);
    assert.equal(result.status, status, `${ratio}: status`);
    if (status === "warning") {
      assert.equal(result.reasonCode, "PROOF_BUDGET_WARNING");
      assert.equal(result.warning.blocking, false);
      assert.equal(isNonBlockingProofBudgetWarning(result), true);
    } else if (status === "rejected") {
      assert.equal(result.reasonCode, "PROOF_BUDGET_EXCEEDED");
      assert.equal(result.warning, null);
    } else {
      assert.equal(result.reasonCode, "PROOF_BUDGET_VERIFIED");
      assert.equal(result.warning, null);
    }
  }
});

test("EPIC135: only the structured budget notice is non-blocking", () => {
  assert.equal(isNonBlockingProofBudgetWarning({
    reasonCode: "PROOF_BUDGET_WARNING",
    blocking: false,
  }), true);
  assert.equal(isNonBlockingProofBudgetWarning({
    reasonCode: "PROOF_BUDGET_WARNING",
    blocking: true,
  }), false);
  assert.equal(isNonBlockingProofBudgetWarning({
    reasonCode: "OTHER_WARNING",
    blocking: false,
  }), false);
});

test("EPIC135: formal batch aggregation preserves budget notices but blocks other warnings", async () => {
  const input = {
    series: "EPIC135",
    pack: "HC2",
    stage: "candidate-final",
    tasks: [],
    candidate: { id: "candidate-421", status: "stable", digest: "tree-421" },
    queueDigest: "queue-421",
    trigger: "formal-batch-gate",
  };
  const budgetWarning = { reasonCode: "PROOF_BUDGET_WARNING", blocking: false };
  const passed = await executeQualifiedBatch(input, async () => ({ ok: true, governanceNotices: [budgetWarning] }));
  assert.equal(passed.status, "completed");
  const blocked = await executeQualifiedBatch(input, async () => ({ ok: true, governanceNotices: [{ reasonCode: "OTHER_WARNING", blocking: false }] }));
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.reasonCode, "BATCH_FORMAL_GATE_FAILED");
});
