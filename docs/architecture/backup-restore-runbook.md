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
2. **Plan the hop and keep the plan.** `relocation-plan` (read-only, same flags as
   the vacate) emits `relocationId`, the `basis`, and `controlManifest`. Write the
   manifest text to `control-manifest.json`: the adopt step needs it, and **after
   the vacate commits no address can produce it again** — `snapshot-manifest`
   refuses the source with `WORKSPACE_RELOCATION_VACATED` and the copy with
   `WORKSPACE_RELOCATION_ADOPTION_REQUIRED`. The vacate receipt carries the same
   text as a second copy, so losing it is recoverable; skipping the plan is not a
   shortcut, because the authority in step 3 must name the id this step computes.

   **Check `hopsRemaining` in the plan output before you start.** The relocation ledger
   holds sixteen entries and a hop costs two of them whether or not a single byte moves,
   so a workspace gets EIGHT attempts for its whole life — an abandoned move that ends in
   `relocation-abort` spends one of them. Nothing gives an entry back, no verb prunes or
   compacts the ledger, and the only route past an exhausted budget is the ungoverned
   hand-edit this design exists to make illegible. At a full ledger the plan itself
   refuses with `WORKSPACE_RELOCATION_LEDGER_FULL`, before you mint anything.
3. **Mint the relocation authority.** A canonical
   `tcrn.workspace-relocation-authority.v1` document. Each permit names the actor,
   the `workspaceId`, the destination workspace root, the CURRENT
   `{version, headEventHash}` basis, the `relocationId` from step 2, and ONE
   `stage` — `vacate`, `adopt` or `abort`. **Mint the vacate and adopt permits now.
   An abort permit cannot be in this document**: it must also name the hop's
   `vacateCommitmentSha256`, which is a digest of the committed `vacated` ledger entry
   and therefore of the digest of this very file. That is arithmetic, not discipline —
   the abort is necessarily a second document minted after the vacate, and the ledger
   records the two different authority digests forever.

   One permit authorizes exactly one hop and exactly one verb of it. An authority
   minted against an older basis is refused `WORKSPACE_RELOCATION_BASIS_STALE`;
   one that names a different hop, destination, workspace or stage is refused
   `WORKSPACE_RELOCATION_NOT_PERMITTED`; an abort permit naming the wrong commitment is
   refused `WORKSPACE_RELOCATION_VACATE_COMMITMENT_MISMATCH`. Reuse across hops is not
   possible: the id is derived over the hop's own content, so the next hop has a
   different one. **Reuse of the SAME hop is possible and is a stated ceiling** — a
   permit is a predicate over the bytes presented at a path, not a token with a spend
   record, so one adopt permit admits the same shipped tree at the same path on as many
   hosts as it is presented to (ADR 0003, ceiling 4).
4. **Vacate the source.** All five destination roots must be stated. A hop that
   leaves the workspace root where it is (moving only `framework`,
   `release-trust`, `transient` or `evidence-locator`) is REFUSED at the plan and
   at the vacate with `WORKSPACE_RELOCATION_INPUT_INVALID`: the ledger keys its
   whole state machine on the workspace root, so such a hop would kill the source
   and could never be adopted. Moving a shared root while the workspaces stay put
   is a real operation — it is simply not a relocation, and it needs its own
   plan (see the multi-partition note below). A destination nested inside the
   source workspace root is refused for the same class of reason.

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
   `relocation-inspect --workspace <address> --at <instant>` at the old address and at
   the new one. Exactly one must report `state: "live"` for a given `workspaceId`. It
   requires both trees present at once and is therefore by construction not something
   `verify` can run for you. Record both outputs as gate evidence. `--at` is your
   declaration of when the observation was taken; it is stamped into the document as
   `observedAt` and is what makes a document usable as an abort's `--target-inspection`.

   **What this compare proves, exactly:** that the two addresses the ledger names
   **on the two hosts where you ran it** have not both stayed live. It cannot see an
   address the ledger does not name. A
   third tree made by copying the control tree, deleting `relocations` and
   rewriting `roots` is a fully live authority for the same chain and is
   indistinguishable from a workspace that never relocated — that is the
   pre-`0.9.0` hand-edit hole, which this design does not close. **And it cannot see a
   second host that adopted the same shipped tree at the same path under the same
   permit: the compare is green at every one of them** (ADR 0003, ceiling 4). A green
   close-out is not a proof that no fork exists; it is a proof about these two
   addresses on these two hosts.

   A `state` of `foreign-address` at a tree you expected to be the destination,
   with `nearMissDestination: true`, means the ledger names this tree under a
   different SPELLING of its path (a case difference on a case-insensitive volume
   is the usual cause). State the destination exactly as `realpath` renders it on
   the destination host.

