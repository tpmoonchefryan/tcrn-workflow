// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-INC-224. The chain's lifetime event bound is not the protocol's
// per-document shape bound, and they must not drift back into one number.
//
// They shared one constant. Every protocol-side use of maxRecords bounds a single
// document or call -- a canonical array's length, an object's property count, the
// context record inputs, the exchange entries, the work graph inputs. Only the
// workspace used it as the number of events a log may accumulate over its lifetime.
// Buying chain headroom by raising the shared constant would have loosened six input
// bounds nobody had measured, to fix one lifetime bound that had been.
//
// The separation is the whole change, so these criteria are about the separation
// holding rather than about either number's value.

import assert from "node:assert/strict";
import test from "node:test";

import { PROTOCOL_LIMITS, canonicalJson } from "../dist/build/packages/protocol/src/index.js";
import { assertWorkspaceRecordCount } from "../dist/build/packages/core/src/index.js";

// Red leg: point assertWorkspaceRecordCount back at maxRecords and a chain is capped at
// the length of a single canonical array again -- which is the state INC-224 measured,
// with the cross-project chain a documented handful of weeks from a wall it did not need.
test("INC-224: the chain accepts more events than a single document may hold elements", () => {
  assert.ok(PROTOCOL_LIMITS.maxChainEvents > PROTOCOL_LIMITS.maxRecords,
    "the lifetime bound must exceed the per-document bound, or separating them bought nothing");
  // Exactly at the old shared ceiling, and one past it: both are legal chain lengths now.
  assert.doesNotThrow(() => assertWorkspaceRecordCount(PROTOCOL_LIMITS.maxRecords));
  assert.doesNotThrow(() => assertWorkspaceRecordCount(PROTOCOL_LIMITS.maxRecords + 1));
  assert.doesNotThrow(() => assertWorkspaceRecordCount(PROTOCOL_LIMITS.maxChainEvents));
});

// Red leg: raise maxRecords alongside maxChainEvents -- the change that was nearly made --
// and a canonical array of eleven thousand elements starts being accepted, which no
// measurement in INC-224 supports and which is not what the chain needed.
test("INC-224: raising the chain bound did not loosen the document shape bound", () => {
  assert.equal(PROTOCOL_LIMITS.maxRecords, 10_000, "the per-document bound is unchanged");
  const overLong = Array.from({ length: PROTOCOL_LIMITS.maxRecords + 1 }, (_, index) => index);
  assert.throws(() => canonicalJson(overLong), (error) => error?.reasonCode === "INPUT_OVERSIZED",
    "a canonical array past the record limit is still refused");
  const overWide = Object.fromEntries(overLong.map((index) => [`k${index}`, index]));
  assert.throws(() => canonicalJson(overWide), (error) => error?.reasonCode === "INPUT_OVERSIZED",
    "a canonical object past the property limit is still refused");
});

// The lifetime bound must still be a bound. Red leg: drop the comparison and the chain
// has no ceiling at all, which is a different defect from the one being fixed.
test("INC-224: the chain bound still refuses past its own ceiling, and refuses nonsense", () => {
  assert.throws(() => assertWorkspaceRecordCount(PROTOCOL_LIMITS.maxChainEvents + 1),
    (error) => error?.reasonCode === "WORKSPACE_RECORD_LIMIT");
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => assertWorkspaceRecordCount(bad),
      (error) => error?.reasonCode === "WORKSPACE_RECORD_LIMIT", String(bad));
  }
});

// The refusal has to name the count it refused, because the operator's next question is
// always "how far past". Red leg: pass a constant string and the number is gone.
test("INC-224: a refused count is reported, not just refused", () => {
  const over = PROTOCOL_LIMITS.maxChainEvents + 7;
  assert.throws(() => assertWorkspaceRecordCount(over), (error) => error?.message === String(over));
});
