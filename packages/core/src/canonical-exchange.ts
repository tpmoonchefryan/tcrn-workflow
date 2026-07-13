// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  ProtocolError,
  assertCanonicalJson,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  validateExchangeEnvelope,
} from "../../protocol/src/index.js";
import type { ExchangeEnvelope } from "../../protocol/src/index.js";
import { assertSupportedWorkspaceFilesystem } from "./workspace.js";

export const CANONICAL_EXCHANGE_REQUEST_VERSION = "tcrn.canonical-exchange-request.v1" as const;
export const CANONICAL_EXCHANGE_MANIFEST_VERSION = "tcrn.canonical-exchange-manifest.v1" as const;
export const CANONICAL_EXCHANGE_TRANSACTION_VERSION = "tcrn.canonical-exchange-transaction.v1" as const;
export const CANONICAL_EXCHANGE_RESUME_VERSION = "tcrn.canonical-exchange-resume.v1" as const;

export const CANONICAL_EXCHANGE_LIMITS = Object.freeze({
  maximumChunks: 128,
  maximumChunkBytes: 1_048_576,
  maximumTotalBytes: 8_388_608,
  maximumLogicalPathBytes: 256,
  maximumManifestBytes: 262_144,
  maximumControlBytes: 65_536,
  maximumBundleFiles: 131,
});

export const CANONICAL_EXCHANGE_REASON_CODES = Object.freeze([
  "EXCHANGE_INPUT_INVALID",
  "EXCHANGE_UNKNOWN_FIELD",
  "EXCHANGE_PATH_INVALID",
  "EXCHANGE_LIMIT_EXCEEDED",
  "EXCHANGE_CANONICAL_INVALID",
  "EXCHANGE_FILE_INVALID",
  "EXCHANGE_LINK_INVALID",
  "EXCHANGE_CHANGED",
  "EXCHANGE_FILESYSTEM_UNSUPPORTED",
  "EXCHANGE_INCOMPLETE",
  "EXCHANGE_CHUNK_DUPLICATE",
  "EXCHANGE_CHUNK_MISSING",
  "EXCHANGE_CHUNK_SUBSTITUTED",
  "EXCHANGE_SEMANTIC_MISMATCH",
  "EXCHANGE_TRANSACTION_MISMATCH",
  "EXCHANGE_RESUME_MISMATCH",
  "EXCHANGE_OUTPUT_EXISTS",
  "EXCHANGE_OUTPUT_UNSAFE",
  "EXCHANGE_WRITE_CRASH",
] as const);

export type CanonicalExchangeReasonCode = typeof CANONICAL_EXCHANGE_REASON_CODES[number];
export type CanonicalExchangeFaultPoint = "after-first-chunk" | "before-commit-rename";

export interface CanonicalExchangeChunkInput {
  readonly logicalPath: string;
  readonly mediaType: "application/json" | "text/plain; charset=utf-8";
  readonly contentBase64: string;
  readonly semanticDigest: string;
}

export interface CanonicalExchangeRequest {
  readonly schemaVersion: typeof CANONICAL_EXCHANGE_REQUEST_VERSION;
  readonly exchange: ExchangeEnvelope;
  readonly transactionId: string;
  readonly sourceWorkspaceId: string;
  readonly targetWorkspaceId: string;
  readonly idempotencyKey: string;
  readonly semanticSubjectDigest: string;
  readonly chunks: readonly CanonicalExchangeChunkInput[];
}

export interface CanonicalExchangeChunkRecord {
  readonly id: string;
  readonly index: number;
  readonly logicalPath: string;
  readonly storedPath: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly semanticDigest: string;
}

export interface CanonicalExchangeManifest {
  readonly schemaVersion: typeof CANONICAL_EXCHANGE_MANIFEST_VERSION;
  readonly bundleId: string;
  readonly transactionId: string;
  readonly sourceWorkspaceId: string;
  readonly targetWorkspaceId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly semanticSubjectDigest: string;
  readonly exchange: ExchangeEnvelope;
  readonly chunks: readonly CanonicalExchangeChunkRecord[];
  readonly totalBytes: number;
  readonly manifestDigest: string;
}

export interface CanonicalExchangeTransaction {
  readonly schemaVersion: typeof CANONICAL_EXCHANGE_TRANSACTION_VERSION;
  readonly transactionId: string;
  readonly bundleId: string;
  readonly idempotencyKey: string;
  readonly manifestDigest: string;
  readonly chunkCount: number;
  readonly totalBytes: number;
  readonly phase: "committed";
  readonly transactionDigest: string;
}

export interface CanonicalExchangeResume {
  readonly schemaVersion: typeof CANONICAL_EXCHANGE_RESUME_VERSION;
  readonly transactionId: string;
  readonly bundleId: string;
  readonly manifestDigest: string;
  readonly completedChunkIds: readonly string[];
  readonly remainingChunkIds: readonly string[];
  readonly resumeDigest: string;
}

