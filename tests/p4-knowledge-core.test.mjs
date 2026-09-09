// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  checkKnowledgeSources,
  createKnowledgeUnit,
  knowledgeLinkIndexCountsForTest,
  createProject,
  createWork,
  deleteWork,
  evaluateKnowledgeFreshness,
  exportKnowledgeCheckpoint,
  initializeKnowledgeStore,
  initializeWorkspace,
  knowledgeContextCandidates,
  listKnowledgeMetadata,
  materializeWorkspace,
  readKnowledgeBody,
  readKnowledgeSnippet,
  rebaseKnowledgeStore,
  retireKnowledgeUnit,
  reverifyKnowledgeUnit,
  transitionKnowledgePromotion,
  validateKnowledgeStore,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const instant = (day, second = 0) => `2026-07-${String(day).padStart(2, "0")}T14:00:${String(second).padStart(2, "0")}Z`;
const joinParts = (parts, separator) => parts.join(separator);
const credentialReference = () => joinParts(["https://", "user", ":", "secret", "@", "example.test/current"], "");
const privateReference = () => joinParts(["/", "Users", "/source/current"], "");

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
    sourceDigest: options.sourceDigest === undefined ? canonicalSha256({ key, source: "current-explicit" }) : options.sourceDigest,
    supersedes: options.supersedes ?? null,
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
    // TCRN-CROSS-STORY-365: this fixture writes a family of cards that differ only by
    // key, so the write-time conflict scorer sees each one as a possible duplicate of
    // the last. That is the scorer being right about a deliberate fixture, so the
    // fixture states the writer's answer once instead of per case.
    coexist: options.coexist ?? true,
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

async function cliJson(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
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
    // WSC-6: the two claim-state assertions below are the executable form of the crash
    // contract. A failure that leaves the process alive must give the claim back, so the
    // store stays usable; a simulated crash must NOT, because a real SIGKILL cannot run a
    // finally block and the retained claim is what marks the store as mid-write. Removing
    // the KNOWLEDGE_FAULT_INJECTED exemption from the mutation finallys flips the second.
    assert.equal((await readdir(fixture.store)).includes("mutation.claim"), false);
    await expectReason("KNOWLEDGE_FAULT_INJECTED", () => rebaseKnowledgeStore(fixture.workspace, { expectedVersion: 0, at: instant(22, 4), retireInvalid: false }, { faultAt: "after-marker-write" }));
    assert.equal((await readdir(fixture.store)).includes("mutation.claim"), true);
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
    // TCRN-CROSS-INC-282 (Owner ruling TCRN-CROSS-MIN-158 D1): the default selection is
    // every active card, so a card answers the default listing, the body read and the
    // checkpoint from the moment it is written, before any promotion step. Withholding it
    // until promotion is what made a written card unretrievable with no signal.
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12) })).records.length, 1);
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all" })).records.length, 1);
    assert.equal((await readKnowledgeSnippet(fixture.workspace, id)).snippet, input.snippet);
    assert.equal((await readKnowledgeBody(fixture.workspace, id, { at: instant(12) })).body, input.body);
    assert.equal((await readKnowledgeBody(fixture.workspace, id, { at: instant(12), allowUnpromoted: true })).body, input.body);
    const writtenCheckpoint = await exportKnowledgeCheckpoint(fixture.workspace, instant(12));
    assert.equal(writtenCheckpoint.includes(input.body), false);
    assert.equal(JSON.parse(writtenCheckpoint).records.length, 1, "the checkpoint corpus is the default selection, which a written card joins at once");
    // TCRN-CROSS-INC-282: an active write is already promoted, so the promote verb has
    // nothing to move here and refuses rather than repeating itself. The candidate-to-
    // promoted transition is proved on the lifecycle-"candidate" path, which is the only
    // writer that still produces a candidate.
    await expectReason("KNOWLEDGE_PROMOTION_INVALID", () => transitionKnowledgePromotion(fixture.workspace, {
      expectedVersion: 1,
      expectedRevision: 1,
      occurredAt: instant(12, 1),
      id,
      promotionState: "promoted",
    }));
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
      expectedVersion: 1,
      expectedRevision: 1,
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
    // TCRN-CROSS-INC-282: no promote step -- an active write is already promoted.
    const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-METADATA-ONLY"));
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
    // TCRN-CROSS-INC-282: both cards are promoted at write; what keeps the explicit-only
    // card out of the checkpoint is its retrieval disposition, which is the point.
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
    assert.equal((await evaluateKnowledgeFreshness(fixture.workspace, instant(12))).records[0].state, "fresh");
    // TCRN-CROSS-INC-282: an unknown-freshness card that computes fresh is an active card,
    // so the default selection carries it. It used to be withheld for being unpromoted.
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12) })).records.length, 1);
    const filtered = await listKnowledgeMetadata(fixture.workspace, {
      at: instant(12), selection: "all", roleScope: "reviewer", category: "testing", tag: "review", freshness: "fresh",
    });
    assert.equal(filtered.records.length, 1);
    assert.equal((await readKnowledgeBody(fixture.workspace, created.id, { at: instant(12), allowUnpromoted: true })).body, "Body KNOWLEDGE-UNKNOWN");
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
    // TCRN-CROSS-INC-282: written lifecycle "candidate" so the knowledge-promote leg below
    // still has a candidate to move. An active write lands promoted and refuses promotion.
    const input = unitInput(fixture, "KNOWLEDGE-CLI", { lifecycle: "candidate" });
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

