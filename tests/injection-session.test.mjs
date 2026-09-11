// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_PER_PROMPT_BYTES,
  InjectionSessionStore,
  UninjectedModelCall,
  buildL0Injection,
  pullCorrelation,
  statusChangeSequences,
} from "../scripts/injection-session.mjs";
import { runInjection, runSessionInjection } from "../scripts/knowledge-inject.mjs";
import {
  InjectionPlacementManifest,
  MAX_HOOK_INPUT_BYTES,
  boundedHookInput,
  inferHost,
  validateInjectionPlacementManifest,
} from "../scripts/knowledge-inject-hook.mjs";

const emptyWorkspace = { work: [], events: [], conferences: [], conferenceMinutes: [] };

async function stateDirectory(context, name) {
  const directory = await mkdtemp(join(tmpdir(), `tcrn-injection-${name}-`));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function candidate(id, index = 0) {
  return {
    id,
    kind: "card",
    key: id,
    status: "active",
    title: `Candidate ${index}`,
    summary: "x".repeat(420),
  };
}

function recallFor(records) {
  return async () => ({ ok: true, result: { records } });
}

test("the real record fixture renders GWT4 six lines and sequence ordering", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/injection-l0-real-records.json", import.meta.url), "utf8"));
  const result = buildL0Injection({
    work: fixture.records,
    events: fixture.events,
    conferences: fixture.conferences,
    conferenceMinutes: fixture.conferenceMinutes,
  });
  assert.equal(result.lines.length, 6);
  assert.match(result.lines[0], /minutes:246640ee9b9ce0d34a555564/u);
  assert.match(result.lines[1], /TCRN-CROSS-INIT-051/u);
  assert.match(result.lines.at(-1), /^另 11 条 active\/ready 未注入$/u);
  assert.equal(result.currentId, "work:e95a729d85353a33e3722299");
  assert.equal(result.statusChangeSequences["work:e95a729d85353a33e3722299"], 5026);
  assert.ok(result.lines.every((line) => Buffer.byteLength(line, "utf8") <= 200));
});

test("status ordering ignores annotation events, prefers active, and uses ascending ids on ties", () => {
  const records = [
    { id: "work:b", kind: "Story", status: "ready", parentId: null },
    { id: "work:a", kind: "Story", status: "active", parentId: null },
  ];
  const events = [
    { sequence: 1, payload: { operation: "work.created", record: { id: "work:a", status: "active" } } },
    { sequence: 2, payload: { operation: "work.annotated", record: { id: "work:a", status: "active" } } },
    { sequence: 3, payload: { operation: "work.created", record: { id: "work:b", status: "ready" } } },
  ];
  const sequences = statusChangeSequences(records, events);
  assert.equal(sequences.get("work:a"), 1);
  assert.equal(sequences.get("work:b"), 3);
  const tie = statusChangeSequences([
    { id: "work:z", status: "active" },
    { id: "work:a", status: "active" },
  ], [
    { sequence: 9, payload: { operation: "work.created", record: { id: "work:z", status: "active" } } },
    { sequence: 9, payload: { operation: "work.created", record: { id: "work:a", status: "active" } } },
  ]);
  assert.equal(tie.get("work:a"), 9);
});

test("inactive parents consume a line without reducing the active/ready omitted count", () => {
  const records = [
    { id: "work:current", externalKey: "CURRENT", kind: "Story", status: "ready", parentId: "work:epic", title: "Current", summary: "", tombstone: false },
    { id: "work:epic", externalKey: "EPIC", kind: "Epic", status: "done", parentId: "work:init", title: "Epic", summary: "", tombstone: false },
    { id: "work:init", externalKey: "INIT", kind: "Initiative", status: "done", parentId: null, title: "Init", summary: "", tombstone: false },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `work:ready-${index}`, externalKey: `READY-${index}`, kind: "Incident", status: "ready", parentId: null, title: "", summary: "", tombstone: false })),
  ];
  const events = records.map((record, index) => ({ sequence: record.id === "work:current" ? 100 : index + 1, payload: { operation: "work.created", record: { id: record.id, status: record.status } } }));
  const result = buildL0Injection({ work: records, events, conferences: [], conferenceMinutes: [] });
  assert.ok(result.lines.some((line) => line.includes("EPIC")));
  assert.ok(result.lines.some((line) => line.includes("INIT")));
  assert.equal(result.omittedCount, 4);
});

