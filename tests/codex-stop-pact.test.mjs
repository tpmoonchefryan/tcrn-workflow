// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_STOP_PACT_EXECUTION_VERSION,
  decideCodexStop,
  executeQualifiedBatch,
  executeCodexStop,
  hostStopResponse,
  normalizeCodexStopInput,
  qualifyBatch,
  qualifyCodexStopBatch,
} from "../tools/stop-pact/codex-executor.mjs";
import { executeProductionBatch } from "../scripts/operational-batch-entry.mjs";
import {
  buildPact,
  writePact,
} from "../tools/stop-pact/pact.mjs";
import {
  createStageCompletionAuthority,
  createStageCompletionStore,
  issueStageCompletionReceipt,
  queryStageCompletionReceipt,
  qualifyBatch as qualifyStageBatch,
  loadStageCompletionSource,
  sealStageCompletionStore,
  writeStageCompletionStoreReceipt,
} from "../scripts/final-gate-plan.mjs";

const NOW = "2026-08-07T12:00:00.000Z";

function pact(overrides = {}) {
  return {
    ...buildPact({
      scope: "finish the governed change",
      authorizedBy: "owner",
      now: "2026-08-07T00:00:00.000Z",
      boundSession: "codex-session",
    }),
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    schemaVersion: CODEX_STOP_PACT_EXECUTION_VERSION,
    sessionId: "codex-session",
    model: "gpt-5-codex",
    now: NOW,
    workedSinceLastBlock: true,
    ...overrides,
  };
}

test("Codex and Claude judge the same shared pact state, with no second status source", () => {
  const verdict = decideCodexStop(event(), pact());
  assert.equal(verdict.action, "block");
  assert.equal(verdict.reasonCode, "BLOCK_RUNNING");
  assert.equal(verdict.mode, "enforce");
  assert.equal(verdict.governingStatus, "running");

  const terminal = decideCodexStop(
    event({ model: "gpt-5-codex" }),
    pact({ status: "completed", active: false }),
  );
  assert.equal(terminal.action, "allow");
  assert.equal(terminal.reasonCode, "NO_ACTIVE_PACT");
});

test("missing or unidentifiable Codex facts fail toward allow", () => {
  const running = pact();
  assert.equal(decideCodexStop(null, running).action, "allow");
  assert.equal(decideCodexStop(event({ sessionId: "" }), running).reasonCode, "CODEX_STOP_CONTEXT_UNAVAILABLE");
  assert.equal(decideCodexStop(event({ workedSinceLastBlock: undefined }), running).reasonCode, "CODEX_STOP_CONTEXT_UNAVAILABLE");

  const unknown = decideCodexStop(event({ model: null }), running);
  assert.equal(unknown.action, "allow");
  assert.equal(unknown.reasonCode, "OBSERVE_WOULD_BLOCK");
  assert.equal(unknown.mode, "observe");
  assert.equal(unknown.modelKnown, false);
  assert.equal(decideCodexStop(event({ model: "unknown" }), running).mode, "observe");
  assert.equal(decideCodexStop(event({ model: "   " }), running).reasonCode, "CODEX_STOP_CONTEXT_UNAVAILABLE");
});

test("Codex work state, not model identity, decides the enforce branch", () => {
  const running = pact();
  const productive = decideCodexStop(event({ workedSinceLastBlock: true }), running);
  const stalled = decideCodexStop(event({ workedSinceLastBlock: false }), {
    ...running,
    runtime: { ...running.runtime, consecutiveBlocks: 3 },
  });
  assert.equal(productive.reasonCode, "BLOCK_RUNNING");
  assert.equal(stalled.reasonCode, "ESCALATION_RELEASE");
  assert.equal(decideCodexStop(event({ model: "gpt-5-codex" }), {
    ...running,
    status: "blocked",
    active: false,
  }).action, "allow");
});

