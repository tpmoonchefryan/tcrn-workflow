// SPDX-License-Identifier: Apache-2.0
// Portal integration tests use the real CLI and a real governed scratch tree.

import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const CLI = process.env.TCRN_WORKFLOW_CLI ?? join(portalRoot, "..", "scripts", "tcrn-workflow.mjs");
const RETIRED_PERSONA_ACTIONS = Object.freeze({
  override: ["persona", "-preset-override"].join(""),
  restore: ["persona", "-preset-restore"].join(""),
  set: ["persona", "-set"].join(""),
  remove: ["persona", "-remove"].join(""),
});

async function cli(args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 32e6 });
  return JSON.parse(stdout);
}

// TCRN-CROSS-INC-386: the portal and every CLI it starts read and write machine settings
// under HOME, so every portal child gets a scratch HOME inside its fixture, removed with it.
async function scratchHome(base) {
  const home = join(base, "home");
  await mkdir(home, { recursive: true });
  return home;
}

async function scratch(prefix, externalKey) {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const home = await scratchHome(base);
  const roots = {};
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots[kind] = await realpath(path);
  }
  await cli(["init", "--workspace", roots.workspace, "--framework", roots.framework, "--transient", roots.transient,
    "--evidence-locator", roots["evidence-locator"], "--release-trust", roots["release-trust"],
    "--external-key", externalKey, "--at", "2026-08-11T15:00:00Z"]);
  const proseRoot = join(base, "prose");
  await mkdir(proseRoot);
  return { base, workspace: roots.workspace, proseRoot, home };
}

async function startPortal({ workspace, container, proseRoot, home, env = {} }) {
  assert.ok(home, "every portal child needs a scratch HOME inside its fixture (TCRN-CROSS-INC-386)");
  const args = [join(portalRoot, "portal.mjs")];
  if (container) args.push("--container", container);
  else args.push("--workspace", workspace);
  if (proseRoot) args.push("--prose-root", proseRoot);
  args.push("--port", "0");
  const child = spawn(process.execPath, args, {
    env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, ...env, HOME: home },
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

async function readBoot(url) {
  const page = await (await fetch(url)).text();
  assert.ok(!page.includes("__PORTAL_BOOT__"));
  return { page, boot: JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]) };
}

function request(url, path, options) { return fetch(new URL(path, url), options).then(async (response) => ({ response, body: await response.json() })); }
function writeOptions(token, method, body) { return { method, headers: { "content-type": "application/json", "x-portal-token": token }, body: JSON.stringify(body) }; }
function readOptions(token) { return { headers: { "x-portal-token": token } }; }

