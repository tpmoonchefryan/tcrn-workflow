// SPDX-License-Identifier: Apache-2.0
// INIT-028 INC-145/147: named guard coverage for the model-plan domain.

import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_EXECUTION_CONFIG,
  applyModelPlanRemoveInExecutionConfig,
  applyModelPlanRemove,
  applyModelPlanSet,
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
