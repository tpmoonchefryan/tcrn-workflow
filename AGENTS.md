# AGENTS.md — TCRN Workflow agent entry

This repository is the governance engine. `CONTRIBUTING.md` is the manual; this file is
the canonical agent reference, and it covers one thing the manual does not: which instrument
answers which question here, and how each of them lies when it is stale.

## Four rules you must not miss

The first four numbered sections below are the engine's core operating rules. The fifth
section covers background-resource reclaim and is an additional teardown obligation.

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

Probe evidence must come from the command's structured result, not a shell-shaped shortcut:
use argv execution and parse JSON reason codes. Do not use zsh colon modifiers, `ref:path`
lookups, `|tail`/`|head`, `PIPESTATUS`, or `grep` as a verdict. The public-world replay is
`pnpm preflight`; it supplies the scrubbed environment, isolated checkout, and collect-all
ordering that a local one-liner cannot prove.

### 3. There is no code graph here — and know which copy, *on which host*, you are driving

This repository is not indexed by codegraph (the product repositories on this platform
are). Its instruments are the command catalog, the test suite, and — from `v0.6.0` — the
MCP facade (`scripts/tcrn-workflow-mcp.mjs`), which derives its tool schemas from the same
catalog and performs no shell construction.

The freshness trap that a stale index is elsewhere, a stale *copy* is here: the working
tree in this repository and the installed copy a governed session actually drives are two
different things and routinely sit at different versions. Before concluding that a verb
does or does not exist, check which one you just ran.

**Since 2026-07-29 that question has a second half: which host.** This platform's governed
chains no longer all live on one machine — one partition's truth was relocated to another
host, and there is now an installed engine copy on each. Two copies means two version
numbers and two catalogs, so "does this verb exist" is a question about the copy you are
actually invoking, and `commands` must be asked of *that* one. Which partition is where,
with a runnable recheck command per partition, is stated in the platform root's `AGENTS.md`
section 三 — do not infer it from this repository's working tree.

### 3b. The relocation verb family, and what it cannot do

`v0.9.0` carries five relocation verbs — `relocation-plan` and `relocation-inspect` (read),
`relocation-vacate`, `relocation-adopt` and `relocation-abort` (mutating). They are the
**only** legitimate way a governed workspace changes machines: the engine binds five
absolute roots, so a byte-identical copy at any other path is refused by all three read
verbs, and moving bytes without moving the binding produces an unreadable tree rather than
a second live authority.

**Read `docs/adr/0003-workspace-relocation.md` before reasoning about this family, and read
its "four ceilings" section rather than a summary of it.** The general statement all four
are instances of: *this mechanism cannot prevent a fork, only make one legible.* Three
consequences that repeatedly get overstated in prose and must not be:

- it is **authorization, not authentication** — nothing proves who ran the command;
- the ledger is **deletable**, and no single-sided test can go red on that; detection is
  the *counterparty's* capability, not the engine's;
- `relocation-abort` **after** the destination has adopted is not a rollback — it is a fork,
  produced with legal verbs and no damaged bytes.

Operationally: the ledger has a **16-entry cap, consumed per attempt, with no compaction
verb**, and an adopt entry is written only into the destination copy and never sent back. So
the two sides' ledger lengths are *expected* to differ — **never write a closing predicate
that compares ledger lengths** — and "move it back" costs a fresh hop rather than an undo.
Sequencing for a multi-partition platform is in the same ADR (section OD-D).

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
  is. **A remote tree is not an exception**: `cat >`, `sed -i` or `rsync` over SSH is the
  same act with the same outcome, and a write to a chain that lives on another host must be
  performed by the engine *on that host*.
- **Root files are allowlisted in both directions.** `scripts/policy/source-allowlist.json`
  fails closed on a tracked file that is not listed *and* on a listed file that does not
  exist. Adding a root document means adding its entry in the same change.

## Platform conventions

This repository sits inside the TCRN Platform working tree. Cross-repo conventions —
constraint classification and evolution, direction and track choices, sourcing and vetting
of outside code, delivery cadence — live in the platform root's `AGENTS.md` and `docs/`.
The one that governs changes to this repository most directly: **replacing old behaviour
requires a residual-applicability analysis first** — does the old path still hold for some
supported user, host, or model? If it does, the change is conditional (a version-gated
operation, an enable event) rather than a deletion. This engine already works that way;
the convention names the practice so it survives outside the engine too.
