#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-220 — the Codex stand-in for Claude Code's permissions.deny.
//
// Only the engine may write inside a control tree. Claude Code states that declaratively
// in `permissions.deny`, which needs no process and cannot be defeated by a handler that
// crashes. Codex has no such list, so the same refusal has to be a PreToolUse hook, and a
// hook is a weaker instrument in two ways worth naming rather than glossing:
//
//   - a hook that fails is reported and the operation PROCEEDS (both hosts document this),
//     so a crash here is a hole a deny rule would not have had. The guard is therefore
//     written to have nothing in it that can throw: no imports beyond node builtins, no
//     filesystem access, no parsing beyond the payload itself;
//   - Codex fires PreToolUse for Bash, apply_patch (Edit/Write matchers), MCP tools and
//     local function tools, but not for hosted tools. That gap is real. It is recorded in
//     the harness roster instead of being papered over here.
//
// Bash is deliberately NOT this guard's business. Shell commands go to the SSH write
// observer, which understands them; a path-substring rule applied to shell would refuse
// the engine's own invocations, since every governed read names the workspace it reads.

import { readFileSync } from "node:fs";

export const GUARDED_SEGMENTS = Object.freeze([".tcrn-workspace", ".tcrn-workflow"]);
export const GUARDED_TOOLS = Object.freeze(["Edit", "Write", "NotebookEdit", "apply_patch"]);

/** Every string reachable in a tool input, however the host nests it. */
export function stringsIn(value, depth = 0) {
  if (depth > 8) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((item) => stringsIn(item, depth + 1));
  }
  return [];
}

/**
 * The refusal decision for one hook payload.
 *
 * Scanning every string rather than a known field is deliberate: `apply_patch` carries its
 * targets inside patch text, and its exact schema is the host's to change. A rule bound to
 * `tool_input.file_path` would read as coverage while missing the tool that most needs it.
 */
export function guardDecision(input) {
  const toolName = typeof input?.tool_name === "string" ? input.tool_name : "";
  if (!GUARDED_TOOLS.includes(toolName)) return { deny: false, reason: null, tool: toolName };
  const hits = stringsIn(input?.tool_input)
    .flatMap((text) => GUARDED_SEGMENTS.filter((segment) => text.includes(segment)));
  if (hits.length === 0) return { deny: false, reason: null, tool: toolName };
  const unique = [...new Set(hits)].sort();
  return {
    deny: true,
    tool: toolName,
    trees: unique,
    reason: `${toolName} targets a governed control tree (${unique.join(", ")}). Only the engine may write there: use the tcrn-workflow CLI, read the current version immediately before the write, and read the receipt back.`,
  };
}

/** The host response object. Both hosts document this exact shape for PreToolUse. */
export function responseFor(decision) {
  if (!decision.deny) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  };
}

if (process.argv[1]?.endsWith("chain-write-guard.mjs")) {
  let payload = {};
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // A payload this guard cannot read is not a write it can refuse. Exit clean rather
    // than block the host on a parsing difference.
    process.exit(0);
  }
  let response = null;
  try {
    response = responseFor(guardDecision(payload));
  } catch {
    process.exit(0);
  }
  if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exit(0);
}
