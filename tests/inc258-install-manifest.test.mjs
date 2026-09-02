// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-258: stopped backup mechanisms are not install obligations.

import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { INSTALL_MANIFEST, INSTALL_MANIFEST_REQUIRED_ITEM_IDS, assertInstallManifestComplete } from "../dist/build/packages/core/src/index.js";
import { inspectInstallWiring } from "../scripts/platform-doctor.mjs";

const REMOVED_IDS = ["machine.local-snapshot-receipt", "machine.offsite-push-receipt"];

test("INC-258 install wiring accepts the stopped backup removal", async () => {
  const result = await inspectInstallWiring(resolve(process.cwd(), "../.."), resolve(process.env.HOME ?? ""));
  assert.equal(result.ok, true);
});

test("INC-258 install manifest matches the post-removal surface and rejects restored receipts", async () => {
  assertInstallManifestComplete(INSTALL_MANIFEST);
  assert.equal(INSTALL_MANIFEST.items.length, 21);
  assert.deepEqual(REMOVED_IDS.filter((id) => INSTALL_MANIFEST.items.some((entry) => entry.id === id)), []);
  assert.deepEqual(REMOVED_IDS.filter((id) => INSTALL_MANIFEST_REQUIRED_ITEM_IDS.includes(id)), []);
  const restored = {
    ...INSTALL_MANIFEST,
    items: [
      ...INSTALL_MANIFEST.items,
      { id: REMOVED_IDS[0], layer: "machine", host: "shared", pathTemplate: "<PLATFORM_ROOT>/missing-local.json", writer: "user-guided", acceptanceProbe: "probe:local-snapshot-freshness;maxAgeHours=26" },
      { id: REMOVED_IDS[1], layer: "machine", host: "shared", pathTemplate: "<PLATFORM_ROOT>/missing-offsite.json", writer: "user-guided", acceptanceProbe: "probe:offsite-push-freshness;maxAgeHours=26" },
    ],
  };
  const red = await inspectInstallWiring(resolve(process.cwd(), "../.."), resolve(process.env.HOME ?? ""), restored);
  assert.equal(red.ok, false);
  assert.deepEqual(red.missing.map((entry) => entry.id).sort(), [...REMOVED_IDS].sort());
});
