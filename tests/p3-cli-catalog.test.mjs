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
    // WSG-4: persona-render, like commands, takes no flags and resolves — the Verity
    // persona is a closed allowlist, not a configuration surface.
    if (entry.name === "commands" || entry.name === "persona-render") {
      assert.equal(outcome.ok, true, `${entry.name} resolves with no flags`);
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
    // WSD-2: gate-create's --work-id is nullable ("-" for a workspace-level gate with
    // no work anchor).
    "gate-create": ["work-id"],
    "knowledge-create": ["last-verified", "project-id"],
    "profile-authorize": ["command", "project-id", "workspace-id"],
    "work-create": ["parent-id"],
  });
  // CQ-05(c2) / OD-5 option 1: the alias inventory is exactly the set of flags whose
  // dispatcher routes through nullableValue, which accepts BOTH "-" and "null". This
  // previously listed only knowledge-create, so gate-create --work-id and work-create
  // --parent-id accepted "null" without declaring it — the catalog is the machine-readable
  // discovery surface, so an accepted-but-undeclared spelling is a catalog that lies.
  // profile-authorize's three sentinel flags are NOT here: they do not use nullableValue.
  // tests/p3-cli-read-surface.test.mjs binds this inventory to the dispatcher's actual
  // behaviour, so the two can no longer drift apart silently.
  assert.deepEqual(aliasFlags, {
    "gate-create": ["work-id"],
    "knowledge-create": ["last-verified", "project-id"],
    "work-create": ["parent-id"],
  });
});

test("WSB-7/WSD-2: exactly the workspace-event mutation verbs carry headSentinel, only on expected-version", () => {
  const sentinelVerbs = [];
  for (const entry of COMMAND_CATALOG) {
    for (const flag of entry.flags) {
      if (flag.headSentinel !== undefined) {
        assert.equal(flag.headSentinel, true, `${entry.name}.${flag.name} headSentinel must be true`);
        assert.equal(flag.name, "expected-version", `${entry.name}.${flag.name} may not carry headSentinel`);
        sentinelVerbs.push(entry.name);
      }
    }
  }
  // WSD-2 adds the seven conference/gate event-log mutation verbs to the six
  // original project/work verbs; WSE-3 adds attestation-enable (the one-way
  // attestation.actor.enabled appender). Head resolves under the held lease for
  // all of them and is still rejected on knowledge-marker verbs by construction.
  assert.deepEqual([...sentinelVerbs].sort(), [
    "attestation-enable",
    "conference-append-position", "conference-cancel", "conference-close", "conference-open",
    "gate-create", "gate-delete", "gate-transition",
    "project-create", "project-delete", "project-update", "work-create", "work-delete", "work-transition",
  ]);
});

test("WSB-5: exactly the authority-gated compatibility verbs are programmatic-only; every other verb is cli", () => {
  const bySurface = {};
  for (const entry of COMMAND_CATALOG) {
    assert.ok(
      entry.availability === "cli" || entry.availability === "programmatic-only" || entry.availability === "fixture-only",
      `${entry.name} availability must be a known invocation surface`,
    );
    (bySurface[entry.availability] ??= []).push(entry.name);
  }
  for (const surface of Object.keys(bySurface)) bySurface[surface] = bySurface[surface].sort();
  // The shipped binary constructs CliIo as {write} only, so these two verbs cannot
  // obtain their required CompatibilityAdmissionAuthority and fail closed; the catalog
  // records that programmatic-only surface (WSB-5).
  assert.deepEqual(bySurface["programmatic-only"], ["compatibility-dry-run", "compatibility-plan"]);
  // OD-18: assertDisposable (artifact-lifecycle.ts) admits a store only when the marker
  // carries disposable and the Workspace external key starts with FIXTURE-, and
  // initializeArtifactStore refuses to set disposable on anything else. So these two
  // verbs can never succeed against a live Workspace -- which the spec states outright
  // ("The live local graph is therefore ineligible"). The catalog now says so too:
  // a caller planning work from it would otherwise budget for a verb that is designed
  // to fail for them.
  assert.deepEqual(bySurface["fixture-only"], ["artifact-archive-apply", "artifact-archive-restore"]);
  assert.equal(
    (bySurface["cli"]?.length ?? 0) + bySurface["programmatic-only"].length + bySurface["fixture-only"].length,
    COMMAND_CATALOG.length,
    "every catalog entry is partitioned into exactly one known surface",
  );
});
