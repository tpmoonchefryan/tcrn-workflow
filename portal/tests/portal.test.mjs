// SPDX-License-Identifier: Apache-2.0
//
// End-to-end over the real thing: a governed scratch workspace, the real CLI,
// the real portal process. Nothing here stubs the engine, because the property
// under test is precisely that the portal's numbers come from the engine.

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

async function governedScratch() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "portal-test-")));
  const roots = {};
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots[kind] = await realpath(path);
  }
  await cli(["init", "--workspace", roots.workspace, "--framework", roots.framework, "--transient", roots.transient,
    "--evidence-locator", roots["evidence-locator"], "--release-trust", roots["release-trust"],
    "--external-key", "TCRN-PORTAL-TEST", "--at", "2026-08-11T15:00:00Z"]);
  const proseRoot = join(base, "prose");
  await mkdir(proseRoot);
  return { base, workspace: roots.workspace, proseRoot };
}

async function governedContainerScratch() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "portal-container-test-")));
  const container = join(base, ".tcrn-workspace");
  const proseRoot = join(base, "prose");
  await mkdir(container);
  await mkdir(proseRoot);
  const partitions = [];
  for (const id of ["alpha", "beta"]) {
    const partitionRoot = join(container, id);
    await mkdir(partitionRoot);
    const roots = {};
    for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust", "attestations"]) {
      const path = join(partitionRoot, kind);
      await mkdir(path);
      roots[kind] = await realpath(path);
    }
    await cli(["init", "--workspace", roots.workspace, "--framework", roots.framework, "--transient", roots.transient,
      "--evidence-locator", roots["evidence-locator"], "--release-trust", roots["release-trust"],
      "--external-key", `TCRN-PORTAL-${id.toUpperCase()}`, "--at", "2026-08-11T15:00:00Z"]);
    partitions.push({ id, workspace: roots.workspace });
  }
  await writeFile(join(proseRoot, "AGENTS.md"), "# AGENTS.md\n\nSet backup.cadence before a release.\n", "utf8");
  return { base, container, proseRoot, partitions };
}

async function startPortal({ workspace, container, proseRoot, env = {} }) {
  const args = [join(portalRoot, "portal.mjs")];
  if (container) args.push("--container", container);
  else args.push("--workspace", workspace);
  args.push("--prose-root", proseRoot, "--port", "0");
  const child = spawn(process.execPath, args, {
    env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("portal did not start: " + buffer)), 15000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((entry) => entry.includes("PORTAL_LISTENING"));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line).url); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error("portal exited " + code + ": " + buffer)); });
  });
  return { child, url };
}

test("portal serves live catalog, commits a governed write, and refuses an untokened one", async (t) => {
  const scratch = await governedScratch();
  const { child, url } = await startPortal(scratch);
  t.after(async () => { child.kill(); await rm(scratch.base, { recursive: true, force: true }); });

  const page = await (await fetch(url)).text();
  assert.ok(!page.includes("__PORTAL_BOOT__"), "boot payload must be substituted into the page");
  const token = JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]).token;
  assert.ok(token.length >= 32, "a per-run token must be injected");

  // The catalog the page renders is the engine's, not a constant in the page.
  const catalog = await (await fetch(new URL("/api/settings", url))).json();
  assert.equal(catalog.reasonCode, "SETTINGS_CATALOG_READY");
  const engineCatalog = await cli(["settings-catalog", "--workspace", scratch.workspace]);
  assert.deepEqual(catalog.settings, engineCatalog.settings);
  assert.ok(!page.includes("gate-close"), "no catalog value may be hard-coded in the page");
  assert.match(page, /id="setting-select"/u, "enum settings need a dedicated selector control");
  assert.match(page, /Array\.isArray\(entry\.allowedValues\)/u, "the selector must be driven by the live catalog");
  assert.deepEqual(catalog.settings.find((entry) => entry.key === "backup.cadence").allowedValues, ["gate-close", "session-end", "manual"]);

  // A mutation without the token is refused before it reaches the engine.
  const untokened = await fetch(new URL("/api/settings", url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "backup.cadence", value: "manual" }),
  });
  assert.equal(untokened.status, 403);
  assert.equal((await untokened.json()).reasonCode, "PORTAL_TOKEN_REQUIRED");

  // The write returns the engine's own receipt, and the CLI reads back the same value.
  const committed = await (await fetch(new URL("/api/settings", url), {
    method: "POST", headers: { "content-type": "application/json", "x-portal-token": token },
    body: JSON.stringify({ key: "backup.cadence", value: "manual" }),
  })).json();
  assert.equal(committed.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(committed.setting.value, "manual");
  assert.ok(committed.receiptDigest && committed.headEventHash, "receipt must carry engine digests");
  const readback = await cli(["settings-catalog", "--workspace", scratch.workspace]);
  assert.equal(readback.settings.find((entry) => entry.key === "backup.cadence").currentValue, "manual");
  assert.equal(committed.readback.currentValue, "manual");

  // An unregistered key is refused by the engine and surfaced verbatim.
  const refused = await fetch(new URL("/api/settings", url), {
    method: "POST", headers: { "content-type": "application/json", "x-portal-token": token },
    body: JSON.stringify({ key: "bogus.key", value: "x" }),
  });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).reasonCode, "SETTINGS_KEY_UNREGISTERED");
});

