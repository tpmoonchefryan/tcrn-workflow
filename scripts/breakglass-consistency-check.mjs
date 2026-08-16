#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-019 INC-055 — break-glass allowlist consistency gate.
//
//   node tcrn-workflow/scripts/breakglass-consistency-check.mjs
//
// The SSH break-glass allowlist in scripts/policy/ssh-breakglass-allowlist.json is this
// repository's own, and this gate judges it on its own terms: present, parseable, and
// carrying the shape the observer reads.
//
// It used to diff that file against a copy in a sibling product project, which was
// declared the authority — so the engine repository read another project in order to
// validate itself, the dependency direction the platform forbids (TCRN-CROSS-INC-214).
// A cross-repository consistency check is still a reasonable thing to want; it belongs
// on the other side, where reading this repository is the permitted direction.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const WF_MIRROR = resolve(PLATFORM_ROOT, "tcrn-workflow/scripts/policy/ssh-breakglass-allowlist.json");

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");
}

export function checkConsistency() {
  const problems = [];
  if (!existsSync(WF_MIRROR)) {
    return {
      ok: false,
      reasonCode: "WF_MIRROR_MISSING",
      problems: ["WF mirror missing: scripts/policy/ssh-breakglass-allowlist.json"],
      wfSha: null,
      aosSha: null
    };
  }
  const wfSha = sha256(WF_MIRROR);
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(WF_MIRROR, "utf8"));
  } catch (error) {
    problems.push(`allowlist is not parseable JSON: ${String(error?.message ?? error)}`);
  }
  if (parsed !== null) {
    if (parsed.schemaVersion !== "tcrn.ssh-breakglass-allowlist.v1") problems.push("allowlist schemaVersion is not the shape the observer reads");
    if (!Array.isArray(parsed.entries)) problems.push("allowlist has no entries array");
    if (!Array.isArray(parsed.classes)) problems.push("allowlist has no classes array");
  }
  return {
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? "BREAKGLASS_ALLOWLIST_WELL_FORMED" : "BREAKGLASS_ALLOWLIST_MALFORMED",
    problems,
    wfSha
  };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1]?.endsWith("breakglass-consistency-check.mjs")) {
  const result = checkConsistency();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  for (const p of result.problems) process.stderr.write(`  PROBLEM: ${p}\n`);
  if (!result.ok) process.exitCode = 1;
}
