// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  activeBinding,
  annotateWork,
  createProject,
  createWork,
  initializeWorkspace,
  materializeWorkspace,
  readTelemetryRecords,
} from "../dist/build/packages/core/src/index.js";
import {
  acquireOperationalBatchInput,
  executeOperationalBatch,
  executeQualifiedBatch,
  qualifyBatch,
  readNativeBatchState,
} from "../scripts/final-gate-plan.mjs";
import * as finalGatePlan from "../scripts/final-gate-plan.mjs";

const createdAt = "2026-08-19T18:00:00Z";
const boundaryPrefix = "telemetry:observation-collector:";

async function workspace(key) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-batch-verify-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: key, createdAt, segmentEventLimit: 64 });
  return { base, root: join(base, "workspace") };
}

function batchInput(workspaceRoot) {
  return {
    ...(workspaceRoot === undefined ? {} : { workspace: workspaceRoot }),
    series: "EPIC135",
    pack: "CHAIN-NATIVE",
    stage: "candidate-final",
    tasks: [],
    candidate: { id: "candidate-421", status: "stable", digest: "tree-421" },
    queueDigest: "queue-421",
    trigger: "formal-batch-gate",
  };
}

async function nonBoundaryVerifyRecords(fixture) {
  const state = await materializeWorkspace(fixture.root);
  const transient = activeBinding(state.metadata).find((entry) => entry.kind === "transient");
  assert.ok(transient);
  const read = await readTelemetryRecords(transient.path, { kind: "verify", limit: Number.MAX_SAFE_INTEGER });
  return read.records.filter((record) => typeof record.payload?.source === "string" && !record.payload.source.startsWith(boundaryPrefix));
}

test("successful qualified batch writes one real verify telemetry record", async (context) => {
  const fixture = await workspace("batch-verify-pass");
  context.after(() => rm(fixture.base, { recursive: true, force: true }));

  const result = await executeQualifiedBatch(batchInput(fixture.root), async () => ({ ok: true }));

  assert.equal(result.status, "completed");
  const records = await nonBoundaryVerifyRecords(fixture);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "verify");
  assert.equal(records[0].payload.source.startsWith(boundaryPrefix), false);
  assert.equal(records[0].payload.source, "final-gate-plan:batch-verify");
  assert.equal(records[0].payload.availability, "available");
  assert.equal(records[0].payload.passed, true);
});

test("failed formal runner does not write verify telemetry", async (context) => {
  const fixture = await workspace("batch-verify-fail");
  context.after(() => rm(fixture.base, { recursive: true, force: true }));

  const result = await executeQualifiedBatch(batchInput(fixture.root), async () => ({ ok: false, reasonCode: "X" }));

  assert.equal(result.status, "failed");
  assert.equal(result.reasonCode, "X");
  assert.equal((await nonBoundaryVerifyRecords(fixture)).length, 0);
});

