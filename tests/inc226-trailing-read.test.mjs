// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-INC-226. Retrieval has to work in a workspace someone is working in.
//
// knowledge-core required the store's marker to equal the chain head exactly, and
// applied that to reads. Any event moves the head, so one governed write took the
// whole retrieval surface offline until a hand-run rebase. Measured on 2026-08-19:
// all six partitions refusing every knowledge read, and TCRN-TMS -- rebased and then
// left alone -- answering normally, which isolated the write as the cause.
//
// The exemption these criteria pin is deliberately narrow, and it is paid for: a
// trailing read is admitted, and the answer says that it trails.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  createKnowledgeUnit,
  createProject,
  createWork,
  evaluateKnowledgeFreshness,
  initializeKnowledgeStore,
  initializeWorkspace,
  knowledgeContextCandidates,
  listKnowledgeMetadata,
  validateKnowledgeStore,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const instant = (day, second = 0) => `2026-08-${String(day).padStart(2, "0")}T14:00:${String(second).padStart(2, "0")}Z`;

async function emptyWorkspace(externalKey) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc226-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey, createdAt: instant(19), segmentEventLimit: 64 });
  return { base, workspace: join(base, "workspace") };
}

// A store holding one card, and a chain that has since taken exactly one more event.
// That single event is the entire defect: nothing about the store changed.
async function storeTrailingByOneWrite() {
  const { base, workspace } = await emptyWorkspace("INC226-TRAILING");
  const lease = await acquireWorkspaceLease(workspace, { now: instant(19, 1) });
  let state;
  try {
    state = await createProject(workspace, lease, {
      expectedVersion: 0, occurredAt: instant(19, 1), externalKey: "INC226-PROJECT", name: "Retrieval",
    });
    state = await createWork(workspace, lease, {
      expectedVersion: 1, occurredAt: instant(19, 2), projectId: state.projects[0].id,
      externalKey: "INC226-ANCHOR", kind: "Initiative", parentId: null, status: "active",
    });
  } finally {
    await lease.release();
  }
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  await createKnowledgeUnit(workspace, {
    expectedVersion: 0, occurredAt: instant(19, 3), externalKey: "INC226-CARD",
    scope: "project", projectId: state.projects[0].id, roleScopes: [],
    category: "workflow", kind: "guide", tags: ["retrieval"],
    subject: "A card filed while the store was aligned",
    summary: "Exists so a trailing read has something to return.",
    snippet: "The store still answers after the chain moves.",
    accountableOwnerId: deriveStableId("owner", "INC226-OWNER"),
    sourceReferences: ["evidence://fixture/inc226"],
    sourceDigest: canonicalSha256({ key: "INC226-CARD" }),
    linkedWorkIds: [state.work[0].id],
    linkedDecisionIds: [deriveStableId("decision", "INC226-DECISION")],
    linkedGateIds: [deriveStableId("gate", "INC226-GATE")],
    linkedEvidenceIds: [deriveStableId("evidence", "INC226-EVIDENCE")],
    lifecycle: "active", retrievalDisposition: "default", freshnessState: "fresh",
    lastVerified: instant(19, 2),
    stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: "Filed before the chain advanced.",
  });
  const second = await acquireWorkspaceLease(workspace, { now: instant(19, 4) });
  let advanced;
  try {
    advanced = await createWork(workspace, second, {
      expectedVersion: 2, occurredAt: instant(19, 5), projectId: state.projects[0].id,
      externalKey: "INC226-THE-ONE-WRITE", kind: "Incident", parentId: null, status: "active",
    });
  } finally {
    await second.release();
  }
  return { base, workspace, headEventHash: advanced.headEventHash, projectId: state.projects[0].id, workId: state.work[0].id };
}

