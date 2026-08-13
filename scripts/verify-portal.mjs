#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INC-140: the portal gates are one serial train.  The engine suite and the
// portal suite must never share an output session concurrently.

import { spawnSync } from "node:child_process";

const commands = [
  ["pnpm", ["portal:test"]],
  ["pnpm", ["portal:proof"]],
  [process.execPath, ["scripts/coverage-conservation.mjs"]],
  [process.execPath, ["tests/coverage-conservation.test.mjs"]],
  [process.execPath, ["scripts/coverage-conservation-proof.mjs"]],
  [process.execPath, ["scripts/verbatim-evidence-proof.mjs", "--check"]],
  [process.execPath, ["scripts/verbatim-evidence-meta-proof.mjs"]],
];

for (const [executable, args] of commands) {
  const result = spawnSync(executable, args, { stdio: "inherit", env: { ...process.env, npm_config_offline: "true" } });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
// The receipt names the interpreter as "node", never process.execPath: this output is
// pasted into evidence and printed in public CI logs, and execPath carries the runner's
// home directory. Execution above still uses the real interpreter.
const reportedName = (executable) => (executable === process.execPath ? "node" : executable);
process.stdout.write(JSON.stringify({ ok: true, reasonCode: "PORTAL_VERIFY_TRAIN_GREEN", commands: commands.map(([executable, args]) => [reportedName(executable), ...args]) }) + "\n");
