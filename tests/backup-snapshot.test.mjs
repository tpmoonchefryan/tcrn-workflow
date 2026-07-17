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
  createKnowledgeUnit,
  createProject,
  createSnapshotManifest,
  createWork,
  initializeKnowledgeStore,
  initializeWorkspace,
  rebaseKnowledgeStore,
  validateKnowledgeStore,
  validateWorkspace,
  verifySnapshotManifest,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

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

// WSF-3: a workspace fixture carrying BOTH stores — a workspace event log advanced
// past project+work and an initialized knowledge store with one unit bound to the
// current head. The round-trip and doctrine-failure cases below all restore the
// whole control tree (or deliberately break lockstep) from this state.
function knowledgeInput({ projectId, workId }) {
  return {
    expectedVersion: 0,
    occurredAt: instant(5),
    externalKey: "KNOWLEDGE-BK-ROUNDTRIP",
    scope: "project",
    projectId,
    roleScopes: [],
    category: "implementation",
    kind: "guide",
    tags: ["backup", "workflow"],
    subject: "Backup round-trip subject",
    summary: "Backup round-trip summary",
    snippet: "Backup round-trip snippet",
    accountableOwnerId: deriveStableId("owner", "BK-ROUNDTRIP-OWNER"),
    sourceReferences: ["evidence://fixture/bk-roundtrip"],
    sourceDigest: canonicalSha256({ key: "BK-ROUNDTRIP", source: "current" }),
    linkedWorkIds: [workId],
    linkedDecisionIds: [deriveStableId("decision", "BK-ROUNDTRIP-DECISION")],
    linkedGateIds: [deriveStableId("gate", "BK-ROUNDTRIP-GATE")],
    linkedEvidenceIds: [deriveStableId("evidence", "BK-ROUNDTRIP-EVIDENCE")],
    lifecycle: "active",
    retrievalDisposition: "default",
    freshnessState: "fresh",
    lastVerified: instant(4),
    stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only",
    body: "Backup round-trip body",
  };
}

async function roundTripFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-bk-rt-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "WORKSPACE-BK-RT", createdAt: instant(0), segmentEventLimit: 2 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  let projectId;
  let workId;
  try {
    const withProject = await createProject(workspace, lease, { externalKey: "PROJ-ALPHA", name: "Alpha", expectedVersion: 0, occurredAt: instant(2) });
    projectId = withProject.projects[0].id;
    const withWork = await createWork(workspace, lease, { expectedVersion: 1, occurredAt: instant(3), projectId, externalKey: "WORK-ALPHA", kind: "Initiative", parentId: null, status: "active" });
    workId = withWork.work[0].id;
  } finally {
    await lease.release();
  }
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  await createKnowledgeUnit(workspace, knowledgeInput({ projectId, workId }));
  return {
    base,
    workspace,
    control: join(workspace, ".tcrn-workflow"),
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

test("WSF-3 case 8: snapshot then wipe then restore round-trips the whole control tree byte-identically", async (t) => {
  const fixture = await roundTripFixture();
  t.after(() => fixture.close());
  const manifest = await manifestUnderLease(fixture.workspace, 10, (lease) => createSnapshotManifest(fixture.workspace, lease));
  assert.equal(JSON.parse(manifest).validate.knowledge, "valid", "the manifest embeds a valid knowledge store");
  const copy = join(fixture.base, "snapshot-copy");
  await cp(fixture.control, join(copy, ".tcrn-workflow"), { recursive: true });
  // Wipe the live control tree entirely, then restore it from the copy in place.
  await rm(fixture.control, { recursive: true, force: true });
  await cp(join(copy, ".tcrn-workflow"), fixture.control, { recursive: true });
  // The restored copy verifies byte-for-byte against the manifest receipt.
  assert.equal((await verifySnapshotManifest(fixture.workspace, manifest)).reasonCode, "SNAPSHOT_VERIFIED");
  // Both stores validate green after restore, and the workspace head is unchanged.
  const state = await validateWorkspace(fixture.workspace);
  assert.equal(state.headEventHash, JSON.parse(manifest).headEventHash);
  assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
  // Byte-identity: a fresh manifest of the restored tree equals the original,
  // proving the per-file sha256 set, head hash, and version all round-tripped.
  const remanifest = await manifestUnderLease(fixture.workspace, 11, (lease) => createSnapshotManifest(fixture.workspace, lease));
  assert.equal(remanifest, manifest, "the restored tree re-manifests byte-identically");
});

test("WSF-3 case 9: partial restore leaving a newer knowledge store fails KNOWLEDGE_HIGH_WATER_MISMATCH", async (t) => {
  const fixture = await roundTripFixture();
  t.after(() => fixture.close());
  // Save only the workspace portion (state A): events/, views/, workspace.json.
  const backup = join(fixture.base, "ws-backup");
  await mkdir(backup);
  await cp(join(fixture.control, "events"), join(backup, "events"), { recursive: true });
  await cp(join(fixture.control, "views"), join(backup, "views"), { recursive: true });
  await cp(join(fixture.control, "workspace.json"), join(backup, "workspace.json"));
  // Advance the workspace head, then rebase the knowledge store onto the new head
  // so the knowledge marker is strictly NEWER than the saved workspace state.
  const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(7) });
  try {
    await createProject(fixture.workspace, lease, { externalKey: "PROJ-GAMMA", name: "Gamma", expectedVersion: 2, occurredAt: instant(8) });
  } finally {
    await lease.release();
  }
  const marker = JSON.parse(await readFile(join(fixture.control, "knowledge", "store.json"), "utf8"));
  await rebaseKnowledgeStore(fixture.workspace, { expectedVersion: marker.version, at: instant(9), retireInvalid: false });
  // Partial restore: return only the workspace portion to state A, keep the newer store.
  for (const relative of ["events", "views"]) {
    await rm(join(fixture.control, relative), { recursive: true, force: true });
    await cp(join(backup, relative), join(fixture.control, relative), { recursive: true });
  }
  await rm(join(fixture.control, "workspace.json"), { force: true });
  await cp(join(backup, "workspace.json"), join(fixture.control, "workspace.json"));
  await assert.rejects(
    validateKnowledgeStore(fixture.workspace),
    (error) => error?.reasonCode === "KNOWLEDGE_HIGH_WATER_MISMATCH",
  );
});

