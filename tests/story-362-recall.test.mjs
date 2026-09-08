// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-362 — the FTS5 recall core and the verb that dispatches it.
//
// The defect this replaces is not "retrieval was weak". It is that two different
// answers were both wrong in opposite directions: a Chinese prompt became one long
// token and matched nothing, while an English tag word matched every card carrying
// that tag and returned the library. The tests below pin both ends — a prompt that
// shares one bigram with a card finds it, and a term most of the corpus carries
// selects nothing — because a change that fixes one by breaking the other is not a
// fix, and only the pair says so.
//
// The 36-question recall numbers the Story is judged on are measured against the
// shared evaluation corpus, which is a read-only export of a live chain and does not
// live in this repository. They are not asserted here; this file pins the mechanisms
// those numbers depend on.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RecallIndex,
  recall,
  recallDocuments,
  recallQueryTokens,
  resetRecallCache,
  segmentForIndex,
  selectRecallHits,
} from "../dist/build/packages/core/src/recall.js";
import {
  acquireWorkspaceLease,
  captureKnowledgeUnit,
  createProject,
  createWork,
  initializeKnowledgeStore,
  initializeWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";

const instant = (second) => `2026-09-08T00:00:${String(second).padStart(2, "0")}Z`;

function card(id, subject, summary, snippet, tags) {
  return { id, externalKey: id.toUpperCase(), subject, summary, snippet, tags };
}

const CARDS = [
  card("k1", "链头变化后知识索引必须重建", "每次链写都拉开 store 标记差距", "写路径自动 rebase", ["lesson", "knowledge"]),
  card("k2", "hook 注册必须用项目目录变量形态", "settings.json 里的相对路径不生效", "绝对路径或变量", ["lesson", "hook"]),
  card("k3", "覆盖注册表看不见死掉的被测物", "删测试丢覆盖要按分支查", "按文件查会漏", ["lesson", "gate"]),
  card("k4", "Release trust root layout", "Where the trust archive lives", "one canonical origin", ["reference"]),
];

test("STORY-362: CJK is segmented into bigrams on both sides, so a differently worded question still lands", () => {
  assert.equal(segmentForIndex("链头变化"), "链头 头变 变化");
  assert.equal(segmentForIndex("a 门 b"), "a 门 b", "a one-character run has no bigram and is kept whole");
  assert.ok(recallQueryTokens("链头怎么变").includes("链头"));
  assert.ok(!recallQueryTokens("怎么办才好").includes("怎么"), "a connective bigram is dropped");
  const index = new RecallIndex(recallDocuments({ knowledge: CARDS }), "c0");
  const hits = index.search("链头变了知识索引要不要重建");
  assert.equal(hits[0].id, "k1", "the card is reached through a shared bigram, not a shared whole phrase");
  assert.ok(hits[0].score > 1);
  // The behaviour this replaces: the whole run as one token matched nothing at all.
  assert.equal(recallQueryTokens("链头变了知识索引要不要重建").includes("链头变了知识索引要不要重建"), false);
  index.close();
});

test("STORY-362: a term most of the corpus carries scores below the absolute floor and selects nothing", () => {
  const index = new RecallIndex(recallDocuments({ knowledge: CARDS }), "c0");
  const flooded = index.search("lesson");
  assert.equal(flooded.length, 3, "the substring answer is still three cards");
  assert.ok(flooded.every((hit) => hit.score < 1), `every score is below the floor, saw ${flooded.map((h) => h.score).join(",")}`);
  assert.deepEqual(selectRecallHits(flooded), [], "and the threshold turns them into no answer");
  // Discrimination: a term two of four cards do not carry survives the same floor.
  const specific = index.search("hook");
  assert.ok(selectRecallHits(specific).length >= 1);
  assert.equal(selectRecallHits(specific)[0].id, "k2");
  index.close();
});

test("STORY-362: an external key spelled in the prompt puts that record first, above every ranked hit", () => {
  const documents = recallDocuments({
    knowledge: CARDS,
    work: [
      { id: "w1", externalKey: "TCRN-CROSS-STORY-362", kind: "Story", status: "active", title: "FTS5 检索核心", summary: "为谁=每条 prompt 前需要相关知识的会话", scope: "", labels: [] },
      { id: "w2", externalKey: "TCRN-CROSS-MIN-ACCEPTANCE-LANES", kind: "Incident", status: "done", title: "验收车道", summary: "done 归属判据", scope: "", labels: [] },
    ],
  });
  const index = new RecallIndex(documents, "c0");
  const hits = selectRecallHits(index.search("TCRN-CROSS-STORY-362 的检索核心怎么做"));
  assert.equal(hits[0].kind, "work");
  assert.equal(hits[0].key, "TCRN-CROSS-STORY-362");
  assert.equal(hits[0].score, 99);
  // A key with a non-numeric tail is a live spelling on this platform, so the match is
  // corpus membership rather than a pattern that assumes a numeric suffix.
  assert.equal(selectRecallHits(index.search("TCRN-CROSS-MIN-ACCEPTANCE-LANES 说了什么"))[0].key, "TCRN-CROSS-MIN-ACCEPTANCE-LANES");
  index.close();
});

test("STORY-362: a work record with neither a title nor summary text is not indexed at all", () => {
  const work = [
    { id: "w1", externalKey: "K-1", kind: "Story", status: "active", title: "有标题", summary: null, scope: "", labels: [] },
    { id: "w2", externalKey: "K-2", kind: "Story", status: "active", title: null, summary: "有摘要", scope: "", labels: [] },
    { id: "w3", externalKey: "K-3", kind: "Story", status: "active", title: null, summary: null, scope: "scope prose", labels: [] },
    { id: "w4", externalKey: "K-4", kind: "Story", status: "active", title: null, summary: null, scope: "", labels: [] },
  ];
  const documents = recallDocuments({ work });
  assert.deepEqual(documents.map((entry) => entry.id), ["w1", "w2", "w3"], "only the textless record is dropped");
  // retrieval.scopeExcerptBytes bounds the summary text a record without its own
  // summary contributes, and the bound is applied on a UTF-8 boundary.
  const bounded = recallDocuments({ work: [{ ...work[2], scope: "一二三四五六七八九十" }], scopeExcerptBytes: 7 });
  assert.equal(bounded[0].summary, "一二");
});

test("STORY-362: field weights rank a title match above a body match of the same term", () => {
  const index = new RecallIndex(recallDocuments({
    knowledge: [
      card("t1", "archive rotation", "unrelated prose about storage", "", []),
      card("t2", "storage backend", "the archive rotation is described here at some length", "", []),
    ],
  }), "c0");
  const hits = index.search("archive rotation");
  assert.equal(hits[0].id, "t1", "title weight 8 beats body weight 3");
  index.close();
});

test("STORY-362: the index is cached against the storage checkpoint and rewritten incrementally when it moves", () => {
  resetRecallCache();
  const documents = recallDocuments({ knowledge: CARDS });
  let reads = 0;
  const request = (checkpoint, docs) => ({
    cacheKey: "ws", checkpoint, query: "hook", documents: () => { reads += 1; return docs; },
  });
  const first = recall(request("head-1", documents));
  assert.equal(first.rebuilt, true);
  assert.equal(first.indexed, 4);
  assert.equal(reads, 1);
  const second = recall(request("head-1", documents));
  assert.equal(second.rebuilt, false, "the same checkpoint reuses the index");
  assert.equal(reads, 1, "and does not even read the documents");
  const moved = [...documents.slice(0, 3), { ...documents[3], body: "the trust archive moved" }];
  const third = recall(request("head-2", moved));
  assert.equal(third.rebuilt, true);
  assert.equal(third.inserted, 1, "one document changed, so one row is rewritten");
  assert.equal(third.removed, 1);
  assert.equal(third.indexed, 4);
  assert.equal(reads, 2);
  resetRecallCache();
});

async function syntheticWorkspace(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-story-362-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const partitionPath = join(base, ".tcrn-workspace", "cross-project");
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(partitionPath, kind);
    await mkdir(path, { recursive: true });
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: "STORY-362-RECALL", createdAt: instant(0) });
  const workspace = join(partitionPath, "workspace");
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  let state;
  try {
    state = await createProject(workspace, lease, {
      expectedVersion: 0, occurredAt: instant(1), externalKey: "STORY-362-PROJECT", name: "Recall",
    });
    state = await createWork(workspace, lease, {
      expectedVersion: state.version, occurredAt: instant(2), projectId: state.projects[0].id,
      externalKey: "TCRN-CROSS-STORY-362", kind: "Initiative", parentId: null,
      title: "FTS5 检索核心",
    });
  } finally {
    await lease.release();
  }
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  let version = 0;
  for (const entry of CARDS) {
    const written = await captureKnowledgeUnit(workspace, {
      occurredAt: instant(3), subject: entry.subject, summary: entry.summary, snippet: entry.snippet,
      tags: entry.tags, accountableOwnerId: deriveStableId("owner", "STORY-362-OWNER"),
      body: `${entry.subject} ${entry.summary}`, externalKey: entry.externalKey,
      expectedVersion: version, coexist: true,
    });
    version = Number(written.version);
  }
  return { base, workspace };
}

