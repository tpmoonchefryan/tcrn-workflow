// SPDX-License-Identifier: Apache-2.0

// WSG-3 Step-2 activation fragment v2 (activation ladder v1, Step 2;
// docs/activation/activation-ladder-v1.md). This is the FIRST non-inert
// activation surface in the program. It implements
// tcrn.claude-adapter-settings-fragment.v2 under a NEW merge key "tcrnWorkflow"
// (distinct from v1's inert "tcrnWorkflowInert", claude-adapter.ts:167) so the v1
// inert fragment and the v2 active fragment coexist and v1 removal stays exactly
// byte-inverse. The v1 functions in claude-adapter.ts are UNTOUCHED as the inert
// fallback; every private helper the v2 path needs is duplicated here per the
// duplicate-machinery discipline.
//
// The v2 fragment materializes exactly ONE real hooks.SessionStart entry running
// the governed handler emitted by generateSessionStartScript
// (claude-adapter-session-start.ts). Exactly one hook event and one entry are
// admitted; every other event key or a second entry fails
// ACTIVATION_HOOK_SURFACE_EXCEEDED. merge records hooksContainerCreated /
// sessionStartArrayCreated so remove is decidably byte-inverse over settings that
// already carry unrelated user hooks.
//
// N-2: the SessionStart hook is the SOLE authorized fail-open surface; that
// fail-open behavior lives in the emitted script, not here. Every check in this
// module stays fail-closed with a stable ACTIVATION_* reason code.
//
// [BLOCKER resolution, OD-32] tcrn.claude-adapter-installation-generation.v2 is an
// ADDITIVE receipt (v1 untouched) whose entry set covers the four v1 template
// paths PLUS session-start.mjs and reserves persona-render.json (WSG-4). Its
// rollback-plan generator emits the existing tcrn.claude-adapter-rollback-plan.v1
// shape covering every installed activation file, so WSG-2's
// executeClaudeAdapterRollback empties .claude/tcrn-workflow byte-inverse instead
// of orphaning the step-2/3 files.

import { canonicalJson, canonicalSha256, assertProtocolId, compareCanonicalText, parseStrictInstant } from "../../protocol/src/index.js";
import {
  CLAUDE_ADAPTER_HOST_PRODUCT,
  CLAUDE_ADAPTER_SETTINGS_TARGET,
  CLAUDE_ADAPTER_TEMPLATE_PATHS,
  assertNoForbiddenClaudePaths,
  validateClaudeAdapterRequest,
} from "./claude-adapter.js";

export const CLAUDE_ADAPTER_FRAGMENT_V2_VERSION = "tcrn.claude-adapter-settings-fragment.v2" as const;
export const CLAUDE_ADAPTER_HOST_V2_VERSION = "tcrn.claude-adapter-host.v2" as const;
export const CLAUDE_ADAPTER_INSTALLATION_V2_VERSION = "tcrn.claude-adapter-installation-generation.v2" as const;
export const CLAUDE_ADAPTER_ROLLBACK_PLAN_VERSION = "tcrn.claude-adapter-rollback-plan.v1" as const;
export const CLAUDE_ADAPTER_ACTIVATION_MERGE_KEY = "tcrnWorkflow" as const;
export const CLAUDE_ADAPTER_ACTIVATION_HOOK_EVENT = "SessionStart" as const;
export const CLAUDE_ADAPTER_ACTIVATION_HOOK_COMMAND = 'node ".claude/tcrn-workflow/session-start.mjs"' as const;
export const CLAUDE_ADAPTER_SESSION_START_PATH = ".claude/tcrn-workflow/session-start.mjs" as const;
export const CLAUDE_ADAPTER_PERSONA_RENDER_PATH = ".claude/tcrn-workflow/persona-render.json" as const;

