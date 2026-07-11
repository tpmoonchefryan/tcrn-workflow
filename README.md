# TCRN Workflow

TCRN Workflow is an offline-first framework for deterministic work, context,
evidence, and release verification. This repository contains the accepted P1
framework bootstrap and the P2 V1 protocol/conformance basis. P3 capability,
live integrations, and release support remain intentionally unavailable.

## Modes

- `development` is the default. Project commands use offline defaults, a Node
  process network guard, and no telemetry client; this is not an OS network
  sandbox and does not assert release support.
- `release` is fail-closed. It requires an explicit trust root located outside
  the candidate checkout and a verified signed release bundle.

## Deterministic local workflow

Use Node 24.16.0 and pnpm 11.3.0. Dependency lifecycle scripts are disabled.
After an explicit dependency acquisition step, all project verification runs
offline:

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm verify:p1
pnpm verify:p2
pnpm verify:rc1
```

The repository does not collect telemetry. Static checks, a process executable
allowlist, and a Node network guard prove that P1 project code has no implicit
network path. CI action startup and frozen dependency acquisition opt into
network access explicitly. The offline vulnerability command verifies a dated
local denylist only; a fresh external advisory scan remains a release boundary.

The workspace has one exact-pinned development dependency, `ajv@8.17.1`, used
only for offline Draft 2020-12 protocol-schema proof. It was acquired through
an explicit registry boundary with lifecycle scripts disabled; the frozen
lockfile and dependency policy bind its integrity. `typecheck` and `build` use
the pinned Node type-transform engine plus public-contract checks; runtime tests
execute every emitted module. Any dependency change requires another explicit,
reviewed acquisition and policy update.

The deterministic vulnerability command derives the complete direct and
transitive graph from the frozen lockfile, requires exact identity/integrity
closure against dependency policy, and checks every graph identity against the
dated local denylist. It still does not claim a fresh advisory-service scan.

`pnpm verify:p2` checks the frozen Work, Knowledge, Event Integrity, Context,
Exchange, Compatibility, Profile Trust, Receipt, extension-registration, and P3
marker contracts; deterministic vectors and negative/property tests; the public
AOS requirements ledger; exact-pinned meta-schema/local-reference evaluation;
and the unaccepted RC1 candidate manifest. A green
`pnpm verify:rc1` means only `RC1_CANDIDATE_READY`: all four role-verdict slots
remain unresolved, RC1 is not accepted, and P3 remains unavailable.

See `docs/architecture/root-model.md` and
`docs/release-trust/external-release-trust-root-v1.md` for the bootstrap trust
boundary.

`pnpm verify:isolated` copies the exact current Git basis into a disposable
checkout, retains the canonical origin without contacting it, runs the complete
P1 proof, validates declared evidence, and deletes the checkout.

An accepted P1 proof runs from a clean Git checkout and holds an atomic
repository-local output lock for the whole command. All reset and write helpers
require that same session. This cross-platform lock prevents overlapping
framework commands and the path checks reject pre-existing symlink, hardlink,
and output redirection states. P1 intentionally assumes no concurrent hostile
mutation of the exclusive checkout: Node does not expose a portable
descriptor-relative `openat2`/rename boundary, so replacement of output parent
components by an external attacker during the command is outside this
milestone's threat model. A stale lock fails closed and must be removed only
after confirming that no framework command is running.

P1 retains four explicit external boundaries: cross-invocation `rootVersion`
continuity requires an external prior-root or floor; there is no operating-system
network sandbox; no fresh advisory or Codex Security scan is performed; and the
privacy regex set is a focused policy control, not a general DLP system.

## Status

The public API is pre-release. Supported release mode is unavailable unless the
external trust verifier succeeds. P2 claims specification and fixture maturity
only; it claims no live external-runtime compatibility or supported release pair.
