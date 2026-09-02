// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { verifyCloseout } from "../scripts/closeout-verify.mjs";
import { measureCeremonyCost } from "../scripts/ceremony-cost.mjs";

const root = resolve(import.meta.dirname, "..");
const closeoutManifest = JSON.parse(readFileSync(resolve(root, "scripts/policy/closeout-inc263-baseline.json"), "utf8"));
const costManifest = JSON.parse(readFileSync(resolve(root, "scripts/policy/ceremony-cost-init048.json"), "utf8"));

test("INC-263 closeout verification is wired and ceremony cost measurement is deterministic", () => {
  const closeout = verifyCloseout(closeoutManifest);
  assert.equal(closeout.ok, true, JSON.stringify(closeout.problems));
  assert.equal(closeout.reasonCode, "CLOSEOUT_ITEMS_RECONCILED");

  const first = measureCeremonyCost(costManifest);
  const second = measureCeremonyCost(costManifest);
  assert.deepEqual(second, first);
  assert.deepEqual(first, {
    schemaVersion: "tcrn.ceremony-cost.v1",
    initiative: "TCRN-CROSS-INIT-048",
    scopeBytes: 35967,
    claimCount: 16,
    preworkBytes: 46842,
    totalBytes: 82809,
  });

  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["verify:closeout"], "node scripts/task.mjs closeout");
  assert.equal(packageJson.scripts["verify:inc263"], "node scripts/task.mjs inc263");
  assert.equal(packageJson.scripts["report:ceremony-cost"], "node scripts/ceremony-cost.mjs --manifest scripts/policy/ceremony-cost-init048.json");
  const taskSource = readFileSync(resolve(root, "scripts/task.mjs"), "utf8");
  assert.match(taskSource, /closeout:\s*verifyCloseoutGate/u);
  assert.match(taskSource, /const closeout = await verifyCloseoutGate\(\)/u);
  assert.match(taskSource, /measureCeremonyCost/u);
});

test("INC-263 a closeout wiring omission and malformed cost input are red", () => {
  const missingNotes = { ...closeoutManifest };
  delete missingNotes.chainNotes;
  const closeout = verifyCloseout(missingNotes);
  assert.equal(closeout.ok, false);
  assert.ok(closeout.problems.some((problem) => problem.includes("chainItems require per-item chainNotes")));

  const malformed = { ...costManifest, prework: [{ name: "scope-generator", bytes: -1 }] };
  assert.throws(() => measureCeremonyCost(malformed), /non-negative byte count/u);
});
