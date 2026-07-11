// SPDX-License-Identifier: Apache-2.0

import {
  ProtocolError,
  assertProtocolId,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
} from "../../protocol/src/index.js";

export const GENERIC_PROFILE_VERSION = "tcrn.generic-profile.v1" as const;
export const GENERIC_PROFILE_BUNDLE_VERSION = "tcrn.generic-profile-starter-bundle.v1" as const;
export const GENERIC_PROFILE_EFFECTIVE_VERSION = "tcrn.generic-profile-effective.v1" as const;
export const GENERIC_PROFILE_OWNER_REBIND_VERSION = "tcrn.generic-profile-owner-rebind.v1" as const;

export const GENERIC_PROFILE_OPERATIONS = Object.freeze([
  "profile.read",
  "project.create",
  "view.generate",
  "work.create",
  "work.transition",
  "workspace.initialize",
  "workspace.read",
  "workspace.validate",
] as const);

export const GENERIC_PROFILE_REASON_CODES = Object.freeze([
  "PROFILE_BINDING_MISMATCH",
  "PROFILE_BINDING_REQUIRED",
  "PROFILE_BUNDLE_GENERATED",
  "PROFILE_BUNDLE_INVALID",
  "PROFILE_CANONICAL_INVALID",
  "PROFILE_COLD_STANDBY",
  "PROFILE_DUPLICATE_LAYER",
  "PROFILE_DUPLICATE_VALUE",
  "PROFILE_EFFECTIVE_RESOLVED",
  "PROFILE_FIELD_IMMUTABLE",
  "PROFILE_INERT_DATA_REQUIRED",
  "PROFILE_INPUT_INVALID",
  "PROFILE_OPERATION_AUTHORIZED",
  "PROFILE_OPERATION_DENIED",
  "PROFILE_OWNER_REBIND_INVALID",
  "PROFILE_OWNER_REBIND_REQUIRED",
  "PROFILE_PRECEDENCE_AMBIGUOUS",
  "PROFILE_REFUSAL_WEAKENING",
  "PROFILE_RELEASE_UNVERIFIED",
  "PROFILE_RESTRICTION_EXPANSION",
  "PROFILE_SCHEMA_INVALID",
  "PROFILE_TRUST_INVALID",
  "PROFILE_TYPE_CONFLICT",
  "PROFILE_UNKNOWN_FIELD",
  "PROFILE_VALIDATED",
] as const);

export type GenericProfileReasonCode = typeof GENERIC_PROFILE_REASON_CODES[number];
export type GenericProfileOperation = typeof GENERIC_PROFILE_OPERATIONS[number];
export type GenericProfileTrustLevel = "framework_profile" | "user_owned_overlay" | "imported_untrusted";
export type GenericProfileLayerKind =
  | "framework_defaults"
  | "release_verified_framework_profile"
  | "imported_untrusted"
  | "workspace_configuration"
  | "project_configuration"
  | "command_override";
export type GenericProfileBindingMode = "unbound_read_only" | "cold_standby" | "workspace" | "project" | "command";

export class GenericProfileError extends Error {
  readonly reasonCode: GenericProfileReasonCode;

  constructor(reasonCode: GenericProfileReasonCode, message: string) {
    super(message);
    this.name = "GenericProfileError";
    this.reasonCode = reasonCode;
  }
}

export interface GenericProfileBinding {
  readonly mode: GenericProfileBindingMode;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly command: string | null;
}

export interface GenericProfileIdentity {
  readonly profileId: string;
  readonly authorityId: string;
  readonly authorityKind: "framework";
}

export interface GenericProfileImmutableFields {
  readonly identity: GenericProfileIdentity;
  readonly baseMission: string;
  readonly mandatorySafety: readonly string[];
  readonly mandatoryRefusals: readonly string[];
  readonly protocolVersion: 1;
  readonly profileSchemaVersion: 1;
}

export interface GenericProfileBudgets {
  readonly maximumOperations: number;
  readonly maximumWrites: number;
  readonly maximumEvidenceBytes: number;
}

export interface GenericProfileRestrictOnlyFields {
  readonly writePaths: readonly string[];
  readonly tools: readonly string[];
  readonly budgets: GenericProfileBudgets;
  readonly dataClassifications: readonly string[];
  readonly allowedOperations: readonly GenericProfileOperation[];
}

export interface GenericProfileOwnerRebindFields {
  readonly activeBinding: GenericProfileBinding;
  readonly roleReplacement: string | null;
  readonly projectAuthority: string | null;
  readonly escalationOwner: string | null;
}

export interface GenericProfileDisplayFields {
  readonly label: string;
  readonly description: string;
  readonly examples: readonly string[];
  readonly presentation: {
    readonly category: string;
    readonly audience: string;
  };
}

export interface GenericProfileLayer {
  readonly schemaVersion: typeof GENERIC_PROFILE_VERSION;
  readonly layerId: string;
  readonly layerKind: GenericProfileLayerKind;
  readonly trustLevel: GenericProfileTrustLevel;
  readonly releaseVerificationDigest: string | null;
  readonly fields: {
    readonly immutable?: GenericProfileImmutableFields;
    readonly restrictOnly?: GenericProfileRestrictOnlyFields;
    readonly ownerRebindOnly?: GenericProfileOwnerRebindFields;
    readonly displayOnly?: GenericProfileDisplayFields;
  };
}

