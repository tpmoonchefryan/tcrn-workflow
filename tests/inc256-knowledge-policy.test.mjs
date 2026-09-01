// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-256 — migrate existing knowledge policies through one batch.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  applyKnowledgeBatch,
  createKnowledgeUnit,
  createProject,
  createWork,
  evaluateKnowledgeFreshness,
  initializeKnowledgeStore,
  initializeWorkspace,
  listKnowledgeMetadata,
  transitionKnowledgePromotion,
  validateKnowledgeStore,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-09-02T00:00:${String(second).padStart(2, "0")}Z`;

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc256-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "FIXTURE-INC-256", createdAt: instant(1), segmentEventLimit: 64 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(2) });
  let project;
  let work;
  try {
    project = await createProject(workspace, lease, {
      expectedVersion: 0, occurredAt: instant(3), externalKey: "INC-256-PROJECT", name: "INC-256",
    });
    work = await createWork(workspace, lease, {
      expectedVersion: project.version, occurredAt: instant(4), projectId: project.projects[0].id,
      externalKey: "INC-256-WORK", kind: "Incident", parentId: null, status: "active",
    });
  } finally {
    await lease.release();
  }
  await initializeKnowledgeStore(workspace);
  return { base, workspace, projectId: project.projects[0].id, workId: work.work.find((record) => record.externalKey === "INC-256-WORK").id };
}

function card(fx, key, kind, expectedVersion) {
  return {
    expectedVersion,
    occurredAt: instant(5),
    externalKey: key,
    scope: "project",
    projectId: fx.projectId,
    roleScopes: [],
    category: "workflow",
    kind,
    tags: ["inc256", "long-term"],
    subject: `${kind} ${key}`,
    summary: `Existing ${kind} knowledge that must not expire.`,
    snippet: `INC-256 ${kind} card`,
    accountableOwnerId: deriveStableId("owner", "INC-256-OWNER"),
    sourceReferences: [`evidence://inc256/${key}`],
    sourceDigest: canonicalSha256({ key }),
    linkedWorkIds: [fx.workId],
    linkedDecisionIds: [],
    linkedGateIds: [],
    linkedEvidenceIds: [deriveStableId("evidence", `INC-256-${key}`)],
    lifecycle: "active",
    retrievalDisposition: "default",
    freshnessState: "fresh",
    lastVerified: instant(1),
    stalenessPolicy: { maximumAgeDays: 180, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only",
    body: `Body for ${key}.`,
  };
}

const policyBatch = (members) => ({ schemaVersion: "tcrn.knowledge-batch.v1", members });

test("INC-256 knowledge-batch migrates all existing cards to no expiry and preserves retrieval", async () => {
  const fx = await fixture();
  try {
    let version = 0;
    const created = [];
    for (const kind of ["fact", "guide", "decision", "reference"]) {
      const result = await createKnowledgeUnit(fx.workspace, card(fx, `CARD-${kind}`, kind, version));
      version = result.version;
      const promoted = await transitionKnowledgePromotion(fx.workspace, {
        expectedVersion: version, expectedRevision: result.revision, occurredAt: instant(6), id: result.id, promotionState: "promoted",
      });
      version = promoted.version;
      created.push({ id: result.id, revision: promoted.revision, kind });
    }
    const before = await listKnowledgeMetadata(fx.workspace, { at: instant(6), selection: "all" });
    assert.equal(before.total, 4);
    assert.deepEqual(before.records.map((record) => record.stalenessPolicy.maximumAgeDays), [180, 180, 180, 180]);
    assert.equal((await validateKnowledgeStore(fx.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");

    const result = await applyKnowledgeBatch(fx.workspace, policyBatch(created.map((record) => ({
      verb: "knowledge-policy",
      id: record.id,
      expectedRevision: record.revision,
      stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
    }))), { expectedVersion: version, occurredAt: instant(7) });
    assert.equal(result.reasonCode, "KNOWLEDGE_BATCH_APPLIED");
    assert.equal(result.members, 4);
    assert.equal(result.applied.length, 4);

    const after = await listKnowledgeMetadata(fx.workspace, { at: instant(8), selection: "all" });
    assert.equal(after.total, before.total, "migration does not add or remove records");
    assert.deepEqual(after.records.map((record) => record.stalenessPolicy.maximumAgeDays), [null, null, null, null]);
    assert.deepEqual(after.records.map((record) => record.subject), before.records.map((record) => record.subject));
    const future = await evaluateKnowledgeFreshness(fx.workspace, "2027-06-01T00:00:00Z");
    assert.deepEqual(future.records.map((record) => record.state), ["fresh", "fresh", "fresh", "fresh"]);
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: "2027-06-01T00:00:00Z" })).total, 4, "isDefaultSelectable remains true");
    assert.equal((await validateKnowledgeStore(fx.workspace)).records, 4);
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test("INC-256 malformed policy red leg refuses the batch before any migration", async () => {
  const fx = await fixture();
  try {
    const created = await createKnowledgeUnit(fx.workspace, card(fx, "CARD-RED", "fact", 0));
    await assert.rejects(
      applyKnowledgeBatch(fx.workspace, policyBatch([{ verb: "knowledge-policy", id: created.id, expectedRevision: 1 }]), {
        expectedVersion: 1, occurredAt: instant(7),
      }),
      (error) => error?.reasonCode === "WORK_BATCH_REFUSED",
    );
    const unchanged = await listKnowledgeMetadata(fx.workspace, { at: instant(8), selection: "all" });
    assert.equal(unchanged.records[0].stalenessPolicy.maximumAgeDays, 180);
    assert.equal((await validateKnowledgeStore(fx.workspace)).version, 1);
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});
