// SPDX-License-Identifier: Apache-2.0
//
// INIT-009 EPIC-026 S077: the App Server Observer — READ-ONLY.
//
// Codex's App Server speaks JSON-RPC and streams notifications about a session's
// life: threads starting and closing, turns beginning and completing, items being
// produced, commands executing, files changing, approvals being requested. This
// module turns that stream into bounded receipts.
//
// It observes. It does not drive. The protocol also exposes REQUESTS that start,
// interrupt, fork and roll back threads, and this module deliberately implements
// none of them: active orchestration would reopen the GD-1 ruling that retired the
// Codex agent mesh, which MIN-042 placed outside this initiative (S079 assesses
// feasibility only, and any Controller needs its own initiative and a GD-1
// re-litigation). Nothing here sends a request, opens a socket, or writes to a host.
//
// Version-bound by construction. The observed event vocabulary is pinned to the
// protocol schema digest it was derived from (Codex 0.139.0, recorded in
// docs/verification/host/codex-0.139.0-facts.json). A stream from a host whose
// protocol digest differs is admitted only as `unpinned`, and every receipt says
// which it was: a protocol that moved underneath us must be visible, not silently
// reinterpreted.
//
// The same honesty rules as the rest of the observe surface apply. Absence of an
// event is not evidence it did not happen — a stream can be truncated, an observer
// can start late, and unknown methods are counted rather than dropped silently.

import { canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";

export const APP_SERVER_OBSERVER_VERSION = "tcrn.app-server-observation.v1" as const;

// The protocol schema this vocabulary was derived from. Recorded as evidence, not as
// a trust anchor: it says which bytes were read, not that a host must present them.
export const OBSERVED_PROTOCOL_DIGEST = "sha256:4c47a458f57d09cbbf50bf2f58b38f4e" as const;
export const OBSERVED_PROTOCOL_HOST = "Codex CLI 0.139.0" as const;

// Notification methods observed in the real protocol schema. Grouped by what a
// governance reader cares about rather than by protocol layering.
export const OBSERVED_EVENT_GROUPS = Object.freeze({
  thread: Object.freeze(["thread/started", "thread/status/changed", "thread/archived", "thread/unarchived", "thread/closed"]),
  turn: Object.freeze(["turn/started", "turn/completed", "turn/diff/updated", "turn/plan/updated"]),
  item: Object.freeze(["item/started", "item/completed", "item/autoApprovalReview/started", "item/autoApprovalReview/completed"]),
  command: Object.freeze(["command/exec/outputDelta", "item/commandExecution/outputDelta", "process/exited"]),
  fileChange: Object.freeze(["item/fileChange/outputDelta"]),
  hook: Object.freeze(["hook/started", "hook/completed"]),
});

export const OBSERVED_EVENT_METHODS = Object.freeze(
  Object.values(OBSERVED_EVENT_GROUPS).flatMap((group) => [...group]).sort(compareCanonicalText),
);

export const OBSERVER_REASON_CODES = Object.freeze([
  "OBSERVER_SCHEMA_INVALID",
  "OBSERVER_BUDGET_EXCEEDED",
  "OBSERVER_PROTOCOL_UNPINNED",
  "OBSERVER_WRITE_ATTEMPTED",
] as const);
export type ObserverReasonCode = typeof OBSERVER_REASON_CODES[number];

export const OBSERVER_LIMITS = Object.freeze({
  eventsPerObservation: 4_096,
  summaryBytes: 512,
});

export class ObserverError extends Error {
  readonly reasonCode: ObserverReasonCode;
  constructor(reasonCode: ObserverReasonCode, message: string) {
    super(message);
    this.name = "ObserverError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: ObserverReasonCode, message: string): never {
  throw new ObserverError(reasonCode, message);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("OBSERVER_SCHEMA_INVALID", label);
  return value as Readonly<Record<string, unknown>>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export type ProtocolBinding = "pinned" | "unpinned";

export interface ObservationInput {
  readonly hostProduct: string;
  readonly hostVersion: string;
  readonly sessionId: string;
  readonly protocolDigest: string;
  readonly observedFrom: string;
  readonly observedTo: string;
  // The JSON-RPC notification frames as received. Only `method` is interpreted;
  // params are counted and never retained.
  readonly notifications: readonly unknown[];
}

export interface ObservationReceipt {
  readonly schemaVersion: typeof APP_SERVER_OBSERVER_VERSION;
  readonly hostProduct: string;
  readonly hostVersion: string;
  readonly sessionId: string;
  readonly protocolDigest: string;
  readonly protocolBinding: ProtocolBinding;
  readonly observedFrom: string;
  readonly observedTo: string;
  readonly totalNotifications: number;
  readonly groupCounts: Readonly<Record<string, number>>;
  readonly methodCounts: Readonly<Record<string, number>>;
  readonly unknownMethodCount: number;
  readonly malformedFrameCount: number;
  readonly readOnly: true;
  readonly coverageNote: string;
  readonly observationDigest: string;
}

// Fixed notes. Constants so no caller can soften either the read-only boundary or
// the coverage caveat by supplying different text.
export const OBSERVER_COVERAGE_NOTE =
  "observation only: absence of an event is not evidence it did not occur, and a stream may start late or be truncated" as const;

function groupOf(method: string): string | null {
  for (const [group, methods] of Object.entries(OBSERVED_EVENT_GROUPS)) {
    if ((methods as readonly string[]).includes(method)) return group;
  }
  return null;
}

// Fold a received notification stream into one bounded receipt. Params are never
// retained: a command's output, a file's contents and a message's text stay in the
// host. What survives is what was seen, how much of it, and under which protocol.
export function observeAppServerStream(input: unknown): ObservationReceipt {
  const document = record(input, "observation input");
  const wanted = ["hostProduct", "hostVersion", "sessionId", "protocolDigest", "observedFrom", "observedTo", "notifications"];
  const actual = Object.keys(document).sort(compareCanonicalText);
  const sorted = [...wanted].sort(compareCanonicalText);
  if (actual.length !== sorted.length || sorted.some((field, index) => field !== actual[index])) fail("OBSERVER_SCHEMA_INVALID", "observation input: field set");
  for (const field of ["hostProduct", "hostVersion", "sessionId", "protocolDigest", "observedFrom", "observedTo"]) {
    const value = document[field];
    if (typeof value !== "string" || !value.isWellFormed() || value.length === 0) fail("OBSERVER_SCHEMA_INVALID", field);
    if (Buffer.byteLength(value, "utf8") > OBSERVER_LIMITS.summaryBytes) fail("OBSERVER_BUDGET_EXCEEDED", field);
  }
  if (!Array.isArray(document.notifications)) fail("OBSERVER_SCHEMA_INVALID", "notifications");
  if (document.notifications.length > OBSERVER_LIMITS.eventsPerObservation) fail("OBSERVER_BUDGET_EXCEEDED", "notifications");

  const methodCounts: Record<string, number> = {};
  const groupCounts: Record<string, number> = {};
  let unknownMethodCount = 0;
  let malformedFrameCount = 0;

  for (const frame of document.notifications) {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) { malformedFrameCount += 1; continue; }
    const method = (frame as Record<string, unknown>).method;
    if (typeof method !== "string" || method.length === 0) { malformedFrameCount += 1; continue; }
    const group = groupOf(method);
    if (group === null) {
      // An unknown method is COUNTED, never dropped silently: a protocol that grew a
      // new event is exactly the thing a version-bound observer must surface.
      unknownMethodCount += 1;
      continue;
    }
    methodCounts[method] = (methodCounts[method] ?? 0) + 1;
    groupCounts[group] = (groupCounts[group] ?? 0) + 1;
  }

  const orderedMethods: Record<string, number> = {};
  for (const key of Object.keys(methodCounts).sort(compareCanonicalText)) orderedMethods[key] = methodCounts[key] as number;
  const orderedGroups: Record<string, number> = {};
  for (const key of Object.keys(groupCounts).sort(compareCanonicalText)) orderedGroups[key] = groupCounts[key] as number;

  const basis = {
    schemaVersion: APP_SERVER_OBSERVER_VERSION,
    hostProduct: document.hostProduct as string,
    hostVersion: document.hostVersion as string,
    sessionId: document.sessionId as string,
    protocolDigest: document.protocolDigest as string,
    // A stream whose protocol digest is not the one this vocabulary was derived from
    // is admitted, but marked: its counts may under-report events this build cannot
    // name. Silence about that would be the overclaim.
    protocolBinding: (document.protocolDigest === OBSERVED_PROTOCOL_DIGEST ? "pinned" : "unpinned") as ProtocolBinding,
    observedFrom: document.observedFrom as string,
    observedTo: document.observedTo as string,
    totalNotifications: document.notifications.length,
    groupCounts: Object.freeze(orderedGroups),
    methodCounts: Object.freeze(orderedMethods),
    unknownMethodCount,
    malformedFrameCount,
    readOnly: true as const,
    coverageNote: OBSERVER_COVERAGE_NOTE,
  };
  return deepFreeze({ ...basis, observationDigest: canonicalSha256(basis) });
}

export function validateObservationReceipt(value: unknown): ObservationReceipt {
  const document = record(value, "observation receipt");
  if (document.schemaVersion !== APP_SERVER_OBSERVER_VERSION) fail("OBSERVER_SCHEMA_INVALID", "schemaVersion");
  if (document.readOnly !== true) fail("OBSERVER_WRITE_ATTEMPTED", "readOnly");
  if (document.coverageNote !== OBSERVER_COVERAGE_NOTE) fail("OBSERVER_SCHEMA_INVALID", "coverageNote");
  const rest: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(document)) if (key !== "observationDigest") rest[key] = entry;
  if (document.observationDigest !== canonicalSha256(rest)) fail("OBSERVER_SCHEMA_INVALID", "observationDigest");
  return deepFreeze(document as unknown as ObservationReceipt);
}

// Assert a receipt may be presented as evidence for a claim about THIS host and
// protocol. An unpinned observation is usable as a record of what was seen, but it
// may not back a claim that the vocabulary was complete.
export function assertPinnedObservation(receiptValue: unknown): ObservationReceipt {
  const receipt = validateObservationReceipt(receiptValue);
  if (receipt.protocolBinding !== "pinned") fail("OBSERVER_PROTOCOL_UNPINNED", `${receipt.protocolDigest} != ${OBSERVED_PROTOCOL_DIGEST}`);
  return receipt;
}