export interface GenericProfileOwnerRebind {
  readonly schemaVersion: typeof GENERIC_PROFILE_OWNER_REBIND_VERSION;
  readonly approved: true;
  readonly ownerId: string;
  readonly targetLayerId: string;
  readonly replacement: GenericProfileOwnerRebindFields;
}

export interface GenericProfileResolutionRequest {
  readonly schemaVersion: "tcrn.generic-profile-resolution-request.v1";
  readonly layers: readonly GenericProfileLayer[];
  readonly ownerRebind: GenericProfileOwnerRebind | null;
  readonly admittedReleaseProfileDigests: readonly string[];
}

export interface GenericProfileStarterBundle {
  readonly schemaVersion: typeof GENERIC_PROFILE_BUNDLE_VERSION;
  readonly layers: readonly GenericProfileLayer[];
  readonly starterFlow: readonly {
    readonly kind: "Initiative" | "Epic" | "Story" | "Subtask";
    readonly parentKind: "Initiative" | "Epic" | "Story" | null;
  }[];
  readonly bundleDigest: string;
}

export interface EffectiveGenericProfile {
  readonly schemaVersion: typeof GENERIC_PROFILE_EFFECTIVE_VERSION;
  readonly resolution: "bound" | "unbound_read_only" | "cold_standby";
  readonly sourceLayerIds: readonly string[];
  readonly trustSummary: {
    readonly frameworkProfiles: number;
    readonly userOwnedOverlays: number;
    readonly importedUntrusted: number;
  };
  readonly immutable: GenericProfileImmutableFields;
  readonly restrictOnly: GenericProfileRestrictOnlyFields;
  readonly ownerRebindOnly: GenericProfileOwnerRebindFields;
  readonly displayOnly: GenericProfileDisplayFields;
  readonly baseDigest: string;
  readonly profileDigests: readonly {
    readonly layerId: string;
    readonly digest: string;
  }[];
  readonly overlayDigest: string;
  readonly effectivePolicyDigest: string;
  readonly effectiveDigest: string;
}

export interface GenericProfileAuthorizationContext {
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly command: string | null;
}

function fail(reasonCode: GenericProfileReasonCode, message: string): never {
  throw new GenericProfileError(reasonCode, message);
}

function asRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("PROFILE_TYPE_CONFLICT", label);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactFields(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail("PROFILE_UNKNOWN_FIELD", `${label}:${unknown.sort(compareCanonicalText).join(",")}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) fail("PROFILE_SCHEMA_INVALID", `${label}:${missing.join(",")}`);
}

function safeCanonical(value: unknown, label: string): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("PROFILE_INERT_DATA_REQUIRED", `${label}:${error.reasonCode}`);
    }
    throw error;
  }
}

function assertStableId(value: unknown, label: string): asserts value is string {
  try {
    assertProtocolId(value);
  } catch (error) {
    if (error instanceof ProtocolError) fail("PROFILE_SCHEMA_INVALID", `${label}:${error.reasonCode}`);
    throw error;
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("PROFILE_SCHEMA_INVALID", label);
}

function inertText(value: unknown, label: string, maximumBytes = 1_024): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail("PROFILE_SCHEMA_INVALID", label);
  }
  safeCanonical(value, label);
  if (/\$\{|\{\{|`|<\/?script|(?:javascript|data|file|node|https?|ftp|ssh):|(?:^|\s)\/Users\/|[A-Za-z]:\\/iu.test(value)) {
    fail("PROFILE_INERT_DATA_REQUIRED", label);
  }
  return value;
}

function token(value: unknown, label: string): string {
  const checked = inertText(value, label, 128);
  if (!/^[a-z][a-z0-9._-]{1,127}$/u.test(checked)) fail("PROFILE_SCHEMA_INVALID", label);
  return checked;
}

function canonicalStringList(
  value: unknown,
  label: string,
  validate: (entry: unknown, entryLabel: string) => string = token,
  maximum = 64,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) fail("PROFILE_SCHEMA_INVALID", label);
  const checked = value.map((entry, index) => validate(entry, `${label}[${index}]`));
  if (new Set(checked).size !== checked.length) fail("PROFILE_DUPLICATE_VALUE", label);
  const sorted = [...checked].sort(compareCanonicalText);
  if (safeCanonical(sorted, label) !== safeCanonical(checked, label)) fail("PROFILE_CANONICAL_INVALID", label);
  return Object.freeze(sorted);
}

function relativeWritePath(value: unknown, label: string): string {
  const checked = inertText(value, label, 256);
  if (checked.startsWith("/") || checked.includes("\\") || checked.split("/").includes("..") ||
    checked.includes("//") || !/^[a-z0-9._/-]+$/u.test(checked)) {
    fail("PROFILE_INERT_DATA_REQUIRED", label);
  }
  return checked;
}

function boundedInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    fail("PROFILE_SCHEMA_INVALID", label);
  }
  return Number(value);
}

