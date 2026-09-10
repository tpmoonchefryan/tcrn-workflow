// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { canonicalJson } from "../../protocol/src/index.js";

type Behaviour = Readonly<{ dispatch: boolean; verify: boolean }>;
type TierValue = Readonly<{ model: string; effort: string }>;
type Classes = Readonly<Record<string, Behaviour>>;
type Tiers = Readonly<Record<string, Readonly<Record<string, TierValue | null>>>>;
type Modes = Readonly<Record<string, Readonly<Record<string, string>>>>;
type Setting = Readonly<{ key: string; value: string }>;

interface DispatchConfig {
  readonly classes: Classes;
  readonly tiers: Tiers;
  readonly modes: Modes;
  readonly mode: string;
}

function fail(reasonCode: string, message: string): never {
  throw Object.assign(new Error(message), { reasonCode });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("DISPATCH_CONFIG_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function name(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    fail("DISPATCH_CONFIG_INVALID", `${label} must be a non-empty string`);
  }
  canonicalJson(value);
  return value;
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function exact(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  if (canonicalJson(actual) !== canonicalJson([...keys].sort())) {
    fail("DISPATCH_CONFIG_INVALID", `${label} requires exactly ${keys.join(", ")}`);
  }
}

const document = object(
  JSON.parse(readFileSync(new URL("../data/dispatch-defaults.json", import.meta.url), "utf8")),
  "dispatch defaults",
);
const orderValue = document.tierOrder;
if (!Array.isArray(orderValue) || orderValue.length !== 3) {
  fail("DISPATCH_CONFIG_INVALID", "dispatch defaults require three ordered tiers");
}
const tierOrder: readonly string[] = Object.freeze(
  orderValue.map((value) => name(value, "tier")),
);
if (new Set(tierOrder).size !== tierOrder.length) {
  fail("DISPATCH_CONFIG_INVALID", "dispatch default tiers must be distinct");
}

function classes(value: unknown): Classes {
  return Object.fromEntries(Object.entries(object(value, "classes")).map(([key, raw]) => {
    name(key, "class");
    const entry = object(raw, `class ${key}`);
    if (typeof entry.dispatch !== "boolean" || typeof entry.verify !== "boolean") {
      fail(
        "DISPATCH_CLASS_BEHAVIOUR_REQUIRED",
        `class ${key} requires both boolean behaviour bits: dispatch and verify`,
      );
    }
    exact(entry, ["dispatch", "verify"], `class ${key}`);
    return [key, { dispatch: entry.dispatch, verify: entry.verify }];
  }));
}

function row(value: unknown, label: string): TierValue | null {
  if (value === null) return null;
  const entry = object(value, label);
  exact(entry, ["model", "effort"], label);
  if (typeof entry.model !== "string" || typeof entry.effort !== "string") {
    fail("DISPATCH_CONFIG_INVALID", `${label} requires string model and effort`);
  }
  canonicalJson(entry);
  return { model: entry.model, effort: entry.effort };
}

function hostTiers(value: unknown, host: string): Readonly<Record<string, TierValue | null>> {
  const entries = object(value, `tiers for ${host}`);
  for (const key of Object.keys(entries)) {
    if (!tierOrder.includes(key)) {
      fail("DISPATCH_CONFIG_INVALID", `unknown tier ${key}; expected ${tierOrder.join(", ")}`);
    }
  }
  return Object.fromEntries(tierOrder.map((tier) => [
    tier,
    Object.hasOwn(entries, tier) ? row(entries[tier], `${host}/${tier}`) : null,
  ]));
}

function tiers(value: unknown): Tiers {
  return Object.fromEntries(Object.entries(object(value, "tiers")).map(([host, entries]) => [
    name(host, "host"),
    hostTiers(entries, host),
  ]));
}

function mapping(value: unknown): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(object(value, "mode mapping")).map(([key, value]) => {
    name(key, "class");
    if (typeof value !== "string" || !tierOrder.includes(value)) {
      fail("DISPATCH_CONFIG_INVALID", `class ${key} must reference ${tierOrder.join(", ")}`);
    }
    return [key, value];
  }));
}

function modes(value: unknown): Modes {
  return Object.fromEntries(Object.entries(object(value, "modes")).map(([key, value]) => [
    name(key, "mode"),
    mapping(value),
  ]));
}

