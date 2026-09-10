// SPDX-License-Identifier: Apache-2.0
// INIT-028 INC-145/147: vocabulary must remain derived from engine institutions.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFERENCE_EXECUTION_FORMS,
  CONFERENCE_TYPES,
  EXECUTION_HOSTS,
  PERSONA_ROLE_DEFINITIONS,
  SETTINGS_CATALOG,
  readVocabulary,
} from "../dist/build/packages/core/src/index.js";

test("S369: vocabulary distinguishes open configuration strings from known renderers", () => {
  const vocabulary = readVocabulary();
  assert.deepEqual(vocabulary.hosts, EXECUTION_HOSTS);
  assert.equal(vocabulary.hostValueKind, "string");
  assert.equal(vocabulary.effortValueKind, "string");
  assert.deepEqual(vocabulary.efforts, []);
  assert.deepEqual(vocabulary.roles, PERSONA_ROLE_DEFINITIONS);
  assert.deepEqual(vocabulary.conferenceTypes.map((term) => term.value), CONFERENCE_TYPES);
  assert.ok(vocabulary.conferenceTypes.every((term) => term.description.length > 0 && Array.isArray(term.coveredByIndependenceFloors)));
  assert.ok(vocabulary.conferenceTypes.find((term) => term.value === "verification").coveredByIndependenceFloors.includes("verification"));
  assert.deepEqual(vocabulary.executionForms.map((term) => term.value), CONFERENCE_EXECUTION_FORMS);
  assert.ok(vocabulary.executionForms.every((term) => term.description.length > 0));
});

test("S369: vocabulary preserves catalog metadata and live replacement sources", () => {
  const vocabulary = readVocabulary();
  assert.ok(vocabulary.settingsEnums.every((term) => term.controlType === "enum"), "settingsEnums must not contain non-enum catalog entries");
  const expected = new Map(SETTINGS_CATALOG.map((entry) => [entry.key, entry]));
  for (const term of vocabulary.settingsEnums) {
    const entry = expected.get(term.key);
    assert.ok(entry);
    assert.equal(term.type, entry.type);
    assert.equal(term.controlType, entry.controlType);
    assert.equal(term.defaultValue, entry.defaultValue);
  }
  assert.equal(vocabulary.settingsEnums.find((term) => term.key === "execution.dispatchMode").valueSource, "dispatch-mode-list");
  assert.equal(vocabulary.settingsEnums.find((term) => term.key === "execution.claudeCodeSubagentPlan").valueSource, "legacy-model-plan-history");
  assert.equal(vocabulary.settingsEnums.find((term) => term.key === "execution.codexSubagentPlan").valueSource, "legacy-model-plan-history");
});
