// SPDX-License-Identifier: Apache-2.0

import { assertStrictInstant, canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";
import { AGENT_EFFORT_ROSTER } from "./effort.js";
import type { AgentEffortName } from "./effort.js";

/** The closed host roster is the adapter roster, not a user-editable enum. */
export const MODEL_PLAN_HOSTS = Object.freeze(["claude-code", "codex"] as const);
export type ModelPlanHost = typeof MODEL_PLAN_HOSTS[number];
export const MODEL_PLAN_VERSION = "tcrn.model-plan.v1" as const;

export const MODEL_PLAN_REASON_CODES = Object.freeze([
  "MODEL_PLAN_ASSIGNMENT_INVALID",
  "MODEL_PLAN_DEFAULT_MODEL_INVALID",
  "MODEL_PLAN_EFFORT_HOST_UNSUPPORTED",
  "MODEL_PLAN_EFFORT_NOT_ASSIGNABLE",
  "MODEL_PLAN_HOST_UNKNOWN",
  "MODEL_PLAN_IN_USE",
  "MODEL_PLAN_NAME_INVALID",
  "MODEL_PLAN_NOT_FOUND",
  "MODEL_PLAN_PERSONA_UNKNOWN",
  "MODEL_PLAN_RECORD_INVALID",
] as const);
export type ModelPlanReasonCode = typeof MODEL_PLAN_REASON_CODES[number];

export class ModelPlanError extends Error {
  readonly reasonCode: ModelPlanReasonCode;
  constructor(reasonCode: ModelPlanReasonCode, message: string) {
    super(message);
    this.name = "ModelPlanError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: ModelPlanReasonCode, message: string): never {
  throw new ModelPlanError(reasonCode, message);
}

function bounded(value: unknown, label: string, maximum: number, reasonCode: ModelPlanReasonCode): string {
  if (typeof value !== "string" || value.length === 0 || [...value].length > maximum || value.includes("\u0000")) {
    fail(reasonCode, `${label} must be a non-empty string of at most ${maximum} characters`);
  }
  try { canonicalJson(value); } catch { fail(reasonCode, `${label} is not canonical text`); }
  return value;
}

export function assertModelPlanHost(value: unknown): asserts value is ModelPlanHost {
  if (!(MODEL_PLAN_HOSTS as readonly string[]).includes(value as string)) {
    fail("MODEL_PLAN_HOST_UNKNOWN", `${String(value)} is not a legal model-plan host; choose one of ${MODEL_PLAN_HOSTS.join(", ")}`);
  }
}

export function validateModelPlanName(value: unknown): string {
  return bounded(value, "model plan name", 64, "MODEL_PLAN_NAME_INVALID");
}

export function validateModelPlanModel(value: unknown): string {
  return bounded(value, "model plan model", 128, "MODEL_PLAN_DEFAULT_MODEL_INVALID");
}

/**
 * A plan's effort is per-persona dispatch configuration, so two separate things
 * disqualify a value here and they fail with different reason codes: the level may
 * not exist on this host at all, or it may exist as a session level the host cannot
 * carry per dispatch.  Both messages list the values that would have been accepted,
 * which for the second case is the assignable subset rather than the whole roster.
 */
export function validateModelPlanEffort(value: unknown, host: ModelPlanHost): AgentEffortName {
  const assignable = AGENT_EFFORT_ROSTER.filter((candidate) => candidate.applicableHosts.includes(host) && candidate.assignableToSubagent).map((candidate) => candidate.name).join(", ");
  const record = AGENT_EFFORT_ROSTER.find((candidate) => candidate.name === value);
  if (record === undefined || !record.applicableHosts.includes(host)) {
    const legal = AGENT_EFFORT_ROSTER.filter((candidate) => candidate.applicableHosts.includes(host)).map((candidate) => candidate.name).join(", ");
    fail("MODEL_PLAN_EFFORT_HOST_UNSUPPORTED", `effort ${String(value)} is not valid for ${host}; legal values: ${legal}`);
  }
  if (!record.assignableToSubagent) {
    fail("MODEL_PLAN_EFFORT_NOT_ASSIGNABLE", `effort ${record.name} is a ${host} session level and cannot be assigned to one persona; assignable values: ${assignable}`);
  }
  return record.name;
}

export interface ModelPlanRecord {
  readonly schemaVersion: typeof MODEL_PLAN_VERSION;
  readonly host: ModelPlanHost;
  readonly name: string;
  readonly defaultModel: string;
  readonly assignments: Readonly<Record<string, string>>;
  /** Optional so events and state written before S279 replay byte-for-byte. */
  readonly efforts?: Readonly<Record<string, AgentEffortName>>;
  /**
   * The effort a persona gets when it has no entry in `efforts`. Optional for the same
   * replay reason, and validated by the same function as a per-persona effort — a
   * second predicate here would let the "session levels are not dispatchable" boundary
   * hold in one place and not the other, and the loose side becomes the way around it.
   */
  readonly defaultEffort?: AgentEffortName;
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: false;
}

function planSort(records: readonly ModelPlanRecord[]): readonly ModelPlanRecord[] {
  return Object.freeze(records.slice().sort((left, right) => compareCanonicalText(left.host, right.host) || compareCanonicalText(left.name, right.name)));
}

function planFor(records: readonly ModelPlanRecord[], host: ModelPlanHost, name: string): ModelPlanRecord | undefined {
  return records.find((entry) => entry.host === host && entry.name === name);
}

function assertAt(updatedAt: string): void {
  try { assertStrictInstant(updatedAt); } catch { fail("MODEL_PLAN_RECORD_INVALID", "model plan updatedAt is invalid"); }
}

function normalizeAssignments(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCanonicalText(left, right))));
}

