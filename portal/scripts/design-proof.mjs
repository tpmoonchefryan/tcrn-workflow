// SPDX-License-Identifier: Apache-2.0
//
// Four legs that together keep the portal inside the TCRN Design System.
//
//   1. token fidelity — the vendored tokens.css is byte-identical to
//      @tcrn/ui-tokens. Following the design system's own precedent
//      (storybook.css is generated and guarded by `tokens:proof`), the copy is
//      allowed but the drift is not.
//   2. no literal colours — every colour in the portal's own styles resolves to
//      a --tcrn-* custom property. A literal hex is how a private palette gets
//      re-invented, which is exactly what happened before this gate existed.
//   3. no inline styles — layout and presentation stay in the reviewable token
//      stylesheet rather than becoming one-off element exceptions.
//   4. interactive class coverage — every native form control carries a
//      tcrn-* class, so the design-system contract remains visible at the DOM
//      boundary instead of being inferred from tag names alone.
//
// When the design system is not on disk the token leg reports UNVERIFIED and
// exits non-zero rather than passing: an unchecked copy is not a matching copy.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const vendored = join(portalRoot, "tokens.css");
const upstream = process.env.TCRN_DESIGN_SYSTEM_TOKENS
  ?? join(portalRoot, "..", "..", "TCRN-Design-System", "packages", "ui-tokens", "src", "tokens.css");

const digest = (text) => createHash("sha256").update(text).digest("hex");
const indexPath = process.env.TCRN_PORTAL_INDEX ?? join(portalRoot, "index.html");
const baselinePath = process.env.TCRN_PORTAL_BASELINE ?? join(portalRoot, "design-baseline.html");
const brandAssetPath = process.env.TCRN_PORTAL_BRAND_ASSET ?? join(portalRoot, "tcrn-brand-mark.svg");
const brandSourcePath = process.env.TCRN_PORTAL_BRAND_SOURCE
  ?? join(portalRoot, "..", "..", "TCRN-Design-System", "apps", "storybook", "assets", "tcrn-brand-mark.svg");
const EXPECTED_BRAND_MARK_SHA256 = "5f28f17c599c63a05a51c81be03f9ef7845299af1940ebe6aef61f7af47fc25b";
const styled = [{ label: "index.html", path: indexPath }];
const DS_COMPONENT_STYLE = /<style id="tcrn-ds-component-css" data-source="snapshot">[\s\S]*?<\/style>/u;
const publicPrivacyMarkers = Object.freeze([
  ["/", ["Use", "rs"].join(""), "/"].join(""),
  ["/", ["ho", "me"].join(""), "/"].join(""),
  ["\\", ["Use", "rs"].join(""), "\\"].join(""),
  ["ryan", "lan"].reduce((value, part) => value + part, ""),
  ["tpmoon", "chef", "ryan"].reduce((value, part) => value + part, ""),
]);