async function cli(argv) {
  let output = "";
  await runCli(argv, { write(value) { output = value; } });
  return JSON.parse(output);
}

test("STORY-362: the recall verb answers with kind, key, status, title, summary and score", async (context) => {
  const { workspace } = await syntheticWorkspace(context);
  resetRecallCache();
  const answer = await cli(["recall", "--workspace", workspace, "--at", instant(9), "--query", "hook 没有生效", "--allow-trailing", "true"]);
  assert.equal(answer.reasonCode, "RECALL_READY");
  assert.equal(answer.schemaVersion, "tcrn.recall.v1");
  assert.equal(answer.partition, "cross-project");
  assert.equal(answer.tau, "1.0000", "the recorded default of the retrieval.tau setting, spoken as a decimal string");
  assert.equal(answer.relativeFloor, "0.2500");
  assert.ok(answer.records.length >= 1);
  assert.deepEqual(Object.keys(answer.records[0]).sort(), ["id", "key", "kind", "score", "status", "summary", "title"]);
  assert.equal(answer.records[0].kind, "card");
  assert.equal(answer.records[0].title, "hook 注册必须用项目目录变量形态");
  assert.ok(Number(answer.records[0].score) > 1, "the score is a decimal string a caller can compare against tau");
  assert.equal(answer.indexed, 5, "four cards and the one work record that carries a title");
  resetRecallCache();
});

