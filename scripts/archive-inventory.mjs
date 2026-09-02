// SPDX-License-Identifier: Apache-2.0
// INIT-048 / STORY-338 + STORY-339: the container archive inventory has one
// documented source and a bidirectional filesystem comparison.

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const ARCHIVE_INVENTORY_BEGIN = "<!-- ARCHIVE-INVENTORY:BEGIN -->";
export const ARCHIVE_INVENTORY_END = "<!-- ARCHIVE-INVENTORY:END -->";

export function parseArchiveInventory(document) {
  const start = document.indexOf(ARCHIVE_INVENTORY_BEGIN);
  const end = document.indexOf(ARCHIVE_INVENTORY_END, start + ARCHIVE_INVENTORY_BEGIN.length);
  if (start < 0 || end < 0 || end <= start) throw new Error("ARCHIVE_INVENTORY_BLOCK_MISSING");
  const block = document.slice(start + ARCHIVE_INVENTORY_BEGIN.length, end);
  const entries = [];
  for (const line of block.split("\n")) {
    const match = /^- `([^`]+)` — (.+)$/u.exec(line.trim());
    if (match === null) continue;
    entries.push({ name: match[1], description: match[2] });
  }
  if (entries.length === 0 || new Set(entries.map((entry) => entry.name)).size !== entries.length) throw new Error("ARCHIVE_INVENTORY_EMPTY_OR_DUPLICATE");
  return entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

export async function inspectArchiveInventory(archiveRoot, documentedEntries) {
  const actual = (await readdir(resolve(archiveRoot), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const documented = documentedEntries.map((entry) => entry.name).sort();
  const missingOnDisk = documented.filter((name) => !actual.includes(name));
  const undocumentedOnDisk = actual.filter((name) => !documented.includes(name));
  return {
    ok: missingOnDisk.length === 0 && undocumentedOnDisk.length === 0,
    actual,
    documented,
    missingOnDisk,
    undocumentedOnDisk,
  };
}

export async function inspectDocumentedArchive(archiveRoot, documentPath) {
  const document = await readFile(resolve(documentPath), "utf8");
  const entries = parseArchiveInventory(document);
  return inspectArchiveInventory(archiveRoot, entries);
}
