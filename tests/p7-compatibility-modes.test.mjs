// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  COMPATIBILITY_LIMITS,
  calculateCompatibilityEffectivePlanDigest,
  dryRunCompatibilityMode,
  initializeWorkspace,
  parseWorkflowCompatibilityManifest,
  planCompatibilityMode,
  readCompatibilityAdmissionReceipt,
  unavailableCompatibilityCapability,
  validateCompatibilityRequest,
  validateWorkflowCompatibilityManifest,
} from "../dist/build/packages/core/src/index.js";
import { readAuthorityFile } from "../dist/build/packages/core/src/authority-file-reader.js";
import { canonicalJson, canonicalSha256, compareCanonicalText } from "../dist/build/packages/protocol/src/index.js";

const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/p7-compatibility-modes-cases.json", import.meta.url), "utf8"));
const clone = (value) => structuredClone(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function seal(document, field) {
  const copy = clone(document); delete copy[field]; copy[field] = canonicalSha256(copy); return copy;
}

function logicalDefinitions(entries) {
  const all = {
    "definition.alpha": { kind: "Initiative", title: "Alpha" },
    "definition.beta": { kind: "Epic", title: "Beta" },
    "definition.gamma": { kind: "Story", title: "Gamma" },
    "definition.delta": { kind: "Subtask", title: "Delta" },
    "definition.epsilon": { kind: "Knowledge", title: "Epsilon" },
  };
  return Object.fromEntries((entries ?? Object.keys(all)).map((key) => [key, all[key]]));
}

function manifestDocument(workflowOwnedFields, aosOwnedOperationalFields, workflowDefinitions) {
  const basis = {
    schemaVersion: "tcrn.workflow-compatibility-manifest.v1",
    repositoryId: "repository:tcrn-workflow",
    workflowId: "workflow:framework-v3",
    subjectId: "subject:tcrn-platform",
    releaseId: "release:workflow-p7b",
    protocolVersion: 1,
    policyEpoch: 3,
    policyVersion: 7,
    instanceId: "instance:workspace-main",
    dataEpoch: 11,
    definitionsDigest: canonicalSha256(workflowDefinitions),
    workflowOwnedFields,
    aosOwnedOperationalFields,
    supportedAosReleases: [],
  };
  return { ...basis, manifestDigest: canonicalSha256({ ...basis, workflowOwnedFields: [...workflowOwnedFields].sort(compareCanonicalText), aosOwnedOperationalFields: [...aosOwnedOperationalFields].sort(compareCanonicalText) }) };
}

function documents(operation = "initial_import", orders = {}) {
  const workflowDefinitions = logicalDefinitions(orders.definitions);
  const workflowOwnedFields = orders.workflowOwned ?? Object.keys(workflowDefinitions);
  const aosOwnedOperationalFields = orders.aosOwned ?? ["assigneeId", "status"];
  const manifest = manifestDocument(workflowOwnedFields, aosOwnedOperationalFields, workflowDefinitions);
  const normalizedManifest = validateWorkflowCompatibilityManifest(manifest);
  const pairReceipt = seal({
    schemaVersion: "tcrn.compatibility-pair-receipt.v1",
    receiptId: "receipt:pair-p7b",
    repositoryId: manifest.repositoryId,
    workflowId: manifest.workflowId,
    subjectId: manifest.subjectId,
    workflowReleaseId: manifest.releaseId,
    aosReleaseId: "release:aos-reference-only",
    signerId: "signer:release-verifier",
    issuerId: "issuer:compatibility-board",
    audience: "tcrn-workflow-offline-compatibility",
    nonce: "p7b-fixture-nonce",
    issuedAt: "2026-07-12T14:40:00Z",
    notBefore: "2026-07-12T14:40:00Z",
    expiresAt: "2026-07-12T15:40:00Z",
    policyEpoch: 3,
    policyVersion: 7,
    instanceId: manifest.instanceId,
    dataEpoch: manifest.dataEpoch,
    workflowManifestDigest: manifest.manifestDigest,
    aosManifestDigest: "a".repeat(64),
    verdict: "mutual_compatible",
    revoked: false,
  }, "receiptDigest");
  const checkpoint = ["fallback_delta", "reconciliation_dry_run"].includes(operation) ? {
    checkpointId: "checkpoint:p7b", version: 7, instanceId: manifest.instanceId, dataEpoch: manifest.dataEpoch, stateDigest: "b".repeat(64),
  } : null;
  const externalEffectIds = orders.effects ?? ["effect:alpha", "effect:beta"];
  const basis = {
    schemaVersion: "tcrn.compatibility-request.v1", operation, workspaceId: "workspace:tcrn-platform", manifest,
    pairReceipt, checkpoint, workflowDefinitions, aosOperationalState: { assigneeId: "user:operator", status: "active" }, externalEffectIds,
  };
  const requestDigest = canonicalSha256({ ...basis, manifest: normalizedManifest, externalEffectIds: [...externalEffectIds].sort(compareCanonicalText) });
  return { request: { ...basis, requestDigest } };
}

function admissionReceipt(request, changes = {}) {
  const basis = {
    schemaVersion: "tcrn.compatibility-admission.v1",
    authenticatedPairReceiptDigest: request.pairReceipt.receiptDigest,
    expectedManifestDigest: request.manifest.manifestDigest,
    expectedWorkflowReleaseId: request.manifest.releaseId,
    expectedAosReleaseId: request.pairReceipt.aosReleaseId,
    expectedRequestDigest: request.requestDigest,
    expectedEffectivePlanDigest: calculateCompatibilityEffectivePlanDigest(request),
    expectedRepositoryId: request.manifest.repositoryId,
    expectedWorkflowId: request.manifest.workflowId,
    expectedSubjectId: request.manifest.subjectId,
    expectedSignerId: request.pairReceipt.signerId,
    expectedIssuerId: request.pairReceipt.issuerId,
    expectedAudience: request.pairReceipt.audience,
    expectedNonce: request.pairReceipt.nonce,
    verificationTime: "2026-07-12T15:00:00Z",
    minimumPolicyEpoch: 3,
    minimumPolicyVersion: 7,
    expectedInstanceId: request.manifest.instanceId,
    expectedDataEpoch: request.manifest.dataEpoch,
    revokedReceiptIds: [],
    consumedReceiptIds: [],
    workspaceLock: { workspaceId: request.workspaceId, lockId: "lock:compatibility-p7b", generation: 1, valid: true },
    activeAos: false,
    ...changes,
  };
  return seal({ ...basis, revokedReceiptIds: [...basis.revokedReceiptIds].sort(compareCanonicalText), consumedReceiptIds: [...basis.consumedReceiptIds].sort(compareCanonicalText) }, "admissionDigest");
}

function rebuildRequest(source, workflowDefinitions = source.workflowDefinitions, aosOperationalState = source.aosOperationalState) {
  const manifest = manifestDocument(Object.keys(workflowDefinitions), ["assigneeId", "status"], workflowDefinitions);
  const normalizedManifest = validateWorkflowCompatibilityManifest(manifest);
  const pairReceipt = seal({ ...source.pairReceipt, workflowManifestDigest: manifest.manifestDigest }, "receiptDigest");
  const basis = { ...source, manifest, pairReceipt, workflowDefinitions, aosOperationalState };
  delete basis.requestDigest;
  return { ...basis, requestDigest: canonicalSha256({ ...basis, manifest: normalizedManifest, externalEffectIds: [...basis.externalEffectIds].sort(compareCanonicalText) }) };
}

function requestAtCanonicalSize(target) {
  const source = documents().request;
  const values = [];
  let current = rebuildRequest(source, { "definition.alpha": { payload: values } });
  while (values.length < 127) {
    const candidateValues = [...values, "x".repeat(4096)];
    const candidate = rebuildRequest(source, { "definition.alpha": { payload: candidateValues } });
    if (Buffer.byteLength(canonicalJson(candidate), "utf8") > target) break;
    values.push(candidateValues.at(-1)); current = candidate;
  }
  const currentSize = Buffer.byteLength(canonicalJson(current), "utf8");
  const overhead = values.length === 0 ? 2 : 3;
  const remainder = target - currentSize - overhead;
  assert.ok(remainder >= 1 && remainder <= 4096, `document budget remainder ${remainder}`);
  const result = rebuildRequest(source, { "definition.alpha": { payload: [...values, "x".repeat(remainder)] } });
  assert.equal(Buffer.byteLength(canonicalJson(result), "utf8"), target);
  return result;
}

function canonicalPaddingDocument(target) {
  const padding = [];
  let current = canonicalJson({ padding });
  while (Buffer.byteLength(current) + 4_099 <= target) {
    padding.push("x".repeat(4096)); current = canonicalJson({ padding });
  }
  const overhead = padding.length === 0 ? 2 : 3;
  const remainder = target - Buffer.byteLength(current) - overhead;
  assert.ok(remainder >= 1 && remainder <= 4096);
  padding.push("x".repeat(remainder));
  const result = canonicalJson({ padding }); assert.equal(Buffer.byteLength(result), target); return result;
}

async function authorityFile(request, changes = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "workflow-p7b-authority-")));
  const path = join(directory, "compatibility-admission.json");
  const receipt = admissionReceipt(request, changes);
  const bytes = canonicalJson(receipt);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  const authority = { expectedCanonicalPath: path, expectedFileSha256: sha256(bytes) };
  return { directory, path, receipt, bytes, authority, context: await readCompatibilityAdmissionReceipt(path, authority), close: () => rm(directory, { recursive: true, force: true }) };
}

