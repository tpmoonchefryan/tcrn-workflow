// SPDX-License-Identifier: Apache-2.0

// Gate identity authority (gate-v1, E02/STORY-008). Gates already bind evidence: a
// transition to satisfied must cite conference minutes anchored to the gate's work
// item. They do not bind identity -- any actor may execute that transition, and
// "owner intent required" survives only as an outcomeClass string plus whatever the
// cited minutes happen to say.
//
// This module supplies the missing half as a pins-track authority: an out-of-band
// document naming which actor ids may satisfy which outcome classes, read through the
// same TOCTOU-hardened file reader every other authority uses, and bound by a digest
// the caller already holds. The Owner ruling behind that choice is on the governance
// chain: a self-asserted context would let the wiring process name itself
// owner:governance, which is not an authority at all.
//
// Two boundaries this module cannot cross, stated here because the next reader will
// otherwise assume otherwise:
//
//   * It delivers AUTHORIZATION -- which identities are permitted -- not
//     AUTHENTICATION. Nothing here proves who ran the command.
//   * It is a decision-point control, not a chain-integrity invariant. Event hashes
//     are unkeyed, so anyone who can write the event log can append a self-consistent
//     event that replays clean; no non-cryptographic replay check can distinguish
//     that from a genuine one. Closing that gap is the external-anchor programme.

import {
  assertProtocolId,
  canonicalJson,
  compareCanonicalText,
} from "../../protocol/src/index.js";
import { GATE_OUTCOME_CLASSES } from "./assignment-gate.js";
import type { GateRecord } from "./assignment-gate.js";
import { readAuthorityFile } from "./authority-file-reader.js";
import type { AuthorityFileReasonCodes } from "./authority-file-reader.js";

export const GATE_IDENTITY_AUTHORITY_VERSION = "tcrn.gate-identity-authority.v1" as const;

export const GATE_IDENTITY_REASON_CODES = Object.freeze([
  "GATE_IDENTITY_AUTHORITY_REQUIRED",
  "GATE_IDENTITY_AUTHORITY_PATH",
  "GATE_IDENTITY_AUTHORITY_DIGEST",
  "GATE_IDENTITY_AUTHORITY_CHANGED",
  "GATE_IDENTITY_AUTHORITY_LINK",
  "GATE_IDENTITY_AUTHORITY_SPECIAL_FILE",
  "GATE_IDENTITY_AUTHORITY_MALFORMED",
  "GATE_IDENTITY_AUTHORITY_CANONICAL_INVALID",
  "GATE_IDENTITY_ADMISSION_REQUIRED",
  "GATE_IDENTITY_NOT_PERMITTED",
] as const);

export type GateIdentityReasonCode = typeof GATE_IDENTITY_REASON_CODES[number];

export class GateIdentityError extends Error {
  readonly reasonCode: GateIdentityReasonCode;
  constructor(reasonCode: GateIdentityReasonCode, message: string) {
    super(message);
    this.name = "GateIdentityError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: GateIdentityReasonCode, message: string): never {
  throw new GateIdentityError(reasonCode, message);
}

// Bounded so a hostile authority file cannot turn a permission lookup into a denial of
// service. The ceiling is generous against any real roster and small enough that the
// whole document is read and canonicalised in one pass.
export const GATE_IDENTITY_LIMITS = Object.freeze({
  documentBytes: 65_536,
  permits: 256,
});

export interface GateIdentityPermit {
  readonly actorId: string;
  readonly outcomeClasses: readonly GateRecord["outcomeClass"][];
}

export interface GateIdentityAuthorityDocument {
  readonly schemaVersion: typeof GATE_IDENTITY_AUTHORITY_VERSION;
  readonly permits: readonly GateIdentityPermit[];
}

export interface GateIdentityAuthorityFileIdentity {
  readonly expectedCanonicalPath: string;
  readonly expectedFileSha256: string;
}

export interface GateIdentityAuthorityContext {
  readonly document: GateIdentityAuthorityDocument;
  readonly sourcePath: string;
  readonly authorityFileSha256: string;
  readonly sourceIdentityDigest: string;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("GATE_IDENTITY_AUTHORITY_MALFORMED", label);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  if (actual.length !== wanted.length || wanted.some((field, index) => field !== actual[index])) {
    fail("GATE_IDENTITY_AUTHORITY_MALFORMED", label);
  }
}

// Canonical order is required rather than merely produced. Two documents that permit
// the same thing must be the same bytes, so an authority file cannot be reshuffled
// into a different digest while meaning the same, and a reader comparing digests
// across machines is comparing the same document.
function assertCanonicallySorted(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const order = compareCanonicalText(values[index - 1] as string, values[index] as string);
    if (order > 0) fail("GATE_IDENTITY_AUTHORITY_MALFORMED", `${label} order`);
    if (order === 0) fail("GATE_IDENTITY_AUTHORITY_MALFORMED", `${label} duplicate`);
  }
}

