// SPDX-License-Identifier: Apache-2.0
//
// STORY-300 slice 2. One append and many appends are the same operation with a
// different count, so there is one implementation and the single write is its N=1
// case. Every existing chain-write verb -- thirty-two call sites -- now runs the
// batch code path, which is the arrangement that keeps it from rotting: a defect
// in the fold is a defect in every write, not in a road only batches travel.
//
// What the rest of the suite already proves is the N=1 half: it passes unchanged,
// byte for byte, against the generalised kernel. What it cannot reach is the fold
// itself, so these are its criteria.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  appendEvents,
  createProject,
  initializeWorkspace,
  materializeWorkspace,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { assertCanonicalJson, compareCanonicalText, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

// The delta a project-create verb builds, rebuilt here so a batch can be made of
// real operations rather than of shapes replay would refuse. The id derivation and
// the sorted insertion are the two parts that must match the verb exactly: replay
// re-derives both, and a hand-made approximation of either is read as corruption.
function projectCreated(externalKey, name, occurredAt) {
  const id = deriveStableId("project", externalKey);
  return (state) => {
    const record = {
      schemaVersion: "tcrn.project.v1",
      id,
      externalKey,
      name,
      revision: 1,
      updatedAt: occurredAt,
      tombstone: false,
    };
    return {
      payload: { operation: "project.created", record },
      projects: [...state.projects, record].sort((left, right) => compareCanonicalText(left.id, right.id)),
      work: state.work,
    };
  };
}

function instant(offset) {
  return `2026-01-01T00:00:${String(offset).padStart(2, "0")}Z`;
}

async function fixture(context, segmentEventLimit = 4) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s300-append-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: "WORKSPACE-S300-APPEND", createdAt: instant(0), segmentEventLimit });
  const workspace = join(base, "workspace");
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  context.after(() => lease.release().catch(() => undefined));
  return { workspace, lease };
}

// A batch member builds its delta from the state the members before it produced.
// Red leg: hand every member the pre-batch state and the second project's payload
// stops seeing the first, so the fold produces a chain replay refuses.
test("STORY-300: each member of a batch sees what the members before it wrote", async (context) => {
  const { workspace, lease } = await fixture(context);
  const seen = [];
  const committed = await appendEvents(workspace, lease, [0, 1, 2].map((index) => {
    const build = projectCreated(`PROJECT-${index}`, `Project ${index}`, instant(2));
    return (state) => {
      seen.push(state.version);
      return build(state);
    };
  }), { expectedVersion: 0, occurredAt: instant(2) });

  assert.deepEqual(seen, [0, 1, 2], "each member is built against the version its predecessor committed");
  assert.equal(committed.version, 3, "one batch, three events");
  assert.equal(committed.projects.length, 3);
  // The chain the batch wrote must be the chain a fresh replay reads.
  const rematerialized = await materializeWorkspace(workspace);
  assert.equal(rematerialized.version, 3);
  assert.equal(rematerialized.headEventHash, committed.headEventHash);
  // Sorted for the comparison because the chain sorts projects by derived id, which
  // is a hash and therefore unrelated to the order the batch wrote them in.
  assert.deepEqual(rematerialized.projects.map((entry) => entry.externalKey).sort(), ["PROJECT-0", "PROJECT-1", "PROJECT-2"]);
  assert.equal((await validateWorkspace(workspace)).version, 3, "views match the state the batch returned");
});

// The segment limit here is four, so a batch of three starting at version three
// straddles a boundary. Red leg: write the segments in descending order and the
// first segment is left under-full, which materialize reads as corruption -- the
// one ordering that takes status and recover down together.
test("STORY-300: a batch that crosses a segment boundary writes ascending and replays clean", async (context) => {
  const { workspace, lease } = await fixture(context, 4);
  let state = await createProject(workspace, lease, {
    expectedVersion: 0, occurredAt: instant(2), externalKey: "PROJECT-ANCHOR", name: "Anchor",
  });
  state = await createProject(workspace, lease, {
    expectedVersion: 1, occurredAt: instant(3), externalKey: "PROJECT-ANCHOR-2", name: "Anchor 2",
  });
  state = await createProject(workspace, lease, {
    expectedVersion: 2, occurredAt: instant(4), externalKey: "PROJECT-ANCHOR-3", name: "Anchor 3",
  });
  assert.equal(state.version, 3);

  const committed = await appendEvents(workspace, lease,
    [0, 1, 2].map((index) => projectCreated(`SPAN-${index}`, `Span ${index}`, instant(5))),
    { expectedVersion: 3, occurredAt: instant(5) });

  assert.equal(committed.version, 6, "the batch spans versions four through six");
  const segments = (await readdir(join(workspace, ".tcrn-workflow", "events"))).sort();
  assert.deepEqual(segments, ["000001.json", "000002.json"], "the batch opened the second segment");
  // The non-final segment must be exactly full: an under-full one is what replay
  // reads as a broken chain.
  const first = assertCanonicalJson(await readFile(join(workspace, ".tcrn-workflow", "events", "000001.json"), "utf8"));
  assert.equal(first.length, 4, "the earlier segment is written to its limit before the next one opens");
  const rematerialized = await materializeWorkspace(workspace);
  assert.equal(rematerialized.version, 6);
  assert.equal(rematerialized.headEventHash, committed.headEventHash);
  assert.equal((await validateWorkspace(workspace)).version, 6);
});

// Refusal is all-or-nothing and unconditional: a member that throws leaves the
// chain exactly as it was. Red leg: move the fold after the first writeSegment and
// the version advances while the call still fails -- INC-198's shape, rebuilt.
test("STORY-300: a member that refuses leaves the chain untouched", async (context) => {
  const { workspace, lease } = await fixture(context);
  const before = await materializeWorkspace(workspace);
  await assert.rejects(() => appendEvents(workspace, lease, [
    projectCreated("PROJECT-OK", "Ok", instant(2)),
    () => { throw new Error("member two cannot build its delta"); },
  ], { expectedVersion: 0, occurredAt: instant(2) }));

  const after = await materializeWorkspace(workspace);
  assert.equal(after.version, before.version, "a refused batch does not advance the version");
  assert.equal(after.headEventHash, before.headEventHash, "a refused batch does not move the head");
  assert.equal(after.projects.length, before.projects.length, "not even the member that succeeded is left behind");
  assert.deepEqual(await readdir(join(workspace, ".tcrn-workflow", "events")), [], "no segment was written");
});

// One batch is one mutation: one lease, one claim, one concurrency decision. Red
// leg: check the version per member and a batch of three needs three matching
// versions the caller cannot know in advance -- the pre-computed-counter failure
// that produced seven refusals for one real problem on 2026-08-13.
test("STORY-300: a batch takes one concurrency decision, not one per member", async (context) => {
  const { workspace, lease } = await fixture(context);
  await assert.rejects(
    () => appendEvents(workspace, lease, [(state) => ({ projects: state.projects, work: state.work, payload: { operation: "noop" } })],
      { expectedVersion: 7, occurredAt: instant(2) }),
    (error) => error?.reasonCode === "WORKSPACE_CAS_MISMATCH",
  );
  const committed = await appendEvents(workspace, lease,
    [0, 1].map((index) => projectCreated(`ONCE-${index}`, `Once ${index}`, instant(2))),
    { expectedVersion: 0, occurredAt: instant(2) });
  assert.equal(committed.version, 2, "the caller supplied one version for the whole batch");
});
