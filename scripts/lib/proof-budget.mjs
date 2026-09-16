// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The proof-to-product budget is one policy with two distinct outcomes above the
// historical frozen line: a bounded, non-blocking warning and a hard candidate
// release refusal.  Keep the arithmetic here so the report command, push gate,
// and formal-batch consumers all read the same policy fields and use the same
// four-decimal/raw-LF contract.

export const PROOF_BUDGET_WARNING_REASON = "PROOF_BUDGET_WARNING";
export const PROOF_BUDGET_EXCEEDED_REASON = "PROOF_BUDGET_EXCEEDED";
export const PROOF_BUDGET_VERIFIED_REASON = "PROOF_BUDGET_VERIFIED";
export const PROOF_BUDGET_SCOPED_NONBLOCKING_REASON = "PROOF_BUDGET_EXCEEDED_SCOPED_NONBLOCKING";
export const PROOF_BUDGET_SCOPE_BINDING_ENV = "TCRN_PROOF_BUDGET_SCOPE_BINDING_SHA256";

const APPROVED_SCOPE_BINDING_SHA256 = "97f50959e960e34adc431964f8cf46b1b5700ae47c4b38c274fc27165ab75e49";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalText(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function defaultPolicy() {
  try {
    return JSON.parse(readFileSync(new URL("../policy/proof-budget.json", import.meta.url), "utf8"));
  } catch {
    return null;
  }
}

function policyError(detail) {
  const error = new Error(detail);
  error.reasonCode = "PROOF_BUDGET_POLICY_INVALID";
  return error;
}

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw policyError(name);
  return value;
}

