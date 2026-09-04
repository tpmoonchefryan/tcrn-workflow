// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";

// Test harness: each test owns a private synthetic platform root.
const queuedTests = [];
const testConcurrency = 2;
function test(name, optionsOrBody, maybeBody) {
  const options = typeof optionsOrBody === "function" ? {} : optionsOrBody ?? {};
  const body = typeof optionsOrBody === "function" ? optionsOrBody : maybeBody;
  queuedTests.push([name, { ...options, concurrency: true }, body]);
}

import { inspectPlatform } from "../scripts/platform-doctor.mjs";
import { INSTALL_MANIFEST } from "../dist/build/packages/core/src/index.js";

const FIXTURE_COMMIT = "f".repeat(40);
const launchdLabel = "com.tcrn.platform.local-snapshot";
const topology = "## 三、分区拓扑\n";

function syntheticRoster(count = 9) {
  return {
    schemaVersion: "tcrn.acceptance-gate-groups.v1",
    groups: Array.from({ length: count }, (_, index) => ({
      id: `group-${index}`,
      title: `Group ${index}`,
      repository: "fixture",
      command: "pnpm fixture",
      proves: "fixture",
    })),
  };
}

// Complete platform fixture following the existing test pattern.
async function minimalFixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc270-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "platform");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "AGENTS.md"), `${topology}fixture\n`);
  await writeFile(join(root, "CLAUDE.md"), "@AGENTS.md\n");
  await mkdir(join(root, ".tcrn-workspace", "cross-project", "workspace"), { recursive: true });
  const roster = syntheticRoster(9);
  await mkdir(join(root, "platform-docs"), { recursive: true });
  await writeFile(join(root, "platform-docs", "acceptance-gate-groups.json"), `${JSON.stringify(roster, null, 2)}\n`);
  const recordedAt = new Date((await stat(join(root, "platform-docs", "acceptance-gate-groups.json"))).mtimeMs).toISOString();
  await writeFile(
    join(root, "platform-docs", "acceptance-verdicts.json"),
    `${JSON.stringify({
      schemaVersion: "tcrn.acceptance-verdicts.v1",
      verdicts: Object.fromEntries(roster.groups.map((group) => [group.id, { verdict: "green", recordedAt, commit: FIXTURE_COMMIT }])),
    }, null, 2)}\n`
  );
  await mkdir(join(root, "platform-docs"), { recursive: true });
  await writeFile(join(root, "platform-docs", "platform-root-agents.md"), `${topology}fixture\n`);
  return root;
}

// Helper: create a synthetic command catalog.
function createCatalog(verbNames, flagCounts = {}) {
  return verbNames.map((name) => ({
    name,
    availability: "cli",
    mutates: false,
    flags: Array.from({ length: flagCounts[name] ?? 2 }, (_, i) => ({
      name: `flag-${i}`,
      required: i === 0,
      valueKind: "string",
    })),
  }));
}

test("INC-270 case 1: identical catalogs -> green with IDENTICAL", async (context) => {
  const catalog = createCatalog(["verb-a", "verb-b"], { "verb-a": 2, "verb-b": 3 });
  const root = await minimalFixture(context);
  // Test the full platform with synthetic catalogs. Even though other checks may fail,
  // we verify the engineCapabilitySurface check itself.
  const result = await inspectPlatform(root, {
    includeInstallSurface: true,
    engineCommandCatalogs: { installed: catalog, worktree: catalog },
  });
  const leg = result.checks.find((c) => c.name === "engineCapabilitySurface");
  assert.ok(leg, "engineCapabilitySurface leg exists");
  assert.equal(leg.ok, true, "leg is green for identical catalogs");
  assert.equal(leg.capabilitySurface, "IDENTICAL");
  assert.ok(leg.digest, "digest is present");
});

test("INC-270 case 2: worktree has extra verb -> green with WORKTREE_AHEAD", async (context) => {
  const installed = createCatalog(["verb-a", "verb-b"], { "verb-a": 2, "verb-b": 3 });
  const worktree = createCatalog(["verb-a", "verb-b", "verb-c"], { "verb-a": 2, "verb-b": 3, "verb-c": 2 });
  const root = await minimalFixture(context);
  const result = await inspectPlatform(root, {
    includeInstallSurface: true,
    engineCommandCatalogs: { installed, worktree },
  });
  const leg = result.checks.find((c) => c.name === "engineCapabilitySurface");
  assert.equal(leg.ok, true, "leg is green when worktree is ahead");
  assert.equal(leg.capabilitySurface, "WORKTREE_AHEAD");
  assert.deepEqual(leg.worktreeOnly, ["verb-c"]);
  assert.ok(leg.remedy, "remedy is present");
});

