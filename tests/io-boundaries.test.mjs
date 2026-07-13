// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
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
import { walkFiles } from "../scripts/lib/files.mjs";

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

test("source read errors fail closed", async (context) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "tcrn-source-read-")));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const path = resolve(temporary, "unreadable.txt");
  await writeFile(path, "private\n");
  await chmod(path, 0o000);
  await assert.rejects(walkFiles(temporary), (error) => error.reasonCode === "SOURCE_FILE_INVALID");
});