function normalizeEfforts(value: Readonly<Record<string, AgentEffortName>>): Readonly<Record<string, AgentEffortName>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCanonicalText(left, right))));
}

export function applyModelPlanSet(records: readonly ModelPlanRecord[], input: {
  readonly host: unknown;
  readonly name: unknown;
  readonly defaultModel: unknown;
  readonly defaultEffort?: unknown;
  readonly updatedAt: string;
}): { readonly records: readonly ModelPlanRecord[]; readonly record: ModelPlanRecord } {
  assertModelPlanHost(input.host);
  const name = validateModelPlanName(input.name);
  const defaultModel = validateModelPlanModel(input.defaultModel);
  // Absent means "no plan default"; an explicitly given value is held to the same rule
  // a per-persona effort is. Rewriting a plan without naming one clears it, which is
  // how every other field on this verb behaves.
  const defaultEffort = input.defaultEffort === undefined ? undefined : validateModelPlanEffort(input.defaultEffort, input.host);
  assertAt(input.updatedAt);
  const existing = planFor(records, input.host, name);
  const record = Object.freeze({
    schemaVersion: MODEL_PLAN_VERSION,
    host: input.host,
    name,
    defaultModel,
    assignments: existing?.assignments ?? Object.freeze({}),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(existing?.efforts === undefined ? {} : { efforts: existing.efforts }),
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: input.updatedAt,
    tombstone: false as const,
  });
  return { records: planSort(existing === undefined ? [...records, record] : records.map((entry) => entry === existing ? record : entry)), record };
}

export function applyModelPlanAssign(records: readonly ModelPlanRecord[], input: {
  readonly host: unknown;
  readonly name: unknown;
  readonly persona: unknown;
  readonly model: unknown;
  readonly effort?: unknown;
  readonly updatedAt: string;
}, personaExists: (name: string) => boolean): { readonly records: readonly ModelPlanRecord[]; readonly record: ModelPlanRecord } {
  assertModelPlanHost(input.host);
  const name = validateModelPlanName(input.name);
  const persona = bounded(input.persona, "persona name", 64, "MODEL_PLAN_PERSONA_UNKNOWN");
  const model = validateModelPlanModel(input.model);
  const effort = input.effort === undefined ? undefined : validateModelPlanEffort(input.effort, input.host);
  assertAt(input.updatedAt);
  const existing = planFor(records, input.host, name);
  if (existing === undefined) fail("MODEL_PLAN_NOT_FOUND", `no model plan named ${name} exists for ${input.host}`);
  if (!personaExists(persona)) fail("MODEL_PLAN_PERSONA_UNKNOWN", `no active persona named ${persona} exists`);
  const efforts = effort === undefined
    ? existing.efforts
    : normalizeEfforts({ ...(existing.efforts ?? {}), [persona]: effort });
  const record = Object.freeze({
    ...existing,
    assignments: normalizeAssignments({ ...existing.assignments, [persona]: model }),
    ...(efforts === undefined ? {} : { efforts }),
    revision: existing.revision + 1,
    updatedAt: input.updatedAt,
  });
  return { records: planSort(records.map((entry) => entry === existing ? record : entry)), record };
}

export function applyModelPlanUnassign(records: readonly ModelPlanRecord[], input: {
  readonly host: unknown;
  readonly name: unknown;
  readonly persona: unknown;
  readonly updatedAt: string;
}): { readonly records: readonly ModelPlanRecord[]; readonly record: ModelPlanRecord } {
  assertModelPlanHost(input.host);
  const name = validateModelPlanName(input.name);
  const persona = bounded(input.persona, "persona name", 64, "MODEL_PLAN_ASSIGNMENT_INVALID");
  assertAt(input.updatedAt);
  const existing = planFor(records, input.host, name);
  if (existing === undefined) fail("MODEL_PLAN_NOT_FOUND", `no model plan named ${name} exists for ${input.host}`);
  if (!Object.hasOwn(existing.assignments, persona)) fail("MODEL_PLAN_ASSIGNMENT_INVALID", `${persona} is not assigned in ${name}`);
  const assignments = { ...existing.assignments };
  delete assignments[persona];
  const efforts = existing.efforts === undefined ? undefined : { ...existing.efforts };
  if (efforts !== undefined) delete efforts[persona];
  const record = Object.freeze({
    ...existing,
    assignments: normalizeAssignments(assignments),
    ...(efforts === undefined || Object.keys(efforts).length === 0 ? {} : { efforts: normalizeEfforts(efforts) }),
    revision: existing.revision + 1,
    updatedAt: input.updatedAt,
  });
  return { records: planSort(records.map((entry) => entry === existing ? record : entry)), record };
}

