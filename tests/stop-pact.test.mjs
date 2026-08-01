// SPDX-License-Identifier: Apache-2.0
// stop-pact: the host-level stop gate (TCRN-CROSS-INIT-016).
//
// EPIC-038 in one file: the decider judged in every world it will be evaluated in
// (S117), red proofs in both directions plus an anti-tautology sweep (S121), and
// parallel-session isolation and expiry proven against the real verdict (S122). Plus
// the mode dial (D2), the pact lifecycle (S116), and a subprocess exercise of the hook
// wire protocol (S123) so the exit/stdout contract is covered end to end.
//
// The organizing worry, stated once: this gate's predicate turns on worlds this
// process is never standing in — another session, an expired contract, a model that
// is not the one running now, a transcript that cannot be read. So the decider takes
// every world as an argument and the suite drives all of them. The 2026-08-01
// adversarial review found a family of "fail toward blocking on missing info" defects;
// the tests below now pin the corrected direction (fail toward allow) in each.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { decide, blockMessage, DECISION_CODES, STOP_TICKET_CLASSES } from "../tools/stop-pact/decide.mjs";
import {
  buildPact, migratePact, withRuntime, isWellFormedPact, readPact, writePact,
  PACT_SCHEMA_VERSION, MAX_SCOPE_BYTES,
} from "../tools/stop-pact/pact.mjs";
import { resolveMode, resolveModelFromTranscript, toolUseCount, workedSinceLastBlock } from "../tools/stop-pact/mode.mjs";
import { osascriptArgs } from "../tools/stop-pact/notify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "tools", "stop-pact", "hook.mjs");
const CLI = join(HERE, "..", "tools", "stop-pact", "cli.mjs");

const NOW = "2026-08-01T12:00:00Z";
function runningPact(overrides = {}) {
  return {
    schemaVersion: PACT_SCHEMA_VERSION,
    active: true,
    status: "running",
    scope: "build the thing",
    authorizedBy: "owner",
    boundSession: "A",
    maxConsecutiveBlocks: 3,
    createdAt: "2026-08-01T00:00:00Z",
    expiresAt: "2026-08-02T00:00:00Z",
    ticket: null,
    runtime: { consecutiveBlocks: 0, lastBlockToolUses: null },
    history: [],
    ...overrides,
  };
}