export interface CanonicalExchangePlan {
  readonly reasonCode: "EXCHANGE_PLAN_READY";
  readonly manifest: CanonicalExchangeManifest;
  readonly transaction: CanonicalExchangeTransaction;
  readonly resume: CanonicalExchangeResume;
  readonly bundleDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly planDigest: string;
}

export type CanonicalExchangeReadback = Omit<CanonicalExchangePlan, "reasonCode"> & {
  readonly reasonCode: "EXCHANGE_BUNDLE_VERIFIED";
  readonly bundleRoot: string;
  readonly chunks: readonly Readonly<{ record: CanonicalExchangeChunkRecord; contentBase64: string }>[];
};

export interface CanonicalExchangeWriteOptions {
  readonly faultPointForTest?: CanonicalExchangeFaultPoint;
  readonly cleanupCrashForTest?: boolean;
  readonly beforeOwnedStageCleanupForTest?: (path: string) => Promise<void>;
}

export interface CanonicalExchangeReadOptions {
  readonly afterLstatForTest?: (path: string) => Promise<void>;
  readonly afterDescriptorOpenForTest?: (path: string) => Promise<void>;
  readonly afterDescriptorReadForTest?: (path: string, consumedBytes: number) => Promise<void>;
  readonly beforeChunkOpenForTest?: (path: string) => Promise<void>;
}

export class CanonicalExchangeError extends Error {
  readonly reasonCode: CanonicalExchangeReasonCode;

  constructor(reasonCode: CanonicalExchangeReasonCode, message: string) {
    super(message);
    this.name = "CanonicalExchangeError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: CanonicalExchangeReasonCode, message: string): never {
  throw new CanonicalExchangeError(reasonCode, message);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value: unknown, fields: readonly string[], label: string): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) fail("EXCHANGE_INPUT_INVALID", label);
  const actual = Object.keys(value).sort(compareCanonicalText);
  const expected = [...fields].sort(compareCanonicalText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("EXCHANGE_UNKNOWN_FIELD", label);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("EXCHANGE_INPUT_INVALID", label);
  return value;
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{1,31}:[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    fail("EXCHANGE_INPUT_INVALID", label);
  }
  return value;
}

function wellFormed(value: string, label: string): string {
  if (!value.isWellFormed()) fail("EXCHANGE_CANONICAL_INVALID", label);
  return value;
}

function logicalPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > CANONICAL_EXCHANGE_LIMITS.maximumLogicalPathBytes ||
    isAbsolute(value) || value.includes("\\") || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("EXCHANGE_PATH_INVALID", String(value));
  }
  wellFormed(value, "logicalPath");
  return value;
}

function canonicalBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail("EXCHANGE_CANONICAL_INVALID", label);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail("EXCHANGE_CANONICAL_INVALID", label);
  return bytes;
}

function semanticDigest(bytes: Buffer, mediaType: string): string {
  if (mediaType === "application/json") {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) fail("EXCHANGE_CANONICAL_INVALID", "JSON chunk UTF-8");
    try {
      const parsed = assertCanonicalJson(text);
      return canonicalSha256(parsed);
    } catch (error) {
      if (error instanceof ProtocolError) fail("EXCHANGE_CANONICAL_INVALID", error.message);
      throw error;
    }
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || !text.isWellFormed()) fail("EXCHANGE_CANONICAL_INVALID", "text chunk UTF-8");
  return sha256(bytes);
}

interface ValidatedChunk {
  readonly input: CanonicalExchangeChunkInput;
  readonly bytes: Buffer;
  readonly record: CanonicalExchangeChunkRecord;
}

interface InternalPlan {
  readonly publicPlan: CanonicalExchangePlan;
  readonly chunks: readonly ValidatedChunk[];
}

