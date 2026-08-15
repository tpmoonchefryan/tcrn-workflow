// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-281: the machine settings layer.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MACHINE_SETTINGS_CATALOG,
  MACHINE_SETTINGS_LAYER_KIND,
  MACHINE_SETTING_KEYS,
  applyMachineSettingRemove,
  applyMachineSettingSet,
  machineSettingsPath,
  readMachineSettings,
  readMachineSettingsCatalog,
  validateMachineSettingsFile,
} from "../dist/build/packages/core/src/index.js";

const at = "2026-01-01T00:00:00Z";
const scratch = async () => machineSettingsPath(await mkdtemp(join(tmpdir(), "tcrn-s281-")));
const reason = (promise, reasonCode) => assert.rejects(promise, (error) => error?.reasonCode === reasonCode);

test("S281: an untouched machine reads empty rather than failing, and leaves no file", async () => {
  const path = await scratch();
  try {
    // The ordinary case is a machine that has never chosen anything. That has to read
    // as "nothing set", not as an error, or every consumer needs a try/catch to open.
    const file = await readMachineSettings(path);
    assert.equal(file.layerKind, MACHINE_SETTINGS_LAYER_KIND);
    assert.deepEqual(file.values, {});
    await assert.rejects(stat(path), { code: "ENOENT" }, "reading must not create the file");

    const catalogue = await readMachineSettingsCatalog(path);
    assert.deepEqual(catalogue.settings.map((entry) => entry.key), [...MACHINE_SETTING_KEYS]);
    assert.ok(catalogue.settings.every((entry) => entry.currentValue === null));
  } finally { await rm(join(path, "..", ".."), { recursive: true, force: true }); }
});

test("S281: every value is checked against the catalogue before it is stored", async () => {
  const path = await scratch();
  try {
    await reason(applyMachineSettingSet({ key: "portal.nonsense", value: "x", occurredAt: at, path }), "MACHINE_SETTING_KEY_UNKNOWN");
    await reason(applyMachineSettingSet({ key: "portal.defaultTheme", value: "neon", occurredAt: at, path }), "MACHINE_SETTING_VALUE_INVALID");
    await reason(applyMachineSettingSet({ key: "portal.defaultLocale", value: "xx-YY", occurredAt: at, path }), "MACHINE_SETTING_VALUE_INVALID");
    // The port is bounded on both sides; a privileged port and an out-of-range one are
    // both refused, so the two ends of the range are each proven rather than assumed.
    await reason(applyMachineSettingSet({ key: "portal.port", value: "80", occurredAt: at, path }), "MACHINE_SETTING_VALUE_INVALID");
    await reason(applyMachineSettingSet({ key: "portal.port", value: "70000", occurredAt: at, path }), "MACHINE_SETTING_VALUE_INVALID");
    await reason(applyMachineSettingSet({ key: "portal.port", value: "4321.5", occurredAt: at, path }), "MACHINE_SETTING_VALUE_INVALID");
    // An empty value is not "unset": clearing has its own verb, and conflating the two
    // would make a store of the empty string indistinguishable from no preference.
    await reason(applyMachineSettingSet({ key: "portal.defaultTheme", value: "", occurredAt: at, path }), "MACHINE_SETTING_VALUE_INVALID");
    await assert.rejects(stat(path), { code: "ENOENT" }, "a refused write must not create the file");

    // Every value the catalogue does allow is accepted, so the refusals above are
    // bounded rather than a blanket no.
    for (const entry of MACHINE_SETTINGS_CATALOG) {
      for (const value of entry.allowedValues ?? []) {
        const file = await applyMachineSettingSet({ key: entry.key, value, occurredAt: at, path });
        assert.equal(file.values[entry.key], value);
      }
    }
  } finally { await rm(join(path, "..", ".."), { recursive: true, force: true }); }
});

