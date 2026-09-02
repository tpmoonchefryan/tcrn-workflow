// SPDX-License-Identifier: Apache-2.0
// STORY-344: the workspace lifecycle must use StorageBackend for data-plane
// directory work. Lease/recovery-claim identity operations remain deliberately
// file-native; this test covers the workspace metadata/events/views surface that
// a replaceable backend owns.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  initializeWorkspace,
  recoverWorkspace,
  withStorageBackendFactory,
} from "../dist/build/packages/core/src/index.js";
import { FileBackend } from "../dist/build/packages/core/src/storage-backend.js";

const instant = (second) => `2026-09-02T00:00:${String(second).padStart(2, "0")}Z`;
const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
const controlDirectory = ".tcrn-" + "workflow";

class RecordingBackend extends FileBackend {
  calls = [];

  async createControlDirectory() {
    this.calls.push("createControlDirectory");
    return super.createControlDirectory();
  }

  async ensureControlDirectory(relativePath) {
    this.calls.push(`ensureControlDirectory:${relativePath}`);
    return super.ensureControlDirectory(relativePath);
  }

  async listControlEntries(relativePath) {
    this.calls.push(`listControlEntries:${relativePath}`);
    return super.listControlEntries(relativePath);
  }

  async removeControlFile(relativePath) {
    this.calls.push(`removeControlFile:${relativePath}`);
    return super.removeControlFile(relativePath);
  }
}

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s344-")));
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  return {
    base,
    workspace: join(base, "workspace"),
    roots,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

test("STORY-344 workspace lifecycle data-plane operations use StorageBackend", async () => {
  const fx = await fixture();
  try {
    const backend = new RecordingBackend(fx.workspace);
    await withStorageBackendFactory(
      () => backend,
      () => initializeWorkspace({
        roots: fx.roots,
        externalKey: "STORY-344-BOUNDARY",
        createdAt: instant(0),
        segmentEventLimit: 2,
      }),
    );
    assert.deepEqual(backend.calls, [
      "createControlDirectory",
      "ensureControlDirectory:events",
      "ensureControlDirectory:views",
      "ensureControlDirectory:backups",
      "ensureControlDirectory:snapshots",
    ]);

    const lease = await withStorageBackendFactory(
      () => backend,
      () => acquireWorkspaceLease(fx.workspace, { now: instant(1) }),
    );
    try {
      await writeFile(join(fx.workspace, controlDirectory, "events", ".tmp-story-344"), "temporary");
      await withStorageBackendFactory(
        () => backend,
        () => recoverWorkspace(fx.workspace, lease),
      );
    } finally {
      await lease.release();
    }
    assert.deepEqual(backend.calls.slice(5), [
      "listControlEntries:events",
      "removeControlFile:events/.tmp-story-344",
      "listControlEntries:views",
      "listControlEntries:snapshots",
      "listControlEntries:snapshots",
    ]);
  } finally {
    await fx.close();
  }
});

test("STORY-344 workspace lifecycle has no direct data-plane fs calls", async () => {
  const source = await readFile(new URL("../packages/core/src/workspace.ts", import.meta.url), "utf8");
  const initializeBody = source.slice(
    source.indexOf("export async function initializeWorkspace"),
    source.indexOf("async function resolveWorkspace"),
  );
  const recoverBody = source.slice(
    source.indexOf("export async function recoverWorkspace"),
    source.indexOf("export async function exportWorkspace"),
  );
  for (const body of [initializeBody, recoverBody]) {
    assert.doesNotMatch(body, /\b(?:lstat|mkdir|open|readdir|realpath|rename|rm|writeFile|readFile|stat)\s*\(/u);
  }
  assert.match(initializeBody, /backend\.createControlDirectory\(\)/u);
  assert.match(recoverBody, /backend\.listControlEntries\(/u);
  assert.match(recoverBody, /backend\.removeControlFile\(/u);
});
