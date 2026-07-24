// SPDX-License-Identifier: Apache-2.0
//
// INIT-010 EPIC-020 S055: collecting host-execution receipts from observed subagent
// invocations, and feeding them to the EPIC-019 classifier.
//
// The property that matters is the round trip: a receipt built from what a recorder
// OBSERVED must satisfy the classifier, and a position edited after the invocation
// must fail it. Everything else here guards the honesty of the claim -- duplicate
// invocations cannot manufacture independence, and no path ever reports a transcript
// as signed.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  COLLECTION_ATTRIBUTION_NOTE,
  EXECUTION_MODE_EXTENSION_KEY,
  EXECUTION_RECEIPT_EXTENSION_KEY,
  classifyConferenceExecution,
  collectConferenceReceipts,
  collectExecutionReceipt,
  validateHostExecutionReceipt,
  verifyCollectedTranscript,
} from "../dist/build/packages/core/src/index.js";

const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/act7-execution-collection-cases.json", import.meta.url), "utf8"));

function reason(code, operation) { assert.throws(operation, (error) => error?.reasonCode === code, code); }
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const CONTEXT = {
  hostProduct: "Claude Code",
  hostVersion: "2.1.201",
  sessionId: "session:s1",
  conferenceId: "conference:one",
  availability: "observe",
};

const TRANSCRIPT_A = '{"role":"assistant","text":"verity position"}\n';
const TRANSCRIPT_B = '{"role":"assistant","text":"sable position"}\n';

function observed(overrides = {}) {
  const finalMessage = overrides.finalMessage ?? "verity: proof discipline precedes expansion";
  const transcript = overrides.transcript ?? TRANSCRIPT_A;
  const base = {
    agentInvocationId: "agent:inva",
    startedAt: "2026-07-25T00:00:00Z",
    endedAt: "2026-07-25T00:01:00Z",
    freshContext: true,
    promptDigest: digest("the prompt"),
    finalMessage,
    transcriptPath: "/sessions/a.jsonl",
    transcriptDigest: digest(transcript),
    transcriptBytes: Buffer.byteLength(transcript, "utf8"),
  };
  const { transcript: _t, ...rest } = overrides;
  return { ...base, ...rest, finalMessage };
}

test("a collected receipt binds the observed invocation and never claims a signature", () => {
  const collected = collectExecutionReceipt(observed(), "position:a", "receipt:a", CONTEXT);
  assert.equal(validateHostExecutionReceipt(collected.receipt).id, "receipt:a");
  assert.equal(collected.receipt.agentInvocationId, "agent:inva");
  assert.equal(collected.receipt.freshContext, true);
  // outputDigest is the digest of what the invocation actually returned.
  assert.equal(collected.receipt.outputDigest, digest("verity: proof discipline precedes expansion"));
  // The transcript binding is recorded at observation time.
  assert.equal(collected.transcriptDigest, digest(TRANSCRIPT_A));
  assert.equal(collected.transcriptBytes, Buffer.byteLength(TRANSCRIPT_A, "utf8"));
  // Nothing here is ever presented as host-signed.
  assert.equal(collected.transcriptSigned, false);
  assert.equal(collected.receipt.attributionNote, COLLECTION_ATTRIBUTION_NOTE);
  assert.ok(collected.receipt.attributionNote.includes("not identity proof"));
  assert.ok(collected.receipt.attributionNote.includes("not host-signed"));
});

test("collected receipts satisfy the EPIC-019 classifier end to end", () => {
  const positionA = "verity: proof discipline precedes expansion";
  const positionB = "sable: authority stays on the pins track";
  const result = collectConferenceReceipts([
    { positionId: "position:a", receiptId: "receipt:a", observed: observed() },
    { positionId: "position:b", receiptId: "receipt:b", observed: observed({ agentInvocationId: "agent:invb", finalMessage: positionB, transcript: TRANSCRIPT_B, transcriptPath: "/sessions/b.jsonl" }) },
  ], CONTEXT);

  assert.equal(result.receipts.length, 2);
  assert.equal(result.distinctInvocations, 2);
  assert.equal(result.transcriptsSigned, false);

  // The classifier accepts the collected receipts: this is the seam S055 exists to
  // close -- receipts now come from an observation rather than from an author.
  const classification = classifyConferenceExecution({
    request: {
      id: "conference:one",
      type: "architecture",
      extensions: { [EXECUTION_MODE_EXTENSION_KEY]: { required: false, value: { mode: "multi-agent-deliberative" } } },
    },
    positions: [
      { id: "position:a", conferenceId: "conference:one", position: positionA, extensions: { [EXECUTION_RECEIPT_EXTENSION_KEY]: { required: false, value: { receiptId: "receipt:a" } } } },
      { id: "position:b", conferenceId: "conference:one", position: positionB, extensions: { [EXECUTION_RECEIPT_EXTENSION_KEY]: { required: false, value: { receiptId: "receipt:b" } } } },
    ],
    receipts: result.receipts.map((entry) => entry.receipt),
  });
  assert.equal(classification.mode, "multi-agent-deliberative");
  assert.equal(classification.independentPositions, 2);
});

