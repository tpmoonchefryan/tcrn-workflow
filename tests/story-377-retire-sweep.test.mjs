// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-377 — fitness, read-only removal proposals, and bounded retirement.
// TCRN-CROSS-MIN-225 (TCRN-CROSS-SUB-258): knowledge retires only through write-time conflict and
// --supersedes, and fitness is a read-only statistic. The fixtures below still write the observation
// records v1.2.0 relied on, so each case shows that none of them retires or counts anything now.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import {
  appendEvents,
  appendTelemetryRecord,
  acquireWorkspaceLease,
  captureKnowledgeUnit,
  createKnowledgeUnit,
  createTelemetryRecord,
  createProject,
  createWork,
  evaluateKnowledgeFreshness,
  initializeKnowledgeStore,
  initializeWorkspace,
  listKnowledgeMetadata,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  readKnowledgeBody,
  readKnowledgeStoreMarker,
  recoverKnowledgeStore,
  retireKnowledgeSweep,
  retireKnowledgeUnit,
  setWorkspaceSetting,
  sortWorkspaceSettings,
  validateWorkspace,
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

async function fixture(t, externalKey, { aggregateBytes, workItem = false } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s377-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = ["framework", "workspace", "transient", "evidence-locator", "release-trust"]
    .map((kind) => ({ kind, path: join(base, kind) }));
  for (const root of roots) await mkdir(root.path);
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey, createdAt: "2026-01-01T00:00:00Z" });
  const lease = await acquireWorkspaceLease(workspace, { now: "2026-01-01T00:00:01Z" });
  let workId = null;
  try {
    const project = await createProject(workspace, lease, {
      expectedVersion: 0,
      occurredAt: "2026-01-01T00:00:01Z",
      externalKey: `${externalKey}-PROJECT`,
      name: "Story 377 fixture",
    });
    // TCRN-CROSS-MIN-225 AC3: a store small enough to fill, set before the store is initialized.
    if (aggregateBytes !== undefined) {
      await setWorkspaceSetting(workspace, lease, { key: "knowledge.aggregateBytes", value: String(aggregateBytes), expectedVersion: 1, occurredAt: "2026-01-01T00:00:02Z" });
    }
    // TCRN-CROSS-MIN-225 AC5: a work record a telemetry event can name, so fitness digests it.
    if (workItem) {
      const state = await createWork(workspace, lease, { expectedVersion: project.version, occurredAt: "2026-01-01T00:00:03Z", projectId: project.projects[0].id, externalKey: `${externalKey}-INCIDENT`, kind: "Incident", parentId: null, title: "Story 377 telemetry-only artifact" });
      workId = state.work[0].id;
    }
  } finally {
    await lease.release();
  }
  await initializeKnowledgeStore(workspace);
  return { base, workspace, workId, transient: join(base, "transient"), store: join(workspace, "." + "tcrn-workflow", "knowledge") };
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
    for (const channel of ["retrieval", "reference", "trigger", "verify"]) {
      const kind = { retrieval: "retrieval-hit", reference: "reference", trigger: "trigger", verify: "verify" }[channel];
      await appendTelemetryRecord(fx.transient, createTelemetryRecord({
        at: eventAt(offset, 30),
        kind,
        session: `story-377-actual-${offset}-${channel}`,
        payload: { source: `story-377:actual:${channel}`, availability: "available" },
      }));
    }
    const beforeBoundaries = (await readFile(join(fx.transient, "telemetry", dayFile(offset)), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const start = windowDay(offset).toISOString();
    const endDate = windowDay(offset);
    endDate.setUTCHours(23, 59, 59, 999);
    const end = endDate.toISOString();
    for (const channel of ["retrieval", "reference", "trigger", "verify"]) {
      const kind = { retrieval: "retrieval-hit", reference: "reference", trigger: "trigger", verify: "verify" }[channel];
      const actual = beforeBoundaries.filter((record) => record.kind === kind && !String(record.payload.source).startsWith("telemetry:observation-collector:"));
      const highWater = { highWaterCount: actual.length, highWaterDigest: canonicalSha256(actual), highWaterAt: actual.at(-1)?.at ?? null };
      for (const [phase, at] of [["start", start], ["stop", end]]) {
        await appendTelemetryRecord(fx.transient, createTelemetryRecord({
          at,
          kind,
          session: `story-377-checkpoint-${offset}-${channel}`,
          payload: { source: `telemetry:observation-collector:story-377:${offset}:${channel}`, availability: "available", phase, sequence: phase === "start" ? 1 : 2, highWaterDay: start.slice(0, 10), ...highWater },
        }));
      }
    }
    const source = await readFile(join(fx.transient, "telemetry", dayFile(offset)), "utf8");
    const records = source.split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((record) => record.kind !== "observation-coverage")
      .sort((left, right) => left.at < right.at ? -1 : left.at > right.at ? 1 : left.id.localeCompare(right.id));
    const channelCheckpoints = Object.fromEntries(["retrieval", "reference", "trigger", "verify"].map((channel) => {
      const rows = records.filter((record) => record.payload.source === `telemetry:observation-collector:story-377:${offset}:${channel}` && ({ retrieval: "retrieval", reference: "reference", trigger: "trigger", verify: "verify" }[channel] === ({ retrieval: "retrieval", "retrieval-hit": "retrieval", reference: "reference", pull: "reference", trigger: "trigger", "rule-trigger": "trigger", verify: "verify" }[record.kind] ?? null)));
      const actual = records.filter((record) => ({ retrieval: "retrieval", reference: "reference", trigger: "trigger", verify: "verify" }[channel] === ({ retrieval: "retrieval", "retrieval-hit": "retrieval", reference: "reference", pull: "reference", trigger: "trigger", "rule-trigger": "trigger", verify: "verify" }[record.kind] ?? null) && !String(record.payload.source).startsWith("telemetry:observation-collector:")));
      return [channel, {
        availability: "available",
        source: `telemetry:observation-collector:story-377:${offset}:${channel}`,
        startSequence: rows[0]?.payload.sequence,
        stopSequence: rows.at(-1)?.payload.sequence,
        recordCount: rows.length,
        sourceDigest: canonicalSha256(rows),
        highWaterDay: start.slice(0, 10),
        highWaterCount: actual.length,
        highWaterDigest: canonicalSha256(actual),
      }];
    }));
    await appendTelemetryRecord(fx.transient, createTelemetryRecord({
      at: windowDay(offset - 1).toISOString(),
      kind: "observation-coverage",
      session: "story-377-test-collector",
      payload: {
        source: "telemetry:observation-collector", availability: "available",
        coveredFrom: windowDay(offset).toISOString(),
        coveredUntil: windowDay(offset - 1).toISOString(),
        channels: ["retrieval", "reference", "trigger", "verify"],
        coverageVersion: "tcrn.telemetry-observation-coverage.v1",
        channelCheckpoints,
        recordCount: records.length, sourceDigest: canonicalSha256(records),
        collectionErrors: 0, ...overrides,
      },
    }));
  }
}

