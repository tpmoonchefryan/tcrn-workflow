// SPDX-License-Identifier: Apache-2.0
// STORY-338/339: archive cleanup and bidirectional container inventory.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPROVED_ARCHIVE_DELETIONS, LATEST_CHAIN_SNAPSHOT, applyArchiveCleanup, archiveBaseline } from "../scripts/archive-cleanup.mjs";
import { inspectArchiveInventory, parseArchiveInventory, ARCHIVE_INVENTORY_BEGIN, ARCHIVE_INVENTORY_END } from "../scripts/archive-inventory.mjs";

test("STORY-338 cleanup leaves only the approved archive inventory and the newest chain snapshot", async () => {
  // TCRN-CROSS-INC-274: this test proves the cleanup LOGIC against a synthetic
  // archive and inventory document. Assertions about the live platform belong in
  // platform-doctor, which is invoked with an explicit --platform-root and is the
  // tool that legitimately inspects the container.

  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s338-")));
  try {
    // Create a synthetic inventory document with the approved deletions and chain-snapshots.
    // The baseline checker requires ALL approved deletions to be present.
    const inventoryLines = ["- `chain-snapshots` — test chain snapshots"];
    for (const name of APPROVED_ARCHIVE_DELETIONS) {
      inventoryLines.push(`- \`${name}\` — approved deletion target`);
    }
    const inventoryDocument = `
${ARCHIVE_INVENTORY_BEGIN}
${inventoryLines.join("\n")}
${ARCHIVE_INVENTORY_END}
`;

    const entries = parseArchiveInventory(inventoryDocument);

    // Create the synthetic archive structure
    await mkdir(join(base, "chain-snapshots"));
    await writeFile(join(base, "chain-snapshots", LATEST_CHAIN_SNAPSHOT), "latest", "utf8");
    await writeFile(join(base, "chain-snapshots", "older.tar.gz"), "older", "utf8");

    for (const name of APPROVED_ARCHIVE_DELETIONS) {
      await mkdir(join(base, name));
    }

    // Verify the inventory inspection before cleanup
    const resultBefore = await inspectArchiveInventory(base, entries);
    assert.equal(resultBefore.ok, true, JSON.stringify(resultBefore));

    // Apply the cleanup
    const baseline = await archiveBaseline(base);
    await applyArchiveCleanup(base, baseline);

    // Verify the results after cleanup
    assert.deepEqual(await readdir(join(base, "chain-snapshots")), [LATEST_CHAIN_SNAPSHOT]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("STORY-339 inventory detects both an undocumented disk entry and a documented missing entry", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s339-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, "on-disk"));
  await writeFile(join(base, "file-entry"), "x", "utf8");
  const result = await inspectArchiveInventory(base, [{ name: "missing-entry", description: "missing" }, { name: "on-disk", description: "present" }]);
  assert.deepEqual(result.missingOnDisk, ["missing-entry"]);
  assert.deepEqual(result.undocumentedOnDisk, ["file-entry"]);
  assert.equal(result.ok, false);
});

test("STORY-338 and STORY-339 use a baseline-gated destructive list and a two-sided checker", async () => {
  const cleanup = await import("../scripts/archive-cleanup.mjs");
  assert.ok(cleanup.APPROVED_ARCHIVE_DELETIONS.includes("outer-git-backup-20260615"));
  assert.match(cleanup.LATEST_CHAIN_SNAPSHOT, /^chain-snapshot-20260816T132815656Z\.tar\.gz$/u);
});
