// SPDX-License-Identifier: Apache-2.0
//
// STORY-300 slice 1. The command catalog is the only authority on what exists, and
// two of its promises had nothing behind them.
//
// The first is the head sentinel. The catalog declares which verbs accept
// `--expected-version head`, and until now nothing checked that a declaring verb's
// handler actually does. It did not: `storage-home-seal` declared the modifier and
// resolved the flag through a numeric-only path, so the declaration was a promise
// to callers that the binary refused to keep.
//
// The check is behavioural on purpose. A source scan -- "this verb's branch must
// call the resolver" -- reads as the obvious implementation and is not: several
// verbs share one merged dispatcher branch, so the scan has to grow a parser for
// the dispatcher's shape, and a check that needs a special case per dispatcher
// layout is a check that will be wrong the next time the layout moves. Calling the
// verb and looking at what comes back asks the handler itself.
//
// The second is discoverability. The catalog has always carried each flag's name,
// required flag and value kind; there was simply no way to ask for one verb's entry
// without either dumping all 130 or reading the source. `--help` was refused 35
// times in this chain's history, which is the most expensive single refusal in it.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeWorkspace } from "../dist/build/packages/core/src/index.js";

function instant(offset) {
  return `2026-01-01T00:00:${String(offset).padStart(2, "0")}Z`;
}

async function workspaceFixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s300-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: "WORKSPACE-S300", createdAt: instant(0), segmentEventLimit: 64 });
  return join(base, "workspace");
}

async function capture(argv) {
  const chunks = [];
  try {
    await runCli(argv, { write(value) { chunks.push(value); } });
    return { ok: true, output: chunks.join("") };
  } catch (error) {
    return { ok: false, reasonCode: error?.reasonCode, message: String(error?.message ?? error), output: chunks.join("") };
  }
}

function placeholder(flag) {
  switch (flag.valueKind) {
    case "instant": return "2026-01-01T00:00:01Z";
    case "integer": return "1";
    case "json": return "{}";
    default: return "x";
  }
}

// storage-home-seal is checked by name rather than by behaviour, and the reason is
// worth stating because "we tested it by name" is usually an excuse.
//
// Its handler resolves the flag through the numeric-only path and then compares the
// result against a freshly validated version by hand, so `head` would not merely be
// unsupported there -- it would make that comparison true by construction, which is
// the tautological-gate shape this platform has paid for more than once. It also
// refuses on a missing schema and then on an absent Postgres environment before the
// flag is ever resolved, so no local run can reach the question. A declaration that
// nothing can check is a promise to callers with nothing behind it: the fix is to
// stop declaring it, and this assertion is what keeps it from coming back.
const HANDLER_CANNOT_ACCEPT_SENTINEL = ["storage-home-seal"];

// Two probes, not one, and the second probe is the reason this test is worth having.
//
// The obvious version of this check -- call the verb with `head` and assert it is not
// refused for expected-version -- passes for a verb that never reaches its version
// parsing at all. It passed for `storage-home-seal` on the first run here: that verb
// refuses on a missing schema, and then on an absent Postgres environment, both
// before the flag is resolved. A green from a verb that was never asked the question
// is the failure shape this platform has paid for repeatedly, so the test proves
// reachability first.
//
// Probe A sends a value that must be rejected. A verb that reaches version parsing
// refuses it, naming the flag; a verb that does not reach it refuses something else,
// and is reported as unprovable rather than counted as proven. Probe B then sends the
// sentinel and requires that same refusal to be absent.
//
// Red legs, both observed: restore `headSentinel: true` on `storage-home-seal` and it
// reappears under `unprovable`, because no local environment can drive it past its
// Postgres precondition. Point any declaring verb's handler at the numeric-only
// resolver and it appears under `refused`.
test("STORY-300: every verb that declares the head sentinel is reached by, and accepts, the sentinel", async (context) => {
  const workspace = await workspaceFixture(context);
  const declaring = COMMAND_CATALOG.filter((entry) =>
    entry.flags.some((flag) => flag.name === "expected-version" && flag.headSentinel === true));
  assert.ok(declaring.length > 0, "the catalog must declare the sentinel somewhere for this test to mean anything");

  const call = (entry, version) => capture([
    entry.name,
    ...entry.flags.flatMap((flag) => {
      if (flag.name === "expected-version") return ["--expected-version", version];
      if (flag.name === "workspace") return ["--workspace", workspace];
      if (!flag.required) return [];
      return [`--${flag.name}`, placeholder(flag)];
    }),
  ]);

  // Same arguments, two versions: a deliberately wrong number, and the sentinel.
  //
  // The negative check is that the sentinel is never refused as a malformed
  // expected-version -- that is what a numeric-only handler does with it.
  //
  // The positive one is better evidence and needs no valid arguments: a wrong number
  // makes a handler that reached its CAS comparison say so, and the sentinel resolves
  // to the version that is actually there, so the same call must NOT reach that
  // refusal. A verb that answers WORKSPACE_CAS_MISMATCH to `0` and something else to
  // `head` has demonstrably resolved the sentinel, whatever it objects to afterwards.
  const refusedFlag = [];
  const unresolved = [];
  for (const entry of declaring) {
    const numeric = await call(entry, "0");
    const sentinel = await call(entry, "head");
    if (sentinel.ok === false && sentinel.reasonCode === "CLI_ARGUMENT_MALFORMED" && /expected-version/u.test(sentinel.message)) {
      refusedFlag.push(entry.name);
      continue;
    }
    if (numeric.ok === false && numeric.reasonCode === "WORKSPACE_CAS_MISMATCH"
      && sentinel.ok === false && sentinel.reasonCode === "WORKSPACE_CAS_MISMATCH") {
      unresolved.push(entry.name);
    }
  }
  assert.deepEqual(refusedFlag, [], `these verbs declare --expected-version head and their handlers refuse the flag: ${refusedFlag.join(", ")}`);
  assert.deepEqual(unresolved, [], `these verbs reached their CAS comparison and still mismatched on the sentinel, so it was not resolved to the live version: ${unresolved.join(", ")}`);

  for (const name of HANDLER_CANNOT_ACCEPT_SENTINEL) {
    assert.equal(
      declaring.some((entry) => entry.name === name), false,
      `${name} declares --expected-version head, and its handler resolves the flag numerically before a hand-rolled comparison that the sentinel would make true by construction`,
    );
  }
});

// Red leg: remove the `--help` branch and this returns the verb's ordinary refusal
// (or, for a verb with no required flags, runs it) instead of its catalog entry.
test("STORY-300: --help returns the verb's own argument surface without reading engine source", async () => {
  for (const name of ["work-create", "conference-open", "status"]) {
    const result = await capture([name, "--help"]);
    assert.equal(result.ok, true, `${name} --help must not refuse: ${result.reasonCode ?? ""} ${result.message ?? ""}`);
    const payload = JSON.parse(result.output);
    assert.equal(payload.reasonCode, "CLI_CATALOG_READY", "help reuses the catalog reason code rather than minting one");
    assert.equal(payload.commands.length, 1, "help answers about the verb that was asked for, not all of them");
    const entry = payload.commands[0];
    assert.equal(entry.name, name);
    // The whole point: a caller can build a valid invocation from this alone.
    for (const flag of entry.flags) {
      assert.equal(typeof flag.name, "string");
      assert.equal(typeof flag.required, "boolean");
      assert.equal(typeof flag.valueKind, "string");
    }
  }
  // An unknown verb keeps its existing refusal rather than answering emptily.
  const unknown = await capture(["not-a-verb", "--help"]);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reasonCode, "CLI_COMMAND_UNKNOWN");
});
