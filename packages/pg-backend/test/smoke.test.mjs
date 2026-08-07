// SPDX-License-Identifier: Apache-2.0
// STORY-175 smoke: the PG chain backend reads and writes through the
// StorageBackend interface against a live local Postgres.
//
// `pg` resolves via createRequire anchored at this package, because the engine's
// flattened dist/build tree does not carry node_modules. This is the same shape
// the facade (STORY-181-184) uses to load the PG backend outside the engine tree.
// Production is the VM's PG 18; this smoke uses the local Docker PG 16.

import assert from "node:assert/strict";
import { describe, test, before } from "node:test";
import pg from "pg";

import { canonicalJson } from "../../../dist/build/packages/protocol/src/index.js";
import { PgBackend } from "../../../dist/build/packages/pg-backend/src/index.js";

const CONNECTION = process.env.TCRN_PG_TEST_CONNECTION
  ?? "postgresql://history-user@198.51.100.1:5432/tcrn_governance";
const SCHEMA = process.env.TCRN_PG_TEST_SCHEMA ?? "chain_test_cross";

describe("STORY-175 PgBackend smoke", () => {
  // Isolate each run: the runner provisions a dedicated chain_test_* schema;
  // clear its tables before the suite so sequence-1 assertions start clean.
  before(async () => {
    const backend = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
    await backend.connect();
    try {
      await backend.clearForTest();
    } finally {
      await backend.close();
    }
  });

  test("metadata round-trips", async () => {
    const backend = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
    await backend.connect();
    try {
      const bytes = Buffer.from('{"schemaVersion":"tcrn.workspace.v1","ok":true}\n', "utf8");
      await backend.writeMetadataBytes(bytes);
      const read = await backend.readMetadataBytes();
      assert.equal(read.toString("utf8"), bytes.toString("utf8"), "metadata round-trips byte-exact");
    } finally {
      await backend.close();
    }
  });

  test("segment write/read round-trips events through the append-only trigger", async () => {
    const backend = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
    await backend.connect();
    try {
      const segment = canonicalJson([
        {
          schemaVersion: "tcrn.event.v1",
          id: "event:000000000000000000000001",
          streamId: "stream:000000000000000000000001",
          sequence: 1,
          occurredAt: "2026-08-06T00:00:00Z",
          priorHash: null,
          payload: { operation: "project.created", record: { id: "project:x" } },
          payloadHash: "a".repeat(64),
          eventHash: "b".repeat(64),
        },
      ]);
      await backend.writeSegment("000001.json", Buffer.from(segment, "utf8"));
      const names = await backend.listSegmentNames();
      assert.deepEqual(names, ["000001.json"], "segment names derive from sequence");
      const read = await backend.readSegment("000001.json");
      assert.equal(read.toString("utf8"), segment, "segment round-trips byte-exact");
    } finally {
      await backend.close();
    }
  });

  test("view write/read round-trips", async () => {
    const backend = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
    await backend.connect();
    try {
      await backend.writeView("STATUS.md", "# Workspace Status\n");
      const read = await backend.readView("STATUS.md");
      assert.equal(read.toString("utf8"), "# Workspace Status\n", "view round-trips byte-exact");
    } finally {
      await backend.close();
    }
  });

  test("append-only trigger refuses a byte-divergent re-presentation of a committed sequence", async () => {
    const backend = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
    await backend.connect();
    try {
      const event = {
        schemaVersion: "tcrn.event.v1",
        id: "event:000000000000000000000002",
        streamId: "stream:000000000000000000000001",
        sequence: 1, // same sequence as the committed event, DIFFERENT bytes
        occurredAt: "2026-08-06T00:00:00Z",
        priorHash: null,
        payload: { operation: "project.created", record: { id: "project:y" } },
        payloadHash: "c".repeat(64),
        eventHash: "d".repeat(64),
      };
      // A re-presentation with divergent bytes is a forged/forked event, not a
      // CAS race — the engine's read path would also reject it via
      // validateEventChain. The trigger's no-op check refuses it.
      let thrown = null;
      try {
        await backend.writeSegment("000001.json", Buffer.from(canonicalJson([event]), "utf8"));
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, "byte-divergent re-presentation must be refused");
      assert.equal(thrown.reasonCode, "WORKSPACE_EVENT_CORRUPT", "append-only violation maps to EVENT_CORRUPT");
    } finally {
      await backend.close();
    }
  });

  test("schema admission preserves WORKSPACE_SCHEMA_INVALID when the append-only trigger is absent", async () => {
    const raw = new pg.Client({ connectionString: CONNECTION });
    await raw.connect();
    try {
      await raw.query(`drop trigger if exists events_append_only on ${SCHEMA}.events`);
      const backend = new PgBackend({ schema: SCHEMA, connection: CONNECTION });
      try {
        await assert.rejects(
          () => backend.connect(),
          (error) => error?.reasonCode === "WORKSPACE_SCHEMA_INVALID",
        );
      } finally {
        await backend.close();
      }
    } finally {
      await raw.query(
        `create trigger events_append_only
         before insert or update or delete on ${SCHEMA}.events
         for each row execute function chain_append_only_trigger()`,
      );
      await raw.end();
    }
  });
});
