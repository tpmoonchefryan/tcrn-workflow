// SPDX-License-Identifier: Apache-2.0

import { canonicalSha256, assertProtocolId, compareCanonicalText, parseStrictInstant } from "../../protocol/src/index.js";

export const DEPENDENCY_VERSION = "tcrn.dependency.v1" as const;

export const DEPENDENCY_KINDS = Object.freeze(["blocks", "informs"] as const);
export const DEPENDENCY_STATUSES = Object.freeze(["active", "resolved", "waived"] as const);

export const DEPENDENCY_REASON_CODES = Object.freeze([
  "DEPENDENCY_BUDGET_EXCEEDED",
  "DEPENDENCY_CROSS_PROJECT",
  "DEPENDENCY_CYCLE",
  "DEPENDENCY_ENDPOINT_MISSING",
  "DEPENDENCY_ENDPOINT_TOMBSTONED",
  "DEPENDENCY_SCHEMA_INVALID",
  "DEPENDENCY_SELF_EDGE",
  "DEPENDENCY_UNICODE_INVALID",
  "DEPENDENCY_UNKNOWN_FIELD",
  "DEPENDENCY_VALIDATED",
  "DEPENDENCY_WAIVED_AUDIT_FORBIDDEN",
  "DEPENDENCY_WAIVED_AUDIT_REQUIRED",
] as const);

export type DependencyReasonCode = typeof DEPENDENCY_REASON_CODES[number];
export type DependencyKind = typeof DEPENDENCY_KINDS[number];
export type DependencyStatus = typeof DEPENDENCY_STATUSES[number];

export interface DependencyRecord {
  readonly schemaVersion: typeof DEPENDENCY_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly fromWorkId: string;
  readonly toWorkId: string;
  readonly kind: DependencyKind;
  readonly status: DependencyStatus;
  readonly waivedReason?: string;
  readonly waivedByActorId?: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface DependencyWorkReference {
  readonly id: string;
  readonly projectId: string;
  readonly tombstone: boolean;
}

const maximumWaivedReasonBytes = 512;
const maximumExtensionProperties = 64;

export class DependencyError extends Error {
  readonly reasonCode: DependencyReasonCode;
  constructor(reasonCode: DependencyReasonCode, message: string) {
    super(message);
    this.name = "DependencyError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: DependencyReasonCode, message: string): never {
  throw new DependencyError(reasonCode, message);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("DEPENDENCY_SCHEMA_INVALID", label);
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  const unknown = actual.filter((field) => !wanted.includes(field));
  if (unknown.length > 0) fail("DEPENDENCY_UNKNOWN_FIELD", `${label}:${unknown.join(",")}`);
  if (wanted.some((field) => !actual.includes(field))) fail("DEPENDENCY_SCHEMA_INVALID", label);
}

function id(value: unknown, label: string): string {
  try { assertProtocolId(value); } catch { fail("DEPENDENCY_SCHEMA_INVALID", label); }
  return value as string;
}

function text(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.length === 0) fail("DEPENDENCY_UNICODE_INVALID", label);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) fail("DEPENDENCY_BUDGET_EXCEEDED", label);
  return value;
}

function instant(value: unknown, label: string): string {
  try { parseStrictInstant(value); } catch { fail("DEPENDENCY_SCHEMA_INVALID", label); }
  return value as string;
}

