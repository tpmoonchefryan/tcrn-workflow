#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { readJson, repositoryRoot } from "./lib/files.mjs";
import { readBoundRegularFile, safeWriteOutput } from "./lib/safe-io.mjs";
import "./no-network.mjs";

function run(executable, arguments_, cwd, { acceptedStatuses = [0], env = process.env } = {}) {
  if (![process.execPath, "git", "pnpm"].includes(executable)) {
    throw new Error(`ISOLATED_EXECUTABLE_NOT_ALLOWED:${executable}`);
  }
  if (executable === "git" && arguments_[0] === "clone" && !arguments_.includes("--local")) {
    throw new Error("ISOLATED_GIT_CLONE_MUST_BE_LOCAL");
  }
  const result = spawnSync(executable, arguments_, { cwd, encoding: "utf8", env });
  if (!acceptedStatuses.includes(result.status)) {
    throw new Error(`ISOLATED_COMMAND_FAILED:${executable} ${arguments_.join(" ")}\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

function git(arguments_, cwd = repositoryRoot, options) {
  return run("git", arguments_, cwd, options);
}

const initialStatus = git(["status", "--porcelain=v1"]);
if (initialStatus !== "") {
  throw new Error("ISOLATED_SOURCE_BASIS_DIRTY");
}
if (process.version !== "v24.16.0") {
  throw new Error(`ISOLATED_NODE_VERSION:${process.version}`);
}
const sourceGuardUrl = pathToFileURL(resolve(repositoryRoot, "scripts/no-network.mjs")).href;
const pinnedEnvironment = {
  ...process.env,
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  NODE_OPTIONS: `--import=${sourceGuardUrl}`,
  TCRN_OFFLINE_PROOF: "1",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_offline: "true",
};
if (run("pnpm", ["--version"], repositoryRoot, { env: pinnedEnvironment }) !== "11.3.0") {
  throw new Error("ISOLATED_PNPM_VERSION");
}

const commit = git(["rev-parse", "HEAD"]);
const tree = git(["rev-parse", "HEAD^{tree}"]);
const origin = git(["remote", "get-url", "origin"]);
if (!/^https:\/\/github\.com\/[^/]+\/tcrn-workflow\.git$/u.test(origin)) {
  throw new Error(`ISOLATED_ORIGIN_INVALID:${origin}`);
}

const temporary = await mkdtemp(join(tmpdir(), "tcrn-isolated-proof-"));
const checkout = resolve(temporary, "checkout");
try {
  git(["clone", "--local", "--no-hardlinks", "--no-checkout", repositoryRoot, checkout], repositoryRoot);
  git(["remote", "set-url", "origin", origin], checkout);
  git(["checkout", "--detach", commit], checkout);
  git(["branch", "-f", "main", commit], checkout);
  git(["checkout", "main"], checkout);
  git(["update-ref", "-d", "refs/remotes/origin/main"], checkout, { acceptedStatuses: [0, 1] });
  git(["symbolic-ref", "-d", "refs/remotes/origin/HEAD"], checkout, { acceptedStatuses: [0, 1] });
  git(["config", "--unset-all", "branch.main.remote"], checkout, { acceptedStatuses: [0, 1, 5] });
  git(["config", "--unset-all", "branch.main.merge"], checkout, { acceptedStatuses: [0, 1, 5] });
  git(["reflog", "expire", "--expire=now", "--all"], checkout);
  git(["gc", "--prune=now"], checkout);
  if (git(["rev-parse", "HEAD"], checkout) !== commit || git(["rev-parse", "HEAD^{tree}"], checkout) !== tree) {
    throw new Error("ISOLATED_BASIS_MISMATCH");
  }
  if (git(["remote", "get-url", "origin"], checkout) !== origin) {
    throw new Error("ISOLATED_ORIGIN_MISMATCH");
  }

  const guardUrl = pathToFileURL(resolve(checkout, "scripts/no-network.mjs")).href;
  const proof = run("pnpm", ["verify:p1"], checkout, {
    env: {
      ...process.env,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      NODE_OPTIONS: `--import=${guardUrl}`,
      TCRN_OFFLINE_PROOF: "1",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
    },
  });
  const terminal = JSON.parse(proof.split("\n").filter(Boolean).at(-1));
  if (!terminal.ok || terminal.reasonCode !== "P1_VERIFIED") {
    throw new Error(`ISOLATED_P1_REASON:${JSON.stringify(terminal)}`);
  }

  const map = await readJson(resolve(checkout, "verification-map.yaml"));
  const evidencePaths = [...new Set(
    map.claims
      .filter((claim) => claim.phase === "P1" && claim.expectedReasonCode !== "ISOLATED_P1_VERIFIED")
      .map((claim) => claim.evidencePath),
  )].sort();
  const evidence = [];
  for (const path of evidencePaths) {
    const input = await readBoundRegularFile(resolve(checkout, path), {
      reasonCode: "ISOLATED_EVIDENCE_INVALID",
      hardlinkReasonCode: "ISOLATED_EVIDENCE_HARDLINK",
      pathChangedReasonCode: "ISOLATED_EVIDENCE_CHANGED",
    });
    evidence.push({
      path,
      size: input.metadata.size,
      sha256: createHash("sha256").update(input.content).digest("hex"),
      reasonCode: JSON.parse(input.content.toString("utf8")).reasonCode,
    });
  }
  if (git(["status", "--porcelain=v1"], checkout) !== "") {
    throw new Error("ISOLATED_CHECKOUT_DIRTY");
  }
  if (git(["status", "--porcelain=v1"]) !== initialStatus) {
    throw new Error("ISOLATED_SOURCE_BASIS_MUTATED");
  }
  const receipt = {
    schemaVersion: "tcrn.isolated-p1-proof.v1",
    reasonCode: "ISOLATED_P1_VERIFIED",
    commit,
    tree,
    origin,
    node: process.version.slice(1),
    pnpm: "11.3.0",
    sourceBasisMutated: false,
    checkoutClean: true,
    evidence,
  };
  await safeWriteOutput(
    repositoryRoot,
    "dist/evidence/p1/isolated.json",
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
