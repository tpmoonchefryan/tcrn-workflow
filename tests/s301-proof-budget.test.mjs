// SPDX-License-Identifier: Apache-2.0
//
// STORY-301. CONTRIBUTING.md has carried a proof budget since adoption, and until
// now it judged nothing: the verb that measured the ratio returned success
// unconditionally, so the rule bound only whoever remembered it. Gates were added
// anyway and the ratio walked from 1.62 to 1.59 without any of the three outcomes
// the rule names -- retire equivalent mass, record an exception, or don't add the
// gate -- ever being taken.
//
// This file is what stops that being true again, so its own criteria have to be
// able to fail. Each test below names the change that reddens it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { P1_SEQUENCE } from "../scripts/p1-sequence.mjs";
import {
  classifyProofResponsibility,
  evaluateProofBudget,
  isNonBlockingProofBudgetWarning,
  proofBudgetScopeBindingDigest,
  proofResponsibilityViewProblems,
  validateProofBudgetScopeBinding,
  PROOF_BUDGET_SCOPED_NONBLOCKING_REASON,
  PROOF_RESPONSIBILITIES,
} from "../scripts/lib/proof-budget.mjs";
import { budgetWarningNotices, hasWarningOrError, inspectStructuredChildOutput, onlyBudgetWarning, validateStructuredChildExpectations } from "../scripts/lib/push-gate-output.mjs";
import { P8_RELEASE_ARTIFACTS, P8_TAG } from "../scripts/lib/p8-workflow-rc.mjs";
import { executeOperationalBatch, executeQualifiedBatch, normalizeNativeImplementationResult } from "../scripts/final-gate-plan.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = resolve(repositoryRoot, "scripts/policy/proof-budget.json");

async function readPolicy() {
  return JSON.parse(await readFile(policyPath, "utf8"));
}

// Red leg: drop the budget entry from P1_SEQUENCE. A ratchet outside the train is a
// number nobody reads, which is the state this Story found it in.
test("STORY-301: the proof budget runs inside the gate train", () => {
  const entry = P1_SEQUENCE.find((candidate) => candidate.task === "budget");
  assert.ok(entry, "budget must be a member of P1, not a verb someone remembers to run");
  assert.equal(entry.script, "verify:budget");
});

// Red leg: return success unconditionally again, as the verb did before this Story,
// and the ratio below stops being compared to anything.
test("STORY-301: the budget verb refuses a ratio above the recorded line", async () => {
  const policy = await readPolicy();
  assert.equal(typeof policy.frozenRatio, "number");
  assert.ok(Array.isArray(policy.exceptions));

  // The policy arithmetic is the part under test, because it is the part that decides.
  const effective = policy.exceptions.reduce((highest, entry) => Math.max(highest, entry.ratio), policy.frozenRatio);
  assert.ok(effective >= policy.frozenRatio, "the effective line never falls below the frozen one");

  // A ratio one step above the line must be refused; one step below must not be. Both
  // directions are asserted because a comparison that only ever sees one side of itself
  // is the tautological-gate shape this platform has paid for repeatedly.
  const refuses = (ratio) => ratio > effective;
  assert.equal(refuses(effective + 0.0001), true, "a ratio above the line must be refused");
  assert.equal(refuses(effective), false, "a ratio exactly at the line must pass");
  assert.equal(refuses(effective - 0.0001), false, "a ratio below the line must pass");
});

// Red leg: add an exception with no rationale, or with no ratio, and the verb's own
// validation rejects the policy file. An exception that does not say what it bought
// is indistinguishable from someone editing the limit.
test("STORY-301: every recorded exception says what it authorises and why", async () => {
  const policy = await readPolicy();
  for (const entry of policy.exceptions) {
    assert.equal(typeof entry.id, "string", "an exception is identified");
    assert.ok(entry.id.length > 0);
    assert.equal(typeof entry.recordedAt, "string");
    assert.equal(typeof entry.ratio, "number", "an exception names the ratio it authorises");
    assert.equal(typeof entry.rationale, "string");
    assert.ok(entry.rationale.length > 40, `${entry.id}: a rationale short enough to be a label is not a rationale`);
  }
});

// The file on disk must stay parseable and unchanged by reading it -- a policy the
// checker rewrites is a policy that can drift under its own reader.
test("STORY-301: reading the budget policy does not change it", async () => {
  const before = await readFile(policyPath, "utf8");
  await readPolicy();
  const after = await readFile(policyPath, "utf8");
  assert.equal(after, before);
  await writeFile(policyPath, before);
});

