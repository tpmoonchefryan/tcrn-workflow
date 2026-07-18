// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  CanonicalOrderError,
  canonicalUtf8Bytes,
  compareCanonicalText,
} from "../../../scripts/lib/canonical-order.mjs";

export { compareCanonicalText } from "../../../scripts/lib/canonical-order.mjs";

export const PROTOCOL_STATUS = "implemented-p2-v1" as const;
export const PROTOCOL_VERSION = 1 as const;
export const P3_ACCEPTANCE_MARKER_PATH = ".context/platform/workflow-v3-capabilities/p3-local-work-graph.accepted.json" as const;

export const PROTOCOL_LIMITS = Object.freeze({
  maxCanonicalBytes: 1_048_576,
  maxRecords: 10_000,
  maxStringLength: 8_192,
  maxExtensions: 64,
});

export const PROTOCOL_REASON_CODES = Object.freeze([
  "CANONICAL_VALUE_INVALID",
  "CANONICALIZATION_MISMATCH",
  "DUPLICATE_ID",
  "EVENT_CHAIN_CORRUPT",
  "EVENT_REPLAY",
  "EXTERNAL_KEY_INVALID",
  "GRAPH_CROSS_PROJECT_PARENT",
  "GRAPH_CYCLE",
  "GRAPH_PARENT_KIND_INVALID",
  "ID_INVALID",
  "INPUT_OVERSIZED",
  "INVALID_TRANSITION",
  "PATH_ESCAPE",
  "RECORD_MALFORMED",
  "REFERENTIAL_INTEGRITY",
  "TIMESTAMP_INVALID",
  "TOMBSTONE_REFERENCED",
  "UNKNOWN_REQUIRED_EXTENSION",
  "VERSION_WINDOW_INVALID",
] as const);

export type ProtocolReasonCode = typeof PROTOCOL_REASON_CODES[number];
export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type PlannedDeliveryKind = "Initiative" | "Epic" | "Story" | "Subtask";
export type ExtensionWorkKind = "Review" | "Incident" | "Release" | "Knowledge";
export type WorkKind = PlannedDeliveryKind | ExtensionWorkKind;
export type WorkStatus = "planned" | "ready" | "active" | "blocked" | "done" | "cancelled";

export interface ProtocolBootstrapStatus {
  readonly phase: "P2";
  readonly normativeProtocolAvailable: true;
  readonly reasonCode: "P2_VERIFIED";
}

export interface ExtensionValue {
  readonly required: boolean;
  readonly value: JsonValue;
}

export interface ExtensionRegistration {
  readonly id: string;
  readonly version: number;
  readonly requiredByDefault: boolean;
}

export interface WorkRecord {
  readonly schemaVersion: "tcrn.work.v1";
  readonly id: string;
  readonly externalKey: string;
  readonly projectId: string;
  readonly kind: WorkKind;
  readonly parentId: string | null;
  readonly status: WorkStatus;
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
  readonly extensions: Readonly<Record<string, ExtensionValue>>;
}

export interface EventRecord {
  readonly schemaVersion: "tcrn.event.v1";
  readonly id: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly priorHash: string | null;
  readonly payload: JsonValue;
  readonly payloadHash: string;
  readonly eventHash: string;
}

export interface KnowledgeRecord {
  readonly schemaVersion: "tcrn.knowledge.v1";
  readonly id: string;
  readonly projectId: string;
  readonly subject: string;
  readonly body: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
  readonly extensions: Readonly<Record<string, ExtensionValue>>;
}

export interface ContextDocument {
  readonly schemaVersion: "tcrn.context.v1";
  readonly id: string;
  readonly projectId: string;
  readonly workIds: readonly string[];
  readonly knowledgeIds: readonly string[];
  readonly generatedAt: string;
  readonly extensions: Readonly<Record<string, ExtensionValue>>;
}

