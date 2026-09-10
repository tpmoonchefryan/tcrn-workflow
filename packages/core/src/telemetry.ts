// SPDX-License-Identifier: Apache-2.0
// STORY-372: local dispatch telemetry. This is a disposable observation surface,
// separate from the governed workspace event chain and its snapshots.

import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson, canonicalSha256, parseStrictInstant } from "../../protocol/src/index.js";

export const TELEMETRY_SCHEMA_VERSION = "tcrn.telemetry.v1" as const;
export const TELEMETRY_KINDS = Object.freeze(["subagent-start", "subagent-stop"] as const);
export const TELEMETRY_AVAILABILITY = Object.freeze(["available", "unavailable", "unknown"] as const);
export type TelemetryKind = typeof TELEMETRY_KINDS[number];
export type TelemetryAvailability = typeof TELEMETRY_AVAILABILITY[number];

export interface TelemetryUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface DispatchTelemetryPayload {
  readonly dispatchId: string | null;
  readonly parentSession: string | null;
  readonly workId: string | null;
  readonly taskClass: string | null;
  readonly mode: string | null;
  readonly requestedTier: string | null;
  readonly resolvedTier: string | null;
  readonly requestedModel: string | null;
  readonly observedModel: string | null;
  readonly usage: TelemetryUsage | null;
  readonly source: string;
  readonly availability: TelemetryAvailability;
}

export interface TelemetryRecord {
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  readonly id: string;
  readonly at: string;
  readonly kind: TelemetryKind;
  readonly session: string;
  readonly payload: DispatchTelemetryPayload;
}

