// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-214: the adapter baseline is a small, host-neutral
// reconciliation surface.  It names the three product-owned obligations without
// taking ownership of arbitrary user hooks.  The stop-pact entry is deliberately
// an explicit exemption: its current user-level wiring needs an Owner decision
// before an implementation-time placement can be chosen.

import { canonicalJson, canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";
import { OBSERVE_HOOK_EVENTS } from "./receipt-sidecar.js";

export const ADAPTER_BASELINE_VERSION = "tcrn.adapter-baseline.v1" as const;

export const ADAPTER_BASELINE_ENTRY_IDS = Object.freeze([
  "session-start-governance",
  "observe-collection",
  "stop-pact-stop-gate",
] as const);

export type AdapterBaselineEntryId = typeof ADAPTER_BASELINE_ENTRY_IDS[number];
export type AdapterBaselineInstallationState = "installed" | "exempted";
export type AdapterBaselineOwner = "tcrn" | "user";
export type AdapterBaselineDriftCheck =
  | "receipt-and-handler-digest"
  | "handler-and-manifest-digest"
  | "independent-readonly";

export interface AdapterBaselineEntry {
  readonly id: AdapterBaselineEntryId;
  readonly surface: "session-start" | "observe" | "stop-pact";
  readonly installationState: AdapterBaselineInstallationState;
  readonly owner: AdapterBaselineOwner;
  readonly summary: string;
  readonly events: readonly string[];
  readonly driftCheck: AdapterBaselineDriftCheck;
}

export interface AdapterBaseline {
  readonly schemaVersion: typeof ADAPTER_BASELINE_VERSION;
  readonly entries: readonly AdapterBaselineEntry[];
  readonly manifestDigest: string;
}

export const ADAPTER_BASELINE_REASON_CODES = Object.freeze([
  "ADAPTER_BASELINE_INVALID",
  "ADAPTER_BASELINE_MISSING",
  "ADAPTER_BASELINE_DIGEST_MISMATCH",
  "ADAPTER_USER_ZONE_IGNORED",
] as const);
export type AdapterBaselineReasonCode = typeof ADAPTER_BASELINE_REASON_CODES[number];

export class AdapterBaselineError extends Error {
  readonly reasonCode: AdapterBaselineReasonCode;

  constructor(reasonCode: AdapterBaselineReasonCode, message: string) {
    super(message);
    this.name = "AdapterBaselineError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: AdapterBaselineReasonCode, message: string): never {
  throw new AdapterBaselineError(reasonCode, message);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("ADAPTER_BASELINE_INVALID", label);
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const expected = [...fields].sort(compareCanonicalText);
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("ADAPTER_BASELINE_INVALID", label);
  }
}

function text(value: unknown, label: string, maximumBytes = 2_048): string {
  if (typeof value !== "string" || !value.isWellFormed() || Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail("ADAPTER_BASELINE_INVALID", label);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("ADAPTER_BASELINE_INVALID", label);
  return value;
}

function defaultEntries(): readonly AdapterBaselineEntry[] {
  return Object.freeze([
    {
      id: "session-start-governance",
      surface: "session-start",
      installationState: "installed",
      owner: "tcrn",
      summary: "SessionStart installs the bounded governance summary and keeps operation authority unavailable until live governed activation.",
      events: ["SessionStart"],
      driftCheck: "receipt-and-handler-digest",
    },
    {
      id: "observe-collection",
      surface: "observe",
      installationState: "installed",
      owner: "tcrn",
      summary: "The observe installer registers the six enumerated fail-open collection events and binds the handler to the project manifest digest.",
      events: [...OBSERVE_HOOK_EVENTS].sort(compareCanonicalText),
      driftCheck: "handler-and-manifest-digest",
    },
    {
      id: "stop-pact-stop-gate",
      surface: "stop-pact",
      installationState: "exempted",
      owner: "user",
      summary: "Current stop-pact wiring remains outside the adapter-owned installation zone; placement is an implementation-time design choice requiring Owner acceptance and an independent read-only drift check.",
      events: ["Stop"],
      driftCheck: "independent-readonly",
    },
  ] as const);
}

export function createAdapterBaseline(): AdapterBaseline {
  const basis = {
    schemaVersion: ADAPTER_BASELINE_VERSION,
    entries: [...defaultEntries()].sort((left, right) => compareCanonicalText(left.id, right.id)),
  };
  return Object.freeze({ ...basis, manifestDigest: canonicalSha256(basis) });
}

function validateEntry(value: unknown, index: number): AdapterBaselineEntry {
  const document = record(value, `baseline entries[${index}]`);
  exact(document, ["id", "surface", "installationState", "owner", "summary", "events", "driftCheck"], `baseline entries[${index}]`);
  if (!(ADAPTER_BASELINE_ENTRY_IDS as readonly string[]).includes(document.id as string)) fail("ADAPTER_BASELINE_INVALID", `baseline entries[${index}].id`);
  if (!["session-start", "observe", "stop-pact"].includes(document.surface as string)) fail("ADAPTER_BASELINE_INVALID", `baseline entries[${index}].surface`);
  if (!["installed", "exempted"].includes(document.installationState as string)) fail("ADAPTER_BASELINE_INVALID", `baseline entries[${index}].installationState`);
  if (!["tcrn", "user"].includes(document.owner as string)) fail("ADAPTER_BASELINE_INVALID", `baseline entries[${index}].owner`);
  if (!["receipt-and-handler-digest", "handler-and-manifest-digest", "independent-readonly"].includes(document.driftCheck as string)) fail("ADAPTER_BASELINE_INVALID", `baseline entries[${index}].driftCheck`);
  const events = document.events;
  if (!Array.isArray(events) || events.length === 0 || events.some((event) => typeof event !== "string" || !event.isWellFormed()) || new Set(events).size !== events.length) fail("ADAPTER_BASELINE_INVALID", `baseline entries[${index}].events`);
  return {
    id: document.id as AdapterBaselineEntryId,
    surface: document.surface as AdapterBaselineEntry["surface"],
    installationState: document.installationState as AdapterBaselineInstallationState,
    owner: document.owner as AdapterBaselineOwner,
    summary: text(document.summary, `baseline entries[${index}].summary`),
    events: Object.freeze([...events as string[]].sort(compareCanonicalText)),
    driftCheck: document.driftCheck as AdapterBaselineDriftCheck,
  };
}

export function validateAdapterBaseline(value: unknown): AdapterBaseline {
  const document = record(value, "adapter baseline");
  exact(document, ["schemaVersion", "entries", "manifestDigest"], "adapter baseline");
  if (document.schemaVersion !== ADAPTER_BASELINE_VERSION || !Array.isArray(document.entries)) fail("ADAPTER_BASELINE_INVALID", "adapter baseline header");
  const entries = document.entries.map(validateEntry);
  const ids = entries.map((entry) => entry.id);
  for (const id of ADAPTER_BASELINE_ENTRY_IDS) if (!ids.includes(id)) fail("ADAPTER_BASELINE_MISSING", id);
  if (new Set(ids).size !== ids.length || entries.length !== ADAPTER_BASELINE_ENTRY_IDS.length) fail("ADAPTER_BASELINE_INVALID", "adapter baseline entry set");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const session = byId.get("session-start-governance");
  const observe = byId.get("observe-collection");
  const stopPact = byId.get("stop-pact-stop-gate");
  if (session?.installationState !== "installed" || session.owner !== "tcrn" || session.surface !== "session-start") fail("ADAPTER_BASELINE_INVALID", "session-start baseline contract");
  if (observe?.installationState !== "installed" || observe.owner !== "tcrn" || observe.surface !== "observe" || observe.events.length !== OBSERVE_HOOK_EVENTS.length || observe.events.some((event, index) => event !== [...OBSERVE_HOOK_EVENTS].sort(compareCanonicalText)[index])) fail("ADAPTER_BASELINE_INVALID", "observe baseline contract");
  if (stopPact?.installationState !== "exempted" || stopPact.owner !== "user" || stopPact.surface !== "stop-pact" || stopPact.driftCheck !== "independent-readonly") fail("ADAPTER_BASELINE_INVALID", "stop-pact exemption contract");
  const normalizedEntries = [...entries].sort((left, right) => compareCanonicalText(left.id, right.id));
  const basis = { schemaVersion: ADAPTER_BASELINE_VERSION, entries: normalizedEntries };
  const manifestDigest = digest(document.manifestDigest, "adapter baseline manifestDigest");
  if (manifestDigest !== canonicalSha256(basis)) fail("ADAPTER_BASELINE_DIGEST_MISMATCH", "adapter baseline manifestDigest");
  return Object.freeze({ ...basis, manifestDigest });
}

export interface AdapterUserZoneValidation {
  readonly zone: "user";
  readonly findings: readonly [];
  readonly resultUnaffected: true;
}

// The settings argument is deliberately opaque. Parsing or enumerating it would
// make an arbitrary user hook part of the TCRN validation domain. The adapter only
// validates its own project-local fragment during merge/remove operations.
export function validateAdapterUserZone(_settingsText?: unknown): AdapterUserZoneValidation {
  return Object.freeze({
    zone: "user",
    findings: Object.freeze([]) as readonly [],
    resultUnaffected: true as const,
  });
}

export interface AdapterSurfaceValidation {
  readonly reasonCode: "ADAPTER_VALIDATED";
  readonly bundleDigest: string;
  readonly activation: false;
  readonly baselineDigest: string;
  readonly baselineState: "complete";
  readonly userZone: AdapterUserZoneValidation;
}

export function validateAdapterSurface(bundleDigestValue: unknown, baselineValue: unknown, settingsText?: unknown): AdapterSurfaceValidation {
  const bundleDigest = digest(bundleDigestValue, "bundleDigest");
  const baseline = validateAdapterBaseline(baselineValue);
  return Object.freeze({
    reasonCode: "ADAPTER_VALIDATED" as const,
    bundleDigest,
    activation: false as const,
    baselineDigest: baseline.manifestDigest,
    baselineState: "complete" as const,
    userZone: validateAdapterUserZone(settingsText),
  });
}

export function adapterBaselineJson(): string {
  return canonicalJson(createAdapterBaseline());
}
