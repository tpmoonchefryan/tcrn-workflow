#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// TCRN Workflow Portal — zero-dependency local server.
//
// It owns no governance logic. Every read and every write is a child process
// call to the public TCRN Workflow CLI; the portal never imports an engine
// package, never touches a control tree, and never writes a chain file itself.
// AGENTS.md is ordinary repository prose and is read/written with plain fs.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { LOCALE_CONTRACT } from "./locale-contract.mjs";

const execFileAsync = promisify(execFile);
const portalRoot = dirname(fileURLToPath(import.meta.url));

// A portal request must never become a governed identity. The actor is declared
// once at startup so a browser payload can never nominate who wrote to a chain.
const ACTOR = process.env.TCRN_PORTAL_ACTOR ?? "agent:portal";
// The portal ships inside the engine, so the CLI it drives is the one it came
// with — resolved relative to this file rather than guessed at a machine-level
// path. A portal and an engine that arrived together cannot disagree about which
// version is running, which is the whole reason they are no longer two products.
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
const proseRoot = resolve(argument("prose-root", process.env.TCRN_PORTAL_PROSE_ROOT ?? (containerRoot ? dirname(containerRoot) : join(portalRoot, ".."))));
const port = Number(argument("port", process.env.TCRN_PORTAL_PORT ?? "4319"));
const attestDirArgument = argument("attest-dir", process.env.TCRN_PORTAL_ATTEST_DIR ?? "");
const attestDir = attestDirArgument ? resolve(attestDirArgument) : "";
const requestedPartition = argument("partition", process.env.TCRN_PORTAL_PARTITION ?? "");

if (workspace && containerRoot) {
  failStartup(startupError("PORTAL_TARGET_AMBIGUOUS", {}, "choose exactly one of --workspace or --container"));
}
if (!workspace && !containerRoot) {
  failStartup(startupError("PORTAL_TARGET_REQUIRED", {}, "usage: node portal.mjs --workspace <governed workspace path> | --container <.tcrn-workspace path> [--prose-root <dir>] [--port 4319]"));
}

async function discoverPartitions(root) {
  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch {
    throw startupError("PORTAL_CONTAINER_UNAVAILABLE", { container: root }, `container does not exist: ${root}`);
  }
  if (!rootInfo.isDirectory()) {
    throw startupError("PORTAL_CONTAINER_UNAVAILABLE", { container: root }, `container is not a directory: ${root}`);
  }

  const entries = await readdir(root, { withFileTypes: true });
  const partitions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const partitionRoot = join(root, entry.name);
    const partitionWorkspace = join(partitionRoot, "workspace");
    try {
      const workspaceInfo = await stat(partitionWorkspace);
      if (!workspaceInfo.isDirectory()) continue;
      let partitionAttestDir = attestDir;
      if (!partitionAttestDir) {
        const candidate = join(partitionRoot, "attestations");
        try {
          if ((await stat(candidate)).isDirectory()) partitionAttestDir = candidate;
        } catch { /* an attestation directory is optional for read-only runs */ }
      }
      partitions.push({ id: entry.name, workspace: partitionWorkspace, attestDir: partitionAttestDir });
    } catch { /* non-partition directories are ignored */ }
  }
  if (partitions.length === 0) {
    throw startupError("PORTAL_CONTAINER_EMPTY", { container: root, expected: "<partition>/workspace" }, `container has no partition workspaces: ${root}`);
  }
  return partitions.sort((left, right) => left.id.localeCompare(right.id));
}

let partitionCatalog;
try {
  partitionCatalog = containerRoot
    ? await discoverPartitions(containerRoot)
    : [{ id: "workspace", workspace, attestDir }];
} catch (error) {
  failStartup(error);
}

if (requestedPartition && !partitionCatalog.some((partition) => partition.id === requestedPartition)) {
  failStartup(startupError("PORTAL_PARTITION_UNKNOWN", {
    container: containerRoot || null,
    requestedPartition,
    partitions: partitionCatalog.map(({ id }) => id),
  }, `unknown partition: ${requestedPartition}`));
}

const partitionMode = Boolean(containerRoot);
let selectedPartitionId = requestedPartition || partitionCatalog[0].id;
const currentPartition = () => partitionCatalog.find((partition) => partition.id === selectedPartitionId) ?? partitionCatalog[0];

// Loopback plus a per-run token. The bind address alone does not stop another
// page in the same browser from POSTing here, so mutations carry a token that
// only this process ever printed.
const TOKEN = randomBytes(24).toString("hex");

async function cli(args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
    cwd: portalRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return JSON.parse(stdout);
}

// The CLI reports refusals as a non-zero exit with a canonical JSON body. Those
// are answers, not transport failures, so they are surfaced verbatim rather
// than collapsed into a generic 500 — a refused write must stay legible.
async function cliResult(args) {
  try {
    return { ok: true, body: await cli(args) };
  } catch (error) {
    const raw = String(error?.stderr ?? error?.stdout ?? "").trim();
    try {
      return { ok: false, body: JSON.parse(raw) };
    } catch {
      return { ok: false, body: { ok: false, reasonCode: "PORTAL_CLI_UNAVAILABLE", error: raw || String(error?.message ?? error) } };
    }
  }
}

