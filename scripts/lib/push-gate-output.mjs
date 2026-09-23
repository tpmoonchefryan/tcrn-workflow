// SPDX-License-Identifier: Apache-2.0

import { isNonBlockingProofBudgetWarning } from "./proof-budget.mjs";
import { compareCanonicalText } from "./canonical-order.mjs";
import { P8_RELEASE_ARTIFACTS, P8_SUPPORTED_AOS_RELEASES, P8_TAG, staleReleaseArtifactMoves } from "./p8-workflow-rc.mjs";
import { P1_TASKS } from "../p1-sequence.mjs";

const DIAGNOSTIC_WORD = /(?:^|[^A-Za-z])(?:warning|warn|error|errors|failed|failure|blocked|refused|denied)(?:$|[^A-Za-z])/iu;
const P8_SUCCESS_FIELDS = Object.freeze([
  "artifacts", "command", "mutation", "network", "ok", "p8BasisCommit", "privacy", "privacySurfaces",
  "publication", "reasonCode", "releaseStatus", "reproducibility", "sbom",
  "sourceArchive", "staleReleaseArtifacts", "supportedAosReleases", "tag", "tests", "trust",
]);
const P8_ARCHIVE_FIELDS = Object.freeze(["files", "path", "reasonCode", "sha256"]);
const P8_SBOM_FIELDS = Object.freeze([
  "basis", "components", "dependencyGraphClosure", "directComponents", "path",
  "reasonCode", "transitiveComponents",
]);
const P8_ARTIFACT_FIELDS = Object.freeze(["path", "sha256", "size"]);
const P8_STALE_RELEASE_FIELDS = Object.freeze(["from", "sha256", "size", "to", "version"]);
const P8_REPRODUCIBILITY_FIELDS = Object.freeze(["orderedEntries", "rootsIndependent", "sha256", "sourceFiles"]);
const P8_PRIVACY_SURFACE_FIELDS = Object.freeze([
  "aggregateAlgorithm", "buildOutput", "fullHistory", "releaseArtifacts", "sourceArchive", "trackedSource",
]);
const P8_PRIVACY_SURFACE_ROW_FIELDS = Object.freeze(["bytes", "entries", "sha256"]);
const GUARD_SUCCESS_FIELDS = Object.freeze(["guards", "killed", "ok", "reasonCode"]);
const P1_REASON_CODES = Object.freeze({
  "format-check": ["FORMAT_VERIFIED"],
  lint: ["LINT_VERIFIED"],
  typecheck: ["TYPECHECK_VERIFIED"],
  build: ["BUILD_VERIFIED"],
  test: ["TESTS_VERIFIED"],
  portal: ["PORTAL_VERIFY_TRAIN_GREEN"],
  source: ["SOURCE_ALLOWLIST_VERIFIED"],
  archive: ["ARCHIVE_VERIFIED"],
  "no-sibling-dependency": ["NO_SIBLING_DEPENDENCY"],
  offline: ["OFFLINE_BOUNDARY_VERIFIED"],
  governance: ["GOVERNANCE_TOOLCHAIN_VERIFIED"],
  privacy: ["PRIVACY_SOURCE_CLEAN"],
  "verification-map": ["VERIFICATION_MAP_VERIFIED"],
  budget: ["PROOF_BUDGET_VERIFIED", "PROOF_BUDGET_WARNING", "PROOF_BUDGET_EXCEEDED_SCOPED_NONBLOCKING"],
  links: ["MARKDOWN_LINKS_RESOLVED"],
  "retrieval-eval": ["RETRIEVAL_EVAL_VERIFIED"],
});

const SUCCESS_RULES = Object.freeze({
  "verify:p8": {
    reasonCode: "P8_WORKFLOW_RC_VERIFIED",
    fields: P8_SUCCESS_FIELDS,
  },
  "guard-check": {
    reasonCode: "GUARD_CHECK_VERIFIED",
    fields: GUARD_SUCCESS_FIELDS,
  },
});

