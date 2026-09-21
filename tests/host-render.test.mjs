// SPDX-License-Identifier: Apache-2.0
// STORY-371: host-render is a host-owned projection of governed dispatch settings.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { claudeHookSettings, codexHookDocument } from "../scripts/host-harness.mjs";

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
const emptyDispatchSettings = [
  { key: "execution.dispatchMode", value: "frontier" },
  { key: "execution.dispatchTiers", value: "{}" },
];

async function existingFor(plan, root) {
  const values = new Map();
  for (const entry of plan.files) values.set(entry.path, await readFile(join(root, entry.path), "utf8").catch(() => null));
  return values;
}

async function scratch(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

function generatedHooks(host, containerRoot) {
  return host === "codex" ? codexHookDocument(repoRoot, containerRoot).hooks : claudeHookSettings();
}

function hookFilePath(host) {
  return host === "codex" ? ".codex/hooks.json" : ".claude/settings.json";
}

function withoutHostSuffix(group, host) {
  const copy = structuredClone(group);
  const suffix = ` --host ${host === "codex" ? "codex" : "claude"}`;
  for (const hook of copy.hooks ?? []) {
    if (typeof hook?.command === "string" && hook.command.endsWith(suffix)) hook.command = hook.command.slice(0, -suffix.length);
    else if (typeof hook?.command === "string" && hook.command.endsWith(`${suffix}; fi`)) hook.command = `${hook.command.slice(0, -`${suffix}; fi`.length)}; fi`;
  }
  return copy;
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
  assert.equal(plan.resolutions.implement.model, "claude-code-economy");
  assert.equal(plan.resolutions.implement.effort, "low");
  assert.ok(plan.drift.length > 0);
  const receipt = await applyHostRender(plan, { backupDir: join(root, "backups") });
  assert.equal(receipt.reasonCode, "HOST_RENDER_COMMITTED");
  assert.equal(receipt.files.length, 12);
  const renderedSettings = JSON.parse(await readFile(join(root, ".claude", "settings.json"), "utf8"));
  assert.equal(renderedSettings.model, "claude-code-flagship");
  assert.equal(renderedSettings.env.USER_SETTING, "yes");
  assert.equal(renderedSettings.env.CLAUDE_CODE_EFFORT_LEVEL, "max");
  assert.equal(renderedSettings.custom, "keep");
  assert.equal(renderedSettings.hooks.Other[0].hooks[0].command, "user-hook");
  assert.equal(renderedSettings.hooks.Stop.length, 3);
  assert.deepEqual(renderedSettings.hooks.PostToolUse, [{ hooks: [{ type: "command", command: `if [ -f "\${CLAUDE_PROJECT_DIR}/TCRN Platform/tcrn-workflow/scripts/knowledge-inject-hook.mjs" ]; then node "\${CLAUDE_PROJECT_DIR}/TCRN Platform/tcrn-workflow/scripts/knowledge-inject-hook.mjs" --container-root "\${CLAUDE_PROJECT_DIR}" --host claude; fi`, timeout: 30 }] }]);
  const agent = await readFile(join(root, ".claude", "agents", "implement.md"), "utf8");
  assert.match(agent, /description: user-owned/u);
  assert.match(agent, /model: claude-code-economy/u);
  assert.match(agent, /effort: low/u);
  assert.match(agent, /User body stays here\./u);
  const green = await inspectHostRenderDrift({ host: "claude-code", settings: settings("claude-code"), root, repoRoot });
  assert.equal(green.ok, true);
  assert.equal(green.drift.length, 0);

  await writeFile(join(root, ".claude", "agents", "implement.md"), agent.replace("model: claude-code-economy", "model: forged-model"));
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
  const first = renderHostPlan({ host: "codex", scope: "full", settings: config, root, repoRoot, existing: new Map() });
  const plan = renderHostPlan({ host: "codex", scope: "full", settings: config, root, repoRoot, existing: await existingFor(first, root) });
  assert.equal(plan.scope, "full");
  assert.equal(plan.hooksComparable, false);
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
  assert.deepEqual(hooks.hooks.PreToolUse, codexHookDocument(repoRoot, root).hooks.PreToolUse);
  assert.deepEqual(hooks.hooks.SessionStart, codexHookDocument(repoRoot, root).hooks.SessionStart);
  assert.deepEqual(hooks.hooks.PostToolUse, [{ hooks: [{ type: "command", command: `node ${JSON.stringify(join(repoRoot, "scripts/knowledge-inject-hook.mjs"))} --container-root ${JSON.stringify(root)} --host codex`, timeout: 30 }] }]);
  assert.deepEqual(hooks.hooks.Stop, codexHookDocument(repoRoot, root).hooks.Stop);
  assert.deepEqual(hooks.hooks.SubagentStart, codexHookDocument(repoRoot, root).hooks.SubagentStart);
  assert.deepEqual(hooks.hooks.SubagentStop, codexHookDocument(repoRoot, root).hooks.SubagentStop);
  const green = await inspectHostRenderDrift({ host: "codex", settings: config, root, repoRoot });
  assert.equal(green.ok, true);
  assert.equal(green.drift.length, 0);
});

