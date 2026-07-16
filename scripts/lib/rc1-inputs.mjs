// SPDX-License-Identifier: Apache-2.0

// PRG-0 normative-input-set synchronizer (library). The RC1 proof basis pins the
// exact set of normative inputs (scripts/policy/rc1-inputs.json), enforced by
// verify:rc1 (RC1_INPUT_SET_MISMATCH) and verify:p2. `generate:proof-artifacts`
// recomputes every fixtureDigest and the RC1 basis digest but does NOT rewrite
// the normative-input SET, so adding or removing any schema/spec/fixture file
// leaves this policy stale until this synchronizer runs. Discovery mirrors
// scripts/lib/proof-artifacts.mjs `normativePaths` exactly; the policy is stored
// in canonical (compareCanonicalText) order — the same normal form verification
// canonicalizes to before comparing.

import { open, rename, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { compareCanonicalText } from "./canonical-order.mjs";
import { repositoryRoot, toPosixPath, walkFiles } from "./files.mjs";

export const rc1InputsPolicyPath = "scripts/policy/rc1-inputs.json";

export function isNormativeInput(path) {
  return path === "extensions/aos-requirements-v1.json" ||
    path.startsWith("schemas/") ||
    path.startsWith("specs/") ||
    (path.startsWith("fixtures/") && !path.startsWith("fixtures/rc1/")) ||
    path === "verification-map.yaml";
}

export async function discoverNormativeInputs(root = repositoryRoot) {
  const files = await walkFiles(root);
  return files
    .map((path) => toPosixPath(relative(root, path)))
    .filter(isNormativeInput)
    .sort(compareCanonicalText);
}

export function renderRc1InputsPolicy(normativeInputs) {
  return `${JSON.stringify({ normativeInputs }, null, 2)}\n`;
}

async function readCurrent(absolute) {
  try {
    const handle = await open(absolute, "r");
    try {
      return (await handle.readFile()).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(absolute, content) {
  const stagingPath = `${absolute}.regen-rc1-inputs.tmp`;
  await rm(stagingPath, { force: true });
  const handle = await open(stagingPath, "wx", 0o644);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(stagingPath, absolute);
}

// mode: "write" rewrites the policy when stale (idempotent); "check" reports
// staleness without writing. Returns a canonical receipt.
export async function syncRc1Inputs({ root = repositoryRoot, mode = "write" } = {}) {
  if (mode !== "write" && mode !== "check") {
    throw new Error(`RC1_INPUTS_MODE_INVALID: ${mode}`);
  }
  const absolute = resolve(root, rc1InputsPolicyPath);
  const normativeInputs = await discoverNormativeInputs(root);
  const rendered = renderRc1InputsPolicy(normativeInputs);
  const current = await readCurrent(absolute);
  const stale = current !== rendered;
  if (mode === "write" && stale) {
    await atomicWrite(absolute, rendered);
  }
  const reasonCode = mode === "check"
    ? (stale ? "RC1_INPUTS_STALE" : "RC1_INPUTS_CURRENT")
    : (stale ? "RC1_INPUTS_REWRITTEN" : "RC1_INPUTS_CURRENT");
  return { ok: mode === "write" || !stale, mode, reasonCode, stale, inputs: normativeInputs.length };
}
