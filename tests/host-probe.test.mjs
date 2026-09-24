// SPDX-License-Identifier: Apache-2.0
// STORY-373 — host-probe runs a bounded no-shell host command and exposes its result.

import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { probeHost, HOST_PROBE_OUTPUT_BYTES } from "../dist/build/packages/core/src/host-probe.js";
import { COMMAND_CATALOG } from "../dist/build/packages/cli/src/index.js";

const HOST_PROBE_MODULE_URL = new URL("../dist/build/packages/core/src/host-probe.js", import.meta.url).href;

async function fakeExecutable(t, source) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tcrn-host-probe-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "fake-host");
  await writeFile(path, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function runUnpreloadedRelay(t, source) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tcrn-host-probe-relay-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scriptPath = join(directory, "relay.mjs");
  await writeFile(scriptPath, `import { probeHost } from ${JSON.stringify(HOST_PROBE_MODULE_URL)};\n${source}\n`, { mode: 0o700 });
  const child = spawn("/usr/bin/env", ["-u", "NODE_OPTIONS", process.execPath, scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "close");
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}

test("STORY-373: host-probe passes model text as one argv value without a shell", async (t) => {
  const executable = await fakeExecutable(t, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const model = "model; touch /tmp/host-probe-must-not-run";
  const result = await runUnpreloadedRelay(t, `const result = await probeHost({ host: "claude-code", model: ${JSON.stringify(model)}, executable: ${JSON.stringify(executable)}, env: process.env }); process.stdout.write(JSON.stringify(result));`);
  assert.equal(result.reasonCode, "HOST_PROBE_SUCCEEDED");
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.stdout), ["-p", "--bare", "--model", model]);
  assert.deepEqual(result.command, [executable, "-p", "--bare", "--model", model]);
});

test("STORY-373: missing CLI, authentication failure, timeout, and output truncation stay distinct", async (t) => {
  const missing = await probeHost({ host: "codex", model: "missing", executable: join(tmpdir(), "no-such-host-probe") });
  assert.equal(missing.reasonCode, "HOST_PROBE_CLI_UNAVAILABLE");
  assert.equal(missing.availability, "unavailable");

  const authExecutable = await fakeExecutable(t, "process.stderr.write('authentication required'); process.exitCode = 7");
  const auth = (await runUnpreloadedRelay(t, `const result = await probeHost({ host: "codex", model: "auth-model", executable: ${JSON.stringify(authExecutable)}, env: process.env }); process.stdout.write(JSON.stringify(result));`));
  assert.equal(auth.reasonCode, "HOST_PROBE_AUTH_FAILED");
  assert.equal(auth.exitCode, 7);
  assert.match(auth.stderr, /authentication required/u);

  const timeoutExecutable = await fakeExecutable(t, "setTimeout(() => {}, 10_000)");
  const timedOut = await runUnpreloadedRelay(t, `const result = await probeHost({ host: "claude-code", model: "slow", executable: ${JSON.stringify(timeoutExecutable)}, timeoutMs: 100, env: process.env }); process.stdout.write(JSON.stringify(result));`);
  assert.equal(timedOut.reasonCode, "HOST_PROBE_TIMEOUT");
  assert.equal(timedOut.timedOut, true);

  const outputExecutable = await fakeExecutable(t, "process.stdout.write('x'.repeat(70_000))");
  const truncated = await runUnpreloadedRelay(t, `const result = await probeHost({ host: "claude-code", model: "loud", executable: ${JSON.stringify(outputExecutable)}, env: process.env }); process.stdout.write(JSON.stringify(result));`);
  assert.equal(truncated.reasonCode, "HOST_PROBE_OUTPUT_TRUNCATED");
  assert.equal(truncated.ok, false);
  assert.ok(Buffer.byteLength(truncated.stdout, "utf8") <= HOST_PROBE_OUTPUT_BYTES);
  assert.equal(truncated.stdoutTruncated, true);
});