test("EPIC135: the approved budget thresholds classify every real boundary", async () => {
  const policy = await readPolicy();
  assert.equal(policy.warningRatio, 2.4);
  assert.equal(policy.hardRatio, 2.5328);
  assert.equal(policy.exceptions.at(-1)?.id, "TCRN-CROSS-INC-385-MIN222-D1-collector-open-start-and-sealed-day-measured-ratio-20260924");
  const cases = [
    [2.3728, true, "verified"],
    [2.4, true, "verified"],
    [2.4001, true, "warning"],
    [2.5, true, "warning"],
    [2.5328, true, "warning"],
    [2.5329, false, "rejected"],
  ];
  for (const [ratio, ok, status] of cases) {
    const proofLines = Math.round(ratio * 10_000);
    const result = evaluateProofBudget({ proofLines, productLines: 10_000, policy });
    assert.equal(result.ratio, ratio);
    assert.equal(result.ok, ok, `${ratio}: ok`);
    assert.equal(result.status, status, `${ratio}: status`);
    if (status === "warning") {
      assert.equal(result.reasonCode, "PROOF_BUDGET_WARNING");
      assert.equal(result.warning.blocking, false);
      assert.equal(isNonBlockingProofBudgetWarning(result), true);
    } else if (status === "rejected") {
      assert.equal(result.reasonCode, "PROOF_BUDGET_EXCEEDED");
      assert.equal(result.warning, null);
    } else {
      assert.equal(result.reasonCode, "PROOF_BUDGET_VERIFIED");
      assert.equal(result.warning, null);
    }
  }

  const legacyPolicy = structuredClone(policy);
  legacyPolicy.ratioPolicy.schemaVersion = "tcrn.proof-budget-ratio-policy.v1";
  legacyPolicy.ratioPolicy.scope = "repository-wide persistent global max";
  delete legacyPolicy.ratioPolicy.scopedDisposition;
  legacyPolicy.hardRatio = 2.5;
  legacyPolicy.exceptions = legacyPolicy.exceptions.filter((entry) => entry.ratio <= legacyPolicy.hardRatio);
  const legacyExceeded = evaluateProofBudget({ proofLines: 25_001, productLines: 10_000, policy: legacyPolicy });
  assert.equal(legacyExceeded.reasonCode, "PROOF_BUDGET_EXCEEDED");
  assert.equal(legacyExceeded.ok, false);
});

test("EPIC135: only the complete structured budget notice is non-blocking", async () => {
  const policy = await readPolicy();
  const warning = evaluateProofBudget({ proofLines: 24_001, productLines: 10_000, policy }).warning;
  assert.equal(isNonBlockingProofBudgetWarning(warning), true);
  assert.equal(isNonBlockingProofBudgetWarning({ ...warning, blocking: true }), false);
  assert.equal(isNonBlockingProofBudgetWarning({ ...warning, reasonCode: "OTHER_WARNING" }), false);
});

test("TCRN-CROSS-STORY-435/436: finite ratio authorization includes current work and excludes 431/future", async () => {
  const policy = await readPolicy();
  const binding = policy.ratioPolicy.scopedDisposition.binding;
  const bindingSha256 = proofBudgetScopeBindingDigest(policy);
  assert.equal(binding.scopeId, "INIT-051/INC320/CHAIN-NATIVE-20260916");
  assert.deepEqual(binding.allowedWork.slice(-2).map((work) => work.externalKey), [
    "TCRN-CROSS-STORY-435",
    "TCRN-CROSS-STORY-436",
  ]);
  assert.equal(binding.allowedWork.some((work) => work.externalKey === "TCRN-CROSS-STORY-431"), false);
  assert.equal(validateProofBudgetScopeBinding(binding, policy).ok, true);

  const scoped = evaluateProofBudget({
    proofLines: 70_230,
    productLines: 27_706,
    policy,
    scopeBindingSha256: bindingSha256,
  });
  assert.equal(scoped.status, "exceeded-nonblocking");
  assert.equal(scoped.ok, true);
  assert.equal(scoped.warning.scopeBindingSha256, bindingSha256);
  assert.equal(isNonBlockingProofBudgetWarning(scoped, { policy, scopeBindingSha256: bindingSha256 }), true);
  assert.equal(isNonBlockingProofBudgetWarning(scoped, { policy }), false);
  assert.equal(evaluateProofBudget({ proofLines: 70_230, productLines: 27_706, policy, scopeBindingSha256: "0".repeat(64) }).ok, false);

  const future = structuredClone(binding);
  future.allowedWork = [...future.allowedWork, { externalKey: "TCRN-CROSS-STORY-437", id: "work:437" }];
  assert.equal(validateProofBudgetScopeBinding(future, policy).ok, false);
});

