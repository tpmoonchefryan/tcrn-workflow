// SPDX-License-Identifier: Apache-2.0
// The advisory:verify stop branch (TCRN-CROSS-STORY-374). This module owns the
// only command lookup and command runner used by both host adapters. A pact may
// carry an explicit workspace/work id; the engine is asked for that exact record
// and no nearest/active-work inference is permitted.

import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERIFY_TIMEOUT_MS = 8_000;
export const WORK_SHOW_TIMEOUT_MS = 1_500;
export const MAX_STDERR_TAIL_BYTES = 500;

const ENGINE_CLI = join(fileURLToPath(new URL("../../scripts/tcrn-workflow.mjs", import.meta.url)));
const WORK_ID_PATTERN = /^work:[a-z0-9][a-z0-9._-]{0,127}$/u;

function text(value) {
  return typeof value === "string" ? value : "";
}

// Truncate by UTF-8 bytes, not JavaScript code units. The reason is injected into
// a host response and the contract caps the byte tail; dropping a leading UTF-8
// continuation byte keeps the returned string well-formed.
export function utf8Tail(value, maxBytes = MAX_STDERR_TAIL_BYTES) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(text(value), "utf8");
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function unavailable(reason) {
  return { status: "unavailable", command: null, reason };
}

/** Read the verify command from one explicitly named work record. */
export function readAdvisoryVerify({ workspace, workId, engineCli = ENGINE_CLI } = {}) {
  if (!isAbsolute(text(workspace)) || !WORK_ID_PATTERN.test(text(workId))) {
    return unavailable("pact is not bound to a qualified workspace and work id");
  }
  if (!isAbsolute(text(engineCli))) return unavailable("workflow engine is unavailable");

  let result;
  try {
    result = spawnSync(process.execPath, [
      engineCli,
      "work-show",
      "--workspace",
      workspace,
      "--id",
      workId,
    ], {
      cwd: workspace,
      encoding: "utf8",
      timeout: WORK_SHOW_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
  } catch (error) {
    return unavailable(`workflow engine could not be read: ${String(error?.message ?? error)}`);
  }
  if (result.error || result.status !== 0) {
    return unavailable("workflow engine could not read the bound work record");
  }

  let body;
  try {
    body = JSON.parse(text(result.stdout));
  } catch {
    return unavailable("workflow engine returned no readable bound work record");
  }
  if (body?.record?.id !== workId) return unavailable("workflow engine returned a different work record");
  const command = body?.advisory?.verify;
  if (command === undefined || command === null || command === "") {
    return { status: "absent", command: null, reason: "no advisory:verify command is recorded" };
  }
  if (typeof command !== "string" || command.includes("\u0000")) {
    return unavailable("bound advisory:verify command is malformed");
  }
  return { status: "available", command, reason: "advisory:verify command is recorded" };
}

function failureReason({ stderr, timedOut, error, status, signal }) {
  const tail = utf8Tail(stderr);
  if (tail.length > 0) return tail;
  if (timedOut) return `verify command timed out after ${VERIFY_TIMEOUT_MS}ms`;
  if (error) return `verify command could not start: ${String(error?.message ?? error)}`;
  if (signal) return `verify command terminated by ${signal}`;
  return `verify command exited with code ${status === null ? "unknown" : String(status)}`;
}

function killProcessGroup(child, signal) {
  if (!child || typeof child.pid !== "number") return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* process already ended */ }
  }
}

function appendTail(current, chunk) {
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  const combined = current.length === 0 ? next : Buffer.concat([current, next]);
  return combined.length <= MAX_STDERR_TAIL_BYTES
    ? combined
    : combined.subarray(combined.length - MAX_STDERR_TAIL_BYTES);
}

/**
 * Run one owner-recorded command without a shell parser supplied by the caller.
 * The command is intentionally interpreted by /bin/sh because the advisory is a
 * command string; argv construction remains explicit and the detached child group
 * is killed on timeout so grandchildren cannot outlive the Stop hook.
 */
