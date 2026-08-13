// SPDX-License-Identifier: Apache-2.0
//
// The portal's copy is held to the checked-in locale contract snapshot in
// `portal/locale-contract.mjs`. The snapshot is the CI input; an upstream
// design-system comparison is a separate, Owner-scheduled synchronization
// concern. That separation keeps this gate meaningful in a clean checkout.
//
//   1. locale-set  — the portal's locales are exactly the contract's locales.
//   2. key-coverage — every key exists, non-empty, in every locale.
//   3. placeholders — a key's {placeholders} are identical across locales, so a
//      translation cannot silently drop the actor name out of a sentence.
//
// A missing translation is a defect now, not a gap to fill later. This script
// must never turn an absent external checkout into a successful skip.

import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALE_CONTRACT } from "../locale-contract.mjs";

const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const localeSourcePath = process.env.TCRN_PORTAL_LOCALES_SOURCE ?? join(portalRoot, "locales.js");
const policyPath = join(portalRoot, "i18n-policy.json");

function fail(reasonCode, detail) {
  process.stdout.write(`${JSON.stringify({ ok: false, reasonCode, ...detail }, null, 2)}\n`);
  process.exitCode = 1;
}

const contractLocales = [...LOCALE_CONTRACT.supportedLocales];
const fallbackLocale = LOCALE_CONTRACT.fallbackLocale;

// locales.js assigns onto `window`; give it one rather than importing a DOM.
function evaluateLocaleTable(source) {
  const sandbox = {};
  new Function("window", source)(sandbox);
  return sandbox.PORTAL_LOCALES;
}

const localeSource = await readFile(localeSourcePath, "utf8");
const table = evaluateLocaleTable(localeSource);
const policy = JSON.parse(await readFile(policyPath, "utf8"));

const portalLocales = Object.keys(table ?? {});
const placeholders = (value) => [...String(value).matchAll(/\{([a-zA-Z0-9_]+)\}/gu)].map((entry) => entry[1]).sort().join(",");

const legs = [];

// Leg 1 — the signed-in contract snapshot is present and structurally complete.
// The design-system upstream sync is deliberately not a CI prerequisite: the
// snapshot is the artifact a clean checkout can actually carry.
const contractMetadata = [...LOCALE_CONTRACT.localeMetadata];
const snapshotReady = contractLocales.length > 0
  && contractLocales.includes(fallbackLocale)
  && contractMetadata.length === contractLocales.length
  && contractMetadata.every((entry) => contractLocales.includes(entry.locale) && typeof entry.nativeName === "string" && entry.nativeName.length > 0);
legs.push({
  leg: "contract-snapshot",
  ok: snapshotReady,
  reasonCode: snapshotReady ? "I18N_CONTRACT_SNAPSHOT_READY" : "I18N_CONTRACT_SNAPSHOT_INVALID",
  source: "portal/locale-contract.mjs",
  contractLocales,
  fallbackLocale,
  contractMetadata,
});

// Leg 2 — locale set matches the contract exactly, in both directions.
const missingLocales = contractLocales.filter((locale) => !portalLocales.includes(locale));
const extraLocales = portalLocales.filter((locale) => !contractLocales.includes(locale));
legs.push({
  leg: "locale-set",
  ok: missingLocales.length === 0 && extraLocales.length === 0,
  reasonCode: missingLocales.length === 0 && extraLocales.length === 0 ? "LOCALE_SET_MATCHES_CONTRACT" : "LOCALE_SET_DIVERGED",
  contractLocales, portalLocales, missingLocales, extraLocales,
});

// Leg 2 — every key required in every locale, non-empty.
// The fallback locale is the reference: it is the one the contract says every
// other locale falls back to, so divergence is reported against it.
const reference = table?.[fallbackLocale] ? fallbackLocale : portalLocales[0];
const allKeys = [...new Set(Object.values(table ?? {}).flatMap((entry) => Object.keys(entry)))].sort();
const coverageGaps = [];
for (const locale of contractLocales) {
  const entries = table?.[locale] ?? {};
  for (const key of allKeys) {
    const value = entries[key];
    if (typeof value !== "string" || value.trim().length === 0) coverageGaps.push({ locale, key, reason: value === undefined ? "missing" : "empty" });
  }
}
legs.push({
  leg: "key-coverage",
  ok: coverageGaps.length === 0,
  reasonCode: coverageGaps.length === 0 ? "EVERY_KEY_TRANSLATED" : "TRANSLATION_MISSING",
  keyCount: allKeys.length,
  localeCount: contractLocales.length,
  expectedStrings: allKeys.length * contractLocales.length,
  gaps: coverageGaps,
});

