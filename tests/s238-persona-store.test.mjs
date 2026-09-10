// SPDX-License-Identifier: Apache-2.0
// INIT-028 S238 compatibility coverage. The public persona CLI was retired by
// STORY-370; these assertions keep the historical replay/library boundary exact.

import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_PERSONA_STORE,
  allPersonaReadback,
  applyLegacyPersonaSet,
  applyPersonaRemove,
  applyPersonaSet,
  derivePersonaId,
  validatePersonaStoreState,
} from "../dist/build/packages/core/src/index.js";

const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString().replace(/\.\d+Z$/u, "Z");

const fields = {
  name: "审计员",
  role: "reviewer",
  jobTitle: "Verification reviewer",
  mission: "Review evidence",
  refusals: "No publication",
  authorityBoundary: "Owner decides",
  contactWhen: "When evidence conflicts",
  requiredInputs: "Scope and receipts",
  deliverables: "Review note",
  successCriteria: "All claims trace",
};

test("S238: library profile records retain a stable derived identity across updates", () => {
  const first = applyPersonaSet(EMPTY_PERSONA_STORE, { ...fields, updatedAt: at(1) });
  assert.equal(first.record.id, derivePersonaId(fields.name));
  assert.equal(first.record.revision, 1);
  const second = applyPersonaSet(first.state, { ...fields, mission: "Review updated evidence", updatedAt: at(2) });
  assert.equal(second.record.id, first.record.id);
  assert.equal(second.record.revision, 2);
  assert.equal(second.record.mission, "Review updated evidence");
  assert.deepEqual(validatePersonaStoreState(second.state), second.state);
});

test("S238: historical v1 records replay into the current content shape without promoting prompt text", () => {
  const legacy = {
    schemaVersion: "tcrn.persona.v1",
    id: derivePersonaId("Legacy reviewer"),
    name: "Legacy reviewer",
    description: "Historical title",
    role: "reviewer",
    prompt: "Historical prompt must remain replay-only",
    revision: 4,
    updatedAt: at(4),
    tombstone: false,
  };
  const replayed = applyLegacyPersonaSet(EMPTY_PERSONA_STORE, legacy);
  assert.equal(replayed.record.id, legacy.id);
  assert.equal(replayed.record.revision, legacy.revision);
  assert.equal(replayed.record.jobTitle, legacy.description);
  assert.equal(replayed.record.mission, "");
  assert.deepEqual(validatePersonaStoreState({ personas: [legacy] }), replayed.state);
});

test("S238: readback keeps shipped references and custom content distinct", () => {
  const custom = applyPersonaSet(EMPTY_PERSONA_STORE, { ...fields, updatedAt: at(5) }).state;
  const readback = allPersonaReadback(custom);
  assert.equal(readback.filter((entry) => entry.source === "core-reference").length, 8);
  const entry = readback.find((candidate) => candidate.name === fields.name);
  assert.deepEqual({ readOnly: entry.readOnly, source: entry.source, preset: entry.preset }, { readOnly: false, source: "custom", preset: false });
});

test("S238: removing a custom library record is explicit and does not remove a reference preset", () => {
  const custom = applyPersonaSet(EMPTY_PERSONA_STORE, { ...fields, updatedAt: at(6) }).state;
  const removed = applyPersonaRemove(custom, { name: fields.name });
  assert.deepEqual(removed, EMPTY_PERSONA_STORE);
  assert.throws(() => applyPersonaRemove(EMPTY_PERSONA_STORE, { name: fields.name }), (error) => error?.reasonCode === "PERSONA_NOT_FOUND");
});
