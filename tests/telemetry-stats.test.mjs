// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-376 — open telemetry kinds, bounded storage, and read-only stats.

import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendTelemetryRecord,
  createTelemetryRecord,
  initializeWorkspace,
  materializeWorkspace,
  readTelemetryRecords,
  readTelemetryStats,
} from "../dist/build/packages/core/src/index.js";
import { TELEMETRY_LINE_BYTES, pruneTelemetryRecords } from "../dist/build/packages/core/src/telemetry.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { runSessionInjection } from "../scripts/knowledge-inject.mjs";

const at = (day, second = 0) => "2026-09-" + String(day).padStart(2, "0") + "T00:00:" + String(second).padStart(2, "0") + ".000Z";

function payload(source, extra = {}) {
  return { source, availability: "available", ...extra };
}

function record(kind, date, session, extra = {}) {
  return createTelemetryRecord({ at: date, kind, session, payload: payload("test:" + kind, extra) });
}

async function telemetryRoot(t, prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function workspaceFixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-telemetry-stats-workspace-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = ["framework", "workspace", "transient", "evidence-locator", "release-trust"]
    .map((kind) => ({ kind, path: join(base, kind) }));
  for (const root of roots) await mkdir(root.path, { recursive: true });
  const state = await initializeWorkspace({ roots, externalKey: "TELEMETRY-376", createdAt: at(1) });
  return { workspace: join(base, "workspace"), transient: join(base, "transient"), state };
}

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

