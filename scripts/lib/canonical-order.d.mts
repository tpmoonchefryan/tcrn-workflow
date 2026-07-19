// SPDX-License-Identifier: Apache-2.0

// Hand-written declarations for the plain-JavaScript module canonical-order.mjs.
// Each declaration mirrors the real runtime export one-for-one; nothing here is a
// placeholder or a silencing stub.

export declare class CanonicalOrderError extends Error {
  constructor(message: string);
  name: "CanonicalOrderError";
}

export declare function canonicalUtf8Bytes(value: unknown): Buffer;

export declare function compareCanonicalText(left: unknown, right: unknown): number;
