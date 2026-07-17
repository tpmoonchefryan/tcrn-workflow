# P3 Acceptance Marker V1

## Scope & Applicability

This document is normative and describes the P3 acceptance marker defined by
`p3-acceptance-marker-v1.schema.json` and enforced-absent by the P2 protocol
proof. The marker is the single on-disk token that records that the P3
local-work-graph capability has been accepted by the four required roles after
RC1 approval. Its canonical path is
`.context/platform/workflow-v3-capabilities/p3-local-work-graph.accepted.json`.
It inherits the canonical-JSON and strict-instant rules from
`protocol-common-v1`. It carries the AOS requirement `AOS-REQ-014`
(p3-acceptance-marker-contract).

## Record Shape

The field set is exact and closed (`additionalProperties: false`): a marker has
precisely `schemaVersion`, `capability`, `accepted`, `acceptedAt`, `basisCommit`,
`basisTree`, `rc1ManifestDigest`, and `roleVerdicts`, with no other keys.

| Field               | Rule                                                     |
| ------------------- | -------------------------------------------------------- |
| `schemaVersion`     | the constant string `tcrn.p3-acceptance-marker.v1`       |
| `capability`        | the constant string `p3-local-work-graph`                |
| `accepted`          | the constant boolean `true`                              |
| `acceptedAt`        | a `strictInstant`                                        |
| `basisCommit`       | a 40-character lowercase hex commit id (`^[a-f0-9]{40}$`)|
| `basisTree`         | a 40-character lowercase hex tree id (`^[a-f0-9]{40}$`)  |
| `rc1ManifestDigest` | a lowercase SHA-256 digest matching `^[a-f0-9]{64}$`     |
| `roleVerdicts`      | a closed object of the four required role verdicts       |

`roleVerdicts` is exact and closed with precisely
`platform-workflow-architect`, `workflow-verification-engineer`,
`security-risk-reviewer`, and `reality-checker`, each the constant string
`approved`.

## Digest & Canonicalization

`rc1ManifestDigest` is a lowercase hexadecimal SHA-256 that binds the marker to
the exact RC1 candidate-manifest bytes; `basisCommit` and `basisTree` bind it to
the exact accepted source state. The marker is canonical JSON (recursive
`utf8-byte-order-v1` key ordering, safe integers only, one terminal LF).

## Reason Codes

- `P3_MARKER_PRESENT` — the P2 protocol proof fails closed if the marker file
  exists at the canonical path; P2 defines this contract but must never create
  the marker.

A marker that is present is validated against the schema by exact-pinned Draft
2020-12 evaluation: any field outside the constant/pattern set above is rejected
by standard schema validation.

## Ordering & Determinism

The marker is a single record; its object keys and the `roleVerdicts` sub-object
keys serialize in `utf8-byte-order-v1` order under canonical JSON, so an accepted
marker's bytes are a stable function of its content.

## Failure Semantics

The marker is fail-closed by absence: absence means the P3 local-work-graph
capability is unavailable, and P2 asserts and proves that absence. The marker may
be created only by a later accepted control-plane route after RC1 approval — never
by P2 and never by a candidate. All four role verdicts must be exactly `approved`
and `accepted` must be exactly `true`; there is no partial or provisional marker.

## Non-Goals

The marker does not itself grant, execute, or configure the capability; it is a
record of acceptance. Producing RC1 approval, running the role reviews, and
operating the control-plane route that writes the marker are out of scope here.