test("S281: writes are canonical and key order does not depend on write order", async () => {
  const path = await scratch();
  try {
    await applyMachineSettingSet({ key: "portal.port", value: "4321", occurredAt: at, path });
    await applyMachineSettingSet({ key: "portal.defaultTheme", value: "dark", occurredAt: at, path });
    const written = await readFile(path, "utf8");
    // Catalogue order, not insertion order: a file whose bytes depend on the order the
    // reader happened to click is a file that shows spurious diffs forever.
    assert.match(written, /"values":\{"portal\.defaultTheme":"dark","portal\.port":"4321"\}/u);
    assert.ok(written.endsWith("\n"), "the file ends with a newline");
    assert.deepEqual(validateMachineSettingsFile(JSON.parse(written)).values, { "portal.defaultTheme": "dark", "portal.port": "4321" });
  } finally { await rm(join(path, "..", ".."), { recursive: true, force: true }); }
});

test("S281: removing what is not set refuses, and the file disappears with the last value", async () => {
  const path = await scratch();
  try {
    await reason(applyMachineSettingRemove({ key: "portal.defaultTheme", occurredAt: at, path }), "MACHINE_SETTING_NOT_SET");
    await applyMachineSettingSet({ key: "portal.defaultTheme", value: "dark", occurredAt: at, path });
    await applyMachineSettingSet({ key: "portal.port", value: "4321", occurredAt: at, path });
    await applyMachineSettingRemove({ key: "portal.defaultTheme", occurredAt: at, path });
    assert.deepEqual((await readMachineSettings(path)).values, { "portal.port": "4321" });
    await applyMachineSettingRemove({ key: "portal.port", occurredAt: at, path });
    // A machine that ends up with no preferences leaves no file, so a fresh read takes
    // the same absent-file path it would have taken before anything was ever set.
    await assert.rejects(stat(path), { code: "ENOENT" });
    assert.deepEqual((await readMachineSettings(path)).values, {});
  } finally { await rm(join(path, "..", ".."), { recursive: true, force: true }); }
});

test("S281: a corrupt file is an error, not an empty answer", async () => {
  const path = await scratch();
  try {
    await applyMachineSettingSet({ key: "portal.defaultTheme", value: "dark", occurredAt: at, path });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{not json", "utf8");
    // Treating corruption as "nothing chosen" would hide the difference between a
    // machine with no preferences and one whose preferences cannot be read.
    await reason(readMachineSettings(path), "MACHINE_SETTINGS_FILE_INVALID");
    await writeFile(path, JSON.stringify({ schemaVersion: "tcrn.machine-settings.v1", layerKind: "workspace_configuration", values: {}, updatedAt: at }), "utf8");
    await reason(readMachineSettings(path), "MACHINE_SETTINGS_FILE_INVALID");
    await writeFile(path, JSON.stringify({ schemaVersion: "tcrn.machine-settings.v1", layerKind: MACHINE_SETTINGS_LAYER_KIND, values: { "portal.defaultTheme": "neon" }, updatedAt: at }), "utf8");
    // A value that was legal when written but is not in the catalogue now is caught on
    // read, so the store cannot become a way to smuggle a value past validation.
    await reason(readMachineSettings(path), "MACHINE_SETTING_VALUE_INVALID");
  } finally { await rm(join(path, "..", ".."), { recursive: true, force: true }); }
});

test("S281: the layer states where its values come from and when they take effect", async () => {
  // The partition's legal values are this machine's workspaces, not a closed list, so
  // the entry says so — that is what keeps it out of the dictionary (INC-186).
  const partition = MACHINE_SETTINGS_CATALOG.find((entry) => entry.key === "portal.defaultPartition");
  assert.equal(partition?.valueSource, "workspace-discovery");
  assert.equal(partition?.allowedValues, undefined);
  for (const entry of MACHINE_SETTINGS_CATALOG.filter((candidate) => candidate.key !== "portal.defaultPartition")) {
    assert.equal(entry.valueSource, "settings-catalog");
  }
  // The port is bound at listen time, so a receipt that did not say "restart" would
  // leave the reader watching an unchanged page and concluding the write failed.
  assert.equal(MACHINE_SETTINGS_CATALOG.find((entry) => entry.key === "portal.port")?.appliesOn, "restart");
  assert.ok(MACHINE_SETTINGS_CATALOG.filter((entry) => entry.key !== "portal.port").every((entry) => entry.appliesOn === "next-open"));
});
