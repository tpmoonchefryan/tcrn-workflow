// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
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
  breakWorkspaceLease,
  inspectWorkspaceLease,
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
import * as publicCore from "../dist/build/packages/core/src/index.js";
import {
  consumeQuarantineReplacementTestInstrumentation,
  isQuarantineReplacementTestInstrumentationArmed,
  withQuarantineReplacementTestInstrumentation,
} from "../dist/build/packages/core/src/workspace-test-instrumentation.js";
import {
  ProtocolError,
  canonicalJson,
  canonicalSha256,
  createEvent,
  deriveStableId,
} from "../dist/build/packages/protocol/src/index.js";

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

function expectedStreamId(metadata) {
  return `stream:${canonicalSha256({
    schemaVersion: "tcrn.workspace-stream-identity.v1",
    workspaceId: metadata.workspaceId,
    createdAt: metadata.createdAt,
  }).slice(0, 24)}`;
}

function expectedEventId(streamId, sequence) {
  return `event:${canonicalSha256({
    schemaVersion: "tcrn.workspace-event-identity.v1",
    streamId,
    sequence,
  }).slice(0, 24)}`;
}

async function rewriteEventChain(workspace, transform, identity = {}) {
  const control = join(workspace, ".tcrn-workflow");
  const metadata = JSON.parse(await readFile(join(control, "workspace.json"), "utf8"));
  const eventsRoot = join(control, "events");
  const names = (await readdir(eventsRoot)).filter((name) => /^\d{6}\.json$/u.test(name)).sort();
  const original = [];
  for (const name of names) {
    original.push(...JSON.parse(await readFile(join(eventsRoot, name), "utf8")));
  }
  const specifications = transform(structuredClone(original));
  const streamId = identity.streamId ?? expectedStreamId(metadata);
  const rebuilt = [];
  for (const [index, specification] of specifications.entries()) {
    const sequence = index + 1;
    rebuilt.push(createEvent({
      id: identity.eventIdFor?.(streamId, sequence) ?? expectedEventId(streamId, sequence),
      streamId,
      sequence,
      occurredAt: specification.occurredAt,
      priorHash: rebuilt.at(-1)?.eventHash ?? null,
      payload: specification.payload,
    }));
  }
  for (const name of names) {
    await rm(join(eventsRoot, name));
  }
  for (let offset = 0; offset < rebuilt.length; offset += metadata.segmentEventLimit) {
    const segment = rebuilt.slice(offset, offset + metadata.segmentEventLimit);
    const index = Math.floor(offset / metadata.segmentEventLimit) + 1;
    await writeFile(join(eventsRoot, `${String(index).padStart(6, "0")}.json`), canonicalJson(segment));
  }
  return rebuilt;
}

