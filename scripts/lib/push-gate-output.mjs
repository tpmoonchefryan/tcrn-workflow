// SPDX-License-Identifier: Apache-2.0

import { isNonBlockingProofBudgetWarning } from "./proof-budget.mjs";

const DIAGNOSTIC_WORD = /(?:^|[^A-Za-z])(?:warning|warn|error|errors|failed|failure|blocked|refused|denied)(?:$|[^A-Za-z])/iu;

function diagnosticText(value) {
  return typeof value === "string" && DIAGNOSTIC_WORD.test(value);
}

function diagnosticValue(value) {
  if (typeof value === "string") return diagnosticText(value);
  if (Array.isArray(value)) return value.some((entry) => diagnosticValue(entry));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    // Null/false/empty diagnostic fields are ordinary successful receipt shape.
    if (["error", "errors", "warning", "warnings"].includes(key) && (child === null || child === false || Array.isArray(child) && child.length === 0)) return false;
    return diagnosticValue(child);
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

function residualReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  const notices = Array.isArray(receipt.notices) ? receipt.notices : [];
  return {
    ...receipt,
    notices: notices.filter((notice) => notice?.command !== "budget" || !isNonBlockingProofBudgetWarning(notice)),
  };
}

function receiptHasNonBudgetDiagnostic(receipt) {
  const residual = residualReceipt(receipt);
  return residual !== null && diagnosticValue(residual);
}

/** Return only valid budget notices from one uniquely identified P1 receipt. */
export function budgetWarningNotices(output, script) {
  const parsed = parseP1TerminalOutput(output, script);
  if (parsed.receipt === null || parsed.budgetNotices.length === 0) return [];
  if (parsed.budgetNotices.some((notice) => !isNonBlockingProofBudgetWarning(notice))) return [];
  return parsed.budgetNotices;
}

/**
 * Decide whether the generic push-gate warning check may exempt this output.
 * The exemption is deliberately narrow: one P1 terminal receipt, at least one
 * valid budget notice, and no diagnostic in any remaining receipt/output line.
 */
export function onlyBudgetWarning(output, script) {
  const parsed = parseP1TerminalOutput(output, script);
  if (parsed.receipt === null || parsed.budgetNotices.length === 0 || parsed.budgetNotices.some((notice) => !isNonBlockingProofBudgetWarning(notice))) return false;
  if (receiptHasNonBudgetDiagnostic(parsed.receipt)) return false;
  if (parsed.otherJson.some(({ value, line }) => diagnosticValue(value) || diagnosticText(line))) return false;
  if (parsed.nonJson.some((line) => diagnosticText(line))) return false;
  return true;
}

/** Generic diagnostic detection used by the push gate's warning branch. */
export function hasWarningOrError(output, script) {
  if (script !== "verify:p1") return diagnosticText(String(output ?? ""));
  const parsed = parseP1TerminalOutput(output, script);
  if (parsed.terminalReceipts.length !== 1 && parsed.terminalReceipts.some((receipt) => Array.isArray(receipt?.notices) && receipt.notices.some((notice) => notice?.command === "budget"))) return true;
  if (parsed.terminalReceipts.some((receipt) => receiptHasNonBudgetDiagnostic(receipt))) return true;
  if (parsed.otherJson.some(({ value, line }) => diagnosticValue(value) || diagnosticText(line))) return true;
  return parsed.nonJson.some((line) => diagnosticText(line));
}
