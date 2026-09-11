// SPDX-License-Identifier: Apache-2.0
import { appendFile, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson, canonicalSha256, parseStrictInstant } from "../../protocol/src/index.js";

export const TELEMETRY_SCHEMA_VERSION = "tcrn.telemetry.v1" as const;
export const TELEMETRY_AVAILABILITY = Object.freeze(["available", "unavailable", "unknown"] as const);
const OBSERVATION_CHANNELS = Object.freeze(["retrieval", "reference", "trigger", "verify"]);
const OBSERVATION_CHANNEL_BY_KIND: Record<string, string> = Object.freeze({ retrieval: "retrieval", "retrieval-hit": "retrieval", reference: "reference", pull: "reference", trigger: "trigger", "rule-trigger": "trigger", verify: "verify" });
const OBSERVATION_COVERAGE_VERSION = "tcrn.telemetry-observation-coverage.v1";
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

function errorReasonCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && typeof (error as { readonly reasonCode?: unknown }).reasonCode === "string"
    ? (error as { readonly reasonCode: string }).reasonCode
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
  catch (error) { return { problem: { path, line: lineNumber, reasonCode: errorReasonCode(error) ?? "TELEMETRY_RECORD_INVALID" } }; }
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
    && (since === undefined || parseStrictInstant(record.at) >= since))
    .sort((left, right) => {
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

function observationCoverageValid(value: TelemetryPayload, entries: readonly TelemetryRecord[], from: string, until: string): boolean {
  const channels = value.channels;
  if (value.source !== "telemetry:observation-collector" || value.coverageVersion !== OBSERVATION_COVERAGE_VERSION || !Array.isArray(channels) ||
      channels.length !== OBSERVATION_CHANNELS.length || new Set(channels).size !== channels.length ||
      !OBSERVATION_CHANNELS.every((channel) => channels.includes(channel)) ||
      value.channelCheckpoints === null || typeof value.channelCheckpoints !== "object" || Array.isArray(value.channelCheckpoints)) return false;
  const proofs = value.channelCheckpoints as Record<string, unknown>;
  if (canonicalJson(Object.keys(proofs).sort()) !== canonicalJson([...OBSERVATION_CHANNELS].sort())) return false;
  const fromValue = parseStrictInstant(from);
  const untilValue = parseStrictInstant(until);
  return OBSERVATION_CHANNELS.every((channel) => {
    const proof = proofs[channel];
    if (proof === null || typeof proof !== "object" || Array.isArray(proof)) return false;
    const fields = proof as Record<string, unknown>;
    if (canonicalJson(Object.keys(fields).sort()) !== canonicalJson(["availability", "recordCount", "source", "sourceDigest", "startSequence", "stopSequence"])) return false;
    const rows = entries.filter((record) => OBSERVATION_CHANNEL_BY_KIND[record.kind] === channel && record.payload.source === fields.source)
      .sort((left, right) => left.at < right.at ? -1 : left.at > right.at ? 1 : left.id.localeCompare(right.id));
    const phases = rows.map((record) => record.payload.phase);
    const firstStop = phases.indexOf("stop");
    const sequences = rows.map((record) => record.payload.sequence);
    const validSequence = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1;
    return fields.availability === "available" && typeof fields.source === "string" &&
      typeof fields.sourceDigest === "string" && /^[a-f0-9]{64}$/u.test(fields.sourceDigest) &&
      Number.isSafeInteger(fields.recordCount) && Number(fields.recordCount) >= 2 && rows.length === fields.recordCount &&
      Number.isSafeInteger(fields.startSequence) && Number.isSafeInteger(fields.stopSequence) && Number(fields.startSequence) >= 1 && Number(fields.stopSequence) >= Number(fields.startSequence) &&
      rows.every((record) => record.payload.availability === "available") && firstStop > 0 && phases.every((phase, index) => index < firstStop ? phase === "start" : phase === "stop") &&
      sequences.every((sequence, index) => validSequence(sequence) && (index === 0 || Number(sequence) === Number(sequences[index - 1]) + 1)) &&
      sequences[0] === fields.startSequence && sequences.at(-1) === fields.stopSequence &&
      parseStrictInstant(rows[0]!.at) <= fromValue && parseStrictInstant(rows[rows.length - 1]!.at) >= untilValue - 1_000_000n &&
      canonicalSha256(rows as unknown as import("../../protocol/src/index.js").JsonValue) === fields.sourceDigest;
  });
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
  const today = `${current.toISOString().slice(0, 10)}.ndjson`;
  for (const name of directoryAvailable ? [...names, today] : []) {
    const path = join(directory, name);
    let source;
    try {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink()) fail("TELEMETRY_FILE_INVALID", `${path} must be a regular file`);
      source = await readFile(path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") { if (name !== today) missingDays.push(name); continue; }
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
        else if (name !== today) {
          const entries = dayRecords.get(name) ?? [];
          entries.push(record);
          dayRecords.set(name, entries);
          records.push(record);
          if (record.payload.availability !== "available") invalid = true;
        }
      }
    }
    if (invalid) invalidDays.push(name);
  }
  for (const name of names) {
    if (missingDays.includes(name) || invalidDays.includes(name)) continue;
    const from = `${name.slice(0, 10)}T00:00:00.000Z`;
    const until = new Date(new Date(from).getTime() + 86_400_000).toISOString();
    const entries = [...(dayRecords.get(name) ?? [])].sort((left, right) => left.at < right.at ? -1 : left.at > right.at ? 1 : left.id.localeCompare(right.id));
    const sourceDigest = canonicalSha256(entries as unknown as import("../../protocol/src/index.js").JsonValue);
    const receipts = coverage.filter((record) => record.payload.coveredFrom === from && record.payload.coveredUntil === until);
    const proven = receipts.length > 0 && receipts.every((record) => {
      const value = record.payload;
      return value.availability === "available" && value.collectionErrors === 0 &&
        value.coveredFrom === from && value.coveredUntil === until &&
        parseStrictInstant(record.at) >= parseStrictInstant(until) && parseStrictInstant(record.at) <= parseStrictInstant(at) &&
        observationCoverageValid(value, entries, from, until) &&
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
