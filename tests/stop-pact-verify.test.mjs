// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-374 — the explicit work-bound advisory:verify Stop branch.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireWorkspaceLease,
  annotateWork,
  createProject,
  createWork,
  initializeWorkspace,
} from "../dist/build/packages/core/src/index.js";
import {
  CODEX_STOP_PACT_EXECUTION_VERSION,
} from "../tools/stop-pact/codex-executor.mjs";
import { buildPact, writePact } from "../tools/stop-pact/pact.mjs";
import {
  MAX_STDERR_TAIL_BYTES,
  VERIFY_TIMEOUT_MS,
  utf8Tail,
} from "../tools/stop-pact/verify.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const HOOK = join(HERE, "..", "tools", "stop-pact", "hook.mjs");
const STOP_CLI = join(HERE, "..", "tools", "stop-pact", "cli.mjs");
const NOW = "2026-09-10T00:00:00.000Z";

function nodeCommand(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

function backgroundNodeCommand(pidPath, { exitCode = 0, hold = false, ignoreTerm = false } = {}) {
  const childSource = ignoreTerm ? "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60_000);" : "setTimeout(() => {}, 60_000);";
  const parentSource = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
    hold ? "setTimeout(() => {}, 60_000);" : `process.exit(${exitCode});`,
  ].join(" ");
  return nodeCommand(parentSource);
}

async function waitForProcessToExit(pid, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function readPid(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch { /* child has not written its pid yet */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`pid file was not written: ${path}`);
}

function killIfAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* child already exited */ }
}

async function fixture(t, verify) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-story374-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = ["framework", "workspace", "transient", "evidence-locator", "release-trust"]
    .map((kind) => ({ kind, path: join(base, kind) }));
  for (const root of roots) await mkdir(root.path, { recursive: true });
  await initializeWorkspace({ roots, externalKey: "STORY-374-FIXTURE", createdAt: NOW });
  const workspace = join(base, "workspace");
  const lease = await acquireWorkspaceLease(workspace, { now: NOW });
  t.after(() => lease.release().catch(() => undefined));
  let state = await createProject(workspace, lease, {
    expectedVersion: 0,
    occurredAt: NOW,
    externalKey: "STORY-374-PROJECT",
    name: "Story 374",
  });
  state = await createWork(workspace, lease, {
    expectedVersion: state.version,
    occurredAt: NOW,
    projectId: state.projects[0].id,
    externalKey: "STORY-374-INCIDENT",
    kind: "Incident",
    parentId: null,
    status: "active",
    title: "Verify fixture",
  });
  const workId = state.work[0].id;
  if (verify !== undefined) {
    state = await annotateWork(workspace, lease, {
      expectedVersion: state.version,
      occurredAt: NOW,
      id: workId,
      verify,
    });
  }
  return { workspace, workId };
}

function pactFile(t, workspace, workId, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tcrn-story374-pact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "pact.json");
  writePact(buildPact({
    scope: "finish Story 374",
    authorizedBy: "owner",
    now: NOW,
    boundSession: "session-374",
    workspace,
    workId,
    ...overrides,
  }), path);
  return path;
}

function runClaudeHook(path, input = {}) {
  const result = spawnSync("/usr/bin/env", ["-u", "NODE_OPTIONS", process.execPath, HOOK], {
    input: JSON.stringify({ session_id: "session-374", ...input }),
    env: { ...process.env, TCRN_STOP_PACT_PATH: path, TCRN_STOP_PACT_NO_NOTIFY: "1" },
    encoding: "utf8",
  });
  const output = result.stdout.trim();
  return { ...result, json: output.length === 0 ? null : JSON.parse(output) };
}

function runStopCli(path, args) {
  const result = spawnSync(process.execPath, [STOP_CLI, ...args], {
    env: { ...process.env, TCRN_STOP_PACT_PATH: path, TCRN_STOP_PACT_NO_NOTIFY: "1" },
    encoding: "utf8",
  });
  return { ...result, json: JSON.parse(result.stdout.trim()) };
}

