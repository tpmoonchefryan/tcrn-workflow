// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PROTOCOL_LIMITS,
  PROTOCOL_REASON_CODES,
  assertCanonicalJson,
  assertExchangePath,
  assertProtocolId,
  assertStrictInstant,
  assertVersionWindow,
  assertWorkTransition,
  canonicalExternalKey,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  createEvent,
  deriveStableId,
  parseStrictInstant,
  validateCompatibility,
  validateContextDocument,
  validateEventChain,
  validateExchangeEnvelope,
  validateExtensionRegistration,
  validateKnowledgeRecord,
  validateProfileTrust,
  validateReceipt,
  validateWorkGraph,
} from "../dist/build/packages/protocol/src/index.js";

async function fixture(path) {
  return JSON.parse(await readFile(new URL(`../fixtures/protocol/v1/${path}`, import.meta.url), "utf8"));
}

function expectReason(reasonCode, operation) {
  assert.throws(operation, (error) => error.reasonCode === reasonCode, reasonCode);
}

function work(overrides = {}) {
  return {
    schemaVersion: "tcrn.work.v1",
    id: "work:initiative-alpha",
    externalKey: "INITIATIVE-ALPHA",
    projectId: "project:alpha",
    kind: "Initiative",
    parentId: null,
    status: "planned",
    revision: 1,
    updatedAt: "2026-07-11T00:00:00Z",
    tombstone: false,
    extensions: {},
    ...overrides,
  };
}

test("canonical serialization, hashes, stable IDs, instants, and version windows match frozen vectors", async () => {
  const vector = await fixture("positive/canonical-vector.json");
  assert.equal(canonicalJson(vector.input), vector.expectedCanonical);
  assert.equal(canonicalSha256(vector.input), vector.expectedSha256);
  assert.equal(
    deriveStableId(vector.stableIdVector.namespace, vector.stableIdVector.externalKey),
    vector.stableIdVector.expectedId,
  );
  assert.deepEqual(assertCanonicalJson(vector.expectedCanonical), vector.input);
  assert.doesNotThrow(() => assertStrictInstant("2026-07-11T00:00:00.123456789+08:00"));
  assert.doesNotThrow(() => assertVersionWindow(1, 1, 1));
  for (const instant of ["2026-07-11", "07/11/2026", "2026-02-30T00:00:00Z", "2026-07-11T00:00:60Z", "2026-07-11T00:00:00+24:00"]) {
    expectReason("TIMESTAMP_INVALID", () => assertStrictInstant(instant));
  }
  expectReason("VERSION_WINDOW_INVALID", () => assertVersionWindow(1, 2, 1));
  expectReason("CANONICALIZATION_MISMATCH", () => assertCanonicalJson("{\"z\":1,\"a\":2}\n"));
});

test("planned delivery and extension shapes validate without forcing extensions into the hierarchy", async () => {
  const planned = await fixture("positive/planned-delivery.json");
  const ordered = validateWorkGraph(planned.records);
  assert.deepEqual(ordered.map((record) => record.id), planned.expectedOrder);
  assert.equal(canonicalSha256(ordered), planned.expectedGraphHash);

  const extensions = await fixture("positive/extensions.json");
  const extensionOrder = validateWorkGraph(extensions.records, extensions.registry);
  assert.deepEqual(extensionOrder.map((record) => record.kind), ["Review", "Incident", "Release", "Knowledge"]);
  assert.equal(canonicalSha256(extensionOrder), extensions.expectedHash);
  assert.deepEqual(extensionOrder[0].extensions["extension:unknown-optional"].value, { preserved: true });
});

test("event integrity vectors reject replay and corruption", async () => {
  const vector = await fixture("positive/event-chain.json");
  const first = createEvent(vector.inputs[0]);
  const second = createEvent(vector.inputs[1]);
  assert.deepEqual([first.payloadHash, second.payloadHash], vector.expectedPayloadHashes);
  assert.deepEqual([first.eventHash, second.eventHash], vector.expectedEventHashes);
  assert.deepEqual(validateEventChain([second, first]).map((event) => event.id), [first.id, second.id]);
  expectReason("EVENT_REPLAY", () => validateEventChain([first, first]));
  expectReason("EVENT_CHAIN_CORRUPT", () => validateEventChain([first, { ...second, payloadHash: "0".repeat(64) }]));
  expectReason("EVENT_CHAIN_CORRUPT", () => validateEventChain([first, { ...second, streamId: "stream:other" }]));
});

