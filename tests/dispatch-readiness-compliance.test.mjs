// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { DISPATCH_BRIEF_DECLARATIONS, DISPATCH_BRIEF_DECLARATION_FIELDS, DISPATCH_BRIEF_FIELDS, validateAgentLifecycle, validateAgentLifecycleEvidence, validateDispatchBrief, validateStructuredHandoff } from "../scripts/dispatch-readiness-compliance.mjs";

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
  ...DISPATCH_BRIEF_DECLARATIONS,
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

test("INC-264 dispatch briefs require the exact autonomous-operation and scope-restraint declarations", () => {
  for (const field of DISPATCH_BRIEF_DECLARATION_FIELDS) {
    assert.equal(brief[field], DISPATCH_BRIEF_DECLARATIONS[field], field);
    const incomplete = { ...brief };
    delete incomplete[field];
    const result = validateDispatchBrief(incomplete);
    assert.equal(result.ok, false, `${field} deletion must be red`);
    assert.ok(result.problems.some((problem) => problem.field === field && problem.code === "DISPATCH_DECLARATION_MISSING"), field);
  }
});

test("a dispatch brief without a compliant Story scope is refused", () => {
  const missing = validateDispatchBrief({ ...brief, storyScope: undefined });
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some((problem) => problem.field === "storyScope"));
  const invalid = validateDispatchBrief({ ...brief, storyScope: storyScope.replace(/Permissions[^\n]*/u, "Permissions") });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.problems.some((problem) => problem.field === "storyScope"));
});

test("STORY-412 verification cadence is optional for old briefs but strict when declared", () => {
  const verificationPlan = {
    phase: "development",
    localChecks: ["node --test tests/dispatch-readiness-compliance.test.mjs"],
    finalRoots: ["engine-release", "platform-layout", "product-gates"],
    invalidationTriggers: ["sourceDigest", "environmentDigest", "commandDigest", "baselineDigest"],
    blockedDependencies: [],
    sameRepoExecution: "serial",
  };
  const ready = validateDispatchBrief({ ...brief, verificationPlan });
  assert.equal(ready.ok, true, JSON.stringify(ready.problems));
  assert.deepEqual(ready.verificationPlan, { checked: true, phase: "development" });
  const malformed = validateDispatchBrief({ ...brief, verificationPlan: { ...verificationPlan, sameRepoExecution: "parallel" } });
  assert.equal(malformed.ok, false);
  assert.ok(malformed.problems.some((problem) => problem.code === "DISPATCH_VERIFICATION_SERIAL_REQUIRED"));
  const blocked = validateDispatchBrief({ ...brief, verificationPlan: { ...verificationPlan, blockedDependencies: ["DS candidate not fixed"] } });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.problems.some((problem) => problem.code === "DISPATCH_VERIFICATION_PREREQUISITE_BLOCKED"));
  const missingPhase = validateDispatchBrief({ ...brief, verificationPlan: { ...verificationPlan, phase: "release" } });
  assert.equal(missingPhase.ok, false);
  assert.ok(missingPhase.problems.some((problem) => problem.code === "DISPATCH_VERIFICATION_PHASE_INVALID"));
  const legacy = validateDispatchBrief(brief);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.verificationPlan.checked, false);
});

const freshLifecycle = {
  schemaVersion: "tcrn.agent-lifecycle.v1",
  phase: "rework",
  role: "implementation",
  pack: "EPIC135/STORY-424",
  model: "gpt-5.6-luna",
  effort: "max",
  agentId: "01a0a06e-9729-7940-856e-700569fcd1bf",
  newInstance: true,
  forkTurns: "none",
  sameTaskRunning: false,
  predecessor: { agentId: "01a09cb4-46fb-7390-962d-0971efdf294f", status: "done" },
  sourceEvidence: [
    { kind: "spawn_agent", locator: "parent-rollout#ordinal=3799", digest: "a".repeat(64) },
    { kind: "turn_context", locator: "child-rollout#turn_context", digest: "b".repeat(64) },
  ],
};

test("STORY-424: a fresh round binds role, Pack, model, effort, new instance, fork none, and source evidence", () => {
  const result = validateAgentLifecycle(freshLifecycle);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.freshRound, true);
  assert.equal(result.sourceEvidence.status, "verified");
  const briefResult = validateDispatchBrief({ ...brief, lifecycleRequired: true, agentLifecycle: freshLifecycle });
  assert.equal(briefResult.ok, true, JSON.stringify(briefResult.problems));
  assert.equal(briefResult.lifecycle.reasonCode, "DISPATCH_LIFECYCLE_VALID");
});

