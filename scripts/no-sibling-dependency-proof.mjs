#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-215 — the dependency-direction gate.
//
//   node tcrn-workflow/scripts/no-sibling-dependency-proof.mjs
//
// This repository never reaches into a sibling project's tree. INC-214 cleared five
// places that did, and every one of them was found by hand — a grep, a judgement, a
// second grep. Nothing stopped the sixth from appearing, and this platform has already
// learned twice over that a rule nobody can run is a rule nobody keeps: the s197 gate was
// never committed and stayed red for four days unseen; engine-pin was red with no
// observers at all.
//
// What counts as reaching in is READING or EXECUTING, not naming. Three shapes name a
// sibling and are not dependencies, so the gate must not fire on them:
//
//   - a provenance citation — the story-rule registry records which sibling document a
//     rule came from, but only ever compares strings. Deleting those citations would
//     falsify where the rules came from;
//   - a classified sample — the SSH observer's corpus holds command strings naming
//     sibling paths, and its whole job is to classify such commands, not run them;
//   - a generic tool aimed at a directory — `codegraph serve --path <sibling>` runs this
//     platform's own binary; an absent sibling leaves a dead entry, not a broken
//     dependency.
//
// So the predicate is: does a path that resolves INTO a sibling tree reach a filesystem
// read or a process spawn. The test for whether something is a dependency is whether this
// repository behaves differently when the other one is absent
// (`TCRN-CROSS-MIN-INTEGRATION-BOUNDARY`).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLATFORM_ROOT = resolve(REPO_ROOT, "..");

/** Directories scanned. Source only: docs and reports cite freely, and should. */
export const SCANNED_ROOTS = Object.freeze(["scripts", "packages", "portal", "tools"]);
export const SCANNED_EXTENSIONS = Object.freeze([".mjs", ".js", ".ts", ".tsx"]);

/**
 * Sibling projects, discovered rather than listed.
 *
 * A typed roster is a second copy of a fact the filesystem already holds, and it goes
 * stale exactly when it matters — the moment a new sibling is admitted. This is the same
 * defect this platform hit three times in one week with hand-copied partition rosters.
 *
 * `self` is read off the repository root rather than written down (TCRN-CROSS-INC-218).
 * It used to be the constant `"tcrn-workflow"`, which is only this checkout's directory
 * name: `pnpm preflight` clones into `<temp>/checkout`, so inside the one world that
 * proves independence from siblings, this repository counted itself as its own sibling.
 * A constant paired with a name the tree is free to change is exactly the shape the
 * gate-reference-stability convention refuses.
 */
export function siblingProjects(platformRoot = PLATFORM_ROOT, self = basename(REPO_ROOT)) {
  return readdirSync(platformRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => name !== self && name !== "docs" && name !== "var" && name !== "tmp")
    .sort();
}

/**
 * The two operations that make a mention into a dependency.
 *
 * Matched on the same line as the sibling name: a read or a spawn whose argument carries
 * the name. Kept deliberately narrow — a broad "any mention" rule would fire on the three
 * legitimate shapes above and be muted within a week, which is how a gate dies.
 */
const REACHING_OPERATIONS = Object.freeze([
  { id: "filesystem-read", pattern: /\b(?:readFileSync|readFile|createReadStream|existsSync|statSync|lstatSync|readdirSync|readdir|import\s*\()/u },
  { id: "process-spawn", pattern: /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\b/u },
]);

function scannableFiles(root) {
  const found = [];
  const walk = (directory) => {
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
        walk(path);
        continue;
      }
      if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Every line that both names a sibling and performs a reaching operation.
 *
 * The file list is injectable alongside the reader, so the red legs can be exercised on
 * a synthetic source without a repository on disk. Injecting only the reader is not
 * enough — the walk would find nothing and every red would pass by scanning zero files,
 * which is the shape of a gate that is green because it looked nowhere.
 */
export function findReachingLines({
  repoRoot = REPO_ROOT,
  siblings = siblingProjects(),
  read = readFileSync,
  files = null,
} = {}) {
  const findings = [];
  const roots = files === null
    ? SCANNED_ROOTS.map((rootName) => scannableFiles(join(repoRoot, rootName)))
    : [files];
  for (const paths of roots) {
    for (const path of paths) {
      let text = "";
      try { text = read(path, "utf8"); } catch { continue; }
      text.split("\n").forEach((line, index) => {
        // A comment explaining the rule is not the rule being broken. This gate has to be
        // sayable in its own source, and in the convention that describes it.
        const code = line.replace(/\/\/.*$/u, "");
        if (/^\s*\*|^\s*\/\*/u.test(line)) return;
        const named = siblings.find((sibling) => code.includes(sibling));
        if (named === undefined) return;
        const operation = REACHING_OPERATIONS.find((candidate) => candidate.pattern.test(code));
        if (operation === undefined) return;
        findings.push({
          file: relative(repoRoot, path),
          line: index + 1,
          sibling: named,
          operation: operation.id,
          sample: code.trim().slice(0, 120),
        });
      });
    }
  }
  return findings;
}

export function judgeNoSiblingDependency(options = {}) {
  const siblings = options.siblings ?? siblingProjects();
  const findings = options.findings ?? findReachingLines({ ...options, siblings });
  return {
    schemaVersion: "tcrn.no-sibling-dependency.v1",
    ok: findings.length === 0,
    reasonCode: findings.length === 0 ? "NO_SIBLING_DEPENDENCY" : "SIBLING_DEPENDENCY_PRESENT",
    siblings,
    scannedRoots: [...SCANNED_ROOTS],
    findings,
  };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href
  || process.argv[1]?.endsWith("no-sibling-dependency-proof.mjs")) {
  const result = judgeNoSiblingDependency();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  for (const finding of result.findings) {
    process.stderr.write(`  REACHES IN: ${finding.file}:${finding.line} → ${finding.sibling} (${finding.operation})\n    ${finding.sample}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}
