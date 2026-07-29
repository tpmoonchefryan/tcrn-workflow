// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import {
  acquireWorkspaceLease,
  annotateWork,
  createProject,
  createWork,
  deleteWork,
  initializeWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { PROTOCOL_LIMITS, validateEventChain } from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-cli-read-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "FIXTURE-CLI-READ", createdAt: instant(1), segmentEventLimit: 64 });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(2) });
  const ids = {};
  try {
    let v = 0;
    const at = () => instant(v + 3);
    let s = await createProject(workspace, lease, { expectedVersion: v, occurredAt: at(), externalKey: "PROJECT-A", name: "A" }); v += 1;
    ids.projectA = s.projects.find((r) => r.externalKey === "PROJECT-A").id;
    s = await createProject(workspace, lease, { expectedVersion: v, occurredAt: at(), externalKey: "PROJECT-B", name: "B" }); v += 1;
    ids.projectB = s.projects.find((r) => r.externalKey === "PROJECT-B").id;
    s = await createWork(workspace, lease, { expectedVersion: v, occurredAt: at(), projectId: ids.projectA, externalKey: "INIT-A", kind: "Initiative", parentId: null }); v += 1;
    ids.initA = s.work.find((r) => r.externalKey === "INIT-A").id;
    s = await createWork(workspace, lease, { expectedVersion: v, occurredAt: at(), projectId: ids.projectA, externalKey: "EPIC-A", kind: "Epic", parentId: ids.initA }); v += 1;
    ids.epicA = s.work.find((r) => r.externalKey === "EPIC-A").id;
    s = await createWork(workspace, lease, { expectedVersion: v, occurredAt: at(), projectId: ids.projectB, externalKey: "INIT-B", kind: "Initiative", parentId: null }); v += 1;
    ids.initB = s.work.find((r) => r.externalKey === "INIT-B").id;
    s = await createWork(workspace, lease, { expectedVersion: v, occurredAt: at(), projectId: ids.projectA, externalKey: "STORY-A", kind: "Story", parentId: ids.epicA, status: "ready" }); v += 1;
    ids.storyA = s.work.find((r) => r.externalKey === "STORY-A").id;
    s = await deleteWork(workspace, lease, { expectedVersion: v, occurredAt: at(), id: ids.storyA }); v += 1;
  } finally {
    await lease.release();
  }
  return { base, workspace, ids };
}

