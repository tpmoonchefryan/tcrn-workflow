# Security Policy

## Supported versions

Security fixes target the current default branch and the latest tagged release
(`0.5.0`). In the `0.x` range there is no back-port lane: upgrade to the latest
minor to receive fixes. Earlier minor releases and any pre-release candidate are
not separately maintained. A release is supported only once its bundle is
verified against an external trust root and separately accepted.

## Reporting a vulnerability

Use the repository's private security-advisory form. Do not include secrets,
personal data, or exploit details in a public issue. Maintainers will
acknowledge a complete report as capacity permits; this policy is not a service
level agreement.

## Supply-chain boundary

Dependency lifecycle scripts are disabled. CI actions are pinned to immutable
commit identifiers. Release verification rejects trust policy stored inside the
candidate checkout.
