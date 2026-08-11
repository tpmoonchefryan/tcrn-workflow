// SPDX-License-Identifier: Apache-2.0
//
// The locale contract, as this portal ships it.
//
// These values originate in the design system's `@tcrn/ui-copy-state`, which is
// their source of truth — but a source of truth is a development-time
// relationship, not a runtime dependency. The portal used to read that package's
// TypeScript source at request time and scrape it with regular expressions, which
// meant a distributed portal could not render a page unless the design-system
// repository happened to be checked out beside it. TCRN Workflow is an independent
// product: a person who clones the engine and the helper has no reason to hold the
// design system, and asking them to would be asking them to install a company's
// internal monorepo to open a settings page.
//
// So the contract is frozen here, exactly as `tokens.css` already freezes the token
// bytes. Drift is caught where it should be — on a machine that has both, by
// `scripts/i18n-proof.mjs` and `scripts/design-proof.mjs` — rather than by making
// every user carry the upstream.

export const LOCALE_CONTRACT = Object.freeze({
  supportedLocales: Object.freeze(["zh-CN", "en", "ja", "ko", "fr"]),
  localeMetadata: Object.freeze([
    Object.freeze({ locale: "zh-CN", nativeName: "简体中文" }),
    Object.freeze({ locale: "en", nativeName: "English" }),
    Object.freeze({ locale: "ja", nativeName: "日本語" }),
    Object.freeze({ locale: "ko", nativeName: "한국어" }),
    Object.freeze({ locale: "fr", nativeName: "Français" }),
  ]),
  defaultLocale: "en",
  fallbackLocale: "en",
});
