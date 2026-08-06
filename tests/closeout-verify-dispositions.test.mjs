// SPDX-License-Identifier: Apache-2.0
// closeout-verify disposition-kind conformance.
//
// TCRN-CROSS-STORY-172: the INC-061..071 closeout manifest introduces a
// `superseded` disposition (an item carried by a named downstream work item).
// This test pins the three red legs that matter: a batch omitting an original
// item must red; a superseded disposition without a carrying chain work id must
// red; a disposition naming an unknown item must red. Positive: every item with
// exactly one disposition (fixed / retained / superseded / deferred) reconciles.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { verifyCloseout } from "../scripts/closeout-verify.mjs";

const V1 = "tcrn.closeout-verify.v1";

describe("closeout-verify disposition kinds (STORY-172)", () => {
  test("reconciles a batch where every item has exactly one disposition", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INC-061",
      items: ["INC-061", "INC-062", "INC-069", "INC-068"],
      dispositions: {
        "INC-061": { kind: "superseded", carriedBy: "work:aaaaaaaaaaaaaaaaaaaaaaaa" },
        "INC-062": { kind: "retained", ticket: "work:aaaaaaaaaaaaaaaaaaaaaaaa" },
        "INC-069": { kind: "fixed" },
        "INC-068": { kind: "deferred", reason: "convention revision awaits owner" },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, "CLOSEOUT_ITEMS_RECONCILED");
    assert.deepEqual(result.problems, []);
  });

  test("reds when an original item is omitted from the disposition set", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INC-061",
      items: ["INC-061", "INC-062"],
      dispositions: {
        "INC-061": { kind: "superseded", carriedBy: "work:aaaaaaaaaaaaaaaaaaaaaaaa" },
        // INC-062 deliberately omitted
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "CLOSEOUT_ITEMS_UNRECONCILED");
    assert.ok(result.problems.some((p) => p.includes("INC-062 has no disposition")));
  });

  test("reds when a superseded disposition names no carrying chain work id", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INC-061",
      items: ["INC-061"],
      dispositions: {
        "INC-061": { kind: "superseded" }, // carriedBy missing
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("INC-061 is superseded but names no carrying chain work id")));
  });

  test("reds when a superseded disposition names an unknown item", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INC-061",
      items: ["INC-061"],
      dispositions: {
        "INC-061": { kind: "superseded", carriedBy: "work:aaaaaaaaaaaaaaaaaaaaaaaa" },
        "INC-999": { kind: "fixed" },
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("disposition names unknown item INC-999")));
  });

  test("reds on an unknown disposition kind", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INC-061",
      items: ["INC-061"],
      dispositions: { "INC-061": { kind: "absorbed" } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("INC-061 has unknown disposition absorbed")));
  });

  test("reds when a retained disposition names no chain work ticket", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INC-062",
      items: ["INC-062"],
      dispositions: { "INC-062": { kind: "retained" } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("INC-062 is retained but names no chain work ticket")));
  });
});
