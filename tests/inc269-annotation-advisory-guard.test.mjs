// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-269 — work-annotate wrote an event the workspace could not read back.
//
// work.annotated is an advisory-only operation, and the reducer says so: an annotation
// whose advisory keys are all byte-identical to the prior revision is WORKSPACE_EVENT_CORRUPT
// on replay. The verb had no counterpart to that check. --title and --labels are top-level
// work fields rather than extensions, so an annotation that moved only those satisfied the
// verb's own no-op comparison, appended, and returned a complete receipt -- after which
// status, work-list, export, validate and recover all failed on the same workspace, with
// nothing left to fix but the NDJSON by hand. That happened to the live cross-project
// chain at seq 4877 on 2026-09-03.
//
// The two tests below are the two halves of the ruling: the advisory-less annotation is
// refused as input and nothing is appended, and --title/--labels keep working when the
// same annotation also moves an advisory field.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  annotateWork,
  createProject,
  createWork,
  initializeWorkspace,
  materializeWorkspace,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";

const instant = (index) => `2026-09-04T00:00:${String(index).padStart(2, "0")}.000Z`;

async function incidentFixture(context, externalKey) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc269-")));
  const roots = ["framework", "workspace", "transient", "evidence-locator", "release-trust"]
    .map((kind) => ({ kind, path: join(base, kind) }));
  for (const root of roots) await mkdir(root.path);
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey, createdAt: instant(0), segmentEventLimit: 64 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  context.after(async () => {
    await lease.release().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  });
  let state = await createProject(workspace, lease, {
    expectedVersion: 0, occurredAt: instant(2), externalKey: `${externalKey}-PROJECT`, name: "INC269",
  });
  state = await createWork(workspace, lease, {
    expectedVersion: 1, occurredAt: instant(3), projectId: state.projects[0].id,
    externalKey: `${externalKey}-INCIDENT`, kind: "Incident", parentId: null, status: "active",
  });
  return { workspace, lease, id: state.work[0].id, version: state.version };
}

test("INC-269 an annotation that moves no annotatable field is refused before it is written", async (context) => {
  const { workspace, lease, id, version } = await incidentFixture(context, "INC269-GUARD");
  assert.equal(version, 2);

  // TCRN-CROSS-STORY-363 moved this boundary out by three fields: title, labels and
  // summary now count as moves, so a title-only annotation lands instead of being
  // refused. What the guard protects is unchanged and is what the incident was about --
  // the verb must never append an annotation the reducer would then call corrupt -- so
  // the probe is now an annotation that restates the record's own values and moves
  // nothing at all. The record is fresh: its title is null and its labels are empty.
  await assert.rejects(
    () => annotateWork(workspace, lease, {
      expectedVersion: version, occurredAt: instant(4), id, title: null, labels: [],
    }),
    (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID"
      && error.message === `work ${id} annotation changed no annotatable field`,
  );

  // The refusal is the whole point: no event exists, so every read still works. Under the
  // defect each of these three calls returned WORKSPACE_EVENT_CORRUPT instead, and so did
  // recover -- the log was intact and the appended record was the damage.
  const validated = await validateWorkspace(workspace);
  assert.equal(validated.version, version);
  const materialized = await materializeWorkspace(workspace);
  assert.equal(materialized.version, version);
  const record = materialized.work.find((entry) => entry.id === id);
  assert.equal(record.revision, 1);
  assert.equal(record.title, null);
  assert.deepEqual(record.labels, []);

  // The criterion is "a value moved", not "a flag was passed": re-sending the same scope
  // and the same title moves nothing and is refused identically. This is the reducer's
  // predicate, so the verb and replay cannot disagree about it.
  const annotated = await annotateWork(workspace, lease, {
    expectedVersion: version, occurredAt: instant(5), id, scope: "INC-269 advisory guard probe", title: "T",
  });
  await assert.rejects(
    () => annotateWork(workspace, lease, {
      expectedVersion: annotated.version, occurredAt: instant(6), id,
      scope: "INC-269 advisory guard probe", title: "T",
    }),
    (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID"
      && error.message === `work ${id} annotation changed no annotatable field`,
  );
  assert.equal((await validateWorkspace(workspace)).version, annotated.version);
});

test("INC-269 title and labels land, with or without an advisory field beside them", async (context) => {
  const { workspace, lease, id, version } = await incidentFixture(context, "INC269-POSITIVE");

  const state = await annotateWork(workspace, lease, {
    expectedVersion: version, occurredAt: instant(4), id,
    scope: "INC-269 advisory guard probe", title: "T", labels: ["a", "b"],
  });
  const record = state.work.find((entry) => entry.id === id);
  assert.equal(record.title, "T");
  assert.deepEqual(record.labels, ["a", "b"]);
  assert.equal(record.revision, 2);

  const validated = await validateWorkspace(workspace);
  assert.equal(validated.version, version + 1);
  assert.equal(validated.work.find((entry) => entry.id === id).title, "T");

  // TCRN-CROSS-STORY-363: a title-only annotation now lands too, and the workspace still
  // reads back. Under INC-269's disposition this was refused, which left title, labels and
  // summary writable only in the company of a scope the writer had no business touching.
  const retitled = await annotateWork(workspace, lease, {
    expectedVersion: validated.version, occurredAt: instant(5), id, title: "T2",
  });
  assert.equal(retitled.work.find((entry) => entry.id === id).title, "T2");
  const replayed = await validateWorkspace(workspace);
  assert.equal(replayed.version, version + 2);
  assert.equal(replayed.work.find((entry) => entry.id === id).title, "T2");
});
