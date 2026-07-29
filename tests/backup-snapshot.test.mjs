// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import { workflowMcpTools } from "../dist/build/packages/cli/src/mcp.js";
import {
  SnapshotError,
  acquireWorkspaceLease,
  createKnowledgeUnit,
  createProject,
  createSnapshotManifest,
  createWork,
  deriveRelocationId,
  initializeArtifactStore,
  initializeKnowledgeStore,
  initializeWorkspace,
  materializeWorkspace,
  readRelocationAuthority,
  rebaseKnowledgeStore,
  vacateWorkspace,
  validateKnowledgeStore,
  validateWorkspace,
  verifySnapshotManifest,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

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

// ---------------------------------------------------------------------------
// WSR-1 governed workspace relocation (root rebinding).
//
// These land under the EXISTING `backup` task rather than a new verify:* script or
// a new scripts/task.mjs handler: CONTRIBUTING.md's proof budget bans both while
// the ratio is at or above 1.0, and a runtime-capability claim on an existing
// command is the exempt route rather than an argued-around one.
//
// One assertion is deliberately ABSENT and its absence is the point: there is no
// single-sided test that the vacated source "is still dead". workspace.json is not
// covered by the event hash chain, so anyone with write access can restore it in
// canonical bytes and the address is alive again — the engine cannot detect that.
// A test asserting the source stayed dead would be permanently true and would give
// false comfort. The only real proof of a fork is the TWO-SIDED inspect comparison
// in T-FORK below, which needs both trees present at once.
// ---------------------------------------------------------------------------

const RELOCATION_ACTOR = "actor:relocation-operator";

async function relocationFixture({ segmentEventLimit = 4, projects = 2 } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-reloc-")));
  const side = async (name) => {
    const roots = {};
    for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
      const path = join(base, name, kind);
      await mkdir(path, { recursive: true });
      roots[kind] = path;
    }
    return roots;
  };
  const source = await side("A");
  const target = await side("B");
  await initializeWorkspace({
    roots: Object.entries(source).map(([kind, path]) => ({ kind, path })),
    externalKey: "WORKSPACE-RELOC",
    createdAt: instant(0),
    segmentEventLimit,
  });
  const workspace = source.workspace;
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  try {
    for (let index = 0; index < projects; index += 1) {
      await createProject(workspace, lease, {
        externalKey: `PROJ-${String.fromCharCode(65 + index)}`,
        name: `Project ${String(index)}`,
        expectedVersion: index,
        occurredAt: instant(2 + index),
      });
    }
  } finally {
    await lease.release();
  }
  const state = await validateWorkspace(workspace);
  return {
    base,
    source,
    target,
    workspace,
    targetWorkspace: target.workspace,
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function writeRelocationAuthority(fixture, overrides = {}) {
  const document = {
    schemaVersion: "tcrn.workspace-relocation-authority.v1",
    permits: [{
      actorId: overrides.actorId ?? RELOCATION_ACTOR,
      workspaceIds: overrides.workspaceIds ?? [fixture.workspaceId],
      destinations: overrides.destinations ?? [fixture.targetWorkspace],
      basis: overrides.basis ?? { headEventHash: fixture.headEventHash, version: fixture.version },
    }],
  };
  const path = overrides.path ?? join(fixture.base, `authority-${String(authoritySequence += 1)}.json`);
  const bytes = canonicalJson(document);
  await writeFile(path, bytes);
  return { path, digest: createSha256(bytes), document, bytes };
}

let authoritySequence = 0;

function createSha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const destinationFlags = (roots) => [
  "--to-framework", roots.framework,
  "--to-workspace-root", roots.workspace,
  "--to-transient", roots.transient,
  "--to-evidence-locator", roots["evidence-locator"],
  "--to-release-trust", roots["release-trust"],
];

const adoptRootFlags = (roots) => [
  "--framework", roots.framework,
  "--transient", roots.transient,
  "--evidence-locator", roots["evidence-locator"],
  "--release-trust", roots["release-trust"],
];

async function takeManifest(fixture, second = 8) {
  const outcome = await invokeCli(["snapshot-manifest", "--workspace", fixture.workspace, "--at", instant(second)]);
  assert.equal(outcome.ok, true, "the source must produce a manifest before it is vacated");
  const path = join(fixture.base, "control-manifest.json");
  await writeFile(path, outcome.output);
  return { path, text: outcome.output };
}

async function vacate(fixture, authority, { at = instant(9), actor = RELOCATION_ACTOR, expectedVersion = "head", destination } = {}) {
  return invokeCli([
    "relocation-vacate",
    "--workspace", fixture.workspace,
    "--at", at,
    "--actor", actor,
    "--expected-version", String(expectedVersion),
    ...destinationFlags(destination ?? fixture.target),
    "--relocation-authority", authority.path,
    "--relocation-authority-digest", authority.digest,
  ]);
}

// The operator moves the bytes. The engine gets no copy path: ADR 0002 rejected a
// destination-writing verb BY NAME and ADR 0003 records the refusal again, so this
// helper stands in for `cp -R` / `rsync -a` / `tar` exactly as the runbook does.
async function copyControlTree(fixture) {
  await cp(join(fixture.workspace, ".tcrn-workflow"), join(fixture.targetWorkspace, ".tcrn-workflow"), { recursive: true });
}

async function adopt(fixture, authority, manifest, relocationId, { at = instant(11), actor = RELOCATION_ACTOR, roots } = {}) {
  return invokeCli([
    "relocation-adopt",
    "--workspace", fixture.targetWorkspace,
    ...adoptRootFlags(roots ?? fixture.target),
    "--at", at,
    "--actor", actor,
    "--relocation-id", relocationId,
    "--control-manifest", manifest.path,
    "--relocation-authority", authority.path,
    "--relocation-authority-digest", authority.digest,
  ]);
}

async function vacatedFixture(options = {}) {
  const fixture = await relocationFixture(options);
  const authority = await writeRelocationAuthority(fixture);
  const manifest = await takeManifest(fixture);
  const outcome = await vacate(fixture, authority);
  assert.equal(outcome.ok, true, `vacate must succeed: ${String(outcome.reasonCode)}`);
  const receipt = JSON.parse(outcome.output);
  return { fixture, authority, manifest, receipt, relocationId: receipt.relocationId };
}

async function readMetadataJson(workspaceRoot) {
  return JSON.parse(await readFile(join(workspaceRoot, ".tcrn-workflow", "workspace.json"), "utf8"));
}

async function writeMetadataJson(workspaceRoot, value) {
  await writeFile(join(workspaceRoot, ".tcrn-workflow", "workspace.json"), canonicalJson(value));
}

test("WSR-1 T1: vacate kills the source across every read and write surface", async (t) => {
  const { fixture } = await vacatedFixture();
  t.after(() => fixture.close());
  const surfaces = [
    ["status", "--workspace", fixture.workspace],
    ["validate", "--workspace", fixture.workspace],
    ["export", "--workspace", fixture.workspace],
    ["event-list", "--workspace", fixture.workspace],
    ["work-list", "--workspace", fixture.workspace],
    ["project-list", "--workspace", fixture.workspace],
    ["snapshot-manifest", "--workspace", fixture.workspace, "--at", instant(12)],
    ["lease-break", "--workspace", fixture.workspace, "--at", instant(12), "--owner-token", "whatever"],
    ["project-create", "--workspace", fixture.workspace, "--expected-version", "2", "--at", instant(12), "--external-key", "PROJ-Z", "--name", "Z"],
    ["recover", "--workspace", fixture.workspace, "--at", instant(12)],
  ];
  for (const args of surfaces) {
    const outcome = await invokeCli(args);
    assert.equal(outcome.ok, false, `${args[0]} must refuse a vacated address`);
    assert.equal(outcome.reasonCode, "WORKSPACE_RELOCATION_VACATED", `${args[0]} must refuse under the relocation code`);
  }
});

test("WSR-1 T2: refusal coverage is enumerated from the catalog, never from a hand-written list", async (t) => {
  const { fixture } = await vacatedFixture();
  t.after(() => fixture.close());
  // A hand-written list of verbs goes stale the day a verb is added, and it goes
  // stale in the permissive direction. The set under test is derived.
  const admitted = new Set(["relocation-adopt", "relocation-abort", "relocation-inspect", "lease-inspect"]);
  const placeholder = (flag) => {
    if (flag.valueKind === "instant") return instant(12);
    if (flag.valueKind === "integer") return "0";
    if (flag.valueKind === "json") return "{}";
    if (flag.valueKind === "boolean") return "true";
    if (flag.valueKind === "list") return "-";
    return "-";
  };
  const workspaceVerbs = COMMAND_CATALOG.filter((entry) =>
    entry.availability === "cli" && entry.flags.some((flag) => flag.name === "workspace"));
  assert.ok(workspaceVerbs.length >= 20, "the catalog must actually carry the workspace verb family");
  let refusedUnderRelocationCode = 0;
  for (const entry of workspaceVerbs) {
    if (admitted.has(entry.name)) continue;
    const args = [entry.name];
    for (const flag of entry.flags) {
      if (!flag.required) continue;
      args.push(`--${flag.name}`, flag.name === "workspace" ? fixture.workspace : placeholder(flag));
    }
    const outcome = await invokeCli(args);
    // The universal claim is that NOTHING succeeds. Some verbs refuse earlier on
    // argument shape, which is why the specific-code count is asserted separately
    // rather than demanded of every entry.
    assert.equal(outcome.ok, false, `${entry.name} must not succeed against a vacated address`);
    if (outcome.reasonCode === "WORKSPACE_RELOCATION_VACATED") refusedUnderRelocationCode += 1;
  }
  // 38 of the 54 catalog verbs taking --workspace reach the relocation refusal
  // itself; the rest stop earlier on argument shape (a placeholder id, a JSON
  // request body) and are covered by the universal no-success claim above. The
  // floor is set just under the measured value rather than at a round number that
  // would let two thirds of the surface silently stop refusing.
  assert.ok(refusedUnderRelocationCode >= 36, `too few verbs reached the relocation refusal: ${String(refusedUnderRelocationCode)}`);
  // The declared exceptions must actually behave as exceptions, or "admitted" is a
  // list of things nobody checked.
  const inspect = await invokeCli(["relocation-inspect", "--workspace", fixture.workspace]);
  assert.equal(inspect.ok, true);
  const leaseInspect = await invokeCli(["lease-inspect", "--workspace", fixture.workspace, "--at", instant(12)]);
  assert.equal(leaseInspect.ok, true, "D10 admits lease-inspect: it emits no workspace content and cannot revive anything");
});

test("WSR-1 T3: the readMetadata-only paths are covered and resolveWorkspace would have missed them", async (t) => {
  const { fixture } = await vacatedFixture();
  t.after(() => fixture.close());
  // None of these four reaches resolveWorkspace. They are the reason the admission
  // check sits in readMetadata: put it in resolveWorkspace and every one of them
  // still succeeds against a dead address.
  await assert.rejects(
    acquireWorkspaceLease(fixture.workspace, { now: instant(12) }),
    (error) => error.reasonCode === "WORKSPACE_RELOCATION_VACATED",
  );
  const breakLease = await invokeCli(["lease-break", "--workspace", fixture.workspace, "--at", instant(12), "--owner-token", "t"]);
  assert.equal(breakLease.reasonCode, "WORKSPACE_RELOCATION_VACATED");
  const breakClaim = await invokeCli(["lease-recovery-break", "--workspace", fixture.workspace, "--at", instant(12), "--claim-token", "t"]);
  assert.equal(breakClaim.reasonCode, "WORKSPACE_RELOCATION_VACATED");
  // Both sides differ: lease-inspect is the one that must still answer.
  const inspect = await invokeCli(["lease-inspect", "--workspace", fixture.workspace, "--at", instant(12)]);
  assert.equal(inspect.ok, true);
});

test("WSR-1 T4: the readMetadata admission default is strict", async (t) => {
  const { fixture } = await vacatedFixture();
  t.after(() => fixture.close());
  await copyControlTree(fixture);
  // An ADOPTION_REQUIRED tree read by an ordinary verb that passes no admission
  // argument at all. If the default were permissive this would succeed and nothing
  // else in the suite would notice.
  const outcome = await invokeCli(["status", "--workspace", fixture.targetWorkspace]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "WORKSPACE_RELOCATION_ADOPTION_REQUIRED");
  await assert.rejects(
    materializeWorkspace(fixture.targetWorkspace),
    (error) => error.reasonCode === "WORKSPACE_RELOCATION_ADOPTION_REQUIRED",
  );
});

test("WSR-1 T5: adopt changes exactly one file in the control tree", async (t) => {
  const { fixture, authority, manifest, relocationId } = await vacatedFixture();
  t.after(() => fixture.close());
  await copyControlTree(fixture);
  const before = await listTree(join(fixture.targetWorkspace, ".tcrn-workflow"));
  const outcome = await adopt(fixture, authority, manifest, relocationId);
  assert.equal(outcome.ok, true, `adopt must succeed: ${String(outcome.reasonCode)}`);
  const after = await listTree(join(fixture.targetWorkspace, ".tcrn-workflow"));
  const changed = after.filter((entry, index) => entry !== before[index]);
  assert.equal(after.length, before.length, "adopt must add and remove nothing");
  assert.equal(changed.length, 1, `adopt must change exactly one entry, changed: ${JSON.stringify(changed)}`);
  assert.ok(changed[0].startsWith("f workspace.json"), `the one changed entry must be workspace.json, got ${String(changed[0])}`);
  // And the strong form: every event and view byte is identical.
  await assert.rejects(
    verifySnapshotManifest(fixture.targetWorkspace, manifest.text),
    (error) => error.reasonCode === "SNAPSHOT_MISMATCH" && error.message === "workspace.json",
    "workspace.json is the one file that differs, and the unfiltered verify must name it",
  );
  assert.equal(
    (await verifySnapshotManifest(fixture.targetWorkspace, manifest.text, { excludePaths: ["workspace.json"] })).reasonCode,
    "SNAPSHOT_VERIFIED",
    "and nothing else differs at all",
  );
  const fresh = JSON.parse(manifest.text).files.filter((entry) => entry.path !== "workspace.json");
  for (const entry of fresh) {
    const bytes = await readFile(join(fixture.targetWorkspace, ".tcrn-workflow", entry.path));
    assert.equal(createSha256(bytes.toString("utf8")), entry.sha256, `${entry.path} must be byte-identical after adopt`);
  }
});

test("WSR-1 T6: the event chain survives the move untouched", async (t) => {
  const { fixture, authority, manifest, relocationId } = await vacatedFixture();
  t.after(() => fixture.close());
  const sourceEvents = [];
  // Read the source's chain BEFORE it is vacated is impossible here (it already is),
  // so read it from the manifest basis and from the target after adoption.
  await copyControlTree(fixture);
  assert.equal((await adopt(fixture, authority, manifest, relocationId)).ok, true);
  const status = JSON.parse((await invokeCli(["status", "--workspace", fixture.targetWorkspace])).output);
  assert.equal(status.version, fixture.version, "version must be unchanged");
  assert.equal(status.headEventHash, fixture.headEventHash, "headEventHash must be unchanged");
  let offset = 0;
  while (true) {
    const page = JSON.parse((await invokeCli(["event-list", "--workspace", fixture.targetWorkspace, "--limit", "2", "--offset", String(offset)])).output);
    sourceEvents.push(...page.records);
    if (page.records.length === 0 || sourceEvents.length >= page.total) break;
    offset += page.records.length;
  }
  assert.equal(sourceEvents.length, fixture.version, "every event must still be readable end to end");
  const state = await validateWorkspace(fixture.targetWorkspace);
  const streamIds = new Set(state.events.map((event) => event.streamId));
  assert.equal(streamIds.size, 1, "one stream id");
  assert.deepEqual(state.events.map((event) => event.id), sourceEvents.map((event) => event.id));
});

test("WSR-1 T7: the artifact store stays in lockstep with no rebase", async (t) => {
  const fixture = await relocationFixture();
  t.after(() => fixture.close());
  // The store must actually EXIST before this proves anything. artifact-doctor
  // fails ARTIFACT_PATH_INVALID on any workspace that has no artifact store at all,
  // relocated or not — asserting against an absent store would have been a test
  // that passes for a reason unrelated to relocation.
  await initializeArtifactStore(fixture.workspace, { disposable: false });
  const before = await invokeCli(["artifact-doctor", "--workspace", fixture.workspace]);
  assert.equal(before.ok, true, `the control reading must be green before the move: ${String(before.reasonCode)}`);
  const state = await validateWorkspace(fixture.workspace);
  const authority = await writeRelocationAuthority({ ...fixture, version: state.version, headEventHash: state.headEventHash });
  const manifest = await takeManifest(fixture);
  const outcome = await vacate(fixture, authority);
  assert.equal(outcome.ok, true, `vacate must succeed: ${String(outcome.reasonCode)}`);
  await copyControlTree(fixture);
  assert.equal((await adopt(fixture, authority, manifest, JSON.parse(outcome.output).relocationId)).ok, true);
  const after = await invokeCli(["artifact-doctor", "--workspace", fixture.targetWorkspace]);
  assert.equal(after.ok, true, `artifact-doctor must pass at the adopted address with no rebase: ${String(after.reasonCode)}`);
  assert.equal(JSON.parse(after.output).reasonCode, JSON.parse(before.output).reasonCode);
});

test("WSR-1 T7b: a populated knowledge store validates at the adopted address with no rebase", async (t) => {
  const fixture = await relocationFixture();
  t.after(() => fixture.close());
  await initializeKnowledgeStore(fixture.workspace, { disposableAcknowledged: true });
  const state = await validateWorkspace(fixture.workspace);
  const authority = await writeRelocationAuthority({ ...fixture, version: state.version, headEventHash: state.headEventHash });
  const manifest = await takeManifest(fixture, 8);
  const outcome = await vacate({ ...fixture }, authority, { expectedVersion: "head" });
  assert.equal(outcome.ok, true, `vacate must succeed: ${String(outcome.reasonCode)}`);
  const relocationId = JSON.parse(outcome.output).relocationId;
  await copyControlTree(fixture);
  assert.equal((await adopt(fixture, authority, manifest, relocationId)).ok, true);
  const knowledge = await invokeCli(["knowledge-validate", "--workspace", fixture.targetWorkspace]);
  assert.equal(knowledge.ok, true, `knowledge-validate must pass without a rebase: ${String(knowledge.reasonCode)}`);
});

test("WSR-1 T8: the empty-directory gap is closed by the ADDED check, not by the manifest", async (t) => {
  const { fixture, authority, manifest, relocationId } = await vacatedFixture();
  t.after(() => fixture.close());
  await copyControlTree(fixture);
  await rm(join(fixture.targetWorkspace, ".tcrn-workflow", "backups"), { recursive: true, force: true });
  // BOTH sides must be able to differ. The first assertion is what proves the second
  // is measuring something real rather than something that cannot fail: the manifest
  // collects FILES only, so it is structurally blind to a dropped empty directory.
  // Compared exactly as adopt compares: workspace.json is excluded, because the
  // manifest was taken before the vacate rewrote it. Everything else must still
  // verify clean — the manifest collects FILES only and is structurally blind to a
  // dropped empty directory.
  const verify = await verifySnapshotManifest(fixture.targetWorkspace, manifest.text, { excludePaths: ["workspace.json"] });
  assert.equal(verify.reasonCode, "SNAPSHOT_VERIFIED", "the manifest is blind to a missing empty directory");
  const outcome = await adopt(fixture, authority, manifest, relocationId);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "WORKSPACE_RELOCATION_CONTROL_TREE_INCOMPLETE");
});

test("WSR-1 T9: the transport-residue gap is closed by the ADDED check, not by the manifest", async (t) => {
  for (const residue of ["lease", "lease-recovery.claim", "knowledge/mutation.claim", "artifacts/restore.claim"]) {
    const { fixture, authority, manifest, relocationId } = await vacatedFixture();
    try {
      await copyControlTree(fixture);
      const path = join(fixture.targetWorkspace, ".tcrn-workflow", residue);
      await mkdir(dirname(path), { recursive: true });
      if (residue === "lease") {
        await mkdir(path, { recursive: true });
      } else {
        await writeFile(path, "{}\n");
      }
      // Blind in the opposite direction: these four are excluded from the manifest
      // by design, so a copy that carried them across still verifies clean.
      const verify = await verifySnapshotManifest(fixture.targetWorkspace, manifest.text, { excludePaths: ["workspace.json"] });
      assert.equal(verify.reasonCode, "SNAPSHOT_VERIFIED", `the manifest is blind to a copied ${residue}`);
      const outcome = await adopt(fixture, authority, manifest, relocationId);
      assert.equal(outcome.ok, false, `adopt must refuse a copied ${residue}`);
      assert.equal(outcome.reasonCode, "WORKSPACE_RELOCATION_TRANSPORT_RESIDUE");
    } finally {
      await fixture.close();
    }
  }
});

test("WSR-1 T10: vacate refuses an unsettled tree and names recover as the fix", async (t) => {
  const fixture = await relocationFixture();
  t.after(() => fixture.close());
  const authority = await writeRelocationAuthority(fixture);
  await writeFile(join(fixture.workspace, ".tcrn-workflow", "events", ".tmp-9999-1"), "[]\n");
  const outcome = await vacate(fixture, authority, { expectedVersion: fixture.version });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "WORKSPACE_RELOCATION_UNSETTLED", "the settle check runs ahead of the validate, so it is the check that fires");
  // Recorded rather than smoothed over: with the `head` sentinel the CLI
  // materializes the chain to resolve the version BEFORE the verb runs, and a
  // stray .tmp- under events/ makes readSegmentEvents refuse the whole chain. That
  // is pre-existing head-sentinel behaviour shared by every verb, not something
  // this design introduces, and pretending otherwise would need a check that
  // cannot fire.
  const viaHead = await vacate(fixture, authority);
  assert.equal(viaHead.reasonCode, "WORKSPACE_EVENT_CORRUPT");
  // Both sides differ: once recover has settled the tree, the same vacate admits.
  assert.equal((await invokeCli(["recover", "--workspace", fixture.workspace, "--at", instant(8)])).ok, true);
  assert.equal((await vacate(fixture, authority)).ok, true);
});

