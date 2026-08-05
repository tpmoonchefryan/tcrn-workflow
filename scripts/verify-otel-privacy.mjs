#!/usr/bin/env node
// S10 (TCRN-CROSS-STORY-150) — privacy self-check for the OTel span sinks.
//
// Reads a JSONL span sink and asserts every record carries only the allowed label
// keys — the S10 privacy contract ("sink 无链内容"). A record the contract does not
// permit — any other key (payload, argv, chain bytes, …), or a line that is not a
// JSON object at all — is a violation and this exits 1.
//
//   node scripts/verify-otel-privacy.mjs --sink <path> [--kind ceremony|verb]
//
// Exit 0 clean · 1 privacy violation · 2 could-not-judge.
//
// The three exit codes are three different answers and must stay distinguishable:
// "I looked and the sink is clean", "I looked and the sink leaks", and "I could not
// look at all". A could-not-judge is NEVER a pass — a guard that cannot read its
// subject must say so rather than crash or, worse, exit 0.
//
// R2 — two ways this guard broke its own contract, both measured before the fix:
//
//   1. A line that is valid JSON but not an object crashed or lied. `null` reached
//      Object.keys() outside any try and died with a bare TypeError, whose exit code
//      is 1 — so the guard reported a privacy violation it had never observed. `42`
//      was worse: Object.keys(42) is [], so an unaccounted record came back CLEAN at
//      exit 0. Both are gone because the classifier below is total over everything
//      JSON.parse can return; no input reaches an unguarded property access.
//   2. The verdict was truncated at the pipe buffer. process.stdout.write() on a
//      pipe is asynchronous on POSIX and the process.exit() that followed discarded
//      whatever was still buffered: a 450-violation report measured 97,042 bytes
//      written against 65,536 bytes received, i.e. invalid JSON delivered to the
//      consumer exactly when the report mattered most.
//
// Where each input lands, and why:
//
//   blank / whitespace-only line          not a record — JSONL framing, counted
//                                         separately as blankLines. A sink that holds
//                                         nothing else is exit 2 (PRIVACY_SINK_EMPTY),
//                                         never a clean pass: zero records judged is
//                                         not evidence of a clean emitter.
//   line that is not JSON                 exit 1: the bytes are in the sink and
//                                         nothing bounds them. The key allowlist is
//                                         what makes a line safe and it cannot vouch
//                                         for these. (A sink torn mid-write reports
//                                         here too — deliberately, fail-closed.)
//   JSON null/number/string/bool/array    exit 1: same reason. The allowlist is
//                                         inapplicable to a non-object, so the
//                                         record's content is unaccounted for.
//   JSON object with an off-list key      exit 1: the original leak.
//   JSON object, keys ⊆ allowlist         exit 0.
//
// Exit 2 stays reserved for whole-sink conditions — the guard could not read its
// subject at all. A per-line problem is never escalated to 2: that would throw away
// the per-line evidence for every other line in the file, and it would claim "I did
// not look" about a file that was read end to end.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const KIND_KEYS = {
  ceremony: ["span", "at", "partition", "verb", "expectedVersion", "outcome", "reasonCode"],
  verb: ["span", "at", "verb", "outcome", "reasonCode"],
};

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const REFUSAL_FIELD_LIMIT = 256;

// Every string a refusal carries comes from argv or from an OS error message, so its
// length is chosen by the caller and not by this file. That made the refusal path
// truncatable too: an 80 KiB --sink value produced an 80 KiB refusal that the
// process.exit(2) below cut off at the pipe buffer — measured at 65,536 bytes of
// invalid JSON. Clamping holds a refusal under a kilobyte, and that bound is what
// makes exiting immediately safe here: a payload that small is handed to an empty
// pipe in a single synchronous try-write, so nothing is left buffered to discard.
// The full report has no such bound, which is why it never calls process.exit at
// all. The only non-string field any caller passes is an internal constant.
function clampField(value) {
  if (typeof value !== "string" || value.length <= REFUSAL_FIELD_LIMIT) return value;
  return `${value.slice(0, REFUSAL_FIELD_LIMIT)} [+${value.length - REFUSAL_FIELD_LIMIT} chars]`;
}

// Refuse with a reason code and exit 2. Never exit 0 from here: the sink was not
// read, so "clean" was never established.
function couldNotJudge(reasonCode, extra = {}) {
  const bounded = Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, clampField(value)]));
  process.stdout.write(`${JSON.stringify({ ok: false, verdict: "could-not-judge", reasonCode, ...bounded })}\n`);
  process.exit(2);
}

