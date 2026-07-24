# Activation Ladder v1 (gated design artifact)

- Status: Accepted per program authorization (recommended defaults, OD-32/OD-33/OD-34)
- Date: 2026-07-17
- Governs: WSG-2 (Step 1), WSG-3 (Step 2), WSG-4 (Step 3), INIT-009
  EPIC-023 S066/S067 (Codex peer rungs)

Both host adapters ship **inert**: `generateClaudeAdapterBundle`
(`packages/core/src/claude-adapter.ts:356`) emits uninstalled template data to
stdout only, and the settings fragment is data under the `tcrnWorkflowInert`
merge key (`:167`) that Claude Code does not interpret. This document is the
signed precondition for any code that makes a Claude Code host live. No
activation code merges before this doc is signed and its per-step
verification-map claims are green (governing handoff constraint 5; the
`P6B-CLAUDE-ADAPTER` claim names `activation` as a re-verification trigger).

Each step below states its hook command (or "none"), failure mode, rollback
citation, and the verification-map claim ids that MUST be green before that
step's code merges.

## Step 0 — Read-only queries (no code)

- **What**: skill-taught invocations of the existing stdout-only verbs
  `claude-adapter-generate` / `claude-adapter-validate` /
  `claude-adapter-settings-fragment` (`packages/cli/src/index.ts:400-449`) against
  a verified checkout, plus the metadata-first work/knowledge queries.
- **Hook command**: none. Nothing is written to disk; nothing executes from a
  host surface.
- **Failure mode**: none (pure reads).
- **Rollback**: n/a.
- **Claims required before advance**: none beyond the existing
  `P6B-CLAUDE-ADAPTER`.

## Step 1 — Governed project-local install (WSG-2)

- **What**: a new `claude-adapter-install` verb writes the four inert templates
  (`CLAUDE_ADAPTER_TEMPLATE_PATHS`, `claude-adapter.ts:152`) under
  `<projectRoot>/.claude/tcrn-workflow/` and emits the existing
  `tcrn.claude-adapter-installation-generation.v1` receipt. `.claude/settings.json`
  is **not** touched in this step.
- **Hook command**: none. The four files are inert JSON; no hook is registered
  and nothing runs from them.
- **Failure mode**: fail-closed. A pre-existing target file →
  `INSTALLER_TARGET_EXISTS` with zero writes; an installation root containing any
  `.claude`/`.codex` segment or a symlinked root → `INSTALLER_ROOT_INVALID`
  (mirrors `readClaudeAdapterInstallationReceipt` root checks, `:542`, and
  `assertNoForbiddenClaudePaths`, `:259`). No write under user-level `~/.claude`
  (governing handoff constraint 7 / N-7).
- **Rollback**: `planClaudeAdapterRollback` (`:609`) is `identity_digest_match_only`
  — it removes only files whose bytes still match the receipt; a tampered file →
  `INSTALLER_ROLLBACK_MISMATCH` and the file is preserved.
- **Claims required before merge**: `ACT1-CLAUDE-INSTALLER`.

## Step 2 — Activation fragment v2: single fail-OPEN SessionStart hook (WSG-3)

- **What**: a new fragment schema `tcrn.claude-adapter-settings-fragment.v2` under a
  distinct `tcrnWorkflow` merge key (so v1 inert and v2 active coexist and v1
  removal stays byte-inverse) installs exactly ONE `SessionStart` hook that runs a
  governed handler reading `.claude/tcrn-workflow/project.json` read-only and
  printing only a bounded authority summary. Activation binds to a Step-1 receipt
  digest (no install → no activation).
- **Hook command**: `node .claude/tcrn-workflow/session-start.mjs` (handler
  emitted by `generateSessionStartScript`). It reads project metadata, composes a
  summary, and if the summary exceeds **1024 bytes it prints nothing** (a
  truncated authority summary is a misrepresentation, not a fallback).
- **Failure mode**: **fail-OPEN** — this is the single documented exception to the
  repository's fail-closed norm (governing handoff N-2). The handler body is
  wrapped so every failure path (missing/malformed `project.json`, over-budget
  text, any thrown error) prints nothing and exits 0; the session proceeds as
  plain Claude Code. `ACT2-FAIL-OPEN` makes this a proven property.
- **Settings admission (installer, not handler)**: the Step-2 installer reads
  `.claude/settings.json` under the same hardened sequence the receipt readers use
  (`lstat` → `open` `O_NOFOLLOW` → `fstat` identity → read → `fstat` + by-name
  `lstat` recheck), and re-verifies the file's bytes and identity immediately
  before the `rename` that commits the merge. Three cases now fail with the
  terminal `INSTALLER_SETTINGS_INTERFERENCE` (alongside the existing
  `INSTALLER_TARGET_EXISTS` / `INSTALLER_ROOT_INVALID`): a **symlinked or
  hardlinked** `.claude/settings.json`, an identity swap during the read, and any
  concurrent edit landing between the merge and the commit. The symlink rejection
  is a deliberate behaviour change — previously the bare read followed the link and
  the `rename` then replaced it with a regular file, destroying a stow/chezmoi-style
  dotfile link without a word. The code is terminal, not transient: retrying a
  symlinked `settings.json` never succeeds; the operator must resolve the link (or
  the competing edit) first. The `rename` is the sole commit point — nothing
  failable follows it, so no crash can leave an activated hook pointing at a script
  the cleanup deleted.
- **Rollback**: `removeClaudeAdapterSettingsFragment` (`:512`) is the byte-inverse
  of `mergeClaudeAdapterSettingsFragment` (`:506`); removal restores
  `.claude/settings.json` byte-for-byte, preserving any pre-existing user hooks.
