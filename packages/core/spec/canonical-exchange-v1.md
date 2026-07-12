# Canonical Exchange P7-A

P7-A is an offline, file-native exchange bundle. It imports the frozen P2
`tcrn.exchange.v1` envelope and does not redefine protocol serialization,
stable IDs, instants, extension admission, or exchange-entry semantics.

## Closed bundle

A request binds an exchange envelope, source and target Workspace IDs, one
transaction ID, one idempotency key, a semantic subject digest, and 1–128
canonical chunks. Chunks are ordered by UTF-8 byte order of logical path. Each
record binds logical and stored paths, media type, byte size, SHA-256, semantic
digest, index, and deterministic chunk ID. Duplicate paths, missing entries,
substitution, semantic mismatch, noncanonical base64, malformed Unicode, and
unknown fields fail closed.

The committed directory contains exactly `manifest.json`, `transaction.json`,
`resume.json`, and `chunks/`. Control documents are exact canonical JSON with one
terminal LF. The manifest binds the frozen P2 exchange envelope and every chunk.
The committed transaction binds the manifest, chunk count, total bytes, and
idempotency key. The resume record binds the complete sorted chunk-ID set and an
empty remaining set. Their digests plus ordered chunk digests form the bundle
digest; the full plan forms the plan digest.

Stored admission validates the closed manifest, transaction, resume, and every
nested chunk record before any nested field is dereferenced. The reader requires
equal-length, one-to-one, canonically ordered exchange-entry/chunk membership;
unique IDs, logical paths, and stored paths; and exact `bundleId`/`createdAt`
binding to the strict-instant P2 envelope. After descriptor-bound chunk reads it
reconstructs the complete request-derived manifest, transaction, and resume and
requires canonical equality. Caller-selected IDs, record order, stored paths, or
resealed control digests therefore cannot replace deterministic identity.

## Filesystem and limits

The reader admits only a real absolute bundle root, a closed file set, real
directories, regular single-link files, and descriptor-bound pre/open/post/named
identity. Symlinks, hardlinks, special files, replacement, missing/extra files,
partial bundles, traversal, backslashes, absolute logical paths, and limits fail
closed. Each chunk is at most 1 MiB, aggregate chunk bytes are at most 8 MiB,
there are at most 128 chunks, and logical paths are at most 256 UTF-8 bytes.
Directory iteration is bounded before full enumeration. Declared chunk count,
per-chunk bytes, aggregate bytes, and total bundle files are rejected before any
chunk descriptor is opened; cumulative declared and observed bytes are checked
again before every chunk read.

The writer requires a supported local filesystem and an existing real parent,
writes a deterministic partial generation with no-follow exclusive files,
rechecks the parent identity, and atomically renames the completed generation.
It never overwrites an existing output. A staging generation is cleanup-eligible
only after this invocation created it and recorded its directory device/inode/type.
`EEXIST`, links, and special files are never recursively removed. Cleanup
revalidates the exact owned identity and rejects replacement before removal.
Cooperative clean-checkout protection is retained; hostile concurrent
ancestor-component replacement is outside the P1 Option-B threat model.

The Draft 2020-12 proof evaluates the request plus closed stored manifest,
transaction, resume, and nested chunk-record definitions. Runtime parity vectors
cover null, primitive, missing/unknown fields, wrong types, malformed Unicode,
and limits. Cross-field derived identity, ordering, digest, and aggregate-sum
rules remain executable runtime invariants because JSON Schema does not express
those relationships by itself.

## Execution and transport boundary

Chunk bytes are data only. JSON chunks must already be canonical; text chunks
must be well-formed UTF-8. No candidate module, command, hook, script, URL, or
code is executed. The module imports no network or child-process client and does
not resolve locators. CLI surfaces are read-only `exchange-plan`,
`exchange-validate`, and `exchange-dry-run`; dry-run reports `mutation=false`,
`network=false`, and `codeExecution=false`. No AOS release, endpoint, credential,
runtime, database, API, compatibility mode, apply, or external effect is claimed.

## Residuals

This is P7-A only. Compatibility modes, AOS requirements, RC4, live transport,
signer/issuer policy, pair receipts, conflict resolution, and apply semantics are
separate later gates. The offline bundle is integrity-bound but not an external
signature or identity trust assertion.