// STORY-355 GWT1: `fetch` (undici) never forwards a caller-supplied Host header — it
// always sends the header that matches the real socket target, which defeats the one
// thing this needs to prove. `node:http`'s request() has no such guard, so it is the
// only way to simulate the DNS-rebinding shape: a real loopback TCP connection carrying
// a forged Host header, exactly what an attacker-controlled page can make a browser send.
function rawRequest(url, path, { host, headers = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(path, url);
    const req = httpRequest(target, { headers: { ...headers, ...(host === undefined ? {} : { host }) } }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolvePromise({ status: response.statusCode, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("portal boots from the live engine and exposes the new read surfaces", async (t) => {
  const fixture = await scratch("tcrn-portal-read-", "TCRN-PORTAL-READ");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  assert.equal(boot.partitionMode, false);
  assert.match(page, /data-page="dashboard"/u);
  assert.match(page, /data-page="vocabulary"/u);

  const settings = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(settings.body.reasonCode, "SETTINGS_CATALOG_READY");
  assert.deepEqual(settings.body.settings.filter((entry) => entry.key.includes("SubagentPlan")).map((entry) => entry.key), ["execution.claudeCodeSubagentPlan", "execution.codexSubagentPlan"]);
  const execution = await request(url, "/api/execution", readOptions(boot.token));
  assert.equal(execution.body.reasonCode, "PORTAL_EXECUTION_READY");
  assert.ok(Array.isArray(execution.body.plans));
  assert.equal(Object.hasOwn(execution.body, "personas"), false);
  const dictionary = await request(url, "/api/vocabulary", readOptions(boot.token));
  assert.equal(dictionary.body.reasonCode, "VOCABULARY_READY");
  assert.equal(Object.hasOwn(dictionary.body, "roles"), false);
  assert.equal(Object.hasOwn(dictionary.body, "efforts"), false);
  assert.ok(dictionary.body.hosts.includes("codex"));
});

test("STORY-379 read views use CLI projections and keep partial data visible", async (t) => {
  const fixture = await scratch("tcrn-portal-views-", "TCRN-PORTAL-VIEWS");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  for (const tab of ["work", "knowledge", "gates", "evolution"]) assert.match(page, new RegExp(`data-workspace-tab="${tab}"`, "u"));

  const work = await request(url, "/api/work", readOptions(boot.token));
  assert.equal(work.body.reasonCode, "PORTAL_WORK_READY");
  assert.ok(Array.isArray(work.body.records));
  const knowledge = await request(url, "/api/knowledge", readOptions(boot.token));
  assert.match(knowledge.body.reasonCode, /^PORTAL_KNOWLEDGE_/u);
  assert.ok(Array.isArray(knowledge.body.records));
  const gates = await request(url, "/api/gates", readOptions(boot.token));
  assert.equal(gates.body.reasonCode, "PORTAL_GATES_READY");
  assert.ok(Array.isArray(gates.body.records));
  const evolution = await request(url, "/api/evolution", readOptions(boot.token));
  assert.equal(evolution.body.reasonCode, "PORTAL_EVOLUTION_READY");
  assert.ok(evolution.body.retrievalEval.reasonCode);
  assert.ok(Object.hasOwn(evolution.body, "modeStats"));
  assert.ok(Array.isArray(evolution.body.hosts));

  const untokened = await request(url, "/api/evolution");
  assert.equal(untokened.response.status, 403);
  assert.equal(untokened.body.reasonCode, "PORTAL_TOKEN_REQUIRED");
});

// TCRN-CROSS-MIN-225 D3 (TCRN-CROSS-SUB-259): the evolution projection pages through knowledge-list
// until the list is no longer truncated and never asks retire-proposals, which proposes nothing now.
// The recording CLI serves knowledge-list in pages of four records, standing in for a store larger
// than one page, so the eleven cards below take three pages; every call's arguments are logged.
test("MIN-225 the evolution projection reads every page of the knowledge list and never calls retire-proposals", async (t) => {
  const fixture = await scratch("tcrn-portal-min225-", "FIXTURE-TCRN-PORTAL-MIN225");
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  await cli(["project-create", "--workspace", fixture.workspace, "--expected-version", "0", "--at", "2026-09-20T09:00:00Z", "--external-key", "FIXTURE-PORTAL-MIN225-PROJECT", "--name", "MIN-225"]);
  await cli(["knowledge-init", "--workspace", fixture.workspace]);
  const capture = (subject, extra = []) => cli(["knowledge-capture", "--workspace", fixture.workspace, "--at", "2026-09-20T10:00:00Z",
    "--subject", subject, "--summary", `${subject} summary`, "--snippet", `${subject} snippet`, "--tags", "min225",
    "--accountable-owner-id", "owner:portal-min225", "--body", `${subject} body`, "--coexist", "true", ...extra]);
  const originals = [];
  for (let index = 0; index < 5; index += 1) originals.push(await capture(`MIN-225 original card ${index}`));
  const replacements = [];
  for (let index = 0; index < 3; index += 1) replacements.push(await capture(`MIN-225 replacement card ${index}`, ["--supersedes", originals[index].id]));
  for (let index = 0; index < 3; index += 1) await capture(`MIN-225 unrelated card ${index}`);
  const log = join(fixture.base, "cli-calls.ndjson");
  const recorder = join(fixture.base, "recording-cli.mjs");
  await writeFile(recorder, `import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const forwarded = args[0] === "knowledge-list" ? args.map((value, index) => (args[index - 1] === "--limit" ? "4" : value)) : args;
const actual = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...forwarded], { encoding: "utf8", maxBuffer: 32e6 });
process.stdout.write(actual.stdout || "");
process.stderr.write(actual.stderr || "");
process.exitCode = actual.status ?? 1;
`, "utf8");
  const { child, url } = await startPortal({ ...fixture, env: { TCRN_WORKFLOW_CLI: recorder } });
  t.after(() => child.kill());
  const { boot } = await readBoot(url);
  const evolution = await request(url, "/api/evolution", readOptions(boot.token));
  assert.equal(evolution.body.reasonCode, "PORTAL_EVOLUTION_READY");
  assert.equal(evolution.body.conflictRetirementCount, 3, "every replaced card is counted, beyond the default page of eight");
  assert.deepEqual(evolution.body.conflictRetirements.map((entry) => [entry.id, entry.supersededBy]).sort(), originals.slice(0, 3).map((card, index) => [card.id, replacements[index].id]).sort());
  for (const field of ["retirement", "pendingRetirementCount", "retiredCount"]) assert.equal(Object.hasOwn(evolution.body, field), false, field);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.some((args) => args[0] === "retire-proposals"), false, "retire-proposals is never called");
  const pages = calls.filter((args) => args[0] === "knowledge-list" && args.includes("--offset")).map((args) => Number(args[args.indexOf("--offset") + 1]));
  assert.deepEqual(pages, [0, 4, 8], "the list is read page by page until it is no longer truncated");
});

test("portal writes use actor plus live CAS, then return readback and session audit", async (t) => {
  const fixture = await scratch("tcrn-portal-write-", "TCRN-PORTAL-WRITE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);

  const untokened = await request(url, "/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "backup.cadence", value: "manual" }) });
  assert.equal(untokened.response.status, 403);
  assert.equal(untokened.body.reasonCode, "PORTAL_TOKEN_REQUIRED");

  const setting = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "backup.cadence", value: "manual" }));
  assert.equal(setting.response.status, 200);
  assert.equal(setting.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(setting.body.readback.currentValue, "manual");

  const tiers = await request(url, "/api/settings", writeOptions(boot.token, "POST", {
    key: "execution.dispatchTiers",
    value: JSON.stringify({ "claude-code": { flagship: null, main: { model: "opus-5", effort: "xhigh2" }, economy: null } }),
  }));
  assert.equal(tiers.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  const classes = await request(url, "/api/settings", writeOptions(boot.token, "POST", {
    key: "execution.dispatchClasses",
    value: JSON.stringify({ "review-visual": { dispatch: true, verify: false } }),
  }));
  assert.equal(classes.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  const modes = await request(url, "/api/settings", writeOptions(boot.token, "POST", {
    key: "execution.dispatchModes",
    value: JSON.stringify({ custom: { "review-visual": "main" } }),
  }));
  assert.equal(modes.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  const retired = await request(url, "/api/execution", writeOptions(boot.token, "POST", { action: "model-plan-set", host: "claude-code", name: "daily", defaultModel: "opus-5" }));
  assert.equal(retired.response.status, 409);
  assert.equal(retired.body.reasonCode, "PORTAL_UNKNOWN_ACTION");
  const active = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.dispatchMode", value: "custom" }));
  assert.equal(active.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  const retiredPersona = await request(url, "/api/execution", writeOptions(boot.token, "POST", { action: RETIRED_PERSONA_ACTIONS.override, name: "Verity", fields: { mission: "Review governed evidence", role: "reviewer" } }));
  assert.equal(retiredPersona.response.status, 409);
  assert.equal(retiredPersona.body.reasonCode, "PORTAL_UNKNOWN_ACTION");

  const audit = await request(url, "/api/session-audit", readOptions(boot.token));
  assert.equal(audit.body.reasonCode, "PORTAL_SESSION_AUDIT_READY");
  assert.equal(audit.body.writes.length, 7);
  assert.equal(audit.body.writes.filter((entry) => entry.ok).length, 5);
  assert.equal(audit.body.writes.find((entry) => entry.action === "model-plan-set").ok, false);
  assert.ok(audit.body.writes.every((entry) => entry.action && entry.occurredAt));
});

// STORY-403 replaces the old STORY-366 manual-writing interaction while retaining
// the native CLI/data contract tested by this same integration case.
test("STORY-366: the article endpoint uses knowledge-store CAS and returns the engine receipt unchanged", async (t) => {
  const fixture = await scratch("tcrn-portal-article-", "TCRN-PORTAL-ARTICLE");
  await cli(["project-create", "--workspace", fixture.workspace, "--expected-version", "0", "--at", "2026-08-11T15:00:01Z", "--external-key", "PORTAL-ARTICLE-PROJECT", "--name", "Articles"]);
  await cli(["knowledge-init", "--workspace", fixture.workspace, "--acknowledge-disposable", "true"]);
  const native = await cli(["knowledge-article-create", "--workspace", fixture.workspace, "--expected-version", "0", "--at", "2026-08-11T15:00:01Z", "--path", "portal-article.md", "--category", "architecture", "--title", "Agent article", "--summary", "Agent article summary", "--content", "Agent article body", "--accountable-owner-id", "owner:portal", "--evidence-ids", "evidence:portal-article"]);
  assert.equal(native.reasonCode, "KNOWLEDGE_ARTICLE_CREATED");
  assert.equal(await readFile(native.path, "utf8").then((text) => text.includes("Agent article body")), true);
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  assert.doesNotMatch(page, /data-page="articles"/u);
  assert.doesNotMatch(page, /article-form|knowledge-article-create/iu);
  assert.match(page, /data-workspace-tab="knowledge"/u);
  const knowledge = await request(url, "/api/knowledge", readOptions(boot.token));
  const article = knowledge.body.records.find((record) => record.subject === "Agent article");
  assert.ok(article, "the native article must remain in the knowledge index");
  assert.deepEqual(article.sourceReferences, ["portal-article.md"]);
  const body = await request(url, `/api/knowledge/body?id=${encodeURIComponent(article.id)}`, readOptions(boot.token));
  assert.equal(body.response.status, 200);
  assert.match(body.body.body, /Source: portal-article\.md/u);
  const refused = await request(url, "/api/knowledge/articles", writeOptions(boot.token, "POST", { title: "Manual article", category: "architecture", content: "must not write" }));
  assert.equal(refused.response.status, 404);
  assert.equal(refused.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
});

test("state surface follows engine version and turns health red on failed status/actor legs", async (t) => {
  const fixture = await scratch("tcrn-portal-state-", "TCRN-PORTAL-STATE");
  const wrapper = join(fixture.base, "status-wrapper.mjs");
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
  const { child, url } = await startPortal({ ...fixture, env: { TCRN_WORKFLOW_CLI: wrapper } });
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const status = await request(url, "/api/status", readOptions(boot.token));
  assert.equal(status.body.engineVersion, "0.11.99");
  assert.equal(status.body.ok, true);

  child.kill();
  const actorPortal = await startPortal({ ...fixture, env: { TCRN_PORTAL_ACTOR: "   " } });
  t.after(() => actorPortal.child.kill());
  const { boot: actorBoot } = await readBoot(actorPortal.url);
  const actorStatus = await request(actorPortal.url, "/api/status", readOptions(actorBoot.token));
  assert.equal(actorStatus.body.ok, false);
  assert.deepEqual(actorStatus.body.checks.find((check) => check.key === "actor"), { key: "actor", ok: false, reasonCode: "PORTAL_ACTOR_MISSING" });
});

test("AGENTS.md read/write is allow-listed and reconciliation reports line-level findings", async (t) => {
  const fixture = await scratch("tcrn-portal-agents-", "TCRN-PORTAL-AGENTS");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const text = "# rules\n\nSet backup.cadence before close.\n";
  const written = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "AGENTS.md", text }));
  assert.equal(written.body.reasonCode, "PORTAL_AGENTS_MD_WRITTEN");
  assert.equal(written.body.matches, true);
  assert.equal(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), text);
  const green = await request(url, "/api/agents-md/reconcile", readOptions(boot.token));
  assert.equal(green.body.ok, true);
  assert.equal(green.body.findings.length, 0);

  await writeFile(join(fixture.proseRoot, "AGENTS.md"), `${text}\nAlso set backup.retiredKey.\n`, "utf8");
  const red = await request(url, "/api/agents-md/reconcile", readOptions(boot.token));
  assert.equal(red.body.ok, false);
  assert.equal(red.body.findings[0].kind, "unregistered");
  assert.equal(red.body.findings[0].line, 5);

  const escapedRead = await request(url, "/api/agents-md?file=" + encodeURIComponent("../AGENTS.md"), readOptions(boot.token));
  assert.equal(escapedRead.response.status, 404);
  assert.equal(escapedRead.body.reasonCode, "PORTAL_PATH_ESCAPE");
  const escapedWrite = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "../AGENTS.md", text: "no" }));
  assert.equal(escapedWrite.response.status, 404);
  assert.equal(escapedWrite.body.reasonCode, "PORTAL_PATH_ESCAPE");
});

test("container mode lists partitions and changes the selected live target", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-container-")));
  const container = join(base, ".tcrn-workspace");
  await mkdir(container);
  const partitions = [];
  for (const id of ["alpha", "beta"]) {
    const root = join(container, id);
    await mkdir(root);
    const roots = {};
    for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) { const path = join(root, kind); await mkdir(path); roots[kind] = path; }
    await cli(["init", "--workspace", roots.workspace, "--framework", roots.framework, "--transient", roots.transient, "--evidence-locator", roots["evidence-locator"], "--release-trust", roots["release-trust"], "--external-key", `TCRN-PORTAL-${id}`, "--at", "2026-08-11T15:00:00Z"]);
    partitions.push({ id, workspace: roots.workspace });
  }
  const { child, url } = await startPortal({ container, home: await scratchHome(base) });
  t.after(async () => { child.kill(); await rm(base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const partitionRead = await request(url, "/api/partitions", readOptions(boot.token));
  assert.deepEqual(partitionRead.body.partitions.map((entry) => entry.id), ["alpha", "beta"]);
  const selected = await request(url, "/api/partition", writeOptions(boot.token, "POST", { partition: "beta" }));
  assert.equal(selected.body.reasonCode, "PORTAL_PARTITION_SELECTED");
  assert.equal(selected.body.selectedPartition, "beta");
});

test("portal serves live catalog, commits a governed write, and refuses an untokened one", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-read-", "TCRN-PORTAL-CONSERVATION-READ");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  assert.ok(!page.includes("__PORTAL_BOOT__"));
  assert.ok(boot.token.length >= 32);
  const catalog = await request(url, "/api/settings", readOptions(boot.token));
  const engineCatalog = await cli(["settings-catalog", "--workspace", fixture.workspace]);
  assert.deepEqual(catalog.body.settings, engineCatalog.settings);
  assert.ok(!page.includes("gate-close"));
  assert.match(page, /data-setting-control/u);
  assert.ok(catalog.body.settings.every((entry) => entry.controlType));
  const untokened = await request(url, "/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "backup.cadence", value: "manual" }) });
  assert.equal(untokened.response.status, 403);
  assert.equal(untokened.body.reasonCode, "PORTAL_TOKEN_REQUIRED");
  const committed = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "backup.cadence", value: "manual" }));
  assert.equal(committed.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(committed.body.setting.value, "manual");
  assert.equal(committed.body.readback.currentValue, "manual");
  assert.ok(committed.body.receiptDigest && committed.body.headEventHash);
  const refused = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "bogus.key", value: "x" }));
  assert.equal(refused.response.status, 409);
  assert.equal(refused.body.reasonCode, "SETTINGS_KEY_UNREGISTERED");
  const status = await request(url, "/api/status", readOptions(boot.token));
  assert.equal(status.body.checks.length, 3);
  assert.ok(status.body.checks.every((check) => check.ok));
  const commands = await request(url, "/api/commands", readOptions(boot.token));
  assert.ok(commands.body.commands.some((entry) => entry.name === "settings-set" && entry.mutates));
});

