#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// STORY-371: render the governed dispatch configuration into host-owned files.
// The renderer owns only the fields it declares; all other host configuration is
// carried forward byte-for-byte where the host format permits it.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  readDispatchConfig,
  resolveDispatch,
} from "../dist/build/packages/core/src/index.js";
import { claudeHookSettings, codexHookDocument, hookEntriesFor } from "./host-harness.mjs";

const execFileAsync = promisify(execFile);
export const HOST_RENDER_VERSION = "tcrn.host-render.v1";
export const HOST_RENDER_HOSTS = Object.freeze(["claude-code", "codex"]);
export const HOST_RENDER_SCOPES = Object.freeze(["full", "hooks-only"]);
export const HOST_RENDER_AGENT_DIRECTORY = ".claude/agents";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
const CODEX_CONFIG_PATH = ".codex/config.toml";
const CODEX_HOOKS_PATH = ".codex/hooks.json";
const CLAUDE_BRIDGE_PATH = "CLAUDE.md";
const CLAUDE_EFFORT_ENV = "CLAUDE_CODE_EFFORT_LEVEL";

function failure(reasonCode, message, details = {}) {
  throw Object.assign(new Error(message), { reasonCode, ...details });
}

function renderScope(value) {
  const scope = value === undefined ? "full" : value;
  if (!HOST_RENDER_SCOPES.includes(scope)) {
    failure("HOST_RENDER_SCOPE_INVALID", `scope must be one of ${HOST_RENDER_SCOPES.join(", ")}`);
  }
  return scope;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") || !value.isWellFormed()) {
    failure("HOST_RENDER_INPUT_INVALID", `${label} must be non-empty well-formed text`);
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(value, (_key, child) => {
    if (child === null || typeof child !== "object" || Array.isArray(child)) return child;
    return Object.fromEntries(Object.keys(child).sort().map((key) => [key, child[key]]));
  });
}

function settingsEntries(settings) {
  if (!Array.isArray(settings)) failure("HOST_RENDER_SETTINGS_INVALID", "settings must be an array");
  return settings.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.key !== "string") failure("HOST_RENDER_SETTINGS_INVALID", "setting entry");
    const value = entry.value ?? entry.currentValue ?? entry.defaultValue;
    return { key: entry.key, value: value === null || value === undefined ? "" : String(value) };
  });
}

function readConfig(settings, mode) {
  const entries = settingsEntries(settings);
  const config = readDispatchConfig(entries);
  const selectedMode = mode === undefined ? config.mode : text(mode, "mode");
  if (!Object.hasOwn(config.modes, selectedMode)) failure("HOST_RENDER_MODE_UNKNOWN", `unknown dispatch mode ${selectedMode}`);
  return { config, mode: selectedMode };
}

function resolved(config, host, taskClass, mode) {
  const result = resolveDispatch(config, host, taskClass, mode);
  return result.value === null ? null : { model: result.value.model, effort: result.value.effort, tier: result.resolvedTier };
}

function jsonObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) failure("HOST_RENDER_TARGET_INVALID", `${label} must be a JSON object`);
  return value;
}

function parseJson(bytes, label, fallback = {}) {
  if (bytes === null || bytes === undefined || bytes.length === 0) return structuredClone(fallback);
  try { return jsonObject(JSON.parse(bytes), label); } catch (error) { failure("HOST_RENDER_TARGET_INVALID", `${label} is not valid JSON`, { cause: String(error?.message ?? error) }); }
}

// Exact managed-group identity replaces path-based hook ownership.

function hookGroupIdentity(host, event, group) {
  return stableJson({ host, event, group });
}

