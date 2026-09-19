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
// What counts as reaching in is READING or EXECUTING, not naming. Four shapes name a
// sibling and are not dependencies, so the gate must not fire on them:
//
//   - a provenance citation — the story-rule registry records which sibling document a
//     rule came from, but only ever compares strings. Deleting those citations would
//     falsify where the rules came from;
//   - a classified sample — the SSH observer's corpus holds command strings naming
//     sibling paths, and its whole job is to classify such commands, not run them;
//   - a generic tool aimed at a directory — `codegraph serve --path <sibling>` runs this
//     platform's own binary; an absent sibling leaves a dead entry, not a broken
//     dependency;
//   - the gate's own test file — `tests/no-sibling-dependency.test.mjs` contains synthetic
//     violation samples to exercise the gate's red legs. A gate that fires on its own test
//     fixtures gets muted within a week, and a muted gate is worth less than no gate
//     because it still looks like coverage.
//
// So the predicate is: does a path that resolves INTO a sibling tree reach a filesystem
// read or a process spawn. The test for whether something is a dependency is whether this
// repository behaves differently when the other one is absent
// (`TCRN-CROSS-MIN-INTEGRATION-BOUNDARY`).
//
// COVERAGE LIMITATION: This gate detects patterns on a single line only. It cannot flag
// violations where the sibling name and reaching operation span multiple lines (e.g.,
// const path = resolve(PLATFORM_ROOT, "TCRN-AOS/file.json") on line N, then readFile(path)
// on line M). Four test files contain such multi-line patterns and are addressed by a
// separate dispatch: tests/story-338-339-archive-inventory.test.mjs,
// tests/inc258-install-manifest.test.mjs, tests/inc259-storage-migration.test.mjs,
// tests/inc260-snapshot-read-optimization.test.mjs.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertInstallManifestComplete, readInstallManifest } from "../dist/build/packages/core/src/index.js";
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLATFORM_ROOT = resolve(REPO_ROOT, "..");

/** Directories scanned. Source only: docs and reports cite freely, and should. */
export const SCANNED_ROOTS = Object.freeze(["scripts", "packages", "portal", "tools", "tests"]);
export const SCANNED_EXTENSIONS = Object.freeze([".mjs", ".js", ".ts", ".tsx"]);

export class SiblingDependencyInputError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SiblingDependencyInputError";
    this.reasonCode = "SIBLING_DEPENDENCY_NOT_VERIFIABLE";
    this.details = details;
  }
}

const HELPER_SKILL_PROBE = "probe:helper-skill-digest;source=trusted-archive-state;archive=skill-archive.json;state=state.json;entry=SKILL.md";

function ownPackageIdentity(repoRoot) {
  try {
    const document = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    if (document === null || typeof document !== "object" || typeof document.name !== "string" || document.name.length === 0) {
      throw new Error("package name is missing");
    }
    return document.name;
  } catch (error) {
    throw new SiblingDependencyInputError(`repository identity is not readable: ${String(error?.message ?? error)}`);
  }
}

/**
 * Resolve the canonical sibling roster from the validated install manifest.
 *
 * The manifest is the installation-surface authority; no directory beside the checkout
 * is inspected. The Helper is represented by the three manifest skill entries, whose
 * identical canonical path suffix is the only accepted Helper identity.
 */
export function canonicalSiblingRoster({ repoRoot = REPO_ROOT, manifest, manifestReader = readInstallManifest } = {}) {
  let resolvedManifest;
  try {
    resolvedManifest = manifest ?? manifestReader();
    assertInstallManifestComplete(resolvedManifest);
  } catch (error) {
    if (error?.reasonCode === "SIBLING_DEPENDENCY_NOT_VERIFIABLE") throw error;
    throw new SiblingDependencyInputError(`validated install-manifest unavailable: ${String(error?.message ?? error)}`);
  }
  const projects = resolvedManifest.projects;
  const projectNames = projects.map((project) => {
    if (project === null || typeof project !== "object" || typeof project.name !== "string" || project.name.length === 0 || typeof project.pathTemplate !== "string") {
      throw new SiblingDependencyInputError("install-manifest project roster is incomplete");
    }
    if (!project.pathTemplate.includes("<PLATFORM_ROOT>")) throw new SiblingDependencyInputError(`project ${project.name} has no canonical platform-root path`);
    return project.name;
  });
  if (new Set(projectNames).size !== projectNames.length) throw new SiblingDependencyInputError("install-manifest project roster is ambiguous");

  const self = ownPackageIdentity(repoRoot);
  if (!projectNames.includes(self)) throw new SiblingDependencyInputError(`repository identity ${self} is absent from the install-manifest project roster`);

  const helperItems = resolvedManifest.items.filter((item) => item?.acceptanceProbe === HELPER_SKILL_PROBE);
  const helperNames = helperItems.map((item) => {
    const match = /(?:^|\/)tcrn-workflow-helper\/?$/u.exec(item.pathTemplate);
    return match === null ? null : "tcrn-workflow-helper";
  });
  if (helperItems.length !== 3 || helperNames.some((name) => name === null) || new Set(helperNames).size !== 1) {
    throw new SiblingDependencyInputError("install-manifest Helper identity is missing, invalid, or ambiguous");
  }
  const helperIdentity = helperNames[0];
  if (projectNames.includes(helperIdentity)) throw new SiblingDependencyInputError("install-manifest Helper identity collides with a project identity");

  const siblings = [...projectNames, helperIdentity].filter((name) => name !== self).sort();
  return {
    siblings,
    self,
    helperIdentity,
    manifestSource: "validated-install-manifest",
    manifestDigest: canonicalSha256(resolvedManifest),
  };
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
  { id: "process-spawn", pattern: /\b(?:spawn|spawnSync|(?<!\.)exec|execSync|execFile|execFileSync|fork)\b/u },
]);