test("INC-270 case 3: installed has extra verb -> RED PLATFORM_ENGINE_INSTALLED_AHEAD", async (context) => {
  const installed = createCatalog(["verb-a", "verb-b", "verb-extra"], { "verb-a": 2, "verb-b": 3, "verb-extra": 1 });
  const worktree = createCatalog(["verb-a", "verb-b"], { "verb-a": 2, "verb-b": 3 });
  const root = await minimalFixture(context);
  const result = await inspectPlatform(root, {
    includeInstallSurface: true,
    engineCommandCatalogs: { installed, worktree },
  });
  const leg = result.checks.find((c) => c.name === "engineCapabilitySurface");
  assert.equal(leg.ok, false, "leg is red when installed is ahead");
  assert.equal(leg.reasonCode, "PLATFORM_ENGINE_INSTALLED_AHEAD");
  assert.equal(leg.capabilitySurface, "INSTALLED_AHEAD");
  assert.deepEqual(leg.installedOnly, ["verb-extra"]);
  // The platform will be red, but may have other reasons. Verify the leg itself is red with the right reason.
  assert.equal(result.ok, false, "platform is red when engine surface check is red");
  // The platform's top-level reasonCode may be from another failing check, but our check is red.
  const firstFailure = result.checks.find((c) => !c.ok);
  assert.ok(firstFailure, "platform has a red check");
});

test("INC-270 case 3b: both differ -> RED, both listed", async (context) => {
  const installed = createCatalog(["verb-a", "verb-extra"], { "verb-a": 2, "verb-extra": 1 });
  const worktree = createCatalog(["verb-a", "verb-new"], { "verb-a": 2, "verb-new": 2 });
  const root = await minimalFixture(context);
  const result = await inspectPlatform(root, {
    includeInstallSurface: true,
    engineCommandCatalogs: { installed, worktree },
  });
  const leg = result.checks.find((c) => c.name === "engineCapabilitySurface");
  assert.equal(leg.ok, false);
  assert.equal(leg.reasonCode, "PLATFORM_ENGINE_INSTALLED_AHEAD");
  assert.deepEqual(leg.installedOnly, ["verb-extra"]);
  assert.deepEqual(leg.worktreeOnly, ["verb-new"]);
});

test("INC-270 case 4a: unreadable installed -> uncomparable", async (context) => {
  const worktree = createCatalog(["verb-a", "verb-b"]);
  const root = await minimalFixture(context);
  const result = await inspectPlatform(root, {
    includeInstallSurface: true,
    engineCommandCatalogs: { installed: null, worktree },
  });
  const leg = result.checks.find((c) => c.name === "engineCapabilitySurface");
  assert.equal(leg.ok, true, "uncomparable is green");
  assert.equal(leg.comparable, false);
  assert.ok(leg.readable, "readable field shows which copy is readable");
  assert.equal(leg.readable.installed, false);
  assert.equal(leg.readable.worktree, true);
});

test("INC-270 case 4b: both unreadable -> uncomparable", async (context) => {
  const root = await minimalFixture(context);
  const result = await inspectPlatform(root, {
    includeInstallSurface: true,
    engineCommandCatalogs: { installed: null, worktree: null },
  });
  const leg = result.checks.find((c) => c.name === "engineCapabilitySurface");
  assert.equal(leg.ok, true);
  assert.equal(leg.comparable, false);
  assert(!leg.readable, "readable field not present when both unreadable");
});

test("engineFloorSatisfied renamed from engineAlignment", async (context) => {
  const root = await minimalFixture(context);
  const result = await inspectPlatform(root, {
    includeInstallSurface: true,
    engineCopyVersions: { installed: "0.11.15", worktree: "0.11.15" },
    engineRequiredVersions: { "cross-project": "0.11.15" },
  });
  const leg = result.checks.find((c) => c.name === "engineFloorSatisfied");
  assert.ok(leg, "renamed leg exists");
  assert.equal(leg.ok, true);
  assert.equal(leg.requirementAsserted, true);
});

test("both engineFloorSatisfied and engineCapabilitySurface in checks", async (context) => {
  const root = await minimalFixture(context);
  const catalog = createCatalog(["verb-a"]);
  const result = await inspectPlatform(root, {
    includeInstallSurface: true,
    engineCopyVersions: { installed: "0.11.15", worktree: "0.11.15" },
    engineRequiredVersions: { "cross-project": null },
    engineCommandCatalogs: { installed: catalog, worktree: catalog },
  });
  const floorLeg = result.checks.find((c) => c.name === "engineFloorSatisfied");
  const surfaceLeg = result.checks.find((c) => c.name === "engineCapabilitySurface");
  assert.ok(floorLeg);
  assert.ok(surfaceLeg);
  assert.notEqual(floorLeg, surfaceLeg);
});