test("reconciliation goes red when prose names an unregistered key, and green once repaired", async (t) => {
  const scratch = await governedScratch();
  const { child, url } = await startPortal(scratch);
  t.after(async () => { child.kill(); await rm(scratch.base, { recursive: true, force: true }); });

  const green = "# AGENTS.md\n\nSet backup.cadence before a release.\n";
  await writeFile(join(scratch.proseRoot, "AGENTS.md"), green);
  const first = await (await fetch(new URL("/api/reconcile", url))).json();
  assert.equal(first.reasonCode, "PROSE_MATCHES_CATALOG");
  assert.equal(first.mismatchCount, 0);
  assert.ok(first.rows.some((row) => row.key === "backup.cadence" && row.registered));

  // Red leg: prose claims a key the engine does not register.
  await writeFile(join(scratch.proseRoot, "AGENTS.md"), green + "\nAlso set backup.retiredKey to something.\n");
  const red = await (await fetch(new URL("/api/reconcile", url))).json();
  assert.equal(red.ok, false);
  assert.equal(red.reasonCode, "PROSE_CLAIMS_UNREGISTERED_KEY");
  assert.ok(red.rows.some((row) => row.key === "backup.retiredKey" && !row.registered));

  // Green again once the stale claim is removed.
  await writeFile(join(scratch.proseRoot, "AGENTS.md"), green);
  assert.equal((await (await fetch(new URL("/api/reconcile", url))).json()).ok, true);
});

test("prose surface writes the file and reads it back", async (t) => {
  const scratch = await governedScratch();
  const { child, url } = await startPortal(scratch);
  t.after(async () => { child.kill(); await rm(scratch.base, { recursive: true, force: true }); });

  const body = "# AGENTS.md\n\nOwner actions stay parked.\n";
  const written = await (await fetch(new URL("/api/prose", url), {
    method: "POST", headers: { "content-type": "application/json", "x-portal-token": JSON.parse((await (await fetch(url)).text()).match(/const BOOT = (\{.*\});/u)[1]).token },
    body: JSON.stringify({ file: "AGENTS.md", text: body }),
  })).json();
  assert.equal(written.reasonCode, "PORTAL_PROSE_WRITTEN");
  assert.equal(written.matches, true);
  assert.equal(await readFile(join(scratch.proseRoot, "AGENTS.md"), "utf8"), body);

  // Only the allow-listed basename is reachable; traversal is refused.
  const escaped = await fetch(new URL("/api/prose?file=" + encodeURIComponent("../../etc/hosts"), url));
  assert.equal(escaped.status, 404);
  assert.equal((await escaped.json()).reasonCode, "PORTAL_PROSE_NOT_ALLOWED");
});

