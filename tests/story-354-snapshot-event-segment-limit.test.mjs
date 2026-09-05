// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-354 (round 2): walkControlTree's boundReadFileBytes applied the
// generic PROTOCOL_LIMITS.maxCanonicalBytes ceiling (1 MiB) to every control-tree
// file, event segments included. That ceiling is right for small control documents
// (workspace.json, extensions.json, lease/owner.json, ...) but wrong for
// events/NNNNNN.ndjson: a segment legitimately grows up to its configured
// segmentEventLimit (WORKSPACE_SEGMENT_BYTES_DEFAULT, 16 MiB, unless a workspace
// was created with a smaller explicit limit) before rotating to the next segment,
// so any workspace whose current segment merely crossed 1 MiB -- long before
// rotation, and with nothing malformed about it -- made
// createSnapshotManifest/verifySnapshotManifest fail closed with
// SNAPSHOT_PATH_INVALID: "<path> exceeds the snapshot read limit". The fix raises
// the ceiling to WORKSPACE_SEGMENT_BYTES_MAX (the same 64 MiB bound
// SegmentedBackend.readSegment already enforces on the same files) for entries
// matching events/EVENT_SEGMENT_NAME_PATTERN, leaving every other control file at
// the original 1 MiB ceiling.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  appendEvents,
  createProject,
  createSnapshotManifest,
  createWorkDelta,
  initializeWorkspace,
  verifySnapshotManifest,
} from "../dist/build/packages/core/src/index.js";
import { PROTOCOL_LIMITS } from "../dist/build/packages/protocol/src/index.js";

const controlDirectory = ".tcrn-" + "workflow";
const instant = (second) => `2026-09-05T05:00:${String(second).padStart(2, "0")}Z`;

// Empirically calibrated against the real engine, not derived from a formula: 1500
// minimal work.created ("Incident", parentless, no scope/title/labels) events pad
// events/000001.ndjson to roughly 1.3 MB -- about 26% past the 1 MiB ceiling this
// test exists to lift for event segments -- while staying far under both
// segmentEventLimit (16 MiB default, so the segment never rotates to 000002.ndjson)
// and the unrelated per-view projection budget (also 1 MiB, but the work-index view
// stays far more compact per record than the raw hash-chained event log, so it does
// not trip WORKSPACE_VIEW_BUDGET_EXCEEDED at this record count).
const PAD_COUNT = 1500;

async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s354-seglimit-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "STORY-354-SEGLIMIT", createdAt: instant(0) });
  return { base, workspace };
}

test("STORY-354 snapshot-manifest reads an event segment past the generic 1 MiB control-file limit", async (context) => {
  const fx = await fixture(context);
  const lease = await acquireWorkspaceLease(fx.workspace, { now: instant(1) });
  const segmentPath = join(fx.workspace, controlDirectory, "events", "000001.ndjson");
  let manifestText;
  let state;
  let segmentBytes;
  let segmentSha256;
  try {
    state = await createProject(fx.workspace, lease, {
      externalKey: "STORY-354-SEGLIMIT-PROJECT",
      name: "Event segment limit coverage",
      expectedVersion: 0,
      occurredAt: instant(1),
    });
    const projectId = state.projects[0].id;
    const deltas = [];
    for (let i = 0; i < PAD_COUNT; i += 1) {
      deltas.push(createWorkDelta({
        projectId,
        externalKey: `STORY-354-PAD-${i}`,
        kind: "Incident",
        parentId: null,
        status: "active",
        occurredAt: instant(2),
      }));
    }
    state = await appendEvents(fx.workspace, lease, deltas, { expectedVersion: state.version, occurredAt: instant(2) });

    const segmentStat = await stat(segmentPath);
    segmentBytes = segmentStat.size;
    assert.ok(
      segmentBytes > PROTOCOL_LIMITS.maxCanonicalBytes,
      `precondition: 000001.ndjson must exceed the snapshot read limit (${PROTOCOL_LIMITS.maxCanonicalBytes} bytes) to exercise the fix; got ${segmentBytes} bytes from ${PAD_COUNT} padding events`,
    );
    segmentSha256 = createHash("sha256").update(await readFile(segmentPath)).digest("hex");

    manifestText = await createSnapshotManifest(fx.workspace, lease);
  } finally {
    await lease.release();
  }

  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.schemaVersion, "tcrn.workspace-snapshot-manifest.v1");
  assert.equal(manifest.validate.workspace, "valid");
  assert.equal(manifest.version, state.version);

  const segmentEntry = manifest.files.find((entry) => entry.path === "events/000001.ndjson");
  assert.ok(segmentEntry, "manifest must cover the oversized event segment, not silently skip it");
  assert.equal(segmentEntry.bytes, segmentBytes, "manifest must record the segment's full size, not a truncated read");
  assert.equal(segmentEntry.sha256, segmentSha256, "manifest must hash the segment's full content, not a truncated read");

  assert.equal((await verifySnapshotManifest(fx.workspace, manifestText)).reasonCode, "SNAPSHOT_VERIFIED");
});