async function run(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function reasonOf(args) {
  return runCli(args, { write() {} }).then(() => null, (error) => error?.reasonCode);
}

// INC-027: the page-ceiling assertions are about BYTES, so they need the receipt as it
// was written, not as it survives a JSON round trip.
async function runRaw(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return output;
}

async function emptyRoots(context, prefix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  return { base, roots, workspace: join(base, "workspace") };
}

// INC-027: instants for a chain longer than one minute of the `instant` helper.
const chainInstant = (n) => new Date(Date.UTC(2026, 6, 11, 0, 0, n)).toISOString().replace(/\.\d{3}Z$/u, "Z");

// INC-027: a chain LONGER than the default page window. Without one the default is a
// constant nobody can observe, and an assertion about it could not go red.
async function longChainFixture(context, count) {
  const layout = await emptyRoots(context, "tcrn-cli-events-");
  await initializeWorkspace({ roots: layout.roots, externalKey: "FIXTURE-CLI-EVENTS", createdAt: chainInstant(1), segmentEventLimit: 64 });
  const lease = await acquireWorkspaceLease(layout.workspace, { now: chainInstant(2) });
  try {
    for (let version = 0; version < count; version += 1) {
      await createProject(layout.workspace, lease, {
        expectedVersion: version,
        occurredAt: chainInstant(version + 3),
        externalKey: `PROJECT-${String(version).padStart(3, "0")}`,
        name: `Project ${version}`,
      });
    }
  } finally {
    await lease.release();
  }
  return layout;
}

// INC-027: a chain whose EVENTS are fat, built out of re-annotations of one work item.
//
// The obvious way to fatten a chain -- many large conference positions -- cannot be used,
// and the reason is worth recording: every extension record stays in the derived state,
// and the view documents are themselves canonicalized under the same one-MiB ceiling, so
// the engine refuses to WRITE a chain whose surviving records exceed it. Re-annotating one
// record replaces the advisory value instead of accumulating records, so the chain grows
// past the ceiling while the views it materializes stay small -- which is exactly the
// shape of a long-lived governed chain, and exactly the shape `export` cannot read.
async function fatChainFixture(context, annotations) {
  const layout = await emptyRoots(context, "tcrn-cli-fat-events-");
  await initializeWorkspace({ roots: layout.roots, externalKey: "FIXTURE-CLI-FAT", createdAt: chainInstant(1), segmentEventLimit: 64 });
  const lease = await acquireWorkspaceLease(layout.workspace, { now: chainInstant(2) });
  try {
    const state = await createProject(layout.workspace, lease, { expectedVersion: 0, occurredAt: chainInstant(3), externalKey: "PROJECT-FAT", name: "Fat" });
    const projectId = state.projects[0].id;
    const created = await createWork(layout.workspace, lease, { expectedVersion: 1, occurredAt: chainInstant(4), projectId, externalKey: "INIT-FAT", kind: "Initiative", parentId: null });
    const workId = created.work[0].id;
    for (let index = 0; index < annotations; index += 1) {
      await annotateWork(layout.workspace, lease, {
        expectedVersion: 2 + index,
        occurredAt: chainInstant(5 + index),
        id: workId,
        // Distinct each time: an annotation that changes nothing is refused, and the
        // whole point is that each event carries its own copy of the fat value.
        scope: `scope ${index} ${"x".repeat(8_000)}`,
      });
    }
  } finally {
    await lease.release();
  }
  return layout;
}

test("project-list is deterministic, tombstone-free, and budgeted", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  const all = await run(["project-list", ...ws]);
  assert.equal(all.reasonCode, "WORKSPACE_LIST_READY");
  assert.equal(all.kind, "project");
  assert.equal(all.total, 2);
  assert.deepEqual(all.records.map((r) => r.id), [fx.ids.projectA, fx.ids.projectB].sort());
  const page = await run(["project-list", ...ws, "--limit", "1", "--offset", "1"]);
  assert.equal(page.total, 2);
  assert.equal(page.records.length, 1);
  assert.equal(page.truncated, false);
  const first = await run(["project-list", ...ws, "--limit", "1"]);
  assert.equal(first.truncated, true);
});

test("work-list filters conjunctively, excludes tombstones, and is byte-stable", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  const all = await run(["work-list", ...ws]);
  // STORY-A was deleted; INIT-A, EPIC-A, INIT-B remain
  assert.equal(all.total, 3);
  assert.equal(all.records.some((r) => r.id === fx.ids.storyA), false);
  const roots = await run(["work-list", ...ws, "--parent-id", "-"]);
  assert.deepEqual(roots.records.map((r) => r.id).sort(), [fx.ids.initA, fx.ids.initB].sort());
  const byProject = await run(["work-list", ...ws, "--project-id", fx.ids.projectB]);
  assert.deepEqual(byProject.records.map((r) => r.id), [fx.ids.initB]);
  const byKind = await run(["work-list", ...ws, "--kind", "Epic"]);
  assert.deepEqual(byKind.records.map((r) => r.id), [fx.ids.epicA]);
  const conjunctive = await run(["work-list", ...ws, "--project-id", fx.ids.projectA, "--kind", "Initiative"]);
  assert.deepEqual(conjunctive.records.map((r) => r.id), [fx.ids.initA]);
  // byte-identical repeat
  let a = ""; await runCli(["work-list", ...ws], { write: (v) => { a += v; } });
  let b = ""; await runCli(["work-list", ...ws], { write: (v) => { b += v; } });
  assert.equal(a, b);
});

