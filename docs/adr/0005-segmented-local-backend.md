# ADR 0005: Segmented local storage backend

Status: accepted (INIT-048, 2026-09-02)

## Decision

The MVP keeps the local file backend and adds `file-segmented` as the default
for new workspace event writes. The segmented backend writes canonical NDJSON
event records into numbered segments, rolls new segments at the configured
`storage.segmentBytes` limit (16 MiB by default), and maintains point, label,
time, and manifest sidecars. Existing count-based JSON segments remain
readable and historical event bytes are never rewritten by the byte-roll rule.

Reads use the newest valid replay checkpoint under `snapshots/` and replay only
the tail after its version. Checkpoints are compressed when necessary, written
through atomic temporary-file replacement, and published by a manifest written
last. A malformed or damaged checkpoint returns `WORKSPACE_SNAPSHOT_INVALID`;
the reader never silently falls back to a full replay. The checkpoint is a
performance cache, not an authority or a backup receipt.

`storage.backend` is a closed MVP enum containing only `file` and
`file-segmented`. The PostgreSQL implementation was removed from the repository by
TCRN-CROSS-INC-275 (2026-09-04); see ADR 0004. The local
backend is dependency-free at runtime.

## Selection criteria

- Roll by serialized UTF-8 bytes, not record count, so a large scope cannot
  make one segment disproportionately large.
- Keep sidecars derived and rebuildable; a missing sidecar is an integrity
  failure for point lookup, not a reason to scan the event log silently.
- Write the segment or checkpoint before its manifest pointer and verify the
  bytes after replacement.
- Treat the event log and metadata as the source of truth; views, indexes,
  snapshots, knowledge bodies, and time-attestation segments are rebuildable.
- Keep all runtime dependencies at zero and use the existing bounded atomic IO.

## Fixed protocol values

The work and gate state machines, field names and schema versions, the
1,048,576-byte canonical ceiling, SHA-256, and the 8,192-byte maximum knowledge
body remain protocol constants. They are not settings because changing them
would change what an existing chain means rather than tune local capacity.

## Rejected alternatives

- A PostgreSQL default was rejected for this MVP by the Owner's 2026-09-02
  ruling; retaining its code does not make it a selectable backend.
- A fallback scan after a missing index or damaged checkpoint was rejected
  because it makes a performance regression invisible while returning a result
  that appears valid.
- Rewriting old event segments during a setting change was rejected because
  append-only history is an audit fact; only future segment placement changes.