test("reconciliation goes red when prose names an unregistered key, and green once repaired", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-reconcile-", "TCRN-PORTAL-CONSERVATION-RECONCILE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const greenText = "# AGENTS.md\n\nSet backup.cadence before close.\n";
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), greenText, "utf8");
  const green = await request(url, "/api/agents-md/reconcile", readOptions(boot.token));
  assert.equal(green.body.ok, true);
  assert.equal(green.body.findings.length, 0);
  assert.ok(green.body.rows.some((row) => row.key === "backup.cadence" && row.registered));
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), `${greenText}\nAlso set backup.retiredKey.\n`, "utf8");
  const red = await request(url, "/api/agents-md/reconcile", readOptions(boot.token));
  assert.equal(red.body.ok, false);
  assert.equal(red.body.findings[0].kind, "unregistered");
  assert.equal(red.body.findings[0].line, 5);
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), greenText, "utf8");
  assert.equal((await request(url, "/api/agents-md/reconcile", readOptions(boot.token))).body.ok, true);
});

test("prose surface writes the file and reads it back", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-prose-", "TCRN-PORTAL-CONSERVATION-PROSE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const text = "# AGENTS.md\n\nOwner actions stay parked.\n";
  const written = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "AGENTS.md", text }));
  assert.equal(written.body.reasonCode, "PORTAL_AGENTS_MD_WRITTEN");
  assert.equal(written.body.matches, true);
  assert.equal(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), text);
  const readback = await request(url, "/api/agents-md", readOptions(boot.token));
  assert.equal(readback.body.text, text);
  assert.equal(readback.body.path, join(fixture.proseRoot, "AGENTS.md"));
  const escapedRead = await request(url, "/api/agents-md?file=" + encodeURIComponent("../AGENTS.md"), readOptions(boot.token));
  assert.equal(escapedRead.response.status, 404);
  assert.equal(escapedRead.body.reasonCode, "PORTAL_PATH_ESCAPE");
  const escapedWrite = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "../AGENTS.md", text: "no" }));
  assert.equal(escapedWrite.response.status, 404);
  assert.equal(escapedWrite.body.reasonCode, "PORTAL_PATH_ESCAPE");
});

