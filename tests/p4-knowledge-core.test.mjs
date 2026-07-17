// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  KNOWLEDGE_LIMITS,
  KnowledgeCoreError,
  acquireWorkspaceLease,
  createKnowledgeUnit,
  createProject,
  createWork,
  deleteWork,
  evaluateKnowledgeFreshness,
  exportKnowledgeCheckpoint,
  initializeKnowledgeStore,
  initializeWorkspace,
  listKnowledgeMetadata,
  readKnowledgeBody,
  readKnowledgeSnippet,
  rebaseKnowledgeStore,
  transitionKnowledgePromotion,
  validateKnowledgeStore,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const instant = (day, second = 0) => `2026-07-${String(day).padStart(2, "0")}T14:00:${String(second).padStart(2, "0")}Z`;
const credentialReference = () => ["https://", "user", ":", "secret", "@", "example.test/current"].join("");
const privateReference = () => ["/", "Users", "/source/current"].join("");

function knowledgeAjv() {
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  ajv.addKeyword({
    keyword: "x-tcrn-maxUtf8Bytes",
    schemaType: "number",
    type: "string",
    validate: (maximumBytes, value) => Buffer.byteLength(value, "utf8") <= maximumBytes,
  });
  return ajv;
}

async function workspaceFixture({ externalKey = "FIXTURE-KNOWLEDGE-CORE", initialize = true } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-p4-knowledge-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey, createdAt: instant(11), segmentEventLimit: 64 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(11, 1) });
  let state;
  try {
    state = await createProject(workspace, lease, {
      expectedVersion: 0,
      occurredAt: instant(11, 1),
      externalKey: "FIXTURE-KNOWLEDGE-PROJECT",
      name: "Knowledge Fixture",
    });
    state = await createWork(workspace, lease, {
      expectedVersion: 1,
      occurredAt: instant(11, 2),
      projectId: state.projects[0].id,
      externalKey: "FIXTURE-KNOWLEDGE-WORK",
      kind: "Initiative",
      parentId: null,
      status: "active",
    });
  } finally {
    await lease.release();
  }
  if (initialize) await initializeKnowledgeStore(workspace);
  return {
    base,
    workspace,
    store: join(workspace, ".tcrn-workflow", "knowledge"),
    projectId: state.projects[0].id,
    workId: state.work[0].id,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

function unitInput(fixture, key, options = {}) {
  return {
    expectedVersion: options.expectedVersion ?? 0,
    occurredAt: options.occurredAt ?? instant(11, 3),
    externalKey: key,
    scope: options.scope ?? "project",
    projectId: options.projectId === undefined ? fixture.projectId : options.projectId,
    roleScopes: options.roleScopes ?? [],
    category: options.category ?? "implementation",
    kind: options.kind ?? "guide",
    tags: options.tags ?? ["knowledge", "workflow"],
    subject: options.subject ?? `Subject ${key}`,
    summary: options.summary ?? `Summary ${key}`,
    snippet: options.snippet ?? `Snippet ${key}`,
    accountableOwnerId: options.accountableOwnerId ?? deriveStableId("owner", `${key}-OWNER`),
    sourceReferences: options.sourceReferences ?? [`evidence://fixture/${key.toLowerCase()}`],
    sourceDigest: options.sourceDigest ?? canonicalSha256({ key, source: "current-explicit" }),
    linkedWorkIds: options.linkedWorkIds ?? [fixture.workId],
    linkedDecisionIds: options.linkedDecisionIds ?? [deriveStableId("decision", `${key}-DECISION`)],
    linkedGateIds: options.linkedGateIds ?? [deriveStableId("gate", `${key}-GATE`)],
    linkedEvidenceIds: options.linkedEvidenceIds ?? [deriveStableId("evidence", `${key}-EVIDENCE`)],
    lifecycle: options.lifecycle ?? "active",
    retrievalDisposition: options.retrievalDisposition ?? "default",
    freshnessState: options.freshnessState ?? "fresh",
    lastVerified: options.lastVerified === undefined ? instant(11, 2) : options.lastVerified,
    stalenessPolicy: options.stalenessPolicy ?? { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
    exportDisposition: options.exportDisposition ?? "metadata-only",
    body: options.body ?? `Body ${key}`,
  };
}

async function expectReason(reasonCode, operation) {
  await assert.rejects(operation, (error) => error?.reasonCode === reasonCode, reasonCode);
}

function settle(operation) {
  return operation.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

function deterministicPermutations(values) {
  const result = [];
  const visit = (prefix, remaining) => {
    if (remaining.length === 0) {
      result.push(prefix);
      return;
    }
    for (let index = 0; index < remaining.length; index += 1) {
      visit([...prefix, remaining[index]], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
    }
  };
  visit([], values);
  return result;
}

test("WSC-1: real workspace knowledge admission requires explicit disposability acknowledgment", async () => {
  const fixture = await workspaceFixture({ externalKey: "REAL-WORKSPACE-ONE", initialize: false });
  try {
    await expectReason("KNOWLEDGE_DISPOSABLE_ACK_REQUIRED", () => initializeKnowledgeStore(fixture.workspace));
    const result = await initializeKnowledgeStore(fixture.workspace, { disposableAcknowledged: true });
    assert.equal(result.reasonCode, "KNOWLEDGE_STORE_INITIALIZED");
    assert.equal(result.admission, "acknowledged-disposable");
    assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
  } finally {
    await fixture.close();
  }
});

test("WSC-1: fixture workspace admits with no flag and reports fixture admission", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-ADMISSION", initialize: false });
  try {
    const result = await initializeKnowledgeStore(fixture.workspace);
    assert.equal(result.reasonCode, "KNOWLEDGE_STORE_INITIALIZED");
    assert.equal(result.admission, "fixture");
  } finally {
    await fixture.close();
  }
});

test("WSC-1: knowledge-init CLI round-trips the acknowledgment flag", async () => {
  const fixture = await workspaceFixture({ externalKey: "REAL-WORKSPACE-CLI", initialize: false });
  try {
    let output = "";
    await runCli(["knowledge-init", "--workspace", fixture.workspace, "--acknowledge-disposable", "true"], { write: (value) => { output += value; } });
    const result = JSON.parse(output);
    assert.equal(result.reasonCode, "KNOWLEDGE_STORE_INITIALIZED");
    assert.equal(result.admission, "acknowledged-disposable");
  } finally {
    await fixture.close();
  }
});

test("WSC-2: knowledge-rebase re-binds the store to an advanced workspace head", async () => {
  const fixture = await workspaceFixture();
  try {
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(20, 1) });
    try {
      await createProject(fixture.workspace, lease, { expectedVersion: 2, occurredAt: instant(20, 2), externalKey: "FIXTURE-KNOWLEDGE-PROJECT-TWO", name: "Two" });
    } finally {
      await lease.release();
    }
    await expectReason("KNOWLEDGE_HIGH_WATER_MISMATCH", () => validateKnowledgeStore(fixture.workspace));
    const result = await rebaseKnowledgeStore(fixture.workspace, { expectedVersion: 0, at: instant(20, 3), retireInvalid: false });
    assert.equal(result.reasonCode, "KNOWLEDGE_STORE_REBASED");
    assert.equal(result.retired, 0);
    assert.deepEqual(result.offenders, []);
    assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
  } finally {
    await fixture.close();
  }
});

test("WSC-2: knowledge-rebase blocks on a link-invalid record and retires it under retire-invalid", async () => {
  const fixture = await workspaceFixture();
  try {
    const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "REBASE-OFFENDER", { expectedVersion: 0 }));
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(21, 1) });
    try {
      await deleteWork(fixture.workspace, lease, { expectedVersion: 2, occurredAt: instant(21, 2), id: fixture.workId });
    } finally {
      await lease.release();
    }
    await expectReason("KNOWLEDGE_REBASE_BLOCKED", () => rebaseKnowledgeStore(fixture.workspace, { expectedVersion: 1, at: instant(21, 3), retireInvalid: false }));
    const result = await rebaseKnowledgeStore(fixture.workspace, { expectedVersion: 1, at: instant(21, 3), retireInvalid: true });
    assert.equal(result.reasonCode, "KNOWLEDGE_STORE_REBASED");
    assert.equal(result.retired, 1);
    assert.deepEqual(result.offenders, [created.id]);
    assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
  } finally {
    await fixture.close();
  }
});

