// SPDX-License-Identifier: Apache-2.0

// This detached process is the command's process-group leader.  It waits for
// that group to be durably recorded in the output-session owner before it
// starts `node --test`.  If its task parent dies while the group is unbound,
// it exits before any test controller or worker can be created.

import { spawn } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";

const lockPath = process.env.TCRN_TEST_CONTROLLER_LOCK_PATH;
const outerPid = Number(process.env.TCRN_TEST_CONTROLLER_OUTER_PID);
const readyPath = process.env.TCRN_TEST_BIND_WINDOW_READY_PATH;
const orphanPath = process.env.TCRN_TEST_BIND_WINDOW_ORPHAN_PATH;
const boundPath = process.env.TCRN_TEST_BIND_WINDOW_BOUND_PATH;
const runPath = process.env.TCRN_TEST_BIND_WINDOW_RUN_PATH;
const orphanDelay = Number(process.env.TCRN_TEST_BIND_WINDOW_ORPHAN_DELAY_MS ?? "0");
const testArguments = process.argv.slice(2);

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

// Keep the test controller's streams private to this bootstrap.  With
// `inherit`, a worker (or an orphan it created) can retain the bootstrap's
// task-facing pipe after the controller exits.  That prevents the outer task
// from observing the bootstrap close and strands its command-wide session.
// The bootstrap forwards controller output while it is alive, but its own
// streams are never inherited by controller descendants.
const testController = spawn(process.execPath, testArguments, {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, TCRN_TEST_CONTROLLER_PROCESS_GROUP: String(process.pid) },
});
testController.stdout.on("data", (chunk) => process.stdout.write(chunk));
testController.stderr.on("data", (chunk) => process.stderr.write(chunk));
const result = await new Promise((resolveResult, rejectResult) => {
  testController.once("error", rejectResult);
  // The controller's `close` waits for its inherited descriptors to close.
  // A detached descendant can retain those descriptors after the controller
  // has exited, which is outside this command's recorded process group.  The
  // outer task independently waits for the recorded group before releasing
  // its output session; use `exit` here so an unrelated pipe holder cannot
  // deadlock that release boundary.
  testController.once("exit", (code, signal) => resolveResult({ code, signal }));
});
testController.stdout.destroy();
testController.stderr.destroy();
process.exitCode = result.code ?? (result.signal ? 1 : 1);
