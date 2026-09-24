// SPDX-License-Identifier: Apache-2.0
// STORY-373: one-shot, no-shell host model probe. The host owns credentials and
// output semantics; this module only returns a bounded observation.

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";

export const HOST_PROBE_HOSTS = Object.freeze(["claude-code", "codex"] as const);
export const HOST_PROBE_DEFAULT_TIMEOUT_MS = 30_000 as const;
export const HOST_PROBE_OUTPUT_BYTES = 65_536 as const;
export type HostProbeHost = typeof HOST_PROBE_HOSTS[number];

export interface HostProbeResult {
  readonly schemaVersion: "tcrn.host-probe.v1";
  readonly host: HostProbeHost;
  readonly model: string;
  readonly command: readonly string[];
  readonly ok: boolean;
  readonly reasonCode: string;
  readonly availability: "available" | "unavailable";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
}

export class HostProbeError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "HostProbeError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: string, message: string): never {
  throw new HostProbeError(reasonCode, message);
}

function boundedModel(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\u0000") || !value.isWellFormed()) {
    fail("HOST_PROBE_MODEL_INVALID", "model must be non-empty, bounded, well-formed text");
  }
  return value;
}

function host(value: unknown): HostProbeHost {
  if (!(HOST_PROBE_HOSTS as readonly string[]).includes(value as string)) {
    fail("HOST_PROBE_HOST_UNKNOWN", `host must be one of ${HOST_PROBE_HOSTS.join(", ")}`);
  }
  return value as HostProbeHost;
}

function argumentsFor(selectedHost: HostProbeHost, model: string): readonly string[] {
  return selectedHost === "claude-code"
    ? ["-p", "--bare", "--model", model]
    : ["exec", "-m", model, "-s", "read-only", "--ephemeral"];
}

/**
 * TCRN-CROSS-INC-387 (STORY-461 R3): the host CLI a probe runs, by the rule resolveModelCli in
 * scripts/injection-session.mjs uses. For Claude Code the host's own executable wins when
 * CLAUDE_CODE_EXECPATH names an executable regular file; otherwise `claude` runs from PATH, which
 * can be an older standalone install that does not know the host's models (problem #235). No
 * variable names a Codex host's executable, so Codex runs `codex` from PATH. The result adds no
 * field: command[0] names what ran, an absolute path for the host CLI, the bare name for PATH.
 */
function defaultExecutable(selectedHost: HostProbeHost, env: NodeJS.ProcessEnv): string {
  if (selectedHost === "codex") return "codex";
  const hostExecutable = env.CLAUDE_CODE_EXECPATH ?? "";
  if (hostExecutable.length > 0) {
    try {
      accessSync(hostExecutable, fsConstants.X_OK);
      if (statSync(hostExecutable).isFile()) return hostExecutable;
    } catch { /* not executable here: fall back to PATH */ }
  }
  return "claude";
}

function text(value: Buffer, state: { bytes: number; truncated: boolean }): void {
  state.bytes += value.byteLength;
  if (state.bytes > HOST_PROBE_OUTPUT_BYTES) state.truncated = true;
}

function appendBounded(chunks: string[], value: Buffer, state: { bytes: number; truncated: boolean }): void {
  if (state.truncated && state.bytes > HOST_PROBE_OUTPUT_BYTES) return;
  const remaining = HOST_PROBE_OUTPUT_BYTES - state.bytes;
  if (value.byteLength <= remaining) {
    chunks.push(value.toString("utf8"));
    state.bytes += value.byteLength;
    return;
  }
  if (remaining > 0) {
    let end = remaining;
    while (end > 0 && (value[end]! & 0xc0) === 0x80) end -= 1;
    chunks.push(value.subarray(0, end).toString("utf8"));
  }
  text(value, state);
}

function terminate(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* the process already exited */ }
  }
}

function reasonFor(exitCode: number | null, stderr: string, truncated: boolean): string {
  if (truncated) return "HOST_PROBE_OUTPUT_TRUNCATED";
  if (exitCode === 0) return "HOST_PROBE_SUCCEEDED";
  if (/(?:auth|credential|login|unauthori|forbidden|api[ _-]?key|token)/iu.test(stderr)) return "HOST_PROBE_AUTH_FAILED";
  return "HOST_PROBE_EXIT_NONZERO";
}

export async function probeHost(input: {
  readonly host: unknown;
  readonly model: unknown;
  readonly timeoutMs?: number;
  /** Test seam only; production callers run the host's own CLI, or the PATH command (defaultExecutable). */
  readonly executable?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<HostProbeResult> {
  const selectedHost = host(input.host);
  const model = boundedModel(input.model);
  const timeoutMs = input.timeoutMs ?? HOST_PROBE_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    fail("HOST_PROBE_TIMEOUT_INVALID", "timeoutMs must be an integer from 100 through 120000");
  }
  const env = input.env ?? process.env;
  const args = argumentsFor(selectedHost, model);
  const executable = input.executable ?? defaultExecutable(selectedHost, env);
  if (typeof executable !== "string" || executable.length === 0 || executable.includes("\u0000") || !executable.isWellFormed()) {
    fail("HOST_PROBE_EXECUTABLE_INVALID", "executable must be non-empty well-formed text");
  }
  const command = [executable, ...args];
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutState = { bytes: 0, truncated: false };
  const stderrState = { bytes: 0, truncated: false };
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, availability: "available" | "unavailable", spawnFailure = false): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      const truncated = stdoutState.truncated || stderrState.truncated;
      const reasonCode = timedOut
        ? "HOST_PROBE_TIMEOUT"
        : spawnFailure
          ? "HOST_PROBE_CLI_UNAVAILABLE"
          : reasonFor(exitCode, stderrChunks.join(""), truncated);
      resolve({
        schemaVersion: "tcrn.host-probe.v1",
        host: selectedHost,
        model,
        command,
        ok: reasonCode === "HOST_PROBE_SUCCEEDED",
        reasonCode,
        availability,
        exitCode,
        signal,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        stdoutTruncated: stdoutState.truncated,
        stderrTruncated: stderrState.truncated,
        timedOut,
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        detached: true,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      finish(null, null, "unavailable", true);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => appendBounded(stdoutChunks, chunk, stdoutState));
    child.stderr?.on("data", (chunk: Buffer) => appendBounded(stderrChunks, chunk, stderrState));
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(null, null, error.code === "ENOENT" ? "unavailable" : "available", error.code === "ENOENT");
    });
    child.once("close", (exitCode, signal) => finish(exitCode, signal, "available"));
    timer = setTimeout(() => {
      timedOut = true;
      terminate(child, "SIGTERM");
      setTimeout(() => terminate(child, "SIGKILL"), 250).unref();
    }, timeoutMs);
  });
}
