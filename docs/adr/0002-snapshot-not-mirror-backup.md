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

**Manifest scope**: the `.tcrn-workflow` control tree only (not the whole
workspace root). **Manifest classification**: an engine output schema (the
`migration-plan` precedent), not an extension-registration subject.

**Restore constraint**: same-path-only in V1. Root-rebind (restoring to a
different path) requires the migration apply path V1 lacks
(`WORKSPACE_MIGRATION_APPLY_UNAVAILABLE`, `:59`); a workspace whose schema does not
match its location fails `WORKSPACE_SCHEMA_INVALID` (`:65`). The WSF-3 runbook
restores to the original path, then validates.

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
