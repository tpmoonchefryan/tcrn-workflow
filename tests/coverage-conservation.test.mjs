// SPDX-License-Identifier: Apache-2.0
// INC-138 self-mutation: the conservation gate must actually turn red.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compareCoverageSurface,
  countCoverage,
  evaluateCoverage,
  evaluateSurvivingModuleCoverage,
  measureExecutedBlocks,
  resolveImportedModule,
  retiredTestPaths,
  validateWaivers,
} from "../scripts/coverage-conservation.mjs";

test("coverage conservation rejects a removed test without a replacement waiver", () => {
  const baseline = { "tests/example.test.mjs": `test("kept", () => { assert.equal(1, 1); });\ntest("removed", () => { assert.equal(1, 1); });` };
  const current = { "tests/example.test.mjs": `test("kept", () => { assert.equal(1, 1); });` };
  const red = evaluateCoverage({ baselineByPath: baseline, currentByPath: current, waivers: [] });
  assert.equal(red.ok, false);
  assert.deepEqual(red.problems[0].unwaivedTests, ["removed"]);
  const green = evaluateCoverage({ baselineByPath: baseline, currentByPath: current, waivers: [
    { path: "tests/example.test.mjs", testName: "removed", reason: "retired", replacement: "tests/new.test.mjs" },
    { path: "tests/example.test.mjs", testName: "__assertions__", reason: "retired with test", replacement: "tests/new.test.mjs" },
  ] });
  assert.equal(green.ok, true);
});

test("coverage conservation rejects an assertion-only loss while test names remain", () => {
  const baseline = { "tests/example.test.mjs": `test("kept", () => { assert.equal(1, 1); assert.equal(2, 2); });` };
  const current = { "tests/example.test.mjs": `test("kept", () => {});` };
  const red = evaluateCoverage({ baselineByPath: baseline, currentByPath: current, waivers: [] });
  assert.equal(red.ok, false);
  assert.equal(red.problems[0].removedTests.length, 0);
  assert.equal(red.problems[0].assertionLoss, 2);
});

test("coverage conservation requires waiver reason and either replacement or disowned", () => {
  assert.deepEqual(validateWaivers([{ path: "tests/example.test.mjs", testName: "retired", reason: "superseded", replacement: "tests/new.test.mjs" }]), []);
  assert.deepEqual(validateWaivers([{ path: "tests/example.test.mjs", testName: "retired", reason: "" }]), [
    "waivers[0].reason must be non-empty",
    "waivers[0] must have either replacement or disowned field",
  ]);
});

test("coverage baseline completeness names an unregistered test file", () => {
  const red = compareCoverageSurface(["tests/kept.test.mjs"], ["tests/kept.test.mjs", "tests/new.test.mjs"]);
  assert.equal(red.ok, false);
  assert.deepEqual(red.missingFiles, ["tests/new.test.mjs"]);
  assert.deepEqual(red.staleFiles, []);
  const green = compareCoverageSurface(["tests/kept.test.mjs", "tests/new.test.mjs"], ["tests/kept.test.mjs", "tests/new.test.mjs"]);
  assert.equal(green.ok, true);
});

test("named test waivers remain executable when baseline carries testNames", () => {
  const baselineMetricsByPath = {
    "tests/example.test.mjs": { testCount: 2, assertionCount: 2, testNames: ["kept", "retired"] },
  };
  const currentByPath = { "tests/example.test.mjs": `test("kept", () => { assert.equal(1, 1); });` };
  const red = evaluateCoverage({ baselineMetricsByPath, currentByPath, waivers: [] });
  assert.equal(red.ok, false);
  assert.deepEqual(red.problems[0].removedTests, ["retired"]);
  const green = evaluateCoverage({ baselineMetricsByPath, currentByPath, waivers: [
    { path: "tests/example.test.mjs", testName: "retired", reason: "replaced", replacement: "tests/new.test.mjs" },
    { path: "tests/example.test.mjs", testName: "__assertions__", reason: "replaced with the named test", replacement: "tests/new.test.mjs" },
  ] });
  assert.equal(green.ok, true);
});

test("validates replacement waiver (regression)", () => {
  const result = validateWaivers([{ path: "tests/example.test.mjs", testName: "retired", reason: "superseded", replacement: "tests/new.test.mjs" }]);
  assert.deepEqual(result, []);
});

