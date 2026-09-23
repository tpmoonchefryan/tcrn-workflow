# Proof lines by responsibility

The proof-to-product ratio counts every `.mjs` line under `tests/` and `scripts/` as
proof. Some of those lines are the workflow itself: hooks, the CLI entry, dispatch
resolution. A single ratio cannot tell a new gate from a new hook. The view described
here classifies the same lines by what each file does, and reports that classification
beside the raw count. It does not replace the raw count.

It rebuilds TCRN-CROSS-SUB-116 as TCRN-CROSS-STORY-462 (TCRN-CROSS-MIN-213 D2,
TCRN-CROSS-MIN-221 D3). It follows the direction approved in D5 of the 2026-09-15
ratio-policy Owner authorization: keep the raw ratio as a trend and separate runtime
function, test, and verification tool by real responsibility.

## What stays exactly as it was

- `proofLines`, `productLines`, the ratio, and the raw `0x0a` counting method in
  `scripts/task.mjs`'s `reportBudget` (WSG-7).
- The policy fields `frozenRatio`, `warningRatio`, `hardRatio`, `exceptions`,
  `ratioPolicy` (including the INIT-051 `scopedDisposition` and its
  `allowedWork`/`excludedWork` sets), and `surfaceCaps`. These remain the only numbers
  that judge anything.
- No file was moved, merged, or reformatted to change a count.

The view is not a cap or a threshold, and it triggers no approval request. None of its
keys ends in `Cap`, so the doctor's `proofBudget` leg does not read it as one.

## Where it lives

- Policy: `scripts/policy/proof-budget.json`, field `responsibilityView`.
- Report: `corepack pnpm run report:budget` prints it as the `responsibility` field,
  next to `proofLines` and `productLines`.
- Code: `classifyProofResponsibility` and `proofResponsibilityViewProblems` in
  `scripts/lib/proof-budget.mjs`.

The report sums the same files the raw count reads, and the parts always add back up:
`byResponsibility` + `mixed.lines` + `unknown.lines` = `proofLines`. The same source
tree always gives the same numbers. A view that cannot classify is reported with
`status: "invalid"` and its problems, beside a raw count and verdict that do not change.

## Classification basis

A file is classified by what it does when it runs, not by the directory it sits in.

| Responsibility | What belongs here |
| :--- | :--- |
| `test` | Everything under `tests/`: test files, fixtures, helpers. Also a file under `scripts/` that exists only to serve tests (`scripts/pg-test-connection.mjs`). |
| `runtime-function` | Code that runs when the workflow is used. This covers host hooks and guards, the CLI entry, host configuration rendering, knowledge injection, capture and translation, and chain maintenance tools (summary backfill, language migration). It also covers backups and archive maintenance, the Owner queue, and the portal build steps that produce shipped bytes. |
| `verification-tool` | Code that judges or measures the repository or a release. This covers gate runners, proofs, test controllers, and privacy, link and coverage checks. It also covers release verification, benchmarks and measurements, including research prototypes that only measure. |

`scripts/bench/` is classified by prefix. Every other script is named individually in
`classes` or `mixed`, so a script added later is reported as `unknown` until someone
classifies it.

## Mixed files

A file with more than one responsibility is counted once, under `mixed`, with every
responsibility named. It is not split, and it is not forced into one class.

| File | Why it is both runtime function and verification tool |
| :--- | :--- |
| `scripts/dispatch-adapter.mjs` | Resolves native dispatch for hosts at run time and carries the validation that refuses a changed work, scope, model or effort. |
| `scripts/task.mjs` | Builds `dist/build`, which the CLI and hooks execute, and runs every verification leg. |
| `scripts/lib/canonical-order.mjs` | Copied into `dist/build` by the build and used by gates. |
| `scripts/lib/files.mjs`, `scripts/lib/safe-io.mjs`, `scripts/lib/scoped-strip-types.mjs` | The build that produces `dist/build` walks, transforms and writes through them, and so do gates. |
| `scripts/lib/local-command.mjs` | Used by the knowledge-language migration and by gates. |
| `scripts/lib/private-token-roster.mjs` | Read by the SSH write observer hook and by the privacy scans. |
| `scripts/verify-release-trust.mjs`, `scripts/lib/release-trust.mjs` | Shipped as the `tcrn-workflow-release-verify` command that consumers run, and it verifies a release. |

## Unknown files

A proof file named nowhere in the view is reported by path under `unknown`. It is never
folded into a class. At the time of writing that applies to `scripts/incident-replay.mjs`,
a tool that turns incidents into rule drafts. No host, CLI verb or gate runs it, and its
responsibility has not been settled. Classifying a file is a review act: add it to
`classes` or `mixed` together with the reason.

`staleEntries` lists files the view names that no longer exist.

## Cost

There is no reliable measured baseline for run time, resources, repeated execution, or
maintenance burden. `costBaseline` therefore records each of them as `unknown`: not zero,
and not an estimate. The view claims no saving. The validator refuses any other value
until a real measurement exists.

## How it is meant to be used

The view supports the batch review D5 describes: new scope, duplicated mechanisms, real
resource overruns, or growth nobody can explain. A rising raw ratio shows where to look.
The view shows whether the growth came from tests, verification tooling, or the
workflow's own runtime code. Neither the ratio crossing a line nor a shift between
classes asks Owner for approval by itself.