test("STORY-391: a mixed managed-looking user group stays whole and ordered", async (t) => {
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
  assert.deepEqual(userGroup, old, "full user group, including its managed-looking hook, is preserved");
  const managedCommands = document.hooks.SessionStart.flatMap((group) => group.hooks ?? [])
    .filter((hook) => hook.command.includes("scripts/knowledge-inject-hook.mjs"));
  assert.equal(managedCommands.length, 2, "the user hook and canonical generated hook both remain");
  assert.equal(plan.files.find((entry) => entry.path === ".codex/hooks.json").actualManaged.SessionStart.length, 0, "user group is not classified as managed");
  assert.equal(plan.drift.some((entry) => entry.path === ".codex/hooks.json"), true);
});

test("TCRN-CROSS-STORY-417: exact legacy telemetry groups migrate in place on both hosts", async (t) => {
  for (const host of ["claude-code", "codex"]) {
    const root = await scratch(`tcrn-host-render-legacy-${host}-`);
    t.after(() => rm(root, { recursive: true, force: true }));
    const generated = generatedHooks(host, root);
    const existingHooks = Object.fromEntries(Object.entries(generated).map(([event, groups]) => [
      event,
      groups.map((group) => event === "SubagentStart" || event === "SubagentStop" ? withoutHostSuffix(group, host) : structuredClone(group)),
    ]));
    const existing = new Map([[hookFilePath(host), JSON.stringify(host === "codex" ? { hooks: existingHooks } : { hooks: existingHooks })]]);
    const config = settings(host);
    const plan = renderHostPlan({ host, settings: config, root, repoRoot, existing });
    const file = plan.files.find((entry) => entry.path === hookFilePath(host));
    const document = JSON.parse(file.content);
    assert.equal(document.hooks.SubagentStart.length, generated.SubagentStart.length);
    assert.equal(document.hooks.SubagentStop.length, generated.SubagentStop.length);
    assert.deepEqual(document.hooks.SubagentStart, generated.SubagentStart, `${host} Start legacy replacement is exact`);
    assert.deepEqual(document.hooks.SubagentStop, generated.SubagentStop, `${host} Stop legacy replacement is exact`);
    const actualHooks = host === "codex" ? file.actualManaged : file.actualManaged.hooks;
    assert.equal(actualHooks.SubagentStart[0].hooks[0].command.endsWith(` --host ${host === "codex" ? "codex" : "claude"}`), false, "actual projection records the legacy before state");
    assert.equal(file.drift, true);
  }
});