export function validateHostEvidenceProvenance(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reasonCode: "PUSH_GATE_HOST_EVIDENCE_INVALID", detail: "receipt is not an object" };
  if (typeof value.observedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.observedAt)) return { ok: false, reasonCode: "PUSH_GATE_HOST_EVIDENCE_INVALID", detail: `observedAt is ${String(value.observedAt)}` };
  if (typeof value.supersededBy !== "string" || value.supersededBy.length === 0 || value.currentClaim !== "none") return { ok: false, reasonCode: "PUSH_GATE_HOST_EVIDENCE_PROVENANCE_INVALID", detail: `supersededBy is ${String(value.supersededBy)}, currentClaim is ${String(value.currentClaim)}` };
  return { ok: true, reasonCode: "PUSH_GATE_HOST_EVIDENCE_VALID" };
}

/** Validate the real policy inputs needed before non-P1 children may start. */
export function validateStructuredChildExpectations({ sourceFiles, guardIds, p8BasisCommit } = {}) {
  const findings = [];
  const listProblems = (value, name) => {
    if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
      findings.push({ code: "CHILD_EXPECTATION_LIST_INVALID", location: `$.${name}` });
      return;
    }
    if (new Set(value).size !== value.length) findings.push({ code: "CHILD_EXPECTATION_LIST_DUPLICATE", location: `$.${name}` });
  };
  listProblems(sourceFiles, "sourceFiles");
  listProblems(guardIds, "guardIds");
  if (typeof p8BasisCommit !== "string" || !/^[a-f0-9]{40}$/u.test(p8BasisCommit)) findings.push({ code: "CHILD_EXPECTATION_COMMIT_INVALID", location: "$.p8BasisCommit" });
  return {
    ok: findings.length === 0,
    reasonCode: findings.length === 0 ? "CHILD_EXPECTATIONS_VALID" : "CHILD_EXPECTATIONS_INVALID",
    findings,
    sourceFiles: Array.isArray(sourceFiles) ? [...sourceFiles] : null,
    guardIds: Array.isArray(guardIds) ? [...guardIds] : null,
    p8BasisCommit: typeof p8BasisCommit === "string" ? p8BasisCommit : null,
  };
}

function diagnosticText(value) {
  return typeof value === "string" && DIAGNOSTIC_WORD.test(value);
}

function diagnosticValue(value, { allowBudgetReasonCode = false, location = "$" } = {}) {
  if (typeof value === "string") return diagnosticText(value);
  if (Array.isArray(value)) return value.some((entry) => diagnosticValue(entry, { allowBudgetReasonCode, location }));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    // Null/false/empty diagnostic fields are ordinary successful receipt shape.
    if (["error", "errors", "warning", "warnings"].includes(key) && (child === null || child === false || Array.isArray(child) && child.length === 0)) return false;
    // verify:p1 exposes the reason of every inner command in an enumerated
    // `observedReasonCodes` array.  The budget command's policy-valid warning
    // is the one typed reason that contains the generic diagnostic word;
    // permit that exact value only after the caller has established that the
    // same terminal receipt carries a valid budget notice.  A reason in any
    // other field, or any other warning/error value in the array, remains red.
    if (allowBudgetReasonCode && key === "observedReasonCodes" && Array.isArray(child)) {
      return child.some((entry) => entry !== "PROOF_BUDGET_WARNING" && diagnosticValue(entry, { allowBudgetReasonCode: false, location: `${location}.${key}` }));
    }
    return diagnosticValue(child, { allowBudgetReasonCode, location: `${location}.${key}` });
  });
}

function parseJsonLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Parse a P1 output stream without allowing a later terminal receipt to replace
 * an earlier one. The returned receipt is usable only when exactly one
 * P1_VERIFIED terminal record was observed.
 */
