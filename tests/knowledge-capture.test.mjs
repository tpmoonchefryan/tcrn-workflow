// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-365 — capture, the Stop-hook write, and write-time conflict scoring.
//
// Owner ruling TCRN-CROSS-MIN-146 is the behaviour under test: a small card is official
// the moment it is written. Every case below therefore asserts the WRITTEN state, never a
// promotion step — and the last case asserts that nothing this Story writes lands as a
// candidate, which is the ruling stated as a machine check rather than as prose.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  KNOWLEDGE_CONFLICT_SCORE_THRESHOLD,
  acquireWorkspaceLease,
  captureKnowledgeUnit,
  createProject,
  initializeKnowledgeStore,
  initializeWorkspace,
  knowledgeConflictHits,
  knowledgeRelevanceScore,
  listKnowledgeMetadata,
  readTelemetryRecords,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";
import {
  boundedUtf8,
  captureArguments,
  cardFor,
  extractLessons,
  hostFromArgv,
  runCaptureHook,
} from "../scripts/knowledge-capture-hook.mjs";

const instant = (day, second = 0) => `2026-09-${String(day).padStart(2, "0")}T09:00:${String(second).padStart(2, "0")}Z`;
const OWNER = "owner:agent-session";

/**
 * A throwaway platform container with one governed workspace in the cross-project
 * partition, so the hook can be driven at the same path shape it runs at in production.
 */
async function containerFixture(externalKey = "FIXTURE-CAPTURE") {
  const container = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s365-")));
  const base = join(container, ".tcrn-workspace", "cross-project");
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path, { recursive: true });
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey, createdAt: instant(1), segmentEventLimit: 64 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1, 1) });
  try {
    await createProject(workspace, lease, {
      expectedVersion: 0, occurredAt: instant(1, 1), externalKey: "FIXTURE-CAPTURE-PROJECT", name: "Capture Fixture",
    });
  } finally {
    await lease.release();
  }
  await initializeKnowledgeStore(workspace);
  return { container, workspace, close: () => rm(container, { recursive: true, force: true }) };
}

function lessonCard(subject, overrides = {}) {
  return {
    occurredAt: instant(2), subject, summary: `${subject} 的完整说明`, snippet: `${subject} 摘录`,
    tags: ["lesson"], accountableOwnerId: OWNER, body: `${subject} 正文`, ...overrides,
  };
}

async function cliJson(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

test("STORY-365 lessons are the declared paragraphs, bounded and in order", () => {
  const turn = [
    "先说结论，这段不是经验。",
    "",
    "经验：guard-check 运行期间不要并发编辑工作树",
    "它在运行时真实变异工作树，当独占操作对待。",
    "",
    "Lesson: clone, not worktree, for a dry run",
    "",
    "经验:策略 JSON 按键定位，不按行号",
    "",
    "经验：第四条应当被丢弃",
  ].join("\n");
  const lessons = extractLessons(turn);
  assert.equal(lessons.length, 3, "at most three lessons per turn");
  assert.equal(lessons[0].split("\n").length, 2, "a lesson runs to the blank line, so it stays one card");
  assert.equal(lessons[1], "clone, not worktree, for a dry run");
  assert.equal(lessons[2], "策略 JSON 按键定位，不按行号");
  assert.deepEqual(extractLessons("没有标记的一段话"), [], "prose that declared nothing writes nothing");
  assert.deepEqual(extractLessons(null), [], "an unreadable transcript writes nothing");
});

test("STORY-365 a bounded field never splits a UTF-8 sequence", () => {
  assert.equal(boundedUtf8("经验记录", 7), "经验", "seven bytes hold two three-byte characters and no half of a third");
  assert.equal(Buffer.byteLength(boundedUtf8("经验记录", 7), "utf8"), 6);
  assert.equal(boundedUtf8("abc", 8), "abc", "a short value is returned whole");
  const card = cardFor("头一行\n第二行");
  assert.equal(card.subject, "头一行", "the subject is the headline, not the whole lesson");
  assert.equal(card.body, "头一行\n第二行");
  assert.ok(captureArguments(card, "/ws", instant(2)).includes("--coexist"), "the hook path answers coexist by default");
});

test("STORY-365 GWT1: a declared lesson becomes a promoted card default recall finds", async () => {
  const fixture = await containerFixture("FIXTURE-CAPTURE-HOOK");
  try {
    const transcript = join(fixture.container, "transcript.jsonl");
    await writeFile(transcript, `${JSON.stringify({
      type: "assistant",
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "收尾。\n\n经验：guard-check 运行期间不要并发编辑工作树" }] },
    })}\n`);
    const report = runCaptureHook({ hook_event_name: "Stop", transcript_path: transcript }, {
      containerRoot: fixture.container,
      now: () => instant(2),
    });
    assert.equal(report.written, 1, JSON.stringify(report));
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(3), allowTrailing: true });
    const card = listed.records.find((record) => record.subject.includes("guard-check"));
    assert.ok(card, `default recall must find the captured card: ${JSON.stringify(listed.records.map((r) => r.subject))}`);
    assert.equal(card.promotionState, "promoted", "written is retrievable; there is no candidate state");
    assert.equal(card.lifecycle, "active");
    assert.deepEqual(card.extensions, {}, "a first card has nothing to coexist with");
  } finally {
    await fixture.close();
  }
});