export function runVerification(command, cwd, { timeoutMs = VERIFY_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  if (typeof command !== "string" || command.length === 0 || command.includes("\u0000")) {
    return Promise.resolve({ status: "failed", ok: false, reason: "verify command is malformed" });
  }
  if (!isAbsolute(text(cwd))) {
    return Promise.resolve({ status: "failed", ok: false, reason: "verify working directory is unavailable" });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl("/bin/sh", ["-c", command], {
        cwd,
        detached: true,
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      resolve({ status: "failed", ok: false, reason: failureReason({ error, stderr: "" }) });
      return;
    }

    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    let timeoutTimer;
    let forceTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve(result);
    };
    if (child?.stderr?.on) child.stderr.on("data", (chunk) => { stderr = appendTail(stderr, chunk); });
    child?.once?.("error", (error) => {
      if (timedOut) return;
      finish({ status: "failed", ok: false, reason: failureReason({ error, stderr }) });
    });
    child?.once?.("close", (status, signal) => {
      if (timedOut) {
        finish({ status: "failed", ok: false, timedOut: true, reason: failureReason({ stderr, timedOut: true }) });
        return;
      }
      if (status === 0) {
        finish({ status: "passed", ok: true, exitCode: 0, stderr: utf8Tail(stderr) });
        return;
      }
      finish({ status: "failed", ok: false, exitCode: status, signal, reason: failureReason({ stderr, status, signal }) });
    });
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      forceTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
        finish({ status: "failed", ok: false, timedOut: true, reason: failureReason({ stderr, timedOut: true }) });
      }, 250);
    }, Math.max(1, timeoutMs));
  });
}

/** Synchronous adapter retained for the synchronous executor API and unit tests. */
export function runVerificationSync(command, cwd, { timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  if (typeof command !== "string" || command.length === 0 || command.includes("\u0000")) {
    return { status: "failed", ok: false, reason: "verify command is malformed" };
  }
  if (!isAbsolute(text(cwd))) {
    return { status: "failed", ok: false, reason: "verify working directory is unavailable" };
  }
  let result;
  try {
    result = spawnSync("/bin/sh", ["-c", command], {
      cwd,
      shell: false,
      timeout: Math.max(1, timeoutMs),
      maxBuffer: 64 * 1024,
      encoding: "buffer",
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    return { status: "failed", ok: false, reason: failureReason({ error, stderr: "" }) };
  }
  const stderr = result.stderr ?? Buffer.alloc(0);
  const timedOut = result.error?.code === "ETIMEDOUT" || (result.status === null && result.signal === "SIGTERM");
  if (result.status === 0 && !result.error) return { status: "passed", ok: true, exitCode: 0, stderr: utf8Tail(stderr) };
  return {
    status: "failed",
    ok: false,
    timedOut,
    exitCode: result.status,
    signal: result.signal,
    reason: failureReason({ stderr, timedOut, error: timedOut ? null : result.error, status: result.status, signal: result.signal }),
  };
}

export function verifyPactBinding(pact, sessionId) {
  if (pact?.status !== "running" || pact?.active !== true) return { status: "skipped", reason: "pact is not running" };
  if (typeof pact.boundSession === "string" && pact.boundSession !== sessionId) return { status: "skipped", reason: "pact belongs to another session" };
  return readAdvisoryVerify({ workspace: pact.workspace, workId: pact.workId });
}

/** Record the result without putting command output or private process data in telemetry. */
export async function recordVerificationTelemetry(pact, sessionId, result) {
  if (!pact?.workspace || result?.status !== "passed" && result?.status !== "failed") return null;
  try {
    const core = await import("../../dist/build/packages/core/src/index.js");
    const state = await core.materializeWorkspace(pact.workspace);
    const transient = core.activeBinding(state.metadata).find((entry) => entry.kind === "transient");
    if (transient === undefined) return null;
    const record = core.createTelemetryRecord({
      at: new Date().toISOString(),
      kind: "verify",
      session: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : "unknown-stop-session",
      payload: {
        source: "stop-pact:verify",
        availability: "available",
        passed: result.ok === true,
        exitCode: result.exitCode ?? null,
        timedOut: result.timedOut === true,
      },
    });
    return await core.appendTelemetryRecord(transient.path, record);
  } catch {
    return null;
  }
}
