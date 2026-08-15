#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INC-156: mechanically re-run evidence blocks labelled `verbatim:<command>`.
// The command is intentionally narrow: evidence may invoke a checked-in Node
// script, never an arbitrary shell pipeline.  The captured stdout is compared
// byte-for-byte (including the final newline) with the fenced block.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryRoot, toPosixPath, walkFiles } from "./lib/files.mjs";

const execFileAsync = promisify(execFile);
const EVIDENCE_ROOTS = [
  "docs/reports/init-028-design/evidence/",
  "docs/reports/init-029-component-loop/evidence/",
];
const DESIGN_PROOF = "portal/scripts/design-proof.mjs";
const HOST_ROLE_SCAN = "rg -n 'claude-code|codex|reviewer|role ===|host ===|host \\?' portal/index.html";
const EXPECTED_DESIGN_LEGS = [
  "token-fidelity",
  "brand-asset-fidelity",
  "portal-brand-token",
  "no-literal-colours",
  "no-inline-style-attributes",
  "interactive-tcrn-class-coverage",
  "vocabulary-column-track-coverage",
  "public-v4-baseline",
  "portal-layout-invariants",
  "editor-focus-boundary",
  "topbar-four-width-single-line",
  "sidenav-v4-style-invariants",
  "ds-control-box-ownership",
];

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertArrayEqual(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: ${JSON.stringify(actual)}`);
  }
}

async function designProofLegNames() {
  const result = await execFileAsync(process.execPath, [resolve(repositoryRoot, DESIGN_PROOF)], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, TCRN_DESIGN_SYSTEM_TOKENS: resolve(repositoryRoot, ".inc156-design-system-absent.css") },
    maxBuffer: 8 * 1024 * 1024,
  });
  const legNames = JSON.parse(result.stdout).legs.map((leg) => leg.leg);
  assertArrayEqual(legNames, EXPECTED_DESIGN_LEGS, "DESIGN_PROOF_LEG_NAMES_CHANGED");
  return { proof: DESIGN_PROOF, legCount: legNames.length, legNames };
}

async function hostRoleScan() {
  const source = await readFile(resolve(repositoryRoot, "portal/index.html"), "utf8");
  const matches = source.split("\n")
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter(({ text }) => /claude-code|codex|reviewer|role ===|host ===|host \?/u.test(text))
    .map(({ line, text }) => `${line}:${text}`);
  if (matches.length === 0) throw new Error("HOST_ROLE_SCAN_NO_MATCHES");
  return { scan: HOST_ROLE_SCAN, exitCode: 0, matches };
}

async function i18nCurrentSummary() {
  const result = await execFileAsync(process.execPath, [resolve(repositoryRoot, "portal/scripts/i18n-proof.mjs")], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_offline: "true" },
    maxBuffer: 8 * 1024 * 1024,
  });
  const report = JSON.parse(result.stdout);
  const fields = ["source", "keyCount", "localeCount", "expectedStrings", "addedKeyCount", "baselineEqualCount", "gaps", "problems", "unreachable", "missingLocales", "extraLocales"];
  const legs = report.legs.map((leg) => Object.fromEntries([
    ["leg", leg.leg],
    ["ok", leg.ok],
    ["reasonCode", leg.reasonCode],
    ...fields.filter((field) => Object.hasOwn(leg, field)).map((field) => [field, leg[field]]),
  ]));
  return { sourceCommand: "node portal/scripts/i18n-proof.mjs", ok: report.ok, reasonCode: report.reasonCode, legs };
}

async function runMode(mode) {
  if (mode === "inc140-design-proof") return designProofLegNames();
  if (mode === "inc153-host-role-scan") return hostRoleScan();
  if (mode === "inc149-i18n-current") return i18nCurrentSummary();
  throw new Error(`EVIDENCE_VERBATIM_MODE_UNKNOWN:${mode}`);
}

function parseNodeCommand(command) {
  const tokens = command.trim().split(/\s+/u);
  if (tokens[0] !== "node" || tokens.length < 2 || tokens[1].startsWith("-")) {
    throw new Error(`EVIDENCE_VERBATIM_COMMAND_FORBIDDEN:${command}`);
  }
  return tokens.slice(1);
}

function firstDifference(expected, actual) {
  const limit = Math.min(expected.length, actual.length);
  let offset = 0;
  while (offset < limit && expected[offset] === actual[offset]) offset += 1;
  if (offset === expected.length && offset === actual.length) return null;
  return {
    offset,
    expected: JSON.stringify(expected.slice(Math.max(0, offset - 24), offset + 24)),
    actual: JSON.stringify(actual.slice(Math.max(0, offset - 24), offset + 24)),
  };
}

function parseVerbatimBlocks(source, path) {
  const blocks = [];
  const pattern = /```verbatim:([^\n]+)\n([\s\S]*?)\n```/gu;
  for (const match of source.matchAll(pattern)) {
    const offset = match.index ?? 0;
    blocks.push({
      path,
      line: source.slice(0, offset).split("\n").length,
      command: match[1].trim(),
      expected: `${match[2]}\n`,
    });
  }
  return blocks;
}

async function evidenceBlocks() {
  const overrideFile = process.env.TCRN_VERBATIM_EVIDENCE_FILE;
  if (overrideFile) {
    const path = process.env.TCRN_VERBATIM_EVIDENCE_LABEL ?? toPosixPath(relative(repositoryRoot, resolve(overrideFile)));
    return parseVerbatimBlocks(await readFile(resolve(overrideFile), "utf8"), path);
  }
  const files = (await walkFiles())
    .map((path) => toPosixPath(relative(repositoryRoot, path)))
    .filter((path) => EVIDENCE_ROOTS.some((root) => path.startsWith(root)) && path.endsWith(".md"))
    .sort();
  const blocks = [];
  for (const path of files) blocks.push(...parseVerbatimBlocks(await readFile(resolve(repositoryRoot, path), "utf8"), path));
  return blocks;
}

async function verifyBlocks() {
  const blocks = await evidenceBlocks();
  const results = [];
  for (const block of blocks) {
    let args;
    try {
      args = parseNodeCommand(block.command);
    } catch (error) {
      results.push({ ...block, ok: false, reasonCode: "EVIDENCE_VERBATIM_COMMAND_FORBIDDEN", error: String(error.message ?? error) });
      continue;
    }
    try {
      const result = await execFileAsync(process.execPath, args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, npm_config_offline: "true" },
        maxBuffer: 8 * 1024 * 1024,
      });
      const difference = firstDifference(block.expected, result.stdout);
      results.push({
        path: block.path,
        line: block.line,
        command: block.command,
        ok: difference === null && result.stderr === "",
        ...(difference ? { reasonCode: "EVIDENCE_VERBATIM_MISMATCH", difference } : {}),
        ...(result.stderr ? { reasonCode: "EVIDENCE_VERBATIM_STDERR", stderr: result.stderr } : {}),
      });
    } catch (error) {
      const stdout = String(error.stdout ?? "");
      const stderr = String(error.stderr ?? "");
      results.push({
        path: block.path,
        line: block.line,
        command: block.command,
        ok: false,
        reasonCode: "EVIDENCE_VERBATIM_COMMAND_FAILED",
        exitCode: error.status ?? null,
        difference: firstDifference(block.expected, stdout),
        stderr,
        error: String(error.message ?? error),
      });
    }
  }
  const problems = results.filter((result) => !result.ok);
  return {
    ok: problems.length === 0 && blocks.length > 0,
    reasonCode: problems.length === 0 && blocks.length > 0 ? "EVIDENCE_VERBATIM_VERIFIED" : "EVIDENCE_VERBATIM_MISMATCH",
    blockCount: blocks.length,
    problems,
    results,
  };
}

async function main() {
  if (process.argv[2] === "--check") {
    const result = await verifyBlocks();
    process.stdout.write(json(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const result = await runMode(process.argv[2]);
  process.stdout.write(json(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stdout.write(json({ ok: false, reasonCode: String(error.message ?? error) }));
    process.exitCode = 1;
  }
}
