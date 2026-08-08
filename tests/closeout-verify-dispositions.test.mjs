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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyCloseout } from "../scripts/closeout-verify.mjs";

const V1 = "tcrn.closeout-verify.v1";
const V2 = "tcrn.closeout-verify.v2";

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

  test("chain-backed closeouts reconcile the authoritative item set and per-item notes", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INC-090",
      items: ["INC-090", "INC-091"],
      chainItems: [{ externalKey: "INC-090" }, { id: "INC-091" }],
      chainAnnotations: {
        "INC-090": "red-leg refusal receipt evidence/090.json sha256=abc",
        "INC-091": "negative-leg refusal receipt evidence/091.json sha256=def",
      },
      dispositions: {
        "INC-090": { kind: "fixed" },
        "INC-091": { kind: "fixed" },
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
  });

  test("reds when chain-derived closeout notes omit the red leg or evidence anchor", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INC-090",
      items: ["INC-090"],
      chainItems: [{ id: "INC-090" }],
      chainNotes: { "INC-090": "closeout says done" },
      dispositions: { "INC-090": { kind: "fixed" } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("names no evidence/receipt/hash")));
    assert.ok(result.problems.some((p) => p.includes("names no red-leg/negative-leg")));
  });

  test("execution-form and actor declarations are required when the manifest opts in", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INC-092",
      items: ["INC-092"],
      chainItems: [{ id: "INC-092" }],
      chainNotes: { "INC-092": "red-leg receipt evidence/092.json" },
      requireExecutionForm: true,
      dispositions: { "INC-092": { kind: "fixed" } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("execution-form")));
    assert.ok(result.problems.some((p) => p.includes("attributed persona")));
  });

  test("INIT-020 reds when the caller supplies only a self-selected items list", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INIT-020",
      items: ["INC-061"],
      dispositions: { "INC-061": { kind: "fixed" } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("authoritativeItems")));
  });

  test("INIT-020 compares the closeout list to chain-derived items and authority evidence", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "closeout-live-authority-"));
    mkdirSync(join(projectRoot, "evidence"), { recursive: true });
    writeFileSync(join(projectRoot, "evidence", "061.json"), "061\n");
    writeFileSync(join(projectRoot, "evidence", "062.json"), "062\n");
    const common = {
      schemaVersion: V2,
      incident: "TCRN-CROSS-INIT-020",
      authoritativeItems: ["INC-061", "INC-062"],
      chainAuthority: {
        schemaVersion: "tcrn.closeout-chain-authority.v1",
        source: "live-facade-read:status+work-list",
        partition: "cross-project",
        observedAt: "2026-08-07T00:00:00Z",
        workspaceId: "workspace:test",
        version: 2,
        headEventHash: "b".repeat(64),
      },
      chainNotes: {
        "INC-061": "receipt evidence/061.json red-leg result",
        "INC-062": "receipt evidence/062.json red-leg result",
      },
      dispositions: {
        "INC-061": { kind: "fixed" },
        "INC-062": { kind: "fixed" },
      },
    };
    const authority = {
      schemaVersion: "tcrn.closeout-live-authority.v1",
      source: "live-facade-read:status+work-list",
      partition: "cross-project",
      observedAt: "2026-08-07T00:00:00Z",
      head: { workspaceId: "workspace:test", version: 2, headEventHash: "b".repeat(64) },
      scope: {
        schemaVersion: "tcrn.closeout-scope.v1",
        source: "live-facade-read:work-show",
        workId: "work:" + "c".repeat(24),
        externalKey: "TCRN-CROSS-STORY-172",
        text: "INC-061..062 red-leg receipt evidence",
        itemIds: ["INC-061", "INC-062"],
      },
      items: [
        { externalKey: "INC-061", scope: "red-leg receipt evidence/061.json" },
        { externalKey: "INC-062", scope: "red-leg receipt evidence/062.json" },
        { externalKey: "TCRN-CROSS-INC-999", id: "work:" + "d".repeat(24) },
      ],
    };
    try {
      assert.equal(verifyCloseout({ ...common, items: ["INC-061", "INC-062"] }, { authority, projectRoot }).ok, true);
      const liveOnly = { ...common, items: ["INC-061", "INC-062"] };
      delete liveOnly.authoritativeItems;
      delete liveOnly.chainNotes;
      assert.equal(verifyCloseout(liveOnly, { authority, projectRoot }).ok, true);
      const withoutScope = { ...authority };
      delete withoutScope.scope;
      const scopeMissing = verifyCloseout(liveOnly, { authority: withoutScope, projectRoot });
      assert.equal(scopeMissing.ok, false);
      assert.ok(scopeMissing.problems.some((p) => p.includes("live work-show scope-derived item set")));
      const omitted = verifyCloseout({ ...common, items: ["INC-061"], dispositions: { "INC-061": { kind: "fixed" } } }, { authority, projectRoot });
      assert.equal(omitted.ok, false);
      assert.ok(omitted.problems.some((p) => p.includes("chain-derived item set")));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("closeout-verify windowed red-leg obligation (INC-077)", () => {
  const RED_LEG = {
    schemaVersion: "tcrn.closeout-red-leg.v1",
    target: "cross-project file tree",
    oldPathway: "engine CLI via SSH with no TCRN_PG_*",
    refusalReasonCode: "WORKSPACE_STORAGE_RELOCATED",
    evidence: "red-leg-record-2026-08-07.json",
  };

  test("reconciles a windowed closeout that carries a well-formed redLeg", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INC-077",
      windowed: true,
      redLeg: RED_LEG,
      items: ["freeze-file-tree"],
      dispositions: { "freeze-file-tree": { kind: "fixed" } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, "CLOSEOUT_ITEMS_RECONCILED");
  });

  test("REDS when a windowed closeout omits the redLeg — only a positive leg is not acceptance", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INC-077",
      windowed: true, // redLeg deliberately omitted
      items: ["freeze-file-tree"],
      dispositions: { "freeze-file-tree": { kind: "fixed" } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("windowed closeout requires a redLeg record")));
  });

  test("REDS when a redLeg is present but empty (copy-pasted or emptied field)", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INC-077",
      windowed: true,
      redLeg: { schemaVersion: "tcrn.closeout-red-leg.v1", target: "", oldPathway: "", refusalReasonCode: "", evidence: "" },
      items: ["freeze-file-tree"],
      dispositions: { "freeze-file-tree": { kind: "fixed" } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("redLeg.target must name")));
  });

  test("REDS when INIT-020 windowed items try to self-report windowed:false", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INIT-020",
      windowed: false,
      items: ["INC-074"],
      dispositions: { "INC-074": { kind: "fixed" } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("require windowed:true")));
  });

  test("REDS when a non-windowed manifest still carries a malformed redLeg", () => {
    const result = verifyCloseout({
      schemaVersion: V1,
      incident: "TCRN-CROSS-INC-077",
      redLeg: { schemaVersion: "tcrn.closeout-red-leg.v1", target: "x", oldPathway: "", refusalReasonCode: "", evidence: "y" },
      items: ["item"],
      dispositions: { item: { kind: "fixed" } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("redLeg.refusalReasonCode must name")));
  });
});
