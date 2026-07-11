# Release Trust V1 Normative Contract

The words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, and
MAY are interpreted as described by RFC 2119.

1. A release verifier MUST receive the trust-root path explicitly.
2. The resolved trust-root path MUST be outside the candidate framework root.
3. Trust roots and manifests MUST conform to the committed V1 schemas and MUST
   reject unknown fields.
4. The manifest signature MUST be Ed25519 over canonical JSON UTF-8 bytes.
5. Repository, workflow, and subject MUST match caller expectations.
6. Trust-root and manifest validity windows MUST contain the supplied
   verification time.
7. Revoked keys, unknown keys, sequence rollback, path escape, symlinks,
   hard-linked artifacts, invalid signatures, and artifact mismatches MUST fail.
8. Failure MUST return a stable reason code and MUST NOT admit release mode.
9. The verifier MUST NOT search the checkout, environment, or network for
   replacement trust material.

The executable reference is `scripts/verify-release-trust.mjs`.
