// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createDependencyMaterialization, populateDependencyStore, verifyDependencyMaterialization } from "../scripts/lib/dependency-materialization.mjs";

const productRoot = resolve(import.meta.dirname, "..");

async function sourceFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "tcrn-dependency-materialization-source-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "scripts/policy"), { recursive: true });
  await Promise.all([
    cp(resolve(productRoot, "package.json"), resolve(root, "package.json")),
    cp(resolve(productRoot, "pnpm-lock.yaml"), resolve(root, "pnpm-lock.yaml")),
    cp(resolve(productRoot, "scripts/policy/dependency-policy.json"), resolve(root, "scripts/policy/dependency-policy.json")),
  ]);
  return root;
}

async function materializationFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "tcrn-dependency-materialization-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "store/v11/files"), { recursive: true });
  await writeFile(resolve(root, "store/v11/files/alpha"), "alpha\n", { mode: 0o600 });
  await writeFile(resolve(root, "store/v11/files/beta"), "beta\n", { mode: 0o600 });
  return root;
}

test("materialization binds a complete store inventory to the exact frozen lockfile and populates only an absent target", async (context) => {
  const [source, materialization] = await Promise.all([sourceFixture(context), materializationFixture(context)]);
  const created = await createDependencyMaterialization(source, materialization);
  assert.equal(created.packages.length, 8);
  assert.equal((await verifyDependencyMaterialization(source, materialization)).store.length, 2);
  const targetParent = await mkdtemp(join(tmpdir(), "tcrn-dependency-materialization-target-"));
  context.after(() => rm(targetParent, { recursive: true, force: true }));
  await populateDependencyStore(source, materialization, resolve(targetParent, "store"));
  assert.equal((await readFile(resolve(targetParent, "store/v11/files/alpha"), "utf8")), "alpha\n");
  await assert.rejects(populateDependencyStore(source, materialization, resolve(targetParent, "store")), (error) => error.reasonCode === "DEPENDENCY_MATERIALIZATION_TARGET_EXISTS");
});

test("materialization rejects substituted, omitted, extra, and wrong-lockfile inputs", async (context) => {
  const [source, materialization] = await Promise.all([sourceFixture(context), materializationFixture(context)]);
  await createDependencyMaterialization(source, materialization);
  await writeFile(resolve(materialization, "store/v11/files/alpha"), "substituted\n", { mode: 0o600 });
  await assert.rejects(verifyDependencyMaterialization(source, materialization), (error) => error.reasonCode === "DEPENDENCY_MATERIALIZATION_STORE_MISMATCH");
  await writeFile(resolve(materialization, "store/v11/files/alpha"), "alpha\n", { mode: 0o600 });
  await rm(resolve(materialization, "store/v11/files/beta"));
  await assert.rejects(verifyDependencyMaterialization(source, materialization), (error) => error.reasonCode === "DEPENDENCY_MATERIALIZATION_STORE_MISMATCH");
  await writeFile(resolve(materialization, "store/v11/files/beta"), "beta\n", { mode: 0o600 });
  await writeFile(resolve(materialization, "unexpected"), "extra\n", { mode: 0o600 });
  await assert.rejects(verifyDependencyMaterialization(source, materialization), (error) => error.reasonCode === "DEPENDENCY_MATERIALIZATION_EXTRA_ARTIFACT");
  await rm(resolve(materialization, "unexpected"));
  const manifestPath = resolve(materialization, "dependency-materialization.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.packages[0].integrity = "sha512-substituted";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(verifyDependencyMaterialization(source, materialization), (error) => error.reasonCode === "DEPENDENCY_MATERIALIZATION_LOCK_MISMATCH");
  await writeFile(resolve(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await assert.rejects(verifyDependencyMaterialization(source, materialization));
});