test("WSC-2: knowledge-rebase enforces CAS and fails closed at fault points leaving the store locked", async () => {
  const fixture = await workspaceFixture();
  try {
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(22, 1) });
    try {
      await createProject(fixture.workspace, lease, { expectedVersion: 2, occurredAt: instant(22, 2), externalKey: "FIXTURE-KNOWLEDGE-PROJECT-THREE", name: "Three" });
    } finally {
      await lease.release();
    }
    await expectReason("KNOWLEDGE_CAS_MISMATCH", () => rebaseKnowledgeStore(fixture.workspace, { expectedVersion: 9, at: instant(22, 3), retireInvalid: false }));
    await expectReason("KNOWLEDGE_FAULT_INJECTED", () => rebaseKnowledgeStore(fixture.workspace, { expectedVersion: 0, at: instant(22, 4), retireInvalid: false }, { faultAt: "after-marker-write" }));
    await expectReason("KNOWLEDGE_LOCKED", () => rebaseKnowledgeStore(fixture.workspace, { expectedVersion: 0, at: instant(22, 5), retireInvalid: false }));
  } finally {
    await fixture.close();
  }
});

test("empty Knowledge bootstrap is closed, schema-valid, deterministic, and body-free", async () => {
  const fixture = await workspaceFixture();
  try {
    const validation = await validateKnowledgeStore(fixture.workspace);
    assert.equal(validation.reasonCode, "KNOWLEDGE_STORE_VALID");
    assert.equal(validation.version, 0);
    assert.equal(validation.records, 0);
    assert.deepEqual((await readdir(fixture.store)).sort(), ["bodies", "metadata", "store.json", "views"]);
    assert.deepEqual(await readdir(join(fixture.store, "metadata")), []);
    assert.deepEqual(await readdir(join(fixture.store, "bodies")), []);
    const index1 = await readFile(join(fixture.store, "views", "index.json"), "utf8");
    const index2 = await readFile(join(fixture.store, "views", "index.json"), "utf8");
    assert.equal(index1, index2);
    assert.deepEqual(JSON.parse(index1).records, []);
    const schema = JSON.parse(await readFile(new URL("../packages/core/schema/knowledge-core-v1.schema.json", import.meta.url), "utf8"));
    const ajv = knowledgeAjv();
    assert.equal(ajv.validate(schema, JSON.parse(await readFile(join(fixture.store, "store.json"), "utf8"))), true, JSON.stringify(ajv.errors));
  } finally {
    await fixture.close();
  }
});

