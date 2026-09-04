// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-274: platform-doctor storage shape and snapshot read checks.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import test from "node:test";

import { inspectPlatform } from "../scripts/platform-doctor.mjs";
import { WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES } from "../dist/build/packages/core/src/index.js";

const FIXTURE_COMMIT = "f".repeat(40);

async function createMinimalFixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc274-doctor-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "platform");
  const home = join(base, "home");
  await mkdir(join(root, ".tcrn-workspace", "cross-project", "workspace"), { recursive: true });
  await mkdir(home, { recursive: true });

  // Create platform-docs directory with minimal acceptance gate groups
  const docsDirectory = "platform-docs";
  await mkdir(join(root, docsDirectory), { recursive: true });

  const rosterPath = join(root, docsDirectory, "acceptance-gate-groups.json");
  const roster = {
    schemaVersion: "tcrn.acceptance-gate-groups.v1",
    groups: [
      { id: "engine-suite", title: "engine-suite", repository: "TCRN Platform/tcrn-workflow", command: "fixture", proves: "fixture" },
    ],
  };
  await writeFile(rosterPath, `${JSON.stringify(roster, null, 2)}\n`);
  const rosterRecordedAt = new Date((await stat(rosterPath)).mtimeMs).toISOString();

  const verdictPath = join(root, docsDirectory, "acceptance-verdicts.json");
  await writeFile(verdictPath, `${JSON.stringify({
    schemaVersion: "tcrn.acceptance-verdicts.v1",
    verdicts: { "engine-suite": { verdict: "green", recordedAt: rosterRecordedAt, commit: FIXTURE_COMMIT } },
  }, null, 2)}\n`);

  return { root, home };
}

// All partitions at storage version 2 with correct segment bound = green.
test("workspaceStorageShape: all partitions at version 2 with correct segment bound", async (context) => {
  const fixture = await createMinimalFixture(context);
  const partitions = [
    { partition: "cross-project", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
    { partition: "TCRN-AOS", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
    { partition: "TCRN-Design-System", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
    { partition: "TCRN-TMS", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
    { partition: "Joi-Button", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
    { partition: "dsh-joi-channel-theme", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
    { partition: "dsh-tcrn-workflow-plugin", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
    { partition: "ADBlock", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
  ];

  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    acceptanceHeadCommit: FIXTURE_COMMIT,
    workspaceStorageShape: { partitions },
    includeInstallSurface: false,
  });

  const check = result.checks.find((c) => c.name === "workspaceStorageShape");
  assert.ok(check, "workspaceStorageShape check should exist");
  assert.equal(check.ok, true, "storage shape check should pass when all partitions are at version 2");
  assert.equal(check.partitions.length, 8, "should report all 8 partitions");
  assert.equal(check.partitions.every((p) => p.ok), true, "all partitions should be ok");
});

// One partition behind version 2 = RED naming that partition.
test("workspaceStorageShape: one partition behind version 2", async (context) => {
  const fixture = await createMinimalFixture(context);
  const partitions = [
    { partition: "cross-project", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
    { partition: "TCRN-AOS", storageVersion: 1, segmentEventLimit: 1048576, ok: false }, // Behind: version 1
    { partition: "TCRN-Design-System", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
    { partition: "TCRN-TMS", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
    { partition: "Joi-Button", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
    { partition: "dsh-joi-channel-theme", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
    { partition: "dsh-tcrn-workflow-plugin", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
    { partition: "ADBlock", storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, ok: true },
  ];

  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    acceptanceHeadCommit: FIXTURE_COMMIT,
    workspaceStorageShape: { partitions },
    includeInstallSurface: false,
  });

  const check = result.checks.find((c) => c.name === "workspaceStorageShape");
  assert.ok(check, "workspaceStorageShape check should exist");
  assert.equal(check.ok, false, "storage shape check should fail when one partition is behind");
  assert.equal(check.reasonCode, "PLATFORM_WORKSPACE_STORAGE_BEHIND");
  assert.equal(check.failed.length, 1, "should report one failed partition");
  assert.equal(check.failed[0].partition, "TCRN-AOS", "should name the behind partition");
  assert.equal(check.failed[0].storageVersion, 1, "should report the partition's current version");
});

// Snapshot read performance is an observation, never fails the doctor.
// When measurements are available, comparable=true and measuredPartitions > 0.
test("snapshotReadPerformance: with measurements reports comparable true and measured count", async (context) => {
  const fixture = await createMinimalFixture(context);
  const measurements = [
    { partition: "cross-project", eventCount: 1000, readTimeNs: 75000000, slope: 75.0 },
    { partition: "TCRN-AOS", eventCount: 500, readTimeNs: 50000000, slope: 100.0 },
  ];

  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    acceptanceHeadCommit: FIXTURE_COMMIT,
    snapshotReadPerformance: { measurements },
    includeInstallSurface: true,
  });

  const check = result.checks.find((c) => c.name === "snapshotReadPerformance");
  assert.ok(check, "snapshotReadPerformance check should exist");
  assert.equal(check.ok, true, "snapshot read check should never fail the doctor");
  assert.equal(check.comparable, true, "should report measurements as comparable when measurements exist");
  assert.ok(check.measurements && check.measurements.length > 0, "should include measurements array");
  assert.equal(check.measuredPartitions, 2, "should report count of measured partitions");
  assert.equal(check.referenceBaseline, 75, "should include the reference baseline");
  assert.equal(check.referenceUnit, "microseconds-per-event");
  assert.ok(check.reason.includes("performance observations are reported"), "should explain why it's an observation");
});

// When no measurements are available, comparable=false and measuredPartitions=0.
test("snapshotReadPerformance: without measurements reports comparable false and measured count zero", async (context) => {
  const fixture = await createMinimalFixture(context);

  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    acceptanceHeadCommit: FIXTURE_COMMIT,
    snapshotReadPerformance: { measurements: [] },
    includeInstallSurface: true,
  });

  const check = result.checks.find((c) => c.name === "snapshotReadPerformance");
  assert.ok(check, "snapshotReadPerformance check should exist");
  assert.equal(check.ok, true, "snapshot read check should never fail the doctor, even with no measurements");
  assert.equal(check.comparable, false, "should report as not comparable when no measurements");
  assert.equal(check.measuredPartitions, 0, "should report zero measured partitions");
  assert.ok(!check.measurements || check.measurements.length === 0, "should not include measurements array or it should be empty");
  assert.ok(check.reason, "should provide a reason for no measurements");
});