export function validateGateIdentityAuthorityDocument(value: unknown): GateIdentityAuthorityDocument {
  const document = record(value, "gate identity authority");
  exact(document, ["schemaVersion", "permits"], "gate identity authority");
  if (document.schemaVersion !== GATE_IDENTITY_AUTHORITY_VERSION) {
    fail("GATE_IDENTITY_AUTHORITY_MALFORMED", "schemaVersion");
  }
  if (!Array.isArray(document.permits)) fail("GATE_IDENTITY_AUTHORITY_MALFORMED", "permits");
  if (document.permits.length === 0) fail("GATE_IDENTITY_AUTHORITY_MALFORMED", "permits empty");
  if (document.permits.length > GATE_IDENTITY_LIMITS.permits) {
    fail("GATE_IDENTITY_AUTHORITY_MALFORMED", "permits count");
  }
  const permits = document.permits.map((entry, index) => {
    const permit = record(entry, `permits[${index}]`);
    exact(permit, ["actorId", "outcomeClasses"], `permits[${index}]`);
    try {
      assertProtocolId(permit.actorId);
    } catch {
      fail("GATE_IDENTITY_AUTHORITY_MALFORMED", `permits[${index}].actorId`);
    }
    if (!Array.isArray(permit.outcomeClasses)) {
      fail("GATE_IDENTITY_AUTHORITY_MALFORMED", `permits[${index}].outcomeClasses`);
    }
    if (permit.outcomeClasses.length === 0) {
      fail("GATE_IDENTITY_AUTHORITY_MALFORMED", `permits[${index}].outcomeClasses empty`);
    }
    for (const outcome of permit.outcomeClasses) {
      // Membership, not coercion: a value that merely stringifies to a member is not
      // one, the same guard the rest of the protocol applies to closed enums.
      if (typeof outcome !== "string" || !(GATE_OUTCOME_CLASSES as readonly string[]).includes(outcome)) {
        fail("GATE_IDENTITY_AUTHORITY_MALFORMED", `permits[${index}].outcomeClasses member`);
      }
    }
    assertCanonicallySorted(permit.outcomeClasses as readonly string[], `permits[${index}].outcomeClasses`);
    return Object.freeze({
      actorId: permit.actorId as string,
      outcomeClasses: Object.freeze([...(permit.outcomeClasses as readonly GateRecord["outcomeClass"][])]),
    });
  });
  assertCanonicallySorted(permits.map((permit) => permit.actorId), "permits");
  return Object.freeze({ schemaVersion: GATE_IDENTITY_AUTHORITY_VERSION, permits: Object.freeze(permits) });
}

const identityContexts = new WeakSet<object>();

const gateIdentityCodes: AuthorityFileReasonCodes<GateIdentityReasonCode> = Object.freeze({
  required: "GATE_IDENTITY_AUTHORITY_REQUIRED",
  path: "GATE_IDENTITY_AUTHORITY_PATH",
  digest: "GATE_IDENTITY_AUTHORITY_DIGEST",
  changed: "GATE_IDENTITY_AUTHORITY_CHANGED",
  link: "GATE_IDENTITY_AUTHORITY_LINK",
  specialFile: "GATE_IDENTITY_AUTHORITY_SPECIAL_FILE",
  limitExceeded: "GATE_IDENTITY_AUTHORITY_MALFORMED",
  notUtf8: "GATE_IDENTITY_AUTHORITY_MALFORMED",
  notJson: "GATE_IDENTITY_AUTHORITY_MALFORMED",
  notCanonical: "GATE_IDENTITY_AUTHORITY_CANONICAL_INVALID",
});

