// SPDX-License-Identifier: Apache-2.0

// This detached process is the command's process-group leader.  It waits for
// that group to be durably recorded in the output-session owner before it
// starts `node --test`.  If its task parent dies while the group is unbound,
// it exits before any test controller or worker can be created.

import { spawn } from "node:child_process";
import { lstat, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { appendProgressIfConfigured, delay } from "./lib/incremental-output.mjs";

const lockPath = process.env.TCRN_TEST_CONTROLLER_LOCK_PATH;
const outerPid = Number(process.env.TCRN_TEST_CONTROLLER_OUTER_PID);
const readyPath = process.env.TCRN_TEST_BIND_WINDOW_READY_PATH;
const orphanPath = process.env.TCRN_TEST_BIND_WINDOW_ORPHAN_PATH;
const boundPath = process.env.TCRN_TEST_BIND_WINDOW_BOUND_PATH;
const runPath = process.env.TCRN_TEST_BIND_WINDOW_RUN_PATH;
const progressPath = process.env.TCRN_TEST_CONTROLLER_PROGRESS_PATH;
const coverageDirectory = process.env.TCRN_TEST_CONTROLLER_COVERAGE_DIRECTORY ?? process.env.NODE_V8_COVERAGE;
const orphanDelay = Number(process.env.TCRN_TEST_BIND_WINDOW_ORPHAN_DELAY_MS ?? "0");
const testArguments = process.argv.slice(2);
const childPolicyImport = new URL("./test-controller-child-policy.mjs", import.meta.url).href;
const reaperPath = fileURLToPath(new URL("./test-controller-reaper.mjs", import.meta.url));

function validAbsolutePath(path) {
  return typeof path === "string" && path.startsWith("/") && !path.includes("\0");
}

function parentIsGone() {
  if (process.ppid !== outerPid) return true;
  try {
    process.kill(outerPid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}

async function testWindowRecord(path, value) {
  if (!path) return;
  if (!validAbsolutePath(path)) throw new Error("TEST_CONTROLLER_BIND_WINDOW_PATH_INVALID");
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
}

function abort(reasonCode = "TEST_CONTROLLER_INPUT_INVALID") {
  // Returning from an import hook after setting exitCode would still let
  // `node --test` discover tests.  This bootstrap instead exits before it
  // has spawned Node's test controller at all.
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode })}\n`); process.exit(1);
}

async function waitForDurableGroupBinding() {
  await testWindowRecord(readyPath, { processGroup: process.pid, outerPid, state: "unbound" });
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    let owner;
    try {
      const metadata = await lstat(lockPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("TEST_CONTROLLER_LOCK_INVALID");
      owner = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8"));
    } catch (error) {
      if (parentIsGone()) return false;
      throw error;
    }
    if (owner?.pid !== outerPid) {
      if (parentIsGone()) return false;
      throw new Error("TEST_CONTROLLER_OWNER_CHANGED");
    }
    if (owner.processGroup === process.pid) return true;
    if (owner.processGroup !== null) throw new Error("TEST_CONTROLLER_GROUP_MISMATCH");
    if (parentIsGone()) return false;
    await delay(10);
  }
  throw new Error("TEST_CONTROLLER_GROUP_BIND_TIMEOUT");
}

async function waitForTestControllerRunGate() {
  if (!boundPath && !runPath) return;
  if (!validAbsolutePath(boundPath) || !validAbsolutePath(runPath)) throw new Error("TEST_CONTROLLER_BIND_WINDOW_PATH_INVALID");
  await testWindowRecord(boundPath, { processGroup: process.pid, outerPid, state: "bound-before-controller" });
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    try {
      await lstat(runPath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error("TEST_CONTROLLER_RUN_GATE_TIMEOUT");
}

function waitForReaperMessage(reaper, type) {
  return new Promise((resolveMessage, rejectMessage) => {
    const onMessage = (message) => {
      if (message?.type === type) {
        cleanup();
        resolveMessage(message);
      } else if (message?.type === "error") {
        cleanup();
        rejectMessage(new Error(message.code));
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectMessage(new Error(`TEST_CONTROLLER_REAPER_EXITED:${code ?? signal}`));
    };
    const cleanup = () => {
      reaper.off("message", onMessage);
      reaper.off("exit", onExit);
    };
    reaper.on("message", onMessage);
    reaper.once("exit", onExit);
  });
}

if (!validAbsolutePath(lockPath) || !Number.isSafeInteger(outerPid) || outerPid <= 0 || testArguments.length === 0) {
  abort("TEST_CONTROLLER_REQUIRED");
}

if (!await waitForDurableGroupBinding()) {
  await testWindowRecord(orphanPath, { processGroup: process.pid, outerPid, state: "orphaned-before-bind" });
  await appendProgressIfConfigured(progressPath, "orphaned-before-bind", { processGroup: process.pid, outerPid });
  if (Number.isSafeInteger(orphanDelay) && orphanDelay > 0 && orphanDelay <= 10_000) await delay(orphanDelay);
  // No `node --test` process has been spawned in this branch.
  process.exit(0);
}

// This test-only gate exposes the post-bind/pre-controller interval.  Once
// binding succeeded, the bootstrap itself is a recorded group member, so a
// dead outer task must remain unrecoverable until this group exits.
await waitForTestControllerRunGate();

// Test-controller output goes to private regular files, never inherited pipes.
// The policy preload refuses a detached child that would escape the recorded
// group. The detached reaper terminates any remaining same-group descendants
// before output is read and the command-wide session may be released.
const outputDirectory = await mkdtemp(join(tmpdir(), "tcrn-test-controller-"));
const stdoutPath = join(outputDirectory, "stdout");
const stderrPath = join(outputDirectory, "stderr");
const stdoutFile = await open(stdoutPath, "w", 0o600);
const stderrFile = await open(stderrPath, "w", 0o600);
// INVARIANT: this file MUST NOT be preloaded with test-controller-child-policy.mjs.
// This detached spawn is the proof -- that policy refuses `detached: true`
// unconditionally, so preloading it here would refuse the reaper before it starts.
const reaper = spawn(process.execPath, [reaperPath, String(process.pid), String(process.pid), outputDirectory], {
  detached: true,
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
let testController;
let controllerResult;
let cleanupErrors = [];
let outputFilesClosed = false;
let reaperCleaned = false;
let reaperDisposed = false;

function describeError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    reasonCode: error?.reasonCode ?? null,
    message: error?.message ?? String(error),
  };
}

function waitForChildExit(child) {
  if (!child) return Promise.resolve({code: null, signal: null});
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({code: child.exitCode, signal: child.signalCode});
  }
  return new Promise((resolveExit, rejectExit) => {
    const onError = (error) => {
      child.off("exit", onExit);
      rejectExit(error);
    };
    const onExit = (code, signal) => {
      child.off("error", onError);
      resolveExit({code, signal});
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function closeOutputFiles() {
  if (outputFilesClosed) return;
  await stdoutFile.close().catch((error) => cleanupErrors.push({operation: "stdout-close", ...describeError(error)}));
  await stderrFile.close().catch((error) => cleanupErrors.push({operation: "stderr-close", ...describeError(error)}));
  outputFilesClosed = true;
}

async function readControllerOutput() {
  try {
    return {
      stdout: await readFile(stdoutPath),
      stderr: await readFile(stderrPath),
    };
  } catch (error) {
    cleanupErrors.push({operation: "controller-output-read", ...describeError(error)});
    return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
  }
}

async function joinReaper() {
  if (!reaper || !reaper.connected) {
    cleanupErrors.push({operation: "reaper-clean", code: "IPC_DISCONNECTED", message: "reaper IPC channel is not connected"});
    return {code: reaper?.exitCode ?? null, signal: reaper?.signalCode ?? null};
  }
  try {
    reaper.send({type: "cleanup"});
    await waitForReaperMessage(reaper, "clean");
    reaperCleaned = true;
  } catch (error) {
    cleanupErrors.push({operation: "reaper-clean", ...describeError(error)});
    try { reaper.kill("SIGTERM"); } catch (killError) { cleanupErrors.push({operation: "reaper-signal", ...describeError(killError)}); }
  }
  return {code: null, signal: null};
}

async function disposeReaper() {
  if (!reaper || reaperDisposed) return {code: null, signal: null};
  if (reaper.connected) {
    try { reaper.send({type: "dispose"}); }
    catch (error) { cleanupErrors.push({operation: "reaper-dispose-send", ...describeError(error)}); }
  }
  const terminal = await waitForChildExit(reaper).catch((error) => {
    cleanupErrors.push({operation: "reaper-join", ...describeError(error)});
    return {error};
  });
  if (terminal?.error === undefined && (terminal?.code !== 0 || terminal?.signal !== null)) {
    cleanupErrors.push({operation: "reaper-exit", code: terminal.code, signal: terminal.signal, message: "reaper did not exit successfully"});
  }
  reaperDisposed = true;
  return terminal;
}
try {
  await waitForReaperMessage(reaper, "ready");
  // INVARIANT: this file MUST NOT be preloaded with test-controller-child-policy.mjs.
  // These are private regular-file descriptors, not inherited controller output, but
  // the policy's stdio allowlist cannot tell the difference without an fstat on a hot
  // path, so it would refuse this spawn. The allowlist stays fail-closed deliberately;
  // the detached reaper spawn above proves this file runs unpreloaded.
  await appendProgressIfConfigured(progressPath, "bound-before-controller", { processGroup: process.pid, outerPid, reaperPid: reaper.pid, coverageDirectory: coverageDirectory ?? null });
  const controllerEnvironment = { ...process.env, TCRN_TEST_CONTROLLER_PROCESS_GROUP: String(process.pid) };
  if (coverageDirectory) controllerEnvironment.NODE_V8_COVERAGE = coverageDirectory;
  testController = spawn(process.execPath, ["--import", childPolicyImport, ...testArguments], {
    stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
    env: controllerEnvironment,
  });
  await appendProgressIfConfigured(progressPath, "controller-started", { pid: testController.pid, processGroup: process.pid, reaperPid: reaper.pid, coverageDirectory: coverageDirectory ?? null });
  controllerResult = await new Promise((resolveResult, rejectResult) => {
    testController.once("error", rejectResult);
    testController.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  await appendProgressIfConfigured(progressPath, "controller-exited", {
    pid: testController.pid,
    processGroup: process.pid,
    code: controllerResult.code,
    signal: controllerResult.signal,
    ok: controllerResult.code === 0 && controllerResult.signal === null,
    coverageDirectory: coverageDirectory ?? null,
  });
  await closeOutputFiles();
  await joinReaper();
  const {stdout, stderr} = await readControllerOutput();
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const reaperTerminal = await disposeReaper();
  await appendProgressIfConfigured(progressPath, "completed", {
    ok: controllerResult.code === 0 && controllerResult.signal === null && cleanupErrors.length === 0,
    primaryOk: controllerResult.code === 0 && controllerResult.signal === null,
    code: controllerResult.code,
    signal: controllerResult.signal,
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    processGroup: process.pid,
    controllerPid: testController.pid,
    reaperPid: reaper.pid,
    reaperTerminal,
    coverageDirectory: coverageDirectory ?? null,
    writerQuiescent: cleanupErrors.length === 0,
    cleanupErrors,
  });
  if (cleanupErrors.length > 0) {
    const cleanupFailure = new Error(JSON.stringify({
      primaryError: controllerResult.code === 0 && controllerResult.signal === null ? null : {
        code: controllerResult.code,
        signal: controllerResult.signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      },
      cleanupErrors,
      processGroup: process.pid,
      controllerPid: testController.pid,
      reaperPid: reaper.pid,
      reaperTerminal,
      coverageDirectory: coverageDirectory ?? null,
    }));
    cleanupFailure.code = "TEST_CONTROLLER_CLEANUP_FAILED";
    throw cleanupFailure;
  }
  // Keep a simple terminal assignment as the fixture boundary used by the
  // lifecycle tests; `result` is the already joined worker terminal state.
  const result = controllerResult;
  process.exitCode = result.code ?? (result.signal ? 1 : 1);
} catch (error) {
  const primaryError = controllerResult && (controllerResult.code !== 0 || controllerResult.signal !== null)
    ? {code: controllerResult.code, signal: controllerResult.signal, message: "test controller exited unsuccessfully"}
    : describeError(error);
  if (testController && testController.exitCode === null && testController.signalCode === null) {
    try { testController.kill("SIGTERM"); } catch (killError) { cleanupErrors.push({operation: "controller-signal", ...describeError(killError)}); }
    await waitForChildExit(testController).catch((waitError) => cleanupErrors.push({operation: "controller-join", ...describeError(waitError)}));
  }
  await closeOutputFiles();
  const output = await readControllerOutput();
  if (!reaperCleaned && reaper?.exitCode === null && reaper?.signalCode === null) await joinReaper();
  const reaperTerminal = reaperDisposed ? null : await disposeReaper();
  const evidence = {
    primaryError,
    cleanupErrors,
    stdout: output.stdout.toString("utf8"),
    stderr: output.stderr.toString("utf8"),
    processGroup: process.pid,
    controllerPid: testController?.pid ?? null,
    controllerTerminal: controllerResult ?? (testController ? {code: testController.exitCode, signal: testController.signalCode} : null),
    reaperPid: reaper?.pid ?? null,
    reaperTerminal,
    coverageDirectory: coverageDirectory ?? null,
    writerQuiescent: cleanupErrors.length === 0,
  };
  await appendProgressIfConfigured(progressPath, "error", {
    reasonCode: error?.code ?? error?.message ?? "TEST_CONTROLLER_FAILED",
    ...evidence,
  }).catch((progressError) => cleanupErrors.push({operation: "progress-error", ...describeError(progressError)}));
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  const wrapped = new Error(JSON.stringify(evidence));
  wrapped.code = error?.code ?? "TEST_CONTROLLER_FAILED";
  throw wrapped;
}