// The closed activation entry-path set the v2 receipt admits: the four inert v1
// templates (already on disk after Step 1), the Step-2 handler, and the reserved
// Step-3 persona render (WSG-4 rides this).
export const CLAUDE_ADAPTER_ACTIVATION_PATHS = Object.freeze([
  ...CLAUDE_ADAPTER_TEMPLATE_PATHS,
  CLAUDE_ADAPTER_SESSION_START_PATH,
  CLAUDE_ADAPTER_PERSONA_RENDER_PATH,
] as const);

export const CLAUDE_ADAPTER_ACTIVATION_REASON_CODES = Object.freeze([
  "ACTIVATION_BUDGET_EXCEEDED",
  "ACTIVATION_CANONICAL_INVALID",
  "ACTIVATION_CONTEXT_STALE",
  "ACTIVATION_FRAGMENT_CONFLICT",
  "ACTIVATION_FRAGMENT_INVALID",
  "ACTIVATION_FRAGMENT_IRREVERSIBLE",
  "ACTIVATION_HOOK_SURFACE_EXCEEDED",
  "ACTIVATION_HOST_MISMATCH",
  "ACTIVATION_HOST_PRODUCT_MISMATCH",
  "ACTIVATION_HOST_REQUIRED",
  "ACTIVATION_RECEIPT_INVALID",
  "ACTIVATION_ROLLBACK_MISMATCH",
  "ACTIVATION_SCHEMA_INVALID",
  "ACTIVATION_UNICODE_INVALID",
] as const);

export type ClaudeAdapterActivationReasonCode = typeof CLAUDE_ADAPTER_ACTIVATION_REASON_CODES[number];

export interface ClaudeAdapterActivationHostInput {
  readonly schemaVersion: typeof CLAUDE_ADAPTER_HOST_V2_VERSION;
  readonly requestDigest: string;
  readonly contextDigest: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly workId: string | null;
  readonly governedAction: "generate" | "validate" | "simulate";
  readonly hostProduct: typeof CLAUDE_ADAPTER_HOST_PRODUCT;
  readonly hostVersionReadback: string;
  readonly contextIssuedAt: string;
  readonly contextExpiresAt: string;
  readonly verificationTime: string;
  readonly installationTarget: "project_local_activation";
  readonly activationAllowed: true;
  readonly installationReceiptDigest: string;
  readonly hostDigest: string;
}

export interface ClaudeAdapterActivationHostContext {
  readonly input: ClaudeAdapterActivationHostInput;
}

export interface ClaudeAdapterActivationHookCommand {
  readonly type: "command";
  readonly command: typeof CLAUDE_ADAPTER_ACTIVATION_HOOK_COMMAND;
}

export interface ClaudeAdapterActivationHookEntry {
  readonly matcher: "";
  readonly hooks: readonly ClaudeAdapterActivationHookCommand[];
}

export interface ClaudeAdapterActivationFragment {
  readonly schemaVersion: typeof CLAUDE_ADAPTER_FRAGMENT_V2_VERSION;
  readonly activation: true;
  readonly contextDigest: string;
  readonly hostDigest: string;
  readonly requestDigest: string;
  readonly installationReceiptDigest: string;
  readonly scriptDigest: string;
  readonly hostProduct: typeof CLAUDE_ADAPTER_HOST_PRODUCT;
  readonly settingsTarget: typeof CLAUDE_ADAPTER_SETTINGS_TARGET;
  readonly mergeKey: typeof CLAUDE_ADAPTER_ACTIVATION_MERGE_KEY;
  readonly hooks: { readonly SessionStart: readonly ClaudeAdapterActivationHookEntry[] };
  readonly fragmentDigest: string;
}

export interface ClaudeAdapterActivationScriptContext {
  readonly scriptDigest: string;
}

export interface ClaudeAdapterActivationInstallationEntry {
  readonly path: string;
  readonly realpath: string;
  readonly contentDigest: string;
  readonly identityDigest: string;
}

