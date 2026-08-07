// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-074 — storage-home sentinel. The class root cause of the INIT-020
// cross fork was that a workspace's backend was silently decided by the caller's
// environment: ceremony.mjs drove the engine without TCRN_PG_* env, so its writes
// landed in the file tree while the facade answered from Postgres. "Where does the
// truth live" was never declared by the thing whose truth it is.
//
// This module is the declaration. When a file→pg migration completes, the engine
// writes a canonical sentinel (`.tcrn-workflow/storage-home.json`) into the source
// file workspace saying `storage: pg` and naming the schema. From then on:
//   - the file backend refuses every MUTATING verb on that workspace with
//     WORKSPACE_STORAGE_RELOCATED (the write door is closed — the incident's exact
//     mechanism), while read-only verbs keep working so the tree stays a forensible
//     archive (INC-083);
//   - a PG-serving path (facade/CLI with TCRN_PG_*) must carry the schema the
//     sentinel names, else it refuses named — a config pointing at the wrong schema,
//     or silently falling back to the file backend, can no longer write silently.
//
// This upgrades "only the engine writes the chain" (GRANT + trigger) to the storage
// plane: "the truth's address is self-declared by the workspace and enforced by the
// engine." Same family as ADR-0003's "moving bytes without moving the binding
// produces an unreadable tree rather than a second live authority."

import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { canonicalJson } from "../../protocol/src/index.js";
import { WORKSPACE_CONTROL_DIRECTORY } from "./storage-backend.js";

export const STORAGE_HOME_VERSION = "tcrn.storage-home.v1" as const;
export const STORAGE_HOME_FILE_NAME = "storage-home.json" as const;

export interface StorageHomeDeclaration {
  readonly schemaVersion: typeof STORAGE_HOME_VERSION;
  readonly storage: "pg" | "file";
  /** The PG schema that now holds this workspace's chain. Required when storage=pg. */
  readonly schema?: string;
  readonly workspaceId?: string;
  readonly migratedAt: string;
}

export class StorageHomeError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "StorageHomeError";
    this.reasonCode = reasonCode;
  }
}

function controlFilePath(workspaceRoot: string): string {
  return resolve(workspaceRoot, WORKSPACE_CONTROL_DIRECTORY, STORAGE_HOME_FILE_NAME);
}

function inside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
}

