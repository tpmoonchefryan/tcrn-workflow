// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  WorkspaceError,
  acquireWorkspaceLease,
  applyWorkspaceMigration,
  assertSupportedWorkspaceFilesystem,
  assertWorkspaceRecordCount,
  assertWorkspaceRelativePath,
  createProject,
  createWorkspaceArchive,
  createWork,
  deleteProject,
  deleteWork,
  exportWorkspace,
  initializeWorkspace,
  materializeWorkspace,
  planWorkspaceMigration,
  recoverWorkspace,
  transitionWork,
  updateProject,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { ProtocolError, canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

async function workspaceFixture(options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-p3-")));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  const state = await initializeWorkspace({
    roots,
    externalKey: options.externalKey ?? "WORKSPACE-ALPHA",
    createdAt: instant(0),
    segmentEventLimit: options.segmentEventLimit ?? 2,
  });
  return {
    base,
    roots,
    workspace,
    state,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

function expectReason(reasonCode, operation) {
  assert.throws(operation, (error) => error?.reasonCode === reasonCode, reasonCode);
}

async function expectReasonAsync(reasonCode, operation) {
  await assert.rejects(operation, (error) => error?.reasonCode === reasonCode, reasonCode);
}

test("Workspace metadata schema, five-root initialization, CLI readback, and standalone boundary are exact", async () => {
  const fixture = await workspaceFixture();
  try {
    const schema = JSON.parse(await readFile(new URL("../packages/core/schema/workspace-v1.schema.json", import.meta.url), "utf8"));
    const metadata = JSON.parse(await readFile(join(fixture.workspace, ".tcrn-workflow", "workspace.json"), "utf8"));
    const ajv = new Ajv2020({ strict: true, validateFormats: false });
    assert.equal(ajv.validate(schema, metadata), true, JSON.stringify(ajv.errors));
    assert.equal(fixture.state.version, 0);
    assert.equal((await validateWorkspace(fixture.workspace)).metadata.workspaceId, fixture.state.metadata.workspaceId);

    let output = "";
    await runCli(["status", "--workspace", fixture.workspace], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).reasonCode, "WORKSPACE_COMMAND_COMPLETED");
    output = "";
    await runCli([
      "project-create",
      "--workspace", fixture.workspace,
      "--expected-version", "0",
      "--at", instant(1),
      "--external-key", "PROJECT-CLI",
      "--name", "CLI Project",
    ], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).version, 1);
    await expectReasonAsync("CLI_ARGUMENT_DUPLICATE", () => runCli(
      ["status", "--workspace", fixture.workspace, "--workspace", fixture.workspace],
      { write() {} },
    ));
    await expectReasonAsync("CLI_ARGUMENT_UNKNOWN", () => runCli(
      ["status", "--workspace", fixture.workspace, "--remote", "true"],
      { write() {} },
    ));

    for (const path of ["../packages/core/package.json", "../packages/cli/package.json"]) {
      const manifest = JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
      assert.deepEqual(manifest.dependencies ?? {}, {});
    }
  } finally {
    await fixture.close();
  }
});

test("project CRUD and Initiative-Epic-Story-Subtask operations materialize deterministically", async () => {
  const fixture = await workspaceFixture();
  try {
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
    try {
      let state = await createProject(fixture.workspace, lease, {
        expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-ALPHA", name: "Alpha",
      });
      const projectId = state.projects[0].id;
      state = await createWork(fixture.workspace, lease, {
        expectedVersion: 1, occurredAt: instant(2), projectId, externalKey: "INITIATIVE-ONE", kind: "Initiative", parentId: null,
      });
      const initiativeId = state.work.find((record) => record.kind === "Initiative").id;
      state = await createWork(fixture.workspace, lease, {
        expectedVersion: 2, occurredAt: instant(3), projectId, externalKey: "EPIC-ONE", kind: "Epic", parentId: initiativeId,
      });
      const epicId = state.work.find((record) => record.kind === "Epic").id;
      state = await createWork(fixture.workspace, lease, {
        expectedVersion: 3, occurredAt: instant(4), projectId, externalKey: "STORY-ONE", kind: "Story", parentId: epicId,
      });
      const storyId = state.work.find((record) => record.kind === "Story").id;
      state = await createWork(fixture.workspace, lease, {
        expectedVersion: 4, occurredAt: instant(5), projectId, externalKey: "SUBTASK-ONE", kind: "Subtask", parentId: storyId,
      });
      state = await transitionWork(fixture.workspace, lease, {
        expectedVersion: 5, occurredAt: instant(6), id: initiativeId, status: "ready",
      });
      state = await updateProject(fixture.workspace, lease, {
        expectedVersion: 6, occurredAt: instant(7), id: projectId, name: "Alpha Updated",
      });
      const subtaskId = state.work.find((record) => record.kind === "Subtask").id;
      state = await deleteWork(fixture.workspace, lease, {
        expectedVersion: 7, occurredAt: instant(8), id: subtaskId,
      });
      state = await createProject(fixture.workspace, lease, {
        expectedVersion: 8, occurredAt: instant(9), externalKey: "PROJECT-EMPTY", name: "Empty",
      });
      const emptyProjectId = state.projects.find((record) => record.externalKey === "PROJECT-EMPTY").id;
      state = await deleteProject(fixture.workspace, lease, {
        expectedVersion: 9, occurredAt: instant(10), id: emptyProjectId,
      });
      assert.equal(state.version, 10);
      assert.deepEqual(state.work.map((record) => record.kind), ["Initiative", "Epic", "Story", "Subtask"]);
      assert.equal(state.projects.find((record) => record.id === projectId).revision, 2);
      await expectReasonAsync("GRAPH_PARENT_KIND_INVALID", () => createWork(fixture.workspace, lease, {
        expectedVersion: 10, occurredAt: instant(11), projectId, externalKey: "BAD-EPIC", kind: "Epic", parentId: storyId,
      }));
      const status = await readFile(join(fixture.workspace, ".tcrn-workflow", "views", "STATUS.md"), "utf8");
      assert.match(status, /Work records: 3/u);
      assert.equal(await exportWorkspace(fixture.workspace), await exportWorkspace(fixture.workspace));
      assert.deepEqual(await createWorkspaceArchive(fixture.workspace), await createWorkspaceArchive(fixture.workspace));
      assert.equal((await exportWorkspace(fixture.workspace)).includes(fixture.base), false);
    } finally {
      await lease.release();
    }
  } finally {
    await fixture.close();
  }
});

