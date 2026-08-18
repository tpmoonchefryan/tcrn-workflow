#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The install manifest is the only path/residence authority. The doctor consumes
// the built public core so the same bytes are used by the CLI's install-manifest
// read surface and by this host probe; there is no second path table here.
import {
  INSTALL_MANIFEST,
  assertInstallManifestComplete,
  compareEngineVersions,
} from "../dist/build/packages/core/src/index.js";
// The identity digest is computed by the engine's own canonicaliser rather than
// reproduced here. A second implementation of a digest is a second answer waiting to
// disagree with the first (TCRN-CROSS-INC-219).
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import {
  HOSTS,
  claudeHarnessDrift,
  codexHookDocument,
  hookEntriesFor,
} from "./host-harness.mjs";

const execFileAsync = promisify(execFile);
const TOPOLOGY_SECTION_MARKER = "## 三、分区拓扑";

function check(name, ok, details = {}) {
  return { name, ok, ...details };
}

async function existingPath(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function expandTemplate(template, platformRoot, homeRoot) {
  if (typeof template !== "string") return null;
  if (!template.includes("<PLATFORM_ROOT>") && !template.includes("<HOME>")) return null;
  return resolve(template.replaceAll("<PLATFORM_ROOT>", platformRoot).replaceAll("<HOME>", homeRoot));
}

async function inspectAgents(root) {
  const path = join(root, "AGENTS.md");
  const stats = await existingPath(path);
  if (!stats) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const misplacedPath = join(root, entry.name, "AGENTS.md");
      const misplacedStats = await existingPath(misplacedPath);
      if (misplacedStats?.isFile() && (await readFile(misplacedPath, "utf8")).length === 0) {
        return check("platformAgents", false, {
          reasonCode: "PLATFORM_AGENTS_EMPTY",
          path: relative(root, misplacedPath),
          expectedPath: "AGENTS.md",
        });
      }
    }
    return check("platformAgents", false, { reasonCode: "PLATFORM_AGENTS_MISSING", path: "AGENTS.md" });
  }
  if (!stats.isFile()) return check("platformAgents", false, { reasonCode: "PLATFORM_AGENTS_NOT_FILE", path: "AGENTS.md" });
  const content = await readFile(path, "utf8");
  if (content.length === 0) return check("platformAgents", false, { reasonCode: "PLATFORM_AGENTS_EMPTY", path: "AGENTS.md" });
  if (!content.includes(TOPOLOGY_SECTION_MARKER)) {
    return check("platformAgents", false, {
      reasonCode: "PLATFORM_AGENTS_TOPOLOGY_SECTION_MISSING",
      path: "AGENTS.md",
      marker: TOPOLOGY_SECTION_MARKER,
    });
  }
  return check("platformAgents", true, { path: "AGENTS.md", marker: TOPOLOGY_SECTION_MARKER });
}

async function inspectWorkspaceContainer(root) {
  const containerPath = join(root, ".tcrn-workspace");
  const containerStats = await existingPath(containerPath);
  if (!containerStats || !containerStats.isDirectory()) {
    return check("workspaceContainer", false, { reasonCode: "WORKSPACE_CONTAINER_MISSING", path: ".tcrn-workspace" });
  }
  const entries = await readdir(containerPath, { withFileTypes: true });
  const partitions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    const workspaceStats = await existingPath(workspacePath);
    if (workspaceStats?.isDirectory()) partitions.push(entry.name);
  }
  if (partitions.length === 0) {
    return check("workspaceContainer", false, { reasonCode: "WORKSPACE_PARTITION_MISSING", path: ".tcrn-workspace" });
  }
  return check("workspaceContainer", true, { path: ".tcrn-workspace", partitions });
}

async function inspectGitAncestors(root) {
  const visited = [];
  let current = root;
  while (true) {
    visited.push(current);
    if (await existingPath(join(current, ".git"))) {
      return check("containerOutsideGit", false, { reasonCode: "PLATFORM_ROOT_INSIDE_GIT_REPOSITORY", gitAncestor: current });
    }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
  return check("containerOutsideGit", true, { ancestorsChecked: visited.length });
}

async function inspectClaudeBridge(root) {
  const path = join(root, "CLAUDE.md");
  const stats = await existingPath(path);
  if (!stats || !stats.isFile()) return check("claudeBridge", false, { reasonCode: "PLATFORM_CLAUDE_BRIDGE_MISSING", path: "CLAUDE.md" });
  const content = await readFile(path, "utf8");
  if (content.trim().length === 0) return check("claudeBridge", false, { reasonCode: "PLATFORM_CLAUDE_BRIDGE_EMPTY", path: "CLAUDE.md" });
  return check("claudeBridge", true, { path: "CLAUDE.md" });
}

async function inspectBridgeSyntax(root) {
  const candidates = [join(root, "AGENTS.md"), join(root, "CLAUDE.md")];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === ".tcrn-workspace") continue;
    candidates.push(join(root, entry.name, "AGENTS.md"), join(root, entry.name, "CLAUDE.md"));
  }
  const failures = [];
  for (const path of candidates) {
    const stats = await existingPath(path);
    if (!stats?.isFile()) continue;
    const lines = (await readFile(path, "utf8")).split(/\r?\n/u);
    for (const [index, rawLine] of lines.entries()) {
      const line = rawLine.trim();
      if (!line.startsWith("@")) continue;
      if (line.startsWith("@@")) {
        failures.push({
          path: relative(root, path),
          line: index + 1,
          lineText: rawLine,
          reasonCode: "PLATFORM_BRIDGE_SYNTAX_INVALID",
        });
        continue;
      }
      const targetText = line.slice(1).trim();
      const target = targetText.length > 0 ? resolve(dirname(path), targetText) : null;
      const targetStats = target === null ? null : await existingPath(target);
      if (!targetStats?.isFile()) {
        failures.push({
          path: relative(root, path),
          line: index + 1,
          lineText: rawLine,
          target: targetText,
          reasonCode: "PLATFORM_BRIDGE_TARGET_UNAVAILABLE",
        });
      }
    }
  }
  return failures.length === 0
    ? check("bridgeSyntax", true, { filesChecked: candidates.length, source: "platform-and-direct-child-bridges" })
    : check("bridgeSyntax", false, { reasonCode: failures[0].reasonCode, failures, source: "platform-and-direct-child-bridges" });
}

async function inspectInstallWiring(platformRoot, homeRoot, manifest) {
  const required = manifest.items;
  const missing = [];
  const invalid = [];
  for (const entry of required) {
    const path = expandTemplate(entry.pathTemplate, platformRoot, homeRoot);
    const stats = path === null ? null : await existingPath(path);
    if (!stats) {
      missing.push({ id: entry.id, pathTemplate: entry.pathTemplate, probe: entry.acceptanceProbe });
      continue;
    }
    const probe = parseAcceptanceProbe(entry.acceptanceProbe);
    if (!probe) {
      invalid.push({ id: entry.id, reasonCode: "PLATFORM_ACCEPTANCE_PROBE_INVALID", acceptanceProbe: entry.acceptanceProbe });
      continue;
    }
    if (["regular-file", "receipt-json", "trust-archive-freshness", "local-snapshot-freshness", "offsite-push-freshness", "launchd-duty", "regular-executable"].includes(probe.kind)) {
      if (!stats.isFile()) invalid.push({ id: entry.id, reasonCode: "PLATFORM_INSTALL_WIRING_NOT_FILE", pathTemplate: entry.pathTemplate, probe: probe.kind });
      else if (probe.kind === "regular-executable" && (stats.mode & 0o111) === 0) invalid.push({ id: entry.id, reasonCode: "PLATFORM_INSTALL_WIRING_NOT_EXECUTABLE", pathTemplate: entry.pathTemplate, probe: probe.kind });
      else if (["receipt-json", "trust-archive-freshness", "local-snapshot-freshness", "offsite-push-freshness"].includes(probe.kind)) {
        try {
          JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
          invalid.push({ id: entry.id, reasonCode: "PLATFORM_ACCEPTANCE_PROBE_FAILED", pathTemplate: entry.pathTemplate, probe: probe.kind, error: error?.code ?? "INVALID_JSON" });
        }
      }
    } else if (probe.kind === "adapter-bundle-digest") {
      // STORY-286. A directory that exists says nothing about what is in it — the ceiling
      // INC-208 recorded, where an edited bundle passed. The receipt this bundle was
      // installed from carries a digest per file, so acceptance means the bytes are still
      // the bytes that were installed.
      if (!stats.isDirectory()) {
        invalid.push({ id: entry.id, reasonCode: "PLATFORM_INSTALL_WIRING_NOT_DIRECTORY", pathTemplate: entry.pathTemplate, probe: probe.kind });
      } else {
        const failure = await adapterBundleDrift(path, expandTemplate(probe.parameters.receipt ?? "", platformRoot, homeRoot));
        if (failure !== null) invalid.push({ id: entry.id, reasonCode: failure.reasonCode, pathTemplate: entry.pathTemplate, probe: probe.kind, ...failure.detail });
      }
    } else if (probe.kind === "regular-directory" || probe.kind === "helper-skill-digest" || probe.kind === "engine-version") {
      if (!stats.isDirectory()) invalid.push({ id: entry.id, reasonCode: "PLATFORM_INSTALL_WIRING_NOT_DIRECTORY", pathTemplate: entry.pathTemplate, probe: probe.kind });
    } else {
      invalid.push({ id: entry.id, reasonCode: "PLATFORM_ACCEPTANCE_PROBE_UNSUPPORTED", pathTemplate: entry.pathTemplate, probe: probe.kind });
    }
  }
  return missing.length === 0 && invalid.length === 0
    ? check("installWiring", true, { itemCount: required.length, source: "install-manifest", probes: "safe-manifest-expression" })
    : check("installWiring", false, {
      reasonCode: "PLATFORM_INSTALL_WIRING_INCOMPLETE",
      source: "install-manifest",
      missing,
      invalid,
    });
}

