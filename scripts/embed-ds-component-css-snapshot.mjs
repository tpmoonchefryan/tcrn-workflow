#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INIT-029/S252: keep the runtime page self-contained by embedding the checked-in
// CSS snapshot in the shipped HTML. The marker is a real style element, not a
// comment or a runtime dependency.

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { INLINE_MARKER, REPOSITORY_ROOT, SNAPSHOT_PATH } from "./ds-component-css-reconcile.mjs";

export const INDEX_PATH = resolve(
  process.env.TCRN_DS_COMPONENT_CSS_INDEX ?? join(REPOSITORY_ROOT, "portal/index.html"),
);
const INLINE_PATTERN = /<style id="tcrn-ds-component-css" data-source="snapshot">[\s\S]*?<\/style>/u;

export async function sync({ snapshotPath = SNAPSHOT_PATH, indexPath = INDEX_PATH, write = true } = {}) {
  const snapshot = await readFile(snapshotPath, "utf8");
  if (snapshot.includes("</style>")) throw new Error("DS_COMPONENT_CSS_SNAPSHOT_CONTAINS_STYLE_CLOSE");
  const index = await readFile(indexPath, "utf8");
  const match = index.match(INLINE_PATTERN);
  if (!match) throw new Error("DS_COMPONENT_CSS_INLINE_MARKER_NOT_FOUND");
  const replacement = `${INLINE_MARKER}${snapshot}</style>`;
  const next = index.replace(INLINE_PATTERN, replacement);
  const matches = next === index;
  if (write && !matches) await writeFile(indexPath, next, "utf8");
  return { ok: true, reasonCode: matches ? "DS_COMPONENT_CSS_INLINE_MATCHES_SNAPSHOT" : "DS_COMPONENT_CSS_INLINE_WRITTEN", snapshotBytes: Buffer.byteLength(snapshot) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const checkOnly = process.argv.includes("--check");
    const result = await sync({ write: !checkOnly });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
