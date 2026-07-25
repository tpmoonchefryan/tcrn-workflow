# Activation Ladder v1 (gated design artifact)

- Status: Accepted activation ladder; main-session persona scope corrected 2026-07-25
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
- **Hook command**: `node '<admittedProjectRoot>/.claude/tcrn-workflow/session-start.mjs' --handler-digest <scriptDigest>`
  (handler emitted by `generateSessionStartScript`; the real canonical absolute
  root is shell-quoted into the fragment, and the handler's exact byte digest is
  pinned in the approved line so post-approval drift in those bytes fail-opens
  instead of running — INC-015. The digest travels as an argument because the
  emitted source cannot contain its own digest and a literal would break N-7).
  It reads project metadata, composes a summary, and if the summary exceeds
  **1024 bytes it prints nothing** (a truncated authority summary is a
  misrepresentation, not a fallback).
- **Failure mode**: **fail-OPEN** — this is the single documented exception to the
  repository's fail-closed norm (governing handoff N-2). The handler body is
  wrapped so every failure path (missing/malformed `project.json`, a control
  character in an interpolated project field (INC-014), a missing or mismatched
  --handler-digest (INC-015), over-budget text, any thrown error) prints nothing
  and exits 0; the session proceeds as plain Claude Code. `ACT2-FAIL-OPEN` makes
  this a proven property.
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
- **Claims required before merge**: `ACT2-CLAUDE-SESSIONSTART`, `ACT2-FAIL-OPEN`,
  and `HOOK-ABSOLUTE-ROOT-BINDING`. The latter proves that fire-time cwd cannot
  redirect the command to a different project handler. It does not cover the
  interpreter: `node` is a bare name resolved through the fire-time PATH, and the same
  gate executes that substitution to keep the boundary honest (INC-011, disclosed).

## Step 3 — Persona-free compatibility rung; conference renderer stays separate (WSG-4)

- **What**: the historical `--step3` activation spelling remains a compatibility
  alias for the same persona-free SessionStart summary as Step 2. It creates no
  `persona-render.json`, binds no Core Reference role to the host session, and
  does not make the main thread read-only. The summary's `operationAuthority`
  limits Workflow mutations only; it does not revoke a user's explicit authority
  for ordinary repository work.
- **Conference-only renderer**: `persona-render --profile-id <id>` can render any
  of the eight closed Core Reference persona ids into a digest-bound reference of
  at most 1024 UTF-8 bytes. Its scope is
  `conference_position_reference`; it writes only to stdout and is never consumed
  by SessionStart. Mutated persona prose still fails through the pinned source
  validation path.
- **Hook command**: unchanged from Step 2. The handler reads only `project.json`
  and emits the bounded Workflow/main-thread scope summary.
- **Failure mode**: the SessionStart handler remains fail-OPEN. Conference render
  generation remains fail-closed with the ACT3 reason codes and is not a host
  activation path.
- **Rollback**: activation rollback covers the four inert templates plus
  `session-start.mjs`; there is no persona file to remove.
- **Claims required before merge**: `ACT3-PERSONA-RENDER`.

## KEEP INERT (non-goals — do not activate in this program)

- **PreToolUse enforcement** — the framework adjudicating host tool use is the
  authority-creep apex.
- **Stop / final-hop response suppression** — a live misfire silences the agent;
  it stays simulate-only.
- **Any write under user-level `~/.claude`** — inert bundle paths remain under
  `assertNoForbiddenClaudePaths` (`:259`), while active fragments carry the
  required absolute project path only after installer root admission rejects the
  home directory, filesystem root, their ancestors, host-tree segments and
  symlinked roots.
- **Automatic knowledge promotion** — promotion stays an explicit
  `knowledge-promote` action so conference/candidate output cannot self-authorize
  into routed context.
- **Conference orchestration** — no live orchestration until the WS-D conference
  verbs exist with receipts.

## Owner sign-off (GD-1)

Ratified per the program implementation authorization (recommended defaults):
Step-2 fail-OPEN semantics admitted as the sole documented exception to the
fail-closed norm (OD-32), and the v2-fragment-with-new-merge-key approach admitted
(OD-33). The earlier OD-34 implementation interpretation that injected Verity into
a main host session is superseded: Core Reference personas are conference-only
position attributions. This doc remains the activation gate artifact; WSG-2/3/4
code merges only after their named claims are green.

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