test("the page boots with the shipped locale contract and needs nothing outside the portal", async (t) => {
  const scratch = await governedScratch();
  const { child, url } = await startPortal(scratch);
  t.after(async () => { child.kill(); await rm(scratch.base, { recursive: true, force: true }); });

  // Regression: localeContract() once used a non-global regexp with matchAll,
  // which threw and made every page load a 500 rather than a broken locale.
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const page = await response.text();
  const boot = JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]);

  // The contract the portal SHIPS is the reference here, not the design system's
  // source. Reading the design system from a test would reintroduce exactly the
  // dependency this arrangement removes: the portal travels inside the engine, so
  // a suite that needs a design-system checkout is a suite no user can run. That
  // the shipped contract still agrees with its upstream is asserted by
  // portal/scripts/i18n-proof.mjs, which runs where the upstream exists.
  const { LOCALE_CONTRACT } = await import("../locale-contract.mjs");
  const declared = [...LOCALE_CONTRACT.supportedLocales];
  assert.deepEqual(boot.supportedLocales, declared, "the page must boot with the contract the portal ships");
  assert.equal(boot.localeMetadata.length, declared.length);
  assert.ok(boot.localeMetadata.every((entry) => entry.nativeName.length > 0));

  // Copy is served as a separate file so the gate can read it; the page must
  // actually reference it rather than inlining a second table.
  const locales = await (await fetch(new URL("/locales.js", url))).text();
  assert.match(locales, /window\.PORTAL_LOCALES/u);
  for (const locale of declared) assert.ok(locales.includes(`"${locale}"`) || locales.includes(`${locale}:`), `locales.js must define ${locale}`);
});

test("container mode lists every partition and switches the live target", async (t) => {
  const scratch = await governedContainerScratch();
  const { child, url } = await startPortal(scratch);
  t.after(async () => { child.kill(); await rm(scratch.base, { recursive: true, force: true }); });

  const page = await (await fetch(url)).text();
  const boot = JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]);
  assert.equal(boot.partitionMode, true);
  assert.deepEqual(boot.partitions.map((entry) => entry.id), ["alpha", "beta"]);
  assert.match(page, /id="partition-select"/u);
  assert.match(page, /\/api\/partition/u);

  const listed = await (await fetch(new URL("/api/partitions", url))).json();
  assert.equal(listed.reasonCode, "PORTAL_PARTITIONS_READY");
  assert.deepEqual(listed.partitions.map((entry) => entry.id), ["alpha", "beta"]);

  const token = boot.token;
  const switched = await fetch(new URL("/api/partition", url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-portal-token": token },
    body: JSON.stringify({ partition: "beta" }),
  });
  const switchBody = await switched.json();
  assert.equal(switched.status, 200);
  assert.equal(switchBody.reasonCode, "PORTAL_PARTITION_SELECTED");
  assert.equal(switchBody.selectedPartition, "beta");
  assert.equal(switchBody.workspace, scratch.partitions[1].workspace);

  const catalog = await (await fetch(new URL("/api/settings", url))).json();
  const engineCatalog = await cli(["settings-catalog", "--workspace", scratch.partitions[1].workspace]);
  assert.deepEqual(catalog.settings, engineCatalog.settings, "after switching, reads come from the selected partition");
});

test("launcher generation emits regular files, starts macOS launcher, and names a vanished container", async (t) => {
  const scratch = await governedContainerScratch();
  const outputDir = join(scratch.base, "launchers");
  await mkdir(outputDir);
  t.after(() => rm(scratch.base, { recursive: true, force: true }));

  const generator = join(portalRoot, "scripts", "generate-launchers.mjs");
  const { stdout } = await execFileAsync(process.execPath, [generator,
    "--container", scratch.container, "--output-dir", outputDir, "--prose-root", scratch.proseRoot, "--port", "0"], {
    encoding: "utf8",
  });
  const report = JSON.parse(stdout);
  assert.equal(report.reasonCode, "PORTAL_LAUNCHERS_GENERATED");
  assert.equal(report.symlinks, false);
  assert.equal(report.files.length, 3);
  for (const file of report.files) {
    const info = await lstat(file);
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.ok((await readFile(file, "utf8")).includes("--container"));
  }
  assert.match(await readFile(report.files.find((file) => file.endsWith(".command")), "utf8"), /^#!\/bin\/sh/u);
  assert.match(await readFile(report.files.find((file) => file.endsWith(".sh")), "utf8"), /set -eu/u);
  assert.match(await readFile(report.files.find((file) => file.endsWith(".cmd")), "utf8"), /^@echo off/mu);

  const launcher = spawn(report.files.find((file) => file.endsWith(".command")), [], {
    env: { ...process.env, TCRN_WORKFLOW_CLI: CLI },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("generated macOS launcher did not start: " + buffer)), 15000);
    launcher.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((entry) => entry.includes("PORTAL_LISTENING"));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line).url); }
    });
    launcher.on("exit", (code) => { clearTimeout(timer); reject(new Error("generated launcher exited " + code + ": " + buffer)); });
  });
  t.after(() => launcher.kill());
  assert.equal((await (await fetch(new URL("/api/partitions", url))).json()).partitions.length, 2);

  const vanished = join(scratch.base, "vanished-container");
  const badOutput = join(scratch.base, "bad-launchers");
  await mkdir(badOutput);
  await execFileAsync(process.execPath, [generator,
    "--container", vanished, "--output-dir", badOutput, "--prose-root", scratch.proseRoot, "--port", "0"], { encoding: "utf8" });
  let failure;
  try {
    await execFileAsync(join(badOutput, "tcrn-workflow-portal.sh"), [], { encoding: "utf8" });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "a vanished container must prevent launcher startup");
  assert.match(String(failure.stderr), /PORTAL_CONTAINER_UNAVAILABLE/u);
});

