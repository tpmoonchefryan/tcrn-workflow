#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// TCRN Workflow Portal — a zero-dependency local projection of the public CLI.
// The portal owns no governance state. Chain reads and writes go through the
// bundled CLI; AGENTS.md is ordinary workspace prose and is handled with fs.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { LOCALE_CONTRACT } from "./locale-contract.mjs";

const execFileAsync = promisify(execFile);
const portalRoot = dirname(fileURLToPath(import.meta.url));
const ACTOR = (process.env.TCRN_PORTAL_ACTOR ?? "agent:portal").trim();
const BUNDLED_CLI = join(portalRoot, "..", "scripts", "tcrn-workflow.mjs");
const HOST_RENDER = join(portalRoot, "..", "scripts", "host-render.mjs");
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
const portArgument = argument("port", process.env.TCRN_PORTAL_PORT ?? "");
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

// INC-203: the catalog above is a snapshot of the container at boot. A partition
// admitted afterwards stayed invisible here until someone happened to restart the
// portal, with nothing on screen to suggest the list was stale — the switcher is the
// portal's whole answer to "which partitions exist", so it has to answer from the
// container rather than from a memory of it. A readdir per read is nothing on a
// loopback tool. A failed rescan keeps the last good catalog: a transient filesystem
// error should not empty the switcher.
async function refreshPartitionCatalog() {
  if (!containerRoot) return partitionCatalog;
  try {
    partitionCatalog = await discoverPartitions(containerRoot);
  } catch { /* keep the last good catalog */ }
  return partitionCatalog;
}
// STORY-355: the old default resolved into the selected partition's own directory
// inside the chain container, so every partition's Rules page silently read an
// empty file instead of the real AGENTS.md. Prose is not partitioned: it is one
// document living above the chain container. The default is therefore derived to
// land outside the container by construction -- walking up past the
// .tcrn-workspace segment when the target sits inside one -- and the refusal below
// only ever fires on a --prose-root someone chose explicitly. Refusing the derived
// default instead would make --workspace mode unbootable against every governed
// partition, which is worse than the bug being fixed.
const CHAIN_CONTAINER_DIRECTORY = [".tcrn", "workspace"].join("-");

function defaultProseRoot() {
  const base = containerRoot ? containerRoot : currentPartition().workspace;
  const segments = resolve(base).split(sep);
  const index = segments.indexOf(CHAIN_CONTAINER_DIRECTORY);
  // Above the container when the target is inside one; the target's parent otherwise.
  return index === -1 ? dirname(resolve(base)) : segments.slice(0, index).join(sep) || sep;
}

const currentProseRoot = () => {
  if (!proseRootArgument) return defaultProseRoot();
  const root = resolve(proseRootArgument);
  if (root.split(sep).includes(CHAIN_CONTAINER_DIRECTORY)) {
    throw startupError("PORTAL_PROSE_ROOT_UNSAFE", { proseRoot: root }, "prose root must not resolve inside a chain container");
  }
  return root;
};
// Fail at boot rather than on the first Rules read.
try { currentProseRoot(); } catch (error) { failStartup(error); }
async function currentWorkspaceName() {
  try {
    const metadata = JSON.parse(await readFile(join(currentPartition().workspace, ".tcrn-workflow", "workspace.json"), "utf8"));
    if (typeof metadata.externalKey === "string" && metadata.externalKey.length > 0) return metadata.externalKey;
  } catch { /* legacy or incomplete workspace metadata falls back to the partition id */ }
  return currentPartition().id;
}
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

