// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  artifactArchiveDryRun,
  artifactCompactDryRun,
  authorizeGenericProfileOperation,
  calculateContextRouteRequestDigest,
  calculateGenericProfileAdmissionClaims,
  createKnowledgeUnit,
  createProject,
  createWork,
  exportWorkspace,
  GENERIC_PROFILE_ADMISSION_RECEIPT_VERSION,
  GENERIC_PROFILE_BASE_DIGEST,
  GENERIC_PROFILE_OPERATIONS,
  generateGenericStarterBundle,
  generateCorePersonaBundle,
  initializeArtifactStore,
  initializeKnowledgeStore,
  initializeWorkspace,
  listKnowledgeMetadata,
  readContextRouteAuthorityReceipt,
  readGenericProfileAdmissionReceipt,
  routeContext,
  transitionKnowledgePromotion,
  transitionWork,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256, compareCanonicalText, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

import {
  P8_RELEASE_ARTIFACTS,
  P8_SUPPORTED_AOS_RELEASES,
  P8_TAG,
  P8_VERSION,
  assertClosedReleaseArtifactAllowlist,
  buildP8ReleaseArtifacts,
  p8ArtifactRecords,
  rebuildP8SourceArchiveInIndependentRoots,
  sanitizedCoreReferenceProjection,
} from "../scripts/lib/p8-workflow-rc.mjs";

function fileAuthority(path, bytes) {
  return { expectedCanonicalPath: path, expectedFileSha256: createHash("sha256").update(bytes).digest("hex") };
}

function p8ProfileResolution(workspaceId, projectId) {
  const base = generateGenericStarterBundle().layers[0];
  const replacement = {
    activeBinding: { mode: "project", workspaceId, projectId, command: null },
    roleReplacement: null,
    projectAuthority: projectId,
    escalationOwner: "owner:fixture-p8",
  };
  const workspaceLayer = {
    schemaVersion: "tcrn.generic-profile.v1",
    layerId: "profile-layer:p8-disposable-project",
    layerKind: "workspace_configuration",
    trustLevel: "user_owned_overlay",
    releaseVerificationDigest: null,
    fields: {
      ownerRebindOnly: replacement,
      displayOnly: {
        label: "P8 Disposable Profile",
        description: "Inert project-bound profile for disposable P8 dogfood.",
        examples: ["p8-disposable-project"],
        presentation: { category: "workflow", audience: "workspace-owner" },
      },
    },
  };
  return {
    schemaVersion: "tcrn.generic-profile-resolution-request.v1",
    layers: [base, workspaceLayer],
    ownerRebind: {
      schemaVersion: "tcrn.generic-profile-owner-rebind.v1",
      approved: true,
      ownerId: "owner:fixture-p8",
      targetLayerId: workspaceLayer.layerId,
      replacement,
    },
  };
}

function p8AdmissionReceipt(profileResolution) {
  const claims = calculateGenericProfileAdmissionClaims(profileResolution);
  const layer = profileResolution.layers.find((entry) => entry.layerKind === "workspace_configuration");
  const layerAdmissions = [{
    layerDigest: canonicalSha256(layer),
    layerKind: layer.layerKind,
    trustLevel: layer.trustLevel,
    releaseVerificationDigest: layer.releaseVerificationDigest,
  }];
  const ownerRebindAdmission = {
    ownerRebindDigest: canonicalSha256(profileResolution.ownerRebind),
    targetLayerDigest: canonicalSha256(layer),
    targetBindingDigest: canonicalSha256(profileResolution.ownerRebind.replacement.activeBinding),
    ownerId: profileResolution.ownerRebind.ownerId,
  };
  const basis = {
    schemaVersion: GENERIC_PROFILE_ADMISSION_RECEIPT_VERSION,
    frameworkBaseDigest: GENERIC_PROFILE_BASE_DIGEST,
    layerAdmissions,
    ownerRebindAdmission,
    governedActions: [...GENERIC_PROFILE_OPERATIONS].sort(compareCanonicalText),
    resolutionDisposition: "normal",
    requestDigest: claims.requestDigest,
    effectiveDigest: claims.effectiveDigest,
  };
  return { claims, receipt: { ...basis, receiptDigest: canonicalSha256(basis) } };
}

