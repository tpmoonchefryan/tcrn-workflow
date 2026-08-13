# INC-142 — model-plan assignment UI

## Precondition

INC-136's current-state gate had already gone red before this repair. The
original browser probe found a backend `model-plan-assign` route but no
frontend assignment control, no active badge, and duplicate active-plan
controls.

## DOM proof

The live portal was booted from a scratch governed workspace. After creating
two plans, the selected plan's DOM returned:

```json
{"active":1,"addline":1,"receipt":"✓v2"}
```

The assignment addline contains a persona select populated from the persona
read surface, a model input, and the assignment action. Existing assignments
render with a `model-plan-unassign` action. Only the plan area renders the
active-plan control; the settings row remains the single source for selecting
the active plan.

The model-plan note now states the scope explicitly: the setting is read for
subagent dispatch and does not affect the primary session. Host options and
persona-role options are produced from `/api/vocabulary` and `/api/execution`,
not a second portal roster.

## Repair pointers and negative behavior

- `portal/index.html`: `data-ui="assignment-addline"`,
  `data-ui="plan-active-badge"`, assignment/unassignment controls, and
  vocabulary-backed options.
- `portal/portal.mjs`: the assignment, unassignment, and remove actions all
  go through the fresh-status/CAS CLI wrapper and return the engine reason
  code in the receipt surface.
- `portal/tests/portal.test.mjs`: real CLI plan creation, assignment, refusal
  while referenced, and readback.

The live DOM evidence is the UI proof; API tests are cited only for the write
boundary and reason-code behavior, not as proof that a control is visible.

The placement decision is already Owner-ratified in the source handover:
assignment is performed in the settings-page plan area and persona details
only read back the resolved model.
