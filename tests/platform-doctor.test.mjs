// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { adapterIdentityObservations, inspectPlatform } from "../scripts/platform-doctor.mjs";
import { GUARDED_TREES, HOSTS, claudeHookSettings, hookEntriesFor } from "../scripts/host-harness.mjs";
import { applyHostHarness } from "../scripts/host-harness-apply.mjs";
import { INSTALL_MANIFEST } from "../dist/build/packages/core/src/index.js";
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

const topology = "## 三、分区拓扑\n";
const FIXTURE_COMMIT = "f".repeat(40);
const launchdLabel = "com.tcrn.platform.local-snapshot";

// STORY-300: a complete container now carries the acceptance-lane roster, so the
// synthetic one does too. `roster: false` builds a container without it, which is
// what the roster leg's red case looks like -- and what every container looked like
// until 2026-08-19, while forty-four records were landing done against it.
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

async function fixture(context, { agents = `${topology}fixture\n`, chain = true, git = false, whitelistGit = false, claude = "@AGENTS.md\n", roster = syntheticRoster(), trackedAgents = true, docsDirectory = "platform-docs" } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-platform-doctor-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "platform");
  await mkdir(root, { recursive: true });
  if (agents !== null) await writeFile(join(root, "AGENTS.md"), agents);
  if (claude !== null) await writeFile(join(root, "CLAUDE.md"), claude);
  if (chain) await mkdir(join(root, ".tcrn-workspace", "cross-project", "workspace"), { recursive: true });
  if (git) {
    await mkdir(join(root, ".git"));
    if (whitelistGit) await writeFile(join(root, ".gitignore"), "/*\n!/AGENTS.md\n!/CLAUDE.md\n!/docs/\n");
  }
  if (roster !== null) {
    await mkdir(join(root, docsDirectory), { recursive: true });
    await writeFile(join(root, docsDirectory, "acceptance-gate-groups.json"), `${JSON.stringify(roster, null, 2)}\n`);
    // INC-234: a container carrying the roster and no verdicts is exactly the state that
    // let product-gates sit red for two days, so "complete" has to include them. The
    // timestamps are pinned to the roster file's own mtime, which is what the leg
    // measures against -- a fixture anchored to the wall clock would age out mid-suite.
    const recordedAt = new Date((await stat(join(root, docsDirectory, "acceptance-gate-groups.json"))).mtimeMs).toISOString();
    await writeFile(join(root, docsDirectory, "acceptance-verdicts.json"), `${JSON.stringify({
      schemaVersion: "tcrn.acceptance-verdicts.v1",
      verdicts: Object.fromEntries(roster.groups.map((group) => [group.id, { verdict: "green", recordedAt, commit: FIXTURE_COMMIT }])),
    }, null, 2)}\n`);
  }
  // STORY-300 Wave 2.2: the identity file's tracked copy, byte-identical unless a
  // case deliberately diverges them.
  if (agents !== null && trackedAgents !== false) {
    await mkdir(join(root, docsDirectory), { recursive: true });
    await writeFile(join(root, docsDirectory, "platform-root-agents.md"), trackedAgents === true || trackedAgents === undefined ? agents : trackedAgents);
  }
  return root;
}

test("a complete synthetic platform container is green", async (context) => {
  const root = await fixture(context);
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, "PLATFORM_LAYOUT_HEALTHY");
  assert.deepEqual(result.checks.map((item) => item.ok), [true, true, true, true, true, true, true, true]);
});

test("INC-247: the container-root platform docs location is canonical", async (context) => {
  const root = await fixture(context, { docsDirectory: "platform-docs" });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.checks.find((entry) => entry.name === "acceptanceGateGroups").acceptedExceptionCount, 0);
});

test("INC-247: the former classification-folder docs location is rejected", async (context) => {
  const root = await fixture(context, { docsDirectory: join("TCRN Platform", "docs") });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((entry) => entry.name === "acceptanceGateGroups").reasonCode, "PLATFORM_ACCEPTANCE_ROSTER_MISSING");
});

// Red legs for the roster, both observed before this landed: an absent roster is
// named as absent rather than tolerated, and a roster that has quietly lost a group
// is refused with the count reported. Nine is the number the acceptance ruling
// names, so a different count is a change to the criterion and belongs in a ruling
// rather than in a file edit.
test("STORY-300: an absent acceptance roster is a red leg, not a tolerated gap", async (context) => {
  const root = await fixture(context, { roster: null });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.name === "acceptanceGateGroups").reasonCode, "PLATFORM_ACCEPTANCE_ROSTER_MISSING");
});

test("STORY-300: an acceptance roster that lost a group is refused with the count", async (context) => {
  const root = await fixture(context, { roster: syntheticRoster(8) });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  const leg = result.checks.find((item) => item.name === "acceptanceGateGroups");
  assert.equal(leg.reasonCode, "PLATFORM_ACCEPTANCE_ROSTER_INVALID");
  assert.equal(leg.declaredGroups, 8);
});

// Red legs for the identity file's history, both observed before this landed. Two
// copies of a governing document is normally the defect; it is admissible only
// because one is checked against the other on every run, and these are what make
// that check real.
test("STORY-300: an untracked platform identity file is a red leg", async (context) => {
  const root = await fixture(context, { trackedAgents: false });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.name === "platformAgentsHistory").reasonCode, "PLATFORM_AGENTS_UNTRACKED");
});

test("STORY-300: the identity file and its tracked copy may not diverge in silence", async (context) => {
  const root = await fixture(context, { trackedAgents: `${topology}fixture\nan edit that never reached the tracked copy\n` });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.name === "platformAgentsHistory").reasonCode, "PLATFORM_AGENTS_HISTORY_DIVERGED");
});

test("STORY-300: an acceptance roster entry missing a field is named by id", async (context) => {
  const roster = syntheticRoster();
  roster.groups[3] = { ...roster.groups[3], command: "" };
  const root = await fixture(context, { roster });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.find((item) => item.name === "acceptanceGateGroups").incomplete, ["group-3"]);
});

test("an empty platform AGENTS.md is a load-bearing red leg", async (context) => {
  const root = await fixture(context, { agents: "" });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PLATFORM_AGENTS_EMPTY");
  assert.equal(result.checks.find((item) => item.name === "platformAgents").reasonCode, "PLATFORM_AGENTS_EMPTY");
});

test("a missing platform AGENTS.md is named separately", async (context) => {
  const root = await fixture(context, { agents: null });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PLATFORM_AGENTS_MISSING");
});

test("a missing chain container is a distinct red leg", async (context) => {
  const root = await fixture(context, { chain: false });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "WORKSPACE_CONTAINER_MISSING");
});

test("a container inside Git ancestry is refused", async (context) => {
  const root = await fixture(context, { git: true });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PLATFORM_ROOT_INSIDE_GIT_REPOSITORY");
  assert.equal(result.checks.find((item) => item.name === "containerOutsideGit").ok, false);
});

test("the container whitelist repository is allowed, while code-repository ancestry is not", async (context) => {
  const root = await fixture(context, { git: true, whitelistGit: true });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  const leg = result.checks.find((item) => item.name === "containerOutsideGit");
  assert.equal(leg.ok, true, JSON.stringify(leg));
  assert.equal(leg.repository, "container-whitelist");
});

test("a missing Claude bridge is named separately", async (context) => {
  const root = await fixture(context, { claude: null });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PLATFORM_CLAUDE_BRIDGE_MISSING");
});

test("an empty misplaced AGENTS.md remains visible before the root is repaired", async (context) => {
  const root = await fixture(context, { agents: null });
  await mkdir(join(root, "classification"));
  await writeFile(join(root, "classification", "AGENTS.md"), "");
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PLATFORM_AGENTS_EMPTY");
  assert.equal(result.checks.find((item) => item.name === "platformAgents").path, "classification/AGENTS.md");
});

