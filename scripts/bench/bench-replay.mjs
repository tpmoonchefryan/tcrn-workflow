#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// S12.2 — replay benchmark over a synthesized scratch chain (TCRN-CROSS-STORY-142).
//
// Runs the four common read verbs — status, validate, export, work-list — against
// a scratch chain produced by synthesize-chain.mjs, each at least 5 times, and
// reports the median wall-clock per verb plus a markdown table. The benchmark NEVER
// runs against a live chain: it takes the workspace path from a synthesized-N.json
// (which lives in the scratch base dir) or is handed one explicitly, and both are
// outside any repository.
//
// Usage:
//   node scripts/bench/bench-replay.mjs --workspace <path> --label <n> [--out-dir <path>]
//
// Writes <out-dir>/bench-<label>.json and bench-<label>.md.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = resolve(REPO_ROOT, "scripts/tcrn-workflow.mjs");

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const workspace = resolve(argument("workspace") ?? "");
const label = argument("label") ?? "chain";
const outDir = resolve(argument("out-dir") ?? join(REPO_ROOT, "docs/reports/init-018/S12"));
const RUNS = 5;

if (!workspace || !workspace.endsWith("/workspace")) {
  process.stderr.write("--workspace must point at a synthesized chain's workspace root (ends with /workspace)\n");
  process.exit(2);
}

const VERBS = [
  ["status", ["status", "--workspace", workspace]],
  ["validate", ["validate", "--workspace", workspace]],
  ["export", ["export", "--workspace", workspace]],
  ["work-list", ["work-list", "--workspace", workspace, "--limit", "200"]]
];

function oneRun(argv) {
  const start = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { json = null; }
  // On refusal the CLI writes the JSON error to stderr, so a refusal's reasonCode is
  // read from there when stdout carries nothing (export's INPUT_OVERSIZED, for one).
  let refusal = null;
  if (json === null && result.stderr.trim() !== "") {
    try { refusal = JSON.parse(result.stderr); } catch { refusal = null; }
  }
  return {
    ms: elapsedMs,
    ok: result.status === 0 && json !== null,
    reasonCode: json?.reasonCode ?? refusal?.reasonCode ?? null
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const startedAt = Date.now();
const results = {};
for (const [name, argv] of VERBS) {
  const runs = [];
  for (let r = 0; r < RUNS; r += 1) runs.push(oneRun(argv));
  const times = runs.map((run) => run.ms);
  results[name] = {
    runs: RUNS,
    medianMs: Number(median(times).toFixed(1)),
    minMs: Number(Math.min(...times).toFixed(1)),
    maxMs: Number(Math.max(...times).toFixed(1)),
    allOk: runs.every((run) => run.ok),
    reasonCode: runs[0].reasonCode
  };
}

const summary = {
  schemaVersion: "tcrn.s12-bench.v1",
  workspace,
  label,
  runsPerVerb: RUNS,
  date: startedAt,
  thresholdNote: "S12.3 threshold: a common read verb median >2000ms is the rule's startup-repair trigger",
  verbs: results
};

mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, `bench-${label}.json`);
writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);

const rows = Object.entries(results).map(([name, v]) =>
  `| ${name} | ${v.medianMs} | ${v.minMs} | ${v.maxMs} | ${v.allOk ? "ok" : "FAILED " + (v.reasonCode ?? "")} |`);
const md = `# S12 replay benchmark — ${label} events

Scratch chain: ${workspace}
Read verbs × ${RUNS} runs each; median wall-clock in ms.
A FAILED <reasonCode> verdict means the verb refused (e.g. export's 1 MiB canonical
ceiling) — its timing is the wall-clock of the refusal, not a throughput number.

| verb | median ms | min ms | max ms | verdict |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

Threshold (S12.3 rule): a common read verb median > 2000 ms triggers startup repair.
`;
const mdPath = join(outDir, `bench-${label}.md`);
writeFileSync(mdPath, md);

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
