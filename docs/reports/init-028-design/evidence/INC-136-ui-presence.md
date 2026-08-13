# INC-136 — portal UI presence and receipt DOM proof

## Scope and gate discipline

This evidence implements the EPIC-080 / INC-136 scope. The gate was added and
run against the pre-repair portal before relying on any repaired markup. Its
selectors and failure rules were then kept unchanged while the portal was
repaired. Static HTML checks are only the presence gate; the UI claims below
use live DOM queries and interactions.

## Pre-repair red run

Command:

```text
node --test portal/tests/ui-presence.test.mjs
```

The first run was intentionally red. It reported 24 absent DOM components:

```text
workspace overview/audit tabs
entity Persona/template tabs
persona custom/preset sections
persona override dot
persona locked name hint
persona more-fields disclosure
persona factory ghost
persona single-field restore
persona model read-only area
persona modified badge
delete confirmation
prose directory
prose line-number gutter
prose finding link
assignment addline
active plan badge
workspace paths
path copy control
partition switcher
engine connection
setting modified dot
setting dictionary link
receipt chip
receipt drawer
```

The second pre-repair assertion also red with `receipt chip unique DOM control
count 0 (expected 1)`. This was the required current-state red proof; it was
not manufactured by changing the implementation after the gate was written.

## Repaired gate

The unchanged gate now passes:

```text
✔ INC-136 DOM contract names every preview component
✔ INC-136 receipt chip contract has a live target and drawer trigger
tests 2, pass 2, fail 0
```

## Live DOM proof

Target: local scratch portal at `http://127.0.0.1:57355/`, backed by a real
initialized CLI workspace at `/tmp/init028-dom.fUl6fO/workspace`. This is a
local harness proof, not a production deployment claim.

Dashboard DOM query after boot:

```json
{"chipText":"idle","engineConnection":1,"healthRows":3,"partitionSwitcher":1,"paths":5,"receiptChip":1,"receiptDrawer":1,"workspaceTabs":2}
```

Settings DOM after selecting the Execution group:

```json
{"rows":5,"controls":7,"modifiedDots":[{"hidden":true,"key":"execution.independenceFloor"},{"hidden":true,"key":"execution.maxConcurrentSubagents"},{"hidden":true,"key":"execution.maxDispatchDepth"},{"hidden":true,"key":"execution.personalessDispatch"},{"hidden":true,"key":"execution.subagentPolicy"}],"dictionaryLinks":3,"numeric":2,"enumControls":4}
```

After creating `dom-proof` for `claude-code` and selecting it as the active
plan, the live DOM returned:

```json
{"active":1,"addline":1,"receipt":"✓v2"}
```

After selecting the `Verity` preset, the detail DOM returned:

```json
{"ghost":8,"modified":[{"hidden":false,"text":"Modified"}],"more":1,"nameLocks":2,"readonly":1,"restore":8}
```

The receipt write was opened through the actual chip click, not by inspecting
HTML text. The live drawer state and its six labeled fields were:

```json
{"hidden":"false","open":"true","active":"drawer-close"}
```

While open, the live drawer had `role="dialog"`, `aria-modal="true"`, and
these six DOM labels:

```json
{"fields":["reason code","record","chain version","receipt digest","head event","actor"]}
```

The implementation also binds Escape to the same close transition.

Prose page after saving a real file containing one registered and one
unregistered key:

```json
{"directory":1,"findings":1,"gutterLines":5,"page":true,"path":"/tmp/init028-dom.fUl6fO/prose/AGENTS.md","reconcile":"1 findings"}
```

Vocabulary page DOM:

```json
{"categories":5,"first":"orchestrator","page":true,"terms":6,"version":"tcrn.vocabulary.v1"}
```

Search was exercised with `backup.cadence`; pressing Enter made the Settings
page visible and added one `.tcrn-highlight` to the exact
`data-setting-row="backup.cadence"`. The result list contained two real data
matches, proving the route is data-driven rather than an English substring
page switch.

## Implementation pointers

- `portal/tests/ui-presence.test.mjs` is the named DOM gate and uses parsed
  DOM nodes/selectors rather than `innerHTML.includes`.
- `portal/index.html` owns the live tabs, paths, persona sections/detail
  controls, model-plan assignment, setting controls, prose directory/gutter,
  and receipt drawer.
- `portal/portal.mjs` supplies the live status, command catalog, partition
  readback, and engine-backed write receipts consumed by those surfaces.
