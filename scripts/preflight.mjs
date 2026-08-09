#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-INIT-021 INC-123/125 — reproduce the public CI world before push.
// This runner is intentionally independent of `verify:p1`: P1 is fail-fast, while
// preflight must collect every red leg in one isolated run so the first failure cannot
// hide a second-world mismatch.

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ALLOWED_ENV_NAMES = Object.freeze([
  "CI",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PNPM_HOME",
  "TMPDIR",
]);

export const P1_GATE_SPECS = Object.freeze([
  ["format", ["pnpm", "run", "--silent", "format:check"]],
  ["lint", ["pnpm", "run", "--silent", "lint"]],
  ["typecheck", ["pnpm", "run", "--silent", "typecheck"]],
  ["build", ["pnpm", "run", "--silent", "build"]],
  ["test", ["pnpm", "run", "--silent", "test"]],
  ["test-trust", ["pnpm", "run", "--silent", "verify:trust"]],
  ["archive", ["pnpm", "run", "--silent", "archive"]],
  ["sbom", ["pnpm", "run", "--silent", "sbom"]],
  ["licenses", ["pnpm", "run", "--silent", "verify:licenses"]],
  ["vulnerabilities", ["pnpm", "run", "--silent", "verify:vulnerabilities"]],
  ["source", ["pnpm", "run", "--silent", "verify:source"]],
  ["lifecycle", ["pnpm", "run", "--silent", "verify:lifecycle"]],
  ["offline", ["pnpm", "run", "--silent", "verify:offline"]],
  ["governance", ["pnpm", "run", "--silent", "verify:governance"]],
  ["workspace", ["pnpm", "run", "--silent", "verify:workspace"]],
  ["privacy", ["pnpm", "run", "--silent", "verify:privacy"]],
  ["roots", ["pnpm", "run", "--silent", "verify:roots"]],
  ["ci", ["pnpm", "run", "--silent", "verify:ci"]],
  ["verification-map", ["pnpm", "run", "--silent", "verify:map"]],
  ["history", ["pnpm", "run", "--silent", "verify:history"]],
]);

export const LESSON_GATE_SPECS = Object.freeze([
  ["lessons", ["node", "scripts/verify-s6.mjs"]],
  ["observer", ["node", "scripts/ssh-write-observer.mjs", "--verify-channel", "--project-dir", "."]],
]);

const PnpmRun = (script) => ["pnpm", "run", "--silent", script];

const UNSAFE_PROBE_FORMS = Object.freeze([
  ["ZSH_COMMAND", /(?:^|[\s/])zsh(?:$|[\s])/iu],
  ["SHELL_CONJUNCTION", /[;&|]{1,2}/u],
  ["PIPESTATUS", /PIPESTATUS/u],
  ["PIPE_TAIL", /(?:^|[\s|])tail(?:$|[\s])/iu],
  ["PIPE_HEAD", /(?:^|[\s|])head(?:$|[\s])/iu],
  ["GREP_VERDICT", /(?:^|[\s/])grep(?:$|[\s])/iu],
  ["REF_PATH_SYNTAX", /ref:path/u],
]);

export function scrubPublicEnvironment(environment = process.env) {
  const scrubbed = {};
  for (const name of ALLOWED_ENV_NAMES) {
    if (typeof environment[name] === "string") scrubbed[name] = environment[name];
  }
  scrubbed.CI = "true";
  scrubbed.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  return scrubbed;
}

export function probeDisciplineProblems(command) {
  const text = Array.isArray(command) ? command.join(" ") : String(command);
  return UNSAFE_PROBE_FORMS
    .filter(([, pattern]) => pattern.test(text))
    .map(([reasonCode]) => reasonCode);
}

export function assertSafeProbeCommand(command) {
  const problems = probeDisciplineProblems(command);
  if (problems.length > 0) {
    throw new Error(`PREFLIGHT_PROBE_DISCIPLINE:${problems.join(",")}`);
  }
}