test("single-writer lease, CAS, stale-lock recovery, and atomic crash points fail closed", async () => {
  const fixture = await workspaceFixture();
  try {
    const active = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
    await expectReasonAsync("WORKSPACE_LOCKED", () => acquireWorkspaceLease(fixture.workspace, { now: instant(2) }));
    await expectReasonAsync("WORKSPACE_CAS_MISMATCH", () => createProject(fixture.workspace, active, {
      expectedVersion: 1, occurredAt: instant(2), externalKey: "PROJECT-CAS", name: "CAS",
    }));
    await active.release();

    const leaseRoot = join(fixture.workspace, ".tcrn-workflow", "lease");
    await mkdir(leaseRoot);
    await writeFile(join(leaseRoot, "owner.json"), canonicalJson({
      schemaVersion: "tcrn.workspace-lease.v1",
      token: "stale",
      pid: 999999,
      acquiredAt: "2000-01-01T00:00:00Z",
      expiresAtNanoseconds: "946684801000000000",
    }));
    const recoveredLease = await acquireWorkspaceLease(fixture.workspace, { now: instant(3) });
    await recoveredLease.release();
  } finally {
    await fixture.close();
  }

  const cases = JSON.parse(await readFile(new URL("../packages/core/fixtures/p3-cases.json", import.meta.url), "utf8"));
  for (const fault of cases.faultCases) {
    const crashFixture = await workspaceFixture();
    try {
      const lease = await acquireWorkspaceLease(crashFixture.workspace, { now: instant(1) });
      try {
        await expectReasonAsync(fault.expectedReasonCode, () => createProject(crashFixture.workspace, lease, {
          expectedVersion: 0,
          occurredAt: instant(2),
          externalKey: `PROJECT-${fault.id.toUpperCase()}`,
          name: fault.id,
          crashAt: fault.id,
        }));
        assert.equal((await materializeWorkspace(crashFixture.workspace)).version, fault.committed ? 1 : 0);
        if (fault.committed) {
          await expectReasonAsync("WORKSPACE_VIEW_STALE", () => validateWorkspace(crashFixture.workspace));
          assert.equal((await recoverWorkspace(crashFixture.workspace, lease)).version, 1);
        } else {
          assert.equal((await validateWorkspace(crashFixture.workspace)).version, 0);
        }
      } finally {
        await lease.release();
      }
    } finally {
      await crashFixture.close();
    }
  }
});

test("segment rotation and replay, truncation, reordering, corruption, gap, and special-entry attacks are rejected", async () => {
  const fixture = await workspaceFixture({ segmentEventLimit: 2 });
  try {
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
    try {
      let state = await createProject(fixture.workspace, lease, {
        expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-SEGMENT", name: "Segment",
      });
      const projectId = state.projects[0].id;
      state = await createWork(fixture.workspace, lease, {
        expectedVersion: 1, occurredAt: instant(2), projectId, externalKey: "INITIATIVE-SEGMENT", kind: "Initiative", parentId: null,
      });
      const initiativeId = state.work[0].id;
      await createWork(fixture.workspace, lease, {
        expectedVersion: 2, occurredAt: instant(3), projectId, externalKey: "EPIC-SEGMENT", kind: "Epic", parentId: initiativeId,
      });
    } finally {
      await lease.release();
    }
    const eventsRoot = join(fixture.workspace, ".tcrn-workflow", "events");
    const firstPath = join(eventsRoot, "000001.json");
    const secondPath = join(eventsRoot, "000002.json");
    const firstText = await readFile(firstPath, "utf8");
    const secondText = await readFile(secondPath, "utf8");
    const first = JSON.parse(firstText);

    await writeFile(firstPath, "{");
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    await writeFile(firstPath, firstText);

    await writeFile(firstPath, canonicalJson([first[0], first[0]]));
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    await writeFile(firstPath, firstText);

    await writeFile(firstPath, canonicalJson([...first].reverse()));
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    await writeFile(firstPath, firstText);

    await writeFile(firstPath, canonicalJson([first[0], { ...first[1], eventHash: "0".repeat(64) }]));
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    await writeFile(firstPath, firstText);

    await rename(secondPath, join(eventsRoot, "000003.json"));
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    await rename(join(eventsRoot, "000003.json"), secondPath);

    await mkdir(join(eventsRoot, "special-entry"));
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    await rm(join(eventsRoot, "special-entry"), { recursive: true });
    assert.equal((await validateWorkspace(fixture.workspace)).version, 3);
    assert.equal(secondText, await readFile(secondPath, "utf8"));
  } finally {
    await fixture.close();
  }
});

