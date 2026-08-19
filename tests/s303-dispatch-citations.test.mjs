// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-STORY-303. A dispatch brief must cite things that exist.
//
// The readiness gate checked that five fields were present and non-empty, which a
// single-character string satisfies. The rule it was written for is that a ticket must
// be granular enough to dispatch to an economy model without losing detail, and
// presence measures none of that: the brief that fails this rule in practice is not the
// one with an empty field, it is the one pointing at a file that has since moved and
// naming a test script that was renamed.
//
// Both are the same failure -- a citation that is not real -- and both are mechanical.
// The criteria below pin that check, and pin its honesty about what it did not check.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateDispatchBrief } from "../scripts/dispatch-readiness-compliance.mjs";

const storyScope = [
  "Goal 为谁：Owner；目的锚：STORY-303；符合性判据：引用可解析；判定人：机器判定车道。",
  "Requirements 现象与证据：存在性不等于充分性；修复项：实现引用解析。",
  "Acceptance Criteria GIVEN 一份引用不存在文件的 brief WHEN 运行门 THEN 拒绝并点名该引用。",
  "Business Background 证据：五要素齐备的 brief 仍可能让执行者去找不存在的东西。",
  "Preconditions 无——原因：校验器在链外。",
  "Assumptions 无——原因：不改变链历史。",
  "Use Cases & Examples 派工前自检一份 brief。",
  "Feature Toggle & Setting 无——原因：不允许 bypass。",
  "Permissions Owner 负责裁定。",
  "Implementation Notes 决策状态：planned；修复项：新增引用解析。",
].join("\n");

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "tcrn-s302-"));
  await mkdir(join(root, "packages"), { recursive: true });
  await writeFile(join(root, "packages", "real.ts"), "export const real = true;\n");
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", "probe.mjs"), "// probe\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", typecheck: "tsc" } }, null, 2));
  return root;
}

const briefFor = (root, overrides = {}) => ({
  storyScope,
  repositoryRoot: root,
  redLineBoundaries: ["control tree writes go through the engine"],
  filePointers: ["packages/real.ts"],
  verificationCommands: ["pnpm test"],
  chainCloseoutActions: ["annotate evidence, transition through ceremony, and read back"],
  effectiveEvidenceCommands: ["run the deployment-position proof after the final commit"],
  ...overrides,
});

// Red leg: drop unresolvedCitation and a brief pointing at a file that does not exist
// is dispatched as ready -- the executor then invents what it could not find.
test("STORY-303: a file pointer that does not resolve is refused and named", async () => {
  const root = await repository();
  try {
    assert.equal(validateDispatchBrief(briefFor(root)).ok, true, "the honest brief still passes");
    const result = validateDispatchBrief(briefFor(root, { filePointers: ["packages/real.ts", "packages/moved-away.ts"] }));
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "DISPATCH_BRIEF_INCOMPLETE");
    const problem = result.problems.find((entry) => entry.code === "DISPATCH_POINTER_UNRESOLVED");
    assert.ok(problem, "the unresolved pointer is reported");
    assert.match(problem.message, /moved-away\.ts/u, "and the message names which one");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A pointer written as file:line is the form this repository's own conventions use, so
// the suffix must not turn a real citation into a false negative. Red leg: drop the
// suffix strip and every conventionally-written pointer is reported as missing.
test("STORY-303: a file:line pointer resolves on the file, not the whole string", async () => {
  const root = await repository();
  try {
    for (const pointer of ["packages/real.ts:42", "packages/real.ts:42:7"]) {
      assert.equal(validateDispatchBrief(briefFor(root, { filePointers: [pointer] })).ok, true, pointer);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Red leg: drop unrunnableCommand and "pnpm test:all" dispatches clean, sending the
// executor to a script that was renamed and leaving it to choose which tests count --
// the exact substitution the acceptance-lane ruling exists to prevent.
test("STORY-303: a verification command naming an undefined script is refused", async () => {
  const root = await repository();
  try {
    const result = validateDispatchBrief(briefFor(root, { verificationCommands: ["pnpm typecheck", "pnpm test:all"] }));
    assert.equal(result.ok, false);
    const problem = result.problems.find((entry) => entry.code === "DISPATCH_COMMAND_UNRUNNABLE");
    assert.ok(problem, "the unrunnable command is reported");
    assert.match(problem.message, /test:all/u);
    assert.equal(validateDispatchBrief(briefFor(root, { verificationCommands: ["pnpm run typecheck"] })).ok, true, "the run form is the same command");
    assert.equal(validateDispatchBrief(briefFor(root, { verificationCommands: ["node scripts/probe.mjs"] })).ok, true, "a node invocation resolves on its file");
    assert.equal(validateDispatchBrief(briefFor(root, { verificationCommands: ["node scripts/absent.mjs"] })).ok, false, "and fails when that file is absent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The check must not overclaim. A command it cannot parse is counted, not passed
// silently. Red leg: drop the unjudged counter and an unparseable command is
// indistinguishable from a verified one.
test("STORY-303: a command the validator cannot judge is counted rather than passed quietly", async () => {
  const root = await repository();
  try {
    const result = validateDispatchBrief(briefFor(root, { verificationCommands: ["pnpm test", "make verify && ./ci.sh"] }));
    assert.equal(result.ok, true, "an unjudgeable command is not a failure");
    assert.equal(result.citations.checked, true);
    assert.equal(result.citations.unjudgedCommands, 1, "but it is counted, so the caller knows what was not checked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Red leg: default `citations.checked` to true, or omit the field, and a brief that
// declared no root reads as one whose citations were verified -- a weaker answer
// wearing the stronger one's clothes.
test("STORY-303: a brief with no repositoryRoot says its citations went unchecked", () => {
  const brief = briefFor("/unused");
  delete brief.repositoryRoot;
  const result = validateDispatchBrief(brief);
  assert.equal(result.ok, true, "presence-only remains a pass, exactly as before");
  assert.equal(result.citations.checked, false);
  assert.match(result.citations.reason, /not resolved/u, "and says why");
});
