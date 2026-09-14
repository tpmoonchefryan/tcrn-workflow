// SPDX-License-Identifier: Apache-2.0

// The dispatch brief is deliberately a transport object, not a second work
// record. It carries the five pieces of execution equipment that a caller must
// provide at the moment it dispatches a Story. Keeping this validator outside
// the chain prevents execution detail from becoming append-only scope, while
// making the old "missing element means no dispatch" rule executable.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { validateStoryScope } from "./story-scope-compliance.mjs";

export const DISPATCH_BRIEF_FIELDS = Object.freeze([
  "redLineBoundaries",
  "filePointers",
  "verificationCommands",
  "chainCloseoutActions",
  "effectiveEvidenceCommands",
]);

export const DISPATCH_BRIEF_DECLARATIONS = Object.freeze({
  autonomousOperation: "你在自主运行。使用者不在实时观看，无法在任务中途回答问题，所以问「要我……吗？」「是否继续？」只会让工作停摆。原始请求已涵盖的可逆动作，直接做。只有破坏性动作与真正的范围变更才停下来交给使用者定。任务做完后提出后续建议可以；动手前先请示不行。",
  scopeRestraint: "在工作或测试中发现任务未提及的既有缺陷、性能问题或行为，不要在本次改动里修复、优化或扩展它，除非被要求的行为离开它无法工作；把它写进总结作为后续项。任务表述有歧义处，按其措辞与周边代码最直接支持的读法实现，在总结里写明这个假设，不要同时为另一种读法也建构。验证方式随你，草稿脚本与快速检查不必保留。只在任务要求、或本仓对这类改动本来就保留测试的地方提交测试，规模比照邻近测试文件，大致每条声明的行为一个聚焦测试；不要把草稿检查变成额外的永久测试文件。",
});

export const DISPATCH_BRIEF_DECLARATION_FIELDS = Object.freeze(Object.keys(DISPATCH_BRIEF_DECLARATIONS));

export const VERIFICATION_PHASES = Object.freeze([
  "development",
  "candidate-final",
  "publication",
  "merge-sensitive",
]);

// TCRN-CROSS-STORY-424: execution evidence is additive to the five dispatch
// elements above.  A brief remains a transport object, while this small
// declaration makes the lifetime of the transport's recipient explicit.  It
// deliberately does not try to authenticate a model or an actor: the
// collaboration tool input and the host turn context are the evidence sources,
// and the validator reports when those sources are unavailable instead of
// treating a prompt claim as identity.
export const AGENT_LIFECYCLE_SCHEMA_VERSION = "tcrn.agent-lifecycle.v1";
export const AGENT_LIFECYCLE_PHASES = Object.freeze(["task-pack", "rework", "decision", "acceptance", "clarification"]);
export const AGENT_LIFECYCLE_FRESH_PHASES = Object.freeze(["task-pack", "rework", "decision", "acceptance"]);
export const DISPATCH_LIFECYCLE_FIELDS = Object.freeze([
  "schemaVersion",
  "phase",
  "role",
  "pack",
  "model",
  "effort",
  "agentId",
  "newInstance",
  "forkTurns",
  "sameTaskRunning",
  "predecessor",
  "sourceEvidence",
]);
export const STRUCTURED_HANDOFF_SCHEMA_VERSION = "tcrn.structured-handoff.v1";

const LIFECYCLE_PHASE_ALIASES = Object.freeze({
  "epic-pack": "task-pack",
  "story-pack": "task-pack",
  "new-pack": "task-pack",
  "new-task": "task-pack",
  "new-instance": "task-pack",
  "rework-round": "rework",
  "decision-round": "decision",
  "acceptance-round": "acceptance",
  clarify: "clarification",
});

const LIFECYCLE_EVIDENCE_KINDS = Object.freeze([
  "artifact",
  "collaboration",
  "spawn_agent",
  "send_message",
  "turn_context",
  "telemetry",
  "rollout",
  "status",
  "work-show",
  // Accepted only so a negative fixture can name the tempting false proof;
  // `validateAgentLifecycleEvidence` never treats it as a fresh-instance fact.
  "compaction",
]);

const LIFECYCLE_STATUS_VALUES = Object.freeze(["verified", "unknown"]);
const TERMINAL_PREDECESSOR_STATUSES = Object.freeze(["done", "completed", "cancelled", "canceled", "blocked", "failed", "terminal", "closed", "succeeded", "success"]);

function lifecycleField(value, names) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const name of names) {
    if (Object.hasOwn(value, name)) return value[name];
  }
  return undefined;
}

const LIFECYCLE_FIELD_ALIASES = Object.freeze({
  workId: ["workId", "work_id", "taskId", "task_id", "workID"],
  phase: ["phase", "roundType", "lifecyclePhase"],
  role: ["role", "roleId"],
  pack: ["pack", "packId"],
  model: ["model", "requestedModel"],
  effort: ["effort", "reasoningEffort"],
  agentId: ["agentId", "agent_id", "childAgentId", "child_agent_id"],
  newInstance: ["newInstance", "new-instance"],
  forkTurns: ["forkTurns", "fork_turns", "fork-turns"],
  sameTaskRunning: ["sameTaskRunning", "same-task-running"],
  predecessor: ["predecessor", "previousAgent", "previous_agent"],
  sourceEvidence: ["sourceEvidence", "source-evidence", "evidence"],
});

function lifecycleOwns(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return LIFECYCLE_FIELD_ALIASES[field].some((name) => Object.hasOwn(value, name));
}

function lifecycleValue(value, field) {
  return lifecycleField(value, LIFECYCLE_FIELD_ALIASES[field]);
}

// Outer structured-handoff bindings are authoritative declarations.  Work is
// the only value intentionally propagated into a nested lifecycle: it keeps
// the identity intact at the envelope boundary without turning an outer
// declaration into an observed host fact.  Other fields remain explicit in
// both envelopes and are compared below.
function normalizeLifecycleDeclaration(value, { outerWorkId } = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  if (!lifecycleOwns(value, "workId") && typeof outerWorkId === "string") {
    return { ...value, workId: outerWorkId };
  }
  return value;
}

function lifecycleEvidenceEntries(value) {
  const raw = lifecycleValue(value, "sourceEvidence");
  return Array.isArray(raw) ? raw : undefined;
}

function evidenceDescriptor(entry) {
  if (typeof entry === "string") return { kind: null, locator: entry, digest: undefined, status: undefined };
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { kind: null, locator: null, digest: undefined, status: undefined };
  return {
    kind: lifecycleField(entry, ["kind", "source", "type"]),
    locator: lifecycleField(entry, ["locator", "path", "ref"]),
    digest: lifecycleField(entry, ["digest", "sha256", "sourceDigest"]),
    status: lifecycleField(entry, ["status", "evidenceStatus"]),
  };
}