test("WSR-1 T11: ordering is mechanized — copy-then-adopt without a vacate fails closed", async (t) => {
  const fixture = await relocationFixture();
  t.after(() => fixture.close());
  const authority = await writeRelocationAuthority(fixture);
  const manifest = await takeManifest(fixture);
  await copyControlTree(fixture);
  const outcome = await adopt(fixture, authority, manifest, "relocation:000000000000000000000000");
  assert.equal(outcome.ok, false, "the operator's natural instinct (copy first) must fail closed");
  assert.equal(outcome.reasonCode, "WORKSPACE_RELOCATION_NOT_PENDING", "a tree with no ledger has nothing to adopt");
  // And the copy is not usable as a workspace either — the pre-existing same-path
  // refusal this design does not remove, only supplies a governed route through.
  const status = await invokeCli(["status", "--workspace", fixture.targetWorkspace]);
  assert.equal(status.ok, false);
  assert.equal(status.reasonCode, "WORKSPACE_SCHEMA_INVALID");
  // The source is untouched and still alive: an attempted out-of-order adopt must
  // not have killed anything.
  assert.equal((await invokeCli(["status", "--workspace", fixture.workspace])).ok, true);
});

test("WSR-1 T12: adopt is idempotent", async (t) => {
  const { fixture, authority, manifest, relocationId } = await vacatedFixture();
  t.after(() => fixture.close());
  await copyControlTree(fixture);
  assert.equal((await adopt(fixture, authority, manifest, relocationId)).ok, true);
  const before = await readFile(join(fixture.targetWorkspace, ".tcrn-workflow", "workspace.json"));
  const again = await adopt(fixture, authority, manifest, relocationId, { at: instant(13) });
  assert.equal(again.ok, true);
  assert.equal(JSON.parse(again.output).reasonCode, "WORKSPACE_RELOCATION_ALREADY_ADOPTED");
  const after = await readFile(join(fixture.targetWorkspace, ".tcrn-workflow", "workspace.json"));
  assert.equal(after.toString("utf8"), before.toString("utf8"), "a retry must change no bytes");
});

