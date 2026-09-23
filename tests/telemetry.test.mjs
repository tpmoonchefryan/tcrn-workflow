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
import { readTelemetryObservationWindow } from "../dist/build/packages/core/src/telemetry.js";
import * as telemetryCore from "../dist/build/packages/core/src/telemetry.js";
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import { OBSERVATION_BOUNDARY_PREFIX, OBSERVATION_CHANNELS, recordObservationBoundary, sealObservationDay } from "../scripts/knowledge-inject.mjs";

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

test("STORY-393: a host session boundary reconciles four real channel high-water marks", async (t) => {
  const fixture = await workspaceFixture(t);
  const start = await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "host-session", host: "claude", phase: "start", at: "2026-09-09T23:59:59.000Z", workspaceState: fixture.state });
  assert.equal(start.ok, true);
  for (const channel of OBSERVATION_CHANNELS) {
    const kind = { retrieval: "retrieval-hit", reference: "reference", trigger: "trigger", verify: "verify" }[channel];
    await appendTelemetryRecord(fixture.transient, createTelemetryRecord({ at: "2026-09-10T12:00:00.000Z", kind, session: `host-session-${channel}`, payload: { source: `host-session:actual:${channel}`, availability: "available" } }));
  }
  const stop = await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "host-session", host: "claude", phase: "stop", at: "2026-09-10T23:59:59.999Z", workspaceState: fixture.state });
  assert.equal(stop.ok, true);
  const sealed = await sealObservationDay(fixture.transient, { at: "2026-09-11T00:00:01.000Z" });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  assert.equal((await readTelemetryObservationWindow(fixture.transient, "2026-09-11T12:00:00.000Z", 1)).complete, true);
  const records = await readTelemetryRecords(fixture.transient, { limit: Number.MAX_SAFE_INTEGER });
  assert.equal(records.records.filter((record) => record.payload.source.startsWith(OBSERVATION_BOUNDARY_PREFIX)).length, 16);
});

test("STORY-393 B1: Stop closes the not-yet-sealed UTC day and keeps the date first in the source key", async (t) => {
  const fixture = await workspaceFixture(t);
  const start = await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "host-session", host: "claude", phase: "start", at: "2026-09-10T00:00:00.000Z", workspaceState: fixture.state });
  assert.equal(start.ok, true);
  for (const channel of OBSERVATION_CHANNELS) {
    const kind = { retrieval: "retrieval-hit", reference: "reference", trigger: "trigger", verify: "verify" }[channel];
    await appendTelemetryRecord(fixture.transient, createTelemetryRecord({ at: "2026-09-10T12:00:00.000Z", kind, session: `host-session-${channel}`, payload: { source: `host-session:actual:${channel}`, availability: "available" } }));
  }
  const stop = await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "host-session", host: "claude", phase: "stop", at: "2026-09-11T02:00:00.000Z", workspaceState: fixture.state });
  assert.equal(stop.ok, true, JSON.stringify(stop));
  assert.equal(stop.coverage.reasonCode, "TELEMETRY_COVERAGE_RECORDED", JSON.stringify(stop.coverage));
  assert.equal((await readTelemetryObservationWindow(fixture.transient, "2026-09-11T12:00:00.000Z", 1)).complete, true);
  const boundaries = (await readTelemetryRecords(fixture.transient, { limit: Number.MAX_SAFE_INTEGER })).records.filter((record) => record.payload.source.startsWith(OBSERVATION_BOUNDARY_PREFIX));
  assert.ok(boundaries.some((record) => record.payload.source.includes(":20260910.host-session:")), "the UTC date is retained before the bounded session segment");
  assert.ok(boundaries.every((record) => record.session.startsWith("20260910.") || record.session.startsWith("20260911.")));
});

