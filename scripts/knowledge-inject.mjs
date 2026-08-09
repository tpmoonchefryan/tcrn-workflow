#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-019 STORY-162 — the knowledge injection chain.
//
//   node tcrn-workflow/scripts/knowledge-inject.mjs --prompt "<p>" [--partition X]
//       [--role-scope Y] [--budget N] [--trigger-keywords "a,b,c"] [--self-test] [--verify-channel]
//
// WHAT THIS IS. D2's "webhook/hook 提醒 agent 按 prompt 检索并注入" on Claude Code is a
// hook. This script is the retrieval half: given a prompt it runs the platform's OWN
// relevance machine (knowledge-candidates via the MCP read face — never a second
// relevance routine written here), applies a HARD byte budget, and emits a
// metadata-level injection (never full bodies). The hook side registers it on
// SessionStart (baseline, once) and UserPromptSubmit (keyword-gated).
//
// THE DIVISION OF LABOUR IS THE ENGINE'S, NOT MINE. Relevance selection = the
// knowledge-candidates verb. Budget / freshness / authority = context-route, which in
// the pinned release stops at CONTEXT_AUTHORITY_REQUIRED (out-of-band authority); until
// that supply program lands, this script enforces the byte budget itself and says so in
// the output — the same stated fallback the platform's on-demand-context doc already
// carries. A self-written relevance routine is forbidden; a self-written budget is the
// documented interim, not the design.
//
// KEYWORD GATE (STORY-162.1): UserPromptSubmit must not fire a candidate query on every
// turn (context budget is a hard constraint). `--trigger-keywords` is a local, cheap
// gate: if the prompt contains none of them, the script emits an empty injection and
// exits 0 without touching the read face. SessionStart passes a fixed baseline keyword
// set and no prompt.
//
// RETRIEVAL QUALITY (STORY-161.5, measured): knowledge-candidates search is AND-token
// FTS over the card text. A natural-language prompt's connective words pull the query to
// zero. So the script extracts MEANINGFUL tokens (ASCII alnum words, CJK bigrams) minus
// stopwords, and queries with those — never the raw sentence.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const READ_FACE_SERVER = resolve(PLATFORM_ROOT, "TCRN-AOS/deploy/aos-local-client/remote-read-mcp.mjs");
export const SETTINGS_PATH = resolve(PLATFORM_ROOT, ".claude/settings.json");
export const DEFAULT_PARTITION = "cross-project";
export const DEFAULT_ROLE_SCOPE = "implementation";
export const DEFAULT_BUDGET = 8000;
export const MAX_TOKENS_IN_QUERY = 6;

// Connectors / function words that carry no retrieval signal. Chinese bigrams are kept;
// these single tokens are dropped. Deliberately small — the FTS is the relevance judge,
// this list only trims noise, and a token wrongly dropped is a miss, never a wrong hit.
const STOPWORDS = new Set([
  "怎么", "应该", "没有", "为什么", "如果", "可以", "一个", "这个", "那个",
  "在", "里", "了", "的", "吗", "呢", "做", "写", "查", "对", "是", "不",
  "要", "给", "和", "或", "与", "我", "你", "它", "们", "条", "次", "吗"
]);

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; i += 1; }
  }
  return flags;
}

/** Meaningful query tokens: ASCII alnum words (>=2) + CJK bigrams, minus stopwords. */
export function extractQueryTokens(prompt) {
  const tokens = new Set();
  for (const match of String(prompt ?? "").toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{1,31}/gu)) {
    tokens.add(match[0]);
  }
  const cjk = String(prompt ?? "").match(/[一-鿿]+/gu) ?? [];
  for (const phrase of cjk) {
    if (phrase.length === 2 && !STOPWORDS.has(phrase)) tokens.add(phrase);
    for (let i = 0; i + 1 < phrase.length; i += 1) {
      const bigram = phrase.slice(i, i + 2);
      if (!STOPWORDS.has(bigram)) tokens.add(bigram);
    }
  }
  return [...tokens].slice(0, MAX_TOKENS_IN_QUERY);
}

