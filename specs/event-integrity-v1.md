# Event Integrity V1

Events conform to `event-integrity-v1.schema.json`. A stream starts at sequence
one with `priorHash: null`. Every later event uses the immediately prior event
hash. `payloadHash` is the canonical SHA-256 of the payload; `eventHash` is the
canonical SHA-256 of the event basis before `eventHash` is added.

Duplicate IDs, duplicate or missing sequence values, prior-hash mismatch,
payload corruption, unknown or unhashed fields, and event-hash corruption fail
closed. Validation sorts by numeric sequence then ID using
`utf8-byte-order-v1` before checking so input order cannot change the result.
Every accepted event field participates directly or transitively in
`payloadHash` and `eventHash`.
