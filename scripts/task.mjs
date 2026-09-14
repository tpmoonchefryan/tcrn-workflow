#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import {
  fileRecord,
  repositoryRoot,
  readDependencyManifest,
  readJson,
  readSourceFile,
  toPosixPath,
  walkFiles,
} from "./lib/files.mjs";
import { P1_TASKS } from "./p1-sequence.mjs";
import { compareCanonicalText } from "./lib/canonical-order.mjs";
import { codeOnly, controlByteOffset } from "./lib/code-only.mjs";
import { LocalCommandError, runLocalCommand } from "./lib/local-command.mjs";
import {
  DependencyGraphError,
  assertNoKnownVulnerabilities,
  evaluateVulnerabilityPolicyFreshness,
  validateFrozenDependencyGraph,
} from "./lib/dependency-graph.mjs";
import {
  aggregatePrivacySurface,
  decodeGitMetadataBytes,
  decodePrivacyScanBytes,
  parseGitObjectBatch,
  parseHistoricalTreePaths,
  scanPrivacyEntries,
} from "./lib/privacy.mjs";
import { privateRuntimeConfig } from "./lib/private-token-roster.mjs";
import {
  P8_SUPPORTED_AOS_RELEASES,
  P8_RELEASE_ARTIFACTS,
  P8_TAG,
  P8_VERSION,
  buildP8ReleaseArtifacts,
  p8ArtifactRecords,
  rebuildP8SourceArchiveInIndependentRoots,
} from "./lib/p8-workflow-rc.mjs";
import { assertP8TagPreconditions, assertReleaseCommitShape } from "./lib/release-tag-gate.mjs";
import { ProtocolProofError } from "./lib/protocol-proof.mjs";
import {
  BoundaryError,
  bindOutputSessionProcessGroup,
  assertCleanExclusiveSourceBasis,
  readBoundRegularFile,
  safeCleanOutputRoot,
  safeResetOutputDirectory,
  safeWriteOutput,
  withExclusiveOutputSession,
} from "./lib/safe-io.mjs";
import { delay, PROGRESS_WAIT_MAX_MS, readProgressDelta, summarizeProgress, waitForProgress } from "./lib/incremental-output.mjs";
import { installNoNetworkGuard } from "./no-network.mjs";
import { ScopedStripTypesError, stripTypesWithScopedExperimentalWarning } from "./lib/scoped-strip-types.mjs";
import { evaluateProofBudget } from "./lib/proof-budget.mjs";

installNoNetworkGuard();

const command = process.argv[2];
const textExtensions = new Set([".json", ".md", ".mjs", ".ts", ".yaml", ".yml"]);
const textNames = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".node-version",
  ".npmrc",
  "LICENSE",
  "NOTICE",
]);
const noNetworkImport = pathToFileURL(resolve(repositoryRoot, "scripts/no-network.mjs")).href;
const testControllerBootstrapPath = resolve(repositoryRoot, "scripts/test-controller-bootstrap.mjs");

class TaskError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "TaskError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, message) {
  throw new TaskError(reasonCode, message);
}

function assertion(condition, reasonCode, detail = "") {
  if (!condition) {
    fail(reasonCode, detail || reasonCode);
  }
}

function success(reasonCode, fields = {}) {
  return { reasonCode, ...fields };
}

function run(executable, arguments_, options = {}) {
  return runLocalCommand(executable, arguments_, { cwd: repositoryRoot, ...options });
}

function controllerTimeoutMs() {
  const configured = Number(process.env.TCRN_TEST_CONTROLLER_TIMEOUT_MS ?? "600000");
  assertion(Number.isSafeInteger(configured) && configured > 0 && configured <= 600_000, "TEST_CONTROLLER_TIMEOUT_INVALID", String(configured));
  return configured;
}

function terminateTestControllerGroup(processGroup) {
  try { process.kill(-processGroup, "SIGTERM"); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function runDetachedTestController(arguments_, extraEnvironment) {
  const progressDirectory = await mkdtemp(join(tmpdir(), "tcrn-test-progress-"));
  const progressPath = join(progressDirectory, "events.ndjson");
  let child;
  try {
    child = spawn(process.execPath, [testControllerBootstrapPath, ...arguments_], {
      cwd: repositoryRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        NO_COLOR: "1",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_offline: "true",
        ...extraEnvironment,
        TCRN_TEST_CONTROLLER_LOCK_PATH: resolve(repositoryRoot, ".git/tcrn-workflow-output.lock"),
        TCRN_TEST_CONTROLLER_OUTER_PID: String(process.pid),
        TCRN_TEST_CONTROLLER_PROGRESS_PATH: progressPath,
      },
    });
    assertion(Number.isSafeInteger(child.pid) && child.pid > 0, "TEST_CONTROLLER_PID_INVALID");
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const result = new Promise((resolveResult, rejectResult) => {
      child.once("error", rejectResult);
      // The bootstrap keeps controller streams private, so no controller
      // descendant can retain these task-facing descriptors. Waiting for close
      // preserves complete stdout/stderr capture before zero-stderr validation
      // and command-wide output-session release.
      child.once("close", (code, signal) => resolveResult({ code, signal }));
    });
    if (process.env.TCRN_TEST_BIND_PROCESS_GROUP_FAILURE === "1") {
      // This test-only injection exercises the failure branch before owner
      // metadata can authorize the controller to discover a test file.
      child.kill("SIGTERM");
      await result;
      await waitForProcessGroupExit(child.pid);
      fail("TEST_CONTROLLER_BIND_INJECTED_FAILURE", "test-only pre-bind injection");
    }
    await waitForTestControllerBindWindow();
    // `detached` makes this controller the leader of a dedicated POSIX process
    // group.  Recovery subsequently treats every live group member as a live
    // command descendant, rather than trusting only this outer task PID.
    await bindOutputSessionProcessGroup(child.pid);

    const timeoutMs = controllerTimeoutMs();
    const startedAt = Date.now();
    const resultOutcome = result.then((value) => ({ kind: "exit", value }), (error) => ({ kind: "error", error }));
    let cursor = 0;
    let events = [];
    let counters = { polls: 0, unchangedPolls: 0, bytesRead: 0 };
    let completed;
    while (completed === undefined) {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        terminateTestControllerGroup(child.pid);
        await resultOutcome;
        fail("TEST_CONTROLLER_TIMEOUT", `controller exceeded ${timeoutMs}ms`);
      }
      const waitController = new AbortController();
      const wait = waitForProgress(progressPath, {
        cursor,
        events,
        timeoutMs: Math.min(remaining, PROGRESS_WAIT_MAX_MS),
        pollMs: 25,
        maxPollMs: 1_000,
        counters,
        signal: waitController.signal,
      });
      const outcome = await Promise.race([
        resultOutcome,
        wait.then((value) => ({ kind: "progress", value }), (error) => ({ kind: "progress-error", error })),
      ]);
      waitController.abort();
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.kind === "exit") {
        completed = outcome.value;
        try {
          const delta = await readProgressDelta(progressPath, cursor);
          cursor = delta.nextCursor;
          events = [...events, ...delta.events];
          counters = {
            polls: counters.polls + 1,
            unchangedPolls: counters.unchangedPolls + (delta.events.length === 0 ? 1 : 0),
            bytesRead: counters.bytesRead + delta.bytesRead,
          };
        } catch {
          // The controller's exit result remains authoritative when the final
          // progress read cannot be completed.
        }
        break;
      }
      if (outcome.kind === "progress-error") throw outcome.error;
      cursor = outcome.value.cursor;
      events = outcome.value.events;
      counters = { polls: outcome.value.polls, unchangedPolls: outcome.value.unchangedPolls, bytesRead: outcome.value.bytesRead };
      if (["completed", "failed", "orphaned"].includes(outcome.value.status)) {
        const remainingAfterProgress = timeoutMs - (Date.now() - startedAt);
        let exitOutcome = { kind: "timeout" };
        if (remainingAfterProgress > 0) {
          exitOutcome = await new Promise((resolveOutcome) => {
            const timer = setTimeout(() => resolveOutcome({ kind: "timeout" }), remainingAfterProgress);
            resultOutcome.then((value) => {
              clearTimeout(timer);
              resolveOutcome(value);
            });
          });
        }
        if (exitOutcome.kind === "timeout") {
          terminateTestControllerGroup(child.pid);
          await resultOutcome;
          fail("TEST_CONTROLLER_TIMEOUT", `controller did not close after ${outcome.value.status}`);
        }
        if (exitOutcome.kind === "error") throw exitOutcome.error;
        completed = exitOutcome.value;
        break;
      }
    }
    await waitForProcessGroupExit(child.pid);
    const progress = { ...summarizeProgress(events), cursor, ...counters };
    if (completed.code === 0 && progress.status !== "completed") {
      fail("TEST_CONTROLLER_PROGRESS_MISSING", JSON.stringify(progress));
    }
    if (completed.code !== 0) {
      fail("COMMAND_FAILED", `${process.execPath} ${arguments_.join(" ")}\n${Buffer.concat(stdout).toString("utf8")}${Buffer.concat(stderr).toString("utf8")}`);
    }
    if (Buffer.concat(stderr).toString("utf8").trim() !== "") {
      fail("COMMAND_UNEXPECTED_STDERR", `${process.execPath} ${arguments_.join(" ")}\n${Buffer.concat(stderr).toString("utf8")}`);
    }
    return { progress };
  } finally {
    await rm(progressDirectory, { recursive: true, force: true });
  }
}

