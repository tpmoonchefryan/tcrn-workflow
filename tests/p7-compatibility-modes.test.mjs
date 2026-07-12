// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  dryRunCompatibilityMode,
  parseWorkflowCompatibilityManifest,
  planCompatibilityMode,
  unavailableCompatibilityCapability,
  validateCompatibilityRequest,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/p7-compatibility-modes-cases.json", import.meta.url), "utf8"));
const clone = (value) => structuredClone(value);

function seal(document, field) {
  const copy = clone(document);
  delete copy[field];
  copy[field] = canonicalSha256(copy);
  return copy;
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

function documents(operation = "initial_import", definitionOrder) {
  const workflowDefinitions = logicalDefinitions(definitionOrder);
  const manifest = seal({
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
    workflowOwnedFields: Object.keys(workflowDefinitions).sort(),
    aosOwnedOperationalFields: ["assigneeId", "status"],
    supportedAosReleases: [],
  }, "manifestDigest");
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
    checkpointId: "checkpoint:p7b",
    version: 7,
    instanceId: manifest.instanceId,
    dataEpoch: manifest.dataEpoch,
    stateDigest: "b".repeat(64),
  } : null;
  const request = seal({
    schemaVersion: "tcrn.compatibility-request.v1",
    operation,
    workspaceId: "workspace:tcrn-platform",
    manifest,
    pairReceipt,
    checkpoint,
    workflowDefinitions,
    aosOperationalState: { assigneeId: "user:operator", status: "active" },
    externalEffectIds: ["effect:alpha", "effect:beta"],
  }, "requestDigest");
  const admission = seal({
    schemaVersion: "tcrn.compatibility-admission.v1",
    authenticatedPairReceiptDigest: pairReceipt.receiptDigest,
    expectedRepositoryId: manifest.repositoryId,
    expectedWorkflowId: manifest.workflowId,
    expectedSubjectId: manifest.subjectId,
    expectedSignerId: pairReceipt.signerId,
    expectedIssuerId: pairReceipt.issuerId,
    expectedAudience: pairReceipt.audience,
    expectedNonce: pairReceipt.nonce,
    verificationTime: "2026-07-12T15:00:00Z",
    minimumPolicyEpoch: 3,
    minimumPolicyVersion: 7,
    expectedInstanceId: manifest.instanceId,
    expectedDataEpoch: manifest.dataEpoch,
    revokedReceiptIds: [],
    consumedReceiptIds: [],
    workspaceLock: { workspaceId: request.workspaceId, lockId: "lock:compatibility-p7b", generation: 1, valid: true },
    activeAos: false,
  }, "admissionDigest");
  return { request, admission };
}

function resealRequest(request) {
  request.manifest = seal(request.manifest, "manifestDigest");
  request.pairReceipt.workflowManifestDigest = request.manifest.manifestDigest;
  request.pairReceipt = seal(request.pairReceipt, "receiptDigest");
  return seal(request, "requestDigest");
}

function syncAdmission(admission, request) {
  admission.authenticatedPairReceiptDigest = request.pairReceipt.receiptDigest;
  return seal(admission, "admissionDigest");
}

function reason(code, operation) { assert.throws(operation, (error) => error?.reasonCode === code, code); }