The command names the handler through the installer-admitted canonical absolute
project root and carries the exact handler and summary byte digests. The root is
part of the artifact and definition digests, and the installer compares it with
its independently re-admitted root before writing. The resulting definition
digest is intentionally machine specific. The interpreter is not part of that binding:
the command's first token is the bare name `node`, resolved through the fire-time PATH,
so a PATH entry ahead of the real interpreter substitutes it and the handler's byte
self-check never runs (INC-011). An absolute interpreter path is not pinned because the
approved definition would then drift with every toolchain change, and a fail-open hook
degrades silently when it drifts. The handler rechecks both byte digests, accepts only
the documented SessionStart sources, emits at most 1024 UTF-8 bytes as
`hookSpecificOutput.additionalContext` for `SessionStart`, and on every failure
emits nothing and exits zero. The generic `systemMessage` field is deliberately
not used because Codex surfaces it as a warning rather than model context. No
enforce event is installed. The injected v2 summary states that the main thread
is not read-only, ordinary repository authorization remains available when the
user grants it, and Core Reference personas are conference-only.

Codex owns the decisive activation step. A non-managed command hook is skipped
until the operator reviews and approves its exact current definition through
`/hooks`; a changed definition is skipped until approved again. Therefore the
installation receipt always has:

- `activationState: pending_host_approval`;
- `approvedHookDefinitionDigests: []`;
- `installationDoesNotProveActivation: true`;
- `activationAuthorityDigest`: the independently admitted activation-host digest.

Only `adapter-activation-record`, under the separate authority-bearing-output
grant, can emit `host_observed_active`. It accepts the descriptor-bound activation
receipt plus either a real branded activation-host observation context or an
operator-pinned observation file; it never accepts a self-described approval set
or observation JSON. The observation binds the active receipt, activation
authority and host digest, exact hook definition, approved definition set,
host/session/event/fire facts, and evidence digest. The v2 host receipt binds that
observation digest, its evidence source, and where applicable the observation
file SHA-256 and source identity digest. An observation is admitted only while it is
fresh for the authority presenting it: inside the activation-host context window on
the branded route (that window is covered by the bound host digest), and inside the
operator bundle window and at or before the operator verification time on the pinned
file route. The same pinned bytes therefore cannot be re-presented under a rotated
bundle to mint another `host_observed_active` receipt. The approved set contains TCRN SHA-256
digests of the exact local definition bytes. Codex stores a host-owned `trusted_hash`, which
the live probe observed out of band, but its normalized input and digest-domain
semantics are opaque. Current TCRN receipts do not ingest that host value, so they
mark it `opaque_not_exported` and never assert digest equality. The July 25
`a340f94` observation and v2 receipt are retained in
`docs/verification/host/codex-session-start-activation.json` only as historical
evidence for the withdrawn persona-bound bytes. They do not approve or live-prove
the corrected persona-free v2 summary and handler. That corrected definition has
not been installed, reviewed through `/hooks`, approved, or fired. `pnpm
verify:act9` binds the code-level fail-open, trust-state and pending-live evidence
contracts; `pnpm verify:act12` executes the absolute-root cwd-hijack probe
hermetically and, in the same run, executes the interpreter substitution it does not
close, so the INC-011 disclosure cannot outlive the code it describes.

`adapter-activation-assess` computes only set membership from two caller-supplied
inputs. Its document is schema-tagged
`tcrn.codex-activation-definition-comparison.v1`, declares `evidenceClass:
caller_supplied_input_only`, carries no activation-state field, and is refused by
every activation validator on its key set (INC-012).

### Codex Step 3 — capability summary compatibility rung (S067)

Step 3 uses the same single hook and the same persona-free summary as Step 2. The
capability-manifest digest, summary object, summary file, handler, and hook
definition remain digest-bound. A handler-byte or summary-byte change changes the
command definition, so the local comparison reports the new definition digest as
absent from the supplied approved set and a fresh `/hooks` approval is required; a
changed approved set is also explicit. No Core Reference
persona is injected or bound to the main session, and the injected Workflow
authority boundary does not withdraw ordinary repository authorization.

`adapter-deactivate` verifies every activation file and its receipt before
removing anything, unregisters `.codex/hooks.json` first, then removes the handler
and summary, and leaves the inert Step-1 bundle intact. Codex may retain its
host-owned approval for the removed exact definition; with no project hook
definition, nothing remains active. The gate is
`CODEX-SESSIONSTART-ACTIVATION` / `pnpm verify:act9`.
