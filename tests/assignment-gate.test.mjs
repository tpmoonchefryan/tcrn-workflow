// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  ASSIGNMENT_VERSION,
  GATE_VERSION,
  listAssignmentsByWorkItem,
  listGatesByWorkItem,
  validateAssignmentRecord,
  validateGateRecord,
} from "../dist/build/packages/core/src/index.js";

const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/assignment-gate-cases.json", import.meta.url), "utf8"));

function reason(code, operation) { assert.throws(operation, (error) => error?.reasonCode === code, code); }

function assignment(overrides = {}) {
  return {
    schemaVersion: ASSIGNMENT_VERSION,
    id: "assignment:one", projectId: "project:alpha", workId: "work:a", accountableActorId: "actor:minerva",
    status: "active", revision: 1, updatedAt: "2026-07-16T00:00:00Z", tombstone: false, extensions: {},
    ...overrides,
  };
}
function gate(overrides = {}) {
  return {
    schemaVersion: GATE_VERSION,
    id: "gate:one", projectId: "project:alpha", workId: "work:a", title: "release readiness",
    outcomeClass: "owner_intent_required", status: "pending", revision: 1, updatedAt: "2026-07-16T00:00:00Z", tombstone: false, extensions: {},
    ...overrides,
  };
}

test("valid assignment and gate records validate", () => {
  const assignments = [assignment(), assignment({ id: "assignment:2", status: "proposed" }), assignment({ id: "assignment:3", status: "released" })];
  const gates = [gate(), gate({ id: "gate:2", workId: null }), gate({ id: "gate:3", status: "satisfied", outcomeClass: "role_decision" }), gate({ id: "gate:4", status: "blocked", outcomeClass: "blocked" })];
  assert.equal(assignments.length, fixture.assignmentPositiveCases);
  assert.equal(gates.length, fixture.gatePositiveCases);
  for (const value of assignments) assert.equal(validateAssignmentRecord(value).schemaVersion, ASSIGNMENT_VERSION);
  for (const value of gates) assert.equal(validateGateRecord(value).schemaVersion, GATE_VERSION);
  assert.equal(validateGateRecord(gate({ workId: null })).workId, null);
});

test("hostile assignment records fail closed", () => {
  const hostile = [
    () => reason("ASSIGNMENT_UNKNOWN_FIELD", () => validateAssignmentRecord({ ...assignment(), extra: true })),
    () => reason("ASSIGNMENT_SCHEMA_INVALID", () => validateAssignmentRecord(assignment({ status: "done" }))),
    () => reason("ASSIGNMENT_SCHEMA_INVALID", () => validateAssignmentRecord(assignment({ workId: "NotAnId" }))),
    () => reason("ASSIGNMENT_SCHEMA_INVALID", () => validateAssignmentRecord(assignment({ revision: 0 }))),
    () => reason("ASSIGNMENT_SCHEMA_INVALID", () => validateAssignmentRecord(assignment({ updatedAt: "2026-07-16" }))),
    () => reason("ASSIGNMENT_SCHEMA_INVALID", () => validateAssignmentRecord(assignment({ workId: null }))),
  ];
  assert.equal(hostile.length, fixture.assignmentHostileCases);
  for (const operation of hostile) operation();
});

test("hostile gate records fail closed", () => {
  const hostile = [
    () => reason("GATE_UNKNOWN_FIELD", () => validateGateRecord({ ...gate(), extra: true })),
    () => reason("GATE_SCHEMA_INVALID", () => validateGateRecord(gate({ status: "open" }))),
    () => reason("GATE_SCHEMA_INVALID", () => validateGateRecord(gate({ outcomeClass: "final" }))),
    () => reason("GATE_UNICODE_INVALID", () => validateGateRecord(gate({ title: "\ud800" }))),
    () => reason("GATE_UNICODE_INVALID", () => validateGateRecord(gate({ title: "x".repeat(2049) }))),
    () => reason("GATE_SCHEMA_INVALID", () => validateGateRecord(gate({ revision: 0 }))),
    () => reason("GATE_SCHEMA_INVALID", () => validateGateRecord(gate({ projectId: "NotAnId" }))),
  ];
  assert.equal(hostile.length, fixture.gateHostileCases);
  for (const operation of hostile) operation();
});

