// SPDX-License-Identifier: Apache-2.0

import {
  acquireWorkspaceLease,
  applyArtifactArchive,
  artifactArchiveDryRun,
  artifactCompactDryRun,
  artifactDoctor,
  artifactSizeReport,
  createKnowledgeUnit,
  createProject,
  createWork,
  deleteProject,
  deleteWork,
  evaluateKnowledgeFreshness,
  exportKnowledgeCheckpoint,
  exportWorkspace,
  initializeKnowledgeStore,
  initializeWorkspace,
  listKnowledgeMetadata,
  planWorkspaceMigration,
  readKnowledgeBody,
  readKnowledgeSnippet,
  recoverWorkspace,
  restoreArtifactArchive,
  transitionKnowledgePromotion,
  transitionWork,
  updateProject,
  validateKnowledgeStore,
  validateWorkspace,
} from "../../core/src/index.js";
import type {
  ExplicitRoot,
  KnowledgeCategory,
  KnowledgeFreshnessState,
  KnowledgeKind,
  KnowledgePromotionState,
} from "../../core/src/index.js";
import { canonicalJson } from "../../protocol/src/index.js";
import type { PlannedDeliveryKind, WorkStatus } from "../../protocol/src/index.js";

export const RELEASE_REQUIRED_ARGUMENTS = [
  "trust-root",
  "bundle",
  "subject",
  "repository",
  "workflow",
  "now",
] as const;

export type ReleaseRequiredArgument =
  (typeof RELEASE_REQUIRED_ARGUMENTS)[number];

export function missingReleaseArguments(
  supplied: Readonly<Record<string, string | undefined>>,
): readonly ReleaseRequiredArgument[] {
  return RELEASE_REQUIRED_ARGUMENTS.filter((name) => !supplied[name]);
}

export class WorkflowCliError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "WorkflowCliError";
    this.reasonCode = reasonCode;
  }
}

export interface CliIo {
  write(value: string): void;
}

function fail(reasonCode: string, message: string): never {
  throw new WorkflowCliError(reasonCode, message);
}

function parseArguments(arguments_: readonly string[], allowed: readonly string[]): Readonly<Record<string, string>> {
  if (arguments_.some((value) => value.length > 8_192)) {
    fail("CLI_INPUT_OVERSIZED", "CLI arguments exceed the local input limit");
  }
  const values: Record<string, string> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("CLI_ARGUMENT_MALFORMED", String(flag ?? "missing"));
    }
    const name = flag.slice(2);
    if (!allowed.includes(name)) {
      fail("CLI_ARGUMENT_UNKNOWN", name);
    }
    if (Object.hasOwn(values, name)) {
      fail("CLI_ARGUMENT_DUPLICATE", name);
    }
    values[name] = value;
  }
  return values;
}

function required(values: Readonly<Record<string, string>>, names: readonly string[]): void {
  const missing = names.filter((name) => !values[name]);
  if (missing.length > 0) {
    fail("CLI_ARGUMENT_MISSING", missing.join(","));
  }
}

function expectedVersion(values: Readonly<Record<string, string>>): number {
  const version = Number(values["expected-version"]);
  if (!Number.isSafeInteger(version) || version < 0) {
    fail("CLI_ARGUMENT_MALFORMED", "expected-version");
  }
  return version;
}

function boundedInteger(values: Readonly<Record<string, string>>, name: string): number | undefined {
  const raw = values[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("CLI_ARGUMENT_MALFORMED", name);
  }
  return value;
}

function listValue(value: string | undefined): readonly string[] {
  if (!value || value === "-") return [];
  const values = value.split(",");
  if (values.some((entry) => entry.length === 0)) fail("CLI_ARGUMENT_MALFORMED", "list");
  return values;
}

function booleanValue(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  fail("CLI_ARGUMENT_MALFORMED", name);
}

async function withLease<T>(workspace: string, at: string, operation: (lease: Awaited<ReturnType<typeof acquireWorkspaceLease>>) => Promise<T>): Promise<T> {
  const lease = await acquireWorkspaceLease(workspace, { now: at });
  try {
    return await operation(lease);
  } finally {
    await lease.release();
  }
}

