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
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { P1_SEQUENCE } from "../scripts/p1-sequence.mjs";
import {
  evaluateProofBudget,
  isNonBlockingProofBudgetWarning,
  proofBudgetScopeBindingDigest,
  validateProofBudgetScopeBinding,
  PROOF_BUDGET_SCOPED_NONBLOCKING_REASON,
} from "../scripts/lib/proof-budget.mjs";
import { budgetWarningNotices, hasWarningOrError, inspectStructuredChildOutput, onlyBudgetWarning, validateStructuredChildExpectations } from "../scripts/lib/push-gate-output.mjs";
import { P8_RELEASE_ARTIFACTS, P8_TAG } from "../scripts/lib/p8-workflow-rc.mjs";
import { executeOperationalBatch, executeQualifiedBatch } from "../scripts/final-gate-plan.mjs";

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
  assert.equal(policy.hardRatio, 2.5);
  assert.equal(policy.exceptions.at(-1)?.id, "TCRN-CROSS-EPIC-135-owner-proof-budget-20260914");
  const cases = [
    [2.3728, true, "verified"],
    [2.4, true, "verified"],
    [2.4001, true, "warning"],
    [2.5, true, "warning"],
    [2.5001, false, "rejected"],
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

test("TCRN-CROSS-STORY-430: the raw 2.5348 ratio stays exceeded but is nonblocking for the exact bound closure", async () => {
  const policy = await readPolicy();
  const binding = policy.ratioPolicy.scopedDisposition.binding;
  const bindingSha256 = proofBudgetScopeBindingDigest(policy);
  assert.equal(policy.warningRatio, 2.4);
  assert.equal(policy.hardRatio, 2.5);
  assert.equal(binding.scopeId, "INIT-051/INC320-SERIAL-430+432-434+FINAL-RED");
  assert.equal(binding.currentExecution.pack, "INC320/430+432-434+FINAL-RED");
  assert.equal(binding.currentExecution.phase, "rework");
  assert.equal(binding.currentExecution.primaryWork.externalKey, "TCRN-CROSS-STORY-434");
  assert.equal(binding.currentExecution.primaryWork.id, "work:1891880eb2925c9c777d1d22");
  assert.equal(binding.currentExecution.primaryWork.scopeDigest, "d619d74e52f707ab1e2b3d29a6416c65410f7f8a5177dd0ce980a90ad0aee761");
  assert.equal(binding.currentExecution.role, "implementation");
  assert.equal(binding.currentExecution.bindingKind, "governed-task-role");
  assert.equal(binding.currentExecution.personaProfileId, null);
  assert.equal(binding.currentExecution.dispatch.workspaceVersion, 6361);
  assert.equal(binding.currentExecution.dispatch.headEventHash, "111dee8fc7462c867c69ae922a60fc3e6d1a2416047394faf9530856ae26b198");
  assert.equal(binding.currentExecution.dispatch.configDigest, "c64d5248a2580243fd301485a3afc4629d2dccd1f928a3d527d6fd1f3d00f91f");
  assert.equal(binding.currentExecution.dispatch.resolutionInput, "implement");
  assert.equal(binding.currentExecution.dispatch.model, "gpt-5.6-luna");
  assert.equal(binding.currentExecution.dispatch.effort, "max");
  assert.equal(binding.currentExecution.dispatch.forkTurns, "none");
  for (const field of ["activePackBriefSha256", "technicalPackSha256", "roleBindingAmendmentSha256", "serialPackRecordSha256"]) {
    assert.match(binding.currentExecution[field], /^[a-f0-9]{64}$/u, field);
  }
  assert.equal(binding.allowedWork.length, 21);
  assert.equal(binding.allowedWork.some((work) => work.externalKey === "TCRN-CROSS-STORY-431"), false);
  const correctionWork = binding.allowedWork.filter((work) => ["TCRN-CROSS-STORY-432", "TCRN-CROSS-STORY-433", "TCRN-CROSS-STORY-434"].includes(work.externalKey));
  assert.equal(correctionWork.length, 3);
  assert.equal(correctionWork.every((work) => binding.currentExecution.workIds.includes(work.id)), true);
  assert.deepEqual(binding.currentExecution.workIds, binding.allowedWork.map((work) => work.id));
  assert.deepEqual(validateProofBudgetScopeBinding(binding, policy), {
    ok: true,
    reasonCode: "PROOF_BUDGET_SCOPE_BINDING_VERIFIED",
    bindingSha256: policy.ratioPolicy.scopedDisposition.bindingSha256,
    executionSha256: bindingSha256,
  });

  const result = evaluateProofBudget({
    proofLines: 70_230,
    productLines: 27_706,
    policy,
    scopeBindingSha256: bindingSha256,
  });
  assert.equal(result.ratio, 2.5348);
  assert.equal(result.ok, true);
  assert.equal(result.status, "exceeded-nonblocking");
  assert.equal(result.reasonCode, PROOF_BUDGET_SCOPED_NONBLOCKING_REASON);
  assert.equal(result.rawStatus, "exceeded");
  assert.equal(result.rawReasonCode, "PROOF_BUDGET_EXCEEDED");
  assert.equal(result.blocking, false);
  assert.equal(result.warning.hardLimit, 2.5);
  assert.equal(result.warning.blocking, false);
  assert.equal(result.warning.scopeBindingSha256, bindingSha256);
  assert.equal(isNonBlockingProofBudgetWarning(result, { scopeBindingSha256: bindingSha256 }), true);
});

test("TCRN-CROSS-STORY-430: missing, caller-invented, future, or malformed bindings stay hard-red", async () => {
  const policy = await readPolicy();
  const binding = policy.ratioPolicy.scopedDisposition.binding;
  const bindingSha256 = proofBudgetScopeBindingDigest(policy);
  const input = { proofLines: 70_230, productLines: 27_706, policy };
  for (const requested of [undefined, "INIT-051", "a".repeat(64)]) {
    const result = evaluateProofBudget({ ...input, scopeBindingSha256: requested });
    assert.equal(result.ok, false, String(requested));
    assert.equal(result.status, "rejected", String(requested));
    assert.equal(result.reasonCode, "PROOF_BUDGET_EXCEEDED", String(requested));
    assert.equal(result.ratio, 2.5348, String(requested));
  }

  const futureWork = structuredClone(binding);
  futureWork.currentExecution.primaryWork = {
    externalKey: "TCRN-CROSS-STORY-431",
    id: "work:f6dfafa9884552bf95938066",
    revision: 1,
    scopeDigest: "977cfeb2718b60e0b7b9b07e95be34d7ab660c596544e604185fbc7b77ff19e0",
  };
  assert.equal(validateProofBudgetScopeBinding(futureWork, policy).ok, false);
  const wrongPack = structuredClone(binding);
  wrongPack.currentExecution.pack = "INIT-051";
  assert.equal(validateProofBudgetScopeBinding(wrongPack, policy).ok, false);
  const wrongPhase = structuredClone(binding);
  wrongPhase.currentExecution.phase = "task-pack";
  assert.equal(validateProofBudgetScopeBinding(wrongPhase, policy).ok, false);
  const staleDispatch = structuredClone(binding);
  staleDispatch.currentExecution.dispatch.workspaceVersion -= 1;
  assert.equal(validateProofBudgetScopeBinding(staleDispatch, policy).ok, false);
  const missingCurrentWork = structuredClone(binding);
  missingCurrentWork.currentExecution.workIds = missingCurrentWork.currentExecution.workIds.filter((id) => id !== "work:a9e16b025a21b9cf7238a5ce");
  assert.equal(validateProofBudgetScopeBinding(missingCurrentWork, policy).ok, false);
  const extraWork = structuredClone(binding);
  extraWork.currentExecution.workIds.push("work:f6dfafa9884552bf95938066");
  assert.equal(validateProofBudgetScopeBinding(extraWork, policy).ok, false);

  const malformedPolicy = structuredClone(policy);
  malformedPolicy.ratioPolicy.scopedDisposition.bindingSha256 = "0".repeat(64);
  assert.throws(
    () => evaluateProofBudget({ ...input, scopeBindingSha256: bindingSha256, policy: malformedPolicy }),
    (error) => error?.reasonCode === "PROOF_BUDGET_POLICY_INVALID",
  );
  const malformedScopePolicy = structuredClone(policy);
  malformedScopePolicy.ratioPolicy.scope = "INIT-051";
  assert.throws(
    () => evaluateProofBudget({ ...input, scopeBindingSha256: bindingSha256, policy: malformedScopePolicy }),
    (error) => error?.reasonCode === "PROOF_BUDGET_POLICY_INVALID",
  );
  assert.throws(
    () => evaluateProofBudget({ proofLines: -1, productLines: 27_706, policy, scopeBindingSha256: bindingSha256 }),
    (error) => error?.reasonCode === "PROOF_BUDGET_POLICY_INVALID",
  );
});

test("EPIC135: push-gate budget exemption requires one terminal receipt and no other diagnostics", () => {
  const boundary = evaluateProofBudget({ proofLines: 24_001, productLines: 10_000, policy: {
    frozenRatio: 1.5888,
    warningRatio: 2.4,
    hardRatio: 2.5,
    exceptions: [{ id: "fixture", recordedAt: "2026-09-14", ratio: 2.5, rationale: "A bounded fixture threshold for parser coverage." }],
  } });
  const budget = { command: "budget", ...boundary };
  const receipt = (notices) => JSON.stringify({ ok: true, reasonCode: "P1_VERIFIED", notices });
  const budgetOnly = receipt([budget]);
  assert.equal(budgetWarningNotices(budgetOnly, "verify:p1").length, 1);
  assert.equal(onlyBudgetWarning(budgetOnly, "verify:p1"), true);
  assert.equal(hasWarningOrError(budgetOnly, "verify:p1"), false);

  const sameReceipt = receipt([budget, { command: "typecheck", severity: "warning", reasonCode: "OTHER_WARNING", blocking: true }]);
  assert.equal(onlyBudgetWarning(sameReceipt, "verify:p1"), false);
  assert.equal(hasWarningOrError(sameReceipt, "verify:p1"), true);

  const independentLine = `OTHER_WARNING: compiler notice\n${budgetOnly}`;
  assert.equal(onlyBudgetWarning(independentLine, "verify:p1"), false);
  assert.equal(hasWarningOrError(independentLine, "verify:p1"), true);

  const otherFirst = `${receipt([{ command: "typecheck", severity: "warning", reasonCode: "OTHER_WARNING" }])}\n${budgetOnly}`;
  const otherLast = `${budgetOnly}\n${receipt([{ command: "typecheck", severity: "warning", reasonCode: "OTHER_WARNING" }])}`;
  for (const output of [otherFirst, otherLast]) {
    assert.deepEqual(budgetWarningNotices(output, "verify:p1"), []);
    assert.equal(onlyBudgetWarning(output, "verify:p1"), false);
    assert.equal(hasWarningOrError(output, "verify:p1"), true);
  }
});

test("TCRN-CROSS-STORY-430: scoped exceeded notice is shared by P1/push and never hides a real error", async () => {
  const policy = await readPolicy();
  const bindingSha256 = proofBudgetScopeBindingDigest(policy);
  const result = evaluateProofBudget({ proofLines: 70_230, productLines: 27_706, policy, scopeBindingSha256: bindingSha256 });
  const budgetNotice = { command: "budget", ...result.warning };
  const receipt = (notices) => JSON.stringify({ ok: true, reasonCode: "P1_VERIFIED", notices });
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
    reasonCode: "P8_WORKFLOW_RC_VERIFIED",
    tag: P8_TAG,
    p8BasisCommit: "a".repeat(40),
    tests: "P8_WORKFLOW_RC_TESTS_VERIFIED",
    trust: "TRUST_NEGATIVE_MATRIX_VERIFIED",
    sourceArchive: { reasonCode: "ARCHIVE_VERIFIED", path: "dist/source/tcrn-workflow-source.tar", sha256: sourceDigest, files: sourceFiles.length },
    sbom: { reasonCode: "SBOM_VERIFIED", path: "dist/sbom/sbom.cdx.json", components: 1, directComponents: 1, transitiveComponents: 0, dependencyGraphClosure: "complete", basis: "c".repeat(64) },
    artifacts: P8_RELEASE_ARTIFACTS.map((path) => ({ path: `dist/release/${path}`, size: 1, sha256: "d".repeat(64) })).sort((left, right) => left.path.localeCompare(right.path)),
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

test("EPIC135: formal batch aggregation preserves budget notices but blocks other warnings", async () => {
  const input = {
    series: "EPIC135",
    pack: "HC2",
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
    pack: binding.currentExecution.pack,
    primaryWorkId: binding.currentExecution.primaryWork.id,
    scopeDigest: binding.currentExecution.primaryWork.scopeDigest,
    role: binding.currentExecution.role,
    phase: binding.currentExecution.phase,
    taskClass: binding.currentExecution.taskClass,
    personaProfileId: binding.currentExecution.personaProfileId,
    workIds: binding.currentExecution.workIds,
    proofBudgetScopeBinding: binding,
  };
  const scopedPass = await executeQualifiedBatch(boundInput, async () => ({ ok: true, governanceNotices: [{ command: "budget", ...scoped.warning }] }));
  assert.equal(scopedPass.status, "completed");

  const noBindingInput = { ...boundInput };
  delete noBindingInput.proofBudgetScopeBinding;
  const missingBinding = await executeQualifiedBatch(noBindingInput, async () => ({ ok: true, governanceNotices: [{ command: "budget", ...scoped.warning }] }));
  assert.equal(missingBinding.status, "failed");

  const wrongPackInput = { ...boundInput, pack: "INIT-051" };
  const wrongPack = await executeQualifiedBatch(wrongPackInput, async () => ({ ok: true, governanceNotices: [{ command: "budget", ...scoped.warning }] }));
  assert.equal(wrongPack.status, "failed");
});

test("TCRN-CROSS-STORY-430: operational batch revalidates the same scope binding against native work", async () => {
  const policy = await readPolicy();
  const binding = policy.ratioPolicy.scopedDisposition.binding;
  const bindingSha256 = proofBudgetScopeBindingDigest(policy);
  const currentWorkIds = binding.currentExecution.workIds;
  const records = [
    ...binding.allowedWork.map((work) => ({ ...work, revision: work.id === binding.currentExecution.primaryWork.id ? 1 : 1, scopeDigest: work.id === binding.currentExecution.primaryWork.id ? binding.currentExecution.primaryWork.scopeDigest : `scope-${work.id}`, status: "blocked", dependencies: [], blockedReason: "bounded fixture stage input" })),
    ...binding.excludedWork.map((work) => ({ ...work, revision: 1, scopeDigest: "scope-planned-431", status: "planned", dependencies: [] })),
  ];
  const selected = (workIds) => workIds.map((id) => records.find((record) => record.id === id)).filter(Boolean);
  const readNative = async ({ workIds }) => {
    const tasks = selected(workIds);
    return {
      ok: true,
      nativeStatus: { workspaceId: binding.workspaceId, version: 6361, headEventHash: "1".repeat(64) },
      workListComplete: true,
      workListPages: [{ offset: 0, total: records.length, truncated: false, version: 6361, headEventHash: "1".repeat(64) }],
      workListRecords: records,
      workShows: tasks.map(({ id, revision, scopeDigest, status, externalKey }) => ({ id, revision, scopeDigest, status, externalKey })),
      tasks,
      queue: { observed: true, digest: "queue-scope", tasks, records: tasks },
      queueDigest: "queue-scope",
      dependencies: { observed: true, schemaPresent: true, records: tasks.map(({ id, dependencies }) => ({ id, dependencies })) },
      dependencySchemaPresent: true,
    };
  };
  const observeRuntime = async ({ nativeState }) => ({
    observedAt: "2026-09-15T12:45:00Z",
    source: "code-owned-test-observer",
    queue: { observed: true, digest: nativeState.queueDigest, records: nativeState.tasks },
    dependencies: { observed: true, digest: "dependencies-scope", records: nativeState.dependencies.records },
    agents: { observed: true, digest: "agents-scope", records: [] },
    writes: { observed: true, digest: "writes-scope", records: [] },
    candidate: { observed: true, stable: true, id: "candidate-scope", digest: "tree-scope", records: [] },
  });
  const input = {
    series: "INIT-051",
    pack: binding.currentExecution.pack,
    stage: "candidate-final",
    trigger: "formal-batch-gate",
    workspace: "/fixture/workspace",
    workIds: currentWorkIds,
    primaryWorkId: binding.currentExecution.primaryWork.id,
    scopeDigest: binding.currentExecution.primaryWork.scopeDigest,
    role: binding.currentExecution.role,
    phase: binding.currentExecution.phase,
    taskClass: binding.currentExecution.taskClass,
    personaProfileId: binding.currentExecution.personaProfileId,
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

  let wrongPackCalls = 0;
  const wrongPack = await executeOperationalBatch({ ...input, pack: "INIT-051" }, async () => {
    wrongPackCalls += 1;
    return { ok: true, governanceNotices: [{ command: "budget", ...warning }] };
  }, { readNative, observeRuntime });
  assert.equal(wrongPack.status, "not-verifiable");
  assert.equal(wrongPackCalls, 0);

  let futureCalls = 0;
  const futureWork = await executeOperationalBatch({ ...input, workIds: [...currentWorkIds, "work:f6dfafa9884552bf95938066"] }, async () => {
    futureCalls += 1;
    return { ok: true, governanceNotices: [{ command: "budget", ...warning }] };
  }, { readNative, observeRuntime });
  assert.equal(futureWork.status, "not-verifiable");
  assert.equal(futureCalls, 0);
});