test("STORY-365 correction 1: the Codex Stop payload carries no transcript_path, only last_assistant_message inline", async () => {
  const fixture = await containerFixture("FIXTURE-CAPTURE-CODEX");
  try {
    const report = runCaptureHook({
      hook_event_name: "Stop",
      last_assistant_message: "收尾。\n\n经验：Codex 的 Stop payload 没有 transcript_path，经验要走 last_assistant_message",
    }, {
      containerRoot: fixture.container,
      now: () => instant(2),
    });
    assert.equal(report.written, 1, JSON.stringify(report));
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(3), allowTrailing: true });
    const card = listed.records.find((record) => record.subject.includes("Codex"));
    assert.ok(card, `default recall must find the captured card: ${JSON.stringify(listed.records.map((r) => r.subject))}`);
    assert.equal(card.promotionState, "promoted", "the Codex host path is retrievable exactly like the Claude Code path");
  } finally {
    await fixture.close();
  }
});

test("STORY-393 B2/U6: host argv wins and replayed Stop payloads do not write another boundary", async () => {
  assert.equal(hostFromArgv(["--host", "codex"], { host: "claude" }, {}), "codex");
  assert.equal(hostFromArgv([], {}, { TCRN_HOST: "codex" }), "codex");
  assert.equal(hostFromArgv([], {}, {}), "unknown-host");
  const fixture = await containerFixture("FIXTURE-CAPTURE-REPLAY");
  try {
    const input = { hook_event_name: "Stop", session_id: "capture-session", host: "codex" };
    const first = runCaptureHook(input, { containerRoot: fixture.container, now: () => instant(2) });
    assert.deepEqual(first.observationBoundary, {
      ok: false,
      reasonCode: "TELEMETRY_BOUNDARY_GAP_RESUMED",
      unknown: true,
      resumed: true,
      from: "2026-09-02",
      until: "2026-09-02",
      count: 4,
      duplicate: false,
      protocolVersion: "tcrn.injection-protocol.v2",
    }, JSON.stringify(first));
    const telemetryRoot = join(fixture.container, ".tcrn-workspace", "cross-project", "transient");
    const before = await readTelemetryRecords(telemetryRoot, { limit: Number.MAX_SAFE_INTEGER });
    assert.equal(before.records.filter((record) => record.payload.source.includes(":codex:")).length, 4);

    const snake = runCaptureHook({ ...input, stop_hook_active: true }, { containerRoot: fixture.container, now: () => instant(2, 1) });
    const camel = runCaptureHook({ ...input, stopHookActive: true }, { containerRoot: fixture.container, now: () => instant(2, 2) });
    assert.deepEqual(snake.observationBoundary, { ok: true, reasonCode: "TELEMETRY_BOUNDARY_SKIPPED_REPLAY", skipped: true });
    assert.deepEqual(camel.observationBoundary, { ok: true, reasonCode: "TELEMETRY_BOUNDARY_SKIPPED_REPLAY", skipped: true });
    const after = await readTelemetryRecords(telemetryRoot, { limit: Number.MAX_SAFE_INTEGER });
    assert.equal(after.records.length, before.records.length, "replayed Stop payloads do not add a second boundary");
  } finally {
    await fixture.close();
  }
});

