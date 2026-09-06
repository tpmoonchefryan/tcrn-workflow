// SPDX-License-Identifier: Apache-2.0
//
// INC-006: authority-bearing output must not be minted from self-described JSON.
//
// TCRN-CROSS-STORY-358 family 1 ("adapters"): this file carried five cases. "ACT13:
// self-described, tampered, forged, cloned, and mismatched observations cannot mint
// activation" and "INC-017: a pinned observation cannot be replayed past the window
// that admitted it" drove the retired Codex adapter-activation machinery end to end and
// retire with it. "INC-012: the guarded vocabulary covers every host-state field core
// declares" scanned packages/core/src for hand-authored host-shaped field declarations
// and bound them two-way to AUTHORITY_OUTPUT_FIELDS; every declaration it ever found
// lived in codex-adapter-activation.ts and codex-adapter-installer.ts, both retired
// here, so there is nothing left anywhere in core for it to scan. See
// scripts/policy/coverage-waivers.json for the disposition of all three. The two
// surviving cases below test packages/cli/src/index.ts's CLI write boundary directly
// and carry no adapter dependency.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertDeclaredOutputCategory,
  authorityShapedOutputFields,
} from "../dist/build/packages/cli/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

function reason(code, operation) {
  assert.throws(operation, (error) => error?.reasonCode === code, code);
}

test("INC-012: authority-shaped output from a verb that does not declare it fails closed", () => {
  const hostState = canonicalJson({
    activationState: "host_observed_active",
    currentDefinitionApproved: true,
    hookFired: true,
    trustApprovalObserved: true,
  });
  // A read verb emitting this would be laundering caller-chosen input into evidence.
  reason("CLI_AUTHORITY_OUTPUT_UNDECLARED", () =>
    assertDeclaredOutputCategory("work-show", hostState));
  // A verb absent from the catalog has declared nothing and may not speak either.
  reason("CLI_AUTHORITY_OUTPUT_UNDECLARED", () =>
    assertDeclaredOutputCategory("not-a-catalog-verb", hostState));
  // A renamed field carrying the same token is the same claim.
  reason("CLI_AUTHORITY_OUTPUT_UNDECLARED", () =>
    assertDeclaredOutputCategory(
      "work-show",
      canonicalJson({ hostState: "host_observed_active" }),
    ));
  // Nesting is not a hiding place, and a boolean host act carries no token to match on.
  reason("CLI_AUTHORITY_OUTPUT_UNDECLARED", () =>
    assertDeclaredOutputCategory(
      "work-show",
      canonicalJson({ records: [{ inner: { hookFired: true } }] }),
    ));
  // Bytes that spell the claim but cannot be parsed are refused, not waved through.
  reason("CLI_AUTHORITY_OUTPUT_UNDECLARED", () =>
    assertDeclaredOutputCategory(
      "work-show",
      '{"activationState":"host_observed_active"',
    ));

  // TCRN-CROSS-STORY-358 family 1: adapter-activation-record was the sole catalog verb
  // ever declared authorityBearing:true, and adapter-activate the mutates:true verb this
  // case used for the other declared branch; both retire in this change with the rest of
  // the adapter verbs. work-create is a live mutates:true verb and stands in for that
  // branch; assertDeclaredOutputCategory's authorityBearing:true branch is untouched
  // product code (packages/cli/src/index.ts), but no catalog entry remains to exercise it.
  assertDeclaredOutputCategory("work-create", hostState);
  // And ordinary reads are untouched: the claim lives in object keys, so caller text that
  // merely mentions a guarded name is not a finding.
  assertDeclaredOutputCategory(
    "work-show",
    canonicalJson({ status: "done", note: "activationState" }),
  );
  assert.deepEqual(
    authorityShapedOutputFields(canonicalJson({ note: "host_observed_active" })),
    [],
  );
  assert.deepEqual(
    authorityShapedOutputFields(canonicalJson({ activationState: "x" })),
    ["activationState"],
  );
});

test("INC-012: every dispatched write passes the guarded output boundary", async () => {
  const module = await import("../dist/build/packages/cli/src/index.js");
  assert.equal(typeof module.runCli, "function");
  // The unguarded dispatcher is not reachable from outside the module.
  assert.equal(module.dispatchCli, undefined);
  const source = await readFile(
    new URL("../packages/cli/src/index.ts", import.meta.url),
    "utf8",
  );
  // Exactly one guarded io is constructed, and the raw dispatcher is declared once and
  // called once -- so no verb can obtain an io that writes around the boundary.
  assert.equal(
    source.split("assertDeclaredOutputCategory(command, value)").length - 1,
    1,
  );
  assert.equal(source.split("dispatchCli(").length - 1, 2);
});
