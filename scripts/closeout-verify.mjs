#!/usr/bin/env node
// TCRN-CROSS-INIT-019 INC-054 — 批单逐项核销:处置集与原单条目集机器可 diff.
//
//   node tcrn-workflow/scripts/closeout-verify.mjs --manifest <manifest.json>
//
// A multi-item incident (a batch) closes by listing EVERY original item and giving each
// exactly one disposition. A disposition set that silently omits an original item is the
// defect INC-051 committed (gate_list data source and the INC041 double-write never
// appeared in "fixed" or "retained" — they just vanished). This tool diffs the manifest's
// item set against the closed dispositions and refuses a manifest that leaves an item
// without a disposition.
//
// Manifest shape:
// {
//   "schemaVersion": "tcrn.closeout-verify.v1",
//   "incident": "INC-051",
//   "items": [ "item-id-1", "item-id-2", ... ],      // the ORIGINAL item set
//   "dispositions": {                                 // every original item must appear
//     "item-id-1": { "kind": "fixed" },
//     "item-id-2": { "kind": "retained", "ticket": "work:<id>" },  // retained REQUIRES a live chain work id
//     "item-id-3": { "kind": "deferred", "reason": "..." }
//   }
// }
//
// Rules: every original item has a disposition; no disposition names an unknown item; a
// retained disposition names a chain work id; a superseded disposition names the work id
// that carries it; a deferred disposition carries a reason.
//
// `superseded` is the disposition a batch uses when the item's requirement is not
// independently closed here but is carried by a named downstream work item (a
// facet of the storage/transport migration in INIT-020 — e.g. an INC whose
// protection target is re-homed onto a facade story). It exists so a batch can be
// reconciled without either folding the item into a retained disposition (which
// would claim an independent continuation this initiative does not run) or
// deferring it (which is for a reason, not a carrier). `carriedBy` must name a
// chain work id, the same shape `retained.ticket` requires — a superseded item
// that names no live carrier is exactly the evaporation this tool exists to
// catch.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function chainWorkId(value) {
  return typeof value === "string" && /^work:[a-f0-9]{24}$/u.test(value);
}

export function verifyCloseout(manifest) {
  const problems = [];
  if (manifest?.schemaVersion !== "tcrn.closeout-verify.v1") {
    problems.push("schemaVersion must be tcrn.closeout-verify.v1");
  }
  if (!Array.isArray(manifest?.items) || manifest.items.length === 0) {
    problems.push("items must be a non-empty array of the original item ids");
  }
  const dispositions = manifest?.dispositions ?? {};
  const items = manifest?.items ?? [];
  for (const item of items) {
    const d = dispositions[item];
    if (d === undefined) {
      problems.push(`item ${item} has no disposition — omitted from the disposition set`);
      continue;
    }
    if (!["fixed", "retained", "superseded", "deferred"].includes(d.kind)) {
      problems.push(`item ${item} has unknown disposition ${d.kind}`);
      continue;
    }
    if (d.kind === "retained" && !chainWorkId(d.ticket)) {
      problems.push(`item ${item} is retained but names no chain work ticket`);
    }
    if (d.kind === "superseded" && !chainWorkId(d.carriedBy)) {
      problems.push(`item ${item} is superseded but names no carrying chain work id`);
    }
    if (d.kind === "deferred" && typeof d.reason !== "string") {
      problems.push(`item ${item} is deferred but carries no reason`);
    }
  }
  for (const item of Object.keys(dispositions)) {
    if (!items.includes(item)) {
      problems.push(`disposition names unknown item ${item} — not in the original set`);
    }
  }
  return {
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? "CLOSEOUT_ITEMS_RECONCILED" : "CLOSEOUT_ITEMS_UNRECONCILED",
    incident: manifest?.incident ?? "<unknown>",
    itemCount: items.length,
    dispositionCount: Object.keys(dispositions).length,
    problems
  };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1]?.endsWith("closeout-verify.mjs")) {
  const path = process.argv.includes("--manifest") ? resolve(process.argv[process.argv.indexOf("--manifest") + 1]) : null;
  if (path === null) {
    process.stderr.write("usage: closeout-verify.mjs --manifest <manifest.json>\n");
    process.exitCode = 2;
  } else {
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(path, "utf8")); } catch { manifest = null; }
    if (manifest === null) {
      process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: "MANIFEST_UNREADABLE", path })}\n`);
      process.exitCode = 1;
    } else {
      const result = verifyCloseout(manifest);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      for (const p of result.problems) process.stderr.write(`  PROBLEM: ${p}\n`);
      if (!result.ok) process.exitCode = 1;
    }
  }
}
