#!/usr/bin/env node
// TCRN-CROSS-INIT-019 INC-052 — 收口绑定生效证据:tip 复量协议.
//
//   node tcrn-workflow/scripts/closeout-evidence-runner.mjs --batch <batch.json>
//
// A batch records, for each incident being closed, the set of EVIDENCE COMMANDS that
// prove the fix is alive (the fifth dispatch element). Closing a batch means re-running
// every evidence command against the FINAL HEAD — not against the tree at some earlier
// point, and not by hand-copying a result table. Any command whose expected outcome
// does not match the live run rejects the closeout (exit 1).
//
// WHY THIS EXISTS (INC-052, tip-remeasure protocol). The first remediation batch closed
// nine incidents whose fixes were real, but the batch itself shipped three red gates —
// the hygiene doc carried a literal username, a moved test missed the source allowlist,
// and the committed projection was two chain versions behind its own receipts. All three
// have the same root: the last full-gate run happened BEFORE the last commit. The five
// elements put an evidence command on the dispatch side; nothing on the close side
// re-ran them against HEAD. This runner is the close-side counterpart: it replays the
// batch's evidence command set against HEAD and produces the table from the commands'
// output, never from prose. A batch whose evidence is red on its own final tree is
// rejected — the exact shape INC-043..051 produced.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_BATCH = resolve(PLATFORM_ROOT, "TCRN-AOS/docs/reports/init-019/QA/closeout-batch.json");

/** One evidence command: run it, capture its exit code, judge against the expected sign. */
export function runEvidence(entry, platformRoot = PLATFORM_ROOT) {
  const dir = entry.dir ? resolve(platformRoot, entry.dir) : platformRoot;
  const args = typeof entry.cmd === "string" ? entry.cmd.split(/\s+/u) : entry.args;
  const program = typeof entry.cmd === "string" ? args.shift() : entry.program;
  const result = spawnSync(program, args, { cwd: dir, encoding: "utf8", timeout: entry.timeoutMs ?? 180_000 });
  const exit = result.status ?? (result.error ? String(result.error.code ?? "ERR") : "TIMEOUT");
  const expected = entry.expectedExit ?? 0;
  // exit 0 is only ever green for an expectedExit 0 command; a command declared to be
  // red (expectedExit: "nonzero") is green when it actually exits non-zero.
  const ok = (exit === expected) || (expected === "nonzero" && exit !== 0);
  return { cmd: entry.cmd ?? `${entry.program} ${(entry.args ?? []).join(" ")}`, dir, expected: String(expected), exit: String(exit), ok };
}

export function runBatch(batchPath) {
  let batch = null;
  try {
    batch = JSON.parse(readFileSync(batchPath, "utf8"));
  } catch {
    return { ok: false, reasonCode: "BATCH_UNREADABLE", error: `cannot read ${batchPath}` };
  }
  if (!Array.isArray(batch.incidents) || batch.incidents.length === 0) {
    return { ok: false, reasonCode: "BATCH_EMPTY", error: "batch must carry at least one incident" };
  }
  const rows = [];
  for (const incident of batch.incidents) {
    for (const entry of incident.evidence ?? []) {
      const result = runEvidence(entry);
      rows.push({ incident: incident.id, ...result });
    }
  }
  const red = rows.filter((r) => !r.ok);
  return {
    schemaVersion: "tcrn.closeout-evidence.v1",
    batchPath,
    ranAt: new Date().toISOString().replace(/\.\d+Z$/u, "Z"),
    ok: red.length === 0,
    reasonCode: red.length === 0 ? "CLOSEOUT_EVIDENCE_GREEN" : "CLOSEOUT_EVIDENCE_RED",
    incidents: batch.incidents.length,
    evidenceCount: rows.length,
    red,
    rows
  };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1]?.endsWith("closeout-evidence-runner.mjs")) {
  const batchPath = process.argv.includes("--batch")
    ? resolve(process.argv[process.argv.indexOf("--batch") + 1])
    : DEFAULT_BATCH;
  const result = runBatch(batchPath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  for (const row of result.rows ?? []) {
    process.stderr.write(`[${row.ok ? "ok" : "RED"}] ${row.incident}: ${row.cmd} → exit ${row.exit} (expected ${row.expected})\n`);
  }
  if (!result.ok) process.exitCode = 1;
}
