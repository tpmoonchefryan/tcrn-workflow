// SPDX-License-Identifier: Apache-2.0
//
// INIT-009 / EPIC-022: a host-neutral Workflow MCP facade over the canonical
// command catalog. The facade is intentionally thin: tool schemas remove shell
// quoting and nested-receipt parsing, while runOperatorCli remains the one command
// dispatcher. Mutating tools additionally require an exact command grant from the
// independently pinned operator-authority bundle. CAS, explicit instants, actor
// fields and stable reason codes therefore remain the CLI/core implementation's
// responsibility rather than being reinterpreted here.

import type { Readable, Writable } from "node:stream";

import {
  FRAMEWORK_VERSION,
  assertOperatorMcpAuthorityOutputGranted,
  assertOperatorMcpWriteGranted,
  readOperatorAuthority,
} from "../../core/src/index.js";
import {
  COMMAND_CATALOG,
  runOperatorCli,
} from "./index.js";

export const WORKFLOW_MCP_PROTOCOL_VERSIONS = Object.freeze([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const);
export const WORKFLOW_MCP_SERVER_NAME = "tcrn-workflow" as const;
export const WORKFLOW_MCP_TOOL_PREFIX = "tcrn_workflow_" as const;

type JsonRpcId = string | number;

interface CatalogFlag {
  readonly name: string;
  readonly required: boolean;
  readonly valueKind: "string" | "json" | "integer" | "instant" | "boolean" | "list";
  readonly headSentinel?: true;
}

interface CatalogEntry {
  readonly name: string;
  readonly availability: "cli" | "programmatic-only" | "fixture-only";
  readonly mutates: boolean;
  readonly authorityBearing?: boolean;
  readonly flags: readonly CatalogFlag[];
}

export interface WorkflowMcpOptions {
  readonly authorityPinsPath?: string;
  readonly authorityPinsDigest?: string;
  readonly clock: () => string;
}

export class WorkflowMcpError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "WorkflowMcpError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: string, message: string): never {
  throw new WorkflowMcpError(reasonCode, message);
}

function record(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    fail("MCP_INVALID_REQUEST", label);
  }
  return value as Readonly<Record<string, unknown>>;
}

function authorityArguments(options: WorkflowMcpOptions): readonly string[] {
  const hasPath = options.authorityPinsPath !== undefined;
  const hasDigest = options.authorityPinsDigest !== undefined;
  if (hasPath !== hasDigest) {
    fail(
      "OPERATOR_AUTHORITY_REQUIRED",
      "authority pins path and digest are required together",
    );
  }
  return hasPath
    ? [
      "--authority-pins",
      options.authorityPinsPath as string,
      "--authority-pins-digest",
      options.authorityPinsDigest as string,
    ]
    : [];
}

function catalog(): readonly CatalogEntry[] {
  return COMMAND_CATALOG as readonly CatalogEntry[];
}

function toolName(command: string): string {
  return `${WORKFLOW_MCP_TOOL_PREFIX}${command.replaceAll("-", "_")}`;
}

function commandForTool(name: string): CatalogEntry | undefined {
  return catalog().find((entry) => toolName(entry.name) === name);
}

function flagSchema(flag: CatalogFlag): Readonly<Record<string, unknown>> {
  if (flag.valueKind === "integer") {
    return flag.headSentinel === true
      ? { oneOf: [{ type: "integer" }, { const: "head" }] }
      : { type: "integer" };
  }
  if (flag.valueKind === "boolean") return { type: "boolean" };
  if (flag.valueKind === "list") {
    return { type: "array", items: { type: "string" } };
  }
  if (flag.valueKind === "json") return {};
  if (flag.valueKind === "instant") {
    return { type: "string", format: "date-time" };
  }
  return { type: "string" };
}

