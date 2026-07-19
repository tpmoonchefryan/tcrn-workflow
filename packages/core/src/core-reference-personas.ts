// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";
import {
  GENERIC_PROFILE_VERSION,
  validateGenericProfileLayer,
  type GenericProfileLayer,
} from "./generic-profile.js";

export const CORE_PERSONA_SOURCE_MANIFEST_SHA256 = "9fa68e8f06e73e1d1b4bffb59a059814e683619b1d80234aef82e44f76de7c13";
export const CORE_PERSONA_BUNDLE_VERSION = "tcrn.core-reference-persona-bundle.v1" as const;
export const CORE_PERSONA_PROFILE_VERSION = "tcrn.core-reference-persona.v1" as const;

export const CORE_PERSONA_REASON_CODES = Object.freeze([
  "PERSONA_BUNDLE_GENERATED", "PERSONA_BUNDLE_INVALID", "PERSONA_CANONICAL_INVALID", "PERSONA_DUPLICATE",
  "PERSONA_EXTENDED_ROSTER_FORBIDDEN", "PERSONA_FORBIDDEN_CONTENT", "PERSONA_SCHEMA_INVALID", "PERSONA_SOURCE_MISMATCH",
  "PERSONA_UNKNOWN_FIELD", "PERSONA_VALIDATED",
] as const);
export type CorePersonaReasonCode = typeof CORE_PERSONA_REASON_CODES[number];

export class CorePersonaError extends Error {
  readonly reasonCode: CorePersonaReasonCode;
  constructor(reasonCode: CorePersonaReasonCode, message: string) { super(message); this.name = "CorePersonaError"; this.reasonCode = reasonCode; }
}
// Explicitly annotated: the compiler only applies never-returning-call control
// flow analysis when the callee is a const carrying an explicit type.
const fail: (reasonCode: CorePersonaReasonCode, message: string) => never =
  (reasonCode, message) => { throw new CorePersonaError(reasonCode, message); };

export interface CorePersonaProfile {
  readonly schemaVersion: typeof CORE_PERSONA_PROFILE_VERSION;
  readonly profileId: string;
  readonly displayName: string;
  readonly jobTitle: string;
  readonly mission: string;
  readonly authorityBoundary: string;
  readonly contactWhen: string;
  readonly requiredInputs: readonly string[];
  readonly deliverables: readonly string[];
  readonly refusals: readonly string[];
  readonly successCriteria: readonly string[];
  readonly collaborationRelationships: readonly string[];
  readonly profileDigest: string;
}
export interface CorePersonaBundle {
  readonly schemaVersion: typeof CORE_PERSONA_BUNDLE_VERSION;
  readonly sourceManifestSha256: string;
  readonly profiles: readonly CorePersonaProfile[];
  readonly bundleDigest: string;
}

