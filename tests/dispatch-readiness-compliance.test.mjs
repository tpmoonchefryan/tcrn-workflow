// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DISPATCH_BRIEF_DECLARATIONS, DISPATCH_BRIEF_DECLARATION_FIELDS, DISPATCH_BRIEF_FIELDS, DISPATCH_CONTEXT_PACKAGE_SCHEMA_VERSION, DISPATCH_CONTEXT_READ_POLICY, validateAgentLifecycle, validateAgentLifecycleEvidence, validateDispatchBrief, validateStructuredHandoff } from "../scripts/dispatch-readiness-compliance.mjs";
import { buildBoundedContextPackage, comparePreSpawnReceiptBytes, DISPATCH_PRESPAWN_RECEIPT_SCHEMA, storyScopeFromWorkShow, validatePreSpawnAssociation, validatePreSpawnBaseline, validatePreSpawnReceiptBytes, validateTaskRoleBinding } from "../scripts/dispatch-adapter.mjs";
import { acquireWorkspaceLease, createProject, createWork, initializeWorkspace, validateWorkspace } from "../dist/build/packages/core/src/index.js";

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_CLI = join(ENGINE_ROOT, "scripts/tcrn-workflow.mjs");
const instant = (second) => `2026-09-16T00:00:${String(second).padStart(2, "0")}Z`;

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