// Red leg: drop the `trailingAdmitted` term and this is KNOWLEDGE_HIGH_WATER_MISMATCH
// again -- which is what every session on this platform hit all week.
test("INC-226: a metadata-first read answers after the chain advances, when asked to", async () => {
  const { base, workspace } = await storeTrailingByOneWrite();
  try {
    await assert.rejects(
      () => listKnowledgeMetadata(workspace, { at: instant(19, 6) }),
      (error) => error?.reasonCode === "KNOWLEDGE_HIGH_WATER_MISMATCH",
      "the default must keep refusing -- every existing caller depends on it",
    );
    // selection "all" rather than the default: a freshly created card is a promotion
    // candidate, and the default selection shows only promoted ones. That filter is
    // orthogonal to this defect and stays exactly as it was -- the claim here is that
    // the read answers at all, where it used to refuse.
    const admitted = await listKnowledgeMetadata(workspace, { at: instant(19, 6), selection: "all", allowTrailing: true });
    assert.equal(admitted.reasonCode, "KNOWLEDGE_LIST_READY");
    assert.equal(admitted.total, 1, "the card filed before the write is still retrievable");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// The exemption is only worth having if a stale answer cannot pass for a current one.
// Red leg: drop trailingDisclosure and the response is indistinguishable from an
// aligned one, which is strictly worse than the refusal it replaced.
test("INC-226: a trailing answer carries both heads, so staleness is answerable from it", async () => {
  const { base, workspace, headEventHash } = await storeTrailingByOneWrite();
  try {
    for (const read of [
      () => listKnowledgeMetadata(workspace, { at: instant(19, 6), allowTrailing: true }),
      () => knowledgeContextCandidates(workspace, { at: instant(19, 6), allowTrailing: true }),
      () => evaluateKnowledgeFreshness(workspace, instant(19, 6), { allowTrailing: true }),
    ]) {
      const result = await read();
      assert.equal(result.knowledgeStoreTrailing, true, "the flag a caller branches on");
      assert.equal(result.chainHeadEventHash, headEventHash, "the head it trails");
      assert.notEqual(result.storeHighWaterDigest, result.chainHeadEventHash, "and its own, which differs");
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Red leg: widen the exemption past `bodyMode === "metadata-only"` and validate stops
// being able to tell an aligned store from a trailing one -- the check whose entire
// job is to answer that question.
test("INC-226: validate is not exempt, however the flag is passed", async () => {
  const { base, workspace } = await storeTrailingByOneWrite();
  try {
    for (const options of [{}, { allowTrailing: true }]) {
      await assert.rejects(
        () => validateKnowledgeStore(workspace, options),
        (error) => error?.reasonCode === "KNOWLEDGE_HIGH_WATER_MISMATCH",
        "validate must refuse a trailing store even when handed the read-path flag",
      );
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Red leg: let the exemption reach a mutation and a candidate can be filed against a
// head the store never saw -- the provenance hole the strict equality existed to close.
test("INC-226: a write is not exempt -- filing still demands an aligned store", async () => {
  const { base, workspace, projectId, workId } = await storeTrailingByOneWrite();
  try {
    await assert.rejects(
      () => createKnowledgeUnit(workspace, {
        expectedVersion: 1, occurredAt: instant(19, 6), externalKey: "INC226-CARD-2",
        scope: "project", projectId, roleScopes: [],
        category: "workflow", kind: "guide", tags: ["retrieval"],
        subject: "Filed against a head the store never saw",
        summary: "Must not be admitted.", snippet: "Must not be admitted.",
        accountableOwnerId: deriveStableId("owner", "INC226-OWNER-2"),
        sourceReferences: ["evidence://fixture/inc226-2"],
        sourceDigest: canonicalSha256({ key: "INC226-CARD-2" }),
        linkedWorkIds: [workId],
        linkedDecisionIds: [deriveStableId("decision", "INC226-DECISION-2")],
        linkedGateIds: [deriveStableId("gate", "INC226-GATE-2")],
        linkedEvidenceIds: [deriveStableId("evidence", "INC226-EVIDENCE-2")],
        lifecycle: "active", retrievalDisposition: "default", freshnessState: "fresh",
        lastVerified: instant(19, 5),
        stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
        exportDisposition: "metadata-only", body: "Must not be admitted.",
        allowTrailing: true,
      }),
      (error) => error?.reasonCode === "KNOWLEDGE_HIGH_WATER_MISMATCH",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// An aligned store must answer exactly as it did before this change existed, or every
// caller reading today's response shape has to be revisited. Red leg: emit the
// disclosure unconditionally and this fails on the extra keys.
test("INC-226: an aligned read is byte-identical to what it was before the exemption", async () => {
  const { base, workspace } = await emptyWorkspace("INC226-ALIGNED");
  try {
    const lease = await acquireWorkspaceLease(workspace, { now: instant(19, 1) });
    try {
      await createProject(workspace, lease, {
        expectedVersion: 0, occurredAt: instant(19, 1), externalKey: "INC226-ALIGNED-PROJECT", name: "Aligned",
      });
    } finally {
      await lease.release();
    }
    await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
    const plain = await listKnowledgeMetadata(workspace, { at: instant(19, 6) });
    const asked = await listKnowledgeMetadata(workspace, { at: instant(19, 6), allowTrailing: true });
    assert.deepEqual(asked, plain, "asking for trailing reads changes nothing when nothing trails");
    for (const key of ["knowledgeStoreTrailing", "storeHighWaterDigest", "chainHeadEventHash"]) {
      assert.equal(key in plain, false, `${key} must be absent when the store is current`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
