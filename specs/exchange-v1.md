# Exchange V1

Exchange envelopes conform to `exchange-v1.schema.json`. At most 10,000 entries
are ordered by portable relative path using `utf8-byte-order-v1`. Paths are at
most 512 Unicode scalar values and media types are 1..128 scalar values.
Absolute paths, backslashes, empty components, dot components, and parent
traversal fail with `PATH_ESCAPE`. Each entry binds media type, a safe-integer
byte length from 0 through 1 MiB, and a lowercase SHA-256 digest.

An exchange does not imply a transport, endpoint, credential, database, or live
compatibility claim. Receipt of an envelope is represented separately.
