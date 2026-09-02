// SPDX-License-Identifier: Apache-2.0
// STORY-346: PostgreSQL remains retained code but is not a selectable MVP backend.

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";

import { SETTINGS_CATALOG } from "../dist/build/packages/core/src/index.js";

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
  const source = await readFile(new URL("../packages/core/src/workspace.ts", import.meta.url), "utf8");
  const backendFunction = source.slice(source.indexOf("function backendKindForState"), source.indexOf("async function writeReplaySnapshot"));
  assert.doesNotMatch(backendFunction, /return ["']pg["']/u);
});
