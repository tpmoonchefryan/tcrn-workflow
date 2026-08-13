// SPDX-License-Identifier: Apache-2.0

import { assertProtocolId, canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";
import {
  EMPTY_PERSONA_STORE,
  PersonaStoreError,
  applyPersonaRemove,
  applyPersonaSet,
  applyLegacyPersonaSet,
  applyPersonaPresetOverride,
  applyPersonaPresetRemove,
  applyPersonaPresetRestore,
  personaExists,
  personaNameExists,
  validatePersonaPresetOverride,
  validatePersonaStoreState,
} from "./persona-store.js";
import type { PersonaPresetOverrideRecord, PersonaRecord } from "./persona-store.js";
import {
  ModelPlanError,
  applyModelPlanAssign,
  applyModelPlanRemove,
  applyModelPlanSet,
  applyModelPlanUnassign,
  validateModelPlanState,
} from "./model-plan.js";
import type { ModelPlanRecord } from "./model-plan.js";

/**
 * INIT-026 S232 — the execution-configuration surface.
 *
 * A user's model choice is a composite judgement of cost, intelligence, and
 * feel: when Opus 5 shipped, a real population rolled back to 4.8, a decision
 * no tier vocabulary can express because both releases sit in the same tier.
 * So this surface records the model NAME the user chose, and the engine treats
 * it the way it treats a backup destination: carried, audited, never
 * interpreted. What the engine does own is referential integrity — a default
 * pointer must name a configuration that exists, and removing a configuration
 * something still points at is refused.
 *
 * Two layers, ruled deliberately:
 *   - per-host named configurations with one optional `default` pointer, so a
 *     global rollback is ONE switch;
 *   - per-persona bindings that pin a specific configuration, so a reviewer
 *     persona stays on the strong model while the default moves.
 * The pointer is called `default`, not `active`: a pinned persona does not
 * follow it, so "active" would claim more than the mechanism delivers.
 *
 * The host set is CLOSED — exactly the adapter families that exist. An API or
 * relay login still drives one of these two host applications; a third entry
 * would be a ghost host no adapter can wire.
 *
 * Access details stay off the chain: an entry is {name, model, note?}. An
 * endpoint or key belongs to the host's own local configuration, and the
 * Credentials discipline (references, never values) already says so.
 */
export const EXECUTION_CONFIG_VERSION = "tcrn.execution-config.v1" as const;
export const EXECUTION_HOSTS = Object.freeze(["claude-code", "codex"] as const);
export type ExecutionHost = typeof EXECUTION_HOSTS[number];

export const EXECUTION_CONFIG_REASON_CODES = Object.freeze([
  "EXECUTION_BINDING_UNKNOWN",
  "EXECUTION_CONFIGURATION_IN_USE",
  "EXECUTION_CONFIGURATION_UNKNOWN",
  "EXECUTION_HOST_UNKNOWN",
  "EXECUTION_PERSONA_IN_USE",
  "EXECUTION_PERSONA_UNKNOWN",
  "EXECUTION_RECORD_INVALID",
] as const);
export type ExecutionConfigReasonCode = typeof EXECUTION_CONFIG_REASON_CODES[number];

export interface HostConfigurationRecord {
  readonly schemaVersion: typeof EXECUTION_CONFIG_VERSION;
  readonly host: ExecutionHost;
  readonly name: string;
  readonly model: string;
  readonly note: string | null;
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: false;
}

export interface HostDefaultRecord {
  readonly host: ExecutionHost;
  readonly configurationName: string | null;
  readonly updatedAt: string;
}

export interface PersonaBindingRecord {
  readonly profileId: string;
  readonly host: ExecutionHost;
  readonly configurationName: string;
  readonly updatedAt: string;
}

export interface ExecutionConfigState {
  readonly configurations: readonly HostConfigurationRecord[];
  readonly defaults: readonly HostDefaultRecord[];
  readonly bindings: readonly PersonaBindingRecord[];
  readonly personas: readonly PersonaRecord[];
  readonly modelPlans: readonly ModelPlanRecord[];
  readonly personaOverrides: readonly PersonaPresetOverrideRecord[];
  readonly personaTombstones: readonly string[];
}

export const EMPTY_EXECUTION_CONFIG: ExecutionConfigState = Object.freeze({
  configurations: Object.freeze([]),
  defaults: Object.freeze([]),
  bindings: Object.freeze([]),
  personas: EMPTY_PERSONA_STORE.personas,
  modelPlans: Object.freeze([]),
  personaOverrides: Object.freeze([]),
  personaTombstones: Object.freeze([]),
});

export class ExecutionConfigError extends Error {
  readonly reasonCode: ExecutionConfigReasonCode;
  constructor(reasonCode: ExecutionConfigReasonCode, message: string) {
    super(message);
    this.name = "ExecutionConfigError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: ExecutionConfigReasonCode, message: string): never {
  throw new ExecutionConfigError(reasonCode, message);
}

export function assertExecutionHost(value: unknown): asserts value is ExecutionHost {
  if (!(EXECUTION_HOSTS as readonly string[]).includes(value as string)) {
    fail("EXECUTION_HOST_UNKNOWN", `host must be one of ${EXECUTION_HOSTS.join(", ")}`);
  }
}

function assertBoundedText(value: unknown, label: string, maximumLength: number, allowSpaces: boolean): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength || value.includes("\u0000") || (!allowSpaces && /\s/u.test(value))) {
    fail("EXECUTION_RECORD_INVALID", `${label} must be a non-empty string of at most ${maximumLength} characters`);
  }
  try {
    canonicalJson(value);
  } catch {
    fail("EXECUTION_RECORD_INVALID", `${label} is not canonical text`);
  }
}

