// SPDX-License-Identifier: Apache-2.0
// Portal integration tests use the real CLI and a real governed scratch tree.

import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const CLI = process.env.TCRN_WORKFLOW_CLI ?? join(portalRoot, "..", "scripts", "tcrn-workflow.mjs");

async function cli(args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 32e6 });
  return JSON.parse(stdout);
}

async function scratch(prefix, externalKey) {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
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
  return { base, workspace: roots.workspace, proseRoot };
}

async function startPortal({ workspace, container, proseRoot, env = {} }) {
  const args = [join(portalRoot, "portal.mjs")];
  if (container) args.push("--container", container);
  else args.push("--workspace", workspace);
  if (proseRoot) args.push("--prose-root", proseRoot);
  args.push("--port", "0");
  const child = spawn(process.execPath, args, {
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

async function readBoot(url) {
  const page = await (await fetch(url)).text();
  assert.ok(!page.includes("__PORTAL_BOOT__"));
  return { page, boot: JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]) };
}

function request(url, path, options) { return fetch(new URL(path, url), options).then(async (response) => ({ response, body: await response.json() })); }
function writeOptions(token, method, body) { return { method, headers: { "content-type": "application/json", "x-portal-token": token }, body: JSON.stringify(body) }; }

test("portal boots from the live engine and exposes the new read surfaces", async (t) => {
  const fixture = await scratch("tcrn-portal-read-", "TCRN-PORTAL-READ");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  assert.equal(boot.partitionMode, false);
  assert.match(page, /data-page="dashboard"/u);
  assert.match(page, /data-page="vocabulary"/u);

  const settings = await request(url, "/api/settings");
  assert.equal(settings.body.reasonCode, "SETTINGS_CATALOG_READY");
  assert.deepEqual(settings.body.settings.filter((entry) => entry.key.includes("SubagentPlan")).map((entry) => entry.key), ["execution.claudeCodeSubagentPlan", "execution.codexSubagentPlan"]);
  const execution = await request(url, "/api/execution");
  assert.equal(execution.body.reasonCode, "PORTAL_EXECUTION_READY");
  assert.ok(Array.isArray(execution.body.plans));
  assert.ok(execution.body.personas.some((persona) => persona.name === "Verity"));
  const dictionary = await request(url, "/api/vocabulary");
  assert.equal(dictionary.body.reasonCode, "VOCABULARY_READY");
  assert.ok(dictionary.body.roles.some((role) => role.value === "reviewer"));
  assert.ok(dictionary.body.hosts.includes("codex"));
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

  const plan = await request(url, "/api/execution", writeOptions(boot.token, "POST", { action: "model-plan-set", host: "claude-code", name: "daily", defaultModel: "opus-5" }));
  assert.equal(plan.body.reasonCode, "MODEL_PLAN_WRITE_COMMITTED");
  const assignment = await request(url, "/api/execution", writeOptions(boot.token, "POST", { action: "model-plan-assign", host: "claude-code", plan: "daily", persona: "Verity", model: "sonnet-5" }));
  assert.equal(assignment.body.reasonCode, "MODEL_PLAN_WRITE_COMMITTED");
  const active = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.claudeCodeSubagentPlan", value: "daily" }));
  assert.equal(active.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  const override = await request(url, "/api/execution", writeOptions(boot.token, "POST", { action: "persona-preset-override", name: "Verity", fields: { mission: "Review governed evidence", role: "reviewer" } }));
  assert.equal(override.body.reasonCode, "PERSONA_WRITE_COMMITTED");
  assert.equal(override.body.readback.personas.find((persona) => persona.name === "Verity").mission, "Review governed evidence");

  const audit = await request(url, "/api/session-audit");
  assert.equal(audit.body.reasonCode, "PORTAL_SESSION_AUDIT_READY");
  assert.equal(audit.body.writes.length, 5);
  assert.ok(audit.body.writes.every((entry) => entry.action && entry.occurredAt));
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
  const status = await request(url, "/api/status");
  assert.equal(status.body.engineVersion, "0.11.99");
  assert.equal(status.body.ok, true);

  child.kill();
  const actorPortal = await startPortal({ ...fixture, env: { TCRN_PORTAL_ACTOR: "   " } });
  t.after(() => actorPortal.child.kill());
  const actorStatus = await request(actorPortal.url, "/api/status");
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
  const green = await request(url, "/api/agents-md/reconcile");
  assert.equal(green.body.ok, true);
  assert.equal(green.body.findings.length, 0);

  await writeFile(join(fixture.proseRoot, "AGENTS.md"), `${text}\nAlso set backup.retiredKey.\n`, "utf8");
  const red = await request(url, "/api/agents-md/reconcile");
  assert.equal(red.body.ok, false);
  assert.equal(red.body.findings[0].kind, "unregistered");
  assert.equal(red.body.findings[0].line, 5);

  const escapedRead = await request(url, "/api/agents-md?file=" + encodeURIComponent("../AGENTS.md"));
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
  const { child, url } = await startPortal({ container });
  t.after(async () => { child.kill(); await rm(base, { recursive: true, force: true }); });
  const partitionRead = await request(url, "/api/partitions");
  assert.deepEqual(partitionRead.body.partitions.map((entry) => entry.id), ["alpha", "beta"]);
  const { boot } = await readBoot(url);
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
  const catalog = await request(url, "/api/settings");
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
  const status = await request(url, "/api/status");
  assert.equal(status.body.checks.length, 3);
  assert.ok(status.body.checks.every((check) => check.ok));
  const commands = await request(url, "/api/commands");
  assert.ok(commands.body.commands.some((entry) => entry.name === "settings-set" && entry.mutates));
});

test("reconciliation goes red when prose names an unregistered key, and green once repaired", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-reconcile-", "TCRN-PORTAL-CONSERVATION-RECONCILE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const greenText = "# AGENTS.md\n\nSet backup.cadence before close.\n";
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), greenText, "utf8");
  const green = await request(url, "/api/agents-md/reconcile");
  assert.equal(green.body.ok, true);
  assert.equal(green.body.findings.length, 0);
  assert.ok(green.body.rows.some((row) => row.key === "backup.cadence" && row.registered));
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), `${greenText}\nAlso set backup.retiredKey.\n`, "utf8");
  const red = await request(url, "/api/agents-md/reconcile");
  assert.equal(red.body.ok, false);
  assert.equal(red.body.findings[0].kind, "unregistered");
  assert.equal(red.body.findings[0].line, 5);
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), greenText, "utf8");
  assert.equal((await request(url, "/api/agents-md/reconcile")).body.ok, true);
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
  const readback = await request(url, "/api/agents-md");
  assert.equal(readback.body.text, text);
  assert.equal(readback.body.path, join(fixture.proseRoot, "AGENTS.md"));
  const escapedRead = await request(url, "/api/agents-md?file=" + encodeURIComponent("../AGENTS.md"));
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
  const { child, url } = await startPortal({ container });
  t.after(async () => { child.kill(); await rm(base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  assert.equal(boot.partitionMode, true);
  assert.deepEqual(boot.partitions.map((entry) => entry.id), ["alpha", "beta"]);
  const listed = await request(url, "/api/partitions");
  assert.deepEqual(listed.body.partitions.map((entry) => entry.id), ["alpha", "beta"]);
  const selected = await request(url, "/api/partition", writeOptions(boot.token, "POST", { partition: "beta" }));
  assert.equal(selected.body.reasonCode, "PORTAL_PARTITION_SELECTED");
  assert.equal(selected.body.selectedPartition, "beta");
  assert.equal(selected.body.workspace, partitions[1].workspace);
  assert.equal(selected.body.proseRoot, join(container, "beta"));
  const catalog = await request(url, "/api/settings");
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
  const launcher = spawn(command, [], { env: { ...process.env, TCRN_WORKFLOW_CLI: CLI }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => launcher.kill());
  const url = await new Promise((resolve, reject) => { let buffer = ""; const timer = setTimeout(() => reject(new Error(`launcher timeout: ${buffer}`)), 15000); launcher.stdout.on("data", (chunk) => { buffer += chunk; const line = buffer.split("\n").find((entry) => entry.includes("PORTAL_LISTENING")); if (line) { clearTimeout(timer); resolve(JSON.parse(line).url); } }); launcher.on("exit", (code) => { clearTimeout(timer); reject(new Error(`launcher exited ${code}: ${buffer}`)); }); });
  assert.equal((await request(url, "/api/partitions")).body.partitions.length, 2);
  const vanished = join(base, "vanished-container");
  const badOutput = join(base, "bad-launchers");
  await mkdir(badOutput);
  await execFileAsync(process.execPath, [generator, "--container", vanished, "--output-dir", badOutput, "--prose-root", proseRoot, "--port", "0"], { encoding: "utf8" });
  let failure;
  try { await execFileAsync(join(badOutput, "tcrn-workflow-portal.sh"), [], { encoding: "utf8" }); } catch (error) { failure = error; }
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
  const { page, boot } = await readBoot(url);
  const post = async (payload) => request(url, "/api/execution", writeOptions(boot.token, "POST", payload));
  const created = await post({ action: "model-plan-set", host: "claude-code", name: "owner-scenario", defaultModel: "opus-5" });
  assert.equal(created.body.reasonCode, "MODEL_PLAN_WRITE_COMMITTED");
  const assigned = await post({ action: "model-plan-assign", host: "claude-code", plan: "owner-scenario", persona: "Verity", model: "sonnet-5" });
  assert.equal(assigned.body.reasonCode, "MODEL_PLAN_WRITE_COMMITTED");
  assert.equal(assigned.body.readback.plans.find((plan) => plan.name === "owner-scenario").assignments.Verity, "sonnet-5");
  const active = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.claudeCodeSubagentPlan", value: "owner-scenario" }));
  assert.equal(active.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  const refused = await post({ action: "model-plan-remove", host: "claude-code", name: "owner-scenario" });
  assert.equal(refused.response.status, 409);
  assert.equal(refused.body.reasonCode, "MODEL_PLAN_IN_USE");
  const readback = await request(url, "/api/execution");
  assert.equal(readback.body.plans.find((plan) => plan.name === "owner-scenario").assignments.Verity, "sonnet-5");
  assert.match(page, /data-ui="assignment-addline"/u);
  assert.match(page, /data-ui="receipt-drawer"/u);
});

test("INIT-027 execution cards keep persona data, policy linkage, and engine refusals visible", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-cards-", "TCRN-PORTAL-CONSERVATION-CARDS");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  const post = async (payload) => request(url, "/api/execution", writeOptions(boot.token, "POST", payload));
  const initial = await request(url, "/api/execution");
  assert.equal(initial.body.personas.filter((persona) => persona.readOnly).length, 8);
  assert.equal(initial.body.personas.find((persona) => persona.name === "Verity").mission.length > 0, true);
  assert.match(page, /data-ui="persona-model-readonly"/u);
  assert.match(page, /data-ui="persona-more-fields"/u);
  const override = await post({ action: "persona-preset-override", name: "Verity", fields: { mission: "temporary portal override", role: "reviewer" } });
  assert.equal(override.body.reasonCode, "PERSONA_WRITE_COMMITTED");
  assert.equal(override.body.readback.personas.find((persona) => persona.name === "Verity").overridden, true);
  const restoreAll = await post({ action: "persona-preset-restore", name: "Verity" });
  assert.equal(restoreAll.body.reasonCode, "PERSONA_WRITE_COMMITTED");
  assert.equal(restoreAll.body.readback.personas.find((persona) => persona.name === "Verity").overridden, false);
  assert.doesNotMatch(page, /\bstyle\s*=/u);
  const custom = await post({ action: "persona-set", name: "Portal auditor", role: "reviewer", mission: "Review exact evidence", refusals: "No unsupported claims" });
  assert.equal(custom.body.reasonCode, "PERSONA_WRITE_COMMITTED");
  assert.equal(custom.body.readback.personas.some((persona) => persona.name === "Portal auditor" && persona.source === "custom"), true);
  const plan = await post({ action: "model-plan-set", host: "codex", name: "card-plan", defaultModel: "model-a" });
  assert.equal(plan.body.reasonCode, "MODEL_PLAN_WRITE_COMMITTED");
  const assignment = await post({ action: "model-plan-assign", host: "codex", plan: "card-plan", persona: "Portal auditor", model: "model-b" });
  assert.equal(assignment.body.reasonCode, "MODEL_PLAN_WRITE_COMMITTED");
  const active = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.codexSubagentPlan", value: "card-plan" }));
  assert.equal(active.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  const refused = await post({ action: "persona-remove", name: "Portal auditor" });
  assert.equal(refused.response.status, 409);
  assert.equal(refused.body.reasonCode, "EXECUTION_PERSONA_IN_USE");
  const policy = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.subagentPolicy", value: "forbidden" }));
  assert.equal(policy.body.setting.value, "forbidden");
  assert.equal((await request(url, "/api/execution")).body.personas.some((persona) => persona.name === "Portal auditor"), true);
});
