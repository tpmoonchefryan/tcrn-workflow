#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-426/427 — the host-neutral dispatch adapter.
//
// This module is intentionally the small boundary between Workflow and a host's
// native agent tool.  Workflow resolves a real workspace/host/class/mode tuple;
// the caller owns the actual spawn.  No Codex App, Claude Code, or sibling
// repository is imported here.  A caller must re-resolve immediately before the
// native call and compare the configuration source, then compare the actual
// model/effort and lifecycle observation after the call.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  materializeWorkspace,
  readDispatchConfig,
  resolveDispatch,
  storyScopeFromRecord,
} from "../dist/build/packages/core/src/index.js";
import {
  DISPATCH_CONTEXT_PACKAGE_SCHEMA_VERSION,
  DISPATCH_CONTEXT_READ_POLICY,
  DISPATCH_BRIEF_DECLARATIONS,
  validateAgentLifecycle,
  validateAgentLifecycleEvidence,
  validateDispatchBrief,
} from "./dispatch-readiness-compliance.mjs";

export const DISPATCH_ADAPTER_VERSION = "tcrn.dispatch-adapter.v1";
export const DISPATCH_ADAPTER_HOSTS = Object.freeze(["claude-code", "codex"]);
export const DISPATCH_PRESPAWN_RECEIPT_SCHEMA = "tcrn.dispatch-pre-spawn-receipt.v1";

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_CLI = resolve(ENGINE_ROOT, "scripts/tcrn-workflow.mjs");
const PRESPAWN_SOURCE_INPUTS = Object.freeze([
  "scripts/dispatch-adapter.mjs",
  "scripts/dispatch-readiness-compliance.mjs",
  "packages/core/src/workspace.ts",
  "packages/core/src/dispatch-config.ts",
  "package.json",
  "pnpm-lock.yaml",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonSerializationError(path, detail) {
  return Object.assign(new TypeError(`canonical JSON value at ${path} is invalid: ${detail}`), {
    reasonCode: "DISPATCH_JSON_VALUE_INVALID",
    field: path,
  });
}

function stableJson(value, { path = "$", inArray = false, active = new Set() } = {}) {
  if (value === undefined) return inArray ? "null" : undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw jsonSerializationError(path, "number must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw jsonSerializationError(path, `unsupported ${typeof value}`);
  if (active.has(value)) throw jsonSerializationError(path, "cyclic object");

  active.add(value);
  let encoded;
  if (Array.isArray(value)) {
    const items = Array.from({ length: value.length }, (_, index) => (
      stableJson(value[index], { path: `${path}[${index}]`, inArray: true, active }) ?? "null"
    ));
    encoded = `[${items.join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw jsonSerializationError(path, "object must be a plain JSON record");
    }
    const fields = [];
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      // JSON's schema-safe object behavior is to omit optional undefined fields.
      // Required fields are checked by their owning schema before/after encoding.
      if (child === undefined) continue;
      const childJson = stableJson(child, { path: `${path}.${key}`, active });
      if (childJson !== undefined) fields.push(`${JSON.stringify(key)}:${childJson}`);
    }
    encoded = `{${fields.join(",")}}`;
  }
  active.delete(value);
  return encoded;
}

function digest(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function digestBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function canonicalJsonBytes(value) {
  const encoded = stableJson(value);
  if (typeof encoded !== "string") throw jsonSerializationError("$", "the receipt root must be a JSON value");
  return Buffer.from(`${encoded}\n`, "utf8");
}

function fileDigestRecord(path, bytes) {
  return { path, bytes: bytes.length, sha256: digestBytes(bytes) };
}

function readRegularInput(inputPath, field) {
  try {
    const absolute = resolve(nonEmptyText(inputPath, field, 4_096));
    if (!isAbsolute(absolute)) throw new Error(`${field} must resolve to an absolute path`);
    const metadata = lstatSync(absolute);
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(`${field} must be a regular single-link file`);
    const real = realpathSync(absolute);
    const bytes = readFileSync(real);
    return { ok: true, path: absolute, realPath: real, bytes, sha256: digestBytes(bytes) };
  } catch (error) {
    return { ok: false, reasonCode: "DISPATCH_INPUT_INVALID", field, error: String(error?.message ?? error) };
  }
}

function parseJsonInput(input, field) {
  if (!input?.ok) return input;
  try {
    return { ...input, value: JSON.parse(input.bytes.toString("utf8")) };
  } catch (error) {
    return { ok: false, reasonCode: "DISPATCH_INPUT_INVALID", field, error: String(error?.message ?? error), path: input.path, sha256: input.sha256 };
  }
}

function engineGitRead(args) {
  const result = spawnSync("git", ["--no-optional-locks", "-C", ENGINE_ROOT, ...args], {
    cwd: ENGINE_ROOT,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, error: String(result.error?.message ?? result.stderr ?? "git read failed"), exitCode: result.status ?? 1 };
  }
  return { ok: true, value: result.stdout.trim() };
}

function readEngineSourceIdentity() {
  const commit = engineGitRead(["rev-parse", "HEAD"]);
  const tree = engineGitRead(["rev-parse", "HEAD^{tree}"]);
  const status = engineGitRead(["status", "--porcelain=v1", "--untracked-files=all"]);
  const packageFile = readRegularInput(resolve(ENGINE_ROOT, "package.json"), "package.json");
  if (!commit.ok || !tree.ok || !status.ok || !packageFile.ok) {
    return failure("DISPATCH_SOURCE_IDENTITY_UNAVAILABLE", "engine source identity could not be read", { commit, tree, status, packageFile });
  }
  if (status.value.trim().length > 0) return failure("DISPATCH_SOURCE_TREE_DIRTY", "dispatch source identity requires a clean engine worktree", { status: status.value });
  let packageJson;
  try { packageJson = JSON.parse(packageFile.bytes.toString("utf8")); } catch (error) {
    return failure("DISPATCH_SOURCE_IDENTITY_INVALID", "engine package metadata is not valid JSON", { error: String(error?.message ?? error) });
  }
  const files = [];
  for (const relativePath of PRESPAWN_SOURCE_INPUTS) {
    const input = readRegularInput(resolve(ENGINE_ROOT, relativePath), relativePath);
    if (!input.ok) return failure("DISPATCH_SOURCE_INPUT_INVALID", "a required dispatch source input is unavailable", { path: relativePath, input });
    files.push({ path: relativePath, bytes: input.bytes.length, sha256: input.sha256 });
  }
  return {
    schemaVersion: "tcrn.dispatch-source-identity.v1",
    engineVersion: typeof packageJson.version === "string" ? packageJson.version : null,
    commit: commit.value,
    tree: tree.value,
    worktreeClean: true,
    files,
  };
}

function readCliJson(args, label) {
  const result = spawnSync(process.execPath, [ENGINE_CLI, ...args], {
    cwd: ENGINE_ROOT,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, reasonCode: "DISPATCH_CHAIN_READ_FAILED", label, argv: [ENGINE_CLI, ...args], exitCode: result.status ?? 1, stderr: String(result.stderr ?? result.error?.message ?? "") };
  }
  if (String(result.stderr ?? "").length > 0) {
    return { ok: false, reasonCode: "DISPATCH_CHAIN_READ_STDERR_NONEMPTY", label, argv: [ENGINE_CLI, ...args], exitCode: result.status, stderr: String(result.stderr) };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout), stdoutBytes: Buffer.byteLength(result.stdout), stdoutSha256: digestBytes(Buffer.from(result.stdout, "utf8")) };
  } catch (error) {
    return { ok: false, reasonCode: "DISPATCH_CHAIN_READ_INVALID", label, argv: [ENGINE_CLI, ...args], error: String(error?.message ?? error), stdout: String(result.stdout ?? "") };
  }
}

function taskRoleTuple(binding) {
  return {
    bindingKind: binding?.bindingKind,
    role: binding?.role,
    personaProfileId: binding?.personaProfileId,
    phase: binding?.phase,
    taskClass: binding?.taskClass,
    workId: binding?.primaryWorkId ?? binding?.workId,
    pack: binding?.pack,
    taskNamePrefix: binding?.taskNamePrefix,
    scopeMarker: binding?.scopeMarker,
    predecessor: binding?.predecessor ?? null,
    predecessorEvidence: binding?.predecessorEvidence ?? null,
  };
}

function controlledRecordStoryScope(record) {
  if (!isRecord(record) || record.kind !== "Story" || record.tombstone !== false || !isRecord(record.extensions)) {
    return failure("DISPATCH_WORK_SCOPE_INVALID", "a controlled Story record with structured extensions is required");
  }
  const extension = record.extensions["advisory:scope"];
  if (!isRecord(extension) || typeof extension.value !== "string" || extension.value.trim().length === 0) {
    return failure("DISPATCH_WORK_SCOPE_INVALID", "the controlled Story record does not carry a non-empty advisory scope string");
  }
  let scope;
  try {
    scope = storyScopeFromRecord(record);
  } catch (error) {
    return failure("DISPATCH_WORK_SCOPE_INVALID", "the controlled Story record scope could not be read", { error: String(error?.message ?? error) });
  }
  if (typeof scope !== "string" || scope !== extension.value) {
    return failure("DISPATCH_WORK_SCOPE_INVALID", "the controlled Story record scope is missing or inconsistent");
  }
  return { ok: true, scope, source: "controlled-record.extensions[advisory:scope]" };
}

/**
 * Read the scope from the actual `work-show` envelope used by the CLI. The
 * public work-show projection carries it at `advisory.scope`, not in the
 * projected `record.extensions`; the record form remains accepted only when
 * that complete structured extension is present (for controlled core inputs).
 */
export function storyScopeFromWorkShow(workShow) {
  if (!isRecord(workShow)) return failure("DISPATCH_WORK_SCOPE_INVALID", "a structured work-show or controlled work record is required");

  const hasWorkShowScope = isRecord(workShow.advisory) && Object.hasOwn(workShow.advisory, "scope");
  if (hasWorkShowScope) {
    const scope = workShow.advisory.scope;
    if (typeof scope !== "string" || scope.trim().length === 0) {
      return failure("DISPATCH_WORK_SCOPE_INVALID", "work-show advisory.scope must be a non-empty string", { actualType: scope === null ? "null" : typeof scope });
    }
    if (isRecord(workShow.record) && Object.hasOwn(workShow.record, "extensions")) {
      const recordScope = controlledRecordStoryScope(workShow.record);
      if (!recordScope.ok) return recordScope;
      if (recordScope.scope !== scope) {
        return failure("DISPATCH_WORK_SCOPE_MISMATCH", "work-show advisory.scope differs from the controlled record scope", {
          advisoryScopeSha256: digestBytes(Buffer.from(scope, "utf8")),
          recordScopeSha256: digestBytes(Buffer.from(recordScope.scope, "utf8")),
        });
      }
    }
    return { ok: true, scope, source: "work-show.advisory.scope" };
  }

  const record = Object.hasOwn(workShow, "record") ? workShow.record : workShow;
  if (isRecord(record) && Object.hasOwn(record, "extensions")) return controlledRecordStoryScope(record);
  return failure("DISPATCH_WORK_SCOPE_INVALID", "work-show advisory.scope or a complete controlled Story record is required");
}

export function validateTaskRoleBinding({ binding, brief, liveWork, liveScope, roleContractSha256, briefTemplateSha256, technicalPack, scopeMarkerSha256, prepared } = {}) {
  const problems = [];
  if (!isRecord(binding)) return failure("DISPATCH_ROLE_BINDING_REQUIRED", "a code-owned task-role binding object is required");
  const scopeAuthority = storyScopeFromWorkShow(liveWork);
  const authoritativeScope = scopeAuthority.ok ? scopeAuthority.scope : null;
  if (!scopeAuthority.ok) problems.push({ code: scopeAuthority.reasonCode ?? "DISPATCH_WORK_SCOPE_INVALID", field: "liveWork.advisory.scope", detail: scopeAuthority.error ?? null });
  if (scopeAuthority.ok && liveScope !== authoritativeScope) problems.push({ code: "DISPATCH_WORK_SCOPE_MISMATCH", field: "liveScope", expectedSha256: digestBytes(Buffer.from(authoritativeScope, "utf8")), actualSha256: typeof liveScope === "string" ? digestBytes(Buffer.from(liveScope, "utf8")) : null });
  const tuple = taskRoleTuple(binding);
  if (tuple.bindingKind !== "governed-task-role") problems.push({ code: "DISPATCH_BINDING_KIND_INVALID", field: "bindingKind" });
  if (typeof tuple.role !== "string" || tuple.role.trim().length === 0) problems.push({ code: "DISPATCH_ROLE_BINDING_REQUIRED", field: "role" });
  if (!Object.hasOwn(binding, "personaProfileId") || tuple.personaProfileId !== null) problems.push({ code: "DISPATCH_PERSONA_PROFILE_FORBIDDEN", field: "personaProfileId", expected: null, actual: tuple.personaProfileId ?? "missing" });
  if (typeof tuple.phase !== "string" || tuple.phase.trim().length === 0) problems.push({ code: "DISPATCH_PHASE_BINDING_REQUIRED", field: "phase" });
  if (typeof tuple.pack !== "string" || tuple.pack.trim().length === 0) problems.push({ code: "DISPATCH_PACK_BINDING_REQUIRED", field: "pack" });
  if (binding.host !== prepared?.resolution?.host) problems.push({ code: "DISPATCH_HOST_MISMATCH", field: "host", expected: prepared?.resolution?.host ?? null, actual: binding.host ?? null });
  if (binding.mode !== prepared?.resolution?.mode) problems.push({ code: "DISPATCH_MODE_MISMATCH", field: "mode", expected: prepared?.resolution?.mode ?? null, actual: binding.mode ?? null });
  if (typeof tuple.taskNamePrefix !== "string" || !/^[a-z][a-z0-9_]{0,39}$/u.test(tuple.taskNamePrefix)) problems.push({ code: "DISPATCH_TASK_NAME_PREFIX_INVALID", field: "taskNamePrefix" });
  if (typeof tuple.scopeMarker !== "string" || tuple.scopeMarker.trim().length === 0) problems.push({ code: "DISPATCH_SCOPE_MARKER_REQUIRED", field: "scopeMarker" });
  for (const [field, markerValue] of [
    ["bindingKind", tuple.bindingKind],
    ["role", tuple.role],
    ["personaProfileId", "null"],
    ["phase", tuple.phase],
    ["taskClass", tuple.taskClass],
    ["workId", tuple.workId],
    ["pack", tuple.pack],
    ["taskNamePrefix", tuple.taskNamePrefix],
  ]) {
    if (typeof tuple.scopeMarker === "string" && (typeof markerValue !== "string" || !tuple.scopeMarker.includes(`${field}=${markerValue}`))) {
      problems.push({ code: "DISPATCH_SCOPE_MARKER_BINDING_INVALID", field: `scopeMarker.${field}`, expected: markerValue ?? null });
    }
  }
  if (typeof tuple.workId !== "string" || tuple.workId !== liveWork?.record?.id) problems.push({ code: "DISPATCH_WORK_BINDING_MISMATCH", field: "workId", expected: liveWork?.record?.id ?? null, actual: tuple.workId ?? null });
  if (liveWork?.record?.status !== "active" || liveWork?.record?.tombstone !== false) problems.push({ code: "DISPATCH_WORK_NOT_ACTIVE", field: "work.status", actual: liveWork?.record?.status ?? null });
  if (typeof tuple.scopeMarker === "string" && !String(authoritativeScope ?? "").includes(tuple.scopeMarker)) problems.push({ code: "DISPATCH_SCOPE_MARKER_MISSING", field: "scopeMarker" });
  if (typeof roleContractSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(roleContractSha256) || !String(authoritativeScope ?? "").includes(roleContractSha256)) problems.push({ code: "DISPATCH_ROLE_CONTRACT_DIGEST_UNBOUND", field: "roleContractSha256" });
  if (typeof briefTemplateSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(briefTemplateSha256) || !String(authoritativeScope ?? "").includes(briefTemplateSha256)) problems.push({ code: "DISPATCH_BRIEF_TEMPLATE_DIGEST_UNBOUND", field: "briefTemplateSha256" });
  if (typeof technicalPack?.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(technicalPack.sha256) || !String(authoritativeScope ?? "").includes(technicalPack.sha256)) problems.push({ code: "DISPATCH_PACK_DIGEST_UNBOUND", field: "technicalPack.sha256" });
  if (typeof scopeMarkerSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(scopeMarkerSha256) || !String(authoritativeScope ?? "").includes(scopeMarkerSha256)) problems.push({ code: "DISPATCH_SCOPE_MARKER_DIGEST_UNBOUND", field: "scopeMarkerSha256" });

  const lifecycle = brief?.agentLifecycle ?? brief?.lifecycle;
  if (!isRecord(brief)) problems.push({ code: "DISPATCH_BRIEF_REQUIRED", field: "brief" });
  if (brief?.taskClass !== tuple.taskClass || prepared?.resolution?.taskClass !== tuple.taskClass) problems.push({ code: "DISPATCH_CLASS_MISMATCH", field: "taskClass", expected: prepared?.resolution?.taskClass ?? null, actual: brief?.taskClass ?? tuple.taskClass ?? null });
  if (brief?.host !== undefined && brief.host !== prepared?.resolution?.host) problems.push({ code: "DISPATCH_HOST_MISMATCH", field: "host", expected: prepared?.resolution?.host ?? null, actual: brief.host });
  if (brief?.mode !== undefined && brief.mode !== prepared?.resolution?.mode) problems.push({ code: "DISPATCH_MODE_MISMATCH", field: "mode", expected: prepared?.resolution?.mode ?? null, actual: brief.mode });
  const briefWorkId = brief?.workId ?? brief?.storyId;
  if (briefWorkId !== tuple.workId || lifecycle?.workId !== tuple.workId) problems.push({ code: "DISPATCH_WORK_BINDING_MISMATCH", field: "brief.workId", expected: tuple.workId ?? null, actual: briefWorkId ?? lifecycle?.workId ?? null });
  if (brief?.storyScope !== authoritativeScope) problems.push({ code: "DISPATCH_BRIEF_SCOPE_STALE", field: "storyScope" });
  if (!isRecord(brief?.taskRoleBinding)) problems.push({ code: "DISPATCH_BRIEF_ROLE_BINDING_MISSING", field: "taskRoleBinding" });
  else {
    for (const field of ["bindingKind", "role", "phase", "taskClass", "workId", "pack", "taskNamePrefix", "scopeMarker"]) {
      if (brief.taskRoleBinding[field] !== tuple[field]) problems.push({ code: "DISPATCH_BRIEF_ROLE_BINDING_MISMATCH", field: `taskRoleBinding.${field}`, expected: tuple[field] ?? null, actual: brief.taskRoleBinding[field] ?? null });
    }
    if (stableJson(brief.taskRoleBinding.predecessor ?? null) !== stableJson(tuple.predecessor) || stableJson(brief.taskRoleBinding.predecessorEvidence ?? null) !== stableJson(tuple.predecessorEvidence)) {
      problems.push({ code: "DISPATCH_BRIEF_PREDECESSOR_BINDING_MISMATCH", field: "taskRoleBinding.predecessor" });
    }
    if (!Object.hasOwn(brief.taskRoleBinding, "personaProfileId") || brief.taskRoleBinding.personaProfileId !== null) problems.push({ code: "DISPATCH_BRIEF_ROLE_BINDING_MISMATCH", field: "taskRoleBinding.personaProfileId", expected: null, actual: brief.taskRoleBinding.personaProfileId ?? "missing" });
  }
  if (brief?.technicalPack?.sha256 !== technicalPack?.sha256 || brief?.technicalPack?.path !== technicalPack?.path) problems.push({ code: "DISPATCH_BRIEF_PACK_MISMATCH", field: "technicalPack" });
  if (lifecycle?.role !== tuple.role) problems.push({ code: "DISPATCH_ROLE_BINDING_MISMATCH", field: "agentLifecycle.role", expected: tuple.role ?? null, actual: lifecycle?.role ?? null });
  if (lifecycle?.pack !== tuple.pack) problems.push({ code: "DISPATCH_PACK_BINDING_MISMATCH", field: "agentLifecycle.pack", expected: tuple.pack ?? null, actual: lifecycle?.pack ?? null });
  if (lifecycle?.phase !== tuple.phase) problems.push({ code: "DISPATCH_PHASE_BINDING_MISMATCH", field: "agentLifecycle.phase", expected: tuple.phase ?? null, actual: lifecycle?.phase ?? null });
  if (lifecycle?.model !== prepared?.resolution?.value?.model) problems.push({ code: "DISPATCH_MODEL_MISMATCH", field: "agentLifecycle.model", expected: prepared?.resolution?.value?.model ?? null, actual: lifecycle?.model ?? null });
  if (lifecycle?.effort !== prepared?.resolution?.value?.effort) problems.push({ code: "DISPATCH_EFFORT_MISMATCH", field: "agentLifecycle.effort", expected: prepared?.resolution?.value?.effort ?? null, actual: lifecycle?.effort ?? null });
  if (lifecycle?.newInstance !== true || lifecycle?.forkTurns !== "none" || lifecycle?.sameTaskRunning !== false) problems.push({ code: "DISPATCH_LIFECYCLE_INVALID", field: "agentLifecycle", expected: { newInstance: true, forkTurns: "none", sameTaskRunning: false }, actual: { newInstance: lifecycle?.newInstance ?? null, forkTurns: lifecycle?.forkTurns ?? null, sameTaskRunning: lifecycle?.sameTaskRunning ?? null } });
  if (lifecycle?.agentId !== undefined && lifecycle.agentId !== null) problems.push({ code: "DISPATCH_PRESPAWN_AGENT_ID_FORBIDDEN", field: "agentLifecycle.agentId", actual: lifecycle.agentId });
  if (stableJson(lifecycle?.predecessor ?? null) !== stableJson(tuple.predecessor)) problems.push({ code: "DISPATCH_PREDECESSOR_BINDING_MISMATCH", field: "agentLifecycle.predecessor" });
  if (stableJson(lifecycle?.predecessorEvidence ?? null) !== stableJson(tuple.predecessorEvidence)) problems.push({ code: "DISPATCH_PREDECESSOR_EVIDENCE_MISMATCH", field: "agentLifecycle.predecessorEvidence" });
  const briefValidation = validateDispatchBrief(brief);
  if (!briefValidation.ok) problems.push({ code: "DISPATCH_BRIEF_INVALID", field: "brief", reasonCode: briefValidation.reasonCode, problems: briefValidation.problems });

  return {
    schemaVersion: "tcrn.dispatch-task-binding-check.v1",
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? "DISPATCH_TASK_BINDING_VALID" : "DISPATCH_TASK_BINDING_INVALID",
    tuple,
    liveWork: liveWork?.record ? { id: liveWork.record.id, revision: liveWork.record.revision, scopeDigest: liveWork.record.scopeDigest, status: liveWork.record.status } : null,
    briefVerdict: briefValidation,
    problems,
  };
}

function nonEmptyText(value, field, maximum = 512) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\u0000") || !value.isWellFormed()) {
    throw Object.assign(new Error(`${field} must be non-empty bounded text`), { reasonCode: "DISPATCH_INPUT_INVALID" });
  }
  return value;
}

function workspacePath(value) {
  const path = nonEmptyText(value, "workspace", 2_048);
  if (!isAbsolute(path)) throw Object.assign(new Error("workspace must be absolute"), { reasonCode: "DISPATCH_WORKSPACE_NOT_ABSOLUTE" });
  return resolve(path);
}

function reasonCode(error, fallback = "DISPATCH_RESOLUTION_FAILED") {
  return typeof error?.reasonCode === "string" ? error.reasonCode : fallback;
}

function failure(code, message, details = {}) {
  return {
    schemaVersion: DISPATCH_ADAPTER_VERSION,
    ok: false,
    status: "rejected",
    executable: false,
    reasonCode: code,
    error: message,
    ...details,
  };
}

function sourceFor(state, config) {
  const dispatchSettings = {
    classes: config.classes,
    tiers: config.tiers,
    modes: config.modes,
    mode: config.mode,
  };
  const configDigest = digest(dispatchSettings);
  return {
    kind: "engine-workspace-dispatch-config",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    configDigest,
  };
}

function resolutionFrom(config, source, { host, taskClass, mode }) {
  const selectedMode = mode ?? config.mode;
  const resolution = resolveDispatch(config, host, taskClass, selectedMode);
  // The legacy resolver intentionally falls through to a lower tier for host
  // rendering. Native dispatch is stricter: a class is entitled only to its
  // configured tier. Downgrading a decision/acceptance/implementation request
  // would hide a missing value and is exactly the silent fallback this adapter
  // is meant to prevent.
  const exactTier = resolution.value !== null && resolution.resolvedTier === resolution.requestedTier;
  const executable = resolution.dispatch === true && exactTier;
  const reason = resolution.value === null
    ? "DISPATCH_RESOLUTION_EMPTY"
    : !exactTier
      ? "DISPATCH_TIER_VALUE_MISSING"
    : resolution.dispatch !== true
      ? "DISPATCH_CLASS_NOT_DISPATCHABLE"
      : "DISPATCH_RESOLUTION_READY";
  return {
    schemaVersion: DISPATCH_ADAPTER_VERSION,
    ok: executable,
    status: "resolved",
    executable,
    reasonCode: reason,
    source,
    resolution,
  };
}

/**
 * Resolve one task against the current workspace.  This is the only source a
 * native adapter may use for its model and effort.  An empty tier is a
 * structured refusal, not a request to fill flagship; a non-dispatchable
 * compatibility class is reported but is never executable.
 */
export async function resolveDispatchRequest({ workspace, host, taskClass, mode } = {}) {
  let path;
  try {
    path = workspacePath(workspace);
    nonEmptyText(host, "host", 128);
    nonEmptyText(taskClass, "taskClass", 128);
    if (mode !== undefined) nonEmptyText(mode, "mode", 128);
  } catch (error) {
    return failure(reasonCode(error, "DISPATCH_INPUT_INVALID"), String(error?.message ?? error));
  }
  if (!DISPATCH_ADAPTER_HOSTS.includes(host)) {
    return failure("DISPATCH_HOST_UNSUPPORTED", `host ${host} is not supported by the native adapter`, {
      host,
      taskClass,
      mode: mode ?? null,
    });
  }
  try {
    const state = await materializeWorkspace(path);
    const config = readDispatchConfig(state.settings);
    const source = sourceFor(state, config);
    return {
      ...resolutionFrom(config, source, { host, taskClass, mode }),
      workspace: path,
      workspaceId: state.metadata.workspaceId,
    };
  } catch (error) {
    return failure(reasonCode(error), String(error?.message ?? error), {
      workspace: path,
      host,
      taskClass,
      mode: mode ?? null,
    });
  }
}

/**
 * Build exactly the values that may be forwarded to a host's native spawn
 * call.  The returned model/effort are copied from the engine resolution; no
 * provider or flagship fallback exists here.  Lifecycle metadata remains
 * separate so the parent can add the host tool's own fields without making the
 * engine depend on that tool.
 */
export function buildNativeSpawnInput(prepared, lifecycle) {
  if (!prepared || prepared.schemaVersion !== DISPATCH_ADAPTER_VERSION || prepared.executable !== true || prepared.resolution?.value === null) {
    return failure("DISPATCH_RESOLUTION_NOT_EXECUTABLE", "a successful executable resolution is required before spawn");
  }
  if (!isRecord(lifecycle)) return failure("DISPATCH_LIFECYCLE_REQUIRED", "lifecycle binding is required before spawn");
  const value = prepared.resolution.value;
  const declared = { ...lifecycle };
  const lifecycleWorkId = invocationValue(declared, ["workId", "work_id", "taskId", "task_id"]);
  if (typeof lifecycleWorkId !== "string" || lifecycleWorkId.trim().length === 0) {
    return failure("DISPATCH_WORK_BINDING_REQUIRED", "lifecycle workId is required before spawn");
  }
  const lifecycleClass = invocationValue(declared, ["taskClass", "dispatchClass", "class"]);
  if (lifecycleClass !== undefined && lifecycleClass !== prepared.resolution.taskClass) {
    return failure("DISPATCH_CLASS_MISMATCH", "lifecycle class does not match the engine resolution", { expected: prepared.resolution.taskClass, actual: lifecycleClass });
  }
  if (declared.model !== undefined && declared.model !== value.model) {
    return failure("DISPATCH_MODEL_MISMATCH", "lifecycle model does not match the engine resolution", { expected: value.model, actual: declared.model });
  }
  if (declared.effort !== undefined && declared.effort !== value.effort) {
    return failure("DISPATCH_EFFORT_MISMATCH", "lifecycle effort does not match the engine resolution", { expected: value.effort, actual: declared.effort });
  }
  declared.model = value.model;
  declared.effort = value.effort;
  const lifecycleResult = validateAgentLifecycle(declared);
  if (!lifecycleResult.ok) {
    return failure("DISPATCH_LIFECYCLE_INVALID", "lifecycle binding is not dispatchable", { lifecycle: lifecycleResult });
  }
  return {
    schemaVersion: DISPATCH_ADAPTER_VERSION,
    ok: true,
    status: "ready",
    reasonCode: "DISPATCH_NATIVE_SPAWN_READY",
    source: prepared.source,
    resolution: prepared.resolution,
    // `effort` is deliberately host-neutral.  The caller maps it to the
    // native tool's reasoning/effort argument and must retain this input in
    // its dispatch artifact.
    spawn: {
      model: value.model,
      effort: value.effort,
    },
    lifecycle: declared,
  };
}

export function validatePreSpawnBaseline({ baseline, baselineSha256, status, workList, prepared, sourceIdentity, primaryWorkId, primaryExternalKey, requiredExternalKeys = [] } = {}) {
  const problems = [];
  if (baseline?.schemaVersion !== "tcrn.init-051-final-B-star.v1") problems.push({ code: "DISPATCH_BASELINE_SCHEMA_INVALID", field: "schemaVersion" });
  if (baseline?.workspace?.id !== status?.workspaceId || baseline?.workspace?.version !== status?.version || baseline?.workspace?.headEventHash !== status?.headEventHash) {
    problems.push({ code: "DISPATCH_BASELINE_CHAIN_DRIFT", field: "workspace", expected: { id: status?.workspaceId, version: status?.version, headEventHash: status?.headEventHash }, actual: baseline?.workspace ?? null });
  }
  if (baseline?.queue?.truncated !== false || baseline?.queue?.total !== workList?.total || baseline?.queue?.returned !== workList?.records?.length || baseline?.queue?.version !== workList?.version || baseline?.queue?.headEventHash !== workList?.headEventHash || baseline?.queue?.workListSha256 !== workList?.stdoutSha256) {
    problems.push({ code: "DISPATCH_BASELINE_QUEUE_DRIFT", field: "queue", expected: { total: workList?.total, returned: workList?.records?.length, truncated: false, version: workList?.version, headEventHash: workList?.headEventHash, workListSha256: workList?.stdoutSha256 }, actual: baseline?.queue ?? null });
  }
  if (baseline?.configuration?.configDigest !== prepared?.source?.configDigest || prepared?.source?.configDigest === undefined) {
    problems.push({ code: "DISPATCH_BASELINE_CONFIG_DRIFT", field: "configuration.configDigest", expected: prepared?.source?.configDigest ?? null, actual: baseline?.configuration?.configDigest ?? null });
  }
  if (baseline?.sourceIdentities?.engine?.commit !== sourceIdentity?.commit || baseline?.sourceIdentities?.engine?.tree !== sourceIdentity?.tree) {
    problems.push({ code: "DISPATCH_BASELINE_SOURCE_DRIFT", field: "sourceIdentities.engine", expected: { commit: sourceIdentity?.commit, tree: sourceIdentity?.tree }, actual: baseline?.sourceIdentities?.engine ?? null });
  }
  if (baseline?.sourceIdentities?.engine?.worktreeClean !== true || baseline?.sourceIdentities?.helper?.worktreeClean !== true || !/^[a-f0-9]{40}$/u.test(String(baseline?.sourceIdentities?.helper?.commit ?? "")) || !/^[a-f0-9]{40}$/u.test(String(baseline?.sourceIdentities?.helper?.tree ?? ""))) {
    problems.push({ code: "DISPATCH_BASELINE_SOURCE_IDENTITY_INVALID", field: "sourceIdentities" });
  }
  if (baseline?.primaryExternalKey !== primaryExternalKey) problems.push({ code: "DISPATCH_BASELINE_PRIMARY_KEY_MISMATCH", field: "primaryExternalKey", expected: primaryExternalKey ?? null, actual: baseline?.primaryExternalKey ?? null });
  if (!Array.isArray(baseline?.workBindings) || baseline.workBindings.length === 0) {
    problems.push({ code: "DISPATCH_BASELINE_WORK_BINDINGS_INVALID", field: "workBindings" });
  } else {
    const listed = new Map((workList.records ?? []).map((record) => [record.externalKey, record]));
    const baselineKeys = new Set();
    for (const binding of baseline.workBindings) {
      if (!isRecord(binding) || typeof binding.externalKey !== "string" || baselineKeys.has(binding.externalKey)) {
        problems.push({ code: "DISPATCH_BASELINE_WORK_BINDING_INVALID", field: "workBindings" });
        continue;
      }
      baselineKeys.add(binding.externalKey);
      const current = listed.get(binding.externalKey);
      if (!current || current.id !== binding.id || current.revision !== binding.revision || current.scopeDigest !== binding.scopeDigest || current.status !== binding.status) {
        problems.push({ code: "DISPATCH_BASELINE_WORK_DRIFT", field: `workBindings.${binding.externalKey}`, expected: binding, actual: current ?? null });
      }
    }
    const primaryExternalKey = baseline?.primaryExternalKey;
    if (typeof primaryExternalKey !== "string" || !baselineKeys.has(primaryExternalKey)) problems.push({ code: "DISPATCH_PRIMARY_WORK_NOT_BASELINED", field: "workBindings", primaryExternalKey: primaryExternalKey ?? null });
    const primary = typeof primaryExternalKey === "string" ? listed.get(primaryExternalKey) : undefined;
    if (!primary || primary.id !== primaryWorkId) problems.push({ code: "DISPATCH_PRIMARY_WORK_MISMATCH", field: "primaryWorkId", expected: primary?.id ?? null, actual: primaryWorkId ?? null });
    for (const requiredKey of requiredExternalKeys) {
      if (!baselineKeys.has(requiredKey)) problems.push({ code: "DISPATCH_EVIDENCE_WORK_NOT_BASELINED", field: `workBindings.${requiredKey}`, expected: requiredKey });
    }
  }
  return {
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? "DISPATCH_BASELINE_CURRENT" : "DISPATCH_BASELINE_NOT_CURRENT",
    baselineSha256,
    problems,
  };
}

function safeTaskPrefix(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/u.test(value);
}

export function buildBoundedContextPackage({ plan, brief, binding, workId, status, liveWork, prepared }) {
  return {
    schemaVersion: DISPATCH_CONTEXT_PACKAGE_SCHEMA_VERSION,
    purpose: plan.purpose,
    task: { role: binding.role, workId, pack: binding.pack, phase: binding.phase },
    current: {
      workspaceId: status.workspaceId,
      version: status.version,
      headEventHash: status.headEventHash,
      configDigest: prepared.source.configDigest,
      workRevision: liveWork.record.revision,
      scopeDigest: liveWork.record.scopeDigest,
    },
    inputs: {
      filePointers: [...(Array.isArray(brief.filePointers) ? brief.filePointers : [])],
      allowedDirectories: [...(Array.isArray(plan.allowedDirectories) ? plan.allowedDirectories : [])],
      decisionIndex: [...plan.decisionIndex],
      resultIndex: [...plan.resultIndex],
      rawInputs: [...plan.rawInputs],
    },
    readPolicy: {
      ...DISPATCH_CONTEXT_READ_POLICY,
      searchOrder: [...DISPATCH_CONTEXT_READ_POLICY.searchOrder],
    },
    resourcePolicy: {
      ownerKey: `task:${workId}:${binding.pack}`,
      registrationRequired: true,
      signalOnlyOwnedGroups: true,
      verifyAllChildrenTerminal: true,
    },
    limitation: "This package is a bounded dispatch contract, not a host-wide search sandbox or proof of native payload delivery.",
  };
}

/**
 * Produce one deterministic code-owned receipt immediately before a fresh
 * native dispatch. The brief's role is checked against its separately
 * digest-bound task-role file and the live scope; model/effort come only from
 * a fresh engine resolution. No host-native role or message plaintext is
 * manufactured here.
 */
export async function preparePreSpawnReceipt({ workspace, roleBindingPath, briefTemplatePath, baselinePath } = {}) {
  let workspaceRoot;
  try { workspaceRoot = workspacePath(workspace); } catch (error) { return failure(reasonCode(error, "DISPATCH_INPUT_INVALID"), String(error?.message ?? error)); }
  const bindingInput = parseJsonInput(readRegularInput(roleBindingPath, "roleBindingPath"), "roleBinding");
  if (!bindingInput.ok) return failure(bindingInput.reasonCode, "task-role binding input is unreadable", { input: bindingInput });
  const briefInput = parseJsonInput(readRegularInput(briefTemplatePath, "briefTemplatePath"), "briefTemplate");
  if (!briefInput.ok) return failure(briefInput.reasonCode, "effective brief template is unreadable", { input: briefInput });
  const baselineInput = parseJsonInput(readRegularInput(baselinePath, "baselinePath"), "baseline");
  if (!baselineInput.ok) return failure(baselineInput.reasonCode, "frozen baseline is unreadable", { input: baselineInput });

  const binding = bindingInput.value;
  const briefTemplate = briefInput.value;
  const baseline = baselineInput.value;
  if (!isRecord(binding) || !isRecord(briefTemplate) || !isRecord(baseline)) return failure("DISPATCH_INPUT_INVALID", "binding, brief template, and baseline must be objects");
  for (const forbidden of ["observedRole", "nativeRole", "agentRole", "providerIdentity", "contextPackage"]) {
    if (Object.hasOwn(binding, forbidden) || Object.hasOwn(briefTemplate, forbidden)) {
      return failure("DISPATCH_CALLER_OBSERVATION_FORBIDDEN", "caller-supplied native identity fields cannot substitute for observed host facts", { field: forbidden });
    }
  }
  const workId = binding.primaryWorkId ?? binding.workId;
  if (typeof workId !== "string" || workId.trim().length === 0) return failure("DISPATCH_WORK_BINDING_REQUIRED", "primary work id is required in the task-role binding");
  if (typeof binding.host !== "string" || !DISPATCH_ADAPTER_HOSTS.includes(binding.host)) return failure("DISPATCH_HOST_UNSUPPORTED", "task-role binding host is not supported", { host: binding.host ?? null });
  if (typeof binding.taskClass !== "string" || typeof binding.role !== "string" || typeof binding.pack !== "string" || typeof binding.phase !== "string") return failure("DISPATCH_ROLE_PACK_PHASE_REQUIRED", "role, Pack, phase, and task class must be explicit in the task-role binding");
  if (binding.newInstance !== true || binding.forkTurns !== "none" || binding.sameTaskRunning !== false) return failure("DISPATCH_LIFECYCLE_INVALID", "task-role binding must authorize a fresh instance with literal fork none", { newInstance: binding.newInstance ?? null, forkTurns: binding.forkTurns ?? null, sameTaskRunning: binding.sameTaskRunning ?? null });
  if (!safeTaskPrefix(binding.taskNamePrefix)) return failure("DISPATCH_TASK_NAME_PREFIX_INVALID", "taskNamePrefix must be a short lower-case identifier");
  if (!isRecord(binding.technicalPack) || typeof binding.technicalPack.path !== "string" || typeof binding.technicalPack.sha256 !== "string") return failure("DISPATCH_PACK_BINDING_REQUIRED", "the exact technical Pack path and digest are required");
  const technicalPackPath = isAbsolute(binding.technicalPack.path) ? binding.technicalPack.path : resolve(dirname(bindingInput.path), binding.technicalPack.path);
  const technicalPackInput = readRegularInput(technicalPackPath, "technicalPack");
  if (!technicalPackInput.ok) return failure(technicalPackInput.reasonCode, "technical Pack bytes are unavailable", { input: technicalPackInput });
  if (technicalPackInput.sha256 !== binding.technicalPack.sha256) return failure("DISPATCH_PACK_DIGEST_MISMATCH", "technical Pack bytes do not match the bound digest", { expected: binding.technicalPack.sha256, actual: technicalPackInput.sha256 });
  let predecessorEvidenceInput = null;
  if (binding.predecessor !== undefined && binding.predecessor !== null) {
    if (!isRecord(binding.predecessor) || typeof binding.predecessor.agentId !== "string" || typeof binding.predecessor.status !== "string" || !isRecord(binding.predecessorEvidence) || typeof binding.predecessorEvidence.path !== "string" || !isSha256(binding.predecessorEvidence.sha256)) {
      return failure("DISPATCH_PREDECESSOR_BINDING_INVALID", "a declared predecessor requires a bounded terminal-status observation artifact");
    }
    const predecessorPath = isAbsolute(binding.predecessorEvidence.path) ? binding.predecessorEvidence.path : resolve(dirname(bindingInput.path), binding.predecessorEvidence.path);
    const predecessorInput = parseJsonInput(readRegularInput(predecessorPath, "predecessorEvidence"), "predecessorEvidence");
    if (!predecessorInput.ok) return failure(predecessorInput.reasonCode, "predecessor observation is unreadable", { input: predecessorInput });
    if (predecessorInput.sha256 !== binding.predecessorEvidence.sha256 || predecessorInput.value?.predecessor?.agentId !== binding.predecessor.agentId || predecessorInput.value?.predecessor?.status !== binding.predecessor.status) {
      return failure("DISPATCH_PREDECESSOR_EVIDENCE_MISMATCH", "predecessor observation bytes do not support the declared terminal predecessor", { expected: binding.predecessor, actual: predecessorInput.value?.predecessor ?? null, expectedSha256: binding.predecessorEvidence.sha256, actualSha256: predecessorInput.sha256 });
    }
    if (["running", "active", "in-progress"].includes(binding.predecessor.status.trim().toLowerCase())) return failure("DISPATCH_LIFECYCLE_RUNNING_PREDECESSOR", "a running predecessor can only receive same-task clarification");
    predecessorEvidenceInput = predecessorInput;
  }

  const resolved = await resolveDispatchRequest({ workspace: workspaceRoot, host: binding.host, taskClass: binding.taskClass });
  if (!resolved.ok || resolved.executable !== true) return failure("DISPATCH_REPARSE_REFUSED", "fresh engine resolution is not executable", { current: resolved });
  if (binding.mode !== undefined && binding.mode !== resolved.resolution.mode) return failure("DISPATCH_MODE_MISMATCH", "bound mode differs from the current engine mode", { expected: resolved.resolution.mode, actual: binding.mode });
  const statusRead = readCliJson(["status", "--workspace", workspaceRoot], "status");
  if (!statusRead.ok) return failure(statusRead.reasonCode, "fresh status read failed", { statusRead });
  const status = statusRead.value;
  const listRead = readCliJson(["work-list", "--workspace", workspaceRoot, "--limit", "2000"], "work-list");
  if (!listRead.ok) return failure(listRead.reasonCode, "complete work-list read failed", { listRead });
  const workList = { ...listRead.value, stdoutSha256: listRead.stdoutSha256, stdoutBytes: listRead.stdoutBytes };
  if (workList.truncated !== false || workList.records?.length !== workList.total) return failure("DISPATCH_WORK_LIST_INCOMPLETE", "the current complete work-list is not available", { total: workList.total ?? null, returned: workList.records?.length ?? null, truncated: workList.truncated ?? null });
  const listedPrimary = workList.records.find((record) => record.id === workId);
  if (!listedPrimary) return failure("DISPATCH_WORK_NOT_FOUND", "bound work id is not present in the current complete queue", { workId });
  const workShowRead = readCliJson(["work-show", "--workspace", workspaceRoot, "--id", workId], "work-show");
  if (!workShowRead.ok) return failure(workShowRead.reasonCode, "current primary work-show read failed", { workShowRead });
  const liveWork = workShowRead.value;
  const scopeAuthority = storyScopeFromWorkShow(liveWork);
  if (!scopeAuthority.ok) return failure(scopeAuthority.reasonCode ?? "DISPATCH_WORK_SCOPE_INVALID", "the live work-show did not expose an authoritative Story scope", { scopeAuthority });
  const liveScope = scopeAuthority.scope;
  if (status.version !== resolved.source.version || status.headEventHash !== resolved.source.headEventHash || workList.version !== status.version || workList.headEventHash !== status.headEventHash || liveWork.version !== status.version || liveWork.headEventHash !== status.headEventHash) {
    return failure("DISPATCH_CHAIN_READ_DRIFT", "status, dispatch resolution, complete queue, and work-show do not share one chain head", { status: { version: status.version, headEventHash: status.headEventHash }, resolution: resolved.source, queue: { version: workList.version, headEventHash: workList.headEventHash }, workShow: { version: liveWork.version, headEventHash: liveWork.headEventHash } });
  }
  if (listedPrimary.revision !== liveWork.record?.revision || listedPrimary.scopeDigest !== liveWork.record?.scopeDigest || listedPrimary.status !== liveWork.record?.status || liveWork.record?.id !== workId) {
    return failure("DISPATCH_WORK_BINDING_DRIFT", "work-list and primary work-show disagree", { listedPrimary, record: liveWork.record ?? null });
  }
  const sourceIdentity = readEngineSourceIdentity();
  if (sourceIdentity.ok === false) return sourceIdentity;
  const primaryExternalKey = binding.primaryExternalKey ?? liveWork.record.externalKey;
  const requiredExternalKeys = [primaryExternalKey, ...(Array.isArray(binding.evidenceDuties) ? binding.evidenceDuties : [])].map((entry) => Number.isInteger(entry) ? `TCRN-CROSS-STORY-${entry}` : entry);
  const baselineCheck = validatePreSpawnBaseline({ baseline, baselineSha256: baselineInput.sha256, status, workList, prepared: resolved, sourceIdentity, primaryWorkId: workId, primaryExternalKey, requiredExternalKeys });
  if (!baselineCheck.ok) return failure("DISPATCH_BASELINE_NOT_CURRENT", "the frozen B-star inputs do not match current chain/source/configuration", { baselineCheck });

  const templateLifecycle = briefTemplate.agentLifecycle ?? briefTemplate.lifecycle;
  if (!isRecord(templateLifecycle)) return failure("DISPATCH_LIFECYCLE_REQUIRED", "brief template must carry agentLifecycle");
  const bindingTuple = taskRoleTuple(binding);
  const declaredBriefFields = [
    ["workId", briefTemplate.workId ?? briefTemplate.storyId, workId],
    ["storyId", briefTemplate.storyId ?? briefTemplate.workId, workId],
    ["taskClass", briefTemplate.taskClass, binding.taskClass],
    ["host", briefTemplate.host, binding.host],
    ["mode", briefTemplate.mode, resolved.resolution.mode],
  ];
  for (const [field, actual, expected] of declaredBriefFields) {
    if (actual !== undefined && actual !== expected) return failure("DISPATCH_BRIEF_BINDING_MISMATCH", `brief template ${field} differs from the governed task binding`, { field, expected, actual });
  }
  if (!isRecord(briefTemplate.taskRoleBinding)) return failure("DISPATCH_BRIEF_ROLE_BINDING_MISSING", "brief template must explicitly carry taskRoleBinding");
  for (const field of ["bindingKind", "role", "phase", "taskClass", "workId", "pack", "taskNamePrefix", "scopeMarker"]) {
    if (briefTemplate.taskRoleBinding[field] !== bindingTuple[field]) return failure("DISPATCH_BRIEF_ROLE_BINDING_MISMATCH", `brief taskRoleBinding ${field} differs from the role contract`, { field, expected: bindingTuple[field] ?? null, actual: briefTemplate.taskRoleBinding[field] ?? null });
  }
  if (!Object.hasOwn(briefTemplate.taskRoleBinding, "personaProfileId") || briefTemplate.taskRoleBinding.personaProfileId !== null) return failure("DISPATCH_PERSONA_PROFILE_FORBIDDEN", "brief taskRoleBinding must preserve personaProfileId=null", { actual: briefTemplate.taskRoleBinding.personaProfileId ?? "missing" });
  if (!isRecord(briefTemplate.technicalPack) || briefTemplate.technicalPack.path !== technicalPackInput.path || briefTemplate.technicalPack.sha256 !== technicalPackInput.sha256) return failure("DISPATCH_BRIEF_PACK_MISMATCH", "brief technical Pack bytes differ from the governed Pack input", { expected: { path: technicalPackInput.path, sha256: technicalPackInput.sha256 }, actual: briefTemplate.technicalPack ?? null });
  for (const [field, expected] of Object.entries(DISPATCH_BRIEF_DECLARATIONS)) {
    if (briefTemplate[field] !== expected) return failure("DISPATCH_DECLARATION_MISMATCH", `brief template ${field} differs from the readiness contract`, { field, expected, actual: briefTemplate[field] ?? null });
  }
  if (briefTemplate.storyScope !== undefined && briefTemplate.storyScope !== liveScope) return failure("DISPATCH_BRIEF_SCOPE_STALE", "brief template contains a scope that differs from current live work-show");
  if (briefTemplate.baseline !== undefined && (!isRecord(briefTemplate.baseline) || briefTemplate.baseline.sha256 !== baselineInput.sha256 || briefTemplate.baseline.version !== status.version || briefTemplate.baseline.headEventHash !== status.headEventHash)) {
    return failure("DISPATCH_BRIEF_BASELINE_MISMATCH", "brief template contains a stale B-star binding", { expected: { sha256: baselineInput.sha256, version: status.version, headEventHash: status.headEventHash }, actual: briefTemplate.baseline });
  }
  for (const [field, expected] of [["phase", binding.phase], ["role", binding.role], ["pack", binding.pack], ["workId", workId]]) {
    if (templateLifecycle[field] !== undefined && templateLifecycle[field] !== expected) return failure("DISPATCH_LIFECYCLE_BINDING_MISMATCH", `brief lifecycle ${field} differs from the task-role binding`, { field, expected, actual: templateLifecycle[field] });
  }
  for (const [field, expected] of [["newInstance", true], ["forkTurns", "none"], ["sameTaskRunning", false]]) {
    if (templateLifecycle[field] !== undefined && templateLifecycle[field] !== expected) return failure("DISPATCH_LIFECYCLE_INVALID", `brief lifecycle ${field} differs from the fresh task-role binding`, { field, expected, actual: templateLifecycle[field] });
  }
  const expectedPredecessor = binding.predecessor ?? null;
  if (templateLifecycle.predecessor !== undefined && stableJson(templateLifecycle.predecessor) !== stableJson(expectedPredecessor)) return failure("DISPATCH_PREDECESSOR_BINDING_MISMATCH", "brief predecessor differs from the task-role binding");
  const expectedPredecessorEvidence = binding.predecessorEvidence ?? null;
  if (templateLifecycle.predecessorEvidence !== undefined && stableJson(templateLifecycle.predecessorEvidence) !== stableJson(expectedPredecessorEvidence)) return failure("DISPATCH_PREDECESSOR_EVIDENCE_MISMATCH", "brief predecessor evidence differs from the task-role binding");
  if (templateLifecycle.model !== undefined && templateLifecycle.model !== resolved.resolution.value.model) return failure("DISPATCH_MODEL_MISMATCH", "caller brief model differs from the engine resolution", { expected: resolved.resolution.value.model, actual: templateLifecycle.model });
  if (templateLifecycle.effort !== undefined && templateLifecycle.effort !== resolved.resolution.value.effort) return failure("DISPATCH_EFFORT_MISMATCH", "caller brief effort differs from the engine resolution", { expected: resolved.resolution.value.effort, actual: templateLifecycle.effort });
  if (briefTemplate.structuredHandoff !== undefined) {
    const handoff = briefTemplate.structuredHandoff;
    const handoffLifecycle = handoff?.lifecycle ?? handoff?.agentLifecycle;
    if (!isRecord(handoff) || handoff.workId !== workId || handoff.role !== binding.role || handoff.pack !== binding.pack || !isRecord(handoffLifecycle) || handoffLifecycle.phase !== binding.phase || handoffLifecycle.role !== binding.role || handoffLifecycle.pack !== binding.pack || handoffLifecycle.workId !== workId) {
      return failure("DISPATCH_HANDOFF_BINDING_MISMATCH", "brief structuredHandoff declarations contradict the task-role binding");
    }
  }
  const sourceEvidence = [
    { kind: "artifact", locator: bindingInput.path, digest: bindingInput.sha256, status: "verified" },
    { kind: "artifact", locator: briefInput.path, digest: briefInput.sha256, status: "verified" },
    { kind: "artifact", locator: technicalPackInput.path, digest: technicalPackInput.sha256, status: "verified" },
    ...(predecessorEvidenceInput ? [{ kind: "artifact", locator: predecessorEvidenceInput.path, digest: predecessorEvidenceInput.sha256, status: "verified" }] : []),
    { kind: "work-show", locator: `${workId}@${liveWork.record.revision}`, digest: liveWork.record.scopeDigest, status: "verified" },
    { kind: "artifact", locator: baselineInput.path, digest: baselineInput.sha256, status: "verified" },
  ];
  if (templateLifecycle.sourceEvidence !== undefined && stableJson(templateLifecycle.sourceEvidence) !== stableJson(sourceEvidence)) return failure("DISPATCH_LIFECYCLE_SOURCE_EVIDENCE_MISMATCH", "caller lifecycle sourceEvidence differs from independently observed preparation inputs");
  const lifecycle = {
    ...templateLifecycle,
    schemaVersion: "tcrn.agent-lifecycle.v1",
    phase: binding.phase,
    role: binding.role,
    pack: binding.pack,
    workId,
    model: resolved.resolution.value.model,
    effort: resolved.resolution.value.effort,
    newInstance: true,
    forkTurns: "none",
    sameTaskRunning: false,
    sourceEvidence,
  };
  // The lifecycle schema treats predecessor as optional object metadata. A
  // binding's absent or explicit-null predecessor is represented by omission
  // in lifecycle (while the receipt taskRole tuple carries canonical null).
  // Terminal predecessor objects are retained with their evidence.
  if (expectedPredecessor === null) delete lifecycle.predecessor;
  else lifecycle.predecessor = expectedPredecessor;
  if (expectedPredecessorEvidence === null) delete lifecycle.predecessorEvidence;
  else lifecycle.predecessorEvidence = expectedPredecessorEvidence;
  const effectiveBrief = {
    ...briefTemplate,
    repositoryRoot: ENGINE_ROOT,
    workId,
    storyId: workId,
    taskClass: binding.taskClass,
    host: binding.host,
    mode: resolved.resolution.mode,
    storyScope: liveScope,
    lifecycleRequired: true,
    agentLifecycle: lifecycle,
    structuredHandoff: {
      schemaVersion: "tcrn.structured-handoff.v1",
      workId,
      role: binding.role,
      pack: binding.pack,
      lifecycle,
    },
    taskRoleBinding: briefTemplate.taskRoleBinding,
    technicalPack: briefTemplate.technicalPack,
    baseline: { path: baselineInput.path, sha256: baselineInput.sha256, version: status.version, headEventHash: status.headEventHash },
  };
  if (briefTemplate.contextPlanRequired === true || briefTemplate.contextPlan !== undefined) {
    if (!isRecord(briefTemplate.contextPlan)) return failure("DISPATCH_CONTEXT_PLAN_REQUIRED", "a code-owned pre-spawn context package requires an explicit contextPlan");
    effectiveBrief.contextPlanRequired = true;
    effectiveBrief.contextPackage = buildBoundedContextPackage({ plan: briefTemplate.contextPlan, brief: effectiveBrief, binding, workId, status, liveWork, prepared: resolved });
  }
  Object.assign(effectiveBrief, DISPATCH_BRIEF_DECLARATIONS);
  const scopeMarkerSha256 = typeof binding.scopeMarker === "string" ? digestBytes(Buffer.from(binding.scopeMarker, "utf8")) : null;
  const bindingCheck = validateTaskRoleBinding({ binding, brief: effectiveBrief, liveWork, liveScope, roleContractSha256: bindingInput.sha256, briefTemplateSha256: briefInput.sha256, technicalPack: { path: technicalPackInput.path, sha256: technicalPackInput.sha256 }, scopeMarkerSha256, prepared: resolved });
  if (!bindingCheck.ok) return failure("DISPATCH_TASK_BINDING_INVALID", "role/work/Pack/phase is not bound to the live scope and effective brief", { bindingCheck });
  const nativeInput = buildNativeSpawnInput(resolved, lifecycle);
  if (!nativeInput.ok) return failure("DISPATCH_LIFECYCLE_INVALID", "the engine-resolved task binding is not dispatchable", { nativeInput });
  const briefVerdict = validateDispatchBrief(effectiveBrief);
  if (!briefVerdict.ok) return failure("DISPATCH_BRIEF_INVALID", "the effective dispatch brief is not valid", { briefVerdict });
  const finalStatus = readCliJson(["status", "--workspace", workspaceRoot], "status-after-resolution");
  if (!finalStatus.ok || finalStatus.value.version !== status.version || finalStatus.value.headEventHash !== status.headEventHash) {
    return failure("DISPATCH_CHAIN_CHANGED_DURING_PREPARATION", "the chain moved while preparing the receipt", { before: { version: status.version, headEventHash: status.headEventHash }, after: finalStatus.value ?? finalStatus });
  }

  const effectiveBriefBytes = canonicalJsonBytes(effectiveBrief);
  const receipt = {
    schemaVersion: DISPATCH_PRESPAWN_RECEIPT_SCHEMA,
    bindingKind: binding.bindingKind,
    personaProfileId: null,
    taskRole: bindingTuple,
    roleContract: { path: bindingInput.path, bytes: bindingInput.bytes.length, sha256: bindingInput.sha256 },
    technicalPack: { path: technicalPackInput.path, bytes: technicalPackInput.bytes.length, sha256: technicalPackInput.sha256 },
    briefTemplate: { path: briefInput.path, bytes: briefInput.bytes.length, sha256: briefInput.sha256 },
    effectiveBrief: { sha256: digestBytes(effectiveBriefBytes), bytes: effectiveBriefBytes.length, content: effectiveBrief },
    briefVerdict,
    baseline: { path: baselineInput.path, bytes: baselineInput.bytes.length, sha256: baselineInput.sha256, version: status.version, headEventHash: status.headEventHash, content: baseline },
    workspace: { path: workspaceRoot, id: status.workspaceId, version: status.version, headEventHash: status.headEventHash, configDigest: resolved.source.configDigest },
    completeQueue: { total: workList.total, returned: workList.records.length, truncated: workList.truncated, sha256: workList.stdoutSha256, bytes: workList.stdoutBytes },
    liveWork: { id: liveWork.record.id, externalKey: liveWork.record.externalKey, revision: liveWork.record.revision, scopeDigest: liveWork.record.scopeDigest, status: liveWork.record.status, scopeSha256: digestBytes(Buffer.from(liveScope, "utf8")) },
    resolution: resolved.resolution,
    source: { engine: sourceIdentity, configuration: resolved.source },
    bindingCheck,
    lifecycle: nativeInput.lifecycle,
    actualNextSpawn: { status: "pending-actual-native-spawn", nativeRole: null, childId: null, parentThreadId: null },
    nonClaim: "This is a code-owned pre-spawn resolution receipt; it does not observe a host call, child, native role, plaintext message, or provider authentication.",
  };
  let receiptBytes;
  try {
    receiptBytes = canonicalJsonBytes(receipt);
  } catch (error) {
    return failure(reasonCode(error, "DISPATCH_JSON_VALUE_INVALID"), "pre-spawn receipt could not be encoded as canonical JSON", { field: error?.field ?? null, error: String(error?.message ?? error) });
  }
  const receiptCheck = validatePreSpawnReceiptBytes(receiptBytes);
  if (!receiptCheck.ok) return failure(receiptCheck.reasonCode, "generated pre-spawn receipt failed its own canonical schema verifier", { receiptCheck });
  const receiptSha256 = digestBytes(receiptBytes);
  const taskName = `${binding.taskNamePrefix}_${receiptSha256}`;
  return {
    schemaVersion: DISPATCH_PRESPAWN_RECEIPT_SCHEMA,
    ok: true,
    status: "ready",
    reasonCode: "DISPATCH_PRESPAWN_RECEIPT_READY",
    receipt,
    receiptBytes,
    receiptSha256,
    taskName,
    model: resolved.resolution.value.model,
    effort: resolved.resolution.value.effort,
    forkTurns: "none",
    workspace: receipt.workspace,
    evidenceDuties: binding.evidenceDuties ?? [],
    nativeObservation: { status: "pending", nativeRole: null, childId: null },
  };
}

export function validatePreSpawnReceiptBytes(receiptBytes) {
  let bytes;
  try { bytes = Buffer.isBuffer(receiptBytes) ? receiptBytes : Buffer.from(receiptBytes, "utf8"); } catch (error) {
    return failure("DISPATCH_RECEIPT_BYTES_INVALID", "receipt bytes are not readable", { error: String(error?.message ?? error) });
  }
  let receipt;
  try { receipt = JSON.parse(bytes.toString("utf8")); } catch (error) {
    return failure("DISPATCH_RECEIPT_JSON_INVALID", "receipt is not valid JSON", { error: String(error?.message ?? error) });
  }
  if (!isRecord(receipt) || receipt.schemaVersion !== DISPATCH_PRESPAWN_RECEIPT_SCHEMA) return failure("DISPATCH_RECEIPT_SCHEMA_INVALID", "pre-spawn receipt schemaVersion is invalid");
  const selfReference = (value, location = "$", active = new Set()) => {
    if (value === null || typeof value !== "object") return null;
    if (active.has(value)) return { location, key: "cycle" };
    active.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (["receiptSha256", "taskName", "task_name"].includes(key)) return { location: `${location}.${key}`, key };
      const found = selfReference(child, `${location}.${key}`, active);
      if (found) return found;
    }
    active.delete(value);
    return null;
  };
  const selfReferenceFound = selfReference(receipt);
  if (selfReferenceFound) return failure("DISPATCH_RECEIPT_SELF_REFERENCE_FORBIDDEN", "receipt bytes cannot contain their own digest or derived task name", { location: selfReferenceFound.location });
  if (receipt.bindingKind !== "governed-task-role" || receipt.personaProfileId !== null || !isRecord(receipt.taskRole) || receipt.taskRole.bindingKind !== "governed-task-role" || receipt.taskRole.personaProfileId !== null) return failure("DISPATCH_RECEIPT_TASK_ROLE_INVALID", "receipt must preserve the governed task role and personaProfileId=null");
  const taskRole = receipt.taskRole;
  for (const field of ["role", "phase", "taskClass", "workId", "pack", "scopeMarker"]) {
    if (typeof taskRole[field] !== "string" || taskRole[field].trim().length === 0) return failure("DISPATCH_RECEIPT_TASK_ROLE_INVALID", `receipt taskRole.${field} is required`);
  }
  if (!safeTaskPrefix(taskRole.taskNamePrefix)) return failure("DISPATCH_TASK_NAME_PREFIX_INVALID", "receipt task-name prefix is invalid");
  const resolution = receipt.resolution;
  if (!isRecord(resolution) || !isRecord(resolution.value) || typeof resolution.host !== "string" || typeof resolution.taskClass !== "string" || typeof resolution.mode !== "string" || typeof resolution.value.model !== "string" || typeof resolution.value.effort !== "string" || resolution.taskClass !== taskRole.taskClass) {
    return failure("DISPATCH_RECEIPT_RESOLUTION_INVALID", "receipt must retain the exact engine-resolved tuple");
  }
  const lifecycle = receipt.lifecycle;
  if (!isRecord(lifecycle) || lifecycle.phase !== taskRole.phase || lifecycle.role !== taskRole.role || lifecycle.pack !== taskRole.pack || lifecycle.workId !== taskRole.workId || lifecycle.model !== resolution.value.model || lifecycle.effort !== resolution.value.effort || lifecycle.newInstance !== true || lifecycle.forkTurns !== "none" || lifecycle.sameTaskRunning !== false || Object.hasOwn(lifecycle, "agentId")) {
    return failure("DISPATCH_RECEIPT_LIFECYCLE_INVALID", "pre-spawn lifecycle must match the bound role/work/Pack and contain no child id claim");
  }
  const nextSpawn = receipt.actualNextSpawn;
  if (!isRecord(nextSpawn) || nextSpawn.status !== "pending-actual-native-spawn" || nextSpawn.nativeRole !== null || nextSpawn.childId !== null || nextSpawn.parentThreadId !== null) {
    return failure("DISPATCH_RECEIPT_OBSERVATION_INVALID", "pre-spawn receipt must leave actual native association pending and unknown");
  }
  if (!isRecord(receipt.workspace) || !Number.isSafeInteger(receipt.workspace.version) || typeof receipt.workspace.headEventHash !== "string" || typeof receipt.workspace.configDigest !== "string") {
    return failure("DISPATCH_RECEIPT_WORKSPACE_INVALID", "receipt must bind the current chain and dispatch configuration");
  }
  if (!isRecord(receipt.baseline) || !isSha256(receipt.baseline.sha256) || receipt.baseline.version !== receipt.workspace.version || receipt.baseline.headEventHash !== receipt.workspace.headEventHash || !isRecord(receipt.baseline.content)) {
    return failure("DISPATCH_RECEIPT_BASELINE_INVALID", "receipt B-star baseline does not match its live workspace head");
  }
  const baselineContent = receipt.baseline.content;
  if (baselineContent.workspace?.id !== receipt.workspace.id || baselineContent.workspace?.version !== receipt.workspace.version || baselineContent.workspace?.headEventHash !== receipt.workspace.headEventHash) {
    return failure("DISPATCH_RECEIPT_BASELINE_CONTENT_INVALID", "embedded B-star content does not match the receipt workspace binding");
  }
  if (!isRecord(receipt.liveWork) || receipt.liveWork.id !== taskRole.workId || !Number.isSafeInteger(receipt.liveWork.revision) || !isSha256(receipt.liveWork.scopeDigest) || receipt.liveWork.status !== "active" || !isSha256(receipt.liveWork.scopeSha256)) {
    return failure("DISPATCH_RECEIPT_LIVE_WORK_INVALID", "receipt must bind the active live work revision and scope digest");
  }
  if (!isRecord(receipt.completeQueue) || receipt.completeQueue.truncated !== false || !Number.isSafeInteger(receipt.completeQueue.total) || receipt.completeQueue.returned !== receipt.completeQueue.total || !isSha256(receipt.completeQueue.sha256)) {
    return failure("DISPATCH_RECEIPT_QUEUE_INVALID", "receipt must bind a complete current work list");
  }
  if (!isRecord(receipt.roleContract) || !isSha256(receipt.roleContract.sha256) || !isRecord(receipt.technicalPack) || !isSha256(receipt.technicalPack.sha256) || !isRecord(receipt.briefTemplate) || !isSha256(receipt.briefTemplate.sha256) || !isRecord(receipt.effectiveBrief) || !isSha256(receipt.effectiveBrief.sha256) || !Number.isSafeInteger(receipt.effectiveBrief.bytes)) {
    return failure("DISPATCH_RECEIPT_INPUT_DIGEST_INVALID", "receipt must digest-bind its role contract, Pack, template, and effective brief");
  }
  const effectiveBrief = receipt.effectiveBrief.content;
  if (!isRecord(effectiveBrief)) return failure("DISPATCH_RECEIPT_EFFECTIVE_BRIEF_INVALID", "effective brief content is missing");
  const effectiveBriefBytes = canonicalJsonBytes(effectiveBrief);
  if (effectiveBriefBytes.length !== receipt.effectiveBrief.bytes || digestBytes(effectiveBriefBytes) !== receipt.effectiveBrief.sha256) {
    return failure("DISPATCH_RECEIPT_EFFECTIVE_BRIEF_DIGEST_MISMATCH", "effective brief canonical bytes do not match their digest");
  }
  if (effectiveBrief.contextPlanRequired === true) {
    const current = effectiveBrief.contextPackage?.current;
    if (current?.workspaceId !== receipt.workspace.id || current?.version !== receipt.workspace.version || current?.headEventHash !== receipt.workspace.headEventHash || current?.configDigest !== receipt.workspace.configDigest || current?.workRevision !== receipt.liveWork.revision || current?.scopeDigest !== receipt.liveWork.scopeDigest) {
      return failure("DISPATCH_RECEIPT_CONTEXT_PACKAGE_BINDING_MISMATCH", "bounded context package differs from the receipt's current workspace and live work observations");
    }
  }
  const effectiveBinding = effectiveBrief.taskRoleBinding;
  if (!isRecord(effectiveBinding) || effectiveBinding.bindingKind !== taskRole.bindingKind || effectiveBinding.role !== taskRole.role || effectiveBinding.personaProfileId !== null || effectiveBinding.phase !== taskRole.phase || effectiveBinding.taskClass !== taskRole.taskClass || effectiveBinding.workId !== taskRole.workId || effectiveBinding.pack !== taskRole.pack || effectiveBinding.taskNamePrefix !== taskRole.taskNamePrefix || effectiveBinding.scopeMarker !== taskRole.scopeMarker || stableJson(effectiveBinding.predecessor ?? null) !== stableJson(taskRole.predecessor ?? null) || stableJson(effectiveBinding.predecessorEvidence ?? null) !== stableJson(taskRole.predecessorEvidence ?? null)) {
    return failure("DISPATCH_RECEIPT_EFFECTIVE_BINDING_MISMATCH", "effective brief task binding differs from the canonical receipt");
  }
  if (typeof effectiveBrief.storyScope !== "string" || effectiveBrief.storyScope.trim().length === 0) {
    return failure("DISPATCH_RECEIPT_SCOPE_AUTHORITY_MISSING", "effective brief storyScope must be a non-empty string", {
      location: "$.effectiveBrief.content.storyScope",
      valueType: effectiveBrief.storyScope === null ? "null" : Array.isArray(effectiveBrief.storyScope) ? "array" : typeof effectiveBrief.storyScope,
    });
  }
  const scopeMarkerSha256 = digestBytes(Buffer.from(taskRole.scopeMarker, "utf8"));
  if (!effectiveBrief.storyScope.includes(taskRole.scopeMarker) || !effectiveBrief.storyScope.includes(receipt.roleContract.sha256)
    || !effectiveBrief.storyScope.includes(receipt.briefTemplate.sha256) || !effectiveBrief.storyScope.includes(receipt.technicalPack.sha256)
    || !effectiveBrief.storyScope.includes(scopeMarkerSha256)) {
    return failure("DISPATCH_RECEIPT_SCOPE_AUTHORITY_MISSING", "effective brief scope does not carry the role, brief, marker, and technical Pack digests");
  }
  const lifecycleVerdict = validateAgentLifecycle(lifecycle);
  const briefVerdict = validateDispatchBrief(effectiveBrief);
  if (!lifecycleVerdict.ok || !briefVerdict.ok || typeof effectiveBrief.storyScope !== "string" || !isRecord(receipt.liveWork) || digestBytes(Buffer.from(effectiveBrief.storyScope, "utf8")) !== receipt.liveWork.scopeSha256) {
    return failure("DISPATCH_RECEIPT_EFFECTIVE_BRIEF_SEMANTIC_INVALID", "effective brief scope or lifecycle does not validate", { lifecycleVerdict, briefVerdict });
  }
  if (stableJson(receipt.briefVerdict) !== stableJson(briefVerdict)) return failure("DISPATCH_RECEIPT_BRIEF_VERDICT_MISMATCH", "stored brief verdict differs from independent validation");
  const lifecycleEvidence = Array.isArray(lifecycle.sourceEvidence) ? lifecycle.sourceEvidence : [];
  const hasVerifiedArtifact = digest => lifecycleEvidence.some(entry => entry?.kind === "artifact" && entry?.digest === digest && entry?.status === "verified");
  if (!hasVerifiedArtifact(receipt.roleContract.sha256) || !hasVerifiedArtifact(receipt.briefTemplate.sha256) || !hasVerifiedArtifact(receipt.technicalPack.sha256) || !hasVerifiedArtifact(receipt.baseline.sha256)) {
    return failure("DISPATCH_RECEIPT_SOURCE_EVIDENCE_INCOMPLETE", "lifecycle evidence must bind the role contract, brief, Pack, and B-star bytes");
  }
  if (!lifecycleEvidence.some(entry => entry?.kind === "work-show" && entry?.digest === receipt.liveWork.scopeDigest && entry?.status === "verified")) {
    return failure("DISPATCH_RECEIPT_WORK_SHOW_EVIDENCE_MISSING", "lifecycle evidence must bind the current primary work-show scope digest");
  }
  if (taskRole.predecessor !== null && taskRole.predecessor !== undefined) {
    if (!isRecord(taskRole.predecessorEvidence) || !hasVerifiedArtifact(taskRole.predecessorEvidence.sha256) || stableJson(lifecycle.predecessor ?? null) !== stableJson(taskRole.predecessor) || stableJson(lifecycle.predecessorEvidence ?? null) !== stableJson(taskRole.predecessorEvidence)) {
      return failure("DISPATCH_RECEIPT_PREDECESSOR_EVIDENCE_MISSING", "terminal predecessor and its raw observation digest must be retained");
    }
  } else if (taskRole.predecessorEvidence !== null && taskRole.predecessorEvidence !== undefined) {
    return failure("DISPATCH_RECEIPT_PREDECESSOR_EVIDENCE_INVALID", "predecessor evidence cannot be present without a terminal predecessor");
  } else if (stableJson(lifecycle.predecessor ?? null) !== "null" || stableJson(lifecycle.predecessorEvidence ?? null) !== "null") {
    return failure("DISPATCH_RECEIPT_PREDECESSOR_BINDING_MISMATCH", "absent predecessor fields must remain null in lifecycle metadata");
  }
  if (effectiveBrief.workId !== receipt.liveWork.id || effectiveBrief.storyId !== receipt.liveWork.id || effectiveBrief.taskClass !== taskRole.taskClass || effectiveBrief.host !== resolution.host || effectiveBrief.mode !== resolution.mode || effectiveBrief.technicalPack?.sha256 !== receipt.technicalPack.sha256) {
    return failure("DISPATCH_RECEIPT_EFFECTIVE_BRIEF_BINDING_MISMATCH", "effective brief work/taskClass/host/mode/Pack differs from the receipt");
  }
  if (!isRecord(effectiveBrief.baseline) || effectiveBrief.baseline.sha256 !== receipt.baseline.sha256 || effectiveBrief.baseline.version !== receipt.workspace.version || effectiveBrief.baseline.headEventHash !== receipt.workspace.headEventHash || effectiveBrief.technicalPack?.path !== receipt.technicalPack.path) {
    return failure("DISPATCH_RECEIPT_EFFECTIVE_BASELINE_MISMATCH", "effective brief baseline or Pack path differs from the receipt");
  }
  const primaryBaselineBinding = Array.isArray(baselineContent.workBindings) ? baselineContent.workBindings.find(binding => binding?.id === receipt.liveWork.id) : null;
  if (baselineContent.primaryExternalKey !== receipt.liveWork.externalKey || primaryBaselineBinding?.revision !== receipt.liveWork.revision || primaryBaselineBinding?.scopeDigest !== receipt.liveWork.scopeDigest || primaryBaselineBinding?.status !== receipt.liveWork.status) {
    return failure("DISPATCH_RECEIPT_BASELINE_WORK_BINDING_INVALID", "B-star does not carry the primary work revision and scope digest");
  }
  if (baselineContent.queue?.truncated !== false || baselineContent.queue?.total !== receipt.completeQueue.total || baselineContent.queue?.returned !== receipt.completeQueue.returned || baselineContent.queue?.workListSha256 !== receipt.completeQueue.sha256) {
    return failure("DISPATCH_RECEIPT_BASELINE_QUEUE_INVALID", "embedded B-star queue summary differs from the receipt");
  }
  if (receipt.source?.configuration?.workspaceId !== receipt.workspace.id || receipt.source?.configuration?.version !== receipt.workspace.version || receipt.source?.configuration?.headEventHash !== receipt.workspace.headEventHash || receipt.source?.configuration?.configDigest !== receipt.workspace.configDigest) {
    return failure("DISPATCH_RECEIPT_SOURCE_BINDING_INVALID", "engine configuration source differs from the workspace binding");
  }
  if (receipt.source?.engine?.commit !== baselineContent.sourceIdentities?.engine?.commit || receipt.source?.engine?.tree !== baselineContent.sourceIdentities?.engine?.tree || receipt.source?.engine?.worktreeClean !== true || baselineContent.sourceIdentities?.engine?.worktreeClean !== true) {
    return failure("DISPATCH_RECEIPT_ENGINE_SOURCE_INVALID", "receipt engine source identity differs from B-star");
  }
  const reconstructedBinding = {
    ...taskRole,
    primaryWorkId: taskRole.workId,
    primaryExternalKey: receipt.liveWork.externalKey,
    host: resolution.host,
    mode: resolution.mode,
  };
  const reconstructedBindingCheck = validateTaskRoleBinding({
    binding: reconstructedBinding,
    brief: effectiveBrief,
    liveWork: { advisory: { scope: effectiveBrief.storyScope }, record: { ...receipt.liveWork, tombstone: false } },
    liveScope: effectiveBrief.storyScope,
    roleContractSha256: receipt.roleContract.sha256,
    briefTemplateSha256: receipt.briefTemplate.sha256,
    technicalPack: receipt.technicalPack,
    scopeMarkerSha256,
    prepared: { resolution },
  });
  if (!reconstructedBindingCheck.ok || stableJson(receipt.bindingCheck) !== stableJson(reconstructedBindingCheck)) {
    return failure("DISPATCH_RECEIPT_TASK_BINDING_RESULT_MISMATCH", "stored task-binding result differs from independent validation", { reconstructedBindingCheck });
  }
  const canonical = canonicalJsonBytes(receipt);
  if (!canonical.equals(bytes)) return failure("DISPATCH_RECEIPT_NOT_CANONICAL", "receipt bytes are not canonical JSON with one trailing newline");
  const receiptSha256 = digestBytes(bytes);
  const prefix = receipt.taskRole?.taskNamePrefix;
  if (!safeTaskPrefix(prefix)) return failure("DISPATCH_TASK_NAME_PREFIX_INVALID", "receipt task-name prefix is invalid");
  return {
    schemaVersion: DISPATCH_PRESPAWN_RECEIPT_SCHEMA,
    ok: true,
    status: "verified-bytes",
    reasonCode: "DISPATCH_PRESPAWN_RECEIPT_BYTES_VALID",
    receipt,
    receiptSha256,
    taskName: `${prefix}_${receiptSha256}`,
  };
}

export function comparePreSpawnReceiptBytes(savedReceiptBytes, currentReceiptBytes) {
  const saved = validatePreSpawnReceiptBytes(savedReceiptBytes);
  if (!saved.ok) return failure("DISPATCH_SAVED_RECEIPT_INVALID", "saved pre-spawn receipt bytes are invalid", { saved });
  const current = validatePreSpawnReceiptBytes(currentReceiptBytes);
  if (!current.ok) return failure("DISPATCH_CURRENT_RECEIPT_INVALID", "current pre-spawn receipt bytes are invalid", { current });
  const savedBytes = Buffer.isBuffer(savedReceiptBytes) ? savedReceiptBytes : Buffer.from(savedReceiptBytes, "utf8");
  const currentBytes = Buffer.isBuffer(currentReceiptBytes) ? currentReceiptBytes : Buffer.from(currentReceiptBytes, "utf8");
  if (!savedBytes.equals(currentBytes) || saved.receiptSha256 !== current.receiptSha256) {
    return failure("DISPATCH_PRESPAWN_RECEIPT_STALE", "saved receipt no longer matches deterministic current inputs", {
      expectedSha256: current.receiptSha256,
      actualSha256: saved.receiptSha256,
      expectedTaskName: current.taskName,
      actualTaskName: saved.taskName,
    });
  }
  return { schemaVersion: DISPATCH_PRESPAWN_RECEIPT_SCHEMA, ok: true, status: "current", reasonCode: "DISPATCH_PRESPAWN_RECEIPT_CURRENT", receiptSha256: saved.receiptSha256, taskName: saved.taskName };
}

/** Recompute the receipt from current chain/config/source reads and compare exact bytes. */
export async function verifyPreSpawnReceipt({ receiptBytes, workspace, roleBindingPath, briefTemplatePath, baselinePath } = {}) {
  const observed = validatePreSpawnReceiptBytes(receiptBytes);
  if (!observed.ok) return observed;
  const current = await preparePreSpawnReceipt({ workspace, roleBindingPath, briefTemplatePath, baselinePath });
  if (!current.ok) return failure("DISPATCH_PRESPAWN_REPLAY_REFUSED", "current role/work/Pack/config/source inputs no longer produce a valid receipt", { current });
  const comparison = comparePreSpawnReceiptBytes(receiptBytes, current.receiptBytes);
  if (!comparison.ok) return comparison;
  return {
    schemaVersion: DISPATCH_PRESPAWN_RECEIPT_SCHEMA,
    ok: true,
    status: "current",
    reasonCode: "DISPATCH_PRESPAWN_RECEIPT_CURRENT",
    receiptSha256: observed.receiptSha256,
    taskName: observed.taskName,
    model: current.model,
    effort: current.effort,
    forkTurns: current.forkTurns,
    source: current.receipt.source,
    workspace: current.workspace,
  };
}

/**
 * Join the frozen receipt to actual native tool and child observations. Missing
 * records stay not-verifiable; contradictory tuples or swapped/terminal child
 * ids are red. Raw host role and encrypted prompt fields are carried through
 * as unknown and never authenticate the task binding.
 */
export function validatePreSpawnAssociation({ receiptBytes, spawnCall, spawnResult, activity, childSessionMeta, turnContext } = {}) {
  const parsed = validatePreSpawnReceiptBytes(receiptBytes);
  if (!parsed.ok) return { ...parsed, status: "red", reasonCode: parsed.reasonCode };
  const missing = [];
  for (const [field, value] of Object.entries({ spawnCall, spawnResult, activity, childSessionMeta, turnContext })) {
    if (!isRecord(value)) missing.push(field);
  }
  if (missing.length > 0) return {
    schemaVersion: "tcrn.dispatch-association.v1",
    ok: false,
    status: "not-verifiable",
    reasonCode: "DISPATCH_ASSOCIATION_OBSERVATION_MISSING",
    missing,
    receiptSha256: parsed.receiptSha256,
    taskName: parsed.taskName,
    unknowns: ["actual native role", "encrypted prompt plaintext", "provider authentication"],
  };

  const receipt = parsed.receipt;
  const callEnvelope = isRecord(spawnCall.payload) ? spawnCall.payload : spawnCall;
  const resultEnvelope = isRecord(spawnResult.payload) ? spawnResult.payload : spawnResult;
  const activityEnvelope = isRecord(activity.payload) ? activity.payload : activity;
  const childMeta = isRecord(childSessionMeta.payload) ? childSessionMeta.payload : childSessionMeta;
  const context = isRecord(turnContext.payload) ? turnContext.payload : turnContext;
  const spawnArgs = isRecord(callEnvelope.arguments)
    ? callEnvelope.arguments
    : typeof callEnvelope.arguments === "string"
      ? (() => { try { return JSON.parse(callEnvelope.arguments); } catch { return null; } })()
      : null;
  const mismatches = [];
  if (callEnvelope.name !== "spawn_agent") mismatches.push({ code: "DISPATCH_ASSOCIATION_TOOL_MISMATCH", field: "spawnCall.name", expected: "spawn_agent", actual: callEnvelope.name ?? null });
  if (!isRecord(spawnArgs)) mismatches.push({ code: "DISPATCH_ASSOCIATION_SPAWN_INPUT_INVALID", field: "spawnCall.arguments" });
  const callId = spawnCall.callId ?? spawnCall.call_id ?? callEnvelope.call_id ?? null;
  if (typeof callId !== "string" || callId.length === 0) mismatches.push({ code: "DISPATCH_ASSOCIATION_CALL_ID_MISSING", field: "spawnCall.callId" });
  const actualTaskName = spawnArgs?.task_name;
  if (actualTaskName !== parsed.taskName) mismatches.push({ code: "DISPATCH_ASSOCIATION_TASK_NAME_MISMATCH", field: "task_name", expected: parsed.taskName, actual: actualTaskName ?? null });
  const expectedModel = receipt.resolution?.value?.model;
  const expectedEffort = receipt.resolution?.value?.effort;
  const actualModel = spawnArgs?.model;
  const actualEffort = spawnArgs?.reasoning_effort ?? spawnArgs?.effort;
  if (actualModel !== expectedModel) mismatches.push({ code: "DISPATCH_ASSOCIATION_MODEL_MISMATCH", field: "model", expected: expectedModel ?? null, actual: actualModel ?? null });
  if (actualEffort !== expectedEffort) mismatches.push({ code: "DISPATCH_ASSOCIATION_EFFORT_MISMATCH", field: "effort", expected: expectedEffort ?? null, actual: actualEffort ?? null });
  if (spawnArgs?.fork_turns !== "none") mismatches.push({ code: "DISPATCH_ASSOCIATION_FORK_MISMATCH", field: "fork_turns", expected: "none", actual: spawnArgs?.fork_turns ?? null });
  if ((spawnResult.callId ?? spawnResult.call_id ?? resultEnvelope.call_id ?? null) !== callId) mismatches.push({ code: "DISPATCH_ASSOCIATION_RESULT_CALL_MISMATCH", field: "spawnResult.callId" });
  let resultOutput = resultEnvelope.output;
  if (typeof resultOutput === "string") {
    try { resultOutput = JSON.parse(resultOutput); } catch { resultOutput = null; }
  }
  const returnedTaskName = resultEnvelope.task_name ?? resultEnvelope.result?.task_name ?? resultOutput?.task_name ?? null;
  if (typeof returnedTaskName !== "string" || !returnedTaskName.endsWith(parsed.taskName)) mismatches.push({ code: "DISPATCH_ASSOCIATION_RESULT_TASK_MISMATCH", field: "spawnResult.task_name", expectedSuffix: parsed.taskName, actual: returnedTaskName });
  const activityCallId = activity.callId ?? activity.id ?? activityEnvelope.item?.id ?? null;
  if (activityCallId !== callId) mismatches.push({ code: "DISPATCH_ASSOCIATION_ACTIVITY_CALL_MISMATCH", field: "activity.callId", expected: callId, actual: activityCallId });
  const childId = childMeta.id ?? childMeta.threadId ?? null;
  const activityChildId = activity.childId ?? activity.agent_thread_id ?? activityEnvelope.item?.agent_thread_id ?? null;
  if (typeof childId !== "string" || activityChildId !== childId) mismatches.push({ code: "DISPATCH_ASSOCIATION_CHILD_MISMATCH", field: "childId", expected: activityChildId, actual: childId });
  const parentThreadId = activity.parentThreadId ?? activity.thread_id ?? activityEnvelope.thread_id ?? null;
  if (typeof parentThreadId !== "string" || childMeta.parent_thread_id !== parentThreadId || childMeta.session_id !== parentThreadId) mismatches.push({ code: "DISPATCH_ASSOCIATION_PARENT_MISMATCH", field: "parentThreadId", expected: parentThreadId, actual: childMeta.parent_thread_id ?? null });
  const actualAgentPath = childMeta.agent_path ?? childMeta.agentPath ?? null;
  const activityAgentPath = activity.agent_path ?? activity.agentPath ?? activityEnvelope.item?.agent_path ?? null;
  if (typeof actualAgentPath !== "string" || actualAgentPath !== activityAgentPath || basename(actualAgentPath) !== parsed.taskName) mismatches.push({ code: "DISPATCH_ASSOCIATION_PATH_MISMATCH", field: "agentPath", expected: activityAgentPath, actual: actualAgentPath });
  const contextModel = context.model ?? context.collaboration_mode?.settings?.model ?? null;
  const contextEffort = context.effort ?? context.reasoning_effort ?? context.collaboration_mode?.settings?.reasoning_effort ?? null;
  if (contextModel !== expectedModel) mismatches.push({ code: "DISPATCH_ASSOCIATION_CONTEXT_MODEL_MISMATCH", field: "turnContext.model", expected: expectedModel ?? null, actual: contextModel });
  if (contextEffort !== expectedEffort) mismatches.push({ code: "DISPATCH_ASSOCIATION_CONTEXT_EFFORT_MISMATCH", field: "turnContext.effort", expected: expectedEffort ?? null, actual: contextEffort });
  const predecessorId = receipt.lifecycle?.predecessor?.agentId ?? null;
  if (typeof predecessorId === "string" && childId === predecessorId) mismatches.push({ code: "DISPATCH_ASSOCIATION_TERMINAL_INSTANCE_REUSED", field: "childId", predecessorId, actual: childId });

  const nativeAgentRole = childMeta.agentRole ?? childMeta.agent_role ?? childMeta.source?.subagent?.thread_spawn?.agent_role ?? null;
  const result = {
    schemaVersion: "tcrn.dispatch-association.v1",
    ok: mismatches.length === 0,
    status: mismatches.length === 0 ? "green" : "red",
    reasonCode: mismatches.length === 0 ? "DISPATCH_ASSOCIATION_VERIFIED" : "DISPATCH_ASSOCIATION_INVALID",
    receiptSha256: parsed.receiptSha256,
    taskName: parsed.taskName,
    callId,
    parentThreadId,
    childId,
    agentPath: actualAgentPath,
    model: actualModel ?? null,
    effort: actualEffort ?? null,
    forkTurns: spawnArgs?.fork_turns ?? null,
    turnContext: { model: contextModel, effort: contextEffort },
    nativeAgentRole,
    nativeRoleDisposition: nativeAgentRole === null ? "unknown/native null" : "raw host field retained; not used as task authority",
    encryptedPromptPlaintext: "unknown/not independently readable",
    providerAuthentication: "unknown/not claimed",
    mismatches,
  };
  return result;
}

/** Revalidate current receipt inputs before comparing raw native observations. */
export async function verifyPreSpawnDispatch({ receiptBytes, observations, workspace, roleBindingPath, briefTemplatePath, baselinePath } = {}) {
  const receiptReplay = await verifyPreSpawnReceipt({ receiptBytes, workspace, roleBindingPath, briefTemplatePath, baselinePath });
  if (!receiptReplay.ok) return failure("DISPATCH_PRESPAWN_REPLAY_REFUSED", "receipt no longer replays against current engine and chain inputs", { receiptReplay });
  if (!isRecord(observations)) {
    return {
      schemaVersion: "tcrn.dispatch-association.v1",
      ok: false,
      status: "not-verifiable",
      reasonCode: "DISPATCH_ASSOCIATION_OBSERVATION_MISSING",
      missing: ["observations"],
      receiptSha256: receiptReplay.receiptSha256,
      taskName: receiptReplay.taskName,
    };
  }
  const association = validatePreSpawnAssociation({ receiptBytes, ...observations });
  return { ...association, receiptReplay };
}

function compareSource(prepared, current) {
  const expected = prepared?.source;
  const actual = current?.source;
  if (!expected || !actual) return { ok: false, reason: "missing resolution source" };
  for (const field of ["workspaceId", "version", "headEventHash", "configDigest"]) {
    if (expected[field] !== actual[field]) return { ok: false, reason: `${field} changed`, field, expected: expected[field], actual: actual[field] };
  }
  return { ok: true };
}

function invocationValue(invocation, names) {
  for (const name of names) {
    if (invocation && Object.hasOwn(invocation, name)) return invocation[name];
  }
  return undefined;
}

/**
 * Re-resolve and validate the exact native invocation.  This function calls
 * the existing 424 lifecycle evidence validator rather than maintaining a
 * second lifecycle implementation.  Missing host observations remain
 * `not-verifiable`; they are never converted into identity proof.
 */
export async function validateDispatchInvocation({ prepared, invocation, lifecycle, observedLifecycle } = {}) {
  if (!prepared || prepared.schemaVersion !== DISPATCH_ADAPTER_VERSION || prepared.executable !== true) {
    return failure("DISPATCH_RESOLUTION_NOT_EXECUTABLE", "an executable engine resolution is required");
  }
  const request = prepared.resolution;
  const current = await resolveDispatchRequest({
    workspace: prepared.workspace,
    host: request.host,
    taskClass: request.taskClass,
    mode: request.mode,
  });
  if (!current.ok || current.executable !== true) {
    return failure("DISPATCH_REPARSE_REFUSED", "the fresh engine resolution is not executable", { current });
  }
  const sourceComparison = compareSource(prepared, current);
  if (!sourceComparison.ok) {
    return failure("DISPATCH_CONFIG_DRIFT", "dispatch configuration changed after resolution", { sourceComparison, current });
  }
  const actualModel = invocationValue(invocation, ["model", "requestedModel"]);
  const actualEffort = invocationValue(invocation, ["effort", "reasoningEffort", "reasoning_effort"]);
  if (typeof actualModel !== "string" || actualModel.length === 0) {
    return failure("DISPATCH_SPAWN_INPUT_MISSING", "native invocation did not expose model");
  }
  if (typeof actualEffort !== "string" || actualEffort.length === 0) {
    return failure("DISPATCH_SPAWN_INPUT_MISSING", "native invocation did not expose effort");
  }
  if (actualModel !== request.value.model) {
    return failure("DISPATCH_MODEL_MISMATCH", "native invocation model does not match the engine resolution", { expected: request.value.model, actual: actualModel });
  }
  if (actualEffort !== request.value.effort) {
    return failure("DISPATCH_EFFORT_MISMATCH", "native invocation effort does not match the engine resolution", { expected: request.value.effort, actual: actualEffort });
  }
  for (const field of ["workspaceId", "host", "taskClass", "mode"]) {
    const names = field === "taskClass" ? ["taskClass", "dispatchClass", "class"] : [field];
    const actual = invocationValue(invocation, names);
    if (actual !== undefined && actual !== (field === "workspaceId" ? prepared.workspaceId : request[field])) {
      return failure("DISPATCH_INVOCATION_BINDING_MISMATCH", `native invocation ${field} does not match the engine resolution`, { field, expected: field === "workspaceId" ? prepared.workspaceId : request[field], actual });
    }
  }
  if (!isRecord(lifecycle)) return failure("DISPATCH_LIFECYCLE_REQUIRED", "lifecycle binding is required for native dispatch");
  const lifecycleWorkId = invocationValue(lifecycle, ["workId", "work_id", "taskId", "task_id"]);
  if (typeof lifecycleWorkId !== "string" || lifecycleWorkId.trim().length === 0) {
    return failure("DISPATCH_WORK_BINDING_REQUIRED", "lifecycle workId is required for native dispatch");
  }
  const invocationWorkId = invocationValue(invocation, ["workId", "work_id", "taskId", "task_id"]);
  if (invocationWorkId !== undefined && invocationWorkId !== lifecycleWorkId) {
    return failure("DISPATCH_WORK_BINDING_MISMATCH", "native invocation workId does not match the lifecycle binding", { expected: lifecycleWorkId, actual: invocationWorkId });
  }
  const lifecycleClass = invocationValue(lifecycle, ["taskClass", "dispatchClass", "class"]);
  if (lifecycleClass !== undefined && lifecycleClass !== request.taskClass) {
    return failure("DISPATCH_CLASS_MISMATCH", "lifecycle class does not match the engine resolution", { expected: request.taskClass, actual: lifecycleClass });
  }
  const declared = { ...lifecycle, model: lifecycle.model ?? request.value.model, effort: lifecycle.effort ?? request.value.effort };
  const lifecycleEvidence = validateAgentLifecycleEvidence(declared, observedLifecycle);
  if (lifecycleEvidence.status === "red") {
    return failure("DISPATCH_LIFECYCLE_EVIDENCE_RED", "native dispatch lifecycle evidence contradicts the declaration", { lifecycle: lifecycleEvidence });
  }
  if (lifecycleEvidence.status !== "green") {
    return failure("DISPATCH_LIFECYCLE_NOT_VERIFIABLE", "native dispatch lifecycle observation is unavailable or incomplete", { lifecycle: lifecycleEvidence });
  }
  return {
    schemaVersion: DISPATCH_ADAPTER_VERSION,
    ok: true,
    status: "validated",
    reasonCode: "DISPATCH_NATIVE_INVOCATION_VALID",
    source: prepared.source,
    currentSource: current.source,
    resolution: request,
    invocation: { model: actualModel, effort: actualEffort },
    lifecycle: lifecycleEvidence,
  };
}

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
}

function jsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`${label} is not readable JSON: ${error?.message ?? error}`), { reasonCode: "DISPATCH_INPUT_INVALID" });
  }
}

async function main(argv) {
  if (argv.includes("--prepare-receipt")) {
    const preparedReceipt = await preparePreSpawnReceipt({
      workspace: flag(argv, "workspace"),
      roleBindingPath: flag(argv, "role-binding"),
      briefTemplatePath: flag(argv, "brief-template"),
      baselinePath: flag(argv, "baseline"),
    });
    if (!preparedReceipt.ok) return preparedReceipt;
    return {
      schemaVersion: DISPATCH_PRESPAWN_RECEIPT_SCHEMA,
      ok: true,
      reasonCode: preparedReceipt.reasonCode,
      receiptSha256: preparedReceipt.receiptSha256,
      task_name: preparedReceipt.taskName,
      model: preparedReceipt.model,
      reasoning_effort: preparedReceipt.effort,
      fork_turns: preparedReceipt.forkTurns,
      receiptBytesBase64: preparedReceipt.receiptBytes.toString("base64"),
      workspace: preparedReceipt.workspace,
      bindingCheck: preparedReceipt.receipt.bindingCheck,
      effectiveBriefSha256: preparedReceipt.receipt.effectiveBrief.sha256,
      source: preparedReceipt.receipt.source,
    };
  }
  if (argv.includes("--verify-receipt")) {
    const receiptPath = flag(argv, "receipt");
    const input = readRegularInput(receiptPath, "receipt");
    if (!input.ok) return failure(input.reasonCode, "pre-spawn receipt bytes are unreadable", { input });
    return verifyPreSpawnReceipt({
      receiptBytes: input.bytes,
      workspace: flag(argv, "workspace"),
      roleBindingPath: flag(argv, "role-binding"),
      briefTemplatePath: flag(argv, "brief-template"),
      baselinePath: flag(argv, "baseline"),
    });
  }
  if (argv.includes("--verify-association")) {
    const receiptInput = readRegularInput(flag(argv, "receipt"), "receipt");
    if (!receiptInput.ok) return failure(receiptInput.reasonCode, "pre-spawn receipt bytes are unreadable", { input: receiptInput });
    const observationsInput = parseJsonInput(readRegularInput(flag(argv, "observations"), "observations"), "observations");
    if (!observationsInput.ok) return failure(observationsInput.reasonCode, "raw dispatch observations are unreadable", { input: observationsInput });
    return verifyPreSpawnDispatch({
      receiptBytes: receiptInput.bytes,
      observations: observationsInput.value,
      workspace: flag(argv, "workspace"),
      roleBindingPath: flag(argv, "role-binding"),
      briefTemplatePath: flag(argv, "brief-template"),
      baselinePath: flag(argv, "baseline"),
    });
  }
  const workspace = flag(argv, "workspace");
  const host = flag(argv, "host");
  const taskClass = flag(argv, "class");
  const mode = flag(argv, "mode");
  if (!workspace || !host || !taskClass) return failure("DISPATCH_ARGUMENT_MISSING", "--workspace, --host, and --class are required");
  const prepared = await resolveDispatchRequest({ workspace, host, taskClass, mode });
  const lifecyclePath = flag(argv, "lifecycle");
  const observedPath = flag(argv, "observed");
  if (lifecyclePath === undefined && flag(argv, "model") === undefined && flag(argv, "effort") === undefined) return prepared;
  let lifecycle;
  let observed;
  try {
    lifecycle = lifecyclePath === undefined ? undefined : jsonFile(lifecyclePath, "lifecycle");
    observed = observedPath === undefined ? undefined : jsonFile(observedPath, "observed");
  } catch (error) {
    return failure(reasonCode(error, "DISPATCH_INPUT_INVALID"), String(error?.message ?? error));
  }
  return validateDispatchInvocation({
    prepared,
    lifecycle,
    observedLifecycle: observed,
    invocation: { model: flag(argv, "model"), effort: flag(argv, "effort") },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.ok !== true) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failure(reasonCode(error), String(error?.message ?? error)))}\n`);
    process.exitCode = 1;
  }
}
