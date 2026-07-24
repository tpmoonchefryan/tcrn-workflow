// SPDX-License-Identifier: Apache-2.0
//
// INIT-007 / S041: the spawn-guard host adapter's registration protocol. These
// exercise the file-level register/deregister/list/detect behavior the pure core
// tests cannot, including the review-hardened cases: --pgid validation (a NaN
// deregister must not silently keep everything), atomic append under concurrency,
// and self-healing over a corrupt registry line.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  appendRegistration,
  detectFromTable,
  listRegistrations,
  parseFlags,
  registryPath,
  removeRegistration,
  runCli,
  SpawnGuardError,
} from "../scripts/spawn-guard.mjs";

function reg(pgid, pattern = "yes", purpose = "cpu-stress") {
  return { pgid, pattern, purpose, spawnedAt: "2026-07-24T00:13:00Z" };
}

async function tempRegistry(context) {
  const dir = await mkdtemp(join(tmpdir(), "tcrn-spawn-guard-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  return resolve(dir, "registrations.jsonl");
}

test("spawn-guard: register appends and list round-trips", async (context) => {
  const path = await tempRegistry(context);
  await appendRegistration(path, reg(74045));
  await appendRegistration(path, reg(74417, "sleep", "dev-server"));
  const registrations = await listRegistrations(path);
  assert.equal(registrations.length, 2);
  assert.deepEqual(registrations.map((r) => r.pgid).sort((a, b) => a - b), [74045, 74417]);
});

test("spawn-guard: deregister removes exactly the pgid and self-heals a corrupt line", async (context) => {
  const path = await tempRegistry(context);
  await appendRegistration(path, reg(74045));
  await appendRegistration(path, reg(74417));
  // Simulate an externally-torn/corrupt line appended by a crash or a hand-edit.
  await writeFile(path, "this is not valid json\n", { flag: "a" });
  const remaining = await removeRegistration(path, 74045);
  assert.equal(remaining, 1, "the corrupt line is dropped, only 74417 kept");
  const registrations = await listRegistrations(path);
  assert.deepEqual(registrations.map((r) => r.pgid), [74417]);
  // The rewritten file is clean canonical JSONL — no corrupt line survives.
  assert.ok(!(await readFile(path, "utf8")).includes("not valid json"));
});

test("spawn-guard: a non-numeric --pgid is rejected, never a silent no-op", async () => {
  // The F4 regression: `deregister --pgid abc` used to coerce to NaN, keep every
  // line, and exit 0 — telling the caller cleanup happened when nothing was removed.
  await assert.rejects(
    runCli(["deregister", "--registry", "/tmp/does-not-matter.jsonl", "--pgid", "abc"]),
    (error) => error instanceof SpawnGuardError && /--pgid must be a positive integer/u.test(error.message),
  );
});

test("spawn-guard: concurrent appends do not lose a registration", async (context) => {
  const path = await tempRegistry(context);
  // O_APPEND of a sub-PIPE_BUF line is atomic; fire many at once and all survive.
  await Promise.all(Array.from({ length: 20 }, (_unused, index) => appendRegistration(path, reg(80000 + index))));
  const registrations = await listRegistrations(path);
  assert.equal(registrations.length, 20);
  assert.equal(new Set(registrations.map((r) => r.pgid)).size, 20);
});

test("spawn-guard: detectFromTable reports residue against a fixture process table", async (context) => {
  const path = await tempRegistry(context);
  await appendRegistration(path, reg(74045));
  const registryText = await readFile(path, "utf8");
  const table = "74048 74045 1 20.0 yes\n401 401 1 12.9 WindowServer\n";
  const report = detectFromTable(registryText, table, "2026-07-24T05:00:00Z");
  assert.equal(report.status, "residue-present");
  assert.equal(report.residueCount, 1);
  assert.equal(report.residue[0].pgid, 74045);
  // Clean once the group is gone.
  const clean = detectFromTable(registryText, "401 401 1 12.9 WindowServer\n", "2026-07-24T05:00:00Z");
  assert.equal(clean.status, "clean");
});

test("spawn-guard: registryPath derives the transient sibling of a workspace root", () => {
  const path = registryPath({ workspace: "/a/b/partition/workspace" });
  assert.equal(path, "/a/b/partition/transient/spawn-registry/registrations.jsonl");
  assert.throws(() => registryPath({}), (error) => error instanceof SpawnGuardError);
});

test("spawn-guard: parseFlags rejects a dangling flag", () => {
  assert.throws(() => parseFlags(["--pgid"]), (error) => error instanceof SpawnGuardError);
  assert.deepEqual(parseFlags(["--pgid", "10", "--pattern", "yes"]), { pgid: "10", pattern: "yes" });
});
