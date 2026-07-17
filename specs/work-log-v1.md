# Work-Log Convention V1

## Status and scope

This is a documentation-level convention (spec only). It defines how a worker
dispatch closes; it adds no schema, no engine code, and no enforcement hook in
this candidate. Enforcement is a host-adapter concern deferred to a later route.

## Dispatch closeout

Every worker dispatch closes with two artifacts:

1. a receipt (the existing receipt-v1 record), and
2. a work-log knowledge candidate.

The work-log candidate is a knowledge unit created through the existing
knowledge-core-v1 promotion pipeline with:

- `kind`: `decision` or `summary`;
- a link to the dispatch `workId`, and to a `gateId` when the dispatch closed
  against a gate (grounded by gate-v1);
- a body size cap of 4096 bytes (a convention number that fits under the
  knowledge body budget);
- `promotionState` `candidate` — the work-log candidate is never auto-promoted;
- lifecycle coupling: the candidate tombstones with its work item.

No second knowledge store is created; the single knowledge store holds work-log
candidates alongside other knowledge. High-frequency small records are bounded by
the size cap and by candidate-not-promoted status so the knowledge budget is not
flooded.

## Event linkage

A work-log candidate that closes out chain mutations binds itself to the events it
covers, so the audit trail runs from an accountable actor through a decision to the
evidence behind it. The linkage reuses fields the knowledge store already validates;
it adds no schema and no engine hook.

- Event references: each covered chain event is listed as a `sourceReferences`
  entry of the form `event:<eventHash>`, where `<eventHash>` is that event's
  `tcrn.event.v1` `eventHash` (lowercase hex). The form is a stableId-safe,
  redaction-stable string, so it satisfies the source-reference grammar
  knowledge-core already enforces — bounded, printable, sorted, unique, and left
  unchanged by artifact redaction — with no new grammar.
- Accountable owner: the candidate's `accountableOwnerId` matches the actor
  attested on the covered events (actor-attestation-v1 `payload.actor`). When that
  actor carries the `owner:` prefix the match is exact string equality. When the
  attested actor is a `profile:` or `agent:` id, `accountableOwnerId` stays the
  owning `owner:` id — as the knowledge promotion rule requires — and the
  `profile:`/`agent:` actor id is carried as an additional `sourceReferences` entry.
- Evidence links: `linkedEvidenceIds` (and `linkedGateIds` where a gate closed the
  dispatch) carry the evidence knowledge ids exactly as today; promotion still fails
  closed `KNOWLEDGE_PROVENANCE_INVALID` unless at least one evidence id is present.

The resulting audit walk runs one direction only: `event.payload.actor` -> work-log
candidate (found by its `event:<eventHash>` reference) -> `linkedEvidenceIds` /
`linkedGateIds` -> evidence. Reference direction is event -> actor (attested in the
chain) and work-log -> event; there is deliberately no event-side forward pointer to
knowledge, which would require mutating an event after the knowledge unit exists —
impossible on an append-only chain.

## Settings change as a decision record

A settings change is recorded as a decision, using the same convention: a work-log
knowledge candidate (`kind: decision`) that records the prior value, the new
value, the rationale, and a backlink to the overlay admission receipt. This
grounds the WS-I settings-elicitation flow: a recommended settings change becomes
an auditable decision, not a silent mutation.

## Residuals

There is no live enforcement, no automatic dispatch instrumentation, and no
promotion in this candidate. The convention is normative documentation; a governed
route may later add a host-adapter enforcement hook.
