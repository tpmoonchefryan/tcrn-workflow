// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { cp, lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { compareCanonicalText } from "./canonical-order.mjs";
import { validateFrozenDependencyGraph } from "./dependency-graph.mjs";

const manifestName = "dependency-materialization.json";
const schemaVersion = "tcrn.dependency-materialization.v1";

function fail(reasonCode, detail = "") {
  const error = new Error(detail || reasonCode);
  error.reasonCode = reasonCode;
  throw error;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function inside(root, candidate) {
  const relation = relative(root, candidate);
  return relation !== "" && !relation.startsWith("..") && !relation.includes("../");
}

async function regularDirectory(path, reasonCode) {
  const metadata = await lstat(path).catch((error) => fail(reasonCode, `${path}: ${error.code ?? error.message}`));
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(reasonCode, path);
  return metadata;
}

export async function inventoryMaterializedStore(storeRoot) {
  const realRoot = resolve(storeRoot);
  await regularDirectory(realRoot, "DEPENDENCY_MATERIALIZATION_STORE_INVALID");
  const records = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareCanonicalText(left.name, right.name))) {
      const path = resolve(directory, entry.name);
      const metadata = await lstat(path).catch((error) => fail("DEPENDENCY_MATERIALIZATION_STORE_INVALID", `${path}: ${error.code ?? error.message}`));
      if (metadata.isSymbolicLink()) fail("DEPENDENCY_MATERIALIZATION_STORE_INVALID", path);
      if (metadata.isDirectory()) {
        await visit(path);
      } else if (metadata.isFile()) {
        records.push({ path: relative(realRoot, path), size: metadata.size, sha256: sha256(await readFile(path)) });
      } else {
        fail("DEPENDENCY_MATERIALIZATION_STORE_INVALID", path);
      }
    }
  }
  await visit(realRoot);
  if (records.length === 0) fail("DEPENDENCY_MATERIALIZATION_STORE_EMPTY", realRoot);
  return records.sort((left, right) => compareCanonicalText(left.path, right.path));
}

async function exactInputs(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const [packageJson, dependencyPolicy, lockContent] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, "scripts/policy/dependency-policy.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, "pnpm-lock.yaml"), "utf8"),
  ]);
  const graph = validateFrozenDependencyGraph({ packageJson, dependencyPolicy, lockContent });
  return {
    lockSha256: sha256(lockContent),
    packages: graph.records.map(({ identity, integrity }) => ({ identity, integrity })),
  };
}

function canonicalManifest(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function createDependencyMaterialization(repositoryRoot, materializationRoot) {
  const root = resolve(materializationRoot);
  const entries = await readdir(root).catch((error) => fail("DEPENDENCY_MATERIALIZATION_ROOT_INVALID", `${root}: ${error.code ?? error.message}`));
  if (entries.length !== 1 || entries[0] !== "store") fail("DEPENDENCY_MATERIALIZATION_ROOT_DIRTY", root);
  const inputs = await exactInputs(repositoryRoot);
  const manifest = {
    schemaVersion,
    lockSha256: inputs.lockSha256,
    packages: inputs.packages,
    store: await inventoryMaterializedStore(resolve(root, "store")),
  };
  await writeFile(resolve(root, manifestName), canonicalManifest(manifest), { mode: 0o600, flag: "wx" }).catch((error) => fail("DEPENDENCY_MATERIALIZATION_WRITE_FAILED", `${root}: ${error.code ?? error.message}`));
  return manifest;
}

export async function verifyDependencyMaterialization(repositoryRoot, materializationRoot) {
  const root = resolve(materializationRoot);
  await regularDirectory(root, "DEPENDENCY_MATERIALIZATION_ROOT_INVALID");
  const entries = (await readdir(root)).sort(compareCanonicalText);
  if (JSON.stringify(entries) !== JSON.stringify([manifestName, "store"])) fail("DEPENDENCY_MATERIALIZATION_EXTRA_ARTIFACT", root);
  const raw = await readFile(resolve(root, manifestName), "utf8").catch((error) => fail("DEPENDENCY_MATERIALIZATION_MANIFEST_INVALID", `${root}: ${error.code ?? error.message}`));
  let manifest;
  try { manifest = JSON.parse(raw); } catch { fail("DEPENDENCY_MATERIALIZATION_MANIFEST_INVALID", root); }
  if (raw !== canonicalManifest(manifest) || manifest?.schemaVersion !== schemaVersion || !Array.isArray(manifest.packages) || !Array.isArray(manifest.store)) {
    fail("DEPENDENCY_MATERIALIZATION_MANIFEST_INVALID", root);
  }
  const inputs = await exactInputs(repositoryRoot);
  if (manifest.lockSha256 !== inputs.lockSha256 || JSON.stringify(manifest.packages) !== JSON.stringify(inputs.packages)) {
    fail("DEPENDENCY_MATERIALIZATION_LOCK_MISMATCH", root);
  }
  const store = await inventoryMaterializedStore(resolve(root, "store"));
  if (JSON.stringify(manifest.store) !== JSON.stringify(store)) fail("DEPENDENCY_MATERIALIZATION_STORE_MISMATCH", root);
  return manifest;
}

export async function populateDependencyStore(repositoryRoot, materializationRoot, targetStore) {
  const manifest = await verifyDependencyMaterialization(repositoryRoot, materializationRoot);
  const target = resolve(targetStore);
  const existing = await lstat(target).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing) fail("DEPENDENCY_MATERIALIZATION_TARGET_EXISTS", target);
  await cp(resolve(materializationRoot, "store"), target, { recursive: true, force: false, errorOnExist: true }).catch((error) => fail("DEPENDENCY_MATERIALIZATION_POPULATE_FAILED", `${target}: ${error.code ?? error.message}`));
  const actual = await inventoryMaterializedStore(target);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.store)) fail("DEPENDENCY_MATERIALIZATION_POPULATE_MISMATCH", target);
  return manifest;
}