test("post-execution recheck failure does not write verify telemetry", async (context) => {
  const fixture = await workspace("batch-verify-recheck");
  context.after(() => rm(fixture.base, { recursive: true, force: true }));
  const input = batchInput(fixture.root);
  const qualified = qualifyBatch(input);
  let rechecks = 0;

  // This case pins the emitter after the post-execution recheck: moving the call
  // above that block would leave a verify record despite this invalidation.
  const result = await executeQualifiedBatch(input, async () => ({ ok: true }), {
    recheck: async () => {
      rechecks += 1;
      return rechecks === 1 ? qualified : { ...qualified, status: "not-ready", eligible: false, formalGateAllowed: false };
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reasonCode, "BATCH_RECHECK_NOT_ELIGIBLE");
  assert.equal((await nonBoundaryVerifyRecords(fixture)).length, 0);
});

test("missing or unusable workspace leaves the qualified batch result unchanged", async () => {
  const missing = await executeQualifiedBatch(batchInput(), async () => ({ ok: true }));
  assert.equal(missing.status, "completed");
  assert.equal(missing.reasonCode, "BATCH_FORMAL_GATE_COMPLETED");

  const nonexistent = await executeQualifiedBatch(
    batchInput(join(tmpdir(), `tcrn-batch-verify-missing-${process.pid}-${Date.now()}`)),
    async () => ({ ok: true }),
  );
  assert.equal(nonexistent.status, "completed");
  assert.equal(nonexistent.reasonCode, "BATCH_FORMAL_GATE_COMPLETED");
});

// TCRN-CROSS-MIN-225 D3 (TCRN-CROSS-SUB-257): the verify emitter has no collector self-check mode
// any more. A caller that still passes `selfCheck` (the v1.2.0 session boundary did) gets a named
// answer and nothing is written -- above all no passing verify record, which the formal path alone
// writes, unchanged.
test("MIN-225: the batch verify emitter has no self-check mode and a legacy self-check call writes nothing", async (context) => {
  const fixture = await workspace("batch-verify-no-self-check");
  context.after(() => rm(fixture.base, { recursive: true, force: true }));
  const state = await materializeWorkspace(fixture.root);
  const transient = activeBinding(state.metadata).find((entry) => entry.kind === "transient").path;
  for (const call of [
    { root: transient, sessionId: "legacy-self-check", selfCheck: { host: "claude" } },
    { workspace: fixture.root, sessionId: "legacy-self-check", selfCheck: { host: "codex" } },
  ]) {
    assert.deepEqual(await finalGatePlan.emitBatchVerifyTelemetry(call), { reasonCode: "TELEMETRY_SELF_CHECK_RETIRED", written: false });
  }
  assert.deepEqual((await readTelemetryRecords(transient, { limit: Number.MAX_SAFE_INTEGER })).records, [], "no self-check and no verify record");
  const result = await executeQualifiedBatch({ ...batchInput(fixture.root), sessionId: "formal-batch-session" }, async () => ({ ok: true }));
  assert.equal(result.status, "completed");
  assert.deepEqual((await readTelemetryRecords(transient, { limit: Number.MAX_SAFE_INTEGER })).records.map((record) => [record.kind, record.session, record.payload.source, record.payload.passed]), [["verify", "formal-batch-session", "final-gate-plan:batch-verify", true]], "the formal run still writes its one verify record, under its own session");
});

// TCRN-CROSS-STORY-460 R4 (SUB-239). The fixture below goes through the engine the way the
// formal entry does: a real isolated workspace, a Story whose native result is written with
// work-annotate, and readNativeBatchState reading status, work-list and work-show through
// the engine CLI. No task object is built by hand.
const BOUND_STORY_SCOPE = [
  "【Goal】为谁=正式批次入口；目的锚=STORY-460 R4；符合性判据=资格复核用 work-show 的 scope；判定人=本测试。",
  "【Requirements】现象与证据=问题清单 #241；修复项=readNativeBatchState 带上 advisory.scope。",
  "【Acceptance Criteria】GIVEN a bound Story with a valid native result WHEN the entry qualifies it THEN it is eligible。",
  "【Business Background】evidence=before this change only an all-blocked binding could qualify。",
  "【Preconditions】无——原因：the fixture initializes its own roots。",
  "【Assumptions】无——原因：no runtime setting is introduced。",
  "【Use Cases & Examples】无——原因：the assertions are the example。",
  "【Feature Toggle & Setting】无——原因：no toggle is added。",
  "【Permissions】the test is the actor on its own temporary workspace。",
  "【Implementation Notes】决策点及裁定状态=none。",
].join("\n");
const boundCandidate = Object.freeze({ id: "candidate-story-460", digest: "c".repeat(64) });
const boundAt = (index) => `2026-08-19T18:00:${String(10 + index).padStart(2, "0")}.000Z`;

async function boundStoryWorkspace(key, { resultScope = BOUND_STORY_SCOPE } = {}) {
  const fixture = await workspace(key);
  // The engine stores external keys upper-cased.
  const prefix = key.toUpperCase();
  const lease = await acquireWorkspaceLease(fixture.root, { now: boundAt(0) });
  try {
    let state = await createProject(fixture.root, lease, { expectedVersion: 0, occurredAt: boundAt(1), externalKey: `${prefix}-PROJECT`, name: "Batch entry" });
    const projectId = state.projects[0].id;
    state = await createWork(fixture.root, lease, { expectedVersion: state.version, occurredAt: boundAt(2), projectId, externalKey: `${prefix}-INITIATIVE`, kind: "Initiative", parentId: null, title: "Initiative" });
    const initiativeId = state.work.find((record) => record.externalKey === `${prefix}-INITIATIVE`).id;
    state = await createWork(fixture.root, lease, { expectedVersion: state.version, occurredAt: boundAt(3), projectId, externalKey: `${prefix}-EPIC`, kind: "Epic", parentId: initiativeId, title: "Epic" });
    const epicId = state.work.find((record) => record.externalKey === `${prefix}-EPIC`).id;
    state = await createWork(fixture.root, lease, { expectedVersion: state.version, occurredAt: boundAt(4), projectId, externalKey: `${prefix}-STORY-460`, kind: "Story", parentId: epicId, title: "Bound Story", status: "active", scope: BOUND_STORY_SCOPE });
    const story = state.work.find((record) => record.externalKey === `${prefix}-STORY-460`);
    const evidence = join(fixture.base, "native-result-evidence.json");
    await writeFile(evidence, JSON.stringify({ workId: story.id }));
    await annotateWork(fixture.root, lease, {
      expectedVersion: state.version,
      occurredAt: boundAt(5),
      id: story.id,
      result: {
        schemaVersion: "tcrn.native-implementation-result.v1",
        status: "passed",
        ok: true,
        exitCode: 0,
        command: "node --test tests/final-gate-plan-batch-verify.test.mjs",
        dependencies: [],
        evidence,
        // The annotation that carries the result is the revision it is bound to.
        revision: story.revision + 1,
        scopeDigest: createHash("sha256").update(resultScope).digest("hex"),
        workId: story.id,
        candidateId: boundCandidate.id,
        candidateDigest: boundCandidate.digest,
      },
    });
    return { ...fixture, storyId: story.id };
  } finally {
    await lease.release();
  }
}

function boundBatchInput(fixture) {
  return {
    workspace: fixture.root,
    workIds: [fixture.storyId],
    series: "INIT-052",
    pack: "STORY-460",
    stage: "candidate-final",
    trigger: "formal-batch-gate",
    candidate: { ...boundCandidate, status: "stable" },
  };
}

// The host process table and the engine checkout are not facts this test can pin, so the
// runtime observer is a code-owned stand-in. The queue it reports is the native snapshot
// readNativeBatchState returned, which is what the production observer reports as well.
async function observeIsolatedRuntime({ nativeState }) {
  return {
    observedAt: boundAt(6),
    source: "story-460-isolated-observer",
    queue: { observed: true, digest: nativeState.queueDigest, records: nativeState.queue.records },
    dependencies: { observed: true, digest: "dependencies-story-460", records: nativeState.dependencies.records },
    agents: { observed: true, digest: "agents-story-460", records: [] },
    writes: { observed: true, digest: "writes-story-460", records: [] },
    candidate: { observed: true, stable: true, id: boundCandidate.id, digest: boundCandidate.digest, records: [] },
  };
}

async function entryQualification(input) {
  const acquired = await acquireOperationalBatchInput(input, { observeRuntime: observeIsolatedRuntime });
  assert.notEqual(acquired.ok, false, JSON.stringify(acquired));
  return qualifyBatch({ ...acquired, operational: true, runtimeObserver: acquired.runtimeObserver, requireRuntimeObservation: true, trigger: "formal-batch-gate" });
}

// Red leg (AC6): build the tasks in readNativeBatchState without the work-show scope again.
// The native result then re-normalizes against a null scope and the Story is refused with
// "native stable scope text is missing", which is issue #241 as the entry saw it.
test("STORY-460 R4 SUB-239: a non-blocked bound Story with a valid native result qualifies through readNativeBatchState", async (context) => {
  const fixture = await boundStoryWorkspace("batch-verify-bound-story");
  context.after(() => rm(fixture.base, { recursive: true, force: true }));

  const native = await readNativeBatchState({ workspace: fixture.root, workIds: [fixture.storyId], series: "INIT-052", pack: "STORY-460", stage: "candidate-final" });
  assert.equal(native.ok, true, JSON.stringify(native));
  assert.equal(native.tasks.length, 1);
  assert.equal(native.tasks[0].status, "active", "the bound Story is not blocked");
  assert.equal(native.tasks[0].scope, BOUND_STORY_SCOPE, "the task carries the scope work-show returned");
  assert.equal(native.tasks[0].implementationRecorded, true, native.tasks[0].implementationResultReason);

  const qualification = await entryQualification(boundBatchInput(fixture));
  assert.equal(qualification.reasonCode, "BATCH_FORMAL_GATE_ELIGIBLE", JSON.stringify(qualification.reasons));
  assert.equal(qualification.eligible, true);
  assert.equal(qualification.formalGateAllowed, true);
  assert.equal(qualification.tasks[0].implementationRecorded, true);
});

test("STORY-460 R4 SUB-239: a native result bound to other scope text is still refused after the scope is carried", async (context) => {
  const fixture = await boundStoryWorkspace("batch-verify-other-scope", { resultScope: `${BOUND_STORY_SCOPE}\n(edited)` });
  context.after(() => rm(fixture.base, { recursive: true, force: true }));

  const qualification = await entryQualification(boundBatchInput(fixture));
  assert.equal(qualification.reasonCode, "BATCH_IMPLEMENTATION_RESULT_NOT_VERIFIABLE");
  assert.equal(qualification.eligible, false);
  assert.match(qualification.reasons.join("; "), /result scope digest differs from the native scope/u);
  assert.doesNotMatch(qualification.reasons.join("; "), /native stable scope text is missing/u);
});

// AC5. The roster root stand-in is always green, so the only thing between the entry and
// the verify record is the qualification above. Red leg: the R4 revert keeps the entry at
// BATCH_IMPLEMENTATION_RESULT_NOT_VERIFIABLE, the stand-in never runs, and nothing is written.
test("STORY-460 AC5 SUB-239: the operational entry with an always-green roster root stand-in writes one batch verify record", async (context) => {
  const fixture = await boundStoryWorkspace("batch-verify-entry");
  context.after(() => rm(fixture.base, { recursive: true, force: true }));
  const handed = [];
  const alwaysGreenRosterRoot = async (qualification) => {
    handed.push(qualification);
    return { ok: true, status: "completed", executed: [] };
  };

  const result = await executeOperationalBatch(boundBatchInput(fixture), alwaysGreenRosterRoot, { observeRuntime: observeIsolatedRuntime });

  assert.equal(result.status, "completed", JSON.stringify(result.reasons));
  assert.equal(result.reasonCode, "BATCH_FORMAL_GATE_COMPLETED");
  assert.equal(handed.length, 1, "the stand-in runs exactly once");
  assert.equal(handed[0].reasonCode, "BATCH_FORMAL_GATE_ELIGIBLE");
  const records = await nonBoundaryVerifyRecords(fixture);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "verify");
  assert.equal(records[0].payload.source, "final-gate-plan:batch-verify");
  assert.equal(records[0].payload.passed, true);
});
