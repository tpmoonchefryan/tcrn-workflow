// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

let temporarySequence = 0;
const outputSessionStorage = new AsyncLocalStorage();
const locallyPublishedRecoveryClaims = new Map();
const locallyPublishingRecoveryClaims = new Map();
const outputLockName = "tcrn-workflow-output.lock";
const outputLockMetadataName = "owner.json";
const outputOwnerStagePrefix = ".owner.json.staging-";
const outputRecoveryClaimName = ".tcrn-workflow-output-recovery-claim";
const outputAcquisitionClaimName = ".tcrn-workflow-output-acquisition-claim";
const outputAcquisitionStagePrefix = ".tcrn-workflow-output-acquisition-claim.staging-";
const maximumRecoveryClaimBytes = 65_536;
const outputOwnerFields = ["schemaVersion", "pid", "uid", "lockDev", "lockIno", "ownerDev", "ownerIno", "processGroup"];
const recoveryClaimFields = ["schemaVersion", "pid", "uid", "repositoryPath", "lockPath", "stagingName", "claimDev", "claimIno", "lockDev", "lockIno", "lockCtimeMs", "lockMtimeMs", "ownerDev", "ownerIno", "ownerBytes"];
const acquisitionClaimFields = ["schemaVersion", "pid", "uid", "repositoryPath", "lockPath", "claimDev", "claimIno"];
const recoveryStagePattern = /^\.tcrn-workflow-output-recovery-claim\.staging-([1-9][0-9]*)-([1-9][0-9]*)$/;
const recoveryClaimCanonicalPrefix = '{"schemaVersion":"tcrn.output-session-recovery-claim.v1",';
const outputOwnerStagePattern = /^\.owner\.json\.staging-([1-9][0-9]*)-(0|[1-9][0-9]*)-([1-9][0-9]*)$/;
const outputAcquisitionStagePattern = /^\.tcrn-workflow-output-acquisition-claim\.staging-([1-9][0-9]*)-([1-9][0-9]*)$/;
const legacyAuthorityBrand = new WeakSet();
const legacyReceiptFields = ["schemaVersion", "repositoryPath", "lockPath", "lockDev", "lockIno", "lockCtimeMs", "lockMtimeMs", "lockUid", "lockMode", "lockEntries", "findingId", "reviewReceiptPath", "reviewReceiptSha256", "reviewReceiptDev", "reviewReceiptIno", "reviewReceiptCtimeMs", "reviewReceiptMtimeMs"];
const legacyFindingId = "RC4-ROUND2-OUTPUT-SESSION-LIFECYCLE-1";

export class BoundaryError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "BoundaryError";
    this.reasonCode = reasonCode;
  }
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function isLocallyPublishedRecoveryClaim(path, metadata) {
  const published = locallyPublishedRecoveryClaims.get(path);
  return Boolean(published && sameIdentity(published, metadata));
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}

async function readReviewReceipt(path, expectedDigest, reasonCode) {
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expectedDigest ?? "")) fail(reasonCode, "review receipt authority");
  const canonicalPath = await realpath(path).catch(() => fail(reasonCode, path));
  if (canonicalPath !== path) fail(reasonCode, path);
  const before = await pathMetadata(path, reasonCode);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.size > maximumRecoveryClaimBytes) fail(reasonCode, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => fail(reasonCode, `${path}: ${error.code ?? error.message}`));
  try {
    const opened = await handle.stat();
    if (!sameIdentity(before, opened) || opened.nlink !== before.nlink || opened.uid !== before.uid || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs || opened.size > maximumRecoveryClaimBytes) fail(reasonCode, path);
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(16_384, maximumRecoveryClaimBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumRecoveryClaimBytes) fail(reasonCode, path);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const settled = await handle.stat();
    if (!sameIdentity(opened, settled) || settled.nlink !== opened.nlink || settled.uid !== opened.uid || settled.size !== opened.size || settled.mtimeMs !== opened.mtimeMs || settled.ctimeMs !== opened.ctimeMs) fail(reasonCode, path);
    const bytes = Buffer.concat(chunks, total).toString("utf8");
    const after = await pathMetadata(path, reasonCode);
    if (!sameIdentity(opened, after) || after.nlink !== opened.nlink || after.uid !== opened.uid || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || sha256(bytes) !== expectedDigest) fail(reasonCode, path);
    let parsed;
    try { parsed = JSON.parse(bytes); } catch { fail(reasonCode, path); }
    if (parsed?.combinedFinding?.id !== legacyFindingId) fail(reasonCode, path);
    return { identity: opened, bytes };
  } finally { await handle.close(); }
}

function parseLegacyReceipt(bytes, metadata, canonicalPath) {
  let value;
  try { value = JSON.parse(bytes); } catch { fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", canonicalPath); }
  if (bytes !== `${JSON.stringify(value)}\n` || JSON.stringify(Object.keys(value)) !== JSON.stringify(legacyReceiptFields) ||
      value?.schemaVersion !== "tcrn.output-session-legacy-receipt.v1" || !isAbsolute(value.repositoryPath) || !isAbsolute(value.lockPath) ||
      !Number.isSafeInteger(value.lockDev) || !Number.isSafeInteger(value.lockIno) || !Number.isFinite(value.lockCtimeMs) || !Number.isFinite(value.lockMtimeMs) ||
      !Number.isSafeInteger(value.lockUid) || value.lockMode !== 0o700 || JSON.stringify(value.lockEntries) !== "[]" || value.findingId !== legacyFindingId ||
      !isAbsolute(value.reviewReceiptPath) || !/^[a-f0-9]{64}$/.test(value.reviewReceiptSha256 ?? "") || !Number.isSafeInteger(value.reviewReceiptDev) || !Number.isSafeInteger(value.reviewReceiptIno) || !Number.isFinite(value.reviewReceiptCtimeMs) || !Number.isFinite(value.reviewReceiptMtimeMs)) {
    fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", canonicalPath);
  }
  return value;
}

export async function admitLegacyOutputSessionReceipt({ receiptPath, receiptSha256: expectedDigest, reviewReceiptPath, reviewReceiptSha256 } = {}) {
  if (!isAbsolute(receiptPath) || !/^[a-f0-9]{64}$/.test(expectedDigest ?? "")) fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", "legacy receipt authority");
  const canonicalPath = await realpath(receiptPath).catch(() => fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", receiptPath));
  if (canonicalPath !== receiptPath) fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", receiptPath);
  const source = await readBoundClaim(canonicalPath, "OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH");
  if (source.metadata.nlink !== 1) fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", canonicalPath);
  if (sha256(source.bytes) !== expectedDigest) fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", canonicalPath);
  const value = parseLegacyReceipt(source.bytes, source.metadata, canonicalPath);
  const repositoryReal = await realpath(value.repositoryPath).catch(() => fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", value.repositoryPath));
  if (value.repositoryPath !== repositoryReal || inside(repositoryReal, canonicalPath) || value.lockPath !== resolve(repositoryReal, ".git", outputLockName)) fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", canonicalPath);
  if (value.reviewReceiptPath !== reviewReceiptPath || value.reviewReceiptSha256 !== reviewReceiptSha256) fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", canonicalPath);
  const review = await readReviewReceipt(reviewReceiptPath, reviewReceiptSha256, "OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH");
  if (value.reviewReceiptDev !== review.identity.dev || value.reviewReceiptIno !== review.identity.ino || value.reviewReceiptCtimeMs !== review.identity.ctimeMs || value.reviewReceiptMtimeMs !== review.identity.mtimeMs) fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", canonicalPath);
  const authority = freezeDeep({ value, sourcePath: canonicalPath, sourceDigest: expectedDigest, sourceIdentity: source.metadata, sourceBytes: source.bytes, reviewPath: reviewReceiptPath, reviewDigest: reviewReceiptSha256, reviewIdentity: review.identity, reviewBytes: review.bytes });
  legacyAuthorityBrand.add(authority);
  return authority;
}

async function validateLegacyAuthority(authority, repository, lock) {
  if (!authority || typeof authority !== "object" || !legacyAuthorityBrand.has(authority)) fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_REQUIRED", "legacy receipt authority");
  const source = await readBoundClaim(authority.sourcePath, "OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH");
  if (source.metadata.nlink !== 1 || !sameIdentity(source.metadata, authority.sourceIdentity) || source.bytes !== authority.sourceBytes || sha256(source.bytes) !== authority.sourceDigest) fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", authority.sourcePath);
  const value = parseLegacyReceipt(source.bytes, source.metadata, authority.sourcePath);
  const review = await readReviewReceipt(authority.reviewPath, authority.reviewDigest, "OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH");
  if (!sameIdentity(review.identity, authority.reviewIdentity) || review.bytes !== authority.reviewBytes || value.repositoryPath !== repository.realPath || value.lockPath !== resolve(repository.realPath, ".git", outputLockName) ||
      value.lockDev !== lock.dev || value.lockIno !== lock.ino || value.lockCtimeMs !== lock.ctimeMs || value.lockMtimeMs !== lock.mtimeMs || value.lockUid !== lock.uid || value.lockMode !== (lock.mode & 0o777) ||
      value.reviewReceiptDev !== review.identity.dev || value.reviewReceiptIno !== review.identity.ino || value.reviewReceiptCtimeMs !== review.identity.ctimeMs || value.reviewReceiptMtimeMs !== review.identity.mtimeMs) fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", authority.sourcePath);
}

function outputLockMetadata(lock, ownerUid, ownerIdentity, processGroup = null, pid = process.pid) {
  return {
    schemaVersion: "tcrn.output-session-owner.v1",
    pid,
    uid: ownerUid,
    lockDev: lock.dev,
    lockIno: lock.ino,
    ownerDev: ownerIdentity?.dev ?? 0,
    ownerIno: ownerIdentity?.ino ?? 0,
    processGroup,
  };
}

function assertOutputLockIdentity(lock, expectedIdentity, reasonCode, path) {
  if (lock.isSymbolicLink() || !lock.isDirectory() || lock.uid !== process.getuid?.() || (lock.mode & 0o777) !== 0o700 ||
      (expectedIdentity && !sameIdentity(lock, expectedIdentity))) {
    fail(reasonCode, path);
  }
}

function injectReleaseFailure(point) {
  if (process.env.TCRN_TEST_OUTPUT_SESSION_RELEASE_FAILURE_AT === point) {
    fail("OUTPUT_SESSION_RELEASE_INJECTED_FAILURE", point);
  }
}

async function releaseOutputSession(lockPath, expectedIdentity, { deadOwner = false, ownerIdentity } = {}) {
  const before = await pathMetadata(lockPath, "OUTPUT_SESSION_RELEASE_FAILED");
  assertOutputLockIdentity(before, expectedIdentity, "OUTPUT_SESSION_RELEASE_REPLACED", lockPath);
  const ownerPath = resolve(lockPath, outputLockMetadataName);
  const owner = await readOutputLockMetadata(lockPath).catch(() => fail("OUTPUT_SESSION_RELEASE_REPLACED", ownerPath));
  if (owner.value.lockDev !== before.dev || owner.value.lockIno !== before.ino || (!deadOwner && owner.value.pid !== process.pid) ||
      (ownerIdentity && !sameIdentity(owner.identity, ownerIdentity))) {
    fail("OUTPUT_SESSION_RELEASE_REPLACED", ownerPath);
  }
  if (!deadOwner) {
    assertDeadProcessGroup(
      owner.value.processGroup,
      "OUTPUT_SESSION_RELEASE_DESCENDANT_LIVE",
      "OUTPUT_SESSION_RELEASE_DESCENDANT_LIVENESS_UNKNOWN",
    );
  }
  const ownerBeforeUnlink = await pathMetadata(ownerPath, "OUTPUT_SESSION_RELEASE_FAILED");
  if (!sameIdentity(owner.identity, ownerBeforeUnlink)) fail("OUTPUT_SESSION_RELEASE_REPLACED", ownerPath);
  await rm(ownerPath).catch((error) => fail("OUTPUT_SESSION_RELEASE_FAILED", `${lockPath}: ${error.code ?? error.message}`));
  injectReleaseFailure("after-owner-unlink");
  await syncDirectory(lockPath, "OUTPUT_SESSION_RELEASE_FAILED");
  const afterOwnerUnlink = await pathMetadata(lockPath, "OUTPUT_SESSION_RELEASE_FAILED");
  assertOutputLockIdentity(afterOwnerUnlink, before, "OUTPUT_SESSION_RELEASE_REPLACED", lockPath);
  await rmdir(lockPath).catch((error) => fail("OUTPUT_SESSION_RELEASE_FAILED", `${lockPath}: ${error.code ?? error.message}`));
  injectReleaseFailure("after-lock-rmdir");
  await syncDirectory(dirname(lockPath), "OUTPUT_SESSION_RELEASE_FAILED");
}

async function readOutputLockMetadataAt(lockPath, path) {
  const { metadata, bytes } = await readBoundClaim(path, "OUTPUT_SESSION_METADATA_INVALID");
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) {
    fail("OUTPUT_SESSION_METADATA_INVALID", path);
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes);
    if (bytes !== `${JSON.stringify(parsed)}\n`) fail("OUTPUT_SESSION_METADATA_INVALID", path);
  } catch (error) {
    fail("OUTPUT_SESSION_METADATA_INVALID", `${lockPath}: ${error.code ?? error.message}`);
  }
  if (JSON.stringify(Object.keys(parsed ?? {})) !== JSON.stringify(outputOwnerFields) ||
      parsed?.schemaVersion !== "tcrn.output-session-owner.v1" || !Number.isSafeInteger(parsed.pid) || !Number.isSafeInteger(parsed.uid) ||
      parsed.uid !== metadata.uid || !Number.isSafeInteger(parsed.lockDev) || !Number.isSafeInteger(parsed.lockIno) ||
      (parsed.processGroup !== null && (!Number.isSafeInteger(parsed.processGroup) || parsed.processGroup <= 0)) ||
      parsed.ownerDev !== metadata.dev || parsed.ownerIno !== metadata.ino) {
    fail("OUTPUT_SESSION_METADATA_INVALID", lockPath);
  }
  const afterRead = await pathMetadata(path, "OUTPUT_SESSION_METADATA_INVALID");
  if (!sameIdentity(metadata, afterRead) || afterRead.isSymbolicLink() || !afterRead.isFile() || afterRead.nlink !== 1 ||
      afterRead.uid !== metadata.uid || (afterRead.mode & 0o777) !== 0o600) {
    fail("OUTPUT_SESSION_METADATA_INVALID", path);
  }
  return { value: parsed, identity: metadata, bytes };
}

async function readOutputLockMetadata(lockPath) {
  return readOutputLockMetadataAt(lockPath, resolve(lockPath, outputLockMetadataName));
}

async function clearDeadOwnerPublicationStages(lockPath, owner) {
  const entries = await readdir(lockPath).catch((error) => fail("OUTPUT_SESSION_METADATA_INVALID", `${lockPath}: ${error.code ?? error.message}`));
  const stages = entries.filter((entry) => outputOwnerStagePattern.test(entry)).sort();
  for (const name of stages) {
    const stagePath = resolve(lockPath, name);
    const match = outputOwnerStagePattern.exec(name);
    const pid = Number(match[1]);
    const processGroup = Number(match[2]);
    if (processGroup <= 0 || pid !== owner.value.pid) fail("OUTPUT_SESSION_METADATA_INVALID", stagePath);
    const before = await pathMetadata(stagePath, "OUTPUT_SESSION_METADATA_INVALID");
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.uid !== owner.value.uid || (before.mode & 0o777) !== 0o600) fail("OUTPUT_SESSION_METADATA_INVALID", stagePath);
    assertDeadProcess(pid, "OUTPUT_SESSION_RECOVERY_OWNER_LIVE", "OUTPUT_SESSION_RECOVERY_OWNER_LIVENESS_UNKNOWN");
    // A pre-publication update records its intended group in the reserved
    // filename.  Do not discard that sole descendant authority until the
    // group is independently dead; otherwise a later recovery would see the
    // old null group and could overlap a surviving controller.
    assertDeadProcessGroup(processGroup, "OUTPUT_SESSION_RECOVERY_DESCENDANT_LIVE", "OUTPUT_SESSION_RECOVERY_DESCENDANT_LIVENESS_UNKNOWN");
    const bound = await readBoundClaim(stagePath, "OUTPUT_SESSION_METADATA_INVALID");
    if (!sameIdentity(before, bound.metadata) || bound.metadata.nlink !== 1) fail("OUTPUT_SESSION_METADATA_INVALID", stagePath);
    const expected = Buffer.from(`${JSON.stringify({ ...owner.value, ownerDev: bound.metadata.dev, ownerIno: bound.metadata.ino, processGroup })}\n`);
    const stageBytes = Buffer.from(bound.bytes);
    if (stageBytes.length > expected.length || !expected.subarray(0, stageBytes.length).equals(stageBytes)) fail("OUTPUT_SESSION_METADATA_INVALID", stagePath);
    if (stageBytes.length === expected.length) await readOutputLockMetadataAt(lockPath, stagePath);
    const beforeRemove = await pathMetadata(stagePath, "OUTPUT_SESSION_METADATA_INVALID");
    if (!sameIdentity(bound.metadata, beforeRemove)) fail("OUTPUT_SESSION_METADATA_INVALID", stagePath);
    await rm(stagePath).catch((error) => fail("OUTPUT_SESSION_METADATA_INVALID", `${stagePath}: ${error.code ?? error.message}`));
    await syncDirectory(lockPath, "OUTPUT_SESSION_METADATA_INVALID");
  }
}

