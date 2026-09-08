# ADR 0002: Snapshot-not-mirror backup

- Status: Accepted per program authorization (recommended defaults, OD-28/OD-29/OD-30)
- Date: 2026-07-17
- Governs: WSF-2 (snapshot witness), WSF-3 (restore proof), WSF-4 (git tier), WSF-5/WSF-6 (skill + settings)

## Decision

Backup is a snapshot of a **quiesced** workspace, never a live mirror. Live-sync,
junction/symlink, and cloud-mirror of a live workspace are contraindicated by
design: the engine fail-closes on the exact filesystem behaviors a sync client
produces — inode-identity changes (double-stat `dev`/`ino`), `nlink !== 1`
(`boundFile`), unexpected control-directory entries (conflict copies such as
`store (1).json`), symlinks, and non-allowlisted filesystem types
(`assertSupportedWorkspaceFilesystem`, `packages/core/src/workspace.ts:213-216`,
`WORKSPACE_FILESYSTEM_UNSUPPORTED`). The reason codes are predictable stops, not
silent corruption — but they make a synced live workspace unusable.

Backup and restore therefore are: quiesce (no writer lease held) → copy the
workspace tree with OS tools → `workspace validate` to prove integrity. Git is the
recommended tier-2 (the workspace is canonical JSON; `.gitignore` `lease/` and
`lease-recovery.claim`), used as an **integrity witness only** — its hash tree is
an independent completeness check — with all restores routed through the copy
runbook (empty directories such as `.tcrn-workflow/backups/` are not tracked by
git and must be recreated). Export archives are canonical checkpoint anchors, but
there is **no governed re-import** in this line (exchange is plan/dry-run only), so
archive-based restore is never promised.

## MAKE-VS-TEACH verdict: hybrid

Build read-only **witness** verbs (`snapshot-manifest`, `snapshot-verify`) that
compute and check a manifest over the control tree; **teach** the actual copy with
OS tools. Rejected alternatives:

1. **A destination-writing `snapshot` verb** that streams the workspace to an
   arbitrary `--destination` — rejected as the largest new outward-write surface
   for the least benefit; `cp`/`tar`/`rsync` already copy correctly.
2. **Repurposing `.tcrn-workflow/backups/`** as the snapshot target — rejected:
   that control directory is reserved for migration rollback
   (`restore-exact-pre-migration-backup-then-validate`, `workspace.ts:138,:1531`),
   and migration apply currently fails closed
   (`WORKSPACE_MIGRATION_APPLY_UNAVAILABLE`, `:59`).
3. **A live-sync integration** (watch + push) — rejected as directly
   contraindicated by the fail-closed filesystem guards above.

## Path-safety analysis

The witness verbs read the workspace and write only a manifest. The premise that
"no engine path writes outside the workspace root" is **false** and must not be
used as the argument: `writeCanonicalExchangeBundle`
(`packages/core/src/canonical-exchange.ts:364-365`) already writes to an arbitrary
absolute `outputRoot` through a dedicated outward guard family (`outputBoundary`).
That precedent *strengthens* the read-only-witness choice — the outward-write
guard pattern exists and is proven, so the manifest writer reuses it rather than
inventing a new one, and the witness never mutates the workspace it inspects
(`atomicWrite`, `workspace.ts:299-347`, remains the only inward primitive).

> **TCRN-CROSS-STORY-358 note (2026-09-06).** `canonical-exchange.ts` retired
> whole in this Story's family 3 (no consumer beyond its own three CLI verbs);
> the file:line citation above no longer resolves, and `outputBoundary` has no
> other live example in this tree. The historical point stands regardless — "no
> engine path writes outside the workspace root" was already false at the time
> this ADR was written, which is what the paragraph argues — so the
> read-only-witness verdict below is not reopened. Git tag `attic-2026-09`
> retains the retired file for reference.

**Manifest scope**: the `.tcrn-workflow` control tree only (not the whole
workspace root). **Manifest classification**: an engine output schema (the
`migration-plan` precedent), not an extension-registration subject.

