// SPDX-License-Identifier: Apache-2.0

import { assertProtocolId, assertStrictInstant, canonicalJson, canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";
import {
  CORE_REFERENCE_PERSONA_IDS,
  generateCorePersonaBundle,
  isCoreReferencePersonaId,
} from "./core-reference-personas.js";

/**
 * The persona surface deliberately stores content, not a rendered prompt.  The
 * old v1 event shape remains a replay-only input; new reads never expose the
 * retired `description` or `prompt` fields.
 */
export const PERSONA_STORE_VERSION = "tcrn.persona-store.v2" as const;
export const PERSONA_RECORD_VERSION = "tcrn.persona.v2" as const;
export const LEGACY_PERSONA_RECORD_VERSION = "tcrn.persona.v1" as const;

// Single source for the role roster's semantic metadata. The
// reviewOnlyDispatchable values are an implementation proposal for the still
// unresolved policy decision; vocabulary consumers derive from this table and
// must not invent a second policy table at the presentation layer.
export const PERSONA_ROLE_DEFINITIONS = Object.freeze([
  { value: "orchestrator", description: "Coordinates bounded workflow decisions", reviewOnlyDispatchable: false },
  { value: "planner", description: "Turns intent into an executable plan", reviewOnlyDispatchable: false },
  { value: "implementer", description: "Changes the scoped implementation", reviewOnlyDispatchable: false },
  { value: "reviewer", description: "Checks evidence and reports discrepancies", reviewOnlyDispatchable: true },
  { value: "gatekeeper", description: "Applies a named quality or authority gate", reviewOnlyDispatchable: true },
  { value: "steward", description: "Maintains governed workspace health", reviewOnlyDispatchable: true },
] as const);
export const PERSONA_ROLES = Object.freeze(PERSONA_ROLE_DEFINITIONS.map((entry) => entry.value));
export type PersonaRole = typeof PERSONA_ROLE_DEFINITIONS[number]["value"];

export const PERSONA_CONTENT_FIELDS = Object.freeze([
  "jobTitle",
  "mission",
  "refusals",
  "authorityBoundary",
  "contactWhen",
  "requiredInputs",
  "deliverables",
  "successCriteria",
] as const);
export type PersonaContentField = typeof PERSONA_CONTENT_FIELDS[number];
export const PERSONA_NARRATIVE_FIELDS = Object.freeze(PERSONA_CONTENT_FIELDS.filter((field) => field !== "jobTitle"));
export const PERSONA_OVERRIDE_FIELDS = Object.freeze(["role", ...PERSONA_CONTENT_FIELDS] as const);
export type PersonaOverrideField = typeof PERSONA_OVERRIDE_FIELDS[number];

export const PERSONA_REASON_CODES = Object.freeze([
  "PERSONA_CONTENT_INVALID",
  "PERSONA_DESCRIPTION_INVALID",
  "PERSONA_FIELD_INVALID",
  "PERSONA_NAME_INVALID",
  "PERSONA_NAME_CONFLICT",
  "PERSONA_NOT_FOUND",
  "PERSONA_PRESET_NOT_FOUND",
  "PERSONA_PRESET_TOMBSTONED",
  "PERSONA_PROMPT_INVALID",
  "PERSONA_RECORD_INVALID",
  "PERSONA_ROLE_INVALID",
  "PERSONA_PRESET_IN_USE",
] as const);
export type PersonaReasonCode = typeof PERSONA_REASON_CODES[number];

export class PersonaStoreError extends Error {
  readonly reasonCode: PersonaReasonCode;

  constructor(reasonCode: PersonaReasonCode, message: string) {
    super(message);
    this.name = "PersonaStoreError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: PersonaReasonCode, message: string): never {
  throw new PersonaStoreError(reasonCode, message);
}

const codePointLength = (value: string): number => [...value].length;

function boundedText(value: unknown, label: string, maximum: number, reasonCode: PersonaReasonCode, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || codePointLength(value) > maximum || value.includes("\u0000")) {
    fail(reasonCode, `${label} must be ${allowEmpty ? "an empty or " : "a non-empty "}string of at most ${maximum} characters`);
  }
  try {
    canonicalJson(value);
  } catch {
    fail(reasonCode, `${label} is not canonical text`);
  }
  return value;
}

export function validatePersonaName(value: unknown): string {
  return boundedText(value, "persona name", 64, "PERSONA_NAME_INVALID");
}

export function validatePersonaJobTitle(value: unknown): string {
  return boundedText(value, "persona jobTitle", 256, "PERSONA_FIELD_INVALID", true);
}

export function validatePersonaContent(value: unknown, field: PersonaContentField): string {
  const maximum = field === "jobTitle" ? 256 : 4096;
  return boundedText(value, `persona ${field}`, maximum, field === "jobTitle" ? "PERSONA_FIELD_INVALID" : "PERSONA_CONTENT_INVALID", true);
}

export function validatePersonaDescription(value: unknown): string {
  return boundedText(value, "persona description", 256, "PERSONA_DESCRIPTION_INVALID");
}

/** Retained for callers that still validate a historical v1 event. */
export function validatePersonaPrompt(value: unknown): string {
  return boundedText(value, "persona prompt", 4096, "PERSONA_PROMPT_INVALID");
}

export function validatePersonaRole(value: unknown): PersonaRole {
  if (typeof value !== "string" || !(PERSONA_ROLES as readonly string[]).includes(value)) {
    fail("PERSONA_ROLE_INVALID", `persona role must be one of ${PERSONA_ROLES.join(", ")}`);
  }
  return value as PersonaRole;
}

/** The name is the user-facing identity; the derived id is never user-chosen. */
export function derivePersonaId(name: unknown): string {
  const canonicalName = validatePersonaName(name);
  const id = `profile:custom-${canonicalSha256({ namespace: "persona", name: canonicalName }).slice(0, 24)}-v1`;
  assertProtocolId(id);
  return id;
}

export interface PersonaRecord {
  readonly schemaVersion: typeof PERSONA_RECORD_VERSION;
  readonly id: string;
  readonly name: string;
  readonly role: PersonaRole;
  readonly jobTitle: string;
  readonly mission: string;
  readonly refusals: string;
  readonly authorityBoundary: string;
  readonly contactWhen: string;
  readonly requiredInputs: string;
  readonly deliverables: string;
  readonly successCriteria: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: false;
}

export interface LegacyPersonaRecord {
  readonly schemaVersion: typeof LEGACY_PERSONA_RECORD_VERSION;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly role: PersonaRole;
  readonly prompt: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: false;
}

export interface PersonaStoreState {
  readonly personas: readonly PersonaRecord[];
}

export interface PersonaPresetOverrideRecord {
  readonly schemaVersion: "tcrn.persona-preset-override.v1";
  readonly name: string;
  readonly fields: Readonly<Partial<Record<PersonaOverrideField, string | PersonaRole>>>;
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: false;
}

export const EMPTY_PERSONA_STORE: PersonaStoreState = Object.freeze({
  personas: Object.freeze([]),
});

const sortPersonas = (personas: readonly PersonaRecord[]): readonly PersonaRecord[] => Object.freeze(
  personas.slice().sort((left, right) => compareCanonicalText(left.id, right.id)),
);
const sortOverrides = (records: readonly PersonaPresetOverrideRecord[]): readonly PersonaPresetOverrideRecord[] => Object.freeze(
  records.slice().sort((left, right) => compareCanonicalText(left.name, right.name)),
);
const findPersona = (state: PersonaStoreState, id: string): PersonaRecord | undefined =>
  state.personas.find((persona) => persona.id === id);
const findCore = (name: string) => CORE_REFERENCE_PERSONAS.find((persona) => persona.name === name);

function assertUpdatedAt(value: string): void {
  try {
    assertStrictInstant(value);
  } catch {
    fail("PERSONA_RECORD_INVALID", "persona updatedAt is invalid");
  }
}

function emptyContent(): Record<PersonaContentField, string> {
  return {
    jobTitle: "",
    mission: "",
    refusals: "",
    authorityBoundary: "",
    contactWhen: "",
    requiredInputs: "",
    deliverables: "",
    successCriteria: "",
  };
}

function contentFromInput(input: Readonly<Record<string, unknown>>): Omit<PersonaRecord, "schemaVersion" | "id" | "name" | "revision" | "updatedAt" | "tombstone"> {
  const content = emptyContent();
  for (const field of PERSONA_CONTENT_FIELDS) {
    content[field] = validatePersonaContent(input[field] ?? "", field) as never;
  }
  return {
    role: validatePersonaRole(input.role),
    ...content,
  };
}

function makePersonaRecord(state: PersonaStoreState, input: Readonly<Record<string, unknown>>, updatedAt: string): PersonaRecord {
  const name = validatePersonaName(input.name);
  assertUpdatedAt(updatedAt);
  const id = derivePersonaId(name);
  const existing = findPersona(state, id);
  const content = contentFromInput(input);
  return Object.freeze({
    schemaVersion: PERSONA_RECORD_VERSION,
    id,
    name,
    ...content,
    revision: (existing?.revision ?? 0) + 1,
    updatedAt,
    tombstone: false,
  });
}

function activeCoreNames(tombstones: readonly string[] = []): readonly string[] {
  const deleted = new Set(tombstones);
  return CORE_REFERENCE_PERSONAS.filter((persona) => !deleted.has(persona.name)).map((persona) => persona.name);
}

export function personaNameExists(state: PersonaStoreState, name: unknown, tombstones: readonly string[] = []): boolean {
  const canonicalName = validatePersonaName(name);
  return activeCoreNames(tombstones).includes(canonicalName) || state.personas.some((persona) => persona.name === canonicalName);
}

export function personaNameExistsIncludingTombstones(state: PersonaStoreState, name: unknown): boolean {
  const canonicalName = validatePersonaName(name);
  return CORE_REFERENCE_PERSONAS.some((persona) => persona.name === canonicalName) || state.personas.some((persona) => persona.name === canonicalName);
}

export function applyPersonaSet(state: PersonaStoreState, input: {
  readonly name: unknown;
  readonly role: unknown;
  readonly jobTitle?: unknown;
  readonly mission?: unknown;
  readonly refusals?: unknown;
  readonly authorityBoundary?: unknown;
  readonly contactWhen?: unknown;
  readonly requiredInputs?: unknown;
  readonly deliverables?: unknown;
  readonly successCriteria?: unknown;
  /** Legacy parameters are accepted only by this in-memory compatibility helper. */
  readonly description?: unknown;
  readonly prompt?: unknown;
  readonly updatedAt: string;
}): { readonly state: PersonaStoreState; readonly record: PersonaRecord } {
  const inputRecord = input as unknown as Readonly<Record<string, unknown>>;
  const legacy = input.jobTitle === undefined && input.mission === undefined && input.description !== undefined;
  const normalized: Readonly<Record<string, unknown>> = legacy
    ? {
        ...inputRecord,
        jobTitle: input.description,
        mission: input.prompt ?? "",
        refusals: "",
        authorityBoundary: "",
        contactWhen: "",
        requiredInputs: "",
        deliverables: "",
        successCriteria: "",
      }
    : inputRecord;
  const record = makePersonaRecord(state, normalized, input.updatedAt);
  const existing = findPersona(state, record.id);
  return {
    state: { personas: sortPersonas(existing === undefined ? [...state.personas, record] : state.personas.map((entry) => entry === existing ? record : entry)) },
    record,
  };
}

/** Apply a historical `execution.persona.set` body without emitting v1 fields in a new event. */
export function applyLegacyPersonaSet(state: PersonaStoreState, input: {
  readonly id?: unknown;
  readonly schemaVersion?: unknown;
  readonly name: unknown;
  readonly description: unknown;
  readonly role: unknown;
  readonly prompt: unknown;
  readonly revision: unknown;
  readonly updatedAt: string;
  readonly tombstone: unknown;
}): { readonly state: PersonaStoreState; readonly record: PersonaRecord } {
  if (input.tombstone !== false || input.schemaVersion !== undefined && input.schemaVersion !== LEGACY_PERSONA_RECORD_VERSION) {
    fail("PERSONA_RECORD_INVALID", "legacy persona record envelope is invalid");
  }
  const name = validatePersonaName(input.name);
  const description = validatePersonaDescription(input.description);
  validatePersonaPrompt(input.prompt);
  validatePersonaRole(input.role);
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1) fail("PERSONA_RECORD_INVALID", "legacy persona revision is invalid");
  assertUpdatedAt(input.updatedAt);
  const id = derivePersonaId(name);
  if (input.id !== undefined && input.id !== id) fail("PERSONA_RECORD_INVALID", "legacy persona id is not derived from name");
  const existing = findPersona(state, id);
  const record = makePersonaRecord(state, {
    name,
    role: input.role,
    jobTitle: description,
    // The v1 prompt is replay evidence only.  It is deliberately not projected
    // into the v2 content face; only description has the ruled mapping to jobTitle.
    mission: "",
    refusals: "",
    authorityBoundary: "",
    contactWhen: "",
    requiredInputs: "",
    deliverables: "",
    successCriteria: "",
  }, input.updatedAt);
  const normalized = Object.freeze({ ...record, revision: Number(input.revision) });
  return {
    state: { personas: sortPersonas(existing === undefined ? [...state.personas, normalized] : state.personas.map((entry) => entry === existing ? normalized : entry)) },
    record: normalized,
  };
}

