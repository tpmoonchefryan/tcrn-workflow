// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, relative, resolve, sep } from "node:path";

import { assertStrictInstant, canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";

/**
 * Settings are a deliberately small engine-owned overlay surface. The generic
 * profile remains the authority for layer semantics; this module owns the
 * bounded vocabulary that the workspace can actually consume.
 */
export const SETTINGS_CATALOG_VERSION = "tcrn.settings-catalog.v1" as const;
export const WORKSPACE_SETTING_VERSION = "tcrn.workspace-setting.v1" as const;
export const SETTINGS_LAYER_KIND = "workspace_configuration" as const;

export const SETTINGS_REASON_CODES = Object.freeze([
  "SETTINGS_KEY_UNREGISTERED",
  "SETTINGS_RECORD_INVALID",
  "SETTINGS_VALUE_INVALID",
] as const);

export type SettingsReasonCode = typeof SETTINGS_REASON_CODES[number];
export type SettingValueType = "enum" | "path" | "string";

export type SettingKey =
  | "backup.cadence"
  | "backup.destination"
  | "driver.capabilityProfile"
  | "workspace.generatedArtifactsPath";

export interface SettingsCatalogEntry {
  readonly key: SettingKey;
  readonly type: SettingValueType;
  readonly layerKind: typeof SETTINGS_LAYER_KIND;
  readonly defaultValue: string | null;
  readonly allowedValues?: readonly string[];
}

export interface WorkspaceSettingRecord {
  readonly schemaVersion: typeof WORKSPACE_SETTING_VERSION;
  readonly key: SettingKey;
  readonly layerKind: typeof SETTINGS_LAYER_KIND;
  readonly value: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: false;
}

export interface SettingsCatalogReadback {
  readonly schemaVersion: typeof SETTINGS_CATALOG_VERSION;
  readonly layerKind: typeof SETTINGS_LAYER_KIND;
  readonly workspaceId: string;
  readonly settings: readonly {
    readonly key: SettingKey;
    readonly type: SettingValueType;
    readonly layer: typeof SETTINGS_LAYER_KIND;
    readonly defaultValue: string | null;
    readonly currentValue: string | null;
  }[];
}

export class SettingsError extends Error {
  readonly reasonCode: SettingsReasonCode;

  constructor(reasonCode: SettingsReasonCode, message: string) {
    super(message);
    this.name = "SettingsError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: SettingsReasonCode, message: string): never {
  throw new SettingsError(reasonCode, message);
}

function isInside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
}

function assertCanonicalString(value: unknown, label: string, maximumLength: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength || value.includes("\u0000")) {
    fail("SETTINGS_VALUE_INVALID", `${label} must be a non-empty bounded string`);
  }
  try {
    canonicalJson(value);
  } catch {
    fail("SETTINGS_VALUE_INVALID", `${label} is not canonical JSON`);
  }
}

