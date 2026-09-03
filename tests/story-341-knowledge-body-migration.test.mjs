// SPDX-License-Identifier: Apache-2.0
// STORY-341: knowledge bodies are disposable and can move to segmented local storage.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileStoreBackend,
  SegmentedKnowledgeStoreBackend,
} from "../dist/build/packages/core/src/index.js";

const profile = {
  reasonCodes: {
    pathInvalid: "KNOWLEDGE_PATH_INVALID",
    linkUnsafe: "KNOWLEDGE_LINK_UNSAFE",
    specialFile: "KNOWLEDGE_SPECIAL_FILE",
    limitExceeded: "KNOWLEDGE_LIMIT_EXCEEDED",
    sourceChanged: "KNOWLEDGE_SOURCE_CHANGED",
    alreadyExists: "KNOWLEDGE_ALREADY_EXISTS",
  },
  limits: { markerBytes: 16384, metadataBytes: 65536, bodyBytes: 8192, viewBytes: 1048576, recordBytes: 0 },
};

test("STORY-341 disposable knowledge bodies migrate with byte-exact readback and point reads", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s341-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "knowledge");
  await mkdir(join(root, "bodies"), { recursive: true });
  const file = new FileStoreBackend(root, profile);
  const segmented = new SegmentedKnowledgeStoreBackend(file);
  const bodies = new Map([
    ["knowledge:aaaaaaaaaaaaaaaaaaaaaaaa", Buffer.from("first body", "utf8")],
    ["knowledge:bbbbbbbbbbbbbbbbbbbbbbbb", Buffer.from("second body", "utf8")],
  ]);
  for (const [id, body] of bodies) await file.writeKnowledgeBody(id, body);
  const migrated = await segmented.migrateKnowledgeBodies(4096);
  assert.deepEqual(migrated, { before: 2, after: 2, bodyBytes: 21 });
  const entries = await readdir(join(root, "bodies"));
  assert.ok(entries.includes("000001.ndjson"));
  assert.ok(entries.includes("000001.idx"));
  assert.ok(entries.includes("manifest.json"));
  assert.equal(entries.some((name) => name.endsWith(".body")), false);
  for (const [id, body] of bodies) assert.deepEqual(await segmented.readKnowledgeBody(id), body);
  const manifest = JSON.parse(await readFile(join(root, "bodies", "manifest.json"), "utf8"));
  assert.equal(manifest.count, bodies.size);
});

test("STORY-341 knowledge body migration is explicit and keeps metadata outside the body segments", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s341-metadata-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "knowledge");
  await mkdir(join(root, "bodies"), { recursive: true });
  await mkdir(join(root, "metadata"), { recursive: true });
  const file = new FileStoreBackend(root, profile);
  const segmented = new SegmentedKnowledgeStoreBackend(file);
  const metadata = Buffer.from("{\"id\":\"knowledge:metadata\"}\n", "utf8");
  await file.writeKnowledgeMetadata("knowledge:metadata", metadata);
  await file.writeKnowledgeBody("knowledge:metadata", Buffer.from("body", "utf8"));
  await segmented.migrateKnowledgeBodies(4096);
  assert.deepEqual(await segmented.readKnowledgeMetadata("knowledge:metadata"), metadata);
  assert.deepEqual(await segmented.readKnowledgeBody("knowledge:metadata"), Buffer.from("body", "utf8"));
  assert.equal((await readdir(join(root, "metadata"))).includes("knowledge:metadata.json"), true);
  assert.equal((await readdir(join(root, "bodies"))).some((name) => name.endsWith(".body")), false);
});