test("a missing --platform-root argument fails closed", async () => {
  const result = await inspectPlatform();
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PLATFORM_ROOT_REQUIRED");
});

test("S259 bridge syntax is green when root and direct-child references resolve", async (context) => {
  const root = await fixture(context, { claude: "@AGENTS.md\n" });
  await mkdir(join(root, "classification"));
  await writeFile(join(root, "classification", "AGENTS.md"), "@../AGENTS.md\n");
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  const bridge = result.checks.find((item) => item.name === "bridgeSyntax");
  assert.equal(result.ok, true);
  assert.equal(bridge.ok, true);
  assert.equal(bridge.source, "platform-and-direct-child-bridges");
});

test("S259 bridge syntax names a double-at reference independently", async (context) => {
  const root = await fixture(context, { claude: "@@\n" });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  const bridge = result.checks.find((item) => item.name === "bridgeSyntax");
  assert.equal(result.reasonCode, "PLATFORM_BRIDGE_SYNTAX_INVALID");
  assert.equal(bridge.failures[0].path, "CLAUDE.md");
  assert.equal(bridge.failures[0].line, 1);
});

test("S259 bridge syntax names a dangling target independently", async (context) => {
  const root = await fixture(context, { claude: "@missing-bridge.md\n" });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  const bridge = result.checks.find((item) => item.name === "bridgeSyntax");
  assert.equal(result.reasonCode, "PLATFORM_BRIDGE_TARGET_UNAVAILABLE");
  assert.equal(bridge.failures[0].path, "CLAUDE.md");
  assert.equal(bridge.failures[0].target, "missing-bridge.md");
});

test("S259 bridge syntax skips hidden directories and the workspace container", async (context) => {
  const root = await fixture(context);
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, ".hidden", "CLAUDE.md"), "@missing-hidden.md\n");
  await writeFile(join(root, ".tcrn-workspace", "CLAUDE.md"), "@missing-workspace.md\n");
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, true);
  assert.equal(result.checks.find((item) => item.name === "bridgeSyntax").ok, true);
});

async function completeInstallFixture(context, { engineVersion = "0.11.15", helperVersion = "0.11.15", harness = true } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-init033-doctor-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "platform");
  const home = join(base, "home");
  await mkdir(join(root, ".tcrn-workspace", "cross-project", "workspace"), { recursive: true });
  await mkdir(home, { recursive: true });
  // STORY-300: a complete container carries the acceptance-lane roster. INC-234: and its
  // verdicts, because a roster with no verdicts is exactly the state that let a group sit
  // red for two days. Timestamps are pinned to the roster's own mtime, which is what the
  // leg measures against -- anchoring a fixture to the wall clock ages it out mid-suite.
  const docsDirectory = "platform-docs";
  await mkdir(join(root, docsDirectory), { recursive: true });
  const rosterPath = join(root, docsDirectory, "acceptance-gate-groups.json");
  const completeRoster = syntheticRoster();
  await writeFile(rosterPath, `${JSON.stringify(completeRoster, null, 2)}\n`);
  const rosterRecordedAt = new Date((await stat(rosterPath)).mtimeMs).toISOString();
  await writeFile(join(root, docsDirectory, "acceptance-verdicts.json"), `${JSON.stringify({
    schemaVersion: "tcrn.acceptance-verdicts.v1",
    verdicts: Object.fromEntries(completeRoster.groups.map((group) => [group.id, { verdict: "green", recordedAt: rosterRecordedAt, commit: FIXTURE_COMMIT }])),
  }, null, 2)}\n`);
  await writeFile(join(root, docsDirectory, "platform-root-agents.md"), `${topology}fixture\n`);
  for (const entry of INSTALL_MANIFEST.items) {
    const path = entry.pathTemplate.replaceAll("<PLATFORM_ROOT>", root).replaceAll("<HOME>", home);
    if (entry.acceptanceProbe.startsWith("probe:regular-directory") || entry.acceptanceProbe.startsWith("probe:helper-skill-digest") || entry.acceptanceProbe.startsWith("probe:engine-version") || entry.acceptanceProbe.startsWith("probe:adapter-bundle-digest")) await mkdir(path, { recursive: true });
    else {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "{}\n");
      if (entry.acceptanceProbe.startsWith("probe:regular-executable")) await chmod(path, 0o755);
    }
  }
  // STORY-286: the adapter entries are accepted by their receipt's digests now, so a
  // complete fixture has to install a bundle AND record what it installed — which is the
  // whole point: "a directory is here" stopped being enough.
  for (const entry of INSTALL_MANIFEST.items.filter((item) => item.acceptanceProbe.startsWith("probe:adapter-bundle-digest"))) {
    const bundle = entry.pathTemplate.replaceAll("<PLATFORM_ROOT>", root).replaceAll("<HOME>", home);
    const relativeFile = `${entry.pathTemplate.replace("<PLATFORM_ROOT>/", "")}/project.json`;
    await writeFile(join(bundle, "project.json"), "{}\n");
    const receiptTemplate = /receipt=([^;]+)/u.exec(entry.acceptanceProbe)?.[1] ?? "";
    const receiptPath = receiptTemplate.replaceAll("<PLATFORM_ROOT>", root).replaceAll("<HOME>", home);
    await mkdir(join(receiptPath, ".."), { recursive: true });
    await writeFile(receiptPath, JSON.stringify({
      schemaVersion: "tcrn.adapter-installation-generation.v1",
      installationRoot: root,
      entries: [{ path: relativeFile, contentDigest: createHash("sha256").update(await readFile(join(bundle, "project.json"))).digest("hex") }],
    }));
  }
  // TCRN-CROSS-INC-220: a complete install now includes each host's harness, because
  // Owner ruled a host is under the harness from the moment it installs its adapter. The
  // fixture's idea of "complete" moves with that ruling rather than around it.
  if (harness) {
    // The handlers the roster names are stubbed INSIDE the fixture, so both renderings
    // point at files that exist and pass `node --check` here rather than reaching into
    // the developer's real checkout. A fixture whose hooks name absent targets would red
    // on executability and teach nothing about coverage.
    const fixtureRepo = join(root, "TCRN Platform", "tcrn-workflow");
    for (const host of HOSTS) {
      for (const entry of hookEntriesFor(host)) {
        const handler = join(fixtureRepo, entry.handler);
        await mkdir(join(handler, ".."), { recursive: true });
        await writeFile(handler, "export {}\n");
      }
    }
    await writeFile(join(root, ".claude", "settings.json"), `${JSON.stringify({
      hooks: claudeHookSettings(),
      permissions: { deny: GUARDED_TREES.map((tree) => `Write(//${tree}/**)`) },
    }, null, 2)}\n`);
    applyHostHarness("codex", root, { repoRoot: fixtureRepo });
  }
  await writeFile(join(root, "AGENTS.md"), `${topology}fixture\n`);
  await writeFile(join(root, "CLAUDE.md"), "@AGENTS.md\n");
  await mkdir(join(home, ".tcrn-workflow", "tcrn-workflow"), { recursive: true });
  await writeFile(join(home, ".tcrn-workflow", "tcrn-workflow", "package.json"), `${JSON.stringify({ version: engineVersion })}\n`);
  for (const host of [".agents", ".claude", ".codex"]) {
    await mkdir(join(home, host, "skills", "tcrn-workflow-helper"), { recursive: true });
    await writeFile(join(home, host, "skills", "tcrn-workflow-helper", "SKILL.md"), `Supports TCRN Workflow \`v${helperVersion}\`\n`);
  }
  return { root, home };
}