function callDecide(overrides = {}) {
  return decide({
    pact: runningPact(),
    now: NOW,
    sessionId: "A",
    stopHookActive: false,
    mode: "enforce",
    workedSinceLastBlock: false,
    consecutiveBlocks: 0,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// S117 — the decider, every world
// ---------------------------------------------------------------------------

test("no pact, or an inactive pact, always allows", () => {
  assert.equal(callDecide({ pact: null }).code, "NO_ACTIVE_PACT");
  assert.equal(callDecide({ pact: runningPact({ active: false }) }).code, "NO_ACTIVE_PACT");
});

test("a pact bound to another session allows without disturbing its counter", () => {
  const verdict = callDecide({ sessionId: "B", consecutiveBlocks: 2 });
  assert.equal(verdict.action, "allow");
  assert.equal(verdict.code, "OTHER_SESSION");
  assert.equal(verdict.effects.bindSession, null);
});

test("an expired pact allows and asks to be deactivated", () => {
  const verdict = callDecide({ now: "2026-08-03T00:00:00Z" });
  assert.equal(verdict.code, "PACT_EXPIRED");
  assert.equal(verdict.effects.deactivate, true);
});

test("an unparseable expiresAt fails toward NOT expired, never silently lifting a live pact", () => {
  const verdict = callDecide({ pact: runningPact({ expiresAt: "not-a-date" }), mode: "enforce", workedSinceLastBlock: true });
  assert.notEqual(verdict.code, "PACT_EXPIRED");
  assert.equal(verdict.action, "block");
});

test("a migrated status is a legitimate stop", () => {
  assert.equal(callDecide({ pact: runningPact({ status: "completed" }) }).code, "STATUS_COMPLETED");
  assert.equal(callDecide({ pact: runningPact({ status: "blocked", ticket: { class: "hard_blockage" } }) }).code, "STATUS_BLOCKED");
  assert.equal(callDecide({ pact: runningPact({ status: "owner_directive" }) }).code, "STATUS_OWNER_DIRECTIVE");
});

test("an unrecognized status fails OPEN and shouts, never trapping the session", () => {
  const verdict = callDecide({ pact: runningPact({ status: "runing" }) });
  assert.equal(verdict.action, "allow");
  assert.equal(verdict.code, "STATUS_UNKNOWN");
  assert.equal(verdict.notify.level, "loud");
});

test("observe mode surfaces a premature stop but never blocks it (the flagship dial)", () => {
  const verdict = callDecide({ mode: "observe", workedSinceLastBlock: false, consecutiveBlocks: 5 });
  assert.equal(verdict.action, "allow");
  assert.equal(verdict.code, "OBSERVE_WOULD_BLOCK");
});

test("enforce + running + fresh work blocks and starts the streak at 1", () => {
  const verdict = callDecide({ mode: "enforce", workedSinceLastBlock: true, consecutiveBlocks: 0 });
  assert.equal(verdict.action, "block");
  assert.equal(verdict.effects.setConsecutiveBlocks, 1);
  assert.equal(verdict.effects.recordBlockOffset, true);
});

test("enforce + no progress climbs to the cap, then RELEASES (the valve is not starved)", () => {
  assert.equal(callDecide({ mode: "enforce", workedSinceLastBlock: false, consecutiveBlocks: 2 }).effects.setConsecutiveBlocks, 3);
  const atCap = callDecide({ mode: "enforce", workedSinceLastBlock: false, consecutiveBlocks: 3 });
  assert.equal(atCap.code, "ESCALATION_RELEASE");
  assert.equal(atCap.effects.setConsecutiveBlocks, 0);
});

test("a non-integer stored counter fails toward RELEASE, never toward an ever-growing string", () => {
  // Review finding: "x">=cap is false and "x"+1 concatenates, trapping forever. The
  // decider coerces a bad counter to the cap so it releases instead.
  const verdict = callDecide({ mode: "enforce", workedSinceLastBlock: false, consecutiveBlocks: "x" });
  assert.equal(verdict.code, "ESCALATION_RELEASE");
});

test("productive work resets the streak — a busy run is never escalated to release", () => {
  const verdict = callDecide({ mode: "enforce", workedSinceLastBlock: true, consecutiveBlocks: 99 });
  assert.equal(verdict.action, "block");
  assert.equal(verdict.effects.setConsecutiveBlocks, 1);
});

test("first firing binds the pact to the session; an already-bound pact re-binds to nothing", () => {
  assert.equal(callDecide({ pact: runningPact({ boundSession: null }), sessionId: "A", mode: "enforce", workedSinceLastBlock: true }).effects.bindSession, "A");
  assert.equal(callDecide({ sessionId: "A", mode: "enforce", workedSinceLastBlock: true }).effects.bindSession, null);
});

// ---------------------------------------------------------------------------
// S121 — red proofs, both directions, and an anti-tautology sweep
// ---------------------------------------------------------------------------

test("BOTH verdicts are reachable — the gate is not an elaborate constant", () => {
  assert.equal(callDecide({ pact: null }).action, "allow");
  assert.equal(callDecide({ mode: "enforce", workedSinceLastBlock: true }).action, "block");
});

test("no world with no-pact or observe or another-session ever blocks (safety sweep)", () => {
  const statuses = ["running", "completed", "blocked", "owner_directive", "runing"];
  let sawBlock = false, sawAllow = false;
  for (const status of statuses) for (const w of [true, false]) for (const c of [0, 1, 3, 10]) {
    assert.equal(decide({ pact: null, now: NOW, sessionId: "A", mode: "enforce", workedSinceLastBlock: w, consecutiveBlocks: c }).action, "allow");
    assert.equal(decide({ pact: runningPact({ status }), now: NOW, sessionId: "Z", mode: "enforce", workedSinceLastBlock: w, consecutiveBlocks: c }).action, "allow");
    assert.equal(decide({ pact: runningPact({ status }), now: NOW, sessionId: "A", mode: "observe", workedSinceLastBlock: w, consecutiveBlocks: c }).action, "allow");
    const v = decide({ pact: runningPact({ status }), now: NOW, sessionId: "A", mode: "enforce", workedSinceLastBlock: w, consecutiveBlocks: c });
    if (v.action === "block") sawBlock = true; else sawAllow = true;
  }
  assert.ok(sawBlock, "the block path must be reachable");
  assert.ok(sawAllow, "the allow path must be reachable");
});

test("every declared decision code is actually reachable", () => {
  const reached = new Set([
    callDecide({ pact: null }).code,
    callDecide({ sessionId: "B" }).code,
    callDecide({ now: "2026-09-01T00:00:00Z" }).code,
    callDecide({ pact: runningPact({ status: "completed" }) }).code,
    callDecide({ pact: runningPact({ status: "blocked", ticket: { class: "hard_blockage" } }) }).code,
    callDecide({ pact: runningPact({ status: "owner_directive" }) }).code,
    callDecide({ pact: runningPact({ status: "runing" }) }).code,
    callDecide({ mode: "observe" }).code,
    callDecide({ mode: "enforce", workedSinceLastBlock: false, consecutiveBlocks: 3 }).code,
    callDecide({ mode: "enforce", workedSinceLastBlock: true }).code,
  ]);
  for (const code of DECISION_CODES) assert.ok(reached.has(code), `decision code ${code} is unreached`);
});

test("the block message names all three ticket classes and a runnable command, and truncates a huge scope", () => {
  const message = blockMessage(runningPact(), "node /abs/cli.mjs");
  for (const cls of STOP_TICKET_CLASSES) assert.ok(message.includes(cls), `must name ${cls}`);
  assert.ok(message.includes("node /abs/cli.mjs complete"), "must name a runnable complete command");
  const huge = blockMessage(runningPact({ scope: "z".repeat(9000) }), "x");
  assert.ok(huge.length < 3000, "an oversized scope must be truncated in the block reason");
});

// ---------------------------------------------------------------------------
// D2 — the mode dial: unknown model fails toward observe (flagship-safe)
// ---------------------------------------------------------------------------

test("resolveMode: Fable and UNKNOWN both observe; only an identified non-flagship enforces", () => {
  assert.equal(resolveMode("claude-fable-5"), "observe");
  assert.equal(resolveMode("claude-opus-4-8"), "enforce");
  assert.equal(resolveMode("claude-opus-5"), "enforce");
  assert.equal(resolveMode("claude-haiku-4-5-20251001"), "enforce");
  // The review's flagship finding: an unrecoverable model must NOT enforce.
  assert.equal(resolveMode(null), "observe");
  assert.equal(resolveMode(""), "observe");
  assert.equal(resolveMode(undefined), "observe");
});

test("resolveModelFromTranscript reads the last assistant model and does not lose a valid leading tail line", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-transcript-"));
  try {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "user", message: { role: "user" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-fable-5" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-4-8" } }),
    ].join("\n") + "\n");
    assert.equal(resolveModelFromTranscript(path), "claude-opus-4-8");
    assert.equal(resolveModelFromTranscript(join(dir, "missing.jsonl")), null);
    // A whole valid file read as a tail must not drop its first line: single-line file.
    const single = join(dir, "one.jsonl");
    writeFileSync(single, JSON.stringify({ type: "assistant", message: { model: "claude-fable-5" } }) + "\n");
    assert.equal(resolveModelFromTranscript(single, { tailBytes: 1_000_000 }), "claude-fable-5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toolUseCount counts tool_use markers; workedSinceLastBlock fails toward NO progress on unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-tu-"));
  try {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
    ].join("\n") + "\n");
    assert.equal(toolUseCount(path), 2);
    assert.equal(toolUseCount(join(dir, "missing.jsonl")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(workedSinceLastBlock(3, 1), true);     // 2 new tool uses => worked
  assert.equal(workedSinceLastBlock(1, 1), false);    // none new => no progress
  assert.equal(workedSinceLastBlock(5, null), true);  // no prior block => fresh
  assert.equal(workedSinceLastBlock(null, 2), false); // UNKNOWN now => no progress => release direction
});

