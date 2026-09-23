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
export const PROOF_BUDGET_SCOPE_BINDING_SCHEMA = "tcrn.proof-budget-scope-binding.v1";
export const PROOF_RESPONSIBILITY_VIEW_SCHEMA = "tcrn.proof-budget.responsibility-view.v1";
export const PROOF_RESPONSIBILITY_COUNT_SCHEMA = "tcrn.proof-budget.responsibility-count.v1";
export const PROOF_RESPONSIBILITIES = Object.freeze(["runtime-function", "test", "verification-tool"]);

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

const STABLE_AUTHORITY_FIELDS = Object.freeze([
  "ratioDecisionMinutesId",
  "ratioOwnerAuthorizationSha256",
  "executionCorrectionMinutesId",
  "executionCorrectionOwnerAuthorizationSha256",
  "chainNativeDecisionMinutesId",
]);

function stableAuthority(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw policyError("scopedDisposition.binding.authority");
  const actual = Object.keys(value).sort();
  const expected = [...STABLE_AUTHORITY_FIELDS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw policyError("scopedDisposition.binding.authority.fields");
  for (const field of STABLE_AUTHORITY_FIELDS) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0 || value[field].includes("\u0000")) {
      throw policyError(`scopedDisposition.binding.authority.${field}`);
    }
    if (field.endsWith("Sha256") && !/^[a-f0-9]{64}$/u.test(value[field])) {
      throw policyError(`scopedDisposition.binding.authority.${field}`);
    }
    if (field.endsWith("MinutesId") && !/^minutes:[a-f0-9]{24}$/u.test(value[field])) {
      throw policyError(`scopedDisposition.binding.authority.${field}`);
    }
  }
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
    || binding.schemaVersion !== PROOF_BUDGET_SCOPE_BINDING_SCHEMA
    || typeof binding.scopeId !== "string" || binding.scopeId.length === 0
    || typeof binding.workspaceId !== "string" || !/^workspace:[a-f0-9]{24}$/u.test(binding.workspaceId)
    || !Array.isArray(binding.allowedWork) || binding.allowedWork.length === 0
    || !Array.isArray(binding.excludedWork)) {
    throw policyError("scopedDisposition.binding");
  }
  const bindingKeys = Object.keys(binding).sort();
  if (JSON.stringify(bindingKeys) !== JSON.stringify(["allowedWork", "authority", "excludedWork", "schemaVersion", "scopeId", "workspaceId"])) {
    throw policyError("scopedDisposition.binding.fields");
  }
  stableAuthority(binding.authority);
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
  const excludedKeys = new Set();
  const excludedIds = new Set();
  for (const work of binding.excludedWork) {
    if (!work || typeof work !== "object" || Array.isArray(work)
      || typeof work.externalKey !== "string" || !/^TCRN-CROSS-STORY-[0-9]+$/u.test(work.externalKey)
      || typeof work.id !== "string" || !/^work:[a-f0-9]{24}$/u.test(work.id)
      || allowedKeys.has(work.externalKey) || allowedIds.has(work.id)
      || excludedKeys.has(work.externalKey) || excludedIds.has(work.id)) {
      throw policyError("scopedDisposition.excludedWork");
    }
    excludedKeys.add(work.externalKey);
    excludedIds.add(work.id);
  }
  if (!excludedKeys.has("TCRN-CROSS-STORY-431")) throw policyError("scopedDisposition.excludedWork.431");
  const bindingSha256 = sha256(canonicalText(binding));
  if (bindingSha256 !== disposition.bindingSha256) throw policyError("scopedDisposition.bindingSha256");
  return { disposition, binding, bindingSha256 };
}

/** Digest of the finite code-owned authorization accepted by production budget consumers. */
export function proofBudgetScopeBindingDigest(policy) {
  return configuredScopeBinding(policy)?.bindingSha256 ?? null;
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
  return { ok: true, reasonCode: "PROOF_BUDGET_SCOPE_BINDING_VERIFIED", bindingSha256: configured.bindingSha256 };
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
      : "repository-wide hard line with one explicit, finite-work-authorized nonblocking disposition";
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
    const authorizedBinding = configured !== null && scopeBindingSha256 === configured.bindingSha256;
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
        scopeBindingSha256: configured.bindingSha256,
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
          scopeBindingSha256: configured.bindingSha256,
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
export function isNonBlockingProofBudgetWarning(value, { policy = defaultPolicy(), scopeBindingSha256 = null } = {}) {
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
    && warning.scopeBindingSha256 === configured.bindingSha256
    && scopeBindingSha256 === configured.bindingSha256
    && canonicalText(warning.scopeBinding) === canonicalText(configured.binding);
}

// TCRN-CROSS-STORY-462 (rebuilding TCRN-CROSS-SUB-116). A view beside the raw count, never in
// place of it: reportBudget's proof files are classified by what each one does -- runtime
// function, test, or verification tool -- as policy.responsibilityView records it. A file with
// more than one responsibility is counted once under `mixed` with all of them named; a file
// the view does not name is `unknown` and listed. Nothing here is a cap, a threshold, or an
// approval request, and the ratio verdict above never reads it.
// docs/verification/proof-responsibility.md states the basis.
function responsibilityList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => PROOF_RESPONSIBILITIES.includes(entry)) && new Set(value).size === value.length;
}

