// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import {
  ProtocolError,
  assertCanonicalJson,
  assertProtocolId,
  assertStrictInstant,
  canonicalExternalKey,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  deriveStableId,
  parseStrictInstant,
  validateKnowledgeRecord,
} from "../../protocol/src/index.js";
import type { JsonValue, KnowledgeRecord } from "../../protocol/src/index.js";
import { redactArtifactReference } from "./artifact-lifecycle.js";
import { materializeWorkspace } from "./workspace.js";
import type { WorkspaceState } from "./workspace.js";

export const KNOWLEDGE_CORE_VERSION = "tcrn.knowledge-core.v1" as const;
export const KNOWLEDGE_STORE_SCHEMA_VERSION = "tcrn.knowledge-store.v1" as const;
export const KNOWLEDGE_METADATA_SCHEMA_VERSION = "tcrn.knowledge-unit-metadata.v1" as const;

export const KNOWLEDGE_LIMITS = Object.freeze({
  maximumBodyBytes: 8_192,
  maximumSummaryBytes: 2_048,
  maximumSnippetBytes: 512,
  maximumMetadataBytes: 32_768,
  maximumRecords: 16,
  maximumQueryResults: 8,
  maximumAggregateBytes: 131_072,
  maximumLocators: 16,
  maximumLinksPerClass: 64,
  maximumTags: 32,
  maximumRoleScopes: 16,
});

export const KNOWLEDGE_REASON_CODES = Object.freeze([
  "KNOWLEDGE_ALREADY_EXISTS",
  "KNOWLEDGE_BODY_ACCESS_DENIED",
  "KNOWLEDGE_CANONICAL_INVALID",
  "KNOWLEDGE_CAS_MISMATCH",
  "KNOWLEDGE_CHECKPOINT_READY",
  "KNOWLEDGE_DISPOSABLE_ACK_REQUIRED",
  "KNOWLEDGE_DUPLICATE",
  "KNOWLEDGE_FAULT_INJECTED",
  "KNOWLEDGE_FRESHNESS_EVALUATED",
  "KNOWLEDGE_HIGH_WATER_MISMATCH",
  "KNOWLEDGE_INPUT_INVALID",
  "KNOWLEDGE_LIMIT_EXCEEDED",
  "KNOWLEDGE_LINK_INVALID",
  "KNOWLEDGE_LINK_UNSAFE",
  "KNOWLEDGE_LIST_READY",
  "KNOWLEDGE_LOCKED",
  "KNOWLEDGE_NOT_FOUND",
  "KNOWLEDGE_PARTIAL_STATE",
  "KNOWLEDGE_PATH_INVALID",
  "KNOWLEDGE_PROMOTION_INVALID",
  "KNOWLEDGE_PROMOTION_UPDATED",
  "KNOWLEDGE_PROVENANCE_INVALID",
  "KNOWLEDGE_REBASE_BLOCKED",
  "KNOWLEDGE_RECORD_INVALID",
  "KNOWLEDGE_REDACTION_REQUIRED",
  "KNOWLEDGE_SELECTION_INVALID",
  "KNOWLEDGE_SOURCE_CHANGED",
  "KNOWLEDGE_SPECIAL_FILE",
  "KNOWLEDGE_STORE_INITIALIZED",
  "KNOWLEDGE_STORE_REBASED",
  "KNOWLEDGE_STORE_VALID",
  "KNOWLEDGE_UNIT_CREATED",
] as const);

export type KnowledgeReasonCode = typeof KNOWLEDGE_REASON_CODES[number];
export type KnowledgeScope = "workspace" | "project" | "role";
export type KnowledgeCategory = "architecture" | "domain" | "implementation" | "standards" | "testing" | "workflow" | "decision" | "evidence";
export type KnowledgeKind = "fact" | "guide" | "decision" | "reference" | "summary";
export type KnowledgeLifecycle = "candidate" | "active" | "retired";
export type KnowledgeRetrievalDisposition = "default" | "explicit-only" | "excluded";
export type KnowledgePromotionState = "candidate" | "promoted" | "rejected";
export type KnowledgeFreshnessState = "fresh" | "stale" | "unknown";
export type KnowledgeExportDisposition = "metadata-only" | "excluded";
export type KnowledgeFaultPoint = "after-body-write" | "after-metadata-write" | "after-marker-write";

export class KnowledgeCoreError extends Error {
  readonly reasonCode: KnowledgeReasonCode;

  constructor(reasonCode: KnowledgeReasonCode, message: string) {
    super(message);
    this.name = "KnowledgeCoreError";
    this.reasonCode = reasonCode;
  }
}

export interface KnowledgeStalenessPolicy {
  readonly maximumAgeDays: number;
  readonly unknownDisposition: "fail-closed";
}

export interface KnowledgeUnitMetadata {
  readonly schemaVersion: typeof KNOWLEDGE_METADATA_SCHEMA_VERSION;
  readonly id: string;
  readonly externalKey: string;
  readonly scope: KnowledgeScope;
  readonly projectId: string | null;
  readonly roleScopes: readonly string[];
  readonly category: KnowledgeCategory;
  readonly kind: KnowledgeKind;
  readonly tags: readonly string[];
  readonly subject: string;
  readonly summary: string;
  readonly snippet: string;
  readonly accountableOwnerId: string;
  readonly sourceReferences: readonly string[];
  readonly sourceDigest: string;
  readonly linkedWorkIds: readonly string[];
  readonly linkedDecisionIds: readonly string[];
  readonly linkedGateIds: readonly string[];
  readonly linkedEvidenceIds: readonly string[];
  readonly lifecycle: KnowledgeLifecycle;
  readonly retrievalDisposition: KnowledgeRetrievalDisposition;
  readonly promotionState: KnowledgePromotionState;
  readonly freshnessState: KnowledgeFreshnessState;
  readonly lastVerified: string | null;
  readonly stalenessPolicy: KnowledgeStalenessPolicy;
  readonly redactionDisposition: "focused-reference-redaction-v1";
  readonly exportDisposition: KnowledgeExportDisposition;
  readonly authority: "workspace-knowledge-metadata";
  readonly sourceProvenance: "explicit-current-source-reference";
  readonly bodySha256: string;
  readonly bodyBytes: number;
  readonly revision: number;
  readonly updatedAt: string;
  readonly extensions: Readonly<Record<string, never>>;
}

export interface CreateKnowledgeUnitInput {
  readonly expectedVersion: number;
  readonly occurredAt: string;
  readonly externalKey: string;
  readonly scope: KnowledgeScope;
  readonly projectId: string | null;
  readonly roleScopes: readonly string[];
  readonly category: KnowledgeCategory;
  readonly kind: KnowledgeKind;
  readonly tags: readonly string[];
  readonly subject: string;
  readonly summary: string;
  readonly snippet: string;
  readonly accountableOwnerId: string;
  readonly sourceReferences: readonly string[];
  readonly sourceDigest: string;
  readonly linkedWorkIds: readonly string[];
  readonly linkedDecisionIds: readonly string[];
  readonly linkedGateIds: readonly string[];
  readonly linkedEvidenceIds: readonly string[];
  readonly lifecycle: KnowledgeLifecycle;
  readonly retrievalDisposition: KnowledgeRetrievalDisposition;
  readonly freshnessState: KnowledgeFreshnessState;
  readonly lastVerified: string | null;
  readonly stalenessPolicy: KnowledgeStalenessPolicy;
  readonly exportDisposition: KnowledgeExportDisposition;
  readonly body: string;
}

export interface KnowledgeReadOptions {
  readonly beforeDescriptorReadForTest?: (path: string) => Promise<void>;
  readonly afterDescriptorOpenForTest?: (path: string) => Promise<void>;
}

export interface KnowledgeMutationOptions extends KnowledgeReadOptions {
  readonly faultAt?: KnowledgeFaultPoint;
}

