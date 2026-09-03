// SPDX-License-Identifier: Apache-2.0
// STORY-347/348: variable values are settings or policy data; protocol values
// that define validity remain fixed in code.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_PROVENANCE_POLICY,
  SettingsError,
  acquireWorkspaceLease,
  createProject,
  createWork,
  initializeWorkspace,
  setWorkspaceSetting,
} from "../dist/build/packages/core/src/index.js";
import { PROTOCOL_LIMITS } from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-09-02T06:00:${String(second).padStart(2, "0")}Z`;

async function fixture(context, suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s347-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: `STORY-347-${suffix}`, createdAt: instant(0) });
  return { base, workspace, roots };
}

async function cli(arguments_) {
  let output = "";
  await runCli(arguments_, { write(value) { output = value; } });
  return JSON.parse(output);
}

test("STORY-347 settings catalog exposes all six new keys and numeric bounds", async (context) => {
  const fx = await fixture(context, "CATALOG");
  const catalog = await cli(["settings-catalog", "--workspace", fx.workspace]);
  const expected = ["storage.segmentBytes", "storage.snapshotEveryEvents", "storage.backend", "injection.budgetBytes", "retrieval.scopeExcerptBytes", "knowledge.aggregateBytes"];
  const entries = catalog.settings.filter((entry) => expected.includes(entry.key));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), [...expected].sort());
  assert.equal(entries.find((entry) => entry.key === "storage.segmentBytes").defaultValue, "16777216");
  assert.equal(entries.find((entry) => entry.key === "storage.snapshotEveryEvents").defaultValue, "512");
  assert.equal(entries.find((entry) => entry.key === "storage.backend").defaultValue, "file-segmented");
  assert.equal(entries.find((entry) => entry.key === "injection.budgetBytes").defaultValue, "32768");
  assert.equal(entries.find((entry) => entry.key === "retrieval.scopeExcerptBytes").defaultValue, "512");
  assert.equal(entries.find((entry) => entry.key === "knowledge.aggregateBytes").defaultValue, "131072");
  assert.ok(entries.filter((entry) => entry.controlType === "number").every((entry) => entry.min !== undefined && entry.max !== undefined));
});

test("STORY-347 settings reject below-minimum values and retrieval setting supplies the default excerpt window", async (context) => {
  const fx = await fixture(context, "CONSUME");
  const lease = await acquireWorkspaceLease(fx.workspace, { now: instant(1) });
  try {
    await assert.rejects(() => setWorkspaceSetting(fx.workspace, lease, {
      key: "storage.snapshotEveryEvents", value: "0", expectedVersion: 0, occurredAt: instant(2),
    }), (error) => error instanceof SettingsError && error.reasonCode === "SETTINGS_VALUE_INVALID");
    let state = await setWorkspaceSetting(fx.workspace, lease, {
      key: "retrieval.scopeExcerptBytes", value: "12", expectedVersion: 0, occurredAt: instant(2),
    });
    state = await createProject(fx.workspace, lease, { externalKey: "STORY-347-PROJECT", name: "Settings", expectedVersion: state.version, occurredAt: instant(3) });
    state = await createWork(fx.workspace, lease, {
      projectId: state.projects[0].id, externalKey: "STORY-347-INCIDENT", kind: "Incident", parentId: null,
      scope: "【Goal】abcdefghijklmnop", expectedVersion: state.version, occurredAt: instant(4),
    });
    const defaultWindow = await cli(["work-list", "--workspace", fx.workspace, "--search", "abc"]);
    assert.equal(Buffer.byteLength(defaultWindow.records[0].scope, "utf8"), 12);
    const overridden = await cli(["work-list", "--workspace", fx.workspace, "--search", "abc", "--scope-bytes", "4"]);
    assert.equal(Buffer.byteLength(overridden.records[0].scope, "utf8"), 4);
  } finally {
    await lease.release();
  }
});

test("STORY-348 provenance policy is an external JSON source and the aggregate setting is bounded by the canonical ceiling", async (context) => {
  const policy = JSON.parse(await readFile(new URL("../scripts/policy/knowledge-provenance.json", import.meta.url), "utf8"));
  assert.deepEqual(policy, {
    schemaVersion: "tcrn.knowledge-provenance-policy.v1",
    relaxedKinds: ["fact", "decision", "summary"],
    strictKinds: ["guide", "reference"],
  });
  const fx = await fixture(context, "AGGREGATE");
  const lease = await acquireWorkspaceLease(fx.workspace, { now: instant(1) });
  try {
    const state = await setWorkspaceSetting(fx.workspace, lease, {
      key: "knowledge.aggregateBytes", value: "65536", expectedVersion: 0, occurredAt: instant(2),
    });
    assert.equal(state.settings.find((entry) => entry.key === "knowledge.aggregateBytes").value, "65536");
  } finally {
    await lease.release();
  }
});

test("STORY-348 protocol validity values remain hardcoded rather than becoming settings", async (context) => {
  assert.equal(KNOWLEDGE_LIMITS.maximumBodyBytes, 8_192);
  assert.equal(KNOWLEDGE_LIMITS.maximumAggregateBytes, PROTOCOL_LIMITS.maxCanonicalBytes);
  assert.equal(PROTOCOL_LIMITS.maxCanonicalBytes, 1_048_576);
  assert.deepEqual(KNOWLEDGE_PROVENANCE_POLICY, {
    relaxedKinds: ["fact", "decision", "summary"],
    strictKinds: ["guide", "reference"],
  });
  const fx = await fixture(context, "RUNTIME-POLICY");
  const catalog = await cli(["settings-catalog", "--workspace", fx.workspace]);
  assert.equal(catalog.settings.some((entry) => entry.key === "protocol.maxCanonicalBytes"), false);
});
