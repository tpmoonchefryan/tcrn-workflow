# P3 decision: live compaction deferred to storage version 2

- Status: Accepted per program authorization (recommended default, OD-7)
- Date: 2026-07-17
- Governs: WSA-6 (compaction deferral and 10k-cap analysis)
- Depends on: WSA-1, WSA-2 (single O(delta) replay), WSA-5 (operation-count proof)
- Registers with: the "Migration window" section of
  `packages/core/spec/file-engine-v1.md`, the single normative home for the
  V1 storage boundary

## Decision

The engine keeps the frozen `PROTOCOL_LIMITS.maxRecords = 10_000` ceiling
(`packages/protocol/src/index.ts`) with O(n)-read mutations for V1. Live
compaction — rewriting the authoritative event chain to reclaim budget spent on
tombstones, revisions, and closed decision cycles — is **out of V1 scope**. It is
admissible only as a future storage-version-2 migration that supplies the exact
backup, transformation, post-validation, and rollback contract the V1 migration
planner already dry-runs (`planWorkspaceMigration`), and that the V1 apply path
deliberately withholds (`applyWorkspaceMigration` fails closed with
`WORKSPACE_MIGRATION_APPLY_UNAVAILABLE`). This deferral is recorded, not implied,
because it names a protocol-sensitive precondition (storage version 2).

## Post-fix cost model (analytical, no wall-clock)

After WSA-1/WSA-2 landed, a committed mutation performs exactly one full replay
and no per-event full-graph validation. The operation counts below are the
closed-form quantities the WSA-5 instrumentation asserts
(`packages/core/src/workspace-perf-instrumentation.ts`), proven by the claims
**P3-ENGINE-SINGLE-REPLAY-PIPELINE** (`fullMaterialize == 1` per mutation) and
**P3-ENGINE-INCREMENTAL-REPLAY** (`terminalGraphValidation == 1`,
`closureValidation == work-event count`, closure records bounded by the four-level
Initiative → Epic → Story → Subtask hierarchy).

Let `n` be the chain length (event count) and `segmentEventLimit = 64` (the
engine default). Per committed mutation:

| Operation (per mutation) | Count | Growth |
| --- | --- | --- |
| Full chain replay (`fullMaterialize`) | 1 | reads `ceil(n / 64)` segment files, hashing every event for genesis-anchored chain verification |
| Terminal full-graph validation (`terminalGraphValidation`) | 1 | O(active records) |
| Per-event closure validation (`closureValidation`) | one per work event | each O(delta), ancestor-bounded to ≤ 4 records visited |
| View rewrite | 1 | O(active records) |

Segment files read per replay, `ceil(n / 64)`:

| Chain length `n` | Segment files read | Per-event full-graph validations |
| --- | --- | --- |
| 1,000 | 16 | 0 (one terminal only) |
| 5,000 | 79 | 0 (one terminal only) |
| 10,000 (cap) | 157 | 0 (one terminal only) |

The per-mutation cost is therefore strictly linear in `n` plus a term linear in
the active-record count — there is no quadratic term. At the ceiling this is a few
hundred small canonical-JSON reads and one terminal validation per mutation.

**Conclusion.** 10,000 events is serviceable for a single MVP workspace without
compaction. Compaction reclaims chain budget; it does not lower per-mutation
asymptotic cost, which is already linear. The ceiling is the reason to stop
growing the chain, not a reason to rewrite it in V1.

## The version-counts-events nuance (normative)

The cap is enforced against the **event count**, not the live-record count:
`assertWorkspaceRecordCount(state.version + 1)` guards each append and
`assertWorkspaceRecordCount(events.length)` guards each replay
(`packages/core/src/workspace.ts`), failing `WORKSPACE_RECORD_LIMIT`. Because
`version` counts every appended event — creates, updates, transitions, tombstones,
resurrections, and every extension event — the ceiling binds earlier than the word
"records" suggests. A workspace with 10,000 live records is unreachable; a
workspace reaches the ceiling at 10,000 **events**, including all history.

## Event inflation from WS-D / WS-E (updated analysis)

The original deferral was reasoned against project/work mutation volumes only.
The conference, gate, and attestation surfaces landed since then materially
increase events per unit of decided work, so the updated analysis models a
conference-heavy workload:

- **Conferences** (WSD-2/WSD-3): each decision cycle emits `conference-open`, one
  `conference-append-position` per recorded position, and `conference-close` —
  several events per cycle rather than one.
- **Gates** (WSD-1/WSD-4): `gate-create`, one or more `gate-transition`, and
  `gate-delete` across a gate's lifecycle.
- **Attestation** (WSE-2/WSE-3): `attestation-enable` is a one-time
  workspace-boundary event; the per-event `--actor` field (WSE-3) and `eventRefs`
  linkage (WSE-5) enlarge payloads without adding events.

These extension events are counted by `extensionClosureValidation` /
`extensionClosureRecordsVisited`, kept separate from the work closures (SDC-3) so
each remains O(delta) and ancestor-bounded — they do **not** change the linear
per-mutation cost. Their effect is on **arrival**: a conference- and gate-heavy
workflow consumes the 10,000-event budget in fewer decided-work units than a
project/work-only workflow. The ceiling therefore should be read per
decision-cycle event yield, not per deliverable, when sizing a workspace.

## Why live compaction is not admissible in V1 (five collision points)

Rewriting the authoritative chain collides with five load-bearing invariants:

1. **Genesis-anchored hash-chain verification.** Chain integrity is checked from
   the genesis anchor forward over the read segments (`validateEventChain` over
   `readSegmentEvents`); a compacting rewrite breaks the hash anchor it verifies
   against.
2. **Recovery never discards authoritative corruption** (the `file-engine-v1.md`
   recovery rule). Compaction is exactly a discard of authoritative history, which
   the recovery contract forbids.
3. **Tombstone and resurrection admission depend on full history.** Whether a
   record may be resurrected is decided from its complete event lineage;
   collapsing that lineage removes the admission basis.
4. **Byte-identical export / archive checkpoints depend on the full chain.**
   Canonical export bundles are checkpoint anchors over the whole chain; a rewrite
   changes their bytes and voids the checkpoint promise (export is plan/dry-run,
   with no governed re-import).
5. **The V1-only storage window is fail-closed.** `applyWorkspaceMigration` has no
   real apply path (`WORKSPACE_MIGRATION_APPLY_UNAVAILABLE`), so there is no
   governed mechanism in V1 that could perform a compacting rewrite with the
   required safety envelope.

## Deferral target

Compaction is deferred to a future **storage-version-2 proposal** requiring, per
the existing migration contract (`planWorkspaceMigration`): an exact pre-migration
backup, a defined transformation, full target-schema and full event-chain
post-validation after transformation, and an exact rollback. Admitting it earlier
would require weakening one of the five invariants above or forcing a frozen
artifact — neither is in scope.

The executable expression of this deferral remains the migration-boundary tests in
`tests/p3-file-engine.test.mjs` (`WORKSPACE_MIGRATION_DOWNGRADE`,
`WORKSPACE_MIGRATION_FUTURE`, `WORKSPACE_MIGRATION_APPLY_UNAVAILABLE`): apply stays
unavailable, downgrades and unknown future versions fail closed.

## Owner sign-off (GD-1)

Ratified per the program implementation authorization (recommended default):
**sign the compaction deferral** — accept the 10,000-event ceiling with
O(n)-read mutations for V1, compaction only via a future storage-version-2
migration, with the analysis updated to model conference/gate/attestation event
inflation from WS-D/WS-E (OD-7; GAP-13). Sign-off recorded before WSA-6 merges.