test("WSR-1 T13: abort restores the source from the tree alone", async (t) => {
  const { fixture, authority, manifest, relocationId } = await vacatedFixture();
  t.after(() => fixture.close());
  // Delete every receipt and sidecar first. Abort must be a pure function of the
  // tree — this is the test the tombstone alternative cannot pass, because a
  // tombstone destroys the pre-vacate binding bytes abort needs.
  await rm(manifest.path, { force: true });
  const outcome = await invokeCli([
    "relocation-abort",
    "--workspace", fixture.workspace,
    "--at", instant(12),
    "--actor", RELOCATION_ACTOR,
    "--relocation-id", relocationId,
    "--relocation-authority", authority.path,
    "--relocation-authority-digest", authority.digest,
  ]);
  assert.equal(outcome.ok, true, `abort must succeed: ${String(outcome.reasonCode)}`);
  const state = await validateWorkspace(fixture.workspace);
  assert.equal(state.version, fixture.version, "version unchanged");
  assert.equal(state.headEventHash, fixture.headEventHash, "head unchanged");
  const status = await invokeCli(["status", "--workspace", fixture.workspace]);
  assert.equal(status.ok, true, "the source is fully alive at its original binding");
  const inspect = JSON.parse((await invokeCli(["relocation-inspect", "--workspace", fixture.workspace])).output);
  assert.equal(inspect.state, "live");
  assert.equal(inspect.stage, "aborted");
  // A wrong relocationId is refused: restating it is the proof of attention, the
  // same device lease-break uses when it demands the current owner token.
  const wrong = await invokeCli([
    "relocation-abort", "--workspace", fixture.workspace, "--at", instant(13), "--actor", RELOCATION_ACTOR,
    "--relocation-id", "relocation:000000000000000000000000",
    "--relocation-authority", authority.path, "--relocation-authority-digest", authority.digest,
  ]);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reasonCode, "WORKSPACE_RELOCATION_NOT_PENDING");
});