/**
 * Does an installed adapter bundle still carry the bytes its receipt recorded?
 *
 * Returns null when it does. The receipt names each installed file with a content digest;
 * a drifted, deleted or added file is a bundle that is no longer the one that was
 * accepted. An unreadable receipt is itself the finding — the probe never falls back to
 * "the directory is there", because that fallback is the ceiling this replaces.
 */
async function adapterBundleDrift(bundlePath, receiptPath) {
  if (!receiptPath) return { reasonCode: "PLATFORM_ADAPTER_RECEIPT_UNDECLARED", detail: {} };
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    return { reasonCode: "PLATFORM_ADAPTER_RECEIPT_UNREADABLE", detail: { receiptPath, error: error?.code ?? "INVALID_JSON" } };
  }
  const entries = Array.isArray(receipt?.entries) ? receipt.entries : null;
  if (entries === null || entries.length === 0) {
    return { reasonCode: "PLATFORM_ADAPTER_RECEIPT_EMPTY", detail: { receiptPath } };
  }
  const installationRoot = typeof receipt.installationRoot === "string" ? receipt.installationRoot : null;
  const drifted = [];
  for (const entry of entries) {
    if (typeof entry?.path !== "string" || typeof entry?.contentDigest !== "string") {
      drifted.push({ path: entry?.path ?? null, reason: "receipt entry is not path plus contentDigest" });
      continue;
    }
    const target = installationRoot === null ? resolve(bundlePath, entry.path) : resolve(installationRoot, entry.path);
    let bytes;
    try {
      bytes = await readFile(target);
    } catch {
      drifted.push({ path: entry.path, reason: "installed file is absent" });
      continue;
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.contentDigest) drifted.push({ path: entry.path, reason: "content digest differs from the receipt" });
  }
  return drifted.length === 0 ? null : { reasonCode: "PLATFORM_ADAPTER_BUNDLE_DRIFTED", detail: { receiptPath, drifted } };
}

/**
 * Installed adapter files whose bytes match their receipt but whose file identity moved.
 *
 * TCRN-CROSS-INC-219. This reports; it never decides. The two digests answer different
 * questions: `contentDigest` answers "are these the bytes we installed", which is what an
 * acceptance probe should ask and what the verdict stays bound to; `identityDigest` covers
 * mtime and ctime and therefore moves on a chmod, an editor save or a restore from backup.
 * Wiring identity into the verdict would turn benign touches into platform-red.
 *
 * Silence would be worse than either, though — two checks over one installation giving
 * opposite answers, with only one of them visible, is how a green comes to mean nothing.
 * So the drift is named here, with the timestamp that moved, and `adapter-rebind` is the
 * governed way to clear it.
 */
export async function adapterIdentityObservations(manifest, platformRoot, homeRoot) {
  const observations = [];
  for (const entry of manifest.items ?? []) {
    const probe = parseAcceptanceProbe(entry.acceptanceProbe);
    if (probe?.kind !== "adapter-bundle-digest") continue;
    const receiptPath = expandTemplate(probe.parameters.receipt ?? "", platformRoot, homeRoot);
    if (!receiptPath) continue;
    let receipt;
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    } catch {
      continue; // An unreadable receipt is already the installWiring check's finding.
    }
    const installationRoot = typeof receipt?.installationRoot === "string" ? receipt.installationRoot : null;
    for (const item of Array.isArray(receipt?.entries) ? receipt.entries : []) {
      if (typeof item?.path !== "string" || typeof item?.identityDigest !== "string") continue;
      const target = installationRoot === null
        ? resolve(expandTemplate(entry.pathTemplate, platformRoot, homeRoot), item.path)
        : resolve(installationRoot, item.path);
      let stats;
      try {
        stats = await lstat(target);
      } catch {
        continue; // Absence is a content finding, not an identity one.
      }
      const observed = canonicalSha256({
        dev: String(stats.dev),
        ino: String(stats.ino),
        size: String(stats.size),
        mtimeMs: String(stats.mtimeMs),
        ctimeMs: String(stats.ctimeMs),
      });
      if (observed === item.identityDigest) continue;
      observations.push({
        reasonCode: "PLATFORM_ADAPTER_IDENTITY_DRIFTED",
        id: entry.id,
        path: item.path,
        receiptPath,
        modifiedAt: new Date(stats.mtimeMs).toISOString(),
        remedy: "adapter-rebind",
      });
    }
  }
  return observations;
}

function parseAcceptanceProbe(value) {
  if (typeof value !== "string") return null;
  const [head, ...segments] = value.split(";");
  if (!head?.startsWith("probe:")) return null;
  const kind = head.slice("probe:".length);
  if (!["regular-file", "regular-directory", "regular-executable", "receipt-json", "helper-skill-digest", "engine-version", "trust-archive-freshness", "local-snapshot-freshness", "offsite-push-freshness", "launchd-duty", "adapter-bundle-digest"].includes(kind)) return null;
  const parameters = Object.fromEntries(segments.map((segment) => segment.split("=")).filter(([key, val]) => typeof key === "string" && typeof val === "string" && key.length > 0 && val.length > 0));
  return { kind, parameters };
}

function probeFailure(reasonCode, message, details = {}) {
  return Object.assign(new Error(message), { reasonCode, ...details });
}

