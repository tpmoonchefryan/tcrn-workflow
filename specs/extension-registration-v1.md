# Extension Registration V1

## Scope & Applicability

This document is normative and describes the registration record admitted by
`validateExtensionRegistration` against `extension-registration-v1.schema.json`.
A registration is the additive mechanism by which an extension identifier becomes
known: it binds a stable extension ID and version to the model surfaces the
extension applies to and to a digest of the extension's own schema. It inherits
every canonical-JSON, ordering, identifier, and extension rule from
`protocol-common-v1`. It carries the AOS requirement `AOS-REQ-013` (required and
optional extension registration).

## Record Shape

The field set is exact and closed (`additionalProperties: false`): a registration
has precisely `schemaVersion`, `id`, `version`, `requiredByDefault`, `appliesTo`,
and `schemaDigest`, with no other keys.

| Field               | Rule                                                    |
| ------------------- | ------------------------------------------------------- |
| `schemaVersion`     | the constant string `tcrn.extension-registration.v1`    |
| `id`                | a `stableId`, unique within a registry                  |
| `version`           | a safe integer, at least 1                              |
| `requiredByDefault` | a boolean                                               |
| `appliesTo`         | a non-empty, duplicate-free subset of the surface set   |
| `schemaDigest`      | a lowercase SHA-256 digest matching `^[a-f0-9]{64}$`    |

`appliesTo` values are drawn from exactly `work`, `knowledge`, `event`,
`context`, `exchange`, and `receipt`; the array has at least one entry, no
duplicates, and no value outside that set. Registration `id`s are unique: a
duplicate identifier within the validated registry fails as a duplicate.

## Digest & Canonicalization

`schemaDigest` is a lowercase hexadecimal SHA-256 over the canonical bytes of the
registered extension's own schema, matching the shared `sha256` shape. A
registration is otherwise hashed with the shared `canonicalSha256` rules
(`utf8-byte-order-v1` key ordering, safe integers only, one terminal LF).

## Reason Codes

Registration admission emits codes from the shared `PROTOCOL_REASON_CODES` list:

- `RECORD_MALFORMED` — missing/extra field, wrong `schemaVersion`, a non-integer
  or sub-1 `version`, a non-boolean `requiredByDefault`, an empty `appliesTo`, a
  duplicate or out-of-set `appliesTo` value, or a `schemaDigest` of the wrong
  shape.
- `CANONICAL_VALUE_INVALID` — a key that is not a well-formed Unicode scalar
  string.
- `ID_INVALID` — an `id` that is not a valid `stableId`.
- `DUPLICATE_ID` — the same registration `id` appears twice in a registry.

When a registration is consumed as part of an extension map check, a
`required: true` extension with no matching registration fails with
`UNKNOWN_REQUIRED_EXTENSION`.

## Ordering & Determinism

`appliesTo` is validated as a duplicate-free set; the registry is keyed by unique
`id`. Object keys serialize in `utf8-byte-order-v1` order under canonical JSON,
so a registration's bytes and digest are a stable function of its content.

## Failure Semantics

Admission is fail-closed and total; the first violated rule throws with its
specific reason code. A required extension MUST be registered before use: an
unknown required value fails closed at admission of any record that carries it.
Unknown optional values are preserved and still participate in the carrier's
canonical hash. A registration is additive only — it MUST NOT redefine core field
meaning, planned-delivery parent rules, canonical serialization, the shared
limits, or the reason-code set.

## Non-Goals

A registration does not carry the extension's payload schema inline (only its
digest), does not grant runtime capability, and does not assert a supported
release. Discovery, distribution, and versioning policy for extension schemas are
out of scope here.
