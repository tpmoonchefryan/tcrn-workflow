// SPDX-License-Identifier: Apache-2.0

// INC-002: host-approved hook commands bind the installer-admitted absolute
// project root. The test executes each command from an attacker-controlled cwd;
// a relative-path regression runs the decoy handler and turns this test red.
//
// INC-011: the same commands do NOT bind their interpreter. The last test executes the
// disclosed residual rather than describing it, so the wording in the claim ledger, the
// two adapter specs and the activation ladder can never outlive the code.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, parse } from "node:path";
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
    const command = claudeAdapterActivationHookCommand(admittedRoot, digest);
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
    assert.notEqual(
      command,
      claudeAdapterActivationHookCommand(admittedRoot, "b".repeat(64)),
      "the approved Claude command is specific to the handler bytes, not only the root",
    );
    assert.ok(command.endsWith(`--handler-digest ${digest}`));
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

// Every path here is synthesized at run time from mkdtemp and process.env. A literal
// interpreter path would be a machine path in a committed file, which the privacy gate
// refuses (LOCAL_ABSOLUTE_PATH), and it would also make this test machine-specific.
async function decoyInterpreter(directory) {
  await mkdir(directory, { recursive: true });
  // Echoes argv[1] so the test can prove the substituted interpreter still received the
  // admitted absolute handler -- the cwd binding must hold even under substitution.
  await writeFile(
    join(directory, "node"),
    `#!/bin/sh
printf "decoy-interpreter %s" "$1"
exit 0
`,
    { mode: 0o700 },
  );
  return directory;
}

test("INC-011: both approved commands resolve their interpreter through the fire-time PATH", async () => {
  const value = await fixture();
  try {
    const codexRoot = await admitCodexAdapterInstallationRoot(value.admittedRoot);
    const claudeRoot = await admitClaudeAdapterInstallationRoot(value.admittedRoot);
    const cases = [
      {
        command: JSON.parse(
          codexHookDefinitionForDigests(codexRoot, digest, digest).source,
        ).hooks.SessionStart[0].hooks[0].command,
        handler: join(value.admittedRoot, CODEX_SESSION_START_PATH),
        marker: "codex-admitted",
      },
      {
        command: claudeAdapterActivationHookCommand(claudeRoot, digest),
        handler: join(value.admittedRoot, CLAUDE_ADAPTER_SESSION_START_PATH),
        marker: "claude-admitted",
      },
    ];
    const decoy = await decoyInterpreter(join(value.base, "poisoned path"));
    for (const { command, handler, marker } of cases) {
      // The interpreter is a bare name; only the handler argument is absolute.
      assert.ok(command.startsWith("node '"), command);

      const fired = spawnSync(command, {
        cwd: value.attackerCwd,
        encoding: "utf8",
        shell: true,
        env: { ...process.env, PATH: `${decoy}${delimiter}${process.env.PATH ?? ""}` },
      });

      // Fail-open means exit zero, so nothing about a substituted interpreter reaches
      // the host either. That is the disclosure, not a defence.
      assert.equal(fired.status, 0, fired.stderr);
      assert.equal(fired.stdout, `decoy-interpreter ${handler}`);
      // The handler bytes never executed, so its own --handler-digest self-check never
      // ran: digest binding provides nothing against interpreter substitution.
      assert.equal(fired.stdout.includes(marker), false);
      // INC-002 still holds under substitution: the argument handed to the decoy is the
      // admitted handler, never the attacker cwd's same-named file.
      assert.equal(fired.stdout.includes(value.attackerCwd), false);
    }
  } finally {
    await value.close();
  }
});