export function validateConfigurationName(value: unknown): string {
  assertBoundedText(value, "configuration name", 64, false);
  return value;
}

/** The model is the user's choice, carried verbatim. Bounded, never interpreted. */
export function validateModel(value: unknown): string {
  assertBoundedText(value, "model", 256, false);
  return value;
}

export function validateNote(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  assertBoundedText(value, "note", 512, true);
  return value;
}

const findConfiguration = (state: ExecutionConfigState, host: ExecutionHost, name: string) =>
  state.configurations.find((entry) => entry.host === host && entry.name === name);

export function applyHostConfigSet(state: ExecutionConfigState, input: {
  readonly host: ExecutionHost;
  readonly name: string;
  readonly model: string;
  readonly note: string | null;
  readonly updatedAt: string;
}): { readonly state: ExecutionConfigState; readonly record: HostConfigurationRecord } {
  const existing = findConfiguration(state, input.host, input.name);
  const record: HostConfigurationRecord = Object.freeze({
    schemaVersion: EXECUTION_CONFIG_VERSION,
    host: input.host,
    name: input.name,
    model: input.model,
    note: input.note,
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: input.updatedAt,
    tombstone: false,
  });
  const configurations = existing === undefined
    ? [...state.configurations, record]
    : state.configurations.map((entry) => entry === existing ? record : entry);
  return { state: { ...state, configurations: sortState(configurations) }, record };
}

export function applyHostConfigRemove(state: ExecutionConfigState, input: {
  readonly host: ExecutionHost;
  readonly name: string;
}): ExecutionConfigState {
  const existing = findConfiguration(state, input.host, input.name);
  if (existing === undefined) {
    fail("EXECUTION_CONFIGURATION_UNKNOWN", `no configuration named ${input.name} for ${input.host}`);
  }
  // Referential integrity is the engine's half of the bargain. The content of a
  // configuration is opaque; whether something still points at it is not.
  const defaultPointer = state.defaults.find((entry) => entry.host === input.host);
  if (defaultPointer?.configurationName === input.name) {
    fail("EXECUTION_CONFIGURATION_IN_USE", `${input.name} is ${input.host}'s default; move or clear the default first`);
  }
  const binding = state.bindings.find((entry) => entry.host === input.host && entry.configurationName === input.name);
  if (binding !== undefined) {
    fail("EXECUTION_CONFIGURATION_IN_USE", `${input.name} is pinned by ${binding.profileId}; remove that binding first`);
  }
  return { ...state, configurations: state.configurations.filter((entry) => entry !== existing) };
}

