#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-332 — fail-open Stop checks for the platform output contract.
//
// The transcript reader is shared with the existing stop-pact mode reader. This
// hook only judges the three lexical rules that can be checked without a model;
// it never writes a pact and never makes a session impossible to stop.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveLastAssistantText } from "./mode.mjs";

const VOCABULARY_PATH = new URL("./agents-zero-vocabulary.json", import.meta.url);
const CJK = /[一-鿿]/gu;
const FENCE = /^\s*(```|~~~)/u;
const HEADING = /^\s*#{1,6}\s+/u;
const TABLE_ROW = /^\s*(?:\|.*\||[^|\n]+\|[^|\n]+)\s*$/u;
const COMPARISON_WORD = /对比|相比|相较|差异|区别|不同|优于|低于|高于|多于|少于|大于|小于|而不是|代替|替代|前者|后者|\b(?:vs|versus|compared?|difference|instead|rather than|than)\b/iu;

function readVocabulary() {
  try {
    const value = JSON.parse(readFileSync(VOCABULARY_PATH, "utf8"));
    if (Array.isArray(value?.terms)) return value.terms.filter((term) => typeof term === "string" && term.length > 0);
  } catch {
    // The caller remains fail-open. The built-in list keeps a malformed optional
    // vocabulary file from silently disabling the check entirely.
  }
  return ["门税", "安全阀", "熔断", "隐身", "必炸", "装饰", "兜底", "天花板", "挤掉", "拉走", "浮的", "声音"];
}

function removeInlineCode(line) {
  return line.replace(/`[^`\n]*`/gu, "");
}

function removeQuotedText(line) {
  return line
    .replace(/"[^"\n]*"/gu, "")
    .replace(/'[^'\n]*'/gu, "")
    .replace(/“[^”\n]*”/gu, "")
    .replace(/‘[^’\n]*’/gu, "")
    .replace(/「[^」\n]*」/gu, "")
    .replace(/『[^』\n]*』/gu, "")
    .replace(/《[^》\n]*》/gu, "");
}

function maskedLines(text, { removeQuotes = false } = {}) {
  const lines = String(text ?? "").split(/\r?\n/u);
  const output = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      output.push("");
      continue;
    }
    if (inFence || TABLE_ROW.test(line) || HEADING.test(line)) {
      output.push("");
      continue;
    }
    let visible = removeInlineCode(line);
    if (removeQuotes) visible = removeQuotedText(visible);
    output.push(visible);
  }
  return output;
}

function cjkCount(text) {
  return (String(text ?? "").match(CJK) ?? []).length;
}

function rule7(text) {
  const visible = maskedLines(text).join("\n");
  const count = cjkCount(visible);
  return count > 400 ? { rule: 7, cjkCharacters: count, message: `规则 7：散文含 ${count} 个 CJK 字符，超过 400 字上限` } : null;
}

function rule3(text, vocabulary) {
  const visible = maskedLines(text, { removeQuotes: true }).join("\n");
  const terms = vocabulary.filter((term) => visible.includes(term));
  return terms.length === 0 ? null : { rule: 3, terms, message: `规则 3：散文使用造词：${terms.join("、")}` };
}

function rule5(text) {
  const original = String(text ?? "").split(/\r?\n/u);
  const visible = maskedLines(text);
  for (let index = 0; index < visible.length; index += 1) {
    const line = visible[index] ?? "";
    if (!line || !COMPARISON_WORD.test(line)) continue;
    let hasNearbyTable = false;
    for (let nearby = Math.max(0, index - 2); nearby <= Math.min(original.length - 1, index + 2); nearby += 1) {
      if (TABLE_ROW.test(original[nearby] ?? "")) {
        hasNearbyTable = true;
        break;
      }
    }
    if (!hasNearbyTable) {
      return { rule: 5, line: index + 1, message: `规则 5：散文第 ${index + 1} 行出现对比词，但邻近没有表格` };
    }
  }
  return null;
}

export function checkResponseText(text, { vocabulary = readVocabulary() } = {}) {
  const violations = [rule7(text), rule3(text, vocabulary), rule5(text)].filter(Boolean);
  return {
    ok: violations.length === 0,
    violations,
    metrics: { cjkCharacters: cjkCount(maskedLines(text).join("\n")) },
  };
}

export function responseStyleReason(result) {
  return result.violations.map((violation) => `[AGENTS.md §零规则 ${violation.rule}] ${violation.message}`).join("\n");
}

export function inspectTranscript(input) {
  if (input?.stop_hook_active === true) return { ok: true, skipped: true, text: "" };
  const path = typeof input?.transcript_path === "string" ? input.transcript_path : "";
  const text = resolveLastAssistantText(path);
  return text === null ? { ok: true, skipped: true, text: "" } : { ok: true, skipped: false, text };
}

export function checkStopInput(input) {
  const inspected = inspectTranscript(input);
  if (inspected.skipped) return { ok: true, skipped: true, violations: [] };
  return checkResponseText(inspected.text);
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = checkStopInput(readStdin());
    if (!result.ok) process.stdout.write(`${JSON.stringify({ decision: "block", reason: responseStyleReason(result) })}\n`);
  } catch {
    // Stop checks are advisory enforcement. Any failure is explicitly fail-open.
    process.exitCode = 0;
  }
}
