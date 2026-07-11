// SPDX-License-Identifier: Apache-2.0

export class CanonicalOrderError extends Error {
  constructor(message) {
    super(message);
    this.name = "CanonicalOrderError";
  }
}

export function canonicalUtf8Bytes(value) {
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new CanonicalOrderError("Canonical text must be a well-formed Unicode scalar string");
  }
  return Buffer.from(value, "utf8");
}

export function compareCanonicalText(left, right) {
  return Buffer.compare(canonicalUtf8Bytes(left), canonicalUtf8Bytes(right));
}
