# Compatibility V1

## Scope & Applicability

This document is normative and describes the compatibility document admitted by
`validateCompatibility` against `compatibility-v1.schema.json`. A compatibility
document states, for one profile, the protocol version it targets and the
inclusive protocol-version window it declares, at a maturity that never exceeds
what P2 can prove. It inherits every canonical-JSON, identifier, and version-
window rule from `protocol-common-v1`. It carries the AOS requirement
`AOS-REQ-010` (version window and maturity).

## Record Shape

The field set is exact and closed (`additionalProperties: false`): a
compatibility document has precisely `schemaVersion`, `profileId`,
`protocolVersion`, `minimumProtocolVersion`, `maximumProtocolVersion`, and
`maturity`, with no other keys.

| Field                    | Rule                                                |
| ------------------------ | --------------------------------------------------- |
| `schemaVersion`          | the constant string `tcrn.compatibility.v1`         |
| `profileId`              | a `stableId`                                        |
| `protocolVersion`        | a safe integer, at least 1                          |
| `minimumProtocolVersion` | a safe integer, at least 1                          |
| `maximumProtocolVersion` | a safe integer, at least 1                          |
| `maturity`               | one of exactly `specified` or `fixture_verified`    |

The three version fields form an inclusive window validated by
`assertVersionWindow`: it requires `1 <= minimum <= protocolVersion <= maximum`.
Maturity is restricted to `specified` or `fixture_verified` — the only two states
P2 can substantiate.

## Digest & Canonicalization

A compatibility document is hashed with the shared `canonicalSha256` rules
(`utf8-byte-order-v1` key ordering, safe integers only, one terminal LF). It has
no internal digest field; its identity is its canonical bytes.

## Reason Codes

Compatibility admission emits codes from the shared `PROTOCOL_REASON_CODES` list:

- `RECORD_MALFORMED` — missing/extra field, wrong `schemaVersion`, a non-string
  `profileId`, a non-integer version field, or a `maturity` outside
  `{specified, fixture_verified}`.
- `CANONICAL_VALUE_INVALID` — a key that is not a well-formed Unicode scalar
  string.
- `ID_INVALID` — a `profileId` that is not a valid `stableId`.
- `VERSION_WINDOW_INVALID` — a window that is not
  `1 <= minimum <= protocolVersion <= maximum`.

## Ordering & Determinism

A compatibility document is a single record with no ordered array; its object
keys serialize in `utf8-byte-order-v1` order under canonical JSON, so the same
content always produces the same bytes.

## Failure Semantics

Admission is fail-closed and total: the first violated rule throws with its
specific reason code. No P2 compatibility document asserts a supported live
release pair. The `maturity` field caps the claim at `specified` or
`fixture_verified`; a supported-release assertion requires later runtime evidence
and an accepted release boundary that P2 cannot grant.

## Non-Goals

A compatibility document does not name a live endpoint, a release artifact, or a
counterpart deployment, and it does not confer the external Release Trust Root's
authority. Negotiating or activating a live release pair is out of scope here.
