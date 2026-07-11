// SPDX-License-Identifier: Apache-2.0

import {
  acquireWorkspaceLease,
  createProject,
  createWork,
  deleteProject,
  deleteWork,
  exportWorkspace,
  initializeWorkspace,
  planWorkspaceMigration,
  recoverWorkspace,
  transitionWork,
  updateProject,
  validateWorkspace,
} from "../../core/src/index.js";
import type { ExplicitRoot } from "../../core/src/index.js";
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
