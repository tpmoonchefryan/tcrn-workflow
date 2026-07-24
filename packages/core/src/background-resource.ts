// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalJson,
  assertStrictInstant,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  ProtocolError,
} from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";

// INIT-007 / S040+S041: background-resource residue governance, host-neutral.
//
// A governed agent session that spawns a background load (a CPU stress loop, a
// dev server, a headless browser) owns that load for the session's lifetime and
// must reclaim it at teardown. When it does not — a detached child outlives the
// subshell that led its process group and reparents to init — the load becomes an
// orphan that burns the host silently. This module is the machine-checkable half
// of the convention: a registration face (record the process GROUP a session owns)
// and a detection face (given a registration set and a process-table snapshot,
// report which owned groups still have live members, or which orphans match a
// registered command pattern). Both are PURE — no `ps`, no `fs`, no `Date`, no
// randomness — so they are deterministic and unit-testable against fixtures; the
// process-table read, the clock, and the file I/O are the host adapter's job
// (see scripts/spawn-guard.mjs). Registering the process GROUP id rather than a
// child pid is the reaper's lesson (scripts/test-controller-reaper.mjs): pids are
// reused and orphans outlive their leader, but the pgid is the stable handle and
// the whole group is discovered live from the kernel every scan.

export const BACKGROUND_RESOURCE_REGISTRATION_VERSION = "tcrn.background-resource-registration.v1" as const;
export const BACKGROUND_RESOURCE_RESIDUE_VERSION = "tcrn.background-resource-residue.v1" as const;

export const BACKGROUND_RESOURCE_LIMITS = Object.freeze({
  maximumRegistrations: 256,
  maximumProcessRows: 65_536,
  // The registry is small (bounded by maximumRegistrations); a live process
  // table on a busy CI/container host is not, so it gets its own bound sized to
  // the host adapter's ps read buffer rather than an arbitrarily tighter cap
  // that would make the detector break exactly when the host is loaded.
  maximumTextBytes: 262_144,
  maximumProcessTableBytes: 16 * 1024 * 1024,
});

// New frozen reason-code list, sorted, owned by this module. It is additive: no
// existing reason-code list is edited (the residue capability never touches the
// event chain or the engine).
export const BACKGROUND_RESOURCE_REASON_CODES = Object.freeze([
  "BACKGROUND_RESOURCE_INPUT_INVALID",
  "BACKGROUND_RESOURCE_LIMIT_EXCEEDED",
  "BACKGROUND_RESOURCE_REGISTRATION_INVALID",
] as const);

export type BackgroundResourceReasonCode = typeof BACKGROUND_RESOURCE_REASON_CODES[number];

export class BackgroundResourceError extends Error {
  readonly reasonCode: BackgroundResourceReasonCode;

