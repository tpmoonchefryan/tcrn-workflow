// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-261 — verification-map link shape and reverse-lookup support.

const WORK_ID = /^work:[a-f0-9]{24}$/u;
const GWT_ID = /^GWT\d+$/u;

export function validateVerificationMapLinks(map) {
  const claims = Array.isArray(map?.claims) ? map.claims : [];
  const problems = [];
  let linkedClaimCount = 0;
  for (const claim of claims) {
    if (claim === null || typeof claim !== "object" || typeof claim.id !== "string") continue;
    if (!Object.hasOwn(claim, "workId") || claim.workId === null || claim.workId === undefined) continue;
    linkedClaimCount += 1;
    if (typeof claim.workId !== "string" || !WORK_ID.test(claim.workId)) {
      problems.push(`${claim.id}: workId must be a protocol work id`);
    }
    if (!Array.isArray(claim.gwt) || claim.gwt.length === 0 || claim.gwt.some((gwt) => typeof gwt !== "string" || !GWT_ID.test(gwt))) {
      problems.push(`${claim.id}: gwt must be a non-empty list of GWT ids`);
    } else if (new Set(claim.gwt).size !== claim.gwt.length) {
      problems.push(`${claim.id}: gwt must not contain duplicates`);
    }
  }
  return {
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? "VERIFICATION_LINKS_VALID" : "VERIFICATION_LINKS_INVALID",
    linkedClaimCount,
    problems,
  };
}