export function applyHostConfigDefault(state: ExecutionConfigState, input: {
  readonly host: ExecutionHost;
  readonly configurationName: string | null;
  readonly updatedAt: string;
}): ExecutionConfigState {
  if (input.configurationName !== null && findConfiguration(state, input.host, input.configurationName) === undefined) {
    fail("EXECUTION_CONFIGURATION_UNKNOWN", `no configuration named ${input.configurationName} for ${input.host}`);
  }
  const record: HostDefaultRecord = Object.freeze({
    host: input.host,
    configurationName: input.configurationName,
    updatedAt: input.updatedAt,
  });
  const defaults = [...state.defaults.filter((entry) => entry.host !== input.host), record];
  return { ...state, defaults: Object.freeze(defaults.slice().sort((a, b) => a.host.localeCompare(b.host))) };
}

export function applyPersonaBindingSet(state: ExecutionConfigState, input: {
  readonly profileId: string;
  readonly host: ExecutionHost;
  readonly configurationName: string;
  readonly updatedAt: string;
}): ExecutionConfigState {
  try {
    assertProtocolId(input.profileId);
  } catch {
    fail("EXECUTION_RECORD_INVALID", "profileId must be a protocol id such as profile:tcrn-verity-v1");
  }
  if (findConfiguration(state, input.host, input.configurationName) === undefined) {
    fail("EXECUTION_CONFIGURATION_UNKNOWN", `no configuration named ${input.configurationName} for ${input.host}`);
  }
  if (!personaExists({ personas: state.personas }, input.profileId)) {
    fail("EXECUTION_PERSONA_UNKNOWN", `no persona exists for ${input.profileId}`);
  }
  const record: PersonaBindingRecord = Object.freeze({
    profileId: input.profileId,
    host: input.host,
    configurationName: input.configurationName,
    updatedAt: input.updatedAt,
  });
  const bindings = [...state.bindings.filter((entry) => !(entry.profileId === input.profileId && entry.host === input.host)), record];
  return { ...state, bindings: Object.freeze(bindings.slice().sort((a, b) => a.profileId.localeCompare(b.profileId) || a.host.localeCompare(b.host))) };
}

export function applyPersonaBindingRemove(state: ExecutionConfigState, input: {
  readonly profileId: string;
  readonly host: ExecutionHost;
}): ExecutionConfigState {
  const existing = state.bindings.find((entry) => entry.profileId === input.profileId && entry.host === input.host);
  if (existing === undefined) {
    fail("EXECUTION_BINDING_UNKNOWN", `no binding for ${input.profileId} on ${input.host}`);
  }
  return { ...state, bindings: state.bindings.filter((entry) => entry !== existing) };
}

export function applyCustomPersonaSet(state: ExecutionConfigState, input: {
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
  readonly description?: unknown;
  readonly prompt?: unknown;
  readonly updatedAt: string;
}): { readonly state: ExecutionConfigState; readonly record: PersonaRecord } {
  try {
    const name = String(input.name);
    if (personaNameExists({ personas: state.personas }, name, state.personaTombstones) && !state.personas.some((persona) => persona.name === name)) {
      throw new PersonaStoreError("PERSONA_NAME_CONFLICT", `${name} is reserved by a preset persona`);
    }
    if (state.personaTombstones.includes(name)) {
      throw new PersonaStoreError("PERSONA_NAME_CONFLICT", `${name} is reserved by a tombstoned preset persona`);
    }
    const applied = applyPersonaSet({ personas: state.personas }, input);
    return { state: { ...state, personas: applied.state.personas }, record: applied.record };
  } catch (error) {
    if (error instanceof PersonaStoreError) throw error;
    throw error;
  }
}

