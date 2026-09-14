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
import { assessEvidenceReuse, assessDynamicEvidenceReuse, buildDevelopmentPlan, buildDynamicGatePlan, buildFinalGatePlan, createGateReceiptAuthority, DEVELOPMENT_CHECK_COMMANDS, executeSelectedRoots, issueGateReceipt, queryGateReceipt, recordExecution } from "../scripts/final-gate-plan.mjs";
import { classifyProcess } from "../scripts/operational-batch-entry.mjs";
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

test("STORY-413: gate planning and evidence reuse use one positive and negative predicate", async () => {
  const roster = JSON.parse(readFileSync(resolve(PLATFORM_ROOT, "platform-docs/acceptance-gate-groups.json"), "utf8"));
  const containment = JSON.parse(readFileSync(resolve(PLATFORM_ROOT, "TCRN Platform/tcrn-workflow/scripts/policy/gate-containment.json"), "utf8"));
  const inputs = { sourceDigest: "source-a", environmentDigest: "environment-a", commandDigest: "command-a", baselineDigest: "baseline-a" };
  const successful = { id: "evidence-1", ok: true, status: "completed", inputs };
  const reusable = assessEvidenceReuse({ evidence: successful, inputs });
  assert.equal(reusable.reusable, true);
  assert.deepEqual(reusable.invalidated, []);
  for (const field of Object.keys(inputs)) {
    const changed = { ...inputs, [field]: `${field}-b` };
    const rejected = assessEvidenceReuse({ evidence: successful, inputs: changed });
    assert.equal(rejected.reusable, false, JSON.stringify(changed));
    assert.equal(rejected.reused.length, 0);
    assert.ok(rejected.invalidated[0].reasons.length > 0);
  }
  const missingDigest = assessEvidenceReuse({ evidence: successful, inputs: { ...inputs, baselineDigest: undefined } });
  assert.equal(missingDigest.reusable, false);
  assert.ok(missingDigest.invalidated[0].reasons.length > 0);
  assert.equal(assessEvidenceReuse({ evidence: { ...successful, ok: false }, inputs }).reusable, false);
  assert.equal(assessEvidenceReuse({ evidence: { ...successful, status: "running" }, inputs }).reusable, false);

  const planOptions = { roster, containment, phase: "candidate-final", inputs, executionPermission: true, candidateReady: true, blockedDependencies: [] };
  const buildPlan = (overrides = {}) => buildFinalGatePlan({ ...planOptions, ...overrides });
  const assertNoRootExecution = async (candidate) => {
    let calls = 0;
    const result = await executeSelectedRoots(candidate, async () => { calls += 1; return { ok: true }; });
    assert.equal(calls, 0);
    assert.deepEqual(result.executed, []);
    return result;
  };

  const plan = buildPlan({ previousEvidence: [successful] });
  assert.deepEqual(plan.selected.map(({ id }) => id), ["engine-release", "platform-layout", "product-gates"]);
  assert.deepEqual(plan.executionOrder, plan.selected.map(({ id }) => id));
  assert.equal(plan.execution.strategy, "serial");
  assert.deepEqual(plan.reused, [{ id: "evidence-1", reason: "same source, environment, command, and baseline inputs" }]);
  assert.ok(plan.coveredBy.every(({ coveredBy }) => coveredBy !== null));
  const executed = recordExecution(plan, plan.selected.map(({ id }) => ({ id, ok: true })));
  assert.deepEqual(executed.executed.map(({ id }) => id), plan.executionOrder);
  const order = [];
  const measured = await executeSelectedRoots(plan, async (entry) => {
    order.push(entry.id);
    return { ok: true, reasonCode: "FIXTURE_ROOT_GREEN" };
  });
  assert.deepEqual(order, plan.executionOrder);
  assert.deepEqual(measured.executed.map(({ id, reasonCode }) => ({ id, reasonCode })), plan.executionOrder.map((id) => ({ id, reasonCode: "FIXTURE_ROOT_GREEN" })));
  assert.ok(measured.executed.every(({ elapsedMs }) => Number.isSafeInteger(elapsedMs) && elapsedMs >= 0));
  const failedRoot = await executeSelectedRoots(plan, async (entry) => ({ ok: entry.id !== "platform-layout", reasonCode: entry.id === "platform-layout" ? "FIXTURE_ROOT_RED" : "FIXTURE_ROOT_GREEN" }));
  assert.ok(failedRoot.blocked.some(({ id, reason }) => id === "platform-layout" && reason === "FIXTURE_ROOT_RED"));
  assert.equal(failedRoot.executed.find(({ id }) => id === "platform-layout").ok, false);
  const blockedPlan = buildPlan({ blockedDependencies: ["DS candidate pending"] });
  const blockedResult = await assertNoRootExecution(blockedPlan);
  assert.ok(blockedResult.blocked.some(({ reason }) => reason === "DS candidate pending"));
  const missingInputPlan = buildPlan({ inputs: {} });
  await assertNoRootExecution(missingInputPlan);
  const unknownReadinessPlan = buildPlan({ candidateReady: undefined });
  assert.equal(unknownReadinessPlan.executable, false);
  await assertNoRootExecution(unknownReadinessPlan);
  const missingRequiredSuite = { ...containment, groups: containment.groups.filter((group) => group.id !== "engine-suite").map((group) => group.id === "engine-p1" ? { ...group, contains: [] } : group) };
  assert.throws(() => buildPlan({ containment: missingRequiredSuite }), (error) => error.reasonCode === "GATE_PLAN_REQUIRED_GROUP_MISSING");
  assert.throws(() => recordExecution(plan, [{ id: "engine-release", ok: true }]), (error) => error.reasonCode === "GATE_PLAN_EXECUTION_MISMATCH");
  assert.throws(() => recordExecution(plan, [...plan.selected.map(({ id }) => ({ id, ok: true })), { id: "engine-p1", ok: true }]), (error) => error.reasonCode === "GATE_PLAN_EXECUTION_MISMATCH");

  const known = buildDevelopmentPlan({ changedFiles: ["scripts/task.mjs"], inputs, previousEvidence: [successful] });
  assert.deepEqual(known.selected.map(({ id }) => id), ["typecheck", "test"]);
  assert.deepEqual(known.selected.map(({ id, command }) => ({ id, command })), [{ id: "typecheck", command: "pnpm typecheck" }, { id: "test", command: "pnpm test" }]);
  assert.deepEqual(known.blocked, []);
  const docs = buildDevelopmentPlan({ changedFiles: ["docs/dispatch.md"] });
  assert.deepEqual(docs.selected.map(({ id, command }) => ({ id, command })), [{ id: "format-check", command: "pnpm format:check" }, { id: "links", command: "pnpm verify:links" }]);
  const packageScripts = JSON.parse(readFileSync(resolve(PLATFORM_ROOT, "TCRN Platform/tcrn-workflow/package.json"), "utf8")).scripts;
  for (const command of Object.values(DEVELOPMENT_CHECK_COMMANDS)) {
    const tokens = command.split(/\s+/u);
    if (tokens[0] === "pnpm") assert.equal(Object.hasOwn(packageScripts, tokens.at(-1)), true, command);
  }
  const unknown = buildDevelopmentPlan({ changedFiles: ["generated/unknown.bin"] });
  assert.ok(unknown.blocked.some(({ id }) => id === "generated/unknown.bin"));
  assert.deepEqual(unknown.selected.map(({ id }) => id), ["typecheck", "test"]);
});

