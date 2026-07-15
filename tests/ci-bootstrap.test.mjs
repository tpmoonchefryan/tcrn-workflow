// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

async function readWorkflow() {
  return readFile(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
}

test("CI acquires pinned pnpm online only after pinned Node and verifies it before dependencies", async () => {
  const workflow = await readWorkflow();
  const node = workflow.indexOf("uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
  const bootstrap = workflow.indexOf("- name: Acquire exact pnpm under explicit online bootstrap policy");
  const version = workflow.indexOf("- name: Verify acquired pnpm version");
  const dependencies = workflow.indexOf("- name: Acquire exact dependencies explicitly");
  assert.ok(node >= 0 && bootstrap > node && version > bootstrap && dependencies > version);
  assert.equal(workflow.includes("pnpm/action-setup"), false);
  assert.match(workflow, /npm_config_offline: "false"/u);
  assert.match(workflow, /npm_config_prefer_offline: "false"/u);
  assert.match(workflow, /npm install --global pnpm@11\.3\.0 --ignore-scripts --no-audit --no-fund --no-update-notifier --prefer-online/u);
  assert.match(workflow, /test "\$\(pnpm --version\)" = "11\.3\.0"/u);
});

test("CI retains explicit safe dependency acquisition and offline P1 execution", async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts --config\.offline=false/u);
  assert.match(workflow, /- name: Verify P1 offline\n        run: pnpm verify:p1/u);
});
