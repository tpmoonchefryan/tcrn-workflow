# Work Dependency V1

## Status and scope

`tcrn.dependency.v1` is an additive extension record shape for directed
relationships between work items. It is registered through
extension-registration-v1 with `appliesTo: ["work"]` and
`requiredByDefault: false`, and carries its own `schemaDigest`; the frozen
work-model-v1 record and its normative text are unchanged. Work items remain a
pure tree in work-model-v1; dependencies are separate records, never core fields.

## Record

A dependency binds one project-scoped directed edge from `fromWorkId` to
`toWorkId` with a `kind` (`blocks` or `informs`) and a `status` (`active`,
`resolved`, or `waived`). It carries `id`, `projectId`, `revision`, a strict
`updatedAt` instant, a `tombstone` flag, and an `extensions` map. All identifiers
are protocol stable IDs. `additionalProperties` is closed. A self-edge
(`fromWorkId` equal to `toWorkId`) fails closed.

Audit consistency: a `waived` dependency requires both a bounded `waivedReason`
and a `waivedByActorId`; either absent fails closed, and both are forbidden on a
non-waived dependency. The canonical hash covers the complete record, including
unknown optional extension values, so a stored dependency round-trips
deterministically under `utf8-byte-order-v1`.

## Rules

Edges are project-scoped. For a live (non-tombstoned) dependency both endpoints
must be live, same-project work records; a missing endpoint, a tombstoned
endpoint, or an endpoint in another project fails closed. Cross-project edges are
out of scope for this candidate and are rejected. Tombstoned dependencies are
historical and are not endpoint-checked.

Cycle detection runs over active `blocks` edges only: a directed cycle among
active blocking dependencies fails closed with a stable cycle reason. `informs`
edges, resolved, waived, and tombstoned dependencies never participate in cycle
detection.

Total order for listing and hashing is `utf8-byte-order-v1` over `projectId` then
`id`; host locale collation is forbidden.

## Read path

`list-blockers(workId)` returns the active `blocks` edges whose target is the
work item — the query a hub uses to answer "what blocks X". `list-by-work-item`
returns every dependency touching the work item as either endpoint. Both return
records in the canonical total order.

## Residuals

There is no live store, scheduler, automatic resolution, notification, or
cross-project edge in this candidate. The record is inert product data validated
offline; activation and any hub read integration require separate governed routes.
