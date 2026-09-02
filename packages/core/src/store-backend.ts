// SPDX-License-Identifier: Apache-2.0
// STORY-177 — the knowledge/artifact store data-plane abstraction. The workspace
// control tree already rides behind a StorageBackend (STORY-174); this file gives
// the two derived stores (knowledge-core, artifact-lifecycle) the same treatment
// for their data-plane IO: the knowledge marker, metadata/body/view records, and
// artifact records. The file backend is a behaviour-preserving convergence of the
// two stores' former private helpers (readBoundRegularFile/writeExclusiveFile/
// replaceRegularFile); a Postgres backend (analogous to STORY-175) will implement
// the same interface over SQL. Claim/quarantine protocol stays file-native, exactly
// as workspace leases do — the interface only covers the data plane.
//
// The file backend is store-aware through a small profile: the two stores map the
// same physical failures to different reason-code families (KNOWLEDGE_* versus
// ARTIFACT_*), and each file type carries its own byte bound and observation hooks
// (the test seams that previously travelled on KnowledgeReadOptions/ArtifactScanOptions).
// The profile is supplied by the constructing store, so the byte behaviour is
// unchanged; the STORY-176-style equivalence gate can later swap in a PG backend
// through withStoreBackendFactory.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { assertCanonicalJson, canonicalJson, canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";

export interface StoreBackend {
  // knowledge marker (store.json)
  readKnowledgeMarker(): Promise<Buffer>;
  writeKnowledgeMarker(bytes: Buffer | string): Promise<void>;
  // knowledge metadata records (metadata/*.json)
  listKnowledgeMetadata(): Promise<string[]>;
  readKnowledgeMetadata(id: string): Promise<Buffer>;
  writeKnowledgeMetadata(id: string, bytes: Buffer | string): Promise<void>;
  // knowledge bodies (bodies/*.body)
  listKnowledgeBodies(): Promise<string[]>;
  readKnowledgeBody(id: string): Promise<Buffer>;
  writeKnowledgeBody(id: string, bytes: Buffer | string): Promise<void>;
  // knowledge views (views/index.json)
  readKnowledgeView(): Promise<Buffer>;
  writeKnowledgeView(bytes: Buffer | string): Promise<void>;
  // artifact marker (store.json)
  readArtifactMarker(): Promise<Buffer>;
  writeArtifactMarker(bytes: Buffer | string): Promise<void>;
  // artifact records (records/*.json)
  listArtifactRecords(): Promise<string[]>;
  readArtifactRecord(id: string): Promise<Buffer>;
  writeArtifactRecord(id: string, bytes: Buffer | string): Promise<void>;
}

/** The failure shape the file backend raises. The two stores' own error classes
 * (KnowledgeCoreError/ArtifactLifecycleError) carry the same reason-code strings,
 * so a StoreBackendError with the store's code is indistinguishable to the
 * reason-code assertions the suite relies on. */
export class StoreBackendError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "StoreBackendError";
    this.reasonCode = reasonCode;
  }
}

export interface StoreBackendObservationHooks {
  readonly beforeDescriptorReadForTest?: ((path: string) => Promise<void>) | undefined;
  readonly afterDescriptorOpenForTest?: ((path: string) => Promise<void>) | undefined;
  readonly afterDescriptorReadForTest?: ((path: string) => Promise<void>) | undefined;
}

export interface FileStoreBackendProfile {
  readonly reasonCodes: {
    readonly pathInvalid: string;
    readonly linkUnsafe: string;
    readonly specialFile: string;
    readonly limitExceeded: string;
    readonly sourceChanged: string;
    readonly alreadyExists: string;
  };
  readonly limits: {
    readonly markerBytes: number;
    readonly metadataBytes: number;
    readonly bodyBytes: number;
    readonly viewBytes: number;
    readonly recordBytes: number;
  };
}

// STORY-177: a package-private backend-factory override so an equivalence gate can
// run the SAME store verbs against a PG backend and compare byte output to the file
// backend, mirroring workspace.ts's withStorageBackendFactory. Scope is one async
// operation (AsyncLocalStorage); production callers never arm it.
const storeBackendFactoryOverride = new AsyncLocalStorage<() => StoreBackend>();

