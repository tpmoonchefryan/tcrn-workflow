// SPDX-License-Identifier: Apache-2.0
// INIT-048 / STORY-340: local time-attestation receipts. Legacy receipts remain
// readable until the migration's delete step; once a directory has a manifest,
// new receipts use the same segmented NDJSON/index layout.
//
// TCRN-CROSS-INC-378: no code in this file takes one canonical document over the whole
// record list any more. The list digest is streamed (R1); segments roll over before a
// segment or its index could outgrow one canonical document, and every byte is computed
// before the first write (R2); every read-modify-write holds the directory lock (R5).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { PROTOCOL_LIMITS, assertCanonicalJson, canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { processIsAlive } from "./knowledge-core.js";

export const ATTESTATION_MANIFEST_VERSION = "tcrn.attestation-manifest.v1" as const;
export const ATTESTATION_INDEX_VERSION = "tcrn.attestation-index.v1" as const;
// A segment and the index beside it must each fit one canonical document. One MiB bounds
// the segment; 8,192 records bound the index, whose entries run to about 124 bytes, under
// both one MiB and the 10,000-key object limit whatever size the records are.
export const ATTESTATION_SEGMENT_BYTES = PROTOCOL_LIMITS.maxCanonicalBytes;
export const ATTESTATION_SEGMENT_RECORDS = 8_192;
const ATTESTATION_LOCK_NAME = "attestation.lock";
const ATTESTATION_LOCK_TIMEOUT_MS = 10_000;
const ATTESTATION_LOCK_POLL_MS = 10;
// TCRN-CROSS-STORY-457: a lock that cannot be read (empty, cut short, not a lock) and is
// older than this is stale. A writer now places its lock whole, so only a pre-STORY-457
// writer ever showed an empty lock, and only for the instant between creating and writing it.
export const ATTESTATION_LOCK_UNREADABLE_STALE_MS = 5_000;
// TCRN-CROSS-INC-382: a v2 lock records the start time read with LC_ALL=C and TZ=UTC, the
// reading the check compares. A v1 lock's start was read with its writer's own time zone and
// locale, so it is still read but never compared.
export const ATTESTATION_LOCK_VERSION = "tcrn.attestation-lock.v2" as const;
const ATTESTATION_LOCK_VERSION_V1 = "tcrn.attestation-lock.v1";

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

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// The refusals added by TCRN-CROSS-INC-378 carry a stable reasonCode for the CLI to report.
function attestationError(reasonCode: string, detail: string): Error {
  return Object.assign(new Error(`${reasonCode}: ${detail}`), { reasonCode });
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

// The only names the segment writer creates, and so the only names it may ever remove.
function segmentFileName(name: string): boolean {
  return /^\d{6}\.(?:ndjson|idx)$/u.test(name);
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

export interface AttestationLockHolder {
  readonly pid: number;
  readonly start: string | null;
  readonly createdAt: string | null;
  // True only for a start read the way the check reads it (a v2 lock).
  readonly startComparable: boolean;
}

export interface AttestationLockState {
  readonly state: "live" | "stale" | "unparseable";
  readonly holder: AttestationLockHolder | null;
  readonly staleReason: "holder-not-running" | "holder-pid-reused" | "unparseable-expired" | null;
  readonly ageMs: number;
  readonly text: string;
}

// The start time `ps` reports for a pid, or null when it cannot say (no such process, no
// `ps`). With null the pid-reuse check is skipped: the lock is then judged by the pid alone,
// as before, so the fallback never clears a live holder (STORY-457 Assumptions).
// TCRN-CROSS-INC-382: `ps` formats lstart in the caller's time zone and locale, so one
// process read differently to two writers in different environments. It is read with
// LC_ALL=C and TZ=UTC, for the lock and for the check alike.
const PROCESS_START_ENV = { LC_ALL: "C", TZ: "UTC" } as const;

function processStart(pid: number): Promise<string | null> {
  return new Promise((settle) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000, env: { ...process.env, ...PROCESS_START_ENV } }, (error, stdout) => {
      const text = typeof stdout === "string" ? stdout.trim() : "";
      settle(error === null && text.length > 0 ? text : null);
    });
  });
}