**Restore constraint**: same-path-only for a *restore*. A workspace whose stored
roots disagree with its location fails `WORKSPACE_SCHEMA_INVALID` (`:65`), and the
WSF-3 runbook restores to the original path, then validates.

> **Retired 2026-07-29, superseded by ADR 0003.** This paragraph used to add that
> root-rebind "requires the migration apply path V1 lacks
> (`WORKSPACE_MIGRATION_APPLY_UNAVAILABLE`)", and attributed the deferral to
> OD-29. That was a misattribution repeated in two documents: OD-29 is the
> manifest-scope decision (see the sign-off section below, which says so), while
> the apply-path deferral is OD-7 and concerns storage-version-2 chain rewriting.
> Root rebinding transforms no events and changes no `storageVersion`, so it never
> needed the apply path. The governed route was the relocation verb family, which
> ADR 0003 described; that verb family, its module and its ADR retired in
> TCRN-CROSS-STORY-358, so there is no governed route through the refusal today.
> The `WORKSPACE_SCHEMA_INVALID` refusal above is unchanged and is now the whole
> story: restore in place.

## Amendment, TCRN-CROSS-STORY-380 (2026-09-08): a cloud directory may hold blobs

The decision above is about a LIVE WORKSPACE, and that half is unchanged: the chain,
the lease, the views and the control tree are still never mirrored, and every reason
code listed above still fires if anybody tries. What this amendment narrows is the
sentence's reach. "Cloud-mirror is contraindicated" was written about the only bytes
this engine stored at the time, and it was read afterwards as a rule about cloud
storage in general, which is why `workspace.generatedArtifactsPath` shipped in
TCRN-CROSS-STORY-213 accepting relative paths only.

A generated artifact is not a live workspace. It is immutable, it is addressed by the
sha256 of its own content, and nothing reads it by name expecting a particular inode.
None of the failure modes above apply to it: there is no lease to double-hold, no
control-directory entry a conflict copy can shadow, no `nlink` invariant, and a
`store (1).json`-shaped duplicate is simply a file whose name is not a digest, which
`artifact-list` reports as unindexed rather than adopting.

The one failure a sync client can still cause is the one that matters — it rewrites
bytes — and that failure is now DETECTED rather than prevented by prohibition:

  * `artifact-put` re-reads every blob from disk and re-hashes it before it emits a
    receipt, so a rewrite between write and read is refused at the moment it happens,
    by the writer, with `ARTIFACT_MISMATCH` and the blob removed;
  * `artifact-verify` recomputes every blob the manifest records, so a rewrite that
    happens later is found by a command an operator can run on either machine;
  * the manifest that says which blobs should exist, and what they should hash to,
    lives in the workspace control tree and records no absolute path. It is the local
    half, and it never goes to the cloud directory at all.

`workspace.generatedArtifactsPath` therefore accepts an absolute root, subject to the
conditions in `specs/settings-catalog-v1.md`: outside the workspace, outside its
control tree, outside `<HOME>/.tcrn-workflow`, an existing directory, and not a
symbolic link. Using a cloud-synced folder for it is a supported configuration, not a
tolerated one. Putting a workspace there remains contraindicated, for every reason
this ADR gave in the first place.

## Consequences

WSF-2's `BK-SNAPSHOT-WITNESS` claim lists this ADR in its `fixturePaths`, so
doctrine drift invalidates the proof digest. The helper skill (WSF-5) teaches the
copy flow and warns, with named reason codes, why live-sync/junction bricks the
store. This is a product-repo change (witness verbs + proof) plus a helper-repo
change (skill flow) that rides the Stage 8 batched candidate.

## Owner sign-off (GD-1)

Ratified per the program implementation authorization (recommended defaults):
hybrid MAKE-VS-TEACH verdict (OD-28), manifest scope = control tree only (OD-29),
git as integrity-witness-only with copy-runbook restore (OD-30). Sign-off recorded
before WSF-2 merges.
