# Contributing

Use the pinned Node and pnpm versions. Do not enable package lifecycle scripts,
add an unpinned executable, introduce telemetry, or make a project command
implicitly access the network.

Before proposing a change:

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm verify:p1
```

Before pushing a public branch, run `pnpm preflight`. It creates an independent
`git clone --no-local --no-hardlinks`, scrubs private `TCRN_*` and sibling-checkout
variables, and runs the P1 and lessons gates without fail-fast so all red legs are
visible in the same receipt. The preflight probe contract is executable: do not use
zsh command modifiers, shell conjunctions, `PIPESTATUS`, `ref:path` probes, `tail`,
`head`, or `grep` as a verdict. `pnpm verify:privacy` judges the checked-out
HEAD-reachable public surface. The separate history diagnostic it used to name,
`verify:privacy:history`, retired with the rest of the ticket-numbered `verify:*`
roster in TCRN-CROSS-STORY-359; retained historical tags may still contain retired
bytes, and no gate in this repository judges them.

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
not proof scaffolding. The effective repository-wide hard ceiling is the
Owner-authorised `hardRatio` in `scripts/policy/proof-budget.json` (`2.50` in
the current policy). The structured `warningRatio` (`2.40`) reports growth
above the warning line without blocking; a ratio above the hard ceiling refuses
the corresponding candidate's formal release.

**Baseline.** At adoption the measured ratio was approximately `1.62`
(corrected baseline, with the `packages/protocol` package included in product
mass per its definition), well above the `1.0` threshold, so the rule binds.

**Machine enforcement — 2026-08-19, TCRN-CROSS-STORY-301, extended 2026-09-14.**
Until the first date the rule above bound and judged nothing:
`pnpm verify:budget` reported the ratio and returned success unconditionally, so
the rule was enforced by whoever remembered it. The evaluator now reads the
structured `warningRatio` and `hardRatio` fields, returns a structured
non-blocking `PROOF_BUDGET_WARNING` for `warningRatio < ratio <= hardRatio`, and
refuses with `PROOF_BUDGET_EXCEEDED` above `hardRatio`. It runs inside P1 and
the formal candidate-batch aggregate preserves the budget warning without
turning it into a generic warnings-as-failure result.

The check is a proxy and is written down as one. The rule is about introducing
gates; the check measures whether proof mass grew faster than the product it
proves. That is stricter in one direction — a test written for a genuinely new
capability can trip it — and blind in another: deleting product code raises the
ratio while adding no proof at all. Both are accepted rather than papered over,
because the alternative is asking a script to decide what counts as a gate, and
that judgement is exactly what went unmade for a year.

The hard line moves only by an entry naming the ratio it authorises and the
reason, so the policy file reads as the history of every time this was paid.

**Owner exception — TCRN-CROSS-EPIC-135, 2026-09-14.** The policy entry
`TCRN-CROSS-EPIC-135-owner-proof-budget-20260914` records the Owner-approved
`2.50` hard ceiling, `2.40` non-blocking warning, intentional bounded headroom,
and batch/stage measurement cadence. Development-time Story completion does not
create a ratio stop; candidate-final/publication boundaries still measure the
hard line. The entry cites the approving event and artifact and supersedes the
earlier exact-`2.3728` zero-headroom proposal; the raw LF/four-decimal count,
historical `frozenRatio`, surface caps, and other warning/error and security
semantics remain unchanged.

**Finite scoped disposition — TCRN-CROSS-STORY-430, 435, and 436.** The finite
authorization in `scripts/policy/proof-budget.json` preserves the `2.40`
warning and `2.50` hard line. Only the named ratio item may become a
non-blocking warning, and only after the code-owned `allowedWork` set matches
fresh native work records. The policy keeps the raw result and never suppresses
another warning, error, security, trust, resource, or surface-cap result.
Transient Pack, agent, brief, and chain-head digests are not part of the
authorization, and no caller boolean or environment hash can grant it. Work 431
and unlisted future work do not inherit the binding; changes to relevant work
or dispatch configuration are re-read immediately, while unrelated chain
appends do not invalidate the finite policy.

**Recorded exception — OD-22, 2026-08-19, the ratchet's own installation.** The
first thing the ratchet did was refuse the change that installed it: the verb's
reasoning lives in `scripts/` and its criteria live in `tests/`, both of which are
proof mass by the definition above. A mechanism that stops proof mass growing
cannot be installed without growing some. The allowance is recorded rather than
absorbed by editing the frozen line, because a mechanism whose first act is to
quietly raise its own limit teaches the habit it was built to stop.

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
plus a test run (~4-5s measured) and the registry's eighteen entries would push
the P1 wall clock past the 180s escalation trigger that protects the "run it on
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

It prints `{proofLines, productLines, ratio}` and the structured threshold result.
At or below `2.40` the reason is `PROOF_BUDGET_VERIFIED`; above `2.40` and at
or below `2.50` it is `PROOF_BUDGET_WARNING` with `warning.blocking: false` and
exit `0`; above `2.50` it is `PROOF_BUDGET_EXCEEDED` and exits `1`. The command
is already the budget member of P1; its warning is exempted only when the exact
structured budget notice is present. No generic warning is downgraded.

## Surface caps — three raw counts, not a ratio (2026-09-05, TCRN-CROSS-STORY-356)

**Definition.** The ratio above bounds proof mass against product mass; it says
nothing about the absolute size of either one, so both can grow together,
forever, in step, without the ratio ever moving. Three raw counts are pinned
instead, each against its own recorded cap rather than against each other: how
many `verify:*` scripts `package.json` declares (`verifyScriptCount`), how many
claims `verification-map.yaml` carries (`claimCount`), and how many lines
`packages/core/src/**/*.ts` holds (`coreSourceLines`) — counted the same
deliberately crude way as the ratio's own product mass, a raw `0x0a` byte count
with blank lines and comments included, but over a narrower file set: `core`
alone, not every `packages/*/src` directory `scripts/task.mjs`'s `reportBudget`
(WSG-7) spans. The two line counts are not expected to agree.

**Where it runs.** Unlike the ratio above, this is not a `verify:*` script or a
verification-map claim — adding either would be the self-referential move this
Story exists to close off. It is a `platform-doctor.mjs` leg (`proofBudget`),
read from `scripts/policy/proof-budget.json`'s `surfaceCaps` field against a live
`TCRN Platform/tcrn-workflow` checkout. A container that only consumes this
engine, without a checkout, has nothing to measure; the leg reports
`comparable: false` rather than a quiet pass.

**Caps, zero margin.** `scripts/policy/proof-budget.json`'s `surfaceCaps` field carries
the current `verifyScriptCap`, `claimCap`, and `coreSourceLineCap` — read it directly;
this document does not mirror the numbers, since each is the value measured the day it
was last written, not a value with headroom already spent. `verifyScriptCount`
and `claimCount` move only on a deliberate act (a new script, a new claim);
`coreSourceLines` moves on any change to `packages/core/src`, including an
ordinary defect fix, so a red result there does not by itself mean new proof
surface was added — the remedy is the same either way: retire an equivalent
count in the same change, or record an Owner-authorised increase below.

**Raising a cap is Owner's decision, not this leg's.** The leg answers exactly
one question — does the measured count exceed the recorded cap — and cannot
decide who is authorised to raise one. That authorization is recorded the same
way a ratio exception is recorded above: a policy-file edit made in review, with
the reasoning written into `scripts/policy/proof-budget.json`. No verb in this
engine checks who made that edit, the same limit the ratio's own exceptions have carried
since 2026-08-19. In practice: edit the cap to the value measured after the change that
needs it lands, in the same commit, and add an `exceptions` entry naming the work item
that raises it and citing the authorising decision (the convention MIN-144 D8 records);
lowering a cap needs no exception.

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

## Documentation

The human-facing root documents are single-language and follow the house style in
`docs/style/house-style.md`. `README.md` is written in Simplified Chinese and is
authoritative; every other root document is English. The twenty locale mirrors and
the `tcrn-doc-synced-to` pins that held them to their English sources retired in
TCRN-CROSS-STORY-360, together with `scripts/policy/doc-coverage.json` — every edit
to an English source had to re-translate and re-pin four files, and the pins were
stale in the tree at the moment they were removed. `pnpm push-gate` still fails
closed on a version left behind in `README.md` prose and on the CJK emphasis rule.

When to cut a release, and what the version number is allowed to track, are in
`docs/versioning/release-policy.md`.
