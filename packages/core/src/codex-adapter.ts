// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { canonicalJson, canonicalSha256, assertProtocolId, compareCanonicalText, parseStrictInstant } from "../../protocol/src/index.js";
import { validateContextRouteResult } from "./context-router.js";

export const CODEX_ADAPTER_REQUEST_VERSION = "tcrn.codex-adapter-request.v1" as const;
export const CODEX_ADAPTER_HOST_VERSION = "tcrn.codex-adapter-host.v1" as const;
export const CODEX_ADAPTER_BUNDLE_VERSION = "tcrn.codex-adapter-bundle.v1" as const;
export const CODEX_ADAPTER_FALLBACK_VERSION = "tcrn.codex-adapter-fallback.v1" as const;
export const CODEX_ADAPTER_LIFECYCLE_VERSION = "tcrn.codex-adapter-lifecycle.v1" as const;
export const CODEX_ADAPTER_INSTALLATION_VERSION = "tcrn.codex-adapter-installation-generation.v1" as const;

export const CODEX_ADAPTER_REASON_CODES = Object.freeze([
  "ADAPTER_BINDING_MISMATCH",
  "ADAPTER_BUDGET_EXCEEDED",
  "ADAPTER_BUNDLE_GENERATED",
  "ADAPTER_BUNDLE_INVALID",
  "ADAPTER_CANONICAL_INVALID",
  "ADAPTER_CONTEXT_STALE",
  "ADAPTER_FINAL_HOP_BLOCKED",
  "ADAPTER_FINAL_HOP_DELIVERED",
  "ADAPTER_FINAL_HOP_DUPLICATE",
  "ADAPTER_FINAL_HOP_REQUIRED",
  "ADAPTER_GOVERNED_ROUTING_REQUIRED",
  "ADAPTER_HOST_MISMATCH",
  "ADAPTER_HOST_REQUIRED",
  "ADAPTER_INSTALLATION_CANONICAL_INVALID",
  "ADAPTER_INSTALLATION_CHANGED",
  "ADAPTER_INSTALLATION_DIGEST",
  "ADAPTER_INSTALLATION_LINK",
  "ADAPTER_INSTALLATION_MALFORMED",
  "ADAPTER_INSTALLATION_MISMATCH",
  "ADAPTER_INSTALLATION_PATH",
  "ADAPTER_INSTALLATION_REQUIRED",
  "ADAPTER_INSTALLATION_SPECIAL_FILE",
  "ADAPTER_PATH_INVALID",
  "ADAPTER_ROLLBACK_MISMATCH",
  "ADAPTER_ROLLBACK_PLANNED",
  "ADAPTER_SCHEMA_INVALID",
  "ADAPTER_UNICODE_INVALID",
  "ADAPTER_UNKNOWN_FIELD",
  "ADAPTER_VALIDATED",
] as const);

export type CodexAdapterReasonCode = typeof CODEX_ADAPTER_REASON_CODES[number];
export type CodexAdapterGovernedAction = "generate" | "validate" | "simulate";

export interface CodexAdapterRequest {
  readonly schemaVersion: typeof CODEX_ADAPTER_REQUEST_VERSION;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly workId: string | null;
  readonly contextResult: Readonly<Record<string, unknown>>;
  readonly promptText: string;
  readonly environmentText: string;
  readonly rawSessionText: string;
}

export interface CodexAdapterHostInput {
  readonly schemaVersion: typeof CODEX_ADAPTER_HOST_VERSION;
  readonly requestDigest: string;
  readonly contextDigest: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly workId: string | null;
  readonly governedAction: CodexAdapterGovernedAction;
  readonly contextIssuedAt: string;
  readonly contextExpiresAt: string;
  readonly verificationTime: string;
  readonly installationTarget: "inert_bundle_only";
  readonly activationAllowed: false;
  readonly hostDigest: string;
}

export interface CodexAdapterHostContext {
  readonly input: CodexAdapterHostInput;
}

export interface CodexAdapterInstallationFileIdentity {
  readonly expectedCanonicalPath: string;
  readonly expectedFileSha256: string;
}

export interface CodexAdapterInstallationEntry {
  readonly path: string;
  readonly realpath: string;
  readonly contentDigest: string;
  readonly identityDigest: string;
}