async function cliJson(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function reasonOf(argv) {
  return runCli(argv, { write() {} }).then(() => null, (error) => error?.reasonCode);
}

// Every file of the knowledge store, by relative path. `cardsOnly` keeps metadata/ and bodies/: the
// cards themselves, without the marker and the derived view.
async function storeBytes(fx, { cardsOnly = false } = {}) {
  const files = {};
  const walk = async (directory, prefix) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${relative}/`);
      else files[relative] = await readFile(join(directory, entry.name), "utf8");
    }
  };
  await walk(fx.store, "");
  return cardsOnly ? Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith("metadata/") || path.startsWith("bodies/"))) : files;
}

// Records of the collector that v1.2.0 retired, as it wrote them: boundary rows, a collector
// self-check that even names a card, and a per-channel (v2) receipt beside the v1 ones sealWindow
// writes. They are history now; nothing may read them as evidence for or against a card.
async function legacyObservationRecords(fx, offset, cardId) {
  const day = windowDay(offset).toISOString().slice(0, 10);
  for (const [phase, at, sequence] of [["start", `${day}T00:00:00.000Z`, 1], ["stop", `${day}T23:59:59.999Z`, 2]]) {
    await appendTelemetryRecord(fx.transient, createTelemetryRecord({
      at, kind: "retrieval", session: `${day.replace(/-/gu, "")}.min-225`,
      payload: { source: `telemetry:observation-collector:claude:${day.replace(/-/gu, "")}.min-225:retrieval`, availability: "available", phase, sequence, highWaterDay: day, highWaterCount: 0, highWaterDigest: canonicalSha256([]), highWaterAt: null },
    }));
  }
  await appendTelemetryRecord(fx.transient, createTelemetryRecord({
    at: eventAt(offset, 55), kind: "collector-self-check", session: "min-225-self-check",
    payload: { source: "knowledge-inject:retrieval", channel: "retrieval", host: "claude", verdict: "ok", reasonCode: null, availability: "available", candidateIds: [cardId] },
  }));
  await appendTelemetryRecord(fx.transient, createTelemetryRecord({
    at: windowDay(offset - 1).toISOString(), kind: "observation-coverage", session: `observation-seal-${day}-retrieval`,
    payload: { source: "telemetry:observation-collector", availability: "available", coverageVersion: "tcrn.telemetry-observation-coverage.v2", coveredFrom: `${day}T00:00:00.000Z`, coveredUntil: windowDay(offset - 1).toISOString(), channel: "retrieval", outcome: "observed-zero", selfCheckIds: [], recordCount: 0, sourceDigest: canonicalSha256([]), collectionErrors: 0 },
  }));
}

// Per-day fitness summaries as the v1.2.0 seal wrote them under telemetry/summaries, each giving the
// card one observed event.
async function legacySummaries(fx, days, cardId) {
  const directory = join(fx.transient, "telemetry", "summaries");
  await mkdir(directory, { recursive: true });
  for (let offset = days; offset >= 1; offset -= 1) {
    const day = windowDay(offset).toISOString().slice(0, 10);
    await writeFile(join(directory, `${day}.json`), canonicalJson({
      schemaVersion: "tcrn.telemetry-fitness-summary.v1", day,
      channels: { reference: "sealed", retrieval: "sealed", trigger: "sealed", verify: "sealed" },
      rows: { [cardId]: [0, 0, 0, 0, 1, eventAt(offset), eventAt(offset)] },
    }));
  }
}

function afterFirstDay(firstDay, days) {
  const date = new Date(`${firstDay}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

// TCRN-CROSS-MIN-225 D1 (TCRN-CROSS-SUB-258): knowledge retires only through write-time conflict and
// --supersedes. The card below is small, idle and older than every window, and the telemetry holds 120
// complete days that v1.2.0 judged a complete window (v1 receipts, per-day summaries), with idle days,
// boundary rows, self-checks and a v2 receipt beside them. Before the change the sweep retired the card
// at the first instant with ninety observation days behind it; now no instant, window or minimum
// retires anything, and nothing in the store moves, the marker included.
test("MIN-225: retire-sweep retires nothing for any instant, window, or observation input", async (t) => {
  const fx = await fixture(t, "FIXTURE-MIN-225-SWEEP-GRID");
  const idle = await card(fx, "MIN-225-IDLE", { occurredAt: "2026-04-01T00:00:00.000Z" });
  await fillWindow(fx, 120, [{ offset: 120, kind: "judge", payload: { candidateIds: [idle.id] } }]);
  await legacySummaries(fx, 120, idle.id);
  for (const offset of [25, 15, 5]) await legacyObservationRecords(fx, offset, idle.id);
  for (let offset = 121; offset <= 125; offset += 1) await writeFile(join(fx.transient, "telemetry", dayFile(offset)), "");
  const firstDay = windowDay(120).toISOString().slice(0, 10);
  const before = await storeBytes(fx);
  const results = [];
  for (const days of [89, 90, 365, 3650]) {
    for (const windowDays of [1, 90, 3650]) {
      for (const minEvents of [1, 1_000_000]) {
        results.push(await cliJson(["retire-sweep", "--workspace", fx.workspace, "--at", afterFirstDay(firstDay, days), "--window-days", String(windowDays), "--min-events", String(minEvents)]));
      }
    }
    results.push(await retireKnowledgeSweep(fx.workspace, { at: afterFirstDay(firstDay, days) }));
  }
  results.push(...await Promise.all([
    retireKnowledgeSweep(fx.workspace, { at: afterFirstDay(firstDay, 90) }),
    retireKnowledgeSweep(fx.workspace, { at: afterFirstDay(firstDay, 3650) }),
  ]));
  assert.equal(results.length, 30);
  assert.deepEqual(results.map((result) => result.retired), Array(30).fill([]), "no instant, window, minimum or telemetry retires a card");
  assert.deepEqual(await storeBytes(fx), before, "every card, body, metadata file and the marker are byte-identical");
  assert.deepEqual([...new Set(results.map((result) => `${result.schemaVersion}|${result.reasonCode}`))], ["tcrn.knowledge-retire-sweep.v2|KNOWLEDGE_RETIRE_SWEEP_CONFLICT_ONLY"]);
  assert.deepEqual(results[1].retiredInputs, { "min-events": 1_000_000, "window-days": 1 }, "the retired flags are named back and have no effect");
  assert.equal(await reasonOf(["retire-sweep", "--workspace", fx.workspace, "--at", AT, "--window-days", "0"]), "KNOWLEDGE_INPUT_INVALID", "and are still validated");
  assert.equal(await reasonOf(["retire-sweep", "--workspace", fx.workspace, "--at", AT, "--min-events", "0"]), "KNOWLEDGE_INPUT_INVALID");
  const listed = (await listKnowledgeMetadata(fx.workspace, { at: afterFirstDay(firstDay, 3650), selection: "all" })).records.find((record) => record.id === idle.id);
  assert.equal(listed.lifecycle, "active");
  assert.equal(listed.retirement ?? null, null);
});

// AC2: the one automatic retirement left is the write path's own. A possible conflict is refused, and
// --supersedes marks the older card instead: out of default retrieval, still active, body kept.
test("MIN-225: a supersede write is the only retirement", async (t) => {
  const fx = await fixture(t, "FIXTURE-MIN-225-SUPERSEDE");
  const subject = "MIN-225 only a conflicting write retires a card";
  const lesson = (externalKey, overrides = {}) => ({
    occurredAt: "2026-06-12T00:00:00.000Z", externalKey, subject, summary: `${subject} summary`, snippet: `${subject} snippet`,
    tags: ["fitness"], accountableOwnerId: OWNER, body: `${externalKey} body`, ...overrides,
  });
  const old = await captureKnowledgeUnit(fx.workspace, lesson("MIN-225-OLD"));
  const refused = await captureKnowledgeUnit(fx.workspace, lesson("MIN-225-NEW")).then(() => null, (error) => error);
  assert.equal(refused?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "a conflicting write without --supersedes or --coexist is refused");
  const replacement = await captureKnowledgeUnit(fx.workspace, lesson("MIN-225-NEW", { supersedes: old.id }));
  assert.equal(replacement.superseded, old.id);
  const all = (await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" })).records;
  const replaced = all.find((record) => record.id === old.id);
  assert.equal(replaced.extensions.supersededBy, replacement.id, "the older card carries the mark");
  assert.equal(replaced.lifecycle, "active", "and is retired by the mark, not deleted");
  assert.equal((await readKnowledgeBody(fx.workspace, old.id, { at: AT })).body, "MIN-225-OLD body", "its body stays");
  assert.deepEqual((await listKnowledgeMetadata(fx.workspace, { at: AT })).records.map((record) => record.id), [replacement.id], "default retrieval answers with the new card only");
  const proposals = await cliJson(["retire-proposals", "--workspace", fx.workspace, "--at", AT]);
  assert.deepEqual([proposals.proposals, proposals.ruleDiffs, proposals.retiredRecords], [[], [], []], "and no other path proposes or records a retirement");
});

// AC3: time and capacity retire nothing. A card past its maximumAgeDays turns stale and stays active
// with its body; a store at its aggregate limit refuses the next write and evicts nothing.
test("MIN-225: a stale card and a full store lose nothing", async (t) => {
  const fx = await fixture(t, "FIXTURE-MIN-225-STALE");
  const stale = await createKnowledgeUnit(fx.workspace, {
    expectedVersion: Number((await readKnowledgeStoreMarker(fx.workspace)).version),
    occurredAt: "2026-06-12T00:00:00.000Z",
    externalKey: "MIN-225-STALE",
    scope: "workspace",
    projectId: null,
    roleScopes: [],
    category: "workflow",
    kind: "fact",
    tags: ["fitness"],
    subject: "MIN-225 stale fact",
    summary: "A fact that ages out",
    snippet: "A fact that ages out",
    accountableOwnerId: OWNER,
    sourceReferences: [],
    sourceDigest: canonicalSha256("min-225-stale"),
    supersedes: null,
    linkedWorkIds: [],
    linkedDecisionIds: [],
    linkedGateIds: [],
    linkedEvidenceIds: ["evidence:min-225-stale"],
    lifecycle: "active",
    retrievalDisposition: "default",
    freshnessState: "fresh",
    lastVerified: "2026-06-12T00:00:00.000Z",
    stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only",
    body: "MIN-225 stale body",
    coexist: true,
  });
  const cards = await storeBytes(fx, { cardsOnly: true });
  for (const at of [AT, "2027-09-10T12:00:00.000Z", "2036-09-10T12:00:00.000Z"]) {
    assert.deepEqual((await retireKnowledgeSweep(fx.workspace, { at })).retired, [], at);
    const listed = (await listKnowledgeMetadata(fx.workspace, { at, selection: "all" })).records.find((record) => record.id === stale.id);
    const freshness = (await evaluateKnowledgeFreshness(fx.workspace, at)).records.find((record) => record.id === stale.id);
    assert.deepEqual([listed.lifecycle, freshness.state], ["active", "stale"], `${at}: past maximumAgeDays the card is stale, not retired`);
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at })).records.some((record) => record.id === stale.id), false, "and default retrieval leaves it out");
  }
  assert.deepEqual(await storeBytes(fx, { cardsOnly: true }), cards, "its metadata and body are byte-identical");

  const full = await fixture(t, "FIXTURE-MIN-225-FULL", { aggregateBytes: 4_096 });
  const written = [];
  let refusal = null;
  for (let index = 0; index < 20 && refusal === null; index += 1) {
    try {
      written.push(await card(full, `MIN-225-FULL-${index}`, { body: `${"x".repeat(600)}${index}` }));
    } catch (error) {
      refusal = error;
    }
  }
  assert.equal(refusal?.reasonCode, "KNOWLEDGE_LIMIT_EXCEEDED", "the store fills to its aggregate limit");
  assert.ok(written.length >= 1);
  const fullCards = await storeBytes(full, { cardsOnly: true });
  const again = await card(full, "MIN-225-FULL-AGAIN", { body: "y" }).then(() => null, (error) => error);
  assert.equal(again?.reasonCode, "KNOWLEDGE_LIMIT_EXCEEDED", "a full store refuses the next write");
  assert.deepEqual(await storeBytes(full, { cardsOnly: true }), fullCards, "and evicts nothing to make room");
  assert.deepEqual((await listKnowledgeMetadata(full.workspace, { at: AT, selection: "all" })).records.map((record) => `${record.id}|${record.lifecycle}`).sort(), written.map((entry) => `${entry.id}|active`).sort());
});