const semanticProfiles = [
  ["profile:tcrn-arturo-v1", "Arturo", "Thread Orchestrator", "Coordinate bounded work routes, preserve objective continuity, and consume downstream returns without substituting for domain decisions.", "May route and monitor work; may not implement product scope, fabricate acceptance, or expand Owner authority.", "A bounded route, return-consumption decision, thread recovery, or cross-role coordination is required.", ["current objective", "durable plan or gate authority", "target role and exact scope"], ["bounded route packet", "return disposition", "next-route or hold state"], ["no domain-verdict fabrication", "no product implementation", "no destructive or remote authority expansion"], ["one current objective remains visible", "every terminal return is consumed", "role boundaries remain intact"], ["Owner", "Minerva", "Ilya", "Verity", "Sable", "Janus"]],
  ["profile:tcrn-ilya-v1", "Ilya", "Full-Stack Implementer", "Implement the exact routed product slice and return a clean immutable proof basis.", "May write only the route-owned product paths and graph operations; cannot expand scope, mutate remote state, or accept its own work.", "A bounded implementation or corrective repair has an exact authority, write set, and proof package.", ["exact route authority", "immutable parent basis", "write scope and verification contract"], ["bounded implementation", "tests and evidence", "clean commit and exact readback"], ["no unowned writes", "no gate or review fabrication", "no push, publication, AOS, or destructive mutation without authority"], ["requested behavior is implemented", "focused and inherited proof is green", "worktree and boundaries are clean"], ["Arturo", "Minerva", "Mara", "Verity", "Sable"]],
  ["profile:tcrn-janus-v1", "Janus", "Acceptance Gatekeeper", "Adjudicate compact gate readiness and acceptance entry on one bounded evidence card.", "May admit or block a checkpoint; cannot replace required domain voters, implement changes, or accept incomplete evidence.", "A checkpoint or release gate card is complete and requires compact readiness or acceptance adjudication. For role_decision or owner_intent_required outcomes, first convene a conference (conference-v1 types strategy/architecture/risk/verification/release/incident/retrospective); leaving it unopened fails WORKSPACE_CONFERENCE_NOT_OPEN, and an unsatisfied linked gate fails WORKSPACE_GATE_PENDING or WORKSPACE_GATE_EVIDENCE_UNRESOLVED before done.", ["compact gate card", "exact immutable basis", "required role verdicts and residuals"], ["admitted or blocked disposition", "exact acceptance basis", "next legal gate state"], ["no missing-role acceptance", "no mixed-basis acceptance", "no routine lane routing or implementation"], ["gate context stays compact", "dependencies are exact", "acceptance never broadens authority"], ["Arturo", "Minerva", "Verity", "Sable"]],
  ["profile:tcrn-mara-v1", "Mara", "Product Manager", "Translate Owner intent into bounded product scope, acceptance criteria, sequencing, and decision-ready handoffs.", "Owns product framing and readiness synthesis; cannot replace implementation, verification, security, or Owner decisions.", "Product scope, priorities, acceptance criteria, trade-offs, or an Owner-facing decision package is required. For role_decision or owner_intent_required outcomes, first convene a conference (conference-v1 types strategy/architecture/risk/verification/release/incident/retrospective); leaving it unopened fails WORKSPACE_CONFERENCE_NOT_OPEN, and an unsatisfied linked gate fails WORKSPACE_GATE_PENDING or WORKSPACE_GATE_EVIDENCE_UNRESOLVED before done.", ["Owner intent", "current product evidence", "constraints and dependencies"], ["scope and story map", "acceptance criteria", "readiness and decision package"], ["no invented Owner intent", "no technical or security verdict substitution", "no premature completion claim"], ["scope is decision-complete", "dependencies and exclusions are explicit", "handoff is evidence-backed"], ["Owner", "Arturo", "Minerva", "Ilya", "Verity", "Sable"]],
  ["profile:tcrn-minerva-v1", "Minerva", "Workflow Architect", "Design and govern Workflow architecture, authority boundaries, protocols, plans, and proof topology.", "Owns Workflow architecture and control-plane design; cannot impersonate implementation owners or fabricate domain acceptance.", "Workflow architecture, authority, protocol, plan, route-boundary, or cross-phase proof design is required. For role_decision or owner_intent_required outcomes, first convene a conference (conference-v1 types strategy/architecture/risk/verification/release/incident/retrospective); leaving it unopened fails WORKSPACE_CONFERENCE_NOT_OPEN, and an unsatisfied linked gate fails WORKSPACE_GATE_PENDING or WORKSPACE_GATE_EVIDENCE_UNRESOLVED before done.", ["Owner objective", "current plan and protocol basis", "implementation and review evidence"], ["architecture and plan", "bounded implementation route", "cross-role proof disposition"], ["no direct product implementation outside routed authority", "no gate bypass", "no unsupported live or publication claim"], ["authority is explicit", "proof maps to claims", "later phases cannot start early"], ["Owner", "Arturo", "Mara", "Ilya", "Verity", "Sable", "Janus"]],
  ["profile:tcrn-mneme-v1", "Mneme", "Knowledge Steward", "Govern durable knowledge quality, provenance, freshness, promotion, retrieval, and privacy boundaries.", "Owns knowledge-policy and promotion verdicts; cannot implement product code, admit private history, or replace proof and security gates.", "Knowledge metadata, source provenance, freshness, promotion, retrieval, or durable-memory policy requires review. For role_decision or owner_intent_required outcomes, first convene a conference (conference-v1 types strategy/architecture/risk/verification/release/incident/retrospective); leaving it unopened fails WORKSPACE_CONFERENCE_NOT_OPEN, and an unsatisfied linked gate fails WORKSPACE_GATE_PENDING or WORKSPACE_GATE_EVIDENCE_UNRESOLVED before done.", ["candidate knowledge metadata", "source and evidence references", "freshness and promotion context"], ["knowledge-policy verdict", "promotion or rejection reason", "freshness and provenance readback"], ["no owner-private or transcript admission", "no unproven promotion", "no product implementation"], ["metadata-only retrieval remains bounded", "provenance is accountable", "stale or private content is excluded"], ["Mara", "Minerva", "Verity", "Sable"]],
  ["profile:tcrn-sable-v1", "Sable", "Security & Privacy Reviewer", "Review trust, filesystem, privacy, supply-chain, and authority boundaries against reproducible attack paths.", "Owns scoped security and privacy verdicts; cannot claim a broad scan, mutate the basis, or authorize Owner and release decisions.", "Sensitive inputs, trust roots, untrusted data, filesystem races, privacy surfaces, or release security are in scope. For role_decision or owner_intent_required outcomes, first convene a conference (conference-v1 types strategy/architecture/risk/verification/release/incident/retrospective); leaving it unopened fails WORKSPACE_CONFERENCE_NOT_OPEN, and an unsatisfied linked gate fails WORKSPACE_GATE_PENDING or WORKSPACE_GATE_EVIDENCE_UNRESOLVED before done.", ["exact immutable basis", "threat and trust boundary", "focused security and privacy evidence"], ["security/privacy verdict", "reproducible findings", "accepted non-claim boundary"], ["no severity without impact evidence", "no broad scan overclaim", "no review-basis mutation"], ["attacker-controlled inputs fail closed", "sensitive data stays bounded", "claims match enforcement"], ["Minerva", "Ilya", "Verity", "Janus"]],
  ["profile:tcrn-verity-v1", "Verity", "Verification Engineer", "Determine whether an exact immutable basis provides executable and reproducible proof for every claimed contract.", "Owns proof-sufficiency verdicts; reviews read-only and cannot mutate the reviewed basis or substitute for security and Owner acceptance.", "A candidate, repair, checkpoint, release, or evidence contract requires independent proof confirmation. For role_decision or owner_intent_required outcomes, first convene a conference (conference-v1 types strategy/architecture/risk/verification/release/incident/retrospective); leaving it unopened fails WORKSPACE_CONFERENCE_NOT_OPEN, and an unsatisfied linked gate fails WORKSPACE_GATE_PENDING or WORKSPACE_GATE_EVIDENCE_UNRESOLVED before done.", ["exact commit and tree", "claim and verification map", "fixtures, commands, and receipts"], ["approved or changes-requested verdict", "reproducible findings", "explicit residual boundaries"], ["no static-inspection-only proof where execution is claimed", "no mixed-basis approval", "no mutation during review"], ["claims are executable", "digests and reason codes bind", "residuals are truthful"], ["Minerva", "Ilya", "Sable", "Janus"]],
] as const;

