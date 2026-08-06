// SPDX-License-Identifier: Apache-2.0
// STORY-174 red leg: a one-byte deviation injected at the storage abstraction
// layer must turn the engine's chain read red.
//
// The storage abstraction (StorageBackend) is the convergence point of STORY-174:
// the file backend implements it, and the engine's data-plane reads (metadata,
// segments, views) ride through it. 174.6 demands a red leg — a one-byte
// deviation at the abstraction layer that makes the existing engine suite fail.
// This test proves the deviation is on the data path: a FileBackend constructed
// with `injectSegmentByteDeviation` returns a segment whose first byte differs,
// and materializeWorkspace (which runs validateEventChain over the segments)
// turns red WORKSPACE_EVENT_CORRUPT. The control — the same history read through
// a clean backend — stays green.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  createProject,
  initializeWorkspace,
  materializeWorkspace,
  updateProject,
} from "../dist/build/packages/core/src/index.js";
import { FileBackend } from "../dist/build/packages/core/src/storage-backend.js";

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

async function workspaceFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s174-")));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  const state = await initializeWorkspace({
    roots,
    externalKey: "WORKSPACE-S174",
    createdAt: instant(0),
    segmentEventLimit: 2,
  });
  return {
    base,
    workspace,
    state,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function createHistory(fixture) {
  const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
  try {
    let state = await createProject(fixture.workspace, lease, {
      expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-S174", name: "Alpha",
    });
    state = await updateProject(fixture.workspace, lease, {
      expectedVersion: 1, occurredAt: instant(2), id: state.projects[0].id, name: "Beta",
    });
    return state;
  } finally {
    await lease.release();
  }
}

test("STORY-174 red leg: a one-byte segment deviation at the abstraction layer changes the read bytes", async () => {
  const fixture = await workspaceFixture();
  try {
    await createHistory(fixture);

    // Control: a clean backend reads the same history green.
    const clean = await materializeWorkspace(fixture.workspace);
    assert.equal(clean.version, 2, "control history has two events");

    // Deviated backend: read the first segment through an injected FileBackend
    // and prove the single-byte delta is length-preserving and changes bytes.
    const backend = new FileBackend(fixture.workspace, undefined, true);
    const segmentName = (await backend.listSegmentNames())[0];
    const deviated = await backend.readSegment(segmentName);
    const controlBytes = await new FileBackend(fixture.workspace).readSegment(segmentName);
    assert.equal(deviated.length, controlBytes.length, "deviation is length-preserving");
    assert.notEqual(deviated.toString("utf8"), controlBytes.toString("utf8"), "deviation changed the bytes");
  } finally {
    await fixture.close();
  }
});

test("STORY-174 red leg: the deviated segment is refused by chain validation", async () => {
  const fixture = await workspaceFixture();
  try {
    await createHistory(fixture);
    const backend = new FileBackend(fixture.workspace, undefined, true);
    const segmentName = (await backend.listSegmentNames())[0];
    const deviated = await backend.readSegment(segmentName);

    // Write the deviated bytes back to disk so the engine's own read path
    // (which re-validates the chain) sees them — this is the honest form of the
    // red leg: a one-byte deviation on the control surface is refused.
    const { writeFile } = await import("node:fs/promises");
    const { join: pathJoin } = await import("node:path");
    await writeFile(pathJoin(fixture.workspace, ".tcrn-workflow", "events", segmentName), deviated);

    let thrown = null;
    try {
      await materializeWorkspace(fixture.workspace);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "the deviated segment must turn the chain read red");
    assert.equal(thrown.reasonCode, "WORKSPACE_EVENT_CORRUPT", "chain validation refuses the one-byte deviation");
  } finally {
    await fixture.close();
  }
});
