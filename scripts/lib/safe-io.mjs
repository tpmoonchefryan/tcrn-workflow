// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

let temporarySequence = 0;

export class BoundaryError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "BoundaryError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, message) {
  throw new BoundaryError(reasonCode, message);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function inside(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
}

async function pathMetadata(path, reasonCode) {
  return lstat(path).catch((error) => fail(reasonCode, `${path}: ${error.code ?? error.message}`));
}

export async function readBoundRegularFile(path, {
  reasonCode,
  hardlinkReasonCode,
  pathChangedReasonCode = "INPUT_PATH_CHANGED",
  afterOpen,
} = {}) {
  const inputReason = reasonCode ?? "INPUT_INVALID";
  const hardlinkReason = hardlinkReasonCode ?? inputReason;
  const lexicalPath = resolve(path);
  const before = await pathMetadata(lexicalPath, inputReason);
  if (before.isSymbolicLink() || !before.isFile()) {
    fail(inputReason, `${lexicalPath} must be a regular non-symlink file`);
  }
  if (before.nlink !== 1) {
    fail(hardlinkReason, `${lexicalPath} must have exactly one filesystem link`);
  }
  if (typeof constants.O_NOFOLLOW !== "number") {
    fail("NOFOLLOW_UNAVAILABLE", "The pinned platform must expose O_NOFOLLOW");
  }

  let handle;
  try {
    handle = await open(lexicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    fail(inputReason, `${lexicalPath}: ${error.code ?? error.message}`);
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      fail(pathChangedReasonCode, `${lexicalPath} changed while opening`);
    }
    if (opened.nlink !== 1) {
      fail(hardlinkReason, `${lexicalPath} must have exactly one filesystem link`);
    }
    if (afterOpen) {
      await afterOpen({ path: lexicalPath, descriptor: handle.fd });
    }
    const content = await handle.readFile();
    const afterRead = await handle.stat();
    if (!sameIdentity(opened, afterRead) || afterRead.nlink !== 1) {
      fail(pathChangedReasonCode, `${lexicalPath} changed while reading`);
    }
    const pathAfter = await pathMetadata(lexicalPath, pathChangedReasonCode);
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile() || !sameIdentity(opened, pathAfter)) {
      fail(pathChangedReasonCode, `${lexicalPath} no longer names the opened file`);
    }
    const realPath = await realpath(lexicalPath).catch((error) =>
      fail(pathChangedReasonCode, `${lexicalPath}: ${error.code ?? error.message}`),
    );
    const realMetadata = await pathMetadata(realPath, pathChangedReasonCode);
    if (!sameIdentity(opened, realMetadata)) {
      fail(pathChangedReasonCode, `${lexicalPath} realpath identity changed`);
    }
    return { content, realPath, metadata: afterRead };
  } finally {
    await handle.close();
  }
}

export async function resolveBoundDirectory(path, {
  reasonCode = "DIRECTORY_INVALID",
  symlinkReasonCode = reasonCode,
} = {}) {
  const lexicalPath = resolve(path);
  const before = await pathMetadata(lexicalPath, reasonCode);
  if (before.isSymbolicLink()) {
    fail(symlinkReasonCode, `${lexicalPath} must not be a symlink`);
  }
  if (!before.isDirectory()) {
    fail(reasonCode, `${lexicalPath} must be a directory`);
  }
  const realPath = await realpath(lexicalPath).catch((error) =>
    fail(reasonCode, `${lexicalPath}: ${error.code ?? error.message}`),
  );
  const after = await pathMetadata(realPath, reasonCode);
  if (!after.isDirectory() || !sameIdentity(before, after)) {
    fail(reasonCode, `${lexicalPath} changed while resolving`);
  }
  return { realPath, metadata: after };
}

function outputSegments(relativePath) {
  if (isAbsolute(relativePath) || relativePath.includes("\\")) {
    fail("OUTPUT_PATH_INVALID", `${relativePath} must be a portable relative output path`);
  }
  const segments = relativePath.split("/");
  if (segments[0] !== "dist" || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("OUTPUT_PATH_INVALID", `${relativePath} must remain beneath dist`);
  }
  return segments;
}

