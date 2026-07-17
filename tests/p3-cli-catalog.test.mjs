// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";

async function invoke(args) {
  let output = "";
  const outcome = await runCli(args, { write: (value) => { output += value; } }).then(
    () => ({ ok: true, output }),
    (error) => ({ ok: false, reasonCode: error?.reasonCode }),
  );
  return outcome;
}

test("commands emits schema-valid, deterministic catalog JSON", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/cli-catalog-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  let a = "";
  await runCli(["commands"], { write: (value) => { a += value; } });
  let b = "";
  await runCli(["commands"], { write: (value) => { b += value; } });
  assert.equal(a, b, "commands output must be byte-identical across invocations");
  const parsed = JSON.parse(a);
  assert.equal(validate(parsed), true, JSON.stringify(validate.errors));
  assert.equal(parsed.reasonCode, "CLI_CATALOG_READY");
  // canonical order: names ascending
  const names = parsed.commands.map((entry) => entry.name);
  assert.deepEqual(names, [...names].sort());
});

test("catalog and dispatcher are in two-way name parity", async () => {
  const source = await readFile(new URL("../packages/cli/src/index.js", new URL("../dist/build/packages/cli/", import.meta.url)), "utf8").catch(() => null)
    ?? await readFile(new URL("../packages/cli/src/index.ts", import.meta.url), "utf8");
  const dispatched = new Set();
  for (const match of source.matchAll(/command === "([a-z0-9-]+)"/gu)) {
    if (match[1] !== "-") dispatched.add(match[1]);
  }
  const cataloged = new Set(COMMAND_CATALOG.map((entry) => entry.name));
  const missingFromCatalog = [...dispatched].filter((name) => !cataloged.has(name)).sort();
  const missingFromDispatch = [...cataloged].filter((name) => !dispatched.has(name)).sort();
  assert.deepEqual(missingFromCatalog, [], "every dispatched verb must have a catalog entry (SDC-1)");
  assert.deepEqual(missingFromDispatch, [], "every catalog entry must dispatch");
});

test("unknown verbs fail closed and every cataloged verb dispatches", async () => {
  assert.equal((await invoke(["no-such-verb"])).reasonCode, "CLI_COMMAND_UNKNOWN");
  for (const entry of COMMAND_CATALOG) {
    const outcome = await invoke([entry.name]);
    if (entry.name === "commands") {
      assert.equal(outcome.ok, true, "commands resolves with no flags");
      continue;
    }
    assert.equal(outcome.ok, false, `${entry.name} should reject with no flags`);
    assert.notEqual(outcome.reasonCode, "CLI_COMMAND_UNKNOWN", `${entry.name} must dispatch`);
  }
});

test("required flags in the catalog match the dispatcher's missing-argument failure", async () => {
  for (const entry of COMMAND_CATALOG) {
    const requiredFlags = entry.flags.filter((flag) => flag.required).map((flag) => flag.name);
    if (requiredFlags.length === 0) continue;
    const outcome = await invoke([entry.name]);
    assert.equal(outcome.reasonCode, "CLI_ARGUMENT_MISSING", `${entry.name} with no flags must report missing arguments`);
  }
});

test("WSB-4: exactly the nullable flags carry the '-' sentinel, and only knowledge-create flags carry the 'null' alias", () => {
  const sentinelFlags = {};
  const aliasFlags = {};
  for (const entry of COMMAND_CATALOG) {
    for (const flag of entry.flags) {
      if (flag.nullSentinel !== undefined) {
        assert.equal(flag.nullSentinel, "-", `${entry.name}.${flag.name} null sentinel must be "-"`);
        (sentinelFlags[entry.name] ??= []).push(flag.name);
      }
      if (flag.deprecatedAliases !== undefined) {
        assert.deepEqual([...flag.deprecatedAliases], ["null"], `${entry.name}.${flag.name} deprecated alias set`);
        (aliasFlags[entry.name] ??= []).push(flag.name);
      }
    }
  }
  for (const record of [sentinelFlags, aliasFlags]) {
    for (const name of Object.keys(record)) record[name] = record[name].sort();
  }
  assert.deepEqual(sentinelFlags, {
    "knowledge-create": ["last-verified", "project-id"],
    "profile-authorize": ["command", "project-id", "workspace-id"],
    "work-create": ["parent-id"],
  });
  assert.deepEqual(aliasFlags, { "knowledge-create": ["last-verified", "project-id"] });
});
