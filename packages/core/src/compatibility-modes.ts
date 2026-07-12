// SPDX-License-Identifier: Apache-2.0

import {
  assertProtocolId,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  parseStrictInstant,
} from "../../protocol/src/index.js";

export const COMPATIBILITY_MANIFEST_VERSION = "tcrn.workflow-compatibility-manifest.v1" as const;
export const COMPATIBILITY_RECEIPT_VERSION = "tcrn.compatibility-pair-receipt.v1" as const;
export const COMPATIBILITY_REQUEST_VERSION = "tcrn.compatibility-request.v1" as const;
export const COMPATIBILITY_ADMISSION_VERSION = "tcrn.compatibility-admission.v1" as const;
export const COMPATIBILITY_RESULT_VERSION = "tcrn.compatibility-plan.v1" as const;

export const COMPATIBILITY_LIMITS = Object.freeze({
  maximumDefinitions: 128,
  maximumOperationalFields: 64,
  maximumExternalEffects: 128,
  maximumStringBytes: 512,
  maximumDocumentBytes: 262_144,
});

export const COMPATIBILITY_REASON_CODES = Object.freeze([
  "COMPATIBILITY_INPUT_INVALID",
  "COMPATIBILITY_UNKNOWN_FIELD",
  "COMPATIBILITY_UNICODE_INVALID",
  "COMPATIBILITY_LIMIT_EXCEEDED",
  "COMPATIBILITY_CANONICAL_INVALID",
  "COMPATIBILITY_MANIFEST_VALID",
  "COMPATIBILITY_MANIFEST_MISMATCH",
  "COMPATIBILITY_REFERENCE_MISMATCH",
  "COMPATIBILITY_RECEIPT_UNAUTHENTICATED",
  "COMPATIBILITY_RECEIPT_EXPIRED",
  "COMPATIBILITY_RECEIPT_REVOKED",
  "COMPATIBILITY_RECEIPT_REPLAYED",
  "COMPATIBILITY_POLICY_ROLLBACK",
  "COMPATIBILITY_WORKSPACE_LOCK_REQUIRED",
  "COMPATIBILITY_INSTANCE_MISMATCH",
  "COMPATIBILITY_DATA_EPOCH_MISMATCH",
  "COMPATIBILITY_SPLIT_BRAIN",
  "COMPATIBILITY_CHECKPOINT_STALE",
  "COMPATIBILITY_FIELD_OWNERSHIP_CONFLICT",
  "COMPATIBILITY_EXTERNAL_EFFECT_DUPLICATE",
  "COMPATIBILITY_PLAN_READY",
  "COMPATIBILITY_DRY_RUN_READY",
  "COMPATIBILITY_CAPABILITY_UNAVAILABLE",
] as const);

export type CompatibilityReasonCode = typeof COMPATIBILITY_REASON_CODES[number];
export type CompatibilityOperation =
  | "initial_import"
  | "portable_checkpoint"
  | "fallback_admission"
  | "fallback_delta"
  | "conflict_plan"
  | "reconciliation_dry_run";
export type CompatibilityUnavailableSurface =
  | "aos_primary"
  | "fallback_activation"
  | "import_apply"
  | "reconciliation_apply";

export class CompatibilityError extends Error {
  readonly reasonCode: CompatibilityReasonCode;
  constructor(reasonCode: CompatibilityReasonCode, message: string) {
    super(message);
    this.name = "CompatibilityError";
    this.reasonCode = reasonCode;
  }
}

export interface WorkflowCompatibilityManifest {
  readonly schemaVersion: typeof COMPATIBILITY_MANIFEST_VERSION;
  readonly repositoryId: string;
  readonly workflowId: string;
  readonly subjectId: string;
  readonly releaseId: string;
  readonly protocolVersion: number;
  readonly policyEpoch: number;
  readonly policyVersion: number;
  readonly instanceId: string;
  readonly dataEpoch: number;
  readonly definitionsDigest: string;
  readonly workflowOwnedFields: readonly string[];
  readonly aosOwnedOperationalFields: readonly string[];
  readonly supportedAosReleases: readonly string[];
  readonly manifestDigest: string;
}

