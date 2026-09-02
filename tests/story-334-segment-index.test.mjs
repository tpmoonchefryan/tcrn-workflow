// SPDX-License-Identifier: Apache-2.0
// STORY-334: segmented NDJSON is accompanied by point, label, time, and
// manifest sidecars. A missing point index is a refusal, never a scan fallback.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";
import { FileBackend } from "../dist/build/packages/core/src/storage-backend.js";
import { SegmentedBackend } from "../dist/build/packages/core/src/segmented-backend.js";

const controlDirectory = ".tcrn-" + "workflow";

async function fixture(suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s334-${suffix}-`)));
  const workspace = join(base, "workspace");
  await mkdir(join(workspace, controlDirectory, "events"), { recursive: true });
  await mkdir(join(workspace, controlDirectory, "views"), { recursive: true });
  await mkdir(join(workspace, controlDirectory, "backups"), { recursive: true });
  return { base, workspace, async close() { await rm(base, { recursive: true, force: true }); } };
}

function event(id, sequence, labels = []) {
  return {
    schemaVersion: "tcrn.event.v1",
    id,
    streamId: "stream:story334",
    sequence,
    occurredAt: `2026-09-02T02:00:0${sequence}Z`,
    priorHash: null,
    payload: { operation: "work.created", record: { id, labels } },
    payloadHash: `payload-${sequence}`,
    eventHash: `hash-${sequence}`,
  };
}

test("STORY-334 segmented backend writes NDJSON and all sidecars, with O(1) point lookup", async () => {
  const fx = await fixture("positive");
  try {
    const backend = new SegmentedBackend(fx.workspace);
    const first = event("work:story334-one", 1, ["storage", "migration"]);
    const second = event("work:story334-two", 2, ["storage"]);
    await backend.writeSegment("000001.ndjson", Buffer.from(`${canonicalJson(first)}${canonicalJson(second)}`, "utf8"));
    const entries = (await readdir(join(fx.workspace, controlDirectory, "events"))).sort();
    assert.deepEqual(entries, ["000001.idx", "000001.ndjson", "labels.idx", "manifest.json", "time.idx"]);
    const location = await backend.lookupKey("work:story334-one");
    assert.deepEqual(location, { segment: "000001.ndjson", offset: 0, length: Buffer.byteLength(canonicalJson(first), "utf8") });
    const read = await backend.readByKey("work:story334-two");
    assert.equal(read?.id, "work:story334-two");
    const labels = JSON.parse((await backend.readControlFile("events/labels.idx")).toString("utf8"));
    assert.deepEqual(labels.labels.storage, ["work:story334-one", "work:story334-two"]);
    assert.deepEqual(labels.labels.migration, ["work:story334-one"]);
    const manifest = await backend.readManifest();
    assert.deepEqual(manifest.segments[0], {
      name: "000001.ndjson",
      bytes: Buffer.byteLength(canonicalJson(first) + canonicalJson(second), "utf8"),
      records: 2,
      firstSequence: 1,
      lastSequence: 2,
      sha256: manifest.segments[0].sha256,
    });
    assert.equal(manifest.activeSegment, "000001.ndjson");
  } finally {
    await fx.close();
  }
});

test("STORY-334 sidecar profile controls the index suffix", async () => {
  const fx = await fixture("profile");
  try {
    const delegate = new FileBackend(fx.workspace);
    const profile = { segmentExtension: ".ndjson", indexExtension: ".sidecar", labelsIndexName: "labels.sidecar", timeIndexName: "time.sidecar", manifestName: "manifest.json" };
    const backend = new SegmentedBackend(fx.workspace, delegate, profile);
    await backend.writeSegment("000001.ndjson", Buffer.from(canonicalJson(event("work:story334-profile", 1)), "utf8"));
    const entries = (await readdir(join(fx.workspace, controlDirectory, "events"))).sort();
    assert.ok(entries.includes("000001.sidecar"));
    assert.ok(entries.includes("labels.sidecar"));
    assert.ok(entries.includes("time.sidecar"));
    assert.ok(await backend.lookupKey("work:story334-profile"));
  } finally {
    await fx.close();
  }
});

test("STORY-334 sidecar point lookup refuses a missing index instead of scanning", async () => {
  const fx = await fixture("red");
  try {
    const backend = new SegmentedBackend(fx.workspace);
    await backend.writeSegment("000001.ndjson", Buffer.from(canonicalJson(event("work:story334-red", 1)), "utf8"));
    await unlink(join(fx.workspace, controlDirectory, "events", "000001.idx"));
    await assert.rejects(() => backend.readByKey("work:story334-red"), (error) => error?.message?.startsWith("WORKSPACE_INDEX_INVALID:") === true);
  } finally {
    await fx.close();
  }
});
