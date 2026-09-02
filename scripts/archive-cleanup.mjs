// SPDX-License-Identifier: Apache-2.0
// STORY-338: destructive archive cleanup. Baseline and target checks happen in
// this engine-owned command before any removal is attempted.

import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const LATEST_CHAIN_SNAPSHOT = "chain-snapshot-20260816T132815656Z.tar.gz";
export const APPROVED_ARCHIVE_DELETIONS = Object.freeze([
  "outer-git-backup-20260615",
  "appsupport-legacy-2026-07",
  "premove-backup-2026-08-12",
  "vacated-container-2026-08-12",
  "inc249-filter-probe-20260823",
  "inc249-pre-filter-20260823.bundle",
  "aos-stalled-worktree-20260817",
  "chain-backup-20260813T170751Z",
  "helper-trust-backup-20260814T101401Z",
  "helper-trust-backup-20260816T232323Z",
]);

async function sizeAndMtime(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return { bytes: info.size, mtimeMs: info.mtimeMs };
  if (info.isFile()) return { bytes: info.size, mtimeMs: info.mtimeMs };
  if (!info.isDirectory()) return { bytes: info.size, mtimeMs: info.mtimeMs };
  const children = await readdir(path);
  let bytes = 0;
  let mtimeMs = info.mtimeMs;
  for (const child of children) {
    const nested = await sizeAndMtime(resolve(path, child));
    bytes += nested.bytes;
    mtimeMs = Math.max(mtimeMs, nested.mtimeMs);
  }
  return { bytes, mtimeMs };
}

export async function archiveBaseline(archiveRoot) {
  const root = resolve(archiveRoot);
  const entries = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const size = await sizeAndMtime(resolve(root, entry.name));
    entries.push({ name: entry.name, ...size });
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return { schemaVersion: "tcrn.archive-cleanup-baseline.v1", entries };
}

function assertBaselineTargets(baseline) {
  if (baseline?.schemaVersion !== "tcrn.archive-cleanup-baseline.v1" || !Array.isArray(baseline.entries)) throw new Error("ARCHIVE_BASELINE_INVALID");
  const names = new Set(baseline.entries.map((entry) => entry?.name));
  for (const name of APPROVED_ARCHIVE_DELETIONS) if (!names.has(name)) throw new Error(`ARCHIVE_BASELINE_TARGET_MISSING:${name}`);
  if (!names.has("chain-snapshots")) throw new Error("ARCHIVE_BASELINE_TARGET_MISSING:chain-snapshots");
}

export async function applyArchiveCleanup(archiveRoot, baseline) {
  assertBaselineTargets(baseline);
  const current = await archiveBaseline(archiveRoot);
  if (JSON.stringify(current) !== JSON.stringify(baseline)) throw new Error("ARCHIVE_BASELINE_CHANGED");
  const root = resolve(archiveRoot);
  for (const name of APPROVED_ARCHIVE_DELETIONS) await rm(resolve(root, name), { recursive: true, force: false });
  const snapshots = resolve(root, "chain-snapshots");
  for (const entry of await readdir(snapshots, { withFileTypes: true })) {
    if (entry.name !== LATEST_CHAIN_SNAPSHOT) await rm(resolve(snapshots, entry.name), { recursive: true, force: false });
  }
  return archiveBaseline(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  const archiveRoot = process.argv[3];
  const output = process.argv[4];
  try {
    if (mode === "baseline") {
      if (!archiveRoot || !output) throw new Error("ARCHIVE_CLEANUP_INPUT_INVALID");
      await writeFile(resolve(output), `${JSON.stringify(await archiveBaseline(archiveRoot))}\n`, "utf8");
      process.stdout.write(JSON.stringify({ ok: true, reasonCode: "ARCHIVE_BASELINE_RECORDED" }) + "\n");
    } else if (mode === "apply") {
      if (!archiveRoot || !output) throw new Error("ARCHIVE_CLEANUP_INPUT_INVALID");
      const baseline = JSON.parse(await readFile(resolve(output), "utf8"));
      process.stdout.write(JSON.stringify({ ok: true, reasonCode: "ARCHIVE_CLEANUP_APPLIED", remaining: (await applyArchiveCleanup(archiveRoot, baseline)).entries.map((entry) => entry.name) }) + "\n");
    } else throw new Error("ARCHIVE_CLEANUP_MODE_INVALID");
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, reasonCode: error?.message?.split(":")[0] ?? "ARCHIVE_CLEANUP_FAILED" }) + "\n");
    process.exitCode = 1;
  }
}