/** Problems that keep a responsibility view from classifying; an empty list means it can. */
export function proofResponsibilityViewProblems(view) {
  if (!view || typeof view !== "object" || Array.isArray(view)) return ["responsibilityView is missing"];
  const problems = [];
  if (view.schemaVersion !== PROOF_RESPONSIBILITY_VIEW_SCHEMA) problems.push("responsibilityView.schemaVersion");
  if (typeof view.document !== "string" || !/^docs\/[A-Za-z0-9./_-]+\.md$/u.test(view.document)) problems.push("responsibilityView.document");
  if (JSON.stringify(view.responsibilities) !== JSON.stringify(PROOF_RESPONSIBILITIES)) problems.push("responsibilityView.responsibilities");
  const named = new Set();
  const name = (path, where) => {
    if (typeof path !== "string" || !/^(?:scripts|tests)\/[A-Za-z0-9./_-]+\.mjs$/u.test(path)) problems.push(`${where}: ${String(path)}`);
    else if (named.has(path)) problems.push(`${where}: ${path} is named twice`);
    named.add(path);
  };
  if (!Array.isArray(view.prefixes) || view.prefixes.some((rule) => typeof rule?.prefix !== "string" || !/^(?:scripts|tests)\/(?:[A-Za-z0-9._-]+\/)*$/u.test(rule.prefix) || !PROOF_RESPONSIBILITIES.includes(rule?.responsibility))) {
    problems.push("responsibilityView.prefixes");
  }
  if (!view.classes || typeof view.classes !== "object" || Array.isArray(view.classes)
    || JSON.stringify(Object.keys(view.classes).sort()) !== JSON.stringify([...PROOF_RESPONSIBILITIES])) {
    problems.push("responsibilityView.classes");
  } else {
    for (const responsibility of PROOF_RESPONSIBILITIES) {
      if (!Array.isArray(view.classes[responsibility])) problems.push(`responsibilityView.classes.${responsibility}`);
      else for (const path of view.classes[responsibility]) name(path, `responsibilityView.classes.${responsibility}`);
    }
  }
  if (!view.mixed || typeof view.mixed !== "object" || Array.isArray(view.mixed)) {
    problems.push("responsibilityView.mixed");
  } else {
    for (const [path, responsibilities] of Object.entries(view.mixed)) {
      name(path, "responsibilityView.mixed");
      if (!responsibilityList(responsibilities) || responsibilities.length < 2) problems.push(`responsibilityView.mixed: ${path} must name two or more responsibilities`);
    }
  }
  const cost = view.costBaseline;
  if (!cost || typeof cost !== "object" || Array.isArray(cost) || Object.keys(cost).length === 0) problems.push("responsibilityView.costBaseline");
  else for (const [field, value] of Object.entries(cost)) {
    // No measured baseline exists; a number here would be a claim nothing measured.
    if (value !== "unknown") problems.push(`responsibilityView.costBaseline.${field} must stay unknown until measured`);
  }
  return problems;
}

/** Classify [{path, lines}] proof files; the raw proofLines is their plain sum either way. */
export function classifyProofResponsibility(files, view) {
  const rows = (Array.isArray(files) ? files : []).filter((row) => typeof row?.path === "string" && Number.isSafeInteger(row.lines) && row.lines >= 0);
  const proofLines = rows.reduce((total, row) => total + row.lines, 0);
  const problems = proofResponsibilityViewProblems(view);
  if (problems.length > 0) {
    return { schemaVersion: PROOF_RESPONSIBILITY_COUNT_SCHEMA, status: "invalid", reasonCode: "PROOF_RESPONSIBILITY_VIEW_INVALID", proofLines, problems };
  }
  const assigned = new Map();
  for (const responsibility of PROOF_RESPONSIBILITIES) for (const path of view.classes[responsibility]) assigned.set(path, [responsibility]);
  for (const [path, responsibilities] of Object.entries(view.mixed)) assigned.set(path, [...responsibilities].sort());
  const byResponsibility = Object.fromEntries(PROOF_RESPONSIBILITIES.map((responsibility) => [responsibility, 0]));
  const mixed = [];
  const unknown = [];
  const seen = new Set();
  for (const row of [...rows].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
    seen.add(row.path);
    const responsibilities = assigned.get(row.path)
      ?? view.prefixes.filter((rule) => row.path.startsWith(rule.prefix)).map((rule) => [rule.responsibility])[0]
      ?? null;
    if (responsibilities === null) unknown.push({ path: row.path, lines: row.lines });
    else if (responsibilities.length > 1) mixed.push({ path: row.path, lines: row.lines, responsibilities });
    else byResponsibility[responsibilities[0]] += row.lines;
  }
  const total = (list) => list.reduce((sum, row) => sum + row.lines, 0);
  return {
    schemaVersion: PROOF_RESPONSIBILITY_COUNT_SCHEMA,
    status: "classified",
    proofLines,
    byResponsibility,
    mixed: { lines: total(mixed), files: mixed },
    unknown: { lines: total(unknown), files: unknown },
    staleEntries: [...assigned.keys()].filter((path) => !seen.has(path)).sort(),
    costBaseline: { ...view.costBaseline },
    document: view.document,
  };
}
