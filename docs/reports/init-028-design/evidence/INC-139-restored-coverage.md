# INC-139 — restored current coverage and mutation red legs

## Restored cases

The named historical cases are present and runnable again:

- `portal/tests/portal.test.mjs`: the nine portal catalog, reconciliation,
  prose, locale, container, launcher, i18n, execution, and execution-card
  cases.
- `tests/s232-execution-config.test.mjs`: S232 owner/integrity/clear cases,
  S233 policy catalog, and both S234 independence-floor cases.
- `tests/s238-persona-store.test.mjs`: both S238 custom-persona cases.

They were adapted to the surviving model-plan and unified-persona institutions;
the guarded behavior was not removed or waived.

## Mutation evidence

Each mutation below was applied temporarily, the named restored case was run,
and the mutation was reverted before the green run.

1. `settings.ts`: removed `review-only` from the policy allowed-values list.
   `S233: the two policy keys are in the catalog with their closed value sets`
   went red with the deep-equal diff showing the missing `review-only` value.

2. `conference.ts`: made `independenceFloorCovers("verification", ...)`
   return false. `S234: a covered close without the declaration refuses; with
   it, the minutes carry the form` went red because the required refusal no
   longer occurred. The default-floor S234 case remained green, showing the
   mutation was targeted.

3. `persona-store.ts`: held a custom persona update at revision 1. The
   restored S238 CRUD case went red with `1 !== 2` at its update-revision
   assertion.

4. `portal/portal.mjs`: dropped the first entry from the live settings read.
   `portal serves live catalog, commits a governed write, and refuses an
   untokened one` went red at the portal/engine catalog deep comparison.

5. The restored i18n portal case uses a real CLI shim that removes
   `allowedValues`; it went red at `SETTING_ENUM_VALUES_GAP` and is now green
   with the shim removed.

All temporary mutations were reverted and the final build was regenerated.
