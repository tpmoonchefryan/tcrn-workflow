// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MODE,
  FRAMEWORK_VERSION,
  admitDevelopment,
} from "../dist/build/packages/core/src/index.js";
import {
  RELEASE_REQUIRED_ARGUMENTS,
  missingReleaseArguments,
} from "../dist/build/packages/cli/src/index.js";
import {
  PROTOCOL_STATUS,
  protocolBootstrapStatus,
} from "../dist/build/packages/protocol/src/index.js";
import {
  STRIP_TYPES_EXPERIMENTAL_WARNING,
  stripTypesWithScopedExperimentalWarning,
} from "../scripts/lib/scoped-strip-types.mjs";

function runStripWarningFixture(emissions) {
  const originalEmitWarning = process.emitWarning;
  const forwarded = [];
  process.emitWarning = (...arguments_) => {
    forwarded.push(arguments_);
  };
  try {
    const result = stripTypesWithScopedExperimentalWarning("type Fixture = string;", { mode: "transform", sourceMap: false }, {
      transform() {
        for (const arguments_ of emissions) {
          process.emitWarning(...arguments_);
        }
        return "fixture-output";
      },
      warningState: { consumed: false },
    });
    return { result, forwarded };
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

test("development mode is explicitly offline and telemetry-free", () => {
  assert.equal(DEFAULT_MODE, "development");
  assert.equal(FRAMEWORK_VERSION, "0.1.0-rc.1");
  assert.deepEqual(admitDevelopment(), {
    admitted: true,
    mode: "development",
    projectCommandNetwork: "process-guarded-offline",
    osNetworkSandbox: "not-provided",
    telemetry: "disabled",
  });
});

test("release mode declares every required external input", () => {
  assert.deepEqual(RELEASE_REQUIRED_ARGUMENTS, [
    "trust-root",
    "bundle",
    "subject",
    "repository",
    "workflow",
    "now",
  ]);
  assert.deepEqual(missingReleaseArguments({ repository: "tcrn-workflow" }), [
    "trust-root",
    "bundle",
    "subject",
    "workflow",
    "now",
  ]);
});

test("P2 exposes the frozen normative protocol without claiming P3", () => {
  assert.equal(PROTOCOL_STATUS, "implemented-p2-v1");
  assert.deepEqual(protocolBootstrapStatus, {
    phase: "P2",
    normativeProtocolAvailable: true,
    reasonCode: "P2_VERIFIED",
  });
});

test("stripTypeScriptTypes consumes only its exact experimental warning", () => {
  const fixture = runStripWarningFixture([[STRIP_TYPES_EXPERIMENTAL_WARNING, "ExperimentalWarning"]]);
  assert.equal(fixture.result, "fixture-output");
  assert.deepEqual(fixture.forwarded, []);
});

test("stripTypeScriptTypes rejects changed warning message or type", () => {
  assert.throws(
    () => runStripWarningFixture([["changed strip warning", "ExperimentalWarning"]]),
    (error) => error.reasonCode === "STRIP_TYPES_WARNING_MISSING",
  );
  assert.throws(
    () => runStripWarningFixture([[STRIP_TYPES_EXPERIMENTAL_WARNING, "Warning"]]),
    (error) => error.reasonCode === "STRIP_TYPES_WARNING_MISSING",
  );
});

test("stripTypeScriptTypes forwards unrelated warnings while consuming the exact warning", () => {
  const fixture = runStripWarningFixture([
    ["unrelated warning", "Warning"],
    [STRIP_TYPES_EXPERIMENTAL_WARNING, "ExperimentalWarning"],
  ]);
  assert.equal(fixture.result, "fixture-output");
  assert.deepEqual(fixture.forwarded, [["unrelated warning", "Warning", undefined, undefined]]);
});
