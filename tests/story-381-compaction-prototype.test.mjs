// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { archiveProjection, simulateTailLoad } from "../scripts/compaction-prototype.mjs";

const status = {
  workspaceId: "workspace:prototype",
  version: 100,
  headEventHash: "f".repeat(64),
  budgets: { events: { limit: 10_000, headroomEvents: 9_900 }, views: [] },
};

const manifest = {
  workspaceId: status.workspaceId,
  version: status.version,
  files: [
    { path: "events/000001.idx", bytes: 10, sha256: "a".repeat(64) },
    { path: "events/000001.ndjson", bytes: 100, sha256: "b".repeat(64) },
    { path: "events/000002.idx", bytes: 20, sha256: "c".repeat(64) },
    { path: "events/000002.ndjson", bytes: 200, sha256: "d".repeat(64) },
    { path: "views/index.json", bytes: 300, sha256: "e".repeat(64) },
  ],
};

const records = Array.from({ length: 100 }, (_, sequence) => ({ sequence, payload: { operation: "work.updated" } }));

test("STORY-381 compaction projection keeps the head and estimates cold bytes", () => {
  const projection = archiveProjection(manifest, status, records, 1);
  assert.equal(projection.archive.coldSegmentCount, 1);
  assert.equal(projection.archive.coldBytes, 110);
  assert.equal(projection.archive.retainedEventSegmentBytes, 220);
  assert.equal(projection.archive.headRoot.headEventHash, status.headEventHash);
  assert.equal(projection.archive.destination, "workspace.generatedArtifactsPath (research estimate only; nothing written)");
  assert.equal(projection.simulation.missingColdSegment.ok, false);
  assert.deepEqual(projection.simulation.missingColdSegment.missing, ["events/000001.idx"]);
  assert.equal(projection.simulation.tamperedColdSegment.ok, false);
  assert.deepEqual(projection.simulation.tamperedColdSegment.mismatched, ["events/000001.idx"]);
});

test("STORY-381 tail simulation is deterministic and does not write a workspace", () => {
  const first = simulateTailLoad(records.slice(-10));
  const second = simulateTailLoad(records.slice(-10));
  assert.deepEqual(first, second);
  assert.equal(first.records, 10);
  assert.match(first.digest, /^[0-9a-f]{64}$/u);
});
