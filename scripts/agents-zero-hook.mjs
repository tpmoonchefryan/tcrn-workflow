#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-331 — re-inject the platform output contract on every prompt.
//
// AGENTS.md is the authority. This hook deliberately reads the file at fire time;
// it does not carry a second copy of section zero in source, settings, or a
// generated artifact. Any failure is fail-open so a missing constraint helper
// cannot prevent the host from accepting a prompt.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_CONTAINER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const AGENTS_FILE_NAME = "AGENTS.md";
export const ZERO_SECTION_HEADING = "## 零、输出行文（硬约束）";
export const OWNER_CONTRACT_RELATIVE_PATH = "platform-docs/owner-output-contract.md";
const OWNER_CONTRACT_FILE_NAME = "owner-output-contract.md";
export const OWNER_AUDIENCE = "owner";
export const OWNER_ON_DEMAND_EVENTS = Object.freeze(["UserPromptSubmit"]);
export const OWNER_ON_DEMAND_PURPOSES = Object.freeze(["owner-output", "owner-review", "owner-response", "owner-facing", "presentation"]);

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
  const event = typeof input?.hook_event_name === "string" ? input.hook_event_name : input?.hookEventName;
  if (["owner", "owner-facing", "owner_facing", "owner-facing-output"].includes(normalized) && OWNER_ON_DEMAND_EVENTS.includes(event)) return OWNER_AUDIENCE;
  if (["internal", "internal-subagent", "subagent", "main-orchestrator", "acceptance"].includes(normalized)) return "internal";
  return "unknown";
}

export const resolveAudience = audienceValue;

function ownerRequest(input = {}) {
  const request = input?.ownerRequest ?? input?.owner_request ?? input?.contextRequest ?? input?.context_request ?? input?.request;
  const purpose = typeof request === "object" && request !== null
    ? request.purpose ?? request.reason ?? request.kind
    : input?.purpose ?? input?.ownerPurpose ?? input?.owner_purpose;
  const explicit = request === true || typeof request === "string" && request.trim().length > 0 || request && typeof request === "object";
  return { explicit, purpose: typeof purpose === "string" ? purpose.trim().toLowerCase() : "" };
}

/** Owner prose is loaded only for an explicit, bounded host request. */
export function shouldLoadOwnerContract(input = {}) {
  const event = typeof input?.hook_event_name === "string" ? input.hook_event_name : input?.hookEventName;
  const request = ownerRequest(input);
  return audienceValue(input) === OWNER_AUDIENCE
    && OWNER_ON_DEMAND_EVENTS.includes(event)
    && request.explicit
    && OWNER_ON_DEMAND_PURPOSES.includes(request.purpose);
}

