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
// UserPromptSubmit (every prompt) and explicitly bound SubagentStart (task frame).
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
  boundedSearch,
  buildBoundedCandidateContext,
  buildBoundedTaskContext,
  buildL0Injection,
  deduplicateCandidates,
  filterCandidatesByDispatchContext,
  normalizeDispatchContext,
  pullCorrelation,
  temporaryEmptyDirectory,
  removeTemporaryDirectory,
  promptDigest,
  recordIdentity,
} from "./injection-session.mjs";
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

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
const DISPATCH_HOST_ALIASES = Object.freeze({ claude: "claude-code", codex: "codex" });

const CHILD_AGENT_MARKER_FIELDS = Object.freeze(["agent_id", "agentId", "child_agent_id", "childAgentId"]);

export function hasChildAgentMarker(input = {}) {
  const scopes = [input, input?.payload, input?.context, input?.dispatchContext, input?.dispatch, input?.task, input?.subagent, input?.agent];
  return scopes.some((scope) => scope !== null && typeof scope === "object" && !Array.isArray(scope)
    && CHILD_AGENT_MARKER_FIELDS.some((field) => scope[field] !== undefined && scope[field] !== null && scope[field] !== ""));
}

export function dispatchHostName(host) {
  return DISPATCH_HOST_ALIASES[host] ?? host;
}

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
// The hook protocol is a bounded, single-document JSON exchange.  This ceiling
// applies to the child-process result, not to the smaller additionalContext
// budget; a result beyond it is a visible transport failure and is retriable.
export const INJECTION_PROTOCOL_VERSION = "tcrn.injection-protocol.v2";
export const MAX_INJECTION_PROTOCOL_BYTES = 512_000;
export const MAX_INJECTION_PROTOCOL_ERROR_BYTES = 512;
export const DEFAULT_INJECTION_RETRIES = 1;

const STOPWORDS = new Set([
  "怎么", "应该", "没有", "为什么", "如果", "可以", "一个", "这个", "那个",
  "在", "里", "了", "的", "吗", "呢", "做", "写", "查", "对", "是", "不",
  "要", "给", "和", "或", "与", "我", "你", "它", "们", "条", "次", "什么",
]);


export function parseFlags(argv) {
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

export const parseBooleanFlag = (value) => value === true || value === "true" ? true : value === false || value === "false" ? false : null;

function protocolObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reasonCode: "INJECT_OUTPUT_INVALID" };
  const output = { ...value };
  // The wrapper only needs metadata-level rows.  Keeping a whole recall result
  // (and especially an accidental body field) in argv/stdout makes transport
  // size depend on store contents and can reproduce INC318 under ARG_MAX.
  if (Array.isArray(output.candidates)) {
    output.candidates = output.candidates.map((candidate) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
      const safe = {};
      for (const key of ["id", "kind", "key", "status", "title", "subject", "summary", "score", "workId", "workIds", "linkedWorkIds", "pack", "packId", "labels", "tags"]) {
        if (candidate[key] !== undefined) safe[key] = candidate[key];
      }
      return safe;
    });
  }
  if (typeof output.error === "string") output.error = output.error.slice(-MAX_INJECTION_PROTOCOL_ERROR_BYTES);
  return output;
}

/** Serialize one bounded protocol document for the production CLI. */
export function serializeInjectionProtocol(value, { maxBytes = MAX_INJECTION_PROTOCOL_BYTES } = {}) {
  const projected = { ...protocolObject(value), protocolVersion: INJECTION_PROTOCOL_VERSION };
  const text = JSON.stringify(projected);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, bytes, truncated: false, value: projected };
  const failure = {
    protocolVersion: INJECTION_PROTOCOL_VERSION,
    ok: false,
    reasonCode: "INJECT_OUTPUT_TRUNCATED",
    truncated: true,
    outputBytes: bytes,
    maximumBytes: maxBytes,
  };
  return { text: JSON.stringify(failure), bytes: Buffer.byteLength(JSON.stringify(failure), "utf8"), truncated: true, value: failure };
}

/** Parse either the current one-document protocol or a legacy pretty JSON result. */
export function parseInjectionProtocol(stdout, { maxBytes = MAX_INJECTION_PROTOCOL_BYTES } = {}) {
  const source = String(stdout ?? "");
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > maxBytes) return { ok: false, reasonCode: "INJECT_OUTPUT_TRUNCATED", outputBytes: bytes, maximumBytes: maxBytes };
  const text = source.trim();
  if (text.length === 0) return { ok: false, reasonCode: "INJECT_OUTPUT_UNPARSEABLE", outputBytes: bytes };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    // A legacy one-line response is accepted, but a mixture of logs and JSON
    // is not: taking the last line was the INC318 failure mode in reverse.
    if (lines.length === 1) {
      try { parsed = JSON.parse(lines[0]); } catch { parsed = null; }
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reasonCode: "INJECT_OUTPUT_UNPARSEABLE", outputBytes: bytes };
  if (parsed.protocolVersion !== undefined && parsed.protocolVersion !== INJECTION_PROTOCOL_VERSION) {
    return { ok: false, reasonCode: "INJECT_PROTOCOL_VERSION_UNSUPPORTED", protocolVersion: parsed.protocolVersion, outputBytes: bytes };
  }
  return { ok: true, value: parsed, outputBytes: bytes, legacy: parsed.protocolVersion === undefined };
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

export const OBSERVATION_CHANNELS = Object.freeze(["retrieval", "reference", "trigger", "verify"]);
export const OBSERVATION_BOUNDARY_PREFIX = "telemetry:observation-collector:";
const OBSERVATION_CHANNEL_BY_KIND = Object.freeze({ retrieval: "retrieval", "retrieval-hit": "retrieval", reference: "reference", pull: "reference", trigger: "trigger", "rule-trigger": "trigger", verify: "verify", "gate-result": "verify" });

async function nextObservationSequence(core, root, kind, source) {
  const channel = OBSERVATION_CHANNEL_BY_KIND[kind];
  if (channel === undefined || typeof core.readTelemetryRecords !== "function") return null;
  const read = await core.readTelemetryRecords(root, { limit: Number.MAX_SAFE_INTEGER });
  const values = read.records
    .filter((record) => OBSERVATION_CHANNEL_BY_KIND[record.kind] === channel && record.payload.source === source)
    .map((record) => record.payload.sequence)
    .filter((sequence) => Number.isSafeInteger(sequence) && sequence >= 1);
  return Math.max(0, ...values) + 1;
}

