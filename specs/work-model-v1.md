# Work Model V1

Work records conform to `work-model-v1.schema.json`. IDs and external keys are
stable, revisions increase monotonically from one, and tombstones remain
addressable records rather than deletion signals.

The planned-delivery graph is exactly `Initiative -> Epic -> Story -> Subtask`.
Initiatives have no parent; each other planned-delivery node has the immediately
preceding kind as parent in the same project. Missing parents,
cross-project parents, cycles, kind skips, duplicate IDs, and live references to
tombstoned parents fail closed.

Review, Incident, Release, and Knowledge are extension work shapes. They MAY
reference a same-project record but are not inserted into or required by the
planned-delivery hierarchy. Deterministic order is project ID in
`utf8-byte-order-v1`, kind rank, then record ID in that same total order. The
permitted status transitions are frozen in the protocol module;
terminal states have no outgoing transitions.