async function clearDeadInitialOwnerPublicationStages(lockPath, lock) {
  const entries = await readdir(lockPath).catch((error) => fail("OUTPUT_SESSION_METADATA_INVALID", `${lockPath}: ${error.code ?? error.message}`));
  const stages = entries.filter((entry) => outputOwnerStagePattern.test(entry)).sort();
  for (const name of stages) {
    const stagePath = resolve(lockPath, name);
    const match = outputOwnerStagePattern.exec(name);
    const pid = Number(match[1]);
    if (match[2] !== "0") fail("OUTPUT_SESSION_METADATA_INVALID", stagePath);
    const before = await pathMetadata(stagePath, "OUTPUT_SESSION_METADATA_INVALID");
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600) fail("OUTPUT_SESSION_METADATA_INVALID", stagePath);
    assertDeadProcess(pid, "OUTPUT_SESSION_RECOVERY_OWNER_LIVE", "OUTPUT_SESSION_RECOVERY_OWNER_LIVENESS_UNKNOWN");
    const bound = await readBoundClaim(stagePath, "OUTPUT_SESSION_METADATA_INVALID");
    if (!sameIdentity(before, bound.metadata) || bound.metadata.nlink !== 1) fail("OUTPUT_SESSION_METADATA_INVALID", stagePath);
    const expected = Buffer.from(`${JSON.stringify(outputLockMetadata(lock, before.uid, bound.metadata, null, pid))}\n`);
    const stageBytes = Buffer.from(bound.bytes);
    if (stageBytes.length > expected.length || !expected.subarray(0, stageBytes.length).equals(stageBytes)) fail("OUTPUT_SESSION_METADATA_INVALID", stagePath);
    if (stageBytes.length === expected.length) await readOutputLockMetadataAt(lockPath, stagePath);
    const beforeRemove = await pathMetadata(stagePath, "OUTPUT_SESSION_METADATA_INVALID");
    if (!sameIdentity(bound.metadata, beforeRemove)) fail("OUTPUT_SESSION_METADATA_INVALID", stagePath);
    await rm(stagePath).catch((error) => fail("OUTPUT_SESSION_METADATA_INVALID", `${stagePath}: ${error.code ?? error.message}`));
    await syncDirectory(lockPath, "OUTPUT_SESSION_METADATA_INVALID");
  }
  return stages.length !== 0;
}

function crashAtOwnerPublication(point) {
  if (process.env.TCRN_TEST_OWNER_PUBLICATION_CRASH_AT === point) process.kill(process.pid, "SIGKILL");
}

async function publishOutputOwnerMetadata(lockPath, expectedOwner, next, reasonCode) {
  const ownerPath = resolve(lockPath, outputLockMetadataName);
  const stagePath = resolve(lockPath, `${outputOwnerStagePrefix}${process.pid}-${next.processGroup}-${temporarySequence += 1}`);
  let handle;
  let published = false;
  try {
    handle = await open(stagePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const stageIdentity = await handle.stat();
    if (stageIdentity.isSymbolicLink() || !stageIdentity.isFile() || stageIdentity.nlink !== 1 || stageIdentity.uid !== process.getuid?.() || (stageIdentity.mode & 0o777) !== 0o600) {
      fail(reasonCode, stagePath);
    }
    const bytes = `${JSON.stringify({ ...next, ownerDev: stageIdentity.dev, ownerIno: stageIdentity.ino })}\n`;
    crashAtOwnerPublication("group-stage-open");
    if (process.env.TCRN_TEST_OWNER_PUBLICATION_CRASH_AT === "group-stage-partial") {
      await handle.writeFile(bytes.slice(0, 7));
      process.kill(process.pid, "SIGKILL");
    }
    await handle.writeFile(bytes);
    await handle.sync();
    crashAtOwnerPublication("group-stage-fsynced");
    await handle.close();
    handle = undefined;
    const staged = await readOutputLockMetadataAt(lockPath, stagePath);
    if (!sameIdentity(staged.identity, stageIdentity) || staged.bytes !== bytes) fail(reasonCode, stagePath);
    const current = await readOutputLockMetadata(lockPath);
    if (!sameIdentity(current.identity, expectedOwner.identity) || current.bytes !== expectedOwner.bytes) fail("OUTPUT_SESSION_RELEASE_REPLACED", ownerPath);
    crashAtOwnerPublication("prepublication");
    await rename(stagePath, ownerPath).catch((error) => fail(reasonCode, `${ownerPath}: ${error.code ?? error.message}`));
    published = true;
    await syncDirectory(lockPath, reasonCode);
    crashAtOwnerPublication("afterpublication");
    const sealed = await readOutputLockMetadata(lockPath);
    if (!sameIdentity(sealed.identity, stageIdentity) || sealed.bytes !== bytes) fail("OUTPUT_SESSION_RELEASE_REPLACED", ownerPath);
    return sealed;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!published) {
      await rm(stagePath).catch((error) => {
        if (error.code !== "ENOENT") fail(reasonCode, `${stagePath}: ${error.code ?? error.message}`);
      });
    }
  }
}

