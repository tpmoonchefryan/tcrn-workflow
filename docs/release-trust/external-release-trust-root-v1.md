# External Release Trust Root V1

## Authority boundary

The trust root is supplied explicitly with `--trust-root` and must resolve
outside the candidate checkout. Trust root, manifest, signature, and artifact
must each be a single-link regular file. The verifier opens them with
`O_NOFOLLOW`, validates descriptor/path identity, reads through that descriptor,
and rejects links or path replacement. No embedded key, repository setting,
manifest field, or environment fallback can replace this external authority.

The trust root binds:

- schema version `tcrn.release-trust-root.v1`;
- monotonically increasing root version;
- validity interval;
- repository and workflow names;
- minimum accepted release sequence;
- Ed25519 public keys and revocation timestamps.

The signed manifest binds:

- schema version `tcrn.release-manifest.v1`;
- subject, repository, and workflow;
- monotonically increasing release sequence;
- issue and expiry timestamps;
- signer key id;
- artifact relative path, byte length, and SHA-256 digest.

Trust-root and manifest files use canonical UTF-8 JSON: recursively sorted object
keys, preserved array order, no insignificant whitespace, and one terminal LF.
JSON signatures cover the canonical bytes without the terminal LF. Instants use
the strict no-leap-second RFC 3339 subset and must name possible dates, times,
and offsets. A seconds value of `60` is rejected rather than normalized.

Signature files contain canonical padded base64 plus one terminal LF. Exact
decode/re-encode equality and a 64-byte Ed25519 signature are required.

## Failure behavior

Verification returns a stable reason code and exits nonzero. It rejects missing
or malformed input, path escape, symlinks, hard-linked artifacts, wrong claims,
invalid time windows, rollback, revoked or unknown keys, invalid signatures,
and artifact size or digest mismatch.

`rootVersion` is recorded but cross-invocation root-version rollback remains an
external release-controller responsibility in V1. The verifier has no accepted
prior-root or root-version-floor input. Manifest sequence rollback is enforced
locally through `minimumSequence`; no stronger root-version claim is made.

## Command

```sh
node scripts/verify-release-trust.mjs \
  --trust-root /external/release-trust-root.json \
  --bundle /external/release-bundle \
  --subject tcrn-workflow-source \
  --repository tcrn-workflow \
  --workflow release \
  --now 2026-07-11T00:00:00.000Z
```

The example paths are illustrative, not defaults. The verifier never searches
for trust material.