test("knowledge, context, exchange, compatibility, profile trust, receipt, and registration fixtures validate", async () => {
  const models = await fixture("positive/models.json");
  const planned = await fixture("positive/planned-delivery.json");
  const knowledge = validateKnowledgeRecord(models.knowledge);
  assert.equal(validateContextDocument(models.context, planned.records, [knowledge]), models.context);
  assert.equal(validateExchangeEnvelope(models.exchange), models.exchange);
  assert.equal(validateCompatibility(models.compatibility), models.compatibility);
  assert.equal(validateProfileTrust(models.profileTrust), models.profileTrust);
  assert.equal(validateReceipt(models.receipt), models.receipt);
  assert.equal(validateExtensionRegistration(models.extensionRegistration), models.extensionRegistration);
  const { expectedHash, ...basis } = models;
  assert.equal(canonicalSha256(basis), expectedHash);

  expectReason("TOMBSTONE_REFERENCED", () => validateContextDocument(
    models.context,
    planned.records,
    [{ ...knowledge, tombstone: true }],
  ));
  expectReason("CANONICALIZATION_MISMATCH", () => validateExchangeEnvelope({
    ...models.exchange,
    entries: [...models.exchange.entries].reverse(),
  }));
});

test("runtime validators match closed schema types, limits, and shared extension semantics", async () => {
  const models = await fixture("positive/models.json");
  const planned = await fixture("positive/planned-delivery.json");
  const events = await fixture("positive/event-chain.json");
  const knowledge = models.knowledge;
  const registry = [{ id: "extension:risk", version: 1, requiredByDefault: false }];

  expectReason("RECORD_MALFORMED", () => validateWorkGraph([work({ tombstone: "false" })]));
  expectReason("ID_INVALID", () => validateWorkGraph([work({ id: 7 })]));
  expectReason("RECORD_MALFORMED", () => createEvent({ ...events.inputs[0], unexpected: true }));
  const firstEvent = createEvent(events.inputs[0]);
  expectReason("RECORD_MALFORMED", () => validateEventChain([{ ...firstEvent, unexpected: true }]));
  expectReason("RECORD_MALFORMED", () => validateEventChain([{ ...firstEvent, sequence: "1" }]));

  expectReason("INPUT_OVERSIZED", () => validateExchangeEnvelope({
    ...models.exchange,
    entries: [{ ...models.exchange.entries[0], path: "a".repeat(513) }],
  }));
  expectReason("INPUT_OVERSIZED", () => validateExchangeEnvelope({
    ...models.exchange,
    entries: [{ ...models.exchange.entries[0], mediaType: "a".repeat(129) }],
  }));
  expectReason("RECORD_MALFORMED", () => validateExchangeEnvelope({
    ...models.exchange,
    entries: [{ ...models.exchange.entries[0], path: 7 }],
  }));
  expectReason("INPUT_OVERSIZED", () => validateExchangeEnvelope({
    ...models.exchange,
    entries: Array.from({ length: PROTOCOL_LIMITS.maxRecords + 1 }, () => models.exchange.entries[0]),
  }));
  expectReason("RECORD_MALFORMED", () => validateContextDocument({ ...models.context, workIds: "work:initiative-alpha" }, planned.records, [knowledge]));
  expectReason("INPUT_OVERSIZED", () => validateContextDocument(
    { ...models.context, workIds: Array.from({ length: PROTOCOL_LIMITS.maxRecords + 1 }, (_, index) => `work:a${index}`) },
    planned.records,
    [knowledge],
  ));

  const validExtensions = { "extension:risk": { required: true, value: { score: 1 } } };
  const unknownRequired = { "extension:unknown": { required: true, value: { score: 1 } } };
  const malformed = { "extension:risk": { required: "true", value: { score: 1 } } };
  const floatValue = { "extension:risk": { required: false, value: { score: 1.5 } } };
  const oversized = Object.fromEntries(Array.from(
    { length: PROTOCOL_LIMITS.maxExtensions + 1 },
    (_, index) => [`extension:e${String(index).padStart(2, "0")}`, { required: false, value: null }],
  ));
  const surfaces = [
    (extensions, acceptedRegistry = registry) => validateWorkGraph([work({ extensions })], acceptedRegistry),
    (extensions, acceptedRegistry = registry) => validateKnowledgeRecord({ ...knowledge, extensions }, acceptedRegistry),
    (extensions, acceptedRegistry = registry) => validateContextDocument({ ...models.context, extensions }, planned.records, [knowledge], acceptedRegistry),
    (extensions, acceptedRegistry = registry) => validateExchangeEnvelope({ ...models.exchange, extensions }, acceptedRegistry),
    (extensions, acceptedRegistry = registry) => validateReceipt({ ...models.receipt, extensions }, acceptedRegistry),
  ];
  for (const validate of surfaces) {
    assert.doesNotThrow(() => validate(validExtensions));
    expectReason("UNKNOWN_REQUIRED_EXTENSION", () => validate(unknownRequired, []));
    expectReason("RECORD_MALFORMED", () => validate(malformed));
    expectReason("CANONICAL_VALUE_INVALID", () => validate(floatValue));
    expectReason("INPUT_OVERSIZED", () => validate(oversized));
  }

  const closedValidators = [
    () => validateWorkGraph([work({ unexpected: true })]),
    () => validateKnowledgeRecord({ ...models.knowledge, unexpected: true }),
    () => validateContextDocument({ ...models.context, unexpected: true }, planned.records, [knowledge]),
    () => validateExchangeEnvelope({ ...models.exchange, unexpected: true }),
    () => validateCompatibility({ ...models.compatibility, unexpected: true }),
    () => validateProfileTrust({ ...models.profileTrust, unexpected: true }),
    () => validateReceipt({ ...models.receipt, unexpected: true }),
    () => validateExtensionRegistration({ ...models.extensionRegistration, unexpected: true }),
  ];
  for (const validate of closedValidators) {
    expectReason("RECORD_MALFORMED", validate);
  }

  const malformedInputs = [
    ["CANONICALIZATION_MISMATCH", () => assertCanonicalJson(null)],
    ["RECORD_MALFORMED", () => validateWorkGraph([null])],
    ["RECORD_MALFORMED", () => validateKnowledgeRecord(null)],
    ["RECORD_MALFORMED", () => validateContextDocument(null, [], [])],
    ["RECORD_MALFORMED", () => validateExchangeEnvelope(null)],
    ["RECORD_MALFORMED", () => validateCompatibility(null)],
    ["RECORD_MALFORMED", () => validateProfileTrust(null)],
    ["RECORD_MALFORMED", () => validateReceipt(null)],
    ["RECORD_MALFORMED", () => validateExtensionRegistration(null)],
    ["RECORD_MALFORMED", () => createEvent(null)],
    ["RECORD_MALFORMED", () => validateEventChain([null])],
  ];
  for (const [reasonCode, validate] of malformedInputs) {
    expectReason(reasonCode, validate);
  }
});