export function applyLegacyCustomPersonaSet(state: ExecutionConfigState, input: {
  readonly id?: unknown;
  readonly schemaVersion?: unknown;
  readonly name: unknown;
  readonly description: unknown;
  readonly role: unknown;
  readonly prompt: unknown;
  readonly revision: unknown;
  readonly updatedAt: string;
  readonly tombstone: unknown;
}): { readonly state: ExecutionConfigState; readonly record: PersonaRecord } {
  try {
    const applied = applyLegacyPersonaSet({ personas: state.personas }, input);
    return { state: { ...state, personas: applied.state.personas }, record: applied.record };
  } catch (error) {
    if (error instanceof PersonaStoreError) throw error;
    throw error;
  }
}

export function applyCustomPersonaRemove(state: ExecutionConfigState, input: { readonly name: unknown }): ExecutionConfigState {
  const id = (() => {
    const candidate = state.personas.find((persona) => persona.name === input.name);
    return candidate?.id;
  })();
  const binding = id === undefined ? undefined : state.bindings.find((candidate) => candidate.profileId === id);
  if (binding !== undefined) {
    fail("EXECUTION_PERSONA_IN_USE", `${String(input.name)} is referenced by ${binding.profileId} on ${binding.host}; remove that binding first`);
  }
  const name = String(input.name);
  if (state.modelPlans.some((plan) => Object.hasOwn(plan.assignments, name))) {
    fail("EXECUTION_PERSONA_IN_USE", `${name} is referenced by a model plan; remove that assignment first`);
  }
  try {
    const next = applyPersonaRemove({ personas: state.personas }, input);
    return { ...state, personas: next.personas };
  } catch (error) {
    if (error instanceof PersonaStoreError) throw error;
    throw error;
  }
}

export function applyModelPlanSetInExecutionConfig(state: ExecutionConfigState, input: {
  readonly host: unknown; readonly name: unknown; readonly defaultModel: unknown; readonly updatedAt: string;
}): { readonly state: ExecutionConfigState; readonly record: ModelPlanRecord } {
  try {
    const applied = applyModelPlanSet(state.modelPlans, input);
    return { state: { ...state, modelPlans: applied.records }, record: applied.record };
  } catch (error) {
    if (error instanceof ModelPlanError) throw error;
    throw error;
  }
}

export function applyModelPlanAssignInExecutionConfig(state: ExecutionConfigState, input: {
  readonly host: unknown; readonly name: unknown; readonly persona: unknown; readonly model: unknown; readonly updatedAt: string;
}): { readonly state: ExecutionConfigState; readonly record: ModelPlanRecord } {
  const applied = applyModelPlanAssign(state.modelPlans, input, (name) => personaNameExists({ personas: state.personas }, name, state.personaTombstones));
  return { state: { ...state, modelPlans: applied.records }, record: applied.record };
}

export function applyModelPlanUnassignInExecutionConfig(state: ExecutionConfigState, input: {
  readonly host: unknown; readonly name: unknown; readonly persona: unknown; readonly updatedAt: string;
}): { readonly state: ExecutionConfigState; readonly record: ModelPlanRecord } {
  const applied = applyModelPlanUnassign(state.modelPlans, input);
  return { state: { ...state, modelPlans: applied.records }, record: applied.record };
}

export function applyModelPlanRemoveInExecutionConfig(state: ExecutionConfigState, input: { readonly host: unknown; readonly name: unknown }, settings: readonly { readonly key: string; readonly value: string }[]): ExecutionConfigState {
  const records = applyModelPlanRemove(state.modelPlans, input, (plan) => {
    const setting = settings.find((candidate) =>
      (plan.host === "claude-code" && candidate.key === "execution.claudeCodeSubagentPlan" && candidate.value === plan.name) ||
      (plan.host === "codex" && candidate.key === "execution.codexSubagentPlan" && candidate.value === plan.name),
    );
    return setting === undefined ? undefined : `setting ${setting.key}`;
  });
  return { ...state, modelPlans: records };
}

export function applyPersonaPresetOverrideInExecutionConfig(state: ExecutionConfigState, input: {
  readonly name: unknown; readonly fields: Readonly<Record<string, unknown>>; readonly updatedAt: string;
}): { readonly state: ExecutionConfigState; readonly record: PersonaPresetOverrideRecord } {
  if (state.personas.some((persona) => persona.name === String(input.name))) {
    throw new PersonaStoreError("PERSONA_NAME_CONFLICT", `${String(input.name)} is a custom persona, not a preset; use persona-set for custom content`);
  }
  const applied = applyPersonaPresetOverride(input, state.personaOverrides, state.personaTombstones);
  return { state: { ...state, personaOverrides: applied.overrides }, record: applied.record };
}

