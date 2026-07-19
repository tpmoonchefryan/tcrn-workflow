// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { compareCanonicalText } from "./canonical-order.mjs";
import { BoundaryError, readBoundRegularFile } from "./safe-io.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "../..");

export const excludedDirectories = new Set([
  ".git",
  ".pnpm-store",
  "coverage",
  "dist",
  "node_modules",
]);

export function toPosixPath(value) {
  return value.split(sep).join("/");
}

export function isInside(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
}

// walkFiles returns paths, never contents, so it probes each candidate for the boundary
// properties it enforces (regular non-symlink, exactly one link, openable) and closes the
// descriptor without reading. Reading every file only to discard it re-read the whole
// tree on each of the walk's many call sites.
//
// The probe still opens with O_NOFOLLOW and still requires the guard that the pinned
// platform exposes it: dropping the open in favour of a bare lstat would let the walk
// silently traverse a symlink and would stop surfacing unreadable files at all.
// Failures are BoundaryError instances so callers keep matching on `reasonCode`; the
// previous bare `Error("SOURCE_HARDLINK:...")` carried no reasonCode and passed the
// existing assertion only because readBoundRegularFile happened to throw first.
async function probeSourceFile(absolute, root) {
  const label = toPosixPath(relative(root, absolute));
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new BoundaryError("NOFOLLOW_UNAVAILABLE", "The pinned platform must expose O_NOFOLLOW");
  }
  const before = await lstat(absolute).catch((error) => {
    throw new BoundaryError("SOURCE_FILE_INVALID", `${label}: ${error.code ?? error.message}`);
  });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new BoundaryError("SOURCE_FILE_INVALID", `${label} must be a regular non-symlink file`);
  }
  if (before.nlink !== 1) {
    throw new BoundaryError("SOURCE_HARDLINK", `${label} must have exactly one filesystem link`);
  }
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new BoundaryError("SOURCE_FILE_INVALID", `${label}: ${error.code ?? error.message}`);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new BoundaryError("SOURCE_PATH_CHANGED", `${label} changed while opening`);
    }
    if (opened.nlink !== 1) {
      throw new BoundaryError("SOURCE_HARDLINK", `${label} must have exactly one filesystem link`);
    }
  } finally {
    await handle.close();
  }
}

export async function walkFiles(root = repositoryRoot) {
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCanonicalText(left.name, right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
        continue;
      }
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        await probeSourceFile(absolute, root);
        files.push(absolute);
      } else {
        throw new BoundaryError("SOURCE_SPECIAL_FILE", toPosixPath(relative(root, absolute)));
      }
    }
  }

  await walk(root);
  return files;
}

export async function readJson(path) {
  return JSON.parse((await readSourceFile(path)).toString("utf8"));
}

const fileRecordMemo = new Map();

function identityKey(metadata) {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(":");
}

// Test seam. Whether an entry was cached is the guard under test and is otherwise
// invisible from outside, because ctime is part of the key and cannot be forged back to
// a previous value, so the poisoning sequence cannot be replayed end to end.
export function fileRecordMemoEntriesForTest() {
  return fileRecordMemo.size;
}

// A single verify run re-reads the same paths from roughly a dozen walk and hash call
// sites, so the digest is memoised on filesystem identity.
//
// The key is the bigint lstat snapshot taken BEFORE the read, and the entry is stored
// only when a post-read snapshot still matches it. Keying on the post-read snapshot
// instead would let a same-size in-place rewrite that lands during the read produce
// key(post-write state) -> sha256(pre-write bytes), stick for the life of the process,
// and flow through proof-artifacts' record() into fixtureDigest generation. Nanosecond
// mtime and ctime alongside dev/ino/size make an undetected rewrite require identical
// size and identical timestamps at nanosecond resolution.
//
// A cache hit skips readBoundRegularFile and with it the symlink, hardlink and
// path-replacement checks -- which is sound only because every one of those transitions
// moves dev/ino or ctime and therefore moves the key, forcing the full bound read.
export async function fileRecord(path, root = repositoryRoot, { afterOpen } = {}) {
  const before = await lstat(path, { bigint: true }).catch(() => null);
  const key = before === null ? null : identityKey(before);
  const cached = key === null ? undefined : fileRecordMemo.get(key);
  if (cached !== undefined) {
    return { path: toPosixPath(relative(root, path)), size: cached.size, sha256: cached.sha256 };
  }
  const opened = await readBoundRegularFile(path, {
    reasonCode: "SOURCE_FILE_INVALID",
    hardlinkReasonCode: "SOURCE_HARDLINK",
    pathChangedReasonCode: "SOURCE_PATH_CHANGED",
    ...(afterOpen ? { afterOpen } : {}),
  });
  const size = opened.metadata.size;
  const sha256 = createHash("sha256").update(opened.content).digest("hex");
  if (key !== null) {
    const after = await lstat(path, { bigint: true }).catch(() => null);
    if (after !== null && identityKey(after) === key) {
      fileRecordMemo.set(key, { size, sha256 });
    }
  }
  return { path: toPosixPath(relative(root, path)), size, sha256 };
}

export async function readSourceFile(path) {
  return (await readBoundRegularFile(path, {
    reasonCode: "SOURCE_FILE_INVALID",
    hardlinkReasonCode: "SOURCE_HARDLINK",
    pathChangedReasonCode: "SOURCE_PATH_CHANGED",
  })).content;
}

// For a manifest inside a package manager's tree, which this repository does not own.
// `node_modules` is in excludedDirectories above precisely because the source walk must
// never enter it, so pointing readSourceFile at a path under it was always a category
// error: it asserts nlink === 1 against a content-addressable store that hardlinks by
// design. It passed locally only because a cross-filesystem pnpm store copies instead,
// and failed on every CI runner. The guard it dropped also bought nothing coherent --
// the same commit asserted nlink on typescript's package.json while executing
// lib/tsc.js from that same package with no check at all.
export async function readDependencyManifest(path) {
  const content = (await readBoundRegularFile(path, {
    reasonCode: "DEPENDENCY_MANIFEST_INVALID",
    pathChangedReasonCode: "DEPENDENCY_MANIFEST_CHANGED",
    allowHardlinks: true,
  })).content;
  return JSON.parse(content.toString("utf8"));
}