function permutations(values, maximum) {
  const result = [];
  const visit = (prefix, remaining) => {
    if (result.length >= maximum) return;
    if (remaining.length === 0) { result.push(prefix); return; }
    for (let index = 0; index < remaining.length; index += 1) visit([...prefix, remaining[index]], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
  };
  visit([], values);
  return result;
}

function deepWellFormed(value) {
  if (typeof value === "string") return value.isWellFormed();
  if (Array.isArray(value)) return value.every(deepWellFormed);
  return !value || typeof value !== "object" || Object.entries(value).every(([key, item]) => key.isWellFormed() && deepWellFormed(item));
}

test("all six offline modes produce deterministic zero-network zero-mutation plans", () => {
  const operations = ["initial_import", "portable_checkpoint", "fallback_admission", "fallback_delta", "conflict_plan", "reconciliation_dry_run"];
  assert.equal(operations.length, fixture.positiveOperations);
  for (const operation of operations) {
    const { request, admission } = documents(operation);
    const plan = planCompatibilityMode(request, admission);
    const dry = dryRunCompatibilityMode(request, admission);
    assert.equal(plan.reasonCode, "COMPATIBILITY_PLAN_READY");
    assert.equal(dry.reasonCode, "COMPATIBILITY_DRY_RUN_READY");
    assert.deepEqual({ mutation: plan.mutation, network: plan.network }, { mutation: false, network: false });
    assert.deepEqual(plan.preservedAosOperationalKeys, ["assigneeId", "status"]);
    assert.equal(plan.planDigest, planCompatibilityMode(clone(request), clone(admission)).planDigest);
  }
});

test("canonical manifest and governed CLI surfaces are closed and authority-separated", async () => {
  const { request, admission } = documents();
  assert.equal(parseWorkflowCompatibilityManifest(canonicalJson(request.manifest)).manifestDigest, request.manifest.manifestDigest);
  reason("COMPATIBILITY_CANONICAL_INVALID", () => parseWorkflowCompatibilityManifest(` ${canonicalJson(request.manifest)}`));
  let validated = "", planned = "", dry = "", unavailable = "";
  await runCli(["compatibility-validate", "--request", canonicalJson(request)], { write: (value) => { validated = value; } });
  await runCli(["compatibility-plan", "--request", canonicalJson(request)], { compatibilityAdmission: admission, write: (value) => { planned = value; } });
  await runCli(["compatibility-dry-run", "--request", canonicalJson(request)], { compatibilityAdmission: admission, write: (value) => { dry = value; } });
  await runCli(["compatibility-unavailable", "--surface", "aos_primary"], { write: (value) => { unavailable = value; } });
  assert.equal(JSON.parse(validated).reasonCode, "COMPATIBILITY_MANIFEST_VALID");
  assert.equal(JSON.parse(planned).reasonCode, "COMPATIBILITY_PLAN_READY");
  assert.equal(JSON.parse(dry).mutation, false);
  assert.equal(JSON.parse(unavailable).disposition, fixture.capabilityDisposition);
  await assert.rejects(runCli(["compatibility-plan", "--request", canonicalJson(request)], { write() {} }), (error) => error.reasonCode === "COMPATIBILITY_RECEIPT_UNAUTHENTICATED");
  await assert.rejects(runCli(["compatibility-plan", "--request", canonicalJson(request), "--extra", "x"], { compatibilityAdmission: admission, write() {} }), (error) => error.reasonCode === "CLI_ARGUMENT_UNKNOWN");
});

test("every state-changing live surface is exactly unavailable without network or mutation", () => {
  const surfaces = ["aos_primary", "fallback_activation", "import_apply", "reconciliation_apply"];
  assert.equal(surfaces.length, fixture.unavailableSurfaces);
  for (const surface of surfaces) {
    const result = unavailableCompatibilityCapability(surface);
    assert.equal(result.reasonCode, "COMPATIBILITY_CAPABILITY_UNAVAILABLE");
    assert.equal(result.disposition, "capability_unavailable_until_mutual_release");
    assert.deepEqual({ supported: result.supportedAosReleases, mutation: result.mutation, network: result.network }, { supported: [], mutation: false, network: false });
  }
  reason("COMPATIBILITY_INPUT_INVALID", () => unavailableCompatibilityCapability("future_apply"));
});

test("hostile receipt, rollback, replay, split-brain, checkpoint, ownership and limit vectors fail closed", () => {
  const cases = [];
  const mutateAdmission = (change) => { const { request, admission } = documents("fallback_delta"); change(admission, request); return [request, seal(admission, "admissionDigest")]; };
  cases.push(["COMPATIBILITY_REFERENCE_MISMATCH", ...mutateAdmission((a) => { a.expectedRepositoryId = "repository:wrong"; })]);
  cases.push(["COMPATIBILITY_RECEIPT_UNAUTHENTICATED", ...mutateAdmission((a) => { a.expectedSignerId = "signer:wrong"; })]);
  cases.push(["COMPATIBILITY_RECEIPT_UNAUTHENTICATED", ...mutateAdmission((a) => { a.expectedIssuerId = "issuer:wrong"; })]);
  cases.push(["COMPATIBILITY_RECEIPT_UNAUTHENTICATED", ...mutateAdmission((a) => { a.expectedAudience = "wrong"; })]);
  cases.push(["COMPATIBILITY_RECEIPT_UNAUTHENTICATED", ...mutateAdmission((a) => { a.expectedNonce = "wrong"; })]);
  cases.push(["COMPATIBILITY_RECEIPT_EXPIRED", ...mutateAdmission((a) => { a.verificationTime = "2026-07-12T16:00:00Z"; })]);
  cases.push(["COMPATIBILITY_RECEIPT_REVOKED", ...mutateAdmission((a, r) => { a.revokedReceiptIds = [r.pairReceipt.receiptId]; })]);
  cases.push(["COMPATIBILITY_RECEIPT_REPLAYED", ...mutateAdmission((a, r) => { a.consumedReceiptIds = [r.pairReceipt.receiptId]; })]);
  cases.push(["COMPATIBILITY_POLICY_ROLLBACK", ...mutateAdmission((a) => { a.minimumPolicyEpoch = 4; })]);
  cases.push(["COMPATIBILITY_POLICY_ROLLBACK", ...mutateAdmission((a) => { a.minimumPolicyVersion = 8; })]);
  cases.push(["COMPATIBILITY_INSTANCE_MISMATCH", ...mutateAdmission((a) => { a.expectedInstanceId = "instance:wrong"; })]);
  cases.push(["COMPATIBILITY_DATA_EPOCH_MISMATCH", ...mutateAdmission((a) => { a.expectedDataEpoch = 12; })]);
  cases.push(["COMPATIBILITY_WORKSPACE_LOCK_REQUIRED", ...mutateAdmission((a) => { a.workspaceLock = { ...a.workspaceLock, workspaceId: "workspace:wrong" }; })]);
  cases.push(["COMPATIBILITY_SPLIT_BRAIN", ...mutateAdmission((a) => { a.activeAos = true; })]);
  {
    const { request, admission } = documents("fallback_delta"); request.checkpoint.version = 6; cases.push(["COMPATIBILITY_CHECKPOINT_STALE", seal(request, "requestDigest"), admission]);
  }
  {
    const { request, admission } = documents("fallback_delta"); request.checkpoint.instanceId = "instance:wrong"; cases.push(["COMPATIBILITY_INSTANCE_MISMATCH", seal(request, "requestDigest"), admission]);
  }
  {
    const { request, admission } = documents(); request.externalEffectIds = ["effect:alpha", "effect:alpha"]; cases.push(["COMPATIBILITY_EXTERNAL_EFFECT_DUPLICATE", seal(request, "requestDigest"), admission]);
  }
  {
    const { request, admission } = documents(); request.workflowDefinitions.status = "forged"; request.manifest.definitionsDigest = canonicalSha256(request.workflowDefinitions); const changed = resealRequest(request); cases.push(["COMPATIBILITY_FIELD_OWNERSHIP_CONFLICT", changed, syncAdmission(admission, changed)]);
  }
  {
    const { request, admission } = documents(); request.extra = true; cases.push(["COMPATIBILITY_UNKNOWN_FIELD", request, admission]);
  }
  {
    const { request, admission } = documents(); request.manifest.repositoryId = "repository:wrong"; const changed = resealRequest(request); cases.push(["COMPATIBILITY_REFERENCE_MISMATCH", changed, syncAdmission(admission, changed)]);
  }
  {
    const { request, admission } = documents(); request.manifest.supportedAosReleases = ["release:aos-live"]; cases.push(["COMPATIBILITY_MANIFEST_MISMATCH", resealRequest(request), admission]);
  }
  {
    const { request, admission } = documents(); request.aosOperationalState.status = "\ud800"; cases.push(["COMPATIBILITY_UNICODE_INVALID", request, admission]);
  }
  {
    const { request, admission } = documents(); request.pairReceipt.expiresAt = "2026-02-30T00:00:00Z"; cases.push(["COMPATIBILITY_INPUT_INVALID", request, admission]);
  }
  {
    const { request, admission } = documents(); request.externalEffectIds = Array.from({ length: 129 }, (_, index) => `effect:e${index}`); cases.push(["COMPATIBILITY_LIMIT_EXCEEDED", seal(request, "requestDigest"), admission]);
  }
  assert.equal(cases.length, fixture.hostileCases);
  for (const [code, request, admission] of cases) reason(code, () => planCompatibilityMode(request, admission));
});

test("Draft 2020-12 and runtime agree on closed request and Unicode/count representative boundaries", async () => {
  const schema = JSON.parse(await readFile(new URL("../packages/core/schema/compatibility-modes-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: true });
  ajv.addKeyword({ keyword: "x-tcrn-maxUtf8Bytes", schemaType: "number", type: "string", validate: (maximum, value) => Buffer.byteLength(value, "utf8") <= maximum });
  ajv.addKeyword({ keyword: "x-tcrn-wellFormedUnicode", schemaType: "boolean", type: "string", validate: (enabled, value) => !enabled || value.isWellFormed() });
  ajv.addKeyword({ keyword: "x-tcrn-deepWellFormedUnicode", schemaType: "boolean", validate: (enabled, value) => !enabled || deepWellFormed(value) });
  const validate = ajv.compile(schema);
  const base = documents().request;
  const vectors = [
    { ...base, extra: true },
    { ...base, operation: "apply" },
    { ...base, workspaceId: "bad" },
    { ...base, externalEffectIds: Array.from({ length: 129 }, (_, index) => `effect:e${index}`) },
    { ...base, externalEffectIds: ["effect:alpha", "effect:alpha"] },
    { ...base, manifest: { ...base.manifest, extra: true } },
    { ...base, manifest: { ...base.manifest, supportedAosReleases: ["release:aos"] } },
    { ...base, pairReceipt: { ...base.pairReceipt, revoked: true } },
    { ...base, pairReceipt: { ...base.pairReceipt, unknown: true } },
    { ...base, pairReceipt: { ...base.pairReceipt, nonce: "\ud800" } },
    { ...base, workflowDefinitions: { "\udc00": true } },
    { ...base, checkpoint: { checkpointId: "bad", version: 0, instanceId: "instance:x", dataEpoch: 1, stateDigest: "0".repeat(64) } },
  ];
  assert.equal(vectors.length, fixture.schemaParityCases);
  assert.equal(validate(base), true, JSON.stringify(validate.errors));
  assert.doesNotThrow(() => validateCompatibilityRequest(base));
  for (const vector of vectors) {
    assert.equal(validate(vector), false, JSON.stringify(validate.errors));
    assert.throws(() => validateCompatibilityRequest(vector));
  }
});

test("64 distinct real definition insertion orders yield identical plans and corpus digest", () => {
  const keys = ["definition.alpha", "definition.beta", "definition.gamma", "definition.delta", "definition.epsilon"];
  const orders = permutations(keys, fixture.propertyPermutations);
  assert.equal(new Set(orders.map((order) => order.join("|"))).size, 64);
  const plans = orders.map((order) => { const { request, admission } = documents("initial_import", order); return planCompatibilityMode(request, admission); });
  assert.equal(new Set(plans.map((plan) => canonicalJson(plan))).size, 1);
  assert.equal(new Set(plans.map((plan) => plan.planDigest)).size, 1);
  assert.equal(canonicalSha256(orders), fixture.permutationCorpusDigest);
});
