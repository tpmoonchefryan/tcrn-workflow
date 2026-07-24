// SPDX-License-Identifier: Apache-2.0
//
// INIT-010 EPIC-020 S055: the collection layer that turns observed subagent
// invocations into the host-execution receipts EPIC-019's classifier consumes.
//
// The seam this closes. conference-execution.ts can verify that a position's text
// matches a receipt's output digest and that the bound receipts name distinct
// fresh-context invocations -- but it has to be HANDED those receipts. Anyone can
// author them, which is why that module's spec says plainly it verifies consistency,
// not authenticity. This module is the honest half of the story: it builds receipts
// from what a host recorder observed, so a receipt is at least a record of an
// invocation that a hook saw, rather than a claim typed after the fact.
//
// What it still does not achieve, stated here so no caller infers otherwise. The
// collector runs with the same authority as the agent it observes: the same user can
// write the log, the transcript and the receipt. So this raises the cost of a forged
// deliberation from "type some JSON" to "forge a consistent observed record", and it
// is attribution evidence, never identity proof. MIN-046's rule applies unchanged --
// a missing receipt is not evidence that an invocation did not happen, and an
// unsealed batch never claims completeness.
//
// Pure and host-neutral: no IO, no host read, no network. The Claude wiring supplies
// observed lines from the observe log; a Codex collector (S054) can supply the same
// shape from its own surface, which is why nothing here names a host.

import { createHash } from "node:crypto";

import { compareCanonicalText } from "../../protocol/src/index.js";
import { HOST_EXECUTION_RECEIPT_VERSION, validateHostExecutionReceipt } from "./conference-execution.js";
import type { HostExecutionReceipt } from "./conference-execution.js";

export const COLLECTION_REASON_CODES = Object.freeze([
  "COLLECTION_SCHEMA_INVALID",
  "COLLECTION_UNICODE_INVALID",
  "COLLECTION_BINDING_MISMATCH",
  "COLLECTION_TRANSCRIPT_UNSIGNED",
  "COLLECTION_DUPLICATE_INVOCATION",
] as const);
export type CollectionReasonCode = typeof COLLECTION_REASON_CODES[number];

// A fixed disclosure that travels on every collected receipt. It is a constant so no
// caller can soften it, and it says the two things a reader must not get wrong: the
// transcript carries no host signature, and observation is not identity proof.
export const COLLECTION_ATTRIBUTION_NOTE =
  "collected from an observed host invocation; the transcript is not host-signed and this is attribution, not identity proof" as const;