test("INC-270 case 5a: worktree has extra flag on a verb -> green WORKTREE_AHEAD", async (context) => {
  const installed = createCatalog(["verb-a", "verb-b"], { "verb-a": 2, "verb-b": 3 });
  const worktree = installed.map((cmd) => {
    if (cmd.name === "verb-a") {
      return {
        ...cmd,
        flags: [...cmd.flags, { name: "extra-flag", required: false, valueKind: "string" }],
      };
    }
    return cmd;
  });
  const root = await minimalFixture(context);
  const result = await inspectPlatform(root, {
    includeInstallSurface: true,
    engineCommandCatalogs: { installed, worktree },
  });
  const leg = result.checks.find((c) => c.name === "engineCapabilitySurface");
  assert.equal(leg.ok, true, "leg is green when worktree has extra flags");
  assert.equal(leg.capabilitySurface, "WORKTREE_AHEAD");
  assert.ok(leg.worktreeOnlyFlags, "worktreeOnlyFlags is present");
  assert.ok(leg.worktreeOnlyFlags["verb-a"], "verb-a is in worktreeOnlyFlags");
  assert.deepEqual(leg.worktreeOnlyFlags["verb-a"], ["extra-flag"]);
});

test("INC-270 case 5b: installed has extra flag on a verb -> RED PLATFORM_ENGINE_INSTALLED_AHEAD", async (context) => {
  const worktree = createCatalog(["verb-a", "verb-b"], { "verb-a": 2, "verb-b": 3 });
  const installed = worktree.map((cmd) => {
    if (cmd.name === "verb-a") {
      return {
        ...cmd,
        flags: [...cmd.flags, { name: "extra-flag", required: false, valueKind: "string" }],
      };
    }
    return cmd;
  });
  const root = await minimalFixture(context);
  const result = await inspectPlatform(root, {
    includeInstallSurface: true,
    engineCommandCatalogs: { installed, worktree },
  });
  const leg = result.checks.find((c) => c.name === "engineCapabilitySurface");
  assert.equal(leg.ok, false, "leg is red when installed has extra flags");
  assert.equal(leg.reasonCode, "PLATFORM_ENGINE_INSTALLED_AHEAD");
  assert.equal(leg.capabilitySurface, "INSTALLED_AHEAD");
  assert.ok(leg.installedOnlyFlags, "installedOnlyFlags is present");
  assert.ok(leg.installedOnlyFlags["verb-a"], "verb-a is in installedOnlyFlags");
  assert.deepEqual(leg.installedOnlyFlags["verb-a"], ["extra-flag"]);
});

test("INC-270 case 6: same verbs and flags, but valueKind differs -> green ATTRIBUTES_DIVERGENT", async (context) => {
  const baseInstalled = createCatalog(["verb-a"], { "verb-a": 2 });
  const installed = baseInstalled.map((cmd) => ({
    ...cmd,
    flags: cmd.flags.map((flag, i) => ({
      ...flag,
      valueKind: i === 0 ? "string" : "number",
    })),
  }));
  const worktree = baseInstalled.map((cmd) => ({
    ...cmd,
    flags: cmd.flags.map((flag, i) => ({
      ...flag,
      valueKind: i === 0 ? "number" : "string",
    })),
  }));
  const root = await minimalFixture(context);
  const result = await inspectPlatform(root, {
    includeInstallSurface: true,
    engineCommandCatalogs: { installed, worktree },
  });
  const leg = result.checks.find((c) => c.name === "engineCapabilitySurface");
  assert.equal(leg.ok, true, "leg is green when only attributes diverge");
  assert.equal(leg.capabilitySurface, "ATTRIBUTES_DIVERGENT");
  assert.ok(leg.attributeDifferences, "attributeDifferences is present");
  assert.ok(Array.isArray(leg.attributeDifferences), "attributeDifferences is an array");
  assert.ok(leg.attributeDifferences.length > 0, "at least one attribute difference recorded");
});

// Set up the test suite and run.
async function runTests() {
  for (const [name, options, body] of queuedTests) {
    nodeTest.test(name, options, body);
  }
}

runTests().catch((error) => {
  console.error("Test setup error:", error);
  process.exitCode = 1;
});
