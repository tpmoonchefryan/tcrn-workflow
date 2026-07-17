// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import {
  acquireWorkspaceLease,
  createProject,
  createWork,
  deleteWork,
  initializeWorkspace,
} from "../dist/build/packages/core/src/index.js";

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-cli-read-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "FIXTURE-CLI-READ", createdAt: instant(1), segmentEventLimit: 64 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(2) });
  const ids = {};
  try {
    let v = 0;
    const at = () => instant(v + 3);
    let s = await createProject(workspace, lease, { expectedVersion: v, occurredAt: at(), externalKey: "PROJECT-A", name: "A" }); v += 1;
    ids.projectA = s.projects.find((r) => r.externalKey === "PROJECT-A").id;
    s = await createProject(workspace, lease, { expectedVersion: v, occurredAt: at(), externalKey: "PROJECT-B", name: "B" }); v += 1;
    ids.projectB = s.projects.find((r) => r.externalKey === "PROJECT-B").id;
    s = await createWork(workspace, lease, { expectedVersion: v, occurredAt: at(), projectId: ids.projectA, externalKey: "INIT-A", kind: "Initiative", parentId: null }); v += 1;
    ids.initA = s.work.find((r) => r.externalKey === "INIT-A").id;
    s = await createWork(workspace, lease, { expectedVersion: v, occurredAt: at(), projectId: ids.projectA, externalKey: "EPIC-A", kind: "Epic", parentId: ids.initA }); v += 1;
    ids.epicA = s.work.find((r) => r.externalKey === "EPIC-A").id;
    s = await createWork(workspace, lease, { expectedVersion: v, occurredAt: at(), projectId: ids.projectB, externalKey: "INIT-B", kind: "Initiative", parentId: null }); v += 1;
    ids.initB = s.work.find((r) => r.externalKey === "INIT-B").id;
    s = await createWork(workspace, lease, { expectedVersion: v, occurredAt: at(), projectId: ids.projectA, externalKey: "STORY-A", kind: "Story", parentId: ids.epicA, status: "ready" }); v += 1;
    ids.storyA = s.work.find((r) => r.externalKey === "STORY-A").id;
    s = await deleteWork(workspace, lease, { expectedVersion: v, occurredAt: at(), id: ids.storyA }); v += 1;
  } finally {
    await lease.release();
  }
  return { base, workspace, ids };
}

async function run(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function reasonOf(args) {
  return runCli(args, { write() {} }).then(() => null, (error) => error?.reasonCode);
}

test("project-list is deterministic, tombstone-free, and budgeted", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  const all = await run(["project-list", ...ws]);
  assert.equal(all.reasonCode, "WORKSPACE_LIST_READY");
  assert.equal(all.kind, "project");
  assert.equal(all.total, 2);
  assert.deepEqual(all.records.map((r) => r.id), [fx.ids.projectA, fx.ids.projectB].sort());
  const page = await run(["project-list", ...ws, "--limit", "1", "--offset", "1"]);
  assert.equal(page.total, 2);
  assert.equal(page.records.length, 1);
  assert.equal(page.truncated, false);
  const first = await run(["project-list", ...ws, "--limit", "1"]);
  assert.equal(first.truncated, true);
});

test("work-list filters conjunctively, excludes tombstones, and is byte-stable", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  const all = await run(["work-list", ...ws]);
  // STORY-A was deleted; INIT-A, EPIC-A, INIT-B remain
  assert.equal(all.total, 3);
  assert.equal(all.records.some((r) => r.id === fx.ids.storyA), false);
  const roots = await run(["work-list", ...ws, "--parent-id", "-"]);
  assert.deepEqual(roots.records.map((r) => r.id).sort(), [fx.ids.initA, fx.ids.initB].sort());
  const byProject = await run(["work-list", ...ws, "--project-id", fx.ids.projectB]);
  assert.deepEqual(byProject.records.map((r) => r.id), [fx.ids.initB]);
  const byKind = await run(["work-list", ...ws, "--kind", "Epic"]);
  assert.deepEqual(byKind.records.map((r) => r.id), [fx.ids.epicA]);
  const conjunctive = await run(["work-list", ...ws, "--project-id", fx.ids.projectA, "--kind", "Initiative"]);
  assert.deepEqual(conjunctive.records.map((r) => r.id), [fx.ids.initA]);
  // byte-identical repeat
  let a = ""; await runCli(["work-list", ...ws], { write: (v) => { a += v; } });
  let b = ""; await runCli(["work-list", ...ws], { write: (v) => { b += v; } });
  assert.equal(a, b);
});

