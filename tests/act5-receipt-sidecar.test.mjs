// SPDX-License-Identifier: Apache-2.0
//
// INIT-009 EPIC-024 S068: the bounded, prunable observe-receipt sidecar.
//
// The load-bearing property under MIN-046 is the coverage discipline: a fail-open
// recorder is silent both when nothing happened and when it broke, so no code path
// may report `complete` on anything but a batch that was opened and sealed. These
// cases exist to make that inexpressible rather than merely discouraged.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OBSERVE_HOOK_EVENTS,
  RECEIPT_COVERAGE_NOTE,
  RECEIPT_LIMITS,
  anchorReceiptBatch,
  appendReceipt,
  openReceiptBatch,
  pruneReceiptBatches,
  sealReceiptBatch,
  validateReceiptAnchor,
  validateReceiptBatch,
  verifyAnchorAgainstBatch,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/act5-receipt-sidecar-cases.json", import.meta.url), "utf8"));

function reason(code, operation) { assert.throws(operation, (error) => error?.reasonCode === code, code); }

function batch(overrides = {}) {
  return openReceiptBatch({
    batchId: "batch:one", hostProduct: "Claude Code", hostVersion: "2.1.201",
    sessionId: "session:s1", workspaceId: "workspace:w1", openedAt: "2026-07-25T00:00:00Z",
    ...overrides,
  });
}
function entry(overrides = {}) {
  return { event: "PostToolUse", occurredAt: "2026-07-25T00:00:01Z", summary: "ran a shell tool", ...overrides };
}

test("a batch records hook events in a verifiable hash chain", () => {
  let current = batch();
  assert.equal(current.entries.length, 0);
  assert.equal(current.coverage, "unknown");

  current = appendReceipt(current, entry());
  current = appendReceipt(current, entry({ event: "SessionEnd", summary: "session ended", occurredAt: "2026-07-25T00:00:02Z" }));
  assert.equal(current.entries.length, 2);
  assert.equal(current.entries[0].priorDigest, "0".repeat(64));
  assert.equal(current.entries[1].priorDigest, current.entries[0].entryDigest);
  assert.equal(current.entries[1].sequence, 2);
  // Round-trips through validation.
  assert.equal(validateReceiptBatch(JSON.parse(canonicalJson(current))).batchDigest, current.batchDigest);
});

test("only sealing can claim complete coverage, and an unsealed batch never can", () => {
  const open = appendReceipt(batch(), entry());
  assert.equal(open.coverage, "unknown");
  assert.equal(open.sealedAt, null);

  const sealed = sealReceiptBatch(open, "2026-07-25T01:00:00Z");
  assert.equal(sealed.coverage, "complete");
  assert.equal(sealed.sealedAt, "2026-07-25T01:00:00Z");

  // A hand-forged "complete" batch that was never sealed is refused: the whole point
  // of the classification is that it cannot be asserted, only earned.
  const forged = { ...open, coverage: "complete" };
  reason("RECEIPT_COVERAGE_UNPROVEN", () => validateReceiptBatch(forged));

  // An EMPTY sealed batch is complete-but-empty, which is a real state: the recorder
  // ran and saw nothing. It is distinguishable from an unsealed empty batch, which is
  // the case where the recorder may simply have died.
  const emptySealed = sealReceiptBatch(batch({ batchId: "batch:empty" }), "2026-07-25T01:00:00Z");
  assert.equal(emptySealed.coverage, "complete");
  assert.equal(emptySealed.entries.length, 0);
  assert.equal(validateReceiptBatch(batch({ batchId: "batch:live" })).coverage, "unknown");

  reason("RECEIPT_BATCH_SEALED", () => appendReceipt(sealed, entry()));
  reason("RECEIPT_BATCH_SEALED", () => sealReceiptBatch(sealed, "2026-07-25T02:00:00Z"));
});

