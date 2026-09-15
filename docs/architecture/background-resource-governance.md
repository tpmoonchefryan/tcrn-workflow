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

At spawn time, register the load's process group under an exact task owner key.
Use the host's explicit child/process-group handle; do not use an ambient group
or a command-name match as permission to signal other work:

```bash
OWNER_KEY="task:<work-id>:<Pack>"
node scripts/spawn-guard.mjs register \
  --workspace "<partition>/workspace" \
  --pgid "$PGID" \
  --pattern "yes" --purpose "$OWNER_KEY"
```

At teardown, the owning host/session control reclaims only that registered
process group and waits for every child to exit. The detector does not kill
processes. Verify the exact owner group, then deregister it; `deregister` with a
purpose refuses an owner mismatch or any live group member:

```bash
node scripts/spawn-guard.mjs detect --workspace "<partition>/workspace" --purpose "$OWNER_KEY"
node scripts/spawn-guard.mjs deregister --workspace "<partition>/workspace" --pgid "$PGID" --purpose "$OWNER_KEY"
```

Task-scoped `detect --purpose` examines only the registered process groups with
that exact owner key; it does not attribute another task's group or command
pattern to this task. It prints a canonical JSON residue report and exits `0`
when clean, `3` when residue is present, `4` when the owner has no registration
(`not-verifiable`), and `1` when the detector itself fails. The unfiltered
`detect` remains a workspace-wide report for legacy host use. Keep an active
registration and its raw diagnostics if cleanup is incomplete; never kill or
deregister another task's process group.

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
- **The Stop event exists; SessionEnd is the part that stays unconfirmed.** This
  bullet used to say that whether Codex exposes any session-end-shaped hook event
  at all was unconfirmed. That claim was already stale when written: the 0.139.0
  survey's own `versionPinnedHookSurface.hookEvents`
  (`docs/verification/host/codex-0.139.0-facts.json`), read from a real
  `codex app-server generate-json-schema`, lists `Stop`. TCRN-CROSS-STORY-357 then
  put that event into production use by two independent capabilities —
  `tools/stop-pact/codex-executor.mjs` (STORY-194) and
  `tools/stop-pact/codex-response-style-hook.mjs` (STORY-357), both registered as
  `stop-pact` and `stop-response-style-check` in `scripts/host-harness.mjs`'s
  `HARNESS_CAPABILITIES` roster and each exercised by its own test suite — which
  closes "does Codex expose a Stop hook event at all" for good. What is still true:
  Codex's distinct **SessionEnd** event stayed `schemaUnavailable` in that same
  0.139.0 survey, STORY-357 did not re-run the schema generator against the
  0.148.0 binary now installed (see `docs/verification/host/codex-0.148.0-facts.json`),
  so SessionEnd's status on the current binary is unverified rather than confirmed
  absent. And Stop gaining two occupants does not give this Initiative's own
  detector a third: nothing shipped here wires `spawn-guard.mjs` to Codex's Stop
  event. The honest position narrows to **Claude-only for this Initiative's
  session-end surface**, with Codex offered the direct `spawn-guard.mjs`
  invocation (which needs no hook) in the meantime.

## What ships in this Initiative, stated without overclaim

- The detector and the registration protocol ship and are invokable on any host
  today (`spawn-guard.mjs`), dogfooded once against a real process group.
- Automatic session-end firing is **not** activated on either host. Claude Code
  needs an Owner-signed ladder step; Codex needs the trust gate honored and a
  session-end-event survey. Both are recorded here as recipes, not as done work —
  a conditional the executor was warned about, not a scope cut.
