// SPDX-License-Identifier: Apache-2.0
// STORY-177 — the Postgres store backend for the knowledge/artifact stores.
//
// Implements StoreBackend (packages/core/src/store-backend.ts) over the chain
// schema's store tables, so the two stores' full verb set can run against PG
// with byte-identical results to the file store (the STORY-176 equivalence
// gate, extended to the two stores per STORY-177's positive leg).
//
// The CAS semantics are preserved by the store logic (knowledge CAS uses the
// store marker's version, high-water binds the chain head) — this backend only
// moves the bytes; it does not change what the store code enforces.

import { StoreBackendError } from "../../core/src/index.js";
import type { StoreBackend } from "../../core/src/index.js";
import pg from "pg";

function mapError(error: unknown): never {
  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message ?? String(error);
  switch (code) {
    case "42501":
      throw new StoreBackendError("KNOWLEDGE_PATH_INVALID", `permission denied: ${message}`);
    case "08001":
    case "08006":
    case "57P03":
      throw new StoreBackendError("KNOWLEDGE_LIMIT_EXCEEDED", `pg unreachable: ${message}`);
    default:
      throw new StoreBackendError("KNOWLEDGE_PARTIAL_STATE", `pg error ${code ?? "unknown"}: ${message}`);
  }
}

export class PgStoreBackend implements StoreBackend {
  private readonly client: pg.Client;
  private readonly schema: string;

  constructor(options: { schema: string; connection: string }) {
    this.schema = options.schema;
    this.client = new pg.Client({ connectionString: options.connection });
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      mapError(error);
    }
  }

  async close(): Promise<void> {
    await this.client.end().catch(() => {});
  }

  private table(name: string): string {
    return `${this.schema}.${name}`;
  }

  private async readSingle(table: string, label: string): Promise<Buffer> {
    try {
      const { rows } = await this.client.query(`select bytes from ${this.table(table)} where id = 1`);
      const row = rows[0];
      if (!row?.bytes) {
        throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", `${label} missing`);
      }
      return Buffer.from(row.bytes as Buffer);
    } catch (error) {
      if (error instanceof StoreBackendError) throw error;
      mapError(error);
    }
  }

  private async writeSingle(table: string, bytes: Buffer | string): Promise<void> {
    try {
      await this.client.query(
        `insert into ${this.table(table)} (id, bytes) values (1, $1)
         on conflict (id) do update set bytes = excluded.bytes`,
        [Buffer.from(bytes)],
      );
    } catch (error) {
      mapError(error);
    }
  }

  private async listIds(table: string): Promise<string[]> {
    try {
      const { rows } = await this.client.query(`select id from ${this.table(table)} order by id`);
      return rows.map((row) => row.id as string);
    } catch (error) {
      mapError(error);
    }
  }

  private async readKeyed(table: string, id: string): Promise<Buffer> {
    try {
      const { rows } = await this.client.query(`select bytes from ${this.table(table)} where id = $1`, [id]);
      const row = rows[0];
      if (!row?.bytes) {
        throw new StoreBackendError("KNOWLEDGE_NOT_FOUND", `${table}:${id}`);
      }
      return Buffer.from(row.bytes as Buffer);
    } catch (error) {
      if (error instanceof StoreBackendError) throw error;
      mapError(error);
    }
  }

  private async writeKeyed(table: string, id: string, bytes: Buffer | string): Promise<void> {
    try {
      await this.client.query(
        `insert into ${this.table(table)} (id, bytes) values ($1, $2)
         on conflict (id) do update set bytes = excluded.bytes`,
        [id, Buffer.from(bytes)],
      );
    } catch (error) {
      mapError(error);
    }
  }

  // knowledge marker
  async readKnowledgeMarker(): Promise<Buffer> {
    return this.readSingle("knowledge_marker", "knowledge marker");
  }
  async writeKnowledgeMarker(bytes: Buffer | string): Promise<void> {
    await this.writeSingle("knowledge_marker", bytes);
  }
  // knowledge metadata
  async listKnowledgeMetadata(): Promise<string[]> {
    const ids = await this.listIds("knowledge_metadata");
    return ids.map((id) => `${id}.json`);
  }
  async readKnowledgeMetadata(id: string): Promise<Buffer> {
    return this.readKeyed("knowledge_metadata", id);
  }
  async writeKnowledgeMetadata(id: string, bytes: Buffer | string): Promise<void> {
    await this.writeKeyed("knowledge_metadata", id, bytes);
  }
  // knowledge bodies
  async listKnowledgeBodies(): Promise<string[]> {
    const ids = await this.listIds("knowledge_bodies");
    return ids.map((id) => `${id}.body`);
  }
  async readKnowledgeBody(id: string): Promise<Buffer> {
    return this.readKeyed("knowledge_bodies", id);
  }
  async writeKnowledgeBody(id: string, bytes: Buffer | string): Promise<void> {
    await this.writeKeyed("knowledge_bodies", id, bytes);
  }
  // knowledge views
  async readKnowledgeView(): Promise<Buffer> {
    return this.readSingle("knowledge_views", "knowledge view");
  }
  async writeKnowledgeView(bytes: Buffer | string): Promise<void> {
    await this.writeSingle("knowledge_views", bytes);
  }
  // artifact marker
  async readArtifactMarker(): Promise<Buffer> {
    return this.readSingle("artifact_marker", "artifact marker");
  }
  async writeArtifactMarker(bytes: Buffer | string): Promise<void> {
    await this.writeSingle("artifact_marker", bytes);
  }
  // artifact records
  async listArtifactRecords(): Promise<string[]> {
    const ids = await this.listIds("artifact_records");
    return ids.map((id) => `${id}.json`);
  }
  async readArtifactRecord(id: string): Promise<Buffer> {
    return this.readKeyed("artifact_records", id);
  }
  async writeArtifactRecord(id: string, bytes: Buffer | string): Promise<void> {
    await this.writeKeyed("artifact_records", id, bytes);
  }
}