function toolDescriptor(entry: CatalogEntry): Readonly<Record<string, unknown>> {
  const properties = Object.fromEntries(
    entry.flags.map((flag) => [flag.name, flagSchema(flag)]),
  );
  return {
    name: toolName(entry.name),
    description: `${entry.mutates ? "Governed write" : entry.authorityBearing ? "Authority-bearing output" : "Read-only"} Workflow command: ${entry.name}. Stable CLI reason codes are preserved.`,
    inputSchema: {
      type: "object",
      properties,
      required: entry.flags.filter((flag) => flag.required)
        .map((flag) => flag.name),
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: !(entry.mutates || entry.authorityBearing === true),
      destructiveHint: entry.mutates,
      idempotentHint: !(entry.mutates || entry.authorityBearing === true),
      openWorldHint: false,
    },
  };
}

export function workflowMcpTools(): readonly Readonly<Record<string, unknown>>[] {
  const tools = catalog()
    .filter((entry) => entry.availability !== "fixture-only")
    .map(toolDescriptor);
  const names = tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) {
    fail("MCP_TOOL_COLLISION", "catalog command names do not map one-to-one");
  }
  return tools;
}

function cliFlagValue(flag: CatalogFlag, value: unknown): string {
  if (flag.valueKind === "string" || flag.valueKind === "instant") {
    if (typeof value !== "string") {
      fail("MCP_ARGUMENT_INVALID", flag.name);
    }
    return value;
  }
  if (flag.valueKind === "integer") {
    if (flag.headSentinel === true && value === "head") return "head";
    if (!Number.isSafeInteger(value)) {
      fail("MCP_ARGUMENT_INVALID", flag.name);
    }
    return String(value);
  }
  if (flag.valueKind === "boolean") {
    if (typeof value !== "boolean") {
      fail("MCP_ARGUMENT_INVALID", flag.name);
    }
    return String(value);
  }
  if (flag.valueKind === "list") {
    if (!Array.isArray(value) ||
      value.some((entry) => typeof entry !== "string" ||
        entry.length === 0 || entry.includes(","))) {
      fail("MCP_ARGUMENT_INVALID", flag.name);
    }
    return value.length === 0 ? "-" : value.join(",");
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) fail("MCP_ARGUMENT_INVALID", flag.name);
    return serialized;
  } catch {
    fail("MCP_ARGUMENT_INVALID", flag.name);
  }
}

function cliArguments(
  entry: CatalogEntry,
  input: unknown,
): readonly string[] {
  const argumentsRecord = input === undefined ? {} : record(input, "arguments");
  const allowed = new Set(entry.flags.map((flag) => flag.name));
  const unknown = Object.keys(argumentsRecord)
    .filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    fail("MCP_ARGUMENT_UNKNOWN", unknown.sort().join(","));
  }
  const missing = entry.flags.filter(
    (flag) => flag.required && argumentsRecord[flag.name] === undefined,
  );
  if (missing.length > 0) {
    fail("MCP_ARGUMENT_MISSING", missing.map((flag) => flag.name).join(","));
  }
  const result: string[] = [entry.name];
  for (const flag of entry.flags) {
    const value = argumentsRecord[flag.name];
    if (value === undefined) continue;
    result.push(`--${flag.name}`, cliFlagValue(flag, value));
  }
  return result;
}

function parsedOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function errorResult(error: unknown): Readonly<Record<string, unknown>> {
  const reasonCode = typeof (error as { reasonCode?: unknown })?.reasonCode ===
    "string"
    ? (error as { reasonCode: string }).reasonCode
    : "MCP_INTERNAL_ERROR";
  const result = {
    ok: false,
    reasonCode,
    error: String((error as { message?: unknown })?.message ?? error),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: true,
  };
}

export class WorkflowMcpDispatcher {
  readonly #options: WorkflowMcpOptions;
  #initialized = false;

  constructor(options: WorkflowMcpOptions) {
    authorityArguments(options);
    this.#options = options;
  }

