# Git as a Tier-2 Integrity Witness

Git is the recommended tier-2 backup for a workspace control tree, but **only as
an integrity witness — never as a restore mechanism.** The control tree is
canonical JSON (stable bytes, meaningful diffs), and git's content-addressed hash
tree is an integrity witness **independent** of the engine's own event-chain
hashes: corruption must fool two unrelated hash systems to pass unnoticed. Restore
always routes through the OS-copy procedure in `backup-restore-runbook.md`, because
git cannot reproduce the empty directories the control tree structurally requires
(see the recreation appendix below). Use git to *detect* drift; use the copy
runbook to *recover* from it.

All paths below are workspace-relative placeholders. `<root>` is the Workspace
authority root — the directory that contains `.tcrn-workflow/`. Paths with spaces
are first-class; always double-quote them.

## Where to `git init`

Initialize the repository at the **workspace root**, so the control tree is tracked
as `.tcrn-workflow/**`:

```
cd "<root>"
git init
```

Do **not** `git init` inside `.tcrn-workflow`. `resolveWorkspace`'s bound-directory
checks tolerate extra control-dir entries today, but the knowledge store already
enforces exact-entry membership (`scanKnowledgeStore`'s `expectedRootEntries` rule
in `knowledge-core.ts` fails `KNOWLEDGE_PARTIAL_STATE` "knowledge store root entries
are not exact"), which is the project's stated direction. A `.git` directory living
inside the control tree is one storage-version bump away from bricking the store.
Track the control tree from outside it.

## What to ignore

Committing lease state or in-flight claims would make a clone or checkout resurrect
crashed-session residue that `snapshot-manifest` fail-closes on
(`SNAPSHOT_RESIDUE_PRESENT`) and that the stores reject on their own
(`KNOWLEDGE_PARTIAL_STATE`, `ARTIFACT_PARTIAL_STATE`). Put exactly these lines in
`<root>/.gitignore`:

```gitignore
.tcrn-workflow/lease/
.tcrn-workflow/lease-recovery.claim
.tcrn-workflow/knowledge/mutation.claim
.tcrn-workflow/knowledge/released-*
.tcrn-workflow/artifacts/restore.claim
.tcrn-workflow/artifacts/released-restore-*
.tcrn-workflow/stale-lease-*/
.tcrn-workflow/released-*
.tcrn-workflow/attempt-owned-*
.tcrn-workflow/**/.tmp-*
```

### Source of each ignored path

Every pattern maps to an engine constant. The taxonomy is the SDC-9 residue set
that `workspace-snapshot.ts` (`EXCLUDED_RELATIVE_PATHS`, `RESIDUE_PREFIX`,
`TEMPORARY_PREFIX`) already excludes from the snapshot manifest; the git ignore list
is that same taxonomy plus the two store-local claim classes.

| Ignore pattern | Source | Why it must never be committed |
| --- | --- | --- |
| `.tcrn-workflow/lease/` | `acquireWorkspaceLease` writes `controlPath(root, "lease")` (`workspace.ts`); excluded by `EXCLUDED_RELATIVE_PATHS` | The held lease is live session state; a committed lease resurrects a phantom holder (`WORKSPACE_LOCKED`). Ignoring `lease/` also covers `released-mutation-*`, which lives *inside* `lease/` (dirname of `lease/mutation.claim`) and is therefore not a distinct top-level pattern. |
| `.tcrn-workflow/lease-recovery.claim` | `controlPath(root, "lease-recovery.claim")` (`workspace.ts`); excluded by `EXCLUDED_RELATIVE_PATHS` | Crash-recovery claim; committing it replays a half-finished recovery. |
| `.tcrn-workflow/knowledge/mutation.claim` | `scanKnowledgeStore` (`knowledge-core.ts`) fails `KNOWLEDGE_PARTIAL_STATE` "mutation claim is present"; excluded by `EXCLUDED_RELATIVE_PATHS` | An in-flight knowledge mutation; a clone carrying it bricks the store. |
| `.tcrn-workflow/knowledge/released-*` | the `released-<token>` quarantine directory under the knowledge store root in `knowledge-core.ts` | The knowledge release quarantine that leaks on a crash mid-release. If committed, it becomes an extra knowledge-root entry that bricks the store via the exact-entry rule (`KNOWLEDGE_PARTIAL_STATE`). |
| `.tcrn-workflow/artifacts/restore.claim` | `resolve(storeRoot, "restore.claim")` in `artifact-lifecycle.ts` fails `ARTIFACT_PARTIAL_STATE` "restore claim is present" | A partial artifact restore; committing it resurrects `ARTIFACT_PARTIAL_STATE`. |
| `.tcrn-workflow/artifacts/released-restore-*` | the `released-restore-<token>` quarantine directory under the artifact store root in `artifact-lifecycle.ts` | The artifact restore-claim quarantine; same `ARTIFACT_PARTIAL_STATE` hazard on clone. |
| `.tcrn-workflow/stale-lease-*/` | `RESIDUE_PREFIX` (`workspace-snapshot.ts`) fails `SNAPSHOT_RESIDUE_PRESENT` | A crashed-session lease quarantine. |
| `.tcrn-workflow/released-*` | `RESIDUE_PREFIX` (`workspace-snapshot.ts`) | Top-level workspace release quarantines (`released-lease-*`, `released-recovery-*`). |
| `.tcrn-workflow/attempt-owned-*` | `RESIDUE_PREFIX` (`workspace-snapshot.ts`) | Attempt-owned quarantine residue. |
| `.tcrn-workflow/**/.tmp-*` | `TEMPORARY_PREFIX` — `atomicWrite` stages under `.tmp-<pid>-<seq>` before rename (`workspace.ts`) | Half-written atomic-write temporaries at any control level. |

## Commit cadence

Commit at **gate-close** and **session-end** — the two quiescent points. Use the
workspace `headEventHash` as the commit message, so every commit is externally
joinable to the engine's event chain. Read it from `status` (the `status` verb
writes it via `writeState` in `cli/src/index.ts`):