test("work-show returns one record and fails closed on unknown ids and malformed filters", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  const shown = await run(["work-show", ...ws, "--id", fx.ids.epicA]);
  assert.equal(shown.reasonCode, "WORKSPACE_RECORD_READY");
  assert.equal(shown.record.id, fx.ids.epicA);
  assert.equal(shown.record.kind, "Epic");
  assert.equal(await reasonOf(["work-show", ...ws, "--id", "work:deadbeefdeadbeefdeadbeef"]), "WORKSPACE_INPUT_INVALID");
  assert.equal(await reasonOf(["work-show", ...ws, "--id", fx.ids.storyA]), "WORKSPACE_INPUT_INVALID");
  assert.equal(await reasonOf(["work-list", ...ws, "--kind", "Bogus"]), "CLI_ARGUMENT_MALFORMED");
  assert.equal(await reasonOf(["work-list", ...ws, "--status", "bogus"]), "CLI_ARGUMENT_MALFORMED");
  assert.equal(await reasonOf(["work-list", ...ws, "--limit", "0"]), "CLI_ARGUMENT_MALFORMED");
  assert.equal(await reasonOf(["project-list", ...ws, "--offset", "-1"]), "CLI_ARGUMENT_MALFORMED");
});

test("read verbs and validate fail closed on stale views, but status reads authority", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  await writeFile(join(fx.workspace, ".tcrn-workflow", "views", "index.json"), "{}\n");
  assert.equal(await reasonOf(["work-list", ...ws]), "WORKSPACE_VIEW_STALE");
  assert.equal(await reasonOf(["project-list", ...ws]), "WORKSPACE_VIEW_STALE");
  assert.equal(await reasonOf(["work-show", ...ws, "--id", fx.ids.epicA]), "WORKSPACE_VIEW_STALE");
  assert.equal(await reasonOf(["validate", ...ws]), "WORKSPACE_VIEW_STALE");
  // WSA-3 / SDC-10: status is authority-only and must survive stale views
  const status = await run(["status", ...ws]);
  assert.equal(status.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(status.version, 7);
});

// CQ-05(c2) proof. Before this guard the round trip was BROKEN, not merely inconsistent:
// work-create routed --parent-id through nullableValue (which accepts "-" and the
// deprecated alias "null"), while the work-list filter compared with a bare === "-" and
// so treated "null" as a literal parent id. An agent could create a root work item with
// --parent-id null and then get total=0 back for the identical spelling — a silent wrong
// answer. Reverting the filter to === "-" turns the "null" assertions below red.
test("CQ-05(c2): the null sentinel round-trips through work-create and work-list for every accepted spelling", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  const created = await run(["work-create", ...ws, "--expected-version", "7", "--at", instant(30),
    "--project-id", fx.ids.projectA, "--external-key", "ROOT-VIA-NULL", "--kind", "Initiative", "--parent-id", "null"]);
  assert.equal(created.record.parentId, null, "the deprecated alias must be stored as null, not as a literal id");
  const rootId = created.record.id;

  // The writer accepted "null"; the reader must find it back under that same spelling.
  const viaNull = await run(["work-list", ...ws, "--parent-id", "null"]);
  assert.ok(viaNull.records.some((r) => r.id === rootId), "--parent-id null must find the record --parent-id null created");
  assert.equal(viaNull.records.some((r) => r.id === fx.ids.epicA), false, "the null filter must not admit parented work");

  // Canonical spelling must return the identical set — the two spellings are aliases,
  // so any divergence between them is itself the defect.
  const viaDash = await run(["work-list", ...ws, "--parent-id", "-"]);
  assert.deepEqual(viaNull.records.map((r) => r.id).sort(), viaDash.records.map((r) => r.id).sort());
  assert.deepEqual(viaDash.records.map((r) => r.id).sort(), [fx.ids.initA, fx.ids.initB, rootId].sort());

  // A real id must still be matched literally, so the alias handling cannot have
  // collapsed into "treat every value as null".
  const viaParent = await run(["work-list", ...ws, "--parent-id", fx.ids.initA]);
  assert.deepEqual(viaParent.records.map((r) => r.id), [fx.ids.epicA]);
});