export interface CodexAdapterInstallationReceipt {
  readonly schemaVersion: typeof CODEX_ADAPTER_INSTALLATION_VERSION;
  readonly generationId: string;
  readonly bundleDigest: string;
  readonly installationRoot: string;
  readonly entries: readonly CodexAdapterInstallationEntry[];
  readonly receiptDigest: string;
}

export interface CodexAdapterInstallationContext {
  readonly receipt: CodexAdapterInstallationReceipt;
  readonly sourcePath: string;
  readonly authorityFileSha256: string;
  readonly sourceIdentityDigest: string;
}

export interface CodexAdapterInstallationReadOptions {
  readonly afterReceiptLstat?: () => void | Promise<void>;
  readonly afterEntryLstat?: (path: string, index: number) => void | Promise<void>;
}

export interface CodexAdapterFile {
  readonly path: string;
  readonly content: string;
  readonly contentDigest: string;
  readonly mode: "inert_json";
}

export interface CodexAdapterBundle {
  readonly schemaVersion: typeof CODEX_ADAPTER_BUNDLE_VERSION;
  readonly reasonCode: "ADAPTER_BUNDLE_GENERATED";
  readonly activation: false;
  readonly requestDigest: string;
  readonly contextDigest: string;
  readonly hostDigest: string;
  readonly files: readonly CodexAdapterFile[];
  readonly manifestDigest: string;
  readonly rollback: readonly {
    readonly path: string;
    readonly contentDigest: string;
    readonly removalPolicy: "identity_digest_match_only";
    readonly requireNoFollow: true;
    readonly requireRegularSingleLink: true;
  }[];
  readonly bundleDigest: string;
}

export const CODEX_ADAPTER_TEMPLATE_PATHS = Object.freeze([
  ".codex/tcrn-workflow/bootstrap.json",
  ".codex/tcrn-workflow/final-hop.json",
  ".codex/tcrn-workflow/project.json",
  ".codex/tcrn-workflow/stop.json",
] as const);

const hostContexts = new WeakSet<object>();
const installationContexts = new WeakSet<object>();
const shaPattern = /^[a-f0-9]{64}$/u;
const maximumUntrustedBytes = 8_192;

export class CodexAdapterError extends Error {
  readonly reasonCode: CodexAdapterReasonCode;
  constructor(reasonCode: CodexAdapterReasonCode, message: string) {
    super(message);
    this.name = "CodexAdapterError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: CodexAdapterReasonCode, message: string): never {
  throw new CodexAdapterError(reasonCode, message);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("ADAPTER_SCHEMA_INVALID", label);
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  const unknown = actual.filter((field) => !wanted.includes(field));
  if (unknown.length > 0) fail("ADAPTER_UNKNOWN_FIELD", `${label}:${unknown.join(",")}`);
  if (wanted.some((field) => !actual.includes(field))) fail("ADAPTER_SCHEMA_INVALID", label);
}

function text(value: unknown, label: string, maximumBytes = maximumUntrustedBytes): string {
  if (typeof value !== "string" || !value.isWellFormed()) fail("ADAPTER_UNICODE_INVALID", label);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) fail("ADAPTER_BUDGET_EXCEEDED", label);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) fail("ADAPTER_SCHEMA_INVALID", label);
  return value;
}

function rawSha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function id(value: unknown, label: string): string {
  try { assertProtocolId(value); } catch { fail("ADAPTER_SCHEMA_INVALID", label); }
  return value as string;
}

function nullableId(value: unknown, label: string): string | null {
  return value === null ? null : id(value, label);
}