async function ensureDirectory(path, repositoryReal, isDist) {
  try {
    await mkdir(path);
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  const metadata = await pathMetadata(path, "OUTPUT_DIRECTORY_INVALID");
  if (metadata.isSymbolicLink()) {
    fail("OUTPUT_DIRECTORY_SYMLINK", `${path} must not be a symlink`);
  }
  if (!metadata.isDirectory()) {
    fail("OUTPUT_DIRECTORY_INVALID", `${path} must be a directory`);
  }
  const realPath = await realpath(path);
  if (!inside(repositoryReal, realPath) || (isDist && dirname(realPath) !== repositoryReal)) {
    fail("OUTPUT_DIRECTORY_ESCAPE", `${path} resolves outside the repository output root`);
  }
  const realMetadata = await pathMetadata(realPath, "OUTPUT_DIRECTORY_INVALID");
  if (!sameIdentity(metadata, realMetadata)) {
    fail("OUTPUT_DIRECTORY_CHANGED", `${path} changed while resolving`);
  }
  return realPath;
}

export async function ensureSafeOutputDirectory(repositoryPath, relativeDirectory = "dist") {
  const segments = outputSegments(relativeDirectory === "dist" ? "dist/.sentinel" : `${relativeDirectory}/.sentinel`).slice(0, -1);
  const repository = await resolveBoundDirectory(repositoryPath, {
    reasonCode: "OUTPUT_REPOSITORY_INVALID",
    symlinkReasonCode: "OUTPUT_REPOSITORY_SYMLINK",
  });
  let current = repository.realPath;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    await ensureDirectory(current, repository.realPath, index === 0);
  }
  return current;
}

export async function safeResetOutputDirectory(repositoryPath, relativeDirectory) {
  const segments = outputSegments(`${relativeDirectory}/.sentinel`).slice(0, -1);
  if (segments.length < 2) {
    fail("OUTPUT_RESET_INVALID", "The dist root itself cannot be reset");
  }
  const parentRelative = segments.slice(0, -1).join("/");
  const parent = await ensureSafeOutputDirectory(repositoryPath, parentRelative);
  const target = resolve(parent, segments.at(-1));
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
      fail("OUTPUT_DIRECTORY_SYMLINK", `${target} must not be a symlink`);
    }
    if (!metadata.isDirectory()) {
      fail("OUTPUT_DIRECTORY_INVALID", `${target} must be a directory`);
    }
    const quarantine = resolve(parent, `.reset-${process.pid}-${temporarySequence += 1}`);
    await rename(target, quarantine);
    await rm(quarantine, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(target);
  return ensureSafeOutputDirectory(repositoryPath, relativeDirectory);
}

export async function safeWriteOutput(repositoryPath, relativePath, content, { mode = 0o600 } = {}) {
  const segments = outputSegments(relativePath);
  const directoryRelative = segments.slice(0, -1).join("/");
  const directory = await ensureSafeOutputDirectory(repositoryPath, directoryRelative);
  const target = resolve(directory, segments.at(-1));
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      fail("OUTPUT_TARGET_INVALID", `${target} must be a regular non-symlink file`);
    }
    if (existing.nlink !== 1) {
      fail("OUTPUT_TARGET_HARDLINK", `${target} must have exactly one filesystem link`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const temporary = resolve(directory, `.write-${process.pid}-${temporarySequence += 1}`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    await handle.writeFile(content);
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.nlink !== 1) {
      fail("OUTPUT_TEMP_INVALID", `${temporary} is not a single-link regular file`);
    }
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    const targetMetadata = await pathMetadata(target, "OUTPUT_TARGET_INVALID");
    if (targetMetadata.isSymbolicLink() || !targetMetadata.isFile() || targetMetadata.nlink !== 1 || !sameIdentity(written, targetMetadata)) {
      fail("OUTPUT_TARGET_CHANGED", `${target} does not name the descriptor-written file`);
    }
    const targetReal = await realpath(target);
    const distReal = await realpath(resolve(repositoryPath, "dist"));
    if (!inside(distReal, targetReal)) {
      fail("OUTPUT_TARGET_ESCAPE", `${target} resolves outside dist`);
    }
    return { path: target, metadata: targetMetadata };
  } finally {
    if (handle) {
      await handle.close();
    }
    await rm(temporary, { force: true });
  }
}

export async function safeCleanOutputRoot(repositoryPath) {
  const repository = await resolveBoundDirectory(repositoryPath, {
    reasonCode: "OUTPUT_REPOSITORY_INVALID",
    symlinkReasonCode: "OUTPUT_REPOSITORY_SYMLINK",
  });
  const dist = resolve(repository.realPath, "dist");
  try {
    const metadata = await lstat(dist);
    if (metadata.isSymbolicLink()) {
      fail("OUTPUT_DIRECTORY_SYMLINK", `${dist} must not be a symlink`);
    }
    if (!metadata.isDirectory()) {
      fail("OUTPUT_DIRECTORY_INVALID", `${dist} must be a directory`);
    }
    const distReal = await realpath(dist);
    if (dirname(distReal) !== repository.realPath) {
      fail("OUTPUT_DIRECTORY_ESCAPE", `${dist} resolves outside the repository`);
    }
    const quarantine = resolve(repository.realPath, `.dist-clean-${process.pid}-${temporarySequence += 1}`);
    await rename(dist, quarantine);
    await rm(quarantine, { recursive: true, force: true });
    return { removed: true };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { removed: false };
    }
    throw error;
  }
}
