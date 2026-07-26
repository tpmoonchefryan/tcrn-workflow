# CLAUDE.md — TCRN Workflow agent entry

This repository is the governance engine. `CONTRIBUTING.md` is the manual; this file is
the signpost for agents, and it covers one thing the manual does not: which instrument
answers which question here, and how each of them lies when it is stale.

## Instrument discipline

### 1. Enumerate capability from the command catalog, never from prose

`commands` emits the schema-valid, byte-stable catalog: every verb, its flags, each
flag's `valueKind`, whether the verb mutates, and its availability. **That output is the
only authority on what exists.** Documentation — this file included — can be behind the
code; the catalog is what the engine enforces. Reading a verb's name in a document and
assuming its flags is how an agent writes a command that has never been valid.

The catalog does not carry the *legal values* a flag accepts. Those come from the source.
Work-status transitions, for one, are `planned → ready → active → done`; a `planned` item
cannot go straight to `active`, and the engine refuses with `INVALID_TRANSITION` rather
than guessing what you meant.

### 2. Probe with reads, never with writes

The catalog marks every verb `mutates` or not. Firing a mutating verb "to see what it
does" is not discovery: aimed at a live chain it performs its mutation, and terminal
transitions do not come back. When a mutating verb genuinely has to be exercised to be
understood, exercise it in a scratch workspace created for that purpose and discarded
after.

### 3. There is no code graph here — and know which copy you are driving

This repository is not indexed by codegraph (the product repositories on this platform
are). Its instruments are the command catalog, the test suite, and — from `v0.6.0` — the
MCP facade (`scripts/tcrn-workflow-mcp.mjs`), which derives its tool schemas from the same
catalog and performs no shell construction.

The freshness trap that a stale index is elsewhere, a stale *copy* is here: the working
tree in this repository and the installed copy a governed session actually drives are two
different things and routinely sit at different versions. Before concluding that a verb
does or does not exist, check which one you just ran.

### 4. Verify "did it reach elsewhere" against the authority, and compare full values

- Whether a branch or tag reached the remote: ask the server (`git ls-remote`). Do **not**
  use `git log --not --remotes` — under a narrow fetch refspec it can never see a newly
  pushed branch.
- Comparing commits: compare **full** SHAs. An 8-character local id against a
  7-character server-truncated one reports a difference that does not exist.
- Dating something: measure against a reference that does not move (a file's own write
  time, an upstream timestamp), never against the wall clock as it is right now. A
  measurement anchored to "now" invalidates itself a few hours later.

### 5. Background loads: write the reclaim in the same breath as the spawn

Never start a long-running detached task without its teardown in the same command or flow
(`trap 'kill 0' EXIT`, or capture the process **group** and kill it). Verify the group is
empty at teardown. Killing the direct child is not enough — a package-manager shim chain
lets the real binary reparent to init and survive. A daemon a tool registers itself is not
a leak; the test is whether anything owns the record of it.

## Two boundaries that are easy to cross by accident

- **Only the engine may write inside a control tree.** Everything under `.tcrn-workflow/`
  is written in the engine's canonical byte form. An editor that reformats on save, a
  linter, a prettifier, or an agent reaching for a file-write tool breaks the chain, and
  then *reading* it stops working too. Inspecting those files is fine; saving them never
  is.
- **Root files are allowlisted in both directions.** `scripts/policy/source-allowlist.json`
  fails closed on a tracked file that is not listed *and* on a listed file that does not
  exist. Adding a root document means adding its entry in the same change.

## Platform conventions

This repository sits inside the TCRN Platform working tree. Cross-repo conventions —
constraint classification and evolution, direction and track choices, sourcing and vetting
of outside code, delivery cadence — live in the platform root's `CLAUDE.md` and `docs/`.
The one that governs changes to this repository most directly: **replacing old behaviour
requires a residual-applicability analysis first** — does the old path still hold for some
supported user, host, or model? If it does, the change is conditional (a version-gated
operation, an enable event) rather than a deletion. This engine already works that way;
the convention names the practice so it survives outside the engine too.
