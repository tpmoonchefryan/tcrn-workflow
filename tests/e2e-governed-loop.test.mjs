// SPDX-License-Identifier: Apache-2.0

// WSG-6: the flagship end-to-end governed-loop proof.
//
// One hermetic replay of the whole product loop —
// initiative -> epic -> story -> gate -> conference -> distill -> promote -> trace
// — on a REAL (non-fixture) workspace created under mkdtemp, driven entirely
// through the governed CLI surface (runCli + a CliIo write-capture stub, never a
// direct core-library call), with every timestamp supplied explicitly (no
// Date.now, no randomness) and no network access (the offline process guard is
// installed by the verify harness).
//
// The command sequence is authored once in ./e2e-governed-loop-commands.mjs and
// reproduced verbatim by docs/tutorial/governed-loop.md; this proof replays that
// single source of truth and additionally re-derives the doc/proof equality, so
// the tutorial cannot rot (acceptance criterion 2). The trace step asserts an
// unbroken digest chain binding the work record, the gate card, the conference
// minutes, the distilled knowledge candidate, and the promotion receipt
// (acceptance criterion 3).

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import {
  CONFERENCE_TITLE,
  DISTILLED_DECISION,
  EVIDENCE_PATH,
  FRAMEWORK_PATH,
  RELEASE_TRUST_PATH,
  TRANSIENT_PATH,
  WORKSPACE_PATH,
  canonicalizeCommand,
  expectedTutorialCommands,
  extractTutorialCommands,
  governedLoopStoryline,
  initCommand,
} from "./e2e-governed-loop-commands.mjs";

const MINUTES_PREFIX = "minutes:";
const MINUTES_LOCATOR_PREFIX = "conference-minutes:";
const CONFERENCE_TAGS = ["conference-decision", "distilled", "type-architecture"];