export function applyPersonaRemove(state: PersonaStoreState, input: { readonly name: unknown }): PersonaStoreState {
  const name = validatePersonaName(input.name);
  const id = derivePersonaId(name);
  const existing = findPersona(state, id);
  if (existing === undefined) fail("PERSONA_NOT_FOUND", `no custom persona named ${name} exists`);
  return { personas: sortPersonas(state.personas.filter((entry) => entry !== existing)) };
}

function validatePersonaRecord(value: unknown): PersonaRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("PERSONA_RECORD_INVALID", "persona record must be an object");
  const record = value as Record<string, unknown>;
  const expected = ["authorityBoundary", "contactWhen", "deliverables", "id", "jobTitle", "mission", "name", "refusals", "requiredInputs", "revision", "role", "schemaVersion", "successCriteria", "tombstone", "updatedAt"];
  if (canonicalJson(Object.keys(record).sort(compareCanonicalText)) !== canonicalJson(expected.sort(compareCanonicalText))) fail("PERSONA_RECORD_INVALID", "persona record fields are not exact");
  const name = validatePersonaName(record.name);
  if (record.schemaVersion !== PERSONA_RECORD_VERSION || record.tombstone !== false || typeof record.id !== "string" || record.id !== derivePersonaId(name) ||
    !Number.isSafeInteger(record.revision) || Number(record.revision) < 1 || typeof record.updatedAt !== "string") {
    fail("PERSONA_RECORD_INVALID", "persona record envelope is invalid");
  }
  validatePersonaRole(record.role);
  for (const field of PERSONA_CONTENT_FIELDS) validatePersonaContent(record[field], field);
  assertUpdatedAt(record.updatedAt);
  return record as unknown as PersonaRecord;
}