export interface ExchangeEntry {
  readonly path: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ExchangeEnvelope {
  readonly schemaVersion: "tcrn.exchange.v1";
  readonly id: string;
  readonly createdAt: string;
  readonly protocolVersion: number;
  readonly entries: readonly ExchangeEntry[];
  readonly extensions: Readonly<Record<string, ExtensionValue>>;
}

export class ProtocolError extends Error {
  readonly reasonCode: ProtocolReasonCode;

  constructor(reasonCode: ProtocolReasonCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: ProtocolReasonCode, message: string): never {
  throw new ProtocolError(reasonCode, message);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactFields(value: unknown, expected: readonly string[], label: string): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) {
    fail("RECORD_MALFORMED", `${label} requires the exact V1 field set`);
  }
  try {
    const keys = Object.keys(value);
    for (const key of keys) {
      canonicalStringLength(key);
    }
    if (keys.sort(compareCanonicalText).join("\0") !== [...expected].sort(compareCanonicalText).join("\0")) {
      fail("RECORD_MALFORMED", `${label} requires the exact V1 field set`);
    }
  } catch (error) {
    if (error instanceof CanonicalOrderError) {
      fail("CANONICAL_VALUE_INVALID", error.message);
    }
    throw error;
  }
}

function assertSha256(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("RECORD_MALFORMED", "Expected a lowercase SHA-256 digest");
  }
}

function canonicalStringLength(value: string): number {
  try {
    canonicalUtf8Bytes(value);
  } catch (error) {
    if (error instanceof CanonicalOrderError) {
      fail("CANONICAL_VALUE_INVALID", error.message);
    }
    throw error;
  }
  return [...value].length;
}

function assertSortedUnique(values: unknown, label: string): asserts values is readonly string[] {
  if (!Array.isArray(values) || values.length > PROTOCOL_LIMITS.maxRecords || new Set(values).size !== values.length) {
    if (Array.isArray(values) && values.length > PROTOCOL_LIMITS.maxRecords) {
      fail("INPUT_OVERSIZED", label);
    }
    fail("RECORD_MALFORMED", label);
  }
  for (const value of values) {
    assertProtocolId(value);
  }
  const sorted = [...values].sort(compareCanonicalText);
  if (JSON.stringify(values) !== JSON.stringify(sorted)) {
    fail("CANONICALIZATION_MISMATCH", `${label} must be sorted`);
  }
}

