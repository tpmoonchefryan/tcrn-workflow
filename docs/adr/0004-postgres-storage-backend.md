# ADR 0004: PostgreSQL storage backend for governed workspaces

Status: accepted (TCRN-CROSS-STORY-171, direction D1–D5′ of MIN-063/MIN-064)

Supersedes the file-tree storage backend as the **production track** for the five
governed chains. The file backend remains the **local-mode track** and the
**migration/verification instrument**. This ADR does not touch `MIN-060 D4`
("only local mode writes local files") — see section 8.

## Context

The engine stores a governed workspace's truth as canonical byte files under
`.tcrn-workflow/`: a `workspace.json` metadata file (whose tenth, optional field
carries the relocation ledger), numbered segment files under `events/` holding
canonical-JSON event records, derived `views/`, and two disposable stores
(`knowledge/`, `artifacts/`) each with their own marker and claim files. Every
mutation is an `atomicWrite` (fsync → rename → identity-verify → parent-dir
sync), every read is a `boundFile`/`boundDirectory` with symlink and
single-link enforcement, and single-writer semantics are a filesystem lease
(`lease/owner.json` with a pid liveness probe) plus a mutation claim.

`MIN-063`/`MIN-064` directed: (D1) AOS becomes the single read/write facade in
front of the engine, co-resident with the chains; (D2) the storage backend moves
from the canonical byte file tree to a database behind a storage abstraction;
(D3′) PostgreSQL single instance on the VM bound to loopback, one chain schema
per chain, GRANT-mechanised "only the engine writes a chain"; (D4′) a single
one-window full migration, file tree → read-only archive, SSH read-forwarding
retired in the same window, rollback = reverse migration; (D5′) the INIT-019
sequencing gate is lifted, with INC-061..071 verified item-by-item inside this
initiative.

## Decision

A PostgreSQL backend implemented behind a storage abstraction, with the file
backend converged onto the same interface so both stay byte-equivalent and the
existing test suite keeps running against both. Decisions that `MIN-063/064`
left open are settled here rather than deferred to execution: PG version, schema
layout, interface granularity, and lease form. Each section states its
judgement and the criterion that would turn it red.

### 1. Instance topology and version (STORY-171.1)

**Verdict: one PostgreSQL 18 instance on the private VM, bound to loopback,
reached only through the SSH tunnel the facade owns.**

- **Version: PostgreSQL 18.** Measured 2026-08-06 via `apt-cache policy
  postgresql` on the private VM (`Ubuntu 26.04 LTS`, candidate
  `18+290ubuntu1`). PG 18 is the newest major available on the host's own
  distribution, which is the sourcing criterion: a distribution-provided
  version gets backported security fixes without a third-party APT source.
  Recheck: `ssh <vm-host> "apt-cache policy postgresql"`.
- **Upgrade path.** Annual major-version assessment (the ADR 0004 review
  rhythm). In-place upgrades run `pg_upgrade` at a low-traffic point **outside**
  the switch window; the write side of a major bump is gated by the next
  mandated release stop. A minor upgrade is a package update plus restart.
- **systemd unit.** `tcrn-postgres.service`, `Restart=on-failure`,
  `LimitNOFILE` raised, WAL on the same data dir (single host, single disk
  class), data dir under `<private-data-root>/postgres` (outside the rsynced cockpit
  `runtime/`), `pg_hba.conf` with only `local` peer for `root`→`postgres` admin
  and `local` peer for the engine role (below), no `host` lines for any chain
  schema.
- **Binding.** `listen_addresses = '<loopback>'` hard-coded in
  `<private-config-root>/postgresql.conf`, mirroring the cockpit bind
  (CONF-007 D7 precedent). No environment variable moves it.
- **Backups** are taken on the VM (both halves on one host) and pulled to this
  machine as the off-site copy — the pull direction re-ruled in `MIN-007 D9`
  is untouched. Section 6 changes the format, not the direction.

**Criterion that turns this red:** a second PG instance, or a PG instance not
on the VM, or a `host` line granting any chain schema to a non-local address,
appears in the deployed `postgresql.conf`/`pg_hba.conf` at any time and the
facade's byte-compare instrument does not fail.

### 2. Schema layout (STORY-171.2)

**Verdict: one database, five per-chain schemas, one domain schema, one
collaboration placeholder schema.**