function assertWorkspaceRelativeSettingPath(value: string, label: string): void {
  if (isAbsolute(value) || value.includes("\\")) {
    fail("SETTINGS_VALUE_INVALID", `${label} must be a workspace-relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("SETTINGS_VALUE_INVALID", `${label} must not escape its workspace`);
  }
}

const catalogEntries: readonly SettingsCatalogEntry[] = [
  {
    key: "backup.cadence",
    type: "enum",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "gate-close",
    allowedValues: ["gate-close", "session-end", "manual"],
  },
  {
    key: "backup.destination",
    type: "path",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: null,
  },
  {
    key: "driver.capabilityProfile",
    type: "string",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "default",
  },
  {
    key: "workspace.generatedArtifactsPath",
    type: "path",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: ".tcrn-workflow/artifacts",
  },
];

export const SETTINGS_CATALOG: readonly SettingsCatalogEntry[] = Object.freeze(
  catalogEntries.map((entry) => Object.freeze({
    ...entry,
    ...(entry.allowedValues === undefined ? {} : { allowedValues: Object.freeze([...entry.allowedValues]) }),
  })),
);

const catalogByKey = new Map<SettingKey, SettingsCatalogEntry>(
  SETTINGS_CATALOG.map((entry) => [entry.key, entry]),
);

export function settingsCatalogEntry(key: unknown): SettingsCatalogEntry {
  if (typeof key !== "string") {
    fail("SETTINGS_KEY_UNREGISTERED", String(key));
  }
  const entry = catalogByKey.get(key as SettingKey);
  if (entry === undefined) {
    fail("SETTINGS_KEY_UNREGISTERED", key);
  }
  return entry;
}

export function validateSettingValue(key: unknown, value: unknown, workspaceRoot?: string): string {
  const entry = settingsCatalogEntry(key);
  assertCanonicalString(value, String(key), entry.key === "driver.capabilityProfile" ? 128 : 4096);
  if (entry.type === "enum" && !entry.allowedValues?.includes(value)) {
    fail("SETTINGS_VALUE_INVALID", `${entry.key} is outside its closed enum`);
  }
  if (entry.key === "workspace.generatedArtifactsPath") {
    assertWorkspaceRelativeSettingPath(value, entry.key);
  }
  if (entry.key === "backup.destination") {
    if (!isAbsolute(value)) {
      fail("SETTINGS_VALUE_INVALID", `${entry.key} must be an absolute path`);
    }
    if (workspaceRoot !== undefined) {
      const workspace = resolve(workspaceRoot);
      const destination = resolve(value);
      if (isInside(workspace, destination) || isInside(resolve(workspace, ".tcrn-workflow"), destination)) {
        fail("SETTINGS_VALUE_INVALID", `${entry.key} must be outside the workspace and its control tree`);
      }
    }
  }
  return value;
}

export function validateWorkspaceSettingRecord(value: unknown, workspaceRoot?: string): WorkspaceSettingRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("SETTINGS_RECORD_INVALID", "setting record must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = ["key", "layerKind", "revision", "schemaVersion", "tombstone", "updatedAt", "value"];
  const actual = Object.keys(record).sort(compareCanonicalText);
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort(compareCanonicalText))) {
    fail("SETTINGS_RECORD_INVALID", "setting record fields are not exact");
  }
  const entry = settingsCatalogEntry(record.key);
  if (record.schemaVersion !== WORKSPACE_SETTING_VERSION || record.layerKind !== SETTINGS_LAYER_KIND ||
    record.tombstone !== false || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1) {
    fail("SETTINGS_RECORD_INVALID", `${entry.key} record envelope is invalid`);
  }
  try {
    assertStrictInstant(record.updatedAt);
  } catch {
    fail("SETTINGS_RECORD_INVALID", `${entry.key} updatedAt is invalid`);
  }
  validateSettingValue(entry.key, record.value, workspaceRoot);
  return record as unknown as WorkspaceSettingRecord;
}

export function createWorkspaceSettingRecord(
  key: unknown,
  value: unknown,
  revision: number,
  updatedAt: string,
  workspaceRoot?: string,
): WorkspaceSettingRecord {
  const entry = settingsCatalogEntry(key);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail("SETTINGS_RECORD_INVALID", `${entry.key} revision is invalid`);
  }
  try {
    assertStrictInstant(updatedAt);
  } catch {
    fail("SETTINGS_RECORD_INVALID", `${entry.key} updatedAt is invalid`);
  }
  const normalizedValue = validateSettingValue(entry.key, value, workspaceRoot);
  return validateWorkspaceSettingRecord({
    schemaVersion: WORKSPACE_SETTING_VERSION,
    key: entry.key,
    layerKind: SETTINGS_LAYER_KIND,
    value: normalizedValue,
    revision,
    updatedAt,
    tombstone: false,
  }, workspaceRoot);
}

export function sortWorkspaceSettings(records: Iterable<WorkspaceSettingRecord>): readonly WorkspaceSettingRecord[] {
  return [...records].sort((left, right) => compareCanonicalText(left.key, right.key));
}

export function readSettingsCatalog(
  workspaceId: string,
  records: readonly WorkspaceSettingRecord[],
): SettingsCatalogReadback {
  return {
    schemaVersion: SETTINGS_CATALOG_VERSION,
    layerKind: SETTINGS_LAYER_KIND,
    workspaceId,
    settings: SETTINGS_CATALOG.map((entry) => ({
      key: entry.key,
      type: entry.type,
      layer: entry.layerKind,
      defaultValue: entry.defaultValue,
      currentValue: records.find((record) => record.key === entry.key)?.value ?? entry.defaultValue,
    })),
  };
}