test("metadata/body separation, default omission, explicit reads, promotion, freshness, and checkpoint policy are exact", async () => {
  const fixture = await workspaceFixture();
  try {
    const input = unitInput(fixture, "KNOWLEDGE-ALPHA");
    const created = await createKnowledgeUnit(fixture.workspace, input);
    assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    assert.equal(created.version, 1);
    const id = created.id;
    const metadataText = await readFile(join(fixture.store, "metadata", `${id}.json`), "utf8");
    const bodyText = await readFile(join(fixture.store, "bodies", `${id}.body`), "utf8");
    assert.equal(bodyText, input.body);
    assert.equal(metadataText.includes(input.body), false);
    const schema = JSON.parse(await readFile(new URL("../packages/core/schema/knowledge-core-v1.schema.json", import.meta.url), "utf8"));
    const ajv = knowledgeAjv();
    assert.equal(ajv.validate(schema, JSON.parse(metadataText)), true, JSON.stringify(ajv.errors));
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12) })).records.length, 0);
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all" })).records.length, 1);
    assert.equal((await readKnowledgeSnippet(fixture.workspace, id)).snippet, input.snippet);
    await expectReason("KNOWLEDGE_BODY_ACCESS_DENIED", () => readKnowledgeBody(fixture.workspace, id, { at: instant(12) }));
    assert.equal((await readKnowledgeBody(fixture.workspace, id, { at: instant(12), allowUnpromoted: true })).body, input.body);
    const candidateCheckpoint = await exportKnowledgeCheckpoint(fixture.workspace, instant(12));
    assert.equal(candidateCheckpoint.includes(input.body), false);
    assert.deepEqual(JSON.parse(candidateCheckpoint).records, []);
    const promoted = await transitionKnowledgePromotion(fixture.workspace, {
      expectedVersion: 1,
      expectedRevision: 1,
      occurredAt: instant(12, 1),
      id,
      promotionState: "promoted",
    });
    assert.equal(promoted.reasonCode, "KNOWLEDGE_PROMOTION_UPDATED");
    assert.equal(promoted.version, 2);
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12) })).records.length, 1);
    const checkpoint = await exportKnowledgeCheckpoint(fixture.workspace, instant(12));
    assert.equal(checkpoint.includes(input.body), false);
    assert.equal(JSON.parse(checkpoint).records.length, 1);
    assert.equal((await readKnowledgeBody(fixture.workspace, id, { at: instant(12) })).body, input.body);
    assert.equal((await evaluateKnowledgeFreshness(fixture.workspace, instant(12))).records[0].state, "fresh");
    assert.equal((await evaluateKnowledgeFreshness(fixture.workspace, "2026-08-20T14:00:00Z")).records[0].state, "stale");
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: "2026-08-20T14:00:00Z" })).records.length, 0);
    await expectReason("KNOWLEDGE_BODY_ACCESS_DENIED", () => readKnowledgeBody(fixture.workspace, id, { at: "2026-08-20T14:00:00Z" }));
    assert.equal((await readKnowledgeBody(fixture.workspace, id, { at: "2026-08-20T14:00:00Z", allowStale: true })).body, input.body);
    await expectReason("KNOWLEDGE_PROMOTION_INVALID", () => transitionKnowledgePromotion(fixture.workspace, {
      expectedVersion: 2,
      expectedRevision: 2,
      occurredAt: instant(12, 2),
      id,
      promotionState: "rejected",
    }));
  } finally {
    await fixture.close();
  }
});

test("metadata-only surfaces never open bodies while explicit/full integrity paths do", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-METADATA-ONLY" });
  try {
    const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-METADATA-ONLY"));
    await transitionKnowledgePromotion(fixture.workspace, {
      expectedVersion: 1, expectedRevision: 1, occurredAt: instant(12, 1), id: created.id, promotionState: "promoted",
    });
    const bodyPath = join(fixture.store, "bodies", `${created.id}.body`);
    const observed = [];
    const observation = { beforeDescriptorReadForTest: async (path) => { observed.push(path); } };
    await listKnowledgeMetadata(fixture.workspace, { at: instant(12), ...observation });
    await readKnowledgeSnippet(fixture.workspace, created.id, observation);
    await evaluateKnowledgeFreshness(fixture.workspace, instant(12), observation);
    await exportKnowledgeCheckpoint(fixture.workspace, instant(12), observation);
    assert.equal(observed.includes(bodyPath), false);
    observed.length = 0;
    await readKnowledgeBody(fixture.workspace, created.id, { at: instant(12), ...observation });
    assert.deepEqual(observed.filter((path) => path.endsWith(".body")), [bodyPath]);
    observed.length = 0;
    await validateKnowledgeStore(fixture.workspace, observation);
    assert.deepEqual(observed.filter((path) => path.endsWith(".body")), [bodyPath]);

    const backing = join(fixture.base, "body-backing");
    await rename(bodyPath, backing);
    await symlink(backing, bodyPath);
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12) })).records.length, 1);
    assert.equal((await readKnowledgeSnippet(fixture.workspace, created.id)).id, created.id);
    assert.equal((await evaluateKnowledgeFreshness(fixture.workspace, instant(12))).records.length, 1);
    assert.equal(JSON.parse(await exportKnowledgeCheckpoint(fixture.workspace, instant(12))).records.length, 1);
    await expectReason("KNOWLEDGE_LINK_UNSAFE", () => validateKnowledgeStore(fixture.workspace));
    await expectReason("KNOWLEDGE_LINK_UNSAFE", () => readKnowledgeBody(fixture.workspace, created.id, { at: instant(12) }));
  } finally {
    await fixture.close();
  }
});