test("EPIC135: push-gate budget exemption requires one terminal receipt and no other diagnostics", () => {
  const fixturePolicy = {
    frozenRatio: 1.5888,
    warningRatio: 2.4,
    hardRatio: 2.5,
    exceptions: [{ id: "fixture", recordedAt: "2026-09-14", ratio: 2.5, rationale: "A bounded fixture threshold for parser coverage." }],
  };
  const budgetOptions = { policy: fixturePolicy };
  const boundary = evaluateProofBudget({ proofLines: 24_001, productLines: 10_000, policy: fixturePolicy });
  const budget = { command: "budget", ...boundary };
  const reasonCodes = Object.fromEntries([
    ["format-check", "FORMAT_VERIFIED"], ["lint", "LINT_VERIFIED"], ["typecheck", "TYPECHECK_VERIFIED"],
    ["build", "BUILD_VERIFIED"], ["test", "TESTS_VERIFIED"], ["portal", "PORTAL_VERIFY_TRAIN_GREEN"],
    ["source", "SOURCE_ALLOWLIST_VERIFIED"], ["archive", "ARCHIVE_VERIFIED"],
    ["no-sibling-dependency", "NO_SIBLING_DEPENDENCY"], ["offline", "OFFLINE_BOUNDARY_VERIFIED"],
    ["governance", "GOVERNANCE_TOOLCHAIN_VERIFIED"], ["privacy", "PRIVACY_SOURCE_CLEAN"],
    ["verification-map", "VERIFICATION_MAP_VERIFIED"], ["budget", "PROOF_BUDGET_WARNING"],
    ["links", "MARKDOWN_LINKS_RESOLVED"], ["retrieval-eval", "RETRIEVAL_EVAL_VERIFIED"],
  ]);
  const receipt = (notices, overrides = {}) => JSON.stringify({
    ok: true,
    command: "verify-p1",
    reasonCode: "P1_VERIFIED",
    commands: P1_SEQUENCE.map(({ task }) => task),
    observedReasonCodes: P1_SEQUENCE.map(({ task }) => reasonCodes[task]),
    notices,
    ...overrides,
  });
  const budgetOnly = receipt([budget]);
  assert.equal(budgetWarningNotices(budgetOnly, "verify:p1", budgetOptions).length, 1);
  assert.equal(onlyBudgetWarning(budgetOnly, "verify:p1", budgetOptions), true);
  assert.equal(hasWarningOrError(budgetOnly, "verify:p1", budgetOptions), false);

  const sameReceipt = receipt([budget, { command: "typecheck", severity: "warning", reasonCode: "OTHER_WARNING", blocking: true }]);
  assert.equal(onlyBudgetWarning(sameReceipt, "verify:p1", budgetOptions), false);
  assert.equal(hasWarningOrError(sameReceipt, "verify:p1", budgetOptions), true);

  const independentLine = `OTHER_WARNING: compiler notice\n${budgetOnly}`;
  assert.equal(onlyBudgetWarning(independentLine, "verify:p1"), false);
  assert.equal(hasWarningOrError(independentLine, "verify:p1"), true);

  const otherFirst = `${receipt([{ command: "typecheck", severity: "warning", reasonCode: "OTHER_WARNING" }])}\n${budgetOnly}`;
  const otherLast = `${budgetOnly}\n${receipt([{ command: "typecheck", severity: "warning", reasonCode: "OTHER_WARNING" }])}`;
  for (const output of [otherFirst, otherLast]) {
    assert.deepEqual(budgetWarningNotices(output, "verify:p1", budgetOptions), []);
    assert.equal(onlyBudgetWarning(output, "verify:p1", budgetOptions), false);
    assert.equal(hasWarningOrError(output, "verify:p1"), true);
  }
});

test("TCRN-CROSS-STORY-430: scoped exceeded notice is shared by P1/push and never hides a real error", async () => {
  const policy = await readPolicy();
  const bindingSha256 = proofBudgetScopeBindingDigest(policy);
  const result = evaluateProofBudget({ proofLines: 70_230, productLines: 27_706, policy, scopeBindingSha256: bindingSha256 });
  const budgetNotice = { command: "budget", ...result.warning };
  const reasonCodeByTask = {
    "format-check": "FORMAT_VERIFIED", lint: "LINT_VERIFIED", typecheck: "TYPECHECK_VERIFIED", build: "BUILD_VERIFIED",
    test: "TESTS_VERIFIED", portal: "PORTAL_VERIFY_TRAIN_GREEN", source: "SOURCE_ALLOWLIST_VERIFIED", archive: "ARCHIVE_VERIFIED",
    "no-sibling-dependency": "NO_SIBLING_DEPENDENCY", offline: "OFFLINE_BOUNDARY_VERIFIED", governance: "GOVERNANCE_TOOLCHAIN_VERIFIED",
    privacy: "PRIVACY_SOURCE_CLEAN", "verification-map": "VERIFICATION_MAP_VERIFIED", links: "MARKDOWN_LINKS_RESOLVED",
    "retrieval-eval": "RETRIEVAL_EVAL_VERIFIED",
  };
  const receipt = (notices) => JSON.stringify({
    ok: true,
    command: "verify-p1",
    reasonCode: "P1_VERIFIED",
    commands: P1_SEQUENCE.map(({ task }) => task),
    observedReasonCodes: P1_SEQUENCE.map(({ task }) => task === "budget" ? result.reasonCode : reasonCodeByTask[task]),
    notices,
  });
  const exact = receipt([budgetNotice]);
  const options = { scopeBindingSha256: bindingSha256 };
  assert.equal(budgetWarningNotices(exact, "verify:p1", options).length, 1);
  assert.equal(onlyBudgetWarning(exact, "verify:p1", options), true);
  assert.equal(hasWarningOrError(exact, "verify:p1", options), false);

  const forged = { ...budgetNotice, scopeBindingSha256: "0".repeat(64) };
  assert.deepEqual(budgetWarningNotices(receipt([forged]), "verify:p1", options), []);
  assert.equal(onlyBudgetWarning(receipt([forged]), "verify:p1", options), false);
  assert.equal(hasWarningOrError(receipt([forged]), "verify:p1", options), true);

  const mixed = receipt([budgetNotice, { command: "typecheck", severity: "error", reasonCode: "COMPILER_ERROR", blocking: true }]);
  assert.equal(onlyBudgetWarning(mixed, "verify:p1", options), false);
  assert.equal(hasWarningOrError(mixed, "verify:p1", options), true);
});