  async #callTool(
    name: unknown,
    input: unknown,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (typeof name !== "string") {
      fail("MCP_TOOL_UNKNOWN", "tool name");
    }
    const entry = commandForTool(name);
    if (!entry || entry.availability === "fixture-only") {
      fail("MCP_TOOL_UNKNOWN", name);
    }
    if (entry.mutates || entry.authorityBearing === true) {
      if (!this.#options.authorityPinsPath ||
        !this.#options.authorityPinsDigest) {
        fail(
          "OPERATOR_AUTHORITY_REQUIRED",
          `MCP ${entry.mutates ? "write" : "authority-bearing output"} requires pinned authority: ${entry.name}`,
        );
      }
      const context = await readOperatorAuthority(
        this.#options.authorityPinsPath,
        {
          expectedCanonicalPath: this.#options.authorityPinsPath,
          expectedFileSha256: this.#options.authorityPinsDigest,
        },
        this.#options.clock(),
      );
      if (entry.mutates) {
        assertOperatorMcpWriteGranted(context, entry.name);
      } else {
        assertOperatorMcpAuthorityOutputGranted(context, entry.name);
      }
    }
    const output: string[] = [];
    await runOperatorCli([
      ...authorityArguments(this.#options),
      ...cliArguments(entry, input),
    ], {
      write: (value) => output.push(value),
      clock: this.#options.clock,
    });
    const text = output.join("");
    const result = {
      ok: true,
      command: entry.name,
      result: parsedOutput(text),
    };
    return {
      content: [{ type: "text", text }],
      structuredContent: result,
      isError: false,
    };
  }

  async dispatch(value: unknown): Promise<Readonly<Record<string, unknown>> | null> {
    const request = record(value, "JSON-RPC request");
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      fail("MCP_INVALID_REQUEST", "jsonrpc or method");
    }
    const notification = request.id === undefined;
    if (!notification && typeof request.id !== "string" &&
      typeof request.id !== "number") {
      fail("MCP_INVALID_REQUEST", "id");
    }
    const id = request.id as JsonRpcId;
    if (request.method === "notifications/initialized") {
      this.#initialized = true;
      return null;
    }
    if (notification) return null;
    if (request.method === "initialize") {
      const parameters = record(request.params, "initialize params");
      const requested = typeof parameters.protocolVersion === "string"
        ? parameters.protocolVersion
        : "";
      const protocolVersion = WORKFLOW_MCP_PROTOCOL_VERSIONS.includes(
        requested as typeof WORKFLOW_MCP_PROTOCOL_VERSIONS[number],
      )
        ? requested
        : WORKFLOW_MCP_PROTOCOL_VERSIONS[0];
      this.#initialized = true;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: WORKFLOW_MCP_SERVER_NAME,
            version: FRAMEWORK_VERSION,
          },
          instructions: "Workflow tools preserve canonical CLI schemas, reason codes, CAS, explicit time and actor fields. Mutations require an out-of-band pinned command grant.",
        },
      };
    }
    if (!this.#initialized) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32002, message: "Server not initialized" },
      };
    }
    if (request.method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (request.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: workflowMcpTools() },
      };
    }
    if (request.method === "tools/call") {
      try {
        const parameters = record(request.params, "tools/call params");
        return {
          jsonrpc: "2.0",
          id,
          result: await this.#callTool(
            parameters.name,
            parameters.arguments,
          ),
        };
      } catch (error) {
        return { jsonrpc: "2.0", id, result: errorResult(error) };
      }
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    };
  }
}

export async function runWorkflowMcpStdio(
  input: Readable,
  output: Writable,
  options: WorkflowMcpOptions,
): Promise<void> {
  const dispatcher = new WorkflowMcpDispatcher(options);
  let buffered = "";
  for await (const chunk of input) {
    buffered += Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk);
    if (Buffer.byteLength(buffered, "utf8") > 1_048_576) {
      fail("MCP_INPUT_OVERSIZED", "JSON-RPC line exceeds one MiB");
    }
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        output.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: String(
              (error as { message?: unknown })?.message ?? error,
            ),
          },
        })}\n`);
        continue;
      }
      let response: Readonly<Record<string, unknown>> | null;
      try {
        response = await dispatcher.dispatch(parsed);
      } catch (error) {
        response = {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "Invalid Request",
            data: {
              reasonCode: typeof (error as { reasonCode?: unknown })
                ?.reasonCode === "string"
                ? (error as { reasonCode: string }).reasonCode
                : "MCP_INVALID_REQUEST",
            },
          },
        };
      }
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    }
  }
  if (buffered.trim() !== "") {
    output.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "unterminated JSON-RPC line" },
    })}\n`);
  }
}
