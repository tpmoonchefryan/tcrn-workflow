// SPDX-License-Identifier: Apache-2.0

import { assertProtocolId, canonicalJson } from "../../protocol/src/index.js";

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
}

export const EMPTY_EXECUTION_CONFIG: ExecutionConfigState = Object.freeze({
  configurations: Object.freeze([]),
  defaults: Object.freeze([]),
  bindings: Object.freeze([]),
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

function sortState(configurations: readonly HostConfigurationRecord[]): readonly HostConfigurationRecord[] {
  return Object.freeze(configurations.slice().sort((a, b) =>
    a.host.localeCompare(b.host) || a.name.localeCompare(b.name)));
}

/** Replay arm: rebuild the surface from its event payloads, refusing malformed ones. */
export function validateExecutionConfigState(value: unknown): ExecutionConfigState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("EXECUTION_RECORD_INVALID", "execution config state must be an object");
  }
  const candidate = value as { configurations?: unknown; defaults?: unknown; bindings?: unknown };
  const configurations = Array.isArray(candidate.configurations) ? candidate.configurations : [];
  const defaults = Array.isArray(candidate.defaults) ? candidate.defaults : [];
  const bindings = Array.isArray(candidate.bindings) ? candidate.bindings : [];
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
  }
  return {
    configurations: sortState(configurations as HostConfigurationRecord[]),
    defaults: Object.freeze([...(defaults as HostDefaultRecord[])]),
    bindings: Object.freeze([...(bindings as PersonaBindingRecord[])]),
  };
}