function p8Receipt(sourceFiles) {
  const sourceDigest = "b".repeat(64);
  return {
    command: "p8",
    ok: true,
    reasonCode: "P8_WORKFLOW_RC_VERIFIED",
    tag: P8_TAG,
    p8BasisCommit: "a".repeat(40),
    tests: "P8_WORKFLOW_RC_TESTS_VERIFIED",
    trust: "TRUST_NEGATIVE_MATRIX_VERIFIED",
    sourceArchive: { reasonCode: "ARCHIVE_VERIFIED", path: "dist/source/tcrn-workflow-source.tar", sha256: sourceDigest, files: sourceFiles.length },
    sbom: { reasonCode: "SBOM_VERIFIED", path: "dist/sbom/sbom.cdx.json", components: 1, directComponents: 1, transitiveComponents: 0, dependencyGraphClosure: "complete", basis: "c".repeat(64) },
    artifacts: P8_RELEASE_ARTIFACTS.map((path) => ({ path: `dist/release/${path}`, size: 1, sha256: "d".repeat(64) })).sort((left, right) => left.path.localeCompare(right.path)),
    staleReleaseArtifacts: [],
    supportedAosReleases: [],
    network: false,
    mutation: false,
    publication: false,
    releaseStatus: "accepted_release",
    privacy: "PRIVACY_SOURCE_CLEAN",
    reproducibility: { sha256: sourceDigest, sourceFiles: sourceFiles.length, orderedEntries: sourceFiles, rootsIndependent: true },
    privacySurfaces: {
      aggregateAlgorithm: "sha256(path-NUL-byteLength-NUL-bytes over canonical path order)",
      trackedSource: { entries: 1, bytes: 1, sha256: "e".repeat(64) },
      fullHistory: { entries: 1, bytes: 1, sha256: "f".repeat(64) },
      buildOutput: { entries: 1, bytes: 1, sha256: "1".repeat(64) },
      sourceArchive: { entries: 1, bytes: 1, sha256: "2".repeat(64) },
      releaseArtifacts: { entries: 1, bytes: 1, sha256: "3".repeat(64) },
    },
  };
}

test("INC-320/433: P8 and guard schema expectations must be complete before those children can start", () => {
  const valid = validateStructuredChildExpectations({ sourceFiles: ["scripts/task.mjs"], guardIds: ["BR-01"], p8BasisCommit: "a".repeat(40) });
  assert.equal(valid.ok, true, JSON.stringify(valid));
  for (const inputs of [
    { sourceFiles: [], guardIds: ["BR-01"] },
    { sourceFiles: ["scripts/task.mjs", "scripts/task.mjs"], guardIds: ["BR-01"] },
    { sourceFiles: ["scripts/task.mjs"], guardIds: ["BR-01", "BR-01"] },
    { sourceFiles: ["scripts/task.mjs"], guardIds: [null] },
  ]) {
    const result = validateStructuredChildExpectations(inputs);
    assert.equal(result.ok, false, JSON.stringify(inputs));
    assert.equal(result.reasonCode, "CHILD_EXPECTATIONS_INVALID");
  }
});

test("EPIC135: exact P8 archive member paths are typed data, not diagnostics", () => {
  const sourceFiles = [
    "docs/activation/enforce-failure-policy-agenda-v1.md",
    "scripts/policy/failure-pattern-register.json",
    "src/ordinary-module.mjs",
  ].sort();
  const result = inspectStructuredChildOutput({
    stdout: `${JSON.stringify(p8Receipt(sourceFiles))}\n`,
    stderr: "",
    exitCode: 0,
    signal: null,
  }, "verify:p8", { sourceFiles });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.reasonCode, "CHILD_TERMINAL_RECEIPT_VALID");
  assert.equal(hasWarningOrError({ stdout: JSON.stringify(p8Receipt(sourceFiles)), stderr: "", exitCode: 0 }, "verify:p8", { sourceFiles }), false);
});

