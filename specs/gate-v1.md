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
mutates `status` only and `gate.deleted` is the only tombstone route (there is
no untombstone). Violations fail closed with `WORKSPACE_EVENT_CORRUPT` at
replay time.

Workspaces containing a gate record additionally emit a `views/extensions.json`
index; workspaces without extension records keep their views, export, and
archive bytes unchanged. `storageVersion` stays 1: an old binary reading a
workspace that contains these events fails closed with
`WORKSPACE_EVENT_CORRUPT` (unknown operation).

## Residuals

There is no approval routing or gate lifecycle automation in this candidate, and
transition-time enforcement semantics (blocking a work transition on a pending
gate) are specified separately when that capability lands. Record validation
remains offline and store-independent; activation requires a separate governed
route.
