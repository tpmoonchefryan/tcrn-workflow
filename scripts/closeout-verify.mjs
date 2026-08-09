#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
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
//     "item-id-3": { "kind": "deferred", "reason": "...", "timing": "..." }
//   }
// }
//
// Rules: every original item has a disposition; no disposition names an unknown item; a
// retained disposition names a chain work id; a superseded disposition names the work id
// that carries it; a deferred disposition carries a reason and timing (or a legacy `scope`
// field that explicitly states the timing).
//
// TCRN-CROSS-INIT-020 INC-077 — the red-leg obligation for window-type closeouts. A
// freeze/archive/retire/migrate closeout whose acceptance only ran the positive leg
// (the new path works) is NOT accepted: the negative leg (the old path refuses to
// write) is half the acceptance criteria, and a window closeout that omits it must
// red. Machine form: a manifest declaring `windowed: true` MUST carry a non-empty,
// well-formed `redLeg` record naming the old pathway and the refusal it must produce.
// A redLeg that is present must always be well-formed, so a copy-pasted or emptied
// redLeg field fails closed rather than being waved through.

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { storyScopeProblems } from "./story-scope-compliance.mjs";

export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const RED_LEG_VERSION = "tcrn.closeout-red-leg.v1";
const CHAIN_AUTHORITY_VERSION = "tcrn.closeout-chain-authority.v1";
const LIVE_AUTHORITY_VERSION = "tcrn.closeout-live-authority.v1";
const CLOSEOUT_SCHEMA_V1 = "tcrn.closeout-verify.v1";
const CLOSEOUT_SCHEMA_V2 = "tcrn.closeout-verify.v2";

function chainWorkId(value) {
  return typeof value === "string" && /^work:[a-f0-9]{24}$/u.test(value);
}

function chainItemId(value) {
  let raw = typeof value === "string" ? value : null;
  if (value && typeof value === "object") {
    for (const key of ["id", "externalKey", "key", "itemId"]) {
      if (typeof value[key] === "string" && value[key].length > 0) {
        raw = value[key];
        break;
      }
    }
  }
  if (raw === null) return null;
  return raw.match(/^TCRN-CROSS-(.+)$/u)?.[1] ?? raw;
}

function noteText(note) {
  if (typeof note === "string") return note;
  if (note && typeof note === "object") return JSON.stringify(note);
  return "";
}

function namedEvidence(note) {
  const text = noteText(note);
  return /(?:evidence|receipt|reasonCode|sha256|hash|\.json|\.md)/iu.test(text);
}

function redLegNamed(note) {
  const text = noteText(note);
  return /(?:red[- ]?leg|negative[- ]?leg|negative path|红腿|负腿)/iu.test(text)
    || note?.redLeg === true || note?.negativeLeg === true;
}

function initiativeIncident(value) {
  return typeof value === "string" && /^TCRN-CROSS-INIT-\d+$/u.test(value);
}

function authorityItems(authority) {
  const source = authority?.items ?? authority?.records ?? authority?.workItems;
  return Array.isArray(source) ? source : null;
}

function authorityHead(authority) {
  return authority?.head
    ?? authority?.chainAuthority
    ?? (authority && typeof authority === "object" && authority.headEventHash !== undefined ? authority : null);
}

function authorityScope(authority) {
  const scope = authority?.scope;
  return scope && typeof scope === "object" && !Array.isArray(scope) ? scope : null;
}

function authorityScopeItems(authority) {
  const scope = authorityScope(authority);
  if (!Array.isArray(scope?.itemIds)) return null;
  return scope.itemIds.map(chainItemId).filter((id) => id !== null);
}

function authorityItemId(value) {
  if (value && typeof value === "object") {
    for (const key of ["externalKey", "key", "itemId", "id"]) {
      if (typeof value[key] === "string" && value[key].length > 0) {
        return value[key].match(/^TCRN-CROSS-(.+)$/u)?.[1] ?? value[key];
      }
    }
  }
  return chainItemId(value);
}