test("WSB-4: knowledge-create null sentinel '-' round-trips to null and the deprecated 'null' alias is byte-equivalent", async () => {
  const sentinelInput = (fixture) => unitInput(fixture, "KNOWLEDGE-SENTINEL", {
    expectedVersion: 0,
    scope: "workspace",
    projectId: null,
    roleScopes: [],
    linkedWorkIds: [],
    freshnessState: "unknown",
    lastVerified: null,
  });
  const listFlag = (values) => (values.length === 0 ? "-" : values.join(","));
  const createArguments = (fixture, projectSpelling, lastVerifiedSpelling) => {
    const input = sentinelInput(fixture);
    return [
      "knowledge-create", "--workspace", fixture.workspace, "--expected-version", "0", "--at", input.occurredAt,
      "--external-key", input.externalKey, "--scope", input.scope, "--project-id", projectSpelling,
      "--role-scopes", "-", "--category", input.category, "--kind", input.kind, "--tags", listFlag(input.tags),
      "--subject", input.subject, "--summary", input.summary, "--snippet", input.snippet,
      "--accountable-owner-id", input.accountableOwnerId,
      "--source-references", listFlag(input.sourceReferences), "--source-digest", input.sourceDigest,
      "--work-ids", listFlag(input.linkedWorkIds), "--decision-ids", listFlag(input.linkedDecisionIds),
      "--gate-ids", listFlag(input.linkedGateIds), "--evidence-ids", listFlag(input.linkedEvidenceIds),
      "--lifecycle", input.lifecycle, "--retrieval", input.retrievalDisposition, "--freshness", input.freshnessState,
      "--last-verified", lastVerifiedSpelling, "--stale-days", String(input.stalenessPolicy.maximumAgeDays),
      "--export", input.exportDisposition, "--body", input.body,
    ];
  };
  const storedRecord = async (fixture, created) => {
    const view = JSON.parse(await readFile(join(fixture.store, "views", "index.json"), "utf8"));
    return view.records.find((entry) => entry.id === created.id);
  };
  const createViaCli = async (projectSpelling, lastVerifiedSpelling) => {
    const fixture = await workspaceFixture({ initialize: false, externalKey: "FIXTURE-KNOWLEDGE-SENTINEL" });
    await runCli(["knowledge-init", "--workspace", fixture.workspace], { write() {} });
    let output = "";
    await runCli(createArguments(fixture, projectSpelling, lastVerifiedSpelling), { write: (value) => { output += value; } });
    const created = JSON.parse(output);
    return { fixture, created, output, record: await storedRecord(fixture, created) };
  };

  const dash = await createViaCli("-", "-");
  const alias = await createViaCli("null", "null");
  const programmatic = await workspaceFixture({ initialize: false, externalKey: "FIXTURE-KNOWLEDGE-SENTINEL" });
  try {
    assert.equal(dash.created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    // '-' is the canonical null spelling for both flags.
    assert.equal(dash.record.projectId, null);
    assert.equal(dash.record.lastVerified, null);
    // Deprecated 'null' alias produces a byte-identical committed record and envelope.
    assert.equal(alias.output, dash.output);
    assert.deepEqual(alias.record, dash.record);
    // The CLI '-' spelling round-trips to the same stored record as programmatic explicit nulls.
    await initializeKnowledgeStore(programmatic.workspace);
    const direct = await createKnowledgeUnit(programmatic.workspace, sentinelInput(programmatic));
    const directRecord = await storedRecord(programmatic, direct);
    assert.deepEqual(directRecord, dash.record);
  } finally {
    await dash.fixture.close();
    await alias.fixture.close();
    await programmatic.close();
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

test("WSC-3: provenance is enforced at capture for an active card and at promotion for a candidate", async () => {
  // TCRN-CROSS-INC-282: an active write is a promoted write, so a missing owner, source or
  // evidence is refused where the writer can see it instead of being parked in a state no
  // reader returns. A record its own author wrote as lifecycle "candidate" keeps the cheap
  // path: written without full provenance, rejectable without it, unpromotable until it
  // carries it.
  const incompleteProvenance = [
    ["source", { sourceReferences: [] }],
    ["evidence", { linkedEvidenceIds: [] }],
    ["owner-empty", { accountableOwnerId: "" }],
    ["owner-namespace", { accountableOwnerId: deriveStableId("profile", "UNADMITTED-OWNER") }],
  ];
  for (const [label, override] of incompleteProvenance) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-PROVENANCE-ACTIVE-${label.toUpperCase()}` });
    try {
      await expectReason("KNOWLEDGE_PROVENANCE_INVALID", () => createKnowledgeUnit(
        fixture.workspace,
        unitInput(fixture, `KNOWLEDGE-PROVENANCE-ACTIVE-${label.toUpperCase()}`, override),
      ));
    } finally {
      await fixture.close();
    }
  }
  for (const [label, override] of incompleteProvenance) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-PROVENANCE-${label.toUpperCase()}` });
    try {
      const created = await createKnowledgeUnit(
        fixture.workspace,
        unitInput(fixture, `KNOWLEDGE-PROVENANCE-${label.toUpperCase()}`, { ...override, lifecycle: "candidate" }),
      );
      assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
      assert.equal(created.promotionState, "candidate");
      // rejecting a candidate never needs provenance
      const rejected = await transitionKnowledgePromotion(fixture.workspace, {
        expectedVersion: 1, expectedRevision: 1, occurredAt: instant(12), id: created.id, promotionState: "rejected",
      });
      assert.equal(rejected.reasonCode, "KNOWLEDGE_PROMOTION_UPDATED");
    } finally {
      await fixture.close();
    }
  }
  for (const [label, override] of [
    ["source", { sourceReferences: [] }],
    ["evidence", { linkedEvidenceIds: [] }],
    ["owner-empty", { accountableOwnerId: "" }],
  ]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-PROMOTE-BLOCK-${label.toUpperCase()}` });
    try {
      const created = await createKnowledgeUnit(fixture.workspace,
        unitInput(fixture, `KNOWLEDGE-PROMOTE-BLOCK-${label.toUpperCase()}`, { ...override, lifecycle: "candidate" }));
      await expectReason("KNOWLEDGE_PROVENANCE_INVALID", () => transitionKnowledgePromotion(fixture.workspace, {
        expectedVersion: 1, expectedRevision: 1, occurredAt: instant(12), id: created.id, promotionState: "promoted",
      }));
    } finally {
      await fixture.close();
    }
  }
});

test("WSC-6: promotion enforces machine checks for tags and snippet", async () => {
  for (const [label, override] of [
    ["no-tags", { tags: [] }],
    ["empty-snippet", { snippet: "" }],
  ]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-PROMOTE-CHECK-${label.toUpperCase()}` });
    try {
      const created = await createKnowledgeUnit(fixture.workspace,
        unitInput(fixture, `KNOWLEDGE-CHECK-${label.toUpperCase()}`, { ...override, lifecycle: "candidate" }));
      await expectReason("KNOWLEDGE_PROMOTION_INVALID", () => transitionKnowledgePromotion(fixture.workspace, {
        expectedVersion: 1, expectedRevision: 1, occurredAt: instant(11, 5), id: created.id, promotionState: "promoted",
      }));
      // rejecting never needs the promotion checks
      const rejected = await transitionKnowledgePromotion(fixture.workspace, {
        expectedVersion: 1, expectedRevision: 1, occurredAt: instant(11, 6), id: created.id, promotionState: "rejected",
      });
      assert.equal(rejected.reasonCode, "KNOWLEDGE_PROMOTION_UPDATED");
    } finally {
      await fixture.close();
    }
  }
  // TCRN-CROSS-INC-282: the same two checks now also refuse the write itself, because an
  // active card is written promoted and validateMetadataShape runs them there.
  for (const [label, override] of [
    ["no-tags", { tags: [] }],
    ["empty-snippet", { snippet: "" }],
  ]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-WRITE-CHECK-${label.toUpperCase()}` });
    try {
      await expectReason("KNOWLEDGE_PROMOTION_INVALID", () => createKnowledgeUnit(fixture.workspace,
        unitInput(fixture, `KNOWLEDGE-WRITE-CHECK-${label.toUpperCase()}`, override)));
    } finally {
      await fixture.close();
    }
  }
  // a fully-governed candidate promotes
  const ok = await workspaceFixture({ externalKey: "FIXTURE-PROMOTE-CHECK-OK" });
  try {
    const created = await createKnowledgeUnit(ok.workspace, unitInput(ok, "KNOWLEDGE-CHECK-OK", { lifecycle: "candidate" }));
    const promoted = await transitionKnowledgePromotion(ok.workspace, {
      expectedVersion: 1, expectedRevision: 1, occurredAt: instant(11, 5), id: created.id, promotionState: "promoted",
    });
    assert.equal(promoted.promotionState, "promoted");
  } finally {
    await ok.close();
  }
});

test("WSE-5: a work-log candidate carrying an event reference and chain-matching accountable owner promotes unchanged", async () => {
  // Rationale linkage (work-log-v1 Event linkage): the event -> work-log -> evidence
  // audit walk is expressible today with zero schema or engine change. A work-log
  // decision candidate that lists a covered event as an `event:<eventHash>` source
  // reference, sets accountableOwnerId to the attested owner: actor, and carries the
  // evidence link passes createKnowledgeUnit and the existing promotion validation.
  const eventReference = (fixture, seed) => `event:${canonicalSha256({ workId: fixture.workId, seed })}`;
  const agentActor = deriveStableId("agent", "WORK-LOG-AGENT");

  for (const [label, override] of [
    // owner: actor -> exact accountableOwnerId match, event reference only
    ["owner-actor", (fixture) => ({ kind: "decision", sourceReferences: [eventReference(fixture, "owner")] })],
    // profile:/agent: actor -> owning owner stays accountable, actor id rides in sourceReferences
    ["agent-actor", (fixture) => ({ kind: "decision", sourceReferences: [eventReference(fixture, "agent"), agentActor] })],
  ]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-WORK-LOG-${label.toUpperCase()}` });
    try {
      const created = await createKnowledgeUnit(
        fixture.workspace,
        unitInput(fixture, `WORK-LOG-${label.toUpperCase()}`, override(fixture)),
      );
      assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
      // creation itself proves the event reference survives storage: a reference the
      // source-reference grammar rejected or redaction rewrote would fail closed here.
      // TCRN-CROSS-STORY-365: source and evidence supplied together are written
      // official, so this candidate is promoted at creation rather than one step later.
      // The promotion path stays exercised for the records that still reach it.
      assert.equal(created.promotionState, "promoted");
      const promoted = created.promotionState === "promoted" ? created : await transitionKnowledgePromotion(fixture.workspace, {
        expectedVersion: 1, expectedRevision: 1, occurredAt: instant(12), id: created.id, promotionState: "promoted",
      });
      assert.equal(promoted.promotionState, "promoted");
    } finally {
      await fixture.close();
    }
  }

  // TCRN-CROSS-INC-282: half-supplied provenance on a relaxed kind used to be the one
  // shape that landed a candidate and then refused promotion -- a card written,
  // unretrievable, and unrepairable by any verb. This case was that refusal's proof; it is
  // now the proof of what replaced it. A source with no evidence id is written promoted and
  // answers the default selection immediately.
  const halfSupplied = await workspaceFixture({ externalKey: "FIXTURE-WORK-LOG-NO-EVIDENCE" });
  try {
    const created = await createKnowledgeUnit(halfSupplied.workspace, unitInput(halfSupplied, "WORK-LOG-NO-EVIDENCE", {
      kind: "decision",
      sourceReferences: [eventReference(halfSupplied, "no-evidence")],
      linkedEvidenceIds: [],
    }));
    assert.equal(created.promotionState, "promoted", "a source without an evidence id is still a written card");
    const listed = await listKnowledgeMetadata(halfSupplied.workspace, { at: instant(12) });
    assert.equal(listed.records.some((record) => record.id === created.id), true, "default recall answers for it at once");
  } finally {
    await halfSupplied.close();
  }
});

