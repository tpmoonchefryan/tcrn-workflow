// SPDX-License-Identifier: Apache-2.0
import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson, canonicalSha256, parseStrictInstant } from "../../protocol/src/index.js";

export const TELEMETRY_SCHEMA_VERSION = "tcrn.telemetry.v1" as const;
export const TELEMETRY_AVAILABILITY = Object.freeze(["available", "unavailable", "unknown"] as const);
const OBSERVATION_CHANNELS = Object.freeze(["retrieval", "reference", "trigger", "verify"]);
const OBSERVATION_CHANNEL_BY_KIND: Record<string, string> = Object.freeze({ retrieval: "retrieval", "retrieval-hit": "retrieval", reference: "reference", pull: "reference", trigger: "trigger", "rule-trigger": "trigger", verify: "verify", "gate-result": "verify" });
const OBSERVATION_COVERAGE_VERSION = "tcrn.telemetry-observation-coverage.v1";
const OBSERVATION_CHANNEL_COVERAGE_VERSION = "tcrn.telemetry-observation-coverage.v2";
const OBSERVATION_BOUNDARY_PREFIX = "telemetry:observation-collector:";
export const TELEMETRY_LINE_BYTES = 16 * 1024;
export const TELEMETRY_RETENTION_DAYS = 90;
export type TelemetryAvailability = typeof TELEMETRY_AVAILABILITY[number];

export interface TelemetryUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export type TelemetryPayload = Readonly<Record<string, unknown>>;

export interface TelemetryRecord {
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly session: string;
  readonly payload: TelemetryPayload;
}

export interface TelemetryReadResult {
  readonly records: readonly TelemetryRecord[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly problems: readonly { readonly path: string; readonly line: number; readonly reasonCode: string }[];
}

interface TelemetryObservationWindow {
  readonly windowDays: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly complete: boolean;
  readonly missingDays: readonly string[];
  readonly invalidDays: readonly string[];
  readonly records: readonly TelemetryRecord[];
  readonly problems: TelemetryReadResult["problems"];
}

export interface TelemetryEvidenceSnapshot {
  readonly schemaVersion: "tcrn.telemetry-evidence.v1";
  readonly id: string;
  readonly digest: string;
  readonly fields: {
    readonly at: string;
    readonly kind: string;
    readonly session: string;
    readonly payload: TelemetryPayload;
  };
}

export class TelemetryError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "TelemetryError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: string, message: string): never {
  throw new TelemetryError(reasonCode, message);
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : undefined;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("TELEMETRY_RECORD_INVALID", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function nullableText(value: unknown, label: string, maximum = 256): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !value.isWellFormed() || value.includes("\u0000")) fail("TELEMETRY_RECORD_INVALID", `${label} must be null or bounded text`);
  canonicalJson(value);
  return value;
}

function requiredText(value: unknown, label: string, maximum = 256): string {
  const result = nullableText(value, label, maximum);
  if (result === null) fail("TELEMETRY_RECORD_INVALID", `${label} is required`);
  return result;
}

const FORBIDDEN_PAYLOAD_KEYS = /(?:prompt|body|content|transcript|stdin|stdout|stderr|secret|password|token(?!s)|response)/iu;

