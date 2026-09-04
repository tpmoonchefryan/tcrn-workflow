// SPDX-License-Identifier: Apache-2.0
// STORY-346: PostgreSQL is removed; product contains no code for or selection of it.
// Owner ruling 2026-09-04: PostgreSQL does not exist in this product. Tests assert
// its absence and would fail if it were reintroduced accidentally.
// Reference: TCRN-CROSS-INC-275 removed backend, scripts, CLI paths, and CI job.

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

test("STORY-346 storage.backend catalog contains only file backends, PostgreSQL absent", async () => {
  // TCRN-CROSS-INC-275: Product constraint — only local file backends are selectable.
  // This test would fail if PostgreSQL were re-added to allowedValues.
  const backend = SETTINGS_CATALOG.find((entry) => entry.key === "storage.backend");
  assert.deepEqual(backend?.allowedValues, ["file", "file-segmented"]);
});

test("STORY-346 PostgreSQL implementation and migration scripts are absent", async () => {
  // TCRN-CROSS-INC-275: All PostgreSQL code paths removed from product.
  // These assertions catch accidental reintroduction of pg-backend or its build artifacts.
  const fileNotFound = async (url) => {
    try {
      await access(url, constants.F_OK);
      throw new Error(`Expected ${url} to not exist, but it does`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };

  // Core pg backend implementation must not exist
  await fileNotFound(new URL("../packages/pg-backend/src/index.ts", import.meta.url));

  // Migration scripts that targeted PostgreSQL must not exist
  await fileNotFound(new URL("../scripts/apply-pg-schema.mjs", import.meta.url));
  await fileNotFound(new URL("../scripts/apply-pg-test-schema.mjs", import.meta.url));
  await fileNotFound(new URL("../scripts/pg-test-runner.mjs", import.meta.url));

  // Verification map must not claim any pg fixtures
  const map = JSON.parse(await readFile(new URL("../verification-map.yaml", import.meta.url), "utf8"));
  const pgFixtures = map.claims.flatMap((claim) => claim.fixturePaths).filter((path) => /pg/i.test(path) && !path.endsWith("story-346-pg-disabled.test.mjs"));
  assert.deepEqual(pgFixtures, []);
});

test("STORY-346 production backend selection rejects PostgreSQL", async () => {
  // TCRN-CROSS-INC-275: Verify the absence is enforced at runtime, not just in catalog.
  // This test would fail if pg were added back to allowedValues without removing this test.
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
