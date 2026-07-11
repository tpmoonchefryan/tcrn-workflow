// SPDX-License-Identifier: Apache-2.0

import { createHash, verify as verifySignature } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJsonBytes } from "./canonical-json.mjs";
import { isInside } from "./files.mjs";

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
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
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

function instant(value, reasonCode, field) {
  const text = requiredString(value, reasonCode, field);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    fail(reasonCode, `${field} must be an ISO date-time`);
  }
  return parsed;
}

async function regularUnlinkedFile(path, reasonCode, { hardlink = false } = {}) {
  const linkMetadata = await lstat(path).catch(() => fail(reasonCode, `Missing file: ${path}`));
  if (linkMetadata.isSymbolicLink() || !linkMetadata.isFile()) {
    fail(reasonCode, `File must be regular and not symbolic: ${path}`);
  }
  const metadata = await stat(path);
  if (hardlink && metadata.nlink !== 1) {
    fail("TRUST_ARTIFACT_HARDLINK", "Artifact must have one filesystem link");
  }
  return metadata;
}

function safeBundlePath(bundleRoot, relativePath) {
  requiredString(relativePath, "TRUST_ARTIFACT_PATH", "artifact.path");
  if (isAbsolute(relativePath) || relativePath.includes("\\")) {
    fail("TRUST_ARTIFACT_PATH", "Artifact path must be portable and relative");
  }
  const candidate = resolve(bundleRoot, relativePath);
  const relation = relative(bundleRoot, candidate);
  if (relation === "" || relation.startsWith("..") || relation.startsWith(sep)) {
    fail("TRUST_ARTIFACT_PATH_ESCAPE", "Artifact escapes bundle root");
  }
  return candidate;
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
      instant(key.revokedAt, "TRUST_ROOT_MALFORMED", "revokedAt");
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
  instant(manifest.issuedAt, "TRUST_MANIFEST_MALFORMED", "issuedAt");
  instant(manifest.expiresAt, "TRUST_MANIFEST_MALFORMED", "expiresAt");
  exactKeys(manifest.artifact, ["path", "sha256", "size"], "TRUST_MANIFEST_MALFORMED");
  requiredString(manifest.artifact.path, "TRUST_MANIFEST_MALFORMED", "artifact.path");
  if (typeof manifest.artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.artifact.sha256)) {
    fail("TRUST_MANIFEST_MALFORMED", "artifact.sha256 must be lowercase SHA-256");
  }
  if (!Number.isSafeInteger(manifest.artifact.size) || manifest.artifact.size < 0) {
    fail("TRUST_MANIFEST_MALFORMED", "artifact.size must be a non-negative integer");
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
  await regularUnlinkedFile(trustRootPath, "TRUST_ROOT_FILE");
  const rootReal = await realpath(trustRootPath);
  const repositoryReal = await realpath(repositoryRoot);
  if (isInside(repositoryReal, rootReal)) {
    fail("TRUST_ROOT_CANDIDATE_CONTROLLED", "Trust root resolves inside the candidate checkout");
  }

  const bundleReal = await realpath(bundlePath).catch(() => fail("TRUST_BUNDLE_MISSING", "Bundle is missing"));
  const bundleMetadata = await stat(bundleReal);
  if (!bundleMetadata.isDirectory()) {
    fail("TRUST_BUNDLE_MISSING", "Bundle path must be a directory");
  }

  const manifestPath = resolve(bundleReal, "manifest.json");
  const signaturePath = resolve(bundleReal, "manifest.sig");
  await regularUnlinkedFile(manifestPath, "TRUST_MANIFEST_FILE");
  await regularUnlinkedFile(signaturePath, "TRUST_SIGNATURE_FILE");

  let root;
  let manifest;
  try {
    root = JSON.parse(await readFile(rootReal, "utf8"));
  } catch (error) {
    fail("TRUST_ROOT_MALFORMED", String(error));
  }
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail("TRUST_MANIFEST_MALFORMED", String(error));
  }

  validateTrustRoot(root);
  validateManifest(manifest);

  const verificationTime = instant(now, "TRUST_TIME_INVALID", "now");
  const rootStart = instant(root.validFrom, "TRUST_ROOT_MALFORMED", "validFrom");
  const rootEnd = instant(root.validUntil, "TRUST_ROOT_MALFORMED", "validUntil");
  if (verificationTime < rootStart || verificationTime > rootEnd) {
    fail("TRUST_ROOT_EXPIRED", "Trust root is outside its validity interval");
  }
  const manifestStart = instant(manifest.issuedAt, "TRUST_MANIFEST_MALFORMED", "issuedAt");
  const manifestEnd = instant(manifest.expiresAt, "TRUST_MANIFEST_MALFORMED", "expiresAt");
  if (verificationTime < manifestStart || verificationTime > manifestEnd) {
    fail("TRUST_MANIFEST_EXPIRED", "Manifest is outside its validity interval");
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
  if (key.revokedAt !== null && verificationTime >= instant(key.revokedAt, "TRUST_ROOT_MALFORMED", "revokedAt")) {
    fail("TRUST_KEY_REVOKED", "Signer key is revoked");
  }

  const signatureText = (await readFile(signaturePath, "utf8")).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText)) {
    fail("TRUST_SIGNATURE_ENCODING", "Signature must be canonical base64");
  }
  const signature = Buffer.from(signatureText, "base64");
  let validSignature = false;
  try {
    validSignature = verifySignature(null, canonicalJsonBytes(manifest), key.publicKeyPem, signature);
  } catch {
    fail("TRUST_KEY_INVALID", "Trusted public key is invalid");
  }
  if (!validSignature) {
    fail("TRUST_SIGNATURE_INVALID", "Manifest signature is invalid");
  }

  const artifactPath = safeBundlePath(bundleReal, manifest.artifact.path);
  const artifactMetadata = await regularUnlinkedFile(artifactPath, "TRUST_ARTIFACT_FILE", { hardlink: true });
  const artifactReal = await realpath(artifactPath);
  if (!isInside(bundleReal, artifactReal)) {
    fail("TRUST_ARTIFACT_PATH_ESCAPE", "Artifact resolves outside bundle root");
  }
  if (artifactMetadata.size !== manifest.artifact.size) {
    fail("TRUST_ARTIFACT_SIZE", "Artifact size does not match manifest");
  }
  const digest = createHash("sha256").update(await readFile(artifactReal)).digest("hex");
  if (digest !== manifest.artifact.sha256) {
    fail("TRUST_ARTIFACT_DIGEST", "Artifact digest does not match manifest");
  }

  return {
    admitted: true,
    reasonCode: "TRUST_VERIFIED",
    rootVersion: root.rootVersion,
    sequence: manifest.sequence,
    signerKeyId: manifest.signerKeyId,
    artifactSha256: digest,
  };
}
