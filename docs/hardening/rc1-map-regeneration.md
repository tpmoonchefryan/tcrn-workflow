# Proof-basis regeneration and change discipline (PRG-0)

This document is the standing procedure for the post-MVP hardening program. It
exists because the verification chain fails closed on any drift between a tracked
file and the digests that pin it, so every change that touches a pinned file must
regenerate the proof basis in the same change.

## Why regeneration is mandatory

Two fail-closed gates re-derive digests over tracked files on every run:

- `verify:map` recomputes an aggregate digest over each claim's `fixturePaths`
  and stops with `VERIFICATION_MAP_DIGEST_MISMATCH` on drift.
- `verify:rc1` / `verify:p2` re-derive the RC1 basis over the normative input set
  (`schemas/`, `specs/`, `fixtures/` outside `fixtures/rc1/`,
  `extensions/aos-requirements-v1.json`, `verification-map.yaml`) and stop with
  `RC1_MANIFEST_BASIS_DIGEST` (a byte changed) or `RC1_INPUT_SET_MISMATCH` (a file
  was added or removed) on drift.

Many hardening changes edit files pinned by 10-20 existing claims, so "regenerate
after editing" is not optional polish — it is the difference between a green and a
red tree.

## The two regeneration tools

- `pnpm regen:map-digests` — recomputes every claim's `fixtureDigest`, the RC1
  basis digest, and the source allowlist. This is the existing
  `generate:proof-artifacts` write pass under a plan-named alias. It is idempotent:
  a run on an unmodified tree rewrites nothing.
- `pnpm regen:rc1-inputs` — rewrites `scripts/policy/rc1-inputs.json` to the exact
  normative input set in canonical order. `regen:map-digests` does **not** touch
  this set, so run this whenever a normative file is **added or removed**. Pass
  `--check` for a non-mutating staleness probe.

## Procedure by change kind

1. **Edited an existing pinned file** (any file already tracked):
   `pnpm regen:map-digests`, then `pnpm verify:p1`.
2. **Edited a normative file's bytes** (a `schemas/`, `specs/`, `fixtures/` file,
   or `verification-map.yaml`): `pnpm regen:map-digests` (this refreshes the RC1
   basis too), then `pnpm verify:rc1 && pnpm verify:p2`.
3. **Added or removed a normative file**: `pnpm regen:rc1-inputs` **then**
   `pnpm regen:map-digests`, then `pnpm verify:rc1 && pnpm verify:p2`.
4. **Added any new source, test, or doc file**: first admit it to the bounded
   source set (below), then run step 1.

If a regeneration reports drift in a claim whose `fixturePaths` you did **not**
edit, stop and escalate — that is a tamper or tooling signal, never something to
re-pin blindly (governing handoff §2 trigger 3).

## New-file checklist (GAP-12)

Every new file under a scanned root (`scripts/`, `packages/`, `tests/`, `docs/`,
`schemas/`, `specs/`, `fixtures/`) must, in the same change:

1. Be admitted to the bounded source set. The generator computes the allowlist as
   `declared ∪ routeAdditions`; a new file that is in neither fails
   `PROOF_ARTIFACT_UNAPPROVED_SOURCE`. Add the new path to `routeAdditions` in
   `scripts/lib/proof-artifacts.mjs`, then `pnpm regen:map-digests` folds it into
   `scripts/policy/source-allowlist.json`.
2. If it is a normative file (schema/spec/fixture), run `pnpm regen:rc1-inputs`
   before `regen:map-digests`.
3. Carry workspace-relative paths only — no absolute user paths or hostnames — so
   the privacy gate stays green (governing handoff N-7).
4. Stage its one-line CHANGELOG contribution for the Stage 8 consolidated pass.

## Phase enum (ACT / BK)

`verify:map` admits the `ACT` (activation ladder) and `BK` (backup) phases in its
per-claim allowlist. Their entries in the phase-completeness loop (which asserts
every listed phase has at least one claim) and the `evidencePhase` mapping are
added **atomically with each phase's first claim** — a phase cannot be required to
be present before any claim of it exists. The first `BK` claim (WSF-2) and the
first `ACT` claim (WSG-2) each append their phase to the completeness loop and
`evidencePhase` in the same change that introduces the claim.

## Integration-branch discipline (GAP-11)

- One integration branch per stage (`hardening/stage-<n>`), branched from the
  prior stage's merged tip.
- Each stage's Owner decision batch (governing handoff §8) is signed and recorded
  before the stage begins (N-4).
- A fresh-context reviewer pass runs at each stage gate; the stage merges only
  after all gates are green (`verify:p1`, plus the stage's new suites).
- No stage rewrites a published ref or pushes; the Owner performs every tag and
  publication act (GD-1).
