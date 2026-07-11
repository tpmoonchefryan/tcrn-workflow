# Protocol Common V1

This document is normative. V1 protocol documents use canonical UTF-8 JSON
with recursively lexicographically sorted object keys, preserved array order,
no insignificant whitespace, safe-integer numbers only, and exactly one
terminal LF. SHA-256 digests cover those exact bytes.

Stable IDs use `namespace:value`; namespaces and values are lowercase ASCII and
match the common schema. External keys are NFC-normalized uppercase tokens.
`deriveStableId` hashes the namespace, a NUL separator, and the canonical
external key, then uses the first 24 lowercase hexadecimal characters.

Instants use the strict no-leap-second RFC 3339 subset. V1 rejects normalized,
date-only, locale, impossible-date, seconds-60, and invalid-offset values.
Version windows are inclusive and require `1 <= minimum <= version <= maximum`.

Unknown optional extensions are preserved byte-semantically through canonical
JSON. Unknown required extensions fail with `UNKNOWN_REQUIRED_EXTENSION`.
Objects reject unknown normative fields. Inputs are limited to 1 MiB canonical
bytes, 10,000 records, 8,192 characters per string, 64 extensions per record,
and 64 levels of JSON nesting.

All failures use one code from `PROTOCOL_REASON_CODES`; implementations MUST NOT
replace a more specific code with a generic success or partial result.
