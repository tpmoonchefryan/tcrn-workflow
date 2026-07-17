// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  ACTOR_ATTESTATION_ENABLE_OPERATION,
  ACTOR_ATTESTATION_REGISTRATION_ID,
  ACTOR_ATTESTATION_SCHEMA_VERSION,
  ACTOR_PREFIXES,
  EVENT_PAYLOAD_OPERATION_EXTRAS,
  acquireWorkspaceLease,
  assertActorId,
  buildActorAttestationEnableRecord,
  buildActorAttestationRegistration,
  buildEventPayload,
  createProject,
  createWork,
  enableActorAttestation,
  exportWorkspace,
  initializeWorkspace,
  materializeWorkspace,
  validateActorAttestationEnableRecord,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, createEvent, validateExtensionRegistration } from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

async function workspaceFixture(segmentEventLimit = 64) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-actor-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: "WORKSPACE-ACTOR", createdAt: instant(0), segmentEventLimit });
  return {
    workspace: join(base, "workspace"),
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function reasonAsync(code, operation) {
  await assert.rejects(operation, (error) => error?.reasonCode === code, code);
}

// WSE-2: re-hash the last event of the single control segment with a new payload,
// keeping id/streamId/sequence/occurredAt/priorHash so the hash chain stays
// internally valid — this is a hand-crafted log the live path would never write,
// proving the replay reducer enforces attestation independently of the writer.
async function rehashLastEvent(workspace, buildPayload) {
  const segment = join(workspace, ".tcrn-workflow", "events", "000001.json");
  const events = JSON.parse(await readFile(segment, "utf8"));
  const last = events.at(-1);
  events[events.length - 1] = createEvent({
    id: last.id,
    streamId: last.streamId,
    sequence: last.sequence,
    occurredAt: last.occurredAt,
    priorHash: last.priorHash,
    payload: buildPayload(last.payload),
  });
  await writeFile(segment, canonicalJson(events));
}

function reason(code, operation) {
  assert.throws(operation, (error) => error?.reasonCode === code, code);
}

test("assertActorId accepts the allowlisted prefixes and fails closed otherwise", () => {
  for (const prefix of ACTOR_PREFIXES) {
    assert.doesNotThrow(() => assertActorId(`${prefix}:alpha-01`));
  }
  for (const bad of ["role:x", "owner:", "Owner:x", "OWNER:X", "owneralpha", "x", ":x", 42, null, undefined]) {
    reason("ACTOR_ID_INVALID", () => assertActorId(bad));
  }
});

test("buildEventPayload carries a validated actor only when supplied", () => {
  assert.deepEqual(buildEventPayload("work.created", { id: "x" }), { operation: "work.created", record: { id: "x" } });
  assert.deepEqual(buildEventPayload("work.created", { id: "x" }, "owner:alpha"), { operation: "work.created", record: { id: "x" }, actor: "owner:alpha" });
  reason("ACTOR_ID_INVALID", () => buildEventPayload("work.created", { id: "x" }, "role:alpha"));
});

// WSD-1 (SDC-2): the registered per-operation extras table — never ad-hoc
// payload shapes. conference.closed must carry exactly the minutes extra; no
// other operation may carry one; reserved keys stay unforgeable.
test("buildEventPayload admits exactly the registered per-operation extras", () => {
  assert.deepEqual(EVENT_PAYLOAD_OPERATION_EXTRAS, { "conference.closed": ["minutes"] });
  assert.deepEqual(
    buildEventPayload("conference.closed", { id: "x" }, undefined, { minutes: { id: "m" } }),
    { operation: "conference.closed", record: { id: "x" }, minutes: { id: "m" } },
  );
  assert.deepEqual(
    buildEventPayload("conference.closed", { id: "x" }, "owner:alpha", { minutes: { id: "m" } }),
    { operation: "conference.closed", record: { id: "x" }, minutes: { id: "m" }, actor: "owner:alpha" },
  );
  reason("EVENT_PAYLOAD_EXTRA_INVALID", () => buildEventPayload("conference.closed", { id: "x" }));
  reason("EVENT_PAYLOAD_EXTRA_INVALID", () => buildEventPayload("conference.closed", { id: "x" }, undefined, {}));
  reason("EVENT_PAYLOAD_EXTRA_INVALID", () => buildEventPayload("conference.closed", { id: "x" }, undefined, { minutes: { id: "m" }, extra: true }));
  reason("EVENT_PAYLOAD_EXTRA_INVALID", () => buildEventPayload("work.created", { id: "x" }, undefined, { minutes: { id: "m" } }));
  reason("EVENT_PAYLOAD_EXTRA_INVALID", () => buildEventPayload("conference.created", { id: "x" }, undefined, { actor: "owner:alpha" }));
});

test("the enable record round-trips and validates fail-closed", () => {
  const record = buildActorAttestationEnableRecord();
  assert.deepEqual(record, { schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION, version: 1 });
  assert.doesNotThrow(() => validateActorAttestationEnableRecord(record));
  for (const bad of [{}, { schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION }, { schemaVersion: "x", version: 1 }, { schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION, version: 2 }, { schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION, version: 1, extra: true }, null, []]) {
    reason("ACTOR_ATTESTATION_INVALID", () => validateActorAttestationEnableRecord(bad));
  }
  assert.equal(ACTOR_ATTESTATION_ENABLE_OPERATION, "attestation.actor.enabled");
});

test("the extension registration is event-scoped, off by default, and schema-digest bound", async () => {
  const schemaBytes = await readFile(new URL("../schemas/actor-attestation-v1.schema.json", import.meta.url));
  const schemaDigest = createHash("sha256").update(schemaBytes).digest("hex");
  const registration = buildActorAttestationRegistration(schemaDigest);
  assert.equal(registration.id, ACTOR_ATTESTATION_REGISTRATION_ID);
  assert.deepEqual(registration.appliesTo, ["event"]);
  assert.equal(registration.requiredByDefault, false);
  assert.doesNotThrow(() => validateExtensionRegistration(registration));

  const registrationSchema = JSON.parse(await readFile(new URL("../schemas/extension-registration-v1.schema.json", import.meta.url), "utf8"));
  const protocolSchema = JSON.parse(await readFile(new URL("../schemas/protocol-common-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addKeyword({ keyword: "x-tcrn-aos-requirementIds", schemaType: "array" });
  ajv.addSchema(protocolSchema);
  assert.equal(ajv.compile(registrationSchema)(registration), true);
});

test("the actor-attestation schema validates the enable record and actor strings", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/actor-attestation-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addKeyword({ keyword: "x-tcrn-aos-requirementIds", schemaType: "array" });
  const validateEnable = ajv.compile(schema);
  assert.equal(validateEnable({ schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION, version: 1 }), true);
  assert.equal(validateEnable({ schemaVersion: "x", version: 1 }), false);
  assert.equal(validateEnable({ schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION, version: 1, extra: true }), false);

  const validateActor = ajv.compile(schema.$defs.actorId);
  for (const prefix of ACTOR_PREFIXES) {
    assert.equal(validateActor(`${prefix}:alpha-01`), true);
  }
  for (const bad of ["role:x", "OWNER:X", "owner:"]) {
    assert.equal(validateActor(bad), false);
  }
});

// ---------------------------------------------------------------------------
// WSE-2: engine enforcement of the enable-boundary. These cases drive the real
// file engine (enable event plus mutations) and hand-crafted replay logs the
// live path would never write, proving the mandatory-actor rule is enforced
// identically on write and on replay, and that default behaviour is unchanged.
// ---------------------------------------------------------------------------

async function attestedChain(fixture) {
  const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
  try {
    const created = await createProject(fixture.workspace, lease, {
      expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-CHAIN", name: "Chain",
    });
    await enableActorAttestation(fixture.workspace, lease, {
      expectedVersion: 1, occurredAt: instant(2), actorId: "owner:release-gate",
    });
    await createWork(fixture.workspace, lease, {
      expectedVersion: 2, occurredAt: instant(3), projectId: created.projects[0].id, externalKey: "INIT-CHAIN", kind: "Initiative", parentId: null, actorId: "agent:builder-7",
    });
  } finally {
    await lease.release();
  }
}

test("WSE-2 default: no enable event keeps mutations actor-optional and export actor-free", async () => {
  const fixture = await workspaceFixture();
  try {
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
    let state;
    try {
      // An actor supplied before any enable event is a no-op: accepted, never
      // written, so the derived state and export bytes stay actor-free.
      state = await createProject(fixture.workspace, lease, {
        expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-DEFAULT", name: "Default", actorId: "owner:release-gate",
      });
    } finally {
      await lease.release();
    }
    assert.equal(state.attestationEnabledAtSequence, null);
    const exported = await exportWorkspace(fixture.workspace);
    assert.equal(exported.includes("\"actor\""), false);
    const replayed = await materializeWorkspace(fixture.workspace);
    assert.equal(replayed.attestationEnabledAtSequence, null);
    assert.equal(replayed.version, 1);
  } finally {
    await fixture.close();
  }
});

test("WSE-2 live: enabling attestation makes a valid actor mandatory on every later write", async () => {
  const fixture = await workspaceFixture();
  try {
    const lease = await acquireWorkspaceLease(fixture.workspace, { now: instant(1) });
    let created;
    try {
      created = await createProject(fixture.workspace, lease, {
        expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-A", name: "Alpha",
      });
      assert.equal(created.attestationEnabledAtSequence, null);

      const enabled = await enableActorAttestation(fixture.workspace, lease, {
        expectedVersion: 1, occurredAt: instant(3), actorId: "owner:release-gate",
      });
      assert.equal(enabled.attestationEnabledAtSequence, 2);

      // A missing actor fails closed and writes nothing (version and head unchanged).
      const before = await materializeWorkspace(fixture.workspace);
      await reasonAsync("WORKSPACE_ACTOR_REQUIRED", () => createWork(fixture.workspace, lease, {
        expectedVersion: 2, occurredAt: instant(4), projectId: created.projects[0].id, externalKey: "INIT-A", kind: "Initiative", parentId: null,
      }));
      const afterFail = await materializeWorkspace(fixture.workspace);
      assert.equal(afterFail.version, before.version);
      assert.equal(afterFail.headEventHash, before.headEventHash);

      // An unlisted prefix fails closed as an invalid actor.
      await reasonAsync("WORKSPACE_ACTOR_INVALID", () => createWork(fixture.workspace, lease, {
        expectedVersion: 2, occurredAt: instant(4), projectId: created.projects[0].id, externalKey: "INIT-A", kind: "Initiative", parentId: null, actorId: "role:nope",
      }));

      // A valid actor succeeds.
      const worked = await createWork(fixture.workspace, lease, {
        expectedVersion: 2, occurredAt: instant(4), projectId: created.projects[0].id, externalKey: "INIT-A", kind: "Initiative", parentId: null, actorId: "agent:builder-7",
      });
      assert.equal(worked.version, 3);
      assert.equal(worked.attestationEnabledAtSequence, 2);

      // Re-enabling an already-attested workspace fails closed.
      await reasonAsync("WORKSPACE_INPUT_INVALID", () => enableActorAttestation(fixture.workspace, lease, {
        expectedVersion: 3, occurredAt: instant(5), actorId: "owner:release-gate",
      }));
    } finally {
      await lease.release();
    }
    const exported = JSON.parse(await exportWorkspace(fixture.workspace));
    assert.equal("actor" in exported.events[0].payload, false);
    assert.equal(exported.events[1].payload.operation, ACTOR_ATTESTATION_ENABLE_OPERATION);
    assert.equal(exported.events[1].payload.actor, "owner:release-gate");
    assert.equal(exported.events[2].payload.actor, "agent:builder-7");
  } finally {
    await fixture.close();
  }
});

test("WSE-2 replay: a hand-crafted post-enable event with no valid actor fails closed", async () => {
  const missing = await workspaceFixture();
  try {
    await attestedChain(missing);
    await rehashLastEvent(missing.workspace, (payload) => {
      const copy = { ...payload };
      delete copy.actor;
      return copy;
    });
    await reasonAsync("WORKSPACE_ACTOR_REQUIRED", () => materializeWorkspace(missing.workspace));
  } finally {
    await missing.close();
  }

  const invalid = await workspaceFixture();
  try {
    await attestedChain(invalid);
    await rehashLastEvent(invalid.workspace, (payload) => ({ ...payload, actor: "role:forged" }));
    await reasonAsync("WORKSPACE_ACTOR_INVALID", () => materializeWorkspace(invalid.workspace));
  } finally {
    await invalid.close();
  }
});

test("WSE-2 replay: a duplicate enable event and a pre-enable actor both corrupt the chain", async () => {
  const dup = await workspaceFixture();
  try {
    await attestedChain(dup);
    await rehashLastEvent(dup.workspace, () => ({
      operation: ACTOR_ATTESTATION_ENABLE_OPERATION,
      record: buildActorAttestationEnableRecord(),
      actor: "owner:release-gate",
    }));
    await reasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(dup.workspace));
  } finally {
    await dup.close();
  }

  const early = await workspaceFixture();
  try {
    const lease = await acquireWorkspaceLease(early.workspace, { now: instant(1) });
    try {
      await createProject(early.workspace, lease, {
        expectedVersion: 0, occurredAt: instant(1), externalKey: "PROJECT-EARLY", name: "Early",
      });
    } finally {
      await lease.release();
    }
    // The live path never writes an actor before enablement; a hand-crafted
    // pre-enable event carrying one violates the exact {operation, record} shape
    // and the reducer fails it closed as a corrupt event.
    await rehashLastEvent(early.workspace, (payload) => ({ ...payload, actor: "owner:release-gate" }));
    await reasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(early.workspace));
  } finally {
    await early.close();
  }
});