test("S264 four install-completeness legs are green on a synthetic full fixture", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  assert.equal(result.ok, true);
  assert.deepEqual(["helperCopies", "installWiring", "hooks", "deploymentFreshness"].map((name) => result.checks.find((item) => item.name === name).ok), [true, true, true, true]);
});

test("S264 each install-completeness leg has a distinct synthetic red reason", async (context) => {
  const wiring = await completeInstallFixture(context);
  const wiringResult = await inspectPlatform(wiring.root, { homeRoot: wiring.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  // INC-207 moved the harness to the container root, so the deleted item is a
  // container one now; joi-button no longer carries a declared settings file.
  await rm(join(wiring.root, ".claude", "settings.json"));
  const wiringRed = await inspectPlatform(wiring.root, { homeRoot: wiring.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  assert.equal(wiringResult.ok, true);
  assert.equal(wiringRed.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");

  const stale = await completeInstallFixture(context, { engineVersion: "0.11.14" });
  const staleRed = await inspectPlatform(stale.root, { homeRoot: stale.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  assert.equal(staleRed.reasonCode, "PLATFORM_DEPLOYMENT_STALE");

  const helper = await completeInstallFixture(context);
  await rm(join(helper.home, ".codex", "skills", "tcrn-workflow-helper"), { recursive: true, force: true });
  const helperRed = await inspectPlatform(helper.root, { homeRoot: helper.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  assert.equal(helperRed.reasonCode, "PLATFORM_HELPER_COPIES_INCOMPLETE");

  const launchd = await completeInstallFixture(context);
  const launchdRed = await inspectPlatform(launchd.root, { homeRoot: launchd.home, launchdLabels: [] });
  assert.equal(launchdRed.reasonCode, "PLATFORM_LAUNCHD_NOT_ON_DUTY");
});

test("INC-206 an undeclared harness inside the governed area is red, and an unrelated project's is not", async (context) => {
  const fixture = await completeInstallFixture(context);
  const surface = (result) => result.checks.find((entry) => entry.name === "harnessSurface");

  const green = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  assert.equal(surface(green).ok, true);

  // The classification folder is governed by position: it is on the path from the
  // container root to declared projects. This is the exact shape that sat live and
  // unseen for four days after the container moved.
  await mkdir(join(fixture.root, "TCRN Platform", ".claude"), { recursive: true });
  await writeFile(join(fixture.root, "TCRN Platform", ".claude", "settings.json"), "{}\n", "utf8");
  const strayRed = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  assert.equal(surface(strayRed).ok, false);
  assert.equal(surface(strayRed).reasonCode, "PLATFORM_HARNESS_UNDECLARED");
  assert.ok(surface(strayRed).undeclared.includes(join("TCRN Platform", ".claude")));
  await rm(join(fixture.root, "TCRN Platform", ".claude"), { recursive: true, force: true });

  // The container also holds projects this platform does not govern. Reporting their
  // harness would train the reader to skip the leg, so the governed area is derived
  // from the manifest's own project roots rather than from "everything below here".
  await mkdir(join(fixture.root, "unrelated-project", ".claude"), { recursive: true });
  await writeFile(join(fixture.root, "unrelated-project", ".claude", "settings.json"), "{}\n", "utf8");
  const unrelated = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  assert.equal(surface(unrelated).ok, true, "an unrelated project's own harness is not the platform's business");
});

test("INC-195 the snapshot train is owed only when a chain declares an automatic cadence", async (context) => {
  const fixture = await completeInstallFixture(context);
  const partitions = ["cross-project", "TCRN-AOS", "TCRN-Design-System", "TCRN-TMS", "Joi-Button"];
  const allManual = Object.fromEntries(partitions.map((name) => [name, "manual"]));
  const launchd = (result) => result.checks.find((entry) => entry.name === "launchd");

  // Declared manual: an off-duty train is the declaration being honoured, not a
  // defect. Green, but it has to say so — a silent pass would be the roster-shaped
  // outcome Owner ruled against.
  const manual = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [], declaredBackupCadence: allManual });
  assert.equal(launchd(manual).ok, true);
  assert.equal(launchd(manual).reasonCode, "PLATFORM_BACKUP_DECLARED_MANUAL");
  assert.equal(launchd(manual).onDuty, false);
  assert.equal(launchd(manual).freshnessAsserted, false);
  // "supplied" rather than "chain-declaration": the field distinguishes a value
  // this fixture injected from one actually read off a chain, so a synthetic run
  // can never be mistaken for evidence about the real platform.
  assert.equal(launchd(manual).cadenceSource, "supplied");

  // Either automatic cadence still owes a train.
  for (const cadence of ["gate-close", "session-end"]) {
    const automatic = await inspectPlatform(fixture.root, {
      homeRoot: fixture.home,
      launchdLabels: [],
      declaredBackupCadence: { ...allManual, "TCRN-AOS": cadence },
    });
    assert.equal(launchd(automatic).ok, false);
    assert.equal(launchd(automatic).reasonCode, "PLATFORM_LAUNCHD_NOT_ON_DUTY");
  }

  // Freshness is asserted only against an automatic expectation; under `manual`
  // the last snapshot is reported rather than required.
  const staleButManual = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [],
    declaredBackupCadence: allManual,
    localSnapshotFreshness: { ok: false, latestAt: "2020-01-01T00:00:00Z", ageHours: 99_999 },
  });
  assert.equal(launchd(staleButManual).ok, true);

  // The declaration may only relax. When it cannot be read the strict
  // expectation stands, and the report names the read as unreadable.
  const unreadable = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [], engineCli: "/nonexistent/engine.mjs" });
  assert.equal(launchd(unreadable).ok, false);
  assert.equal(launchd(unreadable).reasonCode, "PLATFORM_LAUNCHD_NOT_ON_DUTY");
  assert.equal(launchd(unreadable).cadenceSource, "unreadable");
});

test("S264 manifest mutation is automatically probed by the wiring leg", async (context) => {
  const fixture = await completeInstallFixture(context);
  const extra = {
    id: "project.synthetic-new-surface",
    layer: "project",
    host: "shared",
    pathTemplate: "<PLATFORM_ROOT>/synthetic-new-surface/required.txt",
    writer: "engine-adapter",
    acceptanceProbe: "synthetic probe",
  };
  const manifest = { ...INSTALL_MANIFEST, items: [...INSTALL_MANIFEST.items, extra] };
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT, manifest });
  assert.equal(result.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");
  assert.equal(result.checks.find((item) => item.name === "installWiring").missing.some((item) => item.id === extra.id), true);
});

test("S267 hook leg expands the container root and checks all four root-bound events", async (context) => {
  const fixture = await completeInstallFixture(context);
  await mkdir(join(fixture.root, "scripts"), { recursive: true });
  await writeFile(join(fixture.root, "scripts", "hook.mjs"), "export {}\n");
  await writeFile(join(fixture.root, ".claude", "settings.json"), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/scripts/hook.mjs"' }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/scripts/hook.mjs"' }] }],
    PreToolUse: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/scripts/hook.mjs"' }] }],
    Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/scripts/hook.mjs"' }] }],
  } }));
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  const hooks = result.checks.find((item) => item.name === "hooks");
  assert.equal(hooks.ok, true);
  assert.equal(hooks.checked, 4);
  assert.deepEqual(hooks.events, ["PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
});

test("S267 hook leg turns red for a missing target independently", async (context) => {
  const fixture = await completeInstallFixture(context);
  await writeFile(join(fixture.root, ".claude", "settings.json"), JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/scripts/missing.mjs"' }] }],
  } }));
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  assert.equal(result.reasonCode, "PLATFORM_HOOK_TARGET_UNAVAILABLE");
  assert.equal(result.checks.find((item) => item.name === "hooks").failures[0].event, "Stop");
});