export function applyModelPlanRemove(records: readonly ModelPlanRecord[], input: { readonly host: unknown; readonly name: unknown }, referencedBy: (record: ModelPlanRecord) => string | undefined): readonly ModelPlanRecord[] {
  assertModelPlanHost(input.host);
  const name = validateModelPlanName(input.name);
  const existing = planFor(records, input.host, name);
  if (existing === undefined) fail("MODEL_PLAN_NOT_FOUND", `no model plan named ${name} exists for ${input.host}`);
  const reference = referencedBy(existing);
  if (reference !== undefined) fail("MODEL_PLAN_IN_USE", `${name} is referenced by ${reference}; remove that reference first`);
  return planSort(records.filter((entry) => entry !== existing));
}

function validateRecord(value: unknown): ModelPlanRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("MODEL_PLAN_RECORD_INVALID", "model plan record must be an object");
  const record = value as Record<string, unknown>;
  const legacyFields = ["assignments", "defaultModel", "host", "name", "revision", "schemaVersion", "tombstone", "updatedAt"];
  // Three shapes replay: the original, the one S279 added `efforts` to, and this one.
  // Each is exact, so an unknown field is still refused.
  const acceptedShapes = [
    legacyFields,
    [...legacyFields, "efforts"],
    [...legacyFields, "defaultEffort"],
    [...legacyFields, "defaultEffort", "efforts"],
  ].map((fields) => canonicalJson(fields.slice().sort(compareCanonicalText)));
  const actualFields = Object.keys(record).sort(compareCanonicalText);
  if (!acceptedShapes.includes(canonicalJson(actualFields))) fail("MODEL_PLAN_RECORD_INVALID", "model plan record fields are not exact");
  assertModelPlanHost(record.host);
  const name = validateModelPlanName(record.name);
  const defaultModel = validateModelPlanModel(record.defaultModel);
  if (record.schemaVersion !== MODEL_PLAN_VERSION || record.tombstone !== false || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1) fail("MODEL_PLAN_RECORD_INVALID", "model plan record envelope is invalid");
  if (record.assignments === null || typeof record.assignments !== "object" || Array.isArray(record.assignments)) fail("MODEL_PLAN_RECORD_INVALID", "model plan assignments must be a map");
  const assignments: Record<string, string> = {};
  for (const [persona, model] of Object.entries(record.assignments)) {
    bounded(persona, "persona name", 64, "MODEL_PLAN_ASSIGNMENT_INVALID");
    assignments[persona] = validateModelPlanModel(model);
  }
  const defaultEffort = record.defaultEffort === undefined
    ? undefined
    : validateModelPlanEffort(record.defaultEffort, record.host as ModelPlanHost);
  let efforts: Readonly<Record<string, AgentEffortName>> | undefined;
  if (record.efforts !== undefined) {
    if (record.efforts === null || typeof record.efforts !== "object" || Array.isArray(record.efforts)) fail("MODEL_PLAN_RECORD_INVALID", "model plan efforts must be a map");
    const normalized: Record<string, AgentEffortName> = {};
    for (const [persona, effort] of Object.entries(record.efforts)) {
      bounded(persona, "persona name", 64, "MODEL_PLAN_ASSIGNMENT_INVALID");
      if (!Object.hasOwn(assignments, persona)) fail("MODEL_PLAN_RECORD_INVALID", `effort has no corresponding assignment for ${persona}`);
      normalized[persona] = validateModelPlanEffort(effort, record.host as ModelPlanHost);
    }
    efforts = normalizeEfforts(normalized);
  }
  assertAt(String(record.updatedAt));
  return Object.freeze({
    schemaVersion: MODEL_PLAN_VERSION,
    host: record.host as ModelPlanHost,
    name,
    defaultModel,
    assignments: normalizeAssignments(assignments),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(efforts === undefined ? {} : { efforts }),
    revision: record.revision as number,
    updatedAt: record.updatedAt as string,
    tombstone: false,
  });
}

export function validateModelPlanState(value: unknown): readonly ModelPlanRecord[] {
  if (!Array.isArray(value)) fail("MODEL_PLAN_RECORD_INVALID", "model plans must be an array");
  const records = value.map(validateRecord);
  if (new Set(records.map((record) => `${record.host}\u0000${record.name}`)).size !== records.length) fail("MODEL_PLAN_RECORD_INVALID", "duplicate model plan identity");
  return planSort(records);
}

export function readModelPlans(records: readonly ModelPlanRecord[]): readonly ModelPlanRecord[] {
  return planSort(records);
}