export function withStoreBackendFactory<T>(factory: () => StoreBackend, operation: () => Promise<T>): Promise<T> {
  if (storeBackendFactoryOverride.getStore() !== undefined) {
    throw new Error("store backend factory nesting is unsupported");
  }
  return storeBackendFactoryOverride.run(factory, operation);
}

/** Resolve the active backend for a store operation: the injected factory wins,
 * otherwise the converged file backend. The profile carries the store's reason
 * codes, per-file byte bounds, and the observation hooks a call's options passed. */
export function resolveStoreBackend(
  storeRoot: string,
  profile: FileStoreBackendProfile,
  hooks: StoreBackendObservationHooks = {},
): StoreBackend {
  const factory = storeBackendFactoryOverride.getStore();
  if (factory !== undefined) return factory();
  return new SegmentedKnowledgeStoreBackend(new FileStoreBackend(storeRoot, profile, hooks));
}

interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface FileSnapshot extends FileIdentity {
  readonly size: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface BoundBytes {
  readonly bytes: Buffer;
  readonly identity: FileIdentity;
}

/**
 * The file backend: the exact byte behaviour of the two stores' former private
 * helpers, unchanged. This is the "file backend converged behind the interface"
 * half of STORY-177 — a behaviour-preserving move, not a rewrite. The hardened read
 * is the knowledge-core variant (which is the superset of the two stores' shared
 * logic); the unified write covers both the exclusive-create call sites (init,
 * create, restore) and the atomic-replace call sites (mutation verbs), choosing the
 * branch by whether the target already exists. Every write goes through this path so
 * the two backends stay byte-equivalent.
 */
export class FileStoreBackend implements StoreBackend {
  private readonly storeRoot: string;
  private readonly codes: FileStoreBackendProfile["reasonCodes"];
  private readonly limits: FileStoreBackendProfile["limits"];
  private readonly hooks: StoreBackendObservationHooks;

  constructor(storeRoot: string, profile: FileStoreBackendProfile, hooks: StoreBackendObservationHooks = {}) {
    this.storeRoot = storeRoot;
    this.codes = profile.reasonCodes;
    this.limits = profile.limits;
    this.hooks = hooks;
  }

  // ---- knowledge ----

  async readKnowledgeMarker(): Promise<Buffer> {
    return (await this.readBoundRegularFile(this.path("store.json"), this.limits.markerBytes)).bytes;
  }

  async writeKnowledgeMarker(bytes: Buffer | string): Promise<void> {
    await this.writeAtomic(this.path("store.json"), bytes);
  }

  async listKnowledgeMetadata(): Promise<string[]> {
    return this.listDirectory("metadata");
  }

  async readKnowledgeMetadata(id: string): Promise<Buffer> {
    return (await this.readBoundRegularFile(this.path(`metadata/${id}.json`), this.limits.metadataBytes)).bytes;
  }

  async writeKnowledgeMetadata(id: string, bytes: Buffer | string): Promise<void> {
    await this.writeAtomic(this.path(`metadata/${id}.json`), bytes);
  }

  async listKnowledgeBodies(): Promise<string[]> {
    return this.listDirectory("bodies");
  }

  async readKnowledgeBody(id: string): Promise<Buffer> {
    return (await this.readBoundRegularFile(this.path(`bodies/${id}.body`), this.limits.bodyBytes)).bytes;
  }

  async writeKnowledgeBody(id: string, bytes: Buffer | string): Promise<void> {
    await this.writeAtomic(this.path(`bodies/${id}.body`), bytes);
  }

  // STORY-341: the segmented knowledge backend reuses the same bounded path and
  // atomic-write primitives for its body segments and sidecars. These methods
  // intentionally stay outside StoreBackend so ordinary store verbs retain the
  // legacy record interface while the pluggable local implementation can own
  // its physical layout.
  async listKnowledgeBodyFiles(): Promise<string[]> {
    return this.listDirectory("bodies");
  }

  async readKnowledgeBodyFile(name: string, maximumBytes = this.limits.viewBytes || this.limits.bodyBytes): Promise<Buffer> {
    return (await this.readBoundRegularFile(this.path(`bodies/${name}`), maximumBytes)).bytes;
  }

  async writeKnowledgeBodyFile(name: string, bytes: Buffer | string): Promise<void> {
    await this.writeAtomic(this.path(`bodies/${name}`), bytes);
  }

  async removeKnowledgeBodyFile(name: string): Promise<void> {
    const path = this.path(`bodies/${name}`);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw new StoreBackendError(this.codes.pathInvalid, `${path}:${String(error)}`);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new StoreBackendError(this.codes.linkUnsafe, path);
    await rm(path);
  }

  async readKnowledgeView(): Promise<Buffer> {
    return (await this.readBoundRegularFile(this.path("views/index.json"), this.limits.viewBytes)).bytes;
  }

  async writeKnowledgeView(bytes: Buffer | string): Promise<void> {
    await this.writeAtomic(this.path("views/index.json"), bytes);
  }

  // ---- artifact ----

  async readArtifactMarker(): Promise<Buffer> {
    return (await this.readBoundRegularFile(this.path("store.json"), this.limits.markerBytes)).bytes;
  }

  async writeArtifactMarker(bytes: Buffer | string): Promise<void> {
    await this.writeAtomic(this.path("store.json"), bytes);
  }

  async listArtifactRecords(): Promise<string[]> {
    return this.listDirectory("records");
  }

  async readArtifactRecord(id: string): Promise<Buffer> {
    return (await this.readBoundRegularFile(this.path(`records/${id}.json`), this.limits.recordBytes)).bytes;
  }

  async writeArtifactRecord(id: string, bytes: Buffer | string): Promise<void> {
    await this.writeAtomic(this.path(`records/${id}.json`), bytes);
  }

  // ---- shared file primitives ----

  private path(relativePath: string): string {
    this.assertRelativePath(relativePath);
    const candidate = resolve(this.storeRoot, relativePath);
    if (!this.inside(this.storeRoot, candidate)) {
      throw new StoreBackendError(this.codes.pathInvalid, relativePath);
    }
    return candidate;
  }

  private assertRelativePath(value: string): asserts value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.startsWith("/") || value.includes("\\")) {
      throw new StoreBackendError(this.codes.pathInvalid, value);
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new StoreBackendError(this.codes.pathInvalid, value);
    }
  }

  private inside(parent: string, candidate: string): boolean {
    const relation = relative(parent, candidate);
    return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
  }

  private sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino;
  }

  private snapshot(value: FileSnapshot): FileSnapshot {
    return { dev: value.dev, ino: value.ino, size: value.size, mode: value.mode, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs };
  }

  private sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
    return this.sameIdentity(left, right) && left.size === right.size && left.mode === right.mode &&
      left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
  }

  private async boundDirectory(path: string, parent?: string): Promise<string> {
    let before;
    try {
      before = await lstat(path);
    } catch (error) {
      throw new StoreBackendError(this.codes.pathInvalid, `${path}:${String((error as { code?: string }).code ?? error)}`);
    }
    if (before.isSymbolicLink()) {
      throw new StoreBackendError(this.codes.linkUnsafe, path);
    }
    if (!before.isDirectory()) {
      throw new StoreBackendError(this.codes.specialFile, path);
    }
    const canonical = await realpath(path);
    if (parent && !this.inside(parent, canonical)) {
      throw new StoreBackendError(this.codes.pathInvalid, path);
    }
    const after = await lstat(canonical);
    if (!after.isDirectory() || after.isSymbolicLink() || !this.sameIdentity(before, after)) {
      throw new StoreBackendError(this.codes.sourceChanged, path);
    }
    return canonical;
  }

  private async listDirectory(relativePath: string): Promise<string[]> {
    const root = await this.boundDirectory(this.path(relativePath));
    const entries = await readdir(root);
    // Canonical byte order; compareCanonicalText lives in protocol's index but
    // importing it here would pull the whole protocol module. The store re-sorts
    // anyway; a plain UTF-8 compare is behaviour-identical for the ASCII .json/.body
    // names the stores enumerate.
    entries.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return entries;
  }

  private async readBoundRegularFile(path: string, maximumBytes: number): Promise<BoundBytes> {
    let before;
    try {
      before = await lstat(path, { bigint: true });
    } catch (error) {
      throw new StoreBackendError(this.codes.pathInvalid, `${path}:${String((error as { code?: string }).code ?? error)}`);
    }
    if (before.isSymbolicLink()) {
      throw new StoreBackendError(this.codes.linkUnsafe, path);
    }
    if (!before.isFile()) {
      throw new StoreBackendError(this.codes.specialFile, path);
    }
    if (before.nlink !== 1n) {
      throw new StoreBackendError(this.codes.linkUnsafe, path);
    }
    const maximum = BigInt(maximumBytes);
    if (before.size > maximum) {
      throw new StoreBackendError(this.codes.limitExceeded, `${path}:${before.size}`);
    }
    const beforeSnapshot = this.snapshot(before);
    await this.hooks.beforeDescriptorReadForTest?.(path);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.size > maximum || !this.sameSnapshot(beforeSnapshot, opened)) {
        throw new StoreBackendError(opened.size > maximum ? this.codes.limitExceeded : this.codes.sourceChanged, path);
      }
      const openedSnapshot = this.snapshot(opened);
      await this.hooks.afterDescriptorOpenForTest?.(path);
      const bytes = await handle.readFile();
      await this.hooks.afterDescriptorReadForTest?.(path);
      const after = await handle.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      if (BigInt(bytes.length) > maximum || after.size > maximum || named.size > maximum) {
        throw new StoreBackendError(this.codes.limitExceeded, path);
      }
      if (BigInt(bytes.length) !== openedSnapshot.size || !this.sameSnapshot(openedSnapshot, after) || !this.sameSnapshot(openedSnapshot, named) ||
        named.isSymbolicLink() || !named.isFile() || named.nlink !== 1n) {
        throw new StoreBackendError(this.codes.sourceChanged, path);
      }
      return { bytes, identity: { dev: opened.dev, ino: opened.ino } };
    } catch (error) {
      if (error instanceof StoreBackendError) {
        throw error;
      }
      // Thrown inline rather than through a helper: TypeScript's reachability
      // analysis stops honouring a never-returning call in a catch clause once the
      // statement carries a finally block, so routing through one here would make
      // the function look like it can fall off the end.
      throw new StoreBackendError(this.codes.sourceChanged, `${path}:${String(error)}`);
    } finally {
      await handle?.close();
    }
  }

  private async writeAtomic(path: string, bytes: Buffer | string): Promise<void> {
    let existing;
    try {
      existing = await lstat(path);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        throw new StoreBackendError(this.codes.pathInvalid, `${path}:${String(error)}`);
      }
      existing = undefined;
    }
    if (existing !== undefined) {
      // Replace branch: the mutation-verb call sites (create marker/metadata/view,
      // promote/retire/rebase/reverify metadata and marker). Mirrors the stores'
      // replaceRegularFile: the target must be a safe single-link regular file.
      if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
        throw new StoreBackendError(existing.isSymbolicLink() || existing.nlink !== 1 ? this.codes.linkUnsafe : this.codes.specialFile, path);
      }
      const temporaryPath = resolve(dirname(path), `.tmp-${randomBytes(12).toString("hex")}`);
      const temporary = await this.writeExclusive(temporaryPath, bytes);
      try {
        const rebound = await lstat(path);
        if (!this.sameIdentity(existing, rebound) || rebound.isSymbolicLink() || !rebound.isFile() || rebound.nlink !== 1) {
          throw new StoreBackendError(this.codes.sourceChanged, path);
        }
        await rename(temporaryPath, path);
        const named = await lstat(path);
        if (!this.sameIdentity(named, temporary) || named.isSymbolicLink() || !named.isFile() || named.nlink !== 1) {
          throw new StoreBackendError(this.codes.sourceChanged, path);
        }
        await this.syncDirectory(dirname(path));
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      return;
    }
    // Create branch: the exclusive-create call sites (init marker/view, create body,
    // restore records). Mirrors the stores' writeExclusiveFile.
    await this.writeExclusive(path, bytes);
  }

  private async writeExclusive(path: string, bytes: Buffer | string): Promise<FileIdentity> {
    const parent = await this.boundDirectory(dirname(path));
    const parentBefore = await lstat(parent);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) {
        throw new StoreBackendError(this.codes.linkUnsafe, path);
      }
      await handle.close();
      handle = undefined;
      const named = await lstat(path);
      const parentAfter = await lstat(parent);
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !this.sameIdentity(opened, named) || !this.sameIdentity(parentBefore, parentAfter)) {
        throw new StoreBackendError(this.codes.sourceChanged, path);
      }
      await this.syncDirectory(parent);
      return { dev: named.dev, ino: named.ino };
    } catch (error) {
      await handle?.close();
      if ((error as { code?: string }).code === "EEXIST") {
        throw new StoreBackendError(this.codes.alreadyExists, path);
      }
      if (error instanceof StoreBackendError) {
        throw error;
      }
      throw new StoreBackendError(this.codes.pathInvalid, `${path}:${String(error)}`);
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

interface SegmentedKnowledgeBodyLocation {
  readonly segment: string;
  readonly offset: number;
  readonly length: number;
}

interface SegmentedKnowledgeBodyManifest {
  readonly schemaVersion: "tcrn.knowledge-body-manifest.v1";
  readonly segments: readonly { readonly name: string; readonly bytes: number; readonly records: number; readonly sha256: string }[];
  readonly count: number;
  readonly indexDigest: string;
}

function segmentedBodySha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function segmentedBodyObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * STORY-341: a local body backend that automatically reads the legacy one-file
 * layout until a manifest is present, then uses NDJSON plus point indexes. The
 * StoreBackend surface is unchanged, so knowledge-core does not know which
 * physical layout is active.
 */
export class SegmentedKnowledgeStoreBackend implements StoreBackend {
  constructor(private readonly delegate: FileStoreBackend) {}

  readKnowledgeMarker(): Promise<Buffer> { return this.delegate.readKnowledgeMarker(); }
  writeKnowledgeMarker(bytes: Buffer | string): Promise<void> { return this.delegate.writeKnowledgeMarker(bytes); }
  listKnowledgeMetadata(): Promise<string[]> { return this.delegate.listKnowledgeMetadata(); }
  readKnowledgeMetadata(id: string): Promise<Buffer> { return this.delegate.readKnowledgeMetadata(id); }
  writeKnowledgeMetadata(id: string, bytes: Buffer | string): Promise<void> { return this.delegate.writeKnowledgeMetadata(id, bytes); }
  readKnowledgeView(): Promise<Buffer> { return this.delegate.readKnowledgeView(); }
  writeKnowledgeView(bytes: Buffer | string): Promise<void> { return this.delegate.writeKnowledgeView(bytes); }
  readArtifactMarker(): Promise<Buffer> { return this.delegate.readArtifactMarker(); }
  writeArtifactMarker(bytes: Buffer | string): Promise<void> { return this.delegate.writeArtifactMarker(bytes); }
  listArtifactRecords(): Promise<string[]> { return this.delegate.listArtifactRecords(); }
  readArtifactRecord(id: string): Promise<Buffer> { return this.delegate.readArtifactRecord(id); }
  writeArtifactRecord(id: string, bytes: Buffer | string): Promise<void> { return this.delegate.writeArtifactRecord(id, bytes); }

  async listKnowledgeBodies(): Promise<string[]> {
    const manifest = await this.readSegmentedManifest();
    if (manifest === null) return this.delegate.listKnowledgeBodies();
    const ids = new Set<string>();
    for (const segment of manifest.segments) {
      const index = await this.readSegmentedIndex(segment.name);
      for (const id of Object.keys(index)) ids.add(id);
    }
    return [...ids].sort(compareCanonicalText).map((id) => `${id}.body`);
  }

  async readKnowledgeBody(id: string): Promise<Buffer> {
    const manifest = await this.readSegmentedManifest();
    if (manifest === null) return this.delegate.readKnowledgeBody(id);
    for (const segment of manifest.segments) {
      const index = await this.readSegmentedIndex(segment.name);
      const location = index[id];
      if (location === undefined) continue;
      const bytes = await this.delegate.readKnowledgeBodyFile(segment.name, Math.max(16_777_216, segment.bytes));
      if (bytes.length !== segment.bytes || segmentedBodySha256(bytes) !== segment.sha256) throw new StoreBackendError("KNOWLEDGE_SOURCE_CHANGED", segment.name);
      const line = bytes.subarray(location.offset, location.offset + location.length).toString("utf8");
      const value = assertCanonicalJson(line);
      if (!segmentedBodyObject(value) || value.id !== id || typeof value.body !== "string") throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", id);
      return Buffer.from(value.body, "utf8");
    }
    throw new StoreBackendError("KNOWLEDGE_PATH_INVALID", `body ${id} is unavailable`);
  }

  async writeKnowledgeBody(id: string, bytes: Buffer | string): Promise<void> {
    const manifest = await this.readSegmentedManifest();
    if (manifest === null) return this.delegate.writeKnowledgeBody(id, bytes);
    const records: { readonly id: string; readonly bytes: Buffer }[] = [];
    for (const name of await this.listKnowledgeBodies()) {
      const currentId = name.endsWith(".body") ? name.slice(0, -5) : name;
      records.push({ id: currentId, bytes: await this.readKnowledgeBody(currentId) });
    }
    const replacement = Buffer.from(bytes);
    const existing = records.findIndex((record) => record.id === id);
    if (existing < 0) records.push({ id, bytes: replacement });
    else records[existing] = { id, bytes: replacement };
    await this.writeKnowledgeBodiesSegmented(records);
  }

  async migrateKnowledgeBodies(segmentBytes = 1_048_576): Promise<{ readonly before: number; readonly after: number; readonly bodyBytes: number }> {
    const legacy = (await this.delegate.listKnowledgeBodyFiles()).filter((name) => name.endsWith(".body")).sort(compareCanonicalText);
    const records = [] as { readonly id: string; readonly bytes: Buffer }[];
    for (const name of legacy) records.push({ id: name.slice(0, -5), bytes: await this.delegate.readKnowledgeBody(name.slice(0, -5)) });
    await this.writeKnowledgeBodiesSegmented(records, segmentBytes);
    for (const record of records) {
      const readback = await this.readKnowledgeBody(record.id);
      if (!readback.equals(record.bytes)) throw new StoreBackendError("KNOWLEDGE_SOURCE_CHANGED", record.id);
    }
    for (const name of legacy) await this.delegate.removeKnowledgeBodyFile(name);
    return { before: records.length, after: await this.listKnowledgeBodies().then((ids) => ids.length), bodyBytes: records.reduce((total, record) => total + record.bytes.length, 0) };
  }

  private async readSegmentedManifest(): Promise<SegmentedKnowledgeBodyManifest | null> {
    const names = await this.delegate.listKnowledgeBodyFiles();
    const hasSegments = names.some((name) => /^\d{6}\.(?:ndjson|idx)$/u.test(name));
    if (!names.includes("manifest.json")) {
      if (hasSegments) throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", "segmented body manifest is missing");
      return null;
    }
    const value = assertCanonicalJson((await this.delegate.readKnowledgeBodyFile("manifest.json", 65_536)).toString("utf8"));
    if (!segmentedBodyObject(value) || value.schemaVersion !== "tcrn.knowledge-body-manifest.v1" || !Array.isArray(value.segments) ||
      !Number.isSafeInteger(value.count) || Number(value.count) < 0 || typeof value.indexDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.indexDigest)) {
      throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", "segmented body manifest is invalid");
    }
    const segments: Array<SegmentedKnowledgeBodyManifest["segments"][number]> = [];
    for (const raw of value.segments) {
      if (!segmentedBodyObject(raw) || typeof raw.name !== "string" || !/^\d{6}\.ndjson$/u.test(raw.name) ||
        !Number.isSafeInteger(raw.bytes) || !Number.isSafeInteger(raw.records) || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.sha256)) {
        throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", "segmented body manifest segment is invalid");
      }
      segments.push({ name: raw.name, bytes: Number(raw.bytes), records: Number(raw.records), sha256: raw.sha256 });
    }
    return { schemaVersion: "tcrn.knowledge-body-manifest.v1", segments, count: Number(value.count), indexDigest: value.indexDigest };
  }

  private async readSegmentedIndex(segmentName: string): Promise<Readonly<Record<string, SegmentedKnowledgeBodyLocation>>> {
    const value = assertCanonicalJson((await this.delegate.readKnowledgeBodyFile(segmentName.replace(".ndjson", ".idx"), 1_048_576)).toString("utf8"));
    if (!segmentedBodyObject(value) || value.schemaVersion !== "tcrn.knowledge-body-index.v1" || !segmentedBodyObject(value.entries)) {
      throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", `${segmentName} index`);
    }
    const entries: Record<string, SegmentedKnowledgeBodyLocation> = {};
    for (const [id, raw] of Object.entries(value.entries)) {
      if (!segmentedBodyObject(raw) || typeof raw.segment !== "string" || raw.segment !== segmentName || !Number.isSafeInteger(raw.offset) || !Number.isSafeInteger(raw.length) || Number(raw.offset) < 0 || Number(raw.length) < 1) {
        throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", `${segmentName} index entry`);
      }
      entries[id] = { segment: raw.segment, offset: Number(raw.offset), length: Number(raw.length) };
    }
    return entries;
  }

  private async writeKnowledgeBodiesSegmented(records: readonly { readonly id: string; readonly bytes: Buffer }[], segmentBytes = 1_048_576): Promise<void> {
    if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 4096) throw new StoreBackendError("KNOWLEDGE_LIMIT_EXCEEDED", "body segment size");
    const sorted = [...records].sort((left, right) => compareCanonicalText(left.id, right.id));
    const chunks: { readonly id: string; readonly bytes: Buffer }[][] = [];
    let chunk: { readonly id: string; readonly bytes: Buffer }[] = [];
    let used = 0;
    for (const record of sorted) {
      const line = canonicalJson({ id: record.id, body: record.bytes.toString("utf8") });
      if (chunk.length > 0 && used + Buffer.byteLength(line, "utf8") > segmentBytes) {
        chunks.push(chunk);
        chunk = [];
        used = 0;
      }
      chunk.push(record);
      used += Buffer.byteLength(line, "utf8");
    }
    if (chunk.length > 0) chunks.push(chunk);
    const segments: Array<SegmentedKnowledgeBodyManifest["segments"][number]> = [];
    const indexDocuments: JsonValue[] = [];
    for (const [index, part] of chunks.entries()) {
      const name = `${String(index + 1).padStart(6, "0")}.ndjson`;
      const content = Buffer.from(part.map((record) => canonicalJson({ id: record.id, body: record.bytes.toString("utf8") })).join(""), "utf8");
      const entries: Record<string, SegmentedKnowledgeBodyLocation> = {};
      let offset = 0;
      for (const record of part) {
        const length = Buffer.byteLength(canonicalJson({ id: record.id, body: record.bytes.toString("utf8") }), "utf8");
        entries[record.id] = { segment: name, offset, length };
        offset += length;
      }
      await this.delegate.writeKnowledgeBodyFile(name, content);
      const indexDocument = { schemaVersion: "tcrn.knowledge-body-index.v1", entries } as unknown as JsonValue;
      await this.delegate.writeKnowledgeBodyFile(name.replace(".ndjson", ".idx"), canonicalJson(indexDocument));
      indexDocuments.push(indexDocument);
      segments.push({ name, bytes: content.length, records: part.length, sha256: segmentedBodySha256(content) });
    }
    for (const name of await this.delegate.listKnowledgeBodyFiles()) {
      if ((/^\d{6}\.(?:ndjson|idx)$/u.test(name)) && !segments.some((segment) => segment.name === name || segment.name.replace(".ndjson", ".idx") === name)) {
        await this.delegate.removeKnowledgeBodyFile(name);
      }
    }
    const manifest = { schemaVersion: "tcrn.knowledge-body-manifest.v1", segments, count: sorted.length, indexDigest: canonicalSha256(indexDocuments) };
    await this.delegate.writeKnowledgeBodyFile("manifest.json", canonicalJson(manifest));
  }
}
