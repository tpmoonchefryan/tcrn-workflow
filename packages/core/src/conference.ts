// SPDX-License-Identifier: Apache-2.0

import { canonicalSha256, assertProtocolId, compareCanonicalText, parseStrictInstant } from "../../protocol/src/index.js";
import type { CreateKnowledgeUnitInput } from "./knowledge-core.js";

export const CONFERENCE_REQUEST_VERSION = "tcrn.conference.v1.request" as const;
export const CONFERENCE_POSITION_VERSION = "tcrn.conference.v1.position" as const;
export const CONFERENCE_MINUTES_VERSION = "tcrn.conference.v1.minutes" as const;

export const CONFERENCE_TYPES = Object.freeze(["strategy", "architecture", "risk", "verification", "release", "incident", "retrospective"] as const);
export const CONFERENCE_STATUSES = Object.freeze(["open", "closed", "cancelled"] as const);
export const CONFERENCE_OUTCOME_CLASSES = Object.freeze(["discussion_only", "recommendation", "role_decision", "blocked", "owner_intent_required"] as const);

export const CONFERENCE_REASON_CODES = Object.freeze([
  "CONFERENCE_ANCHOR_REQUIRED",
  "CONFERENCE_BUDGET_EXCEEDED",
  "CONFERENCE_DESIRED_OUTCOME_REQUIRED",
  "CONFERENCE_DISTILLED",
  "CONFERENCE_MINUTES_UNBOUND",
  "CONFERENCE_POSITION_UNBOUND",
  "CONFERENCE_SCHEMA_INVALID",
  "CONFERENCE_UNICODE_INVALID",
  "CONFERENCE_UNKNOWN_FIELD",
  "CONFERENCE_VALIDATED",
] as const);

export type ConferenceReasonCode = typeof CONFERENCE_REASON_CODES[number];

const maximumTextBytes = 2_048;
const maximumExtensionProperties = 64;

export class ConferenceError extends Error {
  readonly reasonCode: ConferenceReasonCode;
  constructor(reasonCode: ConferenceReasonCode, message: string) {
    super(message);
    this.name = "ConferenceError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: ConferenceReasonCode, message: string): never {
  throw new ConferenceError(reasonCode, message);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("CONFERENCE_SCHEMA_INVALID", label);
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  const unknown = actual.filter((field) => !wanted.includes(field));
  if (unknown.length > 0) fail("CONFERENCE_UNKNOWN_FIELD", `${label}:${unknown.join(",")}`);
  if (wanted.some((field) => !actual.includes(field))) fail("CONFERENCE_SCHEMA_INVALID", label);
}

function id(value: unknown, label: string): string {
  try { assertProtocolId(value); } catch { fail("CONFERENCE_SCHEMA_INVALID", label); }
  return value as string;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.length === 0) fail("CONFERENCE_UNICODE_INVALID", label);
  if (Buffer.byteLength(value, "utf8") > maximumTextBytes) fail("CONFERENCE_BUDGET_EXCEEDED", label);
  return value;
}

function instant(value: unknown, label: string): string {
  try { parseStrictInstant(value); } catch { fail("CONFERENCE_SCHEMA_INVALID", label); }
  return value as string;
}

function boundedTextArray(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value)) fail("CONFERENCE_SCHEMA_INVALID", label);
  if (value.length > maximum) fail("CONFERENCE_BUDGET_EXCEEDED", label);
  return value.map((entry, index) => text(entry, `${label}[${index}]`));
}

function idArray(value: unknown, label: string, { min = 0, max = 64, unique = true } = {}): readonly string[] {
  if (!Array.isArray(value)) fail("CONFERENCE_SCHEMA_INVALID", label);
  if (value.length < min) fail("CONFERENCE_ANCHOR_REQUIRED", label);
  if (value.length > max) fail("CONFERENCE_BUDGET_EXCEEDED", label);
  const ids = value.map((entry, index) => id(entry, `${label}[${index}]`));
  if (unique && new Set(ids).size !== ids.length) fail("CONFERENCE_SCHEMA_INVALID", `${label} duplicate`);
  return ids;
}

