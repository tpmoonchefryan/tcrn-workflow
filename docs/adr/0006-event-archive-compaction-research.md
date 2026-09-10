# ADR 0006: Research shape for cold-segment archive and compaction

- Status: Option D adopted for current operation; V2 not started
- Date: 2026-09-10
- Governs: TCRN-CROSS-STORY-381 and the future storage-version-2 decision
- Related: `docs/2026-07-17-p3-compaction-deferral-decision.md`

## Decision status

This document is a decision package, not a V2 implementation. V1 keeps its
authoritative event chain, its 10,000-event ceiling, and its fail-closed
`applyWorkspaceMigration` boundary. Owner adopted Option D on 2026-09-11 when
approving the INIT-051 closeout remediation. Option A remains a research
alternative only; no V2 study or implementation is started by this decision.
Acceptance of the research package does not require starting a new programme.

## Closed reason and current measurements

The earlier compaction decision closed the V1 apply path because a rewrite would
need an exact backup, a defined transformation, full post-validation, and exact
rollback. `planWorkspaceMigration` can describe that boundary; the V1 apply
function fails with `WORKSPACE_MIGRATION_APPLY_UNAVAILABLE`. The counter at
`packages/core/src/workspace.ts` counts chain events, including updates,
transitions, tombstones, and extension events, rather than live records. The
same replay path checks the event count before append and during replay.

The read-only prototype freezes `status`, paged `event-list`, and
`snapshot-manifest` through the CLI. The 2026-09-10 cross-project sample was:

| Measure | Result | Meaning |
| --- | ---: | --- |
| Chain version / event count | 5,640 / 10,000 | 4,360 event slots remain; live-record count is not the cap counter |
| Materialized control-tree bytes | 18,798,373 | Snapshot-manifest sum, including event, knowledge, snapshot, and view files |
| Older event segment files selected | 6 files in 3 segment pairs | The newest numbered event segment remains in the simulated live tail |
| Estimated cold archive bytes | 13,756,957 | Existing `.ndjson` and `.idx` bytes; no archive was written |
| Estimated archive envelope | 13,757,930 | Cold bytes plus a digest-bearing archive index |
| Estimated control bytes after move | 5,041,728 | Retained control bytes plus a small head-root record |
| Current `status` timing | median 536.6 ms; p95 565.7 ms | 20 serial CLI observations after one warm-up |
| Simulated tail load | median 1.6 ms; p95 2.3 ms | In-process digest over 167 proportionally selected frozen records; not a V2 status measurement |

The prototype's negative probes detect both a missing cold file and a changed
digest. The input digest before and after the run was
`5e22ca997cd5d1dac028bcf73e123b7137bac1ce6926dadbbffc4eae5185e839`; the live
chain version, head hash, and manifest file bytes were unchanged.

## Options

| Option | Shape | Cost and limitation | Falsifiable red leg | Recommendation |
| --- | --- | --- | --- | --- |
| A. Cold-segment archive plus head root | Move older event `.ndjson`/`.idx` pairs to `workspace.generatedArtifactsPath`; retain a digest-bearing archive index, the genesis rule, and the chain head root | Requires a storage-version-2 format, archive backup/retention, archive lookup during historical reads, migration downtime or quiescence, full rollback, and post-validation. Moving bytes does not by itself reduce the event counter. | Missing or tampered archive file; archive-index digest mismatch; source head or genesis mismatch; target replay, views, backup, or rollback validation failure | Recommended V2 research direction only; not admitted to V1 |
| B. Raise the event ceiling | Increase `PROTOCOL_LIMITS.maxChainEvents` and continue the current replay path | Defers the stop while increasing replay, backup, and view pressure. The 1 MiB materialized-view limit can bind before 10,000 live records, so the event limit is not the only capacity boundary. | An append or replay exceeds the declared cap; event-count and live-record semantics diverge; any view exceeds its declared byte limit | Reject as the sole remedy; keep the current V1 limit |
| C. Split the chain by partition | Create independently bounded chains and define cross-partition references and ordering | Requires atomicity, parent/reference resolution, backup/restore coordination, and a new operator model. It changes ownership of history but does not define cold-history retention. | Missing, duplicated, or out-of-order cross-partition event; unresolved parent/reference; inconsistent combined status or restore | Reject for this decision; revisit only with a separate partition protocol |
| D. Do not compact | Keep V1 authoritative history and stop appends at the existing cap | No implementation cost now, but operators eventually need a governed response before headroom reaches zero. It preserves all V1 integrity and recovery rules. | Any write passes the cap, silently discards history, or reports headroom as zero/unknown incorrectly | Safe V1 operating posture while Owner decides V2 |

## Proposed V2 acceptance envelope for Option A

Option A can be admitted only if all of the following are specified and proved
by a future implementation Story:

1. Quiesce and take an exact pre-migration backup before touching authoritative
   data.
2. Define the archive object, segment index, digest algorithm, genesis/head
   roots, retention, and the source-to-target transformation byte by byte.
3. Validate the target schema, complete chain, retained views, archive index,
   backup, and rollback path after the transformation.
4. Prove red legs for missing, truncated, tampered, stale, duplicated, and
   misordered cold segments. A head hash alone is not a substitute for those
   checks.
5. Keep the 10,000-event rule explicit. Moving old bytes out of the hot path
   does not authorize an append beyond the V1 event count.

The current prototype covers only the read-only evidence shape and the negative
integrity probes. It does not move files, rewrite events, change protocol
limits, change view budgets, or claim a V2 latency result.

## Event and view budget for summary backfill

Summary backfill remains a separate cost from archive research. One governed
summary update is one additional `work.updated` event, so the sample would move
from 5,640 to 5,641 events and from 4,360 to 4,359 headroom for one update.
The materialized view bytes must be measured in an isolated scratch write; this
package does not extrapolate them and does not write the live chain. Any future
backfill plan must reserve both event headroom and each view's byte headroom.

## Reproduction

Run the read-only prototype from the engine repository:

```text
corepack pnpm run research:compaction -- --workspace <cross-project-workspace> --runs 20 --at 2026-09-10T22:35:00Z
```

The implementation is `scripts/compaction-prototype.mjs`. It writes no output
file; its JSON stdout is the research record. The command uses only CLI read
verbs, reports the current `status` timing beside the labelled tail simulation,
and returns `liveChainUnchanged: true` when the frozen source digest and
manifest/head checks match after the run.

## Owner decision boundary

The current decision retains V1 as the only operating posture. A V2 design
study or separate partition protocol requires a future Owner decision. No policy approval
or prototype result is an implementation acceptance, and no external
publication, deployment, or release is implied.