export function requiredFailurePatternProblems(register) {
  const problems = [];
  const pattern = (Array.isArray(register?.patterns) ? register.patterns : [])
    .find((entry) => entry?.id === "evaluated-world-drift");
  if (!pattern) {
    return ["evaluated-world-drift:missing"];
  }
  if (pattern.disposition !== "gated") problems.push("evaluated-world-drift:disposition");
  if (pattern.gate !== "pnpm preflight") problems.push("evaluated-world-drift:gate");
  if (!Number.isInteger(pattern.occurrenceCount) || pattern.occurrenceCount < 2) {
    problems.push("evaluated-world-drift:occurrence-count");
  }
  if (!Array.isArray(pattern.occurrences) || pattern.occurrences.length < 2) {
    problems.push("evaluated-world-drift:occurrences");
  }
  return problems;
}

function commandText(command) {
  return command.join(" ");
}

function extractReasonCode(stdout, stderr, exitCode) {
  const lines = `${stdout}\n${stderr}`.split("\n").reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (typeof value?.reasonCode === "string") return value.reasonCode;
    } catch {
      // Human/test output is expected for some gates; keep scanning for a terminal JSON receipt.
    }
  }
  return exitCode === 0 ? "COMMAND_EXITED_ZERO" : "COMMAND_EXITED_NONZERO";
}

export function summarizeGateResult(key, command, execution) {
  const stdout = String(execution.stdout ?? "");
  const stderr = String(execution.stderr ?? "");
  const exitCode = execution.status ?? 1;
  return {
    key,
    command: commandText(command),
    ok: exitCode === 0,
    exitCode,
    reasonCode: extractReasonCode(stdout, stderr, exitCode),
    stdoutTail: stdout.slice(-2000),
    stderrTail: stderr.slice(-2000),
  };
}

export function collectGateResults(specs, runner) {
  const results = [];
  for (const [key, command] of specs) {
    assertSafeProbeCommand(command);
    results.push(summarizeGateResult(key, command, runner(command)));
  }
  return results;
}

