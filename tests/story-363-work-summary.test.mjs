// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-363 — the work record's summary field, and a required title.
//
// Two changes with one purpose: 802 records on this platform's chains carried an
// external key and nothing else a reader would type, so `work-list --search` could
// only match a key or a wall of scope prose. `--title` becomes required where a
// record is born, `summary` becomes a bounded derived line, and search reaches both.
//
// The third test below is the one that matters most and is the least obvious: adding
// a field to WorkRecord is a protocol change, and a protocol change that filled the
// field in during replay would restate every derived view on every chain as stale.
// `summary` is therefore ABSENT on a record that predates it, not null, and this file
// proves both halves -- the legacy shape still validates, and its bytes do not move.

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
  deriveWorkSummary,
  initializeWorkspace,
  transitionWork,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { WORK_SUMMARY_MAX_BYTES, canonicalSha256, validateWorkGraph } from "../dist/build/packages/protocol/src/index.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";

const instant = (index) => `2026-09-07T00:00:${String(index).padStart(2, "0")}.000Z`;

const STORY_SCOPE = [
  "【Goal】为谁=读工单列表的 Owner；目的锚=STORY-363；符合性判据=记录带 summary；判定人=派工线程。",
  "【Requirements】现象与证据=只有外部键可检索；修复项=新增 summary 字段。",
  "【Acceptance Criteria】GIVEN a Story WHEN it is created THEN it carries a summary。",
  "【Business Background】evidence=802 records carried no readable name。",
  "【Preconditions】无——原因：the fixture initializes its own roots。",
  "【Assumptions】无——原因：no runtime setting is introduced。",
  "【Use Cases & Examples】无——原因：the assertions are the example。",
  "【Feature Toggle & Setting】无——原因：the byte bound is a protocol constant。",
  "【Permissions】the running thread is the actor。",
  "【Implementation Notes】决策点及裁定状态=summary is derived from the Goal block。",
].join("\n");

// The lease is taken to seed the project and released again: runCli acquires its own,
// and a fixture that kept one would answer WORKSPACE_LOCKED to every CLI probe below.
// A test that needs the core verbs takes a fresh lease itself.
async function fixture(context, externalKey) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s363-")));
  const roots = ["framework", "workspace", "transient", "evidence-locator", "release-trust"]
    .map((kind) => ({ kind, path: join(base, kind) }));
  for (const root of roots) await mkdir(root.path);
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey, createdAt: instant(0), segmentEventLimit: 64 });
  context.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const seed = await acquireWorkspaceLease(workspace, { now: instant(1) });
  const state = await createProject(workspace, seed, {
    expectedVersion: 0, occurredAt: instant(2), externalKey: `${externalKey}-PROJECT`, name: "S363",
  });
  await seed.release();
  return { workspace, projectId: state.projects[0].id, version: state.version };
}

async function lease(context, workspace) {
  const held = await acquireWorkspaceLease(workspace, { now: instant(1) });
  context.after(() => held.release().catch(() => undefined));
  return held;
}

async function invoke(tokens) {
  let output = "";
  const outcome = await runCli(tokens, { write: (value) => { output += value; } }).then(
    () => ({ ok: true, value: JSON.parse(output) }),
    (error) => ({ ok: false, reasonCode: error?.reasonCode }),
  );
  return outcome;
}

test("GWT1: work-create without --title is refused at the CLI boundary and appends nothing", async (context) => {
  const { workspace, projectId, version } = await fixture(context, "S363-GWT1");
  const refused = await invoke([
    "work-create", "--workspace", workspace, "--expected-version", String(version), "--at", instant(3),
    "--project-id", projectId, "--external-key", "S363-NO-TITLE", "--kind", "Initiative",
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.reasonCode, "CLI_ARGUMENT_MISSING");
  const state = await validateWorkspace(workspace);
  assert.equal(state.version, version, "a refused create leaves the chain at the version it read");
  assert.equal(state.work.length, 0);

  const accepted = await invoke([
    "work-create", "--workspace", workspace, "--expected-version", String(version), "--at", instant(4),
    "--project-id", projectId, "--external-key", "S363-WITH-TITLE", "--kind", "Initiative", "--title", "A named initiative",
  ]);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.value.record.title, "A named initiative");
});

