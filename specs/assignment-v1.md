# Work Assignment V1

## Status and scope

`tcrn.assignment.v1` is an additive extension record binding a work item to one
accountable actor. It registers through extension-registration-v1 with
`appliesTo: ["work"]` and `requiredByDefault: false`, carries its own
`schemaDigest`, and does not change work-model-v1. This is a skeleton: schema plus
minimal read and write validation. There is no employee lifecycle, capacity model,
scheduling, or notification.

## Record

An assignment carries `id`, `projectId`, `workId`, an `accountableActorId`, a
`status` (proposed, active, released), `revision`, a strict `updatedAt` instant,
`tombstone`, and a closed `extensions` map. `additionalProperties` is closed.

The accountable actor field is named `accountableActorId`, deliberately not the
knowledge-core `accountableOwnerId` precedent: an assignment binds any actor, so
the knowledge-core `owner:` prefix rule does not apply here.

## Read path

`list-by-work-item` returns non-tombstoned assignments for a work item in
`utf8-byte-order-v1` over `projectId` then `id`.

## Residuals

There is no live store, employee lifecycle, capacity, or scheduling in this
candidate. Records are inert product data validated offline; activation requires a
separate governed route.
