// SPDX-License-Identifier: Apache-2.0

export const FRAMEWORK_VERSION = "0.1.0-rc.4" as const;
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
  SNAPSHOT_REASON_CODES,
  SnapshotError,
  createSnapshotManifest,
  readSnapshotManifestFile,
  verifySnapshotManifest,
} from "./workspace-snapshot.js";
export type { SnapshotReasonCode } from "./workspace-snapshot.js";
export {
  WORKSPACE_CONTROL_DIRECTORY,
  WORKSPACE_REASON_CODES,
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_STORAGE_VERSION,
  WorkspaceError,
  acquireWorkspaceLease,
  appendConferencePositionInWorkspace,
  applyWorkspaceMigration,
  assertSupportedWorkspaceFilesystem,
  breakWorkspaceLease,
  cancelConferenceInWorkspace,
  closeConferenceInWorkspace,
  createGateInWorkspace,
  deleteGateInWorkspace,
  inspectWorkspaceLease,
  assertWorkspaceRecordCount,
  assertWorkspaceRelativePath,
  createProject,
  createWorkspaceArchive,
  createWork,
  deleteProject,
  deleteWork,
  enableActorAttestation,
  exportWorkspace,
  initializeWorkspace,
  materializeWorkspace,
  openConferenceInWorkspace,
  planWorkspaceMigration,
  rebuildWorkspaceViews,
  recoverWorkspace,
  transitionGateInWorkspace,
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
  PUBLIC_AOS_REQUIREMENTS_REASON_CODES,
  PUBLIC_AOS_REQUIREMENTS_READBACK_VERSION,
  PUBLIC_AOS_REQUIREMENTS_VERSION,
  publicAosRequirementsValidReason,
  PublicAosRequirementsError,
  parsePublicAosRequirementsLedger,
  publicAosRequirementsReadback,
  validatePublicAosRequirementsLedger,
} from "./public-aos-requirements.js";
export type {
  PublicAosRequirement,
  PublicAosRequirementMaturity,
  PublicAosRequirementsLedger,
  PublicAosRequirementsReasonCode,
  PublicAosRequirementStatus,
} from "./public-aos-requirements.js";
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
  knowledgeContextCandidates,
  listKnowledgeMetadata,
  readKnowledgeBody,
  readKnowledgeSnippet,
  rebaseKnowledgeStore,
  retireKnowledgeUnit,
  reverifyKnowledgeUnit,
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
export {
  CLAUDE_ADAPTER_BUNDLE_VERSION,
  CLAUDE_ADAPTER_FALLBACK_VERSION,
  CLAUDE_ADAPTER_FRAGMENT_VERSION,
  CLAUDE_ADAPTER_HOOK_EVENTS,
  CLAUDE_ADAPTER_HOST_PRODUCT,
  CLAUDE_ADAPTER_HOST_VERSION,
  CLAUDE_ADAPTER_LIFECYCLE_VERSION,
  CLAUDE_ADAPTER_INSTALLATION_VERSION,
  CLAUDE_ADAPTER_REASON_CODES,
  CLAUDE_ADAPTER_REQUEST_VERSION,
  CLAUDE_ADAPTER_SETTINGS_TARGET,
  CLAUDE_ADAPTER_FRAGMENT_MERGE_KEY,
  CLAUDE_ADAPTER_TEMPLATE_PATHS,
  ClaudeAdapterError,
  admitClaudeAdapterHostInput,
  assertNoForbiddenClaudePaths,
  calculateClaudeAdapterRequestDigest,
  claudeAdapterAuthorityEmptyFallback,
  generateClaudeAdapterBundle,
  generateClaudeAdapterSettingsFragment,
  mergeClaudeAdapterSettingsFragment,
  planClaudeAdapterRollback,
  readClaudeAdapterInstallationReceipt,
  removeClaudeAdapterSettingsFragment,
  simulateClaudeAdapterLifecycle,
  validateClaudeAdapterBundle,
  validateClaudeAdapterRequest,
  validateClaudeAdapterSettingsFragment,
} from "./claude-adapter.js";
export type {
  ClaudeAdapterBundle,
  ClaudeAdapterFile,
  ClaudeAdapterGovernedAction,
  ClaudeAdapterHostContext,
  ClaudeAdapterHostInput,
  ClaudeAdapterInstallationContext,
  ClaudeAdapterInstallationEntry,
  ClaudeAdapterInstallationFileIdentity,
  ClaudeAdapterInstallationReadOptions,
  ClaudeAdapterInstallationReceipt,
  ClaudeAdapterReasonCode,
  ClaudeAdapterRequest,
} from "./claude-adapter.js";
export {
  CLAUDE_ADAPTER_INSTALLER_REASON_CODES,
  ClaudeAdapterInstallerError,
  executeClaudeAdapterRollback,
  installClaudeAdapterActivation,
  installClaudeAdapterBundle,
} from "./claude-adapter-installer.js";
export type {
  ClaudeAdapterActivationInstallOptions,
  ClaudeAdapterActivationInstallResult,
  ClaudeAdapterInstallOptions,
  ClaudeAdapterInstallResult,
  ClaudeAdapterInstallerReasonCode,
  ClaudeAdapterRollbackResult,
} from "./claude-adapter-installer.js";
export {
  CLAUDE_ADAPTER_ACTIVATION_HOOK_COMMAND,
  CLAUDE_ADAPTER_ACTIVATION_HOOK_EVENT,
  CLAUDE_ADAPTER_ACTIVATION_MERGE_KEY,
  CLAUDE_ADAPTER_ACTIVATION_PATHS,
  CLAUDE_ADAPTER_ACTIVATION_REASON_CODES,
  CLAUDE_ADAPTER_FRAGMENT_V2_VERSION,
  CLAUDE_ADAPTER_HOST_V2_VERSION,
  CLAUDE_ADAPTER_INSTALLATION_V2_VERSION,
  CLAUDE_ADAPTER_PERSONA_RENDER_PATH,
  CLAUDE_ADAPTER_ROLLBACK_PLAN_VERSION,
  CLAUDE_ADAPTER_SESSION_START_PATH,
  ClaudeAdapterActivationError,
  admitClaudeAdapterActivationHostInput,
  generateClaudeAdapterActivationFragment,
  generateClaudeAdapterActivationRollbackPlan,
  mergeClaudeAdapterActivationFragment,
  removeClaudeAdapterActivationFragment,
  validateClaudeAdapterActivationFragment,
  validateClaudeAdapterActivationInstallationReceipt,
} from "./claude-adapter-activation.js";
export type {
  ClaudeAdapterActivationFragment,
  ClaudeAdapterActivationHostContext,
  ClaudeAdapterActivationHostInput,
  ClaudeAdapterActivationInstallationEntry,
  ClaudeAdapterActivationInstallationReceipt,
  ClaudeAdapterActivationReasonCode,
  ClaudeAdapterActivationScriptContext,
} from "./claude-adapter-activation.js";
export {
  SESSION_START_INJECTION_BUDGET_BYTES,
  SESSION_START_REASON_CODES,
  SESSION_START_SCRIPT_VERSION,
  SessionStartScriptError,
  generateSessionStartScript,
  sessionStartScriptDigest,
} from "./claude-adapter-session-start.js";
export type {
  SessionStartReasonCode,
  SessionStartScriptOptions,
} from "./claude-adapter-session-start.js";
export {
  DEPENDENCY_VERSION,
  DEPENDENCY_KINDS,
  DEPENDENCY_STATUSES,
  DEPENDENCY_REASON_CODES,
  DependencyError,
  validateDependencyRecord,
  canonicalDependencyDigest,
  assertDependencyEndpoints,
  orderDependencies,
  assertNoDependencyCycle,
  listDependencyBlockers,
  listDependenciesByWorkItem,
} from "./dependency.js";
export {
  ACTOR_ATTESTATION_SCHEMA_VERSION,
  ACTOR_ATTESTATION_ENABLE_OPERATION,
  ACTOR_ATTESTATION_REGISTRATION_ID,
  ACTOR_PREFIXES,
  ACTOR_ATTESTATION_REASON_CODES,
  ActorAttestationError,
  EVENT_PAYLOAD_OPERATION_EXTRAS,
  assertActorId,
  buildEventPayload,
  buildActorAttestationEnableRecord,
  validateActorAttestationEnableRecord,
  buildActorAttestationRegistration,
} from "./actor-attestation.js";
export type {
  DependencyRecord,
  DependencyWorkReference,
  DependencyReasonCode,
  DependencyKind,
  DependencyStatus,
} from "./dependency.js";
export {
  CONFERENCE_REQUEST_VERSION,
  CONFERENCE_POSITION_VERSION,
  CONFERENCE_MINUTES_VERSION,
  CONFERENCE_TYPES,
  CONFERENCE_STATUSES,
  CONFERENCE_OUTCOME_CLASSES,
  CONFERENCE_REASON_CODES,
  ConferenceError,
  validateConferenceRequest,
  validateConferencePosition,
  validateConferenceMinutes,
  openConference,
  appendConferencePosition,
  listConferencesByWorkItem,
  closeConference,
  distillConferenceKnowledge,
} from "./conference.js";
export type {
  ConferenceRequest,
  ConferencePosition,
  ConferenceMinutes,
  ConferenceDecisionCandidate,
  ConferenceReasonCode,
  DistillConferenceOptions,
} from "./conference.js";
export {
  ASSIGNMENT_VERSION,
  GATE_VERSION,
  ASSIGNMENT_STATUSES,
  GATE_STATUSES,
  GATE_OUTCOME_CLASSES,
  ASSIGNMENT_GATE_REASON_CODES,
  AssignmentGateError,
  validateAssignmentRecord,
  validateGateRecord,
  listAssignmentsByWorkItem,
  listGatesByWorkItem,
} from "./assignment-gate.js";
export type {
  AssignmentRecord,
  GateRecord,
  AssignmentGateReasonCode,
} from "./assignment-gate.js";
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