/** Does the prompt contain any trigger keyword? The cheap gate before any network. */
export function promptTriggers(prompt, triggerKeywords) {
  const list = (triggerKeywords ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  const text = String(prompt ?? "");
  return list.some((kw) => text.includes(kw) || text.toLowerCase().includes(kw.toLowerCase()));
}

/** The trigger keywords actually present in the prompt — the clean query terms. */
export function matchedTriggerKeywords(prompt, triggerKeywords) {
  const list = (triggerKeywords ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return [];
  const text = String(prompt ?? "");
  return list.filter((kw) => text.includes(kw) || text.toLowerCase().includes(kw.toLowerCase()));
}

/** One JSON-RPC round-trip against the MCP read face server. */
export function callReadFace(tool, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [READ_FACE_SERVER], { stdio: ["pipe", "pipe", "inherit"] });
    let buffered = "";
    const frames = [];
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolvePromise({ ok: false, reasonCode: "READ_FACE_TIMEOUT", error: "read face did not answer within the bound" }); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      while (buffered.includes("\n")) {
        const newline = buffered.indexOf("\n");
        frames.push(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (frames.some((f) => f.includes(`"id":${frames.length}`))) { /* frame arriving */ }
      }
    });
    const next = () => new Promise((r) => {
      const poll = () => {
        if (frames.length > 0) return r(frames.shift());
        setTimeout(poll, 20);
      };
      poll();
    });
    const send = (v) => child.stdin.write(`${JSON.stringify(v)}\n`);
    (async () => {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "knowledge-inject", version: "0.1.0" } } });
      await next();
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
      const frame = await next();
      clearTimeout(timer);
      child.kill("SIGTERM");
      let parsed = null;
      try { parsed = JSON.parse(frame); } catch { parsed = null; }
      const result = parsed?.result;
      if (result === undefined || result.isError === true) {
        const sc = result?.structuredContent ?? null;
        resolvePromise({ ok: false, reasonCode: sc?.reasonCode ?? "READ_FACE_REFUSED", error: sc?.error ?? "no structured result", result: sc });
        return;
      }
      resolvePromise({ ok: true, reasonCode: "READ_FACE_OK", result: result.structuredContent ?? result });
    })().catch((error) => {
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolvePromise({ ok: false, reasonCode: "READ_FACE_INTERNAL", error: String(error?.message ?? error) });
    });
  });
}

/** Byte-level budget cut, pure: `{ text, truncated }`. A CJK character can exceed the cut. */
export function truncateToBudget(text, budget) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= budget) return { text, truncated: false };
  return { text: Buffer.from(text, "utf8").subarray(0, budget).toString("utf8"), truncated: true };
}

/** The injection chain: gate -> candidates -> budget -> metadata-level output. */
export async function runInjection({ prompt, partition, roleScope, budget, triggerKeywords }) {
  if (!promptTriggers(prompt, triggerKeywords)) {
    return { ok: true, injected: false, reason: "TRIGGER_GATE_NO_MATCH", candidates: [], injectedBytes: 0 };
  }
  const matched = matchedTriggerKeywords(prompt, triggerKeywords);
  // Query with the matched trigger keywords (clean, curated terms) when available; else
  // fall back to the first few extracted tokens. Never the raw sentence — the AND-token
  // FTS rejects connective words (measured in STORY-161.5). Multi-word: query each term
  // SEPARATELY and union the candidate ids (OR semantics), because a multi-term AND
  // query pulls to zero whenever any term is absent from a card (measured in the QA
  // review: "判据+CAS+marker" → 0, single "CAS" → 1).
  const tokens = matched.length > 0 ? matched : extractQueryTokens(prompt).slice(0, 3);
  if (tokens.length === 0) {
    return { ok: true, injected: false, reason: "NO_QUERY_TOKENS", candidates: [], injectedBytes: 0 };
  }
  const seen = new Set();
  const candidates = [];
  for (const token of tokens) {
    const call = await callReadFace("tcrn_remote_read_knowledge_candidates", {
      partition,
      "role-scope": roleScope,
      search: token,
      at: new Date().toISOString().replace(/\.\d+Z$/u, "Z")
    });
    if (!call.ok) {
      return { ok: false, reasonCode: call.reasonCode, error: call.error, injected: false, candidates: [], injectedBytes: 0 };
    }
    const batch = call.result?.result?.candidates ?? call.result?.candidates ?? [];
    for (const candidate of batch) {
      if (!seen.has(candidate.id)) { seen.add(candidate.id); candidates.push(candidate); }
    }
  }
  const lines = [];
  for (const candidate of candidates) {
    const line = `· [${candidate.id}] ${candidate.title ?? candidate.subject ?? ""} — ${candidate.summary ?? ""}`;
    lines.push(line);
  }
  const { text: joined, truncated } = truncateToBudget(lines.join("\n"), budget);
  return {
    ok: true,
    injected: true,
    reason: "INJECTION_PRODUCED",
    queryTokens: tokens,
    candidateCount: candidates.length,
    injectedBytes: Buffer.byteLength(joined, "utf8"),
    truncated,
    budget,
    injection: joined.length === 0 ? null : joined
  };
}

