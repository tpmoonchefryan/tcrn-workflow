// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { assertP8TagPreconditions, assertReleaseCommitShape } from "../scripts/lib/release-tag-gate.mjs";

const GREEN = {
  reasonCode: "P8_WORKFLOW_RC_VERIFIED",
  releaseStatus: "accepted_release",
  publication: false,
  mutation: false,
  tag: "v0.11.8",
};
const COMMIT = "a".repeat(40);

test("INC-093: a green P8 result must bind exactly to the candidate tag commit", () => {
  assert.deepEqual(
    assertP8TagPreconditions({ p8Result: { ...GREEN, p8BasisCommit: COMMIT }, expectedTag: "v0.11.8", tagCommit: COMMIT, p8BasisCommit: COMMIT }),
    { tag: "v0.11.8", tagCommit: COMMIT, p8BasisCommit: COMMIT, p8ReasonCode: "P8_WORKFLOW_RC_VERIFIED" },
  );
});

test("INC-093 red leg: a red P8 result or a different basis refuses tag preflight", () => {
  assert.throws(
    () => assertP8TagPreconditions({ p8Result: { ...GREEN, reasonCode: "P8_FAILED", p8BasisCommit: COMMIT }, expectedTag: "v0.11.8", tagCommit: COMMIT, p8BasisCommit: COMMIT }),
    (error) => error.reasonCode === "RELEASE_TAG_P8_NOT_GREEN",
  );
  assert.throws(
    () => assertP8TagPreconditions({ p8Result: { ...GREEN, p8BasisCommit: COMMIT }, expectedTag: "v0.11.8", tagCommit: "b".repeat(40), p8BasisCommit: COMMIT }),
    (error) => error.reasonCode === "RELEASE_TAG_P8_BASIS_MISMATCH",
  );
});

test("INC-093: release commits admit metadata and regenerated proof surfaces", () => {
  assert.deepEqual(
    assertReleaseCommitShape({ changedPaths: [
      "packages/core/package.json",
      "CHANGELOG.md",
      "docs/releases/0.11.8.md",
      "scripts/policy/source-allowlist.json",
      "verification-map.yaml",
      "fixtures/rc1/rc1-candidate-proof-manifest.json",
    ] }),
    { changedPaths: [
      "CHANGELOG.md",
      "docs/releases/0.11.8.md",
      "fixtures/rc1/rc1-candidate-proof-manifest.json",
      "packages/core/package.json",
      "scripts/policy/source-allowlist.json",
      "verification-map.yaml",
    ] },
  );
  assert.throws(
    () => assertReleaseCommitShape({ changedPaths: ["packages/core/src/workspace.ts"] }),
    (error) => error.reasonCode === "RELEASE_COMMIT_SHAPE_INVALID",
  );
});
