// SPDX-License-Identifier: Apache-2.0
// STORY-174 — the storage abstraction. ADR 0004 §1 fixes the interface
// granularity: metadata read/write, segment read/append, view write, and the
// control-root directory skeleton. The file backend implements this interface
// on top of the four IO helpers that previously lived as workspace.ts privates
// (boundDirectory/boundFile/ensureDirectory/atomicWrite); the Postgres backend
// (STORY-175) implements the same interface over SQL. Every write goes through
// this interface so the two backends stay byte-equivalent (STORY-176 gate).

import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { PROTOCOL_LIMITS } from "../../protocol/src/index.js";

export const WORKSPACE_CONTROL_DIRECTORY = ".tcrn-workflow" as const;

export type WorkspaceCrashPoint =
  | "before-write"
  | "after-temp-sync"
  | "after-event-commit"
  | "before-view-commit";

/** The failure the file backend raises. Same shape as workspace.ts's
 * WorkspaceError so tests asserting `error.reasonCode` keep working — the PG
 * backend (STORY-175) maps SQL failures to these same reason codes. */
export class StorageError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "StorageError";
    this.reasonCode = reasonCode;
  }
}

export interface StorageBackend {
  /** Read the workspace.json metadata bytes, fail-closed on any unsafe file. */
  readMetadataBytes(): Promise<Buffer>;
  /** Atomically replace workspace.json. */
  writeMetadataBytes(content: Buffer, crashAt?: WorkspaceCrashPoint): Promise<void>;
  /** The event segment file names, in canonical byte order. The engine layer
   * validates shape/gaps; the backend only enumerates. */
  listSegmentNames(): Promise<string[]>;
  /** Read one event segment's bytes. */
  readSegment(name: string): Promise<Buffer>;
  /** Atomically append/replace one event segment. */
  writeSegment(name: string, content: Buffer, crashAt?: WorkspaceCrashPoint): Promise<void>;
  /** Read one derived view's bytes. */
  readView(name: string): Promise<Buffer>;
  /** Atomically write one derived view. */
  writeView(name: string, content: string, crashAt?: WorkspaceCrashPoint): Promise<void>;
  /** INC-085: enumerate the derived view names, in canonical byte order. The
   * migration and ADR-0004 §9 criterion-4 equivalence need the full view set,
   * not just the views a caller happens to know about. */
  listViewNames(): Promise<string[]>;
  /** Ensure a control-tree directory exists (mode 0700), fail-closed on symlink. */
  ensureControlDirectory(relativePath: string): Promise<void>;
}

/**
 * The file backend: the exact byte behaviour of the previous workspace.ts
 * privates, unchanged. This is the "file backend converged behind the
 * interface" half of STORY-174 — a behaviour-preserving move, not a rewrite.
 * The four helpers (boundDirectory/boundFile/ensureDirectory/atomicWrite) moved
 * here verbatim; their fail-closed semantics (symlink rejection, single-link
 * enforcement, dev/ino identity checks, fsync+rename+identity-verify) are the
 * guarantees the PG backend must reproduce.
 */
export class FileBackend implements StorageBackend {
  constructor(
    private readonly workspaceRoot: string,
    private readonly injectedCrashAt?: (phase: WorkspaceCrashPoint) => boolean,
    // STORY-174 red leg: an injectable one-byte deviation on segment reads. When
    // set, the returned segment bytes differ from disk by one byte, which must
    // make validateEventChain red (WORKSPACE_EVENT_CORRUPT) — proving the
    // abstraction layer is on the data path. Off by default; no production path
    // constructs a backend with it.
    private readonly injectSegmentByteDeviation?: boolean,
  ) {}

  async readMetadataBytes(): Promise<Buffer> {
    return this.boundFile(this.controlPath("workspace.json"));
  }

  async writeMetadataBytes(content: Buffer, crashAt?: WorkspaceCrashPoint): Promise<void> {
    await this.atomicWrite(this.controlPath("workspace.json"), content, crashAt);
  }

  async listSegmentNames(): Promise<string[]> {
    const root = await this.boundDirectory(this.controlPath("events"));
    const entries = await readdir(root, { withFileTypes: true });
    entries.sort((left, right) => this.compare(left.name, right.name));
    return entries.map((entry) => entry.name);
  }

  async readSegment(name: string): Promise<Buffer> {
    const content = await this.boundFile(this.controlPath(`events/${name}`));
    if (this.injectSegmentByteDeviation && content.length > 0) {
      const deviated = Buffer.from(content);
      const first = deviated[0] ?? 0x7b;
      deviated[0] = first === 0x7b ? 0x7c : first + 1; // `{` → `|`
      return deviated;
    }
    return content;
  }

  async writeSegment(name: string, content: Buffer, crashAt?: WorkspaceCrashPoint): Promise<void> {
    await this.atomicWrite(this.controlPath(`events/${name}`), content, crashAt);
  }

  async readView(name: string): Promise<Buffer> {
    return this.boundFile(this.controlPath(`views/${name}`));
  }

  async writeView(name: string, content: string, crashAt?: WorkspaceCrashPoint): Promise<void> {
    await this.atomicWrite(this.controlPath(`views/${name}`), content, crashAt);
  }