test("the chain detects removal, reordering and mutation of any entry", () => {
  let current = batch();
  for (const index of [1, 2, 3]) current = appendReceipt(current, entry({ summary: `call ${index}`, occurredAt: `2026-07-25T00:00:0${index}Z` }));

  const cases = [
    // Dropping the middle entry breaks both the sequence and the prior-digest link.
    () => reason("RECEIPT_CHAIN_BROKEN", () => validateReceiptBatch({ ...current, entries: [current.entries[0], current.entries[2]] })),
    // Reordering breaks the link.
    () => reason("RECEIPT_CHAIN_BROKEN", () => validateReceiptBatch({ ...current, entries: [current.entries[1], current.entries[0], current.entries[2]] })),
    // Editing a summary invalidates that entry's digest.
    () => reason("RECEIPT_CHAIN_BROKEN", () => validateReceiptBatch({ ...current, entries: [{ ...current.entries[0], summary: "something else" }, current.entries[1], current.entries[2]] })),
    // Editing the batch digest is caught.
    () => reason("RECEIPT_CHAIN_BROKEN", () => validateReceiptBatch({ ...current, batchDigest: "0".repeat(64) })),
  ];
  assert.equal(cases.length, fixture.chainCases);
  for (const operation of cases) operation();
});

test("the enumerated observe surface is closed and budgets are enforced", () => {
  const cases = [
    // MIN-046: anything not enumerated is refused. PreToolUse is an ENFORCE event and
    // was explicitly NOT amended, so it must be rejected here.
    () => reason("RECEIPT_EVENT_UNKNOWN", () => appendReceipt(batch(), entry({ event: "PreToolUse" }))),
    () => reason("RECEIPT_EVENT_UNKNOWN", () => appendReceipt(batch(), entry({ event: "Stop" }))),
    () => reason("RECEIPT_EVENT_UNKNOWN", () => appendReceipt(batch(), entry({ event: "PermissionRequest" }))),
    // Over-budget summary and detail are refused rather than truncated.
    () => reason("RECEIPT_BUDGET_EXCEEDED", () => appendReceipt(batch(), entry({ summary: "x".repeat(RECEIPT_LIMITS.summaryBytes + 1) }))),
    () => reason("RECEIPT_BUDGET_EXCEEDED", () => appendReceipt(batch(), entry({ detail: "x".repeat(RECEIPT_LIMITS.detailBytes + 1) }))),
    // Malformed instants and unknown fields fail closed.
    () => reason("RECEIPT_SCHEMA_INVALID", () => appendReceipt(batch(), entry({ occurredAt: "yesterday" }))),
    () => reason("RECEIPT_SCHEMA_INVALID", () => appendReceipt(batch(), { ...entry(), unexpected: 1 })),
  ];
  assert.equal(cases.length, fixture.closedSurfaceCases);
  for (const operation of cases) operation();

  // A detail payload is retained only as a digest -- a receipt is never a transcript.
  const withDetail = appendReceipt(batch(), entry({ detail: "the full tool output" }));
  assert.equal(withDetail.entries[0].detailDigest, createHash("sha256").update(canonicalJson("the full tool output"), "utf8").digest("hex"));
  assert.equal(JSON.stringify(withDetail).includes("the full tool output"), false);
});

test("a batch seals rather than growing past its entry budget", () => {
  let current = batch();
  for (let index = 0; index < RECEIPT_LIMITS.entriesPerBatch; index += 1) {
    current = appendReceipt(current, entry({ summary: `call ${index}` }));
  }
  assert.equal(current.entries.length, RECEIPT_LIMITS.entriesPerBatch);
  reason("RECEIPT_BATCH_FULL", () => appendReceipt(current, entry()));
});

