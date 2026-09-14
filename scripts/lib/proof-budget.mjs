// SPDX-License-Identifier: Apache-2.0

// The proof-to-product budget is one policy with two distinct outcomes above the
// historical frozen line: a bounded, non-blocking warning and a hard candidate
// release refusal.  Keep the arithmetic here so the report command, push gate,
// and formal-batch consumers all read the same policy fields and use the same
// four-decimal/raw-LF contract.

export const PROOF_BUDGET_WARNING_REASON = "PROOF_BUDGET_WARNING";
export const PROOF_BUDGET_EXCEEDED_REASON = "PROOF_BUDGET_EXCEEDED";
export const PROOF_BUDGET_VERIFIED_REASON = "PROOF_BUDGET_VERIFIED";

function policyError(detail) {
  const error = new Error(detail);
  error.reasonCode = "PROOF_BUDGET_POLICY_INVALID";
  return error;
}

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw policyError(name);
  return value;
}

/**
 * Read the policy's structured warning/hard thresholds and validate the
 * historical exception ledger.  `hardRatio` is the repository-wide ceiling;
 * exception entries may explain a raise up to that ceiling but cannot silently
 * authorize a higher one.
 */
export function proofBudgetThresholds(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw policyError("policy");
  const frozenRatio = finiteNumber(policy.frozenRatio, "frozenRatio");
  if (!Array.isArray(policy.exceptions)) throw policyError("exceptions");
  for (const entry of policy.exceptions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw policyError("exception entry");
    if (typeof entry.id !== "string" || entry.id.length === 0) throw policyError("exception id");
    if (typeof entry.recordedAt !== "string" || entry.recordedAt.length === 0) throw policyError(`${entry.id}: recordedAt`);
    if (typeof entry.rationale !== "string" || entry.rationale.length === 0) throw policyError(`${entry.id}: rationale`);
    finiteNumber(entry.ratio, `${entry.id}: ratio`);
  }
  const exceptionHighWater = policy.exceptions.reduce((highest, entry) => Math.max(highest, entry.ratio), frozenRatio);
  const warningRatio = finiteNumber(policy.warningRatio, "warningRatio");
  const hardRatio = finiteNumber(policy.hardRatio, "hardRatio");
  if (warningRatio < frozenRatio || hardRatio < warningRatio || exceptionHighWater > hardRatio) {
    throw policyError("threshold ordering");
  }
  return Object.freeze({ frozenRatio, warningRatio, hardRatio, exceptionHighWater });
}

/** Count and classify one measured proof/product pair using the policy. */
export function evaluateProofBudget({ proofLines, productLines, policy } = {}) {
  if (!Number.isSafeInteger(proofLines) || proofLines < 0) throw policyError("proofLines");
  if (!Number.isSafeInteger(productLines) || productLines < 0) throw policyError("productLines");
  const thresholds = proofBudgetThresholds(policy);
  const ratio = productLines === 0 ? 0 : Number((proofLines / productLines).toFixed(4));
  const base = {
    proofLines,
    productLines,
    ratio,
    frozenRatio: thresholds.frozenRatio,
    warningRatio: thresholds.warningRatio,
    hardRatio: thresholds.hardRatio,
    effectiveRatio: thresholds.hardRatio,
    exceptions: policy.exceptions.length,
  };
  if (ratio > thresholds.hardRatio) {
    return {
      ...base,
      ok: false,
      status: "rejected",
      reasonCode: PROOF_BUDGET_EXCEEDED_REASON,
      error: `proof-to-product ratio ${String(ratio)} exceeds the hard line ${String(thresholds.hardRatio)}`,
      warning: null,
    };
  }
  if (ratio > thresholds.warningRatio) {
    return {
      ...base,
      ok: true,
      status: "warning",
      reasonCode: PROOF_BUDGET_WARNING_REASON,
      warning: {
        schemaVersion: "tcrn.proof-budget-warning.v1",
        reasonCode: PROOF_BUDGET_WARNING_REASON,
        severity: "warning",
        blocking: false,
        ratio,
        threshold: thresholds.warningRatio,
        hardLimit: thresholds.hardRatio,
        scope: "bounded-batch-stage",
      },
    };
  }
  return {
    ...base,
    ok: true,
    status: "verified",
    reasonCode: PROOF_BUDGET_VERIFIED_REASON,
    warning: null,
  };
}

/**
 * A push-gate child may carry this exact structured notice through P1.  It is
 * intentionally narrow: callers must prove the notice is the budget command's
 * non-blocking result before exempting the generic warnings-as-failure scan.
 */
export function isNonBlockingProofBudgetWarning(value) {
  const warning = value?.warning && typeof value.warning === "object" ? value.warning : value;
  return warning && typeof warning === "object" && !Array.isArray(warning)
    && warning.reasonCode === PROOF_BUDGET_WARNING_REASON
    && warning.blocking === false;
}