function validateRequest(value: unknown): InternalPlan {
  exactFields(value, ["schemaVersion", "exchange", "transactionId", "sourceWorkspaceId", "targetWorkspaceId", "idempotencyKey", "semanticSubjectDigest", "chunks"], "exchange request");
  if (value.schemaVersion !== CANONICAL_EXCHANGE_REQUEST_VERSION || !Array.isArray(value.chunks)) fail("EXCHANGE_INPUT_INVALID", "request header");
  if (value.chunks.length === 0 || value.chunks.length > CANONICAL_EXCHANGE_LIMITS.maximumChunks) fail("EXCHANGE_LIMIT_EXCEEDED", "chunk count");
  const transactionId = stableId(value.transactionId, "transactionId");
  const sourceWorkspaceId = stableId(value.sourceWorkspaceId, "sourceWorkspaceId");
  const targetWorkspaceId = stableId(value.targetWorkspaceId, "targetWorkspaceId");
  const idempotencyKey = stableId(value.idempotencyKey, "idempotencyKey");
  const semanticSubjectDigest = digest(value.semanticSubjectDigest, "semanticSubjectDigest");
  const raw = value.chunks.map((entry, index) => {
    exactFields(entry, ["logicalPath", "mediaType", "contentBase64", "semanticDigest"], `chunks[${index}]`);
    const path = logicalPath(entry.logicalPath);
    if (entry.mediaType !== "application/json" && entry.mediaType !== "text/plain; charset=utf-8") fail("EXCHANGE_INPUT_INVALID", `mediaType:${path}`);
    const bytes = canonicalBase64(entry.contentBase64, `contentBase64:${path}`);
    if (bytes.length > CANONICAL_EXCHANGE_LIMITS.maximumChunkBytes) fail("EXCHANGE_LIMIT_EXCEEDED", path);
    const actualSemantic = semanticDigest(bytes, entry.mediaType);
    if (digest(entry.semanticDigest, `semanticDigest:${path}`) !== actualSemantic) fail("EXCHANGE_SEMANTIC_MISMATCH", path);
    return { input: entry as unknown as CanonicalExchangeChunkInput, path, bytes, actualSemantic, sha256: sha256(bytes) };
  }).sort((left, right) => compareCanonicalText(left.path, right.path));
  if (new Set(raw.map((entry) => entry.path)).size !== raw.length) fail("EXCHANGE_CHUNK_DUPLICATE", "logicalPath");
  const totalBytes = raw.reduce((sum, entry) => sum + entry.bytes.length, 0);
  if (totalBytes > CANONICAL_EXCHANGE_LIMITS.maximumTotalBytes) fail("EXCHANGE_LIMIT_EXCEEDED", "total bytes");
  let exchange: ExchangeEnvelope;
  try { exchange = validateExchangeEnvelope(value.exchange as ExchangeEnvelope); } catch (error) {
    if (error instanceof ProtocolError) fail("EXCHANGE_INPUT_INVALID", error.message);
    throw error;
  }
  const entries = exchange.entries;
  if (entries.length !== raw.length) fail("EXCHANGE_CHUNK_MISSING", "exchange entries");
  const chunks: ValidatedChunk[] = raw.map((entry, index) => {
    const expected = entries[index];
    if (!expected || expected.path !== entry.path || expected.mediaType !== entry.input.mediaType || expected.size !== entry.bytes.length || expected.sha256 !== entry.sha256) {
      fail("EXCHANGE_CHUNK_SUBSTITUTED", entry.path);
    }
    const identityBasis = { bundleId: exchange.id, logicalPath: entry.path, sha256: entry.sha256, semanticDigest: entry.actualSemantic };
    const id = `exchange-chunk:${canonicalSha256(identityBasis).slice(0, 32)}`;
    const storedPath = `chunks/${String(index + 1).padStart(4, "0")}-${entry.sha256.slice(0, 16)}.chunk`;
    return { input: entry.input, bytes: entry.bytes, record: { id, index, logicalPath: entry.path, storedPath, mediaType: entry.input.mediaType, size: entry.bytes.length, sha256: entry.sha256, semanticDigest: entry.actualSemantic } };
  });
  const manifestBasis = { schemaVersion: CANONICAL_EXCHANGE_MANIFEST_VERSION, bundleId: exchange.id, transactionId, sourceWorkspaceId, targetWorkspaceId, idempotencyKey, createdAt: exchange.createdAt, semanticSubjectDigest, exchange, chunks: chunks.map((entry) => entry.record), totalBytes };
  const manifest: CanonicalExchangeManifest = { ...manifestBasis, manifestDigest: canonicalSha256(manifestBasis) };
  const transactionBasis = { schemaVersion: CANONICAL_EXCHANGE_TRANSACTION_VERSION, transactionId, bundleId: exchange.id, idempotencyKey, manifestDigest: manifest.manifestDigest, chunkCount: chunks.length, totalBytes, phase: "committed" as const };
  const transaction: CanonicalExchangeTransaction = { ...transactionBasis, transactionDigest: canonicalSha256(transactionBasis) };
  const ids = chunks.map((entry) => entry.record.id).sort(compareCanonicalText);
  const resumeBasis = { schemaVersion: CANONICAL_EXCHANGE_RESUME_VERSION, transactionId, bundleId: exchange.id, manifestDigest: manifest.manifestDigest, completedChunkIds: ids, remainingChunkIds: [] as readonly string[] };
  const resume: CanonicalExchangeResume = { ...resumeBasis, resumeDigest: canonicalSha256(resumeBasis) };
  const bundleDigest = canonicalSha256({ manifestDigest: manifest.manifestDigest, transactionDigest: transaction.transactionDigest, resumeDigest: resume.resumeDigest, chunkDigests: chunks.map((entry) => entry.record.sha256) });
  const planBasis = { manifest, transaction, resume, bundleDigest, fileCount: chunks.length + 3, totalBytes };
  return { chunks, publicPlan: { reasonCode: "EXCHANGE_PLAN_READY", ...planBasis, planDigest: canonicalSha256(planBasis) } };
}

export function planCanonicalExchange(value: unknown): CanonicalExchangePlan {
  try { return validateRequest(value).publicPlan; } catch (error) {
    if (error instanceof CanonicalExchangeError) throw error;
    fail("EXCHANGE_INPUT_INVALID", String(error));
  }
}

function sameIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameDirectoryIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.isDirectory() && right.isDirectory();
}

async function readDirectoryBound(path: string, maximumEntries: number): Promise<string[]> {
  let directory;
  try {
    directory = await opendir(path);
    const entries: string[] = [];
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      entries.push(entry.name);
      if (entries.length > maximumEntries) fail("EXCHANGE_LIMIT_EXCEEDED", `${path}:directory entries`);
    }
    return entries.sort(compareCanonicalText);
  } catch (error) {
    if (error instanceof CanonicalExchangeError) throw error;
    fail("EXCHANGE_FILE_INVALID", `${path}:${String(error)}`);
  } finally {
    await directory?.close().catch((error: unknown) => {
      if ((error as { code?: string }).code !== "ERR_DIR_CLOSED") fail("EXCHANGE_FILE_INVALID", `${path}:${String(error)}`);
    });
  }
}

async function safeWrite(path: string, bytes: Buffer | string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== Buffer.byteLength(bytes)) fail("EXCHANGE_FILE_INVALID", path);
    await handle.close(); handle = undefined;
    const named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameIdentity(opened, named)) fail("EXCHANGE_CHANGED", path);
  } catch (error) {
    await handle?.close();
    if ((error as { code?: string }).code === "EEXIST") fail("EXCHANGE_OUTPUT_EXISTS", path);
    if (error instanceof CanonicalExchangeError) throw error;
    fail("EXCHANGE_FILE_INVALID", `${path}:${String(error)}`);
  }
}

async function outputBoundary(outputRoot: string): Promise<{ parent: string; parentIdentity: Awaited<ReturnType<typeof lstat>> }> {
  if (!isAbsolute(outputRoot) || resolve(outputRoot) !== outputRoot || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(basename(outputRoot))) fail("EXCHANGE_PATH_INVALID", outputRoot);
  const parent = dirname(outputRoot);
  const canonicalParent = await realpath(parent).catch(() => fail("EXCHANGE_OUTPUT_UNSAFE", parent));
  if (canonicalParent !== parent) fail("EXCHANGE_OUTPUT_UNSAFE", parent);
  const identity = await lstat(parent);
  if (!identity.isDirectory() || identity.isSymbolicLink()) fail("EXCHANGE_OUTPUT_UNSAFE", parent);
  try { await assertSupportedWorkspaceFilesystem(parent); } catch { fail("EXCHANGE_FILESYSTEM_UNSUPPORTED", parent); }
  try { await lstat(outputRoot); fail("EXCHANGE_OUTPUT_EXISTS", outputRoot); } catch (error) {
    if (error instanceof CanonicalExchangeError) throw error;
    if ((error as { code?: string }).code !== "ENOENT") fail("EXCHANGE_OUTPUT_UNSAFE", outputRoot);
  }
  return { parent, parentIdentity: identity };
}

export async function writeCanonicalExchangeBundle(outputRoot: string, value: unknown, options: CanonicalExchangeWriteOptions = {}): Promise<CanonicalExchangeReadback> {
  const internal = validateRequest(value);
  const boundary = await outputBoundary(outputRoot);
  const stage = join(boundary.parent, `.${basename(outputRoot)}.partial-${internal.publicPlan.manifest.manifestDigest.slice(0, 16)}`);
  let ownedStage: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    try { await mkdir(stage, { mode: 0o700 }); } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") fail("EXCHANGE_OUTPUT_EXISTS", stage);
      fail("EXCHANGE_OUTPUT_UNSAFE", stage);
    }
    const createdStage = await lstat(stage).catch(() => fail("EXCHANGE_CHANGED", stage));
    if (!createdStage.isDirectory() || createdStage.isSymbolicLink()) fail("EXCHANGE_OUTPUT_UNSAFE", stage);
    ownedStage = createdStage;
    await mkdir(join(stage, "chunks"), { mode: 0o700 });
    for (const [index, chunk] of internal.chunks.entries()) {
      await safeWrite(join(stage, chunk.record.storedPath), chunk.bytes);
      if (index === 0 && options.faultPointForTest === "after-first-chunk") fail("EXCHANGE_WRITE_CRASH", stage);
    }
    await safeWrite(join(stage, "manifest.json"), canonicalJson(internal.publicPlan.manifest));
    await safeWrite(join(stage, "transaction.json"), canonicalJson(internal.publicPlan.transaction));
    await safeWrite(join(stage, "resume.json"), canonicalJson(internal.publicPlan.resume));
    if (options.faultPointForTest === "before-commit-rename") fail("EXCHANGE_WRITE_CRASH", stage);
    const parentAfter = await lstat(boundary.parent);
    if (!sameDirectoryIdentity(boundary.parentIdentity, parentAfter)) fail("EXCHANGE_CHANGED", boundary.parent);
    await rename(stage, outputRoot);
    ownedStage = undefined;
    const parentCommitted = await lstat(boundary.parent);
    if (!sameDirectoryIdentity(parentAfter, parentCommitted)) fail("EXCHANGE_CHANGED", boundary.parent);
    return await readCanonicalExchangeBundle(outputRoot);
  } catch (error) {
    const preserveCrash = error instanceof CanonicalExchangeError && error.reasonCode === "EXCHANGE_WRITE_CRASH" && options.cleanupCrashForTest !== true;
    if (ownedStage && !preserveCrash) {
      await options.beforeOwnedStageCleanupForTest?.(stage);
      const current = await lstat(stage).catch(() => fail("EXCHANGE_CHANGED", stage));
      if (!sameDirectoryIdentity(ownedStage, current)) fail("EXCHANGE_CHANGED", stage);
      await rm(stage, { recursive: true, force: false }).catch((cleanupError) => fail("EXCHANGE_OUTPUT_UNSAFE", `${stage}:${String(cleanupError)}`));
    }
    throw error;
  }
}

