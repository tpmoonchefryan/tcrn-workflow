#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { runCli } from "../dist/build/packages/cli/src/index.js";

try {
  await runCli(process.argv.slice(2), {
    write: (value) => process.stdout.write(value),
    // WSE-4: the outermost layer supplies the wall-clock reader. It exists only here,
    // never inside library code, so --attest-dir advisory time receipts read the real
    // clock in production while every hermetic runCli caller injects a fixed instant or
    // omits it (in which case --attest-dir fails closed rather than falling through).
    clock: () => new Date().toISOString(),
  });
} catch (error) {
  const reasonCode = typeof error?.reasonCode === "string" ? error.reasonCode : "CLI_INTERNAL_ERROR";
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
}