export interface CompatibilityPairReceipt {
  readonly schemaVersion: typeof COMPATIBILITY_RECEIPT_VERSION;
  readonly receiptId: string;
  readonly repositoryId: string;
  readonly workflowId: string;
  readonly subjectId: string;
  readonly workflowReleaseId: string;
  readonly aosReleaseId: string;
  readonly signerId: string;
  readonly issuerId: string;
  readonly audience: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly policyEpoch: number;
  readonly policyVersion: number;
  readonly instanceId: string;
  readonly dataEpoch: number;
  readonly workflowManifestDigest: string;
  readonly aosManifestDigest: string;
  readonly verdict: "mutual_compatible";
  readonly revoked: false;
  readonly receiptDigest: string;
}

export interface CompatibilityCheckpoint {
  readonly checkpointId: string;
  readonly version: number;
  readonly instanceId: string;
  readonly dataEpoch: number;
  readonly stateDigest: string;
}

export interface CompatibilityRequest {
  readonly schemaVersion: typeof COMPATIBILITY_REQUEST_VERSION;
  readonly operation: CompatibilityOperation;
  readonly workspaceId: string;
  readonly manifest: WorkflowCompatibilityManifest;
  readonly pairReceipt: CompatibilityPairReceipt;
  readonly checkpoint: CompatibilityCheckpoint | null;
  readonly workflowDefinitions: Readonly<Record<string, unknown>>;
  readonly aosOperationalState: Readonly<Record<string, unknown>>;
  readonly externalEffectIds: readonly string[];
  readonly requestDigest: string;
}

export interface CompatibilityWorkspaceLock {
  readonly workspaceId: string;
  readonly lockId: string;
  readonly generation: number;
  readonly valid: true;
}

export interface CompatibilityAdmissionContext {
  readonly schemaVersion: typeof COMPATIBILITY_ADMISSION_VERSION;
  readonly authenticatedPairReceiptDigest: string;
  readonly expectedRepositoryId: string;
  readonly expectedWorkflowId: string;
  readonly expectedSubjectId: string;
  readonly expectedSignerId: string;
  readonly expectedIssuerId: string;
  readonly expectedAudience: string;
  readonly expectedNonce: string;
  readonly verificationTime: string;
  readonly minimumPolicyEpoch: number;
  readonly minimumPolicyVersion: number;
  readonly expectedInstanceId: string;
  readonly expectedDataEpoch: number;
  readonly revokedReceiptIds: readonly string[];
  readonly consumedReceiptIds: readonly string[];
  readonly workspaceLock: CompatibilityWorkspaceLock;
  readonly activeAos: false;
  readonly admissionDigest: string;
}

export interface CompatibilityPlan {
  readonly schemaVersion: typeof COMPATIBILITY_RESULT_VERSION;
  readonly reasonCode: "COMPATIBILITY_PLAN_READY" | "COMPATIBILITY_DRY_RUN_READY";
  readonly operation: CompatibilityOperation;
  readonly workspaceId: string;
  readonly requestDigest: string;
  readonly manifestDigest: string;
  readonly receiptDigest: string;
  readonly state: "planned" | "checkpoint_planned" | "fallback_planned" | "conflicts_planned" | "reconciliation_planned";
  readonly workflowDefinitionKeys: readonly string[];
  readonly preservedAosOperationalKeys: readonly string[];
  readonly conflicts: readonly string[];
  readonly externalEffectIds: readonly string[];
  readonly mutation: false;
  readonly network: false;
  readonly planDigest: string;
}