async function publishInitialOutputOwnerMetadata(lockPath, lock, ownerUid) {
  const ownerPath = resolve(lockPath, outputLockMetadataName);
  const stagePath = resolve(lockPath, `${outputOwnerStagePrefix}${process.pid}-0-${temporarySequence += 1}`);
  let handle;
  let published = false;
  try {
    handle = await open(stagePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const stageIdentity = await handle.stat();
    if (stageIdentity.isSymbolicLink() || !stageIdentity.isFile() || stageIdentity.nlink !== 1 || stageIdentity.uid !== ownerUid || (stageIdentity.mode & 0o777) !== 0o600) {
      fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", stagePath);
    }
    const bytes = `${JSON.stringify(outputLockMetadata(lock, ownerUid, stageIdentity))}\n`;
    crashAtOwnerPublication("initial-stage-open");
    if (process.env.TCRN_TEST_OWNER_PUBLICATION_CRASH_AT === "initial-stage-partial") {
      await handle.writeFile(bytes.slice(0, 7));
      process.kill(process.pid, "SIGKILL");
    }
    await handle.writeFile(bytes);
    await handle.sync();
    crashAtOwnerPublication("initial-stage-fsynced");
    await handle.close();
    handle = undefined;
    const staged = await readOutputLockMetadataAt(lockPath, stagePath);
    if (!sameIdentity(staged.identity, stageIdentity) || staged.bytes !== bytes) fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", stagePath);
    const ownerExists = await lstat(ownerPath).then(() => true).catch((error) => {
      if (error.code === "ENOENT") return false;
      fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", `${ownerPath}: ${error.code ?? error.message}`);
    });
    if (ownerExists) fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", ownerPath);
    crashAtOwnerPublication("initial-prepublication");
    await rename(stagePath, ownerPath).catch((error) => fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", `${ownerPath}: ${error.code ?? error.message}`));
    published = true;
    await syncDirectory(lockPath, "OUTPUT_SESSION_METADATA_CREATE_FAILED");
    crashAtOwnerPublication("initial-afterpublication");
    const sealed = await readOutputLockMetadata(lockPath);
    if (!sameIdentity(sealed.identity, stageIdentity) || sealed.bytes !== bytes) fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", ownerPath);
    return sealed;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!published) {
      await rm(stagePath).catch((error) => {
        if (error.code !== "ENOENT") fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", `${stagePath}: ${error.code ?? error.message}`);
      });
    }
  }
}

async function removeUninitializedOutputSessionLock(lockPath, expectedIdentity) {
  const before = await pathMetadata(lockPath, "OUTPUT_SESSION_METADATA_CREATE_FAILED");
  assertOutputLockIdentity(before, expectedIdentity, "OUTPUT_SESSION_METADATA_CREATE_FAILED", lockPath);
  const names = await readdir(lockPath).catch((error) => fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", `${lockPath}: ${error.code ?? error.message}`));
  if (names.length !== 0) fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", `${lockPath} is no longer empty`);
  const after = await pathMetadata(lockPath, "OUTPUT_SESSION_METADATA_CREATE_FAILED");
  if (!sameIdentity(before, after)) fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", `${lockPath} changed during metadata cleanup`);
  await rmdir(lockPath).catch((error) => fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", `${lockPath}: ${error.code ?? error.message}`));
  await syncDirectory(dirname(lockPath), "OUTPUT_SESSION_METADATA_CREATE_FAILED");
}

async function removeOwnedOutputSessionMetadata(lockPath, expectedLockIdentity, ownerIdentity) {
  const before = await pathMetadata(lockPath, "OUTPUT_SESSION_METADATA_CREATE_FAILED");
  assertOutputLockIdentity(before, expectedLockIdentity, "OUTPUT_SESSION_METADATA_CREATE_FAILED", lockPath);
  const ownerPath = resolve(lockPath, outputLockMetadataName);
  const owner = await pathMetadata(ownerPath, "OUTPUT_SESSION_METADATA_CREATE_FAILED");
  if (!sameIdentity(owner, ownerIdentity) || owner.isSymbolicLink() || !owner.isFile() || owner.nlink !== 1 ||
      owner.uid !== process.getuid?.() || (owner.mode & 0o777) !== 0o600) {
    fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", `${ownerPath} changed during metadata cleanup`);
  }
  await rm(ownerPath).catch((error) => fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", `${lockPath}: ${error.code ?? error.message}`));
  await removeUninitializedOutputSessionLock(lockPath, expectedLockIdentity);
}

function recoveryClaimBytes(repositoryPath, lockPath, lock, receipt, owner, stagingName, stagingIdentity, pid = process.pid) {
  return `${JSON.stringify({
    schemaVersion: "tcrn.output-session-recovery-claim.v1",
    pid,
    uid: process.getuid?.(),
    repositoryPath,
    lockPath,
    stagingName,
    claimDev: stagingIdentity.dev,
    claimIno: stagingIdentity.ino,
    lockDev: lock.dev,
    lockIno: lock.ino,
    lockCtimeMs: receipt.lockCtimeMs,
    lockMtimeMs: receipt.lockMtimeMs,
    ownerDev: owner?.identity.dev ?? null,
    ownerIno: owner?.identity.ino ?? null,
    ownerBytes: owner?.bytes ?? null,
  })}\n`;
}

async function clearDeadRecoveryClaimWithoutLock(claimPath, repositoryPath, expectedLockPath) {
  // This cleanup is only for a fixed claim left *after* the lock itself was
  // durably removed.  A normal release publishes the same claim before it
  // unlinks owner.json, so deleting it while the lock still exists would
  // strand an ownerless lock on a crash between unlink and rmdir.
  const lock = await lstat(expectedLockPath).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    fail("OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED", `${expectedLockPath}: ${error.code ?? error.message}`);
  });
  if (lock) return undefined;
  const claim = await readRecoveryClaim(claimPath, expectedLockPath, "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", { expectedNlink: 1, allowMissing: true, repositoryPath });
  if (!claim) return;
  if (claim.value.pid === process.pid && claim.locallyPublished) {
    fail("OUTPUT_SESSION_RECOVERY_CONCURRENT", claimPath);
  }
  assertDeadProcess(claim.value.pid, "OUTPUT_SESSION_RECOVERY_CLAIM_LIVE", "OUTPUT_SESSION_RECOVERY_CLAIM_LIVENESS_UNKNOWN");
  await validateRecoveryClaim(claimPath, claim.metadata, claim.bytes, "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
  const lockBeforeRemove = await lstat(expectedLockPath).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    fail("OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED", `${expectedLockPath}: ${error.code ?? error.message}`);
  });
  if (lockBeforeRemove) return undefined;
  await rm(claimPath).catch((error) => fail("OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED", `${claimPath}: ${error.code ?? error.message}`));
  await syncDirectory(dirname(claimPath), "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
  const after = await lstat(claimPath).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    fail("OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED", `${claimPath}: ${error.code ?? error.message}`);
  });
  if (after) fail("OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED", claimPath);
  return { reasonCode: "OUTPUT_SESSION_RECOVERY_RESIDUE_CLEARED" };
}

async function validateRecoveryClaim(path, expectedIdentity, expectedBytes, reasonCode, expectedNlink = 1) {
  const { metadata: claim, bytes } = await readBoundClaim(path, reasonCode);
  if (!sameIdentity(claim, expectedIdentity) || claim.isSymbolicLink() || !claim.isFile() || claim.nlink !== expectedNlink ||
      claim.uid !== process.getuid?.() || (claim.mode & 0o777) !== 0o600) fail(reasonCode, path);
  if (bytes !== expectedBytes) fail(reasonCode, path);
  return claim;
}