function validateBinding(value: unknown, label: string): GenericProfileBinding {
  const document = asRecord(value, label);
  exactFields(document, ["mode", "workspaceId", "projectId", "command"], ["mode", "workspaceId", "projectId", "command"], label);
  const modes: readonly GenericProfileBindingMode[] = ["unbound_read_only", "cold_standby", "workspace", "project", "command"];
  if (typeof document.mode !== "string" || !modes.includes(document.mode as GenericProfileBindingMode)) {
    fail("PROFILE_SCHEMA_INVALID", `${label}.mode`);
  }
  const mode = document.mode as GenericProfileBindingMode;
  const workspaceId = document.workspaceId;
  const projectId = document.projectId;
  const command = document.command;
  if (workspaceId !== null) assertStableId(workspaceId, `${label}.workspaceId`);
  if (projectId !== null) assertStableId(projectId, `${label}.projectId`);
  if (command !== null && (typeof command !== "string" || !/^[a-z][a-z0-9:-]{1,63}$/u.test(command))) {
    fail("PROFILE_SCHEMA_INVALID", `${label}.command`);
  }
  const valid = (mode === "unbound_read_only" || mode === "cold_standby")
    ? workspaceId === null && projectId === null && command === null
    : mode === "workspace"
      ? typeof workspaceId === "string" && projectId === null && command === null
      : mode === "project"
        ? typeof workspaceId === "string" && typeof projectId === "string" && command === null
        : typeof workspaceId === "string" && typeof projectId === "string" && typeof command === "string";
  if (!valid) fail("PROFILE_SCHEMA_INVALID", `${label}:${mode}`);
  return { mode, workspaceId, projectId, command } as GenericProfileBinding;
}

function validateImmutable(value: unknown, label: string): GenericProfileImmutableFields {
  const document = asRecord(value, label);
  exactFields(
    document,
    ["identity", "baseMission", "mandatorySafety", "mandatoryRefusals", "protocolVersion", "profileSchemaVersion"],
    ["identity", "baseMission", "mandatorySafety", "mandatoryRefusals", "protocolVersion", "profileSchemaVersion"],
    label,
  );
  const identityDocument = asRecord(document.identity, `${label}.identity`);
  exactFields(identityDocument, ["profileId", "authorityId", "authorityKind"], ["profileId", "authorityId", "authorityKind"], `${label}.identity`);
  assertStableId(identityDocument.profileId, `${label}.identity.profileId`);
  assertStableId(identityDocument.authorityId, `${label}.identity.authorityId`);
  if (identityDocument.authorityKind !== "framework") fail("PROFILE_TRUST_INVALID", `${label}.identity.authorityKind`);
  if (document.protocolVersion !== 1 || document.profileSchemaVersion !== 1) fail("PROFILE_SCHEMA_INVALID", `${label}.versions`);
  return {
    identity: {
      profileId: identityDocument.profileId,
      authorityId: identityDocument.authorityId,
      authorityKind: "framework",
    },
    baseMission: token(document.baseMission, `${label}.baseMission`),
    mandatorySafety: canonicalStringList(document.mandatorySafety, `${label}.mandatorySafety`),
    mandatoryRefusals: canonicalStringList(document.mandatoryRefusals, `${label}.mandatoryRefusals`),
    protocolVersion: 1,
    profileSchemaVersion: 1,
  };
}

function validateBudgets(value: unknown, label: string): GenericProfileBudgets {
  const document = asRecord(value, label);
  exactFields(
    document,
    ["maximumOperations", "maximumWrites", "maximumEvidenceBytes"],
    ["maximumOperations", "maximumWrites", "maximumEvidenceBytes"],
    label,
  );
  return {
    maximumOperations: boundedInteger(document.maximumOperations, `${label}.maximumOperations`, 10_000),
    maximumWrites: boundedInteger(document.maximumWrites, `${label}.maximumWrites`, 10_000),
    maximumEvidenceBytes: boundedInteger(document.maximumEvidenceBytes, `${label}.maximumEvidenceBytes`, 16_777_216),
  };
}

function operation(value: unknown, label: string): GenericProfileOperation {
  if (typeof value !== "string" || !GENERIC_PROFILE_OPERATIONS.includes(value as GenericProfileOperation)) {
    fail("PROFILE_SCHEMA_INVALID", label);
  }
  return value as GenericProfileOperation;
}

function validateRestrictOnly(value: unknown, label: string): GenericProfileRestrictOnlyFields {
  const document = asRecord(value, label);
  exactFields(
    document,
    ["writePaths", "tools", "budgets", "dataClassifications", "allowedOperations"],
    ["writePaths", "tools", "budgets", "dataClassifications", "allowedOperations"],
    label,
  );
  return {
    writePaths: canonicalStringList(document.writePaths, `${label}.writePaths`, relativeWritePath),
    tools: canonicalStringList(document.tools, `${label}.tools`),
    budgets: validateBudgets(document.budgets, `${label}.budgets`),
    dataClassifications: canonicalStringList(document.dataClassifications, `${label}.dataClassifications`),
    allowedOperations: canonicalStringList(document.allowedOperations, `${label}.allowedOperations`, operation) as readonly GenericProfileOperation[],
  };
}

