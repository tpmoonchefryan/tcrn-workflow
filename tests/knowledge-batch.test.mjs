// SPDX-License-Identifier: Apache-2.0
//
// Knowledge-batch: N cards, one invocation.
//
// The measured case this exists for: filing four cards on 2026-08-19 took sixteen CLI
// round trips -- per card a version read, the write, a receipt read, plus the rebase any
// intervening chain write forces. One batch is one invocation with the rebase folded in.
//
// The deliberate difference from work-batch, which these criteria pin rather than hide:
// this batch is per-member atomic, not all-or-nothing. The store is a disposable,
// rebuildable projection and every member keeps the per-mutation atomicity the knowledge
// verbs have always had, so a mid-batch failure leaves the earlier members applied -- and
// the refusal must say exactly which, or partiality becomes a silent lie.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  applyKnowledgeBatch,
  createProject,
  createWork,
  initializeKnowledgeStore,
  initializeWorkspace,
  listKnowledgeMetadata,
  validateKnowledgeStore,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = (second = 0) => `2026-08-19T22:00:${String(second).padStart(2, "0")}Z`;

async function workspaceWithStore() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-kbatch-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: "KBATCH", createdAt: at(0), segmentEventLimit: 64 });
  const root = join(base, "workspace");
  const lease = await acquireWorkspaceLease(root, { now: at(1) });
  let state;
  try {
    state = await createProject(root, lease, { expectedVersion: 0, occurredAt: at(1), externalKey: "KBATCH-P", name: "KBatch" });
  } finally {
    await lease.release();
  }
  await initializeKnowledgeStore(root, { disposableAcknowledged: true });
  return { base, root, projectId: state.projects[0].id, chainVersion: state.version };
}

const card = (fixture, n) => ({
  verb: "knowledge-create",
  externalKey: `KB-CARD-${n}`,
  scope: "project", projectId: fixture.projectId, roleScopes: [],
  category: "workflow", kind: "fact", tags: ["batch"],
  subject: `Card ${n} subject`, summary: `Card ${n} summary.`, snippet: `Card ${n} snippet.`,
  accountableOwnerId: deriveStableId("owner", "KB-OWNER"),
  sourceReferences: [`evidence://kb/${n}`], sourceDigest: canonicalSha256({ n }),
  linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [],
  linkedEvidenceIds: [deriveStableId("evidence", `KB-EV-${n}`)],
  lifecycle: "active", retrievalDisposition: "default", freshnessState: "fresh",
  lastVerified: at(1), stalenessPolicy: { maximumAgeDays: 180, unknownDisposition: "fail-closed" },
  exportDisposition: "metadata-only", body: `Card ${n} body.`,
});

const batch = (members) => ({ schemaVersion: "tcrn.knowledge-batch.v1", members });

const refusal = async (operation) => {
  try {
    await operation();
    return null;
  } catch (error) {
    return { reasonCode: error?.reasonCode, payload: JSON.parse(error.message) };
  }
};