test("STORY-420: dynamic impact selects affected roots, reuses only bound terminal evidence, and fails closed on unknown impact", async () => {
  const roster = JSON.parse(readFileSync(resolve(PLATFORM_ROOT, "platform-docs/acceptance-gate-groups.json"), "utf8"));
  const containment = JSON.parse(readFileSync(resolve(PLATFORM_ROOT, "TCRN Platform/tcrn-workflow/scripts/policy/gate-containment.json"), "utf8"));
  const inputs = { sourceDigest: "source-420", environmentDigest: "environment-420", commandDigest: "command-420", baselineDigest: "baseline-420" };
  const options = { roster, containment, inputs, candidateReady: true, executionPermission: true };

  const engine = buildDynamicGatePlan({ ...options, changedFiles: ["scripts/final-gate-plan.mjs"] });
  assert.deepEqual(engine.selected.map(({ id }) => id), ["engine-release"]);
  assert.deepEqual(engine.gates.map(({ id, disposition }) => ({ id, disposition })), [
    { id: "engine-release", disposition: "run" },
    { id: "platform-layout", disposition: "not-applicable" },
    { id: "product-gates", disposition: "not-applicable" },
  ]);
  assert.equal(engine.coveredBy.some(({ id }) => id === "engine-p1"), true);
  assert.equal(engine.selected.some(({ id }) => id === "engine-p1"), false);

  const evidence = ["engine-release", "platform-layout", "product-gates"].map((gateId, index) => ({
    id: `evidence-420-${index}`,
    gateId,
    phase: "candidate-final",
    status: "completed",
    ok: true,
    inputs,
  }));
  const unchanged = buildDynamicGatePlan({ ...options, changedFiles: [], previousEvidence: evidence });
  assert.deepEqual(unchanged.selected, []);
  assert.deepEqual(unchanged.reused.map(({ id }) => id), ["engine-release", "platform-layout", "product-gates"]);
  assert.deepEqual(unchanged.notVerifiable, []);

  const unrelated = buildDynamicGatePlan({ ...options, changedFiles: [], crossRepoChanges: [{ repository: "TCRN-Design-System", related: false }], previousEvidence: evidence });
  assert.deepEqual(unrelated.selected, []);
  assert.equal(unrelated.blocked.length, 0);
  assert.ok(unrelated.notApplicable.some(({ id }) => id === "product-gates"));

  const related = buildDynamicGatePlan({ ...options, changedFiles: [], crossRepoChanges: [{ repository: "TCRN-Design-System", related: true }], previousEvidence: evidence });
  assert.deepEqual(related.selected.map(({ id }) => id), ["product-gates"]);
  assert.ok(related.invalidated.some(({ id, evidenceId }) => id === "product-gates" && evidenceId === "evidence-420-2"));

  const unknown = buildDynamicGatePlan({ ...options, changedFiles: [], environmentChanges: ["unregistered-runtime"] });
  assert.ok(unknown.blocked.some(({ id }) => id === "unknown-impact"));
  assert.deepEqual(unknown.selected.map(({ id }) => id), ["engine-release", "platform-layout", "product-gates"]);

  const missing = assessDynamicEvidenceReuse({ evidence: { id: "evidence-missing", gateId: "engine-release", phase: "candidate-final", status: "completed", ok: true, inputs: { ...inputs, baselineDigest: undefined } }, inputs, phase: "candidate-final", gateId: "engine-release" });
  assert.equal(missing.reusable, false);
  assert.ok(missing.reasons.some((reason) => reason.includes("digest")));

  let calls = 0;
  const drifted = await executeSelectedRoots(engine, async () => { calls += 1; return { ok: true }; }, { currentInputs: { ...inputs, sourceDigest: "source-drifted" } });
  assert.equal(calls, 0);
  assert.equal(drifted.executable, false);
  assert.ok(drifted.blocked.some(({ id }) => id === "input-drift"));

  for (const phase of ["candidate-final", "publication", "merge-sensitive"]) {
    const phasePlan = buildDynamicGatePlan({ ...options, phase, changedFiles: ["scripts/final-gate-plan.mjs"] });
    assert.deepEqual(phasePlan.selected.map(({ id }) => id), ["engine-release"]);
  }
});

