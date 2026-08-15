#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// STORY-279: compile a catalog mutation into dist and require the catalog test
// to observe the missing optional effort flag.

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogSource = "packages/cli/src/index.ts";
const catalogTest = "tests/p3-cli-catalog.test.mjs";
const effortFlag = '{ name: "effort", required: false, valueKind: "string" }, ';

async function run(executable, args, cwd) {
  return execFile(executable, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

async function runAllowFailure(executable, args, cwd) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, npm_config_offline: "true", npm_config_user_agent: "pnpm/11.3.0 npm/? node/v24.16.0 darwin arm64" },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectResult);
    child.once("close", (status, signal) => resolveResult({ status, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function createScratch() {
  const scratch = await mkdtemp(join(tmpdir(), "tcrn-s279-catalog-"));
  await cp(repositoryRoot, scratch, {
    recursive: true,
    filter(source) {
      const relative = source.slice(repositoryRoot.length + 1);
      return !relative.startsWith(".git")
        && !relative.startsWith("dist")
        && !relative.startsWith("node_modules")
        && !relative.startsWith(".tcrn-artifacts")
        && !relative.startsWith(".tcrn-workspace")
        && !relative.startsWith(".claude")
        && !relative.startsWith(".codex");
    },
  });
  await cp(join(repositoryRoot, "node_modules"), join(scratch, "node_modules"), { recursive: true });
  await mkdir(join(scratch, ".git"), { recursive: true });
  return scratch;
}

async function proveMutation() {
  const scratch = await createScratch();
  try {
    const path = join(scratch, catalogSource);
    const source = await readFile(path, "utf8");
    if (source.split(effortFlag).length - 1 !== 1) throw new Error("S279_EFFORT_CATALOG_ANCHOR_NOT_UNIQUE");
    await writeFile(path, source.replace(effortFlag, ""));
    const build = await runAllowFailure(process.execPath, ["scripts/task.mjs", "build"], scratch);
    const test = build.status === 0
      ? await runAllowFailure(process.execPath, ["--test", "--test-name-pattern", "S279 model-plan-assign catalog", catalogTest], scratch)
      : { status: null, stdout: "", stderr: "" };
    return {
      build: { status: build.status, green: build.status === 0 },
      catalogTest: { status: test.status, intendedTestRed: test.status !== 0 && test.stdout.includes("S279 model-plan-assign catalog") },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const control = await createScratch();
let controlResult;
try {
  const build = await runAllowFailure(process.execPath, ["scripts/task.mjs", "build"], control);
  const test = build.status === 0
    ? await runAllowFailure(process.execPath, ["--test", "--test-name-pattern", "S279 model-plan-assign catalog", catalogTest], control)
    : { status: null, stdout: "", stderr: "" };
  controlResult = { buildStatus: build.status, testStatus: test.status, green: build.status === 0 && test.status === 0 };
} finally {
  await rm(control, { recursive: true, force: true });
}

const mutation = await proveMutation();
const ok = controlResult.green && mutation.build.green && mutation.catalogTest.intendedTestRed;
process.stdout.write(`${JSON.stringify({ ok, reasonCode: ok ? "S279_TRUE_COMPILED_MUTATION_RED" : "S279_MUTATION_PROOF_FAILED", control: controlResult, mutation }, null, 2)}\n`);
process.exitCode = ok ? 0 : 1;