// Leg 5 — a newly shipped key is not allowed to masquerade as a translation
// merely because it exists in every table.  The comparison basis is the last
// committed portal copy, so this leg reports the current batch's additions
// without maintaining a second hand-written key list.  Any deliberate English
// carry-over must be listed here with a reason and is visible in the report.
const TRANSLATION_REALITY_EXEMPTIONS = Object.freeze({});
let baselineKeys = [];
let baselineError = null;
try {
  const baselineSource = execFileSync("git", ["show", "HEAD:portal/locales.js"], { cwd: join(portalRoot, ".."), encoding: "utf8" });
  const baseline = evaluateLocaleTable(baselineSource);
  baselineKeys = [...new Set(Object.values(baseline ?? {}).flatMap((entry) => Object.keys(entry)))];
} catch (error) {
  baselineError = String(error?.message ?? error);
}
const addedKeys = allKeys.filter((key) => !baselineKeys.includes(key));
const realityGaps = [];
for (const locale of ["ja", "ko", "fr"]) {
  for (const key of addedKeys) {
    const english = table?.en?.[key];
    const translated = table?.[locale]?.[key];
    if (typeof english !== "string" || typeof translated !== "string" || english !== translated) continue;
    if (TRANSLATION_REALITY_EXEMPTIONS[key]) continue;
    realityGaps.push({ locale, key, reason: "matches-en", english, exemption: null });
  }
}
legs.push({
  leg: "translation-reality",
  ok: baselineError === null && realityGaps.length === 0,
  reasonCode: baselineError !== null ? "TRANSLATION_BASELINE_UNAVAILABLE" : realityGaps.length === 0 ? "TRANSLATIONS_DIFFER_FROM_ENGLISH" : "TRANSLATION_REALITY_GAP",
  baseline: "HEAD:portal/locales.js",
  addedKeyCount: addedKeys.length,
  exemptions: TRANSLATION_REALITY_EXEMPTIONS,
  gaps: realityGaps,
  ...(baselineError ? { error: baselineError } : {}),
});

// Leg 7 — the whole table is compared, not only keys added since HEAD. A
// spread-based locale can otherwise silently fall back to English when an old
// translation is deleted. The small waiver set is explicit, bounded, and
// reviewable; the checked-in baseline count records the pre-fix observation.
const fullTableProblems = [];
const fullTableReference = policy.referenceLocale ?? fallbackLocale;
const policyLocales = policy.locales ?? {};
for (const locale of contractLocales.filter((candidate) => candidate !== fullTableReference)) {
  const config = policyLocales[locale];
  const equalKeys = allKeys.filter((key) => table?.[locale]?.[key] === table?.[fullTableReference]?.[key]);
  if (!config || !Number.isSafeInteger(config.maxEnglishMatches) || !Array.isArray(config.waivers)) {
    fullTableProblems.push({ locale, reason: "policy-missing" });
    continue;
  }
  const unexpected = equalKeys.filter((key) => !config.waivers.includes(key));
  if (equalKeys.length > config.maxEnglishMatches || unexpected.length > 0) {
    fullTableProblems.push({
      locale,
      equalCount: equalKeys.length,
      maxEnglishMatches: config.maxEnglishMatches,
      equalKeys,
      unexpected,
      baselineEqualCount: policy.baselineEqualCount?.[locale] ?? null,
      waivers: config.waivers,
    });
  }
}
legs.push({
  leg: "translation-full-table",
  ok: fullTableProblems.length === 0,
  reasonCode: fullTableProblems.length === 0 ? "FULL_LOCALE_TABLE_TRANSLATED" : "FULL_LOCALE_TABLE_REALITY_GAP",
  policy: "portal/i18n-policy.json",
  baselineEqualCount: policy.baselineEqualCount ?? {},
  problems: fullTableProblems,
});

