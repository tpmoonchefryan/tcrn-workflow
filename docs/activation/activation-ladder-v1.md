# Activation Ladder v1 (gated design artifact)

- Status: Accepted per program authorization (recommended defaults, OD-32/OD-33/OD-34)
- Date: 2026-07-17
- Governs: WSG-2 (Step 1), WSG-3 (Step 2), WSG-4 (Step 3)

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