test("WSR-1 T14: the relocation authority is load-bearing, not decorative", async (t) => {
  const fixture = await relocationFixture();
  t.after(() => fixture.close());
  const good = await writeRelocationAuthority(fixture);
  // (a) omitted entirely
  const omitted = await invokeCli([
    "relocation-vacate", "--workspace", fixture.workspace, "--at", instant(9), "--actor", RELOCATION_ACTOR,
    "--expected-version", "head", ...destinationFlags(fixture.target),
  ]);
  assert.equal(omitted.ok, false);
  assert.equal(omitted.reasonCode, "CLI_ARGUMENT_MISSING");
  // (b) the digest of a different file
  const other = await writeRelocationAuthority(fixture, { actorId: "actor:someone-else" });
  const wrongDigest = await vacate(fixture, { path: good.path, digest: other.digest });
  assert.equal(wrongDigest.ok, false);
  assert.equal(wrongDigest.reasonCode, "WORKSPACE_RELOCATION_AUTHORITY_DIGEST");
  // (d) a valid roster whose actor is not the one running the command
  const wrongActor = await vacate(fixture, good, { actor: "actor:not-in-the-roster" });
  assert.equal(wrongActor.ok, false);
  assert.equal(wrongActor.reasonCode, "WORKSPACE_RELOCATION_NOT_PERMITTED");
  // and the roster still works when everything lines up, or the three refusals
  // above prove nothing about the permit ever admitting anything.
  const good2 = await vacate(fixture, good);
  assert.equal(good2.ok, true, `the matching permit must admit: ${String(good2.reasonCode)}`);
});

