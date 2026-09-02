// SPDX-License-Identifier: Apache-2.0
// INIT-048 / STORY-340: local time-attestation receipts. Legacy receipts remain
// readable until the migration's delete step; once a directory has a manifest,
// new receipts use the same segmented NDJSON/index layout.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { assertCanonicalJson, canonicalJson, canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";

export const ATTESTATION_MANIFEST_VERSION = "tcrn.attestation-manifest.v1" as const;
export const ATTESTATION_INDEX_VERSION = "tcrn.attestation-index.v1" as const;
export const ATTESTATION_SEGMENT_BYTES = 16_777_216 as const;

export interface AttestationFileRecord {
  readonly name: string;
  readonly bytes: Buffer;
  readonly value: Readonly<Record<string, JsonValue>>;
}

export interface AttestationDirectoryReport {
  readonly legacyFiles: number;
  readonly legacyBytes: number;
  readonly recordsDigest: string;
  readonly records: readonly string[];
}

interface AttestationLocation {
  readonly segment: string;
  readonly offset: number;
  readonly length: number;
}

interface AttestationManifestSegment {
  readonly name: string;
  readonly bytes: number;
  readonly records: number;
  readonly sha256: string;
}

interface AttestationManifest {
  readonly schemaVersion: typeof ATTESTATION_MANIFEST_VERSION;
  readonly segments: readonly AttestationManifestSegment[];
  readonly count: number;
  readonly recordsDigest: string;
}

let temporarySequence = 0;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function legacyName(name: string): boolean {
  return /^[a-f0-9]{64}\.json$/u.test(name);
}

function segmentName(index: number): string {
  return `${String(index).padStart(6, "0")}.ndjson`;
}

function indexName(index: number): string {
  return `${String(index).padStart(6, "0")}.idx`;
}

function manifestPath(directory: string): string {
  return resolve(directory, "manifest.json");
}

