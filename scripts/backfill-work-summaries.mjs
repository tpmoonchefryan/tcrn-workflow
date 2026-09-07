#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-363 — give the records that predate `summary` one.
//
// The field is written at creation from the Goal block's first sentence, so every record
// created from here on has a summary and none of the ones already on a chain does.
// Backfilling them is a chain write like any other: it goes through the engine's own
// work-annotate verb, one event per record, each carrying the actor that ran it. Nothing
// here touches a workspace directory itself.
//
// Two modes, and the safe one is the default:
//   (no flag)  plan only. Reads the workspace, writes nothing, prints what it would do.
//   --apply    performs the annotations, in id order, stopping at the first refusal.
//
// The summary it derives is the same one createWork would have derived, because it is the
// same function: deriveWorkSummary off the core barrel. A second implementation here would
// drift from the engine's the first time either changed.
//
// The work is exported rather than done at import time so the test can drive it in-process
// with its own write sink. A grandchild of the test controller does not keep its stdout.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { deriveWorkSummary, validateWorkspace } from "../dist/build/packages/core/src/index.js";
import { WORK_SUMMARY_MAX_BYTES } from "../dist/build/packages/protocol/src/index.js";
import { runOperatorCli } from "../dist/build/packages/cli/src/index.js";

const ADVISORY_SCOPE_KEY = "advisory:scope";

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

// One instant per event, derived from the base by adding the record's ordinal in seconds.
// A batch that stamped every event with one instant would be asking the chain to record a
// hundred separate acts as simultaneous.
function instantAt(base, offsetSeconds) {
  return `${new Date(Date.parse(base) + offsetSeconds * 1000).toISOString().slice(0, 19)}Z`;
}

function scopeOf(record) {
  const value = record.extensions?.[ADVISORY_SCOPE_KEY]?.value;
  return typeof value === "string" ? value : "";
}

async function annotate(tokens) {
  let output = "";
  await runOperatorCli(tokens, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

export async function backfillWorkSummaries(argv) {
  const workspace = flag(argv, "workspace");
  const base = flag(argv, "at");
  const actor = flag(argv, "actor");
  const apply = argv.includes("--apply");
  if (!workspace) {
    return { ok: false, reasonCode: "BACKFILL_INPUT_INVALID", error: "--workspace <path> names the workspace to read" };
  }
  if (apply && (!base || !actor)) {
    return {
      ok: false,
      reasonCode: "BACKFILL_INPUT_INVALID",
      error: "--apply requires --at <instant> and --actor <id>: an unattributed chain write is not one this tool will make",
    };
  }
  const state = await validateWorkspace(workspace);
  const scoped = state.work.filter((record) => !record.tombstone && scopeOf(record).length > 0);
  // A record qualifies when it has scope to derive from and no summary yet. `undefined` is
  // the pre-363 shape and `null` is a record created after the field existed with nothing
  // to derive; both are backfillable, and one that already carries a summary is left alone.
  const candidates = scoped
    .map((record) => ({
      id: record.id,
      externalKey: record.externalKey,
      kind: record.kind,
      status: record.status,
      existing: record.summary ?? null,
      derived: deriveWorkSummary(scopeOf(record), WORK_SUMMARY_MAX_BYTES),
    }))
    .filter((entry) => entry.existing === null && typeof entry.derived === "string")
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  if (!apply) {
    return {
      ok: true,
      reasonCode: "BACKFILL_PLANNED",
      mode: "plan",
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      scoped: scoped.length,
      candidates: candidates.length,
      maximumBytes: WORK_SUMMARY_MAX_BYTES,
      records: candidates.map((entry) => ({ ...entry, bytes: Buffer.byteLength(entry.derived, "utf8") })),
    };
  }
  const written = [];
  for (const [index, entry] of candidates.entries()) {
    const receipt = await annotate([
      "work-annotate", "--workspace", workspace, "--expected-version", "head",
      "--at", instantAt(base, index), "--id", entry.id, "--summary", entry.derived, "--actor", actor,
    ]);
    written.push({ id: entry.id, externalKey: entry.externalKey, version: receipt.version, summary: entry.derived });
  }
  return {
    ok: true,
    reasonCode: "BACKFILL_APPLIED",
    mode: "apply",
    workspaceId: state.metadata.workspaceId,
    actor,
    written: written.length,
    records: written,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await backfillWorkSummaries(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