export function parseP1TerminalOutput(output, script = "verify:p1") {
  const terminalReceipts = [];
  const otherJson = [];
  const nonJson = [];
  if (script !== "verify:p1") return { terminalReceipts, otherJson, nonJson, receipt: null, budgetNotices: [] };
  for (const line of String(output ?? "").split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const value = parseJsonLine(line);
    if (value?.reasonCode === "P1_VERIFIED") terminalReceipts.push(value);
    else if (value !== null) otherJson.push({ line, value });
    else nonJson.push(line);
  }
  const receipt = terminalReceipts.length === 1 ? terminalReceipts[0] : null;
  const notices = Array.isArray(receipt?.notices) ? receipt.notices : [];
  const budgetNotices = notices.filter((notice) => notice?.command === "budget");
  return { terminalReceipts, otherJson, nonJson, receipt, budgetNotices };
}

function residualReceipt(receipt, options = {}) {
  if (!receipt || typeof receipt !== "object") return null;
  const notices = Array.isArray(receipt.notices) ? receipt.notices : [];
  return {
    ...receipt,
    notices: notices.filter((notice) => notice?.command !== "budget" || !isNonBlockingProofBudgetWarning(notice, options)),
  };
}

function receiptHasNonBudgetDiagnostic(receipt, options = {}, { allowBudgetReasonCode = false } = {}) {
  const residual = residualReceipt(receipt, options);
  return residual !== null && diagnosticValue(residual, { allowBudgetReasonCode });
}

/** Return only valid budget notices from one uniquely identified P1 receipt. */
export function budgetWarningNotices(output, script, options = {}) {
  const parsed = parseP1TerminalOutput(output, script);
  if (parsed.receipt === null || parsed.budgetNotices.length === 0) return [];
  if (parsed.budgetNotices.some((notice) => !isNonBlockingProofBudgetWarning(notice, options))) return [];
  return parsed.budgetNotices;
}

/**
 * Decide whether the generic push-gate warning check may exempt this output.
 * The exemption is deliberately narrow: one P1 terminal receipt, at least one
 * valid budget notice, and no diagnostic in any remaining receipt/output line.
 */
export function onlyBudgetWarning(output, script, options = {}) {
  const parsed = parseP1TerminalOutput(output, script);
  if (parsed.receipt === null || parsed.budgetNotices.length === 0 || parsed.budgetNotices.some((notice) => !isNonBlockingProofBudgetWarning(notice, options))) return false;
  if (parsed.receipt.ok !== true || parsed.receipt.command !== "verify-p1" || !Array.isArray(parsed.receipt.commands) || !Array.isArray(parsed.receipt.observedReasonCodes)) return false;
  if (JSON.stringify(parsed.receipt.commands) !== JSON.stringify(P1_TASKS)) return false;
  if (parsed.receipt.observedReasonCodes.length !== P1_TASKS.length) return false;
  if (parsed.receipt.observedReasonCodes.some((reasonCode, index) => !P1_REASON_CODES[P1_TASKS[index]]?.includes(reasonCode))) return false;
  if (parsed.budgetNotices.length !== 1) return false;
  if (parsed.receipt.observedReasonCodes[P1_TASKS.indexOf("budget")] !== parsed.budgetNotices[0].reasonCode) return false;
  if (receiptHasNonBudgetDiagnostic(parsed.receipt, options, { allowBudgetReasonCode: true })) return false;
  if (parsed.otherJson.some(({ value, line }) => diagnosticValue(value) || diagnosticText(line))) return false;
  if (parsed.nonJson.some((line) => diagnosticText(line))) return false;
  return true;
}