async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = resolve(parent, `.tmp-${process.pid}-${temporarySequence += 1}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directoryHandle = await open(parent, constants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function readLegacy(directory: string): Promise<readonly AttestationFileRecord[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const records: AttestationFileRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !legacyName(entry.name)) continue;
    const bytes = await readFile(resolve(directory, entry.name));
    const value = assertCanonicalJson(bytes.toString("utf8"));
    if (!isObject(value)) throw new Error(`ATTESTATION_RECORD_INVALID: ${entry.name}`);
    records.push({ name: entry.name, bytes, value });
  }
  return records.sort((left, right) => compareCanonicalText(left.name, right.name));
}

async function readManifest(directory: string): Promise<AttestationManifest | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(manifestPath(directory));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  const value = assertCanonicalJson(bytes.toString("utf8"));
  const manifest = isObject(value) ? value as Readonly<Record<string, unknown>> : null;
  if (manifest === null || manifest.schemaVersion !== ATTESTATION_MANIFEST_VERSION || !Array.isArray(manifest.segments) ||
    !Number.isSafeInteger(manifest.count) || Number(manifest.count) < 0 || typeof manifest.recordsDigest !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.recordsDigest)) {
    throw new Error("ATTESTATION_MANIFEST_INVALID");
  }
  const segments: AttestationManifestSegment[] = [];
  for (const rawSegment of manifest.segments) {
    const segment = isObject(rawSegment) ? rawSegment as Readonly<Record<string, unknown>> : null;
    if (segment === null || typeof segment.name !== "string" || !/^\d{6}\.ndjson$/u.test(segment.name) ||
      !Number.isSafeInteger(segment.bytes) || !Number.isSafeInteger(segment.records) || typeof segment.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(segment.sha256)) {
      throw new Error("ATTESTATION_MANIFEST_INVALID");
    }
    segments.push({ name: segment.name, bytes: Number(segment.bytes), records: Number(segment.records), sha256: segment.sha256 });
  }
  return { schemaVersion: ATTESTATION_MANIFEST_VERSION, segments, count: Number(manifest.count), recordsDigest: manifest.recordsDigest };
}

async function readSegmentRecords(directory: string, manifest: AttestationManifest): Promise<readonly AttestationFileRecord[]> {
  const records: AttestationFileRecord[] = [];
  for (const segment of manifest.segments) {
    const bytes = await readFile(resolve(directory, segment.name));
    if (bytes.length !== segment.bytes || sha256(bytes) !== segment.sha256 || !bytes.toString("utf8").endsWith("\n")) {
      throw new Error(`ATTESTATION_SEGMENT_INVALID: ${segment.name}`);
    }
    let offset = 0;
    for (const line of bytes.toString("utf8").split("\n").slice(0, -1)) {
      const value = assertCanonicalJson(`${line}\n`);
      if (!isObject(value) || typeof value.eventHash !== "string") throw new Error(`ATTESTATION_RECORD_INVALID: ${segment.name}`);
      const length = Buffer.byteLength(`${line}\n`, "utf8");
      records.push({ name: `${value.eventHash}.json`, bytes: Buffer.from(line, "utf8"), value });
      offset += length;
    }
    void offset;
  }
  if (records.length !== manifest.count || canonicalSha256(records.map((record) => record.value)) !== manifest.recordsDigest) {
    throw new Error("ATTESTATION_MANIFEST_INVALID");
  }
  return records;
}

function recordsDigest(records: readonly AttestationFileRecord[]): string {
  return canonicalSha256(records.map((record) => record.value));
}

export async function reportAttestationDirectory(directory: string): Promise<AttestationDirectoryReport> {
  const records = await readLegacy(directory);
  return {
    legacyFiles: records.length,
    legacyBytes: records.reduce((total, record) => total + record.bytes.length, 0),
    recordsDigest: recordsDigest(records),
    records: records.map((record) => record.name),
  };
}

export async function migrateAttestationDirectory(directory: string, segmentBytes = ATTESTATION_SEGMENT_BYTES): Promise<AttestationDirectoryReport> {
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 4096) throw new Error("ATTESTATION_SEGMENT_BYTES_INVALID");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existingManifest = await readManifest(directory);
  const records = existingManifest === null ? await readLegacy(directory) : await readSegmentRecords(directory, existingManifest);
  const chunks: AttestationFileRecord[][] = [];
  let chunk: AttestationFileRecord[] = [];
  let bytes = 0;
  for (const record of records) {
    const lineBytes = Buffer.byteLength(canonicalJson(record.value), "utf8");
    if (chunk.length > 0 && bytes + lineBytes > segmentBytes) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(record);
    bytes += lineBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  const manifestSegments: AttestationManifestSegment[] = [];
  for (const [index, part] of chunks.entries()) {
    const content = Buffer.from(part.map((record) => canonicalJson(record.value)).join(""), "utf8");
    await atomicWrite(resolve(directory, segmentName(index + 1)), content);
    const locations: Record<string, AttestationLocation> = {};
    let offset = 0;
    for (const record of part) {
      const length = Buffer.byteLength(canonicalJson(record.value), "utf8");
      locations[record.value.eventHash as string] = { segment: segmentName(index + 1), offset, length };
      offset += length;
    }
    await atomicWrite(resolve(directory, indexName(index + 1)), canonicalJson({ schemaVersion: ATTESTATION_INDEX_VERSION, entries: locations }));
    manifestSegments.push({ name: segmentName(index + 1), bytes: content.length, records: part.length, sha256: sha256(content) });
  }
  await atomicWrite(manifestPath(directory), canonicalJson({ schemaVersion: ATTESTATION_MANIFEST_VERSION, segments: manifestSegments, count: records.length, recordsDigest: recordsDigest(records) }));
  return reportAttestationDirectory(directory);
}

export async function readAttestationReceipt(directory: string, eventHash: string): Promise<string> {
  if (!/^[a-f0-9]{64}\.json$/u.test(`${eventHash}.json`)) throw new Error("ATTESTATION_KEY_INVALID");
  const manifest = await readManifest(directory);
  if (manifest === null) return (await readFile(resolve(directory, `${eventHash}.json`))).toString("utf8");
  for (const segment of manifest.segments) {
    const indexValue = assertCanonicalJson((await readFile(resolve(directory, segment.name.replace(/\.ndjson$/u, ".idx")))).toString("utf8"));
    const index = isObject(indexValue) ? indexValue as Readonly<Record<string, unknown>> : null;
    const entries = index !== null && isObject(index.entries as JsonValue | undefined) ? index.entries as Readonly<Record<string, JsonValue>> : null;
    if (index === null || index.schemaVersion !== ATTESTATION_INDEX_VERSION || entries === null) throw new Error("ATTESTATION_INDEX_INVALID");
    const rawLocation = entries[eventHash];
    const locationValue = isObject(rawLocation) ? rawLocation as Readonly<Record<string, unknown>> : null;
    if (locationValue === null || typeof locationValue.segment !== "string" || locationValue.segment !== segment.name ||
      !Number.isSafeInteger(locationValue.offset) || !Number.isSafeInteger(locationValue.length) || Number(locationValue.offset) < 0 || Number(locationValue.length) < 1) continue;
    const bytes = await readFile(resolve(directory, segment.name));
    const line = bytes.subarray(Number(locationValue.offset), Number(locationValue.offset) + Number(locationValue.length)).toString("utf8");
    const value = assertCanonicalJson(line);
    if (!isObject(value) || value.eventHash !== eventHash) throw new Error("ATTESTATION_INDEX_INVALID");
    return canonicalJson(value);
  }
  throw new Error(`ATTESTATION_NOT_FOUND: ${eventHash}`);
}

export async function deleteLegacyAttestations(directory: string, baseline: AttestationDirectoryReport): Promise<AttestationDirectoryReport> {
  const current = await reportAttestationDirectory(directory);
  if (current.legacyFiles !== baseline.legacyFiles || current.legacyBytes !== baseline.legacyBytes || current.recordsDigest !== baseline.recordsDigest || canonicalJson(current.records) !== canonicalJson(baseline.records)) {
    throw new Error("ATTESTATION_BASELINE_MISMATCH");
  }
  const manifest = await readManifest(directory);
  if (manifest === null || manifest.count !== current.legacyFiles || manifest.recordsDigest !== current.recordsDigest) throw new Error("ATTESTATION_MIGRATION_UNVERIFIED");
  const migrated = await readSegmentRecords(directory, manifest);
  if (canonicalJson(migrated.map((record) => record.value)) !== canonicalJson((await readLegacy(directory)).map((record) => record.value))) throw new Error("ATTESTATION_VALUE_MISMATCH");
  for (const name of current.records) await rm(resolve(directory, name));
  return { legacyFiles: 0, legacyBytes: 0, recordsDigest: current.recordsDigest, records: [] };
}

export async function writeAttestationReceipt(directory: string, receipt: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const value = assertCanonicalJson(receipt);
  if (!isObject(value) || typeof value.eventHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.eventHash)) throw new Error("ATTESTATION_RECORD_INVALID");
  const manifest = await readManifest(directory);
  if (manifest === null) {
    await atomicWrite(resolve(directory, `${value.eventHash}.json`), receipt);
    return;
  }
  const records = [...await readSegmentRecords(directory, manifest), { name: `${value.eventHash}.json`, bytes: Buffer.from(receipt, "utf8"), value }]
    .sort((left, right) => compareCanonicalText(left.name, right.name));
  const chunks: AttestationFileRecord[][] = [records];
  const content = Buffer.from(chunks[0]!.map((record) => canonicalJson(record.value)).join(""), "utf8");
  await atomicWrite(resolve(directory, segmentName(1)), content);
  const locations: Record<string, AttestationLocation> = {};
  let offset = 0;
  for (const record of records) {
    const length = Buffer.byteLength(canonicalJson(record.value), "utf8");
    locations[record.value.eventHash as string] = { segment: segmentName(1), offset, length };
    offset += length;
  }
  await atomicWrite(resolve(directory, indexName(1)), canonicalJson({ schemaVersion: ATTESTATION_INDEX_VERSION, entries: locations }));
  await atomicWrite(manifestPath(directory), canonicalJson({ schemaVersion: ATTESTATION_MANIFEST_VERSION, segments: [{ name: segmentName(1), bytes: content.length, records: records.length, sha256: sha256(content) }], count: records.length, recordsDigest: recordsDigest(records) }));
}