test("work-show returns one record and fails closed on unknown ids and malformed filters", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  const shown = await run(["work-show", ...ws, "--id", fx.ids.epicA]);
  assert.equal(shown.reasonCode, "WORKSPACE_RECORD_READY");
  assert.equal(shown.record.id, fx.ids.epicA);
  assert.equal(shown.record.kind, "Epic");
  assert.equal(await reasonOf(["work-show", ...ws, "--id", "work:deadbeefdeadbeefdeadbeef"]), "WORKSPACE_INPUT_INVALID");
  assert.equal(await reasonOf(["work-show", ...ws, "--id", fx.ids.storyA]), "WORKSPACE_INPUT_INVALID");
  assert.equal(await reasonOf(["work-list", ...ws, "--kind", "Bogus"]), "CLI_ARGUMENT_MALFORMED");
  assert.equal(await reasonOf(["work-list", ...ws, "--status", "bogus"]), "CLI_ARGUMENT_MALFORMED");
  assert.equal(await reasonOf(["work-list", ...ws, "--limit", "0"]), "CLI_ARGUMENT_MALFORMED");
  assert.equal(await reasonOf(["project-list", ...ws, "--offset", "-1"]), "CLI_ARGUMENT_MALFORMED");
});

test("read verbs and validate fail closed on stale views, but status reads authority", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  await writeFile(join(fx.workspace, ".tcrn-workflow", "views", "index.json"), "{}\n");
  assert.equal(await reasonOf(["work-list", ...ws]), "WORKSPACE_VIEW_STALE");
  assert.equal(await reasonOf(["project-list", ...ws]), "WORKSPACE_VIEW_STALE");
  assert.equal(await reasonOf(["work-show", ...ws, "--id", fx.ids.epicA]), "WORKSPACE_VIEW_STALE");
  assert.equal(await reasonOf(["validate", ...ws]), "WORKSPACE_VIEW_STALE");
  // WSA-3 / SDC-10: status is authority-only and must survive stale views
  const status = await run(["status", ...ws]);
  assert.equal(status.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(status.version, 7);
});

test("WSB-6: the agent-integration reference stays in drift-guarded agreement with the catalog", async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const docText = await readFile(join(repoRoot, "docs/architecture/agent-integration-v1.md"), "utf8");

  // The three retry reason codes with undocumented semantics that motivated the
  // doc must each appear (relaxed to at-least-once per the verifier correction,
  // since the error-envelope and retry-table sections both name CAS_MISMATCH).
  for (const code of ["WORKSPACE_VIEW_STALE", "WORKSPACE_LOCKED", "WORKSPACE_CAS_MISMATCH"]) {
    assert.ok(docText.includes(code), `retry table must name ${code}`);
  }

  // Bidirectional drift guard: the doc's enumerated programmatic-only block must
  // equal exactly the live COMMAND_CATALOG programmatic-only surface.
  const liveProgrammaticOnly = COMMAND_CATALOG.filter((entry) => entry.availability === "programmatic-only")
    .map((entry) => entry.name)
    .sort();
  const block = docText.match(/```\nprogrammatic-only\n([\s\S]*?)```/);
  assert.ok(block, "doc must carry a fenced programmatic-only enumeration block");
  const documented = block[1].trim().split("\n").map((line) => line.trim()).filter(Boolean).sort();
  assert.deepEqual(documented, liveProgrammaticOnly);

  // Coverage direction restated verb-by-verb so a newly programmatic-only verb
  // that slips the block still fails loudly.
  for (const name of liveProgrammaticOnly) {
    assert.ok(docText.includes(name), `doc must mention programmatic-only verb ${name}`);
  }
});
