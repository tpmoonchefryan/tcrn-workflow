// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { canonicalJson, canonicalJsonBytes } from "../scripts/lib/canonical-json.mjs";
import {
  strictRfc3339Instant,
  TrustVerificationError,
  verifyReleaseBundle,
} from "../scripts/lib/release-trust.mjs";
import { repositoryRoot } from "../scripts/lib/files.mjs";

const now = "2026-07-11T12:00:00.000Z";

async function createFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "tcrn-release-trust-"));
  const bundlePath = resolve(root, "bundle");
  await mkdir(bundlePath);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const artifact = Buffer.from("deterministic release artifact\n", "utf8");
  const artifactPath = resolve(bundlePath, "artifact.bin");
  await writeFile(artifactPath, artifact);
  const manifest = {
    schemaVersion: "tcrn.release-manifest.v1",
    subject: "tcrn-workflow-source",
    repository: "tcrn-workflow",
    workflow: "release",
    sequence: 7,
    issuedAt: "2026-07-11T00:00:00.000Z",
    expiresAt: "2026-07-12T00:00:00.000Z",
    signerKeyId: "release-key-1",
    artifact: {
      path: "artifact.bin",
      sha256: createHash("sha256").update(artifact).digest("hex"),
      size: artifact.length,
    },
  };
  const trustRoot = {
    schemaVersion: "tcrn.release-trust-root.v1",
    rootVersion: 3,
    validFrom: "2026-07-10T00:00:00.000Z",
    validUntil: "2026-07-13T00:00:00.000Z",
    repository: "tcrn-workflow",
    workflow: "release",
    minimumSequence: 7,
    keys: [
      {
        keyId: "release-key-1",
        algorithm: "ed25519",
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        revokedAt: null,
      },
    ],
  };
  const trustRootPath = resolve(root, "trust-root.json");
  const manifestPath = resolve(bundlePath, "manifest.json");
  const signaturePath = resolve(bundlePath, "manifest.sig");

  async function writeSignedManifest(signingKey = privateKey) {
    await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
    await writeFile(
      signaturePath,
      `${sign(null, canonicalJsonBytes(manifest), signingKey).toString("base64")}\n`,
    );
  }

  async function writeTrustRoot() {
    await writeFile(trustRootPath, `${canonicalJson(trustRoot)}\n`);
  }

  await writeSignedManifest();
  await writeTrustRoot();
  return {
    root,
    bundlePath,
    artifactPath,
    manifestPath,
    signaturePath,
    manifest,
    trustRoot,
    trustRootPath,
    writeSignedManifest,
    writeTrustRoot,
  };
}

function request(fixture, overrides = {}) {
  return {
    repositoryRoot,
    trustRootPath: fixture.trustRootPath,
    bundlePath: fixture.bundlePath,
    expectedSubject: "tcrn-workflow-source",
    expectedRepository: "tcrn-workflow",
    expectedWorkflow: "release",
    now,
    ...overrides,
  };
}

async function expectReason(fixture, reasonCode, overrides = {}) {
  await assert.rejects(
    verifyReleaseBundle(request(fixture, overrides)),
    (error) => error instanceof TrustVerificationError && error.reasonCode === reasonCode,
  );
}

test("valid external trust root admits the signed bundle", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const result = await verifyReleaseBundle(request(fixture));
  assert.deepEqual(result, {
    admitted: true,
    reasonCode: "TRUST_VERIFIED",
    rootVersion: 3,
    rootVersionRollbackDisposition: "external-prior-root-floor-required",
    sequence: 7,
    signerKeyId: "release-key-1",
    artifactSha256: fixture.manifest.artifact.sha256,
  });
});

test("candidate-controlled trust root is rejected", async (context) => {
  const fixture = await createFixture();
  const candidateRoot = resolve(repositoryRoot, "dist/test/trust-root.json");
  await mkdir(resolve(repositoryRoot, "dist/test"), { recursive: true });
  await writeFile(candidateRoot, await readFile(fixture.trustRootPath));
  context.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(resolve(repositoryRoot, "dist/test"), { recursive: true, force: true });
  });
  await expectReason(fixture, "TRUST_ROOT_CANDIDATE_CONTROLLED", { trustRootPath: candidateRoot });
});

test("forged signature is rejected", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const forged = generateKeyPairSync("ed25519");
  await fixture.writeSignedManifest(forged.privateKey);
  await expectReason(fixture, "TRUST_SIGNATURE_INVALID");
});

test("tampered artifact is rejected", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const tampered = Buffer.from(await readFile(fixture.artifactPath));
  tampered[0] ^= 1;
  await writeFile(fixture.artifactPath, tampered);
  await expectReason(fixture, "TRUST_ARTIFACT_DIGEST");
});