function instant(value: unknown, label: string): string {
  try { parseStrictInstant(value); } catch { fail("ADAPTER_SCHEMA_INVALID", label); }
  return value as string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sameIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function identityDigest(value: Awaited<ReturnType<typeof lstat>>): string {
  return canonicalSha256({ dev: String(value.dev), ino: String(value.ino), size: String(value.size), mtimeMs: String(value.mtimeMs), ctimeMs: String(value.ctimeMs) });
}

function bindingFromResult(result: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const context = record(result.context, "context result context");
  const authority = record(context.authoritySummary, "context authority summary");
  return record(authority.binding, "context binding");
}

export function validateCodexAdapterRequest(value: unknown): CodexAdapterRequest {
  const document = record(value, "adapter request");
  exact(document, ["schemaVersion", "workspaceId", "projectId", "workId", "contextResult", "promptText", "environmentText", "rawSessionText"], "adapter request");
  if (document.schemaVersion !== CODEX_ADAPTER_REQUEST_VERSION) fail("ADAPTER_SCHEMA_INVALID", "adapter request version");
  const contextResult = validateContextRouteResult(document.contextResult);
  return deepFreeze({
    schemaVersion: CODEX_ADAPTER_REQUEST_VERSION,
    workspaceId: id(document.workspaceId, "workspaceId"),
    projectId: id(document.projectId, "projectId"),
    workId: nullableId(document.workId, "workId"),
    contextResult,
    promptText: text(document.promptText, "promptText"),
    environmentText: text(document.environmentText, "environmentText"),
    rawSessionText: text(document.rawSessionText, "rawSessionText"),
  });
}

export function calculateCodexAdapterRequestDigest(value: unknown): string {
  return canonicalSha256(validateCodexAdapterRequest(value));
}

export function admitCodexAdapterHostInput(value: unknown): CodexAdapterHostContext {
  const document = record(value, "adapter host input");
  exact(document, ["schemaVersion", "requestDigest", "contextDigest", "workspaceId", "projectId", "workId", "governedAction", "contextIssuedAt", "contextExpiresAt", "verificationTime", "installationTarget", "activationAllowed", "hostDigest"], "adapter host input");
  if (document.schemaVersion !== CODEX_ADAPTER_HOST_VERSION || !["generate", "validate", "simulate"].includes(String(document.governedAction)) ||
    document.installationTarget !== "inert_bundle_only" || document.activationAllowed !== false) fail("ADAPTER_SCHEMA_INVALID", "adapter host header");
  const basis = {
    schemaVersion: CODEX_ADAPTER_HOST_VERSION,
    requestDigest: sha(document.requestDigest, "host requestDigest"),
    contextDigest: sha(document.contextDigest, "host contextDigest"),
    workspaceId: id(document.workspaceId, "host workspaceId"),
    projectId: id(document.projectId, "host projectId"),
    workId: nullableId(document.workId, "host workId"),
    governedAction: document.governedAction as CodexAdapterGovernedAction,
    contextIssuedAt: instant(document.contextIssuedAt, "host contextIssuedAt"),
    contextExpiresAt: instant(document.contextExpiresAt, "host contextExpiresAt"),
    verificationTime: instant(document.verificationTime, "host verificationTime"),
    installationTarget: "inert_bundle_only" as const,
    activationAllowed: false as const,
  };
  if (parseStrictInstant(basis.contextIssuedAt) > parseStrictInstant(basis.verificationTime) || parseStrictInstant(basis.verificationTime) >= parseStrictInstant(basis.contextExpiresAt)) fail("ADAPTER_CONTEXT_STALE", "host context validity window");
  if (sha(document.hostDigest, "hostDigest") !== canonicalSha256(basis)) fail("ADAPTER_CANONICAL_INVALID", "hostDigest");
  const context = deepFreeze({ input: { ...basis, hostDigest: document.hostDigest as string } });
  hostContexts.add(context);
  return context;
}

function assertHost(request: CodexAdapterRequest, host: CodexAdapterHostContext | undefined): CodexAdapterHostInput {
  if (!host || !hostContexts.has(host)) fail("ADAPTER_HOST_REQUIRED", "independently governed host input required");
  const input = host.input;
  const contextDigest = sha(request.contextResult.contextDigest, "contextDigest");
  const binding = bindingFromResult(request.contextResult);
  if (input.requestDigest !== canonicalSha256(request) || input.contextDigest !== contextDigest || input.governedAction !== "generate" ||
    input.workspaceId !== request.workspaceId || input.projectId !== request.projectId || input.workId !== request.workId) fail("ADAPTER_HOST_MISMATCH", "request, target, or action");
  if (binding.mode !== "workspace" && binding.mode !== "project" && binding.mode !== "command") fail("ADAPTER_BINDING_MISMATCH", "bound context required");
  if (binding.workspaceId !== request.workspaceId || (binding.projectId !== null && binding.projectId !== request.projectId)) fail("ADAPTER_BINDING_MISMATCH", "workspace or project");
  return input;
}

function templateContents(request: CodexAdapterRequest, host: CodexAdapterHostInput): Readonly<Record<string, string>> {
  const result = request.contextResult;
  const context = record(result.context, "context");
  const authority = record(context.authoritySummary, "authority summary");
  const common = { activation: false, contextDigest: host.contextDigest, hostDigest: host.hostDigest, requestDigest: host.requestDigest };
  return {
    ".codex/tcrn-workflow/bootstrap.json": canonicalJson({ schemaVersion: "tcrn.codex-adapter-bootstrap-template.v1", ...common, routing: "governed_context_required", ambientDiscovery: false }),
    ".codex/tcrn-workflow/final-hop.json": canonicalJson({ schemaVersion: "tcrn.codex-adapter-final-hop-template.v1", ...common, behavior: "single_owner_visible_response_after_governed_routing", duplicate: "reject", receiptRetention: "metadata_only" }),
    ".codex/tcrn-workflow/project.json": canonicalJson({ schemaVersion: "tcrn.codex-adapter-project-template.v1", ...common, workspaceId: host.workspaceId, projectId: host.projectId, workId: host.workId, profileId: authority.profileId, effectivePolicyDigest: authority.effectivePolicyDigest, operationAuthority: "none_until_live_governed_activation" }),
    ".codex/tcrn-workflow/stop.json": canonicalJson({ schemaVersion: "tcrn.codex-adapter-stop-template.v1", ...common, behavior: "preserve_required_final_hop", rawInputRetention: "none" }),
  };
}

export function generateCodexAdapterBundle(value: unknown, host?: CodexAdapterHostContext, templateOrder: readonly string[] = CODEX_ADAPTER_TEMPLATE_PATHS): CodexAdapterBundle {
  const request = validateCodexAdapterRequest(value);
  const admitted = assertHost(request, host);
  if (templateOrder.length !== CODEX_ADAPTER_TEMPLATE_PATHS.length || new Set(templateOrder).size !== CODEX_ADAPTER_TEMPLATE_PATHS.length ||
    templateOrder.some((path) => !CODEX_ADAPTER_TEMPLATE_PATHS.includes(path as typeof CODEX_ADAPTER_TEMPLATE_PATHS[number]))) fail("ADAPTER_PATH_INVALID", "template order");
  const contents = templateContents(request, admitted);
  const files = templateOrder.map((path) => ({ path, content: contents[path] as string, contentDigest: rawSha(contents[path] as string), mode: "inert_json" as const }))
    .sort((left, right) => compareCanonicalText(left.path, right.path));
  const manifestDigest = canonicalSha256(files.map(({ path, contentDigest, mode }) => ({ path, contentDigest, mode })));
  const rollback = files.map(({ path, contentDigest }) => ({ path, contentDigest, removalPolicy: "identity_digest_match_only" as const, requireNoFollow: true as const, requireRegularSingleLink: true as const }));
  const basis = { schemaVersion: CODEX_ADAPTER_BUNDLE_VERSION, reasonCode: "ADAPTER_BUNDLE_GENERATED" as const, activation: false as const, requestDigest: admitted.requestDigest, contextDigest: admitted.contextDigest, hostDigest: admitted.hostDigest, files, manifestDigest, rollback };
  return deepFreeze({ ...basis, bundleDigest: canonicalSha256(basis) });
}

function validateTemplateContent(path: string, content: string, common: { readonly requestDigest: string; readonly contextDigest: string; readonly hostDigest: string }): void {
  let parsed: Readonly<Record<string, unknown>>;
  try { parsed = record(JSON.parse(content), `template ${path}`); } catch (error) {
    if (error instanceof CodexAdapterError) throw error;
    fail("ADAPTER_BUNDLE_INVALID", `template ${path}`);
  }
  let canonicalContent: string;
  try { canonicalContent = canonicalJson(parsed); } catch { fail("ADAPTER_CANONICAL_INVALID", `template bytes ${path}`); }
  if (canonicalContent !== content) fail("ADAPTER_CANONICAL_INVALID", `template bytes ${path}`);
  const shared = ["schemaVersion", "activation", "contextDigest", "hostDigest", "requestDigest"];
  const specific = path.endsWith("bootstrap.json") ? ["routing", "ambientDiscovery"]
    : path.endsWith("final-hop.json") ? ["behavior", "duplicate", "receiptRetention"]
      : path.endsWith("project.json") ? ["workspaceId", "projectId", "workId", "profileId", "effectivePolicyDigest", "operationAuthority"]
        : ["behavior", "rawInputRetention"];
  exact(parsed, [...shared, ...specific], `template ${path}`);
  if (parsed.activation !== false || parsed.contextDigest !== common.contextDigest || parsed.hostDigest !== common.hostDigest || parsed.requestDigest !== common.requestDigest) fail("ADAPTER_BUNDLE_INVALID", `template binding ${path}`);
  if (path.endsWith("bootstrap.json") && (parsed.schemaVersion !== "tcrn.codex-adapter-bootstrap-template.v1" || parsed.routing !== "governed_context_required" || parsed.ambientDiscovery !== false)) fail("ADAPTER_BUNDLE_INVALID", path);
  if (path.endsWith("final-hop.json") && (parsed.schemaVersion !== "tcrn.codex-adapter-final-hop-template.v1" || parsed.behavior !== "single_owner_visible_response_after_governed_routing" || parsed.duplicate !== "reject" || parsed.receiptRetention !== "metadata_only")) fail("ADAPTER_BUNDLE_INVALID", path);
  if (path.endsWith("project.json")) {
    if (parsed.schemaVersion !== "tcrn.codex-adapter-project-template.v1" || parsed.operationAuthority !== "none_until_live_governed_activation") fail("ADAPTER_BUNDLE_INVALID", path);
    id(parsed.workspaceId, `${path}.workspaceId`); id(parsed.projectId, `${path}.projectId`); nullableId(parsed.workId, `${path}.workId`); id(parsed.profileId, `${path}.profileId`); sha(parsed.effectivePolicyDigest, `${path}.effectivePolicyDigest`);
  }
  if (path.endsWith("stop.json") && (parsed.schemaVersion !== "tcrn.codex-adapter-stop-template.v1" || parsed.behavior !== "preserve_required_final_hop" || parsed.rawInputRetention !== "none")) fail("ADAPTER_BUNDLE_INVALID", path);
}

export function validateCodexAdapterBundle(value: unknown): CodexAdapterBundle {
  const document = record(value, "adapter bundle");
  exact(document, ["schemaVersion", "reasonCode", "activation", "requestDigest", "contextDigest", "hostDigest", "files", "manifestDigest", "rollback", "bundleDigest"], "adapter bundle");
  if (document.schemaVersion !== CODEX_ADAPTER_BUNDLE_VERSION || document.reasonCode !== "ADAPTER_BUNDLE_GENERATED" || document.activation !== false || !Array.isArray(document.files) || !Array.isArray(document.rollback) || document.files.length !== CODEX_ADAPTER_TEMPLATE_PATHS.length || document.rollback.length !== CODEX_ADAPTER_TEMPLATE_PATHS.length) fail("ADAPTER_BUNDLE_INVALID", "bundle header");
  const requestDigest = sha(document.requestDigest, "requestDigest");
  const contextDigest = sha(document.contextDigest, "contextDigest");
  const hostDigest = sha(document.hostDigest, "hostDigest");
  const files = document.files.map((entry, index) => {
    const file = record(entry, `files[${index}]`); exact(file, ["path", "content", "contentDigest", "mode"], `files[${index}]`);
    if (file.path !== CODEX_ADAPTER_TEMPLATE_PATHS[index] || file.mode !== "inert_json") fail("ADAPTER_PATH_INVALID", `files[${index}]`);
    const content = text(file.content, `files[${index}].content`, 65_536);
    if (sha(file.contentDigest, `files[${index}].contentDigest`) !== rawSha(content)) fail("ADAPTER_CANONICAL_INVALID", `files[${index}]`);
    validateTemplateContent(file.path as string, content, { requestDigest, contextDigest, hostDigest });
    return { path: file.path as string, content, contentDigest: file.contentDigest as string, mode: "inert_json" as const };
  });
  const rollback = document.rollback.map((entry, index) => {
    const item = record(entry, `rollback[${index}]`); exact(item, ["path", "contentDigest", "removalPolicy", "requireNoFollow", "requireRegularSingleLink"], `rollback[${index}]`);
    if (item.path !== files[index]?.path || item.contentDigest !== files[index]?.contentDigest || item.removalPolicy !== "identity_digest_match_only" || item.requireNoFollow !== true || item.requireRegularSingleLink !== true) fail("ADAPTER_ROLLBACK_MISMATCH", `rollback[${index}]`);
    return { path: item.path as string, contentDigest: item.contentDigest as string, removalPolicy: "identity_digest_match_only" as const, requireNoFollow: true as const, requireRegularSingleLink: true as const };
  });
  const manifestDigest = canonicalSha256(files.map(({ path, contentDigest, mode }) => ({ path, contentDigest, mode })));
  if (sha(document.manifestDigest, "manifestDigest") !== manifestDigest) fail("ADAPTER_CANONICAL_INVALID", "manifestDigest");
  const basis = { schemaVersion: CODEX_ADAPTER_BUNDLE_VERSION, reasonCode: "ADAPTER_BUNDLE_GENERATED" as const, activation: false as const, requestDigest, contextDigest, hostDigest, files, manifestDigest, rollback };
  if (sha(document.bundleDigest, "bundleDigest") !== canonicalSha256(basis)) fail("ADAPTER_CANONICAL_INVALID", "bundleDigest");
  return deepFreeze({ ...basis, bundleDigest: document.bundleDigest as string });
}

export function codexAdapterAuthorityEmptyFallback(value: unknown): Readonly<Record<string, unknown>> {
  const document = record(value, "adapter fallback input");
  exact(document, ["promptText", "environmentText", "rawSessionText"], "adapter fallback input");
  const digests = {
    environmentDigest: canonicalSha256(text(document.environmentText, "environmentText")),
    promptDigest: canonicalSha256(text(document.promptText, "promptText")),
    rawSessionDigest: canonicalSha256(text(document.rawSessionText, "rawSessionText")),
  };
  return deepFreeze({ schemaVersion: CODEX_ADAPTER_FALLBACK_VERSION, reasonCode: "ADAPTER_GOVERNED_ROUTING_REQUIRED", authority: "none", operation: null, needsGovernedRouting: true, inputDigests: digests });
}

export function simulateCodexAdapterLifecycle(value: unknown): Readonly<Record<string, unknown>> {
  const document = record(value, "adapter lifecycle");
  exact(document, ["schemaVersion", "contextDigest", "governedRoutingSucceeded", "stopRequests", "finalHopRequests"], "adapter lifecycle");
  if (document.schemaVersion !== CODEX_ADAPTER_LIFECYCLE_VERSION || typeof document.governedRoutingSucceeded !== "boolean" || !Number.isSafeInteger(document.stopRequests) || !Number.isSafeInteger(document.finalHopRequests) || (document.stopRequests as number) < 0 || (document.stopRequests as number) > 2 || (document.finalHopRequests as number) < 0 || (document.finalHopRequests as number) > 2) fail("ADAPTER_SCHEMA_INVALID", "adapter lifecycle values");
  const contextDigest = sha(document.contextDigest, "lifecycle contextDigest");
  const routed = document.governedRoutingSucceeded as boolean, finalHops = document.finalHopRequests as number;
  const reasonCode = !routed ? "ADAPTER_FINAL_HOP_BLOCKED" : finalHops === 0 ? "ADAPTER_FINAL_HOP_REQUIRED" : finalHops === 1 ? "ADAPTER_FINAL_HOP_DELIVERED" : "ADAPTER_FINAL_HOP_DUPLICATE";
  return deepFreeze({ schemaVersion: CODEX_ADAPTER_LIFECYCLE_VERSION, reasonCode, contextDigest, ownerVisibleResponses: routed && finalHops > 0 ? 1 : 0, finalHopPending: routed && finalHops === 0, rawInputRetained: false });
}

function validateInstallationReceipt(value: unknown): CodexAdapterInstallationReceipt {
  const document = record(value, "adapter installation receipt");
  exact(document, ["schemaVersion", "generationId", "bundleDigest", "installationRoot", "entries", "receiptDigest"], "adapter installation receipt");
  if (document.schemaVersion !== CODEX_ADAPTER_INSTALLATION_VERSION || !Array.isArray(document.entries) || document.entries.length !== CODEX_ADAPTER_TEMPLATE_PATHS.length || typeof document.installationRoot !== "string" || !isAbsolute(document.installationRoot) || resolve(document.installationRoot) !== document.installationRoot) fail("ADAPTER_INSTALLATION_MALFORMED", "installation receipt header");
  const entries = document.entries.map((entry, index) => {
    const item = record(entry, `installation entries[${index}]`);
    exact(item, ["path", "realpath", "contentDigest", "identityDigest"], `installation entries[${index}]`);
    if (item.path !== CODEX_ADAPTER_TEMPLATE_PATHS[index] || typeof item.realpath !== "string" || !isAbsolute(item.realpath) || resolve(item.realpath) !== item.realpath) fail("ADAPTER_INSTALLATION_PATH", `installation entries[${index}]`);
    return { path: item.path as string, realpath: item.realpath, contentDigest: sha(item.contentDigest, `installation entries[${index}].contentDigest`), identityDigest: sha(item.identityDigest, `installation entries[${index}].identityDigest`) };
  });
  const basis = { schemaVersion: CODEX_ADAPTER_INSTALLATION_VERSION, generationId: id(document.generationId, "generationId"), bundleDigest: sha(document.bundleDigest, "installation bundleDigest"), installationRoot: document.installationRoot, entries };
  if (sha(document.receiptDigest, "installation receiptDigest") !== canonicalSha256(basis)) fail("ADAPTER_INSTALLATION_MISMATCH", "installation receiptDigest");
  return { ...basis, receiptDigest: document.receiptDigest as string };
}

export async function readCodexAdapterInstallationReceipt(
  path: string,
  authority?: CodexAdapterInstallationFileIdentity,
  options: CodexAdapterInstallationReadOptions = {},
): Promise<CodexAdapterInstallationContext> {
  if (!authority) fail("ADAPTER_INSTALLATION_REQUIRED", "out-of-band installation authority required");
  if (!isAbsolute(authority.expectedCanonicalPath) || resolve(authority.expectedCanonicalPath) !== authority.expectedCanonicalPath || path !== authority.expectedCanonicalPath) fail("ADAPTER_INSTALLATION_PATH", path);
  if (!shaPattern.test(authority.expectedFileSha256)) fail("ADAPTER_INSTALLATION_DIGEST", path);
  let before;
  try { before = await lstat(path); } catch { fail("ADAPTER_INSTALLATION_CHANGED", path); }
  if (before.isSymbolicLink() || before.nlink !== 1) fail("ADAPTER_INSTALLATION_LINK", path);
  if (!before.isFile()) fail("ADAPTER_INSTALLATION_SPECIAL_FILE", path);
  if (before.size < 2 || before.size > 65_536) fail("ADAPTER_INSTALLATION_MALFORMED", path);
  await options.afterReceiptLstat?.();
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { fail("ADAPTER_INSTALLATION_CHANGED", path); }
  let content: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(before, opened)) fail("ADAPTER_INSTALLATION_CHANGED", path);
    content = await handle.readFile();
    const after = await handle.stat(), named = await lstat(path);
    if (!sameIdentity(opened, after) || !sameIdentity(after, named) || content.length !== after.size) fail("ADAPTER_INSTALLATION_CHANGED", path);
  } finally { await handle.close(); }
  const canonicalPath = await realpath(path).catch(() => fail("ADAPTER_INSTALLATION_CHANGED", path));
  if (canonicalPath !== authority.expectedCanonicalPath) fail("ADAPTER_INSTALLATION_PATH", path);
  const fileSha256 = createHash("sha256").update(content).digest("hex");
  if (fileSha256 !== authority.expectedFileSha256) fail("ADAPTER_INSTALLATION_DIGEST", path);
  const sourceText = content.toString("utf8");
  if (!Buffer.from(sourceText, "utf8").equals(content)) fail("ADAPTER_INSTALLATION_MALFORMED", path);
  let parsed: unknown;
  try { parsed = JSON.parse(sourceText); } catch { fail("ADAPTER_INSTALLATION_MALFORMED", path); }
  let canonicalReceipt: string;
  try { canonicalReceipt = `${canonicalJson(parsed)}\n`; } catch { fail("ADAPTER_INSTALLATION_CANONICAL_INVALID", path); }
  if (canonicalReceipt !== sourceText) fail("ADAPTER_INSTALLATION_CANONICAL_INVALID", path);
  const receipt = validateInstallationReceipt(parsed);
  const rootRealpath = await realpath(receipt.installationRoot).catch(() => fail("ADAPTER_INSTALLATION_PATH", receipt.installationRoot));
  const rootStat = await lstat(receipt.installationRoot).catch(() => fail("ADAPTER_INSTALLATION_PATH", receipt.installationRoot));
  if (rootRealpath !== receipt.installationRoot || rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("ADAPTER_INSTALLATION_PATH", receipt.installationRoot);
  for (let index = 0; index < receipt.entries.length; index += 1) {
    const entry = receipt.entries[index] as CodexAdapterInstallationEntry;
    const expectedPath = resolve(receipt.installationRoot, entry.path);
    if (expectedPath !== entry.realpath || !expectedPath.startsWith(`${receipt.installationRoot}/`)) fail("ADAPTER_INSTALLATION_PATH", entry.path);
    let entryBefore;
    try { entryBefore = await lstat(expectedPath); } catch { fail("ADAPTER_INSTALLATION_CHANGED", entry.path); }
    if (entryBefore.isSymbolicLink() || entryBefore.nlink !== 1) fail("ADAPTER_INSTALLATION_LINK", entry.path);
    if (!entryBefore.isFile()) fail("ADAPTER_INSTALLATION_SPECIAL_FILE", entry.path);
    await options.afterEntryLstat?.(expectedPath, index);
    let entryHandle;
    try { entryHandle = await open(expectedPath, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { fail("ADAPTER_INSTALLATION_CHANGED", entry.path); }
    let entryContent: Buffer;
    try {
      const opened = await entryHandle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(entryBefore, opened)) fail("ADAPTER_INSTALLATION_CHANGED", entry.path);
      entryContent = await entryHandle.readFile();
      const after = await entryHandle.stat(), named = await lstat(expectedPath);
      if (!sameIdentity(opened, after) || !sameIdentity(after, named) || entryContent.length !== after.size) fail("ADAPTER_INSTALLATION_CHANGED", entry.path);
    } finally { await entryHandle.close(); }
    const namedRealpath = await realpath(expectedPath).catch(() => fail("ADAPTER_INSTALLATION_CHANGED", entry.path));
    if (namedRealpath !== entry.realpath) fail("ADAPTER_INSTALLATION_PATH", entry.path);
    if (createHash("sha256").update(entryContent).digest("hex") !== entry.contentDigest || identityDigest(entryBefore) !== entry.identityDigest) fail("ADAPTER_INSTALLATION_MISMATCH", entry.path);
  }
  const context = deepFreeze({ receipt, sourcePath: path, authorityFileSha256: fileSha256, sourceIdentityDigest: identityDigest(before) });
  installationContexts.add(context);
  return context;
}

export function planCodexAdapterRollback(bundleValue: unknown, installationValue: unknown): Readonly<Record<string, unknown>> {
  const bundle = validateCodexAdapterBundle(bundleValue);
  if (typeof installationValue !== "object" || installationValue === null || !installationContexts.has(installationValue)) fail("ADAPTER_INSTALLATION_REQUIRED", "descriptor-bound installation generation required");
  const installation = installationValue as CodexAdapterInstallationContext;
  if (installation.receipt.bundleDigest !== bundle.bundleDigest) fail("ADAPTER_INSTALLATION_MISMATCH", "bundle generation");
  const removals = installation.receipt.entries.map((entry, index) => {
    if (entry.path !== bundle.files[index]?.path || entry.contentDigest !== bundle.files[index]?.contentDigest) fail("ADAPTER_ROLLBACK_MISMATCH", entry.path);
    return { path: entry.path, realpath: entry.realpath, contentDigest: entry.contentDigest, identityDigest: entry.identityDigest };
  });
  const basis = { generationId: installation.receipt.generationId, bundleDigest: bundle.bundleDigest, installationReceiptDigest: installation.receipt.receiptDigest, installationSourceIdentityDigest: installation.sourceIdentityDigest, removals };
  return deepFreeze({ schemaVersion: "tcrn.codex-adapter-rollback-plan.v1", reasonCode: "ADAPTER_ROLLBACK_PLANNED", activation: false, ...basis, planDigest: canonicalSha256(basis) });
}