test("STORY-365 GWT2/GWT3: the same subject twice is scored, refused, and released by supersedes", async () => {
  const fixture = await containerFixture("FIXTURE-CAPTURE-CONFLICT");
  try {
    const subject = "guard-check 运行期间不要并发编辑";
    const first = await captureKnowledgeUnit(fixture.workspace, lessonCard(subject), { allowTrailing: true });
    assert.equal(first.promotionState, "promoted");

    const refusal = await captureKnowledgeUnit(fixture.workspace, lessonCard(subject, { body: "第二次写入" }), { allowTrailing: true })
      .then(() => null, (error) => error);
    assert.equal(refusal?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "the same subject twice is a possible conflict");
    assert.deepEqual(refusal.details.conflicts, [first.id], "the refusal hands back the hit list, not just a verdict");

    const replacement = await captureKnowledgeUnit(
      fixture.workspace,
      lessonCard(subject, { body: "第二次写入", supersedes: first.id }),
      { allowTrailing: true },
    );
    assert.equal(replacement.superseded, first.id, "the receipt names what was replaced");
    const all = await listKnowledgeMetadata(fixture.workspace, { at: instant(3), selection: "all", allowTrailing: true });
    const replaced = all.records.find((record) => record.id === first.id);
    assert.equal(replaced.extensions.supersededBy, replacement.id, "the replaced card carries the mark");
    assert.equal(replaced.revision, 2, "and the mark is a revision of that record, not a note beside it");
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(3), allowTrailing: true });
    assert.deepEqual(listed.records.map((record) => record.id), [replacement.id], "default recall answers with one of them");
  } finally {
    await fixture.close();
  }
});

test("STORY-365 coexist admits the write and records what it stands beside", async () => {
  const fixture = await containerFixture("FIXTURE-CAPTURE-COEXIST");
  try {
    const subject = "策略 JSON 按键定位 不按行号";
    const first = await captureKnowledgeUnit(fixture.workspace, lessonCard(subject), { allowTrailing: true });
    const second = await captureKnowledgeUnit(
      fixture.workspace,
      lessonCard(subject, { body: "另一面", coexist: true }),
      { allowTrailing: true },
    );
    assert.deepEqual(second.conflicts, [first.id]);
    const all = await listKnowledgeMetadata(fixture.workspace, { at: instant(3), selection: "all", allowTrailing: true });
    assert.deepEqual(all.records.find((record) => record.id === second.id).extensions, { coexistsWith: [first.id] });
    assert.equal(all.records.length, 2, "coexisting cards both survive");
  } finally {
    await fixture.close();
  }
});

test("STORY-365 the threshold is two subject-token hits, not one shared word", () => {
  const metadata = {
    subject: "guard-check 运行期间不要并发编辑", summary: "", snippet: "", tags: [],
    id: "knowledge:000000000000000000000001", lifecycle: "active",
  };
  assert.equal(knowledgeRelevanceScore(metadata, metadata.subject), KNOWLEDGE_CONFLICT_SCORE_THRESHOLD);
  assert.deepEqual(knowledgeConflictHits([metadata], metadata.subject), [metadata.id]);
  assert.deepEqual(knowledgeConflictHits([metadata], "guard-check 另一件完全不同的事"), [],
    "one shared token scores 8 and stays under the line");
  assert.deepEqual(knowledgeConflictHits([{ ...metadata, lifecycle: "retired" }], metadata.subject), [],
    "a retired card is not a live conflict");
  assert.deepEqual(knowledgeConflictHits([metadata], metadata.subject, [metadata.id]), [],
    "an excluded id -- the record itself, or the one it supersedes -- is not its own conflict");
});