test("the anchor is a bounded summary that binds its batch and states the coverage caveat", () => {
  let current = batch();
  current = appendReceipt(current, entry());
  current = appendReceipt(current, entry({ event: "SubagentStop", summary: "subagent finished", occurredAt: "2026-07-25T00:00:03Z" }));
  const sealed = sealReceiptBatch(current, "2026-07-25T01:00:00Z");
  const anchor = anchorReceiptBatch(sealed);

  assert.equal(anchor.entryCount, 2);
  assert.deepEqual(anchor.eventCounts, { PostToolUse: 1, SubagentStop: 1 });
  assert.equal(anchor.coverage, "complete");
  assert.equal(anchor.batchDigest, sealed.batchDigest);
  // Per-host identity travels with the anchor so a Claude batch can never be counted
  // as Codex coverage.
  assert.equal(anchor.hostProduct, "Claude Code");
  assert.equal(anchor.hostVersion, "2.1.201");
  // The caveat is a fixed constant no caller can soften.
  assert.equal(anchor.coverageNote, RECEIPT_COVERAGE_NOTE);
  assert.ok(anchor.coverageNote.includes("not evidence"));
  // The anchor is bounded: it carries counts, never the entries.
  assert.equal(JSON.stringify(anchor).includes("ran a shell tool"), false);
  assert.ok(Buffer.byteLength(canonicalJson(anchor), "utf8") < 1024);

  assert.equal(validateReceiptAnchor(JSON.parse(canonicalJson(anchor))).anchorDigest, anchor.anchorDigest);
  assert.equal(verifyAnchorAgainstBatch(anchor, sealed).batchId, "batch:one");

  const anchorCases = [
    // An anchor whose coverage was upgraded no longer matches its digest.
    () => reason("RECEIPT_ANCHOR_MISMATCH", () => validateReceiptAnchor({ ...anchor, coverage: "unknown" })),
    // The caveat cannot be removed or reworded.
    () => reason("RECEIPT_SCHEMA_INVALID", () => validateReceiptAnchor({ ...anchor, coverageNote: "all tool uses recorded" })),
    // An anchor cannot be re-pointed at a different batch.
    () => reason("RECEIPT_ANCHOR_MISMATCH", () => verifyAnchorAgainstBatch(anchor, sealReceiptBatch(batch({ batchId: "batch:other" }), "2026-07-25T01:00:00Z"))),
  ];
  assert.equal(anchorCases.length, fixture.anchorCases);
  for (const operation of anchorCases) operation();
});

test("pruning drops whole sealed batches, keeps the live one, and returns their anchors", () => {
  const sealedBatches = ["a", "b", "c"].map((suffix, index) =>
    sealReceiptBatch(
      appendReceipt(batch({ batchId: `batch:${suffix}`, openedAt: `2026-07-25T0${index}:00:00Z` }), entry()),
      `2026-07-25T0${index}:30:00Z`,
    ));
  const live = appendReceipt(batch({ batchId: "batch:live", openedAt: "2026-07-25T04:00:00Z" }), entry());

  const result = pruneReceiptBatches([...sealedBatches, live], 1);
  // Oldest two sealed batches dropped; newest sealed plus the live batch retained.
  assert.deepEqual(result.prunedBatchIds, ["batch:a", "batch:b"]);
  assert.deepEqual(result.retained.map((value) => value.batchId).sort(), ["batch:c", "batch:live"]);
  // A retained batch still verifies -- pruning never reaches inside a batch.
  for (const retained of result.retained) assert.equal(validateReceiptBatch(retained).batchDigest, retained.batchDigest);
  // Every pruned batch leaves an anchor, so the record that it existed survives.
  assert.equal(result.retainedAnchors.length, 2);
  for (const anchor of result.retainedAnchors) assert.equal(validateReceiptAnchor(anchor).entryCount, 1);
  // The live batch is never pruned however small the keep count.
  assert.equal(pruneReceiptBatches([live], 0).prunedBatchIds.length, 0);
});

test("the fixture pins the surface and the coverage discipline this proof claims", () => {
  assert.equal(fixture.schemaVersion, "tcrn.act5-receipt-sidecar-cases.v1");
  assert.deepEqual([...OBSERVE_HOOK_EVENTS], fixture.observeEvents);
  assert.equal(fixture.enforceEventsRefused, true);
  assert.equal(fixture.missingReceiptIsNotMissingEvent, true);
  assert.equal(fixture.liveHostProof, "not-claimed-per-min-046");
});
