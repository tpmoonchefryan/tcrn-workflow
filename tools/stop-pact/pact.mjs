// SPDX-License-Identifier: Apache-2.0
// The run contract: storage, schema, and lifecycle (TCRN-CROSS-STORY-116).
//
// A pact exists only while a run-to-completion authorization is live. Its file is
// the authorization made concrete; its `status` is the migration state a stop must
// pass through. Everything that transforms a pact is a pure builder here; the only
// IO is read/write of one JSON file, deliberately thin so the interesting logic is
// testable without a filesystem.
//
// Location: a single user-level file, because the hook that reads it is user-level
// and fires in every session. One active pact at a time, bound by session id to
// exactly one run — a design limit stated plainly in the schema doc, not a bug.

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PACT_SCHEMA_VERSION = "tcrn.stop-pact.v1";
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_MAX_CONSECUTIVE_BLOCKS = 3;
export const PACT_STATUSES = Object.freeze(["running", "completed", "blocked", "owner_directive"]);

// The pact path is fixed at the user level to match the user-level hook, but is
// overridable by env so the tests never touch the real file and so an operator can
// relocate it. Resolution is a function, not a constant, so a test setting the env
// per-case is honoured.
export function pactPath() {
  const override = process.env.TCRN_STOP_PACT_PATH;
  if (typeof override === "string" && override.length > 0) return override;
  return join(homedir(), ".claude", "stop-pact", "current.json");
}

// --- pure builders (no clock, no IO) ---

// Scope is capped so a huge value cannot bloat the block reason that is fed back to
// the model on every block (review finding on the stdout path).
export const MAX_SCOPE_BYTES = 8192;

export function buildPact({ scope, authorizedBy, now, ttlMs = DEFAULT_TTL_MS, maxConsecutiveBlocks = DEFAULT_MAX_CONSECUTIVE_BLOCKS, boundSession = null }) {
  const createdMs = Date.parse(now);
  if (Number.isNaN(createdMs)) throw new Error("buildPact: `now` must be an ISO-8601 instant");
  if (typeof scope !== "string" || scope.length === 0) throw new Error("buildPact: scope is required");
  if (Buffer.byteLength(scope, "utf8") > MAX_SCOPE_BYTES) throw new Error(`buildPact: scope exceeds ${MAX_SCOPE_BYTES} bytes`);
  if (typeof authorizedBy !== "string" || authorizedBy.length === 0) throw new Error("buildPact: authorizedBy is required");
  return {
    schemaVersion: PACT_SCHEMA_VERSION,
    active: true,
    status: "running",
    scope,
    authorizedBy,
    boundSession,
    maxConsecutiveBlocks,
    createdAt: new Date(createdMs).toISOString(),
    expiresAt: new Date(createdMs + ttlMs).toISOString(),
    ticket: null,
    runtime: { consecutiveBlocks: 0, lastBlockToolUses: null },
    history: [{ at: new Date(createdMs).toISOString(), event: "started", detail: authorizedBy }],
  };
}

// A migration is additive to history and never edits a prior entry — the same
// append-only discipline the governance chain uses, so "what happened to this run"
// is legible after the fact rather than overwritten.
export function migratePact(pact, { status, now, detail = "", ticket = null }) {
  if (!PACT_STATUSES.includes(status)) throw new Error(`migratePact: unknown status ${status}`);
  const atMs = Date.parse(now);
  if (Number.isNaN(atMs)) throw new Error("migratePact: `now` must be an ISO-8601 instant");
  const at = new Date(atMs).toISOString();
  return {
    ...pact,
    status,
    // A terminal migration deactivates enforcement; only "running" keeps it live.
    active: status === "running",
    ticket: status === "blocked" ? ticket : pact.ticket,
    history: [...(pact.history ?? []), { at, event: status, detail }],
  };
}

export function withRuntime(pact, { consecutiveBlocks, lastBlockToolUses, boundSession }) {
  const next = { ...pact, runtime: { ...pact.runtime } };
  if (consecutiveBlocks !== undefined) next.runtime.consecutiveBlocks = consecutiveBlocks;
  if (lastBlockToolUses !== undefined) next.runtime.lastBlockToolUses = lastBlockToolUses;
  if (boundSession !== undefined && boundSession !== null) next.boundSession = boundSession;
  return next;
}

// A pact whose shape we do not recognize is treated as ABSENT rather than trusted:
// the decider's first branch (no active pact → allow) is the safe destination for a
// malformed file, so a corrupted pact can never trap a session — it can only fail to
// govern one, which is the correct direction to fail for a mechanism that must never
// make an ordinary session un-stoppable.
export function isWellFormedPact(value) {
  if (value === null || typeof value !== "object") return false;
  if (value.schemaVersion !== PACT_SCHEMA_VERSION) return false;
  if (typeof value.active !== "boolean") return false;
  // Status must be a non-empty string, but is NOT gated on the known enum here: a
  // well-formed envelope carrying an UNRECOGNIZED status must reach the decider so it
  // can be surfaced loudly (STATUS_UNKNOWN) rather than silently treated as absent.
  // A review finding showed the old enum gate made the STATUS_UNKNOWN branch — and its
  // "shouts" test — dead: readPact returned null and the corruption passed unnoticed.
  if (typeof value.status !== "string" || value.status.length === 0) return false;
  if (value.runtime === null || typeof value.runtime !== "object") return false;
  // The counter must be a non-negative integer. A non-numeric value (a review finding
  // used "x") otherwise passes, then NaN>=cap is false forever and "x"+1 concatenates,
  // trapping the session. Rejecting it here fails the pact toward ABSENT (=> allow),
  // the safe direction.
  if (!Number.isInteger(value.runtime.consecutiveBlocks) || value.runtime.consecutiveBlocks < 0) return false;
  return true;
}

// --- thin IO ---

export function readPact(path = pactPath()) {
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return isWellFormedPact(parsed) ? parsed : null;
}

export function writePact(pact, path = pactPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pact, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path); // atomic replace so a concurrent reader never sees a half-written pact
}
