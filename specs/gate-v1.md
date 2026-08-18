# Gate V1

## Status and scope

`tcrn.gate.v1` is an additive extension record for a minimal decision gate. It
registers through extension-registration-v1 with `appliesTo: ["work"]` and
`requiredByDefault: false`, carries its own `schemaDigest`, and does not change
work-model-v1. This is a skeleton: schema plus minimal read and write validation.
There is no full gate lifecycle, approval routing, or automation.

## Record

A gate carries `id`, `projectId`, an optional `workId` (nullable — a gate may be
project-scoped without a single work anchor), a bounded `title`, an `outcomeClass`
reusing the conference vocabulary (discussion_only, recommendation, role_decision,
blocked, owner_intent_required), a `status` (pending, satisfied, blocked),
`revision`, a strict `updatedAt` instant, `tombstone`, and a closed `extensions`
map. `additionalProperties` is closed.

**Record vocabulary and write vocabulary are different sizes.** All five outcome
classes remain valid in the schema and in replay, so every record ever written
still validates and every chain still reads. What a *new* gate may be born as is
narrower: the CLI mints only `role_decision` and `owner_intent_required`
(`TCRN-CROSS-MIN-102` 裁定三), refusing the other three with
`CLI_ARGUMENT_MALFORMED`. The reason is that on a gate they were pure labels —
`owner_intent_required` is the only class that reaches engine behaviour (the
identity roster under Enforcement) — and across the platform that ruled this, no
gate had ever been created with any of the three. A value the CLI does not
recognise at all still travels uncast to the engine, which answers with
`GATE_SCHEMA_INVALID`; only the retired-but-legal classes are refused early.

This record grounds the previously dangling knowledge `linkedGateIds` reference:
a knowledge unit may reference a gate `id` that now has a defined shape.

## Read path

`list-by-work-item` returns non-tombstoned gates for a work item in
`utf8-byte-order-v1` over `projectId` then `id`.

## Persistence

Gate records persist as additive workspace event-log operations: `gate.created`,
`gate.updated`, and `gate.deleted`, each built through the shared attested
payload constructor with payload `{operation, record}`.

Event binding: every persisted record's `updatedAt` equals its event's
`occurredAt`; `gate.created` carries `revision` 1, `tombstone` false, status
`pending`, a new id, a live (non-tombstoned) project, and — when `workId` is
non-null — a live same-project work anchor. A mutation carries `revision`
exactly one above the current record and pins every field it does not explicitly
mutate (identity, `projectId`, and `workId` never change): `gate.updated`
mutates `status` (and, on the move to `satisfied`, adds exactly the evidence
entry described under Enforcement) and `gate.deleted` is the only tombstone route
(there is no untombstone). Violations fail closed with `WORKSPACE_EVENT_CORRUPT`
at replay time.

## Enforcement

Gate enforcement is off by default: a workspace with no gate records is
behaviorally unchanged, and creating a `pending` gate anchored to a work item IS
the per-work-item opt-in — there is no global switch.

Designated transition set. A non-tombstoned gate that is **not `satisfied`** and
whose `workId` anchors a work item blocks any work transition whose target status
is `done`, with stable reason `WORKSPACE_GATE_PENDING` and no event appended. The
designated set is exactly `done`: transitions to `cancelled`, `blocked`, `ready`,
or `active` are never blocked, so cleanup and re-planning can never wedge. The
identical predicate runs in the replay reducer as `WORKSPACE_EVENT_CORRUPT`, so a
hand-tampered event log cannot drive a work item to `done` past an unsatisfied gate.

The clearing state is `satisfied` and only `satisfied`, because that is the one
state reached by citing resolving minutes. This is worth stating rather than
leaving to be inferred, since the earlier predicate counted `pending` alone: with
`pending` and `blocked` freely interconvertible and no evidence required to move
between them, flipping a gate to `blocked` *released* the work item — two legal
commands took an unsatisfied gate out of the way of `done`, in a state whose name
says the opposite. Corrected under `TCRN-CROSS-MIN-102` 裁定一.

Gate `status` `blocked` therefore carries no clearing power and never did carry a
documented purpose. It is one of three unrelated meanings the word has in this
protocol, and the three do not move together: `blocked` as a gate status (a gate
held short of satisfaction), `blocked` as a work status (a work item that cannot
proceed), and `blocked` as an `outcomeClass` value (retired from the write path,
see below). Only the work status is in active use.

Gate lifecycle. `pending` and `blocked` interconvert freely; a gate reaches
`satisfied` only from `pending` or `blocked` and only with resolving evidence;
`satisfied` is terminal (its only exit is a `gate.deleted` tombstone). The
tombstone route also serves as the documented deadlock escape when a gate's
conference is cancelled and no minutes can ever resolve.

Satisfaction evidence. A transition to `satisfied` requires a minutes locator of
the form `conference-minutes:<suffix>` (a protocol id). It resolves when a
non-tombstoned conference-minutes record whose id shares that suffix exists and —
when the gate's `workId` is non-null — that minutes record's conference lists the
gate's `workId` in its `linkedWorkIds`. The resolving locator is persisted in the
gate's `extensions` map under key `gate-evidence:conference-minutes` as a
`{required: false, value: "conference-minutes:<suffix>"}` entry (`required: false`
needs no extension-registry row). An unresolved locator fails the verb with
`WORKSPACE_GATE_EVIDENCE_UNRESOLVED` and no event; the replay reducer re-resolves
the persisted locator against already-materialized minutes and fails closed with
`WORKSPACE_EVENT_CORRUPT` on any mismatch or a smuggled extensions delta.

Workspaces containing a gate record additionally emit a `views/extensions.json`
verification summary; workspaces without extension records keep their views,
export, and archive bytes unchanged. The summary carries a count and a digest
per collection rather than the gate records themselves, so its size is fixed
rather than proportional to the number of gates, while any byte inside any gate
record still moves it. Gate records are read through `gate-list-by-work-item`. `storageVersion` stays 1: an old binary reading a
workspace that contains these events fails closed with
`WORKSPACE_EVENT_CORRUPT` (unknown operation).

## Residuals

There is no approval routing or gate lifecycle automation in this candidate.
Transition-time enforcement (blocking a work transition on a pending gate, and
minutes-backed satisfaction) is specified under Enforcement above and enforced
identically at the verb and replay layers. Widening the designated set beyond
target `done` (for example, requiring gates on selected work kinds) stays a
future Owner decision, not a shipped knob. Record validation remains offline and
store-independent; activation requires a separate governed route.
