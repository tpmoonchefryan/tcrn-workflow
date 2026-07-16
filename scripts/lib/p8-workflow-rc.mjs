// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { canonicalJson } from "./canonical-json.mjs";
import { compareCanonicalText } from "./canonical-order.mjs";
import { readBoundRegularFile } from "./safe-io.mjs";

export const P8_VERSION = "0.1.0-rc.4";
export const P8_TAG = "v0.1.0-rc.4";
export const P8_REPOSITORY = "tcrn-workflow";
export const P8_WORKFLOW = "release";
export const P8_SUPPORTED_AOS_RELEASES = Object.freeze([]);
export const P8_RELEASE_ARTIFACTS = Object.freeze([
  `tcrn-workflow-${P8_VERSION}-source.tar`,
  "sbom.cdx.json",
  "release-manifest.json",
  "provenance.json",
  "checksums.txt",
  "release-notes.md",
]);

export class P8ReleaseError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "P8ReleaseError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, message) {
  throw new P8ReleaseError(reasonCode, message);
}

function assertion(condition, reasonCode, message) {
  if (!condition) fail(reasonCode, message ?? reasonCode);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function posix(value) {
  return value.split(sep).join("/");
}

function safePath(path) {
  assertion(typeof path === "string" && path.length > 0 && path.length <= 255, "P8_RELEASE_PATH_INVALID", String(path));
  assertion(!path.startsWith("/") && !path.includes("\\"), "P8_RELEASE_PATH_INVALID", path);
  const parts = path.split("/");
  assertion(parts.every((part) => part !== "" && part !== "." && part !== ".."), "P8_RELEASE_PATH_INVALID", path);
  return path;
}

function fixedMode(path, bytes) {
  return bytes.subarray(0, 2).toString("utf8") === "#!" ? 0o755 : 0o644;
}

function tarField(target, offset, size, value) {
  const bytes = Buffer.from(value, "utf8");
  assertion(bytes.length <= size, "P8_RELEASE_TAR_FIELD", value);
  bytes.copy(target, offset);
}

function tarOctal(value, size) {
  return `${value.toString(8).padStart(size - 1, "0")}\0`;
}

function tarEntry(record) {
  const header = Buffer.alloc(512, 0);
  tarField(header, 0, 100, record.path);
  tarField(header, 100, 8, tarOctal(record.mode, 8));
  tarField(header, 108, 8, tarOctal(0, 8));
  tarField(header, 116, 8, tarOctal(0, 8));
  tarField(header, 124, 12, tarOctal(record.bytes.length, 12));
  tarField(header, 136, 12, tarOctal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  tarField(header, 257, 6, "ustar\0");
  tarField(header, 263, 2, "00");
  tarField(header, 265, 32, "root");
  tarField(header, 297, 32, "root");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  tarField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (record.bytes.length % 512)) % 512, 0);
  return Buffer.concat([header, record.bytes, padding]);
}

export function buildCanonicalUstar(records) {
  assertion(Array.isArray(records) && records.length > 0, "P8_RELEASE_RECORDS_EMPTY");
  const normalized = records.map((record) => {
    assertion(record && Buffer.isBuffer(record.bytes), "P8_RELEASE_RECORD_INVALID");
    const path = safePath(record.path);
    assertion(record.mode === 0o644 || record.mode === 0o755, "P8_RELEASE_MODE_INVALID", path);
    return { path, bytes: Buffer.from(record.bytes), mode: record.mode };
  }).sort((left, right) => compareCanonicalText(left.path, right.path));
  assertion(new Set(normalized.map((record) => record.path)).size === normalized.length, "P8_RELEASE_DUPLICATE_PATH");
  return Buffer.concat([...normalized.map(tarEntry), Buffer.alloc(1024, 0)]);
}

export function buildDeterministicSourceArchive(records) {
  assertion(Array.isArray(records) && records.length > 0, "P8_ARCHIVE_RECORDS_INVALID");
  for (const record of records) {
    assertion(record && Buffer.isBuffer(record.content) && typeof record.executable === "boolean", "P8_ARCHIVE_RECORD_INVALID");
    assertion(record.singleLink === true, "P8_ARCHIVE_LINK_INVALID", record.path ?? "unknown");
  }
  return buildCanonicalUstar(records.map((record) => ({
    path: record.path,
    bytes: record.content,
    mode: record.executable ? 0o755 : 0o644,
  })));
}

