#!/usr/bin/env node
// TCRN-CROSS-INIT-019 STORY-167 — 待 Owner 队列:从链与仓取数渲染,不写成散文.
//
//   node tcrn-workflow/scripts/owner-queue.mjs [--partition cross-project]
//
// The queue is NOT prose — every row comes from a governed source or a committed
// declaration:
//   * work items in `blocked` status on the named partition (owner_intent gates);
//   * the INC-041 four carry-over to-dos (STORY-170 backfill targets);
//   * the release stop point (the only hard stop this initiative may not pass).
//
// Criterion (167.3): a non-empty queue with a pending item that has crossed its
// stated due/wait is NOT silent — the command exits non-zero, so a caller (the
// 168 runner, or a hand run) is reminded rather than quietly told "nothing".

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const READ_FACE_SERVER = resolve(PLATFORM_ROOT, "TCRN-AOS/deploy/aos-local-client/remote-read-mcp.mjs");

// INC-041 四件代办 (STORY-170 只补票不执行). Declared here; the backfill tickets live
// in docs/reports/init-019/BRIEFING.md section 7.
export const INC041_TODOS = Object.freeze([
  Object.freeze({ id: "S4.2", item: "Codex 侧应用三个 MCP 服务器增量 diff", status: "pending-owner-apply", evidence: "三个 MCP 服务器在 Codex 侧 status 实测可用 + parity:proof 白名单收缩后仍绿" }),
  Object.freeze({ id: "STORY-144", item: "enforce 切换(与 STORY-165 合流)", status: "waiting-observation-window", evidence: "切换后拦截一次真实误用并可回退" }),
  Object.freeze({ id: "S154", item: "archify 安装", status: "pending-owner-apply", evidence: "安装后重算 sha256 与钉扎一致,且在 skills 名册里可见" }),
  Object.freeze({ id: "otel-spans", item: "otel-spans 接线", status: "pending-owner-apply", evidence: "引擎跑一次真动词后 sink 里出现 verb span,且隐私门对该 sink exit 0" })
]);

export const RELEASE_STOP = Object.freeze({
  id: "release-stop",
  item: "TCRN-CROSS-INIT-019 对外发布(本 INIT 唯一必停点,归 Owner)",
  status: "owner-held",
  evidence: "发布前不可被任何执行者触发;开发期推整合分支不触发"
});

function callReadFace(tool, args, timeoutMs = 120_000) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [READ_FACE_SERVER], { stdio: ["pipe", "pipe", "inherit"] });
    let buffered = "";
    const frames = [];
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolvePromise({ ok: false, reasonCode: "READ_FACE_TIMEOUT", error: "read face timeout" }); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      while (buffered.includes("\n")) {
        const newline = buffered.indexOf("\n");
        frames.push(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    });
    const next = () => new Promise((r) => { const poll = () => { if (frames.length) return r(frames.shift()); setTimeout(poll, 20); }; poll(); });
    (async () => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "owner-queue", version: "0.1.0" } } })}\n`);
      await next();
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } })}\n`);
      const frame = await next();
      clearTimeout(timer);
      child.kill("SIGTERM");
      try {
        const parsed = JSON.parse(frame);
        const result = parsed?.result?.structuredContent ?? parsed?.result;
        if (parsed?.result?.isError === true) return resolvePromise({ ok: false, reasonCode: result?.reasonCode ?? "READ_FACE_REFUSED", error: result?.error ?? "" });
        resolvePromise({ ok: true, result });
      } catch {
        resolvePromise({ ok: false, reasonCode: "READ_FACE_NON_JSON", error: frame.slice(0, 120) });
      }
    })().catch((error) => { clearTimeout(timer); child.kill("SIGTERM"); resolvePromise({ ok: false, reasonCode: "READ_FACE_INTERNAL", error: String(error?.message ?? error) }); });
  });
}

export async function renderOwnerQueue({ partition = "cross-project" } = {}) {
  const blocked = await callReadFace("tcrn_remote_read_work_list", { partition, status: "blocked" });
  let blockedRows = [];
  if (blocked.ok) {
    const records = blocked.result?.result?.records ?? blocked.result?.records ?? [];
    blockedRows = records.map((r) => ({ source: "chain-blocked", id: r.externalKey ?? r.id, status: r.status }));
  }

  const rows = [
    ...blockedRows,
    ...INC041_TODOS.map((t) => ({ source: "inc041-todo", id: t.id, status: t.status, evidence: t.evidence })),
    { source: "release-stop", id: RELEASE_STOP.id, status: RELEASE_STOP.status, evidence: RELEASE_STOP.evidence }
  ];

  const reminder = rows.length > 0;
  return {
    schemaVersion: "tcrn.owner-queue.v1",
    partition,
    renderedAt: new Date().toISOString().replace(/\.\d+Z$/u, "Z"),
    ok: reminder === false,
    reasonCode: reminder === false ? "OWNER_QUEUE_EMPTY" : "OWNER_QUEUE_NONEMPTY_REMIND",
    count: rows.length,
    rows,
    criterion: "队列非空即提醒(exit 1);发布必停点恒在队首语义"
  };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const partition = process.argv.includes("--partition") ? process.argv[process.argv.indexOf("--partition") + 1] : "cross-project";
  const result = await renderOwnerQueue({ partition });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  for (const row of result.rows) {
    process.stderr.write(`- [${row.source}] ${row.id} (${row.status})${row.evidence ? ` — ${row.evidence}` : ""}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}