function reason(code, operation) { assert.throws(operation, (error) => error?.reasonCode === code, code); }
async function reasonAsync(code, operation) { await assert.rejects(operation, (error) => error?.reasonCode === code, code); }

function permutations(values, maximum) {
  const result = [];
  const visit = (prefix, remaining) => {
    if (result.length >= maximum) return;
    if (remaining.length === 0) { result.push(prefix); return; }
    for (let index = 0; index < remaining.length; index += 1) visit([...prefix, remaining[index]], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
  };
  visit([], values); return result;
}

function deepWellFormed(value) {
  if (typeof value === "string") return value.isWellFormed();
  if (Array.isArray(value)) return value.every(deepWellFormed);
  return !value || typeof value !== "object" || Object.entries(value).every(([key, item]) => key.isWellFormed() && deepWellFormed(item));
}

function jsonDepth(value, depth = 0) {
  if (!value || typeof value !== "object") return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.length === 0 ? depth : Math.max(...children.map((child) => jsonDepth(child, depth + 1)));
}

async function validators() {
  const schema = JSON.parse(await readFile(new URL("../packages/core/schema/compatibility-modes-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: true });
  ajv.addKeyword({ keyword: "x-tcrn-maxUtf8Bytes", schemaType: "number", type: "string", validate: (maximum, value) => Buffer.byteLength(value, "utf8") <= maximum });
  ajv.addKeyword({ keyword: "x-tcrn-wellFormedUnicode", schemaType: "boolean", type: "string", validate: (enabled, value) => !enabled || value.isWellFormed() });
  ajv.addKeyword({ keyword: "x-tcrn-deepWellFormedUnicode", schemaType: "boolean", validate: (enabled, value) => !enabled || deepWellFormed(value) });
  ajv.addKeyword({ keyword: "x-tcrn-maxDepth", schemaType: "number", validate: (maximum, value) => jsonDepth(value) <= maximum });
  ajv.addKeyword({ keyword: "x-tcrn-maxCanonicalBytes", schemaType: "number", validate: (maximum, value) => { try { return Buffer.byteLength(canonicalJson(value), "utf8") <= maximum; } catch { return false; } } });
  ajv.addSchema(schema);
  return {
    request: ajv.getSchema(schema.$id),
    admission: ajv.compile({ $ref: `${schema.$id}#/$defs/admission` }),
  };
}

test("six offline modes require independently read opaque authority and stay deterministic", async () => {
  const operations = ["initial_import", "portable_checkpoint", "fallback_admission", "fallback_delta", "conflict_plan", "reconciliation_dry_run"];
  for (const operation of operations) {
    const { request } = documents(operation); const admitted = await authorityFile(request);
    try {
      const plan = planCompatibilityMode(request, admitted.context); const dry = dryRunCompatibilityMode(request, admitted.context);
      assert.equal(plan.reasonCode, "COMPATIBILITY_PLAN_READY"); assert.equal(dry.reasonCode, "COMPATIBILITY_DRY_RUN_READY");
      assert.deepEqual({ mutation: plan.mutation, network: plan.network }, { mutation: false, network: false });
      assert.equal(plan.effectivePlanDigest, admitted.receipt.expectedEffectivePlanDigest);
      reason("COMPATIBILITY_AUTHORITY_REQUIRED", () => planCompatibilityMode(request, admitted.receipt));
      reason("COMPATIBILITY_AUTHORITY_REQUIRED", () => planCompatibilityMode(request, clone(admitted.context)));
    } finally { await admitted.close(); }
  }
});

test("governed CLI obtains authority only from host injection and exact canonical source", async () => {
  const { request } = documents(); const admitted = await authorityFile(request);
  try {
    assert.equal(parseWorkflowCompatibilityManifest(canonicalJson(request.manifest)).manifestDigest, request.manifest.manifestDigest);
    reason("COMPATIBILITY_CANONICAL_INVALID", () => parseWorkflowCompatibilityManifest(` ${canonicalJson(request.manifest)}`));
    let planned = "", dry = "";
    await runCli(["compatibility-plan", "--request", canonicalJson(request)], { compatibilityAdmissionAuthority: admitted.authority, write: (value) => { planned = value; } });
    await runCli(["compatibility-dry-run", "--request", canonicalJson(request)], { compatibilityAdmissionAuthority: admitted.authority, write: (value) => { dry = value; } });
    assert.equal(JSON.parse(planned).reasonCode, "COMPATIBILITY_PLAN_READY"); assert.equal(JSON.parse(dry).mutation, false);
    await assert.rejects(runCli(["compatibility-plan", "--request", canonicalJson(request)], { write() {} }), (error) => error.reasonCode === "COMPATIBILITY_AUTHORITY_REQUIRED");
    await assert.rejects(runCli(["compatibility-plan", "--request", canonicalJson(request), "--authority", admitted.path], { compatibilityAdmissionAuthority: admitted.authority, write() {} }), (error) => error.reasonCode === "CLI_ARGUMENT_UNKNOWN");
  } finally { await admitted.close(); }
});

test("authority file admission rejects forged, copied, path, digest, link, special and changed sources", async () => {
  const { request } = documents(); const admitted = await authorityFile(request);
  try {
    await reasonAsync("COMPATIBILITY_AUTHORITY_REQUIRED", () => readCompatibilityAdmissionReceipt(admitted.path, undefined));
    await reasonAsync("COMPATIBILITY_AUTHORITY_PATH", () => readCompatibilityAdmissionReceipt(admitted.path, { ...admitted.authority, expectedCanonicalPath: "relative.json" }));
    await reasonAsync("COMPATIBILITY_AUTHORITY_DIGEST", () => readCompatibilityAdmissionReceipt(admitted.path, { ...admitted.authority, expectedFileSha256: "0".repeat(64) }));
    const copy = join(admitted.directory, "copy.json"); await writeFile(copy, admitted.bytes);
    await reasonAsync("COMPATIBILITY_AUTHORITY_PATH", () => readCompatibilityAdmissionReceipt(copy, admitted.authority));
    const symbolic = join(admitted.directory, "symbolic.json"); await symlink(admitted.path, symbolic);
    await reasonAsync("COMPATIBILITY_AUTHORITY_LINK", () => readCompatibilityAdmissionReceipt(symbolic, { expectedCanonicalPath: symbolic, expectedFileSha256: admitted.authority.expectedFileSha256 }));
    const hard = join(admitted.directory, "hard.json"); await link(admitted.path, hard);
    await reasonAsync("COMPATIBILITY_AUTHORITY_LINK", () => readCompatibilityAdmissionReceipt(admitted.path, admitted.authority));
    await rm(hard); const special = join(admitted.directory, "special"); await mkdir(special);
    await reasonAsync("COMPATIBILITY_AUTHORITY_SPECIAL_FILE", () => readCompatibilityAdmissionReceipt(special, { expectedCanonicalPath: special, expectedFileSha256: admitted.authority.expectedFileSha256 }));
    const replacement = join(admitted.directory, "replacement.json"); await writeFile(replacement, admitted.bytes);
    await reasonAsync("COMPATIBILITY_AUTHORITY_CHANGED", () => readCompatibilityAdmissionReceipt(admitted.path, admitted.authority, { afterLstatForTest: async () => { await rename(replacement, admitted.path); } }));
  } finally { await admitted.close(); }

  const changed = await authorityFile(request);
  try {
    await reasonAsync("COMPATIBILITY_AUTHORITY_CHANGED", () => readCompatibilityAdmissionReceipt(changed.path, changed.authority, { afterOpenForTest: async () => { await writeFile(changed.path, `${changed.bytes} `); } }));
  } finally { await changed.close(); }
});

test("authority reads stay bounded under sparse and continuous same-inode growth with exact size boundaries", async () => {
  const { request } = documents();
  const sparse = await authorityFile(request); let sparseRead = 0;
  try {
    await reasonAsync("COMPATIBILITY_LIMIT_EXCEEDED", () => readCompatibilityAdmissionReceipt(sparse.path, sparse.authority, {
      afterOpenForTest: async () => { await truncate(sparse.path, 32 * 1024 * 1024); },
      observeReadBytesForTest: (bytes) => { sparseRead = bytes; },
    }));
    assert.equal(sparseRead, 65_537);
  } finally { await sparse.close(); }

  const growing = await authorityFile(request); let growingRead = 0; let growthRounds = 0;
  try {
    await reasonAsync("COMPATIBILITY_LIMIT_EXCEEDED", () => readCompatibilityAdmissionReceipt(growing.path, growing.authority, {
      observeReadBytesForTest: (bytes) => { growingRead = bytes; },
      afterReadChunkForTest: async () => { growthRounds += 1; await appendFile(growing.path, "x".repeat(16_384)); },
    }));
    assert.equal(growingRead, 65_537); assert.ok(growthRounds >= 4);
  } finally { await growing.close(); }

  const directory = await realpath(await mkdtemp(join(tmpdir(), "workflow-p7b-boundary-")));
  try {
    const exactPath = join(directory, "exact.json");
    const exactBytes = canonicalPaddingDocument(65_536);
    assert.equal(Buffer.byteLength(exactBytes), 65_536); await writeFile(exactPath, exactBytes);
    let exactRead = 0;
    await reasonAsync("COMPATIBILITY_UNKNOWN_FIELD", () => readCompatibilityAdmissionReceipt(exactPath, { expectedCanonicalPath: exactPath, expectedFileSha256: sha256(exactBytes) }, { observeReadBytesForTest: (bytes) => { exactRead = bytes; } }));
    assert.equal(exactRead, 65_536);
    const overPath = join(directory, "over.json"); const overBytes = `${exactBytes} `; await writeFile(overPath, overBytes); let overRead = 0;
    await reasonAsync("COMPATIBILITY_LIMIT_EXCEEDED", () => readCompatibilityAdmissionReceipt(overPath, { expectedCanonicalPath: overPath, expectedFileSha256: sha256(overBytes) }, { observeReadBytesForTest: (bytes) => { overRead = bytes; } }));
    assert.equal(overRead, 0);
    await assert.rejects(runCli(["compatibility-plan", "--request", canonicalJson(request)], { compatibilityAdmissionAuthority: { expectedCanonicalPath: overPath, expectedFileSha256: sha256(overBytes) }, write() {} }), (error) => error.reasonCode === "COMPATIBILITY_LIMIT_EXCEEDED");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("shared authority reader propagates caller errors and normalizes foreign errors to the changed code", async () => {
  const { request } = documents();
  const admitted = await authorityFile(request);

  class SentinelError extends Error {
    constructor(reasonCode) { super(reasonCode); this.name = "SentinelError"; this.reasonCode = reasonCode; }
  }
  const codes = {
    required: "SENTINEL_REQUIRED", path: "SENTINEL_PATH", digest: "SENTINEL_DIGEST",
    changed: "SENTINEL_CHANGED", link: "SENTINEL_LINK", specialFile: "SENTINEL_SPECIAL_FILE",
    limitExceeded: "SENTINEL_LIMIT", notUtf8: "SENTINEL_UTF8", notJson: "SENTINEL_JSON",
    notCanonical: "SENTINEL_CANONICAL",
  };
  const parameters = (overrides = {}) => ({
    maximumBytes: 65_536,
    codes,
    details: { required: "authority required", expectedDigest: "expectedFileSha256" },
    fail: (reasonCode, detail) => { throw new SentinelError(reasonCode, detail); },
    isOwnError: (error) => error instanceof SentinelError,
    ...overrides,
  });

  try {
    // The caller's own typed failure, raised from inside the read block, must
    // reach the caller unwrapped rather than being relabelled as changed.
    const ownError = new SentinelError("SENTINEL_CALLER_SPECIFIC");
    await assert.rejects(
      readAuthorityFile(admitted.path, admitted.authority, parameters({
        hooks: { afterOpenForTest: async () => { throw ownError; } },
      })),
      (error) => error === ownError,
      "caller error must propagate unwrapped",
    );

    // A foreign error from the same position is normalized into the caller's
    // changed code, so unexpected filesystem faults never escape untyped.
    await assert.rejects(
      readAuthorityFile(admitted.path, admitted.authority, parameters({
        hooks: { afterOpenForTest: async () => { throw new TypeError("foreign failure"); } },
      })),
      (error) => error instanceof SentinelError && error.reasonCode === "SENTINEL_CHANGED",
      "foreign error must normalize to the changed code",
    );

    // The reader stops at verified canonical bytes and hands the caller the
    // parsed value plus the unified source identity digest.
    const result = await readAuthorityFile(admitted.path, admitted.authority, parameters());
    assert.equal(result.fileSha256, admitted.authority.expectedFileSha256);
    assert.equal(result.canonicalPath, admitted.path);
    assert.equal(result.sourceText, admitted.bytes);
    assert.match(result.sourceIdentityDigest, /^[a-f0-9]{64}$/u);
    assert.equal(typeof result.parsed, "object");

    // Every reason-code slot is caller-supplied, not baked into the reader.
    await reasonAsync("SENTINEL_REQUIRED", () => readAuthorityFile(admitted.path, undefined, parameters()));
    const directoryPath = join(admitted.directory, "reader-special");
    await mkdir(directoryPath);
    await reasonAsync("SENTINEL_SPECIAL_FILE", () => readAuthorityFile(directoryPath, { expectedCanonicalPath: directoryPath, expectedFileSha256: admitted.authority.expectedFileSha256 }, parameters()));
  } finally { await admitted.close(); }
});

test("anchored receipt binds request, plan, release pair, lock, policy, replay and revocation", async () => {
  const schemaValidators = await validators();
  const cases = [
    ["COMPATIBILITY_AUTHORITY_MISMATCH", { expectedRequestDigest: "0".repeat(64) }],
    ["COMPATIBILITY_AUTHORITY_MISMATCH", { expectedEffectivePlanDigest: "0".repeat(64) }],
    ["COMPATIBILITY_AUTHORITY_MISMATCH", { expectedManifestDigest: "0".repeat(64) }],
    ["COMPATIBILITY_AUTHORITY_MISMATCH", { expectedWorkflowReleaseId: "release:wrong" }],
    ["COMPATIBILITY_AUTHORITY_MISMATCH", { expectedAosReleaseId: "release:wrong" }],
    ["COMPATIBILITY_RECEIPT_UNAUTHENTICATED", { expectedSignerId: "signer:wrong" }],
    ["COMPATIBILITY_RECEIPT_UNAUTHENTICATED", { expectedIssuerId: "issuer:wrong" }],
    ["COMPATIBILITY_RECEIPT_UNAUTHENTICATED", { expectedAudience: "wrong" }],
    ["COMPATIBILITY_RECEIPT_UNAUTHENTICATED", { expectedNonce: "wrong" }],
    ["COMPATIBILITY_POLICY_ROLLBACK", { minimumPolicyEpoch: 4 }],
    ["COMPATIBILITY_POLICY_ROLLBACK", { minimumPolicyVersion: 8 }],
    ["COMPATIBILITY_WORKSPACE_LOCK_REQUIRED", { workspaceLock: { workspaceId: "workspace:wrong", lockId: "lock:forged", generation: 99, valid: true } }],
    ["COMPATIBILITY_RECEIPT_REPLAYED", { consumedReceiptIds: ["receipt:pair-p7b"] }],
    ["COMPATIBILITY_RECEIPT_REVOKED", { revokedReceiptIds: ["receipt:pair-p7b"] }],
  ];
  for (const [code, changes] of cases) {
    const { request } = documents("fallback_delta"); const admitted = await authorityFile(request, changes);
    try {
      assert.equal(schemaValidators.admission(admitted.receipt), true, JSON.stringify(schemaValidators.admission.errors));
      reason(code, () => planCompatibilityMode(request, admitted.context));
    } finally { await admitted.close(); }
  }
  const malformed = { ...admissionReceipt(documents().request), extra: true };
  assert.equal(schemaValidators.admission(malformed), false);
});

test("governed CLI fails closed on authority path, file, source, lock, policy, replay and revocation attacks", async () => {
  const { request } = documents("fallback_delta");
  const invoke = (authority) => runCli(["compatibility-plan", "--request", canonicalJson(request)], { compatibilityAdmissionAuthority: authority, write() {} });
  const admitted = await authorityFile(request);
  try {
    await assert.rejects(invoke({ ...admitted.authority, expectedFileSha256: "0".repeat(64) }), (error) => error.reasonCode === "COMPATIBILITY_AUTHORITY_DIGEST");
    await assert.rejects(invoke({ ...admitted.authority, expectedCanonicalPath: "relative.json" }), (error) => error.reasonCode === "COMPATIBILITY_AUTHORITY_PATH");
    const symbolic = join(admitted.directory, "cli-symbolic.json"); await symlink(admitted.path, symbolic);
    await assert.rejects(invoke({ expectedCanonicalPath: symbolic, expectedFileSha256: admitted.authority.expectedFileSha256 }), (error) => error.reasonCode === "COMPATIBILITY_AUTHORITY_LINK");
    const hard = join(admitted.directory, "cli-hard.json"); await link(admitted.path, hard);
    await assert.rejects(invoke(admitted.authority), (error) => error.reasonCode === "COMPATIBILITY_AUTHORITY_LINK"); await rm(hard);
    const special = join(admitted.directory, "cli-special"); await mkdir(special);
    await assert.rejects(invoke({ expectedCanonicalPath: special, expectedFileSha256: admitted.authority.expectedFileSha256 }), (error) => error.reasonCode === "COMPATIBILITY_AUTHORITY_SPECIAL_FILE");
    await writeFile(admitted.path, `${admitted.bytes} `);
    await assert.rejects(invoke(admitted.authority), (error) => error.reasonCode === "COMPATIBILITY_AUTHORITY_DIGEST");
  } finally { await admitted.close(); }
  const attacks = [
    ["COMPATIBILITY_AUTHORITY_MISMATCH", { expectedRequestDigest: "0".repeat(64) }],
    ["COMPATIBILITY_WORKSPACE_LOCK_REQUIRED", { workspaceLock: { workspaceId: "workspace:wrong", lockId: "lock:forged", generation: 2, valid: true } }],
    ["COMPATIBILITY_POLICY_ROLLBACK", { minimumPolicyEpoch: 4 }],
    ["COMPATIBILITY_RECEIPT_REPLAYED", { consumedReceiptIds: ["receipt:pair-p7b"] }],
    ["COMPATIBILITY_RECEIPT_REVOKED", { revokedReceiptIds: ["receipt:pair-p7b"] }],
  ];
  for (const [code, changes] of attacks) {
    const candidate = await authorityFile(request, changes);
    try { await assert.rejects(invoke(candidate.authority), (error) => error.reasonCode === code); } finally { await candidate.close(); }
  }
});

test("semantic ownership and effect sets normalize across 64 real cross-surface permutations", async () => {
  const definitionKeys = ["definition.alpha", "definition.beta", "definition.gamma", "definition.delta", "definition.epsilon"];
  const orders = permutations(definitionKeys, fixture.propertyPermutations);
  const plans = [];
  for (let index = 0; index < orders.length; index += 1) {
    const reverse = index % 2 === 1;
    const { request } = documents("initial_import", {
      definitions: orders[index],
      workflowOwned: reverse ? [...definitionKeys].reverse() : definitionKeys,
      aosOwned: reverse ? ["status", "assigneeId"] : ["assigneeId", "status"],
      effects: reverse ? ["effect:beta", "effect:alpha"] : ["effect:alpha", "effect:beta"],
    });
    const admitted = await authorityFile(request);
    try { plans.push(planCompatibilityMode(request, admitted.context)); } finally { await admitted.close(); }
  }
  assert.equal(new Set(orders.map((order) => order.join("|"))).size, 64);
  assert.equal(new Set(plans.map((plan) => canonicalJson(plan))).size, 1);
  assert.equal(new Set(plans.map((plan) => plan.planDigest)).size, 1);
  assert.equal(canonicalSha256(orders.map((order, index) => ({ definitionOrder: order, reversedSets: index % 2 === 1 }))), fixture.permutationCorpusDigest);
});

test("recursive Draft 2020-12 and runtime parity covers exact max and max-plus-one boundaries", async () => {
  const { request: validate } = await validators(); const base = documents().request;
  const nested = (depth) => { let value = true; for (let index = 0; index < depth; index += 1) value = [value]; return value; };
  const object128 = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`k${index}`, index]));
  const hugeDefinitions = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`k${index}`, Array(3).fill("x".repeat(4096))]));
  const valid = [
    { ...base, workflowDefinitions: { ...base.workflowDefinitions, rank: Number.MAX_SAFE_INTEGER } },
    { ...base, workflowDefinitions: { ...base.workflowDefinitions, values: Array(128).fill(true) } },
    { ...base, workflowDefinitions: object128 },
    { ...base, workflowDefinitions: { ...base.workflowDefinitions, nested: nested(15) } },
    { ...base, aosOperationalState: { assigneeId: "a".repeat(4096), status: "active" } },
  ];
  const invalid = [
    { ...base, workflowDefinitions: { ...base.workflowDefinitions, rank: 1.5 } },
    { ...base, workflowDefinitions: { ...base.workflowDefinitions, rank: Number.MAX_SAFE_INTEGER + 1 } },
    { ...base, workflowDefinitions: { ...base.workflowDefinitions, values: Array(129).fill(true) } },
    { ...base, workflowDefinitions: { ...object128, extra: true } },
    { ...base, workflowDefinitions: { ...base.workflowDefinitions, nested: nested(16) } },
    { ...base, workflowDefinitions: { ["k".repeat(129)]: true } },
    { ...base, aosOperationalState: { assigneeId: "é".repeat(2049), status: "active" } },
    { ...base, workflowDefinitions: { "\ud800": true } },
    { ...base, workflowDefinitions: hugeDefinitions },
  ];
  for (const vector of valid) {
    const changed = rebuildRequest(base, vector.workflowDefinitions, vector.aosOperationalState);
    assert.equal(validate(changed), true, JSON.stringify(validate.errors)); assert.doesNotThrow(() => validateCompatibilityRequest(changed));
  }
  for (const vector of invalid) {
    assert.equal(validate(vector), false, JSON.stringify(validate.errors)); assert.throws(() => validateCompatibilityRequest(vector));
  }
  reason("COMPATIBILITY_LIMIT_EXCEEDED", () => validateCompatibilityRequest({ ...base, workflowDefinitions: hugeDefinitions }));
  const exactDocument = requestAtCanonicalSize(COMPATIBILITY_LIMITS.maximumDocumentBytes);
  const oversizedDocument = requestAtCanonicalSize(COMPATIBILITY_LIMITS.maximumDocumentBytes + 1);
  assert.equal(validate(exactDocument), true, JSON.stringify(validate.errors)); assert.doesNotThrow(() => validateCompatibilityRequest(exactDocument));
  assert.equal(validate(oversizedDocument), false); reason("COMPATIBILITY_LIMIT_EXCEEDED", () => validateCompatibilityRequest(oversizedDocument));
});

test("all live surfaces remain exactly unavailable without network or mutation", () => {
  const surfaces = ["aos_primary", "fallback_activation", "import_apply", "reconciliation_apply"];
  for (const surface of surfaces) {
    const result = unavailableCompatibilityCapability(surface);
    assert.equal(result.reasonCode, "COMPATIBILITY_CAPABILITY_UNAVAILABLE"); assert.equal(result.disposition, "capability_unavailable_until_mutual_release");
    assert.deepEqual({ supported: result.supportedAosReleases, mutation: result.mutation, network: result.network }, { supported: [], mutation: false, network: false });
  }
});

// WSB-5: first-ever coverage of the shipped bin "tcrn-workflow" (scripts/tcrn-workflow.mjs).
// The wrapper constructs CliIo as {write} only, so the authority-gated compatibility
// verbs cannot obtain a CompatibilityAdmissionAuthority and MUST fail closed; a read
// verb over the same wrapper pins its stdout/exit contract. Hermetic: node spawns node
// against a repo-local script, no network, using the dist/ build the test gate guarantees.
const shippedWorkflowBinary = fileURLToPath(new URL("../scripts/tcrn-workflow.mjs", import.meta.url));

function runShippedWorkflowBinary(arguments_) {
  return spawnSync(process.execPath, [shippedWorkflowBinary, ...arguments_], { encoding: "utf8" });
}

async function initializedWrapperWorkspace() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "workflow-p7b-wrapper-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind); await mkdir(path); roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: "WORKSPACE-WRAPPER", createdAt: "2026-07-12T00:00:00Z", segmentEventLimit: 2 });
  return { base, workspace: join(base, "workspace"), close: () => rm(base, { recursive: true, force: true }) };
}