export async function releaseSourceRecords(repositoryRoot, allowedFiles) {
  assertion(Array.isArray(allowedFiles) && allowedFiles.length > 0, "P8_RELEASE_ALLOWLIST_INVALID");
  const root = resolve(repositoryRoot);
  const paths = [...allowedFiles].map(safePath).sort(compareCanonicalText);
  assertion(new Set(paths).size === paths.length, "P8_RELEASE_ALLOWLIST_DUPLICATE");
  const records = [];
  for (const path of paths) {
    const absolute = resolve(root, path);
    assertion(posix(relative(root, absolute)) === path, "P8_RELEASE_PATH_ESCAPE", path);
    const source = await readBoundRegularFile(absolute, {
      reasonCode: "P8_RELEASE_SOURCE_INVALID",
      hardlinkReasonCode: "P8_RELEASE_SOURCE_HARDLINK",
      pathChangedReasonCode: "P8_RELEASE_SOURCE_CHANGED",
    });
    records.push({ path, bytes: source.content, mode: fixedMode(path, source.content) });
  }
  return records;
}

function orderedRecordPaths(records) {
  return records.map((record) => record.path).sort(compareCanonicalText);
}

async function materializeSourceRecords(root, records) {
  for (const record of records) {
    const target = resolve(root, safePath(record.path));
    assertion(posix(relative(root, target)) === record.path, "P8_RELEASE_PATH_ESCAPE", record.path);
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, record.bytes, { mode: record.mode });
  }
}

export async function rebuildP8SourceArchiveInIndependentRoots({ repositoryRoot, allowedFiles }) {
  const basisRecords = await releaseSourceRecords(repositoryRoot, allowedFiles);
  const expectedPaths = orderedRecordPaths(basisRecords);
  const stagingBase = await realpath(await mkdtemp(join(tmpdir(), "tcrn-p8-source-basis-")));
  const roots = [];
  try {
    for (const name of ["first", "second"]) {
      const root = resolve(stagingBase, name);
      await mkdir(root, { mode: 0o700 });
      await materializeSourceRecords(root, basisRecords);
      roots.push(root);
    }
    const rebuilt = [];
    for (const root of roots) {
      const records = await releaseSourceRecords(root, allowedFiles);
      const orderedPaths = orderedRecordPaths(records);
      assertion(JSON.stringify(orderedPaths) === JSON.stringify(expectedPaths), "P8_ARCHIVE_REPRODUCIBILITY_PATHS");
      rebuilt.push({ root, orderedPaths, archive: buildCanonicalUstar(records) });
    }
    assertion(rebuilt[0].archive.equals(rebuilt[1].archive), "P8_ARCHIVE_REPRODUCIBILITY_MISMATCH");
    return {
      sourceFiles: expectedPaths.length,
      orderedEntries: expectedPaths,
      archive: rebuilt[0].archive,
      sha256: sha256(rebuilt[0].archive),
      rootsIndependent: true,
    };
  } finally {
    await rm(stagingBase, { recursive: true, force: true });
  }
}

export async function assertP8Versions(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const manifests = ["package.json", "packages/core/package.json", "packages/cli/package.json", "packages/protocol/package.json"];
  const versions = await Promise.all(manifests.map(async (path) => {
    const value = JSON.parse((await readFile(resolve(root, path), "utf8")));
    return { path, version: value.version };
  }));
  assertion(versions.every((entry) => entry.version === P8_VERSION), "P8_VERSION_MISMATCH", JSON.stringify(versions));
  const coreIndex = await readFile(resolve(root, "packages/core/src/index.ts"), "utf8");
  assertion(coreIndex.includes(`FRAMEWORK_VERSION = \"${P8_VERSION}\"`), "P8_FRAMEWORK_VERSION_MISMATCH");
  return versions;
}