function runCodexStop(input, options) {
  const moduleUrl = new URL("../tools/stop-pact/codex-executor.mjs", import.meta.url).href;
  const source = [
    `import { executeCodexStop } from ${JSON.stringify(moduleUrl)};`,
    `const result = executeCodexStop(${JSON.stringify(input)}, ${JSON.stringify(options)});`,
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const result = spawnSync("/usr/bin/env", ["-u", "NODE_OPTIONS", process.execPath, "--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runVerificationUnpreloaded(command, cwd, options = {}) {
  const moduleUrl = new URL("../tools/stop-pact/verify.mjs", import.meta.url).href;
  const source = [
    `import { runVerification } from ${JSON.stringify(moduleUrl)};`,
    `const result = await runVerification(${JSON.stringify(command)}, ${JSON.stringify(cwd)}, ${JSON.stringify(options)});`,
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const result = spawnSync("/usr/bin/env", ["-u", "NODE_OPTIONS", process.execPath, "--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runVerificationSyncUnpreloaded(command, cwd, options = {}) {
  const moduleUrl = new URL("../tools/stop-pact/verify.mjs", import.meta.url).href;
  const source = [
    `import { runVerificationSync } from ${JSON.stringify(moduleUrl)};`,
    `const result = runVerificationSync(${JSON.stringify(command)}, ${JSON.stringify(cwd)}, ${JSON.stringify(options)});`,
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const result = spawnSync("/usr/bin/env", ["-u", "NODE_OPTIONS", process.execPath, "--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runVerificationCancellationUnpreloaded(command, cwd, pidPath) {
  const moduleUrl = new URL("../tools/stop-pact/verify.mjs", import.meta.url).href;
  const source = [
    `import { runVerification } from ${JSON.stringify(moduleUrl)};`,
    'import { access } from "node:fs/promises";',
    'const controller = new AbortController();',
    `const promise = runVerification(${JSON.stringify(command)}, ${JSON.stringify(cwd)}, { signal: controller.signal, timeoutMs: 30_000 });`,
    "for (let attempt = 0; attempt < 1_000; attempt += 1) { try { await access(" + JSON.stringify(pidPath) + "); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }",
    "controller.abort();",
    "const result = await promise;",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const result = spawnSync("/usr/bin/env", ["-u", "NODE_OPTIONS", process.execPath, "--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("STORY-374 Subtask 020: start persists an explicit workspace/work binding and migrations append history", async (t) => {
  const { workspace, workId } = await fixture(t);
  const directory = mkdtempSync(join(tmpdir(), "tcrn-story374-start-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "pact.json");
  const started = runStopCli(path, [
    "start",
    "--scope", "finish Story 374",
    "--authorized-by", "owner",
    "--workspace", workspace,
    "--work-id", workId,
  ]);
  assert.equal(started.status, 0);
  assert.equal(started.json.reasonCode, "PACT_STARTED");
  const status = runStopCli(path, ["status"]);
  assert.equal(status.json.pact.workspace, workspace);
  assert.equal(status.json.pact.workId, workId);
  assert.equal(status.json.pact.history.length, 1);
  const completed = runStopCli(path, ["complete", "--detail", "verify passed"]);
  assert.equal(completed.json.reasonCode, "PACT_COMPLETED");
  const after = runStopCli(path, ["status"]);
  assert.equal(after.json.pact.active, false);
  assert.equal(after.json.pact.history.length, 2);
  assert.equal(after.json.pact.history[1].event, "completed");
});

test("STORY-374 GWT1/GWT3: a failing bound verify blocks both hosts before model tier resolution", async (t) => {
  const verify = nodeCommand("process.stderr.write('verify failed on the bound work'); process.exit(1)");
  const { workspace, workId } = await fixture(t, verify);
  const path = pactFile(t, workspace, workId);

  const claude = runClaudeHook(path, { stop_hook_active: false });
  assert.equal(claude.status, 0);
  assert.equal(claude.json?.decision, "block");
  assert.match(claude.json?.reason ?? "", /verify failed on the bound work/u);

  const codex = runCodexStop({
    hook_event_name: "Stop",
    session_id: "session-374",
    model: "claude-opus-5",
    stop_hook_active: false,
    tool_use_count: 0,
    now: NOW,
  }, { path });
  assert.equal(codex.schemaVersion, CODEX_STOP_PACT_EXECUTION_VERSION);
  assert.equal(codex.reasonCode, "VERIFY_FAILED");
  assert.equal(codex.mode, "verify");
  assert.equal(codex.action, "block");
  assert.match(codex.message, /verify failed on the bound work/u);
});

test("STORY-374 GWT2: a passing verify allows the stop without consulting the model tier", async (t) => {
  const { workspace, workId } = await fixture(t, nodeCommand("process.exit(0)"));
  const path = pactFile(t, workspace, workId);
  const claude = runClaudeHook(path, { stop_hook_active: false });
  assert.equal(claude.status, 0);
  assert.equal(claude.json, null);

  const codex = runCodexStop({
    session_id: "session-374",
    model: "gpt-5-codex",
    stop_hook_active: false,
    tool_use_count: 0,
    now: NOW,
  }, { path });
  assert.equal(codex.reasonCode, "VERIFY_PASSED");
  assert.equal(codex.mode, "verify");
  assert.equal(codex.action, "allow");
});

test("STORY-374 GWT4: an absent verify command keeps the legacy observe path fail-open", async (t) => {
  const { workspace, workId } = await fixture(t);
  const path = pactFile(t, workspace, workId);
  const claude = runClaudeHook(path, {
    stop_hook_active: false,
    transcript_path: join(workspace, "missing-transcript.jsonl"),
  });
  assert.equal(claude.status, 0);
  assert.equal(claude.json, null);
});

test("STORY-374: stop_hook_active and a parallel session take priority over verify", async (t) => {
  const verify = nodeCommand("process.stderr.write('must not run'); process.exit(1)");
  const { workspace, workId } = await fixture(t, verify);
  const path = pactFile(t, workspace, workId);
  assert.equal(runClaudeHook(path, { stop_hook_active: true }).json, null);
  assert.equal(runClaudeHook(path, { session_id: "parallel-session", stop_hook_active: false }).json, null);
});

test("STORY-374: stderr is retained as a well-formed UTF-8 tail capped at 500 bytes", () => {
  const long = "前".repeat(400);
  const tail = utf8Tail(long);
  assert.ok(Buffer.byteLength(tail, "utf8") <= MAX_STDERR_TAIL_BYTES);
  assert.ok(tail.length > 0);
  assert.equal(VERIFY_TIMEOUT_MS, 8_000);
});

test("STORY-374: the async runner blocks on timeout and reports an exit without stderr", async (t) => {
  // The detached process-group scenario must run outside the governed test preload;
  // the host hook itself is likewise exercised unpreloaded above.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tcrn-story374-relay-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const moduleUrl = new URL("../tools/stop-pact/verify.mjs", import.meta.url).href;
  const source = [
    `import { runVerification } from ${JSON.stringify(moduleUrl)};`,
    `const result = await runVerification(${JSON.stringify(nodeCommand("setTimeout(() => {}, 60_000)"))}, ${JSON.stringify(directory)}, { timeoutMs: 50 });`,
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const result = spawnSync("/usr/bin/env", ["-u", "NODE_OPTIONS", process.execPath, "--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.timedOut, true);
  assert.match(output.reason, /timed out/u);
});

test("STORY-384: async success, failure, cancellation, timeout, and pipeline paths reclaim their process groups", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tcrn-story384-async-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = [
    ["success", "success.pid", {}, {}],
    ["failure", "failure.pid", { exitCode: 7 }, {}],
    ["term-ignoring timeout", "timeout.pid", { hold: true, ignoreTerm: true }, { timeoutMs: 500 }],
  ];
  for (const [name, filename, commandOptions, runOptions] of cases) {
    const pidPath = join(directory, filename);
    const result = runVerificationUnpreloaded(backgroundNodeCommand(pidPath, commandOptions), directory, runOptions);
    assert.equal(result.ok, name === "success", `${name} result`);
    if (name === "failure") assert.equal(result.exitCode, 7);
    if (name === "term-ignoring timeout") assert.equal(result.timedOut, true);
    const pid = await readPid(pidPath);
    try { assert.equal(await waitForProcessToExit(pid), true, `${name} child must exit`); } finally { killIfAlive(pid); }
  }

  const pipelinePidPath = join(directory, "pipeline.pid");
  await writeFile(pipelinePidPath, "", "utf8");
  const pipeline = `sleep 30 | cat > /dev/null & echo $! > ${JSON.stringify(pipelinePidPath)}; exit 0`;
  const pipelineResult = runVerificationUnpreloaded(pipeline, directory);
  assert.equal(pipelineResult.ok, true);
  const pipelinePid = await readPid(pipelinePidPath);
  try { assert.equal(await waitForProcessToExit(pipelinePid), true, "pipeline child must exit"); } finally { killIfAlive(pipelinePid); }

  const cancelledPidPath = join(directory, "cancelled.pid");
  const cancelled = runVerificationCancellationUnpreloaded(backgroundNodeCommand(cancelledPidPath, { hold: true }), directory, cancelledPidPath);
  const cancelledPid = await readPid(cancelledPidPath);
  assert.equal(cancelled.cancelled, true);
  try { assert.equal(await waitForProcessToExit(cancelledPid), true, "cancelled child must exit"); } finally { killIfAlive(cancelledPid); }
});

test("STORY-384: the synchronous runner uses a detached group and reclaims background descendants", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tcrn-story384-sync-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidPath = join(directory, "sync.pid");
  const result = runVerificationSyncUnpreloaded(backgroundNodeCommand(pidPath), directory, { timeoutMs: 500 });
  assert.equal(result.ok, true);
  const pid = await readPid(pidPath);
  try { assert.equal(await waitForProcessToExit(pid), true, "synchronous child must exit"); } finally { killIfAlive(pid); }
});

test("STORY-392: synchronous timeout reclaims a TERM-ignoring group before the watchdog boundary", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tcrn-story392-timeout-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidPath = join(directory, "timeout-supervisor.pid");
  const command = `trap '' TERM; echo $$ > ${JSON.stringify(pidPath)}; while :; do sleep 1; done`;
  const started = Date.now();
  const result = runVerificationSyncUnpreloaded(command, directory, { timeoutMs: 200 });
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 3_000, `synchronous verification exceeded watchdog budget: ${elapsed}ms`);
  const pid = await readPid(pidPath);
  assert.equal(await waitForProcessToExit(pid), true, "timeout group must be empty before return");
});

test("STORY-392: an explicitly bound unreadable work record fails closed while Owner stop stays available", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tcrn-story392-binding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "pact.json");
  const workspace = join(directory, "missing-workspace");
  writePact(buildPact({
    scope: "finish Story 392",
    authorizedBy: "owner",
    now: NOW,
    boundSession: "session-374",
    workspace,
    workId: "work:000000000000000000000000",
  }), path);
  const input = { session_id: "session-374", model: "gpt-5-codex", stop_hook_active: false, tool_use_count: 0, now: NOW };
  const claude = runClaudeHook(path, input);
  assert.equal(claude.status, 0);
  assert.equal(claude.json?.decision, "block");
  assert.match(claude.json?.reason ?? "", /bound work verification unavailable/u);
  const codex = runCodexStop(input, { path });
  assert.equal(codex.reasonCode, "VERIFY_FAILED");
  assert.equal(codex.action, "block");
  assert.match(codex.message, /bound work verification unavailable/u);
  const ownerStop = runCodexStop({ ...input, stop_hook_active: true }, { path });
  assert.equal(ownerStop.reasonCode, "STOP_HOOK_ACTIVE");
  assert.equal(ownerStop.action, "allow");
});
