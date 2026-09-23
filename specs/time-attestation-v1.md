# Time Attestation V1

`tcrn.time-attestation.v1` is an advisory, opt-in CLI receipt that records the
local wall-clock reading observed when a workspace mutation was invoked. It is
**not** a registered protocol extension, it is **not** part of the workspace trust
boundary, and it changes no frozen schema. This document is the durable record of
what the receipt does and does not claim, and of why the rejected designs were
rejected.

## What the event chain proves

The single-writer event chain proves **ordering**: each event carries a
`priorHash` linking it to its predecessor, so the sequence of decisions is linear
and tamper-evident. The chain does **not** prove wall-clock truth. Every event's
`occurredAt` is a **caller-asserted** instant supplied on the command line; the
engine validates only that it is a strict RFC-3339 instant, never that it matches
real elapsed time. The determinism contract permits exactly one `Date.now()` in
the engine — the lease-creation grace, a liveness guard that lives outside event
content and never enters a hashed payload. No engine path reads a clock to stamp
an event.

## Why the engine does not record observed time — rejected designs

1. **Engine-recorded observed time — REJECTED.** An engine-observed timestamp
   would either enter hashed event content, breaking the byte-identical
   permutation proofs and replay determinism, or sit unhashed inside the trust
   boundary, attesting nothing while polluting the audited surface. The engine
   stays clock-free by design.
2. **Non-hashed sidecar inside the workspace — REJECTED.** An unhashed,
   unauthenticated file written inside the control directory is trivially editable
   and would create a false impression of in-workspace attestation.
3. **CLI-layer advisory receipt — CHOSEN.** The CLI, not the engine, captures a
   wall-clock reading through an injectable clock and writes a canonical-JSON
   receipt per mutation to a caller-chosen directory that must resolve **outside**
   the workspace root. The chain's own claim stays exactly what it can prove, and
   the receipt is explicitly labelled advisory, unauthenticated, local-clock
   evidence.

## Receipt shape

A receipt is the canonical JSON serialization of exactly four fields:

- `schemaVersion` — the constant `"tcrn.time-attestation.v1"`.
- `eventHash` — the lowercase SHA-256 `headEventHash` of the mutation the receipt
  attests, and the key the receipt is filed under (the file basename
  `<eventHash>.json` in the legacy layout, the index key in the segmented one; see
  Storage layout).