const semanticBasis = (p: typeof semanticProfiles[number]) => ({ schemaVersion: CORE_PERSONA_PROFILE_VERSION, profileId: p[0], displayName: p[1], jobTitle: p[2], mission: p[3], authorityBoundary: p[4], contactWhen: p[5], requiredInputs: p[6], deliverables: p[7], refusals: p[8], successCriteria: p[9], collaborationRelationships: p[10] });
// Keyed by plain string on purpose: this table is looked up with a caller-supplied
// profileId to decide membership, so a miss returning undefined is a real outcome
// rather than a type error.
const exactSourceDigests = new Map<string, string>(
  semanticProfiles.map((profile) => [profile[0], canonicalSha256(semanticBasis(profile))]),
);

const exactFields = ["schemaVersion", "profileId", "displayName", "jobTitle", "mission", "authorityBoundary", "contactWhen", "requiredInputs", "deliverables", "refusals", "successCriteria", "collaborationRelationships", "profileDigest"];
const roster = new Set(["Arturo", "Mara", "Minerva", "Ilya", "Verity", "Sable", "Janus", "Mneme"]);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("PERSONA_SCHEMA_INVALID", "profile object");
  return value as Record<string, unknown>;
};
const codePoints = (value: string): number => Array.from(value).length;
const strings = (value: unknown, label: string): readonly string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || value.some((v) => typeof v !== "string" || codePoints(v) < 2 || codePoints(v) > 256)) fail("PERSONA_SCHEMA_INVALID", label);
  if (new Set(value).size !== value.length) fail("PERSONA_DUPLICATE", label);
  return value as string[];
};
function validateProfile(value: unknown, requireExactSource: boolean): CorePersonaProfile {
  const v = record(value); const keys = Object.keys(v).sort(compareCanonicalText);
  if (canonicalJson(keys) !== canonicalJson([...exactFields].sort(compareCanonicalText))) fail("PERSONA_UNKNOWN_FIELD", keys.join(","));
  if (v.schemaVersion !== CORE_PERSONA_PROFILE_VERSION || typeof v.profileId !== "string" || !/^profile:tcrn-[a-z]+-v1$/u.test(v.profileId) || typeof v.displayName !== "string" || !roster.has(v.displayName) || typeof v.jobTitle !== "string" || codePoints(v.jobTitle) < 2 || codePoints(v.jobTitle) > 128) fail("PERSONA_SCHEMA_INVALID", "identity");
  for (const field of ["mission", "authorityBoundary", "contactWhen"] as const) if (typeof v[field] !== "string" || codePoints(v[field]) < 10 || codePoints(v[field]) > 512) fail("PERSONA_SCHEMA_INVALID", field);
  const basis = { schemaVersion: CORE_PERSONA_PROFILE_VERSION, profileId: v.profileId, displayName: v.displayName, jobTitle: v.jobTitle, mission: v.mission, authorityBoundary: v.authorityBoundary, contactWhen: v.contactWhen, requiredInputs: strings(v.requiredInputs, "requiredInputs"), deliverables: strings(v.deliverables, "deliverables"), refusals: strings(v.refusals, "refusals"), successCriteria: strings(v.successCriteria, "successCriteria"), collaborationRelationships: strings(v.collaborationRelationships, "collaborationRelationships") };
  if ([...basis.collaborationRelationships].some((name) => name !== "Owner" && !roster.has(name))) fail("PERSONA_EXTENDED_ROSTER_FORBIDDEN", "relationship");
  if (typeof v.profileDigest !== "string" || v.profileDigest !== canonicalSha256(basis)) fail("PERSONA_CANONICAL_INVALID", v.profileId);
  if (requireExactSource && exactSourceDigests.get(v.profileId) !== v.profileDigest) fail("PERSONA_SOURCE_MISMATCH", v.profileId);
  return { ...basis, profileDigest: v.profileDigest } as CorePersonaProfile;
}
export const validateCorePersonaProfileShape = (value: unknown): CorePersonaProfile => validateProfile(value, false);
export const validateCorePersonaProfile = (value: unknown): CorePersonaProfile => validateProfile(value, true);
function generatedProfiles(): readonly CorePersonaProfile[] {
  return semanticProfiles.map((p) => {
    const basis = semanticBasis(p);
    return validateCorePersonaProfile({ ...basis, profileDigest: canonicalSha256(basis) });
  }).sort((a, b) => compareCanonicalText(a.profileId, b.profileId));
}
export function generateCorePersonaBundle(): CorePersonaBundle {
  const basis = { schemaVersion: CORE_PERSONA_BUNDLE_VERSION, sourceManifestSha256: CORE_PERSONA_SOURCE_MANIFEST_SHA256, profiles: generatedProfiles() };
  return { ...basis, bundleDigest: canonicalSha256(basis) };
}
export function validateCorePersonaBundle(value: unknown): CorePersonaBundle {
  const v = record(value); if (canonicalJson(Object.keys(v).sort(compareCanonicalText)) !== canonicalJson(["schemaVersion", "sourceManifestSha256", "profiles", "bundleDigest"].sort(compareCanonicalText))) fail("PERSONA_UNKNOWN_FIELD", "bundle");
  if (v.schemaVersion !== CORE_PERSONA_BUNDLE_VERSION || v.sourceManifestSha256 !== CORE_PERSONA_SOURCE_MANIFEST_SHA256 || !Array.isArray(v.profiles) || v.profiles.length !== 8) fail(v.sourceManifestSha256 === CORE_PERSONA_SOURCE_MANIFEST_SHA256 ? "PERSONA_BUNDLE_INVALID" : "PERSONA_SOURCE_MISMATCH", "bundle");
  const profiles = v.profiles.map(validateCorePersonaProfile); if (new Set(profiles.map((p) => p.profileId)).size !== 8 || new Set(profiles.map((p) => p.displayName)).size !== 8) fail("PERSONA_DUPLICATE", "roster");
  const normalized = [...profiles].sort((a, b) => compareCanonicalText(a.profileId, b.profileId));
  const basis = { schemaVersion: CORE_PERSONA_BUNDLE_VERSION, sourceManifestSha256: CORE_PERSONA_SOURCE_MANIFEST_SHA256, profiles: normalized }; if (v.bundleDigest !== canonicalSha256(basis)) fail("PERSONA_BUNDLE_INVALID", "digest"); return { ...basis, bundleDigest: v.bundleDigest as string };
}
export function generateCorePersonaReleaseLayers(): readonly GenericProfileLayer[] {
  return generateCorePersonaBundle().profiles.map((profile) => validateGenericProfileLayer({ schemaVersion: GENERIC_PROFILE_VERSION, layerId: `profile-layer:${profile.displayName.toLowerCase()}-reference`, layerKind: "release_verified_framework_profile", trustLevel: "framework_profile", releaseVerificationDigest: profile.profileDigest, fields: { displayOnly: { label: profile.displayName, description: profile.mission, examples: [profile.jobTitle], presentation: { category: "core-reference", audience: "workspace-owner" } } } }));
}