export interface ClaudeAdapterActivationInstallationReceipt {
  readonly schemaVersion: typeof CLAUDE_ADAPTER_INSTALLATION_V2_VERSION;
  readonly generationId: string;
  readonly bundleDigest: string;
  readonly fragmentDigest: string;
  readonly scriptDigest: string;
  readonly installationRoot: string;
  readonly entries: readonly ClaudeAdapterActivationInstallationEntry[];
  readonly receiptDigest: string;
}

const shaPattern = /^[a-f0-9]{64}$/u;
const maximumUntrustedBytes = 8_192;
const maximumHostVersionBytes = 256;
const maximumSettingsBytes = 65_536;
const activationHostContexts = new WeakSet<object>();

export class ClaudeAdapterActivationError extends Error {
  readonly reasonCode: ClaudeAdapterActivationReasonCode;
  constructor(reasonCode: ClaudeAdapterActivationReasonCode, message: string) {
    super(message);
    this.name = "ClaudeAdapterActivationError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: ClaudeAdapterActivationReasonCode, message: string): never {
  throw new ClaudeAdapterActivationError(reasonCode, message);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("ACTIVATION_SCHEMA_INVALID", label);
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  const unexpected = actual.filter((field) => !wanted.includes(field));
  if (unexpected.length > 0) fail("ACTIVATION_SCHEMA_INVALID", `${label}:${unexpected.join(",")}`);
  if (wanted.some((field) => !actual.includes(field))) fail("ACTIVATION_SCHEMA_INVALID", label);
}

function text(value: unknown, label: string, maximumBytes = maximumUntrustedBytes): string {
  if (typeof value !== "string" || !value.isWellFormed()) fail("ACTIVATION_UNICODE_INVALID", label);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) fail("ACTIVATION_BUDGET_EXCEEDED", label);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) fail("ACTIVATION_SCHEMA_INVALID", label);
  return value;
}

function id(value: unknown, label: string): string {
  try { assertProtocolId(value); } catch { fail("ACTIVATION_SCHEMA_INVALID", label); }
  return value as string;
}

function nullableId(value: unknown, label: string): string | null {
  return value === null ? null : id(value, label);
}