// ---------------------------------------------------------------------------
// S116 — pact lifecycle and validation
// ---------------------------------------------------------------------------

test("buildPact sets a running, active pact expiring at created + ttl, and caps scope", () => {
  const pact = buildPact({ scope: "s", authorizedBy: "owner", now: "2026-08-01T00:00:00Z", ttlMs: 3600_000 });
  assert.equal(pact.status, "running");
  assert.equal(pact.expiresAt, "2026-08-01T01:00:00.000Z");
  assert.equal(pact.runtime.consecutiveBlocks, 0);
  assert.ok(isWellFormedPact(pact));
  assert.throws(() => buildPact({ scope: "z".repeat(MAX_SCOPE_BYTES + 1), authorizedBy: "o", now: NOW }), /scope exceeds/u);
});

test("migratePact deactivates on a terminal status, appends history, keeps the prior", () => {
  const started = buildPact({ scope: "s", authorizedBy: "owner", now: "2026-08-01T00:00:00Z" });
  const done = migratePact(started, { status: "completed", now: "2026-08-01T05:00:00Z", detail: "done" });
  assert.equal(done.status, "completed");
  assert.equal(done.active, false);
  assert.equal(done.history.length, started.history.length + 1);
  assert.deepEqual(done.history[0], started.history[0]);
});