function writeState(io: CliIo, state: Awaited<ReturnType<typeof validateWorkspace>>): void {
  io.write(canonicalJson({
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    projects: state.projects.filter((record) => !record.tombstone).length,
    work: state.work.filter((record) => !record.tombstone).length,
  }));
}

export async function runCli(arguments_: readonly string[], io: CliIo): Promise<void> {
  const command = arguments_[0];
  if (!command || command.startsWith("--")) {
    fail("CLI_COMMAND_REQUIRED", "A governed command is required");
  }
  const rest = arguments_.slice(1);
  if (command === "init") {
    const names = ["workspace", "framework", "transient", "evidence-locator", "release-trust", "external-key", "at", "segment-events"];
    const values = parseArguments(rest, names);
    required(values, names.slice(0, 7));
    const roots: ExplicitRoot[] = [
      { kind: "framework", path: values.framework ?? "" },
      { kind: "workspace", path: values.workspace ?? "" },
      { kind: "transient", path: values.transient ?? "" },
      { kind: "evidence-locator", path: values["evidence-locator"] ?? "" },
      { kind: "release-trust", path: values["release-trust"] ?? "" },
    ];
    const state = await initializeWorkspace({
      roots,
      externalKey: values["external-key"] ?? "",
      createdAt: values.at ?? "",
      ...(values["segment-events"] ? { segmentEventLimit: Number(values["segment-events"]) } : {}),
    });
    writeState(io, state);
    return;
  }
  if (command === "validate" || command === "status") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    writeState(io, await validateWorkspace(values.workspace ?? ""));
    return;
  }
  if (command === "export") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(await exportWorkspace(values.workspace ?? ""));
    return;
  }
  if (command === "migration-plan") {
    const values = parseArguments(rest, ["workspace", "target-version", "dry-run"]);
    required(values, ["workspace", "target-version", "dry-run"]);
    if (values["dry-run"] !== "true") {
      fail("CLI_MIGRATION_DRY_RUN_REQUIRED", "P3 migration planning is dry-run only");
    }
    io.write(canonicalJson(await planWorkspaceMigration(values.workspace ?? "", Number(values["target-version"]))));
    return;
  }
  if (command === "recover") {
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => recoverWorkspace(workspace, lease));
    writeState(io, state);
    return;
  }
  if (command === "knowledge-init") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await initializeKnowledgeStore(values.workspace ?? "")));
    return;
  }
  if (command === "knowledge-validate") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await validateKnowledgeStore(values.workspace ?? "")));
    return;
  }
  if (command === "knowledge-create") {
    const names = [
      "workspace", "expected-version", "at", "external-key", "scope", "project-id", "role-scopes", "category", "kind", "tags",
      "subject", "summary", "snippet", "accountable-owner-id", "source-references", "source-digest", "work-ids", "decision-ids", "gate-ids", "evidence-ids",
      "lifecycle", "retrieval", "freshness", "last-verified", "stale-days", "export", "body",
    ];
    const values = parseArguments(rest, names);
    required(values, names);
    io.write(canonicalJson(await createKnowledgeUnit(values.workspace ?? "", {
      expectedVersion: expectedVersion(values),
      occurredAt: values.at ?? "",
      externalKey: values["external-key"] ?? "",
      scope: values.scope as "workspace" | "project" | "role",
      projectId: values["project-id"] === "null" ? null : values["project-id"] ?? null,
      roleScopes: listValue(values["role-scopes"]),
      category: values.category as KnowledgeCategory,
      kind: values.kind as KnowledgeKind,
      tags: listValue(values.tags),
      subject: values.subject ?? "",
      summary: values.summary ?? "",
      snippet: values.snippet ?? "",
      accountableOwnerId: values["accountable-owner-id"] ?? "",
      sourceReferences: listValue(values["source-references"]),
      sourceDigest: values["source-digest"] ?? "",
      linkedWorkIds: listValue(values["work-ids"]),
      linkedDecisionIds: listValue(values["decision-ids"]),
      linkedGateIds: listValue(values["gate-ids"]),
      linkedEvidenceIds: listValue(values["evidence-ids"]),
      lifecycle: values.lifecycle as "candidate" | "active" | "retired",
      retrievalDisposition: values.retrieval as "default" | "explicit-only" | "excluded",
      freshnessState: values.freshness as KnowledgeFreshnessState,
      lastVerified: values["last-verified"] === "null" ? null : values["last-verified"] ?? null,
      stalenessPolicy: { maximumAgeDays: Number(values["stale-days"]), unknownDisposition: "fail-closed" },
      exportDisposition: values.export as "metadata-only" | "excluded",
      body: values.body ?? "",
    })));
    return;
  }
  if (command === "knowledge-list") {
    const values = parseArguments(rest, ["workspace", "at", "selection", "project-id", "role-scope", "category", "kind", "tag", "freshness", "promotion"]);
    required(values, ["workspace", "at"]);
    io.write(canonicalJson(await listKnowledgeMetadata(values.workspace ?? "", {
      at: values.at ?? "",
      ...(values.selection ? { selection: values.selection as "default" | "all" } : {}),
      ...(values["project-id"] ? { projectId: values["project-id"] } : {}),
      ...(values["role-scope"] ? { roleScope: values["role-scope"] } : {}),
      ...(values.category ? { category: values.category as KnowledgeCategory } : {}),
      ...(values.kind ? { kind: values.kind as KnowledgeKind } : {}),
      ...(values.tag ? { tag: values.tag } : {}),
      ...(values.freshness ? { freshness: values.freshness as KnowledgeFreshnessState } : {}),
      ...(values.promotion ? { promotionState: values.promotion as KnowledgePromotionState } : {}),
    })));
    return;
  }
  if (command === "knowledge-snippet") {
    const values = parseArguments(rest, ["workspace", "id"]);
    required(values, ["workspace", "id"]);
    io.write(canonicalJson(await readKnowledgeSnippet(values.workspace ?? "", values.id ?? "")));
    return;
  }
  if (command === "knowledge-body") {
    const values = parseArguments(rest, ["workspace", "id", "at", "allow-unpromoted", "allow-stale"]);
    required(values, ["workspace", "id", "at"]);
    io.write(canonicalJson(await readKnowledgeBody(values.workspace ?? "", values.id ?? "", {
      at: values.at ?? "",
      allowUnpromoted: booleanValue(values["allow-unpromoted"], "allow-unpromoted"),
      allowStale: booleanValue(values["allow-stale"], "allow-stale"),
    })));
    return;
  }
  if (command === "knowledge-freshness") {
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    io.write(canonicalJson(await evaluateKnowledgeFreshness(values.workspace ?? "", values.at ?? "")));
    return;
  }
  if (command === "knowledge-promote") {
    const values = parseArguments(rest, ["workspace", "expected-version", "expected-revision", "at", "id", "state"]);
    required(values, ["workspace", "expected-version", "expected-revision", "at", "id", "state"]);
    io.write(canonicalJson(await transitionKnowledgePromotion(values.workspace ?? "", {
      expectedVersion: expectedVersion(values),
      expectedRevision: Number(values["expected-revision"]),
      occurredAt: values.at ?? "",
      id: values.id ?? "",
      promotionState: values.state as "promoted" | "rejected",
    })));
    return;
  }
  if (command === "knowledge-checkpoint") {
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    io.write(await exportKnowledgeCheckpoint(values.workspace ?? "", values.at ?? ""));
    return;
  }
  if (command === "artifact-size") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await artifactSizeReport(values.workspace ?? "")));
    return;
  }
  if (command === "artifact-doctor") {
    const names = ["workspace", "warning-bytes", "critical-bytes", "warning-count", "critical-count"];
    const values = parseArguments(rest, names);
    required(values, ["workspace"]);
    const warningBytes = boundedInteger(values, "warning-bytes");
    const criticalBytes = boundedInteger(values, "critical-bytes");
    const warningCount = boundedInteger(values, "warning-count");
    const criticalCount = boundedInteger(values, "critical-count");
    io.write(canonicalJson(await artifactDoctor(values.workspace ?? "", {
      ...(warningBytes === undefined ? {} : { warningBytes }),
      ...(criticalBytes === undefined ? {} : { criticalBytes }),
      ...(warningCount === undefined ? {} : { warningCount }),
      ...(criticalCount === undefined ? {} : { criticalCount }),
    })));
    return;
  }
  if (command === "artifact-compact-dry-run") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await artifactCompactDryRun(values.workspace ?? "")));
    return;
  }
  if (command === "artifact-archive-dry-run") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await artifactArchiveDryRun(values.workspace ?? "")));
    return;
  }
  if (command === "artifact-archive-apply") {
    const values = parseArguments(rest, ["workspace", "expected-plan-digest"]);
    required(values, ["workspace", "expected-plan-digest"]);
    io.write(canonicalJson(await applyArtifactArchive(values.workspace ?? "", {
      expectedPlanDigest: values["expected-plan-digest"] ?? "",
    })));
    return;
  }
  if (command === "artifact-archive-restore") {
    const values = parseArguments(rest, ["workspace", "archive-id", "expected-plan-digest"]);
    required(values, ["workspace", "archive-id", "expected-plan-digest"]);
    io.write(canonicalJson(await restoreArtifactArchive(
      values.workspace ?? "",
      values["archive-id"] ?? "",
      { expectedPlanDigest: values["expected-plan-digest"] ?? "" },
    )));
    return;
  }
  const shared = ["workspace", "expected-version", "at"];
  if (command === "project-create") {
    const values = parseArguments(rest, [...shared, "external-key", "name"]);
    required(values, [...shared, "external-key", "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => createProject(workspace, lease, {
      expectedVersion: expectedVersion(values), occurredAt: at, externalKey: values["external-key"] ?? "", name: values.name ?? "",
    }));
    writeState(io, state);
    return;
  }
  if (command === "project-update") {
    const values = parseArguments(rest, [...shared, "id", "name"]);
    required(values, [...shared, "id", "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => updateProject(workspace, lease, {
      expectedVersion: expectedVersion(values), occurredAt: at, id: values.id ?? "", name: values.name ?? "",
    }));
    writeState(io, state);
    return;
  }
  if (command === "project-delete") {
    const values = parseArguments(rest, [...shared, "id"]);
    required(values, [...shared, "id"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => deleteProject(workspace, lease, {
      expectedVersion: expectedVersion(values), occurredAt: at, id: values.id ?? "",
    }));
    writeState(io, state);
    return;
  }
  if (command === "work-create") {
    const values = parseArguments(rest, [...shared, "project-id", "external-key", "kind", "parent-id", "status"]);
    required(values, [...shared, "project-id", "external-key", "kind"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => createWork(workspace, lease, {
      expectedVersion: expectedVersion(values),
      occurredAt: at,
      projectId: values["project-id"] ?? "",
      externalKey: values["external-key"] ?? "",
      kind: values.kind as PlannedDeliveryKind,
      parentId: values["parent-id"] ?? null,
      ...(values.status ? { status: values.status as WorkStatus } : {}),
    }));
    writeState(io, state);
    return;
  }
  if (command === "work-transition") {
    const values = parseArguments(rest, [...shared, "id", "status"]);
    required(values, [...shared, "id", "status"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => transitionWork(workspace, lease, {
      expectedVersion: expectedVersion(values), occurredAt: at, id: values.id ?? "", status: values.status as WorkStatus,
    }));
    writeState(io, state);
    return;
  }
  if (command === "work-delete") {
    const values = parseArguments(rest, [...shared, "id"]);
    required(values, [...shared, "id"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withLease(workspace, at, (lease) => deleteWork(workspace, lease, {
      expectedVersion: expectedVersion(values), occurredAt: at, id: values.id ?? "",
    }));
    writeState(io, state);
    return;
  }
  fail("CLI_COMMAND_UNKNOWN", command);
}
