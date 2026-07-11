#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { runCli } from "../dist/build/packages/cli/src/index.js";

try {
  await runCli(process.argv.slice(2), { write: (value) => process.stdout.write(value) });
} catch (error) {
  const reasonCode = typeof error?.reasonCode === "string" ? error.reasonCode : "CLI_INTERNAL_ERROR";
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
}