test("WSF-3 case 10: restoring the tree to a different path fails WORKSPACE_SCHEMA_INVALID", async (t) => {
  const fixture = await roundTripFixture();
  t.after(() => fixture.close());
  const alternate = await realpath(await mkdtemp(join(tmpdir(), "tcrn-bk-alt-")));
  t.after(() => rm(alternate, { recursive: true, force: true }));
  const relocated = join(alternate, "workspace");
  await mkdir(relocated);
  await cp(fixture.control, join(relocated, ".tcrn-workflow"), { recursive: true });
  // The original fixture stays intact so root recanonicalization succeeds and the
  // only failure is the same-path identity mismatch — proving the doctrine is real.
  await assert.rejects(
    validateWorkspace(relocated),
    (error) => error?.reasonCode === "WORKSPACE_SCHEMA_INVALID",
  );
});

// WSF-4: the git tier-2 guidance doc prescribes a .gitignore for a workspace-root
// git repo. Its fenced `gitignore` block must name exactly the SDC-9 residue
// taxonomy the snapshot witness excludes/fails-closed on, plus the two store-local
// claim classes (knowledge released-*, artifact restore.claim / released-restore-*)
// whose commit would resurrect a bricked store on clone. This array is kept
// ADJACENT to the WSF-2 exclusion list documented in workspace-snapshot.ts so the
// doc and the engine constants drift together loudly. Hermetic: no git is invoked.
const GITIGNORE_EXPECTED = [
  ".tcrn-workflow/lease/",
  ".tcrn-workflow/lease-recovery.claim",
  ".tcrn-workflow/knowledge/mutation.claim",
  ".tcrn-workflow/knowledge/released-*",
  ".tcrn-workflow/artifacts/restore.claim",
  ".tcrn-workflow/artifacts/released-restore-*",
  ".tcrn-workflow/stale-lease-*/",
  ".tcrn-workflow/released-*",
  ".tcrn-workflow/attempt-owned-*",
  ".tcrn-workflow/**/.tmp-*",
];

test("WSF-4 case 11: backup-git-tier.md prescribes the exact SDC-9 residue .gitignore", async () => {
  const doc = await readFile(new URL("../docs/architecture/backup-git-tier.md", import.meta.url), "utf8");
  const fence = doc.match(/```gitignore\n([\s\S]*?)```/u);
  assert.ok(fence, "the doc must carry a fenced gitignore block");
  const lines = fence[1].split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  // The block is exactly the SDC-9 taxonomy — no more, no fewer patterns.
  assert.deepEqual(lines, GITIGNORE_EXPECTED, "the gitignore fence must match the SDC-9 residue taxonomy exactly");
  // Targeted invariants the verifier corrections require, stated independently of order:
  assert.ok(lines.includes(".tcrn-workflow/lease/"), "must ignore the lease directory");
  assert.ok(lines.includes(".tcrn-workflow/lease-recovery.claim"), "must ignore the recovery claim");
  assert.ok(lines.includes(".tcrn-workflow/knowledge/mutation.claim"), "must ignore the knowledge mutation claim");
  assert.ok(lines.includes(".tcrn-workflow/knowledge/released-*"), "must ignore the knowledge release quarantine");
  assert.ok(lines.includes(".tcrn-workflow/artifacts/restore.claim"), "must ignore the artifact restore claim");
  assert.ok(lines.includes(".tcrn-workflow/artifacts/released-restore-*"), "must ignore the artifact restore quarantine");
  assert.ok(lines.some((line) => line.includes(".tmp-")), "must ignore atomic-write temporaries");
  // The doc downgrades git to witness-only: it must route restores through the copy
  // runbook and carry the quiesce-before-working-tree-ops and headEventHash-message conventions.
  assert.ok(/backup-restore-runbook\.md/u.test(doc), "the doc cross-links the copy restore runbook");
  assert.ok(/[Qq]uiesce/u.test(doc), "the doc carries the quiesce-before-git-working-tree-ops warning");
  assert.ok(/headEventHash/u.test(doc), "the doc states the commit-message-carries-headEventHash convention");
});
