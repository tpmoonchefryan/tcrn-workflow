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
  createEvent,
  deriveStableId,
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

test("work graph and protocol negatives return exact frozen reason codes", async () => {
  const observed = new Set();
  function negative(reasonCode, operation) {
    expectReason(reasonCode, operation);
    observed.add(reasonCode);
  }

  negative("RECORD_MALFORMED", () => validateWorkGraph([work({ unexpected: true })]));
  negative("CANONICAL_VALUE_INVALID", () => canonicalJson(1.5));
  negative("ID_INVALID", () => assertProtocolId("INVALID"));
  negative("EXTERNAL_KEY_INVALID", () => canonicalExternalKey("bad key"));
  negative("TIMESTAMP_INVALID", () => assertStrictInstant("2026-02-30T00:00:00Z"));
  negative("VERSION_WINDOW_INVALID", () => assertVersionWindow(2, 1, 1));
  negative("DUPLICATE_ID", () => validateWorkGraph([work(), work()]));
  negative("GRAPH_CYCLE", () => validateWorkGraph([
    work({ id: "work:review-a", externalKey: "REVIEW-A", kind: "Review", parentId: "work:review-b" }),
    work({ id: "work:review-b", externalKey: "REVIEW-B", kind: "Review", parentId: "work:review-a" }),
  ]));
  negative("GRAPH_CROSS_PROJECT_PARENT", () => validateWorkGraph([
    work(),
    work({ id: "work:epic-a", externalKey: "EPIC-A", projectId: "project:beta", kind: "Epic", parentId: "work:initiative-alpha" }),
  ]));
  negative("INVALID_TRANSITION", () => assertWorkTransition("done", "active"));
  negative("INPUT_OVERSIZED", () => canonicalJson("x".repeat(PROTOCOL_LIMITS.maxStringLength + 1)));
  negative("UNKNOWN_REQUIRED_EXTENSION", () => validateWorkGraph([
    work({ extensions: { "extension:missing": { required: true, value: { enabled: true } } } }),
  ]));
  negative("DUPLICATE_ID", () => validateWorkGraph([work()], [
    { id: "extension:risk", version: 1, requiredByDefault: false },
    { id: "extension:risk", version: 1, requiredByDefault: false },
  ]));
  negative("PATH_ESCAPE", () => assertExchangePath("../escape.json"));
  negative("CANONICALIZATION_MISMATCH", () => assertCanonicalJson("{ \"a\": 1 }\n"));
  negative("TOMBSTONE_REFERENCED", () => validateWorkGraph([
    work({ tombstone: true }),
    work({ id: "work:epic-a", externalKey: "EPIC-A", kind: "Epic", parentId: "work:initiative-alpha" }),
  ]));
  negative("REFERENTIAL_INTEGRITY", () => validateWorkGraph([
    work({ id: "work:epic-a", externalKey: "EPIC-A", kind: "Epic", parentId: "work:missing" }),
  ]));
  negative("GRAPH_PARENT_KIND_INVALID", () => validateWorkGraph([
    work(),
    work({ id: "work:story-a", externalKey: "STORY-A", kind: "Story", parentId: "work:initiative-alpha" }),
  ]));
  const replay = createEvent({
    id: "event:replay-1",
    streamId: "stream:replay",
    sequence: 1,
    occurredAt: "2026-07-11T02:00:00Z",
    priorHash: null,
    payload: { revision: 1 },
  });
  negative("EVENT_REPLAY", () => validateEventChain([replay, replay]));
  negative("EVENT_CHAIN_CORRUPT", () => validateEventChain([{ ...replay, eventHash: "0".repeat(64) }]));

  for (const path of ["/absolute.json", "a\\b.json", "a//b.json", "a/./b.json", "a/../b.json"]) {
    expectReason("PATH_ESCAPE", () => assertExchangePath(path));
  }
  assert.doesNotThrow(() => assertExchangePath("a/b.json"));

  const declared = await fixture("negative/cases.json");
  const covered = new Set(declared.cases.map((entry) => entry.expectedReasonCode));
  assert.deepEqual([...covered].sort(), [...PROTOCOL_REASON_CODES].sort());
  for (const reasonCode of observed) {
    assert.ok(PROTOCOL_REASON_CODES.includes(reasonCode));
    assert.ok(covered.has(reasonCode));
  }
  assert.ok(covered.has("EVENT_REPLAY"));
  assert.ok(covered.has("EVENT_CHAIN_CORRUPT"));
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
