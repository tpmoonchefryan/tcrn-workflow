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
