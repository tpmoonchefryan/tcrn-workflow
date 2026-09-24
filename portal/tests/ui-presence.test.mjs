// SPDX-License-Identifier: Apache-2.0
// INC-148: the portal contract is evaluated against a parsed, executed DOM.
// linkedom is test-only; portal/index.html remains dependency-free at runtime.

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { historicalModelPlan } from "../../tests/helpers/model-plan-history.mjs";

const execFileAsync = promisify(execFile);
const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const CLI = process.env.TCRN_WORKFLOW_CLI ?? join(portalRoot, "..", "scripts", "tcrn-workflow.mjs");
const MUTATION = process.env.TCRN_UI_MUTATION ?? "";
const COMPONENTS = Object.freeze([
  ["workspace overview/audit tabs", '[data-ui="workspace-tabs"]'],
  ["prose directory", '[data-ui="prose-directory"]'],
  ["prose line-number gutter", '[data-ui="prose-gutter"]'],
  ["prose finding link", '[data-ui="prose-finding-link"]'],
  ["workspace paths", '[data-ui="workspace-paths"]'],
  ["work tree", '[data-ui="work-tree"]'],
  ["knowledge view", '[data-ui="knowledge-view"]'],
  ["gates view", '[data-ui="gates-view"]'],
  ["evolution dashboard", '[data-ui="evolution-dashboard"]'],
  ["path copy control", '[data-ui="path-copy"]'],
  ["partition switcher", '[data-ui="partition-switcher"]'],
  ["engine connection", '[data-ui="engine-connection"]'],
  ["setting modified dot", '[data-ui="setting-modified-dot"]'],
  ["setting dictionary link", '[data-ui="setting-dictionary-link"]'],
  ["dispatch configuration surface", '[data-ui="dispatch-config-surface"]'],
  ["dispatch tier table", '[data-ui="dispatch-tier-table"]'],
  ["dispatch override table", '[data-ui="dispatch-override-table"]'],
  ["DS NumberInput", ".tcrn-number-input"],
  ["DS SettingChoice", ".tcrn-setting-choice"],
  ["returned stat card", ".tcrn-stat-card"],
  ["returned setting row", ".tcrn-setting-row"],
  ["returned line-numbered editor", ".tcrn-line-numbered-editor"],
  ["returned app status bar", ".tcrn-app-status-bar"],
  ["receipt chip", '[data-ui="receipt-chip"]'],
  ["receipt drawer", '[data-ui="receipt-drawer"]'],
]);

let logicalAt = Date.parse("2026-08-13T00:00:00Z");
const nextAt = () => new Date(logicalAt += 1000).toISOString();

async function cli(args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 32e6 });
  return JSON.parse(stdout);
}

async function scratch(prefix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  // TCRN-CROSS-INC-386: the portal and every CLI it starts read and write machine settings
  // under HOME, so each fixture carries its own scratch HOME, removed with the fixture.
  const home = join(base, "home");
  await mkdir(home);
  const roots = {};
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots[kind] = await realpath(path);
  }
  await cli(["init", "--workspace", roots.workspace, "--framework", roots.framework, "--transient", roots.transient,
    "--evidence-locator", roots["evidence-locator"], "--release-trust", roots["release-trust"],
    "--external-key", "TCRN-INC148-DOM", "--at", nextAt()]);
  const proseRoot = join(base, "prose");
  await mkdir(proseRoot);
  await writeFile(join(proseRoot, "AGENTS.md"), "# Workspace rules\n\nbackup.cadence\nbackup.unknown\n", "utf8");
  return { base, workspace: roots.workspace, proseRoot, home };
}

async function writeScratch(fixture, command, args) {
  const status = await cli(["status", "--workspace", fixture.workspace]);
  return cli([command, "--workspace", fixture.workspace, "--expected-version", String(status.version), "--at", nextAt(), "--actor", "agent:test", ...args]);
}

async function seed(fixture) {
  await historicalModelPlan(fixture.workspace, "set", { host: "claude-code", name: "budget", defaultModel: "claude-sonnet-4-5" }, nextAt());
  await writeScratch(fixture, "settings-set", ["--key", "execution.claudeCodeSubagentPlan", "--value", "budget"]);
}

function mutateSource(source, mutation) {
  if (mutation === "assignment-addline") return source.replaceAll('data-ui="assignment-addline"', 'data-ui="assignment-addline-mutated"');
  if (mutation === "receipt-click") return source.replace('$("#receipt-chip").addEventListener("click", openReceipt); ', "");
  if (mutation === "receipt-stale") return source.replace(/setText\("#receipt-chip-text", state\.receipt\.version \? [\s\S]*?\);\n    renderReceipt\(\);/u, 'setText("#receipt-chip-text", "idle");\n    renderReceipt();');
  if (mutation === "s253-old-class") return source.replace('class="tcrn-top-bar"', 'class="tcrn-topbar"');
  if (mutation === "s255-missing-component-css") return source.replace(".tcrn-switch {", ".tcrn-switch-mutated {");
  if (mutation === "s275-missing-nav-name") return source.replace('aria-label="Dashboard" data-i18n-aria-label="nav.dashboard"', "");
  if (mutation === "s275-missing-brand-mark") return source.replace('data-brand-asset="tcrn-brand-mark"', 'data-brand-asset="tcrn-brand-mark-mutated"');
  return source;
}

function installDomShims(window) {
  const nativeFetch = globalThis.fetch;
  window.CSS = { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character}`) };
  window.navigator.clipboard = { writeText: async () => {} };
  window.window = window;
  window.self = window;
  window.globalThis = window;
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  window.console = console;
  const datasetDescriptor = Object.getOwnPropertyDescriptor(window.Element.prototype, "dataset");
  assert.ok(datasetDescriptor?.get, "DOM harness must expose Element.dataset");
  Object.defineProperty(window.Element.prototype, "dataset", {
    configurable: true,
    get() {
      const element = this;
      const nativeDataset = datasetDescriptor.get.call(element);
      return new Proxy(nativeDataset, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof property !== "string" || value !== null && value !== undefined) return value;
          const attribute = `data-${property.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`)}`;
          const raw = element.getAttribute(attribute);
          return raw === null ? value : raw;
        },
      });
    },
  });
  const selectPrototype = window.HTMLSelectElement.prototype;
  Object.defineProperty(selectPrototype, "value", {
    configurable: true,
    get() {
      const option = this.querySelector("option[selected]") || this.querySelector("option");
      return option?.getAttribute("value") ?? option?.textContent ?? "";
    },
    set(value) {
      for (const option of this.querySelectorAll("option")) {
        if (option.getAttribute("value") === String(value)) option.setAttribute("selected", "");
        else option.removeAttribute("selected");
      }
    },
  });
  return nativeFetch;
}

async function startPortal(fixture, env = {}) {
  assert.ok(fixture.home, "every portal child needs the fixture scratch HOME (TCRN-CROSS-INC-386)");
  const child = spawn(process.execPath, [join(portalRoot, "portal.mjs"), "--workspace", fixture.workspace,
    "--prose-root", fixture.proseRoot, "--port", "0"], {
    env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, ...env, HOME: fixture.home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`portal did not start: ${buffer}`)), 15000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((entry) => entry.includes("PORTAL_LISTENING"));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line).url); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`portal exited ${code}: ${buffer}`)); });
  });
  return { child, url };
}

async function loadExecutedDom(fixture, env = {}) {
  const { child, url } = await startPortal(fixture, env);
  const nativeFetch = globalThis.fetch;
  let source = await (await nativeFetch(url)).text();
  source = mutateSource(source, MUTATION);
  const { window, document } = parseHTML(source, { url });
  installDomShims(window);
  // TCRN-CROSS-INC-221. This used to end in `setTimeout(900)`, which is the very thing the
  // comment below `waitFor` warns against: too short and the assertion reads a DOM that has
  // not been filled, too long and every run pays the worst case. It read `—` out of
  // #stat-engine under load — in the sweep AND in preflight's isolated clone, so not a
  // local-contention flake.
  //
  // The harness already owns the page's fetch, so it can count what is in flight and wait
  // for the real settle signal instead of guessing at one. Waiting on in-flight requests
  // rather than on any asserted field is deliberate: a test that waited for #stat-engine
  // would turn a genuine regression into a timeout instead of a readable difference.
  let inFlight = 0;
  let lastSettled = Date.now();
  window.fetch = (path, options = {}) => {
    inFlight += 1;
    lastSettled = Date.now();
    return nativeFetch(new URL(path, url), options).finally(() => {
      inFlight -= 1;
      lastSettled = Date.now();
    });
  };
  const context = vm.createContext(window);
  for (const script of [...document.querySelectorAll("script")]) {
    if (script.src) {
      const scriptSource = await (await nativeFetch(new URL(script.src, url))).text();
      vm.runInContext(scriptSource, context);
    } else if (script.textContent.trim()) {
      vm.runInContext(script.textContent, context);
    }
  }
  // The quiet period covers a handler that starts its next request from the previous
  // response; a page that fetches nothing settles well inside the old 900ms.
  await waitFor(
    () => inFlight === 0 && Date.now() - lastSettled >= 150,
    "the page's initial fetches to settle",
    20_000,
  );
  return { child, document, source, window };
}

function missingComponents(document) {
  return COMPONENTS.filter(([, selector]) => document.querySelectorAll(selector).length === 0)
    .map(([name, selector]) => ({ name, selector }));
}

const hierarchyPages = Object.freeze(["dashboard", "settings", "prose", "vocabulary"]);
const topbarDesignMap = Object.freeze([
  ["product-shell-header", "header.tcrn-top-bar", "ProductShell/TopBar", "https://tcrn-design-system-storybook.vercel.app/components-navigation-shells.html#navigation-shell-spec"],
  ["partition-select", "#partition-select", "Select", "https://tcrn-design-system-storybook.vercel.app/components-controls-data.html#field-spec-usage"],
  ["engine-status", "#engine-connection", "Badge", "https://tcrn-design-system-storybook.vercel.app/proof-proof-visual-instances.html#owner-quality-product-shell"],
  ["workspace-search", "#global-search", "SearchInput", "https://tcrn-design-system-storybook.vercel.app/components-navigation-shells.html#navigation-shell-spec"],
  ["theme-toggle", "#theme-button", "ThemeToggle", "https://tcrn-design-system-storybook.vercel.app/components-navigation-shells.html#navigation-shell-spec"],
  ["locale-menu", "#locale-menu", "LocaleMenu", "https://tcrn-design-system-storybook.vercel.app/components-navigation-shells.html#navigation-shell-spec"],
  ["receipt-chip", "#receipt-chip", "Badge/Button", "https://tcrn-design-system-storybook.vercel.app/proof-proof-visual-instances.html#owner-quality-product-shell"],
]);

function childIndex(parent, child) {
  return [...parent.children].indexOf(child);
}