function canonicalValue(value: unknown, depth: number): string {
  if (depth > 64) {
    fail("CANONICAL_VALUE_INVALID", "Canonical values may not exceed 64 levels");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && canonicalStringLength(value) > PROTOCOL_LIMITS.maxStringLength) {
      fail("INPUT_OVERSIZED", "A protocol string exceeds the configured limit");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("CANONICAL_VALUE_INVALID", "Only safe integers are canonical protocol numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > PROTOCOL_LIMITS.maxRecords) {
      fail("INPUT_OVERSIZED", "Canonical arrays may not exceed the record limit");
    }
    return `[${value.map((entry) => canonicalValue(entry, depth + 1)).join(",")}]`;
  }
  if (!isPlainObject(value)) {
    fail("CANONICAL_VALUE_INVALID", "Only JSON objects, arrays, strings, booleans, null, and safe integers are supported");
  }
  let keys: string[];
  try {
    keys = Object.keys(value);
    for (const key of keys) {
      canonicalStringLength(key);
    }
    keys.sort(compareCanonicalText);
  } catch (error) {
    if (error instanceof CanonicalOrderError) {
      fail("CANONICAL_VALUE_INVALID", error.message);
    }
    throw error;
  }
  if (keys.length > PROTOCOL_LIMITS.maxRecords) {
    fail("INPUT_OVERSIZED", "Canonical objects may not exceed the property limit");
  }
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key], depth + 1)}`).join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  const canonical = `${canonicalValue(value, 0)}\n`;
  if (Buffer.byteLength(canonical, "utf8") > PROTOCOL_LIMITS.maxCanonicalBytes) {
    fail("INPUT_OVERSIZED", "Canonical input exceeds one MiB");
  }
  return canonical;
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function assertCanonicalJson(text: unknown): JsonValue {
  if (typeof text !== "string" || !text.endsWith("\n") || text.length === 0) {
    fail("CANONICALIZATION_MISMATCH", "Canonical JSON requires exactly one terminal LF");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("RECORD_MALFORMED", "Input is not valid JSON");
  }
  if (canonicalJson(parsed) !== text) {
    fail("CANONICALIZATION_MISMATCH", "Input bytes are not canonical JSON");
  }
  return parsed as JsonValue;
}

export function canonicalExternalKey(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]+$/u.test(value)) {
    fail("EXTERNAL_KEY_INVALID", String(value));
  }
  const canonical = value.toUpperCase();
  if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/u.test(canonical) || canonical.length > 128) {
    fail("EXTERNAL_KEY_INVALID", value);
  }
  return canonical;
}

export function deriveStableId(namespace: unknown, externalKey: unknown): string {
  if (typeof namespace !== "string" || !/^[a-z][a-z0-9-]{1,31}$/u.test(namespace)) {
    fail("ID_INVALID", String(namespace));
  }
  const key = canonicalExternalKey(externalKey);
  return `${namespace}:${createHash("sha256").update(`${namespace}\0${key}`, "utf8").digest("hex").slice(0, 24)}`;
}

export function assertProtocolId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{1,31}:[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    fail("ID_INVALID", String(value));
  }
}

export function parseStrictInstant(value: unknown): bigint {
  if (typeof value !== "string") {
    fail("TIMESTAMP_INVALID", String(value));
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u);
  if (!match) {
    fail("TIMESTAMP_INVALID", value);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText = "", offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0) || hour > 23 || minute > 59 || second > 59) {
    fail("TIMESTAMP_INVALID", value);
  }
  if (offset !== "Z") {
    const offsetHour = Number(offset?.slice(1, 3));
    const offsetMinute = Number(offset?.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      fail("TIMESTAMP_INVALID", value);
    }
  }
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const daysSinceEpoch = era * 146097 + dayOfEra - 719468;
  let offsetSeconds = 0;
  if (offset !== "Z") {
    const magnitude = Number(offset?.slice(1, 3)) * 3600 + Number(offset?.slice(4, 6)) * 60;
    offsetSeconds = offset?.startsWith("+") ? magnitude : -magnitude;
  }
  const wholeSeconds = BigInt(daysSinceEpoch * 86400 + hour * 3600 + minute * 60 + second - offsetSeconds);
  const fractionNanoseconds = BigInt(fractionText.padEnd(9, "0") || "0");
  return wholeSeconds * 1_000_000_000n + fractionNanoseconds;
}

export function assertStrictInstant(value: unknown): void {
  parseStrictInstant(value);
}

export function assertVersionWindow(version: number, minimum: number, maximum: number): void {
  if (![version, minimum, maximum].every(Number.isSafeInteger) || minimum < 1 || minimum > maximum || version < minimum || version > maximum) {
    fail("VERSION_WINDOW_INVALID", `${minimum}:${version}:${maximum}`);
  }
}

function assertWorkRecordShape(record: WorkRecord): void {
  const expectedFields = [
    "schemaVersion", "id", "externalKey", "projectId", "kind", "parentId",
    "status", "revision", "updatedAt", "tombstone", "extensions",
  ];
  assertExactFields(record, expectedFields, "Work records");
  if (record.schemaVersion !== "tcrn.work.v1" || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
    typeof record.tombstone !== "boolean") {
    fail("RECORD_MALFORMED", String(record.id ?? "unknown"));
  }
  assertProtocolId(record.id);
  assertProtocolId(record.projectId);
  if (record.externalKey !== canonicalExternalKey(record.externalKey)) {
    fail("EXTERNAL_KEY_INVALID", record.externalKey);
  }
  assertStrictInstant(record.updatedAt);
  if (record.parentId !== null) {
    assertProtocolId(record.parentId);
  }
  if (typeof record.kind !== "string" || !["Initiative", "Epic", "Story", "Subtask", "Review", "Incident", "Release", "Knowledge"].includes(record.kind)) {
    fail("RECORD_MALFORMED", String(record.id));
  }
  if (typeof record.status !== "string" || !["planned", "ready", "active", "blocked", "done", "cancelled"].includes(record.status)) {
    fail("RECORD_MALFORMED", String(record.id));
  }
}

function validatedExtensionRegistry(registry: unknown): ReadonlyMap<string, ExtensionRegistration> {
  if (!Array.isArray(registry)) {
    fail("RECORD_MALFORMED", "Extension registry");
  }
  if (registry.length > PROTOCOL_LIMITS.maxExtensions) {
    fail("INPUT_OVERSIZED", "Extension registry");
  }
  const registrations = new Map<string, ExtensionRegistration>();
  for (const entry of registry) {
    assertExactFields(entry, ["id", "version", "requiredByDefault"], "Extension registry entries");
    assertProtocolId(entry.id);
    if (registrations.has(entry.id)) {
      fail("DUPLICATE_ID", entry.id);
    }
    if (!Number.isSafeInteger(entry.version) || entry.version < 1 || typeof entry.requiredByDefault !== "boolean") {
      fail("RECORD_MALFORMED", entry.id);
    }
    registrations.set(entry.id, entry as unknown as ExtensionRegistration);
  }
  return registrations;
}

function validateExtensionMap(extensions: unknown, registry: unknown, label: string): void {
  if (!isPlainObject(extensions)) {
    fail("RECORD_MALFORMED", `${label} extensions`);
  }
  let ids: string[];
  try {
    ids = Object.keys(extensions).sort(compareCanonicalText);
  } catch (error) {
    if (error instanceof CanonicalOrderError) {
      fail("CANONICAL_VALUE_INVALID", error.message);
    }
    throw error;
  }
  if (ids.length > PROTOCOL_LIMITS.maxExtensions) {
    fail("INPUT_OVERSIZED", `${label} extensions`);
  }
  const registrations = validatedExtensionRegistry(registry);
  for (const id of ids) {
    canonicalStringLength(id);
    assertProtocolId(id);
    const extension = extensions[id];
    assertExactFields(extension, ["required", "value"], "Extension values");
    if (typeof extension.required !== "boolean") {
      fail("RECORD_MALFORMED", `${label}:${id}`);
    }
    if (extension.required && !registrations.has(id)) {
      fail("UNKNOWN_REQUIRED_EXTENSION", `${label}:${id}`);
    }
    canonicalJson(extension.value);
  }
}

export function validateKnowledgeRecord(record: KnowledgeRecord, registry: readonly ExtensionRegistration[] = []): KnowledgeRecord {
  assertExactFields(
    record,
    ["schemaVersion", "id", "projectId", "subject", "body", "revision", "updatedAt", "tombstone", "extensions"],
    "Knowledge records",
  );
  if (record.schemaVersion !== "tcrn.knowledge.v1" || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
    typeof record.subject !== "string" || canonicalStringLength(record.subject) < 1 || canonicalStringLength(record.subject) > 512 ||
    typeof record.body !== "string" || canonicalStringLength(record.body) > PROTOCOL_LIMITS.maxStringLength || typeof record.tombstone !== "boolean") {
    fail("RECORD_MALFORMED", String(record.id ?? "unknown"));
  }
  assertProtocolId(record.id);
  assertProtocolId(record.projectId);
  assertStrictInstant(record.updatedAt);
  validateExtensionMap(record.extensions, registry, record.id);
  return record;
}

export function validateContextDocument(
  document: ContextDocument,
  workRecords: readonly WorkRecord[],
  knowledgeRecords: readonly KnowledgeRecord[],
  registry: readonly ExtensionRegistration[] = [],
): ContextDocument {
  assertExactFields(
    document,
    ["schemaVersion", "id", "projectId", "workIds", "knowledgeIds", "generatedAt", "extensions"],
    "Context documents",
  );
  if (document.schemaVersion !== "tcrn.context.v1" || !Array.isArray(workRecords) || !Array.isArray(knowledgeRecords)) {
    fail("RECORD_MALFORMED", String(document.id ?? "unknown"));
  }
  if (workRecords.length > PROTOCOL_LIMITS.maxRecords || knowledgeRecords.length > PROTOCOL_LIMITS.maxRecords) {
    fail("INPUT_OVERSIZED", "Context record inputs");
  }
  assertProtocolId(document.id);
  assertProtocolId(document.projectId);
  assertStrictInstant(document.generatedAt);
  assertSortedUnique(document.workIds, "workIds");
  assertSortedUnique(document.knowledgeIds, "knowledgeIds");
  validateExtensionMap(document.extensions, registry, document.id);
  validateWorkGraph(workRecords, registry);
  for (const record of knowledgeRecords) {
    validateKnowledgeRecord(record, registry);
  }
  const workById = new Map(workRecords.map((record) => [record.id, record]));
  const knowledgeById = new Map(knowledgeRecords.map((record) => [record.id, record]));
  for (const id of document.workIds) {
    const record = workById.get(id);
    if (!record || record.projectId !== document.projectId) {
      fail("REFERENTIAL_INTEGRITY", id);
    }
    if (record.tombstone) {
      fail("TOMBSTONE_REFERENCED", id);
    }
  }
  for (const id of document.knowledgeIds) {
    const record = knowledgeById.get(id);
    if (!record || record.projectId !== document.projectId) {
      fail("REFERENTIAL_INTEGRITY", id);
    }
    if (record.tombstone) {
      fail("TOMBSTONE_REFERENCED", id);
    }
  }
  return document;
}

export function validateExchangeEnvelope(envelope: ExchangeEnvelope, registry: readonly ExtensionRegistration[] = []): ExchangeEnvelope {
  assertExactFields(envelope, ["schemaVersion", "id", "createdAt", "protocolVersion", "entries", "extensions"], "Exchange envelopes");
  if (envelope.schemaVersion !== "tcrn.exchange.v1" || envelope.protocolVersion !== PROTOCOL_VERSION || !Array.isArray(envelope.entries)) {
    fail("RECORD_MALFORMED", String(envelope.id ?? "unknown"));
  }
  if (envelope.entries.length > PROTOCOL_LIMITS.maxRecords) {
    fail("INPUT_OVERSIZED", "Exchange entries");
  }
  assertProtocolId(envelope.id);
  assertStrictInstant(envelope.createdAt);
  validateExtensionMap(envelope.extensions, registry, envelope.id);
  let previous: string | null = null;
  for (const entry of envelope.entries) {
    assertExactFields(entry, ["path", "mediaType", "size", "sha256"], "Exchange entries");
    assertExchangePath(entry.path);
    if (typeof entry.sha256 !== "string") {
      fail("RECORD_MALFORMED", entry.path);
    }
    assertSha256(entry.sha256);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.mediaType !== "string" || canonicalStringLength(entry.mediaType) < 1) {
      fail("RECORD_MALFORMED", entry.path);
    }
    if (entry.size > PROTOCOL_LIMITS.maxCanonicalBytes || canonicalStringLength(entry.mediaType) > 128) {
      fail("INPUT_OVERSIZED", entry.path);
    }
    if (previous !== null && compareCanonicalText(entry.path, previous) <= 0) {
      fail("CANONICALIZATION_MISMATCH", entry.path);
    }
    previous = entry.path;
  }
  return envelope;
}

export function validateCompatibility(document: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  assertExactFields(document, ["schemaVersion", "profileId", "protocolVersion", "minimumProtocolVersion", "maximumProtocolVersion", "maturity"], "Compatibility documents");
  if (document.schemaVersion !== "tcrn.compatibility.v1" || typeof document.profileId !== "string" ||
    typeof document.protocolVersion !== "number" || typeof document.minimumProtocolVersion !== "number" ||
    typeof document.maximumProtocolVersion !== "number" || typeof document.maturity !== "string" ||
    !["specified", "fixture_verified"].includes(document.maturity)) {
    fail("RECORD_MALFORMED", "compatibility");
  }
  assertProtocolId(document.profileId);
  assertVersionWindow(document.protocolVersion, document.minimumProtocolVersion, document.maximumProtocolVersion);
  return document;
}

export function validateProfileTrust(document: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  assertExactFields(document, ["schemaVersion", "profileId", "issuer", "issuedAt", "expiresAt", "minimumProtocolVersion", "maximumProtocolVersion", "capabilityDigest"], "Profile trust documents");
  if (document.schemaVersion !== "tcrn.profile-trust.v1" || typeof document.profileId !== "string" || typeof document.issuer !== "string" ||
    typeof document.issuedAt !== "string" || typeof document.expiresAt !== "string" ||
    typeof document.minimumProtocolVersion !== "number" || typeof document.maximumProtocolVersion !== "number" ||
    typeof document.capabilityDigest !== "string") {
    fail("RECORD_MALFORMED", "profile-trust");
  }
  assertProtocolId(document.profileId);
  assertProtocolId(document.issuer);
  const issuedAt = parseStrictInstant(document.issuedAt);
  const expiresAt = parseStrictInstant(document.expiresAt);
  assertVersionWindow(PROTOCOL_VERSION, document.minimumProtocolVersion, document.maximumProtocolVersion);
  assertSha256(document.capabilityDigest);
  if (issuedAt >= expiresAt) {
    fail("VERSION_WINDOW_INVALID", "Profile trust validity window is empty");
  }
  return document;
}

export function validateReceipt(
  document: Readonly<Record<string, unknown>>,
  registry: readonly ExtensionRegistration[] = [],
): Readonly<Record<string, unknown>> {
  assertExactFields(document, ["schemaVersion", "id", "exchangeId", "receivedAt", "status", "subjectDigest", "extensions"], "Receipts");
  if (document.schemaVersion !== "tcrn.receipt.v1" || typeof document.id !== "string" || typeof document.exchangeId !== "string" ||
    typeof document.receivedAt !== "string" || typeof document.status !== "string" ||
    !["accepted", "rejected"].includes(document.status) || typeof document.subjectDigest !== "string") {
    fail("RECORD_MALFORMED", "receipt");
  }
  assertProtocolId(document.id);
  assertProtocolId(document.exchangeId);
  assertStrictInstant(document.receivedAt);
  assertSha256(document.subjectDigest);
  validateExtensionMap(document.extensions, registry, document.id);
  return document;
}

export function validateExtensionRegistration(document: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  assertExactFields(document, ["schemaVersion", "id", "version", "requiredByDefault", "appliesTo", "schemaDigest"], "Extension registrations");
  if (document.schemaVersion !== "tcrn.extension-registration.v1" || typeof document.id !== "string" ||
    !Number.isSafeInteger(document.version) || Number(document.version) < 1 || typeof document.requiredByDefault !== "boolean" ||
    !Array.isArray(document.appliesTo) || document.appliesTo.length < 1 || typeof document.schemaDigest !== "string") {
    fail("RECORD_MALFORMED", "extension-registration");
  }
  assertProtocolId(document.id);
  assertSha256(document.schemaDigest);
  const allowed = new Set(["work", "knowledge", "event", "context", "exchange", "receipt"]);
  // The string check must precede the duplicate check: Set membership is identity-based for
  // objects, so two distinct ["work"] arrays never collide and would slip past the dedupe.
  if (document.appliesTo.some((value) => typeof value !== "string" || !allowed.has(value)) ||
    new Set(document.appliesTo).size !== document.appliesTo.length) {
    fail("RECORD_MALFORMED", document.id);
  }
  return document;
}

export function validateWorkGraph(records: readonly WorkRecord[], registry: readonly ExtensionRegistration[] = []): readonly WorkRecord[] {
  if (!Array.isArray(records) || !Array.isArray(registry)) {
    fail("RECORD_MALFORMED", "Work graph inputs");
  }
  if (records.length > PROTOCOL_LIMITS.maxRecords) {
    fail("INPUT_OVERSIZED", String(records.length));
  }
  const byId = new Map<string, WorkRecord>();
  for (const record of records) {
    assertWorkRecordShape(record);
    validateExtensionMap(record.extensions, registry, record.id);
    if (byId.has(record.id)) {
      fail("DUPLICATE_ID", record.id);
    }
    byId.set(record.id, record);
  }
  const expectedParent = new Map<PlannedDeliveryKind, PlannedDeliveryKind | null>([
    ["Initiative", null],
    ["Epic", "Initiative"],
    ["Story", "Epic"],
    ["Subtask", "Story"],
  ]);
  for (const record of records) {
    const expected = expectedParent.get(record.kind as PlannedDeliveryKind);
    if (expected === null && record.parentId !== null) {
      fail("GRAPH_PARENT_KIND_INVALID", record.id);
    }
    if (expected !== undefined && expected !== null) {
      const parent = record.parentId === null ? undefined : byId.get(record.parentId);
      if (!parent) {
        fail("REFERENTIAL_INTEGRITY", record.id);
      }
      if (parent.projectId !== record.projectId) {
        fail("GRAPH_CROSS_PROJECT_PARENT", record.id);
      }
      if (parent.kind !== expected) {
        fail("GRAPH_PARENT_KIND_INVALID", record.id);
      }
      if (parent.tombstone && !record.tombstone) {
        fail("TOMBSTONE_REFERENCED", record.id);
      }
    } else if (record.parentId !== null) {
      const parent = byId.get(record.parentId);
      if (!parent) {
        fail("REFERENTIAL_INTEGRITY", record.id);
      }
      if (parent.projectId !== record.projectId) {
        fail("GRAPH_CROSS_PROJECT_PARENT", record.id);
      }
      if (parent.tombstone && !record.tombstone) {
        fail("TOMBSTONE_REFERENCED", record.id);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(record: WorkRecord): void {
    if (visiting.has(record.id)) {
      fail("GRAPH_CYCLE", record.id);
    }
    if (visited.has(record.id)) {
      return;
    }
    visiting.add(record.id);
    if (record.parentId !== null) {
      const parent = byId.get(record.parentId);
      if (parent) {
        visit(parent);
      }
    }
    visiting.delete(record.id);
    visited.add(record.id);
  }
  for (const record of records) {
    visit(record);
  }
  return deterministicWorkOrder(records);
}

export function deterministicWorkOrder(records: readonly WorkRecord[]): readonly WorkRecord[] {
  const rank = new Map<WorkKind, number>([
    ["Initiative", 0], ["Epic", 1], ["Story", 2], ["Subtask", 3],
    ["Review", 4], ["Incident", 5], ["Release", 6], ["Knowledge", 7],
  ]);
  return [...records].sort((left, right) => {
    const project = compareCanonicalText(left.projectId, right.projectId);
    if (project !== 0) {
      return project;
    }
    const kind = (rank.get(left.kind) ?? 99) - (rank.get(right.kind) ?? 99);
    return kind === 0 ? compareCanonicalText(left.id, right.id) : kind;
  });
}

const transitions: Readonly<Record<WorkStatus, readonly WorkStatus[]>> = Object.freeze({
  planned: ["ready", "cancelled"],
  ready: ["active", "blocked", "cancelled"],
  active: ["blocked", "done", "cancelled"],
  blocked: ["ready", "active", "cancelled"],
  done: [],
  cancelled: [],
});

export function assertWorkTransition(from: unknown, to: unknown): void {
  if (typeof from !== "string" || typeof to !== "string" || !Object.hasOwn(transitions, from) ||
    !(transitions as Readonly<Record<string, readonly string[]>>)[from]?.includes(to)) {
    fail("INVALID_TRANSITION", `${String(from)}:${String(to)}`);
  }
}

export function createEvent(input: Omit<EventRecord, "eventHash" | "payloadHash" | "schemaVersion">): EventRecord {
  assertExactFields(input, ["id", "streamId", "sequence", "occurredAt", "priorHash", "payload"], "Event inputs");
  assertProtocolId(input.id);
  assertProtocolId(input.streamId);
  assertStrictInstant(input.occurredAt);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    fail("RECORD_MALFORMED", input.id);
  }
  if ((input.sequence === 1) !== (input.priorHash === null)) {
    fail("EVENT_CHAIN_CORRUPT", input.id);
  }
  if (input.priorHash !== null) {
    assertSha256(input.priorHash);
  }
  const payloadHash = canonicalSha256(input.payload);
  const basis = {
    schemaVersion: "tcrn.event.v1" as const,
    id: input.id,
    streamId: input.streamId,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    priorHash: input.priorHash,
    payload: input.payload,
    payloadHash,
  };
  return { ...basis, eventHash: canonicalSha256(basis) };
}

export function validateEventChain(events: readonly EventRecord[]): readonly EventRecord[] {
  if (!Array.isArray(events)) {
    fail("RECORD_MALFORMED", "Event chain");
  }
  if (events.length > PROTOCOL_LIMITS.maxRecords) {
    fail("INPUT_OVERSIZED", "Event chain");
  }
  for (const event of events) {
    assertExactFields(
      event,
      ["schemaVersion", "id", "streamId", "sequence", "occurredAt", "priorHash", "payload", "payloadHash", "eventHash"],
      "Event records",
    );
    if (event.schemaVersion !== "tcrn.event.v1" || typeof event.payloadHash !== "string" || typeof event.eventHash !== "string") {
      fail("RECORD_MALFORMED", String(event.id ?? "unknown"));
    }
    assertSha256(event.payloadHash);
    assertSha256(event.eventHash);
    createEvent({
      id: event.id,
      streamId: event.streamId,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      priorHash: event.priorHash,
      payload: event.payload,
    });
  }
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence || compareCanonicalText(left.id, right.id));
  const ids = new Set<string>();
  for (const [index, event] of ordered.entries()) {
    if (ids.has(event.id) || event.sequence !== index + 1) {
      fail("EVENT_REPLAY", event.id);
    }
    ids.add(event.id);
    const expected = createEvent({
      id: event.id,
      streamId: event.streamId,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      priorHash: event.priorHash,
      payload: event.payload,
    });
    const prior = ordered[index - 1];
    if (event.streamId !== ordered[0]?.streamId || event.payloadHash !== expected.payloadHash || event.eventHash !== expected.eventHash ||
      event.priorHash !== (prior?.eventHash ?? null)) {
      fail("EVENT_CHAIN_CORRUPT", event.id);
    }
  }
  return ordered;
}

export function assertExchangePath(path: unknown): asserts path is string {
  if (typeof path !== "string") {
    fail("RECORD_MALFORMED", "Exchange path must be a string");
  }
  if (canonicalStringLength(path) > 512) {
    fail("INPUT_OVERSIZED", path.slice(0, 32));
  }
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("PATH_ESCAPE", path);
  }
}

export const protocolBootstrapStatus: ProtocolBootstrapStatus = {
  phase: "P2",
  normativeProtocolAvailable: true,
  reasonCode: "P2_VERIFIED",
};
