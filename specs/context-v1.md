# Context V1

Context documents conform to `context-v1.schema.json` and bind a project to
deduplicated ordered work and knowledge ID sets at a strict generation instant.
Producers sort both ID arrays lexicographically before hashing or exchange.

A context builder MUST resolve every non-tombstoned reference before emission.
Unknown optional extensions are preserved; unknown required extensions prevent
admission.