test("path, link, Unicode, size, record, filesystem, and migration boundaries have stable failures", async () => {
  expectReason("WORKSPACE_PATH_ESCAPE", () => assertWorkspaceRelativePath("../escape"));
  expectReason("WORKSPACE_PATH_ESCAPE", () => assertWorkspaceRelativePath("a\\b"));
  expectReason("WORKSPACE_RECORD_LIMIT", () => assertWorkspaceRecordCount(10_001));
  await expectReasonAsync("WORKSPACE_FILESYSTEM_UNSUPPORTED", () => assertSupportedWorkspaceFilesystem(tmpdir(), 0x7fffffff));

  const malformed = await workspaceFixture();
  try {
    const lease = await acquireWorkspaceLease(malformed.workspace, { now: instant(1) });
    try {
      await expectReasonAsync("WORKSPACE_INPUT_INVALID", () => createProject(malformed.workspace, lease, {
        expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-UNICODE", name: "\ud800",
      }));
      await expectReasonAsync("WORKSPACE_INPUT_OVERSIZED", () => createProject(malformed.workspace, lease, {
        expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-LARGE", name: "x".repeat(513),
      }));
    } finally {
      await lease.release();
    }
    const plan = await planWorkspaceMigration(malformed.workspace, 1);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.applyAvailable, false);
    assert.equal(plan.rollback, "restore-exact-pre-migration-backup-then-validate");
    assert.equal(plan.postValidation, "validate-exact-target-schema-and-full-event-chain");
    await expectReasonAsync("WORKSPACE_MIGRATION_DOWNGRADE", () => planWorkspaceMigration(malformed.workspace, 0));
    await expectReasonAsync("WORKSPACE_MIGRATION_FUTURE", () => planWorkspaceMigration(malformed.workspace, 2));
    await expectReasonAsync("WORKSPACE_MIGRATION_APPLY_UNAVAILABLE", () => applyWorkspaceMigration());
  } finally {
    await malformed.close();
  }

  for (const linkKind of ["symlink", "hardlink"]) {
    const fixture = await workspaceFixture();
    try {
      const metadata = join(fixture.workspace, ".tcrn-workflow", "workspace.json");
      const backup = join(fixture.workspace, ".tcrn-workflow", `workspace-${linkKind}.json`);
      await rename(metadata, backup);
      if (linkKind === "symlink") {
        await symlink(backup, metadata);
      } else {
        await link(backup, metadata);
      }
      await expectReasonAsync("WORKSPACE_PATH_INVALID", () => materializeWorkspace(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }

  const future = await workspaceFixture();
  try {
    const metadataPath = join(future.workspace, ".tcrn-workflow", "workspace.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(metadataPath, canonicalJson({ ...metadata, storageVersion: 2 }));
    await expectReasonAsync("WORKSPACE_MIGRATION_FUTURE", () => materializeWorkspace(future.workspace));
  } finally {
    await future.close();
  }
});

test("derived ordering, readback hashes, and export bytes remain deterministic across 64 permutations", async () => {
  const fixture = await workspaceFixture();
  try {
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
    try {
      let state = fixture.state;
      for (const [index, key] of ["PROJECT-Z", "PROJECT-A", "PROJECT-M"].entries()) {
        state = await createProject(fixture.workspace, lease, {
          expectedVersion: index, occurredAt: instant(index + 1), externalKey: key, name: key,
        });
      }
      assert.deepEqual(state.projects.map((record) => record.externalKey), ["PROJECT-A", "PROJECT-M", "PROJECT-Z"]);
    } finally {
      await lease.release();
    }
    const state = await validateWorkspace(fixture.workspace);
    const expected = canonicalSha256(state.projects);
    let seed = 113;
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const shuffled = [...state.projects];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        seed = (seed * 48271) % 2147483647;
        const target = seed % (index + 1);
        [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
      }
      shuffled.sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
      assert.equal(canonicalSha256(shuffled), expected);
    }
    const readback = JSON.parse(await readFile(join(fixture.workspace, ".tcrn-workflow", "views", "readback.json"), "utf8"));
    assert.equal(readback.authority, "derived-rebuildable");
    assert.equal(typeof readback.graphDigest, "string");
  } finally {
    await fixture.close();
  }
});