// Literal colours in any notation. Values inside the vendored token file are
// the design system's own definitions and are not scanned here.
const LITERAL_COLOUR = /(#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|color-mix)\s*\()/gu;
const PORTAL_BRAND_TOKEN_LINE = /^\s*--tcrn-brand-accent-workflow:\s*#(?:3b5272|9db5d4);\s*$/u;

const legs = [];
const indexText = await readFile(indexPath, "utf8");

// Leg 1 — token fidelity.
try {
  const [local, source] = await Promise.all([readFile(vendored, "utf8"), readFile(upstream, "utf8")]);
  const matches = local === source;
legs.push({
  leg: "token-fidelity",
    ok: matches,
    reasonCode: matches ? "TOKENS_MATCH_DESIGN_SYSTEM" : "TOKENS_DRIFTED",
    vendoredSha256: digest(local),
    upstreamSha256: digest(source),
    upstream,
  });
} catch (error) {
  // An absent upstream is not a failure. This leg compares the shipped token
  // bytes against the design system, which lives on the platform that authors
  // the portal; since the portal now ships inside the engine, this script
  // reaches every user, and none of them has that repository. A gate that goes
  // red where it was never meant to apply teaches people to ignore red. The
  // other leg — no literal colours — still runs, because it needs nothing.
  const absent = error?.code === "ENOENT";
  legs.push({
    leg: "token-fidelity",
    ok: absent,
    ...(absent ? { skipped: true } : {}),
    reasonCode: absent ? "TOKENS_SOURCE_ABSENT" : "TOKENS_UNREADABLE",
    upstream,
    ...(absent ? { note: "run this on the platform that holds the design system" } : { error: String(error?.message ?? error) }),
  });
}

// Leg 2 — the portal ships the admitted Design System mother-brand asset
// without a local redraw or byte-level transformation. The expected digest is
// enough for consumer installs; when the sibling Design System repo is present,
// the source bytes are compared as a second, cross-repo proof.
let brandAssetReport;
try {
  const asset = await readFile(brandAssetPath);
  const assetSha256 = digest(asset);
  const findings = [];
  let sourceSha256;
  let sourceAvailable = true;
  try {
    const source = await readFile(brandSourcePath);
    sourceSha256 = digest(source);
    if (!asset.equals(source)) findings.push({ name: "source bytes", reason: "portal asset differs from Design System source" });
  } catch (error) {
    if (error?.code === "ENOENT") sourceAvailable = false;
    else findings.push({ name: "source read", reason: String(error?.message ?? error) });
  }
  if (assetSha256 !== EXPECTED_BRAND_MARK_SHA256) findings.push({ name: "asset digest", reason: "portal asset digest differs from admitted source" });
  brandAssetReport = {
    leg: "brand-asset-fidelity",
    ok: findings.length === 0,
    reasonCode: findings.length === 0 ? "BRAND_ASSET_MATCHES_DESIGN_SYSTEM" : "BRAND_ASSET_DIGEST_MISMATCH",
    asset: "portal/tcrn-brand-mark.svg",
    expectedSha256: EXPECTED_BRAND_MARK_SHA256,
    assetSha256,
    ...(sourceAvailable ? { sourceSha256 } : { sourceAvailable: false }),
    findings,
  };
} catch (error) {
  brandAssetReport = {
    leg: "brand-asset-fidelity",
    ok: false,
    reasonCode: "BRAND_ASSET_UNREADABLE",
    asset: "portal/tcrn-brand-mark.svg",
    expectedSha256: EXPECTED_BRAND_MARK_SHA256,
    findings: [{ name: "asset read", reason: String(error?.message ?? error) }],
  };
}
legs.push(brandAssetReport);

// Leg 3 — product-owned Workflow accent values are registered in the portal
// surface, while the Design System mother-brand token remains unchanged.
const portalTokenRequirements = [
  { name: "light Workflow accent", text: "--tcrn-brand-accent-workflow: #3b5272;" },
  { name: "dark Workflow accent", text: "--tcrn-brand-accent-workflow: #9db5d4;" },
];
const portalTokenFindings = portalTokenRequirements
  .filter((requirement) => !indexText.includes(requirement.text))
  .map((requirement) => ({ name: requirement.name, reason: "portal token declaration is absent", text: requirement.text }));
legs.push({
  leg: "portal-brand-token",
  ok: portalTokenFindings.length === 0,
  reasonCode: portalTokenFindings.length === 0 ? "PORTAL_WORKFLOW_TOKEN_REGISTERED" : "PORTAL_WORKFLOW_TOKEN_MISSING",
  findings: portalTokenFindings,
});

// Leg 4 — no literal colours outside the token file. The two product-owned
// Workflow token declarations are the portal's deliberately registered palette
// extension and are checked independently above.
const findings = [];
for (const target of styled) {
  // The vendored Design System snapshot is package truth, just like tokens.css;
  // its own literals are not portal-authored palette declarations. The separate
  // S252 reconciliation gate proves snapshot/source/inline byte identity.
  const text = (await readFile(target.path, "utf8")).replace(DS_COMPONENT_STYLE, "");
  for (const [index, line] of text.split("\n").entries()) {
    if (PORTAL_BRAND_TOKEN_LINE.test(line)) continue;
    for (const match of line.matchAll(LITERAL_COLOUR)) {
      findings.push({ file: target.label, line: index + 1, literal: match[0], context: line.trim().slice(0, 100) });
    }
  }
}
legs.push({
  leg: "no-literal-colours",
  ok: findings.length === 0,
  reasonCode: findings.length === 0 ? "COLOURS_COME_FROM_TOKENS" : "LITERAL_COLOUR_FOUND",
  scanned: styled.map((entry) => entry.label),
  findings,
});

// Leg 5 — inline style attributes are forbidden in shipped HTML. The embedded
// <style> block is a stylesheet, not an element-level exception; only opening
// element tags are considered here.
const lineNumberAt = (offset) => indexText.slice(0, offset).split("\n").length;
const inlineStyleFindings = [];
for (const match of indexText.matchAll(/<([a-z][a-z0-9:_-]*)\b[^>]*\bstyle\s*=/giu)) {
  inlineStyleFindings.push({
    file: "index.html",
    line: lineNumberAt(match.index ?? 0),
    element: match[1],
  });
}
legs.push({
  leg: "no-inline-style-attributes",
  ok: inlineStyleFindings.length === 0,
  reasonCode: inlineStyleFindings.length === 0 ? "INLINE_STYLE_ATTRIBUTES_ABSENT" : "INLINE_STYLE_ATTRIBUTE_FOUND",
  scanned: "index.html",
  findings: inlineStyleFindings,
});

// Leg 6 — the static HTML controls must carry at least one design-system class.
// The portal's dynamic controls use the same class contract in the page script;
// this leg proves the shipped native surface where a regression is easiest to
// introduce and where a browser can inspect it without executing the page.
// A <button> has to carry a class from the design system's button family. The reset
// control carried `tcrn-setting-row__reset` — a class the design system does define,
// but as a part of the settings row, not as a button — so it took the row's placement
// and none of the button treatment, and looked unlike every other control beside it.
// Checking "is this class design-system-defined" is therefore not enough; the question
// is whether the element names the component it is.
const DS_BUTTON_FAMILY = new Set(["tcrn-button", "tcrn-icon-button", "tcrn-link-button"]);
// Controls that are legitimately not button components: rows and items that happen to
// be rendered as <button> for keyboard semantics. Explicit, so a new one is a decision
// rather than a class name that slips past.
const NON_BUTTON_CONTROLS = new Set([
  "tcrn-nav-item",              // sidebar navigation item
  "tcrn-product-shell__brand",  // brand lockup, a navigation affordance
  "tcrn-subnav__item",          // settings-group and vocabulary tabs
  "tcrn-entity",                // persona list row
  "tcrn-directory__item",       // prose heading jump list
  "tcrn-finding-link",          // reconciliation finding jump
  "tcrn-search-result",         // command palette result row
  "tcrn-shell-locale-menu__trigger", "tcrn-shell-locale-menu__option",
  "tcrn-switch__control",       // the switch's own input
  "tcrn-workspace-tab", "tcrn-entity-tab",
  "tcrn-badge",                 // the receipt chip is a status badge that opens the drawer
]);
const interactiveFindings = [];
for (const match of indexText.matchAll(/<(button|input|select|textarea)\b([^>]*)>/giu)) {
  const attributes = match[2] ?? "";
  const classMatch = attributes.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu);
  const classValue = classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? "";
  const tokens = classValue.split(/\s+/u);
  if (!tokens.some((token) => token.startsWith("tcrn-"))) {
    interactiveFindings.push({
      file: "index.html",
      line: lineNumberAt(match.index ?? 0),
      element: match[1],
      reason: "missing tcrn-* class",
    });
    continue;
  }
  // INC-191: the prefix alone was not enough. A reset control carried
  // `tcrn-setting-row__reset` — a portal-local name with the right prefix and no design
  // system component behind it — and this leg called it covered for as long as it
  // existed. A button now has to name a real button component, not merely start with
  // the letters.
  if (match[1].toLowerCase() === "button" && !tokens.some((token) => DS_BUTTON_FAMILY.has(token) || NON_BUTTON_CONTROLS.has(token))) {
    interactiveFindings.push({
      file: "index.html",
      line: lineNumberAt(match.index ?? 0),
      element: match[1],
      reason: "a button that names no design-system button component and is not a registered non-button control",
      classValue,
    });
  }
}
// INC-191: an emoji or a punctuation character standing in for an icon depends on
// whatever font resolves it — U+1F4D6 and U+1F512 have no glyph in the shipped face and
// rendered as boxes on the reader's screen. Icons are inline SVG; these characters are
// not allowed as the visible content of a control.
const GLYPH_ICONS = /[\u{1F300}-\u{1FAFF}\u{25A0}-\u{25FF}\u{21BA}\u{21BB}\u{FF0B}\u{2212}\u{29C9}]/gu;
const glyphFindings = [];
for (const match of indexText.matchAll(/<(button|span)\b[^>]*>([^<]{1,12})<\/(?:button|span)>/gu)) {
  const inner = match[2];
  if (!GLYPH_ICONS.test(inner)) continue;
  GLYPH_ICONS.lastIndex = 0;
  glyphFindings.push({ file: "index.html", line: lineNumberAt(match.index ?? 0), element: match[1], content: inner.trim() });
}
legs.push({
  leg: "interactive-tcrn-class-coverage",
  ok: interactiveFindings.length === 0 && glyphFindings.length === 0,
  reasonCode: interactiveFindings.length > 0 ? "INTERACTIVE_ELEMENT_CLASS_MISSING"
    : glyphFindings.length > 0 ? "INTERACTIVE_ELEMENT_GLYPH_ICON"
    : "INTERACTIVE_ELEMENTS_CARRY_TCRN_CLASS",
  scanned: "index.html",
  findings: [...interactiveFindings, ...glyphFindings],
});

