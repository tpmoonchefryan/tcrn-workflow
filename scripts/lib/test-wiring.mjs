// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-020 INC-079 — test wiring. A test that no pipeline ever executes
// is a gate whose lifetime equals the day it was written. Shared by:
//   - scripts/test-wiring-proof.mjs (the standalone gate, wired into CI);
//   - scripts/task.mjs verify:map (INC-078: an ADR criterion whose named gate test
//     is orphaned is a criterion with no machine red leg).
//
// A test file is "wired" when a pipeline glob covers it (the root tests/ glob) or
// the wiring registry names its owner with a dated reason (the parity / ssh-breakglass
// allowlist shape — directed, dated, cannot silently widen).

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export const COVERED_PREFIXES = ["tests/"];

function walkTestFiles(dir, out = [], root = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTestFiles(full, out, root);
    else if (entry.isFile() && (entry.name.endsWith(".test.mjs") || (full.split("/").includes("test") && entry.name.endsWith(".mjs")))) {
      out.push(relative(root, full));
    }
  }
  return out;
}

export function judgeTestWiring({ repoRoot, registryPath } = {}) {
  const problems = [];
  const scanned = [];
  let workflow = "";
  try {
    workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  } catch (error) {
    problems.push(`.github/workflows/ci.yml: unreadable (${String(error?.message ?? error)})`);
  }
  for (const base of ["tests", "packages", "scripts"]) {
    scanned.push(...walkTestFiles(join(repoRoot, base), [], join(repoRoot, base))
      .map((path) => `${base}/${path}`));
  }
  const covered = scanned.filter((path) => COVERED_PREFIXES.some((prefix) => path.startsWith(prefix)));
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (error) {
    return { ok: false, reasonCode: "TEST_WIRING_REGISTRY_UNREADABLE", error: String(error?.message ?? error), scanned: scanned.length };
  }
  const registered = new Map((registry.entries ?? []).map((entry) => [entry.path, entry]));
  const orphaned = [];
  for (const path of scanned.sort()) {
    if (covered.includes(path)) continue;
    const entry = registered.get(path);
    if (entry === undefined) {
      orphaned.push(path);
      continue;
    }
    if (typeof entry.owner !== "string" || entry.owner.length === 0) {
      problems.push(`${path}: registry entry names no owner`);
    }
    if (typeof entry.since !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.since)) {
      problems.push(`${path}: registry entry has no dated reason`);
    }
    if (typeof entry.reason !== "string" || entry.reason.length === 0) {
      problems.push(`${path}: registry entry has no reason`);
    }
    // Every registry entry must name an executable owner. The previous code
    // only validated owners that happened to begin with github-action: and
    // silently accepted any other prefix.
    const owner = entry.owner ?? "";
    const action = /^github-action:([A-Za-z0-9_-]+)(?:\s|$)/u.exec(owner);
    if (action === null) {
      problems.push(`${path}: owner must use the github-action:<job> prefix`);
      continue;
    }
    const marker = `\n  ${action[1]}:\n`;
    const start = workflow.indexOf(marker);
    const nextJob = start < 0 ? -1 : workflow.slice(start + marker.length).search(/\n  [A-Za-z0-9_-]+:\n/u);
    const block = start < 0
      ? ""
      : workflow.slice(start, nextJob < 0 ? undefined : start + marker.length + nextJob);
    if (start < 0) {
      problems.push(`${path}: owner ${action[1]} is not a job in .github/workflows/ci.yml`);
    } else if (!block.includes("node --test") || !block.includes("packages/pg-backend/test/*.test.mjs") || (!path.endsWith(".test.mjs") && !block.includes(path))) {
      problems.push(`${path}: owner ${action[1]} does not execute the declared PG test glob in CI`);
    }
  }
  const scannedSet = new Set(scanned);
  for (const entry of registry.entries ?? []) {
    if (typeof entry.path !== "string" || !scannedSet.has(entry.path)) {
      problems.push(`${entry.path ?? "<missing>"}: registry entry names a test file that does not exist`);
    }
  }
  return {
    ok: problems.length === 0 && orphaned.length === 0,
    reasonCode: problems.length === 0 && orphaned.length === 0 ? "TEST_WIRING_VERIFIED" : "TEST_WIRING_UNWIRED",
    scanned: scanned.length,
    coveredByPipeline: covered.length,
    registered: registered.size,
    orphaned,
    problems,
  };
}