test("GWT2: a Story created with a Goal block carries a derived summary inside the byte bound", async (context) => {
  const { workspace, projectId, version } = await fixture(context, "S363-GWT2");
  const held = await lease(context, workspace);
  let state = await createWork(workspace, held, {
    expectedVersion: version, occurredAt: instant(3), projectId, externalKey: "S363-INITIATIVE",
    kind: "Initiative", parentId: null, title: "Initiative",
  });
  assert.equal(state.work[0].summary, null, "a record with no scope to derive from carries an explicit null");
  const initiativeId = state.work[0].id;
  state = await createWork(workspace, held, {
    expectedVersion: state.version, occurredAt: instant(4), projectId, externalKey: "S363-EPIC",
    kind: "Epic", parentId: initiativeId, title: "Epic",
  });
  const epicId = state.work.find((record) => record.externalKey === "S363-EPIC").id;

  state = await createWork(workspace, held, {
    expectedVersion: state.version, occurredAt: instant(5), projectId, externalKey: "S363-STORY",
    kind: "Story", parentId: epicId, title: "Summary story", scope: STORY_SCOPE,
  });
  const story = state.work.find((record) => record.externalKey === "S363-STORY");
  assert.equal(typeof story.summary, "string");
  assert.ok(Buffer.byteLength(story.summary, "utf8") <= WORK_SUMMARY_MAX_BYTES,
    `summary is ${Buffer.byteLength(story.summary, "utf8")} bytes`);
  assert.equal(story.summary, "为谁=读工单列表的 Owner", "the summary is the first sentence of the Goal block");
  assert.equal(story.summary, deriveWorkSummary(STORY_SCOPE, WORK_SUMMARY_MAX_BYTES),
    "the write path derives with the same function the backfill tool calls");

  // The derivation, not the explicit flag, is the path the bound truncates rather than
  // refuses. A Goal sentence long enough to run past 160 bytes is cut on a code-point
  // boundary, which is the half of the byte bound nothing else here reaches.
  const truncated = deriveWorkSummary(STORY_SCOPE.replace("读工单列表的 Owner", "读工单列表的 Owner".repeat(12)), WORK_SUMMARY_MAX_BYTES);
  assert.ok(Buffer.byteLength(truncated, "utf8") <= WORK_SUMMARY_MAX_BYTES,
    `a derived summary is cut to the bound: ${Buffer.byteLength(truncated, "utf8")} bytes`);
  assert.equal(truncated.includes("�"), false, "the cut lands on a code-point boundary, not mid-sequence");

  // An explicit --summary wins over the derivation, and the bound is enforced on it.
  // The lease goes back before the CLI probes: runCli takes its own.
  await held.release();
  const explicit = await invoke([
    "work-create", "--workspace", workspace, "--expected-version", String(state.version), "--at", instant(6),
    "--project-id", projectId, "--external-key", "S363-EXPLICIT", "--kind", "Incident", "--title", "Explicit",
    "--summary", "现象：门未比对元素是否存在；根因：只比对属性值。",
  ]);
  assert.equal(explicit.ok, true, JSON.stringify(explicit));
  assert.equal(explicit.value.record.summary, "现象：门未比对元素是否存在；根因：只比对属性值。");

  const oversized = await invoke([
    "work-create", "--workspace", workspace, "--expected-version", String(explicit.value.version), "--at", instant(7),
    "--project-id", projectId, "--external-key", "S363-OVERSIZED", "--kind", "Incident", "--title", "Oversized",
    "--summary", "格".repeat(54),
  ]);
  assert.equal(oversized.ok, false);
  assert.equal(oversized.reasonCode, "WORKSPACE_INPUT_INVALID", "162 UTF-8 bytes is over the 160-byte bound");
});