function documentRecord(path, bytes) {
  return { path, size: bytes.length, sha256: sha256(bytes) };
}

export async function buildP8ReleaseDocuments({ repositoryRoot, allowedFiles }) {
  await assertP8Versions(repositoryRoot);
  const archive = buildCanonicalUstar(await releaseSourceRecords(repositoryRoot, allowedFiles));
  const sourcePath = P8_RELEASE_ARTIFACTS[0];
  const sbom = Buffer.from(`${JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", serialNumber: `urn:uuid:${sha256(archive).slice(0, 8)}-${sha256(archive).slice(8, 12)}-4000-8000-${sha256(archive).slice(12, 24)}`, version: 1, metadata: { component: { type: "application", name: P8_REPOSITORY, version: P8_VERSION }, properties: [{ name: "tcrn:supported-aos-releases", value: "[]" }] }, components: [] }, null, 2)}\n`, "utf8");
  const notes = Buffer.from(`# TCRN Workflow ${P8_VERSION}\n\nThis is an immutable unpublished local release candidate. It supports no AOS releases, performs no publication, and is not a supported release.\n`, "utf8");
  const manifestBasis = {
    schemaVersion: "tcrn.workflow-release-candidate-manifest.v1",
    repository: P8_REPOSITORY,
    workflow: P8_WORKFLOW,
    version: P8_VERSION,
    tag: P8_TAG,
    releaseStatus: "unpublished_candidate",
    supportedAosReleases: P8_SUPPORTED_AOS_RELEASES,
    artifacts: [documentRecord(sourcePath, archive), documentRecord("sbom.cdx.json", sbom), documentRecord("release-notes.md", notes)],
  };
  const manifest = Buffer.from(`${canonicalJson({ ...manifestBasis, manifestDigest: sha256(Buffer.from(canonicalJson(manifestBasis), "utf8")) })}\n`, "utf8");
  const provenanceBasis = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [documentRecord(sourcePath, archive)],
    predicate: {
      buildType: "tcrn.workflow.local-unpublished-candidate.v1",
      buildDefinition: { externalParameters: { version: P8_VERSION, tag: P8_TAG, supportedAosReleases: P8_SUPPORTED_AOS_RELEASES }, resolvedDependencies: [documentRecord("release-manifest.json", manifest)] },
      runDetails: { builder: { id: "tcrn-workflow-local" }, metadata: { invocationId: sha256(manifest), startedOn: "1970-01-01T00:00:00.000Z", finishedOn: "1970-01-01T00:00:00.000Z" } },
    },
  };
  const provenance = Buffer.from(`${canonicalJson(provenanceBasis)}\n`, "utf8");
  const checksummed = [
    documentRecord(sourcePath, archive),
    documentRecord("sbom.cdx.json", sbom),
    documentRecord("release-manifest.json", manifest),
    documentRecord("provenance.json", provenance),
    documentRecord("release-notes.md", notes),
  ].sort((left, right) => compareCanonicalText(left.path, right.path));
  const checksums = Buffer.from(checksummed.map((record) => `${record.sha256}  ${record.path}`).join("\n") + "\n", "utf8");
  const documents = new Map([
    [sourcePath, archive], ["sbom.cdx.json", sbom], ["release-manifest.json", manifest], ["provenance.json", provenance], ["checksums.txt", checksums], ["release-notes.md", notes],
  ]);
  validateP8ReleaseDocuments(documents);
  return { documents, sourceArchiveSha256: sha256(archive), manifestDigest: sha256(manifest), provenanceDigest: sha256(provenance) };
}

