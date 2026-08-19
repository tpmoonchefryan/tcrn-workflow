// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-STORY-300, slice 3. Recording N facts costs one act.
//
// Measured on the same machine, same records: forty single verbs take 1,651 ms with forty
// leases and forty CAS decisions; one batch of forty takes 51 ms with one of each. That
// ratio is the ceremony this platform's own audit called backwards, and filing four
// knowledge cards on 2026-08-19 paid sixteen round trips for it.
//
// The criteria below are mostly not about speed. They are about the two things a batch can
// get wrong in ways a fast implementation would hide: writing part of itself, and blaming
// the wrong member.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  applyWorkBatch,
  createProject,
  initializeWorkspace,
  materializeWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = (second = 0) => `2026-08-19T18:00:${String(second).padStart(2, "0")}Z`;

const STORY_SCOPE = [
  "## Goal",
  "为谁:the operator. 目的锚:STORY-300. 符合性判据:one batch, one receipt. 判定人:machine-checked lane.",
  "", "## Requirements", "- 实现 the batch primitive.",
  "", "## Acceptance Criteria", "GIVEN a batch WHEN it runs THEN all members land or none do",
  "", "## Business Background", "实测 sixteen round trips for four cards.",
  "", "## Preconditions", "- None.",
  "", "## Assumptions", "- None.",
  "", "## Use Cases & Examples", "- Record several facts as one act.",
  "", "## Feature Toggle & Setting", "None.",
  "", "## Permissions", "None.",
  "", "## Implementation Notes", "新增 the batch primitive.",
].join("\n");

async function workspace(key) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s300b-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: key, createdAt: at(0), segmentEventLimit: 64 });
  const root = join(base, "workspace");
  const lease = await acquireWorkspaceLease(root, { now: at(1) });
  let state;
  try {
    state = await createProject(root, lease, { expectedVersion: 0, occurredAt: at(1), externalKey: `${key}-P`, name: key });
  } finally {
    await lease.release();
  }
  return { base, root, projectId: state.projects[0].id, version: state.version };
}

const apply = async (fixture, members, second = 2) => {
  const lease = await acquireWorkspaceLease(fixture.root, { now: at(second) });
  try {
    return await applyWorkBatch(fixture.root, lease, { schemaVersion: "tcrn.work-batch.v1", members }, {
      expectedVersion: fixture.version, occurredAt: at(second),
    });
  } finally {
    await lease.release();
  }
};

const refusal = async (fixture, members, second = 2) => {
  try {
    await apply(fixture, members, second);
    return null;
  } catch (error) {
    return { reasonCode: error?.reasonCode, payload: JSON.parse(error.message) };
  }
};

