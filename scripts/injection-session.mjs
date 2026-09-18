#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat as lstatAsync, readdir as readdirAsync, readFile as readFileAsync } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const INJECTION_SESSION_SCHEMA_VERSION = "tcrn.injection-session-state.v1";
export const DEFAULT_SESSION_BUDGET = 24_576;
export const DEFAULT_PER_PROMPT_BYTES = 1_600;
export const MAX_INJECTION_ROWS = 8;
export const MAX_INJECTION_ROW_BYTES = 200;
export const DEFAULT_STATE_DIRECTORY = join(homedir(), ".tcrn-injection");
export const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;
export const DEFAULT_SEARCH_MAX_FILES = 256;
export const DEFAULT_SEARCH_MAX_MATCHES = 100;
export const DEFAULT_SEARCH_MAX_DEPTH = 3;
export const DEFAULT_SEARCH_MAX_FILE_BYTES = 1_048_576;

// TCRN-CROSS-STORY-418: a hook payload is not a work assignment.  The three
// values below are the minimum binding an injection is allowed to trust.  They
// deliberately live on this small, host-neutral module so Claude and Codex use
// the same parser and the same refusal reasons.
export const DISPATCH_CONTEXT_SCHEMA_VERSION = "tcrn.dispatch-context.v1";
export const DISPATCH_ROLES = Object.freeze(["main", "subagent"]);
export const DISPATCH_CONTEXT_FIELD_BYTES = Object.freeze({ role: 64, workId: 256, pack: 256, dispatchId: 256, parentSession: 256, dependency: 256 });

const ROLE_ALIASES = Object.freeze({
  main: "main",
  orchestrator: "main",
  parent: "main",
  "main-agent": "main",
  subagent: "subagent",
  "sub-agent": "subagent",
  child: "subagent",
  worker: "subagent",
});

const LOCK_WAIT_MS = 5;
const LOCK_STALE_MS = 60_000;
const MAX_HISTORY = 256;
const ACTIVE_READY = new Set(["active", "ready"]);

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function canonicalIdCompare(left, right) {
  return Buffer.from(String(left), "utf8").compare(Buffer.from(String(right), "utf8"));
}

