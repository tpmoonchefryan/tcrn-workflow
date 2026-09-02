#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-263 — deterministic ceremony-cost measurement.
//
// The input is a checked-in measurement manifest rather than a threshold policy.
// It records the byte counts observed for one Initiative's scope and prework; this
// command only sums and reports those numbers.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const CEREMONY_COST_SCHEMA_VERSION = "tcrn.ceremony-cost.v1";

function fail(message) {
  const error = new Error(message);
  error.reasonCode = "CEREMONY_COST_MANIFEST_INVALID";
  throw error;
}

function byteEntries(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty list`);
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.name !== "string" || entry.name.length === 0
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      fail(`${label}[${index}] must carry a name and non-negative byte count`);
    }
    return { name: entry.name, bytes: entry.bytes };
  });
}

export function measureCeremonyCost(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)
    || manifest.schemaVersion !== CEREMONY_COST_SCHEMA_VERSION
    || typeof manifest.initiative !== "string" || manifest.initiative.length === 0
    || !Array.isArray(manifest.claimIds) || manifest.claimIds.length === 0
    || manifest.claimIds.some((id) => typeof id !== "string" || id.length === 0)) {
    fail("manifest schema or initiative claim list is invalid");
  }
  const scopes = byteEntries(manifest.scope, "scope");
  const prework = byteEntries(manifest.prework, "prework");
  const scopeBytes = scopes.reduce((total, entry) => total + entry.bytes, 0);
  const preworkBytes = prework.reduce((total, entry) => total + entry.bytes, 0);
  return {
    schemaVersion: CEREMONY_COST_SCHEMA_VERSION,
    initiative: manifest.initiative,
    scopeBytes,
    claimCount: manifest.claimIds.length,
    preworkBytes,
    totalBytes: scopeBytes + preworkBytes,
  };
}

if (process.argv[1]?.endsWith("ceremony-cost.mjs")) {
  const pathIndex = process.argv.indexOf("--manifest");
  if (pathIndex < 0 || !process.argv[pathIndex + 1]) {
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: "CEREMONY_COST_MANIFEST_REQUIRED" })}\n`);
    process.exitCode = 2;
  } else {
    try {
      const manifest = JSON.parse(readFileSync(resolve(process.argv[pathIndex + 1]), "utf8"));
      process.stdout.write(`${JSON.stringify({ ok: true, reasonCode: "CEREMONY_COST_MEASURED", ...measureCeremonyCost(manifest) })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: error?.reasonCode ?? "CEREMONY_COST_MANIFEST_INVALID", error: String(error?.message ?? error) })}\n`);
      process.exitCode = 1;
    }
  }
}