async function readBound(path: string, maximumBytes: number, options: CanonicalExchangeReadOptions): Promise<Buffer> {
  const before = await lstat(path).catch(() => fail("EXCHANGE_INCOMPLETE", path));
  if (before.isSymbolicLink()) fail("EXCHANGE_LINK_INVALID", path);
  if (!before.isFile()) fail("EXCHANGE_FILE_INVALID", path);
  if (before.nlink !== 1) fail("EXCHANGE_LINK_INVALID", path);
  if (before.size > maximumBytes) fail("EXCHANGE_LIMIT_EXCEEDED", path);
  await options.afterLstatForTest?.(path);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { fail("EXCHANGE_CHANGED", path); }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(before, opened) || opened.size > maximumBytes) fail("EXCHANGE_CHANGED", path);
    await options.afterDescriptorOpenForTest?.(path);
    const chunks: Buffer[] = [];
    let consumedBytes = 0;
    while (true) {
      const remaining = maximumBytes + 1 - consumedBytes;
      if (remaining <= 0) fail("EXCHANGE_LIMIT_EXCEEDED", path);
      const buffer = Buffer.allocUnsafe(Math.min(65_536, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      consumedBytes += bytesRead;
      await options.afterDescriptorReadForTest?.(path, consumedBytes);
      if (consumedBytes > maximumBytes) fail("EXCHANGE_LIMIT_EXCEEDED", path);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const bytes = Buffer.concat(chunks, consumedBytes);
    const after = await handle.stat();
    const named = await lstat(path).catch(() => fail("EXCHANGE_CHANGED", path));
    if (!sameIdentity(opened, after) || !sameIdentity(after, named) || bytes.length !== after.size || bytes.length > maximumBytes) fail("EXCHANGE_CHANGED", path);
    return bytes;
  } finally { await handle.close(); }
}

function canonicalDocument<T>(bytes: Buffer, label: string): T {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("EXCHANGE_CANONICAL_INVALID", label);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail("EXCHANGE_CANONICAL_INVALID", label); }
  try {
    if (canonicalJson(parsed) !== text) fail("EXCHANGE_CANONICAL_INVALID", label);
  } catch (error) {
    if (error instanceof CanonicalExchangeError) throw error;
    fail("EXCHANGE_CANONICAL_INVALID", label);
  }
  return parsed as T;
}

function validateStoredManifest(value: unknown): CanonicalExchangeManifest {
  exactFields(value, ["schemaVersion", "bundleId", "transactionId", "sourceWorkspaceId", "targetWorkspaceId", "idempotencyKey", "createdAt", "semanticSubjectDigest", "exchange", "chunks", "totalBytes", "manifestDigest"], "manifest");
  const document = value as unknown as CanonicalExchangeManifest;
  if (document.schemaVersion !== CANONICAL_EXCHANGE_MANIFEST_VERSION || !Array.isArray(document.chunks) || !Number.isSafeInteger(document.totalBytes) || document.totalBytes < 0) fail("EXCHANGE_INPUT_INVALID", "manifest");
  if (document.chunks.length === 0 || document.chunks.length > CANONICAL_EXCHANGE_LIMITS.maximumChunks || document.chunks.length + 3 > CANONICAL_EXCHANGE_LIMITS.maximumBundleFiles || document.totalBytes > CANONICAL_EXCHANGE_LIMITS.maximumTotalBytes) fail("EXCHANGE_LIMIT_EXCEEDED", "manifest limits");
  stableId(document.bundleId, "bundleId");
  stableId(document.transactionId, "transactionId");
  stableId(document.sourceWorkspaceId, "sourceWorkspaceId");
  stableId(document.targetWorkspaceId, "targetWorkspaceId");
  stableId(document.idempotencyKey, "idempotencyKey");
  if (typeof document.createdAt !== "string") fail("EXCHANGE_INPUT_INVALID", "createdAt");
  digest(document.semanticSubjectDigest, "semanticSubjectDigest");
  digest(document.manifestDigest, "manifestDigest");
  let exchange: ExchangeEnvelope;
  try { exchange = validateExchangeEnvelope(document.exchange); } catch (error) {
    if (error instanceof ProtocolError) fail("EXCHANGE_INPUT_INVALID", error.message);
    throw error;
  }
  if (document.bundleId !== exchange.id || document.createdAt !== exchange.createdAt) fail("EXCHANGE_CHUNK_SUBSTITUTED", "manifest exchange binding");
  const records = document.chunks.map((record, index) => validateStoredChunkRecord(record, index));
  if (exchange.entries.length !== records.length) fail("EXCHANGE_CHUNK_SUBSTITUTED", "manifest exchange membership");
  const identities = [records.map((record) => record.id), records.map((record) => record.logicalPath), records.map((record) => record.storedPath)];
  if (identities.some((entries) => new Set(entries).size !== entries.length)) fail("EXCHANGE_CHUNK_DUPLICATE", "manifest chunk identity");
  const declaredBytes = records.reduce((sum, record) => {
    if (sum + record.size > CANONICAL_EXCHANGE_LIMITS.maximumTotalBytes) fail("EXCHANGE_LIMIT_EXCEEDED", "manifest declared bytes");
    return sum + record.size;
  }, 0);
  if (declaredBytes !== document.totalBytes) fail("EXCHANGE_CHUNK_SUBSTITUTED", "manifest totalBytes");
  const basis = { schemaVersion: document.schemaVersion, bundleId: document.bundleId, transactionId: document.transactionId, sourceWorkspaceId: document.sourceWorkspaceId, targetWorkspaceId: document.targetWorkspaceId, idempotencyKey: document.idempotencyKey, createdAt: document.createdAt, semanticSubjectDigest: document.semanticSubjectDigest, exchange: document.exchange, chunks: document.chunks, totalBytes: document.totalBytes };
  if (canonicalSha256(basis) !== document.manifestDigest) fail("EXCHANGE_CHUNK_SUBSTITUTED", "manifestDigest");
  return document;
}

