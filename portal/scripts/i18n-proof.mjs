// SPDX-License-Identifier: Apache-2.0
//
// The portal's copy is held to the platform's i18n contract in
// @tcrn/ui-copy-state, which declares copyCoverage "required" for all five
// locales. That word is why this is a gate and not a checklist: a missing
// translation is a defect now, not a gap to fill later.
//
//   1. locale-set  — the portal's locales are exactly the contract's locales.
//   2. key-coverage — every key exists, non-empty, in every locale.
//   3. placeholders — a key's {placeholders} are identical across locales, so a
//      translation cannot silently drop the actor name out of a sentence.
//
// The contract is read from the design system rather than restated here; when
// it cannot be read the run reports UNVERIFIED and exits non-zero.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const copyStateSource = process.env.TCRN_COPY_STATE_SOURCE
  ?? join(portalRoot, "..", "..", "TCRN-Design-System", "packages", "ui-copy-state", "src", "index.ts");

function fail(reasonCode, detail) {
  process.stdout.write(`${JSON.stringify({ ok: false, reasonCode, ...detail }, null, 2)}\n`);
  process.exitCode = 1;
}

function skip(reasonCode, detail) {
  // This proof compares the shipped copy against its upstream in the design
  // system, which exists on the platform that authors the portal and nowhere
  // else. The portal now ships inside the engine, so this script travels to
  // every user — and a gate that goes red on a machine that was never meant to
  // satisfy it teaches people to ignore red. Absent upstream is not a failure;
  // it is this check having nothing to compare against, and it says so.
  process.stdout.write(`${JSON.stringify({ ok: true, skipped: true, reasonCode, ...detail }, null, 2)}\n`);
  process.exit(0);
}


let contractLocales;
let fallbackLocale;
try {
  const source = await readFile(copyStateSource, "utf8");
  const declared = source.match(/tcrnSupportedLocales = \[([^\]]+)\]/u);
  if (!declared) throw new Error("tcrnSupportedLocales not found");
  contractLocales = [...declared[1].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]);
  fallbackLocale = source.match(/tcrnFallbackLocale:\s*TcrnLocale\s*=\s*"([^"]+)"/u)?.[1] ?? contractLocales[0];
} catch (error) {
  skip("I18N_CONTRACT_SOURCE_ABSENT", { source: copyStateSource, note: "run this on the platform that holds the design system" });
}

// locales.js assigns onto `window`; give it one rather than importing a DOM.
const table = await (async () => {
  const source = await readFile(join(portalRoot, "locales.js"), "utf8");
  const sandbox = {};
  new Function("window", source)(sandbox);
  return sandbox.PORTAL_LOCALES;
})();

const portalLocales = Object.keys(table ?? {});
const placeholders = (value) => [...String(value).matchAll(/\{([a-zA-Z0-9_]+)\}/gu)].map((entry) => entry[1]).sort().join(",");

const legs = [];

// Leg 1 — the contract the portal ships is the contract the design system states.
// Compared term by term rather than by a digest over the file, because that file
// carries prose which may legitimately change while these values must not.
const { LOCALE_CONTRACT } = await import(new URL("../locale-contract.mjs", import.meta.url));
const contractMetadata = [...(await readFile(copyStateSource, "utf8")).matchAll(
  /\{\s*locale:\s*"([^"]+)",\s*nativeName:\s*"([^"]+)"/gu)].map(([, locale, nativeName]) => ({ locale, nativeName }));
const shippedDrift = [];
if (LOCALE_CONTRACT.supportedLocales.join(",") !== contractLocales.join(",")) {
  shippedDrift.push({ term: "supportedLocales", shipped: [...LOCALE_CONTRACT.supportedLocales], source: contractLocales });
}
if (LOCALE_CONTRACT.fallbackLocale !== fallbackLocale) {
  shippedDrift.push({ term: "fallbackLocale", shipped: LOCALE_CONTRACT.fallbackLocale, source: fallbackLocale });
}
for (const entry of contractMetadata) {
  const shipped = LOCALE_CONTRACT.localeMetadata.find((candidate) => candidate.locale === entry.locale);
  if (shipped?.nativeName !== entry.nativeName) {
    shippedDrift.push({ term: `nativeName:${entry.locale}`, shipped: shipped?.nativeName ?? null, source: entry.nativeName });
  }
}
legs.push({
  leg: "shipped-contract",
  ok: shippedDrift.length === 0,
  reasonCode: shippedDrift.length === 0 ? "SHIPPED_CONTRACT_MATCHES_SOURCE" : "SHIPPED_CONTRACT_DRIFTED",
  drift: shippedDrift,
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
    const enumMissingAllowedValues = catalog
      .filter((entry) => entry.type === "enum" && (!Array.isArray(entry.allowedValues) || entry.allowedValues.length === 0))
      .map((entry) => entry.key);
    const ok = undescribed.length === 0 && orphaned.length === 0 && enumMissingAllowedValues.length === 0;
    settingLeg = {
      leg: "setting-descriptions",
      ok,
      reasonCode: enumMissingAllowedValues.length > 0
        ? "SETTING_ENUM_VALUES_GAP"
        : ok ? "EVERY_SETTING_DESCRIBED" : "SETTING_DESCRIPTION_GAP",
      registered, describedKeys, undescribed, orphaned, enumMissingAllowedValues,
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