let ownStart: Promise<string | null> | undefined;
function ownProcessStart(): Promise<string | null> {
  ownStart ??= processStart(process.pid);
  return ownStart;
}

// Every lock format: the canonical v2 line, the v1 line (INC-382: read, its start never
// compared), and the pre-STORY-457 "<pid>\n", which names a pid and nothing to check it against.
function parseAttestationLock(text: string): AttestationLockHolder | null {
  if (/^[1-9]\d*\n$/u.test(text)) return { pid: Number(text), start: null, createdAt: null, startComparable: false };
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (text.endsWith("\n") && (value.schemaVersion === ATTESTATION_LOCK_VERSION || value.schemaVersion === ATTESTATION_LOCK_VERSION_V1) && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && (value.start === null || typeof value.start === "string") && typeof value.createdAt === "string") {
      return { pid: Number(value.pid), start: value.start as string | null, createdAt: value.createdAt, startComparable: value.schemaVersion === ATTESTATION_LOCK_VERSION };
    }
  } catch {
    // Not a lock this engine wrote: judged by its age below.
  }
  return null;
}

/**
 * TCRN-CROSS-STORY-457 R2: the lock as it stands. Stale when its holder is not running, when
 * the holder's pid now belongs to a process that started at another time (judged only from a
 * start read the way this check reads it, INC-382), or when it cannot be read and is older
 * than ATTESTATION_LOCK_UNREADABLE_STALE_MS; a fresh unreadable lock and a live holder are
 * waited for. Read-only; undefined when there is no lock.
 */
export async function assessAttestationLock(path: string): Promise<AttestationLockState | undefined> {
  let text: string;
  let modified: number;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      modified = (await handle.stat()).mtimeMs;
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
  const ageMs = Math.max(0, Date.now() - modified);
  const holder = parseAttestationLock(text);
  if (holder === null) return { state: ageMs > ATTESTATION_LOCK_UNREADABLE_STALE_MS ? "stale" : "unparseable", holder, staleReason: ageMs > ATTESTATION_LOCK_UNREADABLE_STALE_MS ? "unparseable-expired" : null, ageMs, text };
  if (!processIsAlive(holder.pid)) return { state: "stale", holder, staleReason: "holder-not-running", ageMs, text };
  if (holder.start !== null && holder.startComparable) {
    const start = holder.pid === process.pid ? await ownProcessStart() : await processStart(holder.pid);
    if (start !== null && start !== holder.start) return { state: "stale", holder, staleReason: "holder-pid-reused", ageMs, text };
  }
  return { state: "live", holder, staleReason: null, ageMs, text };
}

async function pause(): Promise<void> {
  await new Promise((settle) => setTimeout(settle, ATTESTATION_LOCK_POLL_MS));
}

// Another waiter may have taken the same stale lock over and written its own between our
// read and the rename; a moved lock that is not the one judged stale is put back.
async function removeStaleLock(path: string, stale: string): Promise<void> {
  const aside = `${path}.${process.pid}-${temporarySequence += 1}.stale`;
  try {
    await rename(path, aside);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return;
    throw error;
  }
  if (await readFile(aside, "utf8").catch(() => null) !== stale) {
    await link(aside, path).catch((error: unknown) => {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    });
  }
  await rm(aside, { force: true });
}

// R5 (problem #206): receipts are written after the workspace lease is released, so two
// writers could each read the store and the later rename would silently drop the earlier
// receipt. Every read-modify-write therefore holds one lock file in the directory, created
// exclusively and naming its holder's pid. A lock whose holder no longer exists is stale
// and is taken over; a live holder is waited for until the timeout, which refuses with
// ATTESTATION_LOCKED before the operation has written anything.
export interface AttestationStaleLockTakeover {
  readonly reason: NonNullable<AttestationLockState["staleReason"]>;
  readonly holderPid: number | null;
}

