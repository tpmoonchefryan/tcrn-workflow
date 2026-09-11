// SPDX-License-Identifier: Apache-2.0
// STORY-371: host-render is a host-owned projection of governed dispatch settings.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyHostRender,
  inspectHostRenderDrift,
  renderHostPlan,
} from "../scripts/host-render.mjs";
import { codexHookDocument } from "../scripts/host-harness.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const newline = "\n";
const tiers = (host, flagship, main, economy) => JSON.stringify({ [host]: {
  flagship: { model: flagship, effort: "max" },
  main: { model: main, effort: "high" },
  economy: { model: economy, effort: "low" },
} });
const settings = (host, mode = "frontier") => [
  { key: "execution.dispatchMode", value: mode },
  { key: "execution.dispatchTiers", value: tiers(host, `${host}-flagship`, `${host}-main`, `${host}-economy`) },
];

async function existingFor(plan, root) {
  const values = new Map();
  for (const entry of plan.files) values.set(entry.path, await readFile(join(root, entry.path), "utf8").catch(() => null));
  return values;
}

async function scratch(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

test("STORY-371: Claude rendering preserves user fields, writes tier fields, and proves idempotent drift", async (t) => {
  const root = await scratch("tcrn-host-render-claude-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".claude", "agents"), { recursive: true });
  await writeFile(join(root, ".claude", "settings.json"), `${JSON.stringify({ custom: "keep", env: { USER_SETTING: "yes" }, hooks: { Other: [{ hooks: [{ type: "command", command: "user-hook" }] }] }, permissions: { allow: ["Read(/**)"] } }, null, 2)}${newline}`);
  await writeFile(join(root, "CLAUDE.md"), ` @AGENTS.md ${newline}${newline}`);
  await writeFile(join(root, ".claude", "agents", "implement.md"), `---${newline}description: user-owned${newline}model: old-model${newline}effort: old-effort${newline}---${newline}User body stays here.${newline}`);
  const first = renderHostPlan({ host: "claude-code", mode: "frontier", settings: settings("claude-code"), root, repoRoot, existing: new Map() });
  const plan = renderHostPlan({ host: "claude-code", mode: "frontier", settings: settings("claude-code"), root, repoRoot, existing: await existingFor(first, root) });
  assert.equal(plan.resolutions.implement.model, "claude-code-main");
  assert.equal(plan.resolutions.implement.effort, "high");
  assert.ok(plan.drift.length > 0);
  const receipt = await applyHostRender(plan, { backupDir: join(root, "backups") });
  assert.equal(receipt.reasonCode, "HOST_RENDER_COMMITTED");
  assert.equal(receipt.files.length, 10);
  const renderedSettings = JSON.parse(await readFile(join(root, ".claude", "settings.json"), "utf8"));
  assert.equal(renderedSettings.model, "claude-code-flagship");
  assert.equal(renderedSettings.env.USER_SETTING, "yes");
  assert.equal(renderedSettings.env.CLAUDE_CODE_EFFORT_LEVEL, "max");
  assert.equal(renderedSettings.custom, "keep");
  assert.equal(renderedSettings.hooks.Other[0].hooks[0].command, "user-hook");
  assert.equal(renderedSettings.hooks.Stop.length, 3);
  const agent = await readFile(join(root, ".claude", "agents", "implement.md"), "utf8");
  assert.match(agent, /description: user-owned/u);
  assert.match(agent, /model: claude-code-main/u);
  assert.match(agent, /effort: high/u);
  assert.match(agent, /User body stays here\./u);
  const green = await inspectHostRenderDrift({ host: "claude-code", settings: settings("claude-code"), root, repoRoot });
  assert.equal(green.ok, true);
  assert.equal(green.drift.length, 0);

  await writeFile(join(root, ".claude", "agents", "implement.md"), agent.replace("model: claude-code-main", "model: forged-model"));
  const red = await inspectHostRenderDrift({ host: "claude-code", settings: settings("claude-code"), root, repoRoot });
  assert.equal(red.ok, false);
  assert.ok(red.drift.some((entry) => entry.path.endsWith("implement.md")));
});

test("STORY-371: Codex rendering changes only root model keys and generated hooks", async (t) => {
  const root = await scratch("tcrn-host-render-codex-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".codex"), { recursive: true });
  await writeFile(join(root, ".codex", "config.toml"), `model = "old-model"${newline}model_reasoning_effort = "low"${newline}custom = "keep"${newline}${newline}[projects."x"]${newline}model = "nested-model"${newline}`);
  await writeFile(join(root, ".codex", "hooks.json"), `${JSON.stringify({ custom: true, hooks: { User: [{ hooks: [{ type: "command", command: "user-hook" }] }] } }, null, 2)}${newline}`);
  const config = settings("codex", "eco");
  const first = renderHostPlan({ host: "codex", settings: config, root, repoRoot, existing: new Map() });
  const plan = renderHostPlan({ host: "codex", settings: config, root, repoRoot, existing: await existingFor(first, root) });
  assert.equal(plan.resolutions.plan.model, "codex-main");
  const receipt = await applyHostRender(plan, { backupDir: join(root, "backups") });
  assert.equal(receipt.reasonCode, "HOST_RENDER_COMMITTED");
  const toml = await readFile(join(root, ".codex", "config.toml"), "utf8");
  assert.match(toml, /^model = "codex-main"$/mu);
  assert.match(toml, /^model_reasoning_effort = "high"$/mu);
  assert.match(toml, /^custom = "keep"$/mu);
  assert.match(toml, /model = "nested-model"/u);
  const hooks = JSON.parse(await readFile(join(root, ".codex", "hooks.json"), "utf8"));
  assert.equal(hooks.custom, true);
  assert.equal(hooks.hooks.User[0].hooks[0].command, "user-hook");
  assert.deepEqual(hooks.hooks.PreToolUse, codexHookDocument(repoRoot).hooks.PreToolUse);
  assert.deepEqual(hooks.hooks.SessionStart, codexHookDocument(repoRoot).hooks.SessionStart);
  assert.deepEqual(hooks.hooks.Stop, codexHookDocument(repoRoot).hooks.Stop);
  assert.deepEqual(hooks.hooks.SubagentStart, codexHookDocument(repoRoot).hooks.SubagentStart);
  assert.deepEqual(hooks.hooks.SubagentStop, codexHookDocument(repoRoot).hooks.SubagentStop);
  const green = await inspectHostRenderDrift({ host: "codex", settings: config, root, repoRoot });
  assert.equal(green.ok, true);
  assert.equal(green.drift.length, 0);
});

test("STORY-391: a mixed managed hook group keeps user entries and group attributes", async (t) => {
  const root = await scratch("tcrn-host-render-mixed-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = codexHookDocument("/old/TCRN Platform/tcrn-workflow").hooks.SessionStart[0];
  old.matcher = "user-session-start";
  old.timeout = 30;
  old.hooks.push({ type: "command", command: "echo user-owned-hook" });
  const existing = new Map([[".codex/hooks.json", JSON.stringify({ hooks: { SessionStart: [old] } })]]);
  const plan = renderHostPlan({ host: "codex", settings: settings("codex"), root, repoRoot, existing });
  const document = JSON.parse(plan.files.find((entry) => entry.path === ".codex/hooks.json").content);
  const userGroup = document.hooks.SessionStart.find((group) => group.matcher === "user-session-start");
  assert.deepEqual(userGroup, { matcher: "user-session-start", timeout: 30, hooks: [{ type: "command", command: "echo user-owned-hook" }] });
  const managedCommands = document.hooks.SessionStart.flatMap((group) => group.hooks ?? [])
    .filter((hook) => hook.command.includes("scripts/knowledge-inject-hook.mjs"));
  assert.equal(managedCommands.length, 1);
  assert.equal(plan.drift.some((entry) => entry.path === ".codex/hooks.json"), true);
});

test("STORY-371: an empty main tier is an explicit no-write plan", async (t) => {
  const root = await scratch("tcrn-host-render-empty-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = renderHostPlan({ host: "claude-code", settings: [{ key: "execution.dispatchMode", value: "frontier" }, { key: "execution.dispatchTiers", value: "{}" }], root, repoRoot, existing: new Map() });
  assert.equal(plan.comparable, false);
  assert.equal(plan.reasonCode, "HOST_RENDER_MODEL_UNSET");
  assert.deepEqual(plan.files, []);
  assert.equal((await applyHostRender(plan)).reasonCode, "HOST_RENDER_ALREADY_CURRENT");
});

test("STORY-371: a target change between planning and writing is refused before any host write", async (t) => {
  const root = await scratch("tcrn-host-render-cas-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = settings("claude-code");
  const plan = renderHostPlan({ host: "claude-code", settings: config, root, repoRoot, existing: new Map() });
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(join(root, ".claude", "settings.json"), "user changed\n");
  await assert.rejects(applyHostRender(plan), (error) => error?.reasonCode === "HOST_RENDER_CONCURRENT_MODIFICATION");
  assert.equal(await readFile(join(root, ".claude", "settings.json"), "utf8"), "user changed\n");
});
