// SPDX-License-Identifier: Apache-2.0
//
// INIT-009 EPIC-024 S068: the bounded, prunable receipt sidecar that observe hooks
// append to, and the anchor that binds a batch to the main event chain.
//
// Why a sidecar and not the main chain. The main chain is hash-linked, uncompacted,
// and slows perceptibly in the low thousands of events (README, "Known limits"). A
// per-tool-call receipt stream would exhaust that budget in a single session. So
// receipts live in their own append-only batches, and only a BATCH ANCHOR -- a
// bounded summary plus the batch digest -- is eligible for the main chain. One
// governed record per turn, not one per tool call.
//
// What MIN-046 (the N-2 amendment) binds into this design, and why each is here:
//
//   * Observe receipts are fail-open. A recorder that breaks is silent, and so is a
//     session where nothing happened. Therefore a batch carries an explicit
//     `coverage` classification and every anchor states it: `complete` only when the
//     batch was opened AND sealed by the same generation, otherwise `unknown`. A
//     missing receipt is NEVER evidence that an event did not occur, and nothing in
//     this module will report `complete` on the strength of an empty batch.
//   * Evidence is per host. Every batch names its host product and version, so a
//     Claude batch can never be counted as Codex coverage.
//   * Bounded and prunable. A batch caps entry count and byte size; when full it
//     seals rather than growing without limit. Pruning drops whole sealed batches --
//     never individual entries -- so a retained batch's digest still verifies.
//
// This module is pure: it validates, links and digests. It performs no IO, opens no
// hook, and reads no host. Wiring a real hook to it is S069 and later, each gated on
// its own per-host live receipt under MIN-046.

import { createHash } from "node:crypto";

import { canonicalJson, canonicalSha256, assertProtocolId, compareCanonicalText, parseStrictInstant } from "../../protocol/src/index.js";

export const RECEIPT_ENTRY_VERSION = "tcrn.observe-receipt.v1" as const;
export const RECEIPT_BATCH_VERSION = "tcrn.observe-receipt-batch.v1" as const;
export const RECEIPT_ANCHOR_VERSION = "tcrn.observe-receipt-anchor.v1" as const;

// The observe surface MIN-046 enumerated. Anything not listed is refused: widening
// the list is a new ruling, never an implementation decision.
export const OBSERVE_HOOK_EVENTS = Object.freeze([
  "PostToolUse",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
] as const);
export type ObserveHookEvent = typeof OBSERVE_HOOK_EVENTS[number];

// `complete` is only ever asserted by sealBatch for a batch it opened and sealed in
// one generation. Everything else -- a batch recovered from disk, a batch whose
// recorder may have died, an empty batch -- is `unknown`. There is deliberately no
// value meaning "nothing happened", because this layer cannot distinguish that from
// "the recorder stopped".
export const RECEIPT_COVERAGE = Object.freeze(["complete", "unknown"] as const);
export type ReceiptCoverage = typeof RECEIPT_COVERAGE[number];

export const RECEIPT_LIMITS = Object.freeze({
  entriesPerBatch: 512,
  batchBytes: 262_144,
  summaryBytes: 1_024,
  detailBytes: 4_096,
});

export const RECEIPT_REASON_CODES = Object.freeze([
  "RECEIPT_SCHEMA_INVALID",
  "RECEIPT_EVENT_UNKNOWN",
  "RECEIPT_UNICODE_INVALID",
  "RECEIPT_BUDGET_EXCEEDED",
  "RECEIPT_BATCH_FULL",
  "RECEIPT_BATCH_SEALED",
  "RECEIPT_CHAIN_BROKEN",
  "RECEIPT_ANCHOR_MISMATCH",
  "RECEIPT_COVERAGE_UNPROVEN",
  "RECEIPT_VALIDATED",
] as const);
export type ReceiptReasonCode = typeof RECEIPT_REASON_CODES[number];

