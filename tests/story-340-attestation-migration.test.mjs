// SPDX-License-Identifier: Apache-2.0
// STORY-340: migrate legacy time-attestation files through the engine-owned
// segmented receipt backend, with a full-value readback before deletion.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ATTESTATION_MANIFEST_VERSION,
  deleteLegacyAttestations,
  migrateAttestationDirectory,
  readAttestationReceipt,
  reportAttestationDirectory,
  writeAttestationReceipt,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256, PROTOCOL_LIMITS } from "../dist/build/packages/protocol/src/index.js";

const hash = (digit) => digit.repeat(64);

function receipt(eventHash, second) {
  return canonicalJson({
    schemaVersion: "tcrn.time-attestation.v1",
    eventHash,
    observedAt: `2026-09-02T04:00:${String(second).padStart(2, "0")}Z`,
    occurredAt: `2026-09-02T03:00:${String(second).padStart(2, "0")}Z`,
  });
}

test("STORY-340 attestation migration preserves full values, supports point lookup, and deletes only after baseline proof", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s340-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, "attestations");
  await mkdir(directory);
  const values = new Map([[hash("a"), receipt(hash("a"), 1)], [hash("b"), receipt(hash("b"), 2)], [hash("c"), receipt(hash("c"), 3)]]);
  for (const [eventHash, body] of values) await writeFile(join(directory, `${eventHash}.json`), body, "utf8");

  const baseline = await reportAttestationDirectory(directory);
  assert.equal(baseline.legacyFiles, 3);
  const prepared = await migrateAttestationDirectory(directory, 4096);
  assert.equal(prepared.legacyFiles, 3, "the prepare phase keeps legacy records in place");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, ATTESTATION_MANIFEST_VERSION);
  for (const [eventHash, body] of values) assert.equal(await readAttestationReceipt(directory, eventHash), body);

  const deleted = await deleteLegacyAttestations(directory, baseline);
  assert.equal(deleted.legacyFiles, 0);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".json") && name !== "manifest.json"), []);
  for (const [eventHash, body] of values) assert.equal(await readAttestationReceipt(directory, eventHash), body);

  const nextHash = hash("d");
  await writeAttestationReceipt(directory, receipt(nextHash, 4));
  assert.equal(await readAttestationReceipt(directory, nextHash), receipt(nextHash, 4));
});

test("STORY-340 attestation migration has a fail-closed full-value comparison", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s340-value-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, "attestations");
  await mkdir(directory);
  const eventHash = hash("a");
  const original = receipt(eventHash, 1);
  await writeFile(join(directory, `${eventHash}.json`), original, "utf8");
  const baseline = await reportAttestationDirectory(directory);
  await migrateAttestationDirectory(directory, 4096);
  const deleted = await deleteLegacyAttestations(directory, baseline);
  assert.equal(deleted.legacyFiles, 0);
  assert.equal((await readdir(directory)).includes(`${eventHash}.json`), false, "legacy data is deleted only after the full-value readback passes");
  assert.equal(await readAttestationReceipt(directory, eventHash), original);
});

// TCRN-CROSS-INC-378. Every synthetic receipt carries the same two instants, so every
// line has the same length and a store can be sized to the byte. Sorting the canonical
// bodies sorts them by eventHash: they share the prefix up to the fixed-width hash.
const syntheticHash = (tag, index) => createHash("sha256").update(`${tag}:${index}`).digest("hex");
const sorted = (bodies) => [...bodies].sort();

function syntheticReceipt(eventHash) {
  return canonicalJson({
    schemaVersion: "tcrn.time-attestation.v1",
    eventHash,
    observedAt: "2026-09-23T00:00:00Z",
    occurredAt: "2026-09-22T00:00:00Z",
  });
}

async function inc378Directory(context, label) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-inc378-${label}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, "attestations");
  await mkdir(directory);
  return directory;
}

// A segmented store is built in one migration from legacy files, the way the live stores
// were built, rather than by writing receipts one at a time.
async function migratedStore(directory, bodies, segmentBytes) {
  for (const body of bodies) await writeFile(join(directory, `${JSON.parse(body).eventHash}.json`), body, "utf8");
  const baseline = await reportAttestationDirectory(directory);
  await migrateAttestationDirectory(directory, segmentBytes);
  await deleteLegacyAttestations(directory, baseline);
  return sorted(bodies);
}