// TCRN-CROSS-STORY-461 R1 (SUB-240): verify:p8 reports the stale source archives it moved.
// The push gate reads that list as typed data, and only in the shape the move produces.
test("STORY-461 SUB-240: stale release moves are typed P8 receipt data", () => {
  const sourceFiles = ["scripts/task.mjs", "src/ordinary-module.mjs"].sort();
  const moved = {
    from: "dist/release/tcrn-workflow-1.1.2-source.tar",
    to: "dist/stale-release/1.1.2/tcrn-workflow-1.1.2-source.tar",
    version: "1.1.2",
    size: 10,
    sha256: "4".repeat(64),
  };
  const inspect = (staleReleaseArtifacts) => inspectStructuredChildOutput({
    stdout: `${JSON.stringify({ ...p8Receipt(sourceFiles), staleReleaseArtifacts })}\n`,
    stderr: "",
    exitCode: 0,
    signal: null,
  }, "verify:p8", { sourceFiles });
  const valid = inspect([moved]);
  assert.equal(valid.ok, true, JSON.stringify(valid));
  for (const [label, rows, code] of [
    ["destination outside the stale directory", [{ ...moved, to: "dist/evidence/tcrn-workflow-1.1.2-source.tar" }], "P8_STALE_RELEASE_RECORD_INVALID"],
    ["a current artifact reported as stale", [{ ...moved, from: "dist/release/sbom.cdx.json" }], "P8_STALE_RELEASE_RECORD_INVALID"],
    ["an extra field", [{ ...moved, note: "moved" }], "CHILD_TERMINAL_FIELDS_INVALID"],
    ["not a list", {}, "P8_STALE_RELEASE_SET_INVALID"],
  ]) {
    const result = inspect(rows);
    assert.equal(result.ok, false, label);
    assert.ok(result.findings.some((finding) => finding.code === code), `${label}: ${JSON.stringify(result.findings)}`);
  }
});

test("EPIC135: exact guard ids are typed data only after count and registry identity match", () => {
  const guardIds = ["guard-ordinary", "INC-027-event-page-ceiling-refused"];
  const result = inspectStructuredChildOutput({
    stdout: `${JSON.stringify({ ok: true, reasonCode: "GUARD_CHECK_VERIFIED", guards: guardIds.length, killed: guardIds })}\n`,
    stderr: "",
    exitCode: 0,
    signal: null,
  }, "guard-check", { guardIds });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.reasonCode, "CHILD_TERMINAL_RECEIPT_VALID");
  assert.equal(hasWarningOrError({ stdout: JSON.stringify({ ok: true, reasonCode: "GUARD_CHECK_VERIFIED", guards: guardIds.length, killed: guardIds }), stderr: "", exitCode: 0 }, "guard-check", { guardIds }), false);
});