// CQ-05(c2) contract half: the catalog is the machine-readable discovery surface, so a
// spelling the dispatcher accepts but the catalog does not declare is a catalog that
// lies. These are exactly the flags routed through nullableValue.
test("CQ-05(c2): every nullableValue flag declares its sentinel and its deprecated alias", () => {
  const flagOf = (verb, flag) => COMMAND_CATALOG.find((entry) => entry.name === verb)?.flags.find((f) => f.name === flag);
  for (const [verb, flag] of [["knowledge-create", "project-id"], ["knowledge-create", "last-verified"],
    ["work-create", "parent-id"], ["gate-create", "work-id"]]) {
    const declared = flagOf(verb, flag);
    assert.ok(declared, `${verb} must declare the flag ${flag}`);
    assert.equal(declared.nullSentinel, "-", `${verb}.${flag} must declare the canonical null sentinel`);
    assert.deepEqual([...(declared.deprecatedAliases ?? [])], ["null"], `${verb}.${flag} must declare the "null" alias its dispatcher accepts`);
  }
});

// CQ-05(c) proof for integerValue. Each of these used to reach core as NaN and come back
// under a SEMANTIC reason code that misdescribed a syntax error — most starkly
// `migration-plan --target-version abc` answering WORKSPACE_MIGRATION_DOWNGRADE "NaN".
// Removing integerValue (restoring the bare Number(...) calls) turns these red.
test("CQ-05(c): malformed integer flags fail at the CLI boundary naming the flag", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  const malformed = async (args, flag) => {
    const error = await runCli(args, { write() {} }).then(() => null, (caught) => caught);
    assert.ok(error, `${flag} must fail closed`);
    assert.equal(error.reasonCode, "CLI_ARGUMENT_MALFORMED");
    assert.equal(error.message.includes(flag), true, `the failure must name ${flag}, got ${error.message}`);
    return error;
  };
  await malformed(["migration-plan", ...ws, "--target-version", "abc", "--dry-run", "true"], "target-version");
  await malformed(["migration-plan", ...ws, "--target-version", "2.5", "--dry-run", "true"], "target-version");
  await malformed(["knowledge-promote", ...ws, "--expected-version", "7", "--expected-revision", "abc",
    "--at", instant(31), "--id", "knowledge:0000000000000000000000000000000000000000", "--state", "promoted"], "expected-revision");

  // The minimum is deliberately unbounded below: 0 and negatives are LEGITIMATE downgrade
  // requests that core must still judge. A positive minimum here would pre-empt the very
  // judgement this patch exists to protect, so assert the flag reaches core untouched.
  for (const target of ["0", "-1"]) {
    const reason = await reasonOf(["migration-plan", ...ws, "--target-version", target, "--dry-run", "true"]);
    assert.equal(reason, "WORKSPACE_MIGRATION_DOWNGRADE", `--target-version ${target} must still be judged by core`);
  }
});

// R2-NEW-7 proof: within one verb, `limit` used a truthy guard and `offset` used
// `!== undefined`, so the two flags disagreed about the empty string — `--limit=` was
// silently dropped and the command answered as if no limit had been asked for, while
// `--offset=` was passed through. Restoring the truthy guard turns the limit case red.
test("R2-NEW-7: empty-string integer flags are rejected, not silently dropped", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace, "--at", instant(32)];
  for (const verb of ["knowledge-list", "knowledge-candidates"]) {
    // Baseline: with the flag omitted the verb gets past pagination entirely and fails
    // later, on the absent knowledge store. "Silently dropped" means indistinguishable
    // from this, which is precisely what the truthy guard did to --limit=.
    const omitted = await reasonOf([verb, ...ws]);
    assert.equal(omitted, "KNOWLEDGE_PATH_INVALID");

    for (const flag of ["limit", "offset"]) {
      // The empty string is a SUPPLIED value, so it must be handed to core verbatim and
      // behave exactly like the explicit "0" it parses to — the same rule offset already
      // followed and limit did not. Equality against the explicit-zero run is the whole
      // point: it is what makes the two flags agree.
      const empty = await reasonOf([verb, ...ws, `--${flag}=`]);
      const zero = await reasonOf([verb, ...ws, `--${flag}`, "0"]);
      assert.equal(empty, zero, `${verb} --${flag}= must behave as the supplied value 0`);
    }

    // Direction check: limit=0 is refused by core, so an empty --limit must NOT look like
    // an omitted --limit. This is the assertion the truthy guard reddens.
    assert.equal(await reasonOf([verb, ...ws, "--limit="]), "KNOWLEDGE_INPUT_INVALID");
    assert.notEqual(await reasonOf([verb, ...ws, "--limit="]), omitted);
  }
});

