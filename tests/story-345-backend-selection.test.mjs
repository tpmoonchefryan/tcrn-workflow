// SPDX-License-Identifier: Apache-2.0
// STORY-345: the local segmented backend is selectable through the governed
// storage.backend setting; unknown values are not silently mapped to file.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  createProject,
  initializeWorkspace,
  materializeWorkspace,
  setWorkspaceSetting,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";

const controlDirectory = ".tcrn-" + "workflow";
const instant = (second) => `2026-09-02T03:00:${String(second).padStart(2, "0")}Z`;

async function fixture(suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s345-${suffix}-`)));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: `STORY-345-${suffix}`, createdAt: instant(0) });
  return { base, workspace, async close() { await rm(base, { recursive: true, force: true }); } };
}

test("STORY-345 default segmented and explicit file backends produce the same work state", async () => {
  const segmented = await fixture("SEGMENTED");
  const file = await fixture("FILE");
  try {
    for (const [fixture, backend] of [[segmented, "file-segmented"], [file, "file"]]) {
      const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
      try {
        let state = await setWorkspaceSetting(fixture.workspace, lease, {
          key: "storage.backend",
          value: backend,
          expectedVersion: 0,
          occurredAt: instant(1),
        });
        state = await createProject(fixture.workspace, lease, {
          externalKey: "STORY-345-PROJECT",
          name: "Same result",
          expectedVersion: state.version,
          occurredAt: instant(2),
        });
        assert.equal(state.version, 2);
      } finally {
        await lease.release();
      }
    }
    const left = await validateWorkspace(segmented.workspace);
    const right = await validateWorkspace(file.workspace);
    assert.deepEqual(left.projects.map(({ id, externalKey, name, revision, tombstone }) => ({ id, externalKey, name, revision, tombstone })), right.projects.map(({ id, externalKey, name, revision, tombstone }) => ({ id, externalKey, name, revision, tombstone })));
    const segmentedEntries = await readdir(join(segmented.workspace, controlDirectory, "events"));
    assert.ok(segmentedEntries.includes("000001.idx"), "segmented backend must build a point index");
    assert.ok(segmentedEntries.includes("manifest.json"), "segmented backend must build a manifest");
    const fileEntries = await readdir(join(file.workspace, controlDirectory, "events"));
    assert.deepEqual(fileEntries.filter((entry) => /^\d{6}\.idx$/u.test(entry)), []);
  } finally {
    await segmented.close();
    await file.close();
  }
});

test("STORY-345 backend selection rejects unknown values and does not silently fall back", async () => {
  const fx = await fixture("UNKNOWN");
  try {
    const lease = await acquireWorkspaceLease(fx.workspace, { now: instant(1) });
    try {
      await assert.rejects(() => setWorkspaceSetting(fx.workspace, lease, {
        key: "storage.backend",
        value: "pg",
        expectedVersion: 0,
        occurredAt: instant(1),
      }), (error) => error?.reasonCode === "SETTINGS_VALUE_INVALID");
    } finally {
      await lease.release();
    }
    const state = await materializeWorkspace(fx.workspace);
    assert.equal(state.version, 0, "an invalid backend setting must not append an event");
    const freshLease = await acquireWorkspaceLease(fx.workspace, { now: instant(2) });
    try {
      await createProject(fx.workspace, freshLease, {
        externalKey: "STORY-345-DEFAULT-PROJECT",
        name: "Default segmented backend",
        expectedVersion: state.version,
        occurredAt: instant(2),
      });
    } finally {
      await freshLease.release();
    }
    const entries = await readdir(join(fx.workspace, controlDirectory, "events"));
    assert.ok(entries.includes("000001.idx"), "the default backend must retain the segmented point index");
    assert.ok(entries.includes("manifest.json"), "the default backend must retain the segmented manifest");
  } finally {
    await fx.close();
  }
});