test("STORY-393 B1: repeated Stop events extend the prior attested endpoint without stop-stop rows", async (t) => {
  const fixture = await workspaceFixture(t);
  await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "multi-turn", host: "claude", phase: "start", at: "2026-09-10T09:00:00.000Z", workspaceState: fixture.state });
  await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "multi-turn", host: "claude", phase: "stop", at: "2026-09-10T10:00:00.000Z", workspaceState: fixture.state });
  await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "multi-turn", host: "claude", phase: "stop", at: "2026-09-10T11:00:00.000Z", workspaceState: fixture.state });
  const rows = (await readTelemetryRecords(fixture.transient, { limit: Number.MAX_SAFE_INTEGER })).records
    .filter((record) => record.kind === "retrieval" && record.payload.source.includes(":20260910.multi-turn:"))
    .sort((left, right) => Number(left.payload.sequence) - Number(right.payload.sequence));
  assert.deepEqual(rows.map((record) => [record.payload.phase, record.payload.sequence]), [["start", 1], ["stop", 2], ["start", 3], ["stop", 4]]);
  assert.equal(rows[2].at, "2026-09-10T10:00:00.000Z", "the synthetic start is the previous real stop");
});

test("TCRN-CROSS-SUB-153 D4: an overlong Stop resumes all channels at the real instant and stays idempotent", async (t) => {
  const fixture = await workspaceFixture(t);
  const start = await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "stale-session", host: "claude", phase: "start", at: "2026-09-01T00:00:00.000Z", workspaceState: fixture.state });
  assert.equal(start.ok, true);

  const gap = await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "stale-session", host: "claude", phase: "stop", at: "2026-09-05T12:00:00.000Z", workspaceState: fixture.state });
  assert.deepEqual(gap, {
    ok: false,
    reasonCode: "TELEMETRY_BOUNDARY_GAP_RESUMED",
    unknown: true,
    resumed: true,
    from: "2026-09-01",
    until: "2026-09-05",
    count: 4,
    duplicate: false,
  });
  let records = (await readTelemetryRecords(fixture.transient, { limit: Number.MAX_SAFE_INTEGER })).records;
  const boundaries = records.filter((record) => record.payload.source.startsWith(OBSERVATION_BOUNDARY_PREFIX));
  assert.equal(boundaries.filter((record) => record.payload.phase === "stop").length, 0, "a gap never writes a backdated Stop");
  assert.equal(records.filter((record) => record.kind === "observation-coverage").length, 0, "a gap never seals coverage");
  const resumed = boundaries.filter((record) => record.at === "2026-09-05T12:00:00.000Z" && record.payload.phase === "start");
  assert.deepEqual(new Set(resumed.map((record) => record.kind)), new Set(OBSERVATION_CHANNELS));

  const retry = await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "stale-session", host: "claude", phase: "stop", at: "2026-09-05T12:00:00.000Z", workspaceState: fixture.state });
  assert.deepEqual(retry, { ...gap, count: 0, duplicate: true }, "an identical resume is a deterministic no-op");
  records = (await readTelemetryRecords(fixture.transient, { limit: Number.MAX_SAFE_INTEGER })).records;
  assert.equal(records.length, boundaries.length, "an identical resume appends nothing");

  for (const channel of OBSERVATION_CHANNELS) {
    const kind = { retrieval: "retrieval-hit", reference: "reference", trigger: "trigger", verify: "verify" }[channel];
    await appendTelemetryRecord(fixture.transient, createTelemetryRecord({
      at: "2026-09-05T13:00:00.000Z",
      kind,
      session: `stale-session-${channel}`,
      payload: { source: `post-gap:${channel}`, availability: "available" },
    }));
  }
  const later = await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "stale-session", host: "claude", phase: "stop", at: "2026-09-06T00:00:01.000Z", workspaceState: fixture.state });
  assert.equal(later.ok, true, JSON.stringify(later));
  assert.equal(later.reasonCode, "TELEMETRY_BOUNDARY_RECORDED");
  assert.equal(later.coverage?.reasonCode, "TELEMETRY_COVERAGE_UNPROVEN", "a mid-day resumed boundary cannot seal a full UTC day");
});

