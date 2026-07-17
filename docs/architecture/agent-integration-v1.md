# Agent-Integration Reference V1

This is the CLI consumption contract for an automated agent driving the governed
workflow. It documents existing behavior only. The sole normative additions are
the retry obligations in section 3, which constrain callers, not the engine. The
authority for read-surface staleness is the "Authority and layout" section of
`packages/core/spec/file-engine-v1.md`; this reference cites it and adds no
divergent semantics.

## 1. Surfaces

Two invocation surfaces exist. The shipped binary runs every `availability: "cli"`
verb over the default `CliIo`. A programmatic embedder that constructs its own
`CliIo` — supplying host authority the binary refuses to take from argv — reaches
the `availability: "programmatic-only"` verbs as well. The two programmatic-only
verbs both require a host-supplied compatibility admission authority and fail
closed with `COMPATIBILITY_AUTHORITY_REQUIRED` from the shipped binary:

```
programmatic-only
compatibility-dry-run
compatibility-plan
```

The `commands` verb is the discovery root. It emits the schema-valid, byte-stable
`COMMAND_CATALOG` — every verb with its flags, `availability`, and `mutates`
status. An agent enumerates capability from that catalog rather than from prose;
this document stays in drift-guarded agreement with it (see the read-surface
test). Never hardcode a verb list an agent could instead read from `commands`.

## 2. Envelopes

Every verb writes exactly one canonical-JSON document to stdout on success.

- Mutation verbs return the created or mutated record identity additively in the
  envelope (id, revision, tombstone; work adds kind/status/projectId/parentId),
  so an agent never reads a view off disk to learn the id it just wrote.
- List verbs return `{reasonCode, kind, total, records, truncated}` under bounded
  `--limit`/`--offset`; show verbs return a single `record`.
- On failure the shipped binary writes nothing to stdout, writes
  `{ok:false, reasonCode, error}` to stderr, and exits 1. The `reasonCode` is the
  stable machine contract; `error` is human text and must not be parsed.

## 3. Retry table

Every recommendation names the exact reason code and a governed remediation verb.
No free-form advice. Retriable rows are transient; non-retriable rows are
workflow or corruption conditions the agent must resolve before re-issuing.

| Reason code | Class | Obligation |
| --- | --- | --- |
| `WORKSPACE_VIEW_STALE` | Retriable | Views lag authority (a writer committed an event but had not yet rewritten the derived views, or crashed between the two). Re-read up to a small fixed bound. Retry after the holding writer's lease expiry or on observed version progress. If it persists, acquire the lease and run `recover`, which rebuilds the views from the authoritative chain. Reads only — `status` reads authority and never raises this code. |
| `WORKSPACE_LOCKED` | Retriable (out-of-process) | Another live writer holds the single-writer lease, or a lease is inside its documented creation grace period. The CLI does not busy-retry internally; the agent backs off and re-invokes the same verb later. Never delete lease files by hand — that is a fail-closed corruption path. |
| `WORKSPACE_CAS_MISMATCH` | Retriable (after re-plan) | The supplied `--expected-version` diverged from the committed version, or a concurrent claim raced the append. Re-read the current version (via `status` or a list envelope), re-derive the intended mutation from fresh state, and re-issue. When the decision does not depend on previously read record contents, `--expected-version head` derives the version under the held lease and avoids the two-step read (see section 4). |
| `WORKSPACE_LEASE_OBSERVED` | Informational | Success code of `lease-inspect`. Reports lease presence/holder for an operator deciding whether a `WORKSPACE_LOCKED` writer is live or abandoned. Not an error. |
| `WORKSPACE_LEASE_BROKEN` | Informational | Success code of `lease-break`. The named stale lease was quarantined by an operator-authorized escape hatch. Break only a lease first confirmed abandoned via `lease-inspect`. |
| `WORKSPACE_LEASE_INVALID` | Non-retriable | A lease or mutation claim is linked, special, malformed, or bound to a foreign generation. Fail closed; the agent stops and requires operator verification via `lease-inspect`. Never auto-retry over a corrupt lease. |
| `WORKSPACE_GATE_PENDING` | Non-retriable | A workflow precondition, not a transient: a governed gate on the target work is not yet satisfied, so the transition is refused. Retrying is futile. The gate must be transitioned to a satisfying state through its own governed verb before the work transition is re-issued. |
| `SNAPSHOT_RESIDUE_PRESENT` | Non-retriable | The control tree carries claim/quarantine residue at snapshot time. Resolve per the residue taxonomy (recover-cleanable classes via `recover`; manual-removal and lease-break classes as documented) before re-running the snapshot witness. |
| `SNAPSHOT_MISMATCH` | Non-retriable | A copied control tree does not recompute to its saved manifest. The copy is not a faithful snapshot; re-take the snapshot from a quiesced workspace rather than retrying the verify. |

Other `SNAPSHOT_*` codes (`SNAPSHOT_MANIFEST_INVALID`, `SNAPSHOT_MANIFEST_SCHEMA_VERSION`, `SNAPSHOT_PATH_INVALID`, `SNAPSHOT_INPUT_INVALID`, `SNAPSHOT_VERIFY_SCHEMA_VERSION`) are input/shape failures of the snapshot witness verbs and are corrected by fixing the input, not by retrying.

## 4. Sentinels

Flag-value sentinels carry a fixed meaning across verbs.

- `-` is the canonical null sentinel for a nullable flag; an omitted flag is also
  null. It applies to: `knowledge-create` `--project-id` and `--last-verified`;
  `work-create` `--parent-id`; `gate-create` `--work-id`; and `profile-authorize`
  `--workspace-id`, `--project-id`, and `--command`.
- `null` is a deprecated alias for `-`, accepted this release for external
  compatibility on `knowledge-create` `--project-id` and `--last-verified` only.
  Prefer `-`; the alias may be withdrawn in a later release.
- `head` is valid for `--expected-version` on the workspace-event mutation verbs
  only. Under the held lease it derives the current version, so the CAS check
  passes by construction and no read-version-then-mutate two-step is needed.
  It forfeits intent-level lost-update detection: a concurrent writer's committed
  change between the caller's planning read and its mutation goes undetected.
  Numeric `--expected-version` is the default and the correct choice whenever the
  mutation is derived from previously read record contents. `head` is rejected on
  knowledge-marker mutations (`knowledge-create`, `knowledge-promote`) with
  `CLI_ARGUMENT_MALFORMED`. The verbs accepting `head` are: `project-create`,
  `project-update`, `project-delete`, `work-create`, `work-transition`,
  `work-delete`, `conference-open`, `conference-append-position`,
  `conference-close`, `conference-cancel`, `gate-create`, `gate-transition`, and
  `gate-delete`.

The `--flag=value` attached form (split on the first `=`) lets a value legitimately
begin with `--`; the two-token `--flag value` form rejects a value beginning with
`--`, which doubles as missing-value detection.

## 5. Budgets

- Each argument token is capped at 65,536 characters; an overlong token fails
  closed with `CLI_INPUT_OVERSIZED` before parsing.
- List verbs are bounded by `--limit`/`--offset`; an envelope's `truncated` flag
  signals more records beyond the page.
- All emitted paths are workspace-relative under `.tcrn-workflow/`; the contract
  embeds no host root path.

## 6. Determinism guarantees

For an identical committed event basis, every read verb emits byte-identical
canonical JSON: stable key order, sorted records, and no host paths, wall-clock
reads, or randomness in the output. An agent may hash a read envelope to detect
change and may compare two invocations byte-for-byte. Mutations are the only
source of new versions, and each admitted mutation advances the version by one.
