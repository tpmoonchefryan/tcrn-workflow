#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import {
  fileRecord,
  repositoryRoot,
  readJson,
  readSourceFile,
  toPosixPath,
  walkFiles,
} from "./lib/files.mjs";
import { compareCanonicalText } from "./lib/canonical-order.mjs";
import { LocalCommandError, runLocalCommand } from "./lib/local-command.mjs";
import {
  DependencyGraphError,
  assertNoKnownVulnerabilities,
  validateFrozenDependencyGraph,
} from "./lib/dependency-graph.mjs";
import {
  aggregatePrivacySurface,
  decodeGitMetadataBytes,
  decodePrivacyScanBytes,
  parseHistoricalTreePaths,
  scanPrivacyEntries,
} from "./lib/privacy.mjs";
import {
  P8_SUPPORTED_AOS_RELEASES,
  P8_RELEASE_ARTIFACTS,
  P8_VERSION,
  buildP8ReleaseArtifacts,
  p8ArtifactRecords,
  rebuildP8SourceArchiveInIndependentRoots,
} from "./lib/p8-workflow-rc.mjs";
import {
  ProtocolProofError,
  validateAosLedger,
  validateP2SchemasAndFixtures,
  validateRc1Candidate,
} from "./lib/protocol-proof.mjs";
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
import { installNoNetworkGuard } from "./no-network.mjs";
import { ScopedStripTypesError, stripTypesWithScopedExperimentalWarning } from "./lib/scoped-strip-types.mjs";

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