export async function readGateIdentityAuthority(
  path: string,
  authority?: GateIdentityAuthorityFileIdentity,
): Promise<GateIdentityAuthorityContext> {
  const source = await readAuthorityFile(path, authority, {
    maximumBytes: GATE_IDENTITY_LIMITS.documentBytes,
    codes: gateIdentityCodes,
    details: {
      required: "Out-of-band gate identity authority is required",
      expectedDigest: path,
    },
    fail,
    isOwnError: (error) => error instanceof GateIdentityError,
  });
  const context = Object.freeze({
    document: validateGateIdentityAuthorityDocument(source.parsed),
    sourcePath: path,
    authorityFileSha256: source.fileSha256,
    sourceIdentityDigest: source.sourceIdentityDigest,
  });
  identityContexts.add(context);
  return context;
}

// The brand is not the trust anchor -- the digest is. It exists so a caller cannot
// hand a permission check an object it assembled itself instead of one the reader
// produced, which would skip every filesystem and canonical-bytes check above.
function admitted(value: unknown): GateIdentityAuthorityContext {
  if (typeof value !== "object" || value === null || !identityContexts.has(value)) {
    fail("GATE_IDENTITY_ADMISSION_REQUIRED", "Descriptor-bound gate identity authority is required");
  }
  return value as GateIdentityAuthorityContext;
}

export function permitsGateOutcome(
  context: GateIdentityAuthorityContext,
  actorId: string,
  outcomeClass: GateRecord["outcomeClass"],
): boolean {
  const permit = admitted(context).document.permits.find((entry) => entry.actorId === actorId);
  return permit !== undefined && permit.outcomeClasses.includes(outcomeClass);
}

// Refusal is a named failure rather than a boolean at the call site, so the reason the
// transition stopped is the same string in the CLI, the engine, and the tests.
export function assertGateOutcomePermitted(
  context: GateIdentityAuthorityContext,
  actorId: string,
  outcomeClass: GateRecord["outcomeClass"],
): void {
  if (!permitsGateOutcome(context, actorId, outcomeClass)) {
    fail("GATE_IDENTITY_NOT_PERMITTED", `${actorId} may not satisfy ${outcomeClass}`);
  }
}

// The record a satisfied transition carries so an auditor can see which authority was
// in force. It is deliberately self-contained: replay checks its shape and never
// re-reads the file, because a chain whose readability depends on an external file
// still being present is a chain that bricks on ordinary key rotation or a restore
// onto a fresh machine.
export interface GateIdentityDecision {
  readonly actorId: string;
  readonly authorityFileSha256: string;
}

export function gateIdentityDecision(
  context: GateIdentityAuthorityContext,
  actorId: string,
): GateIdentityDecision {
  return Object.freeze({ actorId, authorityFileSha256: admitted(context).authorityFileSha256 });
}

export function validateGateIdentityDecision(value: unknown): GateIdentityDecision {
  const decision = record(value, "gate identity decision");
  exact(decision, ["actorId", "authorityFileSha256"], "gate identity decision");
  try {
    assertProtocolId(decision.actorId);
  } catch {
    fail("GATE_IDENTITY_AUTHORITY_MALFORMED", "decision actorId");
  }
  if (typeof decision.authorityFileSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(decision.authorityFileSha256)) {
    fail("GATE_IDENTITY_AUTHORITY_MALFORMED", "decision authorityFileSha256");
  }
  return Object.freeze({
    actorId: decision.actorId as string,
    authorityFileSha256: decision.authorityFileSha256,
  });
}

// Canonical bytes for the document a deployment publishes. Kept beside the validator so
// a roster written by hand and one written by tooling are the same file.
export function canonicalGateIdentityAuthority(document: GateIdentityAuthorityDocument): string {
  return canonicalJson(validateGateIdentityAuthorityDocument(document));
}