// CQ-05(c): the knowledge verbs were the last two pagination sites still handing a bare
// Number() to core, so `--limit abc` arrived as NaN and came back as
// KNOWLEDGE_INPUT_INVALID "limit" — core answering a range question that was never asked,
// about a value that is not a number. The sibling project-list/work-list flags of the same
// name and the same catalog valueKind answered CLI_ARGUMENT_MALFORMED. Restoring either
// bare Number() turns this red.
test("CQ-05: malformed knowledge pagination flags are syntax errors, not range refusals", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace, "--at", instant(33)];
  for (const verb of ["knowledge-list", "knowledge-candidates"]) {
    for (const flag of ["limit", "offset"]) {
      for (const value of ["abc", "2.5", "1e400"]) {
        const reason = await reasonOf([verb, ...ws, `--${flag}`, value]);
        assert.equal(reason, "CLI_ARGUMENT_MALFORMED", `${verb} --${flag} ${value} is malformed syntax`);
      }
    }
  }

  // The other half of the contract, and the reason no minimum is passed at the CLI: every
  // value that IS an integer must still reach core, so core keeps the whole window rule
  // (>= 1, <= maximumRecords, offset >= 0) rather than half of it. A CLI-side floor would
  // silently take the lower bound and leave the ceiling behind.
  for (const [flag, value] of [["limit", "0"], ["offset", "-1"], ["limit", "1000000"]]) {
    const reason = await reasonOf(["knowledge-list", ...ws, `--${flag}`, value]);
    assert.equal(reason, "KNOWLEDGE_INPUT_INVALID", `--${flag} ${value} stays core's judgement`);
  }
});

// The same defect on the init path. The plan dropped --segment-events after probing "abc",
// "0", "-3", "2.5" and "1e400" and finding core guarded all of them — but it never probed
// the EMPTY string, and the truthy guard dropped that one on the floor, initializing the
// workspace as if no segment limit had been supplied at all.
test("CQ-05: an empty --segment-events is a supplied value, not an omitted flag", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-cli-init-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  // Every init needs its own untouched roots, so each probe gets a numbered set.
  let generation = 0;
  const initArguments = async (...extra) => {
    const home = join(base, `gen-${generation += 1}`);
    const flags = [];
    for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
      const path = join(home, kind);
      await mkdir(path, { recursive: true });
      flags.push(`--${kind}`, path);
    }
    return ["init", ...flags, "--external-key", "SEGMENT-PROBE", "--at", instant(34), ...extra];
  };

  // Omitted: initialization succeeds under the default segment limit. reasonOf answers
  // null on success, and that null is the baseline the empty string must NOT match.
  assert.equal(await reasonOf(await initArguments()), null);
  // Supplied-but-empty parses to 0, which core refuses exactly as it refuses an explicit 0.
  const empty = await reasonOf(await initArguments("--segment-events="));
  assert.equal(empty, await reasonOf(await initArguments("--segment-events", "0")));
  assert.notEqual(empty, null, "--segment-events= must not initialize as if omitted");
  // And a value that is not an integer is now named as such instead of reaching core.
  assert.equal(await reasonOf(await initArguments("--segment-events", "abc")), "CLI_ARGUMENT_MALFORMED");
});

