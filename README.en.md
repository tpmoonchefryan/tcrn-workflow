<div align="center">

# TCRN Workflow

### Turn your agent's "it's done" into evidence you can check yourself

**A governance framework for AI-agent delivery. Every capability it claims is a claim a machine can falsify.**

[简体中文](./README.md) · English · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Français](./README.fr.md)

![status](https://img.shields.io/badge/status-1.0.1-blue) ![gates](https://img.shields.io/badge/verify%3Ap1-24%20gates-brightgreen) ![claims](https://img.shields.io/badge/proven%20claims-122-brightgreen) ![deps](https://img.shields.io/badge/runtime%20deps-0-success)

![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![node](https://img.shields.io/badge/node-24.16.0-informational) ![pnpm](https://img.shields.io/badge/pnpm-11.3.0-informational) ![network](https://img.shields.io/badge/network-none-important) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex-blueviolet)

[What it solves](#what-it-solves) · [Who it is for](#who-it-is-for) · [What you get](#what-you-get) · [Three-minute start](#three-minute-start) · [A real example](#a-real-example) · [Current status](#current-status) · [Full documentation](#full-documentation)

`Verified claims: 122 (hygiene 20 · inertness 13 · runtime 89)`

</div>

---

## What it solves

Your agent tells you the tests passed. What you hold is one line of text in a chat window.

TCRN Workflow replaces that line with three things you can check.

- **A ledger of claims.** Every capability the framework asserts has a matching claim in `verification-map.yaml`, bound to a stable reason code and proven by a test that runs offline.
- **A tamper-evident event chain.** Every change to a workspace is a chained record. Entries are hashed to the one before, append-only, and the history cannot be rewritten.
- **A reproducible release.** Every version can be rebuilt byte for byte and compared against published digests.

Change what a claim covers without re-proving it and the build fails. That is enforced, not advisory.

## Who it is for

| | |
| --- | --- |
| **A good fit** | You point agents at work that has consequences: production code, delivery that must leave a record, handoffs between agents where nobody remembers who decided what. You want an artifact a reviewer can check rather than a transcript they must trust. You want everything to stay on your machine: no database, no daemon, no network, no telemetry. |
| **Not a fit** | You want a zero-setup chat assistant, you need cloud sync or a hosted dashboard, or your work is exploratory enough that an append-only audit trail is friction rather than value. |

## What you get

| You get | What that means |
| --- | --- |
| **A workspace that is only files** | The whole work graph — Initiative → Epic → Story → Subtask — is canonically formatted JSON plus a hash chain. Audit it with `cat` and `sha256sum`; exports are byte-reproducible. |
| **One command, 24 gates** | `pnpm verify:p1` runs format, lint, typecheck, build, 134 test files, the trust matrix, archive/SBOM/license/vulnerability policy, the source allowlist, the offline boundary, the privacy scan, CI hardening, the claim ledger, and the clean-history proof. Anything unexpected stops it. |
| **122 machine-readable claims** | `verification-map.yaml` binds 122 claims to observable reason codes: 20 framework-hygiene, 13 inertness-proof, 89 runtime-capability. All 122 carry a red leg — each one states what change would turn it red, and that red was measured. |
| **Guards that prove they still bite** | `pnpm guard-check` breaks each of the 61 registered guards in the source and requires its named test to go red. |
| **137 governed CLI verbs** | All local. Every write declares which version it builds on; if someone wrote first, the write is refused rather than silently overwriting. |
| **Zero runtime dependencies** | Both `dependencies` and `optionalDependencies` in `package.json` are empty. Development mode also installs a process-level network guard, and telemetry is zero. |

## Three-minute start

You need the pinned toolchain: Node 24.16.0 and pnpm 11.3.0. Dependency lifecycle scripts stay off, so installing runs no third-party code.

```sh
# 1. Install the pinned dev dependencies: frozen lockfile, no scripts
pnpm install --offline --frozen-lockfile --ignore-scripts

# 2. Watch the framework prove itself: 24 gates, fully offline
pnpm verify:p1

# 3. Build, then drive the governed CLI
pnpm build
node scripts/tcrn-workflow.mjs commands
```

Typical governed commands — all local, no network, no database:

```sh
# validate a workspace and materialize its deterministic views
node scripts/tcrn-workflow.mjs validate --workspace <path>

# create a work record with a version-checked write
node scripts/tcrn-workflow.mjs work-create --workspace <path> --expected-version <version> ...

# search work records by topic
node scripts/tcrn-workflow.mjs work-list --workspace <path> --search "<keyword>"
```

## A real example

`pnpm guard-check` removes or breaks each of the 61 registered guards in the source, one at a time, and requires that guard's named test to go red. All 61 must go red for the run to pass.

What that proves: those protections still work right now, not that somebody wrote them once. A check that could break without anyone noticing is the same as no check.

## Current status

The current accepted release is 1.0.1. Each accepted version is an immutable tag plus a reproducible artifact set; `CHANGELOG.md` carries the full ledger.

Publication, push, and tagging are separate stops and are never inferred from local tests. External consumers verify the release bytes through the companion `tcrn-workflow-helper`, whose own bootstrap digest is published separately so it can be checked independently.

Known boundaries are on the wiki page "Known limits", including one writer per workspace, the event-count ceiling, and same-path-only restore. Those are design decisions, not a backlog.

## Full documentation

Architecture, command reference, claims and gates, repository layout, known limits, and plain answers are in this repository's GitHub wiki — the Wiki tab at the top of the repository page.

[Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md) · [Privacy](./PRIVACY.md) · [Code of conduct](./CODE_OF_CONDUCT.md) · [Support](./SUPPORT.md)

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