/** Truncate text without splitting a UTF-8 sequence. */
export function boundedUtf8(text, maximumBytes) {
  const bytes = Buffer.from(String(text ?? ""), "utf8");
  if (bytes.length <= maximumBytes) return bytes.toString("utf8");
  let end = Math.max(0, maximumBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function extensionValue(record, key) {
  const raw = record?.extensions?.[key];
  if (raw !== null && typeof raw === "object" && Object.hasOwn(raw, "value")) return raw.value;
  return raw;
}

export function recordIdentity(record) {
  if (typeof record?.id === "string" && record.id.length > 0) return record.id;
  if (typeof record?.key === "string" && record.key.length > 0) return `${record.kind ?? "record"}:${record.key}`;
  return null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function searchManifestScope(manifest) {
  if (Array.isArray(manifest)) return { files: manifest, directories: [] };
  if (!isObject(manifest)) return { files: [], directories: [] };
  return {
    files: manifest.files ?? manifest.paths ?? manifest.knownFiles ?? [],
    directories: manifest.directories ?? manifest.roots ?? manifest.knownDirectories ?? [],
  };
}

function searchPaths(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}

function searchNextScope(queue, current = null) {
  const pending = current === null ? queue : [current, ...queue];
  return {
    files: [...new Set(pending.filter((entry) => entry.kind === "file").map((entry) => entry.path))],
    directories: [...new Set(pending.filter((entry) => entry.kind === "directory").map((entry) => entry.path))],
  };
}

function searchResult({ query, matches = [], scannedFiles = 0, partial = false, reasonCode = "SEARCH_COMPLETED", partialReason = null, nextScope = null, ...extra }) {
  return {
    ok: reasonCode !== "SEARCH_SCOPE_REQUIRED" && reasonCode !== "SEARCH_SCOPE_OUT_OF_BOUNDS",
    reasonCode,
    query,
    matches,
    scannedFiles,
    partial,
    ...(partialReason === null ? {} : { partialReason }),
    nextScope,
    ...extra,
  };
}

/**
 * Search only an explicit file/manifest/directory scope. An empty scope never
 * falls back to home or a repository-wide walk, and every incomplete result
 * carries the work that remains for a later, explicitly widened call.
 */
export async function boundedSearch({
  query,
  files = [],
  directories = [],
  manifest = null,
  timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
  maxFiles = DEFAULT_SEARCH_MAX_FILES,
  maxMatches = DEFAULT_SEARCH_MAX_MATCHES,
  maxDepth = DEFAULT_SEARCH_MAX_DEPTH,
  maxFileBytes = DEFAULT_SEARCH_MAX_FILE_BYTES,
} = {}) {
  const text = typeof query === "string" ? query : String(query ?? "");
  if (text.trim().length === 0) return searchResult({ query: text, partial: true, reasonCode: "SEARCH_QUERY_REQUIRED", nextScope: null });
  const manifestScope = searchManifestScope(manifest);
  const scopedFiles = searchPaths([...manifestScope.files, ...(Array.isArray(files) ? files : [])]);
  const scopedDirectories = searchPaths([...manifestScope.directories, ...(Array.isArray(directories) ? directories : [])]);
  const nextScope = { files: scopedFiles, directories: scopedDirectories };
  if (scopedFiles.length === 0 && scopedDirectories.length === 0) {
    return searchResult({ query: text, partial: true, reasonCode: "SEARCH_SCOPE_REQUIRED", nextScope });
  }
  if ([...scopedFiles, ...scopedDirectories].some((path) => !isAbsolute(path))) {
    return searchResult({ query: text, partial: true, reasonCode: "SEARCH_SCOPE_OUT_OF_BOUNDS", nextScope });
  }
  const forbiddenRoots = [resolve(homedir()), resolve(homedir(), "Code")];
  const forbidden = scopedDirectories.find((path) => path === "/" || forbiddenRoots.some((root) => path === root));
  if (forbidden !== undefined) {
    return searchResult({ query: text, partial: true, reasonCode: "SEARCH_SCOPE_OUT_OF_BOUNDS", nextScope: { files: scopedFiles, directories: [forbidden] }, rejectedPath: forbidden });
  }
  const numeric = (value, fallback, minimum) => Number.isSafeInteger(value) && value >= minimum ? value : fallback;
  const timeout = numeric(timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS, 0);
  const fileLimit = numeric(maxFiles, DEFAULT_SEARCH_MAX_FILES, 1);
  const matchLimit = numeric(maxMatches, DEFAULT_SEARCH_MAX_MATCHES, 1);
  const depthLimit = numeric(maxDepth, DEFAULT_SEARCH_MAX_DEPTH, 0);
  const byteLimit = numeric(maxFileBytes, DEFAULT_SEARCH_MAX_FILE_BYTES, 1);
  const queue = [
    ...scopedFiles.map((path) => ({ kind: "file", path, depth: 0 })),
    ...scopedDirectories.map((path) => ({ kind: "directory", path, depth: 0 })),
  ];
  const matches = [];
  const lowerQuery = text.toLocaleLowerCase();
  const started = Date.now();
  const deadline = started + timeout;
  let scannedFiles = 0;
  let partial = false;
  let partialReason = null;
  const markPartial = (reason) => {
    partial = true;
    if (partialReason === null) partialReason = reason;
  };
  while (queue.length > 0) {
    if (Date.now() >= deadline) {
      markPartial("SEARCH_TIMEOUT");
      break;
    }
    const current = queue.shift();
    if (current.kind === "directory") {
      if (current.depth >= depthLimit) {
        markPartial("SEARCH_DEPTH_LIMIT");
        queue.unshift(current);
        break;
      }
      let entries;
      try {
        entries = (await readdirAsync(current.path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
      } catch {
        markPartial("SEARCH_SCOPE_UNREADABLE");
        queue.unshift(current);
        break;
      }
      for (const entry of entries) {
        const child = join(current.path, entry.name);
        if (entry.isSymbolicLink()) {
          markPartial("SEARCH_SYMLINK_SKIPPED");
          continue;
        }
        queue.push({ kind: entry.isDirectory() ? "directory" : "file", path: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (scannedFiles >= fileLimit) {
      markPartial("SEARCH_FILE_LIMIT");
      queue.unshift(current);
      break;
    }
    let info;
    try { info = await lstatAsync(current.path); } catch {
      markPartial("SEARCH_FILE_UNREADABLE");
      queue.unshift(current);
      break;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      markPartial("SEARCH_FILE_UNREADABLE");
      continue;
    }
    if (info.size > byteLimit) {
      markPartial("SEARCH_FILE_SIZE_LIMIT");
      queue.unshift(current);
      break;
    }
    let content;
    try { content = await readFileAsync(current.path, "utf8"); } catch {
      markPartial("SEARCH_FILE_UNREADABLE");
      queue.unshift(current);
      break;
    }
    scannedFiles += 1;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLocaleLowerCase().includes(lowerQuery)) continue;
      matches.push({ path: current.path, line: index + 1, text: boundedUtf8(lines[index], MAX_INJECTION_ROW_BYTES) });
      if (matches.length >= matchLimit) {
        markPartial("SEARCH_MATCH_LIMIT");
        queue.unshift(current);
        break;
      }
    }
    if (partial) break;
  }
  return searchResult({
    query: text,
    matches,
    scannedFiles,
    partial,
    reasonCode: partial ? "SEARCH_PARTIAL" : "SEARCH_COMPLETED",
    partialReason,
    nextScope: partial ? searchNextScope(queue) : null,
  });
}

function boundedContextText(value, maximumBytes) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.includes("\u0000") || !text.isWellFormed()) return null;
  const bounded = boundedUtf8(text, maximumBytes);
  return bounded === text ? text : null;
}

function contextScopes(input) {
  if (!isObject(input)) return [];
  return [
    input,
    input.context,
    input.dispatchContext,
    input.dispatch,
    input.task,
    input.subagent,
    input.agent,
  ].filter(isObject);
}

function contextValues(scopes, names) {
  return scopes.flatMap((scope) => names.map((name) => scope[name]))
    .filter((value) => value !== undefined && value !== null && value !== "");
}

function oneContextValue(values) {
  const strings = values.map((value) => typeof value === "string" ? value.trim() : value);
  const unique = [];
  for (const value of strings) {
    if (!unique.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) unique.push(value);
  }
  return { value: unique[0], conflict: unique.length > 1 };
}

function contextEnvironmentValues(env, names) {
  return names.map((name) => env?.[name]).filter((value) => value !== undefined && value !== null && value !== "");
}

function normaliseRole(value) {
  if (typeof value !== "string") return null;
  return ROLE_ALIASES[value.trim().toLowerCase()] ?? null;
}

function contextPackValue(value) {
  if (isObject(value)) return value.id ?? value.packId ?? value.pack_id ?? value.key ?? null;
  return value;
}

function contextDependencyValues(scopes, env) {
  const values = contextValues(scopes, ["dependencies", "dependencyIds", "dependency_ids", "dependsOn"])
    .flatMap((value) => Array.isArray(value) ? value : String(value).split(","));
  values.push(...contextEnvironmentValues(env, ["TCRN_DISPATCH_DEPENDENCIES", "TCRN_CONTEXT_DEPENDENCIES"]));
  return [...new Set(values.map((value) => boundedContextText(String(value), DISPATCH_CONTEXT_FIELD_BYTES.dependency)).filter(Boolean))].slice(0, 16);
}

/**
 * Resolve the host supplied dispatch binding without consulting prompt text.
 *
 * A binding is intentionally all-or-nothing: role, workId and pack must arrive
 * together.  Treating a missing field as a default would let an unbound child
 * inherit whichever active item happened to win the old L0 ordering.
 */
export function normalizeDispatchContext(input = {}, { env = process.env, requireBinding = true } = {}) {
  const scopes = contextScopes(input);
  const roleValues = [...contextValues(scopes, ["role", "taskRole", "task_role", "agentRole", "agent_role", "dispatchRole", "dispatch_role"]), ...contextEnvironmentValues(env, ["TCRN_DISPATCH_ROLE", "TCRN_CONTEXT_ROLE"])];
  const workValues = [...contextValues(scopes, ["workId", "workID", "work_id", "workItemId", "work_item_id", "taskId", "task_id"]), ...contextEnvironmentValues(env, ["TCRN_DISPATCH_WORK_ID", "TCRN_WORK_ID", "TCRN_CONTEXT_WORK_ID"])];
  const packValues = [...contextValues(scopes, ["pack", "packId", "packID", "pack_id", "taskPack", "task_pack", "taskPackId", "task_pack_id", "batch", "batchId", "batchID", "batch_id"]), ...contextEnvironmentValues(env, ["TCRN_DISPATCH_PACK", "TCRN_PACK_ID", "TCRN_CONTEXT_PACK"])];
  const dispatchValues = [...contextValues(scopes, ["dispatchId", "dispatch_id"]), ...contextEnvironmentValues(env, ["TCRN_DISPATCH_ID"])];
  const parentValues = [...contextValues(scopes, ["parentSession", "parent_session", "parentSessionId", "parent_session_id"]), ...contextEnvironmentValues(env, ["TCRN_PARENT_SESSION", "TCRN_TELEMETRY_PARENT_SESSION"])]
    .map((value) => String(value));
  const role = oneContextValue(roleValues.map(normaliseRole));
  const workId = oneContextValue(workValues.map((value) => typeof value === "string" ? boundedContextText(value, DISPATCH_CONTEXT_FIELD_BYTES.workId) : null));
  const pack = oneContextValue(packValues.map(contextPackValue).map((value) => typeof value === "string" ? boundedContextText(value, DISPATCH_CONTEXT_FIELD_BYTES.pack) : null));
  const dispatchId = oneContextValue(dispatchValues.map((value) => typeof value === "string" ? boundedContextText(value, DISPATCH_CONTEXT_FIELD_BYTES.dispatchId) : null));
  const parentSession = oneContextValue(parentValues.map((value) => boundedContextText(value, DISPATCH_CONTEXT_FIELD_BYTES.parentSession)));
  const hasAny = roleValues.length > 0 || workValues.length > 0 || packValues.length > 0;
  const base = {
    schemaVersion: DISPATCH_CONTEXT_SCHEMA_VERSION,
    bound: false,
    role: role.value ?? null,
    workId: workId.value ?? null,
    pack: pack.value ?? null,
    dependencies: contextDependencyValues(scopes, env),
    dispatchId: dispatchId.value ?? null,
    parentSession: parentSession.value ?? null,
  };
  if (!hasAny && !requireBinding) return { ok: true, ...base, mode: "legacy" };
  if (role.conflict || workId.conflict || pack.conflict || dispatchId.conflict || parentSession.conflict) {
    return { ok: false, reasonCode: "DISPATCH_CONTEXT_BINDING_CONFLICT", ...base };
  }
  if (role.value == null || !DISPATCH_ROLES.includes(role.value)) {
    const missing = roleValues.length === 0 ? ["role"] : [];
    if (workId.value == null) missing.push("workId");
    if (pack.value == null) missing.push("pack");
    return { ok: false, reasonCode: roleValues.length === 0 ? "DISPATCH_CONTEXT_BINDING_MISSING" : "DISPATCH_CONTEXT_ROLE_INVALID", missing, ...base };
  }
  const missing = [];
  if (workId.value == null) missing.push("workId");
  if (pack.value == null) missing.push("pack");
  if (missing.length > 0) return { ok: false, reasonCode: "DISPATCH_CONTEXT_BINDING_MISSING", missing, ...base };
  return { ok: true, ...base, bound: true, mode: role.value };
}

// American spelling is kept as a small compatibility alias for callers that
// use the surrounding Workflow vocabulary.
export const normalizeDispatchBinding = normalizeDispatchContext;

function extensionContextValue(record, key) {
  const raw = record?.extensions?.[key];
  return isObject(raw) && Object.hasOwn(raw, "value") ? raw.value : raw;
}

function contextWorkIds(record) {
  const values = [
    ["Initiative", "Epic", "Story", "Subtask", "Incident", "Release", "work"].includes(record?.kind) ? record?.id : null,
    record?.workId,
    record?.work_id,
    ...(Array.isArray(record?.workIds) ? record.workIds : []),
    ...(Array.isArray(record?.linkedWorkIds) ? record.linkedWorkIds : []),
    ...(Array.isArray(record?.relatedWorkIds) ? record.relatedWorkIds : []),
    record?.sourceWorkId,
    record?.taskWorkId,
    record?.context?.workId,
    record?.metadata?.workId,
    extensionContextValue(record, "advisory:workId"),
    extensionContextValue(record, "advisory:work-id"),
    extensionContextValue(record, "advisory:workIds"),
    extensionContextValue(record, "advisory:linkedWorkIds"),
  ];
  return new Set(values.flatMap((value) => Array.isArray(value) ? value : [value]).filter((value) => typeof value === "string"));
}

function contextPacks(record) {
  const values = [
    record?.pack,
    record?.packId,
    record?.pack_id,
    record?.taskPack,
    record?.packKey,
    record?.batch,
    record?.batchId,
    record?.context?.pack,
    record?.metadata?.pack,
    extensionContextValue(record, "advisory:pack"),
    extensionContextValue(record, "advisory:packId"),
    extensionContextValue(record, "advisory:sprint"),
    ...(Array.isArray(record?.labels) ? record.labels : []),
    ...(Array.isArray(record?.tags) ? record.tags : []),
  ];
  return new Set(values.flatMap((value) => Array.isArray(value) ? value : [value]).filter((value) => typeof value === "string"));
}

/** Return true only when a candidate carries the bound work or pack identity. */
export function matchesDispatchContext(record, context) {
  if (!context?.ok || context.bound !== true) return false;
  const workIds = contextWorkIds(record);
  const packs = contextPacks(record);
  const workMatch = workIds.has(context.workId);
  const packMatch = packs.has(context.pack);
  // A bound work record normally has no pack field; its id is sufficient.  A
  // knowledge/minutes row may carry either explicit link.  Unbound rows are not
  // admitted merely because their prose happens to mention the prompt.
  return (workIds.size === 0 || workMatch) && (packs.size === 0 || packMatch) && (workIds.size > 0 || packs.size > 0);
}

export function filterCandidatesByDispatchContext(records, context) {
  if (!context?.ok || context.bound !== true) return { records: [], excluded: Array.isArray(records) ? records.length : 0, reasonCode: context?.reasonCode ?? "DISPATCH_CONTEXT_BINDING_MISSING" };
  const input = Array.isArray(records) ? records : [];
  const filtered = input.filter((record) => matchesDispatchContext(record, context));
  return { records: filtered, excluded: input.length - filtered.length, reasonCode: filtered.length > 0 ? "DISPATCH_CONTEXT_MATCHED" : "DISPATCH_CONTEXT_NO_MATCH" };
}

/**
 * The supersession relationship is explicit.  In particular, this never treats a `-L`
 * spelling as a relationship: the chain is allowed to carry unrelated keys with that
 * suffix, and only the recorded extension can retire an original.
 */
export function supersededBy(record) {
  const direct = record?.supersededBy;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const extension = extensionValue(record, "supersededBy");
  return typeof extension === "string" && extension.length > 0 ? extension : null;
}

export function deduplicateCandidates(records, alreadyEmittedIds = []) {
  const seen = new Set((alreadyEmittedIds ?? []).filter((id) => typeof id === "string"));
  const output = [];
  for (const record of records ?? []) {
    const id = recordIdentity(record);
    if (id === null || supersededBy(record) !== null || seen.has(id)) continue;
    seen.add(id);
    output.push(record);
  }
  return output;
}

function workStatusRank(status) {
  return status === "active" ? 0 : status === "ready" ? 1 : 2;
}

function eventRecord(payload) {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload.record
    : undefined;
}

function operationOf(event) {
  return event?.payload !== null && typeof event?.payload === "object" && !Array.isArray(event.payload)
    ? event.payload.operation
    : undefined;
}

/**
 * Calculate the ordering key from the validated event history.  An annotation is read
 * only to seed the preceding status; it does not update the key.  The fallback for a
 * record with no qualifying transition is zero, so the id tiebreak remains deterministic.
 */
export function statusChangeSequences(records = [], events = []) {
  const statuses = new Map();
  const sequences = new Map();
  const orderedEvents = [...(events ?? [])].sort((left, right) => Number(left.sequence) - Number(right.sequence));
  for (const event of orderedEvents) {
    const operation = operationOf(event);
    if (!new Set(["work.created", "work.updated", "work.annotated", "work.deleted"]).has(operation)) continue;
    const record = eventRecord(event.payload);
    const id = recordIdentity(record);
    if (id === null) continue;
    const previous = statuses.get(id);
    if ((operation === "work.created" || operation === "work.updated") &&
      typeof record.status === "string" && (previous === undefined || previous !== record.status)) {
      sequences.set(id, Number(event.sequence));
    }
    if (typeof record.status === "string") statuses.set(id, record.status);
  }
  // A fixture or a caller may supply a current record without its history.  A recorded
  // sequence is accepted only as a fallback; real production state always takes the
  // event-derived value above.
  for (const record of records ?? []) {
    const id = recordIdentity(record);
    const sequence = Number(record?.lastStatusChangeSequence);
    if (id !== null && !sequences.has(id) && Number.isSafeInteger(sequence) && sequence >= 0) sequences.set(id, sequence);
  }
  return sequences;
}

function eventContainsId(value, id) {
  if (value === id) return true;
  if (Array.isArray(value)) return value.some((entry) => eventContainsId(entry, id));
  if (value !== null && typeof value === "object") return Object.values(value).some((entry) => eventContainsId(entry, id));
  return false;
}

function eventSequenceForId(events, id) {
  return Math.max(0, ...(events ?? []).filter((event) => eventContainsId(event.payload, id)).map((event) => Number(event.sequence)).filter(Number.isSafeInteger));
}

function parentForKind(workById, record, kind) {
  let cursor = record;
  const visited = new Set();
  while (cursor?.parentId && !visited.has(cursor.parentId)) {
    visited.add(cursor.parentId);
    const parent = workById.get(cursor.parentId);
    if (!parent) return null;
    if (parent.kind === kind) return parent;
    cursor = parent;
  }
  return null;
}

function workRow(record, workById) {
  const parent = record?.parentId ? workById.get(record.parentId) : null;
  const decidedBy = extensionValue(record, "advisory:decided-by");
  const ruling = Array.isArray(decidedBy) ? decidedBy.join(",") : (typeof decidedBy === "string" ? decidedBy : "—");
  const parentLabel = parent?.externalKey ?? parent?.id ?? "—";
  const kind = record?.kind ?? "work";
  const key = record?.externalKey ?? record?.key ?? record?.id ?? "";
  const status = record?.status ?? "unknown";
  const title = record?.title ?? "";
  const summary = record?.summary ?? "";
  return boundedUtf8(`[${kind} ${key} ${status}] ${title} ${summary} · ${parentLabel} · ${ruling}`.replace(/[ \t]+/gu, " ").trim(), MAX_INJECTION_ROW_BYTES);
}

function ancestorsFor(workById, record) {
  const parents = [];
  let cursor = record;
  const visited = new Set();
  while (cursor?.parentId && !visited.has(cursor.parentId)) {
    visited.add(cursor.parentId);
    const parent = workById.get(cursor.parentId);
    if (parent === undefined) break;
    parents.push(parent);
    cursor = parent;
  }
  return parents;
}

function minutesRow(minutes, conferences) {
  if (minutes === null) return "纪要 —";
  const conference = conferences.find((entry) => entry.id === minutes.conferenceId);
  const label = minutes.externalKey ?? minutes.id ?? "";
  const title = conference?.title ?? "";
  const summary = minutes.summary ?? "";
  return boundedUtf8(`纪要 ${label} ${title} ${summary}`.replace(/[ \t]+/gu, " ").trim(), MAX_INJECTION_ROW_BYTES);
}

function latestMinutes(state) {
  const candidates = (state?.conferenceMinutes ?? []).filter((entry) => !entry.tombstone);
  if (candidates.length === 0) return null;
  // Precompute once per candidate, like compareWork()'s `sequences` map below: the
  // comparator used to call eventSequenceForId() -- a full scan of state.events -- twice
  // per comparison, so an O(n log n) sort became an O(n log n * events) scan.
  const sequences = new Map(candidates.map((entry) => [entry.id, eventSequenceForId(state.events, entry.id)]));
  return [...candidates].sort((left, right) => {
    const sequence = (sequences.get(right.id) ?? 0) - (sequences.get(left.id) ?? 0);
    return sequence !== 0 ? sequence : canonicalIdCompare(left.id, right.id);
  })[0] ?? null;
}

function compareWork(left, right, sequences) {
  const status = workStatusRank(left.status) - workStatusRank(right.status);
  if (status !== 0) return status;
  const sequence = (sequences.get(right.id) ?? 0) - (sequences.get(left.id) ?? 0);
  return sequence !== 0 ? sequence : canonicalIdCompare(left.id, right.id);
}

/**
 * Render the six-line L0 frame.  The summary is a replacement for the sixth slot, so the
 * record displaced by it is deliberately included in the omitted count.
 */
export function buildL0Injection(state, { maxLines = 6, context = null } = {}) {
  if (context !== null) return buildBoundedTaskContext(state, context, { maxLines, maxBytes: DEFAULT_PER_PROMPT_BYTES });
  const allWork = (state?.work ?? []).filter((record) => !record.tombstone);
  const workById = new Map(allWork.map((record) => [record.id, record]));
  const activeReady = allWork.filter((record) => ACTIVE_READY.has(record.status));
  const sequences = statusChangeSequences(allWork, state?.events ?? []);
  const active = activeReady.filter((record) => record.status === "active");
  const ready = activeReady.filter((record) => record.status === "ready");
  const currentPool = active.length > 0 ? active : ready;
  const orderedPool = [...activeReady].sort((left, right) => compareWork(left, right, sequences));
  const current = [...currentPool].sort((left, right) => compareWork(left, right, sequences))[0] ?? null;
  const parents = current === null ? [] : [parentForKind(workById, current, "Epic"), parentForKind(workById, current, "Initiative")].filter((record, index, values) => record !== null && values.findIndex((entry) => entry?.id === record.id) === index);
  const selected = [];
  if (current !== null) selected.push(current);
  for (const parent of parents) if (parent !== null && !selected.some((entry) => entry.id === parent.id)) selected.push(parent);
  for (const record of orderedPool) if (!selected.some((entry) => entry.id === record.id)) selected.push(record);

  const minute = latestMinutes(state);
  const prefix = minute === null ? [] : [minutesRow(minute, state?.conferences ?? [])];
  const capacity = Math.max(0, maxLines - prefix.length);
  let visible = selected.slice(0, capacity);
  const visibleActiveReady = new Set(visible.filter((record) => ACTIVE_READY.has(record.status)).map((record) => record.id));
  let omittedCount = activeReady.filter((record) => !visibleActiveReady.has(record.id)).length;
  let summary = null;
  if (omittedCount > 0 && capacity > 0) {
    // The summary occupies the last slot.  Recompute after this displacement, as the
    // displaced record may itself be active/ready.
    if (visible.length === capacity) visible = visible.slice(0, -1);
    const afterDisplacement = new Set(visible.filter((record) => ACTIVE_READY.has(record.status)).map((record) => record.id));
    omittedCount = activeReady.filter((record) => !afterDisplacement.has(record.id)).length;
    summary = `另 ${omittedCount} 条 active/ready 未注入`;
  }
  const lines = [...prefix, ...visible.map((record) => workRow(record, workById))];
  if (summary !== null) lines.push(summary);
  const ids = [
    ...(minute === null ? [] : [minute.id]),
    ...visible.map((record) => record.id),
  ];
  return {
    text: lines.slice(0, maxLines).join("\n"),
    lines: lines.slice(0, maxLines),
    ids,
    currentId: current?.id ?? null,
    latestMinutesId: minute?.id ?? null,
    statusChangeSequences: Object.fromEntries([...sequences.entries()]),
    omittedCount,
    hasSummary: summary !== null,
  };
}

export function buildBoundedCandidateContext(candidates, { maxRows = MAX_INJECTION_ROWS, maxBytes = DEFAULT_PER_PROMPT_BYTES, workById = new Map() } = {}) {
  const rows = [];
  let bytes = 0;
  for (const candidate of candidates ?? []) {
    if (rows.length >= maxRows) break;
    const row = workRow(candidate, workById);
    const separatorBytes = rows.length === 0 ? 0 : 1;
    const remaining = maxBytes - bytes - separatorBytes;
    if (remaining <= 0) break;
    const bounded = boundedUtf8(row, Math.min(MAX_INJECTION_ROW_BYTES, remaining));
    if (bounded.length === 0) break;
    rows.push(bounded);
    bytes += separatorBytes + Buffer.byteLength(bounded, "utf8");
  }
  return { text: rows.join("\n"), rows, bytes, ids: (candidates ?? []).slice(0, rows.length).map(recordIdentity).filter(Boolean) };
}

/**
 * Build the small work frame allowed for an explicitly bound dispatch.
 *
 * Main/orchestrator work gets the records carrying the same Pack plus its
 * ancestry.  A subagent gets only its own record and ancestry.  In particular,
 * this never falls back to the global active/ready ordering used by legacy L0.
 */
export function buildBoundedTaskContext(state, context, { maxLines = 6, maxBytes = DEFAULT_PER_PROMPT_BYTES } = {}) {
  if (!context?.ok || context.bound !== true) {
    return { ok: false, reasonCode: context?.reasonCode ?? "DISPATCH_CONTEXT_BINDING_MISSING", text: "", lines: [], ids: [], bytes: 0, omittedCount: 0 };
  }
  const allWork = (state?.work ?? []).filter((record) => !record.tombstone);
  const workById = new Map(allWork.map((record) => [record.id, record]));
  const target = workById.get(context.workId);
  if (target === undefined) {
    return { ok: false, reasonCode: "DISPATCH_CONTEXT_WORK_NOT_FOUND", workId: context.workId, pack: context.pack, text: "", lines: [], ids: [], bytes: 0, omittedCount: 0 };
  }
  if (!matchesDispatchContext(target, context)) {
    return { ok: false, reasonCode: "DISPATCH_CONTEXT_PACK_MISMATCH", workId: context.workId, pack: context.pack, text: "", lines: [], ids: [], bytes: 0, omittedCount: 0 };
  }
  const selected = [];
  const add = (record) => {
    if (record !== undefined && !selected.some((entry) => entry.id === record.id)) selected.push(record);
  };
  add(target);
  for (const parent of ancestorsFor(workById, target).reverse()) add(parent);
  if (context.role === "main") {
    // A Pack is a declared batch identity, not a substring query.  Only exact
    // labels/extension values are admitted, so an unrelated active item cannot
    // enter because its title happens to share a word with the task.
    for (const record of allWork) if (matchesDispatchContext(record, context)) add(record);
  }
  const bounded = buildBoundedCandidateContext(selected, { maxRows: maxLines, maxBytes, workById });
  const visibleIds = new Set(bounded.ids);
  return {
    ok: true,
    reasonCode: "DISPATCH_CONTEXT_READY",
    role: context.role,
    workId: context.workId,
    pack: context.pack,
    text: bounded.text,
    lines: bounded.rows,
    ids: bounded.ids,
    bytes: bounded.bytes,
    omittedCount: selected.filter((record) => !visibleIds.has(record.id)).length,
    recordCount: selected.length,
  };
}

function emptySession(sessionId) {
  return {
    sessionId,
    emittedIds: [],
    // `pendingIds` are generated but not acknowledged by the hook wrapper yet.
    // Keeping them separate prevents a failed wrapper parse from turning a
    // later retry into ALREADY_INJECTED_SKIPPED.
    pendingIds: [],
    deliveryAttempts: 0,
    emittedBytes: 0,
    l1Bytes: 0,
    lastL0: null,
    lastL0Ids: [],
    decisions: [],
    pullCorrelations: [],
    pulledIds: [],
    judgments: [],
    translationAttempts: 0,
  };
}

function normaliseSession(sessionId, value) {
  const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  const list = (key) => [...new Set(Array.isArray(source[key]) ? source[key].filter((entry) => typeof entry === "string") : [])];
  return {
    ...emptySession(sessionId),
    emittedIds: list("emittedIds"),
    pendingIds: list("pendingIds").filter((id) => !list("emittedIds").includes(id)),
    deliveryAttempts: Number.isSafeInteger(source.deliveryAttempts) && source.deliveryAttempts >= 0 ? source.deliveryAttempts : 0,
    emittedBytes: Number.isSafeInteger(source.emittedBytes) && source.emittedBytes >= 0 ? source.emittedBytes : 0,
    l1Bytes: Number.isSafeInteger(source.l1Bytes) && source.l1Bytes >= 0 ? source.l1Bytes : 0,
    lastL0: typeof source.lastL0 === "string" ? source.lastL0 : null,
    lastL0Ids: list("lastL0Ids"),
    decisions: Array.isArray(source.decisions) ? source.decisions.slice(-MAX_HISTORY) : [],
    pullCorrelations: Array.isArray(source.pullCorrelations) ? source.pullCorrelations.slice(-MAX_HISTORY) : [],
    pulledIds: list("pulledIds"),
    judgments: Array.isArray(source.judgments) ? source.judgments.slice(-MAX_HISTORY) : [],
    translationAttempts: Number.isSafeInteger(source.translationAttempts) && source.translationAttempts >= 0 ? source.translationAttempts : 0,
  };
}

function emptyDocument() {
  return { schemaVersion: INJECTION_SESSION_SCHEMA_VERSION, sessions: {} };
}

function readDocument(path) {
  if (!existsSync(path)) return emptyDocument();
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value?.schemaVersion !== INJECTION_SESSION_SCHEMA_VERSION || value.sessions === null || typeof value.sessions !== "object" || Array.isArray(value.sessions)) return emptyDocument();
    return value;
  } catch {
    return emptyDocument();
  }
}

function waitBriefly() {
  if (typeof Atomics?.wait !== "function") return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
}

export class InjectionSessionLease {
  #store;
  #fd;
  #document;
  #released = false;

  constructor(store, fd, document, sessionId) {
    this.#store = store;
    this.#fd = fd;
    this.#document = document;
    this.session = normaliseSession(sessionId, document.sessions[sessionId]);
    this.#document.sessions[sessionId] = this.session;
  }

  commit() {
    if (this.#released) throw new Error("session lease already released");
    this.#store.writeDocument(this.#document);
  }

  release() {
    if (this.#released) return;
    this.#released = true;
    try { closeSync(this.#fd); } catch { /* the lock is still removed below */ }
    try { unlinkSync(this.#store.lockPath); } catch { /* another cleanup cannot invalidate the state */ }
  }
}

export class InjectionSessionStore {
  constructor({ directory = DEFAULT_STATE_DIRECTORY, lockTimeoutMs = 10_000, staleLockMs = LOCK_STALE_MS } = {}) {
    this.directory = resolve(directory);
    this.statePath = join(this.directory, "state.json");
    this.lockPath = join(this.directory, "state.lock");
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
  }

  #ensureDirectory() {
    if (!isAbsolute(this.directory)) throw new Error("injection state directory must be absolute");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  #acquireLock() {
    this.#ensureDirectory();
    const started = Date.now();
    while (Date.now() - started < this.lockTimeoutMs) {
      const fd = this.#tryAcquireLock();
      if (fd !== null) return fd;
      waitBriefly();
    }
    throw new Error("INJECTION_SESSION_LOCK_TIMEOUT");
  }

  #tryAcquireLock() {
    this.#ensureDirectory();
    try {
      const fd = openSync(this.lockPath, "wx", 0o600);
      writeFileSync(this.lockPath, `${process.pid}\n`, { flag: "a" });
      return fd;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(this.lockPath).mtimeMs > this.staleLockMs) unlinkSync(this.lockPath);
      } catch { /* a contender may be replacing the lock */ }
      return null;
    }
  }

  writeDocument(document) {
    this.#ensureDirectory();
    const temporary = join(this.directory, `.state.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, this.statePath);
  }

  acquire(sessionId) {
    const id = String(sessionId ?? "").trim();
    if (id.length === 0 || id.length > 512) throw new Error("INJECTION_SESSION_ID_INVALID");
    const fd = this.#acquireLock();
    try {
      return new InjectionSessionLease(this, fd, readDocument(this.statePath), id);
    } catch (error) {
      try { closeSync(fd); } catch { /* best effort */ }
      try { unlinkSync(this.lockPath); } catch { /* best effort */ }
      throw error;
    }
  }

  async acquireAsync(sessionId) {
    const id = String(sessionId ?? "").trim();
    if (id.length === 0 || id.length > 512) throw new Error("INJECTION_SESSION_ID_INVALID");
    const started = Date.now();
    let fd = null;
    while (Date.now() - started < this.lockTimeoutMs) {
      fd = this.#tryAcquireLock();
      if (fd !== null) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_WAIT_MS));
    }
    if (fd === null) throw new Error("INJECTION_SESSION_LOCK_TIMEOUT");
    try {
      return new InjectionSessionLease(this, fd, readDocument(this.statePath), id);
    } catch (error) {
      try { closeSync(fd); } catch { /* best effort */ }
      try { unlinkSync(this.lockPath); } catch { /* best effort */ }
      throw error;
    }
  }

  readSession(sessionId) {
    return normaliseSession(String(sessionId ?? ""), readDocument(this.statePath).sessions[String(sessionId ?? "")]);
  }
}

/**
 * A wrapper calls this only after it has parsed a successful production result.
 * The state file is outside the governed control tree and is protected by the
 * same session lock as generation, so acknowledgement is atomic with respect
 * to a concurrent hook invocation.
 */
export function acknowledgeInjection(sessionId, ids, { directory = DEFAULT_STATE_DIRECTORY } = {}) {
  const requested = [...new Set((ids ?? []).filter((id) => typeof id === "string" && id.length > 0))];
  const store = new InjectionSessionStore({ directory });
  const lease = store.acquire(sessionId);
  try {
    const pending = new Set(lease.session.pendingIds);
    const acknowledged = requested.filter((id) => pending.has(id));
    for (const id of acknowledged) {
      pending.delete(id);
      if (!lease.session.emittedIds.includes(id)) lease.session.emittedIds.push(id);
    }
    lease.session.pendingIds = [...pending];
    lease.session.deliveryAttempts += 1;
    lease.commit();
    return {
      ok: true,
      reasonCode: acknowledged.length > 0 ? "INJECTION_DELIVERY_ACKNOWLEDGED" : "INJECTION_DELIVERY_ALREADY_ACKNOWLEDGED",
      acknowledgedIds: acknowledged,
      pendingIds: [...pending],
      emittedIds: [...lease.session.emittedIds],
    };
  } finally {
    lease.release();
  }
}

export function pendingInjectionIds(sessionId, { directory = DEFAULT_STATE_DIRECTORY } = {}) {
  return new InjectionSessionStore({ directory }).readSession(sessionId).pendingIds;
}

function parseJsonLines(text) {
  const source = String(text ?? "").trim();
  if (source.length === 0) return null;
  const lines = source.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* try the next line */ }
  }
  return null;
}

function isFailureResult(value) {
  if (value === null || typeof value !== "object") return false;
  if (value.isError === true || value.is_error === true || value.ok === false) return true;
  return typeof value.reasonCode === "string" && /(?:FAILED|ERROR|INVALID|REFUSED|DENIED|NOT_FOUND|TIMEOUT)/u.test(value.reasonCode);
}

function collectIds(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) collectIds(entry, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "id" || key === "recordId" || key === "knowledgeId") && typeof entry === "string") output.add(entry);
    collectIds(entry, output);
  }
  return output;
}

function structuredValue(value) {
  if (typeof value !== "string") return value;
  return parseJsonLines(value) ?? value;
}

function toolVerb(input) {
  const name = String(input?.tool_name ?? input?.toolName ?? input?.name ?? "").toLowerCase();
  const toolInput = structuredValue(input?.tool_input ?? input?.toolInput ?? input?.input ?? {});
  const declared = String(toolInput?.verb ?? toolInput?.commandName ?? name).toLowerCase();
  if (declared === "work-show" || declared === "knowledge-body") return declared;
  if (!/^(?:bash|shell|exec|command)$/u.test(name) || typeof toolInput?.command !== "string") return null;
  const command = toolInput.command;
  if (/(?:^|[\s/'"])(?:work-show)(?:[\s/'"]|$)/u.test(command)) return "work-show";
  if (/(?:^|[\s/'"])(?:knowledge-body)(?:[\s/'"]|$)/u.test(command)) return "knowledge-body";
  return null;
}

/** Only a successful structured read of an emitted id is a pull correlation. */
export function pullCorrelation(input, emittedIds, pulledIds = []) {
  const verb = toolVerb(input);
  if (verb === null) return null;
  const outputs = [input?.tool_response, input?.toolResponse, input?.tool_result, input?.toolResult, input?.result, input?.output]
    .filter((value) => value !== undefined)
    .map(structuredValue);
  if (outputs.length === 0 || outputs.some(isFailureResult)) return null;
  const emitted = new Set((emittedIds ?? []).filter((id) => typeof id === "string"));
  const pulled = new Set((pulledIds ?? []).filter((id) => typeof id === "string"));
  const id = [...outputs.flatMap((value) => [...collectIds(value)])].find((candidate) => emitted.has(candidate) && !pulled.has(candidate));
  return id === undefined ? null : { id, verb };
}

function modelOutputJudgment(text) {
  const parsed = parseJsonLines(text);
  if (typeof parsed?.judgment === "boolean") return parsed.judgment;
  const normalized = String(parsed ?? text ?? "").trim().toLowerCase();
  if (/^(?:true|yes|y|1|accept|relevant)$/u.test(normalized)) return true;
  if (/^(?:false|no|n|0|reject|irrelevant)$/u.test(normalized)) return false;
  return null;
}

async function ensureProcessGroupEmpty(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(-pid, 0);
      try { process.kill(-pid, "SIGTERM"); } catch { /* a descendant may have exited between probes */ }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  try { process.kill(-pid, "SIGKILL"); } catch { /* the group is already empty */ }
}

function modelCommand(host, model, cwd, systemPrompt) {
  const codexCliModel = model.startsWith("codex-cli:") ? model.slice("codex-cli:".length) : null;
  if (host === "codex" || codexCliModel !== null) {
    return { executable: "codex", arguments: ["exec", "-C", cwd, "-m", codexCliModel ?? model, "-s", "read-only", "--ephemeral", "--skip-git-repo-check"], cwd, systemPrompt };
  }
  return { executable: "claude", arguments: ["-p", "--bare", "--model", model, "--system-prompt", systemPrompt], cwd, systemPrompt };
}

/**
 * One model call with no host/project context.  Translation and judging instantiate
 * independent instances, so each has its own one-call allowance and timeout.
 */
export class UninjectedModelCall {
  constructor({ host = "claude", model, cwd, systemPrompt = "Return only the requested answer.", timeoutMs = 10_000, spawnImpl = spawn } = {}) {
    this.host = host === "codex" ? "codex" : "claude";
    this.model = typeof model === "string" && model.length > 0 ? model : null;
    this.cwd = cwd ?? null;
    this.systemPrompt = systemPrompt;
    this.timeoutMs = timeoutMs;
    this.spawnImpl = spawnImpl;
    this.used = false;
  }

  async call(prompt) {
    if (this.used) return { ok: false, reasonCode: "UNINJECTED_MODEL_CALL_LIMIT", model: this.model };
    this.used = true;
    if (this.model === null || typeof this.cwd !== "string" || this.cwd.length === 0) return { ok: false, reasonCode: "UNINJECTED_MODEL_UNAVAILABLE", model: this.model };
    const command = modelCommand(this.host, this.model, this.cwd, this.systemPrompt);
    const cleanEnvironment = { ...process.env };
    for (const key of ["CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "TCRN_INJECTION_STATE_DIR"]) delete cleanEnvironment[key];
    let child;
    try {
      child = this.spawnImpl(command.executable, command.arguments, {
        cwd: command.cwd,
        detached: true,
        env: cleanEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return { ok: false, reasonCode: "UNINJECTED_MODEL_SPAWN_FAILED", model: this.model, error: String(error?.message ?? error) };
    }
    let stdout = "";
    let stderr = "";
    if (child.stdout?.on) child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    if (child.stderr?.on) child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const closed = new Promise((resolveClose) => {
      child.once?.("error", (error) => resolveClose({ code: null, error }));
      child.once?.("close", (code, signal) => resolveClose({ code, signal }));
    });
    // codex exec's argv has no system-prompt flag (unlike claude's --system-prompt above),
    // so its stdin body carries the instruction; claude's stdin stays the bare prompt.
    const stdinBody = command.executable === "codex" ? `${command.systemPrompt}\n\n${String(prompt ?? "")}` : String(prompt ?? "");
    try { child.stdin?.end(stdinBody); } catch { /* a dead model is fail-open */ }
    let timer;
    const timeout = new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ timeout: true }), this.timeoutMs);
    });
    const result = await Promise.race([closed, timeout]);
    clearTimeout(timer);
    if (result?.timeout === true) {
      if (Number.isSafeInteger(child.pid) && child.pid > 0 && child.pid !== process.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* group may already be gone */ }
      }
      try { child.kill?.("SIGTERM"); } catch { /* best effort */ }
      await Promise.race([closed, new Promise((resolveClose) => setTimeout(resolveClose, 250))]);
      if (Number.isSafeInteger(child.pid) && child.pid > 0 && child.pid !== process.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* group may already be gone */ }
      }
      await ensureProcessGroupEmpty(child.pid);
      return { ok: false, reasonCode: "UNINJECTED_MODEL_TIMEOUT", model: this.model, timedOut: true };
    }
    await ensureProcessGroupEmpty(child.pid);
    if (result?.code !== 0) return { ok: false, reasonCode: "UNINJECTED_MODEL_FAILED", model: this.model, error: stderr.slice(-200) };
    return { ok: true, model: this.model, text: stdout.trim() };
  }

  async translatePrompt(prompt) {
    const answer = await this.call(prompt);
    return answer.ok ? { text: answer.text, model: answer.model } : { text: null, model: this.model, reasonCode: answer.reasonCode };
  }

  async observeCandidates(prompt, candidates) {
    const answer = await this.call(`${prompt}\n\nCandidates:\n${(candidates ?? []).join("\n")}`);
    return answer.ok ? { judgment: modelOutputJudgment(answer.text), model: answer.model } : { judgment: null, model: this.model, reasonCode: answer.reasonCode };
  }
}

export function temporaryEmptyDirectory() {
  return mkdtempSync(join(tmpdir(), "tcrn-uninjected-"));
}

export function removeTemporaryDirectory(path) {
  if (typeof path === "string" && path.length > 0) rmSync(path, { recursive: true, force: true });
}

export function promptDigest(prompt) {
  return sha256(prompt);
}