test("STORY-363: a record written before the field existed replays unchanged, and its bytes do not move", async () => {
  const legacy = {
    schemaVersion: "tcrn.work.v1",
    id: "work:1111111111111111111111a1",
    externalKey: "S363-LEGACY",
    projectId: "project:1111111111111111111111a2",
    kind: "Initiative",
    parentId: null,
    status: "planned",
    revision: 1,
    updatedAt: instant(2),
    tombstone: false,
    extensions: {},
    scopeDigest: null,
    title: null,
    createdAt: instant(2),
    labels: [],
  };
  const before = canonicalSha256(legacy);
  assert.deepEqual(validateWorkGraph([legacy], []), [legacy], "the 15-field shape still validates");
  assert.equal(canonicalSha256(validateWorkGraph([legacy], [])[0]), before,
    "replay adds no field, so the record hashes to what it hashed before -- which is why no chain's views go stale");

  const summarised = { ...legacy, summary: "现象加根因" };
  assert.deepEqual(validateWorkGraph([summarised], []), [summarised], "the 16-field shape validates too");
  assert.throws(() => validateWorkGraph([{ ...legacy, summary: "格".repeat(54) }], []),
    (error) => error.reasonCode === "RECORD_MALFORMED", "an over-budget summary is malformed on replay");
  assert.throws(() => validateWorkGraph([{ ...legacy, summary: "" }], []),
    (error) => error.reasonCode === "RECORD_MALFORMED", "an empty summary is malformed on replay");
});

test("STORY-363: transition and annotate both write the summary, and annotate is how a pre-363 record gets one", async (context) => {
  const { workspace, projectId, version } = await fixture(context, "S363-WRITE");
  const held = await lease(context, workspace);
  let state = await createWork(workspace, held, {
    expectedVersion: version, occurredAt: instant(3), projectId, externalKey: "S363-CLOSING",
    kind: "Incident", parentId: null, status: "active", title: "Closing line",
  });
  const id = state.work[0].id;
  assert.equal(state.work[0].summary, null);

  state = await transitionWork(workspace, held, {
    expectedVersion: state.version, occurredAt: instant(4), id, status: "done",
    summary: "现象：收口句无处可写；根因：记录没有这个字段。",
  });
  assert.equal(state.work[0].summary, "现象：收口句无处可写；根因：记录没有这个字段。");

  state = await annotateWork(workspace, held, {
    expectedVersion: state.version, occurredAt: instant(5), id, summary: "重写过的收口句。",
  });
  assert.equal(state.work[0].summary, "重写过的收口句。", "annotate refreshes it without touching status");
  assert.equal(state.work[0].status, "done");

  await assert.rejects(
    annotateWork(workspace, held, { expectedVersion: state.version, occurredAt: instant(6), id, summary: "重写过的收口句。" }),
    (error) => error.reasonCode === "WORKSPACE_INPUT_INVALID",
    "an annotation that moves nothing is still refused",
  );
  await validateWorkspace(workspace);
});

test("GWT3: work-list --search matches a keyword that appears only in the title, the labels, or the summary", async (context) => {
  const { workspace, projectId, version } = await fixture(context, "S363-SEARCH");
  const held = await lease(context, workspace);
  let state = await createWork(workspace, held, {
    expectedVersion: version, occurredAt: instant(3), projectId, externalKey: "S363-A",
    kind: "Initiative", parentId: null, title: "Retrieval overhaul", labels: ["indexed"],
  });
  state = await createWork(workspace, held, {
    expectedVersion: state.version, occurredAt: instant(4), projectId, externalKey: "S363-B",
    kind: "Incident", parentId: null, title: "Unrelated", summary: "the closing sentence mentions ratchet",
  });

  const hits = async (term) => {
    const outcome = await invoke(["work-list", "--workspace", workspace, "--search", term]);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    return outcome.value.records.map((record) => record.externalKey);
  };
  assert.deepEqual(await hits("overhaul"), ["S363-A"], "a title-only keyword now matches");
  assert.deepEqual(await hits("indexed"), ["S363-A"], "a labels-only keyword now matches");
  assert.deepEqual(await hits("ratchet"), ["S363-B"], "a summary-only keyword now matches");
  assert.deepEqual(await hits("S363-B"), ["S363-B"], "the external key still matches");
  assert.deepEqual(await hits("nothing-here"), [], "search still fails closed");

  const listed = await invoke(["work-list", "--workspace", workspace]);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.value.records.map((record) => record.summary),
    [null, "the closing sentence mentions ratchet"], "work-list projects summary for every row");
});

