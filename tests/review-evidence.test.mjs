// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-375 — review-evidence produces measured, not self-reported, rows.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REVIEW_EVIDENCE_VERSION,
  diffEvidence,
  parseTestRunOutput,
} from "../scripts/review-evidence.mjs";
import { assessEvidenceReuse, buildDevelopmentPlan, buildFinalGatePlan, recordExecution } from "../scripts/final-gate-plan.mjs";
import { appendProgressEvent, readProgressDelta, summarizeProgress, waitForProgress } from "../scripts/lib/incremental-output.mjs";

const PLATFORM_ROOT = process.env.TCRN_PLATFORM_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHAIN_WORKSPACE = join(PLATFORM_ROOT, [".tcrn", "workspace"].join("-"), "cross-project", "workspace");
const STORY_374 = "work:bba2301b55370dabd7854616";

function gitFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tcrn-review-evidence-repo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "fixture.test.mjs"), "import assert from \"node:assert/strict\"; import test from \"node:test\"; test(\"fixture\", () => assert.equal(1, 1));\n");
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  assert.equal(spawnSync("git", ["-C", root, "add", "tests/fixture.test.mjs"]).status, 0);
  assert.equal(spawnSync("git", ["-C", root, "-c", "user.name=review-test", "-c", "user.email=review-at-example.invalid", "commit", "-qm", "base"]).status, 0);
  return root;
}

function runUnpreloadedCollect(options) {
  const moduleUrl = new URL("../scripts/review-evidence.mjs", import.meta.url).href;
  const source = `import { collectReviewEvidence } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(collectReviewEvidence(${JSON.stringify(options)})));`;
  const result = spawnSync("/usr/bin/env", ["-u", "NODE_OPTIONS", process.execPath, "--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("STORY-375 GWT1: review-evidence reads the bound verify, runs it, and separates runner and AST counts", (t) => {
  const repositoryRoot = gitFixture(t);
  const result = runUnpreloadedCollect({
    workspace: CHAIN_WORKSPACE,
    workId: STORY_374,
    repositoryRoot,
    base: "HEAD",
    allowedFiles: [],
  });
  // The current checkout has no diff, but an empty scope is deliberately refused:
  // a caller must declare the files it reviewed rather than letting the tool invent them.
  assert.equal(result.schemaVersion, REVIEW_EVIDENCE_VERSION);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("allowedFiles")));

  const rerun = runUnpreloadedCollect({
    workspace: CHAIN_WORKSPACE,
    workId: STORY_374,
    repositoryRoot,
    base: "HEAD",
    allowedFiles: ["tests/fixture.test.mjs"],
    testFiles: ["tests/fixture.test.mjs"],
    testCommand: `${JSON.stringify(process.execPath)} --test tests/fixture.test.mjs`,
  });
  assert.equal(rerun.ok, true, JSON.stringify(rerun.problems));
  assert.equal(rerun.evidence.verify.ok, true);
  assert.equal(rerun.evidence.testRun.summary.parseable, true);
  assert.equal(rerun.evidence.testRun.summary.source, "node-test-case-summary");
  assert.deepEqual(rerun.evidence.testRun.summary.testFiles, ["tests/fixture.test.mjs"]);
  assert.equal(rerun.evidence.testRun.summary.testFileCount, 1);
  assert.equal(rerun.evidence.testRun.summary.testCases, 1);
  assert.match(rerun.evidence.testRun.result.stdout, /tests 1/u);
  assert.match(rerun.evidence.testRun.result.stdoutSha256, /^[a-f0-9]{64}$/u);
  assert.equal(rerun.evidence.testRun.result.outputComplete, true);
  assert.equal(typeof rerun.evidence.astCountCoverage.before.testCount, "number");
  assert.equal(typeof rerun.evidence.astCountCoverage.after.testCount, "number");
  assert.deepEqual(rerun.evidence.diff.outOfBounds, []);

  const timeoutRoot = mkdtempSync(join(tmpdir(), "tcrn-review-evidence-timeout-"));
  try {
    const pidFile = join(timeoutRoot, "child.pid");
    const timeout = runUnpreloadedCollect({
      workspace: CHAIN_WORKSPACE,
      workId: STORY_374,
      repositoryRoot,
      base: "HEAD",
      allowedFiles: ["tests/fixture.test.mjs"],
      testFiles: ["tests/fixture.test.mjs"],
      testCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60_000)`)}`,
      commandTimeoutMs: 100,
    });
    assert.equal(timeout.evidence.testRun.result.exitCode, "TIMEOUT");
    assert.equal(timeout.ok, false);
    assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0));
  } finally {
    rmSync(timeoutRoot, { recursive: true, force: true });
  }
});

