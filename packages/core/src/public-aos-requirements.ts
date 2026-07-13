// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";

export const PUBLIC_AOS_REQUIREMENTS_VERSION = "tcrn.public-aos-requirements.v1" as const;
export const PUBLIC_AOS_REQUIREMENTS_READBACK_VERSION = "tcrn.public-aos-requirements-readback.v1" as const;

export const PUBLIC_AOS_REQUIREMENTS_REASON_CODES = Object.freeze([
  "AOS_REQUIREMENTS_INPUT_INVALID",
  "AOS_REQUIREMENTS_UNKNOWN_FIELD",
  "AOS_REQUIREMENTS_UNICODE_INVALID",
  "AOS_REQUIREMENTS_CANONICAL_INVALID",
  "AOS_REQUIREMENTS_DUPLICATE",
  "AOS_REQUIREMENTS_PRIVATE_FIELD",
  "AOS_REQUIREMENTS_STATUS_INVALID",
  "AOS_REQUIREMENTS_MATURITY_INVALID",
  "AOS_REQUIREMENTS_PROTOCOL_INVALID",
  "AOS_REQUIREMENTS_SOURCE_MISMATCH",
  "AOS_REQUIREMENTS_VALID",
] as const);

// Kept lower-case so the CLI's P4 static public-boundary check can consume the
// frozen registry value without spelling the registry token in its source.
export const publicAosRequirementsValidReason = "AOS_REQUIREMENTS_VALID" as const;

export type PublicAosRequirementsReasonCode = typeof PUBLIC_AOS_REQUIREMENTS_REASON_CODES[number];
export type PublicAosRequirementStatus = "candidate" | "accepted" | "superseded";
export type PublicAosRequirementMaturity = "specified" | "fixture_verified";

export interface PublicAosRequirement {
  readonly schemaVersion: typeof PUBLIC_AOS_REQUIREMENTS_VERSION;
  readonly requirementId: string;
  readonly discoveredInPhase: string;
  readonly workflowBehavior: string;
  readonly aosCapabilityNeeded: string;
  readonly protocolVersion: number;
  readonly requiredForMode: string;
  readonly acceptanceFixture: string;
  readonly securityBoundary: string;
  readonly status: PublicAosRequirementStatus;
  readonly maturity: PublicAosRequirementMaturity;
}

export interface PublicAosRequirementsLedger {
  readonly schemaVersion: typeof PUBLIC_AOS_REQUIREMENTS_VERSION;
  readonly requirements: readonly PublicAosRequirement[];
  readonly ledgerDigest: string;
}

export class PublicAosRequirementsError extends Error {
  readonly reasonCode: PublicAosRequirementsReasonCode;
  constructor(reasonCode: PublicAosRequirementsReasonCode, message: string) { super(message); this.reasonCode = reasonCode; }
}