const settingsCatalog = () => cli(["settings-catalog", "--workspace", currentPartition().workspace]);

const executionConfig = () => cli(["execution-config", "--workspace", currentPartition().workspace]);

// INIT-026 S236. Each portal action maps onto exactly one engine verb, and every
// write reads the live head first — the portal owns no governance logic, so a
// refusal (removing a pinned configuration, a ghost host) arrives verbatim from
// the engine and is shown, never translated.
async function writeExecution(action, body) {
  const selected = currentPartition();
  const status = await cli(["status", "--workspace", selected.workspace]);
  const base = ["--workspace", selected.workspace, "--expected-version", String(status.version),
    "--at", new Date().toISOString().slice(0, 19) + "Z", "--actor", ACTOR];
  if (selected.attestDir) base.push("--attest-dir", selected.attestDir);
  const verbs = {
    "config-set": () => ["host-config-set", ...base, "--host", String(body.host ?? ""), "--name", String(body.name ?? ""),
      "--model", String(body.model ?? ""), ...(body.note ? ["--note", String(body.note)] : [])],
    "config-remove": () => ["host-config-remove", ...base, "--host", String(body.host ?? ""), "--name", String(body.name ?? "")],
    "config-default": () => ["host-config-default", ...base, "--host", String(body.host ?? ""),
      ...(body.clear === true ? ["--clear", "true"] : ["--name", String(body.name ?? "")])],
    "binding-set": () => ["persona-binding-set", ...base, "--profile-id", String(body.profileId ?? ""),
      "--host", String(body.host ?? ""), "--name", String(body.name ?? "")],
    "binding-remove": () => ["persona-binding-remove", ...base, "--profile-id", String(body.profileId ?? ""), "--host", String(body.host ?? "")],
    "persona-set": () => ["persona-set", ...base, "--name", String(body.name ?? ""),
      "--description", String(body.description ?? ""), "--role", String(body.role ?? ""),
      "--prompt", String(body.prompt ?? "")],
    "persona-remove": () => ["persona-remove", ...base, "--name", String(body.name ?? "")],
  };
  const build = verbs[action];
  if (!build) return { ok: false, body: { ok: false, reasonCode: "PORTAL_UNKNOWN_ACTION", error: String(action) } };
  return cliResult(build());
}

async function writeSetting(key, value) {
  // Read the live head immediately before the write: expected-version supplied
  // from anywhere else would freeze nothing.
  const selected = currentPartition();
  const status = await cli(["status", "--workspace", selected.workspace]);
  const args = [
    "settings-set", "--workspace", selected.workspace,
    "--expected-version", String(status.version),
    "--at", new Date().toISOString().slice(0, 19) + "Z",
    "--key", key, "--value", value, "--actor", ACTOR,
  ];
  if (selected.attestDir) args.push("--attest-dir", selected.attestDir);
  return cliResult(args);
}

function proseTarget(name) {
  if (!PROSE_FILES.includes(name)) return null;
  const path = join(proseRoot, name);
  // Belt and braces: the allow-list already fixes the basename, and the
  // resolved path is confirmed to stay under the declared prose root.
  return isAbsolute(path) && resolve(path).startsWith(proseRoot) ? path : null;
}

