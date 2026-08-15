// SPDX-License-Identifier: Apache-2.0
// INC-148: the portal contract is evaluated against a parsed, executed DOM.
// linkedom is test-only; portal/index.html remains dependency-free at runtime.

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const execFileAsync = promisify(execFile);
const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const CLI = process.env.TCRN_WORKFLOW_CLI ?? join(portalRoot, "..", "scripts", "tcrn-workflow.mjs");
const MUTATION = process.env.TCRN_UI_MUTATION ?? "";
const COMPONENTS = Object.freeze([
  ["workspace overview/audit tabs", '[data-ui="workspace-tabs"]'],
  ["entity Persona/template tabs", '[data-ui="entity-tabs"]'],
  ["persona custom/preset sections", '[data-ui="persona-section-custom"]'],
  ["persona override dot", '[data-ui="persona-override-dot"]'],
  ["persona locked name hint", '[data-ui="persona-name-lock"]'],
  ["persona more-fields disclosure", '[data-ui="persona-more-fields"]'],
  ["persona factory ghost", '[data-ui="persona-ghost"]'],
  ["persona single-field restore", '[data-ui="persona-restore-field"]'],
  ["persona full restore", '[data-ui="persona-restore-all"]'],
  ["persona model read-only area", '[data-ui="persona-model-readonly"]'],
  ["persona modified badge", '[data-ui="persona-modified-badge"]'],
  ["delete confirmation", '[data-ui="persona-delete-confirm"]'],
  ["prose directory", '[data-ui="prose-directory"]'],
  ["prose line-number gutter", '[data-ui="prose-gutter"]'],
  ["prose finding link", '[data-ui="prose-finding-link"]'],
  ["assignment addline", '[data-ui="assignment-addline"]'],
  ["active plan badge", '[data-ui="plan-active-badge"]'],
  ["workspace paths", '[data-ui="workspace-paths"]'],
  ["path copy control", '[data-ui="path-copy"]'],
  ["partition switcher", '[data-ui="partition-switcher"]'],
  ["engine connection", '[data-ui="engine-connection"]'],
  ["setting modified dot", '[data-ui="setting-modified-dot"]'],
  ["setting dictionary link", '[data-ui="setting-dictionary-link"]'],
  ["returned switch", ".tcrn-switch"],
  ["returned stepper", ".tcrn-stepper"],
  ["returned segmented control", ".tcrn-segmented-nav"],
  ["returned stat card", ".tcrn-stat-card"],
  ["returned setting row", ".tcrn-setting-row"],
  ["returned field provenance", ".tcrn-field-provenance"],
  ["returned line-numbered editor", ".tcrn-line-numbered-editor"],
  ["returned app status bar", ".tcrn-app-status-bar"],
  ["returned definition list", ".tcrn-definition-list"],
  ["returned lock hint", ".tcrn-lock-hint"],
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
  return { base, workspace: roots.workspace, proseRoot };
}

async function writeScratch(fixture, command, args) {
  const status = await cli(["status", "--workspace", fixture.workspace]);
  return cli([command, "--workspace", fixture.workspace, "--expected-version", String(status.version), "--at", nextAt(), "--actor", "agent:test", ...args]);
}

async function seed(fixture) {
  await writeScratch(fixture, "persona-preset-override", ["--name", "Verity", "--fields", JSON.stringify({ mission: "Overridden mission" })]);
  await writeScratch(fixture, "model-plan-set", ["--host", "claude-code", "--name", "budget", "--default-model", "claude-sonnet-4-5"]);
  await writeScratch(fixture, "settings-set", ["--key", "execution.claudeCodeSubagentPlan", "--value", "budget"]);
}

function mutateSource(source, mutation) {
  if (mutation === "assignment-addline") return source.replaceAll('data-ui="assignment-addline"', 'data-ui="assignment-addline-mutated"');
  if (mutation === "persona-ghost-restore") return source.replaceAll('data-ui="persona-ghost"', 'data-ui="persona-ghost-mutated"').replaceAll('data-ui="persona-restore-field"', 'data-ui="persona-restore-field-mutated"').replaceAll('data-ui="persona-restore-all"', 'data-ui="persona-restore-all-mutated"');
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
  const child = spawn(process.execPath, [join(portalRoot, "portal.mjs"), "--workspace", fixture.workspace,
    "--prose-root", fixture.proseRoot, "--port", "0"], {
    env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, ...env },
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
  window.fetch = (path, options = {}) => nativeFetch(new URL(path, url), options);
  const context = vm.createContext(window);
  for (const script of [...document.querySelectorAll("script")]) {
    if (script.src) {
      const scriptSource = await (await nativeFetch(new URL(script.src, url))).text();
      vm.runInContext(scriptSource, context);
    } else if (script.textContent.trim()) {
      vm.runInContext(script.textContent, context);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 900));
  return { child, document, window };
}

function missingComponents(document) {
  return COMPONENTS.filter(([, selector]) => document.querySelectorAll(selector).length === 0)
    .map(([name, selector]) => ({ name, selector }));
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
async function waitFor(predicate, label, timeoutMs = 5_000) {
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
  page.cleanup = async () => { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); };
  page.document.querySelector('[data-persona-name="Verity"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  page.document.querySelector('[data-page-target="settings"]')?.click();
  page.document.querySelector('[data-setting-group="models"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
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
  const returnedRoots = ["tcrn-switch", "tcrn-stat-card", "tcrn-setting-row", "tcrn-field-provenance", "tcrn-line-numbered-editor", "tcrn-app-status-bar", "tcrn-definition-list", "tcrn-lock-hint"];
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
    ["entity section tabs", '[data-ui="entity-tabs"].tcrn-section-tabs'],
    ["surface", ".tcrn-surface"],
    ["detail inspector", "#persona-detail.tcrn-detail-inspector"],
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
  assert.equal(navigationItems.length, 5, "the portal must render the five platform destinations");
  assert.ok(navigationItems.every((button) => button.getAttribute("aria-label")?.trim()), "every destination must expose an accessible name");
  assert.ok(navigationItems.every((button) => button.getAttribute("data-i18n-aria-label")?.trim()), "every destination name must come from the locale table");
  assert.equal(document.querySelector('img.tcrn-brand-mark')?.getAttribute("alt"), "", "the decorative mark must not duplicate the brand accessible name");
  assert.ok(document.querySelector('[data-ui="assignment-addline"] select, [data-ui="assignment-addline"] input, [data-ui="assignment-addline"] button'), "assignment addline must expose controls");
  assert.ok(document.querySelector('[data-ui="receipt-chip"][data-ui-action="open-receipt"]'), "receipt chip must expose its action");
}

async function assertBehaviorContract(page) {
  const { document, window } = page;
  const restoreAll = document.querySelector('[data-ui="persona-restore-all"]');
  assert.ok(restoreAll, "persona full restore must be rendered for the overridden preset");
  assert.equal(restoreAll.dataset.restoreAll, "true", "persona full restore must omit a field selector");
  assert.equal(restoreAll.dataset.restoreField, undefined, "persona full restore must call the no-field engine path");
  const beforeRestore = receiptText(document);
  restoreAll.click();
  await waitFor(receiptAdvanced(document, beforeRestore), "the receipt chip to advance after the persona restore");
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
      assert.match(definition, /协调受约束的工作流决策|将意图转为可执行计划|检查证据并报告差异/u);
      assert.doesNotMatch(definition, /Coordinates bounded workflow decisions|Turns intent into an executable plan|Checks evidence and reports discrepancies/u);
      assert.equal(page.document.querySelector('[data-i18n="dashboard.chain"]')?.textContent, "链版本");
      assert.ok([...page.document.querySelectorAll("[data-i18n]")].every((node) => node.textContent.trim().length > 0), "every static i18n binding must render text in the executed DOM");
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

  test("INC-187 unsetting a setting that is already unset writes nothing, and a bound plan can still be freed", async () => {
    const page = await preparePage();
    try {
      // The plan settings live in the subagent-models group, not the execution group.
      page.document.querySelector('[data-setting-group="models"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      // A host with a single plan renders a two-segment control whose first segment is
      // "unset". Pressing it while nothing is set used to call settings-remove, and the
      // engine refuses to remove a record that does not exist.
      const codexRow = page.document.querySelector('[data-setting-row="execution.codexSubagentPlan"]');
      assert.ok(codexRow, "the execution group must render the Codex plan setting");
      const before = page.document.querySelector("#receipt-chip-text")?.textContent ?? "";
      const unsetControl = [...codexRow.querySelectorAll('[data-setting-control][data-setting-value=""], [data-setting-control]')]
        .find((control) => control.tagName === "BUTTON" ? control.dataset.settingValue === "" : true);
      if (unsetControl?.tagName === "BUTTON") {
        unsetControl.dispatchEvent(new page.window.Event("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        const after = page.document.querySelector("#receipt-chip-text")?.textContent ?? "";
        assert.equal(after, before, "asking to unset what is already unset must not reach the engine at all");
        assert.doesNotMatch(page.document.querySelector("#receipt-body")?.textContent ?? "", /WORKSPACE_INPUT_INVALID/u);
      }

      // The other half: a setting that IS set can be unset, which is what frees a bound
      // plan for removal. The fixture binds "budget" to the Claude Code plan setting.
      const claudeRow = page.document.querySelector('[data-setting-row="execution.claudeCodeSubagentPlan"]');
      const clear = [...claudeRow.querySelectorAll("[data-setting-control]")]
        .find((control) => control.tagName === "BUTTON" && control.dataset.settingValue === "");
      assert.ok(clear, "a bound plan setting must offer a way back to unset");
      const beforeClear = receiptText(page.document);
      clear.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await waitFor(receiptAdvanced(page.document, beforeClear), "the receipt chip to advance after clearing the bound setting");
      assert.match(page.document.querySelector("#receipt-chip-text")?.textContent ?? "", /^✓v\d+$/u, "clearing a bound setting reaches the engine and returns a receipt");
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
      const answerWith = (body, ok = true) => {
        page.window.fetch = (input, options) => {
          const target = String(input);
          if (!target.includes("tcrn-design-authority.json")) return realFetch(input, options);
          return Promise.resolve({ ok, status: ok ? 200 : 404, json: async () => body });
        };
      };

      answerWith({ schemaVersion: "tcrn.design-authority.v1", name: "Example System", version: "9.9.9" });
      const input = page.document.querySelector('[data-setting-control="design.authority"]');
      input.value = "https://design.example.test/";
      input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 700));
      const declared = page.document.querySelector("[data-design-authority-state]");
      assert.equal(declared?.dataset.designAuthorityState, "declared");
      assert.match(declared.textContent, /Example System/u);
      assert.match(declared.textContent, /9\.9\.9/u);
      assert.ok(!declared.className.includes("--warning"), "a contract that answered is not a warning");

      // A response that is not this platform's contract is yellow, not red: the fact is
      // outside this machine, so nothing here can be called false. The message has to
      // say what would turn it green, or a yellow becomes a permanent decoration.
      answerWith({ hello: "world" });
      input.value = "https://other.example.test/";
      input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 700));
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
      input.value = "https://third.example.test/";
      input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 700));
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

      // The markup is the design system's Tooltip: the wrapper declares the scope and
      // forbids interactive content, and the content is a real tooltip role wired to
      // the trigger. The design system's rule reveals it on hover AND focus-within, so
      // the trigger has to be focusable or the keyboard half can never fire.
      assert.equal(tip.getAttribute("data-tooltip-scope"), "supplemental");
      assert.equal(tip.getAttribute("data-tooltip-interactive-content"), "forbidden");
      const trigger = tip.querySelector("button");
      const content = tip.querySelector('[role="tooltip"]');
      assert.ok(trigger && content);
      assert.equal(trigger.getAttribute("aria-describedby"), content.getAttribute("id"));
      assert.ok(trigger.className.includes("tcrn-icon-button"), "the trigger names a design-system button component");
      assert.ok(trigger.querySelector("svg"), "the icon is inline SVG, not a character the shipped font may not have");
      assert.equal(trigger.textContent.trim(), "", "no glyph stands in for the icon");
      assert.equal(content.querySelectorAll("a,button,input,select,textarea").length, 0, "the design system forbids interactive content inside a tooltip");

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

  test("INC-185 the vendor model directory opens as the page's own drawer", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-setting-group="models"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const toggle = page.document.querySelector("#vendor-directory-toggle");
      const drawer = page.document.querySelector("#vendor-directory-drawer");
      assert.ok(toggle && drawer, "the subagent-models surface must carry the trigger and its drawer");
      // Same class as the drawer this page already has, so it inherits that drawer's
      // anchoring and slide rather than carrying a second implementation of them.
      assert.equal(drawer.className, page.document.querySelector("#receipt-drawer").className);
      assert.equal(drawer.getAttribute("data-open"), "false");
      assert.equal(toggle.getAttribute("aria-controls"), "vendor-directory-drawer");

      const links = [...drawer.querySelectorAll("[data-vendor-directory]")];
      assert.deepEqual(links.map((link) => link.dataset.vendorDirectory),
        ["anthropic", "openai", "qwen", "minimax", "deepseek", "kimi", "grok", "gemini", "glm"]);
      // Every link leaves the page safely and carries a design-system class: an <a>
      // with no class is exactly what the interactive-coverage leg cannot see, because
      // this markup is written by the page script rather than shipped in the HTML.
      assert.ok(links.every((link) => link.getAttribute("target") === "_blank"));
      assert.ok(links.every((link) => (link.getAttribute("rel") ?? "").includes("noreferrer")));
      assert.ok(links.every((link) => link.className.includes("tcrn-link-button")));
      assert.ok(links.every((link) => link.getAttribute("href").startsWith("https://")));

      toggle.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      // Three expressions of one state; announcing only aria-expanded would leave the
      // drawer skipped by the readers that follow aria-hidden.
      assert.equal(drawer.getAttribute("data-open"), "true");
      assert.equal(drawer.getAttribute("aria-hidden"), "false");
      assert.equal(toggle.getAttribute("aria-expanded"), "true");

      page.document.querySelector("#vendor-directory-close").dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(drawer.getAttribute("data-open"), "false");
      assert.equal(drawer.getAttribute("aria-hidden"), "true");
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
    } finally { await page.cleanup(); }
  });

  test("S280 portal filters effort options from vocabulary and keeps the receipt chip on the chain", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-setting-group="models"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const effortSelect = page.document.querySelector('[data-assign-effort]');
      assert.ok(effortSelect, "the seeded Claude Code plan must render an effort selector");
      const options = [...effortSelect.querySelectorAll("option")].map((option) => option.value);
      assert.ok(options.includes("high"));
      assert.ok(options.includes("xhigh"));
      assert.ok(!options.includes("minimal"), "Codex-only effort values must not leak into Claude Code");
      assert.ok(!options.includes("none"), "Codex-only effort values must not leak into Claude Code");
      // INC-184: `ultracode` IS a Claude Code level, so host filtering alone would let
      // it through. It is absent because assignment is per persona and this level is
      // a property of the session — the engine refuses it, and the control must not
      // offer what the engine refuses.
      assert.ok(!options.includes("ultracode"), "a session-only level must not be offered as a per-persona assignment");
      assert.ok(!options.includes("ultra"), "a Codex session level must not appear on a Claude Code plan");

      const modelInput = page.document.querySelector('[data-assign-model]');
      const assign = page.document.querySelector('[data-assign]');
      assert.ok(modelInput && assign, "the model plan addline must expose assignment controls");
      modelInput.value = "claude-sonnet-4-5";
      effortSelect.value = "high";
      const beforeAssign = receiptText(page.document);
      assign.click();
      // Two signals, both waited for rather than slept through: the write reaching
      // the chain, and the assignment list re-rendering at all. The row's *content*
      // is then asserted, so a wrong effort value still fails as a diff.
      await waitFor(receiptAdvanced(page.document, beforeAssign), "the receipt chip to advance past the written version");
      const assignment = await waitFor(
        () => page.document.querySelector(".tcrn-assignment")?.textContent || null,
        "the assignment row to re-render after the write",
      );

      assert.match(page.document.querySelector("#receipt-chip-text")?.textContent ?? "", /^✓v\d+$/u);
      assert.match(assignment, /Effort: high/u);
    } finally { await page.cleanup(); }
  });
}