// Driven in-process rather than spawned: the suite runs under a detached test controller
// that keeps its streams private, so a grandchild's stdout does not come back.
const { backfillWorkSummaries: backfill } = await import("../scripts/backfill-work-summaries.mjs");

test("STORY-363: the backfill tool plans before it writes, and writes through work-annotate", async (context) => {
  const { workspace, projectId, version } = await fixture(context, "S363-BACKFILL");
  const held = await lease(context, workspace);
  let state = await createWork(workspace, held, {
    expectedVersion: version, occurredAt: instant(3), projectId, externalKey: "S363-BF-INITIATIVE",
    kind: "Initiative", parentId: null, title: "Initiative",
  });
  state = await createWork(workspace, held, {
    expectedVersion: state.version, occurredAt: instant(4), projectId, externalKey: "S363-BF-EPIC",
    kind: "Epic", parentId: state.work[0].id, title: "Epic",
  });
  const epicId = state.work.find((record) => record.externalKey === "S363-BF-EPIC").id;
  state = await createWork(workspace, held, {
    expectedVersion: state.version, occurredAt: instant(5), projectId, externalKey: "S363-BF-STORY",
    kind: "Story", parentId: epicId, title: "Scoped story", scope: STORY_SCOPE, summary: null,
  });
  const storyId = state.work.find((record) => record.externalKey === "S363-BF-STORY").id;
  assert.equal(state.work.find((record) => record.id === storyId).summary, null,
    "an explicit null stands in for the pre-363 record this tool exists for");
  await held.release();

  const planned = await backfill(["--workspace", workspace]);
  assert.equal(planned.reasonCode, "BACKFILL_PLANNED");
  assert.equal(planned.mode, "plan");
  assert.equal(planned.candidates, 1, "only the record with scope and no summary is a candidate");
  assert.equal(planned.records[0].externalKey, "S363-BF-STORY");
  assert.equal(planned.records[0].derived, deriveWorkSummary(STORY_SCOPE, WORK_SUMMARY_MAX_BYTES));
  assert.ok(planned.records[0].bytes <= WORK_SUMMARY_MAX_BYTES);
  assert.equal((await validateWorkspace(workspace)).version, state.version, "planning writes nothing");

  const applied = await backfill(["--workspace", workspace, "--at", instant(6), "--actor", "agent:test", "--apply"]);
  assert.equal(applied.reasonCode, "BACKFILL_APPLIED");
  assert.equal(applied.written, 1);
  const replayed = await validateWorkspace(workspace);
  assert.equal(replayed.version, state.version + 1, "one event per record, and the chain still replays");
  assert.equal(replayed.work.find((record) => record.id === storyId).summary,
    deriveWorkSummary(STORY_SCOPE, WORK_SUMMARY_MAX_BYTES));

  const rerun = await backfill(["--workspace", workspace]);
  assert.equal(rerun.candidates, 0, "a second run finds nothing left to do");
});

test("STORY-363: the backfill tool refuses to write without a workspace, an instant and an actor", async (context) => {
  const { workspace } = await fixture(context, "S363-BACKFILL-REFUSAL");
  for (const argv of [[], ["--workspace", workspace, "--apply"], ["--workspace", workspace, "--at", instant(6), "--apply"]]) {
    const outcome = await backfill(argv);
    assert.equal(outcome.ok, false, JSON.stringify(argv));
    assert.equal(outcome.reasonCode, "BACKFILL_INPUT_INVALID", JSON.stringify(argv));
  }
  assert.equal((await backfill(["--workspace", workspace])).reasonCode, "BACKFILL_PLANNED",
    "a read with no --apply needs neither an instant nor an actor");
});
