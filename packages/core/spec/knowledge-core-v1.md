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
views, default selection, or checkpoints. Body bytes are reachable only through
the explicit body-read API or governed CLI command.

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
and snippet, inert current-source references and digest, ordered work/decision/
gate/evidence links, lifecycle, retrieval and export dispositions, promotion,
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

Creation always starts in `candidate` promotion state. The only V1 transitions
are candidate to `promoted` or `rejected`; promoted and rejected states are
terminal. Candidate bodies require an explicit override on the explicit body
surface and are never checkpointed.

## Limits and privacy

V1 limits body bytes to 8192, summary bytes to 2048, snippet bytes to 512,
metadata bytes to 32768, records to 16, query results to 8, aggregate store
bytes to 128 KiB, source locators to 16, each link class to 64, tags to 32, and
role scopes to 16.

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