// STORY-457 R1: the lock is written whole into a private file and linked into place, so no
// other process ever sees it half written; link refuses when a lock is already there.
async function placeAttestationLock(path: string, text: string): Promise<boolean> {
  const staged = `${path}.${process.pid}-${temporarySequence += 1}.new`;
  await writeFile(staged, text, { flag: "wx", mode: 0o600 });
  try {
    await link(staged, path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    return false;
  } finally {
    await rm(staged, { force: true });
  }
}

export async function withAttestationLock<T>(directory: string, operation: () => Promise<T>, timeoutMs = ATTESTATION_LOCK_TIMEOUT_MS, onStaleLock?: (takeover: AttestationStaleLockTakeover) => void): Promise<T> {
  const path = resolve(directory, ATTESTATION_LOCK_NAME);
  const own = `${canonicalJson({ createdAt: new Date().toISOString(), pid: process.pid, schemaVersion: ATTESTATION_LOCK_VERSION, start: await ownProcessStart() })}\n`;
  for (let waited = 0; ; waited += ATTESTATION_LOCK_POLL_MS) {
    if (await placeAttestationLock(path, own)) break;
    const lock = await assessAttestationLock(path);
    if (lock === undefined) continue;
    if (lock.state === "stale") {
      await removeStaleLock(path, lock.text);
      onStaleLock?.({ reason: lock.staleReason!, holderPid: lock.holder?.pid ?? null });
      continue;
    }
    if (waited >= timeoutMs) {
      const by = lock.holder !== null ? ` by process ${lock.holder.pid}` : "";
      throw attestationError("ATTESTATION_LOCKED", `${ATTESTATION_LOCK_NAME} is still held${by} after ${timeoutMs} ms`);
    }
    await pause();
  }
  try {
    return await operation();
  } finally {
    // Release only the lock this writer placed; one that is not ours is left for its owner.
    if (await readFile(path, "utf8").catch(() => null) === own) await rm(path, { force: true });
  }
}

// Store files are the only names backup copies and restore writes back or removes.
function storeFileName(name: string): boolean {
  return name === "manifest.json" || segmentFileName(name) || legacyName(name);
}

// Rewrite, backup and restore run inside a lock the caller already holds (repair runs all
// three inside one), so they check it is this process's rather than take it again.
async function assertLockHeld(directory: string): Promise<void> {
  const lock = await assessAttestationLock(resolve(directory, ATTESTATION_LOCK_NAME));
  if (lock?.state !== "live" || lock.holder?.pid !== process.pid) throw attestationError("ATTESTATION_LOCK_NOT_HELD", "call inside withAttestationLock");
}

export interface AttestationStoreFile {
  readonly name: string;
  readonly bytes: Buffer;
}

export interface AttestationDirectoryContents {
  readonly manifest: Buffer | null;
  readonly segments: readonly AttestationStoreFile[];
  readonly indexes: readonly AttestationStoreFile[];
  readonly legacy: readonly AttestationStoreFile[];
  readonly lock: Buffer | null;
  readonly temporary: readonly AttestationStoreFile[];
  readonly other: readonly { readonly name: string; readonly bytes: Buffer | null }[];
}

// R4: the lenient read verify, repair and restore start from. It judges nothing: every
// entry is sorted into what the store owns (manifest, segments, indexes, legacy receipts),
// the lock, write residue (.tmp- files and stale-lock leftovers) and everything else, and
// read as it is. An entry that is not a regular file is listed with the others, unread.
export async function readAttestationDirectory(directory: string): Promise<AttestationDirectoryContents> {
  let manifest: Buffer | null = null;
  let lock: Buffer | null = null;
  const segments: AttestationStoreFile[] = [];
  const indexes: AttestationStoreFile[] = [];
  const legacy: AttestationStoreFile[] = [];
  const temporary: AttestationStoreFile[] = [];
  const other: { readonly name: string; readonly bytes: Buffer | null }[] = [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareCanonicalText(left.name, right.name));
  for (const entry of entries) {
    const bytes = entry.isFile() ? await readFile(resolve(directory, entry.name)) : null;
    if (bytes === null) other.push({ name: entry.name, bytes });
    else if (entry.name === "manifest.json") manifest = bytes;
    else if (/^\d{6}\.ndjson$/u.test(entry.name)) segments.push({ name: entry.name, bytes });
    else if (/^\d{6}\.idx$/u.test(entry.name)) indexes.push({ name: entry.name, bytes });
    else if (legacyName(entry.name)) legacy.push({ name: entry.name, bytes });
    else if (entry.name === ATTESTATION_LOCK_NAME) lock = bytes;
    else if (entry.name.startsWith(".tmp-") || entry.name.startsWith(`${ATTESTATION_LOCK_NAME}.`)) temporary.push({ name: entry.name, bytes });
    else other.push({ name: entry.name, bytes });
  }
  return { manifest, segments, indexes, legacy, lock, temporary, other };
}

function storeFiles(contents: AttestationDirectoryContents): readonly AttestationStoreFile[] {
  const manifest = contents.manifest === null ? [] : [{ name: "manifest.json", bytes: contents.manifest }];
  return [...manifest, ...contents.segments, ...contents.indexes, ...contents.legacy];
}

// R4 repair: before a store is rewritten, every file it owns is copied byte for byte into
// backupDirectory, which must not exist or be empty, beside backup-manifest.json
// (tcrn.attestation-backup.v1) naming every file in the directory with its size, sha-256
// and whether it was copied. Files the store does not own are named, not copied; the lock
// and entries that are not regular files are left out; no path is recorded. Each copy is
// synced by atomicWrite and read back against its digest before this returns, so a backup
// that did not land refuses the repair before the store is touched.
export async function backupAttestationStore(directory: string, backupDirectory: string): Promise<string> {
  await assertLockHeld(directory);
  const contents = await readAttestationDirectory(directory);
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  if ((await readdir(backupDirectory)).length > 0) throw attestationError("ATTESTATION_BACKUP_INVALID", "the backup directory is not empty");
  const owned = storeFiles(contents);
  for (const file of owned) await atomicWrite(resolve(backupDirectory, file.name), file.bytes);
  const foreign = [...contents.temporary, ...contents.other.flatMap((file) => file.bytes === null ? [] : [{ name: file.name, bytes: file.bytes }])];
  const describe = (file: AttestationStoreFile, copied: boolean): Readonly<Record<string, JsonValue>> =>
    ({ name: file.name, bytes: file.bytes.length, sha256: sha256(file.bytes), copied });
  const files = [...owned.map((file) => describe(file, true)), ...foreign.map((file) => describe(file, false))]
    .sort((left, right) => compareCanonicalText(String(left.name), String(right.name)));
  const manifest = canonicalJson({ schemaVersion: "tcrn.attestation-backup.v1", files });
  await atomicWrite(resolve(backupDirectory, "backup-manifest.json"), manifest);
  for (const file of owned) {
    if (sha256(await readFile(resolve(backupDirectory, file.name))) !== sha256(file.bytes)) throw attestationError("ATTESTATION_BACKUP_INVALID", `${file.name} did not read back`);
  }
  return manifest;
}

// R4 repair: the store rewritten by the one segment writer (R2) from these canonical
// record lines, each without its LF, in any order.
export async function rewriteAttestationStore(directory: string, lines: readonly string[]): Promise<void> {
  await assertLockHeld(directory);
  const records = lines.map((line) => {
    const value = assertCanonicalJson(`${line}\n`);
    if (!isObject(value) || typeof value.eventHash !== "string") throw new Error("ATTESTATION_RECORD_INVALID");
    return { name: `${value.eventHash}.json`, bytes: Buffer.from(line, "utf8"), value };
  });
  await writeSegments(directory, records.sort((left, right) => compareCanonicalText(left.name, right.name)), ATTESTATION_SEGMENT_BYTES);
}

// The eventHash of every receipt in these store files: each segment line and each legacy
// receipt. A line that is not a record refuses, because it could be any receipt.
function receiptHashes(files: readonly AttestationStoreFile[]): Set<string> {
  const hashes = new Set<string>();
  for (const file of files) {
    if (legacyName(file.name)) hashes.add(file.name.slice(0, 64));
    if (!file.name.endsWith(".ndjson")) continue;
    for (const line of file.bytes.toString("utf8").split("\n").filter((text) => text.length > 0)) {
      let value: JsonValue = null;
      try {
        value = JSON.parse(line) as JsonValue;
      } catch {
        // judged below with every other line that is not a record
      }
      if (!isObject(value) || typeof value.eventHash !== "string") throw attestationError("ATTESTATION_RESTORE_REFUSED", `${file.name} holds a line that is not a receipt`);
      hashes.add(value.eventHash);
    }
  }
  return hashes;
}

// R4 restore, the rollback of a repair. backup-manifest.json and every copied file are
// checked against their recorded size and sha-256 first, and a store holding a receipt the
// backup lacks is refused, so a restore never drops a receipt written after the repair.
// Then each copied file is written back (the manifest last), store files the backup does
// not have are removed, files the store does not own are left alone, and every restored
// file is read back against its digest.
export async function restoreAttestationStore(directory: string, backupDirectory: string): Promise<{ readonly backupManifest: string; readonly restored: readonly string[]; readonly removed: readonly string[] }> {
  await assertLockHeld(directory);
  const backupManifest = (await readFile(resolve(backupDirectory, "backup-manifest.json"))).toString("utf8");
  const document = assertCanonicalJson(backupManifest);
  const entries = isObject(document) && document.schemaVersion === "tcrn.attestation-backup.v1" && Array.isArray(document.files) ? document.files : null;
  if (entries === null) throw attestationError("ATTESTATION_RESTORE_REFUSED", "backup-manifest.json is not a tcrn.attestation-backup.v1 document");
  const files: AttestationStoreFile[] = [];
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.name !== "string" || typeof entry.copied !== "boolean") throw attestationError("ATTESTATION_RESTORE_REFUSED", "backup-manifest.json has a malformed entry");
    if (!entry.copied) continue;
    const bytes = storeFileName(entry.name) ? await readFile(resolve(backupDirectory, entry.name)) : null;
    if (bytes === null || bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw attestationError("ATTESTATION_RESTORE_REFUSED", `${entry.name} in the backup does not match backup-manifest.json`);
    files.push({ name: entry.name, bytes });
  }
  const current = storeFiles(await readAttestationDirectory(directory));
  const kept = receiptHashes(files);
  const lost = [...receiptHashes(current)].filter((hash) => !kept.has(hash));
  if (lost.length > 0) throw attestationError("ATTESTATION_RESTORE_REFUSED", `the store holds ${lost.length} receipt(s) the backup does not, first ${lost[0]}`);
  const names = new Set(files.map((file) => file.name));
  for (const file of [...files.filter((entry) => entry.name !== "manifest.json"), ...files.filter((entry) => entry.name === "manifest.json")]) {
    await atomicWrite(resolve(directory, file.name), file.bytes);
  }
  const removed = current.filter((file) => !names.has(file.name)).map((file) => file.name);
  for (const name of removed) await rm(resolve(directory, name), { force: true });
  for (const file of files) {
    if (sha256(await readFile(resolve(directory, file.name))) !== sha256(file.bytes)) throw attestationError("ATTESTATION_RESTORE_UNVERIFIED", `${file.name} did not read back`);
  }
  return { backupManifest, restored: files.map((file) => file.name), removed };
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
  return parseAttestationManifest(bytes);
}