test("the page boots with the shipped locale contract and needs nothing outside the portal", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-locale-", "TCRN-PORTAL-CONSERVATION-LOCALE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.ok(!page.includes("__PORTAL_BOOT__"));
  const boot = JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]);
  const { LOCALE_CONTRACT } = await import("../locale-contract.mjs");
  assert.deepEqual(boot.supportedLocales, [...LOCALE_CONTRACT.supportedLocales]);
  assert.equal(boot.fallbackLocale, LOCALE_CONTRACT.fallbackLocale);
  assert.equal(boot.localeMetadata.length, LOCALE_CONTRACT.localeMetadata.length);
  assert.ok(boot.localeMetadata.every((entry) => entry.nativeName.length > 0));
  const locales = await (await fetch(new URL("/locales.js", url))).text();
  assert.match(locales, /window\.PORTAL_LOCALES/u);
  for (const locale of LOCALE_CONTRACT.supportedLocales) assert.ok(locales.includes(`"${locale}"`) || locales.includes(`${locale}:`));
});

test("container mode lists every partition and switches the live target", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-conservation-container-")));
  const container = join(base, ".tcrn-workspace");
  await mkdir(container);
  const partitions = [];
  for (const id of ["alpha", "beta"]) {
    const root = join(container, id);
    await mkdir(root);
    const roots = {};
    for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) { const path = join(root, kind); await mkdir(path); roots[kind] = path; }
    await cli(["init", "--workspace", roots.workspace, "--framework", roots.framework, "--transient", roots.transient, "--evidence-locator", roots["evidence-locator"], "--release-trust", roots["release-trust"], "--external-key", `TCRN-PORTAL-CONSERVATION-${id}`, "--at", "2026-08-11T15:00:00Z"]);
    partitions.push({ id, workspace: roots.workspace });
  }
  const { child, url } = await startPortal({ container, home: await scratchHome(base) });
  t.after(async () => { child.kill(); await rm(base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  assert.equal(boot.partitionMode, true);
  assert.deepEqual(boot.partitions.map((entry) => entry.id), ["alpha", "beta"]);
  const listed = await request(url, "/api/partitions", readOptions(boot.token));
  assert.deepEqual(listed.body.partitions.map((entry) => entry.id), ["alpha", "beta"]);
  const selected = await request(url, "/api/partition", writeOptions(boot.token, "POST", { partition: "beta" }));
  assert.equal(selected.body.reasonCode, "PORTAL_PARTITION_SELECTED");
  assert.equal(selected.body.selectedPartition, "beta");
  assert.equal(selected.body.workspace, partitions[1].workspace);
  // STORY-355: prose is not partitioned, so switching the selected partition must not
  // move where the Rules page reads from -- the default stays pinned above the chain
  // container regardless of which partition is currently selected.
  assert.equal(selected.body.proseRoot, dirname(container));
  const catalog = await request(url, "/api/settings", readOptions(boot.token));
  assert.deepEqual(catalog.body.settings, (await cli(["settings-catalog", "--workspace", partitions[1].workspace])).settings);
});

test("launcher generation emits regular files, starts macOS launcher, and names a vanished container", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-conservation-launchers-")));
  const container = join(base, ".tcrn-workspace");
  const proseRoot = join(base, "prose");
  await mkdir(container);
  await mkdir(proseRoot);
  for (const id of ["alpha", "beta"]) {
    const root = join(container, id);
    await mkdir(root);
    const roots = {};
    for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust", "attestations"]) { const path = join(root, kind); await mkdir(path); roots[kind] = path; }
    await cli(["init", "--workspace", roots.workspace, "--framework", roots.framework, "--transient", roots.transient, "--evidence-locator", roots["evidence-locator"], "--release-trust", roots["release-trust"], "--external-key", `TCRN-PORTAL-LAUNCH-${id}`, "--at", "2026-08-11T15:00:00Z"]);
  }
  const outputDir = join(base, "launchers");
  await mkdir(outputDir);
  t.after(() => rm(base, { recursive: true, force: true }));
  const generator = join(portalRoot, "scripts", "generate-launchers.mjs");
  const report = JSON.parse((await execFileAsync(process.execPath, [generator, "--container", container, "--output-dir", outputDir, "--prose-root", proseRoot, "--port", "0"], { encoding: "utf8" })).stdout);
  assert.equal(report.reasonCode, "PORTAL_LAUNCHERS_GENERATED");
  assert.equal(report.symlinks, false);
  assert.equal(report.files.length, 3);
  for (const file of report.files) { assert.equal((await lstat(file)).isFile(), true); assert.equal((await lstat(file)).isSymbolicLink(), false); assert.match(await readFile(file, "utf8"), /--container/u); }
  const command = report.files.find((file) => file.endsWith(".command"));
  assert.match(await readFile(command, "utf8"), /^#!\/bin\/sh/u);
  const home = await scratchHome(base);
  const launcher = spawn(command, [], { env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => launcher.kill());
  const url = await new Promise((resolve, reject) => { let buffer = ""; const timer = setTimeout(() => reject(new Error(`launcher timeout: ${buffer}`)), 15000); launcher.stdout.on("data", (chunk) => { buffer += chunk; const line = buffer.split("\n").find((entry) => entry.includes("PORTAL_LISTENING")); if (line) { clearTimeout(timer); resolve(JSON.parse(line).url); } }); launcher.on("exit", (code) => { clearTimeout(timer); reject(new Error(`launcher exited ${code}: ${buffer}`)); }); });
  const { boot: launcherBoot } = await readBoot(url);
  assert.equal((await request(url, "/api/partitions", readOptions(launcherBoot.token))).body.partitions.length, 2);
  const vanished = join(base, "vanished-container");
  const badOutput = join(base, "bad-launchers");
  await mkdir(badOutput);
  await execFileAsync(process.execPath, [generator, "--container", vanished, "--output-dir", badOutput, "--prose-root", proseRoot, "--port", "0"], { encoding: "utf8" });
  let failure;
  try { await execFileAsync(join(badOutput, "tcrn-workflow-portal.sh"), [], { encoding: "utf8", env: { ...process.env, HOME: home } }); } catch (error) { failure = error; }
  assert.ok(failure);
  assert.match(String(failure.stderr), /PORTAL_CONTAINER_UNAVAILABLE/u);
});

test("i18n proof turns red when the engine drops enum allowedValues", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-conservation-i18n-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const shim = join(base, "strip-catalog.mjs");
  await writeFile(shim, `import { execFileSync } from "node:child_process"; const output = execFileSync(process.execPath, [process.env.TCRN_REAL_CLI, ...process.argv.slice(2)], { encoding: "utf8" }); const body = JSON.parse(output); if (process.argv[2] === "settings-catalog") for (const entry of body.settings ?? []) delete entry.allowedValues; process.stdout.write(JSON.stringify(body));\n`, "utf8");
  let failure;
  try { await execFileAsync(process.execPath, [join(portalRoot, "scripts", "i18n-proof.mjs")], { encoding: "utf8", env: { ...process.env, TCRN_WORKFLOW_CLI: shim, TCRN_REAL_CLI: CLI } }); } catch (error) { failure = error; }
  assert.ok(failure);
  const report = JSON.parse(failure.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.reasonCode, "I18N_CONTRACT_VIOLATION");
  const leg = report.legs.find((entry) => entry.leg === "setting-descriptions");
  assert.equal(leg.reasonCode, "SETTING_ENUM_VALUES_GAP");
  assert.ok(leg.enumMissingAllowedValues.includes("backup.cadence"));
  assert.ok(leg.enumMissingAllowedValues.includes("execution.subagentPolicy"));
});

test("i18n full-table proof turns red when an existing translation regresses", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-i18n-full-table-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePath = join(base, "locales-mutated.js");
  const source = await readFile(join(portalRoot, "locales.js"), "utf8");
  await writeFile(sourcePath, source.replace('"receipt.title": "エンジンのレシート"', '"receipt.title": "Engine receipt"'), "utf8");
  let failure;
  try {
    await execFileAsync(process.execPath, [join(portalRoot, "scripts", "i18n-proof.mjs")], { encoding: "utf8", env: { ...process.env, TCRN_PORTAL_LOCALES_SOURCE: sourcePath } });
  } catch (error) { failure = error; }
  assert.ok(failure);
  const report = JSON.parse(failure.stdout);
  const leg = report.legs.find((entry) => entry.leg === "translation-full-table");
  assert.equal(leg.reasonCode, "FULL_LOCALE_TABLE_REALITY_GAP");
  assert.ok(leg.problems.some((problem) => problem.locale === "ja" && problem.unexpected.includes("receipt.title")));
});

