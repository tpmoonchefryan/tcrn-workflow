// SPDX-License-Identifier: Apache-2.0
// INIT-028 INC-145/147: named guard coverage for the model-plan domain.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_EFFORT_ROSTER,
  EMPTY_EXECUTION_CONFIG,
  applyModelPlanAssign,
  applyModelPlanRemoveInExecutionConfig,
  applyModelPlanRemove,
  applyModelPlanSet,
  readVocabulary,
  validateModelPlanState,
} from "../dist/build/packages/core/src/index.js";

const at = "2026-01-01T00:00:00Z";

const reason = (callback, reasonCode) => assert.throws(callback, (error) => error?.reasonCode === reasonCode);

test("INC-145 M1/M3/M4: model-plan host and bounded text guards refuse", () => {
  reason(() => applyModelPlanSet([], { host: "gemini", name: "valid", defaultModel: "model", updatedAt: at }), "MODEL_PLAN_HOST_UNKNOWN");
  reason(() => applyModelPlanSet([], { host: "codex", name: "x".repeat(65), defaultModel: "model", updatedAt: at }), "MODEL_PLAN_NAME_INVALID");
  reason(() => applyModelPlanSet([], { host: "codex", name: "valid", defaultModel: "m".repeat(129), updatedAt: at }), "MODEL_PLAN_DEFAULT_MODEL_INVALID");
});

test("INC-145 M6: an active-plan reference refuses removal", () => {
  const created = applyModelPlanSet([], { host: "claude-code", name: "active-plan", defaultModel: "opus-5", updatedAt: at });
  reason(
    () => applyModelPlanRemove(created.records, { host: "claude-code", name: "active-plan" }, (record) => record.name === "active-plan" ? "setting execution.claudeCodeSubagentPlan" : undefined),
    "MODEL_PLAN_IN_USE",
  );
  assert.equal(created.records.length, 1);
});

test("INC-152 MODEL_PLAN_IN_USE wiring names the settings reference", () => {
  const created = applyModelPlanSet([], { host: "claude-code", name: "wired-plan", defaultModel: "opus-5", updatedAt: at });
  const state = { ...EMPTY_EXECUTION_CONFIG, modelPlans: created.records };
  reason(
    () => applyModelPlanRemoveInExecutionConfig(state, { host: "claude-code", name: "wired-plan" }, [{ key: "execution.claudeCodeSubagentPlan", value: "wired-plan" }]),
    "MODEL_PLAN_IN_USE",
  );
  assert.throws(
    () => applyModelPlanRemoveInExecutionConfig(state, { host: "claude-code", name: "wired-plan" }, [{ key: "execution.claudeCodeSubagentPlan", value: "wired-plan" }]),
    /setting execution\.claudeCodeSubagentPlan/u,
  );
});

test("S279: one effort roster preserves vendor names, host applicability, and legacy replay", () => {
  // INC-181: the roster covers both documentation layers — the model API effort values
  // and the two host session levels (ultra on Codex, ultracode on Claude Code) that the
  // API pages cannot carry by construction.
  assert.deepEqual(AGENT_EFFORT_ROSTER.map((entry) => entry.name), ["high", "low", "max", "medium", "minimal", "none", "xhigh", "ultra", "ultracode"]);
  assert.deepEqual(AGENT_EFFORT_ROSTER.find((entry) => entry.name === "ultracode")?.applicableHosts, ["claude-code"]);
  assert.deepEqual(AGENT_EFFORT_ROSTER.find((entry) => entry.name === "ultra")?.applicableHosts, ["codex"]);
  assert.deepEqual(AGENT_EFFORT_ROSTER.find((entry) => entry.name === "none")?.applicableHosts, ["codex"]);
  assert.deepEqual(AGENT_EFFORT_ROSTER.find((entry) => entry.name === "low")?.applicableHosts, ["claude-code", "codex"]);
  assert.equal(readVocabulary().efforts.length, AGENT_EFFORT_ROSTER.length);
  const created = applyModelPlanSet([], { host: "codex", name: "reasoned", defaultModel: "gpt-5", updatedAt: at });
  const assigned = applyModelPlanAssign(created.records, { host: "codex", name: "reasoned", persona: "Verity", model: "gpt-5", effort: "none", updatedAt: at }, (name) => name === "Verity");
  assert.equal(assigned.record.efforts?.Verity, "none");
  const claudePlan = applyModelPlanSet([], { host: "claude-code", name: "reasoned", defaultModel: "claude-sonnet", updatedAt: at });
  assert.throws(
    () => applyModelPlanAssign(claudePlan.records, { host: "claude-code", name: "reasoned", persona: "Verity", model: "claude-sonnet", effort: "none", updatedAt: at }, () => true),
    (error) => error?.reasonCode === "MODEL_PLAN_EFFORT_HOST_UNSUPPORTED" && /claude-code.*high.*low.*max.*medium.*xhigh/u.test(error.message),
  );
  const legacy = validateModelPlanState([created.records[0]]);
  assert.equal(Object.hasOwn(legacy[0], "efforts"), false, "old model-plan records must retain their legacy envelope");
});

