#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { basename, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { INSTALL_MANIFEST, assertInstallManifestComplete } from "../dist/build/packages/core/src/index.js";

const SURFACE_NAMES = Object.freeze([
  ".claude",
  ".codex",
  ".mcp.json",
  "AGENTS.md",
  "CLAUDE.md",
  ".tcrn-install-receipts",
]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", ".tcrn-workspace", ".tcrn-artifacts"]);
const execFileAsync = promisify(execFile);

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function markerRules(options) {
  const rules = [
    { reasonCode: "CROSS_REPO_ABSOLUTE_PATH", expression: /(?:^|[\s"'`=(,:])\/(?:Users|home|private)\//u },
    { reasonCode: "CROSS_REPO_WINDOWS_PATH", expression: /(?:^|[\s"'`=(,:])[A-Za-z]:[\\/]/u },
  ];
  const names = [options.userName, options.hostName, options.governedHost]
    .filter((value) => typeof value === "string" && value.trim().length >= 3)
    .map((value) => value.trim());
  for (const value of [...new Set(names)]) {
    rules.push({ reasonCode: "CROSS_REPO_PRIVATE_IDENTITY", expression: new RegExp(`(?:^|[^A-Za-z0-9_])${escaped(value)}(?:$|[^A-Za-z0-9_])`, "u"), value });
  }
  return rules;
}

async function statOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function surfaceFiles(root, relativePath = "", options = {}) {
  const absolute = resolve(root, relativePath);
  const stats = await statOrNull(absolute);
  if (!stats) return [];
  if (stats.isFile()) {
    const relativePathValue = relative(root, absolute);
    // A repository's ignored host settings are local instance state, not
    // public repository content. Receipts are the one intentionally scanned
    // untracked surface because INIT-033 wrote them into project roots.
    if (options.trackedOnly && !options.trackedFiles.has(relativePathValue) && !relativePathValue.startsWith(".tcrn-install-receipts/")) return [];
    return [{ absolute, relativePath: relativePathValue }];
  }
  if (!stats.isDirectory()) return [];
  const files = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const child = relativePath.length === 0 ? entry.name : `${relativePath}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    files.push(...await surfaceFiles(root, child, options));
  }
  return files;
}

async function trackedFiles(root) {
  try {
    const result = await execFileAsync("git", ["-C", root, "ls-files", "--cached"], { timeout: 10_000, maxBuffer: 4_194_304 });
    return new Set(result.stdout.split("\n").map((value) => value.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

async function scanFile(file, root, projectName, rules) {
  const bytes = await readFile(file.absolute);
  const text = bytes.toString("utf8");
  const findings = [];
  for (const rule of rules) {
    const match = rule.expression.exec(text);
    if (match) {
      findings.push({ reasonCode: rule.reasonCode, value: rule.value, offset: match.index });
    }
  }
  return findings.length === 0 ? [] : [{
    project: projectName,
    path: file.absolute,
    relativePath: relative(root, file.absolute),
    findings,
  }];
}

export async function inspectCrossRepoPrivacy(platformRootArgument, options = {}) {
  if (typeof platformRootArgument !== "string" || platformRootArgument.trim().length === 0) {
    return { ok: false, reasonCode: "PLATFORM_ROOT_REQUIRED", projects: [], findings: [] };
  }
  const requestedRoot = resolve(platformRootArgument);
  let platformRoot;
  try {
    platformRoot = await realpath(requestedRoot);
  } catch (error) {
    return { ok: false, reasonCode: "PLATFORM_ROOT_INVALID", path: requestedRoot, error: error?.code ?? "UNKNOWN", projects: [], findings: [] };
  }
  const manifest = options.manifest ?? INSTALL_MANIFEST;
  if (manifest === INSTALL_MANIFEST) assertInstallManifestComplete(manifest);
  const rules = markerRules({
    userName: options.userName ?? userInfo().username,
    hostName: options.hostName ?? hostname(),
    governedHost: options.governedHost ?? process.env.TCRN_SSH_GOVERNED_HOST,
  });
  const projects = [];
  const findings = [];
  for (const project of manifest.projects) {
    const projectRoot = resolve(project.pathTemplate.replaceAll("<PLATFORM_ROOT>", platformRoot));
    const projectStats = await statOrNull(projectRoot);
    if (!projectStats?.isDirectory()) {
      projects.push({ name: project.name, path: projectRoot, ok: false, reasonCode: "CROSS_REPO_PROJECT_ROOT_MISSING" });
      continue;
    }
    const tracked = await trackedFiles(projectRoot);
    const scanOptions = { trackedOnly: tracked !== null, trackedFiles: tracked ?? new Set() };
    const files = [];
    for (const surfaceName of SURFACE_NAMES) files.push(...await surfaceFiles(projectRoot, surfaceName, scanOptions));
    const projectFindings = [];
    for (const file of files) projectFindings.push(...await scanFile(file, projectRoot, project.name, rules));
    findings.push(...projectFindings);
    projects.push({ name: project.name, path: projectRoot, filesScanned: files.length, findings: projectFindings.length, ok: projectFindings.length === 0 });
  }
  const missing = projects.filter((project) => project.reasonCode === "CROSS_REPO_PROJECT_ROOT_MISSING");
  return {
    ok: missing.length === 0 && findings.length === 0,
    reasonCode: missing.length > 0 ? "CROSS_REPO_PROJECT_ROOT_MISSING" : findings.length > 0 ? "CROSS_REPO_PRIVACY_LEAK" : "CROSS_REPO_PRIVACY_GREEN",
    projects,
    findings,
    scannedSurfaceNames: SURFACE_NAMES,
  };
}

function platformRootFromArgv(argv) {
  const index = argv.indexOf("--platform-root");
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--")) return null;
  if (argv.some((argument, argumentIndex) => argumentIndex !== index && argumentIndex !== index + 1 && argument.startsWith("--"))) return null;
  return argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await inspectCrossRepoPrivacy(platformRootFromArgv(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
