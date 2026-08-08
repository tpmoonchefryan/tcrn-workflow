// SPDX-License-Identifier: Apache-2.0
// The stop-pact decider (TCRN-CROSS-STORY-117): a pure function from a run
// contract plus one Stop-hook firing to a verdict. It performs no IO, reads no
// clock, and touches no host — every fact it needs is an argument, and every
// consequence it wants is data in its return value. The hook layer (hook.mjs)
// is the only impure part; it reads the pact, resolves the model, computes the
// transcript delta, calls this, then applies the effects.
//
// Why pure, stated plainly: the conditions this gate turns on hold in worlds
// this process is never in — another session's stop, an expired contract, a
// model that isn't the one running now. A gate whose predicate can only be
// exercised in the one world the author happens to be standing in is the gate
// that shipped green for a month on this platform and turned out never to have
// been satisfiable in the world that mattered. So the decider takes every world
// as an argument and the test suite drives all of them.
//
// The verdict vocabulary is frozen and every code is reachable from some input;
// tools/stop-pact/stop-pact.test.mjs proves each one fires and — the harder
// direction — that `block` and `allow` are BOTH reachable, so the gate can
// actually go either way rather than being an elaborate constant.

export const DECISION_CODES = Object.freeze([
  "NO_ACTIVE_PACT", // no contract, or contract inactive → day-to-day sessions are untouched
  "OTHER_SESSION", // contract is bound to a different session → parallel runs untouched
  "PACT_EXPIRED", // past expiresAt → lifted, not haunting a later session
  "STATUS_COMPLETED", // the run declared itself done → a legitimate stop
  "STATUS_BLOCKED", // the run declared a hard blockage with a ticket → a legitimate stop
  "STATUS_OWNER_DIRECTIVE", // the owner called it off → a legitimate stop
  "STATUS_UNKNOWN", // a status the schema does not define → fail OPEN, never trap on a bad pact
  "STOP_HOOK_ACTIVE", // host loop guard says this is a continuation firing, never block again
  "OBSERVE_WOULD_BLOCK", // running + observe mode → surfaced, never blocked (the flagship dial)
  "ESCALATION_RELEASE", // enforce, but N consecutive no-progress blocks → released so a stuck loop cannot burn forever
  "BLOCK_RUNNING", // enforce + running + no migration → the stop is premature; continue
]);

// The three ticket classes a `block` migration must name — verbatim the standing
// stop-budget ruling (2026-07-21): the only legitimate reasons to stop mid-run.
export const STOP_TICKET_CLASSES = Object.freeze([
  "owner_intent_required",
  "external_release",
  "hard_blockage",
]);

const TERMINAL_STATUSES = Object.freeze({
  completed: "STATUS_COMPLETED",
  blocked: "STATUS_BLOCKED",
  owner_directive: "STATUS_OWNER_DIRECTIVE",
});

