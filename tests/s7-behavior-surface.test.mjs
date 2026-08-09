// SPDX-License-Identifier: Apache-2.0
// S7 — engine behavior-surface golden samples (TCRN-CROSS-STORY-141).
//
// The engine's behavior surface is deterministic for a fixed input: same bytes in,
// same canonical JSON out, for as long as the engine's semantics hold. These tests
// pin that determinism — a golden snapshot compared full-value on every run — so a
// change to `adapter-generate` or `persona-render` that alters their output goes red
// instead of silently shipping a new behavior surface.
//
// Goldens live beside this test under fixtures/s7-golden/ as string modules (INC-034:
// as .json they were rewritten by this repository own formatter, which is the byte
// under test). The fixed inputs
// (inputs.mjs) are the single source for both the golden generator and this test, so
// the snapshot cannot drift from what the test asserts. Regenerate a golden ONLY when
// the behavior change is intended: update inputs if needed, re-run the generator
// (see docs/reports/init-018/S7/commands.md), and review the diff.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCodexAdapterBundle } from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";
import { adapterHost, adapterRequest, PERSONA_PROFILE_ID } from "./fixtures/s7-golden/inputs.mjs";
import { ADAPTER_GENERATE_GOLDEN } from "./fixtures/s7-golden/adapter-generate.golden.mjs";
import { PERSONA_RENDER_GOLDEN } from "./fixtures/s7-golden/persona-render.golden.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("adapter-generate: fixed input reproduces the golden bundle, full value", async () => {
  const request = adapterRequest();
  const bundle = generateCodexAdapterBundle(request, adapterHost(request));
  const actual = canonicalJson(bundle);
  assert.equal(actual.trim(), ADAPTER_GENERATE_GOLDEN);
});

test("persona-render: fixed profile-id reproduces the golden render, full value", async () => {
  const run = spawnSync(process.execPath,
    [join(REPO_ROOT, "scripts/tcrn-workflow.mjs"), "persona-render", "--profile-id", PERSONA_PROFILE_ID],
    { encoding: "utf8", cwd: REPO_ROOT });
  assert.equal(run.status, 0, `persona-render must succeed; stderr: ${run.stderr}`);
  assert.equal(run.stdout.trim(), PERSONA_RENDER_GOLDEN);
});

test("the goldens are self-consistent with the shared fixed inputs", async () => {
  // A golden that no longer matches its own generator is a stale snapshot, not a
  // behavior lock. Re-derive from the same inputs and require byte equality.
  const request = adapterRequest();
  const rederived = canonicalJson(generateCodexAdapterBundle(request, adapterHost(request)));
  assert.equal(rederived.trim(), ADAPTER_GENERATE_GOLDEN);
  assert.equal(PERSONA_PROFILE_ID, "profile:tcrn-mneme-v1");
});
