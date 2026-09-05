// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-354: createSnapshotManifest pinned its validate half to
// FileBackend (INC-086, written when the alternative ambient backend was PG --
// STORY-189). PG was retired in 50db3e2 (TCRN-CROSS-INC-275); the two backends
// left both read the SAME on-disk control tree, so the pin no longer guards
// against a stale mirror and instead breaks every file-segmented workspace:
// FileBackend.listSegmentNames does not filter the segmented backend's
// per-segment .idx sidecars the way SegmentedBackend.listSegmentNames does, so
// validateWorkspace's readSegmentEvents rejected every one with
// WORKSPACE_EVENT_CORRUPT: "unexpected event entry 000001.idx".

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  createProject,
  createSnapshotManifest,
  initializeWorkspace,
  setWorkspaceSetting,
  verifySnapshotManifest,
} from "../dist/build/packages/core/src/index.js";

const controlDirectory = ".tcrn-" + "workflow";
const instant = (second) => `2026-09-05T05:00:${String(second).padStart(2, "0")}Z`;

async function fixture(context, suffix = "SEG") {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s354-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: `STORY-354-${suffix}`, createdAt: instant(0) });
  return { base, workspace };
}

test("STORY-354 snapshot-manifest succeeds on a file-segmented workspace and covers its .idx sidecars", async (context) => {
  const fx = await fixture(context);
  const lease = await acquireWorkspaceLease(fx.workspace, { now: instant(1) });
  let manifestText;
  let state;
  try {
    state = await setWorkspaceSetting(fx.workspace, lease, {
      key: "storage.backend",
      value: "file-segmented",
      expectedVersion: 0,
      occurredAt: instant(1),
    });
    state = await createProject(fx.workspace, lease, {
      externalKey: "STORY-354-PROJECT",
      name: "Segmented manifest coverage",
      expectedVersion: state.version,
      occurredAt: instant(2),
    });

    const entries = await readdir(join(fx.workspace, controlDirectory, "events"));
    assert.ok(entries.includes("000001.idx"), "fixture must be file-segmented with a built point index");
    assert.ok(entries.includes("manifest.json"), "fixture must be file-segmented with a built segment manifest");

    manifestText = await createSnapshotManifest(fx.workspace, lease);
  } finally {
    await lease.release();
  }
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.schemaVersion, "tcrn.workspace-snapshot-manifest.v1");
  assert.equal(manifest.validate.workspace, "valid");
  assert.equal(manifest.version, state.version);

  const manifestPaths = manifest.files.map((entry) => entry.path);
  assert.ok(manifestPaths.includes("events/000001.idx"), "manifest must cover the segment point index");
  assert.ok(manifestPaths.includes("events/manifest.json"), "manifest must cover the segment manifest sidecar");
  assert.ok(manifestPaths.includes("events/000001.ndjson"), "manifest must cover the event segment itself");

  assert.equal((await verifySnapshotManifest(fx.workspace, manifestText)).reasonCode, "SNAPSHOT_VERIFIED");
});

test("STORY-354 a workspace with no explicit storage.backend setting (default segmented) also snapshots cleanly", async (context) => {
  const fx = await fixture(context, "DEFAULT");
  const lease = await acquireWorkspaceLease(fx.workspace, { now: instant(1) });
  try {
    const state = await createProject(fx.workspace, lease, {
      externalKey: "STORY-354-DEFAULT-PROJECT",
      name: "Default segmented backend",
      expectedVersion: 0,
      occurredAt: instant(1),
    });
    const entries = await readdir(join(fx.workspace, controlDirectory, "events"));
    assert.ok(entries.includes("000001.idx"), "the default backend must retain the segmented point index");
    const manifestText = await createSnapshotManifest(fx.workspace, lease);
    assert.equal(JSON.parse(manifestText).version, state.version);
  } finally {
    await lease.release();
  }
});