async function readTrustedHelperDigest(homeRoot, parameters) {
  if (parameters.source !== "trusted-archive-state") {
    throw probeFailure("PLATFORM_TRUST_ROOT_SOURCE_INVALID", "helper digest source is not the trusted archive/state surface", { source: parameters.source ?? null });
  }
  const trustRoot = join(homeRoot, ".tcrn-workflow");
  const archivePath = join(trustRoot, parameters.archive ?? "skill-archive.json");
  const statePath = join(trustRoot, parameters.state ?? "state.json");
  const archiveStats = await existingPath(archivePath);
  const stateStats = await existingPath(statePath);
  if (!archiveStats?.isFile() || !stateStats?.isFile()) {
    throw probeFailure("PLATFORM_TRUST_ROOT_MISSING", "trusted archive/state is unavailable", { archivePath, statePath });
  }
  const [archiveBytes, stateBytes] = await Promise.all([readFile(archivePath), readFile(statePath)]);
  let archive;
  let state;
  try {
    archive = JSON.parse(archiveBytes.toString("utf8"));
    state = JSON.parse(stateBytes.toString("utf8"));
  } catch (error) {
    throw probeFailure("PLATFORM_TRUST_ROOT_INVALID", "trusted archive/state is not valid JSON", { archivePath, statePath, error: error?.code ?? "INVALID_JSON" });
  }
  if (archive?.schemaVersion !== "tcrn.workflow.helper.archive.v1" || state?.schemaVersion !== "tcrn.workflow.helper.state.v1") {
    throw probeFailure("PLATFORM_TRUST_ROOT_INVALID", "trusted archive/state schema is unsupported", { archivePath, statePath });
  }
  const archiveDigest = createHash("sha256").update(archiveBytes).digest("hex");
  if (state.verifiedArchiveSha256 !== archiveDigest) {
    throw probeFailure("PLATFORM_TRUST_ROOT_STATE_MISMATCH", "state does not attest to the archive bytes", { archivePath, statePath, expectedArchiveSha256: state.verifiedArchiveSha256 ?? null, actualArchiveSha256: archiveDigest });
  }
  if (!Array.isArray(archive.entries) || archive.entries.length === 0) {
    throw probeFailure("PLATFORM_TRUST_ROOT_INVALID", "trusted archive has no entries", { archivePath });
  }
  const declared = new Map();
  for (const entry of archive.entries) {
    if (entry === null || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.sha256 !== "string" || typeof entry.contentBase64 !== "string" || declared.has(entry.path)) {
      throw probeFailure("PLATFORM_TRUST_ROOT_INVALID", "trusted archive entry is malformed or duplicated", { archivePath, entryPath: entry?.path ?? null });
    }
    const content = Buffer.from(entry.contentBase64, "base64");
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== entry.sha256) {
      throw probeFailure("PLATFORM_TRUST_ROOT_ARCHIVE_DIGEST_MISMATCH", "trusted archive entry digest does not match its bytes", { archivePath, entryPath: entry.path, expected: entry.sha256, actual: digest });
    }
    declared.set(entry.path, entry.sha256);
  }
  const entryPath = parameters.entry ?? "SKILL.md";
  const digest = declared.get(entryPath);
  if (typeof digest !== "string") {
    throw probeFailure("PLATFORM_TRUST_ROOT_ENTRY_MISSING", "trusted archive does not contain the requested helper entry", { archivePath, entryPath });
  }
  return { digest, archiveDigest, archivePath, statePath, entryPath, declaredEntryCount: declared.size };
}

function hookCommands(settings) {
  const hooks = settings?.hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const commands = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (group === null || typeof group !== "object" || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (hook !== null && typeof hook === "object" && typeof hook.command === "string") commands.push({ event, command: hook.command });
      }
    }
  }
  return commands;
}

/**
 * Is a hook command something this host can actually run?
 *
 * Shared by both hosts because the answer is the same question twice: resolve the target,
 * confirm it is a file, and ask node to parse it. A registered hook whose target does not
 * parse is a hook that fails at the moment it is supposed to protect something.
 */
async function hookTargetFailures(commands, resolveTarget) {
  const failures = [];
  let checked = 0;
  for (const hook of commands) {
    const target = resolveTarget(hook.command);
    if (target === null) continue;
    checked += 1;
    if (target === undefined) {
      failures.push({ event: hook.event, command: hook.command, reasonCode: "PLATFORM_HOOK_COMMAND_UNSUPPORTED" });
      continue;
    }
    const targetStats = await existingPath(target);
    if (!targetStats?.isFile()) {
      failures.push({ event: hook.event, command: hook.command, target, reasonCode: "PLATFORM_HOOK_TARGET_UNAVAILABLE" });
      continue;
    }
    try {
      await execFileAsync(process.execPath, ["--check", target], { timeout: 10_000, maxBuffer: 1_048_576 });
    } catch (error) {
      failures.push({ event: hook.event, command: hook.command, target, reasonCode: "PLATFORM_HOOK_TARGET_UNUSABLE", error: error?.code ?? "NODE_CHECK_FAILED" });
    }
  }
  return { failures, checked };
}

/**
 * The codex arm (TCRN-CROSS-STORY-286).
 *
 * This leg only ever read the Claude settings, so a codex host could carry a broken or
 * unparseable hook and the doctor would call the platform healthy. Codex writes an exact
 * `.codex/hooks.json` at activation, in the same event → hooks → command shape, differing
 * only in that its commands carry resolved absolute paths rather than a project-dir
 * placeholder.
 *
 * Absence is deferral, not health: the adapter bundle installs inert and activation is a
 * separate governed step, so a container with no hooks file has not failed anything — it
 * has not been activated. Saying so is different from saying it passed.
 */
async function inspectCodexHooks(platformRoot) {
  const hooksPath = resolve(platformRoot, ".codex/hooks.json");
  const stats = await existingPath(hooksPath);
  if (!stats) return { state: "absent" };
  if (!stats.isFile()) return { state: "invalid", reasonCode: "PLATFORM_CODEX_HOOKS_NOT_FILE" };
  let settings;
  try {
    settings = JSON.parse(await readFile(hooksPath, "utf8"));
  } catch (error) {
    return { state: "invalid", reasonCode: "PLATFORM_CODEX_HOOKS_INVALID", error: error?.message ?? "INVALID_JSON" };
  }
  const commands = hookCommands(settings);
  const { failures, checked } = await hookTargetFailures(commands, (command) => {
    const match = /^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(command.trim());
    if (!match) return undefined;
    return resolve(match[1] ?? match[2] ?? match[3]);
  });
  return {
    state: failures.length === 0 ? "live" : "broken",
    checked,
    failures,
    events: [...new Set(commands.map((hook) => hook.event))].sort(),
  };
}

/**
 * Is every host that installed an adapter actually under the harness?
 *
 * TCRN-CROSS-INC-220, and the predicate is Owner's ruling written down: a host comes under
 * the harness from the moment it installs its adapter. So the requirement is conditional
 * on the adapter, not on the host being in a list — a machine that never installed Codex
 * is not missing anything, and one that did is missing something real. Before this leg,
 * Codex carried four inert declaration files and no harness at all, and nothing said so.
 *
 * This red has a governed way back to green (`scripts/host-harness-apply.mjs`), which is
 * what makes it a fair red rather than an ornament.
 */
export async function inspectHarnessCoverage(platformRoot) {
  const hosts = [];
  const failures = [];
  for (const host of HOSTS) {
    const adapterRoot = join(platformRoot, `.${host}`, "tcrn-workflow");
    const adapter = await existingPath(adapterRoot);
    if (!adapter?.isDirectory()) {
      hosts.push({ host, adapterInstalled: false, harness: "not-required" });
      continue;
    }
    if (host === "claude") {
      const drift = claudeHarnessDrift(join(platformRoot, ".claude", "settings.json"));
      hosts.push({ host, adapterInstalled: true, harness: drift.length === 0 ? "complete" : "incomplete", findings: drift });
      if (drift.length > 0) failures.push({ host, reasonCode: "PLATFORM_HARNESS_INCOMPLETE", findings: drift });
      continue;
    }
    const hooksPath = join(platformRoot, ".codex", "hooks.json");
    const stats = await existingPath(hooksPath);
    if (!stats?.isFile()) {
      hosts.push({ host, adapterInstalled: true, harness: "absent" });
      failures.push({ host, reasonCode: "PLATFORM_HARNESS_ABSENT", path: hooksPath, remedy: "scripts/host-harness-apply.mjs" });
      continue;
    }
    let live;
    try {
      live = JSON.parse(await readFile(hooksPath, "utf8"));
    } catch (error) {
      hosts.push({ host, adapterInstalled: true, harness: "unreadable" });
      failures.push({ host, reasonCode: "PLATFORM_HARNESS_UNREADABLE", path: hooksPath, error: error?.code ?? "INVALID_JSON" });
      continue;
    }
    // Compared capability by capability rather than by whole-document equality: the file
    // is a two-zone document that may legitimately acquire user-owned hooks, and refusing
    // those would push someone to delete this leg rather than keep it.
    const missing = [];
    for (const entry of hookEntriesFor(host)) {
      const groups = Array.isArray(live?.hooks?.[entry.event]) ? live.hooks[entry.event] : [];
      const commands = groups.flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
        .map((hook) => String(hook?.command ?? ""));
      if (!commands.some((command) => command.includes(entry.handler))) {
        missing.push({ capability: entry.id, event: entry.event, handler: entry.handler });
      }
    }
    hosts.push({ host, adapterInstalled: true, harness: missing.length === 0 ? "complete" : "incomplete", findings: missing });
    if (missing.length > 0) failures.push({ host, reasonCode: "PLATFORM_HARNESS_INCOMPLETE", findings: missing, remedy: "scripts/host-harness-apply.mjs" });
  }
  return failures.length === 0
    ? check("harnessCoverage", true, { hosts, capabilities: hookEntriesFor("codex").length })
    : check("harnessCoverage", false, { reasonCode: failures[0].reasonCode, hosts, failures });
}

