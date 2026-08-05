#!/usr/bin/env node
// S6 gate entry — TCRN-CROSS-STORY-148, reworked under TCRN-CROSS-INC-034/035.
//
// WHAT CHANGED AND WHY. This used to shell out to promptfoo against
// `s6-lessons.yaml`, whose provider returned the fixture's own canned answer and
// whose assertions then looked for a substring of that same answer. It could not
// fail, and it cost this repository 686 transitive packages — including a browser
// and an ML runtime — inside a dependency policy that freezes the graph at a
// handful of identities, each carrying an integrity hash and a stated acquisition
// boundary. `pnpm install` had begun refusing outright (ERR_PNPM_IGNORED_BUILDS on
// six native packages), so the gate meant to guard behaviour was itself the reason
// this repository's dependency gate was red.
//
// The deterministic claim that survives is narrower and true: the lesson markers
// DISCRIMINATE between a correct decision and the anti-pattern that was actually
// taken when each lesson was learned. That is a property of the corpus, provable
// offline with no dependency at all, and it is what runs here now.
//
// Behaviour against a real model is a different claim and keeps its own gate:
// `tests/promptfoo/s6-lessons/s6-models.yaml`, run at release time with a
// credential. promptfoo is deliberately NOT a dependency of this repository.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE = "tests/s6-lessons.test.mjs";

const child = spawnSync(process.execPath, ["--test", TEST_FILE], {
  cwd: REPO_ROOT,
  encoding: "utf8"
});

const passed = child.status === 0;
process.stdout.write(`${JSON.stringify({
  ok: passed,
  reasonCode: passed ? "S6_LESSON_MARKERS_DISCRIMINATE" : "S6_LESSON_MARKERS_DO_NOT_DISCRIMINATE",
  gate: "s6-lesson-discrimination",
  claim: "each lesson's markers pass a correct decision and reject the anti-pattern actually taken; "
    + "this is NOT a claim about model behaviour, which is s6-models.yaml's release-time gate",
  testFile: TEST_FILE,
  detail: passed ? null : (child.stdout || child.stderr || "").slice(-1200)
}, null, 2)}\n`);

process.exit(passed ? 0 : 1);