const manifestFields = ["schemaVersion", "repositoryId", "workflowId", "subjectId", "releaseId", "protocolVersion", "policyEpoch", "policyVersion", "instanceId", "dataEpoch", "definitionsDigest", "workflowOwnedFields", "aosOwnedOperationalFields", "supportedAosReleases", "manifestDigest"] as const;
const receiptFields = ["schemaVersion", "receiptId", "repositoryId", "workflowId", "subjectId", "workflowReleaseId", "aosReleaseId", "signerId", "issuerId", "audience", "nonce", "issuedAt", "notBefore", "expiresAt", "policyEpoch", "policyVersion", "instanceId", "dataEpoch", "workflowManifestDigest", "aosManifestDigest", "verdict", "revoked", "receiptDigest"] as const;
const requestFields = ["schemaVersion", "operation", "workspaceId", "manifest", "pairReceipt", "checkpoint", "workflowDefinitions", "aosOperationalState", "externalEffectIds", "requestDigest"] as const;
const admissionFields = ["schemaVersion", "authenticatedPairReceiptDigest", "expectedRepositoryId", "expectedWorkflowId", "expectedSubjectId", "expectedSignerId", "expectedIssuerId", "expectedAudience", "expectedNonce", "verificationTime", "minimumPolicyEpoch", "minimumPolicyVersion", "expectedInstanceId", "expectedDataEpoch", "revokedReceiptIds", "consumedReceiptIds", "workspaceLock", "activeAos", "admissionDigest"] as const;
const operations: readonly CompatibilityOperation[] = Object.freeze(["initial_import", "portable_checkpoint", "fallback_admission", "fallback_delta", "conflict_plan", "reconciliation_dry_run"]);
const unavailableSurfaces: readonly CompatibilityUnavailableSurface[] = Object.freeze(["aos_primary", "fallback_activation", "import_apply", "reconciliation_apply"]);

function fail(reasonCode: CompatibilityReasonCode, message: string): never {
  throw new CompatibilityError(reasonCode, message);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("COMPATIBILITY_INPUT_INVALID", label);
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...expected].sort(compareCanonicalText);
  const unknown = actual.filter((field) => !wanted.includes(field));
  if (unknown.length) fail("COMPATIBILITY_UNKNOWN_FIELD", `${label}:${unknown.join(",")}`);
  const missing = wanted.filter((field) => !actual.includes(field));
  if (missing.length) fail("COMPATIBILITY_INPUT_INVALID", `${label}:${missing.join(",")}`);
}

function text(value: unknown, label: string, maximumBytes = COMPATIBILITY_LIMITS.maximumStringBytes): string {
  if (typeof value !== "string" || !value.isWellFormed()) fail("COMPATIBILITY_UNICODE_INVALID", label);
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes) fail("COMPATIBILITY_LIMIT_EXCEEDED", label);
  return value;
}

function digest(value: unknown, label: string): string {
  const candidate = text(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(candidate)) fail("COMPATIBILITY_INPUT_INVALID", label);
  return candidate;
}

function id(value: unknown, label: string): string {
  const candidate = text(value, label, 161);
  try { assertProtocolId(candidate); } catch { fail("COMPATIBILITY_INPUT_INVALID", label); }
  return candidate;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail("COMPATIBILITY_INPUT_INVALID", label);
  return value as number;
}

function instant(value: unknown, label: string): bigint {
  try { return parseStrictInstant(value); } catch { fail("COMPATIBILITY_INPUT_INVALID", label); }
}

function stringList(value: unknown, label: string, maximum: number, valuesAreIds = false): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) fail("COMPATIBILITY_LIMIT_EXCEEDED", label);
  const result = value.map((item, index) => valuesAreIds ? id(item, `${label}[${index}]`) : text(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) fail("COMPATIBILITY_INPUT_INVALID", `${label}:duplicate`);
  return [...result].sort(compareCanonicalText);
}

function validateJsonValue(value: unknown, label: string, depth = 0): void {
  if (depth > 16) fail("COMPATIBILITY_LIMIT_EXCEEDED", label);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { text(value, label, 4096); return; }
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) fail("COMPATIBILITY_INPUT_INVALID", label); return; }
  if (Array.isArray(value)) { if (value.length > 128) fail("COMPATIBILITY_LIMIT_EXCEEDED", label); value.forEach((item, index) => validateJsonValue(item, `${label}[${index}]`, depth + 1)); return; }
  const object = record(value, label);
  if (Object.keys(object).length > 128) fail("COMPATIBILITY_LIMIT_EXCEEDED", label);
  for (const [key, item] of Object.entries(object)) { text(key, `${label}:key`, 128); validateJsonValue(item, `${label}.${key}`, depth + 1); }
}