test("WSC-5: retire and reverify lifecycle transitions fail closed", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-LIFECYCLE" });
  try {
    // retire: a candidate is retired and drops out of default selection; re-retire fails
    const candidate = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-RETIRE-ME", { expectedVersion: 0, occurredAt: instant(11, 3) }));
    const retired = await retireKnowledgeUnit(fixture.workspace, { expectedVersion: 1, expectedRevision: 1, occurredAt: instant(11, 4), id: candidate.id });
    assert.equal(retired.reasonCode, "KNOWLEDGE_RETIRED");
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "default" });
    assert.equal(listed.records.some((r) => r.id === candidate.id), false);
    await expectReason("KNOWLEDGE_LIFECYCLE_INVALID", () => retireKnowledgeUnit(fixture.workspace, { expectedVersion: 2, expectedRevision: 2, occurredAt: instant(11, 5), id: candidate.id }));

    // reverify: promoted record can be re-verified; a candidate cannot
    // TCRN-CROSS-INC-282: written lifecycle "candidate", the one shape that is still a
    // candidate, so "a candidate cannot be re-verified" is still a reachable refusal.
    const promotable = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-REVERIFY-ME", { expectedVersion: 2, occurredAt: instant(11, 6), lifecycle: "candidate" }));
    await expectReason("KNOWLEDGE_LIFECYCLE_INVALID", () => reverifyKnowledgeUnit(fixture.workspace, { expectedVersion: 3, expectedRevision: 1, occurredAt: instant(11, 7), id: promotable.id }));
    await transitionKnowledgePromotion(fixture.workspace, { expectedVersion: 3, expectedRevision: 1, occurredAt: instant(11, 8), id: promotable.id, promotionState: "promoted" });
    const reverified = await reverifyKnowledgeUnit(fixture.workspace, { expectedVersion: 4, expectedRevision: 2, occurredAt: instant(13, 9), id: promotable.id });
    assert.equal(reverified.reasonCode, "KNOWLEDGE_REVERIFIED");
    assert.equal(reverified.lastVerified, instant(13, 9));
  } finally {
    await fixture.close();
  }
});

test("WSC-4: knowledge-list supports bounded substring search over subject and tags", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-SEARCH" });
  try {
    await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-ALPHA", { expectedVersion: 0, occurredAt: instant(11, 3), subject: "Retry backoff policy", tags: ["knowledge", "resilience"] }));
    await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-BETA", { expectedVersion: 1, occurredAt: instant(11, 4), subject: "Cache invalidation rules", tags: ["knowledge", "caching"] }));
    const bySubject = await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all", search: "backoff" });
    assert.equal(bySubject.total, 1);
    assert.equal(bySubject.records[0].subject, "Retry backoff policy");
    const byTag = await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all", search: "caching" });
    assert.equal(byTag.total, 1);
    assert.equal(byTag.records[0].subject, "Cache invalidation rules");
    const caseInsensitive = await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all", search: "RETRY" });
    assert.equal(caseInsensitive.total, 1);
    const none = await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all", search: "nonexistent-term" });
    assert.equal(none.total, 0);
    await expectReason("KNOWLEDGE_INPUT_INVALID", () => listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all", search: "x".repeat(300) }));
    await expectReason("KNOWLEDGE_INPUT_INVALID", () => listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all", limit: 0 }));
  } finally {
    await fixture.close();
  }
});

test("WSC-3: knowledge-create accepts unsorted arrays and sorts them server-side", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-CAPTURE-SORT" });
  try {
    const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-SORT", {
      tags: ["workflow", "knowledge", "architecture"],
      roleScopes: [],
    }));
    assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    const metadata = JSON.parse(await readFile(join(fixture.store, "metadata", `${created.id}.json`), "utf8"));
    assert.deepEqual(metadata.tags, ["architecture", "knowledge", "workflow"]);
    // the stored record is canonical and re-validates
    assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
  } finally {
    await fixture.close();
  }
});