function normalizeLegacyRecord(value: unknown): PersonaRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("PERSONA_RECORD_INVALID", "legacy persona record must be an object");
  const record = value as Record<string, unknown>;
  const expected = ["description", "id", "name", "prompt", "revision", "role", "schemaVersion", "tombstone", "updatedAt"];
  if (canonicalJson(Object.keys(record).sort(compareCanonicalText)) !== canonicalJson(expected.sort(compareCanonicalText))) fail("PERSONA_RECORD_INVALID", "legacy persona record fields are not exact");
  return applyLegacyPersonaSet({ personas: [] }, {
    ...record,
    schemaVersion: LEGACY_PERSONA_RECORD_VERSION,
    id: record.id,
    name: record.name,
    description: record.description,
    role: record.role,
    prompt: record.prompt,
    revision: record.revision,
    updatedAt: String(record.updatedAt),
    tombstone: record.tombstone,
  }).record;
}

export function validatePersonaStoreState(value: unknown): PersonaStoreState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("PERSONA_RECORD_INVALID", "persona store state must be an object");
  const candidate = value as { personas?: unknown };
  if (!Array.isArray(candidate.personas)) fail("PERSONA_RECORD_INVALID", "persona store personas must be an array");
  const records = candidate.personas.map((record) => {
    const schemaVersion = record && typeof record === "object" && !Array.isArray(record) ? (record as Record<string, unknown>).schemaVersion : undefined;
    return schemaVersion === LEGACY_PERSONA_RECORD_VERSION ? normalizeLegacyRecord(record) : validatePersonaRecord(record);
  });
  if (new Set(records.map((record) => record.id)).size !== records.length || new Set(records.map((record) => record.name)).size !== records.length) fail("PERSONA_RECORD_INVALID", "persona store contains duplicate identity");
  return { personas: sortPersonas(records) };
}