export class ReceiptError extends Error {
  readonly reasonCode: ReceiptReasonCode;
  constructor(reasonCode: ReceiptReasonCode, message: string) {
    super(message);
    this.name = "ReceiptError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: ReceiptReasonCode, message: string): never {
  throw new ReceiptError(reasonCode, message);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("RECEIPT_SCHEMA_INVALID", label);
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  if (actual.length !== wanted.length || wanted.some((field, index) => field !== actual[index])) fail("RECEIPT_SCHEMA_INVALID", `${label}: field set`);
}

function id(value: unknown, label: string): string {
  try { assertProtocolId(value); } catch { fail("RECEIPT_SCHEMA_INVALID", label); }
  return value as string;
}

function text(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.length === 0) fail("RECEIPT_UNICODE_INVALID", label);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) fail("RECEIPT_BUDGET_EXCEEDED", label);
  return value;
}

function instant(value: unknown, label: string): string {
  try { parseStrictInstant(value); } catch { fail("RECEIPT_SCHEMA_INVALID", label); }
  return value as string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function entryDigest(basis: unknown): string {
  return createHash("sha256").update(canonicalJson(basis), "utf8").digest("hex");
}

export interface ObserveReceipt {
  readonly schemaVersion: typeof RECEIPT_ENTRY_VERSION;
  readonly sequence: number;
  readonly event: ObserveHookEvent;
  readonly occurredAt: string;
  readonly summary: string;
  readonly detailDigest: string | null;
  readonly priorDigest: string;
  readonly entryDigest: string;
}

export interface AppendReceiptInput {
  readonly event: string;
  readonly occurredAt: string;
  readonly summary: string;
  // The full payload, when the caller has one. Only its digest is retained: a
  // receipt is a bounded summary plus a binding, never a transcript.
  readonly detail?: string;
}

export interface ReceiptBatch {
  readonly schemaVersion: typeof RECEIPT_BATCH_VERSION;
  readonly batchId: string;
  readonly hostProduct: string;
  readonly hostVersion: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly openedAt: string;
  readonly sealedAt: string | null;
  readonly coverage: ReceiptCoverage;
  readonly entries: readonly ObserveReceipt[];
  readonly batchDigest: string;
}

export interface OpenBatchInput {
  readonly batchId: string;
  readonly hostProduct: string;
  readonly hostVersion: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly openedAt: string;
}

// The digest basis is rebuilt field by field rather than by deleting a key: an
// explicit `batchDigest: undefined` is not representable in canonical JSON, so
// spreading a digested batch and blanking the field would fail closed on encoding.
interface BatchFields {
  readonly batchId: string;
  readonly hostProduct: string;
  readonly hostVersion: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly openedAt: string;
  readonly sealedAt: string | null;
  readonly coverage: ReceiptCoverage;
  readonly entries: readonly ObserveReceipt[];
}

function batchBasis(batch: BatchFields): Omit<ReceiptBatch, "batchDigest"> {
  return {
    schemaVersion: RECEIPT_BATCH_VERSION,
    batchId: batch.batchId,
    hostProduct: batch.hostProduct,
    hostVersion: batch.hostVersion,
    sessionId: batch.sessionId,
    workspaceId: batch.workspaceId,
    openedAt: batch.openedAt,
    sealedAt: batch.sealedAt,
    coverage: batch.coverage,
    entries: batch.entries,
  };
}

function withDigest(batch: BatchFields): ReceiptBatch {
  const basis = batchBasis(batch);
  return deepFreeze({ ...basis, batchDigest: canonicalSha256(basis) });
}

// A newly opened batch is `unknown` until it is sealed: an open batch cannot claim
// completeness, because the recorder may stop at any moment.
export function openReceiptBatch(input: OpenBatchInput): ReceiptBatch {
  const document = record(input, "open batch input");
  exact(document, ["batchId", "hostProduct", "hostVersion", "sessionId", "workspaceId", "openedAt"], "open batch input");
  return withDigest({
    batchId: id(document.batchId, "batchId"),
    hostProduct: text(document.hostProduct, "hostProduct", RECEIPT_LIMITS.summaryBytes),
    hostVersion: text(document.hostVersion, "hostVersion", RECEIPT_LIMITS.summaryBytes),
    sessionId: id(document.sessionId, "sessionId"),
    workspaceId: id(document.workspaceId, "workspaceId"),
    openedAt: instant(document.openedAt, "openedAt"),
    sealedAt: null,
    coverage: "unknown",
    entries: [],
  });
}

// Append one observe receipt. The entry is hash-linked to its predecessor so a
// removed or reordered entry is detectable, and the batch refuses to grow past its
// entry-count or byte budget: it seals instead (RECEIPT_BATCH_FULL tells the caller
// to open the next batch, which is a normal rotation, not a failure of the session).
export function appendReceipt(batchValue: unknown, input: AppendReceiptInput): ReceiptBatch {
  const batch = validateReceiptBatch(batchValue);
  if (batch.sealedAt !== null) fail("RECEIPT_BATCH_SEALED", batch.batchId);
  const document = record(input, "append input");
  const fields = document.detail === undefined
    ? ["event", "occurredAt", "summary"]
    : ["event", "occurredAt", "summary", "detail"];
  exact(document, fields, "append input");
  if (!(OBSERVE_HOOK_EVENTS as readonly string[]).includes(document.event as string)) fail("RECEIPT_EVENT_UNKNOWN", String(document.event));
  if (batch.entries.length >= RECEIPT_LIMITS.entriesPerBatch) fail("RECEIPT_BATCH_FULL", batch.batchId);

  const priorDigest = batch.entries.length === 0 ? "0".repeat(64) : (batch.entries[batch.entries.length - 1] as ObserveReceipt).entryDigest;
  const basis = {
    schemaVersion: RECEIPT_ENTRY_VERSION,
    sequence: batch.entries.length + 1,
    event: document.event as ObserveHookEvent,
    occurredAt: instant(document.occurredAt, "occurredAt"),
    summary: text(document.summary, "summary", RECEIPT_LIMITS.summaryBytes),
    detailDigest: document.detail === undefined ? null : entryDigest(text(document.detail, "detail", RECEIPT_LIMITS.detailBytes)),
    priorDigest,
  };
  const entry: ObserveReceipt = { ...basis, entryDigest: entryDigest(basis) };
  const candidate = withDigest({ ...batch, entries: [...batch.entries, entry] });
  if (Buffer.byteLength(canonicalJson(candidate), "utf8") > RECEIPT_LIMITS.batchBytes) fail("RECEIPT_BATCH_FULL", `${batch.batchId}: byte budget`);
  return candidate;
}

// Sealing is the ONLY way a batch becomes `complete`, and only the generation that
// opened it may do so -- that is what makes `complete` mean "this recorder ran from
// open to close", rather than "these are all the events that happened".
export function sealReceiptBatch(batchValue: unknown, sealedAt: string): ReceiptBatch {
  const batch = validateReceiptBatch(batchValue);
  if (batch.sealedAt !== null) fail("RECEIPT_BATCH_SEALED", batch.batchId);
  return withDigest({ ...batch, sealedAt: instant(sealedAt, "sealedAt"), coverage: "complete" as const });
}

export function validateReceiptBatch(value: unknown): ReceiptBatch {
  const document = record(value, "receipt batch");
  if (document.schemaVersion !== RECEIPT_BATCH_VERSION) fail("RECEIPT_SCHEMA_INVALID", "batch schemaVersion");
  exact(document, ["schemaVersion", "batchId", "hostProduct", "hostVersion", "sessionId", "workspaceId", "openedAt", "sealedAt", "coverage", "entries", "batchDigest"], "receipt batch");
  if (!Array.isArray(document.entries)) fail("RECEIPT_SCHEMA_INVALID", "entries");
  if (document.entries.length > RECEIPT_LIMITS.entriesPerBatch) fail("RECEIPT_BUDGET_EXCEEDED", "entries");
  if (!(RECEIPT_COVERAGE as readonly string[]).includes(document.coverage as string)) fail("RECEIPT_SCHEMA_INVALID", "coverage");
  const sealedAt = document.sealedAt === null ? null : instant(document.sealedAt, "sealedAt");
  // An unsealed batch may never claim completeness, however it was assembled.
  if (sealedAt === null && document.coverage === "complete") fail("RECEIPT_COVERAGE_UNPROVEN", "unsealed batch claims complete coverage");

  let priorDigest = "0".repeat(64);
  const entries = document.entries.map((value, index) => {
    const item = record(value, `entries[${index}]`);
    if (item.schemaVersion !== RECEIPT_ENTRY_VERSION) fail("RECEIPT_SCHEMA_INVALID", `entries[${index}].schemaVersion`);
    exact(item, ["schemaVersion", "sequence", "event", "occurredAt", "summary", "detailDigest", "priorDigest", "entryDigest"], `entries[${index}]`);
    if (item.sequence !== index + 1) fail("RECEIPT_CHAIN_BROKEN", `entries[${index}].sequence`);
    if (!(OBSERVE_HOOK_EVENTS as readonly string[]).includes(item.event as string)) fail("RECEIPT_EVENT_UNKNOWN", `entries[${index}].event`);
    if (item.priorDigest !== priorDigest) fail("RECEIPT_CHAIN_BROKEN", `entries[${index}].priorDigest`);
    const detailDigest = item.detailDigest === null ? null : (typeof item.detailDigest === "string" && /^[a-f0-9]{64}$/u.test(item.detailDigest) ? item.detailDigest : fail("RECEIPT_SCHEMA_INVALID", `entries[${index}].detailDigest`));
    const basis = {
      schemaVersion: RECEIPT_ENTRY_VERSION,
      sequence: item.sequence as number,
      event: item.event as ObserveHookEvent,
      occurredAt: instant(item.occurredAt, `entries[${index}].occurredAt`),
      summary: text(item.summary, `entries[${index}].summary`, RECEIPT_LIMITS.summaryBytes),
      detailDigest,
      priorDigest,
    };
    const expected = entryDigest(basis);
    if (item.entryDigest !== expected) fail("RECEIPT_CHAIN_BROKEN", `entries[${index}].entryDigest`);
    priorDigest = expected;
    return deepFreeze({ ...basis, entryDigest: expected });
  });

  const basis = {
    schemaVersion: RECEIPT_BATCH_VERSION,
    batchId: id(document.batchId, "batchId"),
    hostProduct: text(document.hostProduct, "hostProduct", RECEIPT_LIMITS.summaryBytes),
    hostVersion: text(document.hostVersion, "hostVersion", RECEIPT_LIMITS.summaryBytes),
    sessionId: id(document.sessionId, "sessionId"),
    workspaceId: id(document.workspaceId, "workspaceId"),
    openedAt: instant(document.openedAt, "openedAt"),
    sealedAt,
    coverage: document.coverage as ReceiptCoverage,
    entries,
  };
  if (document.batchDigest !== canonicalSha256(basis)) fail("RECEIPT_CHAIN_BROKEN", "batchDigest");
  return deepFreeze({ ...basis, batchDigest: document.batchDigest as string });
}

export interface ReceiptAnchor {
  readonly schemaVersion: typeof RECEIPT_ANCHOR_VERSION;
  readonly batchId: string;
  readonly batchDigest: string;
  readonly hostProduct: string;
  readonly hostVersion: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly openedAt: string;
  readonly sealedAt: string | null;
  readonly coverage: ReceiptCoverage;
  readonly entryCount: number;
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly coverageNote: string;
  readonly anchorDigest: string;
}

// The fixed note every anchor carries. It is a constant so no caller can soften it,
// and it states the one thing a reader must not get wrong about observe receipts.
export const RECEIPT_COVERAGE_NOTE = "observe receipts are fail-open: a missing receipt is not evidence that the event did not occur" as const;

// The bounded summary eligible for the main chain: identity, digest, counts, and an
// explicit coverage classification -- never the entries themselves. One anchor per
// batch keeps the main chain's growth proportional to turns, not to tool calls.
export function anchorReceiptBatch(batchValue: unknown): ReceiptAnchor {
  const batch = validateReceiptBatch(batchValue);
  const eventCounts: Record<string, number> = {};
  for (const event of OBSERVE_HOOK_EVENTS) {
    const count = batch.entries.filter((entry) => entry.event === event).length;
    if (count > 0) eventCounts[event] = count;
  }
  const basis = {
    schemaVersion: RECEIPT_ANCHOR_VERSION,
    batchId: batch.batchId,
    batchDigest: batch.batchDigest,
    hostProduct: batch.hostProduct,
    hostVersion: batch.hostVersion,
    sessionId: batch.sessionId,
    workspaceId: batch.workspaceId,
    openedAt: batch.openedAt,
    sealedAt: batch.sealedAt,
    coverage: batch.coverage,
    entryCount: batch.entries.length,
    eventCounts: Object.freeze(eventCounts),
    coverageNote: RECEIPT_COVERAGE_NOTE,
  };
  return deepFreeze({ ...basis, anchorDigest: canonicalSha256(basis) });
}

export function validateReceiptAnchor(value: unknown): ReceiptAnchor {
  const document = record(value, "receipt anchor");
  if (document.schemaVersion !== RECEIPT_ANCHOR_VERSION) fail("RECEIPT_SCHEMA_INVALID", "anchor schemaVersion");
  exact(document, ["schemaVersion", "batchId", "batchDigest", "hostProduct", "hostVersion", "sessionId", "workspaceId", "openedAt", "sealedAt", "coverage", "entryCount", "eventCounts", "coverageNote", "anchorDigest"], "receipt anchor");
  if (document.coverageNote !== RECEIPT_COVERAGE_NOTE) fail("RECEIPT_SCHEMA_INVALID", "coverageNote");
  const rest: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(document)) if (key !== "anchorDigest") rest[key] = entry;
  if (document.anchorDigest !== canonicalSha256(rest)) fail("RECEIPT_ANCHOR_MISMATCH", "anchorDigest");
  return deepFreeze(document as unknown as ReceiptAnchor);
}

