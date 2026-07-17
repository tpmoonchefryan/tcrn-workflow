# Receipt V1

## Scope & Applicability

This document is normative and describes the receipt record admitted by
`validateReceipt` against `receipt-v1.schema.json`. A receipt is an immutable
local observation that an exchange envelope was received and either admitted or
refused. It inherits every canonical-JSON, ordering, instant, identifier, and
extension rule from `protocol-common-v1`; this document states only what is
specific to receipts. A receipt carries the AOS requirement `AOS-REQ-012`
(immutable receipts).

## Record Shape

The field set is exact and closed (`additionalProperties: false`): a receipt has
precisely `schemaVersion`, `id`, `exchangeId`, `receivedAt`, `status`,
`subjectDigest`, and `extensions`, with no other keys.

| Field           | Rule                                                       |
| --------------- | ---------------------------------------------------------- |
| `schemaVersion` | the constant string `tcrn.receipt.v1`                      |
| `id`            | a `stableId` (`namespace:value`, at most 161 characters)   |
| `exchangeId`    | the `stableId` of the received envelope                    |
| `receivedAt`    | a `strictInstant` (no-leap-second RFC 3339 subset)         |
| `status`        | one of exactly `accepted` or `rejected`                    |
| `subjectDigest` | a lowercase SHA-256 digest matching `^[a-f0-9]{64}$`       |
| `extensions`    | the shared closed extension map (at most 64 entries)       |

`id` and `exchangeId` are validated independently as protocol identifiers.
`receivedAt` is the strict receive instant. `subjectDigest` binds the exact bytes
of the received subject and is never recomputed by an admitter.

## Digest & Canonicalization

`subjectDigest` is a lowercase hexadecimal SHA-256 over the canonical bytes of
the received subject, produced by the shared `canonicalSha256` rules
(`utf8-byte-order-v1` recursive key ordering, one terminal LF, safe integers
only). The digest is not derived from a host filesystem or transport view; it is
the caller's assertion about the exact subject bytes and is admitted verbatim.

## Reason Codes

Failures use one code from the shared `PROTOCOL_REASON_CODES` list; the admitter
never substitutes a generic success for a specific failure. Receipt admission can
emit:

- `RECORD_MALFORMED` — missing/extra field, wrong `schemaVersion`, a `status`
  outside `{accepted, rejected}`, or a non-string typed field.
- `CANONICAL_VALUE_INVALID` — a key or value that is not a well-formed Unicode
  scalar string (for example a lone UTF-16 surrogate in an extension key).
- `ID_INVALID` — an `id` or `exchangeId` that is not a valid `stableId`.
- `TIMESTAMP_INVALID` — a `receivedAt` outside the strict instant subset.
- `INPUT_OVERSIZED` — an extension map or value beyond the shared limits.
- `UNKNOWN_REQUIRED_EXTENSION` — a `required: true` extension with no matching
  registration.

## Ordering & Determinism

A receipt is a single record and has no internal array to order; its object keys
serialize in `utf8-byte-order-v1` order under canonical JSON. Determinism is
therefore a property of the canonical encoding: the same receipt content always
produces the same bytes and the same subject digest.

## Failure Semantics

Admission is fail-closed and total: the first violated rule throws with its
specific reason code and no receipt is returned. Receipts are immutable
observations — an admitter never overwrites, mutates, or re-stamps an earlier
receipt. A replayed or re-observed exchange produces a new receipt under a new
stable `id`; the prior receipt is untouched. An `accepted` status proves only
local schema and integrity admission of the referenced subject; it asserts
nothing about release trust, publication, or live service compatibility.

## Non-Goals

A receipt does not carry the received payload, a transport identity, a
credential, an endpoint, or a supported-release claim. It does not confer
authority reserved for the external Release Trust Root. Delivery, retransmission,
and storage of envelopes are represented by separate records and are out of
scope here.
