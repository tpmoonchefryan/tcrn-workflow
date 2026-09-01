# File-Native Knowledge Core V1

P4 Knowledge Core is an offline, metadata-first store layered beside the P3
Workspace authority. Initialization is clean and empty. It admits fixture
Workspaces (external key prefixed `FIXTURE-`) implicitly, and any other Workspace
only under an explicit per-invocation disposability acknowledgment; without it
initialization fails closed. The store remains a disposable derived index that is
never the system of record. Initialization never searches, imports, migrates,
infers, or consults any predecessor knowledge or workflow source.

## Storage and authority

The store is `.tcrn-workflow/knowledge/` with closed `store.json`, `metadata/`,
`bodies/`, and `views/index.json` entries. Metadata is the index authority.
Bodies are separate single-link regular files and never appear in metadata
views, default selection, or checkpoints. Metadata listing, snippet, freshness,
and checkpoint surfaces enumerate the closed body-name set but never open or
read body files. Full validation and mutations validate all body bindings;
explicit body read validates only the requested body through its bound
descriptor.

The store marker binds the exact Workspace ID and event high-water digest. All
mutations require an exclusive no-follow claim and exact store-version CAS.
Promotion additionally requires record-revision CAS. Descriptor-bound reads
bind device, inode, size, mode, and nanosecond change metadata. Atomic
replacement uses exclusive no-follow temporary files. Link, special-file,
source-replacement, partial/crash, count, size, and aggregate violations fail
closed. P1 Option-B remains the ancestor-component threat boundary.

## Metadata

`KnowledgeUnitMetadata` is closed and binds its stable ID/external key, scope,
project and role scopes, category, kind, ordered tags, subject, bounded summary
and snippet, a P4-only accountable-owner protocol reference, inert current-source
references and digest, an optional `supersedes` knowledge id, ordered
work/decision/gate/evidence links, lifecycle,
retrieval and export dispositions, promotion,
freshness, last verification instant, staleness policy, focused redaction,
authority, provenance, body digest/size, revision, and update instant.

The implementation constructs and validates the frozen P2 Knowledge record for
every accepted metadata/body pair. It does not alter P2 schemas or canonical
semantics.

## Freshness, promotion, and retrieval

Freshness is evaluated at an explicit strict instant. A null
`stalenessPolicy.maximumAgeDays` is change-driven and never expires by the clock;
cards with no verification instant are still selectable. A finite policy marks
an expired age window `stale`, but a missing verification instant is not made
unselectable by an `unknown` result. Default selection and checkpoints exclude
stale records, candidates, rejected or retired records, non-default retrieval,
and excluded export disposition.

Fragment kinds (`fact`, `decision`, and `summary`) may be written without source
or evidence links and are directly selectable when their other fields admit it.
`guide` and `reference` retain their source/evidence provenance floor; a
`reference` without those links is rejected at capture. Sourced records may still
use the compatibility promotion transition, while a source-free fragment is
ready at capture. The owner reference remains provenance accountability only; it
does not claim P5 profile admission or identity resolution.

`knowledge-batch` accepts `knowledge-policy` members for a bounded metadata
migration. Each member supplies an id (or external key), an expected revision,
and the replacement `{maximumAgeDays, unknownDisposition}` policy. The member
advances the disposable store version and metadata revision without changing the
body, source digest, or verification instant; setting `maximumAgeDays` to `null`
also removes a stale posture that came only from the retired calendar policy.

Promotion input is admitted as exactly `promoted|rejected` before the mutation
claim is acquired. Every non-crash error after claim acquisition releases only
the identity-bound claim generation before returning its frozen reason code, so
an invalid request cannot poison an otherwise valid store or block a later
valid mutation.

## Limits and privacy

V1 limits body bytes to 8192, subject bytes to 512, summary bytes to 2048,
snippet bytes to 512, each source-reference string to 512,
metadata bytes to 32768, the default query page to 8 results, aggregate store
bytes to 1 MiB, source locators to 16, each link class to 64, tags to 32, and
role scopes to 16. The aggregate limit is the protocol canonical-view ceiling:
35 measured cards occupied 63,316 source-of-truth bytes and their derived index
occupied 52,851 bytes, or 5.0% of 1,048,576 bytes. The index is verified
separately and is not charged twice. Listing more matches than one page truncates with a
`{total, offset, truncated}` continuation window rather than failing closed, and a
bounded case-insensitive substring over subject, summary, snippet, and tags narrows
results without loading bodies. `knowledge-source-check` is the explicit source
file comparison surface; ordinary reads do not scan every source file.

These text budgets are UTF-8 byte budgets. Draft 2020-12 `maxLength` counts
Unicode code points and is retained only as a structural bound. P4 schema proof
registers the local `x-tcrn-maxUtf8Bytes` assertion and executes multibyte
max/max+1 parity vectors; stock JSON Schema alone is not claimed to enforce
UTF-8 byte length.

