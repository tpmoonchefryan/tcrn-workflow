# File-Native Knowledge Core V1

P4 Knowledge Core is an offline, metadata-first store layered beside the P3
Workspace authority. Initialization is clean and empty, and V1 admits only
explicit synthetic Workspaces whose external key starts with `FIXTURE-`.
Initialization never searches, imports, migrates, infers, or consults any
predecessor knowledge or workflow source.

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
references and digest, ordered work/decision/gate/evidence links, lifecycle,
retrieval and export dispositions, promotion,
freshness, last verification instant, staleness policy, focused redaction,
authority, provenance, body digest/size, revision, and update instant.

The implementation constructs and validates the frozen P2 Knowledge record for
every accepted metadata/body pair. It does not alter P2 schemas or canonical
semantics.

## Freshness, promotion, and retrieval

Freshness is evaluated at an explicit strict instant. Missing verification is
`unknown`; an expired age window is `stale`. Default selection and checkpoints
fail closed by excluding stale and unknown records, candidates, rejected or
retired records, non-default retrieval, and excluded export disposition.

An explicit-current-source record requires a nonempty admitted source-reference
set, nonempty linked-evidence set, and an `owner:*` accountable-owner reference
at creation and again at promotion. The owner reference is provenance
accountability only: it does not claim P5 profile admission or identity
resolution. Creation always starts in `candidate` promotion state. The only V1 transitions
are candidate to `promoted` or `rejected`; promoted and rejected states are
terminal. Candidate bodies require an explicit override on the explicit body
surface and are never checkpointed.

Promotion input is admitted as exactly `promoted|rejected` before the mutation
claim is acquired. Every non-crash error after claim acquisition releases only
the identity-bound claim generation before returning its frozen reason code, so
an invalid request cannot poison an otherwise valid store or block a later
valid mutation.

## Limits and privacy

V1 limits body bytes to 8192, subject bytes to 512, summary bytes to 2048,
snippet bytes to 512, each source-reference string to 512,
metadata bytes to 32768, records to 16, query results to 8, aggregate store
bytes to 128 KiB, source locators to 16, each link class to 64, tags to 32, and
role scopes to 16.

These text budgets are UTF-8 byte budgets. Draft 2020-12 `maxLength` counts
Unicode code points and is retained only as a structural bound. P4 schema proof
registers the local `x-tcrn-maxUtf8Bytes` assertion and executes multibyte
max/max+1 parity vectors; stock JSON Schema alone is not claimed to enforce
UTF-8 byte length.

Source and evidence locators are inert strings. The store performs no URL
resolution, network access, database access, AOS access, or implicit process
launch. Locators must already satisfy the accepted focused reference-redaction
policy; this remains a bounded policy and is not a general DLP claim.

## Governed surfaces

Core exports empty initialization/validation, creation, metadata listing and
filtering, bounded snippet read, explicit body read, freshness evaluation,
promotion transition, and metadata-only checkpoint generation. CLI commands
mirror these surfaces. `P4_KNOWLEDGE_CORE_VERIFIED` proves only this bounded
file-native capability; it does not mark the graph work done or start RC2/P5/P6.

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
