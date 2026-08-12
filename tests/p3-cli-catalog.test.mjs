// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { COMMAND_CATALOG, assertCatalogCategoriesExclusive, runCli } from "../dist/build/packages/cli/src/index.js";

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
    // `commands` is the only zero-argument verb. Conference persona rendering
    // requires an explicit closed-roster --profile-id and must fail without it.
    if (entry.name === "commands") {
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
  // attestation.actor.enabled appender); E05 adds work-annotate (the advisory
  // scope-on-record appender). Head resolves under the held lease for all of
  // them and is still rejected on knowledge-marker verbs by construction.
  //
  // WSR-1 adds relocation-vacate and its read-only preparation relocation-plan,
  // and they are the two exceptions to this test's own title. Neither appends an
  // event: --expected-version is a compare-and-set against the chain the vacate is
  // about to seal, not a slot for an event it is about to write. The sentinel is
  // admitted because "seal this workspace at whatever its head is right now" is
  // the same question head answers everywhere else — but note that resolving
  // `head` materializes the chain in the CLI before the verb runs, so on an
  // unsettled tree the operator sees WORKSPACE_EVENT_CORRUPT rather than the
  // verb's own WORKSPACE_RELOCATION_UNSETTLED (see WSR-1 T10).
  //
  // relocation-plan carries it for one reason: it must resolve the version exactly
  // as the vacate will, or the relocationId it emits — the id the operator mints an
  // authority against — would be a prediction of a hop the engine is not about to
  // take. It is `mutates: false` and appends nothing.
  assert.deepEqual([...sentinelVerbs].sort(), [
    "attestation-enable",
    "conference-append-position", "conference-cancel", "conference-close", "conference-open",
    "gate-create", "gate-delete", "gate-transition",
    "host-config-default", "host-config-remove", "host-config-set",
    "persona-binding-remove", "persona-binding-set", "persona-remove", "persona-set",
    "project-create", "project-delete", "project-update", "relocation-plan", "relocation-vacate",
    "settings-set", "storage-home-seal", "template-admit", "work-annotate", "work-create", "work-delete", "work-transition",
  ]);
});

test("INIT-009: operator pins make every non-fixture verb binary-invocable", () => {
  const bySurface = {};
  for (const entry of COMMAND_CATALOG) {
    assert.ok(
      entry.availability === "cli" || entry.availability === "programmatic-only" || entry.availability === "fixture-only",
      `${entry.name} availability must be a known invocation surface`,
    );
    (bySurface[entry.availability] ??= []).push(entry.name);
  }
  for (const surface of Object.keys(bySurface)) bySurface[surface] = bySurface[surface].sort();
  // EPIC-022 adds the host-neutral global operator-pins channel. Compatibility
  // planning therefore no longer needs a bespoke programmatic embedder.
  assert.deepEqual(bySurface["programmatic-only"] ?? [], []);
  // OD-18: assertDisposable (artifact-lifecycle.ts) admits a store only when the marker
  // carries disposable and the Workspace external key starts with FIXTURE-, and
  // initializeArtifactStore refuses to set disposable on anything else. So these two
  // verbs can never succeed against a live Workspace -- which the spec states outright
  // ("The live local graph is therefore ineligible"). The catalog now says so too:
  // a caller planning work from it would otherwise budget for a verb that is designed
  // to fail for them.
  assert.deepEqual(bySurface["fixture-only"], ["artifact-archive-apply", "artifact-archive-restore"]);
  assert.equal(
    (bySurface["cli"]?.length ?? 0) +
      (bySurface["programmatic-only"]?.length ?? 0) +
      bySurface["fixture-only"].length,
    COMMAND_CATALOG.length,
    "every catalog entry is partitioned into exactly one known surface",
  );
});

test("INC-016: no catalog entry is both a governed write and authority-bearing output", async () => {
  // The shipped catalog already satisfies the exclusion, and the load-time assertion
  // in packages/cli/src/index.ts means an import that got this far proves it.
  assert.equal(assertCatalogCategoriesExclusive(COMMAND_CATALOG), undefined);
  for (const entry of COMMAND_CATALOG) {
    assert.equal(
      entry.mutates === true && entry.authorityBearing === true,
      false,
      `${entry.name} declares two authorization categories`,
    );
  }
  // The negative case: mcp.ts tests `mutates` FIRST, so a both-flags entry would be
  // satisfied by a writeCommands grant alone -- a write grant carrying
  // authority-bearing output, which operator-authority-mcp-v1 forbids outright.
  const both = { name: "adapter-activation-record", availability: "cli", mutates: true, authorityBearing: true, flags: [] };
  assert.throws(
    () => assertCatalogCategoriesExclusive([both]),
    (error) => error?.reasonCode === "CLI_CATALOG_CATEGORY_AMBIGUOUS",
    "CLI_CATALOG_CATEGORY_AMBIGUOUS",
  );
  // The published schema must refuse the same document, or the machine-readable
  // contract permits a state the implementation forbids.
  const schema = JSON.parse(await readFile(new URL("../schemas/cli-catalog-v1.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
  const envelope = (commands) => ({ reasonCode: "CLI_CATALOG_READY", schemaVersion: "tcrn.cli-catalog.v1", commands });
  assert.equal(validate(envelope([both])), false, "the schema must reject authorityBearing with mutates:true");
  assert.equal(validate(envelope([{ ...both, mutates: false }])), true, "authorityBearing with mutates:false stays valid");
});