Source and evidence locators are inert strings. The store performs no URL
resolution, network access, database access, AOS access, or implicit process
launch. Locators must already satisfy the accepted focused reference-redaction
policy; this remains a bounded policy and is not a general DLP claim.

## High-water rebase

The store marker binds the workspace event head at which it was last consistent.
Any workspace event advances that head, and every knowledge read then fails
closed with `KNOWLEDGE_HIGH_WATER_MISMATCH` until a governed rebase re-binds the
store. Rebase re-validates every record's full metadata shape, body binding, and
scope/project/work links against the new workspace state. A live record whose
scope/project or linked-work references no longer resolve is an offender: the
rebase fails closed with `KNOWLEDGE_REBASE_BLOCKED` and a deterministic id-sorted
offender list, unless `retire-invalid` is given, in which case exactly those
records are retired (lifecycle `retired`, a tombstoned audit record whose dangling
backlinks are then durably tolerated) and every retained record is byte-identical.
Rebase is a single version step under the mutation claim; a fault at either write
point leaves the claim present so the next admission fails closed
(`KNOWLEDGE_PARTIAL_STATE`/`KNOWLEDGE_LOCKED`), never accepting a half-rebased
marker. The store is not event-sourced, so rebase — not re-initialization — is the
only path that preserves records across workspace events.

## Lifecycle

A promoted record can be re-verified: `reverify` touches `lastVerified` to the
supplied instant and restores a fresh posture under CAS, so promoted knowledge
does not decay irreversibly out of default selection; only a promoted, non-retired
record admits it. A record of any lifecycle can be `retire`d — it becomes a
tombstoned audit entry (lifecycle `retired`) whose dangling backlinks are durably
tolerated and which leaves default selection. Retiring frees a live create slot:
there is no independent record-count cap. Retired metadata remains an audit entry
and its body may be reclaimed, while the aggregate source-byte budget still counts
the metadata that remains on disk. Capacity is therefore controlled by the
canonical byte ceiling, not by a historical count or by a retired-record allowance.

## Governed surfaces

Core exports empty initialization/validation, creation, metadata listing and
filtering, bounded snippet read, explicit body read, freshness evaluation,
promotion transition, re-verify, retire, high-water rebase, and metadata-only
checkpoint generation. CLI commands mirror these surfaces.
`P4_KNOWLEDGE_CORE_VERIFIED` proves only this bounded file-native capability; it
does not mark the graph work done or start RC2/P5/P6.

## KR-05 fact-card mapping appendix (WS-F)

This appendix aligns the AOS KR-05 fact-card entry convention with product
`KnowledgeUnitMetadata`. It records the correspondence; it does not reconcile the
two, and discrepancies are noted rather than silently normalized.

KR-05 fact-card entry fields are defined by `Kr05SeedEntryCandidate` in the AOS
repository (`packages/db/src/knowledge-seed-convention.ts`) as structured entry
fields plus mandatory body sections — not document frontmatter. Product
`KnowledgeUnitMetadata` is defined in `packages/core/src/knowledge-core.ts`.

| KR-05 fact-card field | KnowledgeUnitMetadata field | Note |
|---|---|---|
| `id` | `id` | Both are stable identifiers. |
| `title` | `subject` | Renamed; same role. |
| `roleScope` | `roleScopes[]` | KR-05 single scope; product is a bounded array. |
| `project` | `projectId` | Renamed. |
| `category` | `category` | KR-05 uses a free string; product uses a closed 8-value enum. Discrepancy recorded. |
| `knowledgeKind` | `kind` | KR-05 `fact_card_convention` vs the product closed kind enum (fact/guide/decision/reference/summary). Discrepancy recorded. |
| `status` | `lifecycle` / `promotionState` | KR-05 `canonical`/… maps onto the product lifecycle and promotion vocabularies. Discrepancy recorded. |
| `lastVerified` | `lastVerified` | Same field. |
| `stalenessPolicy` | `stalenessPolicy` | KR-05 uses a string (`review_after_30_days`); product uses a structured object (`{maximumAgeDays, unknownDisposition}`). Discrepancy recorded. |
| `sourceRef` | `sourceReferences[]` | KR-05 single ref; product is a bounded array. |
| `sourceDigest` | `sourceDigest` | Same field. |
| `tags` | `tags[]` | Same role. |
| `summary` | `summary` | Same field. |
| `body` (+ required sections) | `snippet` / explicit body read | Product separates a bounded snippet from an explicit body read; KR-05 mandatory body sections (invariants, settings_and_cross_module_interactions, gotchas, source_refs_with_digests) are body content. |

The KR-05 required body sections have no dedicated `KnowledgeUnitMetadata` fields;
they are body content governed by the product body/snippet budgets. This mapping
is a documentation alignment for the shared knowledge-records requirement
(AOS-REQ-006); it adds no schema surface and no engine code.
