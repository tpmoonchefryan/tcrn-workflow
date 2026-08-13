# INC-144 — shell, settings controls, prose, and command echo

## Precondition

INC-136 had already gone red. The verification report recorded the missing
partition switcher/engine plaque, hard-coded settings health, absent modified
dots/dictionary links, wrong control types, an unanimated 430px JSON drawer,
missing prose directory/gutter/finding links, stale shell geometry, and a
non-catalog command echo.

## Live DOM proof

The local browser DOM after boot returned:

```json
{"partitionSwitcher":1,"engineConnection":1,"paths":5,
 "receiptDrawer":1,"workspaceTabs":2}
```

The Execution settings page returned five rows, two numeric controls, four
enum/boolean controls, three dictionary links, and row-level modified-dot
nodes. The prose page, after loading a real scratch `AGENTS.md`, returned:

```json
{"directory":1,"findings":1,"gutterLines":5,
 "path":"/tmp/init028-dom.fUl6fO/prose/AGENTS.md",
 "reconcile":"1 findings"}
```

The finding link and directory entry focus the matching editor line. The
receipt drawer is a `role=dialog` with `aria-modal=true`, six labeled fields,
Escape close, a 400px tokenized surface, and transform/transition styling.
The shell uses the fixed `48px / content / 30px` grid and the management
`208px + 860px + gap` layout.

The echo after a write is assembled through the live `commands` catalog and
shows the short semantic form (`settings-set --key ... --value ...`). The
portal does not claim that this short form is a complete executable command.

## Implementation pointers

- `portal/index.html`: shell geometry, catalog-backed controls, modified/reset
  row tools, dictionary links, drawer labels, prose directory/gutter/finding
  nodes, and catalog-checked echo rendering.
- `portal/portal.mjs`: `/api/commands`, live settings catalog, partition
  readback, and explicit path containment.
- `packages/core/src/settings.ts`: `controlType`, enum/boolean values, and
  numeric min/max metadata consumed by the portal.
- `portal/scripts/design-proof.mjs` and `portal/tests/ui-presence.test.mjs`:
  design-system and component gates.

## Unresolved decision — proposal only

Current proposal: keep the echo short and human-readable (verb plus semantic
arguments), while exposing the catalog and keeping the full executable
prefix—workspace, expected version, timestamp, actor, and attestation path—in
the receipt/audit detail. The alternative is to render the complete CLI
invocation inline. **未裁，供 Owner 验收裁定。**
