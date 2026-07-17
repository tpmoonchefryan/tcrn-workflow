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
  attests, also the receipt's file basename (`<eventHash>.json`).
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

## Excluded from export and archive

`exportWorkspace` and `createWorkspaceArchive` read only the event chain. Receipts
live outside the workspace root and are never part of an export or archive, so
export and archive bytes are identical whether or not receipts exist. The
determinism suites therefore never observe a clock.

## Best-effort, no governance weight

Receipt writes sit outside the lease and mutation claim. The mutation event is
committed first; a crash or write failure between commit and receipt loses only
the advisory receipt, never workspace state. A receipt carries **no governance
weight**: it is not authenticated time and confers no trust without an external
time authority. Downstream tooling must not treat a receipt as proof of when a
decision was made — only that some process holding that clock observed the stated
reading.

## Status

`tcrn.time-attestation.v1` is a CLI artifact contract, deliberately outside
extension-registration-v1 and outside the workspace trust boundary. It defines no
engine hook and no schema surface. A future authenticated-time design, if one is
ever built, would be a separate registered contract.