test("list-by-work-item filters tombstones and other work items", () => {
  const assignments = [assignment(), assignment({ id: "assignment:2", workId: "work:b" }), assignment({ id: "assignment:3", tombstone: true })];
  const gates = [gate(), gate({ id: "gate:2", workId: "work:b" }), gate({ id: "gate:3", tombstone: true }), gate({ id: "gate:4", workId: null })];
  const cases = [
    () => assert.deepEqual(listAssignmentsByWorkItem("work:a", assignments).map((entry) => entry.id), ["assignment:one"]),
    () => assert.equal(listAssignmentsByWorkItem("work:b", assignments).length, 1),
    () => assert.deepEqual(listGatesByWorkItem("work:a", gates).map((entry) => entry.id), ["gate:one"]),
    () => assert.equal(listGatesByWorkItem("work:b", gates).length, 1),
  ];
  assert.equal(cases.length, fixture.listCases);
  for (const operation of cases) operation();
});

test("Draft 2020-12 schemas and runtime agree", async () => {
  const assignmentSchema = JSON.parse(await readFile(new URL("../schemas/assignment-v1.schema.json", import.meta.url), "utf8"));
  const gateSchema = JSON.parse(await readFile(new URL("../schemas/gate-v1.schema.json", import.meta.url), "utf8"));
  const protocolSchema = JSON.parse(await readFile(new URL("../schemas/protocol-common-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addKeyword({ keyword: "x-tcrn-maxUtf8Bytes", type: "string", schemaType: "number", validate: (limit, value) => Buffer.byteLength(value, "utf8") <= limit });
  ajv.addSchema(protocolSchema);
  const validateAssignment = ajv.compile(assignmentSchema);
  const validateGate = ajv.compile(gateSchema);
  assert.equal(validateAssignment(assignment()), true); validateAssignmentRecord(assignment());
  assert.equal(validateGate(gate()), true); validateGateRecord(gate());
  const vectors = [
    [validateAssignment, () => validateAssignmentRecord({ ...assignment(), extra: true }), { ...assignment(), extra: true }],
    [validateAssignment, () => validateAssignmentRecord(assignment({ status: "done" })), assignment({ status: "done" })],
    [validateAssignment, () => validateAssignmentRecord(assignment({ revision: 0 })), assignment({ revision: 0 })],
    [validateAssignment, () => validateAssignmentRecord(assignment({ workId: "NotAnId" })), assignment({ workId: "NotAnId" })],
    [validateGate, () => validateGateRecord({ ...gate(), extra: true }), { ...gate(), extra: true }],
    [validateGate, () => validateGateRecord(gate({ outcomeClass: "final" })), gate({ outcomeClass: "final" })],
    [validateGate, () => validateGateRecord(gate({ status: "open" })), gate({ status: "open" })],
    [validateGate, () => validateGateRecord(gate({ updatedAt: "2026-07-16" })), gate({ updatedAt: "2026-07-16" })],
  ];
  assert.equal(vectors.length, fixture.schemaParityCases);
  for (const [validate, runtime, vector] of vectors) {
    assert.equal(validate(vector), false);
    assert.throws(runtime);
  }
});

test("extension registration records bind appliesTo work for assignment and gate", async () => {
  const registrationSchema = JSON.parse(await readFile(new URL("../schemas/extension-registration-v1.schema.json", import.meta.url), "utf8"));
  const protocolSchema = JSON.parse(await readFile(new URL("../schemas/protocol-common-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addKeyword({ keyword: "x-tcrn-aos-requirementIds", schemaType: "array" });
  ajv.addSchema(protocolSchema);
  const validate = ajv.compile(registrationSchema);
  for (const [rid, url] of [["extension:assignment", "../schemas/assignment-v1.schema.json"], ["extension:gate", "../schemas/gate-v1.schema.json"]]) {
    const schemaBytes = await readFile(new URL(url, import.meta.url));
    const registration = {
      schemaVersion: "tcrn.extension-registration.v1",
      id: rid, version: 1, requiredByDefault: fixture.requiredByDefault, appliesTo: [fixture.registrationAppliesTo],
      schemaDigest: createHash("sha256").update(schemaBytes).digest("hex"),
    };
    assert.equal(validate(registration), true);
  }
});