function instant(value: unknown, label: string): string {
  try { parseStrictInstant(value); } catch { fail("ACTIVATION_SCHEMA_INVALID", label); }
  return value as string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Duplicated from claude-adapter.ts (private bindingFromResult): reach the admitted
// authority binding inside a validated context-route result.
function bindingFromResult(result: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const context = record(result.context, "context result context");
  const authority = record(context.authoritySummary, "context authority summary");
  return record(authority.binding, "context binding");
}

export function admitClaudeAdapterActivationHostInput(value: unknown): ClaudeAdapterActivationHostContext {
  const document = record(value, "activation host input");
  exact(document, ["schemaVersion", "requestDigest", "contextDigest", "workspaceId", "projectId", "workId", "governedAction", "hostProduct", "hostVersionReadback", "contextIssuedAt", "contextExpiresAt", "verificationTime", "installationTarget", "activationAllowed", "installationReceiptDigest", "hostDigest"], "activation host input");
  if (document.schemaVersion !== CLAUDE_ADAPTER_HOST_V2_VERSION || typeof document.governedAction !== "string" ||
    !["generate", "validate", "simulate"].includes(document.governedAction) ||
    document.installationTarget !== "project_local_activation" || document.activationAllowed !== true) fail("ACTIVATION_SCHEMA_INVALID", "activation host header");
  if (document.hostProduct !== CLAUDE_ADAPTER_HOST_PRODUCT) fail("ACTIVATION_HOST_PRODUCT_MISMATCH", "host product");
  const basis = {
    schemaVersion: CLAUDE_ADAPTER_HOST_V2_VERSION,
    requestDigest: sha(document.requestDigest, "host requestDigest"),
    contextDigest: sha(document.contextDigest, "host contextDigest"),
    workspaceId: id(document.workspaceId, "host workspaceId"),
    projectId: id(document.projectId, "host projectId"),
    workId: nullableId(document.workId, "host workId"),
    governedAction: document.governedAction as "generate" | "validate" | "simulate",
    hostProduct: CLAUDE_ADAPTER_HOST_PRODUCT,
    hostVersionReadback: text(document.hostVersionReadback, "host version readback", maximumHostVersionBytes),
    contextIssuedAt: instant(document.contextIssuedAt, "host contextIssuedAt"),
    contextExpiresAt: instant(document.contextExpiresAt, "host contextExpiresAt"),
    verificationTime: instant(document.verificationTime, "host verificationTime"),
    installationTarget: "project_local_activation" as const,
    activationAllowed: true as const,
    installationReceiptDigest: sha(document.installationReceiptDigest, "host installationReceiptDigest"),
  };
  if (parseStrictInstant(basis.contextIssuedAt) > parseStrictInstant(basis.verificationTime) || parseStrictInstant(basis.verificationTime) >= parseStrictInstant(basis.contextExpiresAt)) fail("ACTIVATION_CONTEXT_STALE", "host context validity window");
  if (sha(document.hostDigest, "hostDigest") !== canonicalSha256(basis)) fail("ACTIVATION_CANONICAL_INVALID", "hostDigest");
  const context = deepFreeze({ input: { ...basis, hostDigest: document.hostDigest as string } });
  activationHostContexts.add(context);
  return context;
}

function assertActivationHost(request: ReturnType<typeof validateClaudeAdapterRequest>, host: ClaudeAdapterActivationHostContext | undefined): ClaudeAdapterActivationHostInput {
  if (!host || !activationHostContexts.has(host)) fail("ACTIVATION_HOST_REQUIRED", "independently governed activation host input required");
  const input = host.input;
  const contextDigest = sha(request.contextResult.contextDigest, "contextDigest");
  const binding = bindingFromResult(request.contextResult);
  if (input.requestDigest !== canonicalSha256(request) || input.contextDigest !== contextDigest || input.governedAction !== "generate" ||
    input.workspaceId !== request.workspaceId || input.projectId !== request.projectId || input.workId !== request.workId) fail("ACTIVATION_HOST_MISMATCH", "request, target, or action");
  if (input.hostProduct !== CLAUDE_ADAPTER_HOST_PRODUCT) fail("ACTIVATION_HOST_PRODUCT_MISMATCH", "host product");
  if (binding.mode !== "workspace" && binding.mode !== "project" && binding.mode !== "command") fail("ACTIVATION_HOST_MISMATCH", "bound context required");
  if (binding.workspaceId !== request.workspaceId || (binding.projectId !== null && binding.projectId !== request.projectId)) fail("ACTIVATION_HOST_MISMATCH", "workspace or project");
  return input;
}

function activationHookEntry(): ClaudeAdapterActivationHookEntry {
  return { matcher: "", hooks: [{ type: "command", command: CLAUDE_ADAPTER_ACTIVATION_HOOK_COMMAND }] };
}

export function generateClaudeAdapterActivationFragment(value: unknown, host: ClaudeAdapterActivationHostContext | undefined, script: ClaudeAdapterActivationScriptContext): ClaudeAdapterActivationFragment {
  const request = validateClaudeAdapterRequest(value);
  const admitted = assertActivationHost(request, host);
  const scriptContext = record(script, "activation script context");
  exact(scriptContext, ["scriptDigest"], "activation script context");
  const scriptDigest = sha(scriptContext.scriptDigest, "scriptDigest");
  const basis = {
    schemaVersion: CLAUDE_ADAPTER_FRAGMENT_V2_VERSION,
    activation: true as const,
    contextDigest: admitted.contextDigest,
    hostDigest: admitted.hostDigest,
    requestDigest: admitted.requestDigest,
    installationReceiptDigest: admitted.installationReceiptDigest,
    scriptDigest,
    hostProduct: CLAUDE_ADAPTER_HOST_PRODUCT,
    settingsTarget: CLAUDE_ADAPTER_SETTINGS_TARGET,
    mergeKey: CLAUDE_ADAPTER_ACTIVATION_MERGE_KEY,
    hooks: { SessionStart: [activationHookEntry()] },
  };
  const fragment = deepFreeze({ ...basis, fragmentDigest: canonicalSha256(basis) });
  assertNoForbiddenClaudePaths(fragment);
  return fragment;
}

function validateHookEntry(value: unknown, label: string): ClaudeAdapterActivationHookEntry {
  const entry = record(value, label);
  exact(entry, ["matcher", "hooks"], label);
  if (entry.matcher !== "") fail("ACTIVATION_FRAGMENT_INVALID", `${label}.matcher`);
  if (!Array.isArray(entry.hooks) || entry.hooks.length !== 1) fail("ACTIVATION_HOOK_SURFACE_EXCEEDED", `${label}.hooks`);
  const command = record(entry.hooks[0], `${label}.hooks[0]`);
  exact(command, ["type", "command"], `${label}.hooks[0]`);
  if (command.type !== "command" || command.command !== CLAUDE_ADAPTER_ACTIVATION_HOOK_COMMAND) fail("ACTIVATION_FRAGMENT_INVALID", `${label}.hooks[0].command`);
  return activationHookEntry();
}

export function validateClaudeAdapterActivationFragment(value: unknown): ClaudeAdapterActivationFragment {
  const document = record(value, "activation fragment");
  exact(document, ["schemaVersion", "activation", "contextDigest", "hostDigest", "requestDigest", "installationReceiptDigest", "scriptDigest", "hostProduct", "settingsTarget", "mergeKey", "hooks", "fragmentDigest"], "activation fragment");
  if (document.schemaVersion !== CLAUDE_ADAPTER_FRAGMENT_V2_VERSION || document.activation !== true || document.hostProduct !== CLAUDE_ADAPTER_HOST_PRODUCT ||
    document.settingsTarget !== CLAUDE_ADAPTER_SETTINGS_TARGET || document.mergeKey !== CLAUDE_ADAPTER_ACTIVATION_MERGE_KEY) fail("ACTIVATION_FRAGMENT_INVALID", "fragment header");
  const contextDigest = sha(document.contextDigest, "fragment contextDigest");
  const hostDigest = sha(document.hostDigest, "fragment hostDigest");
  const requestDigest = sha(document.requestDigest, "fragment requestDigest");
  const installationReceiptDigest = sha(document.installationReceiptDigest, "fragment installationReceiptDigest");
  const scriptDigest = sha(document.scriptDigest, "fragment scriptDigest");
  const hooksDocument = record(document.hooks, "fragment hooks");
  const hookEvents = Object.keys(hooksDocument);
  if (hookEvents.length !== 1 || hookEvents[0] !== CLAUDE_ADAPTER_ACTIVATION_HOOK_EVENT) fail("ACTIVATION_HOOK_SURFACE_EXCEEDED", "fragment hook event set");
  const sessionStart = hooksDocument[CLAUDE_ADAPTER_ACTIVATION_HOOK_EVENT];
  if (!Array.isArray(sessionStart) || sessionStart.length !== 1) fail("ACTIVATION_HOOK_SURFACE_EXCEEDED", "fragment SessionStart entries");
  const entry = validateHookEntry(sessionStart[0], "fragment SessionStart[0]");
  const basis = {
    schemaVersion: CLAUDE_ADAPTER_FRAGMENT_V2_VERSION,
    activation: true as const,
    contextDigest,
    hostDigest,
    requestDigest,
    installationReceiptDigest,
    scriptDigest,
    hostProduct: CLAUDE_ADAPTER_HOST_PRODUCT,
    settingsTarget: CLAUDE_ADAPTER_SETTINGS_TARGET,
    mergeKey: CLAUDE_ADAPTER_ACTIVATION_MERGE_KEY,
    hooks: { SessionStart: [entry] },
  };
  if (sha(document.fragmentDigest, "fragmentDigest") !== canonicalSha256(basis)) fail("ACTIVATION_FRAGMENT_INVALID", "fragmentDigest");
  const fragment = deepFreeze({ ...basis, fragmentDigest: document.fragmentDigest as string });
  assertNoForbiddenClaudePaths(fragment);
  return fragment;
}

// Duplicated from claude-adapter.ts (private canonicalSettingsObject): admit
// user-owned settings text that is already canonical JSON within the shared budget.
function canonicalSettingsObject(settingsText: unknown): Readonly<Record<string, unknown>> {
  const source = text(settingsText, "settings content", maximumSettingsBytes);
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { fail("ACTIVATION_FRAGMENT_INVALID", "settings content"); }
  const document = record(parsed, "settings content");
  let canonical: string;
  try { canonical = canonicalJson(document); } catch { fail("ACTIVATION_FRAGMENT_INVALID", "settings canonical"); }
  if (canonical !== source) fail("ACTIVATION_FRAGMENT_INVALID", "settings must be canonical");
  return document;
}

function commandOf(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const hooks = (entry as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return null;
  for (const inner of hooks) {
    if (inner && typeof inner === "object" && !Array.isArray(inner) && (inner as Record<string, unknown>).command === CLAUDE_ADAPTER_ACTIVATION_HOOK_COMMAND) return CLAUDE_ADAPTER_ACTIVATION_HOOK_COMMAND;
  }
  return null;
}

export function mergeClaudeAdapterActivationFragment(settingsText: unknown, fragmentValue: unknown): string {
  const fragment = validateClaudeAdapterActivationFragment(fragmentValue);
  const settings = canonicalSettingsObject(settingsText);
  if (Object.prototype.hasOwnProperty.call(settings, CLAUDE_ADAPTER_ACTIVATION_MERGE_KEY)) fail("ACTIVATION_FRAGMENT_CONFLICT", "settings already carry the activation merge key");
  const entry = fragment.hooks.SessionStart[0] as ClaudeAdapterActivationHookEntry;
  const hooksContainerCreated = !Object.prototype.hasOwnProperty.call(settings, "hooks");
  let hooksObject: Readonly<Record<string, unknown>> = {};
  if (!hooksContainerCreated) {
    if (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks)) fail("ACTIVATION_FRAGMENT_CONFLICT", "settings.hooks is not an object");
    hooksObject = settings.hooks as Readonly<Record<string, unknown>>;
  }
  const sessionStartArrayCreated = !Object.prototype.hasOwnProperty.call(hooksObject, CLAUDE_ADAPTER_ACTIVATION_HOOK_EVENT);
  let sessionStart: readonly unknown[] = [];
  if (!sessionStartArrayCreated) {
    const existing = hooksObject[CLAUDE_ADAPTER_ACTIVATION_HOOK_EVENT];
    if (!Array.isArray(existing)) fail("ACTIVATION_FRAGMENT_CONFLICT", "settings.hooks.SessionStart is not an array");
    sessionStart = existing;
  }
  if (sessionStart.some((existing) => commandOf(existing) !== null)) fail("ACTIVATION_FRAGMENT_CONFLICT", "settings already register the activation hook command");
  const otherEvents: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(hooksObject)) if (key !== CLAUDE_ADAPTER_ACTIVATION_HOOK_EVENT) otherEvents[key] = child;
  const mergedHooks = { ...otherEvents, [CLAUDE_ADAPTER_ACTIVATION_HOOK_EVENT]: [...sessionStart, entry] };
  const stored = { ...fragment, hooksContainerCreated, sessionStartArrayCreated };
  const merged = canonicalJson({ ...settings, hooks: mergedHooks, [CLAUDE_ADAPTER_ACTIVATION_MERGE_KEY]: stored });
  if (Buffer.byteLength(merged, "utf8") > maximumSettingsBytes) fail("ACTIVATION_BUDGET_EXCEEDED", "merged settings exceed the size budget");
  return merged;
}