export function parseAttestationManifest(bytes: Buffer): AttestationManifest {
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
    const lines = bytes.toString("utf8").split("\n").slice(0, -1);
    if (lines.length !== segment.records) throw new Error(`ATTESTATION_SEGMENT_INVALID: ${segment.name}`);
    for (const line of lines) {
      const value = assertCanonicalJson(`${line}\n`);
      if (!isObject(value) || typeof value.eventHash !== "string") throw new Error(`ATTESTATION_RECORD_INVALID: ${segment.name}`);
      records.push({ name: `${value.eventHash}.json`, bytes: Buffer.from(line, "utf8"), value });
    }
  }
  if (records.length !== manifest.count || recordsDigest(records) !== manifest.recordsDigest) {
    throw new Error("ATTESTATION_MANIFEST_INVALID");
  }
  return records;
}

// R1: the digest of a record list is the sha-256 of exactly the bytes canonicalSha256
// would hash for the array -- "[", each record's canonical line without its LF, joined by
// ",", then "]\n" -- fed to the hash one line at a time. It has no count or byte
// ceiling, and below one MiB it equals canonicalSha256 of the array, which is what every
// existing manifest recorded, so none of them has to be migrated.
export function attestationRecordsDigest(lines: readonly string[]): string {
  const hash = createHash("sha256").update("[");
  for (const [index, line] of lines.entries()) hash.update(`${index === 0 ? "" : ","}${line}`);
  return hash.update("]\n").digest("hex");
}

