// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  artifactArchiveDryRun,
  artifactCompactDryRun,
  createKnowledgeUnit,
  createProject,
  createWork,
  exportWorkspace,
  generateGenericStarterBundle,
  initializeArtifactStore,
  initializeKnowledgeStore,
  initializeWorkspace,
  listKnowledgeMetadata,
  transitionKnowledgePromotion,
  transitionWork,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

import {
  P8_RELEASE_ARTIFACTS,
  P8_SUPPORTED_AOS_RELEASES,
  P8_TAG,
  P8_VERSION,
  assertClosedReleaseArtifactAllowlist,
  buildDeterministicSourceArchive,
  buildP8ReleaseArtifacts,
  p8ArtifactRecords,
  sanitizeCoreReference,
} from "../scripts/lib/p8-workflow-rc.mjs";

function sourceRecords(order) {
  const records = [
    { path: "README.md", content: Buffer.from("public workflow\n", "utf8"), executable: false, singleLink: true },
    { path: "scripts/task.mjs", content: Buffer.from("#!/usr/bin/env node\n", "utf8"), executable: true, singleLink: true },
    { path: "packages/core/src/index.ts", content: Buffer.from("export {};\n", "utf8"), executable: false, singleLink: true },
  ];
  return order === "reverse" ? records.reverse() : records;
}

function profiles() {
  return Array.from({ length: 8 }, (_, index) => ({
    profileId: `profile:public-${index + 1}`,
    displayName: `Public ${index + 1}`,
    jobTitle: "Reference role",
    mission: "Public deterministic reference.",
    profileDigest: createHash("sha256").update(String(index)).digest("hex"),
  }));
}

test("P8 builds byte-identical USTAR source archives across insertion orders", () => {
  const first = buildDeterministicSourceArchive(sourceRecords("forward"));
  const second = buildDeterministicSourceArchive(sourceRecords("reverse"));
  assert.deepEqual(first, second);
  assert.equal(first.subarray(257, 263).toString("utf8"), "ustar\0");
  assert.throws(
    () => buildDeterministicSourceArchive([{ ...sourceRecords("forward")[0], singleLink: false }]),
    (error) => error.reasonCode === "P8_ARCHIVE_LINK_INVALID",
  );
});

test("P8 creates a closed unpublished release candidate without supported AOS releases", () => {
  const source = buildDeterministicSourceArchive(sourceRecords("forward"));
  const sbom = Buffer.from('{"bomFormat":"CycloneDX"}\n', "utf8");
  const artifacts = buildP8ReleaseArtifacts({ sourceArchive: source, sbom });
  assert.deepEqual([...artifacts.keys()].sort(), [...P8_RELEASE_ARTIFACTS].sort());
  assert.equal(P8_VERSION, "0.1.0-rc.1");
  assert.equal(P8_TAG, "v0.1.0-rc.1");
  assert.deepEqual(P8_SUPPORTED_AOS_RELEASES, []);
  const manifest = JSON.parse(artifacts.get("release-manifest.json").toString("utf8"));
  assert.equal(manifest.releaseStatus, "unpublished_candidate");
  assert.deepEqual(manifest.supportedAosReleases, []);
  assert.equal(p8ArtifactRecords(artifacts).length, 6);
  assert.throws(
    () => assertClosedReleaseArtifactAllowlist(new Map([["unexpected.txt", Buffer.from("")]])),
    (error) => error.reasonCode === "P8_RELEASE_ALLOWLIST_MISMATCH",
  );
});

test("P8 Core Reference projection admits only eight closed public records", () => {
  const projection = sanitizeCoreReference(profiles());
  assert.deepEqual(projection.supportedAosReleases, []);
  assert.equal(projection.profiles.length, 8);
  assert.ok(/^[a-f0-9]{64}$/u.test(projection.bundleIdentity));
  const contaminated = profiles();
  contaminated[0].legacyState = "forbidden";
  assert.throws(
    () => sanitizeCoreReference(contaminated),
    (error) => error.reasonCode === "P8_CORE_REFERENCE_FIELDS",
  );
});

test("P8 dogfood completes one disposable local_primary initiative with Knowledge and dry-run artifacts", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-p8-dogfood-")));
  context.after(() => rm(base, { recursive: true, force: true }));
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
  assert.ok(generateGenericStarterBundle().bundleDigest);
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
  await initializeArtifactStore(workspace, { disposable: true });
  const compactOne = await artifactCompactDryRun(workspace);
  const compactTwo = await artifactCompactDryRun(workspace);
  const archiveOne = await artifactArchiveDryRun(workspace);
  const archiveTwo = await artifactArchiveDryRun(workspace);
  assert.deepEqual(compactOne, compactTwo);
  assert.deepEqual(archiveOne, archiveTwo);
});
