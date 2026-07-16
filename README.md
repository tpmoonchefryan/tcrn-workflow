# TCRN Workflow

TCRN Workflow is an offline-first framework for deterministic work, context,
evidence, and release verification. This repository contains the accepted P1
framework bootstrap, the P2 V1 protocol/conformance basis, the accepted P3
file-native engine, bounded P4 artifact-lifecycle and Knowledge Core candidates,
bounded generic P5 profile-policy and Core Reference persona candidates, and a
bounded P6 Context Router and inert Codex Adapter and inert Claude Code Adapter
candidates. The two Agent App adapters (Codex and Claude Code) are the V1
officially supported hosts; both remain inert dry-run candidates that generate
uninstalled template data only. The canonical P3 capability marker and local
graph are governed outside this product checkout; live integrations and release
support remain intentionally unavailable, and no live Claude Code or Codex host
support is asserted before its governed release route accepts.

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
pnpm verify:p3
pnpm verify:p4
pnpm verify:p4:knowledge
pnpm verify:p5
pnpm verify:p6
pnpm verify:p6:adapter
pnpm verify:p6b
pnpm verify:p7
pnpm verify:p7:compatibility
pnpm verify:p8
pnpm verify:p8
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
remain unresolved in the regenerated candidate proof. The accepted RC1 parent
is recorded externally. `pnpm verify:p3` exercises the standalone file-native
Workspace, leases/CAS, event recovery, migrations, deterministic views, and
filesystem attack matrix, including identity-bound quarantine of ownerless
stale lease generations. P3 acceptance and capability activation remain
external control-plane facts. `pnpm verify:p4` checks artifact classification,
doctor/size budgets, deterministic compact/archive projections, redaction,
disposable-only archive apply/restore, and filesystem attack/fault vectors. It
also runs the file-native Knowledge Core proof for closed metadata, separate
explicit body reads, metadata-only surfaces that never open body files,
accountable source/evidence provenance, strict UTF-8 byte budgets, freshness,
promotion CAS, and 64 real-store insertion permutations with exact index/list/
checkpoint parity, plus disposable-only initialization and filesystem/privacy
faults. Promotion enum admission occurs before claim creation, and artifact
transient/archive generation counts and cumulative storage are bounded before
unbounded reads or writes.
`pnpm verify:p7:compatibility` checks the offline-only compatibility manifest,
authenticated pair-reference admission, anti-rollback policy floor, Workspace
lock binding, descriptor-bound host-only authority receipts, recursive schema
parity, canonical semantic sets, deterministic import/checkpoint/fallback/
conflict/reconciliation plans, and exact field ownership. All live AOS/apply surfaces remain unavailable
with zero network and zero mutation until a mutually supported release exists.
`pnpm verify:p4:knowledge` exposes the narrower
`P4_KNOWLEDGE_CORE_VERIFIED` reason code. Neither command mutates the live graph
or starts P6.

`pnpm verify:p8` requires a clean candidate basis, runs the bounded release
candidate and external-trust proof, independently rebuilds the canonical source
archive, and writes a closed six-file unpublished candidate bundle through the
governed output session. It does not publish, access AOS, or claim a supported
release pair.

`pnpm verify:p5` proves the closed generic profile trust/binding model, a frozen
framework-base digest, descriptor-bound independent admission receipts,
an out-of-band governed path/file-digest authority anchor, complete request and
effective-profile binding, authorization-time request re-resolution, fixed configuration precedence,
exact field merge matrix, owner-rebind boundary, canonical profile/effective-
policy digests, read-only CLI generation and validation, 64 actual layer-order
permutations, and a disposable empty
Workspace cold-start through Initiative → Epic → Story → Subtask. Generated
material is inert data and carries no external project/persona, model, hook,
thread, network, database, AOS, or absolute-path authority. The live Workspace
has no profile store; persona admission remains separate from technical profile authority.
The bounded Core Reference persona set generates exactly eight inert,
source-manifest-bound public records and display-only release layers; it creates
no live store, agent, hook, Skill, or authorization capability.

`pnpm verify:p6` proves the closed deterministic Context Router request,
descriptor-bound out-of-band authority, admitted generic-profile re-resolution,
exact scope/risk/budget controls, metadata-first selection, explicit
body/procedure reads, privacy-minimal receipts, hostile prompt corpus, 64 actual
candidate-order permutations, and bounded pinned-runtime latency observations.
Those observations are local process measurements, not real-time guarantees.
`pnpm verify:p6:adapter` separately proves the closed Context-result bridge,
independently injected host binding, authority-empty raw-session fallback,
deterministic four-file inert template bundle, identity/digest-bound rollback
plan admitted from a pinned descriptor-verified installation-generation receipt,
exact canonical template bytes, complete ordered bundle/schema parity,
final-hop visibility, hostile corpus, and 64 real input/template orders. The
templates are not installed or activated; OG-04 and RC3 remain
unsatisfied, and no live context/profile/Knowledge/artifact store, hook, Skill,
configuration, or owner-visible activation is created.

`pnpm verify:p6b` proves the host-specific Claude Code Adapter over the same
inert dry-run surface: a four-file `.claude/tcrn-workflow/` template bundle bound
to a `claude-code` host identity and data-only version readback, a byte-reversible
settings hook fragment that never clobbers user-owned `.claude/settings.json`,
forbidden-path rejection of any user-level `.claude` location, a CLAUDE.md-only
fallback mode, and a cross-host parity check proving the Codex and Claude adapters
share host-neutral machinery byte-for-byte and diverge only at the enumerated host
surface. It installs and activates nothing; no live Claude Code support is claimed.

`pnpm verify:p8` is the release-candidate proof. It verifies one disposable
dogfood fixture, the eight-record sanitized Core Reference projection, the
external-bootstrap release-trust negative matrix, exact `0.1.0-rc.4` package
and framework versions, a reproducible canonical USTAR source archive, and a
closed local release set containing source archive, SBOM, manifest, provenance,
checksums, and release notes. Its candidate has `supportedAosReleases: []`,
does not publish or push, and makes no graph, store, template, AOS, or network
mutation claim.

After `pnpm build`, governed local commands are available through
`node scripts/tcrn-workflow.mjs`. Mutation commands require an explicit
Workspace, strict timestamp, and expected version; they contact neither AOS nor
a database.

See `docs/architecture/root-model.md` and
`docs/release-trust/external-release-trust-root-v1.md` for the bootstrap trust
boundary.

`pnpm verify:isolated` requires `TCRN_DEPENDENCY_MATERIALIZATION_ROOT` to name
an external, lockfile-bound dependency materialization. Build it once with
`node scripts/dependency-materialization.mjs --mode fetch --materialization
<absolute-directory> --allow-network-fetch`; that explicit path is the only
authorized registry-read phase. The isolated proof validates the manifest,
copies its exact store inventory into a newly absent dedicated store, then
installs offline with the frozen lockfile and ignored lifecycle scripts before
running P1. It copies the exact current Git basis into a disposable checkout,
retains the canonical origin without contacting it, validates declared
evidence, and deletes the checkout.

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
only; P3 is an unaccepted local-engine candidate; neither claims live
external-runtime compatibility or a supported release pair. P4 Knowledge Core
P5 generic profiles, and the P6 Context Router remain unaccepted bounded
candidates and make no live knowledge/profile/context store, live-archive,
Codex Adapter, database, AOS, or network claim.