test("TCRN-CROSS-SUB-166 D4: a Stop with no prior boundary resumes only four channels at the actual instant", async (t) => {
  const fixture = await workspaceFixture(t);
  const at = "2026-09-10T12:00:00.000Z";
  const resumed = await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "empty-session", host: "claude", phase: "stop", at, workspaceState: fixture.state });
  assert.deepEqual(resumed, {
    ok: false,
    reasonCode: "TELEMETRY_BOUNDARY_GAP_RESUMED",
    unknown: true,
    resumed: true,
    from: "2026-09-10",
    until: "2026-09-10",
    count: 4,
    duplicate: false,
  });

  let records = (await readTelemetryRecords(fixture.transient, { limit: Number.MAX_SAFE_INTEGER })).records;
  const boundaries = records.filter((record) => record.payload.source.startsWith(OBSERVATION_BOUNDARY_PREFIX));
  assert.equal(boundaries.length, 4);
  assert.deepEqual(new Set(boundaries.map((record) => record.kind)), new Set(OBSERVATION_CHANNELS));
  assert.ok(boundaries.every((record) => record.at === at && record.payload.phase === "start"));
  assert.equal(records.filter((record) => record.payload.phase === "stop").length, 0);
  assert.equal(records.filter((record) => record.kind === "observation-coverage").length, 0);

  const retry = await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "empty-session", host: "claude", phase: "stop", at, workspaceState: fixture.state });
  assert.deepEqual(retry, { ...resumed, count: 0, duplicate: true });
  records = (await readTelemetryRecords(fixture.transient, { limit: Number.MAX_SAFE_INTEGER })).records;
  assert.equal(records.length, 4, "an identical no-prior-boundary retry appends nothing");
});

test("TCRN-CROSS-SUB-153 D4: exactly three days remains bounded and invalid time fails closed", async (t) => {
  const fixture = await workspaceFixture(t);
  await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "three-days", host: "claude", phase: "start", at: "2026-09-01T00:00:00.000Z", workspaceState: fixture.state });
  const bounded = await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "three-days", host: "claude", phase: "stop", at: "2026-09-03T23:59:59.000Z", workspaceState: fixture.state });
  assert.equal(bounded.ok, true, JSON.stringify(bounded));
  assert.equal(bounded.reasonCode, "TELEMETRY_BOUNDARY_RECORDED");
  const invalid = await recordObservationBoundary({ partition: "cross-project", containerRoot: fixture.base, sessionId: "three-days", host: "claude", phase: "stop", at: "not-a-time", workspaceState: fixture.state });
  assert.deepEqual(invalid, { ok: false, reasonCode: "TELEMETRY_BOUNDARY_INVALID" });
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
  for (const channel of OBSERVATION_CHANNELS) {
    const kind = { retrieval: "retrieval-hit", reference: "reference", trigger: "trigger", verify: "verify" }[channel];
    const availability = availabilityByChannel[channel] ?? "available";
    const actual = createTelemetryRecord({ at: `${day}T12:00:00.000Z`, kind, session: `coverage-actual-${channel}`, payload: { source: `telemetry-test-actual:${channel}`, availability: "available" } });
    await appendTelemetryRecord(root, actual);
    const highWater = { highWaterDay: day, highWaterCount: 1, highWaterDigest: canonicalSha256([actual]), highWaterAt: actual.at };
    for (const [phase, at] of [["start", `${day}T00:00:00.000Z`], ["stop", `${day}T23:59:59.999Z`]]) {
      const upstream = createTelemetryRecord({
        at,
        kind,
        session: `coverage-${channel}`,
        payload: { source: `${OBSERVATION_BOUNDARY_PREFIX}test-session:${channel}`, availability, phase, sequence: phase === "start" ? 1 : 2, ...highWater },
      });
      await appendTelemetryRecord(root, upstream);
    }
  }
}

