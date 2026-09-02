// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { verifyRedLegCoverage } from "../scripts/verification-red-legs.mjs";

const root = resolve(import.meta.dirname, "..");
const map = JSON.parse(readFileSync(resolve(root, "verification-map.yaml"), "utf8"));

test("INC-262 red-leg coverage requires every claim to be independently falsifiable", () => {
  const result = verifyRedLegCoverage(map);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.redLegCount, result.total);
  assert.equal(result.exemptionCount, 0);
  assert.deepEqual(result.uncovered, []);
});

test("INC-262 the global gate reds on a missing redLeg or an unapproved exemption", () => {
  const withoutLeg = structuredClone(map);
  const target = withoutLeg.claims.find((claim) => claim.id === "P1-CLEAN-HISTORY");
  delete target.redLeg;
  const missing = verifyRedLegCoverage(withoutLeg);
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some((problem) => problem.includes("P1-CLEAN-HISTORY: no redLeg")));

  const withoutLegWithExemption = structuredClone(map);
  const exempted = withoutLegWithExemption.claims.find((claim) => claim.id === "P1-CLEAN-HISTORY");
  delete exempted.redLeg;
  exempted.redLegExemption = { reason: "test exemption", timing: "later" };
  const exemption = verifyRedLegCoverage(withoutLegWithExemption);
  assert.equal(exemption.ok, false);
  assert.ok(exemption.problems.some((problem) => problem.includes("exemption is not approved")));
});

test("INC-262 a malformed exemption is red even when its timing is present", () => {
  const candidate = structuredClone(map);
  const target = candidate.claims.find((claim) => claim.id === "P1-CLEAN-HISTORY");
  delete target.redLeg;
  target.redLegExemption = { timing: "after source-owner review" };
  const result = verifyRedLegCoverage(candidate);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("redLegExemption.reason must be non-empty")));
});
