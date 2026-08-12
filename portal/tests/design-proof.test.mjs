// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const indexPath = new URL("../index.html", import.meta.url);
const proofPath = fileURLToPath(new URL("../scripts/design-proof.mjs", import.meta.url));

async function runProof(path) {
  try {
    const result = await execFileAsync(process.execPath, [proofPath], {
      encoding: "utf8",
      env: { ...process.env, TCRN_PORTAL_INDEX: path },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { status: 0, report: JSON.parse(result.stdout) };
  } catch (error) {
    return { status: error.code, report: JSON.parse(String(error.stdout ?? "{}")) };
  }
}

test("S242 design-proof new legs turn red for injected violations and green after restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tcrn-design-proof-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(indexPath, "utf8");
  const baseline = join(directory, "baseline.html");
  await writeFile(baseline, source, "utf8");

  const green = await runProof(baseline);
  assert.equal(green.status, 0);
  assert.equal(green.report.legs.find((leg) => leg.leg === "no-inline-style-attributes").ok, true);
  assert.equal(green.report.legs.find((leg) => leg.leg === "interactive-tcrn-class-coverage").ok, true);

  const styled = join(directory, "inline-style.html");
  await writeFile(styled, source.replace('<main class="tcrn-main">', '<main class="tcrn-main" style="display:block">'), "utf8");
  const redStyle = await runProof(styled);
  assert.notEqual(redStyle.status, 0);
  assert.equal(redStyle.report.legs.find((leg) => leg.leg === "no-inline-style-attributes").reasonCode, "INLINE_STYLE_ATTRIBUTE_FOUND");

  const unclassed = join(directory, "unclassed-control.html");
  await writeFile(unclassed, source.replace('<button class="tcrn-nav__link"', "<button"), "utf8");
  const redClass = await runProof(unclassed);
  assert.notEqual(redClass.status, 0);
  assert.equal(redClass.report.legs.find((leg) => leg.leg === "interactive-tcrn-class-coverage").reasonCode, "INTERACTIVE_ELEMENT_CLASS_MISSING");

  const restored = await runProof(baseline);
  assert.equal(restored.status, 0);
});