test("work graph and protocol negatives return exact frozen reason codes", async () => {
  const replay = createEvent({
    id: "event:replay-1",
    streamId: "stream:replay",
    sequence: 1,
    occurredAt: "2026-07-11T02:00:00Z",
    priorHash: null,
    payload: { revision: 1 },
  });
  const executors = new Map([
    ["canonical-value-invalid", () => canonicalJson(1.5)],
    ["malformed-record", () => validateWorkGraph([work({ unexpected: true })])],
    ["duplicate-id", () => validateWorkGraph([work(), work()])],
    ["cycle", () => validateWorkGraph([
      work({ id: "work:review-a", externalKey: "REVIEW-A", kind: "Review", parentId: "work:review-b" }),
      work({ id: "work:review-b", externalKey: "REVIEW-B", kind: "Review", parentId: "work:review-a" }),
    ])],
    ["cross-project-parent", () => validateWorkGraph([
      work(),
      work({ id: "work:epic-a", externalKey: "EPIC-A", projectId: "project:beta", kind: "Epic", parentId: "work:initiative-alpha" }),
    ])],
    ["invalid-parent-kind", () => validateWorkGraph([
      work(),
      work({ id: "work:story-a", externalKey: "STORY-A", kind: "Story", parentId: "work:initiative-alpha" }),
    ])],
    ["invalid-transition", () => assertWorkTransition("done", "active")],
    ["invalid-id", () => assertProtocolId("INVALID")],
    ["invalid-external-key", () => canonicalExternalKey("bad key")],
    ["invalid-timestamp", () => assertStrictInstant("2026-02-30T00:00:00Z")],
    ["invalid-version-window", () => assertVersionWindow(2, 1, 1)],
    ["oversized-input", () => canonicalJson("x".repeat(PROTOCOL_LIMITS.maxStringLength + 1))],
    ["unknown-required-extension", () => validateWorkGraph([
      work({ extensions: { "extension:missing": { required: true, value: { enabled: true } } } }),
    ])],
    ["event-replay", () => validateEventChain([replay, replay])],
    ["event-corruption", () => validateEventChain([{ ...replay, eventHash: "0".repeat(64) }])],
    ["path-escape", () => assertExchangePath("../escape.json")],
    ["canonicalization-mismatch", () => assertCanonicalJson("{ \"a\": 1 }\n")],
    ["tombstone-reference", () => validateWorkGraph([
      work({ tombstone: true }),
      work({ id: "work:epic-a", externalKey: "EPIC-A", kind: "Epic", parentId: "work:initiative-alpha" }),
    ])],
    ["missing-parent", () => validateWorkGraph([
      work({ id: "work:epic-a", externalKey: "EPIC-A", kind: "Epic", parentId: "work:missing" }),
    ])],
  ]);

  const declared = await fixture("negative/cases.json");
  assert.equal(executors.size, declared.cases.length);
  for (const vector of declared.cases) {
    assert.equal(typeof executors.get(vector.id), "function", vector.id);
    expectReason(vector.expectedReasonCode, executors.get(vector.id));
  }

  for (const path of ["/absolute.json", "a\\b.json", "a//b.json", "a/./b.json", "a/../b.json"]) {
    expectReason("PATH_ESCAPE", () => assertExchangePath(path));
  }
  assert.doesNotThrow(() => assertExchangePath("a/b.json"));

  const covered = new Set(declared.cases.map((entry) => entry.expectedReasonCode));
  assert.deepEqual([...covered].sort(compareCanonicalText), [...PROTOCOL_REASON_CODES].sort(compareCanonicalText));
});