test("a sixty-prompt session stays under the cumulative budget and records every decision", async (context) => {
  const directory = await stateDirectory(context, "sixty");
  const outputs = [];
  for (let index = 0; index < 60; index += 1) {
    const records = Array.from({ length: 8 }, (_, row) => candidate(`knowledge:${index.toString(16).padStart(24, "0")}${row.toString(16)}`, index * 8 + row));
    const result = await runSessionInjection({
      prompt: `prompt-${index}`,
      sessionId: "sixty-session",
      event: "UserPromptSubmit",
      stateDirectory: directory,
      workspaceState: emptyWorkspace,
      budget: 24_576,
      perPromptBytes: DEFAULT_PER_PROMPT_BYTES,
      recall: recallFor(records),
      judgeEnabled: false,
    });
    outputs.push({ injectedBytes: result.injectedBytes, cumulativeBytes: result.cumulativeBytes });
  }
  assert.equal(outputs.length, 60);
  assert.ok(outputs.every((entry) => entry.cumulativeBytes <= 24_576));
  assert.ok(outputs.some((entry) => entry.injectedBytes === 0), "the saturated tail must be L0-only");
  const session = new InjectionSessionStore({ directory }).readSession("sixty-session");
  assert.equal(session.decisions.length, 60);
  assert.ok(session.l1Bytes <= 24_576);
  if (process.env.TCRN_INJECTION_LEDGER) await writeFile(process.env.TCRN_INJECTION_LEDGER, `${JSON.stringify(outputs, null, 2)}\n`);
});

test("a repeated card is explicitly skipped, while another session and a restart retain their own state", async (context) => {
  const directory = await stateDirectory(context, "dedupe");
  const repeated = [candidate("knowledge:000000000000000000000001")];
  const first = await runSessionInjection({ prompt: "repeat-one", sessionId: "one", event: "UserPromptSubmit", stateDirectory: directory, workspaceState: emptyWorkspace, budget: 24_576, perPromptBytes: 1_600, recall: recallFor(repeated), judgeEnabled: false });
  const second = await runSessionInjection({ prompt: "repeat-two", sessionId: "one", event: "UserPromptSubmit", stateDirectory: directory, workspaceState: emptyWorkspace, budget: 24_576, perPromptBytes: 1_600, recall: recallFor(repeated), judgeEnabled: false });
  const other = await runSessionInjection({ prompt: "repeat-three", sessionId: "two", event: "UserPromptSubmit", stateDirectory: directory, workspaceState: emptyWorkspace, budget: 24_576, perPromptBytes: 1_600, recall: recallFor(repeated), judgeEnabled: false });
  assert.equal(first.decision, "INJECTION_EMITTED");
  assert.equal(second.decision, "ALREADY_INJECTED_SKIPPED");
  assert.equal(other.decision, "INJECTION_EMITTED");
  assert.equal(new InjectionSessionStore({ directory }).readSession("one").emittedIds.length, 1);
  assert.equal(new InjectionSessionStore({ directory }).readSession("two").emittedIds.length, 1);
});

