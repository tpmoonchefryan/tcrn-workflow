# ADR 0001: Clean-history offline bootstrap

- Status: Accepted for P1
- Date: 2026-07-11

## Decision

Start the framework from one independent Git root with Apache-2.0 licensing,
offline project-command defaults, disabled dependency lifecycle scripts, exact
tool versions, and no copied implementation or control-plane state.

Release mode is fail-closed and uses an explicitly supplied trust root outside
the checkout. The candidate may contain the verifier and public contract, but
never the authority that decides whether that candidate is trusted.

## Consequences

The bootstrap is intentionally small. Protocol semantics, integrations, and
publication are separate milestones. Initial verification can be reproduced
without another repository or runtime. Network access is limited to explicit
dependency acquisition and remote CI infrastructure setup.