// The motivating case, whole: a chain write has invalidated the store (the normal state of
// a workspace being worked in), and one invocation aligns it, files four cards and
// promotes one. Red leg: drop the alignFirst rebase and the first create refuses
// KNOWLEDGE_HIGH_WATER_MISMATCH -- sixteen round trips' worth of ceremony returns.
test("knowledge-batch: align, four cards and a promote in one act", async () => {
  const fixture = await workspaceWithStore();
  try {
    const lease = await acquireWorkspaceLease(fixture.root, { now: at(2) });
    try {
      await createWork(fixture.root, lease, {
        expectedVersion: fixture.chainVersion, occurredAt: at(2), projectId: fixture.projectId,
        externalKey: "KBATCH-W", kind: "Incident", parentId: null, status: "active",
      });
    } finally {
      await lease.release();
    }
    const result = await applyKnowledgeBatch(fixture.root, batch([
      card(fixture, 1), card(fixture, 2), card(fixture, 3), card(fixture, 4),
      { verb: "knowledge-promote", externalKey: "KB-CARD-1", state: "promoted" },
    ]), { expectedVersion: 0, occurredAt: at(3), alignFirst: true });
    assert.equal(result.reasonCode, "KNOWLEDGE_BATCH_APPLIED");
    assert.equal(result.aligned, true);
    assert.equal(result.applied.length, 6, "the rebase and all five members are receipted");
    const all = await listKnowledgeMetadata(fixture.root, { at: at(4), selection: "all", allowTrailing: true });
    assert.equal(all.total, 4);
    const promoted = await listKnowledgeMetadata(fixture.root, { at: at(4), allowTrailing: true });
    assert.equal(promoted.total, 1, "the promote saw the card its predecessor created");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// The store version is threaded internally -- the caller supplies it once. Red leg: stop
// threading and member two refuses KNOWLEDGE_CAS_MISMATCH against a version that moved.
test("knowledge-batch: the caller reads the store version once, however many members follow", async () => {
  const fixture = await workspaceWithStore();
  try {
    const result = await applyKnowledgeBatch(fixture.root, batch([
      card(fixture, 1), card(fixture, 2), card(fixture, 3),
    ]), { expectedVersion: 0, occurredAt: at(2) });
    assert.equal(result.reasonCode, "KNOWLEDGE_BATCH_APPLIED");
    assert.equal(result.version, 3, "three mutations from the version supplied once");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Partiality is the designed trade, and the refusal must report it structurally: what
// landed (it stays landed), what failed (with the member's own reason code), what was
// never judged. Red leg: report only the failure and the two applied cards become
// invisible -- a partial batch wearing an all-or-nothing refusal's clothes.
test("knowledge-batch: a mid-batch failure names what landed, what failed, and what was never judged", async () => {
  const fixture = await workspaceWithStore();
  try {
    const result = await refusal(() => applyKnowledgeBatch(fixture.root, batch([
      card(fixture, 1),
      card(fixture, 2),
      { ...card(fixture, 1), externalKey: "KB-CARD-1" }, // duplicate: fails on its own terms
      card(fixture, 4),
    ]), { expectedVersion: 0, occurredAt: at(2) }));
    assert.equal(result.reasonCode, "WORK_BATCH_REFUSED");
    assert.equal(result.payload.stage, "apply");
    assert.equal(result.payload.applied.length, 2, "the two cards that landed are receipted");
    assert.equal(result.payload.failed.index, 2);
    assert.match(result.payload.failed.reasonCode, /KNOWLEDGE/u, "the member's own reason code survives");
    assert.deepEqual(result.payload.notEvaluated, [3]);
    // And the store is not damaged by the partial batch: it validates, and holds
    // exactly the applied members.
    await validateKnowledgeStore(fixture.root);
    const all = await listKnowledgeMetadata(fixture.root, { at: at(3), selection: "all" });
    assert.equal(all.total, 2);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Red leg: skip the stateless pass and five malformed members cost five round trips to
// discover -- the ceremony this verb exists to remove, reappearing in its refusal path.
test("knowledge-batch: every shape problem is reported at once, before any mutation", async () => {
  const fixture = await workspaceWithStore();
  try {
    const result = await refusal(() => applyKnowledgeBatch(fixture.root, batch([
      { verb: "knowledge-invent" },
      { verb: "knowledge-create", externalKey: "KB-X" },
      { verb: "knowledge-promote", externalKey: "KB-X", state: "sideways" },
      { verb: "knowledge-retire" },
    ]), { expectedVersion: 0, occurredAt: at(2) }));
    assert.equal(result.payload.stage, "shape");
    assert.deepEqual([...new Set(result.payload.problems.map((problem) => problem.index))], [0, 1, 2, 3]);
    const rules = new Set(result.payload.problems.map((problem) => problem.rule));
    for (const rule of ["verb-known", "field-required", "state-known", "reference-required"]) {
      assert.ok(rules.has(rule), `${rule} is reported`);
    }
    const untouched = await listKnowledgeMetadata(fixture.root, { at: at(3), selection: "all" });
    assert.equal(untouched.total, 0, "no mutation ran");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// A member acting on a card the batch did not touch must carry expectedRevision: the
// batch can only vouch for revisions it observed. Red leg: default to revision 1 and a
// twice-revised card is mutated against a stale revision the caller never stated.
test("knowledge-batch: acting on an untouched card demands an explicit revision", async () => {
  const fixture = await workspaceWithStore();
  try {
    await applyKnowledgeBatch(fixture.root, batch([card(fixture, 1)]), { expectedVersion: 0, occurredAt: at(2) });
    const result = await refusal(() => applyKnowledgeBatch(fixture.root, batch([
      { verb: "knowledge-promote", externalKey: "KB-CARD-1", state: "promoted" },
    ]), { expectedVersion: 1, occurredAt: at(3) }));
    assert.equal(result.payload.failed.reasonCode, "KNOWLEDGE_CAS_MISMATCH");
    assert.match(result.payload.failed.detail, /expectedRevision is required/u);
    const explicit = await applyKnowledgeBatch(fixture.root, batch([
      { verb: "knowledge-promote", externalKey: "KB-CARD-1", state: "promoted", expectedRevision: 1 },
    ]), { expectedVersion: 1, occurredAt: at(4) });
    assert.equal(explicit.reasonCode, "KNOWLEDGE_BATCH_APPLIED");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Red leg: accept a foreign or empty document and a caller holds a receipt for nothing.
test("knowledge-batch: a batch that is not a batch is refused whole", async () => {
  const fixture = await workspaceWithStore();
  try {
    for (const document of [null, [], {}, { schemaVersion: "tcrn.knowledge-batch.v1", members: [] }, { schemaVersion: "other", members: [{}] }]) {
      await assert.rejects(
        () => applyKnowledgeBatch(fixture.root, document, { expectedVersion: 0, occurredAt: at(2) }),
        (error) => error?.reasonCode === "WORK_BATCH_MALFORMED",
        JSON.stringify(document),
      );
    }
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});