function nullableStableId(value: unknown, label: string): string | null {
  if (value === null) return null;
  assertStableId(value, label);
  return value;
}

function validateOwnerFields(value: unknown, label: string): GenericProfileOwnerRebindFields {
  const document = asRecord(value, label);
  exactFields(
    document,
    ["activeBinding", "roleReplacement", "projectAuthority", "escalationOwner"],
    ["activeBinding", "roleReplacement", "projectAuthority", "escalationOwner"],
    label,
  );
  return {
    activeBinding: validateBinding(document.activeBinding, `${label}.activeBinding`),
    roleReplacement: nullableStableId(document.roleReplacement, `${label}.roleReplacement`),
    projectAuthority: nullableStableId(document.projectAuthority, `${label}.projectAuthority`),
    escalationOwner: nullableStableId(document.escalationOwner, `${label}.escalationOwner`),
  };
}

function validateDisplay(value: unknown, label: string): GenericProfileDisplayFields {
  const document = asRecord(value, label);
  exactFields(document, ["label", "description", "examples", "presentation"], ["label", "description", "examples", "presentation"], label);
  const presentation = asRecord(document.presentation, `${label}.presentation`);
  exactFields(presentation, ["category", "audience"], ["category", "audience"], `${label}.presentation`);
  return {
    label: inertText(document.label, `${label}.label`, 128),
    description: inertText(document.description, `${label}.description`, 1_024),
    examples: canonicalStringList(document.examples, `${label}.examples`, (entry, entryLabel) => inertText(entry, entryLabel, 256), 16),
    presentation: {
      category: token(presentation.category, `${label}.presentation.category`),
      audience: token(presentation.audience, `${label}.presentation.audience`),
    },
  };
}

const expectedTrust: Readonly<Record<GenericProfileLayerKind, GenericProfileTrustLevel>> = Object.freeze({
  framework_defaults: "framework_profile",
  release_verified_framework_profile: "framework_profile",
  imported_untrusted: "imported_untrusted",
  workspace_configuration: "user_owned_overlay",
  project_configuration: "user_owned_overlay",
  command_override: "user_owned_overlay",
});

const precedence: Readonly<Record<GenericProfileLayerKind, number>> = Object.freeze({
  framework_defaults: 0,
  release_verified_framework_profile: 1,
  imported_untrusted: 2,
  workspace_configuration: 3,
  project_configuration: 4,
  command_override: 5,
});

export function validateGenericProfileLayer(value: unknown): GenericProfileLayer {
  const document = asRecord(value, "profile layer");
  exactFields(
    document,
    ["schemaVersion", "layerId", "layerKind", "trustLevel", "releaseVerificationDigest", "fields"],
    ["schemaVersion", "layerId", "layerKind", "trustLevel", "releaseVerificationDigest", "fields"],
    "profile layer",
  );
  if (document.schemaVersion !== GENERIC_PROFILE_VERSION) fail("PROFILE_SCHEMA_INVALID", "profile layer schemaVersion");
  assertStableId(document.layerId, "profile layer layerId");
  const layerKinds = Object.keys(precedence) as GenericProfileLayerKind[];
  if (typeof document.layerKind !== "string" || !layerKinds.includes(document.layerKind as GenericProfileLayerKind)) {
    fail("PROFILE_SCHEMA_INVALID", "profile layer layerKind");
  }
  const layerKind = document.layerKind as GenericProfileLayerKind;
  if (document.trustLevel !== expectedTrust[layerKind]) fail("PROFILE_TRUST_INVALID", `${layerKind}:${String(document.trustLevel)}`);
  if (layerKind === "release_verified_framework_profile") {
    assertSha256(document.releaseVerificationDigest, "profile layer releaseVerificationDigest");
  } else if (document.releaseVerificationDigest !== null) {
    fail("PROFILE_TRUST_INVALID", `${layerKind}:releaseVerificationDigest`);
  }
  const fieldsDocument = asRecord(document.fields, "profile layer fields");
  exactFields(fieldsDocument, ["immutable", "restrictOnly", "ownerRebindOnly", "displayOnly"], [], "profile layer fields");
  if (Object.keys(fieldsDocument).length === 0) fail("PROFILE_SCHEMA_INVALID", "profile layer fields empty");
  const fields = {
    ...(Object.hasOwn(fieldsDocument, "immutable") ? { immutable: validateImmutable(fieldsDocument.immutable, "profile layer immutable") } : {}),
    ...(Object.hasOwn(fieldsDocument, "restrictOnly") ? { restrictOnly: validateRestrictOnly(fieldsDocument.restrictOnly, "profile layer restrictOnly") } : {}),
    ...(Object.hasOwn(fieldsDocument, "ownerRebindOnly") ? { ownerRebindOnly: validateOwnerFields(fieldsDocument.ownerRebindOnly, "profile layer ownerRebindOnly") } : {}),
    ...(Object.hasOwn(fieldsDocument, "displayOnly") ? { displayOnly: validateDisplay(fieldsDocument.displayOnly, "profile layer displayOnly") } : {}),
  };
  if (layerKind === "framework_defaults" &&
    (!fields.immutable || !fields.restrictOnly || !fields.ownerRebindOnly || !fields.displayOnly)) {
    fail("PROFILE_SCHEMA_INVALID", "framework defaults must define the complete merge matrix");
  }
  if (layerKind === "imported_untrusted" &&
    (!fields.restrictOnly || fields.immutable || fields.ownerRebindOnly || fields.displayOnly)) {
    fail("PROFILE_TRUST_INVALID", "imported_untrusted layers may only preserve or narrow restrictions");
  }
  safeCanonical(fields, "profile layer fields");
  return {
    schemaVersion: GENERIC_PROFILE_VERSION,
    layerId: document.layerId,
    layerKind,
    trustLevel: expectedTrust[layerKind],
    releaseVerificationDigest: document.releaseVerificationDigest as string | null,
    fields,
  };
}

