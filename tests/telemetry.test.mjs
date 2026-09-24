// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-372 — local dispatch telemetry, hook registration and done evidence.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  acquireWorkspaceLease,
  appendTelemetryRecord,
  createProject,
  createTelemetryRecord,
  createWork,
  initializeWorkspace,
  materializeWorkspace,
  readTelemetryRecords,
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

// TCRN-CROSS-INC-368: a fixture shaped like a real container -- roots live under
// `<base>/.tcrn-workspace/<partition>/*`, matching `workspaceForPartition()`'s own
// derivation -- rather than `workspaceFixture()`'s flatter `<base>/*`, which existing
// tests reach only through `TCRN_TELEMETRY_ROOT`/`TCRN_TELEMETRY_WORKSPACE` and never
// through `containerRoot` itself.
async function containerRootFixture(t, partition = "cross-project") {
  const base = await scratch("tcrn-telemetry-container-root-");
  t.after(() => rm(base, { recursive: true, force: true }));
  const partitionBase = join(base, ".tcrn-workspace", partition);
  const roots = ["framework", "workspace", "transient", "evidence-locator", "release-trust"]
    .map((kind) => ({ kind, path: join(partitionBase, kind) }));
  for (const root of roots) await mkdir(root.path, { recursive: true });
  await initializeWorkspace({ roots, externalKey: "TELEMETRY-CONTAINER-ROOT-TEST", createdAt: INSTANT(0) });
  return { base, transient: join(partitionBase, "transient") };
}

const DISPATCH_TELEMETRY_HOOK_PATH = fileURLToPath(new URL("../scripts/dispatch-telemetry-hook.mjs", import.meta.url));

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

test("STORY-393 U6: an explicit Codex hook host is preserved over payload ambiguity", async (t) => {
  const root = await scratch("tcrn-telemetry-explicit-host-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runTelemetryHook(
    { hook_event_name: "SubagentStart", session_id: "codex-child", host: "claude" },
    { env: { TCRN_TELEMETRY_ROOT: root, TCRN_TELEMETRY_HOST: "codex", TCRN_TELEMETRY_AT: INSTANT(11) } },
  );
  assert.equal(result.reasonCode, "TELEMETRY_RECORDED");
  const record = (await readTelemetryRecords(root, { limit: 10 })).records[0];
  assert.equal(record.payload.source, "hook:codex:SubagentStart");
});