export async function readBoundClaim(path, reasonCode) {
  const before = await pathMetadata(path, reasonCode);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink < 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.size > maximumRecoveryClaimBytes) {
    fail(reasonCode, path);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!sameIdentity(before, opened) || opened.isSymbolicLink() || !opened.isFile() || opened.nlink !== before.nlink ||
        opened.uid !== before.uid || (opened.mode & 0o777) !== 0o600 || opened.size !== before.size ||
        opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs || opened.size > maximumRecoveryClaimBytes) {
      fail(reasonCode, path);
    }
    const chunks = [];
    let totalBytesRead = 0;
    while (true) {
      const remaining = maximumRecoveryClaimBytes + 1 - totalBytesRead;
      const buffer = Buffer.allocUnsafe(Math.min(16_384, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytesRead += bytesRead;
      if (totalBytesRead > maximumRecoveryClaimBytes) fail(reasonCode, path);
    }
    const settled = await handle.stat();
    if (!sameIdentity(opened, settled) || settled.nlink !== opened.nlink || settled.uid !== opened.uid ||
        (settled.mode & 0o777) !== 0o600 || settled.size !== opened.size || settled.mtimeMs !== opened.mtimeMs || settled.ctimeMs !== opened.ctimeMs) {
      fail(reasonCode, path);
    }
    const after = await pathMetadata(path, reasonCode);
    if (!sameIdentity(opened, after) || after.nlink !== opened.nlink || after.uid !== opened.uid ||
        (after.mode & 0o777) !== 0o600 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail(reasonCode, path);
    return { metadata: opened, bytes: Buffer.concat(chunks, totalBytesRead).toString("utf8") };
  } finally { if (handle) await handle.close(); }
}

function assertDeadProcess(pid, liveReason, unknownReason) {
  try {
    process.kill(pid, 0);
    fail(liveReason, String(pid));
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    if (error.code === "ESRCH") return;
    fail(unknownReason, String(pid));
  }
}

function assertDeadProcessGroup(processGroup, liveReason, unknownReason) {
  if (processGroup === null) return;
  try {
    process.kill(-processGroup, 0);
    fail(liveReason, String(processGroup));
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    if (error.code === "ESRCH") return;
    fail(unknownReason, String(processGroup));
  }
}

function parseRecoveryClaim(bytes, metadata, expectedLockPath, reasonCode, { expectedNlink, lock, lockTimesMayDiffer = false, owner, repositoryPath = dirname(dirname(expectedLockPath)) } = {}) {
  let value;
  try { value = JSON.parse(bytes); } catch { fail(reasonCode, expectedLockPath); }
  const stageMatch = recoveryStagePattern.exec(value?.stagingName);
  if (bytes !== `${JSON.stringify(value)}\n` || JSON.stringify(Object.keys(value)) !== JSON.stringify(recoveryClaimFields) ||
      value?.schemaVersion !== "tcrn.output-session-recovery-claim.v1" || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      !Number.isSafeInteger(value.uid) || value.uid !== process.getuid?.() || value.uid !== metadata.uid || value.repositoryPath !== repositoryPath || value.lockPath !== expectedLockPath ||
      !stageMatch || Number(stageMatch[1]) !== value.pid || !Number.isSafeInteger(Number(stageMatch[2])) || Number(stageMatch[2]) <= 0 ||
      value.claimDev !== metadata.dev || value.claimIno !== metadata.ino || !Number.isSafeInteger(value.lockDev) || !Number.isSafeInteger(value.lockIno) ||
      !Number.isFinite(value.lockCtimeMs) || !Number.isFinite(value.lockMtimeMs) || !Number.isSafeInteger(value.ownerDev) ||
      !Number.isSafeInteger(value.ownerIno) || typeof value.ownerBytes !== "string" ||
      (expectedNlink !== undefined && metadata.nlink !== expectedNlink)) {
    fail(reasonCode, expectedLockPath);
  }
  if (lock && (value.lockDev !== lock.dev || value.lockIno !== lock.ino ||
      (!lockTimesMayDiffer && (value.lockCtimeMs !== lock.ctimeMs || value.lockMtimeMs !== lock.mtimeMs)))) {
    fail("OUTPUT_SESSION_RECOVERY_TARGET_REPLACED", expectedLockPath);
  }
  if (owner && (value.ownerDev !== owner.identity.dev || value.ownerIno !== owner.identity.ino || value.ownerBytes !== owner.bytes)) {
    fail("OUTPUT_SESSION_RECOVERY_TARGET_REPLACED", expectedLockPath);
  }
  return value;
}

async function readRecoveryClaim(path, expectedLockPath, reasonCode, { expectedNlink, allowMissing = false, lock, lockTimesMayDiffer, owner, repositoryPath } = {}) {
  const locallyPublishing = (locallyPublishingRecoveryClaims.get(path) ?? 0) > 0;
  const exists = await lstat(path).catch((error) => {
    if (allowMissing && error.code === "ENOENT") return undefined;
    fail(reasonCode, `${path}: ${error.code ?? error.message}`);
  });
  if (!exists) return undefined;
  const { metadata, bytes } = await readBoundClaim(path, reasonCode);
  const value = parseRecoveryClaim(bytes, metadata, expectedLockPath, reasonCode, { expectedNlink, lock, lockTimesMayDiffer, owner, repositoryPath });
  return { metadata, bytes, value, locallyPublished: isLocallyPublishedRecoveryClaim(path, metadata) || (locallyPublishing && metadata.nlink === 2) };
}

function acquisitionClaimBytes(repositoryPath, lockPath, identity, pid = process.pid) {
  return `${JSON.stringify({
    schemaVersion: "tcrn.output-session-acquisition-claim.v1",
    pid,
    uid: process.getuid?.(),
    repositoryPath,
    lockPath,
    claimDev: identity.dev,
    claimIno: identity.ino,
  })}\n`;
}

function crashAtAcquisitionPublication(point) {
  if (process.env.TCRN_TEST_OUTPUT_SESSION_ACQUISITION_PUBLICATION_CRASH_AT === point) process.kill(process.pid, "SIGKILL");
}

async function readAcquisitionClaim(path, repositoryPath, lockPath, reasonCode, { allowMissing = false, expectedNlink = 1 } = {}) {
  const present = await lstat(path).catch((error) => {
    if (allowMissing && error.code === "ENOENT") return undefined;
    fail(reasonCode, `${path}: ${error.code ?? error.message}`);
  });
  if (!present) return undefined;
  const { metadata, bytes } = await readBoundClaim(path, reasonCode);
  let value;
  try { value = JSON.parse(bytes); } catch { fail(reasonCode, path); }
  if (metadata.nlink !== expectedNlink || bytes !== `${JSON.stringify(value)}\n` || JSON.stringify(Object.keys(value)) !== JSON.stringify(acquisitionClaimFields) ||
      value?.schemaVersion !== "tcrn.output-session-acquisition-claim.v1" || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      value.uid !== process.getuid?.() || value.uid !== metadata.uid || value.repositoryPath !== repositoryPath || value.lockPath !== lockPath ||
      value.claimDev !== metadata.dev || value.claimIno !== metadata.ino) fail(reasonCode, path);
  return { metadata, bytes, value };
}

async function publishAcquisitionClaim(gitDirectory, repositoryPath, lockPath) {
  const claimPath = resolve(gitDirectory, outputAcquisitionClaimName);
  const stagePath = resolve(gitDirectory, `${outputAcquisitionStagePrefix}${process.pid}-${temporarySequence += 1}`);
  let handle;
  let identity;
  let bytes;
  let stageRemoved = false;
  try {
    handle = await open(stagePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    identity = await handle.stat();
    if (identity.isSymbolicLink() || !identity.isFile() || identity.nlink !== 1 || identity.uid !== process.getuid?.() || (identity.mode & 0o777) !== 0o600) fail("OUTPUT_SESSION_ACQUISITION_INVALID", stagePath);
    bytes = acquisitionClaimBytes(repositoryPath, lockPath, identity);
    crashAtAcquisitionPublication("stage-open");
    if (process.env.TCRN_TEST_OUTPUT_SESSION_ACQUISITION_PUBLICATION_CRASH_AT === "stage-partial") {
      await handle.writeFile(bytes.slice(0, Math.max(1, Math.floor(bytes.length / 2))));
      process.kill(process.pid, "SIGKILL");
    }
    await handle.writeFile(bytes);
    await handle.sync();
    crashAtAcquisitionPublication("stage-fsynced");
    await handle.close(); handle = undefined;
    const staged = await readAcquisitionClaim(stagePath, repositoryPath, lockPath, "OUTPUT_SESSION_ACQUISITION_INVALID");
    if (!sameIdentity(staged.metadata, identity) || staged.bytes !== bytes) fail("OUTPUT_SESSION_ACQUISITION_INVALID", stagePath);
    crashAtAcquisitionPublication("before-link");
    try { await link(stagePath, claimPath); }
    catch (error) {
      if (error.code === "EEXIST") {
        const loser = await readAcquisitionClaim(stagePath, repositoryPath, lockPath, "OUTPUT_SESSION_ACQUISITION_CHANGED");
        if (!sameIdentity(loser.metadata, identity) || loser.bytes !== bytes) fail("OUTPUT_SESSION_ACQUISITION_CHANGED", stagePath);
        await rm(stagePath).catch((cleanupError) => fail("OUTPUT_SESSION_ACQUISITION_CHANGED", `${stagePath}: ${cleanupError.code ?? cleanupError.message}`));
        stageRemoved = true;
        await syncDirectory(gitDirectory, "OUTPUT_SESSION_ACQUISITION_CHANGED");
        fail("OUTPUT_SESSION_ACQUISITION_CONCURRENT", claimPath);
      }
      fail("OUTPUT_SESSION_ACQUISITION_INVALID", `${claimPath}: ${error.code ?? error.message}`);
    }
    await syncDirectory(gitDirectory, "OUTPUT_SESSION_ACQUISITION_INVALID");
    crashAtAcquisitionPublication("nlink2");
    const linked = await readAcquisitionClaim(claimPath, repositoryPath, lockPath, "OUTPUT_SESSION_ACQUISITION_INVALID", { expectedNlink: 2 });
    if (!sameIdentity(linked.metadata, identity) || linked.metadata.nlink !== 2 || linked.bytes !== bytes) fail("OUTPUT_SESSION_ACQUISITION_INVALID", claimPath);
    const linkedStage = await readAcquisitionClaim(stagePath, repositoryPath, lockPath, "OUTPUT_SESSION_ACQUISITION_INVALID", { expectedNlink: 2 });
    if (!sameIdentity(linkedStage.metadata, identity) || linkedStage.metadata.nlink !== 2 || linkedStage.bytes !== bytes) fail("OUTPUT_SESSION_ACQUISITION_INVALID", stagePath);
    await rm(stagePath).catch((error) => fail("OUTPUT_SESSION_ACQUISITION_CHANGED", `${stagePath}: ${error.code ?? error.message}`));
    stageRemoved = true;
    crashAtAcquisitionPublication("stage-unlinked");
    await syncDirectory(gitDirectory, "OUTPUT_SESSION_ACQUISITION_CHANGED");
    const claim = await readAcquisitionClaim(claimPath, repositoryPath, lockPath, "OUTPUT_SESSION_ACQUISITION_INVALID");
    if (!sameIdentity(claim.metadata, identity) || claim.metadata.nlink !== 1 || claim.bytes !== bytes) fail("OUTPUT_SESSION_ACQUISITION_INVALID", claimPath);
    crashAtAcquisitionPublication("fixed-nlink1");
    return { path: claimPath, ...claim };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!stageRemoved && identity && bytes) {
      const stage = await readAcquisitionClaim(stagePath, repositoryPath, lockPath, "OUTPUT_SESSION_ACQUISITION_CHANGED", { allowMissing: true });
      if (stage) {
        if (!sameIdentity(stage.metadata, identity) || stage.bytes !== bytes) fail("OUTPUT_SESSION_ACQUISITION_CHANGED", stagePath);
        await rm(stagePath).catch((error) => fail("OUTPUT_SESSION_ACQUISITION_CHANGED", `${stagePath}: ${error.code ?? error.message}`));
        await syncDirectory(gitDirectory, "OUTPUT_SESSION_ACQUISITION_CHANGED");
      }
    }
  }
}

async function removeAcquisitionClaim(claim, repositoryPath, lockPath) {
  const current = await readAcquisitionClaim(claim.path, repositoryPath, lockPath, "OUTPUT_SESSION_ACQUISITION_CHANGED");
  if (!sameIdentity(current.metadata, claim.metadata) || current.bytes !== claim.bytes) fail("OUTPUT_SESSION_ACQUISITION_CHANGED", claim.path);
  await rm(claim.path).catch((error) => fail("OUTPUT_SESSION_ACQUISITION_CHANGED", `${claim.path}: ${error.code ?? error.message}`));
  await syncDirectory(dirname(claim.path), "OUTPUT_SESSION_ACQUISITION_CHANGED");
}

async function clearDeadAcquisitionClaimStages(gitDirectory, repositoryPath, lockPath) {
  const fixedPath = resolve(gitDirectory, outputAcquisitionClaimName);
  const entries = await readdir(gitDirectory).catch((error) => fail("OUTPUT_SESSION_ACQUISITION_INVALID", `${gitDirectory}: ${error.code ?? error.message}`));
  for (const name of entries.filter((entry) => entry.startsWith(outputAcquisitionStagePrefix)).sort()) {
    const match = outputAcquisitionStagePattern.exec(name);
    const stagePath = resolve(gitDirectory, name);
    if (!match) fail("OUTPUT_SESSION_ACQUISITION_INVALID", stagePath);
    const pid = Number(match[1]);
    const stage = await pathMetadata(stagePath, "OUTPUT_SESSION_ACQUISITION_INVALID");
    if (stage.isSymbolicLink() || !stage.isFile() || stage.uid !== process.getuid?.() || (stage.mode & 0o777) !== 0o600) fail("OUTPUT_SESSION_ACQUISITION_INVALID", stagePath);
    assertDeadProcess(pid, "OUTPUT_SESSION_ACQUISITION_LIVE", "OUTPUT_SESSION_ACQUISITION_LIVENESS_UNKNOWN");
    const fixed = await lstat(fixedPath).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      fail("OUTPUT_SESSION_ACQUISITION_INVALID", `${fixedPath}: ${error.code ?? error.message}`);
    });
    const bound = await readBoundClaim(stagePath, "OUTPUT_SESSION_ACQUISITION_INVALID");
    if (!sameIdentity(bound.metadata, stage)) fail("OUTPUT_SESSION_ACQUISITION_CHANGED", stagePath);
    const expectedBytes = acquisitionClaimBytes(repositoryPath, lockPath, stage, pid);
    const exactOrPrefix = bound.bytes.length < expectedBytes.length ? expectedBytes.startsWith(bound.bytes) : bound.bytes === expectedBytes;
    if (!exactOrPrefix) fail("OUTPUT_SESSION_ACQUISITION_INVALID", stagePath);
    if (fixed) {
      let fixedClaim;
      let expectedStageNlink;
      if (sameIdentity(fixed, stage)) {
        fixedClaim = await readAcquisitionClaim(fixedPath, repositoryPath, lockPath, "OUTPUT_SESSION_ACQUISITION_INVALID", { expectedNlink: 2 });
        if (fixedClaim.bytes !== bound.bytes || fixedClaim.value.pid !== pid || bound.metadata.nlink !== 2) fail("OUTPUT_SESSION_ACQUISITION_INVALID", stagePath);
        expectedStageNlink = 2;
      } else {
        if (fixed.nlink !== 1 || stage.nlink !== 1) fail("OUTPUT_SESSION_ACQUISITION_INVALID", stagePath);
        fixedClaim = await readAcquisitionClaim(fixedPath, repositoryPath, lockPath, "OUTPUT_SESSION_ACQUISITION_INVALID");
        expectedStageNlink = 1;
      }
      const stageBeforeUnlink = await readBoundClaim(stagePath, "OUTPUT_SESSION_ACQUISITION_CHANGED");
      const fixedBeforeUnlink = await readAcquisitionClaim(fixedPath, repositoryPath, lockPath, "OUTPUT_SESSION_ACQUISITION_CHANGED", { expectedNlink: fixedClaim.metadata.nlink });
      if (!sameIdentity(stageBeforeUnlink.metadata, stage) || stageBeforeUnlink.metadata.nlink !== expectedStageNlink || stageBeforeUnlink.bytes !== bound.bytes ||
          !sameIdentity(fixedBeforeUnlink.metadata, fixedClaim.metadata) || fixedBeforeUnlink.bytes !== fixedClaim.bytes) {
        fail("OUTPUT_SESSION_ACQUISITION_CHANGED", stagePath);
      }
      await rm(stagePath).catch((error) => fail("OUTPUT_SESSION_ACQUISITION_CHANGED", `${stagePath}: ${error.code ?? error.message}`));
      await syncDirectory(gitDirectory, "OUTPUT_SESSION_ACQUISITION_CHANGED");
      const fixedAfterUnlink = await readAcquisitionClaim(fixedPath, repositoryPath, lockPath, "OUTPUT_SESSION_ACQUISITION_CHANGED");
      if (!sameIdentity(fixedAfterUnlink.metadata, fixedClaim.metadata) || fixedAfterUnlink.bytes !== fixedClaim.bytes) fail("OUTPUT_SESSION_ACQUISITION_CHANGED", fixedPath);
      continue;
    }
    if (bound.bytes.length === expectedBytes.length) {
      const parsed = await readAcquisitionClaim(stagePath, repositoryPath, lockPath, "OUTPUT_SESSION_ACQUISITION_INVALID");
      if (parsed.value.pid !== pid || parsed.metadata.nlink !== 1) fail("OUTPUT_SESSION_ACQUISITION_INVALID", stagePath);
    }
    const beforeRemove = await pathMetadata(stagePath, "OUTPUT_SESSION_ACQUISITION_CHANGED");
    if (!sameIdentity(beforeRemove, stage) || beforeRemove.nlink !== 1) fail("OUTPUT_SESSION_ACQUISITION_CHANGED", stagePath);
    await rm(stagePath).catch((error) => fail("OUTPUT_SESSION_ACQUISITION_CHANGED", `${stagePath}: ${error.code ?? error.message}`));
    await syncDirectory(gitDirectory, "OUTPUT_SESSION_ACQUISITION_CHANGED");
  }
}

