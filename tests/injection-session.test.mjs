// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  acknowledgeInjection,
  boundedSearch,
  buildBoundedTaskContext,
  DEFAULT_PER_PROMPT_BYTES,
  InjectionSessionStore,
  normalizeDispatchContext,
  UninjectedModelCall,
  buildL0Injection,
  pullCorrelation,
  statusChangeSequences,
} from "../scripts/injection-session.mjs";
import { parseArgv, parseInjectionProtocol, runInjection, runSessionInjection, serializeInjectionProtocol } from "../scripts/knowledge-inject.mjs";
import {
  InjectionPlacementManifest,
  MAX_HOOK_INPUT_BYTES,
  MAX_HOOK_OUTPUT_BYTES,
  boundedHookInput,
  inferHost,
  runInject,
  validateInjectionPlacementManifest,
} from "../scripts/knowledge-inject-hook.mjs";

const emptyWorkspace = { work: [], events: [], conferences: [], conferenceMinutes: [] };
const dispatchTiers = (model) => JSON.stringify({ "claude-code": { economy: { model, effort: "medium" } } });
const sessionDefaults = Object.freeze({ budget: 24_576, perPromptBytes: 1_600, judgeEnabled: false, settings: Object.freeze([]), workspaceState: emptyWorkspace });
const bareRegressionChild = process.env.TCRN_INJECTION_BARE_REGRESSION_CHILD === "1";
function sessionOptions(overrides = {}) {
  return { ...sessionDefaults, ...overrides };
}
const runSelfContainedSession = (options) => runSessionInjection({ settings: [], ...options });

function workspaceState(work, events = []) {
  return { work, events, conferences: [], conferenceMinutes: [] };
}

const languageSettings = (model = "test-economy") => [
  { key: "artifact.language", currentValue: "zh-CN" },
  { key: "retrieval.promptLanguages", currentValue: "zh-CN" },
  { key: "execution.dispatchTiers", currentValue: dispatchTiers(model) },
];

// TCRN-CROSS-INC-369: the live cross-project configuration -- artifact.language=en,
// retrieval.promptLanguages=zh-CN. An English query here is not "outside" anything (it
// already matches the artifact language), so it must never be owed a translation, even
// though "en" is not itself in promptLanguages.
const englishArtifactLanguageSettings = (model = "test-economy") => [
  { key: "artifact.language", currentValue: "en" },
  { key: "retrieval.promptLanguages", currentValue: "zh-CN" },
  { key: "execution.dispatchTiers", currentValue: dispatchTiers(model) },
];

function mockChild({ output = "reply", onInput = () => {}, close = true, onKill = null } = {}) {
  const child = new EventEmitter();
  child.pid = process.pid;
  child.stdin = { end: onInput };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  if (onKill !== null) child.kill = onKill;
  if (close) setImmediate(() => { child.stdout.emit("data", output); child.emit("close", 0, null); });
  return child;
}

