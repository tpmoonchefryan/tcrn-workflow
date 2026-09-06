#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INC-149: compare current test coverage against a checked-in baseline manifest
// and require an explicit, replacement-pointed waiver for every reduction.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { repositoryRoot, toPosixPath, walkFiles } from "./lib/files.mjs";
import { runLocalCommand } from "./lib/local-command.mjs";

export const REPOSITORY_ROOT = repositoryRoot;
export const COVERAGE_WAIVER_PATH = resolve(REPOSITORY_ROOT, "scripts/policy/coverage-waivers.json");
export const COVERAGE_BASELINE_PATH = resolve(REPOSITORY_ROOT, "scripts/policy/coverage-baseline.json");
export const COVERAGE_TEST_ROOTS = Object.freeze(["tests/", "portal/tests/"]);

export function isCoverageTestPath(path) {
  return COVERAGE_TEST_ROOTS.some((root) => path.startsWith(root)) && path.endsWith(".test.mjs");
}

export function compareCoverageSurface(baselinePaths, currentPaths) {
  const baseline = new Set(baselinePaths);
  const current = new Set(currentPaths);
  const missingFiles = [...current].filter((path) => !baseline.has(path)).sort();
  const staleFiles = [...baseline].filter((path) => !current.has(path)).sort();
  return {
    ok: missingFiles.length === 0 && staleFiles.length === 0,
    expectedFiles: baseline.size,
    currentFiles: current.size,
    missingFiles,
    staleFiles,
  };
}

