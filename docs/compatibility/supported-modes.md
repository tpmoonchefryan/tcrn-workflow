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