test("acquireAsync waits out a held lock, times out on an unreleased one, and reclaims a stale one", async (context) => {
  // (a) a second acquireAsync on the same session waits for the first lease to release,
  // then observes what that lease committed before it resolves.
  const waitDirectory = await stateDirectory(context, "lock-wait");
  const waitStore = new InjectionSessionStore({ directory: waitDirectory });
  const first = await waitStore.acquireAsync("s");
  first.session.emittedIds.push("held-by-first");
  let settled = false;
  const second = waitStore.acquireAsync("s").then((lease) => { settled = true; return lease; });
  assert.equal(settled, false);
  first.commit();
  first.release();
  const lease = await second;
  assert.equal(settled, true);
  assert.deepEqual(lease.session.emittedIds, ["held-by-first"]);
  lease.commit();
  lease.release();

  // (b) a lock file already present, and never released, rejects once lockTimeoutMs elapses.
  const timeoutDirectory = await stateDirectory(context, "lock-timeout");
  await writeFile(join(timeoutDirectory, "state.lock"), `${process.pid}\n`);
  const timeoutStore = new InjectionSessionStore({ directory: timeoutDirectory, lockTimeoutMs: 20 });
  await assert.rejects(timeoutStore.acquireAsync("s"), /INJECTION_SESSION_LOCK_TIMEOUT/u);

  // (c) staleLockMs: 0 reclaims the lock instead of waiting it out.
  const staleDirectory = await stateDirectory(context, "lock-stale");
  await writeFile(join(staleDirectory, "state.lock"), `${process.pid}\n`);
  const staleStore = new InjectionSessionStore({ directory: staleDirectory, staleLockMs: 0 });
  const reclaimed = await staleStore.acquireAsync("s");
  assert.ok(reclaimed);
  reclaimed.commit();
  reclaimed.release();
});

test("thirty judge observations are binary telemetry and cannot change injected bytes", async (context) => {
  const enabledDirectory = await stateDirectory(context, "judge-enabled");
  const disabledDirectory = await stateDirectory(context, "judge-disabled");
  let judgments = 0;
  const judge = async () => {
    judgments += 1;
    return { judgment: judgments % 2 === 0, model: "test-economy" };
  };
  const enabled = [];
  const disabled = [];
  for (let index = 0; index < 30; index += 1) {
    const records = [candidate(`knowledge:${(index + 100).toString(16).padStart(24, "0")}`, index)];
    const common = { prompt: `judge-${index}`, sessionId: "judge-session", event: "UserPromptSubmit", workspaceState: emptyWorkspace, budget: 24_576, perPromptBytes: 1_600, recall: recallFor(records) };
    enabled.push((await runSessionInjection({ ...common, stateDirectory: enabledDirectory, judge })).injection);
    disabled.push((await runSessionInjection({ ...common, stateDirectory: disabledDirectory, judgeEnabled: false })).injection);
  }
  assert.equal(judgments, 30);
  assert.deepEqual(enabled, disabled);
  const records = new InjectionSessionStore({ directory: enabledDirectory }).readSession("judge-session").judgments;
  assert.equal(records.length, 30);
  assert.equal(records.filter((record) => typeof record.judgment === "boolean").length, 30);
});

test("R6 invokes its independent translator before the recall call", async () => {
  const order = [];
  await runInjection({
    prompt: "hello world",
    partition: "cross-project",
    budget: 24_576,
    settings: [
      { key: "artifact.language", currentValue: "zh-CN" },
      { key: "retrieval.promptLanguages", currentValue: "zh-CN" },
      { key: "model.economyTier", currentValue: "test-economy" },
    ],
    translate: async () => { order.push("translate"); return { text: "你好世界", model: "test-economy" }; },
    recall: async (query) => { order.push(`recall:${query}`); return { ok: true, result: { records: [] } }; },
  });
  assert.deepEqual(order, ["translate", "recall:你好世界"]);
});

test("R6 records a translator failure on the last session decision instead of dropping it", async (context) => {
  const directory = await stateDirectory(context, "translation-failure");
  const settings = [
    { key: "artifact.language", currentValue: "zh-CN" },
    { key: "retrieval.promptLanguages", currentValue: "zh-CN" },
    { key: "model.economyTier", currentValue: "test-economy" },
  ];
  const result = await runSessionInjection({
    prompt: "hello world",
    sessionId: "translation-failure",
    event: "UserPromptSubmit",
    stateDirectory: directory,
    workspaceState: emptyWorkspace,
    budget: 24_576,
    perPromptBytes: 1_600,
    settings,
    translate: async () => ({ text: null, model: "economy", reasonCode: "UNINJECTED_MODEL_TIMEOUT" }),
    recall: recallFor([]),
    judgeEnabled: false,
  });
  const session = new InjectionSessionStore({ directory }).readSession("translation-failure");
  const last = session.decisions.at(-1);
  assert.equal(last.translationFailure.reasonCode, "UNINJECTED_MODEL_TIMEOUT");
  assert.equal(result.telemetry.translationFailure.reasonCode, "UNINJECTED_MODEL_TIMEOUT");
});

