// SPDX-License-Identifier: Apache-2.0
//
// Core Reference personas are inert conference-role references. This suite pins
// the half of the corrected boundary that survives TCRN-CROSS-STORY-358: every role
// can be rendered for conference attribution, the render is explicit-profile and
// stdout-only, and a tampered upstream bundle fails closed. The main-session adapter
// half retired with the adapters themselves.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CORE_REFERENCE_PERSONA_IDS,
  PERSONA_RENDER_ALLOWED_PROFILE_IDS,
  PERSONA_RENDER_BUDGET_BYTES,
  PERSONA_RENDER_VERSION,
  generateCorePersonaBundle,
  renderPersonaAuthoritySummary,
  validatePersonaAuthorityRender,
} from "../dist/build/packages/core/src/index.js";
import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

function reason(code, operation) {
  assert.throws(operation, (error) => error?.reasonCode === code, code);
}

function resealProfile(profile) {
  const basis = {
    schemaVersion: profile.schemaVersion,
    profileId: profile.profileId,
    displayName: profile.displayName,
    jobTitle: profile.jobTitle,
    mission: profile.mission,
    authorityBoundary: profile.authorityBoundary,
    contactWhen: profile.contactWhen,
    requiredInputs: profile.requiredInputs,
    deliverables: profile.deliverables,
    refusals: profile.refusals,
    successCriteria: profile.successCriteria,
    collaborationRelationships: profile.collaborationRelationships,
  };
  return { ...basis, profileDigest: canonicalSha256(basis) };
}

test("all eight closed Core Reference roles render as conference-only references", () => {
  assert.deepEqual(PERSONA_RENDER_ALLOWED_PROFILE_IDS, CORE_REFERENCE_PERSONA_IDS);
  assert.equal(CORE_REFERENCE_PERSONA_IDS.length, 8);
  const bundle = generateCorePersonaBundle();
  for (const profileId of CORE_REFERENCE_PERSONA_IDS) {
    const first = renderPersonaAuthoritySummary(bundle, profileId);
    const second = renderPersonaAuthoritySummary(bundle, profileId);
    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.equal(first.schemaVersion, PERSONA_RENDER_VERSION);
    assert.equal(first.scope, "conference_position_reference");
    assert.equal(first.profileId, profileId);
    assert.ok(first.text.includes("Conference role reference:"));
    assert.ok(first.text.includes("does not bind the main thread"));
    assert.ok(first.byteLength <= PERSONA_RENDER_BUDGET_BYTES);
    assert.equal(validatePersonaAuthorityRender(first).renderDigest, first.renderDigest);
  }
});

test("unknown roles and over-budget conference references fail closed", () => {
  const bundle = generateCorePersonaBundle();
  reason("RENDER_PERSONA_NOT_ALLOWED", () =>
    renderPersonaAuthoritySummary(bundle, "profile:tcrn-nobody-v1"),
  );
  reason("RENDER_BUDGET_EXCEEDED", () =>
    renderPersonaAuthoritySummary(bundle, CORE_REFERENCE_PERSONA_IDS[0], {
      template: () => "x".repeat(PERSONA_RENDER_BUDGET_BYTES + 1),
    }),
  );
});

test("upstream persona tamper still fails against the exact source manifest", () => {
  const bundle = generateCorePersonaBundle();
  const profileId = "profile:tcrn-verity-v1";
  const naive = structuredClone(bundle);
  const naiveVerity = naive.profiles.find((profile) => profile.profileId === profileId);
  naiveVerity.authorityBoundary += " and may approve everything";
  reason("PERSONA_CANONICAL_INVALID", () =>
    renderPersonaAuthoritySummary(naive, profileId),
  );

  const resealed = structuredClone(bundle);
  const target = resealed.profiles.find((profile) => profile.profileId === profileId);
  target.authorityBoundary += " and may approve everything";
  const changed = resealProfile(target);
  resealed.profiles = resealed.profiles.map((profile) =>
    profile.profileId === profileId ? changed : profile,
  );
  reason("PERSONA_SOURCE_MISMATCH", () =>
    renderPersonaAuthoritySummary(resealed, profileId),
  );
});

test("persona-render is an explicit-profile, stdout-only conference aid", async () => {
  const entry = COMMAND_CATALOG.find((candidate) => candidate.name === "persona-render");
  assert.deepEqual(entry, {
    name: "persona-render",
    availability: "cli",
    mutates: false,
    flags: [{ name: "profile-id", required: true, valueKind: "string" }],
  });
  let output = "";
  await runCli(
    ["persona-render", "--profile-id", "profile:tcrn-sable-v1"],
    { write: (value) => { output = value; } },
  );
  const render = validatePersonaAuthorityRender(JSON.parse(output));
  assert.equal(render.profileId, "profile:tcrn-sable-v1");
  assert.equal(render.scope, "conference_position_reference");

  const cliSource = await readFile(new URL("../packages/cli/src/index.ts", import.meta.url), "utf8");
  assert.equal(cliSource.split("renderPersonaAuthoritySummary(").length - 1, 1);
  assert.equal(cliSource.includes("persona-render.json"), false);
});
