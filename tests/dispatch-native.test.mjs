// SPDX-License-Identifier: Apache-2.0
// Native dispatch coverage.  The host call is the boundary: model/effort come
// from a fresh engine resolution, while missing host role/provider fields stay
// explicit unknown observations.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeWorkspace } from "../dist/build/packages/core/src/index.js";
import {
  AGENT_LIFECYCLE_SCHEMA_VERSION,
  buildNativeSpawnInput,
  validateAgentLifecycle,
  validateAgentLifecycleEvidence,
  validateDispatchInvocation,
  resolveDispatchRequest,
} from "../scripts/dispatch-adapter.mjs";

const WORKSPACE = resolve(fileURLToPath(new URL("../../../", import.meta.url)), [".tcrn", "workspace"].join("-"), "cross-project/workspace");
const CLI_SCRIPT = fileURLToPath(new URL("../scripts/dispatch-adapter.mjs", import.meta.url));
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

// The host-scoped lifecycle cases judge the adapter's own branch, so they build a scratch
// workspace (both hosts' economy tier plus one active work item) instead of reading live settings.
async function hostFixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-dispatch-native-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const at = (second) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString().replace(/\.\d+Z$/u, "Z");
  await initializeWorkspace({ roots, externalKey: "FIXTURE-DISPATCH-NATIVE", createdAt: at(0) });
  const workspace = join(base, "workspace");
  const run = async (args) => {
    let output = "";
    await runCli([...args, "--actor", "agent:test"], { write: (value) => { output += value; } });
    return JSON.parse(output);
  };
  await run(["dispatch-tiers-set", "--workspace", workspace, "--expected-version", "0", "--at", at(1), "--host", "claude-code", "--tiers", JSON.stringify({ economy: { model: "claude-fixture-model", effort: "max" } })]);
  await run(["dispatch-tiers-set", "--workspace", workspace, "--expected-version", "1", "--at", at(2), "--host", "codex", "--tiers", JSON.stringify({ economy: { model: "gpt-5.6-luna", effort: "max" } })]);
  const project = await run(["project-create", "--workspace", workspace, "--expected-version", "2", "--at", at(3), "--external-key", "FIXTURE-PROJECT", "--name", "Fixture"]);
  const work = await run(["work-create", "--workspace", workspace, "--expected-version", "3", "--at", at(4), "--project-id", project.record.id, "--external-key", "FIXTURE-WORK", "--kind", "Initiative", "--status", "active", "--scope", "fixture scope", "--title", "Fixture work"]);
  return { workspace, workId: work.record.id };
}

test("native resolution reads the live dispatch settings and returns the configured model", async () => {
  const result = await resolveDispatchRequest({ workspace: WORKSPACE, host: "codex", taskClass: "implement" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.executable, true);
  assert.equal(result.resolution.value.model, "gpt-5.6-luna");
  assert.equal(result.resolution.value.effort, "max");
});

test("the actual CLI success entry emits parseable JSON with one real newline", () => {
  const result = spawnSync(process.execPath, [CLI_SCRIPT, "--workspace", WORKSPACE, "--host", "codex", "--class", "implement"], {
    cwd: resolve(CLI_SCRIPT, "../.."),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined, String(result.error ?? ""));
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\\n"), false);
  assert.equal(result.stdout.endsWith("\n"), true);
  const payload = JSON.parse(result.stdout);
  assert.equal(result.stdout, `${JSON.stringify(payload)}\n`);
  assert.equal(payload.ok, true);
  assert.equal(payload.reasonCode, "DISPATCH_RESOLUTION_READY");
});

test("the actual CLI error entry emits parseable JSON with one real newline", () => {
  const result = spawnSync(process.execPath, [CLI_SCRIPT, "--workspace", WORKSPACE, "--host", "not-a-host", "--class", "implement"], {
    cwd: resolve(CLI_SCRIPT, "../.."),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.error, undefined, String(result.error ?? ""));
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\\n"), false);
  assert.equal(result.stdout.endsWith("\n"), true);
  const payload = JSON.parse(result.stdout);
  assert.equal(result.stdout, `${JSON.stringify(payload)}\n`);
  assert.equal(payload.ok, false);
  assert.equal(payload.reasonCode, "DISPATCH_HOST_UNSUPPORTED");
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

test("the Claude Code host needs no agentLifecycle record to spawn or to validate its native call", async (t) => {
  const { workspace, workId } = await hostFixture(t);
  const prepared = await resolveDispatchRequest({ workspace, host: "claude-code", taskClass: "implement" });
  assert.equal(prepared.executable, true, JSON.stringify(prepared));

  const spawn = buildNativeSpawnInput(prepared, undefined);
  assert.equal(spawn.reasonCode, "DISPATCH_NATIVE_SPAWN_READY", JSON.stringify(spawn));
  assert.deepEqual(spawn.spawn, { model: "claude-fixture-model", effort: "max" });
  assert.equal(buildNativeSpawnInput(prepared, { workId }).reasonCode, "DISPATCH_NATIVE_SPAWN_READY");
  assert.equal(buildNativeSpawnInput(prepared, { model: "not-the-resolved-model" }).reasonCode, "DISPATCH_MODEL_MISMATCH");
  assert.equal(buildNativeSpawnInput(prepared, { effort: "low" }).reasonCode, "DISPATCH_EFFORT_MISMATCH");

  const invocation = { model: "claude-fixture-model", effort: "max", workId };
  const validated = await validateDispatchInvocation({ prepared, invocation });
  assert.equal(validated.reasonCode, "DISPATCH_NATIVE_INVOCATION_VALID", JSON.stringify(validated));
  assert.equal(validated.lifecycle, null);
  assert.equal(validated.observations.status, "unknown");
  assert.equal((await validateDispatchInvocation({ prepared, invocation: { ...invocation, model: "wrong-model" } })).reasonCode, "DISPATCH_MODEL_MISMATCH");
});

test("the codex host still requires a valid agentLifecycle to spawn and to validate its native call", async (t) => {
  const { workspace, workId } = await hostFixture(t);
  const prepared = await resolveDispatchRequest({ workspace, host: "codex", taskClass: "implement" });
  assert.equal(prepared.executable, true, JSON.stringify(prepared));

  assert.equal(buildNativeSpawnInput(prepared, undefined).reasonCode, "DISPATCH_LIFECYCLE_REQUIRED");
  assert.equal(buildNativeSpawnInput(prepared, lifecycle({ workId, forkTurns: "all" })).reasonCode, "DISPATCH_LIFECYCLE_INVALID");
  assert.equal(buildNativeSpawnInput(prepared, lifecycle({ workId })).reasonCode, "DISPATCH_NATIVE_SPAWN_READY");

  const invocation = { model: "gpt-5.6-luna", effort: "max", workId };
  assert.equal((await validateDispatchInvocation({ prepared, invocation })).reasonCode, "DISPATCH_LIFECYCLE_REQUIRED");
  assert.equal((await validateDispatchInvocation({ prepared, invocation, lifecycle: lifecycle({ workId, forkTurns: "all" }) })).reasonCode, "DISPATCH_LIFECYCLE_INVALID");
  const validated = await validateDispatchInvocation({ prepared, invocation, lifecycle: lifecycle({ workId }) });
  assert.equal(validated.reasonCode, "DISPATCH_NATIVE_INVOCATION_VALID", JSON.stringify(validated));
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