test("determinism properties hold across 128 reproducible permutations", async () => {
  const planned = await fixture("positive/planned-delivery.json");
  const property = await fixture("property/determinism.json");
  let state = property.seed;
  for (let iteration = 0; iteration < property.permutations; iteration += 1) {
    const shuffled = [...planned.records];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      state = (state * 48271) % 2147483647;
      const target = state % (index + 1);
      [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
    }
    const ordered = validateWorkGraph(shuffled);
    assert.equal(canonicalSha256(ordered), planned.expectedGraphHash);
    assert.equal(deriveStableId("work", "story-alpha"), deriveStableId("work", "STORY-ALPHA"));
  }
});

test("UTF-8 byte ordering is invariant across Unicode insertion permutations and protocol surfaces", async () => {
  const vector = await fixture("property/portable-order.json");
  const collections = [
    ["values", vector.values, vector.expectedOrder, vector.expectedDigests.values],
    ["paths", vector.paths, vector.expectedPaths, vector.expectedDigests.paths],
    ["ids", vector.ids, vector.expectedIds, vector.expectedDigests.ids],
    ["eventTies", vector.eventTieIds, vector.expectedEventTieIds, vector.expectedDigests.eventTies],
    ["rc1Records", vector.rc1Paths, vector.expectedRc1Paths, vector.expectedDigests.rc1Records],
  ];
  for (const [label, input, expectedOrder, expectedDigest] of collections) {
    const ordered = [...input].sort(compareCanonicalText);
    assert.deepEqual(ordered, expectedOrder, label);
    assert.equal(canonicalSha256(ordered), expectedDigest, label);
  }
  const workRecords = vector.ids.map((id, index) => work({
    id,
    externalKey: `REVIEW-${index}`,
    kind: "Review",
  }));
  const workOrder = validateWorkGraph(workRecords);
  assert.deepEqual(workOrder.map((record) => record.id), vector.expectedWorkOrder);
  assert.equal(canonicalSha256(workOrder.map((record) => record.id)), vector.expectedDigests.workOrder);
  let state = 811;
  for (let iteration = 0; iteration < vector.permutations; iteration += 1) {
    const entries = [...vector.objectEntries];
    for (let index = entries.length - 1; index > 0; index -= 1) {
      state = (state * 48271) % 2147483647;
      const target = state % (index + 1);
      [entries[index], entries[target]] = [entries[target], entries[index]];
    }
    const value = Object.fromEntries(entries);
    assert.equal(canonicalJson(value), vector.expectedCanonical);
    assert.equal(canonicalSha256(value), vector.expectedSha256);
    for (const [label, input, expectedOrder, expectedDigest] of collections) {
      const shuffled = [...input];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        state = (state * 48271) % 2147483647;
        const target = state % (index + 1);
        [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
      }
      const ordered = shuffled.sort(compareCanonicalText);
      assert.deepEqual(ordered, expectedOrder, `${label}:${iteration}`);
      assert.equal(canonicalSha256(ordered), expectedDigest, `${label}:${iteration}`);
    }
    const shuffledWork = [...workRecords];
    for (let index = shuffledWork.length - 1; index > 0; index -= 1) {
      state = (state * 48271) % 2147483647;
      const target = state % (index + 1);
      [shuffledWork[index], shuffledWork[target]] = [shuffledWork[target], shuffledWork[index]];
    }
    const orderedWorkIds = validateWorkGraph(shuffledWork).map((record) => record.id);
    assert.deepEqual(orderedWorkIds, vector.expectedWorkOrder, `workOrder:${iteration}`);
    assert.equal(canonicalSha256(orderedWorkIds), vector.expectedDigests.workOrder, `workOrder:${iteration}`);
  }
});

