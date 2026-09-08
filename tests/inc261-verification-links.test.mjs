// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateVerificationMapLinks } from "../scripts/verification-links.mjs";

test("INC-261 the stored map link uses a protocol work id and named GWTs", () => {
  const map = JSON.parse(readFileSync(new URL("../verification-map.yaml", import.meta.url), "utf8"));
  const result = validateVerificationMapLinks(map);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.linkedClaimCount, 0);

  const workId = `work:${"a".repeat(24)}`;
  const valid = { id: "LINK-SHAPE", workId, gwt: ["GWT1", "GWT2"] };
  for (const input of [undefined, {}, { claims: null }]) {
    assert.equal(validateVerificationMapLinks(input).ok, true);
  }
  const unlinked = validateVerificationMapLinks({
    claims: [null, 1, {}, { id: "ABSENT" }, { id: "NULL", workId: null }, { id: "UNDEFINED", workId: undefined }],
  });
  assert.equal(unlinked.ok, true);
  assert.equal(unlinked.linkedClaimCount, 0);

  const linked = validateVerificationMapLinks({ claims: [valid] });
  assert.equal(linked.reasonCode, "VERIFICATION_LINKS_VALID");
  assert.equal(linked.linkedClaimCount, 1);

  for (const value of [42, "external-key"]) {
    const result = validateVerificationMapLinks({ claims: [{ ...valid, workId: value }] });
    assert.equal(result.reasonCode, "VERIFICATION_LINKS_INVALID");
    assert.deepEqual(result.problems, ["LINK-SHAPE: workId must be a protocol work id"]);
  }
  for (const gwt of [undefined, [], [42], ["invalid"], ["GWT1", "invalid"]]) {
    const result = validateVerificationMapLinks({ claims: [{ ...valid, gwt }] });
    assert.equal(result.reasonCode, "VERIFICATION_LINKS_INVALID");
    assert.deepEqual(result.problems, ["LINK-SHAPE: gwt must be a non-empty list of GWT ids"]);
  }
  const duplicates = validateVerificationMapLinks({ claims: [{ ...valid, gwt: ["GWT1", "GWT1"] }] });
  assert.equal(duplicates.reasonCode, "VERIFICATION_LINKS_INVALID");
  assert.deepEqual(duplicates.problems, ["LINK-SHAPE: gwt must not contain duplicates"]);
});