test("checkpoint is exactly the promoted fresh default-selection corpus", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-CHECKPOINT-PARITY" });
  try {
    const defaultUnit = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-DEFAULT", { expectedVersion: 0 }));
    const explicitUnit = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-EXPLICIT", {
      expectedVersion: 1, occurredAt: instant(11, 4), retrievalDisposition: "explicit-only",
    }));
    await transitionKnowledgePromotion(fixture.workspace, {
      expectedVersion: 2, expectedRevision: 1, occurredAt: instant(12, 1), id: defaultUnit.id, promotionState: "promoted",
    });
    await transitionKnowledgePromotion(fixture.workspace, {
      expectedVersion: 3, expectedRevision: 1, occurredAt: instant(12, 2), id: explicitUnit.id, promotionState: "promoted",
    });
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(12) });
    const checkpoint = JSON.parse(await exportKnowledgeCheckpoint(fixture.workspace, instant(12)));
    assert.deepEqual(checkpoint.records.map((record) => record.id), listed.records.map((record) => record.id));
    assert.deepEqual(checkpoint.records.map((record) => record.id), [defaultUnit.id]);
    assert.equal(checkpoint.records.some((record) => record.id === explicitUnit.id), false);
  } finally {
    await fixture.close();
  }
});

test("unknown freshness fails closed and metadata filters remain deterministic", async () => {
  const fixture = await workspaceFixture();
  try {
    const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-UNKNOWN", {
      freshnessState: "unknown",
      lastVerified: null,
      roleScopes: ["reviewer"],
      scope: "role",
      category: "testing",
      tags: ["review", "testing"],
    }));
    assert.equal((await evaluateKnowledgeFreshness(fixture.workspace, instant(12))).records[0].state, "unknown");
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12) })).records.length, 0);
    const filtered = await listKnowledgeMetadata(fixture.workspace, {
      at: instant(12), selection: "all", roleScope: "reviewer", category: "testing", tag: "review", freshness: "unknown",
    });
    assert.equal(filtered.records.length, 1);
    await expectReason("KNOWLEDGE_BODY_ACCESS_DENIED", () => readKnowledgeBody(fixture.workspace, created.id, {
      at: instant(12), allowUnpromoted: true,
    }));
  } finally {
    await fixture.close();
  }
});

test("governed Knowledge CLI exposes init, validate, create, list, snippet, body, freshness, promotion, and checkpoint", async () => {
  const fixture = await workspaceFixture({ initialize: false, externalKey: "FIXTURE-KNOWLEDGE-CLI" });
  try {
    let output = "";
    await runCli(["knowledge-init", "--workspace", fixture.workspace], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).reasonCode, "KNOWLEDGE_STORE_INITIALIZED");
    const input = unitInput(fixture, "KNOWLEDGE-CLI");
    const createArguments = [
      "knowledge-create", "--workspace", fixture.workspace, "--expected-version", "0", "--at", input.occurredAt,
      "--external-key", input.externalKey, "--scope", input.scope, "--project-id", input.projectId,
      "--role-scopes", "-", "--category", input.category, "--kind", input.kind, "--tags", input.tags.join(","),
      "--subject", input.subject, "--summary", input.summary, "--snippet", input.snippet,
      "--accountable-owner-id", input.accountableOwnerId,
      "--source-references", input.sourceReferences.join(","), "--source-digest", input.sourceDigest,
      "--work-ids", input.linkedWorkIds.join(","), "--decision-ids", input.linkedDecisionIds.join(","),
      "--gate-ids", input.linkedGateIds.join(","), "--evidence-ids", input.linkedEvidenceIds.join(","),
      "--lifecycle", input.lifecycle, "--retrieval", input.retrievalDisposition, "--freshness", input.freshnessState,
      "--last-verified", input.lastVerified, "--stale-days", String(input.stalenessPolicy.maximumAgeDays),
      "--export", input.exportDisposition, "--body", input.body,
    ];
    output = "";
    await runCli(createArguments, { write: (value) => { output += value; } });
    const created = JSON.parse(output);
    assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    for (const [command, extra, expected] of [
      ["knowledge-validate", [], "KNOWLEDGE_STORE_VALID"],
      ["knowledge-list", ["--at", instant(12), "--selection", "all"], "KNOWLEDGE_LIST_READY"],
      ["knowledge-freshness", ["--at", instant(12)], "KNOWLEDGE_FRESHNESS_EVALUATED"],
    ]) {
      output = "";
      await runCli([command, "--workspace", fixture.workspace, ...extra], { write: (value) => { output += value; } });
      assert.equal(JSON.parse(output).reasonCode, expected);
    }
    output = "";
    await runCli(["knowledge-snippet", "--workspace", fixture.workspace, "--id", created.id], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).snippet, input.snippet);
    output = "";
    await runCli(["knowledge-body", "--workspace", fixture.workspace, "--id", created.id, "--at", instant(12), "--allow-unpromoted", "true"],
      { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).body, input.body);
    output = "";
    await expectReason("KNOWLEDGE_PROMOTION_INVALID", () => runCli([
      "knowledge-promote", "--workspace", fixture.workspace, "--expected-version", "1", "--expected-revision", "1",
      "--at", instant(12, 1), "--id", created.id, "--state", "approved",
    ], { write() {} }));
    assert.equal((await readdir(fixture.store)).includes("mutation.claim"), false);
    assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
    output = "";
    await runCli(["knowledge-promote", "--workspace", fixture.workspace, "--expected-version", "1", "--expected-revision", "1",
      "--at", instant(12, 1), "--id", created.id, "--state", "promoted"], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).reasonCode, "KNOWLEDGE_PROMOTION_UPDATED");
    output = "";
    await runCli(["knowledge-checkpoint", "--workspace", fixture.workspace, "--at", instant(12)], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).reasonCode, "KNOWLEDGE_CHECKPOINT_READY");
    await expectReason("KNOWLEDGE_SELECTION_INVALID", () => runCli([
      "knowledge-list", "--workspace", fixture.workspace, "--at", instant(12), "--selection", "everything",
    ], { write() {} }));
  } finally {
    await fixture.close();
  }
});