function metadataCandidate(metadata, workspaceId, projectId) {
  const basis = {
    schemaVersion: "tcrn.context-metadata-candidate.v1",
    id: metadata.id,
    kind: "summary",
    scope: "project",
    workspaceId,
    projectId,
    workId: null,
    freshness: "fresh",
    title: metadata.subject,
    summary: metadata.summary,
    retentionClass: "metadata_only",
  };
  return { ...basis, candidateDigest: canonicalSha256(basis) };
}

const p8ContextBudgets = Object.freeze({ fixedInjectionBytes: 1024, authorityBytes: 4096, summaryCount: 16, summaryBytes: 65536, bodyCount: 4, bodyBytes: 65536, receiptBytes: 65536, referenceCount: 16, referenceBytes: 65536 });

test("P8 rebuilds the exact full allowlisted USTAR archive in two independent disposable roots", async () => {
  const policy = JSON.parse(await readFile("scripts/policy/source-allowlist.json", "utf8"));
  const rebuilt = await rebuildP8SourceArchiveInIndependentRoots({ repositoryRoot: process.cwd(), allowedFiles: policy.allowedFiles });
  assert.equal(rebuilt.rootsIndependent, true);
  assert.equal(rebuilt.sourceFiles, policy.allowedFiles.length);
  assert.ok(rebuilt.sourceFiles > 3);
  assert.deepEqual(rebuilt.orderedEntries, [...policy.allowedFiles].sort(compareCanonicalText));
  assert.equal(rebuilt.archive.subarray(257, 263).toString("utf8"), "ustar\0");
  assert.match(rebuilt.sha256, /^[a-f0-9]{64}$/u);
});

test("P8 creates a closed unpublished release candidate without supported AOS releases", () => {
  const source = Buffer.from("P8 source fixture\n", "utf8");
  const sbom = Buffer.from('{"bomFormat":"CycloneDX"}\n', "utf8");
  const artifacts = buildP8ReleaseArtifacts({ sourceArchive: source, sbom });
  assert.deepEqual([...artifacts.keys()].sort(), [...P8_RELEASE_ARTIFACTS].sort());
  assert.equal(P8_VERSION, "0.3.1");
  assert.equal(P8_TAG, "v0.3.1");
  assert.deepEqual(P8_SUPPORTED_AOS_RELEASES, []);
  const manifest = JSON.parse(artifacts.get("release-manifest.json").toString("utf8"));
  assert.equal(manifest.releaseStatus, "accepted_release");
  assert.deepEqual(manifest.supportedAosReleases, []);
  assert.equal(p8ArtifactRecords(artifacts).length, 6);
  assert.throws(
    () => assertClosedReleaseArtifactAllowlist(new Map([["unexpected.txt", Buffer.from("")]])),
    (error) => error.reasonCode === "P8_RELEASE_ALLOWLIST_MISMATCH",
  );
});

test("P8 projects the generated eight-profile Core Reference bundle through the closed sanitizer", () => {
  const bundle = generateCorePersonaBundle();
  const projection = sanitizedCoreReferenceProjection(bundle);
  assert.equal(bundle.profiles.length, 8);
  assert.equal(projection.profiles.length, 8);
  assert.equal(projection.bundleIdentity, bundle.bundleDigest);
  assert.deepEqual(Object.keys(projection.profiles[0]).sort(compareCanonicalText), ["displayName", "jobTitle", "mission", "profileDigest", "profileId"]);
  assert.equal(canonicalJson(projection).match(/legacy|transcript|credential|\/Users\/|AOS/iu), null);
});