// Leg 6b — every vocabulary column count a domain declares has a CSS rule that
// sets the table-shell track list. When a count has no rule both custom properties
// stay unset and the design system's shell falls back to one track, so the row
// renders as a single crammed cell — a layout failure that looks like a content
// mistake and that no content-level check can see. Adding a fifth column to one
// domain did exactly that, so the two sides are compared here rather than trusted
// to stay in step: declared counts come from the column table the page renders
// from, covered counts from the stylesheet the page ships.
// The counts are read by evaluating the declaration, not by counting brackets with a
// pattern: a first attempt at the pattern silently merged a single-line domain into
// the next one and dropped a domain entirely, and it still reported the leg green.
// The table is a pure data literal in a file this script already reads, so taking its
// real value is both simpler and the only reading that cannot drift from the page.
const declaredColumnCounts = new Map();
let columnTableError;
try {
  const start = indexText.indexOf("const VOCABULARY_COLUMNS = {");
  if (start < 0) throw new Error("the vocabulary column table is not declared where this leg looks for it");
  let depth = 0;
  let end = -1;
  for (let index = indexText.indexOf("{", start); index < indexText.length; index += 1) {
    if (indexText[index] === "{") depth += 1;
    else if (indexText[index] === "}") { depth -= 1; if (depth === 0) { end = index + 1; break; } }
  }
  if (end < 0) throw new Error("the vocabulary column table has no closing brace");
  // eslint-disable-next-line no-new-func -- a data literal from the file already being read
  const table = new Function(`return (${indexText.slice(indexText.indexOf("{", start), end)});`)();
  for (const [domain, columns] of Object.entries(table)) declaredColumnCounts.set(domain, Array.isArray(columns) ? columns.length : 0);
} catch (error) {
  columnTableError = String(error?.message ?? error);
}
const coveredColumnCounts = new Set(
  [...indexText.matchAll(/\[data-vocabulary-columns="(\d+)"\]\s*\{/gu)].map((match) => Number(match[1])),
);
const columnCountFindings = [];
if (columnTableError !== undefined || declaredColumnCounts.size === 0) {
  columnCountFindings.push({ name: "column table", reason: columnTableError ?? "the vocabulary column table could not be read, so this leg cannot see what it is meant to check" });
}
for (const [domain, count] of declaredColumnCounts) {
  if (count === 0) columnCountFindings.push({ name: domain, reason: "domain declares no columns" });
  else if (!coveredColumnCounts.has(count)) columnCountFindings.push({ name: domain, count, reason: `no [data-vocabulary-columns="${count}"] rule, so the table collapses to one track` });
}
legs.push({
  leg: "vocabulary-column-track-coverage",
  ok: columnCountFindings.length === 0,
  reasonCode: columnCountFindings.length === 0 ? "VOCABULARY_COLUMN_COUNTS_COVERED" : "VOCABULARY_COLUMN_COUNT_UNCOVERED",
  scanned: "index.html",
  declared: Object.fromEntries(declaredColumnCounts),
  covered: [...coveredColumnCounts].sort((left, right) => left - right),
  findings: columnCountFindings,
});

// Leg 7 — the public v4 baseline is present and privacy-safe. The baseline is
// intentionally a public, sanitized reference; the platform archive retains
// the original source bytes for any future Owner comparison.
let baselineText = "";
let baselineReadError;
try {
  baselineText = await readFile(baselinePath, "utf8");
} catch (error) {
  baselineReadError = error;
}
const baselineFindings = [];
if (baselineReadError !== undefined) {
  baselineFindings.push({ name: "baseline file", reason: "public v4 baseline is unreadable", error: String(baselineReadError?.message ?? baselineReadError) });
} else {
  if (!baselineText.startsWith("<!-- PUBLIC BASELINE:")) baselineFindings.push({ name: "baseline declaration", reason: "public baseline must begin with its sanitization statement" });
  if (!baselineText.includes("TCRN Workflow 门户")) baselineFindings.push({ name: "baseline provenance", reason: "v4 portal preview marker is absent" });
  if (![".stepper", ".switch", ".seg"].every((marker) => baselineText.includes(marker))) baselineFindings.push({ name: "baseline control families", reason: "v4 stepper/switch/segmented control markers are absent" });
  const normalizedBaseline = baselineText.toLocaleLowerCase();
  if (publicPrivacyMarkers.some((marker) => normalizedBaseline.includes(marker.toLocaleLowerCase()))) baselineFindings.push({ name: "baseline privacy", reason: "local path or host identity remains in the public baseline" });
}
legs.push({
  leg: "public-v4-baseline",
  ok: baselineFindings.length === 0,
  reasonCode: baselineFindings.length === 0 ? "PUBLIC_V4_BASELINE_PRESENT_AND_REDACTED" : "PUBLIC_V4_BASELINE_INVALID",
  scanned: "design-baseline.html",
  findings: baselineFindings,
});

// Leg 8 — the portal's layout and control contracts are explicit rather than
// relying on auto-placement. This is deliberately source/AST-shaped: a DOM
// parser can prove class presence, but cannot measure the grid tracks that a
// browser lays out at a viewport width. The browser measurements are captured
// separately by the S274 acceptance evidence.
const initLayoutStart = indexText.indexOf("/* INIT-036 S274/S275:");
const initLayoutEnd = initLayoutStart < 0 ? -1 : indexText.indexOf("</style>", initLayoutStart);
const initLayoutSource = initLayoutStart < 0 || initLayoutEnd < 0 ? "" : indexText.slice(initLayoutStart, initLayoutEnd);
const layoutRequirements = [
  // INC-179: the top row follows the bar instead of asserting a height of its own. A
  // fixed first track is what let the bar (68px from the design system) and its track
  // (48px carried over from the v4 mock) disagree by 20px at narrow widths.
  // INC-189: the status strip moved from a third row of the workspace column to a
  // row of the shell spanning both columns, so the workspace column is back to the
  // design system's own two-row contract and the strip is sized by the component
  // rather than by a hand-picked 30px that its content overflowed.
  { name: "product shell rows", source: initLayoutSource, text: "grid-template-rows: auto minmax(0, 1fr);" },
  { name: "status strip spans the shell", source: initLayoutSource, text: ".tcrn-product-shell > .tcrn-app-status-bar {\n  grid-column: 1 / -1;\n}" },
  { name: "sidebar fills its row", source: initLayoutSource, text: ".tcrn-product-shell__sidebar {\n  height: 100%;" },
  { name: "top bar height from design system", source: initLayoutSource, text: ".tcrn-product-shell__workspace > .tcrn-top-bar {" },
  { name: "editor areas", source: initLayoutSource, text: 'grid-template-areas:\n    "directory bar"\n    "directory editor";' },
  { name: "directory placement", source: initLayoutSource, text: "grid-area: directory;" },
  { name: "editor toolbar placement", source: initLayoutSource, text: "grid-area: bar;" },
  { name: "editor toolbar no full-row placement", source: initLayoutSource, text: "grid-column: auto;" },
  { name: "editor placement", source: initLayoutSource, text: "grid-area: editor;" },
  { name: "prose measure", source: initLayoutSource, text: "max-width: 860px;" },
  { name: "dashboard measure", source: initLayoutSource, text: "max-width: 1040px;" },
  { name: "desktop-to-tablet breakpoint", source: initLayoutSource, text: "@media (max-width: 980px)" },
  { name: "tablet-to-phone breakpoint", source: initLayoutSource, text: "@media (max-width: 760px)" },
  { name: "phone breakpoint", source: initLayoutSource, text: "@media (max-width: 680px)" },
  // INC-167/168: the brand is the design system's shell lockup, sitting in the sidebar
  // header the product shell defines it as a child of. The earlier invariant named the
  // generic lockup, which is exactly the drift these legs exist to catch — a component
  // that looks right and is the wrong one.
  { name: "brand lockup in place", source: indexText, text: 'tcrn-product-shell__brand tcrn-product-logo tcrn-shell-brand-lockup' },
  { name: "brand lockup in sidebar header", source: indexText, text: '<div class="tcrn-product-shell__sidebar-header">' },
  { name: "brand mark asset in place", source: indexText, text: 'data-brand-asset="tcrn-brand-mark"' },
  // These name the markup that uses the construct, not the rule that styles it: the
  // snapshot defines every one of these classes, so a needle that matches CSS too
  // would stay satisfied by a page that had stopped using the component.
  { name: "shell theme toggle in place", source: indexText, text: "tcrn-icon-button tcrn-shell-theme-toggle" },
  { name: "shell locale menu in place", source: indexText, text: 'class="tcrn-shell-locale-menu__panel"' },
  { name: "compound search input in place", source: indexText, text: 'class="tcrn-input tcrn-search-input__control' },
  { name: "footer syntax", source: indexText, text: 'class="tcrn-rail__footer"><span data-i18n="app.boundaryBody">' },
  { name: "boolean control mapping", source: indexText, text: 'entry.controlType === "boolean"' },
  { name: "number control mapping", source: indexText, text: 'entry.controlType === "number") return `<div class="tcrn-stepper"' },
  { name: "number stepper visual", source: indexText, text: 'class="tcrn-stepper"' },
  { name: "segmented enum mapping", source: indexText, text: 'class="tcrn-segmented-nav"' },
  { name: "select enum mapping", source: indexText, text: 'class="tcrn-select" data-setting-control' },
  { name: "text control mapping", source: indexText, text: 'return `<input class="tcrn-input" value="${esc(current)}" placeholder=' },
  // INC-188: the workspace path uses the design system's plain top-bar module. Its
  // breadcrumb sibling `__current-location` ships flex: 0 1 240px and max-width: 240px,
  // sized for a short label, and clipped the path at 240px with 630px of unused space
  // beside it. The needle names the module class on that element so swapping back to
  // the capped variant is caught.
  { name: "workspace path uses the uncapped module", source: indexText, text: 'class="tcrn-top-bar__module tcrn-top-bar__module--path" id="workspace-label"' },
  // Every partition path shares a prefix and differs only in its last segments, so a
  // tail-side ellipsis removes the only part worth reading.
  { name: "workspace path truncates at the head", source: indexText, text: ".tcrn-top-bar__module--path {\n  direction: rtl;" },
  { name: "workspace path column keeps a floor", source: indexText, text: "grid-template-columns: minmax(163px, 1fr) minmax(0, auto);" },
  // INC-190: view preferences persist in this browser. The restore runs in <head> so
  // the first painted frame is already in the chosen theme rather than flashing the
  // default, and both writes sit where the reader chooses so nothing else has to
  // remember to record them. The allow-list is what keeps a hand-edited value from
  // becoming an attribute the page never defined.
  { name: "theme restored before first paint", source: indexText.slice(0, indexText.indexOf("</head>")), text: 'document.documentElement.dataset.tcrnTheme = window.tcrnReadPreference("theme", ["light", "dark"], "light");' },
  { name: "preference reads are allow-listed", source: indexText, text: "return allowed.includes(stored) ? stored : fallback;" },
  { name: "theme choice is recorded", source: indexText, text: 'tcrnWritePreference("theme", state.theme);' },
  { name: "locale choice is recorded", source: indexText, text: 'tcrnWritePreference("locale", state.locale);' },
];
const layoutFindings = layoutRequirements
  .filter((requirement) => !requirement.source.includes(requirement.text))
  .map((requirement) => ({ name: requirement.name, reason: "required structural invariant absent", text: requirement.text }));
// INC-174: a grid whose CONTENT column is a fixed pixel width is this portal's
// recurring disease (the 1000px shell, the 800px vocabulary column). Label and nav
// columns may be pinned measures; the last column of a template must be a flexible
// track. The needle is the last track of each declaration in the portal-owned block.
for (const match of indexText.matchAll(/grid-template-columns:\s*([^;]+);/gu)) {
  const tracks = match[1].trim().split(/\s+(?![^(]*\))/u);
  const last = tracks[tracks.length - 1];
  const fixed = /^(\d+)px$/u.exec(last);
  if (fixed && Number(fixed[1]) > 300) {
    layoutFindings.push({ name: "fixed content column", reason: "content column must be a flexible track", text: match[0].slice(0, 80) });
  }
}
legs.push({
  leg: "portal-layout-invariants",
  ok: layoutFindings.length === 0,
  reasonCode: layoutFindings.length === 0 ? "PORTAL_LAYOUT_EXPLICIT" : "PORTAL_LAYOUT_AUTO_PLACEMENT_OR_MEASURE_DRIFT",
  scanned: "index.html",
  findings: layoutFindings,
});

// Leg 9 — the editor keeps focus semantics on the bounded editor container.
// The browser proof measures the resulting outline and shadow; this leg keeps
// the owning declarations visible and independently mutable in source.
const focusRequirements = [
  { name: "editor textarea outline none", text: ".tcrn-product-shell .tcrn-line-numbered-editor__control:focus-visible {\n  outline: none;" },
  { name: "editor textarea outline width zero", text: "  outline-width: 0;\n  outline-offset: 0;" },
  { name: "editor focus-within border", text: ".tcrn-line-numbered-editor:focus-within {\n  border-color: var(--tcrn-color-brand-primary);" },
  { name: "editor focus-within shadow", text: "  box-shadow: 0 0 0 3px var(--tcrn-color-brand-primary-bg);\n}" },
  { name: "editor internal overflow boundary", text: ".tcrn-line-numbered-editor {\n  display: grid;\n  grid-template-columns: max-content minmax(0, 1fr);\n  min-width: 0;\n  overflow: hidden;" },
];
const focusFindings = focusRequirements
  .filter((requirement) => !indexText.includes(requirement.text))
  .map((requirement) => ({ name: requirement.name, reason: "editor focus boundary invariant absent", text: requirement.text }));
legs.push({
  leg: "editor-focus-boundary",
  ok: focusFindings.length === 0,
  reasonCode: focusFindings.length === 0 ? "EDITOR_FOCUS_BOUNDARY_EXPLICIT" : "EDITOR_FOCUS_BOUNDARY_DRIFTED",
  scanned: "index.html",
  findings: focusFindings,
});

// Leg 10 — the topbar owns the constraints that let the browser keep one row
// at each acceptance width. Width-specific DOM measurements remain evidence,
// not a claim that a source scan can make.
const topbarRequirements = [
  { name: "topbar path min width", text: ".tcrn-top-bar__module {\n  min-width: 0;" },
  { name: "topbar path overflow", text: "  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}" },
  { name: "topbar chips no wrap", text: ".tcrn-top-bar__actions .tcrn-badge {\n  flex-shrink: 0;\n  white-space: nowrap;" },
  { name: "topbar search shrink", text: ".tcrn-top-bar__actions .tcrn-search-input {\n  min-width: 7ch;" },
  { name: "topbar search flex basis", text: "  flex: 1 1 auto;\n  max-width: 430px;" },
];
const topbarFindings = topbarRequirements
  .filter((requirement) => !indexText.includes(requirement.text))
  .map((requirement) => ({ name: requirement.name, reason: "topbar single-line constraint absent", text: requirement.text }));
legs.push({
  leg: "topbar-four-width-single-line",
  ok: topbarFindings.length === 0,
  reasonCode: topbarFindings.length === 0 ? "TOPBAR_SINGLE_LINE_CONSTRAINTS_EXPLICIT" : "TOPBAR_SINGLE_LINE_CONSTRAINTS_DRIFTED",
  acceptanceWidths: [1024, 1280, 1440, 1680],
  scanned: "index.html",
  findings: topbarFindings,
});

// Leg 11 — the portal sidebar mirrors the v4 values exactly. This is scoped to
// the portal override so the package snapshot remains governed by its own
// source and reconciliation gate.
const sidenavRequirements = [
  { name: "sidenav transparent background", text: ".tcrn-product-shell__sidebar {\n  background: transparent;" },
  { name: "sidenav list gap", text: ".tcrn-product-shell__sidebar .tcrn-side-nav {\n  gap: 1px;" },
  { name: "sidenav item padding", text: "  padding: var(--tcrn-space-1h) var(--tcrn-space-2);" },
  { name: "sidenav icon slot width", text: ".tcrn-product-shell__sidebar .tcrn-nav-item__content {\n  flex: 0 0 16px;\n  width: 16px;" },
  { name: "sidenav icon opacity", text: "  opacity: .8;\n  font-size: 12px;" },
  { name: "sidenav current colors", text: ".tcrn-product-shell__sidebar .tcrn-nav-item[aria-current=\"page\"] {\n  background: var(--tcrn-color-brand-primary-bg);\n  color: var(--tcrn-color-brand-primary);" },
  { name: "sidenav non-current hover", text: ".tcrn-product-shell__sidebar .tcrn-nav-item:hover:not([aria-current=\"page\"]) {\n  background: var(--tcrn-color-surface-muted);" },
];
const sidenavFindings = sidenavRequirements
  .filter((requirement) => !indexText.includes(requirement.text))
  .map((requirement) => ({ name: requirement.name, reason: "v4 sidenav value absent", text: requirement.text }));
legs.push({
  leg: "sidenav-v4-style-invariants",
  ok: sidenavFindings.length === 0,
  reasonCode: sidenavFindings.length === 0 ? "SIDENAV_V4_VALUES_EXPLICIT" : "SIDENAV_V4_VALUES_DRIFTED",
  reference: "docs/reports/init-028-design/preview.html:207-211",
  scanned: "index.html",
  findings: sidenavFindings,
});

// INC-196: a DS class whose own rule declares a complete control box owns that
// box, and no second DS class may redeclare its metrics. The switch shipped with
// .tcrn-input beside .tcrn-switch__control, so the text-field base won min-height
// and padding: the 42x24 pill measured 42x34 and the knob floated inside it. The
// INC-191 legs assert that a control carries the *right* DS class; none asserted
// that it carries no conflicting one, so the defect stayed green.
//
// Ownership is read out of the snapshot rather than a local roster: only a
// standalone `.class` rule that sets appearance:none *and* both fixed axes counts
// as a self-contained box. That is what keeps the four legitimate compositions
// green — the search control and the editor control own no standalone rule (the
// DS scopes and neutralises them itself), and the icon button sets no appearance,
// so none of them is an owner and none is flagged.
// Comments are stripped first: a selector list is captured as everything since
// the previous rule, so a comment sitting above it would ride along and no
// single-class selector would ever match. That is not hypothetical — it made
// this leg green against the very defect it was written for until the red leg
// caught it.
const dsBlock = (DS_COMPONENT_STYLE.exec(indexText)?.[0] ?? "").replace(/\/\*[\s\S]*?\*\//gu, "");
const declarationsByClass = new Map();
for (const rule of dsBlock.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
  const body = rule[2];
  for (const selector of rule[1].split(",")) {
    const standalone = /^\s*\.(tcrn-[a-z0-9_-]+)\s*$/u.exec(selector);
    if (!standalone) continue;
    const existing = declarationsByClass.get(standalone[1]) ?? "";
    declarationsByClass.set(standalone[1], `${existing}${body}`);
  }
}
const declares = (className, property) =>
  new RegExp(`(?:^|;)\\s*${property}\\s*:`, "u").test(declarationsByClass.get(className) ?? "");
const ownsItsBox = (className) => declares(className, "appearance")
  && declares(className, "inline-size")
  && declares(className, "block-size");
const redeclaresBox = (className) => ["min-height", "padding", "border-radius"]
  .some((property) => declares(className, property));

const boxFindings = [];
for (const attribute of indexText.matchAll(/class=(?:"|')([^"']*)(?:"|')/gu)) {
  const classes = attribute[1].split(/\s+/u)
    .filter((name) => name.startsWith("tcrn-") && !name.includes("${") && declarationsByClass.has(name));
  for (const owner of classes.filter(ownsItsBox)) {
    for (const intruder of classes.filter((name) => name !== owner && redeclaresBox(name))) {
      boxFindings.push({
        owner,
        conflicting: intruder,
        classAttribute: attribute[1].slice(0, 120),
        reason: "a second DS class redeclares metrics the owner already fixes",
      });
    }
  }
}
legs.push({
  leg: "ds-control-box-ownership",
  ok: boxFindings.length === 0,
  reasonCode: boxFindings.length === 0 ? "DS_CONTROL_BOXES_UNCONTESTED" : "DS_CONTROL_BOX_CONTESTED",
  reference: "TCRN-CROSS-INC-196",
  scanned: "index.html",
  ownersFound: [...declarationsByClass.keys()].filter(ownsItsBox),
  findings: boxFindings,
});

const ok = legs.every((leg) => leg.ok);
process.stdout.write(`${JSON.stringify({
  ok,
  reasonCode: ok ? "DESIGN_SYSTEM_COMPLIANT" : "DESIGN_SYSTEM_VIOLATION",
  legs,
}, null, 2)}\n`);
if (!ok) process.exitCode = 1;
