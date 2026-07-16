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