test("execution surface: the owner scenario end to end with the engine", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-execution-", "TCRN-PORTAL-CONSERVATION-EXECUTION");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const post = async (payload) => request(url, "/api/execution", writeOptions(boot.token, "POST", payload));
  const refusedWrite = await post({ action: "model-plan-set", host: "claude-code", name: "owner-scenario", defaultModel: "opus-5" });
  assert.equal(refusedWrite.response.status, 409);
  assert.equal(refusedWrite.body.reasonCode, "PORTAL_UNKNOWN_ACTION");
  const historical = await request(url, "/api/execution", readOptions(boot.token));
  assert.deepEqual(historical.body.plans, []);
  const active = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.dispatchMode", value: "eco" }));
  assert.equal(active.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  const readback = await request(url, "/api/execution", readOptions(boot.token));
  assert.deepEqual(readback.body.plans, []);
  assert.equal(readback.body.settings.find((entry) => entry.key === "execution.dispatchMode").currentValue, "eco");
  const audit = await request(url, "/api/session-audit", readOptions(boot.token));
  assert.equal(audit.body.writes.find((entry) => entry.action === "model-plan-set").ok, false);
});

test("STORY-370 the retired identity surface is absent while execution policy remains writable", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-cards-", "TCRN-PORTAL-CONSERVATION-CARDS");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  const post = async (payload) => request(url, "/api/execution", writeOptions(boot.token, "POST", payload));
  const initial = await request(url, "/api/execution", readOptions(boot.token));
  assert.equal(Object.hasOwn(initial.body, "personas"), false);
  assert.doesNotMatch(page, /<section[^>]+data-page="entities"/u);
  assert.doesNotMatch(page, /<section[^>]+data-page="entities"/u);
  const override = await post({ action: RETIRED_PERSONA_ACTIONS.override, name: "Verity", fields: { mission: "temporary portal override", role: "reviewer" } });
  assert.equal(override.body.reasonCode, "PORTAL_UNKNOWN_ACTION");
  const restoreAll = await post({ action: RETIRED_PERSONA_ACTIONS.restore, name: "Verity" });
  assert.equal(restoreAll.body.reasonCode, "PORTAL_UNKNOWN_ACTION");
  const custom = await post({ action: RETIRED_PERSONA_ACTIONS.set, name: "Portal auditor", role: "reviewer", mission: "Review exact evidence", refusals: "No unsupported claims" });
  assert.equal(custom.body.reasonCode, "PORTAL_UNKNOWN_ACTION");
  const refused = await post({ action: RETIRED_PERSONA_ACTIONS.remove, name: "Portal auditor" });
  assert.equal(refused.body.reasonCode, "PORTAL_UNKNOWN_ACTION");
  const policy = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.subagentPolicy", value: "forbidden" }));
  assert.equal(policy.body.setting.value, "forbidden");
  assert.equal(Object.hasOwn((await request(url, "/api/execution", readOptions(boot.token))).body, "personas"), false);
});

