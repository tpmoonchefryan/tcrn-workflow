// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { compareCanonicalText } from "./canonical-order.mjs";
import { readBoundRegularFile } from "./safe-io.mjs";

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

export async function resolveRealPath(value) {
  return realpath(resolve(value));
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
        const opened = await readBoundRegularFile(absolute, {
          reasonCode: "SOURCE_FILE_INVALID",
          hardlinkReasonCode: "SOURCE_HARDLINK",
          pathChangedReasonCode: "SOURCE_PATH_CHANGED",
        });
        if (opened.metadata.nlink !== 1) {
          throw new Error(`SOURCE_HARDLINK:${toPosixPath(relative(root, absolute))}`);
        }
        files.push(absolute);
      } else {
        throw new Error(`SOURCE_SPECIAL_FILE:${toPosixPath(relative(root, absolute))}`);
      }
    }
  }

  await walk(root);
  return files;
}

export async function readJson(path) {
  return JSON.parse((await readSourceFile(path)).toString("utf8"));
}

export async function sha256File(path) {
  const content = await readSourceFile(path);
  return createHash("sha256").update(content).digest("hex");
}

export async function fileRecord(path, root = repositoryRoot) {
  const opened = await readBoundRegularFile(path, {
    reasonCode: "SOURCE_FILE_INVALID",
    hardlinkReasonCode: "SOURCE_HARDLINK",
    pathChangedReasonCode: "SOURCE_PATH_CHANGED",
  });
  return {
    path: toPosixPath(relative(root, path)),
    size: opened.metadata.size,
    sha256: createHash("sha256").update(opened.content).digest("hex"),
  };
}

export async function readSourceFile(path) {
  return (await readBoundRegularFile(path, {
    reasonCode: "SOURCE_FILE_INVALID",
    hardlinkReasonCode: "SOURCE_HARDLINK",
    pathChangedReasonCode: "SOURCE_PATH_CHANGED",
  })).content;
}