test("WSR-1 T14c: a roster scoped to a different workspaceId does not permit this workspace", async (t) => {
  const fixture = await relocationFixture();
  t.after(() => fixture.close());
  // The mutation that matters. Without workspaceId scoping the roster permits
  // everything while looking rigorous — a permanently-green gate wearing a suit.
  const foreign = await writeRelocationAuthority(fixture, { workspaceIds: ["workspace:0123456789abcdef01234567"] });
  const outcome = await vacate(fixture, foreign);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "WORKSPACE_RELOCATION_NOT_PERMITTED");
  // Both sides differ: the identical roster scoped to THIS workspace admits.
  const mine = await writeRelocationAuthority(fixture);
  assert.equal((await vacate(fixture, mine)).ok, true);
});

test("WSR-1 T15: the authority basis is a real content-addressed check, not decoration", async (t) => {
  const fixture = await relocationFixture();
  t.after(() => fixture.close());
  const authority = await writeRelocationAuthority(fixture);
  // Mint at version N, then advance the chain by one event.
  const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(6) });
  try {
    await createProject(fixture.workspace, lease, { externalKey: "PROJ-LATER", name: "Later", expectedVersion: fixture.version, occurredAt: instant(7) });
  } finally {
    await lease.release();
  }
  const outcome = await vacate(fixture, authority);
  assert.equal(outcome.ok, false, "an authority minted against an older basis must not still work");
  assert.equal(outcome.reasonCode, "WORKSPACE_RELOCATION_BASIS_STALE");
  // Both sides differ: an authority minted against the CURRENT basis admits.
  const state = await validateWorkspace(fixture.workspace);
  const fresh = await writeRelocationAuthority({ ...fixture, version: state.version, headEventHash: state.headEventHash });
  assert.equal((await vacate(fixture, fresh)).ok, true);
});

