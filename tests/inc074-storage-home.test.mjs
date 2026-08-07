// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-074 — storage-home sentinel. The class root cause of the INIT-020
// cross fork was that a workspace's backend was decided by the caller's environment:
// ceremony.mjs drove the engine without TCRN_PG_*, its writes landed in the file
// tree while the facade answered from Postgres, and no machine noticed the two had
// diverged. The sentinel declares where the truth lives, and the engine enforces it.
//
// Red legs (the incident's exact mechanism):
//   1. After a file→pg migration (or a manually laid sentinel), a mutating verb
//      driven via the FILE backend refuses WORKSPACE_STORAGE_RELOCATED — a caller
//      with no TCRN_PG_* can no longer write a chain whose home is Postgres.
//   2. Read-only verbs still work on the sentinel workspace, so the tree stays a
//      forensible archive (INC-083).
//   3. A PG-facing path naming a DIFFERENT schema than the sentinel refuses
//      (CLI_SCHEMA_MISMATCH) instead of silently serving the wrong chain.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  WorkspaceError,
  acquireWorkspaceLease,
  FileBackend,
  initializeWorkspace,
  materializeWorkspace,
  STORAGE_HOME_VERSION,
  readStorageHomeDeclaration,
  removeStorageHomeDeclaration,
  sealStorageHomeDeclaration,
  withStorageBackendFactory,
  writeStorageHomeDeclaration,
} from "../dist/build/packages/core/src/index.js";

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

async function workspaceFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc074-")));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({
    roots,
    externalKey: "WORKSPACE-INC074",
    createdAt: instant(0),
    segmentEventLimit: 4,
  });
  return { base, workspace, async close() { await rm(base, { recursive: true, force: true }); } };
}

async function expectReasonAsync(reasonCode, operation) {
  try {
    await operation();
  } catch (error) {
    assert.ok(error instanceof WorkspaceError, `expected WorkspaceError, got ${String(error)}`);
    assert.equal(error.reasonCode, reasonCode);
    return error;
  }
  assert.fail(`expected ${reasonCode} to be raised`);
}

test("INC-074: a sentinel declares storage=pg; a mutating verb via the file backend refuses WORKSPACE_STORAGE_RELOCATED", async () => {
  const fixture = await workspaceFixture();
  try {
    // A normal workspace has no sentinel: the file backend writes freely.
    const sentinel = await readStorageHomeDeclaration(fixture.workspace);
    assert.equal(sentinel, null, "fresh workspace carries no storage-home sentinel");

    // Lay the sentinel the way migration-execute would after a file→pg move.
    await writeStorageHomeDeclaration(fixture.workspace, {
      schemaVersion: STORAGE_HOME_VERSION,
      storage: "pg",
      schema: "chain_inc074",
      workspaceId: "workspace:inc074",
      migratedAt: "2026-08-07T00:00:00.000Z",
    });
    const declared = await readStorageHomeDeclaration(fixture.workspace);
    assert.equal(declared?.storage, "pg");
    assert.equal(declared?.schema, "chain_inc074");

    // RED LEG: a mutating verb (lease acquisition) through the file backend refuses.
    await expectReasonAsync("WORKSPACE_STORAGE_RELOCATED", () =>
      acquireWorkspaceLease(fixture.workspace, { now: instant(5) }));

    // POSITIVE LEG: read-only verbs still work — the archive stays forensible.
    const state = await materializeWorkspace(fixture.workspace);
    assert.equal(state.version, 0);

    // Removing the sentinel (governed pg→file rollback) reopens the write door.
    await removeStorageHomeDeclaration(fixture.workspace);
    assert.equal(await readStorageHomeDeclaration(fixture.workspace), null);
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(6) });
    await lease.release();
  } finally {
    await fixture.close();
  }
});