async function inspectHookExecutability(platformRoot, manifest) {
  const codex = await inspectCodexHooks(platformRoot);
  const entry = manifest.items.find((candidate) => candidate.id === "container.claude-settings");
  if (!entry) return check("hooks", false, { reasonCode: "PLATFORM_MANIFEST_HOOK_SETTINGS_MISSING", codex });
  const settingsPath = expandTemplate(entry.pathTemplate, platformRoot, platformRoot);
  const stats = settingsPath === null ? null : await existingPath(settingsPath);
  if (!stats) return check("hooks", true, { source: "installWiring", deferredTo: "installWiring", codex });
  if (!stats.isFile()) return check("hooks", false, { reasonCode: "PLATFORM_HOOK_SETTINGS_NOT_FILE", pathTemplate: entry.pathTemplate, codex });
  let settings;
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    return check("hooks", false, { reasonCode: "PLATFORM_HOOK_SETTINGS_INVALID", error: error?.message ?? "INVALID_JSON", codex });
  }
  const commands = hookCommands(settings);
  const failures = [];
  let checked = 0;
  for (const hook of commands) {
    if (!hook.command.includes("${CLAUDE_PROJECT_DIR}")) continue;
    checked += 1;
    const match = /^node\s+"([^"]+)"$/u.exec(hook.command.trim());
    if (!match) {
      failures.push({ event: hook.event, command: hook.command, reasonCode: "PLATFORM_HOOK_COMMAND_UNSUPPORTED" });
      continue;
    }
    const target = resolve(match[1].replaceAll("${CLAUDE_PROJECT_DIR}", platformRoot));
    const targetStats = await existingPath(target);
    if (!targetStats?.isFile()) {
      failures.push({ event: hook.event, command: hook.command, target, reasonCode: "PLATFORM_HOOK_TARGET_UNAVAILABLE" });
      continue;
    }
    try {
      await execFileAsync(process.execPath, ["--check", target], { timeout: 10_000, maxBuffer: 1_048_576 });
    } catch (error) {
      failures.push({ event: hook.event, command: hook.command, target, reasonCode: "PLATFORM_HOOK_TARGET_UNUSABLE", error: error?.code ?? "NODE_CHECK_FAILED" });
    }
  }
  // A codex hooks file that exists and is broken is a finding of its own: activation
  // wrote it, so something is registered and unrunnable. Absent stays deferral.
  if (codex.state === "broken" || codex.state === "invalid") {
    return check("hooks", false, {
      reasonCode: codex.reasonCode ?? codex.failures?.[0]?.reasonCode ?? "PLATFORM_CODEX_HOOK_TARGET_UNUSABLE",
      source: "container.codex-hooks",
      codex,
      claude: { checked, failures },
    });
  }
  return failures.length === 0
    ? check("hooks", true, { source: "container.claude-settings", checked, events: [...new Set(commands.filter((hook) => hook.command.includes("${CLAUDE_PROJECT_DIR}")).map((hook) => hook.event))].sort(), codex })
    : check("hooks", false, { reasonCode: failures[0].reasonCode, failures, source: "container.claude-settings", codex });
}

