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

The protocol carries all eight kinds at every layer — validation, ordering,
template admission — while the CLI create path opens them one at a time as the
mechanism each needs lands. Incident opened in 0.3.2 and Release in 0.5.0; Review
and Knowledge stay closed there, held by a red leg in
`tests/workspace-extension-records.test.mjs`. This is "closed at the CLI create
path", not "impossible on a chain": `createWork` carries no kind allowlist and
replay accepts all eight, so a record of a closed kind written by some other
client still reads. The disposition is retention with per-kind opening on
demonstrated need, and the two openings above are what that has looked like.