test("EPIC135: P8 and guard diagnostics remain red outside validated typed data", () => {
  const sourceFiles = ["docs/activation/enforce-failure-policy-agenda-v1.md", "scripts/policy/failure-pattern-register.json", "src/ordinary-module.mjs"].sort();
  const p8 = p8Receipt(sourceFiles);
  const p8Line = JSON.stringify(p8);
  const guardIds = ["guard-ordinary", "INC-027-event-page-ceiling-refused"];
  const guardLine = JSON.stringify({ ok: true, reasonCode: "GUARD_CHECK_VERIFIED", guards: guardIds.length, killed: guardIds });
  const cases = [
    ["free text before P8 terminal", { stdout: `warning emitted\n${p8Line}\n`, stderr: "", exitCode: 0, signal: null }, "verify:p8", { sourceFiles }, "CHILD_TERMINAL_DUPLICATE_OR_EXTRA_OUTPUT"],
    ["free text after guard terminal", { stdout: `${guardLine}\ncompiler warning\n`, stderr: "", exitCode: 0, signal: null }, "guard-check", { guardIds }, "CHILD_TERMINAL_DUPLICATE_OR_EXTRA_OUTPUT"],
    ["stderr remains rejecting", { stdout: `${p8Line}\n`, stderr: "warning: hidden channel", exitCode: 0, signal: null }, "verify:p8", { sourceFiles }, "CHILD_STDERR_NOT_EMPTY"],
    ["nonzero child exit remains rejecting", { stdout: `${guardLine}\n`, stderr: "", exitCode: 1, signal: null }, "guard-check", { guardIds }, "CHILD_EXIT_NOT_SUCCESS"],
    ["inner failed receipt remains rejecting when the shell exits zero", { stdout: `${JSON.stringify({ ok: false, reasonCode: "GUARD_CHECK_BLOCKED", guards: 0, killed: [] })}\n`, stderr: "", exitCode: 0, signal: null }, "guard-check", { guardIds }, "CHILD_TERMINAL_REASON_INVALID"],
    ["duplicate terminals remain rejecting", { stdout: `${guardLine}\n${guardLine}\n`, stderr: "", exitCode: 0, signal: null }, "guard-check", { guardIds }, "CHILD_TERMINAL_DUPLICATE_OR_EXTRA_OUTPUT"],
    ["malformed JSON remains rejecting", { stdout: "{not-json}\n", stderr: "", exitCode: 0, signal: null }, "verify:p8", { sourceFiles }, "CHILD_TERMINAL_JSON_INVALID"],
    ["invalid UTF-8 bytes remain rejecting", { stdout: Buffer.from([0xc3, 0x28]), stderr: Buffer.alloc(0), exitCode: 0, signal: null }, "verify:p8", { sourceFiles }, "CHILD_OUTPUT_UTF8_INVALID"],
    ["fake success receipt remains rejecting", { stdout: '{"reasonCode":"P8_WORKFLOW_RC_VERIFIED"}\n', stderr: "", exitCode: 0, signal: null }, "verify:p8", { sourceFiles }, "CHILD_TERMINAL_FIELDS_INVALID"],
    ["P8 terminal for another source commit remains rejecting", { stdout: `${p8Line}\n`, stderr: "", exitCode: 0, signal: null }, "verify:p8", { sourceFiles, p8BasisCommit: "f".repeat(40) }, "P8_BASIS_COMMIT_MISMATCH"],
    ["unknown P8 fields remain rejecting", { stdout: `${JSON.stringify({ ...p8, unknown: "warning" })}\n`, stderr: "", exitCode: 0, signal: null }, "verify:p8", { sourceFiles }, "CHILD_TERMINAL_FIELDS_INVALID"],
    ["P8 terminal command must be the real task entry", { stdout: `${JSON.stringify({ ...p8, command: "verify:p8" })}\n`, stderr: "", exitCode: 0, signal: null }, "verify:p8", { sourceFiles }, "P8_COMMAND_INVALID"],
    ["P8 terminal ok must be true", { stdout: `${JSON.stringify({ ...p8, ok: false })}\n`, stderr: "", exitCode: 0, signal: null }, "verify:p8", { sourceFiles }, "P8_OK_INVALID"],
    ["nested diagnostics remain rejecting", { stdout: `${JSON.stringify({ ...p8, sbom: { ...p8.sbom, path: "warning-and-failure.json" } })}\n`, stderr: "", exitCode: 0, signal: null }, "verify:p8", { sourceFiles }, "CHILD_DIAGNOSTIC_TEXT"],
    ["unknown archive member is not typed data", { stdout: `${JSON.stringify(p8Receipt([...sourceFiles, "docs/new-warning.txt"].sort()))}\n`, stderr: "", exitCode: 0, signal: null }, "verify:p8", { sourceFiles }, "P8_SOURCE_ARCHIVE_COUNT_MISMATCH"],
    ["wrong successful child schema remains rejecting", { stdout: `${p8Line}\n`, stderr: "", exitCode: 0, signal: null }, "guard-check", { guardIds }, "CHILD_TERMINAL_REASON_INVALID"],
    ["unknown child command remains rejecting", { stdout: `${guardLine}\n`, stderr: "", exitCode: 0, signal: null }, "verify:other", { guardIds }, "CHILD_SCRIPT_UNEXPECTED"],
    ["wrong guard identity remains rejecting", { stdout: `${JSON.stringify({ ok: true, reasonCode: "GUARD_CHECK_VERIFIED", guards: guardIds.length, killed: [...guardIds].reverse() })}\n`, stderr: "", exitCode: 0, signal: null }, "guard-check", { guardIds }, "GUARD_SUCCESS_IDENTITY_INVALID"],
  ];
  for (const [label, streams, script, expected, code] of cases) {
    const result = inspectStructuredChildOutput(streams, script, expected);
    assert.equal(result.ok, false, label);
    assert.ok(result.findings.some((finding) => finding.code === code), `${label}: ${JSON.stringify(result.findings)}`);
    assert.equal(hasWarningOrError(streams, script, expected), true, `${label}: generic gate predicate must keep rejecting`);
  }
});

test("EPIC135: formal batch aggregation preserves authorized budget notices but blocks other warnings", async () => {
  const input = {
    series: "EPIC135",
    pack: "CHAIN-NATIVE",
    stage: "candidate-final",
    tasks: [],
    candidate: { id: "candidate-421", status: "stable", digest: "tree-421" },
    queueDigest: "queue-421",
    trigger: "formal-batch-gate",
  };
  const policy = await readPolicy();
  const budgetWarning = { command: "budget", ...evaluateProofBudget({ proofLines: 24_001, productLines: 10_000, policy }).warning };
  const passed = await executeQualifiedBatch(input, async () => ({ ok: true, governanceNotices: [budgetWarning] }));
  assert.equal(passed.status, "completed");
  const blocked = await executeQualifiedBatch(input, async () => ({ ok: true, governanceNotices: [{ reasonCode: "OTHER_WARNING", blocking: false }] }));
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.reasonCode, "BATCH_FORMAL_GATE_FAILED");

  const binding = policy.ratioPolicy.scopedDisposition.binding;
  const bindingSha256 = proofBudgetScopeBindingDigest(policy);
  const scoped = evaluateProofBudget({ proofLines: 70_230, productLines: 27_706, policy, scopeBindingSha256: bindingSha256 });
  const boundInput = {
    ...input,
    series: "INIT-051",
    workIds: binding.allowedWork.map((work) => work.id),
    primaryWorkId: binding.allowedWork.at(-1).id,
    proofBudgetScopeBinding: binding,
  };
  const scopedPass = await executeQualifiedBatch(boundInput, async () => ({ ok: true, governanceNotices: [{ command: "budget", ...scoped.warning }] }));
  assert.equal(scopedPass.status, "completed", JSON.stringify(scopedPass.reasons));

  const noBindingInput = { ...boundInput };
  delete noBindingInput.proofBudgetScopeBinding;
  const missingBinding = await executeQualifiedBatch(noBindingInput, async () => ({ ok: true, governanceNotices: [{ command: "budget", ...scoped.warning }] }));
  assert.equal(missingBinding.status, "failed");

  const wrongWorkInput = { ...boundInput, workIds: [...boundInput.workIds.slice(0, -1), "work:wrong"] };
  const wrongWork = await executeQualifiedBatch(wrongWorkInput, async () => ({ ok: true, governanceNotices: [{ command: "budget", ...scoped.warning }] }));
  assert.equal(wrongWork.status, "failed");
});