test("STORY-355 GWT1+GWT2: a forged Host header is refused on every route, and the token now guards every GET under /api/", async (t) => {
  const fixture = await scratch("tcrn-portal-security-", "TCRN-PORTAL-SECURITY");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);

  // GWT1: a DNS-rebinding-style Host header is rejected before any route runs at all,
  // including "/" -- the real TCP connection still lands on loopback (rawRequest talks
  // to the portal's actual address), only the Host header is forged.
  const rootForged = await rawRequest(url, "/", { host: "attacker.example" });
  assert.equal(rootForged.status, 403);
  assert.equal(rootForged.body.reasonCode, "PORTAL_HOST_REJECTED");
  const prefixForged = await rawRequest(url, "/api/settings", { host: "127.0.0.1.attacker.example" });
  assert.equal(prefixForged.status, 403);
  assert.equal(prefixForged.body.reasonCode, "PORTAL_HOST_REJECTED");
  const badPort = await rawRequest(url, "/api/settings", { host: "127.0.0.1:notaport" });
  assert.equal(badPort.status, 403);
  assert.equal(badPort.body.reasonCode, "PORTAL_HOST_REJECTED");
  const upperLocalhost = await rawRequest(url, "/api/settings", { host: "LOCALHOST", headers: { "x-portal-token": boot.token } });
  assert.equal(upperLocalhost.status, 200);

  // GWT2: token coverage now spans GET, not just the mutating verbs it used to guard alone.
  const untokenedGet = await request(url, "/api/settings");
  assert.equal(untokenedGet.response.status, 403);
  assert.equal(untokenedGet.body.reasonCode, "PORTAL_TOKEN_REQUIRED");
  const tokenedGet = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(tokenedGet.response.status, 200);
});