export function validateP8ReleaseDocuments(documents) {
  assertion(documents instanceof Map && documents.size === P8_RELEASE_ARTIFACTS.length, "P8_RELEASE_DOCUMENT_SET");
  assertion(JSON.stringify([...documents.keys()].sort(compareCanonicalText)) === JSON.stringify([...P8_RELEASE_ARTIFACTS].sort(compareCanonicalText)), "P8_RELEASE_DOCUMENT_SET");
  for (const path of P8_RELEASE_ARTIFACTS) assertion(Buffer.isBuffer(documents.get(path)), "P8_RELEASE_DOCUMENT_INVALID", path);
  const manifest = JSON.parse(documents.get("release-manifest.json").toString("utf8"));
  assertion(manifest.schemaVersion === "tcrn.workflow-release-candidate-manifest.v1" && manifest.repository === P8_REPOSITORY && manifest.workflow === P8_WORKFLOW && manifest.version === P8_VERSION && manifest.tag === P8_TAG && manifest.releaseStatus === "unpublished_candidate" && JSON.stringify(manifest.supportedAosReleases) === "[]", "P8_RELEASE_MANIFEST_INVALID");
  const manifestBasis = { ...manifest };
  delete manifestBasis.manifestDigest;
  assertion(manifest.manifestDigest === sha256(Buffer.from(canonicalJson(manifestBasis), "utf8")), "P8_RELEASE_MANIFEST_DIGEST");
  const expected = new Map([...documents].filter(([path]) => path !== "checksums.txt").map(([path, bytes]) => [path, sha256(bytes)]));
  const lines = documents.get("checksums.txt").toString("utf8").trim().split("\n").filter(Boolean);
  assertion(lines.length === expected.size, "P8_RELEASE_CHECKSUMS_INVALID");
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  ([^\s]+)$/u);
    assertion(match, "P8_RELEASE_CHECKSUMS_INVALID", line);
    assertion(expected.get(match[2]) === match[1], "P8_RELEASE_CHECKSUM_MISMATCH", match[2]);
  }
  const provenance = JSON.parse(documents.get("provenance.json").toString("utf8"));
  assertion(provenance?._type === "https://in-toto.io/Statement/v1" && provenance?.predicateType === "https://slsa.dev/provenance/v1" && provenance?.predicate?.buildDefinition?.externalParameters?.version === P8_VERSION, "P8_RELEASE_PROVENANCE_INVALID");
  return { releaseStatus: "unpublished_candidate", supportedAosReleases: [], artifactCount: documents.size };
}

export function buildP8ReleaseArtifacts({ sourceArchive, sbom }) {
  assertion(Buffer.isBuffer(sourceArchive) && Buffer.isBuffer(sbom), "P8_RELEASE_DOCUMENT_INVALID");
  const sourcePath = P8_RELEASE_ARTIFACTS[0];
  const notes = Buffer.from(`# TCRN Workflow ${P8_VERSION}\n\nThis is an immutable unpublished local release candidate. It supports no AOS releases, performs no publication, and is not a supported release.\n`, "utf8");
  const manifestBasis = {
    schemaVersion: "tcrn.workflow-release-candidate-manifest.v1",
    repository: P8_REPOSITORY,
    workflow: P8_WORKFLOW,
    version: P8_VERSION,
    tag: P8_TAG,
    releaseStatus: "unpublished_candidate",
    supportedAosReleases: P8_SUPPORTED_AOS_RELEASES,
    artifacts: [documentRecord(sourcePath, sourceArchive), documentRecord("sbom.cdx.json", sbom), documentRecord("release-notes.md", notes)],
  };
  const manifest = Buffer.from(`${canonicalJson({ ...manifestBasis, manifestDigest: sha256(Buffer.from(canonicalJson(manifestBasis), "utf8")) })}\n`, "utf8");
  const provenance = Buffer.from(`${canonicalJson({
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [documentRecord(sourcePath, sourceArchive)],
    predicate: {
      buildType: "tcrn.workflow.local-unpublished-candidate.v1",
      buildDefinition: { externalParameters: { version: P8_VERSION, tag: P8_TAG, supportedAosReleases: P8_SUPPORTED_AOS_RELEASES }, resolvedDependencies: [documentRecord("release-manifest.json", manifest)] },
      runDetails: { builder: { id: "tcrn-workflow-local" }, metadata: { invocationId: sha256(manifest), startedOn: "1970-01-01T00:00:00.000Z", finishedOn: "1970-01-01T00:00:00.000Z" } },
    },
  })}\n`, "utf8");
  const checksums = Buffer.from([
    documentRecord(sourcePath, sourceArchive), documentRecord("sbom.cdx.json", sbom), documentRecord("release-manifest.json", manifest), documentRecord("provenance.json", provenance), documentRecord("release-notes.md", notes),
  ].sort((left, right) => compareCanonicalText(left.path, right.path)).map((record) => `${record.sha256}  ${record.path}`).join("\n") + "\n", "utf8");
  const artifacts = new Map([
    [sourcePath, sourceArchive], ["sbom.cdx.json", sbom], ["release-manifest.json", manifest], ["provenance.json", provenance], ["checksums.txt", checksums], ["release-notes.md", notes],
  ]);
  validateP8ReleaseDocuments(artifacts);
  return artifacts;
}

