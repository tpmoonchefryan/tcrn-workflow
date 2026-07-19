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
  const node = workflow.indexOf("uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
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

// The literal SHA above locates the step and pins the reviewed version. It does not, on
// its own, say that pinning is the rule -- swap every `uses:` to a moving tag and the
// ordering assertions still hold, because a tag has an index too. That is the property
// worth stating separately: an action referenced by tag is repointable by whoever controls
// the tag, which is the supply-chain hole SHA pinning exists to close. Stated over every
// step so a step added later cannot quietly arrive unpinned.
test("every CI action is pinned to a commit SHA, never to a movable tag", async () => {
  const workflow = await readWorkflow();
  const uses = [...workflow.matchAll(/uses:\s*(\S+)/gu)].map((match) => match[1]);
  assert.ok(uses.length > 0, "the workflow must reference at least one action");
  for (const reference of uses) {
    const [name, ref] = reference.split("@");
    assert.ok(ref !== undefined, `${name} must carry an explicit ref`);
    assert.match(ref, /^[0-9a-f]{40}$/u, `${name} must be pinned to a 40-character commit SHA, got ${ref}`);
  }
});