// AC5: fitness is a read-only statistic over every readable record up to --at. The same cards and the
// same four-channel events give the same counts whether or not the telemetry also holds the retired
// observation records (v1 and v2 receipts, boundary rows, self-checks naming a card, per-day summaries),
// a historical lastSweepAt and a retirement record written the way the v1.2.0 sweep wrote one, through a
// stopped write that knowledge-recover completes.
test("MIN-225: fitness counts are read-only statistics that legacy observation records do not change", async (t) => {
  const build = async (withLegacy) => {
    const fx = await fixture(t, `FIXTURE-MIN-225-LEGACY-${withLegacy ? "WITH" : "WITHOUT"}`, { workItem: true });
    const idle = await card(fx, "MIN-225-LEGACY-IDLE", { occurredAt: "2026-04-01T00:00:00.000Z" });
    const busy = await card(fx, "MIN-225-LEGACY-BUSY", { occurredAt: "2026-04-01T00:00:00.000Z" });
    const swept = await card(fx, "MIN-225-LEGACY-SWEPT", { occurredAt: "2026-04-01T00:00:00.000Z" });
    const marker = await readKnowledgeStoreMarker(fx.workspace);
    const sweptRevision = (await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" })).records.find((record) => record.id === swept.id).revision;
    const retirement = { schemaVersion: "tcrn.knowledge-retirement.v1", id: swept.id, reason: "zero-retrieval-zero-reference", retrievalCount: 0, referenceCount: 0, observedEvents: 1, windowDays: 90, windowStart: "2026-06-03T00:00:00.000Z", windowEnd: "2026-08-31T23:59:59.999Z", sweptAt: "2026-09-01T00:47:10.039Z" };
    // A manual retirement stays compare-and-swap guarded. The write below stops after its metadata, as a
    // sweep could, and knowledge-recover reclaims the body once.
    await assert.rejects(
      retireKnowledgeUnit(fx.workspace, { expectedVersion: Number(marker.version) + 1, expectedRevision: sweptRevision, occurredAt: retirement.sweptAt, id: swept.id, retirement }),
      (error) => error?.reasonCode === "KNOWLEDGE_CAS_MISMATCH",
    );
    await assert.rejects(
      retireKnowledgeUnit(fx.workspace, { expectedVersion: Number(marker.version), expectedRevision: sweptRevision, occurredAt: retirement.sweptAt, id: swept.id, retirement }, { faultAt: "after-metadata-write" }),
      (error) => error?.reasonCode === "KNOWLEDGE_FAULT_INJECTED",
    );
    const claimPath = join(fx.store, "mutation.claim");
    await writeFile(claimPath, canonicalJson({ ...JSON.parse(await readFile(claimPath, "utf8")), pid: process.pid + 1_000_000 }));
    const recovered = await recoverKnowledgeStore(fx.workspace);
    assert.deepEqual([recovered.reasonCode, recovered.reclaimedRetiredBodies], ["KNOWLEDGE_RECOVERED", 1]);
    assert.equal((await recoverKnowledgeStore(fx.workspace)).reasonCode, "KNOWLEDGE_RECOVERY_NOT_NEEDED");
    await fillWindow(fx, 90, [
      { offset: 90, kind: "judge", payload: { candidateIds: [idle.id] } },
      { offset: 60, kind: "retrieval-hit", payload: { candidateIds: [busy.id] } },
      { offset: 30, kind: "pull", payload: { id: busy.id } },
      { offset: 10, kind: "verify", payload: { artifactId: "verify-script:min-225", passed: false } },
      { offset: 5, kind: "rule-trigger", payload: { artifactId: "rule:min-225" } },
      { offset: 20, kind: "retrieval-hit", payload: { candidateIds: [fx.workId] } },
    ], false);
    if (withLegacy) {
      await sealWindow(fx, 90);
      for (const offset of [80, 40, 2]) await legacyObservationRecords(fx, offset, idle.id);
      await legacySummaries(fx, 90, idle.id);
      const storeJson = join(fx.store, "store.json");
      await writeFile(storeJson, canonicalJson({ ...JSON.parse(await readFile(storeJson, "utf8")), lastSweepAt: "2026-09-01T00:47:10.039Z" }));
      assert.equal((await readKnowledgeStoreMarker(fx.workspace)).lastSweepAt, "2026-09-01T00:47:10.039Z", "the marker still reads a historical lastSweepAt");
    }
    const proposals = await cliJson(["retire-proposals", "--workspace", fx.workspace, "--at", AT]);
    return { fx, idle, busy, swept, proposals };
  };
  const without = await build(false);
  const withLegacy = await build(true);
  // The work record's id and digest differ between the two fixtures by construction; its counts may not.
  const telemetryOnly = (result) => result.proposals.records.filter((record) => record.artifactKind === "telemetry-only")
    .map((record) => (record.id === result.fx.workId ? { ...record, id: "work", baseDigest: "work-record" } : record));
  assert.deepEqual(telemetryOnly(withLegacy).map((record) => record.id), ["rule:min-225", "verify-script:min-225", "work"]);
  assert.deepEqual(telemetryOnly(withLegacy), telemetryOnly(without), "the rule, the check and the work record keep their counts");
  const workRow = withLegacy.proposals.records.find((record) => record.id === withLegacy.fx.workId);
  const workRecord = (await materializeWorkspace(withLegacy.fx.workspace)).work.find((entry) => entry.id === withLegacy.fx.workId);
  assert.deepEqual([workRow.retrievalCount, workRow.baseDigest], [1, canonicalSha256(workRecord)], "a work record named by an event is digested from the chain");
  assert.equal(withLegacy.proposals.records.length, without.proposals.records.length, "the same artifacts are counted");
  for (const [label, pick] of [["idle", (result) => result.idle.id], ["busy", (result) => result.busy.id], ["swept", (result) => result.swept.id]]) {
    const row = (result) => Object.fromEntries(Object.entries(result.proposals.records.find((record) => record.id === pick(result))).filter(([key]) => key !== "id"));
    assert.deepEqual(row(withLegacy), row(without), `${label}: every count is the same with and without the legacy records`);
  }
  const busyRow = withLegacy.proposals.records.find((record) => record.id === withLegacy.busy.id);
  assert.deepEqual([busyRow.retrievalCount, busyRow.referenceCount, busyRow.observedEvents], [1, 1, 2], "the real events are counted");
  const idleRow = withLegacy.proposals.records.find((record) => record.id === withLegacy.idle.id);
  assert.deepEqual([idleRow.retrievalCount, idleRow.referenceCount, idleRow.observedEvents], [0, 0, 1], "a self-check or summary naming the card adds nothing");
  for (const result of [without, withLegacy]) {
    assert.equal(result.proposals.schemaVersion, "tcrn.knowledge-fitness.v2");
    assert.equal(result.proposals.reasonCode, "KNOWLEDGE_RETIRE_PROPOSALS_READY");
    assert.deepEqual([result.proposals.proposals, result.proposals.ruleDiffs], [[], []], "nothing is proposed");
    assert.deepEqual(result.proposals.retiredRecords.map((record) => [record.id, record.retirement?.sweptAt]), [[result.swept.id, "2026-09-01T00:47:10.039Z"]], "the historical retirement record stays readable");
    for (const field of ["windowDays", "minEvents", "windows", "refusals", "windowComplete", "idleDays", "unprovenDays", "missingDays", "invalidDays", "windowStart", "windowEnd"]) assert.equal(Object.hasOwn(result.proposals, field), false, field);
    for (const field of ["eligible", "observationStart", "observationComplete"]) assert.equal(result.proposals.records.some((record) => Object.hasOwn(record, field)), false, field);
  }
  assert.deepEqual([without.proposals.lastSweepAt, withLegacy.proposals.lastSweepAt], [null, "2026-09-01T00:47:10.039Z"], "a historical lastSweepAt is listed, read-only");
  const fx = withLegacy.fx;
  assert.equal((await cliJson(["telemetry-list", "--workspace", fx.workspace, "--limit", "4096"])).reasonCode, "TELEMETRY_LIST_READY");
  assert.equal((await cliJson(["telemetry-stats", "--workspace", fx.workspace])).reasonCode, "TELEMETRY_STATS_READY");
  assert.equal((await cliJson(["knowledge-list", "--workspace", fx.workspace, "--at", AT, "--selection", "all", "--allow-trailing", "true"])).records.length, 3);
  assert.equal(await reasonOf(["telemetry-observation", "--workspace", fx.workspace, "--day", "2026-09-01"]), "TELEMETRY_OBSERVATION_RETIRED");
  for (const name of ["retire-proposals", "retire-sweep"]) {
    assert.deepEqual(COMMAND_CATALOG.find((entry) => entry.name === name)?.flags, [
      { name: "workspace", required: true, valueKind: "string" },
      { name: "at", required: true, valueKind: "instant" },
      { name: "window-days", required: false, valueKind: "integer" },
      { name: "min-events", required: false, valueKind: "integer" },
    ], `${name}: the catalog entry keeps the v1.2.0 flags`);
  }
});

// AC6: fitness.windowDays and fitness.minEvents are retired settings. A new write is refused as an
// unregistered key, and a chain that recorded one of them before the retirement still replays.
test("MIN-225: the retired fitness settings refuse new writes and their history still replays", async (t) => {
  const fx = await fixture(t, "FIXTURE-MIN-225-SETTINGS");
  const lease = await acquireWorkspaceLease(fx.workspace, { now: "2026-01-02T00:00:00Z" });
  try {
    await appendEvents(fx.workspace, lease, [
      (state) => ({
        payload: { operation: "settings.updated", record: { schemaVersion: "tcrn.workspace-setting.v1", key: "fitness.windowDays", layerKind: "workspace_configuration", value: "30", revision: 1, updatedAt: "2026-01-02T00:00:00Z", tombstone: false } },
        projects: state.projects,
        work: state.work,
        settings: state.settings,
      }),
    ], { expectedVersion: 1, occurredAt: "2026-01-02T00:00:00Z" });
  } finally {
    await lease.release();
  }
  const state = await materializeWorkspace(fx.workspace);
  assert.equal(state.version, 2, "the chain with the recorded value replays");
  assert.equal(state.settings.some((entry) => entry.key.startsWith("fitness.")), false, "the recorded value is history, not a current setting");
  for (const key of ["fitness.windowDays", "fitness.minEvents"]) {
    assert.equal(await reasonOf(["settings-set", "--workspace", fx.workspace, "--expected-version", "2", "--at", "2026-01-03T00:00:00Z", "--key", key, "--value", "30"]), "SETTINGS_KEY_UNREGISTERED", key);
  }
  assert.equal((await cliJson(["settings-catalog", "--workspace", fx.workspace])).settings.some((entry) => entry.key.startsWith("fitness.")), false, "the catalog no longer offers them");
  assert.equal((await cliJson(["retire-proposals", "--workspace", fx.workspace, "--at", AT])).reasonCode, "KNOWLEDGE_RETIRE_PROPOSALS_READY");
});

// TCRN-CROSS-INC-389 (STORY-465 R7): settings events exactly as the v1.2.0 core wrote them, appended raw.
// Until SUB-258 the fitness keys were live, so a recorded value also entered the current settings of that
// core: the member that records one carries it in its delta, and the views and any replay snapshot that
// append writes hold it, as they do on a chain written by 1.2.0 (problem list #578). A removal carries the
// payload removeWorkspaceSetting writes.
function recordedSetting(key, value, updatedAt) {
  const record = { schemaVersion: "tcrn.workspace-setting.v1", key, layerKind: "workspace_configuration", value, revision: 1, updatedAt, tombstone: false };
  return (state) => ({
    payload: { operation: "settings.updated", record },
    projects: state.projects,
    work: state.work,
    settings: sortWorkspaceSettings([...state.settings.filter((entry) => entry.key !== key), record]),
  });
}

function removedSetting(key, updatedAt) {
  return (state) => ({
    payload: { operation: "settings.removed", record: { key, updatedAt } },
    projects: state.projects,
    work: state.work,
    settings: state.settings.filter((entry) => entry.key !== key),
  });
}

async function appendSettingEvents(fx, expectedVersion, occurredAt, members) {
  const lease = await acquireWorkspaceLease(fx.workspace, { now: occurredAt });
  try {
    return await appendEvents(fx.workspace, lease, members, { expectedVersion, occurredAt });
  } finally {
    await lease.release();
  }
}

function settle(read) {
  return read.then((state) => ({ state }), (error) => ({ error }));
}

// The three ways a chain is read: seeded from its newest replay snapshot (every read verb), replayed from
// genesis, and with its views compared (validate). Each gives its state or its refusal.
async function readEveryWay(workspace) {
  return {
    snapshotSeeded: await settle(materializeWorkspace(workspace)),
    genesis: await settle(materializeWorkspaceFromGenesis(workspace)),
    validate: await settle(validateWorkspace(workspace)),
  };
}

// The newest replay snapshot as stored: its version and the keys of the settings it seeds.
async function newestSnapshotSettings(fx) {
  const directory = join(fx.workspace, "." + "tcrn-workflow", "snapshots");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const parts = await Promise.all(manifest.snapshotParts.map((part) => readFile(join(directory, part))));
  return { version: manifest.version, keys: JSON.parse(inflateSync(Buffer.concat(parts)).toString("utf8")).settings.map((entry) => entry.key) };
}

// A chain that took a replay snapshot while fitness.windowDays was live: version 2 sets an interval of two
// events, and one append records the retired key and a live one, ending on version 4, where the snapshot
// is written with both.
async function snapshotWhileRetiredKeyLive(t, externalKey) {
  const fx = await fixture(t, externalKey);
  await appendSettingEvents(fx, 1, "2026-01-02T00:00:00Z", [recordedSetting("storage.snapshotEveryEvents", "2", "2026-01-02T00:00:00Z")]);
  await appendSettingEvents(fx, 2, "2026-01-03T00:00:00Z", [
    recordedSetting("fitness.windowDays", "30", "2026-01-03T00:00:00Z"),
    recordedSetting("artifact.language", "zh-CN", "2026-01-03T00:00:00Z"),
  ]);
  assert.deepEqual(await newestSnapshotSettings(fx), { version: 4, keys: ["artifact.language", "fitness.windowDays", "storage.snapshotEveryEvents"] }, "the snapshot holds the retired key as 1.2.0 wrote it");
  return fx;
}

// INC-389 R1: a chain that set fitness.windowDays or fitness.minEvents under 1.1.0-1.2.0 and removed it
// again was valid there. The removal of a retired key is history, like the value it removed, so every read
// opens the chain and neither record is a current setting.
test("INC-389: a removed retired fitness setting replays as history in every read", async (t) => {
  for (const [key, value, label] of [["fitness.windowDays", "30", "WINDOW-DAYS"], ["fitness.minEvents", "5", "MIN-EVENTS"]]) {
    const fx = await fixture(t, `FIXTURE-INC-389-REMOVED-${label}`);
    await appendSettingEvents(fx, 1, "2026-01-02T00:00:00Z", [recordedSetting(key, value, "2026-01-02T00:00:00Z")]);
    await appendSettingEvents(fx, 2, "2026-01-03T00:00:00Z", [removedSetting(key, "2026-01-03T00:00:00Z")]);
    for (const [read, { state, error }] of Object.entries(await readEveryWay(fx.workspace))) {
      assert.equal(error, undefined, `${key} ${read}: ${error?.reasonCode} ${error?.message}`);
      assert.equal(state.version, 3, `${key} ${read}`);
      assert.deepEqual(state.settings, [], `${key} ${read}: the value and its removal are history, not a current setting`);
    }
  }
});

// INC-389 R1: the same holds for a key retired before fitness, model.economyTier.
test("INC-389: an earlier retired key set then removed replays in every read", async (t) => {
  const fx = await fixture(t, "FIXTURE-INC-389-REMOVED-ECONOMY-TIER");
  await appendSettingEvents(fx, 1, "2026-01-02T00:00:00Z", [recordedSetting("model.economyTier", "claude-sonnet-5", "2026-01-02T00:00:00Z")]);
  await appendSettingEvents(fx, 2, "2026-01-03T00:00:00Z", [removedSetting("model.economyTier", "2026-01-03T00:00:00Z")]);
  for (const [read, { state, error }] of Object.entries(await readEveryWay(fx.workspace))) {
    assert.equal(error, undefined, `${read}: ${error?.reasonCode} ${error?.message}`);
    assert.equal(state.version, 3, read);
    assert.deepEqual(state.settings, [], `${read}: the value and its removal are history, not a current setting`);
  }
});

// INC-389 R2 (#566): the snapshot is verified as stored and only its seed drops the retired key, so the
// snapshot-seeded read and a replay from genesis hold the same settings. validate is not asked: the views
// of this chain were projected with the key, so they read WORKSPACE_VIEW_STALE until recover or the next
// write rebuilds them (problem list #576).
test("INC-389: a replay snapshot taken while a retired key was live seeds the same settings as genesis", async (t) => {
  const fx = await snapshotWhileRetiredKeyLive(t, "FIXTURE-INC-389-SNAPSHOT");
  const seeded = await materializeWorkspace(fx.workspace);
  const genesis = await materializeWorkspaceFromGenesis(fx.workspace);
  assert.deepEqual(seeded.settings, genesis.settings, "the snapshot seed and genesis hold the same settings");
  assert.deepEqual(seeded.settings.map((entry) => entry.key), ["artifact.language", "storage.snapshotEveryEvents"], "neither holds the retired key");
  assert.deepEqual(seeded, genesis, "the two reads are the same state");
});

// INC-389 R1 and R2 (#529, #566): the same chain removes the retired key after the snapshot. The seed no
// longer holds the key and genesis never did; both read the removal as history and agree.
test("INC-389: a retired key removed after a replay snapshot reads the same in both replays", async (t) => {
  const fx = await snapshotWhileRetiredKeyLive(t, "FIXTURE-INC-389-SNAPSHOT-REMOVED");
  await appendSettingEvents(fx, 4, "2026-01-04T00:00:00Z", [removedSetting("fitness.windowDays", "2026-01-04T00:00:00Z")]);
  assert.equal((await newestSnapshotSettings(fx)).version, 4, "the removal comes after the newest snapshot");
  const reads = { snapshotSeeded: await settle(materializeWorkspace(fx.workspace)), genesis: await settle(materializeWorkspaceFromGenesis(fx.workspace)) };
  for (const [read, { state, error }] of Object.entries(reads)) {
    assert.equal(error, undefined, `${read}: ${error?.reasonCode} ${error?.message}`);
    assert.equal(state.version, 5, read);
  }
  assert.deepEqual(reads.snapshotSeeded.state.settings, reads.genesis.state.settings, "both reads hold the same settings");
  assert.deepEqual(reads.genesis.state.settings.map((entry) => entry.key), ["artifact.language", "storage.snapshotEveryEvents"], "neither holds the retired key");
});

// INC-389 changes only how replay reads a retired key. A live key removed without ever being set is still a
// corrupt chain in every read, and the write verbs still refuse both fitness keys without appending.
test("INC-389: live key rules and retired key refusals are unchanged", async (t) => {
  const corrupt = await fixture(t, "FIXTURE-INC-389-LIVE-REMOVE");
  await appendSettingEvents(corrupt, 1, "2026-01-02T00:00:00Z", [removedSetting("artifact.language", "2026-01-02T00:00:00Z")]);
  for (const [read, { error }] of Object.entries(await readEveryWay(corrupt.workspace))) {
    assert.equal(error?.reasonCode, "WORKSPACE_EVENT_CORRUPT", read);
    assert.match(error.message, /cannot remove unknown setting artifact\.language/u, read);
  }
  const fx = await fixture(t, "FIXTURE-INC-389-REFUSALS");
  for (const key of ["fitness.windowDays", "fitness.minEvents"]) {
    const write = ["--workspace", fx.workspace, "--expected-version", "1", "--at", "2026-01-02T00:00:00Z", "--key", key];
    assert.equal(await reasonOf(["settings-set", ...write, "--value", "30"]), "SETTINGS_KEY_UNREGISTERED", key);
    assert.equal(await reasonOf(["settings-remove", ...write]), "WORKSPACE_INPUT_INVALID", key);
  }
  assert.equal((await validateWorkspace(fx.workspace)).version, 1, "no refusal appended an event");
});
