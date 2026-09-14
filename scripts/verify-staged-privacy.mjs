#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-425: scan the bytes currently in Git's index before they can
// become a reachable commit. This is deliberately an incremental companion to
// verify:privacy; it never narrows or replaces the historical privacy scan.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { privateRuntimeConfig } from "./lib/private-token-roster.mjs";
import { scanPrivacyEntries } from "./lib/privacy.mjs";

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const STAGED_DIFF_FILTER = "ACMRTUXB";

class StagedPrivacyError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "StagedPrivacyError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, message) {
  throw new StagedPrivacyError(reasonCode, message);
}

function runGit(root, arguments_, { allowStderr = false } = {}) {
  const result = spawnSync("git", ["--no-optional-locks", ...arguments_], {
    cwd: root,
    encoding: null,
    maxBuffer: MAX_CAPTURE_BYTES,
  });
  if (result.error) fail("PRIVACY_STAGED_GIT_UNAVAILABLE", result.error.message);
  if (result.status !== 0) {
    fail("PRIVACY_STAGED_GIT_COMMAND_FAILED", `${arguments_.join(" ")}: ${result.stderr.toString("utf8")}`.trim());
  }
  if (!allowStderr && result.stderr.length > 0) {
    fail("PRIVACY_STAGED_GIT_UNEXPECTED_STDERR", `${arguments_.join(" ")}: ${result.stderr.toString("utf8")}`.trim());
  }
  return result.stdout;
}

function discoverRepositoryRoot() {
  const result = spawnSync("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 4096,
  });
  if (result.error) fail("PRIVACY_STAGED_GIT_UNAVAILABLE", result.error.message);
  if (result.status !== 0) fail("PRIVACY_STAGED_NOT_A_REPOSITORY", result.stderr.trim());
  const root = result.stdout.trim();
  if (root.length === 0) fail("PRIVACY_STAGED_REPOSITORY_ROOT_MISSING", "git returned an empty repository root");
  return resolve(root);
}

function remoteOwner(root) {
  const remote = runGit(root, ["remote", "get-url", "origin"]).toString("utf8").trim();
  const match = remote.match(/github\.com[/:]([^/]+)\/tcrn-workflow(?:\.git)?$/u);
  if (!match) fail("PRIVACY_ORIGIN_UNEXPECTED", remote);
  return match[1];
}

function stagedPaths(root) {
  const output = runGit(root, [
    "diff",
    "--cached",
    "--name-only",
    "--no-renames",
    `--diff-filter=${STAGED_DIFF_FILTER}`,
    "-z",
    "--",
  ]);
  return output.toString("utf8").split("\0").filter(Boolean);
}

function stagedIndexEntry(root, path) {
  const output = runGit(root, ["ls-files", "--stage", "-z", "--", path]);
  const records = output.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const separator = record.indexOf("\t");
    if (separator < 0) fail("PRIVACY_STAGED_INDEX_RECORD_INVALID", path);
    const [mode, object, stage] = record.slice(0, separator).split(/\s+/u);
    if (!/^[0-9]{6}$/u.test(mode) || !/^[a-f0-9]{40,64}$/u.test(object) || !/^[0-3]$/u.test(stage)) {
      fail("PRIVACY_STAGED_INDEX_RECORD_INVALID", path);
    }
    return { mode, object, stage, path: record.slice(separator + 1) };
  });
  if (records.length === 0) fail("PRIVACY_STAGED_INDEX_ENTRY_MISSING", path);
  if (records.length !== 1 || records[0].stage !== "0") fail("PRIVACY_STAGED_INDEX_UNMERGED", path);
  return records[0];
}

function stagedContent(root, path) {
  const result = spawnSync("git", ["--no-optional-locks", "show", `:${path}`], {
    cwd: root,
    encoding: null,
    maxBuffer: MAX_CAPTURE_BYTES,
  });
  if (result.error) fail("PRIVACY_STAGED_GIT_UNAVAILABLE", result.error.message);
  if (result.status !== 0) fail("PRIVACY_STAGED_CONTENT_UNREADABLE", `${path}: ${result.stderr.toString("utf8")}`.trim());
  if (result.stderr.length > 0) fail("PRIVACY_STAGED_GIT_UNEXPECTED_STDERR", `${path}: ${result.stderr.toString("utf8")}`.trim());
  return result.stdout;
}

function scanStaged(root) {
  const owner = remoteOwner(root);
  const paths = stagedPaths(root);
  const entries = [];
  let bytes = 0;
  const objects = [];
  for (const path of paths) {
    const indexEntry = stagedIndexEntry(root, path);
    entries.push({ label: `staged-filename:${path}`, kind: "filename", content: path });
    // A gitlink stores a commit id in the index, not a blob owned by this
    // repository. Its path is still scanned above; there are no local bytes to
    // inspect without reaching into a sibling repository.
    if (indexEntry.mode === "160000") {
      objects.push({ path, object: indexEntry.object, mode: indexEntry.mode, bytes: 0, scanned: false });
      continue;
    }
    const content = stagedContent(root, path);
    bytes += content.length;
    entries.push({ label: `staged-source:${path}`, kind: "source", content: content.toString("utf8") });
    objects.push({ path, object: indexEntry.object, mode: indexEntry.mode, bytes: content.length, scanned: true });
  }
  const runtime = privateRuntimeConfig();
  const privateTokens = runtime.configured
    ? [runtime.host, runtime.runtimeRoot, `${runtime.runtimeRoot}/governance`]
    : [];
  const findings = scanPrivacyEntries(entries, { owner, privateTokens });
  return {
    ok: findings.length === 0,
    reasonCode: findings.length === 0 ? "PRIVACY_STAGED_CLEAN" : "PRIVACY_STAGED_FINDINGS",
    scope: "staged-index-increment-only",
    owner,
    stagedPaths: paths.length,
    scannedEntries: entries.length,
    stagedBytes: bytes,
    objects,
    findings,
    historicalScan: "preserved-by-pnpm-verify:privacy",
  };
}

try {
  const root = discoverRepositoryRoot();
  const result = scanStaged(root);
  process.stdout.write(`${JSON.stringify({ ...result, repositoryRoot: root })}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    reasonCode: error?.reasonCode ?? "PRIVACY_STAGED_INTERNAL_ERROR",
    error: error?.message ?? String(error),
  })}\n`);
  process.exitCode = error?.reasonCode === "PRIVACY_STAGED_FINDINGS" ? 1 : 2;
}