- Database `tcrn_governance`, single instance, single cluster.
- Schemas: `chain_aos`, `chain_cross`, `chain_ds`, `chain_tms`,
  `chain_joi` (one per chain, named from the partition id lowercased);
  `domain` (the domain.db store's table mapping); `collab` (placeholder for
  future collaboration features — see section 3).
- Each `chain_<partition>` schema owns: `events`, `metadata`, `markers`
  (the knowledge/artifact markers — **two distinct shapes, section 6 face 4**),
  `claims` (section 5), and `views` (engine-derived, rebuildable — **not
  authoritative**, section 4). The knowledge and artifact **record stores**
  (knowledge bodies/metadata, artifact records/archives) live in the same
  schema as their own tables — section 6 face 4.
- **Naming convention**: relation names are `snake_case`; every `chain_*`
  schema is created and dropped only by the migration/rollback verbs, never by
  hand.

**Criterion that turns this red:** a table is created inside a `chain_*`
schema by anything other than the engine's schema-DDL verb or the migration
verb; or two chains share one events table.

### 3. Roles and permissions (STORY-171.3)

**Verdict: three roles; GRANT-mechanised "only the engine writes a chain";
append-only enforced by triggers.**

- Roles:
  - `tcrn_engine` — owns the five `chain_*` schemas. The ONLY role with
    `INSERT`/`UPDATE`/`DELETE` on chain tables and with `CREATE` inside a
    `chain_*` schema.
  - `tcrn_domain` — owns the `domain` schema; read-only on `chain_*` (its reads
    are advisory).
  - `tcrn_collab` — future collaboration; `SELECT` on `chain_*` only,
    `USAGE` on `collab` schema. Created now so the placeholder exists with its
    permission already expressed; it never gains chain write.
- **GRANT matrix** (stated, then machine-enforced):

  | permission | tcrn_engine | tcrn_domain | tcrn_collab |
  | --- | --- | --- | --- |
  | `USAGE` on `chain_<p>` schema | yes | yes | yes |
  | `SELECT` on `chain_<p>.*` | yes | yes | yes |
  | `INSERT`/`UPDATE`/`DELETE` on `chain_<p>.*` | yes | no | no |
  | `CREATE` in `chain_<p>` | yes | no | no |
  | `USAGE`+write on `domain` | no | yes | no |
  | `collab` schema | no | no | `USAGE`+`SELECT` |

- **Append-only triggers.** On every `chain_<p>.events` table a
  `BEFORE DELETE OR UPDATE` trigger raises an exception; `TRUNCATE` is refused
  by `REVOKE TRUNCATE` from all three roles. The metadata/markers tables are
  `UPDATE`-only through the engine role (their CAS columns are the
  concurrency boundary), but the events table is structurally append-only.
- **Red-leg tests** (the GRANT face of STORY-175.5, listed here so the DDL has
  its acceptance):
  1. a write as `tcrn_domain` or `tcrn_collab` to any `chain_<p>` table fails
     with `permission denied`;
  2. `UPDATE`/`DELETE` on an events row fails even as `tcrn_engine`;
  3. `TRUNCATE` on an events table fails for every role;
  4. `INSERT` with a `prior_hash` that does not equal the current head's
     `event_hash` fails the chain-continuity check.

**Criterion that turns this red:** any of the four red-leg tests above stops
failing, or an explicit `GRANT` of chain write to a non-engine role exists in
the deployed catalog.

### 4. Event table DDL (STORY-171.4)

**Verdict: events live as rows whose columns carry exactly the canonical
`EventRecord` fields; the canonical bytes are stored, not reconstructed.**

```sql
create table chain_cross.events (
  sequence       integer primary key,
  id             text not null unique,
  stream_id      text not null,
  schema_version text not null,          -- "tcrn.event.v1"; stored, never reconstructed
  occurred_at    text not null,          -- strict instant, engine-validated
  prior_hash     text,                   -- null only at sequence 1
  payload        bytea not null,         -- canonicalJson bytes, verbatim
  payload_hash   text not null,          -- sha256 of canonicalJson(payload)
  event_hash     text not null unique,   -- sha256 of the full EventRecord basis
  check (sequence >= 1),
  check ((sequence = 1) = (prior_hash is null))
);
```

All nine `EventRecord` fields are stored as columns — nothing is reconstructed.
`event_hash` is the sha256 of the full basis including `schema_version`, so a
future version change is visible in the stored bytes, not silently re-derived.

