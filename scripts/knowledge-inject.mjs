#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-019 STORY-162 — the knowledge injection chain.
//
//   node tcrn-workflow/scripts/knowledge-inject.mjs --prompt "<p>" [--partition X]
//       [--limit N] [--budget N] [--trigger-keywords "a,b,c"] [--self-test] [--verify-channel]
//
// WHAT THIS IS. D2's "webhook/hook 提醒 agent 按 prompt 检索并注入" on Claude Code is a
// hook. This script is the retrieval half: given a prompt it runs the platform's OWN
// relevance machine (the `recall` verb — never a second relevance routine written
// here), applies a HARD byte budget, and emits a metadata-level injection (never full
// bodies). The hook side registers it on SessionStart (baseline, once) and
// UserPromptSubmit (every prompt).
//
// THE DIVISION OF LABOUR IS THE ENGINE'S, NOT MINE. Relevance selection = the
// recall verb. Budget / freshness / authority = context-route, which in
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
// RETRIEVAL QUALITY (TCRN-CROSS-STORY-362, measured). This used to issue one
// knowledge-candidates call per extracted token and union the substring hits: no
// ranking, no threshold, cards only, and a contiguous Chinese run treated as a single
// token that matched nothing. Two real prompts measured on 2026-09-04 returned zero
// cards that way. The whole prompt now goes to `recall` in one call, which segments
// CJK into bigrams on both sides, ranks by bm25 over cards, minutes and work records,
// and applies its own absolute and relative thresholds. extractQueryTokens survives as
// the cheap emptiness gate — a prompt with no meaningful token is not worth a chain
// read — and is no longer the query.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_PER_PROMPT_BYTES,
  DEFAULT_SESSION_BUDGET,
  InjectionSessionStore,
  UninjectedModelCall,
  buildBoundedCandidateContext,
  buildL0Injection,
  deduplicateCandidates,
  pullCorrelation,
  temporaryEmptyDirectory,
  removeTemporaryDirectory,
  promptDigest,
  recordIdentity,
} from "./injection-session.mjs";

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
export function callChainRead(verb, { partition, ...flags }, { timeoutMs = 120_000, containerRoot = PLATFORM_ROOT, withPartitionFlag = false } = {}) {
  return new Promise((resolvePromise) => {
    const argv = [ENGINE_CLI, verb, "--workspace", workspaceForPartition(partition, containerRoot)];
    // TCRN-CROSS-STORY-362: a verb that accepts --partition is told which partition this
    // path was resolved from, so a drifted resolution is refused rather than answered
    // from the wrong chain. Verbs that do not accept the flag are not given it.
    if (withPartitionFlag) argv.push("--partition", String(partition));
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
export const DEFAULT_BUDGET = DEFAULT_SESSION_BUDGET;
export const DEFAULT_PER_PROMPT = DEFAULT_PER_PROMPT_BYTES;
// TCRN-CROSS-STORY-362: how many recalled records one prompt may carry. The recall verb
// caps its own answer; this is the hook's ceiling, and the byte budget below is what
// actually decides how much of it is spoken.
export const DEFAULT_RECALL_LIMIT = 8;
export const MAX_TOKENS_IN_QUERY = 6;

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

async function configuredInjectionBudget(partition, containerRoot = PLATFORM_ROOT) {
  const call = await callChainRead("settings-catalog", { partition }, { containerRoot });
  if (!call.ok) return DEFAULT_BUDGET;
  const payload = call.result?.result ?? call.result;
  const setting = payload?.settings?.find((entry) => entry.key === "injection.budgetBytes");
  const value = setting?.currentValue ?? setting?.defaultValue;
  return /^(?:0|[1-9][0-9]*)$/u.test(String(value ?? "")) ? Number(value) : DEFAULT_BUDGET;
}

async function configuredSetting(partition, key, containerRoot = PLATFORM_ROOT) {
  const call = await callChainRead("settings-catalog", { partition }, { containerRoot });
  if (!call.ok) return null;
  const payload = call.result?.result ?? call.result;
  const setting = payload?.settings?.find((entry) => entry.key === key);
  return setting?.currentValue ?? setting?.defaultValue ?? null;
}

async function configuredSettingRecords(partition, containerRoot = PLATFORM_ROOT) {
  const call = await callChainRead("settings-catalog", { partition }, { containerRoot });
  if (!call.ok) return [];
  const payload = call.result?.result ?? call.result;
  return Array.isArray(payload?.settings) ? payload.settings : [];
}

async function configuredPerPromptBytes(partition, containerRoot = PLATFORM_ROOT) {
  const value = await configuredSetting(partition, "injection.perPromptBytes", containerRoot);
  return /^(?:0|[1-9][0-9]*)$/u.test(String(value ?? "")) && Number(value) > 0 ? Number(value) : DEFAULT_PER_PROMPT;
}

let coreLanguageModule;
async function languageModule() {
  if (coreLanguageModule !== undefined) return coreLanguageModule;
  try {
    coreLanguageModule = await import(resolve(SCRIPT_DIRECTORY, "../dist/build/packages/core/src/index.js"));
  } catch {
    coreLanguageModule = null;
  }
  return coreLanguageModule;
}

async function telemetryWriter(partition, containerRoot, sessionId, suppliedState = null) {
  const core = await languageModule();
  if (core?.createTelemetryRecord === undefined || core?.appendTelemetryRecord === undefined || core?.activeBinding === undefined) return null;
  const state = suppliedState ?? await workspaceStateForInjection(partition, containerRoot);
  const root = state?.metadata === undefined
    ? null
    : core.activeBinding(state.metadata).find((entry) => entry.kind === "transient")?.path ?? null;
  if (root === null) return null;
  return async ({ kind, payload }) => {
    try {
      const record = core.createTelemetryRecord({
        at: new Date().toISOString(),
        kind,
        session: sessionId,
        payload: {
          source: `knowledge-inject:${kind}`,
          availability: "available",
          ...payload,
        },
      });
      await core.appendTelemetryRecord(root, record);
      return { availability: "available", id: record.id };
    } catch {
      return { availability: "unavailable", id: null };
    }
  };
}

async function emitTelemetry(writer, event) {
  if (typeof writer !== "function") return { availability: "unavailable", id: null };
  try { return await writer(event); } catch { return { availability: "unavailable", id: null }; }
}

async function queryLanguageAnswer(prompt, settings) {
  const core = await languageModule();
  if (core?.readKnowledgeLanguagePolicy && core?.resolveQueryLanguage) {
    const policy = core.readKnowledgeLanguagePolicy((settings ?? []).map((entry) => ({
      key: entry.key,
      value: entry.currentValue ?? entry.value ?? "",
    })));
    return core.resolveQueryLanguage(prompt, policy);
  }
  return { queryLanguage: null, queryTranslation: null, telemetry: { queryTranslations: 0 } };
}

/** Byte-level budget cut, pure: `{ text, truncated }`. A CJK character can exceed the cut. */
export function truncateToBudget(text, budget) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= budget) return { text, truncated: false };
  return { text: Buffer.from(text, "utf8").subarray(0, budget).toString("utf8"), truncated: true };
}

/**
 * TCRN-CROSS-STORY-364 requirement 4: the read-side counterpart of the write-path hook.
 *
 * The engine decides THAT a translation is owed and WHICH model owes it -- the recall verb
 * answers with `queryTranslation` and a `telemetry.queryTranslations` count. It cannot
 * perform the translation: packages/* reach no network and verify:p1's offline leg measures
 * that. So the same division the write path uses applies here. The Agent asks the model
 * recorded in model.economyTier and hands the answer over as data; this file translates
 * once, asks again, and reports the two counts added together.
 */
export function bundleTranslator(bundlePath) {
  if (typeof bundlePath !== "string" || bundlePath.length === 0) return null;
  let bundle = null;
  try { bundle = JSON.parse(readFileSync(bundlePath, "utf8")); } catch { return null; }
  const translations = bundle?.translations ?? {};
  const model = typeof bundle?.model === "string" ? bundle.model : null;
  return (text) => {
    const answer = translations[text];
    return typeof answer === "string" && answer.length > 0 ? { text: answer, model } : null;
  };
}

/** The recall verb's payload, whichever of the two envelopes the chain read returned. */
function recallPayload(call) {
  return call.result?.result ?? call.result ?? {};
}

function recallTranslationCount(payload) {
  const counted = payload?.telemetry?.queryTranslations;
  return Number.isSafeInteger(counted) ? counted : 0;
}
/** The injection chain: prompt -> optional translation -> recall -> metadata-level output. */
export async function runInjection({
  prompt,
  partition,
  budget,
  triggerKeywords,
  limit,
  containerRoot = PLATFORM_ROOT,
  translate = null,
  settings = null,
  recall = null,
  telemetry = null,
} = {}) {
  void triggerKeywords;
  const effectiveBudget = Number.isSafeInteger(budget) && budget > 0 ? budget : await configuredInjectionBudget(partition, containerRoot);
  // The emptiness gate, not the query: a prompt with no meaningful token buys nothing
  // from a chain read, and the whole prompt is what recall ranks against.
  const tokens = extractQueryTokens(prompt);
  if (tokens.length === 0) {
    return { ok: true, injected: false, reason: "NO_QUERY_TOKENS", candidates: [], injectedBytes: 0 };
  }
  const recallLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_RECALL_LIMIT;
  const askRecall = (query) => callChainRead("recall", {
    partition,
    query,
    limit: recallLimit,
    "allow-trailing": true,
    at: new Date().toISOString().replace(/\.\d+Z$/u, "Z")
  }, { containerRoot, withPartitionFlag: true });
  const originalPrompt = String(prompt ?? "");
  let query = originalPrompt;
  let translatedQuery = null;
  let owed = null;
  let queryTranslations = 0;
  let translationFailure = null;
  // R6: use the engine's language policy before recall. The old post-recall path remains
  // as a fail-open compatibility branch for callers that do not have a settings catalog.
  if (typeof translate === "function") {
    const catalogSettings = settings ?? await configuredSettingRecords(partition, containerRoot);
    const languageAnswer = await queryLanguageAnswer(originalPrompt, catalogSettings);
    owed = languageAnswer.queryTranslation ?? null;
    if (owed !== null) {
      const answer = await translate(originalPrompt, owed);
      const text = typeof answer === "string" ? answer : answer?.text;
      if (typeof text === "string" && text.length > 0 && text !== originalPrompt) {
        query = text;
        translatedQuery = text;
        queryTranslations = 1;
      } else if (answer?.reasonCode) {
        translationFailure = { reasonCode: answer.reasonCode, model: answer.model ?? null, at: new Date().toISOString() };
      }
    }
  }
  const call = typeof recall === "function" ? await recall(query, { limit: recallLimit }) : await askRecall(query);
  if (!call.ok) {
    return { ok: false, reasonCode: call.reasonCode, error: call.error, injected: false, candidates: [], injectedBytes: 0 };
  }
  let payload = recallPayload(call);
  if (owed === null) owed = payload.queryTranslation ?? null;
  if (translatedQuery === null) queryTranslations = recallTranslationCount(payload);
  // Fail-open, and deliberately asymmetric with the write path: a session with no answer
  // is worse than an answer ranked in the wrong language. No translator, a bundle without
  // this prompt, or a second recall that errors -- each keeps the first answer and says so.
  if (translatedQuery === null && owed !== null && typeof translate === "function") {
    const answer = await translate(originalPrompt, owed);
    const text = typeof answer === "string" ? answer : answer?.text;
    if (typeof text === "string" && text.length > 0) {
      const second = typeof recall === "function" ? await recall(text, { limit: recallLimit }) : await askRecall(text);
      if (second.ok) {
        translatedQuery = text;
        payload = recallPayload(second);
        queryTranslations = Math.max(queryTranslations, 1) + recallTranslationCount(payload);
      }
    }
  }
  const candidates = payload.records ?? [];
  await emitTelemetry(telemetry, {
    kind: "retrieval-hit",
    payload: {
      candidateCount: candidates.length,
      candidateIds: candidates.map(recordIdentity).filter(Boolean),
      queryTranslations,
    },
  });
  const lines = [];
  for (const candidate of candidates) {
    // The kind and the key are spoken because the answer now spans three record
    // families: a reader has to be able to tell a card from a ruling from a work item.
    const label = `${candidate.kind ?? "card"} ${candidate.key ?? candidate.id ?? ""}`.trim();
    const line = `· [${label}] ${candidate.title ?? candidate.subject ?? ""} — ${candidate.summary ?? ""}`;
    lines.push(line);
  }
  const joined = lines.join("\n");
  const injectedBytes = Buffer.byteLength(joined, "utf8");
  const budgetExceeded = injectedBytes > effectiveBudget;
  await emitTelemetry(telemetry, {
    kind: "injection-bytes",
    payload: {
      candidateCount: candidates.length,
      injectedBytes,
      budget: effectiveBudget,
      budgetExceeded,
    },
  });
  return {
    ok: true,
    injected: true,
    reason: budgetExceeded ? "INJECTION_BUDGET_EXCEEDED" : "INJECTION_PRODUCED",
    ...(budgetExceeded ? { reasonCode: "INJECTION_BUDGET_EXCEEDED", warning: { reasonCode: "INJECTION_BUDGET_EXCEEDED", actualBytes: injectedBytes, budget: effectiveBudget } } : {}),
    queryTokens: tokens,
    candidateCount: candidates.length,
    candidates,
    injectedBytes,
    truncated: false,
    budgetExceeded,
    budget: effectiveBudget,
    queryLanguage: payload.queryLanguage ?? null,
    queryTranslation: owed,
    translatedQuery,
    telemetry: { queryTranslations, ...(translationFailure === null ? {} : { translationFailure }) },
    injection: joined.length === 0 ? null : joined
  };
}

async function workspaceStateForInjection(partition, containerRoot) {
  const core = await languageModule();
  if (core?.validateWorkspace) {
    try { return await core.validateWorkspace(workspaceForPartition(partition, containerRoot)); } catch { /* fail-open hook */ }
  }
  return null;
}

// STORY-387: a SessionStart is the only bounded production opportunity to close the
// previous UTC day. The collector can write a receipt only when the four upstream
// channels supplied explicit start/stop checkpoints; no empty file or missing host
// input is converted into zero activity.
async function sessionObservationCoverage(event, partition, containerRoot, suppliedState = null) {
  if (event !== "SessionStart") return null;
  const core = await languageModule();
  if (typeof core?.sealTelemetryObservationDay !== "function" || typeof core?.activeBinding !== "function") return null;
  try {
    const state = suppliedState ?? await workspaceStateForInjection(partition, containerRoot);
    const root = state?.metadata === undefined ? null : core.activeBinding(state.metadata).find((entry) => entry.kind === "transient")?.path ?? null;
    return root === null ? null : await core.sealTelemetryObservationDay(root, { at: new Date().toISOString() });
  } catch {
    return null;
  }
}

// STORY-377: SessionStart is the once-per-day trigger for the bounded knowledge
// retirement sweep. The marker in the knowledge store makes repeated starts on the
// same UTC day a no-op; a missing or unavailable store keeps the hook fail-open.
async function sessionRetirementSweep(event, partition, containerRoot) {
  if (event !== "SessionStart") return null;
  const core = await languageModule();
  if (typeof core?.retireKnowledgeSweep !== "function") return null;
  try {
    return await core.retireKnowledgeSweep(workspaceForPartition(partition, containerRoot), {
      at: new Date().toISOString(),
    });
  } catch {
    return null;
  }
}

function settingValue(settings, key) {
  const entry = (settings ?? []).find((candidate) => candidate.key === key);
  return entry?.currentValue ?? entry?.value ?? entry?.defaultValue ?? null;
}

async function productionModelCalls({ host, model, translate, judgeEnabled, judge }) {
  const needsTranslator = translate === null;
  const needsObserver = judge === null && judgeEnabled;
  if ((!needsTranslator && !needsObserver) || typeof model !== "string" || model.length === 0) {
    return { translate, judge, cleanup: () => {} };
  }
  const cwd = temporaryEmptyDirectory();
  const translator = needsTranslator
    ? new UninjectedModelCall({
      host,
      model,
      cwd,
      systemPrompt: "Translate the user's prompt into the recorded knowledge language. Return only the translated prompt.",
    })
    : null;
  const observer = needsObserver
    ? new UninjectedModelCall({
      host,
      model,
      cwd,
      systemPrompt: "Judge whether the candidate rows are relevant to the prompt. Return only true or false.",
    })
    : null;
  return {
    translate: translate ?? (async (text) => translator?.translatePrompt(text)),
    judge: judge ?? (observer === null ? null : async (text, candidates) => observer.observeCandidates(text, candidates.map((candidate) => String(candidate.injection ?? candidate.title ?? candidate.id ?? "")))),
    cleanup: () => removeTemporaryDirectory(cwd),
  };
}

/**
 * The production hook path.  Standalone runInjection intentionally retains its historic
 * reporting-only budget; only this path reads and commits the session ledger.
 */
export async function runSessionInjection({
  prompt = "",
  partition = DEFAULT_PARTITION,
  event = "UserPromptSubmit",
  sessionId = "anonymous",
  hookInput = {},
  containerRoot = PLATFORM_ROOT,
  stateDirectory,
  budget,
  perPromptBytes,
  limit,
  settings = null,
  workspaceState = null,
  translate = null,
  judge = null,
  judgeEnabled = true,
  host = process.env.TCRN_HOST ?? "claude",
  recall = null,
} = {}) {
  const store = new InjectionSessionStore({ directory: stateDirectory });
  const lease = await store.acquireAsync(sessionId);
  let calls = { translate, judge, cleanup: () => {} };
  const started = Date.now();
  const parts = [];
  const emittedIds = [];
  let l0 = null;
  let recallResult = { ok: true, injected: false, candidates: [], injectedBytes: 0 };
  let decisionReason = "NO_CONTEXT";
  let retirementSweep = null;
  let observationCoverage = null;
  try {
    const effectiveSettings = settings ?? await configuredSettingRecords(partition, containerRoot);
    const telemetry = await telemetryWriter(partition, containerRoot, sessionId, workspaceState);
    observationCoverage = await sessionObservationCoverage(event, partition, containerRoot, workspaceState);
    retirementSweep = await sessionRetirementSweep(event, partition, containerRoot);
    calls = await productionModelCalls({
      host,
      model: settingValue(effectiveSettings, "model.economyTier"),
      translate,
      judgeEnabled,
      judge,
    });
    const effectiveBudget = Number.isSafeInteger(budget) && budget > 0 ? budget : await configuredInjectionBudget(partition, containerRoot);
    const effectivePerPrompt = Number.isSafeInteger(perPromptBytes) && perPromptBytes > 0 ? perPromptBytes : await configuredPerPromptBytes(partition, containerRoot);
    const shouldReadL0 = event === "SessionStart" || event === "PostCompact" || event === "UserPromptSubmit";
    if (shouldReadL0) {
      const state = workspaceState ?? await workspaceStateForInjection(partition, containerRoot);
      if (state !== null) {
        l0 = buildL0Injection(state);
        const changed = l0.text !== lease.session.lastL0;
        if (event === "SessionStart" || event === "PostCompact" || changed) {
          if (l0.text.length > 0) parts.push(l0.text);
          emittedIds.push(...l0.ids);
          lease.session.lastL0 = l0.text;
          lease.session.lastL0Ids = l0.ids;
          decisionReason = event === "PostCompact" ? "POST_COMPACT_L0" : changed ? "L0_CHANGED" : "SESSION_START_L0";
        }
      }
    }

    if (event === "PostToolUse") {
      const correlation = pullCorrelation(hookInput, lease.session.emittedIds, lease.session.pulledIds);
      if (correlation !== null) {
        lease.session.pulledIds.push(correlation.id);
        lease.session.pullCorrelations.push({ ...correlation, at: new Date().toISOString() });
        await emitTelemetry(telemetry, { kind: "pull", payload: { id: correlation.id, verb: correlation.verb } });
        decisionReason = "PULL_RECORDED";
      } else {
        decisionReason = "PULL_IGNORED";
      }
    } else if (event === "UserPromptSubmit") {
      if (lease.session.l1Bytes >= effectiveBudget) {
        decisionReason = parts.length > 0 ? "BUDGET_SATURATED_L0_ONLY" : "BUDGET_SATURATED";
      } else {
        recallResult = await runInjection({
          prompt,
          partition,
          budget: effectiveBudget,
          limit,
          containerRoot,
          settings: effectiveSettings,
          translate: calls.translate,
          recall,
          telemetry,
        });
        const fresh = deduplicateCandidates(recallResult.candidates, lease.session.emittedIds);
        const allowance = Math.min(effectivePerPrompt, effectiveBudget - lease.session.l1Bytes);
        const candidateContext = buildBoundedCandidateContext(fresh, { maxBytes: allowance });
        if (candidateContext.text.length > 0) {
          parts.push(candidateContext.text);
          emittedIds.push(...candidateContext.ids);
          lease.session.l1Bytes += candidateContext.bytes;
          decisionReason = "INJECTION_EMITTED";
        } else if (recallResult.candidates.length > 0) {
          decisionReason = "ALREADY_INJECTED_SKIPPED";
        } else if (recallResult.ok !== true) {
          decisionReason = recallResult.reasonCode ?? "RECALL_FAILED";
        } else {
          decisionReason = recallResult.reason ?? "NO_CANDIDATES";
        }
        if (judgeEnabled && calls.judge !== null) {
          const judgement = await calls.judge(prompt, fresh, recallResult);
          const judgment = typeof judgement === "boolean" ? judgement : judgement?.judgment;
          lease.session.judgments.push({
            prompt: promptDigest(prompt),
            candidateIds: fresh.map(recordIdentity).filter(Boolean),
            judgment: typeof judgment === "boolean" ? judgment : null,
            model: judgement?.model ?? settingValue(effectiveSettings, "model.economyTier"),
            at: new Date().toISOString(),
          });
          await emitTelemetry(telemetry, {
            kind: "judge",
            payload: {
              candidateCount: fresh.length,
              judgment: typeof judgment === "boolean" ? judgment : null,
              model: judgement?.model ?? settingValue(effectiveSettings, "model.economyTier"),
            },
          });
        }
        if (recallResult.telemetry?.queryTranslations > 0 || recallResult.translatedQuery !== null || recallResult.telemetry?.translationFailure) lease.session.translationAttempts += 1;
      }
    }

    const injection = parts.join("\n");
    const injectedBytes = Buffer.byteLength(injection, "utf8");
    lease.session.emittedBytes += injectedBytes;
    for (const id of emittedIds) if (!lease.session.emittedIds.includes(id)) lease.session.emittedIds.push(id);
    lease.session.decisions.push({
      prompt: promptDigest(prompt),
      event,
      reason: decisionReason,
      ...(recallResult.telemetry?.translationFailure ? { translationFailure: recallResult.telemetry.translationFailure } : {}),
      injectedIds: [...new Set(emittedIds)],
      injectedBytes,
      cumulativeBytes: lease.session.emittedBytes,
      cumulativeL1Bytes: lease.session.l1Bytes,
      at: new Date().toISOString(),
      elapsedMs: Date.now() - started,
    });
    lease.commit();
    return {
      ...recallResult,
      ok: recallResult.ok !== false,
      injected: injection.length > 0,
      injection: injection.length > 0 ? injection : null,
      injectedBytes,
      cumulativeBytes: lease.session.emittedBytes,
      cumulativeL1Bytes: lease.session.l1Bytes,
      decision: decisionReason,
      l0,
      sessionId,
      ...(observationCoverage === null ? {} : { observationCoverage }),
      ...(retirementSweep === null ? {} : { retirementSweep }),
      telemetry: {
        ...(recallResult.telemetry ?? {}),
        judgments: lease.session.judgments.length,
        translationAttempts: lease.session.translationAttempts,
      },
    };
  } finally {
    calls.cleanup();
    lease.release();
  }
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
  let hookInput = {};
  if (typeof flags["hook-input"] === "string") {
    try { hookInput = JSON.parse(flags["hook-input"]); } catch { hookInput = {}; }
  }
  return {
    prompt: typeof flags.prompt === "string" ? flags.prompt : "",
    partition: typeof flags.partition === "string" ? flags.partition : DEFAULT_PARTITION,
    limit: typeof flags.limit === "string" ? Number(flags.limit) : DEFAULT_RECALL_LIMIT,
    budget: typeof flags.budget === "string" ? Number(flags.budget) : (Number(process.env.TCRN_KNOWLEDGE_INJECTION_BUDGET) || undefined),
    perPromptBytes: typeof flags["per-prompt-bytes"] === "string" ? Number(flags["per-prompt-bytes"]) : undefined,
    triggerKeywords: typeof flags["trigger-keywords"] === "string" ? flags["trigger-keywords"] : "",
    translate: bundleTranslator(typeof flags["translation-bundle"] === "string" ? flags["translation-bundle"] : ""),
    sessionId: typeof flags["session-id"] === "string" ? flags["session-id"] : null,
    event: typeof flags.event === "string" ? flags.event : "UserPromptSubmit",
    stateDirectory: typeof flags["state-dir"] === "string" ? flags["state-dir"] : undefined,
    hookInput,
    judgeEnabled: flags["judge-enabled"] !== "false",
    host: typeof flags.host === "string" ? flags.host : (process.env.TCRN_HOST ?? "claude"),
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
      const start = await runInjection({ prompt: "hook", partition: options.partition, budget: options.budget, triggerKeywords: "" });
      if (start.ok !== true) { out(start); process.exitCode = 1; }
      else if (start.injected !== true || start.candidateCount === 0) { out({ ok: false, reasonCode: "RETRIEVAL_CHAIN_NO_RETURN", detail: "the chain produced no candidates for a known keyword", observed: start }); process.exitCode = 1; }
      else out({ ok: true, reasonCode: "INJECTION_CHANNEL_LIVE", registered: registered.length, ...start });
    }
    process.exitCode = process.exitCode ?? 0;
  } else if (options.selfTest) {
    // self-test must NOT be green on zero retrieval (恒绿门, INC-044): a retrieval
    // chain that produces no candidates for a known curated term is a broken chain.
    // Predicate aligned with verify-channel.
    const result = await runInjection({ prompt: "hook 没有生效", partition: options.partition, budget: options.budget, triggerKeywords: "" });
    out(result);
    if (result.ok !== true || result.injected !== true || result.candidateCount === 0) process.exitCode = 1;
  } else {
    out(options.sessionId === null
      ? await runInjection(options)
      : await runSessionInjection(options));
  }
}