- **Claims required before merge**: `ACT2-CLAUDE-SESSIONSTART`, `ACT2-FAIL-OPEN`.

## Step 3 — Persona-to-prompt renderer for Verity (WSG-4)

- **What**: `renderPersonaAuthoritySummary` renders exactly one advisory persona
  (`profile:tcrn-verity-v1`, a read-only role) into a digest-bound, byte-budgeted
  summary written to `.claude/tcrn-workflow/persona-render.json` and consumed only
  by the Step-2 SessionStart handler. The allowlist is a closed set of one,
  extended only by a future Owner decision; the render is digest-bound to the
  pinned persona source manifest, so mutated persona prose → `PERSONA_SOURCE_MISMATCH`.
- **Hook command**: same SessionStart handler as Step 2; it re-verifies the render
  file's `renderDigest` and `byteLength <= 1024` before printing.
- **Failure mode**: fail-OPEN — a render mismatch or over-budget render → the
  handler prints nothing and exits 0.
- **Rollback**: the render file is removed by the same
  `planClaudeAdapterRollback` identity-match sweep as Step 1's templates.
- **Claims required before merge**: `ACT3-PERSONA-RENDER`.

## KEEP INERT (non-goals — do not activate in this program)

- **PreToolUse enforcement** — the framework adjudicating host tool use is the
  authority-creep apex.
- **Stop / final-hop response suppression** — a live misfire silences the agent;
  it stays simulate-only.
- **Any write under user-level `~/.claude`** — `assertNoForbiddenClaudePaths`
  (`:259`) must survive every activation change.
- **Automatic knowledge promotion** — promotion stays an explicit
  `knowledge-promote` action so conference/candidate output cannot self-authorize
  into routed context.
- **Conference orchestration** — no live orchestration until the WS-D conference
  verbs exist with receipts.

## Owner sign-off (GD-1)

Ratified per the program implementation authorization (recommended defaults):
Step-2 fail-OPEN semantics admitted as the sole documented exception to the
fail-closed norm (OD-32); the v2-fragment-with-new-merge-key approach and the
Verity single-persona allowlist admitted (OD-33/OD-34). This doc is the activation
gate artifact; WSG-2/3/4 code merges only after their named claims are green.

## Codex peer ladder — INIT-009 EPIC-023

Codex now follows the same narrow evidence staircase without pretending its host
trust mechanism is the same as Claude Code settings.

### Codex Step 1 — inert project-local install

`adapter-install` writes only the four validated template files beneath
`.codex/tcrn-workflow/`. It does not create `.codex/hooks.json`, start Codex, or
claim activation. `pnpm verify:act4` remains the gate for this rung.

### Codex Step 2 — one fail-open SessionStart context hook (S066)

`adapter-activate` requires a separately read, digest-pinned Step-1 receipt. It
writes nothing until it also admits an independent
`tcrn.codex-adapter-activation-host.v1` authority document. That document binds
the exact request and Context, Workspace/project/work target, Context validity
window, Step-1 receipt digest, capability-manifest digest and requested
Step-2/Step-3 rung. The inert generation host input cannot be reused because its
contract explicitly says `activationAllowed=false`. Once admitted, activation
writes:

- `.codex/tcrn-workflow/session-start.mjs`;
- `.codex/tcrn-workflow/session-summary.json`;
- exactly one `.codex/hooks.json` entry, for `SessionStart` with matcher
  `startup|resume`.

The command names the project-local handler literally and carries the exact
handler and summary byte digests. The handler rechecks both digests, accepts only
the documented SessionStart sources, emits at most 1024 UTF-8 bytes as
`hookSpecificOutput.additionalContext` for `SessionStart`, and on every failure
emits nothing and exits zero. The generic `systemMessage` field is deliberately
not used because Codex surfaces it as a warning rather than model context. No
enforce event is installed.

Codex owns the decisive activation step. A non-managed command hook is skipped
until the operator reviews and approves its exact current definition through
`/hooks`; a changed definition is skipped until approved again. Therefore the
installation receipt always has:

- `activationState: pending_host_approval`;
- `approvedHookDefinitionDigests: []`;
- `installationDoesNotProveActivation: true`;
- `activationAuthorityDigest`: the independently admitted activation-host digest.

Only `adapter-activation-record`, given an explicit approval-and-fire observation,
can emit `host_observed_active`. The approved set contains TCRN SHA-256 digests of
the exact local definition bytes. Codex does not export its internal trust hash,
so every receipt marks that value `opaque_not_exported` and never asserts digest
equality. The disposable-host approval, fire, and changed-definition skip are
recorded in
`docs/verification/host/codex-session-start-activation.json`; `pnpm verify:act9`
binds the code proof to that evidence.

### Codex Step 3 — bounded Verity plus capability summary (S067)

Step 3 uses the same single hook and adds the same closed Verity advisory persona
used on Claude Code, plus the exact capability-manifest digest. Persona source,
summary object, summary file, handler, and hook definition are digest-bound. A
handler-byte or summary-byte change changes the command definition and therefore
returns the local assessment to `pending_host_approval`; a changed approved set is
also explicit. The injected text continues to confer no mutation or approval
authority.

`adapter-deactivate` verifies every activation file and its receipt before
removing anything, unregisters `.codex/hooks.json` first, then removes the handler
and summary, and leaves the inert Step-1 bundle intact. Codex may retain its
host-owned approval for the removed exact definition; with no project hook
definition, nothing remains active. The gate is
`CODEX-SESSIONSTART-ACTIVATION` / `pnpm verify:act9`.
