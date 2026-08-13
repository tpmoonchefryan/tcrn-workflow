# INC-138 — coverage conservation gate

## Pre-repair red run

The gate was run before restoring any of the deleted coverage:

```text
node scripts/coverage-conservation.mjs
```

It returned `COVERAGE_CONSERVATION_VIOLATION` with these exact problem rows:

```json
[
  {"path":"portal/tests/portal.test.mjs","baseline":{"testCount":9,"assertionCount":92},"current":{"testCount":4,"assertionCount":40},"assertionLoss":52},
  {"path":"tests/s232-execution-config.test.mjs","baseline":{"testCount":6,"assertionCount":26},"current":{"testCount":2,"assertionCount":17},"assertionLoss":9},
  {"path":"tests/s238-persona-store.test.mjs","baseline":{"testCount":2,"assertionCount":23},"current":{"testCount":2,"assertionCount":25},"assertionLoss":0}
]
```

The unwaived names were the nine portal cases, the six S232/S233/S234 cases,
and the two S238 cases listed in the command's full JSON output. No waiver was
used to hide this red state.

## Repaired green run

The deleted named coverage was restored/adapted to the current model-plan,
persona-overlay, portal, and prose read surfaces. The unchanged conservation
gate now returns:

```json
{"ok":true,"problems":[]}
```

The restored portal file now contains 13 tests (the four current tests plus
the nine named historical cases); the two engine files contain eight and four
tests respectively. The restored cases exercise the live institutions rather
than only preserving names.

## Gate self-mutation

The gate's own test constructs a temporary deletion and verifies red, then
adds a precise waiver and verifies green. Command:

```text
node --test tests/coverage-conservation.test.mjs
```

This is a test of the measuring instrument, not a waiver for the restored
coverage.