function configuredScopeBinding(policy) {
  const disposition = policy?.ratioPolicy?.scopedDisposition;
  if (disposition === undefined) return null;
  if (!disposition || typeof disposition !== "object" || Array.isArray(disposition)
    || disposition.schemaVersion !== "tcrn.proof-budget-scoped-disposition.v1"
    || typeof disposition.reasonCode !== "string" || disposition.reasonCode !== PROOF_BUDGET_SCOPED_NONBLOCKING_REASON
    || disposition.disposition !== "nonblocking-ratio-only"
    || typeof disposition.bindingSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(disposition.bindingSha256)) {
    throw policyError("scopedDisposition");
  }
  const binding = disposition.binding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)
    || binding.schemaVersion !== "tcrn.proof-budget-scope-binding.v1"
    || typeof binding.scopeId !== "string" || binding.scopeId.length === 0
    || !binding.authority || typeof binding.authority !== "object" || Array.isArray(binding.authority)
    || !Array.isArray(binding.allowedWork) || binding.allowedWork.length === 0
    || !Array.isArray(binding.excludedWork)
    || !binding.currentExecution || typeof binding.currentExecution !== "object" || Array.isArray(binding.currentExecution)) {
    throw policyError("scopedDisposition.binding");
  }
  const allowedKeys = new Set();
  const allowedIds = new Set();
  for (const work of binding.allowedWork) {
    if (!work || typeof work !== "object" || Array.isArray(work)
      || typeof work.externalKey !== "string" || !/^TCRN-CROSS-STORY-[0-9]+$/u.test(work.externalKey)
      || typeof work.id !== "string" || !/^work:[a-f0-9]{24}$/u.test(work.id)
      || allowedKeys.has(work.externalKey) || allowedIds.has(work.id)) {
      throw policyError("scopedDisposition.allowedWork");
    }
    allowedKeys.add(work.externalKey);
    allowedIds.add(work.id);
  }
  const excludedIds = new Set();
  for (const work of binding.excludedWork) {
    if (!work || typeof work !== "object" || Array.isArray(work)
      || typeof work.externalKey !== "string" || !/^TCRN-CROSS-STORY-[0-9]+$/u.test(work.externalKey)
      || typeof work.id !== "string" || !/^work:[a-f0-9]{24}$/u.test(work.id)
      || allowedKeys.has(work.externalKey) || allowedIds.has(work.id) || excludedIds.has(work.id)) {
      throw policyError("scopedDisposition.excludedWork");
    }
    excludedIds.add(work.id);
  }
  const execution = binding.currentExecution;
  const primary = execution.primaryWork;
  const dispatch = execution.dispatch;
  if (!primary || typeof primary !== "object" || Array.isArray(primary)
    || !allowedWorkMatches(binding.allowedWork, primary.externalKey, primary.id)
    || !Number.isSafeInteger(primary.revision) || primary.revision < 1
    || typeof primary.scopeDigest !== "string" || !/^[a-f0-9]{64}$/u.test(primary.scopeDigest)
    || execution.bindingKind !== "governed-task-role"
    || execution.role !== "implementation" || execution.personaProfileId !== null
    || execution.phase !== "rework" || execution.taskClass !== "implement"
    || execution.pack !== "INC320/RECEIPT-JSON-FREEZE-R3"
    || !/^[a-f0-9]{64}$/u.test(execution.activePackBriefSha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(execution.technicalPackSha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(execution.roleBindingAmendmentSha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(execution.serialPackRecordSha256 ?? "")
    || !Array.isArray(execution.workIds) || execution.workIds.length === 0
    || execution.workIds.some((id) => typeof id !== "string" || !allowedIds.has(id))
    || new Set(execution.workIds).size !== execution.workIds.length
    || execution.workIds.length !== binding.allowedWork.length
    || binding.allowedWork.some((work) => !execution.workIds.includes(work.id))
    || !dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)
    || dispatch.workspaceId !== binding.workspaceId || dispatch.workspaceVersion !== 6379
    || dispatch.headEventHash !== "583946c834a9c7bf98df12472d0caf0726a7e083f3ee42c8f71fac1e2de3447b"
    || dispatch.configDigest !== "c64d5248a2580243fd301485a3afc4629d2dccd1f928a3d527d6fd1f3d00f91f"
    || dispatch.host !== "codex" || dispatch.mode !== "frontier" || dispatch.resolutionInput !== "implement"
    || dispatch.model !== "gpt-5.6-luna" || dispatch.effort !== "max" || dispatch.forkTurns !== "none"
    || !dispatch.primaryWorkAtSpawn || dispatch.primaryWorkAtSpawn.externalKey !== primary.externalKey
    || dispatch.primaryWorkAtSpawn.id !== primary.id || dispatch.primaryWorkAtSpawn.revision !== 5
    || dispatch.primaryWorkAtSpawn.scopeDigest !== "b87572224ba58f10c78b916a15af72acc78d524ab1a4f123533012434fb1746c"
    || dispatch.primaryWorkAtSpawn.status !== "active"
    || !/^[a-f0-9]{64}$/u.test(execution.bindingSha256 ?? "")) {
    throw policyError("scopedDisposition.currentExecution");
  }
  if (execution.workIds.includes(excludedIds.values().next().value)) throw policyError("scopedDisposition.excludedWorkExecution");
  const executionForDigest = { ...execution };
  delete executionForDigest.bindingSha256;
  if (sha256(canonicalText(executionForDigest)) !== execution.bindingSha256) throw policyError("scopedDisposition.currentExecution.bindingSha256");
  const bindingSha256 = sha256(canonicalText(binding));
  if (bindingSha256 !== disposition.bindingSha256 || bindingSha256 !== APPROVED_SCOPE_BINDING_SHA256) {
    throw policyError("scopedDisposition.bindingSha256");
  }
  return { disposition, binding, bindingSha256, executionSha256: execution.bindingSha256 };
}

function allowedWorkMatches(work, externalKey, id) {
  return work.some((entry) => entry?.externalKey === externalKey && entry?.id === id);
}

/** Digest of the single code-owned execution binding accepted by production budget consumers. */
export function proofBudgetScopeBindingDigest(policy) {
  return configuredScopeBinding(policy)?.executionSha256 ?? null;
}

/** Digest the immutable scope authorization; useful for archive readback and policy tests. */
export function proofBudgetScopePolicyDigest(policy) {
  return configuredScopeBinding(policy)?.bindingSha256 ?? null;
}

/** A batch caller must carry the exact code-owned scope object, not an INIT prefix or a self-selected work list. */
export function validateProofBudgetScopeBinding(value, policy = defaultPolicy()) {
  let configured;
  try {
    configured = configuredScopeBinding(policy);
  } catch (error) {
    return { ok: false, reasonCode: error?.reasonCode ?? "PROOF_BUDGET_POLICY_INVALID" };
  }
  if (!configured || !value || typeof value !== "object" || Array.isArray(value)
    || canonicalText(value) !== canonicalText(configured.binding)) {
    return { ok: false, reasonCode: "PROOF_BUDGET_SCOPE_BINDING_INVALID" };
  }
  return { ok: true, reasonCode: "PROOF_BUDGET_SCOPE_BINDING_VERIFIED", bindingSha256: configured.bindingSha256, executionSha256: configured.executionSha256 };
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
  if (policy.ratioPolicy !== undefined) {
    const ratioPolicy = policy.ratioPolicy;
    const expectedScope = ratioPolicy?.schemaVersion === "tcrn.proof-budget-ratio-policy.v1"
      ? "repository-wide persistent global max"
      : "repository-wide hard line with one explicit, current-work-bound nonblocking disposition";
    if (!ratioPolicy || typeof ratioPolicy !== "object" || Array.isArray(ratioPolicy)
      || !["tcrn.proof-budget-ratio-policy.v1", "tcrn.proof-budget-ratio-policy.v2"].includes(ratioPolicy.schemaVersion)
      || ratioPolicy.scope !== expectedScope
      || ratioPolicy.evaluationBoundary !== "bounded-batch-stage"
      || ratioPolicy.review !== "series-end"
      || !ratioPolicy.warning || ratioPolicy.warning.reasonCode !== PROOF_BUDGET_WARNING_REASON || ratioPolicy.warning.blocking !== false
      || !ratioPolicy.hard || ratioPolicy.hard.reasonCode !== PROOF_BUDGET_EXCEEDED_REASON || ratioPolicy.hard.blocking !== true) {
      throw policyError("ratioPolicy");
    }
    if (ratioPolicy.schemaVersion === "tcrn.proof-budget-ratio-policy.v1" && ratioPolicy.scopedDisposition !== undefined) {
      throw policyError("ratioPolicy.scopedDisposition requires v2");
    }
    if (ratioPolicy.schemaVersion === "tcrn.proof-budget-ratio-policy.v2") {
      if (ratioPolicy.scopedDisposition === undefined) throw policyError("ratioPolicy.scopedDisposition");
      configuredScopeBinding(policy);
    }
  }
  return Object.freeze({ frozenRatio, warningRatio, hardRatio, exceptionHighWater });
}

/** Count and classify one measured proof/product pair using the policy. */
export function evaluateProofBudget({ proofLines, productLines, policy, scopeBindingSha256 } = {}) {
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
    const configured = configuredScopeBinding(policy);
    const authorizedBinding = configured !== null && scopeBindingSha256 === configured.executionSha256;
    if (authorizedBinding) {
      const warning = {
        schemaVersion: "tcrn.proof-budget-scoped-disposition.v1",
        reasonCode: configured.disposition.reasonCode,
        rawReasonCode: PROOF_BUDGET_EXCEEDED_REASON,
        rawStatus: "exceeded",
        severity: "warning",
        blocking: false,
        disposition: configured.disposition.disposition,
        ratio,
        threshold: thresholds.hardRatio,
        hardLimit: thresholds.hardRatio,
        scopeId: configured.binding.scopeId,
        scopePolicySha256: configured.bindingSha256,
        scopeBindingSha256: configured.executionSha256,
        scopeBinding: configured.binding,
      };
      return {
        ...base,
        ok: true,
        status: "exceeded-nonblocking",
        reasonCode: configured.disposition.reasonCode,
        rawStatus: "exceeded",
        rawReasonCode: PROOF_BUDGET_EXCEEDED_REASON,
        blocking: false,
        error: null,
        scopeDisposition: {
          status: "nonblocking",
          reasonCode: configured.disposition.reasonCode,
          scopeId: configured.binding.scopeId,
          scopePolicySha256: configured.bindingSha256,
          scopeBindingSha256: configured.executionSha256,
        },
        warning,
      };
    }
    return {
      ...base,
      ok: false,
      status: "rejected",
      reasonCode: PROOF_BUDGET_EXCEEDED_REASON,
      rawStatus: "exceeded",
      rawReasonCode: PROOF_BUDGET_EXCEEDED_REASON,
      blocking: true,
      error: `proof-to-product ratio ${String(ratio)} exceeds the hard line ${String(thresholds.hardRatio)}`,
      warning: null,
      ...(scopeBindingSha256 === undefined || scopeBindingSha256 === null
        ? { scopeDisposition: { status: "not-requested", reasonCode: "PROOF_BUDGET_SCOPE_BINDING_REQUIRED" } }
        : { scopeDisposition: { status: "rejected", reasonCode: "PROOF_BUDGET_SCOPE_BINDING_INVALID" } }),
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
export function isNonBlockingProofBudgetWarning(value, { policy = defaultPolicy(), scopeBindingSha256 = process.env[PROOF_BUDGET_SCOPE_BINDING_ENV] } = {}) {
  const warning = value?.warning && typeof value.warning === "object" ? value.warning : value;
  if (!warning || typeof warning !== "object" || Array.isArray(warning) || warning.blocking !== false) return false;
  if (warning.reasonCode === PROOF_BUDGET_WARNING_REASON) {
    let thresholds;
    try { thresholds = proofBudgetThresholds(policy); } catch { return false; }
    return warning.schemaVersion === "tcrn.proof-budget-warning.v1"
      && warning.severity === "warning"
      && warning.scope === "bounded-batch-stage"
      && Number.isFinite(warning.ratio)
      && warning.ratio > thresholds.warningRatio
      && warning.ratio <= thresholds.hardRatio
      && warning.threshold === thresholds.warningRatio
      && warning.hardLimit === thresholds.hardRatio;
  }
  if (warning.reasonCode !== PROOF_BUDGET_SCOPED_NONBLOCKING_REASON) return false;
  let configured;
  try { configured = configuredScopeBinding(policy); } catch { return false; }
  return configured !== null
    && warning.schemaVersion === "tcrn.proof-budget-scoped-disposition.v1"
    && warning.rawReasonCode === PROOF_BUDGET_EXCEEDED_REASON
    && warning.rawStatus === "exceeded"
    && warning.severity === "warning"
    && warning.disposition === configured.disposition.disposition
    && Number.isFinite(warning.ratio) && warning.ratio > policy.hardRatio
    && warning.threshold === policy.hardRatio
    && warning.hardLimit === policy.hardRatio
    && warning.scopeId === configured.binding.scopeId
    && warning.scopePolicySha256 === configured.bindingSha256
    && warning.scopeBindingSha256 === configured.executionSha256
    && scopeBindingSha256 === configured.executionSha256
    && canonicalText(warning.scopeBinding) === canonicalText(configured.binding);
}