// Leg 6 — every shipped key must be reachable from the portal source.  The
// dynamic families below are explicit because their concrete key is assembled
// from engine data at runtime; each family also names the source marker that
// makes the dynamic access reviewable.  Unknown/unlisted keys remain red.
const sourceForReachability = `${await readFile(join(portalRoot, "index.html"), "utf8")}\n${await readFile(join(portalRoot, "portal.mjs"), "utf8")}`;
const literalReachable = new Set();
for (const match of sourceForReachability.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"|\bt\(\s*["']([^"']+)["']/gu)) literalReachable.add(match[1] ?? match[2]);
const dynamicFamilies = [
  { prefix: "entities.field.", marker: "t(`entities.field.", reason: "persona field names are assembled from the unified schema" },
  { prefix: "setting.", marker: "t(`setting.", reason: "setting labels/descriptions are assembled from the engine catalog" },
  { prefix: "vocabulary.", marker: "t(`vocabulary.", reason: "dictionary category labels are assembled from the vocabulary read surface" },
];
const dynamicReachable = [];
for (const family of dynamicFamilies) {
  if (!sourceForReachability.includes(family.marker)) continue;
  for (const key of allKeys.filter((candidate) => candidate.startsWith(family.prefix))) {
    if (key === "setting.unknown.description") continue;
    literalReachable.add(key);
    dynamicReachable.push({ key, ...family });
  }
}
const unreachableKeys = allKeys.filter((key) => !literalReachable.has(key));
legs.push({
  leg: "key-reachability",
  ok: unreachableKeys.length === 0,
  reasonCode: unreachableKeys.length === 0 ? "EVERY_LOCALE_KEY_REACHABLE" : "UNREACHABLE_LOCALE_KEYS",
  unreachable: unreachableKeys,
  dynamicFamilies,
  dynamicReachable,
});

// Leg 3 — placeholders identical across locales.
const placeholderGaps = [];
for (const key of allKeys) {
  const expected = placeholders(table?.[reference]?.[key] ?? "");
  for (const locale of contractLocales) {
    const value = table?.[locale]?.[key];
    if (typeof value !== "string") continue;
    const actual = placeholders(value);
    if (actual !== expected) placeholderGaps.push({ key, locale, expected, actual });
  }
}
legs.push({
  leg: "placeholders",
  ok: placeholderGaps.length === 0,
  reasonCode: placeholderGaps.length === 0 ? "PLACEHOLDERS_CONSISTENT" : "PLACEHOLDER_DIVERGED",
  reference,
  gaps: placeholderGaps,
});

// Leg 4 — every key the engine registers carries a description. This one asks
// the engine rather than a list, so a key added upstream turns the gate red
// here instead of surfacing to a user as a blank explanation.
const describedKeys = allKeys.filter((key) => key.startsWith("setting.") && key.endsWith(".description"))
  .map((key) => key.slice("setting.".length, -".description".length))
  .filter((key) => key !== "unknown");
let settingLeg;
try {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, rmSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const cli = process.env.TCRN_WORKFLOW_CLI ?? join(portalRoot, "..", "scripts", "tcrn-workflow.mjs");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "i18n-proof-")));
  try {
    const roots = {};
    for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
      const path = join(base, kind);
      mkdirSync(path);
      roots[kind] = realpathSync(path);
    }
    const run = (args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }));
    run(["init", "--workspace", roots.workspace, "--framework", roots.framework, "--transient", roots.transient,
      "--evidence-locator", roots["evidence-locator"], "--release-trust", roots["release-trust"],
      "--external-key", "TCRN-I18N-PROOF", "--at", "2026-01-01T00:00:00Z"]);
    const catalog = run(["settings-catalog", "--workspace", roots.workspace]).settings;
    const registered = catalog.map((entry) => entry.key);
    const undescribed = registered.filter((key) => !describedKeys.includes(key));
    const orphaned = describedKeys.filter((key) => !registered.includes(key));
    // INIT-026 S235: the portal leads with a human name, so every registered key
    // must carry a label in EVERY locale — a missing label falls back to the raw
    // key, which is exactly the state this batch exists to remove.
    const unlabeled = [];
    for (const key of registered) {
      for (const candidate of contractLocales) {
        if (typeof table?.[candidate]?.[`setting.${key}.label`] !== "string") unlabeled.push(`${candidate}:${key}`);
      }
    }
    const enumMissingAllowedValues = catalog
      .filter((entry) => entry.type === "enum" && (!Array.isArray(entry.allowedValues) || entry.allowedValues.length === 0))
      .map((entry) => entry.key);
    const ok = undescribed.length === 0 && orphaned.length === 0 && enumMissingAllowedValues.length === 0 && unlabeled.length === 0;
    settingLeg = {
      leg: "setting-descriptions",
      ok,
      reasonCode: enumMissingAllowedValues.length > 0
        ? "SETTING_ENUM_VALUES_GAP"
        : unlabeled.length > 0 ? "SETTING_LABEL_GAP"
        : ok ? "EVERY_SETTING_DESCRIBED" : "SETTING_DESCRIPTION_GAP",
      registered, describedKeys, undescribed, orphaned, enumMissingAllowedValues, unlabeled,
    };
  } finally { rmSync(base, { recursive: true, force: true }); }
} catch (error) {
  settingLeg = { leg: "setting-descriptions", ok: false, reasonCode: "SETTINGS_CATALOG_UNAVAILABLE", error: String(error?.message ?? error) };
}
legs.push(settingLeg);

const ok = legs.every((leg) => leg.ok);
process.stdout.write(`${JSON.stringify({
  ok,
  reasonCode: ok ? "I18N_CONTRACT_SATISFIED" : "I18N_CONTRACT_VIOLATION",
  legs,
}, null, 2)}\n`);
if (!ok) process.exitCode = 1;
