// SPDX-License-Identifier: Apache-2.0

// This detached process is the command's process-group leader.  It waits for
// that group to be durably recorded in the output-session owner before it
// starts `node --test`.  If its task parent dies while the group is unbound,
// it exits before any test controller or worker can be created.

import { spawn } from "node:child_process";
import { lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const lockPath = process.env.TCRN_TEST_CONTROLLER_LOCK_PATH;
const outerPid = Number(process.env.TCRN_TEST_CONTROLLER_OUTER_PID);
const readyPath = process.env.TCRN_TEST_BIND_WINDOW_READY_PATH;
const orphanPath = process.env.TCRN_TEST_BIND_WINDOW_ORPHAN_PATH;
const boundPath = process.env.TCRN_TEST_BIND_WINDOW_BOUND_PATH;
const runPath = process.env.TCRN_TEST_BIND_WINDOW_RUN_PATH;
const orphanDelay = Number(process.env.TCRN_TEST_BIND_WINDOW_ORPHAN_DELAY_MS ?? "0");
const testArguments = process.argv.slice(2);
const childPolicyImport = new URL("./test-controller-child-policy.mjs", import.meta.url).href;
const reaperPath = fileURLToPath(new URL("./test-controller-reaper.mjs", import.meta.url));

function validAbsolutePath(path) {
  return typeof path === "string" && path.startsWith("/") && !path.includes("\0");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function abort() {
  // Returning from an import hook after setting exitCode would still let
  // `node --test` discover tests.  This bootstrap instead exits before it
  // has spawned Node's test controller at all.
  process.exit(1);
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
  abort();
}

if (!await waitForDurableGroupBinding()) {
  await testWindowRecord(orphanPath, { processGroup: process.pid, outerPid, state: "orphaned-before-bind" });
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
// group.  The detached reaper terminates any remaining same-group descendants
// before output is read and the command-wide session may be released.
const outputDirectory = await mkdtemp(join(tmpdir(), "tcrn-test-controller-"));
const stdoutPath = join(outputDirectory, "stdout");
const stderrPath = join(outputDirectory, "stderr");
const stdoutFile = await open(stdoutPath, "w", 0o600);
const stderrFile = await open(stderrPath, "w", 0o600);
const reaper = spawn(process.execPath, [reaperPath, String(process.pid), String(process.pid), outputDirectory], {
  detached: true,
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
try {
  await waitForReaperMessage(reaper, "ready");
  const testController = spawn(process.execPath, ["--import", childPolicyImport, ...testArguments], {
    stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
    env: { ...process.env, TCRN_TEST_CONTROLLER_PROCESS_GROUP: String(process.pid) },
  });
  const result = await new Promise((resolveResult, rejectResult) => {
    testController.once("error", rejectResult);
    testController.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  await stdoutFile.close();
  await stderrFile.close();
  reaper.send({ type: "cleanup" });
  await waitForReaperMessage(reaper, "clean");
  const [stdout, stderr] = await Promise.all([readFile(stdoutPath), readFile(stderrPath)]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const reaperExit = new Promise((resolveExit) => reaper.once("exit", resolveExit));
  reaper.send({ type: "dispose" });
  await reaperExit;
  process.exitCode = result.code ?? (result.signal ? 1 : 1);
} catch (error) {
  await stdoutFile.close().catch(() => undefined);
  await stderrFile.close().catch(() => undefined);
  reaper.kill("SIGTERM");
  await rm(outputDirectory, { recursive: true, force: true });
  throw error;
}
