// S6 assertion-discrimination gate — TCRN-CROSS-INC-034 / INC-035.
//
// This replaces the promptfoo-backed "deterministic subset" that ran on every
// push. That one asserted a canned fixture contained a substring of itself (see
// the corpus header), so it could not fail; it also dragged promptfoo — 686
// packages including a browser and an ML runtime — into an engine repository
// whose dependency policy freezes the graph at a handful of identities, each
// carrying an integrity hash and a stated acquisition boundary.
//
// What is claimed here is narrower and true: the markers DISCRIMINATE. A correct
// decision passes; the anti-pattern that was actually taken when the lesson was
// learned fails, and fails for the marker the lesson names. Behaviour against a
// real model is a different claim with a different gate (s6-models.yaml, release
// time, its own credential) — and this test guards that gate's corpus stays in
// step with this one.
//
//   node --test tests/s6-lessons.test.mjs        (also: pnpm verify:s6)

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { LESSONS, evaluateDecision } from "./fixtures/s6-lessons/corpus.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_CONFIG = resolve(REPO_ROOT, "tests/promptfoo/s6-lessons/s6-models.yaml");

test("the corpus is well formed on both sides", () => {
  assert.ok(LESSONS.length >= 6, "at least the six lessons this was built for");
  const ids = new Set();
  for (const lesson of LESSONS) {
    assert.ok(!ids.has(lesson.id), `duplicate lesson id ${lesson.id}`);
    ids.add(lesson.id);
    for (const field of ["source", "scenario", "goodDecision", "antiPattern"]) {
      assert.ok(typeof lesson[field] === "string" && lesson[field].length > 0, `${lesson.id}.${field}`);
    }
    assert.ok(lesson.mustContain.length > 0, `${lesson.id} states no positive marker`);
    assert.ok(lesson.mustNotContain.length > 0,
      `${lesson.id} states no anti-pattern marker — without one the predicate degrades to bare substring matching, `
      + "which 「不要继续」 satisfies for a 「继续」 marker");
    // Disjoint markers: a string that is required and forbidden at once makes the
    // predicate unsatisfiable, which is the mirror image of the ever-green fault.
    for (const positive of lesson.mustContain) {
      assert.ok(!lesson.mustNotContain.includes(positive),
        `${lesson.id}: ${positive} is both required and forbidden`);
    }
  }
});

test("a correct decision passes every lesson", () => {
  for (const lesson of LESSONS) {
    const verdict = evaluateDecision(lesson, lesson.goodDecision);
    assert.ok(verdict.ok,
      `${lesson.id}: the good decision did not pass (missing ${verdict.missing}, forbidden ${verdict.forbidden})`);
  }
});

test("the anti-pattern fails every lesson — this is the discrimination claim", () => {
  for (const lesson of LESSONS) {
    const verdict = evaluateDecision(lesson, lesson.antiPattern);
    assert.equal(verdict.ok, false,
      `${lesson.id}: the anti-pattern passed, so these markers cannot tell the two worlds apart`);
    assert.ok(verdict.missing.length > 0 || verdict.forbidden.length > 0,
      `${lesson.id}: failed without naming a marker`);
  }
});

test("both directions of the predicate are exercised across the corpus", () => {
  // A corpus where every anti-pattern fails only by absence never exercises the
  // negation half, and the mustNotContain markers would be decoration. At least
  // one lesson must be decided by each half.
  const byForbidden = LESSONS.filter((l) => evaluateDecision(l, l.antiPattern).forbidden.length > 0);
  const byMissing = LESSONS.filter((l) => evaluateDecision(l, l.antiPattern).missing.length > 0);
  assert.ok(byForbidden.length > 0, "no lesson is decided by an anti-pattern marker");
  assert.ok(byMissing.length > 0, "no lesson is decided by a missing required marker");
});

test("the model gate's corpus has not drifted from this one", () => {
  // The release gate runs the same scenarios against a real model. If it drifts,
  // the offline gate stops guarding anything the release gate will assert. The
  // check is deliberately coarse — scenario text presence — because a stricter
  // parse would need a YAML dependency this repository does not carry.
  const yaml = readFileSync(MODEL_CONFIG, "utf8");
  for (const lesson of LESSONS) {
    assert.ok(yaml.includes(lesson.scenario),
      `${lesson.id}: its scenario is absent from s6-models.yaml — the two corpora have drifted`);
  }
});
