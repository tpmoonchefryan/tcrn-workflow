// SPDX-License-Identifier: Apache-2.0
//
// INIT-010 EPIC-020 S054/S057: version-pinned Codex subagent execution
// collection from lifecycle notifications plus same-connection
// thread/read(includeTurns=true) readback.

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

const baseSecond = 1_753_401_600;
const spawnStartedAtMs = baseSecond * 1_000 + 410;
const spawnCompletedAtMs = baseSecond * 1_000 + 515;

function turn(id, startedAt, completedAt, items = []) {
  return {
    id,
    items,
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

function completeCase({
  prompt = "Review the proposed change independently.",
  finalMessage = "The change is insufficiently evidenced.",
  finalPhase = "final_answer",
  threadSessionId = "session:codex-tree",
  parentThreadId = "thread:parent",
  receiverThreadId = "thread:verity",
  forkedFromId = null,
  createdAt = baseSecond,
  includeThreadStarted = false,
  includeReadback = true,
} = {}) {
  const childTurnId = "turn:verity-1";
  const commentary = {
    type: "agentMessage",
    id: "item:verity-commentary",
    text: "Checking the evidence now.",
    phase: "commentary",
    memoryCitation: null,
  };
  const final = {
    type: "agentMessage",
    id: "item:verity-final",
    text: finalMessage,
    phase: finalPhase,
    memoryCitation: null,
  };
  const notifications = [
    {
      method: "item/started",
      params: {
        threadId: parentThreadId,
        turnId: "turn:parent",
        startedAtMs: spawnStartedAtMs,
        item: {
          type: "collabAgentToolCall",
          id: "item:spawn-verity",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: parentThreadId,
          receiverThreadIds: [],
          prompt,
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: parentThreadId,
        turnId: "turn:parent",
        completedAtMs: spawnCompletedAtMs,
        item: {
          type: "collabAgentToolCall",
          id: "item:spawn-verity",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: parentThreadId,
          receiverThreadIds: [receiverThreadId],
          prompt,
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      },
    },
    {
      method: "turn/started",
      params: {
        threadId: receiverThreadId,
        turn: turn(childTurnId, baseSecond + 1, null),
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: receiverThreadId,
        turnId: childTurnId,
        completedAtMs: (baseSecond + 3) * 1_000,
        item: commentary,
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: receiverThreadId,
        turnId: childTurnId,
        completedAtMs: (baseSecond + 5) * 1_000,
        item: final,
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId: receiverThreadId,
        turn: turn(childTurnId, baseSecond + 1, baseSecond + 5),
      },
    },
  ];
  if (includeThreadStarted) {
    notifications.splice(2, 0, {
      method: "thread/started",
      params: {
        thread: {
          id: receiverThreadId,
          sessionId: threadSessionId,
          forkedFromId,
          parentThreadId,
          threadSource: "subagent",
          ephemeral: true,
          createdAt,
        },
      },
    });
  }
  const threadReadbacks = includeReadback
    ? [
        {
          request: { threadId: receiverThreadId, includeTurns: true },
          response: {
            thread: {
              id: receiverThreadId,
              sessionId: threadSessionId,
              forkedFromId,
              parentThreadId,
              threadSource: null,
              source: {
                subAgent: {
                  thread_spawn: { parent_thread_id: parentThreadId },
                },
              },
              ephemeral: true,
              createdAt,
              turns: [
                turn(
                  childTurnId,
                  baseSecond + 1,
                  baseSecond + 5,
                  [structuredClone(commentary), structuredClone(final)],
                ),
              ],
            },
          },
        },
      ]
    : [];
  return { notifications, threadReadbacks };
}

function input(observation, overrides = {}) {
  return {
    hostProduct: "Codex CLI",
    hostVersion: "0.139.0",
    sessionId: "session:codex-tree",
    protocolDigest: OBSERVED_PROTOCOL_DIGEST,
    observedFrom: "2026-07-25T00:00:00Z",
    observedTo: "2026-07-25T00:10:00Z",
    notifications: observation.notifications,
    threadReadbacks: observation.threadReadbacks,
    ...overrides,
  };
}

function reason(code, operation) {
  assert.throws(operation, (error) => error?.reasonCode === code, code);
}

test("a real-shape stream works without a synthetic subagent thread/started frame", () => {
  const result = collectCodexAppServerExecutions(input(completeCase()));
  assert.equal(result.availability, "observe");
  assert.equal(result.reasonCode, "CODEX_EXECUTION_OBSERVED");
  assert.equal(result.readOnly, true);
  assert.equal(result.drivesHost, false);
  assert.equal(result.observedInvocations, 1);

  const execution = result.records[0];
  assert.equal(execution.availability, "observe");
  assert.equal(execution.threadId, "thread:verity");
  assert.equal(execution.parentThreadId, "thread:parent");
  assert.equal(execution.turnId, "turn:verity-1");
  assert.equal(execution.spawnItemId, "item:spawn-verity");
  assert.match(
    execution.observed.agentInvocationId,
    /^agent-invocation:[0-9a-f]{32}$/u,
  );
  assert.equal(execution.observed.freshContext, true);
  assert.equal(
    execution.transcript.freshContextBasis,
    "spawn_lifecycle_overlaps_non_forked_subagent_thread_readback",
  );
  assert.equal(execution.transcript.threadStartedNotificationObserved, false);
  assert.match(execution.transcript.threadReadbackDigest, /^[0-9a-f]{64}$/u);
  assert.equal(execution.transcriptSigned, false);
  assert.equal(execution.attributionNote, COLLECTION_ATTRIBUTION_NOTE);
  assert.equal(
    execution.transcriptSource.includes("Review the proposed change independently."),
    false,
  );
  assert.equal(
    execution.transcriptSource.includes("The change is insufficiently evidenced."),
    false,
  );
});

test("an observed subagent thread/started frame is optional but must agree with readback", () => {
  const result = collectCodexAppServerExecutions(
    input(completeCase({ includeThreadStarted: true })),
  );
  assert.equal(result.records[0].availability, "observe");
  assert.equal(result.records[0].transcript.threadStartedNotificationObserved, true);

  const disagreement = completeCase({ includeThreadStarted: true });
  disagreement.notifications.find(
    (frame) => frame.method === "thread/started",
  ).params.thread.createdAt -= 1;
  reason("CODEX_EXECUTION_SCHEMA_INVALID", () =>
    collectCodexAppServerExecutions(input(disagreement)),
  );
});

test("the projected receipt retains actual session/thread/turn and readback-bound bytes", () => {
  const result = collectCodexAppServerExecutions(input(completeCase()));
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
  assert.equal(collected.receipt.agentInvocationId, execution.observed.agentInvocationId);
  assert.deepEqual(
    verifyCollectedTranscript(collected, execution.transcriptSource),
    { matches: true, transcriptSigned: false },
  );
  assert.deepEqual(
    verifyCollectedTranscript(collected, `${execution.transcriptSource} `),
    { matches: false, transcriptSigned: false },
  );
});

test("missing readback, prompt, turn lifecycle, and final bytes stay unavailable", () => {
  const missingReadback = collectCodexAppServerExecutions(
    input(completeCase({ includeReadback: false })),
  );
  assert.equal(
    missingReadback.records[0].reasonCode,
    "CODEX_EXECUTION_THREAD_UNAVAILABLE",
  );

  const noPrompt = collectCodexAppServerExecutions(
    input(completeCase({ prompt: null })),
  );
  assert.equal(
    noPrompt.records[0].reasonCode,
    "CODEX_EXECUTION_PROMPT_UNAVAILABLE",
  );

  const missingTurn = completeCase();
  missingTurn.notifications = missingTurn.notifications.filter(
    (frame) => frame.method !== "turn/completed",
  );
  assert.equal(
    collectCodexAppServerExecutions(input(missingTurn)).records[0].reasonCode,
    "CODEX_EXECUTION_TURN_UNAVAILABLE",
  );

  const noFinal = completeCase();
  noFinal.notifications = noFinal.notifications.filter(
    (frame) => frame.params?.item?.id !== "item:verity-final",
  );
  assert.equal(
    collectCodexAppServerExecutions(input(noFinal)).records[0].reasonCode,
    "CODEX_EXECUTION_FINAL_MESSAGE_UNAVAILABLE",
  );
});

test("fresh context is bound to spawn start/completion, receiver, parent, and non-forked readback", () => {
  const missingStart = completeCase();
  missingStart.notifications.shift();
  assert.equal(
    collectCodexAppServerExecutions(input(missingStart)).records[0].reasonCode,
    "CODEX_EXECUTION_FRESH_CONTEXT_UNAVAILABLE",
  );

  const forked = completeCase({ forkedFromId: "thread:older" });
  assert.equal(
    collectCodexAppServerExecutions(input(forked)).records[0].reasonCode,
    "CODEX_EXECUTION_FRESH_CONTEXT_UNAVAILABLE",
  );

  const oldThread = completeCase({ createdAt: baseSecond - 2 });
  assert.equal(
    collectCodexAppServerExecutions(input(oldThread)).records[0].reasonCode,
    "CODEX_EXECUTION_FRESH_CONTEXT_UNAVAILABLE",
  );

  const wrongParent = completeCase({ parentThreadId: "thread:other-parent" });
  wrongParent.notifications[0].params.threadId = "thread:parent";
  wrongParent.notifications[0].params.item.senderThreadId = "thread:parent";
  wrongParent.notifications[1].params.threadId = "thread:parent";
  wrongParent.notifications[1].params.item.senderThreadId = "thread:parent";
  assert.equal(
    collectCodexAppServerExecutions(input(wrongParent)).records[0].reasonCode,
    "CODEX_EXECUTION_FRESH_CONTEXT_UNAVAILABLE",
  );
});

test("receiver/readback mismatch, cross-session contamination, and replay fail closed", () => {
  const receiverMismatch = completeCase();
  receiverMismatch.threadReadbacks[0].request.threadId = "thread:other";
  reason("CODEX_EXECUTION_SCHEMA_INVALID", () =>
    collectCodexAppServerExecutions(input(receiverMismatch)),
  );

  reason("CODEX_EXECUTION_SESSION_MISMATCH", () =>
    collectCodexAppServerExecutions(
      input(completeCase({ threadSessionId: "session:other" })),
    ),
  );

  const duplicateStart = completeCase();
  duplicateStart.notifications.push(structuredClone(duplicateStart.notifications[0]));
  reason("CODEX_EXECUTION_DUPLICATE_EVENT", () =>
    collectCodexAppServerExecutions(input(duplicateStart)),
  );

  const duplicateCompleted = completeCase();
  duplicateCompleted.notifications.push(structuredClone(duplicateCompleted.notifications[1]));
  reason("CODEX_EXECUTION_DUPLICATE_EVENT", () =>
    collectCodexAppServerExecutions(input(duplicateCompleted)),
  );

  const duplicateReadback = completeCase();
  duplicateReadback.threadReadbacks.push(structuredClone(duplicateReadback.threadReadbacks[0]));
  reason("CODEX_EXECUTION_DUPLICATE_EVENT", () =>
    collectCodexAppServerExecutions(input(duplicateReadback)),
  );
});

test("final output uses final_answer timing and must byte-match the readback", () => {
  const observation = completeCase();
  const completedTurn = observation.notifications.pop();
  observation.notifications.push(
    {
      method: "item/completed",
      params: {
        threadId: "thread:verity",
        turnId: "turn:verity-1",
        completedAtMs: (baseSecond + 4) * 1_000,
        item: {
          type: "agentMessage",
          id: "item:verity-final-older",
          text: "Older final answer.",
          phase: "final_answer",
          memoryCitation: null,
        },
      },
    },
    completedTurn,
  );
  observation.threadReadbacks[0].response.thread.turns[0].items.splice(1, 0, {
    type: "agentMessage",
    id: "item:verity-final-older",
    text: "Older final answer.",
    phase: "final_answer",
    memoryCitation: null,
  });
  const execution = collectCodexAppServerExecutions(input(observation)).records[0];
  assert.equal(execution.transcript.finalMessageItemId, "item:verity-final");

  const unknownPhase = completeCase({ finalPhase: null });
  assert.equal(
    collectCodexAppServerExecutions(input(unknownPhase)).records[0].reasonCode,
    "CODEX_EXECUTION_FINAL_MESSAGE_UNAVAILABLE",
  );

  const readbackDrift = completeCase();
  readbackDrift.threadReadbacks[0].response.thread.turns[0].items.find(
    (item) => item.id === "item:verity-final",
  ).text += " drift";
  assert.equal(
    collectCodexAppServerExecutions(input(readbackDrift)).records[0].reasonCode,
    "CODEX_EXECUTION_FINAL_MESSAGE_UNAVAILABLE",
  );
});

test("no candidates and an unpinned protocol remain honestly unavailable", () => {
  const none = collectCodexAppServerExecutions(
    input({ notifications: [], threadReadbacks: [] }),
  );
  assert.equal(none.availability, "unavailable");
  assert.equal(none.reasonCode, "CODEX_EXECUTION_UNAVAILABLE");
  assert.deepEqual(none.records, []);

  const drifted = collectCodexAppServerExecutions(
    input(completeCase(), {
      protocolDigest: `sha256:${"0".repeat(64)}`,
    }),
  );
  assert.equal(drifted.protocolBinding, "unpinned");
  assert.equal(drifted.reasonCode, "CODEX_EXECUTION_PROTOCOL_UNPINNED");
  assert.deepEqual(drifted.records, []);
});

test("the collector consumes supplied readbacks but contains no host-driving implementation", async () => {
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

test("fixture and schema evidence pin the corrected live/readback boundary", () => {
  assert.equal(
    fixture.schemaVersion,
    "tcrn.act10-codex-execution-collection-cases.v1",
  );
  assert.equal(fixture.readOnly, true);
  assert.equal(fixture.drivesHost, false);
  assert.equal(fixture.transcriptsSigned, false);
  assert.equal(fixture.liveHostProof, "live-app-server-readback-receipt-compared");
  assert.deepEqual(schemaEvidence.wireMethods, [
    "item/started",
    "item/completed",
    "thread/read",
    "turn/started",
    "turn/completed",
  ]);
  assert.equal(schemaEvidence.boundary.liveAttachClaimed, true);
  assert.equal(schemaEvidence.boundary.liveSubagentReceiptClaimed, true);
  assert.equal(schemaEvidence.boundary.syntheticThreadStartedAdded, false);
});