test("WSR-1 T16: the authority is read before the lease is taken", async (t) => {
  const fixture = await relocationFixture();
  t.after(() => fixture.close());
  const missing = { path: join(fixture.base, "no-such-authority.json"), digest: "a".repeat(64) };
  const outcome = await vacate(fixture, missing);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "WORKSPACE_RELOCATION_AUTHORITY_CHANGED");
  // The proof that no lock was held while that filesystem refusal happened.
  const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(12) });
  await lease.release();
});

test("WSR-1 T17: the same authority bytes at two host paths carry the same digest", async (t) => {
  const fixture = await relocationFixture();
  t.after(() => fixture.close());
  const hostA = join(fixture.base, "hostA");
  const hostB = join(fixture.base, "hostB");
  await mkdir(hostA, { recursive: true });
  await mkdir(hostB, { recursive: true });
  const left = await writeRelocationAuthority(fixture, { path: join(hostA, "authority.json") });
  const right = await writeRelocationAuthority(fixture, { path: join(hostB, "authority.json") });
  assert.equal(left.digest, right.digest, "identical permissions must be identical bytes and one digest");
  assert.equal(left.bytes, right.bytes);
  // Each host presents its OWN path with the SAME content digest, and both read clean.
  assert.equal((await vacate(fixture, left)).ok, true);
});

test("WSR-1 T18: ledger chaining cannot be spliced, and a correct chain still reads clean", async (t) => {
  const { fixture, authority, manifest, relocationId } = await vacatedFixture();
  t.after(() => fixture.close());
  // (a) hand-edit the hop's `from` so it no longer restates the binding it replaced,
  // AND recompute the relocationId over the tampered content. Without the recompute
  // this test passes for the wrong reason: the id is derived over `from`, so the id
  // check alone catches a naive edit and the chaining rule is never exercised. That
  // was measured, not assumed — the red proof for the chaining rule came back GREEN
  // until this recompute was added.
  const metadata = await readMetadataJson(fixture.workspace);
  const tampered = structuredClone(metadata);
  const elsewhere = join(fixture.base, "elsewhere");
  tampered.relocations[0].from[2].path = elsewhere;
  tampered.relocations[0].from[2].canonicalPath = elsewhere;
  tampered.relocations[0].from[2].portableIdentity = elsewhere.toLowerCase();
  tampered.relocations[0].relocationId = deriveRelocationId({
    workspaceId: tampered.workspaceId,
    sequence: tampered.relocations[0].sequence,
    from: tampered.relocations[0].from,
    to: tampered.relocations[0].to,
    basis: tampered.relocations[0].basis,
  });
  await writeMetadataJson(fixture.workspace, tampered);
  const spliced = await invokeCli(["relocation-inspect", "--workspace", fixture.workspace]);
  assert.equal(spliced.ok, false, "a self-consistent but unchained hop must still be refused");
  assert.equal(spliced.reasonCode, "WORKSPACE_RELOCATION_LEDGER_INVALID");
  // (b) the untampered ledger reads clean, or the rule is only proven to reject.
  await writeMetadataJson(fixture.workspace, metadata);
  const clean = await invokeCli(["relocation-inspect", "--workspace", fixture.workspace]);
  assert.equal(clean.ok, true);
  assert.equal(JSON.parse(clean.output).relocationId, relocationId);
  // (b2) a full two-hop A->B->C ledger reads clean at C.
  await copyControlTree(fixture);
  assert.equal((await adopt(fixture, authority, manifest, relocationId)).ok, true);
  const c = {};
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    c[kind] = join(fixture.base, "C", kind);
    await mkdir(c[kind], { recursive: true });
  }
  const secondState = await validateWorkspace(fixture.targetWorkspace);
  const secondAuthority = await writeRelocationAuthority({
    ...fixture, targetWorkspace: c.workspace, version: secondState.version, headEventHash: secondState.headEventHash,
  });
  const secondManifest = await invokeCli(["snapshot-manifest", "--workspace", fixture.targetWorkspace, "--at", instant(14)]);
  assert.equal(secondManifest.ok, true);
  const secondManifestPath = join(fixture.base, "manifest-2.json");
  await writeFile(secondManifestPath, secondManifest.output);
  const secondVacate = await invokeCli([
    "relocation-vacate", "--workspace", fixture.targetWorkspace, "--at", instant(15), "--actor", RELOCATION_ACTOR,
    "--expected-version", "head", ...destinationFlags(c),
    "--relocation-authority", secondAuthority.path, "--relocation-authority-digest", secondAuthority.digest,
  ]);
  assert.equal(secondVacate.ok, true, `the second hop must vacate: ${String(secondVacate.reasonCode)}`);
  await cp(join(fixture.targetWorkspace, ".tcrn-workflow"), join(c.workspace, ".tcrn-workflow"), { recursive: true });
  const secondAdopt = await invokeCli([
    "relocation-adopt", "--workspace", c.workspace, ...adoptRootFlags(c), "--at", instant(16), "--actor", RELOCATION_ACTOR,
    "--relocation-id", JSON.parse(secondVacate.output).relocationId, "--control-manifest", secondManifestPath,
    "--relocation-authority", secondAuthority.path, "--relocation-authority-digest", secondAuthority.digest,
  ]);
  assert.equal(secondAdopt.ok, true, `the two-hop ledger must adopt at C: ${String(secondAdopt.reasonCode)}`);
  const atC = JSON.parse((await invokeCli(["relocation-inspect", "--workspace", c.workspace])).output);
  assert.equal(atC.state, "live");
  assert.equal(atC.relocations, 4, "two hops, four entries");
  const statusC = JSON.parse((await invokeCli(["status", "--workspace", c.workspace])).output);
  assert.equal(statusC.headEventHash, fixture.headEventHash, "two hops and the chain is still the same chain");
});

