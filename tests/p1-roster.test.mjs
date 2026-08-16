// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-218 — the P1 roster is one list, and each entry points at itself.
//
// Sharing the list removes the drift between the two runners. It does not remove the
// smaller drift inside an entry: a roster naming the verb `source` beside a script that
// runs something else would still read as coverage while covering the wrong thing. So
// each pair is checked against package.json rather than trusted.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { P1_SEQUENCE, P1_TASKS, P1_GATE_SPECS } from "../scripts/p1-sequence.mjs";
import { P1_GATE_SPECS as PREFLIGHT_SPECS } from "../scripts/preflight.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts;

test("preflight runs the roster, not a copy of it", () => {
  // The identity is the whole point: preflight's list and P1's list must be the same
  // object, so a gate added to one cannot be missing from the other.
  assert.equal(PREFLIGHT_SPECS, P1_GATE_SPECS);
  assert.deepEqual(PREFLIGHT_SPECS.map(([key]) => key), P1_TASKS);
});

test("every rostered script exists", () => {
  for (const { task, script } of P1_SEQUENCE) {
    assert.equal(typeof scripts[script], "string", `${task} names package script ${script}, which does not exist`);
  }
});

test("a rostered script dispatches the verb it is listed beside", () => {
  for (const { task, script, dispatchesThroughTask } of P1_SEQUENCE) {
    const dispatched = scripts[script].match(/^node scripts\/task\.mjs ([a-z0-9-]+)$/u);
    if (dispatchesThroughTask) {
      assert.ok(dispatched, `${script} should dispatch through task.mjs but runs: ${scripts[script]}`);
      assert.equal(dispatched[1], task, `${script} runs task ${dispatched[1]}, not ${task}`);
      continue;
    }
    // The declared exception, and it must stay an exception: if the script ever starts
    // dispatching through task.mjs, the roster entry is stale and should drop the flag.
    assert.equal(dispatched, null, `${script} now dispatches through task.mjs — drop dispatchesThroughTask:false`);
  }
});

test("the two gates this drift hid are on the roster", () => {
  // Named rather than counted. A count goes green again the moment any two gates exist,
  // including two that are not these — and these two are the ones that were missing:
  // `no-sibling-dependency` proves the repository stands without its siblings, and the
  // isolated clone was the one world not running it.
  assert.ok(P1_TASKS.includes("no-sibling-dependency"));
  assert.ok(P1_TASKS.includes("portal"));
});

test("the roster names each verb once", () => {
  assert.equal(new Set(P1_TASKS).size, P1_TASKS.length);
});
