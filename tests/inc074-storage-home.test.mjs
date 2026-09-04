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
  StorageHomeError,
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
    assert.ok(
      error instanceof WorkspaceError || error instanceof StorageHomeError,
      `expected WorkspaceError or StorageHomeError, got ${String(error)}`
    );
    assert.equal(error.reasonCode, reasonCode);
    return error;
  }
  assert.fail(`expected ${reasonCode} to be raised`);
}

test("INC-074: a workspace declaring the retired PostgreSQL backend is refused (STORAGE_HOME_BACKEND_RETIRED)", async () => {
  const fixture = await workspaceFixture();
  try {
    // A normal workspace has no sentinel: the file backend writes freely.
    const sentinel = await readStorageHomeDeclaration(fixture.workspace);
    assert.equal(sentinel, null, "fresh workspace carries no storage-home sentinel");

    // Lay the sentinel the way migration-execute would have after a file→pg move.
    // The write succeeds (we just write bytes), but reading it back fails.
    await writeStorageHomeDeclaration(fixture.workspace, {
      schemaVersion: STORAGE_HOME_VERSION,
      storage: "pg",
      schema: "chain_inc074",
      workspaceId: "workspace:inc074",
      migratedAt: "2026-08-07T00:00:00.000Z",
    });

    // The PostgreSQL backend is retired (TCRN-CROSS-INC-275), so reading the
    // pg declaration fails outright, not with a schema or relocation error.
    await expectReasonAsync("STORAGE_HOME_BACKEND_RETIRED", () =>
      readStorageHomeDeclaration(fixture.workspace));

    // Any operation that tries to read the workspace also fails at the same point.
    await expectReasonAsync("STORAGE_HOME_BACKEND_RETIRED", () =>
      acquireWorkspaceLease(fixture.workspace, { now: instant(5) }));

    // Removing the sentinel (rollback) restores the workspace to usable state.
    await removeStorageHomeDeclaration(fixture.workspace);
    assert.equal(await readStorageHomeDeclaration(fixture.workspace), null);
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(6) });
    await lease.release();
  } finally {
    await fixture.close();
  }
});

test("INC-074: a workspace with retired PG backend fails to read (STORAGE_HOME_BACKEND_RETIRED), even within file-backend context", async () => {
  const fixture = await workspaceFixture();
  try {
    await writeStorageHomeDeclaration(fixture.workspace, {
      schemaVersion: STORAGE_HOME_VERSION,
      storage: "pg",
      schema: "chain_inc097",
      workspaceId: "workspace:inc097",
      migratedAt: "2026-08-07T00:00:00.000Z",
    });
    // The refusal happens at the parseDeclaration step, before backend selection.
    await assert.rejects(
      () => withStorageBackendFactory(() => new FileBackend(fixture.workspace), () => acquireWorkspaceLease(fixture.workspace, { now: instant(5) })),
      (error) => error?.reasonCode === "STORAGE_HOME_BACKEND_RETIRED",
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

test("INC-074: CLI refuses a workspace declaring the retired PostgreSQL backend (STORAGE_HOME_BACKEND_RETIRED)", async () => {
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
    // The PostgreSQL backend is retired (TCRN-CROSS-INC-275). When the CLI tries to
    // load the workspace, parseDeclaration refuses the pg storage outright.
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
    assert.ok(output.includes("STORAGE_HOME_BACKEND_RETIRED"), `expected STORAGE_HOME_BACKEND_RETIRED in ${output}`);
    assert.notEqual(exitCode, 0);
  } finally {
    await fixture.close();
  }
});

test("INC-074: sealing a PG archive fails because the backend is retired (STORAGE_HOME_BACKEND_RETIRED)", async () => {
  const fixture = await workspaceFixture();
  try {
    const declaration = {
      schemaVersion: STORAGE_HOME_VERSION,
      storage: "pg",
      schema: "chain_inc074",
      workspaceId: "workspace:inc074",
      migratedAt: "2026-08-07T00:00:00.000Z",
    };
    // sealStorageHomeDeclaration writes the declaration, then tries to read it back
    // for verification. The read-back fails with STORAGE_HOME_BACKEND_RETIRED.
    await assert.rejects(
      () => sealStorageHomeDeclaration(fixture.workspace, declaration),
      (error) => error?.reasonCode === "STORAGE_HOME_BACKEND_RETIRED",
    );
  } finally {
    await fixture.close();
  }
});
