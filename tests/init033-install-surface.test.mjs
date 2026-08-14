// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  INSTALL_MANIFEST_VERSION,
  assertInstallManifestComplete,
  readInstallManifest,
} from "../dist/build/packages/core/src/index.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";

const forbiddenPathPattern = new RegExp("(?:/" + "Users/|/" + "home/|[A-Z]:\\\\)", "u");

async function cliJson(arguments_) {
  let output = "";
  await runCli(arguments_, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

test("S261 install manifest is closed, placeholder-only, and complete", async () => {
  const manifest = readInstallManifest();
  assert.equal(manifest.schemaVersion, INSTALL_MANIFEST_VERSION);
  assert.deepEqual(manifest.placeholders, ["<HOME>", "<PLATFORM_ROOT>"]);
  assert.equal(manifest.projects.find((project) => project.name === "joi-button")?.pathTemplate, "<PLATFORM_ROOT>/joi-button");
  assert.ok(manifest.items.length >= 20);
  for (const entry of manifest.items) {
    assert.equal(typeof entry.layer, "string");
    assert.equal(typeof entry.pathTemplate, "string");
    assert.match(entry.pathTemplate, /<HOME>|<PLATFORM_ROOT>/u);
    assert.equal(typeof entry.writer, "string");
    assert.equal(typeof entry.acceptanceProbe, "string");
    assert.equal(typeof entry.host, "string");
    assert.doesNotMatch(entry.pathTemplate, forbiddenPathPattern);
  }
  assertInstallManifestComplete(manifest);
});

test("S261 independent required-item catalog rejects a manifest item deletion", () => {
  const manifest = readInstallManifest();
  const mutated = { ...manifest, items: manifest.items.slice(0, -1) };
  assert.throws(() => assertInstallManifestComplete(mutated), (error) => error.reasonCode === "INSTALL_MANIFEST_ITEM_MISSING");
});

test("install-manifest is a deterministic read-only CLI verb", async () => {
  const first = await cliJson(["install-manifest"]);
  const second = await cliJson(["install-manifest"]);
  assert.deepEqual(first, second);
  assert.equal(first.reasonCode, "INSTALL_MANIFEST_READY");
  assert.equal(first.schemaVersion, INSTALL_MANIFEST_VERSION);
  assert.equal(first.items.some((entry) => entry.id === "machine.codex-skill"), true);
});
