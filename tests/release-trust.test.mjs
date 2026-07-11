// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { canonicalJsonBytes } from "../scripts/lib/canonical-json.mjs";
import {
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

  async function writeSignedManifest(signingKey = privateKey) {
    await writeFile(resolve(bundlePath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      resolve(bundlePath, "manifest.sig"),
      `${sign(null, canonicalJsonBytes(manifest), signingKey).toString("base64")}\n`,
    );
  }

  async function writeTrustRoot() {
    await writeFile(trustRootPath, `${JSON.stringify(trustRoot, null, 2)}\n`);
  }

  await writeSignedManifest();
  await writeTrustRoot();
  return {
    root,
    bundlePath,
    artifactPath,
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