test("S267 missing settings stays a wiring red leg and does not become a hook false green", async (context) => {
  const fixture = await completeInstallFixture(context);
  await rm(join(fixture.root, ".claude", "settings.json"));
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  assert.equal(result.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");
  assert.equal(result.checks.find((item) => item.name === "hooks").ok, true);
  assert.equal(result.checks.find((item) => item.name === "hooks").deferredTo, "installWiring");
});

test("S269 launchd is green only when the manifest duty, exit status, and fresh success state agree", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    launchdStatus: { lastExitCode: 0 },
    backupFreshness: { ok: true, latestBackupAt: "synthetic", ageHours: 0 },
  });
  const launchd = result.checks.find((item) => item.name === "launchd");
  assert.equal(launchd.ok, true);
  assert.equal(launchd.requiredLabel, launchdLabel);
  assert.equal(result.ok, true);
});

test("S269 launchd recent failure is distinct from absence", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    launchdStatus: { lastExitCode: 1 },
    backupFreshness: { ok: true, latestBackupAt: "synthetic", ageHours: 0 },
  });
  assert.equal(result.reasonCode, "PLATFORM_LAUNCHD_LAST_RUN_FAILED");
});

test("S269 launchd absence remains its own duty red leg", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [],
    launchdStatus: { lastExitCode: 0 },
    backupFreshness: { ok: true, latestBackupAt: "synthetic", ageHours: 0 },
  });
  assert.equal(result.reasonCode, "PLATFORM_LAUNCHD_NOT_ON_DUTY");
});

test("S269 stale successful-output state is red after a successful scheduler exit", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    launchdStatus: { lastExitCode: 0 },
    backupFreshness: { ok: false, latestBackupAt: null, ageHours: Number.POSITIVE_INFINITY, stateOk: false },
  });
  assert.equal(result.reasonCode, "PLATFORM_LAUNCHD_SNAPSHOT_STALE");
  assert.equal(result.checks.find((item) => item.name === "launchd").reasonCode, "PLATFORM_LAUNCHD_SNAPSHOT_STALE");
});

test("S269 launchd label mutation is followed from the manifest", async (context) => {
  const fixture = await completeInstallFixture(context);
  const manifest = {
    ...INSTALL_MANIFEST,
    items: INSTALL_MANIFEST.items.map((entry) => entry.id === "machine.launchd-local-snapshot"
      ? { ...entry, acceptanceProbe: "probe:launchd-duty;label=synthetic.launchd;maxAgeHours=26" }
      : entry),
  };
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    manifest,
    launchdLabels: ["synthetic.launchd"],
    launchdStatus: { lastExitCode: 0 },
    backupFreshness: { ok: true, latestBackupAt: "synthetic", ageHours: 0 },
  });
  const launchd = result.checks.find((item) => item.name === "launchd");
  assert.equal(launchd.ok, true);
  assert.equal(launchd.requiredLabel, "synthetic.launchd");
});

test("S270 install wiring executes every safe manifest probe, including codex config and three launchers", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  const wiring = result.checks.find((item) => item.name === "installWiring");
  assert.equal(wiring.ok, true);
  assert.equal(wiring.itemCount, INSTALL_MANIFEST.items.length);
  assert.equal(wiring.probes, "safe-manifest-expression");
});

test("S270 helper copies reject a declared digest mismatch", async (context) => {
  const fixture = await completeInstallFixture(context);
  const agents = join(fixture.home, ".agents", "skills", "tcrn-workflow-helper", "SKILL.md");
  const claude = join(fixture.home, ".claude", "skills", "tcrn-workflow-helper", "SKILL.md");
  const codex = join(fixture.home, ".codex", "skills", "tcrn-workflow-helper", "SKILL.md");
  const digests = {
    "machine.agents-skill": createHash("sha256").update(await readFile(agents)).digest("hex"),
    "machine.claude-skill": createHash("sha256").update(await readFile(claude)).digest("hex"),
    "machine.codex-skill": createHash("sha256").update(await readFile(codex)).digest("hex"),
  };
  await writeFile(codex, "tampered synthetic helper\n");
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    enforceHelperDigest: true,
    helperSkillDigests: digests,
  });
  assert.equal(result.reasonCode, "PLATFORM_HELPER_COPY_DIGEST_MISMATCH");
  assert.equal(result.checks.find((item) => item.name === "helperCopies").mismatched[0].id, "machine.codex-skill");
});

test("S270 lstat plus file-kind probing rejects a directory in a file residence", async (context) => {
  const fixture = await completeInstallFixture(context);
  const config = join(fixture.home, ".codex", "config.toml");
  await rm(config);
  await mkdir(config);
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  assert.equal(result.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");
  assert.equal(result.checks.find((item) => item.name === "installWiring").invalid.find((item) => item.id === "machine.codex-config").reasonCode, "PLATFORM_INSTALL_WIRING_NOT_FILE");
});

test("S270 unsupported acceptanceProbe syntax is a red leg rather than a shell execution", async (context) => {
  const fixture = await completeInstallFixture(context);
  const manifest = {
    ...INSTALL_MANIFEST,
    items: INSTALL_MANIFEST.items.map((entry) => entry.id === "machine.codex-config" ? { ...entry, acceptanceProbe: "node -e arbitrary" } : entry),
  };
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, manifest, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  assert.equal(result.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");
  assert.equal(result.checks.find((item) => item.name === "installWiring").invalid.find((item) => item.id === "machine.codex-config").reasonCode, "PLATFORM_ACCEPTANCE_PROBE_INVALID");
});

async function installTrustedHelperSource(fixture) {
  const skill = await readFile(join(fixture.home, ".agents", "skills", "tcrn-workflow-helper", "SKILL.md"));
  const archive = {
    entries: [{ path: "SKILL.md", contentBase64: skill.toString("base64"), sha256: createHash("sha256").update(skill).digest("hex") }],
    schemaVersion: "tcrn.workflow.helper.archive.v1",
  };
  const archiveBytes = Buffer.from(JSON.stringify(archive), "utf8");
  await writeFile(join(fixture.home, ".tcrn-workflow", "skill-archive.json"), archiveBytes);
  await writeFile(join(fixture.home, ".tcrn-workflow", "state.json"), JSON.stringify({
    schemaVersion: "tcrn.workflow.helper.state.v1",
    verifiedArchiveSha256: createHash("sha256").update(archiveBytes).digest("hex"),
  }));
}

test("INC-161 helper digest probe resolves from the trusted archive/state and fails closed", async (context) => {
  const fixture = await completeInstallFixture(context);
  await installTrustedHelperSource(fixture);
  const options = { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT, enforceHelperDigest: true };
  const green = await inspectPlatform(fixture.root, options);
  const greenCheck = green.checks.find((item) => item.name === "helperCopies");
  assert.equal(greenCheck.ok, true);
  assert.equal(greenCheck.source, "trusted-archive-state");
  assert.match(greenCheck.archiveDigest, /^[a-f0-9]{64}$/u);

  await writeFile(join(fixture.home, ".codex", "skills", "tcrn-workflow-helper", "SKILL.md"), "tampered trusted helper\n");
  const tampered = await inspectPlatform(fixture.root, options);
  assert.equal(tampered.reasonCode, "PLATFORM_HELPER_COPY_DIGEST_MISMATCH");

  await rm(join(fixture.home, ".tcrn-workflow", "skill-archive.json"));
  const missingRoot = await inspectPlatform(fixture.root, options);
  assert.equal(missingRoot.reasonCode, "PLATFORM_TRUST_ROOT_MISSING");

  await installTrustedHelperSource(fixture);
  await writeFile(join(fixture.home, ".tcrn-workflow", "state.json"), JSON.stringify({
    schemaVersion: "tcrn.workflow.helper.state.v1",
    verifiedArchiveSha256: "0".repeat(64),
  }));
  const mismatchedState = await inspectPlatform(fixture.root, options);
  assert.equal(mismatchedState.reasonCode, "PLATFORM_TRUST_ROOT_STATE_MISMATCH");
});

test("S273 trust archive freshness compares the archive to all installed consumers and marker versions", async (context) => {
  const fixture = await completeInstallFixture(context);
  const skillPath = join(fixture.home, ".agents", "skills", "tcrn-workflow-helper", "SKILL.md");
  const skill = await readFile(skillPath);
  const entry = { path: "SKILL.md", contentBase64: skill.toString("base64"), sha256: createHash("sha256").update(skill).digest("hex") };
  await writeFile(join(fixture.home, ".tcrn-workflow", "skill-archive.json"), JSON.stringify({ schemaVersion: "tcrn.workflow.helper.archive.v1", entries: [entry] }));
  for (const host of ["claude", "codex"]) await writeFile(join(fixture.home, ".tcrn-workflow", `installed-copy-${host}.json`), JSON.stringify({ version: "v0.11.14" }));
  await writeFile(join(fixture.home, ".agents", "skills", "tcrn-workflow-helper", "extra.md"), "drift\n");
  const red = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT, enforceTrustArchive: true });
  const redCheck = red.checks.find((item) => item.name === "trustArchive");
  assert.equal(redCheck.ok, false);
  assert.equal(redCheck.reasonCode, "PLATFORM_TRUST_ARCHIVE_STALE");
  assert.equal(redCheck.consumerProblems.length > 0, true);
});

