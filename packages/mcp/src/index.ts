// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-325 — a dependency-free MCP stdio read surface. The wire
// framing accepts newline-delimited JSON (the MCP stdio transport) and retains
// Content-Length for existing clients. No CLI child process is spawned; the
// five handlers call the core read functions in-process.

import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STORY_SCOPE_HEADINGS,
  listKnowledgeMetadata,
  materializeWorkspace,
  templateBindingFromWorkRecord,
  validateWorkspace,
  workspaceBudgets,
} from "../../core/src/index.js";
import type { WorkRecord } from "../../protocol/src/index.js";

export const MCP_SERVER_VERSION = "tcrn.workflow-mcp.v1" as const;
export const MCP_PROTOCOL_VERSION = "2024-11-05" as const;
const WORK_KINDS = Object.freeze(["Initiative", "Epic", "Story", "Subtask", "Incident", "Release"]);

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "work_search",
    description: "Search work records by external key or advisory scope and return bounded scope excerpts.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Absolute workspace root." },
        query: { type: "string", description: "Case-insensitive substring." },
        projectId: { type: "string" }, kind: { type: "string" }, status: { type: "string" },
        parentId: { type: "string" }, scopeBytes: { type: "integer", minimum: 1, maximum: 65536 },
        limit: { type: "integer", minimum: 1 }, offset: { type: "integer", minimum: 0 },
      },
      required: ["workspace", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "work_show",
    description: "Read one non-tombstoned work record and its advisory fields.",
    inputSchema: {
      type: "object", properties: { workspace: { type: "string" }, id: { type: "string" } },
      required: ["workspace", "id"], additionalProperties: false,
    },
  },
  {
    name: "knowledge_search",
    description: "Search knowledge metadata by relevance without opening knowledge bodies.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string" }, at: { type: "string" }, query: { type: "string" },
        selection: { type: "string", enum: ["default", "all"] }, kind: { type: "string" },
        projectId: { type: "string" }, roleScope: { type: "string" }, limit: { type: "integer", minimum: 1 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["workspace", "at", "query"], additionalProperties: false,
    },
  },
  {
    name: "work_draft",
    description: "Return a Story scope skeleton and the three most recent same-project examples.",
    inputSchema: {
      type: "object", properties: { workspace: { type: "string" }, kind: { type: "string" }, projectId: { type: "string" } },
      required: ["workspace", "kind", "projectId"], additionalProperties: false,
    },
  },
  {
    name: "status",
    description: "Read workspace authority, version, head hash, and bounded view budgets.",
    inputSchema: {
      type: "object", properties: { workspace: { type: "string" } },
      required: ["workspace"], additionalProperties: false,
    },
  },
] as const);

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function stringArg(args: JsonObject, name: string, required = true): string {
  const value = args[name];
  if (typeof value !== "string" || (required && value.length === 0)) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalString(args: JsonObject, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalInteger(args: JsonObject, name: string, minimum: number): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

function excerpt(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function scopeOf(record: WorkRecord): string {
  const entry = record.extensions["advisory:scope"];
  return typeof entry?.value === "string" ? entry.value : "";
}

function workSummary(record: WorkRecord): JsonObject {
  const binding = templateBindingFromWorkRecord(record);
  return {
    id: record.id, externalKey: record.externalKey, kind: record.kind, status: record.status,
    projectId: record.projectId, parentId: record.parentId, revision: record.revision,
    tombstone: record.tombstone, ...(binding === null ? {} : { templateBinding: binding }),
  };
}

function page(records: readonly JsonObject[], state: Awaited<ReturnType<typeof validateWorkspace>>, args: JsonObject): JsonObject {
  const limit = optionalInteger(args, "limit", 1);
  const offset = optionalInteger(args, "offset", 0) ?? 0;
  const recordsPage = limit === undefined ? records.slice(offset) : records.slice(offset, offset + limit);
  return {
    reasonCode: "WORKSPACE_LIST_READY", workspaceId: state.metadata.workspaceId, version: state.version,
    headEventHash: state.headEventHash, kind: "work", total: records.length,
    truncated: offset + recordsPage.length < records.length, records: recordsPage,
  };
}

async function workSearch(args: JsonObject): Promise<JsonObject> {
  const workspace = stringArg(args, "workspace");
  const query = stringArg(args, "query").toLowerCase();
  const state = await validateWorkspace(workspace);
  const projectId = optionalString(args, "projectId");
  const kind = optionalString(args, "kind");
  const status = optionalString(args, "status");
  const parentId = optionalString(args, "parentId");
  const scopeBytes = optionalInteger(args, "scopeBytes", 1) ?? 512;
  if (scopeBytes > 65536) throw new Error("scopeBytes exceeds 65536");
  const records = state.work.filter((record) => !record.tombstone &&
    (projectId === undefined || record.projectId === projectId) &&
    (kind === undefined || record.kind === kind) && (status === undefined || record.status === status) &&
    (parentId === undefined || record.parentId === parentId) &&
    (record.externalKey.toLowerCase().includes(query) || scopeOf(record).toLowerCase().includes(query)))
    .map((record) => ({ ...workSummary(record), scope: excerpt(scopeOf(record), scopeBytes) }));
  return page(records, state, args);
}

async function workShow(args: JsonObject): Promise<JsonObject> {
  const workspace = stringArg(args, "workspace");
  const id = stringArg(args, "id");
  const state = await validateWorkspace(workspace);
  const record = state.work.find((candidate) => candidate.id === id && !candidate.tombstone);
  if (record === undefined) throw new Error(`work ${id} is unavailable`);
  const advisory: JsonObject = {};
  for (const [key, output] of [["advisory:scope", "scope"], ["advisory:decided-by", "decidedBy"], ["advisory:sprint", "sprint"]] as const) {
    const value = record.extensions[key]?.value;
    if (value !== undefined) advisory[output] = value;
  }
  return {
    reasonCode: "WORKSPACE_RECORD_READY", workspaceId: state.metadata.workspaceId, version: state.version,
    headEventHash: state.headEventHash, kind: "work", record: workSummary(record),
    ...(Object.keys(advisory).length === 0 ? {} : { advisory }),
  };
}

async function workDraft(args: JsonObject): Promise<JsonObject> {
  const workspace = stringArg(args, "workspace");
  const kind = stringArg(args, "kind");
  const projectId = stringArg(args, "projectId");
  if (!WORK_KINDS.includes(kind)) throw new Error(`kind ${kind} is not supported`);
  const state = await validateWorkspace(workspace);
  if (!state.projects.some((project) => !project.tombstone && project.id === projectId)) throw new Error(`project ${projectId} does not exist`);
  const headings = kind === "Story" ? [...STORY_SCOPE_HEADINGS] : [];
  const examples = state.work.filter((record) => !record.tombstone && record.kind === kind && record.projectId === projectId && scopeOf(record).length > 0)
    .slice(-3).reverse().map((record) => ({ id: record.id, externalKey: record.externalKey, kind: record.kind, scope: scopeOf(record) }));
  return {
    schemaVersion: "tcrn.work-draft.v1", reasonCode: "WORKSPACE_WORK_DRAFT_READY", workspaceId: state.metadata.workspaceId,
    version: state.version, headEventHash: state.headEventHash, kind, projectId, headings,
    scopeTemplate: headings.map((heading) => `【${heading}】\n<填写 ${heading}>`).join("\n\n"),
    skeleton: headings.map((heading) => `【${heading}】\n<填写 ${heading}>`).join("\n\n"),
    template: headings.map((heading) => `【${heading}】\n<填写 ${heading}>`).join("\n\n"), examples,
  };
}

async function knowledgeSearch(args: JsonObject): Promise<Readonly<Record<string, unknown>>> {
  const workspace = stringArg(args, "workspace");
  const at = stringArg(args, "at");
  const query = stringArg(args, "query");
  const selection = optionalString(args, "selection");
  if (selection !== undefined && selection !== "default" && selection !== "all") throw new Error("selection must be default or all");
  const projectId = optionalString(args, "projectId");
  const roleScope = optionalString(args, "roleScope");
  const kind = optionalString(args, "kind");
  const limit = optionalInteger(args, "limit", 1);
  const offset = optionalInteger(args, "offset", 0);
  return listKnowledgeMetadata(workspace, {
    at, search: query, allowTrailing: true,
    ...(selection === undefined ? {} : { selection: selection as "default" | "all" }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(roleScope === undefined ? {} : { roleScope }),
    ...(kind === undefined ? {} : { kind: kind as "fact" | "guide" | "decision" | "reference" | "summary" }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  });
}

async function status(args: JsonObject): Promise<JsonObject> {
  const workspace = stringArg(args, "workspace");
  const state = await materializeWorkspace(workspace);
  return {
    reasonCode: "WORKSPACE_COMMAND_COMPLETED", workspaceId: state.metadata.workspaceId, version: state.version,
    headEventHash: state.headEventHash, projects: state.projects.filter((record) => !record.tombstone).length,
    work: state.work.filter((record) => !record.tombstone).length, budgets: workspaceBudgets(state),
  };
}

async function callTool(name: string, args: JsonObject): Promise<Readonly<Record<string, unknown>>> {
  switch (name) {
    case "work_search": return workSearch(args);
    case "work_show": return workShow(args);
    case "knowledge_search": return knowledgeSearch(args);
    case "work_draft": return workDraft(args);
    case "status": return status(args);
    default: throw new Error(`unknown tool ${name}`);
  }
}

function response(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function errorResponse(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

type MessageFraming = "newline" | "content-length";

function writeMessage(value: string, framing: MessageFraming): void {
  if (framing === "newline") {
    stdout.write(`${value}\n`);
    return;
  }
  const bytes = Buffer.byteLength(value, "utf8");
  stdout.write(`Content-Length: ${bytes}\r\n\r\n${value}`);
}

export async function dispatchMessage(message: unknown): Promise<string | null> {
  const request = object(message, "JSON-RPC request");
  const id = (typeof request.id === "string" || typeof request.id === "number" || request.id === null) ? request.id : null;
  const method = request.method;
  if (typeof method !== "string") return errorResponse(id, -32600, "method is required");
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "initialize") {
    const params = request.params === undefined ? {} : object(request.params, "initialize params");
    return response(id, {
      protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "tcrn-workflow", version: MCP_SERVER_VERSION },
    });
  }
  if (method === "tools/list") return response(id, { tools: TOOL_DEFINITIONS });
  if (method === "tools/call") {
    try {
      const params = object(request.params, "tools/call params");
      const name = stringArg(params, "name");
      const args = params.arguments === undefined ? {} : object(params.arguments, "tool arguments");
      const result = await callTool(name, args);
      return response(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      return response(id, { isError: true, content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }] });
    }
  }
  return errorResponse(id, -32601, `method not found: ${method}`);
}

let inputBuffer = Buffer.alloc(0);
let expectedBodyBytes: number | null = null;

interface InputFrame {
  readonly body: Buffer;
  readonly framing: MessageFraming;
}

function nextInputFrame(): InputFrame | null {
  if (expectedBodyBytes !== null) {
    if (inputBuffer.length < expectedBodyBytes) return null;
    const body = inputBuffer.subarray(0, expectedBodyBytes);
    inputBuffer = inputBuffer.subarray(expectedBodyBytes);
    expectedBodyBytes = null;
    return { body, framing: "content-length" };
  }

  // A header candidate is identified from the first complete header block. A
  // JSON-lines message cannot contain a literal newline, so this does not
  // steal a valid newline-delimited message from the other branch.
  const headerSeparator = inputBuffer.indexOf("\r\n\r\n");
  if (headerSeparator >= 0) {
    const header = inputBuffer.subarray(0, headerSeparator).toString("ascii");
    const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/iu);
    if (match !== null) {
      const length = Number(match[1]);
      inputBuffer = inputBuffer.subarray(headerSeparator + 4);
      if (!Number.isSafeInteger(length) || length < 0) {
        return { body: Buffer.alloc(0), framing: "content-length" };
      }
      expectedBodyBytes = length;
      return nextInputFrame();
    }
  }

  const newline = inputBuffer.indexOf(0x0a);
  if (newline < 0) return null;
  let body = inputBuffer.subarray(0, newline);
  inputBuffer = inputBuffer.subarray(newline + 1);
  if (body.length > 0 && body[body.length - 1] === 0x0d) body = body.subarray(0, body.length - 1);
  if (body.length === 0) return nextInputFrame();
  return { body, framing: "newline" };
}

async function consumeInput(): Promise<void> {
  for (;;) {
    const frame = nextInputFrame();
    if (frame === null) return;
    const body = frame.body.toString("utf8");
    try {
      const output = await dispatchMessage(JSON.parse(body));
      if (output !== null) writeMessage(output, frame.framing);
    } catch (error) {
      writeMessage(errorResponse(null, -32700, String(error instanceof Error ? error.message : error)), frame.framing);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let inputTask = Promise.resolve();
  stdin.on("data", (chunk: Buffer) => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    inputTask = inputTask.then(consumeInput);
  });
}