export function removeClaudeAdapterActivationFragment(mergedText: unknown, fragmentValue: unknown): string {
  const fragment = validateClaudeAdapterActivationFragment(fragmentValue);
  const merged = canonicalSettingsObject(mergedText);
  if (!Object.prototype.hasOwnProperty.call(merged, CLAUDE_ADAPTER_ACTIVATION_MERGE_KEY)) fail("ACTIVATION_FRAGMENT_IRREVERSIBLE", "merged settings carry no activation fragment");
  const stored = record(merged[CLAUDE_ADAPTER_ACTIVATION_MERGE_KEY], "stored activation fragment");
  if (typeof stored.hooksContainerCreated !== "boolean" || typeof stored.sessionStartArrayCreated !== "boolean") fail("ACTIVATION_FRAGMENT_IRREVERSIBLE", "stored activation fragment lacks container flags");
  const hooksContainerCreated = stored.hooksContainerCreated;
  const sessionStartArrayCreated = stored.sessionStartArrayCreated;
  const storedFragment: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(stored)) if (key !== "hooksContainerCreated" && key !== "sessionStartArrayCreated") storedFragment[key] = child;
  if (canonicalJson(storedFragment) !== canonicalJson(fragment)) fail("ACTIVATION_FRAGMENT_IRREVERSIBLE", "stored activation fragment does not match");
  const hooksObject = record(merged.hooks, "merged hooks");
  const existing = hooksObject[CLAUDE_ADAPTER_ACTIVATION_HOOK_EVENT];
  if (!Array.isArray(existing)) fail("ACTIVATION_FRAGMENT_IRREVERSIBLE", "merged SessionStart array");
  const matches = existing.filter((entry) => commandOf(entry) !== null);
  if (matches.length !== 1) fail("ACTIVATION_FRAGMENT_IRREVERSIBLE", "activation hook entry is not uniquely present");
  const remaining = existing.filter((entry) => commandOf(entry) === null);
  const otherEvents: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(hooksObject)) if (key !== CLAUDE_ADAPTER_ACTIVATION_HOOK_EVENT) otherEvents[key] = child;
  let finalHooks: Record<string, unknown>;
  if (sessionStartArrayCreated) {
    if (remaining.length !== 0) fail("ACTIVATION_FRAGMENT_IRREVERSIBLE", "SessionStart array was not created by the merge");
    finalHooks = otherEvents;
  } else {
    finalHooks = { ...otherEvents, [CLAUDE_ADAPTER_ACTIVATION_HOOK_EVENT]: remaining };
  }
  const rest: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(merged)) if (key !== CLAUDE_ADAPTER_ACTIVATION_MERGE_KEY && key !== "hooks") rest[key] = child;
  if (hooksContainerCreated) {
    if (Object.keys(finalHooks).length !== 0) fail("ACTIVATION_FRAGMENT_IRREVERSIBLE", "hooks container was not created by the merge");
  } else {
    rest.hooks = finalHooks;
  }
  return canonicalJson(rest);
}