test("STORY-355 GWT4: container mode's default prose root sits above the chain container regardless of partition", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-prose-default-")));
  const container = join(base, ".tcrn-workspace");
  const root = join(container, "alpha");
  await mkdir(root, { recursive: true });
  const roots = {};
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) { const path = join(root, kind); await mkdir(path); roots[kind] = path; }
  await cli(["init", "--workspace", roots.workspace, "--framework", roots.framework, "--transient", roots.transient, "--evidence-locator", roots["evidence-locator"], "--release-trust", roots["release-trust"], "--external-key", "TCRN-PORTAL-PROSE-DEFAULT", "--at", "2026-08-11T15:00:00Z"]);
  const { child, url } = await startPortal({ container, home: await scratchHome(base) });
  t.after(async () => { child.kill(); await rm(base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  assert.equal(boot.proseRoot, dirname(container));
});

test("STORY-355: an explicit --prose-root resolving inside a chain container fails at boot", async (t) => {
  const fixture = await scratch("tcrn-portal-prose-unsafe-", "TCRN-PORTAL-PROSE-UNSAFE");
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const unsafeProseRoot = join(fixture.base, ".tcrn-workspace", "nested");
  const args = [join(portalRoot, "portal.mjs"), "--workspace", fixture.workspace, "--prose-root", unsafeProseRoot, "--port", "0"];
  const { status, stderr } = await new Promise((resolveSpawn) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, HOME: fixture.home }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => resolveSpawn({ status: code, stderr }));
  });
  assert.equal(status, 2);
  const report = JSON.parse(stderr);
  assert.equal(report.ok, false);
  assert.equal(report.reasonCode, "PORTAL_PROSE_ROOT_UNSAFE");
});

