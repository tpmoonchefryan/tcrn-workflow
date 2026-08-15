// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-281 — the machine settings layer.
//
// Workspace settings are governed state: they live on the chain, every write is an
// event, and CAS orders them. These are not that. They are per-machine preferences
// about how this machine's portal opens — which partition, which language, which
// theme, which port — and none of them is a claim anyone needs to audit. Putting them
// on a chain would mean every laptop preference became a governed event on a shared
// ledger, and choosing a partition to open in would need an expected-version.
//
// So this layer is deliberately NOT chain-backed. It is a single canonical JSON file
// under the machine-level engine home the install manifest already declares
// (`machine.workflow-engine`, `<HOME>/.tcrn-workflow`). Two properties are kept from
// the governed layer because they are not about governance: only the engine writes the
// file, and every value is validated against a closed catalogue before it is stored.
//
// Resolution order for a value that exists in both places is stated by the consumer,
// not here: the portal reads browser-local preference first, this layer second, its
// built-in fallback last. This module answers only "what does this machine say".

import { homedir } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson } from "../../protocol/src/index.js";

export const MACHINE_SETTINGS_VERSION = "tcrn.machine-settings.v1" as const;
export const MACHINE_SETTINGS_LAYER_KIND = "machine_configuration" as const;
export const MACHINE_SETTINGS_FILE_NAME = "machine-settings.json" as const;
/** The machine-level engine home, as declared by install-manifest item machine.workflow-engine. */
export const MACHINE_SETTINGS_DIRECTORY = ".tcrn-workflow" as const;

export const MACHINE_SETTING_KEYS = Object.freeze([
  "portal.defaultLocale",
  "portal.defaultPartition",
  "portal.defaultTheme",
  "portal.port",
] as const);
export type MachineSettingKey = typeof MACHINE_SETTING_KEYS[number];

export const MACHINE_SETTINGS_REASON_CODES = Object.freeze([
  "MACHINE_SETTINGS_FILE_INVALID",
  "MACHINE_SETTING_KEY_UNKNOWN",
  "MACHINE_SETTING_NOT_SET",
  "MACHINE_SETTING_VALUE_INVALID",
] as const);
export type MachineSettingsReasonCode = typeof MACHINE_SETTINGS_REASON_CODES[number];