function authorityShapeProblems(authority, { requireScope = false } = {}) {
  const problems = [];
  if (authority === null || typeof authority !== "object" || Array.isArray(authority)) {
    return ["live authority read is required; no authority object was supplied"];
  }
  if (authority.schemaVersion !== LIVE_AUTHORITY_VERSION) {
    problems.push(`live authority schemaVersion must be ${LIVE_AUTHORITY_VERSION}`);
  }
  if (typeof authority.source !== "string" || !/^live[-_ ]/iu.test(authority.source)) {
    problems.push("live authority source must identify a live read, not a captured manifest or prose");
  }
  if (typeof authority.partition !== "string" || authority.partition.length === 0) {
    problems.push("live authority partition must identify the chain partition");
  }
  if (typeof authority.observedAt !== "string" || Number.isNaN(Date.parse(authority.observedAt))) {
    problems.push("live authority observedAt must be an ISO timestamp");
  }
  const head = authorityHead(authority);
  if (head === null || typeof head !== "object" || Array.isArray(head)
    || typeof head.workspaceId !== "string" || !Number.isSafeInteger(head.version)
    || head.version < 0 || !/^[a-f0-9]{64}$/u.test(head.headEventHash ?? "")) {
    problems.push("live authority must carry a canonical chain head from the live read");
  }
  const records = authorityItems(authority);
  if (records === null || records.length === 0) {
    problems.push("live authority must carry a non-empty work-list read");
  } else if (records.some((record) => authorityItemId(record) === null)) {
    problems.push("live authority work-list contains a record without id/externalKey/key");
  }
  if (requireScope) {
    const scope = authorityScope(authority);
    const scopeItems = authorityScopeItems(authority);
    if (scope === null || typeof scope.source !== "string" || !/^live[-_ ]/iu.test(scope.source)
      || typeof scope.workId !== "string" || !/^work:[a-f0-9]{24}$/u.test(scope.workId)
      || typeof scope.text !== "string" || scope.text.trim().length === 0
      || scopeItems === null || scopeItems.length === 0) {
      problems.push("live authority must carry a live work-show scope-derived item set");
    }
  }
  return problems;
}

function sameHead(left, right) {
  return left?.workspaceId === right?.workspaceId
    && left?.version === right?.version
    && left?.headEventHash === right?.headEventHash;
}

function evidencePaths(note) {
  const text = noteText(note);
  const rawPaths = [...text.matchAll(/(?:^|[\s(\[【「:：])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_./{},-]+\.(?:json|jsonl|md|mjs|txt))(?:$|[\s)\],。；;】」])/gu)]
    .map((match) => match[1]);
  const expanded = [];
  for (const path of rawPaths) {
    const brace = path.match(/^(.*)\{([^{}]+)\}(.*)$/u);
    if (brace === null) {
      expanded.push(path);
      continue;
    }
    for (const alternative of brace[2].split(",")) {
      if (/^[A-Za-z0-9_.-]+$/u.test(alternative)) expanded.push(`${brace[1]}${alternative}${brace[3]}`);
    }
  }
  return [...new Set(expanded)];
}

function evidenceProblems(note, item, projectRoot, evidenceRoots = []) {
  const problems = [];
  const paths = evidencePaths(note);
  if (paths.length === 0) {
    problems.push(`item ${item} live chain note names no evidence file path`);
    return problems;
  }
  for (const path of paths) {
    const roots = [projectRoot, ...evidenceRoots].map((root) => resolve(root));
    const exists = roots.some((root) => {
      const candidate = resolve(root, path);
      const rel = relative(root, candidate);
      return !rel.startsWith("..") && !rel.includes("\\") && existsSync(candidate);
    });
    if (!exists) {
      problems.push(`item ${item} live chain note names missing evidence file ${path}`);
    }
  }
  return problems;
}

