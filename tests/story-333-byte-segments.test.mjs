// SPDX-License-Identifier: Apache-2.0
// STORY-333: new workspaces use storage-version 2 and roll event segments by
// serialized bytes, while explicit legacy fixtures keep their count semantics.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  createProject,
  initializeWorkspace,
  materializeWorkspace,
  setWorkspaceSetting,
} from "../dist/build/packages/core/src/index.js";

const instant = (second) => `2026-09-02T01:00:${String(second).padStart(2, "0")}Z`;
const controlDirectory = ".tcrn-" + "workflow";

async function fixture(suffix, options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s333-${suffix}-`)));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  const state = await initializeWorkspace({
    roots,
    externalKey: `STORY-333-${suffix}`,
    createdAt: instant(0),
    ...options,
  });
  return {
    base,
    workspace,
    roots,
    state,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

test("STORY-333 byte threshold creates bounded segments and preserves legacy segments", async () => {
  const modern = await fixture("MODERN");
  try {
    const metadata = JSON.parse(await readFile(join(modern.workspace, controlDirectory, "workspace.json"), "utf8"));
    assert.deepEqual({
      storageVersion: metadata.storageVersion,
      minimumStorageVersion: metadata.minimumStorageVersion,
      maximumStorageVersion: metadata.maximumStorageVersion,
      segmentEventLimit: metadata.segmentEventLimit,
    }, {
      storageVersion: 2,
      minimumStorageVersion: 1,
      maximumStorageVersion: 2,
      segmentEventLimit: 16_777_216,
    });

    const lease = await acquireWorkspaceLease(modern.workspace, { now: instant(1) });
    try {
      let state = await setWorkspaceSetting(modern.workspace, lease, {
        key: "storage.segmentBytes",
        value: "4096",
        expectedVersion: 0,
        occurredAt: instant(1),
      });
      for (let index = 0; index < 12; index += 1) {
        state = await createProject(modern.workspace, lease, {
          externalKey: `STORY-333-PROJECT-${String(index).padStart(2, "0")}`,
          name: `Project ${index} ${"x".repeat(index % 2 === 0 ? 80 : 260)}`,
          expectedVersion: state.version,
          occurredAt: instant(index + 2),
        });
      }
      assert.equal(state.version, 13);
    } finally {
      await lease.release();
    }

    const entries = (await readdir(join(modern.workspace, controlDirectory, "events"))).sort();
    const segments = entries.filter((entry) => entry.endsWith(".ndjson"));
    assert.ok(segments.length >= 3, `byte rolling should create several segments, got ${segments.length}`);
    assert.deepEqual(entries.filter((entry) => /^\d{6}\.json$/u.test(entry)), []);
    const sizes = await Promise.all(segments.map(async (entry) => (await stat(join(modern.workspace, controlDirectory, "events", entry))).size));
    assert.ok(sizes.every((size) => size <= 4096), `every modern segment must stay within the configured byte limit: ${sizes.join(",")}`);
    assert.equal((await materializeWorkspace(modern.workspace)).version, 13);
  } finally {
    await modern.close();
  }

  const legacy = await fixture("LEGACY", { segmentEventLimit: 2 });
  try {
    const before = await readFile(join(legacy.workspace, controlDirectory, "workspace.json"), "utf8");
    const lease = await acquireWorkspaceLease(legacy.workspace, { now: instant(1) });
    try {
      await createProject(legacy.workspace, lease, {
        externalKey: "STORY-333-LEGACY-PROJECT",
        name: "Legacy",
        expectedVersion: 0,
        occurredAt: instant(1),
      });
    } finally {
      await lease.release();
    }
    const entries = (await readdir(join(legacy.workspace, controlDirectory, "events"))).sort();
    assert.ok(entries.includes("000001.json"));
    assert.equal(JSON.parse(await readFile(join(legacy.workspace, controlDirectory, "workspace.json"), "utf8")).storageVersion, 1);
    assert.equal(before, await readFile(join(legacy.workspace, controlDirectory, "workspace.json"), "utf8"));
    assert.equal((await materializeWorkspace(legacy.workspace)).version, 1);
  } finally {
    await legacy.close();
  }
});

test("STORY-333 byte rolling is not replaced by event-count rolling", async () => {
  const source = await readFile(new URL("../packages/core/src/workspace.ts", import.meta.url), "utf8");
  const start = source.indexOf("const writes =");
  const end = source.indexOf("for (const write of writes)", start);
  const relevant = source.slice(start, end);
  assert.match(relevant, /Buffer\.byteLength\(canonicalJson\(event\), "utf8"\)/u);
  assert.match(source, /entry\.key === "storage\.segmentBytes"/u);
  assert.match(relevant, /currentName = lastExistingName \?\? `\$\{String\(nextIndex \+ 1\)\.padStart\(6, "0"\)\}\.ndjson`/u);
});
