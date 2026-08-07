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
// TCRN-CROSS-INIT-020 INC-077 — the red-leg obligation for window-type closeouts. A
// freeze/archive/retire/migrate closeout whose acceptance only ran the positive leg
// (the new path works) is NOT accepted: the negative leg (the old path refuses to
// write) is half the acceptance criteria, and a window closeout that omits it must
// red. Machine form: a manifest declaring `windowed: true` MUST carry a non-empty,
// well-formed `redLeg` record naming the old pathway and the refusal it must produce.
// A redLeg that is present must always be well-formed, so a copy-pasted or emptied
// redLeg field fails closed rather than being waved through.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const RED_LEG_VERSION = "tcrn.closeout-red-leg.v1";

function chainWorkId(value) {
  return typeof value === "string" && /^work:[a-f0-9]{24}$/u.test(value);
}

// INC-077: a window-type closeout's negative leg. When present it must be
// well-formed; when the manifest is `windowed` it is REQUIRED.
function redLegProblems(redLeg) {
  const problems = [];
  if (redLeg === null || typeof redLeg !== "object" || Array.isArray(redLeg)) {
    return ["redLeg must be an object"];
  }
  if (redLeg.schemaVersion !== RED_LEG_VERSION) {
    problems.push(`redLeg.schemaVersion must be ${RED_LEG_VERSION}`);
  }
  if (typeof redLeg.target !== "string" || redLeg.target.length === 0) {
    problems.push("redLeg.target must name the frozen/archived/retired/migrated object");
  }
  if (typeof redLeg.oldPathway !== "string" || redLeg.oldPathway.length === 0) {
    problems.push("redLeg.oldPathway must name the pathway that must refuse");
  }
  if (typeof redLeg.refusalReasonCode !== "string" || redLeg.refusalReasonCode.length === 0) {
    problems.push("redLeg.refusalReasonCode must name the refusal code the old pathway produces");
  }
  if (typeof redLeg.evidence !== "string" || redLeg.evidence.length === 0) {
    problems.push("redLeg.evidence must point at the recorded negative-leg run");
  }
  return problems;
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
  // INC-077: the INIT-020 storage/archive/migration batch is windowed by its
  // item set, not by a caller's self-description. An entry that tries to set
  // `windowed:false` cannot evade the negative-leg obligation.
  const derivedWindowed = items.some((item) => /^(?:INC-07[4-9]|INC-08[0-9])$/u.test(item));
  if (derivedWindowed && manifest?.windowed !== true) {
    problems.push("INIT-020 storage/archive/migration items require windowed:true; the red-leg class is derived from the item set");
  }
  if (manifest?.windowed === true || derivedWindowed) {
    if (manifest.redLeg === undefined || manifest.redLeg === null) {
      problems.push("windowed closeout requires a redLeg record (INC-077: only a positive leg is not acceptance)");
    } else {
      problems.push(...redLegProblems(manifest.redLeg).map((problem) => `redLeg: ${problem}`));
    }
  } else if (manifest?.redLeg !== undefined) {
    problems.push(...redLegProblems(manifest.redLeg).map((problem) => `redLeg: ${problem}`));
  }
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
