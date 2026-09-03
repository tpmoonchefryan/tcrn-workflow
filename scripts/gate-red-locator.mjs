// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-049 STORY-350 — locate contained gate failures on demand.

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const declarationPath = resolve(repositoryRoot, "scripts/policy/gate-containment.json");

function fail(reasonCode, detail) {
  const error = new Error(detail);
  error.reasonCode = reasonCode;
  throw error;
}

function groupsById(declaration) {
  if (declaration?.schemaVersion !== "tcrn.gate-containment.v1" || !Array.isArray(declaration.groups)) {
    fail("GATE_CONTAINMENT_INVALID", "schemaVersion or groups");
  }
  const groups = new Map();
  for (const group of declaration.groups) {
    if (!group || typeof group.id !== "string" || groups.has(group.id) || !Array.isArray(group.contains)) {
      fail("GATE_CONTAINMENT_INVALID", "duplicate or malformed group");
    }
    groups.set(group.id, group);
  }
  return groups;
}

export function containedGroupIds(declaration, rootId) {
  const groups = groupsById(declaration);
  if (!groups.has(rootId)) fail("GATE_CONTAINMENT_UNKNOWN_GROUP", rootId);
  const result = [];
  const visited = new Set();
  const active = new Set();
  function visit(id) {
    if (active.has(id)) fail("GATE_CONTAINMENT_CYCLE", id);
    const group = groups.get(id);
    if (!group) fail("GATE_CONTAINMENT_UNKNOWN_GROUP", id);
    active.add(id);
    for (const child of group.contains) {
      if (active.has(child)) fail("GATE_CONTAINMENT_CYCLE", child);
      if (visited.has(child)) continue;
      visited.add(child);
      result.push(child);
      visit(child);
    }
    active.delete(id);
  }
  visit(rootId);
  return result;
}

export function buildRedLocatorPlan(declaration, rootId) {
  const groups = groupsById(declaration);
  return containedGroupIds(declaration, rootId).map((id) => {
    const group = groups.get(id);
    return {
      id,
      command: group.command,
      cwd: group.cwd ?? null,
      executable: group.executable ?? null,
      argv: Array.isArray(group.argv) ? [...group.argv] : null,
    };
  });
}

function runCommand(spec) {
  if (spec.executable === null || spec.argv === null || spec.cwd === null) {
    return { ok: false, reasonCode: "GATE_LOCATOR_CHILD_UNEXECUTABLE", output: spec.id };
  }
  const result = spawnSync(spec.executable, spec.argv, {
    cwd: resolve(repositoryRoot, spec.cwd),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) return { ok: false, reasonCode: "GATE_LOCATOR_CHILD_SPAWN_FAILED", output: result.error.message };
  return {
    ok: result.status === 0,
    reasonCode: result.status === 0 ? "GATE_CHILD_GREEN" : "GATE_CHILD_RED",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-1_000),
  };
}

export async function locateContainedGates(declaration, rootId, { runner = runCommand } = {}) {
  const plan = buildRedLocatorPlan(declaration, rootId);
  const children = [];
  for (const spec of plan) {
    const result = await runner(spec);
    children.push({ id: spec.id, command: spec.command, ...result });
  }
  return {
    ok: children.every((child) => child.ok),
    reasonCode: "GATE_RED_LOCATED",
    gate: rootId,
    children,
  };
}

async function main() {
  const index = process.argv.indexOf("--gate");
  const rootId = index >= 0 ? process.argv[index + 1] : undefined;
  if (typeof rootId !== "string" || rootId.length === 0) fail("GATE_LOCATOR_GATE_REQUIRED", "use --gate <group-id>");
  const declaration = JSON.parse(await readFile(declarationPath, "utf8"));
  const result = await locateContainedGates(declaration, rootId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: error.reasonCode ?? "GATE_LOCATOR_INTERNAL_ERROR", error: error.message })}\n`);
    process.exitCode = 1;
  }
}
