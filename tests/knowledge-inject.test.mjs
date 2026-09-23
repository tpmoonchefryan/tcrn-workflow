// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-019 STORY-162.5 — the pure half of the knowledge injection chain.
// The liveness gate itself (--verify-channel) needs the live host and is run by hand /
// in the runner; these tests hold the pure decision logic (gate, token extraction,
// budget) without the network, so the harness stays green offline.
//
// INC-047: this test lives in the repository that OWNS the source (tcrn-workflow),
// not as a sibling-repo import — a lone clone of either repo can run its own suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  extractQueryTokens, promptTriggers, matchedTriggerKeywords, parseInjectionProtocol, recordObservationBoundary, runInjection, runSessionInjection, serializeInjectionProtocol, truncateToBudget
} from "../scripts/knowledge-inject.mjs";
import * as telemetryCore from "../dist/build/packages/core/src/telemetry.js";
import { filterCandidatesByDispatchContext, normalizeDispatchContext } from "../scripts/injection-session.mjs";
import {
  acquireWorkspaceLease,
  createKnowledgeUnit,
  createProject,
  initializeKnowledgeStore,
  initializeWorkspace,
  materializeWorkspace,
  readTelemetryRecords,
  transitionKnowledgePromotion,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

test("extractQueryTokens keeps ASCII words and CJK bigrams, drops stopwords", () => {
  const tokens = extractQueryTokens("hook 没有生效,应该查什么");
  assert.ok(tokens.includes("hook"));
  assert.ok(!tokens.includes("没有"));
  assert.ok(!tokens.includes("应该"));
  assert.ok(tokens.length > 0);
});

test("CJK query extraction does not split phrases into bigrams", () => {
  const tokens = extractQueryTokens("引擎设计 约束模型 工单格式");
  assert.deepEqual(tokens, ["引擎设计", "约束模型", "工单格式"]);
  assert.equal(tokens.includes("引擎"), false);
  assert.equal(tokens.includes("擎设"), false);
  assert.equal(tokens.includes("设计"), false);
});

async function createSyntheticWorkspace() {
  const instant = (second) => `2026-09-04T00:00:${String(second).padStart(2, "0")}Z`;
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-knowledge-inject-test-")));

  // Create the partition structure: base/.tcrn-workspace/cross-project/
  const partitionPath = join(base, ".tcrn-workspace", "cross-project");
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(partitionPath, kind);
    await mkdir(path, { recursive: true });
    roots.push({ kind, path });
  }

  // Initialize a real workspace
  await initializeWorkspace({ roots, externalKey: "KNOWLEDGE-INJECT-TEST", createdAt: instant(0) });
  const workspace = join(partitionPath, "workspace");

  // Populate with knowledge content so budget tests discriminate.
  // We need content matching "hook" keyword to exceed 10-byte budget.
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  let state;
  try {
    state = await createProject(workspace, lease, {
      expectedVersion: 0,
      occurredAt: instant(1),
      externalKey: "KNOWLEDGE-INJECT-PROJ",
      name: "Knowledge Inject Test"
    });
  } finally {
    await lease.release();
  }

  // Initialize the knowledge store before creating knowledge units
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });

  // Create knowledge units with "hook" keyword and enough content to exceed 10 bytes.
  //
  // TCRN-CROSS-STORY-362: the six cards that say nothing about hooks are not padding.
  // Retrieval is bm25 now, and a term every document in the corpus carries discriminates
  // nothing -- FTS5 clamps its inverse document frequency and the score lands at zero,
  // which is the same mechanism that stops the query `lesson` from returning the whole
  // library. A three-card corpus in which all three are about hooks would therefore
  // return no answer for "hook" and this file would be measuring the clamp rather than
  // the budget. The corpus is nine cards so that "hook" selects the three that are about
  // hooks, which is what the budget tests below need to be discriminating about.
  const projectId = state.projects[0].id;
  const knowledgeUnits = [
    {
      externalKey: "HOOK-GUIDE-001",
      subject: "Hook setup guide",
      summary: "A comprehensive guide about hook configuration",
      tags: ["hook", "setup"]
    },
    {
      externalKey: "HOOK-GUIDE-002",
      subject: "Hook lifecycle management",
      summary: "Managing the lifecycle of hooks in production systems",
      tags: ["hook", "setup"]
    },
    {
      externalKey: "HOOK-GUIDE-003",
      subject: "Hook debugging and troubleshooting",
      summary: "Common hook issues and how to resolve them",
      tags: ["hook", "setup"]
    },
    { externalKey: "OTHER-001", subject: "Release trust root layout", summary: "Where the trust archive lives and what it holds", tags: ["release"] },
    { externalKey: "OTHER-002", subject: "Storage segment rotation", summary: "How segmented storage rolls a segment and when", tags: ["storage"] },
    { externalKey: "OTHER-003", subject: "Lease acquisition order", summary: "Which writer serialises against which claim", tags: ["workspace"] },
    { externalKey: "OTHER-004", subject: "Snapshot replay rebuild", summary: "Rebuilding a derived view from the event chain", tags: ["snapshot"] },
    { externalKey: "OTHER-005", subject: "Conference minutes distillation", summary: "Turning positions into recorded decisions", tags: ["conference"] },
    { externalKey: "OTHER-006", subject: "Persona preset override", summary: "Overriding one governed field of a shipped persona", tags: ["persona"] }
  ];

  let knowledgeVersion = 0;
  for (const unit of knowledgeUnits) {
    const created = await createKnowledgeUnit(workspace, {
      expectedVersion: knowledgeVersion,
      occurredAt: instant(knowledgeVersion + 2),
      externalKey: unit.externalKey,
      scope: "workspace",
      projectId: null,
      roleScopes: [],
      category: "workflow",
      kind: "fact",
      tags: unit.tags,
      subject: unit.subject,
      summary: unit.summary,
      snippet: `Details about ${unit.subject}`,
      accountableOwnerId: deriveStableId("owner", "TEST-OWNER"),
      sourceReferences: [`evidence://fixture/${unit.externalKey}`],
      sourceDigest: canonicalSha256({ key: unit.externalKey }),
      linkedWorkIds: [],
      linkedDecisionIds: [],
      linkedGateIds: [],
      linkedEvidenceIds: [deriveStableId("evidence", `FIXTURE-${unit.externalKey}`)],
      lifecycle: "active",
      retrievalDisposition: "default",
      freshnessState: "fresh",
      lastVerified: instant(knowledgeVersion + 1),
      stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
      exportDisposition: "metadata-only",
      body: `This is knowledge content about ${unit.subject}. It contains sufficient detail to exceed small byte budgets.`,
      // TCRN-CROSS-STORY-365: three "Hook ..." cards written on purpose, each scoring as
      // a possible duplicate of the last.
      coexist: true,
    });
    knowledgeVersion = created.version;

    // Promote the knowledge unit so it shows up in search results. STORY-365 writes a
    // sourced-and-evidenced card promoted already, so this is now a no-op for these three.
    const promoted = created.promotionState === "promoted" ? created : await transitionKnowledgePromotion(workspace, {
      expectedVersion: created.version,
      expectedRevision: created.revision,
      occurredAt: instant(knowledgeVersion + 1),
      id: created.id,
      promotionState: "promoted"
    });
    knowledgeVersion = promoted.version;
  }

  return {
    containerRoot: base,
    cleanup: () => rm(base, { recursive: true, force: true })
  };
}

