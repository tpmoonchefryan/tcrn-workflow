# Release Trust V1 Normative Contract

The words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, and
MAY are interpreted as described by RFC 2119.

1. A release verifier MUST receive the trust-root path explicitly.
2. The resolved trust-root path MUST be outside the candidate framework root.
3. Trust roots and manifests MUST be canonical UTF-8 JSON with one terminal LF,
   conform to the committed V1 schemas, and reject unknown fields.
4. The manifest signature MUST be Ed25519 over canonical JSON UTF-8 bytes.
5. Repository, workflow, and subject MUST match caller expectations.
6. Every instant MUST be strict RFC 3339 without parser normalization. Trust-root
   and manifest validity windows MUST contain the supplied verification time.
7. Revoked or invalid keys, unknown keys, sequence rollback, path escape,
   symlinks, any multi-link security input, path replacement, invalid canonical
   base64, non-64-byte signatures, invalid signatures, and artifact mismatches
   MUST fail.
8. Failure MUST return a stable reason code and MUST NOT admit release mode.
9. The verifier MUST NOT search the checkout, environment, or network for
   replacement trust material.
10. Trust root, manifest, signature, and artifact bytes MUST be read from the
    same no-follow descriptor whose identity and link count were validated.
11. Root-version rollback across invocations is external in V1 because the
    verifier accepts no prior-root or root-version-floor input. A caller MUST
    enforce that policy before relying on `rootVersion` continuity.

The executable reference is `scripts/verify-release-trust.mjs`.