/** Generic diagnostic detection used by the push gate's warning branch. */
export function hasWarningOrError(output, script, expected = {}) {
  if (script === "verify:p8" || script === "guard-check" || output !== null && typeof output === "object" && !Buffer.isBuffer(output)) {
    const streams = output !== null && typeof output === "object" && !Buffer.isBuffer(output)
      ? output
      : { stdout: output ?? "", stderr: "", exitCode: 0, signal: null };
    return !inspectStructuredChildOutput(streams, script, expected).ok;
  }
  if (script !== "verify:p1") return diagnosticText(String(output ?? ""));
  const parsed = parseP1TerminalOutput(output, script);
  if (parsed.terminalReceipts.length !== 1 && parsed.terminalReceipts.some((receipt) => Array.isArray(receipt?.notices) && receipt.notices.some((notice) => notice?.command === "budget"))) return true;
  if (parsed.budgetNotices.some((notice) => !isNonBlockingProofBudgetWarning(notice, expected))) return true;
  const allowBudgetReasonCode = parsed.budgetNotices.length > 0 && parsed.budgetNotices.every((notice) => isNonBlockingProofBudgetWarning(notice, expected));
  if (allowBudgetReasonCode && !onlyBudgetWarning(output, script, expected)) return true;
  if (parsed.terminalReceipts.some((receipt) => receiptHasNonBudgetDiagnostic(receipt, expected, { allowBudgetReasonCode }))) return true;
  if (parsed.otherJson.some(({ value, line }) => diagnosticValue(value) || diagnosticText(line))) return true;
  return parsed.nonJson.some((line) => diagnosticText(line));
}

function exactKeys(value, expected, location, findings) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    findings.push({ code: "CHILD_TERMINAL_OBJECT_INVALID", location });
    return false;
  }
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...expected].sort(compareCanonicalText);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    findings.push({ code: "CHILD_TERMINAL_FIELDS_INVALID", location, expected: wanted, actual });
    return false;
  }
  return true;
}

function digestText(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function childText(value, location, findings) {
  if (Buffer.isBuffer(value)) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      findings.push({ code: "CHILD_OUTPUT_UTF8_INVALID", location, bytes: value.length });
      return "";
    }
  }
  const text = String(value ?? "");
  if (!text.isWellFormed()) {
    findings.push({ code: "CHILD_OUTPUT_UTF8_INVALID", location, bytes: Buffer.byteLength(text, "utf8") });
    return "";
  }
  return text;
}