function safePayloadValue(value: unknown, key: string, depth = 0): unknown {
  if (depth > 4) fail("TELEMETRY_RECORD_INVALID", `${key} is too deeply nested`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 256 || !value.isWellFormed() || value.includes("\u0000")) fail("TELEMETRY_RECORD_INVALID", `${key} must be bounded text`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) fail("TELEMETRY_RECORD_INVALID", `${key} must be a finite safe number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) fail("TELEMETRY_RECORD_INVALID", `${key} has too many entries`);
    return Object.freeze(value.map((entry, index) => safePayloadValue(entry, `${key}[${index}]`, depth + 1)));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 32) fail("TELEMETRY_RECORD_INVALID", `${key} has too many fields`);
    const next: Record<string, unknown> = {};
    for (const [childKey, childValue] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(childKey) || FORBIDDEN_PAYLOAD_KEYS.test(childKey)) fail("TELEMETRY_RECORD_INVALID", `${key}.${childKey} is not an allowed telemetry field`);
      next[childKey] = safePayloadValue(childValue, `${key}.${childKey}`, depth + 1);
    }
    return Object.freeze(next);
  }
  fail("TELEMETRY_RECORD_INVALID", `${key} has an unsupported value`);
}

function nullableCount(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail("TELEMETRY_RECORD_INVALID", `${label} must be a non-negative integer or null`);
  return Number(value);
}

function usage(value: unknown): TelemetryUsage | null {
  if (value === null || value === undefined) return null;
  const entry = object(value, "usage");
  const keys = Object.keys(entry).sort();
  if (canonicalJson(keys) !== canonicalJson(["inputTokens", "outputTokens", "totalTokens"])) fail("TELEMETRY_RECORD_INVALID", "usage fields are not exact");
  return {
    inputTokens: nullableCount(entry.inputTokens, "usage.inputTokens"),
    outputTokens: nullableCount(entry.outputTokens, "usage.outputTokens"),
    totalTokens: nullableCount(entry.totalTokens, "usage.totalTokens"),
  };
}

function payload(value: unknown): TelemetryPayload {
  const entry = object(value, "payload");
  const expected = ["availability", "dispatchId", "mode", "observedModel", "parentSession", "requestedModel", "requestedTier", "resolvedTier", "source", "taskClass", "usage", "workId"];
  if (canonicalJson(Object.keys(entry).sort()) === canonicalJson(expected)) {
    const availability = entry.availability;
    if (!(TELEMETRY_AVAILABILITY as readonly string[]).includes(availability as string)) fail("TELEMETRY_RECORD_INVALID", "availability");
    return Object.freeze({
      dispatchId: nullableText(entry.dispatchId, "dispatchId"),
      parentSession: nullableText(entry.parentSession, "parentSession"),
      workId: nullableText(entry.workId, "workId"),
      taskClass: nullableText(entry.taskClass, "taskClass", 128),
      mode: nullableText(entry.mode, "mode", 128),
      requestedTier: nullableText(entry.requestedTier, "requestedTier", 128),
      resolvedTier: nullableText(entry.resolvedTier, "resolvedTier", 128),
      requestedModel: nullableText(entry.requestedModel, "requestedModel"),
      observedModel: nullableText(entry.observedModel, "observedModel"),
      usage: usage(entry.usage),
      source: requiredText(entry.source, "source", 128),
      availability: availability as TelemetryAvailability,
    });
  }
  if (Object.keys(entry).length === 0 || typeof entry.source !== "string") fail("TELEMETRY_RECORD_INVALID", "payload requires a source");
  if (Object.keys(entry).some((key) => FORBIDDEN_PAYLOAD_KEYS.test(key))) fail("TELEMETRY_RECORD_INVALID", "payload contains private content");
  const safe: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(entry)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key)) fail("TELEMETRY_RECORD_INVALID", "payload field name");
    safe[key] = safePayloadValue(entryValue, `payload.${key}`);
  }
  requiredText(safe.source, "payload.source", 128);
  return Object.freeze(safe);
}

export function validateTelemetryRecord(value: unknown): TelemetryRecord {
  const entry = object(value, "telemetry record");
  const expected = ["at", "id", "kind", "payload", "schemaVersion", "session"];
  if (canonicalJson(Object.keys(entry).sort()) !== canonicalJson(expected)) fail("TELEMETRY_RECORD_INVALID", "record fields are not exact");
  if (entry.schemaVersion !== TELEMETRY_SCHEMA_VERSION) fail("TELEMETRY_RECORD_INVALID", "schemaVersion");
  const at = requiredText(entry.at, "at", 64);
  try { parseStrictInstant(at); } catch { fail("TELEMETRY_RECORD_INVALID", "at is not a strict instant"); }
  const kind = requiredText(entry.kind, "kind", 128);
  const session = requiredText(entry.session, "session");
  const body = payload(entry.payload);
  const id = requiredText(entry.id, "id", 128);
  if (!/^telemetry:[a-f0-9]{24}$/u.test(id)) fail("TELEMETRY_RECORD_INVALID", "id");
  const record = Object.freeze({ schemaVersion: TELEMETRY_SCHEMA_VERSION, id, at, kind, session, payload: body });
  if (Buffer.byteLength(canonicalJson(record as unknown as import("../../protocol/src/index.js").JsonValue), "utf8") > TELEMETRY_LINE_BYTES) fail("TELEMETRY_RECORD_INVALID", `record exceeds ${TELEMETRY_LINE_BYTES} bytes`);
  return record;
}

function telemetryId(kind: string, at: string, session: string, body: TelemetryPayload): string {
  return `telemetry:${canonicalSha256({ schemaVersion: TELEMETRY_SCHEMA_VERSION, kind, at, session, payload: body }).slice(0, 24)}`;
}

export function createTelemetryRecord(input: {
  readonly at: string;
  readonly kind: string;
  readonly session: string;
  readonly payload: TelemetryPayload;
  readonly id?: string;
}): TelemetryRecord {
  const body = payload(input.payload);
  const at = requiredText(input.at, "at", 64);
  const session = requiredText(input.session, "session");
  const kind = requiredText(input.kind, "kind", 128);
  try { parseStrictInstant(at); } catch { fail("TELEMETRY_RECORD_INVALID", "at is not a strict instant"); }
  const id = input.id ?? telemetryId(kind, at, session, body);
  return validateTelemetryRecord({ schemaVersion: TELEMETRY_SCHEMA_VERSION, id, at, kind, session, payload: body });
}

export function telemetryEvidenceSnapshot(record: TelemetryRecord): TelemetryEvidenceSnapshot {
  const validated = validateTelemetryRecord(record);
  return Object.freeze({
    schemaVersion: "tcrn.telemetry-evidence.v1",
    id: validated.id,
    digest: canonicalSha256(validated as unknown as import("../../protocol/src/index.js").JsonValue),
    fields: Object.freeze({
      at: validated.at,
      kind: validated.kind,
      session: validated.session,
      payload: validated.payload,
    }),
  });
}

function rootDirectory(root: string): string {
  if (typeof root !== "string" || !root.startsWith("/") || root.includes("\u0000")) fail("TELEMETRY_ROOT_INVALID", "telemetry root must be an absolute path");
  return resolve(root);
}

function fileFor(root: string, at: string): string {
  return join(rootDirectory(root), "telemetry", `${new Date(at).toISOString().slice(0, 10)}.ndjson`);
}

async function regularDirectory(path: string, create = false): Promise<void> {
  let stats;
  try { stats = await lstat(path); }
  catch (error) {
    if (!create || errorCode(error) !== "ENOENT") throw error;
    try { await mkdir(path, { recursive: false, mode: 0o700 }); }
    catch (mkdirError) { if (errorCode(mkdirError) !== "EEXIST") throw mkdirError; }
    stats = await lstat(path);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("TELEMETRY_ROOT_INVALID", `${path} must be a real directory`);
}

async function regularFileIfPresent(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) fail("TELEMETRY_FILE_INVALID", `${path} must be a regular file`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function telemetryLock(lockPath: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath, { recursive: false, mode: 0o700 });
      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() - started >= 2_000) fail("TELEMETRY_LOCKED", "telemetry writer lock did not clear");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
}

function lineRecord(path: string, line: string, lineNumber: number): { record?: TelemetryRecord; problem?: { path: string; line: number; reasonCode: string } } {
  try { return { record: validateTelemetryRecord(JSON.parse(line)) }; }
  catch (error) { return { problem: { path, line: lineNumber, reasonCode: error !== null && typeof error === "object" && typeof (error as { readonly reasonCode?: unknown }).reasonCode === "string" ? (error as { readonly reasonCode: string }).reasonCode : "TELEMETRY_RECORD_INVALID" } }; }
}

export async function appendTelemetryRecord(root: string, record: TelemetryRecord): Promise<{ readonly record: TelemetryRecord; readonly path: string; readonly duplicate: boolean }> {
  const validated = validateTelemetryRecord(record);
  const path = fileFor(root, validated.at);
  const directory = dirname(path);
  await regularDirectory(rootDirectory(root), true);
  await regularDirectory(directory, true);
  await regularFileIfPresent(path);
  const lockPath = `${path}.lock`;
  await telemetryLock(lockPath);
  try {
    let existing = "";
    try { existing = await readFile(path, "utf8"); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    for (const [index, line] of existing.split("\n").entries()) {
      if (line.length === 0) continue;
      const parsed = lineRecord(path, line, index + 1).record;
      if (parsed?.id === validated.id) return { record: parsed, path, duplicate: true };
    }
    const serialized = canonicalJson(validated as unknown as import("../../protocol/src/index.js").JsonValue);
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(path, `${prefix}${serialized}`, { mode: 0o600 });
    return { record: validated, path, duplicate: false };
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function readTelemetryRecords(root: string, options: {
  readonly kind?: string;
  readonly taskClass?: string;
  readonly since?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly preserveOrder?: boolean;
} = {}): Promise<TelemetryReadResult> {
  if (options.kind !== undefined) requiredText(options.kind, "kind", 128);
  if (options.taskClass !== undefined) requiredText(options.taskClass, "taskClass", 128);
  const since = options.since === undefined ? undefined : (() => {
    try { return parseStrictInstant(options.since); } catch { fail("TELEMETRY_FILTER_INVALID", "since is not a strict instant"); }
  })();
  const offset = options.offset === undefined ? 0 : options.offset;
  const limit = options.limit === undefined ? 100 : options.limit;
  if (!Number.isSafeInteger(offset) || offset < 0) fail("TELEMETRY_FILTER_INVALID", "offset must be a non-negative integer");
  if (!Number.isSafeInteger(limit) || limit < 1) fail("TELEMETRY_FILTER_INVALID", "limit must be a positive integer");
  const base = rootDirectory(root);
  const directory = join(base, "telemetry");
  try {
    const rootStats = await lstat(base);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) fail("TELEMETRY_ROOT_INVALID", `${base} must be a real directory`);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { records: [], total: 0, offset, limit, problems: [] };
    throw error;
  }
  let names: string[];
  try {
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) fail("TELEMETRY_ROOT_INVALID", `${directory} must be a real directory`);
    names = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.ndjson$/u.test(entry.name)).map((entry) => entry.name).sort();
  }
  catch (error) { if (errorCode(error) === "ENOENT") return { records: [], total: 0, offset, limit, problems: [] }; throw error; }
  const records: TelemetryRecord[] = [];
  const problems: { path: string; line: number; reasonCode: string }[] = [];
  for (const name of names) {
    const path = join(directory, basename(name));
    await regularFileIfPresent(path);
    const source = await readFile(path, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (line.length === 0) continue;
      const parsed = lineRecord(path, line, index + 1);
      if (parsed.problem) problems.push(parsed.problem);
      else if (parsed.record) records.push(parsed.record);
    }
  }
  const filtered = records.filter((record) => (options.kind === undefined || record.kind === options.kind)
    && (options.taskClass === undefined || record.payload.taskClass === options.taskClass)
    && (since === undefined || parseStrictInstant(record.at) >= since));
  if (!options.preserveOrder) filtered.sort((left, right) => {
    const leftAt = parseStrictInstant(left.at);
    const rightAt = parseStrictInstant(right.at);
    return leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : left.id.localeCompare(right.id);
  });
  return { records: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit, problems };
}

export async function readTelemetryStats(root: string, options: {
  readonly kind?: string;
  readonly taskClass?: string;
  readonly since?: string;
} = {}): Promise<{
  readonly records: number;
  readonly countsByKind: Readonly<Record<string, number>>;
  readonly usage: { readonly observedRecords: number; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly totalTokens: number | null };
  readonly problems: TelemetryReadResult["problems"];
}> {
  const result = await readTelemetryRecords(root, {
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.taskClass === undefined ? {} : { taskClass: options.taskClass }),
    ...(options.since === undefined ? {} : { since: options.since }),
    limit: Number.MAX_SAFE_INTEGER,
  });
  const counts = new Map<string, number>();
  let observedRecords = 0;
  let inputTotal = 0;
  let outputTotal = 0;
  let totalTotal = 0;
  let inputKnown = false;
  let outputKnown = false;
  let totalKnown = false;
  for (const record of result.records) {
    counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
    const usageValue = record.payload.usage as TelemetryUsage | null | undefined;
    if (usageValue !== null && typeof usageValue === "object") {
      observedRecords += 1;
      if (typeof usageValue.inputTokens === "number") { inputKnown = true; inputTotal += usageValue.inputTokens; }
      if (typeof usageValue.outputTokens === "number") { outputKnown = true; outputTotal += usageValue.outputTokens; }
      if (typeof usageValue.totalTokens === "number") { totalKnown = true; totalTotal += usageValue.totalTokens; }
    }
  }
  const countsByKind = Object.fromEntries([...counts.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  return {
    records: result.total,
    countsByKind,
    usage: {
      observedRecords,
      inputTokens: inputKnown ? inputTotal : null,
      outputTokens: outputKnown ? outputTotal : null,
      totalTokens: totalKnown ? totalTotal : null,
    },
    problems: result.problems,
  };
}

function observationChronologicalCompare(left: TelemetryRecord, right: TelemetryRecord): number { return left.at < right.at ? -1 : left.at > right.at ? 1 : Number(left.payload.sequence) - Number(right.payload.sequence) || left.id.localeCompare(right.id); }
function observationPhaseSequenceValid(rows: readonly TelemetryRecord[]): boolean { const phases = rows.map((record) => record.payload.phase), sequences = rows.map((record) => record.payload.sequence); return rows.length >= 2 && rows.length % 2 === 0 && rows.every((record) => record.payload.availability === "available") && phases.every((phase, index) => phase === (index % 2 === 0 ? "start" : "stop")) && sequences.every((sequence, index) => Number.isSafeInteger(sequence) && Number(sequence) >= 1 && (index === 0 || Number(sequence) === Number(sequences[index - 1]) + 1)); }
function observationIntervals(rows: readonly TelemetryRecord[]): readonly { readonly ordered: readonly TelemetryRecord[]; readonly start: bigint; readonly end: bigint; readonly last: TelemetryRecord }[] | null {
  const ordered = [...rows].sort(observationChronologicalCompare); if (!observationPhaseSequenceValid(rows) || !observationPhaseSequenceValid(ordered)) return null;
  const intervals: { ordered: readonly TelemetryRecord[]; start: bigint; end: bigint; last: TelemetryRecord }[] = [];
  for (let index = 0; index < ordered.length; index += 2) { const start = ordered[index]!; const last = ordered[index + 1]!; intervals.push({ ordered: [start, last], start: parseStrictInstant(start.at), end: parseStrictInstant(last.at), last }); }
  return intervals;
}

// One channel's checkpoint against the records it claims. `zero` is only for the per-channel
// v2 receipt's observed zero (STORY-453 R2): no real record, and a high-water count of 0.
function observationCoverageChannelValid(proof: unknown, entries: readonly TelemetryRecord[], channel: string, from: string, until: string, zero = false): boolean {
  if (proof === null || typeof proof !== "object" || Array.isArray(proof)) return false;
  const fields = proof as Record<string, unknown>;
  if (canonicalJson(Object.keys(fields).sort()) !== canonicalJson(["availability", "highWaterCount", "highWaterDay", "highWaterDigest", "recordCount", "source", "sourceDigest", "startSequence", "stopSequence"])) return false;
  const boundary = entries.filter((record) => OBSERVATION_CHANNEL_BY_KIND[record.kind] === channel && String(record.payload.source).startsWith(OBSERVATION_BOUNDARY_PREFIX)), exact = boundary.filter((record) => record.payload.source === fields.source), identityPrefix = typeof fields.source === "string" ? fields.source.slice(0, -channel.length) : "", rows = exact.length > 0 ? exact : boundary.filter((record) => String(record.payload.source).startsWith(identityPrefix) && String(record.payload.source).endsWith(`:${channel}`));
  const actual = entries.filter((record) => OBSERVATION_CHANNEL_BY_KIND[record.kind] === channel && !String(record.payload.source).startsWith(OBSERVATION_BOUNDARY_PREFIX)).sort(observationChronologicalCompare);
  if (rows.length === 0 || (actual.length === 0) !== zero) return false;
  const groups = new Map<string, TelemetryRecord[]>(); for (const row of rows) { const source = row.payload.source as string; groups.set(source, [...(groups.get(source) ?? []), row]); }
  const intervals = [...groups.values()].flatMap((group) => observationIntervals(group) ?? []);
  const fromValue = parseStrictInstant(from), untilValue = parseStrictInstant(until);
  intervals.sort((left, right) => left.start < right.start ? -1 : left.start > right.start ? 1 : left.end < right.end ? -1 : 1);
  let cursor = fromValue;
  for (const interval of intervals) { if (interval.start > cursor) return false; if (interval.end > cursor) cursor = interval.end; }
  const terminal = intervals.reduce((best, interval) => best === null || interval.end > best.end ? interval : best, null as typeof intervals[number] | null);
  const selected = intervals.flatMap((interval) => interval.ordered).sort(observationChronologicalCompare);
  return fields.availability === "available" && typeof fields.source === "string" && fields.source.startsWith(OBSERVATION_BOUNDARY_PREFIX) && typeof fields.sourceDigest === "string" && /^[a-f0-9]{64}$/u.test(fields.sourceDigest) && Number.isSafeInteger(fields.recordCount) && Number(fields.recordCount) >= 2 && selected.length === fields.recordCount && Number.isSafeInteger(fields.highWaterCount) && Number(fields.highWaterCount) >= (zero ? 0 : 1) && Number(fields.highWaterCount) === actual.length && fields.highWaterDay === from.slice(0, 10) && typeof fields.highWaterDigest === "string" && fields.highWaterDigest === canonicalSha256(actual as unknown as import("../../protocol/src/index.js").JsonValue) && cursor >= untilValue - 1_000_000n && terminal !== null && Number.isSafeInteger(fields.startSequence) && Number.isSafeInteger(fields.stopSequence) && Number(fields.startSequence) === Number(intervals[0]?.ordered[0]?.payload.sequence) && Number(fields.stopSequence) === Number(terminal.last.payload.sequence) && canonicalSha256(selected as unknown as import("../../protocol/src/index.js").JsonValue) === fields.sourceDigest;
}

function observationCoverageValid(value: TelemetryPayload, entries: readonly TelemetryRecord[], from: string, until: string): boolean {
  const channels = value.channels;
  if (value.source !== "telemetry:observation-collector" || value.coverageVersion !== OBSERVATION_COVERAGE_VERSION || !Array.isArray(channels) || channels.length !== OBSERVATION_CHANNELS.length || new Set(channels).size !== channels.length || !OBSERVATION_CHANNELS.every((channel) => channels.includes(channel)) || value.channelCheckpoints === null || typeof value.channelCheckpoints !== "object" || Array.isArray(value.channelCheckpoints)) return false;
  const proofs = value.channelCheckpoints as Record<string, unknown>;
  return canonicalJson(Object.keys(proofs).sort()) === canonicalJson([...OBSERVATION_CHANNELS].sort()) && OBSERVATION_CHANNELS.every((channel) => observationCoverageChannelValid(proofs[channel], entries, channel, from, until));
}

/**
 * TCRN-CROSS-STORY-453: a per-channel (v2) seal receipt against the records it claims. The
 * single-channel rules are the v1 rules (interval union over the whole UTC day, boundary
 * phase and sequence, high water, source identity); an observed zero additionally needs no
 * real record and the channel's valid ok self-checks, named by id. `entries` holds the day's
 * records and the boundary rows around it; receipts themselves are not entries.
 */
export function observationChannelReceiptValid(receipt: TelemetryRecord, entries: readonly TelemetryRecord[]): boolean {
  const value = receipt.payload;
  const channel = value.channel as string;
  const from = String(value.coveredFrom);
  const until = String(value.coveredUntil);
  const day = from.slice(0, 10);
  if (receipt.kind !== "observation-coverage" || value.source !== "telemetry:observation-collector" || value.coverageVersion !== OBSERVATION_CHANNEL_COVERAGE_VERSION || value.availability !== "available" || value.collectionErrors !== 0 || !OBSERVATION_CHANNELS.includes(channel) || !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u.test(from) || until !== new Date(Date.parse(from) + 86_400_000).toISOString() || Date.parse(receipt.at) < Date.parse(until)) return false;
  const inDay = entries.filter((record) => new Date(record.at).toISOString().slice(0, 10) === day);
  const actual = inDay.filter((record) => OBSERVATION_CHANNEL_BY_KIND[record.kind] === channel && !String(record.payload.source).startsWith(OBSERVATION_BOUNDARY_PREFIX)).sort(observationChronologicalCompare);
  const selfChecks = inDay.filter((record) => record.kind === COLLECTOR_SELF_CHECK_KIND && record.payload.channel === channel && record.payload.verdict === "ok" && collectorSelfCheckProblem(record) === null).map((record) => record.id).sort().slice(0, 64);
  const zero = value.outcome === "observed-zero";
  if (!zero && value.outcome !== "records") return false;
  const proofEntries = entries.filter((record) => (record.at >= from && record.at < until) || String(record.payload.source).startsWith(OBSERVATION_BOUNDARY_PREFIX));
  return observationCoverageChannelValid(value.checkpoint, proofEntries, channel, from, until, zero) && value.recordCount === actual.length && value.sourceDigest === canonicalSha256(actual as unknown as import("../../protocol/src/index.js").JsonValue)
    && canonicalJson(value.selfCheckIds as import("../../protocol/src/index.js").JsonValue) === canonicalJson(zero ? selfChecks : []) && (!zero || selfChecks.length > 0);
}

// TCRN-CROSS-STORY-452: a collector self-check records that a channel's own write path ran
// on a day, which is what lets a day with no real record read as an observed zero rather
// than as unknown. It may come only from the write path of that channel's real records;
// this table is the one place that says which path that is, and the writers read it.
export const COLLECTOR_SELF_CHECK_KIND = "collector-self-check";
export const COLLECTOR_SELF_CHECK_SOURCES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  retrieval: Object.freeze(["knowledge-inject:retrieval"]),
  reference: Object.freeze(["knowledge-inject:reference"]),
  trigger: Object.freeze(["knowledge-inject:trigger"]),
  verify: Object.freeze(["cli:gate-result", "final-gate-plan:batch-verify"]),
});
const SELF_CHECK_FIELDS = JSON.stringify(["availability", "channel", "host", "reasonCode", "source", "verdict"]);

/** Null for a valid self-check; otherwise the reason code it is refused under. */
export function collectorSelfCheckProblem(record: TelemetryRecord): string | null {
  const value = record.payload;
  const reasonValid = value.verdict === "ok" ? value.reasonCode === null : value.verdict === "failed" && typeof value.reasonCode === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(value.reasonCode);
  if (record.kind !== COLLECTOR_SELF_CHECK_KIND || JSON.stringify(Object.keys(value).sort()) !== SELF_CHECK_FIELDS || value.availability !== "available" || typeof value.host !== "string" || !OBSERVATION_CHANNELS.includes(value.channel as string) || !reasonValid) return "TELEMETRY_SELF_CHECK_INVALID";
  return (COLLECTOR_SELF_CHECK_SOURCES[value.channel as string] ?? []).includes(value.source as string) ? null : "TELEMETRY_SELF_CHECK_SOURCE_INVALID";
}

export interface ObservationChannelDay {
  readonly channel: string;
  readonly day: string;
  readonly reading: "records" | "observed-zero" | "broken" | "unknown";
  readonly availability: TelemetryAvailability;
  readonly count: number | null;
  readonly selfChecks: { readonly ok: number; readonly failed: number };
  readonly reasonCodes: readonly string[];
}

export interface ObservationChannelDays {
  readonly day: string;
  readonly channels: readonly ObservationChannelDay[];
  readonly refusedSelfChecks: readonly { readonly id: string; readonly channel: string | null; readonly reasonCode: string }[];
}

/** R2: records, an observed zero (an ok self-check and no real record), broken (failed self-checks only), or unknown (no self-check). */
export function classifyObservationChannelDays(records: readonly TelemetryRecord[], day: string): ObservationChannelDays {
  const inDay = records.filter((record) => new Date(record.at).toISOString().slice(0, 10) === day);
  const checks = inDay.filter((record) => record.kind === COLLECTOR_SELF_CHECK_KIND);
  const refusedSelfChecks = checks.flatMap((record) => { const reasonCode = collectorSelfCheckProblem(record); return reasonCode === null ? [] : [{ id: record.id, channel: typeof record.payload.channel === "string" ? record.payload.channel : null, reasonCode }]; });
  const channels = OBSERVATION_CHANNELS.map((channel): ObservationChannelDay => {
    const count = inDay.filter((record) => OBSERVATION_CHANNEL_BY_KIND[record.kind] === channel && !String(record.payload.source).startsWith(OBSERVATION_BOUNDARY_PREFIX)).length;
    const valid = checks.filter((record) => record.payload.channel === channel && collectorSelfCheckProblem(record) === null);
    const ok = valid.filter((record) => record.payload.verdict === "ok").length;
    const reasonCodes = [...new Set(valid.filter((record) => record.payload.verdict === "failed").map((record) => String(record.payload.reasonCode)))].sort();
    const reading: ObservationChannelDay["reading"] = count > 0 ? "records" : ok > 0 ? "observed-zero" : reasonCodes.length > 0 ? "broken" : "unknown";
    return { channel, day, reading, availability: reading === "broken" ? "unavailable" : reading === "unknown" ? "unknown" : "available", count: reading === "records" || reading === "observed-zero" ? count : null, selfChecks: { ok, failed: valid.length - ok }, reasonCodes };
  });
  return { day, channels, refusedSelfChecks };
}

/**
 * SUB-225: one self-check from a channel's write path. Its id is the dedupe key (session,
 * UTC day, channel, verdict, reason), so the telemetry writer lock keeps it to one ok per
 * session, day and channel and one failed per reason code, also across concurrent hooks.
 */
export async function appendCollectorSelfCheck(root: string, input: { readonly at: string; readonly session: string; readonly channel: string; readonly host: string; readonly source: string; readonly verdict: "ok" | "failed"; readonly reasonCode?: string | null }): Promise<{ readonly reasonCode: string; readonly id: string | null }> {
  const reasonCode = input.reasonCode ?? null;
  const key = { schemaVersion: TELEMETRY_SCHEMA_VERSION, kind: COLLECTOR_SELF_CHECK_KIND, day: new Date(input.at).toISOString().slice(0, 10), session: input.session, channel: input.channel, verdict: input.verdict, reasonCode };
  const record = createTelemetryRecord({ id: `telemetry:${canonicalSha256(key).slice(0, 24)}`, at: input.at, kind: COLLECTOR_SELF_CHECK_KIND, session: input.session, payload: { source: input.source, channel: input.channel, host: input.host, verdict: input.verdict, reasonCode, availability: "available" } });
  const problem = collectorSelfCheckProblem(record);
  if (problem !== null) return { reasonCode: problem, id: null };
  const receipt = await appendTelemetryRecord(root, record);
  return { reasonCode: receipt.duplicate ? "TELEMETRY_SELF_CHECK_ALREADY_RECORDED" : "TELEMETRY_SELF_CHECK_RECORDED", id: receipt.record.id };
}

export async function readTelemetryDay(root: string, day: string): Promise<{ readonly records: readonly TelemetryRecord[]; readonly problems: TelemetryReadResult["problems"] }> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`)) || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) fail("TELEMETRY_FILTER_INVALID", "day must be a UTC calendar date");
  const path = join(rootDirectory(root), "telemetry", `${day}.ndjson`);
  let source = "";
  try { await regularFileIfPresent(path); source = await readFile(path, "utf8"); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  const records: TelemetryRecord[] = [];
  const problems: { path: string; line: number; reasonCode: string }[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    if (line.length === 0) continue;
    const parsed = lineRecord(path, line, index + 1);
    if (parsed.problem) problems.push(parsed.problem); else if (parsed.record) records.push(parsed.record);
  }
  return { records, problems };
}

