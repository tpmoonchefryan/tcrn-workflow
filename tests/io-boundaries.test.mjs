// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  assertCleanExclusiveSourceBasis,
  readBoundRegularFile,
  safeResetOutputDirectory,
  safeWriteOutput,
  withExclusiveOutputSession,
} from "../scripts/lib/safe-io.mjs";
import { fileRecord, fileRecordMemoEntriesForTest, readDependencyManifest, walkFiles } from "../scripts/lib/files.mjs";

test("bound reads reject source hardlinks", async (context) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "tcrn-source-link-")));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const first = resolve(temporary, "first.txt");
  await writeFile(first, "content\n");
  await link(first, resolve(temporary, "second.txt"));
  await assert.rejects(walkFiles(temporary), (error) => error.reasonCode === "SOURCE_HARDLINK");
  await assert.rejects(
    readBoundRegularFile(first, {
      reasonCode: "INPUT_INVALID",
      hardlinkReasonCode: "INPUT_HARDLINK",
    }),
    (error) => error.reasonCode === "INPUT_HARDLINK",
  );
});

test("descriptor-bound read detects deterministic path replacement", async (context) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "tcrn-toctou-")));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const path = resolve(temporary, "input.txt");
  const replacement = resolve(temporary, "replacement.txt");
  await writeFile(path, "trusted\n");
  await writeFile(replacement, "replaced\n");
  await assert.rejects(
    readBoundRegularFile(path, {
      reasonCode: "INPUT_INVALID",
      hardlinkReasonCode: "INPUT_HARDLINK",
      afterOpen: async () => {
        await rename(replacement, path);
      },
    }),
    (error) => error.reasonCode === "INPUT_PATH_CHANGED",
  );
});

test("safe output rejects an ignored dist symlink and writes through a bound directory", async (context) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "tcrn-output-")));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(resolve(temporary, ".git"));
  const outside = resolve(temporary, "outside");
  await mkdir(outside);
  await symlink(outside, resolve(temporary, "dist"));
  await assert.rejects(
    safeWriteOutput(temporary, "dist/evidence/result.json", "unsafe\n"),
    (error) => error.reasonCode === "OUTPUT_SESSION_REQUIRED",
  );
  await assert.rejects(
    safeResetOutputDirectory(temporary, "dist/build"),
    (error) => error.reasonCode === "OUTPUT_SESSION_REQUIRED",
  );
  await withExclusiveOutputSession(temporary, async () => {
    await assert.rejects(
      safeWriteOutput(temporary, "dist/evidence/result.json", "unsafe\n"),
      (error) => error.reasonCode === "OUTPUT_DIRECTORY_SYMLINK",
    );
    await rm(resolve(temporary, "dist"));
    await safeWriteOutput(temporary, "dist/evidence/result.json", "safe\n");
    assert.equal(await readFile(resolve(temporary, "dist/evidence/result.json"), "utf8"), "safe\n");
    const alias = resolve(temporary, "result-alias.json");
    await link(resolve(temporary, "dist/evidence/result.json"), alias);
    await assert.rejects(
      safeWriteOutput(temporary, "dist/evidence/result.json", "replacement\n"),
      (error) => error.reasonCode === "OUTPUT_TARGET_HARDLINK",
    );
  });
});

test("accepted P1 basis requires a clean status", () => {
  assert.doesNotThrow(() => assertCleanExclusiveSourceBasis(""));
  assert.throws(
    () => assertCleanExclusiveSourceBasis(" M scripts/task.mjs"),
    (error) => error.reasonCode === "P1_EXCLUSIVE_SOURCE_BASIS_REQUIRED",
  );
});

test("exclusive output session preserves a foreign lock whose identity is outside recovery policy", async (context) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "tcrn-output-lock-")));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const gitDirectory = resolve(temporary, ".git");
  await mkdir(gitDirectory);
  await mkdir(resolve(gitDirectory, "tcrn-workflow-output.lock"));
  await assert.rejects(
    withExclusiveOutputSession(temporary, async () => undefined),
    (error) => error.reasonCode === "OUTPUT_SESSION_RECOVERY_IDENTITY",
  );
});

