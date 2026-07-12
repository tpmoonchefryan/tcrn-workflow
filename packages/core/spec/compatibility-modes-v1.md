# Offline Compatibility And Modes V1

P7-B defines an offline-only planning boundary. A canonical, closed Workflow
compatibility manifest names the Workflow-owned definition fields and the
AOS-owned operational fields. These sets are disjoint. Plans preserve every
AOS-owned field and never apply a mutation.

Compatibility planning requires a separately governed canonical admission
receipt. Its absolute canonical path and raw file SHA-256 arrive only through a
host authority channel. Admission reads a regular single-link file through
`O_NOFOLLOW` and binds pre-open, opened, post-read and named
device/inode/size/mode/mtimeNs/ctimeNs identity. Canonical bytes and closed
fields are read incrementally from the opened descriptor with a hard
65537-byte observation cap; the reader stops on the first byte beyond the
65536-byte receipt limit before post-read validation. Same-inode sparse or
continuous growth therefore cannot cause unbounded allocation or I/O.
The closed canonical receipt binds the exact pair receipt, manifest and release pair, complete request
digest, effective plan digest, repository, workflow, subject, signer, issuer,
audience, nonce, verification time, policy floor, instance, data epoch,
revocation/replay snapshot and Workspace lock generation. The resulting context
is deeply frozen and module-branded; plain, copied or resealed objects cannot be
used by public plan APIs. Prompt, environment, request and CLI fields cannot
supply the authority path or digest.

The deterministic operations are `initial_import`, `portable_checkpoint`,
`fallback_admission`, `fallback_delta`, `conflict_plan` and
`reconciliation_dry_run`. All outputs are canonical, byte-ordered plans with
`mutation=false` and `network=false`. Ownership fields and external-effect IDs
are semantic sets normalized by frozen UTF-8 byte order before manifest,
request and plan hashing, so equivalent set order has identical bytes and
digests. A checkpoint used for fallback delta or
reconciliation must match instance/data epoch and meet the policy-version
floor. External-effect identifiers are unique.

The live state-changing surfaces `aos_primary`, `fallback_activation`,
`import_apply` and `reconciliation_apply` return exactly
`capability_unavailable_until_mutual_release`. P7-B has an empty supported-AOS
release set, performs no network access, and changes no Workspace or AOS state.
This is not a supported live release-pair claim.

JSON Schema proves the closed request/admission structural surfaces and the
recursive JSON value contract: safe integers, 128-item arrays/objects,
128-byte keys and 4096-byte scalar values. Registered proof keywords
`x-tcrn-wellFormedUnicode`, `x-tcrn-deepWellFormedUnicode`,
`x-tcrn-maxUtf8Bytes`, `x-tcrn-maxDepth` and
`x-tcrn-maxCanonicalBytes` enforce malformed-Unicode, 16-level nesting and the
262144-byte complete request boundary. Runtime mirrors those limits and
additionally proves canonical digests, strict RFC 3339 instants, reference
identity, policy and state-machine semantics. All malformed untrusted values
remain contained behind stable `COMPATIBILITY_*` reason codes.