/** Read-only: one UTC day's four channel readings; it writes nothing and backfills nothing (R4). */
export async function readObservationChannelDays(root: string, day: string): Promise<ObservationChannelDays & { readonly problems: TelemetryReadResult["problems"] }> {
  const { records, problems } = await readTelemetryDay(root, day);
  return { ...classifyObservationChannelDays(records, day), problems };
}

export interface ObservationDayVerdict {
  readonly channel: string;
  readonly verdict: "sealed" | "observed-zero" | "idle" | "unproven";
  readonly receipts: readonly { readonly id: string; readonly coverageVersion: string; readonly valid: boolean }[];
}

export interface ObservationDayVerdicts {
  readonly day: string;
  readonly idle: boolean;
  readonly channels: readonly ObservationDayVerdict[];
}

function byInstant(left: TelemetryRecord, right: TelemetryRecord): number {
  return left.at < right.at ? -1 : left.at > right.at ? 1 : left.id.localeCompare(right.id);
}

/**
 * TCRN-CROSS-STORY-453 R3: each channel's verdict for one UTC day. `records` holds the day's
 * records, the boundary rows around it and its seal receipts (the day file, the one before and
 * the three after). A valid v2 receipt gives sealed or observed-zero; a v1 receipt, judged by
 * the v1 rules, seals all four channels; otherwise the day is idle (no boundary row for the day
 * and no self-check from any host, STORY-454 R2) or the channel is unproven. Receipts are listed with
 * their validity. Read-only.
 */
