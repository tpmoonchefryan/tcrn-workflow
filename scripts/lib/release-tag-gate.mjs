// SPDX-License-Identifier: Apache-2.0

/**
 * INC-093 release invariants. Tag creation is deliberately outside this module:
 * the preflight proves that the candidate tag names the exact commit judged by
 * P8 and that a release commit contains only release metadata plus the
 * deterministic proof surfaces regenerated from that metadata. An Owner still
 * decides whether to create or publish the tag.
 */

const SHA = /^[0-9a-f]{40,64}$/u;
const TAG = /^v\d+\.\d+\.\d+$/u;

export class ReleaseTagGateError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "ReleaseTagGateError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, message) {
  throw new ReleaseTagGateError(reasonCode, message);
}

export function assertP8TagPreconditions({ p8Result, expectedTag, tagCommit, p8BasisCommit } = {}) {
  if (p8Result?.reasonCode !== "P8_WORKFLOW_RC_VERIFIED") {
    fail("RELEASE_TAG_P8_NOT_GREEN", "release tag requires a green P8 evidence result");
  }
  if (p8Result.releaseStatus !== "accepted_release" || p8Result.publication !== false || p8Result.mutation !== false) {
    fail("RELEASE_TAG_P8_RELEASE_STATUS_INVALID", "P8 evidence is not an unpublished, non-mutating accepted release candidate");
  }
  if (typeof expectedTag !== "string" || !TAG.test(expectedTag)) {
    fail("RELEASE_TAG_INVALID", String(expectedTag));
  }
  if (p8Result.tag !== expectedTag) {
    fail("RELEASE_TAG_P8_TAG_MISMATCH", `${expectedTag} != ${String(p8Result.tag)}`);
  }
  if (typeof tagCommit !== "string" || !SHA.test(tagCommit) || typeof p8BasisCommit !== "string" || !SHA.test(p8BasisCommit)) {
    fail("RELEASE_TAG_COMMIT_INVALID", "tag commit and P8 basis commit must be full hexadecimal commit ids");
  }
  if (tagCommit !== p8BasisCommit) {
    fail("RELEASE_TAG_P8_BASIS_MISMATCH", `${tagCommit.slice(0, 12)} != ${p8BasisCommit.slice(0, 12)}`);
  }
  return {
    tag: expectedTag,
    tagCommit,
    p8BasisCommit,
    p8ReasonCode: p8Result.reasonCode,
  };
}

function isReleaseMetadataPath(path) {
  return path === "CHANGELOG.md"
    || /^docs\/releases\/\d+\.\d+\.\d+\.md$/u.test(path)
    || /(?:^|\/)package\.json$/u.test(path)
    || path === "scripts/policy/source-allowlist.json"
    || path === "verification-map.yaml"
    || path === "fixtures/rc1/rc1-candidate-proof-manifest.json";
}

export function assertReleaseCommitShape({ changedPaths } = {}) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0 || changedPaths.some((path) => typeof path !== "string" || path.length === 0)) {
    fail("RELEASE_COMMIT_EMPTY", "release commit must name at least one changed path");
  }
  const uniquePaths = [...new Set(changedPaths)];
  const disallowed = uniquePaths.filter((path) => !isReleaseMetadataPath(path));
  if (disallowed.length > 0) {
    fail("RELEASE_COMMIT_SHAPE_INVALID", disallowed.join(","));
  }
  return { changedPaths: uniquePaths.sort() };
}
