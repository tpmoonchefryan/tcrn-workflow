# Security Policy

## Supported versions

Only the current default branch is eligible for security fixes during the
pre-release bootstrap. `0.1.0-rc.1` is an immutable unpublished candidate, not
a supported release. There is no supported release until a release bundle is
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