test("WSR-1 T19: no torn ledger is reachable at either commit point", async (t) => {
  for (const crashAt of ["before-write", "after-temp-sync"]) {
    const fixture = await relocationFixture();
    try {
      const authority = await writeRelocationAuthority(fixture);
      const before = await readFile(join(fixture.workspace, ".tcrn-workflow", "workspace.json"), "utf8");
      await assert.rejects(
        vacateWorkspace(fixture.workspace, {
          at: instant(9),
          actorId: RELOCATION_ACTOR,
          destination: fixture.target,
          authority: await readRelocationAuthority(authority.path, { expectedCanonicalPath: authority.path, expectedFileSha256: authority.digest }),
          expectedVersion: fixture.version,
          crashAt,
        }),
        (error) => error.reasonCode === "WORKSPACE_FAULT_INJECTED",
      );
      const after = await readFile(join(fixture.workspace, ".tcrn-workflow", "workspace.json"), "utf8");
      assert.equal(after, before, `a crash at ${crashAt} must leave the pre-step bytes exactly`);
      // And the address is still fully alive, not half-dead.
      assert.equal((await invokeCli(["status", "--workspace", fixture.workspace])).ok, true);
    } finally {
      await fixture.close();
    }
  }
});

test("WSR-1 T20: one flipped byte anywhere in the copy is caught before adopt", async (t) => {
  const { fixture, authority, manifest, relocationId } = await vacatedFixture();
  t.after(() => fixture.close());
  await copyControlTree(fixture);
  const victim = join(fixture.targetWorkspace, ".tcrn-workflow", "views", "index.json");
  const bytes = await readFile(victim);
  await writeFile(victim, `${bytes.toString("utf8").slice(0, -2)} \n`);
  // Named, not merely mismatched: without the path assertion this test would pass
  // just as happily on the workspace.json the vacate legitimately rewrote.
  await assert.rejects(
    verifySnapshotManifest(fixture.targetWorkspace, manifest.text, { excludePaths: ["workspace.json"] }),
    (error) => error.reasonCode === "SNAPSHOT_MISMATCH" && error.message === "views/index.json",
  );
  const outcome = await adopt(fixture, authority, manifest, relocationId);
  assert.equal(outcome.ok, false, "adopt must not bind a tree whose bytes did not survive the copy");
  assert.equal(outcome.reasonCode, "SNAPSHOT_MISMATCH");
});

test("WSR-1 T21: the target MEASURES the chain rather than quoting the ledger", async (t) => {
  const { fixture, manifest } = await vacatedFixture();
  t.after(() => fixture.close());
  await copyControlTree(fixture);
  // A ledger whose basis claims a version the tree does not materialize to — and
  // which is otherwise entirely SELF-CONSISTENT: the relocationId is recomputed over
  // the fabricated basis and the authority is minted against it too. Every other
  // check therefore passes, and only the measurement at t7 can catch it. Isolating
  // it this way was not optional: with the earlier, naive version of this test the
  // red proof for the measure step came back GREEN, because the ledger validator
  // was catching the fabrication first and the measurement was never reached.
  const metadata = await readMetadataJson(fixture.targetWorkspace);
  const fabricatedVersion = metadata.relocations[0].basis.version + 1;
  metadata.relocations[0].basis.version = fabricatedVersion;
  const fabricatedId = deriveRelocationId({
    workspaceId: metadata.workspaceId,
    sequence: metadata.relocations[0].sequence,
    from: metadata.relocations[0].from,
    to: metadata.relocations[0].to,
    basis: metadata.relocations[0].basis,
  });
  metadata.relocations[0].relocationId = fabricatedId;
  await writeMetadataJson(fixture.targetWorkspace, metadata);
  const matchingAuthority = await writeRelocationAuthority({
    ...fixture, version: fabricatedVersion, headEventHash: fixture.headEventHash,
  });
  const outcome = await adopt(fixture, matchingAuthority, manifest, fabricatedId);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "WORKSPACE_RELOCATION_CHAIN_MISMATCH", "the target must measure the chain, not quote the ledger");
  // Nothing was written: the refusal is BEFORE the commit point, not a postcondition
  // that leaves a rebound tree behind.
  const afterwards = await readMetadataJson(fixture.targetWorkspace);
  assert.equal(afterwards.relocations.length, 1, "no adopted entry may have been appended");
});

