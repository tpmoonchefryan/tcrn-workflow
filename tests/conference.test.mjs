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
  distillConferenceKnowledge,
  listConferencesByWorkItem,
  openConference,
  validateConferenceMinutes,
  validateConferencePosition,
  validateConferenceRequest,
} from "../dist/build/packages/core/src/index.js";
import { canonicalExternalKey, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

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

test("WSD-3: distillConferenceKnowledge emits one governed knowledge input per decision", () => {
  const options = {
    occurredAt: "2026-07-16T02:00:00Z",
    expectedVersionBase: 3,
    stalenessDays: 90,
    accountableOwnerId: "owner:governance",
    evidenceIds: ["evidence:extra", "work:notevidence"],
  };
  const inputs = distillConferenceKnowledge(minutes(), request(), [position()], options);
  const checks = [
    // One input per minutes decision, each a candidate carrying the base-relative CAS.
    () => assert.equal(inputs.length, minutes().decisions.length),
    () => assert.deepEqual(inputs.map((input) => input.expectedVersion), [3, 4]),
    () => assert.equal(inputs.every((input) => input.lifecycle === "candidate" && input.category === "decision" && input.kind === "decision"), true),
    // Hyphen-only external keys the canonicalizer admits (uppercased), unique per decision.
    () => assert.deepEqual(inputs.map((input) => input.externalKey), ["conference-decision-one-one-1", "conference-decision-one-one-2"]),
    () => assert.equal(inputs.every((input) => canonicalExternalKey(input.externalKey) === input.externalKey.toUpperCase()), true),
    // Fixed conference tag set: non-empty and sorted so the WSC-6 promote check passes.
    () => assert.deepEqual(inputs[0].tags, ["conference-decision", "distilled", "type-architecture"]),
    () => assert.equal(inputs.every((input) => input.tags.length >= 1 && input.snippet.length > 0), true),
    // sourceReferences backlink both records; buildMetadata sorts them server-side.
    () => assert.deepEqual([...inputs[0].sourceReferences].sort(), ["conference-minutes:one", "conference:one"].sort()),
    // sourceDigest binds the FULL untruncated basis, recomputed here.
    () => assert.equal(inputs[0].sourceDigest, canonicalSha256({ title: request().title, decision: minutes().decisions[0], minutesId: "minutes:one" })),
    // Evidence union: only evidence:-prefixed ids, deduped and sorted (position + supplement).
    () => assert.deepEqual(inputs[0].linkedEvidenceIds, ["evidence:extra", "evidence:p6b"]),
    // Provenance stays optional at capture, but supplying it here flows through.
    () => assert.equal(inputs[0].accountableOwnerId, "owner:governance"),
    () => assert.equal(inputs[0].stalenessPolicy.maximumAgeDays, 90),
    () => assert.equal(inputs[0].scope === "project" && inputs[0].projectId === "project:alpha", true),
  ];
  assert.equal(checks.length, fixture.distillKnowledgeCases);
  for (const check of checks) check();
  reason("CONFERENCE_MINUTES_UNBOUND", () => distillConferenceKnowledge(minutes({ conferenceId: "conference:other" }), request(), [], options));
});

test("WSD-3: knowledge fields truncate on a code-point boundary without splitting a multi-byte code point", () => {
  // A 4-byte code point straddling the 512-byte snippet bound: truncation must stop
  // before it, leaving a well-formed string at or under the byte cap (no partial unit).
  const decision = `${"a".repeat(510)}\u{1f600}tail`;
  const inputs = distillConferenceKnowledge(minutes({ decisions: [decision] }), request(), [], {
    occurredAt: "2026-07-16T02:00:00Z", expectedVersionBase: 0, stalenessDays: 30,
  });
  const [input] = inputs;
  assert.equal(Buffer.byteLength(input.snippet, "utf8") <= 512, true);
  assert.equal(input.snippet.isWellFormed(), true);
  assert.equal(input.snippet, "a".repeat(510));
  assert.equal(Buffer.byteLength(input.subject, "utf8") <= 512, true);
  assert.equal(input.subject.isWellFormed(), true);
  // summary passes through the 2048-byte cap unchanged and stays well-formed.
  assert.equal(Buffer.byteLength(input.summary, "utf8") <= 2048, true);
  assert.equal(input.summary.isWellFormed(), true);
  // Provenance omitted stays empty (capture-cheap); evidence union is empty.
  assert.equal(input.accountableOwnerId, "");
  assert.deepEqual(input.linkedEvidenceIds, []);
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

  const positionJsonSchema = JSON.parse(await readFile(new URL("../schemas/conference-position-v1.schema.json", import.meta.url), "utf8"));
  const positionSchema = ajv.compile(positionJsonSchema);
  assert.equal(positionSchema(position()), true); validateConferencePosition(position());
  const positionVectors = [
    { ...position(), extra: true },
    position({ evidenceIds: ["NotAnId"] }),
    position({ risks: Array.from({ length: 33 }, () => "r") }),
    position({ updatedAt: "2026-07-16" }),
  ];
  assert.equal(positionVectors.length, fixture.positionParityCases);
  for (const vector of positionVectors) { assert.equal(positionSchema(vector), false); assert.throws(() => validateConferencePosition(vector)); }

  const minutesJsonSchema = JSON.parse(await readFile(new URL("../schemas/conference-minutes-v1.schema.json", import.meta.url), "utf8"));
  const minutesSchema = ajv.compile(minutesJsonSchema);
  assert.equal(minutesSchema(minutes()), true); validateConferenceMinutes(minutes());
  const minutesVectors = [
    { ...minutes(), extra: true },
    minutes({ outcomeClass: "final" }),
    minutes({ decisions: Array.from({ length: 33 }, () => "d") }),
    minutes({ revision: 0 }),
  ];
  assert.equal(minutesVectors.length, fixture.minutesParityCases);
  for (const vector of minutesVectors) { assert.equal(minutesSchema(vector), false); assert.throws(() => validateConferenceMinutes(vector)); }
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