async function syncDirectory(path, reasonCode) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY); await handle.sync(); }
  catch (error) { fail(reasonCode, `${path}: ${error.code ?? error.message}`); }
  finally { if (handle) await handle.close(); }
}

async function removeRecoveryClaim(claimPath, claimIdentity, expectedBytes) {
  await validateRecoveryClaim(claimPath, claimIdentity, expectedBytes, "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
  await rm(claimPath).catch((error) => fail("OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED", `${claimPath}: ${error.code ?? error.message}`));
  await syncDirectory(dirname(claimPath), "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
}

async function assertRecoveryClean(gitDirectory, lockPath, claimPath, reasonCode) {
  for (const path of [lockPath, claimPath, resolve(gitDirectory, outputAcquisitionClaimName)]) {
    const present = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      fail(reasonCode, `${path}: ${error.code ?? error.message}`);
    });
    if (present) fail(reasonCode, path);
  }
  const entries = await readdir(gitDirectory).catch((error) => fail(reasonCode, `${gitDirectory}: ${error.code ?? error.message}`));
  if (entries.some((name) => name.startsWith(".tcrn-workflow-output-recovery-claim.staging-") || name.startsWith(outputAcquisitionStagePrefix))) fail(reasonCode, gitDirectory);
}

async function findRecoveryObjects(gitDirectory, claimPath, reasonCode) {
  const fixed = await lstat(claimPath).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    fail(reasonCode, `${claimPath}: ${error.code ?? error.message}`);
  });
  const entries = await readdir(gitDirectory).catch((error) => fail(reasonCode, `${gitDirectory}: ${error.code ?? error.message}`));
  const stages = entries.filter((name) => name.startsWith(".tcrn-workflow-output-recovery-claim.staging-"));
  return { fixed, stages };
}

async function expectedRecoveryClaimStageBytes(gitDirectory, stagePath, stage) {
  const stageMatch = recoveryStagePattern.exec(basename(stagePath));
  if (!stageMatch) fail("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", stagePath);
  const lockPath = resolve(gitDirectory, outputLockName);
  const lock = await lstat(lockPath).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    fail("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", `${lockPath}: ${error.code ?? error.message}`);
  });
  if (!lock || lock.isSymbolicLink() || !lock.isDirectory() || lock.uid !== process.getuid?.() || (lock.mode & 0o777) !== 0o700) return undefined;
  const ownerPath = resolve(lockPath, outputLockMetadataName);
  const ownerPresent = await lstat(ownerPath).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    fail("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", `${ownerPath}: ${error.code ?? error.message}`);
  });
  if (!ownerPresent) return undefined;
  const owner = await readOutputLockMetadata(lockPath);
  if (owner.value.lockDev !== lock.dev || owner.value.lockIno !== lock.ino) fail("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", lockPath);
  return recoveryClaimBytes(
    dirname(gitDirectory),
    lockPath,
    lock,
    { lockCtimeMs: lock.ctimeMs, lockMtimeMs: lock.mtimeMs },
    owner,
    basename(stagePath),
    stage,
    Number(stageMatch[1]),
  );
}

async function isExactPrepublicationRecoveryClaimPrefix(gitDirectory, stagePath, stage, bytes) {
  const expected = await expectedRecoveryClaimStageBytes(gitDirectory, stagePath, stage);
  // A stage can outlive the lock only after the fixed claim transaction has
  // progressed.  Its full basis is then no longer derivable, but the reserved
  // dead prepublication object is still recognizable by the canonical prefix.
  // Never accept a complete record or arbitrary short bytes in that case.
  if (expected === undefined) {
    return bytes.length < recoveryClaimCanonicalPrefix.length && recoveryClaimCanonicalPrefix.startsWith(bytes);
  }
  return bytes.length < expected.length && expected.startsWith(bytes);
}

async function clearDeadStageOnlyOrphans(gitDirectory, claimPath) {
  const entries = await readdir(gitDirectory).catch((error) => fail("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", `${gitDirectory}: ${error.code ?? error.message}`));
  for (const name of entries) {
    if (!name.startsWith(".tcrn-workflow-output-recovery-claim.staging-")) continue;
    const match = recoveryStagePattern.exec(name);
    if (!match) fail("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", resolve(gitDirectory, name));
    const stagePath = resolve(gitDirectory, name);
    const stage = await lstat(stagePath).catch((error) => fail("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", `${stagePath}: ${error.code ?? error.message}`));
    if (stage.isSymbolicLink() || !stage.isFile() || stage.uid !== process.getuid?.() || (stage.mode & 0o777) !== 0o600) fail("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", stagePath);
    const fixed = await lstat(claimPath).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      fail("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", `${claimPath}: ${error.code ?? error.message}`);
    });
    if (fixed) {
      if (stage.nlink !== 2 || fixed.nlink !== 2 || !sameIdentity(stage, fixed)) fail("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", stagePath);
      continue;
    }
    if (stage.nlink !== 1) fail("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", stagePath);
    if (Number(match[1]) === process.pid && (locallyPublishingRecoveryClaims.get(claimPath) ?? 0) > 0) {
      fail("OUTPUT_SESSION_RECOVERY_CONCURRENT", stagePath);
    }
    assertDeadProcess(Number(match[1]), "OUTPUT_SESSION_RECOVERY_CLAIM_LIVE", "OUTPUT_SESSION_RECOVERY_CLAIM_LIVENESS_UNKNOWN");
    const bound = await readBoundClaim(stagePath, "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID");
    if (!sameIdentity(bound.metadata, stage) || bound.metadata.nlink !== 1) fail("OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED", stagePath);
    if (!(await isExactPrepublicationRecoveryClaimPrefix(gitDirectory, stagePath, stage, bound.bytes))) {
      parseRecoveryClaim(bound.bytes, bound.metadata, resolve(gitDirectory, outputLockName), "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", {
        expectedNlink: 1,
        repositoryPath: dirname(gitDirectory),
      });
    }
    const beforeRemove = await pathMetadata(stagePath, "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
    if (!sameIdentity(bound.metadata, beforeRemove) || beforeRemove.isSymbolicLink() || !beforeRemove.isFile() ||
        beforeRemove.nlink !== 1 || beforeRemove.uid !== process.getuid?.() || (beforeRemove.mode & 0o777) !== 0o600) {
      fail("OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED", stagePath);
    }
    await rm(stagePath).catch((error) => fail("OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED", `${stagePath}: ${error.code ?? error.message}`));
    await syncDirectory(gitDirectory, "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
  }
}