/** STORY-162.5: execute the REGISTERED hook command string itself, not a stand-in. */
export function registeredHookCommands() {
  if (!existsSync(SETTINGS_PATH)) return [];
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")); } catch { return []; }
  const out = [];
  for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const entry of group.hooks ?? []) {
        if (typeof entry.command === "string" && entry.command.includes("knowledge-inject")) {
          out.push({ event, command: entry.command });
        }
      }
    }
  }
  return out;
}

function parseArgv(argv) {
  const flags = parseFlags(argv);
  return {
    prompt: typeof flags.prompt === "string" ? flags.prompt : "",
    partition: typeof flags.partition === "string" ? flags.partition : DEFAULT_PARTITION,
    roleScope: typeof flags["role-scope"] === "string" ? flags["role-scope"] : DEFAULT_ROLE_SCOPE,
    budget: typeof flags.budget === "string" ? Number(flags.budget) : DEFAULT_BUDGET,
    triggerKeywords: typeof flags["trigger-keywords"] === "string" ? flags["trigger-keywords"] : "",
    selfTest: flags["self-test"] === true,
    verifyChannel: flags["verify-channel"] === true
  };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const options = parseArgv(process.argv.slice(2));
  const out = (value) => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
  if (options.verifyChannel) {
    // Red surfaces: registration missing / command cannot start / chain returns nothing.
    const registered = registeredHookCommands();
    if (registered.length === 0) { out({ ok: false, reasonCode: "REGISTRATION_MISSING", detail: "no knowledge-inject hook is registered in the platform .claude/settings.json" }); process.exitCode = 1; }
    else {
      const start = await runInjection({ prompt: "hook", partition: options.partition, roleScope: options.roleScope, budget: options.budget, triggerKeywords: "" });
      if (start.ok !== true) { out(start); process.exitCode = 1; }
      else if (start.injected !== true || start.candidateCount === 0) { out({ ok: false, reasonCode: "RETRIEVAL_CHAIN_NO_RETURN", detail: "the chain produced no candidates for a known keyword", observed: start }); process.exitCode = 1; }
      else out({ ok: true, reasonCode: "INJECTION_CHANNEL_LIVE", registered: registered.length, ...start });
    }
    process.exitCode = process.exitCode ?? 0;
  } else if (options.selfTest) {
    // self-test must NOT be green on zero retrieval (恒绿门, INC-044): a retrieval
    // chain that produces no candidates for a known curated term is a broken chain.
    // Predicate aligned with verify-channel.
    const result = await runInjection({ prompt: "hook 没有生效", partition: options.partition, roleScope: options.roleScope, budget: options.budget, triggerKeywords: "" });
    out(result);
    if (result.ok !== true || result.injected !== true || result.candidateCount === 0) process.exitCode = 1;
  } else {
    out(await runInjection(options));
  }
}
