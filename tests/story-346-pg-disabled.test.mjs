// SPDX-License-Identifier: Apache-2.0
// STORY-346: PostgreSQL remains retained code but is not a selectable MVP backend.

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SETTINGS_CATALOG,
  acquireWorkspaceLease,
  initializeWorkspace,
  setWorkspaceSetting,
} from "../dist/build/packages/core/src/index.js";

test("STORY-346 local backend catalog excludes PostgreSQL and ADR states the MVP revision", async () => {
  const backend = SETTINGS_CATALOG.find((entry) => entry.key === "storage.backend");
  assert.deepEqual(backend?.allowedValues, ["file", "file-segmented"]);
  const adr = await readFile(new URL("../docs/adr/0004-postgres-storage-backend.md", import.meta.url), "utf8");
  assert.match(adr, /INIT-048 MVP revision/u);
  assert.match(adr, /only\s+selectable backends/u);
  assert.match(adr, /not connected/u);
});

test("STORY-346 the pg implementation remains present while the verification map has no pg fixture", async () => {
  await access(new URL("../packages/pg-backend/src/index.ts", import.meta.url), constants.F_OK);
  const map = JSON.parse(await readFile(new URL("../verification-map.yaml", import.meta.url), "utf8"));
  const pgFixtures = map.claims.flatMap((claim) => claim.fixturePaths).filter((path) => /pg/i.test(path) && !path.endsWith("story-346-pg-disabled.test.mjs"));
  assert.deepEqual(pgFixtures, []);
});

test("STORY-346 production backend selection has no pg branch", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s346-backend-")));
  try {
    const roots = [];
    for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
      const path = join(base, kind);
      await mkdir(path);
      roots.push({ kind, path });
    }
    const workspace = join(base, "workspace");
    await initializeWorkspace({ roots, externalKey: "STORY-346-RUNTIME", createdAt: "2026-09-02T08:00:00Z" });
    const lease = await acquireWorkspaceLease(workspace, { now: "2026-09-02T08:00:01Z" });
    try {
      await assert.rejects(() => setWorkspaceSetting(workspace, lease, {
        key: "storage.backend", value: "pg", expectedVersion: 0, occurredAt: "2026-09-02T08:00:02Z",
      }), (error) => error?.reasonCode === "SETTINGS_VALUE_INVALID");
      const accepted = await setWorkspaceSetting(workspace, lease, {
        key: "storage.backend", value: "file", expectedVersion: 0, occurredAt: "2026-09-02T08:00:03Z",
      });
      assert.equal(accepted.settings.find((entry) => entry.key === "storage.backend")?.value, "file");
    } finally {
      await lease.release();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