- `occurredAt` — the caller-asserted event instant (the mutation's `--at`).
- `observedAt` — the instant read from the invoking process's injected clock.

Both instants are validated as strict RFC-3339 instants and `eventHash` against
the SHA-256 digest shape before one byte is written. The receipt carries no
filesystem path and no hostname (a privacy requirement): only a digest and two
instants. It is written with the invoking process's clock, so its authority is
exactly the authority of that process's clock — nothing more.

## Opt-in, injected clock, outside the workspace

The receipt is produced only when a mutation verb is invoked with `--attest-dir`.
With the flag absent, every mutation is byte-identical to a run without this
feature and no clock is read. With the flag present:

- the invoking process must supply a clock; a caller with `--attest-dir` set and
  no injected clock fails closed with `CLI_ARGUMENT_MISSING` rather than falling
  through to an implicit `Date`, so hermetic runs can never silently observe real
  time;
- the directory must resolve outside the workspace root, or the invocation fails
  closed with `CLI_ARGUMENT_MALFORMED` and writes nothing.

The production binary supplies the real clock at its outermost layer only.

## Checks before the workspace lease

Every mutating verb that declares `--attest-dir` (22 of them) runs one shared check
after its own argument checks and before it takes the workspace lease and makes
its CAS decision (TCRN-CROSS-INC-378). It asks, in order, for the injected clock,
for a directory outside the workspace root, and for a consistent store (see
below); a refusal appends no event, creates no directory and writes no byte.
Before INC-378 all three were met only after the commit, so a refused receipt
left an event with no receipt behind a command that reported failure.

The store check is read-only and takes no lock. A directory that does not exist,
or has no `manifest.json`, is consistent. Otherwise every segment the manifest
names must match it in bytes, SHA-256 and record count, and the streamed records
digest must equal `recordsDigest`; anything else refuses with
`ATTESTATION_STORE_INCONSISTENT`, naming what differs. A live directory lock (see
Directory lock) means a writer is mid-rewrite, so the check waits for it, and a
lock still held after 10,000 ms refuses with the same code, saying the lock was
still held. A store that reads inconsistent while a writer has just taken the lock
is waited for rather than reported.

Tests: `WSE-4: --attest-dir fails closed inside the workspace root and with no
injected clock, writing nothing`; `INC-378 every mutating verb that takes
--attest-dir refuses an inconsistent store before the lease and changes nothing`;
`INC-378 work-batch refuses an inconsistent store before the lease and changes
nothing`; `INC-378 a consistent store still takes the receipt and it reads back by
eventHash`.

## Storage layout

A receipt directory is in one of two layouts.

- **Legacy**: one file per receipt, `<eventHash>.json`, holding the receipt's
  canonical JSON. A directory with no `manifest.json` is in this layout, and a new
  receipt there is written the same way.
- **Segmented** (STORY-340, reached through `attestation-migrate --mode prepare`):
  - `NNNNNN.ndjson` segments hold one canonical receipt per line, each line ending
    in LF, in rising `eventHash` order across the whole store;
  - `NNNNNN.idx` beside each segment is `tcrn.attestation-index.v1`, whose
    `entries` map every `eventHash` in the segment to the `segment`, byte `offset`
    and `length` of its line;
  - `manifest.json` is `tcrn.attestation-manifest.v1`: `segments` (each `name`,
    `bytes`, `records` and `sha256`), `count`, and `recordsDigest`.

Reading a legacy directory, and migrating it through `--mode report`, `prepare`
and `delete`, are unchanged; `delete` removes the legacy files only after every
record reads back from the segments with its full value, compared one record at
a time.

Any other file in the directory is not part of the store, and no write to the
store changes or removes it; the `tcrn.relocation-attestation.v1` receipts the
retired relocation verbs left in five partitions' directories are such files.
The writer's own transient files are `attestation.lock` (see Directory lock) and
`.tmp-` files, each renamed into place or removed by the write that created it; a
`.tmp-` file a crashed writer left behind is residue, which `attestation-verify`
reports.

Tests: `STORY-340 attestation migration preserves full values, supports point
lookup, and deletes only after baseline proof`; `INC-378 rewriting a
multi-segment store leaves no unreferenced segment or index and never touches
other files`.

## Records digest

`recordsDigest` is the SHA-256 of `"["`, then every record's canonical line
without its LF joined by `","`, then `"]\n"`, fed to the hash one line at a time.
Those are exactly the bytes `canonicalSha256` hashes for the array of records, so
while that array canonicalises inside one canonical document (one MiB) the digest
is `canonicalSha256` of the array — the value every manifest written before
TCRN-CROSS-INC-378 recorded, which is why no existing manifest needs migrating.
Streamed, it has no record-count or byte ceiling; each line is still checked to
be canonical as it is read.

Tests: `INC-378 a store smaller than one segment keeps the exact bytes the
previous writer produced`; `INC-378 a store at the edge of one canonical MiB
accepts the next receipt and rolls into a second segment`.

## Segments and write order

Writing a receipt, migrating, and repairing go through one writer. It computes
every segment, every index and the manifest before the first byte is written, so
a size or canonical-form refusal changes nothing on disk. Segments roll over at a
record boundary as soon as the next record would take the segment past 1,048,576
bytes or past 8,192 records; the second bound keeps every index inside one
canonical document (one MiB and 10,000 keys) whatever size the records are.
Segments and indexes are written first and the manifest last; only then are the
`NNNNNN.ndjson` and `NNNNNN.idx` files the new manifest does not name removed. A
store smaller than one segment is still the single `000001` segment and is
byte-identical to what v1.1.2 wrote.

The migration's segment size can be set from 4,096 to 1,048,576 bytes and
defaults to 1,048,576; a larger value refuses with
`ATTESTATION_SEGMENT_BYTES_INVALID`.

Tests: `INC-378 a store at the edge of one canonical MiB accepts the next receipt
and rolls into a second segment`; `INC-378 more than ten thousand receipts
migrate and accept a write with every segment and index inside one canonical
document`; `INC-378 rewriting a multi-segment store leaves no unreferenced segment
or index and never touches other files`; `INC-378 a store smaller than one
segment keeps the exact bytes the previous writer produced`.

## Directory lock

Receipts are written after the workspace lease is released, so two writers could
each read the same store and the second rename silently drop the first receipt.
Every read-modify-write of a store — writing a receipt, the migration's `prepare`
and `delete` steps, repair and restore — therefore holds `attestation.lock` in the
directory.

The lock (TCRN-CROSS-STORY-457) is one canonical JSON line,
`{"createdAt","pid","schemaVersion":"tcrn.attestation-lock.v1","start"}` followed
by LF: the holder's process id, the start time `ps -o lstart= -p <pid>` reports for
it (`null` when `ps` cannot say) and the moment it was placed. The writer writes it
whole into a private file and links it into place, so the lock never exists half
written; the link refuses when a lock is already there. The pre-STORY-457 form,
the process id followed by LF, is still read: it names a pid and no start time.

- A lock is **stale**, and is taken over, when its holder is not running
  (`holder-not-running`); when the holder's pid is running but `ps` reports a
  different start time for it, that is, the pid now belongs to an unrelated
  process (`holder-pid-reused`); or when the lock cannot be read as either form and
  is older than 5,000 ms (`unparseable-expired`). A stale lock is moved aside,
  checked to still be the same lock, and removed; a lock another waiter took over
  in the meantime is put back. `writeAttestationReceipt` returns the reason and the
  holder's pid as `staleLock`.
- A live holder, and an unreadable lock younger than 5,000 ms, are waited for,
  polling every 10 ms, for up to 10,000 ms; then the write refuses with
  `ATTESTATION_LOCKED` before it has changed anything, naming the holder's pid
  when the lock names one.
- When `ps` cannot report a start time (no such tool, or no answer within
  2,000 ms), the reuse check is skipped and the lock is judged by its pid alone, as
  before; the fallback never clears a live holder. A pre-STORY-457 lock is judged
  the same way.
- A writer releases only the lock it placed.

Tests: `INC-378 twelve writes started together in one process lose no receipt`;
`INC-378 two processes released together lose no receipt`; `INC-378 a lock held by
a live process is refused without a byte changed, and a lock left by a dead
process is taken over`; `STORY-457 AC1: a lock whose holder is not running is taken
over and the reason is reported`; `STORY-457 AC2 and AC5: a pid reused by an
unrelated live process is stale at once, not after the timeout`; `STORY-457 AC3: an
unreadable lock older than the limit is taken over, a fresh one is waited for`;
`STORY-457 AC4: a live holder whose start time matches is waited for and never
cleared`.

## Excluded from export and archive

`exportWorkspace` and `createWorkspaceArchive` read only the event chain. Receipts
live outside the workspace root and are never part of an export or archive, so
export and archive bytes are identical whether or not receipts exist. The
determinism suites therefore never observe a clock.

## Best-effort, no governance weight

Receipt writes sit outside the lease and mutation claim, and the mutation event
is committed first. Everything that can refuse a receipt on its own terms is
checked before the lease (see Checks before the workspace lease), so what can
still fail is a failure after the commit: a crash, a full or unwritable
directory, a lock held past the timeout. That loses only the advisory receipt,
never workspace state, and the command says so: it fails with
`ATTESTATION_RECEIPT_UNWRITTEN` and the string details `committed` (`"true"`),
`version` (the committed version) and `headEventHash` (the new head), which the
CLI binary also prints on stderr, so a landed write with a missing receipt cannot
be read as a write that never happened. A receipt carries **no governance
weight**: it is not authenticated time and confers no trust without an external
time authority. Downstream tooling must not treat a receipt as proof of when a
decision was made — only that some process holding that clock observed the stated
reading.

Test: `INC-378 a receipt that fails after the commit reports committed, the
version and the new head`.

## attestation-verify

```
attestation-verify --attest-dir <attestation directory> --workspace <workspace root>
```

A read-only verb (`mutates: false`). It takes no lock, creates no directory and
writes no byte, and exits 0 whenever the directory can be read, printing
`tcrn.attestation-verify.v1` without listing the records themselves:

- `manifest`: its `bytes`, `sha256` and full `document` (null without a manifest);
- `segments`: for every `NNNNNN.ndjson` present, its `bytes`, `lines`, `sha256`,
  whether every line is a canonical record (`canonical`), whether the lines rise
  strictly by `eventHash` (`sorted`), whether the manifest names it (`referenced`),
  and its `index` (`bytes`, `sha256`, `entries`, and `matchesSegment`: exactly one
  entry per line, pointing at that line);
- `computed`: the `count`, streamed `recordsDigest` and `concatenatedSha256` of the
  segments the manifest names, in its order (null without a manifest);
- `consistent` and `problems`: consistent when the manifest names segments that
  are all present and match it (records, bytes, SHA-256, count and digest), hold
  canonical lines in rising `eventHash` order across the whole store, and have
  matching indexes; a directory with no manifest is consistent unless it holds
  segments;
- `extraRecords`: `none` when those segments hold as many lines as the manifest
  counts, otherwise `resolved` or `unresolved` as described below;
- `legacyFiles`, `otherFiles` (each `name`, `bytes`, `sha256`), `lock` (the lock
  file's content, trimmed, or null) and `temporaryFiles` (write residue);
- `chainHead`: the workspace `version`, `headEventHash`, and `receiptPresent`
  (a record for the head is in the segments the manifest names or, in a directory
  with no manifest, a legacy file is named for it).

When the segments the manifest names hold exactly one line more than it counts,
each line as long as the excess bytes is taken out in turn; a line is a solution
when the rest, cut by the manifest's per-segment record counts, matches every
segment in bytes and SHA-256 and the streamed digest matches. Only a unique
solution is reported — its `segment`, 1-based `line`, `offset`, `length`,
`eventHash`, `occurredAt`, `observedAt`, and the chain event it names
(`sequence`, `occurredAt`, `occurredAtMatches`) or null. Anything else is
`unresolved`: the position or time of a line is never used to guess.

It exits non-zero when the directory does not exist (`ATTESTATION_DIRECTORY_MISSING`),
resolves inside the workspace root (`CLI_ARGUMENT_MALFORMED`), or the workspace
cannot be read.

Tests: `INC-378 verify reports a consistent store without taking the lock or
writing a byte`; `INC-378 repair puts back the record a sorted write left outside
its manifest, and restore undoes it`; `INC-378 repair at the one-MiB edge splits
the store in two, and restore removes the second segment again`; `INC-378 repair
takes back a record appended after the last segment and keeps the store in
eventHash order`; `INC-378 a relocation receipt in the directory is listed by
verify and left alone by repair and restore`.

## Repair and restore

```
attestation-migrate --root <attestation directory> --mode repair --workspace <workspace root> --expect-extra <eventHash>[,<eventHash>...] --backup-dir <backup directory>
attestation-migrate --root <attestation directory> --mode restore --backup-dir <backup directory>
```

`--mode repair` puts back into its manifest a store whose segments hold records
the manifest never counted — the shape a write that failed between its segment
and its manifest leaves — each such record named with `--expect-extra`. `--root`
must name a directory called `attestations`. The whole repair holds the directory
lock. It refuses with `ATTESTATION_REPAIR_REFUSED`, naming the failed condition,
before any byte is written and without creating a backup, unless:

- the backup directory resolves outside the attestation directory and outside
  the workspace root, and does not exist or is empty;
- the directory has a readable manifest;
- every named `eventHash` occurs exactly once in the existing segments, joined in
  numeric order;
- without the named records, those segments are the store the manifest describes:
  cut by its per-segment record counts, every segment matches in records, bytes
  and SHA-256, and the count and streamed digest match;
- every named record is a canonical `tcrn.time-attestation.v1` receipt of exactly
  the four fields, its `eventHash` is an event on the chain, and its `occurredAt`
  is that event's `occurredAt`.

It then copies every file the store owns (`manifest.json`, the segments, the
indexes and any legacy receipts) byte for byte into the backup directory beside
`backup-manifest.json` (`tcrn.attestation-backup.v1`), whose `files` name every
file in the directory with its `name`, `bytes`, `sha256` and `copied`. Files the
store does not own are named with `copied: false` and not copied; the lock and
entries that are not regular files are left out; no path is recorded. Each copy
is synced and read back against its digest, and a copy that does not read back
refuses with `ATTESTATION_BACKUP_INVALID` before the store is touched. The store
is then rewritten by the segment writer and judged again as `attestation-verify`
judges it; a store that is not consistent after the rewrite fails with
`ATTESTATION_REPAIR_UNVERIFIED`, leaving the backup to restore from. On success it
prints `tcrn.attestation-repair.v1`: `before` (the full manifest, its SHA-256,
and the SHA-256 of the existing segments joined in numeric order), `extraRecords`
(each record's full line and its chain event), `backup` (the directory and the
SHA-256 of `backup-manifest.json`), and `after` (the full new manifest, its
SHA-256, and the SHA-256 of its segments joined in order). A repair that moves no
record keeps the two joined digests equal.

`--mode restore` is the rollback of a repair from its backup, under the same
lock. It checks `backup-manifest.json` and every copied file against the recorded
size and SHA-256, and refuses with `ATTESTATION_RESTORE_REFUSED` — having written
nothing — on a malformed backup manifest or a mismatch, or when the store holds a
receipt the backup does not have, so a restore never drops a receipt written
after the repair. It then
writes every copied file back (the manifest last), removes store files the backup
does not have, leaves every file the store does not own alone, reads each
restored file back against its digest (`ATTESTATION_RESTORE_UNVERIFIED` on a
mismatch), and prints `tcrn.attestation-restore.v1`: the `backup` directory and
manifest SHA-256, and the `restored` and `removed` file names.

The other modes (`report`, `prepare`, `delete`) are unchanged.

Tests: `INC-378 repair puts back the record a sorted write left outside its
manifest, and restore undoes it`; `INC-378 repair at the one-MiB edge splits the
store in two, and restore removes the second segment again`; `INC-378 repair takes
back a record appended after the last segment and keeps the store in eventHash
order`; `INC-378 repair refuses an expected record that is not in the store`;
`INC-378 repair refuses a named record whose removal does not leave the manifest
store`; `INC-378 repair refuses a record for an event the chain does not have`;
`INC-378 repair refuses a record whose occurredAt is not its event time`; `INC-378
repair refuses a backup directory inside the store or the workspace, or one that
is not empty`; `INC-378 restore refuses a backup that changed by one byte`;
`INC-378 restore refuses when the store holds a receipt the backup does not`;
`INC-378 a relocation receipt in the directory is listed by verify and left alone
by repair and restore`.

## Status

`tcrn.time-attestation.v1` is a CLI artifact contract, deliberately outside
extension-registration-v1 and outside the workspace trust boundary. It defines no
engine hook and no schema surface. A future authenticated-time design, if one is
ever built, would be a separate registered contract.