function recordsDigest(records: readonly AttestationFileRecord[]): string {
  return attestationRecordsDigest(records.map((record) => canonicalJson(record.value).slice(0, -1)));
}

// R2: every byte of the new store -- segments, their indexes and the manifest -- is
// computed before the first write, so a size or canonical-form refusal changes nothing on
// disk. Segments roll over at a record boundary once the next record would take one past
// segmentBytes or past ATTESTATION_SEGMENT_RECORDS. The manifest is written last, and only
// then are segment and index files it no longer names removed; no other file in the
// directory (legacy receipts, relocation receipts, the lock) is ever touched here. A store
// smaller than one segment is still the single 000001 segment, byte-identical to v1.1.2.
async function writeSegments(directory: string, records: readonly AttestationFileRecord[], segmentBytes: number): Promise<void> {
  const chunks: { readonly eventHash: string; readonly line: string }[][] = [];
  let chunkBytes = 0;
  for (const record of records) {
    const entry = { eventHash: record.value.eventHash as string, line: canonicalJson(record.value) };
    const lineBytes = Buffer.byteLength(entry.line, "utf8");
    const current = chunks.at(-1);
    if (current === undefined || chunkBytes + lineBytes > segmentBytes || current.length === ATTESTATION_SEGMENT_RECORDS) {
      chunks.push([entry]);
      chunkBytes = lineBytes;
    } else {
      current.push(entry);
      chunkBytes += lineBytes;
    }
  }
  const files: { readonly name: string; readonly content: string }[] = [];
  const segments: AttestationManifestSegment[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const name = segmentName(index + 1);
    const content = chunk.map((entry) => entry.line).join("");
    const locations: Record<string, AttestationLocation> = {};
    let offset = 0;
    for (const entry of chunk) {
      const length = Buffer.byteLength(entry.line, "utf8");
      locations[entry.eventHash] = { segment: name, offset, length };
      offset += length;
    }
    files.push({ name, content }, { name: indexName(index + 1), content: canonicalJson({ schemaVersion: ATTESTATION_INDEX_VERSION, entries: locations }) });
    segments.push({ name, bytes: Buffer.byteLength(content, "utf8"), records: chunk.length, sha256: sha256(content) });
  }
  const manifest = canonicalJson({ schemaVersion: ATTESTATION_MANIFEST_VERSION, segments, count: records.length, recordsDigest: recordsDigest(records) });
  for (const file of files) await atomicWrite(resolve(directory, file.name), file.content);
  await atomicWrite(manifestPath(directory), manifest);
  const kept = new Set(files.map((file) => file.name));
  for (const name of await readdir(directory)) {
    if (segmentFileName(name) && !kept.has(name)) await rm(resolve(directory, name), { force: true });
  }
}

