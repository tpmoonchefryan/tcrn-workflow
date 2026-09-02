// SPDX-License-Identifier: Apache-2.0
// STORY-338/339: archive cleanup and bidirectional container inventory.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { inspectArchiveInventory, parseArchiveInventory } from "../scripts/archive-inventory.mjs";

const containerRoot = fileURLToPath(new URL("../../../", import.meta.url));
const archiveRoot = resolve(containerRoot, ".tcrn-artifacts");
const agentsPath = resolve(containerRoot, "AGENTS.md");

test("STORY-338 cleanup leaves only the approved archive inventory and the newest chain snapshot", async () => {
  const document = await (await import("node:fs/promises")).readFile(agentsPath, "utf8");
  const entries = parseArchiveInventory(document);
  const result = await inspectArchiveInventory(archiveRoot, entries);
  assert.equal(result.ok, true, JSON.stringify(result));
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
