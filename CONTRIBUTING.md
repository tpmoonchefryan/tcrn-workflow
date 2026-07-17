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

**Measurement.** Run the report-only command:

```sh
node scripts/task.mjs budget
```

It prints `{proofLines, productLines, ratio}` with reason `PROOF_BUDGET_REPORT`
and always exits `0`. The command is a measurement, not a gate: it is
intentionally absent from the verification map and from continuous integration,
precisely so the budget rule does not itself add the kind of gate it governs.
The rule binds reviewers and the Owner gate, not CI.