async function stateDirectory(context, name) {
  const directory = await mkdtemp(join(tmpdir(), `tcrn-injection-${name}-`));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function temporaryTextFile(context, name, filename, body) {
  const root = await mkdtemp(join(tmpdir(), `tcrn-${name}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, filename);
  await writeFile(file, body);
  return { root, file };
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

test("418 rejects an unbound subagent without reading global L0 or calling auxiliary models", async (context) => {
  const directory = await stateDirectory(context, "unbound-subagent");
  const state = workspaceState([{ id: "work:other", externalKey: "OTHER", kind: "Story", status: "active", parentId: null, title: "Other", summary: "unrelated", tombstone: false }]);
  let recalls = 0;
  let translates = 0;
  let judgments = 0;
  const result = await runSessionInjection(sessionOptions({
    prompt: "hook",
    sessionId: "unbound-subagent",
    event: "UserPromptSubmit",
    hookInput: { hook_event_name: "UserPromptSubmit", session_id: "unbound-subagent", agent_id: "child-1" },
    stateDirectory: directory,
    workspaceState: state,
    settings: [{ key: "execution.dispatchTiers", currentValue: dispatchTiers("not-used") }],
    recall: async () => { recalls += 1; return { ok: true, result: { records: [] } }; },
    translate: async () => { translates += 1; return { text: "translated" }; },
    judge: async () => { judgments += 1; return { judgment: true }; },
  }));
  assert.equal(result.reasonCode, "DISPATCH_CONTEXT_BINDING_MISSING");
  assert.equal(result.decision, "DISPATCH_CONTEXT_BINDING_MISSING");
  assert.equal(result.injected, false);
  assert.equal(result.injection, null);
  assert.equal(recalls, 0);
  assert.equal(translates, 0);
  assert.equal(judgments, 0);
});

test("418 binds a subagent to one workId and Pack, keeping unrelated active work out", async (context) => {
  const directory = await stateDirectory(context, "bound-subagent");
  const state = workspaceState([
      { id: "work:target", externalKey: "TARGET", kind: "Story", status: "active", parentId: null, title: "Bound task", summary: "EPIC135 HC1", labels: ["EPIC135/HC1"], tombstone: false },
      { id: "work:other", externalKey: "OTHER", kind: "Story", status: "active", parentId: null, title: "Other task", summary: "EPIC135 HC1", labels: ["other-pack"], tombstone: false },
  ]);
  const binding = normalizeDispatchContext({ role: "subagent", workId: "work:target", pack: "EPIC135/HC1" }, { env: {} });
  assert.equal(binding.ok, true);
  const frame = buildBoundedTaskContext(state, binding, { maxLines: 6, maxBytes: 1_600 });
  assert.equal(frame.ok, true);
  assert.ok(frame.text.includes("TARGET"));
  assert.ok(!frame.text.includes("OTHER"));
  let recalls = 0;
  let auxiliary = 0;
  const result = await runSessionInjection(sessionOptions({
    prompt: "task details",
    sessionId: "bound-subagent",
    event: "SubagentStart",
    hookInput: { hook_event_name: "SubagentStart", session_id: "bound-subagent", agent_id: "child-1", role: "subagent", workId: "work:target", pack: "EPIC135/HC1" },
    stateDirectory: directory,
    workspaceState: state,
    settings: [{ key: "execution.dispatchTiers", currentValue: dispatchTiers("not-used") }],
    recall: async () => { recalls += 1; return { ok: true, result: { records: [] } }; },
    translate: async () => { auxiliary += 1; return { text: "translated" }; },
    judge: async () => { auxiliary += 1; return { judgment: true }; },
  }));
  assert.equal(result.decision, "SUBAGENT_TASK_CONTEXT");
  assert.ok(result.injection.includes("TARGET"));
  assert.ok(!result.injection.includes("OTHER"));
  assert.equal(result.dispatchContext.role, "subagent");
  assert.equal(result.dispatchContext.workId, "work:target");
  assert.equal(result.dispatchContext.pack, "EPIC135/HC1");
  assert.equal(recalls, 0);
  assert.equal(auxiliary, 0);
});

test("419 keeps generated ids pending until wrapper acknowledgement, then deduplicates", async (context) => {
  const directory = await stateDirectory(context, "pending-delivery");
  const target = { id: "knowledge:bound", kind: "card", key: "BOUND", status: "active", title: "Bound card", summary: "task", workId: "work:target", pack: "EPIC135/HC1" };
  const options = sessionOptions({
    prompt: "task",
    sessionId: "pending-delivery",
    event: "UserPromptSubmit",
    hookInput: { hook_event_name: "UserPromptSubmit", session_id: "pending-delivery", role: "subagent", workId: "work:target", pack: "EPIC135/HC1" },
    stateDirectory: directory,
    settings: [],
    deliveryMode: "pending",
    workspaceState: workspaceState([{ id: "work:target", externalKey: "TARGET", kind: "Story", status: "active", parentId: null, title: "Target", summary: "task", labels: ["EPIC135/HC1"] }]),
    recall: recallFor([target]),
  });
  const first = await runSessionInjection(options);
  assert.equal(first.delivery.state, "pending");
  assert.ok(new InjectionSessionStore({ directory }).readSession(options.sessionId).pendingIds.includes(target.id));
  const retry = await runSessionInjection({ ...options, retryPending: true });
  assert.equal(retry.delivery.state, "pending");
  assert.ok(retry.injection.includes("BOUND"));
  const acknowledged = acknowledgeInjection(options.sessionId, retry.delivery.ids, { directory });
  assert.equal(acknowledged.reasonCode, "INJECTION_DELIVERY_ACKNOWLEDGED");
  assert.deepEqual(new InjectionSessionStore({ directory }).readSession(options.sessionId).pendingIds, []);
  assert.ok(new InjectionSessionStore({ directory }).readSession(options.sessionId).emittedIds.includes(target.id));
  const skipped = await runSessionInjection({ ...options, deliveryMode: "immediate" });
  assert.equal(skipped.decision, "ALREADY_INJECTED_SKIPPED");
  assert.equal(skipped.injection, null);
});

test("a sixty-prompt session stays under the cumulative budget and records every decision", async (context) => {
  const directory = await stateDirectory(context, "sixty");
  const outputs = []; // sessionOptions supplies settings and state, so production fallbacks cannot read the live chain.
  for (let index = 0; index < 60; index += 1) {
    const records = Array.from({ length: 8 }, (_, row) => candidate(`knowledge:${index.toString(16).padStart(24, "0")}${row.toString(16)}`, index * 8 + row));
    const result = await runSessionInjection(sessionOptions({
      prompt: `prompt-${index}`,
      sessionId: "sixty-session",
      event: "UserPromptSubmit",
      stateDirectory: directory,
      perPromptBytes: DEFAULT_PER_PROMPT_BYTES,
      recall: recallFor(records),
    }));
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

test("the exact bare injection-session command is green or a stable fast failure", { skip: bareRegressionChild }, async (context) => {
  const result = await runUnpreloadedRelay(context, [
    'const environment = { ...process.env, TCRN_INJECTION_BARE_REGRESSION_CHILD: "1" };',
    'delete environment.NODE_OPTIONS;',
    'delete environment.NODE_TEST_CONTEXT;',
    'const child = spawn(process.execPath, ["--test", "tests/injection-session.test.mjs"], { cwd: process.argv[2], env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120000, killSignal: "SIGKILL" });',
    'const stdout = [];',
    'const stderr = [];',
    'child.stdout.on("data", (chunk) => stdout.push(chunk));',
    'child.stderr.on("data", (chunk) => stderr.push(chunk));',
    'const startedAt = Date.now();',
    'const [exitCode, signal] = await once(child, "close");',
    'try { process.kill(-child.pid, "SIGKILL"); } catch {}',
    'const output = { command: [process.execPath, "--test", "tests/injection-session.test.mjs"], cwd: process.argv[2], timeoutMs: 120000, elapsedMs: Date.now() - startedAt, timedOut: signal === "SIGKILL", exitCode, signal, processGroup: child.pid, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };',
    'try { process.kill(-child.pid, 0); output.processGroupAliveAfterReclaim = true; } catch { output.processGroupAliveAfterReclaim = false; }',
    'process.stdout.write(JSON.stringify(output));',
  ].join("\n"), process.cwd());
  if (process.env.TCRN_INJECTION_BARE_REGRESSION_EVIDENCE) await writeFile(process.env.TCRN_INJECTION_BARE_REGRESSION_EVIDENCE, `${JSON.stringify(result, null, 2)}\n`);
  assert.equal(result.timedOut, false, `bare command exceeded 120000 ms\n${result.stderr}\n${result.stdout.slice(-4_096)}`);
  assert.equal(result.processGroupAliveAfterReclaim, false, "owned bare-test process group must be gone");
  if (result.exitCode !== 0) {
    assert.match(`${result.stdout}\n${result.stderr}`, /(?:TEST_CONTROLLER_[A-Z_]+|reasonCode|ERR_[A-Z_]+)/u, "a fast failure must retain a stable readable reason");
  }
});

test("a repeated card is explicitly skipped, while another session and a restart retain their own state", async (context) => {
  const directory = await stateDirectory(context, "dedupe");
  const repeated = [candidate("knowledge:000000000000000000000001")];
  const first = await runSelfContainedSession({ prompt: "repeat-one", sessionId: "one", event: "UserPromptSubmit", stateDirectory: directory, workspaceState: emptyWorkspace, budget: 24_576, perPromptBytes: 1_600, recall: recallFor(repeated), judgeEnabled: false });
  const second = await runSelfContainedSession({ prompt: "repeat-two", sessionId: "one", event: "UserPromptSubmit", stateDirectory: directory, workspaceState: emptyWorkspace, budget: 24_576, perPromptBytes: 1_600, recall: recallFor(repeated), judgeEnabled: false });
  const other = await runSelfContainedSession({ prompt: "repeat-three", sessionId: "two", event: "UserPromptSubmit", stateDirectory: directory, workspaceState: emptyWorkspace, budget: 24_576, perPromptBytes: 1_600, recall: recallFor(repeated), judgeEnabled: false });
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
    enabled.push((await runSelfContainedSession({ ...common, stateDirectory: enabledDirectory, judge })).injection);
    disabled.push((await runSelfContainedSession({ ...common, stateDirectory: disabledDirectory, judgeEnabled: false })).injection);
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
    host: "claude",
    budget: 24_576,
    settings: languageSettings(),
    translate: async () => { order.push("translate"); return { text: "你好世界", model: "test-economy" }; },
    recall: async (query) => { order.push(`recall:${query}`); return { ok: true, result: { records: [] } }; },
  });
  assert.deepEqual(order, ["translate", "recall:你好世界"]);
});

test("TCRN-CROSS-INC-369: an English prompt under artifact.language=en never invokes the translator, before or after recall", async () => {
  let translateCalls = 0;
  const result = await runInjection({
    prompt: "hello world",
    partition: "cross-project",
    host: "claude",
    budget: 24_576,
    settings: englishArtifactLanguageSettings(),
    translate: async () => {
      translateCalls += 1;
      return { text: "should never be reached", model: "test-economy" };
    },
    recall: async () => ({ ok: true, result: { records: [] } }),
  });
  // Counterfactual: reverting INC-369's `queryLanguage !== target` guard in
  // resolveQueryLanguage makes this query "outside" again (artifact.language=en,
  // promptLanguages=zh-CN does not list "en"), which calls the translator once before
  // the first recall -- this is the assertion that goes red without the fix. The second
  // (post-recall, fail-open) call site is also proven at 0 here since the mocked recall
  // returns no queryTranslation of its own.
  assert.equal(translateCalls, 0, "an English query under artifact.language=en must never invoke the translator, pre- or post-recall");
  assert.equal(result.telemetry?.queryTranslations ?? 0, 0);
});

test("R6 records a translator failure on the last session decision instead of dropping it", async (context) => {
  const directory = await stateDirectory(context, "translation-failure");
  const settings = languageSettings();
  const result = await runSessionInjection(sessionOptions({
    prompt: "hello world",
    sessionId: "translation-failure",
    event: "UserPromptSubmit",
    host: "claude",
    stateDirectory: directory,
    settings,
    translate: async () => ({ text: null, model: "economy", reasonCode: "UNINJECTED_MODEL_TIMEOUT" }),
    recall: recallFor([]),
  }));
  const session = new InjectionSessionStore({ directory }).readSession("translation-failure");
  const last = session.decisions.at(-1);
  assert.equal(last.translationFailure.reasonCode, "UNINJECTED_MODEL_TIMEOUT");
  assert.equal(result.telemetry.translationFailure.reasonCode, "UNINJECTED_MODEL_TIMEOUT");
});

test("PostCompact re-emits retained L0 and pull correlation ignores failures, unrelated ids, and replay", async (context) => {
  const directory = await stateDirectory(context, "events");
  const state = workspaceState([{ id: "work:one", externalKey: "ONE", kind: "Story", status: "active", parentId: null, title: "One", summary: "", tombstone: false }], [{ sequence: 1, payload: { operation: "work.created", record: { id: "work:one", status: "active" } } }]);
  const start = await runSessionInjection(sessionOptions({ prompt: "", sessionId: "compact", event: "SessionStart", stateDirectory: directory, workspaceState: state }));
  const compact = await runSessionInjection(sessionOptions({ prompt: "", sessionId: "compact", event: "PostCompact", stateDirectory: directory, workspaceState: state }));
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

test("top-level SessionStart with a production hook payload keeps legacy L0 injection", async (context) => {
  const directory = await stateDirectory(context, "legacy-top-level");
  const state = workspaceState([{ id: "work:one", externalKey: "ONE", kind: "Story", status: "active", parentId: null, title: "One", summary: "", tombstone: false }], [{ sequence: 1, payload: { operation: "work.created", record: { id: "work:one", status: "active" } } }]);
  const result = await runSessionInjection(sessionOptions({
    prompt: "",
    sessionId: "legacy-top-level",
    event: "SessionStart",
    hookInput: { hook_event_name: "SessionStart", session_id: "legacy-top-level", cwd: "/repo" },
    stateDirectory: directory,
    workspaceState: state,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.injected, true);
  assert.equal(result.decision, "L0_CHANGED");
  assert.equal(result.reasonCode, undefined);
  assert.equal(result.dispatchContext, undefined);
});

test("R1 boundedSearch returns hits from an explicitly bounded directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tcrn-bounded-search-hit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const nested = join(root, "known");
  await mkdir(nested);
  const file = join(nested, "record.txt");
  await writeFile(file, "outside\nneedle is here\n");

  const result = await boundedSearch({ query: "needle", directories: [root], maxDepth: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, "SEARCH_COMPLETED");
  assert.equal(result.partial, false);
  assert.equal(result.nextScope, null);
  assert.deepEqual(result.matches, [{ path: file, line: 2, text: "needle is here" }]);
  const renamed = await mkdtemp(join(tmpdir(), "tcrn-renamed-container-"));
  context.after(() => rm(renamed, { recursive: true, force: true }));
  await writeFile(join(renamed, "record.txt"), "portable needle\n");
  assert.equal((await boundedSearch({ query: "needle", directories: [renamed] })).reasonCode, "SEARCH_COMPLETED");
});

test("R2 boundedSearch rejects the platform container and sibling without a directory-name literal", async (context) => {
  const container = await mkdtemp(join(tmpdir(), "tcrn-platform-arbitrary-"));
  context.after(() => rm(container, { recursive: true, force: true }));
  const repository = join(container, "classification", "engine-repo");
  const sibling = join(container, "classification", "adjacent-repo");
  await mkdir(sibling, { recursive: true });
  const boundary = { repositoryRoot: repository };

  for (const rejectedPath of [container, sibling]) {
    const rejected = await boundedSearch({ query: "needle", directories: [rejectedPath], ...boundary });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reasonCode, "SEARCH_SCOPE_OUT_OF_BOUNDS");
    assert.equal(rejected.rejectedPath, rejectedPath);
  }

  // TCRN-CROSS-INC-359 (SUB-192): the repository itself sits inside this same
  // arbitrarily-named container and must stay searchable -- every existing
  // positive leg elsewhere in this file happens to live outside the container
  // and only exercises the ".." allowance, never the in-repo allowance below.
  const inRepoDirectory = join(repository, "nested");
  await mkdir(inRepoDirectory, { recursive: true });
  const inRepoFile = join(inRepoDirectory, "record.txt");
  await writeFile(inRepoFile, "needle is inside the repository\n");

  const filePositive = await boundedSearch({ query: "needle", files: [inRepoFile], ...boundary });
  assert.equal(filePositive.ok, true);
  assert.equal(filePositive.reasonCode, "SEARCH_COMPLETED");
  assert.deepEqual(filePositive.matches, [{ path: inRepoFile, line: 1, text: "needle is inside the repository" }]);

  const directoryPositive = await boundedSearch({ query: "needle", directories: [repository], maxDepth: 2, ...boundary });
  assert.equal(directoryPositive.ok, true);
  assert.equal(directoryPositive.reasonCode, "SEARCH_COMPLETED");
  assert.deepEqual(directoryPositive.matches, [{ path: inRepoFile, line: 1, text: "needle is inside the repository" }]);

  const partial = await boundedSearch({ query: "needle", directories: [repository], maxDepth: 2, timeoutMs: 0, ...boundary });
  assert.equal(partial.ok, true);
  assert.equal(partial.reasonCode, "SEARCH_PARTIAL");
  assert.equal(partial.partial, true);
  assert.equal(partial.partialReason, "SEARCH_TIMEOUT");
  assert.deepEqual(partial.nextScope.directories, [repository]);

  // The container's own parent is an ancestor of the platform root, not merely
  // "outside" it, and must be refused for the same reason the container itself
  // is: left open, a caller could walk back down into the container and its
  // sibling repositories from above (INC-359's finding).
  const ancestor = dirname(container);
  const ancestorRejected = await boundedSearch({ query: "needle", directories: [ancestor], ...boundary });
  assert.equal(ancestorRejected.ok, false);
  assert.equal(ancestorRejected.reasonCode, "SEARCH_SCOPE_OUT_OF_BOUNDS");
  assert.equal(ancestorRejected.rejectedPath, ancestor);
});

test("TCRN-CROSS-INC-362 boundedSearch resolves a symlinked explicit scope item before judging the boundary", async (context) => {
  const container = await mkdtemp(join(tmpdir(), "tcrn-platform-arbitrary-"));
  context.after(() => rm(container, { recursive: true, force: true }));
  const repository = join(container, "classification", "engine-repo");
  const sibling = join(container, "classification", "adjacent-repo");
  // The repository root is created up front (unlike the lexical-only R2 fixture
  // above, which never needs it to exist) so its realpath resolves consistently
  // with the other realpath'd values below -- exactly like a real, already
  // checked-out repositoryRoot always does in production.
  await mkdir(repository, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(join(sibling, "secret.txt"), "needle leaked from the sibling repository\n");
  const boundary = { repositoryRoot: repository };

  const outside = await mkdtemp(join(tmpdir(), "tcrn-outside-symlink-"));
  context.after(() => rm(outside, { recursive: true, force: true }));

  // (a) an explicit directory root that lexically sits outside the container -- the
  // existing ".." allowance would admit it on the lexical check alone -- but is
  // itself a symlink whose real target is the sibling repository inside the
  // container. Traversal already skips symlinked children (SEARCH_SYMLINK_SKIPPED);
  // this is the boundary check on the *root* itself, before traversal starts.
  const linkedRoot = join(outside, "link-to-sibling-root");
  await symlink(sibling, linkedRoot, "dir");
  const rootRejected = await boundedSearch({ query: "needle", directories: [linkedRoot], ...boundary });
  assert.equal(rootRejected.ok, false);
  assert.equal(rootRejected.reasonCode, "SEARCH_SCOPE_OUT_OF_BOUNDS");
  assert.equal(rootRejected.rejectedPath, linkedRoot);

  // (b) an explicit file whose parent directory is a symlink to the sibling
  // repository, so the file's own lexical path looks like it lives outside the
  // container while its real path resolves inside it.
  const linkedParent = join(outside, "link-to-sibling-parent");
  await symlink(sibling, linkedParent, "dir");
  const fileViaLink = join(linkedParent, "secret.txt");
  const fileRejected = await boundedSearch({ query: "needle", files: [fileViaLink], ...boundary });
  assert.equal(fileRejected.ok, false);
  assert.equal(fileRejected.reasonCode, "SEARCH_SCOPE_OUT_OF_BOUNDS");
  assert.equal(fileRejected.rejectedPath, fileViaLink);

  // A real (non-symlinked) in-repository read must stay green: realpath resolution
  // must not turn a legitimate in-repo item into a false rejection.
  const inRepoDirectory = join(repository, "nested");
  await mkdir(inRepoDirectory, { recursive: true });
  const inRepoFile = join(inRepoDirectory, "record.txt");
  await writeFile(inRepoFile, "needle is inside the repository\n");
  const filePositive = await boundedSearch({ query: "needle", files: [inRepoFile], ...boundary });
  assert.equal(filePositive.ok, true);
  assert.equal(filePositive.reasonCode, "SEARCH_COMPLETED");
  assert.deepEqual(filePositive.matches, [{ path: inRepoFile, line: 1, text: "needle is inside the repository" }]);

  // A path that does not exist keeps the existing lexical-only behavior (realpath
  // has nothing to canonicalize) rather than throwing.
  const missing = join(outside, "does-not-exist", "also-missing");
  const missingResult = await boundedSearch({ query: "needle", directories: [missing], ...boundary });
  assert.equal(missingResult.ok, true);
  assert.equal(missingResult.reasonCode, "SEARCH_PARTIAL");
  assert.equal(missingResult.partialReason, "SEARCH_SCOPE_UNREADABLE");
});

test("R1 boundedSearch refuses home scans and exposes timeout continuation", async (context) => {
  const denied = await boundedSearch({ query: "needle", directories: [homedir()] });
  assert.equal(denied.ok, false);
  assert.equal(denied.reasonCode, "SEARCH_SCOPE_OUT_OF_BOUNDS");
  assert.equal(denied.partial, true);
  assert.deepEqual(denied.nextScope.directories, [homedir()]);

  assert.equal((await boundedSearch({ query: "needle" })).reasonCode, "SEARCH_SCOPE_REQUIRED");
  for (const directory of ["relative", "/"]) assert.equal((await boundedSearch({ query: "needle", directories: [directory] })).reasonCode, "SEARCH_SCOPE_OUT_OF_BOUNDS");

  const { root } = await temporaryTextFile(context, "bounded-search-timeout", "record.txt", "needle\n");
  const timed = await boundedSearch({ query: "needle", directories: [root], timeoutMs: 0 });
  assert.equal(timed.ok, true);
  assert.equal(timed.reasonCode, "SEARCH_PARTIAL");
  assert.equal(timed.partial, true);
  assert.equal(timed.partialReason, "SEARCH_TIMEOUT");
  assert.deepEqual(timed.nextScope.directories, [root]);
});

test("knowledge recall receives the caller's bounded search scope", async (context) => {
  const { root, file } = await temporaryTextFile(context, "bounded-search-recall", "known.txt", "bounded recall needle\n");
  let scoped;

  const result = await runInjection({
    prompt: "needle",
    partition: "cross-project",
    budget: 24_576,
    searchScope: { directories: [root], maxDepth: 1 },
    recall: async (query, options) => {
      scoped = await options.boundedSearch({ query });
      return { ok: true, result: { records: [] } };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(scoped.reasonCode, "SEARCH_COMPLETED");
  assert.deepEqual(scoped.matches, [{ path: file, line: 1, text: "bounded recall needle" }]);
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
    return mockChild({ output: "translated" });
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
  assert.match(InjectionPlacementManifest.commands.codex, /--container-root "<PLATFORM_ROOT>" --host codex$/u);
  assert.match(InjectionPlacementManifest.commands.claude, /--container-root "\$\{CLAUDE_PROJECT_DIR\}" --host claude$/u);
});

test("419 emits one bounded protocol document and parses legacy pretty JSON", () => {
  const serialized = serializeInjectionProtocol({ ok: true, injected: true, injection: "context" });
  assert.equal(serialized.truncated, false);
  assert.equal(serialized.text.includes("\n"), false);
  assert.equal(parseInjectionProtocol(serialized.text).value.injection, "context");
  const legacy = parseInjectionProtocol(JSON.stringify({ ok: true, injected: false }, null, 2));
  assert.equal(legacy.ok, true);
  assert.equal(legacy.legacy, true);
  assert.equal(parseInjectionProtocol('{"ok":true}\n{"ok":true}').reasonCode, "INJECT_OUTPUT_UNPARSEABLE");
  const tooLarge = serializeInjectionProtocol({ ok: true, injection: "x".repeat(MAX_HOOK_OUTPUT_BYTES) });
  assert.equal(tooLarge.truncated, true);
  assert.equal(JSON.parse(tooLarge.text).reasonCode, "INJECT_OUTPUT_TRUNCATED");
});

test("419 preserves non-zero child errors and retries an unparseable response once", () => {
  const outputs = [
    { status: 0, stdout: "not json\n", stderr: "parser noise" },
    { status: 0, stdout: `${JSON.stringify({ ok: true, injected: false, reasonCode: "NO_CANDIDATES" })}\n`, stderr: "" },
  ];
  let calls = 0;
  const retried = runInject({ hook_event_name: "UserPromptSubmit", session_id: "protocol-retry", role: "subagent", workId: "work:target", pack: "EPIC135/HC1", prompt: "task" }, {
    host: "codex",
    retries: 1,
    spawnImpl: () => { const next = outputs[calls] ?? outputs.at(-1); calls += 1; return next; },
  });
  assert.equal(retried.ok, true);
  assert.equal(calls, 2);
  assert.equal(retried.attempts[0].reasonCode, "INJECT_OUTPUT_UNPARSEABLE");
  assert.equal(retried.attempts[1].ok, true);

  const failed = runInject({ hook_event_name: "UserPromptSubmit", session_id: "protocol-failed", role: "subagent", workId: "work:target", pack: "EPIC135/HC1", prompt: "task" }, {
    host: "claude",
    retries: 0,
    spawnImpl: () => ({ status: 7, stdout: JSON.stringify({ ok: false, reasonCode: "CHAIN_READ_TIMEOUT" }), stderr: "timeout" }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reasonCode, "CHAIN_READ_TIMEOUT");
  assert.equal(failed.processExitCode, 7);
});

test("419 drives the same bounded wrapper protocol through Claude and Codex paths", () => {
  for (const host of ["claude", "codex"]) {
    let seen = null;
    const result = runInject({ hook_event_name: "SubagentStart", session_id: `host-${host}`, role: "subagent", workId: "work:target", pack: "EPIC135/HC1" }, {
      host,
      containerRoot: "/governed/container",
      retries: 0,
      spawnImpl: (_executable, args, options) => {
        seen = { args, options };
        return { status: 0, stdout: JSON.stringify({ ok: true, injected: false, reasonCode: "DISPATCH_CONTEXT_NO_MATCH" }), stderr: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.protocol.version, "tcrn.injection-protocol.v2");
    assert.ok(seen.args.includes("--host"));
    assert.equal(seen.args[seen.args.indexOf("--host") + 1], host);
    assert.equal(seen.args[seen.args.indexOf("--container-root") + 1], "/governed/container");
    assert.equal(seen.options.maxBuffer, MAX_HOOK_OUTPUT_BYTES);
  }
  const parsed = parseArgv(["--enforce-binding", "true", "--retry-pending", "true", "--judge-enabled", "false"]);
  assert.deepEqual([parsed.enforceBinding, parsed.retryPending, parsed.judgeEnabled], [true, true, false]);
});

test("codex stdin opens with the system prompt while claude stdin stays the bare prompt", async () => {
  const bodies = [];
  const captureSpawn = () => mockChild({ onInput: (body) => bodies.push(body) });
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

test("codex-cli model prefixes use codex for both hosts and preserve the system prompt", async () => {
  const systemPrompt = "Return only the requested answer.";
  const calls = [];
  const captureSpawn = (executable, args, options) => mockChild({ onInput: (body) => calls.push({ executable, args, options, body }) });

  for (const host of ["claude", "codex"]) {
    const call = new UninjectedModelCall({
      host,
      model: "codex-cli:gpt-5.6-luna/max",
      cwd: tmpdir(),
      systemPrompt,
      spawnImpl: captureSpawn,
    });
    await call.call(`prompt-${host}`);
  }

  assert.equal(calls.length, 2);
  for (const { executable, args, body } of calls) {
    assert.equal(executable, "codex");
    const modelIndex = args.indexOf("-m");
    assert.equal(args[modelIndex + 1], "gpt-5.6-luna/max");
    assert.equal(args.some((argument) => argument.includes("codex-cli:")), false);
    assert.equal(body.split("\n\n")[0], systemPrompt);
  }
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
    const spawnImpl = (_executable, _args, options) => mockChild({ output: options.cwd === empty ? "safe" : "forged" });
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
  const spawnImpl = () => mockChild({ close: false, onKill: () => { killed = true; } });
  const call = new UninjectedModelCall({ model: "economy", cwd: tmpdir(), timeoutMs: 5, spawnImpl });
  const timedOut = await call.translatePrompt("slow");
  assert.equal(timedOut.text, null);
  assert.equal(timedOut.reasonCode, "UNINJECTED_MODEL_TIMEOUT");
  assert.equal(killed, true);
  assert.equal((await call.translatePrompt("again")).reasonCode, "UNINJECTED_MODEL_CALL_LIMIT");
});

// The child policy forbids detached descendants; real process-group cases therefore run
// in an unpreloaded relay, while the governed test still owns every assertion.
const injectionSessionModuleUrl = new URL("../scripts/injection-session.mjs", import.meta.url).href;

async function runUnpreloadedRelay(context, caseScript, relayArgument) {
  const directory = await mkdtemp(join(tmpdir(), "tcrn-relay-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const scriptPath = join(directory, "relay.mjs");
  await writeFile(scriptPath, [
    'import { spawn } from "node:child_process";',
    'import { once } from "node:events";',
    `import { UninjectedModelCall } from ${JSON.stringify(injectionSessionModuleUrl)};`,
    caseScript,
  ].join("\n"));
  const relay = spawn("/usr/bin/env", ["-u", "NODE_OPTIONS", process.execPath, scriptPath, relayArgument], { stdio: ["ignore", "pipe", "ignore"] });
  const chunks = [];
  relay.stdout.on("data", (chunk) => chunks.push(chunk));
  await once(relay, "exit");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function relayCallScript(body, prompt, timeoutMs = null, capturePid = false) {
  const spawnCall = capturePid ? `const child = spawn(process.execPath, ["-e", ${JSON.stringify(body)}], options); childPid = child.pid; return child;` : `return spawn(process.execPath, ["-e", ${JSON.stringify(body)}], options);`;
  return [
    ...(capturePid ? ["let childPid = null;"] : []),
    "const call = new UninjectedModelCall({",
    '  model: "economy",',
    '  cwd: process.argv[2],',
    ...(timeoutMs === null ? [] : [`  timeoutMs: ${timeoutMs},`]),
    `  spawnImpl: (_exe, _args, options) => { ${spawnCall} },`,
    "});",
    `const result = await call.translatePrompt(${JSON.stringify(prompt)});`,
    capturePid ? 'process.stdout.write(JSON.stringify({ reasonCode: result.reasonCode, childPid }));' : 'process.stdout.write(JSON.stringify(result));',
  ].join("\n");
}

test("a real child process inherits the isolated cwd and its stdout becomes the translation", async (context) => {
  // realpath keeps the child's cwd stable across macOS's /tmp symlink.
  const empty = await realpath(await mkdtemp(join(tmpdir(), "tcrn-real-child-cwd-")));
  context.after(() => rm(empty, { recursive: true, force: true }));
  const cwdEchoBody = "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(process.cwd()))";
  const result = await runUnpreloadedRelay(context, relayCallScript(cwdEchoBody, "x"), empty);
  assert.equal(result.text, empty);
});

test("a real child that outlives the timeout is killed and leaves its process group empty", async (context) => {
  const hangBody = "setTimeout(()=>{},60000)";
  const { reasonCode, childPid } = await runUnpreloadedRelay(context, relayCallScript(hangBody, "slow", 50, true), tmpdir());
  assert.equal(reasonCode, "UNINJECTED_MODEL_TIMEOUT");
  // process.kill is not intercepted by the policy, so this checks the relay-reported pid.
  assert.throws(() => process.kill(-childPid, 0));
});