test("WSB-6: the agent-integration reference stays in drift-guarded agreement with the catalog", async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const docText = await readFile(join(repoRoot, "docs/architecture/agent-integration-v1.md"), "utf8");

  // The three retry reason codes with undocumented semantics that motivated the
  // doc must each appear (relaxed to at-least-once per the verifier correction,
  // since the error-envelope and retry-table sections both name CAS_MISMATCH).
  for (const code of ["WORKSPACE_VIEW_STALE", "WORKSPACE_LOCKED", "WORKSPACE_CAS_MISMATCH"]) {
    assert.ok(docText.includes(code), `retry table must name ${code}`);
  }

  // Bidirectional drift guard: the doc's enumerated programmatic-only block must
  // equal exactly the live COMMAND_CATALOG programmatic-only surface.
  const liveProgrammaticOnly = COMMAND_CATALOG.filter((entry) => entry.availability === "programmatic-only")
    .map((entry) => entry.name)
    .sort();
  const block = docText.match(/```\nprogrammatic-only\n([\s\S]*?)```/);
  assert.ok(block, "doc must carry a fenced programmatic-only enumeration block");
  const documented = block[1].trim().split("\n").map((line) => line.trim()).filter(Boolean).sort();
  assert.deepEqual(documented, liveProgrammaticOnly);

  // Coverage direction restated verb-by-verb so a newly programmatic-only verb
  // that slips the block still fails loudly.
  for (const name of liveProgrammaticOnly) {
    assert.ok(docText.includes(name), `doc must mention programmatic-only verb ${name}`);
  }
});

// INC-027 (TCRN-CROSS-INC-027). `export` was the only read that returned events, and it
// refuses any workspace whose canonical form exceeds one MiB -- which three of the four
// chains on this platform already do. So the one thing a downstream mirror needs in order
// to reproduce a chain was unreachable exactly on the chains worth mirroring. These three
// tests bind the three properties that make the paged replacement usable: the pages
// concatenate to the chain, a page that cannot fit is refused rather than shortened, and
// the default window never stands in for a value the caller supplied.
test("INC-027: event-list pages the chain and the concatenation IS the chain", async (context) => {
  const fx = await longChainFixture(context, 70);
  const ws = ["--workspace", fx.workspace];

  // The default window is the engine's own segment size, and it is only observable on a
  // chain longer than it -- which is why the fixture writes 70 events for a default of 64.
  const first = await run(["event-list", ...ws]);
  assert.equal(first.reasonCode, "WORKSPACE_LIST_READY");
  assert.equal(first.kind, "event");
  assert.equal(first.total, 70);
  assert.equal(first.records.length, 64, "the default window is the engine's segment size");
  assert.equal(first.truncated, true);

  // Records are verbatim EventRecords, not a summary. A consumer that re-derives the
  // chain must hash exactly the bytes the engine hashed, so all three hashes and the
  // payload have to travel; a projection would break re-derivation by definition.
  assert.deepEqual(
    Object.keys(first.records[0]).sort(),
    ["eventHash", "id", "occurredAt", "payload", "payloadHash", "priorHash", "schemaVersion", "sequence", "streamId"],
  );

  const status = await run(["status", ...ws]);
  assert.equal(first.version, status.version);
  assert.equal(first.headEventHash, status.headEventHash);

  // Page to exhaustion at a window that does not divide the total, so an off-by-one in
  // the offset arithmetic drops or repeats an event instead of landing exactly.
  const events = [];
  let offset = 0;
  for (;;) {
    const raw = await runRaw(["event-list", ...ws, "--limit", "7", "--offset", String(offset)]);
    assert.ok(Buffer.byteLength(raw, "utf8") <= PROTOCOL_LIMITS.maxCanonicalBytes, "every page fits the canonical ceiling");
    const page = JSON.parse(raw);
    events.push(...page.records);
    if (!page.truncated) break;
    offset += page.records.length;
  }
  assert.equal(events.length, status.version, "one event per version, none dropped and none repeated");
  assert.deepEqual(events.map((entry) => entry.sequence), events.map((_, index) => index + 1));
  assert.equal(validateEventChain(events).length, events.length, "the concatenation revalidates as a chain");
  assert.equal(events.at(-1).eventHash, status.headEventHash, "the last page ends at the head the authority reports");
});