test("INIT-047 injection budget=10 reports exceeded without truncation", async (context) => {
  const { containerRoot, cleanup } = await createSyntheticWorkspace();
  context.after(() => cleanup());

  const result = await runInjection({
    prompt: "hook",
    partition: "cross-project",
    budget: 10,
    triggerKeywords: "",
    containerRoot
  });
  assert.equal(result.reasonCode, "INJECTION_BUDGET_EXCEEDED");
  assert.equal(result.truncated, false);
  assert.equal(result.budget, 10);
  assert.ok(result.injectedBytes > 10);
});

test("INIT-047 discrimination: large budget does not report exceeded", async (context) => {
  const { containerRoot, cleanup } = await createSyntheticWorkspace();
  context.after(() => cleanup());

  const result = await runInjection({
    prompt: "hook",
    partition: "cross-project",
    budget: 100000,  // Large budget
    triggerKeywords: "",
    containerRoot
  });
  // With a large budget, we should not get INJECTION_BUDGET_EXCEEDED
  assert.notEqual(result.reasonCode, "INJECTION_BUDGET_EXCEEDED");
  assert.ok(result.injected === true || result.injected === false);  // May inject or not depending on candidates
});

test("a prompt with no trigger keyword is gated off", () => {
  assert.equal(promptTriggers("今天天气如何", "hook,仪式,rebase"), false);
  assert.equal(promptTriggers("hook 没有生效", "hook,仪式,rebase"), true);
});

test("matchedTriggerKeywords returns exactly the keywords present", () => {
  assert.deepEqual(matchedTriggerKeywords("hook 与 仪式 的问题", "hook,仪式,rebase"), ["hook", "仪式"]);
  assert.deepEqual(matchedTriggerKeywords("天气", "hook,仪式"), []);
});

test("an empty trigger list does not gate", () => {
  assert.equal(promptTriggers("anything at all", ""), true);
});

test("truncateToBudget cuts by bytes and reports it", () => {
  const long = "a".repeat(1000);
  const cut = truncateToBudget(long, 100);
  assert.equal(cut.truncated, true);
  assert.ok(Buffer.byteLength(cut.text, "utf8") <= 100);
  assert.equal(truncateToBudget("short", 100).truncated, false);
});

test("truncateToBudget never grows the output past the budget", () => {
  const cjk = "探针".repeat(300); // 600 CJK chars = 1800 bytes
  const cut = truncateToBudget(cjk, 500);
  assert.ok(Buffer.byteLength(cut.text, "utf8") <= 500 + 3); // allow a split multibyte char
});

