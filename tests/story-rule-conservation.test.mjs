// SPDX-License-Identifier: Apache-2.0

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { readStoryRuleRegistry, verifyStoryRuleConservation } from "../scripts/story-rule-conservation.mjs";

describe("STORY-209 source to new-rule conservation", () => {
  test("every named legacy source and rule has a live landing and both legs", () => {
    const result = verifyStoryRuleConservation(readStoryRuleRegistry());
    assert.deepEqual(result, { ok: true, reasonCode: "STORY_RULE_CONSERVATION_VERIFIED", problems: [] });
  });

  test("deleting one mapping is a named red leg", () => {
    const registry = readStoryRuleRegistry();
    registry.rules = registry.rules.filter((rule) => rule.id !== "DISPATCH-LEGACY-001");
    const result = verifyStoryRuleConservation(registry);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes("DISPATCH-LEGACY-001")));
  });

  test("a rule without a red leg cannot be silently accepted", () => {
    const registry = readStoryRuleRegistry();
    registry.rules = registry.rules.map((rule) => rule.id === "STORY-TEMPLATE-001" ? { ...rule, redLeg: "" } : rule);
    const result = verifyStoryRuleConservation(registry);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes("STORY-TEMPLATE-001 missing redLeg")));
  });

  test("a superseded rule must prove that the replacement is stricter", () => {
    const registry = readStoryRuleRegistry();
    registry.rules = registry.rules.map((rule) => rule.id === "STORY-TEMPLATE-001" ? { ...rule, strictnessProof: "" } : rule);
    const result = verifyStoryRuleConservation(registry);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes("STORY-TEMPLATE-001 superseded-by-stricter rule needs strictnessProof")));
  });
});