export interface KnowledgeListQuery extends KnowledgeReadOptions {
  readonly selection?: "default" | "all";
  readonly at: string;
  readonly projectId?: string;
  readonly roleScope?: string;
  readonly category?: KnowledgeCategory;
  readonly kind?: KnowledgeKind;
  readonly tag?: string;
  readonly freshness?: KnowledgeFreshnessState;
  readonly promotionState?: KnowledgePromotionState;
}

export interface KnowledgeBodyReadOptions extends KnowledgeReadOptions {
  readonly at: string;
  readonly allowUnpromoted?: boolean;
  readonly allowStale?: boolean;
}

interface KnowledgeStoreMarker {
  readonly schemaVersion: typeof KNOWLEDGE_STORE_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly eventHighWaterDigest: string;
  readonly version: number;
  readonly disposable: true;
  readonly authority: "metadata-index-authority-body-separate";
}

interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface FileSnapshot extends FileIdentity {
  readonly size: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface BoundBytes {
  readonly bytes: Buffer;
  readonly identity: FileIdentity;
}

interface ExclusiveFile {
  readonly path: string;
  readonly identity: FileIdentity;
}

interface ScannedKnowledgeUnit {
  readonly metadataPath: string;
  readonly bodyPath: string;
  readonly metadata: KnowledgeUnitMetadata;
  readonly body: Buffer | null;
}

interface KnowledgeStoreScan {
  readonly workspaceRoot: string;
  readonly storeRoot: string;
  readonly metadataRoot: string;
  readonly bodiesRoot: string;
  readonly viewsRoot: string;
  readonly marker: KnowledgeStoreMarker;
  readonly workspace: WorkspaceState;
  readonly units: readonly ScannedKnowledgeUnit[];
  readonly index: Readonly<Record<string, JsonValue>>;
  // WSC-2: in rebase mode, the id-sorted set of live (non-retired) records whose
  // scope/project or linked-work references no longer resolve against the advanced
  // workspace head. Empty (and absent from non-rebase scans) otherwise.
  readonly linkInvalid: readonly string[];
}

const markerFields = ["schemaVersion", "workspaceId", "eventHighWaterDigest", "version", "disposable", "authority"];
const metadataFields = [
  "schemaVersion", "id", "externalKey", "scope", "projectId", "roleScopes", "category", "kind", "tags", "subject",
  "summary", "snippet", "accountableOwnerId", "sourceReferences", "sourceDigest", "linkedWorkIds", "linkedDecisionIds", "linkedGateIds",
  "linkedEvidenceIds", "lifecycle", "retrievalDisposition", "promotionState", "freshnessState", "lastVerified",
  "stalenessPolicy", "redactionDisposition", "exportDisposition", "authority", "sourceProvenance", "bodySha256",
  "bodyBytes", "revision", "updatedAt", "extensions",
];
const stalenessFields = ["maximumAgeDays", "unknownDisposition"];

function fail(reasonCode: KnowledgeReasonCode, message: string): never {
  throw new KnowledgeCoreError(reasonCode, message);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function snapshot(value: FileSnapshot): FileSnapshot {
  return { dev: value.dev, ino: value.ino, size: value.size, mode: value.mode, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs };
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function inside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactFields(value: unknown, expected: readonly string[], label: string, reasonCode: KnowledgeReasonCode): asserts value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(reasonCode, `${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareCanonicalText);
  const required = [...expected].sort(compareCanonicalText);
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    fail(reasonCode, `${label} fields are not exact`);
  }
}

function assertDigest(value: unknown, label: string, reasonCode: KnowledgeReasonCode): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(reasonCode, `${label} must be a lowercase SHA-256 digest`);
  }
}

function assertBoundedString(value: unknown, maximumBytes: number, label: string): asserts value is string {
  if (typeof value !== "string") {
    fail("KNOWLEDGE_INPUT_INVALID", `${label} must be a string`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail("KNOWLEDGE_LIMIT_EXCEEDED", label);
  }
  try {
    canonicalJson(value);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("KNOWLEDGE_CANONICAL_INVALID", error.message);
    }
    throw error;
  }
}

function assertSortedStrings(values: unknown, maximum: number, label: string, pattern?: RegExp): asserts values is readonly string[] {
  if (!Array.isArray(values) || values.length > maximum || new Set(values).size !== values.length ||
    values.some((value) => typeof value !== "string" || (pattern ? !pattern.test(value) : false))) {
    fail("KNOWLEDGE_INPUT_INVALID", label);
  }
  for (const value of values) {
    assertBoundedString(value, 512, label);
  }
  if (JSON.stringify(values) !== JSON.stringify([...values].sort(compareCanonicalText))) {
    fail("KNOWLEDGE_CANONICAL_INVALID", `${label} must be sorted`);
  }
}

function assertLinkIds(values: unknown, namespace: string | null, label: string): asserts values is readonly string[] {
  assertSortedStrings(values, KNOWLEDGE_LIMITS.maximumLinksPerClass, label);
  for (const value of values) {
    try {
      assertProtocolId(value);
    } catch (error) {
      fail("KNOWLEDGE_LINK_INVALID", `${label}:${String(error)}`);
    }
    if (namespace && !value.startsWith(`${namespace}:`)) {
      fail("KNOWLEDGE_LINK_INVALID", `${label}:${value}`);
    }
  }
}

async function boundDirectory(path: string, parent?: string): Promise<string> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    fail("KNOWLEDGE_PATH_INVALID", `${path}:${String((error as { code?: string }).code ?? error)}`);
  }
  if (before.isSymbolicLink()) {
    fail("KNOWLEDGE_LINK_UNSAFE", path);
  }
  if (!before.isDirectory()) {
    fail("KNOWLEDGE_SPECIAL_FILE", path);
  }
  const canonical = await realpath(path);
  if (parent && !inside(parent, canonical)) {
    fail("KNOWLEDGE_PATH_INVALID", path);
  }
  const after = await lstat(canonical);
  if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) {
    fail("KNOWLEDGE_SOURCE_CHANGED", path);
  }
  return canonical;
}

async function readBoundRegularFile(path: string, maximumBytes: number, options: KnowledgeReadOptions = {}): Promise<BoundBytes> {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    fail("KNOWLEDGE_PATH_INVALID", `${path}:${String((error as { code?: string }).code ?? error)}`);
  }
  if (before.isSymbolicLink()) {
    fail("KNOWLEDGE_LINK_UNSAFE", path);
  }
  if (!before.isFile()) {
    fail("KNOWLEDGE_SPECIAL_FILE", path);
  }
  if (before.nlink !== 1n) {
    fail("KNOWLEDGE_LINK_UNSAFE", path);
  }
  const maximum = BigInt(maximumBytes);
  if (before.size > maximum) {
    fail("KNOWLEDGE_LIMIT_EXCEEDED", `${path}:${before.size}`);
  }
  const beforeSnapshot = snapshot(before);
  await options.beforeDescriptorReadForTest?.(path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > maximum || !sameSnapshot(beforeSnapshot, opened)) {
      fail(opened.size > maximum ? "KNOWLEDGE_LIMIT_EXCEEDED" : "KNOWLEDGE_SOURCE_CHANGED", path);
    }
    const openedSnapshot = snapshot(opened);
    await options.afterDescriptorOpenForTest?.(path);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (BigInt(bytes.length) > maximum || after.size > maximum || named.size > maximum) {
      fail("KNOWLEDGE_LIMIT_EXCEEDED", path);
    }
    if (BigInt(bytes.length) !== openedSnapshot.size || !sameSnapshot(openedSnapshot, after) || !sameSnapshot(openedSnapshot, named) ||
      named.isSymbolicLink() || !named.isFile() || named.nlink !== 1n) {
      fail("KNOWLEDGE_SOURCE_CHANGED", path);
    }
    return { bytes, identity: { dev: opened.dev, ino: opened.ino } };
  } catch (error) {
    if (error instanceof KnowledgeCoreError) {
      throw error;
    }
    fail("KNOWLEDGE_SOURCE_CHANGED", `${path}:${String(error)}`);
  } finally {
    await handle?.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusiveFile(path: string, bytes: Buffer | string): Promise<ExclusiveFile> {
  const parent = await boundDirectory(dirname(path));
  const parentBefore = await lstat(parent);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      fail("KNOWLEDGE_LINK_UNSAFE", path);
    }
    await handle.close();
    handle = undefined;
    const named = await lstat(path);
    const parentAfter = await lstat(parent);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameIdentity(opened, named) || !sameIdentity(parentBefore, parentAfter)) {
      fail("KNOWLEDGE_SOURCE_CHANGED", path);
    }
    await syncDirectory(parent);
    return { path, identity: { dev: named.dev, ino: named.ino } };
  } catch (error) {
    await handle?.close();
    if ((error as { code?: string }).code === "EEXIST") {
      fail("KNOWLEDGE_ALREADY_EXISTS", path);
    }
    if (error instanceof KnowledgeCoreError) {
      throw error;
    }
    fail("KNOWLEDGE_PATH_INVALID", `${path}:${String(error)}`);
  }
}

async function replaceRegularFile(path: string, bytes: Buffer | string): Promise<void> {
  const current = await lstat(path);
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1) {
    fail(current.isSymbolicLink() || current.nlink !== 1 ? "KNOWLEDGE_LINK_UNSAFE" : "KNOWLEDGE_SPECIAL_FILE", path);
  }
  const temporaryPath = resolve(dirname(path), `.tmp-${randomBytes(12).toString("hex")}`);
  const temporary = await writeExclusiveFile(temporaryPath, bytes);
  try {
    const rebound = await lstat(path);
    if (!sameIdentity(current, rebound) || rebound.isSymbolicLink() || !rebound.isFile() || rebound.nlink !== 1) {
      fail("KNOWLEDGE_SOURCE_CHANGED", path);
    }
    await rename(temporaryPath, path);
    const named = await lstat(path);
    if (!sameIdentity(named, temporary.identity) || named.isSymbolicLink() || !named.isFile() || named.nlink !== 1) {
      fail("KNOWLEDGE_SOURCE_CHANGED", path);
    }
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function ensureNewDirectory(path: string, parent: string): Promise<string> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      fail("KNOWLEDGE_ALREADY_EXISTS", path);
    }
    fail("KNOWLEDGE_PATH_INVALID", `${path}:${String(error)}`);
  }
  return boundDirectory(path, parent);
}

function parseCanonicalObject(bytes: Buffer, label: string, reasonCode: KnowledgeReasonCode): Readonly<Record<string, JsonValue>> {
  try {
    const parsed = assertCanonicalJson(bytes.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(reasonCode, `${label} must be an object`);
    }
    return parsed as Readonly<Record<string, JsonValue>>;
  } catch (error) {
    if (error instanceof KnowledgeCoreError) {
      throw error;
    }
    if (error instanceof ProtocolError) {
      fail(reasonCode, error.message);
    }
    fail(reasonCode, String(error));
  }
}

function validateMarker(value: Readonly<Record<string, JsonValue>>): KnowledgeStoreMarker {
  exactFields(value, markerFields, "knowledge marker", "KNOWLEDGE_RECORD_INVALID");
  if (value.schemaVersion !== KNOWLEDGE_STORE_SCHEMA_VERSION || typeof value.workspaceId !== "string" ||
    !/^workspace:[a-f0-9]{24}$/u.test(value.workspaceId) || typeof value.eventHighWaterDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.eventHighWaterDigest) || !Number.isSafeInteger(value.version) || Number(value.version) < 0 ||
    value.disposable !== true || value.authority !== "metadata-index-authority-body-separate") {
    fail("KNOWLEDGE_RECORD_INVALID", "knowledge marker fields are invalid");
  }
  return value as unknown as KnowledgeStoreMarker;
}

function assertPromotableProvenance(metadata: KnowledgeUnitMetadata): void {
  try {
    assertProtocolId(metadata.accountableOwnerId);
  } catch (error) {
    fail("KNOWLEDGE_PROVENANCE_INVALID", `accountable owner:${String(error)}`);
  }
  if (!metadata.accountableOwnerId.startsWith("owner:") || metadata.sourceReferences.length === 0 || metadata.linkedEvidenceIds.length === 0) {
    fail("KNOWLEDGE_PROVENANCE_INVALID", `${metadata.id}:source, evidence, and accountable owner are required`);
  }
}

function validateMetadataShape(value: Readonly<Record<string, JsonValue>>, workspace: WorkspaceState, deferLinks = false): KnowledgeUnitMetadata {
  exactFields(value, metadataFields, "knowledge metadata", "KNOWLEDGE_RECORD_INVALID");
  exactFields(value.stalenessPolicy, stalenessFields, "knowledge staleness policy", "KNOWLEDGE_RECORD_INVALID");
  if (value.schemaVersion !== KNOWLEDGE_METADATA_SCHEMA_VERSION || typeof value.id !== "string" ||
    typeof value.externalKey !== "string" || !["workspace", "project", "role"].includes(String(value.scope)) ||
    (value.projectId !== null && typeof value.projectId !== "string") || typeof value.category !== "string" ||
    !["architecture", "domain", "implementation", "standards", "testing", "workflow", "decision", "evidence"].includes(value.category) ||
    typeof value.kind !== "string" || !["fact", "guide", "decision", "reference", "summary"].includes(value.kind) ||
    typeof value.subject !== "string" || typeof value.summary !== "string" || typeof value.snippet !== "string" ||
    typeof value.accountableOwnerId !== "string" ||
    typeof value.sourceDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.sourceDigest) ||
    typeof value.lifecycle !== "string" || !["candidate", "active", "retired"].includes(value.lifecycle) ||
    typeof value.retrievalDisposition !== "string" || !["default", "explicit-only", "excluded"].includes(value.retrievalDisposition) ||
    typeof value.promotionState !== "string" || !["candidate", "promoted", "rejected"].includes(value.promotionState) ||
    typeof value.freshnessState !== "string" || !["fresh", "stale", "unknown"].includes(value.freshnessState) ||
    (value.lastVerified !== null && typeof value.lastVerified !== "string") ||
    value.redactionDisposition !== "focused-reference-redaction-v1" ||
    typeof value.exportDisposition !== "string" || !["metadata-only", "excluded"].includes(value.exportDisposition) ||
    value.authority !== "workspace-knowledge-metadata" || value.sourceProvenance !== "explicit-current-source-reference" ||
    typeof value.bodySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.bodySha256) ||
    !Number.isSafeInteger(value.bodyBytes) || Number(value.bodyBytes) < 0 ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.updatedAt !== "string" ||
    value.extensions === null || typeof value.extensions !== "object" || Array.isArray(value.extensions) || Object.keys(value.extensions).length !== 0) {
    fail("KNOWLEDGE_RECORD_INVALID", String(value.id ?? "unknown"));
  }
  if (!Number.isSafeInteger(value.stalenessPolicy.maximumAgeDays) || Number(value.stalenessPolicy.maximumAgeDays) < 1 ||
    Number(value.stalenessPolicy.maximumAgeDays) > 3_650 || value.stalenessPolicy.unknownDisposition !== "fail-closed") {
    fail("KNOWLEDGE_RECORD_INVALID", "staleness policy is invalid");
  }
  const metadata = value as unknown as KnowledgeUnitMetadata;
  try {
    assertProtocolId(metadata.id);
    canonicalExternalKey(metadata.externalKey);
    assertStrictInstant(metadata.updatedAt);
    if (metadata.lastVerified !== null) assertStrictInstant(metadata.lastVerified);
  } catch (error) {
    fail(error instanceof ProtocolError && error.reasonCode === "CANONICAL_VALUE_INVALID" ? "KNOWLEDGE_CANONICAL_INVALID" : "KNOWLEDGE_RECORD_INVALID", String(error));
  }
  if (deriveStableId("knowledge", metadata.externalKey) !== metadata.id) {
    fail("KNOWLEDGE_RECORD_INVALID", `${metadata.id}:identity binding`);
  }
  assertBoundedString(metadata.subject, 512, "subject");
  assertBoundedString(metadata.summary, KNOWLEDGE_LIMITS.maximumSummaryBytes, "summary");
  assertBoundedString(metadata.snippet, KNOWLEDGE_LIMITS.maximumSnippetBytes, "snippet");
  assertSortedStrings(metadata.roleScopes, KNOWLEDGE_LIMITS.maximumRoleScopes, "role scopes", /^[a-z][a-z0-9-]{0,63}$/u);
  assertSortedStrings(metadata.tags, KNOWLEDGE_LIMITS.maximumTags, "tags", /^[a-z0-9][a-z0-9-]{0,63}$/u);
  assertSortedStrings(metadata.sourceReferences, KNOWLEDGE_LIMITS.maximumLocators, "source references");
  assertLinkIds(metadata.linkedWorkIds, "work", "linked work IDs");
  assertLinkIds(metadata.linkedDecisionIds, "decision", "linked decision IDs");
  assertLinkIds(metadata.linkedGateIds, "gate", "linked gate IDs");
  assertLinkIds(metadata.linkedEvidenceIds, "evidence", "linked evidence IDs");
  // WSC-3 / SDC-6: provenance (owner:-prefixed accountable owner, non-empty source
  // and evidence links) is enforced at promotion, not capture — a candidate is
  // cheap to write and only a promoted record must carry full provenance. The
  // promote path re-validates via assertPromotableProvenance.
  if (metadata.promotionState === "promoted") {
    assertPromotableProvenance(metadata);
  }
  for (const reference of metadata.sourceReferences) {
    try {
      if (redactArtifactReference(reference) !== reference) {
        fail("KNOWLEDGE_REDACTION_REQUIRED", metadata.id);
      }
    } catch (error) {
      if (error instanceof KnowledgeCoreError) throw error;
      fail("KNOWLEDGE_REDACTION_REQUIRED", `${metadata.id}:${String(error)}`);
    }
  }
  // WSC-2: link liveness is validated separately so a rebase can tolerate it, and
  // retired records skip it durably — they are tombstoned audit records whose
  // backlinks into now-removed work are intentionally preserved.
  if (!deferLinks && metadata.lifecycle !== "retired") {
    validateMetadataLinks(metadata, workspace);
  }
  if ((metadata.freshnessState === "unknown") !== (metadata.lastVerified === null)) {
    fail("KNOWLEDGE_RECORD_INVALID", `${metadata.id}:freshness`);
  }
  return metadata;
}

// WSC-2: scope/project liveness (KNOWLEDGE_LINK_INVALID:scope) and linked-work
// liveness (KNOWLEDGE_LINK_INVALID:<workId>) — the two checks a rebase tolerates
// (collecting offenders) and a retired record is durably exempt from.
function validateMetadataLinks(metadata: KnowledgeUnitMetadata, workspace: WorkspaceState): void {
  const project = metadata.projectId === null ? undefined : workspace.projects.find((entry) => entry.id === metadata.projectId && !entry.tombstone);
  if ((metadata.scope === "workspace" && (metadata.projectId !== null || metadata.roleScopes.length !== 0)) ||
    (metadata.scope === "project" && (!project || metadata.roleScopes.length !== 0)) ||
    (metadata.scope === "role" && metadata.roleScopes.length === 0) ||
    (metadata.projectId !== null && !project)) {
    fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:scope`);
  }
  for (const workId of metadata.linkedWorkIds) {
    const work = workspace.work.find((entry) => entry.id === workId && !entry.tombstone);
    if (!work || metadata.projectId === null || work.projectId !== metadata.projectId) {
      fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:${workId}`);
    }
  }
}

function validateMetadataBody(metadata: KnowledgeUnitMetadata, body: Buffer, workspace: WorkspaceState): void {
  if (metadata.bodyBytes !== body.length || sha256(body) !== metadata.bodySha256) {
    fail("KNOWLEDGE_RECORD_INVALID", `${metadata.id}:body binding`);
  }
  const protocolRecord: KnowledgeRecord = {
    schemaVersion: "tcrn.knowledge.v1",
    id: metadata.id,
    projectId: metadata.projectId ?? workspace.metadata.workspaceId,
    subject: metadata.subject,
    body: body.toString("utf8"),
    revision: metadata.revision,
    updatedAt: metadata.updatedAt,
    tombstone: metadata.lifecycle === "retired",
    extensions: {},
  };
  if (!Buffer.from(protocolRecord.body, "utf8").equals(body)) {
    fail("KNOWLEDGE_CANONICAL_INVALID", `${metadata.id}:body is not canonical UTF-8`);
  }
  try {
    validateKnowledgeRecord(protocolRecord);
  } catch (error) {
    fail(error instanceof ProtocolError && error.reasonCode === "CANONICAL_VALUE_INVALID" ? "KNOWLEDGE_CANONICAL_INVALID" : "KNOWLEDGE_RECORD_INVALID", String(error));
  }
}

function requireBody(unit: ScannedKnowledgeUnit): Buffer {
  if (unit.body === null) fail("KNOWLEDGE_RECORD_INVALID", `${unit.metadata.id}:body was not admitted`);
  return unit.body;
}

function knowledgeIndex(marker: KnowledgeStoreMarker, metadata: readonly KnowledgeUnitMetadata[]): Readonly<Record<string, JsonValue>> {
  const records = [...metadata].sort((left, right) => compareCanonicalText(left.id, right.id));
  return {
    schemaVersion: "tcrn.knowledge-index.v1",
    authority: "derived-rebuildable",
    workspaceId: marker.workspaceId,
    eventHighWaterDigest: marker.eventHighWaterDigest,
    version: marker.version,
    records: records as unknown as readonly JsonValue[],
    indexDigest: canonicalSha256(records),
  };
}

async function claimPresence(storeRoot: string): Promise<"absent" | "present"> {
  try {
    const metadata = await lstat(resolve(storeRoot, "mutation.claim"));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
      fail("KNOWLEDGE_PARTIAL_STATE", "mutation claim is unsafe");
    }
    return "present";
  } catch (error) {
    if (error instanceof KnowledgeCoreError) throw error;
    if ((error as { code?: string }).code === "ENOENT") return "absent";
    fail("KNOWLEDGE_PARTIAL_STATE", String(error));
  }
}

async function scanKnowledgeStore(
  workspaceRootInput: string,
  options: KnowledgeReadOptions = {},
  allowClaim = false,
  bodyMode: "full" | "metadata-only" = "full",
  rebase = false,
): Promise<KnowledgeStoreScan> {
  const workspace = await materializeWorkspace(workspaceRootInput);
  const workspaceRoot = await boundDirectory(workspaceRootInput);
  const storedWorkspaceRoot = workspace.metadata.roots.find((root) => root.kind === "workspace")?.canonicalPath;
  if (storedWorkspaceRoot !== workspaceRoot) {
    fail("KNOWLEDGE_PATH_INVALID", "knowledge store is not under the Workspace authority root");
  }
  const storeRoot = await boundDirectory(resolve(workspaceRoot, ".tcrn-workflow/knowledge"), workspaceRoot);
  const metadataRoot = await boundDirectory(resolve(storeRoot, "metadata"), storeRoot);
  const bodiesRoot = await boundDirectory(resolve(storeRoot, "bodies"), storeRoot);
  const viewsRoot = await boundDirectory(resolve(storeRoot, "views"), storeRoot);
  const rootEntries = (await readdir(storeRoot)).sort(compareCanonicalText);
  const expectedRootEntries = ["bodies", "metadata", "store.json", "views", ...(allowClaim ? ["mutation.claim"] : [])].sort(compareCanonicalText);
  if (JSON.stringify(rootEntries) !== JSON.stringify(expectedRootEntries)) {
    fail("KNOWLEDGE_PARTIAL_STATE", "knowledge store root entries are not exact");
  }
  if (!allowClaim && await claimPresence(storeRoot) === "present") {
    fail("KNOWLEDGE_PARTIAL_STATE", "mutation claim is present");
  }
  const markerBytes = (await readBoundRegularFile(resolve(storeRoot, "store.json"), 16_384, options)).bytes;
  const marker = validateMarker(parseCanonicalObject(
    markerBytes,
    "knowledge marker",
    "KNOWLEDGE_RECORD_INVALID",
  ));
  // WSC-2: a rebase deliberately runs against an advanced head, so it skips only
  // the high-water equality; workspace identity binding stays mandatory.
  if (marker.workspaceId !== workspace.metadata.workspaceId || (!rebase && marker.eventHighWaterDigest !== workspace.headEventHash)) {
    fail("KNOWLEDGE_HIGH_WATER_MISMATCH", marker.workspaceId);
  }
  const metadataNames = (await readdir(metadataRoot)).sort(compareCanonicalText);
  const bodyNames = (await readdir(bodiesRoot)).sort(compareCanonicalText);
  if (metadataNames.length > KNOWLEDGE_LIMITS.maximumRecords || bodyNames.length > KNOWLEDGE_LIMITS.maximumRecords) {
    fail("KNOWLEDGE_LIMIT_EXCEEDED", "knowledge record count");
  }
  const metadataIds = metadataNames.map((name) => name.endsWith(".json") ? name.slice(0, -5) : "");
  const bodyIds = bodyNames.map((name) => name.endsWith(".body") ? name.slice(0, -5) : "");
  if (metadataIds.some((id) => !/^knowledge:[a-f0-9]{24}$/u.test(id)) || bodyIds.some((id) => !/^knowledge:[a-f0-9]{24}$/u.test(id)) ||
    JSON.stringify(metadataIds) !== JSON.stringify(bodyIds)) {
    fail("KNOWLEDGE_PARTIAL_STATE", "knowledge metadata/body sets differ");
  }
  const units: ScannedKnowledgeUnit[] = [];
  const linkInvalid: string[] = [];
  let aggregateBytes = markerBytes.length;
  for (const id of metadataIds) {
    const metadataPath = resolve(metadataRoot, `${id}.json`);
    const bodyPath = resolve(bodiesRoot, `${id}.body`);
    const metadataBytes = (await readBoundRegularFile(metadataPath, KNOWLEDGE_LIMITS.maximumMetadataBytes, options)).bytes;
    // WSC-2: in rebase mode, shape is still fully validated but link liveness is
    // deferred so a live record pointing at now-tombstoned work is recorded as an
    // offender rather than failing the whole scan; retired records stay exempt.
    const metadata = validateMetadataShape(
      parseCanonicalObject(metadataBytes, "knowledge metadata", "KNOWLEDGE_RECORD_INVALID"),
      workspace,
      rebase,
    );
    if (rebase && metadata.lifecycle !== "retired") {
      try {
        validateMetadataLinks(metadata, workspace);
      } catch (error) {
        if (error instanceof KnowledgeCoreError && error.reasonCode === "KNOWLEDGE_LINK_INVALID") {
          linkInvalid.push(metadata.id);
        } else {
          throw error;
        }
      }
    }
    const body = bodyMode === "full"
      ? (await readBoundRegularFile(bodyPath, KNOWLEDGE_LIMITS.maximumBodyBytes, options)).bytes
      : null;
    if (body !== null) validateMetadataBody(metadata, body, workspace);
    aggregateBytes += metadataBytes.length + (body?.length ?? 0);
    if (aggregateBytes > KNOWLEDGE_LIMITS.maximumAggregateBytes) {
      fail("KNOWLEDGE_LIMIT_EXCEEDED", "knowledge aggregate bytes");
    }
    if (metadata.id !== id) {
      fail("KNOWLEDGE_PATH_INVALID", id);
    }
    units.push({ metadataPath, bodyPath, metadata, body });
  }
  units.sort((left, right) => compareCanonicalText(left.metadata.id, right.metadata.id));
  const index = knowledgeIndex(marker, units.map((unit) => unit.metadata));
  const viewPath = resolve(viewsRoot, "index.json");
  const viewEntries = await readdir(viewsRoot);
  if (JSON.stringify(viewEntries.sort(compareCanonicalText)) !== JSON.stringify(["index.json"])) {
    fail("KNOWLEDGE_PARTIAL_STATE", "knowledge views are not exact");
  }
  const viewBytes = (await readBoundRegularFile(viewPath, KNOWLEDGE_LIMITS.maximumAggregateBytes, options)).bytes;
  aggregateBytes += viewBytes.length;
  if (aggregateBytes > KNOWLEDGE_LIMITS.maximumAggregateBytes) {
    fail("KNOWLEDGE_LIMIT_EXCEEDED", "knowledge aggregate bytes");
  }
  const view = viewBytes.toString("utf8");
  if (view !== canonicalJson(index)) {
    fail("KNOWLEDGE_PARTIAL_STATE", "knowledge index is stale");
  }
  return { workspaceRoot, storeRoot, metadataRoot, bodiesRoot, viewsRoot, marker, workspace, units, index, linkInvalid: linkInvalid.sort(compareCanonicalText) };
}

async function mutationAdmissionScan(workspaceRoot: string, options: KnowledgeReadOptions, rebase = false): Promise<KnowledgeStoreScan> {
  try {
    return await scanKnowledgeStore(workspaceRoot, options, false, "full", rebase);
  } catch (error) {
    if (error instanceof KnowledgeCoreError && error.reasonCode === "KNOWLEDGE_PARTIAL_STATE") {
      const root = resolve(workspaceRoot, ".tcrn-workflow/knowledge");
      if (await claimPresence(root) === "present") fail("KNOWLEDGE_LOCKED", "knowledge mutation claim exists");
    }
    throw error;
  }
}

async function acquireMutationClaim(scan: KnowledgeStoreScan): Promise<ExclusiveFile & { readonly token: string }> {
  const token = randomBytes(24).toString("hex");
  try {
    const claim = await writeExclusiveFile(resolve(scan.storeRoot, "mutation.claim"), canonicalJson({
      schemaVersion: "tcrn.knowledge-mutation-claim.v1",
      workspaceId: scan.marker.workspaceId,
      version: scan.marker.version,
      token,
    }));
    return { ...claim, token };
  } catch (error) {
    if (error instanceof KnowledgeCoreError && error.reasonCode === "KNOWLEDGE_ALREADY_EXISTS") {
      fail("KNOWLEDGE_LOCKED", "knowledge mutation claim exists");
    }
    throw error;
  }
}

async function releaseMutationClaim(storeRoot: string, claim: ExclusiveFile & { readonly token: string }): Promise<void> {
  const current = await lstat(claim.path);
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || !sameIdentity(current, claim.identity)) {
    fail("KNOWLEDGE_SOURCE_CHANGED", "knowledge claim identity changed");
  }
  const released = resolve(storeRoot, `released-${claim.token}`);
  await rename(claim.path, released);
  const moved = await lstat(released);
  if (!sameIdentity(moved, claim.identity) || moved.isSymbolicLink() || !moved.isFile() || moved.nlink !== 1) {
    fail("KNOWLEDGE_SOURCE_CHANGED", "released knowledge claim identity changed");
  }
  await rm(released);
  await syncDirectory(storeRoot);
}

function crash(point: KnowledgeFaultPoint, selected?: KnowledgeFaultPoint): void {
  if (point === selected) {
    fail("KNOWLEDGE_FAULT_INJECTED", point);
  }
}

function computeFreshness(metadata: KnowledgeUnitMetadata, at: string): KnowledgeFreshnessState {
  let now: bigint;
  try {
    now = parseStrictInstant(at);
  } catch (error) {
    fail("KNOWLEDGE_INPUT_INVALID", String(error));
  }
  if (metadata.lastVerified === null || metadata.freshnessState === "unknown") return "unknown";
  let verified: bigint;
  try {
    verified = parseStrictInstant(metadata.lastVerified);
  } catch (error) {
    fail("KNOWLEDGE_RECORD_INVALID", String(error));
  }
  if (now < verified) {
    fail("KNOWLEDGE_INPUT_INVALID", "freshness evaluation precedes last verification");
  }
  const maximumAge = BigInt(metadata.stalenessPolicy.maximumAgeDays) * 86_400_000_000_000n;
  return metadata.freshnessState === "stale" || now - verified > maximumAge ? "stale" : "fresh";
}

function assertEvaluationInstant(at: string): void {
  try {
    assertStrictInstant(at);
  } catch (error) {
    fail("KNOWLEDGE_INPUT_INVALID", String(error));
  }
}

function assertSelection(selection: unknown): asserts selection is "default" | "all" {
  if (selection !== "default" && selection !== "all") {
    fail("KNOWLEDGE_SELECTION_INVALID", String(selection));
  }
}

function isDefaultSelectable(metadata: KnowledgeUnitMetadata, at: string): boolean {
  return metadata.promotionState === "promoted" && metadata.lifecycle === "active" &&
    metadata.retrievalDisposition === "default" && metadata.exportDisposition === "metadata-only" &&
    computeFreshness(metadata, at) === "fresh";
}

function buildMetadata(input: CreateKnowledgeUnitInput, body: Buffer, workspace: WorkspaceState): KnowledgeUnitMetadata {
  let externalKey: string;
  try {
    externalKey = canonicalExternalKey(input.externalKey);
    assertStrictInstant(input.occurredAt);
    if (input.lastVerified !== null) assertStrictInstant(input.lastVerified);
  } catch (error) {
    fail(error instanceof ProtocolError && error.reasonCode === "CANONICAL_VALUE_INVALID" ? "KNOWLEDGE_CANONICAL_INVALID" : "KNOWLEDGE_INPUT_INVALID", String(error));
  }
  const metadata: KnowledgeUnitMetadata = {
    schemaVersion: KNOWLEDGE_METADATA_SCHEMA_VERSION,
    id: deriveStableId("knowledge", externalKey),
    externalKey,
    scope: input.scope,
    projectId: input.projectId,
    // WSC-3: arrays are canonically sorted server-side so an agent never has to
    // pre-sort them (the stored record stays canonical; validateMetadataShape
    // still asserts the sorted invariant on read).
    roleScopes: [...input.roleScopes].sort(compareCanonicalText),
    category: input.category,
    kind: input.kind,
    tags: [...input.tags].sort(compareCanonicalText),
    subject: input.subject,
    summary: input.summary,
    snippet: input.snippet,
    accountableOwnerId: input.accountableOwnerId,
    sourceReferences: [...input.sourceReferences].sort(compareCanonicalText),
    sourceDigest: input.sourceDigest,
    linkedWorkIds: [...input.linkedWorkIds].sort(compareCanonicalText),
    linkedDecisionIds: [...input.linkedDecisionIds].sort(compareCanonicalText),
    linkedGateIds: [...input.linkedGateIds].sort(compareCanonicalText),
    linkedEvidenceIds: [...input.linkedEvidenceIds].sort(compareCanonicalText),
    lifecycle: input.lifecycle,
    retrievalDisposition: input.retrievalDisposition,
    promotionState: "candidate",
    freshnessState: input.freshnessState,
    lastVerified: input.lastVerified,
    stalenessPolicy: input.stalenessPolicy,
    redactionDisposition: "focused-reference-redaction-v1",
    exportDisposition: input.exportDisposition,
    authority: "workspace-knowledge-metadata",
    sourceProvenance: "explicit-current-source-reference",
    bodySha256: sha256(body),
    bodyBytes: body.length,
    revision: 1,
    updatedAt: input.occurredAt,
    extensions: {},
  };
  const validated = validateMetadataShape(metadata as unknown as Readonly<Record<string, JsonValue>>, workspace);
  validateMetadataBody(validated, body, workspace);
  return metadata;
}

async function writeIndex(scan: KnowledgeStoreScan, marker: KnowledgeStoreMarker, metadata: readonly KnowledgeUnitMetadata[]): Promise<void> {
  await replaceRegularFile(resolve(scan.viewsRoot, "index.json"), canonicalJson(knowledgeIndex(marker, metadata)));
}

export async function initializeKnowledgeStore(workspaceRootInput: string, options: { readonly disposableAcknowledged?: boolean } = {}): Promise<Readonly<Record<string, JsonValue>>> {
  const workspace = await materializeWorkspace(workspaceRootInput);
  // WSC-1: fixture workspaces are admitted implicitly; every other workspace only
  // under an explicit per-invocation disposability acknowledgment. The store stays
  // a disposable derived index that is never the system of record.
  const fixtureAdmission = workspace.metadata.externalKey.startsWith("FIXTURE-");
  if (!fixtureAdmission && options.disposableAcknowledged !== true) {
    fail("KNOWLEDGE_DISPOSABLE_ACK_REQUIRED", workspace.metadata.externalKey);
  }
  if (!workspace.headEventHash) {
    fail("KNOWLEDGE_HIGH_WATER_MISMATCH", "knowledge store requires a non-empty Workspace authority");
  }
  const workspaceRoot = await boundDirectory(workspaceRootInput);
  const storeRoot = await ensureNewDirectory(resolve(workspaceRoot, ".tcrn-workflow/knowledge"), workspaceRoot);
  const metadataRoot = await ensureNewDirectory(resolve(storeRoot, "metadata"), storeRoot);
  const bodiesRoot = await ensureNewDirectory(resolve(storeRoot, "bodies"), storeRoot);
  const viewsRoot = await ensureNewDirectory(resolve(storeRoot, "views"), storeRoot);
  void metadataRoot;
  void bodiesRoot;
  const marker: KnowledgeStoreMarker = {
    schemaVersion: KNOWLEDGE_STORE_SCHEMA_VERSION,
    workspaceId: workspace.metadata.workspaceId,
    eventHighWaterDigest: workspace.headEventHash,
    version: 0,
    disposable: true,
    authority: "metadata-index-authority-body-separate",
  };
  await writeExclusiveFile(resolve(storeRoot, "store.json"), canonicalJson(marker));
  await writeExclusiveFile(resolve(viewsRoot, "index.json"), canonicalJson(knowledgeIndex(marker, [])));
  await syncDirectory(storeRoot);
  await scanKnowledgeStore(workspaceRoot);
  return {
    schemaVersion: "tcrn.knowledge-store-init-result.v1",
    reasonCode: "KNOWLEDGE_STORE_INITIALIZED",
    workspaceId: marker.workspaceId,
    version: marker.version,
    records: 0,
    bodyStorage: "separate-explicit-read-only",
    admission: fixtureAdmission ? "fixture" : "acknowledged-disposable",
  };
}

export async function validateKnowledgeStore(workspaceRoot: string, options: KnowledgeReadOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  const scan = await scanKnowledgeStore(workspaceRoot, options);
  return {
    schemaVersion: "tcrn.knowledge-store-validation.v1",
    reasonCode: "KNOWLEDGE_STORE_VALID",
    workspaceId: scan.marker.workspaceId,
    version: scan.marker.version,
    records: scan.units.length,
    indexDigest: scan.index.indexDigest ?? "",
    eventHighWaterDigest: scan.marker.eventHighWaterDigest,
  };
}

export async function createKnowledgeUnit(workspaceRoot: string, input: CreateKnowledgeUnitInput, options: KnowledgeMutationOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    fail("KNOWLEDGE_INPUT_INVALID", "expected version");
  }
  assertBoundedString(input.body, KNOWLEDGE_LIMITS.maximumBodyBytes, "body");
  const body = Buffer.from(input.body, "utf8");
  const workspace = await materializeWorkspace(workspaceRoot);
  const metadata = buildMetadata(input, body, workspace);
  const initial = await mutationAdmissionScan(workspaceRoot, options);
  const claim = await acquireMutationClaim(initial);
  const scan = await scanKnowledgeStore(workspaceRoot, options, true);
  if (scan.marker.version !== input.expectedVersion) {
    await releaseMutationClaim(scan.storeRoot, claim);
    fail("KNOWLEDGE_CAS_MISMATCH", `${input.expectedVersion}:${scan.marker.version}`);
  }
  const metadataBytes = Buffer.from(canonicalJson(metadata), "utf8");
  const marker: KnowledgeStoreMarker = { ...scan.marker, version: scan.marker.version + 1 };
  const projectedMetadata = [...scan.units.map((unit) => unit.metadata), metadata];
  const projectedAggregate = Buffer.byteLength(canonicalJson(marker), "utf8") +
    Buffer.byteLength(canonicalJson(knowledgeIndex(marker, projectedMetadata)), "utf8") +
    scan.units.reduce((total, unit) => total + Buffer.byteLength(canonicalJson(unit.metadata), "utf8") + requireBody(unit).length, 0) +
    metadataBytes.length + body.length;
  if (metadataBytes.length > KNOWLEDGE_LIMITS.maximumMetadataBytes || scan.units.length >= KNOWLEDGE_LIMITS.maximumRecords ||
    projectedAggregate > KNOWLEDGE_LIMITS.maximumAggregateBytes) {
    await releaseMutationClaim(scan.storeRoot, claim);
    fail("KNOWLEDGE_LIMIT_EXCEEDED", "knowledge create budget");
  }
  if (scan.units.some((unit) => unit.metadata.id === metadata.id || unit.metadata.externalKey === metadata.externalKey)) {
    await releaseMutationClaim(scan.storeRoot, claim);
    fail("KNOWLEDGE_DUPLICATE", metadata.id);
  }
  await writeExclusiveFile(resolve(scan.bodiesRoot, `${metadata.id}.body`), body);
  crash("after-body-write", options.faultAt);
  await writeExclusiveFile(resolve(scan.metadataRoot, `${metadata.id}.json`), metadataBytes);
  crash("after-metadata-write", options.faultAt);
  await replaceRegularFile(resolve(scan.storeRoot, "store.json"), canonicalJson(marker));
  crash("after-marker-write", options.faultAt);
  await writeIndex(scan, marker, projectedMetadata);
  await releaseMutationClaim(scan.storeRoot, claim);
  const final = await scanKnowledgeStore(workspaceRoot, options);
  return {
    schemaVersion: "tcrn.knowledge-create-result.v1",
    reasonCode: "KNOWLEDGE_UNIT_CREATED",
    id: metadata.id,
    externalKey: metadata.externalKey,
    revision: metadata.revision,
    version: final.marker.version,
    promotionState: metadata.promotionState,
  };
}

// WSC-2: re-bind the store to the advanced workspace head after full per-record
// re-validation. Live records whose links no longer resolve block the rebase
// unless retireInvalid retires them as tombstoned audit records (their dangling
// backlinks are then durably tolerated). Single version step under a mutation claim.
export async function rebaseKnowledgeStore(workspaceRoot: string, input: {
  readonly expectedVersion: number;
  readonly at: string;
  readonly retireInvalid?: boolean;
}, options: KnowledgeMutationOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    fail("KNOWLEDGE_INPUT_INVALID", "expected version");
  }
  assertStrictInstant(input.at);
  const workspace = await materializeWorkspace(workspaceRoot);
  const initial = await mutationAdmissionScan(workspaceRoot, options, true);
  const claim = await acquireMutationClaim(initial);
  const scan = await scanKnowledgeStore(workspaceRoot, options, true, "full", true);
  if (scan.marker.version !== input.expectedVersion) {
    await releaseMutationClaim(scan.storeRoot, claim);
    fail("KNOWLEDGE_CAS_MISMATCH", `${input.expectedVersion}:${scan.marker.version}`);
  }
  const offenders = scan.linkInvalid;
  if (offenders.length > 0 && input.retireInvalid !== true) {
    await releaseMutationClaim(scan.storeRoot, claim);
    fail("KNOWLEDGE_REBASE_BLOCKED", offenders.join(","));
  }
  const offenderSet = new Set(offenders);
  const marker: KnowledgeStoreMarker = { ...scan.marker, eventHighWaterDigest: workspace.headEventHash ?? scan.marker.eventHighWaterDigest, version: scan.marker.version + 1 };
  const retire = (metadata: KnowledgeUnitMetadata): KnowledgeUnitMetadata =>
    validateMetadataShape({ ...metadata, lifecycle: "retired", revision: metadata.revision + 1, updatedAt: input.at } as unknown as Readonly<Record<string, JsonValue>>, workspace);
  const projectedMetadata = scan.units.map((unit) => offenderSet.has(unit.metadata.id) ? retire(unit.metadata) : unit.metadata);
  for (const unit of scan.units) {
    if (offenderSet.has(unit.metadata.id)) {
      await replaceRegularFile(unit.metadataPath, canonicalJson(retire(unit.metadata)));
    }
  }
  crash("after-metadata-write", options.faultAt);
  await replaceRegularFile(resolve(scan.storeRoot, "store.json"), canonicalJson(marker));
  crash("after-marker-write", options.faultAt);
  await writeIndex(scan, marker, projectedMetadata);
  await releaseMutationClaim(scan.storeRoot, claim);
  const final = await scanKnowledgeStore(workspaceRoot, options);
  return {
    schemaVersion: "tcrn.knowledge-rebase-result.v1",
    reasonCode: "KNOWLEDGE_STORE_REBASED",
    version: final.marker.version,
    eventHighWaterDigest: final.marker.eventHighWaterDigest,
    retired: offenders.length,
    offenders,
  };
}

export async function listKnowledgeMetadata(workspaceRoot: string, query: KnowledgeListQuery): Promise<Readonly<Record<string, JsonValue>>> {
  assertEvaluationInstant(query.at);
  const selection = query.selection ?? "default";
  assertSelection(selection);
  const scan = await scanKnowledgeStore(workspaceRoot, query, false, "metadata-only");
  let records = scan.units.map((unit) => unit.metadata).filter((metadata) => {
    const freshness = computeFreshness(metadata, query.at);
    if (selection === "default" && !isDefaultSelectable(metadata, query.at)) return false;
    return (!query.projectId || metadata.projectId === query.projectId) &&
      (!query.roleScope || metadata.roleScopes.includes(query.roleScope)) &&
      (!query.category || metadata.category === query.category) && (!query.kind || metadata.kind === query.kind) &&
      (!query.tag || metadata.tags.includes(query.tag)) && (!query.freshness || freshness === query.freshness) &&
      (!query.promotionState || metadata.promotionState === query.promotionState);
  });
  records = records.sort((left, right) => compareCanonicalText(left.id, right.id));
  if (records.length > KNOWLEDGE_LIMITS.maximumQueryResults) {
    fail("KNOWLEDGE_LIMIT_EXCEEDED", "knowledge query results");
  }
  return {
    schemaVersion: "tcrn.knowledge-list.v1",
    reasonCode: "KNOWLEDGE_LIST_READY",
    selection,
    at: query.at,
    records: records as unknown as readonly JsonValue[],
    resultDigest: canonicalSha256(records),
  };
}

export async function readKnowledgeSnippet(workspaceRoot: string, id: string, options: KnowledgeReadOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  try {
    assertProtocolId(id);
    if (!id.startsWith("knowledge:")) fail("KNOWLEDGE_PATH_INVALID", id);
  } catch (error) {
    if (error instanceof KnowledgeCoreError) throw error;
    fail("KNOWLEDGE_PATH_INVALID", String(error));
  }
  const scan = await scanKnowledgeStore(workspaceRoot, options, false, "metadata-only");
  const unit = scan.units.find((entry) => entry.metadata.id === id);
  if (!unit) fail("KNOWLEDGE_NOT_FOUND", id);
  return {
    schemaVersion: "tcrn.knowledge-snippet.v1",
    id,
    subject: unit.metadata.subject,
    summary: unit.metadata.summary,
    snippet: unit.metadata.snippet,
    revision: unit.metadata.revision,
  };
}

export async function readKnowledgeBody(workspaceRoot: string, id: string, options: KnowledgeBodyReadOptions): Promise<Readonly<Record<string, JsonValue>>> {
  try {
    assertProtocolId(id);
    if (!id.startsWith("knowledge:")) fail("KNOWLEDGE_PATH_INVALID", id);
  } catch (error) {
    if (error instanceof KnowledgeCoreError) throw error;
    fail("KNOWLEDGE_PATH_INVALID", String(error));
  }
  assertEvaluationInstant(options.at);
  const scan = await scanKnowledgeStore(workspaceRoot, options, false, "metadata-only");
  const unit = scan.units.find((entry) => entry.metadata.id === id);
  if (!unit) fail("KNOWLEDGE_NOT_FOUND", id);
  const freshness = computeFreshness(unit.metadata, options.at);
  if ((!options.allowUnpromoted && unit.metadata.promotionState !== "promoted") ||
    (!options.allowStale && freshness !== "fresh") || unit.metadata.retrievalDisposition === "excluded" || unit.metadata.lifecycle === "retired") {
    fail("KNOWLEDGE_BODY_ACCESS_DENIED", id);
  }
  const body = (await readBoundRegularFile(unit.bodyPath, KNOWLEDGE_LIMITS.maximumBodyBytes, options)).bytes;
  validateMetadataBody(unit.metadata, body, scan.workspace);
  return {
    schemaVersion: "tcrn.knowledge-body-read.v1",
    id,
    revision: unit.metadata.revision,
    freshness,
    bodySha256: unit.metadata.bodySha256,
    body: body.toString("utf8"),
    explicit: true,
  };
}

export async function evaluateKnowledgeFreshness(workspaceRoot: string, at: string, options: KnowledgeReadOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  assertEvaluationInstant(at);
  const scan = await scanKnowledgeStore(workspaceRoot, options, false, "metadata-only");
  const records = scan.units.map((unit) => ({
    id: unit.metadata.id,
    state: computeFreshness(unit.metadata, at),
    lastVerified: unit.metadata.lastVerified,
    maximumAgeDays: unit.metadata.stalenessPolicy.maximumAgeDays,
  }));
  records.sort((left, right) => compareCanonicalText(left.id, right.id));
  return {
    schemaVersion: "tcrn.knowledge-freshness-evaluation.v1",
    reasonCode: "KNOWLEDGE_FRESHNESS_EVALUATED",
    at,
    records,
    evaluationDigest: canonicalSha256(records),
  };
}

export async function transitionKnowledgePromotion(workspaceRoot: string, input: {
  readonly expectedVersion: number;
  readonly expectedRevision: number;
  readonly occurredAt: string;
  readonly id: string;
  readonly promotionState: "promoted" | "rejected";
}, options: KnowledgeMutationOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  try {
    assertProtocolId(input.id);
    assertStrictInstant(input.occurredAt);
  } catch (error) {
    fail("KNOWLEDGE_INPUT_INVALID", String(error));
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
    !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    fail("KNOWLEDGE_INPUT_INVALID", "promotion versions");
  }
  if (input.promotionState !== "promoted" && input.promotionState !== "rejected") {
    fail("KNOWLEDGE_PROMOTION_INVALID", String(input.promotionState));
  }
  const initial = await mutationAdmissionScan(workspaceRoot, options);
  const claim = await acquireMutationClaim(initial);
  let released = false;
  try {
    const scan = await scanKnowledgeStore(workspaceRoot, options, true);
    if (scan.marker.version !== input.expectedVersion) {
      fail("KNOWLEDGE_CAS_MISMATCH", `${input.expectedVersion}:${scan.marker.version}`);
    }
    const unit = scan.units.find((entry) => entry.metadata.id === input.id);
    if (!unit) fail("KNOWLEDGE_NOT_FOUND", input.id);
    if (unit.metadata.revision !== input.expectedRevision) {
      fail("KNOWLEDGE_CAS_MISMATCH", `${input.expectedRevision}:${unit.metadata.revision}`);
    }
    if (unit.metadata.promotionState !== "candidate") {
      fail("KNOWLEDGE_PROMOTION_INVALID", unit.metadata.promotionState);
    }
    const metadata: KnowledgeUnitMetadata = {
      ...unit.metadata,
      promotionState: input.promotionState,
      revision: unit.metadata.revision + 1,
      updatedAt: input.occurredAt,
    };
    // WSC-3 / SDC-6: full provenance is required only to promote; rejecting a
    // candidate never requires it.
    if (input.promotionState === "promoted") {
      assertPromotableProvenance(metadata);
    }
    const unitBody = requireBody(unit);
    const validated = validateMetadataShape(metadata as unknown as Readonly<Record<string, JsonValue>>, scan.workspace);
    validateMetadataBody(validated, unitBody, scan.workspace);
    const marker: KnowledgeStoreMarker = { ...scan.marker, version: scan.marker.version + 1 };
    const projectedMetadata = scan.units.map((entry) => entry.metadata.id === metadata.id ? metadata : entry.metadata);
    const projectedAggregate = Buffer.byteLength(canonicalJson(marker), "utf8") +
      Buffer.byteLength(canonicalJson(knowledgeIndex(marker, projectedMetadata)), "utf8") +
      scan.units.reduce((total, entry) => total +
        Buffer.byteLength(canonicalJson(entry.metadata.id === metadata.id ? metadata : entry.metadata), "utf8") + requireBody(entry).length, 0);
    if (projectedAggregate > KNOWLEDGE_LIMITS.maximumAggregateBytes) {
      fail("KNOWLEDGE_LIMIT_EXCEEDED", "knowledge promotion aggregate bytes");
    }
    await replaceRegularFile(unit.metadataPath, canonicalJson(metadata));
    crash("after-metadata-write", options.faultAt);
    await replaceRegularFile(resolve(scan.storeRoot, "store.json"), canonicalJson(marker));
    crash("after-marker-write", options.faultAt);
    await writeIndex(scan, marker, projectedMetadata);
    await releaseMutationClaim(scan.storeRoot, claim);
    released = true;
    await scanKnowledgeStore(workspaceRoot, options);
    return {
      schemaVersion: "tcrn.knowledge-promotion-result.v1",
      reasonCode: "KNOWLEDGE_PROMOTION_UPDATED",
      id: metadata.id,
      promotionState: metadata.promotionState,
      revision: metadata.revision,
      version: marker.version,
    };
  } finally {
    if (!released) await releaseMutationClaim(initial.storeRoot, claim);
  }
}

export async function exportKnowledgeCheckpoint(workspaceRoot: string, at: string, options: KnowledgeReadOptions = {}): Promise<string> {
  assertEvaluationInstant(at);
  const scan = await scanKnowledgeStore(workspaceRoot, options, false, "metadata-only");
  const records = scan.units.map((unit) => unit.metadata).filter((metadata) => isDefaultSelectable(metadata, at));
  records.sort((left, right) => compareCanonicalText(left.id, right.id));
  return canonicalJson({
    schemaVersion: "tcrn.knowledge-checkpoint.v1",
    reasonCode: "KNOWLEDGE_CHECKPOINT_READY",
    workspaceId: scan.marker.workspaceId,
    eventHighWaterDigest: scan.marker.eventHighWaterDigest,
    version: scan.marker.version,
    at,
    bodyStorage: "excluded",
    records,
    checkpointDigest: canonicalSha256(records),
  });
}