test("STORY-424: missing lifecycle and inherited/old-instance fresh rounds are red", () => {
  const missing = validateDispatchBrief({ ...brief, lifecycleRequired: true });
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some((problem) => problem.code === "DISPATCH_LIFECYCLE_REQUIRED"));
  for (const [field, value, code] of [
    ["newInstance", false, "DISPATCH_LIFECYCLE_NEW_INSTANCE_REQUIRED"],
    ["forkTurns", "all", "DISPATCH_LIFECYCLE_FORK_FORBIDDEN"],
    ["sameTaskRunning", true, "DISPATCH_LIFECYCLE_RUNNING_TASK_REQUIRES_CLARIFICATION"],
  ]) {
    const result = validateAgentLifecycle({ ...freshLifecycle, [field]: value });
    assert.equal(result.ok, false, field);
    assert.ok(result.problems.some((problem) => problem.code === code), `${field} should carry ${code}`);
  }
  const sameAgent = validateAgentLifecycle({ ...freshLifecycle, predecessor: { agentId: freshLifecycle.agentId, status: "done" } });
  assert.ok(sameAgent.problems.some((problem) => problem.code === "DISPATCH_LIFECYCLE_AGENT_REUSED"));
  const runningPredecessor = validateAgentLifecycle({ ...freshLifecycle, predecessor: { agentId: "old-agent", status: "running" } });
  assert.ok(runningPredecessor.problems.some((problem) => problem.code === "DISPATCH_LIFECYCLE_RUNNING_PREDECESSOR"));
});

test("STORY-424: same-task clarification is explicit and does not restart the instance", () => {
  const clarificationInput = {
    ...freshLifecycle,
    phase: "clarification",
    newInstance: false,
    forkTurns: "none",
    sameTaskRunning: true,
    predecessor: undefined,
    sourceEvidence: [{ kind: "send_message", locator: "parent-rollout#clarification", digest: "1".repeat(64) }],
  };
  const clarification = validateAgentLifecycle(clarificationInput);
  assert.equal(clarification.ok, true, JSON.stringify(clarification.problems));
  assert.equal(clarification.freshRound, false);
  const clarified = validateAgentLifecycleEvidence(clarificationInput, clarificationInput);
  assert.equal(clarified.ok, true, JSON.stringify(clarified.problems));
  assert.equal(clarified.status, "green");
  const minimalClarification = validateAgentLifecycle({
    phase: "clarification",
    role: "implementation",
    pack: "EPIC135",
    newInstance: false,
    sameTaskRunning: true,
    sourceEvidence: [{ kind: "send_message", locator: "parent-rollout#clarification", digest: "2".repeat(64) }],
  });
  assert.equal(minimalClarification.ok, true, "clarification does not require a second model/effort declaration");
  const ambiguous = validateAgentLifecycle({ ...clarificationInput, sameTaskRunning: undefined });
  assert.ok(ambiguous.problems.some((problem) => problem.code === "DISPATCH_LIFECYCLE_CLARIFICATION_BINDING_REQUIRED"));
  const restart = validateAgentLifecycle({ ...clarificationInput, newInstance: true });
  assert.ok(restart.problems.some((problem) => problem.code === "DISPATCH_LIFECYCLE_CLARIFICATION_RESTART_REJECTED"));
});

test("STORY-424: prompt claims cannot stand in for source evidence and handoff bindings must agree", () => {
  const claim = validateAgentLifecycle({ ...freshLifecycle, sourceEvidence: [{ kind: "prompt-claim", locator: "prompt" }] });
  assert.equal(claim.ok, false);
  assert.ok(claim.problems.some((problem) => problem.code === "DISPATCH_LIFECYCLE_PROMPT_CLAIM_REJECTED"));
  const handoff = validateStructuredHandoff({
    schemaVersion: "tcrn.structured-handoff.v1",
    workId: "work:62d23a27246cad5bfc78bc17",
    role: "acceptance",
    pack: freshLifecycle.pack,
    lifecycle: freshLifecycle,
  });
  assert.equal(handoff.ok, false);
  assert.ok(handoff.problems.some((problem) => problem.code === "DISPATCH_HANDOFF_BINDING_MISMATCH"));
});

