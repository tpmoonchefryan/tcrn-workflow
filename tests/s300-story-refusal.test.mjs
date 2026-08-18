// SPDX-License-Identifier: Apache-2.0
//
// STORY-300, Wave 1.4. A refusal names the remedy.
//
// The Story scope validator has always known exactly what it wanted -- ten blocks
// in one order, four purpose anchors matched as literal tokens, an ordered
// GIVEN/WHEN/THEN or a bullet list, and two token-shape checks -- and said almost
// none of it. The message was the problem list joined by semicolons: which block
// was missing, never what the full set is; that the Goal lacked anchors, never
// which ones or that they are matched as tokens rather than by meaning.
//
// Two audited sessions were measured reading this module's source to learn a
// contract the module already held, nine days apart, and each of two ceremonies
// spent eight rounds on that class of discovery. Chain-related refusals over the
// audited week ran 242 against 132 successful writes.
//
// These criteria are what stop the message going quiet again.

import assert from "node:assert/strict";
import test from "node:test";

import { STORY_SCOPE_HEADINGS, describeStoryScopeProblems, validateStoryScope } from "../dist/build/packages/core/src/story-scope-compliance.js";

const COMPLIANT = `## Goal
为谁:the operator. 目的锚:prove the refusal is actionable. 符合性判据:the message names the remedy. 判定人:machine-checked lane.

## Requirements
- 实现 the described behaviour.

## Acceptance Criteria
GIVEN a refusal WHEN it is read THEN it names the remedy

## Business Background
实测 evidence that the message was silent.

## Preconditions
- None.

## Assumptions
- None.

## Use Cases & Examples
- A session reads the refusal and fixes the scope.

## Feature Toggle & Setting
None.

## Permissions
None.

## Implementation Notes
新增 the description helper.`;

// Red leg: restore the semicolon join and the caller is told a block is missing
// without being told what the set of blocks is.
test("STORY-300: a refused scope is told the full block roster, in order", () => {
  const validation = validateStoryScope("## Goal\nsomething\n\n## Requirements\nx\n");
  assert.equal(validation.ok, false);
  const message = describeStoryScopeProblems(validation.problems);
  for (const heading of STORY_SCOPE_HEADINGS) {
    assert.ok(message.includes(heading), `the refusal must name ${heading}`);
  }
  // The order matters and is stated, because the validator refuses on order too.
  assert.ok(message.includes(STORY_SCOPE_HEADINGS.join(" / ")), "the roster is given in the order the validator requires");
});

// Red leg: drop the anchor branch and a Goal that reads perfectly to a human is
// refused with no way to learn that the match is on tokens.
test("STORY-300: a missing purpose anchor is told which anchors exist and that they are literal", () => {
  const validation = validateStoryScope(COMPLIANT.replace("判定人:machine-checked lane.", "decided by the machine lane."));
  assert.equal(validation.ok, false);
  const message = describeStoryScopeProblems(validation.problems);
  for (const token of ["beneficiary", "为谁", "目的锚", "符合性判据", "判定人"]) {
    assert.ok(message.includes(token), `the refusal must name the ${token} anchor`);
  }
  assert.ok(/literal token/u.test(message), "and must say the match is on the token rather than the meaning");
});

// Red leg: remove the acceptance branch and the caller learns the shape is wrong
// without learning which two shapes are accepted.
test("STORY-300: a malformed acceptance block is told both accepted shapes", () => {
  const validation = validateStoryScope(COMPLIANT.replace("GIVEN a refusal WHEN it is read THEN it names the remedy", "it should work"));
  assert.equal(validation.ok, false);
  const message = describeStoryScopeProblems(validation.problems);
  assert.ok(message.includes("GIVEN/WHEN/THEN"), "the ordered form is named");
  assert.ok(/bullet list/u.test(message), "and so is the alternative");
});

// The two token-shape checks are the least guessable thing in the contract: they
// scan for vocabulary, and nothing in the block headings hints at that. Red leg:
// drop the branch and the caller is told an element is "not mapped" with no way
// to discover what would map it.
test("STORY-300: the legacy token checks name the vocabulary they scan for", () => {
  const validation = validateStoryScope(COMPLIANT.replace("实测 evidence that the message was silent.", "Background.").replace("- 实现 the described behaviour.", "- Do it.").replace("新增 the description helper.", "Notes."));
  assert.equal(validation.ok, false);
  const message = describeStoryScopeProblems(validation.problems);
  assert.ok(message.includes("evidence"), "the evidence vocabulary is named");
  assert.ok(message.includes("implement") || message.includes("deliver"), "the fix-item vocabulary is named");
  // And the honest limit is stated rather than implied.
  assert.ok(/do not judge whether what it says is true/u.test(message), "the check's own limit is stated");
});

// A compliant scope must still pass unchanged: the point was a better refusal,
// not a looser contract. Red leg: relax any heading or anchor rule and this stops
// being the only thing that passes.
test("STORY-300: the contract itself is unchanged -- a compliant scope still passes", () => {
  const validation = validateStoryScope(COMPLIANT);
  assert.deepEqual(validation.problems, []);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.sections.map((section) => section.heading), [...STORY_SCOPE_HEADINGS]);
});
