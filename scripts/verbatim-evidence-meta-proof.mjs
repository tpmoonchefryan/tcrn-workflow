#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INC-156 meta-criterion: a one-number mutation in a verbatim evidence block
// must be named by the checker, then the unmodified evidence must recover green.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const evidencePath = "docs/reports/init-028-design/evidence/INC-140-ci-portal-train.md";
const label = evidencePath;

async function runChecker(file) {
  const env = { ...process.env, npm_config_offline: "true" };
  if (file) {
    env.TCRN_VERBATIM_EVIDENCE_FILE = file;
    env.TCRN_VERBATIM_EVIDENCE_LABEL = label;
  } else {
    delete env.TCRN_VERBATIM_EVIDENCE_FILE;
    delete env.TCRN_VERBATIM_EVIDENCE_LABEL;
  }
  try {
    const result = await execFileAsync(process.execPath, ["scripts/verbatim-evidence-proof.mjs", "--check"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { exitCode: 0, report: JSON.parse(result.stdout) };
  } catch (error) {
    return { exitCode: error.status ?? 1, report: JSON.parse(String(error.stdout ?? "{}")) };
  }
}

const directory = await mkdtemp(join(tmpdir(), "tcrn-inc156-verbatim-"));
try {
  const source = await readFile(evidencePath, "utf8");
  const mutated = source.replace('"legCount": 4', '"legCount": 5');
  if (mutated === source) throw new Error("INC156_NUMBER_MUTATION_ANCHOR_MISSING");
  const mutatedPath = join(directory, "INC-140-mutated.md");
  await writeFile(mutatedPath, mutated, "utf8");
  const red = await runChecker(mutatedPath);
  const restored = await runChecker();
  const result = {
    schemaVersion: "tcrn.inc156-verbatim-meta-proof.v1",
    mutation: {
      changed: "legCount 4 → 5",
      exitCode: red.exitCode,
      reasonCode: red.report.reasonCode,
      problem: red.report.problems?.[0] ?? null,
    },
    restored: {
      exitCode: restored.exitCode,
      reasonCode: restored.report.reasonCode,
      ok: restored.report.ok,
      blockCount: restored.report.blockCount,
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const problem = result.mutation.problem;
  const valid = result.mutation.exitCode !== 0
    && result.mutation.reasonCode === "EVIDENCE_VERBATIM_MISMATCH"
    && problem?.path === evidencePath
    && Number.isSafeInteger(problem?.line)
    && problem?.difference?.offset > 0
    && result.restored.exitCode === 0
    && result.restored.ok === true
    && result.restored.blockCount >= 4;
  if (!valid) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
