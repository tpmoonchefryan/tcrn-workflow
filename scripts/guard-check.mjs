// SPDX-License-Identifier: Apache-2.0
//
// Guard checker. Each registry entry names a guard and the mutation that removes it; this
// applies the mutation and requires the named test to go RED. A mutation that survives
// means the guard has no proof.
//
// This exists because the rc.6 program twice landed a guard whose proof was never
// written, and the consequence was that reverting the guard reddened nothing -- in a
// framework whose whole claim is that capabilities are machine-verified, that is not a
// fix. The correction was a discipline written into commit messages: revert each guard,
// observe red, restore. This is that discipline as a machine judgement.
//
// It is deliberately NOT general mutation testing. A full sweep over 16k product lines is
// unaffordable here and would bury real findings under equivalent-mutant noise. What this
// does is targeted disproof of specifically declared guards.
//
// Owner-recorded proof budget exception OD-21 (see CONTRIBUTING.md) covers this file.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const findings = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(command, argv) {
  const result = spawnSync(command, argv, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) return { ok: false, output: String(result.error.message) };
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function fail(reasonCode, guardId, detail) {
  findings.push({ reasonCode, guardId, detail });
}

// A mutated tree that is also a dirty tree cannot be restored by comparison, and a crash
// would leave the caller's own edits tangled with ours. Refuse rather than guess.
const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
if (!status.ok) {
  process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: "GUARD_CHECK_GIT_UNAVAILABLE", detail: status.output.trim().slice(0, 200) })}\n`);
  process.exit(1);
}
if (status.output.trim() !== "") {
  process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: "GUARD_CHECK_TREE_DIRTY", detail: status.output.trim().split("\n").slice(0, 5).join(" | ") })}\n`);
  process.exit(1);
}

const registry = JSON.parse(await readFile(resolve(repositoryRoot, "scripts/policy/guard-registry.json"), "utf8"));
const checked = [];

for (const guard of registry.guards) {
  const path = resolve(repositoryRoot, guard.file);
  const original = await readFile(path, "utf8");
  const originalDigest = sha256(original);
  const expectedMatches = guard.expectedMatches ?? 1;

  // The match count is the drift detector, and it runs BEFORE anything is written. If a
  // guard gains or loses a site -- a new admission point, a refactor that renames the
  // arbiter -- the count stops matching and the entry fails without ever mutating the
  // tree. A checker that silently mutated "however many it found" would quietly narrow
  // its own coverage every time the code moved.
  const matches = original.split(guard.find).length - 1;
  if (matches !== expectedMatches) {
    fail("GUARD_CHECK_ANCHOR_DRIFTED", guard.id, `${guard.file}: found ${matches} occurrences, registry declares ${expectedMatches}`);
    continue;
  }

  let restored = false;
  try {
    await writeFile(path, original.split(guard.find).join(guard.replace));
    const build = run("pnpm", ["run", "--silent", "build"]);
    if (!build.ok) {
      // A mutation that will not compile proves nothing about the test. Say so rather
      // than counting it as a kill.
      fail("GUARD_CHECK_MUTATION_UNBUILDABLE", guard.id, build.output.trim().split("\n").slice(-2).join(" | ").slice(0, 200));
    } else {
      const test = run("node", ["--test", guard.test]);
      if (test.ok) fail("GUARD_CHECK_MUTATION_SURVIVED", guard.id, `${guard.test} still passes with the guard removed`);
      else checked.push(guard.id);
    }
  } finally {
    await writeFile(path, original);
    restored = sha256(await readFile(path, "utf8")) === originalDigest;
  }
  // Restoration is verified by digest, not assumed. A checker that leaves a mutated guard
  // behind is worse than no checker: it disarms the thing it was written to protect, and
  // the next gate to run would be judging bytes nobody chose.
  if (!restored) {
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: "GUARD_CHECK_RESTORE_FAILED", guardId: guard.id, file: guard.file, detail: "restore did not reproduce the original digest -- run `git checkout -- .` before trusting this tree" }, null, 2)}\n`);
    process.exit(1);
  }
}

// Leave the caller with a dist/ built from the real source, not from the last mutation.
run("pnpm", ["run", "--silent", "build"]);

const post = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
if (post.ok && post.output.trim() !== "") {
  fail("GUARD_CHECK_TREE_MUTATED", "(checker)", post.output.trim().split("\n").slice(0, 5).join(" | "));
}

if (findings.length > 0) {
  process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: "GUARD_CHECK_BLOCKED", killed: checked.length, findings }, null, 2)}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ ok: true, reasonCode: "GUARD_CHECK_VERIFIED", guards: checked.length, killed: checked })}\n`);
