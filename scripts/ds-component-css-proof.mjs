#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INIT-029/S252: command-boundary red/restore proof for the snapshot contract.
// The proof derives a temporary source fixture from the checked-in snapshot so
// it remains runnable in CI clones that intentionally lack the DS checkout.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REPOSITORY_ROOT, SNAPSHOT_PATH, INDEX_PATH } from "./ds-component-css-reconcile.mjs";

const execFileAsync = promisify(execFile);
const reconcileScript = join(REPOSITORY_ROOT, "scripts/ds-component-css-reconcile.mjs");
const SOURCE_SUFFIX = "/packages/ui-react/src/components/Navigation/Navigation.tsx";
const SOURCE_MUTATION = "--tcrn-color-brand-secondary-readable: #246f80;";
const SNAPSHOT_MUTATION = "--tcrn-color-brand-secondary-readable: #246f81;";

async function run({ sourceRoot, snapshotPath, indexPath }) {
  try {
    const result = await execFileAsync(process.execPath, [reconcileScript], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        TCRN_DESIGN_SYSTEM_ROOT: sourceRoot,
        TCRN_DS_COMPONENT_CSS_SNAPSHOT: snapshotPath,
        TCRN_DS_COMPONENT_CSS_INDEX: indexPath,
      },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { exitCode: 0, report: JSON.parse(result.stdout) };
  } catch (error) {
    return { exitCode: error.status ?? 1, report: JSON.parse(String(error.stdout ?? "{}")) };
  }
}

function sourceFixture(css) {
  return `export const tcrnComponentCss = \`${css}\`;\n`;
}

const directory = await mkdtemp(join(tmpdir(), "tcrn-inc252-ds-css-"));
try {
  const snapshot = await readFile(SNAPSHOT_PATH, "utf8");
  const index = await readFile(INDEX_PATH, "utf8");
  const sourceRoot = join(directory, "source");
  const sourcePath = join(sourceRoot, SOURCE_SUFFIX);
  const sourceDir = dirname(sourcePath);
  await (await import("node:fs/promises")).mkdir(sourceDir, { recursive: true });
  await writeFile(sourcePath, sourceFixture(snapshot), "utf8");

  const baselineSnapshot = join(directory, "snapshot.css");
  const baselineIndex = join(directory, "index.html");
  await writeFile(baselineSnapshot, snapshot, "utf8");
  await writeFile(baselineIndex, index, "utf8");
  const green = await run({ sourceRoot, snapshotPath: baselineSnapshot, indexPath: baselineIndex });

  const sourceMutated = join(directory, "source-mutated");
  const sourceMutatedPath = join(sourceMutated, SOURCE_SUFFIX);
  await (await import("node:fs/promises")).mkdir(dirname(sourceMutatedPath), { recursive: true });
  const mutatedSource = sourceFixture(snapshot.replace(SOURCE_MUTATION, SOURCE_MUTATION.replace("#246f80", "#246f81")));
  await writeFile(sourceMutatedPath, mutatedSource, "utf8");
  const sourceRed = await run({ sourceRoot: sourceMutated, snapshotPath: baselineSnapshot, indexPath: baselineIndex });

  const snapshotMutated = join(directory, "snapshot-mutated.css");
  await writeFile(snapshotMutated, snapshot.replace(SOURCE_MUTATION, SNAPSHOT_MUTATION), "utf8");
  const snapshotRed = await run({ sourceRoot, snapshotPath: snapshotMutated, indexPath: baselineIndex });

  const absent = await run({ sourceRoot: join(directory, "absent-source"), snapshotPath: baselineSnapshot, indexPath: baselineIndex });
  const restored = await run({ sourceRoot, snapshotPath: baselineSnapshot, indexPath: baselineIndex });

  const result = {
    schemaVersion: "tcrn.inc252-ds-component-css-meta-proof.v1",
    cases: [
      { name: "baseline source and inline snapshot", exitCode: green.exitCode, reasonCode: green.report.reasonCode, sourceStatus: green.report.reconciliation?.sourceStatus, countedAsGreen: green.report.reconciliation?.countedAsGreen },
      { name: "mutated DS source byte", exitCode: sourceRed.exitCode, reasonCode: sourceRed.report.reasonCode, sourceMatchesSnapshot: sourceRed.report.reconciliation?.sourceMatchesSnapshot, countedAsGreen: sourceRed.report.reconciliation?.countedAsGreen },
      { name: "mutated snapshot byte", exitCode: snapshotRed.exitCode, reasonCode: snapshotRed.report.reasonCode, sourceMatchesSnapshot: snapshotRed.report.reconciliation?.sourceMatchesSnapshot, inlineMatchesSnapshot: snapshotRed.report.inline?.matchesSnapshot },
      { name: "DS source absent in CI", exitCode: absent.exitCode, reasonCode: absent.report.reasonCode, sourceStatus: absent.report.reconciliation?.sourceStatus, countedAsGreen: absent.report.reconciliation?.countedAsGreen },
      { name: "restore all mutations", exitCode: restored.exitCode, reasonCode: restored.report.reasonCode, sourceStatus: restored.report.reconciliation?.sourceStatus, countedAsGreen: restored.report.reconciliation?.countedAsGreen },
    ],
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const [baseline, source, snapshotCase, missing, restore] = result.cases;
  const valid = baseline.exitCode === 0
    && baseline.reasonCode === "DS_COMPONENT_CSS_RECONCILED"
    && baseline.countedAsGreen === true
    && source.exitCode !== 0
    && source.reasonCode === "DS_COMPONENT_CSS_SOURCE_DRIFT"
    && source.sourceMatchesSnapshot === false
    && snapshotCase.exitCode !== 0
    && ["DS_COMPONENT_CSS_INLINE_DRIFT", "DS_COMPONENT_CSS_SOURCE_DRIFT"].includes(snapshotCase.reasonCode)
    && missing.exitCode === 0
    && missing.reasonCode === "DS_COMPONENT_CSS_SNAPSHOT_SELF_SUFFICIENT"
    && missing.sourceStatus === "unverified"
    && missing.countedAsGreen === false
    && restore.exitCode === 0
    && restore.reasonCode === "DS_COMPONENT_CSS_RECONCILED"
    && restore.countedAsGreen === true;
  if (!valid) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