test("TCRN-CROSS-STORY-393 R2: absolute guarded Claude hooks replace in place and stay project-scoped", async (t) => {
  const root = await scratch("tcrn-host-render-r2-legacy-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const guarded = (handler, host = false) => `if [ "$CLAUDE_PROJECT_DIR" = "${resolve(repoRoot, "..", "..")}" ]; then node "${resolve(repoRoot, handler)}"${host ? " --host claude" : ""}; fi`;
  const existingHooks = {
    Stop: [
      { hooks: [{ type: "command", command: guarded("tools/stop-pact/hook.mjs"), timeout: 10 }] },
      { hooks: [{ type: "command", command: guarded("scripts/knowledge-capture-hook.mjs"), timeout: 30 }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: guarded("scripts/agents-zero-hook.mjs"), timeout: 10 }] }],
  };
  const existing = new Map([[".claude/settings.json", JSON.stringify({ hooks: existingHooks })]]);
  const plan = renderHostPlan({ host: "claude-code", scope: "hooks-only", settings: settings("claude-code"), root, repoRoot, existing });
  const file = plan.files[0];
  const document = JSON.parse(file.content);
  const generated = claudeHookSettings();
  assert.equal(document.hooks.Stop.length, generated.Stop.length, "Stop groups are upgraded in place instead of appended");
  assert.equal(document.hooks.UserPromptSubmit.length, generated.UserPromptSubmit.length, "UserPromptSubmit groups are upgraded in place instead of appended");
  assert.equal(document.hooks.Stop.filter((group) => group.hooks[0].command.includes("knowledge-capture-hook.mjs")).length, 1);
  assert.equal(document.hooks.UserPromptSubmit.filter((group) => group.hooks[0].command.includes("agents-zero-hook.mjs")).length, 1);
  assert.ok(document.hooks.Stop.every((group) => group.hooks[0].command.startsWith("if [ -f \"${CLAUDE_PROJECT_DIR}/")), "the generated projection is guarded");
  const otherProject = await scratch("tcrn-host-render-other-project-");
  t.after(() => rm(otherProject, { recursive: true, force: true }));
  const captureCommand = document.hooks.Stop.find((group) => group.hooks[0].command.includes("knowledge-capture-hook.mjs")).hooks[0].command;
  const result = execFileSync("sh", ["-c", captureCommand], { env: { ...process.env, CLAUDE_PROJECT_DIR: otherProject }, encoding: "utf8" });
  assert.equal(result, "", "an unrelated project does not invoke a missing platform hook");
});