// STORY-281: machine preferences are read through the engine, never by parsing the
// file here — the engine owns validation, and a second reader would be a second set of
// rules. An unreadable layer degrades to "no preference" rather than refusing to open
// the portal: these are conveniences, and none of them is worth a startup failure.
async function machineSettings() {
  try { return await cli(["machine-settings-catalog"]); } catch { return null; }
}
async function machineValue(key) {
  const catalogue = await machineSettings();
  return catalogue?.settings?.find((entry) => entry.key === key)?.currentValue ?? null;
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
const vocabulary = () => cli(["vocabulary"]);
const commands = () => cli(["commands"]);
const DISPATCH_SETTING_KEYS = new Set(["execution.dispatchClasses", "execution.dispatchMode", "execution.dispatchModes", "execution.dispatchTiers"]);

function readInstant() {
  return new Date().toISOString();
}

async function workProjection() {
  const selected = currentPartition();
  const result = await cliResult(["work-list", "--workspace", selected.workspace, "--limit", "4096"]);
  if (!result.ok) return { ok: false, reasonCode: "PORTAL_WORK_READ_FAILED", source: result.body, records: [], total: 0 };
  return { ok: true, reasonCode: "PORTAL_WORK_READY", workspaceId: result.body.workspaceId ?? null, version: result.body.version ?? null, headEventHash: result.body.headEventHash ?? null, total: result.body.total ?? result.body.records?.length ?? 0, records: result.body.records ?? [] };
}

async function knowledgeProjection() {
  const selected = currentPartition();
  const at = readInstant();
  const [listing, retirement] = await Promise.all([
    cliResult(["knowledge-list", "--workspace", selected.workspace, "--at", at, "--selection", "all", "--allow-trailing", "true"]),
    cliResult(["retire-proposals", "--workspace", selected.workspace, "--at", at]),
  ]);
  return {
    ok: listing.ok || retirement.ok,
    reasonCode: listing.ok ? "PORTAL_KNOWLEDGE_READY" : "PORTAL_KNOWLEDGE_PARTIAL",
    at,
    listing: listing.body,
    retirement: retirement.body,
    records: listing.ok ? (listing.body.records ?? []) : [],
    total: listing.ok ? (listing.body.total ?? listing.body.records?.length ?? 0) : 0,
  };
}

async function gateProjection() {
  const selected = currentPartition();
  const result = await cliResult(["gate-list-all", "--workspace", selected.workspace]);
  if (!result.ok) return { ok: false, reasonCode: "PORTAL_GATES_READ_FAILED", source: result.body, records: [], total: 0 };
  return { ok: true, reasonCode: "PORTAL_GATES_READY", workspaceId: result.body.workspaceId ?? null, version: result.body.version ?? null, headEventHash: result.body.headEventHash ?? null, total: result.body.total ?? 0, records: result.body.records ?? [] };
}

async function hostSettingsProjection(host) {
  const args = [HOST_RENDER, "--host", host, "--workspace", currentPartition().workspace, "--root", defaultProseRoot(), "--plan-only", "--hooks-only"];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: portalRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const body = JSON.parse(stdout);
    return { ok: true, host, ...body };
  } catch (error) {
    return { ok: false, host, ...childResult(error, "PORTAL_HOST_SETTINGS_UNAVAILABLE") };
  }
}