// Verify an anchor against the batch it claims to summarise. Used when a retained
// anchor is checked against a batch that survived pruning.
export function verifyAnchorAgainstBatch(anchorValue: unknown, batchValue: unknown): ReceiptAnchor {
  const anchor = validateReceiptAnchor(anchorValue);
  const recomputed = anchorReceiptBatch(batchValue);
  if (recomputed.anchorDigest !== anchor.anchorDigest) fail("RECEIPT_ANCHOR_MISMATCH", anchor.batchId);
  return anchor;
}

export interface PruneResult {
  readonly retained: readonly ReceiptBatch[];
  readonly prunedBatchIds: readonly string[];
  readonly retainedAnchors: readonly ReceiptAnchor[];
}

// Pruning drops WHOLE sealed batches, oldest first, keeping at most `keepBatches`.
// Two properties make this safe: a retained batch's digest still verifies (entries
// are never removed from inside a batch), and every pruned batch's anchor is
// returned, so the main chain keeps a bounded record that the batch existed and what
// it contained. An unsealed batch is never pruned -- it is the live one.
export function pruneReceiptBatches(batchValues: readonly unknown[], keepBatches: number): PruneResult {
  if (!Number.isSafeInteger(keepBatches) || keepBatches < 0) fail("RECEIPT_SCHEMA_INVALID", "keepBatches");
  const batches = batchValues.map((value) => validateReceiptBatch(value));
  const sealed = batches.filter((batch) => batch.sealedAt !== null);
  const live = batches.filter((batch) => batch.sealedAt === null);
  const ordered = [...sealed].sort((left, right) => compareCanonicalText(left.openedAt, right.openedAt) || compareCanonicalText(left.batchId, right.batchId));
  const dropCount = Math.max(0, ordered.length - keepBatches);
  const dropped = ordered.slice(0, dropCount);
  const kept = ordered.slice(dropCount);
  return deepFreeze({
    retained: [...kept, ...live],
    prunedBatchIds: dropped.map((batch) => batch.batchId),
    retainedAnchors: dropped.map((batch) => anchorReceiptBatch(batch)),
  });
}