function chainCloseoutProblems(manifest, items, dispositions, {
  authority: liveAuthority = null,
  projectRoot = PLATFORM_ROOT,
  evidenceRoots = [],
} = {}) {
  const problems = [];
  const source = manifest?.authoritativeItems
    ?? manifest?.chainItems
    ?? manifest?.chain?.items;
  const requiresLiveAuthority = manifest?.schemaVersion === CLOSEOUT_SCHEMA_V2
    || initiativeIncident(manifest?.incident)
    || manifest?.authoritativeItems !== undefined;

  // These flags were introduced as a self-closing switch. They are not part of the
  // contract any more; retaining either spelling is itself a red result.
  if (manifest?.requireChainEvidence === false || manifest?.requireChainRedLeg === false) {
    problems.push("chain evidence and red-leg obligations are mandatory; manifest cannot disable them");
  }

  if (source === undefined) {
    if (!requiresLiveAuthority) return problems;
    if (liveAuthority === null || liveAuthority === undefined) {
      problems.push("chain-bound closeout requires a live work-list authority read; authoritativeItems/manifest.items alone are not authoritative");
    }
  }
  if (source !== undefined && (!Array.isArray(source) || source.length === 0)) {
    problems.push("chainItems must be a non-empty authoritative item array");
  }
  const derived = Array.isArray(source) ? source.map(chainItemId) : [];
  if (derived.some((id) => id === null)) problems.push("chainItems contains an item without id/externalKey/key");
  const original = new Set(items);
  const authoritative = new Set(derived.filter((id) => id !== null));
  if (source !== undefined
    && (original.size !== authoritative.size || [...original].some((id) => !authoritative.has(id)))) {
    problems.push("items must equal the chain-derived item set; the closeout may not omit or invent a chain item");
  }

  if (requiresLiveAuthority) {
    const requireScope = initiativeIncident(manifest?.incident);
    problems.push(...authorityShapeProblems(liveAuthority, { requireScope }));
    const live = authorityItems(liveAuthority);
    const liveIds = new Set((live ?? []).map(authorityItemId).filter((id) => id !== null));
    const scopedIds = new Set((authorityScopeItems(liveAuthority) ?? []).filter((id) => id !== null));
    const comparisonIds = scopedIds.size > 0 ? scopedIds : liveIds;
    const comparisonLabel = scopedIds.size > 0 ? "live scope-derived" : "live chain-derived";
    if (comparisonIds.size > 0 && (original.size !== comparisonIds.size || [...original].some((id) => !comparisonIds.has(id)))) {
      problems.push(`items must equal the ${comparisonLabel} item set; the closeout may not omit or invent a chain item`);
    }
    if (source !== undefined && comparisonIds.size > 0
      && (authoritative.size !== comparisonIds.size || [...authoritative].some((id) => !comparisonIds.has(id)))) {
      problems.push(`manifest authoritativeItems disagree with the ${comparisonLabel} item set`);
    }

    const binding = manifest.chainAuthority ?? manifest.authority;
    const liveHead = authorityHead(liveAuthority);
    if (binding === undefined || binding === null || typeof binding !== "object" || Array.isArray(binding)) {
      problems.push("chain-bound closeout requires a chainAuthority binding to the live read");
    } else {
      if (binding.schemaVersion !== CHAIN_AUTHORITY_VERSION) {
        problems.push(`chainAuthority.schemaVersion must be ${CHAIN_AUTHORITY_VERSION}`);
      }
      if (typeof binding.source !== "string" || !/^live[-_ ]/iu.test(binding.source)) {
        problems.push("chainAuthority.source must identify the authority read");
      }
      if (typeof binding.partition !== "string" || binding.partition.length === 0) {
        problems.push("chainAuthority.partition must identify the chain partition");
      }
      if (typeof binding.observedAt !== "string" || Number.isNaN(Date.parse(binding.observedAt))) {
        problems.push("chainAuthority.observedAt must be an ISO timestamp");
      }
      if (typeof binding.headEventHash !== "string" || !/^[a-f0-9]{64}$/u.test(binding.headEventHash)) {
        problems.push("chainAuthority.headEventHash must be a 64-character authority head hash");
      }
      if (liveHead && (!sameHead(binding, liveHead) || binding.partition !== liveAuthority?.partition)) {
        problems.push("chainAuthority binding does not match the live authority head/partition");
      }
    }
  }

  const notes = manifest?.chainNotes
    ?? manifest?.chainAnnotations
    ?? manifest?.closeoutNotes
    ?? manifest?.chain?.annotations;
  const hasManifestNotes = notes !== undefined && notes !== null
    && typeof notes === "object" && !Array.isArray(notes);
  if (!hasManifestNotes && !requiresLiveAuthority) {
    problems.push("chainItems require per-item chainNotes/chainAnnotations");
    return problems;
  }
  if (hasManifestNotes) {
    for (const item of items) {
      const note = Array.isArray(notes)
        ? notes.find((entry) => chainItemId(entry) === item)
        : notes[item];
      if (note === undefined || note === null || noteText(note).length === 0) {
        problems.push(`item ${item} has no per-item chain closeout note`);
        continue;
      }
      if (!namedEvidence(note)) {
        problems.push(`item ${item} chain closeout note names no evidence/receipt/hash`);
      }
      if (dispositions[item]?.kind !== "deferred" && !redLegNamed(note)) {
        problems.push(`item ${item} chain closeout note names no red-leg/negative-leg result`);
      }
    }
  }

  if (requiresLiveAuthority) {
    const live = authorityItems(liveAuthority) ?? [];
    const byId = new Map(live.map((record) => [authorityItemId(record), record]));
    for (const item of items) {
      const record = byId.get(item);
      const note = record?.closeoutNote ?? record?.annotation ?? record?.scope ?? record?.note;
      if (note === undefined || note === null || noteText(note).length === 0) {
        problems.push(`item ${item} has no live chain closeout note`);
        continue;
      }
      problems.push(...evidenceProblems(note, item, projectRoot, evidenceRoots));
    }
  }

  if (manifest.requireExecutionForm === true) {
    const executionForm = manifest.executionForm ?? manifest.execution?.form;
    const actor = manifest.actor ?? manifest.execution?.actor;
    if (typeof executionForm !== "string" || executionForm.trim().length === 0) {
      problems.push("closeout requires an execution-form declaration");
    }
    if (typeof actor !== "string" || !/^(?:agent|person):[A-Za-z0-9._:-]+$/u.test(actor)) {
      problems.push("closeout requires the executing actor's own attributed persona");
    }
  }
  return problems;
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

export function verifyCloseout(manifest, options = {}) {
  const problems = [];
  if (![CLOSEOUT_SCHEMA_V1, CLOSEOUT_SCHEMA_V2].includes(manifest?.schemaVersion)) {
    problems.push(`schemaVersion must be ${CLOSEOUT_SCHEMA_V1} or ${CLOSEOUT_SCHEMA_V2}`);
  }
  if (!Array.isArray(manifest?.items) || manifest.items.length === 0) {
    problems.push("items must be a non-empty array of the original item ids");
  }
  const dispositions = manifest?.dispositions ?? {};
  const items = manifest?.items ?? [];
  if (dispositions === null || typeof dispositions !== "object" || Array.isArray(dispositions)) {
    problems.push("dispositions must be an object keyed by original item id");
  }
  if (new Set(items).size !== items.length) {
    problems.push("items must not contain duplicate ids");
  }
  problems.push(...chainCloseoutProblems(manifest, items, dispositions, options));
  // Closeout is an independent backstop: the live authority must carry every
  // non-terminal Story's scope, even when the transition path was bypassed by a
  // legacy engine or an imported authority adapter.
  if (options.authority !== undefined && options.authority !== null) {
    problems.push(...storyScopeProblems(options.authority.storyScopes ?? options.authority.items));
  }
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
    if (d === null || typeof d !== "object" || Array.isArray(d)) {
      problems.push(`item ${item} has a non-object disposition`);
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
    if (d.kind === "deferred" && (typeof d.reason !== "string" || d.reason.trim().length === 0)) {
      problems.push(`item ${item} is deferred but carries no reason`);
    }
    if (d.kind === "deferred" && !((typeof d.timing === "string" && d.timing.trim().length > 0) || (typeof d.scope === "string" && d.scope.trim().length > 0))) {
      problems.push(`item ${item} is deferred but carries no timing`);
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
    authority: manifest?.schemaVersion === CLOSEOUT_SCHEMA_V2 || initiativeIncident(manifest?.incident)
      ? {
        required: true,
        supplied: options.authority !== undefined && options.authority !== null,
        source: options.authority?.source ?? null,
        observedAt: options.authority?.observedAt ?? null,
        head: authorityHead(options.authority),
      }
      : { required: false },
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
