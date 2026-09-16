// SPDX-License-Identifier: Apache-2.0
// Native dispatch coverage.  The host call is the boundary: model/effort come
// from a fresh engine resolution, while missing host role/provider fields stay
// explicit unknown observations.

import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_LIFECYCLE_SCHEMA_VERSION,
  buildNativeSpawnInput,
  validateAgentLifecycle,
  validateAgentLifecycleEvidence,
  validateDispatchInvocation,
  resolveDispatchRequest,
} from "../scripts/dispatch-adapter.mjs";

const WORKSPACE = resolve(fileURLToPath(new URL("../../../", import.meta.url)), [".tcrn", "workspace"].join("-"), "cross-project/workspace");
const ACTIVE_WORK = "work:1891880eb2925c9c777d1d22";

function lifecycle(overrides = {}) {
  return {
    schemaVersion: AGENT_LIFECYCLE_SCHEMA_VERSION,
    phase: "rework",
    role: "implementation",
    pack: "CHAIN-NATIVE",
    workId: ACTIVE_WORK,
    model: "gpt-5.6-luna",
    effort: "max",
    newInstance: true,
    forkTurns: "none",
    sameTaskRunning: false,
    ...overrides,
  };
}

test("native resolution reads the live dispatch settings and returns the configured model", async () => {
  const result = await resolveDispatchRequest({ workspace: WORKSPACE, host: "codex", taskClass: "implement" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.executable, true);
  assert.equal(result.resolution.value.model, "gpt-5.6-luna");
  assert.equal(result.resolution.value.effort, "max");
});

test("fresh lifecycle keeps the instance rule but does not require a host role/provider claim", () => {
  const result = validateAgentLifecycle(lifecycle());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.reasonCode, "DISPATCH_LIFECYCLE_VALID_EVIDENCE_UNKNOWN");
  assert.equal(result.sourceEvidence.status, "unknown");

  const observed = validateAgentLifecycleEvidence(lifecycle(), lifecycle());
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.equal(observed.status, "unknown");
  assert.deepEqual(observed.missing, ["native role/provider/turn context"]);
});

test("fork reuse, running predecessor, and prompt claims remain refusals", () => {
  assert.equal(validateAgentLifecycle(lifecycle({ forkTurns: "all" })).ok, false);
  assert.equal(validateAgentLifecycle(lifecycle({ predecessor: { agentId: "agent:old", status: "running" } })).ok, false);
  const claim = validateAgentLifecycle(lifecycle({ sourceEvidence: [{ kind: "prompt-claim", locator: "prompt" }] }));
  assert.equal(claim.ok, false);
});

test("native spawn input forwards only the engine model/effort and explicit lifecycle", async () => {
  const prepared = await resolveDispatchRequest({ workspace: WORKSPACE, host: "codex", taskClass: "implement" });
  const result = buildNativeSpawnInput(prepared, lifecycle());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.spawn, { model: "gpt-5.6-luna", effort: "max" });
  assert.equal(result.lifecycle.workId, ACTIVE_WORK);
});

test("invocation validation rereads relevant work/config and ignores unrelated head fields", async () => {
  const prepared = await resolveDispatchRequest({ workspace: WORKSPACE, host: "codex", taskClass: "implement" });
  const staleHeadProjection = structuredClone(prepared);
  staleHeadProjection.source.version = 1;
  staleHeadProjection.source.headEventHash = "0".repeat(64);
  const result = await validateDispatchInvocation({
    prepared: staleHeadProjection,
    invocation: { model: "gpt-5.6-luna", effort: "max", workId: ACTIVE_WORK },
    lifecycle: lifecycle(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.observations.status, "unknown");
});

test("wrong work, scope, model, or effort still refuses the native call", async () => {
  const prepared = await resolveDispatchRequest({ workspace: WORKSPACE, host: "codex", taskClass: "implement" });
  const base = { prepared, invocation: { model: "gpt-5.6-luna", effort: "max", workId: ACTIVE_WORK }, lifecycle: lifecycle() };
  assert.equal((await validateDispatchInvocation({ ...base, invocation: { ...base.invocation, model: "wrong-model" } })).reasonCode, "DISPATCH_MODEL_MISMATCH");
  assert.equal((await validateDispatchInvocation({ ...base, invocation: { ...base.invocation, effort: "low" } })).reasonCode, "DISPATCH_EFFORT_MISMATCH");
  assert.equal((await validateDispatchInvocation({ ...base, invocation: { ...base.invocation, workId: "work:missing" }, workId: "work:missing", lifecycle: lifecycle({ workId: "work:missing" }) })).ok, false);
  assert.equal((await validateDispatchInvocation({ ...base, scopeDigest: "0".repeat(64) })).reasonCode, "DISPATCH_SCOPE_MISMATCH");
});

test("missing native model/effort facts are a refusal, not an inferred fallback", async () => {
  const prepared = await resolveDispatchRequest({ workspace: WORKSPACE, host: "codex", taskClass: "implement" });
  const result = await validateDispatchInvocation({ prepared, invocation: { workId: ACTIVE_WORK }, lifecycle: lifecycle() });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "DISPATCH_SPAWN_INPUT_MISSING");
});
