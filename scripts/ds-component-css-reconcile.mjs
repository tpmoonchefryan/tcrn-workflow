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
  const ok = inlineReconciled && (source === null || sourceReconciled);
  const reasonCode = !inlineReconciled
    ? "DS_COMPONENT_CSS_INLINE_DRIFT"
    : source === null
      ? "DS_COMPONENT_CSS_SOURCE_ABSENT"
      : sourceReconciled
        ? "DS_COMPONENT_CSS_RECONCILED"
        : "DS_COMPONENT_CSS_SOURCE_DRIFT";

  return {
    ok,
    reasonCode: ok && source === null ? "DS_COMPONENT_CSS_SNAPSHOT_SELF_SUFFICIENT" : reasonCode,
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
      countedAsGreen: sourceReconciled,
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
