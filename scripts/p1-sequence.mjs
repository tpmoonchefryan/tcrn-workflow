// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-218 — the P1 gate roster, written once.
//
// Two runners drive P1 and they need different things from it. `verify:p1` runs the
// verbs in-process and fails fast; `preflight` runs each as its own `pnpm` process in a
// scrubbed environment inside an isolated clone, and collects every red so the first
// failure cannot hide a second-world mismatch. Those are two ways of running the same
// list, and until this file existed each runner carried its own copy of it.
//
// The copies had already drifted. `verify:p1` ran `portal` and `no-sibling-dependency`;
// preflight's list held neither — so the one world that proves this repository stands up
// without its siblings was precisely the world that never ran the sibling gate. Nothing
// compared the two lists, and nothing would have.
//
// That is the failure this platform keeps paying for: a hand-kept roster goes stale at
// the exact moment a new member is admitted, and it goes stale silently, because a list
// nobody checks still looks like coverage. The no-sibling gate's own sibling discovery
// was written to avoid it; its runner list reintroduced it one directory away.

/**
 * P1, in order.
 *
 * `task` is the verb `scripts/task.mjs` dispatches. `script` is the `package.json` entry
 * preflight spawns. They are stated together because the pair is what has to stay true:
 * a roster naming a verb whose script runs something else is the same drift in a smaller
 * space, and `tests/p1-roster.test.mjs` holds them to it.
 */
export const P1_SEQUENCE = Object.freeze([
  { task: "format-check", script: "format:check" },
  { task: "lint", script: "lint" },
  { task: "typecheck", script: "typecheck" },
  { task: "build", script: "build" },
  { task: "test", script: "test" },
  // `portal` is the one entry whose script does not dispatch through task.mjs: both the
  // verb and `verify:portal` run scripts/verify-portal.mjs directly. Declared here rather
  // than special-cased in the test, so the exception is visible where the roster is read.
  { task: "portal", script: "verify:portal", dispatchesThroughTask: false },
  { task: "test-trust", script: "verify:trust" },
  { task: "archive", script: "archive" },
  { task: "sbom", script: "sbom" },
  { task: "licenses", script: "verify:licenses" },
  { task: "vulnerabilities", script: "verify:vulnerabilities" },
  { task: "source", script: "verify:source" },
  { task: "no-sibling-dependency", script: "verify:no-sibling-dependency" },
  { task: "lifecycle", script: "verify:lifecycle" },
  { task: "offline", script: "verify:offline" },
  { task: "governance", script: "verify:governance" },
  { task: "workspace", script: "verify:workspace" },
  { task: "privacy", script: "verify:privacy" },
  { task: "roots", script: "verify:roots" },
  { task: "ci", script: "verify:ci" },
  { task: "verification-map", script: "verify:map" },
  { task: "history", script: "verify:history" },
].map((entry) => Object.freeze({ dispatchesThroughTask: true, ...entry })));

/** The verb names, in order — what `verify:p1` walks. */
export const P1_TASKS = Object.freeze(P1_SEQUENCE.map((entry) => entry.task));

/** `[key, argv]` pairs — what preflight spawns, one process per gate. */
export const P1_GATE_SPECS = Object.freeze(
  P1_SEQUENCE.map((entry) => Object.freeze([
    entry.task,
    Object.freeze(["pnpm", "run", "--silent", entry.script]),
  ])),
);