function validateStoredChunkRecord(value: unknown, position: number): CanonicalExchangeChunkRecord {
  exactFields(value, ["id", "index", "logicalPath", "storedPath", "mediaType", "size", "sha256", "semanticDigest"], `chunk record:${position}`);
  const record = value as unknown as CanonicalExchangeChunkRecord;
  stableId(record.id, `chunk id:${position}`);
  logicalPath(record.logicalPath);
  if (record.index !== position || !Number.isSafeInteger(record.index) || !Number.isSafeInteger(record.size) || record.size < 0) fail("EXCHANGE_INPUT_INVALID", `chunk record:${position}`);
  if (record.size > CANONICAL_EXCHANGE_LIMITS.maximumChunkBytes) fail("EXCHANGE_LIMIT_EXCEEDED", `chunk size:${position}`);
  if (typeof record.storedPath !== "string" || !/^chunks\/[0-9]{4}-[a-f0-9]{16}\.chunk$/u.test(record.storedPath)) fail("EXCHANGE_PATH_INVALID", `storedPath:${position}`);
  wellFormed(record.storedPath, `storedPath:${position}`);
  if (record.mediaType !== "application/json" && record.mediaType !== "text/plain; charset=utf-8") fail("EXCHANGE_INPUT_INVALID", `chunk mediaType:${position}`);
  digest(record.sha256, `chunk sha256:${position}`);
  digest(record.semanticDigest, `chunk semanticDigest:${position}`);
  return record;
}

function validateStoredTransaction(value: unknown): CanonicalExchangeTransaction {
  exactFields(value, ["schemaVersion", "transactionId", "bundleId", "idempotencyKey", "manifestDigest", "chunkCount", "totalBytes", "phase", "transactionDigest"], "transaction");
  const transaction = value as unknown as CanonicalExchangeTransaction;
  if (transaction.schemaVersion !== CANONICAL_EXCHANGE_TRANSACTION_VERSION || transaction.phase !== "committed" || !Number.isSafeInteger(transaction.chunkCount) || transaction.chunkCount < 1 || transaction.chunkCount > CANONICAL_EXCHANGE_LIMITS.maximumChunks || !Number.isSafeInteger(transaction.totalBytes) || transaction.totalBytes < 0 || transaction.totalBytes > CANONICAL_EXCHANGE_LIMITS.maximumTotalBytes) fail("EXCHANGE_INPUT_INVALID", "transaction");
  stableId(transaction.transactionId, "transaction.transactionId");
  stableId(transaction.bundleId, "transaction.bundleId");
  stableId(transaction.idempotencyKey, "transaction.idempotencyKey");
  digest(transaction.manifestDigest, "transaction.manifestDigest");
  digest(transaction.transactionDigest, "transaction.transactionDigest");
  return transaction;
}

