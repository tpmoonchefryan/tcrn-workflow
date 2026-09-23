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
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PROTOCOL_LIMITS, canonicalJson, validateEventChain } from "../dist/build/packages/protocol/src/index.js";
import {
  acquireWorkspaceLease,
  appendEvents,
  assertWorkspaceRecordCount,
  buildEventPayload,
  createWorkspaceSettingRecord,
  initializeWorkspace,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  sortWorkspaceSettings,
} from "../dist/build/packages/core/src/index.js";

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

// TCRN-CROSS-STORY-451 R1: replay without a snapshot validates the whole chain, and it
// measured that chain against the per-document bound. A chain one event past
// maxRecords then read as WORKSPACE_EVENT_CORRUPT on every snapshot-less path. The
// fixture is one append of many members, because each separate append replays the
// whole chain (quadratic), and the members alternate one setting value so no view
// grows with the chain. Red leg: point validateEventChain back at maxRecords.
test("STORY-451: a chain past the per-document bound replays from genesis without a snapshot", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s451-replay-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    await mkdir(join(base, kind));
    roots.push({ kind, path: join(base, kind) });
  }
  const workspace = join(base, "workspace");
  const occurredAt = "2026-09-23T00:00:01Z";
  await initializeWorkspace({ roots, externalKey: "STORY-451-REPLAY", createdAt: "2026-09-23T00:00:00Z" });
  const lease = await acquireWorkspaceLease(workspace, { now: occurredAt });
  const settingDelta = (key, value) => (state) => {
    const prior = state.settings.find((entry) => entry.key === key);
    const record = createWorkspaceSettingRecord(key, value, (prior?.revision ?? 0) + 1, occurredAt, workspace);
    return {
      payload: buildEventPayload("settings.updated", record),
      projects: state.projects,
      work: state.work,
      settings: sortWorkspaceSettings([...state.settings.filter((entry) => entry.key !== key), record]),
    };
  };
  const events = PROTOCOL_LIMITS.maxRecords + 1;
  // The largest interval keeps this chain snapshot-less under either snapshot rule. The
  // 1 MiB segment keeps each segment index (two keys an event) under its own bounds.
  const deltas = [settingDelta("storage.snapshotEveryEvents", "20000"), settingDelta("storage.segmentBytes", "1048576")];
  while (deltas.length < events) {
    deltas.push(settingDelta("injection.budgetBytes", deltas.length % 2 === 0 ? "24576" : "24577"));
  }
  try {
    const committed = await appendEvents(workspace, lease, deltas, { expectedVersion: 0, occurredAt });
    assert.equal(committed.version, events);
  } finally {
    await lease.release();
  }
  await assert.rejects(stat(join(workspace, ".tcrn-" + "workflow", "snapshots", "manifest.json")), { code: "ENOENT" },
    "precondition: no replay snapshot exists, so replay walks the whole chain");
  const replayed = await materializeWorkspaceFromGenesis(workspace);
  assert.equal(replayed.version, events);
  assert.equal((await materializeWorkspace(workspace)).version, events);
});

// R1 at the protocol layer: the length check runs before any record is read, so a
// placeholder array isolates it. Past maxRecords but within maxChainEvents the chain
// reaches per-record validation; past maxChainEvents it is refused by length. Red
// leg: maxRecords as the bound refuses the first array by length too.
test("STORY-451: validateEventChain bounds the chain by maxChainEvents, not by maxRecords", () => {
  assert.throws(() => validateEventChain(Array.from({ length: PROTOCOL_LIMITS.maxRecords + 1 }, () => null)),
    (error) => error?.reasonCode === "RECORD_MALFORMED",
    "a chain one past the per-document bound is read record by record");
  assert.throws(() => validateEventChain(Array.from({ length: PROTOCOL_LIMITS.maxChainEvents + 1 }, () => null)),
    (error) => error?.reasonCode === "INPUT_OVERSIZED",
    "a chain past the lifetime bound is still refused by length");
  assert.throws(() => assertWorkspaceRecordCount(PROTOCOL_LIMITS.maxChainEvents + 1),
    (error) => error?.reasonCode === "WORKSPACE_RECORD_LIMIT");
});