async function telemetryWriter(partition, containerRoot, sessionId, suppliedState = null) {
  const core = await languageModule();
  if (core?.createTelemetryRecord === undefined || core?.appendTelemetryRecord === undefined || core?.activeBinding === undefined) return null;
  const state = suppliedState ?? await workspaceStateForInjection(partition, containerRoot);
  const root = state?.metadata === undefined
    ? null
    : core.activeBinding(state.metadata).find((entry) => entry.kind === "transient")?.path ?? null;
  if (root === null) return null;
  return async ({ kind, payload, observationPhase, observationSource }) => {
    try {
      const source = observationSource ?? `knowledge-inject:${kind}`;
      const sequence = observationPhase === "start" || observationPhase === "stop"
        ? await nextObservationSequence(core, root, kind, source)
        : null;
      const record = core.createTelemetryRecord({
        at: new Date().toISOString(),
        kind,
        session: sessionId,
        payload: {
          ...payload,
          source,
          availability: "available",
          ...(sequence === null ? {} : { phase: observationPhase, sequence }),
        },
      });
      const receipt = await core.appendTelemetryRecord(root, record);
      return { availability: "available", id: receipt.record.id };
    } catch {
      return { availability: "unavailable", id: null };
    }
  };
}

function safeObservationPart(value, fallback) {
  const text = String(value ?? fallback).replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 32);
  return text.length > 0 ? text : fallback;
}

function observationSourceIdentity(record, channel) {
  const source = typeof record?.payload?.source === "string" ? record.payload.source : "";
  if (!source.startsWith(OBSERVATION_BOUNDARY_PREFIX)) return null;
  const session = safeObservationPart(record.session, "unknown-session");
  const suffix = `:${session}:${channel}`;
  if (source.endsWith(suffix) && source.length > OBSERVATION_BOUNDARY_PREFIX.length + suffix.length) {
    const day = /^(\d{8})\./u.exec(session)?.[1];
    return day === undefined ? `${source.slice(0, -suffix.length)}:${channel}` : `${source.slice(0, -suffix.length)}:${day}.${channel}`;
  }
  return source.endsWith(`:${channel}`) ? source : null;
}

function observationChronologicalCompare(left, right) {
  return left.at.localeCompare(right.at) || Number(left.payload.sequence) - Number(right.payload.sequence) || left.id.localeCompare(right.id);
}

function observationPhaseSequenceValid(rows) {
  const phases = rows.map((record) => record.payload.phase);
  const sequences = rows.map((record) => record.payload.sequence);
  return rows.length >= 2 && rows.length % 2 === 0 && rows.every((record) => record.payload.availability === "available") && phases.every((phase, index) => phase === (index % 2 === 0 ? "start" : "stop")) && sequences.every((sequence, index) => Number.isSafeInteger(sequence) && sequence >= 1 && (index === 0 || sequence === sequences[index - 1] + 1));
}

function observationIntervals(rows) {
  const ordered = [...rows].sort(observationChronologicalCompare);
  if (!observationPhaseSequenceValid(rows) || !observationPhaseSequenceValid(ordered)) return null;
  const intervals = [];
  for (let index = 0; index < ordered.length; index += 2) {
    const start = ordered[index];
    const last = ordered[index + 1];
    intervals.push({ ordered: [start, last], start: Date.parse(start.at), end: Date.parse(last.at), last });
  }
  return intervals;
}

function observationHighWaterValid(record, actual, day, requireFull = false) {
  const fields = record.payload;
  const observed = typeof fields.highWaterAt === "string" ? actual.filter((entry) => entry.at <= fields.highWaterAt) : [];
  return fields.highWaterDay === day && Number.isSafeInteger(fields.highWaterCount) && fields.highWaterCount === observed.length && typeof fields.highWaterDigest === "string" && fields.highWaterDigest === canonicalSha256(observed) && (!requireFull || observed.length === actual.length);
}

function observationCoverageCandidate(rows, actual, from, until) {
  const groups = new Map();
  for (const row of rows) {
    const list = groups.get(row.payload.source) ?? [];
    list.push(row);
    groups.set(row.payload.source, list);
  }
  const intervals = [];
  for (const group of groups.values()) {
    const paired = observationIntervals(group);
    if (paired === null || paired.some((interval) => !observationHighWaterValid(interval.last, actual, from.slice(0, 10)))) continue;
    intervals.push(...paired);
  }
  intervals.sort((left, right) => left.start - right.start || left.end - right.end || left.last.id.localeCompare(right.last.id));
  let cursor = Date.parse(from);
  for (const interval of intervals) {
    if (interval.start > cursor) return null;
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < Date.parse(until) - 1) return null;
  const terminal = intervals.reduce((best, interval) => best === null || interval.end > best.end ? interval : best, null);
  if (terminal === null || !observationHighWaterValid(terminal.last, actual, from.slice(0, 10), true)) return null;
  const selected = intervals.flatMap((interval) => interval.ordered).sort(observationChronologicalCompare);
  return { rows: selected, startSequence: intervals[0].ordered[0].payload.sequence, stopSequence: terminal.last.payload.sequence };
}

async function telemetryRootForState(core, partition, containerRoot, suppliedState = null) {
  const state = suppliedState ?? await workspaceStateForInjection(partition, containerRoot);
  return state?.metadata === undefined ? null : core.activeBinding(state.metadata).find((entry) => entry.kind === "transient")?.path ?? null;
}

const MAX_BOUNDARY_DAYS_PER_STOP = 3;

