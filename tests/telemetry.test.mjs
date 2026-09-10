// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-372 — local dispatch telemetry, hook registration and done evidence.

import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendTelemetryObservationCheckpoint,
  acquireWorkspaceLease,
  appendTelemetryRecord,
  createProject,
  createTelemetryRecord,
  createWork,
  initializeWorkspace,
  materializeWorkspace,
  readTelemetryRecords,
  readTelemetryObservationWindow,
  sealTelemetryObservationDay,
  transitionWork,
} from "../dist/build/packages/core/src/index.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { runTelemetryHook } from "../scripts/dispatch-telemetry-hook.mjs";

const INSTANT = (second) => `2026-09-10T00:00:${String(second).padStart(2, "0")}Z`;

function payload(taskClass = "implement") {
  return {
    dispatchId: "dispatch:telemetry-test",
    parentSession: "parent-session",
    workId: "work:telemetry-test",
    taskClass,
    mode: "frontier",
    requestedTier: "main",
    resolvedTier: "main",
    requestedModel: "requested-model",
    observedModel: "observed-model",
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    source: "test",
    availability: "available",
  };
}

async function scratch(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function workspaceFixture(t) {
  const base = await scratch("tcrn-telemetry-workspace-");
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = ["framework", "workspace", "transient", "evidence-locator", "release-trust"]
    .map((kind) => ({ kind, path: join(base, kind) }));
  for (const root of roots) await mkdir(root.path, { recursive: true });
  const state = await initializeWorkspace({ roots, externalKey: "TELEMETRY-TEST", createdAt: INSTANT(0) });
  return { base, workspace: join(base, "workspace"), transient: join(base, "transient"), state };
}

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

test("STORY-372: telemetry is daily NDJSON, stable, idempotent, filterable, and tolerant of bad lines", async (t) => {
  const root = await scratch("tcrn-telemetry-store-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = createTelemetryRecord({ at: INSTANT(1), kind: "subagent-start", session: "session-1", payload: { ...payload(), observedModel: null, usage: null } });
  const stop = createTelemetryRecord({ at: "2026-09-10T23:30:00-02:00", kind: "subagent-stop", session: "session-1", payload: payload() });
  const first = await appendTelemetryRecord(root, stop);
  const second = await appendTelemetryRecord(root, start);
  const duplicate = await appendTelemetryRecord(root, start);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.match(first.path, /2026-09-11\.ndjson$/u, "day partition uses UTC");
  await appendFile(first.path, "not-json\n");

  const all = await readTelemetryRecords(root, { limit: 10 });
  assert.equal(all.total, 2);
  assert.equal(all.records[0].id, start.id);
  assert.equal(all.records[1].id, stop.id);
  assert.equal(all.problems.length, 1);
  assert.equal(all.problems[0].line, 2);
  assert.equal(all.problems[0].reasonCode, "TELEMETRY_RECORD_INVALID");
  const filtered = await readTelemetryRecords(root, { taskClass: "implement", since: INSTANT(1), limit: 1, offset: 1 });
  assert.equal(filtered.total, 2);
  assert.equal(filtered.records.length, 1, "offset is applied after filtering");
  const verify = await readTelemetryRecords(root, { taskClass: "implement", since: "2026-09-10T23:00:00Z", limit: 10 });
  assert.equal(verify.records.length, 1);
  assert.equal(verify.records[0].kind, "subagent-stop");
});

test("STORY-372: both hook events record bounded facts and never fabricate observed model", async (t) => {
  const root = await scratch("tcrn-telemetry-hook-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    TCRN_TELEMETRY_ROOT: root,
    TCRN_TELEMETRY_HOST: "claude",
    TCRN_TELEMETRY_AT: INSTANT(2),
    TCRN_DISPATCH_ID: "dispatch:hook-test",
    TCRN_TELEMETRY_REQUESTED_MODEL: "requested-only",
    TCRN_TELEMETRY_TASK_CLASS: "implement",
    TCRN_TELEMETRY_MODE: "frontier",
    TCRN_TELEMETRY_REQUESTED_TIER: "main",
    TCRN_TELEMETRY_RESOLVED_TIER: "main",
  };
  const start = await runTelemetryHook({ hook_event_name: "SubagentStart", session_id: "child-1", parent_session: "parent-1", prompt: "do not persist" }, { env });
  const stop = await runTelemetryHook({ hook_event_name: "SubagentStop", session_id: "child-1", parent_session: "parent-1", model: "observed-only", usage: { input_tokens: 13, output_tokens: 5, total_tokens: 18 }, transcript: "do not persist" }, { env, now: () => INSTANT(3) });
  const duplicate = await runTelemetryHook({ hook_event_name: "SubagentStop", session_id: "child-1", parent_session: "parent-1", model: "observed-only", usage: { input_tokens: 13, output_tokens: 5, total_tokens: 18 }, transcript: "do not persist" }, { env, now: () => INSTANT(3) });
  assert.equal(start.reasonCode, "TELEMETRY_RECORDED");
  assert.equal(stop.reasonCode, "TELEMETRY_RECORDED");
  assert.equal(duplicate.reasonCode, "TELEMETRY_DUPLICATE");
  const stored = await readTelemetryRecords(root, { limit: 10 });
  assert.equal(stored.records.length, 2);
  const recordedStart = stored.records.find((record) => record.kind === "subagent-start");
  const recordedStop = stored.records.find((record) => record.kind === "subagent-stop");
  assert.equal(recordedStart.payload.parentSession, "parent-1");
  assert.equal(recordedStart.payload.taskClass, "implement");
  assert.equal(recordedStart.payload.observedModel, null);
  assert.equal(recordedStop.payload.observedModel, "observed-only");
  assert.deepEqual(recordedStop.payload.usage, { inputTokens: 13, outputTokens: 5, totalTokens: 18 });
  assert.doesNotMatch(await readFile(join(root, "telemetry", "2026-09-10.ndjson"), "utf8"), /do not persist/u);
  const unavailable = await runTelemetryHook({ hook_event_name: "SubagentStop", session_id: "child-2", model: "x" }, { env: { TCRN_TELEMETRY_ROOT: "/dev/null" } });
  assert.equal(unavailable.reasonCode, "TELEMETRY_FAIL_OPEN");
  assert.equal(unavailable.ok, true);
});

test("STORY-387: the telemetry hook records an upstream checkpoint only when one is supplied", async (t) => {
  const root = await scratch("tcrn-telemetry-checkpoint-hook-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runTelemetryHook({
    hook_event_name: "SubagentStart",
    session_id: "checkpoint-session",
    observationCheckpoint: {
      channel: "retrieval",
      phase: "start",
      sequence: 11,
      source: "host-upstream",
    },
  }, { env: { TCRN_TELEMETRY_ROOT: root, TCRN_TELEMETRY_AT: INSTANT(10) } });
  assert.equal(result.reasonCode, "TELEMETRY_RECORDED");
  assert.equal(result.observationCheckpoint.duplicate, false);
  const records = await readTelemetryRecords(root, { limit: 10 });
  assert.equal(records.records.filter((record) => record.kind === "observation-checkpoint").length, 1);
});

test("STORY-372: telemetry-list filters and done evidence keeps a snapshot after telemetry expires", async (t) => {
  const fixture = await workspaceFixture(t);
  const telemetry = createTelemetryRecord({ at: INSTANT(4), kind: "subagent-stop", session: "session-evidence", payload: payload() });
  const telemetryEarlier = createTelemetryRecord({ at: INSTANT(3), kind: "subagent-stop", session: "session-earlier", payload: payload() });
  await appendTelemetryRecord(fixture.transient, telemetry);
  await appendTelemetryRecord(fixture.transient, telemetryEarlier);
  const telemetryPath = join(fixture.transient, "telemetry", "2026-09-10.ndjson");
  await appendFile(telemetryPath, "bad-line\n");
  const listed = await cli(["telemetry-list", "--workspace", fixture.workspace, "--class", "implement", "--limit", "1"]);
  assert.equal(listed.reasonCode, "TELEMETRY_LIST_READY");
  assert.equal(listed.total, 2);
  assert.equal(listed.records.length, 1);
  assert.equal(listed.records[0].id, telemetryEarlier.id);
  assert.equal(listed.records[0].payload.taskClass, "implement");
  assert.equal(listed.problems.length, 1);
  const page = await cli(["telemetry-list", "--workspace", fixture.workspace, "--class", "implement", "--limit", "1", "--offset", "1"]);
  assert.equal(page.total, 2);
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].id, telemetry.id);
  const lease = await acquireWorkspaceLease(fixture.workspace, { now: INSTANT(5) });
  let state = await createProject(fixture.workspace, lease, { expectedVersion: fixture.state.version, occurredAt: INSTANT(5), externalKey: "PROJECT", name: "Project" });
  state = await createWork(fixture.workspace, lease, { expectedVersion: state.version, occurredAt: INSTANT(6), projectId: state.projects[0].id, externalKey: "INCIDENT", kind: "Incident", parentId: null, title: "Telemetry evidence" });
  const workId = state.work.find((record) => record.externalKey === "INCIDENT").id;
  await assert.rejects(
    transitionWork(fixture.workspace, lease, { expectedVersion: state.version, occurredAt: INSTANT(7), id: workId, status: "done", evidence: "telemetry:000000000000000000000000" }),
    (error) => error?.reasonCode === "WORKSPACE_TELEMETRY_EVIDENCE_UNRESOLVED",
  );
  state = await transitionWork(fixture.workspace, lease, { expectedVersion: state.version, occurredAt: INSTANT(7), id: workId, status: "ready" });
  state = await transitionWork(fixture.workspace, lease, { expectedVersion: state.version, occurredAt: INSTANT(8), id: workId, status: "active" });
  state = await transitionWork(fixture.workspace, lease, { expectedVersion: state.version, occurredAt: INSTANT(9), id: workId, status: "done", evidence: telemetry.id });
  await lease.release();
  const evidence = state.work.find((record) => record.id === workId).extensions["advisory:evidence"];
  const snapshot = state.work.find((record) => record.id === workId).extensions["advisory:evidence-snapshot"];
  assert.equal(evidence.value, telemetry.id);
  assert.equal(snapshot.value.id, telemetry.id);
  assert.equal(snapshot.value.digest.length, 64);
  await rm(join(fixture.transient, "telemetry"), { recursive: true, force: true });
  const reloaded = await materializeWorkspace(fixture.workspace);
  assert.equal(reloaded.work.find((record) => record.id === workId).status, "done");
  const shown = await cli(["work-show", "--workspace", fixture.workspace, "--id", workId]);
  assert.equal(shown.advisory.evidence, telemetry.id);
  assert.equal(shown.advisory.evidenceStatus, "expired");
});