function pageHierarchyFindings(document, source) {
  const findings = [];
  const pages = hierarchyPages.map((name) => document.querySelector(`[data-page="${name}"]`));
  const hierarchies = pages.map((page) => page?.querySelector(':scope > [data-page-hierarchy="true"]'));
  if (document.querySelectorAll('[data-page-hierarchy="true"]').length !== hierarchyPages.length) findings.push("page-level-marker-count");
  for (const [name, page, hierarchy] of hierarchyPages.map((name, index) => [name, pages[index], hierarchies[index]])) {
    if (!page || !hierarchy || hierarchy.getAttribute("data-page-hierarchy-depth") !== "two") { findings.push(`${name}:page-level`); continue; }
    const headRegion = hierarchy.querySelector(':scope > [data-page-hierarchy-region="header"]');
    const head = headRegion?.querySelector(":scope > .tcrn-page__head");
    const tabsRegion = hierarchy.querySelector(':scope > [data-page-hierarchy-region="section-tabs"]');
    const lowerContent = hierarchy.querySelector(':scope > [data-page-hierarchy-region="lower-content"]');
    if (!headRegion || !head || childIndex(hierarchy, headRegion) !== 0 || childIndex(headRegion, head) !== 0) findings.push(`${name}:header-first`);
    if (!tabsRegion || !lowerContent || childIndex(hierarchy, tabsRegion) >= childIndex(hierarchy, lowerContent)) findings.push(`${name}:tabs-before-content`);
    if (name === "dashboard") {
      const tabs = tabsRegion?.querySelector('[data-ui="workspace-tabs"]');
      const panels = [...lowerContent?.querySelectorAll(":scope > [data-workspace-panel]") ?? []];
      if (!tabs || panels.length === 0 || !lowerContent || panels.some((panel) => childIndex(lowerContent, panel) < 0)) findings.push("dashboard:tabs-before-content");
    }
    if (name === "settings") {
      const nav = tabsRegion?.querySelector("[data-settings-layout-nav]");
      const layout = lowerContent?.querySelector('[data-settings-layout-component="SettingsLayout"]');
      const grid = layout?.querySelector("[data-settings-layout-grid]");
      const content = layout?.querySelector("[data-settings-layout-content]");
      if (!grid || !nav || !content || childIndex(grid, content) !== 0 || childIndex(tabsRegion, nav) !== 0) findings.push("settings:tabs-before-content");
      if (content?.contains(nav)) findings.push("settings:local-nav-inside-content");
    }
    if (name === "prose") {
      const directory = tabsRegion?.querySelector(":scope > #prose-directory");
      const shell = lowerContent?.querySelector(":scope > .tcrn-editor-shell");
      const bar = shell?.querySelector(":scope > .tcrn-editor__bar");
      const editor = shell?.querySelector(":scope > #prose-editor");
      if (!directory || !shell || !bar || !editor || childIndex(tabsRegion, directory) !== 0 || childIndex(lowerContent, shell) !== 0 || childIndex(shell, bar) !== 0 || childIndex(shell, editor) !== 1) findings.push("prose:controls-before-editor");
    }
    if (name === "vocabulary") {
      const nav = tabsRegion?.querySelector(":scope > #vocabulary-nav");
      const shell = lowerContent?.querySelector(":scope > .tcrn-vocabulary");
      const terms = shell?.querySelector(":scope > #vocabulary-terms");
      if (!nav || !shell || !terms || childIndex(tabsRegion, nav) !== 0 || childIndex(lowerContent, shell) !== 0 || childIndex(shell, terms) !== 0) findings.push("vocabulary:tabs-before-content");
      if (terms?.contains(nav)) findings.push("vocabulary:nav-inside-content");
    }
  }
  const sourceRules = [
    '[data-page-hierarchy="true"][data-page-hierarchy-depth="two"] [data-settings-layout-grid] { display: block; }',
    '[data-page-hierarchy="true"][data-page-hierarchy-depth="two"] .tcrn-editor-shell { display: block; }',
    '[data-page-hierarchy="true"][data-page-hierarchy-depth="two"] .tcrn-editor__directory { margin-bottom: var(--tcrn-space-3); }',
    '[data-page-hierarchy="true"][data-page-hierarchy-depth="two"] [data-settings-layout-nav],',
  ];
  for (const rule of sourceRules) if (!source.includes(rule)) findings.push(`source:${rule}`);
  return findings;
}

function topbarFindings(document) {
  const findings = [];
  for (const [name, selector, component, sourceUrl] of topbarDesignMap) {
    const nodes = [...document.querySelectorAll(selector)];
    if (nodes.length !== 1) { findings.push(`${name}:count`); continue; }
    const node = nodes[0];
    if (node.getAttribute("data-ds-component") !== component) findings.push(`${name}:component`);
    if (node.getAttribute("data-ds-source-url") !== sourceUrl) findings.push(`${name}:source-url`);
  }
  const header = document.querySelector("header.tcrn-top-bar");
  const actionOrder = ["#partition-select", "#engine-connection", "#global-search", "#theme-button", "#locale-menu", "#receipt-chip"]
    .map((selector) => document.querySelector(selector));
  const domOrder = header ? [header, ...header.querySelectorAll("*")] : [];
  if (actionOrder.some((node) => !node || !domOrder.includes(node))) findings.push("topbar:action-ownership");
  else if (actionOrder.some((node, index) => index > 0 && domOrder.indexOf(actionOrder[index - 1]) >= domOrder.indexOf(node))) findings.push("topbar:action-order");
  if (header?.getAttribute("data-ds-mapping-status") !== "candidate-consumed-pending-coordination") findings.push("topbar:mapping-status");
  return findings;
}

// A fixed sleep after a governed write is a race, not a wait: too short and the
// assertion reads a DOM that has not re-rendered, too long and every run pays for
// the worst case. Lengthening it only moves the boundary — the S280 leg below
// failed roughly one run in three at 500ms while its own receipt-chip assertion
// passed, i.e. the write had landed and only the row was behind.
//
// This polls for the condition instead, and fails with the name of what never
// arrived rather than with an empty-string diff. Callers wait for the *settle
// signal* and assert content separately, so a genuine regression still surfaces as
// an assertion difference rather than as a timeout.
async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// The portal's own "the governed write landed" signal: the chip carries the
// version it read back. It must be waited on as a *change*, because the pattern
// alone is already true from whichever write came before — waiting for the shape
// returns instantly, the test runs ahead of the request it was supposed to wait
// for, and cleanup then kills the child mid-flight (ECONNRESET). Capture the text
// before the click and wait for it to move.
const receiptText = (document) => document.querySelector("#receipt-chip-text")?.textContent ?? "";
const receiptAdvanced = (document, before) => () => {
  const current = receiptText(document);
  return current !== before && /^✓v\d+$/u.test(current) ? current : null;
};

async function preparePage(env = {}) {
  const fixture = await scratch("tcrn-inc148-dom-");
  await seed(fixture);
  const page = await loadExecutedDom(fixture, env);
  page.workspace = fixture.workspace;
  page.cleanup = async () => { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); };
  page.document.querySelector('[data-page-target="settings"]')?.click();
  page.document.querySelector('[data-setting-group="execution"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  return page;
}

function assertDomContract(document) {
  assert.equal(document.querySelectorAll("template#ui-contract-markers").length, 0, "contract must inspect rendered DOM; marker template must be removed");
  const dsStyle = document.querySelector('style#tcrn-ds-component-css[data-source="snapshot"]');
  assert.ok(dsStyle, "the rendered page must inline the signed-in DS component CSS snapshot");
  const dsCss = dsStyle?.textContent ?? "";
  assert.deepEqual(
    ["tcrn-button", "tcrn-field", "tcrn-input", "tcrn-select", "tcrn-textarea", "tcrn-sr-only"].filter((name) => !dsCss.includes(`.${name}`)),
    [],
    "the six shared component roots must come from the inlined DS snapshot",
  );
  const sharedRoots = ["tcrn-button", "tcrn-field", "tcrn-input", "tcrn-select", "tcrn-textarea", "tcrn-sr-only"];
  assert.deepEqual(
    sharedRoots.filter((name) => document.querySelectorAll(`.${name}`).length === 0),
    [],
    "the executed DOM must render every shared component root",
  );
  const returnedRoots = ["tcrn-stat-card", "tcrn-setting-row", "tcrn-line-numbered-editor", "tcrn-app-status-bar"];
  const hasCssRoot = (name) => new RegExp(`\\.${name}(?=[\\s,{:>+~]|$)`, "u").test(dsCss);
  assert.deepEqual(
    returnedRoots.filter((name) => !hasCssRoot(name)),
    [],
    "the executed page must consume every returned construct from the inlined DS snapshot",
  );
  assert.deepEqual(
    returnedRoots.filter((name) => document.querySelectorAll(`.${name}`).length === 0),
    [],
    "the executed DOM must render every returned DS construct",
  );
  const alignedSelectors = [
    ["product shell", ".tcrn-product-shell"],
    ["top bar", "header.tcrn-top-bar"],
    // INC-167: the brand is the design system's shell lockup and it sits in the sidebar
    // header, which is where the product shell defines __brand as a child.
    ["brand lockup", "button.tcrn-product-shell__brand.tcrn-shell-brand-lockup"],
    ["sidebar header", ".tcrn-product-shell__sidebar .tcrn-product-shell__sidebar-header"],
    ["brand mark", 'img.tcrn-brand-mark[data-brand-asset="tcrn-brand-mark"]'],
    ["side navigation", ".tcrn-side-nav"],
    // INC-168 selection-level invariants. The shell controls are the design system's
    // own, not generic parts assembled to look like them: a quiet button wearing a
    // "Theme" label and a bare <select> for language both passed every earlier gate
    // while being the wrong components. Each entry here names the construct the
    // storybook publishes for that role.
    ["shell theme toggle", "button.tcrn-shell-theme-toggle"],
    ["shell locale menu", ".tcrn-shell-locale-menu > .tcrn-shell-locale-menu__trigger"],
    ["locale menu panel", '.tcrn-shell-locale-menu__panel[role="listbox"]'],
    ["compound search input", "span.tcrn-search-input > input.tcrn-search-input__control"],
    ["search shortcut", "kbd.tcrn-search-input__shortcut"],
    ["workspace section tabs", '[data-ui="workspace-tabs"].tcrn-section-tabs'],
    ["surface", ".tcrn-surface"],
    ["knowledge TOC rail", "#prose-directory.tcrn-knowledge-toc-rail"],
    ["receipt badge", "#receipt-chip.tcrn-badge"],
    ["detail drawer", "#receipt-drawer.tcrn-detail-drawer"],
    ["readback panel", "#receipt-body.tcrn-readback-panel"],
    ["activity feed", "#dashboard-audit.tcrn-work-activity-feed"],
  ];
  assert.deepEqual(
    alignedSelectors.filter(([, selector]) => !document.querySelector(selector)),
    [],
    "the executed DOM must expose the S253 DS class alignment",
  );
  const missing = missingComponents(document);
  assert.deepEqual(missing, [], `rendered DOM components absent: ${JSON.stringify(missing)}`);
  const navigationItems = [...document.querySelectorAll(".tcrn-side-nav .tcrn-nav-item")];
  // STORY-370 retired Entities, and STORY-403 folds article reading into the
  // dashboard knowledge view rather than keeping a manual article destination.
  assert.equal(navigationItems.length, 4, "the portal must render the four live platform destinations");
  assert.ok(navigationItems.every((button) => button.getAttribute("aria-label")?.trim()), "every destination must expose an accessible name");
  assert.ok(navigationItems.every((button) => button.getAttribute("data-i18n-aria-label")?.trim()), "every destination name must come from the locale table");
  assert.equal(document.querySelector('img.tcrn-brand-mark')?.getAttribute("alt"), "", "the decorative mark must not duplicate the brand accessible name");
  assert.ok(document.querySelector('[data-ui="receipt-chip"][data-ui-action="open-receipt"]'), "receipt chip must expose its action");
}

