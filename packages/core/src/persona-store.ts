// SPDX-License-Identifier: Apache-2.0

import { assertProtocolId, assertStrictInstant, canonicalJson, canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";
import {
  CORE_REFERENCE_PERSONA_IDS,
  generateCorePersonaBundle,
  isCoreReferencePersonaId,
} from "./core-reference-personas.js";

/**
 * INIT-027 S238 — the user-owned persona content surface.
 *
 * Core Reference personas remain a separate, read-only conference roster. This
 * store carries only custom personas; the two sets are joined at the binding
 * boundary and at the read surface, never by copying or mutating the compiled
 * reference data.
 */
export const PERSONA_STORE_VERSION = "tcrn.persona-store.v1" as const;
export const PERSONA_RECORD_VERSION = "tcrn.persona.v1" as const;

export const PERSONA_ROLES = Object.freeze([
  "orchestrator",
  "planner",
  "implementer",
  "reviewer",
  "gatekeeper",
  "steward",
] as const);
export type PersonaRole = typeof PERSONA_ROLES[number];

export const PERSONA_REASON_CODES = Object.freeze([
  "PERSONA_DESCRIPTION_INVALID",
  "PERSONA_NAME_INVALID",
  "PERSONA_NOT_FOUND",
  "PERSONA_PROMPT_INVALID",
  "PERSONA_RECORD_INVALID",
  "PERSONA_ROLE_INVALID",
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

function boundedText(value: unknown, label: string, maximum: number, reasonCode: PersonaReasonCode): string {
  if (typeof value !== "string" || value.length === 0 || codePointLength(value) > maximum || value.includes("\u0000")) {
    fail(reasonCode, `${label} must be a non-empty string of at most ${maximum} characters`);
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

export function validatePersonaDescription(value: unknown): string {
  return boundedText(value, "persona description", 256, "PERSONA_DESCRIPTION_INVALID");
}

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

export const EMPTY_PERSONA_STORE: PersonaStoreState = Object.freeze({
  personas: Object.freeze([]),
});

const sortPersonas = (personas: readonly PersonaRecord[]): readonly PersonaRecord[] => Object.freeze(
  personas.slice().sort((left, right) => compareCanonicalText(left.id, right.id)),
);

const findPersona = (state: PersonaStoreState, id: string): PersonaRecord | undefined =>
  state.personas.find((persona) => persona.id === id);

export function applyPersonaSet(state: PersonaStoreState, input: {
  readonly name: unknown;
  readonly description: unknown;
  readonly role: unknown;
  readonly prompt: unknown;
  readonly updatedAt: string;
}): { readonly state: PersonaStoreState; readonly record: PersonaRecord } {
  const name = validatePersonaName(input.name);
  const description = validatePersonaDescription(input.description);
  const role = validatePersonaRole(input.role);
  const prompt = validatePersonaPrompt(input.prompt);
  try {
    assertStrictInstant(input.updatedAt);
  } catch {
    fail("PERSONA_RECORD_INVALID", "persona updatedAt is invalid");
  }
  const id = derivePersonaId(name);
  const existing = findPersona(state, id);
  const record: PersonaRecord = Object.freeze({
    schemaVersion: PERSONA_RECORD_VERSION,
    id,
    name,
    description,
    role,
    prompt,
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: input.updatedAt,
    tombstone: false,
  });
  return {
    state: { personas: sortPersonas(existing === undefined ? [...state.personas, record] : state.personas.map((entry) => entry === existing ? record : entry)) },
    record,
  };
}

export function applyPersonaRemove(state: PersonaStoreState, input: { readonly name: unknown }): PersonaStoreState {
  const id = derivePersonaId(input.name);
  const existing = findPersona(state, id);
  if (existing === undefined) {
    fail("PERSONA_NOT_FOUND", `no custom persona named ${existingName(input.name)} exists`);
  }
  return { personas: sortPersonas(state.personas.filter((entry) => entry !== existing)) };
}

function existingName(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function validatePersonaRecord(value: unknown): PersonaRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("PERSONA_RECORD_INVALID", "persona record must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = ["description", "id", "name", "prompt", "revision", "role", "schemaVersion", "tombstone", "updatedAt"];
  if (JSON.stringify(Object.keys(record).sort(compareCanonicalText)) !== JSON.stringify(expected.slice().sort(compareCanonicalText))) {
    fail("PERSONA_RECORD_INVALID", "persona record fields are not exact");
  }
  const name = validatePersonaName(record.name);
  validatePersonaDescription(record.description);
  validatePersonaRole(record.role);
  validatePersonaPrompt(record.prompt);
  if (record.schemaVersion !== PERSONA_RECORD_VERSION || record.tombstone !== false || typeof record.id !== "string" ||
    !Number.isSafeInteger(record.revision) || Number(record.revision) < 1 || typeof record.updatedAt !== "string") {
    fail("PERSONA_RECORD_INVALID", "persona record envelope is invalid");
  }
  try {
    assertStrictInstant(record.updatedAt);
    if (record.id !== derivePersonaId(name)) fail("PERSONA_RECORD_INVALID", "persona id is not derived from name");
  } catch (error) {
    if (error instanceof PersonaStoreError) throw error;
    fail("PERSONA_RECORD_INVALID", "persona record identity is invalid");
  }
  return record as unknown as PersonaRecord;
}

export function validatePersonaStoreState(value: unknown): PersonaStoreState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("PERSONA_RECORD_INVALID", "persona store state must be an object");
  }
  const candidate = value as { personas?: unknown };
  if (!Array.isArray(candidate.personas)) fail("PERSONA_RECORD_INVALID", "persona store personas must be an array");
  const records = candidate.personas.map(validatePersonaRecord);
  if (new Set(records.map((record) => record.id)).size !== records.length || new Set(records.map((record) => record.name)).size !== records.length) {
    fail("PERSONA_RECORD_INVALID", "persona store contains duplicate identity");
  }
  return { personas: sortPersonas(records) };
}

export function personaExists(state: PersonaStoreState, profileId: string): boolean {
  return isCoreReferencePersonaId(profileId) || state.personas.some((persona) => persona.id === profileId);
}

export interface ReferencePersonaReadback {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly role: PersonaRole;
  readonly prompt: string;
  readonly readOnly: true;
  readonly source: "core-reference";
}

const CORE_ROLE_BY_NAME: Readonly<Record<string, PersonaRole>> = Object.freeze({
  Arturo: "orchestrator",
  Ilya: "implementer",
  Janus: "gatekeeper",
  Mara: "planner",
  Minerva: "planner",
  Mneme: "steward",
  Sable: "reviewer",
  Verity: "reviewer",
});

/** Read-only presentation records for the eight compiled conference personas. */
export const CORE_REFERENCE_PERSONAS: readonly ReferencePersonaReadback[] = Object.freeze(
  generateCorePersonaBundle().profiles.map((profile) => Object.freeze({
    id: profile.profileId,
    name: profile.displayName,
    description: profile.mission,
    role: CORE_ROLE_BY_NAME[profile.displayName] as PersonaRole,
    prompt: `${profile.mission}\n\nAuthority boundary: ${profile.authorityBoundary}`,
    readOnly: true as const,
    source: "core-reference" as const,
  })).sort((left, right) => compareCanonicalText(left.id, right.id)),
);

export function allPersonaReadback(state: PersonaStoreState): readonly (ReferencePersonaReadback | (PersonaRecord & { readonly readOnly: false; readonly source: "custom" }))[] {
  return [
    ...CORE_REFERENCE_PERSONAS,
    ...state.personas.map((persona) => ({ ...persona, readOnly: false as const, source: "custom" as const })),
  ].sort((left, right) => compareCanonicalText(left.id, right.id));
}

export { CORE_REFERENCE_PERSONA_IDS };