export function personaExists(state: PersonaStoreState, profileId: string): boolean {
  return isCoreReferencePersonaId(profileId) || state.personas.some((persona) => persona.id === profileId);
}

export interface PersonaReadback {
  readonly id: string;
  readonly name: string;
  readonly role: PersonaRole;
  readonly jobTitle: string;
  readonly mission: string;
  readonly refusals: string;
  readonly authorityBoundary: string;
  readonly contactWhen: string;
  readonly requiredInputs: string;
  readonly deliverables: string;
  readonly successCriteria: string;
  readonly readOnly: boolean;
  readonly source: "core-reference" | "custom";
  readonly preset: boolean;
  readonly overridden: boolean;
  readonly overriddenFields: readonly PersonaOverrideField[];
  readonly factory?: Readonly<Record<string, string>>;
}

export type ReferencePersonaReadback = PersonaReadback & { readonly readOnly: true; readonly source: "core-reference"; readonly preset: true };

const CORE_ROLE_BY_NAME: Readonly<Record<string, PersonaRole>> = Object.freeze({
  Arturo: "orchestrator", Ilya: "implementer", Janus: "gatekeeper", Mara: "planner",
  Minerva: "planner", Mneme: "steward", Sable: "reviewer", Verity: "reviewer",
});

function coreContent(profile: ReturnType<typeof generateCorePersonaBundle>["profiles"][number]): Record<PersonaContentField, string> {
  return {
    jobTitle: profile.jobTitle,
    mission: profile.mission,
    refusals: profile.refusals.join("\n"),
    authorityBoundary: profile.authorityBoundary,
    contactWhen: profile.contactWhen,
    requiredInputs: profile.requiredInputs.join("\n"),
    deliverables: profile.deliverables.join("\n"),
    successCriteria: profile.successCriteria.join("\n"),
  };
}

