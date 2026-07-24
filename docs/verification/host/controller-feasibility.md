# Controller feasibility and the observer boundary

INIT-009 EPIC-026, stories S078, S079 and S083. This is an assessment, not a
capability: nothing described here is built, and the two things it evaluates —
active orchestration on Codex and a control-plane observer on Claude Code — both
remain out of scope for this initiative by the ruling recorded in MIN-042.

## What is built (S077), and what that fixes about the boundary

`packages/core/src/app-server-observer.ts` folds a supplied App Server notification
stream into a bounded receipt: per-group and per-method counts, unknown-method and
malformed-frame counts, and a protocol binding. It retains no `params`, so command
output, file paths and message text stay in the host. It is read-only by
construction — the module names none of the protocol's driving verbs, opens no
socket, and issues no request; `pnpm verify:act8` asserts all of that against the
source.

It does not attach to a live App Server. The stream is *supplied* to it. Attaching
would require running a Codex session, which is out of scope here.

S054 adds a consumer of that same supplied stream:
`packages/core/src/codex-execution-collection.ts` correlates the lower-case wire
methods `item/completed`, `thread/started`, `turn/started` and `turn/completed`.
When a completed `collabAgentToolCall`/`spawnAgent` can be bound to a subagent
thread, its first turn and a phase-tagged final `agentMessage`, the collector
emits an `observe` record with real session/thread/turn ids and prompt/output
digests. `freshContext` is derived only when `forkedFromId` is null and the
thread was created after the matching spawn completed. The final output is the
last `phase=final_answer` item by completion time inside that turn; commentary
is never promoted. Missing fields, an unpinned protocol or incomplete lifecycle
return `unavailable`; nothing is inferred. The resulting transcript projection
is unsigned attribution evidence, not identity proof. `pnpm verify:act10` proves
that correlation against the generated 0.139.0 TypeScript schema shapes without
starting or steering an agent.

`pnpm verify:act11` closes the cross-host acceptance and hostile matrix around
that boundary. It explicitly leaves the live multi-agent/App-visible receipt
comparison incomplete; unavailable cells are a recorded result, not an
all-green live-host claim.

## S079 — Controller feasibility on Codex

**Mechanically feasible; deliberately not built.** Codex 0.139.0's App Server
protocol exposes the requests an active controller would need — `thread/resume`,
`thread/fork`, `thread/rollback`, `thread/injectItems`, `thread/compact/start`, plus
the approval surface (`ExecCommandApproval`, `ApplyPatchApproval`,
`FileChangeApproval`, `PermissionsRequestApproval`). The schema is real and pinned
(`docs/verification/host/codex-0.139.0-facts.json`).

Three things stand between that surface and a controller, and none is a coding
problem:

1. **A retired decision.** GD-1 retired the Codex agent mesh: Claude executes and
   reviews, the Owner signs gates. A controller that starts, interrupts, forks and
   rolls back threads is that mesh returning under another name. MIN-042 held it
   outside this initiative and required a separate initiative plus a GD-1
   re-litigation before any of it is built.
2. **A blast radius nobody has bounded.** `thread/rollback` and `thread/injectItems`
   mutate a user's session history. The failure-policy discipline MIN-046 established
   for blocking hooks — declared blast radius, an owner-tested kill switch reachable
   without the mechanism, fail-closed behaviour proven on a live host — applies at
   least as strongly here, and none of it exists for this surface.
3. **No live evidence.** Nothing in this repository has ever attached to a running
   App Server. A controller built on an unexercised protocol would be a claim about
   a surface we have only read the schema of.

**Recommendation: do not open a Controller initiative now.** The honest next step is
the one the observer already takes — read a real stream from a real session and find
out what the protocol does in practice — and that requires a live Codex run, which is
the Owner's to authorise.

## S083 — Claude Code control-plane observer equivalence

There is no App Server equivalent on Claude Code. Three candidate surfaces exist,
and each is weaker in a way that matters:

| Surface | What it could give | Why it is not equivalent |
| --- | --- | --- |
| Agent SDK | Programmatic session control | It *drives* a session rather than observing one already running; using it as an observer would mean starting the session ourselves, which changes what is being observed. |
| OpenTelemetry export | Structured spans for tool calls and turns | Export is configured by the user, not by us, and no receipt can assume it is on. Absent telemetry is indistinguishable from an absent event — the trap MIN-046 names. |
| Session transcripts | The richest record of what happened | Written by the host for its own use, unsigned, and mutable by the same user who owns the session; the collection layer already treats them as attribution evidence only. |

**Assessment: no equivalent Observer is warranted today.** The observe-hook surface
(EPIC-024) already covers what governance needs from a Claude session — tool
lifecycle, compaction, subagent boundaries — through a mechanism whose failure
semantics are ruled and whose receipts are bounded. A second, weaker path would add
surface without adding evidence. If that changes, it is a separate initiative, on the
same terms as S079.

## S078 — capability mapping

The Browser, Computer-use, Worktree, Automation and Connector capabilities are
recorded in `docs/verification/host/capability-manifest.json` with their surface,
channel and governance level. Their status is unchanged by this epic: they remain
`invoke-only` or `unavailable`, because the observer built here reads a notification
stream and does not govern any of them. Mapping them to `observe` would require a
live attach that has not happened.

## What this document does not claim

- That any App Server was attached, or that any Codex session was observed.
- That the notification vocabulary is complete for versions other than 0.139.0 — a
  stream from a different protocol digest is admitted as `unpinned`, and the receipt
  says so.
- That a Controller is safe to build. It says the opposite: the surface exists, and
  the governance work does not.
