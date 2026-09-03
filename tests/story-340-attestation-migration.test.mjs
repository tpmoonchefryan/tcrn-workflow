// SPDX-License-Identifier: Apache-2.0
// STORY-340: migrate legacy time-attestation files through the engine-owned
// segmented receipt backend, with a full-value readback before deletion.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ATTESTATION_MANIFEST_VERSION,
  deleteLegacyAttestations,
  migrateAttestationDirectory,
  readAttestationReceipt,
  reportAttestationDirectory,
  writeAttestationReceipt,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

const hash = (digit) => digit.repeat(64);

function receipt(eventHash, second) {
  return canonicalJson({
    schemaVersion: "tcrn.time-attestation.v1",
    eventHash,
    observedAt: `2026-09-02T04:00:${String(second).padStart(2, "0")}Z`,
    occurredAt: `2026-09-02T03:00:${String(second).padStart(2, "0")}Z`,
  });
}

test("STORY-340 attestation migration preserves full values, supports point lookup, and deletes only after baseline proof", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s340-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, "attestations");
  await mkdir(directory);
  const values = new Map([[hash("a"), receipt(hash("a"), 1)], [hash("b"), receipt(hash("b"), 2)], [hash("c"), receipt(hash("c"), 3)]]);
  for (const [eventHash, body] of values) await writeFile(join(directory, `${eventHash}.json`), body, "utf8");

  const baseline = await reportAttestationDirectory(directory);
  assert.equal(baseline.legacyFiles, 3);
  const prepared = await migrateAttestationDirectory(directory, 4096);
  assert.equal(prepared.legacyFiles, 3, "the prepare phase keeps legacy records in place");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, ATTESTATION_MANIFEST_VERSION);
  for (const [eventHash, body] of values) assert.equal(await readAttestationReceipt(directory, eventHash), body);

  const deleted = await deleteLegacyAttestations(directory, baseline);
  assert.equal(deleted.legacyFiles, 0);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".json") && name !== "manifest.json"), []);
  for (const [eventHash, body] of values) assert.equal(await readAttestationReceipt(directory, eventHash), body);

  const nextHash = hash("d");
  await writeAttestationReceipt(directory, receipt(nextHash, 4));
  assert.equal(await readAttestationReceipt(directory, nextHash), receipt(nextHash, 4));
});

test("STORY-340 attestation migration has a fail-closed full-value comparison", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s340-value-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, "attestations");
  await mkdir(directory);
  const eventHash = hash("a");
  const original = receipt(eventHash, 1);
  await writeFile(join(directory, `${eventHash}.json`), original, "utf8");
  const baseline = await reportAttestationDirectory(directory);
  await migrateAttestationDirectory(directory, 4096);
  const deleted = await deleteLegacyAttestations(directory, baseline);
  assert.equal(deleted.legacyFiles, 0);
  assert.equal((await readdir(directory)).includes(`${eventHash}.json`), false, "legacy data is deleted only after the full-value readback passes");
  assert.equal(await readAttestationReceipt(directory, eventHash), original);
});