function validateOwnerRebind(value: unknown): GenericProfileOwnerRebind {
  const document = asRecord(value, "owner rebind");
  exactFields(document, ["schemaVersion", "approved", "ownerId", "targetLayerId", "replacement"],
    ["schemaVersion", "approved", "ownerId", "targetLayerId", "replacement"], "owner rebind");
  if (document.schemaVersion !== GENERIC_PROFILE_OWNER_REBIND_VERSION || document.approved !== true) {
    fail("PROFILE_OWNER_REBIND_INVALID", "owner rebind admission");
  }
  assertStableId(document.ownerId, "owner rebind ownerId");
  assertStableId(document.targetLayerId, "owner rebind targetLayerId");
  const replacement = validateOwnerFields(document.replacement, "owner rebind replacement");
  if (["unbound_read_only", "cold_standby"].includes(replacement.activeBinding.mode) || replacement.escalationOwner === null) {
    fail("PROFILE_OWNER_REBIND_INVALID", "owner rebind must establish an active binding and escalation owner");
  }
  return {
    schemaVersion: GENERIC_PROFILE_OWNER_REBIND_VERSION,
    approved: true,
    ownerId: document.ownerId,
    targetLayerId: document.targetLayerId,
    replacement,
  };
}

function starterBasis(): Omit<GenericProfileStarterBundle, "bundleDigest"> {
  const frameworkLayer = validateGenericProfileLayer({
    schemaVersion: GENERIC_PROFILE_VERSION,
    layerId: "profile-layer:generic-framework-defaults",
    layerKind: "framework_defaults",
    trustLevel: "framework_profile",
    releaseVerificationDigest: null,
    fields: {
      immutable: {
        identity: {
          profileId: "profile:generic-workflow-v1",
          authorityId: "authority:framework-defaults",
          authorityKind: "framework",
        },
        baseMission: "maintain-local-planned-delivery-graph",
        mandatorySafety: [
          "canonical-deterministic-outputs",
          "expected-version-cas",
          "preserve-authoritative-event-chain",
        ],
        mandatoryRefusals: [
          "deny-external-authority-inference",
          "deny-network-database-hooks-and-code",
          "deny-unbound-mutation",
        ],
        protocolVersion: 1,
        profileSchemaVersion: 1,
      },
      restrictOnly: {
        writePaths: [".tcrn-workflow"],
        tools: ["node-filesystem"],
        budgets: {
          maximumOperations: 256,
          maximumWrites: 64,
          maximumEvidenceBytes: 1_048_576,
        },
        dataClassifications: ["public", "workspace-internal"],
        allowedOperations: [...GENERIC_PROFILE_OPERATIONS],
      },
      ownerRebindOnly: {
        activeBinding: {
          mode: "unbound_read_only",
          workspaceId: null,
          projectId: null,
          command: null,
        },
        roleReplacement: null,
        projectAuthority: null,
        escalationOwner: null,
      },
      displayOnly: {
        label: "Generic Workflow Profile",
        description: "Inert local defaults for a bounded planned-delivery graph.",
        examples: ["empty-workspace", "local-planned-delivery"],
        presentation: {
          category: "workflow",
          audience: "workspace-owner",
        },
      },
    },
  });
  return {
    schemaVersion: GENERIC_PROFILE_BUNDLE_VERSION,
    layers: [frameworkLayer],
    starterFlow: [
      { kind: "Initiative", parentKind: null },
      { kind: "Epic", parentKind: "Initiative" },
      { kind: "Story", parentKind: "Epic" },
      { kind: "Subtask", parentKind: "Story" },
    ],
  };
}

export function generateGenericStarterBundle(): GenericProfileStarterBundle {
  const basis = starterBasis();
  return validateGenericStarterBundle({ ...basis, bundleDigest: canonicalSha256(basis) });
}

