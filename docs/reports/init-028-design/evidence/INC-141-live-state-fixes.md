# INC-141 — live state surfaces no longer lie

## Precondition and evidence level

INC-136 was written and run against the pre-repair portal first; its red run
listed 24 absent DOM components and found zero receipt-chip controls. This
incident was then repaired against that unchanged gate. The following is
local browser DOM evidence from the scratch portal at
`http://127.0.0.1:57355/`, backed by a real initialized CLI workspace. It is
not a production deployment claim.

## Four repaired behaviors and red-leg discipline

The four original failures were independently reproducible before repair:

1. `applyLocale()` replaced the receipt-chip container text and destroyed its
   child target; a real `SETTINGS_WRITE_COMMITTED` still left the chip at
   `no write yet`.
2. The chip had no click listener; clicking it left the drawer hidden.
3. Five search probes (`backup.cadence`, `Verity`, `gate-close`, `reviewer`,
   and `zzz-nonexistent`) all took the old English-substring dashboard route.
4. The dashboard rendered two fixed `health.ok` rows plus the boot actor,
   regardless of the engine result.

These are the four red legs recorded in the verification report. The repaired
DOM was then exercised through the same state changes, rather than proving the
claims with API response strings.

For the required repair-side red legs, each mutation was applied only long
enough to reload the local browser and was then reverted:

```json
{"mutation":"outer receipt chip receives data-i18n",
 "outerChildren":0,"childTarget":false,"chipText":"idle"}
{"mutation":"receipt chip click listener removed",
 "drawerOpen":"false","ariaHidden":"true"}
{"mutation":"search replaced by dashboard route",
 "query":"backup.cadence","visiblePage":"dashboard","results":0,"highlight":0}
{"mutation":"health checks replaced by three literal successes",
 "chip":"healthy","stat":"3/3","rows":["validateok","catalogok","actorok"]}
```

These browser outputs are the negative legs: the broken mutations visibly
lose the child target, fail to open the drawer, lose data-driven search, or
render the hard-coded all-green health state. The source was restored before
the green gates below.

## Live DOM readback

The repaired dashboard contains four cards, three health rows, and the real
path/receipt controls:

```json
{"tabs":2,"stats":4,"health":3,"paths":5,"receiptChip":1}
```

After a real governed settings write, the chip changed to its committed
receipt state. Clicking that chip opened the actual drawer:

```json
{"hidden":"false","open":"true","active":"drawer-close",
 "fields":["reason code","record","chain version","receipt digest","head event","actor"]}
```

The browser then searched the real `backup.cadence` key and pressed Enter; the
Settings page became visible and exactly one
`[data-setting-row="backup.cadence"]` received `.tcrn-highlight`. This proves
the route is data-driven. The DOM query also showed that an unknown query
produces no result route.

## Implementation pointers

- `portal/index.html`: receipt chip structure, click/Escape drawer handlers,
  live health rows, data-index search, and highlight navigation.
- `portal/portal.mjs`: `/api/status` reads CLI `status`, `validate`, the live
  settings catalog, and the last event; `currentProseRoot()` is partition
  local unless an explicit CLI root is supplied.
- `portal/tests/ui-presence.test.mjs`: unchanged static component gate and
  unique-chip contract.

## Unresolved decision — proposal only

Container prose defaults to the selected partition root's `AGENTS.md`; an
explicit `--prose-root` remains authoritative. This avoids silently targeting
the platform root. The alternative is container-root prose shared by all
partitions. **未裁，供 Owner 验收裁定。**