test("the real Codex Stop payload is accepted without its own schema envelope", () => {
  const hostEvent = {
    hook_event_name: "Stop",
    session_id: "codex-session",
    model: "gpt-5-codex",
    stop_hook_active: false,
    tool_use_count: 9,
    now: NOW,
    cwd: "/workspace",
    last_assistant_message: "I should continue",
  };
  const normalized = normalizeCodexStopInput(hostEvent, pact());
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.sessionId, "codex-session");
  assert.equal(normalized.value.workedSinceLastBlock, true);
  const result = decideCodexStop(hostEvent, pact());
  assert.equal(result.action, "block");
  assert.equal(result.reasonCode, "BLOCK_RUNNING");
  const response = hostStopResponse(result);
  assert.deepEqual(Object.keys(response).sort(), ["decision", "reason"]);
  assert.equal(response.decision, "block");
  assert.ok(response.reason.length > 0);
});

test("Codex stop_hook_active is a loop guard and never emits another block", () => {
  const result = decideCodexStop({
    hook_event_name: "Stop",
    session_id: "codex-session",
    model: "gpt-5-codex",
    stop_hook_active: true,
    tool_use_count: 10,
    now: NOW,
  }, pact({ runtime: { consecutiveBlocks: 1, lastBlockToolUses: 9 } }));
  assert.equal(result.action, "allow");
  assert.equal(result.reasonCode, "STOP_HOOK_ACTIVE");
  assert.equal(hostStopResponse(result), null);
});

test("Codex terminal and expiry branches are explicit red-leg coverage", () => {
  const expired = decideCodexStop(event({ now: "2026-08-09T00:00:00.000Z" }), pact());
  assert.equal(expired.reasonCode, "PACT_EXPIRED");
  assert.equal(expired.action, "allow");

  const completed = decideCodexStop(event(), pact({ status: "completed", active: true }));
  assert.equal(completed.reasonCode, "STATUS_COMPLETED");
  assert.equal(completed.action, "allow");

  const ownerDirective = decideCodexStop(event(), pact({ status: "owner_directive", active: true }));
  assert.equal(ownerDirective.reasonCode, "STATUS_OWNER_DIRECTIVE");
  assert.equal(ownerDirective.action, "allow");

  const unknownModel = decideCodexStop(event({ model: "brand-new-model" }), pact());
  assert.equal(unknownModel.reasonCode, "OBSERVE_WOULD_BLOCK");
  assert.equal(unknownModel.mode, "observe");
  assert.equal(unknownModel.action, "allow");
});

