#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
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
// The chain container sits beside the platform root; a partition's workspace is
// `<container>/.tcrn-workspace/<partition>/workspace`. Resolved by the same convention
// `platform-doctor.mjs` walks, so this repository answers from its own layout contract
// rather than importing another project's roster.
export function workspaceForPartition(partition, containerRoot = resolve(PLATFORM_ROOT, "..")) {
  return resolve(containerRoot, ".tcrn-workspace", String(partition), "workspace");
}

export const ENGINE_CLI = resolve(PLATFORM_ROOT, "tcrn-workflow/scripts/tcrn-workflow.mjs");

/**
 * One read against this repository's own engine.
 *
 * This used to spawn the sibling product project's MCP read face — the engine repository
 * executing another project's code in order to read its own chains, which is the
 * dependency direction the platform forbids. That face also forwarded over SSH to a host
 * the chains left in S199, so the round trip carried a remote-access shape for data
 * sitting on this disk. The envelope is unchanged ({ ok, reasonCode, result }); callers
 * already tolerated both `result.records` and `result.result.records`.
 */
export function callChainRead(verb, { partition, ...flags }, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const argv = [ENGINE_CLI, verb, "--workspace", workspaceForPartition(partition)];
    for (const [name, value] of Object.entries(flags)) {
      if (value === undefined || value === null) continue;
      argv.push(`--${name}`, String(value));
    }
    const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolvePromise({ ok: false, reasonCode: "CHAIN_READ_TIMEOUT", error: "the engine did not answer within the bound" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { err += chunk.toString("utf8"); });
    child.on("close", () => {
      clearTimeout(timer);
      const lines = `${out}${err}`.trim().split("\n");
      let parsed = null;
      try { parsed = JSON.parse(lines[lines.length - 1] ?? ""); } catch { parsed = null; }
      if (parsed === null) {
        resolvePromise({ ok: false, reasonCode: "CHAIN_READ_UNPARSEABLE", error: `${err || out}`.slice(-200) });
        return;
      }
      if (parsed.ok === false) {
        resolvePromise({ ok: false, reasonCode: parsed.reasonCode ?? "CHAIN_READ_REFUSED", error: parsed.error ?? null, result: parsed });
        return;
      }
      resolvePromise({ ok: true, reasonCode: parsed.reasonCode ?? null, result: parsed });
    });
  });
}

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

export async function renderOwnerQueue({ partition = "cross-project" } = {}) {
  const blocked = await callChainRead("work-list", { partition, status: "blocked" });
  let blockedRows = [];
  const readFailures = [];
  if (blocked.ok) {
    const records = blocked.result?.result?.records ?? blocked.result?.records ?? [];
    blockedRows = records.map((r) => ({ source: "chain-blocked", id: r.externalKey ?? r.id, status: r.status }));
  } else {
    // INC-051: a chain-read failure must NEVER silently empty the queue — the Owner
    // could lose a blocked item with no signal at any layer. It is a first-class row.
    readFailures.push({ source: "chain-read-failed", id: blocked.reasonCode ?? "READ_FAILED", status: "unreadable", evidence: blocked.error ?? "" });
  }

  const rows = [
    ...readFailures,
    ...blockedRows,
    ...INC041_TODOS.map((t) => ({ source: "inc041-todo", id: t.id, status: t.status, evidence: t.evidence })),
    { source: "release-stop", id: RELEASE_STOP.id, status: RELEASE_STOP.status, evidence: RELEASE_STOP.evidence }
  ];

  const reminder = rows.length > 0;
  const dataSourceFailed = readFailures.length > 0;
  return {
    schemaVersion: "tcrn.owner-queue.v1",
    partition,
    renderedAt: new Date().toISOString().replace(/\.\d+Z$/u, "Z"),
    ok: reminder === false && !dataSourceFailed,
    reasonCode: dataSourceFailed ? "OWNER_QUEUE_DATA_SOURCE_FAILED"
      : reminder === false ? "OWNER_QUEUE_EMPTY"
        : "OWNER_QUEUE_NONEMPTY_REMIND",
    count: rows.length,
    rows,
    dataSourceFailed,
    // INC-060: exit codes distinguish the three worlds — 0 empty, 1 reminder,
    // 2 chain-read failed (a data-source failure is a RUNNER failure, not a reminder).
    criterion: "exit 0 = empty · 1 = reminder · 2 = chain-read failed (data source unreadable, queue untrustworthy)"
  };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const partition = process.argv.includes("--partition") ? process.argv[process.argv.indexOf("--partition") + 1] : "cross-project";
  const result = await renderOwnerQueue({ partition });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  for (const row of result.rows) {
    process.stderr.write(`- [${row.source}] ${row.id} (${row.status})${row.evidence ? ` — ${row.evidence}` : ""}\n`);
  }
  if (result.dataSourceFailed) process.exitCode = 2;
  else if (!result.ok) process.exitCode = 1;
}