test("selection and strict evaluation instants fail before Knowledge-store scanning", async () => {
  const empty = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-VALIDATION-ORDER" });
  try {
    let opened = false;
    const observer = { beforeDescriptorReadForTest: async () => { opened = true; } };
    await expectReason("KNOWLEDGE_SELECTION_INVALID", () => listKnowledgeMetadata(empty.workspace, {
      at: instant(12), selection: "candidate-leak", ...observer,
    }));
    assert.equal(opened, false);
    await expectReason("KNOWLEDGE_INPUT_INVALID", () => evaluateKnowledgeFreshness(empty.workspace, "2026-07-11", observer));
    assert.equal(opened, false);
    await expectReason("KNOWLEDGE_INPUT_INVALID", () => exportKnowledgeCheckpoint(empty.workspace, "not-an-instant", observer));
    assert.equal(opened, false);
    await createKnowledgeUnit(empty.workspace, unitInput(empty, "KNOWLEDGE-INELIGIBLE", {
      retrievalDisposition: "excluded", freshnessState: "unknown", lastVerified: null,
    }));
    opened = false;
    await expectReason("KNOWLEDGE_INPUT_INVALID", () => exportKnowledgeCheckpoint(empty.workspace, "2026-02-30T00:00:00Z", observer));
    assert.equal(opened, false);
    await expectReason("KNOWLEDGE_INPUT_INVALID", () => evaluateKnowledgeFreshness(empty.workspace, "2026-02-30T00:00:00Z", observer));
    assert.equal(opened, false);
  } finally {
    await empty.close();
  }
});

test("explicit-current-source provenance requires source, evidence, and accountable owner", async () => {
  for (const [label, override] of [
    ["source", { sourceReferences: [] }],
    ["evidence", { linkedEvidenceIds: [] }],
    ["owner-empty", { accountableOwnerId: "" }],
    ["owner-namespace", { accountableOwnerId: deriveStableId("profile", "UNADMITTED-OWNER") }],
  ]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-PROVENANCE-${label.toUpperCase()}` });
    try {
      await expectReason("KNOWLEDGE_PROVENANCE_INVALID", () => createKnowledgeUnit(
        fixture.workspace,
        unitInput(fixture, `KNOWLEDGE-PROVENANCE-${label.toUpperCase()}`, override),
      ));
    } finally {
      await fixture.close();
    }
  }
  for (const field of ["sourceReferences", "linkedEvidenceIds", "accountableOwnerId"]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-PROMOTION-${field.toUpperCase()}` });
    try {
      const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, `KNOWLEDGE-PROMOTION-${field.toUpperCase()}`));
      const metadataPath = join(fixture.store, "metadata", `${created.id}.json`);
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      metadata[field] = field === "accountableOwnerId" ? deriveStableId("profile", "UNADMITTED-OWNER") : [];
      await writeFile(metadataPath, canonicalJson(metadata));
      await expectReason("KNOWLEDGE_PROVENANCE_INVALID", () => transitionKnowledgePromotion(fixture.workspace, {
        expectedVersion: 1, expectedRevision: 1, occurredAt: instant(12), id: created.id, promotionState: "promoted",
      }));
    } finally {
      await fixture.close();
    }
  }
});

