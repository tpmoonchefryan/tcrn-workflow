#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// TCRN Workflow Portal — a zero-dependency local projection of the public CLI.
// The portal owns no governance state. Chain reads and writes go through the
// bundled CLI; AGENTS.md is ordinary workspace prose and is handled with fs.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { LOCALE_CONTRACT } from "./locale-contract.mjs";

const execFileAsync = promisify(execFile);
const portalRoot = dirname(fileURLToPath(import.meta.url));
const ACTOR = (process.env.TCRN_PORTAL_ACTOR ?? "agent:portal").trim();
const BUNDLED_CLI = join(portalRoot, "..", "scripts", "tcrn-workflow.mjs");
const CLI = process.env.TCRN_WORKFLOW_CLI ?? BUNDLED_CLI;
const PROSE_FILES = Object.freeze(["AGENTS.md"]);

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function startupError(reasonCode, detail, message = reasonCode) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  error.detail = detail;
  return error;
}

function failStartup(error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    reasonCode: error?.reasonCode ?? "PORTAL_STARTUP_FAILED",
    ...(error?.detail ?? {}),
    error: String(error?.message ?? error),
  })}\n`);
  process.exit(2);
}

const workspaceArgument = argument("workspace", process.env.TCRN_PORTAL_WORKSPACE ?? "");
const containerArgument = argument("container", process.env.TCRN_PORTAL_CONTAINER ?? "");
const workspace = workspaceArgument ? resolve(workspaceArgument) : "";
const containerRoot = containerArgument ? resolve(containerArgument) : "";
const proseRootArgument = argument("prose-root", process.env.TCRN_PORTAL_PROSE_ROOT ?? "");
const port = Number(argument("port", process.env.TCRN_PORTAL_PORT ?? "4319"));
const attestDirArgument = argument("attest-dir", process.env.TCRN_PORTAL_ATTEST_DIR ?? "");
const attestDir = attestDirArgument ? resolve(attestDirArgument) : "";
const requestedPartition = argument("partition", process.env.TCRN_PORTAL_PARTITION ?? "");

if (workspace && containerRoot) failStartup(startupError("PORTAL_TARGET_AMBIGUOUS", {}, "choose exactly one target"));
if (!workspace && !containerRoot) {
  failStartup(startupError("PORTAL_TARGET_REQUIRED", {}, "use --workspace or --container"));
}

async function discoverPartitions(root) {
  let rootInfo;
  try { rootInfo = await stat(root); } catch {
    throw startupError("PORTAL_CONTAINER_UNAVAILABLE", { container: root }, `container does not exist: ${root}`);
  }
  if (!rootInfo.isDirectory()) throw startupError("PORTAL_CONTAINER_UNAVAILABLE", { container: root }, "container is not a directory");
  const partitions = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const partitionRoot = join(root, entry.name);
    const partitionWorkspace = join(partitionRoot, "workspace");
    try {
      if (!(await stat(partitionWorkspace)).isDirectory()) continue;
      let partitionAttestDir = attestDir;
      if (!partitionAttestDir) {
        const candidate = join(partitionRoot, "attestations");
        try { if ((await stat(candidate)).isDirectory()) partitionAttestDir = candidate; } catch { /* optional */ }
      }
      partitions.push({ id: entry.name, workspace: partitionWorkspace, attestDir: partitionAttestDir });
    } catch { /* non-partition directories are ignored */ }
  }
  if (partitions.length === 0) throw startupError("PORTAL_CONTAINER_EMPTY", { container: root });
  return partitions.sort((left, right) => left.id.localeCompare(right.id));
}

let partitionCatalog;
try {
  partitionCatalog = containerRoot
    ? await discoverPartitions(containerRoot)
    : [{ id: "workspace", workspace, attestDir }];
} catch (error) { failStartup(error); }

if (requestedPartition && !partitionCatalog.some((entry) => entry.id === requestedPartition)) {
  failStartup(startupError("PORTAL_PARTITION_UNKNOWN", {
    requestedPartition,
    partitions: partitionCatalog.map(({ id }) => id),
  }));
}

const partitionMode = Boolean(containerRoot);
let selectedPartitionId = requestedPartition || partitionCatalog[0].id;
const currentPartition = () => partitionCatalog.find((entry) => entry.id === selectedPartitionId) ?? partitionCatalog[0];
// Proposal for the unresolved container prose decision: resolve the document in
// the selected partition root.  An explicit --prose-root remains authoritative
// for callers that have already chosen a target.  This keeps a container read
// local to its partition and never silently targets the platform root.
const currentProseRoot = () => resolve(proseRootArgument || dirname(currentPartition().workspace));
const currentPaths = () => {
  const root = dirname(currentPartition().workspace);
  return Object.fromEntries(["framework", "workspace", "transient", "evidence-locator", "release-trust"].map((kind) => [kind, join(root, kind)]));
};
const TOKEN = randomBytes(24).toString("hex");
const sessionWrites = [];
let writeSequence = 0;
let lastWriteAt = 0;

async function cli(args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
    cwd: portalRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return JSON.parse(stdout);
}

async function cliResult(args) {
  try { return { ok: true, body: await cli(args) }; } catch (error) {
    const raw = String(error?.stderr ?? error?.stdout ?? "").trim();
    try { return { ok: false, body: JSON.parse(raw) }; } catch {
      return { ok: false, body: { ok: false, reasonCode: "PORTAL_CLI_UNAVAILABLE", error: raw || String(error?.message ?? error) } };
    }
  }
}

const settingsCatalog = () => cli(["settings-catalog", "--workspace", currentPartition().workspace]);
const modelPlans = () => cli(["model-plan-list", "--workspace", currentPartition().workspace]);
const personas = () => cli(["persona-list", "--workspace", currentPartition().workspace]);
const vocabulary = () => cli(["vocabulary"]);
const commands = () => cli(["commands"]);

async function executionState() {
  const [settings, plans, personaList] = await Promise.all([settingsCatalog(), modelPlans(), personas()]);
  return {
    ok: true,
    reasonCode: "PORTAL_EXECUTION_READY",
    workspaceId: settings.workspaceId,
    version: settings.version ?? plans.version ?? personaList.version ?? null,
    headEventHash: settings.headEventHash ?? plans.headEventHash ?? personaList.headEventHash ?? null,
    settings: settings.settings,
    plans: plans.plans,
    personas: personaList.personas,
  };
}

function nextOccurredAt() {
  const now = Date.now();
  lastWriteAt = Math.max(now, lastWriteAt + 1000);
  return new Date(lastWriteAt).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function recordSessionWrite(action, result, summary, occurredAt) {
  const body = result.body ?? {};
  sessionWrites.unshift({
    sequence: ++writeSequence,
    action,
    summary,
    occurredAt,
    ok: result.ok,
    reasonCode: body.reasonCode ?? "PORTAL_WRITE_UNRECORDED",
    version: body.version ?? null,
    headEventHash: body.headEventHash ?? null,
    receiptDigest: body.receiptDigest ?? null,
  });
  if (sessionWrites.length > 100) sessionWrites.length = 100;
}

async function governedWrite(build, action, summary) {
  const selected = currentPartition();
  const occurredAt = nextOccurredAt();
  let result;
  try {
    if (!ACTOR) throw new Error("TCRN_PORTAL_ACTOR must be a non-empty actor id");
    const status = await cli(["status", "--workspace", selected.workspace]);
    const common = ["--workspace", selected.workspace, "--expected-version", String(status.version), "--at", occurredAt, "--actor", ACTOR];
    if (selected.attestDir) common.push("--attest-dir", selected.attestDir);
    result = await cliResult(build(common));
  } catch (error) {
    result = { ok: false, body: { ok: false, reasonCode: "PORTAL_CLI_UNAVAILABLE", error: String(error?.message ?? error) } };
  }
  recordSessionWrite(action, result, summary, occurredAt);
  return result;
}

function writeSetting(key, value) {
  return governedWrite(
    (common) => ["settings-set", ...common, "--key", String(key), "--value", String(value)],
    "settings-set",
    `${key} → ${value}`,
  );
}

function removeSetting(key) {
  return governedWrite(
    (common) => ["settings-remove", ...common, "--key", String(key)],
    "settings-remove",
    `${key} reset`,
  );
}

function writeExecution(action, body) {
  const selected = currentPartition();
  const text = (value) => String(value ?? "");
  const json = (value) => JSON.stringify(value ?? {});
  const verbs = {
    "model-plan-set": (common) => ["model-plan-set", ...common, "--host", text(body.host), "--name", text(body.name), "--default-model", text(body.defaultModel)],
    "model-plan-assign": (common) => ["model-plan-assign", ...common, "--host", text(body.host), "--plan", text(body.plan ?? body.name), "--persona", text(body.persona), "--model", text(body.model)],
    "model-plan-unassign": (common) => ["model-plan-unassign", ...common, "--host", text(body.host), "--plan", text(body.plan ?? body.name), "--persona", text(body.persona)],
    "model-plan-remove": (common) => ["model-plan-remove", ...common, "--host", text(body.host), "--name", text(body.name)],
    "persona-preset-override": (common) => ["persona-preset-override", ...common, "--name", text(body.name), "--fields", json(body.fields)],
    "persona-preset-restore": (common) => ["persona-preset-restore", ...common, "--name", text(body.name), ...(body.field ? ["--field", text(body.field)] : [])],
    "persona-set": (common) => ["persona-set", ...common, "--name", text(body.name), "--role", text(body.role),
      ...Object.entries({
        "job-title": body.jobTitle,
        mission: body.mission,
        refusals: body.refusals,
        "authority-boundary": body.authorityBoundary,
        "contact-when": body.contactWhen,
        "required-inputs": body.requiredInputs,
        deliverables: body.deliverables,
        "success-criteria": body.successCriteria,
      }).flatMap(([key, value]) => value === undefined ? [] : [`--${key}`, text(value)])],
    "persona-remove": (common) => ["persona-remove", ...common, "--name", text(body.name)],
  };
  const build = verbs[action];
  if (!build) {
    const result = { ok: false, body: { ok: false, reasonCode: "PORTAL_UNKNOWN_ACTION", error: action } };
    recordSessionWrite(action, result, action, new Date().toISOString());
    return Promise.resolve(result);
  }
  return governedWrite(build, action, body.summary ?? action);
}

function proseTarget(name = PROSE_FILES[0]) {
  if (!PROSE_FILES.includes(name)) return null;
  const root = currentProseRoot();
  const candidate = resolve(root, name);
  const relation = relative(root, candidate);
  if (relation.startsWith("..") || relation.startsWith(`..${sep}`)) return null;
  return candidate;
}

const KEY_PATTERN = /\b([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+)\b/gu;

async function reconcile() {
  const catalog = await settingsCatalog();
  const registered = new Set(catalog.settings.map((entry) => entry.key));
  const rows = [];
  for (const name of PROSE_FILES) {
    const path = proseTarget(name);
    if (!path) continue;
    let text = "";
    try { text = await readFile(path, "utf8"); } catch { continue; }
    for (const [lineIndex, line] of text.split("\n").entries()) {
      for (const match of line.matchAll(KEY_PATTERN)) {
        const key = match[1];
        const namespace = key.slice(0, key.indexOf("."));
        if (![...registered].some((entry) => entry.startsWith(`${namespace}.`))) continue;
        const known = registered.has(key);
        rows.push({ file: name, line: lineIndex + 1, token: key, key, registered: known, kind: known ? "registered" : "unregistered" });
      }
    }
  }
  const findings = rows.filter((row) => row.kind !== "registered");
  return {
    ok: findings.length === 0,
    reasonCode: findings.length === 0 ? "PROSE_MATCHES_CATALOG" : "PROSE_CLAIMS_UNREGISTERED_KEY",
    registered: [...registered].sort(),
    rows,
    findings,
    mismatchCount: findings.length,
  };
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw startupError("PORTAL_PAYLOAD_TOO_LARGE", {});
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function agentsRead(name) {
  const path = proseTarget(name);
  if (!path) return { status: 404, body: { ok: false, reasonCode: "PORTAL_PATH_ESCAPE", file: name } };
  let text = "";
  try { text = await readFile(path, "utf8"); } catch { /* absent prose reads as an empty editor */ }
  return { status: 200, body: { ok: true, reasonCode: "PORTAL_AGENTS_MD_READY", file: name, path, text } };
}

async function agentsWrite(body) {
  const file = String(body.file ?? PROSE_FILES[0]);
  const path = proseTarget(file);
  if (!path) return { status: 404, body: { ok: false, reasonCode: "PORTAL_PATH_ESCAPE", file } };
  const text = String(body.text ?? "");
  await writeFile(path, text, "utf8");
  const readback = await readFile(path, "utf8");
  return { status: 200, body: { ok: true, reasonCode: "PORTAL_AGENTS_MD_WRITTEN", file, path, matches: readback === text, text: readback } };
}

const apiAlias = (pathname) => pathname === "/api/prose" ? "/api/agents-md" : pathname === "/api/reconcile" ? "/api/agents-md/reconcile" : pathname;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const pathname = apiAlias(url.pathname);
  try {
    if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = await readFile(join(portalRoot, "index.html"), "utf8");
      const boot = JSON.stringify({
        token: TOKEN,
        workspace: currentPartition().workspace,
        container: containerRoot || null,
        partitionMode,
        partitions: partitionCatalog.map(({ id }) => ({ id })),
        selectedPartition: selectedPartitionId,
        proseRoot: currentProseRoot(),
        paths: currentPaths(),
        actor: ACTOR,
        proseFiles: PROSE_FILES,
        ...LOCALE_CONTRACT,
      });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html.replace("__PORTAL_BOOT__", boot.replace(/</gu, "\\u003c")));
      return;
    }
    if (request.method === "GET" && pathname === "/locales.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(join(portalRoot, "locales.js"), "utf8"));
      return;
    }
    if (request.method === "GET" && pathname === "/tokens.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(join(portalRoot, "tokens.css"), "utf8"));
      return;
    }
    if (!pathname.startsWith("/api/")) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found\n");
      return;
    }
    if (request.method !== "GET" && request.headers["x-portal-token"] !== TOKEN) {
      send(response, 403, { ok: false, reasonCode: "PORTAL_TOKEN_REQUIRED" });
      return;
    }
    if (request.method === "GET" && pathname === "/api/settings") {
      send(response, 200, await settingsCatalog());
      return;
    }
    if (request.method === "GET" && pathname === "/api/execution") {
      send(response, 200, await executionState());
      return;
    }
    if (request.method === "GET" && pathname === "/api/vocabulary") {
      send(response, 200, await vocabulary());
      return;
    }
    if (request.method === "GET" && pathname === "/api/commands") {
      send(response, 200, await commands());
      return;
    }
    if (request.method === "GET" && pathname === "/api/status") {
      const selected = currentPartition();
      const [status, validation, catalog] = await Promise.all([
        cliResult(["status", "--workspace", selected.workspace]),
        cliResult(["validate", "--workspace", selected.workspace]),
        cliResult(["settings-catalog", "--workspace", selected.workspace]),
      ]);
      const checks = [
        { key: "validate", ok: validation.ok, reasonCode: validation.body?.reasonCode ?? "PORTAL_VALIDATE_FAILED" },
        { key: "catalog", ok: catalog.ok, reasonCode: catalog.body?.reasonCode ?? "PORTAL_CATALOG_FAILED" },
        { key: "actor", ok: ACTOR.length > 0, reasonCode: ACTOR.length > 0 ? "PORTAL_ACTOR_CONFIGURED" : "PORTAL_ACTOR_MISSING" },
      ];
      let events = null;
      try { events = await cli(["event-list", "--workspace", selected.workspace, "--limit", "1"]); } catch { /* health remains legible */ }
      const body = status.body ?? {};
      send(response, 200, {
        ok: checks.every((check) => check.ok) && status.ok,
        reasonCode: checks.every((check) => check.ok) && status.ok ? "PORTAL_STATUS_READY" : "PORTAL_STATUS_DEGRADED",
        workspaceId: body.workspaceId ?? null,
        version: body.version ?? null,
        headEventHash: body.headEventHash ?? null,
        eventCount: events?.total ?? null,
        engineVersion: body.engineVersion ?? null,
        checks,
      });
      return;
    }
    if (request.method === "GET" && pathname === "/api/session-audit") {
      send(response, 200, { ok: true, reasonCode: "PORTAL_SESSION_AUDIT_READY", selectedPartition: selectedPartitionId, writes: sessionWrites });
      return;
    }
    if (request.method === "GET" && pathname === "/api/partitions") {
      send(response, 200, { ok: true, reasonCode: "PORTAL_PARTITIONS_READY", mode: partitionMode ? "container" : "workspace", partitions: partitionCatalog.map(({ id }) => ({ id })), selectedPartition: selectedPartitionId });
      return;
    }
    if (request.method === "POST" && pathname === "/api/partition") {
      const body = await readJsonBody(request);
      const next = String(body.partition ?? body.id ?? "");
      const selected = partitionCatalog.find((entry) => entry.id === next);
      if (!selected) { send(response, 404, { ok: false, reasonCode: "PORTAL_PARTITION_UNKNOWN", requestedPartition: next }); return; }
      selectedPartitionId = selected.id;
      send(response, 200, { ok: true, reasonCode: "PORTAL_PARTITION_SELECTED", selectedPartition: selected.id, workspace: selected.workspace, proseRoot: currentProseRoot(), paths: currentPaths() });
      return;
    }
    if (request.method === "POST" && pathname === "/api/settings") {
      const body = await readJsonBody(request);
      const key = String(body.key ?? "");
      const result = body.reset === true ? await removeSetting(key) : await writeSetting(key, String(body.value ?? ""));
      const readback = result.ok ? await settingsCatalog() : null;
      send(response, result.ok ? 200 : 409, { ...result.body, readback: readback?.settings.find((entry) => entry.key === key) ?? null });
      return;
    }
    if (request.method === "POST" && pathname === "/api/execution") {
      const body = await readJsonBody(request);
      const result = await writeExecution(String(body.action ?? ""), body);
      const readback = result.ok ? await executionState() : null;
      send(response, result.ok ? 200 : 409, { ...result.body, readback });
      return;
    }
    if (request.method === "GET" && pathname === "/api/agents-md") {
      const result = await agentsRead(url.searchParams.get("file") ?? PROSE_FILES[0]);
      send(response, result.status, result.body);
      return;
    }
    if (request.method === "PUT" && pathname === "/api/agents-md") {
      const result = await agentsWrite(await readJsonBody(request));
      send(response, result.status, result.body);
      return;
    }
    if (request.method === "GET" && pathname === "/api/agents-md/reconcile") {
      send(response, 200, await reconcile());
      return;
    }
    send(response, 404, { ok: false, reasonCode: "PORTAL_ROUTE_UNKNOWN" });
  } catch (error) {
    send(response, 500, { ok: false, reasonCode: error?.reasonCode ?? "PORTAL_INTERNAL_ERROR", error: String(error?.message ?? error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  const bound = server.address().port;
  process.stdout.write(`${JSON.stringify({
    reasonCode: "PORTAL_LISTENING",
    url: `http://127.0.0.1:${bound}/`,
    workspace: currentPartition().workspace,
    container: containerRoot || null,
    partitionMode,
    selectedPartition: selectedPartitionId,
    proseRoot: currentProseRoot(),
    actor: ACTOR,
    cli: CLI,
  })}\n`);
});
