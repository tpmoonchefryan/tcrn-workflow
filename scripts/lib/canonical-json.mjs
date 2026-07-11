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

function canonicalValue(value) {
  if (typeof value === "string") {
    assertCanonicalString(value, "String value");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === "object") {
    const output = {};
    const keys = Object.keys(value);
    for (const key of keys) {
      assertCanonicalString(key, "Object key");
    }
    for (const key of keys.sort(compareCanonicalText)) {
      output[key] = canonicalValue(value[key]);
    }
    return output;
  }
  return value;
}

export function canonicalJson(value) {
  try {
    const serialized = JSON.stringify(canonicalValue(value));
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