async function resumeRecoveryClaim(claimPath, repositoryPath, lockPath, lock, owner) {
  const claim = await readRecoveryClaim(claimPath, lockPath, "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", { allowMissing: true, lock, owner, repositoryPath });
  if (!claim) return undefined;
  if (![1, 2].includes(claim.metadata.nlink)) fail("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", claimPath);
  if (claim.value.pid === process.pid && claim.locallyPublished) fail("OUTPUT_SESSION_RECOVERY_CONCURRENT", claimPath);
  assertDeadProcess(claim.value.pid, "OUTPUT_SESSION_RECOVERY_CLAIM_LIVE", "OUTPUT_SESSION_RECOVERY_CLAIM_LIVENESS_UNKNOWN");
  if (claim.metadata.nlink === 2) {
    const stagingPath = resolve(dirname(claimPath), claim.value.stagingName);
    if (basename(stagingPath) !== claim.value.stagingName) fail("OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", stagingPath);
    await validateRecoveryClaim(stagingPath, claim.metadata, claim.bytes, "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", 2);
    await validateRecoveryClaim(claimPath, claim.metadata, claim.bytes, "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED", 2);
    await rm(stagingPath).catch((error) => fail("OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED", `${stagingPath}: ${error.code ?? error.message}`));
    await syncDirectory(dirname(claimPath), "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
    claim.metadata = await validateRecoveryClaim(claimPath, claim.metadata, claim.bytes, "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
  }
  return claim;
}

async function acquireRecoveryClaim(claimPath, repositoryPath, lockPath, lock, receipt, owner) {
  let stagingIdentity;
  let claimIdentity;
  let expectedBytes;
  let handle;
  let publishing = false;
  try {
    await clearDeadStageOnlyOrphans(dirname(claimPath), claimPath);
    const resumed = await resumeRecoveryClaim(claimPath, repositoryPath, lockPath, lock, owner);
    if (resumed) return { identity: resumed.metadata, bytes: resumed.bytes };
    const stagingName = `${basename(claimPath)}.staging-${process.pid}-${temporarySequence += 1}`;
    const stagingPath = resolve(dirname(claimPath), stagingName);
    locallyPublishingRecoveryClaims.set(claimPath, (locallyPublishingRecoveryClaims.get(claimPath) ?? 0) + 1);
    publishing = true;
    handle = await open(stagingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    stagingIdentity = await handle.stat();
    if (stagingIdentity.isSymbolicLink() || !stagingIdentity.isFile() || stagingIdentity.nlink !== 1 ||
        stagingIdentity.uid !== process.getuid?.() || (stagingIdentity.mode & 0o777) !== 0o600) fail("OUTPUT_SESSION_RECOVERY_CONCURRENT", stagingPath);
    expectedBytes = recoveryClaimBytes(repositoryPath, lockPath, lock, receipt, owner, stagingName, stagingIdentity);
    await handle.writeFile(expectedBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await validateRecoveryClaim(stagingPath, stagingIdentity, expectedBytes, "OUTPUT_SESSION_RECOVERY_CONCURRENT");
    try { await link(stagingPath, claimPath); } catch (error) {
      if (error.code === "EEXIST") {
        await validateRecoveryClaim(stagingPath, stagingIdentity, expectedBytes, "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
        await rm(stagingPath).catch((cleanupError) => fail("OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED", `${stagingPath}: ${cleanupError.code ?? cleanupError.message}`));
        await syncDirectory(dirname(claimPath), "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
        fail("OUTPUT_SESSION_RECOVERY_CONCURRENT", claimPath);
      }
      throw error;
    }
    await syncDirectory(dirname(claimPath), "OUTPUT_SESSION_RECOVERY_CONCURRENT");
    claimIdentity = await validateRecoveryClaim(claimPath, stagingIdentity, expectedBytes, "OUTPUT_SESSION_RECOVERY_CONCURRENT", 2);
    if (claimIdentity.nlink !== 2) fail("OUTPUT_SESSION_RECOVERY_CONCURRENT", claimPath);
    locallyPublishedRecoveryClaims.set(claimPath, claimIdentity);
    const stagingAfterLink = await validateRecoveryClaim(stagingPath, stagingIdentity, expectedBytes, "OUTPUT_SESSION_RECOVERY_CONCURRENT", 2);
    if (stagingAfterLink.nlink !== 2) fail("OUTPUT_SESSION_RECOVERY_CONCURRENT", stagingPath);
    await rm(stagingPath).catch((error) => fail("OUTPUT_SESSION_RECOVERY_CONCURRENT", `${stagingPath}: ${error.code ?? error.message}`));
    await syncDirectory(dirname(claimPath), "OUTPUT_SESSION_RECOVERY_CONCURRENT");
    claimIdentity = await validateRecoveryClaim(claimPath, stagingIdentity, expectedBytes, "OUTPUT_SESSION_RECOVERY_CONCURRENT");
    if (claimIdentity.nlink !== 1) fail("OUTPUT_SESSION_RECOVERY_CONCURRENT", claimPath);
    return { identity: claimIdentity, bytes: expectedBytes };
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (error instanceof BoundaryError) throw error;
    fail("OUTPUT_SESSION_RECOVERY_CONCURRENT", `${claimPath}: ${error.code ?? error.message}`);
  } finally {
    if (publishing) {
      const remaining = (locallyPublishingRecoveryClaims.get(claimPath) ?? 1) - 1;
      if (remaining > 0) locallyPublishingRecoveryClaims.set(claimPath, remaining);
      else locallyPublishingRecoveryClaims.delete(claimPath);
    }
  }
}

export async function recoverStaleOutputSessionLock(repositoryPath, authority) {
  const repository = await resolveOutputRepository(repositoryPath);
  const gitDirectory = resolve(repository.realPath, ".git");
  const lockPath = resolve(gitDirectory, outputLockName);
  const recoveryClaim = resolve(gitDirectory, outputRecoveryClaimName);
  const acquisitionClaimPath = resolve(gitDirectory, outputAcquisitionClaimName);
  await clearDeadAcquisitionClaimStages(gitDirectory, repository.realPath, lockPath);
  const acquisition = await readAcquisitionClaim(acquisitionClaimPath, repository.realPath, lockPath, "OUTPUT_SESSION_ACQUISITION_INVALID", { allowMissing: true });
  const lock = await lstat(lockPath).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    fail("OUTPUT_SESSION_RECOVERY_MISSING", `${lockPath}: ${error.code ?? error.message}`);
  });
  if (acquisition) {
    if (acquisition.value.pid === process.pid) fail("OUTPUT_SESSION_RECOVERY_CONCURRENT", acquisitionClaimPath);
    assertDeadProcess(acquisition.value.pid, "OUTPUT_SESSION_ACQUISITION_LIVE", "OUTPUT_SESSION_ACQUISITION_LIVENESS_UNKNOWN");
    if (!lock) {
      await removeAcquisitionClaim({ path: acquisitionClaimPath, ...acquisition }, repository.realPath, lockPath);
      await assertRecoveryClean(gitDirectory, lockPath, recoveryClaim, "OUTPUT_SESSION_ACQUISITION_CHANGED");
      return { reasonCode: "OUTPUT_SESSION_STALE_LOCK_RECOVERED" };
    }
    assertOutputLockIdentity(lock, undefined, "OUTPUT_SESSION_ACQUISITION_INVALID", lockPath);
    const ownerPath = resolve(lockPath, outputLockMetadataName);
    const ownerPresent = await lstat(ownerPath).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      fail("OUTPUT_SESSION_ACQUISITION_INVALID", `${ownerPath}: ${error.code ?? error.message}`);
    });
    if (!ownerPresent) {
      await clearDeadInitialOwnerPublicationStages(lockPath, lock);
      const entries = await readdir(lockPath).catch((error) => fail("OUTPUT_SESSION_ACQUISITION_INVALID", `${lockPath}: ${error.code ?? error.message}`));
      if (entries.length !== 0) fail("OUTPUT_SESSION_ACQUISITION_INVALID", lockPath);
      await rmdir(lockPath).catch((error) => fail("OUTPUT_SESSION_ACQUISITION_CHANGED", `${lockPath}: ${error.code ?? error.message}`));
      await syncDirectory(gitDirectory, "OUTPUT_SESSION_ACQUISITION_CHANGED");
      await removeAcquisitionClaim({ path: acquisitionClaimPath, ...acquisition }, repository.realPath, lockPath);
      await assertRecoveryClean(gitDirectory, lockPath, recoveryClaim, "OUTPUT_SESSION_ACQUISITION_CHANGED");
      return { reasonCode: "OUTPUT_SESSION_STALE_LOCK_RECOVERED" };
    }
    const owner = await readOutputLockMetadata(lockPath);
    if (owner.value.pid !== acquisition.value.pid || owner.value.processGroup !== null || owner.value.lockDev !== lock.dev || owner.value.lockIno !== lock.ino) {
      fail("OUTPUT_SESSION_ACQUISITION_INVALID", lockPath);
    }
    // The owner record is durable; hand its subsequent recovery to the normal
    // owner protocol only after consuming this acquisition provenance.
    const settledLock = await pathMetadata(lockPath, "OUTPUT_SESSION_ACQUISITION_CHANGED");
    const settledOwner = await readOutputLockMetadata(lockPath);
    const settledAcquisition = await readAcquisitionClaim(acquisitionClaimPath, repository.realPath, lockPath, "OUTPUT_SESSION_ACQUISITION_CHANGED");
    if (!sameIdentity(settledLock, lock) || !sameIdentity(settledOwner.identity, owner.identity) || settledOwner.bytes !== owner.bytes ||
        !sameIdentity(settledAcquisition.metadata, acquisition.metadata) || settledAcquisition.bytes !== acquisition.bytes) {
      fail("OUTPUT_SESSION_ACQUISITION_CHANGED", acquisitionClaimPath);
    }
    await removeAcquisitionClaim({ path: acquisitionClaimPath, ...settledAcquisition }, repository.realPath, lockPath);
  }
  if (!lock) {
    await clearDeadStageOnlyOrphans(gitDirectory, recoveryClaim);
    const residue = await clearDeadRecoveryClaimWithoutLock(recoveryClaim, repository.realPath, lockPath);
    if (residue) {
      await assertRecoveryClean(gitDirectory, lockPath, recoveryClaim, "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
      return residue;
    }
    fail("OUTPUT_SESSION_RECOVERY_MISSING", lockPath);
  }
  if (lock.isSymbolicLink() || !lock.isDirectory() || lock.uid !== process.getuid?.() || (lock.mode & 0o777) !== 0o700) {
    fail("OUTPUT_SESSION_RECOVERY_IDENTITY", lockPath);
  }
  const ownerPath = resolve(lockPath, outputLockMetadataName);
  let ownerExists = await lstat(ownerPath).then(() => true).catch((error) => {
    if (error.code === "ENOENT") return false;
    fail("OUTPUT_SESSION_METADATA_INVALID", `${ownerPath}: ${error.code ?? error.message}`);
  });
  if (!ownerExists && await clearDeadInitialOwnerPublicationStages(lockPath, lock)) {
    const entries = await readdir(lockPath).catch((error) => fail("OUTPUT_SESSION_METADATA_INVALID", `${lockPath}: ${error.code ?? error.message}`));
    if (entries.length !== 0) fail("OUTPUT_SESSION_RECOVERY_NOT_EMPTY", lockPath);
    await rmdir(lockPath).catch((error) => fail("OUTPUT_SESSION_RECOVERY_CHANGED", `${lockPath}: ${error.code ?? error.message}`));
    await syncDirectory(dirname(lockPath), "OUTPUT_SESSION_RECOVERY_CHANGED");
    await assertRecoveryClean(gitDirectory, lockPath, recoveryClaim, "OUTPUT_SESSION_RECOVERY_CHANGED");
    return { reasonCode: "OUTPUT_SESSION_STALE_LOCK_RECOVERED", lockDev: lock.dev, lockIno: lock.ino, lockCtimeMs: lock.ctimeMs, lockMtimeMs: lock.mtimeMs };
  }
  ownerExists = await lstat(ownerPath).then(() => true).catch((error) => {
    if (error.code === "ENOENT") return false;
    fail("OUTPUT_SESSION_METADATA_INVALID", `${ownerPath}: ${error.code ?? error.message}`);
  });
  if (ownerExists) {
    let owner = await readOutputLockMetadata(lockPath);
    if (owner.value.lockDev !== lock.dev || owner.value.lockIno !== lock.ino) fail("OUTPUT_SESSION_METADATA_INVALID", lockPath);
    assertDeadProcess(owner.value.pid, "OUTPUT_SESSION_RECOVERY_OWNER_LIVE", "OUTPUT_SESSION_RECOVERY_OWNER_LIVENESS_UNKNOWN");
    await clearDeadOwnerPublicationStages(lockPath, owner);
    const settledOwner = await readOutputLockMetadata(lockPath);
    if (!sameIdentity(owner.identity, settledOwner.identity) || owner.bytes !== settledOwner.bytes) fail("OUTPUT_SESSION_RECOVERY_CHANGED", lockPath);
    owner = settledOwner;
    assertDeadProcessGroup(owner.value.processGroup, "OUTPUT_SESSION_RECOVERY_DESCENDANT_LIVE", "OUTPUT_SESSION_RECOVERY_DESCENDANT_LIVENESS_UNKNOWN");
    // Clearing an authenticated owner-publication stage mutates the lock
    // directory.  Bind a subsequent recovery claim to this settled basis,
    // not to the pre-cleanup timestamp snapshot.
    const settledLock = await pathMetadata(lockPath, "OUTPUT_SESSION_RECOVERY_CHANGED");
    assertOutputLockIdentity(settledLock, lock, "OUTPUT_SESSION_RECOVERY_CHANGED", lockPath);
    const claim = await acquireRecoveryClaim(recoveryClaim, repository.realPath, lockPath, settledLock, { lockCtimeMs: settledLock.ctimeMs, lockMtimeMs: settledLock.mtimeMs }, owner);
    const afterLiveness = await pathMetadata(lockPath, "OUTPUT_SESSION_RECOVERY_CHANGED");
    const currentOwner = await readOutputLockMetadata(lockPath);
    if (!sameIdentity(lock, afterLiveness) || !sameIdentity(owner.identity, currentOwner.identity) || owner.bytes !== currentOwner.bytes) fail("OUTPUT_SESSION_RECOVERY_CHANGED", lockPath);
    assertDeadProcess(owner.value.pid, "OUTPUT_SESSION_RECOVERY_OWNER_LIVE", "OUTPUT_SESSION_RECOVERY_OWNER_LIVENESS_UNKNOWN");
    assertDeadProcessGroup(owner.value.processGroup, "OUTPUT_SESSION_RECOVERY_DESCENDANT_LIVE", "OUTPUT_SESSION_RECOVERY_DESCENDANT_LIVENESS_UNKNOWN");
    await releaseOutputSession(lockPath, settledLock, { deadOwner: true, ownerIdentity: owner.identity });
    await removeRecoveryClaim(recoveryClaim, claim.identity, claim.bytes);
    locallyPublishedRecoveryClaims.delete(recoveryClaim);
    await assertRecoveryClean(gitDirectory, lockPath, recoveryClaim, "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
    return { reasonCode: "OUTPUT_SESSION_STALE_LOCK_RECOVERED", lockDev: lock.dev, lockIno: lock.ino, lockCtimeMs: lock.ctimeMs, lockMtimeMs: lock.mtimeMs };
  }
  const claim = await readRecoveryClaim(recoveryClaim, lockPath, "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID", { expectedNlink: 1, allowMissing: true, lock, lockTimesMayDiffer: true, repositoryPath: repository.realPath });
  if (!claim) {
    await validateLegacyAuthority(authority, repository, lock);
    const entries = await readdir(lockPath).catch((error) => fail("OUTPUT_SESSION_RECOVERY_NOT_EMPTY", `${lockPath}: ${error.code ?? error.message}`));
    if (entries.length !== 0) fail("OUTPUT_SESSION_RECOVERY_NOT_EMPTY", lockPath);
    const afterEmptyRead = await pathMetadata(lockPath, "OUTPUT_SESSION_RECOVERY_TARGET_REPLACED");
    assertOutputLockIdentity(afterEmptyRead, lock, "OUTPUT_SESSION_RECOVERY_TARGET_REPLACED", lockPath);
    if (afterEmptyRead.ctimeMs !== lock.ctimeMs || afterEmptyRead.mtimeMs !== lock.mtimeMs) fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", lockPath);
    const beforeRmdir = await pathMetadata(lockPath, "OUTPUT_SESSION_RECOVERY_TARGET_REPLACED");
    assertOutputLockIdentity(beforeRmdir, lock, "OUTPUT_SESSION_RECOVERY_TARGET_REPLACED", lockPath);
    if (beforeRmdir.ctimeMs !== lock.ctimeMs || beforeRmdir.mtimeMs !== lock.mtimeMs) fail("OUTPUT_SESSION_RECOVERY_LEGACY_RECEIPT_MISMATCH", lockPath);
    await rmdir(lockPath).catch((error) => fail("OUTPUT_SESSION_RECOVERY_CHANGED", `${lockPath}: ${error.code ?? error.message}`));
    await syncDirectory(gitDirectory, "OUTPUT_SESSION_RECOVERY_CHANGED");
    await assertRecoveryClean(gitDirectory, lockPath, recoveryClaim, "OUTPUT_SESSION_RECOVERY_CHANGED");
    return { reasonCode: "OUTPUT_SESSION_STALE_LOCK_RECOVERED", lockDev: lock.dev, lockIno: lock.ino, lockCtimeMs: lock.ctimeMs, lockMtimeMs: lock.mtimeMs };
  }
  if (claim.value.pid === process.pid && claim.locallyPublished) {
    fail("OUTPUT_SESSION_RECOVERY_CONCURRENT", recoveryClaim);
  }
  assertDeadProcess(claim.value.pid, "OUTPUT_SESSION_RECOVERY_CLAIM_LIVE", "OUTPUT_SESSION_RECOVERY_CLAIM_LIVENESS_UNKNOWN");
  const entries = await readdir(lockPath).catch((error) => fail("OUTPUT_SESSION_RECOVERY_NOT_EMPTY", `${lockPath}: ${error.code ?? error.message}`));
  if (entries.length !== 0) fail("OUTPUT_SESSION_RECOVERY_NOT_EMPTY", lockPath);
  await validateRecoveryClaim(recoveryClaim, claim.metadata, claim.bytes, "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
  const beforeRmdir = await pathMetadata(lockPath, "OUTPUT_SESSION_RECOVERY_TARGET_REPLACED");
  assertOutputLockIdentity(beforeRmdir, lock, "OUTPUT_SESSION_RECOVERY_TARGET_REPLACED", lockPath);
  await rmdir(lockPath).catch((error) => fail("OUTPUT_SESSION_RECOVERY_CHANGED", `${lockPath}: ${error.code ?? error.message}`));
  await syncDirectory(gitDirectory, "OUTPUT_SESSION_RECOVERY_CHANGED");
  await removeRecoveryClaim(recoveryClaim, claim.metadata, claim.bytes);
  locallyPublishedRecoveryClaims.delete(recoveryClaim);
  await assertRecoveryClean(gitDirectory, lockPath, recoveryClaim, "OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED");
  return { reasonCode: "OUTPUT_SESSION_STALE_LOCK_RECOVERED", lockDev: lock.dev, lockIno: lock.ino, lockCtimeMs: claim.value.lockCtimeMs, lockMtimeMs: claim.value.lockMtimeMs };
}

export function assertCleanExclusiveSourceBasis(status) {
  if (typeof status !== "string" || status !== "") {
    fail(
      "P1_EXCLUSIVE_SOURCE_BASIS_REQUIRED",
      "The accepted P1 proof requires a clean checkout under the exclusive output session",
    );
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

async function resolveOutputRepository(repositoryPath) {
  return resolveBoundDirectory(repositoryPath, {
    reasonCode: "OUTPUT_REPOSITORY_INVALID",
    symlinkReasonCode: "OUTPUT_REPOSITORY_SYMLINK",
  });
}

async function requireOutputSession(repositoryPath) {
  const repository = await resolveOutputRepository(repositoryPath);
  const session = outputSessionStorage.getStore();
  if (!session || session.repositoryReal !== repository.realPath) {
    fail("OUTPUT_SESSION_REQUIRED", "Output mutation requires the repository's exclusive output session");
  }
  const lock = await pathMetadata(session.lockPath, "OUTPUT_SESSION_LOST");
  assertOutputLockIdentity(lock, session.lockIdentity, "OUTPUT_SESSION_LOST", `${session.lockPath} no longer names the exclusive output lock`);
  return repository;
}

export async function bindOutputSessionProcessGroup(processGroup) {
  if (!Number.isSafeInteger(processGroup) || processGroup <= 0) {
    fail("OUTPUT_SESSION_PROCESS_GROUP_INVALID", String(processGroup));
  }
  const session = outputSessionStorage.getStore();
  if (!session) fail("OUTPUT_SESSION_REQUIRED", "Process-group binding requires the repository's exclusive output session");
  const lock = await pathMetadata(session.lockPath, "OUTPUT_SESSION_LOST");
  assertOutputLockIdentity(lock, session.lockIdentity, "OUTPUT_SESSION_LOST", session.lockPath);
  const owner = await readOutputLockMetadata(session.lockPath);
  if (!sameIdentity(owner.identity, session.ownerIdentity) || owner.value.pid !== process.pid) {
    fail("OUTPUT_SESSION_RELEASE_REPLACED", resolve(session.lockPath, outputLockMetadataName));
  }
  assertDeadProcessGroup(
    owner.value.processGroup,
    "OUTPUT_SESSION_PROCESS_GROUP_LIVE",
    "OUTPUT_SESSION_PROCESS_GROUP_LIVENESS_UNKNOWN",
  );
  const next = { ...owner.value, processGroup };
  const sealed = await publishOutputOwnerMetadata(session.lockPath, owner, next, "OUTPUT_SESSION_PROCESS_GROUP_BIND_FAILED");
  if (sealed.value.processGroup !== processGroup || sealed.value.pid !== process.pid) fail("OUTPUT_SESSION_RELEASE_REPLACED", resolve(session.lockPath, outputLockMetadataName));
  session.ownerIdentity = sealed.identity;
}

export async function withExclusiveOutputSession(repositoryPath, operation) {
  if (typeof operation !== "function") {
    fail("OUTPUT_SESSION_OPERATION_REQUIRED", "An output session requires an operation callback");
  }
  const repository = await resolveOutputRepository(repositoryPath);
  const active = outputSessionStorage.getStore();
  if (active) {
    if (active.repositoryReal !== repository.realPath) {
      fail("OUTPUT_SESSION_REPOSITORY_MISMATCH", "A nested output session cannot change repositories");
    }
    return operation();
  }
  const gitDirectory = resolve(repository.realPath, ".git");
  const gitMetadata = await pathMetadata(gitDirectory, "OUTPUT_SESSION_REPOSITORY_INVALID");
  if (gitMetadata.isSymbolicLink() || !gitMetadata.isDirectory()) {
    fail("OUTPUT_SESSION_REPOSITORY_INVALID", `${gitDirectory} must be a real directory`);
  }
  const gitReal = await realpath(gitDirectory);
  if (dirname(gitReal) !== repository.realPath) {
    fail("OUTPUT_SESSION_REPOSITORY_INVALID", `${gitDirectory} must remain directly beneath the repository`);
  }
  const lockPath = resolve(gitReal, outputLockName);
  const recoveryClaim = resolve(gitReal, outputRecoveryClaimName);
  const acquisitionClaimPath = resolve(gitReal, outputAcquisitionClaimName);
  await clearDeadStageOnlyOrphans(gitReal, recoveryClaim);
  await clearDeadAcquisitionClaimStages(gitReal, repository.realPath, lockPath);
  // A fixed claim is disposable only after a fresh ENOENT readback of its
  // bound lock.  When both objects exist, recovery owns their transaction.
  const lockBeforeAcquisition = await lstat(lockPath).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    fail("OUTPUT_SESSION_RECOVERY_CLAIM_CHANGED", `${lockPath}: ${error.code ?? error.message}`);
  });
  if (!lockBeforeAcquisition) {
    await clearDeadRecoveryClaimWithoutLock(recoveryClaim, repository.realPath, lockPath);
  }
  const existingAcquisition = await readAcquisitionClaim(acquisitionClaimPath, repository.realPath, lockPath, "OUTPUT_SESSION_ACQUISITION_INVALID", { allowMissing: true });
  if (existingAcquisition) {
    if (existingAcquisition.value.pid === process.pid) fail("OUTPUT_SESSION_ACQUISITION_CONCURRENT", acquisitionClaimPath);
    assertDeadProcess(existingAcquisition.value.pid, "OUTPUT_SESSION_ACQUISITION_LIVE", "OUTPUT_SESSION_ACQUISITION_LIVENESS_UNKNOWN");
    await recoverStaleOutputSessionLock(repository.realPath);
    return withExclusiveOutputSession(repository.realPath, operation);
  }
  // A stale initial observation is never authorization to create the fixed
  // lock.  Reconcile the transaction that was present, then restart from a
  // fresh ENOENT observation so every mkdir is claim-held.
  if (lockBeforeAcquisition) {
    try {
      await recoverStaleOutputSessionLock(repository.realPath);
    } catch (error) {
      if (!(error instanceof BoundaryError) || error.reasonCode !== "OUTPUT_SESSION_RECOVERY_MISSING") throw error;
      await assertRecoveryClean(gitReal, lockPath, recoveryClaim, "OUTPUT_SESSION_RECOVERY_CHANGED");
    }
    return withExclusiveOutputSession(repository.realPath, operation);
  }
  let acquisition;
  const publishAcquisition = async () => {
    acquisition = await publishAcquisitionClaim(gitReal, repository.realPath, lockPath);
    if (process.env.TCRN_TEST_OUTPUT_SESSION_ACQUISITION_CRASH_AT === "after-marker-publication") process.kill(process.pid, "SIGKILL");
  };
  await publishAcquisition();
  try {
    await mkdir(lockPath, { mode: 0o700 });
    if (process.env.TCRN_TEST_OUTPUT_SESSION_ACQUISITION_CRASH_AT === "after-lock-mkdir") process.kill(process.pid, "SIGKILL");
  } catch (error) {
    if (error.code === "EEXIST") fail("OUTPUT_SESSION_ACQUISITION_CHANGED", lockPath);
    throw error;
  }
  const lock = await pathMetadata(lockPath, "OUTPUT_SESSION_LOST");
  const recoveryAfterLock = await findRecoveryObjects(gitReal, recoveryClaim, "OUTPUT_SESSION_RECOVERY_CLAIM_INVALID");
  if (recoveryAfterLock.fixed || recoveryAfterLock.stages.length !== 0) {
    await removeUninitializedOutputSessionLock(lockPath, lock);
    fail("OUTPUT_SESSION_RECOVERY_CLAIM_PENDING", recoveryAfterLock.fixed ? recoveryClaim : resolve(gitReal, recoveryAfterLock.stages[0]));
  }
  const ownerUid = process.getuid?.();
  if (!Number.isSafeInteger(ownerUid) || lock.uid !== ownerUid || (lock.mode & 0o777) !== 0o700) {
    await removeUninitializedOutputSessionLock(lockPath, lock);
    fail("OUTPUT_SESSION_OWNER_INVALID", lockPath);
  }
  let ownerIdentity;
  try {
    ownerIdentity = (await publishInitialOutputOwnerMetadata(lockPath, lock, ownerUid)).identity;
    if (process.env.TCRN_TEST_OUTPUT_SESSION_ACQUISITION_CRASH_AT === "after-owner-publication") process.kill(process.pid, "SIGKILL");
  } catch (error) {
    if (ownerIdentity) await removeOwnedOutputSessionMetadata(lockPath, lock, ownerIdentity);
    else await removeUninitializedOutputSessionLock(lockPath, lock);
    fail("OUTPUT_SESSION_METADATA_CREATE_FAILED", `${lockPath}: ${error.code ?? error.message}`);
  }
  const lockIdentity = await pathMetadata(lockPath, "OUTPUT_SESSION_LOST");
  if (!sameIdentity(lock, lockIdentity) || lockIdentity.isSymbolicLink() || !lockIdentity.isDirectory() || lockIdentity.uid !== ownerUid || (lockIdentity.mode & 0o777) !== 0o700) {
    await releaseOutputSession(lockPath, lock);
    fail("OUTPUT_SESSION_OWNER_INVALID", lockPath);
  }
  const initialOwner = await readOutputLockMetadata(lockPath);
  if (!sameIdentity(initialOwner.identity, ownerIdentity) || initialOwner.value.pid !== process.pid || !acquisition) {
    fail("OUTPUT_SESSION_ACQUISITION_CHANGED", acquisitionClaimPath);
  }
  await removeAcquisitionClaim(acquisition, repository.realPath, lockPath);
  const session = { repositoryReal: repository.realPath, lockPath, lockIdentity, ownerIdentity };
  let released = false;
  let releasePromise;
  const release = () => releasePromise ??= (async () => {
    const owner = await readOutputLockMetadata(lockPath).catch(() => fail("OUTPUT_SESSION_RELEASE_REPLACED", resolve(lockPath, outputLockMetadataName)));
    if (!sameIdentity(owner.identity, session.ownerIdentity) || owner.value.pid !== process.pid) {
      fail("OUTPUT_SESSION_RELEASE_REPLACED", resolve(lockPath, outputLockMetadataName));
    }
    // Binding a detached controller replaces owner.json and changes directory
    // timestamps.  Capture the live lock identity immediately before the
    // release claim so recovery validates the transaction's actual basis.
    const currentLock = await pathMetadata(lockPath, "OUTPUT_SESSION_RELEASE_REPLACED");
    assertOutputLockIdentity(currentLock, session.lockIdentity, "OUTPUT_SESSION_RELEASE_REPLACED", lockPath);
    const claim = await acquireRecoveryClaim(
      recoveryClaim,
      repository.realPath,
      lockPath,
      currentLock,
      { lockCtimeMs: currentLock.ctimeMs, lockMtimeMs: currentLock.mtimeMs },
      owner,
    );
    try {
      await releaseOutputSession(lockPath, session.lockIdentity, { ownerIdentity: session.ownerIdentity });
    } catch (error) {
      // A failure after owner unlink must retain the claim: it is the sole
      // provenance that lets governed recovery resume an ownerless lock.
      const lockAfterFailure = await lstat(lockPath).catch((readError) => {
        if (readError.code === "ENOENT") return undefined;
        return undefined;
      });
      const ownerAfterFailure = lockAfterFailure && await lstat(resolve(lockPath, outputLockMetadataName)).catch(() => undefined);
      if (lockAfterFailure && sameIdentity(lockAfterFailure, currentLock) && ownerAfterFailure &&
          sameIdentity(ownerAfterFailure, session.ownerIdentity)) {
        await removeRecoveryClaim(recoveryClaim, claim.identity, claim.bytes);
        locallyPublishedRecoveryClaims.delete(recoveryClaim);
      }
      throw error;
    }
    await removeRecoveryClaim(recoveryClaim, claim.identity, claim.bytes);
    locallyPublishedRecoveryClaims.delete(recoveryClaim);
    await assertRecoveryClean(gitReal, lockPath, recoveryClaim, "OUTPUT_SESSION_RELEASE_FAILED");
  })();
  const interrupt = (signal) => {
    if (released) return;
    released = true;
    const exitCode = signal === "SIGINT" ? 130 : 143;
    void release().then(() => process.exit(exitCode), () => process.exit(1));
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    return await outputSessionStorage.run(session, operation);
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (!released) { released = true; await release(); }
  }
}

// `allowHardlinks` exists for exactly one class of caller: a file this repository does
// not own, read from a package manager's tree. pnpm's store is content-addressable and
// hardlinks into node_modules by design, so `nlink === 1` there asserts a property of
// someone else's storage layout rather than anything about our bytes. Every other guard
// stays on -- symlink refusal, O_NOFOLLOW, and the dev/ino identity carried through open
// and read, which is what actually closes the TOCTOU window. The default is false and
// must stay false: for a tracked source file, a second link IS the finding.
export async function readBoundRegularFile(path, {
  reasonCode,
  hardlinkReasonCode,
  pathChangedReasonCode = "INPUT_PATH_CHANGED",
  allowHardlinks = false,
  afterOpen,
} = {}) {
  const inputReason = reasonCode ?? "INPUT_INVALID";
  const hardlinkReason = hardlinkReasonCode ?? inputReason;
  const lexicalPath = resolve(path);
  const before = await pathMetadata(lexicalPath, inputReason);
  if (before.isSymbolicLink() || !before.isFile()) {
    fail(inputReason, `${lexicalPath} must be a regular non-symlink file`);
  }
  if (!allowHardlinks && before.nlink !== 1) {
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
    if (!allowHardlinks && opened.nlink !== 1) {
      fail(hardlinkReason, `${lexicalPath} must have exactly one filesystem link`);
    }
    if (afterOpen) {
      await afterOpen({ path: lexicalPath, descriptor: handle.fd });
    }
    const content = await handle.readFile();
    const afterRead = await handle.stat();
    if (!sameIdentity(opened, afterRead) || (!allowHardlinks && afterRead.nlink !== 1)) {
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

async function ensureSafeOutputDirectory(repositoryPath, relativeDirectory = "dist") {
  const segments = outputSegments(relativeDirectory === "dist" ? "dist/.sentinel" : `${relativeDirectory}/.sentinel`).slice(0, -1);
  const repository = await requireOutputSession(repositoryPath);
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
  const repository = await requireOutputSession(repositoryPath);
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
