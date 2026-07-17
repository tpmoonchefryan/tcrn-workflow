// SPDX-License-Identifier: Apache-2.0

// WSG-4 Step-3 persona-to-prompt renderer (activation ladder v1, Step 3;
// docs/activation/activation-ladder-v1.md). Step 3 renders exactly ONE advisory
// persona — Verity — into a bounded authority summary that the governed
// SessionStart handler (claude-adapter-session-start.ts, WSG-3) prints. Verity is
// the justified single choice: its authorityBoundary is intrinsically read-only
// ("reviews read-only and cannot mutate the reviewed basis"), so an advisory
// injection of Verity cannot even textually claim write authority. The persona
// allowlist is a CLOSED set of one (OD-34: ratified); extending it is a future
// Owner decision, not a runtime configuration surface.
//
// renderPersonaAuthoritySummary drives its digest binding through
// validateCorePersonaBundle, which transitively pins CORE_PERSONA_SOURCE_MANIFEST_SHA256
// and each profile's exact source digest. Tampering with the persona prose upstream
// therefore fails inside that validator (PERSONA_CANONICAL_INVALID for a naive edit,
// PERSONA_SOURCE_MISMATCH once the profileDigest is resealed) before this module ever
// composes text — the render is bound to the governed source for free.
//
// The byte budget matches SESSION_START_INJECTION_BUDGET_BYTES / fixedInjectionBytes
// (1024). It is enforced fail-closed HERE, at generation time: an over-budget render
// is a build failure, never a runtime surprise. The runtime handler stays fail-open
// (N-2 / OD-32) and independently re-bounds the text it reads; this module is the
// generation-time producer, not that fail-open surface.

import { canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";
import {
  validateCorePersonaBundle,
  type CorePersonaProfile,
} from "./core-reference-personas.js";

export const PERSONA_RENDER_VERSION = "tcrn.persona-authority-render.v1" as const;
export const PERSONA_RENDER_BUDGET_BYTES = 1_024 as const;
// Closed persona allowlist of exactly one member (OD-34).
export const PERSONA_RENDER_ALLOWED_PROFILE_ID = "profile:tcrn-verity-v1" as const;

export const PERSONA_RENDER_REASON_CODES = Object.freeze([
  "RENDER_BUDGET_EXCEEDED",
  "RENDER_PERSONA_NOT_ALLOWED",
  "RENDER_SCHEMA_INVALID",
] as const);
export type PersonaRenderReasonCode = typeof PERSONA_RENDER_REASON_CODES[number];

export class PersonaRenderError extends Error {
  readonly reasonCode: PersonaRenderReasonCode;
  constructor(reasonCode: PersonaRenderReasonCode, message: string) {
    super(message);
    this.name = "PersonaRenderError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: PersonaRenderReasonCode, message: string): never {
  throw new PersonaRenderError(reasonCode, message);
}

export interface PersonaAuthorityRender {
  readonly schemaVersion: typeof PERSONA_RENDER_VERSION;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly bundleDigest: string;
  readonly text: string;
  readonly byteLength: number;
  readonly renderDigest: string;
}

// The render template is governed prose over the canonical field order
// displayName, jobTitle, authorityBoundary, refusals — with NO free interpolation
// beyond the validated profile fields, whose lengths are already bounded by
// validateProfile. The optional override exists ONLY so the generation-time budget
// branch can be exercised in tests; the CLI producer never supplies it, so
// production always composes the fixed governed template below.
export interface PersonaAuthorityRenderOptions {
  readonly template?: (profile: CorePersonaProfile) => string;
}

function defaultAuthorityTemplate(profile: CorePersonaProfile): string {
  const refusals = profile.refusals.join("; ");
  return [
    `Advisory persona: ${profile.displayName} (${profile.jobTitle}).`,
    `Authority boundary: ${profile.authorityBoundary}`,
    `Refuses: ${refusals}.`,
    "This persona is read-only advisory context; it confers no authority to act, mutate, or approve.",
  ].join("\n");
}

const shaPattern = /^[a-f0-9]{64}$/u;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("RENDER_SCHEMA_INVALID", label);
  return value as Readonly<Record<string, unknown>>;
}

function exactFields(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  if (actual.length !== wanted.length || wanted.some((field, index) => field !== actual[index])) fail("RENDER_SCHEMA_INVALID", label);
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) fail("RENDER_SCHEMA_INVALID", label);
  return value;
}