- **Continuity constraint** (trigger): on `INSERT`, verify `sequence =
  (select coalesce(max(sequence),0)+1 from chain_cross.events)` and
  `prior_hash = (select event_hash from chain_cross.events order by sequence
  desc limit 1)` (null at sequence 1). The engine re-verifies the whole chain
  on read exactly as `validateEventChain` does today, so the trigger is a
  fail-closed first line, not the authority.
- **`payload` is `bytea` of the canonical bytes** — the engine writes
  `canonicalJson(payload)` bytes verbatim and the read path re-derives nothing.
  `event_hash`/`payload_hash` are stored as the engine computed them; the read
  side recomputes and compares (red-leg: flip any stored column and the
  chain-verify must fail).
- **Metadata**: `metadata` table holds one row per workspace carrying the full
  canonical `workspace.json` field set — `schema_version`, `storage_version`,
  `minimum_storage_version`, `maximum_storage_version`, `workspace_id`,
  `external_key`, `created_at`, `segment_event_limit`, and the five `roots` as
  their own columns **plus** the relocation ledger as its own table (section 7).
  The `metadata` row is `UPDATE`-only via `tcrn_engine`, CAS-guarded by
  `expected_version`/`version`. The read side re-validates the reconstructed
  metadata byte-for-byte (`WORKSPACE_SCHEMA_INVALID` on mismatch), which is what
  keeps `WORKSPACE_MIGRATION_FUTURE`/`WORKSPACE_MIGRATION_DOWNGRADE` (the
  storage-version gate) alive under PG — the two storage-version columns are
  load-bearing for that gate and must be stored, not dropped.
- **Views stay engine-derived.** `views` is a table the engine materializes
  from the events and rewrites on each mutation; it is rebuilt from the chain
  at any time and is **not** the authority. The "views are not authoritative"
  property of the file backend is preserved. A stale `views` row is a
  `WORKSPACE_VIEW_STALE` refusal on read, exactly as today.
- **markers** (section 6) carry the knowledge/artifact high-water bindings.

**Criterion that turns this red:** a read of the events table at a given head
does not produce the same `EventRecord[]` bytes as `validateEventChain` over
the file backend on the same history; or a `views` row is ever treated as
authoritative by a read path.

### 5. Lease and single-writer semantics (STORY-171.5)

**Verdict: session-level advisory lock as the single-writer mutex; a claims
table as the auditable intent record; the file mutation-claim file is
replaced by transaction atomicity + chain-continuity constraints.**

The file backend enforces single-writer with `lease/owner.json` (TTL + pid
liveness probe) and a `mutation.claim` file whose **presence** is the lock.
Postgres gives two candidate equivalents, compared here:

| property | advisory lock (`pg_try_advisory_xact_lock`) | claim table (one row) |
| --- | --- | --- |
| crash recovery | automatic on connection drop / transaction abort | needs TTL + stale-reclaim logic |
| auditability | none (not persisted) | persists holder/token/acquiredAt |
| single-writer for a chain | exact (keyed by chain) | one row, must be claimed |
| maps to file lease TTL | no probe needed | keeps TTL semantics |
| maps to `processAlive` | unnecessary | needs a pid/backend probe |

**The engine's `processAlive` probe and the lease TTL are a workaround for a
file system that cannot release a lock on crash.** Postgres releases an
advisory lock with the connection, so the crash wedge the TTL exists to clear
cannot arise. **But a hung (not crashed) session is a second wedge the file
lease handled and the advisory lock does not**: a live session stuck
`idle in transaction` holds the advisory xact lock forever
(`idle_in_transaction_session_timeout` defaults to 0), and the claims table
(carried in the same transaction) is invisible to a reader until the hung
transaction commits or aborts. The reclamation path is therefore named, not
assumed: `pg_terminate_backend`/`pg_cancel_backend` on the claim's backend, the
PG counterpart of `lease-break`; plus a stated
`idle_in_transaction_session_timeout` on the engine role's connections. The
judgement: the advisory lock is the **authority** for mutual exclusion; the
claims table is a **durable intent record** (who claimed which chain, when,
token, backend pid) kept for audit and inspection — and its `backend_pid`
column is exactly what makes a hung writer reclaimable, which is why it is
written in the same transaction as the mutation.