function inspectP8Receipt(receipt, expectedSourceFiles, expectedBasisCommit, findings) {
  exactKeys(receipt, P8_SUCCESS_FIELDS, "$", findings);
  if (receipt.command !== "p8") findings.push({ code: "P8_COMMAND_INVALID", location: "$.command", expected: "p8", actual: receipt.command ?? null });
  if (receipt.ok !== true) findings.push({ code: "P8_OK_INVALID", location: "$.ok", expected: true, actual: receipt.ok ?? null });
  if (receipt.reasonCode !== "P8_WORKFLOW_RC_VERIFIED") findings.push({ code: "CHILD_TERMINAL_REASON_INVALID", location: "$.reasonCode" });
  if (receipt.tag !== P8_TAG) findings.push({ code: "P8_TAG_MISMATCH", location: "$.tag", expected: P8_TAG, actual: receipt.tag ?? null });
  if (typeof receipt.p8BasisCommit !== "string" || !/^[a-f0-9]{40}$/u.test(receipt.p8BasisCommit)) findings.push({ code: "P8_BASIS_COMMIT_INVALID", location: "$.p8BasisCommit" });
  if (typeof expectedBasisCommit === "string" && receipt.p8BasisCommit !== expectedBasisCommit) findings.push({ code: "P8_BASIS_COMMIT_MISMATCH", location: "$.p8BasisCommit", expected: expectedBasisCommit, actual: receipt.p8BasisCommit ?? null });
  for (const [field, expected] of [["tests", "P8_WORKFLOW_RC_TESTS_VERIFIED"], ["trust", "TRUST_NEGATIVE_MATRIX_VERIFIED"], ["privacy", "PRIVACY_SOURCE_CLEAN"]]) {
    if (receipt[field] !== expected) findings.push({ code: "P8_SUCCESS_FIELD_INVALID", location: `$.${field}`, expected, actual: receipt[field] ?? null });
  }
  for (const field of ["network", "mutation", "publication"]) {
    if (receipt[field] !== false) findings.push({ code: "P8_SIDE_EFFECT_FLAG_INVALID", location: `$.${field}`, expected: false, actual: receipt[field] ?? null });
  }
  if (receipt.releaseStatus !== "accepted_release") findings.push({ code: "P8_RELEASE_STATUS_INVALID", location: "$.releaseStatus" });
  if (JSON.stringify(receipt.supportedAosReleases) !== JSON.stringify(P8_SUPPORTED_AOS_RELEASES)) findings.push({ code: "P8_SUPPORTED_RELEASE_SET_INVALID", location: "$.supportedAosReleases" });

  const source = receipt.sourceArchive;
  exactKeys(source, P8_ARCHIVE_FIELDS, "$.sourceArchive", findings);
  if (source?.reasonCode !== "ARCHIVE_VERIFIED" || source?.path !== "dist/source/tcrn-workflow-source.tar" || !digestText(source?.sha256) || !nonNegativeInteger(source?.files)) {
    findings.push({ code: "P8_SOURCE_ARCHIVE_RECEIPT_INVALID", location: "$.sourceArchive" });
  }

  const sbom = receipt.sbom;
  exactKeys(sbom, P8_SBOM_FIELDS, "$.sbom", findings);
  if (sbom?.reasonCode !== "SBOM_VERIFIED" || sbom?.path !== "dist/sbom/sbom.cdx.json" || !nonNegativeInteger(sbom?.components) || !nonNegativeInteger(sbom?.directComponents) || !nonNegativeInteger(sbom?.transitiveComponents) || sbom?.dependencyGraphClosure !== "complete" || !digestText(sbom?.basis)) {
    findings.push({ code: "P8_SBOM_RECEIPT_INVALID", location: "$.sbom" });
  }

  const expectedArchiveEntries = Array.isArray(expectedSourceFiles)
    ? [...expectedSourceFiles].sort(compareCanonicalText)
    : null;
  if (expectedArchiveEntries === null || expectedArchiveEntries.length === 0 || expectedArchiveEntries.some((entry) => typeof entry !== "string") || new Set(expectedArchiveEntries).size !== expectedArchiveEntries.length) {
    findings.push({ code: "P8_SOURCE_ALLOWLIST_EXPECTATION_INVALID", location: "$.expectedSourceFiles" });
  }
  const reproducibility = receipt.reproducibility;
  exactKeys(reproducibility, P8_REPRODUCIBILITY_FIELDS, "$.reproducibility", findings);
  if (reproducibility?.rootsIndependent !== true || !digestText(reproducibility?.sha256) || !Array.isArray(reproducibility?.orderedEntries) || !Number.isSafeInteger(reproducibility?.sourceFiles)) {
    findings.push({ code: "P8_REPRODUCIBILITY_RECEIPT_INVALID", location: "$.reproducibility" });
  } else if (expectedArchiveEntries !== null) {
    if (reproducibility.sourceFiles !== expectedArchiveEntries.length || source?.files !== expectedArchiveEntries.length) {
      findings.push({ code: "P8_SOURCE_ARCHIVE_COUNT_MISMATCH", location: "$.reproducibility.sourceFiles", expected: expectedArchiveEntries.length, actual: reproducibility.sourceFiles });
    }
    if (JSON.stringify(reproducibility.orderedEntries) !== JSON.stringify(expectedArchiveEntries)) {
      findings.push({ code: "P8_SOURCE_ARCHIVE_ENTRIES_MISMATCH", location: "$.reproducibility.orderedEntries", expectedCount: expectedArchiveEntries.length, actualCount: reproducibility.orderedEntries.length });
    }
    if (source?.sha256 !== reproducibility.sha256) findings.push({ code: "P8_SOURCE_ARCHIVE_DIGEST_MISMATCH", location: "$.reproducibility.sha256" });
  }

  const expectedArtifactPaths = [...P8_RELEASE_ARTIFACTS].map((entry) => `dist/release/${entry}`).sort(compareCanonicalText);
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length !== expectedArtifactPaths.length) {
    findings.push({ code: "P8_ARTIFACT_SET_INVALID", location: "$.artifacts", expectedCount: expectedArtifactPaths.length, actualCount: Array.isArray(receipt.artifacts) ? receipt.artifacts.length : null });
  } else {
    for (const [index, artifact] of receipt.artifacts.entries()) {
      exactKeys(artifact, P8_ARTIFACT_FIELDS, `$.artifacts[${index}]`, findings);
      if (artifact?.path !== expectedArtifactPaths[index] || !nonNegativeInteger(artifact?.size) || !digestText(artifact?.sha256)) {
        findings.push({ code: "P8_ARTIFACT_RECORD_INVALID", location: `$.artifacts[${index}]`, expectedPath: expectedArtifactPaths[index], actualPath: artifact?.path ?? null });
      }
    }
  }

  // TCRN-CROSS-STORY-461 R1: the stale source archives verify:p8 moved out of dist/release.
  // Each record must be the move staleReleaseArtifactMoves names for that file.
  if (!Array.isArray(receipt.staleReleaseArtifacts)) {
    findings.push({ code: "P8_STALE_RELEASE_SET_INVALID", location: "$.staleReleaseArtifacts" });
  } else {
    for (const [index, moved] of receipt.staleReleaseArtifacts.entries()) {
      exactKeys(moved, P8_STALE_RELEASE_FIELDS, `$.staleReleaseArtifacts[${index}]`, findings);
      const name = typeof moved?.from === "string" && moved.from.startsWith("dist/release/") ? moved.from.slice("dist/release/".length) : null;
      const [expected] = name === null ? [] : staleReleaseArtifactMoves([name]);
      if (expected === undefined || moved.from !== expected.from || moved.to !== expected.to || moved.version !== expected.version || !nonNegativeInteger(moved.size) || !digestText(moved.sha256)) {
        findings.push({ code: "P8_STALE_RELEASE_RECORD_INVALID", location: `$.staleReleaseArtifacts[${index}]` });
      }
    }
  }

  const surfaces = receipt.privacySurfaces;
  exactKeys(surfaces, P8_PRIVACY_SURFACE_FIELDS, "$.privacySurfaces", findings);
  if (surfaces?.aggregateAlgorithm !== "sha256(path-NUL-byteLength-NUL-bytes over canonical path order)") {
    findings.push({ code: "P8_PRIVACY_SURFACE_ALGORITHM_INVALID", location: "$.privacySurfaces.aggregateAlgorithm" });
  }
  for (const field of ["trackedSource", "fullHistory", "buildOutput", "sourceArchive", "releaseArtifacts"]) {
    const row = surfaces?.[field];
    exactKeys(row, P8_PRIVACY_SURFACE_ROW_FIELDS, `$.privacySurfaces.${field}`, findings);
    if (!nonNegativeInteger(row?.entries) || !nonNegativeInteger(row?.bytes) || !digestText(row?.sha256)) {
      findings.push({ code: "P8_PRIVACY_SURFACE_RECORD_INVALID", location: `$.privacySurfaces.${field}` });
    }
  }
}

