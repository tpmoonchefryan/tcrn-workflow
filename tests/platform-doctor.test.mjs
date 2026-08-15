// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectPlatform } from "../scripts/platform-doctor.mjs";
import { INSTALL_MANIFEST } from "../dist/build/packages/core/src/index.js";

const topology = "## 三、分区拓扑\n";
const launchdLabel = "com.tcrn.platform.local-snapshot";

async function fixture(context, { agents = `${topology}fixture\n`, chain = true, git = false, claude = "@AGENTS.md\n" } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-platform-doctor-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "platform");
  await mkdir(root, { recursive: true });
  if (agents !== null) await writeFile(join(root, "AGENTS.md"), agents);
  if (claude !== null) await writeFile(join(root, "CLAUDE.md"), claude);
  if (chain) await mkdir(join(root, ".tcrn-workspace", "cross-project", "workspace"), { recursive: true });
  if (git) await mkdir(join(root, ".git"));
  return root;
}

test("a complete synthetic platform container is green", async (context) => {
  const root = await fixture(context);
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, "PLATFORM_LAYOUT_HEALTHY");
  assert.deepEqual(result.checks.map((item) => item.ok), [true, true, true, true, true, true]);
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

async function completeInstallFixture(context, { engineVersion = "0.11.15", helperVersion = "0.11.15" } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-init033-doctor-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "platform");
  const home = join(base, "home");
  await mkdir(join(root, ".tcrn-workspace", "cross-project", "workspace"), { recursive: true });
  await mkdir(home, { recursive: true });
  for (const entry of INSTALL_MANIFEST.items) {
    const path = entry.pathTemplate.replaceAll("<PLATFORM_ROOT>", root).replaceAll("<HOME>", home);
    if (entry.acceptanceProbe.startsWith("probe:regular-directory") || entry.acceptanceProbe.startsWith("probe:helper-skill-digest") || entry.acceptanceProbe.startsWith("probe:engine-version")) await mkdir(path, { recursive: true });
    else {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "{}\n");
      if (entry.acceptanceProbe.startsWith("probe:regular-executable")) await chmod(path, 0o755);
    }
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
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel] });
  assert.equal(result.ok, true);
  assert.deepEqual(["helperCopies", "installWiring", "hooks", "deploymentFreshness"].map((name) => result.checks.find((item) => item.name === name).ok), [true, true, true, true]);
});

test("S264 each install-completeness leg has a distinct synthetic red reason", async (context) => {
  const wiring = await completeInstallFixture(context);
  const wiringResult = await inspectPlatform(wiring.root, { homeRoot: wiring.home, launchdLabels: [launchdLabel] });
  await rm(join(wiring.root, "joi-button", ".claude", "settings.json"));
  const wiringRed = await inspectPlatform(wiring.root, { homeRoot: wiring.home, launchdLabels: [launchdLabel] });
  assert.equal(wiringResult.ok, true);
  assert.equal(wiringRed.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");

  const stale = await completeInstallFixture(context, { engineVersion: "0.11.14" });
  const staleRed = await inspectPlatform(stale.root, { homeRoot: stale.home, launchdLabels: [launchdLabel] });
  assert.equal(staleRed.reasonCode, "PLATFORM_DEPLOYMENT_STALE");

  const helper = await completeInstallFixture(context);
  await rm(join(helper.home, ".codex", "skills", "tcrn-workflow-helper"), { recursive: true, force: true });
  const helperRed = await inspectPlatform(helper.root, { homeRoot: helper.home, launchdLabels: [launchdLabel] });
  assert.equal(helperRed.reasonCode, "PLATFORM_HELPER_COPIES_INCOMPLETE");

  const launchd = await completeInstallFixture(context);
  const launchdRed = await inspectPlatform(launchd.root, { homeRoot: launchd.home, launchdLabels: [] });
  assert.equal(launchdRed.reasonCode, "PLATFORM_LAUNCHD_NOT_ON_DUTY");
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
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], manifest });
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
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel] });
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
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel] });
  assert.equal(result.reasonCode, "PLATFORM_HOOK_TARGET_UNAVAILABLE");
  assert.equal(result.checks.find((item) => item.name === "hooks").failures[0].event, "Stop");
});

test("S267 missing settings stays a wiring red leg and does not become a hook false green", async (context) => {
  const fixture = await completeInstallFixture(context);
  await rm(join(fixture.root, ".claude", "settings.json"));
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel] });
  assert.equal(result.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");
  assert.equal(result.checks.find((item) => item.name === "hooks").ok, true);
  assert.equal(result.checks.find((item) => item.name === "hooks").deferredTo, "installWiring");
});

test("S269 launchd is green only when the manifest duty, exit status, and fresh success state agree", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectPlatform(fixture.root, {
    homeRoot: fixture.home,
    launchdLabels: [launchdLabel],
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
    launchdLabels: [launchdLabel],
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
    launchdLabels: [launchdLabel],
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
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel] });
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
    launchdLabels: [launchdLabel],
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
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel] });
  assert.equal(result.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");
  assert.equal(result.checks.find((item) => item.name === "installWiring").invalid.find((item) => item.id === "machine.codex-config").reasonCode, "PLATFORM_INSTALL_WIRING_NOT_FILE");
});

test("S270 unsupported acceptanceProbe syntax is a red leg rather than a shell execution", async (context) => {
  const fixture = await completeInstallFixture(context);
  const manifest = {
    ...INSTALL_MANIFEST,
    items: INSTALL_MANIFEST.items.map((entry) => entry.id === "machine.codex-config" ? { ...entry, acceptanceProbe: "node -e arbitrary" } : entry),
  };
  const result = await inspectPlatform(fixture.root, { homeRoot: fixture.home, manifest, launchdLabels: [launchdLabel] });
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
  const options = { homeRoot: fixture.home, launchdLabels: [launchdLabel], enforceHelperDigest: true };
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
  const red = await inspectPlatform(fixture.root, { homeRoot: fixture.home, launchdLabels: [launchdLabel], enforceTrustArchive: true });
  const redCheck = red.checks.find((item) => item.name === "trustArchive");
  assert.equal(redCheck.ok, false);
  assert.equal(redCheck.reasonCode, "PLATFORM_TRUST_ARCHIVE_STALE");
  assert.equal(redCheck.consumerProblems.length > 0, true);
});