test("STORY-286 the hook leg reads codex too, and absence is deferral rather than health", async (context) => {
  // The leg only ever read the Claude settings, so a codex host could carry a broken hook
  // while the doctor called the platform healthy. Codex writes an exact .codex/hooks.json
  // at activation; its commands carry resolved absolute paths rather than a placeholder.
  //
  // harness:false on purpose — INC-220 made a complete fixture carry the harness, and the
  // harness shares .codex/hooks.json with activation. This leg is about the state before
  // either has written it, so the scenario now has to be asked for rather than assumed.
  const fixture = await completeInstallFixture(context, { harness: false });
  await mkdir(join(fixture.root, "scripts"), { recursive: true });
  await writeFile(join(fixture.root, "scripts", "hook.mjs"), "export {}\n");
  await writeFile(join(fixture.root, ".claude", "settings.json"), JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/scripts/hook.mjs"' }] }],
  } }));

  // The adapter bundle installs inert and activation is a separate governed step, so a
  // container with no hooks file has not failed anything — it has not been activated.
  const absent = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  const absentHooks = absent.checks.find((item) => item.name === "hooks");
  assert.equal(absentHooks.ok, true);
  assert.equal(absentHooks.codex.state, "absent", "not activated is not the same claim as passed");

  await mkdir(join(fixture.root, ".codex"), { recursive: true });
  await writeFile(join(fixture.root, ".codex", "hooks.json"), JSON.stringify({ hooks: {
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `node "${join(fixture.root, "scripts", "hook.mjs")}"` }] }],
  } }));
  const live = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  const liveHooks = live.checks.find((item) => item.name === "hooks");
  assert.equal(liveHooks.ok, true);
  assert.equal(liveHooks.codex.state, "live");
  assert.deepEqual(liveHooks.codex.events, ["SessionStart"]);
});

test("STORY-286 a registered codex hook whose target cannot run turns the leg red", async (context) => {
  // Activation wrote the file, so something is registered and unrunnable — a finding of
  // its own, and distinct from never having been activated.
  const fixture = await completeInstallFixture(context);
  await writeFile(join(fixture.root, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
  await mkdir(join(fixture.root, ".codex"), { recursive: true });
  await writeFile(join(fixture.root, ".codex", "hooks.json"), JSON.stringify({ hooks: {
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `node "${join(fixture.root, "scripts", "missing.mjs")}"` }] }],
  } }));
  const missing = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  const missingHooks = missing.checks.find((item) => item.name === "hooks");
  assert.equal(missingHooks.ok, false);
  assert.equal(missingHooks.reasonCode, "PLATFORM_HOOK_TARGET_UNAVAILABLE");
  assert.equal(missingHooks.source, "container.codex-hooks");

  await writeFile(join(fixture.root, ".codex", "hooks.json"), "{ not json");
  const invalid = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT });
  const invalidHooks = invalid.checks.find((item) => item.name === "hooks");
  assert.equal(invalidHooks.ok, false);
  assert.equal(invalidHooks.reasonCode, "PLATFORM_CODEX_HOOKS_INVALID");
});

test("STORY-286 an adapter bundle is accepted by its receipt's digests, not by existing", async (context) => {
  // INC-208 recorded the ceiling: the two adapter entries accepted a directory merely
  // being there, so a bundle whose bytes had been edited passed. The receipt names each
  // installed file with a content digest, which makes acceptance mean "still what was
  // installed" rather than "something is at this path".
  const fixture = await completeInstallFixture(context);
  const bundle = join(fixture.root, ".codex", "tcrn-workflow");
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, "project.json"), "{}\n");
  const receiptDir = join(fixture.root, ".tcrn-artifacts", "install-receipts", "platform-container");
  await mkdir(receiptDir, { recursive: true });
  const digestOf = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
  const receiptPath = join(receiptDir, "codex.json");
  const writeReceipt = async () => writeFile(receiptPath, JSON.stringify({
    schemaVersion: "tcrn.codex-adapter-installation-generation.v1",
    installationRoot: fixture.root,
    entries: [{ path: ".codex/tcrn-workflow/project.json", contentDigest: await digestOf(join(bundle, "project.json")) }],
  }));
  await writeReceipt();

  const entry = {
    id: "container.codex-adapter-under-test",
    layer: "container",
    host: "codex",
    pathTemplate: "<PLATFORM_ROOT>/.codex/tcrn-workflow",
    writer: "engine-adapter",
    acceptanceProbe: "probe:adapter-bundle-digest;receipt=<PLATFORM_ROOT>/.tcrn-artifacts/install-receipts/platform-container/codex.json",
  };
  const manifest = { ...INSTALL_MANIFEST, items: [...INSTALL_MANIFEST.items, entry] };
  const wiring = async () => {
    const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT, manifest });
    return result.checks.find((item) => item.name === "installWiring");
  };

  assert.equal((await wiring()).ok, true, "an untouched bundle matches its receipt");

  await writeFile(join(bundle, "project.json"), "{}\n\n");
  const drifted = await wiring();
  assert.equal(drifted.ok, false);
  const finding = drifted.invalid.find((item) => item.id === entry.id);
  assert.equal(finding.reasonCode, "PLATFORM_ADAPTER_BUNDLE_DRIFTED");
  assert.equal(finding.drifted[0].path, ".codex/tcrn-workflow/project.json", "a drift names the file");

  await writeReceipt();
  assert.equal((await wiring()).ok, true, "re-recording the receipt accepts the new bytes deliberately");

  await writeFile(receiptPath, "{ not json");
  const unreadable = await wiring();
  assert.equal(unreadable.invalid.find((item) => item.id === entry.id).reasonCode, "PLATFORM_ADAPTER_RECEIPT_UNREADABLE",
    "an unreadable receipt is the finding; it never falls back to the directory being there");
});

// TCRN-CROSS-INC-219 — identity drift is reported beside the verdict, never inside it.
// The observation leg is exercised directly against a synthetic receipt so it needs no
// platform container: the question is only whether a drifted identity is named and
// whether naming it can move the verdict.