// R3 (problems #205, #209): what a mutating verb reads before it takes the workspace lease.
// It takes no lock and writes nothing. A directory with no manifest -- absent, or still in
// the legacy one-file-per-receipt layout -- is consistent; otherwise every segment must
// match the manifest in bytes, sha-256 and record count, and the streamed digest must match.
// A live lock means a writer is mid-rewrite, so the check waits for it; a lock still held at
// the timeout is itself the answer, since nothing consistent could be read. Returns null
// when consistent, else what is wrong.
export async function checkAttestationStore(directory: string, timeoutMs = ATTESTATION_LOCK_TIMEOUT_MS): Promise<string | null> {
  const lock = resolve(directory, ATTESTATION_LOCK_NAME);
  // STORY-457: the same judgement the writers use; a stale lock is not someone mid-rewrite.
  const held = async (): Promise<boolean> => {
    const state = (await assessAttestationLock(lock))?.state;
    return state === "live" || state === "unparseable";
  };
  for (let waited = 0; ; waited += ATTESTATION_LOCK_POLL_MS) {
    if (!(await held())) {
      try {
        const manifest = await readManifest(directory);
        if (manifest !== null) await readSegmentRecords(directory, manifest);
        return null;
      } catch (error) {
        // A writer that took the lock after the look above may be halfway through a rewrite;
        // its store is waited for, not reported.
        if (!(await held())) return String((error as { message?: unknown }).message ?? error);
      }
    }
    if (waited >= timeoutMs) return `${ATTESTATION_LOCK_NAME} was still held after ${timeoutMs} ms`;
    await pause();
  }
}

