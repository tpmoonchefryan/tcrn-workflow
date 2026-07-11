// SPDX-License-Identifier: Apache-2.0

import { compareCanonicalText } from "./canonical-order.mjs";

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort(compareCanonicalText)) {
      output[key] = canonicalValue(value[key]);
    }
    return output;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalJsonBytes(value) {
  return Buffer.from(canonicalJson(value), "utf8");
}
