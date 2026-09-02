// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-262 — verification-map red-leg coverage.

const EXEMPTION_ALLOWLIST = new Set();

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function redLegProblems(claim) {
  const redLeg = claim.redLeg;
  if (redLeg === null || typeof redLeg !== "object" || Array.isArray(redLeg)) {
    return [`${claim.id}: redLeg must be an object`];
  }
  const problems = [];
  for (const field of ["mutation", "test", "expectedReasonCode"]) {
    if (!nonEmptyString(redLeg[field])) problems.push(`${claim.id}: redLeg.${field} must be a non-empty string`);
  }
  return problems;
}

function exemptionProblems(claim) {
  const exemption = claim.redLegExemption;
  if (exemption === null || typeof exemption !== "object" || Array.isArray(exemption)) {
    return [`${claim.id}: redLegExemption must be an object`];
  }
  const problems = [];
  if (!nonEmptyString(exemption.reason)) problems.push(`${claim.id}: redLegExemption.reason must be non-empty`);
  if (!nonEmptyString(exemption.timing)) problems.push(`${claim.id}: redLegExemption.timing must be non-empty`);
  if (!EXEMPTION_ALLOWLIST.has(claim.id)) problems.push(`${claim.id}: red-leg exemption is not approved for this map`);
  return problems;
}

export function verifyRedLegCoverage(map) {
  const claims = Array.isArray(map?.claims) ? map.claims : [];
  const problems = [];
  const mutationOwners = new Map();
  const testOwners = new Map();
  let redLegCount = 0;
  let exemptionCount = 0;
  for (const claim of claims) {
    if (claim === null || typeof claim !== "object" || typeof claim.id !== "string") {
      problems.push("claim must carry an id");
      continue;
    }
    const hasRedLeg = Object.hasOwn(claim, "redLeg");
    const hasExemption = Object.hasOwn(claim, "redLegExemption");
    if (hasRedLeg && hasExemption) problems.push(`${claim.id}: redLeg and redLegExemption are mutually exclusive`);
    if (!hasRedLeg && !hasExemption) {
      problems.push(`${claim.id}: no redLeg or explicit exemption`);
      continue;
    }
    if (hasRedLeg) {
      redLegCount += 1;
      problems.push(...redLegProblems(claim));
      const mutation = claim.redLeg?.mutation;
      const test = claim.redLeg?.test;
      if (nonEmptyString(mutation)) {
        const owner = mutationOwners.get(mutation);
        if (owner !== undefined) problems.push(`${claim.id}: redLeg.mutation duplicates ${owner}`);
        else mutationOwners.set(mutation, claim.id);
      }
      if (nonEmptyString(test)) {
        const owner = testOwners.get(test);
        if (owner !== undefined) problems.push(`${claim.id}: redLeg.test duplicates ${owner}`);
        else testOwners.set(test, claim.id);
      }
    } else {
      exemptionCount += 1;
      problems.push(...exemptionProblems(claim));
    }
  }
  return {
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? "RED_LEG_COVERAGE_VERIFIED" : "RED_LEG_COVERAGE_INCOMPLETE",
    total: claims.length,
    redLegCount,
    exemptionCount,
    uncovered: claims.filter((claim) => claim && !Object.hasOwn(claim, "redLeg") && !Object.hasOwn(claim, "redLegExemption")).map((claim) => claim.id),
    problems,
  };
}