async function readStore(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const segments = [];
  for (const segment of manifest.segments) {
    const content = await readFile(join(directory, segment.name));
    const index = await readFile(join(directory, segment.name.replace(/\.ndjson$/u, ".idx")));
    segments.push({ ...segment, content: content.toString("utf8"), actualBytes: content.length, indexBytes: index.length, indexKeys: Object.keys(JSON.parse(index.toString("utf8")).entries).length });
  }
  return { manifest, segments, text: segments.map((segment) => segment.content).join("") };
}

// The digest definition restated without the module: the bytes canonicalSha256 would hash
// for the record array, taken with no one-MiB ceiling.
function listDigest(bodies) {
  return createHash("sha256").update(`[${bodies.map((body) => body.slice(0, -1)).join(",")}]\n`).digest("hex");
}

async function fileDigests(directory) {
  const digests = {};
  for (const name of (await readdir(directory)).sort()) digests[name] = createHash("sha256").update(await readFile(join(directory, name))).digest("hex");
  return digests;
}

test("INC-378 a store at the edge of one canonical MiB accepts the next receipt and rolls into a second segment", async (context) => {
  const directory = await inc378Directory(context, "edge");
  const lineBytes = Buffer.byteLength(syntheticReceipt(syntheticHash("edge", 0)), "utf8");
  // The record array canonicalises to the segment bytes plus two: the brackets add two
  // bytes and the commas replace all but one LF. This is the largest store whose array
  // still fits one MiB, and one more record takes it past, which is where v1.1.2 threw.
  const edge = Math.floor((PROTOCOL_LIMITS.maxCanonicalBytes - 2) / lineBytes);
  assert.ok(edge * lineBytes + 2 <= PROTOCOL_LIMITS.maxCanonicalBytes && (edge + 1) * lineBytes + 2 > PROTOCOL_LIMITS.maxCanonicalBytes);
  const stored = await migratedStore(directory, Array.from({ length: edge }, (_, index) => syntheticReceipt(syntheticHash("edge", index))));
  assert.equal((await readStore(directory)).segments.length, 1, "the edge store is still a single segment");

  const next = syntheticReceipt(syntheticHash("edge", edge));
  await writeAttestationReceipt(directory, next);
  const expected = sorted([...stored, next]);
  const store = await readStore(directory);
  assert.equal(store.manifest.count, edge + 1);
  assert.equal(store.manifest.recordsDigest, listDigest(expected));
  assert.equal(store.text, expected.join(""), "every record reads back byte for byte and in order");
  assert.deepEqual(store.segments.map((segment) => segment.records), [edge, 1]);
  for (const body of [next, expected[0], expected.at(-1)]) assert.equal(await readAttestationReceipt(directory, JSON.parse(body).eventHash), body);
});

test("INC-378 a store smaller than one segment keeps the exact bytes the previous writer produced", async (context) => {
  const directory = await inc378Directory(context, "compat");
  const stored = await migratedStore(directory, [1, 2, 3].map((index) => syntheticReceipt(syntheticHash("compat", index))));
  const next = syntheticReceipt(syntheticHash("compat", 4));
  await writeAttestationReceipt(directory, next);
  // The previous writer restated: one segment of the sorted records, an index of their
  // offsets, and a manifest whose digest is canonicalSha256 of the record array.
  const records = sorted([...stored, next]);
  const segment = records.join("");
  const entries = {};
  let offset = 0;
  for (const body of records) {
    entries[JSON.parse(body).eventHash] = { segment: "000001.ndjson", offset, length: Buffer.byteLength(body, "utf8") };
    offset += Buffer.byteLength(body, "utf8");
  }
  const manifest = canonicalJson({
    schemaVersion: ATTESTATION_MANIFEST_VERSION,
    segments: [{ name: "000001.ndjson", bytes: Buffer.byteLength(segment, "utf8"), records: records.length, sha256: createHash("sha256").update(segment).digest("hex") }],
    count: records.length,
    recordsDigest: canonicalSha256(records.map((body) => JSON.parse(body))),
  });
  assert.equal(listDigest(records), canonicalSha256(records.map((body) => JSON.parse(body))), "below one MiB the streamed digest is canonicalSha256 of the array");
  assert.equal(await readFile(join(directory, "000001.ndjson"), "utf8"), segment);
  assert.equal(await readFile(join(directory, "000001.idx"), "utf8"), canonicalJson({ schemaVersion: "tcrn.attestation-index.v1", entries }));
  assert.equal(await readFile(join(directory, "manifest.json"), "utf8"), manifest);
  assert.deepEqual((await readdir(directory)).sort(), ["000001.idx", "000001.ndjson", "manifest.json"]);
});

