# The governed loop, end to end

This tutorial walks the whole product in one sitting: from an empty workspace to a
completed story whose closing decision is ratified in a conference, distilled into
the knowledge store, promoted, and then traced back through an unbroken chain of
digests. Every command below is a real governed CLI verb, and every one of them is
replayed verbatim by the hermetic proof `tests/e2e-governed-loop.test.mjs` under
`pnpm verify:e2e` — the tutorial and the proof are diffed against each other, so a
command that drifts here fails the build.

The loop is:

**initiative → epic → story → gate → conference → distill → promote → trace.**

## Conventions

- Commands are shown with a `$ ` prompt and the published binary name
  `tcrn-workflow`. Substitute your own installed invocation as needed.
- Paths are workspace-relative placeholders (`./flagship/workspace` and its four
  sibling roots). Identifiers written as `<project-id>`, `<story-id>`, and so on
  stand for the id echoed by the previous command's receipt — copy the real value
  from that output.
- Every mutation takes an explicit `--at` instant and an `--expected-version`
  compare-and-set guard. The instants here are illustrative and deterministic;
  supply your own real timestamps in practice.
- The loop stays actor-optional: attestation is never enabled, so no `--actor` is
  required. Enable it first if your workspace mandates attested writes.

## 0. Create the workspace

`init` establishes the five explicit roots and leaves the workspace at version 0.

```console
$ tcrn-workflow init --workspace ./flagship/workspace --framework ./flagship/framework --transient ./flagship/transient --evidence-locator ./flagship/evidence-locator --release-trust ./flagship/release-trust --external-key FLAGSHIP-WORKSPACE --at 2026-07-11T00:00:00Z
```

The receipt reports `WORKSPACE_COMMAND_COMPLETED` at `version` 0. Each mutation
below advances the version by exactly one.

## 1. Plan the delivery graph: initiative → epic → story

First a project, then the frozen planned-delivery hierarchy under it. `work-create`
echoes the new record's id in `record.id`; capture each one for the next parent.

```console
$ tcrn-workflow project-create --workspace ./flagship/workspace --expected-version 0 --at 2026-07-11T00:00:01Z --external-key FLAGSHIP-PROJECT --name Flagship
$ tcrn-workflow work-create --workspace ./flagship/workspace --expected-version 1 --at 2026-07-11T00:00:02Z --project-id <project-id> --external-key FLAGSHIP-INITIATIVE --kind Initiative
$ tcrn-workflow work-create --workspace ./flagship/workspace --expected-version 2 --at 2026-07-11T00:00:03Z --project-id <project-id> --external-key FLAGSHIP-EPIC --kind Epic --parent-id <initiative-id>
$ tcrn-workflow work-create --workspace ./flagship/workspace --expected-version 3 --at 2026-07-11T00:00:04Z --project-id <project-id> --external-key FLAGSHIP-STORY --kind Story --parent-id <epic-id>
```

Each verb returns `WORKSPACE_COMMAND_COMPLETED` with the created `record`. The Epic
names the Initiative as its `--parent-id`, and the Story names the Epic — the graph
is validated on every append.

## 2. Move the story into flight

A story is planned when created. Walk it through the lifecycle to `active`, the
state from which a governing gate will stand between it and `done`.

```console
$ tcrn-workflow work-transition --workspace ./flagship/workspace --expected-version 4 --at 2026-07-11T00:00:05Z --id <story-id> --status ready
$ tcrn-workflow work-transition --workspace ./flagship/workspace --expected-version 5 --at 2026-07-11T00:00:06Z --id <story-id> --status active
```

## 3. Raise the gate

A work-item gate anchored to the story is born `pending`. While it is pending, the
engine refuses to move the story to `done` (`WORKSPACE_GATE_PENDING`) — the gate is
the governed decision point the rest of the loop resolves.

```console
$ tcrn-workflow gate-create --workspace ./flagship/workspace --expected-version 6 --at 2026-07-11T00:00:07Z --external-key FLAGSHIP-GATE --project-id <project-id> --work-id <story-id> --title Decision-gate --outcome-class role_decision
```

Capture the gate id from `recordId`.

## 4. Hold the conference

Open a conference anchored to the story, record a position, then close it into
minutes. The close is the anchoring evidence the gate will require.

