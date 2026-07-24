// SPDX-License-Identifier: Apache-2.0
//
// INIT-010 EPIC-020 S054: Codex App Server execution collection.
//
// This module consumes a notification stream that an external read-only observer
// already received. It never starts App Server, sends a JSON-RPC request, creates a
// thread, or invokes an agent. From the current version-pinned notification shapes
// it correlates:
//
//   collabAgentToolCall(spawnAgent) -> thread/started(subagent)
//   -> turn/started + turn/completed -> item/completed(agentMessage)
//
// A complete correlation becomes the host-neutral ObservedInvocation consumed by
// execution-collection.ts, with real session/thread/turn bindings. Missing prompt,
// final message, timestamps, or a pinned schema does not get guessed: that candidate
// is returned as `unavailable`. The compact transcript contains digests, not raw
// prompt text, and is not host-signed. As everywhere in EPIC-019/020, this is
// attribution evidence rather than identity proof.

import { createHash } from "node:crypto";

import {
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
} from "../../protocol/src/index.js";
import {
  OBSERVER_COVERAGE_NOTE,
  observeAppServerStream,
} from "./app-server-observer.js";
import type {
  ObservationInput,
  ObservationReceipt,
} from "./app-server-observer.js";
import {
  COLLECTION_ATTRIBUTION_NOTE,
  collectExecutionReceipt,
} from "./execution-collection.js";
import type {
  CollectedReceipt,
  ObservedInvocation,
} from "./execution-collection.js";

export const CODEX_EXECUTION_COLLECTION_VERSION =
  "tcrn.codex-execution-collection.v1" as const;
export const CODEX_EXECUTION_TRANSCRIPT_VERSION =
  "tcrn.codex-execution-transcript.v1" as const;

export const CODEX_EXECUTION_REASON_CODES = Object.freeze([
  "CODEX_EXECUTION_DUPLICATE_EVENT",
  "CODEX_EXECUTION_FINAL_MESSAGE_UNAVAILABLE",
  "CODEX_EXECUTION_FRESH_CONTEXT_UNAVAILABLE",
  "CODEX_EXECUTION_OBSERVED",
  "CODEX_EXECUTION_PROMPT_UNAVAILABLE",
  "CODEX_EXECUTION_PROTOCOL_UNPINNED",
  "CODEX_EXECUTION_SCHEMA_INVALID",
  "CODEX_EXECUTION_SESSION_MISMATCH",
  "CODEX_EXECUTION_THREAD_UNAVAILABLE",
  "CODEX_EXECUTION_TURN_UNAVAILABLE",
  "CODEX_EXECUTION_UNAVAILABLE",
] as const);
export type CodexExecutionReasonCode =
  typeof CODEX_EXECUTION_REASON_CODES[number];

export class CodexExecutionCollectionError extends Error {
  readonly reasonCode: CodexExecutionReasonCode;

  constructor(reasonCode: CodexExecutionReasonCode, message: string) {
    super(message);
    this.name = "CodexExecutionCollectionError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: CodexExecutionReasonCode, message: string): never {
  throw new CodexExecutionCollectionError(reasonCode, message);
}

function record(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", label);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringValue(
  value: unknown,
  label: string,
  maximumBytes = 16_384,
): string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", label);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function instantFromSeconds(value: unknown, label: string): string {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value * 1_000 > 8_640_000_000_000_000
  ) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", label);
  }
  return new Date(value * 1_000).toISOString();
}

interface ThreadFact {
  readonly id: string;
  readonly sessionId: string;
  readonly parentThreadId: string;
  readonly forkedFromId: string | null;
  readonly ephemeral: boolean;
  readonly createdAt: number;
}

interface SpawnFact {
  readonly id: string;
  readonly senderThreadId: string;
  readonly receiverThreadId: string;
  readonly prompt: string | null;
  readonly completedAtMs: number;
}

interface TurnFact {
  readonly id: string;
  readonly threadId: string;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
}