export function observationDayVerdicts(records: readonly TelemetryRecord[], day: string, { unreadable = false }: { readonly unreadable?: boolean } = {}): ObservationDayVerdicts {
  const from = `${day}T00:00:00.000Z`;
  const until = new Date(Date.parse(from) + 86_400_000).toISOString();
  const entries = records.filter((record) => record.kind !== "observation-coverage");
  const inDay = entries.filter((record) => new Date(record.at).toISOString().slice(0, 10) === day).sort(byInstant);
  const boundary = entries.filter((record) => String(record.payload.source).startsWith(OBSERVATION_BOUNDARY_PREFIX));
  // A boundary row belongs to the day its highWaterDay names (a Stop writes a day's rows later).
  const idle = !boundary.some((record) => record.payload.highWaterDay === day) && !inDay.some((record) => record.kind === COLLECTOR_SELF_CHECK_KIND);
  const receipts = records.filter((record) => record.kind === "observation-coverage" && record.payload.coveredFrom === from && record.payload.coveredUntil === until).sort(byInstant);
  const proofRecords = entries.filter((record) => (record.at >= from && record.at < until) || String(record.payload.source).startsWith(OBSERVATION_BOUNDARY_PREFIX));
  const v1 = receipts.filter((record) => record.payload.coverageVersion !== OBSERVATION_CHANNEL_COVERAGE_VERSION).map((record) => {
    const value = record.payload;
    const valid = !unreadable && inDay.every((entry) => entry.payload.availability === "available") && value.availability === "available" && value.collectionErrors === 0 && Date.parse(record.at) >= Date.parse(until)
      && observationCoverageValid(value, proofRecords, from, until) && value.recordCount === inDay.length && value.sourceDigest === canonicalSha256(inDay as unknown as import("../../protocol/src/index.js").JsonValue);
    return { id: record.id, coverageVersion: String(value.coverageVersion), valid };
  });
  const v1Sealed = v1.length > 0 && v1.every((entry) => entry.valid);
  const channels = OBSERVATION_CHANNELS.map((channel): ObservationDayVerdict => {
    const ownRecords = inDay.filter((record) => OBSERVATION_CHANNEL_BY_KIND[record.kind] === channel);
    const v2 = receipts.filter((record) => record.payload.coverageVersion === OBSERVATION_CHANNEL_COVERAGE_VERSION && record.payload.channel === channel)
      .map((record) => ({ record, valid: !unreadable && ownRecords.every((entry) => entry.payload.availability === "available") && observationChannelReceiptValid(record, entries) }));
    const sealed = v2.find((entry) => entry.valid);
    const verdict = sealed !== undefined ? (sealed.record.payload.outcome === "observed-zero" ? "observed-zero" : "sealed") : v1Sealed ? "sealed" : idle ? "idle" : "unproven";
    return { channel, verdict, receipts: [...v1, ...v2.map(({ record, valid }) => ({ id: record.id, coverageVersion: OBSERVATION_CHANNEL_COVERAGE_VERSION, valid }))] };
  });
  return { day, idle, channels };
}