async function retrievalEvaluation() {
  try {
    const { stdout } = await execFileAsync(process.execPath, [join(portalRoot, "..", "scripts", "retrieval-eval.mjs")], { cwd: portalRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const lines = stdout.trim().split("\n").filter((line) => line.length > 0);
    return JSON.parse(lines.at(-1) ?? "{}");
  } catch (error) {
    return childResult(error, "PORTAL_RETRIEVAL_EVAL_UNAVAILABLE");
  }
}

function modeStats(records) {
  const modes = new Map();
  for (const record of records) {
    const payload = record?.payload ?? {};
    const mode = typeof payload.mode === "string" && payload.mode.length > 0 ? payload.mode : "unknown";
    const current = modes.get(mode) ?? { events: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, inputKnown: false, outputKnown: false, totalKnown: false, reworkKnown: 0, reworkCount: 0 };
    current.events += 1;
    const usage = payload.usage;
    if (usage && typeof usage === "object") {
      if (typeof usage.inputTokens === "number") { current.inputKnown = true; current.inputTokens += usage.inputTokens; }
      if (typeof usage.outputTokens === "number") { current.outputKnown = true; current.outputTokens += usage.outputTokens; }
      if (typeof usage.totalTokens === "number") { current.totalKnown = true; current.totalTokens += usage.totalTokens; }
    }
    if (typeof payload.rework === "boolean") { current.reworkKnown += 1; if (payload.rework) current.reworkCount += 1; }
    modes.set(mode, current);
  }
  return Object.fromEntries([...modes.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([mode, value]) => [mode, {
    events: value.events,
    inputTokens: value.inputKnown ? value.inputTokens : null,
    outputTokens: value.outputKnown ? value.outputTokens : null,
    totalTokens: value.totalKnown ? value.totalTokens : null,
    reworkRate: value.reworkKnown === 0 ? null : Number((value.reworkCount / value.reworkKnown).toFixed(4)),
    reworkObserved: value.reworkKnown,
  }]));
}

async function evolutionProjection() {
  const selected = currentPartition();
  const at = readInstant();
  const [stats, listing, retirement, retrieval, claude, codex] = await Promise.all([
    cliResult(["telemetry-stats", "--workspace", selected.workspace]),
    cliResult(["telemetry-list", "--workspace", selected.workspace, "--limit", "4096"]),
    cliResult(["retire-proposals", "--workspace", selected.workspace, "--at", at]),
    retrievalEvaluation(),
    hostSettingsProjection("claude-code"),
    hostSettingsProjection("codex"),
  ]);
  const telemetryRecords = listing.ok && Array.isArray(listing.body.records) ? listing.body.records : [];
  const pending = retirement.ok && Array.isArray(retirement.body?.proposals) ? retirement.body.proposals.filter((entry) => entry.automatic === true).length : 0;
  const retired = retirement.ok && Array.isArray(retirement.body?.retiredRecords) ? retirement.body.retiredRecords.length : 0;
  return {
    ok: true,
    reasonCode: "PORTAL_EVOLUTION_READY",
    at,
    partial: !stats.ok || !listing.ok || !retirement.ok || retrieval.ok === false,
    telemetry: stats.body,
    modeStats: modeStats(telemetryRecords),
    retirement: retirement.body,
    pendingRetirementCount: pending,
    retiredCount: retired,
    retrievalEval: retrieval,
    hosts: [claude, codex],
  };
}

async function executionState() {
  const [settings, classes, dispatch] = await Promise.all([
    settingsCatalog(),
    cli(["dispatch-classes-list", "--workspace", currentPartition().workspace]),
    cli(["dispatch-mode-list", "--workspace", currentPartition().workspace]),
  ]);
  return {
    ok: true,
    reasonCode: "PORTAL_EXECUTION_READY",
    workspaceId: settings.workspaceId,
    version: settings.version ?? classes.version ?? null,
    headEventHash: settings.headEventHash ?? classes.headEventHash ?? null,
    settings: settings.settings,
    plans: [],
    classes: classes.classes,
    dispatch: {
      mode: dispatch.mode,
      modes: dispatch.modes,
      tiers: dispatch.tiers,
    },
  };
}

function nextOccurredAt() {
  const now = Date.now();
  lastWriteAt = Math.max(now, lastWriteAt + 1000);
  return new Date(lastWriteAt).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function childResult(error, fallback = "PORTAL_HOST_RENDER_FAILED") {
  const raw = String(error?.stderr ?? error?.stdout ?? "").trim();
  const lines = raw.split("\n").filter((line) => line.length > 0);
  try { return JSON.parse(lines.at(-1) ?? ""); } catch { return { ok: false, reasonCode: fallback, error: raw || String(error?.message ?? error) }; }
}

async function hostRenderOne(host, hooksOnly = false) {
  const args = [HOST_RENDER, "--host", host, "--workspace", currentPartition().workspace, "--root", defaultProseRoot()];
  if (hooksOnly) args.push("--hooks-only");
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: portalRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    return childResult(error);
  }
}

async function renderHostProjection() {
  const hosts = [];
  for (const host of ["claude-code", "codex"]) {
    let result = await hostRenderOne(host);
    if (result.reasonCode === "HOST_RENDER_MODEL_UNSET") result = await hostRenderOne(host, true);
    hosts.push({ host, ...result });
  }
  const ok = hosts.every((result) => ["HOST_RENDER_COMMITTED", "HOST_RENDER_ALREADY_CURRENT"].includes(result.reasonCode));
  return { ok, reasonCode: ok ? "HOST_RENDER_PROJECTION_READY" : "HOST_RENDER_PROJECTION_FAILED", root: defaultProseRoot(), hosts };
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

function stableId(namespace, externalKey) {
  const key = String(externalKey).toUpperCase();
  return `${namespace}:${createHash("sha256").update(`${namespace}\u0000${key}`, "utf8").digest("hex").slice(0, 24)}`;
}

function articlePathFor(title) {
  return `article-${createHash("sha256").update(String(title), "utf8").digest("hex").slice(0, 24)}.md`;
}

function articleSummaryFor(content) {
  const firstParagraph = String(content).split(/\n\s*\n/u).map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  const bytes = Buffer.from(firstParagraph, "utf8");
  if (bytes.length <= 2048) return firstParagraph;
  let end = 2048;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function languageBundlePath(value) {
  if (value === undefined || value === null || String(value).length === 0) return undefined;
  // CLI subprocesses run from portalRoot. Relative provider bundles therefore
  // resolve from that directory; article paths remain workspace-relative and
  // are resolved by the engine against the selected workspace.
  return isAbsolute(String(value)) ? resolve(String(value)) : resolve(portalRoot, String(value));
}

async function governedArticleWrite(build, action, summary) {
  const selected = currentPartition();
  const occurredAt = nextOccurredAt();
  let result;
  try {
    // Article CAS belongs to the disposable knowledge store, not the workspace
    // chain. Reading status here would reuse the wrong version number.
    const marker = await cliResult(["knowledge-validate", "--workspace", selected.workspace]);
    if (!marker.ok) {
      result = marker;
    } else {
      const common = ["--workspace", selected.workspace, "--expected-version", String(marker.body.version), "--at", occurredAt];
      result = await cliResult(build(common));
    }
  } catch (error) {
    result = { ok: false, body: { ok: false, reasonCode: "PORTAL_CLI_UNAVAILABLE", error: String(error?.message ?? error) } };
  }
  recordSessionWrite(action, result, summary, occurredAt);
  return result;
}

function writeArticle(body) {
  const title = String(body.title ?? "");
  const category = String(body.category ?? "");
  const content = String(body.content ?? body.body ?? "");
  const path = String(body.path ?? articlePathFor(title));
  const externalKey = `ARTICLE-${createHash("sha256").update(path, "utf8").digest("hex").slice(0, 24).toUpperCase()}`;
  const owner = String(body.accountableOwnerId ?? stableId("owner", "PORTAL-OWNER"));
  const evidenceIds = Array.isArray(body.evidenceIds) && body.evidenceIds.length > 0
    ? body.evidenceIds.map((value) => String(value))
    : [stableId("evidence", externalKey)];
  const bundle = languageBundlePath(body.languageBundle);
  const args = (common) => [
    "knowledge-article-create", ...common,
    "--path", path,
    "--category", category,
    "--title", title,
    "--summary", String(body.summary ?? articleSummaryFor(content)),
    "--content", content,
    "--accountable-owner-id", owner,
    "--evidence-ids", evidenceIds.join(","),
    ...(bundle === undefined ? [] : ["--language-bundle", bundle]),
  ];
  return governedArticleWrite(args, "knowledge-article-create", title || "article");
}

async function writeSetting(key, value) {
  const result = await governedWrite(
    (common) => ["settings-set", ...common, "--key", String(key), "--value", String(value)],
    "settings-set",
    `${key} → ${value}`,
  );
  if (result.ok && DISPATCH_SETTING_KEYS.has(key)) {
    return { ...result, body: { ...result.body, hostRender: await renderHostProjection() } };
  }
  return result;
}

async function removeSetting(key) {
  const result = await governedWrite(
    (common) => ["settings-remove", ...common, "--key", String(key)],
    "settings-remove",
    `${key} reset`,
  );
  if (result.ok && DISPATCH_SETTING_KEYS.has(key)) {
    return { ...result, body: { ...result.body, hostRender: await renderHostProjection() } };
  }
  return result;
}

async function writeExecution(action, body) {
  const text = (value) => String(value ?? "");
  const verbs = {
    "model-plan-set": (common) => ["model-plan-set", ...common, "--host", text(body.host), "--name", text(body.name), "--default-model", text(body.defaultModel), ...(text(body.defaultEffort) ? ["--default-effort", text(body.defaultEffort)] : [])],
    "model-plan-assign": (common) => ["model-plan-assign", ...common, "--host", text(body.host), "--plan", text(body.plan ?? body.name), "--persona", text(body.persona), "--model", text(body.model), ...(body.effort ? ["--effort", text(body.effort)] : [])],
    "model-plan-unassign": (common) => ["model-plan-unassign", ...common, "--host", text(body.host), "--plan", text(body.plan ?? body.name), "--persona", text(body.persona)],
    "model-plan-remove": (common) => ["model-plan-remove", ...common, "--host", text(body.host), "--name", text(body.name)],
    "dispatch-tiers-set": (common) => ["dispatch-tiers-set", ...common, "--host", text(body.host), "--tiers", JSON.stringify(body.tiers ?? {})],
    "dispatch-mode-set": (common) => ["dispatch-mode-set", ...common, "--name", text(body.name), "--mapping", JSON.stringify(body.mapping ?? {})],
  };
  const build = verbs[action];
  if (!build) {
    const result = { ok: false, body: { ok: false, reasonCode: "PORTAL_UNKNOWN_ACTION", error: action } };
    recordSessionWrite(action, result, action, new Date().toISOString());
    return Promise.resolve(result);
  }
  const result = await governedWrite(build, action, body.summary ?? action);
  if (result.ok && ["dispatch-tiers-set", "dispatch-mode-set"].includes(action)) {
    return { ...result, body: { ...result.body, hostRender: await renderHostProjection() } };
  }
  return result;
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

// STORY-355: the portal binds loopback only, but a browser sends whatever Host header
// the request carries, and DNS rebinding lets an attacker-controlled page point that
// header at a name that still resolves to 127.0.0.1. Comparing the hostname portion for
// exact equality (never substring or prefix) closes that: `127.0.0.1.attacker.example`
// is not `127.0.0.1`. Split on the LAST colon so a port, if present, is validated as
// digits-only rather than folded into the hostname comparison.
function isLoopbackHost(hostHeader) {
  const host = String(hostHeader ?? "");
  const lastColon = host.lastIndexOf(":");
  const hostname = (lastColon === -1 ? host : host.slice(0, lastColon)).toLowerCase();
  const port = lastColon === -1 ? "" : host.slice(lastColon + 1);
  if (hostname !== "127.0.0.1" && hostname !== "localhost") return false;
  if (port !== "" && !/^[0-9]+$/u.test(port)) return false;
  return true;
}

const server = createServer(async (request, response) => {
  if (!isLoopbackHost(request.headers.host)) {
    send(response, 403, { ok: false, reasonCode: "PORTAL_HOST_REJECTED" });
    return;
  }
  const url = new URL(request.url, "http://127.0.0.1");
  const pathname = apiAlias(url.pathname);
  try {
    if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = await readFile(join(portalRoot, "index.html"), "utf8");
      const boot = JSON.stringify({
        token: TOKEN,
        workspace: currentPartition().workspace,
        workspaceName: await currentWorkspaceName(),
        container: containerRoot || null,
        partitionMode,
        partitions: (await refreshPartitionCatalog()).map(({ id }) => ({ id })),
        selectedPartition: selectedPartitionId,
        proseRoot: currentProseRoot(),
        paths: currentPaths(),
        actor: ACTOR,
        proseFiles: PROSE_FILES,
        machineDefaults: {
          locale: await machineValue("portal.defaultLocale"),
          theme: await machineValue("portal.defaultTheme"),
          partition: await machineValue("portal.defaultPartition"),
        },
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
    if (request.method === "GET" && pathname === "/tcrn-brand-mark.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(join(portalRoot, "tcrn-brand-mark.svg"), "utf8"));
      return;
    }
    if (!pathname.startsWith("/api/")) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found\n");
      return;
    }
    if (request.headers["x-portal-token"] !== TOKEN) {
      send(response, 403, { ok: false, reasonCode: "PORTAL_TOKEN_REQUIRED" });
      return;
    }
    if (request.method === "GET" && pathname === "/api/settings") {
      send(response, 200, await settingsCatalog());
      return;
    }
    if (request.method === "GET" && pathname === "/api/machine-settings") {
      send(response, 200, (await machineSettings()) ?? { reasonCode: "MACHINE_SETTINGS_UNAVAILABLE", settings: [] });
      return;
    }
    if (request.method === "GET" && pathname === "/api/execution") {
      send(response, 200, await executionState());
      return;
    }
    if (request.method === "GET" && pathname === "/api/work") {
      send(response, 200, await workProjection());
      return;
    }
    if (request.method === "GET" && pathname === "/api/knowledge") {
      send(response, 200, await knowledgeProjection());
      return;
    }
    if (request.method === "GET" && pathname === "/api/gates") {
      send(response, 200, await gateProjection());
      return;
    }
    if (request.method === "GET" && pathname === "/api/evolution") {
      send(response, 200, await evolutionProjection());
      return;
    }
    if (request.method === "POST" && pathname === "/api/host-probe") {
      const body = await readJsonBody(request);
      const args = ["host-probe", "--host", String(body.host ?? ""), "--model", String(body.model ?? "")];
      if (body.timeoutMs !== undefined) args.push("--timeout-ms", String(body.timeoutMs));
      const result = await cliResult(args);
      send(response, result.ok ? 200 : 409, result.body);
      return;
    }
    if (request.method === "POST" && pathname === "/api/knowledge/articles") {
      const result = await writeArticle(await readJsonBody(request));
      // The engine receipt is the endpoint body. Do not wrap it in a portal
      // success object: the drawer must display the engine's reasonCode verbatim.
      send(response, result.ok ? 200 : 409, result.body);
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
      send(response, 200, { ok: true, reasonCode: "PORTAL_PARTITIONS_READY", mode: partitionMode ? "container" : "workspace", partitions: (await refreshPartitionCatalog()).map(({ id }) => ({ id })), selectedPartition: selectedPartitionId });
      return;
    }
    if (request.method === "POST" && pathname === "/api/partition") {
      const body = await readJsonBody(request);
      const next = String(body.partition ?? body.id ?? "");
      const selected = partitionCatalog.find((entry) => entry.id === next);
      if (!selected) { send(response, 404, { ok: false, reasonCode: "PORTAL_PARTITION_UNKNOWN", requestedPartition: next }); return; }
      selectedPartitionId = selected.id;
      send(response, 200, { ok: true, reasonCode: "PORTAL_PARTITION_SELECTED", selectedPartition: selected.id, workspace: selected.workspace, workspaceName: await currentWorkspaceName(), proseRoot: currentProseRoot(), paths: currentPaths() });
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
    if (request.method === "POST" && pathname === "/api/machine-settings") {
      const body = await readJsonBody(request);
      const key = String(body.key ?? "");
      const now = new Date().toISOString();
      const result = body.reset === true
        ? await cliResult(["machine-settings-remove", "--at", now, "--key", key])
        : await cliResult(["machine-settings-set", "--at", now, "--key", key, "--value", String(body.value ?? "")]);
      const readback = result.ok ? await machineSettings() : null;
      send(response, result.ok ? 200 : 409, { ...result.body, readback: readback?.settings?.find((entry) => entry.key === key) ?? null });
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

const port = Number(portArgument || (await machineValue("portal.port")) || "4319");
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