// Total over everything JSON.parse can hand back — object, array, string, number,
// boolean, null — and nothing else exists on that side. Totality is the point: it is
// what lets the loop below classify every record without ever asking a value a
// question it cannot answer, so the loop cannot throw by construction rather than by
// a catch net wrapped around it. A net would also swallow the crash the F4 red proof
// depends on; this does not.
function jsonShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const sinkArgument = argument("sink");
const kind = argument("kind") ?? "ceremony";
const allowed = KIND_KEYS[kind];
if (!allowed) {
  couldNotJudge("PRIVACY_UNKNOWN_KIND", { kind, supported: Object.keys(KIND_KEYS) });
}
// --sink must be asked for BEFORE resolving it. resolve("") returns the current
// working directory — a directory that exists — so an absent --sink used to walk
// straight past an existsSync() guard and die on EISDIR inside readFileSync.
if (sinkArgument === undefined || sinkArgument.trim() === "") {
  couldNotJudge("PRIVACY_SINK_NOT_SPECIFIED", { detail: "pass --sink <path to the span JSONL sink>" });
}
const sink = resolve(sinkArgument);
let stats;
try {
  stats = statSync(sink);
} catch (error) {
  couldNotJudge("PRIVACY_SINK_MISSING", { sink, detail: String(error.message) });
}
if (!stats?.isFile()) {
  couldNotJudge("PRIVACY_SINK_NOT_A_FILE", {
    sink,
    detail: stats?.isDirectory() ? "path is a directory, not a span sink" : "path is not a regular file",
  });
}

let text;
try {
  text = readFileSync(sink, "utf8");
} catch (error) {
  couldNotJudge("PRIVACY_SINK_UNREADABLE", { sink, detail: String(error.message) });
}

// The element after the final newline is JSONL's line terminator, not a blank line.
// Dropping it keeps blankLines honest — an empty file has zero of everything rather
// than one phantom blank — and an inaccurate counter is exactly the kind of number
// that later gets promoted into a predicate and lies there.
const lines = text.split("\n");
if (lines[lines.length - 1] === "") lines.pop();

const violations = [];
let records = 0;
let blankLines = 0;
for (const line of lines) {
  if (line.trim() === "") {
    blankLines += 1;
    continue;
  }
  // Every non-blank line is counted as a record from here on, whatever it turns out
  // to be — including one that fails to parse, which the pre-R2 loop left out of the
  // count. That is what makes `records === cleanRecords + violations.length` an
  // invariant a reader can check, and a line that vanished silently impossible to
  // hide behind a plausible-looking total.
  records += 1;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    violations.push({ line: line.slice(0, 120), why: "not-json" });
    continue;
  }
  const shape = jsonShape(value);
  if (shape !== "object") {
    violations.push({ line: line.slice(0, 120), why: "not-an-object", jsonType: shape });
    continue;
  }
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) violations.push({ line: line.slice(0, 120), why: "disallowed-keys", extra });
}

// A verdict computed over zero records establishes nothing about the emitter, so it
// must not be dressed up as PRIVACY_SINK_CLEAN. Point this at the wrong path and hit
// an empty file and the pre-R2 guard said "clean" — the same defect class as the
// token-attribution report that returned "cost 0 tokens, ok:true" when its --match
// selected nothing. Reading an empty file gives the guard no subject to judge, which
// is what exit 2 is for.
if (records === 0) {
  couldNotJudge("PRIVACY_SINK_EMPTY", {
    sink,
    kind,
    blankLines,
    detail: "the sink carries no records — nothing was observed, so nothing is established",
  });
}

const report = {
  ok: violations.length === 0,
  verdict: violations.length === 0 ? "clean" : "violation",
  reasonCode: violations.length === 0 ? "PRIVACY_SINK_CLEAN" : "PRIVACY_SINK_VIOLATION",
  sink,
  kind,
  records,
  cleanRecords: records - violations.length,
  blankLines,
  violations,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
// Deliberately not process.exit(): on a pipe that discarded 31,506 bytes of a
// 97,042-byte report. Setting exitCode lets Node drain stdout and leave with the
// same status, so the consumer gets whole JSON at any report size.
process.exitCode = report.ok ? 0 : 1;
