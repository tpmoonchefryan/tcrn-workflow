// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  SnapshotError,
  acquireWorkspaceLease,
  createProject,
  createSnapshotManifest,
  verifySnapshotManifest,
  initializeWorkspace,
} from "../dist/build/packages/core/src/index.js";

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

async function workspaceFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-bk-")));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "WORKSPACE-BK", createdAt: instant(0), segmentEventLimit: 2 });
  const seed = await acquireWorkspaceLease(workspace, { now: instant(1) });
  try {
    await createProject(workspace, seed, { externalKey: "PROJ-ALPHA", name: "Alpha", expectedVersion: 0, occurredAt: instant(2) });
    await createProject(workspace, seed, { externalKey: "PROJ-BETA", name: "Beta", expectedVersion: 1, occurredAt: instant(3) });
  } finally {
    await seed.release();
  }
  return {
    base,
    workspace,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function manifestUnderLease(workspace, second, action) {
  const lease = await acquireWorkspaceLease(workspace, { now: instant(second) });
  try {
    return await action(lease);
  } finally {
    await lease.release();
  }
}

async function listTree(root) {
  const entries = [];
  const walk = async (directory, base) => {
    const dirents = (await readdir(directory, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : 1));
    for (const dirent of dirents) {
      const relative = base === "" ? dirent.name : `${base}/${dirent.name}`;
      const full = join(directory, dirent.name);
      if (dirent.isDirectory()) {
        entries.push(`d ${relative}`);
        await walk(full, relative);
      } else {
        const stats = await lstat(full);
        entries.push(`f ${relative} ${stats.size}`);
      }
    }
  };
  await walk(root, "");
  return entries;
}

async function invokeCli(args) {
  let output = "";
  return runCli(args, { write: (value) => { output += value; } }).then(
    () => ({ ok: true, output }),
    (error) => ({ ok: false, reasonCode: error?.reasonCode }),
  );
}

test("WSF-2 case 1: snapshot-manifest is byte-identical across two runs on an unchanged workspace", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  const [first, second] = await manifestUnderLease(fixture.workspace, 4, async (lease) => [
    await createSnapshotManifest(fixture.workspace, lease),
    await createSnapshotManifest(fixture.workspace, lease),
  ]);
  assert.equal(first, second, "two consecutive manifests must be byte-identical");
});

test("WSF-2 case 2: snapshot-manifest fails WORKSPACE_LOCKED against a lease-held workspace", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  const holder = await acquireWorkspaceLease(fixture.workspace, { now: instant(4) });
  try {
    const outcome = await invokeCli(["snapshot-manifest", "--workspace", fixture.workspace, "--at", instant(5)]);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "WORKSPACE_LOCKED");
  } finally {
    await holder.release();
  }
});

test("WSF-2 case 3: control-dir quarantine residue fails closed with SNAPSHOT_RESIDUE_PRESENT", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  await mkdir(join(fixture.workspace, ".tcrn-workflow", "stale-lease-deadbeef"));
  await manifestUnderLease(fixture.workspace, 4, async (lease) => {
    await assert.rejects(
      createSnapshotManifest(fixture.workspace, lease),
      (error) => error instanceof SnapshotError && error.reasonCode === "SNAPSHOT_RESIDUE_PRESENT" && error.message.includes("stale-lease-deadbeef"),
    );
  });
});

test("WSF-2 case 4: a manifest taken under a held lease excludes the lease subtree and claims", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  const manifest = await manifestUnderLease(fixture.workspace, 4, (lease) => createSnapshotManifest(fixture.workspace, lease));
  const parsed = JSON.parse(manifest);
  const paths = parsed.files.map((entry) => entry.path);
  assert.ok(paths.length > 0, "the manifest lists control-tree files");
  assert.ok(paths.includes("workspace.json"), "the manifest includes the workspace metadata");
  assert.ok(paths.some((path) => path.startsWith("events/")), "the manifest includes event segments");
  for (const path of paths) {
    assert.ok(path !== "lease" && !path.startsWith("lease/"), `lease subtree must be excluded: ${path}`);
    assert.notEqual(path, "lease-recovery.claim");
  }
  assert.equal(parsed.validate.workspace, "valid");
  assert.equal(parsed.validate.knowledge, "absent");
});

test("WSF-2 case 5: the manifest validates against workspace-snapshot-manifest-v1.schema.json", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  const schema = JSON.parse(await readFile(new URL("../packages/core/schema/workspace-snapshot-manifest-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  const manifest = await manifestUnderLease(fixture.workspace, 4, (lease) => createSnapshotManifest(fixture.workspace, lease));
  assert.equal(validate(JSON.parse(manifest)), true, JSON.stringify(validate.errors));
});

test("WSF-2 case 6: the witness writes nothing — the whole tree is byte-stable across a manifest", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  await manifestUnderLease(fixture.workspace, 4, async (lease) => {
    const before = await listTree(fixture.base);
    await createSnapshotManifest(fixture.workspace, lease);
    const after = await listTree(fixture.base);
    assert.deepEqual(after, before, "createSnapshotManifest must not write to the filesystem");
  });
});

test("WSF-2 case 7: snapshot-verify fails SNAPSHOT_MISMATCH naming a tampered segment", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  const manifest = await manifestUnderLease(fixture.workspace, 4, (lease) => createSnapshotManifest(fixture.workspace, lease));
  const target = join(fixture.base, "restore-copy");
  await mkdir(target);
  await cp(join(fixture.workspace, ".tcrn-workflow"), join(target, ".tcrn-workflow"), { recursive: true });
  // A clean copy verifies.
  assert.deepEqual(await verifySnapshotManifest(target, manifest), {
    schemaVersion: "tcrn.workspace-snapshot-verify.v1",
    reasonCode: "SNAPSHOT_VERIFIED",
    files: JSON.parse(manifest).files.length,
  });
  // Flip one byte of a copied event segment.
  const segment = join(target, ".tcrn-workflow", "events", "000001.json");
  const bytes = await readFile(segment);
  bytes[0] = bytes[0] === 0x20 ? 0x21 : 0x20;
  await writeFile(segment, bytes);
  await assert.rejects(
    verifySnapshotManifest(target, manifest),
    (error) => error instanceof SnapshotError && error.reasonCode === "SNAPSHOT_MISMATCH" && error.message.includes("events/000001.json"),
  );
});
