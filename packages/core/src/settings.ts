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
export type SettingControlType = "enum" | "boolean" | "number" | "text";

export type SettingKey =
  | "backup.cadence"
  | "backup.destination"
  | "driver.capabilityProfile"
  | "engine.requiredVersion"
  | "execution.claudeCodeSubagentPlan"
  | "execution.codexSubagentPlan"
  | "execution.independenceFloor"
  | "execution.maxConcurrentSubagents"
  | "execution.maxDispatchDepth"
  | "execution.personalessDispatch"
  | "execution.subagentPolicy"
  | "workspace.generatedArtifactsPath";

export interface SettingsCatalogEntry {
  readonly key: SettingKey;
  readonly type: SettingValueType;
  readonly controlType: SettingControlType;
  readonly layerKind: typeof SETTINGS_LAYER_KIND;
  readonly defaultValue: string | null;
  readonly allowedValues?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly trueValue?: string;
  readonly falseValue?: string;
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
    readonly controlType: SettingControlType;
      readonly layer: typeof SETTINGS_LAYER_KIND;
      readonly defaultValue: string | null;
      readonly currentValue: string | null;
      readonly allowedValues?: readonly string[];
      readonly min?: number;
      readonly max?: number;
      readonly trueValue?: string;
      readonly falseValue?: string;
    }[];
}

export class SettingsError extends Error {
  readonly reasonCode: SettingsReasonCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(reasonCode: SettingsReasonCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "SettingsError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: SettingsReasonCode, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new SettingsError(reasonCode, message, details);
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
    controlType: "enum",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "gate-close",
    allowedValues: ["gate-close", "session-end", "manual"],
  },
  {
    key: "backup.destination",
    type: "path",
    controlType: "text",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: null,
  },
  {
    key: "driver.capabilityProfile",
    type: "string",
    controlType: "text",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "default",
  },
  {
    key: "engine.requiredVersion",
    type: "string",
    controlType: "text",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: null,
  },
  {
    key: "execution.claudeCodeSubagentPlan",
    type: "string",
    controlType: "enum",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: null,
  },
  {
    key: "execution.codexSubagentPlan",
    type: "string",
    controlType: "enum",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: null,
  },
  {
    // INIT-026 S233/S234. Unlike its sibling above, this one IS enforced: when the
    // floor covers a conference's type, conference-close refuses without an
    // execution-form declaration of "independent". The deliberation convention's
    // "undeclared reads as unverified" grows teeth exactly where the floor says so.
    key: "execution.independenceFloor",
    type: "enum",
    controlType: "enum",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "none",
    allowedValues: ["none", "verification", "verification-and-risk", "all"],
  },
  {
    // INIT-027 S239. These orchestration controls are strings on the governed
    // surface so they remain compatible with the existing settings/profile
    // transport; their numeric domains are enforced below.
    key: "execution.maxConcurrentSubagents",
    type: "string",
    controlType: "number",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "8",
    min: 1,
    max: 32,
  },
  {
    key: "execution.maxDispatchDepth",
    type: "string",
    controlType: "number",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "1",
    min: 1,
    max: 4,
  },
  {
    key: "execution.personalessDispatch",
    type: "enum",
    controlType: "boolean",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "allowed",
    allowedValues: ["allowed", "forbidden"],
    trueValue: "allowed",
    falseValue: "forbidden",
  },
  {
    // INIT-026 S233. Declarative, like backup.cadence: the engine never sees a
    // subagent, so this states the workspace's policy for hosts to honour rather
    // than something the engine can enforce.
    key: "execution.subagentPolicy",
    type: "enum",
    controlType: "enum",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "allowed",
    allowedValues: ["allowed", "review-only", "forbidden"],
  },
  {
    key: "workspace.generatedArtifactsPath",
    type: "path",
    controlType: "text",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: ".tcrn-workflow/artifacts",
  },
];

export const SETTINGS_CATALOG: readonly SettingsCatalogEntry[] = Object.freeze(
  catalogEntries.slice().sort((left, right) => compareCanonicalText(left.key, right.key)).map((entry) => Object.freeze({
    ...entry,
    ...(entry.allowedValues === undefined ? {} : { allowedValues: Object.freeze([...entry.allowedValues]) }),
  })),
);

const catalogByKey = new Map<SettingKey, SettingsCatalogEntry>(
  SETTINGS_CATALOG.map((entry) => [entry.key, entry]),
);

const engineVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function engineVersionParts(value: string): readonly [number, number, number] {
  const match = engineVersionPattern.exec(value);
  if (match === null) {
    fail("SETTINGS_VALUE_INVALID", "engine.requiredVersion must be a stable semantic version");
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function orchestrationInteger(value: string, key: SettingKey): void {
  const maximum = key === "execution.maxConcurrentSubagents" ? 32 : 4;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || Number(value) < 1 || Number(value) > maximum) {
    fail("SETTINGS_VALUE_INVALID", `${key} must be a decimal integer from 1 to ${maximum}`);
  }
}

/** Compare two validated engine versions using release precedence only. */
export function compareEngineVersions(left: string, right: string): number {
  const leftParts = engineVersionParts(left);
  const rightParts = engineVersionParts(right);
  for (const [index, leftPart] of leftParts.entries()) {
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

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
    fail(
      "SETTINGS_VALUE_INVALID",
      `${entry.key} is outside its closed enum; allowed values: ${entry.allowedValues?.join(", ") ?? "none"}`,
      { allowedValues: entry.allowedValues ?? [] },
    );
  }
  if (entry.key === "engine.requiredVersion") {
    engineVersionParts(value);
  }
  if (entry.key === "execution.maxConcurrentSubagents" || entry.key === "execution.maxDispatchDepth") {
    orchestrationInteger(value, entry.key);
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
      controlType: entry.controlType,
      layer: entry.layerKind,
      defaultValue: entry.defaultValue,
      currentValue: records.find((record) => record.key === entry.key)?.value ?? entry.defaultValue,
      ...(entry.allowedValues === undefined ? {} : { allowedValues: entry.allowedValues }),
      ...(entry.min === undefined ? {} : { min: entry.min }),
      ...(entry.max === undefined ? {} : { max: entry.max }),
      ...(entry.trueValue === undefined ? {} : { trueValue: entry.trueValue }),
      ...(entry.falseValue === undefined ? {} : { falseValue: entry.falseValue }),
    })),
  };
}