- One mutation = one transaction: `BEGIN` → take `pg_try_advisory_xact_lock`
  on `hashtext('chain:' || workspace_id)` → re-read marker/head → CAS check →
  `INSERT` event row → `UPDATE` metadata/views/markers → `COMMIT`. If the
  transaction aborts or the connection drops, every byte it wrote is rolled
  back — this replaces `atomicWrite`'s fsync+rename+identity-verify with the
  database's own atomicity, and the durability readback (the "committed
  segment re-read") becomes the transaction's post-commit `SELECT`.
  **Concurrency red-leg mapping is named, not guessed.** Two concurrent
  INSERTs each pass the continuity trigger (each sees the same committed head);
  the `sequence` primary key is the real backstop and the second INSERT raises
  `unique_violation`, which the engine maps to `WORKSPACE_CAS_MISMATCH`
  (a lost CAS race) — not a raw Postgres error. The trigger is a fail-closed
  first line, the PK is the authority, and the reason-code mapping is part of
  the equivalence gate (section 9 criterion 2). **Advisory lock key uses the
  two-argument int4 form** `pg_try_advisory_xact_lock(hashtext('chain:' ||
  workspace_id), 1)` — the single-argument form hashes to a cluster-wide
  namespace where a hash collision between two chains would cause a false
  mutual exclusion (try=false → spurious `WORKSPACE_LOCKED`); the two-arg form
  keeps the chain namespace distinct and bounds the collision surface to the
  per-chain int4 space.
- **`lease-inspect`/`lease-break`/`lease-recovery-break` equivalents**: the
  claims table is readable read-only (audit); the *crash* wedge cannot exist in
  PG (the advisory lock self-releases on connection drop), so the file lease's
  `lease-break` maps to **`pg_terminate_backend`/`pg_cancel_backend` on the
  claim's `backend_pid`** (see the hung-writer reclamation path above);
  `lease-recovery-break` has no PG counterpart (there is no orphan claim file).
  The verbs' semantics are re-stated: `lease-inspect` reads the claims table;
  `lease-break` targets the hung backend named by the claim's pid;
  `lease-recovery-break` is refused with `WORKSPACE_LEASE_INVALID` under PG.
- **Replay parity is unchanged**: the reducer (`materialize`) runs over the
  events rows exactly as over segment files, and the write path re-checks the
  CAS marker inside the transaction.

**Criterion that turns this red:** two concurrent transactions both commit a
mutation to the same chain at the same sequence; or a read during a mutation
observes a partially-applied event.

### 6. Six dependency faces (STORY-171.6)

**Verdict per face — each states whether the file-backend guarantee survives,
is redefined, or is deliberately dropped.**

1. **Canonical bytes + hash chain: survives.** The event row stores canonical
   bytes verbatim (`payload bytea`), `event_hash` covers the full basis as
   `createEvent` computes it today, and `validateEventChain` over the rows is
   byte-identical to over the files. This is the bedrock equivalence of
   STORY-173.
2. **Attestation: survives.** The `actor` joins the hashed payload exactly as
   today (`EVENT_PAYLOAD_OPERATION_EXTRAS`), and `occurredAt` stays
   event-bound. The enabling-event boundary and replay re-derivation are
   untouched.
3. **Fail-closed: survives, and is the design.** PG unreachable → the facade
   refuses every write with the mapped reason code; there is **no fallback to
   the file track** for a governed chain. The shadow chains (fallback-cli) are
   the only buffer, and they replay through the front door after recovery —
   unchanged from today.
4. **Snapshot · export: redefined as bound objects.** `snapshot-manifest`
   and `export` are engine-side projections. Under PG the manifest is derived
   from the events table (a deterministic digest over the rows at a head), not
   a file-tree walk. `controlManifestSha256` keeps its meaning (a sha256 of
   the manifest text) but the manifest's subject is the chain, not a file
   tree. The "blindness" clauses of `workspace-snapshot.ts`
   (`EXCLUDED_RELATIVE_PATHS`, residue prefix) have no PG counterpart — the
   events table has no empty-directory blindness and no quarantine residue;
   the manifest is over exactly the rows, which is stronger, and the 
   `snapshot-verify` two-sided compare keeps its role. **Scope is stated, not
   assumed**: the manifest covers the `events`, `metadata`, `markers` and
   `claims` rows (the control-table equivalent of the file-tree walk), so
   `controlManifestSha256` still binds the relocation basis to the full
   control surface. A single `metadata` row change moves the manifest, exactly
   as a single file change did on the file side.

   **The two stores keep their distinct shapes.** `knowledge-core.ts`'s marker
   (`store.json`) CASes on a **store-owned integer `version`** plus
   `eventHighWaterDigest`; `artifact-lifecycle.ts`'s marker has **no integer
   version** — its CAS is `expectedPlanDigest`. The `markers` table therefore
   models both explicitly: `knowledge_marker(workspace_id, version, high_water_digest)`
   and `artifact_marker(workspace_id, high_water_digest, plan_digest)`, plus
   per-store record tables (`knowledge_units`, `knowledge_bodies`,
   `artifact_records`, `artifact_archives`). The engine's knowledge CAS must
   use the **store `version`**, never the chain version — a ceremony that
   supplies the chain version against the knowledge marker is exactly the
   `KNOWLEDGE_CAS_MISMATCH` class this design exists to prevent. High-water
   binding is enforced in the same transaction as the chain append (a chain
   write and its marker rebase commit atomically), so a store is never readable
   at a head its marker has not caught up to — the `KNOWLEDGE_HIGH_WATER_MISMATCH`
   / `ARTIFACT_HIGH_WATER_MISMATCH` refusals carry over verbatim.
