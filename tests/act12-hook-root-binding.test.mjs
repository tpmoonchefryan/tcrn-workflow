// SPDX-License-Identifier: Apache-2.0

// INC-002: host-approved hook commands bind the installer-admitted absolute
// project root. The test executes each command from an attacker-controlled cwd;
// a relative-path regression runs the decoy handler and turns this test red.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";

import {
  COMMAND_CATALOG,
  runCli,
} from "../dist/build/packages/cli/src/index.js";
import {
  CODEX_SESSION_START_PATH,
  CLAUDE_ADAPTER_SESSION_START_PATH,
  admitClaudeAdapterInstallationRoot,
  admitCodexAdapterInstallationRoot,
  claudeAdapterActivationHookCommand,
  codexHookDefinitionForDigests,
} from "../dist/build/packages/core/src/index.js";

const digest = "a".repeat(64);

async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "tcrn hook root's fixture-")),
  );
  const admittedRoot = join(base, "admitted project");
  const attackerCwd = join(base, "attacker cwd");
  await Promise.all([
    mkdir(join(admittedRoot, ".codex", "tcrn-workflow"), { recursive: true }),
    mkdir(join(admittedRoot, ".claude", "tcrn-workflow"), { recursive: true }),
    mkdir(join(attackerCwd, ".codex", "tcrn-workflow"), { recursive: true }),
    mkdir(join(attackerCwd, ".claude", "tcrn-workflow"), { recursive: true }),
  ]);
  const source = (marker) => `process.stdout.write(${JSON.stringify(marker)});\n`;
  await Promise.all([
    writeFile(join(admittedRoot, CODEX_SESSION_START_PATH), source("codex-admitted")),
    writeFile(join(admittedRoot, CLAUDE_ADAPTER_SESSION_START_PATH), source("claude-admitted")),
    writeFile(join(attackerCwd, CODEX_SESSION_START_PATH), source("codex-hijacked")),
    writeFile(join(attackerCwd, CLAUDE_ADAPTER_SESSION_START_PATH), source("claude-hijacked")),
  ]);
  return {
    base,
    admittedRoot: await realpath(admittedRoot),
    attackerCwd: await realpath(attackerCwd),
    close: () => rm(base, { recursive: true, force: true }),
  };
}

test("INC-002: Codex hook command executes the admitted root from an attacker cwd", async () => {
  const value = await fixture();
  try {
    const admittedRoot = await admitCodexAdapterInstallationRoot(
      value.admittedRoot,
    );
    const definition = codexHookDefinitionForDigests(
      admittedRoot,
      digest,
      digest,
    );
    const command = JSON.parse(definition.source)
      .hooks.SessionStart[0].hooks[0].command;
    const fired = spawnSync(command, {
      cwd: value.attackerCwd,
      encoding: "utf8",
      shell: true,
    });
    assert.equal(fired.status, 0, fired.stderr);
    assert.equal(fired.stdout, "codex-admitted");
    assert.equal(command.includes(`node "${CODEX_SESSION_START_PATH}"`), false);

    const other = codexHookDefinitionForDigests(
      "/tmp/different-project-root",
      digest,
      digest,
    );
    assert.notEqual(
      definition.binding.hookDefinitionDigest,
      other.binding.hookDefinitionDigest,
      "the approved definition digest must be machine/root specific",
    );
  } finally {
    await value.close();
  }
});

test("INC-002: Claude hook command executes the admitted root from an attacker cwd", async () => {
  const value = await fixture();
  try {
    const admittedRoot = await admitClaudeAdapterInstallationRoot(
      value.admittedRoot,
    );
    const command = claudeAdapterActivationHookCommand(admittedRoot);
    const fired = spawnSync(command, {
      cwd: value.attackerCwd,
      encoding: "utf8",
      shell: true,
    });
    assert.equal(fired.status, 0, fired.stderr);
    assert.equal(fired.stdout, "claude-admitted");
    assert.equal(
      command.includes(`node "${CLAUDE_ADAPTER_SESSION_START_PATH}"`),
      false,
    );
  } finally {
    await value.close();
  }
});

test("INC-002: Claude root admission refuses user-level host configuration", async () => {
  const home = homedir();
  const root = parse(home).root;
  const ancestor = dirname(home);
  for (const forbidden of new Set([home, root, ancestor])) {
    await assert.rejects(
      admitClaudeAdapterInstallationRoot(forbidden),
      (error) => error?.reasonCode === "INSTALLER_ROOT_INVALID",
      forbidden,
    );
  }
});

test("INC-002: the Claude fragment CLI requires and admits installation-root", async () => {
  const entry = COMMAND_CATALOG.find(
    (candidate) => candidate.name === "claude-adapter-activation-fragment",
  );
  assert.deepEqual(entry?.flags, [
    { name: "request", required: true, valueKind: "json" },
    { name: "installation-root", required: true, valueKind: "string" },
  ]);

  await assert.rejects(
    runCli(
      ["claude-adapter-activation-fragment", "--request", "{}"],
      { write: () => {} },
    ),
    (error) => error?.reasonCode === "CLI_ARGUMENT_MISSING",
  );

  const missingRoot = join(tmpdir(), "tcrn-inc002-missing-installation-root");
  await assert.rejects(
    runCli(
      [
        "claude-adapter-activation-fragment",
        "--request",
        "{}",
        "--installation-root",
        missingRoot,
      ],
      { write: () => {} },
    ),
    (error) => error?.reasonCode === "INSTALLER_ROOT_INVALID",
  );
});
