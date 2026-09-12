#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-413 — phase-aware gate selection with containment-aware execution.
// This module plans work; it never turns a missing or failed result into a cache hit.

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildContainedExecutionPlan } from "./lib/push-gate-children.mjs";

export const FINAL_GATE_PLAN_VERSION = "tcrn.gate-execution-plan.v1";
export const FINAL_GATE_PHASES = Object.freeze(["candidate-final", "publication", "merge-sensitive"]);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultRosterPath = resolve(repositoryRoot, "../../platform-docs/acceptance-gate-groups.json");
const containmentPath = resolve(repositoryRoot, "scripts/policy/gate-containment.json");

function planError(reasonCode, detail) {
  const error = new Error(detail);
  error.reasonCode = reasonCode;
  return error;
}

function normalizeCommand(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function validateRoster(roster, containment) {
  if (!roster || !Array.isArray(roster.groups)) throw planError("GATE_PLAN_ROSTER_INVALID", "acceptance roster groups");
  const rosterGroups = new Map();
  for (const group of roster.groups) {
    if (!group || typeof group.id !== "string" || rosterGroups.has(group.id)) throw planError("GATE_PLAN_ROSTER_INVALID", "duplicate roster group");
    rosterGroups.set(group.id, group);
  }
  const contained = buildContainedExecutionPlan(containment);
  const containedGroups = new Map(contained.all.map((entry) => [entry.id, entry]));
  if (!Array.isArray(roster.topLevel) || JSON.stringify(roster.topLevel) !== JSON.stringify(contained.selected.map(({ id }) => id))) {
    throw planError("GATE_PLAN_ROOT_ORDER_DRIFT", "acceptance roster topLevel must match gate containment roots");
  }
  for (const rosterGroup of roster.groups) {
    const containedGroup = containedGroups.get(rosterGroup.id);
    if (!containedGroup) throw planError("GATE_PLAN_REQUIRED_GROUP_MISSING", rosterGroup.id);
    if (normalizeCommand(rosterGroup.command) !== normalizeCommand(containedGroup.command)) {
      throw planError("GATE_PLAN_COMMAND_DRIFT", `${rosterGroup.id}: ${normalizeCommand(rosterGroup.command)} != ${normalizeCommand(containedGroup.command)}`);
    }
    if (!Array.isArray(rosterGroup.contains)) throw planError("GATE_PLAN_ROSTER_CONTAINMENT_INVALID", `${rosterGroup.id}.contains`);
    for (const child of rosterGroup.contains) {
      if (!containedGroup.path.includes(child) && !contained.all.some((entry) => entry.id === child && entry.rootId === containedGroup.rootId && entry.path.includes(containedGroup.id))) {
        throw planError("GATE_PLAN_REQUIRED_EDGE_MISSING", `${rosterGroup.id}->${child}`);
      }
    }
  }
  for (const root of contained.selected) {
    const rosterGroup = rosterGroups.get(root.id);
    if (!rosterGroup) throw planError("GATE_PLAN_ROSTER_GROUP_MISSING", root.id);
    const containmentCommand = normalizeCommand(root.command);
    const rosterCommand = normalizeCommand(rosterGroup.command);
    if (containmentCommand !== rosterCommand) throw planError("GATE_PLAN_COMMAND_DRIFT", `${root.id}: ${containmentCommand} != ${rosterCommand}`);
  }
  return { contained, rosterGroups };
}

function inputKey(input) {
  return [input?.sourceDigest, input?.environmentDigest, input?.commandDigest, input?.baselineDigest]
    .map((value) => typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
}

/** A prior result is reusable only when every declared input and the result agree. */
export function assessEvidenceReuse({ evidence, inputs }) {
  const expected = inputKey(inputs);
  const actual = inputKey(evidence?.inputs);
  const missing = expected.map((value, index) => value === null || actual[index] === null).filter(Boolean).length;
  const reasons = [];
  if (typeof evidence?.id !== "string" || evidence.id.length === 0) reasons.push("evidence id missing");
  if (missing > 0) reasons.push("required input digest missing");
  if (JSON.stringify(expected) !== JSON.stringify(actual)) reasons.push("input digest changed");
  if (evidence?.ok !== true) reasons.push("previous result was not successful");
  if (evidence?.status !== undefined && evidence.status !== "completed") reasons.push("evidence is not terminal");
  const reusable = reasons.length === 0;
  return reusable
    ? { reusable: true, reused: [{ id: evidence.id, reason: "same source, environment, command, and baseline inputs" }], invalidated: [], blocked: [] }
    : { reusable: false, reused: [], invalidated: [{ id: evidence?.id ?? null, reasons }], blocked: [] };
}

const DEVELOPMENT_RULES = Object.freeze([
  { id: "docs", match: (path) => path.startsWith("docs/") || path.endsWith(".md"), checks: ["format-check", "links"] },
  { id: "portal", match: (path) => path.startsWith("portal/"), checks: ["portal"] },
  { id: "engine-source", match: (path) => path.startsWith("packages/") || path.startsWith("tests/"), checks: ["typecheck", "test"] },
  { id: "execution-controller", match: (path) => ["scripts/task.mjs", "scripts/test-controller-bootstrap.mjs", "scripts/test-controller-reaper.mjs"].includes(path), checks: ["typecheck", "test"] },
  { id: "gate-declaration", match: (path) => path === "scripts/policy/gate-containment.json" || path === "scripts/lib/push-gate-children.mjs", checks: ["p1-roster"] },
]);

// These are the commands registered by this repository. Keep the rule ids
// stable for changed-file selection, but never derive a package command by
// concatenating the rule id: `format-check` and `links` are policy names, while
// the package scripts are `format:check` and `verify:links`.
export const DEVELOPMENT_CHECK_COMMANDS = Object.freeze({
  "format-check": "pnpm format:check",
  links: "pnpm verify:links",
  portal: "pnpm verify:portal",
  typecheck: "pnpm typecheck",
  test: "pnpm test",
  "p1-roster": "node --test tests/p1-roster.test.mjs",
});

function registeredCommand(command) {
  const tokens = command.split(/\s+/u);
  if (tokens[0] === "pnpm") {
    const script = tokens[1] === "run" ? tokens[2] : tokens[1];
    let scripts;
    try { scripts = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")).scripts ?? {}; } catch { scripts = null; }
    return scripts !== null && typeof script === "string" && Object.hasOwn(scripts, script);
  }
  if (tokens[0] === "node" && tokens[1] === "--test") return tokens[2] !== undefined && existsSync(resolve(repositoryRoot, tokens[2]));
  return false;
}

function developmentCommand(check) {
  const command = DEVELOPMENT_CHECK_COMMANDS[check];
  if (command === undefined) throw planError("GATE_PLAN_DEVELOPMENT_COMMAND_UNREGISTERED", check);
  if (!registeredCommand(command)) throw planError("GATE_PLAN_DEVELOPMENT_COMMAND_UNREGISTERED", command);
  return command;
}

export function buildDevelopmentPlan({ changedFiles, previousEvidence = [], inputs = {} }) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { schemaVersion: FINAL_GATE_PLAN_VERSION, phase: "development", selected: [], executed: [], coveredBy: [], reused: [], invalidated: [], blocked: [{ id: null, reason: "changed file list is required" }] };
  }
  const normalized = [...new Set(changedFiles.map((path) => String(path).replaceAll("\\", "/").replace(/^\.\//u, "")).filter(Boolean))].sort();
  const selected = new Map();
  const blocked = [];
  for (const path of normalized) {
    const matches = DEVELOPMENT_RULES.filter((rule) => rule.match(path));
    if (matches.length === 0) {
      blocked.push({ id: path, reason: "unknown impact; typecheck and test must be chosen by the caller" });
      selected.set("typecheck", { id: "typecheck", command: developmentCommand("typecheck"), scriptExists: true, selected: true, coveredBy: null, reason: `fail-closed fallback for ${path}` });
      selected.set("test", { id: "test", command: developmentCommand("test"), scriptExists: true, selected: true, coveredBy: null, reason: `fail-closed fallback for ${path}` });
      continue;
    }
    for (const rule of matches) for (const check of rule.checks) selected.set(check, { id: check, command: developmentCommand(check), scriptExists: true, selected: true, coveredBy: null, reason: `changed file matched ${rule.id}` });
  }
  const prior = Array.isArray(previousEvidence) ? previousEvidence : previousEvidence ? [previousEvidence] : [];
  const evidence = prior.map((entry) => assessEvidenceReuse({ evidence: entry, inputs }));
  return {
    schemaVersion: FINAL_GATE_PLAN_VERSION,
    phase: "development",
    changedFiles: normalized,
    selected: [...selected.values()],
    executed: [],
    coveredBy: [],
    reused: evidence.flatMap((result) => result.reused),
    invalidated: evidence.flatMap((result) => result.invalidated),
    blocked: [...blocked, ...evidence.flatMap((result) => result.blocked)],
    execution: { strategy: "serial", maxConcurrent: 1 },
    executable: blocked.length === 0,
  };
}

export function buildFinalGatePlan({ roster, containment, phase = "candidate-final", inputs = {}, previousEvidence = [], readiness = {}, blockedDependencies = readiness.blockedDependencies, executionPermission = readiness.executionPermission, candidateReady = readiness.ready }) {
  if (!FINAL_GATE_PHASES.includes(phase)) throw planError("GATE_PLAN_PHASE_INVALID", phase);
  const { contained, rosterGroups } = validateRoster(roster, containment);
  const selected = contained.selected.map((entry) => ({ ...entry, command: rosterGroups.get(entry.id).command, phase }));
  const coveredBy = contained.coveredBy.map((entry) => ({ ...entry, phase }));
  const reuse = [];
  const invalidated = [];
  const blocked = [];
  const requiredInputs = inputKey(inputs);
  const inputNames = ["sourceDigest", "environmentDigest", "commandDigest", "baselineDigest"];
  const missingInputs = inputNames.filter((_name, index) => requiredInputs[index] === null);
  if (missingInputs.length > 0) blocked.push({ id: "candidate-inputs", reason: `missing candidate inputs: ${missingInputs.join(", ")}` });
  if (candidateReady === false) blocked.push({ id: "candidate-readiness", reason: "candidate is not ready" });
  if (blockedDependencies !== undefined && (!Array.isArray(blockedDependencies) || blockedDependencies.some((entry) => typeof entry !== "string" || entry.trim().length === 0))) {
    blocked.push({ id: "blocked-dependencies", reason: "blockedDependencies must be an array of non-empty strings" });
  } else if (Array.isArray(blockedDependencies) && blockedDependencies.length > 0) {
    blocked.push(...blockedDependencies.map((reason, index) => ({ id: `dependency-${index + 1}`, reason })));
  }
  if (executionPermission !== true) blocked.push({ id: "execution-permission", reason: "explicit candidate execution permission is required" });
  const prior = Array.isArray(previousEvidence) ? previousEvidence : previousEvidence ? [previousEvidence] : [];
  for (const evidence of prior) {
    const result = assessEvidenceReuse({ evidence, inputs });
    reuse.push(...result.reused);
    invalidated.push(...result.invalidated);
    blocked.push(...result.blocked);
  }
  return {
    schemaVersion: FINAL_GATE_PLAN_VERSION,
    phase,
    inputs,
    selected,
    executed: [],
    coveredBy,
    reused: reuse,
    invalidated,
    blocked,
    execution: { strategy: "serial", maxConcurrent: 1 },
    executionOrder: selected.map(({ id }) => id),
    executionPermission: blocked.length === 0 ? "granted" : "denied",
    executable: blocked.length === 0,
    rule: "execute selected top-level roots once; contained children are reported, not launched independently",
  };
}

export function recordExecution(plan, results) {
  if (plan?.executable !== true) throw planError("GATE_PLAN_NOT_EXECUTABLE", "plan has blocked prerequisites");
  const rows = Array.isArray(results) ? results : [];
  const selectedIds = new Set((plan?.selected ?? []).map((entry) => entry.id));
  const executedIds = rows.map((entry) => entry?.id).filter(Boolean);
  const duplicate = executedIds.find((id, index) => executedIds.indexOf(id) !== index);
  const unselected = executedIds.filter((id) => !selectedIds.has(id));
  const missing = [...selectedIds].filter((id) => !executedIds.includes(id));
  if (duplicate || unselected.length > 0 || missing.length > 0) throw planError("GATE_PLAN_EXECUTION_MISMATCH", JSON.stringify({ duplicate, unselected, missing }));
  return { ...plan, executed: rows.map((entry) => ({ ...entry, selected: true, coveredBy: null })) };
}

/** Execute only the selected roots, in declaration order, and retain measured rows. */
export async function executeSelectedRoots(plan, runner) {
  if (plan?.execution?.strategy !== "serial" || plan?.execution?.maxConcurrent !== 1) {
    throw planError("GATE_PLAN_SERIAL_POLICY_INVALID", "same-repository roots must execute serially");
  }
  if (typeof runner !== "function") throw planError("GATE_PLAN_RUNNER_REQUIRED", "a root runner is required");
  if (plan?.executable !== true || (plan?.blocked ?? []).length > 0) return { ...plan, executed: [] };
  const rows = [];
  const blocked = [...(plan.blocked ?? [])];
  for (const entry of plan.selected ?? []) {
    const startedAt = Date.now();
    let result;
    try {
      result = await runner(entry);
    } catch (error) {
      result = { ok: false, reasonCode: error.reasonCode ?? "GATE_ROOT_RUN_FAILED", error: error.message };
    }
    const row = {
      ...entry,
      ...(result && typeof result === "object" ? result : { ok: false, reasonCode: "GATE_ROOT_RESULT_INVALID" }),
      elapsedMs: Math.max(0, Date.now() - startedAt),
    };
    if (row.ok !== true) blocked.push({ id: entry.id, reason: row.reasonCode ?? "root execution failed" });
    rows.push(row);
  }
  return recordExecution({ ...plan, blocked }, rows);
}

export const executePlan = executeSelectedRoots;

async function main() {
  const phaseIndex = process.argv.indexOf("--phase");
  const phase = phaseIndex >= 0 ? process.argv[phaseIndex + 1] : "candidate-final";
  const rosterIndex = process.argv.indexOf("--roster");
  const rosterPath = rosterIndex >= 0 ? resolve(process.argv[rosterIndex + 1]) : defaultRosterPath;
  const changedIndex = process.argv.indexOf("--changed-files");
  const changedFiles = changedIndex >= 0 ? process.argv[changedIndex + 1].split(",") : [];
  const [roster, containment] = await Promise.all([JSON.parse(await readFile(rosterPath, "utf8")), JSON.parse(await readFile(containmentPath, "utf8"))]);
  const result = phase === "development"
    ? buildDevelopmentPlan({ changedFiles })
    : buildFinalGatePlan({ roster, containment, phase });
  process.stdout.write(`${JSON.stringify({ ok: true, reasonCode: "GATE_PLAN_READY", ...result })}\n`);
}

if (process.argv[1]?.endsWith("final-gate-plan.mjs")) {
  try { await main(); } catch (error) { process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: error.reasonCode ?? "GATE_PLAN_INTERNAL_ERROR", error: error.message })}\n`); process.exitCode = 1; }
}
