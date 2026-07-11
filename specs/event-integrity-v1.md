# Event Integrity V1

Events conform to `event-integrity-v1.schema.json`. A stream starts at sequence
one with `priorHash: null`. Every later event uses the immediately prior event
hash. `payloadHash` is the canonical SHA-256 of the payload; `eventHash` is the
canonical SHA-256 of the event basis before `eventHash` is added.

Duplicate IDs, duplicate or missing sequence values, prior-hash mismatch,
payload corruption, and event-hash corruption fail with `EVENT_REPLAY` or
`EVENT_CHAIN_CORRUPT`. Validation sorts by sequence then ID before checking so
input order cannot change the result.