async function unionCheckpoints(root, spans, hosts = []) {
  for (const channel of OBSERVATION_CHANNELS) {
    const kind = { retrieval: "retrieval", reference: "reference", trigger: "trigger", verify: "verify" }[channel];
    const actual = createTelemetryRecord({ at: "2026-09-10T10:00:00.000Z", kind, session: `union-actual-${channel}`, payload: { source: `union-actual:${channel}`, availability: "available" } });
    await appendTelemetryRecord(root, actual);
    const sequenceBySource = new Map();
    for (const [index, [session, start, stop]] of spans.entries()) {
      const host = hosts[index] ?? "test-host";
      const source = `${OBSERVATION_BOUNDARY_PREFIX}${host}:${session}:${channel}`;
      const sequenceStart = (sequenceBySource.get(source) ?? 0) + 1;
      sequenceBySource.set(source, sequenceStart + 1);
      for (const [phase, at] of [["start", start], ["stop", stop]]) {
        const boundaryDate = new Date(at);
        if (phase === "stop" && boundaryDate.getUTCHours() === 0) boundaryDate.setUTCDate(boundaryDate.getUTCDate() - 1);
        const day = boundaryDate.toISOString().slice(0, 10);
        const observed = day === "2026-09-10" && Date.parse(at) >= Date.parse(actual.at) ? [actual] : [];
        await appendTelemetryRecord(root, createTelemetryRecord({
          at,
          kind,
          session,
          payload: { source, availability: "available", phase, sequence: sequenceStart + (phase === "start" ? 0 : 1), highWaterDay: day, highWaterCount: observed.length, highWaterDigest: canonicalSha256(observed), highWaterAt: observed.at(-1)?.at ?? null },
        }));
      }
    }
  }
}

test("STORY-393: continuous and overlapping trusted sessions form one coverage interval", async (t) => {
  const root = await scratch("tcrn-telemetry-coverage-union-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await unionCheckpoints(root, [
    ["session-a", "2026-09-09T23:59:59.000Z", "2026-09-10T12:00:00.000Z"],
    ["session-b", "2026-09-10T11:59:59.000Z", "2026-09-11T00:00:00.000Z"],
  ]);
  const sealed = await sealObservationDay(root, { at: "2026-09-11T00:00:01.000Z" });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  const receipt = (await readTelemetryRecords(root, { limit: Number.MAX_SAFE_INTEGER })).records.find((record) => record.kind === "observation-coverage");
  assert.equal(receipt.payload.channelCheckpoints.retrieval.recordCount, 4);
  assert.equal((await readTelemetryObservationWindow(root, "2026-09-11T12:00:00.000Z", 1)).complete, true);
});

test("STORY-393 U5: repeated start-stop pairs in one trusted session form one coverage interval", async (t) => {
  const root = await scratch("tcrn-telemetry-coverage-resumed-session-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await unionCheckpoints(root, [
    ["session-resumed", "2026-09-09T23:59:59.000Z", "2026-09-10T12:00:00.000Z"],
    ["session-resumed", "2026-09-10T12:00:00.000Z", "2026-09-11T00:00:00.000Z"],
  ]);
  const sealed = await sealObservationDay(root, { at: "2026-09-11T00:00:01.000Z" });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  const receipt = (await readTelemetryRecords(root, { limit: Number.MAX_SAFE_INTEGER })).records.find((record) => record.kind === "observation-coverage");
  assert.equal(receipt.payload.channelCheckpoints.retrieval.recordCount, 4);
  assert.equal((await readTelemetryObservationWindow(root, "2026-09-11T12:00:00.000Z", 1)).complete, true);
});