function sameNames(current: readonly string[], baseline: readonly string[]): boolean {
  return Array.isArray(baseline) && current.length === baseline.length && current.every((name, index) => name === baseline[index]);
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
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 4096 || segmentBytes > ATTESTATION_SEGMENT_BYTES) throw new Error("ATTESTATION_SEGMENT_BYTES_INVALID");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return withAttestationLock(directory, async () => {
    const existingManifest = await readManifest(directory);
    const records = existingManifest === null ? await readLegacy(directory) : await readSegmentRecords(directory, existingManifest);
    await writeSegments(directory, records, segmentBytes);
    return reportAttestationDirectory(directory);
  });
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
  return withAttestationLock(directory, async () => {
    const current = await reportAttestationDirectory(directory);
    if (current.legacyFiles !== baseline.legacyFiles || current.legacyBytes !== baseline.legacyBytes || current.recordsDigest !== baseline.recordsDigest || !sameNames(current.records, baseline.records)) {
      throw new Error("ATTESTATION_BASELINE_MISMATCH");
    }
    const manifest = await readManifest(directory);
    if (manifest === null || manifest.count !== current.legacyFiles || manifest.recordsDigest !== current.recordsDigest) throw new Error("ATTESTATION_MIGRATION_UNVERIFIED");
    const migrated = await readSegmentRecords(directory, manifest);
    const legacy = await readLegacy(directory);
    if (migrated.length !== legacy.length || migrated.some((record, index) => canonicalJson(record.value) !== canonicalJson(legacy[index]?.value))) {
      throw new Error("ATTESTATION_VALUE_MISMATCH");
    }
    for (const name of current.records) await rm(resolve(directory, name));
    return { legacyFiles: 0, legacyBytes: 0, recordsDigest: current.recordsDigest, records: [] };
  });
}

export async function writeAttestationReceipt(directory: string, receipt: string, options: { readonly lockTimeoutMs?: number } = {}): Promise<{ readonly staleLock: AttestationStaleLockTakeover | null }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const value = assertCanonicalJson(receipt);
  if (!isObject(value) || typeof value.eventHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.eventHash)) throw new Error("ATTESTATION_RECORD_INVALID");
  const eventHash = value.eventHash;
  let staleLock: AttestationStaleLockTakeover | null = null;
  await withAttestationLock(directory, async () => {
    const manifest = await readManifest(directory);
    if (manifest === null) {
      await atomicWrite(resolve(directory, `${eventHash}.json`), receipt);
      return;
    }
    const records = [...await readSegmentRecords(directory, manifest), { name: `${eventHash}.json`, bytes: Buffer.from(receipt, "utf8"), value }]
      .sort((left, right) => compareCanonicalText(left.name, right.name));
    await writeSegments(directory, records, ATTESTATION_SEGMENT_BYTES);
  }, options.lockTimeoutMs, (takeover) => { staleLock = takeover; });
  return { staleLock };
}