async function createProjectHistory(fixture, update = false, remove = false) {
  const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
  try {
    let state = await createProject(fixture.workspace, lease, {
      expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-FORGED", name: "Forged",
    });
    if (update) {
      state = await updateProject(fixture.workspace, lease, {
        expectedVersion: 1, occurredAt: instant(2), id: state.projects[0].id, name: "Updated",
      });
    }
    if (remove) {
      state = await deleteProject(fixture.workspace, lease, {
        expectedVersion: 1, occurredAt: instant(2), id: state.projects[0].id,
      });
    }
    return state;
  } finally {
    await lease.release();
  }
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

test("Workspace root entries have exact Ajv/runtime field and type parity", async () => {
  const schema = JSON.parse(await readFile(new URL("../packages/core/schema/workspace-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  const mutations = [
    (metadata) => { metadata.roots[0].extraAuthority = true; },
    (metadata) => { delete metadata.roots[0].canonicalPath; },
    (metadata) => { metadata.roots[0].path = 7; },
    (metadata) => { metadata.roots[0] = "framework"; },
  ];
  for (const mutate of mutations) {
    const fixture = await workspaceFixture();
    try {
      const metadataPath = join(fixture.workspace, ".tcrn-workflow", "workspace.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      mutate(metadata);
      assert.equal(ajv.validate(schema, metadata), false);
      await writeFile(metadataPath, canonicalJson(metadata));
      await expectReasonAsync("WORKSPACE_SCHEMA_INVALID", () => materializeWorkspace(fixture.workspace));
    } finally {
      await fixture.close();
    }
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

test("WSA-4: lease-inspect reports state and lease-break clears the pid-reuse wedge under token+expiry gates", async () => {
  const fixture = await workspaceFixture();
  try {
    // no lease yet
    assert.deepEqual(await inspectWorkspaceLease(fixture.workspace, { now: instant(5) }), {
      schemaVersion: "tcrn.workspace-lease-inspection.v1", reasonCode: "WORKSPACE_LEASE_OBSERVED", held: false,
    });
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(10) });
    const inspected = await inspectWorkspaceLease(fixture.workspace, { now: instant(20) });
    assert.equal(inspected.held, true);
    assert.equal(inspected.token, lease.token);
    assert.equal(inspected.expired, false);
    // an unexpired lease cannot be broken, even with the right token
    await expectReasonAsync("WORKSPACE_LOCKED", () => breakWorkspaceLease(fixture.workspace, { now: instant(20), ownerToken: lease.token }));
    // expired now (ttl 30s from instant(10) => expires instant(40)); a wrong token still fails
    assert.equal((await inspectWorkspaceLease(fixture.workspace, { now: instant(50) })).expired, true);
    await expectReasonAsync("WORKSPACE_LEASE_INVALID", () => breakWorkspaceLease(fixture.workspace, { now: instant(50), ownerToken: "0".repeat(48) }));
    // correct token + expired => broken, bypassing the processAlive wedge (this test pid is alive)
    const broken = await breakWorkspaceLease(fixture.workspace, { now: instant(50), ownerToken: lease.token });
    assert.equal(broken.reasonCode, "WORKSPACE_LEASE_BROKEN");
    assert.equal(broken.token, lease.token);
    // the workspace is now acquirable again
    const fresh = await acquireWorkspaceLease(fixture.workspace, { now: instant(51) });
    await fresh.release();
    assert.deepEqual(await inspectWorkspaceLease(fixture.workspace, { now: instant(52) }), {
      schemaVersion: "tcrn.workspace-lease-inspection.v1", reasonCode: "WORKSPACE_LEASE_OBSERVED", held: false,
    });
  } finally {
    await fixture.close();
  }
});

test("WSB-1: mutation responses carry the created/mutated record identity", async () => {
  const fixture = await workspaceFixture();
  try {
    const run = async (args) => {
      let output = "";
      await runCli(args, { write: (value) => { output += value; } });
      return JSON.parse(output);
    };
    const ws = ["--workspace", fixture.workspace];
    const projectCreate = await run(["project-create", ...ws, "--expected-version", "0", "--at", instant(1), "--external-key", "PROJECT-B1", "--name", "B1"]);
    assert.equal(projectCreate.record.id, deriveStableId("project", "PROJECT-B1"));
    assert.equal(projectCreate.record.revision, 1);
    assert.equal(projectCreate.record.tombstone, false);
    // pre-existing envelope keys remain present
    assert.equal(projectCreate.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
    assert.equal(projectCreate.version, 1);
    assert.equal(typeof projectCreate.headEventHash, "string");
    const projectId = projectCreate.record.id;
    const workCreate = await run(["work-create", ...ws, "--expected-version", "1", "--at", instant(2), "--project-id", projectId, "--external-key", "INIT-B1", "--kind", "Initiative"]);
    assert.equal(workCreate.record.id, deriveStableId("work", "INIT-B1"));
    assert.deepEqual({ kind: workCreate.record.kind, status: workCreate.record.status, projectId: workCreate.record.projectId, parentId: workCreate.record.parentId, revision: workCreate.record.revision, tombstone: workCreate.record.tombstone },
      { kind: "Initiative", status: "planned", projectId, parentId: null, revision: 1, tombstone: false });
    const workId = workCreate.record.id;
    const transitioned = await run(["work-transition", ...ws, "--expected-version", "2", "--at", instant(3), "--id", workId, "--status", "ready"]);
    assert.equal(transitioned.record.status, "ready");
    assert.equal(transitioned.record.revision, 2);
    const deleted = await run(["work-delete", ...ws, "--expected-version", "3", "--at", instant(4), "--id", workId]);
    assert.equal(deleted.record.tombstone, true);
    // byte-identical repeat on a fresh fixture
    const other = await workspaceFixture();
    try {
      let a = "";
      await runCli(["project-create", "--workspace", other.workspace, "--expected-version", "0", "--at", instant(1), "--external-key", "PROJECT-B1", "--name", "B1"], { write: (value) => { a += value; } });
      let b = "";
      await runCli(["project-create", "--workspace", fixture.workspace, "--expected-version", "4", "--at", instant(5), "--external-key", "PROJECT-B1B", "--name", "B1"], { write: (value) => { b += value; } });
      assert.notEqual(a, b);
      assert.equal(JSON.parse(a).record.id, deriveStableId("project", "PROJECT-B1"));
    } finally {
      await other.close();
    }
  } finally {
    await fixture.close();
  }
});

test("WSB-4: work-create --parent-id '-' yields a null parent byte-identical to omitting the flag", async () => {
  const createRoot = async (fixture, parentFlag) => {
    let projectOut = "";
    await runCli(["project-create", "--workspace", fixture.workspace, "--expected-version", "0", "--at", instant(1), "--external-key", "PROJECT-B4", "--name", "B4"], { write: (value) => { projectOut += value; } });
    const projectId = JSON.parse(projectOut).record.id;
    let workOut = "";
    await runCli([
      "work-create", "--workspace", fixture.workspace, "--expected-version", "1", "--at", instant(2),
      "--project-id", projectId, "--external-key", "INIT-B4", "--kind", "Initiative", ...parentFlag,
    ], { write: (value) => { workOut += value; } });
    return JSON.parse(workOut);
  };
  const dashFixture = await workspaceFixture();
  const omitFixture = await workspaceFixture();
  try {
    const dash = await createRoot(dashFixture, ["--parent-id", "-"]);
    const omit = await createRoot(omitFixture, []);
    assert.equal(dash.record.parentId, null);
    // '-' is the explicit null spelling; omitting the flag is the historical null. Both are byte-identical.
    assert.deepEqual(dash.record, omit.record);
    assert.equal(dash.headEventHash, omit.headEventHash);
  } finally {
    await dashFixture.close();
    await omitFixture.close();
  }
});

test("WSB-7: --expected-version head derives the current version under the lease; numeric CAS still fails closed", async () => {
  const fixture = await workspaceFixture();
  try {
    const run = async (args) => {
      let output = "";
      await runCli(args, { write: (value) => { output += value; } });
      return JSON.parse(output);
    };
    const ws = ["--workspace", fixture.workspace];
    // (a) head on a workspace at version 0 commits exactly version 1 with the correct record id.
    const projectCreate = await run(["project-create", ...ws, "--expected-version", "head", "--at", instant(1), "--external-key", "PROJECT-B7", "--name", "B7"]);
    assert.equal(projectCreate.version, 1);
    assert.equal(projectCreate.record.id, deriveStableId("project", "PROJECT-B7"));
    const projectId = projectCreate.record.id;
    // (b) two further sequential head mutations commit versions 2 then 3 with no manual version tracking.
    const workCreate = await run(["work-create", ...ws, "--expected-version", "head", "--at", instant(2), "--project-id", projectId, "--external-key", "INIT-B7", "--kind", "Initiative"]);
    assert.equal(workCreate.version, 2);
    assert.equal(workCreate.record.id, deriveStableId("work", "INIT-B7"));
    const workId = workCreate.record.id;
    const transitioned = await run(["work-transition", ...ws, "--expected-version", "head", "--at", instant(3), "--id", workId, "--status", "ready"]);
    assert.equal(transitioned.version, 3);
    assert.equal(transitioned.record.status, "ready");
    // (d) a stale NUMERIC expected-version stays byte-identical to baseline and still fails closed.
    await expectReasonAsync("WORKSPACE_CAS_MISMATCH", () => runCli(
      ["project-create", ...ws, "--expected-version", "1", "--at", instant(4), "--external-key", "PROJECT-B7B", "--name", "B7B"],
      { write: () => {} },
    ));
    // (e) near-miss spellings are not the head marker and fail malformed on an in-scope verb.
    for (const spelling of ["HEAD", "latest"]) {
      await expectReasonAsync("CLI_ARGUMENT_MALFORMED", () => runCli(
        ["work-delete", ...ws, "--expected-version", spelling, "--at", instant(5), "--id", workId],
        { write: () => {} },
      ));
    }
    // (c) head is rejected on out-of-scope knowledge-marker mutations, which keep numeric-only expected-version.
    await expectReasonAsync("CLI_ARGUMENT_MALFORMED", () => runCli(
      ["knowledge-promote", ...ws, "--expected-version", "head", "--expected-revision", "1", "--at", instant(6), "--id", "irrelevant", "--state", "promoted"],
      { write: () => {} },
    ));
  } finally {
    await fixture.close();
  }
});

test("WSA-1: every mutation returns state identical to a fresh materialize (single-replay pipeline)", async () => {
  const fixture = await workspaceFixture();
  try {
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
    const projection = (state) => ({ version: state.version, headEventHash: state.headEventHash, projects: state.projects, work: state.work });
    const assertFresh = async (returned) => {
      const fresh = await materializeWorkspace(fixture.workspace);
      assert.deepEqual(projection(returned), projection(fresh), "returned state must equal a fresh materialize");
    };
    try {
      let state = await createProject(fixture.workspace, lease, { expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-ALPHA", name: "Alpha" });
      await assertFresh(state);
      const projectId = state.projects[0].id;
      state = await createWork(fixture.workspace, lease, { expectedVersion: 1, occurredAt: instant(2), projectId, externalKey: "INITIATIVE-ONE", kind: "Initiative", parentId: null });
      await assertFresh(state);
      const initiativeId = state.work.find((record) => record.kind === "Initiative").id;
      state = await createWork(fixture.workspace, lease, { expectedVersion: 2, occurredAt: instant(3), projectId, externalKey: "EPIC-ONE", kind: "Epic", parentId: initiativeId });
      await assertFresh(state);
      const epicId = state.work.find((record) => record.kind === "Epic").id;
      state = await transitionWork(fixture.workspace, lease, { expectedVersion: 3, occurredAt: instant(4), id: epicId, status: "ready" });
      await assertFresh(state);
      state = await updateProject(fixture.workspace, lease, { expectedVersion: 4, occurredAt: instant(5), id: projectId, name: "Alpha Two" });
      await assertFresh(state);
      state = await deleteWork(fixture.workspace, lease, { expectedVersion: 5, occurredAt: instant(6), id: epicId });
      await assertFresh(state);
      state = await deleteWork(fixture.workspace, lease, { expectedVersion: 6, occurredAt: instant(7), id: initiativeId });
      await assertFresh(state);
      state = await deleteProject(fixture.workspace, lease, { expectedVersion: 7, occurredAt: instant(8), id: projectId });
      await assertFresh(state);
      assert.equal(state.version, 8);
    } finally {
      await lease.release();
    }
  } finally {
    await fixture.close();
  }
});

test("WSA-2: a 400-record deep-hierarchy build completes and exports deterministically", async () => {
  // Under the pre-WSA-2 per-event full-graph validation this build was O(n^3) and
  // exceeded the test-controller timeout. It must now simply finish.
  const fixture = await workspaceFixture();
  try {
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
    const at = (n) => new Date(Date.UTC(2026, 6, 11, 0, 0, 0) + n * 1000).toISOString().replace(/\.000Z$/u, "Z");
    try {
      let version = 0;
      let state = await createProject(fixture.workspace, lease, { expectedVersion: version, occurredAt: at(version), externalKey: "PROJECT-DEEP", name: "Deep" });
      version += 1;
      const projectId = state.projects[0].id;
      const chains = 100;
      for (let i = 0; i < chains; i += 1) {
        state = await createWork(fixture.workspace, lease, { expectedVersion: version, occurredAt: at(version), projectId, externalKey: `INITIATIVE-${i}`, kind: "Initiative", parentId: null });
        const initiativeId = state.work.find((record) => record.externalKey === `INITIATIVE-${i}`).id;
        version += 1;
        state = await createWork(fixture.workspace, lease, { expectedVersion: version, occurredAt: at(version), projectId, externalKey: `EPIC-${i}`, kind: "Epic", parentId: initiativeId });
        const epicId = state.work.find((record) => record.externalKey === `EPIC-${i}`).id;
        version += 1;
        state = await createWork(fixture.workspace, lease, { expectedVersion: version, occurredAt: at(version), projectId, externalKey: `STORY-${i}`, kind: "Story", parentId: epicId });
        const storyId = state.work.find((record) => record.externalKey === `STORY-${i}`).id;
        version += 1;
        state = await createWork(fixture.workspace, lease, { expectedVersion: version, occurredAt: at(version), projectId, externalKey: `SUBTASK-${i}`, kind: "Subtask", parentId: storyId });
        version += 1;
      }
      assert.equal(state.version, 1 + chains * 4);
      assert.equal(state.work.length, chains * 4);
      assert.equal(await exportWorkspace(fixture.workspace), await exportWorkspace(fixture.workspace));
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
      token: "b".repeat(48),
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

test("same lease and expected version admit exactly one concurrent mutation", async () => {
  const fixture = await workspaceFixture();
  try {
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
    try {
      let claimEntered;
      const entered = new Promise((resolve) => { claimEntered = resolve; });
      let releaseBarrier;
      const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
      const winner = createProject(fixture.workspace, lease, {
        expectedVersion: 0,
        occurredAt: instant(2),
        externalKey: "PROJECT-CONCURRENT-ALPHA",
        name: "Concurrent Alpha",
        async afterMutationClaimForTest() {
          claimEntered();
          await barrier;
        },
      });
      await entered;
      const leaseAlias = {
        workspaceRoot: lease.workspaceRoot,
        token: lease.token,
        acquiredAt: lease.acquiredAt,
        release: lease.release.bind(lease),
      };
      assert.notEqual(leaseAlias, lease);
      const loser = createProject(fixture.workspace, leaseAlias, {
        expectedVersion: 0,
        occurredAt: instant(2),
        externalKey: "PROJECT-CONCURRENT-BETA",
        name: "Concurrent Beta",
      }).finally(() => {
        releaseBarrier();
      });
      const settle = async (operation) => {
        try {
          return { status: "fulfilled", value: await operation };
        } catch (reason) {
          return { status: "rejected", reason };
        }
      };
      const outcomes = await Promise.all([settle(winner), settle(loser)]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].reason.reasonCode, "WORKSPACE_CAS_MISMATCH");
      const state = await materializeWorkspace(fixture.workspace);
      assert.equal(state.version, 1);
      assert.equal(state.events.length, 1);
      assert.deepEqual(state.projects.filter((record) => !record.tombstone).map((record) => record.externalKey), [
        "PROJECT-CONCURRENT-ALPHA",
      ]);
      assert.equal((await validateWorkspace(fixture.workspace)).version, 1);
    } finally {
      await lease.release();
    }
  } finally {
    await fixture.close();
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

test("event admission rejects unknown operations, lifecycle forgery, resurrection, and invalid relationships", async () => {
  const scenarios = [
    {
      prepare: (fixture) => createProjectHistory(fixture, true, false),
      mutate(events) {
        events[1].payload.operation = "project.archived";
        return events;
      },
    },
    {
      prepare: (fixture) => createProjectHistory(fixture, false, true),
      mutate(events) {
        const deleted = structuredClone(events[1]);
        deleted.occurredAt = instant(3);
        deleted.payload.record.revision = 3;
        return [...events, deleted];
      },
    },
    {
      prepare: (fixture) => createProjectHistory(fixture, false, true),
      mutate(events) {
        const resurrected = structuredClone(events[1]);
        resurrected.occurredAt = instant(3);
        resurrected.payload.operation = "project.updated";
        resurrected.payload.record.revision = 3;
        resurrected.payload.record.tombstone = false;
        resurrected.payload.record.updatedAt = instant(3);
        return [...events, resurrected];
      },
    },
    {
      prepare: (fixture) => createProjectHistory(fixture, true, false),
      mutate(events) {
        events[1].payload.record.revision = 99;
        return events;
      },
    },
  ];
  for (const scenario of scenarios) {
    const fixture = await workspaceFixture();
    try {
      await scenario.prepare(fixture);
      await rewriteEventChain(fixture.workspace, scenario.mutate);
      await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }

  for (const operation of ["project.updated", "project.deleted"]) {
    const absentFixture = await workspaceFixture();
    try {
      const externalKey = "PROJECT-ABSENT";
      await rewriteEventChain(absentFixture.workspace, () => [{
        occurredAt: instant(1),
        payload: {
          operation,
          record: {
            schemaVersion: "tcrn.project.v1",
            id: deriveStableId("project", externalKey),
            externalKey,
            name: "Absent",
            revision: 1,
            updatedAt: instant(1),
            tombstone: operation === "project.deleted",
          },
        },
      }]);
      await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(absentFixture.workspace));
    } finally {
      await absentFixture.close();
    }
  }

  const workFixture = await workspaceFixture();
  try {
    const lease = await acquireWorkspaceLease(workFixture.workspace, { now: instant(1) });
    try {
      let state = await createProject(workFixture.workspace, lease, {
        expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-WORK-FORGE", name: "Work Forge",
      });
      state = await createWork(workFixture.workspace, lease, {
        expectedVersion: 1,
        occurredAt: instant(2),
        projectId: state.projects[0].id,
        externalKey: "INITIATIVE-WORK-FORGE",
        kind: "Initiative",
        parentId: null,
      });
      await transitionWork(workFixture.workspace, lease, {
        expectedVersion: 2, occurredAt: instant(3), id: state.work[0].id, status: "ready",
      });
    } finally {
      await lease.release();
    }
    await rewriteEventChain(workFixture.workspace, (events) => {
      events[2].payload.operation = "work.archived";
      return events;
    });
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(workFixture.workspace));
  } finally {
    await workFixture.close();
  }

  const relationshipFixture = await workspaceFixture();
  try {
    const lease = await acquireWorkspaceLease(relationshipFixture.workspace, { now: instant(1) });
    try {
      let state = await createProject(relationshipFixture.workspace, lease, {
        expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-RELATIONSHIP", name: "Relationship",
      });
      await createWork(relationshipFixture.workspace, lease, {
        expectedVersion: 1,
        occurredAt: instant(2),
        projectId: state.projects[0].id,
        externalKey: "INITIATIVE-RELATIONSHIP",
        kind: "Initiative",
        parentId: null,
      });
    } finally {
      await lease.release();
    }
    await rewriteEventChain(relationshipFixture.workspace, (events) => {
      events[1].payload.record.projectId = "project:missing";
      return events;
    });
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(relationshipFixture.workspace));
  } finally {
    await relationshipFixture.close();
  }

  const absentWorkFixture = await workspaceFixture();
  try {
    const state = await createProjectHistory(absentWorkFixture, false, false);
    const externalKey = "INITIATIVE-ABSENT";
    await rewriteEventChain(absentWorkFixture.workspace, (events) => [...events, {
      occurredAt: instant(2),
      payload: {
        operation: "work.updated",
        record: {
          schemaVersion: "tcrn.work.v1",
          id: deriveStableId("work", externalKey),
          externalKey,
          projectId: state.projects[0].id,
          kind: "Initiative",
          parentId: null,
          status: "ready",
          revision: 1,
          updatedAt: instant(2),
          tombstone: false,
          extensions: {},
        },
      },
    }]);
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(absentWorkFixture.workspace));
  } finally {
    await absentWorkFixture.close();
  }
});

test("event stream and event IDs are bound to canonical Workspace metadata", async () => {
  const source = await workspaceFixture({ externalKey: "WORKSPACE-SOURCE" });
  const target = await workspaceFixture({ externalKey: "WORKSPACE-TARGET" });
  try {
    await createProjectHistory(source, false, false);
    const sourceSegment = join(source.workspace, ".tcrn-workflow", "events", "000001.json");
    const targetSegment = join(target.workspace, ".tcrn-workflow", "events", "000001.json");
    await writeFile(targetSegment, await readFile(sourceSegment));
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(target.workspace));
  } finally {
    await source.close();
    await target.close();
  }

  for (const identity of [
    { streamId: "stream:wrong" },
    { eventIdFor: () => "event:wrong" },
  ]) {
    const fixture = await workspaceFixture();
    try {
      await createProjectHistory(fixture, false, false);
      await rewriteEventChain(fixture.workspace, (events) => events, identity);
      await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }
});

test("a crashed dir-only lease is reclaimable once ttl of real time elapses, even when the injected event time predates the real clock", async () => {
  const crashFixture = await workspaceFixture();
  try {
    await expectReasonAsync("WORKSPACE_FAULT_INJECTED", () => acquireWorkspaceLease(crashFixture.workspace, {
      now: instant(1),
      crashAfterLeaseDirectoryForTest: true,
    }));
    const incompleteLease = join(crashFixture.workspace, ".tcrn-workflow", "lease");
    assert.deepEqual(await readdir(incompleteLease), []);
    // Backdate the lease directory to a real-recent time well beyond the 30s ttl,
    // WITHOUT year-2000 backdating. The injected event time (2026-07-11) predates
    // the real machine clock, which is exactly the domain in which the previous
    // injected-time grace produced a negative age and wedged the workspace forever.
    // The real-clock grace correctly measures 60s of real elapsed time and reclaims.
    await utimes(incompleteLease, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const recovered = await acquireWorkspaceLease(crashFixture.workspace, { now: instant(2) });
    assert.deepEqual(await readdir(incompleteLease), ["owner.json"]);
    await recovered.release();
  } finally {
    await crashFixture.close();
  }
});

test("lease creation crash and recovery-claim contention are recoverable and single-writer", async () => {
  const crashFixture = await workspaceFixture();
  try {
    await expectReasonAsync("WORKSPACE_FAULT_INJECTED", () => acquireWorkspaceLease(crashFixture.workspace, {
      now: instant(1),
      crashAfterLeaseDirectoryForTest: true,
    }));
    const incompleteLease = join(crashFixture.workspace, ".tcrn-workflow", "lease");
    const incompleteIdentity = await lstat(incompleteLease);
    await utimes(incompleteLease, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    let quarantined = false;
    let reusedTupleObserved = false;
    const recovered = await acquireWorkspaceLease(crashFixture.workspace, {
      now: instant(2),
      async afterLeaseQuarantineForTest({ identity, entries }) {
        assert.deepEqual(identity, { dev: incompleteIdentity.dev, ino: incompleteIdentity.ino });
        assert.deepEqual(entries, []);
        assert.equal(Object.isFrozen(identity), true);
        assert.equal(Object.isFrozen(entries), true);
        assert.throws(() => { identity.dev = 0; }, TypeError);
        assert.throws(() => { entries.push("mutation"); }, TypeError);
        assert.deepEqual(identity, { dev: incompleteIdentity.dev, ino: incompleteIdentity.ino });
        assert.deepEqual(entries, []);
        quarantined = true;
      },
      // A filesystem may reuse the tuple after removal.  Recovery is bound to
      // the quarantined pathname/generation, not to global inode uniqueness.
      freshLeaseIdentityObservationForTest: () => ({ dev: incompleteIdentity.dev, ino: incompleteIdentity.ino }),
      async afterFreshLeaseForTest({ observedIdentity, freshIdentity }) {
        assert.deepEqual(observedIdentity, { dev: incompleteIdentity.dev, ino: incompleteIdentity.ino });
        assert.deepEqual(freshIdentity, observedIdentity);
        reusedTupleObserved = true;
      },
    });
    assert.equal(quarantined, true);
    assert.equal(reusedTupleObserved, true);
    assert.deepEqual(await readdir(incompleteLease), ["owner.json"]);
    await recovered.release();
  } finally {
    await crashFixture.close();
  }

  const contenderFixture = await workspaceFixture();
  try {
    await mkdir(join(contenderFixture.workspace, ".tcrn-workflow", "lease"));
    await utimes(
      join(contenderFixture.workspace, ".tcrn-workflow", "lease"),
      new Date("2000-01-01T00:00:00Z"),
      new Date("2000-01-01T00:00:00Z"),
    );
    let arrivals = 0;
    let releaseBarrier;
    const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
    const beforeClaimForTest = async () => {
      arrivals += 1;
      if (arrivals === 2) {
        releaseBarrier();
      }
      await barrier;
    };
    const outcomes = await Promise.allSettled([
      acquireWorkspaceLease(contenderFixture.workspace, { now: instant(3), beforeClaimForTest }),
      acquireWorkspaceLease(contenderFixture.workspace, { now: instant(3), beforeClaimForTest }),
    ]);
    const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const losers = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.ok(["WORKSPACE_LOCKED", "WORKSPACE_LEASE_INVALID"].includes(losers[0].reason.reasonCode));
    const winner = winners[0].value;
    await createProject(contenderFixture.workspace, winner, {
      expectedVersion: 0, occurredAt: instant(4), externalKey: "PROJECT-WINNER", name: "Winner",
    });
    await winner.release();
    const next = await acquireWorkspaceLease(contenderFixture.workspace, { now: instant(5) });
    try {
      await expectReasonAsync("WORKSPACE_CAS_MISMATCH", () => createProject(contenderFixture.workspace, next, {
        expectedVersion: 0, occurredAt: instant(5), externalKey: "PROJECT-LOSER", name: "Loser",
      }));
    } finally {
      await next.release();
    }
  } finally {
    await contenderFixture.close();
  }

  const delayedFixture = await workspaceFixture();
  try {
    let creatorEntered;
    const entered = new Promise((resolve) => { creatorEntered = resolve; });
    let resumeCreator;
    const resume = new Promise((resolve) => { resumeCreator = resolve; });
    const original = acquireWorkspaceLease(delayedFixture.workspace, {
      now: instant(1),
      async beforeLeaseOwnerForTest() {
        creatorEntered();
        await resume;
      },
    });
    await entered;
    const leasePath = join(delayedFixture.workspace, ".tcrn-workflow", "lease");
    await utimes(leasePath, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    let winnerEntered;
    const winnerAtOwner = new Promise((resolve) => { winnerEntered = resolve; });
    let resumeWinner;
    const winnerResume = new Promise((resolve) => { resumeWinner = resolve; });
    const winnerOperation = acquireWorkspaceLease(delayedFixture.workspace, {
      now: instant(2),
      async beforeLeaseOwnerForTest() {
        winnerEntered();
        await winnerResume;
      },
    });
    await winnerAtOwner;
    resumeCreator();
    await expectReasonAsync("WORKSPACE_LEASE_INVALID", () => original);
    resumeWinner();
    const winner = await winnerOperation;
    await createProject(delayedFixture.workspace, winner, {
      expectedVersion: 0, occurredAt: instant(3), externalKey: "PROJECT-DELAYED-WINNER", name: "Delayed Winner",
    });
    await winner.release();
    assert.equal((await materializeWorkspace(delayedFixture.workspace)).version, 1);
  } finally {
    await delayedFixture.close();
  }
});

test("ownerless stale generations are quarantined without carrying unexpected entries", async () => {
  for (const kind of ["file", "symlink", "directory"]) {
    const fixture = await workspaceFixture({ externalKey: `WORKSPACE-STALE-${kind.toUpperCase()}` });
    try {
      const control = join(fixture.workspace, ".tcrn-workflow");
      const leasePath = join(control, "lease");
      const unexpected = join(leasePath, "unexpected");
      await mkdir(leasePath);
      if (kind === "file") {
        await writeFile(unexpected, "stale");
      } else if (kind === "symlink") {
        await symlink(join(fixture.base, "missing-target"), unexpected);
      } else {
        await mkdir(unexpected);
      }
      const staleIdentity = await lstat(leasePath);
      await utimes(leasePath, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
      let quarantined = false;
      const recovered = await acquireWorkspaceLease(fixture.workspace, { now: instant(3), async afterLeaseQuarantineForTest({ identity, entries }) {
        assert.deepEqual(identity, { dev: staleIdentity.dev, ino: staleIdentity.ino });
        assert.ok(entries.includes("unexpected"));
        quarantined = true;
      } });
      assert.equal(quarantined, true);
      assert.deepEqual(await readdir(leasePath), ["owner.json"]);
      assert.deepEqual((await readdir(control)).filter((name) => name.startsWith("stale-lease-")), []);
      await recovered.release();
    } finally {
      await fixture.close();
    }
  }
});

test("quarantine replacement is preserved and fails closed before recursive cleanup", async () => {
  const fixture = await workspaceFixture({ externalKey: "WORKSPACE-QUARANTINE-REPLACEMENT" });
  try {
    const [packageManifest, packageIndex, publicSignature] = await Promise.all([
      readFile(new URL("../packages/core/package.json", import.meta.url), "utf8"),
      readFile(new URL("../packages/core/src/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../dist/build/packages/core/src/workspace.js", import.meta.url), "utf8"),
    ]);
    assert.equal(packageManifest.includes("workspace-test-instrumentation"), false);
    assert.equal(packageIndex.includes("workspace-test-instrumentation"), false);
    assert.equal(publicSignature.includes("quarantineReplacementForTest"), false);
    assert.equal(Object.keys(publicCore).some((name) => name.toLowerCase().includes("instrumentation")), false);
    const control = join(fixture.workspace, ".tcrn-workflow");
    const leasePath = join(control, "lease");
    const attemptOwned = join(control, "attempt-owned-quarantine-for-test");
    await mkdir(leasePath);
    await writeFile(join(leasePath, "attempt-entry"), "attempt-owned");
    await utimes(leasePath, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    await expectReasonAsync("WORKSPACE_LEASE_INVALID", () => withQuarantineReplacementTestInstrumentation(() => acquireWorkspaceLease(fixture.workspace, {
      now: instant(3),
    })));
    assert.equal(isQuarantineReplacementTestInstrumentationArmed(), false);
    assert.equal(await readFile(join(attemptOwned, "attempt-entry"), "utf8"), "attempt-owned");
    const replacement = (await readdir(control)).find((entry) => entry.startsWith("stale-lease-incomplete-"));
    assert.ok(replacement);
    assert.equal(await readFile(join(control, replacement, "foreign-sentinel"), "utf8"), "foreign-survives");
    const ordinaryCaller = await acquireWorkspaceLease(fixture.workspace, {
      now: instant(4),
      quarantineReplacementForTest: true,
    });
    try {
      assert.equal(isQuarantineReplacementTestInstrumentationArmed(), false);
      assert.equal(await readFile(join(attemptOwned, "attempt-entry"), "utf8"), "attempt-owned");
    } finally {
      await ordinaryCaller.release();
    }
  } finally {
    await fixture.close();
  }
});

test("quarantine replacement instrumentation is operation-local, one-shot, and cleaned after overlap", async () => {
  async function prepareStale(fixture, entry) {
    const control = join(fixture.workspace, ".tcrn-workflow");
    const leasePath = join(control, "lease");
    await mkdir(leasePath);
    await writeFile(join(leasePath, entry), "attempt-owned");
    await utimes(leasePath, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    return { control, leasePath };
  }

  async function runOverlap(ordinaryFirst) {
    const intended = await workspaceFixture({ externalKey: `WORKSPACE-INTENDED-${ordinaryFirst}` });
    const ordinary = await workspaceFixture({ externalKey: `WORKSPACE-ORDINARY-${ordinaryFirst}` });
    try {
      const intendedPaths = await prepareStale(intended, "intended-entry");
      const ordinaryPaths = await prepareStale(ordinary, "ordinary-entry");
      const intendedAttempt = join(intendedPaths.control, "attempt-owned-quarantine-for-test");
      let intendedEntered;
      const intendedAtBarrier = new Promise((resolve) => { intendedEntered = resolve; });
      let releaseIntended;
      const intendedResume = new Promise((resolve) => { releaseIntended = resolve; });
      let intendedContextVisible = false;
      let intendedOperation;
      const startIntended = () => {
        intendedOperation = withQuarantineReplacementTestInstrumentation(() => acquireWorkspaceLease(intended.workspace, {
          now: instant(3),
          async beforeClaimForTest() {
            intendedContextVisible = isQuarantineReplacementTestInstrumentationArmed();
            intendedEntered();
            await intendedResume;
          },
        }));
      };

      let ordinaryLease;
      if (ordinaryFirst) {
        let ordinaryEntered;
        const ordinaryAtBarrier = new Promise((resolve) => { ordinaryEntered = resolve; });
        let releaseOrdinary;
        const ordinaryResume = new Promise((resolve) => { releaseOrdinary = resolve; });
        const ordinaryOperation = acquireWorkspaceLease(ordinary.workspace, {
          now: instant(3),
          async beforeClaimForTest() {
            ordinaryEntered();
            await ordinaryResume;
          },
        });
        await ordinaryAtBarrier;
        startIntended();
        await intendedAtBarrier;
        releaseOrdinary();
        ordinaryLease = await ordinaryOperation;
      } else {
        startIntended();
        await intendedAtBarrier;
        ordinaryLease = await acquireWorkspaceLease(ordinary.workspace, { now: instant(3) });
      }
      try {
        assert.equal(intendedContextVisible, true);
        assert.equal(isQuarantineReplacementTestInstrumentationArmed(), false);
        assert.equal((await readdir(ordinaryPaths.control)).some((entry) => entry.startsWith("attempt-owned-") || entry.startsWith("stale-lease-")), false);
        assert.deepEqual(await readdir(ordinaryPaths.leasePath), ["owner.json"]);
      } finally {
        await ordinaryLease.release();
      }

      releaseIntended();
      await expectReasonAsync("WORKSPACE_LEASE_INVALID", () => intendedOperation);
      assert.equal(isQuarantineReplacementTestInstrumentationArmed(), false);
      assert.equal(await readFile(join(intendedAttempt, "intended-entry"), "utf8"), "attempt-owned");
      const replacement = (await readdir(intendedPaths.control)).find((entry) => entry.startsWith("stale-lease-incomplete-"));
      assert.ok(replacement);
      assert.equal(await readFile(join(intendedPaths.control, replacement, "foreign-sentinel"), "utf8"), "foreign-survives");
    } finally {
      await intended.close();
      await ordinary.close();
    }
  }

  await runOverlap(false);
  await runOverlap(true);
  await assert.rejects(withQuarantineReplacementTestInstrumentation(async () => {
    assert.equal(isQuarantineReplacementTestInstrumentationArmed(), true);
    throw new Error("private wrapper rejection");
  }), /private wrapper rejection/u);
  assert.equal(isQuarantineReplacementTestInstrumentationArmed(), false);
  await assert.rejects(withQuarantineReplacementTestInstrumentation(async () => withQuarantineReplacementTestInstrumentation(async () => {})), /nesting is unsupported/u);
  assert.equal(isQuarantineReplacementTestInstrumentationArmed(), false);
});

test("detached instrumentation descendants cannot consume closed operation capabilities", async () => {
  async function deferredConsumer({ consumeBeforeReturn = false, rejectWrapper = false } = {}) {
    let childEntered;
    const childAtBarrier = new Promise((resolve) => { childEntered = resolve; });
    let releaseChild;
    const childResume = new Promise((resolve) => { releaseChild = resolve; });
    let detached;
    const wrapper = withQuarantineReplacementTestInstrumentation(async () => {
      detached = (async () => {
        childEntered();
        await childResume;
        return consumeQuarantineReplacementTestInstrumentation();
      })();
      await childAtBarrier;
      if (consumeBeforeReturn) {
        assert.equal(consumeQuarantineReplacementTestInstrumentation(), true);
      }
      if (rejectWrapper) {
        throw new Error("wrapper closes detached capability");
      }
      return "detached-started";
    });
    if (rejectWrapper) {
      await assert.rejects(wrapper, /wrapper closes detached capability/u);
    } else {
      await wrapper;
    }
    assert.equal(isQuarantineReplacementTestInstrumentationArmed(), false);
    releaseChild();
    assert.equal(await detached, false);
    assert.equal(isQuarantineReplacementTestInstrumentationArmed(), false);
  }

  await deferredConsumer();
  await deferredConsumer({ rejectWrapper: true });
  await deferredConsumer({ consumeBeforeReturn: true });
});

test("unsafe or active recovery claims fail closed", async () => {
  const fixture = await workspaceFixture();
  try {
    const claimPath = join(fixture.workspace, ".tcrn-workflow", "lease-recovery.claim");
    await writeFile(claimPath, canonicalJson({
      schemaVersion: "tcrn.workspace-lease-recovery.v1",
      token: "a".repeat(48),
      pid: process.pid,
      acquiredAt: instant(1),
      expiresAtNanoseconds: "9999999999999999999",
    }));
    await expectReasonAsync("WORKSPACE_LOCKED", () => acquireWorkspaceLease(fixture.workspace, { now: instant(2) }));
  } finally {
    await fixture.close();
  }

  const malformedOwner = await workspaceFixture();
  try {
    const leasePath = join(malformedOwner.workspace, ".tcrn-workflow", "lease");
    await mkdir(leasePath);
    await writeFile(join(leasePath, "owner.json"), canonicalJson({ invalid: true }));
    await expectReasonAsync("WORKSPACE_LEASE_INVALID", () => acquireWorkspaceLease(malformedOwner.workspace, { now: instant(2) }));
  } finally {
    await malformedOwner.close();
  }

  for (const kind of ["symlink", "hardlink"]) {
    const unsafeOwner = await workspaceFixture();
    try {
      const leasePath = join(unsafeOwner.workspace, ".tcrn-workflow", "lease");
      await mkdir(leasePath);
      const ownerPath = join(leasePath, "owner.json");
      const backing = join(leasePath, `owner-${kind}.json`);
      await writeFile(backing, canonicalJson({
        schemaVersion: "tcrn.workspace-lease.v1",
        token: "c".repeat(48),
        pid: 999999,
        acquiredAt: "2000-01-01T00:00:00Z",
        expiresAtNanoseconds: "946684801000000000",
      }));
      if (kind === "symlink") {
        await symlink(backing, ownerPath);
      } else {
        await link(backing, ownerPath);
      }
      await expectReasonAsync("WORKSPACE_LEASE_INVALID", () => acquireWorkspaceLease(unsafeOwner.workspace, { now: instant(2) }));
    } finally {
      await unsafeOwner.close();
    }
  }

  for (const kind of ["symlink", "hardlink", "directory"]) {
    const unsafe = await workspaceFixture();
    try {
      const control = join(unsafe.workspace, ".tcrn-workflow");
      const claimPath = join(control, "lease-recovery.claim");
      const backing = join(control, `claim-${kind}.json`);
      await writeFile(backing, canonicalJson({ invalid: true }));
      if (kind === "symlink") {
        await symlink(backing, claimPath);
      } else if (kind === "hardlink") {
        await link(backing, claimPath);
      } else {
        await mkdir(claimPath);
      }
      await expectReasonAsync("WORKSPACE_LEASE_INVALID", () => acquireWorkspaceLease(unsafe.workspace, { now: instant(2) }));
    } finally {
      await unsafe.close();
    }
  }

  for (const kind of ["symlink", "hardlink", "directory"]) {
    const unsafe = await workspaceFixture();
    const lease = await acquireWorkspaceLease(unsafe.workspace, { now: instant(1) });
    try {
      const leasePath = join(unsafe.workspace, ".tcrn-workflow", "lease");
      const claimPath = join(leasePath, "mutation.claim");
      const backing = join(leasePath, `mutation-${kind}.json`);
      await writeFile(backing, canonicalJson({ invalid: true }));
      if (kind === "symlink") {
        await symlink(backing, claimPath);
      } else if (kind === "hardlink") {
        await link(backing, claimPath);
      } else {
        await mkdir(claimPath);
      }
      await expectReasonAsync("WORKSPACE_LEASE_INVALID", () => createProject(unsafe.workspace, lease, {
        expectedVersion: 0,
        occurredAt: instant(2),
        externalKey: `PROJECT-MUTATION-${kind.toUpperCase()}`,
        name: kind,
      }));
    } finally {
      await lease.release();
      await unsafe.close();
    }
  }

  for (const kind of ["malformed", "foreign-generation"]) {
    const unsafe = await workspaceFixture();
    const lease = await acquireWorkspaceLease(unsafe.workspace, { now: instant(1) });
    try {
      const claimPath = join(unsafe.workspace, ".tcrn-workflow", "lease", "mutation.claim");
      await writeFile(claimPath, canonicalJson(kind === "malformed" ? { invalid: true } : {
        schemaVersion: "tcrn.workspace-mutation-claim.v1",
        leaseToken: "f".repeat(48),
        token: "a".repeat(48),
        pid: process.pid,
      }));
      await expectReasonAsync("WORKSPACE_LEASE_INVALID", () => createProject(unsafe.workspace, lease, {
        expectedVersion: 0,
        occurredAt: instant(2),
        externalKey: `PROJECT-MUTATION-${kind.toUpperCase()}`,
        name: kind,
      }));
    } finally {
      await lease.release();
      await unsafe.close();
    }
  }

  const staleMutation = await workspaceFixture();
  try {
    const leasePath = join(staleMutation.workspace, ".tcrn-workflow", "lease");
    const leaseToken = "d".repeat(48);
    await mkdir(leasePath);
    await writeFile(join(leasePath, "owner.json"), canonicalJson({
      schemaVersion: "tcrn.workspace-lease.v1",
      token: leaseToken,
      pid: 999999,
      acquiredAt: "2000-01-01T00:00:00Z",
      expiresAtNanoseconds: "946684801000000000",
    }));
    await writeFile(join(leasePath, "mutation.claim"), canonicalJson({
      schemaVersion: "tcrn.workspace-mutation-claim.v1",
      leaseToken,
      token: "e".repeat(48),
      pid: 999999,
    }));
    const recovered = await acquireWorkspaceLease(staleMutation.workspace, { now: instant(2) });
    try {
      const state = await createProject(staleMutation.workspace, recovered, {
        expectedVersion: 0,
        occurredAt: instant(3),
        externalKey: "PROJECT-STALE-MUTATION-RECOVERED",
        name: "Recovered",
      });
      assert.equal(state.version, 1);
    } finally {
      await recovered.release();
    }
  } finally {
    await staleMutation.close();
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
