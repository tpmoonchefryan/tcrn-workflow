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

`0.11.9` is the current accepted release candidate. Its compatibility manifest declares
`supportedAosReleases: []`; it is not a supported AOS release pair. P8 produces
deterministic source and release artifacts; publication is the Owner-signed
annotated tag and the GitHub Release that carries them.

The `0.11.9` release candidate records `supportedAosReleases: []`; it does not
enable a live compatibility pair, connected mode, or AOS mutation.

## Protocol V1

P2 freezes Protocol V1 and provides offline conformance fixtures. This is not a
supported live external-runtime pair. P3 local-work-graph capability remains
unavailable until the canonical acceptance marker is created by a later accepted
route.

## Invocation surfaces

All compatibility verbs are binary-invocable. Their authority requirements still
form a fail-closed security boundary.

- `compatibility-validate` and `compatibility-unavailable` are binary-invocable:
  the shipped binary `tcrn-workflow` can run them directly. They read no host
  authority and change no state.
- `compatibility-plan` and `compatibility-dry-run` require a Compatibility
  Admission Authority. A programmatic embedder may still deliver it through typed
  `CliIo`. The shipped binary delivers it through the host-neutral operator-pins
  bundle, supplied before the command as `--authority-pins <absolute-path>` and
  `--authority-pins-digest <sha256>`. Without a valid pair both verbs fail closed.

The two global values are public trust pins, not credentials. They bind a
canonical pins document whose digest, generation floor and revocation set bind a
separate authority bundle. A command-local `--authority` token remains unknown.
No receipt body, secret or ambient authority is accepted from argv, prompt text
or environment variables. Operators that do not want paths and public digests in
shell history use the structured `tcrn-workflow-mcp` stdio surface.

The command catalog (`commands` verb) records both planning verbs as `cli`.
Fixture-only artifact maintenance remains the only non-CLI surface.