interface MessageFact {
  readonly id: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly text: string;
  readonly phase: "commentary" | "final_answer" | null;
  readonly completedAtMs: number;
}

export interface CodexExecutionTranscript {
  readonly schemaVersion: typeof CODEX_EXECUTION_TRANSCRIPT_VERSION;
  readonly sessionId: string;
  readonly threadId: string;
  readonly parentThreadId: string;
  readonly turnId: string;
  readonly spawnItemId: string;
  readonly promptDigest: string;
  readonly spawnCompletedAt: string;
  readonly threadCreatedAt: string;
  readonly freshContextBasis: "new_subagent_thread_not_forked_after_spawn";
  readonly finalMessageItemId: string;
  readonly finalMessageCompletedAt: string;
  readonly outputDigest: string;
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface CodexObservedExecution {
  readonly availability: "observe";
  readonly reasonCode: "CODEX_EXECUTION_OBSERVED";
  readonly sessionId: string;
  readonly threadId: string;
  readonly parentThreadId: string;
  readonly turnId: string;
  readonly spawnItemId: string;
  readonly observed: ObservedInvocation;
  readonly transcript: CodexExecutionTranscript;
  readonly transcriptSource: string;
  readonly transcriptSigned: false;
  readonly attributionNote: typeof COLLECTION_ATTRIBUTION_NOTE;
  readonly recordDigest: string;
}

export interface CodexUnavailableExecution {
  readonly availability: "unavailable";
  readonly reasonCode:
    | "CODEX_EXECUTION_PROMPT_UNAVAILABLE"
    | "CODEX_EXECUTION_FINAL_MESSAGE_UNAVAILABLE"
    | "CODEX_EXECUTION_FRESH_CONTEXT_UNAVAILABLE"
    | "CODEX_EXECUTION_THREAD_UNAVAILABLE"
    | "CODEX_EXECUTION_TURN_UNAVAILABLE";
  readonly sessionId: string;
  readonly threadId: string;
  readonly parentThreadId: string;
  readonly turnId: string | null;
  readonly spawnItemId: string | null;
  readonly observed: null;
  readonly transcript: null;
  readonly transcriptSource: null;
  readonly transcriptSigned: false;
  readonly attributionNote: typeof COLLECTION_ATTRIBUTION_NOTE;
  readonly recordDigest: string;
}

export type CodexExecutionRecord =
  | CodexObservedExecution
  | CodexUnavailableExecution;

export interface CodexExecutionCollection {
  readonly schemaVersion: typeof CODEX_EXECUTION_COLLECTION_VERSION;
  readonly hostProduct: string;
  readonly hostVersion: string;
  readonly sessionId: string;
  readonly protocolDigest: string;
  readonly protocolBinding: ObservationReceipt["protocolBinding"];
  readonly availability: "observe" | "unavailable";
  readonly reasonCode:
    | "CODEX_EXECUTION_OBSERVED"
    | "CODEX_EXECUTION_PROTOCOL_UNPINNED"
    | "CODEX_EXECUTION_UNAVAILABLE";
  readonly observationReceipt: ObservationReceipt;
  readonly records: readonly CodexExecutionRecord[];
  readonly observedInvocations: number;
  readonly unavailableInvocations: number;
  readonly readOnly: true;
  readonly drivesHost: false;
  readonly coverageNote: string;
  readonly attributionNote: typeof COLLECTION_ATTRIBUTION_NOTE;
  readonly collectionDigest: string;
}

const observedExecutionRecords = new WeakSet<object>();

function unavailable(
  reasonCode: CodexUnavailableExecution["reasonCode"],
  sessionId: string,
  thread: ThreadFact,
  turnId: string | null,
  spawnItemId: string | null,
): CodexUnavailableExecution {
  const basis = {
    availability: "unavailable" as const,
    reasonCode,
    sessionId,
    threadId: thread.id,
    parentThreadId: thread.parentThreadId,
    turnId,
    spawnItemId,
    observed: null,
    transcript: null,
    transcriptSource: null,
    transcriptSigned: false as const,
    attributionNote: COLLECTION_ATTRIBUTION_NOTE,
  };
  return deepFreeze({ ...basis, recordDigest: canonicalSha256(basis) });
}

function addUnique<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  label: string,
): void {
  if (map.has(key)) fail("CODEX_EXECUTION_DUPLICATE_EVENT", `${label}:${key}`);
  map.set(key, value);
}

