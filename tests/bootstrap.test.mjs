// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MODE,
  FRAMEWORK_VERSION,
  admitDevelopment,
  assertDistinctRoots,
} from "../dist/build/packages/core/src/index.js";
import {
  RELEASE_REQUIRED_ARGUMENTS,
  missingReleaseArguments,
} from "../dist/build/packages/cli/src/index.js";
import {
  PROTOCOL_STATUS,
  protocolBootstrapStatus,
} from "../dist/build/packages/protocol/src/index.js";

test("development mode is explicitly offline and telemetry-free", () => {
  assert.equal(DEFAULT_MODE, "development");
  assert.equal(FRAMEWORK_VERSION, "0.0.0-development");
  assert.deepEqual(admitDevelopment(), {
    admitted: true,
    mode: "development",
    network: "offline",
    telemetry: "disabled",
  });
});

test("root collisions fail closed", () => {
  assert.doesNotThrow(() =>
    assertDistinctRoots([
      { kind: "framework", path: "/framework" },
      { kind: "workspace", path: "/workspace" },
    ]),
  );
  assert.throws(
    () =>
      assertDistinctRoots([
        { kind: "framework", path: "/same" },
        { kind: "release-trust", path: "/same" },
      ]),
    /ROOT_PATH_COLLISION/u,
  );
});

test("release mode declares every required external input", () => {
  assert.deepEqual(RELEASE_REQUIRED_ARGUMENTS, [
    "trust-root",
    "bundle",
    "subject",
    "repository",
    "workflow",
  ]);
  assert.deepEqual(missingReleaseArguments({ repository: "tcrn-workflow" }), [
    "trust-root",
    "bundle",
    "subject",
    "workflow",
  ]);
});

test("P1 does not overclaim normative protocol availability", () => {
  assert.equal(PROTOCOL_STATUS, "not-implemented-p1");
  assert.deepEqual(protocolBootstrapStatus, {
    phase: "P1",
    normativeProtocolAvailable: false,
    reasonCode: "P2_OUT_OF_SCOPE",
  });
});