export function p8ArtifactRecords(artifacts) {
  validateP8ReleaseDocuments(artifacts);
  return [...artifacts.entries()].map(([path, bytes]) => documentRecord(`dist/release/${path}`, bytes)).sort((left, right) => compareCanonicalText(left.path, right.path));
}

export function assertClosedReleaseArtifactAllowlist(artifacts) {
  assertion(artifacts instanceof Map, "P8_RELEASE_ALLOWLIST_MISMATCH");
  const actual = [...artifacts.keys()].sort(compareCanonicalText);
  const expected = [...P8_RELEASE_ARTIFACTS].sort(compareCanonicalText);
  assertion(JSON.stringify(actual) === JSON.stringify(expected), "P8_RELEASE_ALLOWLIST_MISMATCH");
  return actual;
}

export function sanitizedCoreReferenceProjection(bundle) {
  assertion(bundle && Array.isArray(bundle.profiles) && bundle.profiles.length === 8, "P8_SANITIZED_CORE_INVALID");
  const profiles = bundle.profiles.map((profile) => {
    const allowed = ["profileId", "displayName", "jobTitle", "mission", "profileDigest"];
    const projection = Object.fromEntries(allowed.map((field) => [field, profile[field]]));
    assertion(Object.values(projection).every((value) => typeof value === "string" && value.length > 0), "P8_SANITIZED_CORE_INVALID");
    return projection;
  }).sort((left, right) => compareCanonicalText(left.profileId, right.profileId));
  const output = { schemaVersion: "tcrn.p8-sanitized-core-reference.v1", bundleIdentity: bundle.bundleDigest, profiles };
  const text = canonicalJson(profiles);
  assertion(!/(?:\.context|legacy|transcript|credential|\/Users\/|AOS)/iu.test(text), "P8_SANITIZED_CORE_PRIVATE_CONTENT");
  return output;
}

export function sanitizeCoreReference(profiles) {
  assertion(Array.isArray(profiles) && profiles.length === 8, "P8_CORE_REFERENCE_COUNT");
  const expectedFields = ["displayName", "jobTitle", "mission", "profileDigest", "profileId"];
  const projected = profiles.map((profile) => {
    assertion(profile && typeof profile === "object" && !Array.isArray(profile), "P8_CORE_REFERENCE_FIELDS");
    assertion(JSON.stringify(Object.keys(profile).sort(compareCanonicalText)) === JSON.stringify(expectedFields), "P8_CORE_REFERENCE_FIELDS");
    assertion(expectedFields.every((field) => typeof profile[field] === "string" && profile[field].length > 0), "P8_CORE_REFERENCE_FIELDS");
    return Object.fromEntries(expectedFields.map((field) => [field, profile[field]]));
  }).sort((left, right) => compareCanonicalText(left.profileId, right.profileId));
  assertion(new Set(projected.map((profile) => profile.profileId)).size === 8, "P8_CORE_REFERENCE_DUPLICATE");
  const output = {
    schemaVersion: "tcrn.p8-sanitized-core-reference.v1",
    profiles: projected,
    supportedAosReleases: P8_SUPPORTED_AOS_RELEASES,
  };
  const text = canonicalJson(projected);
  assertion(!/(?:\.context|legacy|transcript|credential|\/Users\/|AOS)/iu.test(text), "P8_CORE_REFERENCE_PRIVATE_CONTENT");
  return { ...output, bundleIdentity: sha256(Buffer.from(text, "utf8")) };
}