// v2 installation-generation receipt. Additive to v1: covers the four inert
// template paths plus session-start.mjs and (reserved) persona-render.json.
export function validateClaudeAdapterActivationInstallationReceipt(value: unknown): ClaudeAdapterActivationInstallationReceipt {
  const document = record(value, "activation installation receipt");
  exact(document, ["schemaVersion", "generationId", "bundleDigest", "fragmentDigest", "scriptDigest", "installationRoot", "entries", "receiptDigest"], "activation installation receipt");
  if (document.schemaVersion !== CLAUDE_ADAPTER_INSTALLATION_V2_VERSION || !Array.isArray(document.entries) || typeof document.installationRoot !== "string") fail("ACTIVATION_RECEIPT_INVALID", "receipt header");
  const paths = document.entries.map((entry, index) => {
    const item = record(entry, `receipt entries[${index}]`);
    exact(item, ["path", "realpath", "contentDigest", "identityDigest"], `receipt entries[${index}]`);
    if (typeof item.path !== "string" || !CLAUDE_ADAPTER_ACTIVATION_PATHS.includes(item.path as typeof CLAUDE_ADAPTER_ACTIVATION_PATHS[number])) fail("ACTIVATION_RECEIPT_INVALID", `receipt entries[${index}].path`);
    if (typeof item.realpath !== "string" || item.realpath.length === 0) fail("ACTIVATION_RECEIPT_INVALID", `receipt entries[${index}].realpath`);
    return item.path as string;
  });
  const required = [...CLAUDE_ADAPTER_TEMPLATE_PATHS, CLAUDE_ADAPTER_SESSION_START_PATH];
  if (required.some((path) => !paths.includes(path))) fail("ACTIVATION_RECEIPT_INVALID", "receipt entry set");
  if (new Set(paths).size !== paths.length) fail("ACTIVATION_RECEIPT_INVALID", "receipt entry duplicate");
  const sorted = [...paths].sort(compareCanonicalText);
  if (paths.some((path, index) => path !== sorted[index])) fail("ACTIVATION_RECEIPT_INVALID", "receipt entry order");
  const entries = document.entries.map((entry) => {
    const item = entry as Record<string, unknown>;
    return { path: item.path as string, realpath: item.realpath as string, contentDigest: sha(item.contentDigest, "entry contentDigest"), identityDigest: sha(item.identityDigest, "entry identityDigest") };
  });
  const basis = {
    schemaVersion: CLAUDE_ADAPTER_INSTALLATION_V2_VERSION,
    generationId: id(document.generationId, "generationId"),
    bundleDigest: sha(document.bundleDigest, "receipt bundleDigest"),
    fragmentDigest: sha(document.fragmentDigest, "receipt fragmentDigest"),
    scriptDigest: sha(document.scriptDigest, "receipt scriptDigest"),
    installationRoot: document.installationRoot,
    entries,
  };
  if (sha(document.receiptDigest, "receipt receiptDigest") !== canonicalSha256(basis)) fail("ACTIVATION_RECEIPT_INVALID", "receiptDigest");
  return deepFreeze({ ...basis, receiptDigest: document.receiptDigest as string });
}

