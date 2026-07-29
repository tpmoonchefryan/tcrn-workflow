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

1. **Same-path-only for a RESTORE.** A restore targets the exact original path on
   the same machine. `resolveWorkspace` fail-closes `WORKSPACE_SCHEMA_INVALID`
   ("stored roots do not match their current filesystem identities") when the
   stored root `canonicalPath`/`portableIdentity` disagree with the live
   filesystem. Restore in place.

   Moving a workspace to a new path or a new machine is a different operation
   with its own governed route: the relocation verb family (`v0.9.0`, ADR 0003),
   documented in the RELOCATE section below. This doctrine used to say root
   rebind was out of scope "per OD-29"; that attribution was wrong — OD-29 is the
   manifest-scope decision — and the sentence is retired. Do NOT hand-edit
   `roots` to move a workspace: that is the bypass the relocation verbs exist to
   make non-accidental.
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

## RELOCATE — moving a workspace to a new path or a new machine

A relocation is not a restore. It moves the BINDING, never the bytes; the copy is
still yours to make with OS tools, and the engine still writes nothing at the
destination. Full rationale and the two ceilings are in
`docs/adr/0003-workspace-relocation.md`.

Order matters and is machine-enforced: **vacate, then copy, then adopt.** Copying
first and adopting is refused, deliberately, because copy-first is the operator's
natural instinct and must fail closed rather than produce an unauthorized live
target.

1. **Settle and prove green at the source.** `recover`, then `validate`. Vacate
   refuses `WORKSPACE_RELOCATION_UNSETTLED` on a tree carrying `.tmp-` residue —
   at the source, where `recover` can still fix it, rather than at the target
   where it cannot.
2. **Take the manifest and keep it.** `snapshot-manifest > control-manifest.json`.
   The adopt step needs this file; the ledger inside the copied tree holds its
   SHA-256, so a wrong or replayed manifest is refused by the tree itself.
3. **Mint the relocation authority.** A canonical
   `tcrn.workspace-relocation-authority.v1` document whose permit names the actor,
   the `workspaceId`, the destination workspace root, and the CURRENT
   `{version, headEventHash}` basis. It is per-invocation: an authority minted
   against an older basis is refused `WORKSPACE_RELOCATION_BASIS_STALE`.
4. **Vacate the source.** All five destination roots must be stated.

   ```
   pnpm --silent exec tcrn-workflow relocation-vacate \
     --workspace "<source>" --at "<instant>" --actor "<actor:id>" \
     --expected-version <n> \
     --to-framework "<dst-framework>" --to-workspace-root "<dst-workspace>" \
     --to-transient "<dst-transient>" --to-evidence-locator "<dst-evidence>" \
     --to-release-trust "<dst-release-trust>" \
     --relocation-authority "<auth.json>" --relocation-authority-digest "<sha256>"
   ```

   From this moment the source refuses every operation with
   `WORKSPACE_RELOCATION_VACATED`, except `lease-inspect` (pure diagnosis),
   `relocation-inspect` and `relocation-abort`. **Zero addresses are alive until
   the adopt lands** — that is the mechanized form of "it only works in one mode",
   and it is deliberately not a two-alive window.
5. **Copy the control tree with OS tools.** `cp -R`, `rsync -a` or
   `tar cf | tar xf`. Two blindnesses the manifest structurally cannot cover, and
   which adopt checks instead: a dropped EMPTY directory (`events/`, `views/`,
   `backups/`) and a carried-across lock or claim (`lease/`,
   `lease-recovery.claim`, `knowledge/mutation.claim`, `artifacts/restore.claim`).
   A copy tool that drops empty directories — `git` notably — is hostile here.
6. **Adopt at the destination**, restating the `relocationId` from the vacate
   receipt and passing the manifest from step 2. Adopt is idempotent: a retry
   returns `WORKSPACE_RELOCATION_ALREADY_ADOPTED` and changes no bytes.
7. **INSPECT BOTH ADDRESSES AND COMPARE. This step is mandatory.** Run
   `relocation-inspect` at the old address and at the new one. Exactly one must
   report `state: "live"` for a given `workspaceId`. This is the ONLY instrument
   that can detect a fork, it requires both trees present at once, and it is
   therefore by construction not something `verify` can run for you. A close-out
   that checks only the new address proves nothing about the fork this whole verb
   family exists to make visible. Record both outputs as gate evidence.

If the copy fails for any reason, `relocation-abort` at the source restores it
from the ledger's own `from` — no certificate file needed. Abort IS the
fork-creating move if the target already adopted, and the source cannot know
whether it did; what is guaranteed is that the contradiction is permanently
recorded in both files under one `relocationId`.

On a multi-partition platform, roots shared between partitions (typically
`framework` and `release-trust`) must be treated as an all-partitions operation
with a declared order. `relocation-inspect` reports `unmovedRoots` so the runbook
can check it; the engine cannot see sibling partitions and does not claim to.

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
- ADR 0003 — governed workspace relocation (`docs/adr/0003-workspace-relocation.md`).
- Git tier-2 integrity witness (`docs/architecture/backup-git-tier.md`).