// The refusal is the whole reason paging exists here. A page silently shortened to fit
// would be indistinguishable from the end of the chain -- the same "limit expressed as
// absence" that INC-004/INC-005 were filed for, reintroduced one layer down.
test("INC-027: a page that cannot fit is refused under its own code, never shortened", async (context) => {
  const fx = await fatChainFixture(context, 140);
  const ws = ["--workspace", fx.workspace];

  // The precondition: this chain is exactly the kind `export` refuses whole. Without this
  // assertion the rest of the test would still pass on a chain small enough not to matter.
  assert.equal(await reasonOf(["export", ...ws]), "INPUT_OVERSIZED");

  // A caller may raise the window, and then the ceiling is theirs to hit.
  const error = await runCli(["event-list", ...ws, "--limit", "200"], { write() {} }).then(() => null, (caught) => caught);
  assert.ok(error, "an over-ceiling page must fail closed");
  // Deliberately NOT export's INPUT_OVERSIZED. That code says "this chain cannot be read
  // this way" and leaves the caller nowhere to go; this one says "this page cannot" and
  // names the flag that fixes it.
  assert.equal(error.reasonCode, "CLI_EVENT_PAGE_OVERSIZED");
  assert.notEqual(error.reasonCode, "INPUT_OVERSIZED");
  assert.equal(error.message.includes("--limit"), true, `the refusal must name the remedy, got ${error.message}`);

  // The default window on the same chain succeeds, which is what makes the refusal a
  // property of the page rather than a verdict on the chain -- and is the reason the
  // default is conservative rather than "as many as the caller asked for".
  const defaulted = await runRaw(["event-list", ...ws]);
  assert.ok(Buffer.byteLength(defaulted, "utf8") <= PROTOCOL_LIMITS.maxCanonicalBytes);
  assert.equal(JSON.parse(defaulted).records.length, 64);
  assert.equal(JSON.parse(defaulted).truncated, true);

  // And the whole chain still reads, one window at a time.
  const events = [];
  let offset = 0;
  for (;;) {
    const raw = await runRaw(["event-list", ...ws, "--offset", String(offset)]);
    assert.ok(Buffer.byteLength(raw, "utf8") <= PROTOCOL_LIMITS.maxCanonicalBytes);
    const page = JSON.parse(raw);
    events.push(...page.records);
    if (!page.truncated) break;
    offset += page.records.length;
  }
  const status = await run(["status", ...ws]);
  assert.equal(events.length, status.version);
  assert.equal(validateEventChain(events).length, events.length);
});

test("INC-027: the default window never stands in for a supplied one, and event-list obeys the view gate", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];

  const all = await run(["event-list", ...ws]);
  assert.equal(all.total, 7);
  assert.equal(all.records.length, 7);
  assert.equal(all.truncated, false);

  // A supplied value is judged, not replaced. `--limit=` is the case that matters: it is
  // a supplied empty string, and substituting the default for it would answer a question
  // the caller did not ask -- the exact defect R2-NEW-7 records one verb over.
  for (const spelling of ["--limit=", "--limit=0", "--limit=abc", "--limit=2.5", "--offset=-1", "--offset=2.5"]) {
    assert.equal(await reasonOf(["event-list", ...ws, spelling]), "CLI_ARGUMENT_MALFORMED", `${spelling} must be judged`);
  }

  // An offset past the end is an empty page that still reports the total, not an error
  // and not a claim that the chain is empty.
  const past = await run(["event-list", ...ws, "--offset", "99"]);
  assert.deepEqual(past.records, []);
  assert.equal(past.total, 7);
  assert.equal(past.truncated, false);

  // Byte-stable like its siblings.
  assert.equal(await runRaw(["event-list", ...ws]), await runRaw(["event-list", ...ws]));

  // WSA-3: a read verb answers from view-verified state, so a stale view refuses.
  await writeFile(join(fx.workspace, ".tcrn-workflow", "views", "index.json"), "{}\n");
  assert.equal(await reasonOf(["event-list", ...ws]), "WORKSPACE_VIEW_STALE");
});