test("exact instants preserve nanoseconds and normalize offsets without Date parsing", async () => {
  assert.equal(parseStrictInstant("2026-07-11T00:00:00.000000001Z") - parseStrictInstant("2026-07-11T00:00:00Z"), 1n);
  assert.equal(parseStrictInstant("2026-07-11T08:00:00+08:00"), parseStrictInstant("2026-07-11T00:00:00Z"));
  assert.equal(parseStrictInstant("2026-07-10T23:59:59.999999999Z") + 1n, parseStrictInstant("2026-07-11T00:00:00Z"));
  assert.notEqual(parseStrictInstant("2026-07-11T00:00:00.000000001Z"), parseStrictInstant("2026-07-11T00:00:00.000000002Z"));

  const models = await fixture("positive/models.json");
  assert.doesNotThrow(() => validateProfileTrust({
    ...models.profileTrust,
    issuedAt: "2026-07-11T00:00:00.000000001Z",
    expiresAt: "2026-07-11T00:00:00.000000002Z",
  }));
  for (const [issuedAt, expiresAt] of [
    ["2026-07-11T00:00:00.000000001Z", "2026-07-11T00:00:00.000000001Z"],
    ["2026-07-11T00:00:00.000000002Z", "2026-07-11T00:00:00.000000001Z"],
    ["2026-07-11T08:00:00+08:00", "2026-07-11T00:00:00Z"],
  ]) {
    expectReason("VERSION_WINDOW_INVALID", () => validateProfileTrust({ ...models.profileTrust, issuedAt, expiresAt }));
  }
});

test("raw external keys reject non-ASCII aliases before normalization or case conversion", () => {
  assert.equal(canonicalExternalKey("ss"), "SS");
  for (const value of ["ß", "é", "ＳＳ", "é"]) {
    expectReason("EXTERNAL_KEY_INVALID", () => canonicalExternalKey(value));
  }
});
