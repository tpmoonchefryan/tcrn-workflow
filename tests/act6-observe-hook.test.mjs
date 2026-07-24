// SPDX-License-Identifier: Apache-2.0
//
// INIT-009 EPIC-024 S069-S071: the observe hook handler.
//
// These cases RUN the generated handler as a real child process against a real
// directory. A handler that is only read cannot be shown to exit 0 on a broken
// input, and exiting 0 on every path is the property MIN-046 relies on: an observe
// hook may lose a receipt, but it may never break the user's session.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OBSERVE_HOOK_EVENTS,
  OBSERVE_HANDLER_PATH,
  OBSERVE_LOG_PATH,
  appendReceipt,
  generateObserveHookHandler,
  observeHookHandlerDigest,
  openReceiptBatch,
  parseObserveLog,
  sealReceiptBatch,
  validateReceiptBatch,
} from "../dist/build/packages/core/src/index.js";

const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/act6-observe-hook-cases.json", import.meta.url), "utf8"));

function reason(code, operation) { assert.throws(operation, (error) => error?.reasonCode === code, code); }

const MANIFEST = JSON.stringify({ schemaVersion: "tcrn.claude-adapter-project-template.v1", workspaceId: "workspace:w1" }) + "\n";
const MANIFEST_DIGEST = createHash("sha256").update(Buffer.from(MANIFEST, "utf8")).digest("hex");

// Install the generated handler beside a manifest in a real directory, exactly as an
// installed adapter would lay it out.
async function installed(overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tcrn-observe-")));
  const source = generateObserveHookHandler({
    events: [...OBSERVE_HOOK_EVENTS],
    manifestDigest: MANIFEST_DIGEST,
    ...overrides,
  });
  await writeFile(join(root, OBSERVE_HANDLER_PATH), source, { mode: 0o600 });
  await writeFile(join(root, "project.json"), overrides.manifest ?? MANIFEST, { mode: 0o600 });
  return { root, source, close: () => rm(root, { recursive: true, force: true }) };
}

// Run the handler the way a host would: event name on argv, payload on stdin.
function fire(root, event, payload = "") {
  return spawnSync(process.execPath, [join(root, OBSERVE_HANDLER_PATH), event], { input: payload, encoding: "utf8" });
}

async function logLines(root) {
  const path = join(root, OBSERVE_LOG_PATH);
  if (!existsSync(path)) return [];
  return parseObserveLog(await readFile(path, "utf8")).lines;
}

test("the handler records an enumerated event, writes nothing to stdout, and exits 0", async () => {
  const context = await installed();
  try {
    const result = fire(context.root, "PostToolUse", "the full tool payload");
    assert.equal(result.status, 0);
    // An observe hook must never inject context: stdout stays empty.
    assert.equal(result.stdout, "");

    const lines = await logLines(context.root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "PostToolUse");
    // The payload is retained only as a digest -- never as a transcript.
    assert.equal(lines[0].detailDigest, createHash("sha256").update("the full tool payload", "utf8").digest("hex"));
    const raw = await readFile(join(context.root, OBSERVE_LOG_PATH), "utf8");
    assert.equal(raw.includes("the full tool payload"), false);
  } finally {
    await context.close();
  }
});

test("every enumerated observe event is recorded, and appends accumulate", async () => {
  const context = await installed();
  try {
    for (const event of OBSERVE_HOOK_EVENTS) {
      assert.equal(fire(context.root, event, `payload for ${event}`).status, 0);
    }
    const lines = await logLines(context.root);
    assert.equal(lines.length, OBSERVE_HOOK_EVENTS.length);
    assert.deepEqual(lines.map((line) => line.event).sort(), [...OBSERVE_HOOK_EVENTS].sort());
  } finally {
    await context.close();
  }
});

test("the handler exits 0 and records nothing on every failure path", async () => {
  const context = await installed();
  try {
    const cases = [
      // An enforce event was NOT amended into the surface: ignored, silently.
      () => fire(context.root, "PreToolUse", "x"),
      () => fire(context.root, "Stop", "x"),
      () => fire(context.root, "PermissionRequest", "x"),
      // Unknown / absent event name.
      () => fire(context.root, "NotAnEvent", "x"),
      () => spawnSync(process.execPath, [join(context.root, OBSERVE_HANDLER_PATH)], { input: "", encoding: "utf8" }),
    ];
    assert.equal(cases.length, fixture.refusedEventCases);
    for (const operation of cases) {
      const result = operation();
      assert.equal(result.status, 0, "must exit 0");
      assert.equal(result.stdout, "");
    }
    // Nothing was recorded by any of them.
    assert.equal(existsSync(join(context.root, OBSERVE_LOG_PATH)), false);
  } finally {
    await context.close();
  }
});

