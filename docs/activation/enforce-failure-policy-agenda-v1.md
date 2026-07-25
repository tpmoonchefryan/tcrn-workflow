# Enforce failure-policy meeting agenda v1

- Status: Draft evidence package; no enforce surface is authorized
- Governs if ratified: INIT-009 EPIC-025 S073/S074/S075
- Governing boundary: MIN-046 (CONF-043)
- Required outcome class: `owner_intent_required`

This document prepares the evidence and choices for a future Owner meeting. It
is not minutes, does not amend N-2, does not authorize a Hook definition, and
does not claim that an Owner tested a kill switch. The current installed Codex
definition remains one fail-open `SessionStart` observe Hook. Claude live
enforce work in this closeout remains `unavailable`/`blocked`. EPIC-024's
separate fail-open observe evidence does not amend this agenda: it live-fired
Claude `SessionEnd`, retained explicit unavailable cells for the remaining
events, and authorized no enforce surface.

## Common admission conditions

Every surface below starts disabled and is admitted independently. A ruling for
one event does not authorize another event, another host, another command class,
or a global/user-level definition. A first red run is limited to a disposable
project, one exact machine-specific definition, one synthetic action, and no
production data. It must retain:

1. an exact definition digest and a fresh host approval for those bytes;
2. an independently reachable kill switch, exercised by the Owner outside the
   governed Hook path before the red run;
3. a positive control with the surface disabled, plus block, handler-error and
   timeout observations with host exit/result records;
4. a bound receipt that distinguishes policy denial from handler failure,
   timeout, missing receipt and uncovered capability;
5. an immediate rollback path that removes the registration before removing
   its handler, without changing the inert adapter bundle; and
6. explicit no-coverage rows for every host/tool/event not exercised.

No Codex red run may start until the Owner records the failure policy and the
kill-switch evidence. No Claude red run is proposed in this package.

## S073: PreToolUse gate

**Decision requested.** Choose failure semantics separately for a determinate
policy result and for infrastructure failure. A determinate deny can block only
the closed command/tool class named in the ruling. Handler error, malformed
output, digest drift, unavailable authority and timeout each need an explicit
Owner choice; none inherits SessionStart's policy and none may be inferred from
fixtures.

**Blast radius.** A mistaken deny can prevent shell, file or MCP work in the
project. A broad matcher can also create an unmeasured coverage claim. The first
candidate therefore targets one harmless sentinel-writing command in one
disposable project and names all other tools as ungoverned. It must not register
under a user-level host configuration or claim IDE/Desktop parity.

**Independent kill-switch candidates for Owner selection and test.** The
primary candidate is the host-owned `/hooks` disable control for the exact
project definition, exercised from outside the blocked action. The secondary
recovery is managed `adapter-deactivate` from an external terminal/session, not
from a tool call subject to the same PreToolUse gate. Neither is accepted until
the Owner demonstrates disable, reads back the disabled state, and confirms the
positive control can run afterward.

**Real red-evidence plan after ruling.** With the exact definition approved,
attempt a command that would create a disposable sentinel and require a host
record showing the command was denied and the sentinel absent. Then use distinct
lab definitions to produce a controlled handler error and a bounded timeout,
record the host disposition selected by the ruling, use the independent switch,
and run the positive control. Definition drift must return to pending approval.

## S074: PermissionRequest and approval receipt

**Decision requested.** Define whether this surface may only deny, may defer to
the host/user, or may ever approve. An absent, malformed, drifted, errored or
timed-out responder must have a separately ruled disposition. Silence can never
be converted into an approval receipt. The first consumer and the authority
that permits it must be named before an approval-receipt contract is added.

**Blast radius.** A mistaken approval can authorize a destructive action; a
mistaken denial can deadlock an otherwise recoverable session. App Server
approval responses also cross the read-only Observer boundary and can become an
active controller. GD-1 and MIN-042 remain unchanged, so App Server response
driving is excluded from this closeout. A Hook-based candidate, if separately
ruled, is limited to a harmless disposable permission prompt and must never
auto-approve a real command, file write, network action or MCP mutation.

**Independent kill switch.** The candidate must use a host-owned project Hook
disable control or an external managed deactivation path that does not require
the pending approval to succeed. The Owner must demonstrate that the prompt
returns to native host handling after disable. This document records no such
demonstration.

**Real red-evidence plan after ruling.** Produce a harmless permission request,
record the exact host request and an explicit denial/defer result, and verify no
authority-bearing receipt is emitted on missing/malformed output. Repeat with a
controlled handler error and timeout. App Server response frames are not part of
this plan unless a later Initiative reopens GD-1 and authorizes a Controller.

## S075: Stop/final-hop gate

**Decision requested.** Name the closed set of objective invariants that may
delay final-hop completion and rule separate behavior for determinate invariant
failure, unavailable state, malformed state, handler error and timeout. Prose,
model judgment and heuristic quality scores are not eligible blockers. A
SessionStart or observe ruling confers no Stop authority.

**Blast radius.** A false block can suppress the Owner-visible final answer and
make the ordinary recovery instructions inaccessible. Repeated stop loops can
strand a session. The first candidate therefore uses one disposable session,
one synthetic unresolved invariant, one bounded retry/stop count, and no
project delivery gate. It must expose its reason through a host-visible fixed
template without including untrusted state text.

**Independent kill switch.** Disable the exact project definition from the
host-owned Hook surface or remove it through managed deactivation from another
terminal/session. The test is accepted only when the Owner performs the switch
while the lab Stop blocker is active and a subsequent final answer is delivered.
No Owner test is claimed here.

**Real red-evidence plan after ruling.** In a disposable session, prove one
synthetic invariant blocks the final hop without emitting a final answer, then
clear the invariant and prove completion. Run controlled malformed-state,
handler-error and timeout definitions and record the ruled disposition. Finally
exercise the independent switch while blocked and prove a new final answer is
visible. No production work item or release gate participates.

## Evidence package for the meeting

The Owner package must contain the exact proposed definition bytes and digests,
the per-surface matcher, fixed output schemas, maximum execution time, rollback
receipt shape, the disposable red scripts, expected host observations and an
acceptance table with unfilled Owner columns for policy choice and kill-switch
readback. Until those columns are filled in the out-of-band roster-authorized
meeting, S073/S074/S075 and EPIC-025 remain `blocked`, host enforce authorization
remains zero, and no Codex enforce definition is generated or approved.
