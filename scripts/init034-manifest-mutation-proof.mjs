#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(repositoryRoot, "packages/core/src/install-manifest.ts");
const testPath = join(repositoryRoot, "tests/init033-install-surface.test.mjs");

const mutations = [
  { name: "container", id: "container.mcp", distId: "<PLATFORM_ROOT>/.mcp.json", pattern: /^\s*item\("container\.mcp"[^\n]*\n/mu },
  { name: "project", id: "project.TCRN-TMS", distId: "project.TCRN-TMS.claude-adapter", pattern: /^\s*Object\.freeze\(\{ name: "TCRN-TMS"[^\n]*\n/mu },
  { name: "machine", id: "machine.portal-launcher-command", distId: "<PLATFORM_ROOT>/tcrn-workflow-portal.command", pattern: /^\s*item\("machine\.portal-launcher-command"[^\n]*\n/mu },
];

async function run(executable, args, cwd) {
  const result = await execFile(executable, args, { cwd, encoding: "utf8", maxBuffer: 8_388_608 });
  return { status: 0, stdout: result.stdout, stderr: result.stderr };
}

async function runAllowFailure(executable, args, cwd) {
  return await new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, npm_config_offline: "true", npm_config_user_agent: "pnpm/11.3.0 npm/? node/v24.16.0 darwin arm64" } });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectResult);
    child.once("close", (status, signal) => resolveResult({ status, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function createScratch() {
  const scratch = await mkdtemp(join(tmpdir(), "tcrn-init034-manifest-"));
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
  await mkdir(join(scratch, ".git"), { recursive: true });
  await cp(join(repositoryRoot, "node_modules"), join(scratch, "node_modules"), { recursive: true });
  return scratch;
}

async function proveMutation(mutation) {
  const scratch = await createScratch();
  try {
    const scratchSourcePath = join(scratch, "packages/core/src/install-manifest.ts");
    const original = await readFile(scratchSourcePath, "utf8");
    const mutated = original.replace(mutation.pattern, "");
    if (mutated === original) throw new Error(`MUTATION_NOT_APPLIED:${mutation.name}`);
    await writeFile(scratchSourcePath, mutated);
    const build = await runAllowFailure(process.execPath, ["scripts/task.mjs", "build"], scratch);
    if (build.status !== 0) {
      return {
        name: mutation.name,
        deletedId: mutation.id,
        trueBuild: { status: build.status, verified: false, stdout: build.stdout, stderr: build.stderr },
        idAbsentFromDist: false,
        completenessTest: { status: null, intendedTestRed: false, stdout: "", stderr: "" },
      };
    }
    const distPath = join(scratch, "dist/build/packages/core/src/install-manifest.js");
    const dist = await readFile(distPath, "utf8");
    const idAbsentFromDist = !dist.includes(mutation.distId ?? mutation.id);
    const test = await runAllowFailure(process.execPath, ["--test", "--test-name-pattern", "S261 independent required-item catalog", "tests/init033-install-surface.test.mjs"], scratch);
    const intendedTestRed = test.status !== 0 && test.stdout.includes("S261 independent required-item catalog");
    const reasonCode = /reasonCode: '([^']+)'/u.exec(test.stdout)?.[1] ?? null;
    return {
      name: mutation.name,
      deletedId: mutation.id,
      trueBuild: { status: build.status, verified: build.status === 0 },
      idAbsentFromDist,
      completenessTest: { status: test.status, intendedTestRed, reasonCode },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const control = await createScratch();
let controlResult;
try {
  const build = await runAllowFailure(process.execPath, ["scripts/task.mjs", "build"], control);
  const check = await runAllowFailure(process.execPath, ["--input-type=module", "-e", "import { readInstallManifest } from './dist/build/packages/core/src/index.js'; readInstallManifest();"], control);
  controlResult = { buildStatus: build.status, completenessReadStatus: check.status, green: build.status === 0 && check.status === 0 };
} finally {
  await rm(control, { recursive: true, force: true });
}

const results = [];
for (const mutation of mutations) results.push(await proveMutation(mutation));
const ok = controlResult.green && results.every((result) => result.trueBuild.verified && result.idAbsentFromDist && result.completenessTest.intendedTestRed);
process.stdout.write(`${JSON.stringify({ ok, reasonCode: ok ? "S268_TRUE_MUTATION_RED_LEGS" : "S268_MUTATION_PROOF_FAILED", control: controlResult, mutations: results }, null, 2)}\n`);
process.exitCode = ok ? 0 : 1;