```console
$ tcrn-workflow conference-open --workspace ./flagship/workspace --expected-version 7 --at 2026-07-11T00:00:08Z --external-key FLAGSHIP-CONFERENCE --project-id <project-id> --type architecture --title Decide-the-story --work-ids <story-id> --desired-outcome ratify-the-approach --participant-ids profile:architect-01
$ tcrn-workflow conference-append-position --workspace ./flagship/workspace --expected-version 8 --at 2026-07-11T00:00:09Z --conference-id <conference-id> --external-key FLAGSHIP-POSITION --actor-id profile:architect-01 --position persist-via-event-log --risks forward-reads-as-corruption --recommendations document-the-posture --evidence-ids evidence:position-01
```

Capture the conference id from the open receipt's `recordId`.

## 5. Distill the decision into knowledge

Before closing with distillation, initialize the disposable knowledge store — a
real (non-fixture) workspace requires explicit acknowledgment that the store is
rebuildable and disposable.

```console
$ tcrn-workflow knowledge-init --workspace ./flagship/workspace --acknowledge-disposable true
```

Now close the conference with `--distill`. The close event lands first; the
governed high-water rebind re-binds the knowledge store to the advanced head, then
each minutes decision is captured as a promotable knowledge candidate. The receipt
carries the minutes id in `recordId` and the new candidate id in `knowledgeUnitIds`.

```console
$ tcrn-workflow conference-close --workspace ./flagship/workspace --expected-version 9 --at 2026-07-11T00:00:10Z --conference-id <conference-id> --minutes-external-key FLAGSHIP-MINUTES --summary approach-ratified --outcome-class role_decision --decisions persist-conference-and-gate-records --unresolved-issues - --distill true --accountable-owner-id owner:governance --stale-days 90 --evidence-ids evidence:close-01
```

The candidate carries the fixed conference tag set
(`conference-decision`, `distilled`, `type-architecture`), the deduplicated evidence
union of the position and the close, and a `sourceDigest` bound to the full minutes
basis — everything the promotion gate demands.

## 6. Promote the candidate

Read the knowledge marker version, list the candidate, then promote it. Promotion
happens now, while the knowledge marker's high-water still equals the workspace
head — before the final workspace mutations advance it.

```console
$ tcrn-workflow knowledge-validate --workspace ./flagship/workspace
$ tcrn-workflow knowledge-list --workspace ./flagship/workspace --at 2026-07-11T00:00:11Z --selection all
$ tcrn-workflow knowledge-promote --workspace ./flagship/workspace --expected-version <knowledge-version> --expected-revision <knowledge-revision> --at 2026-07-11T00:00:12Z --id <knowledge-id> --state promoted
```

`knowledge-validate` reports the marker `version` (use it as `<knowledge-version>`);
`knowledge-list --selection all` returns the candidate record (use its `id` and
`revision`). Promotion returns `KNOWLEDGE_PROMOTION_UPDATED` with `promotionState`
`promoted`.

## 7. Satisfy the gate and finish the story

The same minutes that produced the knowledge candidate satisfy the gate. The
satisfaction locator is `conference-minutes:` followed by the minutes id's suffix.
Once the gate is `satisfied`, the story is free to reach `done`.

```console
$ tcrn-workflow gate-transition --workspace ./flagship/workspace --expected-version 10 --at 2026-07-11T00:00:13Z --id <gate-id> --status satisfied --minutes-locator <minutes-locator>
$ tcrn-workflow work-transition --workspace ./flagship/workspace --expected-version 11 --at 2026-07-11T00:00:14Z --id <story-id> --status done
```

## 8. Trace the chain

Finally, read the two governed records the chain hangs from and confirm the loop
binds end to end.

```console
$ tcrn-workflow work-show --workspace ./flagship/workspace --id <story-id>
$ tcrn-workflow gate-list --workspace ./flagship/workspace --work-id <story-id>
```

The trace is a chain of digests, each link a field of one record that names the
next:

1. **Work record → gate card.** `gate.workId` equals the story id: the gate governs
   this exact work item, and the story reached `done` only because the gate is
   `satisfied`.
2. **Gate card → conference minutes.** The gate's persisted
   `gate-evidence:conference-minutes` locator resolves to the minutes id from the
   distilling close.
3. **Conference minutes → knowledge candidate.** The candidate's `sourceDigest` is
   the canonical hash of the minutes basis (title, decision, minutes id) — recompute
   it and it matches, so the candidate provably came from these minutes.
4. **Knowledge candidate → promotion receipt.** The promotion receipt names the same
   candidate id, now `promoted`.

No link reads a host path or a hostname — the chain is carried entirely by content
digests and governed record ids, so it is reproducible on every machine. That is the
whole governed loop: planned, gated, deliberated, distilled, promoted, and proven.