function declarationBindingProblems(outer, inner, fieldPrefix = "structuredHandoff.lifecycle") {
  if (outer === null || typeof outer !== "object" || Array.isArray(outer) || inner === null || typeof inner !== "object" || Array.isArray(inner)) return [];
  const problems = [];
  for (const field of ["workId", "phase", "role", "pack", "model", "effort", "agentId", "newInstance", "forkTurns", "sameTaskRunning"]) {
    if (!lifecycleOwns(outer, field) || !lifecycleOwns(inner, field)) continue;
    const outerValue = field === "phase" ? lifecyclePhase(outer) : lifecycleValue(outer, field);
    const innerValue = field === "phase" ? lifecyclePhase(inner) : lifecycleValue(inner, field);
    if (outerValue !== innerValue) {
      problems.push({ field: `${fieldPrefix}.${field}`, message: `inner and outer ${field} declarations must agree`, code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
    }
  }
  if (lifecycleOwns(outer, "predecessor") && lifecycleOwns(inner, "predecessor")) {
    const outerPredecessor = lifecycleValue(outer, "predecessor");
    const innerPredecessor = lifecycleValue(inner, "predecessor");
    const outerId = lifecycleValue(outerPredecessor, "agentId");
    const innerId = lifecycleValue(innerPredecessor, "agentId");
    const outerStatus = lifecycleField(outerPredecessor, ["status", "state"]);
    const innerStatus = lifecycleField(innerPredecessor, ["status", "state"]);
    if (outerId !== innerId || outerStatus !== innerStatus) {
      problems.push({ field: `${fieldPrefix}.predecessor`, message: "inner and outer predecessor declarations must agree", code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
    }
  }
  const outerEvidence = lifecycleEvidenceEntries(outer);
  const innerEvidence = lifecycleEvidenceEntries(inner);
  if (outerEvidence !== undefined && innerEvidence !== undefined) {
    const outerByLocator = new Map();
    const innerByLocator = new Map();
    for (const entry of outerEvidence) {
      const descriptor = evidenceDescriptor(entry);
      if (typeof descriptor.locator === "string") outerByLocator.set(descriptor.locator, descriptor);
    }
    for (const entry of innerEvidence) {
      const descriptor = evidenceDescriptor(entry);
      if (typeof descriptor.locator === "string") innerByLocator.set(descriptor.locator, descriptor);
    }
    const locators = new Set([...outerByLocator.keys(), ...innerByLocator.keys()]);
    for (const locator of locators) {
      const outerEntry = outerByLocator.get(locator);
      const innerEntry = innerByLocator.get(locator);
      if (!outerEntry || !innerEntry) {
        problems.push({ field: `${fieldPrefix}.sourceEvidence`, message: `source evidence locator ${locator} must be present in both declarations`, code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
        continue;
      }
      if (outerEntry.kind !== null && innerEntry.kind !== null && outerEntry.kind !== innerEntry.kind) {
        problems.push({ field: `${fieldPrefix}.sourceEvidence`, message: `source evidence locator ${locator} has conflicting kinds`, code: "DISPATCH_HANDOFF_SOURCE_MISMATCH" });
      }
      if (outerEntry.digest !== innerEntry.digest) {
        problems.push({ field: `${fieldPrefix}.sourceEvidence`, message: `source evidence locator ${locator} has conflicting digests`, code: "DISPATCH_HANDOFF_SOURCE_DIGEST_MISMATCH" });
      }
      if (outerEntry.status !== undefined && innerEntry.status !== undefined && outerEntry.status !== innerEntry.status) {
        problems.push({ field: `${fieldPrefix}.sourceEvidence`, message: `source evidence locator ${locator} has conflicting statuses`, code: "DISPATCH_HANDOFF_SOURCE_MISMATCH" });
      }
    }
  }
  return problems;
}

function lifecycleText(value, field, maximum = 512) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    return { field, message: `${field} must be non-empty bounded text`, code: "DISPATCH_LIFECYCLE_FIELD_INVALID" };
  }
  return null;
}

function lifecycleBoolean(value, field) {
  return typeof value === "boolean"
    ? null
    : { field, message: `${field} must be an explicit boolean`, code: "DISPATCH_LIFECYCLE_FIELD_INVALID" };
}

function lifecycleDigest(value, field) {
  if (value === undefined || value === null || value === "unknown") return null;
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
    ? null
    : { field, message: `${field} must be a lowercase SHA-256 digest or explicit unknown`, code: "DISPATCH_LIFECYCLE_EVIDENCE_INVALID" };
}

function lifecycleEvidenceProblems(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      problems: [{ field: "agentLifecycle.sourceEvidence", message: "sourceEvidence must be a non-empty list", code: "DISPATCH_LIFECYCLE_EVIDENCE_REQUIRED" }],
      status: "unknown",
      count: 0,
    };
  }
  const problems = [];
  let unknown = 0;
  for (const [index, entry] of entries.entries()) {
    const field = `agentLifecycle.sourceEvidence[${index}]`;
    // String locators are retained for compatibility with small handoff notes,
    // but cannot prove anything by themselves.  They are therefore explicitly
    // reported as unknown rather than promoted to a green fact.
    if (typeof entry === "string") {
      if (entry.trim().length === 0 || entry.length > 1_024) {
        problems.push({ field, message: "a source-evidence locator must be non-empty bounded text", code: "DISPATCH_LIFECYCLE_EVIDENCE_INVALID" });
      } else {
        unknown += 1;
      }
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push({ field, message: "a source-evidence entry must be an object or locator", code: "DISPATCH_LIFECYCLE_EVIDENCE_INVALID" });
      continue;
    }
    const kind = lifecycleField(entry, ["kind", "source", "type"]);
    const locator = lifecycleField(entry, ["locator", "path", "ref"]);
    const digest = lifecycleField(entry, ["digest", "sha256", "sourceDigest"]);
    const status = lifecycleField(entry, ["status", "evidenceStatus"]);
    const kindProblem = lifecycleText(kind, `${field}.kind`, 128);
    const locatorProblem = lifecycleText(locator, `${field}.locator`, 1_024);
    if (kindProblem) problems.push(kindProblem);
    if (locatorProblem) problems.push(locatorProblem);
    if (typeof kind === "string" && !LIFECYCLE_EVIDENCE_KINDS.includes(kind) && !/^unknown(?:[-_].*)?$/u.test(kind)) {
      problems.push({ field: `${field}.kind`, message: `kind must identify a real tool/artifact source (${LIFECYCLE_EVIDENCE_KINDS.join(", ")})`, code: "DISPATCH_LIFECYCLE_EVIDENCE_INVALID" });
    }
    if (typeof kind === "string" && /prompt|self[-_ ]?assert|claim/u.test(kind)) {
      problems.push({ field: `${field}.kind`, message: "prompt self-claims cannot be source evidence", code: "DISPATCH_LIFECYCLE_PROMPT_CLAIM_REJECTED" });
    }
    if (typeof locator === "string" && /prompt|self[-_ ]?assert|claim/u.test(locator)) {
      problems.push({ field: `${field}.locator`, message: "prompt self-claims cannot be source evidence", code: "DISPATCH_LIFECYCLE_PROMPT_CLAIM_REJECTED" });
    }
    const digestProblem = lifecycleDigest(digest, `${field}.digest`);
    if (digestProblem) problems.push(digestProblem);
    if (status !== undefined && !LIFECYCLE_STATUS_VALUES.includes(status)) {
      problems.push({ field: `${field}.status`, message: "status must be verified or unknown", code: "DISPATCH_LIFECYCLE_EVIDENCE_INVALID" });
    }
    if (!(typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest) && status !== "unknown")) unknown += 1;
  }
  return { problems, status: problems.length > 0 || unknown > 0 ? "unknown" : "verified", count: entries.length };
}

function lifecyclePhase(value) {
  const raw = lifecycleField(value, ["phase", "roundType", "lifecyclePhase"]);
  if (typeof raw !== "string") return raw;
  return LIFECYCLE_PHASE_ALIASES[raw] ?? raw;
}

/**
 * Validate the additive lifecycle declaration carried by a new dispatch
 * brief.  This is intentionally a shape-and-consistency check, not an
 * identity service.  `sourceEvidence.status === "unknown"` is a valid,
 * explicit answer when the host does not expose a digest; callers must not
 * render that as proof of a fresh instance.
 */
export function validateAgentLifecycle(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      checked: true,
      reasonCode: "DISPATCH_LIFECYCLE_REQUIRED",
      problems: [{ field: "agentLifecycle", message: "agentLifecycle must be an object", code: "DISPATCH_LIFECYCLE_REQUIRED" }],
      sourceEvidence: { status: "unknown", count: 0 },
    };
  }
  const problems = [];
  if (value.schemaVersion !== undefined && value.schemaVersion !== AGENT_LIFECYCLE_SCHEMA_VERSION) {
    problems.push({ field: "agentLifecycle.schemaVersion", message: `schemaVersion must be ${AGENT_LIFECYCLE_SCHEMA_VERSION}`, code: "DISPATCH_LIFECYCLE_SCHEMA_INVALID" });
  }
  const phase = lifecyclePhase(value);
  if (!AGENT_LIFECYCLE_PHASES.includes(phase)) {
    problems.push({ field: "agentLifecycle.phase", message: `phase must be one of ${AGENT_LIFECYCLE_PHASES.join(", ")}`, code: "DISPATCH_LIFECYCLE_PHASE_INVALID" });
  }
  if (AGENT_LIFECYCLE_FRESH_PHASES.includes(phase) && value.schemaVersion !== AGENT_LIFECYCLE_SCHEMA_VERSION) {
    problems.push({ field: "agentLifecycle.schemaVersion", message: `fresh lifecycle rounds require ${AGENT_LIFECYCLE_SCHEMA_VERSION}`, code: "DISPATCH_LIFECYCLE_SCHEMA_INVALID" });
  }
  const role = lifecycleField(value, ["role", "roleId"]);
  const pack = lifecycleField(value, ["pack", "packId"]);
  const model = lifecycleField(value, ["model", "requestedModel"]);
  const effort = lifecycleField(value, ["effort", "reasoningEffort"]);
  const requiredTextFields = AGENT_LIFECYCLE_FRESH_PHASES.includes(phase) || !AGENT_LIFECYCLE_PHASES.includes(phase)
    ? [["role", role], ["pack", pack], ["model", model], ["effort", effort]]
    : [["role", role], ["pack", pack]];
  for (const [field, candidate] of requiredTextFields) {
    const problem = lifecycleText(candidate, `agentLifecycle.${field}`);
    if (problem) problems.push(problem);
  }
  for (const [field, candidate] of [["model", model], ["effort", effort]]) {
    if (!AGENT_LIFECYCLE_FRESH_PHASES.includes(phase) && AGENT_LIFECYCLE_PHASES.includes(phase) && candidate !== undefined) {
      const problem = lifecycleText(candidate, `agentLifecycle.${field}`);
      if (problem) problems.push(problem);
    }
  }
  const newInstance = lifecycleField(value, ["newInstance", "new-instance"]);
  const forkTurns = lifecycleField(value, ["forkTurns", "fork_turns", "fork-turns"]);
  const sameTaskRunning = lifecycleField(value, ["sameTaskRunning", "same-task-running"]);
  const newProblem = lifecycleBoolean(newInstance, "agentLifecycle.newInstance");
  if (newProblem) problems.push(newProblem);
  const sameProblem = sameTaskRunning === undefined ? null : lifecycleBoolean(sameTaskRunning, "agentLifecycle.sameTaskRunning");
  if (sameProblem) problems.push(sameProblem);
  if (forkTurns !== undefined && forkTurns !== "none") {
    problems.push({ field: "agentLifecycle.forkTurns", message: "forkTurns must be the explicit value none", code: "DISPATCH_LIFECYCLE_FORK_FORBIDDEN" });
  }
  if (AGENT_LIFECYCLE_FRESH_PHASES.includes(phase)) {
    if (newInstance !== true) problems.push({ field: "agentLifecycle.newInstance", message: "fresh task-pack/rework/decision/acceptance rounds require newInstance=true", code: "DISPATCH_LIFECYCLE_NEW_INSTANCE_REQUIRED" });
    if (forkTurns !== "none") problems.push({ field: "agentLifecycle.forkTurns", message: "fresh rounds require forkTurns=none; inherited history is forbidden", code: "DISPATCH_LIFECYCLE_FORK_NONE_REQUIRED" });
    if (sameTaskRunning === true) problems.push({ field: "agentLifecycle.sameTaskRunning", message: "a running bounded task may be clarified, but a cross-round dispatch cannot reuse it", code: "DISPATCH_LIFECYCLE_RUNNING_TASK_REQUIRES_CLARIFICATION" });
  }
  if (phase === "clarification") {
    if (sameTaskRunning !== true) problems.push({ field: "agentLifecycle.sameTaskRunning", message: "clarification requires an explicit sameTaskRunning=true", code: "DISPATCH_LIFECYCLE_CLARIFICATION_BINDING_REQUIRED" });
    if (newInstance !== false) problems.push({ field: "agentLifecycle.newInstance", message: "same-task clarification must keep newInstance=false", code: "DISPATCH_LIFECYCLE_CLARIFICATION_RESTART_REJECTED" });
  }
  const workId = lifecycleValue(value, "workId");
  if (workId !== undefined) {
    const workProblem = lifecycleText(workId, "agentLifecycle.workId", 256);
    if (workProblem) problems.push(workProblem);
  }
  const agentId = lifecycleValue(value, "agentId");
  if (agentId !== undefined) {
    const problem = lifecycleText(agentId, "agentLifecycle.agentId", 256);
    if (problem) problems.push(problem);
  }
  const predecessor = lifecycleValue(value, "predecessor");
  let predecessorResult = null;
  if (predecessor !== undefined) {
    if (predecessor === null || typeof predecessor !== "object" || Array.isArray(predecessor)) {
      problems.push({ field: "agentLifecycle.predecessor", message: "predecessor must be an object when supplied", code: "DISPATCH_LIFECYCLE_PREDECESSOR_INVALID" });
    } else {
      const previousId = lifecycleField(predecessor, ["agentId", "agent_id", "id"]);
      const previousStatus = lifecycleField(predecessor, ["status", "state"]);
      const idProblem = lifecycleText(previousId, "agentLifecycle.predecessor.agentId", 256);
      if (idProblem) problems.push(idProblem);
      const statusProblem = lifecycleText(previousStatus, "agentLifecycle.predecessor.status", 128);
      if (statusProblem) problems.push(statusProblem);
      if (typeof agentId === "string" && typeof previousId === "string" && agentId === previousId) {
        problems.push({ field: "agentLifecycle.agentId", message: "a new round cannot reuse its predecessor agentId", code: "DISPATCH_LIFECYCLE_AGENT_REUSED" });
      }
      if (AGENT_LIFECYCLE_FRESH_PHASES.includes(phase) && typeof previousStatus === "string" && ["running", "active", "in-progress"].includes(previousStatus)) {
        problems.push({ field: "agentLifecycle.predecessor.status", message: "a running predecessor is same-task clarification scope, not a new round", code: "DISPATCH_LIFECYCLE_RUNNING_PREDECESSOR" });
      }
      predecessorResult = {
        agentId: typeof previousId === "string" ? previousId : null,
        status: typeof previousStatus === "string" ? previousStatus : null,
      };
    }
  }
  const evidence = lifecycleField(value, ["sourceEvidence", "source-evidence", "evidence"]);
  const sourceEvidence = lifecycleEvidenceProblems(evidence);
  problems.push(...sourceEvidence.problems);
  return {
    ok: problems.length === 0,
    checked: true,
    reasonCode: problems.length === 0
      ? (sourceEvidence.status === "verified" ? "DISPATCH_LIFECYCLE_VALID" : "DISPATCH_LIFECYCLE_VALID_EVIDENCE_UNKNOWN")
      : "DISPATCH_LIFECYCLE_INVALID",
    phase,
    freshRound: AGENT_LIFECYCLE_FRESH_PHASES.includes(phase),
    role: typeof role === "string" ? role : null,
    pack: typeof pack === "string" ? pack : null,
    model: typeof model === "string" ? model : null,
    effort: typeof effort === "string" ? effort : null,
    workId: typeof workId === "string" ? workId : null,
    agentId: typeof agentId === "string" ? agentId : null,
    newInstance: typeof newInstance === "boolean" ? newInstance : null,
    forkTurns: typeof forkTurns === "string" ? forkTurns : null,
    sameTaskRunning: typeof sameTaskRunning === "boolean" ? sameTaskRunning : null,
    predecessor: predecessorResult,
    sourceEvidence: { status: sourceEvidence.status, count: sourceEvidence.count },
    sourceEvidenceEntries: Array.isArray(evidence) ? evidence : null,
    problems,
  };
}