test("TCRN-CROSS-STORY-435/436: operational qualification uses native work state and finite authorization", async () => {
  const policy = await readPolicy();
  const binding = policy.ratioPolicy.scopedDisposition.binding;
  const bindingSha256 = proofBudgetScopeBindingDigest(policy);
  const workIds = binding.allowedWork.map((work) => work.id);
  const records = binding.allowedWork.map((work, index) => ({
    ...work,
    revision: 1,
    scopeDigest: `scope-${index}`,
    status: "blocked",
    dependencies: [],
    blockedReason: "bounded fixture stage input",
  }));
  const readNative = async () => ({
    ok: true,
    nativeStatus: { workspaceId: binding.workspaceId, version: 1, headEventHash: "a".repeat(64) },
    workListComplete: true,
    workListPages: [{ offset: 0, total: records.length, truncated: false, version: 1, headEventHash: "a".repeat(64) }],
    workListRecords: records,
    workShows: records,
    tasks: records,
    queue: { observed: true, digest: "queue-scope", tasks: records, records },
    queueDigest: "queue-scope",
    dependencies: { observed: true, schemaPresent: true, records: records.map(({ id, dependencies }) => ({ id, dependencies })) },
    dependencySchemaPresent: true,
  });
  const observeRuntime = async ({ nativeState }) => ({
    observedAt: "2026-09-16T12:45:00Z",
    source: "code-owned-test-observer",
    queue: { observed: true, digest: nativeState.queueDigest, records: nativeState.tasks },
    dependencies: { observed: true, digest: "dependencies-scope", records: nativeState.dependencies.records },
    agents: { observed: true, digest: "agents-scope", records: [] },
    writes: { observed: true, digest: "writes-scope", records: [] },
    candidate: { observed: true, stable: true, id: "candidate-scope", digest: "tree-scope", records: [] },
  });
  const input = {
    series: "INIT-051",
    pack: "CHAIN-NATIVE",
    stage: "candidate-final",
    trigger: "formal-batch-gate",
    workspace: binding.workspaceId,
    workIds,
    primaryWorkId: binding.allowedWork.at(-1).id,
    proofBudgetScopeBinding: binding,
    candidate: { id: "candidate-scope", status: "stable", digest: "tree-scope" },
    queueDigest: "queue-scope",
  };
  const warning = evaluateProofBudget({ proofLines: 70_230, productLines: 27_706, policy, scopeBindingSha256: bindingSha256 }).warning;
  let runnerCalls = 0;
  const result = await executeOperationalBatch(input, async () => {
    runnerCalls += 1;
    return { ok: true, governanceNotices: [{ command: "budget", ...warning }] };
  }, { readNative, observeRuntime });
  assert.equal(result.status, "completed", JSON.stringify(result.reasons));
  assert.equal(runnerCalls, 1);

  const forgedWork = await executeOperationalBatch({ ...input, workIds: [...workIds, "work:future"] }, async () => {
    runnerCalls += 1;
    return { ok: true, governanceNotices: [{ command: "budget", ...warning }] };
  }, { readNative, observeRuntime });
  assert.equal(forgedWork.status, "not-verifiable");
  assert.equal(runnerCalls, 1);
});

test("TCRN-CROSS-STORY-435/436: native implementation results require real bindings and evidence", () => {
  const scope = "## Goal\nA stable native scope.";
  const scopeDigest = createHash("sha256").update(scope).digest("hex");
  const valid = {
    schemaVersion: "tcrn.native-implementation-result.v1",
    status: "passed",
    ok: true,
    exitCode: 0,
    command: "node --test tests/s301-proof-budget.test.mjs",
    dependencies: [],
    evidence: `${repositoryRoot}/tests/s301-proof-budget.test.mjs`,
    revision: 7,
    scopeDigest,
    workId: "work:08e1f20a81121b28fa5a4d32",
    candidateId: "candidate-tree",
    candidateDigest: "a".repeat(64),
  };
  const bound = { workId: valid.workId, revision: valid.revision, scope, externalKey: "TCRN-CROSS-STORY-301" };
  assert.equal(normalizeNativeImplementationResult(valid, bound).valid, true);
  for (const [field, value] of [
    ["workId", undefined], ["revision", undefined], ["scopeDigest", "b".repeat(64)],
    ["candidateDigest", undefined], ["evidence", "/tmp/native-result-does-not-exist.json"],
    ["dependencies", undefined], ["unknown", "forged"],
  ]) {
    const candidate = { ...valid };
    if (value === undefined) delete candidate[field];
    else candidate[field] = value;
    assert.equal(normalizeNativeImplementationResult(candidate, bound).valid, false, field);
  }
});