export const CORE_REFERENCE_PERSONAS: readonly ReferencePersonaReadback[] = Object.freeze(
  generateCorePersonaBundle().profiles.map((profile) => {
    const factory = coreContent(profile);
    const readback: ReferencePersonaReadback = {
      id: profile.profileId,
      name: profile.displayName,
      role: CORE_ROLE_BY_NAME[profile.displayName] as PersonaRole,
      jobTitle: factory.jobTitle,
      mission: factory.mission,
      refusals: factory.refusals,
      authorityBoundary: factory.authorityBoundary,
      contactWhen: factory.contactWhen,
      requiredInputs: factory.requiredInputs,
      deliverables: factory.deliverables,
      successCriteria: factory.successCriteria,
      readOnly: true as const,
      source: "core-reference" as const,
      preset: true as const,
      overridden: false,
      overriddenFields: Object.freeze([]) as readonly PersonaOverrideField[],
      factory,
    };
    return Object.freeze(readback);
  }).sort((left, right) => compareCanonicalText(left.id, right.id)),
);

function applyOverrides(base: ReferencePersonaReadback, overrides: readonly PersonaPresetOverrideRecord[]): ReferencePersonaReadback {
  const override = overrides.find((entry) => entry.name === base.name);
  if (override === undefined) return base;
  const values = { ...base } as Record<string, unknown>;
  const fields = Object.keys(override.fields).sort(compareCanonicalText) as PersonaOverrideField[];
  for (const field of fields) values[field] = override.fields[field];
  return Object.freeze({
    ...values,
    overridden: fields.length > 0,
    overriddenFields: Object.freeze(fields),
    factory: base.factory,
  }) as ReferencePersonaReadback;
}

