// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-INC-230. A card must be findable by the specifics it stores.
//
// The metadata search filter scanned subject, summary and tags. The snippet -- the
// field defined as the card's bounded excerpt, and therefore where a card puts its
// specifics -- was already loaded in the same scan and was not looked at. Found by
// filing a real card whose snippet said "flake", searching for it, and getting nothing
// back while the card sat two rows away in the same listing.
//
// Bodies stay unsearched, and that is not the same omission: not opening bodies is the
// metadata-first budget discipline the whole retrieval surface is built on. Skipping a
// field the filter already holds is just a gap.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  createKnowledgeUnit,
  createProject,
  initializeKnowledgeStore,
  initializeWorkspace,
  listKnowledgeMetadata,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const instant = (second = 0) => `2026-08-19T14:00:${String(second).padStart(2, "0")}Z`;

async function storeWithOneCard() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc230-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: "INC230", createdAt: instant(), segmentEventLimit: 64 });
  const workspace = join(base, "workspace");
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  let state;
  try {
    state = await createProject(workspace, lease, {
      expectedVersion: 0, occurredAt: instant(1), externalKey: "INC230-PROJECT", name: "Retrieval",
    });
  } finally {
    await lease.release();
  }
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  await createKnowledgeUnit(workspace, {
    expectedVersion: 0, occurredAt: instant(2), externalKey: "INC230-CARD",
    scope: "project", projectId: state.projects[0].id, roleScopes: [],
    category: "workflow", kind: "guide", tags: ["method"],
    // The distinguishing word lives ONLY in the snippet. Subject, summary and tags are
    // deliberately free of it, so a hit can only come from the snippet being scanned.
    subject: "A measurement can be narrower than the claim it supports",
    summary: "Each wrong reading used an instrument that could only return the expected answer.",
    // TCRN-CROSS-INC-232: the distinguishing word is MIXED CASE on purpose. With a
    // lowercase snippet the fold is unobservable -- the search term is lowercased before
    // comparison, so a lowercase haystack matches with or without folding, and the
    // case-folding criterion below could not fail.
    snippet: "A load-sensitive criterion was declared a FlAkE after two isolated runs passed.",
    accountableOwnerId: deriveStableId("owner", "INC230-OWNER"),
    sourceReferences: ["evidence://fixture/inc230"],
    sourceDigest: canonicalSha256({ key: "INC230-CARD" }),
    linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [],
    lifecycle: "active", retrievalDisposition: "default", freshnessState: "fresh",
    lastVerified: instant(1),
    stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: "The body also says flake, and must not be what matched.",
  });
  return { base, workspace };
}

const search = (workspace, term) =>
  listKnowledgeMetadata(workspace, { at: instant(3), selection: "all", search: term });

// Red leg: drop the snippet term from the filter and this returns zero -- which is what
// the live cross-project store did on 2026-08-19 with a card that plainly said "flake".
test("INC-230: a card is findable by a word that appears only in its snippet", async () => {
  const { base, workspace } = await storeWithOneCard();
  try {
    const found = await search(workspace, "flake");
    assert.equal(found.total, 1, "the snippet is part of what search looks at");
    assert.equal(found.records[0].externalKey, "INC230-CARD");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// The three fields that already worked must keep working; widening one must not be
// paid for by narrowing another. Red leg: replace rather than extend the disjunction.
test("INC-230: subject, summary and tag matching are unchanged", async () => {
  const { base, workspace } = await storeWithOneCard();
  try {
    for (const term of ["narrower", "instrument", "method"]) {
      assert.equal((await search(workspace, term)).total, 1, `${term} must still match`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Red leg: reach into the body and the metadata-first discipline is gone -- searching
// bodies is the thing this surface exists not to do, and a widening that quietly took
// it would be a far larger change than the one being made.
test("INC-230: the body is still not searched", async () => {
  const { base, workspace } = await storeWithOneCard();
  try {
    const found = await search(workspace, "must not be what matched");
    assert.equal(found.total, 0, "a phrase unique to the body matches nothing");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Case folding has to apply to the new field on the same terms as the old ones, or the
// widening is real for lowercase queries and absent for every other spelling.
test("INC-230: snippet matching folds case like the fields beside it", async () => {
  const { base, workspace } = await storeWithOneCard();
  try {
    for (const term of ["FLAKE", "Flake", "fLaKe", "flake"]) {
      assert.equal((await search(workspace, term)).total, 1, `${term} must match`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
