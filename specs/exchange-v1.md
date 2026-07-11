# Exchange V1

Exchange envelopes conform to `exchange-v1.schema.json`. Entries are ordered by
portable relative path. Absolute paths, backslashes, empty components, dot
components, and parent traversal fail with `PATH_ESCAPE`. Each entry binds media
type, byte length, and SHA-256 digest.

An exchange does not imply a transport, endpoint, credential, database, or live
compatibility claim. Receipt of an envelope is represented separately.
