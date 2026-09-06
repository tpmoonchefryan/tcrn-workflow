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

  // TCRN-CROSS-STORY-359: `verify:closeout` and `verify:inc263` retired with the rest of
  // the ticket-numbered roster, and the two task.mjs verbs behind them went with the
  // names. The manifest is still reconciled -- by the assertions above, in this file,
  // which `pnpm test` runs from the P1 roster. So what is pinned here is that the wiring
  // MOVED: the old names must be gone, the report command must remain, and task.mjs must
  // no longer be the thing that runs either measurement.
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["verify:closeout"], undefined);
  assert.equal(packageJson.scripts["verify:inc263"], undefined);
  assert.equal(packageJson.scripts["report:ceremony-cost"], "node scripts/ceremony-cost.mjs --manifest scripts/policy/ceremony-cost-init048.json");
  const taskSource = readFileSync(resolve(root, "scripts/task.mjs"), "utf8");
  assert.equal(/verifyCloseoutGate/u.test(taskSource), false);
  assert.equal(/measureCeremonyCost/u.test(taskSource), false);
  assert.equal(packageJson.scripts.test, "node scripts/task.mjs test");
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