test("executor updates the shared pact only for the owning Codex session", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-stop-pact-"));
  try {
    const path = join(dir, "current.json");
    writePact(pact({ boundSession: null }), path);
    const blocked = executeCodexStop(event({ toolUseCount: 9 }), { path });
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(blocked.reasonCode, "BLOCK_RUNNING");
    assert.equal(blocked.wrotePact, true);
    assert.equal(after.boundSession, "codex-session");
    assert.equal(after.runtime.consecutiveBlocks, 1);
    assert.equal(after.runtime.lastBlockToolUses, 9);

    const bystander = executeCodexStop(event({ sessionId: "other-session" }), { path });
    const unchanged = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(bystander.reasonCode, "OTHER_SESSION");
    assert.equal(bystander.wrotePact, false);
    assert.equal(unchanged.runtime.consecutiveBlocks, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default stdin bridge speaks only the host protocol; diagnostics are opt-in", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-stop-pact-cli-"));
  try {
    const path = join(dir, "missing.json");
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../tools/stop-pact/codex-executor.mjs", import.meta.url)),
    ], {
      input: JSON.stringify(event()),
      env: { ...process.env, TCRN_STOP_PACT_PATH: path },
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "", "an allow decision must not emit the internal envelope to Codex");

    const diagnostic = spawnSync(process.execPath, [
      fileURLToPath(new URL("../tools/stop-pact/codex-executor.mjs", import.meta.url)),
      "--diagnostic",
    ], {
      input: JSON.stringify(event()),
      env: { ...process.env, TCRN_STOP_PACT_PATH: path },
      encoding: "utf8",
    });
    assert.equal(diagnostic.status, 0);
    const output = JSON.parse(diagnostic.stdout);
    assert.equal(output.schemaVersion, CODEX_STOP_PACT_EXECUTION_VERSION);
    assert.equal(output.reasonCode, "NO_ACTIVE_PACT");
    assert.equal(output.action, "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real-host block is emitted as exactly the Codex decision object", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-stop-pact-host-"));
  try {
    const path = join(dir, "current.json");
    writePact(pact(), path);
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../tools/stop-pact/codex-executor.mjs", import.meta.url)),
    ], {
      input: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "codex-session",
        model: "gpt-5-codex",
        stop_hook_active: false,
        tool_use_count: 9,
        now: NOW,
        extra_host_field: "ignored",
      }),
      env: { ...process.env, TCRN_STOP_PACT_PATH: path },
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    const response = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(response).sort(), ["decision", "reason"]);
    assert.equal(response.decision, "block");
    assert.ok(response.reason.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("STORY-421: batch qualification uses real work state, keeps hooks light, and runs the formal entry once", async () => {
  const stable = {
    series: "EPIC135",
    pack: "HC2",
    stage: "candidate-final",
    tasks: [],
    candidate: { id: "candidate-421", status: "stable", digest: "tree-421" },
    queueDigest: "queue-421",
  };
  const pending = qualifyBatch({ ...stable, trigger: "formal-batch-gate", tasks: [{ id: "420", status: "active" }], candidateReady: true });
  assert.equal(pending.eligible, false);
  assert.equal(pending.reasonCode, "BATCH_WORK_REMAINING");
  assert.equal(pending.formalGateExecutions, 0);

  const callerReadyIsNotEnough = qualifyBatch({ ...stable, trigger: "formal-batch-gate", tasks: [{ id: "420", status: "ready" }], candidateReady: true });
  assert.equal(callerReadyIsNotEnough.formalGateAllowed, false);
  assert.equal(callerReadyIsNotEnough.reasonCode, "BATCH_WORK_REMAINING");

  const blocked = qualifyBatch({
    ...stable,
    trigger: "formal-batch-gate",
    tasks: [
      { id: "420", status: "blocked", blockedReason: "upstream evidence is unavailable" },
      { id: "post-release", status: "ready", stage: "publication", kind: "release", approved: true },
    ],
  });
  assert.equal(blocked.eligible, true);
  assert.equal(blocked.formalGateAllowed, true);
  assert.equal(blocked.postActions.length, 1);
  assert.deepEqual(blocked.remainingPrerequisites, []);

  const missingDependency = qualifyBatch({ ...stable, trigger: "formal-batch-gate", tasks: [{ id: "421", status: "done", dependencies: ["missing"] }] });
  assert.equal(missingDependency.reasonCode, "BATCH_DEPENDENCY_NOT_VERIFIABLE");
  assert.equal(missingDependency.formalGateExecutions, 0);

  const mismatched = qualifyBatch({ ...stable, trigger: "formal-batch-gate", expectedBinding: { series: "EPIC135", pack: "HC2", stage: "candidate-final" }, currentBinding: { series: "EPIC135", pack: "HC1", stage: "candidate-final" } });
  assert.equal(mismatched.reasonCode, "BATCH_BINDING_MISMATCH");
  assert.equal(mismatched.formalGateAllowed, false);

  const hookInput = { batch: { ...stable, tasks: [{ id: "421", status: "active" }] } };
  const hookQualification = qualifyCodexStopBatch(hookInput, pact());
  assert.equal(hookQualification.reasonCode, "BATCH_WORK_REMAINING");
  assert.equal(hookQualification.formalGateExecutions, 0);

  let runs = 0;
  const completed = await executeQualifiedBatch({ ...stable, trigger: "formal-batch-gate" }, async () => { runs += 1; return { ok: true, id: "formal-root" }; });
  assert.equal(runs, 1);
  assert.equal(completed.reasonCode, "BATCH_FORMAL_GATE_COMPLETED");
  assert.equal(completed.formalGateExecutions, 1);
  const duplicate = await executeQualifiedBatch({ qualification: completed }, async () => { runs += 1; return { ok: true }; });
  assert.equal(runs, 1);
  assert.equal(duplicate.formalGateExecutions, 0);

  const prior = qualifyBatch({ ...stable, trigger: "formal-batch-gate", previousRuns: [{ idempotencyKey: "EPIC135|HC2|candidate-final|tree-421|queue-421", status: "completed" }] });
  assert.equal(prior.reasonCode, "BATCH_ALREADY_COMPLETED");
  assert.equal(prior.formalGateExecutions, 0);
  const concurrent = qualifyBatch({ ...stable, trigger: "formal-batch-gate", previousRuns: [{ idempotencyKey: "EPIC135|HC2|candidate-final|tree-421|queue-421", status: "running" }] });
  assert.equal(concurrent.reasonCode, "BATCH_ALREADY_RUNNING");
  assert.equal(concurrent.formalGateAllowed, false);
});

test("EPIC135 closeout: active Stories need code-owned implementation completion receipts", () => {
  const binding = { series: "EPIC135", pack: "HC1-HC3-final-machine-closeout", stage: "candidate-final" };
  const workspace = "workspace:qualifier";
  const candidate = { id: "candidate-final", digest: "tree-final" };
  const queueDigest = "queue-final";
  const tasks = [
    { id: "work:418", status: "active", revision: 3, scopeDigest: "scope-418", dependencies: [] },
    { id: "work:420", status: "active", revision: 3, scopeDigest: "scope-420", dependencies: ["work:418"] },
  ];
  const authority = createStageCompletionAuthority();
  const receipts = tasks.map((task) => issueStageCompletionReceipt(authority, {
    ...binding,
    workId: task.id,
    revision: task.revision,
    scopeDigest: task.scopeDigest,
    workspace,
    candidate,
    queueDigest,
    agent: "agent:luna",
  }));
  const runtimeObserver = {
    observedAt: NOW,
    source: "test-code-owned-observer",
    queue: { observed: true, digest: queueDigest, records: tasks },
    dependencies: { observed: true, digest: "dependency-final", records: tasks.map(({ id, dependencies }) => ({ id, dependencies })) },
    agents: { observed: true, digest: "agents-final", records: [] },
    writes: { observed: true, digest: "writes-final", records: [] },
    candidate: { observed: true, stable: true, id: candidate.id, digest: candidate.digest, records: [] },
  };
  const input = { ...binding, workspace, expectedBinding: binding, currentBinding: binding, trigger: "formal-batch-gate", tasks, candidate, queueDigest, currentQueueDigest: queueDigest, runtimeObserver, observationFresh: true, operational: true, requireRuntimeObservation: true, stageCompletionAuthority: authority, stageCompletionReceipts: receipts };
  const eligible = qualifyStageBatch(input);
  assert.equal(eligible.status, "eligible");
  assert.equal(eligible.eligible, true);
  assert.deepEqual(eligible.remainingPrerequisites, []);
  assert.ok(eligible.tasks.every(({ implementationComplete }) => implementationComplete === true));

  const withoutReceipts = qualifyStageBatch({ ...input, stageCompletionReceipts: [] });
  assert.equal(withoutReceipts.eligible, false);
  assert.equal(withoutReceipts.reasonCode, "BATCH_WORK_REMAINING");
  const forged = structuredClone(receipts[0]);
  forged.agent = "agent:caller";
  const forgedResult = qualifyStageBatch({ ...input, stageCompletionReceipts: [forged, receipts[1]] });
  assert.equal(forgedResult.eligible, false);
  assert.equal(forgedResult.reasonCode, "BATCH_IMPLEMENTATION_RECEIPT_NOT_VERIFIABLE");

  const wrongWorkspaceAuthority = createStageCompletionAuthority();
  const wrongWorkspaceReceipts = tasks.map((task) => issueStageCompletionReceipt(wrongWorkspaceAuthority, {
    ...binding,
    workId: task.id,
    revision: task.revision,
    scopeDigest: task.scopeDigest,
    workspace: "workspace:wrong",
    candidate,
    queueDigest,
    agent: "agent:luna",
  }));
  const wrongWorkspace = qualifyStageBatch({ ...input, stageCompletionAuthority: wrongWorkspaceAuthority, stageCompletionReceipts: wrongWorkspaceReceipts });
  assert.equal(wrongWorkspace.eligible, false);
  assert.equal(wrongWorkspace.reasonCode, "BATCH_IMPLEMENTATION_RECEIPT_NOT_VERIFIABLE");
  assert.ok(wrongWorkspace.tasks.every(({ implementationComplete }) => implementationComplete === false));

  const missingWorkspaceAuthority = createStageCompletionAuthority();
  const missingWorkspaceReceipts = tasks.map((task) => issueStageCompletionReceipt(missingWorkspaceAuthority, {
    ...binding,
    workId: task.id,
    revision: task.revision,
    scopeDigest: task.scopeDigest,
    candidate,
    queueDigest,
    agent: "agent:luna",
  }));
  const missingWorkspace = qualifyStageBatch({ ...input, stageCompletionAuthority: missingWorkspaceAuthority, stageCompletionReceipts: missingWorkspaceReceipts });
  assert.equal(missingWorkspace.eligible, false);
  assert.equal(missingWorkspace.reasonCode, "BATCH_IMPLEMENTATION_RECEIPT_NOT_VERIFIABLE");
  assert.ok(missingWorkspace.tasks.every(({ implementationComplete }) => implementationComplete === false));
});

test("EPIC135 R2: the operator bridge loads only a sealed code-owned completion source", () => {
  const binding = { series: "EPIC135", pack: "HC1-HC3-final-machine-closeout", stage: "candidate-final" };
  const candidate = { id: "candidate-final", digest: "tree-final" };
  const store = createStageCompletionStore();
  const input = { ...binding, workId: "work:418", revision: 3, scopeDigest: "scope-418", candidate, queueDigest: "queue-final", agent: "agent:luna" };
  const written = writeStageCompletionStoreReceipt(store, input);
  const sealed = sealStageCompletionStore(store);
  const loaded = loadStageCompletionSource(sealed.manifestPath);
  assert.equal(loaded.status, "loaded");
  assert.equal(loaded.receipts.length, 1);
  assert.equal(loaded.receipts[0].receiptDigest, written.receipt.receiptDigest);
  assert.match(loaded.source.lifecycle, /authority-query-valid-for-process-lifetime/u);
  assert.throws(() => loadStageCompletionSource(JSON.stringify(loaded)), (error) => error.reasonCode === "STAGE_COMPLETION_SOURCE_NOT_VERIFIABLE");
});

test("EPIC135 production entry binds admission and native reads to the effective workspace", async () => {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const chainContainer = [".tcrn", "workspace"].join("-");
  const defaultWorkspace = resolve(repositoryRoot, "../..", chainContainer, "cross-project/workspace");
  const binding = { series: "EPIC135", pack: "HC1-HC3-final-machine-closeout", stage: "candidate-final" };
  const root = mkdtempSync(join(tmpdir(), "workspace-binding-entry-"));
  const source = (sourceWorkspace, candidateId) => {
    const options = { root: join(root, candidateId), binding };
    if (sourceWorkspace !== undefined) options.workspace = sourceWorkspace;
    const store = createStageCompletionStore(options);
    const receiptInput = { ...binding, workId: "work:418", revision: 3, scopeDigest: "scope-418", candidate: { id: candidateId, digest: "tree-binding" }, queueDigest: "queue-binding", agent: "agent:luna" };
    if (sourceWorkspace !== undefined) receiptInput.workspace = sourceWorkspace;
    writeStageCompletionStoreReceipt(store, receiptInput);
    return sealStageCompletionStore(store).manifestPath;
  };
  try {
    const validSource = source(defaultWorkspace, "candidate-valid");
    const loader = `import {loadStageCompletionSource} from ${JSON.stringify(fileURLToPath(new URL("../scripts/final-gate-plan.mjs", import.meta.url)))};const result=loadStageCompletionSource(process.argv[1],JSON.parse(process.argv[2]));console.log(JSON.stringify({status:result.status,workspace:result.source.binding.workspace}));`;
    for (const options of [{}, { workspace: defaultWorkspace }]) {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", loader, validSource, JSON.stringify(options)], { encoding: "utf8" });
      assert.equal(child.status, 0);
      assert.deepEqual(JSON.parse(child.stdout), { status: "loaded", workspace: defaultWorkspace });
    }
    for (const workspaceOption of [undefined, null, defaultWorkspace]) {
      const request = { ...binding, stageCompletionSource: validSource, securityVeto: true };
      if (workspaceOption !== undefined) request.workspace = workspaceOption;
      const result = await executeProductionBatch(request);
      assert.equal(result.reasonCode, "BATCH_SECURITY_VETO");
      assert.equal(result.operatorBridge.status, "loaded");
    }

    for (const invalidSource of [source("workspace:wrong", "candidate-wrong"), source(undefined, "candidate-missing")]) {
      for (const workspaceOption of [undefined, null, defaultWorkspace]) {
        const request = { ...binding, stageCompletionSource: invalidSource, securityVeto: true };
        if (workspaceOption !== undefined) request.workspace = workspaceOption;
        const result = await executeProductionBatch(request);
        assert.equal(result.reasonCode, "STAGE_COMPLETION_SOURCE_NOT_VERIFIABLE");
        assert.equal(result.operatorBridge.status, "not-verifiable");
        assert.match(result.operatorBridge.reason, /workspace binding differs/u);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EPIC135 R2: sealed source admission is independent, binding-aware, and cross-process", () => {
  const canonical = (value) => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const jsonBytes = (value) => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, "utf8");
  const root = mkdtempSync(join(tmpdir(), "stage-completion-admission-test-"));
  try {
    const workspace = "workspace:admitted";
    const binding = { series: "EPIC135", pack: "HC1-HC3-final-machine-closeout", stage: "candidate-final" };
    const candidate = { id: "candidate-admitted", digest: "tree-admitted" };
    const store = createStageCompletionStore({ root: join(root, "admitted"), workspace, binding });
    const input = { ...binding, workspace, workId: "work:418", revision: 3, scopeDigest: "scope-418", candidate, queueDigest: "queue-admitted", agent: "agent:luna" };
    const written = writeStageCompletionStoreReceipt(store, input);
    const sealed = sealStageCompletionStore(store);
    const loaded = loadStageCompletionSource(sealed.manifestPath, { workspace, expectedBinding: binding, candidate, workIds: [input.workId], workBindings: [{ workId: input.workId, revision: input.revision, scopeDigest: input.scopeDigest }] });
    assert.equal(loaded.status, "loaded");
    assert.equal(loaded.admission.manifestDigest, sealed.manifestDigest);
    assert.equal(loaded.admission.receiptSetDigest, sealed.receiptSetDigest);
    assert.equal(queryStageCompletionReceipt(loaded.authority, loaded.receipts[0]).receiptDigest, written.receipt.receiptDigest);
    assert.doesNotThrow(() => loadStageCompletionSource(sealed.manifestPath, { expectedDigest: "caller-is-not-an-authority" }));

    const copiedRoot = join(root, "copied");
    cpSync(store.storeRoot, copiedRoot, { recursive: true });
    chmodSync(copiedRoot, 0o700);
    chmodSync(join(copiedRoot, "receipts"), 0o700);
    chmodSync(join(copiedRoot, "manifest.json"), 0o600);
    chmodSync(join(copiedRoot, "receipts", `${written.receipt.receiptDigest}.json`), 0o600);
    const copied = loadStageCompletionSource(join(copiedRoot, "manifest.json"), { workspace, expectedBinding: binding, candidate });
    assert.equal(copied.receipts[0].receiptDigest, written.receipt.receiptDigest);

    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {loadStageCompletionSource} from ${JSON.stringify(fileURLToPath(new URL("../scripts/final-gate-plan.mjs", import.meta.url)))};const r=loadStageCompletionSource(process.argv[1],{workspace:process.argv[2]});console.log(JSON.stringify({status:r.status,admissionDigest:r.source.admissionDigest,query:r.receipts.length}));`, sealed.manifestPath, workspace], { encoding: "utf8" });
    assert.equal(child.status, 0);
    assert.deepEqual(JSON.parse(child.stdout), { status: "loaded", admissionDigest: sealed.admissionDigest, query: 1 });

    assert.throws(() => loadStageCompletionSource(sealed.manifestPath, { workspace: "workspace:wrong" }), (error) => error.reasonCode === "STAGE_COMPLETION_SOURCE_NOT_VERIFIABLE");
    assert.throws(() => loadStageCompletionSource(sealed.manifestPath, { workBindings: [{ workId: input.workId, revision: input.revision, scopeDigest: "scope-wrong" }] }), (error) => error.reasonCode === "STAGE_COMPLETION_SOURCE_NOT_VERIFIABLE");
    assert.throws(() => loadStageCompletionSource(sealed.manifestPath, { candidate: { id: candidate.id, digest: "tree-wrong" } }), (error) => error.reasonCode === "STAGE_COMPLETION_SOURCE_NOT_VERIFIABLE");

    // This source is fully re-sealed with owner-only modes and fresh hashes,
    // but no issuer API is called and therefore no admission anchor exists.
    const forgedRoot = join(root, "never-issued");
    mkdirSync(join(forgedRoot, "receipts"), { recursive: true, mode: 0o700 });
    const forgedReceipt = structuredClone(loaded.receipts[0]);
    forgedReceipt.candidate = { id: "candidate-never-issued", digest: digest(Buffer.from("never-issued-candidate")) };
    delete forgedReceipt.receiptDigest;
    forgedReceipt.receiptDigest = digest(Buffer.from(JSON.stringify(canonical(forgedReceipt)), "utf8"));
    const forgedReceiptBytes = jsonBytes(forgedReceipt);
    const forgedReceiptRelative = `receipts/${forgedReceipt.receiptDigest}.json`;
    writeFileSync(join(forgedRoot, forgedReceiptRelative), forgedReceiptBytes, { mode: 0o600 });
    const originalManifest = JSON.parse(readFileSync(sealed.manifestPath, "utf8"));
    const forgedManifest = { ...originalManifest, receipts: [{ path: forgedReceiptRelative, bytes: forgedReceiptBytes.length, sha256: digest(forgedReceiptBytes), receiptDigest: forgedReceipt.receiptDigest }], receiptCount: 1 };
    delete forgedManifest.manifestDigest;
    forgedManifest.manifestDigest = digest(Buffer.from(JSON.stringify(canonical(forgedManifest)), "utf8"));
    const forgedPath = join(forgedRoot, "manifest.json");
    writeFileSync(forgedPath, jsonBytes(forgedManifest), { mode: 0o600 });
    assert.throws(() => loadStageCompletionSource(forgedPath), (error) => error.reasonCode === "STAGE_COMPLETION_SOURCE_NOT_VERIFIABLE");
    const forgedChild = spawnSync(process.execPath, ["--input-type=module", "-e", `import {loadStageCompletionSource} from ${JSON.stringify(fileURLToPath(new URL("../scripts/final-gate-plan.mjs", import.meta.url)))};try{loadStageCompletionSource(process.argv[1]);process.exitCode=2}catch(error){console.log(JSON.stringify({reasonCode:error.reasonCode}));process.exitCode=1}`, forgedPath], { encoding: "utf8" });
    assert.equal(forgedChild.status, 1);
    assert.deepEqual(JSON.parse(forgedChild.stdout), { reasonCode: "STAGE_COMPLETION_SOURCE_NOT_VERIFIABLE" });

    // Reusing an old admission cannot authorize a changed manifest, and
    // deleting the real admission anchor closes the previously valid source.
    unlinkSync(sealed.admissionPath);
    assert.throws(() => loadStageCompletionSource(sealed.manifestPath), (error) => error.reasonCode === "STAGE_COMPLETION_SOURCE_NOT_VERIFIABLE");
    assert.throws(() => loadStageCompletionSource(forgedPath), (error) => error.reasonCode === "STAGE_COMPLETION_SOURCE_NOT_VERIFIABLE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EPIC135 R2: unknown repository work in the observer side table blocks qualification", () => {
  const input = {
    series: "EPIC135", pack: "HC2", stage: "candidate-final", expectedBinding: { series: "EPIC135", pack: "HC2", stage: "candidate-final" },
    currentBinding: { series: "EPIC135", pack: "HC2", stage: "candidate-final" }, candidate: { id: "candidate", digest: "tree" }, queueDigest: "queue", currentQueueDigest: "queue", trigger: "formal-batch-gate",
    tasks: [],
    runtimeObserver: {
      queue: { observed: true, digest: "queue", records: [] }, dependencies: { observed: true, records: [] },
      agents: { observed: true, records: [], unknown: [{ pid: 321, state: "R", scope: "unknown", role: "unknown-repository-process", command: "node scripts/generate-proof-artifacts.mjs" }] },
      writes: { observed: true, records: [] }, candidate: { observed: true, stable: true, id: "candidate", digest: "tree", records: [] },
    }, operational: true, observationFresh: true, requireRuntimeObservation: true,
  };
  const result = qualifyStageBatch(input);
  assert.equal(result.eligible, false);
  assert.equal(result.reasonCode, "BATCH_UNKNOWN_REPOSITORY_PROCESS");
});
