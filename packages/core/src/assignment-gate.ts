// SPDX-License-Identifier: Apache-2.0

import { assertProtocolId, compareCanonicalText, parseStrictInstant } from "../../protocol/src/index.js";

export const ASSIGNMENT_VERSION = "tcrn.assignment.v1" as const;
export const GATE_VERSION = "tcrn.gate.v1" as const;

export const ASSIGNMENT_STATUSES = Object.freeze(["proposed", "active", "released"] as const);
export const GATE_STATUSES = Object.freeze(["pending", "satisfied", "blocked"] as const);
// Reused from conference vocabulary so gate outcomes and conference minutes align.
export const GATE_OUTCOME_CLASSES = Object.freeze(["discussion_only", "recommendation", "role_decision", "blocked", "owner_intent_required"] as const);

export const ASSIGNMENT_GATE_REASON_CODES = Object.freeze([
  "ASSIGNMENT_SCHEMA_INVALID",
  "ASSIGNMENT_UNICODE_INVALID",
  "ASSIGNMENT_UNKNOWN_FIELD",
  "GATE_SCHEMA_INVALID",
  "GATE_UNICODE_INVALID",
  "GATE_UNKNOWN_FIELD",
] as const);

export type AssignmentGateReasonCode = typeof ASSIGNMENT_GATE_REASON_CODES[number];

interface ReasonCodes {
  readonly schema: AssignmentGateReasonCode;
  readonly unicode: AssignmentGateReasonCode;
  readonly unknown: AssignmentGateReasonCode;
}

const ASSIGNMENT_CODES: ReasonCodes = { schema: "ASSIGNMENT_SCHEMA_INVALID", unicode: "ASSIGNMENT_UNICODE_INVALID", unknown: "ASSIGNMENT_UNKNOWN_FIELD" };
const GATE_CODES: ReasonCodes = { schema: "GATE_SCHEMA_INVALID", unicode: "GATE_UNICODE_INVALID", unknown: "GATE_UNKNOWN_FIELD" };

const maximumTextBytes = 2_048;
const maximumExtensionProperties = 64;

export class AssignmentGateError extends Error {
  readonly reasonCode: AssignmentGateReasonCode;
  constructor(reasonCode: AssignmentGateReasonCode, message: string) {
    super(message);
    this.name = "AssignmentGateError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: AssignmentGateReasonCode, message: string): never {
  throw new AssignmentGateError(reasonCode, message);
}

function record(value: unknown, label: string, codes: ReasonCodes): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(codes.schema, label);
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string, codes: ReasonCodes): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  const unknown = actual.filter((field) => !wanted.includes(field));
  if (unknown.length > 0) fail(codes.unknown, `${label}:${unknown.join(",")}`);
  if (wanted.some((field) => !actual.includes(field))) fail(codes.schema, label);
}

function id(value: unknown, label: string, codes: ReasonCodes): string {
  try { assertProtocolId(value); } catch { fail(codes.schema, label); }
  return value as string;
}

function nullableId(value: unknown, label: string, codes: ReasonCodes): string | null {
  return value === null ? null : id(value, label, codes);
}

function text(value: unknown, label: string, codes: ReasonCodes): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.length === 0) fail(codes.unicode, label);
  if (Buffer.byteLength(value, "utf8") > maximumTextBytes) fail(codes.unicode, label);
  return value;
}

function instant(value: unknown, label: string, codes: ReasonCodes): string {
  try { parseStrictInstant(value); } catch { fail(codes.schema, label); }
  return value as string;
}

function extensions(value: unknown, codes: ReasonCodes): Readonly<Record<string, unknown>> {
  const map = record(value, "extensions", codes);
  const keys = Object.keys(map);
  if (keys.length > maximumExtensionProperties) fail(codes.schema, "extensions");
  for (const key of keys) {
    id(key, `extensions key ${key}`, codes);
    const entry = record(map[key], `extensions.${key}`, codes);
    exact(entry, ["required", "value"], `extensions.${key}`, codes);
    if (typeof entry.required !== "boolean") fail(codes.schema, `extensions.${key}.required`);
  }
  return map;
}

interface RecordBase {
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
}

