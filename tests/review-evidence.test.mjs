// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-375 — review-evidence produces measured, not self-reported, rows.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REVIEW_EVIDENCE_VERSION,
  collectReviewEvidence,
  diffEvidence,
  parseTestRunOutput,
} from "../scripts/review-evidence.mjs";

const REPOSITORY_ROOT = process.cwd();
const CHAIN_WORKSPACE = join("/workspace/user", [".tcrn", "workspace"].join("-"), "cross-project", "workspace");
const STORY_374 = "work:bba2301b55370dabd7854616";

test("STORY-375 GWT1: review-evidence reads the bound verify, runs it, and separates runner and AST counts", () => {
  const result = collectReviewEvidence({
    workspace: CHAIN_WORKSPACE,
    workId: STORY_374,
    repositoryRoot: REPOSITORY_ROOT,
    base: "HEAD",
    allowedFiles: [],
  });
  // The current checkout has no diff, but an empty scope is deliberately refused:
  // a caller must declare the files it reviewed rather than letting the tool invent them.
  assert.equal(result.schemaVersion, REVIEW_EVIDENCE_VERSION);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("allowedFiles")));

  const rerun = collectReviewEvidence({
    workspace: CHAIN_WORKSPACE,
    workId: STORY_374,
    repositoryRoot: REPOSITORY_ROOT,
    base: "HEAD",
    allowedFiles: [
      "fixtures/rc1/rc1-candidate-proof-manifest.json",
      "scripts/policy/coverage-baseline.json",
      "scripts/policy/source-allowlist.json",
      "scripts/review-evidence.mjs",
      "tests/review-evidence.test.mjs",
      "verification-map.yaml",
    ],
    testCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write(JSON.stringify({tests:['fixture-test'],result:'passed'}))")}`,
  });
  assert.equal(rerun.ok, true, JSON.stringify(rerun.problems));
  assert.equal(rerun.evidence.verify.ok, true);
  assert.equal(rerun.evidence.testRun.summary.parseable, true);
  assert.equal(rerun.evidence.testRun.summary.source, "engine-test-result.tests-array");
  assert.equal(rerun.evidence.testRun.summary.tests, 1);
  assert.equal(typeof rerun.evidence.astCountCoverage.before.testCount, "number");
  assert.equal(typeof rerun.evidence.astCountCoverage.after.testCount, "number");
  assert.deepEqual(rerun.evidence.diff.outOfBounds, []);
});

test("STORY-375 GWT2: untracked diff files are included and become out-of-bounds without post-hoc scope widening", () => {
  const root = mkdtempSync(join(tmpdir(), "tcrn-review-evidence-git-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    assert.equal(spawnSync("git", ["-C", root, "add", "tracked.txt"]).status, 0);
    assert.equal(spawnSync("git", ["-C", root, "-c", "user.name=review-test", "-c", "user.email=fixture-at-example.invalid", "commit", "-qm", "base"]).status, 0);
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
  assert.deepEqual(parseTestRunOutput(JSON.stringify({ tests: ["one", "two"], result: "passed" })), {
    tests: 2,
    testFiles: 2,
    testCases: null,
    passed: 2,
    failed: 0,
    parseable: true,
    source: "engine-test-result.tests-array",
  });
  assert.deepEqual(parseTestRunOutput("ℹ tests 12\nℹ pass 12\nℹ fail 0\n"), {
    tests: null,
    testFiles: null,
    testCases: 12,
    passed: 12,
    failed: 0,
    parseable: false,
    source: "node-test-case-summary",
  });
  assert.equal(parseTestRunOutput("passed: 999 tests").parseable, false);
});
