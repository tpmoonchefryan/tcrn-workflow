// SPDX-License-Identifier: Apache-2.0

// WSG-6: the single source of truth for the flagship governed-loop storyline.
//
// This module is pure data plus pure string helpers — it imports nothing and
// writes nothing, so both the hermetic proof (tests/e2e-governed-loop.test.mjs)
// and the doc-proof lockstep gate (scripts/task.mjs `e2e`) load it without a
// build step. The storyline is authored ONCE here; the tutorial
// (docs/tutorial/governed-loop.md) must reproduce the exact same fenced command
// tokens, and both the proof and the gate re-derive that equality so the doc and
// the proof can never drift (acceptance criterion 2).
//
// Path values are workspace-relative placeholders and identifiers are
// angle-bracket placeholders (GAP-5: no absolute paths, no hostnames). The proof
// substitutes real mkdtemp paths and real receipt-derived identifiers at replay
// time; the gate compares the placeholder tokens verbatim.

// The published binary name each fenced command is prefixed with in the tutorial.
export const CLI_BINARY = "tcrn-workflow";

// Workspace-relative root placeholders (identical literal tokens in the tutorial).
export const WORKSPACE_PATH = "./flagship/workspace";
export const FRAMEWORK_PATH = "./flagship/framework";
export const TRANSIENT_PATH = "./flagship/transient";
export const EVIDENCE_PATH = "./flagship/evidence-locator";
export const RELEASE_TRUST_PATH = "./flagship/release-trust";

// The init command is narrated and executed but is NOT part of the CAS-versioned
// mutation storyline (it establishes the workspace at version zero). It is listed
// separately so the proof can seed the real roots before the loop begins while
// the lockstep gate still checks it against the tutorial.
export const initCommand = [
  "init",
  "--workspace",
  WORKSPACE_PATH,
  "--framework",
  FRAMEWORK_PATH,
  "--transient",
  TRANSIENT_PATH,
  "--evidence-locator",
  EVIDENCE_PATH,
  "--release-trust",
  RELEASE_TRUST_PATH,
  "--external-key",
  "FLAGSHIP-WORKSPACE",
  "--at",
  "2026-07-11T00:00:00Z",
];