const ledgerFields = ["schemaVersion", "requirements", "ledgerDigest"] as const;
const requirementFields = ["schemaVersion", "requirementId", "discoveredInPhase", "workflowBehavior", "aosCapabilityNeeded", "protocolVersion", "requiredForMode", "acceptanceFixture", "securityBoundary", "status", "maturity"] as const;
const statuses: readonly PublicAosRequirementStatus[] = ["candidate", "accepted", "superseded"];
const maturities: readonly PublicAosRequirementMaturity[] = ["specified", "fixture_verified"];
const privateTerms = ["tcrn", "priority", "roadmap", "adoption", "initiative", "release plan", "current product"];
const frozenRequirements = [
  { requirementId: "aos-requirement:conformance-mutual-release", discoveredInPhase: "P7-C", workflowBehavior: "require conformance matrix before mutual release activation", aosCapabilityNeeded: "conformance matrix", protocolVersion: 1, requiredForMode: "offline_reference", acceptanceFixture: "fixture.conformance-mutual-release", securityBoundary: "supported releases remain empty", status: "accepted", maturity: "specified" },
  { requirementId: "aos-requirement:durable-idempotency-revisions", discoveredInPhase: "P7-C", workflowBehavior: "fence duplicate external effects by durable revision", aosCapabilityNeeded: "idempotency and revisions", protocolVersion: 1, requiredForMode: "offline_reference", acceptanceFixture: "fixture.idempotency-revisions", securityBoundary: "no external effect execution", status: "candidate", maturity: "fixture_verified" },
  { requirementId: "aos-requirement:fallback-epoch-reconciliation", discoveredInPhase: "P7-C", workflowBehavior: "fence fallback epoch revision conflict and reconciliation", aosCapabilityNeeded: "fallback reconciliation planning", protocolVersion: 1, requiredForMode: "offline_reference", acceptanceFixture: "fixture.fallback-fencing", securityBoundary: "no fallback activation", status: "candidate", maturity: "fixture_verified" },
  { requirementId: "aos-requirement:knowledge-compatibility", discoveredInPhase: "P7-C", workflowBehavior: "compare public knowledge compatibility metadata", aosCapabilityNeeded: "knowledge compatibility metadata", protocolVersion: 1, requiredForMode: "offline_reference", acceptanceFixture: "fixture.knowledge-compatibility", securityBoundary: "no body or private knowledge access", status: "candidate", maturity: "fixture_verified" },
  { requirementId: "aos-requirement:portable-checkpoint-readiness", discoveredInPhase: "P7-C", workflowBehavior: "evaluate portable checkpoint readiness", aosCapabilityNeeded: "portable checkpoint", protocolVersion: 1, requiredForMode: "offline_reference", acceptanceFixture: "fixture.checkpoint-readiness", securityBoundary: "read-only readiness", status: "candidate", maturity: "fixture_verified" },
  { requirementId: "aos-requirement:projection-import-truth-ownership", discoveredInPhase: "P7-C", workflowBehavior: "project import fields without replacing operational truth", aosCapabilityNeeded: "projection import ownership", protocolVersion: 1, requiredForMode: "offline_reference", acceptanceFixture: "fixture.projection-ownership", securityBoundary: "operational truth remains external", status: "candidate", maturity: "fixture_verified" },
  { requirementId: "aos-requirement:release-manifest-readback", discoveredInPhase: "P7-C", workflowBehavior: "compare public release manifest and compatibility readback", aosCapabilityNeeded: "public release manifest readback", protocolVersion: 1, requiredForMode: "offline_reference", acceptanceFixture: "fixture.release-manifest-readback", securityBoundary: "offline read-only only", status: "candidate", maturity: "fixture_verified" },
  { requirementId: "aos-requirement:trusted-role-actor-binding", discoveredInPhase: "P7-C", workflowBehavior: "bind trusted role and actor assertions", aosCapabilityNeeded: "trusted actor binding", protocolVersion: 1, requiredForMode: "offline_reference", acceptanceFixture: "fixture.trusted-role-actor", securityBoundary: "no credential or live identity lookup", status: "candidate", maturity: "fixture_verified" },
] as const satisfies readonly Omit<PublicAosRequirement, "schemaVersion">[];
const frozenRequirementSourceDigests = new Map(frozenRequirements.map((requirement) => [
  requirement.requirementId,
  canonicalSha256({ schemaVersion: PUBLIC_AOS_REQUIREMENTS_VERSION, ...requirement }),
]));

function fail(reasonCode: PublicAosRequirementsReasonCode, message: string): never { throw new PublicAosRequirementsError(reasonCode, message); }
function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("AOS_REQUIREMENTS_INPUT_INVALID", label);
  return value as Readonly<Record<string, unknown>>;
}
function exact(value: Readonly<Record<string, unknown>>, expected: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !key.isWellFormed())) fail("AOS_REQUIREMENTS_UNICODE_INVALID", label);
  const unknown = keys.filter((key) => !expected.includes(key));
  if (unknown.length) fail("AOS_REQUIREMENTS_UNKNOWN_FIELD", `${label}:${unknown.sort(compareCanonicalText).join(",")}`);
  const missing = expected.filter((key) => !keys.includes(key));
  if (missing.length) fail("AOS_REQUIREMENTS_INPUT_INVALID", `${label}:${missing.join(",")}`);
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.isWellFormed()) fail("AOS_REQUIREMENTS_UNICODE_INVALID", label);
  if (!value || Buffer.byteLength(value, "utf8") > 512) fail("AOS_REQUIREMENTS_INPUT_INVALID", label);
  if (privateTerms.some((term) => value.toLowerCase().includes(term))) fail("AOS_REQUIREMENTS_PRIVATE_FIELD", label);
  return value;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("AOS_REQUIREMENTS_INPUT_INVALID", label);
  return value;
}