/**
 * Additional patterns that reference paths outside the repository without mentioning sibling names.
 *
 * These patterns detect references to the platform structure (`.tcrn-workspace`), relative
 * ascent above the repository root, and access to the home directory. Each pattern must be
 * paired with a reaching operation on the same line to be flagged.
 */
const OUTSIDE_REFERENCES = Object.freeze([
  {
    id: "relative-ascent-escape",
    pattern: /(?<!\w)(?:\.\.\s*\/){3,}/u,
    reason: "Three or more consecutive ../ patterns escape above the repository root. This is suspicious in tests because it suggests reaching into sibling directories or the platform container, which may not exist in CI environments. Two or fewer (../../) is normal relative importing within the repository."
  },
  {
    id: "platform-workspace-assembly",
    pattern: /["`'].tcrn["`']\s*,\s*["`']workspace["`']|["`']workspace["`']\s*,\s*["`'].tcrn["`']/u,
    reason: "String fragments '.tcrn' and 'workspace' appear together, indicating assembly of the .tcrn-workspace path via .join() or array literal. This path exists only in the platform container, not in isolated CI environments."
  },
  {
    id: "platform-workspace-direct",
    pattern: /\.tcrn[\s\-_]*workspace/u,
    reason: "Direct reference to .tcrn-workspace, the platform workspace directory. This path exists only in the platform container, not in CI test environments."
  },
  {
    id: "home-environment-reference",
    pattern: /process\.env\.HOME(?!\w)|\$HOME(?!\w)|~\//u,
    reason: "Access to the user's home directory via environment variable or path expansion. Home directory paths are machine-specific and do not exist in standardized CI environments."
  }
]);

