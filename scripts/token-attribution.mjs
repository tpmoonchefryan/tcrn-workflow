#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// S11 (TCRN-CROSS-STORY-151) — host session JSONL token parser.
//
// Reads Claude Code session transcripts (JSONL under ~/.claude/projects) and
// extracts token usage per session and per model. Gaps are reported honestly —
// unparseable lines, lines with usage but no model, usage objects missing a
// token field — never silently capped. The parser only READS host transcripts;
// it never writes under ~/.claude.
//
//   node scripts/token-attribution.mjs --file <session.jsonl>
//   node scripts/token-attribution.mjs --dir <projects-dir> [--match <substr>]
//
// Exit 0 measured · 2 could-not-judge. Exit 1 is not emitted by this tool: there is
// no "I read it and the answer is bad" verdict for a meter, only "I measured" and
// "I could not". The three refusal codes below are kept distinct on purpose, so a
// caller can tell a mis-aimed probe from an empty one.
//
// R2 — the contract on this line used to be prose the bytes did not honour. It read
// "Exit 0 parsed · 1 no sessions / unreadable input", and all three of the ways this
// tool can measure nothing exited 0 with ok:true and a zero total (measured):
//
//   --dir at a directory holding no .jsonl   → ok:true, sessions 0, totals 0
//   --match that selected no session         → ok:true, sessions 0, totals 0
//   --file at a path that does not exist     → ok:true, sessions 1, totals 0
//
// S11's report is an input to delivery-cadence decisions, so a moved directory or a
// mistyped --match handed the caller "this Initiative cost 0 tokens" as a SUCCESS.
// Measuring nothing is could-not-judge, never success. A zero that really was
// measured — sessions read, no usage line in them — is reported as NO_USAGE_OBSERVED
// rather than as a total, because those two are different facts.
//
// One write, one exit: the report is emitted at the bottom through a single
// process.stdout.write and the status is set with process.exitCode. Calling
// process.exit() right after a write truncates a large report at the pipe buffer —
// the sibling defect measured in verify-otel-privacy.mjs, where 97,042 bytes written
// arrived as 65,536 bytes of invalid JSON.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// --match is a whole-session selector applied in --dir mode below, never a
// within-session filter: S11 recorded the sampling caliber as "a single session is
// not split by inside/outside the Initiative". Filtering lines by the substring
// would silently narrow a session's totals to whichever messages happen to spell
// the key, so parseSession deliberately reads every line of the file it is given.
function parseSession(path) {
  const session = {
    file: basename(path),
    lines: 0,
    usageLines: 0,
    unparseableLines: 0,
    missingUsageLines: 0,
    missingModelLines: 0,
    incompleteUsage: 0,
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    byModel: {},
    firstTs: null,
    lastTs: null,
  };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { ...session, error: String(error.message) };
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    session.lines += 1;
    let object;
    try {
      object = JSON.parse(line);
    } catch {
      session.unparseableLines += 1;
      continue;
    }
    const usage = object?.message?.usage;
    if (!usage) {
      session.missingUsageLines += 1;
      continue;
    }
    session.usageLines += 1;
    const model = typeof object.message?.model === "string" ? object.message.model : null;
    if (!model) {
      session.missingModelLines += 1;
    }
    // An honest gap, not a silent cap: if a usage object omits a token field we
    // record it and add what IS present, rather than pretending it was zero.
    let complete = true;
    let input = 0;
    let output = 0;
    let cacheCreation = 0;
    let cacheRead = 0;
    for (const field of TOKEN_FIELDS) {
      const value = usage[field];
      if (!Number.isFinite(value)) {
        complete = false;
        continue;
      }
      if (field === "input_tokens") input = value;
      else if (field === "output_tokens") output = value;
      else if (field === "cache_creation_input_tokens") cacheCreation = value;
      else if (field === "cache_read_input_tokens") cacheRead = value;
    }
    if (!complete) session.incompleteUsage += 1;
    session.tokens.input += input;
    session.tokens.output += output;
    session.tokens.cacheCreation += cacheCreation;
    session.tokens.cacheRead += cacheRead;
    if (model !== null) {
      const row = session.byModel[model] ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, messages: 0 };
      row.input += input;
      row.output += output;
      row.cacheCreation += cacheCreation;
      row.cacheRead += cacheRead;
      row.messages += 1;
      session.byModel[model] = row;
    }
    const ts = object.timestamp ?? object.ts ?? null;
    if (typeof ts === "string") {
      if (session.firstTs === null || ts < session.firstTs) session.firstTs = ts;
      if (session.lastTs === null || ts > session.lastTs) session.lastTs = ts;
    }
  }
  return session;
}

const match = argument("match") ?? null;
const file = argument("file");
const dir = argument("dir");

