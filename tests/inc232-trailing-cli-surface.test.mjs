// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-INC-232. The CLI is the only transport a governed session has, and until
// now nothing asserted that --allow-trailing survives the trip through it.
//
// INC-226 added the flag to five read verbs: the core behaviour was pinned, the catalog
// entry was pinned, and the wiring between them -- five hand-written argument lists and
// five hand-written option objects -- was not. A flag parsed but not threaded, or
// threaded into the wrong verb, produces the exact refusal INC-226 exists to remove,
// and every existing criterion stays green.
//
// The snippet and body reads are here for a second reason. They were given the
// exemption and the disclosure with no criterion on either, so a stale BODY -- the one
// read that returns content rather than metadata -- could have passed for a current one.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  acquireWorkspaceLease,
  createKnowledgeUnit,
  createProject,
  createWork,
  initializeKnowledgeStore,
  initializeWorkspace,
  readKnowledgeBody,
  readKnowledgeSnippet,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const instant = (second = 0) => `2026-08-19T15:00:${String(second).padStart(2, "0")}Z`;

// A store holding one promoted card, and a chain that has taken one further event since.
async function trailingFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc232-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: "INC232", createdAt: instant(), segmentEventLimit: 64 });
  const workspace = join(base, "workspace");
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  let state;
  try {
    state = await createProject(workspace, lease, {
      expectedVersion: 0, occurredAt: instant(1), externalKey: "INC232-PROJECT", name: "Transport",
    });
    state = await createWork(workspace, lease, {
      expectedVersion: 1, occurredAt: instant(2), projectId: state.projects[0].id,
      externalKey: "INC232-ANCHOR", kind: "Initiative", parentId: null, status: "active",
    });
  } finally {
    await lease.release();
  }
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  const created = await createKnowledgeUnit(workspace, {
    expectedVersion: 0, occurredAt: instant(3), externalKey: "INC232-CARD",
    scope: "project", projectId: state.projects[0].id, roleScopes: [],
    category: "workflow", kind: "guide", tags: ["transport"],
    subject: "A card that outlives the head it was filed against",
    summary: "Filed while aligned, read after the chain moved on.",
    snippet: "The transport must carry the flag, and the answer must carry the staleness.",
    accountableOwnerId: deriveStableId("owner", "INC232-OWNER"),
    sourceReferences: ["evidence://fixture/inc232"],
    sourceDigest: canonicalSha256({ key: "INC232-CARD" }),
    linkedWorkIds: [state.work[0].id],
    linkedDecisionIds: [deriveStableId("decision", "INC232-DECISION")],
    linkedGateIds: [deriveStableId("gate", "INC232-GATE")],
    linkedEvidenceIds: [deriveStableId("evidence", "INC232-EVIDENCE")],
    lifecycle: "active", retrievalDisposition: "default", freshnessState: "fresh",
    lastVerified: instant(2),
    stalenessPolicy: { maximumAgeDays: 3650, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: "Body bytes that must not pass for current ones.",
  });
  const id = String(created.id);
  // Left as a candidate on purpose: the reads under test either take selection "all" or
  // an explicit allow-unpromoted, so promotion would add a dependency this criterion does
  // not need and whose own rules would then be able to fail it for unrelated reasons.
  // The one event that puts the store behind. Nothing about the store changes.
  const second = await acquireWorkspaceLease(workspace, { now: instant(5) });
  try {
    await createWork(workspace, second, {
      expectedVersion: 2, occurredAt: instant(6), projectId: state.projects[0].id,
      externalKey: "INC232-THE-ONE-WRITE", kind: "Incident", parentId: null, status: "active",
    });
  } finally {
    await second.release();
  }
  return { base, workspace, id };
}

function capture() {
  const chunks = [];
  return { io: { write: (text) => chunks.push(text) }, text: () => chunks.join("") };
}

async function cli(argv) {
  const out = capture();
  try {
    await runCli(argv, out.io);
    return { ok: true, value: JSON.parse(out.text()) };
  } catch (error) {
    return { ok: false, reasonCode: error?.reasonCode ?? String(error) };
  }
}

// Red leg: drop the flag from any one verb's parseArguments list, or forget to thread it
// into that verb's options object, and exactly that verb comes back red here while the
// core criteria and the catalog criterion both stay green.
test("INC-232: every read verb the catalog says takes --allow-trailing actually honours it", async () => {
  const { base, workspace, id } = await trailingFixture();
  try {
    const invocations = [
      ["knowledge-list", "--workspace", workspace, "--at", instant(7), "--selection", "all"],
      ["knowledge-candidates", "--workspace", workspace, "--at", instant(7), "--selection", "all"],
      ["knowledge-freshness", "--workspace", workspace, "--at", instant(7)],
      ["knowledge-snippet", "--workspace", workspace, "--id", id],
      ["knowledge-body", "--workspace", workspace, "--id", id, "--at", instant(7), "--allow-unpromoted", "true"],
    ];
    for (const argv of invocations) {
      const refused = await cli(argv);
      assert.equal(refused.ok, false, `${argv[0]} must refuse a trailing store by default`);
      assert.equal(refused.reasonCode, "KNOWLEDGE_HIGH_WATER_MISMATCH", argv[0]);
      const admitted = await cli([...argv, "--allow-trailing", "true"]);
      assert.equal(admitted.ok, true, `${argv[0]} must be admitted with the flag: ${admitted.reasonCode}`);
      assert.equal(admitted.value.knowledgeStoreTrailing, true, `${argv[0]} must disclose that it trails`);
      assert.notEqual(admitted.value.storeHighWaterDigest, admitted.value.chainHeadEventHash, argv[0]);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// The two content-bearing reads had the exemption and no criterion. A body is the only
// read that returns bytes rather than metadata, so an undisclosed stale one is the worst
// case this disclosure exists for. Red leg: drop trailingDisclosure from either result.
test("INC-232: a trailing snippet and a trailing body both say so at the library level", async () => {
  const { base, workspace, id } = await trailingFixture();
  try {
    const snippet = await readKnowledgeSnippet(workspace, id, { allowTrailing: true });
    assert.equal(snippet.knowledgeStoreTrailing, true);
    assert.notEqual(snippet.storeHighWaterDigest, snippet.chainHeadEventHash);
    const body = await readKnowledgeBody(workspace, id, { at: instant(7), allowTrailing: true, allowUnpromoted: true });
    assert.equal(body.knowledgeStoreTrailing, true, "a stale body must never pass for a current one");
    assert.notEqual(body.storeHighWaterDigest, body.chainHeadEventHash);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Red leg: let exportKnowledgeCheckpoint keep the exemption it inherited from the
// five/six miscount. The checkpoint is the export artifact and must not be stale-able,
// and it is the one metadata-only scan whose result carries no disclosure to fall back on.
test("INC-232: a checkpoint refuses a trailing store however the flag is passed", async () => {
  const { base, workspace } = await trailingFixture();
  try {
    const { exportKnowledgeCheckpoint } = await import("../dist/build/packages/core/src/index.js");
    for (const options of [{}, { allowTrailing: true }]) {
      await assert.rejects(
        () => exportKnowledgeCheckpoint(workspace, instant(7), options),
        (error) => error?.reasonCode === "KNOWLEDGE_HIGH_WATER_MISMATCH",
        "an export artifact takes the strict rule, not a label",
      );
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