// TCRN-CROSS-STORY-359 (Epic disposition F2). The retired `verifyP4` verb carried
// P4_KNOWLEDGE_LIMIT_CONTRACT, the only thing pinning the six maximum* fields of
// packages/core/fixtures/p4-knowledge-core-cases.json. `verifyP4Knowledge` was the Epic's
// proposed new home; that verb retired in this same Story, so the home is re-derived here.
// This file is where it belongs: it already reads that fixture and already drives every
// one of those limits through KNOWLEDGE_LIMITS, and `pnpm test` is on the P1 roster while
// the focus verbs are not.
//
// Re-derived in one further respect. The retired assertion compared the fixture against
// seven literals, and by the time it was retired three of them were wrong: `maximumRecords`
// no longer exists and `maximumAggregateBytes` had moved from 131,072 to the protocol
// canonical-view ceiling. A contract stated as literals goes stale silently on the side
// nobody looks at. This one compares the fixture to the running constant, so the fixture
// cannot drift from the limits the code enforces without a red.
test("STORY-359: the knowledge fixture declares exactly the limits the code enforces", async () => {
  const fixtureContract = JSON.parse(await readFile(
    new URL("../packages/core/fixtures/p4-knowledge-core-cases.json", import.meta.url),
    "utf8",
  ));
  const declared = Object.fromEntries(Object.entries(fixtureContract).filter(([field]) => field.startsWith("maximum")));
  assert.equal(Object.keys(declared).length, 6);
  for (const [field, value] of Object.entries(declared)) {
    assert.equal(value, KNOWLEDGE_LIMITS[field], `fixture ${field} must equal KNOWLEDGE_LIMITS.${field}`);
  }
  // And the reverse direction, so a limit the fixture never named cannot be added to one
  // side only: every field the fixture declares is a real limit, and the ones it does not
  // declare are the per-record shape bounds the fixture's cases exercise directly.
  assert.deepEqual(Object.keys(declared).sort(), [
    "maximumAggregateBytes", "maximumBodyBytes", "maximumMetadataBytes",
    "maximumQueryResults", "maximumSnippetBytes", "maximumSummaryBytes",
  ]);
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
      // TCRN-CROSS-INC-282: no promote pass -- every card is written promoted, so the
      // corpus under comparison is the written one.
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
    // TCRN-CROSS-INC-282: lifecycle "candidate" keeps a promotable target, so the CAS and
    // input refusals below are still measured against a transition that could succeed.
    const input = unitInput(fixture, "KNOWLEDGE-CAS", { lifecycle: "candidate" });
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

  // WSC-6: promote, retire, and reverify carry the same crash points, and until now no
  // test ever triggered one -- their crash(...) calls were unreachable proof. A simulated
  // crash must retain the claim exactly as create and rebase do, because a real SIGKILL
  // never runs the finally that would release it.
  for (const verb of ["promote", "retire", "reverify"]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-KNOWLEDGE-SIBLING-${verb.toUpperCase()}` });
    try {
      // TCRN-CROSS-INC-282: promote needs a candidate, so that verb writes lifecycle
      // "candidate"; reverify needs a promoted record and now gets one from the write.
      const unit = await createKnowledgeUnit(fixture.workspace,
        unitInput(fixture, `KNOWLEDGE-SIBLING-${verb.toUpperCase()}`, verb === "promote" ? { lifecycle: "candidate" } : {}));
      const version = 1;
      const revision = 1;
      const run = () => {
        const common = { expectedVersion: version, expectedRevision: revision, occurredAt: instant(12, 5), id: unit.id };
        if (verb === "promote") return transitionKnowledgePromotion(fixture.workspace, { ...common, promotionState: "promoted" }, { faultAt: "after-metadata-write" });
        if (verb === "retire") return retireKnowledgeUnit(fixture.workspace, common, { faultAt: "after-metadata-write" });
        return reverifyKnowledgeUnit(fixture.workspace, common, { faultAt: "after-metadata-write" });
      };
      await expectReason("KNOWLEDGE_FAULT_INJECTED", run);
      assert.equal((await readdir(fixture.store)).includes("mutation.claim"), true, `${verb} must retain the claim after a simulated crash`);
    } finally {
      await fixture.close();
    }
  }
});

test("INIT-047 knowledge inventory admits more than 64 records while query pages remain bounded", async () => {
  const count = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-COUNT" });
  try {
    assert.equal(Object.hasOwn(KNOWLEDGE_LIMITS, "maximumRecords"), false);
    for (let index = 0; index < 65; index += 1) {
      await createKnowledgeUnit(count.workspace, unitInput(count, `KNOWLEDGE-COUNT-${index}`, {
        expectedVersion: index,
        occurredAt: instant(11, 3),
        body: "small",
      }));
    }
    const inventory = await listKnowledgeMetadata(count.workspace, { at: instant(12), selection: "all", limit: 100 });
    assert.equal(inventory.total, 65);
    assert.equal(inventory.records.length, 65);
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
    // WSC-4: more matches than one page truncates with a continuation window
    // instead of failing closed.
    const page = await listKnowledgeMetadata(query.workspace, { at: instant(12), selection: "all" });
    assert.equal(page.total, KNOWLEDGE_LIMITS.maximumQueryResults + 1);
    assert.equal(page.records.length, KNOWLEDGE_LIMITS.maximumQueryResults);
    assert.equal(page.truncated, true);
    const next = await listKnowledgeMetadata(query.workspace, { at: instant(12), selection: "all", offset: KNOWLEDGE_LIMITS.maximumQueryResults });
    assert.equal(next.records.length, 1);
    assert.equal(next.truncated, false);
  } finally {
    await query.close();
  }
  const aggregate = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-AGGREGATE" });
  try {
    let rejected = false;
    for (let index = 0; index < 200; index += 1) {
      try {
        await createKnowledgeUnit(aggregate.workspace, unitInput(aggregate, `KNOWLEDGE-AGGREGATE-${index}`, {
          expectedVersion: index,
          occurredAt: instant(11, 3),
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
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-RUNTIME-KNOWLEDGE-BOUNDARY" });
  try {
    assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
    assert.deepEqual((await listKnowledgeMetadata(fixture.workspace, { at: instant(11, 3) })).records, []);
    assert.equal(KnowledgeCoreError.prototype instanceof Error, true);
  } finally {
    await fixture.close();
  }
  const corePackage = JSON.parse(await readFile(new URL("../packages/core/package.json", import.meta.url), "utf8"));
  const cliPackage = JSON.parse(await readFile(new URL("../packages/cli/package.json", import.meta.url), "utf8"));
  assert.deepEqual(corePackage.dependencies ?? {}, {});
  assert.deepEqual(cliPackage.dependencies ?? {}, {});
  assert.ok(KnowledgeCoreError.prototype instanceof Error);
});

test("WSC-7: knowledge metadata maps to digest-valid context-metadata candidates with lossy role scope", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-WSC7-BRIDGE" });
  try {
    const workspaceUnit = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "WSC7-WORKSPACE", {
      expectedVersion: 0, occurredAt: instant(11, 3), scope: "workspace", projectId: null, roleScopes: [],
      linkedWorkIds: [], subject: "Workspace scope subject", summary: "Workspace scope summary",
    }));
    const projectUnit = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "WSC7-PROJECT", {
      expectedVersion: 1, occurredAt: instant(11, 4), subject: "Project scope subject", summary: "Project scope summary",
    }));
    // Role-scoped record carrying a LIVE project reference (knowledge admits this).
    const roleUnit = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "WSC7-ROLE", {
      expectedVersion: 2, occurredAt: instant(11, 5), scope: "role", roleScopes: ["reviewer"],
      subject: "Role scope subject", summary: "Role scope summary",
    }));
    const staleUnit = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "WSC7-STALE", {
      expectedVersion: 3, occurredAt: instant(11, 6), freshnessState: "stale", lastVerified: instant(11),
      subject: "Stale scope subject", summary: "Stale scope summary",
    }));

    const workspaceId = deriveStableId("workspace", "FIXTURE-WSC7-BRIDGE");
    const result = await knowledgeContextCandidates(fixture.workspace, { at: instant(12), selection: "all" });
    assert.equal(result.reasonCode, "KNOWLEDGE_LIST_READY");
    assert.equal(result.schemaVersion, "tcrn.knowledge-context-candidates.v1");
    const byId = new Map(result.candidates.map((candidate) => [candidate.id, candidate]));

    const ws = byId.get(workspaceUnit.id);
    assert.equal(ws.schemaVersion, "tcrn.context-metadata-candidate.v1");
    assert.equal(ws.kind, "metadata");
    assert.equal(ws.scope, "workspace");
    assert.equal(ws.workspaceId, workspaceId);
    assert.equal(ws.projectId, null);
    assert.equal(ws.workId, null);
    assert.equal(ws.freshness, "fresh");
    assert.equal(ws.title, "Workspace scope subject");
    assert.equal(ws.summary, "Workspace scope summary");
    assert.equal(ws.retentionClass, "metadata_only");

    const project = byId.get(projectUnit.id);
    assert.equal(project.scope, "project");
    assert.equal(project.projectId, fixture.projectId);
    assert.equal(project.workId, null);

    // Lossy mapping (VERIFIER CORRECTION): role -> "workspace" and projectId nulled,
    // even though the knowledge record itself carries a live project reference. This is
    // what checkScope (context-router.ts) requires of workspace-scope candidates.
    const role = byId.get(roleUnit.id);
    assert.equal(role.scope, "workspace");
    assert.equal(role.projectId, null);
    assert.equal(role.workId, null);

    // Freshness carried through from knowledge computeFreshness.
    assert.equal(byId.get(staleUnit.id).freshness, "stale");

    // Digest parity: candidateDigest byte-matches canonicalSha256 over the exact
    // 11-field router basis (candidateDigest excluded).
    for (const candidate of result.candidates) {
      const { candidateDigest, ...basis } = candidate;
      assert.equal(candidateDigest, canonicalSha256(basis));
    }

    // Byte-determinism: a second scan produces an identical serialization and digest.
    const again = await knowledgeContextCandidates(fixture.workspace, { at: instant(12), selection: "all" });
    assert.equal(canonicalJson(again), canonicalJson(result));
    assert.equal(again.resultDigest, result.resultDigest);

    // Default selection returns the active+default+fresh corpus. TCRN-CROSS-INC-282 took
    // "promoted" out of that list, so the bridge now carries three of the four -- the
    // stale one is the only exclusion, and it is excluded for being stale.
    const defaultResult = await knowledgeContextCandidates(fixture.workspace, { at: instant(12) });
    assert.equal(defaultResult.selection, "default");
    assert.equal(defaultResult.candidates.length, 3);
    assert.equal(defaultResult.candidates.some((candidate) => candidate.id === staleUnit.id), false, "the stale card is the one the default bridge drops");
    assert.equal(result.candidates.length, 4);

    // CLI surface emits the same candidates array consumable as a context-route request.
    let output = "";
    await runCli(["knowledge-candidates", "--workspace", fixture.workspace, "--at", instant(12), "--selection", "all"],
      { write: (value) => { output += value; } });
    const cli = JSON.parse(output);
    assert.equal(cli.reasonCode, "KNOWLEDGE_LIST_READY");
    assert.deepEqual(cli.candidates, JSON.parse(canonicalJson(result.candidates)));
  } finally {
    await fixture.close();
  }
});

// CQ-02c. `scope` was the one enum in this header still admitted through a coercing
// membership test, two lines above `category`, which was already written correctly. A
// caller of the programmatic createKnowledgeUnit API passes `scope` straight through to
// the persisted metadata (knowledge-core.ts:941), so a coercible value was written to disk
// in a field the exported type declares as an enum.
test("CQ-02c: knowledge metadata scope refuses values that only coerce to a member", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-SCOPE-COERCION" });
  try {
    const vectors = [
      ["single-element array", ["project"]],
      ["plain object with toString", { toString: () => "project" }],
      ["boxed String", new String("project")],
      // Regression anchors only -- already refused before the guard existed.
      ["anchor number", 1],
      ["anchor null", null],
      ["anchor plain object", {}],
    ];
    for (const [label, scope] of vectors) {
      await assert.rejects(
        // The override is applied AFTER unitInput, whose `options.scope ?? "project"`
        // would otherwise silently substitute a legal value for the null anchor.
        () => createKnowledgeUnit(fixture.workspace, { ...unitInput(fixture, `SCOPE-${label.replace(/[^A-Za-z]/gu, "").toUpperCase()}`), scope }),
        (error) => {
          assert.equal(error?.reasonCode, "KNOWLEDGE_RECORD_INVALID", `${label}: got ${error?.reasonCode}`);
          return true;
        },
        label,
      );
    }
    // The guard must not have closed the legal values. Each scope carries its own link
    // shape: workspace scope admits no project or work links, role scope carries role
    // scopes. Rejected creates do not advance the store version, so the successful ones
    // number from zero.
    const legalScopes = [
      ["workspace", { projectId: null, roleScopes: [], linkedWorkIds: [] }],
      ["project", { projectId: fixture.projectId, roleScopes: [] }],
      ["role", { projectId: fixture.projectId, roleScopes: ["reviewer"] }],
    ];
    for (const [index, [scope, shape]] of legalScopes.entries()) {
      const created = await createKnowledgeUnit(fixture.workspace, {
        ...unitInput(fixture, `SCOPE-OK-${scope.toUpperCase()}`, { ...shape, expectedVersion: index }),
        scope,
      });
      assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED", scope);
    }
    // Read the scopes back off disk: the create result does not carry `scope`, so this is
    // what actually shows the legal values survived the guard as strings.
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all" });
    const persisted = listed.records.filter((record) => record.externalKey.startsWith("SCOPE-OK-"));
    assert.deepEqual(persisted.map((record) => record.scope).sort(), ["project", "role", "workspace"]);
    for (const record of persisted) assert.equal(typeof record.scope, "string");
  } finally {
    await fixture.close();
  }
});

// CQ-10, knowledge-core half. Link liveness ran `workspace.projects.find` once per record
// and `workspace.work.find` once per linked work id, so a scan of R records paid R linear
// passes over the workspace. The lookups are now served by maps memoized on the workspace
// state. Per the plan's acceptance criterion 3 this is asserted as a DETERMINISTIC COUNT,
// not as a timing, because a timing assertion is noise on a shared machine and a
// performance regression is invisible to every other gate.
test("CQ-10: knowledge link liveness builds one index per workspace state, not one per record", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-LINK-INDEX" });
  try {
    const recordCount = 6;
    for (let index = 0; index < recordCount; index += 1) {
      await createKnowledgeUnit(fixture.workspace, unitInput(fixture, `LINK-INDEX-${index}`, { expectedVersion: index }));
    }
    const before = knowledgeLinkIndexCountsForTest();
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all" });
    const scanned = listed.records.filter((record) => record.externalKey.startsWith("LINK-INDEX-"));
    assert.equal(scanned.length, recordCount, "the fixture must actually exercise multiple records");
    const after = knowledgeLinkIndexCountsForTest();
    const builds = after.builds - before.builds;
    const lookups = after.lookups - before.lookups;
    // Builds are bounded by the number of materialized workspace states the read path
    // walks, NOT by the number of records. A per-record rebuild shows up here as >= 6.
    assert.ok(builds < recordCount, `link index built ${builds} times for ${recordCount} records`);
    // And the index must actually be the thing answering the lookups. Without this, a call
    // site reverted to `workspace.*.find` would leave the build count untouched and this
    // test would pass with the defect fully reintroduced.
    assert.ok(lookups >= recordCount, `link index served only ${lookups} lookups for ${recordCount} records`);
  } finally {
    await fixture.close();
  }
});

// The index replaces `find`. This pins the lookup-miss behaviours: an id that is absent
// from the index must still be refused, for both the project and the linked-work lookup.
//
// Two related properties are deliberately NOT claimed here, to keep this test honest about
// what it proves. (1) Tombstone exclusion is already pinned by the existing WSC-2 rebase
// test at :222 -- dropping `!entry.tombstone` from the index builder reddens that test, so
// re-asserting it here would add proof mass without adding coverage. (2) The builder is
// first-wins to match `find`, but a materialized workspace has unique record ids, so no
// test can distinguish first-wins from last-wins; that choice rests on review, not proof.
test("CQ-10: the link index still refuses links that are absent from the workspace", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-LINK-SEMANTICS" });
  try {
    await expectReason("KNOWLEDGE_LINK_INVALID", () => createKnowledgeUnit(fixture.workspace, unitInput(fixture, "LINK-UNKNOWN-WORK", {
      linkedWorkIds: [deriveStableId("work", "NO-SUCH-WORK")],
    })));
    await expectReason("KNOWLEDGE_LINK_INVALID", () => createKnowledgeUnit(fixture.workspace, unitInput(fixture, "LINK-UNKNOWN-PROJECT", {
      projectId: deriveStableId("project", "NO-SUCH-PROJECT"),
    })));
    // The live link still resolves.
    const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "LINK-LIVE"));
    assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  } finally {
    await fixture.close();
  }
});

test("TCRN-CROSS-STORY-023: the aggregate cap counts marker+metadata+body but not the derived index, and still fires", async () => {
  // Regression guard for the double-count that made ~30 tiny records scan at 97%.
  // Fill a store with large-body records until the cap rejects one, then prove two
  // things at the admitted count: (1) the store fits under the new accounting
  // (marker + Σ metadata + Σ body), and (2) the SAME records would have exceeded
  // the cap under the old accounting (which also charged the index) — so the fix
  // genuinely raised headroom rather than removing the bound. The final create
  // failing with KNOWLEDGE_LIMIT_EXCEEDED proves the cap still fires.
  const fx = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-S023" });
  try {
    const storeRoot = join(fx.workspace, ".tcrn-workflow/knowledge");
    let admitted = 0, rejected = false;
    for (let i = 0; i < 200; i += 1) {
      try {
        await createKnowledgeUnit(fx.workspace, unitInput(fx, `S023-${i}`, {
          expectedVersion: i, occurredAt: instant(11, 3), body: "x".repeat(7_500),
        }));
        admitted += 1;
      } catch (error) {
        assert.equal(error.reasonCode, "KNOWLEDGE_LIMIT_EXCEEDED"); // the cap still fires
        rejected = true; break;
      }
    }
    assert.equal(rejected, true, "the cap must still reject once the source-of-truth bytes exceed it");
    let sumMeta = 0, sumBody = 0;
    for (const n of await readdir(join(storeRoot, "metadata"))) sumMeta += (await readFile(join(storeRoot, "metadata", n))).length;
    for (const n of await readdir(join(storeRoot, "bodies"))) sumBody += (await readFile(join(storeRoot, "bodies", n))).length;
    const marker = (await readFile(join(storeRoot, "store.json"))).length;
    const index = (await readFile(join(storeRoot, "views/index.json"))).length;
    const cap = 131_072;
    const current = marker + sumMeta + sumBody;
    assert.ok(current <= cap, `admitted records must fit the new cap: ${current} <= ${cap}`);
    assert.ok(current + index > cap, `the same records would have exceeded the old index-inclusive cap: ${current + index} > ${cap}`);
    assert.equal((await validateKnowledgeStore(fx.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
  } finally { await fx.close(); }
});

test("TCRN-CROSS-STORY-025: search matches the summary, not only subject and tags", async () => {
  // A curated card's searchable substance lives in its summary; a machine-shaped
  // subject is not what a reader searches for. Before this, search scanned only
  // subject+tags, so a term present only in the summary was unfindable.
  const fx = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-S025" });
  try {
    await createKnowledgeUnit(fx.workspace, unitInput(fx, "S025-CARD", {
      subject: "Subject S025-CARD",
      summary: "Layout-thrashing animations reflow every frame; animate transform and opacity instead.",
      tags: ["knowledge", "workflow"],
    }));
    const hit = await listKnowledgeMetadata(fx.workspace, { at: instant(12), selection: "all", search: "layout-thrashing" });
    assert.equal(hit.records.length, 1, "a summary-only term must be found");
    const miss = await listKnowledgeMetadata(fx.workspace, { at: instant(12), selection: "all", search: "nonexistent-token-zzz" });
    assert.equal(miss.records.length, 0, "a term present nowhere must not match");
  } finally { await fx.close(); }
});

test("TCRN-CROSS-STORY-024: retiring reclaims the body, keeps the store valid, and still requires a live body", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-S024" });
  try {
    const bodiesDir = join(fx.workspace, ".tcrn-workflow/knowledge/bodies");
    const created = await createKnowledgeUnit(fx.workspace, unitInput(fx, "S024-RECLAIM", {
      expectedVersion: 0, occurredAt: instant(11, 3), body: "x".repeat(7_500),
    }));
    const bodyFile = join(bodiesDir, `${created.id}.body`);
    assert.equal((await readFile(bodyFile)).length, 7_500, "body present before retire");
    // Retire reclaims the body file, and the store is still valid without it.
    await retireKnowledgeUnit(fx.workspace, { expectedVersion: 1, expectedRevision: 1, occurredAt: instant(11, 4), id: created.id });
    await assert.rejects(readFile(bodyFile), "retired body must be deleted");
    assert.equal((await validateKnowledgeStore(fx.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
    // The retired record survives as a metadata-only audit entry.
    const all = await listKnowledgeMetadata(fx.workspace, { at: instant(12), selection: "all" });
    assert.equal(all.records.some((r) => r.id === created.id), true, "retired record kept as audit entry");
    // Integrity still fires: a LIVE record missing its body corrupts the store.
    const live = await createKnowledgeUnit(fx.workspace, unitInput(fx, "S024-LIVE", { expectedVersion: 2, occurredAt: instant(11, 5) }));
    await rm(join(bodiesDir, `${live.id}.body`));
    await expectReason("KNOWLEDGE_PARTIAL_STATE", () => validateKnowledgeStore(fx.workspace));
  } finally { await fx.close(); }
});

test("INIT-047: relevance ordering changes with the query and source-free fragments are selectable", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-INIT047-RANK" });
  try {
    const fragment = (key, subject, summary, expectedVersion) => unitInput(fx, key, {
      expectedVersion,
      kind: "fact",
      sourceReferences: [],
      sourceDigest: null,
      linkedWorkIds: [],
      linkedEvidenceIds: [],
      stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
      lastVerified: null,
      freshnessState: "fresh",
      subject,
      summary,
    });
    const alpha = await createKnowledgeUnit(fx.workspace, fragment("INIT047-ALPHA", "shared alpha", "shared beta", 0));
    await createKnowledgeUnit(fx.workspace, fragment("INIT047-BETA", "shared beta", "shared alpha", 1));
    assert.equal(alpha.promotionState, "promoted");
    const alphaOrder = (await listKnowledgeMetadata(fx.workspace, { at: instant(12), search: "alpha" })).records.map((record) => record.externalKey);
    const betaOrder = (await listKnowledgeMetadata(fx.workspace, { at: instant(12), search: "beta" })).records.map((record) => record.externalKey);
    assert.deepEqual(alphaOrder, ["INIT047-ALPHA", "INIT047-BETA"]);
    assert.deepEqual(betaOrder, ["INIT047-BETA", "INIT047-ALPHA"]);
    assert.equal((await evaluateKnowledgeFreshness(fx.workspace, instant(12))).records.find((record) => record.id === alpha.id).state, "fresh");
  } finally { await fx.close(); }
});

test("INIT-047 supersedes rejects an unavailable target before writing", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-INIT047-SUPERSEDES" });
  try {
    await expectReason("KNOWLEDGE_LINK_INVALID", () => createKnowledgeUnit(fx.workspace, unitInput(fx, "INIT047-MISSING-TARGET", {
      expectedVersion: 0,
      supersedes: deriveStableId("knowledge", "INIT047-MISSING-TARGET-NOT-HERE"),
    })));
    assert.equal((await validateKnowledgeStore(fx.workspace)).records, 0);
  } finally { await fx.close(); }
});

test("INIT-047 source digest check reports changes without hiding metadata", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-INIT047-SOURCE-CHECK" });
  try {
    await writeFile(join(fx.workspace, "source.md"), "source-v1");
    const sourced = await createKnowledgeUnit(fx.workspace, unitInput(fx, "INIT047-SOURCE-CHECK", {
      expectedVersion: 0,
      kind: "reference",
      sourceReferences: ["source.md"],
      sourceDigest: null,
      linkedEvidenceIds: [deriveStableId("evidence", "INIT047-SOURCE-CHECK")],
      retrievalDisposition: "explicit-only",
      lastVerified: instant(11, 3),
      freshnessState: "fresh",
    }));
    assert.equal(sourced.promotionState, "promoted", "TCRN-CROSS-INC-282: a reference carrying source and evidence is written promoted");
    assert.equal((await checkKnowledgeSources(fx.workspace)).records.find((record) => record.id === sourced.id).status, "unchanged");
    await writeFile(join(fx.workspace, "source.md"), "source-v2");
    assert.equal((await checkKnowledgeSources(fx.workspace)).records.find((record) => record.id === sourced.id).status, "changed");
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12), selection: "all", search: "source-check" })).records.length, 1);
  } finally { await fx.close(); }
});

test("INIT-047 article index cards stay explicit-only for default context", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-INIT047-ARTICLE-INDEX" });
  try {
    await writeFile(join(fx.workspace, "article.md"), "article-v1");
    const article = await createKnowledgeUnit(fx.workspace, unitInput(fx, "INIT047-ARTICLE-INDEX", {
      expectedVersion: 0,
      kind: "reference",
      sourceReferences: ["article.md"],
      sourceDigest: null,
      linkedEvidenceIds: [deriveStableId("evidence", "INIT047-ARTICLE-INDEX")],
      retrievalDisposition: "explicit-only",
      lastVerified: instant(11, 3),
      freshnessState: "fresh",
    }));
    assert.equal(article.promotionState, "promoted", "TCRN-CROSS-INC-282: written promoted, and still not a default answer");
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12) })).records.length, 0);
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12), search: "article-index" })).records.length, 1);
    assert.equal((await knowledgeContextCandidates(fx.workspace, { at: instant(12), search: "article-index" })).candidates.length, 0);
  } finally { await fx.close(); }
});

test("STORY-366 GWT1: an article stores full Markdown outside the chain and only a bounded reference index inside", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-STORY-366-CREATE" });
  try {
    const content = "中文".repeat(1_500);
    const owner = deriveStableId("owner", "STORY-366-OWNER");
    const evidence = deriveStableId("evidence", "STORY-366-ARTICLE");
    const workspaceVersion = (await materializeWorkspace(fx.workspace)).version;
    await assert.rejects(
      () => cliJson(["knowledge-article-create", "--workspace", fx.workspace, "--expected-version", String(workspaceVersion), "--at", instant(11, 3), "--path", "wrong-version.md", "--category", "architecture", "--title", "Wrong store version", "--summary", "Not written", "--content", content, "--accountable-owner-id", owner, "--evidence-ids", evidence]),
      (error) => error?.reasonCode === "KNOWLEDGE_CAS_MISMATCH",
      "article CAS is the knowledge-store marker, not the workspace chain version",
    );
    const created = await cliJson(["knowledge-article-create", "--workspace", fx.workspace, "--expected-version", "0", "--at", instant(11, 3), "--path", "topology.md", "--category", "architecture", "--title", "分区 拓扑", "--summary", "迁移摘要", "--content", content, "--accountable-owner-id", owner, "--evidence-ids", evidence]);
    assert.equal(created.reasonCode, "KNOWLEDGE_ARTICLE_CREATED");
    assert.ok(created.articleBytes > Buffer.byteLength(content, "utf8"));
    assert.ok(created.bodyBytes <= 8_192);
    const articlePath = join(fx.workspace, "docs/knowledge/articles/topology.md");
    const markdown = await readFile(articlePath, "utf8");
    assert.match(markdown, /^---\ncategory: architecture\ntitle: 分区 拓扑\n---\n/u);
    assert.ok(markdown.includes(content));
    assert.equal(created.sourceDigest, createHash("sha256").update(markdown).digest("hex"));
    const metadata = JSON.parse(await readFile(join(fx.store, "metadata", `${created.id}.json`), "utf8"));
    const storedBody = await readFile(join(fx.store, "bodies", `${created.id}.body`));
    assert.equal(metadata.kind, "reference");
    assert.equal(metadata.retrievalDisposition, "explicit-only");
    assert.deepEqual(metadata.sourceReferences, ["topology.md"]);
    assert.deepEqual(metadata.linkedEvidenceIds, [evidence]);
    assert.equal(metadata.accountableOwnerId, owner);
    assert.ok(metadata.bodyBytes <= 8_192);
    assert.ok(storedBody.length <= 8_192);
    assert.equal(storedBody.toString("utf8").includes(content), false);
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12) })).records.length, 0);
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12), search: "分区 拓扑" })).records.length, 1);
    await assert.rejects(
      () => cliJson(["knowledge-article-create", "--workspace", fx.workspace, "--expected-version", "1", "--at", instant(11, 4), "--path", "topology.md", "--category", "architecture", "--title", "分区 拓扑", "--summary", "duplicate", "--content", content, "--accountable-owner-id", owner, "--evidence-ids", evidence]),
      (error) => error?.reasonCode === "KNOWLEDGE_ALREADY_EXISTS",
    );
    await assert.rejects(
      () => cliJson(["knowledge-article-create", "--workspace", fx.workspace, "--expected-version", "1", "--at", instant(11, 4), "--path", "../escape.md", "--category", "architecture", "--title", "Unsafe", "--summary", "unsafe", "--content", content, "--accountable-owner-id", owner, "--evidence-ids", evidence]),
      (error) => error?.reasonCode === "KNOWLEDGE_PATH_INVALID",
    );
  } finally { await fx.close(); }
});

test("STORY-366 GWT2: refresh reads the edited file, updates its digest and summary, and keeps identity stable", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-STORY-366-REFRESH" });
  try {
    const owner = deriveStableId("owner", "STORY-366-REFRESH-OWNER");
    const evidence = deriveStableId("evidence", "STORY-366-REFRESH");
    const created = await cliJson(["knowledge-article-create", "--workspace", fx.workspace, "--expected-version", "0", "--at", instant(11, 3), "--path", "refresh.md", "--category", "workflow", "--title", "刷新文章", "--summary", "初始摘要", "--content", "正文一".repeat(1_500), "--accountable-owner-id", owner, "--evidence-ids", evidence]);
    const articlePath = join(fx.workspace, "docs/knowledge/articles/refresh.md");
    const before = await readFile(articlePath, "utf8");
    await writeFile(articlePath, `${before}追加的正文标记`);
    const refreshed = await cliJson(["knowledge-article-refresh", "--workspace", fx.workspace, "--expected-version", "1", "--expected-revision", "1", "--at", instant(11, 4), "--id", created.id, "--path", "refresh.md", "--summary", "更新摘要"]);
    assert.equal(refreshed.reasonCode, "KNOWLEDGE_ARTICLE_REFRESHED");
    assert.equal(refreshed.id, created.id);
    assert.equal(refreshed.revision, 2);
    assert.equal(refreshed.previousSourceDigest, created.sourceDigest);
    const after = await readFile(articlePath, "utf8");
    assert.equal(refreshed.sourceDigest, createHash("sha256").update(after).digest("hex"));
    assert.notEqual(refreshed.sourceDigest, created.sourceDigest);
    const metadata = JSON.parse(await readFile(join(fx.store, "metadata", `${created.id}.json`), "utf8"));
    assert.equal(metadata.summary, "更新摘要");
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12), search: "更新摘要" })).records[0].id, created.id);
    await assert.rejects(
      () => cliJson(["knowledge-article-refresh", "--workspace", fx.workspace, "--expected-version", "1", "--expected-revision", "2", "--at", instant(11, 5), "--id", created.id, "--path", "refresh.md", "--summary", "stale"]),
      (error) => error?.reasonCode === "KNOWLEDGE_CAS_MISMATCH",
    );
  } finally { await fx.close(); }
});

test("INIT-047: supersedes is validated, source digests are computed and source changes are reported", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-INIT047-SOURCES" });
  try {
    const fragment = (key, expectedVersion, overrides = {}) => unitInput(fx, key, {
      expectedVersion,
      kind: "fact",
      sourceReferences: [], sourceDigest: null, linkedWorkIds: [], linkedEvidenceIds: [],
      stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" }, lastVerified: null, freshnessState: "fresh",
      ...overrides,
    });
    const old = await createKnowledgeUnit(fx.workspace, fragment("INIT047-OLD", 0));
    const replacement = await createKnowledgeUnit(fx.workspace, fragment("INIT047-NEW", 1, { supersedes: old.id }));
    const listed = await listKnowledgeMetadata(fx.workspace, { at: instant(12), selection: "all" });
    assert.equal(listed.records.find((record) => record.id === replacement.id).supersedes, old.id);
    // TCRN-CROSS-STORY-365: the supersede marked `old` with extensions.supersededBy, so
    // it is at revision 2 by the time this retire compares.
    await retireKnowledgeUnit(fx.workspace, { expectedVersion: 2, expectedRevision: 2, occurredAt: instant(11, 4), id: old.id });
    await expectReason("KNOWLEDGE_LINK_INVALID", () => createKnowledgeUnit(fx.workspace, fragment("INIT047-AFTER-RETIRE", 3, { supersedes: old.id })));

    await writeFile(join(fx.workspace, "source.md"), "source-v1");
    const sourced = await createKnowledgeUnit(fx.workspace, unitInput(fx, "INIT047-SOURCE", {
      expectedVersion: 3,
      kind: "reference",
      sourceReferences: ["source.md"], sourceDigest: null, linkedEvidenceIds: [deriveStableId("evidence", "INIT047-SOURCE")],
      retrievalDisposition: "explicit-only", lastVerified: instant(11, 3), freshnessState: "fresh",
    }));
    const metadata = JSON.parse(await readFile(join(fx.store, "metadata", `${sourced.id}.json`), "utf8"));
    assert.equal(metadata.sourceDigest, createHash("sha256").update("source-v1").digest("hex"));
    assert.equal(sourced.promotionState, "promoted", "TCRN-CROSS-INC-282: written promoted, no separate promotion act");
    assert.equal((await checkKnowledgeSources(fx.workspace)).records.find((record) => record.id === sourced.id).status, "unchanged");
    await writeFile(join(fx.workspace, "source.md"), "source-v2");
    assert.equal((await checkKnowledgeSources(fx.workspace)).records.find((record) => record.id === sourced.id).status, "changed");
    await rm(join(fx.workspace, "source.md"));
    assert.equal((await checkKnowledgeSources(fx.workspace)).records.find((record) => record.id === sourced.id).status, "missing");
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12), search: "INIT047-SOURCE" })).records.length, 1);
    assert.equal((await knowledgeContextCandidates(fx.workspace, { at: instant(12), search: "INIT047-SOURCE" })).candidates.length, 0);
  } finally { await fx.close(); }
});

// TCRN-CROSS-STORY-359: verifyP4Knowledge retired with the rest of the phase verbs and it
// was the only reader of these three fixture fields. Re-hung here, in the file that drives
// the corpus, so the fixture cannot silently drift away from the values it declares.
test("STORY-359 the p4 knowledge fixture declares the corpus sizes verifyP4Knowledge used to pin", async () => {
  const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/p4-knowledge-core-cases.json", import.meta.url), "utf8"));
  assert.equal(fixture.freshnessCases.length, 3);
  assert.equal(fixture.promotionCases.length, 3);
  assert.equal(fixture.permutationLogicalRecords, 5);
});
