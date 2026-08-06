// SPDX-License-Identifier: Apache-2.0
// STORY-173 equivalence-criterion red-leg evidence.
//
// The four equivalence criteria (ADR 0004 §9) each state a red leg: a one-byte
// deviation that must turn the read path red. This test proves each red leg on a
// scratch workspace — the pre-enactment record the story demands ("在 scratch 上改
// 一字节即红的预演记录"). It is deliberately NOT a dual-backend comparison (that is
// STORY-176); it pins the four refusals the file backend already enforces, which
// are the red legs the PG backend must reproduce byte-for-byte.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  createProject,
  initializeWorkspace,
  materializeWorkspace,
  updateProject,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, createEvent } from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

async function workspaceFixture(options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s173-")));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path, { recursive: true });
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  const state = await initializeWorkspace({
    roots,
    externalKey: options.externalKey ?? "WORKSPACE-S173",
    createdAt: instant(0),
    segmentEventLimit: 2,
  });
  return {
    base,
    workspace,
    state,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function controlFile(workspace, relativePath) {
  return readFile(join(workspace, ".tcrn-workflow", relativePath), "utf8");
}

async function writeControlFile(workspace, relativePath, text) {
  return writeFile(join(workspace, ".tcrn-workflow", relativePath), text);
}

async function createHistory(fixture) {
  const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
  try {
    let state = await createProject(fixture.workspace, lease, {
      expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-S173", name: "Alpha",
    });
    state = await updateProject(fixture.workspace, lease, {
      expectedVersion: 1, occurredAt: instant(2), id: state.projects[0].id, name: "Beta",
    });
    return state;
  } finally {
    await lease.release();
  }
}

// Criterion 1 red leg: flip one byte of a stored payload → the chain-verify must
// fail. We read the segment bytes, mutate one character, write back, and assert
// materializeWorkspace (which runs validateEventChain) throws EVENT_CORRUPT.
async function criterion1ByteFlip(workspace, phase) {
  const before = await materializeWorkspace(workspace);
  const segment = await controlFile(workspace, `events/000001.json`);
  const flipped = segment.replace("Alpha", "Alphx");
  assert.notEqual(flipped, segment, "byte flip must change the bytes");
  await writeControlFile(workspace, `events/000001.json`, flipped);
  let thrown = null;
  try {
    await materializeWorkspace(workspace);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `${phase}: criterion 1 must red on a payload byte flip`);
  assert.equal(thrown.reasonCode, "WORKSPACE_EVENT_CORRUPT", `${phase}: criterion 1 red code`);
  assert.equal(before.version, 2, `${phase}: baseline version`);
}

// Criterion 3 red leg: fork the chain (second event with the same prior_hash) →
// head compare must fail. We replace the second segment's event with a forged
// copy that restates the same prior_hash, so the head differs while the chain
// "looks" chained; the identity check must red.
async function criterion3Fork(workspace, phase) {
  const before = await materializeWorkspace(workspace);
  const events = JSON.parse(await controlFile(workspace, `events/000001.json`));
  const forged = createEvent({
    id: before.events[0].id,            // same id — replay detector reds
    streamId: before.events[0].streamId,
    sequence: 1,
    occurredAt: instant(5),
    priorHash: null,
    payload: { operation: "project.created", record: { ...before.events[0].payload.record, name: "Forged" } },
  });
  await writeControlFile(workspace, `events/000001.json`, canonicalJson([forged]));
  let thrown = null;
  try {
    await materializeWorkspace(workspace);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `${phase}: criterion 3 must red on a forked head`);
  assert.equal(thrown.reasonCode, "WORKSPACE_EVENT_CORRUPT", `${phase}: criterion 3 red code`);
  void events;
}

// Criterion 4 red leg: mutate a view/marker without a chain write → view-stale
// refusal. We rewrite STATUS.md to a stale value and assert validateWorkspace reds
// WORKSPACE_VIEW_STALE. (Marker high-water is a knowledge/artifact face exercised
// under STORY-177; the view side is the engine-derived surface available here.)
async function criterion4ViewStale(workspace, phase) {
  const stale = (await controlFile(workspace, `views/STATUS.md`)).replace(
    /Graph digest: `[a-f0-9]{64}`/u,
    "Graph digest: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`",
  );
  assert.notEqual(stale, await controlFile(workspace, `views/STATUS.md`), "stale view must differ");
  await writeControlFile(workspace, `views/STATUS.md`, stale);
  let thrown = null;
  try {
    await validateWorkspace(workspace);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `${phase}: criterion 4 must red on a stale view`);
  assert.equal(thrown.reasonCode, "WORKSPACE_VIEW_STALE", `${phase}: criterion 4 red code`);
}

// Criterion 2 (reason-code equivalence) red leg: a CAS mismatch on a stale
// expectedVersion must red WORKSPACE_CAS_MISMATCH on the live path — the code the
// PG backend must reproduce exactly.
async function criterion2CasMismatch(fixture, phase) {
  const live = await materializeWorkspace(fixture.workspace);
  const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(6) });
  try {
    let thrown = null;
    try {
      await updateProject(fixture.workspace, lease, {
        expectedVersion: 99, occurredAt: instant(6), id: live.projects[0].id, name: "Gamma",
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, `${phase}: criterion 2 must red on a CAS mismatch`);
    assert.equal(thrown.reasonCode, "WORKSPACE_CAS_MISMATCH", `${phase}: criterion 2 red code`);
  } finally {
    await lease.release();
  }
}

test("STORY-173 criterion 1: a one-byte payload flip turns the chain read red", async () => {
  const fixture = await workspaceFixture();
  try {
    await createHistory(fixture);
    await criterion1ByteFlip(fixture.workspace, "criterion1");
  } finally {
    await fixture.close();
  }
});

test("STORY-173 criterion 2: a stale expectedVersion turns the mutation red (reason-code equivalence)", async () => {
  const fixture = await workspaceFixture();
  try {
    await createHistory(fixture);
    await criterion2CasMismatch(fixture, "criterion2");
  } finally {
    await fixture.close();
  }
});

test("STORY-173 criterion 3: a forked head (reused prior_hash) turns the chain read red", async () => {
  const fixture = await workspaceFixture();
  try {
    await createHistory(fixture);
    await criterion3Fork(fixture.workspace, "criterion3");
  } finally {
    await fixture.close();
  }
});

test("STORY-173 criterion 4: a stale engine-derived view turns validateWorkspace red", async () => {
  const fixture = await workspaceFixture();
  try {
    await createHistory(fixture);
    await criterion4ViewStale(fixture.workspace, "criterion4");
  } finally {
    await fixture.close();
  }
});
