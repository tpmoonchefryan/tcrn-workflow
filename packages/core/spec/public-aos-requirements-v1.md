# Public AOS Requirements V1

P7-C is an offline, generic public ledger. Every closed requirement binds its
stable requirement id, discovery phase, Workflow behavior, needed capability,
protocol version, mode, fixture, security boundary, lifecycle status and
maturity. Only `specified` and `fixture_verified` maturity are admissible.

V1 is a closed source contract: exactly the eight admitted public requirement
projections, including every lifecycle and maturity value, are frozen in the
schema and validator. The validator compares a canonical per-requirement source
digest before it accepts the ledger digest. Text is well-formed Unicode and at
most 512 UTF-8 bytes; protocol versions are safe integers from 1 through
`9007199254740991`. These scalar limits and the exact source boundary are
rejected equally by the Draft 2020-12 contract and runtime validator.

The ledger contains no product priority, ownership, roadmap, adoption,
initiative, current-state or private release-plan field. It exposes no live
compatibility, runtime mutation, supported-release claim or network action.
The read-only CLI validates canonical bytes and emits a deterministic count and
digest readback only.

The public requirements cover release-manifest/readback, trusted actor binding,
projection/import truth ownership, durable idempotency/revisions, portable
checkpoint/readiness, fallback fencing/conflict/reconciliation/recovery,
Knowledge compatibility, and conformance/mutual-release activation. Activation
remains a future mutual-release decision and is not implemented here.