function inspectGuardReceipt(receipt, expectedGuardIds, findings) {
  exactKeys(receipt, GUARD_SUCCESS_FIELDS, "$", findings);
  if (receipt.reasonCode !== "GUARD_CHECK_VERIFIED" || receipt.ok !== true) findings.push({ code: "GUARD_SUCCESS_RECEIPT_INVALID", location: "$" });
  if (!Array.isArray(expectedGuardIds) || expectedGuardIds.length === 0 || expectedGuardIds.some((id) => typeof id !== "string" || id.length === 0) || new Set(expectedGuardIds).size !== expectedGuardIds.length) {
    findings.push({ code: "GUARD_REGISTRY_EXPECTATION_INVALID", location: "$.expectedGuardIds" });
  }
  if (!Array.isArray(receipt.killed) || !Number.isSafeInteger(receipt.guards) || receipt.guards !== receipt.killed.length || JSON.stringify(receipt.killed) !== JSON.stringify(expectedGuardIds)) {
    findings.push({ code: "GUARD_SUCCESS_IDENTITY_INVALID", location: "$.killed", expectedCount: Array.isArray(expectedGuardIds) ? expectedGuardIds.length : null, actualCount: Array.isArray(receipt.killed) ? receipt.killed.length : null, actualGuards: receipt.guards ?? null });
  }
}

