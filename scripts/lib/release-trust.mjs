// SPDX-License-Identifier: Apache-2.0

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

import { canonicalJson, canonicalJsonBytes } from "./canonical-json.mjs";
import { compareCanonicalText } from "./canonical-order.mjs";
import { isInside } from "./files.mjs";
import { BoundaryError, readBoundRegularFile, resolveBoundDirectory } from "./safe-io.mjs";

export class TrustVerificationError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "TrustVerificationError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, message) {
  throw new TrustVerificationError(reasonCode, message);
}

function exactKeys(value, expected, reasonCode) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(reasonCode, "Expected an object");
  }
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...expected].sort(compareCanonicalText);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(reasonCode, `Unexpected fields: ${actual.join(",")}`);
  }
}

function requiredString(value, reasonCode, field) {
  if (typeof value !== "string" || value.length === 0) {
    fail(reasonCode, `${field} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(value, reasonCode, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(reasonCode, `${field} must be a positive integer`);
  }
  return value;
}

function leapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

export function strictRfc3339Instant(value, reasonCode, field) {
  const text = requiredString(value, reasonCode, field);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/u);
  if (!match) {
    fail(reasonCode, `${field} must be a strict RFC 3339 instant`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const zone = match[8];
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) {
    fail(reasonCode, `${field} contains an impossible date, time, or offset`);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  let offsetSeconds = offsetHour * 3600 + offsetMinute * 60;
  if (zone !== "Z" && match[9] === "+") {
    offsetSeconds *= 1;
  } else if (zone !== "Z") {
    offsetSeconds *= -1;
  } else {
    offsetSeconds = 0;
  }
  const fractionNanoseconds = BigInt((fraction || "0").padEnd(9, "0"));
  return BigInt(date.getTime() - offsetSeconds * 1000) * 1_000_000n + fractionNanoseconds;
}

function parseCanonicalJson(content, malformedReason, canonicalReason) {
  const text = content.toString("utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(malformedReason, String(error));
  }
  if (text !== `${canonicalJson(value)}\n`) {
    fail(canonicalReason, "JSON input must be canonical UTF-8 with one terminal LF");
  }
  return value;
}

function validateTrustRoot(root) {
  exactKeys(
    root,
    [
      "keys",
      "minimumSequence",
      "repository",
      "rootVersion",
      "schemaVersion",
      "validFrom",
      "validUntil",
      "workflow",
    ],
    "TRUST_ROOT_MALFORMED",
  );
  if (root.schemaVersion !== "tcrn.release-trust-root.v1") {
    fail("TRUST_ROOT_SCHEMA", "Unsupported trust-root schema");
  }
  requiredInteger(root.rootVersion, "TRUST_ROOT_MALFORMED", "rootVersion");
  requiredInteger(root.minimumSequence, "TRUST_ROOT_MALFORMED", "minimumSequence");
  requiredString(root.repository, "TRUST_ROOT_MALFORMED", "repository");
  requiredString(root.workflow, "TRUST_ROOT_MALFORMED", "workflow");
  if (!Array.isArray(root.keys) || root.keys.length === 0) {
    fail("TRUST_ROOT_MALFORMED", "At least one key is required");
  }
  const ids = new Set();
  for (const key of root.keys) {
    exactKeys(key, ["algorithm", "keyId", "publicKeyPem", "revokedAt"], "TRUST_ROOT_MALFORMED");
    requiredString(key.keyId, "TRUST_ROOT_MALFORMED", "keyId");
    if (ids.has(key.keyId)) {
      fail("TRUST_ROOT_MALFORMED", "Duplicate key id");
    }
    ids.add(key.keyId);
    if (key.algorithm !== "ed25519") {
      fail("TRUST_KEY_ALGORITHM", "Only Ed25519 is supported");
    }
    requiredString(key.publicKeyPem, "TRUST_ROOT_MALFORMED", "publicKeyPem");
    if (key.revokedAt !== null) {
      strictRfc3339Instant(key.revokedAt, "TRUST_ROOT_TIME_INVALID", "revokedAt");
    }
  }
}

function validateManifest(manifest) {
  exactKeys(
    manifest,
    [
      "artifact",
      "expiresAt",
      "issuedAt",
      "repository",
      "schemaVersion",
      "sequence",
      "signerKeyId",
      "subject",
      "workflow",
    ],
    "TRUST_MANIFEST_MALFORMED",
  );
  if (manifest.schemaVersion !== "tcrn.release-manifest.v1") {
    fail("TRUST_MANIFEST_SCHEMA", "Unsupported manifest schema");
  }
  for (const field of ["subject", "repository", "workflow", "signerKeyId"]) {
    requiredString(manifest[field], "TRUST_MANIFEST_MALFORMED", field);
  }
  requiredInteger(manifest.sequence, "TRUST_MANIFEST_MALFORMED", "sequence");
  strictRfc3339Instant(manifest.issuedAt, "TRUST_MANIFEST_TIME_INVALID", "issuedAt");
  strictRfc3339Instant(manifest.expiresAt, "TRUST_MANIFEST_TIME_INVALID", "expiresAt");
  exactKeys(manifest.artifact, ["path", "sha256", "size"], "TRUST_MANIFEST_MALFORMED");
  requiredString(manifest.artifact.path, "TRUST_MANIFEST_MALFORMED", "artifact.path");
  if (typeof manifest.artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.artifact.sha256)) {
    fail("TRUST_MANIFEST_MALFORMED", "artifact.sha256 must be lowercase SHA-256");
  }
  if (!Number.isSafeInteger(manifest.artifact.size) || manifest.artifact.size < 0) {
    fail("TRUST_MANIFEST_MALFORMED", "artifact.size must be a non-negative integer");
  }
}

function safeBundlePath(bundleRoot, relativePath) {
  requiredString(relativePath, "TRUST_ARTIFACT_PATH", "artifact.path");
  if (isAbsolute(relativePath) || relativePath.includes("\\") || normalize(relativePath) !== relativePath) {
    fail("TRUST_ARTIFACT_PATH", "Artifact path must be canonical, portable, and relative");
  }
  const candidate = resolve(bundleRoot, relativePath);
  const relation = relative(bundleRoot, candidate);
  if (relation === "" || relation.startsWith("..") || relation.startsWith(sep)) {
    fail("TRUST_ARTIFACT_PATH_ESCAPE", "Artifact escapes or names the bundle root");
  }
  return candidate;
}

function canonicalSignature(content) {
  const text = content.toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r")) {
    fail("TRUST_SIGNATURE_ENCODING", "Signature file must contain one canonical base64 line and terminal LF");
  }
  const encoded = text.slice(0, -1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
    fail("TRUST_SIGNATURE_ENCODING", "Signature must be canonical padded base64");
  }
  const signature = Buffer.from(encoded, "base64");
  if (signature.toString("base64") !== encoded) {
    fail("TRUST_SIGNATURE_ENCODING", "Signature base64 decode/re-encode mismatch");
  }
  if (signature.length !== 64) {
    fail("TRUST_SIGNATURE_LENGTH", "Ed25519 signatures must be exactly 64 bytes");
  }
  return signature;
}

async function boundInput(path, reasonCode, hardlinkReasonCode) {
  try {
    return await readBoundRegularFile(path, {
      reasonCode,
      hardlinkReasonCode,
      pathChangedReasonCode: "TRUST_INPUT_PATH_CHANGED",
    });
  } catch (error) {
    if (error instanceof BoundaryError) {
      fail(error.reasonCode, error.message);
    }
    throw error;
  }
}

export async function verifyReleaseBundle({
  repositoryRoot,
  trustRootPath,
  bundlePath,
  expectedSubject,
  expectedRepository,
  expectedWorkflow,
  now,
}) {
  if (!trustRootPath) {
    fail("TRUST_ROOT_REQUIRED", "An explicit trust-root path is required");
  }
  const repositoryReal = (await resolveBoundDirectory(repositoryRoot, {
    reasonCode: "TRUST_REPOSITORY_DIRECTORY",
    symlinkReasonCode: "TRUST_REPOSITORY_SYMLINK",
  })).realPath;
  const rootInput = await boundInput(trustRootPath, "TRUST_ROOT_FILE", "TRUST_ROOT_HARDLINK");
  if (isInside(repositoryReal, rootInput.realPath)) {
    fail("TRUST_ROOT_CANDIDATE_CONTROLLED", "Trust root resolves inside the candidate checkout");
  }

  let bundleReal;
  try {
    bundleReal = (await resolveBoundDirectory(bundlePath, {
      reasonCode: "TRUST_BUNDLE_DIRECTORY",
      symlinkReasonCode: "TRUST_BUNDLE_SYMLINK",
    })).realPath;
  } catch (error) {
    if (error instanceof BoundaryError) {
      fail(error.reasonCode, error.message);
    }
    throw error;
  }

  const manifestInput = await boundInput(
    resolve(bundleReal, "manifest.json"),
    "TRUST_MANIFEST_FILE",
    "TRUST_MANIFEST_HARDLINK",
  );
  const signatureInput = await boundInput(
    resolve(bundleReal, "manifest.sig"),
    "TRUST_SIGNATURE_FILE",
    "TRUST_SIGNATURE_HARDLINK",
  );
  const root = parseCanonicalJson(rootInput.content, "TRUST_ROOT_MALFORMED", "TRUST_ROOT_CANONICAL_JSON");
  const manifest = parseCanonicalJson(
    manifestInput.content,
    "TRUST_MANIFEST_MALFORMED",
    "TRUST_MANIFEST_CANONICAL_JSON",
  );
  validateTrustRoot(root);
  validateManifest(manifest);

  const verificationTime = strictRfc3339Instant(now, "TRUST_TIME_INVALID", "now");
  const rootStart = strictRfc3339Instant(root.validFrom, "TRUST_ROOT_TIME_INVALID", "validFrom");
  const rootEnd = strictRfc3339Instant(root.validUntil, "TRUST_ROOT_TIME_INVALID", "validUntil");
  if (rootStart > rootEnd) {
    fail("TRUST_ROOT_TIME_ORDER", "Trust-root validity window is inverted");
  }
  if (verificationTime < rootStart) {
    fail("TRUST_ROOT_NOT_YET_VALID", "Trust root is not yet valid");
  }
  if (verificationTime > rootEnd) {
    fail("TRUST_ROOT_EXPIRED", "Trust root is expired");
  }
  const manifestStart = strictRfc3339Instant(
    manifest.issuedAt,
    "TRUST_MANIFEST_TIME_INVALID",
    "issuedAt",
  );
  const manifestEnd = strictRfc3339Instant(
    manifest.expiresAt,
    "TRUST_MANIFEST_TIME_INVALID",
    "expiresAt",
  );
  if (manifestStart > manifestEnd) {
    fail("TRUST_MANIFEST_TIME_ORDER", "Manifest validity window is inverted");
  }
  if (verificationTime < manifestStart) {
    fail("TRUST_MANIFEST_NOT_YET_VALID", "Manifest is not yet valid");
  }
  if (verificationTime > manifestEnd) {
    fail("TRUST_MANIFEST_EXPIRED", "Manifest is expired");
  }

  if (root.repository !== expectedRepository || manifest.repository !== expectedRepository) {
    fail("TRUST_REPOSITORY_MISMATCH", "Repository claim mismatch");
  }
  if (root.workflow !== expectedWorkflow || manifest.workflow !== expectedWorkflow) {
    fail("TRUST_WORKFLOW_MISMATCH", "Workflow claim mismatch");
  }
  if (manifest.subject !== expectedSubject) {
    fail("TRUST_SUBJECT_MISMATCH", "Subject claim mismatch");
  }
  if (manifest.sequence < root.minimumSequence) {
    fail("TRUST_SEQUENCE_ROLLBACK", "Manifest sequence is below the trust-root floor");
  }

  const key = root.keys.find((candidate) => candidate.keyId === manifest.signerKeyId);
  if (!key) {
    fail("TRUST_KEY_UNKNOWN", "Signer key is not trusted");
  }
  if (
    key.revokedAt !== null &&
    verificationTime >= strictRfc3339Instant(key.revokedAt, "TRUST_ROOT_TIME_INVALID", "revokedAt")
  ) {
    fail("TRUST_KEY_REVOKED", "Signer key is revoked");
  }
  let publicKey;
  try {
    publicKey = createPublicKey(key.publicKeyPem);
  } catch {
    fail("TRUST_KEY_INVALID", "Trusted public key is invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("TRUST_KEY_INVALID", "Trusted public key is not Ed25519");
  }
  const signature = canonicalSignature(signatureInput.content);
  if (!verifySignature(null, canonicalJsonBytes(manifest), publicKey, signature)) {
    fail("TRUST_SIGNATURE_INVALID", "Manifest signature is invalid");
  }

  const artifactPath = safeBundlePath(bundleReal, manifest.artifact.path);
  const artifactInput = await boundInput(artifactPath, "TRUST_ARTIFACT_FILE", "TRUST_ARTIFACT_HARDLINK");
  if (!isInside(bundleReal, artifactInput.realPath)) {
    fail("TRUST_ARTIFACT_PATH_ESCAPE", "Artifact resolves outside bundle root");
  }
  if (artifactInput.metadata.size !== manifest.artifact.size) {
    fail("TRUST_ARTIFACT_SIZE", "Artifact size does not match manifest");
  }
  const digest = createHash("sha256").update(artifactInput.content).digest("hex");
  if (digest !== manifest.artifact.sha256) {
    fail("TRUST_ARTIFACT_DIGEST", "Artifact digest does not match manifest");
  }

  return {
    admitted: true,
    reasonCode: "TRUST_VERIFIED",
    rootVersion: root.rootVersion,
    rootVersionRollbackDisposition: "external-prior-root-floor-required",
    sequence: manifest.sequence,
    signerKeyId: manifest.signerKeyId,
    artifactSha256: digest,
  };
}