test("isWellFormedPact: rejects a bad counter (fail toward absent), accepts an unknown-status envelope", () => {
  assert.equal(isWellFormedPact(null), false);
  assert.equal(isWellFormedPact({ schemaVersion: "wrong" }), false);
  const base = { schemaVersion: PACT_SCHEMA_VERSION, active: true };
  // no runtime / bad counter => not well-formed => readPact returns null => allow
  assert.equal(isWellFormedPact({ ...base, status: "running" }), false);
  assert.equal(isWellFormedPact({ ...base, status: "running", runtime: { consecutiveBlocks: "x" } }), false);
  assert.equal(isWellFormedPact({ ...base, status: "running", runtime: { consecutiveBlocks: -1 } }), false);
  // unknown status but otherwise well-formed => MUST be well-formed so STATUS_UNKNOWN can fire
  assert.equal(isWellFormedPact({ ...base, status: "runing", runtime: { consecutiveBlocks: 0 } }), true);
});

test("readPact fails toward ABSENT on malformed JSON and round-trips a good pact", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-pact-"));
  try {
    const path = join(dir, "p.json");
    writeFileSync(path, "{ not json");
    assert.equal(readPact(path), null);
    const pact = buildPact({ scope: "s", authorizedBy: "owner", now: NOW });
    writePact(pact, path);
    assert.deepEqual(readPact(path), pact);
    // a "x" counter file must read as absent, not trap
    writeFileSync(path, JSON.stringify({ ...pact, runtime: { consecutiveBlocks: "x" } }));
    assert.equal(readPact(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// S122 — parallel isolation and expiry, against the real verdict
// ---------------------------------------------------------------------------

test("the same pact yields different verdicts for the bound vs a parallel session", () => {
  const pact = runningPact({ boundSession: "A" });
  assert.equal(decide({ pact, now: NOW, sessionId: "A", mode: "enforce", workedSinceLastBlock: true, consecutiveBlocks: 0 }).action, "block");
  assert.equal(decide({ pact, now: NOW, sessionId: "B", mode: "enforce", workedSinceLastBlock: true, consecutiveBlocks: 0 }).code, "OTHER_SESSION");
});

test("expiry is a boundary: just-before enforces, at-or-after lifts", () => {
  const pact = runningPact({ expiresAt: "2026-08-01T12:00:00Z" });
  assert.equal(decide({ pact, now: "2026-08-01T11:59:59Z", sessionId: "A", mode: "enforce", workedSinceLastBlock: true, consecutiveBlocks: 0 }).action, "block");
  assert.equal(decide({ pact, now: "2026-08-01T12:00:00Z", sessionId: "A", mode: "enforce", workedSinceLastBlock: true, consecutiveBlocks: 0 }).code, "PACT_EXPIRED");
});

test("osascriptArgs escapes quotes and backslashes and strips control bytes", () => {
  const script = osascriptArgs("T", 'a"b\\c')[1];
  assert.ok(script.includes('a\\"b\\\\c'));
});

// ---------------------------------------------------------------------------
// S123 — the hook wire protocol, end to end via subprocess
// ---------------------------------------------------------------------------

function livePact(overrides = {}) {
  return {
    schemaVersion: PACT_SCHEMA_VERSION, active: true, status: "running", scope: "build", authorizedBy: "owner",
    boundSession: null, maxConsecutiveBlocks: 3, createdAt: "2026-08-01T00:00:00Z",
    expiresAt: "2999-01-01T00:00:00Z", ticket: null, runtime: { consecutiveBlocks: 0, lastBlockToolUses: null }, history: [],
    ...overrides,
  };
}

function runHook(pactObj, stdinObj, transcriptLines) {
  const dir = mkdtempSync(join(tmpdir(), "sp-hook-"));
  const pactFile = join(dir, "pact.json");
  const transcript = join(dir, "t.jsonl");
  if (pactObj) writeFileSync(pactFile, `${JSON.stringify(pactObj)}\n`);
  if (transcriptLines !== null) writeFileSync(transcript, `${(transcriptLines ?? []).map((l) => JSON.stringify(l)).join("\n")}\n`);
  const input = { ...stdinObj, transcript_path: stdinObj.transcript_path ?? (transcriptLines === null ? join(dir, "nope.jsonl") : transcript) };
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    env: { ...process.env, TCRN_STOP_PACT_PATH: pactFile, TCRN_STOP_PACT_NO_NOTIFY: "1" },
    encoding: "utf8",
  });
  let json = null;
  try { json = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null; } catch { /* leave null */ }
  const pactAfter = pactObj ? JSON.parse(readFileSync(pactFile, "utf8")) : null;
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout, json, pactAfter };
}

const OPUS = [{ type: "assistant", message: { model: "claude-opus-4-8" } }];

test("hook: no pact → exits 0, emits nothing", () => {
  const r = runHook(null, { session_id: "A" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("hook: running + opus + first fire → block, binds the session, counter 1", () => {
  const r = runHook(livePact(), { session_id: "A" }, OPUS);
  assert.equal(r.json?.decision, "block");
  assert.equal(r.pactAfter.boundSession, "A");
  assert.equal(r.pactAfter.runtime.consecutiveBlocks, 1);
});

test("hook: running + Fable → observe, allows (flagship untouched)", () => {
  const r = runHook(livePact({ boundSession: "A" }), { session_id: "A" }, [{ type: "assistant", message: { model: "claude-fable-5" } }]);
  assert.equal(r.json, null);
});

test("hook: running + UNREADABLE transcript → observe (model unknown), allows — never blocks a possible flagship", () => {
  // The review's flagship+trap finding: a null transcript must not enforce-block.
  const r = runHook(livePact({ boundSession: "A" }), { session_id: "A" }, null);
  assert.equal(r.json, null, "an unreadable transcript must resolve to observe and allow");
});

test("hook: a PARALLEL session does not reset the bound session's counter", () => {
  // Review finding 6/10: OTHER_SESSION must write nothing.
  const r = runHook(livePact({ boundSession: "A", runtime: { consecutiveBlocks: 2, lastBlockToolUses: 0 } }), { session_id: "B" }, OPUS);
  assert.equal(r.json, null, "the bystander session is allowed");
  assert.equal(r.pactAfter.runtime.consecutiveBlocks, 2, "the bound session's counter must be untouched");
});

test("hook: a large scope produces a valid, untruncated block decision", () => {
  const r = runHook(livePact({ boundSession: "A", scope: "s".repeat(4000) }), { session_id: "A" }, OPUS);
  assert.equal(r.json?.decision, "block", "the block JSON must parse (not be truncated by exit)");
  assert.ok(r.json.reason.length > 100);
});

test("hook: completed pact (inactive) → allows the stop", () => {
  const r = runHook(livePact({ active: false, status: "completed", boundSession: "A" }), { session_id: "A" }, OPUS);
  assert.equal(r.json, null);
});

// ---------------------------------------------------------------------------
// CLI — the migration commands (S118)
// ---------------------------------------------------------------------------

function runCli(args, pactFile) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, TCRN_STOP_PACT_PATH: pactFile, TCRN_STOP_PACT_NO_NOTIFY: "1" }, encoding: "utf8",
  });
  let json = null;
  try { json = JSON.parse(result.stdout.trim()); } catch { /* leave null */ }
  return { status: result.status, json };
}

test("cli: start → status → block enforces the ticket vocabulary and records it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-cli-"));
  const pactFile = join(dir, "p.json");
  try {
    assert.equal(runCli(["start", "--scope", "do the work", "--authorized-by", "owner test"], pactFile).json.reasonCode, "PACT_STARTED");
    assert.equal(runCli(["start", "--scope", "again", "--authorized-by", "o"], pactFile).json.reasonCode, "PACT_ALREADY_ACTIVE");
    assert.equal(runCli(["block", "--ticket", "because", "--reason", "x"], pactFile).json.reasonCode, "TICKET_CLASS_INVALID");
    assert.equal(runCli(["block", "--ticket", "hard_blockage"], pactFile).json.reasonCode, "REASON_REQUIRED");
    assert.equal(runCli(["block", "--ticket", "hard_blockage", "--reason", "waiting on owner key"], pactFile).json.reasonCode, "PACT_BLOCKED");
    const status = runCli(["status"], pactFile);
    assert.equal(status.json.pact.status, "blocked");
    assert.equal(status.json.pact.ticket.class, "hard_blockage");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: complete migrates a running pact to done and deactivates it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-cli2-"));
  const pactFile = join(dir, "p.json");
  try {
    runCli(["start", "--scope", "s", "--authorized-by", "o"], pactFile);
    const done = runCli(["complete"], pactFile);
    assert.equal(done.json.reasonCode, "PACT_COMPLETED");
    assert.equal(done.json.active, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