test("EPIC135 closeout: only an issued receipt with the exact invocation can be reused", async () => {
  const roster = JSON.parse(readFileSync(resolve(PLATFORM_ROOT, "platform-docs/acceptance-gate-groups.json"), "utf8"));
  const containment = JSON.parse(readFileSync(resolve(PLATFORM_ROOT, "TCRN Platform/tcrn-workflow/scripts/policy/gate-containment.json"), "utf8"));
  const entry = roster.groups.find(({ id }) => id === "engine-release");
  const repositoryRoot = resolve(PLATFORM_ROOT, "TCRN Platform/tcrn-workflow");
  const inputs = { sourceDigest: "source-closeout", environmentDigest: "environment-closeout", commandDigest: "command-closeout", baselineDigest: "baseline-closeout" };
  const invocation = { executable: "node", argv: ["scripts/push-gate.mjs"], cwd: repositoryRoot, command: entry.command };
  const authority = createGateReceiptAuthority();
  const receipt = issueGateReceipt(authority, { entry, invocation, inputs, result: { ok: true, status: 0, signal: null, stdout: "", stderr: "" } });
  assert.equal(queryGateReceipt(authority, receipt.terminalEvidence, { gateId: entry.id, expectedInputs: inputs, expectedCommand: entry.command, expectedInvocation: invocation }).gateId, entry.id);
  assert.equal(assessDynamicEvidenceReuse({ evidence: receipt, inputs, gateId: entry.id, phase: "candidate-final", requireTrustedEvidence: true, receiptAuthority: authority, invocation }).reusable, true);

  const forged = structuredClone(receipt);
  forged.terminalEvidence = { ...forged.terminalEvidence, source: "tcrn-code-owned-runner", storeRoot: authority.storeRoot };
  assert.equal(assessDynamicEvidenceReuse({ evidence: forged, inputs, gateId: entry.id, phase: "candidate-final", requireTrustedEvidence: true, receiptAuthority: createGateReceiptAuthority(), invocation }).reusable, false);
  const failedAuthority = createGateReceiptAuthority();
  const failed = issueGateReceipt(failedAuthority, { entry, invocation, inputs, result: { ok: false, status: 1, signal: null, stdout: "", stderr: "failed" } });
  assert.equal(assessDynamicEvidenceReuse({ evidence: failed, inputs, gateId: entry.id, phase: "candidate-final", requireTrustedEvidence: true, receiptAuthority: failedAuthority, invocation }).reusable, false);

  const plan = buildDynamicGatePlan({ roster, containment, inputs, changedFiles: ["scripts/final-gate-plan.mjs"], dependencies: [], configuration: [], generated: [], environment: [], crossRepoChanges: [], candidateReady: true, executionPermission: true, operational: true, requireCompleteImpact: true, gateInvocations: { [entry.id]: invocation }, receiptAuthority: authority });
  const resealed = structuredClone(plan);
  resealed.selected = [];
  resealed.coveredBy = [];
  resealed.executionOrder = [];
  resealed.gates = resealed.gates.map((gate) => gate.disposition === "run" ? { ...gate, disposition: "not-applicable", status: "not-applicable" } : gate);
  resealed.integrity.requiredSelected = [];
  resealed.integrity.coveredChildren = [];
  let calls = 0;
  const refused = await executeSelectedRoots(resealed, async () => { calls += 1; return { ok: true }; }, { getInputs: async () => inputs });
  assert.equal(calls, 0);
  assert.equal(refused.executable, false);
  assert.equal(refused.reasonCode, "GATE_PLAN_EXECUTION_INTEGRITY_REFUSED");
});