5. **Relocation ledger: restated with its four ceilings intact.** The ledger
   moves to its own append-only table (section 7). `relocationId` derivation,
   the vacated→adopted/aborted state machine, `activeBinding`, and the
   four ceilings of ADR 0003 (authorization not authentication; ledger
   deletable; abort-after-adopt is a fork; a permit is a predicate over bytes,
   not a spendable token) **all carry over verbatim** — Postgres does not
   change what a fork is or that the engine cannot detect one. The ledger's
   chaining (`from` restates the binding it replaced) is enforced by the same
   canonical-byte comparison on read.
6. **Backup and read-only archive: redefined.** `paired:backup` switches from
   a file-tree snapshot to a VM-side `pg_dump` in custom format + a sha256
   digest sidecar; the pull direction and the off-site verification are
   unchanged. The read-only archive (the file tree after migration) is
   retained for forensics — only the source side can prove what the source
   said — but it is no longer the authority.

**Criterion that turns this red:** any face above loses its stated guarantee
and the equivalence gate of STORY-176 does not fail; in particular, a
"fallback to file track on PG outage" code path existing anywhere in the
facade.

### 7. Migration ledger quota (STORY-171.7)

**Verdict: the 16-entry / 8-attempt budget semantics survive; the cap value rises
to 64 entries / 32 attempts under PG — and this is a CORE-CODE change, not a
deployment knob.**

ADR 0003's `WORKSPACE_RELOCATION_LEDGER_LIMIT = 16` is enforced in the **read
path** (`validateRelocationLedger` → `validateMetadata`, on every read). Raising
it means changing that shared constant, which changes the file backend's budget
too — the two backends must stay budget-consistent (STORY-174 "zero behaviour
change" and STORY-176's same-history dual-backend equivalence gate both require
it). So: the cap moves behind the storage abstraction as a per-backend constant,
with **the same value on both backends** (64 under PG, 64 under file). The file
backend's historical 16 is a legacy value that the migration of an already-spent
workspace preserves (a workspace that spent `k` entries keeps `k` spent; the new
cap applies to the remaining budget) — but going forward both backends enforce
64, so the equivalence gate can compare same-history budgets byte-for-byte.

The cap serves purpose (ii) from the original design — a finite, unrecoverable,
non-compactable budget is an operational discipline ("plan the thirty-two").
Purpose (i) (per-file re-read cost) disappears under PG but the value is shared,
so both backends carry 64.

- `relocation-plan` refuses at a full ledger with
  `WORKSPACE_RELOCATION_LEDGER_FULL` before the out-of-band minting ceremony,
  reporting `hopsRemaining` and `ledgerEntriesRemaining` — unchanged.
- No compaction verb, and deliberately none — deleting settled entries
  destroys the append-only self-chaining property. The cap is consumed by
  attempts, not by moves; a hop costs two entries whether or not a byte
  travels. Same as ADR 0003.
- **Existing budgets are preserved on migration**: a workspace that has spent
  `k` entries keeps `k` spent; the new cap applies to the remaining budget.
  Migration does not "reset the ledger".
- The ledger rows carry the same fields as the `relocations` array entries and
  the read path re-validates them byte-for-byte against canonical form.
