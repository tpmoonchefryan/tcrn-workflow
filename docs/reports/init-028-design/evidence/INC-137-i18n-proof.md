# INC-137 — translation reality and locale-key reachability

## Pre-repair red run

The strengthening gate was run against the original remediation worktree
before the locale/source repair. Command:

```text
node portal/scripts/i18n-proof.mjs
```

The original red output was:

```text
translation-reality: addedKeyCount=83; gaps=249
  ja 83/83 equal to en
  ko 83/83 equal to en
  fr 83/83 equal to en
key-reachability: unreachable=92
```

The 92 unreachable keys included the dead `receipt.*`, `chip.*`, legacy
`execution.*` and `reconcile.*` families, the old navigation labels, and
`setting.unknown.description`. The full key list is retained in the pre-fix
gate capture from the remediation run; the gate reports each key by name.

## Gate teeth mutation

After the repair, one Japanese value was temporarily changed to the English
string `Persona roles`. The unchanged proof then returned:

```json
{"ok":false,"reasonCode":"I18N_CONTRACT_VIOLATION","translationReality":{"ok":false,"reasonCode":"TRANSLATION_REALITY_GAP","gaps":[{"locale":"ja","key":"vocabulary.roles","reason":"matches-en","english":"Persona roles","exemption":null}]}}
```

The mutation was reverted before the green run. No exemption was added.

## Repaired green run (current source re-read)

```json
{"ok":true,"reasonCode":"I18N_CONTRACT_SATISFIED","legs":[{"leg":"contract-snapshot","ok":true,"reasonCode":"I18N_CONTRACT_SNAPSHOT_READY"},{"leg":"locale-set","ok":true,"reasonCode":"LOCALE_SET_MATCHES_CONTRACT"},{"leg":"key-coverage","ok":true,"reasonCode":"EVERY_KEY_TRANSLATED","keyCount":190,"localeCount":5,"expectedStrings":950,"gaps":[]},{"leg":"translation-reality","ok":true,"reasonCode":"TRANSLATIONS_DIFFER_FROM_ENGLISH","addedKeyCount":148,"gaps":[]},{"leg":"translation-full-table","ok":true,"reasonCode":"FULL_LOCALE_TABLE_TRANSLATED","problems":[]},{"leg":"key-reachability","ok":true,"reasonCode":"EVERY_LOCALE_KEY_REACHABLE","unreachable":[]},{"leg":"placeholders","ok":true,"reasonCode":"PLACEHOLDERS_CONSISTENT"},{"leg":"setting-descriptions","ok":true,"reasonCode":"EVERY_SETTING_DESCRIBED","undescribed":[],"orphaned":[]}]}
```

`portal/locales.js` now has one complete five-locale table with explicit
Japanese, Korean, French, and Simplified Chinese values for the remediation
copy. The current proof also checks the full-table policy and reports the
dynamic key families `setting.*`, `entities.field.*`, and `vocabulary.*` as
consumed by the corresponding engine-backed renderer in `portal/index.html`.