test("EPIC135 R1: private plan registration rejects public discriminator and reseal downgrades before any runner call", async () => {
  const roster = JSON.parse(readFileSync(resolve(PLATFORM_ROOT, "platform-docs/acceptance-gate-groups.json"), "utf8"));
  const containment = JSON.parse(readFileSync(resolve(PLATFORM_ROOT, "TCRN Platform/tcrn-workflow/scripts/policy/gate-containment.json"), "utf8"));
  const inputs = { sourceDigest: "source-r1", environmentDigest: "environment-r1", commandDigest: "command-r1", baselineDigest: "baseline-r1" };
  const options = { roster, containment, phase: "candidate-final", inputs, changedFiles: ["scripts/final-gate-plan.mjs"], dependencies: [], configuration: [], generated: [], environment: [], crossRepoChanges: [], candidateReady: true, executionPermission: true };
  const assertRefused = async (plan) => {
    let calls = 0;
    const result = await executeSelectedRoots(plan, async () => { calls += 1; return { ok: true }; }, { getInputs: async () => inputs });
    assert.equal(calls, 0);
    assert.equal(result.reasonCode, "GATE_PLAN_EXECUTION_INTEGRITY_REFUSED");
    assert.equal(result.executable, false);
  };
  const downgraded = buildDynamicGatePlan(options);
  downgraded.dynamic = false;
  delete downgraded.integrity;
  await assertRefused(downgraded);

  const commandChanged = buildDynamicGatePlan(options);
  commandChanged.selected[0].command = "node unregistered-command.mjs";
  await assertRefused(commandChanged);

  const resealed = structuredClone(buildDynamicGatePlan(options));
  resealed.selected = [];
  resealed.executionOrder = [];
  resealed.gates = resealed.gates.map((gate) => ({ ...gate, disposition: "not-applicable", status: "not-applicable" }));
  resealed.integrity.requiredSelected = [];
  resealed.integrity.requiredSelectionDigest = "0".repeat(64);
  let directCalls = 0;
  assert.throws(() => recordExecution(resealed, []), (error) => error.reasonCode === "GATE_PLAN_EXECUTION_INTEGRITY_REFUSED");
  assert.equal(directCalls, 0);
});

test("EPIC135 closeout: runtime scope keeps unknown writes visible without blocking on unknown system processes", () => {
  const relativeWrite = classifyProcess({ pid: 101, state: "S", command: "node scripts/tcrn-workflow.mjs work-create --workspace /tmp/workspace" }, { selfPid: 1 });
  assert.equal(relativeWrite.scope, "unknown");
  assert.equal(relativeWrite.likelyGovernedWrite, true);
  assert.equal(relativeWrite.scopeBasis, "relative-command-without-cwd");
  const systemProcess = classifyProcess({ pid: 102, state: "S", command: "/usr/libexec/system-service --wait" }, { selfPid: 1 });
  assert.equal(systemProcess.scope, "unknown");
  assert.equal(systemProcess.role, "unknown-live-process");
  assert.equal(systemProcess.likelyGovernedWrite, false);
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
  for (const [name, event, expected] of [
    ["completed", { type: "completed", ok: true, code: 0, signal: null }, "completed"],
    ["failed", { type: "error", reasonCode: "FIXTURE_FAILED" }, "failed"],
    ["orphaned", { type: "orphaned-before-bind", processGroup: 123 }, "orphaned"],
  ]) {
    const historyPath = join(root, `${name}-history.ndjson`);
    await appendProgressEvent(historyPath, event);
    const history = await readProgressDelta(historyPath);
    const knownTerminal = await waitForProgress(historyPath, { cursor: history.nextCursor, events: history.events, timeoutMs: 0, pollMs: 5 });
    assert.equal(knownTerminal.status, expected, name);
    assert.equal(knownTerminal.summary.status, expected, name);
    assert.equal(knownTerminal.polls, 0, name);
  }

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