test("WSR-1 T22: segmentEventLimit is untouchable and a hand-changed limit corrupts the very next read", async (t) => {
  const { fixture, authority, manifest, relocationId } = await vacatedFixture({ segmentEventLimit: 2, projects: 4 });
  t.after(() => fixture.close());
  await copyControlTree(fixture);
  const metadata = await readMetadataJson(fixture.targetWorkspace);
  metadata.segmentEventLimit = 3;
  await writeMetadataJson(fixture.targetWorkspace, metadata);
  const outcome = await adopt(fixture, authority, manifest, relocationId);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "WORKSPACE_EVENT_CORRUPT", "the measure step reads the chain and the limit change corrupts it");
});

test("WSR-1 T23: inspect reports the roots this hop does not move", async (t) => {
  const fixture = await relocationFixture();
  t.after(() => fixture.close());
  // Share the framework and release-trust roots with the destination, exactly as all
  // four partitions on this platform do. A root the relocation leaves in place must
  // already exist at the destination host, and physically MOVING one that another
  // partition also declares bricks that partition. The engine cannot see other
  // partitions and this report does not claim it can.
  const shared = {
    ...fixture.target,
    framework: fixture.source.framework,
    "release-trust": fixture.source["release-trust"],
  };
  const authority = await writeRelocationAuthority(fixture);
  assert.equal((await vacate(fixture, authority, { destination: shared })).ok, true);
  const inspect = JSON.parse((await invokeCli(["relocation-inspect", "--workspace", fixture.workspace])).output);
  assert.deepEqual([...inspect.unmovedRoots].sort(), ["framework", "release-trust"]);
  assert.equal(inspect.state, "vacated");
});

test("WSR-1 T24: the three mutating relocation verbs are absent from the MCP surface", async () => {
  const tools = workflowMcpTools().map((tool) => tool.name);
  for (const name of ["relocation_vacate", "relocation_adopt", "relocation_abort"]) {
    assert.ok(!tools.includes(`tcrn_workflow_${name}`), `${name} must not be MCP-exposed: an MCP grant is a standing command list and cannot carry a per-invocation authority`);
  }
  // Both sides differ: the read-only verb IS exposed, and so is a verb whose
  // authority is optional rather than required.
  assert.ok(tools.includes("tcrn_workflow_relocation_inspect"));
  assert.ok(tools.includes("tcrn_workflow_gate_transition"));
});

test("WSR-1 T25: a workspace that never relocates has byte-identical metadata", async (t) => {
  const fixture = await relocationFixture();
  t.after(() => fixture.close());
  const text = await readFile(join(fixture.workspace, ".tcrn-workflow", "workspace.json"), "utf8");
  const parsed = JSON.parse(text);
  // Absent, not empty. Emitting `relocations: []` unconditionally would change every
  // existing workspace.json digest on this platform and turn an additive change into
  // a migration.
  assert.equal(Object.hasOwn(parsed, "relocations"), false, "relocations must be ABSENT, not an empty array");
  assert.deepEqual(Object.keys(parsed).sort(), [
    "createdAt", "externalKey", "maximumStorageVersion", "minimumStorageVersion",
    "roots", "schemaVersion", "segmentEventLimit", "storageVersion", "workspaceId",
  ], "the nine-field closed V1 form is unchanged for a workspace that never relocates");
  assert.equal(text, canonicalJson(parsed), "still exactly the canonical bytes");
});

test("WSR-1 T-FORK: two truths are not prevented, they are made legible on both sides", async (t) => {
  const { fixture, authority, manifest, relocationId } = await vacatedFixture();
  t.after(() => fixture.close());
  const preVacate = structuredClone(await readMetadataJson(fixture.workspace));
  delete preVacate.relocations;
  await copyControlTree(fixture);
  assert.equal((await adopt(fixture, authority, manifest, relocationId)).ok, true);
  // The bypass, performed exactly as an attacker or a confused operator would: the
  // ledger is deleted from the vacated tree in canonical bytes. The engine CANNOT
  // detect this — not "does not currently"; cannot. workspace.json is the one part
  // of the control tree the event hash chain does not cover.
  await writeMetadataJson(fixture.workspace, preVacate);
  const revived = await invokeCli(["status", "--workspace", fixture.workspace]);
  assert.equal(revived.ok, true, "the ceiling, stated honestly: a hand-restored source is alive again and nothing single-sided goes red");
  // The ONLY instrument that catches it is the two-sided comparison. This is why it
  // is a mandatory close-out step and gate evidence rather than a runbook bullet.
  const left = JSON.parse((await invokeCli(["relocation-inspect", "--workspace", fixture.workspace])).output);
  const right = JSON.parse((await invokeCli(["relocation-inspect", "--workspace", fixture.targetWorkspace])).output);
  assert.equal(left.state, "live");
  assert.equal(right.state, "live");
  assert.equal(left.workspaceId, right.workspaceId);
  assert.notEqual(left.address, right.address);
  const fork = left.workspaceId === right.workspaceId && left.state === "live" && right.state === "live" && left.address !== right.address;
  assert.equal(fork, true, "two live addresses for one workspaceId is the fork, and only comparing both sides shows it");
  // And the negative: before the tamper the same comparison reported exactly one
  // live address, so the check is not one that always reports a fork.
  assert.equal(right.relocationId, relocationId);
});
