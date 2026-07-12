// SPDX-License-Identifier: Apache-2.0

export const FRAMEWORK_VERSION = "0.0.0-development" as const;
export const DEFAULT_MODE = "development" as const;

export type WorkflowMode = "development" | "release";

export type RootKind =
  | "framework"
  | "workspace"
  | "transient"
  | "evidence-locator"
  | "release-trust";

export interface ExplicitRoot {
  readonly kind: RootKind;
  readonly path: string;
}

export interface DevelopmentAdmission {
  readonly admitted: true;
  readonly mode: "development";
  readonly projectCommandNetwork: "process-guarded-offline";
  readonly osNetworkSandbox: "not-provided";
  readonly telemetry: "disabled";
}

export interface ReleaseAdmissionRequest {
  readonly mode: "release";
  readonly trustRootPath: string;
  readonly bundlePath: string;
  readonly subject: string;
  readonly repository: string;
  readonly workflow: string;
}

export function admitDevelopment(): DevelopmentAdmission {
  return {
    admitted: true,
    mode: DEFAULT_MODE,
    projectCommandNetwork: "process-guarded-offline",
    osNetworkSandbox: "not-provided",
    telemetry: "disabled",
  };
}

export { assertDistinctRoots, RootIdentityError } from "./root-identity.js";
export type { CanonicalRoot } from "./root-identity.js";
export {
  WORKSPACE_CONTROL_DIRECTORY,
  WORKSPACE_REASON_CODES,
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_STORAGE_VERSION,
  WorkspaceError,
  acquireWorkspaceLease,
  applyWorkspaceMigration,
  assertSupportedWorkspaceFilesystem,
  assertWorkspaceRecordCount,
  assertWorkspaceRelativePath,
  createProject,
  createWorkspaceArchive,
  createWork,
  deleteProject,
  deleteWork,
  exportWorkspace,
  initializeWorkspace,
  materializeWorkspace,
  planWorkspaceMigration,
  rebuildWorkspaceViews,
  recoverWorkspace,
  transitionWork,
  updateProject,
  validateWorkspace,
  withWorkspaceLease,
} from "./workspace.js";
export type {
  ProjectRecord,
  WorkspaceCrashPoint,
  WorkspaceLease,
  WorkspaceMetadata,
  WorkspaceMigrationPlan,
  WorkspaceMutationOptions,
  WorkspaceReasonCode,
  WorkspaceState,
} from "./workspace.js";
export {
  ARTIFACT_ARCHIVE_SCHEMA_VERSION,
  ARTIFACT_LIFECYCLE_VERSION,
  ARTIFACT_LIMITS,
  ARTIFACT_REASON_CODES,
  ARTIFACT_RECORD_SCHEMA_VERSION,
  ARTIFACT_STORE_SCHEMA_VERSION,
  ArtifactLifecycleError,
  applyArtifactArchive,
  artifactArchiveDryRun,
  artifactCompactDryRun,
  artifactDoctor,
  artifactSizeReport,
  assertArtifactRelativePath,
  classifyArtifact,
  initializeArtifactStore,
  redactArtifactReference,
  restoreArtifactArchive,
} from "./artifact-lifecycle.js";
export type {
  ArtifactArchiveOptions,
  ArtifactClassification,
  ArtifactDoctorBudgets,
  ArtifactFaultPoint,
  ArtifactKind,
  ArtifactReasonCode,
  ArtifactRecord,
  ArtifactScanOptions,
} from "./artifact-lifecycle.js";
export {
  KNOWLEDGE_CORE_VERSION,
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_METADATA_SCHEMA_VERSION,
  KNOWLEDGE_REASON_CODES,
  KNOWLEDGE_STORE_SCHEMA_VERSION,
  KnowledgeCoreError,
  createKnowledgeUnit,
  evaluateKnowledgeFreshness,
  exportKnowledgeCheckpoint,
  initializeKnowledgeStore,
  listKnowledgeMetadata,
  readKnowledgeBody,
  readKnowledgeSnippet,
  transitionKnowledgePromotion,
  validateKnowledgeStore,
} from "./knowledge-core.js";
export type {
  CreateKnowledgeUnitInput,
  KnowledgeBodyReadOptions,
  KnowledgeCategory,
  KnowledgeExportDisposition,
  KnowledgeFaultPoint,
  KnowledgeFreshnessState,
  KnowledgeKind,
  KnowledgeLifecycle,
  KnowledgeListQuery,
  KnowledgeMutationOptions,
  KnowledgePromotionState,
  KnowledgeReadOptions,
  KnowledgeReasonCode,
  KnowledgeRetrievalDisposition,
  KnowledgeScope,
  KnowledgeStalenessPolicy,
  KnowledgeUnitMetadata,
} from "./knowledge-core.js";
export {
  CONTEXT_ROUTE_AUTHORITY_VERSION,
  CONTEXT_ROUTE_LIMITS,
  CONTEXT_ROUTE_REASON_CODES,
  CONTEXT_ROUTE_REQUEST_VERSION,
  CONTEXT_ROUTE_RESULT_VERSION,
  ContextRouteError,
  calculateContextRouteRequestDigest,
  readContextRouteAuthorityReceipt,
  routeContext,
  validateContextRouteRequest,
  validateContextRouteAuthorityReceipt,
  validateContextRouteResult,
} from "./context-router.js";
export {
  CODEX_ADAPTER_BUNDLE_VERSION,
  CODEX_ADAPTER_FALLBACK_VERSION,
  CODEX_ADAPTER_HOST_VERSION,
  CODEX_ADAPTER_LIFECYCLE_VERSION,
  CODEX_ADAPTER_INSTALLATION_VERSION,
  CODEX_ADAPTER_REASON_CODES,
  CODEX_ADAPTER_REQUEST_VERSION,
  CODEX_ADAPTER_TEMPLATE_PATHS,
  CodexAdapterError,
  admitCodexAdapterHostInput,
  calculateCodexAdapterRequestDigest,
  codexAdapterAuthorityEmptyFallback,
  generateCodexAdapterBundle,
  planCodexAdapterRollback,
  readCodexAdapterInstallationReceipt,
  simulateCodexAdapterLifecycle,
  validateCodexAdapterBundle,
  validateCodexAdapterRequest,
} from "./codex-adapter.js";
export type {
  CodexAdapterBundle,
  CodexAdapterFile,
  CodexAdapterGovernedAction,
  CodexAdapterHostContext,
  CodexAdapterHostInput,
  CodexAdapterInstallationContext,
  CodexAdapterInstallationEntry,
  CodexAdapterInstallationFileIdentity,
  CodexAdapterInstallationReadOptions,
  CodexAdapterInstallationReceipt,
  CodexAdapterReasonCode,
  CodexAdapterRequest,
} from "./codex-adapter.js";
export type {
  ContextBudgets,
  ContextExplicitReadCandidate,
  ContextFreshness,
  ContextMetadataCandidate,
  ContextRiskTier,
  ContextRouteAuthorityContext,
  ContextRouteAuthorityFileIdentity,
  ContextRouteAuthorityReceipt,
  ContextRouteOptions,
  ContextRouteReasonCode,
  ContextRouteRequest,
  ContextScope,
  ContextTaskKind,
} from "./context-router.js";
export {
  GENERIC_PROFILE_BUNDLE_VERSION,
  GENERIC_PROFILE_ADMISSION_RECEIPT_VERSION,
  GENERIC_PROFILE_BASE_DIGEST,
  GENERIC_PROFILE_EFFECTIVE_VERSION,
  GENERIC_PROFILE_OPERATIONS,
  GENERIC_PROFILE_OWNER_REBIND_VERSION,
  GENERIC_PROFILE_REASON_CODES,
  GENERIC_PROFILE_VERSION,
  GenericProfileError,
  authorizeGenericProfileOperation,
  calculateGenericProfileAdmissionClaims,
  generateGenericStarterBundle,
  readGenericProfileAdmissionReceipt,
  resolveGenericProfile,
  validateEffectiveGenericProfile,
  validateGenericProfileBinding,
  validateGenericProfileLayer,
  validateGenericStarterBundle,
} from "./generic-profile.js";
export {
  CANONICAL_EXCHANGE_LIMITS,
  CANONICAL_EXCHANGE_MANIFEST_VERSION,
  CANONICAL_EXCHANGE_REASON_CODES,
  CANONICAL_EXCHANGE_REQUEST_VERSION,
  CANONICAL_EXCHANGE_RESUME_VERSION,
  CANONICAL_EXCHANGE_TRANSACTION_VERSION,
  CanonicalExchangeError,
  dryRunCanonicalExchange,
  planCanonicalExchange,
  readCanonicalExchangeBundle,
  validateCanonicalExchangeBundle,
  writeCanonicalExchangeBundle,
} from "./canonical-exchange.js";
export {
  COMPATIBILITY_ADMISSION_VERSION,
  COMPATIBILITY_LIMITS,
  COMPATIBILITY_MANIFEST_VERSION,
  COMPATIBILITY_REASON_CODES,
  COMPATIBILITY_RECEIPT_VERSION,
  COMPATIBILITY_REQUEST_VERSION,
  COMPATIBILITY_RESULT_VERSION,
  CompatibilityError,
  calculateCompatibilityEffectivePlanDigest,
  dryRunCompatibilityMode,
  parseWorkflowCompatibilityManifest,
  planCompatibilityMode,
  readCompatibilityAdmissionReceipt,
  unavailableCompatibilityCapability,
  validateCompatibilityRequest,
  validateWorkflowCompatibilityManifest,
} from "./compatibility-modes.js";
export type {
  CompatibilityAdmissionContext,
  CompatibilityAdmissionAuthority,
  CompatibilityAdmissionReadOptions,
  CompatibilityAdmissionReceipt,
  CompatibilityCheckpoint,
  CompatibilityOperation,
  CompatibilityPairReceipt,
  CompatibilityPlan,
  CompatibilityReasonCode,
  CompatibilityRequest,
  CompatibilityUnavailableSurface,
  CompatibilityWorkspaceLock,
  WorkflowCompatibilityManifest,
} from "./compatibility-modes.js";
export type {
  CanonicalExchangeChunkInput,
  CanonicalExchangeChunkRecord,
  CanonicalExchangeFaultPoint,
  CanonicalExchangeManifest,
  CanonicalExchangePlan,
  CanonicalExchangeReadOptions,
  CanonicalExchangeReadback,
  CanonicalExchangeReasonCode,
  CanonicalExchangeRequest,
  CanonicalExchangeResume,
  CanonicalExchangeTransaction,
  CanonicalExchangeWriteOptions,
} from "./canonical-exchange.js";
export {
  CORE_PERSONA_BUNDLE_VERSION,
  CORE_PERSONA_PROFILE_VERSION,
  CORE_PERSONA_REASON_CODES,
  CORE_PERSONA_SOURCE_MANIFEST_SHA256,
  CorePersonaError,
  generateCorePersonaBundle,
  generateCorePersonaReleaseLayers,
  validateCorePersonaBundle,
  validateCorePersonaProfile,
  validateCorePersonaProfileShape,
} from "./core-reference-personas.js";
export type { CorePersonaBundle, CorePersonaProfile, CorePersonaReasonCode } from "./core-reference-personas.js";
export type {
  EffectiveGenericProfile,
  GenericProfileAdmissionContext,
  GenericProfileAdmissionAuthority,
  GenericProfileAdmissionReadOptions,
  GenericProfileAdmissionReceipt,
  GenericProfileAuthorizationContext,
  GenericProfileBinding,
  GenericProfileBindingMode,
  GenericProfileBudgets,
  GenericProfileDisplayFields,
  GenericProfileIdentity,
  GenericProfileImmutableFields,
  GenericProfileLayer,
  GenericProfileLayerAdmission,
  GenericProfileLayerKind,
  GenericProfileOperation,
  GenericProfileOwnerRebind,
  GenericProfileOwnerRebindAdmission,
  GenericProfileOwnerRebindFields,
  GenericProfileReasonCode,
  GenericProfileResolutionRequest,
  GenericProfileRestrictOnlyFields,
  GenericProfileStarterBundle,
  GenericProfileTrustLevel,
} from "./generic-profile.js";