test("TCRN-CROSS-INC-368 leg 1: a container root with an initialized workspace records telemetry under it", async (t) => {
  const { base, transient } = await containerRootFixture(t);
  const input = JSON.stringify({ hook_event_name: "SubagentStart", session_id: "container-root-child", parent_session: "container-root-parent" });
  const run = spawnSync(process.execPath, [DISPATCH_TELEMETRY_HOOK_PATH, "--container-root", base, "--host", "codex"], { encoding: "utf8", input });
  assert.equal(run.status, 0, `expected a clean exit; stderr=${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.equal(result.reasonCode, "TELEMETRY_RECORDED", `--container-root must resolve the fixture's own workspace, not fail open against it: ${run.stdout}`);
  const records = await readTelemetryRecords(transient, { limit: 10 });
  assert.equal(records.records.length, 1);
  assert.equal(records.records[0].payload.source, "hook:codex:SubagentStart");
});

test("TCRN-CROSS-INC-368 leg 2: an empty (uninitialized) --container-root fails open rather than silently falling back to the installed copy's own container", async (t) => {
  const bare = await scratch("tcrn-telemetry-bare-container-root-");
  t.after(() => rm(bare, { recursive: true, force: true }));
  const input = JSON.stringify({ hook_event_name: "SubagentStart", session_id: "bare-child", parent_session: "bare-parent" });
  const run = spawnSync(process.execPath, [DISPATCH_TELEMETRY_HOOK_PATH, "--container-root", bare, "--host", "codex"], { encoding: "utf8", input });
  assert.equal(run.status, 0, "fail-open never exits non-zero");
  const result = JSON.parse(run.stdout);
  // If the flag were silently ignored, `containerRoot` would default to this script's
  // real, already-initialized `PLATFORM_ROOT` and the call would come back
  // TELEMETRY_RECORDED -- exactly the false negative INC-368 reports. Getting a failure
  // instead of a real container's real chain is the proof the flag was actually consulted.
  assert.equal(result.ok, true);
  assert.notEqual(result.reasonCode, "TELEMETRY_RECORDED");
  assert.match(result.reasonCode, /^TELEMETRY_(FAIL_OPEN|UNAVAILABLE)$/u);
});

test("TCRN-CROSS-INC-368 leg 3: omitting --container-root is still a clean, recognised invocation (transition safety for an installed copy that predates the flag)", async (t) => {
  // The exact argv an already-installed copy of this script would still be invoked with
  // once a render adds the flag only to *new* renders: no --container-root at all. This
  // must not become a usage error or otherwise change shape -- proven here via
  // TCRN_TELEMETRY_ROOT (which this repo's own tests already use throughout this file to
  // reach a scratch sink) rather than the real platform container, so the test never
  // touches the live chain under `.tcrn-workspace`.
  const root = await scratch("tcrn-telemetry-legacy-argv-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = JSON.stringify({ hook_event_name: "SubagentStart", session_id: "legacy-argv-child", parent_session: "legacy-argv-parent" });
  const run = spawnSync(process.execPath, [DISPATCH_TELEMETRY_HOOK_PATH, "--host", "codex"], {
    encoding: "utf8",
    input,
    env: { ...process.env, TCRN_TELEMETRY_ROOT: root },
  });
  assert.equal(run.status, 0, `expected a clean exit; stderr=${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, "TELEMETRY_RECORDED", `no --container-root must not become a usage error: ${run.stdout}`);
});

test("STORY-424: lifecycle facts are bounded and missing facts stay unknown", async (t) => {
  const root = await scratch("tcrn-telemetry-lifecycle-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const digest = "a".repeat(64);
  const start = await runTelemetryHook({
    hook_event_name: "SubagentStart",
    session_id: "clarification-session",
    lifecycle: {
      phase: "clarification",
      role: "implementation",
      pack: "EPIC135/STORY-424",
      effort: "max",
      agentId: "agent-424",
      newInstance: false,
      sameTaskRunning: true,
      sourceEvidence: [{ kind: "turn_context", locator: "child-rollout#turn_context", digest }],
    },
    prompt: "must never be persisted",
  }, { env: { TCRN_TELEMETRY_ROOT: root, TCRN_TELEMETRY_HOST: "codex", TCRN_TELEMETRY_AT: INSTANT(12) } });
  assert.equal(start.reasonCode, "TELEMETRY_RECORDED");
  const stored = (await readTelemetryRecords(root, { limit: 10 })).records[0];
  assert.equal(stored.payload.lifecyclePhase, "clarification");
  assert.equal(stored.payload.role, "implementation");
  assert.equal(stored.payload.pack, "EPIC135/STORY-424");
  assert.equal(stored.payload.agentId, "agent-424");
  assert.equal(stored.payload.newInstance, false);
  assert.equal(stored.payload.sameTaskRunning, true);
  assert.equal(stored.payload.sourceEvidenceStatus, "available");
  assert.deepEqual(stored.payload.sourceEvidence, [{ kind: "turn_context", locator: "child-rollout#turn_context", digest }]);
  assert.doesNotMatch(await readFile(join(root, "telemetry", "2026-09-10.ndjson"), "utf8"), /must never be persisted/u);

  const unknown = await runTelemetryHook({ hook_event_name: "SubagentStop", session_id: "unknown-session" }, { env: { TCRN_TELEMETRY_ROOT: root, TCRN_TELEMETRY_AT: INSTANT(13) } });
  assert.equal(unknown.reasonCode, "TELEMETRY_RECORDED");
  const unknownRecord = (await readTelemetryRecords(root, { limit: 10 })).records.find((record) => record.session === "unknown-session");
  assert.ok(unknownRecord);
  assert.equal(unknownRecord.payload.newInstance, null);
  assert.equal(unknownRecord.payload.forkTurns, null);
  assert.equal(unknownRecord.payload.sourceEvidenceStatus, "unknown");
});

test("native declaration-only stop telemetry never becomes an observed model", async (t) => {
  const root = await scratch("tcrn-telemetry-declaration-observation-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const declaration = {
    workId: "work:telemetry-424",
    phase: "rework",
    role: "implementation",
    pack: "EPIC135/STORY-424",
    model: "declared-only-model",
    effort: "max",
    newInstance: true,
    forkTurns: "none",
    sourceEvidence: [{ kind: "turn_context", locator: "unavailable-turn", digest: "unknown", status: "unknown" }],
  };
  await runTelemetryHook({ hook_event_name: "SubagentStop", session_id: "declared-only", lifecycle: declaration }, { env: { TCRN_TELEMETRY_ROOT: root, TCRN_TELEMETRY_HOST: "codex", TCRN_TELEMETRY_AT: INSTANT(14) } });
  await runTelemetryHook({ hook_event_name: "SubagentStop", session_id: "actual-observation", lifecycle: declaration, observation: { model: "observed-model" } }, { env: { TCRN_TELEMETRY_ROOT: root, TCRN_TELEMETRY_HOST: "codex", TCRN_TELEMETRY_AT: INSTANT(15) } });

  const records = (await readTelemetryRecords(root, { limit: 10 })).records;
  const declared = records.find((record) => record.session === "declared-only");
  const observed = records.find((record) => record.session === "actual-observation");
  assert.ok(declared);
  assert.ok(observed);
  assert.equal(declared.payload.observedModel, null);
  assert.equal(declared.payload.forkTurns, "none");
  assert.equal(declared.payload.sourceEvidenceStatus, "unknown");
  assert.deepEqual(declared.payload.sourceEvidence, [{ kind: "turn_context", locator: "unavailable-turn", digest: "unknown", status: "unknown" }]);
  assert.equal(observed.payload.observedModel, "observed-model");
  assert.equal(observed.payload.forkTurns, "none");
});

test("STORY-424 R02: unknown source evidence never masquerades as available or verified", async (t) => {
  const root = await scratch("tcrn-telemetry-unknown-evidence-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await runTelemetryHook({
    hook_event_name: "SubagentStop",
    session_id: "unknown-string",
    sourceEvidence: ["unknown"],
  }, { env: { TCRN_TELEMETRY_ROOT: root, TCRN_TELEMETRY_AT: INSTANT(16) } });
  await runTelemetryHook({
    hook_event_name: "SubagentStop",
    session_id: "missing-digest",
    sourceEvidence: [{ kind: "turn_context", locator: "present-but-unhashed" }],
  }, { env: { TCRN_TELEMETRY_ROOT: root, TCRN_TELEMETRY_AT: INSTANT(17) } });
  const records = (await readTelemetryRecords(root, { limit: 10 })).records;
  const unknownString = records.find((record) => record.session === "unknown-string");
  const missingDigest = records.find((record) => record.session === "missing-digest");
  assert.equal(unknownString.payload.sourceEvidenceStatus, "unknown");
  assert.equal(unknownString.payload.sourceEvidenceAvailability, "unknown");
  assert.equal(unknownString.payload.sourceEvidenceVerifiability, "unknown");
  assert.equal(missingDigest.payload.sourceEvidenceStatus, "unknown");
  assert.equal(missingDigest.payload.sourceEvidenceAvailability, "available");
  assert.equal(missingDigest.payload.sourceEvidenceVerifiability, "unknown");
});

test("STORY-424 R02: conflicting explicit and generic model observations remain ambiguous", async (t) => {
  const root = await scratch("tcrn-telemetry-model-ambiguity-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await runTelemetryHook({
    hook_event_name: "SubagentStop",
    session_id: "model-conflict",
    model: "declared-model",
    observedModel: "actual-model",
    requestedModel: "requested-model",
  }, { env: { TCRN_TELEMETRY_ROOT: root, TCRN_TELEMETRY_AT: INSTANT(18) } });
  const record = (await readTelemetryRecords(root, { limit: 10 })).records[0];
  assert.equal(record.payload.observedModel, null);
  assert.equal(record.payload.observedModelStatus, "ambiguous");
  assert.deepEqual(record.payload.observedModelCandidates, {
    explicit: ["actual-model"],
    generic: ["declared-model"],
  });
  assert.equal(record.payload.requestedModel, "requested-model");
});

test("STORY-393: the dispatch hook cannot mint an observation checkpoint from external input", async (t) => {
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
  const records = await readTelemetryRecords(root, { limit: 10 });
  assert.equal(records.records.filter((record) => record.kind === "observation-checkpoint").length, 0);
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