// Asked separately from its value: `--file` with nothing after it, and `--file ""`,
// are a mis-typed invocation, not a request to read the current directory instead.
// Falling through to the other input on an empty value is how a probe ends up
// answering a question nobody asked — the PRIVACY_SINK_NOT_SPECIFIED lesson from
// verify-otel-privacy.mjs, applied to the same defect class here.
function flagPresent(name) {
  return process.argv.includes(`--${name}`);
}

function couldNotJudge(reasonCode, extra = {}) {
  return { ok: false, verdict: "could-not-judge", reasonCode, ...extra };
}

// Returns either { sessions } or { refusal }. It never exits and never writes: this
// file has exactly one write and one exit, both at the bottom.
function selectSessions() {
  if (flagPresent("file")) {
    if (file === undefined || file.trim() === "") {
      return { refusal: couldNotJudge("INPUT_EMPTY", { detail: "--file needs a path to a session JSONL" }) };
    }
    return { sessions: [parseSession(resolve(file))] };
  }
  if (flagPresent("dir")) {
    if (dir === undefined || dir.trim() === "") {
      return { refusal: couldNotJudge("INPUT_EMPTY", { detail: "--dir needs a path to a projects directory" }) };
    }
    const root = resolve(dir);
    let entries;
    try {
      entries = readdirSync(root).filter((entry) => entry.endsWith(".jsonl"));
    } catch (error) {
      return { refusal: couldNotJudge("SESSIONS_DIR_UNREADABLE", { dir: root, detail: String(error.message) }) };
    }
    const selected = entries
      .map((entry) => join(root, entry))
      .filter((path) => {
        if (!match) return true;
        try {
          return readFileSync(path, "utf8").includes(match);
        } catch {
          // Unreadable during selection is a gap, not a non-match. Dropping it here
          // silently shrank the sample and left no trace of the shrinking; keeping it
          // lets parseSession record the error where the report can show it.
          return true;
        }
      });
    return { sessions: selected.map((path) => parseSession(path)), scanned: entries.length };
  }
  return { refusal: couldNotJudge("NO_INPUT", { detail: "pass --file <jsonl> or --dir <projects-dir>" }) };
}

function summarize(sessions) {
  const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, messages: 0, sessions: sessions.length, gaps: {} };
  const byModel = {};
  let unreadableSessions = 0;
  for (const session of sessions) {
    if (session.error !== undefined) unreadableSessions += 1;
    totals.input += session.tokens.input;
    totals.output += session.tokens.output;
    totals.cacheCreation += session.tokens.cacheCreation;
    totals.cacheRead += session.tokens.cacheRead;
    totals.gaps.unparseable = (totals.gaps.unparseable ?? 0) + session.unparseableLines;
    totals.gaps.missingUsage = (totals.gaps.missingUsage ?? 0) + session.missingUsageLines;
    totals.gaps.missingModel = (totals.gaps.missingModel ?? 0) + session.missingModelLines;
    totals.gaps.incompleteUsage = (totals.gaps.incompleteUsage ?? 0) + session.incompleteUsage;
    totals.messages += session.usageLines;
    for (const [model, row] of Object.entries(session.byModel)) {
      const agg = byModel[model] ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, messages: 0 };
      agg.input += row.input;
      agg.output += row.output;
      agg.cacheCreation += row.cacheCreation;
      agg.cacheRead += row.cacheRead;
      agg.messages += row.messages;
      byModel[model] = agg;
    }
  }
  // Promoted out of the per-session rows: a caller reading only `totals` could
  // otherwise see four zero gaps and no hint that every session failed to open.
  totals.gaps.unreadableSessions = unreadableSessions;
  const body = { totals, byModel, sessions };
  // Three ways to end up with nothing, kept as three reason codes. Collapsing them
  // would leave the caller unable to tell "the directory moved" from "the --match is
  // wrong" from "these sessions really are empty" — and a probe whose every failure
  // reports the same code is a probe that stopped answering the question.
  if (sessions.length === 0) {
    return {
      ...couldNotJudge("NO_SESSIONS_SELECTED", {
        detail: match ? "no session file contained the --match substring" : "no .jsonl session file under that directory",
      }),
      ...body,
    };
  }
  if (unreadableSessions === sessions.length) {
    return { ...couldNotJudge("SESSIONS_ALL_UNREADABLE", { detail: "every selected session failed to open" }), ...body };
  }
  if (totals.messages === 0) {
    return {
      ...couldNotJudge("NO_USAGE_OBSERVED", { detail: "sessions were read but carried no usage line" }),
      ...body,
    };
  }
  return { ok: true, verdict: "measured", reasonCode: "TOKEN_ATTRIBUTION_READY", ...body };
}

const selection = selectSessions();
const report = selection.refusal ?? summarize(selection.sessions);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 2;
