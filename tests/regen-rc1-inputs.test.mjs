// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { compareCanonicalText } from "../scripts/lib/canonical-order.mjs";
import { repositoryRoot } from "../scripts/lib/files.mjs";
import {
  discoverNormativeInputs,
  isNormativeInput,
  rc1InputsPolicyPath,
  renderRc1InputsPolicy,
  syncRc1Inputs,
} from "../scripts/lib/rc1-inputs.mjs";

async function put(root, path, bytes) {
  await mkdir(resolve(root, path, ".."), { recursive: true });
  await writeFile(resolve(root, path), bytes, { mode: 0o600 });
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "tcrn-rc1-inputs-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  // Normative members (must be discovered), plus non-members that must be ignored.
  await put(root, "extensions/aos-requirements-v1.json", "{}\n");
  await put(root, "schemas/gate-v1.schema.json", "{}\n");
  await put(root, "schemas/event-integrity-v1.schema.json", "{}\n");
  await put(root, "specs/work-model-v1.md", "# spec\n");
  await put(root, "fixtures/protocol/example.json", "{}\n");
  await put(root, "verification-map.yaml", "claims\n");
  // Non-members: fixtures/rc1/*, and files outside the normative roots.
  await put(root, "fixtures/rc1/rc1-candidate-proof-manifest.json", "{}\n");
  await put(root, "scripts/policy/source-allowlist.json", "{}\n");
  await put(root, "packages/core/src/workspace.ts", "// code\n");
  await put(root, "README.md", "# readme\n");
  return root;
}

test("discovery filter admits exactly the normative roots", () => {
  assert.equal(isNormativeInput("extensions/aos-requirements-v1.json"), true);
  assert.equal(isNormativeInput("schemas/gate-v1.schema.json"), true);
  assert.equal(isNormativeInput("specs/work-model-v1.md"), true);
  assert.equal(isNormativeInput("fixtures/protocol/example.json"), true);
  assert.equal(isNormativeInput("verification-map.yaml"), true);
  // Non-members.
  assert.equal(isNormativeInput("fixtures/rc1/rc1-candidate-proof-manifest.json"), false);
  assert.equal(isNormativeInput("extensions/other.json"), false);
  assert.equal(isNormativeInput("scripts/policy/rc1-inputs.json"), false);
  assert.equal(isNormativeInput("packages/core/src/workspace.ts"), false);
  assert.equal(isNormativeInput("README.md"), false);
});

test("discovery is canonical-ordered and set-correct on a synthetic tree", async (context) => {
  const root = await fixture(context);
  const discovered = await discoverNormativeInputs(root);
  assert.deepEqual(discovered, [
    "extensions/aos-requirements-v1.json",
    "fixtures/protocol/example.json",
    "schemas/event-integrity-v1.schema.json",
    "schemas/gate-v1.schema.json",
    "specs/work-model-v1.md",
    "verification-map.yaml",
  ]);
  const resorted = [...discovered].sort(compareCanonicalText);
  assert.deepEqual(discovered, resorted);
});

test("write normalizes an unsorted policy then is idempotent", async (context) => {
  const root = await fixture(context);
  // Seed a policy in a non-canonical order with the correct set.
  await put(root, rc1InputsPolicyPath, `${JSON.stringify({ normativeInputs: [
    "verification-map.yaml",
    "schemas/gate-v1.schema.json",
    "schemas/event-integrity-v1.schema.json",
    "extensions/aos-requirements-v1.json",
    "specs/work-model-v1.md",
    "fixtures/protocol/example.json",
  ] }, null, 2)}\n`);

  const first = await syncRc1Inputs({ root, mode: "write" });
  assert.equal(first.reasonCode, "RC1_INPUTS_REWRITTEN");
  assert.equal(first.ok, true);

  const onDisk = await readFile(resolve(root, rc1InputsPolicyPath), "utf8");
  assert.equal(onDisk, renderRc1InputsPolicy(await discoverNormativeInputs(root)));

  const second = await syncRc1Inputs({ root, mode: "write" });
  assert.equal(second.reasonCode, "RC1_INPUTS_CURRENT");
  const checked = await syncRc1Inputs({ root, mode: "check" });
  assert.equal(checked.reasonCode, "RC1_INPUTS_CURRENT");
  assert.equal(checked.ok, true);
});

test("check reports staleness without writing", async (context) => {
  const root = await fixture(context);
  await put(root, rc1InputsPolicyPath, `${JSON.stringify({ normativeInputs: [] }, null, 2)}\n`);
  const checked = await syncRc1Inputs({ root, mode: "check" });
  assert.equal(checked.reasonCode, "RC1_INPUTS_STALE");
  assert.equal(checked.ok, false);
  // check must not mutate.
  const onDisk = await readFile(resolve(root, rc1InputsPolicyPath), "utf8");
  assert.equal(onDisk, `${JSON.stringify({ normativeInputs: [] }, null, 2)}\n`);
});

// CQ-00 PATCH 9 proof: the wrapper's mode arbitration guards a DESTRUCTIVE write path
// (no argument rewrites the pinned RC1 basis in place). A mistyped mode flag must be an
// explicit usage failure, never a silent fall-through to write. Spawning the real CLI is
// the only way to exercise the arbitration, which lives in the wrapper, not the library.
for (const argument of ["--chck", "check", "-check", "--write"]) {
  test(`regen-rc1-inputs rejects the unknown argument ${argument} without writing`, () => {
    const result = spawnSync(process.execPath, [resolve(repositoryRoot, "scripts/regen-rc1-inputs.mjs"), argument], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).reasonCode, "RC1_INPUTS_MODE_INVALID");
    assert.equal(result.stdout, "");
  });
}

test("committed rc1-inputs policy is canonical and complete", async () => {
  // Guards against drift: the checked-in normative-input set must equal a fresh
  // canonical discovery, so verify:rc1 / verify:p2 never fail on a stale set.
  const rendered = renderRc1InputsPolicy(await discoverNormativeInputs(repositoryRoot));
  const committed = await readFile(resolve(repositoryRoot, rc1InputsPolicyPath), "utf8");
  assert.equal(committed, rendered);
});
