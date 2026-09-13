#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-331 — re-inject the platform output contract on every prompt.
//
// AGENTS.md is the authority. This hook deliberately reads the file at fire time;
// it does not carry a second copy of section zero in source, settings, or a
// generated artifact. Any failure is fail-open so a missing constraint helper
// cannot prevent the host from accepting a prompt.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_CONTAINER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const AGENTS_FILE_NAME = "AGENTS.md";
export const ZERO_SECTION_HEADING = "## 零、输出行文（硬约束）";
export const OWNER_CONTRACT_RELATIVE_PATH = "platform-docs/owner-output-contract.md";
export const OWNER_AUDIENCE = "owner";

function containerRoot() {
  const supplied = process.env.CLAUDE_PROJECT_DIR;
  return typeof supplied === "string" && supplied.length > 0 ? resolve(supplied) : DEFAULT_CONTAINER_ROOT;
}

export function readZeroSection(root = containerRoot()) {
  try {
    const document = readFileSync(resolve(root, AGENTS_FILE_NAME), "utf8");
    const start = document.indexOf(`${ZERO_SECTION_HEADING}\n`);
    if (start < 0) return null;
    const bodyStart = start + ZERO_SECTION_HEADING.length;
    const remainder = document.slice(bodyStart);
    const nextHeading = remainder.search(/^##\s/mu);
    const section = nextHeading < 0 ? document.slice(start) : document.slice(start, bodyStart + nextHeading);
    return section.trim() || null;
  } catch {
    return null;
  }
}

function audienceValue(input = {}) {
  const value = input?.audience ?? input?.outputAudience ?? input?.targetAudience ?? input?.binding?.audience ?? input?.context?.audience;
  if (typeof value !== "string" || value.trim().length === 0) return "missing";
  const normalized = value.trim().toLowerCase();
  if (["owner", "owner-facing", "owner_facing", "owner-facing-output"].includes(normalized)) return OWNER_AUDIENCE;
  if (["internal", "internal-subagent", "subagent", "main-orchestrator", "acceptance"].includes(normalized)) return "internal";
  return "unknown";
}

export const resolveAudience = audienceValue;

/** Resolve the Owner contract through a pointer in the resident index. */
export function readOwnerOutputContract(root = containerRoot()) {
  try {
    const indexPath = resolve(root, AGENTS_FILE_NAME);
    const index = readFileSync(indexPath, "utf8");
    const pointer = index.split(/\r?\n/u).find((line) => line.includes(OWNER_CONTRACT_RELATIVE_PATH) || /owner-output-contract\.md/u.test(line));
    if (!pointer) return { ok: false, reasonCode: "OWNER_OUTPUT_POINTER_MISSING", path: OWNER_CONTRACT_RELATIVE_PATH, text: "" };
    const absolute = pointer.includes("/Users/") ? pointer.match(/\/Users\/[^\s)`]+owner-output-contract\.md/u)?.[0] : resolve(root, OWNER_CONTRACT_RELATIVE_PATH);
    if (!absolute) return { ok: false, reasonCode: "OWNER_OUTPUT_POINTER_MISSING", path: OWNER_CONTRACT_RELATIVE_PATH, text: "" };
    const text = readFileSync(absolute, "utf8");
    return text.length > 0 ? { ok: true, reasonCode: "OWNER_OUTPUT_CONTRACT_READY", path: absolute, text } : { ok: false, reasonCode: "OWNER_OUTPUT_POINTER_MISSING", path: absolute, text: "" };
  } catch {
    return { ok: false, reasonCode: "OWNER_OUTPUT_POINTER_MISSING", path: OWNER_CONTRACT_RELATIVE_PATH, text: "" };
  }
}

export function isEnabled() {
  const value = process.env.TCRN_AGENTS_ZERO_INJECTION;
  return value !== "0" && value !== "false" && value !== "off";
}

export function buildHookResponse(input = {}, { root } = {}) {
  const event = typeof input?.hook_event_name === "string" ? input.hook_event_name : "";
  if (!isEnabled()) {
    return { hookSpecificOutput: { hookEventName: event, additionalContext: "" } };
  }
  const resolvedRoot = root ?? containerRoot();
  const audience = audienceValue(input);
  const contract = audience === OWNER_AUDIENCE ? readOwnerOutputContract(resolvedRoot) : null;
  // A legacy heading remains readable for old fixtures only. Production's
  // resident index has no Owner section and internal/unknown audiences never
  // receive the Owner contract.
  const section = audience === OWNER_AUDIENCE && contract?.ok === true
    ? `[Owner-facing output contract · on-demand]\n${contract.text.trim()}`
    : audience === "missing" || audience === "internal" || audience === "unknown" ? readZeroSection(resolvedRoot)
      : null;
  const legacySection = audience === "missing" ? section : null;
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: section === null || audience === "internal" || audience === "unknown" ? "" : contract?.ok === true ? section : legacySection === null ? "" : `[平台约束重注入 · AGENTS.md §零]\n${legacySection}`,
    },
    ...(audience === OWNER_AUDIENCE && contract?.ok !== true ? { reasonCode: contract?.reasonCode ?? "OWNER_OUTPUT_POINTER_MISSING" } : {}),
  };
}

export function buildHookResponseWithAudienceEvidence(input = {}, { root } = {}) {
  const response = buildHookResponse(input, { root });
  const audience = audienceValue(input);
  return {
    response,
    audience,
    ownerContract: audience === OWNER_AUDIENCE ? readOwnerOutputContract(root ?? containerRoot()) : { ok: false, reasonCode: "OWNER_OUTPUT_NOT_APPLICABLE" },
  };
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
    process.stdout.write(`${JSON.stringify(buildHookResponse(readStdin()))}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "", additionalContext: "" } })}\n`);
  }
}