/** Read-only: reads the day file, the one before and the three after, then observationDayVerdicts. */
export async function readObservationDayVerdicts(root: string, day: string): Promise<ObservationDayVerdicts & { readonly problems: TelemetryReadResult["problems"] }> {
  const target = await readTelemetryDay(root, day);
  const records = [...target.records];
  for (const offset of [-1, 1, 2, 3]) {
    records.push(...(await readTelemetryDay(root, new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10))).records);
  }
  return { ...observationDayVerdicts(records, day, { unreadable: target.problems.length > 0 }), problems: target.problems };
}

// TCRN-CROSS-STORY-454 R5: the per-day fitness summary the seal keeps outside the day files
// retention prunes (telemetry/summaries/<day>.json). It carries the day's channel verdicts at
// seal time and, per raw telemetry id, [retrieval, reference, trigger, verifyFailure, observed
// events, first instant, last instant] -- what the fitness counts are summed from. A summary
// past the canonical bounds (1 MiB, 10,000 ids) is not written, so that day cannot count
// once its raw file is gone: a missing summary is never read as zero.
const FITNESS_SUMMARY_VERSION = "tcrn.telemetry-fitness-summary.v1";
const OBSERVATION_VERDICTS = Object.freeze(["sealed", "observed-zero", "idle", "unproven"]);
export type FitnessSummaryRow = readonly [number, number, number, number, number, string | null, string | null];
export interface ObservationDaySummary {
  readonly schemaVersion: typeof FITNESS_SUMMARY_VERSION;
  readonly day: string;
  readonly channels: Readonly<Record<string, ObservationDayVerdict["verdict"]>>;
  readonly rows: Readonly<Record<string, FitnessSummaryRow>>;
}