test("STORY-362: the verb refuses a partition that is not the one the given path belongs to", async (context) => {
  const { workspace } = await syntheticWorkspace(context);
  resetRecallCache();
  await assert.rejects(
    () => cli(["recall", "--workspace", workspace, "--at", instant(9), "--query", "hook", "--partition", "TCRN-AOS"]),
    (error) => error.reasonCode === "CLI_ARGUMENT_MALFORMED",
  );
  const accepted = await cli(["recall", "--workspace", workspace, "--at", instant(9), "--query", "hook", "--partition", "cross-project", "--allow-trailing", "true"]);
  assert.equal(accepted.reasonCode, "RECALL_READY");
  resetRecallCache();
});

test("STORY-362: --tau overrides the setting, and a flooded term returns nothing at the recorded default", async (context) => {
  const { workspace } = await syntheticWorkspace(context);
  resetRecallCache();
  const floored = await cli(["recall", "--workspace", workspace, "--at", instant(9), "--query", "lesson", "--allow-trailing", "true"]);
  assert.equal(floored.records.length, 0, "three of five documents carry the tag, so it discriminates nothing");
  assert.ok(floored.total > 0, "the ranked list is not empty; the threshold is what empties the answer");
  const lowered = await cli(["recall", "--workspace", workspace, "--at", instant(9), "--query", "lesson", "--tau", "0", "--allow-trailing", "true"]);
  assert.equal(lowered.tau, "0.0000");
  assert.ok(lowered.records.length > 0, "the same query answers once the floor is lowered");
  await assert.rejects(
    () => cli(["recall", "--workspace", workspace, "--at", instant(9), "--query", "lesson", "--tau", "not-a-number"]),
    (error) => error.reasonCode === "CLI_ARGUMENT_MALFORMED",
  );
  resetRecallCache();
});
