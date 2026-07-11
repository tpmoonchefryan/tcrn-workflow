# Knowledge Model V1

Knowledge records conform to `knowledge-model-v1.schema.json`. Each record has
a stable ID, project ID, bounded subject/body, positive revision, strict update
instant, tombstone, and extension map. Tombstones preserve identity and revision
history; they do not authorize dangling references from live context records.

Consumers order knowledge records by project ID and then ID using
`utf8-byte-order-v1`. Canonical hashes cover the complete record, including
unknown optional extensions.