async function assertBehaviorContract(page) {
  const { document, window } = page;
  const chip = document.querySelector('[data-ui="receipt-chip"]');
  const drawer = document.querySelector('[data-ui="receipt-drawer"]');
  chip.click();
  assert.equal(drawer.dataset.open, "true", "receipt chip click must open the drawer");
  assert.equal(drawer.getAttribute("aria-hidden"), "false", "receipt drawer must expose its open state");
  document.querySelector("#drawer-close").click();
  const beforeSetting = receiptText(document);
  const control = document.querySelector('#settings-rows [data-setting-control]');
  assert.ok(control, "fixture must expose a settings control for the write leg");
  if (control.tagName === "BUTTON") control.click();
  else {
    if (control.tagName === "SELECT") control.value = control.value;
    control.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  await waitFor(receiptAdvanced(document, beforeSetting), "the receipt chip to advance after the settings write");
  const chipText = document.querySelector("#receipt-chip-text").textContent;
  assert.match(chipText, /^✓v\d+$/u, `receipt chip must update after a successful write, got ${JSON.stringify(chipText)}`);
}

if (MUTATION) {
  test(`INC-148 meta-criterion mutation ${MUTATION} must red`, async () => {
    const page = await preparePage();
    try {
      if (MUTATION === "presentation") {
        const target = page.document.querySelector('[data-ui="workspace-tabs"]');
        const replacement = page.document.createElement("div");
        replacement.setAttribute("role", "presentation");
        target.replaceWith(replacement);
      }
      assertDomContract(page.document);
      await assertBehaviorContract(page);
    } finally {
      await page.cleanup();
    }
  });
} else {
  test("INC-148 rendered DOM contract names every preview component", async () => {
    const page = await preparePage();
    try { assertDomContract(page.document); } finally { await page.cleanup(); }
  });

  test("INC-148 rendered DOM behavior changes receipt state", async () => {
    const page = await preparePage();
    try { assertDomContract(page.document); await assertBehaviorContract(page); } finally { await page.cleanup(); }
  });

  test("INC-221 a settle signal that never arrives fails by name, not by silent misread", async () => {
    // The property that makes waiting safer than sleeping: a sleep that is too short
    // reports a wrong value as if it were the truth, while a wait that never settles says
    // what it was waiting for. loadExecutedDom now depends on this, so it is pinned here.
    await assert.rejects(
      () => waitFor(() => false, "a signal that cannot arrive", 60),
      (error) => /timed out after 60ms waiting for a signal that cannot arrive/u.test(String(error?.message)),
    );
    // And it returns the predicate's value the moment it is truthy, so a settled page
    // costs one poll interval rather than a fixed budget.
    assert.equal(await waitFor(() => "settled", "an immediate signal"), "settled");
  });

  test("INC-151 rendered engine card follows the engine status value", async () => {
    const fixture = await scratch("tcrn-inc151-engine-dom-");
    const wrapper = join(fixture.base, "engine-version-wrapper.mjs");
    await writeFile(wrapper, `import { spawnSync } from "node:child_process";
const actual = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { encoding: "utf8" });
if (process.argv[2] === "status" && actual.status === 0) {
  const body = JSON.parse(actual.stdout);
  body.engineVersion = "0.11.99";
  process.stdout.write(JSON.stringify(body));
} else {
  process.stdout.write(actual.stdout || "");
  process.stderr.write(actual.stderr || "");
  process.exitCode = actual.status ?? 1;
}
`, "utf8");
    const page = await loadExecutedDom(fixture, { TCRN_WORKFLOW_CLI: wrapper });
    try { assert.equal(page.document.querySelector("#stat-engine").textContent, "0.11.99"); } finally { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); }
  });

  test("INC-151 rendered health card turns red when actor configuration is absent", async () => {
    const fixture = await scratch("tcrn-inc151-health-dom-");
    const page = await loadExecutedDom(fixture, { TCRN_PORTAL_ACTOR: "   " });
    try {
      assert.match(page.document.querySelector("#health-chip").className, /tcrn-badge--danger/u);
      assert.equal(page.document.querySelector("#stat-health").textContent, "2/3");
      assert.match(page.document.querySelector("#health-list").textContent, /actor.*failed/iu);
    } finally { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); }
  });

  test("INC-150 vocabulary descriptions are localized in the executed DOM", async () => {
    const page = await preparePage();
    try {
      // INC-167: language is chosen from the design system's locale menu, so the test
      // drives the option the way a reader does rather than setting a select's value.
      page.document.querySelector('[data-locale-option="zh-CN"]').dispatchEvent(new page.window.Event("click", { bubbles: true }));
      // INC-176: the vocabulary is a table now, so the localized description lives in
      // the Description cell of the first row rather than a definition list.
      // linkedom has no :nth-child, and the cell carries its column name in data-label
      // anyway — which is the more honest anchor: it names the column, not a position.
      const definition = [...page.document.querySelectorAll('[data-vocabulary-table] .tcrn-table-shell__cell')].find((cell) => cell.getAttribute("data-label") === "描述")?.textContent || "";
      assert.match(definition, /确定方向与预期成果|审视结构与技术选择|揭示威胁、缓解措施与暴露面/u);
      assert.doesNotMatch(definition, /Sets direction and intended outcomes|Examines structural and technical choices|Surfaces threats, mitigations, and exposure/u);
      assert.equal(page.document.querySelector('[data-i18n="dashboard.chain"]')?.textContent, "链版本");
      assert.ok([...page.document.querySelectorAll("[data-i18n]")].every((node) => node.textContent.trim().length > 0), "every static i18n binding must render text in the executed DOM");
    } finally { await page.cleanup(); }
  });

  test("STORY-402 retires persona and empty-effort dictionary surfaces while keeping dispatch vocabulary current", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-page-target="vocabulary"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const categories = [...page.document.querySelectorAll("[data-vocabulary-category]")].map((button) => button.dataset.vocabularyCategory);
      assert.ok(categories.includes("conferenceTypes"));
      assert.ok(categories.includes("executionForms"));
      assert.equal(categories.includes("roles"), false);
      assert.equal(categories.includes("efforts"), false);
      assert.equal(page.document.querySelector('[data-vocabulary-table="roles"]'), null);
      assert.equal(page.document.querySelector('[data-vocabulary-table="efforts"]'), null);
      assert.doesNotMatch(await readFile(join(portalRoot, "index.html"), "utf8"), /data-page="articles"|article-form|vocabulary\.roles|vocabulary\.efforts/iu);
      assert.doesNotMatch(await readFile(join(portalRoot, "locales.js"), "utf8"), /vocabulary\.roles|vocabulary\.efforts|persona/iu);
    } finally { await page.cleanup(); }
  });

  test("TCRN-CROSS-STORY-404 consumes the DS106-112 settings contract and exposes coordination status", async () => {
    const page = await preparePage();
    try {
      const layout = page.document.querySelector('[data-settings-layout-component="SettingsLayout"]');
      assert.ok(layout, "the settings page must consume the DS SettingsLayout contract");
      assert.equal(layout.getAttribute("data-ds-candidate"), "TCRN-Design-System@610680b81a950e91e9e1e77718ea7f3f3b19bc27");
      assert.equal(layout.getAttribute("data-ds-contract-status"), "candidate-consumed-pending-coordination");
      assert.equal(layout.getAttribute("data-ds-contract-version"), "ai_consumption_contract_v1");
      assert.equal(layout.getAttribute("data-ds-contract-digest"), "a56fcf3427866d4034ede1c59b59b888ac8169ca19fcd1c3af66b0a49cd16138");
      assert.equal(layout.getAttribute("data-ds-surface-contracts"), "overlay-boundary-contract-v1 field-value-selection-contract-v1 dictionary-content-contract-v1 operation-feedback-contract-v1 content-scope-contract-v1 consumer-evidence-contract-v1 verification-cadence-contract-v1");
      assert.equal(layout.getAttribute("data-ds-static-overlay-bridge"), "mountStaticOverlayBoundary");
      assert.deepEqual(layout.getAttribute("data-ds-rules")?.split(" "), ["DS-106-R1", "DS-106-R2", "DS-107-R1", "DS-107-R2", "DS-108-R1", "DS-108-R2", "DS-112-R1", "DS-112-R2", "DS-116-R1", "DS-116-R2", "DS-117-R1", "DS-117-R2", "DS-118-R1", "DS-118-R2", "DS-119-R1", "DS-119-R2"]);
      const required = {
        "data-settings-layout-mode": "container-driven",
        "data-settings-layout-form-policy": "single-host-single-column",
        "data-settings-layout-breakpoint": "960px",
        "data-settings-content-breakpoint": "720px",
        "data-settings-local-navigation": "compact",
        "data-settings-overflow-policy": "no-page-overflow",
        "data-settings-long-value-policy": "native-inline-scroll-copy",
      };
      for (const [attribute, expected] of Object.entries(required)) assert.equal(layout.getAttribute(attribute), expected, `${attribute} must be declared by SettingsLayout`);
      assert.equal(layout.getAttribute("data-settings-layout-navigation-location"), "page-hierarchy-section-tabs");
      assert.ok(layout.querySelector(".tcrn-settings-layout__frame > .tcrn-settings-layout__grid"));
      assert.ok(page.document.querySelector('[data-page-hierarchy-region="section-tabs"] [data-settings-layout-nav]'));
      assert.ok(layout.querySelector(".tcrn-settings-layout__content"));
      const dsStyle = page.document.querySelector('style#tcrn-ds-component-css[data-source="snapshot"]');
      assert.ok(dsStyle?.textContent.includes(".tcrn-setting-choice") && dsStyle.textContent.includes(".tcrn-number-input") && dsStyle.textContent.includes(".tcrn-settings-layout"));
      const numberInputs = [...layout.querySelectorAll('[data-number-input-component="NumberInput"]')];
      assert.ok(numberInputs.length > 0, "workspace settings must render DS NumberInput controls");
      assert.ok(numberInputs.every((input) => input.classList.contains("tcrn-number-input")
        && input.classList.contains("tcrn-input")
        && input.type === "number"
        && input.getAttribute("data-number-input") === "true"
        && input.getAttribute("data-number-input-semantic") === "numeric-entry"
        && input.getAttribute("min") !== null
        && input.getAttribute("max") !== null
        && input.getAttribute("value") !== null
        && input.getAttribute("data-number-input-visibility") === "full-value"));
      const settingChoices = [...layout.querySelectorAll('[data-setting-choice="true"]')];
      assert.ok(settingChoices.length > 0, "workspace settings must render DS SettingChoice markers");
      assert.ok(settingChoices.every((choice) => choice.getAttribute("data-setting-choice-semantic") === "value-selection"
        && choice.getAttribute("data-setting-choice-control") === "select"
        && Number.isInteger(Number(choice.getAttribute("data-setting-choice-option-count")))
        && choice.getAttribute("data-setting-choice-rejection-reason") !== null));
      assert.equal(layout.querySelectorAll(".tcrn-stepper").length, 0, "Stepper must not carry numeric setting semantics");

      page.document.querySelector('[data-setting-group="execution"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(layout.querySelectorAll('[data-settings-host-switcher="true"]').length, 1, "one host switcher must precede the selected host form");
      assert.equal(layout.querySelectorAll("[data-dispatch-host-card]").length, 1, "only one complete host form may be rendered");
      assert.equal(layout.querySelectorAll('[data-dispatch-mode-select="true"]').length, 1, "dispatch mode must use a native select fallback when width is unknown");
      assert.equal(layout.querySelectorAll("button[data-dispatch-mode]").length, 0, "navigation-style buttons must not carry setting values");
      const hostSelect = layout.querySelector('[data-dispatch-host-switcher="true"]');
      const alternateHost = [...hostSelect.options].find((option) => option.value !== hostSelect.value);
      if (alternateHost) {
        hostSelect.value = alternateHost.value;
        hostSelect.dispatchEvent(new page.window.Event("change", { bubbles: true }));
        assert.equal(layout.querySelector('[data-dispatch-host-card]')?.getAttribute("data-dispatch-host-card"), alternateHost.value);
      }
      for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        assert.equal(page.document.documentElement.lang, locale);
        assert.equal(layout.getAttribute("data-settings-layout-component"), "SettingsLayout");
      }
      page.document.querySelector('[data-locale-option="en"]')?.click();
      page.document.querySelector("#theme-button")?.click();
      assert.ok(["light", "dark"].includes(page.document.documentElement.dataset.tcrnTheme));
    } finally { await page.cleanup(); }
  });

  test("TCRN-CROSS-STORY-405 proves the fixed DS semantics, rejects structural mutations, and preserves coordination status", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-setting-group="execution"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const layout = page.document.querySelector('[data-settings-layout-component="SettingsLayout"]');
      assert.ok(layout);
      const findings = (root) => {
        const output = [];
        if (root.getAttribute("data-ds-candidate") !== "TCRN-Design-System@610680b81a950e91e9e1e77718ea7f3f3b19bc27") output.push("ds-candidate");
        if (root.getAttribute("data-ds-contract-status") !== "candidate-consumed-pending-coordination") output.push("ds-contract-status");
        if (root.getAttribute("data-ds-contract-version") !== "ai_consumption_contract_v1") output.push("ds-contract-version");
        if (root.getAttribute("data-ds-contract-digest") !== "a56fcf3427866d4034ede1c59b59b888ac8169ca19fcd1c3af66b0a49cd16138") output.push("ds-contract-digest");
        if (root.getAttribute("data-ds-rules") !== "DS-106-R1 DS-106-R2 DS-107-R1 DS-107-R2 DS-108-R1 DS-108-R2 DS-112-R1 DS-112-R2 DS-116-R1 DS-116-R2 DS-117-R1 DS-117-R2 DS-118-R1 DS-118-R2 DS-119-R1 DS-119-R2") output.push("ds-rules");
        if (root.getAttribute("data-settings-layout-navigation-location") !== "page-hierarchy-section-tabs") output.push("navigation-location");
        const required = {
          "data-settings-layout-mode": "container-driven",
          "data-settings-layout-form-policy": "single-host-single-column",
          "data-settings-layout-breakpoint": "960px",
          "data-settings-content-breakpoint": "720px",
          "data-settings-local-navigation": "compact",
          "data-settings-overflow-policy": "no-page-overflow",
          "data-settings-long-value-policy": "native-inline-scroll-copy",
        };
        for (const [attribute, expected] of Object.entries(required)) if (root.getAttribute(attribute) !== expected) output.push(attribute);
        if (root.querySelectorAll("[data-dispatch-host-card]").length !== 1) output.push("parallel-host-columns");
        if (!root.querySelector('[data-settings-host-switcher="true"]')) output.push("host-switcher");
        if (!root.querySelector('[data-dispatch-mode-select="true"]')) output.push("mode-select");
        if (root.querySelectorAll("button[data-dispatch-mode]").length > 0) output.push("setting-value-navigation-button");
        if (root.querySelectorAll(".tcrn-stepper").length > 0) output.push("stepper-numeric-entry");
        for (const input of root.querySelectorAll('[data-number-input-component="NumberInput"]')) {
          if (!input.classList.contains("tcrn-number-input")) output.push("number-input-identity");
          if (input.getAttribute("data-number-input-visibility") !== "full-value") output.push("number-input-visibility");
          if (input.type !== "number" || input.getAttribute("min") === null || input.getAttribute("max") === null || input.getAttribute("value") === null) output.push("number-input-native-range");
        }
        return output;
      };
      assert.deepEqual(findings(layout), [], "the fixed candidate's structural proof must be green while coordination remains pending");

      layout.removeAttribute("data-settings-layout-form-policy");
      assert.ok(findings(layout).includes("data-settings-layout-form-policy"), "missing single-column policy must red");
      layout.setAttribute("data-settings-layout-form-policy", "single-host-single-column");

      const numberInput = layout.querySelector('[data-number-input-component="NumberInput"]');
      numberInput.classList.remove("tcrn-number-input");
      numberInput.removeAttribute("data-number-input-visibility");
      assert.ok(findings(layout).includes("number-input-identity") && findings(layout).includes("number-input-visibility"), "a NumberInput lookalike must red");
      numberInput.classList.add("tcrn-number-input");
      numberInput.setAttribute("data-number-input-visibility", "full-value");

      const hostContainer = layout.querySelector(".tcrn-dispatch-hosts");
      const duplicate = hostContainer.querySelector("[data-dispatch-host-card]").cloneNode(true);
      hostContainer.append(duplicate);
      assert.ok(findings(layout).includes("parallel-host-columns"), "a second host form must red");
      duplicate.remove();

      const stepper = page.document.createElement("div");
      stepper.className = "tcrn-stepper";
      layout.append(stepper);
      assert.ok(findings(layout).includes("stepper-numeric-entry"), "a Stepper numeric mutation must red");
      stepper.remove();
      assert.deepEqual(findings(layout), [], "restoring the candidate must return the positive proof to green");
    } finally { await page.cleanup(); }
  });

  test("TCRN-CROSS-STORY-407/409/411 R3 consumes DS116-119 operation, scope, and evidence markers", async () => {
    const page = await preparePage();
    try {
      const feedback = page.document.querySelector("#operation-feedback");
      assert.ok(feedback, "the receipt drawer must expose the DS OperationFeedback root");
      assert.deepEqual({
        phase: feedback.getAttribute("data-operation-phase"),
        state: feedback.getAttribute("data-operation-state"),
        geometry: feedback.getAttribute("data-operation-geometry"),
        notification: feedback.getAttribute("data-operation-update-notification"),
        live: feedback.getAttribute("aria-live"),
      }, { phase: "idle", state: "idle", geometry: "responsive-safe", notification: "aria-live", live: "polite" });
      assert.ok(feedback.querySelector('[data-operation-short-status="true"]'));
      assert.ok(feedback.querySelector('[data-operation-identity="true"]'));
      const detailsTrigger = feedback.querySelector('[data-operation-details-trigger="true"]');
      const details = feedback.querySelector('[data-operation-details="true"]');
      assert.ok(detailsTrigger && details);
      assert.equal(details.hidden, true);
      detailsTrigger.click();
      assert.equal(details.hidden, false);
      assert.equal(detailsTrigger.getAttribute("aria-expanded"), "true");
      detailsTrigger.click();
      assert.equal(details.hidden, true);

      page.document.querySelector('[data-setting-group="machine"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const scope = page.document.querySelector('[data-content-scope="machine-settings"]');
      assert.ok(scope, "machine settings must consume the independent ContentScope contract");
      assert.deepEqual({
        source: scope.getAttribute("data-content-source"),
        phase: scope.getAttribute("data-content-phase"),
        valid: scope.getAttribute("data-content-valid"),
        shown: scope.getAttribute("data-content-shown-count"),
        total: scope.getAttribute("data-content-total-count"),
        countKind: scope.getAttribute("data-content-count-kind"),
        stale: scope.getAttribute("data-content-stale"),
      }, { source: "engine.machine-settings", phase: "content", valid: "true", shown: "4", total: "4", countKind: "total", stale: "false" });
      assert.equal(scope.querySelectorAll("[data-machine-row]").length, 4);
      assert.equal(scope.querySelectorAll(".tcrn-content-scope__content").length, 1);
      assert.equal(page.document.querySelector("#settings-rows .tcrn-state-surface"), null, "a sibling scope must not supply the machine empty state");

      const chip = page.document.querySelector("#receipt-chip");
      const control = page.document.querySelector('[data-machine-control="portal.defaultTheme"]');
      assert.ok(chip && control);
      control.value = control.value === "dark" ? "light" : "dark";
      control.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(() => feedback.getAttribute("data-operation-phase") === "success" ? "success" : null, "the operation feedback receipt update");
      assert.equal(feedback.getAttribute("data-operation-phase"), "success");
      assert.equal(feedback.getAttribute("data-operation-state"), "ready");
      assert.equal(feedback.querySelector('[data-operation-short-status="true"]')?.getAttribute("data-operation-short-status-phase"), "success");
      assert.ok(feedback.querySelector('[data-operation-identity-field="actor"]')?.textContent);
      assert.match(page.document.querySelector("#receipt-body")?.textContent ?? "", /MACHINE_SETTINGS_WRITE_COMMITTED/u);
    } finally { await page.cleanup(); }
  });

  test("TCRN-CROSS-STORY-406 renders every current route as two levels and rejects a third-level or reordered mutation", async () => {
    const page = await preparePage();
    const source = await readFile(join(portalRoot, "index.html"), "utf8");
    try {
      assert.deepEqual(pageHierarchyFindings(page.document, source), [], "current routes must use Header + subpage controls + lower content");

      const settings = page.document.querySelector('[data-page="settings"]');
      const settingsHierarchy = settings.querySelector('[data-page-hierarchy="true"]');
      settingsHierarchy.removeAttribute("data-page-hierarchy");
      assert.ok(pageHierarchyFindings(page.document, source).includes("settings:page-level"), "a missing level declaration must red");
      settingsHierarchy.setAttribute("data-page-hierarchy", "true");

      const grid = settings.querySelector("[data-settings-layout-grid]");
      const nav = settings.querySelector("[data-settings-layout-nav]");
      const content = settings.querySelector("[data-settings-layout-content]");
      const settingsTabsRegion = settingsHierarchy.querySelector('[data-page-hierarchy-region="section-tabs"]');
      grid.append(nav);
      assert.ok(pageHierarchyFindings(page.document, source).includes("settings:tabs-before-content"), "a local-nav-after-content mutation must red");
      settingsTabsRegion.append(nav);
      assert.deepEqual(pageHierarchyFindings(page.document, source), [], "restoring the two-level order must return green");
    } finally { await page.cleanup(); }
  });

  test("TCRN-CROSS-STORY-407 binds each product topbar control to its complete DS address and rejects duplicate or unbound controls", async () => {
    const page = await preparePage();
    try {
      assert.deepEqual(topbarFindings(page.document), [], "the topbar mapping must be structurally complete");

      const header = page.document.querySelector("header.tcrn-top-bar");
      const duplicate = header.cloneNode(true);
      header.parentElement.append(duplicate);
      assert.ok(topbarFindings(page.document).includes("product-shell-header:count"), "a duplicate product shell header must red");
      duplicate.remove();

      const receipt = page.document.querySelector("#receipt-chip");
      const receiptParent = receipt.parentElement;
      receipt.remove();
      assert.ok(topbarFindings(page.document).includes("receipt-chip:count"), "a missing mapped action must red");
      receiptParent.append(receipt);
      assert.deepEqual(topbarFindings(page.document), [], "restoring the mapped action must return green");

      header.removeAttribute("data-ds-source-url");
      assert.ok(topbarFindings(page.document).includes("product-shell-header:source-url"), "a self-reported but incomplete DS binding must red");
    } finally { await page.cleanup(); }
  });

  test("TCRN-CROSS-STORY-407/411 R2-W1 gives every tablist DS keyboard and tabpanel semantics", async () => {
    const page = await preparePage();
    try {
      const keydown = (target, key) => {
        const event = new page.window.Event("keydown", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "key", { value: key });
        target.dispatchEvent(event);
      };
      const tabLists = [...page.document.querySelectorAll('[role="tablist"]')];
      assert.equal(tabLists.length, 3, "dashboard, settings, and vocabulary must all expose a tablist");
      for (const list of tabLists) {
        const tabs = [...list.querySelectorAll('[role="tab"]')];
        assert.ok(tabs.length > 1, "each tablist must expose its complete tab set");
        assert.equal(tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").length, 1, "each tablist has one selected tab");
        assert.equal(tabs.filter((tab) => tab.getAttribute("tabindex") === "0").length, 1, "each tablist has one tabbable tab");
        for (const tab of tabs) {
          assert.ok(tab.id, "each tab has a stable id");
          assert.equal(tab.getAttribute("aria-current"), null, "a real tab must not announce a page-current navigation state");
          assert.ok(tab.getAttribute("aria-controls"), "each tab controls a panel");
          const panel = page.document.getElementById(tab.getAttribute("aria-controls"));
          assert.equal(panel?.getAttribute("role"), "tabpanel", "each tab target is a tabpanel");
        }
        const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
        const panel = page.document.getElementById(selected.getAttribute("aria-controls"));
        assert.equal(panel?.getAttribute("aria-labelledby"), selected.id, "the selected tab labels its panel");
      }

      const settingsList = page.document.querySelector('[data-settings-layout-nav]');
      const workspace = settingsList.querySelector('[data-setting-group="workspace"]');
      keydown(workspace, "ArrowRight");
      const backup = settingsList.querySelector('[data-setting-group="backup"]');
      assert.equal(backup.getAttribute("aria-selected"), "true", "ArrowRight selects the next settings group");
      assert.equal(page.document.getElementById("settings-panel").getAttribute("aria-labelledby"), backup.id);
      keydown(backup, "Home");
      assert.equal(workspace.getAttribute("aria-selected"), "true", "Home selects the first settings group");
      const machine = settingsList.querySelector('[data-setting-group="machine"]');
      keydown(workspace, "End");
      assert.equal(machine.getAttribute("aria-selected"), "true", "End selects the last settings group");
      assert.equal(page.document.getElementById("settings-panel").getAttribute("aria-labelledby"), machine.id);

      const dashboardList = page.document.querySelector('[data-ui="workspace-tabs"]');
      const overview = dashboardList.querySelector('[data-workspace-tab="overview"]');
      keydown(overview, "ArrowRight");
      const work = dashboardList.querySelector('[data-workspace-tab="work"]');
      assert.equal(work.getAttribute("aria-selected"), "true", "dashboard ArrowRight selects the next panel");
      assert.equal(page.document.querySelector('[data-workspace-panel="work"]').hidden, false);
      assert.equal(page.document.querySelector('[data-workspace-panel="overview"]').hidden, true);
      keydown(work, "End");
      const audit = dashboardList.querySelector('[data-workspace-tab="audit"]');
      assert.equal(audit.getAttribute("aria-selected"), "true", "dashboard End selects the final panel");
      assert.equal(page.document.querySelector('[data-workspace-panel="audit"]').hidden, false);
      keydown(audit, "Home");
      assert.equal(overview.getAttribute("aria-selected"), "true");

      page.document.querySelector('[data-page-target="vocabulary"]')?.click();
      const vocabularyList = page.document.querySelector("#vocabulary-nav");
      const vocabularyTabs = [...vocabularyList.querySelectorAll('[role="tab"]')];
      const firstVocabularyTab = vocabularyTabs[0];
      keydown(firstVocabularyTab, "ArrowRight");
      const selectedVocabularyTab = [...vocabularyList.querySelectorAll('[role="tab"]')]
        .find((tab) => tab.getAttribute("aria-selected") === "true");
      assert.notEqual(selectedVocabularyTab, firstVocabularyTab, "vocabulary ArrowRight selects the next category");
      const vocabularyPanel = page.document.getElementById(selectedVocabularyTab.getAttribute("aria-controls"));
      assert.equal(vocabularyPanel.getAttribute("role"), "tabpanel");
      assert.equal(vocabularyPanel.getAttribute("aria-labelledby"), selectedVocabularyTab.id);
      keydown(selectedVocabularyTab, "End");
      const lastVocabularyTab = [...vocabularyList.querySelectorAll('[role="tab"]')]
        .find((tab) => tab.getAttribute("aria-selected") === "true");
      assert.equal(lastVocabularyTab, [...vocabularyList.querySelectorAll('[role="tab"]')].at(-1), "vocabulary End selects the final category");
    } finally { await page.cleanup(); }
  });

  test("INC-183 every enum setting is its own dictionary entry", async () => {
    const page = await preparePage();
    try {
      const navFor = (category) => page.document.querySelector(`[data-vocabulary-category="${category}"]`);
      // The shared "settings enums" domain is retired (Owner, MIN-094). Asserting its
      // absence is the half that keeps this from passing on a page that simply added
      // the new entries beside the old container.
      assert.equal(navFor("settingsEnums"), null, "the retired shared settings-enum domain must not appear");
      assert.equal(page.document.querySelector('[data-vocabulary-table="settingsEnums"]'), null);

      // Each enum setting stands on its own, named by the same human label the settings
      // page uses for that control.
      const entries = [...page.document.querySelectorAll("[data-vocabulary-category]")]
        .map((button) => button.dataset.vocabularyCategory)
        .filter((category) => category.startsWith("setting:"));
      assert.ok(entries.includes("setting:backup.cadence"));
      assert.ok(entries.includes("setting:execution.independenceFloor"));
      assert.ok(entries.includes("setting:execution.subagentPolicy"));
      assert.notEqual(navFor("setting:backup.cadence").textContent.trim(), "backup.cadence", "an entry is named, not keyed");

      navFor("setting:backup.cadence").dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      const shell = page.document.querySelector('[data-vocabulary-table="setting:backup.cadence"]');
      assert.ok(shell, "the entry must render its own table");
      const rows = [...shell.querySelectorAll(".tcrn-table-shell__row")];
      const cell = (row, label) => [...row.children].find((node) => node.getAttribute("data-label") === label)?.textContent.trim() ?? "";
      const values = rows.map((row) => cell(row, "Value"));

      // The entry IS the setting, so its rows are exactly that setting's values — all
      // three of them, and nothing belonging to another setting.
      assert.deepEqual(values, ["gate-close", "session-end", "manual"]);
      // Anchored on the positive badge rather than its text: the label is localized,
      // and a test that reads it is really testing which locale the fixture booted in.
      const isDefaultRow = (row) => Boolean([...row.children]
        .find((node) => node.getAttribute("data-label") === "Default")
        ?.querySelector(".tcrn-badge--positive"));
      assert.deepEqual(rows.filter(isDefaultRow).map((row) => cell(row, "Value")), ["gate-close"]);
      // No cell is blank: the row unit is the value, and a description keyed by setting
      // key alone would have left every value undefined.
      assert.ok(rows.every((row) => [...row.children].every((node) => node.textContent.trim().length > 0)), "no cell may be blank");

      // A hyphenated value survives, and a second entry proves the shape is shared
      // rather than special-cased for the cadence.
      navFor("setting:execution.independenceFloor").dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      const floor = page.document.querySelector('[data-vocabulary-table="setting:execution.independenceFloor"]');
      assert.deepEqual([...floor.querySelectorAll(".tcrn-table-shell__row")].map((row) => cell(row, "Value")),
        ["none", "verification", "verification-and-risk", "all"]);
    } finally { await page.cleanup(); }
  });

  test("TCRN-CROSS-STORY-409 keeps every visible field in its declared group and models prompt languages as a deduplicated set", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-page-target="settings"]')?.click();
      const retiredEconomySettingKey = "model.economyTier";
      const catalogForGroups = await cli(["settings-catalog", "--workspace", page.workspace]);
      const settingGroupSource = page.source.match(/const SETTING_GROUPS = Object\.freeze\(\{([\s\S]*?)\n  \}\);/u)?.[1];
      assert.ok(settingGroupSource, "the portal must declare its settings group coverage");
      const settingGroupEntries = [...settingGroupSource.matchAll(/^ {4}"([^"]+)": "([^"]+)",$/gmu)].map(([, key, group]) => [key, group]);
      const settingGroups = settingGroupEntries.map(([key]) => key);
      const legacyModelSource = page.source.match(/const LEGACY_MODEL_SETTING_KEYS = new Set\(\[([^\]]*)\]\);/u)?.[1] ?? "";
      const legacyModelKeys = [...legacyModelSource.matchAll(/"([^"]+)"/gu)].map(([, key]) => key);
      const catalogKeys = new Set(catalogForGroups.settings.map((entry) => entry.key));
      const groupedKeys = new Set([...settingGroups, ...legacyModelKeys]);
      const missingFromGroups = [...catalogKeys].filter((key) => !groupedKeys.has(key)).sort();
      const staleGroups = [...groupedKeys].filter((key) => !catalogKeys.has(key)).sort();
      assert.deepEqual(
        { missingFromGroups, staleGroups },
        { missingFromGroups: [], staleGroups: [] },
        `settings catalog/group coverage differs (missing: ${missingFromGroups.join(", ") || "none"}; stale: ${staleGroups.join(", ") || "none"})`,
      );
      const groupFor = (key) => {
        for (const group of ["workspace", "backup", "execution", "machine"]) {
          page.document.querySelector(`[data-setting-group="${group}"]`)?.click();
          const selector = group === "machine" ? `[data-machine-row="${key}"]` : `[data-setting-row="${key}"]`;
          if (page.document.querySelector(selector)) return group;
        }
        return null;
      };
      assert.equal(groupFor(retiredEconomySettingKey), null, "retired economy-tier model must not appear in any settings group");
      assert.equal(groupFor("retrieval.promptLanguages"), "workspace");
      assert.equal(groupFor("backup.cadence"), "backup");
      assert.equal(groupFor("portal.port"), "machine", "machine settings stay outside the workspace settings groups");

      // Retirement is a user-visible contract, not only a grouping detail: neither
      // legacy subagent-plan key may produce a settings row in the rendered execution
      // surface, and neither may be discoverable through the global search index.
      page.document.querySelector('[data-setting-group="execution"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      for (const key of ["execution.claudeCodeSubagentPlan", "execution.codexSubagentPlan"]) {
        assert.equal(page.document.querySelector(`[data-setting-row="${key}"]`), null, `${key} must stay absent from rendered settings`);
        const globalSearch = page.document.querySelector("#global-search");
        globalSearch.value = key;
        globalSearch.dispatchEvent(new page.window.Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(page.document.querySelectorAll("#search-results [data-search-index]").length, 0, `${key} must stay absent from global search`);
      }

      // The actual delta is locale-independent: all five localized routes keep the
      // same neighboring execution-control identities and order while the retired
      // economy-tier field stays absent from the rendered surface.
      const dispatchKeys = new Set(["execution.dispatchClasses", "execution.dispatchMode", "execution.dispatchModes", "execution.dispatchTiers"]);
      const legacyKeys = new Set(["execution.claudeCodeSubagentPlan", "execution.codexSubagentPlan"]);
      const expectedExecutionRows = [...catalogForGroups.settings]
        .filter((entry) => settingGroupEntries.some(([key, group]) => key === entry.key && group === "execution"))
        .map((entry) => entry.key)
        .filter((key) => !dispatchKeys.has(key) && !legacyKeys.has(key));
      for (const locale of ["zh-CN", "en", "ja", "ko", "fr"]) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.deepEqual(
          [...page.document.querySelectorAll("[data-setting-row]")].map((row) => row.dataset.settingRow),
          expectedExecutionRows,
          `${locale} must keep the neighboring execution controls in order`,
        );
        assert.equal(page.document.querySelector(`[data-setting-row="${retiredEconomySettingKey}"]`), null, `${locale} must omit retired economy-tier`);
      }

      page.document.querySelector('[data-setting-group="workspace"]')?.click();
      assert.equal(page.document.querySelector(`[data-setting-row="${retiredEconomySettingKey}"]`), null, "the retired model field must not leak into workspace");
      const prompt = page.document.querySelector('[data-setting-control="retrieval.promptLanguages"]');
      assert.ok(prompt, "prompt languages must have a live control");
      assert.equal(prompt.tagName, "SELECT");
      assert.equal(prompt.hasAttribute("multiple"), true);
      assert.equal(prompt.getAttribute("data-setting-cardinality"), "set");
      assert.equal(prompt.closest("[data-setting-choice-component]")?.getAttribute("data-setting-choice-source"), "artifact.language.allowedValues");
      assert.equal(prompt.closest("[data-setting-choice-component]")?.getAttribute("data-setting-choice-value-format"), "comma-separated");

      const catalog = await cli(["settings-catalog", "--workspace", page.workspace]);
      const languageSetting = catalog.settings.find((entry) => entry.key === "artifact.language");
      const roster = languageSetting.allowedValues;
      assert.ok(Array.isArray(roster) && roster.length > 0);
      assert.deepEqual([...prompt.options].map((option) => option.value), roster, "the selector options must come from the engine language roster");
      assert.equal(new Set([...prompt.options].map((option) => option.value)).size, prompt.options.length, "language options must be unique");

      const firstOption = prompt.options[0];
      for (const option of [...prompt.options]) option.removeAttribute("selected");
      firstOption.setAttribute("selected", "");
      const duplicate = firstOption.cloneNode(true);
      duplicate.setAttribute("selected", "");
      prompt.append(duplicate);
      const before = receiptText(page.document);
      prompt.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(receiptAdvanced(page.document, before), "the prompt-language set receipt");
      const saved = (await cli(["settings-catalog", "--workspace", page.workspace])).settings.find((entry) => entry.key === "retrieval.promptLanguages");
      assert.equal(saved.currentValue, firstOption.value, "duplicate selected language values must be serialized once");
    } finally { await page.cleanup(); }
  });

  test("TCRN-CROSS-STORY-410 gives every vocabulary value a distinct five-locale definition and shows each category explanation once", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-page-target="vocabulary"]')?.click();
      const categories = [
        "hosts",
        "conferenceTypes",
        "executionForms",
        "setting:artifact.language",
        "setting:backup.cadence",
        "setting:execution.independenceFloor",
        "setting:execution.subagentPolicy",
        "setting:storage.backend",
      ];
      const countOf = (text, needle) => needle ? text.split(needle).length - 1 : 0;
      for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
        for (const category of categories) {
          const button = page.document.querySelector(`[data-vocabulary-category="${category}"]`);
          assert.ok(button, `${locale} must keep the ${category} vocabulary category`);
          button.dispatchEvent(new page.window.Event("click", { bubbles: true }));
          const terms = page.document.querySelector("#vocabulary-terms");
          const categoryDescription = terms.querySelector(`[data-vocabulary-category-description="${category}"]`);
          assert.equal(terms.querySelectorAll("[data-vocabulary-category-description]").length, 1, `${locale}/${category} must show one category explanation`);
          assert.ok(categoryDescription?.textContent.trim() && !/^(?:vocabulary|setting)\./u.test(categoryDescription.textContent.trim()), `${locale}/${category} category explanation must be localized`);
          const rows = [...terms.querySelectorAll(".tcrn-table-shell__row")];
          assert.ok(rows.length > 0, `${locale}/${category} must render its engine values`);
          const descriptions = rows.map((row) => row.children[1]?.textContent.trim() ?? "");
          assert.ok(descriptions.every((description) => description.length > 0 && !/^(?:vocabulary|setting)\./u.test(description)), `${locale}/${category} values must have localized definitions`);
          assert.equal(new Set(descriptions).size, descriptions.length, `${locale}/${category} values must not collapse to one repeated description`);
          assert.ok(descriptions.every((description) => description !== categoryDescription.textContent.trim()), `${locale}/${category} values must not repeat the category explanation`);
          if (category === "setting:backup.cadence") assert.equal(countOf(terms.textContent, categoryDescription.textContent.trim()), 1, `${locale}/backup category copy must appear once`);
          if (category === "setting:storage.backend") assert.notEqual(descriptions[0], descriptions[1], `${locale}/storage backend values need distinct meaning`);
        }
      }
    } finally { await page.cleanup(); }
  });

  test("TCRN-CROSS-STORY-410 R2-W2 explains storage choices in user terms before technical detail", async () => {
    const page = await preparePage();
    try {
      const technicalShorthand = /NDJSON|sidecar|backend|边车|后端|サイドカー|バックエンド|사이드카|백엔드/iu;
      const functionalChoice = {
        file: /compatib|兼容|互換|호환/u,
        segmented: /grow|small|section|分段|片段|増え|小さ|늘|단위|grandit|petites/u,
      };
      page.document.querySelector('[data-page-target="settings"]')?.click();
      page.document.querySelector('[data-setting-group="workspace"]')?.click();
      const storageRow = () => page.document.querySelector('[data-setting-row="storage.backend"] .tcrn-setting-row__description')?.textContent.trim() ?? "";
      page.document.querySelector('[data-page-target="vocabulary"]')?.click();
      const openStorageVocabulary = () => {
        const button = page.document.querySelector('[data-vocabulary-category="setting:storage.backend"]');
        assert.ok(button, "the storage backend dictionary entry must remain available");
        button.dispatchEvent(new page.window.Event("click", { bubbles: true }));
        const table = page.document.querySelector('[data-vocabulary-table="setting:storage.backend"]');
        assert.ok(table, "the storage backend table must render");
        return [...table.querySelectorAll('.tcrn-table-shell__row')].map((row) => row.children[1]?.textContent.trim() ?? "");
      };
      for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        page.document.querySelector('[data-page-target="settings"]')?.click();
        page.document.querySelector('[data-setting-group="workspace"]')?.click();
        const main = storageRow();
        assert.ok(main.length > 0, `${locale} storage setting needs a main explanation`);
        assert.doesNotMatch(main, technicalShorthand, `${locale} main storage explanation must lead with user consequences`);
        assert.match(main, functionalChoice.file, `${locale} main storage explanation must explain the compatibility choice`);
        assert.match(main, functionalChoice.segmented, `${locale} main storage explanation must explain the growing-history choice`);

        page.document.querySelector('[data-page-target="vocabulary"]')?.click();
        const descriptions = openStorageVocabulary();
        assert.equal(descriptions.length, 2, `${locale} must explain both storage values`);
        assert.ok(descriptions.every((description) => description.length > 0 && !technicalShorthand.test(description)), `${locale} value explanations must lead with a user-facing choice`);
        assert.match(descriptions[0], functionalChoice.file, `${locale} file value must state when to choose it`);
        assert.match(descriptions[1], functionalChoice.segmented, `${locale} segmented value must state when to choose it`);
      }
    } finally { await page.cleanup(); }
  });

  test("TCRN-CROSS-STORY-409 R2 covers default, modified, reset, page-switch, disabled, and invalid-value lifecycle states", async () => {
    const page = await preparePage();
    try {
      const selectGroup = (group) => page.document.querySelector(`[data-setting-group="${group}"]`)?.click();
      const waitForReceiptChange = async (before, label) => waitFor(receiptAdvanced(page.document, before), label);
      selectGroup("workspace");

      const defaultRow = page.document.querySelector('[data-setting-row="driver.capabilityProfile"]');
      assert.equal(defaultRow?.dataset.modified, "false", "an unchanged open field starts in its default state");
      const driver = defaultRow.querySelector('[data-setting-control="driver.capabilityProfile"]');
      const beforeModify = receiptText(page.document);
      driver.value = "r2-isolated-driver";
      driver.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitForReceiptChange(beforeModify, "the modified open-field receipt");
      await waitFor(() => page.document.querySelector('[data-setting-row="driver.capabilityProfile"]')?.dataset.modified === "true", "the modified field to read back");
      const modifiedRow = page.document.querySelector('[data-setting-row="driver.capabilityProfile"]');
      assert.equal(modifiedRow?.dataset.modified, "true");
      assert.ok(modifiedRow?.querySelector("[data-reset-setting]"), "a modified field exposes reset");

      const beforeReset = receiptText(page.document);
      modifiedRow.querySelector("[data-reset-setting]").click();
      await waitForReceiptChange(beforeReset, "the open-field reset receipt");
      await waitFor(() => page.document.querySelector('[data-setting-row="driver.capabilityProfile"]')?.dataset.modified === "false", "the reset field to read back");
      assert.equal(page.document.querySelector('[data-setting-row="driver.capabilityProfile"]')?.dataset.modified, "false", "reset returns the field to the engine default");
      assert.equal((await cli(["settings-catalog", "--workspace", page.workspace])).settings.find((entry) => entry.key === "driver.capabilityProfile").currentValue, "default");

      const prompt = page.document.querySelector('[data-setting-control="retrieval.promptLanguages"]');
      assert.ok(prompt?.hasAttribute("multiple"));
      for (const option of [...prompt.options]) option.removeAttribute("selected");
      for (const option of [...prompt.options]) option.setAttribute("selected", "");
      const beforeSet = receiptText(page.document);
      prompt.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitForReceiptChange(beforeSet, "the prompt-language collection receipt");
      await waitFor(() => page.document.querySelector('[data-setting-row="retrieval.promptLanguages"]')?.dataset.modified === "true", "the prompt-language collection to read back");
      assert.equal((await cli(["settings-catalog", "--workspace", page.workspace])).settings.find((entry) => entry.key === "retrieval.promptLanguages").currentValue, "en,zh-CN");

      page.document.querySelector('[data-page-target="dashboard"]')?.click();
      page.document.querySelector('[data-page-target="settings"]')?.click();
      assert.equal(page.document.querySelector('[data-setting-control="retrieval.promptLanguages"]')?.options[0].hasAttribute("selected"), true, "page switching preserves the live collection state");

      const currentPrompt = page.document.querySelector('[data-setting-control="retrieval.promptLanguages"]');
      for (const option of [...currentPrompt.options]) option.removeAttribute("selected");
      const beforeCollectionReset = receiptText(page.document);
      currentPrompt.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitForReceiptChange(beforeCollectionReset, "the prompt-language collection reset receipt");
      await waitFor(() => page.document.querySelector('[data-setting-row="retrieval.promptLanguages"]')?.dataset.modified === "false", "the prompt-language reset to read back");
      assert.equal((await cli(["settings-catalog", "--workspace", page.workspace])).settings.find((entry) => entry.key === "retrieval.promptLanguages").currentValue, null, "clearing the collection removes the setting rather than writing an empty value");

      selectGroup("machine");
      assert.equal(page.document.querySelector("#partition-select")?.disabled, true, "workspace-only mode disables partition switching");
      assert.match(page.document.querySelector('[data-machine-row="portal.port"]')?.textContent ?? "", /restart/u, "the machine port exposes its restart lifecycle");

      selectGroup("workspace");
      const numeric = page.document.querySelector('[data-setting-control="conference.positionBudgetBytes"]');
      const beforeInvalid = receiptText(page.document);
      numeric.value = "511";
      numeric.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(() => receiptText(page.document) !== beforeInvalid && receiptText(page.document).startsWith("✕"), "the invalid-value receipt");
      assert.equal(page.document.querySelector('[data-setting-row="conference.positionBudgetBytes"]')?.dataset.modified, "false", "an engine-rejected value does not change the field");
      assert.equal((await cli(["settings-catalog", "--workspace", page.workspace])).settings.find((entry) => entry.key === "conference.positionBudgetBytes").currentValue, "4096");
    } finally { await page.cleanup(); }
  });

  test("TCRN-CROSS-SUB-123 execution.subagentPolicy is a governed portal select with complete lifecycle coverage", async () => {
    const page = await preparePage();
    try {
      const key = "execution.subagentPolicy";
      const allowedValues = ["allowed", "review-only", "forbidden"];
      const controlFor = () => page.document.querySelector(`[data-setting-control="${key}"]`);
      const rowFor = () => page.document.querySelector(`[data-setting-row="${key}"]`);
      const readback = async () => (await cli(["settings-catalog", "--workspace", page.workspace])).settings.find((entry) => entry.key === key);

      const initial = controlFor();
      assert.equal(initial?.tagName, "SELECT", "execution.subagentPolicy must render as a select");
      assert.deepEqual([...initial.options].map((option) => option.value), allowedValues, "the select options must be the closed engine enum");
      assert.equal(initial.closest("[data-setting-choice-component]")?.getAttribute("data-setting-choice-control"), "select");
      assert.equal(initial.value, "allowed", "the portal select must show the catalog default");

      const selected = "review-only";
      const beforeWrite = receiptText(page.document);
      initial.value = selected;
      initial.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(() => receiptAdvanced(page.document, beforeWrite)(), "the subagent-policy write receipt");
      await waitFor(() => rowFor()?.dataset.modified === "true" && controlFor()?.value === selected, "the subagent-policy write readback");
      assert.ok(page.document.querySelector("#receipt-body")?.textContent.includes(key), "the write receipt must name execution.subagentPolicy");
      assert.equal((await readback()).currentValue, selected, "the engine readback must carry the selected policy value");

      page.document.querySelector('[data-page-target="dashboard"]')?.click();
      page.document.querySelector('[data-page-target="settings"]')?.click();
      page.document.querySelector('[data-setting-group="execution"]')?.click();
      await waitFor(() => controlFor()?.value === selected, "the selected policy to survive a page switch");
      assert.equal(rowFor()?.dataset.modified, "true");

      const reset = rowFor()?.querySelector(`[data-reset-setting="${key}"]`);
      assert.ok(reset, "a modified policy must expose reset");
      const beforeReset = receiptText(page.document);
      reset.click();
      await waitFor(() => receiptAdvanced(page.document, beforeReset)(), "the subagent-policy reset receipt");
      await waitFor(() => rowFor()?.dataset.modified === "false" && controlFor()?.value === "allowed", "the policy reset readback");
      assert.equal((await readback()).currentValue, "allowed", "reset must restore the allowed default");

      const invalid = page.document.createElement("option");
      invalid.value = "not-a-policy";
      invalid.textContent = invalid.value;
      const afterReset = controlFor();
      afterReset.append(invalid);
      afterReset.value = invalid.value;
      afterReset.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(() => (page.document.querySelector("#receipt-body")?.textContent ?? "").includes("SETTINGS_VALUE_INVALID"), "the CLI-layer invalid policy refusal");
      assert.match(page.document.querySelector("#receipt-body")?.textContent ?? "", /SETTINGS_VALUE_INVALID/u, "the CLI must reject an out-of-range policy");
      assert.equal(rowFor()?.dataset.modified, "false", "a rejected policy must not mark the row modified");
      assert.equal((await readback()).currentValue, "allowed", "the rejected policy must not change the engine value");
    } finally { await page.cleanup(); }
  });

  test("TCRN-CROSS-SUB-124 execution.independenceFloor is a governed portal select with complete lifecycle coverage", async () => {
    const page = await preparePage();
    try {
      const key = "execution.independenceFloor";
      const allowedValues = ["none", "verification", "verification-and-risk", "all"];
      const controlFor = () => page.document.querySelector(`[data-setting-control="${key}"]`);
      const rowFor = () => page.document.querySelector(`[data-setting-row="${key}"]`);
      const readback = async () => (await cli(["settings-catalog", "--workspace", page.workspace])).settings.find((entry) => entry.key === key);

      const initial = controlFor();
      assert.equal(initial?.tagName, "SELECT", "execution.independenceFloor must render as a select");
      assert.deepEqual([...initial.options].map((option) => option.value), allowedValues, "the select options must be the closed engine enum");
      assert.equal(initial.closest("[data-setting-choice-component]")?.getAttribute("data-setting-choice-control"), "select");
      assert.equal(initial.value, "none", "the portal select must show the catalog default");

      const selected = "verification-and-risk";
      const beforeWrite = receiptText(page.document);
      initial.value = selected;
      initial.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(() => receiptAdvanced(page.document, beforeWrite)(), "the independence-floor write receipt");
      await waitFor(() => rowFor()?.dataset.modified === "true" && controlFor()?.value === selected, "the independence-floor write readback");
      assert.ok(page.document.querySelector("#receipt-body")?.textContent.includes(key), "the write receipt must name execution.independenceFloor");
      assert.equal((await readback()).currentValue, selected, "the engine readback must carry the selected floor value");

      page.document.querySelector('[data-page-target="dashboard"]')?.click();
      page.document.querySelector('[data-page-target="settings"]')?.click();
      page.document.querySelector('[data-setting-group="execution"]')?.click();
      await waitFor(() => controlFor()?.value === selected, "the selected floor to survive a page switch");
      assert.equal(rowFor()?.dataset.modified, "true");

      const reset = rowFor()?.querySelector(`[data-reset-setting="${key}"]`);
      assert.ok(reset, "a modified floor must expose reset");
      const beforeReset = receiptText(page.document);
      reset.click();
      await waitFor(() => receiptAdvanced(page.document, beforeReset)(), "the independence-floor reset receipt");
      await waitFor(() => rowFor()?.dataset.modified === "false" && controlFor()?.value === "none", "the floor reset readback");
      assert.equal((await readback()).currentValue, "none", "reset must restore the none default");

      const invalid = page.document.createElement("option");
      invalid.value = "not-a-floor";
      invalid.textContent = invalid.value;
      const afterReset = controlFor();
      afterReset.append(invalid);
      afterReset.value = invalid.value;
      afterReset.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(() => (page.document.querySelector("#receipt-body")?.textContent ?? "").includes("SETTINGS_VALUE_INVALID"), "the CLI-layer invalid floor refusal");
      assert.match(page.document.querySelector("#receipt-body")?.textContent ?? "", /SETTINGS_VALUE_INVALID/u, "the CLI must reject an out-of-range floor");
      assert.equal(rowFor()?.dataset.modified, "false", "a rejected floor must not mark the row modified");
      assert.equal((await readback()).currentValue, "none", "the rejected floor must not change the engine value");
    } finally { await page.cleanup(); }
  });

  test("INC-193 the design authority is declared, and what cannot be checked here is yellow", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-setting-group="workspace"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const row = page.document.querySelector('[data-setting-row="design.authority"]');
      assert.ok(row, "the design authority is a workspace setting");
      assert.ok(row.querySelector('[data-concept-tip="setting.design.authority"]'), "its ceiling is explained where it is set");

      // Unset is the ordinary case for a workspace with no design system, and it is
      // silent: no panel, no warning, nothing to resolve. A gate that could not be
      // satisfied in this world would make the optional key effectively required.
      const panel = page.document.querySelector("#design-authority");
      assert.ok(panel, "the panel exists even when there is nothing to show");
      assert.equal(panel.hidden, true, "an undeclared authority says nothing at all");

      // The contract is fetched by the reader's browser. Both outcomes are exercised
      // here because only one of them can be produced against a real address offline,
      // and a state proven on one side only is half a state machine.
      const realFetch = page.window.fetch;
      // TCRN-CROSS-INC-221. The stub records when it answered, because the panel is the
      // only other observable and two of the three cases below render byte-identically —
      // deliberately, since a body under a foreign contract must leak nothing. There is no
      // change to wait for, so the settle signal is the contract fetch being answered plus
      // a quiet period for the handler to render it.
      const traffic = { answered: 0, at: 0 };
      const answerWith = (body, ok = true) => {
        page.window.fetch = (input, options) => {
          const target = String(input);
          if (!target.includes("tcrn-design-authority.json")) return realFetch(input, options);
          traffic.answered += 1;
          traffic.at = Date.now();
          return Promise.resolve({ ok, status: ok ? 200 : 404, json: async () => body });
        };
      };
      const rendered = (label) => {
        const seen = traffic.answered;
        return async () => {
          await waitFor(() => traffic.answered > seen && Date.now() - traffic.at >= 120, label);
        };
      };

      answerWith({ schemaVersion: "tcrn.design-authority.v1", name: "Example System", version: "9.9.9" });
      const input = page.document.querySelector('[data-setting-control="design.authority"]');
      const declaredRendered = rendered("the declared contract to be fetched and rendered");
      input.value = "https://design.example.test/";
      input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await declaredRendered();
      const declared = page.document.querySelector("[data-design-authority-state]");
      assert.equal(declared?.dataset.designAuthorityState, "declared");
      assert.match(declared.textContent, /Example System/u);
      assert.match(declared.textContent, /9\.9\.9/u);
      assert.ok(!declared.className.includes("--warning"), "a contract that answered is not a warning");

      // A response that is not this platform's contract is yellow, not red: the fact is
      // outside this machine, so nothing here can be called false. The message has to
      // say what would turn it green, or a yellow becomes a permanent decoration.
      answerWith({ hello: "world" });
      const warnedRendered = rendered("the foreign response to be fetched and rendered");
      input.value = "https://other.example.test/";
      input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await warnedRendered();
      const warned = page.document.querySelector("[data-design-authority-state]");
      assert.equal(warned?.dataset.designAuthorityState, "warning", "a response that is not this contract is yellow");
      assert.ok(warned.className.includes("tcrn-inline-alert"), "the warning uses the design system's alert");
      assert.ok(warned.className.includes("tcrn-inline-alert--warning"));
      assert.match(warned.textContent, /turns green/u, "a yellow must say what resolves it");

      // A body that is well-formed in every way EXCEPT the schema version isolates that
      // check. Without this case the schema check could be deleted and nothing would
      // notice, because the earlier sample was also missing its name and version and
      // would keep landing yellow by a different route.
      answerWith({ schemaVersion: "someone.elses.contract.v1", name: "Example System", version: "9.9.9" });
      const wrongSchemaRendered = rendered("the body under another contract to be fetched and rendered");
      input.value = "https://third.example.test/";
      input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await wrongSchemaRendered();
      const wrongSchema = page.document.querySelector("[data-design-authority-state]");
      assert.equal(wrongSchema?.dataset.designAuthorityState, "warning", "a well-formed body under another contract is still not ours");
      assert.ok(!wrongSchema.textContent.includes("Example System"), "nothing from an unrecognised contract reaches the page");
    } finally { await page.cleanup(); }
  });

  test("INC-192 abstract concepts carry a supplemental explanation the keyboard can reach", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-setting-group="execution"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const tip = page.document.querySelector('[data-concept-tip="setting.execution.independenceFloor"]');
      assert.ok(tip, "the independence floor is the concept that prompted this batch and must carry one");

      // This long explanation uses the design system's non-interactive Popover boundary:
      // the consumer supplies the trigger and domain copy, while the mounted layer is
      // body-bound and cannot be clipped by a settings row.
      assert.equal(tip.getAttribute("data-overlay-scope"), "popover");
      assert.equal(tip.getAttribute("data-static-overlay-kind"), "popover");
      const trigger = tip.querySelector("button");
      const layerId = trigger?.getAttribute("aria-controls");
      const content = layerId ? page.document.getElementById(layerId) : null;
      assert.ok(trigger && content);
      assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
      assert.equal(trigger.getAttribute("aria-controls"), content.getAttribute("id"));
      assert.equal(content.getAttribute("role"), "dialog");
      assert.equal(content.parentElement, page.document.body, "the popover layer must be mounted at document body");
      assert.equal(content.getAttribute("data-overlay-boundary"), "document-body");
      assert.equal(content.getAttribute("data-overlay-positioning"), "static-fixed");
      assert.equal(content.getAttribute("data-ds-overlay-candidate"), "TCRN-Design-System@610680b81a950e91e9e1e77718ea7f3f3b19bc27");
      assert.equal(content.hidden, true, "a mounted popover starts closed");
      // INC-201: the contract is that the trigger names *a* design-system button
      // component, which is what design-proof's button-family leg enforces. It used to
      // be pinned to tcrn-icon-button specifically, and that class is a 38x38 control
      // box — carrying it and then overriding its every declaration is the collision
      // INC-196 was about, so the 16px info affordance names tcrn-button instead.
      assert.ok(
        ["tcrn-button", "tcrn-icon-button", "tcrn-link-button"].some((name) => trigger.classList.contains(name)),
        "the trigger names a design-system button component",
      );
      assert.ok(trigger.querySelector("svg"), "the icon is inline SVG, not a character the shipped font may not have");
      assert.equal(trigger.textContent.trim(), "", "no glyph stands in for the icon");
      assert.equal(content.querySelectorAll("a,button,input,select,textarea").length, 0, "the design system forbids interactive content inside a tooltip");

      trigger.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      assert.equal(content.hidden, false, "the popover opens from its trigger");
      assert.equal(trigger.getAttribute("aria-expanded"), "true");
      const escape = new page.window.Event("keydown", { bubbles: true });
      Object.defineProperty(escape, "key", { value: "Escape" });
      page.document.dispatchEvent(escape);
      assert.equal(content.hidden, true, "Escape closes the popover");
      assert.equal(trigger.getAttribute("aria-expanded"), "false");

      // The explanation says the thing the surface does not — here, that the engine
      // never checks the declaration is true. A tip that only repeated the label would
      // train the icon into noise.
      assert.match(content.textContent, /self-report|never that it is true/u);
      assert.ok(!content.textContent.startsWith("concept."), "a tip must not show the reader its own key");

      // Every dictionary category carries one; they had no explanation at all before.
      page.document.querySelector('[data-page-target="vocabulary"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const categories = [...page.document.querySelectorAll("[data-vocabulary-category]")]
        .map((button) => button.dataset.vocabularyCategory)
        .filter((category) => !category.startsWith("setting:"));
      const explained = [...page.document.querySelectorAll('#vocabulary-nav [data-concept-tip]')]
        .map((node) => node.dataset.conceptTip.replace("vocabulary.", ""));
      assert.deepEqual(explained.slice().sort(), categories.slice().sort(), "every dictionary category is explained");
    } finally { await page.cleanup(); }
  });

  test("TCRN-CROSS-STORY-408 R2 consumes the DS static overlay boundary for short and long explanations", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-setting-group="execution"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const longTip = page.document.querySelector('[data-concept-tip="setting.execution.independenceFloor"]');
      const shortTip = page.document.querySelector('[data-concept-tip="setting.execution.subagentPolicy"]');
      assert.ok(longTip && shortTip, "the settings surface must expose both overlay consumers");
      const inspect = (tip) => {
        const trigger = tip.querySelector("button");
        const id = trigger?.getAttribute("aria-controls") || trigger?.getAttribute("aria-describedby");
        const layer = id ? page.document.getElementById(id) : null;
        assert.ok(trigger && layer, "every overlay trigger must resolve its layer by id");
        assert.equal(layer.parentElement, page.document.body, "every layer must escape the settings row boundary");
        assert.equal(layer.getAttribute("data-overlay-boundary"), "document-body");
        assert.equal(layer.getAttribute("data-overlay-positioning"), "static-fixed");
        assert.equal(layer.getAttribute("data-ds-overlay-candidate"), "TCRN-Design-System@610680b81a950e91e9e1e77718ea7f3f3b19bc27");
        assert.equal(layer.hidden, true);
        return { trigger, layer };
      };
      const long = inspect(longTip);
      assert.equal(long.trigger.getAttribute("aria-haspopup"), "dialog");
      long.trigger.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      assert.equal(long.layer.hidden, false);
      const closeLong = new page.window.Event("keydown", { bubbles: true });
      Object.defineProperty(closeLong, "key", { value: "Escape" });
      page.document.dispatchEvent(closeLong);
      assert.equal(long.layer.hidden, true);

      const short = inspect(shortTip);
      assert.equal(short.trigger.getAttribute("aria-describedby"), short.layer.getAttribute("id"));
      assert.equal(short.layer.getAttribute("role"), "tooltip");
      short.trigger.dispatchEvent(new page.window.Event("focusin", { bubbles: true }));
      assert.equal(short.layer.hidden, false, "the short tooltip opens from keyboard focus");
      const closeShort = new page.window.Event("keydown", { bubbles: true });
      Object.defineProperty(closeShort, "key", { value: "Escape" });
      page.document.dispatchEvent(closeShort);
      assert.equal(short.layer.hidden, true, "Escape closes the short tooltip");
    } finally { await page.cleanup(); }
  });

  test("INC-186 the dictionary carries no workspace data", async () => {
    const page = await preparePage();
    try {
      // The fixture creates a plan named "budget" and binds it to a setting, so if the
      // dictionary drew its values from the plan list this sweep would find that name.
      // That is the whole defect: the dictionary grew a row because the reader created
      // a plan, which is the portal inventing vocabulary rather than publishing it.
      const names = [...page.document.querySelectorAll("[data-vocabulary-category]")].map((button) => button.dataset.vocabularyCategory);
      assert.ok(!names.includes("setting:execution.claudeCodeSubagentPlan"), "a setting whose values are plan names has no closed set to define");
      assert.ok(!names.includes("setting:execution.codexSubagentPlan"));
      // Both sides: settings the engine does publish a closed set for keep their entries.
      assert.ok(names.includes("setting:backup.cadence"));
      assert.ok(names.includes("setting:execution.subagentPolicy"));

      for (const name of names) {
        page.document.querySelector(`[data-vocabulary-category="${name}"]`).dispatchEvent(new page.window.Event("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 40));
        const rendered = page.document.querySelector("#vocabulary-terms")?.textContent ?? "";
        assert.ok(!rendered.includes("budget"), `workspace data leaked into the ${name} entry`);
      }

      // The 📖 link and the dictionary answer the same question, so the link is present
      // exactly where an entry exists to reach and absent where none does.
      page.document.querySelector('[data-setting-group="backup"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const cadenceRow = page.document.querySelector('[data-setting-row="backup.cadence"]');
      assert.ok(cadenceRow?.querySelector("[data-vocabulary-link]"), "a closed-enum setting keeps its dictionary link");
      page.document.querySelector('[data-setting-group="execution"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const planRow = page.document.querySelector('[data-setting-row="execution.claudeCodeSubagentPlan"]');
      if (planRow) assert.equal(planRow.querySelector("[data-vocabulary-link]"), null, "a plan-sourced setting must not offer a link to an entry that does not exist");
    } finally { await page.cleanup(); }
  });

  test("STORY-373 the dispatch surface replaces the old model page and directory", async () => {
    const page = await preparePage();
    try {
      assert.equal(page.document.querySelector('[data-setting-group="models"]'), null);
      assert.equal(page.document.querySelector("#model-plans"), null);
      assert.equal(page.document.querySelector('[data-ui="vendor-directory-toggle"]'), null);
      assert.equal(page.document.querySelector('[data-ui="vendor-directory-drawer"]'), null);
      const surface = page.document.querySelector('[data-ui="dispatch-config-surface"]');
      assert.ok(surface, "the execution group must render the dispatch configuration surface");
      assert.ok(surface.textContent.includes("next session") || surface.textContent.includes("下次会话"), "the activation boundary must be visible");
      assert.equal(page.document.querySelectorAll("[data-dispatch-tier-row]").length, 3);
      assert.equal(page.document.querySelectorAll("[data-dispatch-model]").length, 3);
      assert.equal(page.document.querySelectorAll("[data-dispatch-effort]").length, 3);
      assert.ok(page.document.querySelector('[data-ui="dispatch-override-table"]'));
      assert.ok(page.document.querySelector('[data-dispatch-mode-select] option[value="eco"]'));
    } finally { await page.cleanup(); }
  });

  test("STORY-373 mode save returns the engine receipt and host probe shows raw host failure", async () => {
    const fixture = await scratch("tcrn-story373-dispatch-dom-");
    await seed(fixture);
    const bin = join(fixture.base, "fake-host-bin");
    await mkdir(bin);
    const fake = join(bin, "claude");
    await writeFile(fake, "#!/usr/bin/env node\nprocess.stderr.write('host says model missing\\n'); process.exitCode = 7;\n", { mode: 0o700 });
    // TCRN-CROSS-INC-387: host-probe prefers the host CLI named by CLAUDE_CODE_EXECPATH, which a
    // Claude Code session sets; clearing it keeps this case on the fake claude first on PATH.
    const page = await loadExecutedDom(fixture, { PATH: `${bin}:${process.env.PATH}`, CLAUDE_CODE_EXECPATH: "" });
    page.workspace = fixture.workspace;
    page.cleanup = async () => { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); };
    page.document.querySelector('[data-page-target="settings"]')?.click();
    page.document.querySelector('[data-setting-group="execution"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    try {
      const mode = page.document.querySelector('[data-dispatch-mode-select]');
      assert.ok(mode);
      const before = receiptText(page.document);
      mode.value = "eco";
      mode.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(receiptAdvanced(page.document, before), "the dispatch-mode receipt");
      assert.match(page.document.querySelector("#receipt-body")?.textContent ?? "", /SETTINGS_WRITE_COMMITTED/u);
      assert.equal((await cli(["settings-catalog", "--workspace", fixture.workspace])).settings.find((entry) => entry.key === "execution.dispatchMode").currentValue, "eco");

      const row = [...page.document.querySelectorAll("[data-dispatch-tier-row]")].find((candidate) => JSON.parse(candidate.dataset.dispatchTierRow).host === "claude-code" && JSON.parse(candidate.dataset.dispatchTierRow).tier === "main");
      assert.ok(row);
      row.querySelector("[data-dispatch-model]").value = "does-not-exist";
      row.querySelector("[data-dispatch-effort]").value = "high";
      const beforeTierSave = receiptText(page.document);
      page.document.querySelector('[data-dispatch-save-host="claude-code"]')?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await waitFor(receiptAdvanced(page.document, beforeTierSave), "the dispatch-tier receipt");
      assert.match(page.document.querySelector("#receipt-body")?.textContent ?? "", /DISPATCH_CONFIG_WRITE_COMMITTED/u);
      const savedTiers = JSON.parse((await cli(["settings-catalog", "--workspace", fixture.workspace])).settings.find((entry) => entry.key === "execution.dispatchTiers").currentValue);
      assert.equal(savedTiers["claude-code"].main.model, "does-not-exist");
      const probe = row.querySelector("[data-dispatch-probe]");
      probe.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      const result = row.querySelector("[data-dispatch-probe-result]");
      await waitFor(() => result.dataset.state === "error", "the host probe error result");
      assert.match(result.textContent, /HOST_PROBE_EXIT_NONZERO/u);
      assert.match(result.textContent, /host says model missing/u);
      assert.match(result.textContent, /7/u);
    } finally { await page.cleanup(); }
  });


  // STORY-355 GWT3. Evidence boundary, stated plainly rather than overclaimed: this
  // proves the toggle exists, that clicking it flips the two state attributes the CSS
  // keys off (.tcrn-shell-mobile-nav-toggle and the data-mobile-nav-expanded rule
  // inside the 760px block), and that all live nav destinations still reach their
  // section through it. It does NOT prove the CSS actually shows or hides anything at
  // that breakpoint -- linkedom parses and executes script but never runs layout or
  // media queries (INC-148's "against a parsed, executed DOM", not a rendered one).
  // The closest this harness gets to that half of the contract is the static text
  // check of the two rules at the end, which is not a rendering assertion either.
  test("STORY-355 GWT3: the mobile nav toggle flips its state attributes, every destination stays reachable through it, and the 760px rules that gate it are present", async () => {
    const page = await preparePage();
    try {
      const shell = page.document.querySelector(".tcrn-product-shell");
      const toggle = page.document.querySelector("#mobile-nav-toggle");
      const nav = page.document.querySelector("#primary-side-nav");
      assert.ok(shell && toggle && nav, "the shell must expose the mobile nav toggle and the nav it controls");
      assert.equal(toggle.getAttribute("aria-controls"), "primary-side-nav");
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
      assert.equal(shell.getAttribute("data-mobile-nav-expanded"), null, "closed is the unset default -- a server render needs no script to start correct");

      toggle.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(shell.getAttribute("data-mobile-nav-expanded"), "true");
      assert.equal(toggle.getAttribute("aria-expanded"), "true");

      // The live destinations the CSS puts behind this toggle at narrow widths still
      // drive the same section router the always-visible desktop nav always used.
      const destinations = ["dashboard", "settings", "prose", "vocabulary"];
      for (const target of destinations) {
        const navItem = nav.querySelector(`[data-page-target="${target}"]`);
        assert.ok(navItem, `the expanded nav must still carry the ${target} destination`);
        navItem.dispatchEvent(new page.window.Event("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 40));
        for (const section of [...page.document.querySelectorAll("[data-page]")]) {
          assert.equal(section.hidden, section.dataset.page !== target, `[data-page="${section.dataset.page}"] hidden must follow the ${target} navigation`);
        }
      }

      toggle.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(shell.getAttribute("data-mobile-nav-expanded"), "false");
      assert.equal(toggle.getAttribute("aria-expanded"), "false");

      const css = page.document.querySelector('style#tcrn-ds-component-css[data-source="snapshot"]')?.textContent ?? "";
      assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.tcrn-shell-mobile-nav-toggle\s*\{[\s\S]*?display:\s*inline-flex/u,
        "the mobile toggle must become visible inside the 760px breakpoint");
      assert.match(css, /@media \(max-width: 760px\)[\s\S]*?data-mobile-nav-expanded="true"[\s\S]*?\.tcrn-side-nav\s*\{[\s\S]*?display:\s*grid/u,
        "the expanded attribute must be what reveals the side nav inside the 760px breakpoint");
    } finally { await page.cleanup(); }
  });

  test("STORY-379 GWT2/GWT3: work, knowledge, gates, and evolution views are reachable, read-only, and translated", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-page-target="dashboard"]')?.click();
      for (const target of ["work", "knowledge", "gates", "evolution"]) {
        page.document.querySelector(`[data-workspace-tab="${target}"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(page.document.querySelector(`[data-workspace-panel="${target}"]`)?.hidden, false, `${target} panel must be reachable`);
      }
      const evolution = page.document.querySelector('[data-ui="evolution-dashboard"]');
      assert.equal(evolution?.querySelectorAll("button").length, 0, "evolution retirement is read-only and has no confirmation control");
      for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(page.document.documentElement.lang, locale);
        assert.notEqual(page.document.querySelector('[data-i18n="dashboard.evolutionTitle"]')?.textContent, "dashboard.evolutionTitle");
      }
    } finally { await page.cleanup(); }
  });

  // TCRN-CROSS-MIN-225 D3 (TCRN-CROSS-SUB-259): the only automatic retirement left is a --supersedes
  // write, so the evolution panel lists the cards such writes replaced and nothing else: no window,
  // no last sweep, no proposal, no pending count and no button. The wrapper answers knowledge-list
  // with two replaced cards, a manually retired card and a card carrying a v1.2.0 retirement record,
  // and still answers retire-proposals with the old window payload, which the panel must not show.
  test("MIN-225 the evolution panel lists conflict retirements only", async () => {
    const fixture = await scratch("tcrn-min225-evolution-dom-");
    const card = (suffix, subject, updatedAt, extra = {}) => ({ id: `knowledge:000000000000000000000${suffix}`, subject, updatedAt, lifecycle: "active", extensions: {}, ...extra });
    const records = [
      card("a01", "Older card A", "2026-09-20T10:00:00.000Z", { extensions: { supersededBy: "knowledge:000000000000000000000b01" } }),
      card("b01", "Newer card A", "2026-09-20T10:00:00.000Z"),
      card("a02", "Older card B", "2026-09-22T10:00:00.000Z", { extensions: { supersededBy: "knowledge:000000000000000000000b02" } }),
      card("b02", "Newer card B", "2026-09-22T10:00:00.000Z"),
      card("c01", "Manually retired card", "2026-09-21T10:00:00.000Z", { lifecycle: "retired" }),
      card("c02", "Card swept in 1.2.0", "2026-09-21T11:00:00.000Z", { lifecycle: "retired", retirement: { schemaVersion: "tcrn.knowledge-retirement.v1", reason: "zero-retrieval-zero-reference" } }),
    ];
    const listing = { schemaVersion: "tcrn.knowledge-list.v1", reasonCode: "KNOWLEDGE_LIST_READY", total: records.length, truncated: false, records };
    const legacy = {
      reasonCode: "KNOWLEDGE_RETIRE_PROPOSALS_READY",
      windowComplete: false,
      windows: { card: { complete: false, observationDays: 89, missingObservationDays: 1 } },
      idleDays: ["2026-09-01"],
      unprovenDays: ["2026-09-12"],
      proposals: [{ id: "knowledge:000000000000000000000c09", automatic: true, baseDigest: "legacy-digest", retrievalCount: 0, referenceCount: 0 }],
      retiredRecords: [{ id: "knowledge:000000000000000000000c02", retirement: { reason: "zero-retrieval-zero-reference" } }],
      lastSweepAt: "2026-09-24T00:47:10.039Z",
    };
    const wrapper = join(fixture.base, "evolution-wrapper.mjs");
    await writeFile(wrapper, `import { spawnSync } from "node:child_process";
if (process.argv[2] === "knowledge-list") {
  process.stdout.write(${JSON.stringify(JSON.stringify(listing))});
} else if (process.argv[2] === "retire-proposals") {
  process.stdout.write(${JSON.stringify(JSON.stringify(legacy))});
} else {
  const actual = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { encoding: "utf8" });
  process.stdout.write(actual.stdout || "");
  process.stderr.write(actual.stderr || "");
  process.exitCode = actual.status ?? 1;
}
`, "utf8");
    const page = await loadExecutedDom(fixture, { TCRN_WORKFLOW_CLI: wrapper });
    try {
      const dashboard = page.document.querySelector('[data-ui="evolution-dashboard"]');
      const panel = page.document.querySelector("#evolution-retirement");
      const rows = [...panel.querySelectorAll(".tcrn-read-list__row")].map((row) => row.textContent.replace(/\s+/gu, " ").trim());
      assert.equal(rows.length, 2, `only the two replaced cards are listed: ${JSON.stringify(rows)}`);
      assert.match(rows[0], /^Older card B.*knowledge:000000000000000000000a02.*knowledge:000000000000000000000b02.*2026-09-22T10:00:00\.000Z/u, "newest first, with the card, its replacement and the time");
      assert.match(rows[1], /^Older card A.*knowledge:000000000000000000000a01.*knowledge:000000000000000000000b01.*2026-09-20T10:00:00\.000Z/u);
      const text = dashboard.textContent.replace(/\s+/gu, " ");
      for (const absent of [/observation window/iu, /last sweep/iu, /proposal/iu, /pending retirement/iu, /Manually retired card/u, /Card swept in 1\.2\.0/u, /legacy-digest/u]) {
        assert.doesNotMatch(text, absent, `the panel shows no ${absent}`);
      }
      assert.equal(dashboard.querySelectorAll("button").length, 0, "the list is read-only");
      const cells = [...page.document.querySelectorAll("#evolution-stats .tcrn-inline-metric")].map((cell) => cell.textContent.replace(/\s+/gu, " ").trim());
      assert.equal(cells.length, 4, "the stats block keeps its four cells");
      assert.match(cells[3], /^Conflict retirements ?2 ?items$/u, "and counts the conflict retirements in the fourth");
    } finally { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); }
  });

  test("STORY-389: narrow execution cards, status receipts, and French tab labels keep their boundaries", async () => {
    const page = await preparePage();
    try {
      const source = await readFile(join(portalRoot, "index.html"), "utf8");
      assert.match(source, /\.tcrn-dispatch-hosts\s*\{[^}]*display:\s*block;/u);
      assert.match(source, /@media \(max-width: 520px\)[\s\S]*?\.tcrn-app-status-bar__command[\s\S]*?white-space:\s*normal;/u);
      assert.equal(page.document.querySelectorAll("[data-dispatch-host-card]").length, 1);
      page.document.querySelector('[data-locale-option="fr"]')?.click();
      assert.notEqual(page.document.querySelector('[data-workspace-tab="gates"]')?.textContent, page.document.querySelector('[data-workspace-tab="audit"]')?.textContent);
      assert.equal(page.document.querySelector('[data-workspace-tab="audit"]')?.textContent, "Audit");
      page.document.querySelector('[data-locale-option="en"]')?.click();
      assert.equal(page.document.querySelector('[data-workspace-tab="audit"]')?.textContent, "Audit");
      assert.equal(page.document.querySelector('[data-dispatch-tier-row] [data-label]')?.getAttribute("data-label"), "Tier");
      for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
        const effortLabels = [...page.document.querySelectorAll("[data-dispatch-effort]")].map((input) => {
          const label = page.document.querySelector(`label[for="${input.id}"]`);
          const cell = input.closest("[data-label]");
          return { label: label?.textContent.trim(), dataLabel: cell?.getAttribute("data-label") };
        });
        assert.equal(effortLabels.length, 3);
        assert.ok(effortLabels.every(({ label, dataLabel }) => label && dataLabel && label === dataLabel), `${locale} effort fields must share their translated visible and accessible label`);
        if (locale === "en") {
          assert.ok(effortLabels.every(({ label }) => label === "Effort"), "English effort labels must be English");
          assert.ok(effortLabels.every(({ label }) => label !== "Intensité"), "English must not inherit the old French effort label");
        }
      }
    } finally { await page.cleanup(); }
  });
}
