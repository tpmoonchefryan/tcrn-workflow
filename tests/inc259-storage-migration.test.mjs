// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-259: live legacy workspaces are migrated to byte-bounded storage.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  createProject,
  initializeWorkspace,
  materializeWorkspace,
  migrateWorkspaceStorage,
  planWorkspaceMigration,
  validateWorkspace,
  verifyWorkspaceStorageMigration,
  WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES,
} from "../dist/build/packages/core/src/index.js";

const controlDirectory = ".tcrn-" + "workflow";
const chainContainer = [".tcrn", "workspace"].join("-");
const partitions = [
  "ADBlock",
  "Joi-Button",
  "TCRN-AOS",
  "TCRN-Design-System",
  "TCRN-TMS",
  "cross-project",
  "dsh-joi-channel-theme",
  "dsh-tcrn-workflow-plugin",
];

function logicalState(state) {
  return {
    version: state.version,
    headEventHash: state.headEventHash,
    projects: state.projects,
    work: state.work,
    conferences: state.conferences,
    conferencePositions: state.conferencePositions,
    conferenceMinutes: state.conferenceMinutes,
    gates: state.gates,
    settings: state.settings,
    executionConfig: state.executionConfig,
    templates: state.templates,
    events: state.events,
    attestationEnabledAtSequence: state.attestationEnabledAtSequence,
  };
}

async function legacyFixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc259-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "INC259-LEGACY-FIXTURE", createdAt: "2026-09-02T03:00:00Z", segmentEventLimit: 2 });
  const lease = await acquireWorkspaceLease(workspace, { now: "2026-09-02T03:00:01Z" });
  try {
    let state = await materializeWorkspace(workspace);
    for (let index = 0; index < 5; index += 1) {
      state = await createProject(workspace, lease, {
        externalKey: `INC259-PROJECT-${index}`,
        name: `Project ${index}`,
        expectedVersion: state.version,
        occurredAt: `2026-09-02T03:00:0${index + 2}Z`,
      });
    }
  } finally {
    await lease.release();
  }
  return { base, workspace };
}

test("INC-259 migration preserves materialized values and emits bounded segmented files", async (context) => {
  const fx = await legacyFixture(context);
  const before = await materializeWorkspace(fx.workspace);
  const plan = await planWorkspaceMigration(fx.workspace, 2);
  assert.equal(plan.applyAvailable, true);
  assert.ok(plan.steps.some((step) => step.includes(String(WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES))));
  const migrated = await migrateWorkspaceStorage(fx.workspace);
  const after = await materializeWorkspace(fx.workspace);
  assert.deepEqual(logicalState(after), logicalState(before));
  assert.equal(after.metadata.storageVersion, 2);
  assert.equal(after.metadata.segmentEventLimit, WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES);
  assert.equal(migrated.segmentBytes, WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES);
  assert.equal((await validateWorkspace(fx.workspace)).version, before.version);
  const entries = (await readdir(join(fx.workspace, controlDirectory, "events"))).sort();
  assert.deepEqual(entries.filter((entry) => /^\d{6}\.json$/u.test(entry)), []);
  const segments = entries.filter((entry) => entry.endsWith(".ndjson"));
  assert.ok(segments.length > 0);
  const manifest = JSON.parse(await readFile(join(fx.workspace, controlDirectory, "events", "manifest.json"), "utf8"));
  assert.equal(manifest.segments.length, segments.length);
  assert.ok(manifest.segments.every((entry) => entry.bytes <= WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES));
  assert.equal((await verifyWorkspaceStorageMigration(fx.workspace)).ok, true);
});

test("INC-259 the live eight partitions use storage version 2 and the 4 MiB bound", async () => {
  const platformRoot = resolve(process.cwd(), "../..");
  for (const partition of partitions) {
    const workspace = join(platformRoot, chainContainer, partition, "workspace");
    const metadata = JSON.parse(await readFile(join(workspace, controlDirectory, "workspace.json"), "utf8"));
    assert.equal(metadata.storageVersion, 2, partition);
    assert.equal(metadata.segmentEventLimit, WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, partition);
    const verification = await verifyWorkspaceStorageMigration(workspace);
    assert.equal(verification.ok, true, partition);
    assert.equal((await validateWorkspace(workspace)).metadata.storageVersion, 2, partition);
    const eventEntries = await readdir(join(workspace, controlDirectory, "events"));
    assert.equal(eventEntries.some((entry) => /^\d{6}\.json$/u.test(entry)), false, partition);
    const manifest = JSON.parse(await readFile(join(workspace, controlDirectory, "events", "manifest.json"), "utf8"));
    assert.ok(manifest.segments.every((entry) => entry.bytes <= WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES), partition);
  }
});

test("INC-259 an over-large segment limit is a red migration verification", async (context) => {
  const fx = await legacyFixture(context);
  await migrateWorkspaceStorage(fx.workspace);
  const metadataPath = join(fx.workspace, controlDirectory, "workspace.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  await writeFile(metadataPath, `${JSON.stringify({ ...metadata, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES * 4 })}\n`, "utf8");
  const red = await verifyWorkspaceStorageMigration(fx.workspace);
  assert.equal(red.ok, false);
  assert.equal(red.reasonCode, "WORKSPACE_STORAGE_MIGRATION_LIMIT_INVALID");
});
