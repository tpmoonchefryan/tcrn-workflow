// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-275: MCP stdio surface is removed; product contains no code for or selection of it.
// Owner ruling 2026-09-04: The retired MCP stdio surface does not exist in this product. Tests assert
// its absence and would fail if it were reintroduced accidentally.
// Reference: TCRN-CROSS-INC-275 removed packages/mcp, tests/inc255-mcp-framing.test.mjs, and related MCP test assertions.

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";

import { COMMAND_CATALOG } from "../dist/build/packages/cli/src/index.js";

test("MCP package and implementation are absent", async () => {
  // TCRN-CROSS-INC-275: All MCP stdio surface code removed from product.
  // These assertions catch accidental reintroduction of mcp package or its build artifacts.
  const fileNotFound = async (url) => {
    try {
      await access(url, constants.F_OK);
      throw new Error(`Expected ${url} to not exist, but it does`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };

  // Core MCP implementation must not exist
  await fileNotFound(new URL("../packages/mcp/src/index.ts", import.meta.url));
  await fileNotFound(new URL("../packages/mcp/package.json", import.meta.url));
});

test("CLI catalog contains no MCP surface verb", async () => {
  // TCRN-CROSS-INC-275: Verify MCP is not selectable at runtime through the command catalog.
  // This test would fail if an MCP verb were added back to the command dispatcher.
  const mcpVerbs = COMMAND_CATALOG
    .filter((entry) => /mcp/i.test(entry.name))
    .map((entry) => entry.name);
  assert.deepEqual(mcpVerbs, [], "CLI catalog must contain no MCP surface verbs");
});

test("package.json bin field declares no MCP entry", async () => {
  // TCRN-CROSS-INC-275: Verify the shipped binary offers no MCP surface.
  // This test would fail if a tcrn-workflow-mcp executable entry were added to bin.
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const binKeys = Object.keys(pkg.bin || {});
  const mcpBinEntries = binKeys.filter((key) => /mcp/i.test(key));
  assert.deepEqual(mcpBinEntries, [], "package.json bin field must not declare any MCP entries");
});