test("the file-record memo is keyed on identity that a rewrite cannot reuse", async (context) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "tcrn-file-record-memo-")));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const path = resolve(temporary, "record.txt");
  await writeFile(path, "aaaaaaaa\n");

  const first = await fileRecord(path, temporary);
  const second = await fileRecord(path, temporary);
  assert.deepEqual(second, first, "a repeated read inside one process must be byte-identical");
  assert.equal(first.path, "record.txt");

  // A same-size in-place rewrite keeps dev and ino, so a memo keyed on inode alone would
  // keep serving the stale digest for the life of the process -- and proof-artifacts'
  // record() would carry it straight into fixture digest generation.
  await writeFile(path, "bbbbbbbb\n");
  const rewritten = await fileRecord(path, temporary);
  assert.equal(rewritten.size, first.size);
  assert.notEqual(rewritten.sha256, first.sha256, "a same-size rewrite must not be served from the memo");
  assert.equal(rewritten.sha256, createHash("sha256").update("bbbbbbbb\n").digest("hex"));

  // A rewrite that lands while the read is in flight leaves the pre-read key describing
  // state the returned bytes never had. The record is still correct for what was read,
  // but it must not be cached under that key.
  const racedPath = resolve(temporary, "raced.txt");
  await writeFile(racedPath, "dddddddd\n");
  const before = fileRecordMemoEntriesForTest();
  const raced = await fileRecord(racedPath, temporary, {
    afterOpen: async () => {
      await writeFile(racedPath, "cccccccc\n");
    },
  });
  assert.equal(raced.sha256, createHash("sha256").update("cccccccc\n").digest("hex"));
  assert.equal(fileRecordMemoEntriesForTest(), before, "a read whose identity moved must not be cached");

  // Control: an undisturbed read of the same file does populate the memo, so the
  // assertion above is measuring the guard and not a memo that never caches anything.
  const settled = await fileRecord(racedPath, temporary);
  assert.equal(settled.sha256, raced.sha256);
  assert.equal(fileRecordMemoEntriesForTest(), before + 1);
});

test("source read errors fail closed", async (context) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "tcrn-source-read-")));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const path = resolve(temporary, "unreadable.txt");
  await writeFile(path, "private\n");
  await chmod(path, 0o000);
  await assert.rejects(walkFiles(temporary), (error) => error.reasonCode === "SOURCE_FILE_INVALID");
});

// The CI failure this pins was mine. Pinning a real TypeScript compiler made
// verify:p1 read node_modules/typescript/package.json through readSourceFile, which
// asserts nlink === 1. pnpm's store is content-addressable and hardlinks into
// node_modules, so every CI runner failed SOURCE_HARDLINK in 20 seconds while my machine
// stayed green -- a cross-filesystem pnpm store copies instead of linking, so the local
// nlink was 1. The environment difference hid a category error: node_modules is in
// excludedDirectories precisely because the source walk must never enter it.
test("dependency manifests may be hardlinked; tracked source still may not", async (context) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "tcrn-dep-link-")));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const manifest = resolve(temporary, "package.json");
  await writeFile(manifest, JSON.stringify({ version: "5.9.3" }));
  // Reproduce the store layout: a second link to the same inode, which is what pnpm
  // leaves behind and what the runner actually had.
  await link(manifest, resolve(temporary, "store-copy.json"));

  const parsed = await readDependencyManifest(manifest);
  assert.equal(parsed.version, "5.9.3", "a hardlinked dependency manifest must be readable");

  // The same bytes through the source reader must still be refused. The relaxation is
  // scoped to a caller that names it, not a weakening of the source boundary -- if this
  // assertion ever goes green, the guard has been dropped rather than scoped.
  await assert.rejects(
    readBoundRegularFile(manifest, { reasonCode: "SOURCE_FILE_INVALID", hardlinkReasonCode: "SOURCE_HARDLINK" }),
    (error) => error.reasonCode === "SOURCE_HARDLINK",
  );

  // A symlink is still refused with hardlinks allowed: the relaxation drops the link
  // COUNT, not the file-type guard that keeps a read from following a pointer elsewhere.
  const pointer = resolve(temporary, "pointer.json");
  await symlink(manifest, pointer);
  await assert.rejects(readDependencyManifest(pointer), (error) => error.reasonCode === "DEPENDENCY_MANIFEST_INVALID");
});