/** Resolve the Owner contract through a pointer in the resident index. */
export function readOwnerOutputContract(root = containerRoot()) {
  const missing = (path = OWNER_CONTRACT_RELATIVE_PATH, reasonCode = "OWNER_OUTPUT_POINTER_MISSING") => ({
    ok: false,
    reasonCode,
    path,
    text: "",
  });
  const pointerCandidates = (index) => {
    const candidates = new Map();
    let malformed = false;
    const add = (value) => {
      if (typeof value !== "string" || value.length === 0) return;
      const relativePath = value.replace(/^\.\//u, "");
      if (relativePath === OWNER_CONTRACT_RELATIVE_PATH && !isAbsolute(value)) {
        candidates.set(`root-relative:${relativePath}`, { path: relativePath, absolute: false });
      } else if (isAbsolute(value)) {
        candidates.set(`absolute:${value}`, { path: value, absolute: true });
      }
    };
    const inspect = (fragment) => {
      const marker = fragment.includes(OWNER_CONTRACT_RELATIVE_PATH)
        ? OWNER_CONTRACT_RELATIVE_PATH
        : fragment.includes(OWNER_CONTRACT_FILE_NAME) ? OWNER_CONTRACT_FILE_NAME : null;
      if (marker === null) return;
      const end = fragment.indexOf(marker);
      if (end < 0) return;
      const candidate = fragment.slice(0, end + marker.length)
        .replace(/^[=:]+/u, "")
        .replace(/[.,;!?]+$/u, "");
      add(candidate);
      const normalized = candidate.replace(/^\.\//u, "");
      if (marker === OWNER_CONTRACT_FILE_NAME && normalized !== OWNER_CONTRACT_RELATIVE_PATH && !isAbsolute(candidate)) malformed = true;
    };
    for (const line of index.split(/\r?\n/u)) {
      if (!line.includes(OWNER_CONTRACT_RELATIVE_PATH) && !line.includes(OWNER_CONTRACT_FILE_NAME)) continue;
      // A pointer is a path-shaped value, not arbitrary prose. Prefer quoted
      // or code-span fragments, then inspect the whitespace-delimited form.
      for (const match of line.matchAll(/`([^`]*?)`|"([^"]*?)"|'([^']*?)'/gu)) {
        inspect(match[1] ?? match[2] ?? match[3] ?? "");
      }
      for (const token of line.split(/[\s`"'()[\]{}<>|]+/u)) inspect(token);
    }
    return { candidates: [...candidates.values()], malformed };
  };
  try {
    const indexPath = resolve(root, AGENTS_FILE_NAME);
    const index = readFileSync(indexPath, "utf8");
    const lines = index.split(/\r?\n/u);
    const mentions = lines.filter((line) => line.includes(OWNER_CONTRACT_RELATIVE_PATH) || line.includes(OWNER_CONTRACT_FILE_NAME));
    if (mentions.length === 0) return missing();
    const parsed = pointerCandidates(index);
    const candidates = parsed.candidates;
    if (parsed.malformed || candidates.length === 0) return missing(OWNER_CONTRACT_RELATIVE_PATH, "OWNER_OUTPUT_POINTER_INVALID");
    if (candidates.length !== 1) return missing(OWNER_CONTRACT_RELATIVE_PATH, "OWNER_OUTPUT_POINTER_AMBIGUOUS");
    const pointer = candidates[0];
    const absolute = pointer.absolute ? resolve(pointer.path) : resolve(root, pointer.path);
    let text;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      return missing(absolute, "OWNER_OUTPUT_POINTER_BROKEN");
    }
    return text.length > 0 ? { ok: true, reasonCode: "OWNER_OUTPUT_CONTRACT_READY", path: absolute, text } : missing(absolute, "OWNER_OUTPUT_POINTER_BROKEN");
  } catch {
    return missing();
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
  const requestedOwnerContract = shouldLoadOwnerContract(input);
  const contract = requestedOwnerContract ? readOwnerOutputContract(resolvedRoot) : null;
  // A legacy heading remains readable for old fixtures only. Production's
  // resident index has no Owner section and internal/unknown audiences never
  // receive the Owner contract.
  const section = requestedOwnerContract && contract?.ok === true
    ? `[Owner-facing output contract · on-demand]\n${contract.text.trim()}`
    : audience === "missing" || audience === "internal" || audience === "unknown" ? readZeroSection(resolvedRoot)
      : null;
  const legacySection = audience === "missing" ? section : null;
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: section === null || audience === "internal" || audience === "unknown" || requestedOwnerContract === false && audience === OWNER_AUDIENCE ? "" : contract?.ok === true ? section : legacySection === null ? "" : `[平台约束重注入 · AGENTS.md §零]\n${legacySection}`,
    },
    ...(requestedOwnerContract && contract?.ok !== true ? { reasonCode: contract?.reasonCode ?? "OWNER_OUTPUT_POINTER_MISSING" } : {}),
  };
}

export function buildHookResponseWithAudienceEvidence(input = {}, { root } = {}) {
  const response = buildHookResponse(input, { root });
  const audience = audienceValue(input);
  return {
    response,
    audience,
    ownerContract: audience === OWNER_AUDIENCE && shouldLoadOwnerContract(input) ? readOwnerOutputContract(root ?? containerRoot()) : { ok: false, reasonCode: "OWNER_OUTPUT_ON_DEMAND_NOT_REQUESTED" },
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
