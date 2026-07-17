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

The `distillConferenceKnowledge` transform turns the closed minutes into full
`CreateKnowledgeUnitInput` records — one per decision — that the unmodified
knowledge creation contract admits. Each record carries a hyphen-only external key
`conference-decision-<hex>-<hex>-<n>` the canonicalizer accepts, `project` scope,
`decision` category and kind, a fixed conference tag set and a non-empty snippet
(so it is promotable by construction under the promote-time machine checks),
`subject`/`summary`/`snippet` truncated on a code-point boundary to their byte
caps, a `sourceDigest` bound to the full untruncated title/decision/minutes basis,
both the conference and conference-minutes backlinks, and the deduped
`evidence:`-prefixed union across positions and an optional supplement. Provenance
(accountable owner, evidence) is optional at capture and enforced only at promote.

The `conference-close --distill` verb wires this under one held workspace lease:
it reads the knowledge marker version before the close — so a missing or invalid
knowledge store fails closed BEFORE the close event is appended and the workspace
version is unchanged — appends `conference.closed` (advancing the head), performs
the governed high-water rebind so subsequent knowledge access does not fail on the
advanced head, then creates one candidate per decision and names the created ids in
its receipt. `--distill` is opt-in: absent or false, the close is byte-identical to
a close with no knowledge access.

## Persistence

Conference records persist as additive workspace event-log operations:
`conference.created`, `conference.updated`, `conference.position.appended`, and
`conference.closed`. Every event is built through the shared attested payload
constructor; `conference.closed` carries the minutes under the registered
per-operation extra key `minutes`, so a close is one atomic event whose payload
is exactly `{minutes, operation, record}`.

Event binding: every persisted record's `updatedAt` equals its event's
`occurredAt`; a create carries `revision` 1 and `tombstone` false and its id must
be new; a mutation carries `revision` exactly one above the current record and
pins every field it does not explicitly mutate (identity and `projectId` never
change). `conference.created` requires status `open`, a live (non-tombstoned)
project, and live same-project work for every `linkedWorkIds` entry.
`conference.position.appended` and `conference.closed` require the referenced
conference to be `open` and project-bound; `conference.updated` is the cancel
route (`open` to `cancelled` only). The closing minutes are revision-1 records
bound by `conferenceId` and `projectId`. Violations fail closed:
`WORKSPACE_CONFERENCE_NOT_OPEN` at mutation time, `WORKSPACE_EVENT_CORRUPT` at
replay time.

Workspaces containing a conference event additionally emit a
`views/extensions.json` index; workspaces without extension records keep their
views, export, and archive bytes unchanged. `storageVersion` stays 1: an old
binary reading a workspace that contains these events fails closed with
`WORKSPACE_EVENT_CORRUPT` (unknown operation), and a workspace that never uses
them stays fully readable by old binaries.

## Residuals

There is no scheduler, participant notification, cross-project conference, or
automated action item. Record validation remains offline and store-independent;
hub integration and promotion require separate governed routes.
