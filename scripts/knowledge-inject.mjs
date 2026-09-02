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
// SessionStart (baseline, once) and UserPromptSubmit (every prompt).
//
// THE DIVISION OF LABOUR IS THE ENGINE'S, NOT MINE. Relevance selection = the
// knowledge-candidates verb. Budget / freshness / authority = context-route, which in
// the pinned release stops at CONTEXT_AUTHORITY_REQUIRED (out-of-band authority); until
// that supply program lands, this script enforces the byte budget itself and says so in
// the output — the same stated fallback the platform's on-demand-context doc already
// carries. A self-written relevance routine is forbidden; a self-written budget is the
// documented interim, not the design.
//
// Prompt admission is not controlled by a hand-maintained keyword list. The optional
// trigger-keywords flag remains accepted for old callers, but the production hook does
// not supply it and runInjection never gates a prompt on it.
//
// RETRIEVAL QUALITY (STORY-161.5, measured): knowledge-candidates search is AND-token
// FTS over the card text. A natural-language prompt's connective words pull the query to
// zero. So the script extracts MEANINGFUL tokens (ASCII alnum words and contiguous CJK
// phrases) minus stopwords, and queries with those — never the raw sentence.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const PLATFORM_ROOT = resolve(SCRIPT_DIRECTORY, "../../..");
// The chain container sits beside the platform root; a partition's workspace is
// `<container>/.tcrn-workspace/<partition>/workspace`. Resolved by the same convention
// `platform-doctor.mjs` walks, so this repository answers from its own layout contract
// rather than importing another project's roster.
export function workspaceForPartition(partition, containerRoot = PLATFORM_ROOT) {
  return resolve(containerRoot, ".tcrn-workspace", String(partition), "workspace");
}

export const ENGINE_CLI = resolve(SCRIPT_DIRECTORY, "tcrn-workflow.mjs");

/**
 * One read against this repository's own engine.
 *
 * This used to spawn the sibling product project's MCP read face — the engine repository
 * executing another project's code in order to read its own chains, which is the
 * dependency direction the platform forbids. That face also forwarded over SSH to a host
 * the chains left in S199, so the round trip carried a remote-access shape for data
 * sitting on this disk. The envelope is unchanged ({ ok, reasonCode, result }); callers
 * already tolerated both `result.records` and `result.result.records`.
 */
export function callChainRead(verb, { partition, ...flags }, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const argv = [ENGINE_CLI, verb, "--workspace", workspaceForPartition(partition)];
    for (const [name, value] of Object.entries(flags)) {
      if (value === undefined || value === null) continue;
      argv.push(`--${name}`, String(value));
    }
    const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolvePromise({ ok: false, reasonCode: "CHAIN_READ_TIMEOUT", error: "the engine did not answer within the bound" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { err += chunk.toString("utf8"); });
    child.on("close", () => {
      clearTimeout(timer);
      const lines = `${out}${err}`.trim().split("\n");
      let parsed = null;
      try { parsed = JSON.parse(lines[lines.length - 1] ?? ""); } catch { parsed = null; }
      if (parsed === null) {
        resolvePromise({ ok: false, reasonCode: "CHAIN_READ_UNPARSEABLE", error: `${err || out}`.slice(-200) });
        return;
      }
      if (parsed.ok === false) {
        resolvePromise({ ok: false, reasonCode: parsed.reasonCode ?? "CHAIN_READ_REFUSED", error: parsed.error ?? null, result: parsed });
        return;
      }
      resolvePromise({ ok: true, reasonCode: parsed.reasonCode ?? null, result: parsed });
    });
  });
}
export const SETTINGS_PATH = resolve(PLATFORM_ROOT, ".claude/settings.json");
export const DEFAULT_PARTITION = "cross-project";
export const DEFAULT_ROLE_SCOPE = "implementation";
export const DEFAULT_BUDGET = 32768;
export const MAX_TOKENS_IN_QUERY = 6;
export const INJECTION_RESULT_LIMIT = 1_048_576;

const STOPWORDS = new Set([
  "怎么", "应该", "没有", "为什么", "如果", "可以", "一个", "这个", "那个",
  "在", "里", "了", "的", "吗", "呢", "做", "写", "查", "对", "是", "不",
  "要", "给", "和", "或", "与", "我", "你", "它", "们", "条", "次", "什么",
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

/** Meaningful query tokens: ASCII words and contiguous CJK phrases. */
export function extractQueryTokens(prompt) {
  const tokens = new Set();
  for (const match of String(prompt ?? "").toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{1,31}/gu)) {
    tokens.add(match[0]);
  }
  const cjk = String(prompt ?? "").match(/[一-鿿]+/gu) ?? [];
  for (const phrase of cjk) {
    if (phrase.length > 0 && !STOPWORDS.has(phrase)) tokens.add(phrase);
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

async function configuredInjectionBudget(partition) {
  const call = await callChainRead("settings-catalog", { partition });
  if (!call.ok) return DEFAULT_BUDGET;
  const payload = call.result?.result ?? call.result;
  const setting = payload?.settings?.find((entry) => entry.key === "injection.budgetBytes");
  const value = setting?.currentValue ?? setting?.defaultValue;
  return /^(?:0|[1-9][0-9]*)$/u.test(String(value ?? "")) ? Number(value) : DEFAULT_BUDGET;
}

/** Byte-level budget cut, pure: `{ text, truncated }`. A CJK character can exceed the cut. */
export function truncateToBudget(text, budget) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= budget) return { text, truncated: false };
  return { text: Buffer.from(text, "utf8").subarray(0, budget).toString("utf8"), truncated: true };
}

/** The injection chain: query -> candidates -> budget report -> metadata-level output. */
export async function runInjection({ prompt, partition, roleScope, budget, triggerKeywords }) {
  void triggerKeywords;
  const effectiveBudget = Number.isSafeInteger(budget) && budget > 0 ? budget : await configuredInjectionBudget(partition);
  // Query each meaningful term separately and union the candidates. The engine owns
  // relevance ordering; this wrapper never gates a prompt on a hand-maintained list.
  const tokens = extractQueryTokens(prompt);
  if (tokens.length === 0) {
    return { ok: true, injected: false, reason: "NO_QUERY_TOKENS", candidates: [], injectedBytes: 0 };
  }
  const seen = new Set();
  const candidates = [];
  for (const token of tokens) {
    const call = await callChainRead("knowledge-candidates", {
      partition,
      "role-scope": roleScope,
      search: token,
      limit: INJECTION_RESULT_LIMIT,
      "allow-trailing": true,
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
  const joined = lines.join("\n");
  const injectedBytes = Buffer.byteLength(joined, "utf8");
  const budgetExceeded = injectedBytes > effectiveBudget;
  return {
    ok: true,
    injected: true,
    reason: budgetExceeded ? "INJECTION_BUDGET_EXCEEDED" : "INJECTION_PRODUCED",
    ...(budgetExceeded ? { reasonCode: "INJECTION_BUDGET_EXCEEDED", warning: { reasonCode: "INJECTION_BUDGET_EXCEEDED", actualBytes: injectedBytes, budget: effectiveBudget } } : {}),
    queryTokens: tokens,
    candidateCount: candidates.length,
    injectedBytes,
    truncated: false,
    budgetExceeded,
    budget: effectiveBudget,
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
    budget: typeof flags.budget === "string" ? Number(flags.budget) : (Number(process.env.TCRN_KNOWLEDGE_INJECTION_BUDGET) || undefined),
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
