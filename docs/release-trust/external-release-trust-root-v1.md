# External Release Trust Root V1

## Authority boundary

The trust root is supplied explicitly with `--trust-root` and must resolve
outside the candidate checkout. The verifier rejects symbolic links that land
inside the checkout. No embedded key, repository setting, manifest field, or
environment fallback can replace this external authority.

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

JSON signatures cover UTF-8 bytes produced by recursively sorting object keys,
preserving array order, and serializing with no insignificant whitespace.

## Failure behavior

Verification returns a stable reason code and exits nonzero. It rejects missing
or malformed input, path escape, symlinks, hard-linked artifacts, wrong claims,
invalid time windows, rollback, revoked or unknown keys, invalid signatures,
and artifact size or digest mismatch.

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
