# Contributing

Use the pinned Node and pnpm versions. Do not enable package lifecycle scripts,
add an unpinned executable, introduce telemetry, or make a project command
implicitly access the network.

Before proposing a change:

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm verify:p1
```

Dependencies must be exact versions, compatible with Apache-2.0 distribution,
and added to the offline dependency and vulnerability policies. Source files
that accept comments must include `SPDX-License-Identifier: Apache-2.0`.

Release behavior must fail closed when an external trust root is absent,
candidate-controlled, expired, revoked, or inconsistent with the signed
manifest.

## Proof budget

**Definition.** Proof mass is the total newline count of `tests/**/*.mjs` plus
`scripts/**/*.mjs` (the `.mjs` filter excludes the `scripts/policy` JSON policy
files). Product mass is the total newline count of `packages/*/src/**/*.ts`.
Blank lines and comments are counted deliberately: the measure is crude on
purpose so it is deterministic and not open to reformatting debate. The
proof-to-product ratio is `proofMass / productMass`.

**Rule.** While the ratio is at or above `1.0`, no pull request may introduce a
NEW verification gate — that is, a new `scripts/task.mjs` handler, a new
`verify:*` script, or a new verification-map claim whose category is
`framework-hygiene` — unless the same pull request retires at least the
equivalent proof mass, or the Owner records a written exception. Claims whose
category is `runtime-capability` are exempt: they are the product doing its job,
not proof scaffolding.

**Baseline.** At adoption the measured ratio was approximately `1.62`
(corrected baseline, with the `packages/protocol` package included in product
mass per its definition), well above the `1.0` threshold, so the rule binds.

**Recorded exception — OD-21, 2026-07-19, `pnpm guard-check`.** The Owner grants
one written exception for the guard registry and its mutation checker
(`scripts/guard-check.mjs`, `scripts/policy/guard-registry.json`).

The exception is recorded here rather than avoided, and the distinction matters.
The checker could have been shipped as a standalone npm script — the shape
`push-gate` already uses — and then argued to fall outside the rule's three named
forms. That argument holds for `push-gate`, which checks release consistency and
adds no proof surface. It does not hold here: a mutation checker is proof
scaffolding by any reading, and routing around the rule on a narrow textual
reading would be the governance form of the exact substitution this repository's
own audit caught in its code.

What the exception buys: the rc.6 program twice landed a guard whose proof was
never written, and the consequence was that reverting the guard reddened nothing.
The correction was a discipline recorded in commit messages — revert each guard,
observe red, restore. This makes that discipline a machine judgement. It declares
no new capability; it tests whether existing proof still bites.

Scope: `guard-check` stays a standalone script wired into `push-gate`. It is
deliberately **not** folded into `verify:p1`, because each entry costs a build
plus a test run (~4-5s measured) and the registry's twelve entries would push the
P1 wall clock toward the 180s escalation trigger that protects the "run it on
every change" discipline.

**Current.** `{proofLines: 26631, productLines: 16011, ratio: 1.6633}`, measured
2026-07-20. **Re-measure rather than quote this number.** It is a snapshot, not a
pin: it has been found stale by 144 lines once already, and every entry in the
running commentary that used to live here went stale the moment the next change
landed — a paragraph that says which work added "the last" lines is wrong as soon
as there is a later one. The ratio has moved between `1.535` and `1.6575` across
the rc.6 program, the OD-21 guard checker, the post-release hardening, the OD-16
duplication work, and `host-evidence`; **git log on this file is the history, and
it does not go stale.** What matters here is the current value, the rule above,
and that the ratio has never approached `1.0`, so the rule still binds.

**Measurement.** Run the report-only command:

```sh
node scripts/task.mjs budget
```

It prints `{proofLines, productLines, ratio}` with reason `PROOF_BUDGET_REPORT`
and always exits `0`. The command is a measurement, not a gate: it is
intentionally absent from the verification map and from continuous integration,
precisely so the budget rule does not itself add the kind of gate it governs.
The rule binds reviewers and the Owner gate, not CI.

## Evidence is not a gate — `pnpm host-evidence` (OD-C3, 2026-07-20)

`scripts/host-evidence.mjs` drives the real Claude Code binary against a real
installation of the adapter payload and writes
`docs/verification/host/claude-code.json`. It is **release evidence, not a
verification gate**, and the distinction decides three things about it:

- It is **not** in the `verify:*` namespace, **not** in the verification map,
  and **no** gate or CI job depends on it. The budget rule's ban on new gates is
  therefore not engaged and no exception was needed.
- It cannot run where Claude Code is absent. A check nobody can reproduce becomes
  a check everybody learns to skip, which is how a gate starts lying.
- Its **absence blocks a release**; its exit code blocks nothing. Those are
  different mechanisms and are deliberately not expressed by the same one.

The receipt is written in two groups because they need different runners. Group A
is observable without credentials — hooks fire before authentication, so a
sandboxed session that dies at 401 has still run them. Group B needs a
credentialed session and is the Owner's to run. **When group B has not been run
the receipt must show it as absent rather than omit it**: a receipt that lists
only what was checked reads as complete, and group A going green is exactly the
result that would otherwise be mistaken for the whole thing.

Group B is two commands, not a procedure to reconstruct:

```sh
pnpm host-evidence --prepare-group-b     # installs a probe, prints what to run
# run the printed `claude -p …` in the probe, then:
pnpm host-evidence --record-group-b --observed "<the answer>" --runner "<who>"
```

The printed command pipes its prompt in on stdin. `--tools` is variadic, so a
prompt written after it is consumed as another tool name and the CLI refuses with
"Input must be provided" — the first version of this shipped that way, because the
flag was checked in `--help` and the composed command was never actually run.

The question asks the model which workspace id its session context mentions, and
the answer is the observation — which is why `--record-group-b` checks it against
the installed id rather than accepting a verdict. A reply that does not name it
is recorded as `CONTRADICTED`, not quietly dropped, and the runner's name goes in
the receipt beside the result.

**Two properties make that answer evidence rather than a coincidence, and both
are required.** The workspace id is a nonce minted per preparation, so it cannot
be guessed from the probe's path or from anything the model saw before. And the
printed command passes `--tools ""`, so the id cannot be read out of
`project.json` — which is sitting right there and cannot be removed, because the
handler reads it. Drop either one and a correct answer becomes compatible with
the summary never having reached the model at all, which is the single thing this
observation exists to establish.

A group-A run rewrites the receipt, but **it carries a recorded group B forward
rather than resetting it**, marking it as taken against earlier bytes. Group B
costs a human a session; regenerating group A must never be able to silently
spend that. Stale provenance stated is recoverable — a blank where an observation
used to be is not.
