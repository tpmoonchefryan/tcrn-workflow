// SPDX-License-Identifier: Apache-2.0
// INC-138 self-mutation: the conservation gate must actually turn red.

import assert from "node:assert/strict";
import test from "node:test";

import { compareCoverageSurface, evaluateCoverage, validateWaivers } from "../scripts/coverage-conservation.mjs";

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

test("coverage conservation requires waiver reason and replacement", () => {
  assert.deepEqual(validateWaivers([{ path: "tests/example.test.mjs", testName: "retired", reason: "superseded", replacement: "tests/new.test.mjs" }]), []);
  assert.deepEqual(validateWaivers([{ path: "tests/example.test.mjs", testName: "retired", reason: "", replacement: "" }]), [
    "waivers[0].reason must be non-empty",
    "waivers[0].replacement must be non-empty",
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
