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

References must already be redacted before admission. Authentication material,
userinfo in every parsed hierarchical URL scheme and scheme-relative URL,
URL query/fragment data, common credential forms, email-like private identifiers,
and private machine-home paths are removed or replaced. Malformed or unsupported
hierarchical userinfo fails closed instead of being admitted. This deterministic
focused policy is metadata/reference-first and is not a general DLP claim.

## Doctor, size, and compact projection

`artifact-size`, `artifact-doctor`, and `artifact-compact-dry-run` are read-only.
The size report is deterministically grouped by lifecycle class. Doctor budgets
have exact warning/critical byte and count thresholds and return
`ARTIFACT_DOCTOR_OK`, `ARTIFACT_DOCTOR_WARNING`, or
`ARTIFACT_DOCTOR_CRITICAL`. Compact projection returns exact retained/dropped
paths and a canonical projection digest with `mutationApplied=false`.

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

The accepted P1 Option-B cooperative clean-checkout boundary remains. V1 does
not claim portable protection against a hostile concurrent replacement of
ancestor path components.

## Capability boundary

`P4_ARTIFACT_LIFECYCLE_VERIFIED` proves this bounded lifecycle and disposable
archive corpus. It does not complete P4, mark the local graph Story or Subtask
done, implement the knowledge core, or authorize AOS, remote, release, or
publication mutation.
