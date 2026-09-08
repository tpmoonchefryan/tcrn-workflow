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

  test("completion-link retirement remains registered with its deciding authorities", () => {
    const registry = readStoryRuleRegistry();
    const rule = registry.rules.find((entry) => entry.id === "STORY-COMPLETION-LINKS");
    assert.ok(rule);
    assert.equal(rule.disposition, "superseded-by-stricter");
    assert.deepEqual(rule.supersededBy, [
      "TCRN-CROSS-MIN-ACCEPTANCE-LANES",
      "TCRN-CROSS-MIN-172",
    ]);
    assert.ok(registry.sourceInventory.some((entry) =>
      entry.source === "chain:cross-project:TCRN-CROSS-MIN-172"
      && entry.rules.includes("STORY-COMPLETION-LINKS")));
    assert.equal(verifyStoryRuleConservation(registry).reasonCode, "STORY_RULE_CONSERVATION_VERIFIED");
  });

  test("deleting the completion-link retirement mapping is a named red leg", () => {
    const registry = readStoryRuleRegistry();
    registry.rules = registry.rules.filter((rule) => rule.id !== "STORY-COMPLETION-LINKS");
    const result = verifyStoryRuleConservation(registry);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "STORY_RULE_CONSERVATION_BROKEN");
    assert.ok(result.problems.includes(
      "chain:cross-project:TCRN-CROSS-MIN-172 maps unknown rule STORY-COMPLETION-LINKS",
    ));
  });
});