function sealedDigest(value: Readonly<Record<string, unknown>>, field: string, reason: CompatibilityReasonCode): void {
  const supplied = digest(value[field], field);
  const unsealed = { ...value }; delete unsealed[field];
  if (canonicalSha256(unsealed) !== supplied) fail(reason, field);
}

export function validateWorkflowCompatibilityManifest(value: unknown): WorkflowCompatibilityManifest {
  const input = record(value, "manifest"); exact(input, manifestFields, "manifest");
  if (input.schemaVersion !== COMPATIBILITY_MANIFEST_VERSION) fail("COMPATIBILITY_INPUT_INVALID", "manifest.schemaVersion");
  for (const field of ["repositoryId", "workflowId", "subjectId", "releaseId", "instanceId"] as const) id(input[field], `manifest.${field}`);
  integer(input.protocolVersion, "manifest.protocolVersion", 1); integer(input.policyEpoch, "manifest.policyEpoch", 1); integer(input.policyVersion, "manifest.policyVersion", 1); integer(input.dataEpoch, "manifest.dataEpoch", 1);
  digest(input.definitionsDigest, "manifest.definitionsDigest");
  const workflow = stringList(input.workflowOwnedFields, "manifest.workflowOwnedFields", COMPATIBILITY_LIMITS.maximumDefinitions);
  const operational = stringList(input.aosOwnedOperationalFields, "manifest.aosOwnedOperationalFields", COMPATIBILITY_LIMITS.maximumOperationalFields);
  if (workflow.some((field) => operational.includes(field))) fail("COMPATIBILITY_FIELD_OWNERSHIP_CONFLICT", "manifest ownership overlap");
  const supported = stringList(input.supportedAosReleases, "manifest.supportedAosReleases", 16, true);
  if (supported.length !== 0) fail("COMPATIBILITY_MANIFEST_MISMATCH", "P7-B supported AOS releases must remain empty");
  sealedDigest(input, "manifestDigest", "COMPATIBILITY_MANIFEST_MISMATCH");
  return input as unknown as WorkflowCompatibilityManifest;
}

function validatePairReceipt(value: unknown): CompatibilityPairReceipt {
  const input = record(value, "pairReceipt"); exact(input, receiptFields, "pairReceipt");
  if (input.schemaVersion !== COMPATIBILITY_RECEIPT_VERSION || input.verdict !== "mutual_compatible" || input.revoked !== false) fail("COMPATIBILITY_RECEIPT_UNAUTHENTICATED", "pairReceipt state");
  for (const field of ["receiptId", "repositoryId", "workflowId", "subjectId", "workflowReleaseId", "aosReleaseId", "signerId", "issuerId", "instanceId"] as const) id(input[field], `pairReceipt.${field}`);
  text(input.audience, "pairReceipt.audience"); text(input.nonce, "pairReceipt.nonce");
  instant(input.issuedAt, "pairReceipt.issuedAt"); instant(input.notBefore, "pairReceipt.notBefore"); instant(input.expiresAt, "pairReceipt.expiresAt");
  integer(input.policyEpoch, "pairReceipt.policyEpoch", 1); integer(input.policyVersion, "pairReceipt.policyVersion", 1); integer(input.dataEpoch, "pairReceipt.dataEpoch", 1);
  digest(input.workflowManifestDigest, "pairReceipt.workflowManifestDigest"); digest(input.aosManifestDigest, "pairReceipt.aosManifestDigest");
  sealedDigest(input, "receiptDigest", "COMPATIBILITY_RECEIPT_UNAUTHENTICATED");
  return input as unknown as CompatibilityPairReceipt;
}

function validateCheckpoint(value: unknown): CompatibilityCheckpoint | null {
  if (value === null) return null;
  const input = record(value, "checkpoint"); exact(input, ["checkpointId", "version", "instanceId", "dataEpoch", "stateDigest"], "checkpoint");
  id(input.checkpointId, "checkpoint.checkpointId"); integer(input.version, "checkpoint.version", 0); id(input.instanceId, "checkpoint.instanceId"); integer(input.dataEpoch, "checkpoint.dataEpoch", 1); digest(input.stateDigest, "checkpoint.stateDigest");
  return input as unknown as CompatibilityCheckpoint;
}