const defaultClasses = classes(document.classes);
const defaultModes = modes(document.modes);
const defaultMode = name(document.mode, "default mode");

function parse(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fail("DISPATCH_CONFIG_INVALID", `${label} must contain JSON`);
  }
}

export function dispatchSettingDefault(key: string): string {
  if (key === "execution.dispatchClasses") return canonicalJson(defaultClasses);
  if (key === "execution.dispatchTiers") return "{}";
  if (key === "execution.dispatchModes") return canonicalJson(defaultModes);
  if (key === "execution.dispatchMode") return defaultMode;
  return fail("DISPATCH_CONFIG_INVALID", `unknown dispatch setting ${key}`);
}

export function validateDispatchSetting(key: string, value: string): void {
  if (key === "execution.dispatchMode") {
    name(value, "mode");
    return;
  }
  const parsed = parse(value, key);
  if (key === "execution.dispatchClasses") {
    classes(parsed);
  } else if (key === "execution.dispatchTiers") {
    tiers(parsed);
  } else if (key === "execution.dispatchModes") {
    modes(parsed);
  } else {
    fail("DISPATCH_CONFIG_INVALID", `unknown dispatch setting ${key}`);
  }
}

export function readDispatchConfig(settings: readonly Setting[]): DispatchConfig {
  const value = (key: string): string =>
    settings.find((entry) => entry.key === key)?.value ?? dispatchSettingDefault(key);
  return {
    classes: classes(parse(value("execution.dispatchClasses"), "classes")),
    tiers: tiers(parse(value("execution.dispatchTiers"), "tiers")),
    modes: modes(parse(value("execution.dispatchModes"), "modes")),
    mode: name(value("execution.dispatchMode"), "mode"),
  };
}

export function dispatchSettingUpdate(
  settings: readonly Setting[],
  kind: "classes" | "tiers" | "mode",
  key: string,
  value: unknown,
): Readonly<{ key: string; value: string }> {
  const current = readDispatchConfig(settings);
  if (kind === "classes") {
    return {
      key: "execution.dispatchClasses",
      value: canonicalJson({ ...current.classes, ...classes(value) }),
    };
  }
  if (kind === "tiers") {
    const host = name(key, "host");
    return {
      key: "execution.dispatchTiers",
      value: canonicalJson({ ...current.tiers, [host]: hostTiers(value, host) }),
    };
  }
  const mode = name(key, "mode");
  return {
    key: "execution.dispatchModes",
    value: canonicalJson({
      ...current.modes,
      [mode]: { ...(own(current.modes, mode) ?? {}), ...mapping(value) },
    }),
  };
}

export function resolveDispatch(
  config: DispatchConfig,
  host: string,
  taskClass: string,
  mode = config.mode,
): Readonly<{
  taskClass: string;
  host: string;
  mode: string;
  dispatch: boolean;
  verify: boolean;
  requestedTier: string;
  resolvedTier: string | null;
  value: TierValue | null;
}> {
  name(host, "host");
  const behaviour = own(config.classes, taskClass);
  if (behaviour === undefined) {
    fail("DISPATCH_CLASS_UNKNOWN", `unknown class ${taskClass}`);
  }
  const selected = own(config.modes, mode);
  if (selected === undefined) {
    fail("DISPATCH_MODE_UNKNOWN", `unknown mode ${mode}`);
  }
  const requestedTier = own(selected, taskClass);
  if (requestedTier === undefined) {
    fail("DISPATCH_MAPPING_MISSING", `mode ${mode} has no mapping for ${taskClass}`);
  }
  const start = tierOrder.indexOf(requestedTier);
  if (start < 0) {
    fail("DISPATCH_CONFIG_INVALID", `unknown tier ${requestedTier}`);
  }
  const hostRows = own(config.tiers, host);
  for (const tier of tierOrder.slice(start)) {
    const value = hostRows === undefined ? undefined : own(hostRows, tier);
    if (value !== undefined && value !== null && value.model.length > 0) {
      return {
        taskClass, host, mode, ...behaviour, requestedTier,
        resolvedTier: tier, value,
      };
    }
  }
  return {
    taskClass, host, mode, ...behaviour, requestedTier,
    resolvedTier: null, value: null,
  };
}
