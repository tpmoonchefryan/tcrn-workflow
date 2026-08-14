// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectCrossRepoPrivacy } from "../scripts/cross-repo-privacy.mjs";

function syntheticManifest() {
  return {
    projects: [
      { name: "TCRN-AOS", pathTemplate: "<PLATFORM_ROOT>/TCRN-AOS" },
      { name: "joi-button", pathTemplate: "<PLATFORM_ROOT>/joi-button" },
    ],
  };
}

async function fixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tcrn-cross-repo-privacy-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["TCRN-AOS", "joi-button"]) await mkdir(join(root, name), { recursive: true });
  return root;
}

test("cross-repo privacy scans every manifest project, including exact lowercase joi-button, and stays green", async (context) => {
  const root = await fixture(context);
  await mkdir(join(root, "TCRN-AOS", ".claude"), { recursive: true });
  await writeFile(join(root, "TCRN-AOS", ".claude", "settings.json"), "${CLAUDE_PROJECT_DIR}/safe\n");
  const result = await inspectCrossRepoPrivacy(root, {
    manifest: syntheticManifest(),
    userName: "fixture-user",
    hostName: "fixture-host",
    governedHost: "fixture-governed-host",
  });
  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, "CROSS_REPO_PRIVACY_GREEN");
  assert.deepEqual(result.projects.map((project) => project.name), ["TCRN-AOS", "joi-button"]);
  assert.equal(result.projects.every((project) => project.ok), true);
});

test("cross-repo privacy red leg names an absolute path and an identity marker, then returns green after cleanup", async (context) => {
  const root = await fixture(context);
  await mkdir(join(root, "joi-button", ".tcrn-install-receipts"), { recursive: true });
  const receipt = join(root, "joi-button", ".tcrn-install-receipts", "claude.json");
  const syntheticUsersPath = join("/", "Users", "fixture-user", "Code", "joi-button");
  await writeFile(receipt, JSON.stringify({ realpath: syntheticUsersPath, host: "fixture-host" }));
  const options = { manifest: syntheticManifest(), userName: "fixture-user", hostName: "fixture-host", governedHost: "fixture-governed-host" };
  const red = await inspectCrossRepoPrivacy(root, options);
  assert.equal(red.ok, false);
  assert.equal(red.reasonCode, "CROSS_REPO_PRIVACY_LEAK");
  assert.deepEqual([...new Set(red.findings[0].findings.map((finding) => finding.reasonCode))].sort(), ["CROSS_REPO_ABSOLUTE_PATH", "CROSS_REPO_PRIVATE_IDENTITY"]);
  await writeFile(receipt, JSON.stringify({ digest: "synthetic-only" }));
  const green = await inspectCrossRepoPrivacy(root, options);
  assert.equal(green.ok, true);
  assert.equal(green.reasonCode, "CROSS_REPO_PRIVACY_GREEN");
});

test("cross-repo privacy requires a platform root", async () => {
  const result = await inspectCrossRepoPrivacy();
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PLATFORM_ROOT_REQUIRED");
});