function validateStoredResume(value: unknown): CanonicalExchangeResume {
  exactFields(value, ["schemaVersion", "transactionId", "bundleId", "manifestDigest", "completedChunkIds", "remainingChunkIds", "resumeDigest"], "resume");
  const resume = value as unknown as CanonicalExchangeResume;
  if (resume.schemaVersion !== CANONICAL_EXCHANGE_RESUME_VERSION || !Array.isArray(resume.completedChunkIds) || !Array.isArray(resume.remainingChunkIds) || resume.completedChunkIds.length > CANONICAL_EXCHANGE_LIMITS.maximumChunks || resume.remainingChunkIds.length > CANONICAL_EXCHANGE_LIMITS.maximumChunks) fail("EXCHANGE_INPUT_INVALID", "resume");
  stableId(resume.transactionId, "resume.transactionId");
  stableId(resume.bundleId, "resume.bundleId");
  digest(resume.manifestDigest, "resume.manifestDigest");
  for (const id of [...resume.completedChunkIds, ...resume.remainingChunkIds]) stableId(id, "resume chunk id");
  digest(resume.resumeDigest, "resume.resumeDigest");
  return resume;
}

export async function readCanonicalExchangeBundle(bundleRoot: string, options: CanonicalExchangeReadOptions = {}): Promise<CanonicalExchangeReadback> {
  if (!isAbsolute(bundleRoot) || resolve(bundleRoot) !== bundleRoot || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(basename(bundleRoot))) fail("EXCHANGE_PATH_INVALID", bundleRoot);
  const canonicalRoot = await realpath(bundleRoot).catch(() => fail("EXCHANGE_INCOMPLETE", bundleRoot));
  if (canonicalRoot !== bundleRoot) fail("EXCHANGE_LINK_INVALID", bundleRoot);
  const root = await lstat(bundleRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) fail("EXCHANGE_FILE_INVALID", bundleRoot);
  const rootEntries = await readDirectoryBound(bundleRoot, 4);
  if (JSON.stringify(rootEntries) !== JSON.stringify(["chunks", "manifest.json", "resume.json", "transaction.json"])) fail("EXCHANGE_INCOMPLETE", "bundle root files");
  const chunksRoot = join(bundleRoot, "chunks");
  const chunksDirectory = await lstat(chunksRoot).catch(() => fail("EXCHANGE_INCOMPLETE", chunksRoot));
  if (!chunksDirectory.isDirectory() || chunksDirectory.isSymbolicLink()) fail("EXCHANGE_LINK_INVALID", chunksRoot);
  const manifest = validateStoredManifest(canonicalDocument(await readBound(join(bundleRoot, "manifest.json"), CANONICAL_EXCHANGE_LIMITS.maximumManifestBytes, options), "manifest"));
  const transaction = validateStoredTransaction(canonicalDocument(await readBound(join(bundleRoot, "transaction.json"), CANONICAL_EXCHANGE_LIMITS.maximumControlBytes, options), "transaction"));
  const resume = validateStoredResume(canonicalDocument(await readBound(join(bundleRoot, "resume.json"), CANONICAL_EXCHANGE_LIMITS.maximumControlBytes, options), "resume"));
  const expectedFiles = manifest.chunks.map((entry) => basename(entry.storedPath)).sort(compareCanonicalText);
  const actualFiles = await readDirectoryBound(chunksRoot, CANONICAL_EXCHANGE_LIMITS.maximumChunks);
  if (actualFiles.length + 3 > CANONICAL_EXCHANGE_LIMITS.maximumBundleFiles) fail("EXCHANGE_LIMIT_EXCEEDED", "bundle files");
  if (new Set(actualFiles).size !== actualFiles.length) fail("EXCHANGE_CHUNK_DUPLICATE", "stored chunks");
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) fail(actualFiles.length < expectedFiles.length ? "EXCHANGE_CHUNK_MISSING" : "EXCHANGE_INCOMPLETE", "stored chunks");
  const chunks = [];
  let totalBytes = 0;
  for (const [position, record] of manifest.chunks.entries()) {
    if (totalBytes + record.size > CANONICAL_EXCHANGE_LIMITS.maximumTotalBytes) fail("EXCHANGE_LIMIT_EXCEEDED", "stored total bytes");
    await options.beforeChunkOpenForTest?.(join(bundleRoot, record.storedPath));
    const bytes = await readBound(join(bundleRoot, record.storedPath), CANONICAL_EXCHANGE_LIMITS.maximumChunkBytes, options);
    if (bytes.length !== record.size || sha256(bytes) !== record.sha256) fail("EXCHANGE_CHUNK_SUBSTITUTED", record.logicalPath);
    if (semanticDigest(bytes, record.mediaType) !== record.semanticDigest) fail("EXCHANGE_SEMANTIC_MISMATCH", record.logicalPath);
    totalBytes += bytes.length;
    chunks.push({ record, contentBase64: bytes.toString("base64") });
  }
  if (manifest.exchange.entries.length !== manifest.chunks.length) fail("EXCHANGE_CHUNK_SUBSTITUTED", "exchange entry count");
  for (const [index, entry] of manifest.exchange.entries.entries()) {
    const record = manifest.chunks[index];
    if (!record || entry.path !== record.logicalPath || entry.mediaType !== record.mediaType || entry.size !== record.size || entry.sha256 !== record.sha256) fail("EXCHANGE_CHUNK_SUBSTITUTED", `exchange entry:${index}`);
  }
  if (totalBytes !== manifest.totalBytes || totalBytes > CANONICAL_EXCHANGE_LIMITS.maximumTotalBytes) fail("EXCHANGE_LIMIT_EXCEEDED", "stored total bytes");
  const reconstructed = validateRequest({
    schemaVersion: CANONICAL_EXCHANGE_REQUEST_VERSION,
    exchange: manifest.exchange,
    transactionId: manifest.transactionId,
    sourceWorkspaceId: manifest.sourceWorkspaceId,
    targetWorkspaceId: manifest.targetWorkspaceId,
    idempotencyKey: manifest.idempotencyKey,
    semanticSubjectDigest: manifest.semanticSubjectDigest,
    chunks: chunks.map(({ record, contentBase64 }) => ({ logicalPath: record.logicalPath, mediaType: record.mediaType, contentBase64, semanticDigest: record.semanticDigest })),
  }).publicPlan;
  if (canonicalJson(reconstructed.manifest) !== canonicalJson(manifest)) fail("EXCHANGE_CHUNK_SUBSTITUTED", "derived manifest");
  const transactionBasis = { schemaVersion: transaction.schemaVersion, transactionId: transaction.transactionId, bundleId: transaction.bundleId, idempotencyKey: transaction.idempotencyKey, manifestDigest: transaction.manifestDigest, chunkCount: transaction.chunkCount, totalBytes: transaction.totalBytes, phase: transaction.phase };
  if (transaction.schemaVersion !== CANONICAL_EXCHANGE_TRANSACTION_VERSION || transaction.phase !== "committed" || transaction.transactionId !== manifest.transactionId || transaction.bundleId !== manifest.bundleId || transaction.idempotencyKey !== manifest.idempotencyKey || transaction.manifestDigest !== manifest.manifestDigest || transaction.chunkCount !== manifest.chunks.length || transaction.totalBytes !== totalBytes || canonicalSha256(transactionBasis) !== transaction.transactionDigest) fail("EXCHANGE_TRANSACTION_MISMATCH", "transaction");
  if (canonicalJson(reconstructed.transaction) !== canonicalJson(transaction)) fail("EXCHANGE_TRANSACTION_MISMATCH", "derived transaction");
  const expectedIds = manifest.chunks.map((entry) => entry.id).sort(compareCanonicalText);
  const resumeBasis = { schemaVersion: resume.schemaVersion, transactionId: resume.transactionId, bundleId: resume.bundleId, manifestDigest: resume.manifestDigest, completedChunkIds: resume.completedChunkIds, remainingChunkIds: resume.remainingChunkIds };
  if (resume.schemaVersion !== CANONICAL_EXCHANGE_RESUME_VERSION || resume.transactionId !== manifest.transactionId || resume.bundleId !== manifest.bundleId || resume.manifestDigest !== manifest.manifestDigest || JSON.stringify(resume.completedChunkIds) !== JSON.stringify(expectedIds) || !Array.isArray(resume.remainingChunkIds) || resume.remainingChunkIds.length !== 0 || canonicalSha256(resumeBasis) !== resume.resumeDigest) fail("EXCHANGE_RESUME_MISMATCH", "resume");
  if (canonicalJson(reconstructed.resume) !== canonicalJson(resume)) fail("EXCHANGE_RESUME_MISMATCH", "derived resume");
  const bundleDigest = canonicalSha256({ manifestDigest: manifest.manifestDigest, transactionDigest: transaction.transactionDigest, resumeDigest: resume.resumeDigest, chunkDigests: manifest.chunks.map((entry) => entry.sha256) });
  const planBasis = { manifest, transaction, resume, bundleDigest, fileCount: manifest.chunks.length + 3, totalBytes };
  return { reasonCode: "EXCHANGE_BUNDLE_VERIFIED", ...planBasis, planDigest: canonicalSha256(planBasis), bundleRoot, chunks };
}

export async function validateCanonicalExchangeBundle(bundleRoot: string, options: CanonicalExchangeReadOptions = {}): Promise<CanonicalExchangeReadback> {
  return readCanonicalExchangeBundle(bundleRoot, options);
}

export function dryRunCanonicalExchange(value: unknown, outputRoot: string): Readonly<{ reasonCode: "EXCHANGE_DRY_RUN_READY"; outputRoot: string; bundleDigest: string; manifestDigest: string; fileCount: number; totalBytes: number; mutation: false; network: false; codeExecution: false; dryRunDigest: string }> {
  if (!isAbsolute(outputRoot) || resolve(outputRoot) !== outputRoot) fail("EXCHANGE_PATH_INVALID", outputRoot);
  const plan = planCanonicalExchange(value);
  const basis = { outputRoot, bundleDigest: plan.bundleDigest, manifestDigest: plan.manifest.manifestDigest, fileCount: plan.fileCount, totalBytes: plan.totalBytes, mutation: false as const, network: false as const, codeExecution: false as const };
  return { reasonCode: "EXCHANGE_DRY_RUN_READY", ...basis, dryRunDigest: canonicalSha256(basis) };
}