test("TCRN-CROSS-STORY-393 R6: real user guard forms normalize to the generated handlers", async (t) => {
  const root = await scratch("tcrn-host-render-r6-user-guards-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = resolve(repoRoot, "..", "..");
  const absolute = (handler) => resolve(repoRoot, handler);
  const existingHooks = {
    Stop: [
      { hooks: [{ type: "command", command: `node "${absolute("tools/stop-pact/hook.mjs")}"`, timeout: 10 }] },
      { hooks: [{ type: "command", command: `[ "$CLAUDE_PROJECT_DIR" = "${projectRoot}" ] && node "${absolute("scripts/knowledge-capture-hook.mjs")}" || true`, timeout: 30 }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `if [ "$CLAUDE_PROJECT_DIR" = "${projectRoot}" ]; then node "${absolute("scripts/agents-zero-hook.mjs")}"; else cat >/dev/null; fi`, timeout: 10 }] }],
  };
  const existing = new Map([[".claude/settings.json", JSON.stringify({ hooks: existingHooks })]]);
  const plan = renderHostPlan({ host: "claude-code", scope: "hooks-only", settings: settings("claude-code"), root, repoRoot, existing });
  const document = JSON.parse(plan.files[0].content);
  const generated = claudeHookSettings();
  const sortByCommand = (groups) => groups.slice().sort((left, right) => left.hooks[0].command.localeCompare(right.hooks[0].command));
  assert.deepEqual(sortByCommand(document.hooks.Stop), sortByCommand(generated.Stop), "the real && guard replaces Stop in place");
  assert.deepEqual(sortByCommand(document.hooks.UserPromptSubmit), sortByCommand(generated.UserPromptSubmit), "the real if/then/else guard replaces UserPromptSubmit in place");
  for (const event of ["Stop", "UserPromptSubmit"]) {
    const handlers = document.hooks[event].flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command.match(/(?:scripts|tools)\/[^"'\s]+?\.mjs/u)?.[0])
      .filter(Boolean);
  assert.equal(new Set(handlers).size, handlers.length, `${event} has no duplicate managed handler`);
  }
  const unsafeHooks = structuredClone(existingHooks);
  unsafeHooks.UserPromptSubmit[0].hooks[0].command = unsafeHooks.UserPromptSubmit[0].hooks[0].command.replace("cat >/dev/null", "echo keep-user-command");
  const unsafePlan = renderHostPlan({
    host: "claude-code",
    scope: "hooks-only",
    settings: settings("claude-code"),
    root,
    repoRoot,
    existing: new Map([[".claude/settings.json", JSON.stringify({ hooks: unsafeHooks })]]),
  });
  assert.equal(JSON.parse(unsafePlan.files[0].content).hooks.UserPromptSubmit[0].hooks[0].command, unsafeHooks.UserPromptSubmit[0].hooks[0].command);
});

test("TCRN-CROSS-STORY-417: same-script user groups, metadata, timeout and order are preserved", async (t) => {
  for (const host of ["claude-code", "codex"]) {
    const root = await scratch(`tcrn-host-render-user-group-${host}-`);
    t.after(() => rm(root, { recursive: true, force: true }));
    const generated = generatedHooks(host, root);
    const userGroup = {
      matcher: "UserOwnedSameScript",
      timeout: 37,
      userMetadata: { owner: "user", array: ["keep", { exact: true }] },
      hooks: [{ type: "command", command: `${generated.SubagentStart[0].hooks[0].command} --user-owned-extra`, userField: null }],
    };
    const hooks = structuredClone(generated);
    hooks.SubagentStart = [userGroup, ...hooks.SubagentStart];
    const existing = new Map([[hookFilePath(host), JSON.stringify(host === "codex" ? { hooks } : { hooks })]]);
    const plan = renderHostPlan({ host, settings: settings(host), root, repoRoot, existing });
    const file = plan.files.find((entry) => entry.path === hookFilePath(host));
    const document = JSON.parse(file.content);
    assert.deepEqual(document.hooks.SubagentStart[0], userGroup, `${host} user group is byte-structured intact`);
    assert.deepEqual(document.hooks.SubagentStart.slice(1), generated.SubagentStart, `${host} generated order follows user group`);
    const actualHooks = host === "codex" ? file.actualManaged : file.actualManaged.hooks;
    assert.deepEqual(actualHooks.SubagentStart, generated.SubagentStart, `${host} projection excludes user group`);
  }
});

test("TCRN-CROSS-STORY-417: duplicate exact managed identities refuse before write", async (t) => {
  for (const host of ["claude-code", "codex"]) {
    for (const scope of ["full", "hooks-only"]) {
      const root = await scratch(`tcrn-host-render-duplicate-${host}-${scope}-`);
      t.after(() => rm(root, { recursive: true, force: true }));
      const generated = generatedHooks(host, root);
      const hooks = structuredClone(generated);
      hooks.SubagentStart = [structuredClone(hooks.SubagentStart[0]), structuredClone(hooks.SubagentStart[0]), ...hooks.SubagentStart.slice(1)];
      const existing = new Map([[hookFilePath(host), JSON.stringify({ hooks })]]);
      assert.throws(() => renderHostPlan({ host, scope, settings: settings(host), root, repoRoot, existing }), (error) => error?.reasonCode === "HOST_RENDER_MANAGED_IDENTITY_AMBIGUOUS");
      assert.equal((await readFile(join(root, hookFilePath(host))).catch(() => null)), null, `${host}/${scope} ambiguity has no write`);
    }
  }
});

test("TCRN-CROSS-STORY-417: generated event shape is not coerced when the target is incompatible", async (t) => {
  for (const value of [null, {}, "wrong", 4, true]) {
    const root = await scratch("tcrn-host-render-shape-");
    t.after(() => rm(root, { recursive: true, force: true }));
    const hooks = { ...generatedHooks("codex", root), SubagentStart: value };
    const existing = new Map([[".codex/hooks.json", JSON.stringify({ hooks })]]);
    assert.throws(() => renderHostPlan({ host: "codex", settings: settings("codex"), root, repoRoot, existing }), (error) => error?.reasonCode === "HOST_RENDER_TARGET_INVALID");
  }
});

test("TCRN-CROSS-STORY-417: duplicate nonmatching user groups and unknown event values remain intact", async (t) => {
  for (const host of ["claude-code", "codex"]) {
    const root = await scratch(`tcrn-host-render-structural-${host}-`);
    t.after(() => rm(root, { recursive: true, force: true }));
    const generated = generatedHooks(host, root);
    const userGroup = {
      matcher: "UserOwnedStructural",
      timeout: null,
      metadata: { unknown: [null, "value", { array: [1, 2] }] },
      hooks: [{ type: "command", command: `${generated.SubagentStop[0].hooks[0].command} --user-owned-extra`, timeout: "17" }],
    };
    const hooks = structuredClone(generated);
    hooks.SubagentStop = [userGroup, structuredClone(userGroup), ...hooks.SubagentStop];
    hooks.UserOwnedUnknownEvent = { value: [null, { keep: true }] };
    const existing = new Map([[hookFilePath(host), JSON.stringify({ hooks })]]);
    const plan = renderHostPlan({ host, settings: settings(host), root, repoRoot, existing });
    const file = plan.files.find((entry) => entry.path === hookFilePath(host));
    const document = JSON.parse(file.content);
    assert.deepEqual(document.hooks.SubagentStop.slice(0, 2), [userGroup, userGroup], `${host} duplicate user groups preserve multiplicity and all types`);
    assert.deepEqual(document.hooks.UserOwnedUnknownEvent, hooks.UserOwnedUnknownEvent, `${host} unknown event value is unchanged`);
    const actualHooks = host === "codex" ? file.actualManaged : file.actualManaged.hooks;
    assert.equal(actualHooks.SubagentStop.length, generated.SubagentStop.length, `${host} managed projection excludes duplicate user groups`);
  }
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

test("TCRN-CROSS-STORY-429: Codex hooks-only ignores and preserves an existing project model config", async (t) => {
  const root = await scratch("tcrn-host-render-hooks-only-codex-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".codex"), { recursive: true });
  const configBytes = Buffer.from(`# personal project choice\nmodel = "user-model"\nmodel_reasoning_effort = "low"\ncustom = { keep = true }\n\n[projects."x"]\nmodel = "nested-model"\n`, "utf8");
  await writeFile(join(root, ".codex", "config.toml"), configBytes);
  const userGroup = { matcher: "User", hooks: [{ type: "command", command: "user-owned-hook" }] };
  await writeFile(join(root, ".codex", "hooks.json"), `${JSON.stringify({ description: "user metadata", hooks: { User: [userGroup] } }, null, 2)}\n`);

  const config = settings("codex");
  const first = renderHostPlan({ host: "codex", scope: "hooks-only", settings: config, root, repoRoot, existing: new Map() });
  const plan = renderHostPlan({ host: "codex", scope: "hooks-only", settings: config, root, repoRoot, existing: await existingFor(first, root) });
  assert.equal(plan.resolutions.plan.model, "codex-flagship", "a real model resolution must not expand hooks-only scope");
  assert.deepEqual(plan.files.map((entry) => entry.path), [".codex/hooks.json"]);
  assert.deepEqual(plan.files[0].ownedFields, ["hooks"]);
  assert.deepEqual(Object.keys(plan.files[0].expectedManaged), Object.keys(codexHookDocument(repoRoot, root).hooks));

  const receipt = await applyHostRender(plan, { backupDir: join(root, "backups") });
  assert.equal(receipt.reasonCode, "HOST_RENDER_COMMITTED");
  assert.deepEqual(receipt.files.map((entry) => entry.path), [".codex/hooks.json"]);
  assert.deepEqual(await readFile(join(root, ".codex", "config.toml")), configBytes);
  const renderedHooks = JSON.parse(await readFile(join(root, ".codex", "hooks.json"), "utf8"));
  assert.equal(renderedHooks.description, "user metadata");
  assert.deepEqual(renderedHooks.hooks.User, [userGroup]);

  const doctor = await inspectHostRenderDrift({ host: "codex", scope: "hooks-only", settings: config, root, repoRoot });
  assert.equal(doctor.ok, true);
  assert.equal(doctor.scope, "hooks-only");
  await writeFile(join(root, ".codex", "config.toml"), `model = "changed outside hooks scope"\n`);
  const ignoredModelDrift = await inspectHostRenderDrift({ host: "codex", scope: "hooks-only", settings: config, root, repoRoot });
  assert.equal(ignoredModelDrift.ok, true, "hooks-only comparison does not report model/config state");
});

test("TCRN-CROSS-STORY-429: Claude hooks-only preserves all non-hook settings and backs up exact preimage bytes", async (t) => {
  const root = await scratch("tcrn-host-render-hooks-only-claude-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".claude"), { recursive: true });
  const before = {
    model: "owner-selected-model",
    env: { CLAUDE_CODE_EFFORT_LEVEL: "owner-selected-effort", PRIVATE_USER_FLAG: "keep" },
    permissions: { allow: ["Read(/**)"], deny: ["Bash(/**)"] },
    security: { stopOnUnsafe: true, nested: { mode: "strict", values: [null, 3] } },
    tcrnWorkflowInert: { enabled: false, reason: "user-owned" },
    userUnknown: { nested: ["retain", { key: "value" }] },
    hooks: { UserOwnedEvent: [{ matcher: "user", hooks: [{ type: "command", command: "user-hook" }] }] },
  };
  const beforeBytes = Buffer.from(`${JSON.stringify(before, null, 2)}\n`, "utf8");
  await writeFile(join(root, ".claude", "settings.json"), beforeBytes);
  const config = settings("claude-code");
  const first = renderHostPlan({ host: "claude-code", scope: "hooks-only", settings: config, root, repoRoot, existing: new Map() });
  const plan = renderHostPlan({ host: "claude-code", scope: "hooks-only", settings: config, root, repoRoot, existing: await existingFor(first, root) });
  assert.deepEqual(plan.files.map((entry) => entry.path), [".claude/settings.json"]);
  assert.deepEqual(plan.files[0].ownedFields, ["hooks"]);

  const receipt = await applyHostRender(plan, { backupDir: join(root, "backups") });
  assert.equal(receipt.reasonCode, "HOST_RENDER_COMMITTED");
  assert.deepEqual(receipt.files.map((entry) => entry.path), [".claude/settings.json"]);
  const backupBytes = await readFile(join(root, "backups", ".claude", "settings.json"));
  assert.deepEqual(backupBytes, beforeBytes, "the preimage backup is byte-exact");
  const afterBytes = await readFile(join(root, ".claude", "settings.json"));
  const after = JSON.parse(afterBytes.toString("utf8"));
  const withoutHooks = (value) => {
    const result = structuredClone(value);
    delete result.hooks;
    return result;
  };
  assert.deepEqual(withoutHooks(after), withoutHooks(before), "model, env, security, permissions and unknown nested fields stay semantically identical");
  assert.deepEqual(after.hooks.UserOwnedEvent, before.hooks.UserOwnedEvent);
  assert.notDeepEqual(afterBytes, beforeBytes, "the JSON file changes only because the authorized hooks change");
  assert.equal(await readFile(join(root, "CLAUDE.md"), "utf8").catch(() => null), null);
  assert.equal(await readFile(join(root, ".claude", "agents", "implement.md"), "utf8").catch(() => null), null);
});

test("TCRN-CROSS-STORY-429: empty model plans still project only hooks for both hosts", async (t) => {
  for (const host of ["claude-code", "codex"]) {
    const root = await scratch(`tcrn-host-render-hooks-only-empty-${host}-`);
    t.after(() => rm(root, { recursive: true, force: true }));
    const plan = renderHostPlan({ host, scope: "hooks-only", settings: emptyDispatchSettings, root, repoRoot, existing: new Map() });
    assert.equal(plan.scope, "hooks-only");
    assert.equal(plan.comparable, false);
    assert.equal(plan.hooksComparable, true);
    assert.deepEqual(plan.files.map((entry) => entry.path), [hookFilePath(host)]);
    const receipt = await applyHostRender(plan);
    assert.equal(receipt.reasonCode, "HOST_RENDER_COMMITTED");
    assert.deepEqual(receipt.files.map((entry) => entry.path), [hookFilePath(host)]);
    if (host === "codex") assert.equal(await readFile(join(root, ".codex", "config.toml"), "utf8").catch(() => null), null);
    else {
      assert.equal(await readFile(join(root, "CLAUDE.md"), "utf8").catch(() => null), null);
      assert.equal(await readFile(join(root, ".claude", "agents", "implement.md"), "utf8").catch(() => null), null);
    }
    const doctor = await inspectHostRenderDrift({ host, scope: "hooks-only", settings: emptyDispatchSettings, root, repoRoot });
    assert.equal(doctor.ok, true);
    assert.equal(doctor.scope, "hooks-only");
    assert.equal(doctor.hooksComparable, true);
  }
});

test("TCRN-CROSS-STORY-429: hooks-only rejects injected Codex config and Claude model writes before any apply", async (t) => {
  const codexRoot = await scratch("tcrn-host-render-hooks-only-guard-codex-");
  t.after(() => rm(codexRoot, { recursive: true, force: true }));
  const codexPlan = renderHostPlan({ host: "codex", scope: "hooks-only", settings: settings("codex"), root: codexRoot, repoRoot, existing: new Map() });
  codexPlan.files.push({ path: ".codex/config.toml", content: `model = "injected"\n`, ownedFields: ["model"], beforeSha256: null });
  await assert.rejects(applyHostRender(codexPlan), (error) => error?.reasonCode === "HOST_RENDER_SCOPE_VIOLATION");
  assert.equal(await readFile(join(codexRoot, ".codex", "config.toml"), "utf8").catch(() => null), null);
  assert.equal(await readFile(join(codexRoot, ".codex", "hooks.json"), "utf8").catch(() => null), null);

  const claudeRoot = await scratch("tcrn-host-render-hooks-only-guard-claude-");
  t.after(() => rm(claudeRoot, { recursive: true, force: true }));
  await mkdir(join(claudeRoot, ".claude"), { recursive: true });
  const beforeBytes = Buffer.from(`${JSON.stringify({ model: "user-model", env: { CLAUDE_CODE_EFFORT_LEVEL: "user-effort" }, hooks: {} }, null, 2)}\n`, "utf8");
  await writeFile(join(claudeRoot, ".claude", "settings.json"), beforeBytes);
  const claudeFirst = renderHostPlan({ host: "claude-code", scope: "hooks-only", settings: settings("claude-code"), root: claudeRoot, repoRoot, existing: new Map() });
  const claudePlan = renderHostPlan({ host: "claude-code", scope: "hooks-only", settings: settings("claude-code"), root: claudeRoot, repoRoot, existing: await existingFor(claudeFirst, claudeRoot) });
  const forged = JSON.parse(claudePlan.files[0].content);
  forged.model = "injected-model";
  claudePlan.files[0].content = `${JSON.stringify(forged, null, 2)}\n`;
  await assert.rejects(applyHostRender(claudePlan), (error) => error?.reasonCode === "HOST_RENDER_SCOPE_VIOLATION");
  assert.deepEqual(await readFile(join(claudeRoot, ".claude", "settings.json")), beforeBytes);
});

test("TCRN-CROSS-STORY-429: native CLI scope selects hooks-only or the explicit full path", async (t) => {
  const root = await scratch("tcrn-host-render-hooks-only-cli-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(repoRoot, "scripts", "host-render.mjs");
  const args = ["--host", "codex", "--root", root, "--settings", JSON.stringify(settings("codex"))];
  const hooksPlan = JSON.parse(execFileSync(process.execPath, [cli, ...args, "--scope", "hooks-only", "--plan-only"], { encoding: "utf8" }));
  assert.equal(hooksPlan.reasonCode, "HOST_RENDER_PLAN_READY");
  assert.equal(hooksPlan.plan.scope, "hooks-only");
  assert.deepEqual(hooksPlan.plan.files.map((entry) => entry.path), [".codex/hooks.json"]);

  execFileSync(process.execPath, [cli, ...args, "--hooks-only"], { encoding: "utf8" });
  assert.equal(await readFile(join(root, ".codex", "config.toml"), "utf8").catch(() => null), null);
  assert.ok(JSON.parse(await readFile(join(root, ".codex", "hooks.json"), "utf8")).hooks.SubagentStart.length > 0);

  const fullPlan = JSON.parse(execFileSync(process.execPath, [cli, ...args, "--scope", "full", "--plan-only"], { encoding: "utf8" }));
  assert.equal(fullPlan.plan.scope, "full");
  assert.ok(fullPlan.plan.files.some((entry) => entry.path === ".codex/config.toml"));
});

test("TCRN-CROSS-STORY-429: the six authorized per-host hook changes do not alter other managed or user groups", async (t) => {
  for (const host of ["claude-code", "codex"]) {
    const root = await scratch(`tcrn-host-render-hooks-only-delta-${host}-`);
    t.after(() => rm(root, { recursive: true, force: true }));
    const generated = generatedHooks(host, root);
    const beforeHooks = structuredClone(generated);
    const telemetry = (event) => generated[event].find((group) => group.hooks?.some((hook) => hook.command?.includes("dispatch-telemetry-hook.mjs")));
    const knowledge = generated.SubagentStart.find((group) => group.hooks?.some((hook) => hook.command?.includes("knowledge-inject-hook.mjs")));
    assert.ok(telemetry("SubagentStart"));
    assert.ok(telemetry("SubagentStop"));
    assert.ok(knowledge);
    const legacyStart = withoutHostSuffix(telemetry("SubagentStart"), host);
    const legacyStop = withoutHostSuffix(telemetry("SubagentStop"), host);
    beforeHooks.SubagentStart = beforeHooks.SubagentStart.map((group) => JSON.stringify(group) === JSON.stringify(telemetry("SubagentStart")) ? legacyStart : group);
    beforeHooks.SubagentStart = beforeHooks.SubagentStart.filter((group) => JSON.stringify(group) !== JSON.stringify(knowledge));
    beforeHooks.SubagentStop = beforeHooks.SubagentStop.map((group) => JSON.stringify(group) === JSON.stringify(telemetry("SubagentStop")) ? legacyStop : group);
    const userGroup = { matcher: "UserOwned", timeout: null, metadata: { retain: [1, { nested: true }] }, hooks: [{ type: "command", command: "user hook" }] };
    beforeHooks.UserPromptSubmit.push(userGroup);
    const beforeDocument = host === "claude-code"
      ? { model: "user-model", env: { CLAUDE_CODE_EFFORT_LEVEL: "user-effort", USER_FLAG: null }, permissions: { deny: ["Bash(/**)"] }, security: { nested: { retain: true } }, hooks: beforeHooks }
      : { description: "user metadata", hooks: beforeHooks };
    const existing = new Map([[hookFilePath(host), JSON.stringify(beforeDocument)]]);
    const plan = renderHostPlan({ host, scope: "hooks-only", settings: settings(host), root, repoRoot, existing });
    assert.deepEqual(plan.files.map((entry) => entry.path), [hookFilePath(host)]);
    const file = plan.files[0];
    const actual = JSON.parse(file.content);
    const expected = structuredClone(beforeDocument);
    const startIndex = expected.hooks.SubagentStart.findIndex((group) => JSON.stringify(group) === JSON.stringify(legacyStart));
    const stopIndex = expected.hooks.SubagentStop.findIndex((group) => JSON.stringify(group) === JSON.stringify(legacyStop));
    expected.hooks.SubagentStart[startIndex] = telemetry("SubagentStart");
    expected.hooks.SubagentStart.push(knowledge);
    expected.hooks.SubagentStop[stopIndex] = telemetry("SubagentStop");
    assert.deepEqual(actual, expected, `${host}: exactly two telemetry replacements and one full task-bound knowledge group addition`);
    assert.deepEqual(actual.hooks.UserPromptSubmit.at(-1), userGroup, `${host}: unowned user group and metadata are retained`);
  }
});
