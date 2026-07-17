# Backup and Restore Runbook

A backup nobody has restored is a hope, not a capability. This runbook is the
normative procedure for taking a hermetic snapshot of a workspace control tree
and restoring it byte-for-byte. It is the buildable half of ADR 0002's
snapshot-not-mirror verdict: the copy is taught (OS tools), only the manifest and
its verification are made. The companion `backup-git-tier.md` covers the optional
git tier-2 integrity witness; both restore stories route through this runbook.

All paths below are workspace-relative placeholders. `<root>` is the Workspace
authority root (the directory that contains `.tcrn-workflow/`). Paths with spaces
are first-class here — always double-quote them.

## Two doctrines the operator must accept before starting

1. **Same-path-only.** A restore targets the exact original path on the same
   machine. `resolveWorkspace` fail-closes `WORKSPACE_SCHEMA_INVALID` ("stored
   roots do not match their current filesystem identities") when the stored root
   `canonicalPath`/`portableIdentity` disagree with the live filesystem. Root
   rebind (restoring to a new path or machine) needs the migration apply path,
   which V1 does not have (`WORKSPACE_MIGRATION_APPLY_UNAVAILABLE`) — per OD-29 it
   is out of scope for V1. Restore in place.
2. **Lockstep-only.** The knowledge store marker binds its `eventHighWaterDigest`
   to the workspace `headEventHash`. Restoring the workspace event log without the
   knowledge store (or the reverse) bricks the store with
   `KNOWLEDGE_HIGH_WATER_MISMATCH`. Whole-control-tree byte-identical restore keeps
   both stores in lockstep by construction — never restore one store alone.

## SNAPSHOT

1. **Quiesce.** End every agent session against `<root>`. A snapshot proves a
   quiesced tree; the lease is the quiesce proof and a second holder fails
   `WORKSPACE_LOCKED`.
2. **Settle and prove green.** Run `recover` then `validate`:

   ```
   pnpm --silent exec tcrn-workflow recover --workspace "<root>" --at "<instant>"
   pnpm --silent exec tcrn-workflow validate --workspace "<root>"
   ```

   `recover` clears `.tmp-` residue under `events/` and `views/`. `validate` must
   report a valid workspace before you copy anything.
3. **Write the receipt.** Take the manifest and save stdout verbatim as the
   receipt file:

   ```
   pnpm --silent exec tcrn-workflow snapshot-manifest --workspace "<root>" --at "<instant>" > "<receipt>"
   ```

   The manifest is a deterministic canonical JSON document: sorted per-file
   sha256, the workspace `headEventHash`/`version`/`workspaceId`, and the embedded
   validate result for both stores. It excludes the held `lease/` subtree and the
   in-flight claim residue classes (SDC-9), so it matches the copy byte-for-byte
   only after the lease is released.
4. **Copy the tree.** Copy `.tcrn-workflow` with OS tools to a destination
   **outside** `<root>`:

   ```
   cp -R "<root>/.tcrn-workflow" "<destinationParent>/.tcrn-workflow"      # macOS/Linux
   robocopy "<root>\.tcrn-workflow" "<destinationParent>\.tcrn-workflow" /E   # Windows
   ```

   The manifest was taken under a held lease and the lease is released before this
   step, so `lease/` is absent from both the manifest and the copy.
5. **Prove the copy.** Verify the copy against the saved receipt:

   ```
   pnpm --silent exec tcrn-workflow snapshot-verify --root "<destinationParent>" --manifest "<receipt>"
   ```

   `SNAPSHOT_VERIFIED` means the copy is byte-identical to the snapshotted tree.
   Any other result: do not keep the copy as a backup.

## RESTORE

1. **Quiesce.** End every agent session against `<root>`. Never restore over a
   live workspace.
2. **Copy the tree back to the ORIGINAL path.** Same-path doctrine — the
   destination is the exact `<root>` the snapshot came from:

   ```
   cp -R "<destinationParent>/.tcrn-workflow" "<root>/.tcrn-workflow"      # macOS/Linux
   robocopy "<destinationParent>\.tcrn-workflow" "<root>\.tcrn-workflow" /E   # Windows
   ```

   Restore the WHOLE control tree, both stores together — never a partial restore.
3. **Prove the restored tree.** Verify the original path against the saved
   receipt:

   ```
   pnpm --silent exec tcrn-workflow snapshot-verify --root "<root>" --manifest "<receipt>"
   ```

   Expect `SNAPSHOT_VERIFIED`.
4. **Validate both stores.**

   ```
   pnpm --silent exec tcrn-workflow validate --workspace "<root>"
   pnpm --silent exec tcrn-workflow knowledge-validate --workspace "<root>"
   ```

   Both must pass before agents resume.

## Empty-directory recreation list

OS copy (`cp -R`, `robocopy /E`) preserves empty directories, so the copy runbook
above needs no recreation step. A git-based restore (see `backup-git-tier.md`)
does: git does not track empty directories, and these control-tree directories are
required by the engine even when empty. Recreate them before step 4's `validate`:

- `.tcrn-workflow/backups/` — always empty in V1, required as a directory by
  `resolveWorkspace` (`WORKSPACE_PATH_INVALID` when missing). It is
  migration-reserved and is never a user backup destination.
- `.tcrn-workflow/knowledge/bodies/` — empty until the first knowledge unit;
  required by `scanKnowledgeStore` (`KNOWLEDGE_PARTIAL_STATE` when the store root
  entries are not exact).
- `.tcrn-workflow/knowledge/metadata/` — empty until the first knowledge unit;
  required by `scanKnowledgeStore` (same rule).

The `.gitkeep` workaround is inadmissible inside `knowledge/`: the store's exact
root-entry rule rejects any extra entry. Recreate the bare directories instead.

## Expected-failure table (SDC-9)

Each reason code below exists verbatim in the source (`WORKSPACE_REASON_CODES`,
the KNOWLEDGE reason-code list, or `SNAPSHOT_REASON_CODES`). If a step reports one
of these, stop and follow the action — do not force past it.

| Reason code | What it means | Action |
| --- | --- | --- |
| `SNAPSHOT_RESIDUE_PRESENT` | The tree carries crashed-session quarantine residue (`stale-lease-*`, `released-*`, `attempt-owned-*`); a snapshot over it would bake partial state into the receipt | Remove the named quarantine directory by hand, then re-run the SNAPSHOT procedure from step 2 |
| `SNAPSHOT_MISMATCH` | The copy differs from the manifest at the named path — corrupt or truncated copy | Discard the copy and re-copy from a verified source; do not restore from it |
| `WORKSPACE_SCHEMA_INVALID` | Restored to the wrong path or a second machine (root-identity mismatch) | Restore in place at the exact original `<root>` on the original machine (same-path doctrine) |
| `KNOWLEDGE_HIGH_WATER_MISMATCH` | Partial restore — the workspace and knowledge stores are out of lockstep | Restore the WHOLE control tree so both stores return together; partial restore is unrecoverable by design in V1 |
| `WORKSPACE_VIEW_STALE` | Derived views drifted from the event log | Run `recover --workspace "<root>" --at "<instant>"`, then `validate` |
| `WORKSPACE_LOCKED` | A live lease holder is present — the workspace was not quiesced | End all agent sessions and retry |
| `WORKSPACE_PATH_INVALID` | A required control-tree directory is missing (e.g. an empty directory a git restore dropped) | Recreate the missing directory (see the recreation list), then re-run `validate` |

## Anti-promises

- **Archives are not restorable.** `tcrn.workspace-archive.v1` checkpoint anchors
  are integrity anchors, not backups: V1 has no import path for them. Do not treat
  an archive as a restore source.
- **`.tcrn-workflow/backups/` is migration-reserved.** It is created empty at init
  and is never a user backup destination. Copy snapshots to a destination outside
  `<root>`, never into `backups/`.
- **No live-sync.** Never place a live workspace under a cloud/network sync client
  or a symlink/junction. Snapshot a quiesced tree; restore in place.

## Cross-references

- ADR 0002 — snapshot-not-mirror doctrine (`docs/adr/0002-snapshot-not-mirror-backup.md`).
- Git tier-2 integrity witness (`docs/architecture/backup-git-tier.md`).