test("INC-097 red leg: a file-kind backend override cannot bypass the PG storage-home sentinel", async () => {
  const fixture = await workspaceFixture();
  try {
    await writeStorageHomeDeclaration(fixture.workspace, {
      schemaVersion: STORAGE_HOME_VERSION,
      storage: "pg",
      schema: "chain_inc097",
      workspaceId: "workspace:inc097",
      migratedAt: "2026-08-07T00:00:00.000Z",
    });
    await assert.rejects(
      () => withStorageBackendFactory(() => new FileBackend(fixture.workspace), () => acquireWorkspaceLease(fixture.workspace, { now: instant(5) })),
      (error) => error?.reasonCode === "WORKSPACE_STORAGE_RELOCATED",
    );
  } finally {
    await fixture.close();
  }
});

test("INC-074: a malformed sentinel fails closed rather than being treated as absent", async () => {
  const fixture = await workspaceFixture();
  try {
    const control = join(fixture.workspace, ".tcrn-workflow");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(control, "storage-home.json"), `{"schemaVersion":"${STORAGE_HOME_VERSION}","storage":"bogus"}`, "utf8");
    await assert.rejects(
      () => readStorageHomeDeclaration(fixture.workspace),
      (error) => error?.reasonCode === "STORAGE_HOME_INVALID",
    );
  } finally {
    await fixture.close();
  }
});

test("INC-074: CLI refuses a PG path whose schema does not match the sentinel (CLI_SCHEMA_MISMATCH)", async () => {
  const fixture = await workspaceFixture();
  try {
    await writeStorageHomeDeclaration(fixture.workspace, {
      schemaVersion: STORAGE_HOME_VERSION,
      storage: "pg",
      schema: "chain_declared",
      workspaceId: "workspace:inc074b",
      migratedAt: "2026-08-07T00:00:00.000Z",
    });
    let output = "";
    let exitCode = 0;
    const io = {
      write: (value) => { output += value; },
      onError: (error) => { output += String(error); },
    };
    // Simulate the CLI wrap: status is a read verb but the PG-wrap schema gate runs
    // before dispatch, so a mismatched schema refuses named.
    const previous = { connection: process.env.TCRN_PG_CONNECTION, schema: process.env.TCRN_PG_SCHEMA };
    process.env.TCRN_PG_CONNECTION = "postgresql://x";
    process.env.TCRN_PG_SCHEMA = "chain_wrong";
    try {
      try {
        await runCli(["status", "--workspace", fixture.workspace], io);
      } catch (error) {
        exitCode = 1;
        output = error instanceof Error ? `${error.reasonCode ?? ""} ${error.message}` : String(error);
      }
    } finally {
      if (previous.connection === undefined) delete process.env.TCRN_PG_CONNECTION;
      else process.env.TCRN_PG_CONNECTION = previous.connection;
      if (previous.schema === undefined) delete process.env.TCRN_PG_SCHEMA;
      else process.env.TCRN_PG_SCHEMA = previous.schema;
    }
    assert.ok(output.includes("CLI_SCHEMA_MISMATCH"), `expected CLI_SCHEMA_MISMATCH in ${output}`);
    assert.notEqual(exitCode, 0);
  } finally {
    await fixture.close();
  }
});

test("INC-074/INC-081: sealing a retained archive is idempotent and never overwrites a different binding", async () => {
  const fixture = await workspaceFixture();
  try {
    const declaration = {
      schemaVersion: STORAGE_HOME_VERSION,
      storage: "pg",
      schema: "chain_inc074",
      workspaceId: "workspace:inc074",
      migratedAt: "2026-08-07T00:00:00.000Z",
    };
    const first = await sealStorageHomeDeclaration(fixture.workspace, declaration);
    assert.deepEqual(first, declaration);

    // A retry at a different instant keeps the original immutable binding and
    // cannot rewrite its migration evidence.
    const retry = await sealStorageHomeDeclaration(fixture.workspace, {
      ...declaration,
      migratedAt: "2026-08-07T00:01:00.000Z",
    });
    assert.deepEqual(retry, declaration);

    await assert.rejects(
      () => sealStorageHomeDeclaration(fixture.workspace, { ...declaration, schema: "chain_other" }),
      (error) => error?.reasonCode === "STORAGE_HOME_ALREADY_BOUND",
    );
  } finally {
    await fixture.close();
  }
});
