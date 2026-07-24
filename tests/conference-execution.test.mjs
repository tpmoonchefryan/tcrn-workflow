// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXECUTION_MODES,
  MULTI_AGENT_DEFAULT_TYPES,
  HOST_EXECUTION_RECEIPT_VERSION,
  EXECUTION_MODE_EXTENSION_KEY,
  EXECUTION_RECEIPT_EXTENSION_KEY,
  validateHostExecutionReceipt,
  readExecutionMode,
  classifyConferenceExecution,
} from "../dist/build/packages/core/src/index.js";

const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/conference-execution-cases.json", import.meta.url), "utf8"));

function reason(code, operation) { assert.throws(operation, (error) => error?.reasonCode === code, code); }
function digest(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
const SHA0 = "0".repeat(64);

function receipt(overrides = {}) {
  return {
    schemaVersion: HOST_EXECUTION_RECEIPT_VERSION,
    id: "receipt:one", conferenceId: "conference:one", positionId: "position:one",
    hostProduct: "Claude Code", hostVersion: "2.1.201", sessionId: "session:s1",
    threadId: null, turnId: null, agentInvocationId: "agent:inv1", freshContext: true,
    invokedAt: "2026-07-24T00:00:00Z", promptDigest: SHA0, outputDigest: SHA0,
    availability: "observe", attributionNote: "content binding only; not identity proof",
    ...overrides,
  };
}
function requestLike(overrides = {}) {
  return { id: "conference:one", type: "architecture", extensions: {}, ...overrides };
}
function modeExt(mode, synthesisReason) {
  const value = synthesisReason === undefined ? { mode } : { mode, synthesisReason };
  return { [EXECUTION_MODE_EXTENSION_KEY]: { required: false, value } };
}
function positionLike(id, textValue, receiptId) {
  const extensions = receiptId === undefined ? {} : { [EXECUTION_RECEIPT_EXTENSION_KEY]: { required: false, value: { receiptId } } };
  return { id, conferenceId: "conference:one", position: textValue, extensions };
}

// Two genuinely independent, byte-bound positions for a valid multi-agent case.
function multiAgentInput(overrides = {}) {
  const posA = positionLike("position:a", "verity: proof discipline precedes expansion", "receipt:a");
  const posB = positionLike("position:b", "sable: authority stays on the pins track", "receipt:b");
  return {
    request: requestLike({ extensions: modeExt("multi-agent-deliberative") }),
    positions: [posA, posB],
    receipts: [
      receipt({ id: "receipt:a", positionId: "position:a", agentInvocationId: "agent:inva", outputDigest: digest(posA.position) }),
      receipt({ id: "receipt:b", positionId: "position:b", agentInvocationId: "agent:invb", outputDigest: digest(posB.position) }),
    ],
    ...overrides,
  };
}

test("host-execution receipt validates and rejects malformed receipts", () => {
  const positives = [
    () => assert.equal(validateHostExecutionReceipt(receipt()).schemaVersion, HOST_EXECUTION_RECEIPT_VERSION),
    () => assert.equal(validateHostExecutionReceipt(receipt({ threadId: "thread:t1", turnId: "turn:u1" })).threadId, "thread:t1"),
    () => assert.equal(validateHostExecutionReceipt(receipt({ availability: "invoke-only" })).availability, "invoke-only"),
  ];
  const hostiles = [
    () => reason("EXECUTION_RECEIPT_INVALID", () => validateHostExecutionReceipt(receipt({ schemaVersion: "tcrn.host-execution-receipt.v2" }))),
    () => reason("EXECUTION_RECEIPT_INVALID", () => validateHostExecutionReceipt({ ...receipt(), unexpected: 1 })),
    () => reason("EXECUTION_RECEIPT_INVALID", () => validateHostExecutionReceipt(receipt({ availability: "govern" }))),
    () => reason("EXECUTION_RECEIPT_INVALID", () => validateHostExecutionReceipt(receipt({ outputDigest: "not-a-digest" }))),
    () => reason("EXECUTION_RECEIPT_INVALID", () => validateHostExecutionReceipt(receipt({ freshContext: "yes" }))),
    () => reason("EXECUTION_RECEIPT_INVALID", () => validateHostExecutionReceipt(receipt({ threadId: "THREAD" }))),
    () => reason("EXECUTION_RECEIPT_INVALID", () => validateHostExecutionReceipt(receipt({ invokedAt: "not-an-instant" }))),
    () => reason("EXECUTION_RECEIPT_INVALID", () => validateHostExecutionReceipt(receipt({ promptDigest: "short" }))),
    () => reason("EXECUTION_UNICODE_INVALID", () => validateHostExecutionReceipt(receipt({ hostProduct: "" }))),
    () => reason("EXECUTION_BUDGET_EXCEEDED", () => validateHostExecutionReceipt(receipt({ attributionNote: "x".repeat(2049) }))),
  ];
  assert.equal(positives.length, fixture.receiptPositiveCases);
  assert.equal(hostiles.length, fixture.receiptHostileCases);
  for (const c of [...positives, ...hostiles]) c();
});

test("executionMode reads legacy as null and rejects malformed declarations", () => {
  const positives = [
    () => assert.equal(readExecutionMode(requestLike()), null),
    () => assert.equal(readExecutionMode(requestLike({ extensions: modeExt("synthesis-only", "single-context synthesis, no independent panel needed") })).mode, "synthesis-only"),
    () => assert.equal(readExecutionMode(requestLike({ extensions: modeExt("multi-agent-deliberative") })).mode, "multi-agent-deliberative"),
    () => assert.equal(readExecutionMode(requestLike({ extensions: modeExt("multi-agent-deliberative") })).synthesisReason, null),
  ];
  const hostiles = [
    () => reason("EXECUTION_MODE_INVALID", () => readExecutionMode(requestLike({ extensions: modeExt("synthesis") }))),
    () => reason("EXECUTION_MODE_INVALID", () => readExecutionMode(requestLike({ extensions: { [EXECUTION_MODE_EXTENSION_KEY]: { required: false, value: { mode: "synthesis-only", extra: 1 } } } }))),
    () => reason("EXECUTION_MODE_INVALID", () => readExecutionMode(requestLike({ extensions: { [EXECUTION_MODE_EXTENSION_KEY]: "not-an-object" } }))),
    () => reason("EXECUTION_MODE_INVALID", () => readExecutionMode(requestLike({ extensions: { [EXECUTION_MODE_EXTENSION_KEY]: { required: false, value: "not-an-object" } } }))),
  ];
  assert.equal(positives.length, fixture.modePositiveCases);
  assert.equal(hostiles.length, fixture.modeHostileCases);
  for (const c of [...positives, ...hostiles]) c();
});

test("classify substantiates a declared mode and fails closed otherwise", () => {
  const positives = [
    () => assert.equal(classifyConferenceExecution({ request: requestLike(), positions: [], receipts: [] }).mode, "legacy-unverified"),
    () => assert.equal(classifyConferenceExecution({ request: requestLike({ extensions: modeExt("synthesis-only", "single-context synthesis") }), positions: [], receipts: [] }).mode, "synthesis-only"),
    () => assert.equal(classifyConferenceExecution({ request: requestLike({ type: "risk", extensions: modeExt("synthesis-only") }), positions: [], receipts: [] }).mode, "synthesis-only"),
    () => assert.equal(classifyConferenceExecution(multiAgentInput()).mode, "multi-agent-deliberative"),
    () => assert.equal(classifyConferenceExecution(multiAgentInput()).independentPositions, 2),
    () => {
      const input = multiAgentInput();
      const noReceipt = { id: "position:c", conferenceId: "conference:one", position: "not bound to any receipt", extensions: {} };
      const otherConf = { id: "position:d", conferenceId: "conference:other", position: "belongs elsewhere", extensions: {} };
      const result = classifyConferenceExecution({ ...input, positions: [...input.positions, noReceipt, otherConf] });
      assert.equal(result.mode, "multi-agent-deliberative");
      assert.equal(result.independentPositions, 2);
    },
  ];
  const hostiles = [
    () => reason("EXECUTION_SYNTHESIS_UNMARKED", () => classifyConferenceExecution({ request: requestLike({ extensions: modeExt("synthesis-only") }), positions: [], receipts: [] })),
    () => reason("EXECUTION_BINDING_MISMATCH", () => {
      const input = multiAgentInput();
      input.receipts[0] = receipt({ id: "receipt:a", positionId: "position:a", conferenceId: "conference:other", agentInvocationId: "agent:inva", outputDigest: digest(input.positions[0].position) });
      classifyConferenceExecution(input);
    }),
    () => reason("EXECUTION_BINDING_MISMATCH", () => {
      const input = multiAgentInput();
      input.positions = [positionLike("position:a", input.positions[0].position, "receipt:missing"), input.positions[1]];
      classifyConferenceExecution(input);
    }),
    () => reason("EXECUTION_RECEIPT_INVALID", () => {
      const input = multiAgentInput();
      input.receipts[0] = receipt({ id: "receipt:a", positionId: "position:a", agentInvocationId: "agent:inva", freshContext: "true", outputDigest: digest(input.positions[0].position) });
      classifyConferenceExecution(input);
    }),
    () => reason("EXECUTION_INDEPENDENCE_REQUIRED", () => {
      const input = multiAgentInput();
      classifyConferenceExecution({ ...input, positions: [input.positions[0]] });
    }),
    () => reason("EXECUTION_INDEPENDENCE_REQUIRED", () => {
      const input = multiAgentInput();
      input.receipts[1] = receipt({ id: "receipt:b", positionId: "position:b", agentInvocationId: "agent:inva", outputDigest: digest(input.positions[1].position) });
      classifyConferenceExecution(input);
    }),
    () => reason("EXECUTION_BINDING_MISMATCH", () => {
      const input = multiAgentInput();
      input.receipts[0] = receipt({ id: "receipt:a", positionId: "position:a", agentInvocationId: "agent:inva", outputDigest: SHA0 });
      classifyConferenceExecution(input);
    }),
    () => reason("EXECUTION_BINDING_MISMATCH", () => {
      const input = multiAgentInput();
      input.receipts[0] = receipt({ id: "receipt:a", positionId: "position:z", agentInvocationId: "agent:inva", outputDigest: digest(input.positions[0].position) });
      classifyConferenceExecution(input);
    }),
    () => reason("EXECUTION_RECEIPT_STALE_CONTEXT", () => {
      const input = multiAgentInput();
      input.receipts[0] = receipt({ id: "receipt:a", positionId: "position:a", agentInvocationId: "agent:inva", freshContext: false, outputDigest: digest(input.positions[0].position) });
      classifyConferenceExecution(input);
    }),
  ];
  assert.equal(positives.length, fixture.classifyPositiveCases);
  assert.equal(hostiles.length, fixture.classifyHostileCases);
  for (const c of [...positives, ...hostiles]) c();
});

test("module constants match the fixture's declared intent", () => {
  assert.deepEqual([...EXECUTION_MODES], fixture.executionModes);
  assert.deepEqual([...MULTI_AGENT_DEFAULT_TYPES], fixture.defaultMultiAgentTypes);
  assert.equal(HOST_EXECUTION_RECEIPT_VERSION, fixture.hostExecutionReceiptVersion);
});