export function applyPersonaPresetRestoreInExecutionConfig(state: ExecutionConfigState, input: { readonly name: unknown; readonly field?: unknown; readonly updatedAt: string }): ExecutionConfigState {
  const name = String(input.name);
  return {
    ...state,
    personaOverrides: applyPersonaPresetRestore(input, state.personaOverrides, state.personaTombstones),
    personaTombstones: state.personaTombstones.filter((entry) => entry !== name),
  };
}

export function applyPersonaPresetRemoveInExecutionConfig(state: ExecutionConfigState, input: { readonly name: unknown }): ExecutionConfigState {
  const applied = applyPersonaPresetRemove(input, state.personaOverrides, state.personaTombstones,
    (name) => {
      const plan = state.modelPlans.find((candidate) => Object.hasOwn(candidate.assignments, name));
      return plan === undefined ? undefined : `model plan ${plan.host}/${plan.name}`;
    });
  return { ...state, personaOverrides: applied.overrides, personaTombstones: applied.tombstones };
}

function sortState(configurations: readonly HostConfigurationRecord[]): readonly HostConfigurationRecord[] {
  return Object.freeze(configurations.slice().sort((a, b) =>
    a.host.localeCompare(b.host) || a.name.localeCompare(b.name)));
}

/** Replay arm: rebuild the surface from its event payloads, refusing malformed ones. */
export function validateExecutionConfigState(value: unknown): ExecutionConfigState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("EXECUTION_RECORD_INVALID", "execution config state must be an object");
  }
  const candidate = value as { configurations?: unknown; defaults?: unknown; bindings?: unknown; personas?: unknown; modelPlans?: unknown; personaOverrides?: unknown; personaTombstones?: unknown };
  const configurations = Array.isArray(candidate.configurations) ? candidate.configurations : [];
  const defaults = Array.isArray(candidate.defaults) ? candidate.defaults : [];
  const bindings = Array.isArray(candidate.bindings) ? candidate.bindings : [];
  const personas = validatePersonaStoreState({ personas: Array.isArray(candidate.personas) ? candidate.personas : [] });
  const modelPlans = validateModelPlanState(Array.isArray(candidate.modelPlans) ? candidate.modelPlans : []);
  const personaOverrides = Array.isArray(candidate.personaOverrides) ? candidate.personaOverrides.map(validatePersonaPresetOverride) : [];
  const personaTombstones = Array.isArray(candidate.personaTombstones) && candidate.personaTombstones.every((entry) => typeof entry === "string")
    ? [...new Set(candidate.personaTombstones as string[])].sort(compareCanonicalText)
    : [];
  for (const entry of configurations) {
    const record = entry as HostConfigurationRecord;
    assertExecutionHost(record.host);
    validateConfigurationName(record.name);
    validateModel(record.model);
    validateNote(record.note);
  }
  for (const entry of defaults) {
    const record = entry as HostDefaultRecord;
    assertExecutionHost(record.host);
    if (record.configurationName !== null) validateConfigurationName(record.configurationName);
  }
  for (const entry of bindings) {
    const record = entry as PersonaBindingRecord;
    assertExecutionHost(record.host);
    validateConfigurationName(record.configurationName);
    if (!personaExists(personas, record.profileId)) fail("EXECUTION_PERSONA_UNKNOWN", `no persona exists for ${record.profileId}`);
  }
  return {
    configurations: sortState(configurations as HostConfigurationRecord[]),
    defaults: Object.freeze([...(defaults as HostDefaultRecord[])]),
    bindings: Object.freeze([...(bindings as PersonaBindingRecord[])]),
    personas: personas.personas,
    modelPlans,
    personaOverrides: Object.freeze(personaOverrides),
    personaTombstones: Object.freeze(personaTombstones),
  };
}