test("64 real insertion orders produce exact index, list, and checkpoint parity", async () => {
  const fixtureContract = JSON.parse(await readFile(
    new URL("../packages/core/fixtures/p4-knowledge-core-cases.json", import.meta.url),
    "utf8",
  ));
  const logicalKeys = ["KNOWLEDGE-PERM-A", "KNOWLEDGE-PERM-B", "KNOWLEDGE-PERM-C", "KNOWLEDGE-PERM-D", "KNOWLEDGE-PERM-E"];
  const orders = deterministicPermutations(logicalKeys).slice(0, fixtureContract.propertyPermutations);
  assert.equal(orders.length, 64);
  assert.equal(new Set(orders.map((order) => JSON.stringify(order))).size, 64);
  const corpusDigest = canonicalSha256(orders);
  assert.equal(corpusDigest, fixtureContract.permutationCorpusDigest);
  let baseline;
  for (const order of orders) {
    const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-PERMUTATION-CORPUS" });
    try {
      for (const [version, key] of order.entries()) {
        await createKnowledgeUnit(fixture.workspace, unitInput(fixture, key, {
          expectedVersion: version,
          occurredAt: instant(11, 3 + logicalKeys.indexOf(key)),
        }));
      }
      for (const [index, key] of logicalKeys.entries()) {
        await transitionKnowledgePromotion(fixture.workspace, {
          expectedVersion: logicalKeys.length + index,
          expectedRevision: 1,
          occurredAt: instant(12, index),
          id: deriveStableId("knowledge", key),
          promotionState: "promoted",
        });
      }
      const indexBytes = await readFile(join(fixture.store, "views", "index.json"), "utf8");
      const listBytes = canonicalJson(await listKnowledgeMetadata(fixture.workspace, { at: instant(12) }));
      const checkpointBytes = await exportKnowledgeCheckpoint(fixture.workspace, instant(12));
      const observation = {
        indexBytes,
        indexDigest: JSON.parse(indexBytes).indexDigest,
        listBytes,
        listDigest: JSON.parse(listBytes).resultDigest,
        checkpointBytes,
        checkpointDigest: JSON.parse(checkpointBytes).checkpointDigest,
      };
      baseline ??= observation;
      assert.deepEqual(observation, baseline);
    } finally {
      await fixture.close();
    }
  }
});

test("input, link, redaction, Unicode, body, summary, and snippet boundaries fail closed", async () => {
  for (const [label, mutate, reasonCode] of [
    ["body", (input) => ({ ...input, body: "x".repeat(KNOWLEDGE_LIMITS.maximumBodyBytes + 1) }), "KNOWLEDGE_LIMIT_EXCEEDED"],
    ["summary", (input) => ({ ...input, summary: "x".repeat(KNOWLEDGE_LIMITS.maximumSummaryBytes + 1) }), "KNOWLEDGE_LIMIT_EXCEEDED"],
    ["snippet", (input) => ({ ...input, snippet: "x".repeat(KNOWLEDGE_LIMITS.maximumSnippetBytes + 1) }), "KNOWLEDGE_LIMIT_EXCEEDED"],
    ["unicode", (input) => ({ ...input, subject: `broken-${String.fromCharCode(0xd800)}` }), "KNOWLEDGE_CANONICAL_INVALID"],
    ["work-link", (input) => ({ ...input, linkedWorkIds: [deriveStableId("work", "MISSING")] }), "KNOWLEDGE_LINK_INVALID"],
    ["credential", (input) => ({ ...input, sourceReferences: [credentialReference()] }), "KNOWLEDGE_REDACTION_REQUIRED"],
    ["query", (input) => ({ ...input, sourceReferences: ["evidence://fixture/current?credential=raw"] }), "KNOWLEDGE_REDACTION_REQUIRED"],
    ["private", (input) => ({ ...input, sourceReferences: [privateReference()] }), "KNOWLEDGE_REDACTION_REQUIRED"],
  ]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-BOUNDARY-${label.toUpperCase()}` });
    try {
      await expectReason(reasonCode, () => createKnowledgeUnit(fixture.workspace, mutate(unitInput(fixture, `KNOWLEDGE-${label.toUpperCase()}`))));
    } finally {
      await fixture.close();
    }
  }
  const liveLike = await workspaceFixture({ externalKey: "LIVE-LIKE-KNOWLEDGE", initialize: false });
  try {
    await expectReason("KNOWLEDGE_DISPOSABLE_ACK_REQUIRED", () => initializeKnowledgeStore(liveLike.workspace));
  } finally {
    await liveLike.close();
  }
});

test("custom schema proof enforces the normative UTF-8 byte budgets", async () => {
  const schema = JSON.parse(await readFile(new URL("../packages/core/schema/knowledge-core-v1.schema.json", import.meta.url), "utf8"));
  const customAjv = knowledgeAjv();
  const stockAjv = new Ajv2020({ strict: false, validateFormats: false });
  const boundary = (maximumBytes, prefix = "") => {
    const remaining = maximumBytes - Buffer.byteLength(prefix, "utf8");
    return `${prefix}${"é".repeat(Math.floor(remaining / 2))}${remaining % 2 === 0 ? "" : "a"}`;
  };
  for (const [field, maximumBytes, prefix] of [
    ["subject", 512, ""],
    ["summary", KNOWLEDGE_LIMITS.maximumSummaryBytes, ""],
    ["snippet", KNOWLEDGE_LIMITS.maximumSnippetBytes, ""],
    ["sourceReferences", 512, "evidence-ref-"],
  ]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-UTF8-${field.toUpperCase()}` });
    try {
      const exact = boundary(maximumBytes, prefix);
      assert.equal(Buffer.byteLength(exact, "utf8"), maximumBytes);
      const exactOverride = field === "sourceReferences" ? { sourceReferences: [exact] } : { [field]: exact };
      const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, `KNOWLEDGE-UTF8-${field.toUpperCase()}`, exactOverride));
      const metadata = JSON.parse(await readFile(join(fixture.store, "metadata", `${created.id}.json`), "utf8"));
      assert.equal(customAjv.validate(schema, metadata), true, JSON.stringify(customAjv.errors));
      const over = `${exact}a`;
      assert.equal(Buffer.byteLength(over, "utf8"), maximumBytes + 1);
      const overMetadata = structuredClone(metadata);
      if (field === "sourceReferences") overMetadata.sourceReferences = [over];
      else overMetadata[field] = over;
      assert.equal(stockAjv.validate(schema, overMetadata), true, JSON.stringify(stockAjv.errors));
      assert.equal(customAjv.validate(schema, overMetadata), false);
    } finally {
      await fixture.close();
    }
    const runtime = await workspaceFixture({ externalKey: `FIXTURE-UTF8-OVER-${field.toUpperCase()}` });
    try {
      const over = `${boundary(maximumBytes, prefix)}a`;
      const overOverride = field === "sourceReferences" ? { sourceReferences: [over] } : { [field]: over };
      await expectReason("KNOWLEDGE_LIMIT_EXCEEDED", () => createKnowledgeUnit(
        runtime.workspace,
        unitInput(runtime, `KNOWLEDGE-UTF8-OVER-${field.toUpperCase()}`, overOverride),
      ));
    } finally {
      await runtime.close();
    }
  }
});

