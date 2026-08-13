#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INC-149: compare current test coverage against a checked-in baseline manifest
// and require an explicit, replacement-pointed waiver for every reduction.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { relative, resolve } from "node:path";
import { repositoryRoot, toPosixPath, walkFiles } from "./lib/files.mjs";

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
    for (const field of ["path", "testName", "reason", "replacement"]) {
      if (typeof entry[field] !== "string" || entry[field].trim().length === 0) problems.push(`waivers[${index}].${field} must be non-empty`);
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

async function main() {
  const baselinePath = process.env.TCRN_COVERAGE_BASELINE_OVERRIDE
    ? resolve(process.env.TCRN_COVERAGE_BASELINE_OVERRIDE)
    : COVERAGE_BASELINE_PATH;
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
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: "COVERAGE_BASELINE_INVALID", baselinePath: relative(REPOSITORY_ROOT, baselinePath), problems: baselineProblems }, null, 2)}\n`);
    process.exitCode = 1;
    return;
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
  const output = {
    ...result,
    ok,
    reasonCode,
    baselinePath: relative(REPOSITORY_ROOT, baselinePath),
    waiverPath: relative(REPOSITORY_ROOT, COVERAGE_WAIVER_PATH),
    waiverProblems,
    baselineCompleteness,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