function parseDeclaration(bytes: Buffer, path: string): StorageHomeDeclaration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new StorageHomeError("STORAGE_HOME_INVALID", `${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StorageHomeError("STORAGE_HOME_INVALID", `${path} is not an object`);
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = ["schemaVersion", "storage", "schema", "workspaceId", "migratedAt"].filter((k) => record[k] !== undefined);
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys.sort())) {
    throw new StorageHomeError("STORAGE_HOME_INVALID", `${path} fields are not exact`);
  }
  if (record.schemaVersion !== STORAGE_HOME_VERSION || (record.storage !== "pg" && record.storage !== "file")) {
    throw new StorageHomeError("STORAGE_HOME_INVALID", `${path} schemaVersion or storage is invalid`);
  }
  if (record.storage === "pg" && (typeof record.schema !== "string" || record.schema.length === 0)) {
    throw new StorageHomeError("STORAGE_HOME_INVALID", `${path} storage=pg requires a named schema`);
  }
  if (record.schema !== undefined && typeof record.schema !== "string") {
    throw new StorageHomeError("STORAGE_HOME_INVALID", `${path} schema must be a string`);
  }
  if (record.workspaceId !== undefined && typeof record.workspaceId !== "string") {
    throw new StorageHomeError("STORAGE_HOME_INVALID", `${path} workspaceId must be a string`);
  }
  if (typeof record.migratedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/u.test(String(record.migratedAt))) {
    throw new StorageHomeError("STORAGE_HOME_INVALID", `${path} migratedAt must be a strict instant`);
  }
  return record as unknown as StorageHomeDeclaration;
}

/**
 * Read the storage-home declaration, or null when the workspace carries none.
 * A malformed sentinel fails closed (STORAGE_HOME_INVALID) — a declaration that
 * cannot be read must not be treated as absent.
 */
export async function readStorageHomeDeclaration(workspaceRoot: string): Promise<StorageHomeDeclaration | null> {
  const path = controlFilePath(workspaceRoot);
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new StorageHomeError("STORAGE_HOME_INVALID", `${path}: ${String((error as { code?: string }).code ?? error)}`);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new StorageHomeError("STORAGE_HOME_INVALID", `${path} must be a single-link regular file`);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new StorageHomeError("STORAGE_HOME_INVALID", `${path} changed while opening`);
    }
    const bytes = await handle.readFile();
    return parseDeclaration(bytes, path);
  } finally {
    await handle?.close();
  }
}

/**
 * Write the storage-home declaration in canonical bytes via a temp + rename +
 * fsync sequence, the same discipline the engine uses for workspace.json. Only the
 * engine calls this (migration-execute). A declaration is written ONCE and then the
 * file backend's write door closes on this workspace.
 */
export async function writeStorageHomeDeclaration(workspaceRoot: string, declaration: StorageHomeDeclaration): Promise<void> {
  const path = controlFilePath(workspaceRoot);
  if (!inside(workspaceRoot, path)) {
    throw new StorageHomeError("STORAGE_HOME_INVALID", "sentinel path escapes the workspace");
  }
  const parent = dirname(path);
  try {
    await mkdir(parent, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  }
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new StorageHomeError("STORAGE_HOME_INVALID", `${parent} must be a real directory`);
  }
  const temporary = resolve(parent, `.tmp-storage-home-${process.pid}`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(canonicalJson(declaration));
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.nlink !== 1) {
      throw new StorageHomeError("STORAGE_HOME_INVALID", `${temporary} is not a single-link file`);
    }
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) {
      throw new StorageHomeError("STORAGE_HOME_INVALID", `${path} does not name the written sentinel`);
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

/**
 * Seal a file workspace to a Postgres home without copying the data plane.
 *
 * This is the explicit recovery operation for a retained archive whose bytes
 * are no longer a prefix of the authoritative PG chain.  It is intentionally
 * not an overwrite: a different existing declaration is a binding conflict,
 * while an identical declaration is an idempotent read-back.  The caller is
 * responsible for proving the PG head before invoking this primitive and for
 * holding the workspace lease across that proof and this write.
 */
export async function sealStorageHomeDeclaration(
  workspaceRoot: string,
  declaration: StorageHomeDeclaration,
): Promise<StorageHomeDeclaration> {
  if (declaration.storage !== "pg" || typeof declaration.schema !== "string" || declaration.schema.length === 0) {
    throw new StorageHomeError("STORAGE_HOME_INVALID", "a sealed storage-home declaration must name a PG schema");
  }
  const existing = await readStorageHomeDeclaration(workspaceRoot);
  if (existing !== null) {
    if (existing.storage !== declaration.storage || existing.schema !== declaration.schema ||
      existing.workspaceId !== declaration.workspaceId) {
      throw new StorageHomeError("STORAGE_HOME_ALREADY_BOUND", "workspace already has a different storage-home declaration");
    }
    return existing;
  }
  await writeStorageHomeDeclaration(workspaceRoot, declaration);
  const written = await readStorageHomeDeclaration(workspaceRoot);
  if (written === null || canonicalJson(written) !== canonicalJson(declaration)) {
    throw new StorageHomeError("STORAGE_HOME_INVALID", "storage-home declaration did not survive its write read-back");
  }
  return written;
}

/** Remove the sentinel — the pg→file rollback restores the file tree as live home. */
export async function removeStorageHomeDeclaration(workspaceRoot: string): Promise<void> {
  await rm(controlFilePath(workspaceRoot), { force: true });
}