function nullableSeconds(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", label);
  }
  return value;
}

function milliseconds(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", label);
  }
  return value;
}

function nullableString(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : stringValue(value, label, 512);
}

// Consume current Codex v2 notification shapes. Only the fields needed for the
// binding survive; cwd, model, reasoning and other host payloads are ignored.
export function collectCodexAppServerExecutions(
  inputValue: unknown,
): CodexExecutionCollection {
  const observationReceipt = observeAppServerStream(inputValue);
  const input = record(inputValue, "Codex execution observation input");
  const notifications = input.notifications;
  if (!Array.isArray(notifications)) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", "notifications");
  }
  const hostProduct = stringValue(input.hostProduct, "hostProduct", 512);
  const hostVersion = stringValue(input.hostVersion, "hostVersion", 512);
  const sessionId = stringValue(input.sessionId, "sessionId", 512);
  const protocolDigest = stringValue(input.protocolDigest, "protocolDigest", 512);
  if (hostProduct !== "Codex CLI") {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", "hostProduct");
  }

  if (observationReceipt.protocolBinding !== "pinned") {
    const basis = {
      schemaVersion: CODEX_EXECUTION_COLLECTION_VERSION,
      hostProduct,
      hostVersion,
      sessionId,
      protocolDigest,
      protocolBinding: observationReceipt.protocolBinding,
      availability: "unavailable" as const,
      reasonCode: "CODEX_EXECUTION_PROTOCOL_UNPINNED" as const,
      observationReceipt,
      records: Object.freeze([]) as readonly CodexExecutionRecord[],
      observedInvocations: 0,
      unavailableInvocations: 0,
      readOnly: true as const,
      drivesHost: false as const,
      coverageNote: OBSERVER_COVERAGE_NOTE,
      attributionNote: COLLECTION_ATTRIBUTION_NOTE,
    };
    return deepFreeze({ ...basis, collectionDigest: canonicalSha256(basis) });
  }

  const threads = new Map<string, ThreadFact>();
  const spawnsByReceiver = new Map<string, SpawnFact[]>();
  const turnStarts = new Map<string, TurnFact>();
  const turnCompletions = new Map<string, TurnFact>();
  const messagesByTurn = new Map<string, MessageFact[]>();
  const completedItems = new Set<string>();

  for (const frameValue of notifications) {
    if (
      typeof frameValue !== "object" ||
      frameValue === null ||
      Array.isArray(frameValue)
    ) {
      continue;
    }
    const frame = frameValue as Readonly<Record<string, unknown>>;
    if (typeof frame.method !== "string") continue;
    if (
      frame.method !== "thread/started" &&
      frame.method !== "turn/started" &&
      frame.method !== "turn/completed" &&
      frame.method !== "item/completed"
    ) {
      continue;
    }
    const params = record(frame.params, `${frame.method}.params`);

    if (frame.method === "thread/started") {
      const thread = record(params.thread, "thread/started.params.thread");
      const id = stringValue(thread.id, "thread.id", 512);
      const threadSessionId = stringValue(
        thread.sessionId,
        "thread.sessionId",
        512,
      );
      if (threadSessionId !== sessionId) {
        fail("CODEX_EXECUTION_SESSION_MISMATCH", id);
      }
      if (
        thread.threadSource !== "subagent" ||
        typeof thread.parentThreadId !== "string" ||
        thread.parentThreadId.length === 0
      ) {
        continue;
      }
      addUnique(
        threads,
        id,
        {
          id,
          sessionId: threadSessionId,
          parentThreadId: stringValue(
            thread.parentThreadId,
            "thread.parentThreadId",
            512,
          ),
          forkedFromId: nullableString(
            thread.forkedFromId,
            "thread.forkedFromId",
          ),
          ephemeral:
            typeof thread.ephemeral === "boolean"
              ? thread.ephemeral
              : fail("CODEX_EXECUTION_SCHEMA_INVALID", "thread.ephemeral"),
          createdAt:
            nullableSeconds(thread.createdAt, "thread.createdAt") ??
            fail("CODEX_EXECUTION_SCHEMA_INVALID", "thread.createdAt"),
        },
        "thread/started",
      );
      continue;
    }

    if (frame.method === "turn/started" || frame.method === "turn/completed") {
      const threadId = stringValue(params.threadId, "turn.threadId", 512);
      const turn = record(params.turn, `${frame.method}.params.turn`);
      const turnId = stringValue(turn.id, "turn.id", 512);
      const fact: TurnFact = {
        id: turnId,
        threadId,
        startedAt: nullableSeconds(turn.startedAt, "turn.startedAt"),
        completedAt: nullableSeconds(turn.completedAt, "turn.completedAt"),
      };
      addUnique(
        frame.method === "turn/started" ? turnStarts : turnCompletions,
        `${threadId}\u0000${turnId}`,
        fact,
        frame.method,
      );
      continue;
    }

    const threadId = stringValue(params.threadId, "item.threadId", 512);
    const turnId = stringValue(params.turnId, "item.turnId", 512);
    const completedAtMs = milliseconds(
      params.completedAtMs,
      "item.completedAtMs",
    );
    const item = record(params.item, "item/completed.params.item");
    const itemId = stringValue(item.id, "item.id", 512);
    const itemKey = `${threadId}\u0000${turnId}\u0000${itemId}`;
    if (completedItems.has(itemKey)) {
      fail("CODEX_EXECUTION_DUPLICATE_EVENT", `item/completed:${itemKey}`);
    }
    completedItems.add(itemKey);
    if (
      item.type === "collabAgentToolCall" &&
      item.tool === "spawnAgent" &&
      item.status === "completed"
    ) {
      const senderThreadId = stringValue(
        item.senderThreadId,
        "spawn.senderThreadId",
        512,
      );
      if (!Array.isArray(item.receiverThreadIds)) {
        fail("CODEX_EXECUTION_SCHEMA_INVALID", "spawn.receiverThreadIds");
      }
      const prompt =
        item.prompt === null
          ? null
          : stringValue(item.prompt, "spawn.prompt", 16_384);
      for (const receiver of item.receiverThreadIds) {
        const receiverThreadId = stringValue(
          receiver,
          "spawn.receiverThreadId",
          512,
        );
        const facts = spawnsByReceiver.get(receiverThreadId) ?? [];
        facts.push({
          id: itemId,
          senderThreadId,
          receiverThreadId,
          prompt,
          completedAtMs,
        });
        spawnsByReceiver.set(receiverThreadId, facts);
      }
    } else if (item.type === "agentMessage") {
      const message: MessageFact = {
        id: itemId,
        threadId,
        turnId,
        text: stringValue(item.text, "agentMessage.text", 65_536),
        phase:
          item.phase === null
            ? null
            : item.phase === "commentary" || item.phase === "final_answer"
              ? item.phase
              : fail("CODEX_EXECUTION_SCHEMA_INVALID", "agentMessage.phase"),
        completedAtMs,
      };
      const key = `${threadId}\u0000${turnId}`;
      const messages = messagesByTurn.get(key) ?? [];
      messages.push(message);
      messagesByTurn.set(key, messages);
    }
  }

  const records: CodexExecutionRecord[] = [];
  for (const thread of [...threads.values()].sort((left, right) =>
    compareCanonicalText(left.id, right.id),
  )) {
    const spawns = (spawnsByReceiver.get(thread.id) ?? []).filter(
      (spawn) => spawn.senderThreadId === thread.parentThreadId,
    );
    const completedTurns = [...turnCompletions.values()]
      .filter((turn) => turn.threadId === thread.id)
      .sort((left, right) => {
        const leftStarted = left.startedAt ?? Number.POSITIVE_INFINITY;
        const rightStarted = right.startedAt ?? Number.POSITIVE_INFINITY;
        return leftStarted === rightStarted
          ? compareCanonicalText(left.id, right.id)
          : leftStarted - rightStarted;
      });
    const firstTurn = completedTurns[0];
    if (firstTurn === undefined) {
      records.push(
        unavailable(
          "CODEX_EXECUTION_TURN_UNAVAILABLE",
          sessionId,
          thread,
          null,
          spawns.length === 1 ? spawns[0]?.id ?? null : null,
        ),
      );
      continue;
    }
    const turnKey = `${thread.id}\u0000${firstTurn.id}`;
    const started = turnStarts.get(turnKey);
    if (
      started === undefined ||
      started.startedAt === null ||
      firstTurn.completedAt === null
    ) {
      records.push(
        unavailable(
          "CODEX_EXECUTION_TURN_UNAVAILABLE",
          sessionId,
          thread,
          firstTurn.id,
          spawns.length === 1 ? spawns[0]?.id ?? null : null,
        ),
      );
      continue;
    }
    if (spawns.length !== 1 || spawns[0]?.prompt === null) {
      records.push(
        unavailable(
          "CODEX_EXECUTION_PROMPT_UNAVAILABLE",
          sessionId,
          thread,
          firstTurn.id,
          spawns.length === 1 ? spawns[0]?.id ?? null : null,
        ),
      );
      continue;
    }
    const spawn = spawns[0] as SpawnFact & { readonly prompt: string };
    const freshContext =
      thread.forkedFromId === null &&
      thread.createdAt * 1_000 >= spawn.completedAtMs;
    if (!freshContext) {
      records.push(
        unavailable(
          "CODEX_EXECUTION_FRESH_CONTEXT_UNAVAILABLE",
          sessionId,
          thread,
          firstTurn.id,
          spawn.id,
        ),
      );
      continue;
    }
    const messages = (messagesByTurn.get(turnKey) ?? [])
      .filter((message) => message.phase === "final_answer")
      .sort((left, right) =>
        left.completedAtMs === right.completedAtMs
          ? compareCanonicalText(left.id, right.id)
          : left.completedAtMs - right.completedAtMs,
      );
    const finalMessage = messages[messages.length - 1];
    if (finalMessage === undefined) {
      records.push(
        unavailable(
          "CODEX_EXECUTION_FINAL_MESSAGE_UNAVAILABLE",
          sessionId,
          thread,
          firstTurn.id,
          spawn.id,
        ),
      );
      continue;
    }
    const startedAt = instantFromSeconds(started.startedAt, "startedAt");
    const endedAt = instantFromSeconds(firstTurn.completedAt, "completedAt");
    if (endedAt < startedAt) {
      fail("CODEX_EXECUTION_SCHEMA_INVALID", `turn order:${firstTurn.id}`);
    }
    if (
      finalMessage.completedAtMs < started.startedAt * 1_000 ||
      finalMessage.completedAtMs > firstTurn.completedAt * 1_000
    ) {
      fail(
        "CODEX_EXECUTION_SCHEMA_INVALID",
        `final message order:${finalMessage.id}`,
      );
    }
    const promptDigest = digest(spawn.prompt);
    const transcript: CodexExecutionTranscript = deepFreeze({
      schemaVersion: CODEX_EXECUTION_TRANSCRIPT_VERSION,
      sessionId,
      threadId: thread.id,
      parentThreadId: thread.parentThreadId,
      turnId: firstTurn.id,
      spawnItemId: spawn.id,
      promptDigest,
      spawnCompletedAt: new Date(spawn.completedAtMs).toISOString(),
      threadCreatedAt: instantFromSeconds(
        thread.createdAt,
        "threadCreatedAt",
      ),
      freshContextBasis:
        "new_subagent_thread_not_forked_after_spawn" as const,
      finalMessageItemId: finalMessage.id,
      finalMessageCompletedAt: new Date(
        finalMessage.completedAtMs,
      ).toISOString(),
      outputDigest: digest(finalMessage.text),
      startedAt,
      endedAt,
    });
    const transcriptSource = canonicalJson(transcript);
    const observed: ObservedInvocation = deepFreeze({
      agentInvocationId: spawn.id,
      startedAt,
      endedAt,
      freshContext,
      promptDigest,
      finalMessage: finalMessage.text,
      transcriptPath: `codex-app-server:${sessionId}/${thread.id}/${firstTurn.id}`,
      transcriptDigest: digest(transcriptSource),
      transcriptBytes: Buffer.byteLength(transcriptSource, "utf8"),
    });
    const basis = {
      availability: "observe" as const,
      reasonCode: "CODEX_EXECUTION_OBSERVED" as const,
      sessionId,
      threadId: thread.id,
      parentThreadId: thread.parentThreadId,
      turnId: firstTurn.id,
      spawnItemId: spawn.id,
      observed,
      transcript,
      transcriptSource,
      transcriptSigned: false as const,
      attributionNote: COLLECTION_ATTRIBUTION_NOTE,
    };
    const complete = deepFreeze({
      ...basis,
      recordDigest: canonicalSha256(basis),
    });
    observedExecutionRecords.add(complete);
    records.push(complete);
  }

  const observedInvocations = records.filter(
    (entry) => entry.availability === "observe",
  ).length;
  const unavailableInvocations = records.length - observedInvocations;
  const availability = observedInvocations > 0 ? "observe" : "unavailable";
  const reasonCode =
    observedInvocations > 0
      ? "CODEX_EXECUTION_OBSERVED"
      : "CODEX_EXECUTION_UNAVAILABLE";
  const basis = {
    schemaVersion: CODEX_EXECUTION_COLLECTION_VERSION,
    hostProduct,
    hostVersion,
    sessionId,
    protocolDigest,
    protocolBinding: observationReceipt.protocolBinding,
    availability,
    reasonCode,
    observationReceipt,
    records,
    observedInvocations,
    unavailableInvocations,
    readOnly: true as const,
    drivesHost: false as const,
    coverageNote: OBSERVER_COVERAGE_NOTE,
    attributionNote: COLLECTION_ATTRIBUTION_NOTE,
  };
  return deepFreeze({
    ...basis,
    collectionDigest: canonicalSha256(basis),
  }) as CodexExecutionCollection;
}

// Project a generated complete Codex record into EPIC-019's host-execution receipt.
// The WeakSet prevents a caller from fabricating a structurally similar record and
// passing it through as collector output.
export function collectCodexExecutionReceipt(
  execution: CodexObservedExecution,
  positionId: string,
  receiptId: string,
  conferenceId: string,
  hostProduct: string,
  hostVersion: string,
): CollectedReceipt {
  if (!observedExecutionRecords.has(execution)) {
    fail(
      "CODEX_EXECUTION_SCHEMA_INVALID",
      "collector-generated observed execution required",
    );
  }
  return collectExecutionReceipt(execution.observed, positionId, receiptId, {
    hostProduct,
    hostVersion,
    sessionId: execution.sessionId,
    conferenceId,
    availability: "observe",
    threadId: execution.threadId,
    turnId: execution.turnId,
  });
}

// Type-only assertion that the input contract stays the host-neutral Observer
// contract. It is exported so consumers can pin the exact supplied-stream shape.
export type CodexExecutionObservationInput = ObservationInput;