test("an identity drift is named as an observation, with the moment it happened", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tcrn-doctor-identity-")));
  try {
    const installedDirectory = join(root, ".codex", "tcrn-workflow");
    await mkdir(installedDirectory, { recursive: true });
    const installed = join(installedDirectory, "project.json");
    await writeFile(installed, "{}\n");
    const receiptPath = join(root, "receipt.json");
    const bytes = await readFile(installed);
    await writeFile(receiptPath, `${JSON.stringify({
      installationRoot: root,
      entries: [{
        path: ".codex/tcrn-workflow/project.json",
        contentDigest: createHash("sha256").update(bytes).digest("hex"),
        // A digest that cannot be the live one, so the leg must report.
        identityDigest: createHash("sha256").update("not-the-live-identity").digest("hex"),
      }],
    })}\n`);
    const manifest = {
      items: [{
        id: "container.codex-adapter",
        // Templates, exactly as the real manifest writes them: expandTemplate returns
        // null for a path carrying no <PLATFORM_ROOT>, so a raw path is silently skipped.
        pathTemplate: "<PLATFORM_ROOT>/.codex/tcrn-workflow",
        acceptanceProbe: "probe:adapter-bundle-digest;receipt=<PLATFORM_ROOT>/receipt.json",
      }],
    };
    const observations = await adapterIdentityObservations(manifest, root, root);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].reasonCode, "PLATFORM_ADAPTER_IDENTITY_DRIFTED");
    assert.equal(observations[0].path, ".codex/tcrn-workflow/project.json");
    assert.equal(observations[0].remedy, "adapter-rebind", "and it names the governed way back");
    assert.ok(!Number.isNaN(Date.parse(observations[0].modifiedAt)), "with the timestamp that moved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a matching identity produces no observation at all", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tcrn-doctor-identity-")));
  try {
    const installedDirectory = join(root, ".codex", "tcrn-workflow");
    await mkdir(installedDirectory, { recursive: true });
    const installed = join(installedDirectory, "project.json");
    await writeFile(installed, "{}\n");
    const stats = await lstat(installed);
    const receiptPath = join(root, "receipt.json");
    await writeFile(receiptPath, `${JSON.stringify({
      installationRoot: root,
      entries: [{
        path: ".codex/tcrn-workflow/project.json",
        contentDigest: createHash("sha256").update(await readFile(installed)).digest("hex"),
        identityDigest: canonicalSha256({
          dev: String(stats.dev),
          ino: String(stats.ino),
          size: String(stats.size),
          mtimeMs: String(stats.mtimeMs),
          ctimeMs: String(stats.ctimeMs),
        }),
      }],
    })}\n`);
    const manifest = {
      items: [{
        id: "container.codex-adapter",
        // Templates, exactly as the real manifest writes them: expandTemplate returns
        // null for a path carrying no <PLATFORM_ROOT>, so a raw path is silently skipped.
        pathTemplate: "<PLATFORM_ROOT>/.codex/tcrn-workflow",
        acceptanceProbe: "probe:adapter-bundle-digest;receipt=<PLATFORM_ROOT>/receipt.json",
      }],
    };
    assert.deepEqual(await adapterIdentityObservations(manifest, root, root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// TCRN-CROSS-MIN-102 批0. The alignment leg has to be able to go red, and it has to
// go red for the one condition that actually bites: a copy older than what a chain
// declares it needs. Its green case is deliberately two different greens — nothing
// declared (enforcing nothing, and saying so) versus declared and satisfied — so a
// run can never report "aligned" when no floor exists to be aligned against.
test("MIN-102 engine alignment names a copy that is behind a chain declaration", async (context) => {
  const fixture = await completeInstallFixture(context);
  const alignment = (result) => result.checks.find((entry) => entry.name === "engineAlignment");
  const copies = { installed: "0.11.15", worktree: "0.11.15" };

  // Undeclared is green, but never a silent green: the reason code says the leg is
  // enforcing nothing, and requirementAsserted records that in the verdict itself.
  const undeclared = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    engineCopyVersions: copies,
    engineRequiredVersions: { "cross-project": null },
  });
  assert.equal(alignment(undeclared).ok, true);
  assert.equal(alignment(undeclared).reasonCode, "PLATFORM_ENGINE_REQUIREMENT_UNDECLARED");
  assert.equal(alignment(undeclared).requirementAsserted, false);

  // A satisfied declaration is the other green, and it asserts.
  const satisfied = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    engineCopyVersions: copies,
    engineRequiredVersions: { "cross-project": "0.11.15" },
  });
  assert.equal(alignment(satisfied).ok, true);
  assert.equal(alignment(satisfied).requirementAsserted, true);
  assert.deepEqual(alignment(satisfied).declaringPartitions, ["cross-project"]);

  // The red leg: one copy behind one partition's floor. Both the partition and the
  // offending copy are named, because "something is stale" is not actionable.
  const behind = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    engineCopyVersions: { installed: "0.11.15", worktree: "0.12.0" },
    engineRequiredVersions: { "cross-project": "0.12.0" },
  });
  assert.equal(behind.ok, false);
  assert.equal(alignment(behind).ok, false);
  assert.equal(alignment(behind).reasonCode, "PLATFORM_ENGINE_BEHIND_CHAIN");
  assert.deepEqual(alignment(behind).behind, [
    { partition: "cross-project", required: "0.12.0", copy: "installed", version: "0.11.15", reason: "BEHIND" },
  ]);

  // Semantic precedence, not string order: 0.11.15 vs 0.9.0 is the case a lexical
  // compare gets backwards, and it is exactly the shape a real version bump takes.
  const lexicalTrap = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    engineCopyVersions: { installed: "0.11.15" },
    engineRequiredVersions: { "cross-project": "0.9.0" },
  });
  assert.equal(lexicalTrap.ok, true);
  assert.equal(alignment(lexicalTrap).ok, true);
});

// MIN-103. The Helper's own suite used to check its settings teaching against the
// engine by reading a sibling checkout — forbidden by the dependency-direction rule
// and impossible in the Helper's CI, which checks out one repository. It was ENOENT
// there and green locally, so three consecutive pushes were red on a check that
// could only pass on a developer machine. The question is legitimate; the layer was
// wrong. Here both trees are in scope by design, so here is where it is asked.
test("MIN-103 the platform names a setting the placed Helper never teaches", async (context) => {
  const fixture = await completeInstallFixture(context);
  const coverage = (result) => result.checks.find((entry) => entry.name === "helperSettingsCoverage");
  const catalog = ["backup.cadence", "conference.positionBudgetBytes", "design.authority"];

  const taught = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    helperSettingKeys: { catalog, taught: catalog },
  });
  assert.equal(coverage(taught).ok, true);
  assert.equal(coverage(taught).coverageAsserted, true);

  // The red leg: the engine registered a key and the payload never mentions it, so
  // an operator would meet a setting no guidance covers.
  const gap = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    helperSettingKeys: { catalog, taught: ["backup.cadence", "design.authority"] },
  });
  assert.equal(gap.ok, false);
  assert.equal(coverage(gap).ok, false);
  assert.equal(coverage(gap).reasonCode, "PLATFORM_HELPER_SETTINGS_UNTAUGHT");
  assert.deepEqual(coverage(gap).untaught, ["conference.positionBudgetBytes"]);

  // A payload teaching more than the catalog registers is not a fault: the Helper
  // may still carry guidance for a key a given engine build does not ship.
  const extra = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    helperSettingKeys: { catalog, taught: [...catalog, "some.future.key"] },
  });
  assert.equal(coverage(extra).ok, true);
});