function versionFromSkill(text) {
  const match = /Supports TCRN Workflow `v([^`]+)`/u.exec(text);
  return match?.[1] ?? null;
}

async function inspectDeploymentFreshness(homeRoot, manifest) {
  const engineEntry = manifest.items.find((entry) => entry.id === "machine.workflow-engine");
  const claudeEntry = manifest.items.find((entry) => entry.id === "machine.claude-skill");
  const codexEntry = manifest.items.find((entry) => entry.id === "machine.codex-skill");
  if (!engineEntry || !claudeEntry || !codexEntry) return check("deploymentFreshness", false, { reasonCode: "PLATFORM_MANIFEST_DEPLOYMENT_ITEMS_MISSING" });
  const engineRoot = expandTemplate(engineEntry.pathTemplate, "<PLATFORM_ROOT>", homeRoot);
  const claudeSkill = expandTemplate(claudeEntry.pathTemplate, "<PLATFORM_ROOT>", homeRoot);
  const codexSkill = expandTemplate(codexEntry.pathTemplate, "<PLATFORM_ROOT>", homeRoot);
  if (engineRoot === null || claudeSkill === null || codexSkill === null) return check("deploymentFreshness", false, { reasonCode: "PLATFORM_MANIFEST_PATH_INVALID" });
  try {
    const packageValue = JSON.parse(await readFile(join(engineRoot, "tcrn-workflow", "package.json"), "utf8"));
    const engineVersion = packageValue.version;
    let claudeText;
    let codexText;
    try {
      claudeText = await readFile(join(claudeSkill, "SKILL.md"), "utf8");
      codexText = await readFile(join(codexSkill, "SKILL.md"), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        return check("deploymentFreshness", false, { reasonCode: "PLATFORM_DEPLOYMENT_MISSING", source: "package.json-vs-helper-pin", missingInput: "helper-skill-copy" });
      }
      throw error;
    }
    const claudeVersion = versionFromSkill(claudeText);
    const codexVersion = versionFromSkill(codexText);
    const versions = { engineVersion, claudeVersion, codexVersion };
    if (![engineVersion, claudeVersion, codexVersion].every((value) => typeof value === "string" && value.length > 0)) {
      return check("deploymentFreshness", false, { reasonCode: "PLATFORM_DEPLOYMENT_VERSION_MISSING", versions });
    }
    if (new Set([engineVersion, claudeVersion, codexVersion]).size !== 1) {
      return check("deploymentFreshness", false, { reasonCode: "PLATFORM_DEPLOYMENT_STALE", versions });
    }
    return check("deploymentFreshness", true, { versions, source: "package.json-vs-helper-pin" });
  } catch (error) {
    return check("deploymentFreshness", false, { reasonCode: "PLATFORM_DEPLOYMENT_MISSING", error: error?.code ?? "INVALID_DEPLOYMENT" });
  }
}

// TCRN-CROSS-MIN-102 批0. Four of the adversarial verdicts made the same thing a
// release condition — every engine copy that will read a chain is new enough
// before the first write in a new format lands — and no check could see it.
// `deploymentFreshness` compares the installed copy's own package.json against the
// two helper pins, which says nothing about whether a copy can read a given chain.
// A copy that is too old does not degrade: it fails the whole workspace closed as
// WORKSPACE_EVENT_CORRUPT, indistinguishable from real byte damage.
//
// The baseline is each partition's own `engine.requiredVersion` declaration — a
// chain declaration, class B in the gate-reference inventory, not something the
// tree can move without an edit. The targets are discovered rather than listed:
// partitions by walking the container, engine copies from the install manifest
// (the installed copy is an item, the working tree is a declared project), so a
// partition added tomorrow is covered the day it exists and no second roster
// exists for anything to drift against.
//
// An undeclared partition is green with the reason code saying so, never a silent
// green: nothing has been declared, so there is nothing to enforce, and the
// observed versions are reported as facts rather than asserted as healthy. This is
// the launchd leg's shape, for the same reason.
async function engineCopyVersions(root, homeRoot, manifest, options) {
  if (options.engineCopyVersions && typeof options.engineCopyVersions === "object") {
    return { copies: options.engineCopyVersions, source: "synthetic" };
  }
  const copies = {};
  const engineEntry = manifest.items.find((entry) => entry.id === "machine.workflow-engine");
  const installedRoot = engineEntry ? expandTemplate(engineEntry.pathTemplate, "<PLATFORM_ROOT>", homeRoot) : null;
  const engineProject = (manifest.projects ?? []).find((project) => project.name === "tcrn-workflow");
  const worktreeRoot = engineProject?.pathTemplate?.startsWith("<PLATFORM_ROOT>/")
    ? join(root, engineProject.pathTemplate.slice("<PLATFORM_ROOT>/".length))
    : null;
  const candidates = [
    ["installed", installedRoot === null ? null : join(installedRoot, "tcrn-workflow", "package.json")],
    ["worktree", worktreeRoot === null ? null : join(worktreeRoot, "package.json")],
  ];
  for (const [name, packagePath] of candidates) {
    if (packagePath === null) continue;
    try {
      const value = JSON.parse(await readFile(packagePath, "utf8"));
      if (typeof value.version === "string" && value.version.length > 0) copies[name] = value.version;
    } catch {
      // A copy that is absent is not a copy that is stale. Only present copies are
      // compared; `deploymentFreshness` already owns "the installed copy is missing".
    }
  }
  return { copies, source: "install-manifest" };
}

async function declaredEngineRequirements(root, options) {
  if (options.engineRequiredVersions && typeof options.engineRequiredVersions === "object") {
    return { declarations: options.engineRequiredVersions, source: "synthetic" };
  }
  const containerPath = join(root, ".tcrn-workspace");
  // Same resolution as declaredBackupCadences: fileURLToPath rather than pathname,
  // because this repository lives under a directory whose name contains a space.
  const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "tcrn-workflow.mjs");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch (error) {
    return { declarations: null, source: "unreadable", error: error?.code ?? "CONTAINER_UNREADABLE" };
  }
  const declarations = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    if (!(await existingPath(workspacePath))?.isDirectory()) continue;
    try {
      const result = await execFileAsync(process.execPath, [cli, "settings-catalog", "--workspace", workspacePath], { timeout: 30_000, maxBuffer: 8 * 1_048_576 });
      const catalog = JSON.parse(result.stdout);
      const rows = Object.values(catalog).find((value) => Array.isArray(value)) ?? [];
      const row = rows.find((candidate) => candidate?.key === "engine.requiredVersion");
      declarations[entry.name] = row?.currentValue ?? null;
    } catch (error) {
      return { declarations: null, source: "unreadable", error: error?.code ?? "SETTINGS_CATALOG_FAILED", partition: entry.name };
    }
  }
  return { declarations, source: "chain-declaration" };
}

async function inspectEngineAlignment(root, homeRoot, manifest, options) {
  const observed = await engineCopyVersions(root, homeRoot, manifest, options);
  const copies = observed.copies;
  if (Object.keys(copies).length === 0) {
    return check("engineAlignment", false, { reasonCode: "PLATFORM_ENGINE_COPY_UNREADABLE", source: observed.source });
  }
  const declared = await declaredEngineRequirements(root, options);
  if (declared.declarations === null) {
    // Unreadable is reported, not red. This leg's claim is "no copy is behind a
    // declared floor"; with no readable declaration there is no floor, which is the
    // same epistemic position as none being declared — and a container without a
    // live chain (a fixture, a partial checkout) is not a platform fault any more
    // than it is a passing one. `requirementAsserted` carries the distinction into
    // the verdict so this can never be read as "aligned".
    return check("engineAlignment", true, {
      reasonCode: "PLATFORM_ENGINE_REQUIREMENT_UNREADABLE",
      copies,
      error: declared.error,
      partition: declared.partition ?? null,
      requirementAsserted: false,
      source: declared.source,
    });
  }
  const behind = [];
  for (const [partition, required] of Object.entries(declared.declarations).sort(([left], [right]) => compareCanonicalTextLocal(left, right))) {
    if (typeof required !== "string" || required.length === 0) continue;
    for (const [copy, version] of Object.entries(copies).sort(([left], [right]) => compareCanonicalTextLocal(left, right))) {
      let ordering;
      try {
        ordering = compareEngineVersions(version, required);
      } catch {
        behind.push({ partition, required, copy, version, reason: "UNPARSEABLE" });
        continue;
      }
      if (ordering < 0) behind.push({ partition, required, copy, version, reason: "BEHIND" });
    }
  }
  if (behind.length > 0) {
    return check("engineAlignment", false, {
      reasonCode: "PLATFORM_ENGINE_BEHIND_CHAIN",
      behind,
      copies,
      hint: "that copy fails the whole workspace closed as WORKSPACE_EVENT_CORRUPT — upgrade it before the next write, or the failure will read as byte damage",
      source: "chain engine.requiredVersion + install-manifest",
    });
  }
  const declaringPartitions = Object.entries(declared.declarations)
    .filter(([, required]) => typeof required === "string" && required.length > 0)
    .map(([partition]) => partition)
    .sort(compareCanonicalTextLocal);
  if (declaringPartitions.length === 0) {
    // Green, but never silently: no partition has declared a floor, so this leg is
    // enforcing nothing. The copy versions are reported as observations so the
    // reader can see what is actually installed without the leg claiming it is right.
    return check("engineAlignment", true, {
      reasonCode: "PLATFORM_ENGINE_REQUIREMENT_UNDECLARED",
      copies,
      partitions: Object.keys(declared.declarations).sort(compareCanonicalTextLocal),
      requirementAsserted: false,
      source: "chain engine.requiredVersion + install-manifest",
    });
  }
  return check("engineAlignment", true, {
    copies,
    declaringPartitions,
    requirementAsserted: true,
    source: "chain engine.requiredVersion + install-manifest",
  });
}

// TCRN-CROSS-MIN-103. The Helper teaches a settings surface, and something has to
// check that what it teaches is still what the engine has. That comparison used to
// live in the Helper's own test suite, which read the engine's source out of a
// sibling checkout — a repository reaching into another's tree, forbidden by the
// platform's dependency-direction rule, and impossible in the Helper's CI, which
// checks out one repository. So it was ENOENT there and green locally: three
// consecutive pushes red on a check that could only ever pass on a developer's
// machine, which is the same defect shape as INC-223's DS reconciliation.
//
// The platform layer is where a cross-repository question can be asked honestly:
// this doctor already reads the engine, the installed Helper copies, and the chain.
// The Helper now declares the roster it teaches and holds itself to it; this leg
// answers whether that declaration still matches the engine's own catalog, read
// through the engine's read face rather than by pattern-matching its source.
async function inspectHelperSettingsCoverage(root, homeRoot, manifest, options) {
  if (options.helperSettingKeys && typeof options.helperSettingKeys === "object") {
    return checkHelperSettingsCoverage(options.helperSettingKeys.catalog, options.helperSettingKeys.taught, "synthetic");
  }
  const entry = manifest.items.find((item) => item.id === "machine.claude-skill");
  const skillRoot = entry ? expandTemplate(entry.pathTemplate, "<PLATFORM_ROOT>", homeRoot) : null;
  if (skillRoot === null) return check("helperSettingsCoverage", false, { reasonCode: "PLATFORM_MANIFEST_PATH_INVALID" });

  const catalogKeys = await engineSettingKeys(root, options);
  if (catalogKeys === null) {
    // Unreadable is reported, not red: with no catalog there is nothing to compare,
    // which is the same epistemic position as engineAlignment's undeclared case.
    return check("helperSettingsCoverage", true, {
      reasonCode: "PLATFORM_HELPER_SETTINGS_UNREADABLE",
      coverageAsserted: false,
      source: "engine settings-catalog + installed helper payload",
    });
  }
  let taught;
  try {
    taught = await taughtSettingKeys(skillRoot, catalogKeys);
  } catch (error) {
    return check("helperSettingsCoverage", true, {
      reasonCode: "PLATFORM_HELPER_PAYLOAD_UNREADABLE",
      coverageAsserted: false,
      error: error?.code ?? "UNREADABLE",
      source: "engine settings-catalog + installed helper payload",
    });
  }
  return checkHelperSettingsCoverage(catalogKeys, taught, "engine settings-catalog + installed helper payload");
}

function checkHelperSettingsCoverage(catalogKeys, taught, source) {
  const untaught = catalogKeys.filter((key) => !taught.includes(key)).sort(compareCanonicalTextLocal);
  return untaught.length === 0
    ? check("helperSettingsCoverage", true, { catalogKeys: [...catalogKeys].sort(compareCanonicalTextLocal), coverageAsserted: true, source })
    : check("helperSettingsCoverage", false, {
      reasonCode: "PLATFORM_HELPER_SETTINGS_UNTAUGHT",
      untaught,
      hint: "the engine registered a setting the placed Helper never mentions — teach it in the payload and re-pin, or the operator meets a key no guidance covers",
      source,
    });
}

async function engineSettingKeys(root, options) {
  const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "tcrn-workflow.mjs");
  const containerPath = join(root, ".tcrn-workspace");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    if (!(await existingPath(workspacePath))?.isDirectory()) continue;
    try {
      const result = await execFileAsync(process.execPath, [cli, "settings-catalog", "--workspace", workspacePath], { timeout: 30_000, maxBuffer: 8 * 1_048_576 });
      const catalog = JSON.parse(result.stdout);
      const rows = Object.values(catalog).find((value) => Array.isArray(value)) ?? [];
      const keys = rows.map((row) => row?.key).filter((key) => typeof key === "string");
      if (keys.length > 0) return keys;
    } catch {
      // Any readable partition answers the same catalog; try the next one.
    }
  }
  return null;
}

async function taughtSettingKeys(skillRoot, catalogKeys) {
  const documents = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".md")) documents.push(await readFile(path, "utf8"));
    }
  };
  await walk(skillRoot);
  const prose = documents.join("\n");
  return catalogKeys.filter((key) => prose.includes(key));
}

async function inspectHelperCopies(platformRoot, homeRoot, manifest, options) {
  const entries = manifest.items.filter((entry) => entry.acceptanceProbe.startsWith("probe:helper-skill-digest"));
  const missing = [];
  const mismatched = [];
  const probe = entries.length > 0 ? parseAcceptanceProbe(entries[0].acceptanceProbe) : null;
  let trustedSource = null;
  const syntheticByEntry = options.helperSkillDigests && typeof options.helperSkillDigests === "object";
  const syntheticLaunchd = Array.isArray(options.launchdLabels) && options.enforceHelperDigest !== true;
  if (!syntheticByEntry && !syntheticLaunchd) {
    try {
      trustedSource = await readTrustedHelperDigest(homeRoot, probe?.parameters ?? {});
    } catch (error) {
      return check("helperCopies", false, {
        reasonCode: error?.reasonCode ?? "PLATFORM_TRUST_ROOT_UNAVAILABLE",
        source: "trusted-archive-state",
        ...(error?.archivePath ? { archivePath: error.archivePath } : {}),
        ...(error?.statePath ? { statePath: error.statePath } : {}),
        ...(error?.entryPath ? { entryPath: error.entryPath } : {}),
        ...(error?.expectedArchiveSha256 ? { expectedArchiveSha256: error.expectedArchiveSha256 } : {}),
        ...(error?.actualArchiveSha256 ? { actualArchiveSha256: error.actualArchiveSha256 } : {}),
      });
    }
  }
  for (const entry of entries) {
    const path = expandTemplate(entry.pathTemplate, platformRoot, homeRoot);
    const rootStats = path === null ? null : await existingPath(path);
    const skillPath = path === null ? null : join(path, "SKILL.md");
    const skillStats = skillPath === null ? null : await existingPath(skillPath);
    if (!rootStats?.isDirectory() || !skillStats?.isFile()) {
      missing.push({ id: entry.id, pathTemplate: entry.pathTemplate, reasonCode: "PLATFORM_HELPER_COPY_NOT_REGULAR" });
      continue;
    }
    const actual = createHash("sha256").update(await readFile(skillPath)).digest("hex");
    const entryProbe = parseAcceptanceProbe(entry.acceptanceProbe);
    const expected = options.helperSkillDigests?.[entry.id] ?? (syntheticLaunchd ? actual : trustedSource?.digest);
    if (actual !== expected) mismatched.push({ id: entry.id, reasonCode: "PLATFORM_HELPER_COPY_DIGEST_MISMATCH", expected, actual, source: syntheticByEntry ? "synthetic-helper-digest" : syntheticLaunchd ? "synthetic-launchd-labels" : entryProbe?.parameters.source ?? "trusted-archive-state" });
  }
  return missing.length === 0 && mismatched.length === 0
    ? check("helperCopies", true, { hosts: ["agents", "claude", "codex"], source: syntheticByEntry ? "synthetic-helper-digest" : syntheticLaunchd ? "synthetic-launchd-labels" : "trusted-archive-state", archiveDigest: trustedSource?.archiveDigest ?? null, declaredEntryCount: trustedSource?.declaredEntryCount ?? null })
    : check("helperCopies", false, { reasonCode: missing.length > 0 ? "PLATFORM_HELPER_COPIES_INCOMPLETE" : "PLATFORM_HELPER_COPY_DIGEST_MISMATCH", missing, mismatched });
}

function parseLaunchdProbe(entry) {
  const match = /^probe:launchd-duty;label=([^;]+);maxAgeHours=(\d+)$/u.exec(entry?.acceptanceProbe ?? "");
  if (!match) return null;
  return { label: match[1], maxAgeHours: Number.parseInt(match[2], 10) };
}

async function launchdLabels(options) {
  if (Array.isArray(options.launchdLabels)) return options.launchdLabels;
  try {
    const result = await execFileAsync("launchctl", ["list"], { timeout: 10_000, maxBuffer: 1_048_576 });
    return result.stdout.split("\n").map((line) => line.trim().split(/\s+/u).at(-1)).filter((value) => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

function parseLastExitCode(text) {
  const match = /last exit code\s*=\s*(-?\d+)/u.exec(text);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function launchdStatus(label, options) {
  if (options.launchdStatus && typeof options.launchdStatus === "object") return options.launchdStatus;
  if (Array.isArray(options.launchdLabels)) return { lastExitCode: 0, source: "synthetic-launchd-labels" };
  try {
    const result = await execFileAsync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${label}`], { timeout: 10_000, maxBuffer: 1_048_576 });
    return { lastExitCode: parseLastExitCode(result.stdout), raw: result.stdout };
  } catch (error) {
    return { unavailable: true, error: error?.code ?? "LAUNCHCTL_PRINT_FAILED" };
  }
}