export function allPersonaReadback(
  state: PersonaStoreState,
  overrides: readonly PersonaPresetOverrideRecord[] = [],
  tombstones: readonly string[] = [],
): readonly (ReferencePersonaReadback | (PersonaRecord & { readonly readOnly: false; readonly source: "custom"; readonly preset: false; readonly overridden: false; readonly overriddenFields: readonly [] }))[] {
  const deleted = new Set(tombstones);
  const presets = CORE_REFERENCE_PERSONAS.filter((persona) => !deleted.has(persona.name)).map((persona) => applyOverrides(persona, overrides));
  const customs = state.personas.map((persona) => Object.freeze({
    ...persona,
    readOnly: false as const,
    source: "custom" as const,
    preset: false as const,
    overridden: false as const,
    overriddenFields: Object.freeze([]) as readonly [],
  }));
  return [...presets, ...customs].sort((left, right) => compareCanonicalText(left.id, right.id));
}

export function applyPersonaPresetOverride(input: {
  readonly name: unknown;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}, overrides: readonly PersonaPresetOverrideRecord[], tombstones: readonly string[] = []): { readonly overrides: readonly PersonaPresetOverrideRecord[]; readonly record: PersonaPresetOverrideRecord } {
  const name = validatePersonaName(input.name);
  if (!findCore(name)) fail("PERSONA_PRESET_NOT_FOUND", `no preset persona named ${name} exists`);
  if (tombstones.includes(name)) fail("PERSONA_PRESET_TOMBSTONED", `${name} is tombstoned`);
  const keys = Object.keys(input.fields).sort(compareCanonicalText);
  if (keys.length === 0 || keys.some((field) => !(PERSONA_OVERRIDE_FIELDS as readonly string[]).includes(field))) fail("PERSONA_FIELD_INVALID", "preset override fields are invalid");
  const fields: Partial<Record<PersonaOverrideField, string | PersonaRole>> = {};
  for (const field of keys as PersonaOverrideField[]) {
    fields[field] = field === "role"
      ? validatePersonaRole(input.fields[field])
      : validatePersonaContent(input.fields[field], field);
  }
  assertUpdatedAt(input.updatedAt);
  const existing = overrides.find((entry) => entry.name === name);
  const record: PersonaPresetOverrideRecord = Object.freeze({
    schemaVersion: "tcrn.persona-preset-override.v1",
    name,
    fields: Object.freeze(fields),
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: input.updatedAt,
    tombstone: false,
  });
  return { overrides: sortOverrides(existing === undefined ? [...overrides, record] : overrides.map((entry) => entry === existing ? record : entry)), record };
}