// STORY-355 dispatch correction (plan section 5): the agent's original design made this
// refusal fire on the DERIVED default too, which would make --workspace mode unbootable
// against every governed partition, since a partition's workspace always lives inside
// the chain container. This test is the red-line evidence that the corrected default --
// which walks up past the .tcrn-workspace segment before comparing -- keeps that mode
// bootable, with the prose root landing above the container exactly as in container mode.
test("STORY-355: --workspace mode's default prose root also lands above the chain container", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-workspace-default-")));
  const container = join(base, ".tcrn-workspace");
  const partitionRoot = join(container, "alpha");
  await mkdir(partitionRoot, { recursive: true });
  const roots = {};
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) { const path = join(partitionRoot, kind); await mkdir(path); roots[kind] = path; }
  await cli(["init", "--workspace", roots.workspace, "--framework", roots.framework, "--transient", roots.transient, "--evidence-locator", roots["evidence-locator"], "--release-trust", roots["release-trust"], "--external-key", "TCRN-PORTAL-WORKSPACE-DEFAULT", "--at", "2026-08-11T15:00:00Z"]);
  const { child, url } = await startPortal({ workspace: roots.workspace, home: await scratchHome(base) });
  t.after(async () => { child.kill(); await rm(base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  assert.equal(boot.proseRoot, base);
});