export function validateGenericStarterBundle(value: unknown): GenericProfileStarterBundle {
  const document = asRecord(value, "starter bundle");
  exactFields(document, ["schemaVersion", "layers", "starterFlow", "bundleDigest"],
    ["schemaVersion", "layers", "starterFlow", "bundleDigest"], "starter bundle");
  if (document.schemaVersion !== GENERIC_PROFILE_BUNDLE_VERSION || !Array.isArray(document.layers) ||
    document.layers.length === 0 || document.layers.length > 6 || !Array.isArray(document.starterFlow) ||
    document.starterFlow.length !== 4) {
    fail("PROFILE_BUNDLE_INVALID", "starter bundle structure");
  }
  assertSha256(document.bundleDigest, "starter bundle digest");
  const layers = document.layers.map((layer) => validateGenericProfileLayer(layer));
  const expectedFlow = starterBasis().starterFlow;
  if (safeCanonical(document.starterFlow, "starter flow") !== safeCanonical(expectedFlow, "starter flow")) {
    fail("PROFILE_BUNDLE_INVALID", "starter flow");
  }
  const basis = { schemaVersion: GENERIC_PROFILE_BUNDLE_VERSION, layers, starterFlow: expectedFlow };
  if (canonicalSha256(basis) !== document.bundleDigest) fail("PROFILE_BUNDLE_INVALID", "starter bundle digest mismatch");
  return { ...basis, bundleDigest: document.bundleDigest };
}

function arraySubset(next: readonly string[], current: readonly string[], label: string): void {
  if (next.some((entry) => !current.includes(entry))) fail("PROFILE_RESTRICTION_EXPANSION", label);
}

function mergeRestrictOnly(
  current: GenericProfileRestrictOnlyFields,
  next: GenericProfileRestrictOnlyFields,
): GenericProfileRestrictOnlyFields {
  arraySubset(next.writePaths, current.writePaths, "writePaths");
  arraySubset(next.tools, current.tools, "tools");
  arraySubset(next.dataClassifications, current.dataClassifications, "dataClassifications");
  arraySubset(next.allowedOperations, current.allowedOperations, "allowedOperations");
  if (next.budgets.maximumOperations > current.budgets.maximumOperations ||
    next.budgets.maximumWrites > current.budgets.maximumWrites ||
    next.budgets.maximumEvidenceBytes > current.budgets.maximumEvidenceBytes) {
    fail("PROFILE_RESTRICTION_EXPANSION", "budgets");
  }
  return next;
}

export function resolveGenericProfile(value: unknown): EffectiveGenericProfile {
  const document = asRecord(value, "resolution request");
  exactFields(document, ["schemaVersion", "layers", "ownerRebind", "admittedReleaseProfileDigests"],
    ["schemaVersion", "layers", "ownerRebind", "admittedReleaseProfileDigests"], "resolution request");
  if (document.schemaVersion !== "tcrn.generic-profile-resolution-request.v1" || !Array.isArray(document.layers) ||
    document.layers.length === 0 || document.layers.length > 6) {
    fail("PROFILE_INPUT_INVALID", "resolution request structure");
  }
  const admittedReleaseProfileDigests = canonicalStringList(
    document.admittedReleaseProfileDigests,
    "resolution request admittedReleaseProfileDigests",
    (entry, label) => {
      assertSha256(entry, label);
      return entry;
    },
    6,
  );
  const ownerRebind = document.ownerRebind === null ? null : validateOwnerRebind(document.ownerRebind);
  const layers = document.layers.map((layer) => validateGenericProfileLayer(layer));
  const layerIds = layers.map((layer) => layer.layerId);
  if (new Set(layerIds).size !== layerIds.length) fail("PROFILE_DUPLICATE_LAYER", "layerId");
  const layerKinds = layers.map((layer) => layer.layerKind);
  if (new Set(layerKinds).size !== layerKinds.length) fail("PROFILE_DUPLICATE_LAYER", "layerKind");
  const sorted = [...layers].sort((left, right) => {
    const rank = precedence[left.layerKind] - precedence[right.layerKind];
    return rank === 0 ? compareCanonicalText(left.layerId, right.layerId) : rank;
  });
  const baseLayers = sorted.filter((layer) => layer.layerKind === "framework_defaults");
  if (baseLayers.length !== 1) fail("PROFILE_PRECEDENCE_AMBIGUOUS", "one framework_defaults layer is required");
  for (const layer of sorted.filter((entry) => entry.layerKind === "release_verified_framework_profile")) {
    if (!admittedReleaseProfileDigests.includes(canonicalSha256(layer))) {
      fail("PROFILE_RELEASE_UNVERIFIED", layer.layerId);
    }
  }
  const base = baseLayers[0];
  if (!base.fields.immutable || !base.fields.restrictOnly || !base.fields.ownerRebindOnly || !base.fields.displayOnly) {
    fail("PROFILE_SCHEMA_INVALID", "framework defaults merge matrix");
  }
  let immutable = base.fields.immutable;
  let restrictOnly = base.fields.restrictOnly;
  let ownerRebindOnly = base.fields.ownerRebindOnly;
  let displayOnly = base.fields.displayOnly;
  let rebindApplied = false;
  for (const layer of sorted.slice(1)) {
    if (layer.fields.immutable) {
      if (safeCanonical(layer.fields.immutable.mandatoryRefusals, "mandatory refusals") !==
        safeCanonical(immutable.mandatoryRefusals, "mandatory refusals")) {
        fail("PROFILE_REFUSAL_WEAKENING", layer.layerId);
      }
      if (safeCanonical(layer.fields.immutable, "immutable") !== safeCanonical(immutable, "immutable")) {
        fail("PROFILE_FIELD_IMMUTABLE", layer.layerId);
      }
      immutable = layer.fields.immutable;
    }
    if (layer.fields.restrictOnly) restrictOnly = mergeRestrictOnly(restrictOnly, layer.fields.restrictOnly);
    if (layer.fields.ownerRebindOnly &&
      safeCanonical(layer.fields.ownerRebindOnly, "owner fields") !== safeCanonical(ownerRebindOnly, "owner fields")) {
      if (layer.trustLevel !== "user_owned_overlay" || ownerRebind === null || ownerRebind.targetLayerId !== layer.layerId ||
        safeCanonical(ownerRebind.replacement, "owner rebind") !== safeCanonical(layer.fields.ownerRebindOnly, "owner fields")) {
        fail("PROFILE_OWNER_REBIND_REQUIRED", layer.layerId);
      }
      ownerRebindOnly = layer.fields.ownerRebindOnly;
      rebindApplied = true;
    }
    if (layer.fields.displayOnly) displayOnly = layer.fields.displayOnly;
  }
  if (ownerRebind !== null && !rebindApplied) fail("PROFILE_OWNER_REBIND_INVALID", ownerRebind.targetLayerId);
  const resolution = ownerRebindOnly.activeBinding.mode === "cold_standby"
    ? "cold_standby"
    : ownerRebindOnly.activeBinding.mode === "unbound_read_only"
      ? "unbound_read_only"
      : "bound";
  const profileDigests = sorted.map((layer) => ({ layerId: layer.layerId, digest: canonicalSha256(layer) }));
  const effectivePolicy = { immutable, restrictOnly, ownerRebindOnly, displayOnly };
  const withoutDigest = {
    schemaVersion: GENERIC_PROFILE_EFFECTIVE_VERSION,
    resolution,
    sourceLayerIds: sorted.map((layer) => layer.layerId),
    trustSummary: {
      frameworkProfiles: sorted.filter((layer) => layer.trustLevel === "framework_profile").length,
      userOwnedOverlays: sorted.filter((layer) => layer.trustLevel === "user_owned_overlay").length,
      importedUntrusted: sorted.filter((layer) => layer.trustLevel === "imported_untrusted").length,
    },
    ...effectivePolicy,
    baseDigest: canonicalSha256(base),
    profileDigests,
    overlayDigest: canonicalSha256(profileDigests.slice(1)),
    effectivePolicyDigest: canonicalSha256(effectivePolicy),
  };
  return { ...withoutDigest, effectiveDigest: canonicalSha256(withoutDigest) };
}