async function waitForTestControllerBindWindow() {
  const holdPath = process.env.TCRN_TEST_BIND_WINDOW_HOLD_PATH;
  if (!holdPath) return;
  assertion(holdPath === resolve(holdPath), "TEST_CONTROLLER_BIND_WINDOW_PATH", holdPath);
  await waitForLifecycleCondition(async () => {
    try {
      await lstat(holdPath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }, () => fail("TEST_CONTROLLER_BIND_WINDOW_TIMEOUT", holdPath));
}

async function waitForProcessGroupExit(processGroup) {
  await waitForLifecycleCondition(() => {
    try {
      process.kill(-processGroup, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      fail("TEST_CONTROLLER_GROUP_LIVENESS_UNKNOWN", `${processGroup}: ${error.code ?? error.message}`);
    }
  }, () => fail("TEST_CONTROLLER_GROUP_LIVENESS_TIMEOUT", String(processGroup)));
}

async function waitForLifecycleCondition(probe, onTimeout) {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    if (await probe()) return;
    await delay(10);
  }
  return onTimeout();
}

async function readText(path) {
  return (await readSourceFile(path)).toString("utf8");
}

async function sourcePolicy() {
  return readJson(resolve(repositoryRoot, "scripts/policy/source-allowlist.json"));
}

function allowedByPolicy(path, policy) {
  return policy.allowedFiles.includes(path);
}

async function sourceRecords() {
  // Host-local observer settings carry runtime-only target values. They must not
  // become part of the public source allowlist or release source inventory.
  // TCRN-CROSS-STORY-359 retired verify:observe-channel, which used to fingerprint
  // this file independently; the exclusion now stands on the ignore rule alone.
  const files = (await walkFiles()).filter(
    (path) => toPosixPath(relative(repositoryRoot, path)) !== ".claude/settings.local.json",
  );
  return Promise.all(files.map((path) => fileRecord(path)));
}

async function verifyRuntime() {
  assertion(process.version === "v24.16.0", "RUNTIME_NODE_VERSION", process.version);
  const warningFilters = process.execArgv.filter((argument) => argument.startsWith("--disable-warning="));
  assertion(warningFilters.length === 0, "RUNTIME_WARNING_FILTER_FORBIDDEN", warningFilters.join(","));
  const userAgent = process.env.npm_config_user_agent ?? "";
  assertion(userAgent.startsWith("pnpm/11.3.0 "), "RUNTIME_PNPM_VERSION", userAgent || "missing");
  return success("RUNTIME_VERIFIED", { node: process.version, pnpm: "11.3.0" });
}

async function formatCheck({ write = false } = {}) {
  const files = await walkFiles();
  const findings = [];
  for (const path of files) {
    const name = toPosixPath(relative(repositoryRoot, path));
    if (!textExtensions.has(extname(path)) && !textNames.has(name)) {
      continue;
    }
    const original = await readText(path);
    let normalized = original.replace(/\r\n?/gu, "\n");
    if (!name.endsWith(".md")) {
      normalized = normalized
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/u, ""))
        .join("\n");
    }
    normalized = `${normalized.replace(/\n*$/u, "")}\n`;
    if (name.endsWith(".json")) {
      normalized = `${JSON.stringify(JSON.parse(normalized), null, 2)}\n`;
    }
    if (normalized !== original) {
      if (write) {
        await writeFile(path, normalized);
      } else {
        findings.push(name);
      }
    }
  }
  assertion(findings.length === 0, "FORMAT_MISMATCH", findings.join(","));
  return success(write ? "FORMAT_APPLIED" : "FORMAT_VERIFIED", {
    checked: files.length,
    rewritten: write,
  });
}