function validateExtensions(value: unknown): Readonly<Record<string, unknown>> {
  const map = record(value, "extensions");
  const keys = Object.keys(map);
  if (keys.length > maximumExtensionProperties) fail("DEPENDENCY_BUDGET_EXCEEDED", "extensions");
  for (const key of keys) {
    id(key, `extensions key ${key}`);
    const entry = record(map[key], `extensions.${key}`);
    exact(entry, ["required", "value"], `extensions.${key}`);
    if (typeof entry.required !== "boolean") fail("DEPENDENCY_SCHEMA_INVALID", `extensions.${key}.required`);
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

export function validateDependencyRecord(value: unknown): DependencyRecord {
  const document = record(value, "dependency");
  if (document.schemaVersion !== DEPENDENCY_VERSION) fail("DEPENDENCY_SCHEMA_INVALID", "dependency schemaVersion");
  if (!DEPENDENCY_STATUSES.includes(document.status as DependencyStatus)) fail("DEPENDENCY_SCHEMA_INVALID", "dependency status");
  if (!DEPENDENCY_KINDS.includes(document.kind as DependencyKind)) fail("DEPENDENCY_SCHEMA_INVALID", "dependency kind");
  const waived = document.status === "waived";
  const hasWaivedFields = Object.hasOwn(document, "waivedReason") || Object.hasOwn(document, "waivedByActorId");
  if (waived && (!Object.hasOwn(document, "waivedReason") || !Object.hasOwn(document, "waivedByActorId"))) fail("DEPENDENCY_WAIVED_AUDIT_REQUIRED", "waived audit fields");
  if (!waived && hasWaivedFields) fail("DEPENDENCY_WAIVED_AUDIT_FORBIDDEN", "waived audit fields present without waived status");
  const base = ["schemaVersion", "id", "projectId", "fromWorkId", "toWorkId", "kind", "status", "revision", "updatedAt", "tombstone", "extensions"];
  exact(document, waived ? [...base, "waivedReason", "waivedByActorId"] : base, "dependency");
  if (!Number.isSafeInteger(document.revision) || (document.revision as number) < 1) fail("DEPENDENCY_SCHEMA_INVALID", "dependency revision");
  if (typeof document.tombstone !== "boolean") fail("DEPENDENCY_SCHEMA_INVALID", "dependency tombstone");
  const fromWorkId = id(document.fromWorkId, "fromWorkId");
  const toWorkId = id(document.toWorkId, "toWorkId");
  if (fromWorkId === toWorkId) fail("DEPENDENCY_SELF_EDGE", "fromWorkId equals toWorkId");
  const basis: DependencyRecord = {
    schemaVersion: DEPENDENCY_VERSION,
    id: id(document.id, "id"),
    projectId: id(document.projectId, "projectId"),
    fromWorkId,
    toWorkId,
    kind: document.kind as DependencyKind,
    status: document.status as DependencyStatus,
    ...(waived ? { waivedReason: text(document.waivedReason, "waivedReason", maximumWaivedReasonBytes), waivedByActorId: id(document.waivedByActorId, "waivedByActorId") } : {}),
    revision: document.revision as number,
    updatedAt: instant(document.updatedAt, "updatedAt"),
    tombstone: document.tombstone as boolean,
    extensions: validateExtensions(document.extensions),
  };
  return deepFreeze(basis);
}

// Canonical digest covers the complete validated record including unknown
// optional extension values, so a stored dependency round-trips deterministically.
export function canonicalDependencyDigest(value: unknown): string {
  return canonicalSha256(validateDependencyRecord(value));
}

function workIndex(works: readonly DependencyWorkReference[]): Map<string, DependencyWorkReference> {
  const index = new Map<string, DependencyWorkReference>();
  for (const work of works) index.set(id(work.id, "work id"), work);
  return index;
}

function assertLiveSameProjectEndpoint(record: DependencyRecord, workId: string, index: Map<string, DependencyWorkReference>): void {
  const work = index.get(workId);
  if (!work) fail("DEPENDENCY_ENDPOINT_MISSING", workId);
  if (work.projectId !== record.projectId) fail("DEPENDENCY_CROSS_PROJECT", `${workId} in ${work.projectId} not ${record.projectId}`);
  if (work.tombstone) fail("DEPENDENCY_ENDPOINT_TOMBSTONED", workId);
}

// Endpoints of a live (non-tombstoned) dependency must be live, same-project work
// records; cross-project edges fail closed. Tombstoned dependencies are historical
// and are not endpoint-checked.
export function assertDependencyEndpoints(value: unknown, works: readonly DependencyWorkReference[]): DependencyRecord {
  const dependency = validateDependencyRecord(value);
  if (!dependency.tombstone) {
    const index = workIndex(works);
    assertLiveSameProjectEndpoint(dependency, dependency.fromWorkId, index);
    assertLiveSameProjectEndpoint(dependency, dependency.toWorkId, index);
  }
  return dependency;
}

// Deterministic total order over (projectId, id) using utf8-byte-order-v1.
export function orderDependencies(values: readonly unknown[]): readonly DependencyRecord[] {
  return values
    .map((value) => validateDependencyRecord(value))
    .sort((left, right) => compareCanonicalText(left.projectId, right.projectId) || compareCanonicalText(left.id, right.id));
}

// Cycle detection over active `blocks` edges (from depends on to). A cycle among
// active blocking dependencies fails closed with a stable reason code.
export function assertNoDependencyCycle(values: readonly unknown[]): readonly DependencyRecord[] {
  const dependencies = orderDependencies(values);
  const adjacency = new Map<string, string[]>();
  for (const dependency of dependencies) {
    if (dependency.tombstone || dependency.status !== "active" || dependency.kind !== "blocks") continue;
    const edges = adjacency.get(dependency.fromWorkId) ?? [];
    edges.push(dependency.toWorkId);
    adjacency.set(dependency.fromWorkId, edges);
  }
  const state = new Map<string, number>(); // 0 = visiting, 1 = done
  const stack: Array<{ node: string; index: number }> = [];
  for (const start of [...adjacency.keys()].sort(compareCanonicalText)) {
    if (state.get(start) === 1) continue;
    stack.push({ node: start, index: 0 });
    state.set(start, 0);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { node: string; index: number };
      const edges = adjacency.get(frame.node) ?? [];
      if (frame.index >= edges.length) {
        state.set(frame.node, 1);
        stack.pop();
        continue;
      }
      const next = edges[frame.index] as string;
      frame.index += 1;
      if (state.get(next) === 0) fail("DEPENDENCY_CYCLE", `${frame.node}->${next}`);
      if (state.get(next) === 1) continue;
      state.set(next, 0);
      stack.push({ node: next, index: 0 });
    }
  }
  return dependencies;
}

// Hub read path: the active `blocks` edges whose target is workId — "what blocks X".
export function listDependencyBlockers(workId: unknown, values: readonly unknown[]): readonly DependencyRecord[] {
  const target = id(workId, "workId");
  return orderDependencies(values)
    .filter((dependency) => !dependency.tombstone && dependency.status === "active" && dependency.kind === "blocks" && dependency.toWorkId === target);
}

export function listDependenciesByWorkItem(workId: unknown, values: readonly unknown[]): readonly DependencyRecord[] {
  const target = id(workId, "workId");
  return orderDependencies(values)
    .filter((dependency) => dependency.fromWorkId === target || dependency.toWorkId === target);
}
