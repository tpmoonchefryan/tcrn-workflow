// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  ADAPTER_BASELINE_ENTRY_IDS,
  AdapterBaselineError,
  createAdapterBaseline,
  validateAdapterBaseline,
  validateAdapterSurface,
  validateAdapterUserZone,
} from "../dist/build/packages/core/src/index.js";

function reason(code, operation) {
  assert.throws(operation, (error) => error instanceof AdapterBaselineError && error.reasonCode === code, code);
}

test("S214 baseline is complete, digest-bound, and records the stop-pact exemption", () => {
  const baseline = createAdapterBaseline();
  const validated = validateAdapterBaseline(baseline);
  assert.deepEqual(validated.entries.map((entry) => entry.id), [...ADAPTER_BASELINE_ENTRY_IDS].sort());
  assert.equal(validated.entries.find((entry) => entry.id === "session-start-governance").installationState, "installed");
  assert.equal(validated.entries.find((entry) => entry.id === "observe-collection").events.length, 6);
  const stopPact = validated.entries.find((entry) => entry.id === "stop-pact-stop-gate");
  assert.equal(stopPact.installationState, "exempted");
  assert.equal(stopPact.owner, "user");
  assert.equal(stopPact.driftCheck, "independent-readonly");
});

test("missing baseline entry is a red leg", () => {
  const baseline = createAdapterBaseline();
  const missing = { ...baseline, entries: baseline.entries.filter((entry) => entry.id !== "observe-collection") };
  reason("ADAPTER_BASELINE_MISSING", () => validateAdapterBaseline(missing));
});

test("user hooks are an opaque zone and do not affect adapter validation", () => {
  const baseline = createAdapterBaseline();
  const bundleDigest = "a".repeat(64);
  const userSettings = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "user-owned-hook" }] }] } });
  const withoutUserZone = validateAdapterSurface(bundleDigest, baseline);
  const withUserZone = validateAdapterSurface(bundleDigest, baseline, userSettings);
  assert.deepEqual(withUserZone, withoutUserZone);
  assert.deepEqual(validateAdapterUserZone(userSettings).findings, []);
});
