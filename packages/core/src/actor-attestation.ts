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

// The single event-payload constructor WS-D operations must reuse: {operation,
// record} before attestation is enabled, {operation, record, actor} after. The
// actor, when present, is validated here so no operation can bypass it.
export function buildEventPayload(operation: string, record: JsonValue, actor?: string): Readonly<Record<string, JsonValue>> {
  if (actor === undefined) {
    return { operation, record };
  }
  assertActorId(actor);
  return { operation, record, actor };
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