function validObservationDaySummary(value: unknown, day: string): value is ObservationDaySummary {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const channels = entry.channels as Record<string, unknown> | null;
  const rows = entry.rows as Record<string, unknown> | null;
  const count = (item: unknown): boolean => Number.isSafeInteger(item) && Number(item) >= 0;
  const instant = (item: unknown): boolean => item === null || (typeof item === "string" && !Number.isNaN(Date.parse(item)));
  return JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(["channels", "day", "rows", "schemaVersion"]) && entry.schemaVersion === FITNESS_SUMMARY_VERSION && entry.day === day
    && channels !== null && typeof channels === "object" && JSON.stringify(Object.keys(channels).sort()) === JSON.stringify([...OBSERVATION_CHANNELS].sort()) && Object.values(channels).every((verdict) => OBSERVATION_VERDICTS.includes(verdict as string))
    && rows !== null && typeof rows === "object" && !Array.isArray(rows) && Object.values(rows).every((row) => Array.isArray(row) && row.length === 7 && row.slice(0, 5).every(count) && instant(row[5]) && instant(row[6]));
}

/** Written by the seal path only (never a backfill); replaced atomically when the same day is sealed again. */
export async function writeObservationDaySummary(root: string, summary: ObservationDaySummary): Promise<{ readonly reasonCode: string }> {
  if (!validObservationDaySummary(summary, summary.day)) return { reasonCode: "TELEMETRY_SUMMARY_INVALID" };
  let text: string;
  try { text = canonicalJson(summary as unknown as import("../../protocol/src/index.js").JsonValue); } catch { return { reasonCode: "TELEMETRY_SUMMARY_OVERSIZED" }; }
  const base = rootDirectory(root);
  const directory = join(base, "telemetry", "summaries");
  await regularDirectory(base, true);
  await regularDirectory(join(base, "telemetry"), true);
  await regularDirectory(directory, true);
  const path = join(directory, `${summary.day}.json`);
  await regularFileIfPresent(path);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  return { reasonCode: "TELEMETRY_SUMMARY_RECORDED" };
}

async function readObservationDaySummaries(root: string): Promise<Map<string, ObservationDaySummary>> {
  const directory = join(rootDirectory(root), "telemetry", "summaries");
  const summaries = new Map<string, ObservationDaySummary>();
  let names: string[] = [];
  try { names = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/u.test(entry.name)).map((entry) => entry.name); }
  catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  for (const name of names) {
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (validObservationDaySummary(value, name.slice(0, 10))) summaries.set(name.slice(0, 10), value);
    } catch { /* an unreadable summary is absent: its day cannot count */ }
  }
  return summaries;
}

export type ObservationWindowClass = "card" | "rule" | "verify";
// STORY-454 R3: the channels a record class is judged on. A small card needs retrieval and
// reference to be observation days on the same day; a rule needs trigger; a verify script,
// verify check or gate needs verify.
const OBSERVATION_WINDOW_CHANNELS: Readonly<Record<ObservationWindowClass, readonly string[]>> = Object.freeze({ card: ["retrieval", "reference"], rule: ["trigger"], verify: ["verify"] });

