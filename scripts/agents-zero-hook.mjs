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

export function isEnabled() {
  const value = process.env.TCRN_AGENTS_ZERO_INJECTION;
  return value !== "0" && value !== "false" && value !== "off";
}

export function buildHookResponse(input = {}, { root } = {}) {
  const event = typeof input?.hook_event_name === "string" ? input.hook_event_name : "";
  if (!isEnabled()) {
    return { hookSpecificOutput: { hookEventName: event, additionalContext: "" } };
  }
  const section = readZeroSection(root ?? containerRoot());
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: section === null ? "" : `[平台约束重注入 · AGENTS.md §零]\n${section}`,
    },
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