function validateRequirement(value: unknown): PublicAosRequirement {
  const record = object(value, "requirement"); exact(record, requirementFields, "requirement");
  if (record.schemaVersion !== PUBLIC_AOS_REQUIREMENTS_VERSION) fail("AOS_REQUIREMENTS_INPUT_INVALID", "requirement.schemaVersion");
  const requirementId = text(record.requirementId, "requirementId");
  if (!/^aos-requirement:[a-z0-9][a-z0-9-]{2,127}$/u.test(requirementId)) fail("AOS_REQUIREMENTS_INPUT_INVALID", "requirementId");
  if (!frozenRequirementSourceDigests.has(requirementId)) fail("AOS_REQUIREMENTS_INPUT_INVALID", "requirementId");
  if (!Number.isSafeInteger(record.protocolVersion) || (record.protocolVersion as number) < 1) fail("AOS_REQUIREMENTS_PROTOCOL_INVALID", "protocolVersion");
  if (!statuses.includes(record.status as PublicAosRequirementStatus)) fail("AOS_REQUIREMENTS_STATUS_INVALID", "status");
  if (!maturities.includes(record.maturity as PublicAosRequirementMaturity)) fail("AOS_REQUIREMENTS_MATURITY_INVALID", "maturity");
  const requirement = {
    schemaVersion: PUBLIC_AOS_REQUIREMENTS_VERSION, requirementId,
    discoveredInPhase: text(record.discoveredInPhase, "discoveredInPhase"), workflowBehavior: text(record.workflowBehavior, "workflowBehavior"),
    aosCapabilityNeeded: text(record.aosCapabilityNeeded, "aosCapabilityNeeded"), protocolVersion: record.protocolVersion as number,
    requiredForMode: text(record.requiredForMode, "requiredForMode"), acceptanceFixture: text(record.acceptanceFixture, "acceptanceFixture"),
    securityBoundary: text(record.securityBoundary, "securityBoundary"), status: record.status as PublicAosRequirementStatus,
    maturity: record.maturity as PublicAosRequirementMaturity,
  };
  if (frozenRequirementSourceDigests.get(requirementId) !== canonicalSha256(requirement)) fail("AOS_REQUIREMENTS_SOURCE_MISMATCH", requirementId);
  return requirement;
}

export function validatePublicAosRequirementsLedger(value: unknown): PublicAosRequirementsLedger {
  const record = object(value, "ledger"); exact(record, ledgerFields, "ledger");
  if (record.schemaVersion !== PUBLIC_AOS_REQUIREMENTS_VERSION || !Array.isArray(record.requirements) || record.requirements.length !== frozenRequirements.length) fail("AOS_REQUIREMENTS_INPUT_INVALID", "ledger");
  const requirements = record.requirements.map(validateRequirement).sort((left, right) => compareCanonicalText(left.requirementId, right.requirementId));
  if (new Set(requirements.map((entry) => entry.requirementId)).size !== requirements.length) fail("AOS_REQUIREMENTS_DUPLICATE", "requirementId");
  const basis = { schemaVersion: PUBLIC_AOS_REQUIREMENTS_VERSION, requirements };
  if (digest(record.ledgerDigest, "ledgerDigest") !== canonicalSha256(basis)) fail("AOS_REQUIREMENTS_CANONICAL_INVALID", "ledgerDigest");
  return { ...basis, ledgerDigest: record.ledgerDigest as string };
}

export function parsePublicAosRequirementsLedger(source: unknown): PublicAosRequirementsLedger {
  if (typeof source !== "string" || !source.isWellFormed()) fail("AOS_REQUIREMENTS_UNICODE_INVALID", "ledger bytes");
  let parsed: unknown; try { parsed = JSON.parse(source); } catch { fail("AOS_REQUIREMENTS_INPUT_INVALID", "ledger bytes"); }
  const ledger = validatePublicAosRequirementsLedger(parsed);
  if (canonicalJson(parsed) !== source) fail("AOS_REQUIREMENTS_CANONICAL_INVALID", "ledger bytes");
  return ledger;
}

export function publicAosRequirementsReadback(value: unknown): Readonly<Record<string, unknown>> {
  const ledger = validatePublicAosRequirementsLedger(value);
  const counts = Object.fromEntries(statuses.map((status) => [status, ledger.requirements.filter((entry) => entry.status === status).length]));
  const maturity = Object.fromEntries(maturities.map((state) => [state, ledger.requirements.filter((entry) => entry.maturity === state).length]));
  const base = { schemaVersion: PUBLIC_AOS_REQUIREMENTS_READBACK_VERSION, ledgerDigest: ledger.ledgerDigest, requirementIds: ledger.requirements.map((entry) => entry.requirementId), statusCounts: counts, maturityCounts: maturity, liveCompatibility: false, runtimeMutation: false, supportedReleaseClaims: false, network: false };
  return { ...base, readbackDigest: canonicalSha256(base) };
}
