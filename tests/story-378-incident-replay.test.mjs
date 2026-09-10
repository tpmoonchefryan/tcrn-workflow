// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-378 — incident replay corpus and extraction templates.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireWorkspaceLease,
  captureKnowledgeUnit,
  createProject,
  initializeKnowledgeStore,
  initializeWorkspace,
  listKnowledgeMetadata,
} from "../dist/build/packages/core/src/index.js";
import {
  buildIncidentReplay,
  captureIncidentDecisionCard,
  incidentDecisionCard,
  incidentRuleDraft,
  runIncidentReplayCli,
} from "../scripts/incident-replay.mjs";

const MINUTE_ID = "minutes:0123456789abcdef01234567";
const WORK_ID = "work:0123456789abcdef01234567";
const AT = "2026-09-10T12:00:00.000Z";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function knowledgeFixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s378-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = ["framework", "workspace", "transient", "evidence-locator", "release-trust"]
    .map((kind) => ({ kind, path: join(base, kind) }));
  for (const root of roots) await mkdir(root.path);
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "FIXTURE-STORY-378", createdAt: "2026-01-01T00:00:00Z" });
  const lease = await acquireWorkspaceLease(workspace, { now: "2026-01-01T00:00:01Z" });
  try {
    await createProject(workspace, lease, {
      expectedVersion: 0,
      occurredAt: "2026-01-01T00:00:01Z",
      externalKey: "FIXTURE-STORY-378-PROJECT",
      name: "Story 378 fixture",
    });
  } finally {
    await lease.release();
  }
  await initializeKnowledgeStore(workspace);
  return workspace;
}

function customSource() {
  return {
    id: WORK_ID,
    externalKey: "TCRN-CROSS-INC-378",
    kind: "Incident",
    status: "done",
    summary: "incident summary with a durable observed failure",
    decidedBy: [MINUTE_ID],
    linkedCardIds: ["knowledge:0123456789abcdef01234567"],
    scope: "ignored scope because summary is explicit",
  };
}

test("STORY-378 GWT1: the frozen 55-work corpus yields source-digested replay pairs", async () => {
  const work = await readJson("tests/fixtures/retrieval-eval/work-compact.json");
  const cards = await readJson("tests/fixtures/retrieval-eval/corpus-snapshot.json");
  const minutes = await readJson("tests/fixtures/retrieval-eval/minutes-compact.json");
  const replay = buildIncidentReplay({ workRecords: work.records, cards: cards.records, minutes: minutes.records, at: AT });
  assert.equal(replay.counts.input, 55);
  assert.equal(replay.counts.included, 55);
  assert.equal(replay.counts.skippedNoSummary, 0);
  assert.ok(replay.pairs.length >= 20);
  for (const pair of replay.pairs) {
    assert.match(pair.sourceDigest, /^[a-f0-9]{64}$/u);
    assert.ok(pair.prompt.length > 0);
    assert.ok(pair.expectedIds.length > 0);
  }
});

test("STORY-378: absent summaries are counted and unknown card links cannot label a pair", () => {
  const missing = { id: "work:abcdefabcdefabcdefabcdef", externalKey: "TCRN-CROSS-INC-MISSING", kind: "Incident", scope: "" };
  const source = { ...customSource(), linkedCardIds: ["knowledge:ffffffffffffffffffffffff"] };
  const replay = buildIncidentReplay({ workRecords: [missing, source], cards: [], minutes: [] });
  assert.equal(replay.counts.skippedNoSummary, 1);
  assert.equal(replay.counts.included, 1);
  assert.deepEqual(replay.pairs[0].expectedIds, [WORK_ID]);
  assert.deepEqual(replay.pairs[0].source.linkedCardIds, []);
});

test("STORY-378 GWT2: extraction produces an unapplied rule draft and a directly capturable decision card", async (t) => {
  const work = customSource();
  const minute = { id: MINUTE_ID, summary: "Owner decided to retain the bounded check", decisions: ["retain-bounded-check"] };
  const replay = buildIncidentReplay({ workRecords: [work], cards: [{ id: "knowledge:0123456789abcdef01234567" }], minutes: [minute], at: AT });
  const pair = replay.pairs[0];
  const draft = incidentRuleDraft({ work, pair, at: AT });
  assert.equal(draft.status, "unapplied");
  assert.equal(draft.sourceDigest, pair.sourceDigest);
  assert.match(draft.content, /Status: unapplied/u);
  assert.doesNotMatch(draft.content, /\/workspace\/|\/home\//u);
  const card = incidentDecisionCard({ work, minute, ownerId: "owner:story-378", at: AT });
  assert.equal(card.kind, "decision");
  assert.equal(card.category, "decision");
  assert.deepEqual(card.sourceReferences, [MINUTE_ID]);
  assert.deepEqual(card.linkedEvidenceIds, ["evidence:0123456789abcdef01234567"]);

  const workspace = await knowledgeFixture(t);
  const first = await captureIncidentDecisionCard(workspace, { ...card, occurredAt: AT });
  assert.equal(first.status, "created");
  const second = await captureIncidentDecisionCard(workspace, { ...card, occurredAt: AT });
  assert.equal(second.status, "already-exists");
  const listed = await listKnowledgeMetadata(workspace, { at: AT, selection: "all" });
  assert.equal(listed.records.length, 1);
  assert.equal(listed.records[0].lifecycle, "active");
  assert.equal(listed.records[0].kind, "decision");
});

test("STORY-378: the CLI writes only the rule draft file and reports the formal card plan", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s378-cli-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workPath = join(base, "work.json");
  const minutesPath = join(base, "minutes.json");
  const cardsPath = join(base, "cards.json");
  const draftPath = join(base, "proposed-rule.md");
  await writeFile(workPath, JSON.stringify({ records: [customSource()] }));
  await writeFile(minutesPath, JSON.stringify({ records: [{ id: MINUTE_ID, summary: "Decision summary", decisions: ["decision-1"] }] }));
  await writeFile(cardsPath, JSON.stringify({ records: [] }));
  const result = await runIncidentReplayCli([
    "--work-file", workPath,
    "--minutes-file", minutesPath,
    "--cards-file", cardsPath,
    "--extract-work-key", "TCRN-CROSS-INC-378",
    "--draft-out", draftPath,
    "--at", AT,
  ]);
  assert.equal(result.schemaVersion, "tcrn.incident-extraction.v1");
  assert.equal(result.capture, null);
  assert.equal((await readFile(draftPath, "utf8")), result.ruleDraft.content);
  assert.equal(result.decisionCard.kind, "decision");
});
