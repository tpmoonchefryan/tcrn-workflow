// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectGateResults,
  probeDisciplineProblems,
  requiredFailurePatternProblems,
  scrubPublicEnvironment,
} from "../scripts/preflight.mjs";

test("public preflight strips private host and sibling environment", () => {
  const env = scrubPublicEnvironment({
    PATH: "/bin",
    HOME: "/tmp/home",
    TCRN_SSH_GOVERNED_HOST: "private.example",
    TCRN_SSH_RUNTIME_ROOT: "/srv/private",
    TCRN_PG_TEST_PASSWORD: "secret",
    GITHUB_TOKEN: "token",
  });
  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/tmp/home",
    CI: "true",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  });
});

test("preflight collects every world-mismatch red leg instead of failing fast", () => {
  const specs = [
    ["missing-env", ["node", "probe", "missing-env"]],
    ["sibling-checkout", ["node", "probe", "sibling-checkout"]],
    ["race-assertion", ["node", "probe", "race-assertion"]],
    ["historical-leak", ["node", "probe", "historical-leak"]],
  ];
  const results = collectGateResults(specs, (command) => ({
    status: 1,
    stdout: JSON.stringify({ reasonCode: `INJECTED_${command.at(-1).toUpperCase().replaceAll("-", "_")}` }),
    stderr: "",
  }));
  assert.deepEqual(results.map((result) => result.key), specs.map(([key]) => key));
  assert.equal(results.filter((result) => !result.ok).length, 4);
  assert.deepEqual(results.map((result) => result.reasonCode), [
    "INJECTED_MISSING_ENV",
    "INJECTED_SIBLING_CHECKOUT",
    "INJECTED_RACE_ASSERTION",
    "INJECTED_HISTORICAL_LEAK",
  ]);
});

test("probe command discipline rejects every known shell or ref-shape shortcut", async () => {
  for (const [command, expected] of [
    ["zsh -lc probe", "ZSH_COMMAND"],
    ["node probe && node other", "SHELL_CONJUNCTION"],
    ["echo $PIPESTATUS", "PIPESTATUS"],
    ["command | tail -1", "PIPE_TAIL"],
    ["command | head -1", "PIPE_HEAD"],
    ["grep reasonCode output", "GREP_VERDICT"],
    ["git ls-tree HEAD ref:path", "REF_PATH_SYNTAX"],
  ]) {
    assert.ok(probeDisciplineProblems(command).includes(expected), command);
  }
  assert.deepEqual(probeDisciplineProblems(["node", "scripts/verify-s6.mjs"]), []);
  const source = await readFile(new URL("../scripts/preflight.mjs", import.meta.url), "utf8");
  assert.equal(typeof source, "string");
});

test("the composite world-drift pattern is machine-required and deletion is red", () => {
  const register = {
    patterns: [{
      id: "evaluated-world-drift",
      disposition: "gated",
      gate: "pnpm preflight",
      occurrenceCount: 2,
      occurrences: [{}, {}],
    }],
  };
  assert.deepEqual(requiredFailurePatternProblems(register), []);
  assert.deepEqual(requiredFailurePatternProblems({ patterns: [] }), ["evaluated-world-drift:missing"]);
  assert.ok(requiredFailurePatternProblems({ patterns: [{ ...register.patterns[0], gate: null }] }).includes("evaluated-world-drift:gate"));
  assert.ok(requiredFailurePatternProblems({ patterns: [{ ...register.patterns[0], occurrences: [{}] }] }).includes("evaluated-world-drift:occurrences"));
});
