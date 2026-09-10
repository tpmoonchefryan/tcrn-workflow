#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-375 — machine evidence for a dispatch review.
//
// The caller supplies the immutable comparison basis and the pre-declared file
// scope. This tool runs the command recorded on the exact chain work item, runs
// the requested test command, counts the before/after test source with the AST
// counter, and measures the diff (including untracked files). It never accepts a
// caller-supplied passed flag or test count as evidence.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { countCoverage } from "./coverage-conservation.mjs";

export const REVIEW_EVIDENCE_VERSION = "tcrn.review-evidence.v1";
export const REVIEW_OUTPUT_BYTES = 65_536;
export const REVIEW_COMMAND_TIMEOUT_MS = 180_000;

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_ENGINE = resolve(REPOSITORY_ROOT, "scripts/tcrn-workflow.mjs");
const WORK_ID_PATTERN = /^work:[a-z0-9][a-z0-9._-]{0,127}$/u;

function text(value) {
  return typeof value === "string" ? value : "";
}

function childEnvironment() {
  const environment = { ...process.env };
  // Node's test runner marks a worker with NODE_TEST_CONTEXT. Passing that
  // implementation detail into a nested `node --test` makes the child skip its
  // files as a recursive test run; it is not part of the reviewed command's
  // environment and must not change the measured result.
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

function outputTail(value, maximum = REVIEW_OUTPUT_BYTES) {
  const bytes = Buffer.from(text(value), "utf8");
  if (bytes.length <= maximum) return bytes.toString("utf8");
  let start = bytes.length - maximum;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function resultCode(result) {
  if (result.error?.code === "ETIMEDOUT") return "TIMEOUT";
  if (result.error?.code) return String(result.error.code);
  if (result.status === null || result.status === undefined) return "UNKNOWN";
  return String(result.status);
}

function runShell(command, cwd, timeoutMs = REVIEW_COMMAND_TIMEOUT_MS) {
  if (typeof command !== "string" || command.trim().length === 0 || command.includes("\u0000")) {
    return { command: command ?? null, cwd, exitCode: "INPUT_INVALID", stdout: "", stderr: "" };
  }
  let result;
  try {
    result = spawnSync("/bin/sh", ["-c", command], {
      cwd,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: REVIEW_OUTPUT_BYTES * 2,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnvironment(),
    });
  } catch (error) {
    return { command, cwd, exitCode: String(error?.code ?? "START_FAILED"), stdout: "", stderr: String(error?.message ?? error) };
  }
  return {
    command,
    cwd,
    exitCode: resultCode(result),
    stdout: outputTail(result.stdout),
    stderr: outputTail(result.stderr),
  };
}

function runGit(repositoryRoot, args, { raw = false } = {}) {
  let result;
  try {
    result = spawnSync("git", ["-C", repositoryRoot, ...args], {
      encoding: raw ? "buffer" : "utf8",
      maxBuffer: REVIEW_OUTPUT_BYTES * 4,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`git ${args.join(" ")} could not start: ${String(error?.message ?? error)}`);
  }
  if (result.status !== 0 || result.error) {
    const detail = outputTail(raw ? result.stderr?.toString("utf8") : result.stderr);
    throw new Error(`git ${args.join(" ")} failed (${resultCode(result)}): ${detail}`);
  }
  return raw ? result.stdout : text(result.stdout);
}

function repositoryRelative(repositoryRoot, candidate) {
  const root = resolve(repositoryRoot);
  const absolute = resolve(root, candidate);
  const rest = relative(root, absolute);
  if (rest === "" || rest.startsWith("..") || rest.startsWith(sep) || rest.includes("\\")) return null;
  return rest.split(sep).join("/");
}

function pointerPath(value) {
  return text(value).replace(/:\d+(?::\d+)?$/u, "");
}

function normalizeAllowedFiles(repositoryRoot, allowedFiles) {
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) return { files: [], problems: ["allowedFiles must be a non-empty pre-declared list"] };
  const files = [];
  const problems = [];
  for (const entry of allowedFiles) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      problems.push("allowedFiles contains an empty entry");
      continue;
    }
    const raw = pointerPath(entry.trim());
    const normalized = repositoryRelative(repositoryRoot, raw);
    if (normalized === null) problems.push(`${entry} is outside repositoryRoot`);
    else files.push(normalized);
  }
  return { files: [...new Set(files)].sort(), problems };
}

