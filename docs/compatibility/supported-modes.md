# Supported Modes

## Development

Development mode is supported on Node 24.16.0 and pnpm 11.3.0 with the committed
lockfile. Project commands are offline and telemetry-free. Dependency
acquisition is a separate, explicit operation with lifecycle scripts disabled.

Development mode does not imply release provenance, external-runtime
compatibility, or production support.

## Release

Release mode is admitted only when `scripts/verify-release-trust.mjs` validates
an immutable bundle against a Release Trust Root V1 document outside the
candidate checkout. Missing, candidate-controlled, expired, revoked, rolled
back, or claim-mismatched trust input is rejected.

P1 defines and tests this admission boundary. It does not publish a release.

## P8 Release

`0.5.0` is an accepted release. Its compatibility manifest declares
`supportedAosReleases: []`; it is not a supported AOS release pair. P8 produces
deterministic source and release artifacts; publication is the Owner-signed
annotated tag and the GitHub Release that carries them.

The `0.5.0` release records `supportedAosReleases: []`; it does not
enable a live compatibility pair, connected mode, or AOS mutation.

## Protocol V1

P2 freezes Protocol V1 and provides offline conformance fixtures. This is not a
supported live external-runtime pair. P3 local-work-graph capability remains
unavailable until the canonical acceptance marker is created by a later accepted
route.

## Invocation surfaces

The compatibility verbs split into two invocation surfaces. The distinction is a
fail-closed security boundary, not a packaging accident.

- `compatibility-validate` and `compatibility-unavailable` are binary-invocable:
  the shipped binary `tcrn-workflow` can run them directly. They read no host
  authority and change no state.
- `compatibility-plan` and `compatibility-dry-run` are programmatic-only. They
  require a host-supplied Compatibility Admission Authority delivered through the
  typed programmatic `CliIo` channel. The shipped binary constructs that channel
  with an output writer only, so both verbs MUST fail closed with reason code
  `COMPATIBILITY_AUTHORITY_REQUIRED` and a non-zero exit from the binary.

Authority identity material is never accepted on the argv command line: an
`--authority` token is rejected as an unknown argument before the authority gate
is reached. Passing an admission path or digest as plaintext arguments is a
rejected design — it would place authority-binding identity on the process
command line, where it can leak into shells, logs, and process tables. A host
that must plan or dry-run compatibility embeds the CLI and injects the authority
programmatically, never through the published binary.

The command catalog (`commands` verb) records this boundary: `compatibility-plan`
and `compatibility-dry-run` carry availability `programmatic-only`; every other
verb carries `cli`.
