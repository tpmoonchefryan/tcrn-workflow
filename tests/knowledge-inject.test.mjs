// TCRN-CROSS-INIT-019 STORY-162.5 — the pure half of the knowledge injection chain.
// The liveness gate itself (--verify-channel) needs the live host and is run by hand /
// in the runner; these tests hold the pure decision logic (gate, token extraction,
// budget) without the network, so the harness stays green offline.
//
// INC-047: this test lives in the repository that OWNS the source (tcrn-workflow),
// not as a sibling-repo import — a lone clone of either repo can run its own suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractQueryTokens, promptTriggers, matchedTriggerKeywords, truncateToBudget
} from "../scripts/knowledge-inject.mjs";

test("extractQueryTokens keeps ASCII words and CJK bigrams, drops stopwords", () => {
  const tokens = extractQueryTokens("hook 没有生效,应该查什么");
  assert.ok(tokens.includes("hook"));
  assert.ok(!tokens.includes("没有"));
  assert.ok(!tokens.includes("应该"));
  assert.ok(tokens.length > 0);
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