function validateRequest(value: unknown): CompatibilityRequest {
  const input = record(value, "request"); exact(input, requestFields, "request");
  if (input.schemaVersion !== COMPATIBILITY_REQUEST_VERSION || !operations.includes(input.operation as CompatibilityOperation)) fail("COMPATIBILITY_INPUT_INVALID", "request operation");
  id(input.workspaceId, "request.workspaceId");
  const manifest = validateWorkflowCompatibilityManifest(input.manifest);
  const pairReceipt = validatePairReceipt(input.pairReceipt);
  const checkpoint = validateCheckpoint(input.checkpoint);
  const definitions = record(input.workflowDefinitions, "request.workflowDefinitions"); const operational = record(input.aosOperationalState, "request.aosOperationalState");
  if (Object.keys(definitions).length > COMPATIBILITY_LIMITS.maximumDefinitions || Object.keys(operational).length > COMPATIBILITY_LIMITS.maximumOperationalFields) fail("COMPATIBILITY_LIMIT_EXCEEDED", "request records");
  validateJsonValue(definitions, "request.workflowDefinitions"); validateJsonValue(operational, "request.aosOperationalState");
  if (!Array.isArray(input.externalEffectIds)) fail("COMPATIBILITY_INPUT_INVALID", "request.externalEffectIds");
  const rawEffects = input.externalEffectIds.map((effect, index) => id(effect, `request.externalEffectIds[${index}]`));
  if (new Set(rawEffects).size !== rawEffects.length) fail("COMPATIBILITY_EXTERNAL_EFFECT_DUPLICATE", "externalEffectIds");
  const effects = stringList(input.externalEffectIds, "request.externalEffectIds", COMPATIBILITY_LIMITS.maximumExternalEffects, true);
  if (canonicalSha256(definitions) !== manifest.definitionsDigest) fail("COMPATIBILITY_MANIFEST_MISMATCH", "definitionsDigest");
  if (Buffer.byteLength(canonicalJson(input), "utf8") > COMPATIBILITY_LIMITS.maximumDocumentBytes) fail("COMPATIBILITY_LIMIT_EXCEEDED", "request");
  sealedDigest(input, "requestDigest", "COMPATIBILITY_CANONICAL_INVALID");
  return { ...(input as unknown as CompatibilityRequest), manifest, pairReceipt, checkpoint };
}

function validateAdmission(value: unknown): CompatibilityAdmissionContext {
  const input = record(value, "admission"); exact(input, admissionFields, "admission");
  if (input.schemaVersion !== COMPATIBILITY_ADMISSION_VERSION || input.activeAos !== false) fail("COMPATIBILITY_SPLIT_BRAIN", "admission activeAos");
  digest(input.authenticatedPairReceiptDigest, "admission.authenticatedPairReceiptDigest");
  for (const field of ["expectedRepositoryId", "expectedWorkflowId", "expectedSubjectId", "expectedSignerId", "expectedIssuerId", "expectedInstanceId"] as const) id(input[field], `admission.${field}`);
  text(input.expectedAudience, "admission.expectedAudience"); text(input.expectedNonce, "admission.expectedNonce"); instant(input.verificationTime, "admission.verificationTime");
  integer(input.minimumPolicyEpoch, "admission.minimumPolicyEpoch", 1); integer(input.minimumPolicyVersion, "admission.minimumPolicyVersion", 1); integer(input.expectedDataEpoch, "admission.expectedDataEpoch", 1);
  stringList(input.revokedReceiptIds, "admission.revokedReceiptIds", 128, true); stringList(input.consumedReceiptIds, "admission.consumedReceiptIds", 128, true);
  const lock = record(input.workspaceLock, "admission.workspaceLock"); exact(lock, ["workspaceId", "lockId", "generation", "valid"], "admission.workspaceLock");
  id(lock.workspaceId, "admission.workspaceLock.workspaceId"); id(lock.lockId, "admission.workspaceLock.lockId"); integer(lock.generation, "admission.workspaceLock.generation", 1);
  if (lock.valid !== true) fail("COMPATIBILITY_WORKSPACE_LOCK_REQUIRED", "admission.workspaceLock.valid");
  sealedDigest(input, "admissionDigest", "COMPATIBILITY_RECEIPT_UNAUTHENTICATED");
  return structuredClone(input) as unknown as CompatibilityAdmissionContext;
}