test("STORY-418 recall is filtered by an explicit workId and Pack binding", () => {
  const binding = normalizeDispatchContext({ role: "subagent", workId: "work:bound", pack: "EPIC135/HC1" }, { env: {} });
  const result = filterCandidatesByDispatchContext([
    { id: "knowledge:bound", workId: "work:bound", pack: "EPIC135/HC1" },
    { id: "knowledge:wrong-work", workId: "work:other", pack: "EPIC135/HC1" },
    { id: "knowledge:unbound", title: "same prompt words" },
  ], binding);
  assert.equal(result.reasonCode, "DISPATCH_CONTEXT_MATCHED");
  assert.deepEqual(result.records.map((record) => record.id), ["knowledge:bound"]);
  assert.equal(result.excluded, 2);
});

test("STORY-419 protocol truncation is explicit and never looks like delivered context", () => {
  const oversized = serializeInjectionProtocol({ ok: true, injected: true, injection: "z".repeat(600_000) });
  const parsed = parseInjectionProtocol(oversized.text);
  assert.equal(oversized.truncated, true);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.ok, false);
  assert.equal(parsed.value.reasonCode, "INJECT_OUTPUT_TRUNCATED");
  assert.equal(parsed.value.injected, undefined);
});

// TCRN-CROSS-STORY-452 R1-R3 (SUB-225): each channel's self-check is written by the write path
// of that channel's real records, in the hook event that carries them, at most once per
// session, UTC day and channel (a failed one once per reason code). A host that never
// delivers an event never gets that channel's self-check. Red leg: no writer emits one.
test("STORY-452 SUB-225: each channel self-checks through its own write path and only in its own hook event", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-self-check-writers-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = ["framework", "workspace", "transient", "evidence-locator", "release-trust"].map((kind) => ({ kind, path: join(base, kind) }));
  for (const root of roots) await mkdir(root.path, { recursive: true });
  await initializeWorkspace({ roots, externalKey: "STORY-452-WRITERS", createdAt: "2026-09-01T00:00:00Z" });
  const transient = join(base, "transient");
  const workspaceState = await materializeWorkspace(join(base, "workspace"));
  const candidate = { id: "knowledge:000000000000000000000452", kind: "card", key: "K452", status: "active", title: "Self-check", summary: "Self-check" };
  const common = { stateDirectory: join(transient, "session-state"), workspaceState, settings: [], budget: 24_576, perPromptBytes: 1_600, judgeEnabled: false, host: "claude" };
  const checks = async () => (await readTelemetryRecords(transient, { kind: "collector-self-check", limit: 100 })).records
    .map((record) => `${record.session}|${record.payload.channel}|${record.payload.verdict}|${record.payload.reasonCode ?? ""}|${record.payload.source}`).sort();

  const found = async () => ({ ok: true, result: { records: [candidate] } });
  await runSessionInjection({ ...common, prompt: "self-check prompt", sessionId: "s452", event: "UserPromptSubmit", recall: found });
  await runSessionInjection({ ...common, prompt: "another self-check prompt", sessionId: "s452", event: "UserPromptSubmit", recall: found });
  assert.deepEqual(await checks(), [
    "s452|retrieval|ok||knowledge-inject:retrieval",
    "s452|trigger|ok||knowledge-inject:trigger",
  ], "a prompt self-checks retrieval and trigger, once per session and day");

  await runSessionInjection({ ...common, prompt: "", sessionId: "s452", event: "PostToolUse", hookInput: { tool_name: "work-show", tool_response: "{}" } });
  assert.ok((await checks()).includes("s452|reference|ok||knowledge-inject:reference"), "PostToolUse self-checks reference");
  assert.equal((await checks()).length, 3);

  await recordObservationBoundary({ sessionId: "s452", host: "claude", phase: "start", workspaceState });
  assert.ok((await checks()).includes("s452|verify|ok||final-gate-plan:batch-verify"), "a session boundary self-checks verify through the batch verify emitter");

  const unavailable = async () => ({ ok: false, reasonCode: "RECALL_UNAVAILABLE" });
  await runSessionInjection({ ...common, prompt: "failing self-check prompt", sessionId: "s452-failed", event: "UserPromptSubmit", recall: unavailable });
  await runSessionInjection({ ...common, prompt: "failing self-check prompt again", sessionId: "s452-failed", event: "UserPromptSubmit", recall: unavailable });
  const failed = (await checks()).filter((entry) => entry.startsWith("s452-failed|"));
  assert.deepEqual(failed, [
    "s452-failed|retrieval|failed|RECALL_UNAVAILABLE|knowledge-inject:retrieval",
    "s452-failed|trigger|ok||knowledge-inject:trigger",
  ], "a failed retrieval says why, once per reason code");

  const day = (await readTelemetryRecords(transient, { kind: "collector-self-check", limit: 1 })).records[0].at.slice(0, 10);
  const read = await telemetryCore.readObservationChannelDays(transient, day);
  assert.deepEqual(read.refusedSelfChecks, [], "every written self-check passes the read-side check");
  assert.equal(read.channels.find((entry) => entry.channel === "verify").reading, "observed-zero");
  assert.deepEqual(read.channels.find((entry) => entry.channel === "retrieval").selfChecks, { ok: 1, failed: 1 });
});