  async listViewNames(): Promise<string[]> {
    const root = await this.boundDirectory(this.controlPath("views"));
    const entries = await readdir(root, { withFileTypes: true });
    entries.sort((left, right) => this.compare(left.name, right.name));
    return entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".tmp-")).map((entry) => entry.name);
  }

  async ensureControlDirectory(relativePath: string): Promise<void> {
    await this.ensureDirectory(this.controlPath(relativePath));
  }

  // ---- the four moved helpers (verbatim behaviour) ----

  private compare(left: string, right: string): number {
    // Canonical byte order; compareCanonicalText lives in protocol's index but
    // importing it here would pull the whole protocol module. The engine layer
    // re-sorts anyway (readSegmentEvents), so a plain UTF-8 compare here is
    // behaviour-identical for the .json segment names the engine accepts.
    return left < right ? -1 : left > right ? 1 : 0;
  }

  private controlPath(relativePath: string): string {
    this.assertWorkspaceRelativePath(relativePath === "" ? WORKSPACE_CONTROL_DIRECTORY : `${WORKSPACE_CONTROL_DIRECTORY}/${relativePath}`);
    const candidate = resolve(this.workspaceRoot, WORKSPACE_CONTROL_DIRECTORY, relativePath);
    if (!this.inside(this.workspaceRoot, candidate)) {
      throw new StorageError("WORKSPACE_PATH_ESCAPE", relativePath);
    }
    return candidate;
  }

  private inside(parent: string, candidate: string): boolean {
    const relation = relative(parent, candidate);
    return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
  }

  private assertWorkspaceRelativePath(value: string): asserts value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.startsWith("/") || value.includes("\\")) {
      throw new StorageError("WORKSPACE_PATH_ESCAPE", String(value));
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new StorageError("WORKSPACE_PATH_ESCAPE", value);
    }
  }

  private async boundDirectory(path: string, workspaceRoot?: string): Promise<string> {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      throw new StorageError("WORKSPACE_PATH_INVALID", `${path}: ${String((error as { code?: string }).code ?? error)}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new StorageError("WORKSPACE_PATH_INVALID", `${path} must be a real directory`);
    }
    const resolved = await realpath(path);
    if (workspaceRoot && !this.inside(workspaceRoot, resolved)) {
      throw new StorageError("WORKSPACE_PATH_ESCAPE", path);
    }
    const after = await lstat(resolved);
    if (!after.isDirectory() || metadata.dev !== after.dev || metadata.ino !== after.ino) {
      throw new StorageError("WORKSPACE_PATH_INVALID", `${path} changed while resolving`);
    }
    return resolved;
  }

  private async boundFile(path: string, maximumBytes: number = PROTOCOL_LIMITS.maxCanonicalBytes): Promise<Buffer> {
    let before;
    try {
      before = await lstat(path);
    } catch (error) {
      throw new StorageError("WORKSPACE_PATH_INVALID", `${path}: ${String((error as { code?: string }).code ?? error)}`);
    }
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      throw new StorageError("WORKSPACE_PATH_INVALID", `${path} must be a single-link regular file`);
    }
    if (before.size > maximumBytes) {
      throw new StorageError("WORKSPACE_INPUT_OVERSIZED", path);
    }
    if (typeof constants.O_NOFOLLOW !== "number") {
      throw new StorageError("WORKSPACE_FILESYSTEM_UNSUPPORTED", "O_NOFOLLOW is unavailable");
    }
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new StorageError("WORKSPACE_PATH_INVALID", `${path} changed while opening`);
      }
      const content = await handle.readFile();
      const after = await handle.stat();
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 || content.length > maximumBytes) {
        throw new StorageError("WORKSPACE_PATH_INVALID", `${path} changed while reading`);
      }
      return content;
    } finally {
      await handle?.close();
    }
  }

  private async ensureDirectory(path: string, workspaceRoot?: string): Promise<string> {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") {
        throw error;
      }
    }
    return this.boundDirectory(path, workspaceRoot ?? this.workspaceRoot);
  }

  // Module-level temporary-sequence counter, preserved from the original
  // workspace.ts so consecutive atomicWrites in one process never collide.
  private temporarySequence = 0;

  private async atomicWrite(path: string, content: string | Buffer, crashAt?: WorkspaceCrashPoint): Promise<void> {
    this.crash("before-write", crashAt);
    const parent = await this.boundDirectory(dirname(path), this.workspaceRoot);
    if (!this.inside(parent, resolve(path))) {
      throw new StorageError("WORKSPACE_PATH_ESCAPE", path);
    }
    try {
      const existing = await lstat(path);
      if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
        throw new StorageError("WORKSPACE_PATH_INVALID", `${path} is not a safe replaceable file`);
      }
    } catch (error) {
      if (error instanceof StorageError || (error as { code?: string }).code !== "ENOENT") {
        throw error;
      }
    }
    const temporary = resolve(parent, `.tmp-${process.pid}-${this.temporarySequence += 1}`);
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(content);
      await handle.sync();
      const written = await handle.stat();
      if (!written.isFile() || written.nlink !== 1) {
        throw new StorageError("WORKSPACE_PATH_INVALID", `${temporary} is not a single-link file`);
      }
      this.crash("after-temp-sync", crashAt);
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      const committed = await lstat(path);
      if (!committed.isFile() || committed.isSymbolicLink() || committed.nlink !== 1 || committed.dev !== written.dev || committed.ino !== written.ino) {
        throw new StorageError("WORKSPACE_PATH_INVALID", `${path} does not name the committed descriptor-written file`);
      }
      const directoryHandle = await open(parent, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }

  private crash(point: WorkspaceCrashPoint, selected?: WorkspaceCrashPoint): void {
    if (point === selected || this.injectedCrashAt?.(point)) {
      throw new StorageError("WORKSPACE_FAULT_INJECTED", `injected crash at ${point}`);
    }
  }
}