export function applyPersonaPresetRestore(input: { readonly name: unknown; readonly field?: unknown; readonly updatedAt: string }, overrides: readonly PersonaPresetOverrideRecord[], tombstones: readonly string[] = []): readonly PersonaPresetOverrideRecord[] {
  const name = validatePersonaName(input.name);
  if (!findCore(name)) fail("PERSONA_PRESET_NOT_FOUND", `no preset persona named ${name} exists`);
  assertUpdatedAt(input.updatedAt);
  const existing = overrides.find((entry) => entry.name === name);
  if (existing === undefined && !tombstones.includes(name)) fail("PERSONA_PRESET_NOT_FOUND", `${name} has no override`);
  if (existing === undefined) return overrides;
  if (input.field !== undefined && input.field !== "") {
    if (!(PERSONA_OVERRIDE_FIELDS as readonly string[]).includes(String(input.field))) fail("PERSONA_FIELD_INVALID", `unknown persona field ${String(input.field)}`);
    const fields = { ...existing.fields };
    delete fields[String(input.field) as PersonaOverrideField];
    return sortOverrides(fieldsCount(fields) === 0 ? overrides.filter((entry) => entry !== existing) : overrides.map((entry) => entry === existing ? Object.freeze({ ...entry, fields: Object.freeze(fields), revision: entry.revision + 1, updatedAt: input.updatedAt }) : entry));
  }
  return overrides.filter((entry) => entry !== existing);
}

function fieldsCount(fields: Readonly<Record<string, unknown>>): number { return Object.keys(fields).length; }

export function applyPersonaPresetRemove(input: { readonly name: unknown }, overrides: readonly PersonaPresetOverrideRecord[], tombstones: readonly string[], referencedBy: (name: string) => string | undefined): { readonly overrides: readonly PersonaPresetOverrideRecord[]; readonly tombstones: readonly string[] } {
  const name = validatePersonaName(input.name);
  if (!findCore(name)) fail("PERSONA_PRESET_NOT_FOUND", `no preset persona named ${name} exists`);
  const reference = referencedBy(name);
  if (reference !== undefined) fail("PERSONA_PRESET_IN_USE", `${name} is referenced by ${reference}; remove that assignment first`);
  return { overrides: overrides.filter((entry) => entry.name !== name), tombstones: Object.freeze([...new Set([...tombstones, name])].sort(compareCanonicalText)) };
}

export function validatePersonaPresetOverride(value: unknown): PersonaPresetOverrideRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("PERSONA_RECORD_INVALID", "preset override must be an object");
  const record = value as Record<string, unknown>;
  const expected = ["fields", "name", "revision", "schemaVersion", "tombstone", "updatedAt"];
  if (canonicalJson(Object.keys(record).sort(compareCanonicalText)) !== canonicalJson(expected.sort(compareCanonicalText))) fail("PERSONA_RECORD_INVALID", "preset override fields are not exact");
  const name = validatePersonaName(record.name);
  if (!findCore(name) || record.schemaVersion !== "tcrn.persona-preset-override.v1" || record.tombstone !== false || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1) fail("PERSONA_RECORD_INVALID", "preset override envelope is invalid");
  if (record.fields === null || typeof record.fields !== "object" || Array.isArray(record.fields)) fail("PERSONA_RECORD_INVALID", "preset override fields are invalid");
  const fields = record.fields as Record<string, unknown>;
  for (const field of Object.keys(fields)) {
    if (!(PERSONA_OVERRIDE_FIELDS as readonly string[]).includes(field)) fail("PERSONA_FIELD_INVALID", field);
    if (field === "role") validatePersonaRole(fields[field]);
    else validatePersonaContent(fields[field], field as PersonaContentField);
  }
  assertUpdatedAt(String(record.updatedAt));
  return Object.freeze({ ...record, name, fields: Object.freeze({ ...fields }) }) as unknown as PersonaPresetOverrideRecord;
}

export { CORE_REFERENCE_PERSONA_IDS };
