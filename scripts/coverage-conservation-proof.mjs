#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INC-155 meta-criterion: exercise the production coverage gate through its
// command boundary, not only through its pure evaluator unit tests.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const coverageScript = "scripts/coverage-conservation.mjs";
const s244Path = "tests/s244-model-plan.test.mjs";
const s213Path = "tests/s213-settings.test.mjs";

async function runCoverage(extraEnv = {}) {
  const env = { ...process.env, npm_config_offline: "true", ...extraEnv };
  for (const key of ["TCRN_COVERAGE_CURRENT_OVERRIDE", "TCRN_COVERAGE_BASELINE_OVERRIDE"]) {
    if (extraEnv[key] === undefined) delete env[key];
  }
  try {
    const result = await execFileAsync(process.execPath, [coverageScript], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, report: JSON.parse(result.stdout) };
  } catch (error) {
    return { exitCode: error.status ?? 1, report: JSON.parse(String(error.stdout ?? "{}")) };
  }
}

function reportFor(report, path) {
  return report.reports.find((entry) => entry.path === path) ?? null;
}

// MIN-223 D1 (A1): the INC-155 block records how the baseline relates to the
// coverage surface, not how many entries the baseline holds. expectedFiles and
// currentFiles are the baseline size itself, so registering or retiring a test
// file changed the recorded output without any change in what the case proves.
function completenessRelation(completeness) {
  return {
    ok: completeness.ok,
    missingFiles: completeness.missingFiles,
    staleFiles: completeness.staleFiles,
    currentMinusExpected: completeness.currentFiles - completeness.expectedFiles,
  };
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "tcrn-inc155-coverage-"));
  try {
    const s244 = await readFile(s244Path, "utf8");
    const firstStart = s244.indexOf('test("INC-145 M6:');
    const secondStart = s244.indexOf('\n\ntest("INC-152 MODEL_PLAN_IN_USE wiring names the settings reference"', firstStart);
    if (firstStart < 0 || secondStart < 0) throw new Error("INC155_S244_MUTATION_ANCHOR_MISSING");
    const deletedTestSource = `${s244.slice(0, firstStart)}${s244.slice(secondStart + 2)}`;
    const deletedOverride = join(directory, "deleted-s244.json");
    await writeFile(deletedOverride, JSON.stringify({ [s244Path]: deletedTestSource }), "utf8");
    const deleted = await runCoverage({ TCRN_COVERAGE_CURRENT_OVERRIDE: deletedOverride });

    const baseline = JSON.parse(await readFile("scripts/policy/coverage-baseline.json", "utf8"));
    delete baseline.files[s244Path];
    const incompleteBaseline = join(directory, "missing-s244-baseline.json");
    await writeFile(incompleteBaseline, JSON.stringify(baseline), "utf8");
    const missingFile = await runCoverage({ TCRN_COVERAGE_BASELINE_OVERRIDE: incompleteBaseline });

    const s213 = await readFile(s213Path, "utf8");
    const emptyAssertions = s213.replace(/\bassert(?:\.[A-Za-z][A-Za-z0-9_]*)?\s*\(/gu, "probe(");
    const emptyOverride = join(directory, "empty-assertions.json");
    await writeFile(emptyOverride, JSON.stringify({ [s213Path]: emptyAssertions }), "utf8");
    const assertionLoss = await runCoverage({ TCRN_COVERAGE_CURRENT_OVERRIDE: emptyOverride });

    const restored = await runCoverage();
    const result = {
      schemaVersion: "tcrn.inc155-coverage-meta-proof.v2",
      cases: [
        {
          name: "delete one s244 test block",
          exitCode: deleted.exitCode,
          reasonCode: deleted.report.reasonCode,
          target: reportFor(deleted.report, s244Path),
        },
        {
          name: "new test file without baseline entry",
          exitCode: missingFile.exitCode,
          reasonCode: missingFile.report.reasonCode,
          baselineCompleteness: completenessRelation(missingFile.report.baselineCompleteness),
        },
        {
          name: "empty assertions while keeping test names",
          exitCode: assertionLoss.exitCode,
          reasonCode: assertionLoss.report.reasonCode,
          target: reportFor(assertionLoss.report, s213Path),
        },
        {
          name: "restore all mutations",
          exitCode: restored.exitCode,
          reasonCode: restored.report.reasonCode,
          ok: restored.report.ok,
          baselineCompleteness: completenessRelation(restored.report.baselineCompleteness),
        },
      ],
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const [deletedCase, missingCase, assertionCase, restoredCase] = result.cases;
    const valid = deletedCase.exitCode !== 0
      && deletedCase.reasonCode === "COVERAGE_CONSERVATION_VIOLATION"
      && deletedCase.target?.path === s244Path
      && deletedCase.target.removedTests.includes("INC-145 M6: an active-plan reference refuses removal")
      && deletedCase.target.unwaivedTests.includes("INC-145 M6: an active-plan reference refuses removal")
      && missingCase.exitCode !== 0
      && missingCase.reasonCode === "COVERAGE_BASELINE_INCOMPLETE"
      && missingCase.baselineCompleteness.missingFiles.includes(s244Path)
      && missingCase.baselineCompleteness.currentMinusExpected === 1
      && missingCase.baselineCompleteness.missingFiles.length === 1
      && missingCase.baselineCompleteness.missingFiles[0] === s244Path
      && assertionCase.exitCode !== 0
      && assertionCase.reasonCode === "COVERAGE_CONSERVATION_VIOLATION"
      && assertionCase.target?.path === s213Path
      && assertionCase.target.assertionLoss > 0
      && assertionCase.target.removedTests.length === 0
      && restoredCase.exitCode === 0
      && restoredCase.ok === true
      && restoredCase.baselineCompleteness.ok === true
      && restoredCase.baselineCompleteness.currentMinusExpected === 0
      && restoredCase.baselineCompleteness.missingFiles.length === 0
      && restoredCase.baselineCompleteness.staleFiles.length === 0;
    if (!valid) process.exitCode = 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
