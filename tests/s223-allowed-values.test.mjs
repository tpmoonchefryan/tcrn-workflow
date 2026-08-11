// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  SETTINGS_CATALOG,
  initializeWorkspace,
} from "../dist/build/packages/core/src/index.js";

const instant = (second) => `2026-08-11T00:00:${String(second).padStart(2, "0")}Z`;

async function fixture(context, suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s223-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: `FIXTURE-S223-${suffix}`, createdAt: instant(0) });
  return { workspace };
}

async function runRaw(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function runError(args) {
  try {
    await runCli(args, { write() {} });
  } catch (error) {
    return error;
  }
  assert.fail(`expected ${args[0]} to refuse`);
}

test("S223: settings-catalog exposes the engine-owned enum values", async (t) => {
  const { workspace } = await fixture(t, "catalog");
  const readback = await runRaw(["settings-catalog", "--workspace", workspace]);
  const cadence = readback.settings.find((entry) => entry.key === "backup.cadence");
  assert.deepEqual(cadence.allowedValues, ["gate-close", "session-end", "manual"]);
  assert.deepEqual(cadence.allowedValues, SETTINGS_CATALOG.find((entry) => entry.key === "backup.cadence").allowedValues);
  assert.equal(Object.hasOwn(readback.settings.find((entry) => entry.key === "driver.capabilityProfile"), "allowedValues"), false);
});

test("S223: an enum refusal carries its allowed values and appends no event", async (t) => {
  const { workspace } = await fixture(t, "reject");
  const error = await runError([
    "settings-set",
    "--workspace", workspace,
    "--expected-version", "0",
    "--at", instant(1),
    "--key", "backup.cadence",
    "--value", "hourly",
    "--actor", "agent:codex",
  ]);
  assert.equal(error.reasonCode, "SETTINGS_VALUE_INVALID");
  assert.deepEqual(error.details, { allowedValues: ["gate-close", "session-end", "manual"] });
  assert.match(error.message, /gate-close, session-end, manual/u);
  const status = await runRaw(["status", "--workspace", workspace]);
  assert.equal(status.version, 0);
});