  constructor(reasonCode: BackgroundResourceReasonCode, message: string) {
    super(message);
    this.name = "BackgroundResourceError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: BackgroundResourceReasonCode, message: string): never {
  throw new BackgroundResourceError(reasonCode, message);
}

// The reason a live process is judged residue at session teardown.
export type ResidueReason = "orphaned-pattern-match" | "registered-group-alive";
export type ResidueStatus = "clean" | "residue-present";

// A background load a session declares it owns. pgid is the stable handle; pattern
// is a command substring used to attribute reparented orphans whose group leader
// has already exited; purpose records why it was spawned so a residue report reads.
export interface SpawnRegistration {
  readonly pgid: number;
  readonly pattern: string;
  readonly purpose: string;
  readonly spawnedAt: string;
}

// One row of a process-table snapshot (a parsed `ps` line). cpu is carried as the
// raw `ps` text, not a number: canonical JSON admits only safe integers, and a
// %cpu reading is a float — keeping the exact string preserves the evidence (a
// burning orphan's load) without a lossy round-trip through a rejected number.
export interface ProcessRow {
  readonly pid: number;
  readonly pgid: number;
  readonly ppid: number;
  readonly cpu: string;
  readonly command: string;
}

export interface ResidueEntry {
  readonly pid: number;
  readonly pgid: number;
  readonly ppid: number;
  readonly cpu: string;
  readonly command: string;
  readonly reason: ResidueReason;
  readonly purpose: string;
}

export interface ResidueReport {
  readonly schemaVersion: typeof BACKGROUND_RESOURCE_RESIDUE_VERSION;
  readonly detectedAt: string;
  readonly status: ResidueStatus;
  readonly registeredGroups: number;
  readonly scannedProcesses: number;
  readonly residueCount: number;
  readonly residue: readonly ResidueEntry[];
  readonly reportDigest: string;
}

function isJsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertBoundedText(text: unknown, label: string): string {
  if (typeof text !== "string") fail("BACKGROUND_RESOURCE_INPUT_INVALID", `${label} must be a string`);
  if (Buffer.byteLength(text, "utf8") > BACKGROUND_RESOURCE_LIMITS.maximumTextBytes) {
    fail("BACKGROUND_RESOURCE_LIMIT_EXCEEDED", `${label} exceeds ${BACKGROUND_RESOURCE_LIMITS.maximumTextBytes} bytes`);
  }
  return text;
}

function assertProcessId(value: JsonValue | undefined, label: string): number {
  // A pid/pgid/ppid is a positive safe integer; ppid may be 1 (reparented to init),
  // never 0 or negative. A registration pgid must be a real group, so >= 1.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail("BACKGROUND_RESOURCE_REGISTRATION_INVALID", `${label} must be a positive integer`);
  }
  return value;
}

function assertSafeCount(value: number, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("BACKGROUND_RESOURCE_INPUT_INVALID", `${label} out of range`);
  }
  return value;
}

// Validate a process row fail-closed BEFORE it can reach canonical serialization.
// The parse boundary must be at least as strict as the registration boundary: an
// out-of-safe-range pid or an ill-formed command would otherwise pass parsing and
// throw a foreign ProtocolError out of the deep canonicalSha256 call rather than a
// typed BackgroundResourceError. pid/pgid are real ids (>= 1); ppid may be 0 (a
// kernel-owned process) or 1 (reparented to init).
function assertProcessRow(row: ProcessRow): void {
  assertSafeCount(row.pid, 1, "pid");
  assertSafeCount(row.pgid, 1, "pgid");
  assertSafeCount(row.ppid, 0, "ppid");
  if (typeof row.command !== "string" || !row.command.isWellFormed()) {
    fail("BACKGROUND_RESOURCE_INPUT_INVALID", "command is not well-formed UTF-8");
  }
}

// ---- Registration face (S041): transient JSONL, one canonical object per line. ----

// Emit one JSONL line for a registration. canonicalJson already appends exactly one
// terminal LF, so its output IS a well-formed JSONL line (sorted keys, no spaces).
export function buildRegistrationLine(registration: SpawnRegistration): string {
  assertStrictInstant(registration.spawnedAt);
  const pgid = assertProcessId(registration.pgid, "pgid");
  const pattern = assertBoundedText(registration.pattern, "pattern");
  const purpose = assertBoundedText(registration.purpose, "purpose");
  if (pattern.length === 0) fail("BACKGROUND_RESOURCE_REGISTRATION_INVALID", "pattern must be non-empty");
  return canonicalJson({
    schemaVersion: BACKGROUND_RESOURCE_REGISTRATION_VERSION,
    pgid,
    pattern,
    purpose,
    spawnedAt: registration.spawnedAt,
  });
}