test("i18n proof turns red when the engine drops enum allowedValues", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "portal-s223-red-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const shim = join(base, "strip-catalog.mjs");
  await writeFile(shim, `
import { execFileSync } from "node:child_process";
const output = execFileSync(process.execPath, [process.env.TCRN_REAL_CLI, ...process.argv.slice(2)], { encoding: "utf8" });
const body = JSON.parse(output);
if (process.argv[2] === "settings-catalog") {
  for (const entry of body.settings ?? []) delete entry.allowedValues;
}
process.stdout.write(JSON.stringify(body));
`, "utf8");

  let failure;
  try {
    await execFileAsync(process.execPath, [join(portalRoot, "scripts", "i18n-proof.mjs")], {
      encoding: "utf8",
      env: { ...process.env, TCRN_WORKFLOW_CLI: shim, TCRN_REAL_CLI: CLI },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "proof must fail when enum values disappear from the catalog");
  const report = JSON.parse(failure.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.reasonCode, "I18N_CONTRACT_VIOLATION");
  assert.equal(report.legs.find((leg) => leg.leg === "setting-descriptions").reasonCode, "SETTING_ENUM_VALUES_GAP");
  // Three enum keys since INIT-026 added the two execution policy settings.
  // Sorted before comparing: the leg reports catalog order, which is not
  // lexicographic and is not this assertion's subject.
  assert.deepEqual([...report.legs.find((leg) => leg.leg === "setting-descriptions").enumMissingAllowedValues].sort(),
    ["backup.cadence", "execution.independenceFloor", "execution.subagentPolicy"]);
});

test("execution surface: the owner scenario end to end with the engine's own receipts", async (t) => {
  const scratch = await governedScratch();
  const { child, url } = await startPortal(scratch);
  t.after(async () => { child.kill(); await rm(scratch.base, { recursive: true, force: true }); });

  const page = await (await fetch(url)).text();
  const token = JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]).token;
  const post = async (payload) => {
    const response = await fetch(new URL("/api/execution", url), {
      method: "POST", headers: { "content-type": "application/json", "x-portal-token": token },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };

  const created = await post({ action: "config-set", host: "claude-code", name: "默认", model: "claude-opus-5" });
  assert.equal(created.status, 200);
  assert.equal(created.body.reasonCode, "EXECUTION_CONFIG_COMMITTED");
  await post({ action: "config-set", host: "claude-code", name: "回滚45", model: "claude-opus-4-8", note: "综合选择" });
  const switched = await post({ action: "config-default", host: "claude-code", name: "回滚45" });
  assert.equal(switched.body.defaults[0].configurationName, "回滚45");
  const bound = await post({ action: "binding-set", profileId: "profile:tcrn-verity-v1", host: "claude-code", name: "默认" });
  assert.equal(bound.body.bindings.length, 1);

  // A refusal arrives verbatim from the engine — the portal must not translate
  // it into a generic failure, and the state must be untouched.
  const refused = await post({ action: "config-remove", host: "claude-code", name: "回滚45" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reasonCode, "EXECUTION_CONFIGURATION_IN_USE");
  const readback = await (await fetch(new URL("/api/execution?token=" + token, url))).json();
  assert.equal(readback.configurations.length, 2);

  // The execution surface is in the page with its translated chrome.
  assert.match(page, /surface-execution/u);
  assert.match(page, /data-surface="execution"/u);
});