export class CollectionError extends Error {
  readonly reasonCode: CollectionReasonCode;
  constructor(reasonCode: CollectionReasonCode, message: string) {
    super(message);
    this.name = "CollectionError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: CollectionReasonCode, message: string): never {
  throw new CollectionError(reasonCode, message);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("COLLECTION_SCHEMA_INVALID", label);
  return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.length === 0) fail("COLLECTION_UNICODE_INVALID", label);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function contentDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// One observed subagent invocation, as a host recorder saw it. `transcriptDigest` and
// `transcriptBytes` are recorded at observation time so a transcript edited afterwards
// no longer matches what was seen -- the host-side binding S055 requires.
export interface ObservedInvocation {
  readonly agentInvocationId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly freshContext: boolean;
  readonly promptDigest: string;
  readonly finalMessage: string;
  readonly transcriptPath: string;
  readonly transcriptDigest: string;
  readonly transcriptBytes: number;
}

export interface CollectionContext {
  readonly hostProduct: string;
  readonly hostVersion: string;
  readonly sessionId: string;
  readonly conferenceId: string;
  readonly availability: HostExecutionReceipt["availability"];
  // Host-neutral optional bindings. Claude's current observe log does not expose
  // them and therefore leaves both null; Codex App Server notifications do expose
  // stable thread/turn ids, so S054 supplies them instead of discarding evidence.
  readonly threadId?: string | null;
  readonly turnId?: string | null;
}

const shaPattern = /^[a-f0-9]{64}$/u;

function validateObserved(value: unknown, label: string): ObservedInvocation {
  const document = record(value, label);
  const wanted = ["agentInvocationId", "startedAt", "endedAt", "freshContext", "promptDigest", "finalMessage", "transcriptPath", "transcriptDigest", "transcriptBytes"];
  const actual = Object.keys(document).sort(compareCanonicalText);
  const sorted = [...wanted].sort(compareCanonicalText);
  if (actual.length !== sorted.length || sorted.some((field, index) => field !== actual[index])) fail("COLLECTION_SCHEMA_INVALID", `${label}: field set`);
  if (typeof document.freshContext !== "boolean") fail("COLLECTION_SCHEMA_INVALID", `${label}.freshContext`);
  if (typeof document.transcriptBytes !== "number" || !Number.isSafeInteger(document.transcriptBytes) || document.transcriptBytes < 0) fail("COLLECTION_SCHEMA_INVALID", `${label}.transcriptBytes`);
  for (const field of ["promptDigest", "transcriptDigest"]) {
    if (typeof document[field] !== "string" || !shaPattern.test(document[field] as string)) fail("COLLECTION_SCHEMA_INVALID", `${label}.${field}`);
  }
  return deepFreeze({
    agentInvocationId: text(document.agentInvocationId, `${label}.agentInvocationId`),
    startedAt: text(document.startedAt, `${label}.startedAt`),
    endedAt: text(document.endedAt, `${label}.endedAt`),
    freshContext: document.freshContext as boolean,
    promptDigest: document.promptDigest as string,
    finalMessage: text(document.finalMessage, `${label}.finalMessage`),
    transcriptPath: text(document.transcriptPath, `${label}.transcriptPath`),
    transcriptDigest: document.transcriptDigest as string,
    transcriptBytes: document.transcriptBytes as number,
  });
}

export interface CollectedReceipt {
  readonly receipt: HostExecutionReceipt;
  readonly transcriptPath: string;
  readonly transcriptDigest: string;
  readonly transcriptBytes: number;
  readonly transcriptSigned: false;
}

// Build one host-execution receipt from one observed invocation, bound to the
// position it substantiates. The receipt's outputDigest is the digest of the
// invocation's final message, which is exactly what EPIC-019's classifier compares
// against the position text -- so a position that was edited after the invocation
// fails the binding rather than passing quietly.
//
// `transcriptSigned` is a literal false: this layer has no host signature to offer,
// and saying so in the type stops a later caller from assuming otherwise.
export function collectExecutionReceipt(
  observedValue: unknown,
  positionId: string,
  receiptId: string,
  context: CollectionContext,
): CollectedReceipt {
  const observed = validateObserved(observedValue, "observed invocation");
  const contextDocument = record(context, "collection context");
  const threadId =
    contextDocument.threadId === undefined || contextDocument.threadId === null
      ? null
      : text(contextDocument.threadId, "threadId");
  const turnId =
    contextDocument.turnId === undefined || contextDocument.turnId === null
      ? null
      : text(contextDocument.turnId, "turnId");
  const receipt = validateHostExecutionReceipt({
    schemaVersion: HOST_EXECUTION_RECEIPT_VERSION,
    id: text(receiptId, "receiptId"),
    conferenceId: text(contextDocument.conferenceId, "conferenceId"),
    positionId: text(positionId, "positionId"),
    hostProduct: text(contextDocument.hostProduct, "hostProduct"),
    hostVersion: text(contextDocument.hostVersion, "hostVersion"),
    sessionId: text(contextDocument.sessionId, "sessionId"),
    threadId,
    turnId,
    agentInvocationId: observed.agentInvocationId,
    freshContext: observed.freshContext,
    invokedAt: observed.startedAt,
    promptDigest: observed.promptDigest,
    outputDigest: contentDigest(observed.finalMessage),
    availability: contextDocument.availability,
    attributionNote: COLLECTION_ATTRIBUTION_NOTE,
  });
  return deepFreeze({
    receipt,
    transcriptPath: observed.transcriptPath,
    transcriptDigest: observed.transcriptDigest,
    transcriptBytes: observed.transcriptBytes,
    transcriptSigned: false as const,
  });
}

export interface CollectionPlanEntry {
  readonly positionId: string;
  readonly receiptId: string;
  readonly observed: unknown;
}

export interface CollectionResult {
  readonly receipts: readonly CollectedReceipt[];
  readonly distinctInvocations: number;
  readonly transcriptsSigned: false;
  readonly attributionNote: typeof COLLECTION_ATTRIBUTION_NOTE;
}

// Collect a whole conference's worth of receipts. Two invocations that report the
// same agentInvocationId are refused rather than silently counted twice: the
// independence a multi-agent claim rests on is distinct invocations, so a duplicate
// here would manufacture independence that did not occur.
export function collectConferenceReceipts(entries: readonly CollectionPlanEntry[], context: CollectionContext): CollectionResult {
  if (!Array.isArray(entries)) fail("COLLECTION_SCHEMA_INVALID", "entries");
  const seenInvocations = new Set<string>();
  const seenPositions = new Set<string>();
  const receipts = entries.map((entry, index) => {
    const item = record(entry, `entries[${index}]`);
    const positionId = text(item.positionId, `entries[${index}].positionId`);
    if (seenPositions.has(positionId)) fail("COLLECTION_BINDING_MISMATCH", `duplicate position ${positionId}`);
    seenPositions.add(positionId);
    const collected = collectExecutionReceipt(item.observed, positionId, text(item.receiptId, `entries[${index}].receiptId`), context);
    if (seenInvocations.has(collected.receipt.agentInvocationId)) fail("COLLECTION_DUPLICATE_INVOCATION", collected.receipt.agentInvocationId);
    seenInvocations.add(collected.receipt.agentInvocationId);
    return collected;
  });
  return deepFreeze({
    receipts,
    distinctInvocations: seenInvocations.size,
    transcriptsSigned: false as const,
    attributionNote: COLLECTION_ATTRIBUTION_NOTE,
  });
}

// Re-verify a collected receipt against a transcript's CURRENT bytes. A transcript
// edited after observation no longer matches the digest recorded at observation time,
// so this reports drift rather than accepting the edited file. It proves the file did
// not change since it was seen; it does not prove the file's contents are true.
export function verifyCollectedTranscript(collected: CollectedReceipt, currentTranscript: unknown): { readonly matches: boolean; readonly transcriptSigned: false } {
  const bytes = text(currentTranscript, "transcript");
  const matches = createHash("sha256").update(bytes, "utf8").digest("hex") === collected.transcriptDigest
    && Buffer.byteLength(bytes, "utf8") === collected.transcriptBytes;
  return deepFreeze({ matches, transcriptSigned: false as const });
}
