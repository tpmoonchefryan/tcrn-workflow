// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-255 — exercise the MCP server over its actual stdio boundary.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  acquireWorkspaceLease,
  createProject,
  createWork,
  initializeWorkspace,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";

const SERVER = fileURLToPath(new URL("../dist/build/packages/mcp/src/index.js", import.meta.url));
const instant = (second) => `2026-09-02T00:00:${String(second).padStart(2, "0")}Z`;

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc255-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "FIXTURE-INC-255", createdAt: instant(1), segmentEventLimit: 64 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(2) });
  try {
    const project = await createProject(workspace, lease, {
      expectedVersion: 0, occurredAt: instant(3), externalKey: "INC-255-PROJECT", name: "INC-255",
    });
    await createWork(workspace, lease, {
      expectedVersion: project.version, occurredAt: instant(4), projectId: project.projects[0].id,
      externalKey: "INC-255-WORK", kind: "Incident", parentId: null, status: "active",
    });
  } finally {
    await lease.release();
  }
  return { base, workspace };
}

class StdioClient {
  constructor() {
    this.child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    this.stdout = Buffer.alloc(0);
    this.stderr = [];
    this.waiter = null;
    this.child.stdout.on("data", (chunk) => {
      this.stdout = Buffer.concat([this.stdout, chunk]);
      this.tryRead();
    });
    this.child.stderr.on("data", (chunk) => this.stderr.push(chunk));
    this.child.on("exit", (code, signal) => {
      if (this.waiter !== null) this.waiter.reject(new Error(`server exited ${String(code)} ${String(signal)}`));
    });
  }

  write(message, framing) {
    const body = JSON.stringify(message);
    if (framing === "newline") this.child.stdin.write(`${body}\n`);
    else this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  notify(message, framing) {
    this.write(message, framing);
  }

  request(message, framing) {
    assert.equal(this.waiter, null, "requests are serialized by this client");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`timed out waiting for ${message.method}`));
      }, 2_000);
      this.waiter = { framing, resolve: (value) => { clearTimeout(timer); this.waiter = null; resolve(value); }, reject: (error) => { clearTimeout(timer); this.waiter = null; reject(error); } };
      this.write(message, framing);
      this.tryRead();
    });
  }

  tryRead() {
    if (this.waiter === null) return;
    let body;
    if (this.waiter.framing === "newline") {
      const newline = this.stdout.indexOf(0x0a);
      if (newline < 0) return;
      body = this.stdout.subarray(0, newline);
      this.stdout = this.stdout.subarray(newline + 1);
      if (body.length > 0 && body[body.length - 1] === 0x0d) body = body.subarray(0, body.length - 1);
    } else {
      const separator = this.stdout.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const header = this.stdout.subarray(0, separator).toString("ascii");
      const match = header.match(/^Content-Length:\s*(\d+)$/iu);
      assert.ok(match, `invalid Content-Length response: ${header}`);
      const length = Number(match[1]);
      if (this.stdout.length < separator + 4 + length) return;
      body = this.stdout.subarray(separator + 4, separator + 4 + length);
      this.stdout = this.stdout.subarray(separator + 4 + length);
    }
    try {
      this.waiter.resolve(JSON.parse(body.toString("utf8")));
    } catch (error) {
      this.waiter.reject(error);
    }
  }

  async close() {
    this.child.kill("SIGTERM");
    await once(this.child, "exit");
    assert.equal(Buffer.concat(this.stderr).toString("utf8"), "");
  }
}

test("INC-255 stdio accepts newline JSON and retains Content-Length compatibility", async () => {
  const fx = await fixture();
  const client = new StdioClient();
  try {
    const before = (await validateWorkspace(fx.workspace)).version;
    const initialized = await client.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, "newline");
    assert.equal(initialized.result.serverInfo.name, "tcrn-workflow");
    client.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, "newline");
    const listed = await client.request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "newline");
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["work_search", "work_show", "knowledge_search", "work_draft", "status"]);
    const searched = await client.request({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "work_search", arguments: { workspace: fx.workspace, query: "INC-255" } },
    }, "newline");
    assert.equal(searched.result.structuredContent.records.length, 1);
    const legacy = await client.request({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, "content-length");
    assert.equal(legacy.result.tools.length, 5);
    client.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, "content-length");
    const after = (await validateWorkspace(fx.workspace)).version;
    assert.equal(after, before, "the MCP read surface does not mutate the chain");
  } finally {
    await client.close();
    await rm(fx.base, { recursive: true, force: true });
  }
});