// Red leg: drop the accumulated-state threading from transitionWork's admission and
// member 2 reads a workspace where member 1's record does not exist -- failing
// indistinguishably from the record genuinely not existing, which is the state this slice
// was blocked on. Two levels of parent reference, because a Story must hang under a parent
// and without parentExternalKey the commonest batch there is cannot be expressed.
test("STORY-300: heterogeneous members act on what earlier members created, by external key", async () => {
  const fixture = await workspace("BATCH-OK");
  try {
    const state = await apply(fixture, [
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-INIT-1", kind: "Initiative", parentId: null, status: "active" },
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-EPIC-1", kind: "Epic", parentExternalKey: "B-INIT-1", status: "active" },
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-STORY-1", kind: "Story", parentExternalKey: "B-EPIC-1", status: "planned", scope: STORY_SCOPE },
      { verb: "work-transition", externalKey: "B-STORY-1", status: "ready" },
      { verb: "work-annotate", externalKey: "B-STORY-1", scope: `${STORY_SCOPE}\n\n附注:batched.` },
    ]);
    assert.equal(state.version, fixture.version + 5, "five members, five events, one act");
    const story = state.work.find((record) => record.id === deriveStableId("work", "B-STORY-1"));
    assert.equal(story.status, "ready", "the transition saw the record its predecessor created");
    assert.equal(story.revision, 3, "created, transitioned and annotated within the batch");
    assert.equal(story.parentId, deriveStableId("work", "B-EPIC-1"), "and the parent reference resolved by key");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Red leg: let appendEvents write what it has when a later member throws, and a batch
// leaves a partial subtree on an append-only chain -- which cannot be taken back.
test("STORY-300: a member failing mid-batch leaves the chain exactly where it was", async () => {
  const fixture = await workspace("BATCH-ATOMIC");
  try {
    const before = await materializeWorkspace(fixture.root);
    const result = await refusal(fixture, [
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-INC-9", kind: "Incident", parentId: null, status: "planned" },
      { verb: "work-transition", externalKey: "B-INC-9", status: "done" },
      { verb: "work-annotate", externalKey: "B-INC-9", scope: "never reached" },
    ]);
    assert.equal(result.reasonCode, "WORK_BATCH_REFUSED");
    const after = await materializeWorkspace(fixture.root);
    assert.equal(after.version, before.version, "nothing was written");
    assert.equal(after.headEventHash, before.headEventHash, "and the head did not move");
    assert.equal(after.work.length, before.work.length);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// The distinction the acceptance criterion asks for, and it must be structural rather
// than a difference in wording. Red leg: report every member after the failure as failed
// and three members are called invalid when one was judged and two were never looked at.
test("STORY-300: the member that failed is named with its rule; the rest are unevaluated, not invalid", async () => {
  const fixture = await workspace("BATCH-BLAME");
  try {
    const result = await refusal(fixture, [
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-INC-8", kind: "Incident", parentId: null, status: "planned" },
      { verb: "work-transition", externalKey: "B-INC-8", status: "done" },
      { verb: "work-annotate", externalKey: "B-INC-8", scope: "never reached" },
      { verb: "work-annotate", externalKey: "B-INC-8", scope: "also never reached" },
    ]);
    assert.equal(result.payload.stage, "apply");
    assert.equal(result.payload.failed.index, 1);
    assert.equal(result.payload.failed.verb, "work-transition");
    // The member's OWN reason code, not a generic one. It was being swallowed by an
    // instanceof check that does not hold across separately built module graphs, which
    // turned every member failure into WORKSPACE_ERROR.
    assert.equal(result.payload.failed.reasonCode, "INVALID_TRANSITION");
    assert.equal(result.payload.failed.detail, "planned:done");
    assert.deepEqual(result.payload.notEvaluated, [2, 3], "the members after it were never judged");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Shape failures belong to the members that earned them, so every one is reported at once
// rather than one per round trip -- which is the ceremony this slice exists to remove,
// reappearing inside the refusal path. Red leg: return on the first shape problem.
test("STORY-300: every shape problem is reported together, before any state is consulted", async () => {
  const fixture = await workspace("BATCH-SHAPE");
  try {
    const result = await refusal(fixture, [
      { verb: "work-invent", id: "work:x" },
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-S-1", kind: "Nonsense" },
      { verb: "work-transition", externalKey: "B-S-1", status: "sideways" },
      { verb: "work-annotate", externalKey: "B-S-1" },
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-S-2", kind: "Story" },
    ]);
    assert.equal(result.reasonCode, "WORK_BATCH_REFUSED");
    assert.equal(result.payload.stage, "shape", "no state was consulted");
    assert.deepEqual([...new Set(result.payload.problems.map((problem) => problem.index))], [0, 1, 2, 3, 4],
      "all five members are judged, not just the first to fail");
    const rules = new Set(result.payload.problems.map((problem) => problem.rule));
    for (const rule of ["verb-known", "kind-known", "status-known", "advisory-required", "story-scope-required"]) {
      assert.ok(rules.has(rule), `${rule} is reported`);
    }
    assert.equal(result.payload.notEvaluated, undefined, "nothing is consequential when nothing was applied");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Red leg: derive the reference from externalKey even when id is present, and an explicit
// id is silently replaced by a derivation that may name a different record entirely.
test("STORY-300: an explicit id wins over a derivable one", async () => {
  const fixture = await workspace("BATCH-REF");
  try {
    const state = await apply(fixture, [
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-INC-7", kind: "Incident", parentId: null, status: "planned" },
      // id names B-INC-7; externalKey names something that does not exist. If the key won,
      // this would fail -- so passing proves the id was used.
      { verb: "work-transition", id: deriveStableId("work", "B-INC-7"), externalKey: "B-ABSENT", status: "ready" },
    ]);
    const record = state.work.find((entry) => entry.id === deriveStableId("work", "B-INC-7"));
    assert.equal(record.status, "ready");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Red leg: accept an empty or foreign document and a caller gets a receipt for an act that
// never described anything.
test("STORY-300: a batch that is not a batch is refused before anything else happens", async () => {
  const fixture = await workspace("BATCH-DOC");
  try {
    for (const document of [null, [], { members: [] }, { schemaVersion: "tcrn.work-batch.v1" }, { schemaVersion: "other", members: [{}] }]) {
      const lease = await acquireWorkspaceLease(fixture.root, { now: at(2) });
      try {
        await assert.rejects(
          () => applyWorkBatch(fixture.root, lease, document, { expectedVersion: fixture.version, occurredAt: at(2) }),
          (error) => error?.reasonCode === "WORK_BATCH_MALFORMED", JSON.stringify(document));
      } finally {
        await lease.release();
      }
    }
    // An empty members array is malformed rather than a no-op: a batch of nothing is a
    // caller mistake, and answering it with a receipt would say an act occurred.
    const lease = await acquireWorkspaceLease(fixture.root, { now: at(3) });
    try {
      await assert.rejects(
        () => applyWorkBatch(fixture.root, lease, { schemaVersion: "tcrn.work-batch.v1", members: [] }, { expectedVersion: fixture.version, occurredAt: at(3) }),
        (error) => error?.reasonCode === "WORK_BATCH_MALFORMED");
    } finally {
      await lease.release();
    }
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// The acceptance criterion nobody had written a test for, and the one hazard batching
// actually introduces. Before this slice a single append produced one event, so
// writes.length was always 1 and a crash between segment writes was unreachable. A batch
// makes it reachable, and the loop at workspace.ts has no unwind.
//
// It is not a defect, and the difference matters: segments are written in ascending order
// and only the final segment may be under-full, so the on-disk state after a crash between
// writes -- an ascending prefix present, the rest absent -- is a shorter legal chain rather
// than a damaged one. That is what the Story's criterion asks for in the words "the crash
// window leaves a legal prefix". It was true and unasserted, which is the same standing as
// untrue for anything that has to keep being true.
test("STORY-300: a batch spanning segments writes ascending, and every crash window is a legal prefix", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s300seg-")));
  try {
    const roots = [];
    for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
      const path = join(base, kind);
      await mkdir(path);
      roots.push({ kind, path });
    }
    // Four events a segment, so fourteen members provably span several.
    await initializeWorkspace({ roots, externalKey: "SEG", createdAt: at(0), segmentEventLimit: 4 });
    const root = join(base, "workspace");
    const lease = await acquireWorkspaceLease(root, { now: at(1) });
    let seeded;
    try {
      seeded = await createProject(root, lease, { expectedVersion: 0, occurredAt: at(1), externalKey: "SEG-P", name: "Seg" });
    } finally {
      await lease.release();
    }
    const members = Array.from({ length: 14 }, (_, index) => ({
      verb: "work-create", projectId: seeded.projects[0].id, externalKey: `SEG-${index}`,
      kind: "Incident", parentId: null, status: "planned",
    }));
    const held = await acquireWorkspaceLease(root, { now: at(2) });
    let full;
    try {
      full = await applyWorkBatch(root, held, { schemaVersion: "tcrn.work-batch.v1", members }, {
        expectedVersion: seeded.version, occurredAt: at(2),
      });
    } finally {
      await held.release();
    }
    const events = join(root, ".tcrn-workflow", "events");
    const segments = (await readdir(events)).sort();
    assert.ok(segments.length > 1, "the batch must actually span segments or this asserts nothing");
    assert.deepEqual(segments, [...segments].sort(), "segments are named in ascending order");
    assert.equal((await materializeWorkspace(root)).version, full.version, "the whole batch replays");

    // Every truncation point, because a crash can land at any of them. Removing the
    // trailing segments reproduces exactly the on-disk state a crash between writes leaves.
    for (let keep = segments.length - 1; keep >= 1; keep -= 1) {
      await rm(join(events, segments[keep]), { force: true });
      const replayed = await materializeWorkspace(root);
      assert.equal(replayed.version, keep * 4, `segments 1..${keep} must replay as a legal chain of ${keep * 4}`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// The attribution the batch reports comes from appendEvents, because it is the only thing
// that knows the index. Red leg: count completed closures from outside instead -- the
// counter advances after the closure returns, while actor injection and event
// construction run afterwards and throw too, so a failure there is blamed on the member
// after the one that caused it, a pre-loop failure blames member zero, and a last-member
// failure escapes unattributed.
test("STORY-300: the last member can fail, and it is attributed like any other", async () => {
  const fixture = await workspace("BATCH-LAST");
  try {
    const result = await refusal(fixture, [
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-INC-6", kind: "Incident", parentId: null, status: "planned" },
      { verb: "work-transition", externalKey: "B-INC-6", status: "ready" },
      { verb: "work-transition", externalKey: "B-INC-6", status: "planned" },
    ]);
    assert.equal(result.reasonCode, "WORK_BATCH_REFUSED");
    assert.equal(result.payload.failed.index, 2, "the last member is attributed, not swallowed");
    assert.equal(result.payload.failed.reasonCode, "INVALID_TRANSITION");
    assert.deepEqual(result.payload.notEvaluated, [], "nothing followed it");
    assert.equal(result.payload.failed.phase, "delta", "and the stage that refused it is named");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Red leg: attribute a pre-loop failure to a member and a CAS mismatch -- which no member
// caused -- is reported as member zero's fault.
test("STORY-300: a failure before any member ran blames no member", async () => {
  const fixture = await workspace("BATCH-PRELOOP");
  try {
    const lease = await acquireWorkspaceLease(fixture.root, { now: at(2) });
    try {
      await assert.rejects(
        () => applyWorkBatch(fixture.root, lease, {
          schemaVersion: "tcrn.work-batch.v1",
          members: [{ verb: "work-create", projectId: fixture.projectId, externalKey: "B-INC-5", kind: "Incident", parentId: null, status: "planned" }],
        }, { expectedVersion: fixture.version + 99, occurredAt: at(2) }),
        (error) => error?.reasonCode === "WORKSPACE_CAS_MISMATCH" && error.memberIndex === undefined,
        "a CAS mismatch is the batch's failure, not a member's",
      );
    } finally {
      await lease.release();
    }
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});