export function countCoverage(source) {
  const tests = [...source.matchAll(/\btest(?:\.(?:skip|only|todo))?\s*\(\s*["'`]([^"'`]+)["'`]/gu)].map((match) => match[1]);
  const assertions = [...source.matchAll(/\bassert(?:\.[A-Za-z][A-Za-z0-9_]*)?\s*\(/gu)].length;
  return { testCount: tests.length, assertionCount: assertions, testNames: tests };
}

function baselineMetrics(path, baselineByPath, baselineMetricsByPath) {
  const declared = baselineMetricsByPath?.[path];
  if (declared !== undefined) {
    return {
      testCount: declared.testCount ?? declared.testNames?.length ?? 0,
      assertionCount: declared.assertionCount,
      testNames: [...(declared.testNames ?? [])],
    };
  }
  return countCoverage(baselineByPath?.[path] ?? "");
}

export function validateWaivers(waivers) {
  return waivers.flatMap((entry, index) => {
    if (entry === null || typeof entry !== "object") return [`waivers[${index}] must be an object`];
    const problems = [];

    // These fields are always required.
    for (const field of ["path", "testName", "reason"]) {
      if (typeof entry[field] !== "string" || entry[field].trim().length === 0) {
        problems.push(`waivers[${index}].${field} must be non-empty`);
      }
    }

    // Exactly one of replacement or disowned must be present.
    const hasReplacement = typeof entry.replacement === "string" && entry.replacement.trim().length > 0;
    const hasDisowned = entry.disowned !== null && typeof entry.disowned === "object" && !Array.isArray(entry.disowned);

    if (!hasReplacement && !hasDisowned) {
      problems.push(`waivers[${index}] must have either replacement or disowned field`);
    } else if (hasReplacement && hasDisowned) {
      problems.push(`waivers[${index}] cannot have both replacement and disowned fields`);
    }

    // If disowned is present, both its fields must be non-empty strings.
    // The ruling field is mandatory to gate against casual disposal of inconvenient tests.
    // Without an explicit Owner ruling, this would become the universal exit for deleting
    // any test: a disposal-by-default that would retire coverage conservation itself.
    // See TCRN-CROSS-INC-274.
    if (hasDisowned) {
      if (typeof entry.disowned.owningRepository !== "string" || entry.disowned.owningRepository.trim().length === 0) {
        problems.push(`waivers[${index}].disowned.owningRepository must be non-empty`);
      }
      if (typeof entry.disowned.ruling !== "string" || entry.disowned.ruling.trim().length === 0) {
        problems.push(`waivers[${index}].disowned.ruling must be non-empty`);
      }
    }

    return problems;
  });
}

export function evaluateCoverage({ baselineByPath = {}, baselineMetricsByPath, currentByPath, waivers = [] }) {
  const waiverIndex = new Set(waivers.map((entry) => `${entry.path}\u0000${entry.testName}`));
  const reports = [];
  const problems = [];
  for (const path of Object.keys(baselineMetricsByPath ?? baselineByPath).sort()) {
    const baseline = baselineMetrics(path, baselineByPath, baselineMetricsByPath);
    const current = countCoverage(currentByPath[path] ?? "");
    const removedTests = baseline.testNames.filter((name) => !current.testNames.includes(name));
    const unwaivedTests = removedTests.filter((name) => !waiverIndex.has(`${path}\u0000${name}`));
    const testCountLoss = Math.max(0, baseline.testCount - current.testCount);
    const assertionLoss = Math.max(0, baseline.assertionCount - current.assertionCount);
    const allRemovedTestsWaived = removedTests.every((name) => waiverIndex.has(`${path}\u0000${name}`));
    const testCountWaived = baseline.testNames.length > 0 ? allRemovedTestsWaived : waiverIndex.has(`${path}\u0000__tests__`);
    const assertionWaived = waiverIndex.has(`${path}\u0000__assertions__`);
    // Assertion loss is an independent failure.  It must not be gated by
    // removedTests.every(...): [].every(...) is true when test names remain,
    // which was the dead branch that let an emptied test body pass.
    const pathProblem = unwaivedTests.length > 0
      || (testCountLoss > 0 && !testCountWaived)
      || (assertionLoss > 0 && !assertionWaived);
    const report = {
      path,
      baseline: { testCount: baseline.testCount, assertionCount: baseline.assertionCount },
      current: { testCount: current.testCount, assertionCount: current.assertionCount },
      removedTests,
      unwaivedTests,
      testCountLoss,
      testCountWaived,
      assertionLoss,
      assertionWaived,
      ok: !pathProblem,
    };
    reports.push(report);
    if (pathProblem) problems.push(report);
  }
  return { ok: problems.length === 0, reports, problems };
}

// ---------------------------------------------------------------------------
// Surviving-module coverage (Owner ruling TCRN-CROSS-MIN-144).
//
// The registry above answers "was every removed CASE accounted for". It cannot answer
// the question that actually went wrong four times during TCRN-CROSS-STORY-358: when a
// whole test file retires with the module it was written for, the file usually also
// imported modules that SURVIVE, and it was sometimes the only thing exercising them.
// Coverage conservation was green every one of those times, because every removed case
// carried a waiver -- the waiver says where the CASE went, and nothing asked where the
// MODULE's coverage went.
//
// GRANULARITY, and why this one.
//
// A static sweep -- "does some surviving test still name this module" -- is not enough,
// and this is measured rather than argued: such a sweep passed over
// packages/core/src/authority-file-reader.ts while the foreign-error branch inside it
// went from covered to zero, because four other modules import that file and one of them
// is exercised on every run. Import-level presence and execution are different facts.
//
// So this check reads V8's own record of what ran. For each surviving module a retired
// test file imported directly, it requires:
//
//   1. the module to appear in the coverage output at all (something loaded it), and
//   2. at least one range INSIDE one of its named functions to have a non-zero count.
//
// (2) is the part a sweep cannot express. Merely importing a module covers its top-level
// module wrapper and nothing else, so a module whose last caller disappeared still shows
// up as "imported" and now shows up here as zero executed blocks. What this does NOT do
// is demand full branch coverage of the module: Owner's rule is that ZERO coverage is
// red, and a ratchet on every branch of every module a retired test touched is a
// different and much larger commitment than the ruling makes.
//
// The retired file's import list comes from Git, which is the only place it still
// exists: HEAD first (the file is deleted in the working tree but the deletion is not
// committed yet -- the state an executor is in while making the change), then the commit
// that deleted it. A record whose source cannot be recovered is red, not skipped.

const COVERED_SOURCE_ROOTS = Object.freeze(["packages/", "scripts/", "tools/"]);
const BUILD_PREFIX = "dist/build/";

/** Test-file paths a waiver names that no longer exist on disk. */
export function retiredTestPaths(waivers, currentPaths) {
  const current = new Set(currentPaths);
  return [...new Set(waivers.map((entry) => entry?.path).filter((path) => typeof path === "string"))]
    .filter((path) => !current.has(path))
    .sort();
}

/** Direct import specifiers of one module's source text, static and dynamic. */
export function directImportSpecifiers(source) {
  const specifiers = new Set();
  for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/gu)) specifiers.add(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu)) specifiers.add(match[1]);
  return [...specifiers];
}

/**
 * Repository-relative source path a specifier names, or null when it names something
 * this check does not judge (a bare node: builtin, a package, a sibling test helper).
 *
 * Tests import the BUILT module (`../dist/build/packages/core/src/x.js`); the file that
 * survives or does not is the TypeScript source beside it, so the build prefix is undone
 * here rather than left for the caller to remember.
 */
export function resolveImportedModule(specifier, fromPath) {
  if (!specifier.startsWith(".")) return null;
  const joined = toPosixPath(relative(repositoryRoot, resolve(repositoryRoot, dirname(fromPath), specifier)));
  if (joined.startsWith("..")) return null;
  let candidate = joined;
  if (candidate.startsWith(BUILD_PREFIX)) {
    candidate = candidate.slice(BUILD_PREFIX.length).replace(/\.js$/u, ".ts");
  }
  if (!COVERED_SOURCE_ROOTS.some((root) => candidate.startsWith(root))) return null;
  if (isCoverageTestPath(candidate)) return null;
  return candidate;
}

/** The executed artifact for a source path: TypeScript is judged through its build output. */
export function executedArtifactFor(modulePath) {
  return modulePath.endsWith(".ts") ? `${BUILD_PREFIX}${modulePath.replace(/\.ts$/u, ".js")}` : modulePath;
}

/**
 * The retired file's text, recovered from HEAD or from the commit that removed it.
 *
 * `cat-file` and `rev-list` rather than `show` and `log`: scripts/lib/local-command.mjs
 * admits a fixed set of Git subcommands, and widening that set to read a deleted file
 * would trade a boundary for a convenience. `rev-list -n 1 HEAD -- <path>` names the most
 * recent commit that touched the path, which for a removed file is the removing commit.
 */
export function retiredTestSource(path, { root = REPOSITORY_ROOT } = {}) {
  const blob = (revision) => runLocalCommand("git", ["cat-file", "blob", `${revision}:${path}`], { cwd: root });
  try {
    return blob("HEAD");
  } catch {
    let commit = "";
    try {
      commit = runLocalCommand("git", ["rev-list", "-n", "1", "HEAD", "--", path], { cwd: root }).split("\n")[0].trim();
    } catch {
      return null;
    }
    if (commit === "") return null;
    try {
      return blob(`${commit}^`);
    } catch {
      return null;
    }
  }
}

/**
 * Executed-block counts per artifact, read from a NODE_V8_COVERAGE directory.
 *
 * Every file in that directory is a V8 coverage document; the whole suite's child
 * processes write one each, so there are thousands. A substring test on the raw text
 * decides whether a document is worth parsing, which keeps the read cheap.
 */
export async function measureExecutedBlocks(coverageDirectory, artifacts) {
  const totals = new Map(artifacts.map((artifact) => [artifact, { loaded: false, executedBlocks: 0 }]));
  let documents = 0;
  for (const name of await readdir(coverageDirectory)) {
    if (!name.endsWith(".json")) continue;
    let text;
    try { text = await readFile(resolve(coverageDirectory, name), "utf8"); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    const interesting = artifacts.filter((artifact) => text.includes(artifact));
    if (interesting.length === 0) continue;
    documents += 1;
    let parsed;
    try { parsed = JSON.parse(text); } catch { continue; }
    for (const entry of parsed.result ?? []) {
      const url = String(entry.url ?? "");
      for (const artifact of interesting) {
        if (!url.endsWith(`/${artifact}`)) continue;
        const total = totals.get(artifact);
        total.loaded = true;
        for (const fn of entry.functions ?? []) {
          if (!fn.functionName) continue;
          for (const range of fn.ranges ?? []) {
            if (range.count > 0) total.executedBlocks += 1;
          }
        }
      }
    }
  }
  return { documents, totals };
}

/**
 * The gate. Red when a retired test file's source cannot be recovered, or when a module
 * it imported directly still exists and nothing in the suite executed a block inside it.
 */
export async function evaluateSurvivingModuleCoverage({ coverageDirectory, waivers, currentTestPaths, root = REPOSITORY_ROOT }) {
  const retired = retiredTestPaths(waivers, currentTestPaths);
  const problems = [];
  const byModule = new Map();
  for (const path of retired) {
    const source = retiredTestSource(path, { root });
    if (source === null) {
      problems.push(`${path}: retired test source is unrecoverable from Git, so the modules it imported cannot be named`);
      continue;
    }
    for (const specifier of directImportSpecifiers(source)) {
      const modulePath = resolveImportedModule(specifier, path);
      if (modulePath === null) continue;
      if (!existsSync(resolve(root, modulePath))) continue;
      const owners = byModule.get(modulePath) ?? [];
      owners.push(path);
      byModule.set(modulePath, owners);
    }
  }
  const modulePaths = [...byModule.keys()].sort();
  const artifacts = modulePaths.map((modulePath) => executedArtifactFor(modulePath));
  const { documents, totals } = modulePaths.length === 0
    ? { documents: 0, totals: new Map() }
    : await measureExecutedBlocks(coverageDirectory, artifacts);
  const modules = modulePaths.map((modulePath) => {
    const artifact = executedArtifactFor(modulePath);
    const measured = totals.get(artifact) ?? { loaded: false, executedBlocks: 0 };
    const record = {
      module: modulePath,
      artifact,
      retiredTests: byModule.get(modulePath),
      loaded: measured.loaded,
      executedBlocks: measured.executedBlocks,
      ok: measured.loaded && measured.executedBlocks > 0,
    };
    if (!record.ok) {
      problems.push(`${modulePath}: survives ${record.retiredTests.join(", ")} but the suite executed ${String(record.executedBlocks)} blocks inside it`);
    }
    return record;
  });
  return {
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? "SURVIVING_MODULE_COVERAGE_VERIFIED" : "SURVIVING_MODULE_COVERAGE_ZERO",
    retiredTestFiles: retired,
    coverageDocumentsRead: documents,
    modules,
    problems,
  };
}

/**
 * The conservation registry, read and judged. `main()` below and the `test` verb in
 * scripts/task.mjs run the same function rather than two copies of it: before
 * TCRN-CROSS-STORY-359 this file gated nothing and had to be remembered.
 */
export async function evaluateCoverageRegistry({ baselinePath = COVERAGE_BASELINE_PATH } = {}) {
  const baselineDocument = JSON.parse(await readFile(baselinePath, "utf8"));
  const baselineMetricsByPath = baselineDocument.files;
  const baselineProblems = [];
  if (baselineDocument.schemaVersion !== "tcrn.coverage-baseline.v1") baselineProblems.push("schemaVersion");
  if (baselineMetricsByPath === null || typeof baselineMetricsByPath !== "object" || Array.isArray(baselineMetricsByPath)) baselineProblems.push("files");
  for (const [path, entry] of Object.entries(baselineMetricsByPath ?? {})) {
    if (!path.endsWith(".test.mjs") || entry === null || typeof entry !== "object"
      || !Number.isSafeInteger(entry.testCount) || entry.testCount < 0
      || !Array.isArray(entry.testNames) || entry.testNames.length !== entry.testCount
      || !entry.testNames.every((name) => typeof name === "string")
      || !Number.isSafeInteger(entry.assertionCount) || entry.assertionCount < 0) baselineProblems.push(path);
  }
  if (baselineProblems.length > 0) {
    return { ok: false, reasonCode: "COVERAGE_BASELINE_INVALID", baselinePath: relative(REPOSITORY_ROOT, baselinePath), problems: baselineProblems };
  }
  const names = Object.keys(baselineMetricsByPath).sort();
  const currentTestPaths = (await walkFiles())
    .map((path) => toPosixPath(relative(REPOSITORY_ROOT, path)))
    .filter(isCoverageTestPath)
    .sort();
  const baselineCompleteness = compareCoverageSurface(names, currentTestPaths);
  const overridePath = process.env.TCRN_COVERAGE_CURRENT_OVERRIDE;
  const overrides = overridePath === undefined ? {} : JSON.parse(await readFile(resolve(overridePath), "utf8"));
  const currentByPath = Object.fromEntries(await Promise.all(names.map(async (path) => {
    if (Object.hasOwn(overrides, path)) return [path, overrides[path]];
    try { return [path, await readFile(resolve(REPOSITORY_ROOT, path), "utf8")]; }
    catch (error) { if (error?.code === "ENOENT") return [path, ""]; throw error; }
  })));
  const waiverDocument = JSON.parse(await readFile(COVERAGE_WAIVER_PATH, "utf8"));
  const waivers = waiverDocument.waivers ?? [];
  const waiverProblems = validateWaivers(waivers);
  const result = evaluateCoverage({ baselineMetricsByPath, currentByPath, waivers });
  const ok = result.ok && waiverProblems.length === 0 && baselineCompleteness.ok;
  const reasonCode = !baselineCompleteness.ok
    ? "COVERAGE_BASELINE_INCOMPLETE"
    : ok
      ? "COVERAGE_CONSERVATION_VERIFIED"
      : "COVERAGE_CONSERVATION_VIOLATION";
  return {
    ...result,
    ok,
    reasonCode,
    baselinePath: relative(REPOSITORY_ROOT, baselinePath),
    waiverPath: relative(REPOSITORY_ROOT, COVERAGE_WAIVER_PATH),
    waiverProblems,
    baselineCompleteness,
    waivers,
    currentTestPaths,
  };
}

async function main() {
  const baselinePath = process.env.TCRN_COVERAGE_BASELINE_OVERRIDE
    ? resolve(process.env.TCRN_COVERAGE_BASELINE_OVERRIDE)
    : COVERAGE_BASELINE_PATH;
  const { waivers, currentTestPaths, ...output } = await evaluateCoverageRegistry({ baselinePath });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