test("STORY-393 U5: contiguous intervals from separate sessions on one host cover one day", async (t) => {
  const root = await scratch("tcrn-telemetry-coverage-contiguous-sessions-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await unionCheckpoints(root, [
    ["session-a", "2026-09-09T23:59:59.000Z", "2026-09-10T12:00:00.000Z"],
    ["session-b", "2026-09-10T12:00:00.000Z", "2026-09-11T00:00:00.000Z"],
  ]);
  const sealed = await sealObservationDay(root, { at: "2026-09-11T00:00:01.000Z" });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  assert.equal((await readTelemetryObservationWindow(root, "2026-09-11T12:00:00.000Z", 1)).complete, true);
});

test("STORY-393: gaps and incompatible host sources never combine into a full day", async (t) => {
  for (const [name, hosts] of [["gap", ["test-host", "test-host"]], ["host", ["host-a", "host-b"]]]) {
    const root = await scratch(`tcrn-telemetry-coverage-${name}-union-`);
    t.after(() => rm(root, { recursive: true, force: true }));
    await unionCheckpoints(root, [
      ["session-a", "2026-09-09T23:59:59.000Z", "2026-09-10T12:00:00.000Z"],
      ["session-b", name === "gap" ? "2026-09-10T12:00:00.001Z" : "2026-09-10T12:00:00.000Z", "2026-09-11T00:00:00.000Z"],
    ], hosts);
    const sealed = await sealObservationDay(root, { at: "2026-09-11T00:00:01.000Z" });
    assert.equal(sealed.ok, false, name);
    assert.deepEqual(sealed.invalidChannels, OBSERVATION_CHANNELS, name);
  }
});

test("STORY-393: a late boundary with a bad high-water digest cannot extend coverage", async (t) => {
  const root = await scratch("tcrn-telemetry-coverage-late-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await unionCheckpoints(root, [
    ["session-a", "2026-09-09T23:59:59.000Z", "2026-09-10T12:00:00.000Z"],
    ["session-b", "2026-09-10T12:00:00.000Z", "2026-09-11T00:00:00.000Z"],
  ]);
  await appendTelemetryRecord(root, createTelemetryRecord({
    at: "2026-09-11T00:00:00.100Z",
    kind: "retrieval",
    session: "session-b",
    payload: { source: `${OBSERVATION_BOUNDARY_PREFIX}test-host:session-b:retrieval`, availability: "available", phase: "stop", sequence: 3, highWaterDay: "2026-09-10", highWaterCount: 1, highWaterDigest: "0".repeat(64), highWaterAt: "2026-09-10T10:00:00.000Z" },
  }));
  const sealed = await sealObservationDay(root, { at: "2026-09-11T00:00:01.000Z" });
  assert.equal(sealed.ok, false);
  assert.deepEqual(sealed.invalidChannels, ["retrieval"]);
});

