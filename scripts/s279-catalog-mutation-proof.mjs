#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Compile a catalog mutation into dist and require the catalog test to observe
// the missing required dispatch tier flag.

import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogSource = "packages/cli/src/index.ts";
const catalogTest = "tests/p3-cli-catalog.test.mjs";
const tiersFlag = '{ name: "tiers", required: true, valueKind: "string" }, ';

async function run(executable, args, cwd) {
  return execFile(executable, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

async function runAllowFailure(executable, args, cwd) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1", npm_config_offline: "true", npm_config_user_agent: "pnpm/11.3.0 npm/? node/v24.16.0 darwin arm64" },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectResult);
    child.once("close", (status, signal) => resolveResult({ status, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function runBuild(cwd) {
  return runAllowFailure("corepack", ["pnpm", "run", "build"], cwd);
}

async function createScratch() {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "tcrn-s279-catalog-"));
  await run("git", ["clone", "--local", "--no-hardlinks", repositoryRoot, scratch], repositoryRoot);
  const currentPatch = join(scratch, ".current.patch");
  const diff = await run("git", ["diff", "HEAD", "--binary"], repositoryRoot);
  if (diff.stdout.length > 0) {
    await writeFile(currentPatch, diff.stdout, "utf8");
    await run("git", ["apply", "--binary", currentPatch], scratch);
    await rm(currentPatch, { force: true });
  }
  for (const path of ["packages/core/data/dispatch-defaults.json", "packages/core/src/dispatch-config.ts"]) {
    const target = join(scratch, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repositoryRoot, path), target);
  }
  await run("cp", ["-a", join(repositoryRoot, "node_modules"), join(scratch, "node_modules")], repositoryRoot);
  await mkdir(join(scratch, ".git"), { recursive: true });
  return scratch;
}

async function proveMutation() {
  const scratch = await createScratch();
  try {
    const initialBuild = await runBuild(scratch);
    if (initialBuild.status !== 0) {
      return {
        build: { status: initialBuild.status, green: false, initial: initialBuild.stdout, error: initialBuild.stderr },
        catalogTest: { status: null, intendedTestRed: false },
      };
    }
    const compiled = join(scratch, "dist/build/packages/cli/src/index.js");
    const beforeHash = await sha256(compiled);
    const path = join(scratch, catalogSource);
    const source = await readFile(path, "utf8");
    if (source.split(tiersFlag).length - 1 !== 1) throw new Error("S369_TIERS_CATALOG_ANCHOR_NOT_UNIQUE");
    await writeFile(path, source.replace(tiersFlag, ""));
    const rebuilt = await runBuild(scratch);
    const afterHash = rebuilt.status === 0 ? await sha256(compiled) : null;
    const test = rebuilt.status === 0 && beforeHash !== afterHash
      ? await runAllowFailure(process.execPath, ["--test", "--test-name-pattern", "dispatch tier catalog", catalogTest], scratch)
      : { status: null, stdout: "", stderr: "" };
    await writeFile(path, source);
    const restoredBuild = await runBuild(scratch);
    const restoredHash = restoredBuild.status === 0 ? await sha256(compiled) : null;
    const restoredTest = restoredBuild.status === 0 && restoredHash === beforeHash
      ? await runAllowFailure(process.execPath, ["--test", "--test-name-pattern", "dispatch tier catalog", catalogTest], scratch)
      : { status: null, stdout: "", stderr: "" };
    return {
      build: { status: rebuilt.status, green: rebuilt.status === 0 && beforeHash !== afterHash, beforeHash, afterHash, changed: beforeHash !== afterHash },
      catalogTest: { status: test.status, intendedTestRed: test.status !== 0 && test.stdout.includes("dispatch tier catalog") },
      restored: {
        buildStatus: restoredBuild.status,
        testStatus: restoredTest.status,
        hash: restoredHash,
        green: restoredBuild.status === 0 && restoredHash === beforeHash && restoredTest.status === 0,
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const control = await createScratch();
let controlResult;
try {
  const build = await runBuild(control);
  const test = build.status === 0
    ? await runAllowFailure(process.execPath, ["--test", "--test-name-pattern", "dispatch tier catalog", catalogTest], control)
    : { status: null, stdout: "", stderr: "" };
  controlResult = { buildStatus: build.status, testStatus: test.status, green: build.status === 0 && test.status === 0 };
} finally {
  await rm(control, { recursive: true, force: true });
}

const mutation = await proveMutation();
const ok = controlResult.green && mutation.build.green && mutation.catalogTest.intendedTestRed && mutation.restored.green;
process.stdout.write(`${JSON.stringify({ ok, reasonCode: ok ? "S279_TRUE_COMPILED_MUTATION_RED" : "S279_MUTATION_PROOF_FAILED", control: controlResult, mutation }, null, 2)}\n`);
process.exitCode = ok ? 0 : 1;