test("STORY-375 GWT2: untracked diff files are included and become out-of-bounds without post-hoc scope widening", () => {
  const root = mkdtempSync(join(tmpdir(), "tcrn-review-evidence-git-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    assert.equal(spawnSync("git", ["-C", root, "add", "tracked.txt"]).status, 0);
    assert.equal(spawnSync("git", ["-C", root, "-c", "user.name=review-test", "-c", "user.email=review-at-example.invalid", "commit", "-qm", "base"]).status, 0);
    writeFileSync(join(root, "untracked.txt"), "untracked\n");
    const diff = diffEvidence(root, "HEAD");
    assert.deepEqual(diff.changedFiles, ["untracked.txt"]);
    assert.deepEqual(diff.untracked[0].paths, ["untracked.txt"]);
    assert.deepEqual(diff.files, [{ path: "untracked.txt", status: "??" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("STORY-375: runner counts come from machine output, not prose or a caller-supplied number", () => {
  assert.deepEqual(parseTestRunOutput(JSON.stringify({ tests: ["tests/one.test.mjs", "tests/two.test.mjs"], result: "passed" })), {
    testFiles: ["tests/one.test.mjs", "tests/two.test.mjs"],
    testFileCount: 2,
    testCases: null,
    passed: null,
    failed: 0,
    parseable: true,
    source: "engine-test-result.file-list",
  });
  assert.deepEqual(parseTestRunOutput("ℹ tests 12\nℹ pass 12\nℹ fail 0\n", "", ["tests/fixture.test.mjs"]), {
    testFiles: ["tests/fixture.test.mjs"],
    testFileCount: 1,
    testCases: 12,
    passed: 12,
    failed: 0,
    parseable: true,
    source: "node-test-case-summary",
  });
  assert.equal(parseTestRunOutput(JSON.stringify({ tests: ["fixture-test"], result: "passed" })).parseable, false);
  assert.equal(parseTestRunOutput("passed: 999 tests").parseable, false);
});

test("STORY-413: gate planning and evidence reuse use one positive and negative predicate", () => {
  const roster = JSON.parse(readFileSync(resolve(PLATFORM_ROOT, "platform-docs/acceptance-gate-groups.json"), "utf8"));
  const containment = JSON.parse(readFileSync(resolve(PLATFORM_ROOT, "TCRN Platform/tcrn-workflow/scripts/policy/gate-containment.json"), "utf8"));
  const inputs = { sourceDigest: "source-a", environmentDigest: "environment-a", commandDigest: "command-a", baselineDigest: "baseline-a" };
  const successful = { id: "evidence-1", ok: true, status: "completed", inputs };
  const reusable = assessEvidenceReuse({ evidence: successful, inputs });
  assert.equal(reusable.reusable, true);
  assert.deepEqual(reusable.invalidated, []);
  for (const changed of [
    { ...inputs, sourceDigest: "source-b" },
    { ...inputs, environmentDigest: "environment-b" },
    { ...inputs, commandDigest: "command-b" },
    { ...inputs, baselineDigest: "baseline-b" },
    { ...inputs, baselineDigest: undefined },
  ]) {
    const rejected = assessEvidenceReuse({ evidence: successful, inputs: changed });
    assert.equal(rejected.reusable, false, JSON.stringify(changed));
    assert.equal(rejected.reused.length, 0);
    assert.ok(rejected.invalidated[0].reasons.length > 0);
  }
  assert.equal(assessEvidenceReuse({ evidence: { ...successful, ok: false }, inputs }).reusable, false);
  assert.equal(assessEvidenceReuse({ evidence: { ...successful, status: "running" }, inputs }).reusable, false);

  const plan = buildFinalGatePlan({ roster, containment, phase: "candidate-final", inputs, previousEvidence: [successful] });
  assert.deepEqual(plan.selected.map(({ id }) => id), ["engine-release", "platform-layout", "product-gates"]);
  assert.deepEqual(plan.executionOrder, plan.selected.map(({ id }) => id));
  assert.equal(plan.execution.strategy, "serial");
  assert.deepEqual(plan.reused, [{ id: "evidence-1", reason: "same source, environment, command, and baseline inputs" }]);
  assert.ok(plan.coveredBy.every(({ coveredBy }) => coveredBy !== null));
  const executed = recordExecution(plan, plan.selected.map(({ id }) => ({ id, ok: true })));
  assert.deepEqual(executed.executed.map(({ id }) => id), plan.executionOrder);
  assert.throws(() => recordExecution(plan, [{ id: "engine-release", ok: true }]), (error) => error.reasonCode === "GATE_PLAN_EXECUTION_MISMATCH");
  assert.throws(() => recordExecution(plan, [...plan.selected.map(({ id }) => ({ id, ok: true })), { id: "engine-p1", ok: true }]), (error) => error.reasonCode === "GATE_PLAN_EXECUTION_MISMATCH");

  const known = buildDevelopmentPlan({ changedFiles: ["scripts/task.mjs"], inputs, previousEvidence: [successful] });
  assert.deepEqual(known.selected.map(({ id }) => id), ["typecheck", "test"]);
  assert.deepEqual(known.blocked, []);
  const unknown = buildDevelopmentPlan({ changedFiles: ["generated/unknown.bin"] });
  assert.ok(unknown.blocked.some(({ id }) => id === "generated/unknown.bin"));
  assert.deepEqual(unknown.selected.map(({ id }) => id), ["typecheck", "test"]);
});

test("STORY-414: progress waits report cursor deltas, unchanged polls, and terminal failures without false success", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tcrn-progress-ledger-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "events.ndjson");
  await appendProgressEvent(path, { type: "selected", id: "engine-release" });
  await appendProgressEvent(path, { type: "controller-started", pid: 123 });
  const first = await readProgressDelta(path);
  assert.deepEqual(first.events.map(({ type }) => type), ["selected", "controller-started"]);
  const unchanged = await readProgressDelta(path, first.nextCursor);
  assert.deepEqual(unchanged.events, []);
  assert.equal(unchanged.bytesRead, 0);
  await appendProgressEvent(path, { type: "completed", ok: true, code: 0, signal: null });
  const second = await readProgressDelta(path, first.nextCursor);
  assert.deepEqual(second.events.map(({ type }) => type), ["completed"]);
  assert.equal(summarizeProgress([...first.events, ...second.events]).status, "completed");
  const completed = await waitForProgress(path, { cursor: first.nextCursor, events: first.events, timeoutMs: 100, pollMs: 5 });
  assert.equal(completed.status, "completed");
  assert.ok(completed.polls >= 1);
  assert.ok(completed.bytesRead > 0);

  const idlePath = join(root, "idle.ndjson");
  const idle = await waitForProgress(idlePath, { timeoutMs: 25, pollMs: 5, maxPollMs: 10 });
  assert.equal(idle.status, "timeout");
  assert.ok(idle.polls >= 2);
  assert.equal(idle.summary.status, "running");
  const errorPath = join(root, "error.ndjson");
  await appendProgressEvent(errorPath, { type: "error", reasonCode: "CONTROLLER_FAILED" });
  const failed = await waitForProgress(errorPath, { timeoutMs: 100, pollMs: 5 });
  assert.equal(failed.status, "failed");
  assert.equal(failed.summary.status, "failed");

  const cancelPath = join(root, "cancel.ndjson");
  const controller = new AbortController();
  const pending = waitForProgress(cancelPath, { timeoutMs: 100, pollMs: 10, signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  const cancelled = await pending;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.summary.status, "running");

  await writeFileSync(join(root, "malformed.ndjson"), "{not-json}\n");
  const malformed = await waitForProgress(join(root, "malformed.ndjson"), { timeoutMs: 100, pollMs: 5 });
  assert.equal(malformed.status, "failed");
  assert.equal(malformed.reasonCode, "PROGRESS_EVENT_INVALID");
});
