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
import { randomBytes } from "node:crypto";
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
  return new FileStoreBackend(storeRoot, profile, hooks);
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
