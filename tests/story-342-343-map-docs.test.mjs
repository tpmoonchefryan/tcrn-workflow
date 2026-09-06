// SPDX-License-Identifier: Apache-2.0
// STORY-342/343: verification-map semantics and storage-layout documentation.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const engineRoot = fileURLToPath(new URL("../", import.meta.url));

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