/**
 * Validate the structured handoff envelope used by dispatch callers.  It is
 * optional for historical briefs; when present it binds the lifecycle to one
 * work id and checks that the duplicated role/Pack labels agree.
 */
export function validateStructuredHandoff(value) {
  if (value === undefined) return { checked: false, ok: true, reasonCode: "DISPATCH_HANDOFF_NOT_DECLARED", problems: [] };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { checked: true, ok: false, reasonCode: "DISPATCH_HANDOFF_INVALID", problems: [{ field: "structuredHandoff", message: "structuredHandoff must be an object", code: "DISPATCH_HANDOFF_REQUIRED" }] };
  }
  const problems = [];
  if (value.schemaVersion !== STRUCTURED_HANDOFF_SCHEMA_VERSION) problems.push({ field: "structuredHandoff.schemaVersion", message: `schemaVersion must be ${STRUCTURED_HANDOFF_SCHEMA_VERSION}`, code: "DISPATCH_HANDOFF_SCHEMA_INVALID" });
  for (const field of ["workId", "role", "pack"]) {
    const problem = lifecycleText(value[field], `structuredHandoff.${field}`);
    if (problem) problems.push(problem);
  }
  const lifecycle = value.lifecycle ?? value.agentLifecycle;
  // Preserve the authoritative outer work binding at the nested boundary.  A
  // missing nested work id is filled for declaration validation, but observed
  // evidence comparison still sees the original omission as unknown.
  const normalizedLifecycle = normalizeLifecycleDeclaration(lifecycle, { outerWorkId: value.workId });
  const lifecycleResult = validateAgentLifecycle(normalizedLifecycle);
  if (!lifecycleResult.ok) problems.push(...lifecycleResult.problems.map((problem) => ({ ...problem, field: `structuredHandoff.${problem.field.replace(/^agentLifecycle\.?/u, "lifecycle.")}` })));
  if (typeof value.role === "string" && typeof lifecycleResult.role === "string" && value.role !== lifecycleResult.role) problems.push({ field: "structuredHandoff.role", message: "handoff role must match agentLifecycle.role", code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
  if (typeof value.pack === "string" && typeof lifecycleResult.pack === "string" && value.pack !== lifecycleResult.pack) problems.push({ field: "structuredHandoff.pack", message: "handoff pack must match agentLifecycle.pack", code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
  if (lifecycle !== undefined && lifecycle !== null && typeof lifecycle === "object" && !Array.isArray(lifecycle)) {
    problems.push(...declarationBindingProblems(value, lifecycle));
  }
  return {
    checked: true,
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? "DISPATCH_HANDOFF_VALID" : "DISPATCH_HANDOFF_INVALID",
    workId: typeof value.workId === "string" ? value.workId : lifecycleResult.workId,
    role: typeof value.role === "string" ? value.role : null,
    pack: typeof value.pack === "string" ? value.pack : null,
    lifecycle: lifecycleResult,
    problems,
  };
}

function evidenceEntries(value) {
  const entries = lifecycleField(value, ["sourceEvidence", "source-evidence", "evidence"]);
  return Array.isArray(entries) ? entries : [];
}

function evidenceKind(entry) {
  if (typeof entry === "string") return entry.toLowerCase().includes("compaction") ? "compaction" : null;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const kind = lifecycleField(entry, ["kind", "source", "type"]);
  return typeof kind === "string" ? kind : null;
}

function lifecycleBindingProblems(expected, actual, fieldPrefix = "observedLifecycle") {
  const problems = [];
  if (!expected || !actual) return problems;
  for (const field of ["workId", "phase", "role", "pack", "model", "effort", "newInstance", "forkTurns", "sameTaskRunning"]) {
    const expectedValue = expected[field];
    const actualValue = actual[field];
    if (expectedValue !== null && expectedValue !== undefined && actualValue !== null && actualValue !== undefined && expectedValue !== actualValue) {
      problems.push({ field: `${fieldPrefix}.${field}`, message: `observed ${field} does not match the authoritative handoff`, code: "DISPATCH_LIFECYCLE_BINDING_MISMATCH" });
    }
  }
  // A required declaration must not be silently omitted from the duplicated
  // envelope.  Missing host observations are handled by the evidence comparator
  // as unknown; a handoff envelope is a declaration and must agree in full.
  const fresh = AGENT_LIFECYCLE_FRESH_PHASES.includes(expected.phase);
  for (const field of fresh ? ["phase", "role", "pack", "model", "effort", "newInstance", "forkTurns"] : ["phase", "role", "pack", "newInstance", "sameTaskRunning"]) {
    if (expected[field] !== null && expected[field] !== undefined && (actual[field] === null || actual[field] === undefined)) {
      problems.push({ field: `${fieldPrefix}.${field}`, message: `handoff omitted authoritative ${field}`, code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
    }
  }
  if (expected.sourceEvidence.status !== actual.sourceEvidence.status) {
    problems.push({ field: `${fieldPrefix}.sourceEvidence`, message: "handoff source evidence status must match the authoritative lifecycle", code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
  }
  if (expected.sourceEvidence.count > 0 && actual.sourceEvidence.count === 0) {
    problems.push({ field: `${fieldPrefix}.sourceEvidence`, message: "handoff omitted authoritative source evidence", code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
  }
  if (expected.predecessor !== null) {
    if (actual.predecessor === null) {
      problems.push({ field: `${fieldPrefix}.predecessor`, message: "handoff omitted the authoritative predecessor", code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
    } else {
      for (const field of ["agentId", "status"]) {
        if (expected.predecessor[field] !== actual.predecessor[field]) {
          problems.push({ field: `${fieldPrefix}.predecessor.${field}`, message: `handoff predecessor ${field} does not match the authoritative lifecycle`, code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
        }
      }
    }
  }
  if (expected.agentId !== null && actual.agentId !== null && expected.agentId !== actual.agentId) {
    problems.push({ field: `${fieldPrefix}.agentId`, message: "handoff agentId does not match the authoritative lifecycle", code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
  }
  if (expected.agentId !== null && expected.agentId !== undefined && (actual.agentId === null || actual.agentId === undefined)) {
    problems.push({ field: `${fieldPrefix}.agentId`, message: "handoff omitted authoritative agentId", code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
  }
  const expectedEvidence = expected.sourceEvidenceEntries;
  const actualEvidence = actual.sourceEvidenceEntries;
  if (Array.isArray(expectedEvidence) && Array.isArray(actualEvidence)) {
    problems.push(...declarationBindingProblems({ sourceEvidence: expectedEvidence }, { sourceEvidence: actualEvidence }, `${fieldPrefix}`));
  } else if (Array.isArray(expectedEvidence) !== Array.isArray(actualEvidence)) {
    problems.push({ field: `${fieldPrefix}.sourceEvidence`, message: "handoff omitted authoritative source evidence", code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
  }
  return problems;
}

function terminalStatus(value) {
  return typeof value === "string" && TERMINAL_PREDECESSOR_STATUSES.includes(value.trim().toLowerCase());
}

function lifecycleEnvelope(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { lifecycle: value, outer: undefined };
  const structured = lifecycleField(value, ["structuredHandoff"]);
  if (structured !== undefined && structured !== null && typeof structured === "object" && !Array.isArray(structured)) {
    const nested = structured.lifecycle ?? structured.agentLifecycle;
    return { lifecycle: nested ?? structured, outer: structured };
  }
  const nested = value.agentLifecycle ?? value.lifecycle;
  if (nested !== undefined && nested !== null && typeof nested === "object" && !Array.isArray(nested)) return { lifecycle: nested, outer: value };
  return { lifecycle: value, outer: undefined };
}

function lifecycleObservationMissing(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return true;
  const names = LIFECYCLE_FIELD_ALIASES[field] ?? [];
  const present = names.find((name) => Object.hasOwn(value, name));
  if (present === undefined) return true;
  return value[present] === undefined || value[present] === null;
}

function lifecycleObservedShapeProblemIsMissing(problem, value) {
  const field = problem.field?.replace(/^agentLifecycle\./u, "");
  if (!field || !["phase", "role", "pack", "model", "effort", "newInstance", "forkTurns", "sameTaskRunning", "workId"].includes(field)) return false;
  return lifecycleObservationMissing(value, field);
}

/**
 * Compare a declared lifecycle with an observed dispatch envelope.  This is
 * the narrow bridge from the shape validator to real tool/turn evidence.  It
 * returns `unknown` when a host did not expose enough facts; it never turns a
 * task id, compaction marker, or model self-description into a new instance.
 */
export function validateAgentLifecycleEvidence(declared, observed) {
  const declaredEnvelope = lifecycleEnvelope(declared);
  const declaredOuterWorkId = lifecycleValue(declaredEnvelope.outer, "workId");
  const declaredInput = normalizeLifecycleDeclaration(declaredEnvelope.lifecycle, { outerWorkId: declaredOuterWorkId });
  const declaredResult = validateAgentLifecycle(declaredInput);
  const problems = [...declaredResult.problems];
  const unknownReasons = [];
  if (declaredEnvelope.outer && declaredEnvelope.lifecycle && declaredEnvelope.outer !== declaredEnvelope.lifecycle) {
    problems.push(...declarationBindingProblems(declaredEnvelope.outer, declaredEnvelope.lifecycle));
  }
  if (observed === null || typeof observed !== "object" || Array.isArray(observed)) {
    return { ok: false, status: "unknown", reasonCode: "DISPATCH_LIFECYCLE_EVIDENCE_MISSING", problems: [{ field: "observedLifecycle", message: "observed tool/turn evidence is unavailable", code: "DISPATCH_LIFECYCLE_EVIDENCE_MISSING" }, ...problems] };
  }
  const observedEnvelope = lifecycleEnvelope(observed);
  const observedInput = normalizeLifecycleDeclaration(observedEnvelope.lifecycle, { outerWorkId: lifecycleValue(observedEnvelope.outer, "workId") });
  const observedResult = validateAgentLifecycle(observedInput);
  // Missing observed fields are not declaration violations.  Preserve them as
  // structured unknowns so a host that omits model/effort/fork/source facts
  // cannot crash this comparator or accidentally pass as verified.  Explicit
  // malformed values and contradictions remain red.
  for (const problem of observedResult.problems) {
    if (problem.code === "DISPATCH_LIFECYCLE_EVIDENCE_REQUIRED") {
      unknownReasons.push({ field: "observedLifecycle.sourceEvidence", message: "observed lifecycle did not expose source evidence", code: "DISPATCH_LIFECYCLE_SOURCE_EVIDENCE_MISSING" });
    } else if (lifecycleObservedShapeProblemIsMissing(problem, observedInput)) {
      unknownReasons.push({ field: problem.field.replace(/^agentLifecycle/u, "observedLifecycle"), message: `observed lifecycle did not expose ${problem.field.replace(/^agentLifecycle\./u, "")}`, code: "DISPATCH_LIFECYCLE_FACT_MISSING" });
    } else {
      problems.push(problem);
    }
  }
  const declaredPhase = declaredResult.phase;
  const observedAgentId = lifecycleValue(observedInput, "agentId");
  const declaredWorkId = declaredResult.workId;
  const observedWorkId = lifecycleValue(observedInput, "workId");
  const observedTaskId = lifecycleField(observedInput, ["taskId", "task_id"]);
  const observedEvidence = evidenceEntries(observedInput);
  const observedKinds = new Set(observedEvidence.map(evidenceKind).filter((value) => value !== null));
  if (typeof declaredWorkId === "string" && typeof observedWorkId === "string" && declaredWorkId !== observedWorkId) {
    problems.push({ field: "observedLifecycle.workId", message: "observed work/task id does not match the declared handoff", code: "DISPATCH_LIFECYCLE_WORK_BINDING_MISMATCH" });
  } else if (typeof declaredWorkId === "string" && (observedWorkId === undefined || observedWorkId === null)) {
    unknownReasons.push({ field: "observedLifecycle.workId", message: "observed lifecycle did not expose the declared work/task id", code: "DISPATCH_LIFECYCLE_WORK_ID_MISSING" });
  }
  if (AGENT_LIFECYCLE_FRESH_PHASES.includes(declaredPhase)) {
    if (typeof observedAgentId !== "string" || observedAgentId.trim().length === 0) {
      if (typeof observedTaskId === "string") {
        problems.push({ field: "observedLifecycle.agentId", message: "an old task/work id alone is not a new agent instance", code: "DISPATCH_LIFECYCLE_OLD_TASK_ID_ONLY" });
      } else {
        unknownReasons.push({ field: "observedLifecycle.agentId", message: "fresh round did not expose an observed agentId", code: "DISPATCH_LIFECYCLE_AGENT_ID_MISSING" });
      }
    }
    if (typeof observedAgentId === "string" && declaredResult.predecessor?.agentId && observedAgentId === declaredResult.predecessor.agentId) {
      problems.push({ field: "observedLifecycle.agentId", message: "a terminal predecessor cannot be reused as the fresh agent instance", code: "DISPATCH_LIFECYCLE_TERMINAL_PREDECESSOR_REUSED" });
    }
    if (typeof observedAgentId === "string" && observedResult.predecessor !== null && observedResult.predecessor.agentId === observedAgentId && terminalStatus(observedResult.predecessor.status)) {
      problems.push({ field: "observedLifecycle.agentId", message: "observed terminal predecessor cannot be treated as the fresh agent instance", code: "DISPATCH_LIFECYCLE_TERMINAL_PREDECESSOR_REUSED" });
    }
    if (declaredResult.predecessor !== null) {
      if (observedResult.predecessor === null) {
        unknownReasons.push({ field: "observedLifecycle.predecessor", message: "fresh observation did not retain the declared predecessor binding", code: "DISPATCH_LIFECYCLE_PREDECESSOR_MISSING" });
      } else {
        for (const field of ["agentId", "status"]) {
          if (declaredResult.predecessor[field] !== observedResult.predecessor[field]) {
            problems.push({ field: `observedLifecycle.predecessor.${field}`, message: `observed predecessor ${field} does not match the declaration`, code: "DISPATCH_LIFECYCLE_PREDECESSOR_MISMATCH" });
          }
        }
      }
    }
    if (observedKinds.has("compaction") && !observedKinds.has("spawn_agent")) {
      problems.push({ field: "observedLifecycle.sourceEvidence", message: "compaction is not a new agent instance", code: "DISPATCH_LIFECYCLE_COMPACTION_NOT_INSTANCE" });
    }
    if (!observedKinds.has("spawn_agent")) {
      unknownReasons.push({ field: "observedLifecycle.sourceEvidence", message: "fresh round did not expose the real spawn tool input", code: "DISPATCH_LIFECYCLE_SPAWN_EVIDENCE_MISSING" });
    }
    if (!observedKinds.has("turn_context")) {
      unknownReasons.push({ field: "observedLifecycle.sourceEvidence", message: "fresh round did not expose a child turn_context", code: "DISPATCH_LIFECYCLE_TURN_CONTEXT_MISSING" });
    }
  }
  if (declaredPhase === "clarification") {
    if (observedResult.newInstance !== null && observedResult.newInstance !== false) {
      problems.push({ field: "observedLifecycle", message: "clarification must remain same-task and must not restart the instance", code: "DISPATCH_LIFECYCLE_CLARIFICATION_RESTART_REJECTED" });
    }
    if (observedResult.sameTaskRunning !== null && observedResult.sameTaskRunning !== true) {
      problems.push({ field: "observedLifecycle.sameTaskRunning", message: "clarification must remain bound to a running task", code: "DISPATCH_LIFECYCLE_CLARIFICATION_RESTART_REJECTED" });
    }
    if (typeof observedAgentId !== "string" || observedAgentId.trim().length === 0) {
      unknownReasons.push({ field: "observedLifecycle.agentId", message: "clarification did not expose the running agent id", code: "DISPATCH_LIFECYCLE_AGENT_ID_MISSING" });
    }
    if (!observedKinds.has("send_message")) {
      unknownReasons.push({ field: "observedLifecycle.sourceEvidence", message: "same-task clarification did not expose the real send_message tool input", code: "DISPATCH_LIFECYCLE_SEND_MESSAGE_EVIDENCE_MISSING" });
    }
  }
  for (const field of ["workId", "phase", "role", "pack", "model", "effort", "newInstance", "forkTurns", "sameTaskRunning"]) {
    const expected = declaredResult[field];
    const actual = observedResult[field];
    if (expected !== null && expected !== undefined && actual !== null && actual !== undefined && expected !== actual) {
      problems.push({ field: `observedLifecycle.${field}`, message: `observed ${field} does not match the declared handoff`, code: "DISPATCH_LIFECYCLE_BINDING_MISMATCH" });
    }
    if (expected !== null && expected !== undefined && actual === null && ((AGENT_LIFECYCLE_FRESH_PHASES.includes(declaredPhase) && ["phase", "role", "pack", "model", "effort", "newInstance", "forkTurns"].includes(field)) || (declaredPhase === "clarification" && ["phase", "role", "pack", "model", "effort", "newInstance", "forkTurns", "sameTaskRunning"].includes(field)))) {
      unknownReasons.push({ field: `observedLifecycle.${field}`, message: `observed lifecycle did not expose ${field}`, code: "DISPATCH_LIFECYCLE_FACT_MISSING" });
    }
  }
  if (typeof declaredResult.agentId === "string" && typeof observedAgentId === "string" && declaredResult.agentId !== observedAgentId) {
    problems.push({ field: "observedLifecycle.agentId", message: "observed agentId does not match the declared fresh instance", code: "DISPATCH_LIFECYCLE_AGENT_ID_MISMATCH" });
  }
  const status = problems.length > 0
    ? "red"
    : unknownReasons.length > 0 || declaredResult.sourceEvidence.status !== "verified" || observedResult.sourceEvidence.status !== "verified"
      ? "unknown"
      : "green";
  return {
    ok: status === "green",
    status,
    reasonCode: status === "green" ? "DISPATCH_LIFECYCLE_EVIDENCE_GREEN" : status === "red" ? "DISPATCH_LIFECYCLE_EVIDENCE_RED" : "DISPATCH_LIFECYCLE_EVIDENCE_UNKNOWN",
    declared: declaredResult,
    observed: observedResult,
    unknownReasons,
    problems,
  };
}

const VERIFICATION_PLAN_LIST_FIELDS = Object.freeze([
  "localChecks",
  "finalRoots",
  "invalidationTriggers",
]);

function verificationPlanProblems(plan) {
  if (plan === undefined) return { problems: [], checked: false };
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return { problems: [{ field: "verificationPlan", message: "verificationPlan must be an object" }], checked: true };
  }
  const problems = [];
  if (!VERIFICATION_PHASES.includes(plan.phase)) {
    problems.push({ field: "verificationPlan.phase", message: `phase must be one of ${VERIFICATION_PHASES.join(", ")}`, code: "DISPATCH_VERIFICATION_PHASE_INVALID" });
  }
  for (const field of VERIFICATION_PLAN_LIST_FIELDS) {
    const problem = nonEmptyList(plan[field], `verificationPlan.${field}`);
    if (problem) problems.push(problem);
  }
  if (!Array.isArray(plan.blockedDependencies) || plan.blockedDependencies.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    problems.push({ field: "verificationPlan.blockedDependencies", message: "blockedDependencies must be a list of non-empty strings; an empty list means no blockers", code: "DISPATCH_VERIFICATION_BLOCKED_DEPENDENCIES_INVALID" });
  } else if (plan.blockedDependencies.length > 0) {
    problems.push({ field: "verificationPlan.blockedDependencies", message: "non-empty blockedDependencies make this plan a preview and block dispatch", code: "DISPATCH_VERIFICATION_PREREQUISITE_BLOCKED" });
  }
  if (plan.sameRepoExecution !== "serial") {
    problems.push({ field: "verificationPlan.sameRepoExecution", message: "same-repository output work must be serial", code: "DISPATCH_VERIFICATION_SERIAL_REQUIRED" });
  }
  return { problems, checked: true };
}

function declarationProblems(brief) {
  return DISPATCH_BRIEF_DECLARATION_FIELDS
    .filter((field) => brief[field] !== DISPATCH_BRIEF_DECLARATIONS[field])
    .map((field) => ({
      field,
      message: `${field} must carry the exact autonomous-operation or scope-restraint declaration`,
      code: "DISPATCH_DECLARATION_MISSING",
    }));
}

// TCRN-CROSS-INC-235: a brief that names a target field must carry that field's limit,
// and the requirements it states must fit inside it.
//
// Measured, not supposed. Ten dispatch briefs each demanded four literal strings inside a
// knowledge card's `snippet`. KNOWLEDGE_LIMITS.maximumSnippetBytes is 512; the briefs never
// said so; four of ten results ran 518-530 bytes and the store refused them. The control
// arm -- a frontier model on three of the same tickets -- went over on three of three, at
// 608, 625 and 848 bytes. Writing more thoroughly violated the unstated ceiling MORE, which
// is what settles that the variable was the brief and not the model tier.
//
// WHAT THIS CHECK DOES AND DOES NOT CATCH, stated plainly because the tempting overclaim
// is that it prevents INC-235. It does not. Those four specifics total 55 bytes plus three
// separators -- a 58-byte floor under a 512-byte ceiling -- so a satisfiability check
// passes the exact brief that produced the failure. What actually went wrong was that four
// specifics plus enough prose to read as a card do not fit 512 bytes, and no arithmetic
// decides "enough prose" without inventing a number.
//
// So the remedy this carries is the DECLARATION, not the arithmetic. A brief that names a
// bounded target field now has somewhere to put the bound, which means the dispatched
// worker is told the ceiling exists -- and neither model in the experiment was. The floor
// check is the smaller, decidable half: it refuses a brief whose literal requirements
// cannot fit its own stated ceiling under any prose at all.
//
// The check never knows a target system's limits and must not pretend to: the BRIEF
// declares them. An undeclared field is unjudged, exactly as an unjudgeable command is,
// and `fieldBudgets.checked` travels with the result so a caller cannot read "nothing
// declared" as "budgets verified". Inventing a limit nobody declared would be the mirror
// of the defect this exists to reduce.
const FIELD_BUDGET_RULES = Object.freeze(["maxBytes", "requiredStrings"]);

function fieldBudgetProblems(budgets) {
  if (budgets === undefined) return { problems: [], declared: 0 };
  if (budgets === null || typeof budgets !== "object" || Array.isArray(budgets)) {
    return { problems: [{ field: "fieldBudgets", message: "fieldBudgets must be an object keyed by field name" }], declared: 0 };
  }
  const problems = [];
  let declared = 0;
  for (const [field, spec] of Object.entries(budgets)) {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      problems.push({ field: `fieldBudgets.${field}`, message: "a field budget is an object" });
      continue;
    }
    const unknown = Object.keys(spec).filter((key) => !FIELD_BUDGET_RULES.includes(key));
    if (unknown.length > 0) {
      problems.push({ field: `fieldBudgets.${field}`, message: `unknown budget rules: ${unknown.join(", ")}` });
    }
    const { maxBytes, requiredStrings } = spec;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      problems.push({ field: `fieldBudgets.${field}`, message: "maxBytes must be a positive integer -- the limit of the surface this field is written to" });
      continue;
    }
    declared += 1;
    if (requiredStrings === undefined) continue;
    if (!Array.isArray(requiredStrings) || requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
      problems.push({ field: `fieldBudgets.${field}`, message: "requiredStrings must be a list of non-empty strings" });
      continue;
    }
    // The floor is the required strings themselves plus one separating byte between each.
    // A brief demanding more literal content than its own ceiling admits is unsatisfiable
    // before anyone is dispatched against it, and that is decidable here rather than at the
    // target system after the work is done.
    const floor = requiredStrings.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0)
      + Math.max(0, requiredStrings.length - 1);
    if (floor > maxBytes) {
      problems.push({
        field: `fieldBudgets.${field}`,
        message: `requiredStrings need at least ${floor} bytes but the declared ceiling is ${maxBytes}`,
        code: "DISPATCH_FIELD_BUDGET_UNSATISFIABLE",
      });
    }
  }
  return { problems, declared };
}

// The subcommands a package manager answers itself. A brief naming one is running the
// package manager, not a script, and this check cannot say whether it will succeed.
const PACKAGE_MANAGER_SUBCOMMANDS = new Set([
  "add", "audit", "ci", "config", "dedupe", "dlx", "exec", "fetch", "import", "init",
  "install", "install-test", "link", "list", "ls", "outdated", "pack", "patch", "ping",
  "prune", "publish", "rebuild", "remove", "root", "setup", "store", "uninstall",
  "unlink", "update", "why",
]);

function nonEmptyList(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    return { field, message: `${field} must be a non-empty list` };
  }
  if (value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    return { field, message: `${field} must contain only non-empty strings` };
  }
  return null;
}

// TCRN-CROSS-STORY-303: presence is not sufficiency. Every field above is satisfied by
// a single-character string, so a brief can be shaped-valid and still leave an executor
// guessing -- which is the failure the granularity rule exists to prevent, and exactly
// the shape of gate this audit was commissioned to find: one that reports diligence
// while the thing it names goes unmeasured.
//
// Two failures are mechanical, expensive, and the same failure twice: a citation that
// is not real. Checking that a citation is true constrains nobody's thinking; it checks
// that what was written is so.
//
// The cost is measured rather than asserted, because the first version of this comment
// asserted it and was wrong. It claimed a model that cannot find what it was pointed at
// fills the gap instead of stopping. Tested the same day against Haiku 4.5, two runs per
// arm, identical task and repository differing only in whether the citations resolve:
// both stale-brief runs named the unresolved pointers, found the real files, and
// corrected the verification command -- one of them surfacing a package script the
// author of this check did not know existed. Neither invented anything.
//
// What the stale brief actually cost, averaged over the two runs: 11 tool calls against
// 2, and 38.6 seconds against 17.2 -- roughly five times the tool calls and twice the
// wall clock to arrive at the same answer, for about 10% more tokens. That is the honest
// argument for this check. It does not prevent a wrong answer; it prevents an executor
// paying to rediscover what the brief already knew (TCRN-CROSS-INC-228).
function unresolvedCitation(entry, root) {
  // A pointer may carry a :line or :line:column suffix; the file is the claim.
  const path = entry.replace(/:\d+(?::\d+)?$/u, "");
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  // TCRN-CROSS-INC-232: the message said "under the declared repositoryRoot" and the
  // check never asked. An absolute path from the author's own machine, or a ../ chain
  // out of the tree, was certified as resolving under a root it had left -- so a brief
  // stayed green after the file moved inside the repository the executor checks out,
  // which is the one failure this check exists to catch. Containment is now the claim
  // and the check, in that order.
  const base = resolve(root);
  const contained = absolute === base || absolute.startsWith(`${base}${sep}`);
  if (!contained) return `${entry} resolves outside the declared repositoryRoot`;
  // A directory satisfying a FILE pointer sent the executor to a folder and called it
  // a citation. statSync rather than existsSync is the whole difference.
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return `${entry} does not resolve under the declared repositoryRoot`;
  }
  return stats.isFile() ? null : `${entry} names a directory, not a file`;
}

function packageScripts(root) {
  try {
    return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts ?? {};
  } catch {
    // An absent or unreadable manifest is not a failure. It means script names cannot
    // be judged here, and the unjudged count says so rather than passing them silently.
    return null;
  }
}

function unrunnableCommand(entry, root, scripts) {
  const tokens = entry.trim().split(/\s+/u);
  if (tokens[0] === "pnpm" || tokens[0] === "npm") {
    const explicitRun = tokens[1] === "run";
    const script = explicitRun ? tokens[2] : tokens[1];
    if (script === undefined || script.startsWith("-")) return { unjudged: true };
    // TCRN-CROSS-INC-232: without `run`, the first token may be a package-manager
    // subcommand rather than a script name. `pnpm install --frozen-lockfile` -- copied
    // verbatim out of this repository's own README -- was refused as "a script this
    // repository does not define", which is a false refusal wearing a specific and
    // wrong reason. A builtin is not judgeable by this check and is counted as such.
    if (!explicitRun && PACKAGE_MANAGER_SUBCOMMANDS.has(script)) return { unjudged: true };
    if (scripts === null) return { unjudged: true };
    return Object.hasOwn(scripts, script) ? {} : { message: `${entry} names a script this repository does not define` };
  }
  if (tokens[0] === "node" && tokens[1] !== undefined && !tokens[1].startsWith("-")) {
    return existsSync(isAbsolute(tokens[1]) ? tokens[1] : resolve(root, tokens[1]))
      ? {}
      : { message: `${entry} runs a file that does not exist` };
  }
  // Anything else this validator cannot judge, and an unjudged command must never read
  // as a checked one.
  return { unjudged: true };
}

function resolveCitations(brief, root) {
  const problems = [];
  for (const pointer of brief.filePointers) {
    const message = unresolvedCitation(pointer, root);
    if (message) problems.push({ field: "filePointers", message, code: "DISPATCH_POINTER_UNRESOLVED" });
  }
  const scripts = packageScripts(root);
  let unjudged = 0;
  for (const command of brief.verificationCommands) {
    const verdict = unrunnableCommand(command, root, scripts);
    if (verdict.unjudged) unjudged += 1;
    if (verdict.message) problems.push({ field: "verificationCommands", message: verdict.message, code: "DISPATCH_COMMAND_UNRUNNABLE" });
  }
  return { problems, citations: { checked: true, unjudgedCommands: unjudged } };
}

function authoritativeWorkBinding(brief) {
  const fields = ["storyId", "workId", "taskId", "workID"];
  const values = fields
    .map((field) => [field, brief[field]])
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0);
  const unique = [...new Set(values.map(([, value]) => value))];
  return { value: unique[0], values, unique };
}

export function validateDispatchBrief(brief) {
  const problems = [];
  if (brief === null || typeof brief !== "object" || Array.isArray(brief)) {
    return {
      ok: false,
      reasonCode: "DISPATCH_BRIEF_REQUIRED",
      problems: [{ field: "brief", message: "dispatch brief must be an object" }],
    };
  }
  for (const field of DISPATCH_BRIEF_FIELDS) {
    const problem = nonEmptyList(brief[field], field);
    if (problem) problems.push(problem);
  }
  problems.push(...declarationProblems(brief));
  const storyScope = brief.storyScope;
  if (typeof storyScope !== "string" || storyScope.trim().length === 0) {
    problems.push({ field: "storyScope", message: "storyScope must carry the live Story ten-block scope" });
  } else {
    const scopeResult = validateStoryScope(storyScope);
    for (const problem of scopeResult.problems) {
      problems.push({ field: "storyScope", message: problem.message, code: problem.code });
    }
  }
  // Citations are only resolvable against a root, and a brief that names none gets the
  // presence-only verdict it always got. What it does not get is silence about that:
  // `citations.checked: false` travels with the result, so a caller cannot read a
  // presence pass as a resolvability pass. Same discipline as the trailing-read
  // disclosure -- the weaker answer is labelled rather than dressed as the stronger one.
  const root = brief.repositoryRoot;
  const citations = typeof root === "string" && root.trim().length > 0 && Array.isArray(brief.filePointers) && Array.isArray(brief.verificationCommands)
    ? (() => {
      const resolved = resolveCitations(brief, root);
      problems.push(...resolved.problems);
      return resolved.citations;
    })()
    : {
      checked: false,
      reason: typeof root === "string" && root.trim().length > 0
        ? "repositoryRoot was declared but filePointers or verificationCommands is not a list, so nothing was resolved"
        : "no repositoryRoot declared, so pointers and commands were not resolved",
    };
  // TCRN-CROSS-INC-232: citations.checked was the only place the weaker verdict showed,
  // and it is the one place a shell gate does not look. `ok`, `reasonCode` and the exit
  // code all came from problems.length, which the unchecked branch never touches, so a
  // brief opted out of the whole citation check by omitting one field and still reported
  // DISPATCH_BRIEF_READY with exit 0. The reason code now carries it. Still a pass --
  // presence-only was always a legitimate verdict -- but no longer the same word as the
  // checked one, so `reasonCode == "DISPATCH_BRIEF_READY"` is an assertion a gate can make.
  const budgets = fieldBudgetProblems(brief.fieldBudgets);
  for (const problem of budgets.problems) problems.push(problem);
  const verificationPlan = verificationPlanProblems(brief.verificationPlan);
  problems.push(...verificationPlan.problems);
  const lifecycleRequired = brief.lifecycleRequired === true || brief.requireFreshInstance === true;
  const workBinding = authoritativeWorkBinding(brief);
  if (workBinding.unique.length > 1) {
    problems.push({ field: "workId", message: "story/work/task identity declarations must agree", code: "DISPATCH_WORK_BINDING_MISMATCH" });
  }
  const lifecycleCandidate = brief.agentLifecycle !== undefined && brief.agentLifecycle !== null
    ? brief.agentLifecycle
    : brief.lifecycle;
  const declaredLifecycle = lifecycleCandidate === null ? undefined : lifecycleCandidate;
  if (lifecycleRequired && declaredLifecycle === undefined) {
    problems.push({ field: "agentLifecycle", message: "new task-pack/rework/decision/acceptance briefs must declare agentLifecycle", code: "DISPATCH_LIFECYCLE_REQUIRED" });
  }
  const normalizedLifecycle = normalizeLifecycleDeclaration(declaredLifecycle, { outerWorkId: workBinding.value });
  const lifecycle = declaredLifecycle === undefined
    ? { checked: false, required: lifecycleRequired, reasonCode: lifecycleRequired ? "DISPATCH_LIFECYCLE_REQUIRED" : "DISPATCH_LIFECYCLE_NOT_DECLARED", problems: [] }
    : { required: lifecycleRequired, ...validateAgentLifecycle(normalizedLifecycle) };
  if (declaredLifecycle !== undefined && brief.agentLifecycle !== undefined && brief.lifecycle !== undefined) {
    if (brief.agentLifecycle === null || brief.lifecycle === null || typeof brief.agentLifecycle !== "object" || typeof brief.lifecycle !== "object" || Array.isArray(brief.agentLifecycle) || Array.isArray(brief.lifecycle)) {
      if (brief.agentLifecycle !== brief.lifecycle) problems.push({ field: "lifecycle", message: "agentLifecycle and lifecycle aliases must not disagree", code: "DISPATCH_LIFECYCLE_DUPLICATE" });
    } else {
      problems.push(...declarationBindingProblems(brief.agentLifecycle, brief.lifecycle, "lifecycle"));
    }
  }
  if (declaredLifecycle !== undefined) problems.push(...lifecycle.problems);
  if (declaredLifecycle !== undefined && typeof workBinding.value === "string" && lifecycle.workId !== null && lifecycle.workId !== workBinding.value) {
    problems.push({ field: "agentLifecycle.workId", message: "lifecycle workId must match the dispatch brief's authoritative Story/work id", code: "DISPATCH_WORK_BINDING_MISMATCH" });
  }
  // Historical briefs use `handoff` as a path pointer.  Only the additive
  // object-shaped `structuredHandoff` (or an object supplied under the old
  // alias) is a lifecycle envelope; a path must remain a legacy pointer.
  const declaredHandoff = brief.structuredHandoff !== undefined
    ? brief.structuredHandoff
    : (brief.handoff !== null && typeof brief.handoff === "object" ? brief.handoff : undefined);
  const structuredHandoff = validateStructuredHandoff(declaredHandoff);
  if (declaredHandoff !== undefined) problems.push(...structuredHandoff.problems);
  if (declaredHandoff !== undefined && structuredHandoff.ok) {
    // `storyId`/`workId` is the authoritative work binding when the brief has
    // one.  A handoff that validates against itself but names another Story is
    // still a contradictory handoff and must not pass dispatch readiness.
    const authoritativeWorkId = workBinding.value;
    if (authoritativeWorkId !== undefined && structuredHandoff.workId !== authoritativeWorkId) {
      problems.push({ field: "structuredHandoff.workId", message: "handoff workId must match the dispatch brief's authoritative Story/work id", code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
    }
    if (lifecycle.ok && structuredHandoff.lifecycle?.ok) {
      problems.push(...lifecycleBindingProblems(lifecycle, structuredHandoff.lifecycle, "structuredHandoff.lifecycle"));
      if (lifecycle.role !== structuredHandoff.role) problems.push({ field: "structuredHandoff.role", message: "handoff role must match the dispatch brief lifecycle", code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
      if (lifecycle.pack !== structuredHandoff.pack) problems.push({ field: "structuredHandoff.pack", message: "handoff pack must match the dispatch brief lifecycle", code: "DISPATCH_HANDOFF_BINDING_MISMATCH" });
    }
  }
  const ready = citations.checked ? "DISPATCH_BRIEF_READY" : "DISPATCH_BRIEF_READY_CITATIONS_UNCHECKED";
  return {
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? ready : "DISPATCH_BRIEF_INCOMPLETE",
    problems,
    citations,
    // Reported the same way citations are: a brief that declared no budget is not being
    // called compliant, it is being called unjudged on this axis.
    fieldBudgets: { checked: brief.fieldBudgets !== undefined, declared: budgets.declared },
    verificationPlan: { checked: verificationPlan.checked, ...(brief.verificationPlan === undefined ? {} : { phase: brief.verificationPlan?.phase ?? null }) },
    lifecycle,
    structuredHandoff,
  };
}

if (process.argv[1]?.endsWith("dispatch-readiness-compliance.mjs")) {
  const pathIndex = process.argv.indexOf("--brief");
  if (pathIndex < 0 || !process.argv[pathIndex + 1]) {
    process.stderr.write("usage: dispatch-readiness-compliance.mjs --brief <brief.json>\n");
    process.exitCode = 2;
  } else {
    let result;
    try {
      result = validateDispatchBrief(JSON.parse(readFileSync(process.argv[pathIndex + 1], "utf8")));
    } catch (error) {
      result = {
        ok: false,
        reasonCode: "DISPATCH_BRIEF_UNREADABLE",
        problems: [{ field: "brief", message: String(error?.message ?? error) }],
      };
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  }
}
