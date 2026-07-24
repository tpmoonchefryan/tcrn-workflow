// SPDX-License-Identifier: Apache-2.0
//
// EPIC-019 (INIT-010): verifiable conference execution provenance. Every export here
// is ADDITIVE to the frozen tcrn.conference.v1 records — nothing changes an accepted
// schema. executionMode rides the conference request's `extensions` slot; a
// host-execution receipt is a new standalone record type.
//
// The distinction it makes real: a conference whose positions were all written by
// one context (synthesis-only) versus one whose positions came from genuinely
// independent fresh-context invocations (multi-agent-deliberative). A host-execution
// receipt binds a position to a real host invocation by CONTENT digest — attribution,
// not identity proof. An unkeyed SHA-256 binds what was said, never who said it, so
// this can prove a position was NOT edited after the fact and did come from the bound
// invocation's output; it cannot prove the invocation's author, and it says so.
//
// Legacy conferences carry no execution:mode extension. They are classified
// legacy-unverified and are never retroactively presented as multi-agent — the read
// path fails closed toward "unverified", not toward a claim.

import { createHash } from "node:crypto";

import { assertProtocolId, compareCanonicalText, parseStrictInstant } from "../../protocol/src/index.js";

// The content binding is a plain UTF-8 SHA-256 of the position text: exactly what a
// collector computes over an invocation's final assistant message. It is unkeyed, so
// it binds content, not identity.
function contentDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const EXECUTION_MODES = Object.freeze(["synthesis-only", "multi-agent-deliberative"] as const);
export type ExecutionMode = typeof EXECUTION_MODES[number];

export const HOST_EXECUTION_RECEIPT_VERSION = "tcrn.host-execution-receipt.v1" as const;

// Extension keys. `execution:mode` sits on the conference request; `execution:receipt`
// sits on each position and names the host-execution receipt that substantiates it.
export const EXECUTION_MODE_EXTENSION_KEY = "execution:mode" as const;
export const EXECUTION_RECEIPT_EXTENSION_KEY = "execution:receipt" as const;

// Conference types whose default expectation is genuine multi-agent deliberation.
export const MULTI_AGENT_DEFAULT_TYPES = Object.freeze(["architecture", "strategy"] as const);

// Availability grading, shared with the EPIC-021 capability manifest vocabulary.
export const EXECUTION_AVAILABILITY = Object.freeze(["enforce", "observe", "invoke-only", "unavailable"] as const);

export const EXECUTION_REASON_CODES = Object.freeze([
  "EXECUTION_MODE_INVALID",
  "EXECUTION_RECEIPT_INVALID",
  "EXECUTION_UNICODE_INVALID",
  "EXECUTION_BUDGET_EXCEEDED",
  "EXECUTION_SYNTHESIS_UNMARKED",
  "EXECUTION_INDEPENDENCE_REQUIRED",
  "EXECUTION_BINDING_MISMATCH",
  "EXECUTION_RECEIPT_STALE_CONTEXT",
  "EXECUTION_VALIDATED",
] as const);
export type ExecutionReasonCode = typeof EXECUTION_REASON_CODES[number];

const maximumTextBytes = 2_048;
const maximumExtensionProperties = 64;
const shaPattern = /^[a-f0-9]{64}$/u;

export class ExecutionError extends Error {
  readonly reasonCode: ExecutionReasonCode;
  constructor(reasonCode: ExecutionReasonCode, message: string) {
    super(message);
    this.name = "ExecutionError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: ExecutionReasonCode, message: string): never {
  throw new ExecutionError(reasonCode, message);
}

function record(value: unknown, label: string, code: ExecutionReasonCode = "EXECUTION_RECEIPT_INVALID"): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code, label);
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string, code: ExecutionReasonCode = "EXECUTION_RECEIPT_INVALID"): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  if (actual.length !== wanted.length || wanted.some((field, index) => field !== actual[index])) fail(code, `${label}: field set`);
}

function id(value: unknown, label: string): string {
  try { assertProtocolId(value); } catch { fail("EXECUTION_RECEIPT_INVALID", label); }
  return value as string;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.length === 0) fail("EXECUTION_UNICODE_INVALID", label);
  if (Buffer.byteLength(value, "utf8") > maximumTextBytes) fail("EXECUTION_BUDGET_EXCEEDED", label);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) fail("EXECUTION_RECEIPT_INVALID", label);
  return value;
}

function instant(value: unknown, label: string): string {
  try { parseStrictInstant(value); } catch { fail("EXECUTION_RECEIPT_INVALID", label); }
  return value as string;
}