export interface ObservationClassWindow {
  readonly observationDays: readonly string[];
  readonly complete: boolean;
  readonly missingObservationDays: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly records: readonly TelemetryRecord[];
  // Observation days whose raw day file is gone are counted from their summaries.
  readonly summaries: readonly ObservationDaySummary[];
}

export interface ObservationWindows {
  readonly windowDays: number;
  readonly classes: Readonly<Record<ObservationWindowClass, ObservationClassWindow>>;
  readonly idleDays: readonly string[];
  readonly unprovenDays: readonly string[];
  readonly problems: TelemetryReadResult["problems"];
}

function shiftDay(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * TCRN-CROSS-STORY-454 R1-R4: the last `windowDays` observation days of each record class,
 * counted backwards from the day before `at`. An observation day is a channel day read as
 * sealed or observed-zero; idle and unproven days are neither counted nor a break in the
 * window, and are listed apart. The scan covers at least `windowDays` calendar days and goes
 * further back only while a class is short and older day files exist. Records after `at` are
 * not read. Read-only.
 */
export async function readObservationWindows(root: string, at: string, windowDays: number): Promise<ObservationWindows> {
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 3_650) fail("TELEMETRY_FILTER_INVALID", "windowDays must be a positive bounded integer");
  let atValue: bigint;
  try { atValue = parseStrictInstant(at); } catch { fail("TELEMETRY_FILTER_INVALID", "at is not a strict instant"); }
  const directory = join(rootDirectory(root), "telemetry");
  let names: string[] = [];
  try { names = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.ndjson$/u.test(entry.name)).map((entry) => entry.name).sort(); }
  catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  const files = new Map<string, { readonly records: readonly TelemetryRecord[]; readonly problems: TelemetryReadResult["problems"] }>();
  for (const name of names) {
    const read = await readTelemetryDay(root, name.slice(0, 10));
    files.set(name.slice(0, 10), { records: read.records.filter((record) => parseStrictInstant(record.at) <= atValue), problems: read.problems });
  }
  const summaries = await readObservationDaySummaries(root);
  const earliest = [names[0]?.slice(0, 10), ...summaries.keys()].filter((day): day is string => day !== undefined).sort()[0] ?? null;
  const days: Record<ObservationWindowClass, string[]> = { card: [], rule: [], verify: [] };
  const idleDays: string[] = [];
  const unprovenDays: string[] = [];
  const yesterday = shiftDay(new Date(at).toISOString().slice(0, 10), -1);
  for (let scanned = 0; scanned < 3_650; scanned += 1) {
    const day = shiftDay(yesterday, -scanned);
    const short = Object.values(days).some((list) => list.length < windowDays);
    if (scanned >= windowDays && (!short || earliest === null || day < earliest)) break;
    const summary = files.has(day) ? undefined : summaries.get(day);
    const around = [-1, 0, 1, 2, 3].flatMap((offset) => files.get(shiftDay(day, offset))?.records ?? []);
    const verdicts = summary === undefined
      ? observationDayVerdicts(around, day, { unreadable: (files.get(day)?.problems.length ?? 0) > 0 })
      : { day, idle: Object.values(summary.channels).every((verdict) => verdict === "idle"), channels: OBSERVATION_CHANNELS.map((channel) => ({ channel, verdict: summary.channels[channel]!, receipts: [] })) };
    const observed = (channel: string): boolean => ["sealed", "observed-zero"].includes(verdicts.channels.find((entry) => entry.channel === channel)?.verdict ?? "");
    for (const kind of Object.keys(days) as ObservationWindowClass[]) {
      if (days[kind].length < windowDays && OBSERVATION_WINDOW_CHANNELS[kind].every(observed)) days[kind].push(day);
    }
    if (verdicts.idle) idleDays.push(day);
    else if (verdicts.channels.some((entry) => entry.verdict === "unproven")) unprovenDays.push(day);
  }
  const scannedFrom = idleDays.concat(unprovenDays, ...Object.values(days)).sort()[0] ?? yesterday;
  const classes = Object.fromEntries((Object.keys(days) as ObservationWindowClass[]).map((kind) => {
    const observationDays = [...days[kind]].sort();
    return [kind, {
      observationDays,
      complete: observationDays.length >= windowDays,
      missingObservationDays: Math.max(0, windowDays - observationDays.length),
      windowStart: `${observationDays[0] ?? scannedFrom}T00:00:00.000Z`,
      windowEnd: `${observationDays.at(-1) ?? yesterday}T23:59:59.999Z`,
      records: observationDays.flatMap((day) => (files.get(day)?.records ?? []).filter((record) => record.kind !== "observation-coverage")),
      summaries: observationDays.filter((day) => !files.has(day)).flatMap((day) => summaries.get(day) ?? []),
    }];
  })) as unknown as Record<ObservationWindowClass, ObservationClassWindow>;
  return { windowDays, classes, idleDays: idleDays.sort(), unprovenDays: unprovenDays.sort(), problems: [...files.values()].flatMap((entry) => entry.problems) };
}

