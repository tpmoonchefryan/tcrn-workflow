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

## Residuals

There is no live store, approval routing, gate lifecycle automation, or
enforcement in this candidate. Records are inert product data validated offline;
activation requires a separate governed route.