test("STORY-373: Codex and Claude argv forms are fixed and input validation is fail-closed", async (t) => {
  const result = await runUnpreloadedRelay(t, `const result = await probeHost({ host: "codex", model: "model", executable: process.execPath, env: process.env }); process.stdout.write(JSON.stringify(result));`);
  assert.deepEqual(result.command.slice(1), ["exec", "-m", "model", "-s", "read-only", "--ephemeral"]);
  await assert.rejects(probeHost({ host: "unknown", model: "model" }), (error) => error?.reasonCode === "HOST_PROBE_HOST_UNKNOWN");
  await assert.rejects(probeHost({ host: "codex", model: "" }), (error) => error?.reasonCode === "HOST_PROBE_MODEL_INVALID");
});

test("STORY-373: host-probe is a read-only catalog command with explicit host and model flags", () => {
  const entry = COMMAND_CATALOG.find((candidate) => candidate.name === "host-probe");
  assert.deepEqual(entry, {
    name: "host-probe",
    availability: "cli",
    mutates: false,
    flags: [
      { name: "host", required: true, valueKind: "string" },
      { name: "model", required: true, valueKind: "string" },
      { name: "timeout-ms", required: false, valueKind: "integer" },
    ],
  });
});

// TCRN-CROSS-INC-387 (STORY-461 R3): with no test executable, the Claude Code probe runs the CLI
// resolveModelCli would run: the host's own (CLAUDE_CODE_EXECPATH naming an executable regular
// file), else `claude` from PATH. command[0] names which one ran. Every case passes an env whose
// PATH is only a temporary directory, so no real claude or codex can start.
async function pathDirectory(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tcrn-host-probe-path-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function probeWithEnv(t, env) {
  return runUnpreloadedRelay(t, `const result = await probeHost({ host: "claude-code", model: "m", env: ${JSON.stringify(env)} }); process.stdout.write(JSON.stringify(result));`);
}

test("TCRN-CROSS-INC-387: without a test executable host-probe runs the host Claude CLI named by CLAUDE_CODE_EXECPATH", async (t) => {
  const host = await fakeExecutable(t, "process.stdout.write(`host ${JSON.stringify(process.argv.slice(2))}`)");
  const result = await probeWithEnv(t, { PATH: await pathDirectory(t), CLAUDE_CODE_EXECPATH: host });
  assert.deepEqual(result.command, [host, "-p", "--bare", "--model", "m"], "command[0] is the host CLI");
  assert.equal(result.reasonCode, "HOST_PROBE_SUCCEEDED");
  assert.equal(result.stdout, `host ${JSON.stringify(["-p", "--bare", "--model", "m"])}`);
});

test("TCRN-CROSS-INC-387: a usable host CLI wins over a claude on PATH and an unusable one falls back to the PATH claude named bare", async (t) => {
  const host = await fakeExecutable(t, "process.stdout.write('host')");
  const path = await pathDirectory(t);
  await writeFile(join(path, "claude"), `#!${process.execPath}\nprocess.stdout.write('path')\n`, { mode: 0o700 });
  await writeFile(join(path, "not-executable"), "", { mode: 0o600 });
  const preferred = await probeWithEnv(t, { PATH: path, CLAUDE_CODE_EXECPATH: host });
  assert.deepEqual([preferred.command[0], preferred.stdout], [host, "host"], "the host CLI runs even with a claude on PATH");
  for (const unusable of ["", join(path, "missing"), join(path, "not-executable"), path]) {
    const fallback = await probeWithEnv(t, { PATH: path, CLAUDE_CODE_EXECPATH: unusable });
    assert.deepEqual([fallback.command[0], fallback.stdout, fallback.reasonCode], ["claude", "path", "HOST_PROBE_SUCCEEDED"], `unusable host CLI ${JSON.stringify(unusable)}`);
  }
});