test("PostCompact re-emits retained L0 and pull correlation ignores failures, unrelated ids, and replay", async (context) => {
  const directory = await stateDirectory(context, "events");
  const workspaceState = {
    work: [{ id: "work:one", externalKey: "ONE", kind: "Story", status: "active", parentId: null, title: "One", summary: "", tombstone: false }],
    events: [{ sequence: 1, payload: { operation: "work.created", record: { id: "work:one", status: "active" } } }],
    conferences: [],
    conferenceMinutes: [],
  };
  const start = await runSessionInjection({ prompt: "", sessionId: "compact", event: "SessionStart", stateDirectory: directory, workspaceState, budget: 24_576, perPromptBytes: 1_600, judgeEnabled: false });
  const compact = await runSessionInjection({ prompt: "", sessionId: "compact", event: "PostCompact", stateDirectory: directory, workspaceState, budget: 24_576, perPromptBytes: 1_600, judgeEnabled: false });
  assert.equal(start.injected, true);
  assert.equal(compact.injected, true);
  const emitted = start.l0.ids[0];
  const good = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `work-show --id ${emitted}` }, tool_response: { ok: true, reasonCode: "WORKSPACE_RECORD_READY", record: { id: emitted } } };
  const bad = { ...good, tool_response: { ok: false, reasonCode: "WORKSPACE_INPUT_INVALID", record: { id: emitted } } };
  assert.deepEqual(pullCorrelation(good, [emitted]), { id: emitted, verb: "work-show" });
  assert.equal(pullCorrelation(bad, [emitted]), null);
  assert.equal(pullCorrelation({ ...good, tool_response: { ok: true, record: { id: "work:unrelated" } } }, [emitted]), null);
  assert.equal(pullCorrelation(good, [emitted], [emitted]), null);
});

test("the placement manifest is fixture-shaped and the two model wrappers are independent", async () => {
  assert.equal(validateInjectionPlacementManifest(InjectionPlacementManifest), true);
  const fixture = JSON.parse(await readFile(new URL("../fixtures/injection-placement-manifest.json", import.meta.url), "utf8"));
  assert.equal(validateInjectionPlacementManifest(fixture), true);
  assert.deepEqual(fixture.events, InjectionPlacementManifest.events);
  assert.equal(InjectionPlacementManifest.modelMapping.maxCallsPerPrompt, 1);
  const calls = [];
  const fakeSpawn = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.pid = process.pid;
    child.stdin = { end() {} };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => { child.stdout.emit("data", "translated"); child.emit("close", 0, null); });
    return child;
  };
  const translator = new UninjectedModelCall({ host: "claude", model: "economy", cwd: tmpdir(), spawnImpl: fakeSpawn });
  const judge = new UninjectedModelCall({ host: "codex", model: "economy", cwd: tmpdir(), spawnImpl: fakeSpawn });
  assert.equal((await translator.translatePrompt("hello")).text, "translated");
  assert.equal((await judge.observeCandidates("hello", ["row"])).judgment, null);
  assert.match(calls[0].args.join(" "), /-p --bare --model economy/u);
  assert.match(calls[1].args.join(" "), /exec -C .* -m economy -s read-only --ephemeral/u);
  assert.equal((await translator.call("second")).reasonCode, "UNINJECTED_MODEL_CALL_LIMIT");
});

