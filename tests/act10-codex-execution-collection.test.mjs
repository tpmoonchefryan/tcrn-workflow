// SPDX-License-Identifier: Apache-2.0
//
// INIT-010 EPIC-020 S054: version-pinned Codex subagent/thread/turn collection.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  COLLECTION_ATTRIBUTION_NOTE,
  OBSERVED_PROTOCOL_DIGEST,
  collectCodexAppServerExecutions,
  collectCodexExecutionReceipt,
  verifyCollectedTranscript,
} from "../dist/build/packages/core/src/index.js";

const fixture = JSON.parse(
  await readFile(
    new URL(
      "../packages/core/fixtures/act10-codex-execution-collection-cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const schemaEvidence = JSON.parse(
  await readFile(
    new URL(
      "../docs/verification/host/codex-app-server-execution-collection.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function turn(id, startedAt, completedAt) {
  return {
    id,
    items: [],
    itemsView: "all",
    status: completedAt === null ? "inProgress" : "completed",
    error: null,
    startedAt,
    completedAt,
    durationMs:
      startedAt === null || completedAt === null
        ? null
        : (completedAt - startedAt) * 1_000,
  };
}

function completeNotifications({
  prompt = "Review the proposed change independently.",
  finalMessage = "The change is insufficiently evidenced.",
  threadSessionId = "session:codex-tree",
} = {}) {
  return [
    {
      method: "item/completed",
      params: {
        threadId: "thread:parent",
        turnId: "turn:parent",
        completedAtMs: 1_753_401_600_000,
        item: {
          type: "collabAgentToolCall",
          id: "item:spawn-verity",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "thread:parent",
          receiverThreadIds: ["thread:verity"],
          prompt,
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      },
    },
    {
      method: "thread/started",
      params: {
        thread: {
          id: "thread:verity",
          sessionId: threadSessionId,
          forkedFromId: null,
          parentThreadId: "thread:parent",
          threadSource: "subagent",
          ephemeral: true,
          createdAt: 1_753_401_600,
        },
      },
    },
    {
      method: "turn/started",
      params: {
        threadId: "thread:verity",
        turn: turn("turn:verity-1", 1_753_401_601, null),
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread:verity",
        turnId: "turn:verity-1",
        completedAtMs: 1_753_401_603_000,
        item: {
          type: "agentMessage",
          id: "item:verity-commentary",
          text: "Checking the evidence now.",
          phase: "commentary",
          memoryCitation: null,
        },
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread:verity",
        turnId: "turn:verity-1",
        completedAtMs: 1_753_401_605_000,
        item: {
          type: "agentMessage",
          id: "item:verity-final",
          text: finalMessage,
          phase: "final_answer",
          memoryCitation: null,
        },
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId: "thread:verity",
        turn: turn(
          "turn:verity-1",
          1_753_401_601,
          1_753_401_605,
        ),
      },
    },
  ];
}

function input(notifications, overrides = {}) {
  return {
    hostProduct: "Codex CLI",
    hostVersion: "0.139.0",
    sessionId: "session:codex-tree",
    protocolDigest: OBSERVED_PROTOCOL_DIGEST,
    observedFrom: "2026-07-25T00:00:00Z",
    observedTo: "2026-07-25T00:10:00Z",
    notifications,
    ...overrides,
  };
}

function reason(code, operation) {
  assert.throws(operation, (error) => error?.reasonCode === code, code);
}

test("a supplied current-wire stream correlates spawn, subagent thread, turn, and final output", () => {
  const result = collectCodexAppServerExecutions(
    input(completeNotifications()),
  );
  assert.equal(result.availability, "observe");
  assert.equal(result.reasonCode, "CODEX_EXECUTION_OBSERVED");
  assert.equal(result.readOnly, true);
  assert.equal(result.drivesHost, false);
  assert.equal(result.observedInvocations, 1);
  assert.equal(result.unavailableInvocations, 0);

  const execution = result.records[0];
  assert.equal(execution.availability, "observe");
  assert.equal(execution.sessionId, "session:codex-tree");
  assert.equal(execution.threadId, "thread:verity");
  assert.equal(execution.parentThreadId, "thread:parent");
  assert.equal(execution.turnId, "turn:verity-1");
  assert.equal(execution.spawnItemId, "item:spawn-verity");
  // INC-007: the invocation identity is the (spawn, thread) pair, not the spawn item
  // alone -- one spawnAgent naming several receivers would otherwise give every
  // receiver the same id while still being counted as separate invocations.
  // Distinct per receiver thread and stable for the same (spawn, thread) pair.
  assert.match(execution.observed.agentInvocationId, /^agent-invocation:[0-9a-f]{32}$/u);
  assert.equal(execution.observed.freshContext, true);
  assert.equal(
    execution.transcript.freshContextBasis,
    "new_subagent_thread_not_forked_after_spawn",
  );
  assert.equal(
    execution.transcript.finalMessageItemId,
    "item:verity-final",
  );
  assert.equal(execution.transcriptSigned, false);
  assert.equal(execution.attributionNote, COLLECTION_ATTRIBUTION_NOTE);
  assert.equal(
    execution.transcriptSource.includes(
      "Review the proposed change independently.",
    ),
    false,
  );
  assert.equal(
    execution.transcriptSource.includes(
      "The change is insufficiently evidenced.",
    ),
    false,
  );
});

test("the projected host-execution receipt retains actual session/thread/turn bindings", () => {
  const result = collectCodexAppServerExecutions(
    input(completeNotifications()),
  );
  const execution = result.records[0];
  assert.equal(execution.availability, "observe");
  const collected = collectCodexExecutionReceipt(
    execution,
    "position:verity",
    "receipt:verity",
    "conference:codex",
    result.hostProduct,
    result.hostVersion,
  );
  assert.equal(collected.receipt.sessionId, execution.sessionId);
  assert.equal(collected.receipt.threadId, execution.threadId);
  assert.equal(collected.receipt.turnId, execution.turnId);
  assert.equal(
    collected.receipt.agentInvocationId,
    execution.observed.agentInvocationId,
  );
  assert.equal(collected.receipt.availability, "observe");
  assert.deepEqual(
    verifyCollectedTranscript(collected, execution.transcriptSource),
    { matches: true, transcriptSigned: false },
  );
  assert.deepEqual(
    verifyCollectedTranscript(
      collected,
      `${execution.transcriptSource} `,
    ),
    { matches: false, transcriptSigned: false },
  );
});

test("missing prompt and missing final message downgrade the candidate to unavailable", () => {
  const noPrompt = collectCodexAppServerExecutions(
    input(completeNotifications({ prompt: null })),
  );
  assert.equal(noPrompt.availability, "unavailable");
  assert.equal(
    noPrompt.records[0].reasonCode,
    "CODEX_EXECUTION_PROMPT_UNAVAILABLE",
  );
  assert.equal(noPrompt.records[0].observed, null);

  const frames = completeNotifications();
  const noFinal = frames.filter(
    (frame) =>
      !(
        frame.method === "item/completed" &&
        frame.params.item.type === "agentMessage"
      ),
  );
  const result = collectCodexAppServerExecutions(input(noFinal));
  assert.equal(result.availability, "unavailable");
  assert.equal(
    result.records[0].reasonCode,
    "CODEX_EXECUTION_FINAL_MESSAGE_UNAVAILABLE",
  );
});

test("final output is selected by final_answer phase and completion time, never array position", () => {
  const frames = completeNotifications();
  const completedTurn = frames.pop();
  frames.push(
    {
      method: "item/completed",
      params: {
        threadId: "thread:verity",
        turnId: "turn:verity-1",
        completedAtMs: 1_753_401_604_000,
        item: {
          type: "agentMessage",
          id: "item:verity-final-older",
          text: "Older final answer.",
          phase: "final_answer",
          memoryCitation: null,
        },
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread:verity",
        turnId: "turn:verity-1",
        completedAtMs: 1_753_401_605_000,
        item: {
          type: "agentMessage",
          id: "item:late-commentary",
          text: "This later array element is not the final answer.",
          phase: "commentary",
          memoryCitation: null,
        },
      },
    },
    completedTurn,
  );
  const result = collectCodexAppServerExecutions(input(frames));
  const execution = result.records[0];
  assert.equal(execution.availability, "observe");
  assert.equal(execution.transcript.finalMessageItemId, "item:verity-final");

  const unknownPhase = completeNotifications();
  for (const frame of unknownPhase) {
    if (
      frame.method === "item/completed" &&
      frame.params.item.id === "item:verity-final"
    ) {
      frame.params.item.phase = null;
    }
  }
  const unavailable = collectCodexAppServerExecutions(input(unknownPhase));
  assert.equal(
    unavailable.records[0].reasonCode,
    "CODEX_EXECUTION_FINAL_MESSAGE_UNAVAILABLE",
  );
});

test("fresh context is derived from a new non-forked subagent thread instead of asserted", () => {
  const forked = completeNotifications();
  const forkedThread = forked.find(
    (frame) => frame.method === "thread/started",
  );
  forkedThread.params.thread.forkedFromId = "thread:older";
  const forkedResult = collectCodexAppServerExecutions(input(forked));
  assert.equal(
    forkedResult.records[0].reasonCode,
    "CODEX_EXECUTION_FRESH_CONTEXT_UNAVAILABLE",
  );

  const predatesSpawn = completeNotifications();
  const oldThread = predatesSpawn.find(
    (frame) => frame.method === "thread/started",
  );
  oldThread.params.thread.createdAt = 1_753_401_599;
  const oldResult = collectCodexAppServerExecutions(input(predatesSpawn));
  assert.equal(
    oldResult.records[0].reasonCode,
    "CODEX_EXECUTION_FRESH_CONTEXT_UNAVAILABLE",
  );

  const subsecondUnproven = completeNotifications();
  subsecondUnproven[0].params.completedAtMs += 500;
  const subsecondResult = collectCodexAppServerExecutions(
    input(subsecondUnproven),
  );
  assert.equal(
    subsecondResult.records[0].reasonCode,
    "CODEX_EXECUTION_FRESH_CONTEXT_UNAVAILABLE",
  );
});

test("missing turn lifecycle and no subagent candidates stay honestly unavailable", () => {
  const onlyThread = completeNotifications().filter(
    (frame) =>
      frame.method === "thread/started" ||
      (frame.method === "item/completed" &&
        frame.params.item.type === "collabAgentToolCall"),
  );
  const missingTurn = collectCodexAppServerExecutions(input(onlyThread));
  assert.equal(
    missingTurn.records[0].reasonCode,
    "CODEX_EXECUTION_TURN_UNAVAILABLE",
  );

  const none = collectCodexAppServerExecutions(
    input([{ method: "thread/started", params: { thread: {
      id: "thread:user",
      sessionId: "session:codex-tree",
      parentThreadId: null,
      threadSource: "user",
      createdAt: 1_753_401_600,
    } } }]),
  );
  assert.equal(none.availability, "unavailable");
  assert.equal(none.reasonCode, "CODEX_EXECUTION_UNAVAILABLE");
  assert.deepEqual(none.records, []);
});

test("an unpinned protocol downgrades the whole capability without interpreting params", () => {
  const result = collectCodexAppServerExecutions(
    input(completeNotifications(), {
      protocolDigest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }),
  );
  assert.equal(result.protocolBinding, "unpinned");
  assert.equal(result.availability, "unavailable");
  assert.equal(
    result.reasonCode,
    "CODEX_EXECUTION_PROTOCOL_UNPINNED",
  );
  assert.deepEqual(result.records, []);
});

test("cross-session frames and replayed lifecycle events fail closed", () => {
  reason("CODEX_EXECUTION_SCHEMA_INVALID", () =>
    collectCodexAppServerExecutions(
      input(completeNotifications(), { hostProduct: "Claude Code" }),
    ),
  );
  reason("CODEX_EXECUTION_SESSION_MISMATCH", () =>
    collectCodexAppServerExecutions(
      input(
        completeNotifications({
          threadSessionId: "session:other",
        }),
      ),
    ),
  );
  const duplicateThread = completeNotifications();
  duplicateThread.push(
    structuredClone(
      duplicateThread.find((frame) => frame.method === "thread/started"),
    ),
  );
  reason("CODEX_EXECUTION_DUPLICATE_EVENT", () =>
    collectCodexAppServerExecutions(input(duplicateThread)),
  );
  const duplicateItem = completeNotifications();
  duplicateItem.push(structuredClone(duplicateItem[0]));
  reason("CODEX_EXECUTION_DUPLICATE_EVENT", () =>
    collectCodexAppServerExecutions(input(duplicateItem)),
  );
  const afterTurn = completeNotifications();
  const final = afterTurn.find(
    (frame) =>
      frame.method === "item/completed" &&
      frame.params.item.id === "item:verity-final",
  );
  final.params.completedAtMs = 1_753_401_606_000;
  reason("CODEX_EXECUTION_SCHEMA_INVALID", () =>
    collectCodexAppServerExecutions(input(afterTurn)),
  );
});

test("the collector is a pure supplied-stream reader and contains no driving verb", async () => {
  const source = await readFile(
    new URL(
      "../packages/core/src/codex-execution-collection.ts",
      import.meta.url,
    ),
    "utf8",
  );
  for (const method of [
    "thread/start",
    "thread/fork",
    "thread/resume",
    "turn/start",
    "turn/interrupt",
  ]) {
    assert.equal(source.includes(`"${method}"`), false);
  }
  for (const fragments of [
    ["child", "_process"],
    ["spawn", "Sync("],
    ["create", "Connection"],
    ["fet", "ch("],
  ]) {
    assert.equal(source.includes(fragments.join("")), false);
  }
});

test("fixture and schema evidence pin the no-overclaim boundary", () => {
  assert.equal(
    fixture.schemaVersion,
    "tcrn.act10-codex-execution-collection-cases.v1",
  );
  assert.equal(fixture.readOnly, true);
  assert.equal(fixture.drivesHost, false);
  assert.equal(fixture.transcriptsSigned, false);
  assert.equal(
    fixture.liveHostProof,
    "not-claimed-no-observer-driven-subagent-invocation",
  );
  assert.deepEqual(schemaEvidence.wireMethods, [
    "thread/started",
    "turn/started",
    "turn/completed",
    "item/completed",
  ]);
  assert.equal(schemaEvidence.boundary.liveAttachClaimed, false);
  assert.equal(schemaEvidence.boundary.liveSubagentReceiptClaimed, false);
});