export function validateEffectiveGenericProfile(value: unknown): EffectiveGenericProfile {
  const document = asRecord(value, "effective profile");
  exactFields(
    document,
    ["schemaVersion", "resolution", "sourceLayerIds", "trustSummary", "immutable", "restrictOnly", "ownerRebindOnly",
      "displayOnly", "baseDigest", "profileDigests", "overlayDigest", "effectivePolicyDigest", "effectiveDigest"],
    ["schemaVersion", "resolution", "sourceLayerIds", "trustSummary", "immutable", "restrictOnly", "ownerRebindOnly",
      "displayOnly", "baseDigest", "profileDigests", "overlayDigest", "effectivePolicyDigest", "effectiveDigest"],
    "effective profile",
  );
  if (document.schemaVersion !== GENERIC_PROFILE_EFFECTIVE_VERSION ||
    !["bound", "unbound_read_only", "cold_standby"].includes(String(document.resolution))) {
    fail("PROFILE_SCHEMA_INVALID", "effective profile header");
  }
  if (!Array.isArray(document.sourceLayerIds) || document.sourceLayerIds.length === 0 || document.sourceLayerIds.length > 6) {
    fail("PROFILE_SCHEMA_INVALID", "effective profile sourceLayerIds");
  }
  const sourceLayerIds = document.sourceLayerIds.map((entry, index) => {
    assertStableId(entry, `effective profile sourceLayerIds[${index}]`);
    return entry;
  });
  if (new Set(sourceLayerIds).size !== sourceLayerIds.length) {
    fail("PROFILE_DUPLICATE_LAYER", "effective profile sourceLayerIds");
  }
  const trustSummaryDocument = asRecord(document.trustSummary, "effective profile trustSummary");
  exactFields(trustSummaryDocument, ["frameworkProfiles", "userOwnedOverlays", "importedUntrusted"],
    ["frameworkProfiles", "userOwnedOverlays", "importedUntrusted"], "effective profile trustSummary");
  const trustSummary = {
    frameworkProfiles: boundedInteger(trustSummaryDocument.frameworkProfiles, "frameworkProfiles", 6),
    userOwnedOverlays: boundedInteger(trustSummaryDocument.userOwnedOverlays, "userOwnedOverlays", 6),
    importedUntrusted: boundedInteger(trustSummaryDocument.importedUntrusted, "importedUntrusted", 6),
  };
  const immutable = validateImmutable(document.immutable, "effective profile immutable");
  const restrictOnly = validateRestrictOnly(document.restrictOnly, "effective profile restrictOnly");
  const ownerRebindOnly = validateOwnerFields(document.ownerRebindOnly, "effective profile ownerRebindOnly");
  const displayOnly = validateDisplay(document.displayOnly, "effective profile displayOnly");
  for (const field of ["baseDigest", "overlayDigest", "effectivePolicyDigest", "effectiveDigest"] as const) {
    assertSha256(document[field], `effective profile ${field}`);
  }
  if (!Array.isArray(document.profileDigests) || document.profileDigests.length !== sourceLayerIds.length) {
    fail("PROFILE_SCHEMA_INVALID", "effective profile profileDigests");
  }
  const profileDigests = document.profileDigests.map((entry, index) => {
    const record = asRecord(entry, `effective profile profileDigests[${index}]`);
    exactFields(record, ["layerId", "digest"], ["layerId", "digest"], `effective profile profileDigests[${index}]`);
    assertStableId(record.layerId, `effective profile profileDigests[${index}].layerId`);
    assertSha256(record.digest, `effective profile profileDigests[${index}].digest`);
    if (record.layerId !== sourceLayerIds[index]) fail("PROFILE_CANONICAL_INVALID", "effective profile digest order");
    return { layerId: record.layerId, digest: record.digest };
  });
  const resolution = document.resolution as EffectiveGenericProfile["resolution"];
  const expectedResolution = ownerRebindOnly.activeBinding.mode === "cold_standby"
    ? "cold_standby"
    : ownerRebindOnly.activeBinding.mode === "unbound_read_only"
      ? "unbound_read_only"
      : "bound";
  if (resolution !== expectedResolution) fail("PROFILE_SCHEMA_INVALID", "effective profile resolution/binding mismatch");
  if (trustSummary.frameworkProfiles < 1 ||
    trustSummary.frameworkProfiles + trustSummary.userOwnedOverlays + trustSummary.importedUntrusted !== sourceLayerIds.length) {
    fail("PROFILE_TRUST_INVALID", "effective profile trust summary");
  }
  const withoutDigest = {
    schemaVersion: GENERIC_PROFILE_EFFECTIVE_VERSION,
    resolution,
    sourceLayerIds,
    trustSummary,
    immutable,
    restrictOnly,
    ownerRebindOnly,
    displayOnly,
    baseDigest: document.baseDigest as string,
    profileDigests,
    overlayDigest: document.overlayDigest as string,
    effectivePolicyDigest: document.effectivePolicyDigest as string,
  };
  if (canonicalSha256({ immutable, restrictOnly, ownerRebindOnly, displayOnly }) !== document.effectivePolicyDigest ||
    canonicalSha256(withoutDigest) !== document.effectiveDigest) {
    fail("PROFILE_CANONICAL_INVALID", "effective profile digest");
  }
  return { ...withoutDigest, effectiveDigest: document.effectiveDigest as string };
}

