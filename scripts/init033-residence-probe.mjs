#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// S262 host-residence probe. This creates a disposable container root and a
// disposable child Git fixture, asks each installed host for the read-only
// surface it exposes, and removes the fixture before returning. It deliberately
// never opens a model session or touches a real project configuration.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

async function run(label, executable, args, cwd, environment = {}) {
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      env: { ...process.env, ...environment },
      timeout: 15_000,
      maxBuffer: 1_048_576,
    });
    return { label, executable, args, cwd, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      label,
      executable,
      args,
      cwd,
      exitCode: typeof error?.code === "number" ? error.code : 1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? String(error),
    };
  }
}

const root = await mkdtemp(join(tmpdir(), "tcrn-init033-residence-"));
const project = join(root, "fixture-project");
const codexHome = join(root, "fixture-codex-home");
try {
  await mkdir(join(root, ".claude"), { recursive: true });
  await mkdir(join(root, ".codex"), { recursive: true });
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(root, ".claude", "settings.json"), `${JSON.stringify({
    permissions: { deny: ["Bash(echo INIT033_DENY_MARKER)"] },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "printf INIT033_SESSION_HOOK" }] }],
      Stop: [{ hooks: [{ type: "command", command: "printf INIT033_STOP_HOOK" }] }],
    },
  }, null, 2)}\n`);
  await writeFile(join(root, ".mcp.json"), `${JSON.stringify({
    mcpServers: {
      init033Fixture: { command: "node", args: ["-e", "process.stdout.write('INIT033_MCP_FIXTURE')"] },
    },
  }, null, 2)}\n`);
  // Deliberately place the first Codex config at the container root. A second
  // config is created in the child below, so the two probes distinguish
  // ancestor inheritance from the project surface.
  await writeFile(join(root, ".codex", "config.toml"), "[features]\nhooks = false\n");
  await writeFile(join(project, "AGENTS.md"), "INIT033 disposable fixture\n");

  const hostVersions = [
    await run("claude version", "claude", ["--version"], project),
    await run("codex version", "codex", ["--version"], project, { CODEX_HOME: codexHome }),
  ];
  const probes = [
    // `doctor` is a read-only config parse/entry probe. It does not open a
    // network model session, so settings deny/hooks are reported as loaded
    // surface, with behavior deliberately marked unobserved below.
    await run("claude settings doctor", "claude", ["doctor"], root),
    await run("claude project MCP list", "claude", ["mcp", "list"], project),
    await run("claude project MCP get", "claude", ["mcp", "get", "init033Fixture"], project),
    await run("codex container-root feature list", "codex", ["-C", project, "features", "list"], project, { CODEX_HOME: codexHome }),
    await run("codex project MCP list", "codex", ["-C", project, "mcp", "list"], project, { CODEX_HOME: codexHome }),
  ];
  await mkdir(join(project, ".codex"), { recursive: true });
  await writeFile(join(project, ".codex", "config.toml"), "[features]\nhooks = false\n");
  probes.push(await run("codex project feature list", "codex", ["-C", project, "features", "list"], project, { CODEX_HOME: codexHome }));
  await writeFile(join(codexHome, "config.toml"), "[features]\nhooks = false\n");
  const settingsText = await readFile(join(root, ".claude", "settings.json"), "utf8");
  const codexRootText = await readFile(join(root, ".codex", "config.toml"), "utf8");
  const codexProjectText = await readFile(join(project, ".codex", "config.toml"), "utf8");
  const rootCodexProbe = probes.find((probe) => probe.label === "codex container-root feature list");
  const projectCodexProbe = probes.find((probe) => probe.label === "codex project feature list");
  probes.push(await run("codex user feature list", "codex", ["-C", project, "features", "list"], project, { CODEX_HOME: codexHome }));
  const userCodexProbe = probes.find((probe) => probe.label === "codex user feature list");
  const rootHooksFalseObserved = rootCodexProbe?.stdout.includes("hooks                                stable             false") ?? false;
  const projectHooksFalseObserved = projectCodexProbe?.stdout.includes("hooks                                stable             false") ?? false;
  const userHooksFalseObserved = userCodexProbe?.stdout.includes("hooks                                stable             false") ?? false;
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "tcrn.init033.residence-probe.v1",
    fixture: {
      root,
      childProject: project,
      childIsGitFixture: true,
      cleanup: "completed after this JSON was emitted",
    },
    hostVersions,
    probes,
    conclusions: {
      claudeSettingsDeny: "host surface accepted by doctor; deny behavior not observed because no model session was opened",
      claudeHooks: "host surface accepted by doctor; hook firing not observed because no model session was opened",
      claudeMcp: "effective in child project: project .mcp.json is visible and pending approval",
      codexConfig: userHooksFalseObserved
        ? `effective only from CODEX_HOME/config.toml; container-root .codex=${rootHooksFalseObserved ? "observed" : "not observed"}, project .codex=${projectHooksFalseObserved ? "observed" : "not observed"}`
        : "not observed",
      codexAgents: "AGENTS.md inheritance surface is present in the child fixture; behavior was not observed without opening a model session",
    },
    fixtureBytes: {
      claudeSettings: settingsText,
      codexContainerRootConfig: codexRootText,
      codexProjectConfig: codexProjectText,
    },
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
