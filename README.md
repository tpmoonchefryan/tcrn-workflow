# TCRN Workflow

TCRN Workflow is an offline-first framework for deterministic work, context,
evidence, and release verification. This repository currently contains the P1
framework bootstrap. Protocol semantics and integrations are intentionally not
part of this milestone.

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
```

The repository does not collect telemetry. Static checks, a process executable
allowlist, and a Node network guard prove that P1 project code has no implicit
network path. CI action startup and frozen dependency acquisition opt into
network access explicitly. The offline vulnerability command verifies a dated
local denylist only; a fresh external advisory scan remains a release boundary.

The P1 workspace is dependency-free. Its `typecheck` and `build` commands use
the pinned Node type-transform engine plus P1 public-contract checks; runtime
tests execute every emitted module. Introducing a general-purpose compiler is a
dependency-policy change and requires a reviewed exact pin.

See `docs/architecture/root-model.md` and
`docs/release-trust/external-release-trust-root-v1.md` for the bootstrap trust
boundary.

`pnpm verify:isolated` copies the exact current Git basis into a disposable
checkout, retains the canonical origin without contacting it, runs the complete
P1 proof, validates declared evidence, and deletes the checkout.

## Status

The public API is pre-release. Supported release mode is unavailable unless the
external trust verifier succeeds. No compatibility with an external runtime is
claimed by P1.
