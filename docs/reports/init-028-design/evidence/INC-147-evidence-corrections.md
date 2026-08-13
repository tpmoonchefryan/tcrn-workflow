# INC-147 — evidence corrections and named test files

## Corrections made

The eight original Story evidence files were reviewed sentence by sentence
against the implementation and the new DOM evidence. The acceptance packet
now contains an explicit first-round correction table. Claims that previously
said “支持/展示/实现” without a matching node or behavior are either mapped
to a selector and live browser readback, or labeled `未实现/未证`.

The four scope-named test files now exist and run:

```text
tests/s244-model-plan.test.mjs
tests/s245-subagent-plan-keys.test.mjs
tests/s246-persona-overlay.test.mjs
tests/s247-vocabulary.test.mjs
```

The command below was run after a fresh build:

```text
pnpm build && node --test tests/s244-model-plan.test.mjs \
  tests/s245-subagent-plan-keys.test.mjs \
  tests/s246-persona-overlay.test.mjs \
  tests/s247-vocabulary.test.mjs
BUILD_VERIFIED; 8 tests, 8 pass, 0 fail
```

The correction rule is now explicit: a UI verb must point to live DOM evidence
and an implementation selector/handler; API/static tests are supporting
evidence only.

The final supporting closeout reads `pnpm s219:teaching-audit` as
`HELPER_TEACHING_CONTRACT_GREEN` (12 catalog keys) and the helper contract test
as 1 pass. This is local helper-worktree evidence; c40 archive/re-pin/release
was not performed.

## Owner boundaries

No Story or Incident was marked `done`. Browser evidence is local scratch
evidence, not production deployment or external-account proof. Release
0.11.15, helper c40, push/tag/deploy, and the three unresolved decisions stay
parked for Owner judgment.
