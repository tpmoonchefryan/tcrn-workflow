// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  ProtocolProofError,
  canonicalProofBytes,
  validateP2SchemasAndFixtures,
} from "../scripts/lib/protocol-proof.mjs";

test("Draft 2020-12 schemas are meta-validated with local refs and executable cases", async () => {
  const result = await validateP2SchemasAndFixtures();
  assert.equal(result.schemas, 11);
  assert.equal(result.metaSchemasValidated, 11);
  assert.equal(result.schemaPositiveCases, 11);
  assert.ok(result.schemaNegativeCases >= 22);
  assert.equal(result.stableIdMaximumLength, 161);
  assert.equal(result.stableIdBoundaryCases, 18);
  assert.equal(result.extensionNameCases, 3);
  assert.ok(result.resolvedLocalRefs >= 20);
  assert.equal(result.p3Marker, "absent");
});

test("proof and RC1 canonical inputs reject malformed Unicode with a stable proof reason", () => {
  for (const surrogate of ["\ud800", "\udfff"]) {
    for (const value of [
      surrogate,
      [surrogate],
      { nested: surrogate },
      { [`key-${surrogate}`]: 1 },
      { nested: { [`key-${surrogate}`]: 1 } },
    ]) {
      assert.throws(
        () => canonicalProofBytes(value),
        (error) => error instanceof ProtocolProofError && error.reasonCode === "RC1_CANONICAL_VALUE_INVALID",
      );
    }
  }
});
