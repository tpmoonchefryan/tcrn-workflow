# File-Native Workspace And Event Engine V1

P3 defines a standalone Workspace that needs only the pinned Node runtime and a
supported local filesystem. It does not require a database, AOS, a network
service, or a current external-runtime mutation.

## Authority and layout

The five accepted P1 roots remain mandatory and pairwise distinct. The
`workspace` root contains `.tcrn-workflow/` with immutable V1 metadata,
canonical event segments, a cooperative single-writer lease, backup space, and
derived views. Event segments plus Workspace metadata are authority. `STATUS.md`,
`index.json`, and `readback.json` are deterministic, rebuildable views and never
authority.

Every metadata root entry has exactly `kind`, `path`, `canonicalPath`, and
`portableIdentity`. Nested additions, omissions, scalar replacements, and field
type changes fail with `WORKSPACE_SCHEMA_INVALID`, matching the closed V1
schema.

The portable Workspace archive is canonical JSON that binds its canonical
authority export by SHA-256. It excludes host root paths, is byte-identical for
the same event basis, and is an exchange artifact rather than a second source of
truth.

V1 supports APFS/HFS+, ext-family, XFS, and tmpfs semantics on the pinned macOS
and Ubuntu environments. Unknown filesystem types fail closed. The P1 Option-B
threat model applies: commands require an exclusive cooperative checkout and
protect against all pre-existing link, special-file, path-redirection, and
stale-lock states, but do not claim portable protection from a concurrent
hostile parent-component replacement outside the process.

## Writes, events, and recovery

Every mutation requires a live single-writer lease, an exact expected Workspace
version, and a strict RFC 3339 instant. Writes use an exclusive no-follow
descriptor, file synchronization, atomic rename, target identity validation,
and parent-directory synchronization. The Workspace version is the number of
validated events, so the event chain is also the CAS authority.

Events use the accepted `tcrn.event.v1` hash contract. Segments are contiguous,
canonical JSON arrays with a frozen per-Workspace event limit. Missing,
truncated, replayed, reordered, malformed, or hash-corrupt events fail closed;
recovery never discards authoritative corruption. A crash after an event commit
may leave derived views stale. Governed recovery removes only safe orphan
temporaries and rebuilds the views from the exact chain.

Only `project.created`, `project.updated`, `project.deleted`, `work.created`,
`work.updated`, and `work.deleted` are admitted. Creation cannot reuse a live or
tombstoned identity. Update and delete require a live prior record, exact next
revision, event-bound timestamp, unchanged identity fields, valid Work status
transition, and valid project/parent relationships. Repeated delete,
resurrection, sibling operation names, and forged lifecycle events fail with
`WORKSPACE_EVENT_CORRUPT`.

The Workspace stream identity is the first 24 hexadecimal SHA-256 characters
of canonical `{schemaVersion:"tcrn.workspace-stream-identity.v1",workspaceId,
createdAt}` prefixed by `stream:`. Each event identity similarly hashes
canonical `{schemaVersion:"tcrn.workspace-event-identity.v1",streamId,
sequence}` and is prefixed by `event:`. Replay validates both identities before
materialization, so an internally valid chain transplanted to another Workspace
fails closed without changing the frozen P2 event hash contract.

An incomplete `lease/` remains locked for one lease TTL, preventing a live
creator from being mistaken for a crash. After that grace period, stale or
incomplete recovery uses an independent single-link `O_EXCL|O_NOFOLLOW`
recovery claim, re-reads and binds both lease-directory and owner identities,
and quarantines only the observed generation. Concurrent recoverers admit one
winner; delayed contenders cannot remove the winner's claim or lease. Normal
claim cleanup is identity-bound. A malformed, linked, special, colliding, or
crash-retained recovery claim fails closed and requires operator verification;
it is never silently replaced.

## Work model

Project IDs and Work IDs use accepted stable-ID derivation and canonical ASCII
external keys. P3 exposes project CRUD and the accepted
Initiative → Epic → Story → Subtask hierarchy. Parent kinds, project ownership,
transitions, tombstones, revisions, limits, and deterministic ordering are
validated by the frozen P2 protocol rather than redefined locally.

## Migration window

P3 supports storage version 1 only. Migration planning is dry-run and returns an
exact backup/rollback contract. Downgrades and unknown future versions fail
closed. Every future apply must validate the exact target schema and full event
chain after transformation. Real user-data migration apply is unavailable in P3; a future reviewed
schema must add an exact backup, transformation, post-validation, and rollback
implementation before apply can be admitted.

## Capability boundary

`P3_VERIFIED` proves the local engine and its deterministic fault corpus. It is
not P3 acceptance and does not authorize the canonical capability marker. The
marker remains absent until RC-P3 reviewers and Janus accept one immutable
basis in a separate route.
