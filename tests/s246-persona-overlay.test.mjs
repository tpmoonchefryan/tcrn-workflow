// SPDX-License-Identifier: Apache-2.0
// INIT-028 INC-145/147 compatibility coverage. Overlay behavior remains a
// historical library/replay concern after the public persona verbs retired.

import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_EXECUTION_CONFIG,
  applyCustomPersonaSet,
  applyModelPlanAssignInExecutionConfig,
  applyModelPlanSetInExecutionConfig,
  applyPersonaPresetOverrideInExecutionConfig,
  applyPersonaPresetRemoveInExecutionConfig,
  applyPersonaPresetRestoreInExecutionConfig,
} from "../dist/build/packages/core/src/index.js";

const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString().replace(/\.\d+Z$/u, "Z");
const customInput = (name) => ({
  name, role: "reviewer", jobTitle: "Review", mission: "Evidence review", refusals: "No publication",
  authorityBoundary: "Owner decides", contactWhen: "When evidence conflicts", requiredInputs: "Receipts",
  deliverables: "Review note", successCriteria: "Traceable", updatedAt: at(1),
});

test("INC-145: custom content and preset overlay names cannot collide", () => {
  const custom = applyCustomPersonaSet(EMPTY_EXECUTION_CONFIG, customInput("Audit")).state;
  assert.throws(
    () => applyPersonaPresetOverrideInExecutionConfig(custom, { name: "Audit", fields: { mission: "wrong route" }, updatedAt: at(2) }),
    (error) => error?.reasonCode === "PERSONA_NAME_CONFLICT",
  );
  assert.throws(
    () => applyCustomPersonaSet(EMPTY_EXECUTION_CONFIG, customInput("Verity")),
    (error) => error?.reasonCode === "PERSONA_NAME_CONFLICT",
  );
});

test("INC-145: preset overlay restores individual fields and then the complete factory view", () => {
  const overridden = applyPersonaPresetOverrideInExecutionConfig(EMPTY_EXECUTION_CONFIG, {
    name: "Verity", fields: { role: "gatekeeper", mission: "Owner-facing review" }, updatedAt: at(3),
  });
  assert.deepEqual(overridden.record.fields, { mission: "Owner-facing review", role: "gatekeeper" });
  let restored = applyPersonaPresetRestoreInExecutionConfig(overridden.state, { name: "Verity", field: "mission", updatedAt: at(4) });
  assert.equal(restored.personaOverrides[0].fields.role, "gatekeeper");
  assert.equal(Object.hasOwn(restored.personaOverrides[0].fields, "mission"), false);
  restored = applyPersonaPresetRestoreInExecutionConfig(restored, { name: "Verity", updatedAt: at(5) });
  assert.deepEqual(restored.personaOverrides, []);
  assert.deepEqual(restored.personaTombstones, []);
});

test("INC-152: preset removal refuses an active model-plan reference", () => {
  let state = applyPersonaPresetOverrideInExecutionConfig(EMPTY_EXECUTION_CONFIG, {
    name: "Verity", fields: { mission: "Owner-facing review" }, updatedAt: at(6),
  }).state;
  state = applyModelPlanSetInExecutionConfig(state, { host: "codex", name: "review", defaultModel: "model-a", updatedAt: at(7) }).state;
  state = applyModelPlanAssignInExecutionConfig(state, { host: "codex", name: "review", persona: "Verity", model: "model-b", updatedAt: at(8) }).state;
  assert.throws(
    () => applyPersonaPresetRemoveInExecutionConfig(state, { name: "Verity" }),
    (error) => error?.reasonCode === "PERSONA_PRESET_IN_USE",
  );
});
