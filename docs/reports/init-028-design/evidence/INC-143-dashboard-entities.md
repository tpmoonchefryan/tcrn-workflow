# INC-143 — dashboard and entity management surfaces

## Precondition

The INC-136 DOM gate was red before repair. The original portal had no
workspace/entity tab rows, no four-card dashboard, no five path rows, and no
persona ghost/restore/model-readonly/delete-confirmation surfaces.

## Live DOM proof

The repaired dashboard DOM returned:

```json
{"workspaceTabs":2,"stats":4,"healthRows":3,"paths":5,
 "partitionSwitcher":1,"engineConnection":1}
```

After selecting the `Verity` preset and applying an override, the live entity
detail DOM returned:

```json
{"ghost":8,"modified":[{"hidden":false,"text":"Modified"}],
 "more":1,"nameLocks":2,"readonly":1,"restore":8}
```

The detail page has Persona and disabled Template tabs, custom/preset
sections, a locked preset name, a `details` disclosure for the additional
fields, factory ghost values with field-level restore actions, a modified
badge, and a confirmation popover before removal. The model read-only region
shows each host's explicit assignment, plan default, or host-default fallback
source.

## Implementation pointers

- `portal/index.html`: dashboard tab/card/path markup and the entity list/detail
  renderers, including `data-ui="persona-ghost"`,
  `data-ui="persona-restore-field"`, `data-ui="persona-model-readonly"`,
  `data-ui="persona-modified-badge"`, and
  `data-ui="persona-delete-confirm"`.
- `portal/portal.mjs` and core persona/model-plan read surfaces supply the
  factory, override, assignment, and health data consumed by those nodes.

The browser DOM queries above are the evidence for the UI verbs “展示” and
“支持”; engine/API tests remain separate evidence for persistence and
refusal semantics.
