// SPDX-License-Identifier: Apache-2.0

// WSD-1: conference and gate records as additive workspace event-log operations.
// Proves the store round-trip, unknown-operation fail-closed, openness rules at
// verb and replay layers, the single-event atomic close payload, tombstone and
// pinning rules, golden-byte view/export stability for workspaces without
// extension records, crash recovery of the extension view, and replay determinism.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EVENT_PAYLOAD_OPERATION_EXTRAS,
  acquireWorkspaceLease,
  appendConferencePositionInWorkspace,
  cancelConferenceInWorkspace,
  closeConferenceInWorkspace,
  createGateInWorkspace,
  readGateIdentityAuthority,
  createProject,
  createWork,
  deleteGateInWorkspace,
  exportWorkspace,
  initializeWorkspace,
  materializeWorkspace,
  openConferenceInWorkspace,
  recoverWorkspace,
  transitionGateInWorkspace,
  transitionWork,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import {
  assertCanonicalJson,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  createEvent,
  deriveStableId,
  validateEventChain,
} from "../dist/build/packages/protocol/src/index.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";

const instant = (second) => `2026-07-11T00:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;

// WSD-4: a satisfaction evidence locator shares the suffix of the minutes id it
// names — conference-minutes:<suffix> resolves to minutes:<suffix>.
const minutesLocator = (minutesExternalKey) => `conference-minutes:${deriveStableId("minutes", minutesExternalKey).slice("minutes:".length)}`;

async function workspaceFixture(context, options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-ext-store-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({
    roots,
    externalKey: options.externalKey ?? "WORKSPACE-EXT-STORE",
    createdAt: instant(0),
    segmentEventLimit: options.segmentEventLimit ?? 2,
  });
  return { base, roots, workspace };
}

// A project plus one Initiative, the anchor surface for conferences and gates.
async function seededFixture(context, options = {}) {
  const fixture = await workspaceFixture(context, options);
  const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
  context.after(() => lease.release().catch(() => undefined));
  let state = await createProject(fixture.workspace, lease, {
    expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-EXT", name: "Extension",
  });
  const projectId = state.projects[0].id;
  state = await createWork(fixture.workspace, lease, {
    expectedVersion: 1, occurredAt: instant(2), projectId, externalKey: "INITIATIVE-EXT", kind: "Initiative", parentId: null,
  });
  const workId = state.work[0].id;
  return { ...fixture, lease, state, projectId, workId };
}

function expectedStreamId(metadata) {
  return `stream:${canonicalSha256({
    schemaVersion: "tcrn.workspace-stream-identity.v1",
    workspaceId: metadata.workspaceId,
    createdAt: metadata.createdAt,
  }).slice(0, 24)}`;
}

function expectedEventId(streamId, sequence) {
  return `event:${canonicalSha256({
    schemaVersion: "tcrn.workspace-event-identity.v1",
    streamId,
    sequence,
  }).slice(0, 24)}`;
}

// Rebuilds the on-disk event chain from transformed {occurredAt, payload}
// specifications with correct stream/event identities and hash links, so replay
// negatives exercise exactly the reducer rules rather than chain integrity.
async function rewriteEventChain(workspace, transform) {
  const control = join(workspace, ".tcrn-workflow");
  const metadata = JSON.parse(await readFile(join(control, "workspace.json"), "utf8"));
  const eventsRoot = join(control, "events");
  const names = (await readdir(eventsRoot)).filter((name) => /^\d{6}\.json$/u.test(name)).sort();
  const original = [];
  for (const name of names) {
    original.push(...JSON.parse(await readFile(join(eventsRoot, name), "utf8")));
  }
  const specifications = transform(structuredClone(original));
  const streamId = expectedStreamId(metadata);
  const rebuilt = [];
  for (const [index, specification] of specifications.entries()) {
    const sequence = index + 1;
    rebuilt.push(createEvent({
      id: expectedEventId(streamId, sequence),
      streamId,
      sequence,
      occurredAt: specification.occurredAt,
      priorHash: rebuilt.at(-1)?.eventHash ?? null,
      payload: specification.payload,
    }));
  }
  for (const name of names) {
    await rm(join(eventsRoot, name));
  }
  for (let offset = 0; offset < rebuilt.length; offset += metadata.segmentEventLimit) {
    const segment = rebuilt.slice(offset, offset + metadata.segmentEventLimit);
    const index = Math.floor(offset / metadata.segmentEventLimit) + 1;
    await writeFile(join(eventsRoot, `${String(index).padStart(6, "0")}.json`), canonicalJson(segment));
  }
  return rebuilt;
}

function conferenceRecord(projectId, workId, overrides = {}) {
  return {
    schemaVersion: "tcrn.conference.v1.request",
    id: deriveStableId("conference", "CONF-FORGED"),
    projectId,
    type: "architecture",
    title: "Forged conference",
    linkedWorkIds: [workId],
    desiredOutcome: "decide the forged direction",
    participantIds: ["profile:reviewer-01"],
    status: "open",
    revision: 1,
    updatedAt: instant(3),
    tombstone: false,
    extensions: {},
    ...overrides,
  };
}

function minutesRecord(conferenceId, projectId, overrides = {}) {
  return {
    schemaVersion: "tcrn.conference.v1.minutes",
    id: deriveStableId("minutes", "MINUTES-FORGED"),
    conferenceId,
    projectId,
    summary: "Forged summary",
    outcomeClass: "role_decision",
    decisions: ["forged decision"],
    unresolvedIssues: [],
    revision: 1,
    updatedAt: instant(4),
    tombstone: false,
    extensions: {},
    ...overrides,
  };
}

function gateRecord(projectId, workId, overrides = {}) {
  return {
    schemaVersion: "tcrn.gate.v1",
    id: deriveStableId("gate", "GATE-FORGED"),
    projectId,
    workId,
    title: "Forged gate",
    outcomeClass: "role_decision",
    status: "pending",
    revision: 1,
    updatedAt: instant(3),
    tombstone: false,
    extensions: {},
    ...overrides,
  };
}

async function expectReasonAsync(reasonCode, operation) {
  await assert.rejects(operation, (error) => error?.reasonCode === reasonCode, reasonCode);
}

// WSD-2: drive runCli with a write-capture, the pattern the other CLI suites use.
async function invokeCli(args) {
  let output = "";
  return runCli(args, { write: (value) => { output += value; } }).then(
    () => ({ ok: true, output }),
    (error) => ({ ok: false, reasonCode: error?.reasonCode }),
  );
}

// The mutating verbs take no held lease into the fixture: they acquire their own
// under withLease. Seed the project + Initiative anchor through the CLI itself so
// the whole path — parse, lease, CAS, engine append, canonical receipt — is exercised.
async function cliSeededFixture(context) {
  const fx = await workspaceFixture(context);
  const ws = fx.workspace;
  const project = JSON.parse((await invokeCli(["project-create", "--workspace", ws, "--expected-version", "0", "--at", instant(1), "--external-key", "PROJECT-CLI", "--name", "CLI"])).output);
  const work = JSON.parse((await invokeCli(["work-create", "--workspace", ws, "--expected-version", "1", "--at", instant(2), "--project-id", project.record.id, "--external-key", "INITIATIVE-CLI", "--kind", "Initiative"])).output);
  return { ...fx, ws, projectId: project.record.id, workId: work.record.id };
}

test("conference and gate mutations round-trip through the event log with chained hashes, sorted collections, fresh views, and materialize parity", async (context) => {
  const fx = await seededFixture(context);
  let state = await openConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 2, occurredAt: instant(3), externalKey: "CONF-ALPHA", projectId: fx.projectId, type: "architecture",
    title: "Store design", linkedWorkIds: [fx.workId], desiredOutcome: "pick the persistence route", participantIds: ["profile:architect-01"],
  });
  const conferenceId = state.conferences[0].id;
  assert.equal(conferenceId, deriveStableId("conference", "CONF-ALPHA"));
  state = await appendConferencePositionInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 3, occurredAt: instant(4), conferenceId, externalKey: "POSITION-ALPHA-1", authorActorId: "profile:architect-01",
    position: "Persist through the workspace event log.", risks: ["forward-compat reads as corruption"], recommendations: ["document the posture"], evidenceIds: [],
  });
  state = await closeConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 4, occurredAt: instant(5), conferenceId, minutesExternalKey: "MINUTES-ALPHA",
    summary: "Event-log persistence ratified.", outcomeClass: "role_decision",
    decisions: ["persist conference and gate records as event operations"], unresolvedIssues: [],
  });
  state = await openConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 5, occurredAt: instant(6), externalKey: "CONF-BETA", projectId: fx.projectId, type: "risk",
    title: "Rollout risk", linkedWorkIds: [fx.workId], desiredOutcome: "assess rollout", participantIds: [],
  });
  const cancelledId = state.conferences.find((entry) => entry.id !== conferenceId).id;
  state = await cancelConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 6, occurredAt: instant(7), conferenceId: cancelledId,
  });
  state = await createGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 7, occurredAt: instant(8), externalKey: "GATE-ALPHA", projectId: fx.projectId, workId: fx.workId,
    title: "Decision gate", outcomeClass: "role_decision",
  });
  const gateId = state.gates[0].id;
  state = await transitionGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 8, occurredAt: instant(9), id: gateId, status: "blocked",
  });
  state = await transitionGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 9, occurredAt: instant(10), id: gateId, status: "satisfied", minutesLocator: minutesLocator("MINUTES-ALPHA"),
  });
  state = await createGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 10, occurredAt: instant(11), externalKey: "GATE-BETA", projectId: fx.projectId, workId: null,
    title: "Project-scoped gate", outcomeClass: "recommendation",
  });
  const deletedGateId = state.gates.find((entry) => entry.id !== gateId).id;
  state = await deleteGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 11, occurredAt: instant(12), id: deletedGateId,
  });

  assert.equal(state.version, 12, "version equals the event count");
  assert.equal(state.events.length, 12);
  assert.doesNotThrow(() => validateEventChain(state.events), "the persisted chain stays hash-linked");
  assert.equal(state.headEventHash, state.events.at(-1).eventHash);

  const closed = state.conferences.find((entry) => entry.id === conferenceId);
  assert.equal(closed.status, "closed");
  assert.equal(closed.revision, 2);
  assert.equal(state.conferences.find((entry) => entry.id === cancelledId).status, "cancelled");
  assert.equal(state.conferencePositions.length, 1);
  assert.equal(state.conferencePositions[0].conferenceId, conferenceId);
  assert.equal(state.conferenceMinutes.length, 1);
  assert.equal(state.conferenceMinutes[0].conferenceId, conferenceId);
  assert.equal(state.conferenceMinutes[0].revision, 1);
  const satisfied = state.gates.find((entry) => entry.id === gateId);
  assert.equal(satisfied.status, "satisfied");
  assert.equal(satisfied.revision, 3);
  assert.deepEqual(satisfied.extensions, { "gate-evidence:conference-minutes": { required: false, value: minutesLocator("MINUTES-ALPHA") } }, "WSD-4: the resolving locator persists in the gate extensions");
  assert.equal(state.gates.find((entry) => entry.id === deletedGateId).tombstone, true);
  for (const collection of [state.conferences, state.conferencePositions, state.conferenceMinutes, state.gates]) {
    const sorted = [...collection].sort((left, right) =>
      (left.projectId < right.projectId ? -1 : left.projectId > right.projectId ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    assert.deepEqual(collection, sorted, "collections are sorted by projectId then id");
  }

  // The committed state constructed from the mutation delta is byte-identical
  // to a fresh full replay (SDC-3 parity), and replay is deterministic.
  const fresh = await materializeWorkspace(fx.workspace);
  assert.deepEqual(fresh, state);
  assert.deepEqual(await materializeWorkspace(fx.workspace), fresh);

  // Views are fresh (including the fourth extension view), canonical, and stable.
  const validated = await validateWorkspace(fx.workspace);
  assert.equal(validated.version, 12);
  const viewsRoot = join(fx.workspace, ".tcrn-workflow", "views");
  assert.deepEqual((await readdir(viewsRoot)).sort(), ["STATUS.md", "extensions.json", "index.json", "readback.json"]);
  const extensionsBytes = await readFile(join(viewsRoot, "extensions.json"), "utf8");
  const extensionsIndex = assertCanonicalJson(extensionsBytes);
  assert.equal(extensionsIndex.schemaVersion, "tcrn.workspace-extension-index.v1");
  assert.deepEqual(Object.keys(extensionsIndex).sort(), ["conferenceMinutes", "conferencePositions", "conferences", "gates", "schemaVersion"]);
  assert.equal(extensionsIndex.conferences.length, 2);
  assert.equal(extensionsIndex.gates.length, 2);
  const firstRead = await readFile(join(viewsRoot, "extensions.json"));
  assert.deepEqual(await readFile(join(viewsRoot, "extensions.json")), firstRead, "view bytes are stable across reads");

  // The export carries the collections and round-trips canonically.
  const exported = assertCanonicalJson(await exportWorkspace(fx.workspace));
  assert.equal(exported.conferences.length, 2);
  assert.equal(exported.conferencePositions.length, 1);
  assert.equal(exported.conferenceMinutes.length, 1);
  assert.equal(exported.gates.length, 2);

  // The atomic close event carries exactly {minutes, operation, record}.
  const closeEvent = state.events.find((entry) => entry.payload.operation === "conference.closed");
  assert.deepEqual(Object.keys(closeEvent.payload).sort(), ["minutes", "operation", "record"]);
  assert.deepEqual(EVENT_PAYLOAD_OPERATION_EXTRAS["conference.closed"], ["minutes"]);
  assert.equal(closeEvent.payload.record.status, "closed");
  assert.equal(closeEvent.payload.minutes.conferenceId, conferenceId);
});

test("mutation-time rules fail closed without appending an event", async (context) => {
  const fx = await seededFixture(context);
  let state = await openConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 2, occurredAt: instant(3), externalKey: "CONF-RULES", projectId: fx.projectId, type: "verification",
    title: "Rules", linkedWorkIds: [fx.workId], desiredOutcome: "verify the rules", participantIds: [],
  });
  const conferenceId = state.conferences[0].id;
  state = await closeConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 3, occurredAt: instant(4), conferenceId, minutesExternalKey: "MINUTES-RULES",
    summary: "Closed.", outcomeClass: "discussion_only", decisions: [], unresolvedIssues: [],
  });
  const version = state.version;
  const closedConferenceCases = [
    () => appendConferencePositionInWorkspace(fx.workspace, fx.lease, {
      expectedVersion: version, occurredAt: instant(5), conferenceId, externalKey: "POSITION-LATE", actorId: "profile:late-01",
      position: "Too late.", risks: [], recommendations: [], evidenceIds: [],
    }),
    () => closeConferenceInWorkspace(fx.workspace, fx.lease, {
      expectedVersion: version, occurredAt: instant(5), conferenceId, minutesExternalKey: "MINUTES-AGAIN",
      summary: "Again.", outcomeClass: "discussion_only", decisions: [], unresolvedIssues: [],
    }),
    () => cancelConferenceInWorkspace(fx.workspace, fx.lease, {
      expectedVersion: version, occurredAt: instant(5), conferenceId,
    }),
  ];
  for (const operation of closedConferenceCases) {
    await expectReasonAsync("WORKSPACE_CONFERENCE_NOT_OPEN", operation);
  }
  await expectReasonAsync("WORKSPACE_INPUT_INVALID", () => appendConferencePositionInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: version, occurredAt: instant(5), conferenceId: "conference:000000000000000000000000", externalKey: "POSITION-NOWHERE",
    actorId: "profile:late-01", position: "No conference.", risks: [], recommendations: [], evidenceIds: [],
  }));
  await expectReasonAsync("WORKSPACE_INPUT_INVALID", () => openConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: version, occurredAt: instant(5), externalKey: "CONF-DEAD-WORK", projectId: fx.projectId, type: "risk",
    title: "Dead anchor", linkedWorkIds: ["work:000000000000000000000000"], desiredOutcome: "anchor", participantIds: [],
  }));
  await expectReasonAsync("WORKSPACE_INPUT_INVALID", () => createGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: version, occurredAt: instant(5), externalKey: "GATE-DEAD-WORK", projectId: fx.projectId,
    workId: "work:000000000000000000000000", title: "Dead anchor", outcomeClass: "recommendation",
  }));
  await expectReasonAsync("WORKSPACE_INPUT_INVALID", () => transitionGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: version, occurredAt: instant(5), id: "gate:000000000000000000000000", status: "blocked",
  }));
  // Validator failures surface verbatim for the CLI layer to pass through.
  await expectReasonAsync("CONFERENCE_SCHEMA_INVALID", () => openConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: version, occurredAt: instant(5), externalKey: "CONF-BAD-TYPE", projectId: fx.projectId, type: "committee",
    title: "Bad type", linkedWorkIds: [fx.workId], desiredOutcome: "reject", participantIds: [],
  }));
  await expectReasonAsync("GATE_SCHEMA_INVALID", () => createGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: version, occurredAt: instant(5), externalKey: "GATE-BAD-CLASS", projectId: fx.projectId, workId: fx.workId,
    title: "Bad class", outcomeClass: "committee_decision",
  }));
  await expectReasonAsync("WORKSPACE_CAS_MISMATCH", () => cancelConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: version + 7, occurredAt: instant(5), conferenceId,
  }));
  assert.equal((await materializeWorkspace(fx.workspace)).version, version, "no failed mutation appended an event");
});

test("hand-crafted event logs fail replay closed: unknown operations, openness, binding, pinning, tombstone, and validator rules", async (context) => {
  const record = (payload, second) => ({ occurredAt: instant(second), payload });
  const cases = [
    ["unknown operation conference.reopened", (fx) => [record({ operation: "conference.reopened", record: conferenceRecord(fx.projectId, fx.workId) }, 3)]],
    ["position appended to a closed conference", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      const closed = { ...conference, status: "closed", revision: 2, updatedAt: instant(4) };
      const minutes = minutesRecord(conference.id, fx.projectId);
      const position = {
        schemaVersion: "tcrn.conference.v1.position",
        id: deriveStableId("position", "POSITION-FORGED"),
        conferenceId: conference.id,
        projectId: fx.projectId,
        actorId: "profile:forger-01",
        position: "too late",
        risks: [],
        recommendations: [],
        evidenceIds: [],
        revision: 1,
        updatedAt: instant(5),
        tombstone: false,
        extensions: {},
      };
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ minutes, operation: "conference.closed", record: closed }, 4),
        record({ operation: "conference.position.appended", record: position }, 5),
      ];
    }],
    ["cancel of a cancelled conference", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      const cancelled = { ...conference, status: "cancelled", revision: 2, updatedAt: instant(4) };
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ operation: "conference.updated", record: cancelled }, 4),
        record({ operation: "conference.updated", record: { ...cancelled, revision: 3, updatedAt: instant(5) } }, 5),
      ];
    }],
    ["timestamp not event-bound", (fx) => [record({ operation: "conference.created", record: conferenceRecord(fx.projectId, fx.workId, { updatedAt: instant(9) }) }, 3)]],
    ["create with a prior revision", (fx) => [record({ operation: "conference.created", record: conferenceRecord(fx.projectId, fx.workId, { revision: 2 }) }, 3)]],
    ["duplicate conference create", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ operation: "conference.created", record: { ...conference, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["cancel that mutates a pinned field", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ operation: "conference.updated", record: { ...conference, status: "cancelled", title: "Renamed", revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["cancel that skips a revision", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ operation: "conference.updated", record: { ...conference, status: "cancelled", revision: 3, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["close without the minutes extra", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ operation: "conference.closed", record: { ...conference, status: "closed", revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["close whose minutes bind another conference", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      const minutes = minutesRecord("conference:000000000000000000000000", fx.projectId);
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ minutes, operation: "conference.closed", record: { ...conference, status: "closed", revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["conference for a missing project", (fx) => [record({ operation: "conference.created", record: conferenceRecord("project:000000000000000000000000", fx.workId) }, 3)]],
    ["conference anchored to missing work", (fx) => [record({ operation: "conference.created", record: conferenceRecord(fx.projectId, "work:000000000000000000000000") }, 3)]],
    ["conference record with an unknown field maps ConferenceError to corruption", (fx) => [record({ operation: "conference.created", record: { ...conferenceRecord(fx.projectId, fx.workId), forged: true } }, 3)]],
    ["gate created outside pending", (fx) => [record({ operation: "gate.created", record: gateRecord(fx.projectId, fx.workId, { status: "satisfied" }) }, 3)]],
    ["gate record with a bad outcome class maps AssignmentGateError to corruption", (fx) => [record({ operation: "gate.created", record: gateRecord(fx.projectId, fx.workId, { outcomeClass: "committee_decision" }) }, 3)]],
    ["gate update that moves its work anchor", (fx) => {
      const gate = gateRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "gate.created", record: gate }, 3),
        record({ operation: "gate.updated", record: { ...gate, workId: null, status: "blocked", revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["gate mutation after its tombstone", (fx) => {
      const gate = gateRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "gate.created", record: gate }, 3),
        record({ operation: "gate.deleted", record: { ...gate, tombstone: true, revision: 2, updatedAt: instant(4) } }, 4),
        record({ operation: "gate.updated", record: { ...gate, status: "blocked", revision: 3, updatedAt: instant(5) } }, 5),
      ];
    }],
    ["gate delete that does not tombstone", (fx) => {
      const gate = gateRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "gate.created", record: gate }, 3),
        record({ operation: "gate.deleted", record: { ...gate, revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
    // WSD-4 replay parity: a log that drives a work item to done while a
    // non-tombstoned pending gate anchors it fails materialize.
    ["work driven to done past a pending gate", (fx) => {
      const work = fx.state.work.find((entry) => entry.id === fx.workId);
      const gate = gateRecord(fx.projectId, fx.workId, { updatedAt: instant(5) });
      return [
        record({ operation: "work.updated", record: { ...work, status: "ready", revision: 2, updatedAt: instant(3) } }, 3),
        record({ operation: "work.updated", record: { ...work, status: "active", revision: 3, updatedAt: instant(4) } }, 4),
        record({ operation: "gate.created", record: gate }, 5),
        record({ operation: "work.updated", record: { ...work, status: "done", revision: 4, updatedAt: instant(6) } }, 6),
      ];
    }],
    // WSD-4 replay parity: a gate.updated to satisfied re-resolves its persisted
    // evidence — a log with no resolving minutes, no evidence entry, or an
    // off-graph gate move all fail closed.
    ["gate satisfied in a log without resolving minutes", (fx) => {
      const gate = gateRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "gate.created", record: gate }, 3),
        record({ operation: "gate.updated", record: { ...gate, status: "satisfied", revision: 2, updatedAt: instant(4), extensions: { "gate-evidence:conference-minutes": { required: false, value: "conference-minutes:000000000000000000000000" } } } }, 4),
      ];
    }],
    ["gate satisfied in a log without an evidence entry", (fx) => {
      const gate = gateRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "gate.created", record: gate }, 3),
        record({ operation: "gate.updated", record: { ...gate, status: "satisfied", revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["gate off-graph no-op transition pending to pending", (fx) => {
      const gate = gateRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "gate.created", record: gate }, 3),
        record({ operation: "gate.updated", record: { ...gate, revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
  ];
  for (const [name, forge] of cases) {
    await context.test(name, async (caseContext) => {
      const fx = await seededFixture(caseContext);
      await rewriteEventChain(fx.workspace, (events) => [
        ...events.map((event) => ({ occurredAt: event.occurredAt, payload: event.payload })),
        ...forge(fx),
      ]);
      await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fx.workspace));
    });
  }
});

test("a workspace with zero conference/gate events keeps pre-change golden view bytes, view set, and export digest", async (context) => {
  const fixture = await workspaceFixture(context, { externalKey: "WORKSPACE-GOLDEN" });
  const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
  context.after(() => lease.release().catch(() => undefined));
  let state = await createProject(fixture.workspace, lease, {
    expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-GOLDEN", name: "Golden",
  });
  state = await createWork(fixture.workspace, lease, {
    expectedVersion: 1, occurredAt: instant(2), projectId: state.projects[0].id, externalKey: "INITIATIVE-GOLDEN", kind: "Initiative", parentId: null,
  });
  state = await transitionWork(fixture.workspace, lease, {
    expectedVersion: 2, occurredAt: instant(3), id: state.work[0].id, status: "ready",
  });
  assert.deepEqual(state.conferences, []);
  assert.deepEqual(state.conferencePositions, []);
  assert.deepEqual(state.conferenceMinutes, []);
  assert.deepEqual(state.gates, []);
  const viewsRoot = join(fixture.workspace, ".tcrn-workflow", "views");
  assert.deepEqual((await readdir(viewsRoot)).sort(), ["STATUS.md", "index.json", "readback.json"], "extensions.json is absent");
  // Golden bytes captured from the pre-WSD-1 build of this exact scenario: the
  // legacy views must stay byte-identical for extension-free workspaces.
  assert.equal(await readFile(join(viewsRoot, "STATUS.md"), "utf8"), [
    "# Workspace Status",
    "",
    "- Workspace: `workspace:fefacf6fbd4eba98d40fdf99`",
    "- Version: 3",
    "- Projects: 1",
    "- Work records: 1",
    "- Graph digest: `07828d3f4177f8e9db723b6d0d8194f47b7c66185413b59718aa58443f5be835`",
    "- Authority: derived and rebuildable from the event chain",
    "",
  ].join("\n"));
  assert.equal(
    await readFile(join(viewsRoot, "index.json"), "utf8"),
    "{\"projects\":[{\"externalKey\":\"PROJECT-GOLDEN\",\"id\":\"project:0bf1a7f60bdb47a6be9f4586\",\"name\":\"Golden\",\"revision\":1,\"schemaVersion\":\"tcrn.project.v1\",\"tombstone\":false,\"updatedAt\":\"2026-07-11T00:00:01Z\"}],\"schemaVersion\":\"tcrn.workspace-index.v1\",\"work\":[{\"extensions\":{},\"externalKey\":\"INITIATIVE-GOLDEN\",\"id\":\"work:7370232bfce90e21835d2977\",\"kind\":\"Initiative\",\"parentId\":null,\"projectId\":\"project:0bf1a7f60bdb47a6be9f4586\",\"revision\":2,\"schemaVersion\":\"tcrn.work.v1\",\"status\":\"ready\",\"tombstone\":false,\"updatedAt\":\"2026-07-11T00:00:03Z\"}]}\n",
  );
  assert.equal(
    await readFile(join(viewsRoot, "readback.json"), "utf8"),
    "{\"authority\":\"derived-rebuildable\",\"graphDigest\":\"07828d3f4177f8e9db723b6d0d8194f47b7c66185413b59718aa58443f5be835\",\"headEventHash\":\"ed12d354e1286fa89f897ad8b5259d4bc2bc90f56a586ae02c46bb58e1c0ffa4\",\"projectCount\":1,\"schemaVersion\":\"tcrn.workspace-readback.v1\",\"version\":3,\"workCount\":1,\"workspaceId\":\"workspace:fefacf6fbd4eba98d40fdf99\"}\n",
  );
  const exported = await exportWorkspace(fixture.workspace);
  assert.equal(canonicalSha256(assertCanonicalJson(exported)).length, 64);
  assert.equal(
    (await import("node:crypto")).createHash("sha256").update(exported, "utf8").digest("hex"),
    "1cfc48bea69a4c20a69771f09c050cb6880036460a2571dfb32d1dca99a274c0",
    "export bytes match the pre-WSD-1 build",
  );
  assert.equal(exported.includes("conferences"), false, "no extension keys leak into legacy exports");
  await validateWorkspace(fixture.workspace);
});

test("a crash across conference.closed leaves the event durable and recover() rebuilds extensions.json", async (context) => {
  for (const crashAt of ["after-event-commit", "before-view-commit"]) {
    await context.test(crashAt, async (caseContext) => {
      const fx = await seededFixture(caseContext);
      let state = await openConferenceInWorkspace(fx.workspace, fx.lease, {
        expectedVersion: 2, occurredAt: instant(3), externalKey: "CONF-CRASH", projectId: fx.projectId, type: "release",
        title: "Crash close", linkedWorkIds: [fx.workId], desiredOutcome: "close across a crash", participantIds: [],
      });
      const conferenceId = state.conferences[0].id;
      await expectReasonAsync("WORKSPACE_FAULT_INJECTED", () => closeConferenceInWorkspace(fx.workspace, fx.lease, {
        expectedVersion: 3, occurredAt: instant(4), conferenceId, minutesExternalKey: "MINUTES-CRASH",
        summary: "Crashed close.", outcomeClass: "role_decision", decisions: ["recover"], unresolvedIssues: [], crashAt,
      }));
      // The event committed before the crash, so views are stale until recovery.
      await expectReasonAsync("WORKSPACE_VIEW_STALE", () => validateWorkspace(fx.workspace));
      const recovered = await recoverWorkspace(fx.workspace, fx.lease);
      assert.equal(recovered.version, 4);
      assert.equal(recovered.conferences.find((entry) => entry.id === conferenceId).status, "closed");
      assert.equal(recovered.conferenceMinutes.length, 1);
      const validated = await validateWorkspace(fx.workspace);
      assert.equal(validated.version, 4);
      const extensionsIndex = assertCanonicalJson(await readFile(join(fx.workspace, ".tcrn-workflow", "views", "extensions.json"), "utf8"));
      assert.equal(extensionsIndex.conferences[0].status, "closed");
      assert.equal(extensionsIndex.conferenceMinutes.length, 1);
    });
  }
});

test("WSD-2: the eight governed verbs plus gate-delete mutate and read under lease and CAS with canonical receipts and deterministic list ordering", async (context) => {
  const fx = await cliSeededFixture(context);
  const ws = fx.ws;

  // conference-open — version 2 -> 3, receipt is canonical and names the new id.
  const openResult = await invokeCli(["conference-open", "--workspace", ws, "--expected-version", "2", "--at", instant(3),
    "--external-key", "CONF-CLI", "--project-id", fx.projectId, "--type", "architecture", "--title", "Store design",
    "--work-ids", fx.workId, "--desired-outcome", "pick the persistence route", "--participant-ids", "profile:architect-01"]);
  const openReceipt = assertCanonicalJson(openResult.output);
  assert.equal(openReceipt.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(openReceipt.version, 3);
  assert.equal(openReceipt.recordId, deriveStableId("conference", "CONF-CLI"));
  const conferenceId = openReceipt.recordId;

  // conference-append-position — empty list flags via the "-" sentinel.
  const positionReceipt = assertCanonicalJson((await invokeCli(["conference-append-position", "--workspace", ws,
    "--expected-version", "3", "--at", instant(4), "--conference-id", conferenceId, "--external-key", "POSITION-CLI-1",
    "--actor-id", "profile:architect-01", "--position", "persist through the workspace event log",
    "--risks", "forward reads corruption", "--recommendations", "document the posture", "--evidence-ids", "-"])).output);
  assert.equal(positionReceipt.version, 4);
  assert.equal(positionReceipt.recordId, deriveStableId("position", "POSITION-CLI-1"));

  // conference-close via the head sentinel — resolves to 4 under the lease, appends to 5.
  const closeReceipt = assertCanonicalJson((await invokeCli(["conference-close", "--workspace", ws,
    "--expected-version", "head", "--at", instant(5), "--conference-id", conferenceId, "--minutes-external-key", "MINUTES-CLI",
    "--summary", "event-log persistence ratified", "--outcome-class", "role_decision",
    "--decisions", "persist conference and gate records as event operations", "--unresolved-issues", "-"])).output);
  assert.equal(closeReceipt.version, 5);
  assert.equal(closeReceipt.recordId, deriveStableId("minutes", "MINUTES-CLI"));

  // A second conference so conference-list-by-work returns more than one record to order.
  await invokeCli(["conference-open", "--workspace", ws, "--expected-version", "5", "--at", instant(6),
    "--external-key", "CONF-CLI-2", "--project-id", fx.projectId, "--type", "risk", "--title", "Risk review",
    "--work-ids", fx.workId, "--desired-outcome", "accept residual risk", "--participant-ids", "-"]);

  // conference-cancel — the second conference, recordId echoes the supplied id.
  const cancelReceipt = assertCanonicalJson((await invokeCli(["conference-cancel", "--workspace", ws,
    "--expected-version", "6", "--at", instant(7), "--conference-id", deriveStableId("conference", "CONF-CLI-2")])).output);
  assert.equal(cancelReceipt.version, 7);
  assert.equal(cancelReceipt.recordId, deriveStableId("conference", "CONF-CLI-2"));

  // conference-list-by-work — no lease, byte-identical across invocations, cancelled
  // conference excluded (list filters tombstone only, so the cancelled-but-not-tombstoned
  // record is still present); assert deterministic bytes and projectId-then-id ordering.
  const listConfA = (await invokeCli(["conference-list-by-work", "--workspace", ws, "--work-id", fx.workId])).output;
  const listConfB = (await invokeCli(["conference-list-by-work", "--workspace", ws, "--work-id", fx.workId])).output;
  assert.equal(listConfA, listConfB, "conference-list-by-work is byte-identical across invocations");
  const conferences = JSON.parse(listConfA);
  assert.deepEqual(conferences.map((entry) => entry.id), [...conferences.map((entry) => entry.id)]
    .sort((left, right) => compareCanonicalText(left, right)));

  // gate-create with a work anchor, then a second workspace-level gate ("-").
  const gateReceipt = assertCanonicalJson((await invokeCli(["gate-create", "--workspace", ws, "--expected-version", "7",
    "--at", instant(8), "--external-key", "GATE-CLI", "--project-id", fx.projectId, "--work-id", fx.workId,
    "--title", "Decision gate", "--outcome-class", "role_decision"])).output);
  assert.equal(gateReceipt.version, 8);
  assert.equal(gateReceipt.recordId, deriveStableId("gate", "GATE-CLI"));
  await invokeCli(["gate-create", "--workspace", ws, "--expected-version", "8", "--at", instant(9),
    "--external-key", "GATE-CLI-2", "--project-id", fx.projectId, "--work-id", fx.workId,
    "--title", "Second gate", "--outcome-class", "recommendation"]);

  // gate-transition pending -> satisfied, carrying the resolving minutes locator.
  const transitionReceipt = assertCanonicalJson((await invokeCli(["gate-transition", "--workspace", ws,
    "--expected-version", "9", "--at", instant(10), "--id", deriveStableId("gate", "GATE-CLI"), "--status", "satisfied",
    "--minutes-locator", minutesLocator("MINUTES-CLI")])).output);
  assert.equal(transitionReceipt.version, 10);
  assert.equal(transitionReceipt.recordId, deriveStableId("gate", "GATE-CLI"));

  // gate-list — byte-identical across invocations, sorted by projectId then id.
  const listGateA = (await invokeCli(["gate-list", "--workspace", ws, "--work-id", fx.workId])).output;
  const listGateB = (await invokeCli(["gate-list", "--workspace", ws, "--work-id", fx.workId])).output;
  assert.equal(listGateA, listGateB, "gate-list is byte-identical across invocations");
  const gates = JSON.parse(listGateA);
  assert.equal(gates.length, 2);
  assert.deepEqual(gates.map((entry) => entry.id), [...gates.map((entry) => entry.id)]
    .sort((left, right) => compareCanonicalText(left, right)));

  // gate-delete (GAP-10) tombstones the gate; it then drops out of gate-list.
  const deleteReceipt = assertCanonicalJson((await invokeCli(["gate-delete", "--workspace", ws, "--expected-version", "10",
    "--at", instant(11), "--id", deriveStableId("gate", "GATE-CLI")])).output);
  assert.equal(deleteReceipt.version, 11);
  assert.equal(deleteReceipt.recordId, deriveStableId("gate", "GATE-CLI"));
  const gatesAfterDelete = JSON.parse((await invokeCli(["gate-list", "--workspace", ws, "--work-id", fx.workId])).output);
  assert.deepEqual(gatesAfterDelete.map((entry) => entry.id), [deriveStableId("gate", "GATE-CLI-2")]);
});

test("WSD-2: every mutating verb fails closed on stale CAS, malformed enums pass through to the engine, and contention reports WORKSPACE_LOCKED", async (context) => {
  const fx = await cliSeededFixture(context);
  const ws = fx.ws;

  // CAS discipline: conference-open twice with the same expected-version. The second
  // materialize sees version 3, not 2, and fails before the reducer runs.
  await invokeCli(["conference-open", "--workspace", ws, "--expected-version", "2", "--at", instant(3),
    "--external-key", "CONF-CAS", "--project-id", fx.projectId, "--type", "architecture", "--title", "CAS",
    "--work-ids", fx.workId, "--desired-outcome", "prove CAS", "--participant-ids", "-"]);
  const casReplay = await invokeCli(["conference-open", "--workspace", ws, "--expected-version", "2", "--at", instant(4),
    "--external-key", "CONF-CAS-B", "--project-id", fx.projectId, "--type", "architecture", "--title", "CAS again",
    "--work-ids", fx.workId, "--desired-outcome", "prove CAS", "--participant-ids", "-"]);
  assert.equal(casReplay.ok, false);
  assert.equal(casReplay.reasonCode, "WORKSPACE_CAS_MISMATCH");

  // Fail-closed enum passthrough: a bogus --type surfaces the engine's verbatim code.
  const badType = await invokeCli(["conference-open", "--workspace", ws, "--expected-version", "3", "--at", instant(5),
    "--external-key", "CONF-BAD", "--project-id", fx.projectId, "--type", "not-a-type", "--title", "Bad",
    "--work-ids", fx.workId, "--desired-outcome", "fail closed", "--participant-ids", "-"]);
  assert.equal(badType.ok, false);
  assert.equal(badType.reasonCode, "CONFERENCE_SCHEMA_INVALID");

  const badGate = await invokeCli(["gate-create", "--workspace", ws, "--expected-version", "3", "--at", instant(6),
    "--external-key", "GATE-BAD", "--project-id", fx.projectId, "--work-id", fx.workId, "--title", "Bad gate",
    "--outcome-class", "not-a-class"]);
  assert.equal(badGate.ok, false);
  assert.equal(badGate.reasonCode, "GATE_SCHEMA_INVALID");

  // Lease contention: hold the lease out of band, then a mutating verb cannot acquire it.
  const held = await acquireWorkspaceLease(ws, { now: instant(7) });
  context.after(() => held.release().catch(() => undefined));
  const contended = await invokeCli(["gate-create", "--workspace", ws, "--expected-version", "3", "--at", instant(8),
    "--external-key", "GATE-LOCKED", "--project-id", fx.projectId, "--work-id", fx.workId, "--title", "Locked",
    "--outcome-class", "role_decision"]);
  assert.equal(contended.ok, false);
  assert.equal(contended.reasonCode, "WORKSPACE_LOCKED");
});

test("WSD-3: conference-close --distill governs each decision into a promotable knowledge candidate under one lease", async (context) => {
  const fx = await cliSeededFixture(context);
  const ws = fx.ws;

  const conferenceId = JSON.parse((await invokeCli(["conference-open", "--workspace", ws, "--expected-version", "2", "--at", instant(3),
    "--external-key", "CONF-DISTILL", "--project-id", fx.projectId, "--type", "architecture", "--title", "Distill design",
    "--work-ids", fx.workId, "--desired-outcome", "pick route", "--participant-ids", "profile:architect-01"])).output).recordId;
  // A position contributes an evidence:-prefixed id to the distilled provenance union.
  await invokeCli(["conference-append-position", "--workspace", ws, "--expected-version", "3", "--at", instant(4),
    "--conference-id", conferenceId, "--external-key", "POSITION-DISTILL-1", "--actor-id", "profile:architect-01",
    "--position", "persist via log", "--risks", "drift", "--recommendations", "doc", "--evidence-ids", "evidence:position-01"]);

  // The disposable knowledge store must exist before the close (non-fixture workspace
  // -> explicit disposability acknowledgment).
  const init = assertCanonicalJson((await invokeCli(["knowledge-init", "--workspace", ws, "--acknowledge-disposable", "true"])).output);
  assert.equal(init.reasonCode, "KNOWLEDGE_STORE_INITIALIZED");

  const decisions = ["adopt cross-host parity fixture", "keep host surface enumerated"];
  const closeReceipt = assertCanonicalJson((await invokeCli(["conference-close", "--workspace", ws, "--expected-version", "head",
    "--at", instant(5), "--conference-id", conferenceId, "--minutes-external-key", "MINUTES-DISTILL",
    "--summary", "event-log persistence ratified", "--outcome-class", "role_decision",
    "--decisions", decisions.join(","), "--unresolved-issues", "-",
    "--distill", "true", "--accountable-owner-id", "owner:governance", "--stale-days", "90", "--evidence-ids", "evidence:close-01"])).output);
  // The close event still advances the workspace version by exactly one, and the
  // receipt names one created knowledge unit per decision.
  assert.equal(closeReceipt.version, 5);
  assert.equal(closeReceipt.recordId, deriveStableId("minutes", "MINUTES-DISTILL"));
  assert.equal(closeReceipt.knowledgeUnitIds.length, decisions.length);

  // Each candidate validates through the store, is unpromoted, carries the fixed
  // conference tag set, the deduped evidence union, and a sourceDigest bound to the
  // FULL untruncated basis (recomputed here).
  const minutesId = deriveStableId("minutes", "MINUTES-DISTILL");
  const expectedDigests = decisions.map((decision) => canonicalSha256({ title: "Distill design", decision, minutesId }));
  const listing = assertCanonicalJson((await invokeCli(["knowledge-list", "--workspace", ws, "--at", instant(6), "--selection", "all"])).output);
  assert.equal(listing.total, decisions.length);
  for (const record of listing.records) {
    assert.equal(record.promotionState, "candidate");
    assert.deepEqual(record.tags, ["conference-decision", "distilled", "type-architecture"]);
    assert.deepEqual(record.linkedEvidenceIds, ["evidence:close-01", "evidence:position-01"]);
    assert.equal(Buffer.byteLength(record.subject, "utf8") <= 512, true);
    assert.equal(expectedDigests.includes(record.sourceDigest), true);
  }

  // Promotable by construction: owner + evidence + tag + snippet clear the WSC-6 gates.
  const first = listing.records[0];
  const knowledgeVersion = assertCanonicalJson((await invokeCli(["knowledge-validate", "--workspace", ws])).output).version;
  const promote = await invokeCli(["knowledge-promote", "--workspace", ws, "--expected-version", String(knowledgeVersion),
    "--expected-revision", String(first.revision), "--at", instant(7), "--id", first.id, "--state", "promoted"]);
  assert.equal(promote.ok, true);
  assert.equal(assertCanonicalJson(promote.output).promotionState, "promoted");
});

test("WSD-3: --distill with no knowledge store fails closed BEFORE the close event is appended", async (context) => {
  const fx = await cliSeededFixture(context);
  const ws = fx.ws;
  const conferenceId = JSON.parse((await invokeCli(["conference-open", "--workspace", ws, "--expected-version", "2", "--at", instant(3),
    "--external-key", "CONF-NOSTORE", "--project-id", fx.projectId, "--type", "architecture", "--title", "No store",
    "--work-ids", fx.workId, "--desired-outcome", "pick route", "--participant-ids", "-"])).output).recordId;
  // No knowledge-init: the pre-close store read fails and no close event lands.
  const close = await invokeCli(["conference-close", "--workspace", ws, "--expected-version", "3", "--at", instant(4),
    "--conference-id", conferenceId, "--minutes-external-key", "MINUTES-NOSTORE", "--summary", "should not persist",
    "--outcome-class", "role_decision", "--decisions", "unreachable", "--unresolved-issues", "-", "--distill", "true", "--stale-days", "30"]);
  assert.equal(close.ok, false);
  // Version is unchanged (open was version 3) — the conference is still open, provable
  // by closing it again WITHOUT distillation.
  assert.equal((await materializeWorkspace(ws)).version, 3);
  const reclose = assertCanonicalJson((await invokeCli(["conference-close", "--workspace", ws, "--expected-version", "3", "--at", instant(5),
    "--conference-id", conferenceId, "--minutes-external-key", "MINUTES-NOSTORE", "--summary", "plain close",
    "--outcome-class", "role_decision", "--decisions", "adopt", "--unresolved-issues", "-"])).output);
  assert.equal(reclose.version, 4);
  assert.equal(reclose.knowledgeUnitIds, undefined);
});

// WSD-4: a work item at active, the surface a pending gate governs on its way to done.
async function activeGatedFixture(context) {
  const fx = await seededFixture(context);
  await transitionWork(fx.workspace, fx.lease, { expectedVersion: 2, occurredAt: instant(3), id: fx.workId, status: "ready" });
  const state = await transitionWork(fx.workspace, fx.lease, { expectedVersion: 3, occurredAt: instant(4), id: fx.workId, status: "active" });
  return { ...fx, state };
}

test("WSD-4: a pending gate fails a work transition to done closed at the verb and appends no event", async (context) => {
  const fx = await activeGatedFixture(context);
  const seeded = await createGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 4, occurredAt: instant(5), externalKey: "GATE-BLOCK", projectId: fx.projectId, workId: fx.workId,
    title: "Decision gate", outcomeClass: "role_decision",
  });
  const version = seeded.version;
  await expectReasonAsync("WORKSPACE_GATE_PENDING", () => transitionWork(fx.workspace, fx.lease, {
    expectedVersion: version, occurredAt: instant(6), id: fx.workId, status: "done",
  }));
  assert.equal((await materializeWorkspace(fx.workspace)).version, version, "the blocked transition appended no event");
});

test("WSD-4: minutes-backed satisfaction unblocks the transition to done and the whole chain replays deterministically", async (context) => {
  const fx = await activeGatedFixture(context);
  let state = await openConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 4, occurredAt: instant(5), externalKey: "CONF-SAT", projectId: fx.projectId, type: "architecture",
    title: "Decide", linkedWorkIds: [fx.workId], desiredOutcome: "decide the gate", participantIds: [],
  });
  const conferenceId = state.conferences[0].id;
  state = await closeConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 5, occurredAt: instant(6), conferenceId, minutesExternalKey: "MINUTES-SAT",
    summary: "ratified", outcomeClass: "role_decision", decisions: ["proceed"], unresolvedIssues: [],
  });
  state = await createGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 6, occurredAt: instant(7), externalKey: "GATE-SAT", projectId: fx.projectId, workId: fx.workId,
    title: "Decision gate", outcomeClass: "role_decision",
  });
  const gateId = state.gates[0].id;
  // Still pending: the transition to done is blocked.
  await expectReasonAsync("WORKSPACE_GATE_PENDING", () => transitionWork(fx.workspace, fx.lease, {
    expectedVersion: 7, occurredAt: instant(8), id: fx.workId, status: "done",
  }));
  state = await transitionGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 7, occurredAt: instant(8), id: gateId, status: "satisfied", minutesLocator: minutesLocator("MINUTES-SAT"),
  });
  state = await transitionWork(fx.workspace, fx.lease, {
    expectedVersion: 8, occurredAt: instant(9), id: fx.workId, status: "done",
  });
  assert.equal(state.work.find((entry) => entry.id === fx.workId).status, "done");
  const fresh = await materializeWorkspace(fx.workspace);
  assert.deepEqual(fresh, state, "the committed delta equals a full replay");
  assert.deepEqual(await materializeWorkspace(fx.workspace), fresh, "replay is deterministic");
});

test("WSD-4: the gate.deleted tombstone is the deadlock escape that lets a wedged work item reach done", async (context) => {
  const fx = await activeGatedFixture(context);
  let state = await createGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 4, occurredAt: instant(5), externalKey: "GATE-DEL", projectId: fx.projectId, workId: fx.workId,
    title: "Decision gate", outcomeClass: "role_decision",
  });
  const gateId = state.gates[0].id;
  state = await deleteGateInWorkspace(fx.workspace, fx.lease, { expectedVersion: 5, occurredAt: instant(6), id: gateId });
  state = await transitionWork(fx.workspace, fx.lease, { expectedVersion: 6, occurredAt: instant(7), id: fx.workId, status: "done" });
  assert.equal(state.work.find((entry) => entry.id === fx.workId).status, "done");
});

test("WSD-4: the designated set is exactly done — a pending gate leaves other targets unaffected", async (context) => {
  for (const target of ["blocked", "cancelled"]) {
    await context.test(`active to ${target}`, async (caseContext) => {
      const fx = await activeGatedFixture(caseContext);
      await createGateInWorkspace(fx.workspace, fx.lease, {
        expectedVersion: 4, occurredAt: instant(5), externalKey: `GATE-${target}`, projectId: fx.projectId, workId: fx.workId,
        title: "Decision gate", outcomeClass: "role_decision",
      });
      const state = await transitionWork(fx.workspace, fx.lease, { expectedVersion: 5, occurredAt: instant(6), id: fx.workId, status: target });
      assert.equal(state.work.find((entry) => entry.id === fx.workId).status, target);
    });
  }
  await context.test("planned to ready", async (caseContext) => {
    const fx = await seededFixture(caseContext);
    await createGateInWorkspace(fx.workspace, fx.lease, {
      expectedVersion: 2, occurredAt: instant(3), externalKey: "GATE-READY", projectId: fx.projectId, workId: fx.workId,
      title: "Decision gate", outcomeClass: "role_decision",
    });
    const state = await transitionWork(fx.workspace, fx.lease, { expectedVersion: 3, occurredAt: instant(4), id: fx.workId, status: "ready" });
    assert.equal(state.work.find((entry) => entry.id === fx.workId).status, "ready");
  });
});

test("WSD-4: satisfaction fails closed when the locator resolves to no or non-anchoring minutes, appending no event", async (context) => {
  const fx = await seededFixture(context);
  // A second work item plus a conference anchored only to it, closed with minutes.
  let state = await createWork(fx.workspace, fx.lease, {
    expectedVersion: 2, occurredAt: instant(3), projectId: fx.projectId, externalKey: "INITIATIVE-OTHER", kind: "Initiative", parentId: null,
  });
  const otherWorkId = state.work.find((entry) => entry.id !== fx.workId).id;
  state = await openConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 3, occurredAt: instant(4), externalKey: "CONF-OTHER", projectId: fx.projectId, type: "architecture",
    title: "Other", linkedWorkIds: [otherWorkId], desiredOutcome: "decide elsewhere", participantIds: [],
  });
  const conferenceId = state.conferences[0].id;
  state = await closeConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 4, occurredAt: instant(5), conferenceId, minutesExternalKey: "MINUTES-OTHER",
    summary: "closed", outcomeClass: "role_decision", decisions: ["done"], unresolvedIssues: [],
  });
  // The gate anchors the FIRST work item, which those minutes do not cover.
  state = await createGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 5, occurredAt: instant(6), externalKey: "GATE-EV", projectId: fx.projectId, workId: fx.workId,
    title: "Decision gate", outcomeClass: "role_decision",
  });
  const gateId = state.gates[0].id;
  const version = state.version;
  const unresolvable = [
    minutesLocator("MINUTES-NONE"),              // no stored minutes share this suffix
    minutesLocator("MINUTES-OTHER"),             // stored, but the conference anchors the other work item
    "minutes:000000000000000000000000",          // wrong locator namespace
    "conference-minutes:BAD SUFFIX",              // not a protocol id
  ];
  for (const locator of unresolvable) {
    await expectReasonAsync("WORKSPACE_GATE_EVIDENCE_UNRESOLVED", () => transitionGateInWorkspace(fx.workspace, fx.lease, {
      expectedVersion: version, occurredAt: instant(7), id: gateId, status: "satisfied", minutesLocator: locator,
    }));
  }
  // An absent locator fails closed too.
  await expectReasonAsync("WORKSPACE_GATE_EVIDENCE_UNRESOLVED", () => transitionGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: version, occurredAt: instant(7), id: gateId, status: "satisfied",
  }));
  assert.equal((await materializeWorkspace(fx.workspace)).version, version, "no failed satisfaction appended an event");
});

test("WSD-4: the gate lifecycle graph is enforced at the verb — satisfied is terminal and a locator is rejected off the satisfied path", async (context) => {
  const fx = await seededFixture(context);
  let state = await openConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 2, occurredAt: instant(3), externalKey: "CONF-GRAPH", projectId: fx.projectId, type: "architecture",
    title: "Graph", linkedWorkIds: [fx.workId], desiredOutcome: "decide", participantIds: [],
  });
  const conferenceId = state.conferences[0].id;
  state = await closeConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 3, occurredAt: instant(4), conferenceId, minutesExternalKey: "MINUTES-GRAPH",
    summary: "closed", outcomeClass: "role_decision", decisions: ["go"], unresolvedIssues: [],
  });
  state = await createGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 4, occurredAt: instant(5), externalKey: "GATE-GRAPH", projectId: fx.projectId, workId: fx.workId,
    title: "Decision gate", outcomeClass: "role_decision",
  });
  const gateId = state.gates[0].id;
  // A minutes locator on a non-satisfied transition is rejected.
  await expectReasonAsync("WORKSPACE_INPUT_INVALID", () => transitionGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 5, occurredAt: instant(6), id: gateId, status: "blocked", minutesLocator: minutesLocator("MINUTES-GRAPH"),
  }));
  state = await transitionGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 5, occurredAt: instant(6), id: gateId, status: "satisfied", minutesLocator: minutesLocator("MINUTES-GRAPH"),
  });
  // satisfied is terminal: no further status move is admissible.
  const version = state.version;
  await expectReasonAsync("WORKSPACE_INPUT_INVALID", () => transitionGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: version, occurredAt: instant(7), id: gateId, status: "blocked",
  }));
  assert.equal((await materializeWorkspace(fx.workspace)).version, version, "the off-graph transition appended no event");
});

test("gate-v1: an owner_intent_required gate cannot be satisfied without a roster that names the actor", async (context) => {
  // The class is the opt-in. A gate created as owner_intent_required declares that
  // closing it takes owner intent, and until gate-v1 that declaration was inert. What
  // these cases pin is that it now costs something to close one, and that the cost is
  // paid in the right currency: a roster read from disk under a stated digest, plus a
  // named actor the roster actually permits.
  const fx = await seededFixture(context);
  const roster = {
    schemaVersion: "tcrn.gate-identity-authority.v1",
    permits: [{ actorId: "owner:governance", outcomeClasses: ["owner_intent_required"] }],
  };
  const rosterPath = join(fx.base, "gate-identity-authority.json");
  const rosterBytes = canonicalJson(roster);
  await writeFile(rosterPath, rosterBytes, { encoding: "utf8", mode: 0o600 });
  const admitted = await readGateIdentityAuthority(rosterPath, {
    expectedCanonicalPath: rosterPath,
    expectedFileSha256: canonicalSha256(roster),
  });

  let state = await openConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 2, occurredAt: instant(3), externalKey: "CONF-OWNER", projectId: fx.projectId, type: "architecture",
    title: "Owner ruling", linkedWorkIds: [fx.workId], desiredOutcome: "rule", participantIds: [],
  });
  const conferenceId = state.conferences[0].id;
  state = await closeConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 3, occurredAt: instant(4), conferenceId, minutesExternalKey: "MINUTES-OWNER",
    summary: "Ruled.", outcomeClass: "owner_intent_required", decisions: ["ruled"], unresolvedIssues: [],
  });
  state = await createGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 4, occurredAt: instant(5), externalKey: "GATE-OWNER", projectId: fx.projectId, workId: fx.workId,
    title: "Owner gate", outcomeClass: "owner_intent_required",
  });
  const gateId = state.gates[0].id;
  const satisfy = (extra) => transitionGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 5, occurredAt: instant(6), id: gateId, status: "satisfied",
    minutesLocator: minutesLocator("MINUTES-OWNER"), ...extra,
  });
  const refused = async (code, extra) => {
    await assert.rejects(satisfy(extra), (error) => {
      assert.equal(error?.reasonCode, code, `expected ${code}, got ${error?.reasonCode}`);
      return true;
    }, code);
    // A refused transition must not have advanced the chain -- otherwise the gate is
    // closed to the reader and merely undocumented.
    assert.equal((await materializeWorkspace(fx.workspace)).version, 5, `${code} appended an event`);
  };

  // Evidence alone used to be enough. It is not any more.
  await refused("WORKSPACE_GATE_IDENTITY_REQUIRED", {});
  // A roster without a named actor cannot answer "who", so it is not an answer.
  await refused("WORKSPACE_GATE_IDENTITY_REQUIRED", { identityAuthority: admitted });
  // A named actor with no roster is a claim, which is what gate-v1 exists to stop.
  await refused("WORKSPACE_GATE_IDENTITY_REQUIRED", { actorId: "owner:governance" });
  // An actor the roster does not name is refused by name, not ignored.
  await refused("WORKSPACE_GATE_IDENTITY_REFUSED", { identityAuthority: admitted, actorId: "agent:opus" });

  state = await satisfy({ identityAuthority: admitted, actorId: "owner:governance" });
  assert.equal(state.gates[0].status, "satisfied");
  assert.equal(state.version, 6);
});

test("gate-v1: a supplied roster is honoured for every class, and no class but owner_intent_required demands one", async (context) => {
  // Two halves of the same rule. Asking for the check and having it skipped would be
  // the worst outcome, so a roster supplied against a role_decision gate still binds;
  // and a deployment that wants none of this keeps working by choosing another class.
  const fx = await seededFixture(context);
  const roster = {
    schemaVersion: "tcrn.gate-identity-authority.v1",
    permits: [{ actorId: "owner:governance", outcomeClasses: ["owner_intent_required"] }],
  };
  const rosterPath = join(fx.base, "roster.json");
  const rosterBytes = canonicalJson(roster);
  await writeFile(rosterPath, rosterBytes, { encoding: "utf8", mode: 0o600 });
  const admitted = await readGateIdentityAuthority(rosterPath, {
    expectedCanonicalPath: rosterPath,
    expectedFileSha256: canonicalSha256(roster),
  });

  let state = await openConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 2, occurredAt: instant(3), externalKey: "CONF-ROLE", projectId: fx.projectId, type: "risk",
    title: "Role call", linkedWorkIds: [fx.workId], desiredOutcome: "decide", participantIds: [],
  });
  const conferenceId = state.conferences[0].id;
  state = await closeConferenceInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 3, occurredAt: instant(4), conferenceId, minutesExternalKey: "MINUTES-ROLE",
    summary: "Decided.", outcomeClass: "role_decision", decisions: ["decided"], unresolvedIssues: [],
  });
  state = await createGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 4, occurredAt: instant(5), externalKey: "GATE-ROLE", projectId: fx.projectId, workId: fx.workId,
    title: "Role gate", outcomeClass: "role_decision",
  });
  const gateId = state.gates[0].id;

  // Supplied against a class the roster does not grant: still refused.
  await assert.rejects(transitionGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 5, occurredAt: instant(6), id: gateId, status: "satisfied",
    minutesLocator: minutesLocator("MINUTES-ROLE"), identityAuthority: admitted, actorId: "owner:governance",
  }), (error) => error?.reasonCode === "WORKSPACE_GATE_IDENTITY_REFUSED");

  // Supplied without an actor, on a class that does not itself demand one. The
  // roster still cannot answer "who", and answering anyway would be the skip.
  await assert.rejects(transitionGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 5, occurredAt: instant(6), id: gateId, status: "satisfied",
    minutesLocator: minutesLocator("MINUTES-ROLE"), identityAuthority: admitted,
  }), (error) => error?.reasonCode === "WORKSPACE_GATE_IDENTITY_REQUIRED");
  assert.equal((await materializeWorkspace(fx.workspace)).version, 5, "the refusal appended no event");

  // Not supplied against a non-owner class: unchanged from before gate-v1.
  state = await transitionGateInWorkspace(fx.workspace, fx.lease, {
    expectedVersion: 5, occurredAt: instant(6), id: gateId, status: "satisfied",
    minutesLocator: minutesLocator("MINUTES-ROLE"),
  });
  assert.equal(state.gates[0].status, "satisfied");
});