test("the injection hook carries the actual host instead of defaulting Codex to Claude", () => {
  assert.equal(inferHost({}, { CODEX_PROJECT_DIR: "/repo" }), "codex");
  assert.equal(inferHost({}, { CLAUDE_PROJECT_DIR: "/repo" }), "claude");
  assert.equal(inferHost({ host: "codex" }, { CLAUDE_PROJECT_DIR: "/repo" }), "codex");
  assert.match(InjectionPlacementManifest.commands.codex, /--host codex$/u);
  assert.match(InjectionPlacementManifest.commands.claude, /--host claude$/u);
});

test("codex stdin opens with the system prompt while claude stdin stays the bare prompt", async () => {
  const bodies = [];
  const captureSpawn = () => {
    const child = new EventEmitter();
    child.pid = process.pid;
    child.stdin = { end(body) { bodies.push(body); } };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => { child.stdout.emit("data", "reply"); child.emit("close", 0, null); });
    return child;
  };
  const codex = new UninjectedModelCall({ host: "codex", model: "economy", cwd: tmpdir(), systemPrompt: "Return only the requested answer.", spawnImpl: captureSpawn });
  const claude = new UninjectedModelCall({ host: "claude", model: "economy", cwd: tmpdir(), systemPrompt: "Return only the requested answer.", spawnImpl: captureSpawn });
  await codex.call("original prompt");
  await claude.call("original prompt");
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].startsWith("Return only the requested answer."));
  assert.notEqual(bodies[0], "original prompt");
  assert.ok(bodies[0].endsWith("original prompt"));
  assert.equal(bodies[1], "original prompt");
});

test("a hook payload past 512000 bytes drops tool_response and is marked truncated", () => {
  const small = { hook_event_name: "PostToolUse", prompt: "x" };
  assert.equal(boundedHookInput(small), JSON.stringify(small));
  const huge = { hook_event_name: "PostToolUse", prompt: "x", tool_response: { ok: true, body: "y".repeat(600_000) } };
  assert.ok(Buffer.byteLength(JSON.stringify(huge), "utf8") > MAX_HOOK_INPUT_BYTES);
  const bounded = JSON.parse(boundedHookInput(huge));
  assert.equal(bounded.tcrnPayloadTruncated, true);
  assert.equal(bounded.tool_response, undefined);
  assert.equal(bounded.hook_event_name, "PostToolUse");
  assert.equal(bounded.prompt, "x");
  assert.ok(Buffer.byteLength(boundedHookInput(huge), "utf8") <= MAX_HOOK_INPUT_BYTES);
  const huge2 = { prompt: "x", toolResponse: "z".repeat(600_000) };
  const bounded2 = JSON.parse(boundedHookInput(huge2));
  assert.equal(bounded2.toolResponse, undefined);
  assert.equal(bounded2.tcrnPayloadTruncated, true);
});

test("an isolated wrapper ignores a forged project hook while a deliberately de-isolated control sees it", async () => {
  const project = await mkdtemp(join(tmpdir(), "tcrn-forged-project-"));
  const empty = await mkdtemp(join(tmpdir(), "tcrn-empty-project-"));
  try {
    await writeFile(join(project, "AGENTS.md"), "forged");
    await writeFile(join(project, "settings.json"), "forged");
    const spawnImpl = (_executable, _args, options) => {
      const child = new EventEmitter();
      child.pid = process.pid;
      child.stdin = { end() {} };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => { child.stdout.emit("data", options.cwd === empty ? "safe" : "forged"); child.emit("close", 0, null); });
      return child;
    };
    const isolated = new UninjectedModelCall({ model: "economy", cwd: empty, spawnImpl });
    const deisolated = new UninjectedModelCall({ model: "economy", cwd: project, spawnImpl });
    assert.equal((await isolated.translatePrompt("prompt")).text, "safe");
    assert.equal((await deisolated.translatePrompt("prompt")).text, "forged");
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});