async function lint() {
  const files = await walkFiles();
  const moduleFiles = files.filter((path) => path.endsWith(".mjs"));
  for (const path of moduleFiles) {
    run(process.execPath, ["--check", path]);
  }
  // Byte hygiene runs before every content rule: a file carrying a raw control byte
  // cannot be reviewed by grep at all, so it must fail here rather than be judged by
  // rules that read it as text. Same text-file scope as format-check.
  for (const path of files) {
    const name = toPosixPath(relative(repositoryRoot, path));
    if (!textExtensions.has(extname(path)) && !textNames.has(name)) continue;
    const offset = controlByteOffset(await readSourceFile(path));
    assertion(offset === -1, "LINT_CONTROL_BYTE", `${name}@${offset}`);
  }
  for (const path of files.filter((candidate) => candidate.endsWith(".ts"))) {
    const content = await readText(path);
    const code = codeOnly(content);
    assertion(!/\bany\b/u.test(code), "LINT_EXPLICIT_ANY", toPosixPath(relative(repositoryRoot, path)));
    // @ts-ignore is a comment by construction, so this one keeps reading the whole file.
    assertion(!content.includes("@ts-ignore"), "LINT_TS_IGNORE", toPosixPath(relative(repositoryRoot, path)));
    assertion(!/\beval\s*\(/u.test(code), "LINT_EVAL", toPosixPath(relative(repositoryRoot, path)));
  }
  for (const path of files.filter((candidate) => candidate.includes("/.github/workflows/") && candidate.endsWith(".yml"))) {
    const content = await readText(path);
    assertion(!content.includes("pull_request_target"), "CI_PULL_REQUEST_TARGET_FORBIDDEN");
    for (const line of content.split("\n").filter((value) => value.trim().startsWith("uses:"))) {
      assertion(
        /uses:\s+[^@\s]+@[a-f0-9]{40}(?:\s+#.*)?$/u.test(line.trim()),
        "CI_ACTION_NOT_PINNED",
        line.trim(),
      );
    }
  }
  return success("LINT_VERIFIED", { modules: moduleFiles.length });
}

// The typecheck gate is memoized for the lifetime of the process. verify:p1
// invokes it directly and also reaches it through build and workspace; without
// this the pinned compiler would run four times per suite for one answer. Each
// command still typechecks when run on its own, because a fresh process starts
// with an empty cache.
let memoizedTypecheck = null;

async function typecheck() {
  if (memoizedTypecheck === null) memoizedTypecheck = runTypecheck();
  return memoizedTypecheck;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function runTypecheck() {
  await verifyRuntime();
  const files = (await walkFiles()).filter((path) => path.endsWith(".ts"));
  for (const path of files) {
    const content = await readText(path);
    assertion(
      !/function\s+\w+\s*\([^)]*\)\s*\{/u.test(content),
      "TYPECHECK_RETURN_TYPE_REQUIRED",
      toPosixPath(relative(repositoryRoot, path)),
    );
  }
  // A tree carrying TypeScript must carry the project that governs it. This is
  // asserted before the skip below, so deleting tsconfig.json can never be a way
  // to walk past the compiler — it fails the gate instead of silencing it.
  const projectPath = resolve(repositoryRoot, "tsconfig.json");
  const projectPresent = await pathExists(projectPath);
  assertion(files.length === 0 || projectPresent, "TYPECHECK_PROJECT_MISSING", "tsconfig.json");
  // A tree with no TypeScript at all — the disposable task-entrypoint fixtures
  // are the only such tree here — has nothing for the compiler to check.
  if (!projectPresent) {
    return success("TYPECHECK_VERIFIED", { files: 0, engine: "no-typescript-sources" });
  }
  // SDC-4: the gate must run the version this repository pins, never whatever a
  // caller happens to have resolved. Both facts are read and compared here.
  const manifest = await readJson(resolve(repositoryRoot, "package.json"));
  const pinnedVersion = manifest.devDependencies?.typescript ?? "";
  assertion(/^\d+\.\d+\.\d+$/u.test(pinnedVersion), "TYPECHECK_COMPILER_NOT_PINNED", pinnedVersion);
  const compilerPackage = await readDependencyManifest(resolve(repositoryRoot, "node_modules/typescript/package.json"));
  assertion(
    compilerPackage.version === pinnedVersion,
    "TYPECHECK_COMPILER_VERSION_MISMATCH",
    `${compilerPackage.version} != ${pinnedVersion}`,
  );
  const compiler = resolve(repositoryRoot, "node_modules/typescript/lib/tsc.js");
  // Zero tolerance, per the push-gate hardening: --pretty false gives one
  // machine-readable diagnostic per line, and ANY line at all fails the gate.
  // Nothing here distinguishes an error from a warning or a suggestion.
  const invocation = [compiler, "--noEmit", "--pretty", "false", "--project", "tsconfig.json"];
  let diagnostics = "";
  try {
    diagnostics = run(process.execPath, invocation);
  } catch (error) {
    if (!(error instanceof LocalCommandError)) throw error;
    diagnostics = error.message;
  }
  const reported = diagnostics
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith(`${process.execPath} ${compiler}`));
  assertion(reported.length === 0, "TYPECHECK_DIAGNOSTIC", reported.join(" | "));
  return success("TYPECHECK_VERIFIED", {
    files: files.length,
    engine: `typescript-${pinnedVersion}`,
  });
}

async function build() {
  const checked = await typecheck();
  await safeResetOutputDirectory(repositoryRoot, "dist/build");
  const files = (await walkFiles()).filter((path) => path.endsWith(".ts"));
  for (const path of files) {
    const source = await readText(path);
    const output = stripTypesWithScopedExperimentalWarning(source, { mode: "transform", sourceMap: false });
    const target = toPosixPath(relative(repositoryRoot, path)).replace(/\.ts$/u, ".js");
    await safeWriteOutput(repositoryRoot, `dist/build/${target}`, `${output.replace(/\n*$/u, "")}\n`);
  }
  const canonicalOrder = await readSourceFile(resolve(repositoryRoot, "scripts/lib/canonical-order.mjs"));
  await safeWriteOutput(repositoryRoot, "dist/build/scripts/lib/canonical-order.mjs", canonicalOrder);
  const dispatchConfigPath = resolve(repositoryRoot, "packages/core/src/dispatch-config.ts");
  const dispatchDefaultsPath = resolve(repositoryRoot, "packages/core/data/dispatch-defaults.json");
  if (await pathExists(dispatchConfigPath)) {
    const dispatchDefaults = await readSourceFile(dispatchDefaultsPath);
    await safeWriteOutput(
      repositoryRoot,
      "dist/build/packages/core/data/dispatch-defaults.json",
      dispatchDefaults,
    );
  }
  return success("BUILD_VERIFIED", {
    files: files.length,
    engine: checked.engine,
    output: "dist/build",
  });
}

// TCRN-CROSS-STORY-359: this took twenty-nine filter options, one per retired verb, and
// each one selected a subset of the same `tests/**/*.test.mjs` set. Two survive, and both
// have a caller that is not a `verify:*` name: `p8Only` is the release train's dogfood
// leg, `trustOnly` its external-trust leg.
async function runTests({ trustOnly = false, p8Only = false, extraEnvironment = {} } = {}) {
  await build();
  const tests = (await walkFiles())
    .map((path) => toPosixPath(relative(repositoryRoot, path)))
    .filter((path) => path.startsWith("tests/") && path.endsWith(".test.mjs"))
    .filter((path) => !trustOnly || path === "tests/release-trust.test.mjs")
    .filter((path) => !p8Only || ["tests/local-command-byte-fidelity.test.mjs", "tests/p8-workflow-rc.test.mjs"].includes(path));
  const controller = await runDetachedTestController(["--test", ...tests], {
    NODE_OPTIONS: `--import=${noNetworkImport}`,
    TCRN_OFFLINE_PROOF: "1",
    ...extraEnvironment,
  });
  return success(
    trustOnly
      ? "TRUST_NEGATIVE_MATRIX_VERIFIED"
      : p8Only
        ? "P8_WORKFLOW_RC_TESTS_VERIFIED"
        : "TESTS_VERIFIED",
    { tests, result: "passed", progress: controller.progress },
  );
}

// TCRN-CROSS-STORY-359 and Owner ruling TCRN-CROSS-MIN-144.
//
// `scripts/policy/coverage-baseline.json` gated nothing. It was a registry every unit was
// told to keep current and no gate ever read, which is the state that lets a registry rot
// while still looking like coverage -- the same shape as the hand-kept P1 roster this
// repository already paid for once. Owner's direction for this Story was to fold it into
// the test gate or retire it; folding costs one command and keeps a check the repository
// already relies on in review.
//
// The suite runs under NODE_V8_COVERAGE so the second leg can read what actually
// executed rather than what was merely imported. The directory lives outside the
// repository: it is scratch for one run, not an output artifact, and the output session
// owns everything under dist/.
async function verifyTestSuite() {
  const {
    evaluateCoverageRegistry,
    evaluateSurvivingModuleCoverage,
  } = await import("./coverage-conservation.mjs");
  const coverageDirectory = await mkdtemp(join(tmpdir(), "tcrn-suite-coverage-"));
  let tests;
  try {
    tests = await runTests({ extraEnvironment: { NODE_V8_COVERAGE: coverageDirectory } });
    const registry = await evaluateCoverageRegistry();
    assertion(registry.ok, registry.reasonCode, JSON.stringify({
      problems: (registry.problems ?? []).map((entry) => entry.path ?? entry),
      waiverProblems: registry.waiverProblems,
      baselineCompleteness: registry.baselineCompleteness,
    }));
    const survivingModules = await evaluateSurvivingModuleCoverage({
      coverageDirectory,
      waivers: registry.waivers,
      currentTestPaths: registry.currentTestPaths,
    });
    assertion(survivingModules.ok, survivingModules.reasonCode, survivingModules.problems.join("; "));
    return success("TESTS_VERIFIED", {
      tests: tests.tests,
      result: "passed",
      progress: tests.progress,
      coverageConservation: registry.reasonCode,
      survivingModuleCoverage: {
        reasonCode: survivingModules.reasonCode,
        retiredTestFiles: survivingModules.retiredTestFiles,
        modules: survivingModules.modules.map(({ module, executedBlocks }) => ({ module, executedBlocks })),
      },
    });
  } finally {
    await rm(coverageDirectory, { recursive: true, force: true });
  }
}

async function verifyP8() {
  assertCleanExclusiveSourceBasis(run("git", ["status", "--porcelain=v1", "--untracked-files=all"]));
  const packagePaths = ["package.json", "packages/cli/package.json", "packages/core/package.json", "packages/protocol/package.json"];
  const packages = await Promise.all(packagePaths.map((path) => readJson(resolve(repositoryRoot, path))));
  assertion(packages.every((manifest) => manifest.version === P8_VERSION && manifest.private === true), "P8_PACKAGE_VERSION_MISMATCH");
  const frameworkSource = await readText(resolve(repositoryRoot, "packages/core/src/index.ts"));
  assertion(frameworkSource.includes(`FRAMEWORK_VERSION = \"${P8_VERSION}\"`), "P8_FRAMEWORK_VERSION_MISMATCH");
  assertion(P8_SUPPORTED_AOS_RELEASES.length === 0, "P8_SUPPORTED_AOS_RELEASES_MISMATCH");
  const dogfood = await runTests({ p8Only: true });
  const trust = await runTests({ trustOnly: true });
  const sourceArchive = await archive();
  const sbomResult = await sbom();
  const sourceBytes = await readSourceFile(resolve(repositoryRoot, sourceArchive.path));
  const sbomBytes = await readSourceFile(resolve(repositoryRoot, sbomResult.path));
  const policy = await sourcePolicy();
  const independentlyRebuilt = await rebuildP8SourceArchiveInIndependentRoots({
    repositoryRoot,
    allowedFiles: policy.allowedFiles,
  });
  assertion(sourceBytes.equals(independentlyRebuilt.archive), "P8_ARCHIVE_REPRODUCIBILITY_MISMATCH");
  const artifacts = buildP8ReleaseArtifacts({ sourceArchive: sourceBytes, sbom: sbomBytes });
  for (const [name, content] of artifacts) await safeWriteOutput(repositoryRoot, `dist/release/${name}`, content);
  const owner = await remoteOwner();
  const privacyFindings = scanPrivacyEntries(
    [...artifacts.entries()].map(([path, content]) => ({ label: `dist/release/${path}`, kind: "release", content: content.toString("utf8") })),
    { owner },
  );
  assertion(privacyFindings.length === 0, "P8_RELEASE_PRIVACY_FINDINGS", privacyFindings.join(","));
  const privacy = await verifyPrivacy({ requireP8Surfaces: true });
  const p8BasisCommit = run("git", ["rev-parse", "HEAD"]);
  return success("P8_WORKFLOW_RC_VERIFIED", {
    tag: P8_TAG,
    p8BasisCommit,
    tests: dogfood.reasonCode,
    trust: trust.reasonCode,
    sourceArchive,
    sbom: sbomResult,
    artifacts: p8ArtifactRecords(artifacts),
    supportedAosReleases: P8_SUPPORTED_AOS_RELEASES,
    network: false,
    mutation: false,
    publication: false,
    releaseStatus: "accepted_release",
    privacy: privacy.reasonCode,
    reproducibility: {
      sha256: independentlyRebuilt.sha256,
      sourceFiles: independentlyRebuilt.sourceFiles,
      orderedEntries: independentlyRebuilt.orderedEntries,
      rootsIndependent: independentlyRebuilt.rootsIndependent,
    },
    privacySurfaces: privacy.p8Surfaces,
  });
}

async function verifyReleaseTagPreflight() {
  // INC-133 item 3. The format gate lives inside `verify-p1`, which needs a clean
  // checkout under the exclusive output session — a condition no working tree meets
  // mid-change, which is why the gate was never part of any train and two schema
  // files shipped un-normalised in 0.11.9 and 0.11.10. A release commit is exactly
  // when that condition IS met, so the gate belongs here: at the last point before a
  // tag, on the tree that tag will name. Asserted directly rather than by running the
  // whole of p1, because p1's other basis checks are the release's own subject.
  const format = await formatCheck();
  const p8 = await verifyP8();
  const expectedTagIndex = process.argv.indexOf("--tag");
  const expectedTag = expectedTagIndex >= 0 ? process.argv[expectedTagIndex + 1] : P8_TAG;
  const tagCommit = run("git", ["rev-parse", "HEAD"]);
  const parentRecord = run("git", ["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/u);
  assertion(parentRecord.length === 2, "RELEASE_TAG_COMMIT_PARENT_INVALID", parentRecord.join(" "));
  const changedPaths = run("git", ["diff", "--name-only", `${parentRecord[1]}..HEAD`]).split("\n").filter(Boolean);
  const tagProof = assertP8TagPreconditions({ p8Result: p8, expectedTag, tagCommit, p8BasisCommit: p8.p8BasisCommit });
  const commitShape = assertReleaseCommitShape({ changedPaths });
  return success("RELEASE_TAG_PREFLIGHT_VERIFIED", {
    ...tagProof,
    commitShape,
    formatChecked: format.checked,
    publication: false,
    mutation: false,
  });
}


function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function writeTarField(header, offset, length, value) {
  Buffer.from(value, "utf8").copy(header, offset, 0, length);
}

function tarEntry(name, content, mode) {
  assertion(Buffer.byteLength(name) <= 100, "ARCHIVE_PATH_TOO_LONG", name);
  const header = Buffer.alloc(512, 0);
  writeTarField(header, 0, 100, name);
  writeTarField(header, 100, 8, octal(mode, 8));
  writeTarField(header, 108, 8, octal(0, 8));
  writeTarField(header, 116, 8, octal(0, 8));
  writeTarField(header, 124, 12, octal(content.length, 12));
  writeTarField(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarField(header, 257, 6, "ustar\0");
  writeTarField(header, 263, 2, "00");
  writeTarField(header, 265, 32, "root");
  writeTarField(header, 297, 32, "root");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, padding]);
}

async function archive() {
  await verifySource();
  const records = await sourceRecords();
  records.sort((left, right) => compareCanonicalText(left.path, right.path));
  const entries = [];
  for (const record of records) {
    const content = await readSourceFile(resolve(repositoryRoot, record.path));
    const executable = content.subarray(0, 2).toString("utf8") === "#!";
    entries.push(tarEntry(record.path, content, executable ? 0o755 : 0o644));
  }
  entries.push(Buffer.alloc(1024, 0));
  const output = Buffer.concat(entries);
  const relativePath = "dist/source/tcrn-workflow-source.tar";
  await safeWriteOutput(repositoryRoot, relativePath, output);
  return success("ARCHIVE_VERIFIED", {
    path: relativePath,
    sha256: createHash("sha256").update(output).digest("hex"),
    files: records.length,
  });
}

async function sbom() {
  const packageJson = await readJson(resolve(repositoryRoot, "package.json"));
  const policy = await readJson(resolve(repositoryRoot, "scripts/policy/dependency-policy.json"));
  const lockContent = await readSourceFile(resolve(repositoryRoot, "pnpm-lock.yaml"));
  const packageContent = await readSourceFile(resolve(repositoryRoot, "package.json"));
  const basis = createHash("sha256").update(packageContent).update(lockContent).digest("hex");
  const graph = validateFrozenDependencyGraph({ packageJson, dependencyPolicy: policy, lockContent: lockContent.toString("utf8") });
  const components = graph.records.map((record) => {
    return {
      type: "library",
      name: record.name,
      version: record.version,
      scope: record.direct ? "optional" : "required",
      licenses: [{ license: { id: record.license } }],
      purl: `pkg:npm/${encodeURIComponent(record.name)}@${record.version}`,
    };
  });
  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${basis.slice(0, 8)}-${basis.slice(8, 12)}-4${basis.slice(13, 16)}-a${basis.slice(17, 20)}-${basis.slice(20, 32)}`,
    version: 1,
    metadata: {
      component: { type: "application", name: packageJson.name, version: packageJson.version },
      properties: [{ name: "tcrn:deterministic-basis-sha256", value: basis }],
    },
    components,
  };
  const relativePath = "dist/sbom/sbom.cdx.json";
  await safeWriteOutput(repositoryRoot, relativePath, `${JSON.stringify(document, null, 2)}\n`);
  return success("SBOM_VERIFIED", {
    path: relativePath,
    components: components.length,
    directComponents: graph.directIdentities.length,
    transitiveComponents: graph.transitiveIdentities.length,
    dependencyGraphClosure: "complete",
    basis,
  });
}

async function verifyLicenses() {
  const license = await readText(resolve(repositoryRoot, "LICENSE"));
  const notice = await readText(resolve(repositoryRoot, "NOTICE"));
  assertion(license.includes("Apache License") && license.includes("Version 2.0"), "LICENSE_APACHE_REQUIRED");
  assertion(notice.includes("Apache-2.0"), "NOTICE_SPDX_REQUIRED");
  const sourceFiles = (await walkFiles()).filter((path) => [".mjs", ".ts"].includes(extname(path)));
  const missing = [];
  for (const path of sourceFiles) {
    const content = await readText(path);
    if (!content.split("\n").slice(0, 4).some((line) => line.includes("SPDX-License-Identifier: Apache-2.0"))) {
      missing.push(toPosixPath(relative(repositoryRoot, path)));
    }
  }
  assertion(missing.length === 0, "SPDX_HEADER_MISSING", missing.join(","));
  return success("LICENSES_VERIFIED", { sourceFiles: sourceFiles.length });
}

async function verifyVulnerabilities() {
  const packageJson = await readJson(resolve(repositoryRoot, "package.json"));
  const dependencyPolicy = await readJson(resolve(repositoryRoot, "scripts/policy/dependency-policy.json"));
  const lockContent = (await readSourceFile(resolve(repositoryRoot, "pnpm-lock.yaml"))).toString("utf8");
  const policy = await readJson(resolve(repositoryRoot, "scripts/policy/vulnerability-policy.json"));
  const freshness = evaluateVulnerabilityPolicyFreshness(policy);
  const graph = validateFrozenDependencyGraph({ packageJson, dependencyPolicy, lockContent });
  const vulnerabilityReadback = assertNoKnownVulnerabilities(graph, policy.knownVulnerabilities);
  return success("VULNERABILITY_POLICY_VERIFIED", {
    disposition: policy.disposition,
    snapshotDate: policy.snapshotDate,
    maxAgeDays: policy.maxAgeDays,
    noticeBeforeDays: policy.noticeBeforeDays,
    ...freshness,
    dependencyGraphPackages: vulnerabilityReadback.checkedPackages,
    directPackages: graph.directIdentities.length,
    transitivePackages: graph.transitiveIdentities.length,
    policyClosure: "complete-lock-graph",
    externalAdvisoryScan: "not-performed-by-offline-command",
  });
}

async function remoteOwner() {
  const remote = run("git", ["remote", "get-url", "origin"]);
  const match = remote.match(/github\.com[/:]([^/]+)\/tcrn-workflow(?:\.git)?$/u);
  assertion(match, "PRIVACY_ORIGIN_UNEXPECTED");
  return match[1];
}

async function archiveEntryIfPresent() {
  const archivePath = resolve(repositoryRoot, "dist/source/tcrn-workflow-source.tar");
  try {
    await lstat(archivePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const archiveInput = await readBoundRegularFile(archivePath, {
    reasonCode: "PRIVACY_ARCHIVE_INVALID",
    hardlinkReasonCode: "PRIVACY_ARCHIVE_HARDLINK",
    pathChangedReasonCode: "PRIVACY_ARCHIVE_CHANGED",
  });
  return [{
    label: "dist/source/tcrn-workflow-source.tar",
    kind: "archive",
    content: archiveInput.content.toString("utf8"),
  }];
}

async function filesForPrivacySurface(root, labelPrefix = "") {
  const files = (await walkFiles(root)).filter((path) => {
    const relativePath = toPosixPath(relative(root, path));
    // This ignored file is host-local observer runtime configuration. It is
    // deliberately excluded from public/history release surfaces. The independent
    // fingerprint check that used to cover it, verify:observe-channel, retired in
    // TCRN-CROSS-STORY-359.
    return !(root === repositoryRoot && relativePath === ".claude/settings.local.json");
  });
  return Promise.all(files.map(async (path) => ({
    path: `${labelPrefix}${toPosixPath(relative(root, path))}`,
    content: await readSourceFile(path),
  })));
}

async function verifyPrivacy({ requireP8Surfaces = false, historyScope = "head" } = {}) {
  assertion(historyScope === "head" || historyScope === "all", "PRIVACY_SCOPE_INVALID", historyScope);
  const owner = await remoteOwner();
  const entries = [];
  entries.push({
    label: "git-origin",
    kind: "remote",
    content: run("git", ["remote", "get-url", "origin"]),
  });
  const trackedSourceRecords = await filesForPrivacySurface(repositoryRoot);
  for (const record of trackedSourceRecords) {
    const label = record.path;
    entries.push({ label, kind: "filename", content: label });
    entries.push({ label, kind: "source", content: record.content.toString("utf8") });
  }
  entries.push(...await archiveEntryIfPresent());

  // The public CI world is the checked-out release tip, not every object that happens
  // to be present in a clone. A full object database includes old tags, pull refs and
  // unreachable pre-hardening blobs; scanning that set makes a clean tip permanently
  // red for content that is not in the evaluated release. The explicit history command
  // below preserves the broader scan as a separately named local diagnostic.
  const objectIds = historyScope === "head"
    ? decodeGitMetadataBytes(run("git", ["rev-list", "--objects", "HEAD"], { raw: true }), "PRIVACY_REACHABLE_OBJECTS_UTF8_INVALID")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/\s+/u)[0])
    : null;
  if (objectIds !== null) {
    assertion(objectIds.length > 0, "PRIVACY_REACHABLE_OBJECTS_EMPTY");
    assertion(objectIds.every((object) => /^[a-f0-9]{40,64}$/u.test(object)), "PRIVACY_REACHABLE_OBJECTS_INVALID");
    assertion(new Set(objectIds).size === objectIds.length, "PRIVACY_REACHABLE_OBJECTS_DUPLICATE");
  }
  const objectInput = objectIds === null ? undefined : Buffer.from(`${objectIds.join("\n")}\n`, "utf8");
  // One streaming pass over the selected object set. --batch emits
  // "<oid> <type> <size>\n" followed by exactly <size> bytes and a trailing newline,
  // so the payload stays binary-safe: the length comes from the header, never from
  // scanning for a delimiter. A batch-check pass runs first and declares every object
  // in exactly the header form the batch pass emits, so the total stream length is known
  // before the capture. Both drift directions fail closed rather than yielding a short
  // stream whose unscanned tail would leave the privacy gate green.
  const batchCheck = run(
    "git",
    objectIds === null
      ? ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"]
      : ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { raw: true, input: objectInput, maxBuffer: 64 * 1024 * 1024 },
  );
  let expectedStreamBytes = batchCheck.length;
  const batchCheckLines = decodeGitMetadataBytes(batchCheck, "PRIVACY_GIT_OBJECT_INDEX_UTF8_INVALID").split("\n").filter(Boolean);
  if (objectIds !== null) {
    assertion(batchCheckLines.length === objectIds.length, "PRIVACY_REACHABLE_OBJECT_COUNT_MISMATCH", `${objectIds.length}/${batchCheckLines.length}`);
  }
  for (const line of batchCheckLines) {
    const [object, type, sizeText] = line.split(" ");
    assertion(/^[a-f0-9]{40,64}$/u.test(object) && type !== "missing", "PRIVACY_GIT_OBJECT_TYPE", line);
    const declaredSize = Number(sizeText);
    assertion(Number.isSafeInteger(declaredSize) && declaredSize >= 0, "PRIVACY_GIT_OBJECT_TYPE", line);
    expectedStreamBytes += declaredSize + 1;
  }
  const batch = run(
    "git",
    objectIds === null ? ["cat-file", "--batch-all-objects", "--batch"] : ["cat-file", "--batch"],
    { raw: true, input: objectInput, maxBuffer: expectedStreamBytes + 1 },
  );
  const historyRecords = [];
  let objectCount = 0;
  for (const { object, type, content } of parseGitObjectBatch(batch, expectedStreamBytes)) {
    objectCount += 1;
    historyRecords.push({ path: `${type}:${object}`, content });
    entries.push({
      label: `git-${type}:${object}`,
      kind: type,
      content: decodePrivacyScanBytes(content),
    });
  }
  const buildRoot = resolve(repositoryRoot, "dist/build");
  const sourceArchivePath = resolve(repositoryRoot, "dist/source/tcrn-workflow-source.tar");
  const releaseRoot = resolve(repositoryRoot, "dist/release");
  const p8Surfaces = {};
  if (requireP8Surfaces) {
    for (const root of [buildRoot, releaseRoot]) {
      const metadata = await lstat(root).catch(() => null);
      assertion(metadata?.isDirectory(), "P8_PRIVACY_SURFACE_MISSING", root);
    }
    const sourceArchive = await readBoundRegularFile(sourceArchivePath, {
      reasonCode: "P8_PRIVACY_ARCHIVE_INVALID",
      hardlinkReasonCode: "P8_PRIVACY_ARCHIVE_HARDLINK",
      pathChangedReasonCode: "P8_PRIVACY_ARCHIVE_CHANGED",
    });
    const buildRecords = await filesForPrivacySurface(buildRoot, "dist/build/");
    const releaseRecords = await filesForPrivacySurface(releaseRoot, "dist/release/");
    assertion(JSON.stringify(releaseRecords.map((record) => record.path.slice("dist/release/".length)).sort(compareCanonicalText)) === JSON.stringify([...P8_RELEASE_ARTIFACTS].sort(compareCanonicalText)), "P8_PRIVACY_RELEASE_ARTIFACT_SET");
    entries.push(...buildRecords.map((record) => ({ label: record.path, kind: "build", content: record.content.toString("utf8") })));
    entries.push({ label: "dist/source/tcrn-workflow-source.tar", kind: "archive", content: sourceArchive.content.toString("utf8") });
    entries.push(...releaseRecords.map((record) => ({ label: record.path, kind: "release", content: record.content.toString("utf8") })));
    p8Surfaces.aggregateAlgorithm = "sha256(path-NUL-byteLength-NUL-bytes over canonical path order)";
    p8Surfaces.trackedSource = aggregatePrivacySurface(trackedSourceRecords);
    p8Surfaces.fullHistory = aggregatePrivacySurface(historyRecords);
    p8Surfaces.buildOutput = aggregatePrivacySurface(buildRecords);
    p8Surfaces.sourceArchive = aggregatePrivacySurface([{ path: "dist/source/tcrn-workflow-source.tar", content: sourceArchive.content }]);
    p8Surfaces.releaseArtifacts = aggregatePrivacySurface(releaseRecords);
  }
  const commits = run("git", historyScope === "all" ? ["rev-list", "--all"] : ["rev-list", "HEAD"]).split("\n").filter(Boolean);
  let historicalPaths = 0;
  for (const commit of commits) {
    const tree = run("git", ["ls-tree", "-rz", "--full-tree", commit], { raw: true });
    const treeText = decodeGitMetadataBytes(tree, "PRIVACY_TREE_UTF8_INVALID");
    for (const path of parseHistoricalTreePaths(treeText)) {
      entries.push({ label: `git-commit-tree:${commit}:${path}`, kind: "filename", content: path });
      historicalPaths += 1;
    }
  }
  const refs = run("git", ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)"], { raw: true });
  entries.push({ label: "git-refs", kind: "ref", content: decodeGitMetadataBytes(refs, "PRIVACY_REFS_UTF8_INVALID") });
  // INC-122: feed the gate the deployment-private runtime values so the
  // PRIVATE_RUNTIME_VALUE legs are actually built. The roster is value-free by
  // design (the host supplies the values at runtime), so on a governed host —
  // where settings.local provides real TCRN_SSH_* values — the scan now catches
  // the bare governed hostname and runtime root (e.g. baked into a tracked test
  // fixture) that the earlier legs, keyed on suffixes and encoders, missed. When
  // the environment is unconfigured (a public CI checkout) no real value is known
  // and none is invented, so nothing private is embedded in the gate itself.
  const runtime = privateRuntimeConfig();
  // Only the genuinely-private values: the governed hostname and its runtime
  // root. The loopback address and the facade port are not secret and appear as
  // ordinary literals throughout the tree, so feeding them would red on every
  // legitimate loopback reference rather than on leaked topology.
  const privateTokens = runtime.configured
    ? [runtime.host, runtime.runtimeRoot, `${runtime.runtimeRoot}/governance`]
    : [];
  const findings = scanPrivacyEntries(entries, { owner, privateTokens });
  assertion(findings.length === 0, "PRIVACY_FINDINGS", findings.join(","));
  const source = await verifySource();
  return success("PRIVACY_SOURCE_CLEAN", {
    privacyScope: historyScope === "head" ? "HEAD-reachable" : "all-local-objects",
    scannedEntries: entries.length,
    gitObjects: objectCount,
    historicalCommits: commits.length,
    historicalFullPaths: historicalPaths,
    archiveScanned: entries.some((entry) => entry.kind === "archive"),
    allowedPublicMetadata: "strict-github-noreply-commit-or-tag-lines-only",
    allowedPublicControlMetadata: "exact-p3-marker-contract-only",
    sourceFiles: source.files,
    p8Surfaces: requireP8Surfaces ? p8Surfaces : null,
  });
}

async function verifySource() {
  const policy = await sourcePolicy();
  assertion(!Object.hasOwn(policy, "allowedPrefixes"), "SOURCE_PREFIX_ALLOWLIST_FORBIDDEN");
  const records = await sourceRecords();
  const denied = records.map((record) => record.path).filter((path) => !allowedByPolicy(path, policy));
  assertion(denied.length === 0, "SOURCE_NOT_ALLOWLISTED", denied.join(","));
  const missing = policy.allowedFiles.filter((path) => !records.some((record) => record.path === path));
  assertion(missing.length === 0, "SOURCE_ALLOWLIST_ENTRY_MISSING", missing.join(","));
  return success("SOURCE_ALLOWLIST_VERIFIED", { files: records.length, exactEntries: policy.allowedFiles.length });
}

async function verifyNoSiblingDependency() {
  // TCRN-CROSS-INC-215. The dependency-direction rule was prose and a hand-run grep;
  // INC-214 cleared five reaching sites that way and nothing stopped a sixth.
  const result = JSON.parse(run(process.execPath, [resolve(repositoryRoot, "scripts/no-sibling-dependency-proof.mjs")]));
  assertion(result.ok === true, "SIBLING_DEPENDENCY_PRESENT",
    result.findings.map((finding) => `${finding.file}:${finding.line} → ${finding.sibling}`).join(","));
  return success("NO_SIBLING_DEPENDENCY", { siblings: result.siblings, scannedRoots: result.scannedRoots });
}

async function verifyLifecycle() {
  const manifests = (await walkFiles()).filter((path) => path.endsWith("package.json"));
  const forbidden = new Set(["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]);
  for (const path of manifests) {
    const manifest = await readJson(path);
    for (const script of Object.keys(manifest.scripts ?? {})) {
      assertion(!forbidden.has(script), "LIFECYCLE_SCRIPT_FORBIDDEN", `${path}:${script}`);
    }
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        assertion(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version), "DEPENDENCY_NOT_EXACT", `${name}@${version}`);
      }
    }
  }
  const npmrc = await readText(resolve(repositoryRoot, ".npmrc"));
  assertion(/^ignore-scripts=true$/mu.test(npmrc), "IGNORE_SCRIPTS_REQUIRED");
  assertion(/^offline=true$/mu.test(npmrc), "OFFLINE_DEFAULT_REQUIRED");
  return success("LIFECYCLE_POLICY_VERIFIED", { manifests: manifests.length });
}

async function verifyOfflineBoundary() {
  const guardFiles = new Set(["scripts/no-network.mjs", "tests/offline-boundary.test.mjs"]);
  const localUnixSocketTest = "tests/output-session-lifecycle.test.mjs";
  // The boundary this gate defends is "the engine does not reach the network". The portal
  // is a loopback server: it binds 127.0.0.1 and serves bytes already on disk, and its
  // test drives that server through the same interface a browser would. Listing the pair
  // here states which files are allowed to be servers rather than weakening the predicate
  // for everything — every other file in the repository is still judged the same way.
  const loopbackServerFiles = new Set(["portal/portal.mjs", "portal/tests/portal.test.mjs"]);
  const modules = [
    "node:" + "http",
    "node:" + "https",
    "node:" + "net",
    "node:" + "tls",
    "node:" + "dns",
    "node:" + "dgram",
    ["un", "dici"].join(""),
  ];
  const findings = [];
  for (const path of (await walkFiles()).filter((candidate) => [".mjs", ".ts"].includes(extname(candidate)))) {
    const label = toPosixPath(relative(repositoryRoot, path));
    const content = await readText(path);
    if (!guardFiles.has(label) && !loopbackServerFiles.has(label)) {
      for (const moduleName of modules) {
        const localUnixSocketImport = label === localUnixSocketTest && moduleName === modules[2];
        if (!localUnixSocketImport && (content.includes(`\"${moduleName}\"`) || content.includes(`'${moduleName}'`))) {
          findings.push(`NETWORK_MODULE:${label}:${moduleName}`);
        }
      }
      if (/\bfetch\s*\(/u.test(content) || /\bWebSocket\s*\(/u.test(content)) {
        findings.push(`NETWORK_API:${label}`);
      }
    }
  }
  const packageJson = await readJson(resolve(repositoryRoot, "package.json"));
  const externalTools = [["cu", "rl"].join(""), ["wg", "et"].join(""), ["np", "x"].join("")];
  for (const [name, script] of Object.entries(packageJson.scripts ?? {})) {
    if (externalTools.some((tool) => new RegExp(`(?:^|\\s)${tool}(?:\\s|$)`, "u").test(script))) {
      findings.push(`NETWORK_TOOL:${name}`);
    }
    if (/[;&|]{1,2}/u.test(script)) {
      findings.push(`SHELL_CONJUNCTION:${name}`);
    }
  }
  const npmrc = await readText(resolve(repositoryRoot, ".npmrc"));
  for (const setting of ["offline=true", "audit=false", "fund=false", "update-notifier=false"]) {
    if (!npmrc.split("\n").includes(setting)) {
      findings.push(`OFFLINE_SETTING:${setting}`);
    }
  }
  assertion(findings.length === 0, "OFFLINE_BOUNDARY_FINDINGS", findings.join(","));
  run(process.execPath, ["--test", "tests/offline-boundary.test.mjs"], {
    env: { NODE_OPTIONS: `--import=${noNetworkImport}`, TCRN_OFFLINE_PROOF: "1" },
  });
  return success("OFFLINE_BOUNDARY_VERIFIED", {
    nodeProcessGuard: true,
    staticProcessAllowlist: ["node", "git-local-only", "pinned-pnpm-offline-isolated-proof"],
    telemetry: "no-client-detected",
    osNetworkSandbox: "not-provided",
    freshAdvisoryScan: "not-performed",
    ciDependencyAcquisition: "explicit-external-boundary",
  });
}

async function aggregateDigest(paths) {
  const records = await Promise.all(paths.map((path) => fileRecord(resolve(repositoryRoot, path))));
  records.sort((left, right) => compareCanonicalText(left.path, right.path));
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

const commandContracts = {
  privacy: { exit: 0, reasonCode: "PRIVACY_SOURCE_CLEAN" },
  "verify-p1": { exit: 0, reasonCode: "P1_VERIFIED" },
  governance: { exit: 0, reasonCode: "GOVERNANCE_TOOLCHAIN_VERIFIED" },
  isolated: { exit: 0, reasonCode: "ISOLATED_P1_VERIFIED" },
  p8: { exit: 0, reasonCode: "P8_WORKFLOW_RC_VERIFIED" },
  "retrieval-eval": { exit: 0, reasonCode: "RETRIEVAL_EVAL_VERIFIED" },
};

async function verifyMap() {
  const map = JSON.parse(await readText(resolve(repositoryRoot, "verification-map.yaml")));
  const packageJson = await readJson(resolve(repositoryRoot, "package.json"));
  const { verifyRedLegCoverage } = await import("./verification-red-legs.mjs");
  const { validateVerificationMapLinks } = await import("./verification-links.mjs");
  assertion(map.schemaVersion === "tcrn.verification-map.v1", "VERIFICATION_MAP_SCHEMA");
  assertion(Array.isArray(map.claims) && map.claims.length > 0, "VERIFICATION_MAP_EMPTY");
  const ids = new Set();
  const required = [
    "id",
    "phase",
    "category",
    "status",
    "subject",
    "command",
    "fixturePaths",
    "fixtureDigest",
    "environment",
    "expectedExit",
    "expectedReasonCode",
    "evidencePath",
    "invalidationTriggers",
  ];
  const claimCategories = ["framework-hygiene", "inertness-proof", "runtime-capability"];
  for (const claim of map.claims) {
    assertion(required.every((field) => Object.hasOwn(claim, field)), "VERIFICATION_MAP_FIELDS", claim.id ?? "unknown");
    assertion(!ids.has(claim.id), "VERIFICATION_MAP_DUPLICATE", claim.id);
    ids.add(claim.id);
    // TCRN-CROSS-STORY-359. The allowlist used to admit thirteen phases and the loop
    // below required eleven of them to be non-empty. Both lists now name the two phases
    // that still have a gate to hang on: every other phase's claims measured a verify:*
    // script this Story retired, and a phase kept in an allowlist with no claim under it
    // is the same unread roster this repository keeps paying for.
    assertion(["P1", "P8"].includes(claim.phase), "VERIFICATION_MAP_PHASE", claim.id);
    assertion(claimCategories.includes(claim.category), "VERIFICATION_MAP_CATEGORY", claim.id);
    assertion(["implemented", "candidate", "planned"].includes(claim.status), "VERIFICATION_MAP_STATUS", claim.id);
    assertion(Array.isArray(claim.fixturePaths), "VERIFICATION_MAP_FIXTURES", claim.id);
    assertion(Array.isArray(claim.invalidationTriggers) && claim.invalidationTriggers.length > 0, "VERIFICATION_MAP_INVALIDATION", claim.id);
    // TCRN-CROSS-STORY-359. Every claim now says what it is here for, and says it in a
    // form that can be checked: `requirement` is the ordinal of one of the eleven gate
    // categories this repository keeps (1 format, 2 lint, 3 typecheck, 4 build, 5 test,
    // 6 offline, 7 privacy, 8 chain-validate, 9 hooks-live, 10 retrieval-eval,
    // 11 release), `incident` is the chain id of the incident that put the claim here.
    // Exactly one, never both: a claim that can name neither has no reason to exist and
    // retires instead. This is the field the ledger lacked while it grew to 122 entries
    // named after whichever ticket was open the week each was written.
    const hasRequirement = Object.hasOwn(claim, "requirement");
    const hasIncident = Object.hasOwn(claim, "incident");
    assertion(hasRequirement !== hasIncident, "VERIFICATION_MAP_ANCHOR_MISSING", claim.id);
    if (hasRequirement) {
      assertion(Number.isSafeInteger(claim.requirement) && claim.requirement >= 1 && claim.requirement <= 11, "VERIFICATION_MAP_REQUIREMENT_RANGE", claim.id);
    } else {
      assertion(/^TCRN-[A-Z]+-INC-\d+$/u.test(String(claim.incident)), "VERIFICATION_MAP_INCIDENT_SHAPE", claim.id);
    }
    const commandMatch = claim.command.match(/^pnpm ([a-z0-9:.-]+)$/u);
    assertion(commandMatch, "VERIFICATION_MAP_COMMAND_SURFACE", claim.id);
    const scriptName = commandMatch[1];
    const script = packageJson.scripts?.[scriptName];
    const handlerMatch = script?.match(/^node scripts\/task\.mjs ([a-z0-9-]+)$/u);
    const isolatedMatch = script === "node scripts/isolated-proof.mjs";
    assertion(handlerMatch || isolatedMatch, "VERIFICATION_MAP_COMMAND_SCRIPT", `${claim.id}:${scriptName}`);
    const contractName = isolatedMatch ? "isolated" : handlerMatch[1];
    const contract = commandContracts[contractName];
    assertion(contract, "VERIFICATION_MAP_COMMAND_CONTRACT", `${claim.id}:${contractName}`);
    assertion(contract.exit === claim.expectedExit, "VERIFICATION_MAP_EXIT_UNOBSERVABLE", claim.id);
    assertion(contract.reasonCode === claim.expectedReasonCode, "VERIFICATION_MAP_REASON_UNOBSERVABLE", claim.id);
    if (claim.status === "implemented" || claim.status === "candidate") {
      assertion(/^[a-f0-9]{64}$/u.test(claim.fixtureDigest), "VERIFICATION_MAP_DIGEST", claim.id);
      assertion(claim.fixtureDigest === await aggregateDigest(claim.fixturePaths), "VERIFICATION_MAP_DIGEST_MISMATCH", claim.id);
    } else {
      assertion(claim.fixtureDigest === null, "VERIFICATION_MAP_PLANNED_DIGEST", claim.id);
      assertion(claim.expectedReasonCode.endsWith("_OUT_OF_SCOPE"), "VERIFICATION_MAP_PLANNED_REASON", claim.id);
    }
  }
  const redLegCoverage = verifyRedLegCoverage(map);
  assertion(redLegCoverage.ok, "VERIFICATION_MAP_RED_LEG_COVERAGE", redLegCoverage.problems.join("; "));
  const verificationLinks = validateVerificationMapLinks(map);
  assertion(verificationLinks.ok, "VERIFICATION_MAP_LINKS_INVALID", verificationLinks.problems.join("; "));
  // The completeness loop: a phase named in the allowlist above must actually carry a
  // claim. It read eleven phases before TCRN-CROSS-STORY-359; the nine that carried only
  // ticket-numbered claims left with the scripts those claims measured.
  for (const phase of ["P1", "P8"]) {
    assertion(map.claims.some((claim) => claim.phase === phase), "VERIFICATION_MAP_PHASE_MISSING", phase);
  }
  // TCRN-CROSS-INIT-020 INC-078 — ADR acceptance criteria ↔ machine gate
  // reconciliation. Each ADR acceptance criterion NAMES the executable gate/test
  // that machine-checks it (scripts/policy/adr-criteria.json); a criterion with no
  // named gate, a gate file that does not exist, or a gate that no pipeline runs
  // ("not wired", per INC-079) is red. This is the machine form of "a criterion
  // with no red leg is not a criterion" (ADR-0004 §9) — the view and reason-code
  // criteria went silently unenforced during INIT-020 precisely because nothing
  // forced them to name a gate.
  {
    let adrCriteria;
    try {
      adrCriteria = JSON.parse(await readText(resolve(repositoryRoot, "scripts/policy/adr-criteria.json")));
    } catch (error) {
      assertion(false, "VERIFICATION_MAP_ADR_CRITERIA_UNREADABLE", String(error?.message ?? error));
    }
    if (adrCriteria !== undefined) {
      assertion(adrCriteria.schemaVersion === "tcrn.adr-criteria.v1", "VERIFICATION_MAP_ADR_CRITERIA_SCHEMA");
      assertion(Array.isArray(adrCriteria.criteria) && adrCriteria.criteria.length > 0, "VERIFICATION_MAP_ADR_CRITERIA_EMPTY");
      const criterionIds = new Set();
      const adrSectionHeadings = new Map();
      const adrDocuments = new Map();
      for (const criterion of adrCriteria.criteria) {
        const adrNumber = String(criterion.adr ?? "").padStart(4, "0");
        if (!adrDocuments.has(adrNumber)) {
          const adrPath = resolve(repositoryRoot, `docs/adr/${adrNumber}-postgres-storage-backend.md`);
          let document;
          try {
            document = await readText(adrPath);
          } catch (error) {
            assertion(false, "VERIFICATION_MAP_ADR_SOURCE_UNREADABLE", `${criterion.id}:${String(error?.message ?? error)}`);
          }
          const section = document?.match(/### 9\. Equivalence criteria[\s\S]*?(?=\n##\s|$)/u)?.[0] ?? "";
          assertion(section.length > 0, "VERIFICATION_MAP_ADR_SECTION_MISSING", criterion.id);
          const headings = new Map();
          for (const match of section.matchAll(/^\s*(\d+)\.\s+\*\*(.+?)\*\*/gmu)) {
            headings.set(Number(match[1]), match[2].replace(/[.。]+$/u, "").trim());
          }
          adrDocuments.set(adrNumber, document ?? "");
          adrSectionHeadings.set(adrNumber, headings);
        }
      }
      const wiring = (await import("./lib/test-wiring.mjs")).judgeTestWiring({ repoRoot: repositoryRoot, registryPath: resolve(repositoryRoot, "scripts/policy/test-wiring.json") });
      for (const criterion of adrCriteria.criteria) {
        assertion(typeof criterion.id === "string" && criterion.id.length > 0, "VERIFICATION_MAP_ADR_CRITERION_ID");
        assertion(!criterionIds.has(criterion.id), "VERIFICATION_MAP_ADR_CRITERION_DUPLICATE", criterion.id);
        criterionIds.add(criterion.id);
        const adrNumber = String(criterion.adr ?? "").padStart(4, "0");
        const headings = adrSectionHeadings.get(adrNumber);
        assertion(Number.isSafeInteger(criterion.ordinal) && criterion.ordinal > 0, "VERIFICATION_MAP_ADR_CRITERION_ORDINAL", criterion.id);
        const heading = headings?.get(criterion.ordinal);
        assertion(typeof heading === "string", "VERIFICATION_MAP_ADR_CRITERION_NOT_IN_SOURCE", criterion.id);
        assertion(heading.toLocaleLowerCase() === String(criterion.title ?? "").toLocaleLowerCase(), "VERIFICATION_MAP_ADR_CRITERION_TITLE_DRIFT", criterion.id);
        assertion(typeof criterion.gate === "string" && criterion.gate.length > 0, "VERIFICATION_MAP_ADR_CRITERION_UNNAMED", criterion.id);
        assertion(["implemented", "candidate", "planned", "retired"].includes(criterion.status), "VERIFICATION_MAP_ADR_CRITERION_STATUS", criterion.id);
        if (criterion.status === "retired") {
          assertion(typeof criterion.ruling === "string" && criterion.ruling.trim().length > 0, "VERIFICATION_MAP_ADR_CRITERION_RULING", criterion.id);
        }
        if (criterion.status === "implemented") {
          // The named gate must be real AND pipeline-wired. A gate that no pipeline
          // executes is not a gate (INC-079's rule applied to ADR criteria).
          const gateIsScript = typeof packageJson.scripts?.[criterion.gate] === "string";
          if (!gateIsScript) {
            let exists = false;
            try { await lstat(resolve(repositoryRoot, criterion.gate)); exists = true; } catch { exists = false; }
            assertion(exists, "VERIFICATION_MAP_ADR_CRITERION_GATE_MISSING", criterion.id);
          }
          if (criterion.gate.endsWith(".test.mjs") && (wiring.orphaned ?? []).includes(criterion.gate)) {
            assertion(false, "VERIFICATION_MAP_ADR_CRITERION_GATE_UNWIRED", `${criterion.id}:${criterion.gate}`);
          }
          let gateSource = "";
          try {
            gateSource = await readText(resolve(repositoryRoot, criterion.gate));
          } catch (error) {
            assertion(false, "VERIFICATION_MAP_ADR_CRITERION_GATE_UNREADABLE", `${criterion.id}:${String(error?.message ?? error)}`);
          }
          assertion(gateSource.includes(`§9.${String(criterion.ordinal)}`), "VERIFICATION_MAP_ADR_CRITERION_GATE_LABEL", criterion.id);
          const redLeg = criterion.redLeg;
          assertion(redLeg !== null && typeof redLeg === "object" && !Array.isArray(redLeg), "VERIFICATION_MAP_ADR_RED_LEG_STRUCTURED", criterion.id);
          assertion(redLeg?.schemaVersion === "tcrn.adr-red-leg.v1", "VERIFICATION_MAP_ADR_RED_LEG_SCHEMA", criterion.id);
          assertion(typeof redLeg?.marker === "string" && redLeg.marker.length > 0, "VERIFICATION_MAP_ADR_RED_LEG_MARKER", criterion.id);
          assertion(redLeg?.mutation !== null && typeof redLeg?.mutation === "object" && !Array.isArray(redLeg.mutation), "VERIFICATION_MAP_ADR_RED_LEG_MUTATION", criterion.id);
          assertion(typeof redLeg?.mutation?.kind === "string" && redLeg.mutation.kind.length > 0, "VERIFICATION_MAP_ADR_RED_LEG_MUTATION_KIND", criterion.id);
          assertion(typeof redLeg?.mutation?.target === "string" && redLeg.mutation.target.length > 0, "VERIFICATION_MAP_ADR_RED_LEG_MUTATION_TARGET", criterion.id);
          assertion(redLeg?.expected !== null && typeof redLeg?.expected === "object" && !Array.isArray(redLeg.expected), "VERIFICATION_MAP_ADR_RED_LEG_EXPECTED", criterion.id);
          assertion(typeof redLeg?.expected?.outcome === "string" && redLeg.expected.outcome.length > 0, "VERIFICATION_MAP_ADR_RED_LEG_OUTCOME", criterion.id);
          assertion(Array.isArray(redLeg?.expected?.reasonCodes) && redLeg.expected.reasonCodes.length > 0 && redLeg.expected.reasonCodes.every((code) => typeof code === "string" && code.length > 0), "VERIFICATION_MAP_ADR_RED_LEG_REASON_CODES", criterion.id);
          assertion(gateSource.includes(redLeg.marker), "VERIFICATION_MAP_ADR_CRITERION_RED_LEG_MARKER", criterion.id);
        }
      }
      for (const [adrNumber, headings] of adrSectionHeadings) {
        const expected = adrCriteria.criteria.filter((criterion) => String(criterion.adr).padStart(4, "0") === adrNumber);
        assertion(headings.size === expected.length, "VERIFICATION_MAP_ADR_CRITERION_COUNT_DRIFT", adrNumber);
      }
    }
  }
  const categoryCounts = {
    frameworkHygiene: map.claims.filter((claim) => claim.category === "framework-hygiene").length,
    inertnessProof: map.claims.filter((claim) => claim.category === "inertness-proof").length,
    runtimeCapability: map.claims.filter((claim) => claim.category === "runtime-capability").length,
  };
  // README drift is a build failure: the public claims badge must state the same
  // partition the ledger computes (WSG-5 honest-counts charter).
  const readme = await readText(resolve(repositoryRoot, "README.md"));
  const badge = readme.match(/Verified claims: (\d+) \(hygiene (\d+) · inertness (\d+) · runtime (\d+)\)/u);
  assertion(badge, "VERIFICATION_MAP_README_COUNTS", "badge absent");
  assertion(Number(badge[1]) === map.claims.length, "VERIFICATION_MAP_README_COUNTS", "total");
  assertion(Number(badge[2]) === categoryCounts.frameworkHygiene, "VERIFICATION_MAP_README_COUNTS", "hygiene");
  assertion(Number(badge[3]) === categoryCounts.inertnessProof, "VERIFICATION_MAP_README_COUNTS", "inertness");
  assertion(Number(badge[4]) === categoryCounts.runtimeCapability, "VERIFICATION_MAP_README_COUNTS", "runtime");
  return success("VERIFICATION_MAP_VERIFIED", {
    claims: map.claims.length,
    implemented: map.claims.filter((claim) => claim.status === "implemented").length,
    candidate: map.claims.filter((claim) => claim.status === "candidate").length,
    observableReasonCodes: map.claims.length,
    ...categoryCounts,
    redLegCount: redLegCoverage.redLegCount,
    redLegExemptions: redLegCoverage.exemptionCount,
    linkedClaimCount: verificationLinks.linkedClaimCount,
  });
}

async function verifyHistory() {
  const policy = await readJson(resolve(repositoryRoot, "scripts/policy/history-policy.json"));
  const remotes = run("git", ["remote"]).split("\n").filter(Boolean);
  assertion(remotes.length === 1 && remotes[0] === "origin", "HISTORY_REMOTE_SET", remotes.join(","));
  const remote = run("git", ["remote", "get-url", "--all", "origin"]).split("\n").filter(Boolean);
  assertion(remote.length === 1 && /^https:\/\/github\.com\/[^/]+\/tcrn-workflow\.git$/u.test(remote[0]), "HISTORY_ORIGIN", remote.join(","));
  const roots = run("git", ["rev-list", "--max-parents=0", "--all"]).split("\n").filter(Boolean);
  assertion(roots.length === 1, "HISTORY_ROOT_COUNT", String(roots.length));
  assertion(roots[0] === policy.requiredRootCommit, "HISTORY_ROOT_REWRITTEN", roots[0]);
  const rootLine = run("git", ["rev-list", "--parents", "-n", "1", roots[0]]).split(/\s+/u);
  assertion(rootLine.length === 1, "HISTORY_ROOT_HAS_PARENT");
  const refs = run("git", ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean);
  assertion(refs.every((ref) => !ref.startsWith("refs/replace/") && !ref.startsWith("refs/notes/")), "HISTORY_FORBIDDEN_REF", refs.join(","));
  try {
    await lstat(resolve(repositoryRoot, ".git/objects/info/alternates"));
    fail("HISTORY_ALTERNATES", "Object-store alternates are forbidden");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  run("git", ["fsck", "--strict", "--no-reflogs", "--unreachable"]);
  const reachable = new Set(
    run("git", ["rev-list", "--objects", "--all"]).split("\n").filter(Boolean).map((line) => line.split(" ")[0]),
  );
  const stored = new Set(
    run("git", ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]).split("\n").filter(Boolean),
  );
  const unreachable = [...stored].filter((object) => !reachable.has(object));
  assertion(unreachable.length === 0, "HISTORY_UNREACHABLE_OBJECTS", unreachable.join(","));
  const reflog = run("git", ["reflog", "show", "--all", "--format=%H"]).split("\n").filter(Boolean);
  assertion(reflog.every((object) => reachable.has(object)), "HISTORY_REFLOG_UNREACHABLE");
  return success("HISTORY_CLEAN", {
    rootCommit: roots[0],
    objects: stored.size,
    refs: refs.length,
    reflogEntries: reflog.length,
  });
}

// TCRN-CROSS-STORY-359. This verb aggregated runtime, licenses and lifecycle. The
// dependency-graph gate and the Git-history gate each carried their own `verify:*` name
// and their own P1 roster entry, and both answer the same question this one does: is the
// toolchain this repository builds on the one it declares. Their names retired here; the
// checks did not move an inch -- they run from this verb, in the same P1 position, over
// the same inputs, and their claims re-hang on this command rather than on a script that
// no longer exists.
async function verifyGovernance() {
  const runtime = await verifyRuntime();
  const licenses = await verifyLicenses();
  const lifecycle = await verifyLifecycle();
  const vulnerabilities = await verifyVulnerabilities();
  const history = await verifyHistory();
  return success("GOVERNANCE_TOOLCHAIN_VERIFIED", { runtime, licenses, lifecycle, vulnerabilities, history });
}

async function verifyP1() {
  assertCleanExclusiveSourceBasis(run("git", ["status", "--porcelain=v1", "--untracked-files=all"]));
  // The roster lives in scripts/p1-sequence.mjs so preflight runs this same list rather
  // than a copy of it (TCRN-CROSS-INC-218). The copy had lost `portal` and
  // `no-sibling-dependency`, and nothing compared them.
  const sequence = P1_TASKS;
  const results = [];
  for (const name of sequence) {
    results.push(await invoke(name));
  }
  const notices = results.flatMap((result, index) => (
    result.notice === null || result.notice === undefined
      ? []
      : [{ command: sequence[index], ...result.notice }]
  ));
  return success("P1_VERIFIED", {
    commands: sequence,
    observedReasonCodes: results.map((result) => result.reasonCode),
    notices,
  });
}

async function verifyPortal() {
  return JSON.parse(run(process.execPath, [resolve(repositoryRoot, "scripts/verify-portal.mjs")]));
}

async function clean() {
  const result = await safeCleanOutputRoot(repositoryRoot);
  return success("OUTPUTS_CLEANED", result);
}

// WSG-7: proof-to-product budget measurement. Proof mass = newline count of
// tests/**/*.mjs plus scripts/**/*.mjs (scripts/policy JSON is excluded by the
// .mjs filter); product mass = newline count of packages/*/src/**/*.ts. Deliberately
// crude (blanks and comments included) so the number is deterministic and not open
// to reformatting debate. The policy has a non-blocking warning band and a hard
// candidate-release ceiling; both are evaluated from the same raw counts here.
async function reportBudget() {
  const files = await walkFiles();
  let proofLines = 0;
  let productLines = 0;
  for (const absolute of files) {
    const path = toPosixPath(relative(repositoryRoot, absolute));
    const isProof = (path.startsWith("tests/") || path.startsWith("scripts/")) && path.endsWith(".mjs");
    const isProduct = /^packages\/[^/]+\/src\//u.test(path) && path.endsWith(".ts");
    if (!isProof && !isProduct) {
      continue;
    }
    const content = await readSourceFile(absolute);
    let newlines = 0;
    for (const byte of content) {
      if (byte === 0x0a) {
        newlines += 1;
      }
    }
    if (isProof) {
      proofLines += newlines;
    } else {
      productLines += newlines;
    }
  }
  const policy = await readJson(resolve(repositoryRoot, "scripts/policy/proof-budget.json"));
  let evaluated;
  try {
    evaluated = evaluateProofBudget({ proofLines, productLines, policy });
  } catch (error) {
    fail(error?.reasonCode ?? "PROOF_BUDGET_POLICY_INVALID", error?.message ?? "proof budget policy is invalid");
  }
  if (!evaluated.ok) fail(evaluated.reasonCode, evaluated.error);
  return success(evaluated.reasonCode, {
    ...evaluated,
    ...(evaluated.warning === null ? {} : { notice: evaluated.warning }),
  });
}

// TCRN-CROSS-INC-232: every relative Markdown link in a tracked file must resolve.
// Dispatched through here like every other leg rather than pointed straight at its
// script -- the p1 roster criterion asserts exactly that, and caught it when this one
// was wired the short way.
async function verifyLinks() {
  const { inspectMarkdownLinks } = await import("./markdown-link-resolution.mjs");
  const result = await inspectMarkdownLinks(repositoryRoot);
  if (!result.ok) {
    fail("MARKDOWN_LINK_BROKEN",
      result.broken.map((entry) => `${entry.file} -> ${entry.target}`).join("; "));
  }
  return success("MARKDOWN_LINKS_RESOLVED", { files: result.files, checked: result.checked });
}

const handlers = {
  archive,
  budget: reportBudget,
  build,
  clean,
  "format-check": () => formatCheck(),
  "format-write": () => formatCheck({ write: true }),
  governance: verifyGovernance,
  links: verifyLinks,
  lint,
  offline: verifyOfflineBoundary,
  p8: verifyP8,
  portal: verifyPortal,
  "release-preflight": verifyReleaseTagPreflight,
  privacy: verifyPrivacy,
  sbom,
  source: verifySource,
  "no-sibling-dependency": verifyNoSiblingDependency,
  test: verifyTestSuite,
  typecheck,
  "verification-map": verifyMap,
  "retrieval-eval": async () => {
    const result = JSON.parse(run(process.execPath, [resolve(repositoryRoot, "scripts/retrieval-eval.mjs")]));
    if (!result.ok) fail(result.reasonCode, result.message);
    return result;
  },
  "verify-p1": verifyP1,
};

function errorReason(error) {
  if (error instanceof TaskError || error instanceof LocalCommandError || error instanceof BoundaryError || error instanceof ProtocolProofError || error instanceof DependencyGraphError || error instanceof ScopedStripTypesError) {
    return error.reasonCode;
  }
  return "TASK_INTERNAL_ERROR";
}

// TCRN-CROSS-STORY-359: this mapped thirty verb names onto eight evidence phases, one
// branch per retired ticket-numbered verb. Two phases still have a verb: `p8` is the
// release-candidate train, and everything else on the P1 roster writes under p1.
function evidencePhase(name) {
  return name === "p8" ? "p8" : "p1";
}

async function recordEvidence(name, ok, reasonCode, resultOrMessage) {
  const relativePath = `dist/evidence/${evidencePhase(name)}/${name}.json`;
  const document = ok
    ? { schemaVersion: "tcrn.command-evidence.v1", command: name, ok, reasonCode, result: resultOrMessage }
    : { schemaVersion: "tcrn.command-evidence.v1", command: name, ok, reasonCode, error: resultOrMessage };
  await safeWriteOutput(repositoryRoot, relativePath, `${JSON.stringify(document, null, 2)}\n`);
  return relativePath;
}

async function invoke(name) {
  const handler = handlers[name];
  assertion(handler, "TASK_UNKNOWN", name ?? "missing");
  try {
    const result = await handler();
    assertion(typeof result?.reasonCode === "string", "TASK_REASON_CODE_MISSING", name);
    await recordEvidence(name, true, result.reasonCode, result);
    return result;
  } catch (error) {
    const reasonCode = errorReason(error);
    await recordEvidence(name, false, reasonCode, error.message);
    throw error;
  }
}

try {
  const result = await withExclusiveOutputSession(repositoryRoot, async () => invoke(command));
  process.stdout.write(`${JSON.stringify({ ok: true, command, ...result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, command, reasonCode: errorReason(error), error: error.message })}\n`);
  process.exitCode = 1;
}
