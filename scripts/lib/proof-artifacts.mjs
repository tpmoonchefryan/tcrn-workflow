// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalDocumentBytes } from "./canonical-json.mjs";
import { compareCanonicalText } from "./canonical-order.mjs";
import { fileRecord, readSourceFile, repositoryRoot, toPosixPath, walkFiles } from "./files.mjs";
import { readBoundRegularFile } from "./safe-io.mjs";

const generatedPaths = [
  "scripts/policy/source-allowlist.json",
  "verification-map.yaml",
  "fixtures/rc1/rc1-candidate-proof-manifest.json",
];
const routeAdditions = new Set([
  "scripts/generate-proof-artifacts.mjs",
  "scripts/dependency-materialization.mjs",
  "scripts/lib/dependency-materialization.mjs",
  "scripts/lib/local-command.mjs",
  "scripts/lib/proof-artifacts.mjs",
  "scripts/lib/p8-workflow-rc.mjs",
  "docs/releases/0.1.0-rc.2.md",
  "docs/releases/0.1.0-rc.3.md",
  "docs/releases/0.1.0-rc.4.md",
  "docs/releases/0.1.0-rc.5.md",
  "scripts/lib/scoped-strip-types.mjs",
  "scripts/test-controller-bootstrap.mjs",
  "scripts/test-controller-child-policy.mjs",
  "scripts/test-controller-reaper.mjs",
  "tests/output-session-lifecycle.test.mjs",
  "tests/dependency-materialization.test.mjs",
  "tests/local-command-byte-fidelity.test.mjs",
  "tests/proof-artifact-generator.test.mjs",
  "tests/p8-workflow-rc.test.mjs",
  "tests/ci-bootstrap.test.mjs",
  "scripts/regen-rc1-inputs.mjs",
  "scripts/lib/rc1-inputs.mjs",
  "tests/regen-rc1-inputs.test.mjs",
  "docs/hardening/rc1-map-regeneration.md",
  "docs/activation/activation-ladder-v1.md",
  "docs/adr/0002-snapshot-not-mirror-backup.md",
  "packages/core/src/actor-attestation.ts",
  "tests/actor-attestation.test.mjs",
  "tests/p3-cli-read-surface.test.mjs",
  "tests/p3-cli-catalog.test.mjs",
  "packages/core/src/workspace-perf-instrumentation.ts",
  "tests/p3-engine-complexity.test.mjs",
  "tests/workspace-extension-records.test.mjs",
  "packages/core/src/workspace-snapshot.ts",
  "packages/core/schema/workspace-snapshot-manifest-v1.schema.json",
  "tests/backup-snapshot.test.mjs",
  "docs/architecture/backup-git-tier.md",
  "docs/architecture/backup-restore-runbook.md",
  "docs/architecture/agent-integration-v1.md",
  "docs/architecture/rc5-compatibility.md",
  "packages/core/src/claude-adapter-installer.ts",
  "tests/act1-claude-installer.test.mjs",
  "packages/core/src/claude-adapter-activation.ts",
  "packages/core/src/claude-adapter-session-start.ts",
  "tests/act2-claude-activation.test.mjs",
  "packages/core/src/persona-render.ts",
  "tests/act3-persona-render.test.mjs",
  "docs/2026-07-17-p3-compaction-deferral-decision.md",
  "docs/tutorial/governed-loop.md",
  "tests/e2e-governed-loop-commands.mjs",
  "tests/e2e-governed-loop.test.mjs",
  "packages/core/src/authority-file-reader.ts",
]);
const claimFields = [
  "id", "phase", "category", "status", "subject", "command", "fixturePaths", "fixtureDigest", "environment", "expectedExit", "expectedReasonCode", "evidencePath", "invalidationTriggers",
];
const claimCategories = ["framework-hygiene", "inertness-proof", "runtime-capability"];
const manifestFields = ["schemaVersion", "status", "accepted", "basisDigest", "inputs", "roleVerdictSlots"];
const roleNames = ["platform-workflow-architect", "workflow-verification-engineer", "security-risk-reviewer", "reality-checker"];
const claimRouteAdditions = new Map([
  ["P1-CLEAN-HISTORY", ["scripts/lib/local-command.mjs", "tests/local-command-byte-fidelity.test.mjs"]],
  ["P1-NO-PRIVATE-MIGRATION", ["scripts/lib/local-command.mjs", "tests/local-command-byte-fidelity.test.mjs"]],
  ["P8-WORKFLOW-RC", ["scripts/lib/local-command.mjs", "scripts/lib/privacy.mjs", "tests/local-command-byte-fidelity.test.mjs"]],
]);
const stagePrefix = ".tcrn-proof-artifact-";
let sequence = 0;

