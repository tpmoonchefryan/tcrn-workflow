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

**Current.** `{proofLines: 26196, productLines: 16011, ratio: 1.6361}`, measured
2026-07-20. The rc.6 fix and optimization program moved this from `1.62` to
`1.599` — it added proof to fixes that had shipped without it and retired four
dead release helpers, and no package in it needed the exception clause. The
OD-21 guard checker above then moved it back to `1.618`, which is the cost that
exception bought. The post-release hardening that followed — guard registry
entries eleven and twelve, and the failure-pattern register with its push-gate
checks — took it to `1.6269`, and the OD-16 duplication work added the last
`147` lines: the tests pinning what `canonicalDocumentBytes` means and the corpus
holding the two strict RFC 3339 parsers to one grammar. Both are proof against
drift in bytes that are already shipping, which is what this budget is for. The
ratio did not approach `1.0` at any point, so the rule still binds. Re-measure
rather than quote this number; it is a snapshot, not a pin, and it was once found
stale by 144 lines.

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
