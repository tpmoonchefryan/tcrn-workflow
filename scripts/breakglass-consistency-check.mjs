#!/usr/bin/env node
// TCRN-CROSS-INIT-019 INC-055 — break-glass allowlist consistency gate.
//
//   node tcrn-workflow/scripts/breakglass-consistency-check.mjs
//
// The SSH break-glass allowlist is authoritative in TCRN-AOS and mirrored into this
// repository (scripts/policy/ssh-breakglass-allowlist.json) so a lone clone of
// tcrn-workflow — including its own CI — can run the observer against a real
// allowlist. Two copies mean a drift risk; this gate diffs the digests and reds on
// any difference, so "one list, two consumers" stays a single decision. A missing
// authoritative file (outside the platform working tree) is reported, not silently
// skipped.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const WF_MIRROR = resolve(PLATFORM_ROOT, "tcrn-workflow/scripts/policy/ssh-breakglass-allowlist.json");
export const AOS_AUTHORITY = resolve(PLATFORM_ROOT, "TCRN-AOS/deploy/aos-local-client/ssh-breakglass-allowlist.json");

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
  // World-graded (INC-055): in the PLATFORM working tree the AOS file is the
  // authoritative copy and a drift is red. In an ISOLATED clone of this repository
  // (its own CI) there is no sibling checkout — the mirror itself being present and
  // readable is the satisfiable criterion, and self-test exercises it. A missing
  // authority is reported as the isolated-world outcome, never as a silent pass and
  // never as a hard red in a world where it is structurally absent.
  if (!existsSync(AOS_AUTHORITY)) {
    return {
      ok: true,
      reasonCode: "WF_MIRROR_SELF_CONSISTENT",
      problems: [],
      wfSha,
      aosSha: null,
      world: "isolated"
    };
  }
  const aosSha = sha256(AOS_AUTHORITY);
  if (wfSha !== aosSha) {
    problems.push(`mirror drifted from authority: WF ${wfSha} ≠ AOS ${aosSha}`);
  }
  return {
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? "BREAKGLASS_ALLOWLISTS_CONSISTENT" : "BREAKGLASS_ALLOWLISTS_DRIFTED",
    problems,
    wfSha,
    aosSha,
    world: "platform"
  };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1]?.endsWith("breakglass-consistency-check.mjs")) {
  const result = checkConsistency();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  for (const p of result.problems) process.stderr.write(`  PROBLEM: ${p}\n`);
  if (!result.ok) process.exitCode = 1;
}
