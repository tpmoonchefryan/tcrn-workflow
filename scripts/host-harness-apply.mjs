#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-220 — write one host's harness file at that host's installation root.
//
//   node scripts/host-harness-apply.mjs --host codex --root <installation-root>
//
// Owner ruled that a host comes under the harness when it installs its adapter, and that
// each host manages its own. This is that act, kept separate from the roster so the safe
// operation (rendering and comparing) is what runs by default and writing is explicit.
//
// Claude is deliberately not writable here. Its harness lives inside a settings file that
// also carries user-owned keys and, on this platform, is read by a live session; a
// generator that rewrites it underneath a running session would be a worse failure than
// the drift it corrects. `scripts/host-harness.mjs` reports Claude drift instead, and a
// human applies it.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { REPO_ROOT, codexHookDocument } from "./host-harness.mjs";

export const CODEX_HARNESS_PATH = ".codex/hooks.json";

/** Canonical bytes for a host's harness file: sorted keys, one trailing newline. */
export function harnessBytes(host, repoRoot = REPO_ROOT) {
  if (host !== "codex") throw Object.assign(new Error(`no writable harness renderer for ${host}`), { reasonCode: "HOST_HARNESS_NOT_WRITABLE" });
  return `${JSON.stringify(codexHookDocument(repoRoot), null, 2)}\n`;
}

export function applyHostHarness(host, installationRoot, { repoRoot = REPO_ROOT } = {}) {
  const target = resolve(installationRoot, CODEX_HARNESS_PATH);
  const bytes = harnessBytes(host, repoRoot);
  const existing = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (existing === bytes) {
    return { ok: true, reasonCode: "HOST_HARNESS_ALREADY_CURRENT", host, path: target, wrote: false };
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // Written beside the target and renamed, so a host reading the file never sees a partial
  // document — a half-written hooks.json is a host with an unparseable harness.
  const temporary = join(dirname(target), `.hooks.json.${process.pid}.tmp`);
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  renameSync(temporary, target);
  return {
    ok: true,
    reasonCode: existing === null ? "HOST_HARNESS_WRITTEN" : "HOST_HARNESS_UPDATED",
    host,
    path: target,
    wrote: true,
    previousBytes: existing === null ? 0 : Buffer.byteLength(existing),
    bytes: Buffer.byteLength(bytes),
  };
}

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 || index + 1 >= process.argv.length ? null : process.argv[index + 1];
}

if (process.argv[1]?.endsWith("host-harness-apply.mjs")) {
  const host = flag("host");
  const root = flag("root");
  if (host === null || root === null) {
    process.stderr.write("usage: host-harness-apply.mjs --host <codex> --root <installation-root>\n");
    process.exitCode = 64;
  } else {
    try {
      const result = applyHostHarness(host, root);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: error?.reasonCode ?? "HOST_HARNESS_APPLY_FAILED", error: error?.message })}\n`);
      process.exitCode = 1;
    }
  }
}