test("duplicate, CAS, promotion, and concurrent writer integrity fail closed", async () => {
  const fixture = await workspaceFixture();
  try {
    const input = unitInput(fixture, "KNOWLEDGE-CAS");
    const created = await createKnowledgeUnit(fixture.workspace, input);
    await expectReason("KNOWLEDGE_PROMOTION_INVALID", () => transitionKnowledgePromotion(fixture.workspace, {
      expectedVersion: 1, expectedRevision: 1, occurredAt: instant(12), id: created.id, promotionState: "approved",
    }));
    assert.equal((await readdir(fixture.store)).includes("mutation.claim"), false);
    assert.equal((await validateKnowledgeStore(fixture.workspace)).version, 1);
    await expectReason("KNOWLEDGE_DUPLICATE", () => createKnowledgeUnit(fixture.workspace, { ...input, expectedVersion: 1 }));
    await expectReason("KNOWLEDGE_CAS_MISMATCH", () => transitionKnowledgePromotion(fixture.workspace, {
      expectedVersion: 0, expectedRevision: 1, occurredAt: instant(12), id: created.id, promotionState: "promoted",
    }));
    await expectReason("KNOWLEDGE_CAS_MISMATCH", () => transitionKnowledgePromotion(fixture.workspace, {
      expectedVersion: 1, expectedRevision: 2, occurredAt: instant(12), id: created.id, promotionState: "promoted",
    }));
    assert.equal((await transitionKnowledgePromotion(fixture.workspace, {
      expectedVersion: 1, expectedRevision: 1, occurredAt: instant(12), id: created.id, promotionState: "promoted",
    })).version, 2);
  } finally {
    await fixture.close();
  }
  const concurrent = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-CONCURRENT" });
  try {
    const outcomes = await Promise.all([
      settle(createKnowledgeUnit(concurrent.workspace, unitInput(concurrent, "KNOWLEDGE-CONCURRENT-A"))),
      settle(createKnowledgeUnit(concurrent.workspace, unitInput(concurrent, "KNOWLEDGE-CONCURRENT-B"))),
    ]);
    assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
    const rejected = outcomes.find((entry) => entry.status === "rejected");
    assert.ok(["KNOWLEDGE_LOCKED", "KNOWLEDGE_CAS_MISMATCH"].includes(rejected.reason.reasonCode));
    assert.equal((await validateKnowledgeStore(concurrent.workspace)).version, 1);
  } finally {
    await concurrent.close();
  }
});