test("INC-378 more than ten thousand receipts migrate and accept a write with every segment and index inside one canonical document", async (context) => {
  const directory = await inc378Directory(context, "large");
  const total = 10_050;
  const stored = await migratedStore(directory, Array.from({ length: total }, (_, index) => syntheticReceipt(syntheticHash("large", index))));
  const next = syntheticReceipt(syntheticHash("large", total));
  await writeAttestationReceipt(directory, next);
  const expected = sorted([...stored, next]);
  const store = await readStore(directory);
  assert.equal(store.manifest.count, total + 1);
  assert.equal(store.manifest.recordsDigest, listDigest(expected));
  assert.equal(store.text, expected.join(""));
  for (const segment of store.segments) {
    assert.ok(segment.actualBytes <= PROTOCOL_LIMITS.maxCanonicalBytes && segment.records <= 8_192, `${segment.name} holds at most one MiB and 8192 records`);
    assert.ok(segment.indexBytes < PROTOCOL_LIMITS.maxCanonicalBytes && segment.indexKeys <= PROTOCOL_LIMITS.maxRecords && segment.indexKeys === segment.records, `${segment.name} has an index inside one canonical document`);
  }
  for (const body of [expected[0], expected.at(-1), next]) assert.equal(await readAttestationReceipt(directory, JSON.parse(body).eventHash), body);

  // A real receipt line is about 200 bytes, so one MiB always arrives before 8,192 lines.
  // The count bound is shown with the smallest record the store accepts: 8,193 of them
  // roll over by count while the first segment is still well inside one MiB.
  const small = await inc378Directory(context, "count");
  const bodies = Array.from({ length: 8_193 }, (_, index) => canonicalJson({ eventHash: syntheticHash("count", index) }));
  await migratedStore(small, bodies);
  const counted = await readStore(small);
  assert.deepEqual(counted.segments.map((segment) => segment.records), [8_192, 1]);
  assert.ok(counted.segments[0].actualBytes + Buffer.byteLength(bodies[0], "utf8") <= PROTOCOL_LIMITS.maxCanonicalBytes, "the roll-over was by count, not by bytes");
});

test("INC-378 rewriting a multi-segment store leaves no unreferenced segment or index and never touches other files", async (context) => {
  const directory = await inc378Directory(context, "segments");
  const stored = await migratedStore(directory, Array.from({ length: 60 }, (_, index) => syntheticReceipt(syntheticHash("segments", index))), 4096);
  assert.equal((await readStore(directory)).segments.length, 3, "a 4096-byte migration leaves three segments");
  // Retired relocation verbs left receipts of their own in live attestation directories.
  // They are not part of this store (problem #208), so no rewrite may change or remove one.
  const relocationName = `${syntheticHash("relocation", 0).slice(0, 24)}-adopt.json`;
  const relocationBytes = canonicalJson({ schemaVersion: "tcrn.relocation-attestation.v1", hop: 1 });
  await writeFile(join(directory, relocationName), relocationBytes, "utf8");

  const next = syntheticReceipt(syntheticHash("segments", 60));
  await writeAttestationReceipt(directory, next);
  assert.equal((await readStore(directory)).text, sorted([...stored, next]).join(""));
  assert.deepEqual((await readdir(directory)).sort(), ["000001.idx", "000001.ndjson", "manifest.json", relocationName].sort());
  assert.equal(await readFile(join(directory, relocationName), "utf8"), relocationBytes);
});

