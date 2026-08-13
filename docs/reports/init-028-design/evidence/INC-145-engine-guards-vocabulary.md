# INC-145 — engine declarations and mutation guards

## Pre-repair red

The verification report ran six compiled mutations. Four were green before
this repair: M1 unknown host, M3 65-character plan name, M4 129-character
default model, and M6 removal of a referenced plan. The vocabulary was also
only a shallow literal surface, and `MODEL_PLAN_HOST_UNKNOWN` did not list the
legal hosts. These are the pre-repair red legs retained in the evidence; the
repair did not weaken their criteria.

## Green guard evidence

Named tests now exercise the four guard families and the additional persona
conflict path:

```text
node --test tests/s244-model-plan.test.mjs \
  tests/s245-subagent-plan-keys.test.mjs \
  tests/s246-persona-overlay.test.mjs \
  tests/s247-vocabulary.test.mjs
8 tests, 8 pass, 0 fail
```

The tests are compiled against the current `dist/build` after `pnpm build`.
They assert `MODEL_PLAN_HOST_UNKNOWN`, the 64/128 bounds, `MODEL_PLAN_IN_USE`,
`PERSONA_NAME_CONFLICT`, and `PERSONA_PRESET_IN_USE` with no state advance.
The unknown-host message includes both `claude-code` and `codex`.

The vocabulary read surface now derives roles and their semantic metadata from
`PERSONA_ROLE_DEFINITIONS`, hosts from `MODEL_PLAN_HOSTS`, conference coverage
from `independenceFloorCovers`, execution forms from the conference constants,
and setting terms from `SETTINGS_CATALOG`. It preserves type/default/control
metadata and names the two model-plan sources.

## P2 cleanup

`model-plan-list --host` now rejects an unknown host; the retired public
execution-config write/read family returns `CLI_COMMAND_UNKNOWN`; custom
persona input no longer forwards `description`/`prompt` into the public v2
write; and plan/preset refusal messages include release guidance.

## Unresolved decisions — proposals only

- Legacy `execution-config`: proposal A is explicit public deprecation, with
  replay-only compatibility retained and a clear `CLI_COMMAND_UNKNOWN` route;
  migration or read-only presentation remain Owner alternatives. **未裁。**
- `reviewOnlyDispatchable`: current implementation proposal is one core
  `PERSONA_ROLE_DEFINITIONS` table, with vocabulary deriving from it; the
  alternative is derivation from role plus policy. **未裁。**

The helper c40 teaching/archive/re-pin and release remain parked as required;
no helper release claim is made here.