function residualDiagnostic(value, location, findings, skippedLocation = null) {
  if (skippedLocation !== null && location === skippedLocation) return;
  if (typeof value === "string") {
    if (diagnosticText(value)) findings.push({ code: "CHILD_DIAGNOSTIC_TEXT", location, sample: value.slice(0, 200) });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => residualDiagnostic(entry, `${location}[${index}]`, findings, skippedLocation));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["error", "errors", "warning", "warnings"].includes(key) && (child === null || child === false || Array.isArray(child) && child.length === 0)) continue;
    residualDiagnostic(child, `${location}.${key}`, findings, skippedLocation);
  }
}

/**
 * Validate the two successful non-P1 child receipts without scanning their
 * explicitly typed machine-data fields as diagnostics. Every other byte of a
 * non-P1 stream remains fail-closed: exactly one JSON terminal on stdout,
 * empty stderr, exit 0, exact receipt shape, and no residual diagnostics.
 */
export function inspectStructuredChildOutput({ stdout = "", stderr = "", exitCode = 0, signal = null } = {}, script, expected = {}) {
  const findings = [];
  const rule = SUCCESS_RULES[script];
  if (!rule) return { ok: false, reasonCode: "CHILD_SCRIPT_UNEXPECTED", findings: [{ code: "CHILD_SCRIPT_UNEXPECTED", location: "$.script", actual: script ?? null }] };
  const stdoutText = childText(stdout, "$.stdout", findings);
  const stderrText = childText(stderr, "$.stderr", findings);
  if (exitCode !== 0 || signal !== null) findings.push({ code: "CHILD_EXIT_NOT_SUCCESS", location: "$.exit", exitCode, signal });
  if (stderrText.length > 0) findings.push({ code: "CHILD_STDERR_NOT_EMPTY", location: "$.stderr", bytes: Buffer.byteLength(stderrText), sample: stderrText.slice(0, 200) });
  const lines = stdoutText.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) findings.push({ code: lines.length > 1 ? "CHILD_TERMINAL_DUPLICATE_OR_EXTRA_OUTPUT" : "CHILD_TERMINAL_MISSING", location: "$.stdout", lineCount: lines.length });
  let receipt = null;
  if (lines.length === 1) {
    try {
      receipt = JSON.parse(lines[0]);
      if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("terminal must be a JSON object");
    } catch (error) {
      findings.push({ code: "CHILD_TERMINAL_JSON_INVALID", location: "$.stdout[0]", message: String(error?.message ?? error) });
    }
  }
  if (receipt !== null) {
    if (receipt.reasonCode !== rule.reasonCode) findings.push({ code: "CHILD_TERMINAL_REASON_INVALID", location: "$.reasonCode", expected: rule.reasonCode, actual: receipt.reasonCode ?? null });
    if (script === "verify:p8") inspectP8Receipt(receipt, expected.sourceFiles, expected.p8BasisCommit, findings);
    else inspectGuardReceipt(receipt, expected.guardIds, findings);
    residualDiagnostic(receipt, "$", findings, script === "verify:p8" ? "$.reproducibility.orderedEntries" : "$.killed");
  }
  return {
    ok: findings.length === 0,
    reasonCode: findings.length === 0 ? "CHILD_TERMINAL_RECEIPT_VALID" : "CHILD_OUTPUT_NOT_PROVEN",
    script,
    terminalReasonCode: receipt?.reasonCode ?? null,
    findings,
  };
}