test("P8 dogfood completes one disposable local_primary initiative with Knowledge and dry-run artifacts", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-p8-dogfood-")));
  context.after(async () => {
    await rm(base, { recursive: true, force: true });
    await assert.rejects(lstat(base));
  });
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "FIXTURE-P8-LOCAL-PRIMARY", createdAt: "2026-07-14T00:00:00Z", segmentEventLimit: 64 });
  const lease = await acquireWorkspaceLease(workspace, { now: "2026-07-14T00:00:01Z" });
  let state;
  try {
    state = await createProject(workspace, lease, { expectedVersion: 0, occurredAt: "2026-07-14T00:00:01Z", externalKey: "FIXTURE-P8-PROJECT", name: "P8 local_primary" });
    state = await createWork(workspace, lease, { expectedVersion: 1, occurredAt: "2026-07-14T00:00:02Z", projectId: state.projects[0].id, externalKey: "FIXTURE-P8-INITIATIVE", kind: "Initiative", parentId: null, status: "planned" });
    for (const [expectedVersion, status, occurredAt] of [[2, "ready", "2026-07-14T00:00:03Z"], [3, "active", "2026-07-14T00:00:04Z"], [4, "done", "2026-07-14T00:00:05Z"]]) {
      state = await transitionWork(workspace, lease, { expectedVersion, occurredAt, id: state.work[0].id, status });
    }
  } finally {
    await lease.release();
  }
  assert.equal(state.work[0].status, "done");
  const exportOne = await exportWorkspace(workspace);
  const exportTwo = await exportWorkspace(workspace);
  assert.equal(exportOne, exportTwo);
  const profileResolution = p8ProfileResolution(state.metadata.workspaceId, state.projects[0].id);
  const admission = p8AdmissionReceipt(profileResolution);
  const admissionPath = join(base, "release-trust", "generic-profile-admission.json");
  const admissionBytes = canonicalJson(admission.receipt);
  await writeFile(admissionPath, admissionBytes, { mode: 0o600 });
  const admittedProfile = await readGenericProfileAdmissionReceipt(admissionPath, { authority: fileAuthority(admissionPath, admissionBytes) });
  const authorization = authorizeGenericProfileOperation(profileResolution, admittedProfile, "work.transition", {
    workspaceId: state.metadata.workspaceId,
    projectId: state.projects[0].id,
    command: null,
  });
  assert.equal(authorization.reasonCode, "PROFILE_OPERATION_AUTHORIZED");
  assert.equal(authorization.admissionReceiptDigest, admission.receipt.receiptDigest);
  assert.throws(() => authorizeGenericProfileOperation(profileResolution, admittedProfile, "work.transition", {
    workspaceId: "workspace:wrong", projectId: state.projects[0].id, command: null,
  }), (error) => error.reasonCode === "PROFILE_BINDING_MISMATCH");
  await initializeKnowledgeStore(workspace);
  const knowledge = await createKnowledgeUnit(workspace, {
    expectedVersion: 0,
    occurredAt: "2026-07-14T00:00:06Z",
    externalKey: "FIXTURE-P8-KNOWLEDGE",
    scope: "project",
    projectId: state.projects[0].id,
    roleScopes: [],
    category: "implementation",
    kind: "guide",
    tags: ["p8", "release"],
    subject: "P8 public dogfood Knowledge",
    summary: "A disposable public metadata fixture.",
    snippet: "P8 fixture snippet.",
    accountableOwnerId: deriveStableId("owner", "FIXTURE-P8-OWNER"),
    sourceReferences: ["evidence://fixture/p8-dogfood"],
    sourceDigest: canonicalSha256({ source: "p8-dogfood" }),
    linkedWorkIds: [state.work[0].id],
    linkedDecisionIds: [deriveStableId("decision", "FIXTURE-P8-DECISION")],
    linkedGateIds: [deriveStableId("gate", "FIXTURE-P8-GATE")],
    linkedEvidenceIds: [deriveStableId("evidence", "FIXTURE-P8-EVIDENCE")],
    lifecycle: "active",
    retrievalDisposition: "default",
    freshnessState: "fresh",
    lastVerified: "2026-07-14T00:00:06Z",
    stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only",
    body: "Disposable P8 body is explicitly separated from metadata.",
  });
  await transitionKnowledgePromotion(workspace, {
    expectedVersion: 1,
    expectedRevision: 1,
    occurredAt: "2026-07-14T00:00:06Z",
    id: knowledge.id,
    promotionState: "promoted",
  });
  const selected = await listKnowledgeMetadata(workspace, { at: "2026-07-14T00:00:07Z", projectId: state.projects[0].id, selection: "all" });
  assert.equal(selected.records.length, 1);
  assert.equal(selected.records[0].id, knowledge.id);
  const routedMetadata = metadataCandidate(selected.records[0], state.metadata.workspaceId, state.projects[0].id);
  const routeRequest = {
    schemaVersion: "tcrn.context-route-request.v1",
    verificationTime: "2026-07-14T00:00:07Z",
    workspaceId: state.metadata.workspaceId,
    projectId: state.projects[0].id,
    workId: null,
    taskKind: "implementation",
    riskTier: "high",
    profileResolution,
    expectedEffectiveDigest: admission.claims.effectiveDigest,
    budgets: { ...p8ContextBudgets },
    query: "Route created P8 Knowledge metadata only.",
    metadataCandidates: [routedMetadata],
    explicitReadCandidates: [],
    explicitReadRequests: [],
  };
  const authorityBasis = {
    schemaVersion: "tcrn.context-route-authority.v1",
    requestDigest: calculateContextRouteRequestDigest(routeRequest),
    profileAdmissionReceiptDigest: admission.receipt.receiptDigest,
    effectiveDigest: admission.claims.effectiveDigest,
    workspaceId: state.metadata.workspaceId,
    projectId: state.projects[0].id,
    workId: null,
    taskKind: "implementation",
    minimumRiskTier: "high",
    maximumBudgets: { ...p8ContextBudgets },
    allowedExplicitReadIds: [],
    issuedAt: "2026-07-14T00:00:00Z",
    expiresAt: "2026-07-14T01:00:00Z",
  };
  const contextAuthority = { ...authorityBasis, authorityDigest: canonicalSha256(authorityBasis) };
  const contextAuthorityPath = join(base, "release-trust", "context-route-authority.json");
  const contextAuthorityBytes = canonicalJson(contextAuthority);
  await writeFile(contextAuthorityPath, contextAuthorityBytes, { mode: 0o600 });
  const admittedContextAuthority = await readContextRouteAuthorityReceipt(contextAuthorityPath, fileAuthority(contextAuthorityPath, contextAuthorityBytes));
  const routed = routeContext(routeRequest, admittedProfile, admittedContextAuthority);
  assert.equal(routed.reasonCode, "CONTEXT_ROUTED");
  assert.deepEqual(routed.context.metadata.map((entry) => entry.id), [knowledge.id]);
  assert.deepEqual(routed.context.references, []);
  assert.deepEqual(routed.context.explicitReads, []);
  assert.equal(routed.receipt.profileAdmissionReceiptDigest, admission.receipt.receiptDigest);
  assert.equal(routed.receipt.contextAuthorityDigest, contextAuthority.authorityDigest);
  assert.equal(canonicalJson(routed).includes("Disposable P8 body"), false);
  assert.throws(() => routeContext({ ...routeRequest, query: "tampered" }, admittedProfile, admittedContextAuthority), (error) => error.reasonCode === "CONTEXT_AUTHORITY_MISMATCH");
  await initializeArtifactStore(workspace, { disposable: true });
  const compactOne = await artifactCompactDryRun(workspace);
  const compactTwo = await artifactCompactDryRun(workspace);
  const archiveOne = await artifactArchiveDryRun(workspace);
  const archiveTwo = await artifactArchiveDryRun(workspace);
  assert.deepEqual(compactOne, compactTwo);
  assert.deepEqual(archiveOne, archiveTwo);
});