function parseNameStatus(bytes) {
  const parts = Buffer.isBuffer(bytes) ? bytes.toString("utf8").split("\0") : text(bytes).split("\0");
  const entries = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index++];
    if (!status) continue;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const from = parts[index++] ?? "";
      const to = parts[index++] ?? "";
      entries.push({ status, paths: [from, to].filter(Boolean) });
    } else {
      const path = parts[index++] ?? "";
      entries.push({ status, paths: path ? [path] : [] });
    }
  }
  return entries;
}

function parsePorcelainStatus(bytes) {
  return (Buffer.isBuffer(bytes) ? bytes.toString("utf8") : text(bytes)).split("\0")
    .filter((entry) => entry.length >= 4)
    .map((entry) => ({ status: entry.slice(0, 2), paths: [entry.slice(3)] }));
}

export function diffEvidence(repositoryRoot, base, head = null) {
  const arguments_ = ["diff", "--name-status", "-z", "--find-renames", base];
  if (head !== null && head !== undefined) arguments_.push(head);
  arguments_.push("--");
  const diff = parseNameStatus(runGit(repositoryRoot, arguments_, { raw: true }));
  const status = parsePorcelainStatus(runGit(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { raw: true }))
    .filter((entry) => entry.status === "??");
  const changedFiles = [...new Set([...diff, ...status].flatMap((entry) => entry.paths))].sort();
  const statuses = new Map();
  for (const entry of [...diff, ...status]) {
    for (const path of entry.paths) statuses.set(path, entry.status);
  }
  return {
    base,
    head: head ?? "WORKING_TREE",
    entries: diff,
    untracked: status,
    changedFiles,
    files: changedFiles.map((path) => ({ path, status: statuses.get(path) ?? "unknown" })),
  };
}

function parseTestNumber(output, label) {
  const match = text(output).match(new RegExp(`(?:^|\\n)\\s*ℹ\\s+${label}\\s+(\\d+)\\s*(?:\\n|$)`, "u"));
  return match ? Number(match[1]) : null;
}

