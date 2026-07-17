# Public AOS Requirements V1

## Scope & Applicability

This document is normative and describes the generic public requirements ledger
at `extensions/aos-requirements-v1.json`, admitted by the P2 protocol proof
(`validateAosLedger`). The ledger is the single, implementation-neutral list of
stable requirement identifiers that every AOS-facing P2 schema and protocol
fixture links to. It inherits the canonical-JSON and `utf8-byte-order-v1` rules
from `protocol-common-v1`. The ledger's own `schemaVersion` is
`tcrn.aos-requirements.v1`.

## Record Shape

The ledger is an object with `schemaVersion` (`tcrn.aos-requirements.v1`), a
non-empty `requirements` array, and a `prohibitedClaims` array. Each requirement
entry has an exact, closed field set of precisely `id`, `subject`, and
`maturity`:

| Field      | Rule                                                              |
| ---------- | ---------------------------------------------------------------- |
| `id`       | matches `^AOS-REQ-[0-9]{3}$` and is unique within the ledger      |
| `subject`  | a stable subject slug                                            |
| `maturity` | one of exactly `specified` or `fixture_verified`                 |

The ledger declares `prohibitedClaims` (live-endpoint, credential,
database-layout, current-runtime-mutation, supported-release-pair) as the classes
of assertion it must never make. The ledger object MUST NOT carry any of the
forbidden implementation keys `endpoint`, `credential`, `database`,
`releasePairs`, or `runtimeMutation`.

## Digest & Canonicalization

The ledger bytes are canonical JSON (recursive `utf8-byte-order-v1` key ordering,
safe integers only, one terminal LF). Every AOS-facing P2 schema references its
requirement IDs through `x-tcrn-aos-requirementIds`, and every protocol fixture
through `requirementIds`; the proof reads those bytes directly rather than a
reconstructed object.

## Reason Codes

The ledger admission emits codes from the P2 protocol proof:

- `AOS_LEDGER_SCHEMA` — the ledger `schemaVersion` is not
  `tcrn.aos-requirements.v1`.
- `AOS_LEDGER_EMPTY` — `requirements` is absent or empty.
- `AOS_REQUIREMENT_ID` — a requirement `id` does not match `AOS-REQ-NNN`.
- `AOS_REQUIREMENT_DUPLICATE` — the same `id` appears twice.
- `AOS_MATURITY_OVERCLAIM` — a `maturity` outside `{specified, fixture_verified}`.
- `AOS_REQUIREMENT_FIELDS` — a requirement whose field set is not exactly
  `{id, subject, maturity}`.
- `AOS_IMPLEMENTATION_ASSUMPTION` — a forbidden implementation key on the ledger.
- `AOS_REQUIREMENT_LINK_MISSING` — an AOS-facing schema or protocol fixture that
  lists no requirement IDs.
- `AOS_REQUIREMENT_UNKNOWN` — a linked ID that is not present in the ledger.
- `AOS_REQUIREMENT_UNREFERENCED` — a ledger ID that no schema or fixture links.

## Ordering & Determinism

Requirement identifiers are unique and each links bidirectionally: every ledger
ID is referenced by at least one AOS-facing file, and every referenced ID exists
in the ledger. Object keys serialize in `utf8-byte-order-v1` order under
canonical JSON, so the ledger bytes are a stable function of its content.

## Failure Semantics

Admission is fail-closed and total: the first violated rule stops with its
specific reason code. Maturity is capped at `specified` or `fixture_verified`;
the ledger is intentionally implementation-neutral and asserts no live
compatibility and no current-runtime mutation. Later adoption must produce
separate evidence without rewriting these V1 protocol meanings.

## Non-Goals

The ledger contains no endpoint, credential, database assumption, current-runtime
mutation, supported-release pair, or private deployment fact. It is a naming and
linkage contract, not an execution surface; runtime adoption of any requirement
is out of scope here.