// The governed loop, in replay order. Each step carries:
//   key         — a stable label the proof keys its capture logic on
//   command     — the exact fenced command tokens (after the binary prefix)
//   reasonCode  — the observable success reason the proof asserts, or null for
//                 the two list verbs whose canonical output is a bare record
//                 array with no envelope (the proof asserts their shape instead)
export const governedLoopStoryline = [
  {
    key: "project-create",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["project-create", "--workspace", WORKSPACE_PATH, "--expected-version", "0", "--at", "2026-07-11T00:00:01Z", "--external-key", "FLAGSHIP-PROJECT", "--name", "Flagship"],
  },
  {
    key: "work-create-initiative",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["work-create", "--workspace", WORKSPACE_PATH, "--expected-version", "1", "--at", "2026-07-11T00:00:02Z", "--project-id", "<project-id>", "--external-key", "FLAGSHIP-INITIATIVE", "--kind", "Initiative"],
  },
  {
    key: "work-create-epic",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["work-create", "--workspace", WORKSPACE_PATH, "--expected-version", "2", "--at", "2026-07-11T00:00:03Z", "--project-id", "<project-id>", "--external-key", "FLAGSHIP-EPIC", "--kind", "Epic", "--parent-id", "<initiative-id>"],
  },
  {
    key: "work-create-story",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["work-create", "--workspace", WORKSPACE_PATH, "--expected-version", "3", "--at", "2026-07-11T00:00:04Z", "--project-id", "<project-id>", "--external-key", "FLAGSHIP-STORY", "--kind", "Story", "--parent-id", "<epic-id>"],
  },
  {
    key: "work-transition-story-ready",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["work-transition", "--workspace", WORKSPACE_PATH, "--expected-version", "4", "--at", "2026-07-11T00:00:05Z", "--id", "<story-id>", "--status", "ready"],
  },
  {
    key: "work-transition-story-active",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["work-transition", "--workspace", WORKSPACE_PATH, "--expected-version", "5", "--at", "2026-07-11T00:00:06Z", "--id", "<story-id>", "--status", "active"],
  },
  {
    key: "gate-create",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["gate-create", "--workspace", WORKSPACE_PATH, "--expected-version", "6", "--at", "2026-07-11T00:00:07Z", "--external-key", "FLAGSHIP-GATE", "--project-id", "<project-id>", "--work-id", "<story-id>", "--title", "Decision-gate", "--outcome-class", "role_decision"],
  },
  {
    key: "conference-open",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["conference-open", "--workspace", WORKSPACE_PATH, "--expected-version", "7", "--at", "2026-07-11T00:00:08Z", "--external-key", "FLAGSHIP-CONFERENCE", "--project-id", "<project-id>", "--type", "architecture", "--title", "Decide-the-story", "--work-ids", "<story-id>", "--desired-outcome", "ratify-the-approach", "--participant-ids", "profile:architect-01"],
  },
  {
    key: "conference-append-position",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["conference-append-position", "--workspace", WORKSPACE_PATH, "--expected-version", "8", "--at", "2026-07-11T00:00:09Z", "--conference-id", "<conference-id>", "--external-key", "FLAGSHIP-POSITION", "--actor-id", "profile:architect-01", "--position", "persist-via-event-log", "--risks", "forward-reads-as-corruption", "--recommendations", "document-the-posture", "--evidence-ids", "evidence:position-01"],
  },
  {
    key: "knowledge-init",
    reasonCode: "KNOWLEDGE_STORE_INITIALIZED",
    command: ["knowledge-init", "--workspace", WORKSPACE_PATH, "--acknowledge-disposable", "true"],
  },
  {
    key: "conference-close-distill",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["conference-close", "--workspace", WORKSPACE_PATH, "--expected-version", "9", "--at", "2026-07-11T00:00:10Z", "--conference-id", "<conference-id>", "--minutes-external-key", "FLAGSHIP-MINUTES", "--summary", "approach-ratified", "--outcome-class", "role_decision", "--decisions", "persist-conference-and-gate-records", "--unresolved-issues", "-", "--distill", "true", "--accountable-owner-id", "owner:governance", "--stale-days", "90", "--evidence-ids", "evidence:close-01"],
  },
  {
    key: "knowledge-validate",
    reasonCode: "KNOWLEDGE_STORE_VALID",
    command: ["knowledge-validate", "--workspace", WORKSPACE_PATH],
  },
  {
    key: "knowledge-list",
    reasonCode: "KNOWLEDGE_LIST_READY",
    command: ["knowledge-list", "--workspace", WORKSPACE_PATH, "--at", "2026-07-11T00:00:11Z", "--selection", "all"],
  },
  {
    key: "knowledge-promote",
    reasonCode: "KNOWLEDGE_PROMOTION_UPDATED",
    command: ["knowledge-promote", "--workspace", WORKSPACE_PATH, "--expected-version", "<knowledge-version>", "--expected-revision", "<knowledge-revision>", "--at", "2026-07-11T00:00:12Z", "--id", "<knowledge-id>", "--state", "promoted"],
  },
  {
    key: "gate-transition-satisfied",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["gate-transition", "--workspace", WORKSPACE_PATH, "--expected-version", "10", "--at", "2026-07-11T00:00:13Z", "--id", "<gate-id>", "--status", "satisfied", "--minutes-locator", "<minutes-locator>"],
  },
  {
    key: "work-transition-story-done",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["work-transition", "--workspace", WORKSPACE_PATH, "--expected-version", "11", "--at", "2026-07-11T00:00:14Z", "--id", "<story-id>", "--status", "done"],
  },
  {
    key: "work-show-story",
    reasonCode: "WORKSPACE_RECORD_READY",
    command: ["work-show", "--workspace", WORKSPACE_PATH, "--id", "<story-id>"],
  },
  {
    key: "gate-list",
    reasonCode: null,
    command: ["gate-list", "--workspace", WORKSPACE_PATH, "--work-id", "<story-id>"],
  },
];

// The fixed conference title and single decision the loop distills, reused by the
// proof to recompute the knowledge candidate's sourceDigest independently.
export const CONFERENCE_TITLE = "Decide-the-story";
export const DISTILLED_DECISION = "persist-conference-and-gate-records";

// Canonical string form of a command's tokens, used only for the lockstep diff.
// Both sides feed placeholder tokens through this identically, so the comparison
// is exact token equality with a separator that cannot appear inside a token.
export function canonicalizeCommand(tokens) {
  return tokens.join(" ");
}

// Extract the fenced command lines from the tutorial markdown. A command line is
// any line inside a fenced block that begins with the "$ " prompt; every other
// fenced line (example output) is ignored. The binary prefix is stripped so the
// returned token arrays align with each storyline step's `command`.
export function extractTutorialCommands(markdown) {
  const commands = [];
  let inFence = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/\s+$/u, "");
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed.startsWith("$ ")) {
      continue;
    }
    const tokens = trimmed.slice(2).split(/\s+/u);
    if (tokens[0] === CLI_BINARY) {
      tokens.shift();
    }
    commands.push(tokens);
  }
  return commands;
}

// The full ordered token list the tutorial must reproduce: the init command
// followed by every storyline command.
export function expectedTutorialCommands() {
  return [initCommand, ...governedLoopStoryline.map((step) => step.command)];
}
