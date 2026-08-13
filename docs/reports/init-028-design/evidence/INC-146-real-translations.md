# INC-146 — real ja/ko/fr translations

## Precondition

INC-137's translation-reality gate was red before repair: the current portal
had 83 newly added keys equal to English in each of ja/ko/fr, for 249 gaps;
the same gate found 92 unreachable keys. A temporary single-key ja mutation
also made that gate red, proving the comparison is not a count-only shortcut.

## Green readback (current source re-read)

The unchanged i18n proof now reports:

```json
{"ok":true,"reasonCode":"I18N_CONTRACT_SATISFIED","legs":[
 {"leg":"contract-snapshot","ok":true,"reasonCode":"I18N_CONTRACT_SNAPSHOT_READY"},
 {"leg":"locale-set","ok":true,"reasonCode":"LOCALE_SET_MATCHES_CONTRACT"},
 {"leg":"key-coverage","ok":true,"reasonCode":"EVERY_KEY_TRANSLATED","keyCount":190,"localeCount":5,"expectedStrings":950,"gaps":[]},
 {"leg":"translation-reality","ok":true,"reasonCode":"TRANSLATIONS_DIFFER_FROM_ENGLISH","addedKeyCount":148,"gaps":[]},
 {"leg":"translation-full-table","ok":true,"reasonCode":"FULL_LOCALE_TABLE_TRANSLATED","problems":[]},
 {"leg":"key-reachability","ok":true,"reasonCode":"EVERY_LOCALE_KEY_REACHABLE","unreachable":[]},
 {"leg":"placeholders","ok":true,"reasonCode":"PLACEHOLDERS_CONSISTENT"},
 {"leg":"setting-descriptions","ok":true,"reasonCode":"EVERY_SETTING_DESCRIBED","undescribed":[],"orphaned":[]}
]}
```

`portal/locales.js` contains explicit ja/ko/fr values for the new settings,
model-plan, persona, vocabulary, receipt, health, and prose keys. The proof
compares the locale values against the shipped baseline and checks dynamic
key families, so API output or an English `innerHTML` substring is not being
used as translation evidence.

No unresolved language-term exemption was needed; the five locale contract,
full-table policy, and all added keys are green. Vocabulary semantic
localization is tracked separately in INC-150 because its source-of-truth
choice remains an Owner decision.