If the copy fails for any reason, `relocation-abort` at the source restores it from
the ledger's own `from` — no certificate file needed. **Abort IS the fork-creating
move if the destination already adopted, and the source cannot know whether it
did.** It therefore costs three things rather than one:

- a permit minted for THIS hop's `abort` stage AND naming this hop's
  `vacateCommitmentSha256` (take it from the vacate receipt, or from
  `relocation-inspect` at the vacated address if the receipt is gone). The vacate's own
  document cannot carry it — that was the exact move two adversarial reviews used to
  fork a workspace with engine verbs only. **This is a review device, not a barrier:
  whoever can mint the vacate permit can mint the abort permit, and the engine can
  neither authenticate a minter nor observe when a document was minted. What it buys is
  two documents, two approvals and two different authority digests in the ledger;**
- `--acknowledge-fork-risk true`, which proves nothing and is a ceremony;
- `--target-inspection <file>` whenever you can reach the destination: pass the
  destination's own `relocation-inspect` output. The engine checks THE DOCUMENT — that
  it names this hop's destination, that its declared `observedAt` is within one hour of
  this abort's `--at` and not after it, and that it reports `adoption-required`. It
  refuses `WORKSPACE_RELOCATION_TARGET_ADOPTED` when the document reports an adopted
  destination, and `WORKSPACE_RELOCATION_INSPECTION_STALE` when the two declared
  instants do not agree. **It cannot tell you what the destination is doing right now:
  both instants are yours, the source is offline with respect to the destination, and a
  destination that has not yet adopted may still adopt a minute later.** It is optional
  only because the legitimate abort — the copy was never made, the destination is
  unreachable — has no destination to inspect. The receipt records
  `targetInspectionSupplied`, and when a document was supplied its
  `targetInspectionSha256` and `targetInspectionObservedAt`.

**After an abort, DESTROY THE COPY.** This is the half the compliant abort leaves open
and no engine check can reach: the untouched copy still carries a valid trailing
`vacated` entry, nothing at the destination can ever learn that the source aborted, and
the copy therefore stays adoptable indefinitely. The `forkRisk` statement in the receipt
and in every later inspection names both tenses for this reason. Delete the shipped tree
and any retained tarball of it; a standby host restoring that tarball at the destination
path and following step 6 produces a second live authority with every check green.

What is guaranteed is that the contradiction is permanently recorded in both files
under one `relocationId`, and that every later `relocation-inspect` at an aborted
address carries the `forkRisk` statement.

On a multi-partition platform, roots shared between partitions (typically
`framework` and `release-trust`) must be treated as an all-partitions operation
with a declared order. `relocation-inspect` reports `unmovedRoots` so the runbook
can check it; the engine cannot see sibling partitions and does not claim to. Note
the boundary this draws: a relocation always moves the workspace root, so "move the
shared framework install and leave the workspaces where they are" is NOT expressible
as a relocation and is refused at the plan. Such a move is a filesystem operation
plus a relocation per partition whose workspace roots also move, or it is out of
scope for this verb family.

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
