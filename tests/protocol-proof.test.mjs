// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalJson } from "../scripts/lib/canonical-json.mjs";
import {
  ProtocolProofError,
  canonicalProofBytes,
  validateP2SchemasAndFixtures,
  validateRc1ManifestShape,
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

test("canonical proof serialization preserves every own key in exact UTF-8 byte order", () => {
  assert.equal(canonicalJson({ 2: "two", 10: "ten" }), '{"10":"ten","2":"two"}');
  assert.equal(canonicalJson({ omitted: undefined, number: Number.NaN, negativeZero: -0, array: [undefined] }),
    '{"array":[null],"negativeZero":0,"number":null}');

  const withProto = Object.create(null);
  Object.defineProperty(withProto, "__proto__", { value: "own", enumerable: true });
  Object.defineProperty(withProto, "2", { value: "two", enumerable: true });
  Object.defineProperty(withProto, "10", { value: "ten", enumerable: true });
  assert.equal(canonicalJson(withProto), '{"10":"ten","2":"two","__proto__":"own"}');
  const withDigest = createHash("sha256").update(canonicalProofBytes(withProto)).digest("hex");
  const withoutDigest = createHash("sha256").update(canonicalProofBytes({ 10: "ten", 2: "two" })).digest("hex");
  assert.notEqual(withDigest, withoutDigest);

  const entries = [
    ["é", 6],
    ["é", 5],
    ["!", 1],
    ["__proto__", 4],
    ["2", 3],
    ["10", 2],
  ];
  const expected = '{"!":1,"10":2,"2":3,"__proto__":4,"é":5,"é":6}';
  let state = 97;
  for (let iteration = 0; iteration < 128; iteration += 1) {
    const shuffled = [...entries];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      state = (state * 48271) % 2147483647;
      const target = state % (index + 1);
      [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
    }
    const value = Object.create(null);
    for (const [key, entry] of shuffled) {
      Object.defineProperty(value, key, { value: entry, enumerable: true });
    }
    assert.equal(canonicalJson(value), expected);
    assert.equal(canonicalJson({ nested: value }), `{"nested":${expected}}`);
  }
});

test("RC1 candidate and verdict slots enforce exact field sets", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../fixtures/rc1/rc1-candidate-proof-manifest.json", import.meta.url),
    "utf8",
  ));
  assert.doesNotThrow(() => validateRc1ManifestShape(manifest));
  for (const mutation of [
    (value) => { value.unexpected = true; },
    (value) => { delete value.accepted; },
  ]) {
    const candidate = structuredClone(manifest);
    mutation(candidate);
    assert.throws(
      () => validateRc1ManifestShape(candidate),
      (error) => error instanceof ProtocolProofError && error.reasonCode === "RC1_MANIFEST_FIELDS",
    );
  }
  for (const mutation of [
    (slot) => { slot.unexpected = true; },
    (slot) => { delete slot.verdict; },
  ]) {
    const candidate = structuredClone(manifest);
    mutation(candidate.roleVerdictSlots["security-risk-reviewer"]);
    assert.throws(
      () => validateRc1ManifestShape(candidate),
      (error) => error instanceof ProtocolProofError && error.reasonCode === "RC1_VERDICT_SLOT_FIELDS",
    );
  }
});