test("link, special-file, source-replacement, unknown-field, and partial-state attacks fail closed", async () => {
  for (const kind of ["symlink", "hardlink", "directory"]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-KNOWLEDGE-${kind.toUpperCase()}` });
    try {
      const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, `KNOWLEDGE-${kind.toUpperCase()}`));
      const bodyPath = join(fixture.store, "bodies", `${created.id}.body`);
      const backing = join(fixture.base, `body-${kind}`);
      if (kind === "symlink") {
        await rename(bodyPath, backing);
        await symlink(backing, bodyPath);
      } else if (kind === "hardlink") {
        await link(bodyPath, backing);
      } else {
        await unlink(bodyPath);
        await mkdir(bodyPath);
      }
      await expectReason(kind === "directory" ? "KNOWLEDGE_SPECIAL_FILE" : "KNOWLEDGE_LINK_UNSAFE", () => validateKnowledgeStore(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }
  const replacement = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-REPLACEMENT" });
  try {
    const input = unitInput(replacement, "KNOWLEDGE-REPLACEMENT");
    const created = await createKnowledgeUnit(replacement.workspace, input);
    const bodyPath = join(replacement.store, "bodies", `${created.id}.body`);
    let replaced = false;
    await expectReason("KNOWLEDGE_SOURCE_CHANGED", () => readKnowledgeBody(replacement.workspace, created.id, {
      at: instant(12), allowUnpromoted: true,
      async beforeDescriptorReadForTest(path) {
        if (!replaced && path === bodyPath) {
          replaced = true;
          await rename(bodyPath, `${bodyPath}.old`);
          await writeFile(bodyPath, input.body);
        }
      },
    }));
  } finally {
    await replacement.close();
  }
  const malformed = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-MALFORMED" });
  try {
    const created = await createKnowledgeUnit(malformed.workspace, unitInput(malformed, "KNOWLEDGE-MALFORMED"));
    const path = join(malformed.store, "metadata", `${created.id}.json`);
    const metadata = JSON.parse(await readFile(path, "utf8"));
    metadata.extraAuthority = true;
    await writeFile(path, canonicalJson(metadata));
    await expectReason("KNOWLEDGE_RECORD_INVALID", () => validateKnowledgeStore(malformed.workspace));
  } finally {
    await malformed.close();
  }
  const malformedType = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-MALFORMED-TYPE" });
  try {
    const created = await createKnowledgeUnit(malformedType.workspace, unitInput(malformedType, "KNOWLEDGE-MALFORMED-TYPE"));
    const path = join(malformedType.store, "metadata", `${created.id}.json`);
    const metadata = JSON.parse(await readFile(path, "utf8"));
    metadata.subject = 7;
    await writeFile(path, canonicalJson(metadata));
    await expectReason("KNOWLEDGE_RECORD_INVALID", () => validateKnowledgeStore(malformedType.workspace));
  } finally {
    await malformedType.close();
  }
  for (const faultAt of ["after-body-write", "after-metadata-write", "after-marker-write"]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-KNOWLEDGE-FAULT-${faultAt.toUpperCase()}` });
    try {
      await expectReason("KNOWLEDGE_FAULT_INJECTED", () => createKnowledgeUnit(
        fixture.workspace,
        unitInput(fixture, `KNOWLEDGE-FAULT-${faultAt.toUpperCase()}`),
        { faultAt },
      ));
      await expectReason("KNOWLEDGE_PARTIAL_STATE", () => validateKnowledgeStore(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }
});

test("record-count and query-result limits are executable", async () => {
  const count = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-COUNT" });
  try {
    for (let index = 0; index <= KNOWLEDGE_LIMITS.maximumRecords; index += 1) {
      const id = `knowledge:${index.toString(16).padStart(24, "0")}`;
      await writeFile(join(count.store, "metadata", `${id}.json`), "{}");
      await writeFile(join(count.store, "bodies", `${id}.body`), "");
    }
    await expectReason("KNOWLEDGE_LIMIT_EXCEEDED", () => validateKnowledgeStore(count.workspace));
  } finally {
    await count.close();
  }
  const query = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-QUERY" });
  try {
    for (let index = 0; index <= KNOWLEDGE_LIMITS.maximumQueryResults; index += 1) {
      await createKnowledgeUnit(query.workspace, unitInput(query, `KNOWLEDGE-QUERY-${index}`, {
        expectedVersion: index,
        occurredAt: instant(11, 3 + index),
      }));
    }
    await expectReason("KNOWLEDGE_LIMIT_EXCEEDED", () => listKnowledgeMetadata(query.workspace, { at: instant(12), selection: "all" }));
  } finally {
    await query.close();
  }
  const aggregate = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-AGGREGATE" });
  try {
    let rejected = false;
    for (let index = 0; index < KNOWLEDGE_LIMITS.maximumRecords; index += 1) {
      try {
        await createKnowledgeUnit(aggregate.workspace, unitInput(aggregate, `KNOWLEDGE-AGGREGATE-${index}`, {
          expectedVersion: index,
          occurredAt: instant(11, 3 + index),
          body: "x".repeat(7_500),
        }));
      } catch (error) {
        assert.equal(error.reasonCode, "KNOWLEDGE_LIMIT_EXCEEDED");
        rejected = true;
        break;
      }
    }
    assert.equal(rejected, true);
    assert.equal((await validateKnowledgeStore(aggregate.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
    await expectReason("KNOWLEDGE_PATH_INVALID", () => readKnowledgeBody(aggregate.workspace, "../escape", {
      at: instant(12), allowUnpromoted: true, allowStale: true,
    }));
  } finally {
    await aggregate.close();
  }
});

test("Knowledge implementation has no predecessor, network, database, or AOS read authority", async () => {
  const sources = [
    new URL("../packages/core/src/knowledge-core.ts", import.meta.url),
    new URL("../packages/cli/src/index.ts", import.meta.url),
  ];
  const forbidden = [
    String.fromCharCode(86, 97, 117, 108, 116),
    String.fromCharCode(47, 102, 97, 99, 116, 115, 47),
    String.fromCharCode(47, 105, 110, 105, 116, 105, 97, 116, 105, 118, 101, 115, 47),
    String.fromCharCode(110, 111, 100, 101, 58, 104, 116, 116, 112),
    String.fromCharCode(110, 111, 100, 101, 58, 110, 101, 116),
    String.fromCharCode(102, 101, 116, 99, 104, 40),
    String.fromCharCode(65, 79, 83, 95),
  ];
  for (const sourcePath of sources) {
    const source = await readFile(sourcePath, "utf8");
    for (const token of forbidden) assert.equal(source.includes(token), false, `${sourcePath.pathname}:${token}`);
  }
  const corePackage = JSON.parse(await readFile(new URL("../packages/core/package.json", import.meta.url), "utf8"));
  const cliPackage = JSON.parse(await readFile(new URL("../packages/cli/package.json", import.meta.url), "utf8"));
  assert.deepEqual(corePackage.dependencies ?? {}, {});
  assert.deepEqual(cliPackage.dependencies ?? {}, {});
  assert.ok(KnowledgeCoreError.prototype instanceof Error);
});