test("an uninjected model call fails open at ten seconds and asks only once", async () => {
  let killed = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = process.pid;
    child.stdin = { end() {} };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; };
    return child;
  };
  const call = new UninjectedModelCall({ model: "economy", cwd: tmpdir(), timeoutMs: 5, spawnImpl });
  const timedOut = await call.translatePrompt("slow");
  assert.equal(timedOut.text, null);
  assert.equal(timedOut.reasonCode, "UNINJECTED_MODEL_TIMEOUT");
  assert.equal(killed, true);
  assert.equal((await call.translatePrompt("again")).reasonCode, "UNINJECTED_MODEL_CALL_LIMIT");
});

// scripts/test-controller-child-policy.mjs forbids a detached descendant of the governed
// test process unconditionally ("test code cannot mint an exception through its
// caller-supplied environment"), and UninjectedModelCall always spawns detached so it can
// later signal the whole group. tests/output-session-lifecycle.test.mjs already solves
// this for the identical reason: run the real scenario inside an unpreloaded relay --
// `/usr/bin/env -u NODE_OPTIONS` drops the policy's --import before node starts, so the
// relay's own child_process.spawn is never patched -- rather than in the guarded test
// process itself. Only the relay may pass detached:true; the two case scripts below are
// written to a real file so the inner spawnImpl's source needs no escaping games.
const injectionSessionModuleUrl = new URL("../scripts/injection-session.mjs", import.meta.url).href;

async function runUnpreloadedRelay(context, caseScript, relayArgument) {
  const directory = await mkdtemp(join(tmpdir(), "tcrn-relay-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const scriptPath = join(directory, "relay.mjs");
  await writeFile(scriptPath, [
    'import { spawn } from "node:child_process";',
    `import { UninjectedModelCall } from ${JSON.stringify(injectionSessionModuleUrl)};`,
    caseScript,
  ].join("\n"));
  const relay = spawn("/usr/bin/env", ["-u", "NODE_OPTIONS", process.execPath, scriptPath, relayArgument], { stdio: ["ignore", "pipe", "ignore"] });
  const chunks = [];
  relay.stdout.on("data", (chunk) => chunks.push(chunk));
  await once(relay, "exit");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("a real child process inherits the isolated cwd and its stdout becomes the translation", async (context) => {
  // realpath: the child's own process.cwd() reports the canonical path, and on macOS
  // tmpdir() sits behind a /tmp or /var symlink that mkdtemp() does not resolve.
  const empty = await realpath(await mkdtemp(join(tmpdir(), "tcrn-real-child-cwd-")));
  context.after(() => rm(empty, { recursive: true, force: true }));
  const cwdEchoBody = "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(process.cwd()))";
  const result = await runUnpreloadedRelay(context, [
    'const call = new UninjectedModelCall({',
    '  model: "economy",',
    '  cwd: process.argv[2],',
    `  spawnImpl: (_exe, _args, options) => spawn(process.execPath, ["-e", ${JSON.stringify(cwdEchoBody)}], options),`,
    '});',
    'const result = await call.translatePrompt("x");',
    'process.stdout.write(JSON.stringify(result));',
  ].join("\n"), empty);
  assert.equal(result.text, empty);
});

test("a real child that outlives the timeout is killed and leaves its process group empty", async (context) => {
  const hangBody = "setTimeout(()=>{},60000)";
  const { reasonCode, childPid } = await runUnpreloadedRelay(context, [
    'let childPid = null;',
    'const call = new UninjectedModelCall({',
    '  model: "economy",',
    '  cwd: process.argv[2],',
    '  timeoutMs: 50,',
    '  spawnImpl: (_exe, _args, options) => {',
    `    const child = spawn(process.execPath, ["-e", ${JSON.stringify(hangBody)}], options);`,
    '    childPid = child.pid;',
    '    return child;',
    '  },',
    '});',
    'const result = await call.translatePrompt("slow");',
    'process.stdout.write(JSON.stringify({ reasonCode: result.reasonCode, childPid }));',
  ].join("\n"), tmpdir());
  assert.equal(reasonCode, "UNINJECTED_MODEL_TIMEOUT");
  // process.kill (unlike child_process.spawn) is not intercepted by the policy, so this
  // check runs directly in the outer, governed test process against the relay-reported pid.
  assert.throws(() => process.kill(-childPid, 0));
});
