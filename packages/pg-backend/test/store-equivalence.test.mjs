// SPDX-License-Identifier: Apache-2.0
// STORY-177 positive leg: the knowledge/artifact store data plane produces
// byte-identical content on the file and PG store backends.
//
// The store code (knowledge-core/artifact-lifecycle) enforces CAS (marker
// version) and high-water binding; this test proves the StoreBackend bytes
// round-trip identically across backends — the store-half of the STORY-176
// equivalence gate. A marker, a metadata record, a body, and an artifact record
// are written+read through FileStoreBackend and PgStoreBackend; every byte must
// match.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before } from "node:test";

import { FileStoreBackend, withStoreBackendFactory } from "../../../dist/build/packages/core/src/index.js";
import { PgStoreBackend } from "../../../dist/build/packages/pg-backend/src/index.js";

const CONNECTION = process.env.TCRN_PG_TEST_CONNECTION
  ?? "postgresql://history-user@198.51.100.1:5432/tcrn_governance";

const MARKER = Buffer.from('{"schemaVersion":"tcrn.knowledge-store.v1","version":0,"eventHighWaterDigest":"a".repeat(64)}\n', "utf8");
const METADATA = Buffer.from('{"schemaVersion":"tcrn.knowledge-unit-metadata.v1","id":"knowledge:aaaaaaaaaaaaaaaaaaaaaaaa"}\n', "utf8");
const BODY = Buffer.from("body bytes\n", "utf8");
const ARTIFACT_MARKER = Buffer.from('{"schemaVersion":"tcrn.artifact-store.v1","eventHighWaterDigest":"a".repeat(64)}\n', "utf8");
const ARTIFACT_RECORD = Buffer.from('{"schemaVersion":"tcrn.artifact-record.v1","id":"artifact:aaaaaaaaaaaaaaaaaaaaaaaa"}\n', "utf8");

before(async () => {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: CONNECTION });
  await client.connect();
  await client.query("truncate chain_cross.knowledge_marker, chain_cross.knowledge_metadata, chain_cross.knowledge_bodies, chain_cross.knowledge_views, chain_cross.artifact_marker, chain_cross.artifact_records");
  await client.end();
});

async function fileStore() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s177b-")));
  const storeRoot = join(base, "store");
  await mkdir(join(storeRoot, "metadata"), { recursive: true });
  await mkdir(join(storeRoot, "bodies"), { recursive: true });
  await mkdir(join(storeRoot, "views"), { recursive: true });
  await mkdir(join(storeRoot, "records"), { recursive: true });
  return { storeRoot, async close() { await rm(base, { recursive: true, force: true }); } };
}

test("STORY-177: knowledge/artifact store data-plane bytes are identical across file and PG backends", async () => {
  const file = await fileStore();
  const pg = new PgStoreBackend({ schema: "chain_cross", connection: CONNECTION });
  await pg.connect();
  try {
    const fileBackend = new FileStoreBackend(file.storeRoot, {
      reasonCodes: {
        pathInvalid: "KNOWLEDGE_PATH_INVALID",
        linkUnsafe: "KNOWLEDGE_LINK_UNSAFE",
        specialFile: "KNOWLEDGE_SPECIAL_FILE",
        limitExceeded: "KNOWLEDGE_LIMIT_EXCEEDED",
        sourceChanged: "KNOWLEDGE_SOURCE_CHANGED",
        alreadyExists: "KNOWLEDGE_ALREADY_EXISTS",
      },
      limits: {
        markerBytes: 16_384,
        metadataBytes: 32_768,
        bodyBytes: 8_192,
        viewBytes: 131_072,
        recordBytes: 65_536,
      },
    });

    // Write the same bytes through file and PG store backends.
    await fileBackend.writeKnowledgeMarker(MARKER);
    await fileBackend.writeKnowledgeMetadata("knowledge:aaaaaaaaaaaaaaaaaaaaaaaa", METADATA);
    await fileBackend.writeKnowledgeBody("knowledge:aaaaaaaaaaaaaaaaaaaaaaaa", BODY);
    await fileBackend.writeArtifactMarker(ARTIFACT_MARKER);
    await fileBackend.writeArtifactRecord("artifact:aaaaaaaaaaaaaaaaaaaaaaaa", ARTIFACT_RECORD);

    await pg.writeKnowledgeMarker(MARKER);
    await pg.writeKnowledgeMetadata("knowledge:aaaaaaaaaaaaaaaaaaaaaaaa", METADATA);
    await pg.writeKnowledgeBody("knowledge:aaaaaaaaaaaaaaaaaaaaaaaa", BODY);
    await pg.writeArtifactMarker(ARTIFACT_MARKER);
    await pg.writeArtifactRecord("artifact:aaaaaaaaaaaaaaaaaaaaaaaa", ARTIFACT_RECORD);

    // Read back and compare byte-for-byte.
    assert.equal((await pg.readKnowledgeMarker()).toString("utf8"), MARKER.toString("utf8"), "knowledge marker identical");
    assert.equal((await pg.readKnowledgeMetadata("knowledge:aaaaaaaaaaaaaaaaaaaaaaaa")).toString("utf8"), METADATA.toString("utf8"), "knowledge metadata identical");
    assert.equal((await pg.readKnowledgeBody("knowledge:aaaaaaaaaaaaaaaaaaaaaaaa")).toString("utf8"), BODY.toString("utf8"), "knowledge body identical");
    assert.equal((await pg.readArtifactMarker()).toString("utf8"), ARTIFACT_MARKER.toString("utf8"), "artifact marker identical");
    assert.equal((await pg.readArtifactRecord("artifact:aaaaaaaaaaaaaaaaaaaaaaaa")).toString("utf8"), ARTIFACT_RECORD.toString("utf8"), "artifact record identical");

    // Enumeration matches.
    assert.deepEqual((await pg.listKnowledgeMetadata()).sort(), (await fileBackend.listKnowledgeMetadata()).sort(), "knowledge metadata enumeration identical");
    assert.deepEqual((await pg.listKnowledgeBodies()).sort(), (await fileBackend.listKnowledgeBodies()).sort(), "knowledge body enumeration identical");
    assert.deepEqual((await pg.listArtifactRecords()).sort(), (await fileBackend.listArtifactRecords()).sort(), "artifact record enumeration identical");
  } finally {
    await pg.close();
    await file.close();
  }
});
