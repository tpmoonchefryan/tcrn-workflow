// SPDX-License-Identifier: Apache-2.0
// STORY-370 retires the public identity commands while retaining the historical
// profile bundle as a library/replay input and keeping the conference author path
// independent of that bundle.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import {
  CORE_REFERENCE_PERSONA_IDS,
  generateCorePersonaBundle,
  validateCorePersonaBundle,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

test("STORY-370: the eight historical reference profiles remain closed and deterministic as library data", () => {
  const first = generateCorePersonaBundle();
  const second = generateCorePersonaBundle();
  assert.equal(first.profiles.length, 8);
  assert.deepEqual(first.profiles.map((profile) => profile.profileId), CORE_REFERENCE_PERSONA_IDS);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(validateCorePersonaBundle(first), first);
});

test("STORY-370: profile bundle validation still rejects a resealed source mutation", () => {
  const bundle = structuredClone(generateCorePersonaBundle());
  bundle.profiles[0].mission += " changed";
  assert.throws(() => validateCorePersonaBundle(bundle), (error) => error?.reasonCode === "PERSONA_CANONICAL_INVALID");
});

test("STORY-370: every public persona command is retired from the CLI catalog and dispatcher", async () => {
  const commands = [
    "persona-generate", "persona-list", "persona-preset-override", "persona-preset-restore",
    "persona-remove", "persona-render", "persona-set", "persona-validate",
  ];
  for (const command of commands) {
    assert.equal(COMMAND_CATALOG.some((entry) => entry.name === command), false, command);
    await assert.rejects(runCli([command], { write: () => {} }), (error) => error?.reasonCode === "CLI_COMMAND_UNKNOWN");
  }
});

test("STORY-370: the source no longer exposes the retired renderer module or live command branches", async () => {
  const [cliSource, barrelSource] = await Promise.all([
    readFile(new URL("../packages/cli/src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/core/src/index.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(cliSource.includes("persona-render"), false);
  assert.equal(cliSource.includes("persona-generate"), false);
  assert.equal(barrelSource.includes("persona-render"), false);
});