export class MachineSettingsError extends Error {
  readonly reasonCode: MachineSettingsReasonCode;
  constructor(reasonCode: MachineSettingsReasonCode, message: string) {
    super(message);
    this.name = "MachineSettingsError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: MachineSettingsReasonCode, message: string): never {
  throw new MachineSettingsError(reasonCode, message);
}

export interface MachineSettingsCatalogEntry {
  readonly key: MachineSettingKey;
  readonly type: "enum" | "integer" | "string";
  readonly controlType: "enum" | "number" | "text";
  readonly layerKind: typeof MACHINE_SETTINGS_LAYER_KIND;
  readonly defaultValue: string | null;
  readonly allowedValues?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  /**
   * Whether a change takes effect on the next read or only when the portal restarts.
   * The port is bound at listen time, so a receipt that did not say so would leave the
   * reader watching an unchanged page and concluding the write failed.
   */
  readonly appliesOn: "next-open" | "restart";
  /**
   * Where the legal values come from. `settings-catalog` means the closed list below;
   * `workspace-discovery` means the value set is whatever partitions this machine has,
   * so it is not vocabulary and does not belong in the dictionary (INC-186).
   */
  readonly valueSource: "settings-catalog" | "workspace-discovery";
}

export const MACHINE_SETTINGS_CATALOG: readonly MachineSettingsCatalogEntry[] = Object.freeze([
  Object.freeze({
    key: "portal.defaultLocale",
    type: "enum",
    controlType: "enum",
    layerKind: MACHINE_SETTINGS_LAYER_KIND,
    defaultValue: null,
    allowedValues: Object.freeze(["zh-CN", "en", "ja", "ko", "fr"]),
    appliesOn: "next-open",
    valueSource: "settings-catalog",
  }),
  Object.freeze({
    key: "portal.defaultPartition",
    type: "string",
    controlType: "enum",
    layerKind: MACHINE_SETTINGS_LAYER_KIND,
    defaultValue: null,
    appliesOn: "next-open",
    valueSource: "workspace-discovery",
  }),
  Object.freeze({
    key: "portal.defaultTheme",
    type: "enum",
    controlType: "enum",
    layerKind: MACHINE_SETTINGS_LAYER_KIND,
    defaultValue: null,
    allowedValues: Object.freeze(["light", "dark", "system"]),
    appliesOn: "next-open",
    valueSource: "settings-catalog",
  }),
  Object.freeze({
    key: "portal.port",
    type: "integer",
    controlType: "number",
    layerKind: MACHINE_SETTINGS_LAYER_KIND,
    defaultValue: null,
    min: 1024,
    max: 65535,
    appliesOn: "restart",
    valueSource: "settings-catalog",
  }),
]);

const BY_KEY = new Map<string, MachineSettingsCatalogEntry>(MACHINE_SETTINGS_CATALOG.map((entry) => [entry.key, entry]));

export function machineSettingsPath(home: string = homedir()): string {
  return join(home, MACHINE_SETTINGS_DIRECTORY, MACHINE_SETTINGS_FILE_NAME);
}

export function assertMachineSettingKey(value: unknown): asserts value is MachineSettingKey {
  if (!BY_KEY.has(value as string)) {
    fail("MACHINE_SETTING_KEY_UNKNOWN", `${String(value)} is not a machine setting; choose one of ${MACHINE_SETTING_KEYS.join(", ")}`);
  }
}

/**
 * A key whose values come from workspace discovery cannot be validated against a list
 * here — the engine would have to enumerate this machine's partitions to know, and
 * that is the caller's knowledge, not this module's. Such a value is checked for shape
 * only, and the caller is responsible for offering a real choice.
 */
export function validateMachineSettingValue(key: MachineSettingKey, value: unknown): string {
  const entry = BY_KEY.get(key);
  if (entry === undefined) fail("MACHINE_SETTING_KEY_UNKNOWN", `${key} is not a machine setting`);
  if (typeof value !== "string" || value.length === 0) {
    fail("MACHINE_SETTING_VALUE_INVALID", `${key} needs a non-empty string; to clear it use the remove verb`);
  }
  if (entry.allowedValues !== undefined && !entry.allowedValues.includes(value)) {
    fail("MACHINE_SETTING_VALUE_INVALID", `${value} is not valid for ${key}; legal values: ${entry.allowedValues.join(", ")}`);
  }
  if (entry.type === "integer") {
    if (!/^-?\d+$/u.test(value)) fail("MACHINE_SETTING_VALUE_INVALID", `${key} needs a whole number`);
    const parsed = Number(value);
    if (entry.min !== undefined && parsed < entry.min) fail("MACHINE_SETTING_VALUE_INVALID", `${key} must be at least ${entry.min}`);
    if (entry.max !== undefined && parsed > entry.max) fail("MACHINE_SETTING_VALUE_INVALID", `${key} must be at most ${entry.max}`);
  }
  if (entry.valueSource === "workspace-discovery" && value.trim() !== value) {
    fail("MACHINE_SETTING_VALUE_INVALID", `${key} must not carry surrounding whitespace`);
  }
  return value;
}

export interface MachineSettingsFile {
  readonly schemaVersion: typeof MACHINE_SETTINGS_VERSION;
  readonly layerKind: typeof MACHINE_SETTINGS_LAYER_KIND;
  readonly values: Readonly<Record<string, string>>;
  readonly updatedAt: string;
}

/** Keys are emitted in catalogue order so the file is byte-stable across writes. */
function orderedValues(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const ordered: Record<string, string> = {};
  for (const key of MACHINE_SETTING_KEYS) if (Object.hasOwn(values, key)) ordered[key] = values[key]!;
  return Object.freeze(ordered);
}

export function validateMachineSettingsFile(value: unknown): MachineSettingsFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("MACHINE_SETTINGS_FILE_INVALID", "machine settings must be an object");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== MACHINE_SETTINGS_VERSION) fail("MACHINE_SETTINGS_FILE_INVALID", `machine settings schemaVersion must be ${MACHINE_SETTINGS_VERSION}`);
  if (record.layerKind !== MACHINE_SETTINGS_LAYER_KIND) fail("MACHINE_SETTINGS_FILE_INVALID", `machine settings layerKind must be ${MACHINE_SETTINGS_LAYER_KIND}`);
  if (typeof record.updatedAt !== "string" || record.updatedAt.length === 0) fail("MACHINE_SETTINGS_FILE_INVALID", "machine settings need an updatedAt");
  const values = record.values;
  if (values === null || typeof values !== "object" || Array.isArray(values)) fail("MACHINE_SETTINGS_FILE_INVALID", "machine settings values must be an object");
  const validated: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
    assertMachineSettingKey(key);
    validated[key] = validateMachineSettingValue(key, raw);
  }
  return Object.freeze({
    schemaVersion: MACHINE_SETTINGS_VERSION,
    layerKind: MACHINE_SETTINGS_LAYER_KIND,
    values: orderedValues(validated),
    updatedAt: record.updatedAt,
  });
}