test("a position edited after its invocation fails the binding", () => {
  const result = collectConferenceReceipts([
    { positionId: "position:a", receiptId: "receipt:a", observed: observed() },
    { positionId: "position:b", receiptId: "receipt:b", observed: observed({ agentInvocationId: "agent:invb", finalMessage: "sable: authority stays on the pins track", transcript: TRANSCRIPT_B }) },
  ], CONTEXT);

  reason("EXECUTION_BINDING_MISMATCH", () => classifyConferenceExecution({
    request: { id: "conference:one", type: "architecture", extensions: { [EXECUTION_MODE_EXTENSION_KEY]: { required: false, value: { mode: "multi-agent-deliberative" } } } },
    positions: [
      // The recorded position no longer matches what the invocation returned.
      { id: "position:a", conferenceId: "conference:one", position: "verity: an opinion nobody actually produced", extensions: { [EXECUTION_RECEIPT_EXTENSION_KEY]: { required: false, value: { receiptId: "receipt:a" } } } },
      { id: "position:b", conferenceId: "conference:one", position: "sable: authority stays on the pins track", extensions: { [EXECUTION_RECEIPT_EXTENSION_KEY]: { required: false, value: { receiptId: "receipt:b" } } } },
    ],
    receipts: result.receipts.map((entry) => entry.receipt),
  }));
});

test("collection refuses to manufacture independence or accept malformed observations", () => {
  const cases = [
    // Two positions attributed to the SAME invocation would fake independence.
    () => reason("COLLECTION_DUPLICATE_INVOCATION", () => collectConferenceReceipts([
      { positionId: "position:a", receiptId: "receipt:a", observed: observed() },
      { positionId: "position:b", receiptId: "receipt:b", observed: observed({ finalMessage: "different text" }) },
    ], CONTEXT)),
    // The same position collected twice.
    () => reason("COLLECTION_BINDING_MISMATCH", () => collectConferenceReceipts([
      { positionId: "position:a", receiptId: "receipt:a", observed: observed() },
      { positionId: "position:a", receiptId: "receipt:b", observed: observed({ agentInvocationId: "agent:invb" }) },
    ], CONTEXT)),
    // Malformed observations fail closed rather than producing a partial receipt.
    () => reason("COLLECTION_SCHEMA_INVALID", () => collectExecutionReceipt({ ...observed(), unexpected: 1 }, "position:a", "receipt:a", CONTEXT)),
    () => reason("COLLECTION_SCHEMA_INVALID", () => collectExecutionReceipt(observed({ freshContext: "yes" }), "position:a", "receipt:a", CONTEXT)),
    () => reason("COLLECTION_SCHEMA_INVALID", () => collectExecutionReceipt(observed({ transcriptDigest: "short" }), "position:a", "receipt:a", CONTEXT)),
    () => reason("COLLECTION_SCHEMA_INVALID", () => collectExecutionReceipt(observed({ transcriptBytes: -1 }), "position:a", "receipt:a", CONTEXT)),
    () => reason("COLLECTION_UNICODE_INVALID", () => collectExecutionReceipt(observed({ finalMessage: "" }), "position:a", "receipt:a", CONTEXT)),
  ];
  assert.equal(cases.length, fixture.refusalCases);
  for (const operation of cases) operation();
});

test("a transcript edited after observation reports drift, and is never reported as signed", () => {
  const collected = collectExecutionReceipt(observed(), "position:a", "receipt:a", CONTEXT);
  const unchanged = verifyCollectedTranscript(collected, TRANSCRIPT_A);
  assert.equal(unchanged.matches, true);
  assert.equal(unchanged.transcriptSigned, false);

  const edited = verifyCollectedTranscript(collected, TRANSCRIPT_A.replace("verity position", "something else"));
  assert.equal(edited.matches, false);
  // Even when the digest matches, the transcript is never presented as host-signed:
  // this layer proves the file did not change since it was seen, nothing more.
  assert.equal(edited.transcriptSigned, false);
});

test("an observation with a non-fresh context cannot substantiate a multi-agent claim", () => {
  const result = collectConferenceReceipts([
    { positionId: "position:a", receiptId: "receipt:a", observed: observed({ freshContext: false }) },
    { positionId: "position:b", receiptId: "receipt:b", observed: observed({ agentInvocationId: "agent:invb", finalMessage: "sable: authority stays on the pins track", transcript: TRANSCRIPT_B }) },
  ], CONTEXT);
  assert.equal(result.receipts[0].receipt.freshContext, false);

  reason("EXECUTION_RECEIPT_STALE_CONTEXT", () => classifyConferenceExecution({
    request: { id: "conference:one", type: "architecture", extensions: { [EXECUTION_MODE_EXTENSION_KEY]: { required: false, value: { mode: "multi-agent-deliberative" } } } },
    positions: [
      { id: "position:a", conferenceId: "conference:one", position: "verity: proof discipline precedes expansion", extensions: { [EXECUTION_RECEIPT_EXTENSION_KEY]: { required: false, value: { receiptId: "receipt:a" } } } },
      { id: "position:b", conferenceId: "conference:one", position: "sable: authority stays on the pins track", extensions: { [EXECUTION_RECEIPT_EXTENSION_KEY]: { required: false, value: { receiptId: "receipt:b" } } } },
    ],
    receipts: result.receipts.map((entry) => entry.receipt),
  }));
});

test("the fixture pins the honesty boundary this proof claims", () => {
  assert.equal(fixture.schemaVersion, "tcrn.act7-execution-collection-cases.v1");
  assert.equal(fixture.transcriptsSigned, false);
  assert.equal(fixture.attributionNotIdentity, true);
  assert.equal(fixture.collectorSharesAgentAuthority, true);
  assert.equal(fixture.liveHostProof, "not-claimed-per-min-046");
});
