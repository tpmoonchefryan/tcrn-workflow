// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { validateP2SchemasAndFixtures } from "../scripts/lib/protocol-proof.mjs";

test("Draft 2020-12 schemas are meta-validated with local refs and executable cases", async () => {
  const result = await validateP2SchemasAndFixtures();
  assert.equal(result.schemas, 11);
  assert.equal(result.metaSchemasValidated, 11);
  assert.equal(result.schemaPositiveCases, 11);
  assert.ok(result.schemaNegativeCases >= 22);
  assert.ok(result.resolvedLocalRefs >= 20);
  assert.equal(result.p3Marker, "absent");
});