export function parseWorkflowCompatibilityManifest(sourceText: unknown): WorkflowCompatibilityManifest {
  if (typeof sourceText !== "string" || !sourceText.isWellFormed()) fail("COMPATIBILITY_UNICODE_INVALID", "manifest bytes");
  let parsed: unknown; try { parsed = JSON.parse(sourceText); } catch { fail("COMPATIBILITY_INPUT_INVALID", "manifest bytes"); }
  if (canonicalJson(parsed) !== sourceText) fail("COMPATIBILITY_CANONICAL_INVALID", "manifest bytes");
  return validateWorkflowCompatibilityManifest(parsed);
}

export function validateCompatibilityRequest(value: unknown): CompatibilityRequest {
  return validateRequest(value);
}

function admit(request: CompatibilityRequest, contextValue: unknown): CompatibilityAdmissionContext {
  const context = validateAdmission(contextValue);
  const receipt = request.pairReceipt; const manifest = request.manifest;
  if (context.authenticatedPairReceiptDigest !== receipt.receiptDigest) fail("COMPATIBILITY_RECEIPT_UNAUTHENTICATED", "authenticated digest");
  const references = [[manifest.repositoryId, receipt.repositoryId, context.expectedRepositoryId], [manifest.workflowId, receipt.workflowId, context.expectedWorkflowId], [manifest.subjectId, receipt.subjectId, context.expectedSubjectId]];
  if (references.some(([a, b, c]) => a !== b || b !== c) || receipt.workflowReleaseId !== manifest.releaseId || receipt.workflowManifestDigest !== manifest.manifestDigest) fail("COMPATIBILITY_REFERENCE_MISMATCH", "mutual references");
  if (receipt.signerId !== context.expectedSignerId || receipt.issuerId !== context.expectedIssuerId || receipt.audience !== context.expectedAudience || receipt.nonce !== context.expectedNonce) fail("COMPATIBILITY_RECEIPT_UNAUTHENTICATED", "pair claims");
  const now = instant(context.verificationTime, "admission.verificationTime");
  if (now < instant(receipt.notBefore, "pairReceipt.notBefore") || now < instant(receipt.issuedAt, "pairReceipt.issuedAt") || now >= instant(receipt.expiresAt, "pairReceipt.expiresAt")) fail("COMPATIBILITY_RECEIPT_EXPIRED", "pair receipt window");
  if (context.revokedReceiptIds.includes(receipt.receiptId)) fail("COMPATIBILITY_RECEIPT_REVOKED", receipt.receiptId);
  if (context.consumedReceiptIds.includes(receipt.receiptId)) fail("COMPATIBILITY_RECEIPT_REPLAYED", receipt.receiptId);
  if (receipt.policyEpoch < context.minimumPolicyEpoch || (receipt.policyEpoch === context.minimumPolicyEpoch && receipt.policyVersion < context.minimumPolicyVersion) || manifest.policyEpoch < context.minimumPolicyEpoch || (manifest.policyEpoch === context.minimumPolicyEpoch && manifest.policyVersion < context.minimumPolicyVersion)) fail("COMPATIBILITY_POLICY_ROLLBACK", "policy floor");
  if (receipt.instanceId !== context.expectedInstanceId || manifest.instanceId !== context.expectedInstanceId) fail("COMPATIBILITY_INSTANCE_MISMATCH", "instance");
  if (receipt.dataEpoch !== context.expectedDataEpoch || manifest.dataEpoch !== context.expectedDataEpoch) fail("COMPATIBILITY_DATA_EPOCH_MISMATCH", "data epoch");
  if (context.workspaceLock.workspaceId !== request.workspaceId) fail("COMPATIBILITY_WORKSPACE_LOCK_REQUIRED", "workspace lock binding");
  return Object.freeze(context);
}