// TCRN-CROSS-INC-233. Two internal-consistency checks were green while every host ran a
// skill payload from the day before. `helperCopies` proves the deployed copies match the
// locally trusted archive; `deploymentFreshness` proves the engine version string agrees
// across them. Neither can see a trust root and its deployed copies going stale together,
// which is what happened -- and the payload can move without the version string moving at
// all, which is what made it invisible.
//
// The leg these criteria pin makes the one comparison nobody was making: the locally
// trusted archive against what the helper repository has actually released.
test("INC-233: helper release alignment separates stale, aligned, uncomparable and missing", async (context) => {
  const fixture = await completeInstallFixture(context);
  const leg = (result) => result.checks.find((entry) => entry.name === "helperReleaseAlignment");
  const run = (helperReleaseAlignment) => inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    helperReleaseAlignment,
  });

  // Stale: the state this platform was actually in on 2026-08-19, with both existing
  // checks green. Red leg: drop the inequality branch and it reads as aligned.
  const stale = leg(await run({ published: "a".repeat(64), trusted: "b".repeat(64) }));
  assert.equal(stale.ok, false);
  assert.equal(stale.reasonCode, "PLATFORM_HELPER_PAYLOAD_STALE");
  assert.equal(stale.published, "a".repeat(12));
  assert.equal(stale.trusted, "b".repeat(12));
  // The remedy must say deploying is an Owner stop. A red whose obvious fix looks like
  // something the reader may simply do is how a separate stop gets inferred from a gate.
  assert.match(stale.remedy, /Owner stop/u);

  // Aligned. Red leg: return ok on any input and the leg stops distinguishing anything.
  const digest = "c".repeat(64);
  const aligned = leg(await run({ published: digest, trusted: digest }));
  assert.equal(aligned.ok, true);
  assert.equal(aligned.comparable, true);
  assert.equal(aligned.digest, "c".repeat(12));

  // A container that consumes the helper without checking it out cannot compare and must
  // not be failed for that -- but "nothing to compare" must never read as "compared and
  // equal". Red leg: drop `comparable` and those two answers become one.
  const uncomparable = leg(await run({ published: null, trusted: "d".repeat(64) }));
  assert.equal(uncomparable.ok, true, "a consumer container is not broken");
  assert.equal(uncomparable.comparable, false);
  assert.match(uncomparable.reason, /unknown here/u);

  // Red leg: treat a missing trust root as uncomparable too, and a host with no installed
  // helper at all reports the same green as one that is correctly aligned.
  const missing = leg(await run({ published: "e".repeat(64), trusted: null }));
  assert.equal(missing.ok, false);
  assert.equal(missing.reasonCode, "PLATFORM_HELPER_TRUST_ROOT_MISSING");
});

// TCRN-CROSS-INC-224. Headroom is reported before the wall, not at it.
//
// The cap moved from 10,000 to 20,000 on measured evidence that replay is linear. That
// buys time rather than removing the ceiling, so the thing worth gating is not the
// ceiling but the moment there is still room to decide what happens at it. INC-224 was
// found by someone counting; this leg is so the next one is found by being told.
test("INC-224: headroom passes below the trigger and names the largest chain", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    chainEventCounts: { "cross-project": 4316, "TCRN-AOS": 1054, "TCRN-TMS": 243 },
  });
  const leg = result.checks.find((entry) => entry.name === "chainHeadroom");
  assert.equal(leg.ok, true);
  assert.equal(leg.trigger, 15_000);
  assert.deepEqual(leg.largest, { partition: "cross-project", events: 4316 });
});

// Red leg: compare against the ceiling instead of the trigger and this passes at 19,999,
// leaving one event of notice for a decision that needs weeks.
test("INC-224: crossing the trigger is red, with the remaining headroom and whose call it is", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    chainEventCounts: { "cross-project": 15_001, "TCRN-AOS": 1054 },
  });
  const leg = result.checks.find((entry) => entry.name === "chainHeadroom");
  assert.equal(leg.ok, false);
  assert.equal(leg.reasonCode, "PLATFORM_CHAIN_REVIEW_TRIGGER_REACHED");
  assert.deepEqual(leg.partitions, [{ partition: "cross-project", events: 15_001, headroom: 4_999 }]);
  // The remedy must say the disposition is Owner's. A red that reads as a chore gets
  // treated as one, and the decision it exists to prompt is not a chore.
  assert.match(leg.remedy, /Owner decision/u);
});

// Red leg: report only the first partition over the trigger and a platform with two
// chains near the wall looks like a platform with one.
test("INC-224: every partition over the trigger is named, largest first", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT,
    chainEventCounts: { "TCRN-AOS": 16_000, "cross-project": 18_000, "TCRN-TMS": 243 },
  });
  const leg = result.checks.find((entry) => entry.name === "chainHeadroom");
  assert.equal(leg.ok, false);
  assert.deepEqual(leg.partitions.map((entry) => entry.partition), ["cross-project", "TCRN-AOS"]);
});

// TCRN-CROSS-INC-234. The lane could not tell "green" from "nobody looked".
//
// product-gates was red from 2026-08-17 and six records landed done against the
// nine-group criterion in that window, because nothing consults the roster at the moment
// it binds. This leg cannot verify a group is green -- only running it can -- so what it
// pins is narrower and is the failure that actually happened: an unrecorded run must not
// be indistinguishable from a passing one.
test("INC-234: missing, stale and red verdicts are each refused, and named", async (context) => {
  const fixture = await completeInstallFixture(context);
  const leg = (result) => result.checks.find((entry) => entry.name === "acceptanceVerdicts");
  const run = (acceptanceVerdicts) => inspectPlatform(fixture.root, {
    homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT, acceptanceVerdicts,
  });
  const fresh = new Date(Date.now()).toISOString();

  // No verdicts at all: the state on 2026-08-19, and the one this leg exists for.
  const none = leg(await run({ verdicts: {} }));
  assert.equal(none.ok, false);
  assert.equal(none.reasonCode, "PLATFORM_ACCEPTANCE_LANE_UNPROVEN");
  assert.equal(none.missing.length, 9, "every roster group is named as unrecorded");

  // A red verdict stays visible rather than being absorbed. Red leg: treat any recorded
  // entry as satisfaction and a group that ran and failed reads the same as one that passed.
  const withRed = { verdicts: Object.fromEntries(none.missing.map((id) => [id, { verdict: "green", recordedAt: fresh, commit: FIXTURE_COMMIT }])) };
  // The synthetic roster names its groups group-0..group-8; using a real group id here
  // would silently add an entry the roster does not contain and assert nothing.
  const [firstGroup] = none.missing;
  withRed.verdicts[firstGroup] = { verdict: "red", recordedAt: fresh, commit: FIXTURE_COMMIT, detail: "AOS verify" };
  const red = leg(await run(withRed));
  assert.equal(red.ok, false);
  assert.deepEqual(red.failing.map((entry) => entry.group), [firstGroup]);
  assert.equal(red.missing, undefined, "a red group is not also reported as missing");

  // Staleness, because a verdict from last month is a record of a different tree. Red
  // leg: drop the age comparison and one run certifies the lane forever.
  const withStale = { verdicts: Object.fromEntries(none.missing.map((id) => [id, { verdict: "green", recordedAt: fresh, commit: FIXTURE_COMMIT }])) };
  // STORY-304 rewrote staleness from a clock question into a tree question: a verdict
  // is stale when it names a commit other than the one being inspected. The old form
  // measured age from the roster file's own mtime and, measured on the live tree,
  // could never fire for any input at all.
  withStale.verdicts[firstGroup] = { verdict: "green", recordedAt: fresh, commit: "9".repeat(40) };
  const stale = leg(await run(withStale));
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.stale.map((entry) => entry.group), [firstGroup]);

  // All nine fresh and green is the only pass. Red leg: return ok unconditionally and the
  // leg stops distinguishing anything at all.
  const green = leg(await run({ verdicts: Object.fromEntries(none.missing.map((id) => [id, { verdict: "green", recordedAt: fresh, commit: FIXTURE_COMMIT }])) }));
  assert.equal(green.ok, true);
  assert.equal(green.groups, 9);
});