test("INC-184: a session level stays in the roster and is refused by the dispatch face", () => {
  // A plan's efforts map is per-persona dispatch configuration, so a level the vendor
  // documents as a property of the session has no meaning in that position. The two
  // sides are deliberately different: the vocabulary keeps listing the level because
  // it exists, and assignment refuses it because it cannot be carried per dispatch.
  const sessionOnly = AGENT_EFFORT_ROSTER.filter((entry) => !entry.assignableToSubagent).map((entry) => entry.name);
  assert.deepEqual(sessionOnly, ["ultra", "ultracode"]);
  assert.equal(readVocabulary().efforts.filter((entry) => entry.assignableToSubagent === false).length, 2, "the vocabulary publishes the levels it refuses to assign");

  for (const [host, level, model] of [["codex", "ultra", "gpt-5"], ["claude-code", "ultracode", "claude-sonnet"]]) {
    const plan = applyModelPlanSet([], { host, name: "reasoned", defaultModel: model, updatedAt: at });
    assert.throws(
      () => applyModelPlanAssign(plan.records, { host, name: "reasoned", persona: "Verity", model, effort: level, updatedAt: at }, () => true),
      (error) => error?.reasonCode === "MODEL_PLAN_EFFORT_NOT_ASSIGNABLE"
        // The message must name the levels that would have worked, and must not offer
        // back the one just refused.
        && error.message.includes("high") && !new RegExp(`assignable values:.*\\b${level}\\b`, "u").test(error.message),
      `${level} must be refused for ${host}`,
    );
    // The host-unsupported path keeps its own reason code rather than being absorbed.
    const otherHost = host === "codex" ? "claude-code" : "codex";
    const otherPlan = applyModelPlanSet([], { host: otherHost, name: "reasoned", defaultModel: model, updatedAt: at });
    reason(
      () => applyModelPlanAssign(otherPlan.records, { host: otherHost, name: "reasoned", persona: "Verity", model, effort: level, updatedAt: at }, () => true),
      "MODEL_PLAN_EFFORT_HOST_UNSUPPORTED",
    );
  }

  // Every assignable level still assigns, so the refusal is bounded to the two.
  const codex = applyModelPlanSet([], { host: "codex", name: "worker", defaultModel: "gpt-5", updatedAt: at });
  for (const entry of AGENT_EFFORT_ROSTER.filter((candidate) => candidate.assignableToSubagent && candidate.applicableHosts.includes("codex"))) {
    const assigned = applyModelPlanAssign(codex.records, { host: "codex", name: "worker", persona: "Verity", model: "gpt-5", effort: entry.name, updatedAt: at }, () => true);
    assert.equal(assigned.record.efforts?.Verity, entry.name);
  }
});

test("S282: a plan carries a default effort, held to the same rule as a per-persona one", () => {
  // The plan default and the per-persona effort go through one function. A second
  // predicate here would let "session levels are not dispatchable" hold in one place
  // and not the other, and the loose side becomes the way around it.
  const created = applyModelPlanSet([], { host: "claude-code", name: "review", defaultModel: "claude-sonnet", defaultEffort: "high", updatedAt: at });
  assert.equal(created.record.defaultEffort, "high");
  reason(() => applyModelPlanSet([], { host: "claude-code", name: "review", defaultModel: "claude-sonnet", defaultEffort: "ultracode", updatedAt: at }), "MODEL_PLAN_EFFORT_NOT_ASSIGNABLE");
  reason(() => applyModelPlanSet([], { host: "codex", name: "review", defaultModel: "gpt-5", defaultEffort: "ultra", updatedAt: at }), "MODEL_PLAN_EFFORT_NOT_ASSIGNABLE");
  reason(() => applyModelPlanSet([], { host: "claude-code", name: "review", defaultModel: "claude-sonnet", defaultEffort: "minimal", updatedAt: at }), "MODEL_PLAN_EFFORT_HOST_UNSUPPORTED");

  // Absent means no plan default, and the field is then absent from the record too —
  // a plan written before this story replays byte-for-byte.
  const plain = applyModelPlanSet([], { host: "codex", name: "plain", defaultModel: "gpt-5", updatedAt: at });
  assert.equal(Object.hasOwn(plain.record, "defaultEffort"), false);
  assert.deepEqual(validateModelPlanState([plain.record]), [plain.record]);
  assert.deepEqual(validateModelPlanState([created.record]), [created.record]);

  // All four record shapes replay: with neither field, with each, and with both.
  const assigned = applyModelPlanAssign(created.records, { host: "claude-code", name: "review", persona: "Verity", model: "claude-sonnet", effort: "max", updatedAt: at }, () => true);
  assert.equal(assigned.record.defaultEffort, "high");
  assert.equal(assigned.record.efforts?.Verity, "max");
  assert.deepEqual(validateModelPlanState([assigned.record]), [assigned.record]);

  // A record carrying a session level in the stored field is refused on read, so the
  // store cannot become a way past the write-side check.
  reason(() => validateModelPlanState([{ ...created.record, defaultEffort: "ultracode" }]), "MODEL_PLAN_EFFORT_NOT_ASSIGNABLE");
  // An unknown field is still refused: widening the accepted shapes did not open it up.
  reason(() => validateModelPlanState([{ ...created.record, surprise: "x" }]), "MODEL_PLAN_RECORD_INVALID");
});
