#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Thin CLI wrapper over scripts/lib/rc1-inputs.mjs. Run this, then
// `regen:map-digests`, whenever a normative file (schemas/, specs/, fixtures/
// outside fixtures/rc1/, extensions/aos-requirements-v1.json, verification-map.yaml)
// is added or removed, so scripts/policy/rc1-inputs.json tracks the exact set the
// RC1 proof basis pins. `--check` reports staleness without writing.

import { syncRc1Inputs } from "./lib/rc1-inputs.mjs";

const mode = (process.argv.slice(2).filter((argument) => argument !== "--")[0] ?? "write") === "--check" ? "check" : "write";

try {
  const receipt = await syncRc1Inputs({ mode });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (!receipt.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode: "RC1_INPUTS_INTERNAL_ERROR", error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
}