async function checkpoints(root, day, availabilityByChannel = {}) {
  for (const [index, channel] of ["retrieval", "reference", "trigger", "verify"].entries()) {
    await appendTelemetryObservationCheckpoint(root, {
      at: `${day}T10:00:${String(index * 2).padStart(2, "0")}Z`,
      channel,
      phase: "start",
      sequence: 1,
      source: "telemetry-test-collector",
      availability: availabilityByChannel[channel] ?? "available",
      session: `coverage-${channel}`,
    });
    await appendTelemetryObservationCheckpoint(root, {
      at: `${day}T10:00:${String(index * 2 + 1).padStart(2, "0")}Z`,
      channel,
      phase: "stop",
      sequence: 2,
      source: "telemetry-test-collector",
      availability: availabilityByChannel[channel] ?? "available",
      session: `coverage-${channel}`,
    });
  }
}

test("STORY-387: only explicit four-channel start/stop checkpoints can seal a UTC day", async (t) => {
  const root = await scratch("tcrn-telemetry-coverage-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await checkpoints(root, "2026-09-10");
  const sealed = await sealTelemetryObservationDay(root, { at: "2026-09-11T00:00:01.000Z" });
  assert.equal(sealed.ok, true);
  assert.equal(sealed.reasonCode, "TELEMETRY_COVERAGE_RECORDED");
  assert.equal(sealed.recordCount, 8);
  const duplicate = await sealTelemetryObservationDay(root, { at: "2026-09-11T00:00:02.000Z" });
  assert.equal(duplicate.reasonCode, "TELEMETRY_COVERAGE_ALREADY_RECORDED");
  assert.equal(duplicate.duplicate, true);
  const window = await readTelemetryObservationWindow(root, "2026-09-11T12:00:00.000Z", 1);
  assert.equal(window.complete, true);
  assert.equal(window.records.length, 8);

  const late = await sealTelemetryObservationDay(root, { at: "2026-09-10T23:59:59.000Z" });
  assert.equal(late.ok, false);
  assert.equal(late.reasonCode, "TELEMETRY_COVERAGE_UNPROVEN");
  await appendTelemetryObservationCheckpoint(root, {
    at: "2026-09-10T11:00:00.000Z",
    channel: "verify",
    phase: "start",
    sequence: 3,
    source: "telemetry-test-collector",
  });
  const conflict = await sealTelemetryObservationDay(root, { at: "2026-09-11T00:00:03.000Z" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reasonCode, "TELEMETRY_COVERAGE_CONFLICT");
});

test("STORY-387: missing and unavailable upstream observations stay unproven", async (t) => {
  const missing = await scratch("tcrn-telemetry-coverage-missing-");
  t.after(() => rm(missing, { recursive: true, force: true }));
  const noInput = await sealTelemetryObservationDay(missing, { at: "2026-09-11T00:00:01.000Z" });
  assert.equal(noInput.ok, false);
  assert.deepEqual(noInput.missingChannels, ["retrieval", "reference", "trigger", "verify"]);

  const unavailable = await scratch("tcrn-telemetry-coverage-unavailable-");
  t.after(() => rm(unavailable, { recursive: true, force: true }));
  await checkpoints(unavailable, "2026-09-10", { verify: "unknown" });
  const notSealed = await sealTelemetryObservationDay(unavailable, { at: "2026-09-11T00:00:01.000Z" });
  assert.equal(notSealed.ok, false);
  assert.deepEqual(notSealed.invalidChannels, ["verify"]);
  const notComplete = await readTelemetryObservationWindow(unavailable, "2026-09-11T12:00:00.000Z", 1);
  assert.equal(notComplete.complete, false);
  assert.ok(notComplete.invalidDays.includes("2026-09-10.ndjson"));
});
