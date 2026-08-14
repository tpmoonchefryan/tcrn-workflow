// SPDX-License-Identifier: Apache-2.0
// The three portal proofs run as one step. They used to be a `&&` chain inside the
// package script, which the offline-boundary gate reads as a shell conjunction: a
// script body that is a command line rather than a command is a place where an
// injected argument becomes an injected command. The ordering is the same, the
// first failure still stops the run, and the exit status still belongs to the step
// that produced it.
import { spawnSync } from "node:child_process";

const proofs = ["design-proof.mjs", "i18n-proof.mjs", "dependency-audit.mjs"];

for (const proof of proofs) {
  const result = spawnSync(process.execPath, [`portal/scripts/${proof}`], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
