// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { DISPATCH_BRIEF_FIELDS, validateDispatchBrief } from "../scripts/dispatch-readiness-compliance.mjs";

const storyScope = [
  "Goal 为谁：Owner；目的锚：STORY-209；符合性判据：五要素可复跑；判定人：Owner。",
  "Requirements 现象与证据：命令可复跑；修复项：改造规则门。",
  "Acceptance Criteria GIVEN brief 完整 WHEN 运行门 THEN 通过。",
  "Business Background 证据：旧派工可能遗漏装备。",
  "Preconditions 无——原因：门已加载。",
  "Assumptions 无——原因：不改变链历史。",
  "Use Cases & Examples 无——原因：本单只校验派工。",
  "Feature Toggle & Setting 无——原因：不允许 bypass。",
  "Permissions Owner 负责裁定。",
  "Implementation Notes 决策状态：planned；修复项：新增校验。",
].join("\n");

const brief = Object.freeze({
  storyScope,
  redLineBoundaries: ["control tree writes go through the engine"],
  filePointers: ["packages/core/src/workspace.ts"],
  verificationCommands: ["pnpm typecheck", "pnpm test"],
  chainCloseoutActions: ["annotate evidence, transition through ceremony, and read back"],
  effectiveEvidenceCommands: ["run the deployment-position proof after the final commit"],
});

test("dispatch brief accepts all five execution elements", () => {
  const result = validateDispatchBrief(brief);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  // TCRN-CROSS-INC-232: this fixture declares no repositoryRoot, so its citations are
  // genuinely unresolved and the reason code now says which pass this is. Presence-only
  // remains a pass -- ok is still true, and that is the half of this criterion that has
  // not moved. Before the split, a brief that skipped the citation check entirely was
  // indistinguishable here from one that survived it.
  assert.equal(result.reasonCode, "DISPATCH_BRIEF_READY_CITATIONS_UNCHECKED");
  assert.equal(result.citations.checked, false);
});

test("removing each dispatch element is a stable red leg", () => {
  for (const field of DISPATCH_BRIEF_FIELDS) {
    const incomplete = { ...brief };
    delete incomplete[field];
    const result = validateDispatchBrief(incomplete);
    assert.equal(result.ok, false, field);
    assert.equal(result.reasonCode, "DISPATCH_BRIEF_INCOMPLETE", field);
    assert.ok(result.problems.some((problem) => problem.field === field), field);
  }
});

test("empty and non-string dispatch entries do not count as equipment", () => {
  const empty = validateDispatchBrief({ ...brief, filePointers: [] });
  assert.equal(empty.ok, false);
  const nonString = validateDispatchBrief({ ...brief, verificationCommands: ["pnpm test", 42] });
  assert.equal(nonString.ok, false);
  assert.ok(nonString.problems.some((problem) => problem.field === "verificationCommands"));
});

test("a dispatch brief without a compliant Story scope is refused", () => {
  const missing = validateDispatchBrief({ ...brief, storyScope: undefined });
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some((problem) => problem.field === "storyScope"));
  const invalid = validateDispatchBrief({ ...brief, storyScope: storyScope.replace(/Permissions[^\n]*/u, "Permissions") });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.problems.some((problem) => problem.field === "storyScope"));
});