function legacyGroupFor(host, event, group) {
  if (!["SubagentStart", "SubagentStop", "Stop", "UserPromptSubmit"].includes(event)) return null;
  const hostName = host === "claude-code" ? "claude" : "codex";
  const suffix = ` --host ${hostName}`;
  const legacy = structuredClone(group);
  let changed = 0;
  if (!Array.isArray(legacy?.hooks)) return null;
  for (const hook of legacy.hooks) {
    if (hook && typeof hook === "object" && typeof hook.command === "string" && hook.command.endsWith(suffix)) {
      hook.command = hook.command.slice(0, -suffix.length);
      changed += 1;
    } else if (hook && typeof hook === "object" && typeof hook.command === "string" && hook.command.endsWith(`${suffix}; fi`)) {
      hook.command = `${hook.command.slice(0, -`${suffix}; fi`.length)}; fi`;
      changed += 1;
    }
  }
  return changed === 0 ? null : legacy;
}

function managedCommandKey(command) {
  if (typeof command !== "string") return null;
  let value = command.trim();
  const guarded = /^if \[ (?:-f "[^"]+"|"\$CLAUDE_PROJECT_DIR" = "[^"]+") \]; then (.+); fi$/u.exec(value);
  if (guarded) value = guarded[1];
  const node = /^node "([^"]+)"(?:\s+--host (?:claude|codex))?$/u.exec(value);
  if (!node) return null;
  const normalized = node[1].replaceAll("\\", "/");
  return normalized.match(/(?:^|\/)((?:scripts|tools)\/[^"'\s]+?\.mjs)$/u)?.[1] ?? null;
}

function semanticGroupIdentity(host, event, group) {
  if (!Array.isArray(group?.hooks)) return null;
  const normalized = structuredClone(group);
  for (const hook of normalized.hooks) {
    const key = managedCommandKey(hook?.command);
    if (key === null) return null;
    hook.command = `__tcrn-managed-hook__:${key}`;
  }
  return hookGroupIdentity(host, event, normalized);
}

function managedGroupSlots(host, generated, event) {
  return generated.map((group, slot) => {
    const legacy = legacyGroupFor(host, event, group);
    return {
      slot,
      current: group,
      currentIdentity: hookGroupIdentity(host, event, group),
      legacy,
      legacyIdentity: legacy === null ? null : hookGroupIdentity(host, event, legacy),
    };
  });
}

function classifyManagedGroups(host, event, actualGroups, generatedGroups) {
  if (actualGroups !== undefined && !Array.isArray(actualGroups)) {
    failure("HOST_RENDER_TARGET_INVALID", `${event} hooks must be an array when generated by the harness`, { host, event });
  }
  const actual = actualGroups ?? [];
  const slots = managedGroupSlots(host, generatedGroups, event);
  const assignments = [];
  const usedOccurrences = new Map();
  for (const slot of slots) {
    const matches = [];
    const semantic = semanticGroupIdentity(host, event, slot.current);
    for (let index = 0; index < actual.length; index += 1) {
      const identity = hookGroupIdentity(host, event, actual[index]);
      if (identity === slot.currentIdentity) matches.push({ index, kind: "current" });
      else if (slot.legacyIdentity !== null && identity === slot.legacyIdentity) matches.push({ index, kind: "legacy" });
      else if (semantic !== null && semanticGroupIdentity(host, event, actual[index]) === semantic) matches.push({ index, kind: "legacy" });
    }
    if (matches.length > 1) {
      failure("HOST_RENDER_MANAGED_IDENTITY_AMBIGUOUS", "multiple complete hook groups match one managed identity", {
        host,
        event,
        slot: slot.slot,
        matchingIndexes: matches.map((match) => match.index),
        matchedKinds: matches.map((match) => match.kind),
      });
    }
    if (matches.length === 1) {
      const match = matches[0];
      const prior = usedOccurrences.get(match.index);
      if (prior !== undefined) {
        failure("HOST_RENDER_MANAGED_IDENTITY_AMBIGUOUS", "one hook group matches multiple managed identity slots", {
          host,
          event,
          index: match.index,
          slots: [prior.slot, slot.slot],
        });
      }
      const assignment = { ...match, slot };
      assignments.push(assignment);
      usedOccurrences.set(match.index, assignment);
    }
  }
  return { actual, slots, assignments };
}

function mergeClaudeHooks(existing, generated, host = "claude-code") {
  const result = jsonObject(existing ?? {}, "Claude hooks");
  const merged = structuredClone(result);
  for (const [event, groups] of Object.entries(generated)) {
    const classified = classifyManagedGroups(host, event, result[event], groups);
    const next = classified.actual.map((group) => structuredClone(group));
    for (const assignment of classified.assignments) {
      if (assignment.kind === "legacy") next[assignment.index] = structuredClone(assignment.slot.current);
    }
    for (const [slot, group] of groups.entries()) {
      if (!classified.assignments.some((assignment) => assignment.slot.slot === slot)) next.push(structuredClone(group));
    }
    merged[event] = next;
  }
  return merged;
}

function managedClaudeHooks(actual, expected, host = "claude-code") {
  const result = {};
  for (const [event, groups] of Object.entries(expected)) {
    const classified = classifyManagedGroups(host, event, actual?.[event], groups);
    result[event] = classified.assignments.map((assignment) => structuredClone(classified.actual[assignment.index]));
  }
  return result;
}

function mergeHookDocument(existing, generated) {
  const current = jsonObject(existing ?? {}, "Codex hooks");
  return { ...structuredClone(current), hooks: mergeClaudeHooks(current.hooks, generated, "codex") };
}

function yamlValue(value) {
  return /^[A-Za-z0-9._:-]+$/u.test(value) ? value : JSON.stringify(value);
}

function parseFrontmatter(source) {
  if (!source.startsWith("---\n")) return { fields: [], body: source, newline: "\n" };
  const end = source.indexOf("\n---", 4);
  if (end < 0) failure("HOST_RENDER_TARGET_INVALID", "agent frontmatter has no closing delimiter");
  const raw = source.slice(4, end).split("\n");
  const fields = raw.map((line) => {
    const match = /^(\s*)([A-Za-z0-9_-]+)(\s*:\s*)(.*)$/u.exec(line);
    return match ? { raw: line, indent: match[1], key: match[2], separator: match[3], value: match[4] } : { raw: line };
  });
  return { fields, body: source.slice(end + "\n---".length), newline: "\n" };
}

function frontmatterValue(fields, key) {
  const field = fields.find((entry) => entry.key === key);
  if (!field) return undefined;
  const value = field.value.trim();
  try { return JSON.parse(value); } catch { return value.replace(/^['"]|['"]$/gu, ""); }
}

function updateAgent(source, value) {
  const parsed = parseFrontmatter(source);
  const fields = parsed.fields.slice();
  for (const [key, nextValue] of [["model", value.model], ["effort", value.effort]]) {
    const existing = fields.find((entry) => entry.key === key);
    if (existing) existing.raw = `${existing.indent}${key}${existing.separator}${yamlValue(nextValue)}`;
    else fields.push({ raw: `${key}: ${yamlValue(nextValue)}` });
  }
  const header = fields.map((entry) => entry.raw).join("\n");
  return `---\n${header}\n---${parsed.body}`;
}

function rootTomlValue(source, key) {
  const lines = source.split(/\n/u);
  let table = false;
  for (const line of lines) {
    if (/^\s*\[.*\]\s*(?:#.*)?$/u.test(line)) { table = true; continue; }
    if (!table) {
      const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "u").exec(line);
      if (match) return match[1];
    }
  }
  return undefined;
}

function updateToml(source, values) {
  const lines = source.length === 0 ? [] : source.split(/\n/u);
  let table = false;
  const seen = new Set();
  const output = lines.map((line) => {
    if (/^\s*\[.*\]\s*(?:#.*)?$/u.test(line)) { table = true; return line; }
    if (table) return line;
    for (const [key, value] of Object.entries(values)) {
      const pattern = new RegExp(`^(\\s*)${key}(\\s*=\\s*)"[^"]*"(\\s*(?:#.*)?)$`, "u");
      const match = pattern.exec(line);
      if (match) { seen.add(key); return `${match[1]}${key}${match[2]}${JSON.stringify(value)}${match[3]}`; }
    }
    return line;
  });
  const missing = Object.entries(values).filter(([key]) => !seen.has(key));
  if (missing.length > 0) output.unshift(...missing.map(([key, value]) => `${key} = ${JSON.stringify(value)}`));
  return `${output.join("\n").replace(/\n*$/u, "")}\n`;
}

function existingValue(existing, path) {
  return existing instanceof Map ? existing.get(path) ?? null : existing?.[path] ?? null;
}

async function readExisting(root, paths) {
  const values = new Map();
  for (const path of paths) {
    const absolute = resolve(root, path);
    try { values.set(path, await readFile(absolute, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") values.set(path, null); else failure("HOST_RENDER_TARGET_UNREADABLE", path, { cause: error?.code ?? "READ_FAILED" }); }
  }
  return values;
}

function pathEntry(path, content, ownedFields, before, actualManaged, expectedManaged) {
  return {
    path,
    content,
    ownedFields,
    beforeSha256: before === null ? null : digest(before),
    expectedManaged,
    actualManaged,
    drift: stableJson(actualManaged) !== stableJson(expectedManaged),
  };
}

function managedAgent(source) {
  if (source === null) return null;
  const parsed = parseFrontmatter(source);
  return { model: frontmatterValue(parsed.fields, "model"), effort: frontmatterValue(parsed.fields, "effort") };
}

export function renderHostPlan({ host, mode, scope = "full", settings, root, repoRoot = REPO_ROOT, existing = undefined } = {}) {
  text(host, "host");
  if (!HOST_RENDER_HOSTS.includes(host)) failure("HOST_RENDER_HOST_UNKNOWN", `host must be one of ${HOST_RENDER_HOSTS.join(", ")}`);
  const selectedScope = renderScope(scope);
  const hooksOnly = selectedScope === "hooks-only";
  const { config, mode: selectedMode } = readConfig(settings, mode);
  const classes = Object.keys(config.classes).sort();
  const resolutions = Object.fromEntries(classes.map((taskClass) => [taskClass, resolved(config, host, taskClass, selectedMode)]));
  const values = existing === undefined ? null : existing;
  const get = (path) => existingValue(values, path);
  const files = [];
  if (resolutions.plan === null && !hooksOnly) {
    return {
      schemaVersion: HOST_RENDER_VERSION,
      host,
      mode: selectedMode,
      scope: selectedScope,
      root: root ? resolve(root) : null,
      repoRoot: resolve(repoRoot),
      resolutions,
      files,
      drift: [],
      comparable: false,
      reasonCode: "HOST_RENDER_MODEL_UNSET",
    };
  }
  if (host === "claude-code") {
    const plan = resolutions.plan;
    const current = parseJson(get(CLAUDE_SETTINGS_PATH), CLAUDE_SETTINGS_PATH);
    const expectedHooks = claudeHookSettings();
    const next = structuredClone(current);
    if (plan !== null && !hooksOnly) {
      next.model = plan.model;
      next.env = { ...(next.env && typeof next.env === "object" && !Array.isArray(next.env) ? next.env : {}), [CLAUDE_EFFORT_ENV]: plan.effort };
    }
    next.hooks = mergeClaudeHooks(next.hooks, expectedHooks, "claude-code");
    const settingsManagedExpected = hooksOnly
      ? { hooks: expectedHooks }
      : { model: plan.model, effort: plan.effort, hooks: expectedHooks };
    const settingsManagedActual = hooksOnly
      ? { hooks: managedClaudeHooks(current.hooks, expectedHooks, "claude-code") }
      : { model: current.model, effort: current.env?.[CLAUDE_EFFORT_ENV], hooks: managedClaudeHooks(current.hooks, expectedHooks, "claude-code") };
    const settingsContent = `${JSON.stringify(next, null, 2)}\n`;
    files.push(pathEntry(CLAUDE_SETTINGS_PATH, settingsContent, hooksOnly ? ["hooks"] : ["model", `env.${CLAUDE_EFFORT_ENV}`, "hooks"], get(CLAUDE_SETTINGS_PATH), settingsManagedActual, settingsManagedExpected));
    if (!hooksOnly) {
      files.push(pathEntry(CLAUDE_BRIDGE_PATH, "@AGENTS.md\n", ["content"], get(CLAUDE_BRIDGE_PATH), get(CLAUDE_BRIDGE_PATH), "@AGENTS.md\n"));
      for (const taskClass of classes) {
        const value = resolutions[taskClass];
        if (value === null) continue;
        const path = `${HOST_RENDER_AGENT_DIRECTORY}/${taskClass}.md`;
        const currentAgent = get(path);
        const content = updateAgent(currentAgent ?? "", value);
        files.push(pathEntry(path, content, ["frontmatter.model", "frontmatter.effort"], currentAgent, managedAgent(currentAgent), { model: value.model, effort: value.effort }));
      }
    }
  } else {
    const plan = resolutions.plan;
    if (plan !== null && !hooksOnly) {
      const currentConfig = get(CODEX_CONFIG_PATH) ?? "";
      const nextConfig = updateToml(currentConfig, { model: plan.model, model_reasoning_effort: plan.effort });
      const expectedConfig = { model: plan.model, effort: plan.effort };
      files.push(pathEntry(CODEX_CONFIG_PATH, nextConfig, ["model", "model_reasoning_effort"], get(CODEX_CONFIG_PATH), { model: rootTomlValue(currentConfig, "model"), effort: rootTomlValue(currentConfig, "model_reasoning_effort") }, expectedConfig));
    }
    const expectedHooks = codexHookDocument(repoRoot).hooks;
    const currentHooks = parseJson(get(CODEX_HOOKS_PATH), CODEX_HOOKS_PATH);
    const nextHooks = mergeHookDocument(currentHooks, expectedHooks);
    files.push(pathEntry(CODEX_HOOKS_PATH, `${JSON.stringify(nextHooks, null, 2)}\n`, ["hooks"], get(CODEX_HOOKS_PATH), managedClaudeHooks(currentHooks.hooks, expectedHooks, "codex"), expectedHooks));
  }
  const drift = files.filter((entry) => entry.drift).map((entry) => ({ path: entry.path, expected: entry.expectedManaged, actual: entry.actualManaged }));
  return {
    schemaVersion: HOST_RENDER_VERSION,
    host,
    mode: selectedMode,
    scope: selectedScope,
    root: root ? resolve(root) : null,
    repoRoot: resolve(repoRoot),
    resolutions,
    files,
    drift,
    comparable: resolutions.plan !== null,
    hooksComparable: hooksOnly,
    reasonCode: hooksOnly
      ? drift.length === 0 ? "HOST_RENDER_HOOKS_CURRENT" : "HOST_RENDER_HOOKS_DRIFTED"
      : drift.length === 0 ? "HOST_RENDER_CURRENT" : "HOST_RENDER_DRIFTED",
  };
}

export async function inspectHostRenderDrift(options = {}) {
  const scope = renderScope(options.scope);
  const root = resolve(text(options.root, "root"));
  const first = renderHostPlan({ ...options, root, scope, existing: new Map() });
  const existing = await readExisting(root, first.files.map((entry) => entry.path));
  const plan = renderHostPlan({ ...options, root, scope, existing });
  const comparable = plan.comparable || plan.hooksComparable === true;
  return {
    name: "hostRenderDrift",
    ok: !comparable || plan.drift.length === 0,
    reasonCode: !comparable ? "PLATFORM_HOST_RENDER_UNCONFIGURED" : plan.drift.length === 0 ? "PLATFORM_HOST_RENDER_CURRENT" : "PLATFORM_HOST_RENDER_DRIFTED",
    host: plan.host,
    mode: plan.mode,
    scope: plan.scope,
    comparable,
    hooksComparable: plan.hooksComparable === true,
    drift: plan.drift,
    resolutions: plan.resolutions,
    source: "dispatch settings + host-render projection",
  };
}

async function atomicWrite(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${path.split(sep).at(-1)}.${process.pid}.tmp`);
  await writeFile(temporary, content, { flag: "wx", mode });
  await rename(temporary, path);
}

async function regularFileBytes(path) {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) failure("HOST_RENDER_TARGET_INVALID", `${path} is not a regular file`);
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.reasonCode) throw error;
    failure("HOST_RENDER_TARGET_UNREADABLE", path, { cause: error?.code ?? "READ_FAILED" });
  }
}

function safeTarget(root, relativePath) {
  const target = resolve(root, relativePath);
  const relation = relative(root, target);
  if (relation === "" || relation.startsWith("..") || relation.startsWith(`..${sep}`) || isAbsolute(relation)) failure("HOST_RENDER_TARGET_INVALID", relativePath);
  return target;
}

export async function applyHostRender(plan, { backupDir = undefined } = {}) {
  if (!plan || plan.schemaVersion !== HOST_RENDER_VERSION || typeof plan.root !== "string" || !Array.isArray(plan.files)) failure("HOST_RENDER_PLAN_INVALID", "host render plan");
  const scope = renderScope(plan.scope);
  if (scope === "hooks-only") {
    const expectedPath = plan.host === "claude-code" ? CLAUDE_SETTINGS_PATH : plan.host === "codex" ? CODEX_HOOKS_PATH : null;
    if (expectedPath === null || plan.files.length !== 1 || plan.files[0]?.path !== expectedPath || stableJson(plan.files[0]?.ownedFields) !== stableJson(["hooks"]) || typeof plan.files[0]?.content !== "string") {
      failure("HOST_RENDER_SCOPE_VIOLATION", "hooks-only plans may contain only the host hook projection", { host: plan.host, paths: plan.files.map((entry) => entry?.path ?? null) });
    }
  }
  const root = resolve(plan.root);
  const changes = plan.files.filter((entry) => entry.content !== null);
  const before = new Map();
  for (const entry of changes) {
    const target = safeTarget(root, entry.path);
    const bytes = await regularFileBytes(target);
    before.set(entry.path, bytes);
    const expectedBefore = entry.beforeSha256 === null ? null : entry.beforeSha256;
    if ((bytes === null ? null : digest(bytes)) !== expectedBefore) failure("HOST_RENDER_CONCURRENT_MODIFICATION", entry.path);
    if (scope === "hooks-only") {
      const beforeDocument = parseJson(bytes?.toString("utf8") ?? null, entry.path);
      const afterDocument = parseJson(entry.content, entry.path);
      if (!Object.hasOwn(afterDocument, "hooks")) failure("HOST_RENDER_SCOPE_VIOLATION", "hooks-only content must contain a hooks field", { host: plan.host, path: entry.path });
      const withoutHooks = (value) => {
        const clone = structuredClone(value);
        delete clone.hooks;
        return clone;
      };
      if (stableJson(withoutHooks(beforeDocument)) !== stableJson(withoutHooks(afterDocument))) {
        failure("HOST_RENDER_SCOPE_VIOLATION", "hooks-only content changed non-hook host fields", { host: plan.host, path: entry.path });
      }
    }
  }
  const writes = changes.filter((entry) => before.get(entry.path)?.toString("utf8") !== entry.content || before.get(entry.path) === null);
  if (writes.length === 0) return { reasonCode: "HOST_RENDER_ALREADY_CURRENT", host: plan.host, mode: plan.mode, wrote: false, files: [], backupDir: null, drift: [] };
  const backupRoot = resolve(backupDir ?? join(root, ".tcrn-artifacts", "host-render-backups", `${Date.now()}-${process.pid}`));
  const backups = [];
  try {
    for (const entry of writes) {
      const bytes = before.get(entry.path);
      if (bytes === null) continue;
      const backup = safeTarget(backupRoot, entry.path);
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
      await writeFile(backup, bytes, { flag: "wx", mode: 0o600 });
      backups.push({ path: entry.path, backup });
    }
    for (const entry of writes) await atomicWrite(safeTarget(root, entry.path), entry.content);
    for (const entry of writes) {
      const actual = await readFile(safeTarget(root, entry.path), "utf8");
      if (actual !== entry.content) failure("HOST_RENDER_READBACK_MISMATCH", entry.path);
    }
  } catch (error) {
    for (const entry of writes) {
      const target = safeTarget(root, entry.path);
      const actual = await regularFileBytes(target);
      if (actual === null || actual.toString("utf8") === entry.content) {
        const original = before.get(entry.path);
        if (original === null) await rm(target, { force: true });
        else await atomicWrite(target, original.toString("utf8"));
      }
    }
    throw error;
  }
  return {
    reasonCode: "HOST_RENDER_COMMITTED",
    host: plan.host,
    mode: plan.mode,
    wrote: true,
    files: writes.map((entry) => ({ path: entry.path, beforeSha256: entry.beforeSha256, afterSha256: digest(entry.content) })),
    backupDir: backups.length === 0 ? null : backupRoot,
    drift: [],
  };
}

async function workspaceSettings(workspace) {
  const cli = join(REPO_ROOT, "scripts", "tcrn-workflow.mjs");
  const result = await execFileAsync(process.execPath, [cli, "settings-catalog", "--workspace", workspace], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const body = JSON.parse(result.stdout);
  if (!Array.isArray(body.settings)) failure("HOST_RENDER_SETTINGS_INVALID", "settings-catalog did not return settings");
  return body.settings;
}

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argv = process.argv.slice(2);
    const host = flag(argv, "host");
    const root = flag(argv, "root");
    const workspace = flag(argv, "workspace");
    const mode = flag(argv, "mode");
    const settingsJson = flag(argv, "settings");
    if (!host || !root || (!workspace && !settingsJson)) failure("HOST_RENDER_ARGUMENT_MISSING", "--host, --root, and --workspace (or --settings) are required");
    const settings = settingsJson === undefined ? await workspaceSettings(resolve(workspace)) : JSON.parse(settingsJson);
    const renderRoot = resolve(root);
    const repoRoot = flag(argv, "repo-root") ?? REPO_ROOT;
    const requestedScope = flag(argv, "scope");
    const hooksOnlyAlias = argv.includes("--hooks-only");
    if (requestedScope !== undefined && hooksOnlyAlias && requestedScope !== "hooks-only") failure("HOST_RENDER_SCOPE_CONFLICT", "--hooks-only conflicts with --scope full");
    const scope = renderScope(requestedScope ?? (hooksOnlyAlias ? "hooks-only" : "full"));
    const preliminary = renderHostPlan({ host, mode, scope, settings, root: renderRoot, repoRoot, existing: new Map() });
    const plan = renderHostPlan({ host, mode, scope, settings, root: renderRoot, repoRoot, existing: await readExisting(renderRoot, preliminary.files.map((entry) => entry.path)) });
    const result = argv.includes("--plan-only") ? { reasonCode: "HOST_RENDER_PLAN_READY", plan: { ...plan, files: plan.files.map(({ content, ...entry }) => ({ ...entry, afterSha256: digest(content) })) } } : await applyHostRender(plan, { backupDir: flag(argv, "backup-dir") });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, reasonCode: error?.reasonCode ?? "HOST_RENDER_FAILED", error: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