function nullableId(value: unknown, label: string): string | null {
  if (value === null) return null;
  return id(value, label);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface HostExecutionReceipt {
  readonly schemaVersion: typeof HOST_EXECUTION_RECEIPT_VERSION;
  readonly id: string;
  readonly conferenceId: string;
  readonly positionId: string;
  readonly hostProduct: string;
  readonly hostVersion: string;
  readonly sessionId: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly agentInvocationId: string;
  readonly freshContext: boolean;
  readonly invokedAt: string;
  readonly promptDigest: string;
  readonly outputDigest: string;
  readonly availability: typeof EXECUTION_AVAILABILITY[number];
  readonly attributionNote: string;
}

// A host-execution receipt binds ONE position to ONE real host invocation. The
// binding this record can carry is content, not identity: outputDigest is the
// SHA-256 of the invocation's final assistant message, which the validator checks
// against the position text byte-for-byte. attributionNote is a fixed string so no
// receipt can quietly upgrade itself to an identity claim.
export function validateHostExecutionReceipt(value: unknown): HostExecutionReceipt {
  const document = record(value, "host-execution receipt");
  if (document.schemaVersion !== HOST_EXECUTION_RECEIPT_VERSION) fail("EXECUTION_RECEIPT_INVALID", "schemaVersion");
  exact(document, [
    "schemaVersion", "id", "conferenceId", "positionId", "hostProduct", "hostVersion",
    "sessionId", "threadId", "turnId", "agentInvocationId", "freshContext", "invokedAt",
    "promptDigest", "outputDigest", "availability", "attributionNote",
  ], "host-execution receipt");
  if (typeof document.freshContext !== "boolean") fail("EXECUTION_RECEIPT_INVALID", "freshContext");
  if (!EXECUTION_AVAILABILITY.includes(document.availability as HostExecutionReceipt["availability"])) fail("EXECUTION_RECEIPT_INVALID", "availability");
  return deepFreeze({
    schemaVersion: HOST_EXECUTION_RECEIPT_VERSION,
    id: id(document.id, "id"),
    conferenceId: id(document.conferenceId, "conferenceId"),
    positionId: id(document.positionId, "positionId"),
    hostProduct: text(document.hostProduct, "hostProduct"),
    hostVersion: text(document.hostVersion, "hostVersion"),
    sessionId: id(document.sessionId, "sessionId"),
    threadId: nullableId(document.threadId, "threadId"),
    turnId: nullableId(document.turnId, "turnId"),
    agentInvocationId: id(document.agentInvocationId, "agentInvocationId"),
    freshContext: document.freshContext as boolean,
    invokedAt: instant(document.invokedAt, "invokedAt"),
    promptDigest: sha(document.promptDigest, "promptDigest"),
    outputDigest: sha(document.outputDigest, "outputDigest"),
    availability: document.availability as HostExecutionReceipt["availability"],
    attributionNote: text(document.attributionNote, "attributionNote"),
  });
}

export interface ExecutionModeDeclaration {
  readonly mode: ExecutionMode;
  readonly synthesisReason: string | null;
}

// Read the execution:mode extension off a validated conference request-shaped object.
// Returns null when the extension is absent (legacy conference); the caller treats
// null as legacy-unverified rather than as any mode.
export function readExecutionMode(requestLike: unknown): ExecutionModeDeclaration | null {
  const document = record(requestLike, "conference request");
  const extensionsValue = document.extensions;
  if (typeof extensionsValue !== "object" || extensionsValue === null || Array.isArray(extensionsValue)) fail("EXECUTION_MODE_INVALID", "extensions");
  const extensions = extensionsValue as Readonly<Record<string, unknown>>;
  if (Object.keys(extensions).length > maximumExtensionProperties) fail("EXECUTION_BUDGET_EXCEEDED", "extensions");
  const entry = extensions[EXECUTION_MODE_EXTENSION_KEY];
  if (entry === undefined) return null;
  const wrapper = record(entry, EXECUTION_MODE_EXTENSION_KEY, "EXECUTION_MODE_INVALID");
  exact(wrapper, ["required", "value"], EXECUTION_MODE_EXTENSION_KEY, "EXECUTION_MODE_INVALID");
  if (typeof wrapper.required !== "boolean") fail("EXECUTION_MODE_INVALID", "required");
  const detail = record(wrapper.value, `${EXECUTION_MODE_EXTENSION_KEY}.value`, "EXECUTION_MODE_INVALID");
  const keys = Object.keys(detail);
  if (keys.some((key) => key !== "mode" && key !== "synthesisReason")) fail("EXECUTION_MODE_INVALID", "value fields");
  const mode = detail.mode;
  if (mode !== "synthesis-only" && mode !== "multi-agent-deliberative") fail("EXECUTION_MODE_INVALID", "mode");
  const synthesisReason = detail.synthesisReason === undefined ? null : text(detail.synthesisReason, "synthesisReason");
  return deepFreeze({ mode: mode as ExecutionMode, synthesisReason });
}

export type ExecutionClassification =
  | { readonly mode: "legacy-unverified"; readonly reasonCode: "EXECUTION_VALIDATED"; readonly independentPositions: 0 }
  | { readonly mode: ExecutionMode; readonly reasonCode: "EXECUTION_VALIDATED"; readonly independentPositions: number };

export interface ClassifyInput {
  readonly request: { readonly id: string; readonly type: string; readonly extensions: Readonly<Record<string, unknown>> };
  readonly positions: readonly { readonly id: string; readonly conferenceId: string; readonly position: string; readonly extensions: Readonly<Record<string, unknown>> }[];
  readonly receipts: readonly HostExecutionReceipt[];
}

// The S052 default + S053 validation in one pass. Given a conference, its positions,
// and any host-execution receipts, classify the conference's execution provenance and
// FAIL CLOSED when a declared mode is not substantiated:
//   * no execution:mode extension          -> legacy-unverified (a read, never a claim)
//   * synthesis-only, arch/strategy         -> requires a stated synthesisReason
//   * multi-agent-deliberative              -> requires >= 2 positions, each bound via
//                                              execution:receipt to a DISTINCT receipt
//                                              with freshContext=true whose outputDigest
//                                              equals the SHA-256 of the position text
// A synthesis-only conference is never allowed to read as multi-agent; that is the
// whole point of the extension being explicit.
export function classifyConferenceExecution(input: ClassifyInput): ExecutionClassification {
  const declaration = readExecutionMode(input.request);
  if (declaration === null) {
    return deepFreeze({ mode: "legacy-unverified", reasonCode: "EXECUTION_VALIDATED", independentPositions: 0 });
  }
  const isDefaultMultiAgentType = (MULTI_AGENT_DEFAULT_TYPES as readonly string[]).includes(input.request.type);
  if (declaration.mode === "synthesis-only") {
    if (isDefaultMultiAgentType && declaration.synthesisReason === null) {
      fail("EXECUTION_SYNTHESIS_UNMARKED", `${input.request.type} conference marked synthesis-only without a reason`);
    }
    return deepFreeze({ mode: "synthesis-only", reasonCode: "EXECUTION_VALIDATED", independentPositions: 0 });
  }
  // multi-agent-deliberative: substantiate CONSISTENCY, not AUTHENTICITY. This proves
  // every bound position's text matches its receipt's output digest and the bound
  // receipts name distinct fresh-context invocations — it does NOT prove the receipts
  // came from genuinely independent hosts. An unkeyed content digest binds what was
  // said, not who said it, so a single context that fabricates its own receipt set
  // passes this check. Authenticity is the trusted collector's job (EPIC-020); this
  // classifier is the consistency gate that a real collector's output must also clear.
  // Receipts are re-validated here rather than trusted by TypeScript alone, so a
  // truthy-but-non-boolean freshContext or a malformed digest fails closed.
  const receiptsById = new Map(input.receipts.map((value) => {
    const receipt = validateHostExecutionReceipt(value);
    return [receipt.id, receipt] as const;
  }));
  const boundInvocations = new Set<string>();
  const seenPositions = new Set<string>();
  for (const position of input.positions) {
    if (position.conferenceId !== input.request.id || seenPositions.has(position.id)) continue;
    const entry = position.extensions[EXECUTION_RECEIPT_EXTENSION_KEY];
    if (entry === undefined) continue;
    seenPositions.add(position.id);
    const wrapper = record(entry, EXECUTION_RECEIPT_EXTENSION_KEY);
    exact(wrapper, ["required", "value"], EXECUTION_RECEIPT_EXTENSION_KEY);
    const detail = record(wrapper.value, `${EXECUTION_RECEIPT_EXTENSION_KEY}.value`);
    if (Object.keys(detail).some((key) => key !== "receiptId")) fail("EXECUTION_RECEIPT_INVALID", "receipt reference fields");
    const receiptId = id(detail.receiptId, "receiptId");
    const receipt = receiptsById.get(receiptId);
    if (receipt === undefined || receipt.positionId !== position.id || receipt.conferenceId !== input.request.id) fail("EXECUTION_BINDING_MISMATCH", `position ${position.id}`);
    if (!receipt.freshContext) fail("EXECUTION_RECEIPT_STALE_CONTEXT", `receipt ${receipt.id}`);
    if (contentDigest(text(position.position, `position ${position.id} text`)) !== receipt.outputDigest) fail("EXECUTION_BINDING_MISMATCH", `receipt ${receipt.id} output digest`);
    boundInvocations.add(receipt.agentInvocationId);
  }
  if (boundInvocations.size < 2) fail("EXECUTION_INDEPENDENCE_REQUIRED", `only ${boundInvocations.size} distinct fresh-context invocation(s) bound`);
  return deepFreeze({ mode: "multi-agent-deliberative", reasonCode: "EXECUTION_VALIDATED", independentPositions: boundInvocations.size });
}
