// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-377 — fitness, read-only removal proposals, and bounded retirement.

import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  appendTelemetryRecord,
  acquireWorkspaceLease,
  captureKnowledgeUnit,
  createKnowledgeUnit,
  createTelemetryRecord,
  createProject,
  evaluateKnowledgeFitness,
  initializeKnowledgeStore,
  initializeWorkspace,
  listKnowledgeMetadata,
  readKnowledgeBody,
  readKnowledgeStoreMarker,
  recoverKnowledgeStore,
  retireKnowledgeSweep,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

const AT = "2026-09-10T12:00:00.000Z";
const OWNER = "owner:story-377";

function windowDay(offset) {
  const date = new Date(AT);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - offset);
  return date;
}

function eventAt(offset, second = 0) {
  const date = windowDay(offset);
  date.setUTCHours(12, 0, second, 0);
  return date.toISOString();
}

function dayFile(offset) {
  return `${windowDay(offset).toISOString().slice(0, 10)}.ndjson`;
}

async function fixture(t, externalKey) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s377-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = ["framework", "workspace", "transient", "evidence-locator", "release-trust"]
    .map((kind) => ({ kind, path: join(base, kind) }));
  for (const root of roots) await mkdir(root.path);
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey, createdAt: "2026-01-01T00:00:00Z" });
  const lease = await acquireWorkspaceLease(workspace, { now: "2026-01-01T00:00:01Z" });
  try {
    await createProject(workspace, lease, {
      expectedVersion: 0,
      occurredAt: "2026-01-01T00:00:01Z",
      externalKey: `${externalKey}-PROJECT`,
      name: "Story 377 fixture",
    });
  } finally {
    await lease.release();
  }
  await initializeKnowledgeStore(workspace);
  return { base, workspace, transient: join(base, "transient"), store: join(workspace, "." + "tcrn-workflow", "knowledge") };
}

async function card(fx, externalKey, options = {}) {
  return captureKnowledgeUnit(fx.workspace, {
    occurredAt: options.occurredAt ?? "2026-06-12T00:00:00.000Z",
    externalKey,
    subject: options.subject ?? externalKey,
    summary: options.summary ?? `${externalKey} summary`,
    snippet: options.snippet ?? `${externalKey} snippet`,
    tags: ["fitness"],
    accountableOwnerId: OWNER,
    body: options.body ?? `${externalKey} body`,
    coexist: true,
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.category === undefined ? {} : { category: options.category }),
    ...(options.roleScopes === undefined ? {} : { roleScopes: options.roleScopes }),
  });
}