test("INC-378 twelve writes started together in one process lose no receipt", async (context) => {
  const directory = await inc378Directory(context, "parallel");
  const stored = await migratedStore(directory, [0, 1, 2].map((index) => syntheticReceipt(syntheticHash("parallel", index))));
  const together = Array.from({ length: 12 }, (_, index) => syntheticReceipt(syntheticHash("together", index)));
  await Promise.all(together.map((body) => writeAttestationReceipt(directory, body)));
  const store = await readStore(directory);
  assert.equal(store.manifest.count, stored.length + together.length);
  assert.equal(store.text, sorted([...stored, ...together]).join(""));
  assert.deepEqual((await readdir(directory)).sort(), ["000001.idx", "000001.ndjson", "manifest.json"]);
});

test("INC-378 two processes released together lose no receipt", async (context) => {
  const directory = await inc378Directory(context, "processes");
  const stored = await migratedStore(directory, [0, 1, 2].map((index) => syntheticReceipt(syntheticHash("processes", index))));
  const writer = [
    "const [coreUrl, protocolUrl, directory, tag, count] = process.argv.slice(1);",
    "const { createHash } = await import(\"node:crypto\");",
    "const { writeAttestationReceipt } = await import(coreUrl);",
    "const { canonicalJson } = await import(protocolUrl);",
    "process.stdout.write(\"ready\\n\");",
    "await new Promise((resolve) => process.stdin.once(\"data\", resolve));",
    "for (let index = 0; index < Number(count); index += 1) {",
    "  const eventHash = createHash(\"sha256\").update(tag + \":\" + index).digest(\"hex\");",
    "  await writeAttestationReceipt(directory, canonicalJson({ schemaVersion: \"tcrn.time-attestation.v1\", eventHash, observedAt: \"2026-09-23T00:00:00Z\", occurredAt: \"2026-09-22T00:00:00Z\" }));",
    "}",
  ].join("\n");
  const coreUrl = new URL("../dist/build/packages/core/src/index.js", import.meta.url).href;
  const protocolUrl = new URL("../dist/build/packages/protocol/src/index.js", import.meta.url).href;
  const children = ["left", "right"].map((tag) => spawn(process.execPath, ["--input-type=module", "--eval", writer, coreUrl, protocolUrl, directory, tag, "20"], { stdio: ["pipe", "pipe", "inherit"] }));
  context.after(() => { for (const child of children) child.kill("SIGKILL"); });
  await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("exit", (code) => reject(new Error(`writer exited with ${code} before it was ready`)));
  })));
  const exits = children.map((child) => once(child, "exit"));
  for (const child of children) child.stdin.end("go\n");
  assert.deepEqual((await Promise.all(exits)).map(([code]) => code), [0, 0], "both writers finish cleanly");
  const written = ["left", "right"].flatMap((tag) => Array.from({ length: 20 }, (_, index) => syntheticReceipt(syntheticHash(tag, index))));
  const store = await readStore(directory);
  assert.equal(store.manifest.count, stored.length + written.length);
  assert.equal(store.text, sorted([...stored, ...written]).join(""));
});

test("INC-378 a lock held by a live process is refused without a byte changed, and a lock left by a dead process is taken over", async (context) => {
  const directory = await inc378Directory(context, "holder");
  const stored = await migratedStore(directory, [0, 1, 2].map((index) => syntheticReceipt(syntheticHash("holder", index))));
  const holder = spawn(process.execPath, ["--eval", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  context.after(() => holder.kill("SIGKILL"));
  const exited = once(holder, "exit");
  await writeFile(join(directory, "attestation.lock"), `${holder.pid}\n`, "utf8");
  const before = await fileDigests(directory);
  await assert.rejects(
    writeAttestationReceipt(directory, syntheticReceipt(syntheticHash("holder", 3)), { lockTimeoutMs: 200 }),
    (error) => error?.reasonCode === "ATTESTATION_LOCKED",
  );
  assert.deepEqual(await fileDigests(directory), before, "the refused write changed no byte, the lock included");

  holder.kill("SIGKILL");
  await exited;
  const next = syntheticReceipt(syntheticHash("holder", 4));
  await writeAttestationReceipt(directory, next, { lockTimeoutMs: 1_000 });
  assert.equal((await readStore(directory)).text, sorted([...stored, next]).join(""));
  assert.deepEqual((await readdir(directory)).sort(), ["000001.idx", "000001.ndjson", "manifest.json"], "the stale lock was taken over and released");
});
