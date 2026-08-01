#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The stop-pact operator commands (TCRN-CROSS-STORY-118): start, complete, block,
// cancel, status. Stopping a run is a state migration, not a free action — the same
// discipline the governance chain puts on a work item that cannot jump straight to
// done. `start` is the only command that creates a pact; the other three migrate it;
// `status` reads it.
//
// `block` must name one of exactly three ticket classes — verbatim the standing
// stop-budget ruling (owner_intent_required | external_release | hard_blockage). A
// stop with no ticket and no completion is precisely the event the hook holds.

import { buildPact, migratePact, readPact, writePact, pactPath } from "./pact.mjs";
import { STOP_TICKET_CLASSES } from "./decide.mjs";
import { notify } from "./notify.mjs";

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { flags[key] = true; } else { flags[key] = next; i += 1; }
  }
  return flags;
}

function out(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function fail(code, detail) { out({ ok: false, reasonCode: code, detail: detail ?? null }); process.exit(1); }

function nowIso() { return new Date().toISOString(); }

function cmdStart(flags) {
  const existing = readPact();
  if (existing && existing.active === true && !flags.force) {
    return fail("PACT_ALREADY_ACTIVE", "an active pact exists; migrate it (complete/block/cancel) or pass --force to replace");
  }
  if (typeof flags.scope !== "string") return fail("SCOPE_REQUIRED", "--scope is required");
  if (typeof flags["authorized-by"] !== "string") return fail("AUTHORIZED_BY_REQUIRED", "--authorized-by is required");
  const ttlHours = flags["ttl-hours"] !== undefined ? Number(flags["ttl-hours"]) : 24;
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) return fail("TTL_INVALID", "--ttl-hours must be a positive number");
  const maxBlocks = flags["max-blocks"] !== undefined ? Number(flags["max-blocks"]) : undefined;
  if (maxBlocks !== undefined && (!Number.isInteger(maxBlocks) || maxBlocks <= 0)) return fail("MAX_BLOCKS_INVALID", "--max-blocks must be a positive integer");
  let pact;
  try {
    pact = buildPact({
      scope: flags.scope,
      authorizedBy: flags["authorized-by"],
      now: nowIso(),
      ttlMs: Math.round(ttlHours * 60 * 60 * 1000),
      ...(maxBlocks !== undefined ? { maxConsecutiveBlocks: maxBlocks } : {}),
      boundSession: typeof flags.session === "string" ? flags.session : null,
    });
  } catch (error) {
    return fail("PACT_INVALID", error.message);
  }
  writePact(pact);
  out({ ok: true, reasonCode: "PACT_STARTED", path: pactPath(), status: pact.status, expiresAt: pact.expiresAt, boundSession: pact.boundSession });
}

function migrate(status, detail, ticket) {
  const pact = readPact();
  if (!pact) return fail("NO_PACT", "no pact to migrate");
  if (pact.active !== true && status !== "running") {
    return fail("PACT_NOT_ACTIVE", `pact is already ${pact.status}; nothing to migrate`);
  }
  const next = migratePact(pact, { status, now: nowIso(), detail, ticket });
  writePact(next);
  // Notify HERE, at the migration, because the terminal pact is now inactive and the
  // Stop hook's fast path will exit before it could notify (review finding): the CLI
  // is the only place a legitimate stop is observed with the process still alive.
  const label = status === "blocked" && ticket?.class ? `blocked (${ticket.class})` : status.replace(/_/gu, " ");
  notify("info", `TCRN stop-pact: run ${label}. Stopping is now allowed.`);
  out({ ok: true, reasonCode: `PACT_${status.toUpperCase()}`, status: next.status, active: next.active });
}

function cmdBlock(flags) {
  const ticketClass = flags.ticket;
  if (!STOP_TICKET_CLASSES.includes(ticketClass)) {
    return fail("TICKET_CLASS_INVALID", `--ticket must be one of ${STOP_TICKET_CLASSES.join(" | ")}`);
  }
  if (typeof flags.reason !== "string" || flags.reason.length === 0) {
    return fail("REASON_REQUIRED", "--reason is required so a blocked run says why");
  }
  migrate("blocked", flags.reason, { class: ticketClass, reason: flags.reason });
}

function cmdStatus() {
  const pact = readPact();
  if (!pact) { out({ ok: true, reasonCode: "NO_PACT", pact: null }); return; }
  out({ ok: true, reasonCode: "PACT_READ", pact });
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (command) {
    case "start": return cmdStart(flags);
    case "complete": return migrate("completed", typeof flags.detail === "string" ? flags.detail : "run completed");
    case "block": return cmdBlock(flags);
    case "cancel": return migrate("owner_directive", typeof flags.detail === "string" ? flags.detail : "owner called the run off");
    case "status": return cmdStatus();
    default:
      return fail("UNKNOWN_COMMAND", `commands: start | complete | block | cancel | status`);
  }
}

main();
