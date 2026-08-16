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
// TCRN-CROSS-INC-216. The second root used to be `..`, the classification folder, which
// the 2026-08-16 ruling emptied: harness is built at the container root and nowhere else.
// So this gate called the channel severed while it was running — the same shape as the
// two host locations in INC-212 and the stop-pact probe in INC-213. A ruling moved the
// subject; the gate went on asking where it used to be.
//
// `.` stays: the engine repository commits its own sanitised settings fixture, which
// INC-207 kept as the one surviving project-layer entry precisely so a doctor leg can
// tell an accounted-for directory from a stray.
const steps = [
  [resolve(root, "scripts/breakglass-consistency-check.mjs")],
  [resolve(root, "scripts/ssh-write-observer.mjs"), "--verify-channel", "--project-dir", ".", "--project-dir", "../.."],
];

for (const argv of steps) {
  const run = spawnSync(process.execPath, argv, { cwd: root, stdio: "inherit" });
  if (run.status !== 0) {
    process.exit(run.status ?? 1);
  }
}