test("STORY-376 GWT1/GWT2: open kinds are counted by since, bad lines are reported, and unknown usage stays null", async (t) => {
  const root = await telemetryRoot(t, "tcrn-telemetry-stats-");
  await appendTelemetryRecord(root, record("retrieval-hit", at(9, 1), "s1", { candidateCount: 2 }));
  await appendTelemetryRecord(root, record("retrieval-hit", at(10, 1), "s1", { candidateCount: 1 }));
  await appendTelemetryRecord(root, record("new-signal-from-future", at(10, 2), "s2", {
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
  }));
  await appendFile(join(root, "telemetry", "2026-09-10.ndjson"), "not-json\n");
  const listed = await readTelemetryRecords(root, { kind: "new-signal-from-future", since: at(10) });
  assert.equal(listed.total, 1);
  assert.equal(listed.records[0].kind, "new-signal-from-future");
  assert.equal(listed.problems.length, 1);
  assert.equal(listed.problems[0].line, 3);
  const stats = await readTelemetryStats(root, { since: at(10) });
  assert.deepEqual(stats.countsByKind, { "new-signal-from-future": 1, "retrieval-hit": 1 });
  assert.equal(stats.records, 2);
  assert.deepEqual(stats.usage, { observedRecords: 1, inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  assert.equal(stats.problems.length, 1);
  const noUsage = await readTelemetryStats(root, { kind: "retrieval-hit" });
  assert.deepEqual(noUsage.usage, { observedRecords: 0, inputTokens: null, outputTokens: null, totalTokens: null });
});

test("STORY-376: telemetry-stats and telemetry-list are read-only CLI surfaces for an open kind", async (t) => {
  const fixture = await workspaceFixture(t);
  await appendTelemetryRecord(fixture.transient, record("gate-result", at(10, 3), "s3", { status: "satisfied" }));
  const stats = await cli(["telemetry-stats", "--workspace", fixture.workspace, "--since", at(10)]);
  assert.equal(stats.reasonCode, "TELEMETRY_STATS_READY");
  assert.deepEqual(stats.countsByKind, { "gate-result": 1 });
  const list = await cli(["telemetry-list", "--workspace", fixture.workspace, "--kind", "gate-result", "--since", at(10)]);
  assert.equal(list.reasonCode, "TELEMETRY_LIST_READY");
  assert.equal(list.records[0].kind, "gate-result");
});

test("STORY-376: the Story 367 injection path records retrieval, bytes, judge, and pull through the same module", async (t) => {
  const fixture = await workspaceFixture(t);
  const state = await materializeWorkspace(fixture.workspace);
  const candidate = { id: "knowledge:000000000000000000000376", kind: "card", key: "K376", status: "active", title: "Telemetry", summary: "Telemetry" };
  const first = await runSessionInjection({
    prompt: "telemetry prompt",
    sessionId: "injection-376",
    event: "UserPromptSubmit",
    stateDirectory: join(fixture.transient, "session-state"),
    workspaceState: state,
    settings: [],
    budget: 24_576,
    perPromptBytes: 1_600,
    recall: async () => ({ ok: true, result: { records: [candidate] } }),
    judge: async () => ({ judgment: true, model: "test-model" }),
  });
  assert.equal(first.decision, "INJECTION_EMITTED");
  const pulled = await runSessionInjection({
    prompt: "",
    sessionId: "injection-376",
    event: "PostToolUse",
    stateDirectory: join(fixture.transient, "session-state"),
    workspaceState: state,
    settings: [],
    hookInput: { tool_name: "work-show", tool_response: JSON.stringify({ id: candidate.id }) },
    judgeEnabled: false,
  });
  assert.equal(pulled.decision, "PULL_RECORDED");
  const telemetry = await readTelemetryRecords(fixture.transient, { limit: 100 });
  assert.deepEqual(new Set(telemetry.records.map((entry) => entry.kind)), new Set(["retrieval-hit", "injection-bytes", "judge", "pull"]));
  assert.equal(telemetry.problems.length, 0);
});

test("STORY-376: concurrent writers serialize complete lines and the 16 KiB record bound stays hard", async (t) => {
  const root = await telemetryRoot(t, "tcrn-telemetry-concurrent-");
  await Promise.all(Array.from({ length: 24 }, (_, index) => appendTelemetryRecord(
    root,
    record("concurrent-kind", at(10, index), "session-" + index),
  )));
  const read = await readTelemetryRecords(root, { kind: "concurrent-kind", limit: 100 });
  assert.equal(read.total, 24);
  assert.deepEqual(read.problems, []);
  assert.throws(
    () => createTelemetryRecord({
      at: at(10),
      kind: "oversized-kind",
      session: "s",
      payload: payload("test:oversized", { values: Array.from({ length: 64 }, () => "x".repeat(256)) }),
    }),
    (error) => error?.reasonCode === "TELEMETRY_RECORD_INVALID" && error.message.includes(String(TELEMETRY_LINE_BYTES)),
  );
  assert.throws(
    () => createTelemetryRecord({ at: at(10), kind: "private-kind", session: "s", payload: payload("test:private", { prompt: "must not persist" }) }),
    (error) => error?.reasonCode === "TELEMETRY_RECORD_INVALID",
  );
});

test("STORY-376: retention deletes only manifest-registered closed day files and refuses a symlink root", async (t) => {
  const root = await telemetryRoot(t, "tcrn-telemetry-retention-");
  await mkdir(join(root, "telemetry"), { recursive: true });
  await writeFile(join(root, "telemetry", "2026-01-01.ndjson"), "old\n");
  await writeFile(join(root, "telemetry", "2026-09-01.ndjson"), "new\n");
  await writeFile(join(root, "telemetry", "manifest.json"), JSON.stringify({
    schemaVersion: "tcrn.telemetry-manifest.v1",
    days: [
      { file: "2026-01-01.ndjson", closedAt: "2026-01-01T00:00:00.000Z" },
      { file: "2026-09-01.ndjson", closedAt: at(9) },
    ],
  }));
  const pruned = await pruneTelemetryRecords(root, { now: at(10), retentionDays: 90 });
  assert.deepEqual(pruned.deleted, ["2026-01-01.ndjson"]);
  assert.deepEqual(pruned.skipped, ["2026-09-01.ndjson"]);
  const linkParent = await telemetryRoot(t, "tcrn-telemetry-link-");
  const link = join(linkParent, "link");
  await symlink(root, link);
  await assert.rejects(readTelemetryRecords(link), (error) => error?.reasonCode === "TELEMETRY_ROOT_INVALID");
});
