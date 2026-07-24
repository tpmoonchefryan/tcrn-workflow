#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { runWorkflowMcpStdio } from "../dist/build/packages/cli/src/mcp.js";

function argumentsFrom(argv) {
  if (argv.length === 0) return {};
  const values = {};
  for (let index = 0; index < argv.length;) {
    const token = argv[index];
    let name;
    let value;
    if (token?.startsWith("--") && token.includes("=")) {
      const equalsAt = token.indexOf("=");
      name = token.slice(2, equalsAt);
      value = token.slice(equalsAt + 1);
      index += 1;
    } else {
      const next = argv[index + 1];
      if (!token?.startsWith("--") || next === undefined || next.startsWith("--")) {
        throw new Error(`MCP_ARGUMENT_MALFORMED:${String(token)}`);
      }
      name = token.slice(2);
      value = next;
      index += 2;
    }
    if (name !== "authority-pins" && name !== "authority-pins-digest") {
      throw new Error(`MCP_ARGUMENT_UNKNOWN:${name}`);
    }
    if (Object.hasOwn(values, name)) {
      throw new Error(`MCP_ARGUMENT_DUPLICATE:${name}`);
    }
    values[name] = value;
  }
  if ((values["authority-pins"] === undefined) !==
    (values["authority-pins-digest"] === undefined)) {
    throw new Error("OPERATOR_AUTHORITY_REQUIRED:path-and-digest");
  }
  return {
    ...(values["authority-pins"] === undefined
      ? {}
      : { authorityPinsPath: values["authority-pins"] }),
    ...(values["authority-pins-digest"] === undefined
      ? {}
      : { authorityPinsDigest: values["authority-pins-digest"] }),
  };
}

try {
  await runWorkflowMcpStdio(process.stdin, process.stdout, {
    ...argumentsFrom(process.argv.slice(2)),
    clock: () => new Date().toISOString(),
  });
} catch (error) {
  const reasonCode = typeof error?.reasonCode === "string"
    ? error.reasonCode
    : "MCP_INTERNAL_ERROR";
  process.stderr.write(`${JSON.stringify({
    ok: false,
    reasonCode,
    error: String(error?.message ?? error),
  })}\n`);
  process.exitCode = 1;
}
