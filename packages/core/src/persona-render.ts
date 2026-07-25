// SPDX-License-Identifier: Apache-2.0

// Conference-role reference renderer. Core Reference personas are inert data used
// to attribute conference positions; they are not host-session authority profiles
// and are never injected by a SessionStart adapter. The renderer therefore emits
// an explicitly conference-scoped reference for any of the eight closed roster
// members, suitable for read-only inspection or for preparing a position whose
// actorId is that role.
//
// renderPersonaAuthoritySummary drives its digest binding through
// validateCorePersonaBundle, which transitively pins CORE_PERSONA_SOURCE_MANIFEST_SHA256
// and each profile's exact source digest. Tampering with the persona prose upstream
// therefore fails inside that validator (PERSONA_CANONICAL_INVALID for a naive edit,
// PERSONA_SOURCE_MISMATCH once the profileDigest is resealed) before this module ever
// composes text — the render is bound to the governed source for free.
//
// The 1024-byte budget is retained as a compact-reference budget. It is enforced
// fail-closed at generation time and no host hook consumes the result.

import { canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";
import {
  CORE_REFERENCE_PERSONA_IDS,
  validateCorePersonaBundle,
  type CorePersonaProfile,
} from "./core-reference-personas.js";

export const PERSONA_RENDER_VERSION = "tcrn.conference-persona-reference.v1" as const;
export const PERSONA_RENDER_BUDGET_BYTES = 1_024 as const;
export const PERSONA_RENDER_ALLOWED_PROFILE_IDS = CORE_REFERENCE_PERSONA_IDS;

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
  readonly scope: "conference_position_reference";
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
    `Conference role reference: ${profile.displayName} (${profile.jobTitle}).`,
    `Mandate boundary: ${profile.authorityBoundary}`,
    `Refuses: ${refusals}.`,
    "Use only to attribute a conference position argued from this role's mandate.",
    "This reference does not bind the main thread, make it read-only, or grant Workflow mutation or approval authority.",
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

// Compose a bounded conference reference for one member of the closed eight-role
// roster. The bundle is validated first, so the output stays digest-bound to the
// governed source rather than to caller-supplied prose.
export function renderPersonaAuthoritySummary(bundleValue: unknown, profileId: string, options: PersonaAuthorityRenderOptions = {}): PersonaAuthorityRender {
  if (typeof profileId !== "string") fail("RENDER_SCHEMA_INVALID", "profileId");
  const bundle = validateCorePersonaBundle(bundleValue);
  if (!(PERSONA_RENDER_ALLOWED_PROFILE_IDS as readonly string[]).includes(profileId)) fail("RENDER_PERSONA_NOT_ALLOWED", profileId);
  const profile = bundle.profiles.find((entry) => entry.profileId === profileId);
  if (profile === undefined) fail("RENDER_PERSONA_NOT_ALLOWED", profileId);
  const compose = options.template ?? defaultAuthorityTemplate;
  const text = compose(profile);
  if (typeof text !== "string" || !text.isWellFormed()) fail("RENDER_SCHEMA_INVALID", "text");
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > PERSONA_RENDER_BUDGET_BYTES) fail("RENDER_BUDGET_EXCEEDED", String(byteLength));
  const basis = {
    schemaVersion: PERSONA_RENDER_VERSION,
    scope: "conference_position_reference" as const,
    profileId,
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
  exactFields(document, ["schemaVersion", "scope", "profileId", "profileDigest", "bundleDigest", "text", "byteLength", "renderDigest"], "persona render");
  if (document.schemaVersion !== PERSONA_RENDER_VERSION || document.scope !== "conference_position_reference") fail("RENDER_SCHEMA_INVALID", "render header");
  if (typeof document.profileId !== "string" || !(PERSONA_RENDER_ALLOWED_PROFILE_IDS as readonly string[]).includes(document.profileId)) fail("RENDER_PERSONA_NOT_ALLOWED", String(document.profileId));
  const profileDigest = sha(document.profileDigest, "profileDigest");
  const bundleDigest = sha(document.bundleDigest, "bundleDigest");
  if (typeof document.text !== "string" || !document.text.isWellFormed()) fail("RENDER_SCHEMA_INVALID", "text");
  const byteLength = Buffer.byteLength(document.text, "utf8");
  if (typeof document.byteLength !== "number" || document.byteLength !== byteLength) fail("RENDER_SCHEMA_INVALID", "byteLength");
  if (byteLength > PERSONA_RENDER_BUDGET_BYTES) fail("RENDER_BUDGET_EXCEEDED", String(byteLength));
  const basis = {
    schemaVersion: PERSONA_RENDER_VERSION,
    scope: "conference_position_reference" as const,
    profileId: document.profileId,
    profileDigest,
    bundleDigest,
    text: document.text,
    byteLength,
  };
  if (sha(document.renderDigest, "renderDigest") !== canonicalSha256(basis)) fail("RENDER_SCHEMA_INVALID", "renderDigest");
  return deepFreeze({ ...basis, renderDigest: document.renderDigest as string });
}