export async function readTelemetryObservationWindow(root: string, at: string, windowDays = TELEMETRY_RETENTION_DAYS): Promise<TelemetryObservationWindow> {
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 3_650) fail("TELEMETRY_FILTER_INVALID", "windowDays must be a positive bounded integer");
  try { parseStrictInstant(at); } catch { fail("TELEMETRY_FILTER_INVALID", "at is not a strict instant"); }
  const base = rootDirectory(root);
  const directory = join(base, "telemetry");
  const current = new Date(at);
  current.setUTCHours(0, 0, 0, 0);
  const names: string[] = [];
  for (let offset = windowDays; offset >= 1; offset -= 1) {
    const date = new Date(current);
    date.setUTCDate(date.getUTCDate() - offset);
    names.push(`${date.toISOString().slice(0, 10)}.ndjson`);
  }
  const missingDays: string[] = [];
  const invalidDays: string[] = [];
  const records: TelemetryRecord[] = [];
  const dayRecords = new Map<string, TelemetryRecord[]>();
  const proofRecords: TelemetryRecord[] = [];
  const coverage: TelemetryRecord[] = [];
  const problems: { path: string; line: number; reasonCode: string }[] = [];
  let directoryAvailable = true;
  try {
    const stats = await lstat(base);
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail("TELEMETRY_ROOT_INVALID", `${base} must be a real directory`);
    const telemetryStats = await lstat(directory);
    if (!telemetryStats.isDirectory() || telemetryStats.isSymbolicLink()) fail("TELEMETRY_ROOT_INVALID", `${directory} must be a real directory`);
  } catch (error) {
    if (errorCode(error) === "ENOENT") directoryAvailable = false;
    else throw error;
  }
  if (!directoryAvailable) missingDays.push(...names);
  const today = `${current.toISOString().slice(0, 10)}.ndjson`; const priorBoundary = `${new Date(current.getTime() - (windowDays + 1) * 86_400_000).toISOString().slice(0, 10)}.ndjson`;
  for (const name of directoryAvailable ? [priorBoundary, ...names, today] : []) {
    const path = join(directory, name);
    let source;
    try {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink()) fail("TELEMETRY_FILE_INVALID", `${path} must be a regular file`);
      source = await readFile(path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") { if (name !== today && name !== priorBoundary) missingDays.push(name); continue; }
      throw error;
    }
    let invalid = false;
    for (const [index, line] of source.split("\n").entries()) {
      if (line.length === 0) continue;
      const parsed = lineRecord(path, line, index + 1);
      if (parsed.problem) { problems.push(parsed.problem); invalid = true; }
      else if (parsed.record) {
        const record = parsed.record;
        if (`${new Date(record.at).toISOString().slice(0, 10)}.ndjson` !== name) { invalid = true; continue; }
          if (record.kind === "observation-coverage") coverage.push(record);
          else {
            const boundary = String(record.payload.source).startsWith(OBSERVATION_BOUNDARY_PREFIX);
            if (name !== today || boundary) proofRecords.push(record);
        if (name !== today) {
          const entries = dayRecords.get(name) ?? [];
          entries.push(record);
          dayRecords.set(name, entries);
          records.push(record);
          if (record.payload.availability !== "available") invalid = true;
        }
      } }
    }
    if (invalid) invalidDays.push(name);
  }
  for (const name of names) {
    if (missingDays.includes(name) || invalidDays.includes(name)) continue;
    const from = `${name.slice(0, 10)}T00:00:00.000Z`;
    const until = new Date(new Date(from).getTime() + 86_400_000).toISOString();
    const entries = [...(dayRecords.get(name) ?? [])].sort((left, right) => left.at < right.at ? -1 : left.at > right.at ? 1 : left.id.localeCompare(right.id));
    const sourceDigest = canonicalSha256(entries as unknown as import("../../protocol/src/index.js").JsonValue);
    // A per-channel (v2) receipt is judged by its own reader; the four-channel rules here are unchanged.
    const receipts = coverage.filter((record) => record.payload.coveredFrom === from && record.payload.coveredUntil === until && record.payload.coverageVersion !== OBSERVATION_CHANNEL_COVERAGE_VERSION);
    const proven = receipts.length > 0 && receipts.every((record) => {
      const value = record.payload;
      return value.availability === "available" && value.collectionErrors === 0 &&
        value.coveredFrom === from && value.coveredUntil === until &&
        parseStrictInstant(record.at) >= parseStrictInstant(until) && parseStrictInstant(record.at) <= parseStrictInstant(at) &&
        observationCoverageValid(value, proofRecords.filter((entry) => (entry.at >= from && entry.at < until) || String(entry.payload.source).startsWith(OBSERVATION_BOUNDARY_PREFIX)), from, until) &&
        value.recordCount === entries.length && value.sourceDigest === sourceDigest;
    });
    if (!proven) {
      invalidDays.push(name);
      problems.push({ path: join(directory, name), line: 0, reasonCode: "TELEMETRY_COVERAGE_UNPROVEN" });
    }
  }
  records.sort((left, right) => {
    const leftAt = parseStrictInstant(left.at);
    const rightAt = parseStrictInstant(right.at);
    return leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const first = names[0]!.slice(0, 10);
  const last = names.at(-1)!.slice(0, 10);
  return {
    windowDays,
    windowStart: `${first}T00:00:00.000Z`,
    windowEnd: `${last}T23:59:59.999Z`,
    complete: missingDays.length === 0 && invalidDays.length === 0,
    missingDays,
    invalidDays,
    records,
    problems,
  };
}

function telemetryManifest(value: unknown): readonly { readonly file: string; readonly closedAt: string }[] {
  const entry = object(value, "telemetry manifest");
  if (entry.schemaVersion !== "tcrn.telemetry-manifest.v1" || !Array.isArray(entry.days)) fail("TELEMETRY_MANIFEST_INVALID", "telemetry manifest");
  return entry.days.map((dayEntry, index) => {
    const day = object(dayEntry, `telemetry manifest day ${index}`);
    const file = requiredText(day.file, "telemetry manifest file", 64);
    const closedAt = requiredText(day.closedAt, "telemetry manifest closedAt", 64);
    if (!/^\d{4}-\d{2}-\d{2}\.ndjson$/u.test(file)) fail("TELEMETRY_MANIFEST_INVALID", "telemetry manifest file name");
    try { parseStrictInstant(closedAt); } catch { fail("TELEMETRY_MANIFEST_INVALID", "telemetry manifest closedAt"); }
    return { file, closedAt };
  });
}

/** Delete only old real day files explicitly registered as closed in a manifest. */
export async function pruneTelemetryRecords(root: string, options: {
  readonly now?: string;
  readonly retentionDays?: number;
} = {}): Promise<{ readonly deleted: readonly string[]; readonly skipped: readonly string[] }> {
  const now = options.now ?? new Date().toISOString();
  const retentionDays = options.retentionDays ?? TELEMETRY_RETENTION_DAYS;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0) fail("TELEMETRY_FILTER_INVALID", "retentionDays must be a non-negative integer");
  let cutoff;
  try { cutoff = parseStrictInstant(now) - BigInt(retentionDays) * 86_400_000_000_000n; }
  catch { fail("TELEMETRY_FILTER_INVALID", "now is not a strict instant"); }
  const base = rootDirectory(root);
  const directory = join(base, "telemetry");
  try { await regularDirectory(base, false); } catch (error) {
    if (errorCode(error) === "ENOENT") return { deleted: [], skipped: ["manifest.json"] };
    throw error;
  }
  try { await regularDirectory(directory, false); } catch (error) {
    if (errorCode(error) === "ENOENT") return { deleted: [], skipped: ["manifest.json"] };
    throw error;
  }
  const manifestPath = join(directory, "manifest.json");
  await regularFileIfPresent(manifestPath);
  let manifestSource;
  try { manifestSource = await readFile(manifestPath, "utf8"); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return { deleted: [], skipped: ["manifest.json"] };
    throw error;
  }
  const days = telemetryManifest(JSON.parse(manifestSource));
  const deleted: string[] = [];
  const skipped: string[] = [];
  for (const dayEntry of days) {
    if (parseStrictInstant(dayEntry.closedAt) > cutoff) { skipped.push(dayEntry.file); continue; }
    const path = join(directory, dayEntry.file);
    try {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink()) fail("TELEMETRY_FILE_INVALID", `${path} must be a regular file`);
      await rm(path);
      deleted.push(dayEntry.file);
    } catch (error) {
      if (errorCode(error) === "ENOENT") { skipped.push(dayEntry.file); continue; }
      throw error;
    }
  }
  return { deleted, skipped };
}

export async function readTelemetryRecordById(root: string, id: string): Promise<TelemetryRecord | null> {
  if (!/^telemetry:[a-f0-9]{24}$/u.test(id)) return null;
  const result = await readTelemetryRecords(root, { limit: Number.MAX_SAFE_INTEGER });
  return result.records.find((record) => record.id === id) ?? null;
}