function jsonObjects(output) {
  return text(output).split("\n").reverse().flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value !== null && typeof value === "object" && !Array.isArray(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

/** Parse runner output only; a prose "passed" or a supplied count is not accepted. */
export function parseTestRunOutput(stdout, stderr = "") {
  const combined = `${text(stdout)}\n${text(stderr)}`;
  const structured = jsonObjects(stdout).find((value) => Array.isArray(value.tests));
  if (structured !== undefined) {
    return {
      tests: structured.tests.length,
      testFiles: structured.tests.length,
      testCases: null,
      passed: structured.result === "passed" || structured.ok === true ? structured.tests.length : null,
      failed: structured.result === "passed" || structured.ok === true ? 0 : null,
      parseable: true,
      source: "engine-test-result.tests-array",
    };
  }
  const tests = parseTestNumber(combined, "tests");
  const passed = parseTestNumber(combined, "pass");
  const failed = parseTestNumber(combined, "fail");
  return { tests: null, testFiles: null, testCases: tests, passed, failed, parseable: false, source: "node-test-case-summary" };
}

function readGitFile(repositoryRoot, ref, path) {
  try {
    return runGit(repositoryRoot, ["show", `${ref}:${path}`]);
  } catch {
    return "";
  }
}

function currentTestFiles(repositoryRoot) {
  const tracked = runGit(repositoryRoot, ["ls-files", "--", "tests/"])
    .split("\n").filter((path) => path.endsWith(".test.mjs"));
  let untracked = [];
  try {
    untracked = parsePorcelainStatus(runGit(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { raw: true }))
      .flatMap((entry) => entry.paths).filter((path) => path.startsWith("tests/") && path.endsWith(".test.mjs"));
  } catch { /* diffEvidence will report Git failures */ }
  return [...new Set([...tracked, ...untracked])].sort();
}

export function astTestEvidence(repositoryRoot, base, head = null, testFiles = currentTestFiles(repositoryRoot)) {
  const before = { testCount: 0, assertionCount: 0, files: [] };
  const after = { testCount: 0, assertionCount: 0, files: [] };
  for (const path of testFiles) {
    const beforeSource = readGitFile(repositoryRoot, base, path);
    const afterSource = head === null || head === undefined
      ? existsSync(resolve(repositoryRoot, path)) ? readFileSync(resolve(repositoryRoot, path), "utf8") : ""
      : readGitFile(repositoryRoot, head, path);
    const beforeCount = countCoverage(beforeSource);
    const afterCount = countCoverage(afterSource);
    before.testCount += beforeCount.testCount;
    before.assertionCount += beforeCount.assertionCount;
    after.testCount += afterCount.testCount;
    after.assertionCount += afterCount.assertionCount;
    before.files.push({ path, ...beforeCount });
    after.files.push({ path, ...afterCount });
  }
  return { testFiles, before, after };
}

function readBoundVerify({ workspace, workId, engineCli }) {
  if (!isAbsolute(text(workspace)) || !WORK_ID_PATTERN.test(text(workId))) {
    return { status: "unavailable", reason: "workspace/work-id binding is not qualified", command: null };
  }
  let output;
  try {
    const child = spawnSync(process.execPath, [engineCli, "work-show", "--workspace", workspace, "--id", workId], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: REVIEW_OUTPUT_BYTES * 2,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.status !== 0 || child.error) return { status: "unavailable", reason: "work-show failed", command: null };
    output = JSON.parse(text(child.stdout));
  } catch (error) {
    return { status: "unavailable", reason: String(error?.message ?? error), command: null };
  }
  if (output?.record?.id !== workId) return { status: "unavailable", reason: "work-show returned a different record", command: null };
  const command = output?.advisory?.verify;
  if (typeof command !== "string" || command.length === 0) return { status: "missing", reason: "work has no advisory:verify", command: null };
  return { status: "available", reason: "advisory:verify read from the bound work", command };
}

export function collectReviewEvidence({
  workspace,
  workId,
  repositoryRoot = REPOSITORY_ROOT,
  base,
  head = null,
  allowedFiles,
  testCommand,
  engineCli = DEFAULT_ENGINE,
  commandTimeoutMs = REVIEW_COMMAND_TIMEOUT_MS,
} = {}) {
  const root = resolve(repositoryRoot);
  let rootIsDirectory = false;
  try { rootIsDirectory = isAbsolute(root) && statSync(root).isDirectory(); } catch { /* input is reported below */ }
  if (!rootIsDirectory) {
    return { schemaVersion: REVIEW_EVIDENCE_VERSION, ok: false, reasonCode: "REVIEW_EVIDENCE_INPUT_INVALID", problems: ["repositoryRoot must be a directory"], evidence: null };
  }
  if (typeof base !== "string" || base.length === 0 || base.includes("\u0000")) {
    return { schemaVersion: REVIEW_EVIDENCE_VERSION, ok: false, reasonCode: "REVIEW_EVIDENCE_INPUT_INVALID", problems: ["base is required"], evidence: null };
  }
  const allowed = normalizeAllowedFiles(root, allowedFiles);
  const problems = [...allowed.problems];
  let diff;
  try {
    diff = diffEvidence(root, base, head);
  } catch (error) {
    return { schemaVersion: REVIEW_EVIDENCE_VERSION, ok: false, reasonCode: "REVIEW_EVIDENCE_GIT_UNAVAILABLE", problems: [String(error?.message ?? error)], evidence: null };
  }
  const outOfBounds = diff.changedFiles.filter((path) => !allowed.files.includes(path));
  const binding = readBoundVerify({ workspace, workId, engineCli });
  const verifyRun = binding.status === "available"
    ? runShell(binding.command, root, commandTimeoutMs)
    : null;
  const verify = {
    ...binding,
    run: verifyRun,
    ok: binding.status === "available" && verifyRun?.exitCode === "0",
  };
  // When no separate runner is declared, the bound verify command is the runner
  // too; reuse its real output instead of running a potentially expensive check
  // twice and presenting two observations as if they were independent.
  const actualTestCommand = testCommand ?? binding.command;
  const testRun = testCommand === undefined ? verifyRun : runShell(testCommand, root, commandTimeoutMs);
  const testSummary = testRun === null
    ? { tests: null, testFiles: null, testCases: null, passed: null, failed: null, parseable: false }
    : parseTestRunOutput(testRun.stdout, testRun.stderr);
  const ast = astTestEvidence(root, base, head);
  if (binding.status === "missing") problems.push("bound work has no advisory:verify command");
  if (binding.status === "unavailable") problems.push(`bound work verify is unavailable: ${binding.reason}`);
  if (!verify.ok) problems.push("verify command did not exit 0");
  if (testRun === null || !testSummary.parseable) problems.push("test runner output has no machine-readable tests count");
  if (testRun !== null && testRun.exitCode !== "0") problems.push(`test runner exited ${testRun.exitCode}`);
  if (ast.after.testCount < ast.before.testCount) problems.push(`AST test count decreased from ${ast.before.testCount} to ${ast.after.testCount}`);
  if (testSummary.failed !== null && testSummary.failed > 0) problems.push(`test runner reported ${testSummary.failed} failed tests`);
  problems.push(...outOfBounds.map((path) => `diff file is outside pre-declared scope: ${path}`));
  return {
    schemaVersion: REVIEW_EVIDENCE_VERSION,
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? "REVIEW_EVIDENCE_READY" : "REVIEW_EVIDENCE_INCOMPLETE",
    problems,
    evidence: {
      work: { workspace, workId },
      basis: { repositoryRoot: root, base, head: head ?? "WORKING_TREE" },
      allowedFiles: allowed.files,
      verify,
      testRun: { command: actualTestCommand, result: testRun, summary: testSummary },
      astCountCoverage: ast,
      diff: { ...diff, outOfBounds },
    },
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) values[key] = true;
    else { values[key] = value; index += 1; }
  }
  return values;
}

function readRequest(values) {
  if (typeof values.request !== "string") return values;
  try { return { ...JSON.parse(readFileSync(resolve(values.request), "utf8")), ...values }; }
  catch { return { ...values, requestUnreadable: true }; }
}

if (process.argv[1]?.endsWith("review-evidence.mjs")) {
  const values = readRequest(parseArguments(process.argv.slice(2)));
  let request = values;
  if (values.requestUnreadable) request = { ...values, allowedFiles: [] };
  if (typeof request.allowed === "string") {
    try { request.allowedFiles = JSON.parse(readFileSync(resolve(request.allowed), "utf8")); }
    catch { request.allowedFiles = []; }
  }
  const result = collectReviewEvidence({
    workspace: request.workspace,
    workId: request["work-id"] ?? request.workId,
    repositoryRoot: request["repository-root"] ?? request.repositoryRoot,
    base: request.base,
    head: request.head === true ? null : request.head,
    allowedFiles: request.allowedFiles,
    testCommand: request["test-command"] ?? request.testCommand,
    engineCli: request["engine-cli"] ?? request.engineCli,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
