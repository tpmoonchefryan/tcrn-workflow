#!/usr/bin/env node
// S15 — hot-path context byte baseline (TCRN-CROSS-STORY-143).
//
// Measures the byte size of the files that sit in every governed session's context
// window: the platform root CLAUDE.md, each repo CLAUDE.md, the auto-memory index
// (MEMORY.md), and the platform .mcp.json. BYTES ONLY — the table header says so
// explicitly and never pretends these are tokens: byte counts are cheap, stable and
// machine-free, while token counts depend on model, tokenizer and content.
//
// Where a repo genuinely has no file (tcrn-workflow-helper has no CLAUDE.md, and the
// repos carry no per-repo .mcp.json — the platform .mcp.json at the root is the only
// one), the table says "absent" rather than reporting 0 bytes.
//
// Usage:
//   node scripts/bench/measure-context-bytes.mjs [--out-dir <path>]
//
// Re-measurement cadence (see docs/reports/init-018/S15/remeasure-policy.md):
// after any 公约大改 (a platform-wide convention rewrite) or model-generation change.
import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLATFORM_ROOT = resolve(REPO_ROOT, "..");
const REPOS = ["TCRN-TMS", "TCRN-Design-System", "TCRN-AOS", "tcrn-workflow", "tcrn-workflow-helper"];

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const outDir = resolve(argument("out-dir") ?? join(REPO_ROOT, "docs/reports/init-018/S15"));

// The auto-memory index path follows the Claude Code project-slug convention: the
// project path with the leading slash AND "/" and spaces rewritten to "-"
// (e.g. a local checkout path -> the corresponding project slug).
const memoryIndex = join(homedir(), ".claude/projects", PLATFORM_ROOT.replace(/^\//u, "-").replace(/[\/\s]/gu, "-"), "memory", "MEMORY.md");

function bytes(path) {
  if (!existsSync(path)) return null;
  return statSync(path).size;
}

const entries = [];
const add = (scope, path) => entries.push({ scope, path, bytes: bytes(path) });

add("platform root CLAUDE.md", join(PLATFORM_ROOT, "CLAUDE.md"));
for (const repo of REPOS) add(`repo CLAUDE.md (${repo})`, join(PLATFORM_ROOT, repo, "CLAUDE.md"));
add("auto-memory index (MEMORY.md)", memoryIndex);
add("platform .mcp.json", join(PLATFORM_ROOT, ".mcp.json"));

const table = entries.map((entry) => ({
  scope: entry.scope,
  bytes: entry.bytes === null ? "absent" : entry.bytes
}));

const baseline = {
  schemaVersion: "tcrn.s15-context-bytes.v1",
  note: "BYTES ONLY — byte counts, not tokens. Token counts depend on model and tokenizer; re-measure after convention rewrites or model-generation changes.",
  measuredAt: new Date().toISOString(),
  totalBytes: entries.filter((entry) => entry.bytes !== null).reduce((sum, entry) => sum + entry.bytes, 0),
  entries: table
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "context-bytes.json"), `${JSON.stringify(baseline, null, 2)}\n`);

const rows = table.map((entry) => `| ${entry.scope} | ${entry.bytes} |`);
const md = `# S15 — hot-path context byte baseline

> **单位是字节（bytes），不是 token。** token 数依赖模型与分词器，字节数是廉价、稳定、与机型无关的基线。
> 复测口径见 [remeasure-policy.md](remeasure-policy.md)。

Measured: \`${baseline.measuredAt}\`

| scope | bytes |
| --- | --- |
${rows.join("\n")}

**合计（在场文件）**：${baseline.totalBytes} bytes
`;
writeFileSync(join(outDir, "context-bytes.md"), md);

process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);