// Compose the bounded advisory summary for the single allowed persona. The bundle
// is validated first (digest binding to the governed source), then the closed
// allowlist rejects every other profileId, then the governed template composes the
// text and the byte budget is enforced fail-closed.
export function renderPersonaAuthoritySummary(bundleValue: unknown, profileId: string, options: PersonaAuthorityRenderOptions = {}): PersonaAuthorityRender {
  if (typeof profileId !== "string") fail("RENDER_SCHEMA_INVALID", "profileId");
  const bundle = validateCorePersonaBundle(bundleValue);
  if (profileId !== PERSONA_RENDER_ALLOWED_PROFILE_ID) fail("RENDER_PERSONA_NOT_ALLOWED", profileId);
  const profile = bundle.profiles.find((entry) => entry.profileId === PERSONA_RENDER_ALLOWED_PROFILE_ID);
  if (profile === undefined) fail("RENDER_PERSONA_NOT_ALLOWED", profileId);
  const compose = options.template ?? defaultAuthorityTemplate;
  const text = compose(profile);
  if (typeof text !== "string" || !text.isWellFormed()) fail("RENDER_SCHEMA_INVALID", "text");
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > PERSONA_RENDER_BUDGET_BYTES) fail("RENDER_BUDGET_EXCEEDED", String(byteLength));
  const basis = {
    schemaVersion: PERSONA_RENDER_VERSION,
    profileId: PERSONA_RENDER_ALLOWED_PROFILE_ID,
    profileDigest: profile.profileDigest,
    bundleDigest: bundle.bundleDigest,
    text,
    byteLength,
  };
  return deepFreeze({ ...basis, renderDigest: canonicalSha256(basis) });
}

// Re-validate a persisted render document (the consuming script generator's input):
// exact shape, the single allowed persona, sha-shaped digests, the byte budget, and
// a self-consistent renderDigest over the canonical basis.
export function validatePersonaAuthorityRender(value: unknown): PersonaAuthorityRender {
  const document = record(value, "persona render");
  exactFields(document, ["schemaVersion", "profileId", "profileDigest", "bundleDigest", "text", "byteLength", "renderDigest"], "persona render");
  if (document.schemaVersion !== PERSONA_RENDER_VERSION) fail("RENDER_SCHEMA_INVALID", "schemaVersion");
  if (document.profileId !== PERSONA_RENDER_ALLOWED_PROFILE_ID) fail("RENDER_PERSONA_NOT_ALLOWED", String(document.profileId));
  const profileDigest = sha(document.profileDigest, "profileDigest");
  const bundleDigest = sha(document.bundleDigest, "bundleDigest");
  if (typeof document.text !== "string" || !document.text.isWellFormed()) fail("RENDER_SCHEMA_INVALID", "text");
  const byteLength = Buffer.byteLength(document.text, "utf8");
  if (typeof document.byteLength !== "number" || document.byteLength !== byteLength) fail("RENDER_SCHEMA_INVALID", "byteLength");
  if (byteLength > PERSONA_RENDER_BUDGET_BYTES) fail("RENDER_BUDGET_EXCEEDED", String(byteLength));
  const basis = {
    schemaVersion: PERSONA_RENDER_VERSION,
    profileId: PERSONA_RENDER_ALLOWED_PROFILE_ID,
    profileDigest,
    bundleDigest,
    text: document.text,
    byteLength,
  };
  if (sha(document.renderDigest, "renderDigest") !== canonicalSha256(basis)) fail("RENDER_SCHEMA_INVALID", "renderDigest");
  return deepFreeze({ ...basis, renderDigest: document.renderDigest as string });
}
