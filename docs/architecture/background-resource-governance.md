# Background-resource governance (INIT-007)

A governed agent session that spawns a **background load** — a CPU-stress loop, a
dev server, a headless browser, a watcher — owns that load for the session's
lifetime and must reclaim it at teardown. When it does not, the load outlives the
session and burns the host silently. The originating incident (2026-07-24): a
session spawned five CPU-stress process groups for a frame-rate proof; the shell
subshells that led those groups exited, the `yes` children reparented to init,
and 35 orphans ran at roughly seven cores for about five hours before anyone
noticed.

This is the machine-checkable half of the convention. The human half — *spawn and
cleanup live in the same command; verify the group is empty afterward* — is a
knowledge card on the governance chain (`CARD-BACKGROUND-RESOURCE-GOVERNANCE`).
This document is the host-wiring recipe: how the detector runs, and exactly where
each host draws the line between what ships now and what needs an operator's
signature.

## The pieces

- **`packages/core/src/background-resource.ts`** — the pure, deterministic core.
  A *registration face* records the process **group** a session owns (the pgid is
  the stable handle; pids are reused and orphans outlive their leader) and a
  *detection face* that, given a registration set and a process-table snapshot,
  reports residue. No `ps`, no `fs`, no `Date`, no randomness — it is a fixture-
  testable function, and its red-proof (`BR-01`, `BR-02` in the guard registry)
  is that the injected orphan is always detected.
- **`scripts/spawn-guard.mjs`** — the thin host adapter. It reads the live
  process table with the reaper's hardened `ps` invocation, and stores the
  registry as JSONL in the workspace **transient zone**
  (`<partition>/transient/spawn-registry/registrations.jsonl`), which sits
  outside the engine control tree — replay and the snapshot witness never see it,
  so it can never be mistaken for canonical control bytes.

## Using it directly (works today, every host)

At spawn time, register the load's process group:

```bash
node scripts/spawn-guard.mjs register \
  --workspace "<partition>/workspace" \
  --pgid "$(ps -o pgid= -p $LOAD_PID | tr -d ' ')" \
  --pattern "yes" --purpose "cpu-stress:framerate-proof"
```

At teardown, reap the load and deregister; then detect any residue:

```bash
kill "$LOAD_PID"                       # the convention: reclaim in the same flow
node scripts/spawn-guard.mjs deregister --workspace "<partition>/workspace" --pgid "$PGID"
node scripts/spawn-guard.mjs detect    --workspace "<partition>/workspace"
```

`detect` prints a canonical JSON residue report and exits `0` when clean, `3` when
residue is present (a distinct code so a caller can tell "a leak was found" from
"the detector itself failed", which is exit `1`).

## Wiring it to a host session-end moment

The right automatic trigger is the host's **session-end / stop** event: run
`detect` as the session winds down and surface any residue. Neither host can be
wired live without an explicit operator decision, and for the *same underlying
reason* on each — a new live host surface is a governed step, not a code change.

### Claude Code — proposed ladder step, not activated

Claude Code's activation ladder ships exactly one live hook: a fail-open
`SessionStart` summary (`docs/activation/activation-ladder-v1.md`). `Stop` is a
**deliberate KEEP-INERT non-goal** — "a live misfire silences the agent; it stays
simulate-only." A read-only detector on `Stop` is observation, not response
suppression, so it does not violate the *intent* of that non-goal, but it is
still a **new active host surface** and therefore needs an Owner-signed ladder
step. The recipe, when that step is authorized:

1. Add a `session-stop.mjs` generator mirroring `claude-adapter-session-start.ts`;
   its handler runs `spawn-guard.mjs detect` and **always `process.exit(0)`** (a
   nonzero Stop-hook exit can block the host's stop), writing the residue report
   to a project-local path, never suppressing a response.
2. Relax the single-event guard in `claude-adapter-activation.ts`
   (`validateClaudeAdapterActivationFragment`) from `{SessionStart}` to the closed
   set `{SessionStart, Stop}`, keeping `ACTIVATION_HOOK_SURFACE_EXCEEDED` for
   anything else; add the second handler path to `CLAUDE_ADAPTER_ACTIVATION_PATHS`
   and to the installer's write + byte-inverse rollback loop.
3. Keep the handler's writes **project-local** (`.claude/tcrn-workflow/…`); never
   mutate the `.tcrn-workflow/` control tree or run git working-tree operations
   from the hook (a live-sync-class hazard — see `backup-git-tier.md`).
4. Validate with an extended `host-evidence.mjs` group-A observation: install the
   Stop handler, run `claude -p`, and assert (by filesystem side effect, the
   before-auth technique the SessionStart evidence already uses) that the handler
   fired and wrote its residue marker. First confirm `Stop` hooks fire in `-p`
   one-shot mode, which is currently unexercised.

Until that ladder step is signed, the honest receipt is **proposed, not
activated**.

### Codex — proposed only, pending a session-end survey

Codex is inert in-repo: templates under `.codex/tcrn-workflow/`, no installer, no
CLI verbs. Two constraints bind any future wiring, and neither is a matter of
effort:

- **The trust gate.** Codex requires the operator to review and trust a hook's
  exact hash before it runs, recording trust against that hash; a new or changed
  hook is marked for review and skipped until trusted. So a Codex detector hook is
  **"proposed", never "activated"** in its own receipt, pending-approval is a
  first-class state, and every re-pin of the detector re-triggers approval because
  the handler is digest-bound. A future Codex ladder must be designed natively
  around this — it must not port the Claude three-step.
- **A blocking prerequisite.** The in-repo record and prior host survey establish
  only a Codex **SessionStart**-equivalent hook. Whether Codex exposes a
  **session-end / stop** hook event at all is unconfirmed. Until a fresh survey of
  the current Codex hook events confirms one, a Codex *session-end* detector is
  infeasible regardless of the trust gate, and the honest position is
  **Claude-only for the session-end surface**, with Codex offered the direct
  `spawn-guard.mjs` invocation (which needs no hook) in the meantime.

## What ships in this Initiative, stated without overclaim

- The detector and the registration protocol ship and are invokable on any host
  today (`spawn-guard.mjs`), dogfooded once against a real process group.
- Automatic session-end firing is **not** activated on either host. Claude Code
  needs an Owner-signed ladder step; Codex needs the trust gate honored and a
  session-end-event survey. Both are recorded here as recipes, not as done work —
  a conditional the executor was warned about, not a scope cut.