test("STORY-365 GWT4/GWT5: create needs no backlink lists, and nothing new lands as a candidate", async () => {
  const fixture = await containerFixture("FIXTURE-CAPTURE-CREATE");
  try {
    const created = await cliJson([
      "knowledge-create",
      "--workspace", fixture.workspace,
      "--expected-version", "0",
      "--at", instant(2),
      "--external-key", "S365-NO-LINK-LISTS",
      "--scope", "role",
      "--project-id", "-",
      "--role-scopes", "implementation",
      "--category", "workflow",
      "--kind", "fact",
      "--tags", "lesson",
      "--subject", "四个链接列表都不再必填",
      "--summary", "knowledge-create 不带 work/decision/gate/evidence 也能写",
      "--snippet", "四个列表可选",
      "--accountable-owner-id", OWNER,
      "--source-references", "-",
      "--lifecycle", "active",
      "--retrieval", "default",
      "--freshness", "fresh",
      "--last-verified", "-",
      "--stale-days", "-",
      "--export", "metadata-only",
      "--body", "四个链接列表都不再必填。",
    ]);
    assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    assert.equal(created.promotionState, "promoted", "a create with no backlinks is written official");

    await captureKnowledgeUnit(fixture.workspace, lessonCard("另一条完全不同的经验条目"), { allowTrailing: true });
    const candidates = await cliJson([
      "knowledge-list", "--workspace", fixture.workspace, "--at", instant(3),
      "--selection", "all", "--promotion", "candidate", "--allow-trailing", "true",
    ]);
    assert.equal(candidates.total, 0, "no write this Story admits produces a candidate");
  } finally {
    await fixture.close();
  }
});

test("STORY-365 the extension slot stays a closed roster of two knowledge-id keys", async () => {
  const fixture = await containerFixture("FIXTURE-CAPTURE-EXTENSIONS");
  try {
    const { readFile, writeFile: write } = await import("node:fs/promises");
    const first = await captureKnowledgeUnit(fixture.workspace, lessonCard("扩展槽是有界的两个键"), { allowTrailing: true });
    const path = join(fixture.workspace, ".tcrn-workflow", "knowledge", "metadata", `${first.id}.json`);
    const stored = JSON.parse(await readFile(path, "utf8"));
    for (const forged of [{ unknownKey: "x" }, { supersededBy: "not-an-id" }, { coexistsWith: [] }, { coexistsWith: ["knowledge:000000000000000000000002", "knowledge:000000000000000000000001"] }]) {
      await write(path, canonicalJson({ ...stored, extensions: forged }));
      const refusal = await listKnowledgeMetadata(fixture.workspace, { at: instant(3), allowTrailing: true })
        .then(() => null, (error) => error);
      assert.equal(refusal?.reasonCode, "KNOWLEDGE_RECORD_INVALID", `extensions ${JSON.stringify(forged)} must be refused`);
    }
    await write(path, canonicalJson(stored));
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(3), allowTrailing: true })).records.length, 1);
  } finally {
    await fixture.close();
  }
});

// TCRN-CROSS-INC-282 (Owner ruling TCRN-CROSS-MIN-158 D1) — the machine criterion the
// Incident asked for, stated as the writer states it: a card written with a source
// reference and no evidence id is in the default selection at once. STORY-365 reached both
// verbs (they share buildMetadata) but left the half-supplied provenance branch standing,
// and the branch it left was the one the Stop hook and every hand-written card take.
test("INC-282: a captured card naming a source is promoted and in default recall at once", async () => {
  const fixture = await containerFixture("FIXTURE-CAPTURE-SOURCED");
  try {
    const sourced = await captureKnowledgeUnit(fixture.workspace, lessonCard("带来源的经验卡", {
      sourceReferences: ["docs/tutorial/governed-loop.md"],
    }), { allowTrailing: true });
    assert.equal(sourced.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    assert.equal(sourced.promotionState, "promoted", "a source reference is not a reason to withhold a card");
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(3), allowTrailing: true });
    assert.equal(listed.records.some((record) => record.id === sourced.id), true,
      `default recall must return the sourced card: ${JSON.stringify(listed.records.map((record) => record.subject))}`);
    // The contrast that made the defect invisible: the same card without a source was
    // always returned, so the writer had no way to tell the two apart from the receipt.
    const bare = await captureKnowledgeUnit(fixture.workspace, lessonCard("无来源的经验卡"), { allowTrailing: true });
    assert.equal(bare.promotionState, sourced.promotionState, "both shapes land in the same state");
  } finally {
    await fixture.close();
  }
});
