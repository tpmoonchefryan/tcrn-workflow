# Platform container layout

This document is the public source of truth for the platform container. It
describes the shape and the invariants without naming a machine, a user, or a
host-specific filesystem path. A local platform instance records its concrete
paths in the platform-level `AGENTS.md`.

## Three layers

The layout has three deliberately separate layers:

1. **Machine layer** — the workflow engine, its release-trust root, installed
   skills, and generated portal launchers.
2. **Platform-container layer** — the `.tcrn-workspace` chain container, the
   `.tcrn-artifacts` platform archive, the platform `AGENTS.md`, and the
   `CLAUDE.md` bridge that points to it.
3. **Repository layer** — each repository's own `AGENTS.md`, source tree, and
   session-start wiring such as `.claude/`, `.mcp.json`, or `.codex/`.

A classification folder may organize repositories at the repository layer. It
   is transparent to the platform-container layer and carries no governance
   meaning of its own.

## Container invariants

- The platform container is the user's code root. It may carry a minimal
  whitelist Git repository for container identity and wiring, but that
  repository is not a code repository and must not track governed repositories,
  the chain, or the archive area.
- The container may hold any number of governed repositories and unrelated
  projects. A repository's sibling position is not evidence of its platform
  partition.
- The governed chain stays in `.tcrn-workspace`; this filesystem layout task
  does not copy, rewrite, or relocate chain bytes.
- The `.tcrn-artifacts` directory is owned by the platform container and governed
  with the cross-project partition. Its contents are inventory and recovery
  material, not a second chain authority.
- The platform-to-project mapping is recorded in the platform `AGENTS.md`, not
  inferred from a classification folder or from directory casing.
- A change of chain host or binding is a separate governed operation. It is
  never achieved by a file copy or by editing the control tree.

## Platform `AGENTS.md` contract

The platform-level `AGENTS.md` is the local, path-bearing instance of this
document. It must contain:

- the platform identity and a pointer to this public source of truth;
- a section headed exactly `## 三、分区拓扑`;
- the platform-to-project mapping and any local recheck details supplied by the
  platform-level instance, without requiring this public document to enumerate
  every partition or trust root;
- the cross-repository convention pointers and the short stop/publish/privacy
  discipline summary.

The topology table below is illustrative and non-exhaustive:

| Illustrative entry | Meaning | Local-instance detail |
| --- | --- | --- |
| `partition-id` | One platform partition | The local instance may supply its location and a runnable recheck command |
| `release-trust-root` | A shared trust root, not a project partition | The local instance keeps its trust-root check distinct from project checks |

The local instance may include exact paths and command output. Those details
must stay in the local instance and must not be copied into this public
document.

## Rule residence and on-demand loading

The platform-level `AGENTS.md` is a resident, path-bearing index. It keeps the
identity, security, permissions, true-address table, and the entry points that
every repository needs. Detailed topology history, archive inventory, and
Owner-facing presentation rules may live in path-free companion documents and
are loaded only when their audience or task requires them.

The audience boundary is part of the contract: an Owner-facing response may
load its presentation rules, while an internal subagent loads only its bound
brief, role/Pack contract, applicable safety rules, and relevant source
pointers. A subagent must not receive Owner presentation prose or unrelated
archive history by default. A missing or broken entry is a discovery failure,
not permission to infer a replacement.

The migration proof for a local instance must retain a reachable mapping from
each resident rule to either its retained root text or its named companion
document. It must include a true negative for an omitted or broken entry and a
fixed semantic comparison covering identity, permissions, security, true
addresses, engine-only control-tree writes, actor/CAS attestation, workflow
governance, and audience boundaries. Byte counts are documentation metrics;
they do not prove that historical context was cleared or that a session cost
less. A same-input new-session comparison that was not directly measured is
`unknown`/`not-verifiable`.

## Evidence residence

Public evidence is a redacted, reviewable summary and starts with an explicit
redaction declaration. Byte-exact originals, host logs, and raw command output
live in the platform archive outside public repositories. A public evidence
record may point to a batch-relative archive anchor, but it must not embed a
machine path, username, hostname, credential, or secret. A block is labeled
verbatim only when its command output remains reproducible byte-for-byte;
redacted summaries are not labeled verbatim.

## Session bridge

The platform-container `CLAUDE.md` is a bridge, not a second policy document.
It points to `AGENTS.md` so a session started below any repository can discover
the platform rules through ancestor lookup. Repository-local `CLAUDE.md` files
remain repository-specific and do not replace the platform bridge.

## Doctor gate

The repository ships `scripts/platform-doctor.mjs`. It accepts the platform
root through the required `--platform-root` argument and checks the local
instance for the four invariants: a non-empty platform `AGENTS.md` with the
topology marker, a chain container with at least one partition workspace, a
minimal whitelist Git container boundary that does not claim governed
repositories, and the `CLAUDE.md` bridge. Its test suite uses synthetic
temporary fixtures so CI never depends on a developer's machine.
