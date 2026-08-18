#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INIT-029/S252: reconcile the shipped snapshot, its inline portal copy, and
// the Design System source when that source is available. A missing source is
// explicit unverified state, never a green or skipped reconciliation.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { extractTcrnComponentCss } from "./generate-ds-component-css-snapshot.mjs";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SNAPSHOT_PATH = resolve(
  process.env.TCRN_DS_COMPONENT_CSS_SNAPSHOT ?? join(REPOSITORY_ROOT, "portal/ds-component-css.snapshot.css"),
);
export const INDEX_PATH = resolve(
  process.env.TCRN_DS_COMPONENT_CSS_INDEX ?? join(REPOSITORY_ROOT, "portal/index.html"),
);
export const DESIGN_SYSTEM_ROOT = resolve(
  process.env.TCRN_DESIGN_SYSTEM_ROOT ?? join(REPOSITORY_ROOT, "..", "TCRN-Design-System"),
);
export const DESIGN_SYSTEM_SOURCE = resolve(
  process.env.TCRN_DS_COMPONENT_CSS_SOURCE
    ?? join(DESIGN_SYSTEM_ROOT, "packages/ui-react/src/components/Navigation/Navigation.tsx"),
);
export const INLINE_MARKER = '<style id="tcrn-ds-component-css" data-source="snapshot">';

const digest = (text) => createHash("sha256").update(text).digest("hex");
const relativePath = (path) => relative(REPOSITORY_ROOT, path).replaceAll("\\", "/");

export function extractInlineSnapshot(source) {
  const pattern = /<style id="tcrn-ds-component-css" data-source="snapshot">([\s\S]*?)<\/style>/u;
  const match = source.match(pattern);
  if (!match) throw new Error("DS_COMPONENT_CSS_INLINE_MARKER_NOT_FOUND");
  return match[1];
}

export async function reconcile({ snapshotPath = SNAPSHOT_PATH, indexPath = INDEX_PATH, sourcePath = DESIGN_SYSTEM_SOURCE } = {}) {
  const snapshot = await readFile(snapshotPath, "utf8");
  const index = await readFile(indexPath, "utf8");
  const inline = extractInlineSnapshot(index);
  const inlineMatches = inline === snapshot;

  let source = null;
  let sourceStatus = "unverified";
  try {
    source = extractTcrnComponentCss(await readFile(sourcePath, "utf8"));
    sourceStatus = "verified";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const sourceMatches = source === null ? null : source === snapshot;
  const sourceReconciled = sourceMatches === true;
  const inlineReconciled = inlineMatches;
  // TCRN-CROSS-INC-223. The verdict reads the inline leg alone. Both legs used to
  // decide it, which made a sibling repository's working tree this gate's baseline:
  // someone edits the Design System, this repository's own bytes do not move, and its
  // P1 goes red — taking the sixteen gates behind it down with it. Worse, the verdict
  // was host-dependent, since CI has no sibling checkout and therefore always found
  // the snapshot self-sufficient while a developer machine did not. "Does this tree
  // agree with itself" is what this repository owns and can answer identically
  // everywhere; "has the Design System moved on" is real and worth reporting, so it
  // is reported — as an observation beside the verdict, never inside it. The refresh
  // it calls for is triggered from the Design System side (design-authority-convention).
  const ok = inlineReconciled;
  const reasonCode = !inlineReconciled
    ? "DS_COMPONENT_CSS_INLINE_DRIFT"
    : source === null
      ? "DS_COMPONENT_CSS_SNAPSHOT_SELF_SUFFICIENT"
      : sourceReconciled
        ? "DS_COMPONENT_CSS_RECONCILED"
        : "DS_COMPONENT_CSS_INLINE_RECONCILED";

  return {
    ok,
    reasonCode,
    observations: sourceMatches === false
      ? [{
        reasonCode: "DS_COMPONENT_CSS_SOURCE_DRIFT",
        source: relativePath(sourcePath),
        sourceSha256: digest(source),
        snapshotSha256: digest(snapshot),
        remedy: "node scripts/generate-ds-component-css-snapshot.mjs && node scripts/embed-ds-component-css-snapshot.mjs",
      }]
      : [],
    snapshot: {
      path: relativePath(snapshotPath),
      bytes: Buffer.byteLength(snapshot),
      sha256: digest(snapshot),
    },
    inline: {
      path: relativePath(indexPath),
      marker: INLINE_MARKER,
      bytes: Buffer.byteLength(inline),
      sha256: digest(inline),
      matchesSnapshot: inlineReconciled,
    },
    reconciliation: {
      source: relativePath(sourcePath),
      sourceStatus,
      sourceBytes: source === null ? null : Buffer.byteLength(source),
      sourceSha256: source === null ? null : digest(source),
      sourceMatchesSnapshot: sourceMatches,
      // Renamed from countedAsGreen: since INC-223 this is precisely the quantity that
      // is *not* counted toward the verdict, and a field whose name says the opposite
      // is the shape this platform has paid for more than once.
      sourceReconciled,
      ...(source === null ? { note: "run reconciliation on the platform that holds the Design System source" } : {}),
    },
  };
}

export async function main() {
  const report = await reconcile();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