async function readFreshnessReceipt(path, maxAgeHours, kind) {
  try {
    const receipt = JSON.parse(await readFile(path, "utf8"));
    const timestamp = kind === "offsite"
      ? receipt.pushedAt ?? receipt.finishedAt ?? null
      : receipt.finishedAt ?? receipt.createdAt ?? null;
    const ageHours = typeof timestamp === "string" ? (Date.now() - Date.parse(timestamp)) / 3_600_000 : Number.POSITIVE_INFINITY;
    const ok = kind === "offsite"
      ? receipt.ok === true && receipt.readbackVerified === true
      : receipt.ok === true && typeof receipt.snapshotSha256 === "string" && receipt.chainVersions !== undefined;
    return {
      ok: ok && Number.isFinite(ageHours) && ageHours <= maxAgeHours,
      latestAt: timestamp,
      ageHours,
      receiptOk: receipt.ok === true,
      readbackVerified: receipt.readbackVerified === true,
      receiptPath: path,
    };
  } catch (error) {
    return { ok: false, latestAt: null, ageHours: Number.POSITIVE_INFINITY, receiptPath: path, error: error?.code ?? "BACKUP_RECEIPT_UNAVAILABLE" };
  }
}

async function localSnapshotFreshness(options, platformRoot, manifest, maxAgeHours) {
  if (options.localSnapshotFreshness && typeof options.localSnapshotFreshness === "object") return options.localSnapshotFreshness;
  if (options.backupFreshness && typeof options.backupFreshness === "object") return options.backupFreshness;
  if (Array.isArray(options.launchdLabels)) return { ok: true, latestAt: "synthetic", ageHours: 0, source: "synthetic-launchd-labels" };
  const entry = manifest.items.find((candidate) => candidate.id === "machine.local-snapshot-receipt");
  const path = entry ? expandTemplate(entry.pathTemplate, platformRoot, options.homeRoot ?? process.env.HOME ?? "") : join(platformRoot, ".tcrn-artifacts", "chain-snapshots", "local-snapshot.json");
  return readFreshnessReceipt(path, maxAgeHours, "local");
}

async function offsitePushFreshness(options, platformRoot, manifest, maxAgeHours) {
  if (options.offsitePushFreshness && typeof options.offsitePushFreshness === "object") return options.offsitePushFreshness;
  if (Array.isArray(options.launchdLabels)) return { ok: true, latestAt: "synthetic", ageHours: 0, source: "synthetic-launchd-labels" };
  const entry = manifest.items.find((candidate) => candidate.id === "machine.offsite-push-receipt");
  const path = entry ? expandTemplate(entry.pathTemplate, platformRoot, options.homeRoot ?? process.env.HOME ?? "") : join(platformRoot, ".tcrn-artifacts", "chain-snapshots", "offsite-push.json");
  return readFreshnessReceipt(path, maxAgeHours, "offsite");
}

