// SPDX-License-Identifier: Apache-2.0
// INIT-028 INC-145/147: named guard coverage for model-plan replay and dispatch resolution.

import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_EXECUTION_CONFIG,
  applyModelPlanAssign,
  applyModelPlanRemoveInExecutionConfig,
  applyModelPlanRemove,
  applyModelPlanSet,
  readDispatchConfig,
  resolveDispatch,
  validateModelPlanEffort,
  validateModelPlanState,
} from "../dist/build/packages/core/src/index.js";

const at = "2026-01-01T00:00:00Z";

const reason = (callback, reasonCode) => assert.throws(callback, (error) => error?.reasonCode === reasonCode);

test("S369: model-plan host strings remain open and bounded record fields refuse", () => {
  const unknown = applyModelPlanSet([], { host: "gemini", name: "valid", defaultModel: "model", updatedAt: at });
  assert.equal(unknown.record.host, "gemini");
  reason(() => applyModelPlanAssign(unknown.records, { host: "gemini", name: "missing", persona: "Verity", model: "model", updatedAt: at }, () => true), "MODEL_PLAN_NOT_FOUND");
  reason(() => applyModelPlanAssign(unknown.records, { host: "gemini", name: "valid", persona: "ghost", model: "model", updatedAt: at }, () => false), "MODEL_PLAN_PERSONA_UNKNOWN");
  reason(() => applyModelPlanSet([], { host: "", name: "valid", defaultModel: "model", updatedAt: at }), "MODEL_PLAN_RECORD_INVALID");
  reason(() => applyModelPlanSet([], { host: 42, name: "valid", defaultModel: "model", updatedAt: at }), "MODEL_PLAN_RECORD_INVALID");
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

test("S369: free effort values round-trip without a roster", () => {
  for (const effort of ["none", "ultra", "ultracode", "xhigh2", ""]) {
    assert.equal(validateModelPlanEffort(effort, "gemini"), effort);
    const created = applyModelPlanSet([], { host: "gemini", name: `plan-${effort || "empty"}`, defaultModel: "model", defaultEffort: effort, updatedAt: at });
    assert.equal(created.record.defaultEffort, effort);
    const assigned = applyModelPlanAssign(created.records, { host: "gemini", name: created.record.name, persona: "Verity", model: "model", effort, updatedAt: at }, () => true);
    assert.equal(assigned.record.efforts?.Verity, effort);
  }
});

test("S369: historical model-plan envelopes retain optional fields exactly", () => {
  const plain = applyModelPlanSet([], { host: "codex", name: "plain", defaultModel: "gpt-5", updatedAt: at });
  const defaulted = applyModelPlanSet([], { host: "codex", name: "defaulted", defaultModel: "gpt-5", defaultEffort: "ultracode", updatedAt: at });
  const withEfforts = applyModelPlanAssign(plain.records, { host: "codex", name: "plain", persona: "Verity", model: "gpt-5", effort: "xhigh2", updatedAt: at }, () => true);
  const both = applyModelPlanAssign(defaulted.records, { host: "codex", name: "defaulted", persona: "Verity", model: "gpt-5", effort: "", updatedAt: at }, () => true);

  for (const record of [plain.record, defaulted.record, withEfforts.record, both.record]) {
    assert.deepEqual(validateModelPlanState([record]), [record]);
  }
  assert.equal(Object.hasOwn(plain.record, "defaultEffort"), false);
  assert.equal(Object.hasOwn(plain.record, "efforts"), false);
  reason(() => validateModelPlanState([{ ...plain.record, surprise: "x" }]), "MODEL_PLAN_RECORD_INVALID");
});

test("S369: dispatch resolution falls through lower tiers, keeps hosts isolated, and reports behaviour bits", () => {
  const config = readDispatchConfig([
    {
      key: "execution.dispatchTiers",
      value: JSON.stringify({
        "host-a": {
          flagship: { model: "", effort: "ignored" },
          main: { model: "main-model", effort: "" },
          economy: { model: "economy-model", effort: "economy-effort" },
        },
        "host-b": {
          flagship: null,
          main: { model: "other-main", effort: "other-effort" },
          economy: null,
        },
        empty: { flagship: null, main: null, economy: null },
        upward: { flagship: { model: "flagship-model", effort: "flagship-effort" }, main: null, economy: null },
      }),
    },
    {
      key: "execution.dispatchModes",
      value: JSON.stringify({ frontier: { implement: "flagship", plan: "main", research: "economy" }, empty: {} }),
    },
    { key: "execution.dispatchMode", value: "frontier" },
  ]);

  assert.deepEqual(resolveDispatch(config, "host-a", "implement"), {
    taskClass: "implement",
    host: "host-a",
    mode: "frontier",
    dispatch: true,
    verify: true,
    requestedTier: "flagship",
    resolvedTier: "main",
    value: { model: "main-model", effort: "" },
  });
  assert.equal(resolveDispatch(config, "host-b", "implement").value.model, "other-main");
  assert.equal(resolveDispatch(config, "host-a", "plan").dispatch, false);
  assert.equal(resolveDispatch(config, "host-a", "plan").verify, false);
  assert.deepEqual(resolveDispatch(config, "empty", "implement").value, null);
  assert.deepEqual(resolveDispatch(config, "empty", "research").value, null);
  assert.deepEqual(resolveDispatch(config, "empty", "plan").value, null, "main does not wrap upward to flagship or economy");
  assert.deepEqual(resolveDispatch(config, "upward", "plan").value, null, "a main request never wraps upward to flagship");
  assert.deepEqual(resolveDispatch(config, "upward", "implement").value, { model: "flagship-model", effort: "flagship-effort" });
  const lower = structuredClone(config);
  lower.tiers["host-a"].main = null;
  assert.deepEqual(resolveDispatch(lower, "host-a", "implement").value, { model: "economy-model", effort: "economy-effort" });
  assert.equal(resolveDispatch(config, "host-a", "implement").resolvedTier, "main", "an empty model is unfilled while an empty effort is retained");
  reason(() => resolveDispatch(config, "host-a", "missing"), "DISPATCH_CLASS_UNKNOWN");
  reason(() => resolveDispatch(config, "host-a", "implement", "missing"), "DISPATCH_MODE_UNKNOWN");
  reason(() => resolveDispatch(config, "host-a", "plan", "empty"), "DISPATCH_MAPPING_MISSING");
});
