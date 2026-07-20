// SPDX-License-Identifier: Apache-2.0

import {
  CanonicalOrderError,
  canonicalUtf8Bytes,
  compareCanonicalText,
} from "./canonical-order.mjs";

export class CanonicalJsonError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "CanonicalJsonError";
    this.reasonCode = reasonCode;
  }
}

function assertCanonicalString(value, label) {
  try {
    canonicalUtf8Bytes(value);
  } catch (error) {
    if (error instanceof CanonicalOrderError) {
      throw new CanonicalJsonError("CANONICAL_VALUE_INVALID", `${label}: ${error.message}`);
    }
    throw error;
  }
}

function canonicalSerialize(value) {
  if (typeof value === "string") {
    assertCanonicalString(value, "String value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries = [];
    for (let index = 0; index < value.length; index += 1) {
      entries.push(canonicalSerialize(value[index]) ?? "null");
    }
    return `[${entries.join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    for (const key of keys) {
      assertCanonicalString(key, "Object key");
    }
    const entries = [];
    for (const key of keys.sort(compareCanonicalText)) {
      const serialized = canonicalSerialize(value[key]);
      if (serialized !== undefined) {
        entries.push(`${JSON.stringify(key)}:${serialized}`);
      }
    }
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalJson(value) {
  try {
    const serialized = canonicalSerialize(value);
    if (typeof serialized !== "string") {
      throw new CanonicalJsonError("CANONICAL_VALUE_INVALID", "Value is not canonical JSON");
    }
    return serialized;
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw error;
    }
    throw new CanonicalJsonError("CANONICAL_VALUE_INVALID", String(error));
  }
}

export function canonicalJsonBytes(value) {
  return Buffer.from(canonicalJson(value), "utf8");
}

// OD-16 F1. The product's canonical form ends in a newline: the protocol package's
// `canonicalJson` appends one inside the function, so the bytes it hands out are a
// document. This module's `canonicalJson` returns text without it, which is the right
// split -- a signature covers text, a file on disk is a document -- but it left the
// newline as something each caller had to remember. Three call sites spelled that one
// contract three ways: `canonicalProofBytes` appended it, `generateBasisDigest`
// concatenated a Buffer by hand, and `canonicalJsonBytes` deliberately omitted it.
// Two of those names differ by one trailing byte and by nothing else a reader can see,
// and picking the wrong one produces a wrong digest with no error anywhere.
//
// So the newline belongs to a name now, not to caller discipline. Callers that need the
// product's byte contract say `canonicalDocumentBytes`; callers that genuinely mean the
// unterminated text (release-trust's signature basis) keep saying `canonicalJsonBytes`,
// and that choice is now legible at the call site instead of implied by its absence.
export function canonicalDocumentBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}
