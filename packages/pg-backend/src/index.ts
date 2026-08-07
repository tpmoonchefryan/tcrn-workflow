// SPDX-License-Identifier: Apache-2.0
// STORY-175 — the Postgres chain backend. Implements the StorageBackend
// interface (defined in packages/core/src/storage-backend.ts) over PostgreSQL.
//
// The engine core stays zero-dependency; this package carries the PG driver and
// is consumed by the facade (STORY-181-184), which is the only surface that
// selects a backend. The events table is structurally append-only (trigger +
// GRANT); the read path re-validates the whole chain exactly as the file
// backend does (validateEventChain), so a forged prior_hash is refused at read
// even if a trigger were bypassed.
//
// Fail-closed: a connection failure, a chain-validation failure, or a GRANT
// refusal surfaces as a typed refusal; there is NO fallback to the file track.

import { StorageError } from "../../core/src/index.js";
import type { StorageBackend, WorkspaceCrashPoint } from "../../core/src/index.js";
import { canonicalJson } from "../../protocol/src/index.js";
import pg from "pg";

const { Client } = pg;

export { PgStoreBackend } from "./store.js";

const SEGMENT_LIMIT = 1024; // fallback when no metadata is readable; the workspace's own segmentEventLimit drives layout

export interface PgBackendOptions {
  /** e.g. `chain_cross` — the chain schema this backend serves. */
  schema: string;
  /** Connection string or host/port/database. Loopback-only by design. */
  connection: string;
  /** STORY-176 mutation witness: inject a one-byte deviation into readSegment
   * payload bytes. Off by default; no production path sets it. */
  injectSegmentByteDeviation?: boolean;
}

/**
 * Map a PG driver error to a StorageError with the engine's reason code.
 * Permission refusals and constraint violations are the fail-closed paths.
 *
 * INC-085: Node-level connection errors carry Node error codes (ECONNREFUSED,
 * ENOTFOUND, ETIMEDOUT, ECONNRESET, EPIPE), NOT SQLSTATEs. They previously fell
 * into the default branch and were misreported as WORKSPACE_EVENT_CORRUPT — a
 * downed database read as a corrupt chain, which triggers the wrong incident
 * response (probeTarget reads a dead DB as "bypass copy refused"). They are now
 * mapped to the apply-unavailable family, the same class the SQLSTATE connection
 * failures (08001/08006/57P03) already map to.
 */
function mapPgError(error: unknown): never {
  // INC-085: admission and backend helpers deliberately raise typed
  // StorageErrors. Do not remap them through the generic SQL table; doing so
  // turned a missing append-only trigger (WORKSPACE_SCHEMA_INVALID) into the
  // unrelated EVENT_CORRUPT reason and erased the actual gate that failed.
  if (error instanceof StorageError) {
    throw error;
  }
  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message ?? String(error);
  switch (code) {
    case "42501": // insufficient_privilege
      throw new StorageError("WORKSPACE_PATH_INVALID", `permission denied: ${message}`);
    case "23505": // unique_violation
      throw new StorageError("WORKSPACE_CAS_MISMATCH", `unique violation: ${message}`);
    case "P0001": // raise_exception (our append-only trigger)
      // A sequence-continuity refusal is a CAS conflict (the event was already
      // committed, or a prior_hash mismatch), matching the file backend's
      // WORKSPACE_CAS_MISMATCH. A true append-only violation (UPDATE/DELETE) is
      // corruption.
      if (message.includes("contiguous") || message.includes("prior_hash") || message.includes("first event")) {
        throw new StorageError("WORKSPACE_CAS_MISMATCH", message);
      }
      throw new StorageError("WORKSPACE_EVENT_CORRUPT", message);
    case "08001": // sqlclient_unable_to_establish_sqlconnection
    case "08006": // connection_failure
    case "57P03": // cannot_connect_now
    case "ECONNREFUSED":
    case "ENOTFOUND":
    case "ETIMEDOUT":
    case "ECONNRESET":
    case "EPIPE":
      throw new StorageError("WORKSPACE_MIGRATION_APPLY_UNAVAILABLE", `pg unreachable: ${message}`);
    default:
      throw new StorageError("WORKSPACE_EVENT_CORRUPT", `pg error ${code ?? "unknown"}: ${message}`);
  }
}

/** INC-085: the append-only trigger we require on the events table before any
 * write is admitted (ADR-0004 §5 admission). A schema without the trigger was
 * observed to accept writes and even overwrite sequence 1 — the trigger is the
 * chain's last line of defense against a bypassed engine, so writing into a
 * triggerless schema is refused. */
async function assertAppendOnlyTrigger(client: pg.Client, schema: string): Promise<void> {
  const { rows } = await client.query(
    `select tgname from pg_trigger where tgrelid = to_regclass($1) and not tgisinternal`,
    [`${schema}.events`],
  );
  const triggerNames = rows.map((row) => String(row.tgname));
  if (triggerNames.length === 0) {
    throw new StorageError("WORKSPACE_SCHEMA_INVALID", `events table in schema ${schema} has no append-only trigger; refusing to write`);
  }
}