test("INC-320/432: the existing brief carries a bounded, live-bound context package", () => {
  const fixture = roleBindingFixture();
  const contextPlan = {
    purpose: "Prepare one acceptance round from current source and evidence indexes.",
    decisionIndex: ["minutes:e63d5e7a1a0f507f537607dd"],
    resultIndex: ["LUNA-SERIAL/verifiers/index.json"],
    rawInputs: ["LUNA-SERIAL/evidence/safe-stop.md"],
    allowedDirectories: [],
  };
  const status = { workspaceId: "workspace:1", version: 10, headEventHash: "a".repeat(64) };
  const prepared = { source: { configDigest: "d".repeat(64) } };
  const packageValue = buildBoundedContextPackage({
    plan: contextPlan,
    brief: fixture.brief,
    binding: fixture.binding,
    workId: "work:429",
    status,
    liveWork: { record: fixture.liveWork.record },
    prepared,
  });
  const baseline = { version: status.version, headEventHash: status.headEventHash };
  const currentBrief = { ...fixture.brief, contextPlanRequired: true, contextPlan, contextPackage: packageValue, baseline };
  const ready = validateDispatchBrief(currentBrief);
  assert.equal(ready.ok, true, JSON.stringify(ready.problems));
  assert.equal(packageValue.schemaVersion, DISPATCH_CONTEXT_PACKAGE_SCHEMA_VERSION);
  assert.deepEqual(packageValue.task, { role: "acceptance", workId: "work:429", pack: "PACK-R2", phase: "acceptance" });
  assert.equal(packageValue.current.version, 10);
  assert.equal(packageValue.current.scopeDigest, fixture.liveWork.record.scopeDigest);
  assert.equal(packageValue.readPolicy.defaultReadOnlyTimeoutMs, 60_000);
  assert.equal(packageValue.readPolicy.maximumInlineOutputBytes, 8_192);
  assert.equal(packageValue.readPolicy.maximumMatches, 100);
  assert.equal(packageValue.readPolicy.overflowDisposition, "partial-with-next-scope");
  assert.equal(packageValue.resourcePolicy.ownerKey, "task:work:429:PACK-R2");

  const missingPackage = validateDispatchBrief({ ...currentBrief, contextPackage: undefined });
  assert.ok(missingPackage.problems.some((problem) => problem.code === "DISPATCH_CONTEXT_PACKAGE_REQUIRED"));
  const wideDirectory = validateDispatchBrief({
    ...currentBrief,
    contextPlan: { ...contextPlan, allowedDirectories: ["../"] },
  });
  assert.ok(wideDirectory.problems.some((problem) => problem.code === "DISPATCH_CONTEXT_DIRECTORY_UNBOUNDED"));
  const homeDirectory = validateDispatchBrief({
    ...currentBrief,
    contextPlan: { ...contextPlan, allowedDirectories: ["$HOME"] },
  });
  assert.ok(homeDirectory.problems.some((problem) => problem.code === "DISPATCH_CONTEXT_DIRECTORY_UNBOUNDED"));
  const broadSearch = structuredClone(currentBrief);
  broadSearch.contextPackage.readPolicy.defaultReadOnlyTimeoutMs = 600_000;
  assert.ok(validateDispatchBrief(broadSearch).problems.some((problem) => problem.code === "DISPATCH_CONTEXT_READ_POLICY_INVALID"));
  const wrongTask = structuredClone(currentBrief);
  wrongTask.contextPackage.task.workId = "work:431";
  assert.ok(validateDispatchBrief(wrongTask).problems.some((problem) => problem.code === "DISPATCH_CONTEXT_PACKAGE_BINDING_MISMATCH"));
  const omittedResultIndex = structuredClone(currentBrief);
  omittedResultIndex.contextPackage.inputs.resultIndex = [];
  assert.ok(validateDispatchBrief(omittedResultIndex).problems.some((problem) => problem.code === "DISPATCH_CONTEXT_PACKAGE_INPUTS_INVALID"));
  const baselineDrift = structuredClone(currentBrief);
  baselineDrift.contextPackage.current.headEventHash = "b".repeat(64);
  assert.ok(validateDispatchBrief(baselineDrift).problems.some((problem) => problem.code === "DISPATCH_CONTEXT_PACKAGE_BASELINE_MISMATCH"));
  assert.ok(DISPATCH_CONTEXT_READ_POLICY.searchOrder.includes("manifest"));
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

test("STORY-424 R01: observed work binding cannot drift while the role and Pack remain equal", () => {
  const declared = { ...freshLifecycle, workId: "work:424" };
  const observed = { ...freshLifecycle, workId: "work:other", sourceEvidence: [{ kind: "spawn_agent", locator: "fixture-spawn", digest: "c".repeat(64) }, { kind: "turn_context", locator: "fixture-turn", digest: "d".repeat(64) }] };
  const result = validateAgentLifecycleEvidence(declared, observed);
  assert.equal(result.ok, false);
  assert.equal(result.status, "red");
  assert.ok(result.problems.some((problem) => problem.code === "DISPATCH_LIFECYCLE_WORK_BINDING_MISMATCH"));
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

test("STORY-424 R01: every missing observed identity/fact is structured unknown, never an exception", () => {
  const declared = {
    ...freshLifecycle,
    workId: "work:424",
    predecessor: { agentId: "terminal-agent", status: "done" },
  };
  for (const field of ["agentId", "predecessor", "workId", "model", "effort", "forkTurns", "sourceEvidence"]) {
    const observed = structuredClone(declared);
    delete observed[field];
    let result;
    assert.doesNotThrow(() => { result = validateAgentLifecycleEvidence(declared, observed); }, field);
    assert.equal(result.ok, false, field);
    assert.equal(result.status, "unknown", field);
    assert.equal(result.reasonCode, "DISPATCH_LIFECYCLE_EVIDENCE_UNKNOWN", field);
  }
});

test("STORY-424 R01: outer work binding is retained while explicit inner/source contradictions are red", () => {
  const nested = { ...freshLifecycle };
  delete nested.workId;
  const handoff = validateStructuredHandoff({
    schemaVersion: "tcrn.structured-handoff.v1",
    workId: "work:424",
    role: freshLifecycle.role,
    pack: freshLifecycle.pack,
    lifecycle: nested,
  });
  assert.equal(handoff.ok, true, JSON.stringify(handoff.problems));
  assert.equal(handoff.workId, "work:424");
  assert.equal(handoff.lifecycle.workId, "work:424");

  const contradictory = validateStructuredHandoff({
    schemaVersion: "tcrn.structured-handoff.v1",
    workId: "work:424",
    role: freshLifecycle.role,
    pack: freshLifecycle.pack,
    sourceEvidence: [{ kind: "turn_context", locator: "same", digest: "1".repeat(64) }],
    lifecycle: {
      ...freshLifecycle,
      workId: "work:other",
      sourceEvidence: [{ kind: "turn_context", locator: "same", digest: "2".repeat(64) }],
    },
  });
  assert.equal(contradictory.ok, false);
  assert.ok(contradictory.problems.some((problem) => problem.code === "DISPATCH_HANDOFF_BINDING_MISMATCH"));
  assert.ok(contradictory.problems.some((problem) => problem.code === "DISPATCH_HANDOFF_SOURCE_DIGEST_MISMATCH"));
});

function receiptFixture() {
  const fixture = roleBindingFixture();
  const configuration = { workspaceId: "workspace:1", version: 10, headEventHash: "a".repeat(64), configDigest: "d".repeat(64) };
  const baselineContent = {
    schemaVersion: "tcrn.init-051-final-B-star.v1",
    primaryExternalKey: "TCRN-CROSS-STORY-429",
    workspace: { id: configuration.workspaceId, version: configuration.version, headEventHash: configuration.headEventHash },
    queue: { total: 1, returned: 1, truncated: false, workListSha256: "7".repeat(64) },
    sourceIdentities: { engine: { commit: "1".repeat(40), tree: "2".repeat(40), worktreeClean: true } },
    workBindings: [{ externalKey: "TCRN-CROSS-STORY-429", id: "work:429", revision: 4, scopeDigest: "a".repeat(64), status: "active" }],
  };
  const baseline = { path: "B-star.json", bytes: 10, sha256: "8".repeat(64), version: 10, headEventHash: configuration.headEventHash, content: baselineContent };
  const contextPlan = {
    purpose: "Prepare one final acceptance task from current indexed evidence.",
    decisionIndex: ["minutes:decision"],
    resultIndex: ["candidate-final-plan.json"],
    rawInputs: ["safe-stop.md"],
    allowedDirectories: [],
  };
  const status = { workspaceId: configuration.workspaceId, version: configuration.version, headEventHash: configuration.headEventHash };
  const effectiveBrief = {
    ...fixture.brief,
    contextPlanRequired: true,
    contextPlan,
    baseline: { path: baseline.path, sha256: baseline.sha256, version: baseline.version, headEventHash: baseline.headEventHash },
  };
  effectiveBrief.contextPackage = buildBoundedContextPackage({
    plan: contextPlan,
    brief: effectiveBrief,
    binding: fixture.binding,
    workId: "work:429",
    status,
    liveWork: fixture.liveWork,
    prepared: { source: { configDigest: configuration.configDigest } },
  });
  const effectiveBriefBytes = canonicalReceiptBytes(effectiveBrief);
  const scopeSha256 = createHash("sha256").update(fixture.liveScope, "utf8").digest("hex");
  const bindingCheck = validateTaskRoleBinding({ binding: fixture.binding, brief: effectiveBrief, liveWork: fixture.liveWork, liveScope: fixture.liveScope, roleContractSha256: fixture.roleContractSha256, briefTemplateSha256: fixture.briefTemplateSha256, technicalPack: effectiveBrief.technicalPack, scopeMarkerSha256: fixture.scopeMarkerSha256, prepared: fixture.prepared });
  return {
    schemaVersion: DISPATCH_PRESPAWN_RECEIPT_SCHEMA,
    bindingKind: "governed-task-role",
    personaProfileId: null,
    taskRole: {
      bindingKind: "governed-task-role",
      role: "acceptance",
      personaProfileId: null,
      phase: "acceptance",
      taskClass: "acceptance",
      workId: "work:429",
      pack: "PACK-R2",
      taskNamePrefix: "sol_accept",
      scopeMarker: fixture.scopeMarker,
      predecessor: { agentId: "old-sol", status: "completed" },
      predecessorEvidence: { path: "previous-sol-terminal-observation.json", sha256: "6".repeat(64) },
    },
    roleContract: { path: "role-binding.json", bytes: 10, sha256: fixture.roleContractSha256 },
    technicalPack: { path: fixture.brief.technicalPack.path, bytes: 10, sha256: fixture.technicalPackSha256 },
    briefTemplate: { path: "brief-template.json", bytes: 10, sha256: "9".repeat(64) },
    effectiveBrief: { bytes: effectiveBriefBytes.length, sha256: createHash("sha256").update(effectiveBriefBytes).digest("hex"), content: effectiveBrief },
    briefVerdict: validateDispatchBrief(effectiveBrief),
    baseline,
    workspace: { path: "/tmp/workspace", id: configuration.workspaceId, version: configuration.version, headEventHash: configuration.headEventHash, configDigest: configuration.configDigest },
    completeQueue: { total: 1, returned: 1, truncated: false, sha256: "7".repeat(64), bytes: 100 },
    liveWork: { id: "work:429", externalKey: "TCRN-CROSS-STORY-429", revision: 4, scopeDigest: "a".repeat(64), status: "active", scopeSha256 },
    resolution: { host: "codex", taskClass: "acceptance", mode: "frontier", value: { model: "gpt-5.6-sol", effort: "max" } },
    source: { engine: { engineVersion: "1.1.0", commit: "1".repeat(40), tree: "2".repeat(40), worktreeClean: true, files: [] }, configuration },
    bindingCheck,
    lifecycle: fixture.brief.agentLifecycle,
    actualNextSpawn: { status: "pending-actual-native-spawn", nativeRole: null, childId: null, parentThreadId: null },
    nonClaim: "Pre-spawn only; actual host association remains pending.",
  };
}

function canonicalReceiptBytes(value) {
  const canonicalValue = (entry) => Array.isArray(entry)
    ? entry.map(canonicalValue)
    : entry && typeof entry === "object"
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, canonicalValue(entry[key])]))
      : entry;
  return Buffer.from(`${JSON.stringify(canonicalValue(value))}\n`, "utf8");
}

function roleBindingFixture() {
  const roleContractSha256 = "e".repeat(64);
  const technicalPackSha256 = "f".repeat(64);
  const scopeMarker = "Prospective next-Sol task binding: bindingKind=governed-task-role; role=acceptance; personaProfileId=null; phase=acceptance; taskClass=acceptance; workId=work:429; pack=PACK-R2; taskNamePrefix=sol_accept.";
  const briefTemplateSha256 = "9".repeat(64);
  const scopeMarkerSha256 = createHash("sha256").update(scopeMarker, "utf8").digest("hex");
  const liveScope = `${storyScope}\n\n${scopeMarker}\nroleContractSha256=${roleContractSha256}\nbriefTemplateSha256=${briefTemplateSha256}\ntechnicalPackSha256=${technicalPackSha256}\nscopeMarkerSha256=${scopeMarkerSha256}`;
  const binding = {
    bindingKind: "governed-task-role",
    role: "acceptance",
    personaProfileId: null,
    phase: "acceptance",
    taskClass: "acceptance",
    host: "codex",
    mode: "frontier",
    primaryWorkId: "work:429",
    primaryExternalKey: "TCRN-CROSS-STORY-429",
    pack: "PACK-R2",
    taskNamePrefix: "sol_accept",
    scopeMarker,
  };
  const predecessor = { agentId: "old-sol", status: "completed" };
  binding.predecessor = predecessor;
  binding.predecessorEvidence = { path: "previous-sol-terminal-observation.json", sha256: "6".repeat(64) };
  const sourceEvidence = [
    { kind: "artifact", locator: "role-binding.json", digest: roleContractSha256, status: "verified" },
    { kind: "artifact", locator: "brief-template.json", digest: briefTemplateSha256, status: "verified" },
    { kind: "artifact", locator: "acceptance-pack.md", digest: technicalPackSha256, status: "verified" },
    { kind: "artifact", locator: "previous-sol-terminal-observation.json", digest: "6".repeat(64), status: "verified" },
    { kind: "artifact", locator: "B-star.json", digest: "8".repeat(64), status: "verified" },
    { kind: "work-show", locator: "work:429@revision:4", digest: "a".repeat(64), status: "verified" },
  ];
  const agentLifecycle = {
    schemaVersion: "tcrn.agent-lifecycle.v1",
    phase: "acceptance",
    role: "acceptance",
    pack: "PACK-R2",
    model: "gpt-5.6-sol",
    effort: "max",
    workId: "work:429",
    newInstance: true,
    forkTurns: "none",
    sameTaskRunning: false,
    predecessor,
    sourceEvidence,
  };
  const brief = {
    ...DISPATCH_BRIEF_DECLARATIONS,
    storyId: "work:429",
    workId: "work:429",
    taskClass: "acceptance",
    host: "codex",
    mode: "frontier",
    storyScope: liveScope,
    redLineBoundaries: ["No live write, publication, or work completion."],
    filePointers: ["scripts/dispatch-adapter.mjs"],
    verificationCommands: ["node --test tests/dispatch-readiness-compliance.test.mjs"],
    chainCloseoutActions: ["Read back only authorized evidence annotations."],
    effectiveEvidenceCommands: ["Revalidate the digest-bound pre-spawn receipt."],
    lifecycleRequired: true,
    agentLifecycle,
    structuredHandoff: { schemaVersion: "tcrn.structured-handoff.v1", workId: "work:429", role: "acceptance", pack: "PACK-R2", lifecycle: agentLifecycle },
    taskRoleBinding: { ...binding, workId: binding.primaryWorkId },
    technicalPack: { path: "/tmp/acceptance-pack.md", sha256: technicalPackSha256 },
  };
  const liveWork = { advisory: { scope: liveScope }, record: { id: "work:429", externalKey: "TCRN-CROSS-STORY-429", revision: 4, scopeDigest: "a".repeat(64), status: "active", tombstone: false } };
  const prepared = { resolution: { host: "codex", taskClass: "acceptance", mode: "frontier", value: { model: "gpt-5.6-sol", effort: "max" } } };
  return { roleContractSha256, briefTemplateSha256, technicalPackSha256, scopeMarkerSha256, scopeMarker, liveScope, binding, brief, liveWork, prepared };
}

async function sourceCliWorkShowFixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-dispatch-work-show-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = ["framework", "workspace", "transient", "evidence-locator", "release-trust"].map((kind) => ({ kind, path: join(base, kind) }));
  for (const root of roots) await mkdir(root.path);
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "DISPATCH-WORK-SHOW", createdAt: instant(0), segmentEventLimit: 32 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  let state;
  try {
    state = await createProject(workspace, lease, { expectedVersion: 0, occurredAt: instant(2), externalKey: "DISPATCH-PROJECT", name: "Dispatch scope fixture" });
    const projectId = state.projects.find((record) => record.externalKey === "DISPATCH-PROJECT").id;
    state = await createWork(workspace, lease, { expectedVersion: state.version, occurredAt: instant(3), projectId, externalKey: "DISPATCH-INIT", kind: "Initiative", parentId: null, title: "Dispatch initiative" });
    const initiativeId = state.work.find((record) => record.externalKey === "DISPATCH-INIT").id;
    state = await createWork(workspace, lease, { expectedVersion: state.version, occurredAt: instant(4), projectId, externalKey: "DISPATCH-EPIC", kind: "Epic", parentId: initiativeId, title: "Dispatch epic" });
    const epicId = state.work.find((record) => record.externalKey === "DISPATCH-EPIC").id;
    state = await createWork(workspace, lease, { expectedVersion: state.version, occurredAt: instant(5), projectId, externalKey: "DISPATCH-STORY", kind: "Story", parentId: epicId, status: "active", scope: storyScope, title: "Dispatch story" });
  } finally {
    await lease.release();
  }
  const story = state.work.find((record) => record.externalKey === "DISPATCH-STORY");
  const child = spawnSync(process.execPath, [SOURCE_CLI, "work-show", "--workspace", workspace, "--id", story.id], {
    cwd: ENGINE_ROOT,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  assert.equal(child.error, undefined, String(child.error?.message ?? ""));
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const workShow = JSON.parse(child.stdout);
  const materialized = await validateWorkspace(workspace);
  const controlledRecord = materialized.work.find((record) => record.id === story.id);
  return { workShow, controlledRecord };
}

test("dispatch adapter reads real source CLI work-show advisory.scope and safely rejects incomplete or mismatched scope shapes", async (context) => {
  const { workShow, controlledRecord } = await sourceCliWorkShowFixture(context);
  assert.equal(workShow.record.id, controlledRecord.id);
  assert.equal(Object.hasOwn(workShow.record, "extensions"), false, "the production work-show projection omits record.extensions");
  assert.equal(workShow.advisory.scope, storyScope);
  const production = storyScopeFromWorkShow(workShow);
  assert.equal(production.ok, true, JSON.stringify(production));
  assert.equal(production.source, "work-show.advisory.scope");
  assert.equal(production.scope, storyScope);

  const controlled = storyScopeFromWorkShow(controlledRecord);
  assert.equal(controlled.ok, true, JSON.stringify(controlled));
  assert.equal(controlled.source, "controlled-record.extensions[advisory:scope]");
  assert.equal(controlled.scope, storyScope);

  const missing = structuredClone(workShow);
  delete missing.advisory.scope;
  const recordOnly = storyScopeFromWorkShow(missing);
  assert.equal(recordOnly.ok, false);
  assert.equal(recordOnly.reasonCode, "DISPATCH_WORK_SCOPE_INVALID");
  assert.equal(storyScopeFromWorkShow(workShow.record).reasonCode, "DISPATCH_WORK_SCOPE_INVALID");

  for (const mutant of [
    { ...structuredClone(workShow), advisory: { ...workShow.advisory, scope: { value: storyScope } } },
    { ...structuredClone(workShow), advisory: { ...workShow.advisory, scope: 42 } },
  ]) {
    let result;
    assert.doesNotThrow(() => { result = storyScopeFromWorkShow(mutant); });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "DISPATCH_WORK_SCOPE_INVALID");
  }

  const mismatchRecord = structuredClone(controlledRecord);
  mismatchRecord.extensions["advisory:scope"] = { ...mismatchRecord.extensions["advisory:scope"], value: `${storyScope}\ncontrolled-record-mismatch` };
  const mismatch = storyScopeFromWorkShow({ ...workShow, record: mismatchRecord });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reasonCode, "DISPATCH_WORK_SCOPE_MISMATCH");

  const wrongTypeRecord = structuredClone(controlledRecord);
  wrongTypeRecord.extensions["advisory:scope"] = { value: { text: storyScope } };
  assert.equal(storyScopeFromWorkShow(wrongTypeRecord).reasonCode, "DISPATCH_WORK_SCOPE_INVALID");
});