const readOnlyOperations: readonly GenericProfileOperation[] = Object.freeze([
  "profile.read",
  "view.generate",
  "workspace.read",
  "workspace.validate",
]);

export function authorizeGenericProfileOperation(
  profileValue: unknown,
  operationValue: unknown,
  contextValue: unknown,
): Readonly<Record<string, string>> {
  const profile = validateEffectiveGenericProfile(profileValue);
  const requestedOperation = operation(operationValue, "authorization operation");
  const contextDocument = asRecord(contextValue, "authorization context");
  exactFields(contextDocument, ["workspaceId", "projectId", "command"], ["workspaceId", "projectId", "command"], "authorization context");
  const context: GenericProfileAuthorizationContext = {
    workspaceId: nullableStableId(contextDocument.workspaceId, "authorization context workspaceId"),
    projectId: nullableStableId(contextDocument.projectId, "authorization context projectId"),
    command: contextDocument.command === null
      ? null
      : typeof contextDocument.command === "string" && /^[a-z][a-z0-9:-]{1,63}$/u.test(contextDocument.command)
        ? contextDocument.command
        : fail("PROFILE_SCHEMA_INVALID", "authorization context command"),
  };
  if (profile.resolution === "cold_standby") fail("PROFILE_COLD_STANDBY", requestedOperation);
  if (profile.resolution === "unbound_read_only" && !readOnlyOperations.includes(requestedOperation)) {
    fail("PROFILE_BINDING_REQUIRED", requestedOperation);
  }
  if (!profile.restrictOnly.allowedOperations.includes(requestedOperation)) fail("PROFILE_OPERATION_DENIED", requestedOperation);
  const binding = profile.ownerRebindOnly.activeBinding;
  const mismatch = binding.mode === "workspace"
    ? context.workspaceId !== binding.workspaceId
    : binding.mode === "project"
      ? context.workspaceId !== binding.workspaceId || context.projectId !== binding.projectId
      : binding.mode === "command"
        ? context.workspaceId !== binding.workspaceId || context.projectId !== binding.projectId || context.command !== binding.command
        : false;
  if (mismatch) fail("PROFILE_BINDING_MISMATCH", requestedOperation);
  return {
    reasonCode: "PROFILE_OPERATION_AUTHORIZED",
    operation: requestedOperation,
    effectiveDigest: profile.effectiveDigest,
    bindingMode: binding.mode,
  };
}