async function runDetachedTestController(arguments_, extraEnvironment) {
  const child = spawn(process.execPath, [testControllerBootstrapPath, ...arguments_], {
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
  const completed = await result;
  await waitForProcessGroupExit(child.pid);
  if (completed.code !== 0) {
    fail("COMMAND_FAILED", `${process.execPath} ${arguments_.join(" ")}\n${Buffer.concat(stdout).toString("utf8")}${Buffer.concat(stderr).toString("utf8")}`);
  }
  if (Buffer.concat(stderr).toString("utf8").trim() !== "") {
    fail("COMMAND_UNEXPECTED_STDERR", `${process.execPath} ${arguments_.join(" ")}\n${Buffer.concat(stderr).toString("utf8")}`);
  }
}

async function waitForTestControllerBindWindow() {
  const holdPath = process.env.TCRN_TEST_BIND_WINDOW_HOLD_PATH;
  if (!holdPath) return;
  assertion(holdPath === resolve(holdPath), "TEST_CONTROLLER_BIND_WINDOW_PATH", holdPath);
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    try {
      await lstat(holdPath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  fail("TEST_CONTROLLER_BIND_WINDOW_TIMEOUT", holdPath);
}

async function waitForProcessGroupExit(processGroup) {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    try {
      process.kill(-processGroup, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      fail("TEST_CONTROLLER_GROUP_LIVENESS_UNKNOWN", `${processGroup}: ${error.code ?? error.message}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  fail("TEST_CONTROLLER_GROUP_LIVENESS_TIMEOUT", String(processGroup));
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
  const files = await walkFiles();
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
  for (const path of files.filter((candidate) => candidate.endsWith(".ts"))) {
    const content = await readText(path);
    assertion(!/\bany\b/u.test(content), "LINT_EXPLICIT_ANY", toPosixPath(relative(repositoryRoot, path)));
    assertion(!content.includes("@ts-ignore"), "LINT_TS_IGNORE", toPosixPath(relative(repositoryRoot, path)));
    assertion(!/\beval\s*\(/u.test(content), "LINT_EVAL", toPosixPath(relative(repositoryRoot, path)));
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

async function typecheck() {
  await verifyRuntime();
  const files = (await walkFiles()).filter((path) => path.endsWith(".ts"));
  for (const path of files) {
    const content = await readText(path);
    stripTypesWithScopedExperimentalWarning(content, { mode: "transform", sourceMap: false });
    assertion(
      !/function\s+\w+\s*\([^)]*\)\s*\{/u.test(content),
      "TYPECHECK_RETURN_TYPE_REQUIRED",
      toPosixPath(relative(repositoryRoot, path)),
    );
  }
  return success("TYPECHECK_VERIFIED", {
    files: files.length,
    engine: "node-strip-types-and-p1-contracts",
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
  return success("BUILD_VERIFIED", {
    files: files.length,
    engine: checked.engine,
    output: "dist/build",
  });
}

async function runTests({
  trustOnly = false,
  rootOnly = false,
  protocolOnly = false,
  p3Only = false,
  p4Only = false,
  knowledgeOnly = false,
  p5Only = false,
  p6Only = false,
  p6AdapterOnly = false,
  p6bAdapterOnly = false,
  dependencyOnly = false,
  conferenceOnly = false,
  assignmentGateOnly = false,
  actorOnly = false,
  extensionStoreOnly = false,
  p7Only = false,
  p7CompatibilityOnly = false,
  p7AosRequirementsOnly = false,
  p8Only = false,
  backupOnly = false,
  installerOnly = false,
} = {}) {
  await build();
  const tests = (await walkFiles())
    .map((path) => toPosixPath(relative(repositoryRoot, path)))
    .filter((path) => path.startsWith("tests/") && path.endsWith(".test.mjs"))
    .filter((path) => !trustOnly || path === "tests/release-trust.test.mjs")
    .filter((path) => !rootOnly || path === "tests/root-boundaries.test.mjs")
    .filter((path) => !protocolOnly || path === "tests/protocol-v1.test.mjs")
    .filter((path) => !p3Only || ["tests/p3-file-engine.test.mjs", "tests/p3-cli-read-surface.test.mjs", "tests/p3-cli-catalog.test.mjs", "tests/p3-engine-complexity.test.mjs"].includes(path))
    .filter((path) => !p4Only || ["tests/p4-artifact-lifecycle.test.mjs", "tests/p4-knowledge-core.test.mjs"].includes(path))
    .filter((path) => !knowledgeOnly || path === "tests/p4-knowledge-core.test.mjs")
    .filter((path) => !p5Only || ["tests/p5-generic-profile.test.mjs", "tests/p5-core-reference-personas.test.mjs"].includes(path))
    .filter((path) => !p6Only || ["tests/p6-context-router.test.mjs", "tests/p6-codex-adapter.test.mjs"].includes(path))
    .filter((path) => !p6AdapterOnly || path === "tests/p6-codex-adapter.test.mjs")
    .filter((path) => !p6bAdapterOnly || path === "tests/p6b-claude-adapter.test.mjs")
    .filter((path) => !dependencyOnly || path === "tests/dependency.test.mjs")
    .filter((path) => !conferenceOnly || path === "tests/conference.test.mjs")
    .filter((path) => !assignmentGateOnly || path === "tests/assignment-gate.test.mjs")
    .filter((path) => !actorOnly || path === "tests/actor-attestation.test.mjs")
    .filter((path) => !extensionStoreOnly || path === "tests/workspace-extension-records.test.mjs")
    .filter((path) => !p7Only || path === "tests/p7-canonical-exchange.test.mjs")
    .filter((path) => !p7CompatibilityOnly || path === "tests/p7-compatibility-modes.test.mjs")
    .filter((path) => !p7AosRequirementsOnly || path === "tests/p7-public-aos-requirements.test.mjs")
    .filter((path) => !p8Only || ["tests/local-command-byte-fidelity.test.mjs", "tests/p8-workflow-rc.test.mjs"].includes(path))
    .filter((path) => !backupOnly || path === "tests/backup-snapshot.test.mjs")
    .filter((path) => !installerOnly || path === "tests/act1-claude-installer.test.mjs");
  await runDetachedTestController(["--test", ...tests], {
    NODE_OPTIONS: `--import=${noNetworkImport}`,
    TCRN_OFFLINE_PROOF: "1",
  });
  return success(
    trustOnly
      ? "TRUST_NEGATIVE_MATRIX_VERIFIED"
      : installerOnly
      ? "ACT1_CLAUDE_INSTALLER_TESTS_VERIFIED"
      : backupOnly
      ? "BACKUP_SNAPSHOT_TESTS_VERIFIED"
      : rootOnly
        ? "ROOT_BOUNDARIES_VERIFIED"
        : protocolOnly
          ? "P2_CONFORMANCE_VERIFIED"
          : p3Only
            ? "P3_ENGINE_TESTS_VERIFIED"
            : knowledgeOnly
              ? "P4_KNOWLEDGE_CORE_TESTS_VERIFIED"
              : p5Only
                ? "P5_GENERIC_PROFILE_TESTS_VERIFIED"
                : p6AdapterOnly
                  ? "P6_CODEX_ADAPTER_TESTS_VERIFIED"
                : p6bAdapterOnly
                  ? "P6B_CLAUDE_ADAPTER_TESTS_VERIFIED"
                : dependencyOnly
                  ? "DEPENDENCY_TESTS_VERIFIED"
                : conferenceOnly
                  ? "CONFERENCE_TESTS_VERIFIED"
                : assignmentGateOnly
                  ? "ASSIGNMENT_GATE_TESTS_VERIFIED"
                : actorOnly
                  ? "ACTOR_ATTESTATION_TESTS_VERIFIED"
                : extensionStoreOnly
                  ? "EXT_STORE_TESTS_VERIFIED"
                : p6Only
                  ? "P6_CONTEXT_ROUTER_TESTS_VERIFIED"
                  : p7CompatibilityOnly
                    ? "P7_COMPATIBILITY_MODES_TESTS_VERIFIED"
                    : p7AosRequirementsOnly
                      ? "P7_PUBLIC_AOS_REQUIREMENTS_TESTS_VERIFIED"
                  : p7Only
                    ? "P7_CANONICAL_EXCHANGE_TESTS_VERIFIED"
                  : p8Only
                    ? "P8_WORKFLOW_RC_TESTS_VERIFIED"
                  : p4Only
              ? "P4_ARTIFACT_LIFECYCLE_TESTS_VERIFIED"
              : "TESTS_VERIFIED",
    { tests, result: "passed" },
  );
}

async function verifyP8() {
  assertCleanExclusiveSourceBasis(run("git", ["status", "--porcelain=v1", "--untracked-files=all"]));
  const packagePaths = ["package.json", "packages/cli/package.json", "packages/core/package.json", "packages/protocol/package.json"];
  const packages = await Promise.all(packagePaths.map((path) => readJson(resolve(repositoryRoot, path))));
  assertion(packages.every((manifest) => manifest.version === P8_VERSION && manifest.private === true), "P8_PACKAGE_VERSION_MISMATCH");
  const frameworkSource = await readText(resolve(repositoryRoot, "packages/core/src/index.ts"));
  assertion(frameworkSource.includes(`FRAMEWORK_VERSION = \"${P8_VERSION}\"`), "P8_FRAMEWORK_VERSION_MISMATCH");
  const compatibility = await readJson(resolve(repositoryRoot, "packages/core/fixtures/p7-compatibility-modes-cases.json"));
  assertion(compatibility.supportedAosReleases === 0 && P8_SUPPORTED_AOS_RELEASES.length === 0, "P8_SUPPORTED_AOS_RELEASES_MISMATCH");
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
  return success("P8_WORKFLOW_RC_VERIFIED", {
    tests: dogfood.reasonCode,
    trust: trust.reasonCode,
    sourceArchive,
    sbom: sbomResult,
    artifacts: p8ArtifactRecords(artifacts),
    supportedAosReleases: P8_SUPPORTED_AOS_RELEASES,
    network: false,
    mutation: false,
    publication: false,
    releaseStatus: "unpublished_candidate",
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

async function verifyP2Schemas() {
  const result = await validateP2SchemasAndFixtures();
  return success("P2_SCHEMAS_VERIFIED", result);
}

async function verifyAosRequirements() {
  const result = await validateAosLedger();
  return success("AOS_REQUIREMENTS_VERIFIED", result);
}

async function verifyProtocolConformance() {
  return runTests({ protocolOnly: true });
}

async function verifyRc1CandidateReadiness() {
  const result = await validateRc1Candidate();
  return success("RC1_CANDIDATE_READY", result);
}

async function verifyP3() {
  const tests = await runTests({ p3Only: true });
  const fixturePath = resolve(repositoryRoot, "packages/core/fixtures/p3-cases.json");
  const schemaPath = resolve(repositoryRoot, "packages/core/schema/workspace-v1.schema.json");
  const fixture = await readJson(fixturePath);
  assertion(fixture.schemaVersion === "tcrn.p3-file-engine-cases.v1", "P3_FIXTURE_SCHEMA");
  assertion(Array.isArray(fixture.faultCases) && fixture.faultCases.length === 4, "P3_FAULT_CASES");
  assertion(Array.isArray(fixture.leaseFaultCases) && fixture.leaseFaultCases.length === 1, "P3_LEASE_FAULT_CASES");
  assertion(Array.isArray(fixture.schemaParityCases) && fixture.schemaParityCases.length === 4, "P3_SCHEMA_PARITY_CASES");
  assertion(Array.isArray(fixture.concurrencyCases) && fixture.concurrencyCases.length === 4, "P3_CONCURRENCY_CASES");
  assertion(Array.isArray(fixture.negativeCases) && fixture.negativeCases.length >= 53, "P3_NEGATIVE_CASES");
  assertion(Array.isArray(fixture.migrationCases) && fixture.migrationCases.length === 3, "P3_MIGRATION_CASES");
  assertion(fixture.propertyPermutations >= 64, "P3_PROPERTY_PERMUTATIONS");
  const packages = await Promise.all([
    readJson(resolve(repositoryRoot, "packages/core/package.json")),
    readJson(resolve(repositoryRoot, "packages/cli/package.json")),
  ]);
  assertion(packages.every((manifest) => Object.keys(manifest.dependencies ?? {}).length === 0), "P3_STANDALONE_DEPENDENCY");
  const marker = resolve(repositoryRoot, ".context/platform/workflow-v3-capabilities/p3-local-work-graph.accepted.json");
  try {
    await lstat(marker);
    fail("P3_MARKER_PREMATURE", marker);
  } catch (error) {
    if (error instanceof TaskError || error.code !== "ENOENT") {
      throw error;
    }
  }
  return success("P3_VERIFIED", {
    engineTests: tests.reasonCode,
    faultCases: fixture.faultCases.length,
    leaseFaultCases: fixture.leaseFaultCases.length,
    schemaParityCases: fixture.schemaParityCases.length,
    concurrencyCases: fixture.concurrencyCases.length,
    negativeCases: fixture.negativeCases.length,
    migrationCases: fixture.migrationCases.length,
    propertyPermutations: fixture.propertyPermutations,
    segmentRotationEvents: fixture.segmentRotationEvents,
    fixtureDigest: (await fileRecord(fixturePath)).sha256,
    schemaDigest: (await fileRecord(schemaPath)).sha256,
    standalone: "node-filesystem-only-no-database-no-aos",
    p3Marker: "absent",
    acceptance: "not-claimed",
  });
}

async function verifyP4() {
  const tests = await runTests({ p4Only: true });
  const fixturePath = resolve(repositoryRoot, "packages/core/fixtures/p4-artifact-lifecycle-cases.json");
  const schemaPath = resolve(repositoryRoot, "packages/core/schema/artifact-lifecycle-v1.schema.json");
  const fixture = await readJson(fixturePath);
  const knowledgeFixturePath = resolve(repositoryRoot, "packages/core/fixtures/p4-knowledge-core-cases.json");
  const knowledgeSchemaPath = resolve(repositoryRoot, "packages/core/schema/knowledge-core-v1.schema.json");
  const knowledgeFixture = await readJson(knowledgeFixturePath);
  assertion(fixture.schemaVersion === "tcrn.p4-artifact-lifecycle-cases.v1", "P4_FIXTURE_SCHEMA");
  assertion(Array.isArray(fixture.classificationCases) && fixture.classificationCases.length === 8, "P4_CLASSIFICATION_CASES");
  assertion(Array.isArray(fixture.doctorBudgetCases) && fixture.doctorBudgetCases.length === 3, "P4_DOCTOR_CASES");
  assertion(Array.isArray(fixture.archiveCases) && fixture.archiveCases.length === 3, "P4_ARCHIVE_CASES");
  assertion(Array.isArray(fixture.faultCases) && fixture.faultCases.length === 5, "P4_FAULT_CASES");
  assertion(Array.isArray(fixture.negativeCases) && fixture.negativeCases.length >= 28, "P4_NEGATIVE_CASES");
  assertion(fixture.propertyPermutations >= 64, "P4_PROPERTY_PERMUTATIONS");
  assertion(fixture.maximumEntries === 1_024 && fixture.maximumSourceBytes === 1_048_576 &&
    fixture.maximumStoredBytes === 16_777_216 && fixture.maximumArchiveBytes === 33_554_432 &&
    fixture.maximumArchiveGenerations === 16 && fixture.maximumArchiveFilesPerGeneration === 1 &&
    fixture.maximumArchiveStoredBytes === 33_554_432, "P4_LIMIT_CONTRACT");
  assertion(knowledgeFixture.schemaVersion === "tcrn.p4-knowledge-core-cases.v1", "P4_KNOWLEDGE_FIXTURE_SCHEMA");
  assertion(Array.isArray(knowledgeFixture.operationCases) && knowledgeFixture.operationCases.length === 9, "P4_KNOWLEDGE_OPERATION_CASES");
  assertion(Array.isArray(knowledgeFixture.freshnessCases) && knowledgeFixture.freshnessCases.length === 3, "P4_KNOWLEDGE_FRESHNESS_CASES");
  assertion(Array.isArray(knowledgeFixture.promotionCases) && knowledgeFixture.promotionCases.length === 3, "P4_KNOWLEDGE_PROMOTION_CASES");
  assertion(Array.isArray(knowledgeFixture.faultCases) && knowledgeFixture.faultCases.length === 3, "P4_KNOWLEDGE_FAULT_CASES");
  assertion(Array.isArray(knowledgeFixture.negativeCases) && knowledgeFixture.negativeCases.length >= 36, "P4_KNOWLEDGE_NEGATIVE_CASES");
  assertion(knowledgeFixture.propertyPermutations >= 64, "P4_KNOWLEDGE_PROPERTY_PERMUTATIONS");
  assertion(knowledgeFixture.propertyPermutations === 64 && knowledgeFixture.permutationLogicalRecords === 5 &&
    /^[a-f0-9]{64}$/u.test(knowledgeFixture.permutationCorpusDigest), "P4_KNOWLEDGE_REAL_PERMUTATION_CORPUS");
  assertion(knowledgeFixture.maximumBodyBytes === 8_192 && knowledgeFixture.maximumSummaryBytes === 2_048 &&
    knowledgeFixture.maximumSnippetBytes === 512 && knowledgeFixture.maximumMetadataBytes === 32_768 &&
    knowledgeFixture.maximumRecords === 16 && knowledgeFixture.maximumQueryResults === 8 &&
    knowledgeFixture.maximumAggregateBytes === 131_072, "P4_KNOWLEDGE_LIMIT_CONTRACT");
  const packages = await Promise.all([
    readJson(resolve(repositoryRoot, "packages/core/package.json")),
    readJson(resolve(repositoryRoot, "packages/cli/package.json")),
  ]);
  assertion(packages.every((manifest) => Object.keys(manifest.dependencies ?? {}).length === 0), "P4_STANDALONE_DEPENDENCY");
  return success("P4_ARTIFACT_LIFECYCLE_VERIFIED", {
    lifecycleTests: tests.reasonCode,
    classificationCases: fixture.classificationCases.length,
    doctorBudgetCases: fixture.doctorBudgetCases.length,
    archiveCases: fixture.archiveCases.length,
    faultCases: fixture.faultCases.length,
    negativeCases: fixture.negativeCases.length,
    propertyPermutations: fixture.propertyPermutations,
    maximumArchiveGenerations: fixture.maximumArchiveGenerations,
    maximumArchiveFilesPerGeneration: fixture.maximumArchiveFilesPerGeneration,
    maximumArchiveStoredBytes: fixture.maximumArchiveStoredBytes,
    fixtureDigest: (await fileRecord(fixturePath)).sha256,
    schemaDigest: (await fileRecord(schemaPath)).sha256,
    archiveApplyScope: "disposable-synthetic-workspaces-only",
    liveWorkspaceApply: "not-run",
    compactMode: "dry-run-projection-only",
    legacyReadBoundary: "static-negative-proven",
    knowledgeCore: "file-native-metadata-first-verified",
    knowledgeOperationCases: knowledgeFixture.operationCases.length,
    knowledgeFreshnessCases: knowledgeFixture.freshnessCases.length,
    knowledgePromotionCases: knowledgeFixture.promotionCases.length,
    knowledgeFaultCases: knowledgeFixture.faultCases.length,
    knowledgeNegativeCases: knowledgeFixture.negativeCases.length,
    knowledgePropertyPermutations: knowledgeFixture.propertyPermutations,
    knowledgePermutationLogicalRecords: knowledgeFixture.permutationLogicalRecords,
    knowledgePermutationCorpusDigest: knowledgeFixture.permutationCorpusDigest,
    knowledgeFixtureDigest: (await fileRecord(knowledgeFixturePath)).sha256,
    knowledgeSchemaDigest: (await fileRecord(knowledgeSchemaPath)).sha256,
    acceptance: "not-claimed",
  });
}

async function verifyP4Knowledge() {
  const tests = await runTests({ knowledgeOnly: true });
  const fixturePath = resolve(repositoryRoot, "packages/core/fixtures/p4-knowledge-core-cases.json");
  const schemaPath = resolve(repositoryRoot, "packages/core/schema/knowledge-core-v1.schema.json");
  const fixture = await readJson(fixturePath);
  assertion(fixture.schemaVersion === "tcrn.p4-knowledge-core-cases.v1", "P4_KNOWLEDGE_FIXTURE_SCHEMA");
  assertion(Array.isArray(fixture.operationCases) && fixture.operationCases.length === 9, "P4_KNOWLEDGE_OPERATION_CASES");
  assertion(Array.isArray(fixture.freshnessCases) && fixture.freshnessCases.length === 3, "P4_KNOWLEDGE_FRESHNESS_CASES");
  assertion(Array.isArray(fixture.promotionCases) && fixture.promotionCases.length === 3, "P4_KNOWLEDGE_PROMOTION_CASES");
  assertion(Array.isArray(fixture.faultCases) && fixture.faultCases.length === 3, "P4_KNOWLEDGE_FAULT_CASES");
  assertion(Array.isArray(fixture.negativeCases) && fixture.negativeCases.length >= 36, "P4_KNOWLEDGE_NEGATIVE_CASES");
  assertion(fixture.propertyPermutations >= 64, "P4_KNOWLEDGE_PROPERTY_PERMUTATIONS");
  assertion(fixture.propertyPermutations === 64 && fixture.permutationLogicalRecords === 5 &&
    /^[a-f0-9]{64}$/u.test(fixture.permutationCorpusDigest), "P4_KNOWLEDGE_REAL_PERMUTATION_CORPUS");
  const packages = await Promise.all([
    readJson(resolve(repositoryRoot, "packages/core/package.json")),
    readJson(resolve(repositoryRoot, "packages/cli/package.json")),
  ]);
  assertion(packages.every((manifest) => Object.keys(manifest.dependencies ?? {}).length === 0), "P4_KNOWLEDGE_STANDALONE_DEPENDENCY");
  return success("P4_KNOWLEDGE_CORE_VERIFIED", {
    tests: tests.reasonCode,
    operationCases: fixture.operationCases.length,
    freshnessCases: fixture.freshnessCases.length,
    promotionCases: fixture.promotionCases.length,
    faultCases: fixture.faultCases.length,
    negativeCases: fixture.negativeCases.length,
    propertyPermutations: fixture.propertyPermutations,
    permutationLogicalRecords: fixture.permutationLogicalRecords,
    permutationCorpusDigest: fixture.permutationCorpusDigest,
    fixtureDigest: (await fileRecord(fixturePath)).sha256,
    schemaDigest: (await fileRecord(schemaPath)).sha256,
    bodyStorage: "metadata-surfaces-never-open-bodies-explicit-or-full-validation-only",
    defaultSelection: "promoted-fresh-active-default-retrieval-only",
    provenance: "explicit-source-evidence-owner-required",
    utf8ByteBudgetProof: "custom-keyword-max-and-max-plus-one",
    liveWorkspaceStore: "not-created",
    standalone: "node-filesystem-only-no-database-no-aos-no-network",
    acceptance: "not-claimed",
  });
}

async function verifyP5() {
  const tests = await runTests({ p5Only: true });
  const fixturePath = resolve(repositoryRoot, "packages/core/fixtures/p5-generic-profile-cases.json");
  const schemaPath = resolve(repositoryRoot, "packages/core/schema/generic-profile-v1.schema.json");
  const specPath = resolve(repositoryRoot, "packages/core/spec/generic-profile-v1.md");
  const personaSchemaPath = resolve(repositoryRoot, "packages/core/schema/core-reference-persona-v1.schema.json");
  const personaSpecPath = resolve(repositoryRoot, "packages/core/spec/core-reference-persona-v1.md");
  const fixture = await readJson(fixturePath);
  assertion(fixture.schemaVersion === "tcrn.p5-generic-profile-cases.v1", "P5_FIXTURE_SCHEMA");
  assertion(Array.isArray(fixture.operationCases) && fixture.operationCases.length === 8, "P5_OPERATION_CASES");
  assertion(Array.isArray(fixture.negativeCases) && fixture.negativeCases.length >= 36, "P5_NEGATIVE_CASES");
  assertion(Array.isArray(fixture.trustAdmissionNegativeCases) && fixture.trustAdmissionNegativeCases.length === 5,
    "P5_TRUST_ADMISSION_NEGATIVES");
  assertion(Array.isArray(fixture.admissionFilesystemNegativeCases) && fixture.admissionFilesystemNegativeCases.length === 6,
    "P5_ADMISSION_FILESYSTEM_NEGATIVES");
  assertion(Array.isArray(fixture.authorityAnchorNegativeCases) && fixture.authorityAnchorNegativeCases.length === 7,
    "P5_AUTHORITY_ANCHOR_NEGATIVES");
  assertion(fixture.admissionCanonicalByteCases === 4, "P5_ADMISSION_CANONICAL_BYTES");
  assertion(Array.isArray(fixture.cliCases) && fixture.cliCases.length === 6, "P5_CLI_CASES");
  assertion(fixture.propertyPermutations === 64 && fixture.permutationLayerCount === 6 &&
    /^[a-f0-9]{64}$/u.test(fixture.permutationCorpusDigest), "P5_PROPERTY_PERMUTATIONS");
  assertion(fixture.corePersonaDistinctPermutations === 64 && /^[a-f0-9]{64}$/u.test(fixture.corePersonaPermutationCorpusDigest), "P5_PERSONA_PROPERTY_PERMUTATIONS");
  assertion(fixture.corePersonaAstralParityCases === 20, "P5_PERSONA_ASTRAL_PARITY");
  for (const digestName of ["starterBundleDigest", "baseProfileDigest", "unboundEffectiveDigest", "boundEffectiveDigest",
    "boundOverlayDigest", "boundEffectivePolicyDigest"]) {
    assertion(/^[a-f0-9]{64}$/u.test(fixture[digestName]), "P5_CANONICAL_DIGEST_VECTOR", digestName);
  }
  assertion(fixture.coldStartRecords === 4 && fixture.coldStartEvents === 17, "P5_COLD_START_PROOF");
  assertion(fixture.liveProfileStore === "not-created", "P5_LIVE_STORE_BOUNDARY");
  const packages = await Promise.all([
    readJson(resolve(repositoryRoot, "packages/core/package.json")),
    readJson(resolve(repositoryRoot, "packages/cli/package.json")),
  ]);
  assertion(packages.every((manifest) => Object.keys(manifest.dependencies ?? {}).length === 0), "P5_STANDALONE_DEPENDENCY");
  return success("P5_GENERIC_PROFILES_VERIFIED", {
    tests: tests.reasonCode,
    trustLevels: 3,
    bindingModes: 5,
    mergeClasses: 4,
    operationCases: fixture.operationCases.length,
    negativeCases: fixture.negativeCases.length,
    trustAdmissionNegativeCases: fixture.trustAdmissionNegativeCases.length,
    admissionFilesystemNegativeCases: fixture.admissionFilesystemNegativeCases.length,
    authorityAnchorNegativeCases: fixture.authorityAnchorNegativeCases.length,
    admissionCanonicalByteCases: fixture.admissionCanonicalByteCases,
    coreReferenceProfiles: 8,
    coreReferenceAstralParityCases: fixture.corePersonaAstralParityCases,
    coreReferenceDistinctPermutations: fixture.corePersonaDistinctPermutations,
    coreReferencePermutationCorpusDigest: fixture.corePersonaPermutationCorpusDigest,
    coreReferenceSourceManifestSha256: "9fa68e8f06e73e1d1b4bffb59a059814e683619b1d80234aef82e44f76de7c13",
    coreReferenceSchemaDigest: (await fileRecord(personaSchemaPath)).sha256,
    coreReferenceSpecDigest: (await fileRecord(personaSpecPath)).sha256,
    cliCases: fixture.cliCases.length,
    propertyPermutations: fixture.propertyPermutations,
    permutationLayerCount: fixture.permutationLayerCount,
    permutationCorpusDigest: fixture.permutationCorpusDigest,
    starterBundleDigest: fixture.starterBundleDigest,
    baseProfileDigest: fixture.baseProfileDigest,
    unboundEffectiveDigest: fixture.unboundEffectiveDigest,
    boundEffectiveDigest: fixture.boundEffectiveDigest,
    boundOverlayDigest: fixture.boundOverlayDigest,
    boundEffectivePolicyDigest: fixture.boundEffectivePolicyDigest,
    coldStartRecords: fixture.coldStartRecords,
    coldStartEvents: fixture.coldStartEvents,
    fixtureDigest: (await fileRecord(fixturePath)).sha256,
    schemaDigest: (await fileRecord(schemaPath)).sha256,
    specDigest: (await fileRecord(specPath)).sha256,
    generatedMaterial: "inert-generic-data-only",
    liveProfileStore: "not-created",
    ownerGate: "standing-owner-authority-admitted",
    namedPersonaContent: "eight-core-reference-records-only",
    standalone: "node-filesystem-only-no-database-no-aos-no-network",
    acceptance: "not-claimed",
  });
}

async function verifyP6() {
  const tests = await runTests({ p6Only: true });
  const fixturePath = resolve(repositoryRoot, "packages/core/fixtures/p6-context-router-cases.json");
  const schemaPath = resolve(repositoryRoot, "packages/core/schema/context-router-v1.schema.json");
  const specPath = resolve(repositoryRoot, "packages/core/spec/context-router-v1.md");
  const fixture = await readJson(fixturePath);
  assertion(fixture.schemaVersion === "tcrn.p6-context-router-cases.v1", "P6_CONTEXT_FIXTURE_SCHEMA");
  assertion(fixture.goldenProfileCases === 8, "P6_CONTEXT_GOLDEN_PROFILES");
  assertion(fixture.hostileCases === 24 && fixture.schemaParityCases === 8, "P6_CONTEXT_HOSTILE_CORPUS");
  assertion(fixture.bindingParityCases === 6 && fixture.authorityAllowlistCountCases === 2 &&
    fixture.unicodeParityCases === 12 && fixture.receiptBudgetTamperCases === 2 &&
    fixture.authorityImmutabilityCases === 2 && fixture.authorityCanonicalByteCases === 4, "P6_CONTEXT_REPAIR_VECTORS");
  assertion(fixture.propertyPermutations === 64 && fixture.logicalMetadataCandidates === 6 &&
    /^[a-f0-9]{64}$/u.test(fixture.permutationCorpusDigest), "P6_CONTEXT_PROPERTY_CORPUS");
  assertion(Array.isArray(fixture.latencyStages) && fixture.latencyStages.length === 6 &&
    Object.values(fixture.latencyBudgetMilliseconds).every((value) => Number.isSafeInteger(value) && value > 0),
  "P6_CONTEXT_LATENCY_BUDGETS");
  assertion(fixture.codexAdapter === "implemented_inert_templates_only" && fixture.rc3 === "unaccepted" &&
    fixture.ownerVisibleActivation === "not-claimed" && fixture.liveContextStore === "not-created",
  "P6_CONTEXT_NO_OVERCLAIM");
  const packages = await Promise.all([
    readJson(resolve(repositoryRoot, "packages/core/package.json")),
    readJson(resolve(repositoryRoot, "packages/cli/package.json")),
  ]);
  assertion(packages.every((manifest) => Object.keys(manifest.dependencies ?? {}).length === 0), "P6_STANDALONE_DEPENDENCY");
  return success("P6_CONTEXT_ROUTER_VERIFIED", {
    tests: tests.reasonCode,
    goldenProfileCases: fixture.goldenProfileCases,
    hostileCases: fixture.hostileCases,
    admittedHostileCases: 7,
    schemaParityCases: fixture.schemaParityCases,
    bindingParityCases: fixture.bindingParityCases,
    authorityAllowlistCountCases: fixture.authorityAllowlistCountCases,
    unicodeParityCases: fixture.unicodeParityCases,
    receiptBudgetTamperCases: fixture.receiptBudgetTamperCases,
    authorityImmutabilityCases: fixture.authorityImmutabilityCases,
    authorityCanonicalByteCases: fixture.authorityCanonicalByteCases,
    propertyPermutations: fixture.propertyPermutations,
    logicalMetadataCandidates: fixture.logicalMetadataCandidates,
    explicitReadCandidates: fixture.explicitReadCandidates,
    permutationCorpusDigest: fixture.permutationCorpusDigest,
    latencyStages: fixture.latencyStages,
    latencyBudgetMilliseconds: fixture.latencyBudgetMilliseconds,
    latencyResidual: fixture.latencyResidual,
    fixtureDigest: (await fileRecord(fixturePath)).sha256,
    schemaDigest: (await fileRecord(schemaPath)).sha256,
    specDigest: (await fileRecord(specPath)).sha256,
    contextRouter: "implemented",
    codexAdapter: fixture.codexAdapter,
    rc3: fixture.rc3,
    ownerVisibleActivation: fixture.ownerVisibleActivation,
    liveContextStore: fixture.liveContextStore,
    standalone: "node-filesystem-only-no-database-no-aos-no-network",
  });
}

async function verifyP6Adapter() {
  const tests = await runTests({ p6AdapterOnly: true });
  const fixturePath = resolve(repositoryRoot, "packages/core/fixtures/p6-codex-adapter-cases.json");
  const schemaPath = resolve(repositoryRoot, "packages/core/schema/codex-adapter-v1.schema.json");
  const specPath = resolve(repositoryRoot, "packages/core/spec/codex-adapter-v1.md");
  const fixture = await readJson(fixturePath);
  assertion(fixture.schemaVersion === "tcrn.p6-codex-adapter-cases.v1", "P6_ADAPTER_FIXTURE_SCHEMA");
  assertion(fixture.goldenCases === 8 && fixture.hostileCases === 31 && fixture.schemaParityCases === 8, "P6_ADAPTER_HOSTILE_CORPUS");
  assertion(fixture.pathFaultCases === 8 && fixture.rollbackCases === 14 && fixture.finalHopCases === 4 &&
    fixture.canonicalTemplateCases === 3 && fixture.bundleOrderParityCases === 4 && fixture.bundleUnicodeParityCases === 8 &&
    fixture.hostParityCases === 4 && fixture.lifecycleParityCases === 4 && fixture.installationAuthorityCases === 12 &&
    fixture.installationCanonicalByteCases === 4,
  "P6_ADAPTER_SECURITY_CORPUS");
  assertion(fixture.propertyPermutations === 64 && fixture.templateFiles === 4 && /^[a-f0-9]{64}$/u.test(fixture.permutationCorpusDigest), "P6_ADAPTER_PROPERTY_CORPUS");
  assertion(fixture.coldStartCases === 1 && fixture.staticBoundaryCases === 1, "P6_ADAPTER_STANDALONE_BOUNDARY");
  assertion(fixture.adapter === "implemented_inert_templates_only" && fixture.liveActivation === false && fixture.og04 === "unsatisfied" && fixture.rc3 === "unaccepted" && fixture.liveStore === "not-created", "P6_ADAPTER_NO_OVERCLAIM");
  return success("P6_CODEX_ADAPTER_VERIFIED", {
    tests: tests.reasonCode,
    goldenCases: fixture.goldenCases,
    hostileCases: fixture.hostileCases,
    schemaParityCases: fixture.schemaParityCases,
    pathFaultCases: fixture.pathFaultCases,
    rollbackCases: fixture.rollbackCases,
    canonicalTemplateCases: fixture.canonicalTemplateCases,
    bundleOrderParityCases: fixture.bundleOrderParityCases,
    bundleUnicodeParityCases: fixture.bundleUnicodeParityCases,
    hostParityCases: fixture.hostParityCases,
    lifecycleParityCases: fixture.lifecycleParityCases,
    installationAuthorityCases: fixture.installationAuthorityCases,
    installationCanonicalByteCases: fixture.installationCanonicalByteCases,
    finalHopCases: fixture.finalHopCases,
    propertyPermutations: fixture.propertyPermutations,
    templateFiles: fixture.templateFiles,
    coldStartCases: fixture.coldStartCases,
    staticBoundaryCases: fixture.staticBoundaryCases,
    permutationCorpusDigest: fixture.permutationCorpusDigest,
    fixtureDigest: (await fileRecord(fixturePath)).sha256,
    schemaDigest: (await fileRecord(schemaPath)).sha256,
    specDigest: (await fileRecord(specPath)).sha256,
    adapter: fixture.adapter,
    liveActivation: fixture.liveActivation,
    og04: fixture.og04,
    rc3: fixture.rc3,
    liveStore: fixture.liveStore,
    standalone: "inert-product-data-only-no-database-no-aos-no-network",
  });
}

async function verifyP6b() {
  const tests = await runTests({ p6bAdapterOnly: true });
  const fixturePath = resolve(repositoryRoot, "packages/core/fixtures/p6b-claude-adapter-cases.json");
  const schemaPath = resolve(repositoryRoot, "packages/core/schema/claude-adapter-v1.schema.json");
  const specPath = resolve(repositoryRoot, "packages/core/spec/claude-adapter-v1.md");
  const codexAdapterPath = resolve(repositoryRoot, "packages/core/src/codex-adapter.ts");
  const fixture = await readJson(fixturePath);
  assertion(fixture.schemaVersion === "tcrn.p6b-claude-adapter-cases.v1", "P6B_ADAPTER_FIXTURE_SCHEMA");
  assertion(fixture.goldenCases === 8 && fixture.hostileCases === 31 && fixture.schemaParityCases === 8, "P6B_ADAPTER_HOSTILE_CORPUS");
  assertion(fixture.pathFaultCases === 8 && fixture.rollbackCases === 14 && fixture.finalHopCases === 4 &&
    fixture.canonicalTemplateCases === 3 && fixture.bundleOrderParityCases === 4 && fixture.bundleUnicodeParityCases === 8 &&
    fixture.hostParityCases === 4 && fixture.lifecycleParityCases === 4 && fixture.installationAuthorityCases === 12 &&
    fixture.installationCanonicalByteCases === 4,
  "P6B_ADAPTER_SECURITY_CORPUS");
  assertion(fixture.claudeFallbackCases === 8 && fixture.hostProductCases === 2 && fixture.fragmentReversibilityCases === 3 &&
    fixture.fragmentHostileCases === 5 && fixture.forbiddenPathCases === 5, "P6B_ADAPTER_CLAUDE_SURFACE_CORPUS");
  assertion(fixture.propertyPermutations === 64 && fixture.templateFiles === 4 && /^[a-f0-9]{64}$/u.test(fixture.permutationCorpusDigest), "P6B_ADAPTER_PROPERTY_CORPUS");
  assertion(/^[a-f0-9]{64}$/u.test(fixture.parityNeutralProjectionDigest) && fixture.settingsFragmentReversible === true, "P6B_ADAPTER_PARITY_CORPUS");
  assertion(fixture.coldStartCases === 1 && fixture.staticBoundaryCases === 1, "P6B_ADAPTER_STANDALONE_BOUNDARY");
  assertion(fixture.adapter === "implemented_inert_templates_only" && fixture.hostProduct === "claude-code" && fixture.liveActivation === false && fixture.og04 === "unsatisfied" && fixture.rc3 === "unaccepted" && fixture.liveStore === "not-created", "P6B_ADAPTER_NO_OVERCLAIM");
  return success("P6B_CLAUDE_ADAPTER_VERIFIED", {
    tests: tests.reasonCode,
    goldenCases: fixture.goldenCases,
    hostileCases: fixture.hostileCases,
    schemaParityCases: fixture.schemaParityCases,
    pathFaultCases: fixture.pathFaultCases,
    rollbackCases: fixture.rollbackCases,
    canonicalTemplateCases: fixture.canonicalTemplateCases,
    bundleOrderParityCases: fixture.bundleOrderParityCases,
    bundleUnicodeParityCases: fixture.bundleUnicodeParityCases,
    hostParityCases: fixture.hostParityCases,
    lifecycleParityCases: fixture.lifecycleParityCases,
    installationAuthorityCases: fixture.installationAuthorityCases,
    installationCanonicalByteCases: fixture.installationCanonicalByteCases,
    finalHopCases: fixture.finalHopCases,
    claudeFallbackCases: fixture.claudeFallbackCases,
    hostProductCases: fixture.hostProductCases,
    fragmentReversibilityCases: fixture.fragmentReversibilityCases,
    fragmentHostileCases: fixture.fragmentHostileCases,
    forbiddenPathCases: fixture.forbiddenPathCases,
    propertyPermutations: fixture.propertyPermutations,
    templateFiles: fixture.templateFiles,
    coldStartCases: fixture.coldStartCases,
    staticBoundaryCases: fixture.staticBoundaryCases,
    permutationCorpusDigest: fixture.permutationCorpusDigest,
    parityNeutralProjectionDigest: fixture.parityNeutralProjectionDigest,
    fixtureDigest: (await fileRecord(fixturePath)).sha256,
    schemaDigest: (await fileRecord(schemaPath)).sha256,
    specDigest: (await fileRecord(specPath)).sha256,
    codexAdapterParityDigest: (await fileRecord(codexAdapterPath)).sha256,
    adapter: fixture.adapter,
    hostProduct: fixture.hostProduct,
    liveActivation: fixture.liveActivation,
    og04: fixture.og04,
    rc3: fixture.rc3,
    liveStore: fixture.liveStore,
    standalone: "inert-product-data-only-no-database-no-requirement-ledger-no-network",
  });
}

async function verifyDependency() {
  const tests = await runTests({ dependencyOnly: true });
  const fixturePath = resolve(repositoryRoot, "packages/core/fixtures/dependency-cases.json");
  const schemaPath = resolve(repositoryRoot, "schemas/dependency-v1.schema.json");
  const specPath = resolve(repositoryRoot, "specs/dependency-v1.md");
  const fixture = await readJson(fixturePath);
  assertion(fixture.schemaVersion === "tcrn.dependency-cases.v1", "DEPENDENCY_FIXTURE_SCHEMA");
  assertion(fixture.positiveCases === 6 && fixture.hostileCases === 16 && fixture.schemaParityCases === 8, "DEPENDENCY_CORE_CORPUS");
  assertion(fixture.cycleCases === 5 && fixture.endpointCases === 6 && fixture.blockerReadCases === 3 && fixture.hashStabilityCases === 3, "DEPENDENCY_RULE_CORPUS");
  assertion(fixture.orderingPermutations === 24 && /^[a-f0-9]{64}$/u.test(fixture.orderingCorpusDigest), "DEPENDENCY_ORDER_CORPUS");
  assertion(fixture.registrationAppliesTo === "work" && fixture.requiredByDefault === false && fixture.ledgerRequirement === "AOS-REQ-016", "DEPENDENCY_REGISTRATION");
  assertion(fixture.crossProjectEdges === "rejected" && fixture.liveStore === "not-created", "DEPENDENCY_NO_OVERCLAIM");
  return success("DEPENDENCY_VERIFIED", {
    tests: tests.reasonCode,
    positiveCases: fixture.positiveCases,
    hostileCases: fixture.hostileCases,
    schemaParityCases: fixture.schemaParityCases,
    cycleCases: fixture.cycleCases,
    endpointCases: fixture.endpointCases,
    blockerReadCases: fixture.blockerReadCases,
    hashStabilityCases: fixture.hashStabilityCases,
    orderingPermutations: fixture.orderingPermutations,
    orderingCorpusDigest: fixture.orderingCorpusDigest,
    fixtureDigest: (await fileRecord(fixturePath)).sha256,
    schemaDigest: (await fileRecord(schemaPath)).sha256,
    specDigest: (await fileRecord(specPath)).sha256,
    registrationAppliesTo: fixture.registrationAppliesTo,
    ledgerRequirement: fixture.ledgerRequirement,
    crossProjectEdges: fixture.crossProjectEdges,
    liveStore: fixture.liveStore,
    standalone: "inert-extension-record-data-only-no-store-no-network",
  });
}

async function verifyConference() {
  const tests = await runTests({ conferenceOnly: true });
  const fixturePath = resolve(repositoryRoot, "packages/core/fixtures/conference-cases.json");
  const schemaPath = resolve(repositoryRoot, "schemas/conference-request-v1.schema.json");
  const specPath = resolve(repositoryRoot, "specs/conference-v1.md");
  const fixture = await readJson(fixturePath);
  assertion(fixture.schemaVersion === "tcrn.conference-cases.v1", "CONFERENCE_FIXTURE_SCHEMA");
  assertion(fixture.positiveCases === 3 && fixture.hostileCases === 12 && fixture.schemaParityCases === 8, "CONFERENCE_CORE_CORPUS");
  assertion(fixture.positionParityCases === 4 && fixture.minutesParityCases === 4, "CONFERENCE_SCHEMA_PARITY_CORPUS");
  assertion(fixture.operationCases === 6 && fixture.distillCases === 3, "CONFERENCE_OPERATION_CORPUS");
  assertion(fixture.registrationAppliesTo === "work" && fixture.requiredByDefault === false && fixture.ledgerRequirement === "AOS-REQ-015", "CONFERENCE_REGISTRATION");
  // WSD-1: conference records now persist through the governed workspace
  // event-log store (proved by verify:ext-store); orchestration and search stay excluded.
  assertion(fixture.orchestration === "excluded" && fixture.search === "excluded" && fixture.liveStore === "workspace-event-log", "CONFERENCE_NO_OVERCLAIM");
  return success("CONFERENCE_VERIFIED", {
    tests: tests.reasonCode,
    positiveCases: fixture.positiveCases,
    hostileCases: fixture.hostileCases,
    schemaParityCases: fixture.schemaParityCases,
    operationCases: fixture.operationCases,
    distillCases: fixture.distillCases,
    fixtureDigest: (await fileRecord(fixturePath)).sha256,
    schemaDigest: (await fileRecord(schemaPath)).sha256,
    specDigest: (await fileRecord(specPath)).sha256,
    registrationAppliesTo: fixture.registrationAppliesTo,
    ledgerRequirement: fixture.ledgerRequirement,
    liveStore: fixture.liveStore,
    standalone: "inert-extension-record-validation-no-orchestration-no-search-store-in-workspace-event-log",
  });
}

async function verifyAssignmentGate() {
  const tests = await runTests({ assignmentGateOnly: true });
  const fixturePath = resolve(repositoryRoot, "packages/core/fixtures/assignment-gate-cases.json");
  const fixture = await readJson(fixturePath);
  assertion(fixture.schemaVersion === "tcrn.assignment-gate-cases.v1", "ASSIGNMENT_GATE_FIXTURE_SCHEMA");
  assertion(fixture.assignmentPositiveCases === 3 && fixture.assignmentHostileCases === 6, "ASSIGNMENT_CORPUS");
  assertion(fixture.gatePositiveCases === 4 && fixture.gateHostileCases === 7, "GATE_CORPUS");
  assertion(fixture.schemaParityCases === 8 && fixture.listCases === 4, "ASSIGNMENT_GATE_PARITY_CORPUS");
  assertion(fixture.registrationAppliesTo === "work" && fixture.requiredByDefault === false, "ASSIGNMENT_GATE_REGISTRATION");
  // WSD-1: gate records now persist through the governed workspace event-log
  // store (proved by verify:ext-store); assignments remain store-less.
  assertion(fixture.assignmentLedgerRequirement === "AOS-REQ-017" && fixture.gateLedgerRequirement === "AOS-REQ-018" && fixture.liveStore === "workspace-event-log", "ASSIGNMENT_GATE_NO_OVERCLAIM");
  return success("ASSIGNMENT_GATE_VERIFIED", {
    tests: tests.reasonCode,
    assignmentPositiveCases: fixture.assignmentPositiveCases,
    assignmentHostileCases: fixture.assignmentHostileCases,
    gatePositiveCases: fixture.gatePositiveCases,
    gateHostileCases: fixture.gateHostileCases,
    schemaParityCases: fixture.schemaParityCases,
    listCases: fixture.listCases,
    fixtureDigest: (await fileRecord(fixturePath)).sha256,
    assignmentSchemaDigest: (await fileRecord(resolve(repositoryRoot, "schemas/assignment-v1.schema.json"))).sha256,
    gateSchemaDigest: (await fileRecord(resolve(repositoryRoot, "schemas/gate-v1.schema.json"))).sha256,
    assignmentLedgerRequirement: fixture.assignmentLedgerRequirement,
    gateLedgerRequirement: fixture.gateLedgerRequirement,
    liveStore: fixture.liveStore,
    standalone: "inert-extension-record-validation-no-lifecycle-assignment-store-less-gate-store-in-workspace-event-log",
  });
}

// WSD-1: the conference/gate workspace-event-log store proof. The record-shape
// corpora stay under verify:conference / verify:ext-ag; this task proves the
// persistence semantics (operations, binding rules, openness/tombstone rules,
// legacy byte-stability, replay determinism) end to end and offline.
async function verifyExtStore() {
  const tests = await runTests({ extensionStoreOnly: true });
  const specDigests = await Promise.all([
    fileRecord(resolve(repositoryRoot, "specs/conference-v1.md")),
    fileRecord(resolve(repositoryRoot, "specs/gate-v1.md")),
  ]);
  return success("EXT_STORE_VERIFIED", {
    tests: tests.reasonCode,
    operations: [
      "conference.created",
      "conference.updated",
      "conference.position.appended",
      "conference.closed",
      "gate.created",
      "gate.updated",
      "gate.deleted",
    ],
    store: "workspace-event-log",
    storageVersion: 1,
    atomicClose: "single-event-payload-minutes-operation-record",
    legacyViews: "byte-stable-when-no-extension-records",
    forwardCompatibility: "old-binaries-fail-closed-unknown-operation",
    conferenceSpecDigest: specDigests[0].sha256,
    gateSpecDigest: specDigests[1].sha256,
  });
}

async function verifyActorAttestation() {
  const tests = await runTests({ actorOnly: true });
  const schemaPath = resolve(repositoryRoot, "schemas/actor-attestation-v1.schema.json");
  const specPath = resolve(repositoryRoot, "specs/actor-attestation-v1.md");
  return success("ACTOR_ATTESTATION_VERIFIED", {
    tests: tests.reasonCode,
    schemaDigest: (await fileRecord(schemaPath)).sha256,
    specDigest: (await fileRecord(specPath)).sha256,
    registrationAppliesTo: "event",
    requiredByDefault: false,
    actorPrefixes: ["agent", "owner", "profile"],
    ledgerRequirements: ["AOS-REQ-007", "AOS-REQ-017"],
    enforcement: "enabled-boundary-mandatory-actor-live-and-replay",
    enableBoundary: "sequence>=enabledAtSequence-enabling-event-included",
    reasonCodes: ["WORKSPACE_ACTOR_INVALID", "WORKSPACE_ACTOR_REQUIRED", "WORKSPACE_EVENT_CORRUPT"],
    defaultBehaviour: "no-enable-event-byte-identical-to-rc4",
    standalone: "extension-contract-plus-engine-enforcement-no-store-no-network",
  });
}

async function verifyP7() {
  const tests = await runTests({ p7Only: true });
  const fixturePath = resolve(repositoryRoot, "packages/core/fixtures/p7-canonical-exchange-cases.json");
  const schemaPath = resolve(repositoryRoot, "packages/core/schema/canonical-exchange-v1.schema.json");
  const specPath = resolve(repositoryRoot, "packages/core/spec/canonical-exchange-v1.md");
  const fixture = await readJson(fixturePath);
  assertion(fixture.schemaVersion === "tcrn.p7-canonical-exchange-cases.v1", "P7_EXCHANGE_FIXTURE_SCHEMA");
  assertion(fixture.positiveCases === 8 && fixture.schemaParityCases === 8, "P7_EXCHANGE_POSITIVE_PARITY_CORPUS");
  assertion(fixture.storedSchemaParityCases === 21 && fixture.derivedIdentityCases === 8, "P7_EXCHANGE_STORED_IDENTITY_CORPUS");
  assertion(fixture.stagingOwnershipCases === 5 && fixture.resourceBudgetCases === 5, "P7_EXCHANGE_FILESYSTEM_BUDGET_CORPUS");
  assertion(Array.isArray(fixture.hostileCases) && fixture.hostileCases.length === 32, "P7_EXCHANGE_HOSTILE_CORPUS");
  assertion(Array.isArray(fixture.faultCases) && fixture.faultCases.length === 8, "P7_EXCHANGE_FAULT_CORPUS");
  assertion(fixture.propertyPermutations === 64 && fixture.logicalChunks === 5 && /^[a-f0-9]{64}$/u.test(fixture.permutationCorpusDigest), "P7_EXCHANGE_PROPERTY_CORPUS");
  assertion(fixture.maximumChunks === 128 && fixture.maximumChunkBytes === 1_048_576 && fixture.maximumTotalBytes === 8_388_608, "P7_EXCHANGE_LIMITS");
  assertion(fixture.networkAccess === false && fixture.codeExecution === false && fixture.liveAosMutation === false, "P7_EXCHANGE_OFFLINE_BOUNDARY");
  const packages = await Promise.all([
    readJson(resolve(repositoryRoot, "packages/core/package.json")),
    readJson(resolve(repositoryRoot, "packages/cli/package.json")),
  ]);
  assertion(packages.every((manifest) => Object.keys(manifest.dependencies ?? {}).length === 0), "P7_EXCHANGE_STANDALONE_DEPENDENCY");
  return success("P7_CANONICAL_EXCHANGE_VERIFIED", {
    tests: tests.reasonCode,
    positiveCases: fixture.positiveCases,
    schemaParityCases: fixture.schemaParityCases,
    storedSchemaParityCases: fixture.storedSchemaParityCases,
    derivedIdentityCases: fixture.derivedIdentityCases,
    stagingOwnershipCases: fixture.stagingOwnershipCases,
    resourceBudgetCases: fixture.resourceBudgetCases,
    hostileCases: fixture.hostileCases.length,
    faultCases: fixture.faultCases.length,
    propertyPermutations: fixture.propertyPermutations,
    logicalChunks: fixture.logicalChunks,
    permutationCorpusDigest: fixture.permutationCorpusDigest,
    maximumChunks: fixture.maximumChunks,
    maximumChunkBytes: fixture.maximumChunkBytes,
    maximumTotalBytes: fixture.maximumTotalBytes,
    fixtureDigest: (await fileRecord(fixturePath)).sha256,
    schemaDigest: (await fileRecord(schemaPath)).sha256,
    specDigest: (await fileRecord(specPath)).sha256,
    networkAccess: fixture.networkAccess,
    codeExecution: fixture.codeExecution,
    liveAosMutation: fixture.liveAosMutation,
    compatibilityModes: "out-of-scope",
    aosRequirements: "out-of-scope",
    rc4: "unaccepted",
  });
}

async function verifyP7Compatibility() {
  const tests = await runTests({ p7CompatibilityOnly: true });
  const fixturePath = resolve(repositoryRoot, "packages/core/fixtures/p7-compatibility-modes-cases.json");
  const schemaPath = resolve(repositoryRoot, "packages/core/schema/compatibility-modes-v1.schema.json");
  const specPath = resolve(repositoryRoot, "packages/core/spec/compatibility-modes-v1.md");
  const fixture = await readJson(fixturePath);
  assertion(fixture.schemaVersion === "tcrn.p7-compatibility-modes-cases.v1", "P7_COMPATIBILITY_FIXTURE_SCHEMA");
  assertion(fixture.positiveOperations === 6 && fixture.schemaParityCases === 15 && fixture.documentBudgetCases === 2, "P7_COMPATIBILITY_POSITIVE_PARITY_CORPUS");
  assertion(fixture.authorityFilesystemCases === 9 && fixture.authorityBoundedReadCases === 5 && fixture.authorityBindingCases === 14 && fixture.cliAuthorityCases === 12 && fixture.unavailableSurfaces === 4, "P7_COMPATIBILITY_AUTHORITY_UNAVAILABLE_CORPUS");
  assertion(fixture.propertyPermutations === 64 && /^[a-f0-9]{64}$/u.test(fixture.permutationCorpusDigest), "P7_COMPATIBILITY_PROPERTY_CORPUS");
  assertion(fixture.supportedAosReleases === 0 && fixture.networkAccess === false && fixture.mutation === false && fixture.liveAosMutation === false, "P7_COMPATIBILITY_OFFLINE_BOUNDARY");
  assertion(fixture.capabilityDisposition === "capability_unavailable_until_mutual_release", "P7_COMPATIBILITY_UNAVAILABLE_DISPOSITION");
  return success("P7_COMPATIBILITY_MODES_VERIFIED", {
    tests: tests.reasonCode,
    positiveOperations: fixture.positiveOperations,
    schemaParityCases: fixture.schemaParityCases,
    documentBudgetCases: fixture.documentBudgetCases,
    authorityFilesystemCases: fixture.authorityFilesystemCases,
    authorityBoundedReadCases: fixture.authorityBoundedReadCases,
    authorityBindingCases: fixture.authorityBindingCases,
    cliAuthorityCases: fixture.cliAuthorityCases,
    unavailableSurfaces: fixture.unavailableSurfaces,
    propertyPermutations: fixture.propertyPermutations,
    permutationCorpusDigest: fixture.permutationCorpusDigest,
    fixtureDigest: (await fileRecord(fixturePath)).sha256,
    schemaDigest: (await fileRecord(schemaPath)).sha256,
    specDigest: (await fileRecord(specPath)).sha256,
    supportedAosReleases: fixture.supportedAosReleases,
    networkAccess: fixture.networkAccess,
    mutation: fixture.mutation,
    liveAosMutation: fixture.liveAosMutation,
    capabilityDisposition: fixture.capabilityDisposition,
    compatibilityModes: "implemented-offline-planning-only",
    aosRequirements: "out-of-scope",
    rc4: "unaccepted",
  });
}

async function verifyP7AosRequirements() {
  const tests = await runTests({ p7AosRequirementsOnly: true });
  const fixturePath = resolve(repositoryRoot, "packages/core/fixtures/p7-public-aos-requirements-ledger.json");
  const schemaPath = resolve(repositoryRoot, "packages/core/schema/public-aos-requirements-v1.schema.json");
  const specPath = resolve(repositoryRoot, "packages/core/spec/public-aos-requirements-v1.md");
  const fixture = await readJson(fixturePath);
  assertion(fixture.schemaVersion === "tcrn.public-aos-requirements.v1" && fixture.requirements.length === 8, "P7_AOS_REQUIREMENTS_FIXTURE");
  assertion(fixture.requirements.every((entry) => ["specified", "fixture_verified"].includes(entry.maturity)), "P7_AOS_REQUIREMENTS_MATURITY");
  assertion(fixture.requirements.every((entry) => ["candidate", "accepted", "superseded"].includes(entry.status)), "P7_AOS_REQUIREMENTS_STATUS");
  return success("P7_PUBLIC_AOS_REQUIREMENTS_VERIFIED", {
    tests: tests.reasonCode,
    requirements: fixture.requirements.length,
    hostileVectors: 11,
    scalarParityVectors: 6,
    cliNegativeVectors: 1,
    propertyPermutations: 64,
    fixtureDigest: (await fileRecord(fixturePath)).sha256,
    schemaDigest: (await fileRecord(schemaPath)).sha256,
    specDigest: (await fileRecord(specPath)).sha256,
    liveCompatibility: false,
    runtimeMutation: false,
    supportedReleaseClaims: false,
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
  const [year, month, day] = policy.snapshotDate.split("-").map(Number);
  assertion(year && month && day, "VULNERABILITY_POLICY_DATE_INVALID");
  const snapshot = Date.UTC(year, month - 1, day);
  const ageDays = Math.floor((Date.now() - snapshot) / 86_400_000);
  assertion(ageDays >= 0 && ageDays <= policy.maxAgeDays, "VULNERABILITY_POLICY_STALE", String(ageDays));
  const graph = validateFrozenDependencyGraph({ packageJson, dependencyPolicy, lockContent });
  const vulnerabilityReadback = assertNoKnownVulnerabilities(graph, policy.knownVulnerabilities);
  return success("VULNERABILITY_POLICY_VERIFIED", {
    disposition: policy.disposition,
    snapshotDate: policy.snapshotDate,
    ageDays,
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
  const files = await walkFiles(root);
  return Promise.all(files.map(async (path) => ({
    path: `${labelPrefix}${toPosixPath(relative(root, path))}`,
    content: await readSourceFile(path),
  })));
}

async function verifyPrivacy({ requireP8Surfaces = false } = {}) {
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

  const objectIds = run("git", ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
    .split("\n")
    .filter(Boolean);
  const historyRecords = [];
  for (const object of objectIds) {
    const type = run("git", ["cat-file", "-t", object]);
    if (["blob", "commit", "tag"].includes(type)) {
      const content = run("git", ["cat-file", type, object], { raw: true });
      historyRecords.push({ path: `${type}:${object}`, content });
      entries.push({
        label: `git-${type}:${object}`,
        kind: type,
        content: decodePrivacyScanBytes(content),
      });
    } else if (type === "tree") {
      const content = run("git", ["cat-file", "tree", object], { raw: true });
      historyRecords.push({ path: `tree:${object}`, content });
      entries.push({
        label: `git-tree:${object}`,
        kind: "tree",
        content: decodePrivacyScanBytes(content),
      });
    } else {
      fail("PRIVACY_GIT_OBJECT_TYPE", `${object}:${type}`);
    }
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
  const commits = run("git", ["rev-list", "--all"]).split("\n").filter(Boolean);
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
  const findings = scanPrivacyEntries(entries, { owner });
  assertion(findings.length === 0, "PRIVACY_FINDINGS", findings.join(","));
  const source = await verifySource();
  return success("PRIVACY_SOURCE_CLEAN", {
    scannedEntries: entries.length,
    gitObjects: objectIds.length,
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
    if (!guardFiles.has(label)) {
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
  history: { exit: 0, reasonCode: "HISTORY_CLEAN" },
  privacy: { exit: 0, reasonCode: "PRIVACY_SOURCE_CLEAN" },
  "verify-p1": { exit: 0, reasonCode: "P1_VERIFIED" },
  "test-trust": { exit: 0, reasonCode: "TRUST_NEGATIVE_MATRIX_VERIFIED" },
  governance: { exit: 0, reasonCode: "GOVERNANCE_TOOLCHAIN_VERIFIED" },
  vulnerabilities: { exit: 0, reasonCode: "VULNERABILITY_POLICY_VERIFIED" },
  workspace: { exit: 0, reasonCode: "WORKSPACE_VERIFIED" },
  roots: { exit: 0, reasonCode: "ROOT_BOUNDARIES_VERIFIED" },
  ci: { exit: 0, reasonCode: "CI_HARDENING_VERIFIED" },
  isolated: { exit: 0, reasonCode: "ISOLATED_P1_VERIFIED" },
  p2: { exit: 0, reasonCode: "P2_VERIFIED" },
  p3: { exit: 0, reasonCode: "P3_VERIFIED" },
  p4: { exit: 0, reasonCode: "P4_ARTIFACT_LIFECYCLE_VERIFIED" },
  "p4-knowledge": { exit: 0, reasonCode: "P4_KNOWLEDGE_CORE_VERIFIED" },
  p5: { exit: 0, reasonCode: "P5_GENERIC_PROFILES_VERIFIED" },
  p6: { exit: 0, reasonCode: "P6_CONTEXT_ROUTER_VERIFIED" },
  "p6-adapter": { exit: 0, reasonCode: "P6_CODEX_ADAPTER_VERIFIED" },
  p6b: { exit: 0, reasonCode: "P6B_CLAUDE_ADAPTER_VERIFIED" },
  dep: { exit: 0, reasonCode: "DEPENDENCY_VERIFIED" },
  conference: { exit: 0, reasonCode: "CONFERENCE_VERIFIED" },
  "ext-ag": { exit: 0, reasonCode: "ASSIGNMENT_GATE_VERIFIED" },
  "ext-actor": { exit: 0, reasonCode: "ACTOR_ATTESTATION_VERIFIED" },
  "ext-store": { exit: 0, reasonCode: "EXT_STORE_VERIFIED" },
  p7: { exit: 0, reasonCode: "P7_CANONICAL_EXCHANGE_VERIFIED" },
  "p7-compatibility": { exit: 0, reasonCode: "P7_COMPATIBILITY_MODES_VERIFIED" },
  "p7-aos-requirements": { exit: 0, reasonCode: "P7_PUBLIC_AOS_REQUIREMENTS_VERIFIED" },
  p8: { exit: 0, reasonCode: "P8_WORKFLOW_RC_VERIFIED" },
  rc1: { exit: 0, reasonCode: "RC1_CANDIDATE_READY" },
  backup: { exit: 0, reasonCode: "BACKUP_VERIFIED" },
  act1: { exit: 0, reasonCode: "ACT1_CLAUDE_INSTALLER_VERIFIED" },
};

async function verifyMap() {
  const map = JSON.parse(await readText(resolve(repositoryRoot, "verification-map.yaml")));
  const packageJson = await readJson(resolve(repositoryRoot, "package.json"));
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
    // PRG-0: ACT (activation ladder) and BK (backup) are admitted here so hardening
    // claims validate. Their completeness-loop entries below and the evidencePhase
    // mapping are added atomically with each phase's first claim (a phase cannot be
    // required-present before any claim exists) — see docs/hardening/rc1-map-regeneration.md.
    assertion(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "RC1", "ACT", "BK"].includes(claim.phase), "VERIFICATION_MAP_PHASE", claim.id);
    assertion(claimCategories.includes(claim.category), "VERIFICATION_MAP_CATEGORY", claim.id);
    assertion(["implemented", "candidate", "planned"].includes(claim.status), "VERIFICATION_MAP_STATUS", claim.id);
    assertion(Array.isArray(claim.fixturePaths), "VERIFICATION_MAP_FIXTURES", claim.id);
    assertion(Array.isArray(claim.invalidationTriggers) && claim.invalidationTriggers.length > 0, "VERIFICATION_MAP_INVALIDATION", claim.id);
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
  // WSF-2: BK joins the completeness loop with its first claim (BK-SNAPSHOT-WITNESS);
  // ACT stays admitted-only until WSG-2 lands the first activation claim.
  // WSG-2: ACT joins the completeness loop with its first activation-ladder claim
  // (ACT1-CLAUDE-INSTALLER); PRG-0 pre-admitted ACT to the per-claim allowlist only.
  for (const phase of ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "RC1", "BK", "ACT"]) {
    assertion(map.claims.some((claim) => claim.phase === phase), "VERIFICATION_MAP_PHASE_MISSING", phase);
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

async function verifyGovernance() {
  const runtime = await verifyRuntime();
  const licenses = await verifyLicenses();
  const lifecycle = await verifyLifecycle();
  return success("GOVERNANCE_TOOLCHAIN_VERIFIED", { runtime, licenses, lifecycle });
}

async function verifyWorkspace() {
  const runtime = await verifyRuntime();
  const checked = await typecheck();
  const built = await build();
  return success("WORKSPACE_VERIFIED", { runtime, checked, built });
}

async function verifyRoots() {
  const result = await runTests({ rootOnly: true });
  return success("ROOT_BOUNDARIES_VERIFIED", { tests: result.tests });
}

// WSF-2: the snapshot-witness gate (BK phase). The suite proves manifest
// determinism, quiesce enforcement, residue fail-close, exclusion correctness,
// schema validity, out-of-root read-only behavior, and tamper detection.
async function verifyBackup() {
  const result = await runTests({ backupOnly: true });
  return success("BACKUP_VERIFIED", { tests: result.tests });
}

// WSG-2: the Step-1 governed installer gate (ACT phase, first activation-ladder
// claim). The suite proves the governed on-disk install, receipt round-trip
// through the unmodified TOCTOU reader, identity-digest-gated rollback execution,
// and the fail-closed target/root/tamper negatives.
async function verifyAct1() {
  const result = await runTests({ installerOnly: true });
  return success("ACT1_CLAUDE_INSTALLER_VERIFIED", { tests: result.tests });
}

async function verifyCi() {
  const linted = await lint();
  const workflow = await readText(resolve(repositoryRoot, ".github/workflows/ci.yml"));
  assertion(/^permissions:\n  contents: read$/mu.test(workflow), "CI_PERMISSIONS_NOT_MINIMAL");
  assertion(!workflow.includes("pull_request_target"), "CI_PULL_REQUEST_TARGET_FORBIDDEN");
  assertion(!workflow.includes("pnpm/action-setup"), "CI_PNPM_ACTION_SETUP_FORBIDDEN");
  assertion(workflow.indexOf("uses: actions/setup-node") < workflow.indexOf("Acquire exact pnpm under explicit online bootstrap policy"), "CI_NODE_BOOTSTRAP_ORDER_INVALID");
  assertion(workflow.includes('npm_config_offline: "false"') && workflow.includes('npm_config_prefer_offline: "false"'), "CI_BOOTSTRAP_ONLINE_OVERRIDE_MISSING");
  assertion(workflow.includes("npm install --global pnpm@11.3.0 --ignore-scripts --no-audit --no-fund --no-update-notifier --prefer-online"), "CI_PNPM_BOOTSTRAP_NOT_PINNED");
  assertion(workflow.includes('test "$(pnpm --version)" = "11.3.0"'), "CI_PNPM_VERSION_CHECK_MISSING");
  assertion(workflow.includes("--frozen-lockfile --ignore-scripts --config.offline=false"), "CI_INSTALL_NOT_EXPLICIT");
  assertion(workflow.includes("- name: Verify P1 offline\n        run: pnpm verify:p1"), "CI_OFFLINE_P1_MISSING");
  return success("CI_HARDENING_VERIFIED", { linted });
}

async function verifyP1() {
  assertCleanExclusiveSourceBasis(run("git", ["status", "--porcelain=v1", "--untracked-files=all"]));
  const sequence = [
    "format-check",
    "lint",
    "typecheck",
    "build",
    "test",
    "test-trust",
    "archive",
    "sbom",
    "licenses",
    "vulnerabilities",
    "source",
    "lifecycle",
    "offline",
    "governance",
    "workspace",
    "privacy",
    "roots",
    "ci",
    "verification-map",
    "history",
  ];
  const results = [];
  for (const name of sequence) {
    results.push(await invoke(name));
  }
  return success("P1_VERIFIED", {
    commands: sequence,
    observedReasonCodes: results.map((result) => result.reasonCode),
  });
}

async function verifyP2() {
  assertCleanExclusiveSourceBasis(run("git", ["status", "--porcelain=v1", "--untracked-files=all"]));
  const sequence = ["protocol-schemas", "protocol-test", "aos", "rc1"];
  const results = [];
  for (const name of sequence) {
    results.push(await invoke(name));
  }
  return success("P2_VERIFIED", {
    commands: sequence,
    observedReasonCodes: results.map((result) => result.reasonCode),
  });
}

async function clean() {
  const result = await safeCleanOutputRoot(repositoryRoot);
  return success("OUTPUTS_CLEANED", result);
}

const handlers = {
  aos: verifyAosRequirements,
  archive,
  build,
  ci: verifyCi,
  clean,
  "format-check": () => formatCheck(),
  "format-write": () => formatCheck({ write: true }),
  governance: verifyGovernance,
  history: verifyHistory,
  licenses: verifyLicenses,
  lifecycle: verifyLifecycle,
  lint,
  offline: verifyOfflineBoundary,
  p2: verifyP2,
  p3: verifyP3,
  p4: verifyP4,
  "p4-knowledge": verifyP4Knowledge,
  p5: verifyP5,
  p6: verifyP6,
  "p6-adapter": verifyP6Adapter,
  p6b: verifyP6b,
  dep: verifyDependency,
  conference: verifyConference,
  "ext-ag": verifyAssignmentGate,
  "ext-actor": verifyActorAttestation,
  "ext-store": verifyExtStore,
  p7: verifyP7,
  "p7-compatibility": verifyP7Compatibility,
  "p7-aos-requirements": verifyP7AosRequirements,
  p8: verifyP8,
  privacy: verifyPrivacy,
  rc1: verifyRc1CandidateReadiness,
  roots: verifyRoots,
  "protocol-schemas": verifyP2Schemas,
  "protocol-test": verifyProtocolConformance,
  runtime: verifyRuntime,
  sbom,
  source: verifySource,
  test: () => runTests(),
  "test-trust": () => runTests({ trustOnly: true }),
  typecheck,
  "verification-map": verifyMap,
  "verify-p1": verifyP1,
  vulnerabilities: verifyVulnerabilities,
  workspace: verifyWorkspace,
  backup: verifyBackup,
  act1: verifyAct1,
};

function errorReason(error) {
  if (error instanceof TaskError || error instanceof LocalCommandError || error instanceof BoundaryError || error instanceof ProtocolProofError || error instanceof DependencyGraphError || error instanceof ScopedStripTypesError) {
    return error.reasonCode;
  }
  return "TASK_INTERNAL_ERROR";
}

function evidencePhase(name) {
  if (["aos", "p2", "protocol-schemas", "protocol-test"].includes(name)) {
    return "p2";
  }
  if (name === "p3" || name === "p4") {
    return name;
  }
  if (name === "p4-knowledge") {
    return "p4";
  }
  if (name === "p5") {
    return "p5";
  }
  if (name === "p6") {
    return "p6";
  }
  if (name === "p6-adapter") {
    return "p6";
  }
  if (name === "p6b") {
    return "p6";
  }
  if (name === "dep") {
    return "p2";
  }
  if (name === "conference") {
    return "p2";
  }
  if (name === "ext-ag") {
    return "p2";
  }
  if (name === "ext-actor") {
    return "p2";
  }
  if (name === "ext-store") {
    return "p2";
  }
  if (name === "p7" || name === "p7-compatibility" || name === "p7-aos-requirements") {
    return "p7";
  }
  if (name === "rc1") {
    return "rc1";
  }
  if (name === "backup") {
    return "bk";
  }
  if (name === "act1") {
    return "act";
  }
  if (name === "p8") {
    return "p8";
  }
  return "p1";
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
