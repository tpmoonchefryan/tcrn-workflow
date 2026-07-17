// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  ACTOR_ATTESTATION_ENABLE_OPERATION,
  ACTOR_ATTESTATION_REGISTRATION_ID,
  ACTOR_ATTESTATION_SCHEMA_VERSION,
  ACTOR_PREFIXES,
  EVENT_PAYLOAD_OPERATION_EXTRAS,
  assertActorId,
  buildActorAttestationEnableRecord,
  buildActorAttestationRegistration,
  buildEventPayload,
  validateActorAttestationEnableRecord,
} from "../dist/build/packages/core/src/index.js";
import { validateExtensionRegistration } from "../dist/build/packages/protocol/src/index.js";

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