test("STORY-424 R2: code-owned role/work/Pack/phase binding is checked against the live scope and brief", () => {
  const fixture = roleBindingFixture();
  const validate = (value) => validateTaskRoleBinding({
    binding: value.binding,
    brief: value.brief,
    liveWork: value.liveWork,
    liveScope: value.liveScope,
    roleContractSha256: value.roleContractSha256,
    briefTemplateSha256: value.briefTemplateSha256,
    technicalPack: { path: value.brief.technicalPack.path, sha256: value.technicalPackSha256 },
    scopeMarkerSha256: value.scopeMarkerSha256,
    prepared: value.prepared,
  });
  const green = validate(fixture);
  assert.equal(green.ok, true, JSON.stringify(green.problems));
  const mutations = [
    (copy) => { delete copy.binding.role; },
    (copy) => { copy.binding.role = "decision"; },
    (copy) => { copy.binding.primaryWorkId = "work:other"; },
    (copy) => { copy.brief.agentLifecycle.pack = "WRONG-PACK"; },
    (copy) => { copy.brief.agentLifecycle.phase = "rework"; },
    (copy) => { copy.binding.personaProfileId = "profile:tcrn-verity-v1"; },
    (copy) => { copy.liveScope = copy.liveScope.replace(copy.roleContractSha256, "0".repeat(64)); },
    (copy) => { copy.brief.taskRoleBinding = { ...copy.brief.taskRoleBinding, role: "decision" }; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(fixture);
    mutate(copy);
    assert.equal(validate(copy).ok, false);
  }

  const callerScope = structuredClone(fixture);
  callerScope.liveScope = `${storyScope}\ncaller-supplied-scope`;
  const callerScopeResult = validate(callerScope);
  assert.equal(callerScopeResult.ok, false);
  assert.ok(callerScopeResult.problems.some((problem) => problem.code === "DISPATCH_WORK_SCOPE_MISMATCH"));

  const missingBriefDigest = structuredClone(fixture);
  missingBriefDigest.briefTemplateSha256 = undefined;
  assert.ok(validate(missingBriefDigest).problems.some((problem) => problem.code === "DISPATCH_BRIEF_TEMPLATE_DIGEST_UNBOUND"));
  const missingMarkerDigest = structuredClone(fixture);
  missingMarkerDigest.scopeMarkerSha256 = undefined;
  assert.ok(validate(missingMarkerDigest).problems.some((problem) => problem.code === "DISPATCH_SCOPE_MARKER_DIGEST_UNBOUND"));
});

test("STORY-424 R2: stale chain, work, configuration, and source baselines are rejected", () => {
  const status = { workspaceId: "workspace:1", version: 10, headEventHash: "a".repeat(64) };
  const record = { externalKey: "TCRN-CROSS-STORY-429", id: "work:429", revision: 4, scopeDigest: "b".repeat(64), status: "active" };
  const workList = { truncated: false, total: 1, records: [record], version: 10, headEventHash: status.headEventHash, stdoutSha256: "c".repeat(64) };
  const sourceIdentity = { commit: "1".repeat(40), tree: "2".repeat(40), worktreeClean: true };
  const prepared = { source: { configDigest: "d".repeat(64) } };
  const baseline = {
    schemaVersion: "tcrn.init-051-final-B-star.v1",
    primaryExternalKey: record.externalKey,
    workspace: { id: status.workspaceId, version: status.version, headEventHash: status.headEventHash },
    queue: { total: 1, returned: 1, truncated: false, version: 10, headEventHash: status.headEventHash, workListSha256: workList.stdoutSha256 },
    configuration: { configDigest: prepared.source.configDigest },
    sourceIdentities: { engine: sourceIdentity, helper: { commit: "3".repeat(40), tree: "4".repeat(40), worktreeClean: true } },
    workBindings: [{ externalKey: record.externalKey, id: record.id, revision: record.revision, scopeDigest: record.scopeDigest, status: record.status }],
  };
  const args = { baseline, baselineSha256: "5".repeat(64), status, workList, prepared, sourceIdentity, primaryWorkId: record.id, primaryExternalKey: record.externalKey, requiredExternalKeys: [record.externalKey] };
  assert.equal(validatePreSpawnBaseline(args).ok, true);
  const staleWork = structuredClone(args); staleWork.baseline.workBindings[0].revision += 1;
  assert.ok(validatePreSpawnBaseline(staleWork).problems.some((problem) => problem.code === "DISPATCH_BASELINE_WORK_DRIFT"));
  const staleConfig = structuredClone(args); staleConfig.baseline.configuration.configDigest = "f".repeat(64);
  assert.ok(validatePreSpawnBaseline(staleConfig).problems.some((problem) => problem.code === "DISPATCH_BASELINE_CONFIG_DRIFT"));
  const staleHead = structuredClone(args); staleHead.baseline.workspace.version += 1;
  assert.ok(validatePreSpawnBaseline(staleHead).problems.some((problem) => problem.code === "DISPATCH_BASELINE_CHAIN_DRIFT"));
  const staleSource = structuredClone(args); staleSource.sourceIdentity = { ...sourceIdentity }; staleSource.baseline.sourceIdentities.engine.commit = "9".repeat(40);
  assert.ok(validatePreSpawnBaseline(staleSource).problems.some((problem) => problem.code === "DISPATCH_BASELINE_SOURCE_DRIFT"));
});

test("STORY-424 R2: receipt bytes and actual spawn/child association bind the full digest and resolved tuple", () => {
  const receipt = receiptFixture();
  const bytes = canonicalReceiptBytes(receipt);
  const parsed = validatePreSpawnReceiptBytes(bytes);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.taskName, `sol_accept_${parsed.receiptSha256}`);
  assert.equal(Object.hasOwn(parsed.receipt, "receiptSha256"), false);
  assert.equal(Object.hasOwn(parsed.receipt, "task_name"), false);
  assert.equal(validatePreSpawnReceiptBytes(Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)).reasonCode, "DISPATCH_RECEIPT_NOT_CANONICAL");
  const wrongTemplateDigest = structuredClone(receipt); wrongTemplateDigest.briefTemplate.sha256 = "0".repeat(64);
  assert.equal(validatePreSpawnReceiptBytes(canonicalReceiptBytes(wrongTemplateDigest)).reasonCode, "DISPATCH_RECEIPT_SCOPE_AUTHORITY_MISSING");
  const selfReferential = structuredClone(receipt); selfReferential.effectiveBrief.content.taskName = "sol_accept_self";
  assert.equal(validatePreSpawnReceiptBytes(canonicalReceiptBytes(selfReferential)).reasonCode, "DISPATCH_RECEIPT_SELF_REFERENCE_FORBIDDEN");
  const staleReceipt = structuredClone(receipt); staleReceipt.baseline.version += 1; staleReceipt.baseline.content.workspace.version += 1; staleReceipt.workspace.version += 1; staleReceipt.source.configuration.version += 1; staleReceipt.effectiveBrief.content.baseline.version += 1; staleReceipt.effectiveBrief.content.contextPackage.current.version += 1;
  const staleBriefBytes = canonicalReceiptBytes(staleReceipt.effectiveBrief.content); staleReceipt.effectiveBrief.bytes = staleBriefBytes.length; staleReceipt.effectiveBrief.sha256 = createHash("sha256").update(staleBriefBytes).digest("hex");
  assert.equal(comparePreSpawnReceiptBytes(bytes, canonicalReceiptBytes(staleReceipt)).reasonCode, "DISPATCH_PRESPAWN_RECEIPT_STALE");

  const valid = {
    receiptBytes: bytes,
    spawnCall: { type: "response_item", payload: { type: "function_call", id: "response-1", name: "spawn_agent", call_id: "call-1", arguments: JSON.stringify({ task_name: parsed.taskName, model: "gpt-5.6-sol", reasoning_effort: "max", fork_turns: "none", message: "encrypted" }) } },
    spawnResult: { type: "response_item", payload: { type: "function_call_output", id: "result-1", call_id: "call-1", output: JSON.stringify({ task_name: `/root/${parsed.taskName}` }) } },
    activity: { type: "event_msg", payload: { thread_id: "parent-1", item: { type: "SubAgentActivity", id: "call-1", agent_thread_id: "child-1", agent_path: `/root/${parsed.taskName}` } } },
    childSessionMeta: { type: "session_meta", payload: { id: "child-1", parent_thread_id: "parent-1", session_id: "parent-1", agent_path: `/root/${parsed.taskName}`, source: { subagent: { thread_spawn: { agent_role: null } } } } },
    turnContext: { type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "max" } },
  };
  const green = validatePreSpawnAssociation(valid);
  assert.equal(green.ok, true, JSON.stringify(green.mismatches));
  assert.equal(green.status, "green");
  assert.equal(green.nativeAgentRole, null);
  assert.equal(green.nativeRoleDisposition, "unknown/native null");
  assert.equal(green.providerAuthentication, "unknown/not claimed");

  const wrongTuple = structuredClone(valid); wrongTuple.spawnCall.payload.arguments = JSON.stringify({ task_name: parsed.taskName, model: "gpt-6-astra", reasoning_effort: "max", fork_turns: "none" });
  assert.ok(validatePreSpawnAssociation(wrongTuple).mismatches.some((problem) => problem.code === "DISPATCH_ASSOCIATION_MODEL_MISMATCH"));
  const wrongEffort = structuredClone(valid); wrongEffort.spawnCall.payload.arguments = JSON.stringify({ task_name: parsed.taskName, model: "gpt-5.6-sol", reasoning_effort: "high", fork_turns: "none" });
  assert.ok(validatePreSpawnAssociation(wrongEffort).mismatches.some((problem) => problem.code === "DISPATCH_ASSOCIATION_EFFORT_MISMATCH"));
  const inheritedFork = structuredClone(valid); inheritedFork.spawnCall.payload.arguments = JSON.stringify({ task_name: parsed.taskName, model: "gpt-5.6-sol", reasoning_effort: "max", fork_turns: "all" });
  assert.ok(validatePreSpawnAssociation(inheritedFork).mismatches.some((problem) => problem.code === "DISPATCH_ASSOCIATION_FORK_MISMATCH"));
  const wrongHash = structuredClone(valid); wrongHash.spawnCall.payload.arguments = JSON.stringify({ task_name: `sol_accept_${"0".repeat(64)}`, model: "gpt-5.6-sol", reasoning_effort: "max", fork_turns: "none" });
  assert.ok(validatePreSpawnAssociation(wrongHash).mismatches.some((problem) => problem.code === "DISPATCH_ASSOCIATION_TASK_NAME_MISMATCH"));
  const swappedChild = structuredClone(valid); swappedChild.activity.payload.item.agent_thread_id = "other-child";
  assert.ok(validatePreSpawnAssociation(swappedChild).mismatches.some((problem) => problem.code === "DISPATCH_ASSOCIATION_CHILD_MISMATCH"));
  const reusedChild = structuredClone(valid); reusedChild.childSessionMeta.payload.id = "old-sol"; reusedChild.activity.payload.item.agent_thread_id = "old-sol";
  assert.ok(validatePreSpawnAssociation(reusedChild).mismatches.some((problem) => problem.code === "DISPATCH_ASSOCIATION_TERMINAL_INSTANCE_REUSED"));
  const missing = validatePreSpawnAssociation({ ...valid, spawnResult: null });
  assert.equal(missing.status, "not-verifiable");
  assert.ok(missing.unknowns.includes("actual native role"));
});

test("STORY-424 R3: missing and wrong-type storyScope return structured red instead of throwing", () => {
  const baseline = receiptFixture();
  for (const value of [undefined, { text: "not a scope string" }, 42]) {
    const receipt = structuredClone(baseline);
    if (value === undefined) delete receipt.effectiveBrief.content.storyScope;
    else receipt.effectiveBrief.content.storyScope = value;
    const briefBytes = canonicalReceiptBytes(receipt.effectiveBrief.content);
    receipt.effectiveBrief.bytes = briefBytes.length;
    receipt.effectiveBrief.sha256 = createHash("sha256").update(briefBytes).digest("hex");

    let result;
    assert.doesNotThrow(() => { result = validatePreSpawnReceiptBytes(canonicalReceiptBytes(receipt)); });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "DISPATCH_RECEIPT_SCOPE_AUTHORITY_MISSING");
    assert.equal(result.location, "$.effectiveBrief.content.storyScope");
  }
});