export interface TelemetryReadResult {
  readonly records: readonly TelemetryRecord[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly problems: readonly { readonly path: string; readonly line: number; readonly reasonCode: string }[];
}

export interface TelemetryEvidenceSnapshot {
  readonly schemaVersion: "tcrn.telemetry-evidence.v1";
  readonly id: string;
  readonly digest: string;
  readonly fields: {
    readonly at: string;
    readonly kind: TelemetryKind;
    readonly session: string;
    readonly payload: DispatchTelemetryPayload;
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

function payload(value: unknown): DispatchTelemetryPayload {
  const entry = object(value, "payload");
  const expected = ["availability", "dispatchId", "mode", "observedModel", "parentSession", "requestedModel", "requestedTier", "resolvedTier", "source", "taskClass", "usage", "workId"];
  if (canonicalJson(Object.keys(entry).sort()) !== canonicalJson(expected)) fail("TELEMETRY_RECORD_INVALID", "payload fields are not exact");
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

export function validateTelemetryRecord(value: unknown): TelemetryRecord {
  const entry = object(value, "telemetry record");
  const expected = ["at", "id", "kind", "payload", "schemaVersion", "session"];
  if (canonicalJson(Object.keys(entry).sort()) !== canonicalJson(expected)) fail("TELEMETRY_RECORD_INVALID", "record fields are not exact");
  if (entry.schemaVersion !== TELEMETRY_SCHEMA_VERSION) fail("TELEMETRY_RECORD_INVALID", "schemaVersion");
  const at = requiredText(entry.at, "at", 64);
  try { parseStrictInstant(at); } catch { fail("TELEMETRY_RECORD_INVALID", "at is not a strict instant"); }
  const kind = entry.kind;
  if (!(TELEMETRY_KINDS as readonly string[]).includes(kind as string)) fail("TELEMETRY_RECORD_INVALID", "kind");
  const session = requiredText(entry.session, "session");
  const body = payload(entry.payload);
  const id = requiredText(entry.id, "id", 128);
  if (!/^telemetry:[a-f0-9]{24}$/u.test(id)) fail("TELEMETRY_RECORD_INVALID", "id");
  return Object.freeze({ schemaVersion: TELEMETRY_SCHEMA_VERSION, id, at, kind: kind as TelemetryKind, session, payload: body });
}

function telemetryId(kind: TelemetryKind, at: string, session: string, body: DispatchTelemetryPayload): string {
  return `telemetry:${canonicalSha256({ schemaVersion: TELEMETRY_SCHEMA_VERSION, kind, at, session, payload: body }).slice(0, 24)}`;
}

export function createTelemetryRecord(input: {
  readonly at: string;
  readonly kind: TelemetryKind;
  readonly session: string;
  readonly payload: DispatchTelemetryPayload;
  readonly id?: string;
}): TelemetryRecord {
  const body = payload(input.payload);
  const at = requiredText(input.at, "at", 64);
  const session = requiredText(input.session, "session");
  const kind = input.kind;
  if (!(TELEMETRY_KINDS as readonly string[]).includes(kind)) fail("TELEMETRY_RECORD_INVALID", "kind");
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

function day(at: string): string {
  return new Date(at).toISOString().slice(0, 10);
}

function fileFor(root: string, at: string): string {
  return join(rootDirectory(root), "telemetry", `${day(at)}.ndjson`);
}

function lineRecord(path: string, line: string, lineNumber: number): { record?: TelemetryRecord; problem?: { path: string; line: number; reasonCode: string } } {
  try { return { record: validateTelemetryRecord(JSON.parse(line)) }; }
  catch (error) { return { problem: { path, line: lineNumber, reasonCode: errorReasonCode(error) ?? "TELEMETRY_RECORD_INVALID" } }; }
}

export async function appendTelemetryRecord(root: string, record: TelemetryRecord): Promise<{ readonly record: TelemetryRecord; readonly path: string; readonly duplicate: boolean }> {
  const validated = validateTelemetryRecord(record);
  const path = fileFor(root, validated.at);
  let existing = "";
  try { existing = await readFile(path, "utf8"); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  for (const [index, line] of existing.split("\n").entries()) {
    if (line.length === 0) continue;
    const parsed = lineRecord(path, line, index + 1).record;
    if (parsed?.id === validated.id) return { record: parsed, path, duplicate: true };
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(path, `${prefix}${canonicalJson(validated)}`, { mode: 0o600 });
  return { record: validated, path, duplicate: false };
}

export async function readTelemetryRecords(root: string, options: {
  readonly kind?: string;
  readonly taskClass?: string;
  readonly since?: string;
  readonly limit?: number;
  readonly offset?: number;
} = {}): Promise<TelemetryReadResult> {
  const since = options.since === undefined ? undefined : (() => {
    try { return parseStrictInstant(options.since); } catch { fail("TELEMETRY_FILTER_INVALID", "since is not a strict instant"); }
  })();
  const offset = options.offset === undefined ? 0 : options.offset;
  const limit = options.limit === undefined ? 100 : options.limit;
  if (!Number.isSafeInteger(offset) || offset < 0) fail("TELEMETRY_FILTER_INVALID", "offset must be a non-negative integer");
  if (!Number.isSafeInteger(limit) || limit < 1) fail("TELEMETRY_FILTER_INVALID", "limit must be a positive integer");
  const base = rootDirectory(root);
  const directory = join(base, "telemetry");
  let names: string[];
  try { names = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.ndjson$/u.test(entry.name)).map((entry) => entry.name).sort(); }
  catch (error) { if (errorCode(error) === "ENOENT") return { records: [], total: 0, offset, limit, problems: [] }; throw error; }
  const records: TelemetryRecord[] = [];
  const problems: { path: string; line: number; reasonCode: string }[] = [];
  for (const name of names) {
    const path = join(directory, basename(name));
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

export async function readTelemetryRecordById(root: string, id: string): Promise<TelemetryRecord | null> {
  if (!/^telemetry:[a-f0-9]{24}$/u.test(id)) return null;
  const result = await readTelemetryRecords(root, { limit: Number.MAX_SAFE_INTEGER });
  return result.records.find((record) => record.id === id) ?? null;
}
