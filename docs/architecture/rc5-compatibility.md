# rc.4 → rc.5 Workspace Compatibility and Migration

This is the normative compatibility statement for a workspace control tree that
was written or read by an `0.1.0-rc.4` binary and is now used by an
`0.1.0-rc.5` binary (the governed-conference / gate / actor-attestation surface).
It records what stays readable, what fails closed on purpose, and the one-way
boundaries an operator must accept before enabling them.

All paths below are workspace-relative placeholders. `<root>` is the Workspace
authority root — the directory that contains `.tcrn-workflow/`. Paths with spaces
are first-class; always double-quote them. No hostnames or home paths appear in
this document, and none are written into a workspace by any procedure it
describes.

## The short version

| Direction | Behaviour |
| --- | --- |
| rc.4 workspace → rc.5 binary | **Fully readable.** A workspace that carries only the frozen `work-model-v1` operations (project/work) is byte-identical under rc.5; no migration step is required. |
| rc.5 workspace with only project/work events → rc.4 binary | **Readable.** `storageVersion` stays `1` and the on-disk shapes are unchanged, so an old binary reads it. |
| rc.5 workspace carrying conference / gate / attestation events → rc.4 binary | **Fails closed as corruption (intentional).** See the next section — this is forward-incompatibility, not data loss. |
| Attestation-enabled workspace → any binary | **One-way.** Once enabled, actor attestation cannot be turned off. See "Attestation is one-way". |

## Forward incompatibility is intentional, not data loss

The rc.5 surface adds additive workspace event-log operations —
`conference.created`, `conference.updated`, `conference.position.appended`,
`conference.closed`, `gate.created`, `gate.updated`, `gate.deleted`, and the
`attestation.actor.enabled` chain event. It does **not** bump the storage
version: `storageVersion` stays `1` (`WORKSPACE_STORAGE_VERSION = 1`).

This is the OD-20 forward-compatibility posture. An old rc.4 binary that replays
a chain containing one of these operations reaches the reducer's terminal
`fail("WORKSPACE_EVENT_CORRUPT", "unknown operation <operation>")` — it has no
reducer branch for the operation, so it stops rather than guessing. To an rc.4
user this surfaces as `WORKSPACE_EVENT_CORRUPT`, which reads like corruption. It
is not: the bytes are intact, the hash chain is sound, and an rc.5 binary reads
the same tree cleanly. The old binary is refusing an operation it does not
understand, exactly as a fail-closed engine should.

Two consequences follow from keeping `storageVersion` at `1`:

- A rc.5 workspace that has **never** appended a conference, gate, or attestation
  event is still readable by rc.4. Byte-stability for the no-extension case is a
  proven property, not a hope (see `EXT-CONFERENCE-GATE-STORE`): views, export,
  and archive bytes are identical to rc.4 for a workspace with no extension
  events, and the `views/extensions.json` index is emitted only when extension
  records exist.