// Parse one JSONL line back to a registration. Rejects non-canonical bytes and any
// unexpected shape fail-closed, so a hand-edited or corrupt registry cannot smuggle
// a malformed record past detection.
export function parseRegistrationLine(line: string): SpawnRegistration {
  const text = assertBoundedText(line, "registration line");
  let document: JsonValue;
  try {
    document = assertCanonicalJson(text.endsWith("\n") ? text : `${text}\n`);
  } catch (error) {
    if (error instanceof ProtocolError) fail("BACKGROUND_RESOURCE_REGISTRATION_INVALID", error.message);
    throw error;
  }
  if (!isJsonObject(document) || document.schemaVersion !== BACKGROUND_RESOURCE_REGISTRATION_VERSION) {
    fail("BACKGROUND_RESOURCE_REGISTRATION_INVALID", "unexpected registration shape");
  }
  const keys = Object.keys(document).sort(compareCanonicalText);
  const expected = ["pattern", "pgid", "purpose", "schemaVersion", "spawnedAt"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail("BACKGROUND_RESOURCE_REGISTRATION_INVALID", "registration fields must be exactly the v1 set");
  }
  const pattern = assertBoundedText(document.pattern, "pattern");
  if (pattern.length === 0) fail("BACKGROUND_RESOURCE_REGISTRATION_INVALID", "pattern must be non-empty");
  assertStrictInstant(document.spawnedAt);
  return {
    pgid: assertProcessId(document.pgid, "pgid"),
    pattern,
    purpose: assertBoundedText(document.purpose, "purpose"),
    spawnedAt: document.spawnedAt as string,
  };
}

// Parse a whole registry file (the transient JSONL). Blank lines are skipped; any
// malformed line fails the whole parse — a registry that cannot be read in full is
// not a registry we can trust to bound detection.
export function parseRegistry(text: string): readonly SpawnRegistration[] {
  assertBoundedText(text, "registry");
  const registrations: SpawnRegistration[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    registrations.push(parseRegistrationLine(line));
    if (registrations.length > BACKGROUND_RESOURCE_LIMITS.maximumRegistrations) {
      fail("BACKGROUND_RESOURCE_LIMIT_EXCEEDED", "registry exceeds registration limit");
    }
  }
  return registrations;
}

// ---- Detection face (S040): pure, deterministic residue predicate. ----

// Parse `ps -axo pid=,pgid=,ppid=,%cpu=,command=` output. The four leading columns
// are numeric; command is free-form and may contain spaces, so it is the remainder
// of the line. Any line that does not match the shape fails the whole parse — the
// same fail-closed stance the reaper takes (scripts/test-controller-reaper.mjs:37),
// so a truncated or reformatted process table cannot silently drop an orphan.
const PROCESS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(.*\S)\s*$/u;

export function parseProcessTable(text: string): readonly ProcessRow[] {
  if (typeof text !== "string") fail("BACKGROUND_RESOURCE_INPUT_INVALID", "process table must be a string");
  if (Buffer.byteLength(text, "utf8") > BACKGROUND_RESOURCE_LIMITS.maximumProcessTableBytes) {
    fail("BACKGROUND_RESOURCE_LIMIT_EXCEEDED", "process table exceeds byte limit");
  }
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = PROCESS_ROW.exec(line);
    if (match === null) fail("BACKGROUND_RESOURCE_INPUT_INVALID", "unparsable process-table row");
    const [, pidText, pgidText, ppidText, cpuText, command] = match;
    if (pidText === undefined || pgidText === undefined || ppidText === undefined ||
      cpuText === undefined || command === undefined) {
      fail("BACKGROUND_RESOURCE_INPUT_INVALID", "process-table row missing a field");
    }
    const row: ProcessRow = {
      pid: Number(pidText),
      pgid: Number(pgidText),
      ppid: Number(ppidText),
      cpu: cpuText,
      command,
    };
    assertProcessRow(row);
    rows.push(row);
    if (rows.length > BACKGROUND_RESOURCE_LIMITS.maximumProcessRows) {
      fail("BACKGROUND_RESOURCE_LIMIT_EXCEEDED", "process table exceeds row limit");
    }
  }
  return rows;
}

