// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  CONFERENCE_MINUTES_VERSION,
  CONFERENCE_POSITION_VERSION,
  CONFERENCE_REQUEST_VERSION,
  appendConferencePosition,
  closeConference,
  listConferencesByWorkItem,
  openConference,
  validateConferenceMinutes,
  validateConferencePosition,
  validateConferenceRequest,
} from "../dist/build/packages/core/src/index.js";

const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/conference-cases.json", import.meta.url), "utf8"));

function reason(code, operation) { assert.throws(operation, (error) => error?.reasonCode === code, code); }

function request(overrides = {}) {
  return {
    schemaVersion: CONFERENCE_REQUEST_VERSION,
    id: "conference:one", projectId: "project:alpha", type: "architecture", title: "Adapter topology",
    linkedWorkIds: ["work:a", "work:b"], desiredOutcome: "choose a host-neutral bundle boundary", participantIds: ["actor:minerva"],
    status: "open", revision: 1, updatedAt: "2026-07-16T00:00:00Z", tombstone: false, extensions: {},
    ...overrides,
  };
}
function position(overrides = {}) {
  return {
    schemaVersion: CONFERENCE_POSITION_VERSION,
    id: "position:one", conferenceId: "conference:one", projectId: "project:alpha", actorId: "actor:minerva",
    position: "keep neutral fields byte-identical", risks: ["drift"], recommendations: ["parity fixture"], evidenceIds: ["evidence:p6b"],
    revision: 1, updatedAt: "2026-07-16T00:05:00Z", tombstone: false, extensions: {},
    ...overrides,
  };
}
function minutes(overrides = {}) {
  return {
    schemaVersion: CONFERENCE_MINUTES_VERSION,
    id: "minutes:one", conferenceId: "conference:one", projectId: "project:alpha", summary: "agreed on parity boundary",
    outcomeClass: "role_decision", decisions: ["adopt cross-host parity fixture", "keep host surface enumerated"], unresolvedIssues: [],
    revision: 1, updatedAt: "2026-07-16T01:00:00Z", tombstone: false, extensions: {},
    ...overrides,
  };
}

test("valid conference request, position, and minutes validate", () => {
  const positives = [request(), position(), minutes()];
  assert.equal(positives.length, fixture.positiveCases);
  assert.equal(validateConferenceRequest(request()).schemaVersion, CONFERENCE_REQUEST_VERSION);
  assert.equal(validateConferencePosition(position()).schemaVersion, CONFERENCE_POSITION_VERSION);
  assert.equal(validateConferenceMinutes(minutes()).schemaVersion, CONFERENCE_MINUTES_VERSION);
});

test("operations bind positions and minutes to an open conference", () => {
  const cases = [
    () => assert.equal(openConference(request()).status, "open"),
    () => reason("CONFERENCE_SCHEMA_INVALID", () => openConference(request({ status: "closed" }))),
    () => assert.equal(appendConferencePosition(position(), request()).id, "position:one"),
    () => reason("CONFERENCE_POSITION_UNBOUND", () => appendConferencePosition(position({ conferenceId: "conference:other" }), request())),
    () => reason("CONFERENCE_POSITION_UNBOUND", () => appendConferencePosition(position(), request({ status: "closed" }))),
    () => assert.equal(listConferencesByWorkItem("work:a", [request(), request({ id: "conference:2", linkedWorkIds: ["work:z"] })]).length, 1),
  ];
  assert.equal(cases.length, fixture.operationCases);
  for (const operation of cases) operation();
});

test("close distils each decision into a knowledge candidate backlinking the conference", () => {
  const closed = closeConference(minutes(), request(), [position()]);
  assert.equal(closed.candidates.length, minutes().decisions.length);
  const checks = [
    () => assert.equal(closed.candidates.every((candidate) => candidate.kind === "decision" && candidate.promotionState === "candidate"), true),
    () => assert.equal(closed.candidates.every((candidate) => candidate.sourceReferences.some((reference) => reference.startsWith("conference:"))), true),
    () => assert.equal(closed.candidates.every((candidate) => /^[a-f0-9]{64}$/u.test(candidate.candidateDigest)), true),
  ];
  assert.equal(checks.length, fixture.distillCases);
  for (const check of checks) check();
  reason("CONFERENCE_MINUTES_UNBOUND", () => closeConference(minutes({ conferenceId: "conference:other" }), request()));
});