- Because the version was not raised, there is no numeric downgrade signal. rc.4
  does not report `WORKSPACE_MIGRATION_FUTURE` (that fires only when an on-disk
  `storageVersion` is numerically greater than the binary's, and it is not).
  The refusal is per-operation, at replay time, via `WORKSPACE_EVENT_CORRUPT`.

**Operator guidance.** Treat "conference / gate / attestation" as an rc.5-only
capability. Once a workspace has appended any of these events, standardize its
whole toolchain on rc.5. There is no supported path that lets an rc.4 binary
read past an event it cannot reduce, and none is planned for V1.

## Attestation is one-way

Actor attestation is enabled by appending a single `attestation.actor.enabled`
chain event, via `attestation-enable` (CLI) or `enableActorAttestation` (engine).
The record is minimal (`{schemaVersion, version:1}`) and touches no record graph.

From the enabling event's sequence onward — that event included — a valid `actor`
id is **mandatory** on every appended event. The live append path and the replay
reducer enforce the identical rule:

- A mutation with no actor after enable fails closed `WORKSPACE_ACTOR_REQUIRED`.
- An actor whose id does not match the required shape fails
  `WORKSPACE_ACTOR_INVALID`.
- A hand-tampered log that drops or forges the actor on a post-enable event fails
  `WORKSPACE_ACTOR_REQUIRED` / `WORKSPACE_ACTOR_INVALID` at replay, so the
  binding cannot be edited out after the fact.

There is **no disable operation** in V1. Appending a second
`attestation.actor.enabled` to an already-attested workspace fails closed
`WORKSPACE_INPUT_INVALID` ("actor attestation is already enabled"), and no verb
removes the enable event. The `--actor` flag on the mutation verbs stays
catalog-optional because the **engine**, not the CLI vocabulary, makes it
mandatory once the event is present; on a non-enabled workspace, omitting
`--actor` produces a byte-identical result to rc.4.

**Operator guidance.** Enabling attestation is a deliberate, irreversible
governance decision for a workspace. Decide it once, up front. After it, every
tool and every automated caller that mutates the workspace must supply an actor
id; a caller that does not will fail closed on its first mutation.

## Knowledge stores: metadata schema evolution

The Knowledge Core store under `<root>/.tcrn-workflow/knowledge/` is a
**disposable derived index**, never the system of record. Its store marker
carries `disposable: true` and `authority: "metadata-index-authority-body-separate"`.
The system of record is the workspace event log (projects, work, conferences,
gates, decisions) — that authority is what is preserved across any knowledge
metadata schema change, because the event log's `storageVersion` stays `1`.

The knowledge store binds itself to a specific metadata schema version
(`tcrn.knowledge-unit-metadata.v1`) and to the workspace head via
`eventHighWaterDigest`. Two distinct maintenance paths exist, and they are not
interchangeable:

- **Head advance (same schema).** When the workspace head moves ahead of the
  store, re-bind with `knowledge-rebase`. It re-validates every record against
  the advanced head and re-binds without discarding units, failing closed
  `KNOWLEDGE_REBASE_BLOCKED` on records whose scope/project or linked-work
  references no longer resolve (unless you direct it to retire them as
  tombstoned audit records). Rebase is **not** a schema migration.

- **Metadata schema evolution (disposable re-init).** When the metadata schema
  itself evolves, the supported migration is to re-initialize a fresh disposable
  store and re-capture. There is no in-place metadata upgrader in V1 — the store
  is disposable precisely so none is needed.

### Disposable re-initialization procedure

1. **The authority is safe.** The workspace event log under
   `<root>/.tcrn-workflow/events/` is the system of record and is untouched by
   this procedure. Nothing below rewrites a workspace event.

2. **Remove the derived store.** Delete `<root>/.tcrn-workflow/knowledge/`. This
   is a derived index; its metadata and views are re-derivable and are not the
   source of truth. (`knowledge-init` writes a *new* store directory and will not
   overwrite an existing one, so the old store must be cleared first.)

3. **Re-initialize under explicit acknowledgment.**

   ```
   pnpm --silent exec tcrn-workflow knowledge-init --workspace "<root>" --acknowledge-disposable
   ```

   Every non-fixture workspace must pass `--acknowledge-disposable`; without it,
   initialization fails closed `KNOWLEDGE_DISPOSABLE_ACK_REQUIRED`. The
   acknowledgment is the operator affirming, per invocation, that this store is a
   disposable derived index. A fresh store reports `KNOWLEDGE_STORE_INITIALIZED`
   with `records: 0` and binds to the current workspace head.

4. **Re-capture units.** Re-create the knowledge units you need with
   `knowledge-create`, then re-run the governed lifecycle (`knowledge-promote`,
   `knowledge-reverify`, `knowledge-retire`) to restore promotion and freshness
   posture. Conference-distilled decisions are re-derivable by re-running
   `conference-close --distill` (or the distillation path) against the preserved
   conference minutes in the event log.

### Preserved vs re-derived

| Preserved (system of record, untouched) | Re-derived (disposable, rebuilt on re-init) |
| --- | --- |
| The workspace event log: projects, work, conferences, gates, decisions — every hash-chained event. | The knowledge metadata index and `views/` under `knowledge/`. |
| Conference minutes and gate evidence recorded as events. | Per-unit promotion state and freshness posture. |
| `storageVersion` and the workspace head. | The store marker's `eventHighWaterDigest` binding (re-bound to the current head at init). |

Because the durable authority is the event log, a metadata schema change never
risks the governed record. It costs a re-capture of the derived index, which is
what "disposable" buys.

## Capability vs pinned release

Use this table to decide which binary a workspace requires. "rc.4-safe" means an
rc.4 binary reads the workspace without error.

| Capability present in the workspace | Required binary | rc.4-safe? |
| --- | --- | --- |
| Only `work-model-v1` project/work events | rc.4 or rc.5 | Yes |
| Any conference event (`conference.*`) | rc.5 | No — `WORKSPACE_EVENT_CORRUPT` on rc.4 |
| Any gate event (`gate.*`) | rc.5 | No — `WORKSPACE_EVENT_CORRUPT` on rc.4 |
| Fail-closed gate enforcement (`WORKSPACE_GATE_PENDING`) exercised | rc.5 | No — the pending-gate event is a `gate.*` event |
| `attestation.actor.enabled` appended | rc.5 | No — unknown operation on rc.4, and one-way thereafter |
| Knowledge store on the evolved metadata schema | rc.5 | Store is disposable; event-log authority stays rc.4-safe |

The knowledge store row is deliberately separate: the store is not part of the
workspace event log, so its schema does not change the rc.4-safety of the
authority. Only the derived index needs the newer binary to read.

## Reason codes referenced

Every code below is emitted by the shipped engine; grep the source to confirm.

- `WORKSPACE_EVENT_CORRUPT` — the fail-closed reducer verdict, including the
  `unknown operation` refusal an rc.4 binary hits on an rc.5-only event.
- `WORKSPACE_ACTOR_REQUIRED` / `WORKSPACE_ACTOR_INVALID` — mandatory-actor
  enforcement after attestation is enabled, live and on replay.
- `WORKSPACE_INPUT_INVALID` — a duplicate `attestation.actor.enabled` (already
  enabled).
- `WORKSPACE_GATE_PENDING` — a pending gate refusing a work transition to `done`.
- `WORKSPACE_MIGRATION_FUTURE` / `WORKSPACE_MIGRATION_DOWNGRADE` — the numeric
  storage-version guards; not triggered by the rc.4 → rc.5 additive events,
  documented here so operators know they are a different mechanism.
- `KNOWLEDGE_DISPOSABLE_ACK_REQUIRED` — `knowledge-init` without
  `--acknowledge-disposable` on a non-fixture workspace.
- `KNOWLEDGE_REBASE_BLOCKED` — a head-advance rebase over records whose
  references no longer resolve.
- `KNOWLEDGE_HIGH_WATER_MISMATCH` — the store bound to a workspace head it no
  longer matches (the lockstep binding; see `backup-restore-runbook.md`).
- `KNOWLEDGE_STORE_INITIALIZED` — a fresh disposable store after re-init.