// Emit the existing rollback-plan shape (tcrn.claude-adapter-rollback-plan.v1)
// covering EVERY installed activation entry, so WSG-2's executeClaudeAdapterRollback
// removes the four templates AND session-start.mjs (AND persona-render.json when
// present) and then empties the .claude/tcrn-workflow directory byte-inverse.
export function generateClaudeAdapterActivationRollbackPlan(receiptValue: unknown, sourceIdentityDigest: string): Readonly<Record<string, unknown>> {
  const receipt = validateClaudeAdapterActivationInstallationReceipt(receiptValue);
  const removals = receipt.entries.map((entry) => ({ path: entry.path, realpath: entry.realpath, contentDigest: entry.contentDigest, identityDigest: entry.identityDigest }));
  const basis = {
    generationId: receipt.generationId,
    bundleDigest: receipt.bundleDigest,
    installationReceiptDigest: receipt.receiptDigest,
    installationSourceIdentityDigest: sha(sourceIdentityDigest, "sourceIdentityDigest"),
    removals,
  };
  return deepFreeze({ schemaVersion: CLAUDE_ADAPTER_ROLLBACK_PLAN_VERSION, reasonCode: "ADAPTER_ROLLBACK_PLANNED", activation: false, ...basis, planDigest: canonicalSha256(basis) });
}
