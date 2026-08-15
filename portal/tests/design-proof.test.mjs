// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const indexPath = new URL("../index.html", import.meta.url);
const proofPath = fileURLToPath(new URL("../scripts/design-proof.mjs", import.meta.url));
const coverageProofPath = fileURLToPath(new URL("../../scripts/s278-component-coverage.mjs", import.meta.url));

async function runProof(path, extraEnv = {}) {
  try {
    const result = await execFileAsync(process.execPath, [proofPath], {
      encoding: "utf8",
      env: { ...process.env, TCRN_PORTAL_INDEX: path, ...extraEnv },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { status: 0, report: JSON.parse(result.stdout) };
  } catch (error) {
    return { status: error.code, report: JSON.parse(String(error.stdout ?? "{}")) };
  }
}

async function runCoverageProof(path, extraEnv = {}) {
  try {
    const result = await execFileAsync(process.execPath, [coverageProofPath], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, TCRN_PORTAL_INDEX: path, ...extraEnv },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { status: 0, report: JSON.parse(result.stdout) };
  } catch (error) {
    return { status: error.code, report: JSON.parse(String(error.stdout ?? "{}")) };
  }
}

test("INIT-036 S276 design-proof legs turn red for injected violations and green after restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tcrn-design-proof-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(indexPath, "utf8");
  const baseline = join(directory, "baseline.html");
  await writeFile(baseline, source, "utf8");

  const green = await runProof(baseline);
  assert.equal(green.status, 0);
  assert.equal(green.report.legs.find((leg) => leg.leg === "brand-asset-fidelity").ok, true);
  assert.equal(green.report.legs.find((leg) => leg.leg === "editor-focus-boundary").ok, true);
  assert.equal(green.report.legs.find((leg) => leg.leg === "topbar-four-width-single-line").ok, true);
  assert.equal(green.report.legs.find((leg) => leg.leg === "sidenav-v4-style-invariants").ok, true);
  assert.equal(green.report.legs.find((leg) => leg.leg === "no-inline-style-attributes").ok, true);
  assert.equal(green.report.legs.find((leg) => leg.leg === "interactive-tcrn-class-coverage").ok, true);
  assert.equal(green.report.legs.find((leg) => leg.leg === "ds-control-box-ownership").ok, true);

  // INC-196: the switch shipped carrying .tcrn-input beside .tcrn-switch__control,
  // so the text-field base won min-height and padding and the 42x24 pill rendered
  // 42x34. Re-injecting that second class is the red direction. The leg is green
  // for the compositions the DS itself reconciles — search control, textarea
  // editor, brand lockup, icon button — which the green assertion above covers.
  const contestedBox = join(directory, "contested-control-box.html");
  await writeFile(
    contestedBox,
    source.replace('<input class="tcrn-switch__control" type="checkbox" role="switch"', '<input class="tcrn-switch__control tcrn-input" type="checkbox" role="switch"'),
    "utf8",
  );
  const redBox = await runProof(contestedBox);
  assert.notEqual(redBox.status, 0);
  const contestedLeg = redBox.report.legs.find((leg) => leg.leg === "ds-control-box-ownership");
  assert.equal(contestedLeg.reasonCode, "DS_CONTROL_BOX_CONTESTED");
  assert.ok(contestedLeg.findings.some((finding) => finding.owner === "tcrn-switch__control"
    && finding.conflicting === "tcrn-input"));

  const styled = join(directory, "inline-style.html");
  await writeFile(styled, source.replace('<main class="tcrn-product-shell__main tcrn-main" id="main-content">', '<main class="tcrn-product-shell__main tcrn-main" id="main-content" style="display:block">'), "utf8");
  const redStyle = await runProof(styled);
  assert.notEqual(redStyle.status, 0);
  assert.equal(redStyle.report.legs.find((leg) => leg.leg === "no-inline-style-attributes").reasonCode, "INLINE_STYLE_ATTRIBUTE_FOUND");

  const unclassed = join(directory, "unclassed-control.html");
  await writeFile(unclassed, source.replace('<button class="tcrn-nav-item"', "<button"), "utf8");
  const redClass = await runProof(unclassed);
  assert.notEqual(redClass.status, 0);
  assert.equal(redClass.report.legs.find((leg) => leg.leg === "interactive-tcrn-class-coverage").reasonCode, "INTERACTIVE_ELEMENT_CLASS_MISSING");

  const restored = await runProof(baseline);
  assert.equal(restored.status, 0);
  assert.equal(restored.report.legs.find((leg) => leg.leg === "portal-layout-invariants").ok, true);

  const autoPlaced = join(directory, "auto-placed-editor.html");
  await writeFile(autoPlaced, source.replace('grid-template-areas:\n    "directory bar"\n    "directory editor";', ""), "utf8");
  const redLayout = await runProof(autoPlaced);
  assert.notEqual(redLayout.status, 0);
  assert.equal(redLayout.report.legs.find((leg) => leg.leg === "portal-layout-invariants").reasonCode, "PORTAL_LAYOUT_AUTO_PLACEMENT_OR_MEASURE_DRIFT");

  const restoredLayout = await runProof(baseline);
  assert.equal(restoredLayout.status, 0);

  const sourceAsset = await readFile(new URL("../tcrn-brand-mark.svg", import.meta.url));
  const mutatedAsset = Buffer.from(sourceAsset);
  mutatedAsset[mutatedAsset.length - 1] = mutatedAsset[mutatedAsset.length - 1] === 0x0a ? 0x20 : 0x0a;
  const mutatedAssetPath = join(directory, "brand-mark-mutated.svg");
  await writeFile(mutatedAssetPath, mutatedAsset);
  const redBrand = await runProof(baseline, { TCRN_PORTAL_BRAND_ASSET: mutatedAssetPath });
  assert.notEqual(redBrand.status, 0);
  assert.equal(redBrand.report.legs.find((leg) => leg.leg === "brand-asset-fidelity").reasonCode, "BRAND_ASSET_DIGEST_MISMATCH");
  assert.equal((await runProof(baseline)).report.legs.find((leg) => leg.leg === "brand-asset-fidelity").ok, true);

  const focusOutlineMutated = join(directory, "focus-outline-mutated.html");
  await writeFile(focusOutlineMutated, source.replace("  outline: none;\n  outline-width: 0;\n  outline-offset: 0;", "  outline: 3px solid var(--tcrn-color-focus-ring);\n  outline-width: 3px;\n  outline-offset: 0;"), "utf8");
  const redFocus = await runProof(focusOutlineMutated);
  assert.notEqual(redFocus.status, 0);
  assert.equal(redFocus.report.legs.find((leg) => leg.leg === "editor-focus-boundary").reasonCode, "EDITOR_FOCUS_BOUNDARY_DRIFTED");
  assert.ok(redFocus.report.legs.find((leg) => leg.leg === "editor-focus-boundary").findings.some((finding) => finding.name === "editor textarea outline none"));
  assert.equal((await runProof(baseline)).report.legs.find((leg) => leg.leg === "editor-focus-boundary").ok, true);

  const topbarMutated = join(directory, "topbar-search-mutated.html");
  await writeFile(topbarMutated, source.replace("  max-width: 430px;\n}\n.tcrn-product-shell__sidebar", "  max-width: 431px;\n}\n.tcrn-product-shell__sidebar"), "utf8");
  const redTopbar = await runProof(topbarMutated);
  assert.notEqual(redTopbar.status, 0);
  assert.equal(redTopbar.report.legs.find((leg) => leg.leg === "topbar-four-width-single-line").reasonCode, "TOPBAR_SINGLE_LINE_CONSTRAINTS_DRIFTED");
  assert.ok(redTopbar.report.legs.find((leg) => leg.leg === "topbar-four-width-single-line").findings.some((finding) => finding.name === "topbar search flex basis"));
  assert.equal((await runProof(baseline)).report.legs.find((leg) => leg.leg === "topbar-four-width-single-line").ok, true);

  const sidenavMutated = join(directory, "sidenav-background-mutated.html");
  await writeFile(sidenavMutated, source.replace(".tcrn-product-shell__sidebar {\n  background: transparent;", ".tcrn-product-shell__sidebar {\n  background: var(--tcrn-color-surface-panel);"), "utf8");
  const redSidenav = await runProof(sidenavMutated);
  assert.notEqual(redSidenav.status, 0);
  assert.equal(redSidenav.report.legs.find((leg) => leg.leg === "sidenav-v4-style-invariants").reasonCode, "SIDENAV_V4_VALUES_DRIFTED");
  assert.ok(redSidenav.report.legs.find((leg) => leg.leg === "sidenav-v4-style-invariants").findings.some((finding) => finding.name === "sidenav transparent background"));
  assert.equal((await runProof(baseline)).report.legs.find((leg) => leg.leg === "sidenav-v4-style-invariants").ok, true);

  const layoutMutations = [
    ["product shell rows", "grid-template-rows: auto minmax(0, 1fr);", "grid-template-rows: 48px minmax(0, 1fr);"],
    ["top bar height from design system", ".tcrn-product-shell__workspace > .tcrn-top-bar {", ".tcrn-product-shell__workspace > .tcrn-top-bar-mutated {"],
    ["prose measure", "max-width: 860px;", "max-width: 861px;"],
    ["dashboard measure", "max-width: 1040px;", "max-width: 1041px;"],
    ["desktop-to-tablet breakpoint", "@media (max-width: 980px)", "@media (max-width: 981px)"],
    ["tablet-to-phone breakpoint", "@media (max-width: 760px)", "@media (max-width: 761px)"],
    ["phone breakpoint", "@media (max-width: 680px)", "@media (max-width: 681px)"],
    ["brand lockup in place", "tcrn-product-shell__brand tcrn-product-logo tcrn-shell-brand-lockup", "tcrn-product-shell__brand tcrn-product-logo tcrn-brandlockupmutated"],
    ["brand lockup in sidebar header", '<div class="tcrn-product-shell__sidebar-header">', '<div class="tcrn-product-shell__sidebar-header-mutated">'],
    // INC-168: each selection-level invariant carries its own mutation. Swapping the
    // shell control back for the generic part it replaced is exactly the drift that
    // passed every gate before, so it has to be the thing that turns one red.
    // The mutation has to break the needle, not extend it: appending a suffix leaves the
    // original string present as a prefix and the invariant still finds it.
    ["shell theme toggle in place", "tcrn-icon-button tcrn-shell-theme-toggle", "tcrn-icon-button tcrn-shell-themetoggle"],
    ["shell locale menu in place", 'class="tcrn-shell-locale-menu__panel"', 'class="tcrn-shell-locale-menu__pane"'],
    ["compound search input in place", 'class="tcrn-input tcrn-search-input__control', 'class="tcrn-input tcrn-search-input__ctrl'],
    ["brand mark asset in place", 'data-brand-asset="tcrn-brand-mark"', 'data-brand-asset="tcrn-brand-mark-mutated"'],
    ["footer syntax", 'class="tcrn-rail__footer"><span data-i18n="app.boundaryBody">', 'class="tcrn-rail__footer"><span data-i18n="app.boundaryBody-mutated">'],
    ["boolean control mapping", 'entry.controlType === "boolean"', 'entry.controlType === "boolean-mutated"'],
    ["number control mapping", 'entry.controlType === "number") return `<div class="tcrn-stepper"', 'entry.controlType === "number-mutated"'],
    ["number stepper visual", 'class="tcrn-stepper"', 'class="tcrn-stepper-mutated"'],
    ["segmented enum mapping", 'class="tcrn-segmented-nav"', 'class="tcrn-segmented-nav-mutated"'],
    ["select enum mapping", 'class="tcrn-select" data-setting-control', 'class="tcrn-select-mutated" data-setting-control'],
    ["text control mapping", 'return `<input class="tcrn-input" value="${esc(current)}" placeholder=', 'return `<input class="tcrn-input" value="${esc(current)}" placeholder-mutated='],
    // INC-174: pinning a content column to a fixed width is the recurring layout
    // disease; the leg must go red the moment one reappears.
    ["fixed content column", "grid-template-columns: 208px minmax(0, 860px);", "grid-template-columns: 208px 800px;"],
  ];
  const initScopedMutations = new Set(["product shell rows", "top bar height from design system", "prose measure", "dashboard measure", "desktop-to-tablet breakpoint", "tablet-to-phone breakpoint", "phone breakpoint"]);
  const initStart = source.indexOf("/* INIT-036 S274/S275:");
  const initEnd = source.indexOf("</style>", initStart);
  assert.ok(initStart >= 0 && initEnd > initStart, "INIT-036 style block must be present");
  for (const [name, needle, replacement] of layoutMutations) {
    assert.ok(source.includes(needle), `${name} mutation anchor must exist`);
    const mutatedPath = join(directory, `layout-${name.replaceAll(/[^a-z0-9]+/giu, "-")}.html`);
    const mutatedSource = initScopedMutations.has(name)
      ? `${source.slice(0, initStart)}${source.slice(initStart, initEnd).replaceAll(needle, replacement)}${source.slice(initEnd)}`
      : source.replace(needle, replacement);
    assert.notEqual(mutatedSource, source, `${name} mutation must change the fixture`);
    await writeFile(mutatedPath, mutatedSource, "utf8");
    const red = await runProof(mutatedPath);
    assert.notEqual(red.status, 0, `${name} mutation must red`);
    const layoutLeg = red.report.legs.find((leg) => leg.leg === "portal-layout-invariants");
    assert.equal(layoutLeg.reasonCode, "PORTAL_LAYOUT_AUTO_PLACEMENT_OR_MEASURE_DRIFT", `${name} must be named by layout leg`);
    assert.ok(layoutLeg.findings.some((finding) => finding.name === name), `${name} must be an independent invariant`);
  }

  const privateBaseline = join(directory, "private-baseline.html");
  const baselineSource = await readFile(new URL("../design-baseline.html", import.meta.url), "utf8");
  const privatePath = ["/", ["Use", "rs"].join(""), "/private/Code"].join("");
  await writeFile(privateBaseline, baselineSource.replace("[platform-root]", privatePath), "utf8");
  const redPrivacy = await runProof(baseline, { TCRN_PORTAL_BASELINE: privateBaseline });
  assert.notEqual(redPrivacy.status, 0);
  assert.equal(redPrivacy.report.legs.find((leg) => leg.leg === "public-v4-baseline").reasonCode, "PUBLIC_V4_BASELINE_INVALID");

  const missingDeclaration = join(directory, "missing-baseline-declaration.html");
  await writeFile(missingDeclaration, baselineSource.replace("<!-- PUBLIC BASELINE: sanitized copy of the platform v4 preview; local paths and host identities were removed before inclusion. -->\n", ""), "utf8");
  const redDeclaration = await runProof(baseline, { TCRN_PORTAL_BASELINE: missingDeclaration });
  assert.notEqual(redDeclaration.status, 0);
  assert.equal(redDeclaration.report.legs.find((leg) => leg.leg === "public-v4-baseline").reasonCode, "PUBLIC_V4_BASELINE_INVALID");

  // INC-197: the count is compared against the versioned roster rather than pinned
  // to a literal here. A literal was the original defect in two places at once —
  // the gate froze 51 while reading its baseline from HEAD, so committing the
  // portal rewrite moved the baseline to 64 and turned this assertion red on a
  // change that added nothing unregistered.
  const coverageGreen = await runCoverageProof(baseline);
  assert.equal(coverageGreen.status, 0);
  assert.equal(coverageGreen.report.reasonCode, "COMPONENT_COVERAGE_CONSERVATION_GREEN");
  assert.equal(
    coverageGreen.report.portalOwnedClassBaseline.actualCount,
    coverageGreen.report.portalOwnedClassBaseline.expectedCount,
  );
  assert.ok(coverageGreen.report.portalOwnedClassBaseline.expectedCount > 0);
  assert.equal(coverageGreen.report.returnedComponents.rows.length, 9);

  // The second direction the HEAD baseline could not express: a class root the
  // portal defines without listing it in the roster.
  const unregisteredRoot = join(directory, "coverage-unregistered-root.html");
  const portalStyleClose = source.lastIndexOf("</style>");
  await writeFile(
    unregisteredRoot,
    `${source.slice(0, portalStyleClose)}\n.tcrn-unregistered-probe { color: inherit; }\n${source.slice(portalStyleClose)}`,
    "utf8",
  );
  const redUnregistered = await runCoverageProof(unregisteredRoot);
  assert.notEqual(redUnregistered.status, 0);
  assert.equal(redUnregistered.report.reasonCode, "COMPONENT_COVERAGE_CONSERVATION_RED");
  assert.equal(
    redUnregistered.report.portalOwnedClassBaseline.rows
      .find((row) => row.className === "tcrn-unregistered-probe").status,
    "unregistered",
  );

  const renamedClasses = join(directory, "coverage-renamed.html");
  await writeFile(renamedClasses, source.replaceAll("tcrn-top-bar", "tcrn-topbar"), "utf8");
  const redRename = await runCoverageProof(renamedClasses);
  assert.notEqual(redRename.status, 0);
  assert.equal(redRename.report.reasonCode, "COMPONENT_COVERAGE_CONSERVATION_RED");
  assert.ok(redRename.report.portalOwnedClassBaseline.snapshotDiff.removedOrRenamed.includes("tcrn-top-bar"));

  const missingReturned = join(directory, "coverage-missing-return.html");
  await writeFile(missingReturned, source.replace('class="tcrn-switch"', 'class="tcrn-switchmutated"'), "utf8");
  const redReturned = await runCoverageProof(missingReturned);
  assert.notEqual(redReturned.status, 0);
  assert.equal(redReturned.report.reasonCode, "COMPONENT_COVERAGE_CONSERVATION_RED");
  assert.equal(redReturned.report.returnedComponents.rows.find((row) => row.className === "tcrn-switch").status, "missing");
});