const EMPTY = (updatedAt: string): MachineSettingsFile => Object.freeze({
  schemaVersion: MACHINE_SETTINGS_VERSION,
  layerKind: MACHINE_SETTINGS_LAYER_KIND,
  values: Object.freeze({}),
  updatedAt,
});

/**
 * An absent file is not an error: a machine that has never set a preference is the
 * ordinary case, and the reading side wants an empty answer rather than a thrown one.
 * A file that exists but does not parse IS an error — silently treating corruption as
 * "no preferences" would hide the difference between "nothing chosen" and "what you
 * chose is unreadable".
 */
export async function readMachineSettings(path: string = machineSettingsPath()): Promise<MachineSettingsFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return EMPTY("1970-01-01T00:00:00Z");
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail("MACHINE_SETTINGS_FILE_INVALID", `${path} is not JSON`); }
  return validateMachineSettingsFile(parsed);
}

async function write(path: string, file: MachineSettingsFile): Promise<MachineSettingsFile> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${canonicalJson(file)}\n`, "utf8");
  return file;
}

export async function applyMachineSettingSet(input: {
  readonly key: string;
  readonly value: unknown;
  readonly occurredAt: string;
  readonly path?: string;
}): Promise<MachineSettingsFile> {
  assertMachineSettingKey(input.key);
  const value = validateMachineSettingValue(input.key, input.value);
  const path = input.path ?? machineSettingsPath();
  const current = await readMachineSettings(path);
  return write(path, Object.freeze({
    schemaVersion: MACHINE_SETTINGS_VERSION,
    layerKind: MACHINE_SETTINGS_LAYER_KIND,
    values: orderedValues({ ...current.values, [input.key]: value }),
    updatedAt: input.occurredAt,
  }));
}

/**
 * Removing a key that is not set refuses rather than succeeding quietly, matching the
 * governed layer: a remove that changes nothing is a caller mistake, and reporting it
 * lets the caller notice it asked for the wrong key. Callers that mean "make sure this
 * is unset" check `readMachineSettings` first — the portal does exactly that.
 */
export async function applyMachineSettingRemove(input: {
  readonly key: string;
  readonly occurredAt: string;
  readonly path?: string;
}): Promise<MachineSettingsFile> {
  assertMachineSettingKey(input.key);
  const path = input.path ?? machineSettingsPath();
  const current = await readMachineSettings(path);
  if (!Object.hasOwn(current.values, input.key)) fail("MACHINE_SETTING_NOT_SET", `machine setting ${input.key} is not set`);
  const values = { ...current.values };
  delete values[input.key];
  const next = Object.freeze({
    schemaVersion: MACHINE_SETTINGS_VERSION,
    layerKind: MACHINE_SETTINGS_LAYER_KIND,
    values: orderedValues(values),
    updatedAt: input.occurredAt,
  });
  // The file is removed once nothing is set, so an untouched machine leaves no trace
  // and a fresh read takes the same absent-file path it would have taken before.
  if (Object.keys(next.values).length === 0) {
    await rm(path, { force: true });
    return next;
  }
  return write(path, next);
}

export interface MachineSettingsReadback {
  readonly schemaVersion: typeof MACHINE_SETTINGS_VERSION;
  readonly layerKind: typeof MACHINE_SETTINGS_LAYER_KIND;
  readonly path: string;
  readonly settings: readonly (MachineSettingsCatalogEntry & { readonly currentValue: string | null })[];
  readonly updatedAt: string;
}

export async function readMachineSettingsCatalog(path: string = machineSettingsPath()): Promise<MachineSettingsReadback> {
  const file = await readMachineSettings(path);
  return Object.freeze({
    schemaVersion: MACHINE_SETTINGS_VERSION,
    layerKind: MACHINE_SETTINGS_LAYER_KIND,
    path,
    settings: Object.freeze(MACHINE_SETTINGS_CATALOG.map((entry) => Object.freeze({
      ...entry,
      currentValue: Object.hasOwn(file.values, entry.key) ? file.values[entry.key]! : null,
    }))),
    updatedAt: file.updatedAt,
  });
}
