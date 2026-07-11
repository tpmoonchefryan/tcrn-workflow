# Artifact Lifecycle V1

P4 adds a bounded, offline artifact lifecycle without introducing knowledge
body, snippet, freshness, promotion, persona, AOS, database, or network
semantics. The Workspace event chain remains authority. Artifact records are
closed canonical metadata/reference documents bound to the exact Workspace ID
and event high-water digest; they do not embed raw evidence bodies.

## Classification

V1 freezes eight kinds and five lifecycle classes:

- `artifact` → `authoritative-artifact`;
- `terminal-state`, `decision`, `gate`, and `acceptance` →
  `protected-record` and mandatory terminal state;
- `evidence-reference` → `durable-evidence-reference`;
- `receipt` → `transient-receipt`;
- `cache` → `transient-cache`.

Compaction is projection-only in P4. It always retains authoritative artifacts,
terminal states, decisions, gates, acceptance records, and evidence references.
Receipts and caches are reported as transient and dropped-by-default, but no
implicit deletion occurs. Artifact data is outside the P3 authoritative export,
which continues to serialize only the accepted Work graph and event chain.

## Store and privacy

The store lives at `.tcrn-workflow/artifacts/` with closed `store.json`,
`records/`, `transient/receipts/`, `transient/cache/`, and `archives/` entries.
All source files are bounded, single-link regular files read through
`O_NOFOLLOW` descriptors. Pre-open, opened-descriptor, post-read descriptor, and
post-read named-file snapshots bind device, inode, size, mode, nanosecond mtime,
and nanosecond ctime; every stage and the actual byte count is checked against
the applicable size limit. Paths are bounded relative ASCII segments. Symlinks,
hardlinks, special files, same-inode mutation, source replacement, path
traversal, count/size overflow, malformed canonical JSON, and high-water drift
fail closed.

Record and transient admission is limited to 1024 combined entries, 16 MiB of
stored bytes, and 4 GiB of declared logical bytes. Both transient directories
are enumerated and the combined entry count is rejected before any transient
file is opened. Stored and logical byte totals are enforced incrementally after
each descriptor-bound read, so a scan never reads the whole over-budget corpus
before rejecting it.

References must already be redacted before admission. Authentication material,
userinfo in every parsed hierarchical URL scheme and scheme-relative URL,
URL query/fragment data, common credential forms, email-like private identifiers,
and private machine-home paths are removed or replaced. Leading and trailing
ASCII space (`U+0020`) is removed before URL structural detection; ASCII control
whitespace remains invalid under the printable-reference rule. Malformed or
unsupported hierarchical userinfo fails closed instead of being admitted. This
deterministic focused policy is metadata/reference-first and is not a general
DLP claim.

## Doctor, size, and compact projection

`artifact-size`, `artifact-doctor`, and `artifact-compact-dry-run` are read-only.
The size report is deterministically grouped by lifecycle class. Doctor budgets
have exact warning/critical byte and count thresholds and return
`ARTIFACT_DOCTOR_OK`, `ARTIFACT_DOCTOR_WARNING`, or
`ARTIFACT_DOCTOR_CRITICAL`. Compact projection returns exact retained/dropped
paths and a canonical projection digest with `mutationApplied=false`.
Size and doctor totals include archive-generation count and stored bytes, and
the report exposes the frozen runtime/schema storage limits.

## Archive and restore

Archive dry-run is read-only and returns a plan digest plus deterministic
archive ID. Apply and restore require an explicit artifact-store disposable bit
and are additionally restricted to synthetic Workspaces whose external key
starts with `FIXTURE-`. The live local graph is therefore ineligible.

Apply creates one exclusive archive-generation directory, writes a canonical
bundle through a single-link `O_EXCL|O_NOFOLLOW` descriptor, synchronizes it,
and commits it without overwriting an existing generation. Restore requires an
empty record authority, an exclusive restore claim, exact plan/high-water
binding, canonical base64, per-entry size/hash/path validation, and no
overwrite. Crash or partial states retain an observable incomplete generation
or restore claim and fail with `ARTIFACT_PARTIAL_STATE`; another valid
generation is never silently removed.

V1 admits at most 16 complete or partial archive generations and 32 MiB of
aggregate archive-generation storage. Each generation admits at most the one
canonical bundle file. Generation and per-generation entry counts are checked
before any bundle is opened. Every complete or partial generation entry is required to be
a single-link regular file, and cumulative bytes are checked before reading the
next bundle. Apply preflights the new generation and canonical bundle against
both limits; restore also bounds decoded entry bytes incrementally.

The accepted P1 Option-B cooperative clean-checkout boundary remains. V1 does
not claim portable protection against a hostile concurrent replacement of
ancestor path components.

## Capability boundary

`P4_ARTIFACT_LIFECYCLE_VERIFIED` proves this bounded lifecycle and disposable
archive corpus. It does not complete P4, mark the local graph Story or Subtask
done, implement the knowledge core, or authorize AOS, remote, release, or
publication mutation.