test("validates disowned waiver", () => {
  const result = validateWaivers([{
    path: "tests/example.test.mjs",
    testName: "removed",
    reason: "not owned by this repo",
    disowned: {
      owningRepository: "dsh-tcrn-workflow-plugin",
      ruling: "Owner ruling, 2026-09-04: cross-repository assertions are forbidden (AGENTS.md section 五)"
    }
  }]);
  assert.deepEqual(result, []);
});

test("rejects waiver with neither replacement nor disowned", () => {
  const result = validateWaivers([{ path: "tests/example.test.mjs", testName: "removed", reason: "test removed" }]);
  assert(result.some(msg => msg.includes("must have either replacement or disowned")));
});

test("rejects waiver with both replacement and disowned", () => {
  const result = validateWaivers([{
    path: "tests/example.test.mjs",
    testName: "removed",
    reason: "conflicting",
    replacement: "tests/new.test.mjs",
    disowned: {
      owningRepository: "other-repo",
      ruling: "some ruling"
    }
  }]);
  assert(result.some(msg => msg.includes("cannot have both replacement and disowned")));
});

test("rejects disowned without ruling", () => {
  const result = validateWaivers([{
    path: "tests/example.test.mjs",
    testName: "removed",
    reason: "not owned",
    disowned: {
      owningRepository: "other-repo"
    }
  }]);
  assert(result.some(msg => msg.includes("disowned.ruling must be non-empty")));
});

test("rejects disowned without owningRepository", () => {
  const result = validateWaivers([{
    path: "tests/example.test.mjs",
    testName: "removed",
    reason: "not owned",
    disowned: {
      ruling: "some ruling"
    }
  }]);
  assert(result.some(msg => msg.includes("disowned.owningRepository must be non-empty")));
});

test("rejects disowned with empty-string ruling", () => {
  const result = validateWaivers([{
    path: "tests/example.test.mjs",
    testName: "removed",
    reason: "not owned",
    disowned: {
      owningRepository: "other-repo",
      ruling: ""
    }
  }]);
  assert(result.some(msg => msg.includes("disowned.ruling must be non-empty")));
});

// TCRN-CROSS-STORY-359, Owner ruling TCRN-CROSS-MIN-144. The surviving-module leg exists
// because coverage conservation was green four times while a module lost its only test,
// so it needs its own red legs rather than only a green run on the real tree.

test("STORY-359 retired test paths are the waived paths the tree no longer has", () => {
  const waivers = [
    { path: "tests/gone.test.mjs", testName: "a" },
    { path: "tests/gone.test.mjs", testName: "b" },
    { path: "tests/here.test.mjs", testName: "c" },
  ];
  assert.deepEqual(retiredTestPaths(waivers, ["tests/here.test.mjs"]), ["tests/gone.test.mjs"]);
  assert.deepEqual(retiredTestPaths(waivers, ["tests/here.test.mjs", "tests/gone.test.mjs"]), []);
});

test("STORY-359 an imported build artifact resolves back to the TypeScript source that survives", () => {
  const from = "tests/p7-compatibility-modes.test.mjs";
  assert.equal(resolveImportedModule("../dist/build/packages/core/src/authority-file-reader.js", from), "packages/core/src/authority-file-reader.ts");
  assert.equal(resolveImportedModule("../scripts/lib/safe-io.mjs", from), "scripts/lib/safe-io.mjs");
  // Not judged: node builtins, packages, and a sibling test helper are not modules whose
  // coverage this leg is about.
  assert.equal(resolveImportedModule("node:test", from), null);
  assert.equal(resolveImportedModule("ajv/dist/2020.js", from), null);
  assert.equal(resolveImportedModule("./helpers.test.mjs", from), null);
});

test("STORY-359 a module that is only imported, never executed, reads as zero blocks", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "tcrn-coverage-probe-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  // The distinction the whole leg turns on: V8 records the module wrapper (an unnamed
  // function) for anything merely loaded, and records named functions only when they run.
  await writeFile(join(directory, "probe.json"), `${JSON.stringify({
    result: [
      { url: "file:///repo/dist/build/packages/core/src/imported-only.js", functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: 99, count: 1 }] }] },
      { url: "file:///repo/dist/build/packages/core/src/executed.js", functions: [{ functionName: "readAuthorityFile", ranges: [{ startOffset: 0, endOffset: 50, count: 3 }] }] },
    ],
  })}\n`);
  const { totals } = await measureExecutedBlocks(directory, [
    "dist/build/packages/core/src/imported-only.js",
    "dist/build/packages/core/src/executed.js",
    "dist/build/packages/core/src/absent.js",
  ]);
  assert.deepEqual(totals.get("dist/build/packages/core/src/imported-only.js"), { loaded: true, executedBlocks: 0 });
  assert.deepEqual(totals.get("dist/build/packages/core/src/executed.js"), { loaded: true, executedBlocks: 1 });
  assert.deepEqual(totals.get("dist/build/packages/core/src/absent.js"), { loaded: false, executedBlocks: 0 });
});

