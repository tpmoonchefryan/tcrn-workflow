# Offline Compatibility And Modes V1

P7-B defines an offline-only planning boundary. A canonical, closed Workflow
compatibility manifest names the Workflow-owned definition fields and the
AOS-owned operational fields. These sets are disjoint. Plans preserve every
AOS-owned field and never apply a mutation.

Compatibility planning requires a separately governed admission context. The
context authenticates the exact pair-receipt digest and binds repository,
workflow, subject, signer, issuer, audience, nonce, verification time, policy
floor, instance, data epoch and a valid Workspace lock. Request bytes cannot
populate this authority. Receipts are rejected when expired, not yet valid,
revoked, replayed or below the anti-rollback epoch/version floor.

The deterministic operations are `initial_import`, `portable_checkpoint`,
`fallback_admission`, `fallback_delta`, `conflict_plan` and
`reconciliation_dry_run`. All outputs are canonical, byte-ordered plans with
`mutation=false` and `network=false`. A checkpoint used for fallback delta or
reconciliation must match instance/data epoch and meet the policy-version
floor. External-effect identifiers are unique.

The live state-changing surfaces `aos_primary`, `fallback_activation`,
`import_apply` and `reconciliation_apply` return exactly
`capability_unavailable_until_mutual_release`. P7-B has an empty supported-AOS
release set, performs no network access, and changes no Workspace or AOS state.
This is not a supported live release-pair claim.

JSON Schema proves the closed structural surface, count limits and well-formed
Unicode through the registered `x-tcrn-wellFormedUnicode` and
`x-tcrn-deepWellFormedUnicode` proof keywords. Runtime additionally proves
canonical digests, strict RFC 3339 instants, reference identity, policy and
state-machine semantics.