test("hostile records fail closed", () => {
  const hostile = [
    () => reason("CONFERENCE_UNKNOWN_FIELD", () => validateConferenceRequest({ ...request(), extra: true })),
    () => reason("CONFERENCE_SCHEMA_INVALID", () => validateConferenceRequest(request({ type: "planning" }))),
    () => reason("CONFERENCE_SCHEMA_INVALID", () => validateConferenceRequest(request({ status: "archived" }))),
    () => reason("CONFERENCE_ANCHOR_REQUIRED", () => validateConferenceRequest(request({ linkedWorkIds: [] }))),
    () => reason("CONFERENCE_DESIRED_OUTCOME_REQUIRED", () => validateConferenceRequest(request({ desiredOutcome: "" }))),
    () => reason("CONFERENCE_UNICODE_INVALID", () => validateConferenceRequest(request({ title: "\ud800" }))),
    () => reason("CONFERENCE_BUDGET_EXCEEDED", () => validateConferenceRequest(request({ title: "x".repeat(2049) }))),
    () => reason("CONFERENCE_SCHEMA_INVALID", () => validateConferenceMinutes(minutes({ outcomeClass: "final" }))),
    () => reason("CONFERENCE_BUDGET_EXCEEDED", () => validateConferencePosition(position({ risks: Array.from({ length: 33 }, () => "r") }))),
    () => reason("CONFERENCE_SCHEMA_INVALID", () => validateConferencePosition(position({ evidenceIds: ["NotAnId"] }))),
    () => reason("CONFERENCE_SCHEMA_INVALID", () => validateConferenceRequest(request({ revision: 0 }))),
    () => reason("CONFERENCE_SCHEMA_INVALID", () => validateConferenceRequest(request({ updatedAt: "2026-07-16" }))),
  ];
  assert.equal(hostile.length, fixture.hostileCases);
  for (const operation of hostile) operation();
});

test("Draft 2020-12 schema and runtime agree", async () => {
  const requestJsonSchema = JSON.parse(await readFile(new URL("../schemas/conference-request-v1.schema.json", import.meta.url), "utf8"));
  const protocolSchema = JSON.parse(await readFile(new URL("../schemas/protocol-common-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addKeyword({ keyword: "x-tcrn-maxUtf8Bytes", type: "string", schemaType: "number", validate: (limit, value) => Buffer.byteLength(value, "utf8") <= limit });
  ajv.addSchema(protocolSchema);
  const requestSchema = ajv.compile(requestJsonSchema);
  assert.equal(requestSchema(request()), true); validateConferenceRequest(request());
  const vectors = [
    { ...request(), extra: true },
    request({ type: "planning" }),
    request({ status: "archived" }),
    request({ linkedWorkIds: [] }),
    request({ revision: 0 }),
    request({ id: "NotAnId" }),
    request({ updatedAt: "2026-07-16" }),
    request({ title: "" }),
  ];
  assert.equal(vectors.length, fixture.schemaParityCases);
  for (const vector of vectors) {
    assert.equal(requestSchema(vector), false);
    assert.throws(() => validateConferenceRequest(vector));
  }
});

test("extension registration binds appliesTo work and the conference schema digest", async () => {
  const registrationSchema = JSON.parse(await readFile(new URL("../schemas/extension-registration-v1.schema.json", import.meta.url), "utf8"));
  const protocolSchema = JSON.parse(await readFile(new URL("../schemas/protocol-common-v1.schema.json", import.meta.url), "utf8"));
  const schemaBytes = await readFile(new URL("../schemas/conference-request-v1.schema.json", import.meta.url));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addKeyword({ keyword: "x-tcrn-aos-requirementIds", schemaType: "array" });
  ajv.addSchema(protocolSchema);
  const validate = ajv.compile(registrationSchema);
  const registration = {
    schemaVersion: "tcrn.extension-registration.v1",
    id: "extension:conference",
    version: 1,
    requiredByDefault: fixture.requiredByDefault,
    appliesTo: [fixture.registrationAppliesTo],
    schemaDigest: createHash("sha256").update(schemaBytes).digest("hex"),
  };
  assert.equal(validate(registration), true);
});