test("STORY-359 the gate reds when a surviving module the retired test imported executed nothing", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "tcrn-coverage-probe-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "probe.json"), `${JSON.stringify({ result: [] })}\n`);
  const waivers = [{ path: "tests/p7-compatibility-modes.test.mjs", testName: "any", reason: "r", replacement: "tests/other.test.mjs:any" }];
  const red = await evaluateSurvivingModuleCoverage({ coverageDirectory: directory, waivers, currentTestPaths: [] });
  assert.equal(red.ok, false);
  assert.equal(red.reasonCode, "SURVIVING_MODULE_COVERAGE_ZERO");
  assert.deepEqual(red.retiredTestFiles, ["tests/p7-compatibility-modes.test.mjs"]);
  assert.ok(red.problems.some((problem) => problem.startsWith("packages/core/src/authority-file-reader.ts:")));
});

test("STORY-359 the gate reds when the retired test source cannot be recovered from Git", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "tcrn-coverage-probe-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const waivers = [{ path: "tests/never-existed.test.mjs", testName: "any", reason: "r", replacement: "tests/other.test.mjs:any" }];
  const red = await evaluateSurvivingModuleCoverage({ coverageDirectory: directory, waivers, currentTestPaths: [] });
  assert.equal(red.ok, false);
  assert.ok(red.problems.some((problem) => problem.includes("unrecoverable from Git")));
});

test("coverage names preserve paired quotes and detect suffix changes", async () => {
  const names = [
    "pull-request CI scans the contributor head, not GitHub's synthetic merge commit",
    "STORY-355 GWT4: container mode's default prose root sits above the chain container regardless of partition",
    'a name containing "double quotes" and `backticks`',
    "an escaped \"quote\" and an apostrophe's suffix",
  ];
  const source = names.map((name) => `test(${JSON.stringify(name)}, () => {});`).join("\n");
  assert.deepEqual(
    countCoverage(source).testNames,
    names.map((name) => JSON.stringify(name).slice(1, -1)),
  );

  const ci = await readFile(new URL("./ci-bootstrap.test.mjs", import.meta.url), "utf8");
  const portal = await readFile(new URL("../portal/tests/portal.test.mjs", import.meta.url), "utf8");
  assert.ok(countCoverage(ci).testNames.includes(names[0]));
  assert.ok(countCoverage(portal).testNames.includes(names[1]));

  const path = "tests/example.test.mjs";
  const result = evaluateCoverage({
    baselineByPath: { [path]: `test("owner's original suffix", () => {});` },
    currentByPath: { [path]: `test("owner's changed suffix", () => {});` },
    waivers: [],
  });
  assert.deepEqual(result.problems[0].unwaivedTests, ["owner's original suffix"]);
});

test("coverage counts calls while ignoring fixture strings comments and regex data", () => {
  const source = [
    'const fixture = \'test("phantom", () => { assert.equal(1, 1); });\';',
    'const template = `test("template phantom", () => { assert(false); });`;',
    '// test("comment phantom", () => { assert(false); });',
    '/* test("block phantom", () => { assert(false); }); */',
    'const pattern = /test("regex phantom")/;',
    'test("real", () => { assert.equal(1, 1); });',
    'test.skip("skipped", () => {});',
    'test.only("focused", () => {});',
    'test.todo("pending");',
    'context.test("nested", () => { assert(true); });',
    'test(`dynamic ${scenario.name}`, () => {});',
  ].join("\n");

  assert.deepEqual(countCoverage(source), {
    testCount: 6,
    assertionCount: 2,
    testNames: ["real", "skipped", "focused", "pending", "nested", "dynamic ${scenario.name}"],
  });
});

test("coverage self-count equals the registered tests in this file", async () => {
  const source = await readFile(new URL("./coverage-conservation.test.mjs", import.meta.url), "utf8");
  assert.equal(countCoverage(source).testCount, 20);
});
