// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { assertDistinctRoots } from "../dist/build/packages/core/src/root-identity.js";

async function rootsFixture() {
  const temporary = await mkdtemp(join(tmpdir(), "tcrn-roots-"));
  const root = await realpath(temporary);
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = resolve(root, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  return { root, roots };
}

async function expectRootReason(roots, reasonCode) {
  await assert.rejects(assertDistinctRoots(roots), (error) => error.reasonCode === reasonCode);
}

test("all five canonical sibling roots are admitted", async (context) => {
  const fixture = await rootsFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const admitted = await assertDistinctRoots(fixture.roots);
  assert.equal(admitted.length, 5);
  assert.deepEqual(admitted.map((root) => root.kind), fixture.roots.map((root) => root.kind));
});

test("missing, duplicate, equal, and contained roots fail closed", async (context) => {
  const fixture = await rootsFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await expectRootReason(fixture.roots.slice(0, 4), "ROOT_SET_INCOMPLETE");
  await expectRootReason(
    fixture.roots.map((root, index) => index === 4 ? { ...root, kind: "framework" } : root),
    "ROOT_KIND_DUPLICATE",
  );
  await expectRootReason(
    fixture.roots.map((root, index) => index === 4 ? { ...root, path: fixture.roots[0].path } : root),
    "ROOT_PATH_COLLISION",
  );
  const child = resolve(fixture.roots[0].path, "child");
  await mkdir(child);
  await expectRootReason(
    fixture.roots.map((root, index) => index === 4 ? { ...root, path: child } : root),
    "ROOT_PATH_CONTAINMENT",
  );
});

test("lexical, symlink, and case aliases fail closed", async (context) => {
  const fixture = await rootsFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await expectRootReason(
    fixture.roots.map((root, index) => index === 1 ? { ...root, path: `${root.path}/../workspace` } : root),
    "ROOT_PATH_ALIAS",
  );
  const alias = resolve(fixture.root, "workspace-alias");
  await symlink(fixture.roots[1].path, alias);
  await expectRootReason(
    fixture.roots.map((root, index) => index === 1 ? { ...root, path: alias } : root),
    "ROOT_PATH_SYMLINK",
  );
  await expectRootReason(
    fixture.roots.map((root, index) => index === 1 ? { ...root, path: root.path.toUpperCase() } : root),
    "ROOT_PATH_ALIAS",
  );
});
