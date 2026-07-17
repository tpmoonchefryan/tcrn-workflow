# Profile Trust V1

## Scope & Applicability

This document is normative and describes the profile-trust document admitted by
`validateProfileTrust` against `profile-trust-v1.schema.json`. A profile-trust
document binds a profile and its issuer to a strict, non-empty validity interval,
an inclusive protocol-version window, and a capability digest. It inherits every
canonical-JSON, instant, identifier, and version-window rule from
`protocol-common-v1`. It carries the AOS requirement `AOS-REQ-011` (profile trust
without release elevation). It does not replace the external Release Trust Root V1
authority and admits no release mode.

## Record Shape

The field set is exact and closed (`additionalProperties: false`): a
profile-trust document has precisely `schemaVersion`, `profileId`, `issuer`,
`issuedAt`, `expiresAt`, `minimumProtocolVersion`, `maximumProtocolVersion`, and
`capabilityDigest`, with no other keys.

| Field                    | Rule                                                |
| ------------------------ | --------------------------------------------------- |
| `schemaVersion`          | the constant string `tcrn.profile-trust.v1`         |
| `profileId`              | a `stableId`                                        |
| `issuer`                 | the issuing `stableId`                              |
| `issuedAt`               | a `strictInstant`                                   |
| `expiresAt`              | a `strictInstant`                                   |
| `minimumProtocolVersion` | a safe integer, at least 1                          |
| `maximumProtocolVersion` | a safe integer, at least 1                          |
| `capabilityDigest`       | a lowercase SHA-256 digest matching `^[a-f0-9]{64}$`|

The protocol window is inclusive and validated by `assertVersionWindow` against
the current `protocolVersion` (1): it requires `1 <= minimum <= 1 <= maximum`.

## Digest & Canonicalization

`capabilityDigest` is a lowercase hexadecimal SHA-256 matching the shared
`sha256` shape. The document is otherwise hashed with the shared `canonicalSha256`
rules (`utf8-byte-order-v1` key ordering, safe integers only, one terminal LF).
Both instants are parsed to exact signed epoch nanoseconds after numeric offset
normalization; comparison never uses host date parsing or millisecond rounding.

## Reason Codes

Profile-trust admission emits codes from the shared `PROTOCOL_REASON_CODES` list:

- `RECORD_MALFORMED` — missing/extra field, wrong `schemaVersion`, a non-string
  identifier or instant, or a non-integer version field.
- `CANONICAL_VALUE_INVALID` — a key that is not a well-formed Unicode scalar
  string.
- `ID_INVALID` — a `profileId` or `issuer` that is not a valid `stableId`.
- `TIMESTAMP_INVALID` — an `issuedAt` or `expiresAt` outside the strict subset.
- `VERSION_WINDOW_INVALID` — a protocol window that is not
  `1 <= minimum <= 1 <= maximum`, or an empty validity interval where `issuedAt`
  is not strictly earlier than `expiresAt`.

## Ordering & Determinism

A profile-trust document is a single record with no ordered array; its object
keys serialize in `utf8-byte-order-v1` order under canonical JSON. The interval
comparison is a total order on epoch nanoseconds, so equal instants — including
the same instant written with different offset spellings — compare equal and are
rejected as empty.

## Failure Semantics

Admission is fail-closed and total: the first violated rule throws with its
specific reason code. The validity interval must be non-empty (`issuedAt` strictly
earlier than `expiresAt`); equal instants and inverted windows fail with
`VERSION_WINDOW_INVALID`. A candidate-controlled profile cannot elevate maturity,
invent compatibility, or replace external release trust through this document.

## Non-Goals

A profile-trust document does not admit a release mode, does not name a live
endpoint or credential, and does not confer the external Release Trust Root's
authority. Establishing or rotating that root is out of scope here.