test("INC-246: an accepted red names its exact reason and does not exempt the group", async (context) => {
  const fixture = await completeInstallFixture(context);
  const rosterPath = join(fixture.root, "platform-docs", "acceptance-gate-groups.json");
  const roster = JSON.parse(await readFile(rosterPath, "utf8"));
  roster.groups[0].acceptedExceptions = [{
    acceptedAt: "2026-08-15",
    reasonCode: "PLATFORM_LAUNCHD_NOT_ON_DUTY",
    reason: "OWNER_RULING_BACKUP_LAYERS_STOPPED",
  }];
  await writeFile(rosterPath, `${JSON.stringify(roster, null, 2)}\n`);
  const fresh = new Date(Date.now()).toISOString();
  const verdicts = Object.fromEntries(roster.groups.map((group) => [group.id, {
    verdict: "green",
    recordedAt: fresh,
    commit: FIXTURE_COMMIT,
  }]));
  verdicts["group-0"] = {
    verdict: "red",
    recordedAt: fresh,
    commit: FIXTURE_COMMIT,
    detail: "node scripts/platform-doctor.mjs -> reasonCode=PLATFORM_LAUNCHD_NOT_ON_DUTY; requiredLabel=com.tcrn.platform.local-snapshot",
  };
  const acceptedResult = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel],
    acceptanceHeadCommit: FIXTURE_COMMIT,
    acceptanceVerdicts: { verdicts },
  });
  const acceptedLeg = acceptedResult.checks.find((entry) => entry.name === "acceptanceVerdicts");
  assert.equal(acceptedLeg.ok, true, JSON.stringify(acceptedLeg));
  assert.deepEqual(acceptedLeg.acceptedExceptions, [{
    group: "group-0",
    acceptedAt: "2026-08-15",
    reasonCode: "PLATFORM_LAUNCHD_NOT_ON_DUTY",
    reason: "OWNER_RULING_BACKUP_LAYERS_STOPPED",
  }]);

  verdicts["group-0"].detail = "node scripts/platform-doctor.mjs -> reasonCode=PLATFORM_LAUNCHD_LAST_RUN_FAILED; requiredLabel=com.tcrn.platform.local-snapshot";
  const unacceptedResult = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel],
    acceptanceHeadCommit: FIXTURE_COMMIT,
    acceptanceVerdicts: { verdicts },
  });
  const unacceptedLeg = unacceptedResult.checks.find((entry) => entry.name === "acceptanceVerdicts");
  assert.equal(unacceptedLeg.ok, false);
  assert.deepEqual(unacceptedLeg.failing.map((entry) => entry.group), ["group-0"]);
});

// The remedy has to say what a recorded verdict is and is not, or the file becomes a
// place to write "green" and move on. Red leg: drop the wording and the next reader
// treats the record as the proof.
test("INC-234: the refusal says a record of a run is not proof the run passed", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home, launchdLabels: [launchdLabel], acceptanceHeadCommit: FIXTURE_COMMIT, acceptanceVerdicts: { verdicts: {} },
  });
  const leg = result.checks.find((entry) => entry.name === "acceptanceVerdicts");
  assert.match(leg.remedy, /not proof the run passed/u);
});

// TCRN-CROSS-STORY-304. The acceptance-verdict leg has to be able to fail.
//
// It shipped anchoring freshness to the ROSTER FILE's mtime. Measured on the live tree
// before this repair: roster mtime 2026-08-19T07:29:56Z against every recordedAt
// 2026-08-20T02:30:00Z gave an age of -11.00 hours for all nine groups, so the 26-hour
// bound was unreachable for every input the leg could ever receive. A staleness check that
// cannot go red is not a weaker check; it is no check, reported as a passing one.
//
// It was also host-dependent: git does not track mtime, so a fresh clone stamps it with
// checkout time and the identical tree answers differently elsewhere -- the shape
// TCRN-CROSS-MIN-103 names, and the same host-dependence that made INC-238's link gate
// pass locally and fail in CI.
//
// The reference is now the engine commit a verdict names, compared against the commit
// being inspected. A git object id is a content hash, so the question has one answer on
// every host.
const boundVerdicts = (commit) => ({
  verdicts: Object.fromEntries(syntheticRoster().groups.map((group) => [
    group.id, { verdict: "green", recordedAt: "2026-08-20T02:30:00.000Z", commit },
  ])),
});

test("STORY-304: a verdict recorded against another commit is stale, and names both", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel],
    acceptanceHeadCommit: "a".repeat(40),
    acceptanceVerdicts: boundVerdicts("b".repeat(40)),
  });
  const leg = result.checks.find((entry) => entry.name === "acceptanceVerdicts");
  assert.equal(leg.ok, false);
  assert.equal(leg.reasonCode, "PLATFORM_ACCEPTANCE_LANE_UNPROVEN");
  assert.equal(leg.stale.length, 9, "every verdict recorded against another tree is stale");
  assert.equal(leg.stale[0].recordedAgainst, "b".repeat(12));
  assert.equal(leg.stale[0].head, "a".repeat(12), "and the commit it should have named is reported");
});

// Red leg: restore the mtime anchor and this passes for a verdict recorded against any
// tree at all -- the state all nine were in when v1.0.0 was tagged on a red commit.
test("STORY-304: verdicts recorded against the inspected commit pass", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel],
    acceptanceHeadCommit: "c".repeat(40),
    acceptanceVerdicts: boundVerdicts("c".repeat(40)),
  });
  const leg = result.checks.find((entry) => entry.name === "acceptanceVerdicts");
  assert.equal(leg.ok, true, JSON.stringify(leg));
  assert.equal(leg.head, "c".repeat(12), "a green verdict states which tree it is about");
});

// A verdict naming no commit is worse than a stale one: it cannot be told from a verdict
// recorded against any tree at all. Red leg: accept a missing commit and the leg goes back
// to admitting exactly the shape it had before this repair.
test("STORY-304: a verdict that names no commit is refused as unbound", async (context) => {
  const fixture = await completeInstallFixture(context);
  const unbound = boundVerdicts("d".repeat(40));
  const [first] = Object.keys(unbound.verdicts);
  delete unbound.verdicts[first].commit;
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel],
    acceptanceHeadCommit: "d".repeat(40),
    acceptanceVerdicts: unbound,
  });
  const leg = result.checks.find((entry) => entry.name === "acceptanceVerdicts");
  assert.equal(leg.ok, false);
  assert.deepEqual(leg.stale, [{ group: first, recordedAt: "2026-08-20T02:30:00.000Z", reason: "verdict names no commit" }]);
});

// A container with no readable engine checkout is not a platform whose lane has failed; it
// is one this leg cannot speak about. Red leg: report it as red and every synthetic fixture
// in this file turns red for a reason unrelated to what it tests -- which is what the first
// attempt at this repair actually did, to thirteen criteria at once.
test("STORY-304: an unreadable engine HEAD is not comparable rather than failed", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel],
    acceptanceVerdicts: boundVerdicts("e".repeat(40)),
  });
  const leg = result.checks.find((entry) => entry.name === "acceptanceVerdicts");
  assert.equal(leg.ok, true);
  assert.equal(leg.comparable, false);
  assert.match(leg.reason, /no readable engine HEAD/u);
});