test("STORY-424 R01: the structured handoff is compared with the brief authority, not just with itself", () => {
  const declared = { ...freshLifecycle, predecessor: { agentId: "terminal-agent", status: "done" } };
  const result = validateDispatchBrief({
    ...brief,
    storyId: "work:62d23a27246cad5bfc78bc17",
    lifecycleRequired: true,
    agentLifecycle: declared,
    structuredHandoff: {
      schemaVersion: "tcrn.structured-handoff.v1",
      workId: "work:unrelated",
      role: "acceptance",
      pack: "UNRELATED",
      lifecycle: { ...declared, role: "acceptance", pack: "UNRELATED", model: "different-model", agentId: "other-agent" },
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.field === "structuredHandoff.workId"));
  assert.ok(result.problems.some((problem) => problem.code === "DISPATCH_HANDOFF_BINDING_MISMATCH"));
});

test("STORY-424 R01: a terminal predecessor cannot be reused when declaration omitted its fresh agent id", () => {
  const declared = { ...freshLifecycle, agentId: undefined, predecessor: { agentId: "terminal-agent", status: "done" } };
  const observed = {
    ...freshLifecycle,
    agentId: "terminal-agent",
    predecessor: undefined,
    sourceEvidence: [
      { kind: "spawn_agent", locator: "fixture-spawn", digest: "c".repeat(64) },
      { kind: "turn_context", locator: "fixture-turn", digest: "d".repeat(64) },
    ],
  };
  const result = validateAgentLifecycleEvidence(declared, observed);
  assert.equal(result.ok, false);
  assert.equal(result.status, "red");
  assert.ok(result.problems.some((problem) => problem.code === "DISPATCH_LIFECYCLE_TERMINAL_PREDECESSOR_REUSED"));
});

test("STORY-424 R01: clarification without a real running agent and send_message stays unknown", () => {
  const clarification = {
    phase: "clarification",
    role: "implementation",
    pack: "EPIC135",
    newInstance: false,
    sameTaskRunning: true,
    sourceEvidence: [{ kind: "artifact", locator: "unrelated-artifact", digest: "a".repeat(64) }],
  };
  const result = validateAgentLifecycleEvidence(clarification, clarification);
  assert.equal(result.ok, false);
  assert.equal(result.status, "unknown");
  assert.ok(result.unknownReasons.some((problem) => problem.code === "DISPATCH_LIFECYCLE_SEND_MESSAGE_EVIDENCE_MISSING"));
  assert.ok(result.unknownReasons.some((problem) => problem.code === "DISPATCH_LIFECYCLE_AGENT_ID_MISSING"));
});

test("STORY-424: real spawn plus child turn context is green, while task-id/compaction-only reuse is red", () => {
  const observed = {
    ...freshLifecycle,
    sourceEvidence: [
      { kind: "spawn_agent", locator: "parent-rollout#ordinal=3799", digest: "c".repeat(64) },
      { kind: "turn_context", locator: "child-rollout#turn_context", digest: "d".repeat(64) },
    ],
  };
  const green = validateAgentLifecycleEvidence(freshLifecycle, observed);
  assert.equal(green.ok, true, JSON.stringify(green.problems));
  assert.equal(green.status, "green");
  const digestReuse = validateAgentLifecycleEvidence(freshLifecycle, {
    ...observed,
    sourceEvidence: [
      { kind: "spawn_agent", locator: "retained-evidence#spawn", digest: "f".repeat(64) },
      { kind: "turn_context", locator: "retained-evidence#turn", digest: "0".repeat(64) },
    ],
  });
  assert.equal(digestReuse.ok, true, "digest-bound evidence may be reused without reusing the agent");
  assert.equal(digestReuse.status, "green");
  const unavailableEvidence = validateAgentLifecycleEvidence(freshLifecycle, {
    ...observed,
    sourceEvidence: ["host did not expose a digest"],
  });
  assert.equal(unavailableEvidence.ok, false);
  assert.equal(unavailableEvidence.status, "unknown");
  assert.equal(unavailableEvidence.reasonCode, "DISPATCH_LIFECYCLE_EVIDENCE_UNKNOWN");
  const oldTask = validateAgentLifecycleEvidence(freshLifecycle, {
    ...freshLifecycle,
    agentId: undefined,
    taskId: "old-task-id",
    sourceEvidence: [{ kind: "compaction", locator: "old-session#compaction", digest: "e".repeat(64) }],
  });
  assert.equal(oldTask.ok, false);
  assert.equal(oldTask.status, "red");
  assert.ok(oldTask.problems.some((problem) => problem.code === "DISPATCH_LIFECYCLE_OLD_TASK_ID_ONLY"));
  assert.ok(oldTask.problems.some((problem) => problem.code === "DISPATCH_LIFECYCLE_COMPACTION_NOT_INSTANCE"));
  assert.ok(oldTask.unknownReasons.some((problem) => problem.code === "DISPATCH_LIFECYCLE_SPAWN_EVIDENCE_MISSING"));
});