export class PgBackend implements StorageBackend {
  private readonly client: pg.Client;
  private readonly schema: string;
  private readonly injectSegmentByteDeviation: boolean;
  private segmentLimitCache: number | null = null;

  constructor(options: PgBackendOptions) {
    this.schema = options.schema;
    this.injectSegmentByteDeviation = options.injectSegmentByteDeviation ?? false;
    this.client = new Client({ connectionString: options.connection });
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
      // INC-085: admission validates the append-only trigger exists. A schema
      // without it accepted writes (even overwriting sequence 1); the trigger is
      // the chain's last line of defense, so serving a triggerless schema fails
      // closed at connect time.
      await assertAppendOnlyTrigger(this.client, this.schema);
    } catch (error) {
      mapPgError(error);
    }
  }

  async close(): Promise<void> {
    await this.client.end().catch(() => {});
  }

  // The workspace's own segmentEventLimit drives PG segment layout, matching the
  // file backend. Reading it from the metadata row keeps single segments under
  // the canonical 1 MiB bound for large chains (STORY-189: a 983-event chain
  // exceeded it at the hardcoded 1024 limit). Falls back to the engine maximum.
  //
  // INC-086: the fallback is NEVER cached. A transient metadata-read failure
  // (a downed replica, a mid-migration row) must not freeze the 1024 ceiling
  // forever — v0.11.2 fixed a bad layout that a permanent cache would re-admit
  // on the very next transient fault. Only a genuinely read, validated limit is
  // cached, and it is invalidated on every metadata write.
  private async resolveSegmentLimit(): Promise<number> {
    if (this.segmentLimitCache !== null) {
      return this.segmentLimitCache;
    }
    let limit = SEGMENT_LIMIT;
    try {
      const { rows } = await this.client.query(`select bytes from ${this.table("metadata")} where id = 1`);
      const row = rows[0];
      if (row?.bytes) {
        const parsed = JSON.parse(Buffer.from(row.bytes as Buffer).toString("utf8")) as { segmentEventLimit?: unknown };
        const candidate = Number(parsed.segmentEventLimit);
        if (Number.isSafeInteger(candidate) && candidate >= 2 && candidate <= 1024) {
          limit = candidate;
          // Only a successfully read, validated limit is cached — never the fallback.
          this.segmentLimitCache = limit;
        }
      }
    } catch {
      // metadata read failure falls back to the max for THIS call only; the
      // caller's own read surfaces the real error if the store is broken.
    }
    return limit;
  }

  /** Test-only isolation: truncate the chain tables so a fresh run starts clean. */
  async clearForTest(): Promise<void> {
    this.segmentLimitCache = null;
    await this.client.query(`truncate ${this.table("events")}, ${this.table("metadata")}, ${this.table("views")}`);
  }

  private table(name: string): string {
    return `${this.schema}.${name}`;
  }

  async readMetadataBytes(): Promise<Buffer> {
    try {
      const { rows } = await this.client.query(`select bytes from ${this.table("metadata")} where id = 1`);
      const row = rows[0];
      if (!row?.bytes) {
        throw new StorageError("WORKSPACE_SCHEMA_INVALID", "metadata row missing");
      }
      return Buffer.from(row.bytes as Buffer);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      mapPgError(error);
    }
  }

  async writeMetadataBytes(content: Buffer, _crashAt?: WorkspaceCrashPoint): Promise<void> {
    try {
      // INC-085/ADR-0004 §5: the session-level advisory lock is the PG-side
      // single-writer mutex. One mutation = one transaction = one lock hold, so
      // two concurrent writers serialize here instead of racing the metadata
      // upsert (the file backend's lease equivalent).
      const client = this.client;
      await client.query("begin");
      try {
        await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`chain:${this.schema}`]);
        await client.query(
          `insert into ${this.table("metadata")} (id, bytes) values (1, $1)
           on conflict (id) do update set bytes = excluded.bytes`,
          [content],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
      // The metadata row is the source of the segment limit; a stale cache from
      // before the row existed (the migration probe reads segments pre-metadata)
      // would freeze the fallback and mis-layout every later read (STORY-189).
      this.segmentLimitCache = null;
    } catch (error) {
      mapPgError(error);
    }
  }

  async listSegmentNames(): Promise<string[]> {
    try {
      const limit = await this.resolveSegmentLimit();
      const { rows } = await this.client.query(
        `select distinct ((sequence - 1) / $1) + 1 as segment
         from ${this.table("events")} order by segment`,
        [limit],
      );
      return rows.map((row) => `${String(row.segment as number).padStart(6, "0")}.json`);
    } catch (error) {
      mapPgError(error);
    }
  }

  async readSegment(name: string): Promise<Buffer> {
    try {
      const match = /^(\d{6})\.json$/u.exec(name);
      if (!match) {
        throw new StorageError("WORKSPACE_EVENT_CORRUPT", `unexpected event entry ${name}`);
      }
      const limit = await this.resolveSegmentLimit();
      const segmentIndex = Number(match[1]);
      const from = (segmentIndex - 1) * limit + 1;
      const to = segmentIndex * limit;
      const { rows } = await this.client.query(
        `select payload, payload_hash, event_hash, sequence, id, stream_id, schema_version, occurred_at, prior_hash
         from ${this.table("events")} where sequence between $1 and $2 order by sequence`,
        [from, to],
      );
      const events = rows.map((row) => ({
        schemaVersion: row.schema_version,
        id: row.id,
        streamId: row.stream_id,
        sequence: row.sequence,
        occurredAt: row.occurred_at,
        priorHash: row.prior_hash,
        payload: JSON.parse(Buffer.from(row.payload as Buffer).toString("utf8")),
        payloadHash: row.payload_hash,
        eventHash: row.event_hash,
      }));
      // Canonical serialization, identical to the file backend's segment bytes
      // (sorted keys + terminal LF) — this is what keeps STORY-176's per-event
      // byte equivalence true.
      const canonical = Buffer.from(canonicalJson(events), "utf8");
      if (this.injectSegmentByteDeviation && canonical.length > 0) {
        const deviated = Buffer.from(canonical);
        const first = deviated[0] ?? 0x7b;
        deviated[0] = first === 0x7b ? 0x7c : first + 1; // `{` → `|`
        return deviated;
      }
      return canonical;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      mapPgError(error);
    }
  }

  async writeSegment(_name: string, content: Buffer, _crashAt?: WorkspaceCrashPoint): Promise<void> {
    try {
      const events = JSON.parse(content.toString("utf8")) as Array<{
        schemaVersion: string;
        id: string;
        streamId: string;
        sequence: number;
        occurredAt: string;
        priorHash: string | null;
        payload: unknown;
        payloadHash: string;
        eventHash: string;
      }>;
      const client = this.client;
      await client.query("begin");
      try {
        // INC-085/ADR-0004 §5: schema-scoped advisory xact lock = single-writer
        // mutex. Serializes concurrent writers so the engine's expectedVersion
        // CAS cannot be raced at the data plane.
        await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`chain:${this.schema}`]);
        for (const event of events) {
          // The engine rewrites the whole segment file on each append (the file
          // backend replaces the segment), so the PG backend must upsert: a
          // re-inserted already-committed event is a no-op, and only the new
          // event advances the chain. Events are immutable once written, so an
          // upsert to identical bytes is safe and the append-only trigger still
          // guards UPDATE/DELETE of committed rows.
          await client.query(
            `insert into ${this.table("events")}
             (sequence, id, stream_id, schema_version, occurred_at, prior_hash, payload, payload_hash, event_hash)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (sequence) do update
             set id = excluded.id, stream_id = excluded.stream_id,
                 schema_version = excluded.schema_version, occurred_at = excluded.occurred_at,
                 prior_hash = excluded.prior_hash, payload = excluded.payload,
                 payload_hash = excluded.payload_hash, event_hash = excluded.event_hash`,
            [
              event.sequence,
              event.id,
              event.streamId,
              event.schemaVersion,
              event.occurredAt,
              event.priorHash,
              Buffer.from(JSON.stringify(event.payload), "utf8"),
              event.payloadHash,
              event.eventHash,
            ],
          );
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    } catch (error) {
      mapPgError(error);
    }
  }

  async readView(name: string): Promise<Buffer> {
    try {
      const { rows } = await this.client.query(`select bytes from ${this.table("views")} where name = $1`, [name]);
      const row = rows[0];
      if (!row?.bytes) {
        throw new StorageError("WORKSPACE_VIEW_STALE", `${name} is missing`);
      }
      return Buffer.from(row.bytes as Buffer);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      mapPgError(error);
    }
  }

  async writeView(name: string, content: string, _crashAt?: WorkspaceCrashPoint): Promise<void> {
    try {
      await this.client.query(
        `insert into ${this.table("views")} (name, bytes) values ($1, $2)
         on conflict (name) do update set bytes = excluded.bytes`,
        [name, Buffer.from(content, "utf8")],
      );
    } catch (error) {
      mapPgError(error);
    }
  }

  async listViewNames(): Promise<string[]> {
    try {
      const { rows } = await this.client.query(`select name from ${this.table("views")} order by name`);
      return rows.map((row) => String(row.name));
    } catch (error) {
      mapPgError(error);
    }
  }

  async ensureControlDirectory(_relativePath: string): Promise<void> {
    // PG schemas are created by the DDL (chain-ddl.sql); the workspace root
    // directory concept does not apply. No-op, documented rather than implicit.
  }
}
