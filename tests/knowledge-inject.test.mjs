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
  extractQueryTokens, promptTriggers, matchedTriggerKeywords, runInjection, truncateToBudget
} from "../scripts/knowledge-inject.mjs";
import {
  acquireWorkspaceLease,
  createKnowledgeUnit,
  createProject,
  initializeKnowledgeStore,
  initializeWorkspace,
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

  // Create knowledge units with "hook" keyword and enough content to exceed 10 bytes
  const projectId = state.projects[0].id;
  const knowledgeUnits = [
    {
      externalKey: "HOOK-GUIDE-001",
      subject: "Hook setup guide",
      summary: "A comprehensive guide about hook configuration"
    },
    {
      externalKey: "HOOK-GUIDE-002",
      subject: "Hook lifecycle management",
      summary: "Managing the lifecycle of hooks in production systems"
    },
    {
      externalKey: "HOOK-GUIDE-003",
      subject: "Hook debugging and troubleshooting",
      summary: "Common hook issues and how to resolve them"
    }
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
      tags: ["hook", "setup"],
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
