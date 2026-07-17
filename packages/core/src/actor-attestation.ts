// SPDX-License-Identifier: Apache-2.0

// WSE-1: the actor-attestation contract (SDC-2). Shared constants and validators
// that workspace.ts and the WS-D event operations reuse so actor identity is
// carried and enforced through one payload constructor. This module defines the
// contract only; WSE-2/WSE-3 enforce it. No new dependencies.

import type { JsonValue } from "../../protocol/src/index.js";
import { assertProtocolId } from "../../protocol/src/index.js";

export const ACTOR_ATTESTATION_SCHEMA_VERSION = "tcrn.actor-attestation.v1" as const;
export const ACTOR_ATTESTATION_ENABLE_OPERATION = "attestation.actor.enabled" as const;
export const ACTOR_ATTESTATION_REGISTRATION_ID = "extension:actor-attestation-v1" as const;
export const ACTOR_PREFIXES = Object.freeze(["owner", "profile", "agent"] as const);

export const ACTOR_ATTESTATION_REASON_CODES = Object.freeze([
  "ACTOR_ATTESTATION_INVALID",
  "ACTOR_ID_INVALID",
  "EVENT_PAYLOAD_EXTRA_INVALID",
] as const);
export type ActorAttestationReasonCode = typeof ACTOR_ATTESTATION_REASON_CODES[number];

export class ActorAttestationError extends Error {
  readonly reasonCode: ActorAttestationReasonCode;
  constructor(reasonCode: ActorAttestationReasonCode, detail: string) {
    super(`${reasonCode}: ${detail}`);
    this.name = "ActorAttestationError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: ActorAttestationReasonCode, detail: string): never {
  throw new ActorAttestationError(reasonCode, detail);
}

// An actor id is a protocol stableId whose prefix is one of the allowlist
// {owner, profile, agent} (owner: reuses the knowledge-core accountable-owner
// convention). Any other prefix, uppercase, or non-stableId input fails closed.
export function assertActorId(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    fail("ACTOR_ID_INVALID", String(value));
  }
  const colon = value.indexOf(":");
  const prefix = colon === -1 ? "" : value.slice(0, colon);
  if (!ACTOR_PREFIXES.includes(prefix as typeof ACTOR_PREFIXES[number])) {
    fail("ACTOR_ID_INVALID", value);
  }
  try {
    assertProtocolId(value);
  } catch {
    fail("ACTOR_ID_INVALID", value);
  }
}

// WSD-1 (SDC-2): the registered per-operation extras table. An event payload may
// carry a top-level key beyond {operation, record, actor} ONLY when this table
// registers that key for the payload's operation, and a registered operation MUST
// carry exactly its registered extras — never an ad-hoc shape. conference.closed
// carries the closing minutes so a close is one atomic event.
export const EVENT_PAYLOAD_OPERATION_EXTRAS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "conference.closed": Object.freeze(["minutes"]),
});

const reservedPayloadKeys = new Set(["operation", "record", "actor"]);

// The single event-payload constructor WS-D operations must reuse: {operation,
// record} before attestation is enabled, {operation, record, actor} after, plus
// exactly the extras the table above registers for the operation. The actor,
// when present, is validated here so no operation can bypass it.
export function buildEventPayload(operation: string, record: JsonValue, actor?: string, extras?: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  const registered = EVENT_PAYLOAD_OPERATION_EXTRAS[operation] ?? [];
  const supplied = Object.keys(extras ?? {}).sort();
  if (JSON.stringify(supplied) !== JSON.stringify([...registered].sort())) {
    fail("EVENT_PAYLOAD_EXTRA_INVALID", `${operation} extras must be exactly [${registered.join(",")}]`);
  }
  const payload: Record<string, JsonValue> = { operation, record };
  for (const key of registered) {
    const value = extras?.[key];
    if (reservedPayloadKeys.has(key) || value === undefined) {
      fail("EVENT_PAYLOAD_EXTRA_INVALID", `${operation} extra ${key} is invalid`);
    }
    payload[key] = value;
  }
  if (actor === undefined) {
    return payload;
  }
  assertActorId(actor);
  payload.actor = actor;
  return payload;
}

// The enable event's record: {schemaVersion, version:1}. Appending it through the
// event log turns on mandatory actor attestation for every later event.
export function buildActorAttestationEnableRecord(): Readonly<Record<string, JsonValue>> {
  return { schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION, version: 1 };
}

export function validateActorAttestationEnableRecord(value: unknown): asserts value is Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("ACTOR_ATTESTATION_INVALID", "enable record must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "schemaVersion" || keys[1] !== "version" ||
    record.schemaVersion !== ACTOR_ATTESTATION_SCHEMA_VERSION || record.version !== 1) {
    fail("ACTOR_ATTESTATION_INVALID", "enable record shape");
  }
}

// The extension-registration-v1 record for this extension, event-scoped and
// off-by-default. schemaDigest is supplied by the caller (the sha256 of
// schemas/actor-attestation-v1.schema.json) so it never drifts from the file.
export function buildActorAttestationRegistration(schemaDigest: string): Readonly<Record<string, JsonValue>> {
  return {
    schemaVersion: "tcrn.extension-registration.v1",
    id: ACTOR_ATTESTATION_REGISTRATION_ID,
    version: 1,
    requiredByDefault: false,
    appliesTo: ["event"],
    schemaDigest,
  };
}