async function fillWindow(fx, days = 90, events = [], sealed = true) {
  const telemetry = join(fx.transient, "telemetry");
  await mkdir(telemetry, { recursive: true });
  for (let offset = days; offset >= 1; offset -= 1) {
    await writeFile(join(telemetry, dayFile(offset)), "", { flag: "wx" }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
  }
  for (const [index, event] of events.entries()) {
    await appendTelemetryRecord(fx.transient, createTelemetryRecord({
      at: eventAt(event.offset, index),
      kind: event.kind,
      session: `story-377-${index}`,
      payload: { source: `story-377:${event.kind}`, availability: "available", ...event.payload },
    }));
  }
  if (sealed) await sealWindow(fx, days);
}

// A test collector knows its complete fixture input. Production collectors may
// only emit this receipt after proving coverage; a file's existence is not proof.
async function sealWindow(fx, days = 90, overrides = {}) {
  for (let offset = days; offset >= 1; offset -= 1) {
    const source = await readFile(join(fx.transient, "telemetry", dayFile(offset)), "utf8");
    const records = source.split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((record) => record.kind !== "observation-coverage");
    await appendTelemetryRecord(fx.transient, createTelemetryRecord({
      at: windowDay(offset - 1).toISOString(),
      kind: "observation-coverage",
      session: "story-377-test-collector",
      payload: {
        source: "story-377:test-collector", availability: "available",
        coveredFrom: windowDay(offset).toISOString(),
        coveredUntil: windowDay(offset - 1).toISOString(),
        channels: ["retrieval", "reference", "trigger", "verify"],
        recordCount: records.length, sourceDigest: canonicalSha256(records),
        collectionErrors: 0, ...overrides,
      },
    }));
  }
}

test("INC-295: existing empty day files do not establish complete observation", async (t) => {
  const fx = await fixture(t, "FIXTURE-INC-295-EMPTY-DAYS");
  const idle = await card(fx, "INC-295-IDLE");
  await fillWindow(fx, 90, [{ offset: 90, kind: "judge", payload: { candidateIds: [idle.id] } }], false);
  const fitness = await evaluateKnowledgeFitness(fx.workspace, { at: AT });
  assert.equal(fitness.windowComplete, false);
  assert.equal(fitness.records.find((record) => record.id === idle.id).eligible, false);
  assert.deepEqual((await retireKnowledgeSweep(fx.workspace, { at: AT })).retired, []);
});

test("INC-295: unknown collection and stale or partial coverage never authorize retirement", async (t) => {
  for (const [key, overrides, availability] of [
    ["unknown", {}, "unknown"],
    ["unavailable", {}, "unavailable"],
    ["missing-channel", { channels: ["retrieval"] }, "available"],
    ["collection-error", { collectionErrors: 1 }, "available"],
    ["wrong-count", { recordCount: 100 }, "available"],
    ["wrong-digest", { sourceDigest: "0".repeat(64) }, "available"],
  ]) {
    const fx = await fixture(t, `FIXTURE-INC-295-${key}`);
    const idle = await card(fx, `INC-295-${key}`);
    await fillWindow(fx, 90, [{ offset: 90, kind: "judge", payload: { candidateIds: [idle.id], availability } }], false);
    await sealWindow(fx, 90, overrides);
    const fitness = await evaluateKnowledgeFitness(fx.workspace, { at: AT });
    assert.equal(fitness.windowComplete, false, key);
    assert.equal(fitness.records.find((record) => record.id === idle.id).eligible, false, key);
  }
});

test("INC-295: changed input invalidates a seal and useful rules or checks are not removal candidates", async (t) => {
  const fx = await fixture(t, "FIXTURE-INC-295-PROPOSALS");
  await fillWindow(fx, 90, [
    { offset: 90, kind: "verify", payload: { artifactId: "verify-script:story-377", passed: false } },
    { offset: 90, kind: "verify", payload: { artifactId: "verify-script:idle", passed: true } },
    { offset: 90, kind: "rule-trigger", payload: { artifactId: "rule:active" } },
    { offset: 90, kind: "judge", payload: { artifactId: "rule:idle" } },
    { offset: 90, kind: "judge", payload: { artifactId: "work:not-a-removable-artifact" } },
  ]);
  const fitness = await evaluateKnowledgeFitness(fx.workspace, { at: AT });
  assert.equal(fitness.windowComplete, true);
  assert.deepEqual(fitness.proposals.map((proposal) => proposal.id).sort(), ["rule:idle", "verify-script:idle"]);
  await appendTelemetryRecord(fx.transient, createTelemetryRecord({
    at: eventAt(5), kind: "verify", session: "late-input",
    payload: { source: "story-377:test-collector", availability: "available", artifactId: "verify-script:idle", passed: false },
  }));
  const stale = await evaluateKnowledgeFitness(fx.workspace, { at: AT });
  assert.equal(stale.windowComplete, false);
  assert.deepEqual(stale.proposals, []);
});

test("INC-295: a conflicting collector receipt or partial day is not coverage", async (t) => {
  const fx = await fixture(t, "FIXTURE-INC-295-CONFLICT");
  await fillWindow(fx);
  assert.equal((await evaluateKnowledgeFitness(fx.workspace, { at: AT })).windowComplete, true);
  await sealWindow(fx, 1, { collectionErrors: 1 });
  assert.equal((await evaluateKnowledgeFitness(fx.workspace, { at: AT })).windowComplete, false);
  const partial = await fixture(t, "FIXTURE-INC-295-PARTIAL");
  await fillWindow(partial, 90, [], false);
  await sealWindow(partial, 90, { coveredFrom: "2026-06-12T12:00:00.000Z" });
  assert.equal((await evaluateKnowledgeFitness(partial.workspace, { at: AT })).windowComplete, false);
});

async function cliJson(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

test("STORY-377 GWT1/GWT2/GWT3: fitness is complete, proposals are read-only, and only a small idle card retires", async (t) => {
  const fx = await fixture(t, "FIXTURE-STORY-377-FITNESS");
  const idle = await card(fx, "STORY-377-IDLE", { subject: "Idle small card" });
  const protectedCard = await card(fx, "STORY-377-PROTECTED", { subject: "Protected small card" });
  const reference = await createKnowledgeUnit(fx.workspace, {
    expectedVersion: Number((await readKnowledgeStoreMarker(fx.workspace)).version),
    occurredAt: AT,
    externalKey: "STORY-377-ARTICLE-INDEX",
    scope: "role",
    projectId: null,
    roleScopes: ["implementation"],
    category: "workflow",
    kind: "reference",
    tags: ["article"],
    subject: "Article index card",
    summary: "Article index",
    snippet: "Article index",
    accountableOwnerId: OWNER,
    sourceReferences: ["article.md"],
    sourceDigest: canonicalSha256("article"),
    supersedes: null,
    linkedWorkIds: [],
    linkedDecisionIds: [],
    linkedGateIds: [],
    linkedEvidenceIds: ["evidence:story-377-article"],
    lifecycle: "active",
    retrievalDisposition: "explicit-only",
    freshnessState: "fresh",
    lastVerified: AT,
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only",
    body: "Article index body",
    coexist: true,
  });
  await fillWindow(fx, 90, [
    { offset: 90, kind: "judge", payload: { candidateIds: [idle.id] } },
    { offset: 90, kind: "retrieval-hit", payload: { candidateIds: [protectedCard.id] } },
    { offset: 90, kind: "verify", payload: { artifactId: "verify-script:story-377", passed: true } },
  ]);

  const fitness = await evaluateKnowledgeFitness(fx.workspace, { at: AT });
  assert.equal(fitness.windowComplete, true);
  assert.equal(fitness.records.find((record) => record.id === idle.id).eligible, true);
  assert.equal(fitness.records.find((record) => record.id === protectedCard.id).retrievalCount, 1);
  assert.equal(fitness.records.find((record) => record.id === protectedCard.id).eligible, false);
  assert.equal(fitness.records.find((record) => record.id === reference.id).eligible, false);
  const verifyRow = fitness.records.find((record) => record.id === "verify-script:story-377");
  assert.equal(verifyRow.artifactKind, "telemetry-only");
  assert.equal(verifyRow.verifyFailureCount, 0);

  const beforeProposal = await readKnowledgeStoreMarker(fx.workspace);
  const proposals = await cliJson(["retire-proposals", "--workspace", fx.workspace, "--at", AT]);
  assert.equal(proposals.reasonCode, "KNOWLEDGE_RETIRE_PROPOSALS_READY");
  assert.equal(proposals.version, undefined, "read-only proposal query must not add a knowledge version");
  assert.ok(proposals.proposals.some((proposal) => proposal.id === idle.id && proposal.automatic === true));
  assert.ok(proposals.proposals.some((proposal) => proposal.id === "verify-script:story-377" && proposal.automatic === false));
  assert.equal(Number((await readKnowledgeStoreMarker(fx.workspace)).version), Number(beforeProposal.version));

  const swept = await retireKnowledgeSweep(fx.workspace, { at: AT });
  assert.deepEqual(swept.retired, [idle.id]);
  assert.ok(swept.proposals.some((proposal) => proposal.id === "verify-script:story-377" && proposal.requiresOwnerReview === true));
  const listed = await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" });
  const retired = listed.records.find((record) => record.id === idle.id);
  assert.equal(retired.lifecycle, "retired");
  assert.deepEqual(retired.retirement, {
    schemaVersion: "tcrn.knowledge-retirement.v1",
    id: idle.id,
    reason: "zero-retrieval-zero-reference",
    retrievalCount: 0,
    referenceCount: 0,
    observedEvents: 1,
    windowDays: 90,
    windowStart: "2026-06-12T00:00:00.000Z",
    windowEnd: "2026-09-09T23:59:59.999Z",
    sweptAt: AT,
  });
  await assert.rejects(readKnowledgeBody(fx.workspace, idle.id, { at: AT }), (error) => error?.reasonCode === "KNOWLEDGE_BODY_ACCESS_DENIED");
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" })).records.find((record) => record.id === protectedCard.id).lifecycle, "active");
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" })).records.find((record) => record.id === reference.id).lifecycle, "active");
  assert.equal((await readKnowledgeStoreMarker(fx.workspace)).lastSweepAt, AT);
  const historical = await cliJson(["retire-proposals", "--workspace", fx.workspace, "--at", "2026-09-10T20:00:00.000Z"]);
  assert.ok(historical.retiredRecords.some((record) => record.id === idle.id && record.retirement.id === idle.id));

  const repeat = await retireKnowledgeSweep(fx.workspace, { at: "2026-09-10T20:00:00.000Z" });
  assert.deepEqual(repeat.retired, []);
  assert.deepEqual(repeat.eligible, []);
  assert.equal(Number((await readKnowledgeStoreMarker(fx.workspace)).version), Number(swept.version));
});

test("STORY-377 GWT4: missing, invalid, and rolled-back observation windows never become zero", async (t) => {
  const incomplete = await fixture(t, "FIXTURE-STORY-377-INCOMPLETE");
  const missingCard = await card(incomplete, "STORY-377-MISSING");
  await fillWindow(incomplete, 89, [{ offset: 1, kind: "judge", payload: { candidateIds: [missingCard.id] } }]);
  const missingFitness = await evaluateKnowledgeFitness(incomplete.workspace, { at: AT });
  assert.equal(missingFitness.windowComplete, false);
  assert.ok(missingFitness.missingDays.length > 0);
  assert.equal(missingFitness.records.find((record) => record.id === missingCard.id).eligible, false);
  assert.deepEqual((await retireKnowledgeSweep(incomplete.workspace, { at: AT })).retired, []);
  assert.equal((await listKnowledgeMetadata(incomplete.workspace, { at: AT, selection: "all" })).records[0].lifecycle, "active");

  const invalid = await fixture(t, "FIXTURE-STORY-377-INVALID");
  const invalidCard = await card(invalid, "STORY-377-INVALID-CARD");
  await fillWindow(invalid, 90, [{ offset: 1, kind: "judge", payload: { candidateIds: [invalidCard.id] } }]);
  await appendFile(join(invalid.transient, "telemetry", dayFile(2)), "not-json\n");
  const invalidFitness = await evaluateKnowledgeFitness(invalid.workspace, { at: AT });
  assert.equal(invalidFitness.windowComplete, false);
  assert.ok(invalidFitness.invalidDays.includes(dayFile(2)));
  assert.equal((await retireKnowledgeSweep(invalid.workspace, { at: AT })).retired.length, 0);

  const rollback = await evaluateKnowledgeFitness(invalid.workspace, { at: "2026-01-01T00:00:00.000Z" });
  assert.equal(rollback.windowComplete, false);
  assert.equal(rollback.records.find((record) => record.id === invalidCard.id)?.eligible, false);
});

test("STORY-377: a stopped sweep recovers a retired card once, then its evidence survives telemetry cleanup", async (t) => {
  const fx = await fixture(t, "FIXTURE-STORY-377-RECOVERY");
  const target = await card(fx, "STORY-377-RECOVER");
  await fillWindow(fx, 90, [{ offset: 90, kind: "judge", payload: { candidateIds: [target.id] } }]);
  await assert.rejects(
    retireKnowledgeSweep(fx.workspace, { at: AT }, { faultAt: "after-metadata-write" }),
    (error) => error?.reasonCode === "KNOWLEDGE_FAULT_INJECTED",
  );
  const claimPath = join(fx.store, "mutation.claim");
  const claim = JSON.parse(await readFile(claimPath, "utf8"));
  claim.pid = process.pid + 1_000_000;
  await writeFile(claimPath, canonicalJson(claim));
  const recovered = await recoverKnowledgeStore(fx.workspace);
  assert.equal(recovered.reasonCode, "KNOWLEDGE_RECOVERED");
  assert.equal(recovered.reclaimedRetiredBodies, 1);
  const afterRecovery = (await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" })).records.find((record) => record.id === target.id);
  assert.equal(afterRecovery.lifecycle, "retired");
  assert.equal(afterRecovery.retirement.reason, "zero-retrieval-zero-reference");
  await assert.rejects(readKnowledgeBody(fx.workspace, target.id, { at: AT }), (error) => error?.reasonCode === "KNOWLEDGE_BODY_ACCESS_DENIED");
  await rm(join(fx.transient, "telemetry"), { recursive: true, force: true });
  const afterTelemetryCleanup = (await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" })).records.find((record) => record.id === target.id);
  assert.equal(afterTelemetryCleanup.retirement.observedEvents, 1);
  assert.equal((await recoverKnowledgeStore(fx.workspace)).reasonCode, "KNOWLEDGE_RECOVERY_NOT_NEEDED");
});

test("STORY-377: concurrent sweeps converge without a second retirement", async (t) => {
  const fx = await fixture(t, "FIXTURE-STORY-377-CONCURRENT");
  const target = await card(fx, "STORY-377-CONCURRENT-CARD");
  await fillWindow(fx, 90, [{ offset: 90, kind: "judge", payload: { candidateIds: [target.id] } }]);
  const outcomes = await Promise.all([retireKnowledgeSweep(fx.workspace, { at: AT }), retireKnowledgeSweep(fx.workspace, { at: AT })]);
  const retiredCount = outcomes.reduce((total, result) => total + result.retired.filter((id) => id === target.id).length, 0);
  assert.ok(retiredCount <= 1, "concurrent sweeps must not report a duplicate retirement");
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" })).records.find((record) => record.id === target.id).lifecycle, "retired");
});