test("drift in the bound manifest makes the handler fall silent, still exiting 0", async () => {
  const context = await installed();
  try {
    // A first firing records normally.
    assert.equal(fire(context.root, "SessionEnd").status, 0);
    assert.equal((await logLines(context.root)).length, 1);

    // The manifest the handler was generated against now drifts underneath it.
    await writeFile(join(context.root, "project.json"), JSON.stringify({ schemaVersion: "tcrn.claude-adapter-project-template.v1", workspaceId: "workspace:swapped" }) + "\n");
    const drifted = fire(context.root, "SessionEnd");
    assert.equal(drifted.status, 0);
    assert.equal(drifted.stdout, "");
    // No new line: it recorded nothing rather than recording under a changed authority.
    assert.equal((await logLines(context.root)).length, 1);

    // A missing manifest is the same story: silence, exit 0.
    await rm(join(context.root, "project.json"));
    assert.equal(fire(context.root, "SessionEnd").status, 0);
    assert.equal((await logLines(context.root)).length, 1);
  } finally {
    await context.close();
  }
});

test("generation refuses an unenumerated surface, so unamended coverage cannot be produced", () => {
  const cases = [
    () => reason("OBSERVE_HANDLER_EVENT_UNKNOWN", () => generateObserveHookHandler({ events: ["PreToolUse"], manifestDigest: MANIFEST_DIGEST })),
    () => reason("OBSERVE_HANDLER_EVENT_UNKNOWN", () => generateObserveHookHandler({ events: ["PostToolUse", "Stop"], manifestDigest: MANIFEST_DIGEST })),
    () => reason("OBSERVE_HANDLER_EVENT_UNKNOWN", () => generateObserveHookHandler({ events: ["PostToolUse", "PostToolUse"], manifestDigest: MANIFEST_DIGEST })),
    () => reason("OBSERVE_HANDLER_EMPTY_SURFACE", () => generateObserveHookHandler({ events: [], manifestDigest: MANIFEST_DIGEST })),
    () => reason("OBSERVE_HANDLER_DIGEST_INVALID", () => generateObserveHookHandler({ events: ["PostToolUse"], manifestDigest: "not-a-digest" })),
  ];
  assert.equal(cases.length, fixture.generationRefusalCases);
  for (const operation of cases) operation();
});

test("the handler source is deterministic, host-neutral and free of ambient trust", () => {
  const first = generateObserveHookHandler({ events: ["PostToolUse", "SessionEnd"], manifestDigest: MANIFEST_DIGEST });
  const second = generateObserveHookHandler({ events: ["SessionEnd", "PostToolUse"], manifestDigest: MANIFEST_DIGEST });
  // Same surface in any order yields byte-identical source, so a trust ceremony's
  // approved digest is stable.
  assert.equal(first, second);
  assert.equal(observeHookHandlerDigest(first), observeHookHandlerDigest(second));
  // No environment variable decides behaviour, and no host-absolute path is baked in.
  assert.equal(/process\.env/u.test(first), false);
  assert.equal(first.includes("/Users/"), false);
  assert.equal(first.includes(".claude"), false);
  assert.equal(first.includes(".codex"), false);
  // Always exits 0, and never writes to stdout.
  assert.ok(first.includes("process.exit(0)"));
  assert.equal(/process\.stdout\.write/u.test(first), false);
});

test("a torn final line is dropped without discarding the receipts before it", async () => {
  const context = await installed();
  try {
    assert.equal(fire(context.root, "PostToolUse", "a").status, 0);
    assert.equal(fire(context.root, "SubagentStop", "b").status, 0);
    // Simulate a host killing the recorder mid-write.
    const path = join(context.root, OBSERVE_LOG_PATH);
    await writeFile(path, (await readFile(path, "utf8")) + '{"schemaVersion":"tcrn.observe-hook-line.v1","event":"Sess');

    const parsed = parseObserveLog(await readFile(path, "utf8"));
    assert.equal(parsed.lines.length, 2);
    assert.equal(parsed.dropped, 1);

    // The surviving lines feed the sidecar, and the batch that results is `unknown`
    // until sealed -- a torn log is exactly the case where completeness is unproven.
    let batch = openReceiptBatch({ batchId: "batch:one", hostProduct: "Claude Code", hostVersion: "2.1.201", sessionId: "session:s1", workspaceId: "workspace:w1", openedAt: "2026-07-25T00:00:00Z" });
    for (const line of parsed.lines) {
      batch = appendReceipt(batch, { event: line.event, occurredAt: line.occurredAt, summary: line.summary, ...(line.detailDigest === null ? {} : { detail: line.summary }) });
    }
    assert.equal(batch.coverage, "unknown");
    assert.equal(batch.entries.length, 2);
    assert.equal(validateReceiptBatch(sealReceiptBatch(batch, "2026-07-25T01:00:00Z")).coverage, "complete");
  } finally {
    await context.close();
  }
});

test("the fixture pins the surface and the fail-open discipline this proof claims", () => {
  assert.equal(fixture.schemaVersion, "tcrn.act6-observe-hook-cases.v1");
  assert.deepEqual(fixture.observeEvents, [...OBSERVE_HOOK_EVENTS]);
  assert.equal(fixture.alwaysExitsZero, true);
  assert.equal(fixture.neverWritesStdout, true);
  assert.equal(fixture.liveHostProof, "not-claimed-per-min-046");
});
