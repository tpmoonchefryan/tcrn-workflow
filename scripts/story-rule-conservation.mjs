// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RULE_REGISTRY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "policy/story-rule-conservation.json");
export const REQUIRED_SOURCES = Object.freeze([
  "docs/dispatch-readiness-convention.md",
  "TCRN-AOS/docs/reports/init-020/HANDOVER-2026-08-08-final-codex.md",
  "chain:cross-project:TCRN-CROSS-INC-108",
  "chain:cross-project:TCRN-CROSS-INC-117",
  ".claude/skills/tcrn-workflow-helper/references/workflow-operations.md",
  "tcrn-workflow-helper/skill/tcrn-workflow-helper/references/workflow-operations.md",
  "TCRN-AOS/deploy/aos-local-client/closeout-chain-proof.mjs",
  "scripts/closeout-verify.mjs",
  "scripts/dispatch-readiness-compliance.mjs",
  "tests/closeout-verify-dispositions.test.mjs",
  "tests/dispatch-readiness-compliance.test.mjs",
  "tests/story-scope-compliance.test.mjs",
]);

export function readStoryRuleRegistry(path = RULE_REGISTRY_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function verifyStoryRuleConservation(registry) {
  const problems = [];
  if (registry?.schemaVersion !== "tcrn.story-rule-conservation.v1") problems.push("schemaVersion must be tcrn.story-rule-conservation.v1");
  if (registry?.canonicalSource !== "docs/dispatch-readiness-convention.md") problems.push("canonicalSource must be docs/dispatch-readiness-convention.md");
  const allowed = new Set(registry?.dispositions ?? []);
  if (!["retained", "superseded-by-stricter", "deferred"].every((value) => allowed.has(value))) problems.push("registry must declare all supported dispositions");
  const inventory = Array.isArray(registry?.sourceInventory) ? registry.sourceInventory : [];
  const rules = Array.isArray(registry?.rules) ? registry.rules : [];
  const byId = new Map();
  for (const rule of rules) {
    if (rule === null || typeof rule !== "object") {
      problems.push("rules must contain objects");
      continue;
    }
    if (typeof rule.id !== "string" || rule.id.length === 0) problems.push("every rule needs an id");
    else if (byId.has(rule.id)) problems.push(`duplicate rule id ${rule.id}`);
    else byId.set(rule.id, rule);
    for (const field of ["source", "semantics", "landing", "enforcementHost", "positiveLeg", "redLeg"]) {
      if (typeof rule[field] !== "string" || rule[field].trim().length === 0) problems.push(`${rule.id ?? "<unknown>"} missing ${field}`);
    }
    if (!allowed.has(rule.disposition)) problems.push(`${rule.id ?? "<unknown>"} has unsupported disposition ${rule.disposition}`);
    if (rule.disposition === "deferred" && (typeof rule.reason !== "string" || typeof rule.timing !== "string" || typeof rule.owner !== "string")) {
      problems.push(`${rule.id ?? "<unknown>"} deferred rule needs reason, timing, and owner`);
    }
    if (rule.disposition === "superseded-by-stricter" && (typeof rule.strictnessProof !== "string" || rule.strictnessProof.trim().length === 0)) {
      problems.push(`${rule.id ?? "<unknown>"} superseded-by-stricter rule needs strictnessProof`);
    }
  }
  const referenced = new Set();
  const seenSources = new Set();
  for (const entry of inventory) {
    if (entry === null || typeof entry !== "object" || typeof entry.source !== "string") {
      problems.push("sourceInventory entries need source");
      continue;
    }
    if (seenSources.has(entry.source)) problems.push(`duplicate source inventory ${entry.source}`);
    seenSources.add(entry.source);
    if (!Array.isArray(entry.rules) || entry.rules.length === 0) problems.push(`${entry.source} has no mapped rules`);
    for (const id of entry.rules ?? []) {
      referenced.add(id);
      if (!byId.has(id)) problems.push(`${entry.source} maps unknown rule ${id}`);
    }
  }
  for (const source of REQUIRED_SOURCES) if (!seenSources.has(source)) problems.push(`required source missing from inventory: ${source}`);
  for (const id of byId.keys()) if (!referenced.has(id)) problems.push(`rule ${id} has no source inventory mapping`);
  return { ok: problems.length === 0, reasonCode: problems.length === 0 ? "STORY_RULE_CONSERVATION_VERIFIED" : "STORY_RULE_CONSERVATION_BROKEN", problems };
}

if (process.argv[1]?.endsWith("story-rule-conservation.mjs")) {
  const result = verifyStoryRuleConservation(readStoryRuleRegistry());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
