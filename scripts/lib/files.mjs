// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
        continue;
      }
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
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
  return JSON.parse(await readFile(path, "utf8"));
}

export async function sha256File(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

export async function fileRecord(path, root = repositoryRoot) {
  const metadata = await stat(path);
  return {
    path: toPosixPath(relative(root, path)),
    size: metadata.size,
    sha256: await sha256File(path),
  };
}
