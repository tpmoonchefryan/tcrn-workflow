// SPDX-License-Identifier: Apache-2.0

export const FRAMEWORK_VERSION = "1.0.1" as const;
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
// STORY-174: the storage abstraction is part of the public core surface so the
// PG backend (packages/pg-backend) can implement it. StorageError is the
// fail-closed refusal shape; StorageBackend/FileBackend are the interface and
// the converged file implementation.
export { StorageError, FileBackend, WORKSPACE_CONTROL_DIRECTORY } from "./storage-backend.js";
export type { StorageBackend, StorageBackendKind, StorageDirectoryEntry, WorkspaceCrashPoint } from "./storage-backend.js";
export { SegmentedBackend, SEGMENTED_BACKEND_PROFILE } from "./segmented-backend.js";
export type { SegmentIndexDocument, SegmentIndexEntry, SegmentManifest, SegmentManifestEntry, SegmentedBackendProfile } from "./segmented-backend.js";
export {
  ATTESTATION_MANIFEST_VERSION,
  deleteLegacyAttestations,
  migrateAttestationDirectory,
  readAttestationReceipt,
  reportAttestationDirectory,
  writeAttestationReceipt,
} from "./attestation-storage.js";
// INC-074: the storage-home sentinel declares where a workspace's chain lives
// after a file→pg migration. The file backend refuses mutating verbs on a
// sentinel workspace (WORKSPACE_STORAGE_RELOCATED), and a PG-facing path must
// name the schema the sentinel declares. Part of the public core surface so the
// CLI/facade can check it.
export {
  STORAGE_HOME_VERSION,
  STORAGE_HOME_FILE_NAME,
  StorageHomeError,
  readStorageHomeDeclaration,
  removeStorageHomeDeclaration,
  sealStorageHomeDeclaration,
  writeStorageHomeDeclaration,
} from "./storage-home.js";
export type { StorageHomeDeclaration } from "./storage-home.js";
// STORY-281: machine-level portal preferences. Deliberately not chain-backed — see
// the module header for why a laptop's default theme is not governed workspace state.
export {
  MACHINE_SETTINGS_CATALOG,
  MACHINE_SETTINGS_DIRECTORY,
  MACHINE_SETTINGS_FILE_NAME,
  MACHINE_SETTINGS_LAYER_KIND,
  MACHINE_SETTINGS_REASON_CODES,
  MACHINE_SETTINGS_VERSION,
  MACHINE_SETTING_KEYS,
  MachineSettingsError,
  applyMachineSettingRemove,
  applyMachineSettingSet,
  assertMachineSettingKey,
  machineSettingsPath,
  readMachineSettings,
  readMachineSettingsCatalog,
  validateMachineSettingValue,
  validateMachineSettingsFile,
} from "./machine-settings.js";
export type { MachineSettingKey, MachineSettingsCatalogEntry, MachineSettingsFile, MachineSettingsReadback } from "./machine-settings.js";
// STORY-177: the knowledge/artifact store data-plane backend is part of the public
// core surface so a future PG store backend can implement it. StoreBackendError is
// the fail-closed refusal shape; FileStoreBackend is the converged file
// implementation; withStoreBackendFactory is the test-seam injection.
export { StoreBackendError, FileStoreBackend, SegmentedKnowledgeStoreBackend, withStoreBackendFactory } from "./store-backend.js";
export type { StoreBackend } from "./store-backend.js";
export {
  CONTROL_TREE_SKELETON_DIRECTORIES,
  CONTROL_TREE_TRANSPORT_RESIDUE_PATHS,
  SNAPSHOT_REASON_CODES,
  SnapshotError,
  createSnapshotManifest,
  readGovernedDocumentFile,
  readSnapshotManifestFile,
  verifySnapshotManifest,
} from "./workspace-snapshot.js";
export type { SnapshotReasonCode } from "./workspace-snapshot.js";
// TCRN-CROSS-STORY-380. Exactly the four names packages/cli/src/index.ts calls, and no
// more: scripts/policy/core-export-consumers.json reports every barrel symbol the
// consumer roots do not name, and a constant or type re-exported here "for completeness"
// is a symbol whose only consumer is its own test — the shape TCRN-CROSS-STORY-358 spent
// an Epic removing. artifact-store.ts still exports its schema versions and reason codes
// for readers of that module; the barrel is not that reader.
export {
  assertGeneratedArtifactsRoot,
  listArtifacts,
  putArtifact,
  verifyArtifacts,
} from "./artifact-store.js";
export {
  BACKGROUND_RESOURCE_LIMITS,
  BACKGROUND_RESOURCE_REASON_CODES,
  BACKGROUND_RESOURCE_REGISTRATION_VERSION,
  BACKGROUND_RESOURCE_RESIDUE_VERSION,
  BackgroundResourceError,
  buildRegistrationLine,
  buildResidueReport,
  detectResidue,
  parseProcessTable,
  parseRegistrationLine,
  parseRegistry,
} from "./background-resource.js";
export type {
  BackgroundResourceReasonCode,
  ProcessRow,
  ResidueEntry,
  ResidueReason,
  ResidueReport,
  ResidueStatus,
  SpawnRegistration,
} from "./background-resource.js";
export {
  WORKSPACE_REASON_CODES,
  WORKSPACE_RELOCATION_ENTRY_VERSION,
  WORKSPACE_RELOCATION_IDENTITY_VERSION,
  WORKSPACE_RELOCATION_LEDGER_LIMIT,
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_STORAGE_VERSION,
  WorkspaceError,
  acquireWorkspaceLease,
  activeBinding,
  activeWorkspaceRoot,
  deriveRelocationId,
  relocationStateAt,
  appendConferencePositionInWorkspace,
  admitTemplateInWorkspace,
  applyWorkspaceMigration,
  assertSupportedWorkspaceFilesystem,
  breakWorkspaceLease,
  breakWorkspaceRecoveryClaim,
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
  createWorkDelta,
  annotateWork,
  annotateWorkDelta,
  appendEvents,
  consumeViewWriteFailure,
  deleteProject,
  deleteWork,
  enableActorAttestation,
  exportWorkspace,
  initializeWorkspace,
  materializeWorkspace,
  openConferenceInWorkspace,
  planWorkspaceMigration,
  hasWorkspaceStorageMigration,
  migrateWorkspaceStorage,
  rollbackWorkspaceStorageMigration,
  verifyWorkspaceStorageMigration,
  rebuildWorkspaceViews,
  rebuildReplaySnapshot,
  recoverWorkspace,
  removeHostConfigurationInWorkspace,
  removeCustomPersonaInWorkspace,
  removePersonaBindingInWorkspace,
  removeModelPlanInWorkspace,
  removePersonaInWorkspace,
  restorePersonaPresetInWorkspace,
  overridePersonaPresetInWorkspace,
  assignModelPlanInWorkspace,
  setModelPlanInWorkspace,
  unassignModelPlanInWorkspace,
  setCustomPersonaInWorkspace,
  setHostConfigurationInWorkspace,
  setHostDefaultInWorkspace,
  setPersonaBindingInWorkspace,
  setWorkspaceSetting,
  removeWorkspaceSetting,
  transitionGateInWorkspace,
  transitionWork,
  transitionWorkDelta,
  updateProject,
  validateWorkspace,
  withStorageBackendFactory,
  withWorkspaceLease,
  workspaceBudgets,
  WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES,
} from "./workspace.js";
export type {
  ProjectRecord,
  SprintReference,
  WorkspaceAdmission,
  WorkspaceLease,
  WorkspaceMetadata,
  WorkspaceMigrationPlan,
  WorkspaceMutationOptions,
  WorkspaceReasonCode,
  WorkspaceRelocationAuthorityRecord,
  WorkspaceRelocationBasis,
  WorkspaceRelocationEntry,
  WorkspaceRelocationStage,
  WorkspaceRelocationState,
  WorkspaceState,
} from "./workspace.js";
export {
  TemplateAdmissionError,
  admitTemplate,
  createTemplateAdmissionRecord,
  readTemplateDocumentFile,
  templateBindingFromReceipt,
  templateBindingFromWorkRecord,
  templateDigest,
  templateRecordForBinding,
  templateRecordMatchesBinding,
  templateRegistry,
  validateBoundTemplateWork,
  validateTemplateAdmissionReceipt,
  validateTemplateAdmissionRecord,
  validateTemplateDocument,
} from "./template-admission.js";
export type { TemplateAdmissionRecord } from "./template-admission.js";
export {
  SETTINGS_CATALOG,
  SETTINGS_CATALOG_VERSION,
  SETTINGS_LAYER_KIND,
  SETTINGS_REASON_CODES,
  WORKSPACE_SETTING_VERSION,
  SettingsError,
  compareEngineVersions,
  createWorkspaceSettingRecord,
  readSettingsCatalog,
  settingsCatalogEntry,
  sortWorkspaceSettings,
  validateSettingValue,
  validateWorkspaceSettingRecord,
} from "./settings.js";
export type {
  SettingKey,
  SettingValueType,
  SettingsCatalogEntry,
  SettingsCatalogReadback,
  SettingsReasonCode,
  WorkspaceSettingRecord,
} from "./settings.js";
export {
  INSTALL_MANIFEST,
  INSTALL_MANIFEST_REQUIRED_ITEM_IDS,
  INSTALL_MANIFEST_VERSION,
  assertInstallManifestComplete,
  readInstallManifest,
} from "./install-manifest.js";
export {
  EMPTY_EXECUTION_CONFIG,
  EXECUTION_CONFIG_VERSION,
  EXECUTION_HOSTS,
  EXECUTION_CONFIG_REASON_CODES,
  ExecutionConfigError,
  applyHostConfigDefault,
  applyHostConfigRemove,
  applyHostConfigSet,
  applyLegacyCustomPersonaSet,
  applyCustomPersonaSet,
  applyCustomPersonaRemove,
  applyModelPlanAssignInExecutionConfig,
  applyModelPlanRemoveInExecutionConfig,
  applyModelPlanSetInExecutionConfig,
  applyModelPlanUnassignInExecutionConfig,
  applyPersonaPresetOverrideInExecutionConfig,
  applyPersonaPresetRemoveInExecutionConfig,
  applyPersonaPresetRestoreInExecutionConfig,
  applyPersonaBindingRemove,
  applyPersonaBindingSet,
  assertExecutionHost,
  validateConfigurationName,
  validateExecutionConfigState,
  validateModel,
  validateNote,
} from "./execution-config.js";
export {
  MODEL_PLAN_HOSTS,
  MODEL_PLAN_REASON_CODES,
  MODEL_PLAN_VERSION,
  ModelPlanError,
  assertModelPlanHost,
  applyModelPlanAssign,
  applyModelPlanRemove,
  applyModelPlanSet,
  applyModelPlanUnassign,
  readModelPlans,
  validateModelPlanEffort,
  validateModelPlanModel,
  validateModelPlanName,
  validateModelPlanState,
} from "./model-plan.js";
export type { ModelPlanHost, ModelPlanReasonCode, ModelPlanRecord } from "./model-plan.js";
export {
  AGENT_EFFORT_HOSTS,
  AGENT_EFFORT_NAMES,
  AGENT_EFFORT_ROSTER,
  AGENT_EFFORT_VERSION,
  effortForHost,
} from "./effort.js";
export type { AgentEffortHost, AgentEffortName, AgentEffortRecord } from "./effort.js";
export type {
  ExecutionConfigState,
  ExecutionHost,
  ExecutionConfigReasonCode,
  HostConfigurationRecord,
  HostDefaultRecord,
  PersonaBindingRecord,
} from "./execution-config.js";
export {
  CORE_REFERENCE_PERSONAS,
  EMPTY_PERSONA_STORE,
  PERSONA_REASON_CODES,
  PERSONA_CONTENT_FIELDS,
  PERSONA_NARRATIVE_FIELDS,
  PERSONA_RECORD_VERSION,
  PERSONA_ROLES,
  PERSONA_ROLE_DEFINITIONS,
  PERSONA_STORE_VERSION,
  PersonaStoreError,
  allPersonaReadback,
  applyLegacyPersonaSet,
  applyPersonaPresetOverride,
  applyPersonaPresetRemove,
  applyPersonaPresetRestore,
  applyPersonaRemove,
  applyPersonaSet,
  derivePersonaId,
  personaExists,
  validatePersonaDescription,
  validatePersonaContent,
  validatePersonaJobTitle,
  validatePersonaName,
  validatePersonaPrompt,
  validatePersonaRole,
  validatePersonaStoreState,
  validatePersonaPresetOverride,
} from "./persona-store.js";
export type {
  PersonaReasonCode,
  PersonaRecord,
  PersonaRole,
  PersonaContentField,
  PersonaPresetOverrideRecord,
  PersonaReadback,
  PersonaStoreState,
  ReferencePersonaReadback,
} from "./persona-store.js";
export {
  STORY_SCOPE_HEADINGS,
  deriveWorkSummary,
  storyScopeFromRecord,
  storyScopeNamesOwnerDecider,
  validateStoryVerificationLinks,
  verificationClaimsForWork,
  verificationWorksForClaim,
  validateStoryRecord,
  validateStoryScope,
  validateTemplateScope,
} from "./story-scope-compliance.js";
export type {
  ScopeTemplateDefinition,
  StoryScopeHeading,
  StoryScopeProblem,
  StoryScopeProblemCode,
  StoryScopeSection,
  StoryScopeValidation,
  StoryVerificationLinkProblem,
  StoryVerificationLinkValidation,
  VerificationClaimLink,
} from "./story-scope-compliance.js";
export {
  KNOWLEDGE_CONFLICT_SCORE_THRESHOLD,
  KNOWLEDGE_CORE_VERSION,
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_METADATA_SCHEMA_VERSION,
  KNOWLEDGE_PROVENANCE_POLICY,
  KNOWLEDGE_REASON_CODES,
  KNOWLEDGE_STORE_SCHEMA_VERSION,
  KnowledgeCoreError,
  captureKnowledgeUnit,
  createKnowledgeUnit,
  calculateKnowledgeSourceDigest,
  checkKnowledgeSources,
  evaluateKnowledgeFreshness,
  exportKnowledgeCheckpoint,
  initializeKnowledgeStore,
  migrateKnowledgeBodies,
  knowledgeConflictHits,
  knowledgeContextCandidates,
  knowledgeLinkIndexCountsForTest,
  knowledgeRelevanceScore,
  listKnowledgeMetadata,
  readKnowledgeBody,
  readKnowledgeStoreMarker,
  readKnowledgeSnippet,
  rebaseKnowledgeStore,
  retireKnowledgeUnit,
  reverifyKnowledgeUnit,
  updateKnowledgeStalenessPolicy,
  transitionKnowledgePromotion,
  validateKnowledgeStore,
} from "./knowledge-core.js";
export type {
  CaptureKnowledgeUnitInput,
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
  KnowledgeUnitExtensions,
  KnowledgeUnitMetadata,
} from "./knowledge-core.js";
export {
  OPERATOR_AUTHORITY_BUNDLE_VERSION,
  OPERATOR_AUTHORITY_PINS_VERSION,
  OPERATOR_AUTHORITY_REASON_CODES,
  OperatorAuthorityError,
  readOperatorAuthority,
  validateOperatorAuthorityBundle,
  validateOperatorAuthorityPins,
} from "./operator-authority.js";
export type {
  OperatorAuthorityBundle,
  OperatorAuthorityContext,
  OperatorAuthorityFileGrants,
  OperatorAuthorityPins,
  OperatorAuthorityReasonCode,
} from "./operator-authority.js";
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
  COLLECTION_ATTRIBUTION_NOTE,
  COLLECTION_REASON_CODES,
  CollectionError,
  collectConferenceReceipts,
  collectExecutionReceipt,
  verifyCollectedTranscript,
} from "./execution-collection.js";
export type {
  CollectedReceipt,
  CollectionContext,
  CollectionPlanEntry,
  CollectionReasonCode,
  CollectionResult,
  ObservedInvocation,
} from "./execution-collection.js";
export {
  PERSONA_RENDER_ALLOWED_PROFILE_IDS,
  PERSONA_RENDER_BUDGET_BYTES,
  PERSONA_RENDER_REASON_CODES,
  PERSONA_RENDER_VERSION,
  PersonaRenderError,
  renderPersonaAuthoritySummary,
  validatePersonaAuthorityRender,
} from "./persona-render.js";
export type {
  PersonaAuthorityRender,
  PersonaAuthorityRenderOptions,
  PersonaRenderReasonCode,
} from "./persona-render.js";
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
  CONFERENCE_DISTILL_SUMMARY_BYTES,
  CONFERENCE_POSITION_CEILING_BYTES,
  CONFERENCE_REQUEST_VERSION,
  CONFERENCE_POSITION_VERSION,
  CONFERENCE_MINUTES_VERSION,
  CONFERENCE_TYPES,
  CONFERENCE_STATUSES,
  CONFERENCE_OUTCOME_CLASSES,
  CONFERENCE_EXECUTION_FORMS,
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
export { VOCABULARY_VERSION, readVocabulary } from "./vocabulary.js";
export {
  EXECUTION_MODES,
  HOST_EXECUTION_RECEIPT_VERSION,
  EXECUTION_MODE_EXTENSION_KEY,
  EXECUTION_RECEIPT_EXTENSION_KEY,
  MULTI_AGENT_DEFAULT_TYPES,
  EXECUTION_AVAILABILITY,
  EXECUTION_REASON_CODES,
  ExecutionError,
  validateHostExecutionReceipt,
  readExecutionMode,
  classifyConferenceExecution,
} from "./conference-execution.js";
export type {
  ExecutionMode,
  ExecutionReasonCode,
  HostExecutionReceipt,
  ExecutionModeDeclaration,
  ExecutionClassification,
  ClassifyInput,
} from "./conference-execution.js";
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
export {
  GATE_IDENTITY_AUTHORITY_VERSION,
  GATE_IDENTITY_REASON_CODES,
  GATE_IDENTITY_LIMITS,
  GateIdentityError,
  validateGateIdentityAuthorityDocument,
  readGateIdentityAuthority,
  permitsGateOutcome,
  assertGateOutcomePermitted,
  gateIdentityDecision,
  validateGateIdentityDecision,
  canonicalGateIdentityAuthority,
} from "./gate-identity.js";
export type {
  GateIdentityAuthorityContext,
  GateIdentityAuthorityDocument,
  GateIdentityAuthorityFileIdentity,
  GateIdentityDecision,
  GateIdentityPermit,
  GateIdentityReasonCode,
} from "./gate-identity.js";
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
  CORE_PERSONA_BUNDLE_VERSION,
  CORE_PERSONA_PROFILE_VERSION,
  CORE_PERSONA_REASON_CODES,
  CORE_PERSONA_SOURCE_MANIFEST_SHA256,
  CORE_REFERENCE_PERSONA_IDS,
  CorePersonaError,
  generateCorePersonaBundle,
  generateCorePersonaReleaseLayers,
  isCoreReferencePersonaId,
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
export { WORK_BATCH_SCHEMA_VERSION, WORK_BATCH_VERBS, applyWorkBatch, workBatchReceipt } from "./work-batch.js";
export type { WorkBatchOptions, WorkBatchProblem } from "./work-batch.js";
export { KNOWLEDGE_BATCH_SCHEMA_VERSION, KNOWLEDGE_BATCH_VERBS, applyKnowledgeBatch } from "./knowledge-batch.js";
export type { KnowledgeBatchOptions, KnowledgeBatchProblem } from "./knowledge-batch.js";