```
git -C "<root>" commit -am "$(pnpm --silent exec tcrn-workflow status --workspace "<root>" | node -e 'process.stdin.once("data",d=>process.stdout.write(JSON.parse(d).headEventHash??"empty"))')"
```

A commit message that is the head hash lets an auditor line up any git commit
against a specific point in the event log without opening the tree.

## Why an independent witness

The engine already hashes its own event chain: each event carries `eventHash`, and
the knowledge marker binds `eventHighWaterDigest` to the workspace `headEventHash`.
Those hashes prove *internal* consistency. Git's blob/tree SHA-1 (or SHA-256) object
model is computed by unrelated code over the raw file bytes. For silent corruption
to survive, it would have to produce a byte sequence that is simultaneously
consistent with the engine's event-chain hashes **and** identical under git's object
hashing — two independent hash systems. `git status` / `git diff` against the last
green commit is therefore a cheap, out-of-band tamper check that does not trust the
engine to audit itself.

## Warning: git working-tree operations are a live-sync-class hazard

`git checkout`, `git clean`, `git stash`, and `git reset --hard` **rewrite the
working tree in place**. Run against a *live* workspace they are the same class of
hazard as a cloud/network sync client mutating files under the engine: they can
truncate, replace, or partially write control-tree files while the engine believes
it holds them. **Quiesce first** — end every agent session so no lease is held —
before any git working-tree operation, exactly as the snapshot procedure requires.

A `git checkout` of an older commit *is* a restore, and V1 restore is same-path,
whole-tree, and lockstep only. Do **not** use `git checkout` to restore: it drops
the empty directories the engine requires (next section) and can desynchronize the
two stores. Route every restore through the OS-copy procedure in
`backup-restore-runbook.md`, then `validate` + `knowledge-validate`.

## Appendix: why git cannot restore (empty-directory recreation)

Git does not track empty directories, and the control tree requires several that are
empty in a fresh or between-unit state. A clone- or checkout-based restore therefore
drops them and fail-closes:

- `.tcrn-workflow/backups/` — created at init and required as a directory at every
  `resolveWorkspace` (`ensureDirectory`/`boundDirectory` on `controlPath(root,
  "backups")` in `workspace.ts`; `WORKSPACE_PATH_INVALID` when missing). It is
  **always empty in V1** (migration-reserved, never a user backup destination).
- `.tcrn-workflow/knowledge/bodies/` — required by `scanKnowledgeStore`
  (`boundDirectory` on `bodies`); empty until the first knowledge unit.
- `.tcrn-workflow/knowledge/metadata/` — required by `scanKnowledgeStore`
  (`boundDirectory` on `metadata`); empty until the first knowledge unit.

The `.gitkeep` workaround is **inadmissible inside `knowledge/`**: the store's exact
root-entry rule (`expectedRootEntries` = `bodies`, `metadata`, `store.json`, `views`)
rejects any extra entry, and the metadata/body name regexes reject non-knowledge
files. There is no committable placeholder that survives the store's validation.

This is the structural reason git is witness-only: even after recreating the three
bare directories by hand, a git checkout still risks store desynchronization, so the
supported restore is always the byte-for-byte OS copy in the restore runbook. The
recreation list is documented here (and in `backup-restore-runbook.md`) only so an
operator who has performed a git checkout despite this warning can bring the tree
back to a shape `validate` will accept before switching to the copy runbook.

## A clone preserves single-link identity

The engine requires every control-tree file to be a single-link regular file
(`boundFile` fails `WORKSPACE_PATH_INVALID` "must be a single-link regular file" on
`nlink !== 1`, `workspace.ts`). `git gc` and `git clone` write fresh files on
checkout, so `nlink == 1` holds — a clone-based *inspection* does not itself break
the single-link rule the way a hardlink-deduplicating sync client would. This is a
property of the checkout, not a license to restore from it: same-path, whole-tree,
copy-runbook restore remains the only supported path.

## Cross-references

- Restore runbook — the only supported restore path (`docs/architecture/backup-restore-runbook.md`).
- ADR 0002 — snapshot-not-mirror doctrine (`docs/adr/0002-snapshot-not-mirror-backup.md`).