test("STORY-393: only actual full-day four-channel observations can seal a UTC day", async (t) => {
  const root = await scratch("tcrn-telemetry-coverage-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await checkpoints(root, "2026-09-10");
  const sealed = await sealObservationDay(root, { at: "2026-09-11T00:00:01.000Z" });
  assert.equal(sealed.ok, true);
  assert.equal(sealed.reasonCode, "TELEMETRY_COVERAGE_RECORDED");
  assert.equal(sealed.recordCount, 12);
  const duplicate = await sealObservationDay(root, { at: "2026-09-11T00:00:02.000Z" });
  assert.equal(duplicate.reasonCode, "TELEMETRY_COVERAGE_ALREADY_RECORDED");
  assert.equal(duplicate.duplicate, true);
  const window = await readTelemetryObservationWindow(root, "2026-09-11T12:00:00.000Z", 1);
  assert.equal(window.complete, true);
  assert.equal(window.records.length, 12);

  const late = await sealObservationDay(root, { at: "2026-09-10T23:59:59.000Z" });
  assert.equal(late.ok, false);
  assert.equal(late.reasonCode, "TELEMETRY_COVERAGE_UNPROVEN");
  const current = await readTelemetryRecords(root, { limit: Number.MAX_SAFE_INTEGER });
  const verifyActual = current.records.filter((record) => record.kind === "verify" && !record.payload.source.startsWith(OBSERVATION_BOUNDARY_PREFIX));
  const extra = createTelemetryRecord({ id: "telemetry:ffffffffffffffffffffffff", at: "2026-09-10T23:59:59.999Z", kind: "verify", session: "coverage-verify-extra", payload: { source: `${OBSERVATION_BOUNDARY_PREFIX}test-session:verify`, availability: "available", phase: "stop", sequence: 3, highWaterDay: "2026-09-10", highWaterCount: verifyActual.length, highWaterDigest: canonicalSha256(verifyActual), highWaterAt: verifyActual.at(-1).at } });
  await appendTelemetryRecord(root, extra);
  const conflict = await sealObservationDay(root, { at: "2026-09-11T00:00:03.000Z" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reasonCode, "TELEMETRY_COVERAGE_UNPROVEN");
  assert.deepEqual(conflict.invalidChannels, ["verify"]);
});

test("STORY-393: missing and unavailable upstream observations stay unproven", async (t) => {
  const missing = await scratch("tcrn-telemetry-coverage-missing-");
  t.after(() => rm(missing, { recursive: true, force: true }));
  const noInput = await sealObservationDay(missing, { at: "2026-09-11T00:00:01.000Z" });
  assert.equal(noInput.ok, false);
  assert.deepEqual(noInput.missingChannels, ["retrieval", "reference", "trigger", "verify"]);

  const unavailable = await scratch("tcrn-telemetry-coverage-unavailable-");
  t.after(() => rm(unavailable, { recursive: true, force: true }));
  await checkpoints(unavailable, "2026-09-10", { verify: "unknown" });
  const notSealed = await sealObservationDay(unavailable, { at: "2026-09-11T00:00:01.000Z" });
  assert.equal(notSealed.ok, false);
  assert.deepEqual(notSealed.invalidChannels, ["verify"]);
  const notComplete = await readTelemetryObservationWindow(unavailable, "2026-09-11T12:00:00.000Z", 1);
  assert.equal(notComplete.complete, false);
  assert.ok(notComplete.invalidDays.includes("2026-09-10.ndjson"));
});

test("STORY-393: partial, gapped, and reverse-phase upstream coverage never seals", async (t) => {
  const cases = [
    ["partial", ["2026-09-10T10:00:00.000Z", "2026-09-10T10:00:01.000Z"], [1, 2], ["start", "stop"]],
    ["gapped", ["2026-09-10T00:00:00.000Z", "2026-09-10T23:59:59.999Z"], [1, 999], ["start", "stop"]],
    ["reverse", ["2026-09-10T00:00:00.000Z", "2026-09-10T23:59:59.999Z"], [1, 2], ["stop", "start"]],
  ];
  for (const [name, times, sequences, phases] of cases) {
    const root = await scratch(`tcrn-telemetry-coverage-${name}-`);
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const channel of OBSERVATION_CHANNELS) {
      const kind = { retrieval: "retrieval-hit", reference: "reference", trigger: "trigger", verify: "verify" }[channel];
      const actual = createTelemetryRecord({ at: "2026-09-10T12:00:00.000Z", kind, session: `coverage-${name}-actual-${channel}`, payload: { source: `telemetry-test-actual:${name}:${channel}`, availability: "available" } });
      await appendTelemetryRecord(root, actual);
      const highWater = { highWaterDay: "2026-09-10", highWaterCount: 1, highWaterDigest: canonicalSha256([actual]), highWaterAt: actual.at };
      for (const [index, phase] of phases.entries()) {
        const upstream = createTelemetryRecord({ at: times[index], kind, session: `coverage-${name}-${channel}`, payload: { source: `${OBSERVATION_BOUNDARY_PREFIX}test-session:${name}:${channel}`, availability: "available", phase, sequence: sequences[index], ...highWater } });
        await appendTelemetryRecord(root, upstream);
      }
    }
    const sealed = await sealObservationDay(root, { at: "2026-09-11T00:00:01.000Z" });
    assert.equal(sealed.ok, false, name);
    assert.deepEqual(sealed.invalidChannels, ["retrieval", "reference", "trigger", "verify"], name);
    assert.equal((await readTelemetryObservationWindow(root, "2026-09-11T12:00:00.000Z", 1)).complete, false, name);
  }
});

// TCRN-CROSS-STORY-452 (SUB-224): the read side of the collector self-check. Every
// reading below is taken from one UTC day file; the self-checks carry the source of the
// channel's own write path, which is the only place a self-check may come from.
const SELF_CHECK_DAY = "2026-09-12";

function selfCheck({ channel, verdict = "ok", reasonCode = null, source, host = "claude", at = `${SELF_CHECK_DAY}T08:00:00.000Z`, session = "self-check-session" }) {
  return createTelemetryRecord({
    at,
    kind: "collector-self-check",
    session,
    payload: { source: source ?? telemetryCore.COLLECTOR_SELF_CHECK_SOURCES?.[channel]?.[0], channel, host, verdict, reasonCode, availability: "available" },
  });
}

function channelReading(read, channel) {
  return read.channels.find((entry) => entry.channel === channel);
}

test("STORY-452 AC1-AC3: a channel day reads as records, an observed zero, broken with its reason, or unknown", async (t) => {
  const root = await scratch("tcrn-telemetry-self-check-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendTelemetryRecord(root, createTelemetryRecord({ at: `${SELF_CHECK_DAY}T09:00:00.000Z`, kind: "retrieval-hit", session: "real", payload: { source: "knowledge-inject:retrieval", availability: "available", candidateCount: 0 } }));
  await appendTelemetryRecord(root, selfCheck({ channel: "retrieval" }));
  await appendTelemetryRecord(root, selfCheck({ channel: "reference" }));
  await appendTelemetryRecord(root, selfCheck({ channel: "trigger", verdict: "failed", reasonCode: "RECALL_UNAVAILABLE" }));
  const read = await telemetryCore.readObservationChannelDays(root, SELF_CHECK_DAY);
  assert.deepEqual(read.channels.map((entry) => entry.channel), OBSERVATION_CHANNELS);
  assert.deepEqual(channelReading(read, "retrieval"), { channel: "retrieval", day: SELF_CHECK_DAY, reading: "records", availability: "available", count: 1, selfChecks: { ok: 1, failed: 0 }, reasonCodes: [] });
  assert.deepEqual(channelReading(read, "reference"), { channel: "reference", day: SELF_CHECK_DAY, reading: "observed-zero", availability: "available", count: 0, selfChecks: { ok: 1, failed: 0 }, reasonCodes: [] },
    "an ok self-check with no real record is an observed zero");
  assert.deepEqual(channelReading(read, "trigger"), { channel: "trigger", day: SELF_CHECK_DAY, reading: "broken", availability: "unavailable", count: null, selfChecks: { ok: 0, failed: 1 }, reasonCodes: ["RECALL_UNAVAILABLE"] },
    "only failed self-checks: the channel is broken and says why");
  assert.deepEqual(channelReading(read, "verify"), { channel: "verify", day: SELF_CHECK_DAY, reading: "unknown", availability: "unknown", count: null, selfChecks: { ok: 0, failed: 0 }, reasonCodes: [] },
    "no self-check is unknown, never zero");
  assert.deepEqual(read.refusedSelfChecks, []);
  assert.deepEqual(read.problems, []);
});

test("STORY-452 AC5: a self-check from outside its channel's write path is refused, reported, and changes nothing", async (t) => {
  const root = await scratch("tcrn-telemetry-self-check-refused-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const wrongPath = selfCheck({ channel: "reference", source: "knowledge-inject:trigger" });
  const malformed = selfCheck({ channel: "verify", verdict: "maybe" });
  const reasonless = selfCheck({ channel: "retrieval", verdict: "failed", reasonCode: null });
  for (const record of [wrongPath, malformed, reasonless]) await appendTelemetryRecord(root, record);
  const read = await telemetryCore.readObservationChannelDays(root, SELF_CHECK_DAY);
  for (const channel of OBSERVATION_CHANNELS) assert.equal(channelReading(read, channel).reading, "unknown", channel);
  assert.deepEqual(read.refusedSelfChecks.map(({ id, reasonCode }) => [id, reasonCode]).sort(), [
    [wrongPath.id, "TELEMETRY_SELF_CHECK_SOURCE_INVALID"],
    [malformed.id, "TELEMETRY_SELF_CHECK_INVALID"],
    [reasonless.id, "TELEMETRY_SELF_CHECK_INVALID"],
  ].sort());
  // Each channel names only its own write path; the verify channel has two.
  assert.deepEqual(Object.keys(telemetryCore.COLLECTOR_SELF_CHECK_SOURCES).sort(), [...OBSERVATION_CHANNELS].sort());
  assert.deepEqual(telemetryCore.COLLECTOR_SELF_CHECK_SOURCES.verify, ["cli:gate-result", "final-gate-plan:batch-verify"]);
});

test("STORY-452 AC6 and R3: a day from before self-checks existed reads unknown, reading writes nothing, and a self-check is not a real record", async (t) => {
  const root = await scratch("tcrn-telemetry-self-check-history-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await checkpoints(root, "2026-09-10");
  const directory = join(root, "telemetry");
  const before = await readFile(join(directory, "2026-09-10.ndjson"), "utf8");
  const read = await telemetryCore.readObservationChannelDays(root, "2026-09-10");
  for (const channel of OBSERVATION_CHANNELS) assert.equal(channelReading(read, channel).reading, "records", channel);
  const empty = await telemetryCore.readObservationChannelDays(root, "2026-09-09");
  for (const channel of OBSERVATION_CHANNELS) assert.equal(channelReading(empty, channel).reading, "unknown", channel);
  assert.equal(await readFile(join(directory, "2026-09-10.ndjson"), "utf8"), before, "reading appends nothing");
  await assert.rejects(readFile(join(directory, "2026-09-09.ndjson"), "utf8"), { code: "ENOENT" }, "and backfills nothing");

  // R3: an ok self-check never stands in for the real record a v1 seal needs.
  const sealRoot = await scratch("tcrn-telemetry-self-check-seal-");
  t.after(() => rm(sealRoot, { recursive: true, force: true }));
  await unionCheckpoints(sealRoot, [["session-a", "2026-09-09T23:59:59.000Z", "2026-09-11T00:00:00.000Z"]]);
  const verifyActual = (await readTelemetryRecords(sealRoot, { kind: "verify", limit: 100 })).records.find((record) => record.payload.source === "union-actual:verify");
  assert.ok(verifyActual);
  const withoutVerify = await scratch("tcrn-telemetry-self-check-seal-noverify-");
  t.after(() => rm(withoutVerify, { recursive: true, force: true }));
  for (const record of (await readTelemetryRecords(sealRoot, { limit: Number.MAX_SAFE_INTEGER })).records) {
    if (record.id !== verifyActual.id) await appendTelemetryRecord(withoutVerify, record);
  }
  await appendTelemetryRecord(withoutVerify, selfCheck({ channel: "verify", at: "2026-09-10T10:00:00.000Z" }));
  const sealed = await sealObservationDay(withoutVerify, { at: "2026-09-11T00:00:01.000Z" });
  assert.equal(sealed.ok, false);
  assert.ok(sealed.invalidChannels.includes("verify"), JSON.stringify(sealed));
});