function base(document: Readonly<Record<string, unknown>>, codes: ReasonCodes): RecordBase {
  if (!Number.isSafeInteger(document.revision) || (document.revision as number) < 1) fail(codes.schema, "revision");
  if (typeof document.tombstone !== "boolean") fail(codes.schema, "tombstone");
  return { revision: document.revision as number, updatedAt: instant(document.updatedAt, "updatedAt", codes), tombstone: document.tombstone as boolean, extensions: extensions(document.extensions, codes) };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface AssignmentRecord {
  readonly schemaVersion: typeof ASSIGNMENT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly workId: string;
  readonly accountableActorId: string;
  readonly status: typeof ASSIGNMENT_STATUSES[number];
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
}

// accountableActorId (not the knowledge-core accountableOwnerId precedent):
// an assignment binds an arbitrary actor, so the owner: prefix rule does not apply.
export function validateAssignmentRecord(value: unknown): AssignmentRecord {
  const codes = ASSIGNMENT_CODES;
  const document = record(value, "assignment", codes);
  if (document.schemaVersion !== ASSIGNMENT_VERSION) fail(codes.schema, "assignment schemaVersion");
  exact(document, ["schemaVersion", "id", "projectId", "workId", "accountableActorId", "status", "revision", "updatedAt", "tombstone", "extensions"], "assignment", codes);
  if (!ASSIGNMENT_STATUSES.includes(document.status as AssignmentRecord["status"])) fail(codes.schema, "assignment status");
  return deepFreeze({
    schemaVersion: ASSIGNMENT_VERSION,
    id: id(document.id, "id", codes),
    projectId: id(document.projectId, "projectId", codes),
    workId: id(document.workId, "workId", codes),
    accountableActorId: id(document.accountableActorId, "accountableActorId", codes),
    status: document.status as AssignmentRecord["status"],
    ...base(document, codes),
  });
}

export interface GateRecord {
  readonly schemaVersion: typeof GATE_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly workId: string | null;
  readonly title: string;
  readonly outcomeClass: typeof GATE_OUTCOME_CLASSES[number];
  readonly status: typeof GATE_STATUSES[number];
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export function validateGateRecord(value: unknown): GateRecord {
  const codes = GATE_CODES;
  const document = record(value, "gate", codes);
  if (document.schemaVersion !== GATE_VERSION) fail(codes.schema, "gate schemaVersion");
  exact(document, ["schemaVersion", "id", "projectId", "workId", "title", "outcomeClass", "status", "revision", "updatedAt", "tombstone", "extensions"], "gate", codes);
  if (!GATE_OUTCOME_CLASSES.includes(document.outcomeClass as GateRecord["outcomeClass"])) fail(codes.schema, "gate outcomeClass");
  if (!GATE_STATUSES.includes(document.status as GateRecord["status"])) fail(codes.schema, "gate status");
  return deepFreeze({
    schemaVersion: GATE_VERSION,
    id: id(document.id, "id", codes),
    projectId: id(document.projectId, "projectId", codes),
    workId: nullableId(document.workId, "workId", codes),
    title: text(document.title, "title", codes),
    outcomeClass: document.outcomeClass as GateRecord["outcomeClass"],
    status: document.status as GateRecord["status"],
    ...base(document, codes),
  });
}

export function listAssignmentsByWorkItem(workId: unknown, values: readonly unknown[]): readonly AssignmentRecord[] {
  const target = id(workId, "workId", ASSIGNMENT_CODES);
  return values.map((value) => validateAssignmentRecord(value)).filter((entry) => !entry.tombstone && entry.workId === target)
    .sort((left, right) => compareCanonicalText(left.projectId, right.projectId) || compareCanonicalText(left.id, right.id));
}

export function listGatesByWorkItem(workId: unknown, values: readonly unknown[]): readonly GateRecord[] {
  const target = id(workId, "workId", GATE_CODES);
  return values.map((value) => validateGateRecord(value)).filter((entry) => !entry.tombstone && entry.workId === target)
    .sort((left, right) => compareCanonicalText(left.projectId, right.projectId) || compareCanonicalText(left.id, right.id));
}