async function listRegularFiles(root, prefix = "") {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix.length > 0 ? join(prefix, entry.name) : entry.name;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listRegularFiles(path, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

async function inspectTrustArchiveFreshness(platformRoot, homeRoot, manifest, options) {
  if (options.trustArchiveFreshness && typeof options.trustArchiveFreshness === "object") return check("trustArchive", options.trustArchiveFreshness.ok === true, options.trustArchiveFreshness);
  if (Array.isArray(options.launchdLabels) && options.enforceTrustArchive !== true) return check("trustArchive", true, { source: "synthetic-launchd-labels" });
  const archiveEntry = manifest.items.find((entry) => entry.id === "machine.trust-archive");
  const engineEntry = manifest.items.find((entry) => entry.id === "machine.workflow-engine");
  if (!archiveEntry || !engineEntry) return check("trustArchive", false, { reasonCode: "PLATFORM_TRUST_ARCHIVE_MANIFEST_ITEMS_MISSING" });
  const archivePath = expandTemplate(archiveEntry.pathTemplate, platformRoot, homeRoot);
  const engineRoot = expandTemplate(engineEntry.pathTemplate, platformRoot, homeRoot);
  if (!archivePath || !engineRoot) return check("trustArchive", false, { reasonCode: "PLATFORM_TRUST_ARCHIVE_PATH_INVALID" });
  try {
    const archive = JSON.parse(await readFile(archivePath, "utf8"));
    const entries = Array.isArray(archive.entries) ? archive.entries : [];
    const declared = new Map();
    const archiveProblems = [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.sha256 !== "string" || typeof entry.contentBase64 !== "string") {
        archiveProblems.push({ reasonCode: "PLATFORM_TRUST_ARCHIVE_ENTRY_INVALID", path: entry?.path ?? null });
        continue;
      }
      const content = Buffer.from(entry.contentBase64, "base64");
      const digest = createHash("sha256").update(content).digest("hex");
      if (digest !== entry.sha256 || declared.has(entry.path)) archiveProblems.push({ reasonCode: "PLATFORM_TRUST_ARCHIVE_ENTRY_DIGEST_INVALID", path: entry.path });
      declared.set(entry.path, entry.sha256);
    }
    const consumerRoots = [
      join(homeRoot, ".agents", "skills", "tcrn-workflow-helper"),
      join(homeRoot, ".claude", "skills", "tcrn-workflow-helper"),
      join(homeRoot, ".codex", "skills", "tcrn-workflow-helper"),
    ];
    const consumerProblems = [];
    for (const consumerRoot of consumerRoots) {
      const actualPaths = await listRegularFiles(consumerRoot);
      const actualSet = new Set(actualPaths);
      const missing = [...declared.keys()].filter((path) => !actualSet.has(path));
      const extra = actualPaths.filter((path) => !declared.has(path));
      const mismatched = [];
      for (const path of actualPaths.filter((candidate) => declared.has(candidate))) {
        const actual = createHash("sha256").update(await readFile(join(consumerRoot, path))).digest("hex");
        if (actual !== declared.get(path)) mismatched.push({ path, expected: declared.get(path), actual });
      }
      if (missing.length > 0 || extra.length > 0 || mismatched.length > 0) consumerProblems.push({ root: consumerRoot, missing, extra, mismatched });
    }
    const packageValue = JSON.parse(await readFile(join(engineRoot, "tcrn-workflow", "package.json"), "utf8"));
    const expectedVersion = `v${packageValue.version}`;
    const markerProblems = [];
    for (const host of ["claude", "codex"]) {
      const markerPath = join(homeRoot, ".tcrn-workflow", `installed-copy-${host}.json`);
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      if (marker.version !== expectedVersion) markerProblems.push({ host, markerPath, expectedVersion, actualVersion: marker.version ?? null });
    }
    if (archiveProblems.length > 0 || consumerProblems.length > 0 || markerProblems.length > 0) {
      return check("trustArchive", false, {
        reasonCode: "PLATFORM_TRUST_ARCHIVE_STALE",
        archivePath,
        declaredEntryCount: declared.size,
        consumerProblems,
        archiveProblems,
        markerProblems,
        expectedVersion,
      });
    }
    return check("trustArchive", true, { archivePath, declaredEntryCount: declared.size, consumerRoots: consumerRoots.length, expectedVersion, source: "archive-vs-installed-consumers-and-engine-version" });
  } catch (error) {
    return check("trustArchive", false, { reasonCode: "PLATFORM_TRUST_ARCHIVE_UNAVAILABLE", archivePath, error: error?.code ?? "INVALID_TRUST_ARCHIVE" });
  }
}

// INC-195. Whether an automatic snapshot train is owed is a question the chains
// already answer: `backup.cadence` is the workspace's declaration of how backup
// happens, and `manual` is the legal way to say "on request, not on a timer".
// The probe's label stays the authority on *which* job, never on whether one is
// owed, and there is no roster of hosts excused from the requirement — Owner
// ruled against passing a red by local memory, so the relaxation is derived from
// the declaration or it does not happen.
//
// The declaration can only relax, never tighten: an unreadable chain leaves the
// strict expectation standing and says so in `cadenceSource`. Reading it through
// the sibling CLI rather than the installed copy is deliberate — the doctor
// judges the tree it ships in, and the installed copy cannot currently replay
// cross-project at all (INC-194).
const AUTOMATIC_CADENCES = new Set(["gate-close", "session-end"]);

async function declaredBackupCadences(options, platformRoot) {
  if (options.declaredBackupCadence && typeof options.declaredBackupCadence === "object") {
    return { cadences: options.declaredBackupCadence, source: "supplied" };
  }
  // fileURLToPath, not URL.pathname: this repository lives under a directory whose
  // name contains a space, and pathname hands back the percent-encoded form.
  const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "tcrn-workflow.mjs");
  const containerPath = join(platformRoot, ".tcrn-workspace");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch (error) {
    return { cadences: null, source: "unreadable", error: error?.code ?? "WORKSPACE_CONTAINER_UNREADABLE" };
  }
  const cadences = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    if (!(await existingPath(workspacePath))?.isDirectory()) continue;
    try {
      const result = await execFileAsync(process.execPath, [cli, "settings-catalog", "--workspace", workspacePath], { timeout: 30_000, maxBuffer: 8 * 1_048_576 });
      const catalog = JSON.parse(result.stdout);
      const rows = Object.values(catalog).find((value) => Array.isArray(value)) ?? [];
      const cadence = rows.find((row) => row?.key === "backup.cadence");
      if (cadence === undefined) return { cadences: null, source: "unreadable", error: "BACKUP_CADENCE_ABSENT", partition: entry.name };
      cadences[entry.name] = cadence.currentValue ?? cadence.defaultValue ?? null;
    } catch (error) {
      return { cadences: null, source: "unreadable", error: error?.code ?? "SETTINGS_CATALOG_FAILED", partition: entry.name };
    }
  }
  if (Object.keys(cadences).length === 0) return { cadences: null, source: "unreadable", error: "NO_PARTITION_READ" };
  return { cadences, source: "chain-declaration" };
}

// INC-206. The install surface knew every harness location it had put down and
// nothing at all about the ones it had not. The pre-move container root kept a live
// `.claude` and `.codex` for four days after the move — four hooks and six hooks
// respectively, deciding what actually ran for anyone who opened a session there —
// and no check could see them, because every check started from the manifest and
// asked "is this present?" rather than from the tree and asking "is this declared?".
//
// This leg walks the container and reports any harness root the manifest does not
// place something under. The manifest is the reference on purpose: it is versioned,
// it fails closed, and adding a harness location means declaring it in the same
// change — not a roster of known-acceptable strays, which is the shape the Owner
// ruled out in MIN-099.
// The governed area is derived from the manifest rather than listed here: the
// container root, every declared project root, and the directories that lie between
// them. That middle set is not incidental — the classification folder the strays
// lived in is exactly a directory on the path to declared projects, governed by
// virtue of position and by nothing else. Everything else under the container is an
// unrelated project (AGENTS.md 二 says so plainly), and its own harness is none of
// the platform's business; scanning the whole tree reports those and teaches the
// reader to ignore the leg.
const HARNESS_DIRECTORY_NAMES = Object.freeze([".claude", ".codex"]);