// Reconciliation compares two things that drift apart in practice: the setting
// keys prose claims exist, and the keys the engine actually registers. A key
// named only in prose is a stale document; the check is red when one is found.
const KEY_PATTERN = /\b([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+)\b/gu;

async function reconcile() {
  const catalog = await settingsCatalog();
  const registered = new Set(catalog.settings.map((entry) => entry.key));
  const rows = [];
  for (const name of PROSE_FILES) {
    const path = proseTarget(name);
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const claimed = new Set();
    for (const match of text.matchAll(KEY_PATTERN)) {
      const candidate = match[1];
      // Only keys whose namespace the engine already knows are treated as
      // claims; every other dotted token in prose is ordinary English.
      const namespace = candidate.slice(0, candidate.indexOf("."));
      if ([...registered].some((key) => key.startsWith(`${namespace}.`))) claimed.add(candidate);
    }
    for (const key of [...claimed].sort()) {
      rows.push({ file: name, key, registered: registered.has(key) });
    }
  }
  const mismatches = rows.filter((row) => !row.registered);
  return {
    reasonCode: mismatches.length === 0 ? "PROSE_MATCHES_CATALOG" : "PROSE_CLAIMS_UNREGISTERED_KEY",
    ok: mismatches.length === 0,
    registered: [...registered].sort(),
    rows,
    mismatchCount: mismatches.length,
  };
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(payload);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("payload too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  try {
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(join(portalRoot, "index.html"), "utf8");
      const boot = JSON.stringify({
        token: TOKEN,
        workspace: currentPartition().workspace,
        container: containerRoot || null,
        partitionMode,
        partitions: partitionCatalog.map(({ id }) => ({ id })),
        selectedPartition: selectedPartitionId,
        proseRoot,
        actor: ACTOR,
        proseFiles: PROSE_FILES,
        ...LOCALE_CONTRACT,
      });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html.replace("__PORTAL_BOOT__", boot.replace(/</gu, "\\u003c")));
      return;
    }

    if (request.method === "GET" && url.pathname === "/locales.js") {
      const script = await readFile(join(portalRoot, "locales.js"), "utf8");
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(script);
      return;
    }

    if (request.method === "GET" && url.pathname === "/tokens.css") {
      // The design system's token file, served verbatim. scripts/design-proof.mjs
      // fails if this copy drifts from @tcrn/ui-tokens.
      const css = await readFile(join(portalRoot, "tokens.css"), "utf8");
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      response.end(css);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "GET" && request.headers["x-portal-token"] !== TOKEN) {
        send(response, 403, { ok: false, reasonCode: "PORTAL_TOKEN_REQUIRED" });
        return;
      }
      if (url.pathname === "/api/settings" && request.method === "GET") {
        send(response, 200, await settingsCatalog());
        return;
      }
      if (url.pathname === "/api/partitions" && request.method === "GET") {
        send(response, 200, {
          ok: true,
          reasonCode: "PORTAL_PARTITIONS_READY",
          mode: partitionMode ? "container" : "workspace",
          partitions: partitionCatalog.map(({ id }) => ({ id })),
          selectedPartition: selectedPartitionId,
        });
        return;
      }
      if (url.pathname === "/api/partition" && request.method === "POST") {
        const body = await readJsonBody(request);
        const next = String(body.partition ?? body.id ?? "");
        const selected = partitionCatalog.find((partition) => partition.id === next);
        if (!selected) {
          send(response, 404, {
            ok: false,
            reasonCode: "PORTAL_PARTITION_UNKNOWN",
            requestedPartition: next,
            partitions: partitionCatalog.map(({ id }) => id),
          });
          return;
        }
        selectedPartitionId = selected.id;
        send(response, 200, {
          ok: true,
          reasonCode: "PORTAL_PARTITION_SELECTED",
          selectedPartition: selected.id,
          workspace: selected.workspace,
        });
        return;
      }
      if (url.pathname === "/api/settings" && request.method === "POST") {
        const body = await readJsonBody(request);
        const result = await writeSetting(String(body.key ?? ""), String(body.value ?? ""));
        const readback = result.ok ? await settingsCatalog() : null;
        send(response, result.ok ? 200 : 409, {
          ...result.body,
          readback: readback?.settings.find((entry) => entry.key === body.key) ?? null,
        });
        return;
      }
      if (url.pathname === "/api/execution" && request.method === "GET") {
        send(response, 200, await executionConfig());
        return;
      }
      if (url.pathname === "/api/execution" && request.method === "POST") {
        const body = await readJsonBody(request);
        const result = await writeExecution(String(body.action ?? ""), body);
        const readback = result.ok ? await executionConfig() : null;
        send(response, result.ok ? 200 : 409, { ...result.body, readback });
        return;
      }
      if (url.pathname === "/api/prose" && request.method === "GET") {
        const path = proseTarget(url.searchParams.get("file") ?? PROSE_FILES[0]);
        if (!path) { send(response, 404, { ok: false, reasonCode: "PORTAL_PROSE_NOT_ALLOWED" }); return; }
        let text = "";
        try { text = await readFile(path, "utf8"); } catch { text = ""; }
        send(response, 200, { ok: true, reasonCode: "PORTAL_PROSE_READ", path, text });
        return;
      }
      if (url.pathname === "/api/prose" && request.method === "POST") {
        const body = await readJsonBody(request);
        const path = proseTarget(String(body.file ?? ""));
        if (!path) { send(response, 404, { ok: false, reasonCode: "PORTAL_PROSE_NOT_ALLOWED" }); return; }
        await writeFile(path, String(body.text ?? ""), "utf8");
        const readback = await readFile(path, "utf8");
        send(response, 200, { ok: true, reasonCode: "PORTAL_PROSE_WRITTEN", path, matches: readback === String(body.text ?? "") });
        return;
      }
      if (url.pathname === "/api/reconcile" && request.method === "GET") {
        send(response, 200, await reconcile());
        return;
      }
      send(response, 404, { ok: false, reasonCode: "PORTAL_ROUTE_UNKNOWN" });
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  } catch (error) {
    send(response, 500, { ok: false, reasonCode: "PORTAL_INTERNAL_ERROR", error: String(error?.message ?? error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  // Port 0 asks the OS to pick, so the bound port -- not the requested one --
  // is what callers must be told.
  const bound = server.address().port;
  process.stdout.write(`${JSON.stringify({
    reasonCode: "PORTAL_LISTENING",
    url: `http://127.0.0.1:${bound}/`,
    workspace: currentPartition().workspace,
    container: containerRoot || null,
    partitionMode,
    selectedPartition: selectedPartitionId,
    proseRoot, actor: ACTOR, cli: CLI,
  })}\n`);
  process.stdout.write(`open http://127.0.0.1:${bound}/ (token is injected into the page; mutations without it are refused)\n`);
});
