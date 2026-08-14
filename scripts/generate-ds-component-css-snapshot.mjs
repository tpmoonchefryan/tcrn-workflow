#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INIT-029/S252: materialise the Design System's public CSS export as a
// checked-in, runtime-local snapshot. The portal never imports the package.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DESIGN_SYSTEM_ROOT = resolve(
  process.env.TCRN_DESIGN_SYSTEM_ROOT ?? join(REPOSITORY_ROOT, "..", "TCRN-Design-System"),
);
export const DESIGN_SYSTEM_SOURCE = join(
  DESIGN_SYSTEM_ROOT,
  "packages/ui-react/src/components/Navigation/Navigation.tsx",
);
export const SNAPSHOT_PATH = join(REPOSITORY_ROOT, "portal/ds-component-css.snapshot.css");
export const INLINE_MARKER = '<style id="tcrn-ds-component-css" data-source="snapshot">';

export function extractTcrnComponentCss(source) {
  const match = source.match(/export const tcrnComponentCss = `([\s\S]*?)`;/u);
  if (!match) throw new Error("DS_COMPONENT_CSS_EXPORT_NOT_FOUND");
  if (match[1].includes("${")) throw new Error("DS_COMPONENT_CSS_EXPORT_HAS_INTERPOLATION");
  return match[1];
}

export function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function relativePath(path) {
  return relative(REPOSITORY_ROOT, path).replaceAll("\\", "/");
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  let source;
  try {
    source = extractTcrnComponentCss(await readFile(DESIGN_SYSTEM_SOURCE, "utf8"));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reasonCode: error?.code === "ENOENT" ? "DS_COMPONENT_CSS_SOURCE_ABSENT" : String(error?.message ?? error),
      source: relativePath(DESIGN_SYSTEM_SOURCE),
    })}\n`);
    process.exitCode = 1;
    return;
  }

  if (checkOnly) {
    const snapshot = await readFile(SNAPSHOT_PATH, "utf8");
    const matches = snapshot === source;
    process.stdout.write(`${JSON.stringify({
      ok: matches,
      reasonCode: matches ? "DS_COMPONENT_CSS_SNAPSHOT_MATCHES_SOURCE" : "DS_COMPONENT_CSS_SNAPSHOT_DRIFTED",
      source: relativePath(DESIGN_SYSTEM_SOURCE),
      snapshot: relativePath(SNAPSHOT_PATH),
      sourceBytes: Buffer.byteLength(source),
      snapshotBytes: Buffer.byteLength(snapshot),
      sourceSha256: digest(source),
      snapshotSha256: digest(snapshot),
    })}\n`);
    if (!matches) process.exitCode = 1;
    return;
  }

  await writeFile(SNAPSHOT_PATH, source, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    reasonCode: "DS_COMPONENT_CSS_SNAPSHOT_WRITTEN",
    source: relativePath(DESIGN_SYSTEM_SOURCE),
    snapshot: relativePath(SNAPSHOT_PATH),
    bytes: Buffer.byteLength(source),
    sha256: digest(source),
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
