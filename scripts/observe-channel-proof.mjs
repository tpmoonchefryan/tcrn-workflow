// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-INC-121 — single-entry runner for the observe-channel proof.
// The offline boundary forbids shell conjunctions in package scripts, so the
// two steps that `verify:observe-channel` used to chain with `&&` run here
// sequentially instead, byte-identical arguments, first failure wins.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const steps = [
  [resolve(root, "scripts/breakglass-consistency-check.mjs")],
  [resolve(root, "scripts/ssh-write-observer.mjs"), "--verify-channel", "--project-dir", ".", "--project-dir", ".."],
];

for (const argv of steps) {
  const run = spawnSync(process.execPath, argv, { cwd: root, stdio: "inherit" });
  if (run.status !== 0) {
    process.exit(run.status ?? 1);
  }
}