test("WSB-5: the shipped binary fails compatibility-plan/dry-run closed with COMPATIBILITY_AUTHORITY_REQUIRED and refuses argv authority", () => {
  const { request } = documents();
  const requestJson = canonicalJson(request);
  for (const verb of ["compatibility-plan", "compatibility-dry-run"]) {
    const result = runShippedWorkflowBinary([verb, "--request", requestJson]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "", `${verb} emits no plan without host-supplied authority`);
    const envelope = JSON.parse(result.stderr);
    assert.deepEqual(
      { ok: envelope.ok, reasonCode: envelope.reasonCode },
      { ok: false, reasonCode: "COMPATIBILITY_AUTHORITY_REQUIRED" },
    );
  }
  // Authority identity material can never arrive on argv: an --authority token is
  // rejected as unknown before the authority gate, preserving the programmatic-only boundary.
  const forged = runShippedWorkflowBinary(["compatibility-plan", "--request", requestJson, "--authority", "/tmp/forged.json"]);
  assert.equal(forged.status, 1, forged.stderr);
  assert.equal(JSON.parse(forged.stderr).reasonCode, "CLI_ARGUMENT_UNKNOWN");
});

test("WSB-5: the shipped binary completes the status read verb with exit 0 and WORKSPACE_COMMAND_COMPLETED", async () => {
  const fixture = await initializedWrapperWorkspace();
  try {
    const result = runShippedWorkflowBinary(["status", "--workspace", fixture.workspace]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "", "a successful read emits nothing on stderr");
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
    assert.equal(envelope.version, 0);
  } finally {
    await fixture.close();
  }
});