// Drive one governed command through runCli with a write-capture stub and return
// the parsed canonical output. No clock is injected and --attest-dir is never
// supplied, so the CLI never reaches for a wall clock (constraint 6).
async function invoke(tokens) {
  let output = "";
  await runCli(tokens, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

// Substitute the workspace-relative path placeholders and the receipt-derived
// identifier placeholders with their real values before replay.
function render(tokens, substitutions) {
  return tokens.map((token) => (Object.hasOwn(substitutions, token) ? substitutions[token] : token));
}

test("the flagship governed loop replays end-to-end through the CLI with an unbroken trace digest chain", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-e2e-governed-loop-")));
  context.after(() => rm(base, { recursive: true, force: true }));

  // Real roots for the loop, mapped from the workspace-relative placeholders.
  const roots = {
    [FRAMEWORK_PATH]: join(base, "framework"),
    [WORKSPACE_PATH]: join(base, "workspace"),
    [TRANSIENT_PATH]: join(base, "transient"),
    [EVIDENCE_PATH]: join(base, "evidence-locator"),
    [RELEASE_TRUST_PATH]: join(base, "release-trust"),
  };
  for (const path of Object.values(roots)) {
    await mkdir(path);
  }

  // The live substitution table: path placeholders first, identifiers as the
  // storyline captures them from each receipt.
  const substitutions = { ...roots };

  // Establish the workspace at version zero.
  const initReceipt = await invoke(render(initCommand, substitutions));
  assert.equal(initReceipt.reasonCode, "WORKSPACE_COMMAND_COMPLETED", "init");
  assert.equal(initReceipt.version, 0);

  // Replay the governed loop, asserting each step's observable reason and
  // capturing the identifiers later steps depend on.
  const captured = {};
  for (const step of governedLoopStoryline) {
    const output = await invoke(render(step.command, substitutions));
    if (step.reasonCode === null) {
      // The two list verbs emit a bare canonical record array with no envelope;
      // their shape is asserted where the array is consumed below.
      assert.equal(Array.isArray(output), true, `${step.key} returns a record array`);
    } else {
      assert.equal(output.reasonCode, step.reasonCode, step.key);
    }
    switch (step.key) {
      case "project-create":
        substitutions["<project-id>"] = output.record.id;
        break;
      case "work-create-initiative":
        substitutions["<initiative-id>"] = output.record.id;
        break;
      case "work-create-epic":
        substitutions["<epic-id>"] = output.record.id;
        break;
      case "work-create-story":
        substitutions["<story-id>"] = output.record.id;
        break;
      case "gate-create":
        substitutions["<gate-id>"] = output.recordId;
        break;
      case "conference-open":
        substitutions["<conference-id>"] = output.recordId;
        break;
      case "conference-close-distill":
        captured.minutesId = output.recordId;
        captured.knowledgeUnitIds = output.knowledgeUnitIds;
        substitutions["<minutes-locator>"] = `${MINUTES_LOCATOR_PREFIX}${output.recordId.slice(MINUTES_PREFIX.length)}`;
        break;
      case "knowledge-validate":
        substitutions["<knowledge-version>"] = String(output.version);
        break;
      case "knowledge-list":
        captured.listing = output;
        substitutions["<knowledge-id>"] = output.records[0].id;
        substitutions["<knowledge-revision>"] = String(output.records[0].revision);
        break;
      case "knowledge-promote":
        captured.promotion = output;
        break;
      case "work-show-story":
        captured.story = output.record;
        break;
      case "gate-list":
        captured.gate = output.find((entry) => entry.id === substitutions["<gate-id>"]);
        break;
      default:
        break;
    }
  }

  // --- Trace: the unbroken digest chain (acceptance criterion 3) --------------
  // Node 1 -> 2: the work record is the gate's anchor.
  assert.equal(captured.story.id, substitutions["<story-id>"]);
  assert.equal(captured.story.status, "done", "the story reached done only past a satisfied gate");
  assert.ok(captured.gate, "the gate card is present for the story");
  assert.equal(captured.gate.workId, captured.story.id, "gate card binds the work record");
  assert.equal(captured.gate.status, "satisfied");

  // Node 2 -> 3: the gate's persisted evidence locator resolves to the conference
  // minutes produced by the distilling close.
  const locator = captured.gate.extensions["gate-evidence:conference-minutes"].value;
  assert.equal(locator, substitutions["<minutes-locator>"], "gate card binds the conference minutes");
  assert.equal(locator, `${MINUTES_LOCATOR_PREFIX}${captured.minutesId.slice(MINUTES_PREFIX.length)}`);

  // Node 3 -> 4: the knowledge candidate's sourceDigest is bound to the full
  // minutes basis (title + decision + minutes id), recomputed independently here.
  assert.equal(captured.listing.total, 1, "exactly one decision was distilled");
  const candidate = captured.listing.records[0];
  const expectedSourceDigest = canonicalSha256({ title: CONFERENCE_TITLE, decision: DISTILLED_DECISION, minutesId: captured.minutesId });
  assert.equal(candidate.sourceDigest, expectedSourceDigest, "knowledge candidate binds the conference minutes");
  assert.deepEqual(candidate.tags, CONFERENCE_TAGS);
  assert.deepEqual(candidate.linkedEvidenceIds, ["evidence:close-01", "evidence:position-01"], "the distilled provenance dedupes the close and position evidence");
  assert.equal(candidate.id, captured.knowledgeUnitIds[0], "the close receipt names the distilled candidate");

  // Node 4 -> 5: the promotion receipt is the same candidate, promoted.
  assert.equal(captured.promotion.id, candidate.id, "promotion receipt binds the knowledge candidate");
  assert.equal(captured.promotion.promotionState, "promoted");

  // The five node digests, ordered, hash to a single stable chain digest — the
  // whole loop's evidence collapses to one 64-hex value that changes if a single
  // node or edge changes.
  const chainDigest = canonicalSha256([
    canonicalSha256(captured.story),
    canonicalSha256(captured.gate),
    canonicalSha256({ minutesId: captured.minutesId, sourceBasis: expectedSourceDigest }),
    canonicalSha256(candidate),
    canonicalSha256({ id: captured.promotion.id, promotionState: captured.promotion.promotionState }),
  ]);
  assert.match(chainDigest, /^[a-f0-9]{64}$/u);

  // --- Doc/proof lockstep (acceptance criterion 2), re-derived in-proof -------
  const tutorial = await readFile(new URL("../docs/tutorial/governed-loop.md", import.meta.url), "utf8");
  const documented = extractTutorialCommands(tutorial).map(canonicalizeCommand);
  const authored = expectedTutorialCommands().map(canonicalizeCommand);
  assert.deepEqual(documented, authored, "every tutorial command matches the replayed storyline verbatim");
});
