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
  // TCRN-CROSS-STORY-359: `test` is the widest leg and now the only one that runs the
  // suite. Every subset verb this roster used to carry -- test-trust, roots, and the
  // ticket-numbered focus verbs -- filtered the same `tests/**/*.test.mjs` set this one
  // runs unfiltered, so removing them retired convenience, not coverage.
  { task: "test", script: "test" },
  // `portal` is the one entry whose script does not dispatch through task.mjs: both the
  // verb and `verify:portal` run scripts/verify-portal.mjs directly. Declared here rather
  // than special-cased in the test, so the exception is visible where the roster is read.
  { task: "portal", script: "verify:portal", dispatchesThroughTask: false },
  { task: "source", script: "verify:source" },
  // `archive` stays on the roster because `privacy` below scans the source archive when
  // one is present and silently scans less when it is not. Dropping the producer would
  // have narrowed the privacy surface without any gate saying so.
  { task: "archive", script: "archive" },
  { task: "no-sibling-dependency", script: "verify:no-sibling-dependency" },
  { task: "offline", script: "verify:offline" },
  // TCRN-CROSS-STORY-359: the toolchain aggregate. It ran runtime, licenses and
  // lifecycle before; it now also runs the dependency-graph and Git-history checks that
  // had their own roster entries. The checks are the same code on the same inputs -- what
  // was retired is three more `verify:*` names for them, not the assertions.
  { task: "governance", script: "verify:governance" },
  { task: "privacy", script: "verify:privacy" },
  { task: "verification-map", script: "verify:map" },
  // STORY-301: last, because it measures the tree the gates above just proved, and
  // because a budget that runs first would judge a build nobody had checked yet.
  { task: "budget", script: "verify:budget" },
  // TCRN-CROSS-INC-232: after the budget, because it is the cheapest leg in the train
  // and ordering it early would delay every expensive gate behind a documentation
  // question. It exists because a published code of conduct spent a day telling readers
  // the authoritative text was at a path that did not exist, and every gate above was
  // green throughout -- nothing here had ever checked a documentation link.
  { task: "links", script: "verify:links" },
  { task: "retrieval-eval", script: "verify:retrieval-eval" },
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
