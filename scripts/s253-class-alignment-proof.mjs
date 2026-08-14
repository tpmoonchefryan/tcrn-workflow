#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// STORY-253: reproducible root-token count and alias-convergence evidence.

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const PORTAL = "portal/index.html";
const S252_REMOVED_PORTAL_ROOTS = new Set([
  "tcrn-button",
  "tcrn-field",
  "tcrn-input",
  "tcrn-textarea",
  "tcrn-sr-only",
]);

function portalOwnedStyle(source) {
  const styles = [...source.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gu)];
  if (styles.length === 0) throw new Error("PORTAL_OWNED_STYLE_BLOCK_MISSING");
  return styles.length === 1 ? styles[0][1] : styles[1][1];
}

function rootTokens(source) {
  const tokens = [...portalOwnedStyle(source).matchAll(/\.tcrn-[a-z0-9-]+/gu)]
    .map((match) => match[0].slice(1));
  return [...new Set(tokens)]
    .filter((name) => !name.includes("__") && !name.includes("--"))
    .sort();
}

const current = await readFile(PORTAL, "utf8");
const baseline = execFileSync("git", ["show", `HEAD:${PORTAL}`], { encoding: "utf8" });
const baselineRoots = rootTokens(baseline);
const afterS252Roots = baselineRoots.filter((name) => !S252_REMOVED_PORTAL_ROOTS.has(name));
const currentRoots = rootTokens(current);
const s253Removed = afterS252Roots.filter((name) => !currentRoots.includes(name));
const s253Added = currentRoots.filter((name) => !afterS252Roots.includes(name));

const result = {
  schemaVersion: "tcrn.inc253-class-alignment-proof.v1",
  metric: "unique portal-owned CSS class-root tokens; BEM parts and modifiers excluded",
  rootCounts: {
    handoverBaseline: baselineRoots.length,
    afterS252SnapshotDeduplication: afterS252Roots.length,
    afterS253Alignment: currentRoots.length,
  },
  s252RemovedSharedRoots: [...S252_REMOVED_PORTAL_ROOTS].sort(),
  s253RemovedAliases: s253Removed,
  s253AddedDsRoots: s253Added,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