test("claim mismatch and rollback fail closed", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await expectReason(fixture, "TRUST_SUBJECT_MISMATCH", { expectedSubject: "wrong-subject" });
  fixture.trustRoot.minimumSequence = 8;
  await fixture.writeTrustRoot();
  await expectReason(fixture, "TRUST_SEQUENCE_ROLLBACK");
});

test("repository and workflow mismatch fail closed", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await expectReason(fixture, "TRUST_REPOSITORY_MISMATCH", { expectedRepository: "other-repository" });
  await expectReason(fixture, "TRUST_WORKFLOW_MISMATCH", { expectedWorkflow: "other-workflow" });
});

test("revoked and expired authority fail closed", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  fixture.trustRoot.keys[0].revokedAt = "2026-07-11T01:00:00.000Z";
  await fixture.writeTrustRoot();
  await expectReason(fixture, "TRUST_KEY_REVOKED");
  fixture.trustRoot.keys[0].revokedAt = null;
  await fixture.writeTrustRoot();
  await expectReason(fixture, "TRUST_ROOT_EXPIRED", { now: "2026-07-14T00:00:00.000Z" });
});

test("artifact path escape is rejected", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  fixture.manifest.artifact.path = "../outside.bin";
  await fixture.writeSignedManifest();
  await expectReason(fixture, "TRUST_ARTIFACT_PATH_ESCAPE");
});

test("symbolic and hard-linked artifacts are rejected", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const original = resolve(fixture.root, "original.bin");
  await writeFile(original, await readFile(fixture.artifactPath));
  await rm(fixture.artifactPath);
  await symlink(original, fixture.artifactPath);
  await expectReason(fixture, "TRUST_ARTIFACT_FILE");
  await rm(fixture.artifactPath);
  await link(original, fixture.artifactPath);
  await expectReason(fixture, "TRUST_ARTIFACT_HARDLINK");
});

test("trust root, manifest, and signature links fail closed", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const rootAlias = resolve(fixture.root, "trust-root-alias.json");
  await link(fixture.trustRootPath, rootAlias);
  await expectReason(fixture, "TRUST_ROOT_HARDLINK");
  await rm(rootAlias);
  const rootOriginal = resolve(fixture.root, "trust-root-original.json");
  await writeFile(rootOriginal, await readFile(fixture.trustRootPath));
  await rm(fixture.trustRootPath);
  await symlink(rootOriginal, fixture.trustRootPath);
  await expectReason(fixture, "TRUST_ROOT_FILE");
  await rm(fixture.trustRootPath);
  await writeFile(fixture.trustRootPath, await readFile(rootOriginal));

  const manifestAlias = resolve(fixture.root, "manifest-alias.json");
  await link(fixture.manifestPath, manifestAlias);
  await expectReason(fixture, "TRUST_MANIFEST_HARDLINK");
  await rm(manifestAlias);
  const manifestOriginal = resolve(fixture.root, "manifest-original.json");
  await writeFile(manifestOriginal, await readFile(fixture.manifestPath));
  await rm(fixture.manifestPath);
  await symlink(manifestOriginal, fixture.manifestPath);
  await expectReason(fixture, "TRUST_MANIFEST_FILE");
  await rm(fixture.manifestPath);
  await writeFile(fixture.manifestPath, await readFile(manifestOriginal));

  const signatureAlias = resolve(fixture.root, "signature-alias.txt");
  await link(fixture.signaturePath, signatureAlias);
  await expectReason(fixture, "TRUST_SIGNATURE_HARDLINK");
  await rm(signatureAlias);
  const signatureOriginal = resolve(fixture.root, "signature-original.txt");
  await writeFile(signatureOriginal, await readFile(fixture.signaturePath));
  await rm(fixture.signaturePath);
  await symlink(signatureOriginal, fixture.signaturePath);
  await expectReason(fixture, "TRUST_SIGNATURE_FILE");
});

test("bundle directory symlink fails closed", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const alias = resolve(fixture.root, "bundle-alias");
  await symlink(fixture.bundlePath, alias);
  await expectReason(fixture, "TRUST_BUNDLE_SYMLINK", { bundlePath: alias });
});

test("strict RFC 3339 rejects normalization and impossible instants", () => {
  assert.equal(
    strictRfc3339Instant("2026-07-11T12:00:00.123456789+08:00", "TIME", "value"),
    strictRfc3339Instant("2026-07-11T04:00:00.123456789Z", "TIME", "value"),
  );
  for (const value of [
    "2026-07-11",
    "July 11, 2026 12:00:00",
    "2026-02-30T00:00:00Z",
    "2026-07-11T24:00:00Z",
    "2026-07-11T12:00:60Z",
    "2026-07-11t12:00:00z",
    "2026-07-11T12:00:00",
    "2026-07-11T12:00:00.1234567890Z",
  ]) {
    assert.throws(() => strictRfc3339Instant(value, "TIME", "value"), (error) => error.reasonCode === "TIME");
  }
});

