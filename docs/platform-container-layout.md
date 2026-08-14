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

- The platform container is the user's code root and is not itself inside any
  Git repository.
- The container may hold any number of governed repositories and unrelated
  projects. A repository's sibling position is not evidence of its platform
  partition.
- The governed chain stays in `.tcrn-workspace`; this filesystem layout task
  does not copy, rewrite, or relocate chain bytes.
- The `.tcrn-artifacts` directory is the platform archive area. Its contents
  are inventory and recovery material, not a second chain authority.
- The platform-to-project mapping is recorded in the platform `AGENTS.md`, not
  inferred from a classification folder or from directory casing.
- A change of chain host or binding is a separate governed operation. It is
  never achieved by a file copy or by editing the control tree.

## Platform `AGENTS.md` contract

The platform-level `AGENTS.md` is the local, path-bearing instance of this
document. It must contain:

- the platform identity and a pointer to this public source of truth;
- a section headed exactly `## 三、分区拓扑`;
- one row for each platform partition and for the release-trust root, naming
  the project location in container-relative terms and a runnable recheck
  command for that row;
- the cross-repository convention pointers and the short stop/publish/privacy
  discipline summary.

The topology rows are closed and case-sensitive:

| Entry | Meaning | Required mapping detail |
| --- | --- | --- |
| `cross-project` | Cross-project workflow chain | Project location and a status/validate recheck command |
| `TCRN-AOS` | AOS project partition | Project location and a status/validate recheck command |
| `TCRN-Design-System` | Design-system project partition | Project location and a status/validate recheck command |
| `TCRN-TMS` | TMS project partition | Project location and a status/validate recheck command |
| `Joi-Button` | Joi Button project partition | The directory spelling is exactly `joi-button` |
| `release-trust` | Shared trust root, not a project partition | Trust-root recheck command; never count it as a project |

The local instance may include exact paths and command output. Those details
must stay in the local instance and must not be copied into this public
document.

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
container outside Git ancestry, and the `CLAUDE.md` bridge. Its test suite uses
synthetic temporary fixtures so CI never depends on a developer's machine.