- **The ledger table is structurally append-only, mechanically, like the events
  table.** The append-only trigger is installed on the ledger table too, not
  just on `events`: the GRANT matrix gives `tcrn_engine` `UPDATE`/`DELETE` on
  `chain_<p>.*`, which would otherwise let the engine role silently delete a
  trailing `aborted` entry — undetectable to the read path (a trimmed ledger
  re-validates clean, and only the counterparty can see the deletion, per ADR
  0003 ceiling 2). The trigger and `REVOKE TRUNCATE` close the in-band gap; the
  counter party still has the permanent record, which is the documented
  boundary. This does not change what a fork is — see section 6 face 5.

**Criterion that turns this red:** any code path can increase the remaining
budget without a hop (a reset), or compaction exists anywhere in the
migration or relocation verbs.

### 8. Track table and scope clarification (STORY-171.8)

**Verdict: the file backend is not deleted — its production track for the five
governed chains is replaced.**

| track | who it serves | operating cost | sunset or review |
| --- | --- | --- | --- |
| PG production track (five governed chains) | all governed-partition readers/writers; future collaboration | VM host operations (systemd/upgrades/backups) transferred to the platform operator with this initiative | review = annual PG major-version assessment (ADR rhythm) |
| File backend (local-mode track) | workspaces not wired to AOS (bootstrap / standalone host); the four fallback shadow chains | existing engine test coverage, zero new resident services | review condition = the day `MIN-060 D4` is re-ruled; shadow predicate = facade-unreachable scenario still exists |
| File backend (migration/verification instrument) | STORY-176 equivalence gate, STORY-178 migration verbs, read-only archive forensics | same (test surface) | retained/instrument scope reviewed at closeout (STORY-190) |

Scope clarification (recorded in the ADR track table): "file backend demoted to
instrument" governs the **production track of the five governed chains**.
Local mode (workspaces not wired to AOS), the four fallback shadow chains, and
the migration/verification instrument **keep the file backend**; `MIN-060 D4`
("only local mode writes local files") is not touched.

**Criterion that turns this red:** a governed-chain read or write path routes
to the file backend after the switch window, or the file backend is removed
entirely (its local-mode and instrument uses remain supported).

### 9. Equivalence criteria (STORY-171.9, formalised with STORY-173)

**Verdict: the two backends are equivalent when all four criteria below hold
on the same history, each with a red-leg proof.**

1. **Per-event byte equivalence.** The event rows read back as the identical
   `EventRecord[]` bytes as the file segments for the same history — every
   field including `event_hash`/`payload_hash` byte-for-byte. Red leg: flip
   one byte of one stored `payload` and the compare must fail.
2. **Reason-code equivalence.** The same mutation on both backends returns the
   identical reason code on every path — success and each refusal class
   (`WORKSPACE_CAS_MISMATCH`, `WORKSPACE_LOCKED`, `WORKSPACE_EVENT_CORRUPT`,
   `KNOWLEDGE_*`, `ARTIFACT_*`, relocation codes). Red leg: a refusal class
   whose PG path maps to a different code must fail the gate.
3. **Head-hash equivalence.** `headEventHash` and `version` at every sequence
   are identical across backends. Red leg: append a second event with the
   same `prior_hash` (a fork) and the head compare must fail.
4. **View and two-store marker equivalence.** The engine-derived `views` and
   the knowledge/artifact markers (`version`, `eventHighWaterDigest`,
   record bodies) are byte-identical across backends at the same head. Red
   leg: mutate a marker without a chain write and the store's high-water check
   must fail.

The equivalence gate (STORY-176) machine-checks all four on a shared history
with a mutation witness; a criterion with no red leg is not a criterion.

## Consequences

- The engine gains a storage abstraction with two implementations; the file
  backend is converged onto the same interface with zero behaviour change
  (STORY-174).
- A new PG chain backend with the DDL, roles, triggers, lease, and fail-closed
  mapping above (STORY-175); the two stores go PG behind their markers
  (STORY-177).
- A bidirectional migration verb family (plan/execute/verify/rollback) with
  the same criteria both ways (STORY-178); backup re-based on `pg_dump`
  (STORY-179); a scratch round-trip proof (STORY-180).
- The AOS facade becomes the single read/write face (STORY-181..184); clients
  and criteria converge in the switch window (STORY-185..187); the five chains
  migrate in one window behind four pre-window gates (STORY-188..190). Release
  of the engine version and helper re-pin is the single mandated stop.
- **Irreversible cost, accepted deliberately**: after the switch window, a
  pre-migration engine binary cannot read a governed chain (the file track is
  archived read-only), and a PG-outage never silently reverts to the file
  track. This is the same one-way shape ADR 0003 recorded for relocation, and
  it belongs in the decision record rather than a footnote.