function run(command, cwd, environment) {
  const [executable, ...arguments_] = command;
  const result = spawnSync(executable, arguments_, {
    cwd,
    env: environment,
    encoding: "utf8",
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(command, cwd, environment) {
  return run(["git", ...command], cwd, environment);
}

function successResult(key, command, stdout = "") {
  return summarizeGateResult(key, command, { status: 0, stdout, stderr: "" });
}

async function runPreflight({ runPg = false } = {}) {
  const publicEnvironment = scrubPublicEnvironment();
  const sourceStatus = git(["status", "--porcelain=v1", "--untracked-files=all"], ROOT, publicEnvironment);
  if (sourceStatus.status !== 0 || sourceStatus.stdout.trim() !== "") {
    return {
      ok: false,
      reasonCode: "PREFLIGHT_SOURCE_BASIS_DIRTY",
      isolation: { clone: "not-created", environment: "env-i allowlist", siblingCheckout: "unavailable" },
      gates: [summarizeGateResult("source-basis", ["git", "status", "--porcelain=v1", "--untracked-files=all"], sourceStatus)],
    };
  }

  const sourceOriginResult = git(["remote", "get-url", "origin"], ROOT, publicEnvironment);
  const sourceOrigin = sourceOriginResult.stdout.trim();
  if (sourceOriginResult.status !== 0 || sourceOrigin.length === 0) {
    return {
      ok: false,
      reasonCode: "PREFLIGHT_SOURCE_ORIGIN_UNREADABLE",
      isolation: { clone: "not-created", environment: "env-i allowlist", siblingCheckout: "unavailable" },
      gates: [summarizeGateResult("source-origin", ["git", "remote", "get-url", "origin"], sourceOriginResult)],
    };
  }

  const commitResult = git(["rev-parse", "HEAD"], ROOT, publicEnvironment);
  const commit = commitResult.stdout.trim();
  if (commitResult.status !== 0 || !/^[a-f0-9]{40}$/u.test(commit)) {
    return {
      ok: false,
      reasonCode: "PREFLIGHT_SOURCE_HEAD_UNREADABLE",
      isolation: { clone: "not-created", environment: "env-i allowlist", siblingCheckout: "unavailable" },
      gates: [summarizeGateResult("source-head", ["git", "rev-parse", "HEAD"], commitResult)],
    };
  }

  const temporary = await mkdtemp(join(await realpath(tmpdir()), "tcrn-preflight-"));
  const checkout = resolve(temporary, "checkout");
  const gates = [];
  try {
    const clone = git(["clone", "--quiet", "--no-local", "--no-hardlinks", ROOT, checkout], ROOT, publicEnvironment);
    gates.push(summarizeGateResult("clone-no-local", ["git", "clone", "--quiet", "--no-local", "--no-hardlinks", "<source>", "<checkout>"], clone));
    if (clone.status !== 0) {
      return {
        ok: false,
        reasonCode: "PREFLIGHT_CLONE_FAILED",
        commit,
        isolation: { clone: "--no-local", environment: "env-i allowlist", siblingCheckout: "unavailable" },
        gates,
      };
    }
    const checkoutHead = git(["rev-parse", "HEAD"], checkout, publicEnvironment);
    gates.push(summarizeGateResult("checkout-head", ["git", "rev-parse", "HEAD"], checkoutHead));
    if (checkoutHead.status !== 0 || checkoutHead.stdout.trim() !== commit) {
      gates.push({ key: "checkout-basis", command: "git rev-parse HEAD == source HEAD", ok: false, exitCode: 1, reasonCode: "PREFLIGHT_BASIS_MISMATCH" });
      return {
        ok: false,
        reasonCode: "PREFLIGHT_BASIS_MISMATCH",
        commit,
        isolation: { clone: "--no-local", environment: "env-i allowlist", siblingCheckout: "unavailable" },
        gates,
      };
    }

    const checkoutOrigin = git(["remote", "set-url", "origin", sourceOrigin], checkout, publicEnvironment);
    gates.push(summarizeGateResult("checkout-origin", ["git", "remote", "set-url", "origin", "<public-origin>"], checkoutOrigin));
    if (checkoutOrigin.status !== 0) {
      return {
        ok: false,
        reasonCode: "PREFLIGHT_CHECKOUT_ORIGIN_FAILED",
        commit,
        isolation: { clone: "--no-local", environment: "env-i allowlist", siblingCheckout: "unavailable" },
        gates,
      };
    }

    const install = run(["pnpm", "install", "--offline", "--frozen-lockfile", "--ignore-scripts"], checkout, publicEnvironment);
    gates.push(summarizeGateResult("dependency-install", ["pnpm", "install", "--offline", "--frozen-lockfile", "--ignore-scripts"], install));

    const gateSpecs = [...P1_GATE_SPECS, ...LESSON_GATE_SPECS];
    gates.push(...collectGateResults(gateSpecs, (command) => run(command, checkout, publicEnvironment)));
    if (runPg) {
      gates.push(...collectGateResults([["verify-pg", PnpmRun("pg:test")]], (command) => run(command, checkout, publicEnvironment)));
    } else {
      gates.push(successResult("verify-pg", PnpmRun("pg:test"), "PREFLIGHT_PG_OPTIONAL_SKIPPED"));
      gates.at(-1).ok = true;
      gates.at(-1).reasonCode = "PREFLIGHT_PG_OPTIONAL_SKIPPED";
    }
    const checkoutStatus = git(["status", "--porcelain=v1", "--untracked-files=all"], checkout, publicEnvironment);
    gates.push(summarizeGateResult("checkout-clean", ["git", "status", "--porcelain=v1", "--untracked-files=all"], checkoutStatus));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  const failed = gates.filter((gate) => gate.ok !== true);
  return {
    ok: failed.length === 0,
    reasonCode: failed.length === 0 ? "PREFLIGHT_ALL_GREEN" : "PREFLIGHT_FINDINGS",
    commit,
    isolation: {
      clone: "git clone --no-local --no-hardlinks",
      environment: "env-i allowlist; TCRN_* and sibling checkout unavailable",
      siblingCheckout: "unavailable",
      pg: runPg ? "requested" : "optional-skipped",
    },
    gates,
    red: failed.map((gate) => ({ key: gate.key, reasonCode: gate.reasonCode })),
  };
}

export { runPreflight };

if (process.argv[1]?.endsWith("preflight.mjs")) {
  runPreflight({ runPg: process.argv.includes("--run-pg") }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  }).catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: "PREFLIGHT_INTERNAL_ERROR", error: error.message })}\n`);
    process.exitCode = 1;
  });
}
