# stop-pact — a host-level stop gate

`stop-pact` turns the standing stop-budget ruling (2026-07-21) into a mechanism the
harness can enforce, instead of prose a model can read and then ignore. It exists
because that is what happened: on 2026-07-31 a run stopped prematurely three times in
one session, resisting the ruling, an explicit "run to completion" instruction, and a
memory note the model itself had written 56 minutes earlier. Prose could not hold the
behaviour; this puts a gate at the one layer the model does not author — the Claude
Code **Stop hook**.

Recorded on the governance chain as `TCRN-CROSS-INIT-016`; the D1/D2 execution ruling
is `TCRN-CROSS-MIN-051` (conference `TCRN-CROSS-CONF-049`).

## The idea

When the owner authorises a **run to completion**, you create a *pact*. A user-level
Stop hook then fires at the end of every turn in every session. If a pact is active,
bound to that session, still `running` (not migrated), and the model is not a flagship,
the hook returns a block decision and the turn continues instead of ending. Stopping is
not a free action; it is a **state migration** the run must pass through — the same
discipline the chain puts on a work item that cannot jump straight to `done`.

The judgement is on **work state, not model identity**. The model only sets the
*strength*: `enforce` (block) for ordinary models, `observe` (surface, never block) for
the flagship. So a stronger model is never constrained, a weaker one is kept working,
and neither rule needs a per-model list that the next model release would invalidate.

## The one governing principle

**On missing or ambiguous information, fail toward NOT blocking.** Both hard invariants
live on that side of every ambiguity:

- **Never harm a flagship.** An unrecoverable model resolves to `observe`, never
  `enforce`. (The 2026-08-01 review found an enforce-fallback would block a Fable
  session whenever its model couldn't be read from the transcript.)
- **Never trap a session.** Unknown progress counts as *no* progress, so the escalation
  valve climbs and releases rather than blocking forever. Any throw in the hook exits 0
  with no block. A malformed pact reads as *absent* (→ allow), never as a trap.

## Commands

```
node tools/stop-pact/cli.mjs start --scope "<what this run covers>" --authorized-by "<owner directive>" [--ttl-hours 24] [--max-blocks 3] [--session <id>]
node tools/stop-pact/cli.mjs complete
node tools/stop-pact/cli.mjs block --ticket <owner_intent_required|external_release|hard_blockage> --reason "..."
node tools/stop-pact/cli.mjs cancel
node tools/stop-pact/cli.mjs status
```

The three ticket classes are the only legitimate reasons a run may stop early — verbatim
the stop-budget ruling. The pact lives at `~/.claude/stop-pact/current.json` (override
with `TCRN_STOP_PACT_PATH`).

## Wiring (D1: user level)

Register the hook in `~/.claude/settings.json`:

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node <abs>/tools/stop-pact/hook.mjs", "timeout": 10 } ] } ] } }
```

It fires in every session but **allows immediately when there is no active pact**, so
ordinary sessions are untouched.

## Design (the files)

- `decide.mjs` — the pure decider. No IO, no clock, no host: every world it judges is an
  argument, so the test suite can drive worlds this process is never in (another session,
  an expired pact, a model that isn't the one running now).
- `pact.mjs` — the contract: schema, lifecycle (append-only history), strict validation
  that fails a malformed pact toward *absent*.
- `mode.mjs` — model→mode (D2) and progress by tool-use activity; both fail toward
  not-blocking on missing info.
- `notify.mjs` — a local macOS notification on every legitimate stop and every
  escalation release, so a stop is never silent (the five-and-a-half-hour gap is the
  reason this exists).
- `cli.mjs` — the five commands; the terminal notification fires here, at the migration.
- `hook.mjs` — the one impure orchestrator; translates the verdict to the Stop-hook wire
  protocol (`{"decision":"block","reason":...}` + exit 0, flushed before exit).

## Known limits (honest)

- **Hooks are snapshotted at session start on this host** (measured 2026-08-01: a
  probe registered mid-session never fired). A settings change therefore governs *new*
  sessions, not the running one; restart to apply. Live end-to-end confirmation happens
  on the next session start — the doc contract plus the subprocess tests cover the wire
  protocol until then.
- **Unbound-pact binding is first-fire.** `start` without `--session` binds the pact to
  whichever session stops first. In the common case that is the authorising session (its
  own turn-end), but a parallel session stopping in the narrow window between `start` and
  that turn-end could claim it. Pass `--session <id>` when the id is known to remove the
  race.
- **One active pact per user.** Two concurrent run-to-completion sessions are not yet
  supported; the second `start` refuses unless `--force`.
- **Codex has no equivalent Stop event**, so this governs Claude Code only; the gap is
  recorded per supply-parity (`TCRN-CROSS-STORY-125`).