function scannableFiles(root, strict = false) {
  const found = [];
  const walk = (directory) => {
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (strict) throw new SiblingDependencyInputError(`scan input is unreadable: ${directory}`, { error: String(error?.message ?? error) });
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
        walk(path);
        continue;
      }
      if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        // Skip the gate's own test file — it contains synthetic violation samples to
        // exercise the red legs. Including it would be a false positive on test fixtures.
        if (entry.name === "no-sibling-dependency.test.mjs") continue;
        found.push(path);
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Check if a code line contains a path rooted at a fixture, temp directory, or
 * locally-constructed value.
 *
 * Such paths are not dependencies because they are synthetic test artifacts created
 * locally within the test, not real reaches into sibling repositories (TCRN-CROSS-INC-274).
 * The predicate must distinguish:
 *   - Rooted at fixture/temp (NOT a reach): join(fixture.home, ...), join(tmpdir(), ...)
 *   - Rooted at repository/platform (IS a reach): resolve(engineRoot, "../.../sibling")
 *
 * Signals of local/fixture roots that should NOT be flagged:
 *   - fixture.* (accessing a test fixture object property)
 *   - mkdtemp(...) (creating a temporary directory)
 *   - tmpdir() (getting the system temp directory)
 */
function hasLocalRoot(code) {
  // If the path is built starting with fixture.something, it's a local test fixture
  // and contains no actual sibling repository dependency.
  if (/\b(?:join|resolve)\s*\(\s*fixture\./.test(code)) {
    return true;
  }

  // If the path involves mkdtemp() or tmpdir(), it's a temporary directory
  // created locally and contains no actual repository dependency.
  if (/(mkdtemp|tmpdir)\s*\(/.test(code)) {
    return true;
  }

  return false;
}

/**
 * Every line that both names a sibling and performs a reaching operation,
 * or references paths outside the repository with a reaching operation.
 *
 * The file list is injectable alongside the reader, so the red legs can be exercised on
 * a synthetic source without a repository on disk. Injecting only the reader is not
 * enough — the walk would find nothing and every red would pass by scanning zero files,
 * which is the shape of a gate that is green because it looked nowhere.
 */
export function findReachingLines({
  repoRoot = REPO_ROOT,
  siblings = [],
  read = readFileSync,
  files = null,
  strict = false,
} = {}) {
  const findings = [];
  const roots = files === null
    ? SCANNED_ROOTS.map((rootName) => scannableFiles(join(repoRoot, rootName), strict))
    : [files];
  for (const paths of roots) {
    for (const path of paths) {
      let text = "";
      try { text = read(path, "utf8"); } catch (error) {
        if (strict) throw new SiblingDependencyInputError(`scan input is unreadable: ${path}`, { error: String(error?.message ?? error) });
        continue;
      }
      text.split("\n").forEach((line, index) => {
        // A comment explaining the rule is not the rule being broken. This gate has to be
        // sayable in its own source, and in the convention that describes it.
        const code = line.replace(/\/\/.*$/u, "");
        if (/^\s*\*|^\s*\/\*/u.test(line)) return;

        // First check: explicit sibling name mentioned
        const named = siblings.find((sibling) => code.includes(sibling));
        if (named !== undefined) {
          // Check if this path is rooted at a fixture or temp directory — TCRN-CROSS-INC-274.
          // Paths rooted at test fixtures do not reach actual sibling repositories even when
          // they contain sibling names in their directory structure, so they must not be flagged.
          if (hasLocalRoot(code)) {
            return;
          }

          const operation = REACHING_OPERATIONS.find((candidate) => candidate.pattern.test(code));
          if (operation !== undefined) {
            findings.push({
              file: relative(repoRoot, path),
              line: index + 1,
              sibling: named,
              operation: operation.id,
              sample: code.trim().slice(0, 120),
            });
          }
          return;
        }

        // Second check: reference to paths outside repository (even without explicit sibling name)
        for (const outside of OUTSIDE_REFERENCES) {
          if (!outside.pattern.test(code)) continue;
          const operation = REACHING_OPERATIONS.find((candidate) => candidate.pattern.test(code));
          if (operation === undefined) continue;
          findings.push({
            file: relative(repoRoot, path),
            line: index + 1,
            sibling: null,
            outsideReference: outside.id,
            operation: operation.id,
            sample: code.trim().slice(0, 120),
          });
          return; // Only flag once per line
        }
      });
    }
  }
  return findings;
}

export function judgeNoSiblingDependency(options = {}) {
  let roster;
  try {
    roster = canonicalSiblingRoster(options);
  } catch (error) {
    return {
      schemaVersion: "tcrn.no-sibling-dependency.v1",
      ok: false,
      comparable: false,
      reasonCode: "SIBLING_DEPENDENCY_NOT_VERIFIABLE",
      error: String(error?.message ?? error),
      source: "validated-install-manifest",
      findings: [],
      scannedRoots: [...SCANNED_ROOTS],
    };
  }
  let findings;
  try {
    findings = options.findings ?? findReachingLines({ ...options, siblings: roster.siblings, strict: true });
  } catch (error) {
    return {
      schemaVersion: "tcrn.no-sibling-dependency.v1",
      ok: false,
      comparable: false,
      reasonCode: "SIBLING_DEPENDENCY_NOT_VERIFIABLE",
      error: String(error?.message ?? error),
      source: roster.manifestSource,
      manifestDigest: roster.manifestDigest,
      siblings: roster.siblings,
      findings: [],
      scannedRoots: [...SCANNED_ROOTS],
    };
  }
  return {
    schemaVersion: "tcrn.no-sibling-dependency.v1",
    ok: findings.length === 0,
    comparable: true,
    reasonCode: findings.length === 0 ? "NO_SIBLING_DEPENDENCY" : "SIBLING_DEPENDENCY_PRESENT",
    source: roster.manifestSource,
    manifestDigest: roster.manifestDigest,
    helperIdentity: roster.helperIdentity,
    self: roster.self,
    siblings: roster.siblings,
    scannedRoots: [...SCANNED_ROOTS],
    findings,
    detectionLimitations: "Line-local detection only: the sibling name and reaching operation must appear on the same line. Multi-line patterns (e.g., path assignment on one line, use on another) are not detected. See comments in the source for the list of known multi-line violations being addressed separately.",
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
