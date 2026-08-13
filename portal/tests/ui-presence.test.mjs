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
  const missing = missingComponents(document);
  assert.deepEqual(missing, [], `rendered DOM components absent: ${JSON.stringify(missing)}`);
  assert.ok(document.querySelector('[data-ui="assignment-addline"] select, [data-ui="assignment-addline"] input, [data-ui="assignment-addline"] button'), "assignment addline must expose controls");
  assert.ok(document.querySelector('[data-ui="receipt-chip"][data-ui-action="open-receipt"]'), "receipt chip must expose its action");
}

async function assertBehaviorContract(page) {
  const { document, window } = page;
  const restoreAll = document.querySelector('[data-ui="persona-restore-all"]');
  assert.ok(restoreAll, "persona full restore must be rendered for the overridden preset");
  assert.equal(restoreAll.dataset.restoreAll, "true", "persona full restore must omit a field selector");
  assert.equal(restoreAll.dataset.restoreField, undefined, "persona full restore must call the no-field engine path");
  restoreAll.click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const chip = document.querySelector('[data-ui="receipt-chip"]');
  const drawer = document.querySelector('[data-ui="receipt-drawer"]');
  chip.click();
  assert.equal(drawer.dataset.open, "true", "receipt chip click must open the drawer");
  assert.equal(drawer.getAttribute("aria-hidden"), "false", "receipt drawer must expose its open state");
  document.querySelector("#drawer-close").click();
  const control = document.querySelector('#settings-rows [data-setting-control]');
  assert.ok(control, "fixture must expose a settings control for the write leg");
  if (control.tagName === "BUTTON") control.click();
  else {
    if (control.tagName === "SELECT") control.value = control.value;
    control.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
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
      assert.match(page.document.querySelector("#health-chip").className, /tcrn-chip--blocked/u);
      assert.equal(page.document.querySelector("#stat-health").textContent, "2/3");
      assert.match(page.document.querySelector("#health-list").textContent, /actor.*failed/iu);
    } finally { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); }
  });

  test("INC-150 vocabulary descriptions are localized in the executed DOM", async () => {
    const page = await preparePage();
    try {
      const locale = page.document.querySelector("#locale-select");
      locale.value = "zh-CN";
      locale.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      const definition = page.document.querySelector(".tcrn-term__definition")?.textContent || "";
      assert.match(definition, /协调受约束的工作流决策|将意图转为可执行计划|检查证据并报告差异/u);
      assert.doesNotMatch(definition, /Coordinates bounded workflow decisions|Turns intent into an executable plan|Checks evidence and reports discrepancies/u);
      assert.equal(page.document.querySelector('[data-i18n="dashboard.chain"]')?.textContent, "链版本");
      assert.ok([...page.document.querySelectorAll("[data-i18n]")].every((node) => node.textContent.trim().length > 0), "every static i18n binding must render text in the executed DOM");
    } finally { await page.cleanup(); }
  });
}