// The core predicate. Given the loads a session declared it owns and a live
// process-table snapshot taken at teardown, a process row is residue iff either:
//   (1) its pgid is a registered group that still has a live member — the session
//       owned that group and did not reclaim it. This is the RELIABLE path, and it
//       survives reparenting because a process's pgid does not change when its
//       parent dies. It is the exact shape of the 2026-07-24 incident (35 `yes`
//       orphans in five process groups whose bash leaders had exited). OR
//   (2) it is orphaned — reparented to init (ppid === 1) OR its parent is no longer
//       present in the snapshot — and its command matches a registered pattern. This
//       is the best-effort backstop for when the group leader has exited and the
//       pgid we can see is not the one that was registered. It is a fail-safe net,
//       not the primary detector.
// Known limit of case (2): on a host with a live intermediate subreaper
// (Linux `PR_SET_CHILD_SUBREAPER`, e.g. `systemd --user`), an orphan reparents to
// that subreaper — a live pid still in the snapshot — so neither `ppid === 1` nor
// "parent absent" fires. Likewise a load that calls `setsid` after registration
// moves to a new pgid. In both cases the reliable path is to register the load's
// actual (current) pgid; the pattern backstop only promises init-reparented and
// parent-absent orphans. Case (1) is checked first, so a row that is both a
// live-group member and an orphan is attributed to the group it was registered under.
export function detectResidue(
  registrations: readonly SpawnRegistration[],
  rows: readonly ProcessRow[],
  detectedAt: string,
): ResidueReport {
  assertStrictInstant(detectedAt);
  if (registrations.length > BACKGROUND_RESOURCE_LIMITS.maximumRegistrations) {
    fail("BACKGROUND_RESOURCE_LIMIT_EXCEEDED", "too many registrations");
  }
  if (rows.length > BACKGROUND_RESOURCE_LIMITS.maximumProcessRows) {
    fail("BACKGROUND_RESOURCE_LIMIT_EXCEEDED", "too many process rows");
  }
  for (const row of rows) assertProcessRow(row);
  const groupPurpose = new Map<number, string>();
  for (const registration of registrations) {
    assertProcessId(registration.pgid, "pgid");
    if (registration.pattern.length === 0) fail("BACKGROUND_RESOURCE_REGISTRATION_INVALID", "empty pattern");
    // A duplicate pgid keeps the first-registered purpose; order is caller-stable.
    if (!groupPurpose.has(registration.pgid)) groupPurpose.set(registration.pgid, registration.purpose);
  }
  const livePids = new Set(rows.map((row) => row.pid));
  const residue: ResidueEntry[] = [];
  for (const row of rows) {
    if (groupPurpose.has(row.pgid)) {
      residue.push({ ...row, reason: "registered-group-alive", purpose: groupPurpose.get(row.pgid) ?? "" });
      continue;
    }
    const orphaned = row.ppid === 1 || !livePids.has(row.ppid);
    if (orphaned) {
      const matched = registrations.find((registration) => row.command.includes(registration.pattern));
      if (matched !== undefined) {
        residue.push({ ...row, reason: "orphaned-pattern-match", purpose: matched.purpose });
      }
    }
  }
  // Deterministic total order (pid, then pgid, then command) so two runs over
  // byte-identical input produce a byte-identical report even if a caller ever
  // hands in two rows sharing a pid — the sort never relies on input order.
  residue.sort((left, right) =>
    left.pid - right.pid || left.pgid - right.pgid || compareCanonicalText(left.command, right.command));
  const status: ResidueStatus = residue.length === 0 ? "clean" : "residue-present";
  const body = {
    schemaVersion: BACKGROUND_RESOURCE_RESIDUE_VERSION,
    detectedAt,
    status,
    registeredGroups: groupPurpose.size,
    scannedProcesses: rows.length,
    residueCount: residue.length,
    residue,
  };
  return { ...body, reportDigest: canonicalSha256(body) };
}

// Serialize a residue report as the canonical JSON receipt the host adapter prints.
export function buildResidueReport(report: ResidueReport): string {
  return canonicalJson(report as unknown as JsonValue);
}
