<div align="center">

# TCRN Workflow

### Your Agent says "done." This framework makes it hand you evidence you can check yourself

**A governance framework for AI Agent delivery. Every capability it claims is bound to a machine-falsifiable criterion — if the criterion stops holding, the build goes red.**

[简体中文](./README.md) · English · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Français](./README.fr.md)

![status](https://img.shields.io/badge/status-1.0.1-blue?style=flat-square) ![gates](https://img.shields.io/badge/verify%3Ap1-24%20gates-brightgreen?style=flat-square) ![claims](https://img.shields.io/badge/proven%20claims-124-brightgreen?style=flat-square) ![deps](https://img.shields.io/badge/runtime%20deps-0-success?style=flat-square)

![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![node](https://img.shields.io/badge/node-24.16.0-informational?style=flat-square) ![pnpm](https://img.shields.io/badge/pnpm-11.3.0-informational?style=flat-square) ![network](https://img.shields.io/badge/network-none-important?style=flat-square) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex-blueviolet?style=flat-square)

[Where you are now](#where-you-are-now) · [Why trust it](#why-trust-it) · [Who it is for](#who-it-is-for) · [What you get](#what-you-get) · [Three-minute start](#three-minute-start) · [Current status](#current-status) · [Full documentation](#full-documentation)

`Verified claims: 124 (hygiene 20 · inertness 13 · runtime 91)`

</div>

<table>
<tr>
<td align="center" width="25%">

### 24
P1 gates<br><sub>One command. Anything unexpected stops it</sub>

</td>
<td align="center" width="25%">

### 122
criteria<br><sub>Every one has a red leg, every leg measured</sub>

</td>
<td align="center" width="25%">

### 61
guards<br><sub>Each one broken on purpose, its test must go red</sub>

</td>
<td align="center" width="25%">

### 0
runtime deps<br><sub>No network, no database</sub>

</td>
</tr>
</table>

> [!TIP]
> **You do not have to trust this README**. Install it and run one command: it proves all 122 of its own claims to you, fully offline.

---

## Where you are now

Your Agent changed thirty files and told you the tests are green.

You have two options: review every one of them, which defeats the point of using an Agent, or believe it, which is a bet. When somebody asks "can this ship?", what you can produce on the spot decides whether that is a ten-minute conversation or a whole day.

TCRN Workflow gives you a third option.

| What you want to confirm | ✗ What you have now | ✓ What you have after |
| :--- | :--- | :--- |
| **Did the tests actually run** | One line in a chat window | `pnpm verify:p1` — 24 gates in sequence, anything unexpected stops it |
| **Who changed what, and when** | Scroll back through the chat | A hash-linked event chain, append-only. Alter any entry in history and every hash after it stops matching |
| **Are the protections still working** | The assumption that they are | `pnpm guard-check` — 61 guards broken one at a time in the source, each one's test required to go red |
| **Are these the released bytes** | Read the tag | Artifacts rebuilt byte for byte and compared against published digests |

---

## Why trust it

The framework applies the same standard to itself first.

`pnpm guard-check` **removes or breaks each of the 61 registered guards in the source**, one at a time, and requires the test that covers that guard to go red. All 61 have to go red for the run to pass.

What that proves is not "we wrote these checks" but "these checks are still stopping people right now." A check that broke and nobody noticed is the same thing as no check at all.

That standard covers all **122 claims**. Each one is bound in `verification-map.yaml` to a stable reason code, to a proof that runs offline, and to a red leg — a statement of what change makes it go red, with that failure actually observed. All 122, with no exceptions.

<details>
<summary><b>How the 122 criteria break down</b></summary>

<br>

| Category | Count | What it covers |
| :--- | ---: | :--- |
| `framework-hygiene` | 20 | The framework's own hygiene: clean history, source allowlist, licence and vulnerability policy, offline boundary |
| `inertness-proof` | 13 | Inertness: a host adapter does nothing at all after install until someone explicitly approves activation |
| `runtime-capability` | 89 | Runtime capability: event chain, lease, views, knowledge core, context router, release set |

The full list is in `verification-map.yaml`, each entry carrying `id`, `command`, `fixturePaths` and its red leg.

</details>

> [!IMPORTANT]
> Change what a criterion covers without re-proving it and the build fails. This is not a style preference. It is enforced.

---

## Who it is for

| ✓ A fit if | ✗ Not a fit if |
| :--- | :--- |
| You have Agents doing consequential work: production code, delivery that has to leave a record, several Agents in sequence with nobody remembering who decided what. | You want a zero-configuration chat assistant that works the moment it is installed. |
| What you hand a reviewer has to be an artifact they can re-run, not a conversation they have to believe. | You need cloud sync, a hosted dashboard, or team collaboration views. |
| You require everything to stay on your machine: no database, no daemon, no network, no telemetry. | Your work is still exploratory and an append-only audit trail is a cost rather than a benefit right now. |

---

## What you get

| You get | What it actually is |
| :--- | :--- |
| **A workspace made only of files** | The whole Initiative → Epic → Story → Subtask graph as canonical JSON plus a hash chain. Auditable with `cat` and `sha256sum`, exportable byte-for-byte reproducibly. |
| **24 gates in one command** | `pnpm verify:p1` runs format, lint, types, build, 133 test files, the trust matrix, archive and SBOM and licence and vulnerability policy, source allowlist, offline boundary, privacy scan, CI hardening, the claim ledger and clean history. |
| **122 machine-readable criteria** | 20 framework-hygiene, 13 inertness-proof, 89 runtime-capability. All carry red legs, all bound to observable reason codes. |
| **Guards that prove themselves** | 61 guards, each broken by `pnpm guard-check` with its test required to go red. |
| **137 governed CLI verbs** | All local. Every write declares the version it is based on and is refused if someone wrote first — never a silent overwrite. |
| **Zero runtime dependencies** | Both `dependencies` and `optionalDependencies` in `package.json` are empty. Development mode adds a process-level network guard. Telemetry is zero. |

---

## Three-minute start

You need the pinned toolchain: **Node 24.16.0** and **pnpm 11.3.0**. Dependency lifecycle scripts stay off throughout, so installation executes no third-party code.

```sh
# 1. Install the pinned dev dependencies: explicit, frozen, script-free
pnpm install --offline --frozen-lockfile --ignore-scripts

# 2. Watch the framework prove itself: 24 gates, fully offline
pnpm verify:p1

# 3. Build, then drive the governed CLI
pnpm build
node scripts/tcrn-workflow.mjs commands
```

<details>
<summary><b>The governed commands you will use most</b></summary>

<br>

All local, no network, no database.

```sh
# validate a workspace and materialize its deterministic views
node scripts/tcrn-workflow.mjs validate --workspace <path>

# create a work record with a version-checked write
node scripts/tcrn-workflow.mjs work-create --workspace <path> --expected-version <version> ...

# search work records by subject
node scripts/tcrn-workflow.mjs work-list --workspace <path> --search "<term>"
```

</details>

> [!NOTE]
> The capability list is whatever `commands` outputs, never what a document says. Documentation can fall behind the code. The command catalog cannot.

---

## Current status

The accepted version is **1.0.1**. Every accepted version is an immutable tag plus a reproducible artifact set, and `CHANGELOG.md` is the full ledger.

Publication, push and tagging are separate stops and are never inferred from local tests. Outside users verify the release bytes through the companion `tcrn-workflow-helper`, whose own bootstrap digest is published separately and can be checked independently.

The known boundaries are on the Wiki's "Known limits" page: one writer per workspace, an event-scale ceiling, and recovery only to the original path. These are design decisions, not a backlog.

## Full documentation

Architecture, command reference, criteria and gates, repository layout, known limits and FAQ all live in this repository's GitHub Wiki, reachable from the **Wiki** tab at the top of the repository page.

[Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md) · [Privacy](./PRIVACY.md) · [Code of conduct](./CODE_OF_CONDUCT.md) · [Support](./SUPPORT.md)

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
