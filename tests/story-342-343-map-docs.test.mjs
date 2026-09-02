// SPDX-License-Identifier: Apache-2.0
// STORY-342/343: verification-map semantics and storage-layout documentation.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const engineRoot = fileURLToPath(new URL("../", import.meta.url));
const helperRoot = resolve(engineRoot, "../tcrn-workflow-helper");

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

test("STORY-343 engine and helper documents describe segmented events, replay snapshots, and body migration", async () => {
  const helperFiles = [
    "skill/tcrn-workflow-helper/SKILL.md",
    "skill/tcrn-workflow-helper/references/platform-layout.md",
    "skill/tcrn-workflow-helper/references/workflow-operations.md",
    "skill/tcrn-workflow-helper/references/first-run-wizard.md",
    "skill/tcrn-workflow-helper/references/backup-elicitation.md",
    "skill/tcrn-workflow-helper/references/reason-codes.md",
  ];
  const requiredHelperLayout = {
    "skill/tcrn-workflow-helper/SKILL.md": ["New event", "history is canonical", "replay snapshot", "file-segmented", "Knowledge bodies", "time-attestation"],
    "skill/tcrn-workflow-helper/references/platform-layout.md": ["events/000001.ndjson", "000001.idx", "labels.idx", "time.idx", "snapshots/manifest.json", "metadata/<id>.json", "bodies/*.ndjson", "<eventHash>.json"],
    "skill/tcrn-workflow-helper/references/workflow-operations.md": ["events/*.ndjson", "snapshots/manifest.json", "same segmented form", "time-attestation"],
    "skill/tcrn-workflow-helper/references/first-run-wizard.md": ["events/*.ndjson", "snapshots/", "metadata/", "knowledge bodies"],
    "skill/tcrn-workflow-helper/references/backup-elicitation.md": ["snapshots/", "snapshot-manifest"],
    "skill/tcrn-workflow-helper/references/reason-codes.md": ["snapshot", "WORKSPACE_SNAPSHOT_INVALID"],
  };
  for (const relative of helperFiles) {
    const text = await readFile(resolve(helperRoot, relative), "utf8");
    assert.match(text, /(?:ndjson|segmented|snapshot|sidecar)/iu, relative);
    for (const token of requiredHelperLayout[relative]) assert.ok(text.includes(token), `${relative} is missing documented layout token ${token}`);
  }
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

test("STORY-343 documentation proof names the helper archive refresh as a required step", async () => {
  const helper = await readFile(resolve(helperRoot, "skill/tcrn-workflow-helper/references/settings-elicitation.md"), "utf8");
  assert.match(helper, /settings catalog|settings-set/u);
  const skill = await readFile(resolve(helperRoot, "skill/tcrn-workflow-helper/SKILL.md"), "utf8");
  assert.match(skill, /archive|release/iu);
});