function buildPlan(requestValue: unknown, admissionValue: unknown, dryRun: boolean): CompatibilityPlan {
  const request = validateRequest(requestValue); admit(request, admissionValue);
  const workflowKeys = Object.keys(request.workflowDefinitions).sort(compareCanonicalText);
  const operationalKeys = Object.keys(request.aosOperationalState).sort(compareCanonicalText);
  const workflowAllowed = new Set(request.manifest.workflowOwnedFields);
  const operationalAllowed = new Set(request.manifest.aosOwnedOperationalFields);
  if (workflowKeys.some((key) => !workflowAllowed.has(key)) || operationalKeys.some((key) => !operationalAllowed.has(key)) || workflowKeys.some((key) => operationalAllowed.has(key))) fail("COMPATIBILITY_FIELD_OWNERSHIP_CONFLICT", "field ownership");
  const checkpoint = request.checkpoint;
  if (checkpoint && checkpoint.instanceId !== request.manifest.instanceId) fail("COMPATIBILITY_INSTANCE_MISMATCH", "checkpoint instance");
  if (checkpoint && checkpoint.dataEpoch !== request.manifest.dataEpoch) fail("COMPATIBILITY_DATA_EPOCH_MISMATCH", "checkpoint data epoch");
  if (["fallback_delta", "reconciliation_dry_run"].includes(request.operation) && (!checkpoint || checkpoint.version < request.manifest.policyVersion)) fail("COMPATIBILITY_CHECKPOINT_STALE", "checkpoint version");
  const conflicts = workflowKeys.filter((key) => operationalKeys.includes(key)).sort(compareCanonicalText);
  if (conflicts.length && request.operation !== "conflict_plan" && request.operation !== "reconciliation_dry_run") fail("COMPATIBILITY_FIELD_OWNERSHIP_CONFLICT", "overlapping conflict");
  const state = request.operation === "portable_checkpoint" ? "checkpoint_planned" : request.operation.startsWith("fallback_") ? "fallback_planned" : request.operation === "conflict_plan" ? "conflicts_planned" : request.operation === "reconciliation_dry_run" ? "reconciliation_planned" : "planned";
  const base = {
    schemaVersion: COMPATIBILITY_RESULT_VERSION,
    reasonCode: dryRun ? "COMPATIBILITY_DRY_RUN_READY" as const : "COMPATIBILITY_PLAN_READY" as const,
    operation: request.operation, workspaceId: request.workspaceId, requestDigest: request.requestDigest,
    manifestDigest: request.manifest.manifestDigest, receiptDigest: request.pairReceipt.receiptDigest,
    state, workflowDefinitionKeys: workflowKeys, preservedAosOperationalKeys: operationalKeys,
    conflicts, externalEffectIds: [...request.externalEffectIds].sort(compareCanonicalText), mutation: false as const, network: false as const,
  };
  return { ...base, planDigest: canonicalSha256(base) };
}

export function planCompatibilityMode(request: unknown, admission: unknown): CompatibilityPlan { return buildPlan(request, admission, false); }
export function dryRunCompatibilityMode(request: unknown, admission: unknown): CompatibilityPlan { return buildPlan(request, admission, true); }

export function unavailableCompatibilityCapability(surface: unknown): Readonly<Record<string, unknown>> {
  if (typeof surface !== "string" || !unavailableSurfaces.includes(surface as CompatibilityUnavailableSurface)) fail("COMPATIBILITY_INPUT_INVALID", "surface");
  const base = {
    reasonCode: "COMPATIBILITY_CAPABILITY_UNAVAILABLE" as const,
    disposition: "capability_unavailable_until_mutual_release" as const,
    surface: surface as CompatibilityUnavailableSurface,
    supportedAosReleases: [] as readonly string[],
    mutation: false as const,
    network: false as const,
  };
  return { ...base, resultDigest: canonicalSha256(base) };
}
