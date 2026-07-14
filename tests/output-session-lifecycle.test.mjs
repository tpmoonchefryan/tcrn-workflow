// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, chmod, cp, lstat, link, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, symlink, truncate, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { admitLegacyOutputSessionReceipt, bindOutputSessionProcessGroup, readBoundClaim, recoverStaleOutputSessionLock, safeWriteOutput, withExclusiveOutputSession } from "../scripts/lib/safe-io.mjs";

const ownerSchema = "tcrn.output-session-owner.v1";
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "tcrn-output-session-"));
  await mkdir(resolve(root, ".git"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

async function shortFixture(context) {
  // Unix-domain socket paths are capped on macOS. Keep the hostile-claim
  // corpus beneath /tmp so socket coverage is deterministic rather than
  // conditionally skipped due solely to the system temporary-root length.
  const root = await mkdtemp("/tmp/tcrn-os-");
  await mkdir(resolve(root, ".git"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function lockPath(root) {
  return resolve(root, ".git/tcrn-workflow-output.lock");
}

function recoveryClaimPath(root) {
  return resolve(root, ".git/.tcrn-workflow-output-recovery-claim");
}

function acquisitionClaimPath(root) {
  return resolve(root, ".git/.tcrn-workflow-output-acquisition-claim");
}

async function sealAcquisitionStage(root, pid = 999999, { sequence = 1, bytes } = {}) {
  const stagePath = resolve(root, `.git/.tcrn-workflow-output-acquisition-claim.staging-${pid}-${sequence}`);
  await writeFile(stagePath, "", { mode: 0o600 });
  const identity = await lstat(stagePath);
  const value = {
    schemaVersion: "tcrn.output-session-acquisition-claim.v1",
    pid,
    uid: process.getuid(),
    repositoryPath: root,
    lockPath: lockPath(root),
    claimDev: identity.dev,
    claimIno: identity.ino,
  };
  const canonical = `${JSON.stringify(value)}\n`;
  await writeFile(stagePath, bytes ?? canonical, { mode: 0o600 });
  return { stagePath, identity, canonical };
}

async function sealRecoveryClaim(root, pid, overrides = {}) {
  const claimPath = recoveryClaimPath(root);
  const stagingName = `.tcrn-workflow-output-recovery-claim.staging-${pid}-1`;
  const base = {
    schemaVersion: "tcrn.output-session-recovery-claim.v1",
    pid,
    uid: process.getuid(),
    repositoryPath: root,
    lockPath: lockPath(root),
    stagingName,
    claimDev: 0,
    claimIno: 0,
    lockDev: 1,
    lockIno: 1,
    lockCtimeMs: 1,
    lockMtimeMs: 1,
    ownerDev: 1,
    ownerIno: 1,
    ownerBytes: "{}\n",
    ...overrides,
  };
  await writeFile(claimPath, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  const identity = await lstat(claimPath);
  const sealed = { ...base, claimDev: identity.dev, claimIno: identity.ino };
  await writeFile(claimPath, `${JSON.stringify(sealed)}\n`, { mode: 0o600 });
  return { claimPath, sealed };
}

async function receipt(lock) {
  const metadata = await lstat(lock);
  return { lockDev: metadata.dev, lockIno: metadata.ino, lockCtimeMs: metadata.ctimeMs, lockMtimeMs: metadata.mtimeMs };
}

async function sealOwner(lock, pid, extra = {}) {
  const lockMetadata = await lstat(lock);
  const ownerPath = resolve(lock, "owner.json");
  const base = { schemaVersion: ownerSchema, pid, uid: process.getuid(), lockDev: lockMetadata.dev, lockIno: lockMetadata.ino, ownerDev: 0, ownerIno: 0, processGroup: null, ...extra };
  await writeFile(ownerPath, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  const ownerMetadata = await lstat(ownerPath);
  const sealed = { ...base, ownerDev: ownerMetadata.dev, ownerIno: ownerMetadata.ino };
  await writeFile(ownerPath, `${JSON.stringify(sealed)}\n`, { mode: 0o600 });
  return { lockMetadata, ownerPath, sealed };
}

async function deadOwnerLock(context) {
  const root = await fixture(context);
  const lock = lockPath(root);
  await mkdir(lock, { mode: 0o700 });
  await sealOwner(lock, 999999);
  return { root, lock };
}

async function sealPublishedRecoveryClaim(root, lock, { pid = 999999, keepStage = false } = {}) {
  const claimPath = recoveryClaimPath(root);
  const stagingName = `.tcrn-workflow-output-recovery-claim.staging-${pid}-1`;
  const stagingPath = resolve(root, ".git", stagingName);
  const lockMetadata = await lstat(lock);
  const ownerPath = resolve(lock, "owner.json");
  const ownerMetadata = await lstat(ownerPath);
  const ownerBytes = await readFile(ownerPath, "utf8");
  const base = {
    schemaVersion: "tcrn.output-session-recovery-claim.v1",
    pid,
    uid: process.getuid(),
    repositoryPath: root,
    lockPath: lock,
    stagingName,
    claimDev: 0,
    claimIno: 0,
    lockDev: lockMetadata.dev,
    lockIno: lockMetadata.ino,
    lockCtimeMs: lockMetadata.ctimeMs,
    lockMtimeMs: lockMetadata.mtimeMs,
    ownerDev: ownerMetadata.dev,
    ownerIno: ownerMetadata.ino,
    ownerBytes,
  };
  await writeFile(stagingPath, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  const stageIdentity = await lstat(stagingPath);
  const sealed = { ...base, claimDev: stageIdentity.dev, claimIno: stageIdentity.ino };
  await writeFile(stagingPath, `${JSON.stringify(sealed)}\n`, { mode: 0o600 });
  await link(stagingPath, claimPath);
  if (!keepStage) await rm(stagingPath);
  return { claimPath, stagingPath, ownerPath, sealed };
}

async function assertRecoveryStateClean(root) {
  await assert.rejects(lstat(lockPath(root)), { code: "ENOENT" });
  await assert.rejects(lstat(recoveryClaimPath(root)), { code: "ENOENT" });
  const names = await (await import("node:fs/promises")).readdir(resolve(root, ".git"));
  assert.equal(names.some((name) => name.startsWith(".tcrn-workflow-output-recovery-claim.staging-") || name.startsWith(".tcrn-workflow-output-acquisition-claim")), false);
}

const productRoot = resolve(import.meta.dirname, "..");

function runGit(root, arguments_) {
  const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${arguments_.join(" ")}\n${result.stdout}${result.stderr}`);
}

async function taskEntrypointFixture(context, testSource) {
  const root = await mkdtemp(join(tmpdir(), "tcrn-task-entrypoint-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await cp(resolve(productRoot, "scripts"), resolve(root, "scripts"), { recursive: true });
  await cp(resolve(productRoot, "node_modules"), resolve(root, "node_modules"), { recursive: true });
  await mkdir(resolve(root, "tests"));
  await writeFile(resolve(root, "package.json"), "{\"name\":\"tcrn-task-entrypoint-fixture\",\"type\":\"module\"}\n", { mode: 0o600 });
  await writeFile(resolve(root, ".gitignore"), "dist/\nnode_modules/\n", { mode: 0o600 });
  await writeFile(resolve(root, "tests/entrypoint.test.mjs"), testSource, { mode: 0o600 });
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.email", "tcrn-fixture"]);
  runGit(root, ["config", "user.name", "TCRN Fixture"]);
  runGit(root, ["add", "package.json", ".gitignore", "scripts", "tests"]);
  runGit(root, ["commit", "--quiet", "-m", "fixture"]);
  assert.equal(spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).stdout, "");
  return root;
}

function startTaskEntrypoint(root, extraEnvironment = {}) {
  const environment = {
    ...process.env,
    TCRN_TASK_DESCENDANT_PID_PATH: resolve(root, "descendant.pid"),
    npm_config_user_agent: "pnpm/11.3.0 npm/? node/v24.16.0 darwin arm64",
    ...extraEnvironment,
  };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [resolve(root, "scripts/task.mjs"), "test"], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { child, result };
}

async function waitForPath(path, diagnostic) {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    try {
      await lstat(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const result = diagnostic ? await diagnostic : undefined;
  assert.fail(`timed out waiting for ${path}${result ? `: ${JSON.stringify(result)}` : ""}`);
}

async function readJsonWhenReady(path, diagnostic) {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const result = diagnostic ? await diagnostic : undefined;
  assert.fail(`timed out reading ${path}${result ? `: ${JSON.stringify(result)}` : ""}`);
}

async function waitForDeadPid(pid) {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for descendant ${pid} to exit`);
}

async function liveDetachedProcessGroup() {
  // The production preload forbids detached descendants unconditionally.
  // This isolated safe-io fixture uses an unpreloaded launcher solely to make
  // a controlled foreign process-group target for recovery tests.
  const child = spawn("/usr/bin/env", ["-u", "NODE_OPTIONS", process.execPath, "--eval", [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000);"], { detached: true, stdio: "ignore" });',
    'process.stdout.write(String(child.pid));',
    'child.unref();',
  ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  await once(child, "exit");
  const detachedPid = Number(Buffer.concat(chunks).toString("utf8"));
  const detached = { pid: detachedPid };
  assert.ok(Number.isSafeInteger(detached.pid) && detached.pid > 0);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  process.kill(-detached.pid, 0);
  return detached;
}

async function stopDetachedProcessGroup(child) {
  process.kill(-child.pid, "SIGTERM");
  await waitForDeadPid(child.pid);
}

async function assertTaskResidueClean(root) {
  await assertRecoveryStateClean(root);
  const rootEntries = await readdir(root);
  assert.equal(rootEntries.some((name) => name.startsWith(".dist-clean-")), false);
  const distEntries = await readdir(resolve(root, "dist"), { recursive: true });
  assert.equal(distEntries.some((name) => /(^|\/)\.(?:reset|write)-/u.test(name)), false);
}

async function snapshotFilesystem(paths) {
  const uniquePaths = [...new Set(paths)].sort();
  return Object.fromEntries(await Promise.all(uniquePaths.map(async (path) => {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") return [path, { state: "ENOENT" }];
      throw error;
    }
    const type = metadata.isFile() ? "regular" : metadata.isSymbolicLink() ? "symlink" : metadata.isDirectory() ? "directory" :
      metadata.isFIFO() ? "fifo" : metadata.isSocket() ? "socket" : metadata.isBlockDevice() ? "block-device" :
        metadata.isCharacterDevice() ? "character-device" : "other";
    const snapshot = {
      state: "present",
      type,
      mode: metadata.mode,
      uid: metadata.uid,
      nlink: metadata.nlink,
      dev: metadata.dev,
      ino: metadata.ino,
    };
    if (type === "regular") snapshot.bytes = await readFile(path);
    if (type === "symlink") snapshot.target = await readlink(path);
    if (type === "directory") snapshot.entries = (await readdir(path)).sort();
    return [path, snapshot];
  })));
}

function recoveryRelationPaths(state, claim, extraPaths = []) {
  return [resolve(state.root, ".git"), state.lock, claim.ownerPath, claim.claimPath, claim.stagingPath, ...extraPaths];
}

async function legacyAuthority(context, root, lock, { reviewPath, reviewDigest, admit = true } = {}) {
  const reviewFixtureValue = reviewPath === undefined ? await reviewFixture(context) : { path: reviewPath, digest: reviewDigest };
  const boundReviewPath = reviewFixtureValue.path;
  const boundReviewDigest = reviewFixtureValue.digest;
  const external = await realpath(await mkdtemp(join(tmpdir(), "tcrn-legacy-receipt-")));
  context.after(() => rm(external, { recursive: true, force: true }));
  const lockMetadata = await lstat(lock);
  const review = await lstat(boundReviewPath);
  const value = {
    schemaVersion: "tcrn.output-session-legacy-receipt.v1",
    repositoryPath: root,
    lockPath: lock,
    lockDev: lockMetadata.dev,
    lockIno: lockMetadata.ino,
    lockCtimeMs: lockMetadata.ctimeMs,
    lockMtimeMs: lockMetadata.mtimeMs,
    lockUid: lockMetadata.uid,
    lockMode: 0o700,
    lockEntries: [],
    findingId: "RC4-ROUND2-OUTPUT-SESSION-LIFECYCLE-1",
    reviewReceiptPath: boundReviewPath,
    reviewReceiptSha256: boundReviewDigest,
    reviewReceiptDev: review.dev,
    reviewReceiptIno: review.ino,
    reviewReceiptCtimeMs: review.ctimeMs,
    reviewReceiptMtimeMs: review.mtimeMs,
  };
  const bytes = `${JSON.stringify(value)}\n`;
  const path = resolve(external, "legacy-receipt.json");
  await writeFile(path, bytes, { mode: 0o600 });
  const request = { receiptPath: path, receiptSha256: createHash("sha256").update(bytes).digest("hex"), reviewReceiptPath: boundReviewPath, reviewReceiptSha256: boundReviewDigest };
  return { path, bytes, request, authority: admit ? await admitLegacyOutputSessionReceipt(request) : undefined };
}

async function reviewFixture(context, bytes = "{\"combinedFinding\":{\"id\":\"RC4-ROUND2-OUTPUT-SESSION-LIFECYCLE-1\"}}\n") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tcrn-review-receipt-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, "review.json");
  await writeFile(path, bytes, { mode: 0o644 });
  return { path, bytes, digest: createHash("sha256").update(bytes).digest("hex") };
}

async function loadPostMkdirBarrierHarness(root) {
  const sourcePath = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const marker = "  const lock = await pathMetadata(lockPath, \"OUTPUT_SESSION_LOST\");\n";
  const barrier = "  await globalThis.__tcrnOutputSessionPostMkdirBarrier(lockPath);\n";
  assert.equal(source.split(marker).length, 2);
  const instrumented = source.replace(marker, `${marker}${barrier}`);
  assert.equal(instrumented.replace(barrier, ""), source);
  const harnessPath = resolve(root, "post-mkdir-safe-io-harness.mjs");
  await writeFile(harnessPath, instrumented, { mode: 0o600 });
  return import(`${pathToFileURL(harnessPath).href}?${Date.now()}`);
}

async function loadLegacyRmdirBarrierHarness(root) {
  const sourcePath = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const marker = "    if (afterEmptyRead.ctimeMs !== lock.ctimeMs || afterEmptyRead.mtimeMs !== lock.mtimeMs) fail(\"OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH\", lockPath);\n";
  const barrier = "    await globalThis.__tcrnLegacyRmdirBarrier(lockPath);\n";
  assert.equal(source.split(marker).length, 2);
  const instrumented = source.replace(marker, `${marker}${barrier}`);
  assert.equal(instrumented.replace(barrier, ""), source);
  const harnessPath = resolve(root, "legacy-rmdir-safe-io-harness.mjs");
  await writeFile(harnessPath, instrumented, { mode: 0o600 });
  return import(`${pathToFileURL(harnessPath).href}?${Date.now()}`);
}

async function rewriteLegacyReceipt(receipt, mutate) {
  const value = JSON.parse(receipt.bytes);
  const output = mutate(value);
  const bytes = typeof output === "string" ? output : `${JSON.stringify(output)}\n`;
  await writeFile(receipt.path, bytes, { mode: 0o600 });
  return { ...receipt.request, receiptSha256: createHash("sha256").update(bytes).digest("hex") };
}

async function crashInjectionHarness(root, name, marker, { before = false, partial = false, anchor } = {}) {
  const sourcePath = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const injection = `${partial ? "    await handle.write(\"{\\\"schemaVersion\\\":\");\n" : ""}    /* harness crash */ process.kill(process.pid, \"SIGKILL\");\n`;
  assert.equal(source.split(marker).length, 2, name);
  if (anchor) assert.equal(marker.split(anchor).length, 2, name);
  const replacement = anchor ? marker.replace(anchor, `${anchor}${injection}`) : (before ? `${injection}${marker}` : `${marker}${injection}`);
  const instrumented = source.replace(marker, replacement);
  assert.equal(instrumented.replace(injection, ""), source, name);
  const harnessPath = resolve(root, `${name}-safe-io-harness.mjs`);
  const runnerPath = resolve(root, `${name}-runner.mjs`);
  await writeFile(harnessPath, instrumented, { mode: 0o600 });
  await writeFile(runnerPath, `import { recoverStaleOutputSessionLock } from ${JSON.stringify(pathToFileURL(harnessPath).href)};\nawait recoverStaleOutputSessionLock(process.argv[2]);\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [runnerPath, root], { stdio: "ignore" });
  const exited = once(child, "exit");
  const [code, signal] = await exited;
  assert.equal(code, null, name);
  assert.equal(signal, "SIGKILL", name);
}

async function livenessHarness(root, name, marker, prefix = "", code = "EPERM", condition = "true") {
  const sourcePath = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const injection = `    if (${condition}) { const error = Object.assign(new Error(${JSON.stringify(code)}), { code: ${JSON.stringify(code)} }); throw error; }\n`;
  assert.equal(source.split(marker).length, 2, name);
  const replacement = prefix ? `${prefix}${injection}${marker.slice(prefix.length)}` : `${injection}${marker}`;
  const instrumented = source.replace(marker, replacement);
  assert.equal(instrumented.replace(injection, ""), source, name);
  const harnessPath = resolve(root, `${name}-safe-io-harness.mjs`);
  await writeFile(harnessPath, instrumented, { mode: 0o600 });
  return import(`${pathToFileURL(harnessPath).href}?${Date.now()}`);
}

async function observedUidHarness(root, targetPath) {
  const sourcePath = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const start = source.indexOf("export async function readBoundClaim(path, reasonCode) {");
  const end = source.indexOf("\nfunction assertDeadProcess", start);
  assert.ok(start >= 0 && end > start, "readBoundClaim source boundary");
  const section = source.slice(start, end);
  const injected = section
    .replace("  const before = await pathMetadata(path, reasonCode);\n", "  const before = await pathMetadata(path, reasonCode);\n  const expectedUid = globalThis.__tcrnObservedUid?.(path) ?? __tcrnOriginalUid;\n")
    .replaceAll("process.getuid?.()", "expectedUid")
    .replace("__tcrnOriginalUid", "process.getuid?.()");
  assert.notEqual(injected, section, "observed UID instrumentation applied");
  const harnessPath = resolve(root, "observed-uid-safe-io-harness.mjs");
  await writeFile(harnessPath, `${source.slice(0, start)}${injected}${source.slice(end)}`, { mode: 0o600 });
  return import(`${pathToFileURL(harnessPath).href}?${Date.now()}`);
}

async function lockObservedUidHarness(root) {
  const sourcePath = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const marker = "  if (lock.isSymbolicLink() || !lock.isDirectory() || lock.uid !== process.getuid?.() || (lock.mode & 0o777) !== 0o700) {\n";
  const replacement = "  if (lock.isSymbolicLink() || !lock.isDirectory() || lock.uid !== (globalThis.__tcrnObservedLockUid ?? process.getuid?.()) || (lock.mode & 0o777) !== 0o700) {\n";
  assert.equal(source.split(marker).length, 2, "lock observed UID validation boundary");
  const harnessPath = resolve(root, "lock-observed-uid-safe-io-harness.mjs");
  await writeFile(harnessPath, source.replace(marker, replacement), { mode: 0o600 });
  return import(`${pathToFileURL(harnessPath).href}?${Date.now()}`);
}

async function pathnameReplacementHarness(root) {
  const sourcePath = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const marker = "    const beforeRemove = await pathMetadata(stagePath, \"OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED\");\n";
  const barrier = "    await globalThis.__tcrnStagePathnameReplacement(stagePath);\n";
  assert.equal(source.split(marker).length, 2, "stage pathname replacement boundary");
  const harnessPath = resolve(root, "stage-pathname-replacement-safe-io-harness.mjs");
  await writeFile(harnessPath, source.replace(marker, `${barrier}${marker}`), { mode: 0o600 });
  return import(`${pathToFileURL(harnessPath).href}?${Date.now()}`);
}

async function acquisitionRestartHarness(root) {
  const sourcePath = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const marker = "  if (lockBeforeAcquisition) {\n    try {\n";
  const barrier = "    await globalThis.__tcrnAcquisitionRestartInterleave({ lockPath, recoveryClaim });\n";
  assert.equal(source.split(marker).length, 2, "acquisition restart boundary");
  const harnessPath = resolve(root, "acquisition-restart-safe-io-harness.mjs");
  await writeFile(harnessPath, source.replace(marker, `${marker}${barrier}`), { mode: 0o600 });
  return import(`${pathToFileURL(harnessPath).href}?${Date.now()}`);
}

async function releaseAcquisitionInterleaveHarness(root) {
  const sourcePath = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const releaseMarker = "  injectReleaseFailure(\"after-owner-unlink\");\n";
  const observedMarker = "  if (lockBeforeAcquisition) {\n    try {\n";
  const publicationMarker = "  await publishAcquisition();\n  try {\n";
  const releaseBarrier = [
    "  if (process.env.TCRN_TEST_RELEASE_READY_PATH) {",
    "    await writeFile(process.env.TCRN_TEST_RELEASE_READY_PATH, \"ready\\n\", { mode: 0o600, flag: \"wx\" });",
    "    while (true) {",
    "      try { await lstat(process.env.TCRN_TEST_RELEASE_GO_PATH); break; }",
    "      catch (error) { if (error?.code !== \"ENOENT\") throw error; }",
    "      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));",
    "    }",
    "  }",
    "",
  ].join("\n");
  const observedBarrier = [
    "    if (process.env.TCRN_TEST_ACQUISITION_OBSERVED_PATH) {",
    "      await writeFile(process.env.TCRN_TEST_ACQUISITION_OBSERVED_PATH, \"observed\\n\", { mode: 0o600, flag: \"wx\" });",
    "      while (true) {",
    "        try { await lstat(process.env.TCRN_TEST_ACQUISITION_CONTINUE_PATH); break; }",
    "        catch (error) { if (error?.code !== \"ENOENT\") throw error; }",
    "        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));",
    "      }",
    "    }",
  ].join("\n");
  const publicationProof = [
    "  if (process.env.TCRN_TEST_ACQUISITION_PUBLISHED_PATH) {",
    "    const published = await readAcquisitionClaim(acquisitionClaimPath, repository.realPath, lockPath, \"OUTPUT_SESSION_ACQUISITION_CHANGED\");",
    "    if (!acquisition || published.value.pid !== process.pid || !sameIdentity(published.metadata, acquisition.metadata)) fail(\"OUTPUT_SESSION_ACQUISITION_CHANGED\", acquisitionClaimPath);",
    "    await writeFile(process.env.TCRN_TEST_ACQUISITION_PUBLISHED_PATH, `${JSON.stringify({ pid: process.pid, claimPid: published.value.pid })}\\n`, { mode: 0o600, flag: \"wx\" });",
    "  }",
  ].join("\n");
  assert.equal(source.split(releaseMarker).length, 2, "release ownerless barrier boundary");
  assert.equal(source.split(observedMarker).length, 2, "acquisition observed barrier boundary");
  assert.equal(source.split(publicationMarker).length, 2, "acquisition publication proof boundary");
  const instrumented = source
    .replace(releaseMarker, `${releaseMarker}${releaseBarrier}`)
    .replace(observedMarker, `${observedMarker}${observedBarrier}`)
    .replace(publicationMarker, `${publicationMarker.replace("  try {\n", publicationProof + "\n  try {\n")}`);
  const harnessPath = resolve(root, "release-acquisition-interleave-safe-io-harness.mjs");
  await writeFile(harnessPath, instrumented, { mode: 0o600 });
  return pathToFileURL(harnessPath).href;
}

function startExclusiveOutputSession(moduleUrl, root, environment = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", [
    `import { withExclusiveOutputSession } from ${JSON.stringify(moduleUrl)};`,
    "try {",
    `  await withExclusiveOutputSession(${JSON.stringify(root)}, async () => {});`,
    "  process.stdout.write(\"OK\\n\");",
    "} catch (error) {",
    "  process.stderr.write(`${JSON.stringify({ reasonCode: error?.reasonCode ?? null, message: error?.message ?? String(error) })}\\n`);",
    "  process.exitCode = 1;",
    "}",
  ].join("\n")], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, result: once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr })) };
}

async function localPublicationReplacementHarness(root) {
  const sourcePath = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const marker = "    locallyPublishedRecoveryClaims.set(claimPath, claimIdentity);\n";
  const barrier = "    await globalThis.__tcrnLocalPublicationReplacement(claimPath, stagingPath);\n";
  assert.equal(source.split(marker).length, 2, "local publication identity boundary");
  const instrumented = source.replace(marker, `${marker}${barrier}`);
  assert.equal(instrumented.replace(barrier, ""), source);
  const harnessPath = resolve(root, "local-publication-replacement-safe-io-harness.mjs");
  await writeFile(harnessPath, instrumented, { mode: 0o600 });
  return import(`${pathToFileURL(harnessPath).href}?${Date.now()}`);
}

async function eexistPublicationHarness(root) {
  const sourcePath = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const marker = "    try { await link(stagingPath, claimPath); } catch (error) {\n";
  const barrier = "    try { await globalThis.__tcrnEexistPublication(stagingPath, claimPath); await link(stagingPath, claimPath); } catch (error) {\n";
  assert.equal(source.split(marker).length, 2, "EEXIST publication boundary");
  const harnessPath = resolve(root, "eexist-publication-safe-io-harness.mjs");
  await writeFile(harnessPath, source.replace(marker, barrier), { mode: 0o600 });
  return import(`${pathToFileURL(harnessPath).href}?${Date.now()}`);
}

async function terminalCleanReadbackHarness(root) {
  const sourcePath = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const marker = "    await assertRecoveryClean(gitDirectory, lockPath, recoveryClaim, \"OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED\");\n    return { reasonCode: \"OUTPUT_SESSION_STALE_LOCK_RECOVERED\", lockDev: lock.dev, lockIno: lock.ino, lockCtimeMs: lock.ctimeMs, lockMtimeMs: lock.mtimeMs };\n";
  const observer = "    await globalThis.__tcrnTerminalCleanReadback(gitDirectory, lockPath, recoveryClaim);\n";
  assert.equal(source.split(marker).length, 2, "terminal clean readback boundary");
  const harnessPath = resolve(root, "terminal-clean-readback-safe-io-harness.mjs");
  await writeFile(harnessPath, source.replace(marker, marker.replace("    return", `${observer}    return`)), { mode: 0o600 });
  return import(`${pathToFileURL(harnessPath).href}?${Date.now()}`);
}

async function createFifo(path) {
  if (process.platform === "win32") return { supported: false, reason: "FIFO paths are unsupported on Windows" };
  const child = spawn("mkfifo", [path], { stdio: "ignore" });
  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ supported: false, reason: `mkfifo unavailable: ${error.code ?? error.message}` }));
    child.once("exit", (code) => resolve(code === 0 ? { supported: true } : { supported: false, reason: `mkfifo exited ${code}` }));
  });
  return result;
}

async function createUnixSocket(path) {
  const directoryFallback = async () => {
    await mkdir(path, { mode: 0o700 });
    return { supported: true, close: () => rm(path, { recursive: true, force: true }) };
  };
  if (process.platform === "win32") return directoryFallback();
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
  } catch (error) {
    server.close();
    return directoryFallback();
  }
  return { supported: true, close: () => new Promise((resolve) => server.close(resolve)) };
}

function expectReason(reasonCode) {
  return (error) => error?.reasonCode === reasonCode;
}

test("bounded recovery-claim reads accept exactly 65,536 bytes and reject dense or sparse max-plus-one files", async (context) => {
  const root = await fixture(context);
  const exactPath = resolve(root, ".git/exact-claim");
  await writeFile(exactPath, Buffer.alloc(65_536, 0x61), { mode: 0o600 });
  assert.equal((await readBoundClaim(exactPath, "TEST_BOUNDARY")).bytes.length, 65_536);

  const densePath = resolve(root, ".git/dense-over-limit-claim");
  await writeFile(densePath, Buffer.alloc(65_537, 0x61), { mode: 0o600 });
  await assert.rejects(readBoundClaim(densePath, "TEST_BOUNDARY"), expectReason("TEST_BOUNDARY"));

  const sparsePath = resolve(root, ".git/sparse-over-limit-claim");
  await writeFile(sparsePath, "x", { mode: 0o600 });
  await truncate(sparsePath, 65_537);
  await assert.rejects(readBoundClaim(sparsePath, "TEST_BOUNDARY"), expectReason("TEST_BOUNDARY"));
});

test("bounded recovery-claim reads reject same-inode continuous and sparse growth after open", async (context) => {
  const root = await fixture(context);
  for (const [name, grow] of [
    ["continuous", async (path) => appendFile(path, "b")],
    ["sparse", async (path) => truncate(path, 65_537)],
  ]) {
    const path = resolve(root, `.git/${name}-growth-claim`);
    await writeFile(path, name === "continuous" ? Buffer.alloc(65_536, 0x61) : "x", { mode: 0o600 });
    if (name === "sparse") await truncate(path, 65_536);
    const probe = await open(path, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe);
    const originalRead = fileHandlePrototype.read;
    await probe.close();
    let totalBytesRead = 0;
    let grew = false;
    context.mock.method(fileHandlePrototype, "read", async function (...args) {
      const result = await originalRead.apply(this, args);
      totalBytesRead += result.bytesRead;
      if (!grew) {
        grew = true;
        await grow(path);
      }
      return result;
    });
    try {
      await assert.rejects(readBoundClaim(path, "TEST_GROWTH"), expectReason("TEST_GROWTH"));
    } finally {
      context.mock.restoreAll();
    }
    assert.equal(totalBytesRead, 65_537);
  }
});

test("owner control-reader is descriptor-bounded before canonical metadata validation", async (context) => {
  const cases = [
    ["oversize", async (path) => writeFile(path, Buffer.alloc(65_537, 0x61), { mode: 0o600 }), 0],
    ["exact maximum", async (path) => writeFile(path, Buffer.alloc(65_536, 0x61), { mode: 0o600 }), 65_536],
  ];
  for (const [, mutate, expectedBytesRead] of cases) {
    const { root, lock } = await deadOwnerLock(context);
    const ownerPath = resolve(lock, "owner.json");
    await mutate(ownerPath);
    const probe = await open(ownerPath, "r");
    const prototype = Object.getPrototypeOf(probe);
    const originalRead = prototype.read;
    await probe.close();
    let bytesRead = 0;
    context.mock.method(prototype, "read", async function (...args) {
      const result = await originalRead.apply(this, args);
      bytesRead += result.bytesRead;
      return result;
    });
    try {
      await assert.rejects(recoverStaleOutputSessionLock(root), expectReason("OUTPUT_SESSION_METADATA_INVALID"));
    } finally {
      context.mock.restoreAll();
    }
    assert.equal(bytesRead, expectedBytesRead);
    await lstat(lock);
    await lstat(ownerPath);
  }
});

test("owner control-reader rejects sparse and incremental same-inode growth at maximum-plus-one", async (context) => {
  for (const mode of ["sparse", "continuous"]) {
    const { root, lock } = await deadOwnerLock(context);
    const ownerPath = resolve(lock, "owner.json");
    const ownerIdentity = await lstat(ownerPath);
    const probe = await open(ownerPath, "r");
    const prototype = Object.getPrototypeOf(probe);
    const originalRead = prototype.read;
    const originalStat = prototype.stat;
    await probe.close();
    let stats = 0;
    let bytesRead = 0;
    let growthRounds = 0;
    context.mock.method(prototype, "read", async function (...args) {
      const result = await originalRead.apply(this, args);
      bytesRead += result.bytesRead;
      if (mode === "continuous" && result.bytesRead > 0) {
        const size = (await lstat(ownerPath)).size;
        if (size < 65_537) {
          await appendFile(ownerPath, Buffer.alloc(Math.min(16_384, 65_537 - size), 0x61));
          growthRounds += 1;
        }
      }
      return result;
    });
    context.mock.method(prototype, "stat", async function (...args) {
      const result = await originalStat.apply(this, args);
      stats += 1;
      if (mode === "sparse" && stats === 1) await truncate(ownerPath, 65_537);
      return result;
    });
    try {
      await assert.rejects(recoverStaleOutputSessionLock(root), expectReason("OUTPUT_SESSION_METADATA_INVALID"));
    } finally {
      context.mock.restoreAll();
    }
    assert.equal(bytesRead, 65_537);
    if (mode === "continuous") assert.ok(growthRounds > 1);
    const after = await lstat(ownerPath);
    assert.equal(after.dev, ownerIdentity.dev);
    assert.equal(after.ino, ownerIdentity.ino);
    await lstat(lock);
  }
});

test("owner metadata requires the frozen closed field order without deleting the lock", async (context) => {
  for (const mutate of [
    (value) => { const { ownerIno, ...remaining } = value; return remaining; },
    (value) => ({ ...value, unexpected: true }),
    (value) => ({ pid: value.pid, ...value }),
  ]) {
    const { root, lock } = await deadOwnerLock(context);
    const ownerPath = resolve(lock, "owner.json");
    const value = JSON.parse(await readFile(ownerPath, "utf8"));
    await writeFile(ownerPath, `${JSON.stringify(mutate(value))}\n`, { mode: 0o600 });
    await assert.rejects(recoverStaleOutputSessionLock(root), expectReason("OUTPUT_SESSION_METADATA_INVALID"));
    await lstat(lock);
    await lstat(ownerPath);
  }
});

test("normal terminal work releases its identity-bound lock before the caller returns", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  let owner;
  await withExclusiveOutputSession(root, async () => {
    owner = JSON.parse(await (await import("node:fs/promises")).readFile(resolve(lock, "owner.json"), "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.uid, process.getuid());
    assert.ok(Number.isSafeInteger(owner.ownerDev));
  });
  await assert.rejects(lstat(lock), { code: "ENOENT" });
});

test("nested work uses the existing session and releases once", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  await withExclusiveOutputSession(root, async () => {
    const before = await lstat(lock);
    await withExclusiveOutputSession(root, async () => assert.equal((await lstat(lock)).ino, before.ino));
    assert.equal((await lstat(lock)).ino, before.ino);
  });
  await assert.rejects(lstat(lock), { code: "ENOENT" });
});

test("normal acquisition preserves malformed recovery claims", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  const claim = resolve(root, ".git/.tcrn-workflow-output-recovery-claim");
  const claimBytes = (pid) => `${JSON.stringify({ schemaVersion: "tcrn.output-session-recovery-claim.v1", pid, uid: process.getuid(), lockPath: lock, lockDev: 1, lockIno: 1, lockCtimeMs: 1, lockMtimeMs: 1, ownerDev: null, ownerIno: null, ownerBytes: null })}\n`;
  await writeFile(claim, claimBytes(process.pid), { mode: 0o600 });
  await chmod(claim, 0o600);
  await assert.rejects(withExclusiveOutputSession(root, async () => {}), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
  await rm(claim);
  await writeFile(claim, claimBytes(999999), { mode: 0o600 });
  await chmod(claim, 0o600);
  await assert.rejects(withExclusiveOutputSession(root, async () => {}), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
  await lstat(claim);
});

test("normal acquisition clears only governed dead stage-only residue and preserves live residue", async (context) => {
  const dead = await fixture(context);
  const deadStage = resolve(dead, ".git/.tcrn-workflow-output-recovery-claim.staging-999999-1");
  await writeFile(deadStage, "", { mode: 0o600 });
  await withExclusiveOutputSession(dead, async () => {});
  await assert.rejects(lstat(deadStage), { code: "ENOENT" });
  await assert.rejects(lstat(lockPath(dead)), { code: "ENOENT" });

  const live = await fixture(context);
  const liveStage = resolve(live, `.git/.tcrn-workflow-output-recovery-claim.staging-${process.pid}-1`);
  await writeFile(liveStage, "", { mode: 0o600 });
  await assert.rejects(withExclusiveOutputSession(live, async () => {}), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_LIVE"));
  await lstat(liveStage);
  await assert.rejects(lstat(lockPath(live)), { code: "ENOENT" });

});

test("post-mkdir recovery-object scan removes only the caller lock and preserves recovery state", async (context) => {
  for (const [name, installRecoveryObject] of [
    ["fixed", async (root) => writeFile(recoveryClaimPath(root), "fixed\n", { mode: 0o600 })],
    ["stage", async (root) => writeFile(resolve(root, ".git/.tcrn-workflow-output-recovery-claim.staging-999999-1"), "stage\n", { mode: 0o600 })],
  ]) {
    const root = await fixture(context);
    const harness = await loadPostMkdirBarrierHarness(root);
    let callbackCalled = false;
    let recoveryPath;
    let before;
    globalThis.__tcrnOutputSessionPostMkdirBarrier = async (lock) => {
      await installRecoveryObject(root);
      recoveryPath = name === "fixed" ? recoveryClaimPath(root) : resolve(root, ".git/.tcrn-workflow-output-recovery-claim.staging-999999-1");
      before = { identity: await lstat(recoveryPath), bytes: await readFile(recoveryPath, "utf8") };
      assert.equal(lock, lockPath(root));
    };
    try {
      await assert.rejects(harness.withExclusiveOutputSession(root, async () => { callbackCalled = true; }), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_PENDING"));
    } finally {
      delete globalThis.__tcrnOutputSessionPostMkdirBarrier;
    }
    assert.equal(callbackCalled, false);
    const after = await lstat(recoveryPath);
    assert.equal(after.dev, before.identity.dev);
    assert.equal(after.ino, before.identity.ino);
    assert.equal(await readFile(recoveryPath, "utf8"), before.bytes);
    await assert.rejects(lstat(lockPath(root)), { code: "ENOENT" });
  }
});

test("post-mkdir scan preserves replacement and nonempty initialization locks", async (context) => {
  for (const [name, mutate] of [
    ["replacement", async (root, lock) => {
      await rename(lock, `${lock}.original`);
      await mkdir(lock, { mode: 0o700 });
      await writeFile(recoveryClaimPath(root), "fixed\n", { mode: 0o600 });
    }],
    ["nonempty", async (root, lock) => {
      await writeFile(resolve(lock, "foreign-entry"), "x\n", { mode: 0o600 });
      await writeFile(recoveryClaimPath(root), "fixed\n", { mode: 0o600 });
    }],
  ]) {
    const root = await fixture(context);
    const harness = await loadPostMkdirBarrierHarness(root);
    globalThis.__tcrnOutputSessionPostMkdirBarrier = async (lock) => mutate(root, lock);
    try {
      await assert.rejects(harness.withExclusiveOutputSession(root, async () => {}), expectReason("OUTPUT_SESSION_METADATA_CREATE_FAILED"));
    } finally {
      delete globalThis.__tcrnOutputSessionPostMkdirBarrier;
    }
    await lstat(lockPath(root));
    await lstat(recoveryClaimPath(root));
    if (name === "replacement") await lstat(`${lockPath(root)}.original`);
    else await lstat(resolve(lockPath(root), "foreign-entry"));
  }
});

test("normal acquisition clears an exact dead post-lock recovery claim and leaves zero residue", async (context) => {
  const root = await fixture(context);
  const { claimPath } = await sealRecoveryClaim(root, 999999);
  await withExclusiveOutputSession(root, async () => {});
  await assert.rejects(lstat(claimPath), { code: "ENOENT" });
  await assert.rejects(lstat(lockPath(root)), { code: "ENOENT" });
});

test("normal acquisition preserves an exact live post-lock recovery claim", async (context) => {
  const root = await fixture(context);
  const { claimPath } = await sealRecoveryClaim(root, process.pid);
  await assert.rejects(withExclusiveOutputSession(root, async () => {}), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_LIVE"));
  await lstat(claimPath);
  await assert.rejects(lstat(lockPath(root)), { code: "ENOENT" });
});

test("normal acquisition preserves malformed and wrong-path post-lock recovery claims", async (context) => {
  for (const mutate of [
    async ({ claimPath }) => writeFile(claimPath, "{\n", { mode: 0o600 }),
    async ({ claimPath, sealed }) => writeFile(claimPath, `${JSON.stringify({ ...sealed, lockPath: `${sealed.lockPath}.other` })}\n`, { mode: 0o600 }),
  ]) {
    const root = await fixture(context);
    const claim = await sealRecoveryClaim(root, 999999);
    await mutate(claim);
    await assert.rejects(withExclusiveOutputSession(root, async () => {}), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
    await lstat(claim.claimPath);
    await assert.rejects(lstat(lockPath(root)), { code: "ENOENT" });
  }
});

test("lock-absent cleanup and pre-acquisition reject wrong or transplanted claim repository paths", async (context) => {
  for (const repositoryPath of [resolve(tmpdir(), "tcrn-wrong-repository"), undefined]) {
    const root = await fixture(context);
    const claim = await sealRecoveryClaim(root, 999999);
    const value = repositoryPath === undefined ? (() => { const { repositoryPath: omitted, ...remaining } = claim.sealed; return remaining; })() : { ...claim.sealed, repositoryPath };
    await writeFile(claim.claimPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await assert.rejects(withExclusiveOutputSession(root, async () => {}), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
    await lstat(claim.claimPath);
    await assert.rejects(lstat(lockPath(root)), { code: "ENOENT" });
  }
  const source = await fixture(context);
  const sourceClaim = await sealRecoveryClaim(source, 999999);
  const target = await fixture(context);
  const targetClaimPath = recoveryClaimPath(target);
  await cp(sourceClaim.claimPath, targetClaimPath);
  await assert.rejects(withExclusiveOutputSession(target, async () => {}), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
  await lstat(targetClaimPath);
});

test("an ownerless lock without a fixed claim requires the later durable legacy receipt", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  await mkdir(lock, { mode: 0o700 });
  const exact = await receipt(lock);
  for (const key of Object.keys(exact)) {
    await assert.rejects(recoverStaleOutputSessionLock(root, { ...exact, [key]: exact[key] + 1 }), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_REQUIRED"));
  }
  await assert.rejects(recoverStaleOutputSessionLock(root, exact), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_REQUIRED"));
  assert.equal((await lstat(lock)).ino, exact.lockIno);
});

test("an exact coordinator-admitted external legacy receipt recovers once and cannot replay", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  await mkdir(lock, { mode: 0o700 });
  const { authority } = await legacyAuthority(context, root, lock);
  assert.equal((await recoverStaleOutputSessionLock(root, authority)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED");
  await assertRecoveryStateClean(root);
  await mkdir(lock, { mode: 0o700 });
  await assert.rejects(recoverStaleOutputSessionLock(root, authority), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH"));
  await lstat(lock);
});

test("every closed legacy receipt field group and canonical-form variant fails MISMATCH", async (context) => {
  const mutations = [
    ["repository path", (value) => ({ ...value, repositoryPath: `${value.repositoryPath}.other` })],
    ["lock path", (value) => ({ ...value, lockPath: `${value.lockPath}.other` })],
    ["lock device", (value) => ({ ...value, lockDev: value.lockDev + 1 })],
    ["lock inode", (value) => ({ ...value, lockIno: value.lockIno + 1 })],
    ["lock ctime", (value) => ({ ...value, lockCtimeMs: value.lockCtimeMs + 1 })],
    ["lock mtime", (value) => ({ ...value, lockMtimeMs: value.lockMtimeMs + 1 })],
    ["lock uid", (value) => ({ ...value, lockUid: value.lockUid + 1 })],
    ["lock mode", (value) => ({ ...value, lockMode: 0o755 })],
    ["empty directory shape", (value) => ({ ...value, lockEntries: ["owner.json"] })],
    ["finding", (value) => ({ ...value, findingId: "RC4-OTHER" })],
    ["review path", (value) => ({ ...value, reviewReceiptPath: `${value.reviewReceiptPath}.other` })],
    ["review digest", (value) => ({ ...value, reviewReceiptSha256: `${value.reviewReceiptSha256.slice(0, 63)}0` })],
    ["review device", (value) => ({ ...value, reviewReceiptDev: value.reviewReceiptDev + 1 })],
    ["review inode", (value) => ({ ...value, reviewReceiptIno: value.reviewReceiptIno + 1 })],
    ["review ctime", (value) => ({ ...value, reviewReceiptCtimeMs: value.reviewReceiptCtimeMs + 1 })],
    ["review mtime", (value) => ({ ...value, reviewReceiptMtimeMs: value.reviewReceiptMtimeMs + 1 })],
    ["key order", (value) => ({ lockPath: value.lockPath, ...value })],
    ["missing key", (value) => { const { lockMode, ...remaining } = value; return remaining; }],
    ["unknown key", (value) => ({ ...value, unexpected: true })],
    ["malformed canonical bytes", () => "{\n"],
  ];
  for (const [, mutate] of mutations) {
    const root = await fixture(context);
    const lock = lockPath(root);
    await mkdir(lock, { mode: 0o700 });
    const review = await reviewFixture(context);
    const receipt = await legacyAuthority(context, root, lock, { reviewPath: review.path, reviewDigest: review.digest });
    const request = await rewriteLegacyReceipt(receipt, mutate);
    await assert.rejects((async () => recoverStaleOutputSessionLock(root, await admitLegacyOutputSessionReceipt(request)))(), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH"));
    await lstat(lock);
    await lstat(receipt.path);
    await lstat(review.path);
  }
});

test("only module-private branded legacy authority is accepted and copies or reseals stay REQUIRED", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  await mkdir(lock, { mode: 0o700 });
  const review = await reviewFixture(context);
  const receipt = await legacyAuthority(context, root, lock, { reviewPath: review.path, reviewDigest: review.digest });
  const copied = structuredClone(receipt.authority);
  const resealed = Object.freeze({ ...structuredClone(receipt.authority), sourceDigest: receipt.authority.sourceDigest });
  assert.equal(Object.isFrozen(receipt.authority), true);
  assert.equal(Object.isFrozen(receipt.authority.value), true);
  assert.throws(() => { receipt.authority.value.lockPath = `${lock}.other`; }, TypeError);
  for (const authority of [undefined, null, {}, { ...receipt.authority }, copied, resealed, JSON.parse(JSON.stringify(receipt.authority))]) {
    await assert.rejects(recoverStaleOutputSessionLock(root, authority), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_REQUIRED"));
    await lstat(lock);
    await lstat(receipt.path);
    await lstat(review.path);
  }
});

test("legacy recovery preserves nonempty and replacement locks and rejects the exact bound authority", async (context) => {
  const nonemptyRoot = await fixture(context);
  const nonemptyLock = lockPath(nonemptyRoot);
  await mkdir(nonemptyLock, { mode: 0o700 });
  const nonemptyReview = await reviewFixture(context);
  const entry = resolve(nonemptyLock, "foreign-entry");
  await writeFile(entry, "x", { mode: 0o600 });
  const nonemptyReceipt = await legacyAuthority(context, nonemptyRoot, nonemptyLock, { reviewPath: nonemptyReview.path, reviewDigest: nonemptyReview.digest });
  await assert.rejects(recoverStaleOutputSessionLock(nonemptyRoot, nonemptyReceipt.authority), expectReason("OUTPUT_SESSION_RECOVERY_NOT_EMPTY"));
  await lstat(nonemptyLock);
  await lstat(entry);

  const replacementRoot = await fixture(context);
  const replacementLock = lockPath(replacementRoot);
  await mkdir(replacementLock, { mode: 0o700 });
  const replacementReview = await reviewFixture(context);
  const replacementReceipt = await legacyAuthority(context, replacementRoot, replacementLock, { reviewPath: replacementReview.path, reviewDigest: replacementReview.digest });
  const originalPath = `${replacementLock}.original`;
  await rename(replacementLock, originalPath);
  await mkdir(replacementLock, { mode: 0o700 });
  const replacementIdentity = await lstat(replacementLock);
  await assert.rejects(recoverStaleOutputSessionLock(replacementRoot, replacementReceipt.authority), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH"));
  assert.equal((await lstat(replacementLock)).ino, replacementIdentity.ino);
  await lstat(originalPath);
});

test("an add-then-remove change after the empty read cannot authorize legacy rmdir", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  await mkdir(lock, { mode: 0o700 });
  const review = await reviewFixture(context);
  const receipt = await legacyAuthority(context, root, lock, { reviewPath: review.path, reviewDigest: review.digest });
  const receiptIdentity = await lstat(receipt.path);
  const reviewIdentity = await lstat(review.path);
  const harness = await loadLegacyRmdirBarrierHarness(root);
  const authority = await harness.admitLegacyOutputSessionReceipt(receipt.request);
  globalThis.__tcrnLegacyRmdirBarrier = async (path) => {
    const entry = resolve(path, "rmdir-race-entry");
    await writeFile(entry, "x", { mode: 0o600 });
    await rm(entry);
  };
  try {
    await assert.rejects(harness.recoverStaleOutputSessionLock(root, authority), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH"));
  } finally {
    delete globalThis.__tcrnLegacyRmdirBarrier;
  }
  await lstat(lock);
  assert.deepEqual((await (await import("node:fs/promises")).readdir(lock)), []);
  const afterReceipt = await lstat(receipt.path);
  const afterReview = await lstat(review.path);
  assert.equal(afterReceipt.ino, receiptIdentity.ino);
  assert.equal(afterReview.ino, reviewIdentity.ino);
});

test("legacy receipt source non-authority forms fail MISMATCH without lock mutation", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  await mkdir(lock, { mode: 0o700 });
  const receipt = await legacyAuthority(context, root, lock);
  await assert.rejects(recoverStaleOutputSessionLock(root, { ...receipt.authority }), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_REQUIRED"));
  await lstat(lock);
  const digest = createHash("sha256").update(receipt.bytes).digest("hex");
  const cases = [
    async (candidate) => link(candidate.path, `${candidate.path}.hardlink`),
    async (candidate) => { await rm(candidate.path); await mkdir(candidate.path, { mode: 0o700 }); },
    async (candidate) => chmod(candidate.path, 0o644),
    async (candidate) => writeFile(candidate.path, Buffer.alloc(65_537, 0x61), { mode: 0o600 }),
  ];
  for (const mutate of cases) {
    const isolated = await fixture(context);
    const isolatedLock = lockPath(isolated);
    await mkdir(isolatedLock, { mode: 0o700 });
    const candidate = await legacyAuthority(context, isolated, isolatedLock);
    await mutate(candidate);
    await assert.rejects(admitLegacyOutputSessionReceipt({ ...candidate.request, receiptPath: candidate.path, receiptSha256: createHash("sha256").update(candidate.bytes).digest("hex") }), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH"));
    await lstat(isolatedLock);
  }
  const wrongDigest = `${digest.slice(0, 63)}${digest.endsWith("0") ? "1" : "0"}`;
  await assert.rejects(admitLegacyOutputSessionReceipt({ ...receipt.request, receiptSha256: wrongDigest }), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH"));
  await lstat(lock);
});

test("legacy source symlink, copied authority replacement, and pathname replacement preserve the exact lock", async (context) => {
  const cases = [
    ["symlink", async (receipt) => { await rename(receipt.path, `${receipt.path}.target`); await symlink(`${receipt.path}.target`, receipt.path); }],
    ["copied canonical authority path", async (receipt) => { await cp(receipt.path, `${receipt.path}.copy`); await rm(receipt.path); await rename(`${receipt.path}.copy`, receipt.path); }],
    ["post-admission pathname/inode replacement", async (receipt) => { await rename(receipt.path, `${receipt.path}.old`); await writeFile(receipt.path, receipt.bytes, { mode: 0o600 }); }],
  ];
  for (const [, mutate] of cases) {
    const root = await fixture(context);
    const lock = lockPath(root);
    await mkdir(lock, { mode: 0o700 });
    const receipt = await legacyAuthority(context, root, lock);
    await mutate(receipt);
    await assert.rejects(recoverStaleOutputSessionLock(root, receipt.authority), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH"));
    await lstat(lock);
  }
});

test("legacy receipt and review authority one-shot sparse growth stop at maximum-plus-one and preserve the lock", async (context) => {
  for (const [target, growthStat] of [
    ["legacy", 1],
    ["review", 3],
  ]) {
    const root = await fixture(context);
    const lock = lockPath(root);
    await mkdir(lock, { mode: 0o700 });
    const review = await reviewFixture(context);
    const receipt = await legacyAuthority(context, root, lock, { reviewPath: review.path, reviewDigest: review.digest });
    const targetPath = target === "legacy" ? receipt.path : review.path;
    const originalIdentity = await lstat(targetPath);
    const probe = await open(targetPath, "r");
    const prototype = Object.getPrototypeOf(probe);
    const originalRead = prototype.read;
    const originalStat = prototype.stat;
    await probe.close();
    let stats = 0;
    let targetBytesRead = 0;
    let grew = false;
    context.mock.method(prototype, "read", async function (...args) {
      const result = await originalRead.apply(this, args);
      if (grew) targetBytesRead += result.bytesRead;
      return result;
    });
    context.mock.method(prototype, "stat", async function (...args) {
      const result = await originalStat.apply(this, args);
      stats += 1;
      if (stats === growthStat) {
        await truncate(targetPath, 65_537);
        grew = true;
      }
      return result;
    });
    try {
      await assert.rejects(recoverStaleOutputSessionLock(root, receipt.authority), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH"));
    } finally {
      context.mock.restoreAll();
    }
    assert.equal(targetBytesRead, 65_537);
    const after = await lstat(targetPath);
    assert.equal(after.dev, originalIdentity.dev);
    assert.equal(after.ino, originalIdentity.ino);
    await lstat(lock);
  }
});

test("legacy receipt and review authority continuous growth is incremental, capped, and non-destructive", async (context) => {
  for (const target of ["legacy", "review"]) {
    const root = await fixture(context);
    const lock = lockPath(root);
    await mkdir(lock, { mode: 0o700 });
    const review = await reviewFixture(context);
    const receipt = await legacyAuthority(context, root, lock, { reviewPath: review.path, reviewDigest: review.digest });
    const targetPath = target === "legacy" ? receipt.path : review.path;
    const originalIdentity = await lstat(targetPath);
    const probe = await open(targetPath, "r");
    const prototype = Object.getPrototypeOf(probe);
    const originalRead = prototype.read;
    await probe.close();
    let reads = 0;
    let targetBytesRead = 0;
    let growthRounds = 0;
    context.mock.method(prototype, "read", async function (...args) {
      const result = await originalRead.apply(this, args);
      reads += 1;
      const targetRead = target === "legacy" ? reads >= 1 : reads >= 3;
      if (targetRead) {
        targetBytesRead += result.bytesRead;
        if (result.bytesRead > 0) {
          const size = (await lstat(targetPath)).size;
          if (size < 65_537) {
            await appendFile(targetPath, Buffer.alloc(Math.min(16_384, 65_537 - size), 0x61));
            growthRounds += 1;
          }
        }
      }
      return result;
    });
    try {
      await assert.rejects(recoverStaleOutputSessionLock(root, receipt.authority), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH"));
    } finally {
      context.mock.restoreAll();
    }
    assert.ok(growthRounds > 1);
    assert.equal(targetBytesRead, 65_537);
    const after = await lstat(targetPath);
    assert.equal(after.dev, originalIdentity.dev);
    assert.equal(after.ino, originalIdentity.ino);
    await lstat(lock);
  }
});

test("legacy and review authority oversize sources reject before their descriptor reads", async (context) => {
  const legacyRoot = await fixture(context);
  const legacyLock = lockPath(legacyRoot);
  await mkdir(legacyLock, { mode: 0o700 });
  const legacy = await legacyAuthority(context, legacyRoot, legacyLock);
  await writeFile(legacy.path, Buffer.alloc(65_537, 0x61), { mode: 0o600 });
  const legacyProbe = await open(legacy.path, "r");
  const prototype = Object.getPrototypeOf(legacyProbe);
  const originalRead = prototype.read;
  await legacyProbe.close();
  let legacyReads = 0;
  context.mock.method(prototype, "read", async function (...args) {
    legacyReads += 1;
    return originalRead.apply(this, args);
  });
  try {
    await assert.rejects(admitLegacyOutputSessionReceipt(legacy.request), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH"));
  } finally {
    context.mock.restoreAll();
  }
  assert.equal(legacyReads, 0);
  await lstat(legacyLock);

  const reviewRoot = await fixture(context);
  const reviewLock = lockPath(reviewRoot);
  await mkdir(reviewLock, { mode: 0o700 });
  const review = await reviewFixture(context);
  await writeFile(review.path, Buffer.alloc(65_537, 0x61), { mode: 0o644 });
  const receipt = await legacyAuthority(context, reviewRoot, reviewLock, { reviewPath: review.path, reviewDigest: createHash("sha256").update(await readFile(review.path)).digest("hex"), admit: false });
  const reviewProbe = await open(review.path, "r");
  const reviewPrototype = Object.getPrototypeOf(reviewProbe);
  const originalReviewRead = reviewPrototype.read;
  const originalReviewStat = reviewPrototype.stat;
  await reviewProbe.close();
  let sourceSettled = false;
  let stats = 0;
  let reviewReads = 0;
  context.mock.method(reviewPrototype, "read", async function (...args) {
    if (sourceSettled) reviewReads += 1;
    return originalReviewRead.apply(this, args);
  });
  context.mock.method(reviewPrototype, "stat", async function (...args) {
    const result = await originalReviewStat.apply(this, args);
    stats += 1;
    if (stats === 2) sourceSettled = true;
    return result;
  });
  try {
    await assert.rejects(admitLegacyOutputSessionReceipt(receipt.request), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH"));
  } finally {
    context.mock.restoreAll();
  }
  assert.equal(reviewReads, 0);
  await lstat(reviewLock);
});

test("a malformed review source with its matching coordinator digest still fails MISMATCH", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  await mkdir(lock, { mode: 0o700 });
  const review = await reviewFixture(context, "{\n");
  const receipt = await legacyAuthority(context, root, lock, { reviewPath: review.path, reviewDigest: review.digest, admit: false });
  await assert.rejects(admitLegacyOutputSessionReceipt(receipt.request), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH"));
  await lstat(lock);
});

test("review authority source non-authority forms fail MISMATCH without lock mutation", async (context) => {
  const cases = [
    async (review) => ({ path: `${review.path}.missing`, digest: review.digest }),
    async (review) => ({ path: review.path, digest: `${review.digest.slice(0, 63)}0` }),
    async (review) => { await rename(review.path, `${review.path}.target`); await symlink(`${review.path}.target`, review.path); return { path: review.path, digest: review.digest }; },
    async (review) => { await link(review.path, `${review.path}.hardlink`); return { path: review.path, digest: review.digest }; },
    async (review) => { await cp(review.path, `${review.path}.copy`); await rm(review.path); await rename(`${review.path}.copy`, review.path); return { path: review.path, digest: review.digest }; },
    async (review) => { const bytes = "{\n"; await writeFile(review.path, bytes, { mode: 0o644 }); return { path: review.path, digest: createHash("sha256").update(bytes).digest("hex") }; },
    async (review) => { const bytes = Buffer.alloc(65_537, 0x61); await writeFile(review.path, bytes, { mode: 0o644 }); return { path: review.path, digest: createHash("sha256").update(bytes).digest("hex") }; },
  ];
  for (const mutate of cases) {
    const root = await fixture(context);
    const lock = lockPath(root);
    await mkdir(lock, { mode: 0o700 });
    const review = await reviewFixture(context);
    const receipt = await legacyAuthority(context, root, lock, { reviewPath: review.path, reviewDigest: review.digest });
    const supplied = await mutate(review);
    await assert.rejects(admitLegacyOutputSessionReceipt({ receiptPath: receipt.path, receiptSha256: createHash("sha256").update(receipt.bytes).digest("hex"), reviewReceiptPath: supplied.path, reviewReceiptSha256: supplied.digest }), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH"));
    await lstat(lock);
  }
});

test("a live empty initialization cannot be deleted with a caller-minted receipt", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  await mkdir(lock, { mode: 0o700 });
  const exact = await receipt(lock);
  await assert.rejects(recoverStaleOutputSessionLock(root, exact), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_REQUIRED"));
  assert.equal((await lstat(lock)).ino, exact.lockIno);
});

test("a sibling recovery claim remains an identity-bound barrier and is never removed by a losing caller", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  await mkdir(lock, { mode: 0o700 });
  const exact = await receipt(lock);
  const claim = resolve(root, ".git/.tcrn-workflow-output-recovery-claim");
  await writeFile(claim, "foreign\n", { mode: 0o600 });
  await assert.rejects(recoverStaleOutputSessionLock(root, exact), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
  assert.equal((await lstat(lock)).ino, exact.lockIno);
  assert.equal((await lstat(claim)).mode & 0o777, 0o600);
});

test("dead owner metadata recovers while a live owner is rejected", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  await mkdir(lock, { mode: 0o700 });
  await sealOwner(lock, process.pid);
  await assert.rejects(recoverStaleOutputSessionLock(root), expectReason("OUTPUT_SESSION_RECOVERY_OWNER_LIVE"));
  await rm(resolve(lock, "owner.json"));
  await sealOwner(lock, 999999);
  assert.equal((await recoverStaleOutputSessionLock(root)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED");
});

test("descendant process-group liveness blocks recovery and normal release until the exact group is gone", async (context) => {
  const group = await liveDetachedProcessGroup();
  try {
    const root = await fixture(context);
    const lock = lockPath(root);
    await mkdir(lock, { mode: 0o700 });
    await sealOwner(lock, 999999, { processGroup: group.pid });
    const before = await snapshotFilesystem([lock, resolve(lock, "owner.json")]);
    await assert.rejects(recoverStaleOutputSessionLock(root), expectReason("OUTPUT_SESSION_RECOVERY_DESCENDANT_LIVE"));
    assert.deepEqual(await snapshotFilesystem([lock, resolve(lock, "owner.json")]), before);

    const releaseRoot = await fixture(context);
    const releaseLock = lockPath(releaseRoot);
    const runnerPath = resolve(releaseRoot, "release-group-runner.mjs");
    await writeFile(runnerPath, [
      `import { bindOutputSessionProcessGroup, withExclusiveOutputSession } from ${JSON.stringify(new URL("../scripts/lib/safe-io.mjs", import.meta.url).href)};`,
      `await withExclusiveOutputSession(${JSON.stringify(releaseRoot)}, async () => bindOutputSessionProcessGroup(${group.pid}));`,
      "",
    ].join("\n"), { mode: 0o600 });
    const runner = spawn(process.execPath, [runnerPath], { stdio: ["ignore", "ignore", "ignore"] });
    const [runnerCode, runnerSignal] = await once(runner, "exit");
    assert.equal(runnerCode, 1);
    assert.equal(runnerSignal, null);
    await lstat(releaseLock);

    await stopDetachedProcessGroup(group);
    assert.equal((await recoverStaleOutputSessionLock(root)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED");
    assert.equal((await recoverStaleOutputSessionLock(releaseRoot)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED");
    await assertRecoveryStateClean(root);
    await assertRecoveryStateClean(releaseRoot);
    await rm(runnerPath);
  } finally {
    try { process.kill(-group.pid, 0); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
});

test("a command can bind a later test-controller group only after the prior group is provably gone", async (context) => {
  const [first, second] = await Promise.all([liveDetachedProcessGroup(), liveDetachedProcessGroup()]);
  try {
    const root = await fixture(context);
    await withExclusiveOutputSession(root, async () => {
      await bindOutputSessionProcessGroup(first.pid);
      await assert.rejects(bindOutputSessionProcessGroup(second.pid), expectReason("OUTPUT_SESSION_PROCESS_GROUP_LIVE"));
      await stopDetachedProcessGroup(first);
      await bindOutputSessionProcessGroup(second.pid);
      await stopDetachedProcessGroup(second);
    });
    await assertRecoveryStateClean(root);
  } finally {
    for (const child of [first, second]) {
      try { process.kill(-child.pid, 0); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
});

test("descendant process-group EPERM and dead-group recovery preserve stable fail-closed reasons", async (context) => {
  const uncertain = await deadOwnerLock(context);
  await sealOwner(uncertain.lock, 999999, { processGroup: 999998 });
  const before = await snapshotFilesystem([uncertain.lock, resolve(uncertain.lock, "owner.json")]);
  const harness = await livenessHarness(
    uncertain.root,
    "descendant-group-eperm",
    "    process.kill(-processGroup, 0);\n",
    "",
    "EPERM",
  );
  await assert.rejects(harness.recoverStaleOutputSessionLock(uncertain.root), expectReason("OUTPUT_SESSION_RECOVERY_DESCENDANT_LIVENESS_UNKNOWN"));
  assert.deepEqual(await snapshotFilesystem([uncertain.lock, resolve(uncertain.lock, "owner.json")]), before);

  const dead = await deadOwnerLock(context);
  await sealOwner(dead.lock, 999999, { processGroup: 999998 });
  assert.equal((await recoverStaleOutputSessionLock(dead.root)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED");
  await assertRecoveryStateClean(dead.root);
});

test("owner and claimant EPERM or unknown liveness are stable reasons with state preservation", async (context) => {
  for (const code of ["EPERM", "EIO"]) {
    const owner = await deadOwnerLock(context);
    const ownerHarness = await livenessHarness(owner.root, `owner-${code}`, "    process.kill(pid, 0);\n", "", code);
    await assert.rejects(ownerHarness.recoverStaleOutputSessionLock(owner.root), expectReason("OUTPUT_SESSION_RECOVERY_OWNER_LIVENESS_UNKNOWN"));
    await lstat(owner.lock);
    await lstat(resolve(owner.lock, "owner.json"));

    const claimant = await deadOwnerLock(context);
    const claim = await sealPublishedRecoveryClaim(claimant.root, claimant.lock, { pid: 999998 });
    const claimantHarness = await livenessHarness(claimant.root, `claimant-${code}`, "    process.kill(pid, 0);\n", "", code, "pid === 999998");
    await assert.rejects(claimantHarness.recoverStaleOutputSessionLock(claimant.root), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_LIVENESS_UNKNOWN"));
    await lstat(claimant.lock);
    await lstat(claim.claimPath);
  }
});

test("PID reuse is treated as live for both owner and published claimant", async (context) => {
  const ownerRoot = await fixture(context);
  const ownerLock = lockPath(ownerRoot);
  await mkdir(ownerLock, { mode: 0o700 });
  await sealOwner(ownerLock, process.pid);
  await assert.rejects(recoverStaleOutputSessionLock(ownerRoot), expectReason("OUTPUT_SESSION_RECOVERY_OWNER_LIVE"));
  await lstat(ownerLock);
  await lstat(resolve(ownerLock, "owner.json"));

  const claimant = await deadOwnerLock(context);
  const claim = await sealPublishedRecoveryClaim(claimant.root, claimant.lock, { pid: process.pid });
  await assert.rejects(recoverStaleOutputSessionLock(claimant.root), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_LIVE"));
  await lstat(claimant.lock);
  await lstat(claim.claimPath);
});

test("failed local publication tracking is inode-bound and cannot misclassify a replaced current-PID claim", async (context) => {
  const state = await deadOwnerLock(context);
  const harness = await localPublicationReplacementHarness(state.root);
  const fixed = recoveryClaimPath(state.root);
  const originalFixed = `${fixed}.abandoned`;
  const originalStage = resolve(state.root, ".git", `abandoned-tcrn-output-recovery-claim-staging-${process.pid}-1`);
  globalThis.__tcrnLocalPublicationReplacement = async (claimPath, stagingPath) => {
    await rename(claimPath, originalFixed);
    await rename(stagingPath, originalStage);
    const error = Object.assign(new Error("simulated post-publication failure"), { code: "EIO" });
    throw error;
  };
  try {
    await assert.rejects(harness.recoverStaleOutputSessionLock(state.root), expectReason("OUTPUT_SESSION_RECOVERY_CONCURRENT"));
  } finally {
    delete globalThis.__tcrnLocalPublicationReplacement;
  }
  const replacement = await sealPublishedRecoveryClaim(state.root, state.lock, { pid: process.pid });
  const paths = [resolve(state.root, ".git"), state.lock, replacement.ownerPath, replacement.claimPath, replacement.stagingPath, originalFixed, originalStage];
  const before = await snapshotFilesystem(paths);
  await assert.rejects(harness.recoverStaleOutputSessionLock(state.root), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_LIVE"));
  assert.deepEqual(await snapshotFilesystem(paths), before);
});

test("EEXIST publication cleans only the losing stage and preserves the competing fixed claim", async (context) => {
  const state = await deadOwnerLock(context);
  const harness = await eexistPublicationHarness(state.root);
  const fixed = recoveryClaimPath(state.root);
  const staged = [];
  globalThis.__tcrnEexistPublication = async (stagingPath, claimPath) => {
    staged.push(stagingPath);
    await writeFile(claimPath, "competing fixed claim\n", { mode: 0o600 });
  };
  try {
    await assert.rejects(harness.recoverStaleOutputSessionLock(state.root), expectReason("OUTPUT_SESSION_RECOVERY_CONCURRENT"));
  } finally {
    delete globalThis.__tcrnEexistPublication;
  }
  assert.equal(staged.length, 1);
  const paths = [resolve(state.root, ".git"), state.lock, resolve(state.lock, "owner.json"), fixed, staged[0]];
  const snapshot = await snapshotFilesystem(paths);
  assert.equal(snapshot[fixed].type, "regular");
  assert.equal(snapshot[fixed].nlink, 1);
  assert.equal(snapshot[staged[0]].state, "ENOENT");
  await assert.rejects(harness.recoverStaleOutputSessionLock(state.root), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
  assert.deepEqual(await snapshotFilesystem(paths), snapshot);
});

test("dead-owner recovery has one claim winner and leaves neither lock nor sibling claim", async (context) => {
  const { root, lock } = await deadOwnerLock(context);
  const results = await Promise.allSettled([recoverStaleOutputSessionLock(root), recoverStaleOutputSessionLock(root)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.reasonCode === "OUTPUT_SESSION_RECOVERY_CONCURRENT").length, 1);
  await assert.rejects(lstat(lock), { code: "ENOENT" });
  await assert.rejects(lstat(resolve(root, ".git/.tcrn-workflow-output-recovery-claim")), { code: "ENOENT" });
});

test("two and three concurrent dead-owner recoverers permit one winner and leave CLEAN", async (context) => {
  for (const count of [2, 3]) {
    const { root, lock } = await deadOwnerLock(context);
    const results = await Promise.allSettled(Array.from({ length: count }, () => recoverStaleOutputSessionLock(root)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    for (const result of results.filter((entry) => entry.status === "rejected")) {
      assert.ok(["OUTPUT_SESSION_RECOVERY_CONCURRENT", "OUTPUT_SESSION_RECOVERY_MISSING"].includes(result.reason.reasonCode));
    }
    await assertRecoveryStateClean(root);
    await assert.rejects(lstat(lock), { code: "ENOENT" });
  }
});

test("repeated two-and-three recoverer stress records only causal losers and always reaches CLEAN", async (context) => {
  const iterationsPerWidth = 12;
  const distribution = new Map();
  for (let iteration = 0; iteration < iterationsPerWidth; iteration += 1) {
    for (const count of [2, 3]) {
      const { root } = await deadOwnerLock(context);
      const results = await Promise.allSettled(Array.from({ length: count }, () => recoverStaleOutputSessionLock(root)));
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      assert.equal(fulfilled.length, 1, `iteration ${iteration} width ${count}`);
      assert.equal(fulfilled[0].value.reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED");
      for (const result of results) {
        const reasonCode = result.status === "fulfilled" ? result.value.reasonCode : result.reason.reasonCode;
        distribution.set(reasonCode, (distribution.get(reasonCode) ?? 0) + 1);
        if (result.status === "rejected") {
          assert.ok(
            ["OUTPUT_SESSION_RECOVERY_CONCURRENT", "OUTPUT_SESSION_RECOVERY_MISSING"].includes(reasonCode),
            `iteration ${iteration} width ${count} emitted non-causal rejection ${reasonCode}`,
          );
        }
      }
      await assertRecoveryStateClean(root);
    }
  }
  assert.equal(distribution.get("OUTPUT_SESSION_STALE_LOCK_RECOVERED"), iterationsPerWidth * 2);
  assert.equal([...distribution.values()].reduce((sum, count) => sum + count, 0), iterationsPerWidth * (2 + 3));
});

test("recovery resumes each dead crash state to the exact clean terminal state", async (context) => {
  await (async () => {
    const { root, lock } = await deadOwnerLock(context);
    const stagePath = resolve(root, ".git/.tcrn-workflow-output-recovery-claim.staging-999999-1");
    await writeFile(stagePath, "", { mode: 0o600 });
    assert.equal((await recoverStaleOutputSessionLock(root)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED");
    await assertRecoveryStateClean(root);
  })();

  await (async () => {
    const { root, lock } = await deadOwnerLock(context);
    const claim = await sealPublishedRecoveryClaim(root, lock, { keepStage: true });
    assert.equal((await lstat(claim.claimPath)).nlink, 2);
    assert.equal((await lstat(claim.stagingPath)).nlink, 2);
    assert.equal((await recoverStaleOutputSessionLock(root)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED");
    await assertRecoveryStateClean(root);
  })();

  await (async () => {
    const { root, lock } = await deadOwnerLock(context);
    const claim = await sealPublishedRecoveryClaim(root, lock);
    await rm(claim.ownerPath);
    assert.equal((await recoverStaleOutputSessionLock(root)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED");
    await assertRecoveryStateClean(root);
  })();

  await (async () => {
    const { root, lock } = await deadOwnerLock(context);
    const claim = await sealPublishedRecoveryClaim(root, lock);
    await rm(claim.ownerPath);
    await rmdir(lock);
    assert.equal((await recoverStaleOutputSessionLock(root)).reasonCode, "OUTPUT_SESSION_RECOVERY_RESIDUE_CLEARED");
    await assertRecoveryStateClean(root);
  })();
});

test("recovery preserves live and replacement-bound crash states", async (context) => {
  const live = await deadOwnerLock(context);
  const liveClaim = await sealPublishedRecoveryClaim(live.root, live.lock, { pid: process.pid });
  await assert.rejects(recoverStaleOutputSessionLock(live.root), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_LIVE"));
  await lstat(live.lock);
  await lstat(liveClaim.claimPath);

  const replaced = await deadOwnerLock(context);
  const replacedClaim = await sealPublishedRecoveryClaim(replaced.root, replaced.lock);
  await rename(replaced.lock, `${replaced.lock}.old`);
  await mkdir(replaced.lock, { mode: 0o700 });
  await assert.rejects(recoverStaleOutputSessionLock(replaced.root), expectReason("OUTPUT_SESSION_RECOVERY_TARGET_REPLACED"));
  await lstat(replaced.lock);
  await lstat(replacedClaim.claimPath);
});

test("published-object and OWNER_REMOVED resume races preserve the exact foreign state", async (context) => {
  const ownerReplacement = await deadOwnerLock(context);
  const ownerClaim = await sealPublishedRecoveryClaim(ownerReplacement.root, ownerReplacement.lock);
  await rename(ownerClaim.ownerPath, `${ownerClaim.ownerPath}.original`);
  await sealOwner(ownerReplacement.lock, 999999);
  await assert.rejects(recoverStaleOutputSessionLock(ownerReplacement.root), expectReason("OUTPUT_SESSION_RECOVERY_TARGET_REPLACED"));
  await lstat(ownerClaim.claimPath);
  await lstat(resolve(ownerReplacement.lock, "owner.json"));
  await lstat(`${ownerClaim.ownerPath}.original`);

  const lockReplacement = await deadOwnerLock(context);
  const lockClaim = await sealPublishedRecoveryClaim(lockReplacement.root, lockReplacement.lock);
  await rename(lockReplacement.lock, `${lockReplacement.lock}.original`);
  await mkdir(lockReplacement.lock, { mode: 0o700 });
  await assert.rejects(recoverStaleOutputSessionLock(lockReplacement.root), expectReason("OUTPUT_SESSION_RECOVERY_TARGET_REPLACED"));
  await lstat(lockClaim.claimPath);
  await lstat(lockReplacement.lock);
  await lstat(`${lockReplacement.lock}.original`);

  const extraEntry = await deadOwnerLock(context);
  const extraClaim = await sealPublishedRecoveryClaim(extraEntry.root, extraEntry.lock);
  await rm(extraClaim.ownerPath);
  const entry = resolve(extraEntry.lock, "foreign-entry");
  await writeFile(entry, "x", { mode: 0o600 });
  await assert.rejects(recoverStaleOutputSessionLock(extraEntry.root), expectReason("OUTPUT_SESSION_RECOVERY_NOT_EMPTY"));
  await lstat(extraClaim.claimPath);
  await lstat(extraEntry.lock);
  await lstat(entry);
});

test("published claim canonical-key, binding, byte, and pathname corruption fails closed", async (context) => {
  const mutations = [
    (value) => { const { repositoryPath, ...remaining } = value; return remaining; },
    (value) => ({ ...value, unexpected: true }),
    (value) => ({ pid: value.pid, ...value }),
    (value) => ({ ...value, repositoryPath: `${value.repositoryPath}.other` }),
    (value) => ({ ...value, lockPath: `${value.lockPath}.other` }),
    () => "{\n",
  ];
  for (const mutate of mutations) {
    const state = await deadOwnerLock(context);
    const claim = await sealPublishedRecoveryClaim(state.root, state.lock);
    const original = await readFile(claim.claimPath, "utf8");
    const output = mutate(JSON.parse(original));
    await writeFile(claim.claimPath, typeof output === "string" ? output : `${JSON.stringify(output)}\n`, { mode: 0o600 });
    await assert.rejects(recoverStaleOutputSessionLock(state.root), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
    await lstat(claim.claimPath);
    await lstat(state.lock);
  }
  const replacement = await deadOwnerLock(context);
  const claim = await sealPublishedRecoveryClaim(replacement.root, replacement.lock);
  await rename(claim.claimPath, `${claim.claimPath}.original`);
  await writeFile(claim.claimPath, await readFile(`${claim.claimPath}.original`), { mode: 0o600 });
  await assert.rejects(recoverStaleOutputSessionLock(replacement.root), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
  await lstat(claim.claimPath);
  await lstat(`${claim.claimPath}.original`);
});

test("nlink2 published fixed-stage hostile corpus rejects every mutated object without cleanup", async (context) => {
  const cases = [
    { name: "fixed malformed", mutate: async ({ claimPath }) => writeFile(claimPath, "{\n", { mode: 0o600 }) },
    { name: "fixed noncanonical", mutate: async ({ claimPath }) => appendFile(claimPath, " ") },
    { name: "fixed missing key", mutate: async ({ claimPath }) => { const { repositoryPath, ...rest } = JSON.parse(await readFile(claimPath)); await writeFile(claimPath, `${JSON.stringify(rest)}\n`, { mode: 0o600 }); } },
    { name: "fixed unknown key", mutate: async ({ claimPath }) => { const value = JSON.parse(await readFile(claimPath)); await writeFile(claimPath, `${JSON.stringify({ ...value, extra: true })}\n`, { mode: 0o600 }); } },
    { name: "fixed reordered", mutate: async ({ claimPath }) => { const value = JSON.parse(await readFile(claimPath)); await writeFile(claimPath, `${JSON.stringify({ pid: value.pid, ...value })}\n`, { mode: 0o600 }); } },
    { name: "fixed wrong repository", mutate: async ({ claimPath }) => { const value = JSON.parse(await readFile(claimPath)); await writeFile(claimPath, `${JSON.stringify({ ...value, repositoryPath: `${value.repositoryPath}.other` })}\n`, { mode: 0o600 }); } },
    { name: "fixed wrong lock", mutate: async ({ claimPath }) => { const value = JSON.parse(await readFile(claimPath)); await writeFile(claimPath, `${JSON.stringify({ ...value, lockPath: `${value.lockPath}.other` })}\n`, { mode: 0o600 }); } },
    { name: "fixed oversize", mutate: async ({ claimPath }) => writeFile(claimPath, Buffer.alloc(65_537, 0x61), { mode: 0o600 }) },
    { name: "fixed symlink", extraPaths: ({ claimPath }) => [`${claimPath}.target`], mutate: async ({ claimPath }) => { await rename(claimPath, `${claimPath}.target`); await symlink(`${claimPath}.target`, claimPath); } },
    { name: "fixed directory", mutate: async ({ claimPath }) => { await rm(claimPath); await mkdir(claimPath, { mode: 0o700 }); } },
    { name: "fixed mode", mutate: async ({ claimPath }) => chmod(claimPath, 0o644) },
    { name: "fixed nlink3", extraPaths: ({ claimPath }) => [`${claimPath}.extra`], mutate: async ({ claimPath }) => link(claimPath, `${claimPath}.extra`) },
    { name: "fixed copied inode", extraPaths: ({ claimPath }) => [`${claimPath}.copy`], mutate: async ({ claimPath }) => { await cp(claimPath, `${claimPath}.copy`); await rm(claimPath); await rename(`${claimPath}.copy`, claimPath); } },
    { name: "stage symlink", extraPaths: ({ stagingPath }) => [`${stagingPath}.target`], mutate: async ({ stagingPath }) => { await rename(stagingPath, `${stagingPath}.target`); await symlink(`${stagingPath}.target`, stagingPath); } },
    { name: "stage directory", mutate: async ({ stagingPath }) => { await rm(stagingPath); await mkdir(stagingPath, { mode: 0o700 }); } },
    { name: "stage mode", mutate: async ({ stagingPath }) => chmod(stagingPath, 0o644) },
    { name: "stage nlink3", extraPaths: ({ stagingPath }) => [`${stagingPath}.extra`], mutate: async ({ stagingPath }) => link(stagingPath, `${stagingPath}.extra`) },
    { name: "stage copied to a distinct inode", extraPaths: ({ stagingPath }) => [`${stagingPath}.copy`], mutate: async ({ stagingPath }) => { await cp(stagingPath, `${stagingPath}.copy`); await rm(stagingPath); await rename(`${stagingPath}.copy`, stagingPath); } },
    {
      name: "independent fixed and stage regular files retain identical canonical bytes on different inodes",
      extraPaths: ({ claimPath, stagingPath }) => [`${claimPath}.copy`, `${stagingPath}.copy`],
      mutate: async ({ claimPath, stagingPath }) => {
        await cp(claimPath, `${claimPath}.copy`);
        await cp(stagingPath, `${stagingPath}.copy`);
        await rm(claimPath);
        await rm(stagingPath);
        await rename(`${claimPath}.copy`, claimPath);
        await rename(`${stagingPath}.copy`, stagingPath);
      },
    },
    {
      name: "fixed-stage pathname swap retains the original objects under temporary names",
      extraPaths: ({ claimPath, stagingPath }) => [
        `${claimPath}.original`, `${stagingPath}.original`, `${claimPath}.replacement`, `${stagingPath}.replacement`,
      ],
      mutate: async ({ claimPath, stagingPath }) => {
        await cp(claimPath, `${claimPath}.replacement`);
        await cp(stagingPath, `${stagingPath}.replacement`);
        await rename(claimPath, `${claimPath}.original`);
        await rename(stagingPath, `${stagingPath}.original`);
        await rename(`${stagingPath}.replacement`, claimPath);
        await rename(`${claimPath}.replacement`, stagingPath);
      },
    },
  ];
  for (const { name, extraPaths = () => [], mutate } of cases) {
    await context.test(name, async (caseContext) => {
      const state = await deadOwnerLock(caseContext);
      const claim = await sealPublishedRecoveryClaim(state.root, state.lock, { keepStage: true });
      await mutate(claim);
      const paths = recoveryRelationPaths(state, claim, extraPaths(claim));
      const before = await snapshotFilesystem(paths);
      await assert.rejects(recoverStaleOutputSessionLock(state.root), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
      assert.deepEqual(await snapshotFilesystem(paths), before, `${name} must preserve every recovery relation after rejection`);
    });
  }
});

test("test-only observed wrong UID metadata fails at each recovery validation boundary without mutation", async (context) => {
  await context.test("lock", async (caseContext) => {
    const state = await deadOwnerLock(caseContext);
    const harness = await lockObservedUidHarness(state.root);
    const paths = [resolve(state.root, ".git"), state.lock, resolve(state.lock, "owner.json")];
    const before = await snapshotFilesystem(paths);
    globalThis.__tcrnObservedLockUid = process.getuid() + 1;
    try {
      await assert.rejects(harness.recoverStaleOutputSessionLock(state.root), expectReason("OUTPUT_SESSION_RECOVERY_IDENTITY"));
    } finally {
      delete globalThis.__tcrnObservedLockUid;
    }
    assert.deepEqual(await snapshotFilesystem(paths), before);
  });
  for (const target of ["owner", "fixed", "stage"]) {
    await context.test(target, async (caseContext) => {
      const state = await deadOwnerLock(caseContext);
      const claim = target === "owner" ? undefined : await sealPublishedRecoveryClaim(state.root, state.lock, { keepStage: true });
      const targetPath = target === "owner" ? resolve(state.lock, "owner.json") : target === "fixed" ? claim.claimPath : claim.stagingPath;
      const harness = await observedUidHarness(state.root, targetPath);
      const paths = claim ? recoveryRelationPaths(state, claim) : [resolve(state.root, ".git"), state.lock, targetPath];
      const before = await snapshotFilesystem(paths);
      globalThis.__tcrnObservedUid = (path) => path === targetPath ? process.getuid() + 1 : undefined;
      try {
        await assert.rejects(harness.recoverStaleOutputSessionLock(state.root), expectReason(target === "owner" ? "OUTPUT_SESSION_METADATA_INVALID" : "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
      } finally {
        delete globalThis.__tcrnObservedUid;
      }
      assert.deepEqual(await snapshotFilesystem(paths), before);
    });
  }
});

test("FIFO and Unix-socket fixed and staging claims fail closed without mutation when supported", async (context) => {
  for (const special of ["fifo", "socket"]) {
    for (const target of ["fixed", "stage"]) {
      await context.test(`${target} ${special}`, async (caseContext) => {
        const root = special === "socket" ? await shortFixture(caseContext) : await fixture(caseContext);
        const lock = lockPath(root);
        await mkdir(lock, { mode: 0o700 });
        await sealOwner(lock, 999999);
        const state = { root, lock };
        const claim = await sealPublishedRecoveryClaim(state.root, state.lock, { keepStage: true });
        const targetPath = target === "fixed" ? claim.claimPath : claim.stagingPath;
        await rm(targetPath);
        const created = special === "fifo" ? await createFifo(targetPath) : await createUnixSocket(targetPath);
        if (!created.supported) {
          caseContext.skip(created.reason);
          return;
        }
        try {
          const paths = recoveryRelationPaths(state, claim);
          const before = await snapshotFilesystem(paths);
          await assert.rejects(recoverStaleOutputSessionLock(state.root), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
          assert.deepEqual(await snapshotFilesystem(paths), before, `${target} ${special} must remain untouched`);
        } finally {
          await created.close?.();
        }
      });
    }
  }
});

test("stage-only orphan matrix cleans only exact governed dead residue and preserves every failure state", async (context) => {
  const stage = (root, name = ".tcrn-workflow-output-recovery-claim.staging-999999-1") => resolve(root, ".git", name);
  const successCases = [
    {
      name: "dead zero-byte stage",
      create: async (root) => {
        const path = stage(root);
        await writeFile(path, "", { mode: 0o600 });
        return [path];
      },
    },
    {
      name: "dead partial-byte stage",
      create: async (root) => {
        const path = stage(root);
        await writeFile(path, '{"schemaVersion":', { mode: 0o600 });
        return [path];
      },
    },
    {
      name: "dead sealed canonical stage",
      create: async (root) => {
        const sealed = await sealRecoveryClaim(root, 999999);
        await rename(sealed.claimPath, sealed.stagingName ? resolve(root, ".git", sealed.stagingName) : stage(root));
        return [stage(root)];
      },
    },
  ];
  for (const { name, create } of successCases) {
    await context.test(name, async (caseContext) => {
      const root = await fixture(caseContext);
      const paths = await create(root);
      await withExclusiveOutputSession(root, async () => {});
      for (const path of paths) await assert.rejects(lstat(path), { code: "ENOENT" });
      await assertRecoveryStateClean(root);
    });
  }

  const failureCases = [
    { name: "live claimant", create: async (root) => [stage(root, `.tcrn-workflow-output-recovery-claim.staging-${process.pid}-1`)], bytes: "", reason: "OUTPUT_SESSION_RECOVERY_CLAIM_LIVE" },
    { name: "PID reuse", create: async (root) => [stage(root, `.tcrn-workflow-output-recovery-claim.staging-${process.pid}-2`)], bytes: "", reason: "OUTPUT_SESSION_RECOVERY_CLAIM_LIVE" },
    { name: "malformed bytes", create: async (root) => [stage(root)], bytes: "{broken}\n", reason: "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID" },
    { name: "noncanonical bytes", create: async (root) => [stage(root)], bytes: '{"unexpected":true}\n', reason: "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID" },
    { name: "oversize bytes", create: async (root) => [stage(root)], bytes: Buffer.alloc(65_537, 0x61), reason: "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID" },
    { name: "wrong filename grammar", create: async (root) => [stage(root, ".tcrn-workflow-output-recovery-claim.staging-x-1")], bytes: "", reason: "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID" },
    { name: "wrong filename pid", create: async (root) => [stage(root, ".tcrn-workflow-output-recovery-claim.staging-0-1")], bytes: "", reason: "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID" },
    { name: "wrong filename nonce", create: async (root) => [stage(root, ".tcrn-workflow-output-recovery-claim.staging-999999-0")], bytes: "", reason: "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID" },
    { name: "wrong mode", create: async (root) => [stage(root)], bytes: "", mode: 0o644, reason: "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID" },
    { name: "extra hardlink", create: async (root) => [stage(root), `${stage(root)}.extra`], bytes: "", link: true, reason: "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID" },
    {
      name: "fixed-claim coexistence",
      create: async (root) => [stage(root), recoveryClaimPath(root)],
      bytes: "",
      fixed: true,
      reason: "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID",
    },
  ];
  for (const { name, create, bytes, mode = 0o600, link: extraLink, fixed, reason } of failureCases) {
    await context.test(name, async (caseContext) => {
      const root = await fixture(caseContext);
      const paths = await create(root);
      await writeFile(paths[0], bytes, { mode });
      if (mode !== 0o600) await chmod(paths[0], mode);
      if (extraLink) await link(paths[0], paths[1]);
      if (fixed) await writeFile(recoveryClaimPath(root), "fixed", { mode: 0o600 });
      const observedPaths = [resolve(root, ".git"), lockPath(root), recoveryClaimPath(root), ...paths];
      const before = await snapshotFilesystem(observedPaths);
      await assert.rejects(withExclusiveOutputSession(root, async () => {}), expectReason(reason));
      assert.deepEqual(await snapshotFilesystem(observedPaths), before, `${name} must remain unchanged`);
    });
  }

  for (const kind of ["symlink", "directory"]) {
    await context.test(`dead stage ${kind}`, async (caseContext) => {
      const root = await fixture(caseContext);
      const path = stage(root);
      const target = `${path}.target`;
      if (kind === "symlink") {
        await writeFile(target, "target", { mode: 0o600 });
        await symlink(target, path);
      } else {
        await mkdir(path, { mode: 0o700 });
      }
      const observedPaths = [resolve(root, ".git"), lockPath(root), path, target];
      const before = await snapshotFilesystem(observedPaths);
      await assert.rejects(withExclusiveOutputSession(root, async () => {}), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
      assert.deepEqual(await snapshotFilesystem(observedPaths), before);
    });
  }

  for (const code of ["EPERM", "EIO"]) {
    await context.test(`dead stage ${code} liveness uncertainty`, async (caseContext) => {
      const root = await fixture(caseContext);
      const path = stage(root);
      await writeFile(path, "", { mode: 0o600 });
      const harness = await livenessHarness(root, `stage-${code}`, "    process.kill(pid, 0);\n", "", code);
      const observedPaths = [resolve(root, ".git"), lockPath(root), path];
      const before = await snapshotFilesystem(observedPaths);
      await assert.rejects(harness.withExclusiveOutputSession(root, async () => {}), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_LIVENESS_UNKNOWN"));
      assert.deepEqual(await snapshotFilesystem(observedPaths), before);
    });
  }

  for (const special of ["fifo", "socket"]) {
    await context.test(`dead stage ${special}`, async (caseContext) => {
      const root = special === "socket" ? await shortFixture(caseContext) : await fixture(caseContext);
      const path = stage(root);
      const created = special === "fifo" ? await createFifo(path) : await createUnixSocket(path);
      if (!created.supported) {
        caseContext.skip(created.reason);
        return;
      }
      try {
        const observedPaths = [resolve(root, ".git"), lockPath(root), path];
        const before = await snapshotFilesystem(observedPaths);
        await assert.rejects(withExclusiveOutputSession(root, async () => {}), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
        assert.deepEqual(await snapshotFilesystem(observedPaths), before);
      } finally {
        await created.close?.();
      }
    });
  }

  await context.test("pathname replacement", async (caseContext) => {
    const root = await fixture(caseContext);
    const path = stage(root);
    const original = `${path}.original`;
    await writeFile(path, "", { mode: 0o600 });
    const harness = await pathnameReplacementHarness(root);
    globalThis.__tcrnStagePathnameReplacement = async (currentPath) => {
      await rename(currentPath, original);
      await writeFile(currentPath, "replacement", { mode: 0o600 });
    };
    const observedPaths = [resolve(root, ".git"), lockPath(root), path, original];
    try {
      await assert.rejects(harness.withExclusiveOutputSession(root, async () => {}), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED"));
    } finally {
      delete globalThis.__tcrnStagePathnameReplacement;
    }
    const snapshot = await snapshotFilesystem(observedPaths);
    assert.equal(snapshot[original].type, "regular");
    assert.equal(snapshot[path].type, "regular");
    assert.equal(snapshot[lockPath(root)].state, "ENOENT");
  });
});

test("terminal recovery matrix emits success only after CLEAN readback and preserves every fail-closed state", async (context) => {
  const success = await deadOwnerLock(context);
  const harness = await terminalCleanReadbackHarness(success.root);
  let cleanReadback = false;
  globalThis.__tcrnTerminalCleanReadback = async (gitDirectory, lock, claim) => {
    const state = await snapshotFilesystem([gitDirectory, lock, claim]);
    assert.equal(state[lock].state, "ENOENT");
    assert.equal(state[claim].state, "ENOENT");
    assert.equal(state[gitDirectory].entries.some((entry) => entry.startsWith(".tcrn-workflow-output-recovery-claim.staging-")), false);
    cleanReadback = true;
  };
  try {
    assert.equal((await harness.recoverStaleOutputSessionLock(success.root)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED");
  } finally {
    delete globalThis.__tcrnTerminalCleanReadback;
  }
  assert.equal(cleanReadback, true);
  await assertRecoveryStateClean(success.root);

  const failure = await deadOwnerLock(context);
  const claim = await sealPublishedRecoveryClaim(failure.root, failure.lock, { keepStage: true });
  await chmod(claim.stagingPath, 0o644);
  const paths = recoveryRelationPaths(failure, claim);
  const before = await snapshotFilesystem(paths);
  await assert.rejects(recoverStaleOutputSessionLock(failure.root), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
  assert.deepEqual(await snapshotFilesystem(paths), before, "fail-closed recovery must preserve the exact pre-call state");
});

test("stage-only live and malformed residue is preserved while exact dead canonical partial residue is cleared", async (context) => {
  const live = await deadOwnerLock(context);
  const liveStage = resolve(live.root, ".git", `.tcrn-workflow-output-recovery-claim.staging-${process.pid}-1`);
  await writeFile(liveStage, "", { mode: 0o600 });
  await assert.rejects(recoverStaleOutputSessionLock(live.root), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_LIVE"));
  await lstat(liveStage);

  const malformed = await deadOwnerLock(context);
  const malformedStage = resolve(malformed.root, ".git/.tcrn-workflow-output-recovery-claim.staging-999999-1");
  await mkdir(malformedStage, { mode: 0o700 });
  await assert.rejects(recoverStaleOutputSessionLock(malformed.root), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
  await lstat(malformedStage);

  const dead = await deadOwnerLock(context);
  const deadStage = resolve(dead.root, ".git/.tcrn-workflow-output-recovery-claim.staging-999999-1");
  // The stage writer may be killed at any byte boundary.  Recovery accepts
  // only a proper prefix of the exact claim it can derive from this lock and
  // owner, rather than treating arbitrary short bytes as ours.
  await writeFile(deadStage, '{"schemaVersion":"tcrn.output-session-recovery-claim.v1","pid":999999,', { mode: 0o600 });
  assert.equal((await recoverStaleOutputSessionLock(dead.root)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED");
  await assertRecoveryStateClean(dead.root);

  for (const bytes of [
    '{"schemaVersion":',
    '{"schemaVersion":"tcrn.output-session-recovery-claim.v1","pid":999999,"uid":',
  ]) {
    const partial = await deadOwnerLock(context);
    await writeFile(resolve(partial.root, ".git/.tcrn-workflow-output-recovery-claim.staging-999999-1"), bytes, { mode: 0o600 });
    assert.equal((await recoverStaleOutputSessionLock(partial.root)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED");
    await assertRecoveryStateClean(partial.root);
  }

  for (const bytes of ["not-a-prefix", '{"schemaVersion":"tcrn.output-session-recovery-claim.v1"}\n']) {
    const invalid = await deadOwnerLock(context);
    const stagePath = resolve(invalid.root, ".git/.tcrn-workflow-output-recovery-claim.staging-999999-1");
    await writeFile(stagePath, bytes, { mode: 0o600 });
    const before = await snapshotFilesystem([invalid.lock, resolve(invalid.lock, "owner.json"), stagePath]);
    await assert.rejects(recoverStaleOutputSessionLock(invalid.root), expectReason("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID"));
    assert.deepEqual(await snapshotFilesystem([invalid.lock, resolve(invalid.lock, "owner.json"), stagePath]), before);
  }
});

test("recovery rejects every malformed, copied, linked, nonregular, mode, and foreign metadata form", async (context) => {
  const cases = [
    async ({ ownerPath }) => { await chmod(ownerPath, 0o644); },
    async ({ ownerPath }) => { await writeFile(ownerPath, "{\n"); },
    async ({ ownerPath }) => { await writeFile(ownerPath, `${JSON.stringify({ malformed: true })}\n`); },
    async ({ ownerPath }) => { await writeFile(ownerPath, `${JSON.stringify({ schemaVersion: ownerSchema, pid: 999999, uid: process.getuid() + 1, lockDev: 1, lockIno: 1, ownerDev: 1, ownerIno: 1 })}\n`); },
    async ({ ownerPath }) => { await cp(ownerPath, `${ownerPath}.copy`); await rm(ownerPath); await rename(`${ownerPath}.copy`, ownerPath); },
    async ({ ownerPath }) => { await link(ownerPath, `${ownerPath}.link`); },
    async ({ ownerPath }) => { await rm(ownerPath); await mkdir(ownerPath); },
    async ({ ownerPath }) => { await rm(ownerPath); await writeFile(`${ownerPath}.target`, "x"); await symlink(`${ownerPath}.target`, ownerPath); },
  ];
  for (const mutate of cases) {
    await (async () => {
      const root = await mkdtemp(join(tmpdir(), "tcrn-output-session-negative-"));
      try {
        await mkdir(resolve(root, ".git"));
        const lock = lockPath(root);
        await mkdir(lock, { mode: 0o700 });
        const owner = await sealOwner(lock, 999999);
        await mutate(owner);
        await assert.rejects(recoverStaleOutputSessionLock(root), expectReason("OUTPUT_SESSION_METADATA_INVALID"));
      } finally { await rm(root, { recursive: true, force: true }); }
    })();
  }
});

test("recovery rejects foreign lock mode and lock replacement", async (context) => {
  const { root, lock } = await deadOwnerLock(context);
  await chmod(lock, 0o755);
  await assert.rejects(recoverStaleOutputSessionLock(root), expectReason("OUTPUT_SESSION_RECOVERY_IDENTITY"));
  await chmod(lock, 0o700);
  const old = `${lock}.old`;
  await rename(lock, old);
  await mkdir(lock, { mode: 0o700 });
  await assert.rejects(recoverStaleOutputSessionLock(root), expectReason("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_REQUIRED"));
});

test("guarded output rejects a replaced lock before writing and release rejects a replaced lock", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  await withExclusiveOutputSession(root, async () => {
    const old = `${lock}.old`;
    await rename(lock, old);
    await mkdir(lock, { mode: 0o700 });
    await assert.rejects(safeWriteOutput(root, "dist/evidence/replaced.json", "{}\n"), expectReason("OUTPUT_SESSION_LOST"));
    await rm(lock, { recursive: true });
    await rename(old, lock);
  });
  await assert.rejects(lstat(lock), { code: "ENOENT" });

  const second = await fixture(context);
  const secondLock = lockPath(second);
  await assert.rejects(withExclusiveOutputSession(second, async () => {
    await rename(secondLock, `${secondLock}.old`);
    await mkdir(secondLock, { mode: 0o700 });
  }), expectReason("OUTPUT_SESSION_RELEASE_REPLACED"));
});

function childScript(root) {
  const safeIo = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  return `import { withExclusiveOutputSession } from ${JSON.stringify(safeIo.href)}; await withExclusiveOutputSession(${JSON.stringify(root)}, async () => { process.stdout.write('LOCKED' + String.fromCharCode(10)); await new Promise(() => setInterval(() => {}, 1000)); });`;
}

async function waitLocked(child) {
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  for (let elapsed = 0; elapsed < 2000 && !output.includes("LOCKED\n"); elapsed += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(output, "LOCKED\n");
}

test("SIGINT and SIGTERM release owned sessions with their conventional exit status", async (context) => {
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const root = await fixture(context);
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript(root)], { stdio: ["ignore", "pipe", "pipe"] });
    await waitLocked(child);
    const exited = once(child, "exit");
    child.kill(signal);
    const [code, receivedSignal] = await exited;
    assert.equal(receivedSignal, null);
    assert.equal(code, exitCode);
    await assert.rejects(lstat(lockPath(root)), { code: "ENOENT" });
  }
});

test("forced crash leaves recoverable dead-owner metadata", async (context) => {
  const root = await fixture(context);
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript(root)], { stdio: ["ignore", "pipe", "pipe"] });
  await waitLocked(child);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.equal((await recoverStaleOutputSessionLock(root)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED");
  await assert.rejects(lstat(lockPath(root)), { code: "ENOENT" });
});

test("acquisition provenance recovers a dead claimant before, during, and after initial owner publication", async (context) => {
  const safeIo = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  for (const point of ["after-marker-publication", "after-lock-mkdir", "after-owner-publication"]) {
    const root = await fixture(context);
    const runner = spawn(process.execPath, ["--input-type=module", "--eval", [
      `import { withExclusiveOutputSession } from ${JSON.stringify(safeIo.href)};`,
      `await withExclusiveOutputSession(${JSON.stringify(root)}, async () => {});`,
    ].join("\n")], {
      env: { ...process.env, TCRN_TEST_OUTPUT_SESSION_ACQUISITION_CRASH_AT: point },
      stdio: "ignore",
    });
    const [code, signal] = await once(runner, "exit");
    assert.equal(code, null, point);
    assert.equal(signal, "SIGKILL", point);
    await withExclusiveOutputSession(root, async () => {});
    await assertRecoveryStateClean(root);
  }
});

test("acquisition hard-link publication resumes every durable crash boundary", async (context) => {
  const safeIo = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  for (const point of ["stage-open", "stage-partial", "stage-fsynced", "before-link", "nlink2", "stage-unlinked", "fixed-nlink1"]) {
    const root = await fixture(context);
    const runner = spawn(process.execPath, ["--input-type=module", "--eval", [
      `import { withExclusiveOutputSession } from ${JSON.stringify(safeIo.href)};`,
      `await withExclusiveOutputSession(${JSON.stringify(root)}, async () => {});`,
    ].join("\n")], {
      env: { ...process.env, TCRN_TEST_OUTPUT_SESSION_ACQUISITION_PUBLICATION_CRASH_AT: point },
      stdio: "ignore",
    });
    const [code, signal] = await once(runner, "exit");
    assert.equal(code, null, point);
    assert.equal(signal, "SIGKILL", point);
    await withExclusiveOutputSession(root, async () => {});
    await assertRecoveryStateClean(root);
  }
});

test("dead acquisition stages accept exact arbitrary proper prefixes and reject non-prefix residue", async (context) => {
  for (const select of [0, 1, 80, -1]) {
    const root = await fixture(context);
    const staged = await sealAcquisitionStage(root);
    const length = select < 0 ? staged.canonical.length - 1 : Math.min(select, staged.canonical.length - 1);
    await writeFile(staged.stagePath, staged.canonical.slice(0, length), { mode: 0o600 });
    await withExclusiveOutputSession(root, async () => {});
    await assert.rejects(lstat(staged.stagePath), { code: "ENOENT" });
    await assertRecoveryStateClean(root);
  }
  for (const bytes of ["not-a-prefix", '{"schemaVersion":"tcrn.output-session-acquisition-claim.v1"}\n']) {
    const root = await fixture(context);
    const staged = await sealAcquisitionStage(root, 999999, { bytes });
    const before = await snapshotFilesystem([resolve(root, ".git"), staged.stagePath]);
    await assert.rejects(withExclusiveOutputSession(root, async () => {}), expectReason("OUTPUT_SESSION_ACQUISITION_INVALID"));
    assert.deepEqual(await snapshotFilesystem([resolve(root, ".git"), staged.stagePath]), before);
  }
});

test("dead acquisition fixed-stage publication and loser residue resume without replacing the winner", async (context) => {
  const root = await fixture(context);
  const published = await sealAcquisitionStage(root);
  await link(published.stagePath, acquisitionClaimPath(root));
  assert.equal((await lstat(published.stagePath)).nlink, 2);
  await withExclusiveOutputSession(root, async () => {});
  await assertRecoveryStateClean(root);

  const loserRoot = await fixture(context);
  const winner = await sealAcquisitionStage(loserRoot, 999999, { sequence: 1 });
  await rename(winner.stagePath, acquisitionClaimPath(loserRoot));
  const loser = await sealAcquisitionStage(loserRoot, 999999, { sequence: 2 });
  const beforeWinner = await readFile(acquisitionClaimPath(loserRoot), "utf8");
  await withExclusiveOutputSession(loserRoot, async () => {});
  assert.notEqual(beforeWinner, "");
  await assertRecoveryStateClean(loserRoot);
});

test("normal-release provenance resumes ownerless and lockless interruptions without legacy authority", async (context) => {
  const safeIo = new URL("../scripts/lib/safe-io.mjs", import.meta.url);
  for (const point of ["after-owner-unlink", "after-lock-rmdir"]) {
    const root = await fixture(context);
    const runner = spawn(process.execPath, ["--input-type=module", "--eval", [
      `import { withExclusiveOutputSession } from ${JSON.stringify(safeIo.href)};`,
      `await withExclusiveOutputSession(${JSON.stringify(root)}, async () => {});`,
    ].join("\n")], {
      env: { ...process.env, TCRN_TEST_OUTPUT_SESSION_RELEASE_FAILURE_AT: point },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [code, signal] = await once(runner, "exit");
    assert.equal(code, 1, point);
    assert.equal(signal, null, point);
    const claim = recoveryClaimPath(root);
    await lstat(claim);
    if (point === "after-owner-unlink") {
      await lstat(lockPath(root));
      await assert.rejects(lstat(resolve(lockPath(root), "owner.json")), { code: "ENOENT" });
    } else {
      await assert.rejects(lstat(lockPath(root)), { code: "ENOENT" });
    }
    // A fresh contender consumes only the transaction it can authenticate;
    // no historical legacy receipt is admitted for this new ownerless state.
    await withExclusiveOutputSession(root, async () => {});
    await assertRecoveryStateClean(root);
  }
});

test("a stale release-lock observation restarts only after an exact CLEAN reread", async (context) => {
  const state = await deadOwnerLock(context);
  const oldLock = await lstat(state.lock);
  const claim = await sealPublishedRecoveryClaim(state.root, state.lock);
  await rm(resolve(state.lock, "owner.json"));
  const harness = await acquisitionRestartHarness(state.root);
  globalThis.__tcrnAcquisitionRestartInterleave = async ({ lockPath: observedLock, recoveryClaim }) => {
    assert.equal(observedLock, state.lock);
    assert.equal(recoveryClaim, claim.claimPath);
    const current = await lstat(observedLock);
    assert.equal(current.dev, oldLock.dev);
    assert.equal(current.ino, oldLock.ino);
    await rmdir(observedLock);
    await rm(recoveryClaim);
  };
  try {
    await harness.withExclusiveOutputSession(state.root, async () => {});
  } finally {
    delete globalThis.__tcrnAcquisitionRestartInterleave;
  }
  await assertRecoveryStateClean(state.root);
});

test("two-process release and acquisition interleavings preserve the release transaction and restart claim-held", async (context) => {
  const runPausedRelease = async (root, harnessUrl, suffix) => {
    const readyPath = resolve(root, `release-${suffix}.ready`);
    const goPath = resolve(root, `release-${suffix}.go`);
    const owner = startExclusiveOutputSession(harnessUrl, root, {
      TCRN_TEST_RELEASE_READY_PATH: readyPath,
      TCRN_TEST_RELEASE_GO_PATH: goPath,
    });
    await waitForPath(readyPath, owner.result);
    const lock = await lstat(lockPath(root));
    const claimBytes = await readFile(recoveryClaimPath(root), "utf8");
    await assert.rejects(lstat(resolve(lockPath(root), "owner.json")), { code: "ENOENT" });
    process.kill(owner.child.pid, 0);
    return { owner, readyPath, goPath, lock, claimBytes };
  };
  const release = async ({ owner, goPath }) => {
    await writeFile(goPath, "go\n", { mode: 0o600, flag: "wx" });
    const result = await owner.result;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.stdout, "OK\n");
    assert.equal(result.stderr, "");
  };

  // Schedule A: a contender observes the existing ownerless lock while the
  // original releaser and its fixed recovery transaction are still live. It
  // must not create an acquisition marker or replace the old lock.
  const scheduleARoot = await fixture(context);
  const scheduleAHarness = await releaseAcquisitionInterleaveHarness(scheduleARoot);
  const scheduleA = await runPausedRelease(scheduleARoot, scheduleAHarness, "a");
  const ordinary = await startExclusiveOutputSession(new URL("../scripts/lib/safe-io.mjs", import.meta.url).href, scheduleARoot).result;
  assert.equal(ordinary.code, 1, ordinary.stderr);
  assert.equal(ordinary.signal, null, ordinary.stderr);
  assert.equal(ordinary.stdout, "");
  assert.equal(JSON.parse(ordinary.stderr).reasonCode, "OUTPUT_SESSION_RECOVERY_CLAIM_LIVE");
  const scheduleALockAfter = await lstat(lockPath(scheduleARoot));
  assert.equal(scheduleALockAfter.dev, scheduleA.lock.dev);
  assert.equal(scheduleALockAfter.ino, scheduleA.lock.ino);
  assert.equal(await readFile(recoveryClaimPath(scheduleARoot), "utf8"), scheduleA.claimBytes);
  await assert.rejects(lstat(acquisitionClaimPath(scheduleARoot)), { code: "ENOENT" });
  assert.equal((await readdir(resolve(scheduleARoot, ".git"))).some((name) => name.startsWith(".tcrn-workflow-output-acquisition-claim.staging-")), false);
  process.kill(scheduleA.owner.child.pid, 0);
  await release(scheduleA);
  await assertRecoveryStateClean(scheduleARoot);

  // Schedule B: the contender is deliberately paused after observing that
  // same old lock. The releaser naturally reaches CLEAN; only then may the
  // contender restart, publish its own fixed acquisition claim, mkdir, and
  // complete. The copied source records the claim identity immediately before
  // mkdir so this is a real two-process ordering proof, not test-side cleanup.
  const scheduleBRoot = await fixture(context);
  const scheduleBHarness = await releaseAcquisitionInterleaveHarness(scheduleBRoot);
  const scheduleB = await runPausedRelease(scheduleBRoot, scheduleBHarness, "b");
  const observedPath = resolve(scheduleBRoot, "acquisition-observed");
  const continuePath = resolve(scheduleBRoot, "acquisition-continue");
  const publishedPath = resolve(scheduleBRoot, "acquisition-published.json");
  const restarting = startExclusiveOutputSession(scheduleBHarness, scheduleBRoot, {
    TCRN_TEST_ACQUISITION_OBSERVED_PATH: observedPath,
    TCRN_TEST_ACQUISITION_CONTINUE_PATH: continuePath,
    TCRN_TEST_ACQUISITION_PUBLISHED_PATH: publishedPath,
  });
  await waitForPath(observedPath, restarting.result);
  const scheduleBObservedLock = await lstat(lockPath(scheduleBRoot));
  assert.equal(scheduleBObservedLock.dev, scheduleB.lock.dev);
  assert.equal(scheduleBObservedLock.ino, scheduleB.lock.ino);
  await release(scheduleB);
  await assertRecoveryStateClean(scheduleBRoot);
  await writeFile(continuePath, "continue\n", { mode: 0o600, flag: "wx" });
  const restarted = await restarting.result;
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.equal(restarted.signal, null, restarted.stderr);
  assert.equal(restarted.stdout, "OK\n");
  assert.equal(restarted.stderr, "");
  const publication = JSON.parse(await readFile(publishedPath, "utf8"));
  assert.equal(publication.pid, restarting.child.pid);
  assert.equal(publication.claimPid, restarting.child.pid);
  await assertRecoveryStateClean(scheduleBRoot);
});

test("atomic owner-group publication recovers before and after its durable replacement", async (context) => {
  for (const point of ["group-stage-open", "group-stage-partial", "group-stage-fsynced", "prepublication", "afterpublication"]) {
    const root = await fixture(context);
    const runnerPath = resolve(root, `owner-publication-${point}.mjs`);
    await writeFile(runnerPath, [
      `import { bindOutputSessionProcessGroup, withExclusiveOutputSession } from ${JSON.stringify(new URL("../scripts/lib/safe-io.mjs", import.meta.url).href)};`,
      `await withExclusiveOutputSession(${JSON.stringify(root)}, async () => bindOutputSessionProcessGroup(999998));`,
      "",
    ].join("\n"), { mode: 0o600 });
    const runner = spawn(process.execPath, [runnerPath], {
      env: { ...process.env, TCRN_TEST_OWNER_PUBLICATION_CRASH_AT: point },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const [code, signal] = await once(runner, "exit");
    assert.equal(code, null, point);
    assert.equal(signal, "SIGKILL", point);
    assert.equal((await recoverStaleOutputSessionLock(root)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED", point);
    await assertRecoveryStateClean(root);
    await rm(runnerPath);
  }
});

test("atomic initial owner publication recovers before and after its durable replacement", async (context) => {
  for (const point of ["initial-stage-open", "initial-stage-partial", "initial-stage-fsynced", "initial-prepublication", "initial-afterpublication"]) {
    const root = await fixture(context);
    const runnerPath = resolve(root, `initial-owner-publication-${point}.mjs`);
    await writeFile(runnerPath, [
      `import { withExclusiveOutputSession } from ${JSON.stringify(new URL("../scripts/lib/safe-io.mjs", import.meta.url).href)};`,
      `await withExclusiveOutputSession(${JSON.stringify(root)}, async () => {});`,
      "",
    ].join("\n"), { mode: 0o600 });
    const runner = spawn(process.execPath, [runnerPath], {
      env: { ...process.env, TCRN_TEST_OWNER_PUBLICATION_CRASH_AT: point },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const [code, signal] = await once(runner, "exit");
    assert.equal(code, null, point);
    assert.equal(signal, "SIGKILL", point);
    assert.equal((await recoverStaleOutputSessionLock(root)).reasonCode, "OUTPUT_SESSION_STALE_LOCK_RECOVERED", point);
    await assertRecoveryStateClean(root);
    await rm(runnerPath);
  }
});

test("a malformed owner-publication stage preserves the dead lock fail-closed", async (context) => {
  const root = await fixture(context);
  const lock = lockPath(root);
  await mkdir(lock, { mode: 0o700 });
  await sealOwner(lock, 999999);
  const stagePath = resolve(lock, ".owner.json.staging-999999-0-1");
  await writeFile(stagePath, "foreign\\n", { mode: 0o600 });
  const before = await snapshotFilesystem([lock, resolve(lock, "owner.json"), stagePath]);
  await assert.rejects(recoverStaleOutputSessionLock(root), expectReason("OUTPUT_SESSION_METADATA_INVALID"));
  assert.deepEqual(await snapshotFilesystem([lock, resolve(lock, "owner.json"), stagePath]), before);
});

test("an unbound detached test controller exits before discovery after its task owner dies", async (context) => {
  const importPath = resolve(await mkdtemp(join(tmpdir(), "tcrn-test-import-")), "imported");
  context.after(() => rm(resolve(importPath, ".."), { recursive: true, force: true }));
  const root = await taskEntrypointFixture(context, [
    'import { writeFileSync } from "node:fs";',
    'import test from "node:test";',
    'if (process.env.TCRN_TEST_BIND_WINDOW_IMPORT_PATH) writeFileSync(process.env.TCRN_TEST_BIND_WINDOW_IMPORT_PATH, "test-source-imported\\n");',
    'test("only a durably bound controller may import this source", () => {});',
    "",
  ].join("\n"));
  const readyPath = resolve(root, "bind-window-ready.json");
  const orphanPath = resolve(root, "bind-window-orphan.json");
  const holdPath = resolve(root, "bind-window-release");
  const interrupted = startTaskEntrypoint(root, {
    TCRN_TEST_BIND_WINDOW_READY_PATH: readyPath,
    TCRN_TEST_BIND_WINDOW_ORPHAN_PATH: orphanPath,
    TCRN_TEST_BIND_WINDOW_HOLD_PATH: holdPath,
    TCRN_TEST_BIND_WINDOW_ORPHAN_DELAY_MS: "3000",
    TCRN_TEST_BIND_WINDOW_IMPORT_PATH: importPath,
  });
  await waitForPath(lockPath(root), interrupted.result);
  await waitForPath(readyPath, interrupted.result);
  const ready = await readJsonWhenReady(readyPath, interrupted.result);
  assert.ok(Number.isSafeInteger(ready.processGroup) && ready.processGroup > 0);
  assert.deepEqual(JSON.parse(await readFile(resolve(lockPath(root), "owner.json"), "utf8")).processGroup, null);
  await assert.rejects(lstat(importPath), { code: "ENOENT" });

  // This SIGKILL lands after detached spawn but before the task is allowed to
  // bind owner.processGroup.  The bootstrap remains alive briefly only to
  // make the no-wait contender observation deterministic; it terminates
  // before spawning Node's test controller, so no test worker can start.
  interrupted.child.kill("SIGKILL");
  const interruptedResult = await interrupted.result;
  assert.equal(interruptedResult.code, null, JSON.stringify(interruptedResult));
  assert.equal(interruptedResult.signal, "SIGKILL", JSON.stringify(interruptedResult));
  assert.equal(interruptedResult.stdout, "");
  assert.equal(interruptedResult.stderr, "");
  await waitForPath(orphanPath);
  process.kill(ready.processGroup, 0);
  await assert.rejects(lstat(importPath), { code: "ENOENT" });

  const contender = startTaskEntrypoint(root);
  // A dead outer owner may be recovered here, but this explicitly proves the
  // only surviving predecessor is an inert bootstrap: it is still live and
  // the predecessor test source has not been imported.
  process.kill(ready.processGroup, 0);
  const contenderResult = await contender.result;
  assert.equal(contenderResult.code, 0, contenderResult.stderr);
  assert.equal(contenderResult.signal, null);
  assert.equal(contenderResult.stderr, "");
  assert.equal(JSON.parse(contenderResult.stdout).reasonCode, "TESTS_VERIFIED");
  await assert.rejects(lstat(importPath), { code: "ENOENT" });
  await waitForDeadPid(ready.processGroup);
  await assertTaskResidueClean(root);
});

test("a pre-bind process-group bind failure terminates the controller before test discovery", async (context) => {
  const importPath = resolve(await mkdtemp(join(tmpdir(), "tcrn-test-import-")), "imported");
  context.after(() => rm(resolve(importPath, ".."), { recursive: true, force: true }));
  const root = await taskEntrypointFixture(context, [
    'import { writeFileSync } from "node:fs";',
    'import test from "node:test";',
    'if (process.env.TCRN_TEST_BIND_WINDOW_IMPORT_PATH) writeFileSync(process.env.TCRN_TEST_BIND_WINDOW_IMPORT_PATH, "test-source-imported\\n");',
    'test("pre-bind failure never discovers this source", () => {});',
    "",
  ].join("\n"));
  const failed = await startTaskEntrypoint(root, {
    TCRN_TEST_BIND_PROCESS_GROUP_FAILURE: "1",
    TCRN_TEST_BIND_WINDOW_IMPORT_PATH: importPath,
  }).result;
  assert.equal(failed.code, 1);
  assert.equal(failed.signal, null);
  assert.equal(failed.stdout, "");
  assert.equal(JSON.parse(failed.stderr).reasonCode, "TEST_CONTROLLER_BIND_INJECTED_FAILURE");
  await assert.rejects(lstat(importPath), { code: "ENOENT" });
  await assertTaskResidueClean(root);
});

test("a bound bootstrap blocks recovery before it starts the test controller", async (context) => {
  const importPath = resolve(await mkdtemp(join(tmpdir(), "tcrn-test-import-")), "imported");
  context.after(() => rm(resolve(importPath, ".."), { recursive: true, force: true }));
  const root = await taskEntrypointFixture(context, [
    'import { writeFileSync } from "node:fs";',
    'import test from "node:test";',
    'if (process.env.TCRN_TEST_BIND_WINDOW_IMPORT_PATH) writeFileSync(process.env.TCRN_TEST_BIND_WINDOW_IMPORT_PATH, "test-source-imported\\n");',
    'test("controller starts only after its group was recorded", () => {});',
    "",
  ].join("\n"));
  const boundPath = resolve(root, "bind-window-bound.json");
  const runPath = resolve(root, "bind-window-run");
  const interrupted = startTaskEntrypoint(root, {
    TCRN_TEST_BIND_WINDOW_BOUND_PATH: boundPath,
    TCRN_TEST_BIND_WINDOW_RUN_PATH: runPath,
    TCRN_TEST_BIND_WINDOW_IMPORT_PATH: importPath,
  });
  await waitForPath(lockPath(root), interrupted.result);
  await waitForPath(boundPath, interrupted.result);
  const bound = await readJsonWhenReady(boundPath, interrupted.result);
  assert.ok(Number.isSafeInteger(bound.processGroup) && bound.processGroup > 0);
  const owner = JSON.parse(await readFile(resolve(lockPath(root), "owner.json"), "utf8"));
  assert.equal(owner.processGroup, bound.processGroup);
  await assert.rejects(lstat(importPath), { code: "ENOENT" });

  // The outer task is gone, but the durably bound bootstrap group is still
  // live and has not created the Node test controller.  Recovery must fail
  // closed rather than allowing a contender to rebuild dist concurrently.
  interrupted.child.kill("SIGKILL");
  const interruptedResult = await interrupted.result;
  assert.equal(interruptedResult.code, null, JSON.stringify(interruptedResult));
  assert.equal(interruptedResult.signal, "SIGKILL", JSON.stringify(interruptedResult));
  assert.equal(interruptedResult.stdout, "");
  assert.equal(interruptedResult.stderr, "");
  const noWait = await startTaskEntrypoint(root).result;
  assert.equal(noWait.code, 1);
  assert.equal(noWait.signal, null);
  assert.equal(noWait.stdout, "");
  assert.equal(JSON.parse(noWait.stderr).reasonCode, "OUTPUT_SESSION_RECOVERY_DESCENDANT_LIVE");
  await lstat(lockPath(root));
  await assert.rejects(lstat(importPath), { code: "ENOENT" });

  await writeFile(runPath, "run\\n", { mode: 0o600, flag: "wx" });
  await waitForPath(importPath);
  await waitForDeadPid(bound.processGroup);
  const recovered = await startTaskEntrypoint(root).result;
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(recovered.signal, null);
  assert.equal(recovered.stderr, "");
  assert.equal(JSON.parse(recovered.stdout).reasonCode, "TESTS_VERIFIED");
  await assertTaskResidueClean(root);
});

test("a fresh real task entrypoint fails closed while a killed predecessor group lives, then recovers cleanly", async (context) => {
  const crashSource = [
    'import { writeFileSync } from "node:fs";',
    'import test from "node:test";',
    'writeFileSync(process.env.TCRN_TASK_DESCENDANT_PID_PATH, `${JSON.stringify({ testPid: process.pid, controllerPid: process.ppid, processGroup: Number(process.env.TCRN_TEST_CONTROLLER_PROCESS_GROUP) })}\\n`);',
    'test("remain alive while the outer lifecycle probe kills the actual task entrypoint", async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });',
    "",
  ].join("\n");
  const root = await taskEntrypointFixture(context, crashSource);
  const interrupted = startTaskEntrypoint(root);
  await waitForPath(lockPath(root), interrupted.result);
  await waitForPath(resolve(root, "descendant.pid"), interrupted.result);
  const descendants = JSON.parse(await readFile(resolve(root, "descendant.pid"), "utf8"));
  assert.ok(Number.isSafeInteger(descendants.testPid) && descendants.testPid > 0);
  assert.ok(Number.isSafeInteger(descendants.controllerPid) && descendants.controllerPid > 0);
  assert.ok(Number.isSafeInteger(descendants.processGroup) && descendants.processGroup > 0);
  // The bootstrap launches a Node test controller plus a test-file process.
  // The recovery run starts only after both recorded descendants are gone, so
  // it cannot overlap a surviving importer of dist/build.
  interrupted.child.kill("SIGKILL");
  const interruptedResult = await interrupted.result;
  assert.equal(interruptedResult.code, null, JSON.stringify(interruptedResult));
  assert.equal(interruptedResult.signal, "SIGKILL", JSON.stringify(interruptedResult));
  assert.equal(interruptedResult.stdout, "");
  assert.equal(interruptedResult.stderr, "");
  const owner = JSON.parse(await readFile(resolve(lockPath(root), "owner.json"), "utf8"));
  assert.equal(owner.processGroup, descendants.processGroup);
  const noWait = await startTaskEntrypoint(root).result;
  assert.equal(noWait.code, 1);
  assert.equal(noWait.signal, null);
  assert.equal(noWait.stdout, "");
  assert.equal(JSON.parse(noWait.stderr).reasonCode, "OUTPUT_SESSION_RECOVERY_DESCENDANT_LIVE");
  await lstat(lockPath(root));
  // The test controller is the leader of a dedicated detached process group;
  // its worker and controller must both be gone before stale-owner recovery
  // is permitted to acquire the command-wide output session.
  await waitForDeadPid(descendants.testPid);
  await waitForDeadPid(descendants.controllerPid);
  await waitForDeadPid(descendants.processGroup);
  await rm(resolve(root, "descendant.pid"));

  await writeFile(resolve(root, "tests/entrypoint.test.mjs"), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'test("fresh task fixture", () => { assert.equal(2 + 2, 4); });',
    "",
  ].join("\n"), { mode: 0o600 });
  runGit(root, ["add", "tests/entrypoint.test.mjs"]);
  runGit(root, ["commit", "--quiet", "-m", "recovery fixture"]);
  assert.equal(spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).stdout, "");
  const recovered = startTaskEntrypoint(root);
  const result = await recovered.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, result.stdout);
  assert.deepEqual(JSON.parse(lines[0]), { ok: true, command: "test", reasonCode: "TESTS_VERIFIED", tests: ["tests/entrypoint.test.mjs"], result: "passed" });
  assert.deepEqual(JSON.parse(await readFile(resolve(root, "dist/evidence/p1/test.json"), "utf8")), {
    schemaVersion: "tcrn.command-evidence.v1",
    command: "test",
    ok: true,
    reasonCode: "TESTS_VERIFIED",
    result: { reasonCode: "TESTS_VERIFIED", tests: ["tests/entrypoint.test.mjs"], result: "passed" },
  });
  await assertTaskResidueClean(root);
});

test("a concurrent real task entrypoint preserves its live command-wide owner and rejects the contender", async (context) => {
  const root = await taskEntrypointFixture(context, [
    'import test from "node:test";',
    'test("hold the command-wide session while dist build imports remain stable", async () => { await new Promise((resolve) => setTimeout(resolve, 1_000)); });',
    "",
  ].join("\n"));
  const owner = startTaskEntrypoint(root);
  await waitForPath(lockPath(root), owner.result);
  const contender = await startTaskEntrypoint(root).result;
  assert.equal(contender.code, 1);
  assert.equal(contender.signal, null);
  assert.equal(contender.stdout, "");
  const contenderReceipt = JSON.parse(contender.stderr);
  assert.equal(contenderReceipt.ok, false);
  assert.equal(contenderReceipt.reasonCode, "OUTPUT_SESSION_RECOVERY_OWNER_LIVE", contender.stderr);
  await lstat(lockPath(root));
  const ownerResult = await owner.result;
  assert.equal(ownerResult.code, 0, ownerResult.stderr);
  assert.equal(ownerResult.signal, null);
  assert.equal(ownerResult.stderr, "");
  await assertTaskResidueClean(root);
});

test("the real command-five test path rejects detached inherited-pipe descendants and reproduces the rejected cycle only in a disposable fixture", async (context) => {
  const holderSource = [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'import test from "node:test";',
    'const lockPath = process.env.TCRN_TEST_CONTROLLER_LOCK_PATH;',
    'const holder = spawn(process.execPath, ["--eval", "const { existsSync } = require(\\\"node:fs\\\"); const lock = process.argv[1]; const timer = setInterval(() => { if (!existsSync(lock)) { clearInterval(timer); process.exit(0); } }, 10);", lockPath], { detached: true, stdio: "inherit" });',
    'holder.unref();',
    'writeFileSync(process.env.TCRN_TASK_PIPE_HOLDER_PID_PATH, String(holder.pid) + "\\n");',
    'test("the descendant waits for the command-wide lock", () => {});',
    "",
  ].join("\n");
  const current = await taskEntrypointFixture(context, holderSource);
  const currentHolderPath = resolve(current, "pipe-holder.pid");
  const currentResult = await startTaskEntrypoint(current, {
    TCRN_TASK_PIPE_HOLDER_PID_PATH: currentHolderPath,
  }).result;
  assert.equal(currentResult.code, 1, currentResult.stderr);
  assert.equal(currentResult.signal, null);
  assert.equal(currentResult.stdout, "");
  const currentReceipt = JSON.parse(currentResult.stderr);
  assert.equal(currentReceipt.reasonCode, "COMMAND_FAILED");
  assert.equal(currentReceipt.error.includes("TEST_CONTROLLER_DETACHED_DESCENDANT_FORBIDDEN"), true);
  await assert.rejects(lstat(currentHolderPath), { code: "ENOENT" });
  await assertTaskResidueClean(current);

  // Reconstruct the rejected controller stream topology in a second clean
  // fixture. The detached holder waits for the retained lock, while the old
  // controller close waits for that holder's inherited task-facing pipe.
  const rejected = await taskEntrypointFixture(context, holderSource);
  const rejectedBootstrapPath = resolve(rejected, "scripts/test-controller-bootstrap.mjs");
  const fixedBootstrap = await readFile(rejectedBootstrapPath, "utf8");
  const rejectedMarker = "// Test-controller output goes to private regular files, never inherited pipes.\n";
  assert.equal(fixedBootstrap.includes(rejectedMarker), true, "controller topology fixture boundary");
  const rejectedBootstrap = `${fixedBootstrap.slice(0, fixedBootstrap.indexOf(rejectedMarker))}const testController = spawn(process.execPath, testArguments, {\n  stdio: "inherit",\n  env: { ...process.env, TCRN_TEST_CONTROLLER_PROCESS_GROUP: String(process.pid) },\n});\nconst result = await new Promise((resolveResult, rejectResult) => {\n  testController.once("error", rejectResult);\n  testController.once("close", (code, signal) => resolveResult({ code, signal }));\n});\nprocess.exitCode = result.code ?? (result.signal ? 1 : 1);\n`;
  await writeFile(rejectedBootstrapPath, rejectedBootstrap, { mode: 0o600 });
  runGit(rejected, ["add", "scripts/test-controller-bootstrap.mjs"]);
  runGit(rejected, ["commit", "--quiet", "-m", "rejected inherited-stream bootstrap"]);
  const rejectedHolderPath = resolve(rejected, "pipe-holder.pid");
  const rejectedRun = startTaskEntrypoint(rejected, {
    TCRN_TASK_PIPE_HOLDER_PID_PATH: rejectedHolderPath,
  });
  await waitForPath(rejectedHolderPath, rejectedRun.result);
  const early = await Promise.race([
    rejectedRun.result.then(() => "settled"),
    new Promise((resolveDelay) => setTimeout(() => resolveDelay("pending"), 500)),
  ]);
  assert.equal(early, "pending", "rejected inherited pipe must delay terminal task close");
  const rejectedHolder = Number(await readFile(rejectedHolderPath, "utf8"));
  const rejectedOwner = JSON.parse(await readFile(resolve(lockPath(rejected), "owner.json"), "utf8"));
  assert.ok(Number.isSafeInteger(rejectedOwner.processGroup) && rejectedOwner.processGroup > 0);
  // Dispose only the captured disposable processes; no lock or claim is
  // removed manually. A later real task invocation performs governed stale
  // owner recovery after the cycle has been demonstrated.
  rejectedRun.child.kill("SIGKILL");
  await rejectedRun.result;
  process.kill(rejectedHolder, "SIGKILL");
  process.kill(-rejectedOwner.processGroup, "SIGKILL");
  await waitForDeadPid(rejectedHolder);
  await waitForDeadPid(rejectedOwner.processGroup);
  await writeFile(resolve(rejected, "tests/entrypoint.test.mjs"), [
    'import test from "node:test";',
    'test("recovered fixture", () => {});',
    "",
  ].join("\n"), { mode: 0o600 });
  runGit(rejected, ["add", "tests/entrypoint.test.mjs"]);
  runGit(rejected, ["commit", "--quiet", "-m", "recovery fixture"]);
  const recovered = await startTaskEntrypoint(rejected).result;
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).reasonCode, "TESTS_VERIFIED");
  await assertTaskResidueClean(rejected);
});

test("the real command-five test path rejects a same-group inherited descendant before terminal release", async (context) => {
  const source = [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'import test from "node:test";',
    'const lockPath = process.env.TCRN_TEST_CONTROLLER_LOCK_PATH;',
    'const child = spawn(process.execPath, ["--eval", "const { existsSync } = require(\\\"node:fs\\\"); const lock = process.argv[1]; const timer = setInterval(() => { if (!existsSync(lock)) { clearInterval(timer); process.exit(0); } }, 10);", lockPath], { stdio: "inherit" });',
    'writeFileSync(process.env.TCRN_TASK_PIPE_HOLDER_PID_PATH, String(child.pid) + "\\n");',
    'test("the controller exits while its same-group descendant awaits cleanup", () => {});',
    "",
  ].join("\n");
  const root = await taskEntrypointFixture(context, source);
  const holderPath = resolve(root, "pipe-holder.pid");
  const result = await startTaskEntrypoint(root, { TCRN_TASK_PIPE_HOLDER_PID_PATH: holderPath }).result;
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  const receipt = JSON.parse(result.stderr);
  assert.equal(receipt.reasonCode, "COMMAND_FAILED");
  assert.equal(receipt.error.includes("TEST_CONTROLLER_INHERITED_STDIO_FORBIDDEN"), true);
  await assert.rejects(lstat(holderPath), { code: "ENOENT" });
  await assertTaskResidueClean(root);
});

test("a permitted real-entrypoint Node relay cannot create a detached escaped descendant", async (context) => {
  const source = [
    'import assert from "node:assert/strict";',
    'import { spawn } from "node:child_process";',
    'import { once } from "node:events";',
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import test from "node:test";',
    'test("a permitted relay retains the controller child policy", async () => {',
    '  const relay = [',
    '    "const { spawn } = require(\\\"node:child_process\\\");",',
    '    "const { writeFileSync } = require(\\\"node:fs\\\");",',
    '    "const attempted = [",',
    '    "  [\\\"TEST_CONTROLLER_DETACHED_DESCENDANT_FORBIDDEN\\\", () => spawn(process.execPath, [\\\"--eval\\\", \\\"setInterval(() => {}, 1000);\\\"], { detached: true, stdio: \\\"ignore\\\" })],",',
    '    "  [\\\"TEST_CONTROLLER_INHERITED_STDIO_FORBIDDEN\\\", () => spawn(process.execPath, [\\\"--eval\\\", \\\"\\\"], { stdio: \\\"inherit\\\" })],",',
    '    "];",',
    '    "const codes = attempted.map(([expected, attempt]) => { try { attempt(); return \\\"escaped\\\"; } catch (error) { return error.code === expected ? error.code : \\\"unexpected\\\"; } });",',
    '    "writeFileSync(process.env.TCRN_TASK_RELAY_RESULT_PATH, codes.join(\\\",\\\") + \\\"\\\\n\\\");",',
    '    "process.exit(codes.every((code, index) => code === attempted[index][0]) ? 0 : 1);",',
    '  ].join("\\n");',
    '  const child = spawn(process.execPath, ["--eval", relay], {',
    '    env: { TCRN_TASK_RELAY_RESULT_PATH: process.env.TCRN_TASK_RELAY_RESULT_PATH, NODE_OPTIONS: "" },',
    '    stdio: "ignore",',
    '  });',
    '  const [code, signal] = await once(child, "exit");',
    '  assert.equal(code, 0);',
    '  assert.equal(signal, null);',
    '  assert.equal(readFileSync(process.env.TCRN_TASK_RELAY_RESULT_PATH, "utf8"), "TEST_CONTROLLER_DETACHED_DESCENDANT_FORBIDDEN,TEST_CONTROLLER_INHERITED_STDIO_FORBIDDEN\\n");',
    '});',
    "",
  ].join("\n");
  const root = await taskEntrypointFixture(context, source);
  const relayResultPath = resolve(root, "relay-result.txt");
  const result = await startTaskEntrypoint(root, { TCRN_TASK_RELAY_RESULT_PATH: relayResultPath }).result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    command: "test",
    reasonCode: "TESTS_VERIFIED",
    tests: ["tests/entrypoint.test.mjs"],
    result: "passed",
  });
  await rm(relayResultPath);
  await assertTaskResidueClean(root);
});

test("the controller child policy rejects detached escape through every supported child_process signature", () => {
  const policy = new URL("../scripts/test-controller-child-policy.mjs", import.meta.url).href;
  const source = [
    'import { exec, execFile, fork, spawn, spawnSync } from "node:child_process";',
    'const attempts = [',
    '  () => spawn(process.execPath, { detached: true }),',
    '  () => spawn(process.execPath, [], { detached: true }),',
    '  () => spawnSync(process.execPath, { detached: true }),',
    '  () => spawnSync(process.execPath, [], { detached: true }),',
    '  () => exec("ignored", { detached: true }),',
    '  () => execFile(process.execPath, { detached: true }),',
    '  () => execFile(process.execPath, [], { detached: true }),',
    '  () => fork("ignored.mjs", { detached: true }),',
    '  () => fork("ignored.mjs", [], { detached: true }),',
    '];',
    'const codes = attempts.map((attempt) => { try { attempt(); return "escaped"; } catch (error) { return error.code; } });',
    'process.stdout.write(JSON.stringify(codes));',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--import", policy, "--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), Array(9).fill("TEST_CONTROLLER_DETACHED_DESCENDANT_FORBIDDEN"));
});

test("the controller child policy propagates to a Node relay even when it supplies an empty environment", () => {
  const policy = new URL("../scripts/test-controller-child-policy.mjs", import.meta.url).href;
  const relay = [
    'const { spawnSync } = require("node:child_process");',
    'try { spawnSync(process.execPath, ["--eval", ""], { detached: true, stdio: "ignore" }); process.stdout.write("escaped"); }',
    'catch (error) { process.stdout.write(error.code ?? "unexpected"); }',
  ].join("\n");
  const source = [
    'import { spawnSync } from "node:child_process";',
    `const result = spawnSync(process.execPath, ["--eval", ${JSON.stringify(relay)}], { encoding: "utf8", env: {} });`,
    'process.stdout.write(result.stdout);',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--import", policy, "--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "TEST_CONTROLLER_DETACHED_DESCENDANT_FORBIDDEN");
});

test("a passing detached test that writes stderr fails the real task entrypoint cleanly", async (context) => {
  const root = await taskEntrypointFixture(context, [
    'import test from "node:test";',
    'test("the underlying detached test passes", () => {});',
    "",
  ].join("\n"));
  const bootstrapPath = resolve(root, "scripts/test-controller-bootstrap.mjs");
  const bootstrap = await readFile(bootstrapPath, "utf8");
  const exitMarker = "process.exitCode = result.code ?? (result.signal ? 1 : 1);\n";
  const fixtureStderr = "process.stderr.write(\"test-only detached controller stderr\\n\");\n";
  assert.equal(bootstrap.split(exitMarker).length, 2, "fixture bootstrap terminal boundary");
  await writeFile(bootstrapPath, bootstrap.replace(exitMarker, `${fixtureStderr}${exitMarker}`), { mode: 0o600 });
  runGit(root, ["add", "scripts/test-controller-bootstrap.mjs"]);
  runGit(root, ["commit", "--quiet", "-m", "fixture controller stderr"]);
  assert.equal(spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).stdout, "");
  const result = await startTaskEntrypoint(root).result;
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stdout, "");
  const lines = result.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, result.stderr);
  const receipt = JSON.parse(lines[0]);
  assert.deepEqual({ ok: receipt.ok, command: receipt.command, reasonCode: receipt.reasonCode }, {
    ok: false,
    command: "test",
    reasonCode: "COMMAND_UNEXPECTED_STDERR",
  });
  assert.equal(result.stderr.includes("TESTS_VERIFIED"), false);
  assert.equal(result.stderr.includes("test-only detached controller stderr"), true);
  assert.deepEqual(JSON.parse(await readFile(resolve(root, "dist/evidence/p1/test.json"), "utf8")), {
    schemaVersion: "tcrn.command-evidence.v1",
    command: "test",
    ok: false,
    reasonCode: "COMMAND_UNEXPECTED_STDERR",
    error: receipt.error,
  });
  await assertTaskResidueClean(root);
});

test("a nonzero detached controller propagates COMMAND_FAILED and releases the real task entrypoint cleanly", async (context) => {
  const root = await taskEntrypointFixture(context, [
    'import test from "node:test";',
    'test("the detached controller fails", () => { throw new Error("test-only nonzero controller failure"); });',
    "",
  ].join("\n"));
  const result = await startTaskEntrypoint(root).result;
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  const lines = result.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, result.stderr);
  const receipt = JSON.parse(lines[0]);
  assert.deepEqual({ ok: receipt.ok, command: receipt.command, reasonCode: receipt.reasonCode }, {
    ok: false,
    command: "test",
    reasonCode: "COMMAND_FAILED",
  });
  assert.equal(receipt.error.includes("test-only nonzero controller failure"), true);
  assert.equal(result.stderr.includes("TESTS_VERIFIED"), false);
  assert.deepEqual(JSON.parse(await readFile(resolve(root, "dist/evidence/p1/test.json"), "utf8")), {
    schemaVersion: "tcrn.command-evidence.v1",
    command: "test",
    ok: false,
    reasonCode: "COMMAND_FAILED",
    error: receipt.error,
  });
  await assertTaskResidueClean(root);
});

test("SIGKILL injection at each staged publication and release boundary resumes deterministically", async (context) => {
  const points = [
    ["stage-created", "    stagingIdentity = await handle.stat();\n", {}, "stage"],
    ["stage-partial", "    await handle.writeFile(expectedBytes);\n", { before: true, partial: true }, "stage"],
    ["stage-fsynced", "    await handle.writeFile(expectedBytes);\n    await handle.sync();\n", {}, "stage"],
    ["published-before-git-fsync", "    try { await link(stagingPath, claimPath); } catch (error) {\n      if (error.code === \"EEXIST\") {\n        await validateRecoveryClaim(stagingPath, stagingIdentity, expectedBytes, \"OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED\");\n        await rm(stagingPath).catch((cleanupError) => fail(\"OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED\", `${stagingPath}: ${cleanupError.code ?? cleanupError.message}`));\n        await syncDirectory(dirname(claimPath), \"OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED\");\n        fail(\"OUTPUT_SESSION_RECOVERY_CONCURRENT\", claimPath);\n      }\n      throw error;\n    }\n    await syncDirectory(dirname(claimPath), \"OUTPUT_SESSION_RECOVERY_CONCURRENT\");\n", { anchor: "      throw error;\n    }\n" }, "nlink2"],
    ["nlink2-before-stage-unlink", "    await rm(stagingPath).catch((error) => fail(\"OUTPUT_SESSION_RECOVERY_CONCURRENT\", `${stagingPath}: ${error.code ?? error.message}`));\n", { before: true }, "nlink2"],
    ["stage-unlink-before-second-git-fsync", "    if (stagingAfterLink.nlink !== 2) fail(\"OUTPUT_SESSION_RECOVERY_CONCURRENT\", stagingPath);\n    await rm(stagingPath).catch((error) => fail(\"OUTPUT_SESSION_RECOVERY_CONCURRENT\", `${stagingPath}: ${error.code ?? error.message}`));\n", {}, "fixed"],
    ["stage-unlinked", "    await rm(stagingPath).catch((error) => fail(\"OUTPUT_SESSION_RECOVERY_CONCURRENT\", `${stagingPath}: ${error.code ?? error.message}`));\n    await syncDirectory(dirname(claimPath), \"OUTPUT_SESSION_RECOVERY_CONCURRENT\");\n", {}, "fixed"],
    ["owner-unlinked-before-fsync", "  await syncDirectory(lockPath, \"OUTPUT_SESSION_RELEASE_FAILED\");\n", { before: true }, "owner-absent"],
    ["owner-unlinked-after-fsync", "  const afterOwnerUnlink = await pathMetadata(lockPath, \"OUTPUT_SESSION_RELEASE_FAILED\");\n", { before: true }, "owner-absent"],
    ["lock-rmdir-before-git-fsync", "  await syncDirectory(dirname(lockPath), \"OUTPUT_SESSION_RELEASE_FAILED\");\n", { before: true }, "lock-absent"],
    ["lock-rmdir-after-git-fsync", "  await rmdir(lockPath).catch((error) => fail(\"OUTPUT_SESSION_RELEASE_FAILED\", `${lockPath}: ${error.code ?? error.message}`));\n  injectReleaseFailure(\"after-lock-rmdir\");\n  await syncDirectory(dirname(lockPath), \"OUTPUT_SESSION_RELEASE_FAILED\");\n", {}, "lock-absent"],
    ["fixed-unlinked-before-git-fsync", "  await validateRecoveryClaim(claimPath, claimIdentity, expectedBytes, \"OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED\");\n  await rm(claimPath).catch((error) => fail(\"OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED\", `${claimPath}: ${error.code ?? error.message}`));\n", {}, "clean"],
    ["fixed-unlinked-after-git-fsync", "  await validateRecoveryClaim(claimPath, claimIdentity, expectedBytes, \"OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED\");\n  await rm(claimPath).catch((error) => fail(\"OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED\", `${claimPath}: ${error.code ?? error.message}`));\n  await syncDirectory(dirname(claimPath), \"OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED\");\n", {}, "clean"],
  ];
  for (const [name, marker, options, state] of points) {
    const { root, lock } = await deadOwnerLock(context);
    await crashInjectionHarness(root, name, marker, options);
    const claim = recoveryClaimPath(root);
    if (state === "stage") {
      const stages = (await (await import("node:fs/promises")).readdir(resolve(root, ".git"))).filter((entry) => entry.startsWith(".tcrn-workflow-output-recovery-claim.staging-"));
      assert.equal(stages.length, 1, name);
      const stage = await lstat(resolve(root, ".git", stages[0]));
      assert.equal(stage.nlink, 1, name);
      assert.equal(stage.mode & 0o777, 0o600, name);
      if (name === "stage-created") assert.equal(stage.size, 0, name);
      if (name === "stage-partial") assert.equal(stage.size, Buffer.byteLength('{"schemaVersion":'), name);
      await assert.rejects(lstat(claim), { code: "ENOENT" });
    } else if (state === "nlink2") {
      const fixed = await lstat(claim);
      const stages = (await (await import("node:fs/promises")).readdir(resolve(root, ".git"))).filter((entry) => entry.startsWith(".tcrn-workflow-output-recovery-claim.staging-"));
      assert.equal(stages.length, 1, name);
      const stage = await lstat(resolve(root, ".git", stages[0]));
      assert.equal(fixed.nlink, 2, name);
      assert.equal(stage.nlink, 2, name);
      assert.equal(fixed.dev, stage.dev, name);
      assert.equal(fixed.ino, stage.ino, name);
      assert.equal(fixed.mode & 0o777, 0o600, name);
    } else if (state === "owner-absent") {
      await lstat(lock);
      await assert.rejects(lstat(resolve(lock, "owner.json")), { code: "ENOENT" });
      assert.equal((await lstat(claim)).nlink, 1, name);
    } else if (state === "fixed") {
      assert.equal((await lstat(claim)).nlink, 1, name);
    } else if (state === "lock-absent") {
      await assert.rejects(lstat(lock), { code: "ENOENT" });
      await lstat(claim);
    } else {
      await assertRecoveryStateClean(root);
    }
    const restarted = await recoverStaleOutputSessionLock(root).catch((error) => error);
    if (state === "clean") assert.equal(restarted.reasonCode, "OUTPUT_SESSION_RECOVERY_MISSING", name);
    else assert.ok(["OUTPUT_SESSION_STALE_LOCK_RECOVERED", "OUTPUT_SESSION_RECOVERY_RESIDUE_CLEARED"].includes(restarted.reasonCode), name);
    await assertRecoveryStateClean(root);
  }
});