export class ProofArtifactError extends Error {
  constructor(reasonCode, detail) {
    super(detail);
    this.name = "ProofArtifactError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, detail) {
  throw new ProofArtifactError(reasonCode, detail);
}

function assert(condition, reasonCode, detail) {
  if (!condition) fail(reasonCode, detail);
}

function exactKeys(value, fields, reasonCode, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), reasonCode, label);
  assert(JSON.stringify(Object.keys(value)) === JSON.stringify(fields), reasonCode, label);
}

function safePath(value, reasonCode = "PROOF_ARTIFACT_PATH_INVALID") {
  assert(typeof value === "string" && value.length > 0 && value.isWellFormed(), reasonCode, String(value));
  assert(!isAbsolute(value) && !value.includes("\\"), reasonCode, value);
  const parts = value.split("/");
  assert(parts.every((part) => part !== "" && part !== "." && part !== ".."), reasonCode, value);
  return value;
}

function pathInRoot(root, path, reasonCode = "PROOF_ARTIFACT_PATH_INVALID") {
  const normalized = safePath(path, reasonCode);
  const candidate = resolve(root, normalized);
  const relation = relative(root, candidate);
  assert(relation !== "" && !relation.startsWith("..") && !relation.startsWith(sep), reasonCode, path);
  return candidate;
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJsonBound(root, path, reasonCode) {
  const absolute = pathInRoot(root, path, reasonCode);
  const opened = await readBoundRegularFile(absolute, {
    reasonCode,
    hardlinkReasonCode: "PROOF_ARTIFACT_SOURCE_HARDLINK",
    pathChangedReasonCode: "PROOF_ARTIFACT_SOURCE_REPLACED",
  });
  let value;
  try { value = JSON.parse(opened.content.toString("utf8")); } catch { fail(reasonCode, path); }
  return { value, bytes: opened.content, metadata: opened.metadata };
}

async function record(root, path, virtual = new Map()) {
  if (virtual.has(path)) {
    const bytes = virtual.get(path);
    return { path, size: bytes.length, sha256: sha256(bytes) };
  }
  const absolute = pathInRoot(root, path, "PROOF_ARTIFACT_PATH_INVALID");
  try {
    return await fileRecord(absolute, root);
  } catch (error) {
    if (error?.reasonCode) throw error;
    fail("PROOF_ARTIFACT_SOURCE_INVALID", `${path}: ${error?.message ?? error}`);
  }
}

async function listedFiles(root) {
  try {
    return await walkFiles(root);
  } catch (error) {
    if (error instanceof ProofArtifactError) throw error;
    fail("PROOF_ARTIFACT_SOURCE_INVALID", String(error?.message ?? error));
  }
}

async function sourceAllowlist(root) {
  const { value } = await readJsonBound(root, generatedPaths[0], "PROOF_ARTIFACT_ALLOWLIST_INVALID");
  exactKeys(value, ["allowedFiles"], "PROOF_ARTIFACT_ALLOWLIST_FIELDS", generatedPaths[0]);
  assert(Array.isArray(value.allowedFiles), "PROOF_ARTIFACT_ALLOWLIST_INVALID", generatedPaths[0]);
  const declared = value.allowedFiles.map((path) => safePath(path, "PROOF_ARTIFACT_ALLOWLIST_PATH"));
  assert(new Set(declared).size === declared.length, "PROOF_ARTIFACT_DUPLICATE_PATH", generatedPaths[0]);
  return { value, declared };
}

async function rebuiltAllowlist(root) {
  const { declared } = await sourceAllowlist(root);
  const discovered = (await listedFiles(root)).map((path) => toPosixPath(relative(root, path))).sort(compareCanonicalText);
  const discoveredSet = new Set(discovered);
  const declaredSet = new Set(declared);
  for (const path of declared) assert(discoveredSet.has(path), "PROOF_ARTIFACT_DECLARED_SOURCE_MISSING", path);
  for (const path of discovered) {
    if (!declaredSet.has(path) && !routeAdditions.has(path)) fail("PROOF_ARTIFACT_UNAPPROVED_SOURCE", path);
  }
  const allowedFiles = [...new Set([...declared, ...routeAdditions])].sort(compareCanonicalText);
  assert(JSON.stringify(allowedFiles) === JSON.stringify(discovered), "PROOF_ARTIFACT_SOURCE_SET_MISMATCH", "allowlist must exactly admit the bounded source set");
  return { allowedFiles };
}

function validateMap(map) {
  exactKeys(map, ["schemaVersion", "claims"], "PROOF_ARTIFACT_MAP_FIELDS", "verification map");
  assert(map.schemaVersion === "tcrn.verification-map.v1" && Array.isArray(map.claims), "PROOF_ARTIFACT_MAP_INVALID", "verification map");
  const ids = new Set();
  for (const claim of map.claims) {
    exactKeys(claim, claimFields, "PROOF_ARTIFACT_CLAIM_FIELDS", claim?.id ?? "unknown");
    assert(typeof claim.id === "string" && !ids.has(claim.id), "PROOF_ARTIFACT_MAP_INVALID", claim?.id ?? "unknown");
    ids.add(claim.id);
    assert(["implemented", "candidate", "planned"].includes(claim.status), "PROOF_ARTIFACT_MAP_INVALID", claim.id);
    assert(claimCategories.includes(claim.category), "PROOF_ARTIFACT_MAP_INVALID", claim.id);
    assert(Array.isArray(claim.fixturePaths), "PROOF_ARTIFACT_MAP_INVALID", claim.id);
    const paths = claim.fixturePaths.map((path) => safePath(path, "PROOF_ARTIFACT_PATH_INVALID"));
    assert(new Set(paths).size === paths.length, "PROOF_ARTIFACT_DUPLICATE_PATH", claim.id);
    assert(claim.environment && typeof claim.environment === "object" && !Array.isArray(claim.environment), "PROOF_ARTIFACT_MAP_INVALID", claim.id);
    if (claim.status === "planned") assert(claim.fixtureDigest === null, "PROOF_ARTIFACT_PLANNED_DIGEST", claim.id);
  }
}

async function rebuiltMap(root, virtual) {
  const { value: map } = await readJsonBound(root, generatedPaths[1], "PROOF_ARTIFACT_MAP_INVALID");
  validateMap(map);
  const claims = [];
  for (const claim of map.claims) {
    if (claim.status === "planned") {
      claims.push({ ...claim, fixtureDigest: null });
      continue;
    }
    const fixturePaths = [...new Set([...claim.fixturePaths, ...(claimRouteAdditions.get(claim.id) ?? [])])];
    assert(!fixturePaths.includes("verification-map.yaml"), "PROOF_ARTIFACT_SELF_REFERENCE", claim.id);
    const records = await Promise.all(fixturePaths.map((path) => record(root, path, virtual)));
    records.sort((left, right) => compareCanonicalText(left.path, right.path));
    claims.push({ ...claim, fixturePaths, fixtureDigest: sha256(JSON.stringify(records)) });
  }
  return { ...map, claims };
}

async function normativePaths(root) {
  const { value: policy } = await readJsonBound(root, "scripts/policy/rc1-inputs.json", "PROOF_ARTIFACT_RC1_POLICY_INVALID");
  exactKeys(policy, ["normativeInputs"], "PROOF_ARTIFACT_RC1_POLICY_FIELDS", "rc1 policy");
  assert(Array.isArray(policy.normativeInputs), "PROOF_ARTIFACT_RC1_POLICY_INVALID", "rc1 policy");
  const declared = policy.normativeInputs.map((path) => safePath(path, "PROOF_ARTIFACT_PATH_INVALID")).sort(compareCanonicalText);
  assert(new Set(declared).size === declared.length, "PROOF_ARTIFACT_DUPLICATE_PATH", "rc1 policy");
  const discovered = (await listedFiles(root))
    .map((path) => toPosixPath(relative(root, path)))
    .filter((path) => path === "extensions/aos-requirements-v1.json" || path.startsWith("schemas/") || path.startsWith("specs/") ||
      (path.startsWith("fixtures/") && !path.startsWith("fixtures/rc1/")) || path === "verification-map.yaml")
    .sort(compareCanonicalText);
  assert(JSON.stringify(declared) === JSON.stringify(discovered), "PROOF_ARTIFACT_RC1_INPUT_SET", "normative input policy is stale");
  return declared;
}

function validateManifest(manifest) {
  exactKeys(manifest, manifestFields, "PROOF_ARTIFACT_MANIFEST_FIELDS", "rc1 manifest");
  assert(manifest.schemaVersion === "tcrn.rc1-candidate-proof-manifest.v1" && manifest.status === "candidate_unreviewed" && manifest.accepted === false,
    "PROOF_ARTIFACT_MANIFEST_INVALID", "rc1 manifest");
  exactKeys(manifest.roleVerdictSlots, roleNames, "PROOF_ARTIFACT_ROLE_FIELDS", "rc1 manifest");
  for (const role of roleNames) {
    const slot = manifest.roleVerdictSlots[role];
    exactKeys(slot, ["status", "verdict", "basisDigest"], "PROOF_ARTIFACT_ROLE_SLOT_FIELDS", role);
    assert(slot.status === "unresolved" && slot.verdict === null && slot.basisDigest === null, "PROOF_ARTIFACT_MANIFEST_INVALID", role);
  }
}

async function rebuiltManifest(root, virtual) {
  const { value: manifest } = await readJsonBound(root, generatedPaths[2], "PROOF_ARTIFACT_MANIFEST_INVALID");
  validateManifest(manifest);
  const inputs = await Promise.all((await normativePaths(root)).map((path) => record(root, path, virtual)));
  inputs.sort((left, right) => compareCanonicalText(left.path, right.path));
  // OD-16 F1: this was `Buffer.concat([canonicalJsonBytes(inputs), Buffer.from("\n")])`
  // -- the document contract, spelled by hand. Same bytes, one name.
  return { ...manifest, basisDigest: sha256(canonicalDocumentBytes(inputs)), inputs };
}

async function assertNoTemporaryResidue(root) {
  const found = [];
  for (const path of generatedPaths) {
    const directory = dirname(pathInRoot(root, path));
    const entries = await readdir(directory);
    found.push(...entries.filter((entry) => entry.startsWith(stagePrefix)).map((entry) => resolve(directory, entry)));
  }
  assert(found.length === 0, "PROOF_ARTIFACT_TEMP_RESIDUE", found.join(","));
}

async function atomicWrite(root, path, bytes, beforeRename) {
  const target = pathInRoot(root, path);
  const original = await readBoundRegularFile(target, {
    reasonCode: "PROOF_ARTIFACT_TARGET_INVALID",
    hardlinkReasonCode: "PROOF_ARTIFACT_TARGET_INVALID",
    pathChangedReasonCode: "PROOF_ARTIFACT_TARGET_REPLACED",
  });
  const existing = original.metadata;
  const directory = dirname(target);
  const temporary = resolve(directory, `${stagePrefix}${process.pid}-${sequence += 1}`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, existing.mode & 0o777);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat();
    assert(written.isFile() && written.nlink === 1, "PROOF_ARTIFACT_TEMP_INVALID", path);
    await handle.close();
    handle = undefined;
    try {
      await beforeRename?.({ path, target, temporary, bytes });
    } catch (error) {
      fail("PROOF_ARTIFACT_PRE_RENAME_FAILED", `${path}: ${error?.message ?? error}`);
    }
    const before = await readBoundRegularFile(target, {
      reasonCode: "PROOF_ARTIFACT_TARGET_INVALID",
      hardlinkReasonCode: "PROOF_ARTIFACT_TARGET_INVALID",
      pathChangedReasonCode: "PROOF_ARTIFACT_TARGET_REPLACED",
    });
    assert(before.metadata.isFile() && before.metadata.nlink === 1 && before.metadata.dev === existing.dev && before.metadata.ino === existing.ino &&
      before.metadata.size === existing.size && before.metadata.uid === existing.uid && before.metadata.mode === existing.mode &&
      before.metadata.ctimeMs === existing.ctimeMs && before.metadata.mtimeMs === existing.mtimeMs && before.content.equals(original.content),
      "PROOF_ARTIFACT_TARGET_REPLACED", path);
    await rename(temporary, target);
    const after = await lstat(target);
    assert(after.isFile() && !after.isSymbolicLink() && after.nlink === 1 && after.dev === written.dev && after.ino === written.ino,
      "PROOF_ARTIFACT_TARGET_REPLACED", path);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

export async function generateProofArtifacts({ root = repositoryRoot, mode = "check", beforeRename } = {}) {
  assert(["check", "write"].includes(mode), "PROOF_ARTIFACT_MODE_INVALID", mode);
  const rootReal = await realpath(root).catch((error) => fail("PROOF_ARTIFACT_ROOT_INVALID", String(error?.code ?? error)));
  const allowlist = await rebuiltAllowlist(rootReal);
  const allowlistBytes = Buffer.from(prettyJson(allowlist), "utf8");
  const map = await rebuiltMap(rootReal, new Map([[generatedPaths[0], allowlistBytes]]));
  const mapBytes = Buffer.from(prettyJson(map), "utf8");
  const manifest = await rebuiltManifest(rootReal, new Map([
    [generatedPaths[0], allowlistBytes],
    [generatedPaths[1], mapBytes],
  ]));
  const expected = new Map([
    [generatedPaths[0], allowlistBytes],
    [generatedPaths[1], mapBytes],
    [generatedPaths[2], Buffer.from(prettyJson(manifest), "utf8")],
  ]);
  const stale = [];
  for (const [path, bytes] of expected) {
    const current = await readSourceFile(pathInRoot(rootReal, path));
    if (!current.equals(bytes)) stale.push(path);
  }
  if (mode === "check") {
    await assertNoTemporaryResidue(rootReal);
    return { reasonCode: stale.length === 0 ? "PROOF_ARTIFACTS_CURRENT" : "PROOF_ARTIFACTS_STALE", stale, generatedPaths };
  }
  for (const path of stale) await atomicWrite(rootReal, path, expected.get(path), beforeRename);
  const reread = await generateProofArtifacts({ root: rootReal, mode: "check" });
  assert(reread.reasonCode === "PROOF_ARTIFACTS_CURRENT", "PROOF_ARTIFACT_PARITY_FAILED", reread.stale.join(","));
  return { reasonCode: "PROOF_ARTIFACTS_WRITTEN", stale, generatedPaths, terminal: true };
}
