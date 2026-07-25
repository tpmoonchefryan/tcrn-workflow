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

The shipped Observer does not attach to a live App Server; the stream is
*supplied* to it. S057 later used a separate bounded evidence harness for one live
attach. That proves the supplied-stream/readback path without adding connection or
driving verbs to the Observer and without creating a reusable Controller.

S054 adds a consumer of that same supplied stream:
`packages/core/src/codex-execution-collection.ts` correlates the lower-case
`item/started` and `item/completed` spawn lifecycle with the receiver's captured
`thread/read(includeTurns=true)`, `turn/started`, `turn/completed`, and a
phase-tagged final `agentMessage`. A child `thread/started` notification is
optional because Codex 0.139.0 did not emit it in the live run; if present it must
agree with readback. The collector emits an `observe` record with real opaque host
session/thread/turn ids and prompt/output digests. `freshContext` requires matching
receiver, session, parent, non-forked readback and overlapping creation/spawn
lifecycle. Raw and normalized readback final ids stay distinct while phase and
text bytes must match. Missing fields, readback, an unpinned protocol or incomplete
lifecycle return `unavailable`; replay and cross-session contamination fail closed.
The transcript projection remains unsigned attribution evidence, not identity
proof.

`pnpm verify:act10` proves the collector against hostile 0.139.0-shaped fixtures.
S057 additionally attached a bounded harness once to the real pinned App Server,
passed 28 raw/readback comparisons, produced one unsigned fresh-context Workflow
execution receipt, and cleanly tore down its launched process tree. That exact
evidence is recorded in `codex-app-server-execution-collection.json`. Earlier
Codex Desktop rollout records remain separate and were not converted.

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
3. **No live Controller evidence.** S057 now proves one bounded start/readback
   evidence path, not rollback, injection, approval response, interruption or
   control of an ordinary user session. Turning that harness into a reusable
   controller would cross the retired-decision and blast-radius boundaries above.

**Recommendation: do not open a Controller initiative now.** The read-only
collection question has enough live evidence for S057; the remaining gap is not
protocol feasibility but explicit authority and safety evidence for control-plane
mutation.

## S083 — Claude Code control-plane observer equivalence

There is no App Server equivalent on Claude Code. Three candidate surfaces exist,
and each is weaker in a way that matters:

| Surface | What it could give | Why it is not equivalent |
| --- | --- | --- |
| Agent SDK | Programmatic session control | It *drives* a session rather than observing one already running; using it as an observer would mean starting the session ourselves, which changes what is being observed. |
| OpenTelemetry export | Structured spans for tool calls and turns | Export is configured by the user, not by us, and no receipt can assume it is on. Absent telemetry is indistinguishable from an absent event — the trap MIN-046 names. |
| Session transcripts | The richest record of what happened | Written by the host for its own use, unsigned, and mutable by the same user who owns the session; the collection layer already treats them as attribution evidence only. |

**Assessment: no equivalent Observer is warranted today.** The observe-hook surface
(EPIC-024) is the intended Claude path for tool lifecycle, compaction and subagent
boundaries. Its generated handler now has exact live evidence for `SessionEnd` on
Claude Code 2.1.201, while the other five Claude cells remain explicitly unavailable
because the model probe returned API status 402 before inference or tool use. The
same acceptance artifact records exact Codex evidence for the other five events and
the version-pinned absence of Codex `SessionEnd`; neither host has complete six-event
coverage. A second, weaker control-plane path would add surface without resolving
those host conditions. If that changes, it is a separate initiative, on the same
terms as S079.

## S078 — capability mapping

The Browser, Computer-use, Worktree, Automation and Connector capabilities are
recorded in `docs/verification/host/capability-manifest.json` with their surface,
channel and governance level. Their status is unchanged by this epic: they remain
`invoke-only` or `unavailable`, because the observer built here reads a bounded
notification/readback surface and does not govern any of them. One S057 attach did
not exercise or establish complete coverage of those host-exclusive capabilities.

## What this document does not claim

- That S057's bounded evidence harness is a shipped App Server Controller or gives
  authority to drive ordinary user sessions.
- That the notification vocabulary is complete for versions other than 0.139.0 — a
  stream from a different protocol digest is admitted as `unpinned`, and the receipt
  says so.
- That EPIC-024 has complete six-event live coverage on either host. Its accepted
  matrix preserves six explicit unavailable host-event cells, does not rename Codex
  `Stop` to `SessionEnd`, and adds no enforce hook.
- That a Controller is safe to build. It says the opposite: the surface exists, and
  the governance work does not.
