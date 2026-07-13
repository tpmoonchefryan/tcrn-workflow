#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { createDependencyMaterialization, populateDependencyStore, verifyDependencyMaterialization } from "./lib/dependency-materialization.mjs";
import { repositoryRoot } from "./lib/files.mjs";

function fail(reasonCode, detail = "") { const error = new Error(detail || reasonCode); error.reasonCode = reasonCode; throw error; }
function argument(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }

const mode = argument("--mode");
const materialization = argument("--materialization");
if (!["fetch", "verify", "populate"].includes(mode) || !materialization || !resolve(materialization).startsWith("/")) fail("DEPENDENCY_MATERIALIZATION_ARGUMENTS");

let result;
if (mode === "fetch") {
  if (!process.argv.includes("--allow-network-fetch")) fail("DEPENDENCY_MATERIALIZATION_NETWORK_AUTH_REQUIRED");
  const root = resolve(materialization);
  await mkdir(root, { mode: 0o700, recursive: true });
  if ((await readdir(root)).length !== 0) fail("DEPENDENCY_MATERIALIZATION_ROOT_DIRTY", root);
  const store = resolve(root, "store");
  const modules = resolve(root, ".fetch-modules");
  const fetch = spawnSync("pnpm", ["fetch", "--frozen-lockfile", "--ignore-scripts", "--store-dir", store, "--modules-dir", modules, "--config.offline=false"], { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_audit: "false", npm_config_fund: "false" } });
  await rm(modules, { recursive: true, force: true });
  if (fetch.status !== 0) fail("DEPENDENCY_MATERIALIZATION_FETCH_FAILED", `${fetch.stdout}${fetch.stderr}`);
  // pnpm's project index is a source-checkout symlink, not a retained package
  // artifact. It is deliberately excluded so the materialization is portable.
  await rm(resolve(store, "v11/projects"), { recursive: true, force: true });
  result = await createDependencyMaterialization(repositoryRoot, root);
} else if (mode === "verify") {
  result = await verifyDependencyMaterialization(repositoryRoot, materialization);
} else {
  const store = argument("--target-store");
  if (!store || !resolve(store).startsWith("/")) fail("DEPENDENCY_MATERIALIZATION_ARGUMENTS");
  result = await populateDependencyStore(repositoryRoot, materialization, store);
}
process.stdout.write(`${JSON.stringify({ ok: true, reasonCode: "DEPENDENCY_MATERIALIZATION_VERIFIED", lockSha256: result.lockSha256, packages: result.packages.length, storeFiles: result.store.length })}\n`);
