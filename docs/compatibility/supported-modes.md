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

## Unpublished P8 Candidate

`0.1.0-rc.1` is an immutable local candidate only. Its compatibility manifest
declares `supportedAosReleases: []`; it is not a supported AOS release pair and
must not be published, pushed, or treated as a public release. P8 produces
deterministic local source and release artifacts solely for later gate review.

The local `0.1.0-rc.1` candidate records `supportedAosReleases: []`; it does not
enable a live compatibility pair, connected mode, or AOS mutation.

## Protocol V1

P2 freezes Protocol V1 and provides offline conformance fixtures. This is not a
supported live external-runtime pair. P3 local-work-graph capability remains
unavailable until the canonical acceptance marker is created by a later accepted
route.