function observationDay(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function observationSessionKey(day, sessionId) {
  return safeObservationPart(`${day.replace(/-/gu, "")}.${safeObservationPart(sessionId, "unknown-session")}`, "unknown-session");
}

function observationSourceForDay(host, sessionId, day, channel) {
  const hostPart = safeObservationPart(host, "unknown-host");
  const sessionKey = observationSessionKey(day, sessionId);
  return {
    source: `${OBSERVATION_BOUNDARY_PREFIX}${hostPart}:${sessionKey}:${channel}`,
    sessionKey,
  };
}

function observationSessionKeyDay(session) {
  if (typeof session !== "string" || !/^\d{8}\./u.test(session)) return null;
  return `${session.slice(0, 4)}-${session.slice(4, 6)}-${session.slice(6, 8)}`;
}

function observationBoundaryRows(records, host, sessionId, channel) {
  const hostPart = safeObservationPart(host, "unknown-host");
  const sessionPart = safeObservationPart(sessionId, "unknown-session");
  const maximumSessionPart = sessionPart.slice(0, 23);
  const prefix = `${OBSERVATION_BOUNDARY_PREFIX}${hostPart}:`;
  return records.filter((record) => {
    const session = record.session;
    const source = record.payload?.source;
    return String(source).startsWith(prefix)
      && String(source).endsWith(`:${channel}`)
      && typeof session === "string"
      && /^\d{8}\./u.test(session)
      && session.slice(9) === maximumSessionPart
      && String(source).endsWith(`:${session}:${channel}`);
  });
}

function observationLastBoundaryRow(rows) {
  return [...rows].sort((left, right) => Number(left.payload.sequence) - Number(right.payload.sequence) || left.at.localeCompare(right.at) || left.id.localeCompare(right.id)).at(-1) ?? null;
}

function observationLatestStop(rows) {
  return rows.filter((record) => record.payload.phase === "stop")
    .sort((left, right) => left.at.localeCompare(right.at) || Number(left.payload.sequence) - Number(right.payload.sequence) || left.id.localeCompare(right.id))
    .at(-1) ?? null;
}

function observationDaysBetween(from, until) {
  const fromValue = Date.parse(`${from}T00:00:00.000Z`);
  const untilValue = Date.parse(`${until}T00:00:00.000Z`);
  if (!Number.isFinite(fromValue) || !Number.isFinite(untilValue)) return [];
  if (fromValue > untilValue) return [from];
  const days = [];
  for (let cursor = fromValue; cursor <= untilValue && days.length <= MAX_BOUNDARY_DAYS_PER_STOP; cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

function observationActualForDay(records, channel, day, through) {
  const throughValue = Date.parse(through);
  return records.filter((record) => OBSERVATION_CHANNEL_BY_KIND[record.kind] === channel
    && !String(record.payload?.source).startsWith(OBSERVATION_BOUNDARY_PREFIX)
    && observationDay(record.at) === day
    && (!Number.isFinite(throughValue) || Date.parse(record.at) <= throughValue))
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
}

function observationHighWaterPayload(records, channel, day, at, source, phase, sequence, through) {
  const actual = observationActualForDay(records, channel, day, through);
  return {
    source,
    availability: "available",
    phase,
    sequence,
    highWaterDay: day,
    highWaterCount: actual.length,
    highWaterDigest: canonicalSha256(actual),
    highWaterAt: actual.at(-1)?.at ?? null,
  };
}

/** Record the real host-session boundaries used by the daily coverage proof. */
export async function recordObservationBoundary({
  partition = DEFAULT_PARTITION,
  containerRoot = PLATFORM_ROOT,
  sessionId = "anonymous",
  host = process.env.TCRN_HOST ?? "claude",
  phase,
  at = new Date().toISOString(),
  workspaceState = null,
} = {}) {
  if (phase !== "start" && phase !== "stop") return { ok: false, reasonCode: "TELEMETRY_BOUNDARY_INVALID" };
  const core = await languageModule();
  if (typeof core?.createTelemetryRecord !== "function" || typeof core?.appendTelemetryRecord !== "function" || typeof core?.readTelemetryRecords !== "function" || typeof core?.activeBinding !== "function") return { ok: false, reasonCode: "TELEMETRY_BOUNDARY_UNAVAILABLE" };
  try {
    const root = await telemetryRootForState(core, partition, containerRoot, workspaceState);
    if (root === null) return { ok: false, reasonCode: "TELEMETRY_BOUNDARY_UNAVAILABLE" };
    const atDay = observationDay(at);
    if (atDay === null) return { ok: false, reasonCode: "TELEMETRY_BOUNDARY_INVALID" };
    const read = await core.readTelemetryRecords(root, { limit: Number.MAX_SAFE_INTEGER, preserveOrder: true });
    const records = [...read.records];
    const created = [];
    if (phase === "start") {
      for (const channel of OBSERVATION_CHANNELS) {
        const target = observationSourceForDay(host, sessionId, atDay, channel);
        const rows = records.filter((record) => record.payload?.source === target.source);
        const sequence = Math.max(0, ...rows.map((record) => record.payload.sequence).filter((value) => Number.isSafeInteger(value) && value >= 1)) + 1;
        created.push(core.createTelemetryRecord({
          at,
          kind: channel,
          session: target.sessionKey,
          payload: observationHighWaterPayload(records, channel, atDay, at, target.source, "start", sequence, at),
        }));
      }
    } else {
      // Inspect every channel before constructing any stop rows. A stale, empty, or
      // divergent channel invalidates the whole invocation; partial stop coverage is
      // never evidence of a real boundary.
      const plans = OBSERVATION_CHANNELS.map((channel) => {
        const sessionRows = observationBoundaryRows(records, host, sessionId, channel);
        const open = sessionRows
          .map((record) => ({ record, day: observationSessionKeyDay(record.session) }))
          .filter(({ record, day }) => day !== null && record.payload.phase === "start")
          .filter(({ record }) => observationLastBoundaryRow(sessionRows.filter((candidate) => candidate.payload.source === record.payload.source))?.id === record.id)
          .sort((left, right) => left.record.at.localeCompare(right.record.at) || left.record.id.localeCompare(right.record.id))
          .at(-1) ?? null;
        const previousStop = observationLatestStop(sessionRows);
        const startAt = open?.record.at ?? previousStop?.at ?? at;
        const startDay = open?.day ?? observationDay(startAt) ?? atDay;
        return {
          channel,
          startAt,
          startDay,
          days: observationDaysBetween(startDay, atDay),
          hasPriorBoundary: open !== null || previousStop !== null,
        };
      });
      const gap = plans.find(({ days, hasPriorBoundary }) => !hasPriorBoundary || days.length === 0 || days.length > MAX_BOUNDARY_DAYS_PER_STOP) ?? null;
      const currentDayResume = plans.every(({ channel }) => {
        const target = observationSourceForDay(host, sessionId, atDay, channel);
        const last = observationLastBoundaryRow(records.filter((record) => record.payload?.source === target.source));
        return last?.payload.phase === "start" && last.at === at;
      });
      if (gap !== null || currentDayResume) {
        // On a gap, resume at the actual Stop instant. The new starts are the only
        // records allowed here: no backdated rows, Stop rows, or coverage receipt.
        // Repeating the exact invocation sees the same four starts and is a no-op.
        if (!currentDayResume) {
          for (const channel of OBSERVATION_CHANNELS) {
            const target = observationSourceForDay(host, sessionId, atDay, channel);
            const rows = records.filter((record) => record.payload?.source === target.source);
            const last = observationLastBoundaryRow(rows);
            if (last?.payload.phase === "start" && last.at === at) continue;
            const sequence = Math.max(0, ...rows.map((record) => record.payload.sequence).filter((value) => Number.isSafeInteger(value) && value >= 1)) + 1;
            created.push(core.createTelemetryRecord({
              at,
              kind: channel,
              session: target.sessionKey,
              payload: observationHighWaterPayload(records, channel, atDay, at, target.source, "start", sequence, at),
            }));
          }
        }
        const resumedReceipts = [];
        for (const record of created) {
          const receipt = await core.appendTelemetryRecord(root, record);
          resumedReceipts.push(receipt);
          if (!receipt.duplicate) records.push(record);
        }
        return {
          ok: false,
          reasonCode: "TELEMETRY_BOUNDARY_GAP_RESUMED",
          unknown: true,
          resumed: true,
          from: gap?.startDay ?? (currentDayResume
            ? OBSERVATION_CHANNELS.flatMap((channel) => observationBoundaryRows(records, host, sessionId, channel)
              .map((record) => observationSessionKeyDay(record.session))
              .filter((day) => day !== null && day !== atDay))
              .sort()
              .at(0) ?? atDay
            : atDay),
          until: atDay,
          count: resumedReceipts.length,
          duplicate: currentDayResume || resumedReceipts.some((receipt) => receipt.duplicate),
        };
      }
      for (const { channel, startAt, startDay, days } of plans) {
        for (const day of days) {
          const target = observationSourceForDay(host, sessionId, day, channel);
          const rows = records.filter((record) => record.payload?.source === target.source);
          const last = observationLastBoundaryRow(rows);
          let sequence = Math.max(0, ...rows.map((record) => record.payload.sequence).filter((value) => Number.isSafeInteger(value) && value >= 1)) + 1;
          if (last?.payload.phase !== "start") {
            created.push(core.createTelemetryRecord({
              at: startAt,
              kind: channel,
              session: target.sessionKey,
              payload: observationHighWaterPayload(records, channel, day, startAt, target.source, "start", sequence, startAt),
            }));
            sequence += 1;
          }
          created.push(core.createTelemetryRecord({
            at,
            kind: channel,
            session: target.sessionKey,
            payload: observationHighWaterPayload(records, channel, day, at, target.source, "stop", sequence, at),
          }));
        }
      }
    }
    const receipts = [];
    for (const record of created) {
      const receipt = await core.appendTelemetryRecord(root, record);
      receipts.push(receipt);
      if (!receipt.duplicate) records.push(record);
    }
    const coverage = phase === "stop" ? await sealObservationDay(root, { at }) : null;
    return { ok: true, reasonCode: "TELEMETRY_BOUNDARY_RECORDED", phase, sessionId: String(sessionId), count: receipts.length, duplicate: receipts.some((receipt) => receipt.duplicate), ...(coverage === null ? {} : { coverage }) };
  } catch (error) {
    return { ok: false, reasonCode: "TELEMETRY_BOUNDARY_UNAVAILABLE", error: String(error?.reasonCode ?? error?.message ?? error) };
  }
}

async function emitTelemetry(writer, event) {
  if (typeof writer !== "function") return { availability: "unavailable", id: null };
  try { return await writer(event); } catch { return { availability: "unavailable", id: null }; }
}

export async function sealObservationDay(root, { at = new Date().toISOString(), coveredFrom, coveredUntil } = {}) {
  const core = await languageModule();
  if (core?.createTelemetryRecord === undefined || core?.appendTelemetryRecord === undefined || core?.readTelemetryRecords === undefined) return { ok: false, reasonCode: "TELEMETRY_COVERAGE_UNPROVEN" };
  const current = new Date(at);
  if (Number.isNaN(current.getTime())) return { ok: false, reasonCode: "TELEMETRY_COVERAGE_UNPROVEN" };
  current.setUTCHours(0, 0, 0, 0);
  const until = coveredUntil ?? current.toISOString();
  const fromDate = new Date(current);
  fromDate.setUTCDate(fromDate.getUTCDate() - 1);
  const from = coveredFrom ?? fromDate.toISOString();
  const fromValue = Date.parse(from);
  const untilValue = Date.parse(until);
  if (!Number.isFinite(fromValue) || !Number.isFinite(untilValue) || untilValue - fromValue !== 86_400_000 || current.getTime() < untilValue || !from.endsWith("T00:00:00.000Z") || !until.endsWith("T00:00:00.000Z")) return { ok: false, reasonCode: "TELEMETRY_COVERAGE_UNPROVEN", coveredFrom: from, coveredUntil: until };
  const read = await core.readTelemetryRecords(root, { limit: Number.MAX_SAFE_INTEGER, preserveOrder: true });
  const targetFile = `${from.slice(0, 10)}.ndjson`;
  const entries = read.records.filter((record) => record.kind !== "observation-coverage" && Date.parse(record.at) >= fromValue && Date.parse(record.at) < untilValue)
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  const proofEntries = read.records.filter((record) => record.kind !== "observation-coverage" && ((Date.parse(record.at) >= fromValue && Date.parse(record.at) < untilValue) || String(record.payload.source).startsWith(OBSERVATION_BOUNDARY_PREFIX)));
  const missingChannels = [];
  const invalidChannels = [];
  const channelCheckpoints = {};
  for (const channel of OBSERVATION_CHANNELS) {
    const allRows = proofEntries.filter((record) => OBSERVATION_CHANNEL_BY_KIND[record.kind] === channel && String(record.payload.source).startsWith(OBSERVATION_BOUNDARY_PREFIX));
    if (allRows.length === 0) { missingChannels.push(channel); continue; }
    const actual = entries.filter((record) => OBSERVATION_CHANNEL_BY_KIND[record.kind] === channel && !String(record.payload.source).startsWith(OBSERVATION_BOUNDARY_PREFIX)).sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
    if (actual.length === 0) { invalidChannels.push(channel); continue; }
    const identities = [...new Set(allRows.map((record) => observationSourceIdentity(record, channel)).filter(Boolean))].sort();
    const candidate = identities.map((identity) => ({ identity, rows: allRows.filter((record) => observationSourceIdentity(record, channel) === identity) }))
      .map(({ identity, rows }) => ({ identity, proof: observationCoverageCandidate(rows, actual, from, until) }))
      .find((entry) => entry.proof !== null);
    if (candidate === undefined) { invalidChannels.push(channel); continue; }
    const { proof } = candidate;
    channelCheckpoints[channel] = { availability: "available", source: candidate.identity, startSequence: proof.startSequence, stopSequence: proof.stopSequence, recordCount: proof.rows.length, sourceDigest: canonicalSha256(proof.rows), highWaterDay: from.slice(0, 10), highWaterCount: actual.length, highWaterDigest: canonicalSha256(actual) };
  }
  const problems = read.problems.filter((problem) => problem.path.endsWith(`/${targetFile}`));
  const sourceDigest = canonicalSha256(entries);
  if (problems.length > 0 || entries.length === 0 || missingChannels.length > 0 || invalidChannels.length > 0) return { ok: false, reasonCode: "TELEMETRY_COVERAGE_UNPROVEN", coveredFrom: from, coveredUntil: until, missingChannels, invalidChannels, recordCount: entries.length, sourceDigest };
  const existing = read.records.filter((record) => record.kind === "observation-coverage" && record.payload.coveredFrom === from && record.payload.coveredUntil === until);
  const matching = existing.find((record) => record.payload.sourceDigest === sourceDigest && record.payload.recordCount === entries.length);
  if (matching !== undefined) return { ok: true, reasonCode: "TELEMETRY_COVERAGE_ALREADY_RECORDED", coveredFrom: from, coveredUntil: until, recordCount: entries.length, sourceDigest, duplicate: true, record: matching };
  if (existing.length > 0) return { ok: false, reasonCode: "TELEMETRY_COVERAGE_CONFLICT", coveredFrom: from, coveredUntil: until, recordCount: entries.length, sourceDigest };
  const receipt = await core.appendTelemetryRecord(root, core.createTelemetryRecord({
    at,
    kind: "observation-coverage",
    session: `observation-seal-${from.slice(0, 10)}`,
    payload: { source: "telemetry:observation-collector", availability: "available", coverageVersion: "tcrn.telemetry-observation-coverage.v1", coveredFrom: from, coveredUntil: until, channels: ["retrieval", "reference", "trigger", "verify"], channelCheckpoints, recordCount: entries.length, sourceDigest, collectionErrors: 0 },
  }));
  return { ok: true, reasonCode: receipt.duplicate ? "TELEMETRY_COVERAGE_ALREADY_RECORDED" : "TELEMETRY_COVERAGE_RECORDED", coveredFrom: from, coveredUntil: until, recordCount: entries.length, sourceDigest, duplicate: receipt.duplicate, record: receipt.record };
}

async function queryLanguageAnswer(prompt, settings, host) {
  const core = await languageModule();
  if (core?.readKnowledgeLanguagePolicy && core?.resolveQueryLanguage) {
    const policy = core.readKnowledgeLanguagePolicy((settings ?? []).map((entry) => ({
      key: entry.key,
      value: entry.currentValue ?? entry.value ?? entry.defaultValue ?? "",
    })), dispatchHostName(host));
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
 * that. So the same division the write path uses applies here. The Agent asks the
 * economy-tier model configured for the current host and hands the answer over as data;
 * this file translates
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
  host = process.env.TCRN_HOST ?? "claude",
  translate = null,
  settings = null,
  recall = null,
  telemetry = null,
  dispatchContext = null,
  context = null,
  searchScope = null,
} = {}) {
  void triggerKeywords;
  const suppliedContext = dispatchContext ?? context;
  const boundContext = suppliedContext === null
    ? null
    : normalizeDispatchContext(suppliedContext, { env: {}, requireBinding: true });
  if (boundContext !== null && boundContext.ok !== true) {
    return { ok: true, injected: false, reason: boundContext.reasonCode, reasonCode: boundContext.reasonCode, candidates: [], injectedBytes: 0, dispatchContext: boundContext };
  }
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
    host: dispatchHostName(host),
    "allow-trailing": true,
    at: new Date().toISOString().replace(/\.\d+Z$/u, "Z")
  }, { containerRoot, withPartitionFlag: true });
  const invokeRecall = async (query) => {
    const baseScope = Array.isArray(searchScope)
      ? { manifest: searchScope }
      : searchScope !== null && typeof searchScope === "object" ? searchScope : {};
    const boundedRecallSearch = (options = {}) => {
      const requested = options !== null && typeof options === "object" && !Array.isArray(options) ? options : {};
      return boundedSearch({
        ...baseScope,
        ...requested,
        query: typeof requested.query === "string" ? requested.query : query,
      });
    };
    try {
      return typeof recall === "function" ? await recall(query, {
        limit: recallLimit,
        searchScope,
        boundedSearch: boundedRecallSearch,
        ...(boundContext?.bound === true ? { role: boundContext.role, workId: boundContext.workId, pack: boundContext.pack } : {}),
      }) : await askRecall(query);
    } catch (error) {
      return { ok: false, reasonCode: "RECALL_FAILED", error: String(error?.reasonCode ?? error?.message ?? error) };
    }
  };
  const retrievalSource = "knowledge-inject:retrieval";
  await emitTelemetry(telemetry, { kind: "retrieval", observationPhase: "start", observationSource: retrievalSource, payload: { stage: "start" } });
  const originalPrompt = String(prompt ?? "");
  let query = originalPrompt;
  let translatedQuery = null;
  let owed = null;
  let queryTranslations = 0;
  let translationFailure = null;
  const invokeTranslator = async (original, owedLanguage) => {
    try {
      return await translate(original, owedLanguage);
    } catch (error) {
      return { text: null, reasonCode: "UNINJECTED_MODEL_FAILED", error: String(error?.message ?? error) };
    }
  };
  // R6: use the engine's language policy before recall. The old post-recall path remains
  // as a fail-open compatibility branch for callers that do not have a settings catalog.
  if (typeof translate === "function") {
    const catalogSettings = settings ?? await configuredSettingRecords(partition, containerRoot);
    const languageAnswer = await queryLanguageAnswer(originalPrompt, catalogSettings, host);
    owed = languageAnswer.queryTranslation ?? null;
    if (owed !== null) {
      const answer = await invokeTranslator(originalPrompt, owed);
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
  const call = await invokeRecall(query);
  if (!call.ok) {
    await emitTelemetry(telemetry, { kind: "retrieval", observationPhase: "stop", observationSource: retrievalSource, payload: { stage: "stop" } });
    return { ok: false, reasonCode: call.reasonCode, error: call.error, injected: false, candidates: [], injectedBytes: 0 };
  }
  let payload = recallPayload(call);
  if (owed === null) owed = payload.queryTranslation ?? null;
  if (translatedQuery === null) queryTranslations = recallTranslationCount(payload);
  // Fail-open, and deliberately asymmetric with the write path: a session with no answer
  // is worse than an answer ranked in the wrong language. No translator, a bundle without
  // this prompt, or a second recall that errors -- each keeps the first answer and says so.
  if (translatedQuery === null && owed !== null && typeof translate === "function") {
    const answer = await invokeTranslator(originalPrompt, owed);
    const text = typeof answer === "string" ? answer : answer?.text;
    if (typeof text === "string" && text.length > 0) {
      const second = await invokeRecall(text);
      if (second.ok) {
        translatedQuery = text;
        payload = recallPayload(second);
        queryTranslations = Math.max(queryTranslations, 1) + recallTranslationCount(payload);
      }
    }
  }
  const rawCandidates = Array.isArray(payload.records) ? payload.records : [];
  const scoped = boundContext === null
    ? { records: rawCandidates, excluded: 0, reasonCode: "DISPATCH_CONTEXT_UNSCOPED" }
    : filterCandidatesByDispatchContext(rawCandidates, boundContext);
  const candidates = scoped.records;
  payload = { ...payload, records: candidates };
  await emitTelemetry(telemetry, {
    kind: "retrieval-hit",
    observationPhase: "stop",
    observationSource: retrievalSource,
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
    reason: budgetExceeded ? "INJECTION_BUDGET_EXCEEDED" : candidates.length === 0 && boundContext !== null ? scoped.reasonCode : "INJECTION_PRODUCED",
    reasonCode: budgetExceeded ? "INJECTION_BUDGET_EXCEEDED" : candidates.length === 0 && boundContext !== null ? scoped.reasonCode : "INJECTION_PRODUCED",
    ...(budgetExceeded ? { reasonCode: "INJECTION_BUDGET_EXCEEDED", warning: { reasonCode: "INJECTION_BUDGET_EXCEEDED", actualBytes: injectedBytes, budget: effectiveBudget } } : {}),
    queryTokens: tokens,
    candidateCount: candidates.length,
    excludedCandidateCount: scoped.excluded,
    candidates,
    injectedBytes,
    truncated: false,
    budgetExceeded,
    budget: effectiveBudget,
    queryLanguage: payload.queryLanguage ?? null,
    queryTranslation: owed,
    translatedQuery,
    telemetry: { queryTranslations, ...(translationFailure === null ? {} : { translationFailure }) },
    ...(boundContext === null ? {} : { dispatchContext: boundContext }),
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

// STORY-387: SessionStart and Stop are bounded production opportunities to close the
// previous UTC day. The collector seals actual channel records; no empty file or
// missing host input is converted into zero activity.
async function sessionObservationCoverage(event, partition, containerRoot, suppliedState = null) {
  if (event !== "SessionStart" && event !== "Stop") return null;
  const core = await languageModule();
  if (typeof core?.activeBinding !== "function") return null;
  try {
    const state = suppliedState ?? await workspaceStateForInjection(partition, containerRoot);
    const root = state?.metadata === undefined ? null : core.activeBinding(state.metadata).find((entry) => entry.kind === "transient")?.path ?? null;
    return root === null ? null : await sealObservationDay(root);
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

async function economyModelForHost(settings, host) {
  const core = await languageModule();
  if (typeof core?.readDispatchConfig !== "function") return null;
  try {
    const views = (settings ?? []).map((entry) => ({
      key: entry.key,
      value: entry.currentValue ?? entry.value ?? entry.defaultValue ?? "",
    }));
    const model = core.readDispatchConfig(views).tiers[dispatchHostName(host)]?.economy?.model;
    return typeof model === "string" && model.length > 0 ? model : null;
  } catch {
    return null;
  }
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
  searchScope = null,
  dispatchContext = null,
  context = null,
  role = undefined,
  workId = undefined,
  pack = undefined,
  dependencies = undefined,
  dispatchId = undefined,
  parentSession = undefined,
  enforceBinding = false,
  deliveryMode = "immediate",
  retryPending = false,
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
  let contextFailure = false;
  const explicitBinding = dispatchContext ?? context ?? {
    ...hookInput,
    ...(role === undefined ? {} : { role }),
    ...(workId === undefined ? {} : { workId }),
    ...(pack === undefined ? {} : { pack }),
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(dispatchId === undefined ? {} : { dispatchId }),
    ...(parentSession === undefined ? {} : { parentSession }),
  };
  const bindingRequested = enforceBinding || hasChildAgentMarker(hookInput) || dispatchContext !== null || context !== null || role !== undefined || workId !== undefined || pack !== undefined || dependencies !== undefined || dispatchId !== undefined || parentSession !== undefined || event === "SubagentStart";
  const dispatch = normalizeDispatchContext(explicitBinding, { requireBinding: bindingRequested });
  const pendingMode = deliveryMode === "pending";
  try {
    const effectiveSettings = settings ?? await configuredSettingRecords(partition, containerRoot);
    const economyModel = await economyModelForHost(effectiveSettings, host);
    const telemetry = await telemetryWriter(partition, containerRoot, sessionId, workspaceState);
    const observationBoundary = event === "SessionStart" ? await recordObservationBoundary({ partition, containerRoot, sessionId, host, workspaceState, phase: "start" }) : null;
    observationCoverage = await sessionObservationCoverage(event, partition, containerRoot, workspaceState);
    retirementSweep = await sessionRetirementSweep(event, partition, containerRoot);
    // A malformed or unbound hook payload receives a stable refusal and no
    // context/model work.  Direct library callers with no hook payload retain
    // the legacy main-session behaviour for compatibility.
    if (dispatch.ok !== true) {
      decisionReason = dispatch.reasonCode;
    }
    const subagent = dispatch.ok === true && dispatch.bound === true && dispatch.role === "subagent";
    const auxiliaryModelsAllowed = !subagent;
    calls = auxiliaryModelsAllowed ? await productionModelCalls({
      host,
      model: economyModel,
      translate,
      judgeEnabled,
      judge,
    }) : { translate: null, judge: null, cleanup: () => {} };
    const effectiveBudget = Number.isSafeInteger(budget) && budget > 0 ? budget : await configuredInjectionBudget(partition, containerRoot);
    const effectivePerPrompt = Number.isSafeInteger(perPromptBytes) && perPromptBytes > 0 ? perPromptBytes : await configuredPerPromptBytes(partition, containerRoot);
    const shouldReadL0 = dispatch.ok === true && (event === "SessionStart" || event === "PostCompact" || event === "UserPromptSubmit" || event === "SubagentStart");
    if (shouldReadL0) {
      const state = workspaceState ?? await workspaceStateForInjection(partition, containerRoot);
      if (state !== null) {
        l0 = dispatch.bound === true ? buildBoundedTaskContext(state, dispatch, { maxLines: 6, maxBytes: effectivePerPrompt }) : buildL0Injection(state);
        if (l0.ok === false) {
          contextFailure = true;
          decisionReason = l0.reasonCode;
        }
        const changed = l0.text !== lease.session.lastL0;
        const allowSubagentL0 = subagent && event === "SubagentStart";
        const retryPendingL0 = retryPending && lease.session.pendingIds.some((id) => l0.ids.includes(id));
        if (event === "SessionStart" || event === "PostCompact" || changed || allowSubagentL0 || retryPendingL0) {
          if (l0.text.length > 0) parts.push(l0.text);
          emittedIds.push(...l0.ids);
          lease.session.lastL0 = l0.text;
          lease.session.lastL0Ids = l0.ids;
          decisionReason = event === "SubagentStart" ? "SUBAGENT_TASK_CONTEXT" : event === "PostCompact" ? "POST_COMPACT_L0" : changed ? "L0_CHANGED" : "SESSION_START_L0";
        }
      }
    }

    if (dispatch.ok === true && event === "PostToolUse") {
      const referenceSource = "knowledge-inject:reference";
      await emitTelemetry(telemetry, { kind: "reference", observationPhase: "start", observationSource: referenceSource, payload: { stage: "start" } });
      const correlation = pullCorrelation(hookInput, lease.session.emittedIds, lease.session.pulledIds);
      if (correlation !== null) {
        lease.session.pulledIds.push(correlation.id);
        lease.session.pullCorrelations.push({ ...correlation, at: new Date().toISOString() });
        await emitTelemetry(telemetry, { kind: "pull", observationPhase: "stop", observationSource: referenceSource, payload: { id: correlation.id, verb: correlation.verb } });
        decisionReason = "PULL_RECORDED";
      } else {
        await emitTelemetry(telemetry, { kind: "reference", observationPhase: "stop", observationSource: referenceSource, payload: { stage: "stop" } });
        decisionReason = "PULL_IGNORED";
      }
    } else if (dispatch.ok === true && event === "SubagentStop") {
      decisionReason = "SUBAGENT_STOP_NO_INJECTION";
    } else if (dispatch.ok === true && !contextFailure && event === "UserPromptSubmit") {
      if (lease.session.l1Bytes >= effectiveBudget) {
        decisionReason = parts.length > 0 ? "BUDGET_SATURATED_L0_ONLY" : "BUDGET_SATURATED";
      } else {
        await emitTelemetry(telemetry, { kind: "trigger", observationPhase: "start", observationSource: "knowledge-inject:trigger", payload: { event: "UserPromptSubmit", stage: "start" } });
        try {
          recallResult = await runInjection({
            prompt,
            partition,
            budget: effectiveBudget,
            limit,
            containerRoot,
            settings: effectiveSettings,
            translate: subagent ? null : calls.translate,
            recall,
            searchScope,
            telemetry,
            host,
            dispatchContext: dispatch.bound === true ? dispatch : null,
          });
        } finally {
          await emitTelemetry(telemetry, { kind: "trigger", observationPhase: "stop", observationSource: "knowledge-inject:trigger", payload: { event: "UserPromptSubmit", stage: "stop" } });
        }
        const dedupeIds = [
          ...lease.session.emittedIds,
          ...(retryPending ? [] : lease.session.pendingIds),
        ];
        const fresh = deduplicateCandidates(recallResult.candidates, dedupeIds);
        const allowance = Math.min(effectivePerPrompt, effectiveBudget - lease.session.l1Bytes);
        const candidateContext = buildBoundedCandidateContext(fresh, { maxBytes: allowance });
        if (candidateContext.text.length > 0) {
          parts.push(candidateContext.text);
          emittedIds.push(...candidateContext.ids);
          if (!pendingMode) lease.session.l1Bytes += candidateContext.bytes;
          decisionReason = "INJECTION_EMITTED";
        } else if (recallResult.candidates.length > 0) {
          decisionReason = "ALREADY_INJECTED_SKIPPED";
        } else if (recallResult.ok !== true) {
          decisionReason = recallResult.reasonCode ?? "RECALL_FAILED";
        } else {
          decisionReason = recallResult.reason ?? "NO_CANDIDATES";
        }
        if (!subagent && judgeEnabled && calls.judge !== null) {
          let judgement;
          try {
            judgement = await calls.judge(prompt, fresh, recallResult);
          } catch (error) {
            judgement = { judgment: null, reasonCode: "UNINJECTED_MODEL_FAILED", error: String(error?.message ?? error) };
          }
          const judgment = typeof judgement === "boolean" ? judgement : judgement?.judgment;
          lease.session.judgments.push({
            prompt: promptDigest(prompt),
            candidateIds: fresh.map(recordIdentity).filter(Boolean),
            judgment: typeof judgment === "boolean" ? judgment : null,
            model: judgement?.model ?? economyModel,
            ...(judgement?.reasonCode ? { reasonCode: judgement.reasonCode } : {}),
            at: new Date().toISOString(),
          });
          await emitTelemetry(telemetry, {
            kind: "judge",
            payload: {
              candidateCount: fresh.length,
              judgment: typeof judgment === "boolean" ? judgment : null,
              model: judgement?.model ?? economyModel,
              ...(judgement?.reasonCode ? { reasonCode: judgement.reasonCode } : {}),
            },
          });
        }
        if (recallResult.telemetry?.queryTranslations > 0 || recallResult.translatedQuery !== null || recallResult.telemetry?.translationFailure) lease.session.translationAttempts += 1;
      }
    }

    const injection = parts.join("\n");
    const injectedBytes = Buffer.byteLength(injection, "utf8");
    const uniqueInjectedIds = [...new Set(emittedIds.filter((id) => typeof id === "string"))];
    const deliveryState = pendingMode && uniqueInjectedIds.length > 0 ? "pending" : "acknowledged";
    if (deliveryState === "pending") {
      for (const id of uniqueInjectedIds) {
        if (!lease.session.pendingIds.includes(id) && !lease.session.emittedIds.includes(id)) lease.session.pendingIds.push(id);
      }
    } else {
      lease.session.emittedBytes += injectedBytes;
      for (const id of uniqueInjectedIds) {
        lease.session.pendingIds = lease.session.pendingIds.filter((pending) => pending !== id);
        if (!lease.session.emittedIds.includes(id)) lease.session.emittedIds.push(id);
      }
    }
    if (pendingMode) lease.session.deliveryAttempts += 1;
    lease.session.decisions.push({
      prompt: promptDigest(prompt),
      event,
      reason: decisionReason,
      ...(recallResult.telemetry?.translationFailure ? { translationFailure: recallResult.telemetry.translationFailure } : {}),
      injectedIds: uniqueInjectedIds,
      injectedBytes,
      cumulativeBytes: lease.session.emittedBytes,
      cumulativeL1Bytes: lease.session.l1Bytes,
      delivery: { mode: pendingMode ? "pending" : "immediate", state: deliveryState, attempt: lease.session.deliveryAttempts },
      ...(dispatch.bound === true ? { dispatch: { role: dispatch.role, workId: dispatch.workId, pack: dispatch.pack } } : {}),
      at: new Date().toISOString(),
      elapsedMs: Date.now() - started,
    });
    lease.commit();
    return {
      ...recallResult,
      ok: dispatch.ok !== true || contextFailure ? false : recallResult.ok !== false,
      ...(dispatch.ok !== true ? { reasonCode: dispatch.reasonCode } : contextFailure ? { reasonCode: l0?.reasonCode } : {}),
      injected: injection.length > 0,
      injection: injection.length > 0 ? injection : null,
      injectedBytes,
      cumulativeBytes: lease.session.emittedBytes,
      cumulativeL1Bytes: lease.session.l1Bytes,
      decision: decisionReason,
      l0,
      delivery: { mode: pendingMode ? "pending" : "immediate", state: deliveryState, ids: uniqueInjectedIds, attempt: lease.session.deliveryAttempts },
      ...(dispatch.bound === true || dispatch.ok !== true ? { dispatchContext: dispatch } : {}),
      sessionId,
      ...(observationCoverage === null ? {} : { observationCoverage }),
      ...(observationBoundary === null ? {} : { observationBoundary }),
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

export function parseArgv(argv) {
  const flags = parseFlags(argv);
  let hookInput = {};
  if (typeof flags["hook-input"] === "string") {
    try { hookInput = JSON.parse(flags["hook-input"]); } catch { hookInput = {}; }
  }
  let context = null;
  if (typeof flags.context === "string") {
    try { context = JSON.parse(flags.context); } catch { context = { role: "invalid-context" }; }
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
    context,
    judgeEnabled: parseBooleanFlag(flags["judge-enabled"]) !== false,
    host: typeof flags.host === "string" ? flags.host : (process.env.TCRN_HOST ?? "claude"),
    selfTest: flags["self-test"] === true,
    verifyChannel: flags["verify-channel"] === true,
    observationBoundary: typeof flags["observation-boundary"] === "string" ? flags["observation-boundary"] : null,
    at: typeof flags.at === "string" ? flags.at : undefined,
    containerRoot: typeof flags["container-root"] === "string" ? flags["container-root"] : PLATFORM_ROOT,
    role: typeof flags.role === "string" ? flags.role : undefined,
    workId: typeof flags["work-id"] === "string" ? flags["work-id"] : undefined,
    pack: typeof flags.pack === "string" ? flags.pack : undefined,
    dispatchId: typeof flags["dispatch-id"] === "string" ? flags["dispatch-id"] : undefined,
    parentSession: typeof flags["parent-session"] === "string" ? flags["parent-session"] : undefined,
    enforceBinding: parseBooleanFlag(flags["enforce-binding"]) === true,
    deliveryMode: flags["delivery-mode"] === "pending" ? "pending" : "immediate",
    retryPending: parseBooleanFlag(flags["retry-pending"]) === true,
  };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const options = parseArgv(process.argv.slice(2));
  const out = (value) => {
    const serialized = serializeInjectionProtocol(value);
    process.stdout.write(`${serialized.text}\n`);
    return serialized;
  };
  try {
    if (options.observationBoundary !== null) {
      out(await recordObservationBoundary({ partition: options.partition, containerRoot: options.containerRoot, sessionId: options.sessionId ?? "anonymous", host: options.host, phase: options.observationBoundary, at: options.at }));
    } else if (options.verifyChannel) {
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
      const result = options.sessionId === null
        ? await runInjection(options)
        : await runSessionInjection(options);
      out(result);
      if (result?.ok === false) process.exitCode = 1;
    }
  } catch (error) {
    out({ ok: false, reasonCode: error?.reasonCode ?? "INJECT_PROCESS_FAILED", error: String(error?.message ?? error) });
    process.exitCode = 1;
  }
}
