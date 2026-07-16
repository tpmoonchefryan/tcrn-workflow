# Conference V1

## Status and scope

`tcrn.conference.v1` is an additive extension shape for pre-commitment
collaborative deliberation. It registers through extension-registration-v1 with
`appliesTo: ["work"]` and `requiredByDefault: false`, carries its own
`schemaDigest`, and does not change work-model-v1. This is a skeleton: request,
position, and minutes records with a minimal operation surface. There is no
orchestration, action-item automation, notification, or search.

A conference is deliberation before a decision is owned; it is not a review board
(post-commitment independent adjudication). The two are never merged.

## Records

A `request` binds a conference `type` (adopting the AOS conference type
vocabulary: strategy, architecture, risk, verification, release, incident,
retrospective), a bounded `title`, at least one anchoring `linkedWorkIds` entry
(the first is the primary anchor), a required `desiredOutcome`, `participantIds`,
and a `status` (open, closed, cancelled). Field names are adapted to product
domain language — the AOS source `linkedTicketIds` and `participantEmployeeIds`
map to `linkedWorkIds` and `participantIds`; semantics, not names, are mirrored.

A `position` binds `conferenceId`, `projectId`, an `actorId`, a bounded
`position`, bounded `risks` and `recommendations` arrays, and `evidenceIds`.

`minutes` bind `conferenceId`, a `summary`, an `outcomeClass` (discussion_only,
recommendation, role_decision, blocked, owner_intent_required — a truthful class,
`owner_intent_required` where that is the fact), `decisions`, and
`unresolvedIssues`. All records carry `id`, `projectId`, `revision`, a strict
`updatedAt` instant, `tombstone`, and a closed `extensions` map;
`additionalProperties` is closed and text fields are byte-budgeted.

## Operations

`open` admits a request in `open` status. `append-position` admits a position
bound to an open conference by matching `conferenceId` and `projectId`; an unbound
or closed conference fails closed. `close` admits minutes bound to the conference
and distils each minutes decision into one knowledge decision candidate.
`list-by-work-item` returns non-tombstoned conferences anchoring a work item in
`utf8-byte-order-v1` over `projectId` then `id`.

## Close distillation

Closing a conference emits, for each minutes decision, a knowledge candidate with
`kind: "decision"` and `promotionState: "candidate"` that backlinks the conference
and its minutes through inert `sourceReferences` locators. These candidates feed
the existing knowledge-core-v1 promotion pipeline; none is promoted here, and no
second knowledge store is created (single knowledge store). The raw positions and
minutes remain size-budgeted records subject to the knowledge and archive
lifecycle.

## Residuals

There is no live store, scheduler, participant notification, cross-project
conference, or automated action item. Records are inert product data validated
offline; hub integration and promotion require separate governed routes.