test("verification, root, and manifest time vectors fail closed", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await expectReason(fixture, "TRUST_TIME_INVALID", { now: "2026-07-11" });
  await expectReason(fixture, "TRUST_ROOT_NOT_YET_VALID", { now: "2026-07-09T00:00:00Z" });
  fixture.manifest.issuedAt = "2026-07-11T13:00:00Z";
  await fixture.writeSignedManifest();
  await expectReason(fixture, "TRUST_MANIFEST_NOT_YET_VALID");
  fixture.manifest.issuedAt = "2026-07-10T00:00:00Z";
  fixture.manifest.expiresAt = "2026-07-11T01:00:00Z";
  await fixture.writeSignedManifest();
  await expectReason(fixture, "TRUST_MANIFEST_EXPIRED");
  fixture.trustRoot.validFrom = "not-a-date";
  await fixture.writeTrustRoot();
  await expectReason(fixture, "TRUST_ROOT_TIME_INVALID");
});

test("canonical JSON and strict schemas fail closed", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(fixture.trustRootPath, `${JSON.stringify(fixture.trustRoot, null, 2)}\n`);
  await expectReason(fixture, "TRUST_ROOT_CANONICAL_JSON");
  await fixture.writeTrustRoot();
  await writeFile(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`);
  await expectReason(fixture, "TRUST_MANIFEST_CANONICAL_JSON");
  fixture.manifest.unexpected = true;
  await fixture.writeSignedManifest();
  await expectReason(fixture, "TRUST_MANIFEST_MALFORMED");
  delete fixture.manifest.unexpected;
  fixture.trustRoot.unexpected = true;
  await fixture.writeTrustRoot();
  await fixture.writeSignedManifest();
  await expectReason(fixture, "TRUST_ROOT_MALFORMED");
  delete fixture.trustRoot.unexpected;
  fixture.trustRoot.schemaVersion = "unknown";
  await fixture.writeTrustRoot();
  await expectReason(fixture, "TRUST_ROOT_SCHEMA");
});

test("release-trust canonical JSON rejects malformed Unicode before claim or signature evaluation", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const canonicalManifest = await readFile(fixture.manifestPath, "utf8");
  for (const escaped of ["\\ud800", "\\udfff"]) {
    await writeFile(
      fixture.manifestPath,
      canonicalManifest.replace('"subject":"tcrn-workflow-source"', `"subject":"bad${escaped}"`),
    );
    await expectReason(fixture, "TRUST_MANIFEST_CANONICAL_JSON");
    await writeFile(
      fixture.manifestPath,
      canonicalManifest.replace(/"artifact":\{[^}]+\}/u, `"artifact":{"key-${escaped}":1}`),
    );
    await expectReason(fixture, "TRUST_MANIFEST_CANONICAL_JSON");
  }
});

test("release-trust canonical parsing uses UTF-8 order for integer-like keys", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const canonicalManifest = await readFile(fixture.manifestPath, "utf8");
  await writeFile(fixture.manifestPath, `{"2":2,"10":1,${canonicalManifest.slice(1)}`);
  await expectReason(fixture, "TRUST_MANIFEST_CANONICAL_JSON");
  await writeFile(fixture.manifestPath, `{"10":1,"2":2,${canonicalManifest.slice(1)}`);
  await expectReason(fixture, "TRUST_MANIFEST_MALFORMED");
});

test("unknown and invalid signing keys fail closed", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  fixture.manifest.signerKeyId = "unknown-key";
  await fixture.writeSignedManifest();
  await expectReason(fixture, "TRUST_KEY_UNKNOWN");
  fixture.manifest.signerKeyId = "release-key-1";
  fixture.trustRoot.keys[0].publicKeyPem = "not-a-public-key";
  await fixture.writeTrustRoot();
  await fixture.writeSignedManifest();
  await expectReason(fixture, "TRUST_KEY_INVALID");
});

test("canonical base64 and Ed25519 length are enforced", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const canonical = (await readFile(fixture.signaturePath, "utf8")).trim();
  await writeFile(fixture.signaturePath, `${canonical.replace(/=+$/u, "")}\n`);
  await expectReason(fixture, "TRUST_SIGNATURE_ENCODING");
  await writeFile(fixture.signaturePath, `${Buffer.alloc(63).toString("base64")}\n`);
  await expectReason(fixture, "TRUST_SIGNATURE_LENGTH");
  await writeFile(fixture.signaturePath, "!!!!\n");
  await expectReason(fixture, "TRUST_SIGNATURE_ENCODING");
});

test("artifact size and non-canonical paths fail closed", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  fixture.manifest.artifact.size += 1;
  await fixture.writeSignedManifest();
  await expectReason(fixture, "TRUST_ARTIFACT_SIZE");
  fixture.manifest.artifact.size -= 1;
  for (const [path, reasonCode] of [
    ["/absolute.bin", "TRUST_ARTIFACT_PATH"],
    ["folder\\artifact.bin", "TRUST_ARTIFACT_PATH"],
    ["folder/../artifact.bin", "TRUST_ARTIFACT_PATH"],
    [".", "TRUST_ARTIFACT_PATH_ESCAPE"],
  ]) {
    fixture.manifest.artifact.path = path;
    await fixture.writeSignedManifest();
    await expectReason(fixture, reasonCode);
  }
});

test("CLI rejects missing, duplicate, and unknown arguments", () => {
  const cli = resolve(repositoryRoot, "scripts/verify-release-trust.mjs");
  const cases = [
    [[], "TRUST_ARGUMENTS_REQUIRED"],
    [["--now", now, "--now", now], "TRUST_ARGUMENTS_INVALID"],
    [["--unknown", "value"], "TRUST_ARGUMENT_UNKNOWN"],
  ];
  for (const [arguments_, reasonCode] of cases) {
    const result = spawnSync(process.execPath, [cli, ...arguments_], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).reasonCode, reasonCode);
  }
});

// OD-16 F7. Two strict RFC 3339 parsers exist and neither is going away: the protocol
// package's `parseStrictInstant` (integer civil arithmetic, used by the product) and
// this module's `strictRfc3339Instant` (Date arithmetic, reachable from the published
// `tcrn-workflow-release-verify` bin, which must run with no build step). The 2026-07-18
// audit recorded them as "equivalent today, will drift on the next edit" and nothing was
// checking that. This corpus is the check: one grammar, two implementations, and any edit
// that moves one and not the other turns it red.
//
// The helper repository's `cliNow` is deliberately NOT in scope. It accepts a narrower
// grammar on purpose -- Z only, exactly three fractional digits -- and pinning it to this
// corpus would convert a designed restriction into a reported defect.
test("both strict RFC 3339 implementations accept and reject exactly the same grammar", async () => {
  const { parseStrictInstant } = await import("../dist/build/packages/protocol/src/index.js");

  const accepted = [
    "2026-07-11T12:00:00Z",
    "2026-07-11T12:00:00.1Z",
    "2026-07-11T12:00:00.123Z",
    "2026-07-11T12:00:00.123456789Z",
    "2026-07-11T12:00:00+08:00",
    "2026-07-11T12:00:00-05:30",
    "2026-07-11T12:00:00.5+00:00",
    "2024-02-29T00:00:00Z",
    "2000-02-29T23:59:59Z",
    "1970-01-01T00:00:00Z",
    "2026-12-31T23:59:59.999999999-12:00",
  ];
  const rejected = [
    "2026-07-11",
    "July 11, 2026 12:00:00",
    "2026-02-30T00:00:00Z",
    "2023-02-29T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-07-00T00:00:00Z",
    "2026-07-11T24:00:00Z",
    "2026-07-11T12:60:00Z",
    "2026-07-11T12:00:60Z",
    "2026-07-11t12:00:00z",
    "2026-07-11T12:00:00",
    "2026-07-11T12:00:00.1234567890Z",
    "2026-07-11T12:00:00.Z",
    "2026-07-11T12:00:00+24:00",
    "2026-07-11T12:00:00+08:60",
    "2026-07-11T12:00:00 Z",
    " 2026-07-11T12:00:00Z",
    "",
  ];

  const admits = (parse, value) => {
    try { parse(value); return true; } catch { return false; }
  };

  for (const value of accepted) {
    assert.equal(admits((v) => strictRfc3339Instant(v, "TIME", "value"), value), true, `release-trust must accept ${value}`);
    assert.equal(admits(parseStrictInstant, value), true, `protocol must accept ${value}`);
    // Agreeing on admission is not enough: they must agree on the instant itself, or a
    // receipt verified by one and produced by the other silently disagrees about when.
    assert.equal(
      strictRfc3339Instant(value, "TIME", "value"),
      parseStrictInstant(value),
      `both implementations must derive the same nanoseconds for ${value}`,
    );
  }
  for (const value of rejected) {
    assert.equal(admits((v) => strictRfc3339Instant(v, "TIME", "value"), value), false, `release-trust must reject ${value}`);
    assert.equal(admits(parseStrictInstant, value), false, `protocol must reject ${value}`);
  }

  // Non-strings are refused by both rather than coerced.
  for (const value of [null, undefined, 42, {}, [], new Date()]) {
    assert.equal(admits((v) => strictRfc3339Instant(v, "TIME", "value"), value), false);
    assert.equal(admits(parseStrictInstant, value), false);
  }
});
