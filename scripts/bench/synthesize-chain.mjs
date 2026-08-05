#!/usr/bin/env node
// S12.1 — synthesize a scratch chain of N events through the engine's public CLI
// (TCRN-CROSS-STORY-142).
//
// Every event is produced by invoking the engine CLI verb it belongs to
// (init / project-create / work-create / work-transition); nothing here writes a
// byte inside the workspace. The chain is therefore engine-valid by construction
// — the same admission and graph checks the real chains get — and lives entirely
// in a disposable scratch root OUTSIDE any repository.
//
// Work hierarchy follows the engine's own parent-kind map: Initiative (parentless)
// → Epic(Initiative) → Story(Epic) → Subtask(Story). The event mix mimics a real
// governed chain: a project, one Initiative, a handful of Epics, `--events` Stories
// spread across the Epics, a tail of Subtasks, and a transition pass that moves a
// fraction of the Stories to active/done. Every mutating call chains
// `--expected-version` from the previous call's returned version (a CAS, not a guess).
//
// Usage:
//   node scripts/bench/synthesize-chain.mjs --events <n> [--base-dir <path>]
//     [--epics <k>] [--stories-per-epic <m>] [--transition-fraction <f>]
//
// Writes <base-dir>/synthesized-<n>.json with the workspace path and event count,
// which bench-replay.mjs reads. Default base-dir is the OS temp dir (never a repo).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = resolve(REPO_ROOT, "scripts/tcrn-workflow.mjs");

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const eventsTarget = Number.parseInt(argument("events") ?? "3000", 10);
const baseDir = resolve(argument("base-dir") ?? join(tmpdir(), "tcrn-s12-bench"));
const epicCount = Number.parseInt(argument("epics") ?? "6", 10);
const transitionFraction = Number.parseFloat(argument("transition-fraction") ?? "0.2");

if (!Number.isFinite(eventsTarget) || eventsTarget <= 0) {
  process.stderr.write("--events must be a positive integer\n");
  process.exit(2);
}

let tick = 0;
// One virtual second per event; rolls through minutes and hours so a 10k-event
// chain (≈2.8h of virtual time) never emits an invalid `00:60` timestamp.
const at = () => {
  const hours = Math.floor(tick / 3600);
  const minutes = Math.floor((tick % 3600) / 60);
  const seconds = tick % 60;
  tick += 1;
  return `2026-08-05T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}Z`;
};

function run(argv) {
  const result = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { json = null; }
  if (result.status !== 0 || json === null || json.reasonCode !== "WORKSPACE_COMMAND_COMPLETED") {
    process.stderr.write(`engine ${argv[0]} refused: ${JSON.stringify({ status: result.status, stdout: result.stdout.slice(0, 300), stderr: result.stderr.slice(0, 300) })}\n`);
    process.exit(1);
  }
  return json;
}

const workspaceName = `ws-${eventsTarget}`;
const wsDir = join(baseDir, workspaceName);
for (const root of ["workspace", "transient", "evidence-locator", "release-trust"]) {
  mkdirSync(join(wsDir, root), { recursive: true });
}
const workspace = join(wsDir, "workspace");

const startedAt = Date.now();

const init = run(["init", "--workspace", workspace, "--framework", REPO_ROOT,
  "--transient", join(wsDir, "transient"), "--evidence-locator", join(wsDir, "evidence-locator"),
  "--release-trust", join(wsDir, "release-trust"), "--external-key", `S12-SYNTH-${eventsTarget}`, "--at", at()]);
let version = init.version;

const project = run(["project-create", "--workspace", workspace, "--expected-version", String(version),
  "--at", at(), "--external-key", `S12-PROJECT-${eventsTarget}`, "--name", `S12 synthetic ${eventsTarget}`]);
version = project.version;
const projectId = project.record.id;

const initiative = run(["work-create", "--workspace", workspace, "--expected-version", String(version),
  "--at", at(), "--project-id", projectId, "--external-key", `S12-INITIATIVE-${eventsTarget}`, "--kind", "Initiative"]);
version = initiative.version;
const initiativeId = initiative.record.id;

const epics = [];
for (let e = 0; e < epicCount; e += 1) {
  const epic = run(["work-create", "--workspace", workspace, "--expected-version", String(version),
    "--at", at(), "--project-id", projectId, "--parent-id", initiativeId,
    "--external-key", `S12-EPIC-${eventsTarget}-${e}`, "--kind", "Epic"]);
  version = epic.version;
  epics.push(epic.record.id);
}

const stories = [];
for (let s = 0; s < eventsTarget; s += 1) {
  const epicId = epics[s % epics.length];
  const story = run(["work-create", "--workspace", workspace, "--expected-version", String(version),
    "--at", at(), "--project-id", projectId, "--parent-id", epicId,
    "--external-key", `S12-STORY-${eventsTarget}-${s}`, "--kind", "Story"]);
  version = story.version;
  stories.push(story.record.id);
}

// A small tail of Subtasks, then a transition pass over a fraction of the stories
// (planned → ready → active), which is what gives the chain its replay weight.
const subtaskTarget = Math.max(1, Math.floor(eventsTarget * 0.05));
const subtasks = [];
for (let t = 0; t < subtaskTarget; t += 1) {
  const storyId = stories[t % stories.length];
  const sub = run(["work-create", "--workspace", workspace, "--expected-version", String(version),
    "--at", at(), "--project-id", projectId, "--parent-id", storyId,
    "--external-key", `S12-SUB-${eventsTarget}-${t}`, "--kind", "Subtask"]);
  version = sub.version;
  subtasks.push(sub.record.id);
}

const transitionCount = Math.floor(stories.length * transitionFraction);
for (let t = 0; t < transitionCount; t += 1) {
  const id = stories[t];
  const ready = run(["work-transition", "--workspace", workspace, "--expected-version", String(version),
    "--at", at(), "--id", id, "--status", "ready"]);
  version = ready.version;
}

const summary = {
  schemaVersion: "tcrn.s12-synthesize.v1",
  ok: true,
  eventsTarget,
  workspace,
  baseDir,
  projectId,
  initiativeId,
  epics: epics.length,
  stories: stories.length,
  subtasks: subtasks.length,
  transitions: transitionCount,
  finalVersion: version,
  durationMs: Date.now() - startedAt
};
const outPath = join(baseDir, `synthesized-${eventsTarget}.json`);
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