// TCRN-CROSS-STORY-462 (SUB-242, rebuilding SUB-116). The responsibility view sits beside the
// raw count: it classifies reportBudget's proof files by what they do, never replaces the raw
// total, and is judged by nothing. Red legs: drop a file from the classified total, fold a
// mixed file into one class, report an unknown or a cost as zero, or let the view move the
// ratio verdict.
test("STORY-462 SUB-242: the responsibility view counts every proof line once beside the raw total", () => {
  const view = {
    schemaVersion: "tcrn.proof-budget.responsibility-view.v1",
    document: "docs/verification/proof-responsibility.md",
    responsibilities: [...PROOF_RESPONSIBILITIES],
    prefixes: [{ prefix: "tests/", responsibility: "test" }],
    classes: {
      "runtime-function": ["scripts/hook.mjs"],
      test: [],
      "verification-tool": ["scripts/gate.mjs", "scripts/retired.mjs"],
    },
    mixed: { "scripts/adapter.mjs": ["runtime-function", "verification-tool"] },
    costBaseline: { runtime: "unknown", resources: "unknown", repeatedExecution: "unknown", maintenance: "unknown" },
  };
  const files = [
    { path: "tests/a.test.mjs", lines: 40 },
    { path: "tests/fixtures/helper.mjs", lines: 2 },
    { path: "scripts/hook.mjs", lines: 11 },
    { path: "scripts/gate.mjs", lines: 7 },
    { path: "scripts/adapter.mjs", lines: 13 },
    { path: "scripts/new-tool.mjs", lines: 5 },
  ];
  const counted = classifyProofResponsibility(files, view);
  assert.equal(counted.status, "classified");
  assert.equal(counted.proofLines, 78, "the raw total is the plain sum of the same files");
  assert.deepEqual(counted.byResponsibility, { "runtime-function": 11, test: 42, "verification-tool": 7 });
  assert.deepEqual(counted.mixed, { lines: 13, files: [{ path: "scripts/adapter.mjs", lines: 13, responsibilities: ["runtime-function", "verification-tool"] }] });
  assert.deepEqual(counted.unknown, { lines: 5, files: [{ path: "scripts/new-tool.mjs", lines: 5 }] });
  assert.equal(Object.values(counted.byResponsibility).reduce((total, lines) => total + lines, 0) + counted.mixed.lines + counted.unknown.lines, counted.proofLines);
  assert.deepEqual(counted.staleEntries, ["scripts/retired.mjs"]);
  assert.deepEqual(Object.values(counted.costBaseline), ["unknown", "unknown", "unknown", "unknown"]);

  const broken = classifyProofResponsibility(files, { ...view, mixed: { "scripts/adapter.mjs": ["runtime-function"] }, costBaseline: { ...view.costBaseline, runtime: 0 } });
  assert.equal(broken.status, "invalid");
  assert.equal(broken.reasonCode, "PROOF_RESPONSIBILITY_VIEW_INVALID");
  assert.equal(broken.proofLines, 78, "an unusable view still reports the raw total");
  assert.ok(broken.problems.some((problem) => problem.includes("scripts/adapter.mjs")), JSON.stringify(broken.problems));
  assert.ok(broken.problems.some((problem) => problem.includes("costBaseline.runtime")), JSON.stringify(broken.problems));
});

test("STORY-462 SUB-242: the committed responsibility view is valid and leaves the ratio policy alone", async () => {
  const policy = await readPolicy();
  const view = policy.responsibilityView;
  assert.deepEqual(proofResponsibilityViewProblems(view), []);
  assert.deepEqual(view.responsibilities, ["runtime-function", "test", "verification-tool"]);
  assert.deepEqual(view.mixed["scripts/dispatch-adapter.mjs"], ["runtime-function", "verification-tool"], "a file with two responsibilities is not forced into one");
  assert.ok(Object.values(view.costBaseline).every((value) => value === "unknown"), "no measured cost baseline exists, so none is claimed");
  assert.ok(view.classes["runtime-function"].includes("scripts/knowledge-inject.mjs"), "runtime code under scripts/ is not called proof by directory");
  const documentText = await readFile(resolve(repositoryRoot, view.document), "utf8");
  assert.match(documentText, /responsibilityView/u);
  assert.deepEqual(Object.keys(policy.surfaceCaps).filter((key) => key.endsWith("Cap")).sort(), ["claimCap", "coreSourceLineCap", "verifyScriptCap"]);
  const withoutView = { ...policy };
  delete withoutView.responsibilityView;
  assert.deepEqual(
    evaluateProofBudget({ proofLines: 72_824, productLines: 29_041, policy }),
    evaluateProofBudget({ proofLines: 72_824, productLines: 29_041, policy: withoutView }),
    "the view does not move the ratio verdict",
  );
});