async function inspectHarnessSurface(root, manifest) {
  const declaredPrefixes = manifest.items
    .filter((entry) => entry.pathTemplate.startsWith("<PLATFORM_ROOT>/"))
    .map((entry) => join(root, entry.pathTemplate.slice("<PLATFORM_ROOT>/".length)));
  const declaresSomethingUnder = (directory) =>
    declaredPrefixes.some((path) => path === directory || path.startsWith(`${directory}${sep}`));

  const governed = new Set([root]);
  for (const project of manifest.projects ?? []) {
    if (!project.pathTemplate?.startsWith("<PLATFORM_ROOT>/")) continue;
    let current = join(root, project.pathTemplate.slice("<PLATFORM_ROOT>/".length));
    while (current.startsWith(root) && current !== root) {
      governed.add(current);
      current = dirname(current);
    }
  }

  const undeclared = [];
  for (const directory of [...governed].sort(compareCanonicalTextLocal)) {
    for (const name of HARNESS_DIRECTORY_NAMES) {
      const path = join(directory, name);
      if (!(await existingPath(path))?.isDirectory()) continue;
      if (!declaresSomethingUnder(path)) undeclared.push(relative(root, path));
    }
  }

  return undeclared.length === 0
    ? check("harnessSurface", true, {
      governedDirectories: [...governed].map((path) => relative(root, path) || ".").sort(compareCanonicalTextLocal),
      source: "install-manifest",
    })
    : check("harnessSurface", false, {
      reasonCode: "PLATFORM_HARNESS_UNDECLARED",
      undeclared: undeclared.sort(compareCanonicalTextLocal),
      hint: "declare it in the install manifest, or retire it — an undeclared harness decides what runs and no other leg can see it",
      source: "install-manifest",
    });
}

const compareCanonicalTextLocal = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

async function inspectLaunchdDuty(options, manifest) {
  const entry = manifest.items.find((candidate) => candidate.acceptanceProbe.startsWith("probe:launchd-duty"));
  const probe = parseLaunchdProbe(entry);
  if (!probe) return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_PROBE_INVALID" });
  const declared = await declaredBackupCadences(options, options.platformRoot);
  const automatic = declared.cadences === null
    || Object.values(declared.cadences).some((cadence) => AUTOMATIC_CADENCES.has(cadence));
  const labels = await launchdLabels(options);
  if (!automatic) {
    // Green, but never silently: the reason code says the expectation came off
    // the chain, and the last snapshot is reported as a fact rather than asserted.
    const localFreshness = await localSnapshotFreshness(options, options.platformRoot, manifest, probe.maxAgeHours);
    return check("launchd", true, {
      reasonCode: "PLATFORM_BACKUP_DECLARED_MANUAL",
      requiredLabel: probe.label,
      onDuty: labels.includes(probe.label),
      declaredCadence: declared.cadences,
      cadenceSource: declared.source,
      lastLocalSnapshotAt: localFreshness.latestAt ?? null,
      freshnessAsserted: false,
      source: "chain backup.cadence + install-manifest",
    });
  }
  if (!labels.includes(probe.label)) {
    return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_NOT_ON_DUTY", requiredLabel: probe.label, observedLabels: labels, declaredCadence: declared.cadences, cadenceSource: declared.source, source: "install-manifest" });
  }
  const status = await launchdStatus(probe.label, options);
  if (status.unavailable) return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_STATUS_UNAVAILABLE", requiredLabel: probe.label, error: status.error });
  if (status.lastExitCode !== null && status.lastExitCode !== 0) {
    return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_LAST_RUN_FAILED", requiredLabel: probe.label, lastExitCode: status.lastExitCode, source: "launchctl print" });
  }
  const localFreshness = await localSnapshotFreshness(options, options.platformRoot, manifest, probe.maxAgeHours);
  if (!localFreshness.ok) {
    return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_SNAPSHOT_STALE", requiredLabel: probe.label, lastExitCode: status.lastExitCode, freshness: localFreshness, maxAgeHours: probe.maxAgeHours, source: "local snapshot receipt" });
  }
  const offsiteFreshness = await offsitePushFreshness(options, options.platformRoot, manifest, probe.maxAgeHours);
  if (!offsiteFreshness.ok) {
    return check("launchd", false, { reasonCode: "PLATFORM_OFFSITE_PUSH_STALE", requiredLabel: probe.label, lastExitCode: status.lastExitCode, freshness: offsiteFreshness, maxAgeHours: probe.maxAgeHours, source: "offsite push receipt" });
  }
  return check("launchd", true, { requiredLabel: probe.label, lastExitCode: status.lastExitCode, localFreshness, offsiteFreshness, declaredCadence: declared.cadences, cadenceSource: declared.source, source: "chain backup.cadence + install-manifest + launchctl + local/offsite receipts" });
}

export async function inspectPlatform(platformRootArgument, options = {}) {
  if (typeof platformRootArgument !== "string" || platformRootArgument.trim().length === 0) {
    return { ok: false, reasonCode: "PLATFORM_ROOT_REQUIRED", checks: [check("platformRoot", false, { reasonCode: "PLATFORM_ROOT_REQUIRED" })] };
  }
  const requestedRoot = resolve(platformRootArgument);
  let root;
  try {
    root = await realpath(requestedRoot);
  } catch (error) {
    return { ok: false, reasonCode: "PLATFORM_ROOT_INVALID", checks: [check("platformRoot", false, { reasonCode: "PLATFORM_ROOT_INVALID", path: requestedRoot, error: error?.code ?? "UNKNOWN" })] };
  }
  const rootStats = await existingPath(root);
  if (!rootStats?.isDirectory()) return { ok: false, reasonCode: "PLATFORM_ROOT_INVALID", checks: [check("platformRoot", false, { reasonCode: "PLATFORM_ROOT_INVALID", path: root })] };
  const homeRoot = resolve(options.homeRoot ?? process.env.HOME ?? "");
  const manifest = options.manifest ?? INSTALL_MANIFEST;
  assertInstallManifestComplete(manifest);
  const checks = [
    check("platformRoot", true, { path: root }),
    await inspectAgents(root),
    await inspectWorkspaceContainer(root),
    await inspectGitAncestors(root),
    await inspectClaudeBridge(root),
    await inspectBridgeSyntax(root),
  ];
  if (options.includeInstallSurface !== false) {
    checks.push(
      await inspectHelperCopies(root, homeRoot, manifest, options),
      await inspectInstallWiring(root, homeRoot, manifest),
      await inspectHookExecutability(root, manifest),
      await inspectDeploymentFreshness(homeRoot, manifest),
      await inspectEngineAlignment(root, homeRoot, manifest, options),
      await inspectHelperSettingsCoverage(root, homeRoot, manifest, options),
      await inspectTrustArchiveFreshness(root, homeRoot, manifest, options),
      await inspectLaunchdDuty({ ...options, platformRoot: root, homeRoot }, manifest),
      await inspectHarnessSurface(root, manifest),
      await inspectHarnessCoverage(root),
    );
  }
  const firstFailure = checks.find((item) => !item.ok);
  // Observations are reported beside the verdict, never inside it: `firstFailure` reads
  // `checks` only, so an identity drift is visible without being able to turn the
  // platform red (TCRN-CROSS-INC-219).
  const observations = options.includeInstallSurface === false
    ? []
    : await adapterIdentityObservations(manifest, root, homeRoot);
  return { ok: !firstFailure, reasonCode: firstFailure?.reasonCode ?? "PLATFORM_LAYOUT_HEALTHY", checks, observations };
}

function platformRootFromArgv(argv) {
  const index = argv.indexOf("--platform-root");
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--")) return null;
  if (argv.some((argument, argumentIndex) => argumentIndex !== index && argumentIndex !== index + 1 && argument.startsWith("--"))) return null;
  return argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const platformRoot = platformRootFromArgv(process.argv.slice(2));
  const result = await inspectPlatform(platformRoot);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