function epochMs(value) {
  // Accepts a number (already ms) or an ISO-8601 string. Returns NaN for anything
  // unparseable, which the caller must treat as "cannot reason about time" rather
  // than as a moment — see the expiry branch, which fails toward NOT expiring so a
  // malformed timestamp never silently lifts a live pact.
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function verdict(action, code, { message = "", notify = null, effects = {} } = {}) {
  return {
    action,
    code,
    message,
    notify,
    effects: {
      bindSession: null,
      setConsecutiveBlocks: 0,
      deactivate: false,
      recordBlockOffset: false,
      ...effects,
    },
  };
}

/**
 * @param {object} input
 * @param {object|null} input.pact          parsed contract, or null if none exists
 * @param {number|string} input.now         current instant (ms epoch or ISO); injected, never read here
 * @param {string} input.sessionId          the firing session's id (from hook stdin)
 * @param {boolean} [input.stopHookActive]  host loop-guard flag (recorded, not authoritative — see below)
 * @param {"enforce"|"observe"} input.mode  enforcement strength, already resolved from the current model
 * @param {boolean} input.workedSinceLastBlock  did substantive work happen since the last block for this session?
 * @param {number} input.consecutiveBlocks  no-progress blocks so far this session (from pact.runtime)
 */
export function decide(input) {
  const {
    pact,
    now,
    sessionId,
    mode,
    workedSinceLastBlock,
    consecutiveBlocks,
  } = input;

  // 1. No governing contract → allow. This is the branch that keeps every
  //    ordinary session, and every flagship run nobody put under a pact,
  //    completely unaffected. It is deliberately first and deliberately total.
  if (!pact || pact.active !== true) {
    return verdict("allow", "NO_ACTIVE_PACT");
  }

  // 2. Bound to a different session → allow, and do not touch that session's
  //    counter. A user-level hook fires in every session; only the one the
  //    contract is bound to is governed. A parallel run is none of our business.
  if (typeof pact.boundSession === "string" && pact.boundSession.length > 0 && pact.boundSession !== sessionId) {
    return verdict("allow", "OTHER_SESSION");
  }

  // This firing either owns the pact already or is the first to arrive; if the
  // latter, the effect below claims it. Binding is an effect, not a mutation here.
  const bindSession = pact.boundSession ? null : sessionId;

  // 3. Expired → allow, mark inactive, notify. A timestamp we cannot parse fails
  //    toward NOT expired: a malformed expiresAt must never be the thing that
  //    quietly lifts an active pact.
  const nowMs = epochMs(now);
  const expiresMs = epochMs(pact.expiresAt);
  if (!Number.isNaN(nowMs) && !Number.isNaN(expiresMs) && nowMs >= expiresMs) {
    return verdict("allow", "PACT_EXPIRED", {
      message: "run pact expired; enforcement lifted",
      notify: { level: "info", message: "TCRN stop-pact expired and was lifted. A stop here is no longer governed." },
      effects: { deactivate: true, setConsecutiveBlocks: 0 },
    });
  }

  // 4. The run declared an outcome → a legitimate stop. This is the whole point
  //    of "stopping is a migration, not a free action": once the run says done /
  //    blocked / called-off, stopping is allowed and the user is told.
  const terminalCode = TERMINAL_STATUSES[pact.status];
  if (terminalCode) {
    const label = pact.status === "blocked" && pact.ticket?.class
      ? `blocked (${pact.ticket.class})`
      : pact.status.replace(/_/gu, " ");
    return verdict("allow", terminalCode, {
      message: `run pact ${label}`,
      notify: { level: "info", message: `TCRN stop-pact: run ended as "${label}". Stop allowed.` },
      effects: { bindSession, setConsecutiveBlocks: 0 },
    });
  }

  // 5. Any status other than "running" that isn't a known terminal → fail OPEN.
  //    A pact in a shape we don't understand must not trap a session forever;
  //    it allows the stop and shouts so the malformed contract gets noticed.
  if (pact.status !== "running") {
    return verdict("allow", "STATUS_UNKNOWN", {
      message: `run pact has unrecognized status "${String(pact.status)}"`,
      notify: { level: "loud", message: `TCRN stop-pact: contract status "${String(pact.status)}" is not recognized; allowing the stop. Inspect the pact.` },
      effects: { bindSession, setConsecutiveBlocks: 0 },
    });
  }

  // --- status === "running": this stop is premature by definition of the run. ---

  // Claude and Codex both expose a loop-guard flag on the continuation firing
  // generated by a previous block. Treat it as an allow with no pact effect: a
  // hook that blocks its own continuation can trap the session regardless of the
  // escalation valve below.
  if (input.stopHookActive === true) {
    return verdict("allow", "STOP_HOOK_ACTIVE", {
      message: "stop-hook continuation already active; allowing without another block",
      effects: { setConsecutiveBlocks: consecutiveBlocks },
    });
  }

  // 6. Observe mode (the flagship dial, D2): never block. Surface the premature
  //    stop so it is not silent, and let it proceed. This is how a strong model
  //    is left free while the same event on a weaker model would be held.
  if (mode === "observe") {
    return verdict("allow", "OBSERVE_WOULD_BLOCK", {
      message: "observe mode: premature stop surfaced, not blocked",
      notify: {
        level: "loud",
        message: "TCRN stop-pact (observe): a run marked 'running' stopped without recording completion or a block ticket. Allowed — but this is the pattern the pact exists to catch.",
      },
      effects: { bindSession, setConsecutiveBlocks: consecutiveBlocks },
    });
  }

  // 7. Enforce mode. Escalation valve: only a NO-PROGRESS streak counts. If the
  //    run did real work since the last block it is continuing productively, so
  //    the streak resets to 1 and it keeps being nudged. A stuck loop — re-stops
  //    with nothing done between — climbs the counter and is released after the
  //    cap so it cannot burn tokens forever. maxConsecutiveBlocks sits under
  //    Claude Code's own 8-block cap, so this valve, not the host's, governs.
  const cap = Number.isInteger(pact.maxConsecutiveBlocks) && pact.maxConsecutiveBlocks > 0
    ? pact.maxConsecutiveBlocks
    : 3;

  // Defensive coercion (review finding): a stored counter that is not a non-negative
  // integer must fail toward release, never toward an ever-growing string or a NaN
  // comparison that pins the streak below the cap forever. isWellFormedPact already
  // rejects such a pact upstream, but the decider must not depend on that to be safe.
  const count = Number.isInteger(consecutiveBlocks) && consecutiveBlocks >= 0 ? consecutiveBlocks : cap;

  if (!workedSinceLastBlock && count >= cap) {
    return verdict("allow", "ESCALATION_RELEASE", {
      message: `released after ${count} consecutive no-progress blocks (cap ${cap})`,
      notify: {
        level: "loud",
        message: `TCRN stop-pact: a running pact re-stopped ${count} times with no work in between. Released to avoid a stuck loop — the run did NOT complete. Check what it is stuck on.`,
      },
      effects: { bindSession, setConsecutiveBlocks: 0 },
    });
  }

  const nextCount = workedSinceLastBlock ? 1 : count + 1;
  return verdict("block", "BLOCK_RUNNING", {
    message: blockMessage(pact, input.cliInvocation),
    effects: { bindSession, setConsecutiveBlocks: nextCount, recordBlockOffset: true },
  });
}

// The text fed back to the model when a stop is blocked. It states the fact, the
// two ways out, and nothing else — no exhortation, so a model reading it treats
// it as a protocol, not a scolding.
export function blockMessage(pact, cliInvocation = "stop-pact") {
  const raw = typeof pact?.scope === "string" && pact.scope.length > 0 ? pact.scope : "(scope unstated)";
  // Truncate defensively: the reason is fed back to the model on every block, so an
  // oversized scope must not bloat it (review finding on the stdout path).
  const scope = raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw;
  const cli = typeof cliInvocation === "string" && cliInvocation.length > 0 ? cliInvocation : "stop-pact";
  return [
    "This turn is under an active TCRN run pact and its status is still \"running\".",
    `Scope: ${scope}`,
    "A run does not end by stopping; it ends by a recorded migration. Do not stop yet.",
    `Continue the work. When it is genuinely finished run: ${cli} complete`,
    `If you are truly blocked, record it: ${cli} block --ticket <owner_intent_required|external_release|hard_blockage> --reason "..." — those are the only three reasons a run may stop early.`,
    `If the owner has called it off: ${cli} cancel`,
  ].join("\n");
}
