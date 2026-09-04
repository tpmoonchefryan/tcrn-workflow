// SPDX-License-Identifier: Apache-2.0
// STORY-342/343: verification-map semantics and storage-layout documentation.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { INIT049_FOCUSED_CLAIM_COUNT, INIT049_FOCUSED_CLAIM_NAMES, INIT049_FOCUSED_CLAIMS } from "../scripts/init049-focused-claims.mjs";

const engineRoot = fileURLToPath(new URL("../", import.meta.url));

test("STORY-342 every INIT-048 story claim has an independent command, reason code, and red leg", async () => {
  const map = JSON.parse(await readFile(resolve(engineRoot, "verification-map.yaml"), "utf8"));
  const stories = map.claims.filter((claim) => /^INIT048-STORY-\d+$/u.test(claim.id));
  assert.equal(stories.length, 16);
  assert.equal(new Set(stories.map((claim) => claim.command)).size, 16);
  assert.equal(new Set(stories.map((claim) => claim.expectedReasonCode)).size, 16);
  assert.equal(new Set(stories.map((claim) => claim.redLeg.test)).size, 16);
  const single = map.claims.find((claim) => claim.id === "P3-ENGINE-SINGLE-REPLAY-PIPELINE");
  const incremental = map.claims.find((claim) => claim.id === "P3-ENGINE-INCREMENTAL-REPLAY");
  assert.match(single.subject, /snapshot.*tail/u);
  assert.match(incremental.subject, /snapshot.*tail/u);
});

test("STORY-343 engine documents describe segmented events, replay snapshots, and body migration", async () => {
  // TCRN-CROSS-INC-274: Cross-repository assertions on tcrn-workflow-helper documentation
  // have been removed. This test originally verified both engine and helper repository
  // documentation as a unit. The helper assertions violated AGENTS.md section 五
  // (cross-repository dependency prohibition): "A repository never reaches into a sibling's
  // tree... The test is whether this repository behaves differently when the other one is
  // absent." These tests failed in GitHub Actions (where the sibling is not checked out)
  // and kept CI red for twelve days.
  //
  // What was removed:
  // - Assertions on 6 tcrn-workflow-helper documentation files (SKILL.md and 5 references)
  // - A table defining required layout tokens in each helper file
  // - The helperRoot path binding and corresponding file-read loop
  //
  // Coverage is not lost: the same assertions belong in the tcrn-workflow-helper repository,
  // which owns those documents. Moving this verification into the helper repository as
  // follow-up work (not in scope for this change) is tracked on TCRN-CROSS-INC-274.
  const engineFiles = [
    "packages/core/spec/knowledge-core-v1.md",
    "docs/architecture/backup-git-tier.md",
    "docs/architecture/backup-restore-runbook.md",
    "docs/architecture/rc5-compatibility.md",
    "docs/adr/0005-segmented-local-backend.md",
  ];
  for (const relative of engineFiles) {
    const text = await readFile(resolve(engineRoot, relative), "utf8");
    assert.match(text, /(?:segment|snapshot|body)/iu, relative);
  }
});

test("STORY-352 P3 and Knowledge claims have independent focused commands and expectations", async () => {
  const map = JSON.parse(await readFile(resolve(engineRoot, "verification-map.yaml"), "utf8"));
  assert.equal(INIT049_FOCUSED_CLAIM_NAMES.length, INIT049_FOCUSED_CLAIM_COUNT);
  const claims = map.claims.filter((claim) => INIT049_FOCUSED_CLAIM_NAMES.includes(claim.command.replace(/^pnpm verify:/u, "")));
  assert.equal(claims.length, INIT049_FOCUSED_CLAIM_NAMES.length);
  assert.equal(new Set(claims.map((claim) => claim.command)).size, claims.length);
  assert.equal(new Set(claims.map((claim) => claim.expectedReasonCode)).size, claims.length);
  assert.equal(new Set(claims.map((claim) => claim.redLeg.test)).size, claims.length);
  for (const claim of claims) {
    const name = claim.command.replace(/^pnpm verify:/u, "");
    const spec = INIT049_FOCUSED_CLAIMS[name];
    assert.equal(claim.expectedReasonCode, spec.reasonCode, name);
    assert.equal(claim.redLeg.test, spec.pattern, name);
    assert.ok(claim.fixturePaths.includes(spec.path), `${name} must name its focused test file`);
  }
});