function extensions(value: unknown): Readonly<Record<string, unknown>> {
  const map = record(value, "extensions");
  const keys = Object.keys(map);
  if (keys.length > maximumExtensionProperties) fail("CONFERENCE_BUDGET_EXCEEDED", "extensions");
  for (const key of keys) {
    id(key, `extensions key ${key}`);
    const entry = record(map[key], `extensions.${key}`);
    exact(entry, ["required", "value"], `extensions.${key}`);
    if (typeof entry.required !== "boolean") fail("CONFERENCE_SCHEMA_INVALID", `extensions.${key}.required`);
  }
  return map;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function common(document: Readonly<Record<string, unknown>>): { revision: number; updatedAt: string; tombstone: boolean; extensions: Readonly<Record<string, unknown>> } {
  if (!Number.isSafeInteger(document.revision) || (document.revision as number) < 1) fail("CONFERENCE_SCHEMA_INVALID", "revision");
  if (typeof document.tombstone !== "boolean") fail("CONFERENCE_SCHEMA_INVALID", "tombstone");
  return { revision: document.revision as number, updatedAt: instant(document.updatedAt, "updatedAt"), tombstone: document.tombstone as boolean, extensions: extensions(document.extensions) };
}

export interface ConferenceRequest {
  readonly schemaVersion: typeof CONFERENCE_REQUEST_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly type: typeof CONFERENCE_TYPES[number];
  readonly title: string;
  readonly linkedWorkIds: readonly string[];
  readonly desiredOutcome: string;
  readonly participantIds: readonly string[];
  readonly status: typeof CONFERENCE_STATUSES[number];
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export function validateConferenceRequest(value: unknown): ConferenceRequest {
  const document = record(value, "conference request");
  if (document.schemaVersion !== CONFERENCE_REQUEST_VERSION) fail("CONFERENCE_SCHEMA_INVALID", "request schemaVersion");
  exact(document, ["schemaVersion", "id", "projectId", "type", "title", "linkedWorkIds", "desiredOutcome", "participantIds", "status", "revision", "updatedAt", "tombstone", "extensions"], "conference request");
  if (!CONFERENCE_TYPES.includes(document.type as ConferenceRequest["type"])) fail("CONFERENCE_SCHEMA_INVALID", "request type");
  if (!CONFERENCE_STATUSES.includes(document.status as ConferenceRequest["status"])) fail("CONFERENCE_SCHEMA_INVALID", "request status");
  if (typeof document.desiredOutcome !== "string" || document.desiredOutcome.length === 0) fail("CONFERENCE_DESIRED_OUTCOME_REQUIRED", "desiredOutcome");
  return deepFreeze({
    schemaVersion: CONFERENCE_REQUEST_VERSION,
    id: id(document.id, "id"),
    projectId: id(document.projectId, "projectId"),
    type: document.type as ConferenceRequest["type"],
    title: text(document.title, "title"),
    linkedWorkIds: idArray(document.linkedWorkIds, "linkedWorkIds", { min: 1 }),
    desiredOutcome: text(document.desiredOutcome, "desiredOutcome"),
    participantIds: idArray(document.participantIds, "participantIds"),
    status: document.status as ConferenceRequest["status"],
    ...common(document),
  });
}

export interface ConferencePosition {
  readonly schemaVersion: typeof CONFERENCE_POSITION_VERSION;
  readonly id: string;
  readonly conferenceId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly position: string;
  readonly risks: readonly string[];
  readonly recommendations: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export function validateConferencePosition(value: unknown): ConferencePosition {
  const document = record(value, "conference position");
  if (document.schemaVersion !== CONFERENCE_POSITION_VERSION) fail("CONFERENCE_SCHEMA_INVALID", "position schemaVersion");
  exact(document, ["schemaVersion", "id", "conferenceId", "projectId", "actorId", "position", "risks", "recommendations", "evidenceIds", "revision", "updatedAt", "tombstone", "extensions"], "conference position");
  return deepFreeze({
    schemaVersion: CONFERENCE_POSITION_VERSION,
    id: id(document.id, "id"),
    conferenceId: id(document.conferenceId, "conferenceId"),
    projectId: id(document.projectId, "projectId"),
    actorId: id(document.actorId, "actorId"),
    position: text(document.position, "position"),
    risks: boundedTextArray(document.risks, "risks", 32),
    recommendations: boundedTextArray(document.recommendations, "recommendations", 32),
    evidenceIds: idArray(document.evidenceIds, "evidenceIds", { max: 32 }),
    ...common(document),
  });
}

export interface ConferenceMinutes {
  readonly schemaVersion: typeof CONFERENCE_MINUTES_VERSION;
  readonly id: string;
  readonly conferenceId: string;
  readonly projectId: string;
  readonly summary: string;
  readonly outcomeClass: typeof CONFERENCE_OUTCOME_CLASSES[number];
  readonly decisions: readonly string[];
  readonly unresolvedIssues: readonly string[];
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export function validateConferenceMinutes(value: unknown): ConferenceMinutes {
  const document = record(value, "conference minutes");
  if (document.schemaVersion !== CONFERENCE_MINUTES_VERSION) fail("CONFERENCE_SCHEMA_INVALID", "minutes schemaVersion");
  exact(document, ["schemaVersion", "id", "conferenceId", "projectId", "summary", "outcomeClass", "decisions", "unresolvedIssues", "revision", "updatedAt", "tombstone", "extensions"], "conference minutes");
  if (!CONFERENCE_OUTCOME_CLASSES.includes(document.outcomeClass as ConferenceMinutes["outcomeClass"])) fail("CONFERENCE_SCHEMA_INVALID", "minutes outcomeClass");
  return deepFreeze({
    schemaVersion: CONFERENCE_MINUTES_VERSION,
    id: id(document.id, "id"),
    conferenceId: id(document.conferenceId, "conferenceId"),
    projectId: id(document.projectId, "projectId"),
    summary: text(document.summary, "summary"),
    outcomeClass: document.outcomeClass as ConferenceMinutes["outcomeClass"],
    decisions: boundedTextArray(document.decisions, "decisions", 32),
    unresolvedIssues: boundedTextArray(document.unresolvedIssues, "unresolvedIssues", 32),
    ...common(document),
  });
}

// Operations — minimal skeleton. No orchestration, action-item automation, or search.
export function openConference(value: unknown): ConferenceRequest {
  const request = validateConferenceRequest(value);
  if (request.status !== "open") fail("CONFERENCE_SCHEMA_INVALID", "opened conference must be status open");
  return request;
}

export function appendConferencePosition(positionValue: unknown, requestValue: unknown): ConferencePosition {
  const request = validateConferenceRequest(requestValue);
  const position = validateConferencePosition(positionValue);
  if (position.conferenceId !== request.id || position.projectId !== request.projectId) fail("CONFERENCE_POSITION_UNBOUND", position.id);
  if (request.status !== "open") fail("CONFERENCE_POSITION_UNBOUND", "conference not open");
  return position;
}

export function listConferencesByWorkItem(workId: unknown, requests: readonly unknown[]): readonly ConferenceRequest[] {
  const target = id(workId, "workId");
  return requests
    .map((value) => validateConferenceRequest(value))
    .filter((request) => !request.tombstone && request.linkedWorkIds.includes(target))
    .sort((left, right) => compareCanonicalText(left.projectId, right.projectId) || compareCanonicalText(left.id, right.id));
}

export interface ConferenceDecisionCandidate {
  readonly kind: "decision";
  readonly promotionState: "candidate";
  readonly projectId: string;
  readonly subject: string;
  readonly body: string;
  readonly sourceReferences: readonly string[];
  readonly linkedWorkIds: readonly string[];
  readonly candidateDigest: string;
}

// Close = distill: emit one knowledge decision candidate per minutes decision, each
// backlinking the conference record via an inert sourceReferences locator. The
// candidate feeds the existing knowledge-core promotion pipeline; nothing is
// promoted here. No second knowledge store is created (single knowledge store).
export function closeConference(minutesValue: unknown, requestValue: unknown, positionsValue: readonly unknown[] = []): Readonly<{ minutes: ConferenceMinutes; request: ConferenceRequest; candidates: readonly ConferenceDecisionCandidate[] }> {
  const request = validateConferenceRequest(requestValue);
  const minutes = validateConferenceMinutes(minutesValue);
  if (minutes.conferenceId !== request.id || minutes.projectId !== request.projectId) fail("CONFERENCE_MINUTES_UNBOUND", minutes.id);
  for (const positionValue of positionsValue) {
    const position = validateConferencePosition(positionValue);
    if (position.conferenceId !== request.id) fail("CONFERENCE_POSITION_UNBOUND", position.id);
  }
  const backlink = `conference:${request.id.split(":").slice(1).join(":") || request.id}`;
  const candidates = minutes.decisions.map((decision, index) => {
    const basis = {
      kind: "decision" as const,
      promotionState: "candidate" as const,
      projectId: request.projectId,
      subject: `${request.title} decision ${index + 1}`.slice(0, maximumTextBytes),
      body: decision,
      sourceReferences: [backlink, `conference-minutes:${minutes.id.split(":").slice(1).join(":") || minutes.id}`],
      linkedWorkIds: request.linkedWorkIds,
    };
    return deepFreeze({ ...basis, candidateDigest: canonicalSha256(basis) });
  });
  return deepFreeze({ minutes, request, candidates });
}

// WSD-3: truncate on a code-point boundary so the result is valid UTF-8 and its
// byte length never exceeds the bound (a single code point is at most four bytes,
// well under every cap here). Used for the subject/summary/snippet knowledge
// fields, whose knowledge-core bounds are byte-measured while the protocol record
// bound is code-point measured — a code-point-safe truncation satisfies both.
function truncateOnCodePoint(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let result = "";
  for (const codePoint of value) {
    if (Buffer.byteLength(result + codePoint, "utf8") > maximumBytes) break;
    result += codePoint;
  }
  return result;
}

const maximumSubjectBytes = 512;
const maximumSnippetBytes = 512;

export interface DistillConferenceOptions {
  readonly occurredAt: string;
  readonly expectedVersionBase: number;
  readonly stalenessDays: number;
  readonly accountableOwnerId?: string;
  readonly evidenceIds?: readonly string[];
}

// WSD-3 / SDC-6: transform closed conference minutes into governed knowledge
// creation inputs — one candidate per minutes decision. Each input is a FULL
// CreateKnowledgeUnitInput accepted by the unmodified fail-closed knowledge
// creation contract (WSC-3 capture-cheap): provenance (accountable owner,
// evidence) is optional at capture and enforced only at promotion, while the
// vocabulary-conformant tag set and non-empty snippet make the candidate
// promotable by construction under WSC-6's final promote gates. The external key
// is hyphen-only (CONFERENCE-DECISION-<hex>-<hex>-<n>) so canonicalExternalKey
// admits it; sourceDigest binds the FULL untruncated decision basis even when the
// stored subject is byte-bounded. The transform is pure — no store access — and
// the CLI performs the governed high-water rebind before feeding these inputs to
// createKnowledgeUnit, whose own CAS advances expectedVersion from the base.
export function distillConferenceKnowledge(minutesValue: unknown, requestValue: unknown, positionsValue: readonly unknown[] = [], options: DistillConferenceOptions): readonly CreateKnowledgeUnitInput[] {
  const request = validateConferenceRequest(requestValue);
  const minutes = validateConferenceMinutes(minutesValue);
  if (minutes.conferenceId !== request.id || minutes.projectId !== request.projectId) fail("CONFERENCE_MINUTES_UNBOUND", minutes.id);
  const positions = positionsValue.map((value) => {
    const position = validateConferencePosition(value);
    if (position.conferenceId !== request.id) fail("CONFERENCE_POSITION_UNBOUND", position.id);
    return position;
  });
  const evidence = [...new Set([
    ...positions.flatMap((position) => position.evidenceIds.filter((reference) => reference.startsWith("evidence:"))),
    ...(options.evidenceIds ?? []).filter((reference) => reference.startsWith("evidence:")),
  ])].sort(compareCanonicalText);
  const requestSuffix = request.id.slice(request.id.indexOf(":") + 1);
  const minutesSuffix = minutes.id.slice(minutes.id.indexOf(":") + 1);
  // Fixed conference tag set (no per-store vocabulary.json exists): every tag
  // matches the knowledge tag grammar and the set is non-empty, so the candidate
  // clears the WSC-6 promote machine-check (>=1 tag) with no free-form drift.
  const tags = ["conference-decision", "distilled", `type-${request.type}`].sort(compareCanonicalText);
  const sourceReferences = [`conference:${requestSuffix}`, `conference-minutes:${minutesSuffix}`];
  return minutes.decisions.map((decision, index): CreateKnowledgeUnitInput => ({
    expectedVersion: options.expectedVersionBase + index,
    occurredAt: options.occurredAt,
    externalKey: `conference-decision-${requestSuffix}-${minutesSuffix}-${index + 1}`,
    scope: "project",
    projectId: request.projectId,
    roleScopes: [],
    category: "decision",
    kind: "decision",
    tags,
    subject: truncateOnCodePoint(`${request.title}: ${decision}`, maximumSubjectBytes),
    summary: truncateOnCodePoint(minutes.summary, maximumTextBytes),
    snippet: truncateOnCodePoint(decision, maximumSnippetBytes),
    accountableOwnerId: options.accountableOwnerId ?? "",
    sourceReferences,
    sourceDigest: canonicalSha256({ title: request.title, decision, minutesId: minutes.id }),
    linkedWorkIds: request.linkedWorkIds,
    linkedDecisionIds: [],
    linkedGateIds: [],
    linkedEvidenceIds: evidence,
    lifecycle: "candidate",
    retrievalDisposition: "default",
    freshnessState: "unknown",
    lastVerified: null,
    stalenessPolicy: { maximumAgeDays: options.stalenessDays, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only",
    body: decision,
  }));
}
