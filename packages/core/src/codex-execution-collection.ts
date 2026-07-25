// SPDX-License-Identifier: Apache-2.0
//
// INIT-010 EPIC-020 S054: Codex App Server execution collection.
//
// This module consumes a notification stream plus captured thread/read(includeTurns)
// responses that an external read-only observer already received. It never starts
// App Server, sends a JSON-RPC request, creates a thread, or invokes an agent. From
// the current version-pinned shapes it correlates:
//
//   item/started + item/completed(collabAgentToolCall/spawnAgent)
//   -> receiver thread/read(includeTurns=true)
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
  "tcrn.codex-execution-collection.v2" as const;
export const CODEX_EXECUTION_TRANSCRIPT_VERSION =
  "tcrn.codex-execution-transcript.v2" as const;

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

function exactFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  if (
    actual.length !== wanted.length ||
    wanted.some((field, index) => field !== actual[index])
  ) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", label);
  }
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
  readonly threadSource: "subagent";
  readonly ephemeral: boolean;
  readonly createdAt: number;
  readonly turns: readonly ReadbackTurnFact[];
  readonly readbackDigest: string;
}

interface ThreadStartFact {
  readonly id: string;
  readonly sessionId: string;
  readonly parentThreadId: string;
  readonly forkedFromId: string | null;
  readonly threadSource: "subagent";
  readonly ephemeral: boolean;
  readonly createdAt: number;
}

interface SpawnFact {
  readonly id: string;
  readonly senderThreadId: string;
  readonly senderTurnId: string;
  readonly receiverThreadId: string;
  readonly prompt: string | null;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number;
}

interface ReadbackItemFact {
  readonly id: string;
  readonly type: string;
  readonly text: string | null;
  readonly phase: "commentary" | "final_answer" | null;
}

interface ReadbackTurnFact {
  readonly id: string;
  readonly status: string;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly items: readonly ReadbackItemFact[];
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
  readonly spawnStartedAt: string;
  readonly spawnCompletedAt: string;
  readonly threadCreatedAt: string;
  readonly threadReadbackDigest: string;
  readonly threadStartedNotificationObserved: boolean;
  readonly freshContextBasis: "spawn_lifecycle_overlaps_non_forked_subagent_thread_readback";
  readonly finalMessageItemId: string;
  readonly readbackFinalMessageItemId: string;
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
  threadId: string,
  parentThreadId: string,
  turnId: string | null,
  spawnItemId: string | null,
): CodexUnavailableExecution {
  const basis = {
    availability: "unavailable" as const,
    reasonCode,
    sessionId,
    threadId,
    parentThreadId,
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

function readbackItem(value: unknown, label: string): ReadbackItemFact {
  const item = record(value, label);
  const type = stringValue(item.type, `${label}.type`, 128);
  const id = stringValue(item.id, `${label}.id`, 512);
  if (type !== "agentMessage") {
    return { id, type, text: null, phase: null };
  }
  const text = stringValue(item.text, `${label}.text`, 65_536);
  const phase =
    item.phase === null
      ? null
      : item.phase === "commentary" || item.phase === "final_answer"
        ? item.phase
        : fail("CODEX_EXECUTION_SCHEMA_INVALID", `${label}.phase`);
  return { id, type, text, phase };
}

function readbackTurn(value: unknown, label: string): ReadbackTurnFact {
  const turn = record(value, label);
  if (!Array.isArray(turn.items)) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", `${label}.items`);
  }
  return {
    id: stringValue(turn.id, `${label}.id`, 512),
    status: stringValue(turn.status, `${label}.status`, 128),
    startedAt: nullableSeconds(turn.startedAt, `${label}.startedAt`),
    completedAt: nullableSeconds(turn.completedAt, `${label}.completedAt`),
    items: turn.items.map((item, index) =>
      readbackItem(item, `${label}.items[${index}]`),
    ),
  };
}

function readbackThread(value: unknown, sessionId: string, label: string): ThreadFact {
  const wrapper = record(value, label);
  exactFields(wrapper, ["request", "response"], label);
  const request = record(wrapper.request, `${label}.request`);
  exactFields(request, ["threadId", "includeTurns"], `${label}.request`);
  const requestedThreadId = stringValue(
    request.threadId,
    `${label}.request.threadId`,
    512,
  );
  if (request.includeTurns !== true) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", `${label}.request.includeTurns`);
  }
  const response = record(wrapper.response, `${label}.response`);
  exactFields(response, ["thread"], `${label}.response`);
  const thread = record(response.thread, `${label}.response.thread`);
  const id = stringValue(thread.id, `${label}.thread.id`, 512);
  if (id !== requestedThreadId) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", `${label}.request/response threadId`);
  }
  const threadSessionId = stringValue(
    thread.sessionId,
    `${label}.thread.sessionId`,
    512,
  );
  if (threadSessionId !== sessionId) {
    fail("CODEX_EXECUTION_SESSION_MISMATCH", id);
  }
  if (!Array.isArray(thread.turns)) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", `${label}.thread.turns`);
  }
  const turns = thread.turns.map((turn, index) =>
    readbackTurn(turn, `${label}.thread.turns[${index}]`),
  );
  if (new Set(turns.map((turn) => turn.id)).size !== turns.length) {
    fail("CODEX_EXECUTION_DUPLICATE_EVENT", `${label}.thread.turns`);
  }
  for (const turn of turns) {
    if (new Set(turn.items.map((item) => item.id)).size !== turn.items.length) {
      fail("CODEX_EXECUTION_DUPLICATE_EVENT", `${label}.thread.turn:${turn.id}.items`);
    }
  }
  const parentThreadId =
    thread.parentThreadId === null
      ? ""
      : stringValue(
          thread.parentThreadId,
          `${label}.thread.parentThreadId`,
          512,
        );
  const declaredThreadSource =
    thread.threadSource === null
      ? null
      : stringValue(thread.threadSource, `${label}.thread.threadSource`, 128);
  if (declaredThreadSource !== null && declaredThreadSource !== "subagent") {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", `${label}.thread.threadSource`);
  }
  if (declaredThreadSource === null) {
    const source = record(thread.source, `${label}.thread.source`);
    const subAgent = record(source.subAgent, `${label}.thread.source.subAgent`);
    const threadSpawn = record(
      subAgent.thread_spawn,
      `${label}.thread.source.subAgent.thread_spawn`,
    );
    if (
      stringValue(
        threadSpawn.parent_thread_id,
        `${label}.thread.source parent`,
        512,
      ) !== parentThreadId
    ) {
      fail("CODEX_EXECUTION_SCHEMA_INVALID", `${label}.thread.source parent`);
    }
  }
  const basis = {
    id,
    sessionId: threadSessionId,
    parentThreadId,
    forkedFromId: nullableString(
      thread.forkedFromId,
      `${label}.thread.forkedFromId`,
    ),
    threadSource: "subagent" as const,
    ephemeral:
      typeof thread.ephemeral === "boolean"
        ? thread.ephemeral
        : fail("CODEX_EXECUTION_SCHEMA_INVALID", `${label}.thread.ephemeral`),
    createdAt:
      nullableSeconds(thread.createdAt, `${label}.thread.createdAt`) ??
      fail("CODEX_EXECUTION_SCHEMA_INVALID", `${label}.thread.createdAt`),
    turns,
  };
  if (basis.parentThreadId.length === 0) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", `${label}.thread is not a subagent`);
  }
  const digestBasis = {
    ...basis,
    turns: turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      items: turn.items.map((item) => ({
        id: item.id,
        type: item.type,
        phase: item.phase,
        textDigest: item.text === null ? null : digest(item.text),
      })),
    })),
  };
  return deepFreeze({
    id: basis.id,
    sessionId: basis.sessionId,
    parentThreadId: basis.parentThreadId,
    forkedFromId: basis.forkedFromId,
    threadSource: basis.threadSource,
    ephemeral: basis.ephemeral,
    createdAt: basis.createdAt,
    turns: basis.turns,
    readbackDigest: canonicalSha256(digestBasis),
  });
}

// Consume current Codex v2 notification shapes. Only the fields needed for the
// binding survive; cwd, model, reasoning and other host payloads are ignored.
export function collectCodexAppServerExecutions(
  inputValue: unknown,
): CodexExecutionCollection {
  const input = record(inputValue, "Codex execution observation input");
  exactFields(
    input,
    [
      "hostProduct",
      "hostVersion",
      "sessionId",
      "protocolDigest",
      "observedFrom",
      "observedTo",
      "notifications",
      "threadReadbacks",
    ],
    "Codex execution observation input",
  );
  const notifications = input.notifications;
  if (!Array.isArray(notifications)) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", "notifications");
  }
  if (!Array.isArray(input.threadReadbacks)) {
    fail("CODEX_EXECUTION_SCHEMA_INVALID", "threadReadbacks");
  }
  const hostProduct = stringValue(input.hostProduct, "hostProduct", 512);
  const hostVersion = stringValue(input.hostVersion, "hostVersion", 512);
  const sessionId = stringValue(input.sessionId, "sessionId", 512);
  const protocolDigest = stringValue(input.protocolDigest, "protocolDigest", 512);
  const observationReceipt = observeAppServerStream({
    hostProduct,
    hostVersion,
    sessionId,
    protocolDigest,
    observedFrom: input.observedFrom,
    observedTo: input.observedTo,
    notifications,
  });
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

  const threadReadbacks = new Map<string, ThreadFact>();
  for (const [index, readbackValue] of input.threadReadbacks.entries()) {
    const thread = readbackThread(
      readbackValue,
      sessionId,
      `threadReadbacks[${index}]`,
    );
    addUnique(threadReadbacks, thread.id, thread, "thread/read");
  }
  const threadStarts = new Map<string, ThreadStartFact>();
  const spawnsByReceiver = new Map<string, SpawnFact[]>();
  const spawnStarts = new Map<string, {
    readonly id: string;
    readonly senderThreadId: string;
    readonly senderTurnId: string;
    readonly prompt: string | null;
    readonly startedAtMs: number;
  }>();
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
      frame.method !== "item/started" &&
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
        threadStarts,
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
          threadSource: "subagent",
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
    const item = record(params.item, `${frame.method}.params.item`);
    const itemId = stringValue(item.id, "item.id", 512);
    const itemKey = `${threadId}\u0000${turnId}\u0000${itemId}`;

    if (frame.method === "item/started") {
      if (
        item.type === "collabAgentToolCall" &&
        item.tool === "spawnAgent" &&
        item.status === "inProgress"
      ) {
        const senderThreadId = stringValue(
          item.senderThreadId,
          "spawn.senderThreadId",
          512,
        );
        if (senderThreadId !== threadId) {
          fail("CODEX_EXECUTION_SCHEMA_INVALID", "spawn sender/thread mismatch");
        }
        const prompt =
          item.prompt === null
            ? null
            : stringValue(item.prompt, "spawn.prompt", 16_384);
        addUnique(
          spawnStarts,
          itemKey,
          {
            id: itemId,
            senderThreadId,
            senderTurnId: turnId,
            prompt,
            startedAtMs: milliseconds(
              params.startedAtMs,
              "item.startedAtMs",
            ),
          },
          "item/started:spawnAgent",
        );
      }
      continue;
    }

    const completedAtMs = milliseconds(
      params.completedAtMs,
      "item.completedAtMs",
    );
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
      if (senderThreadId !== threadId) {
        fail("CODEX_EXECUTION_SCHEMA_INVALID", "spawn sender/thread mismatch");
      }
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
          senderTurnId: turnId,
          receiverThreadId,
          prompt,
          startedAtMs: spawnStarts.get(itemKey)?.startedAtMs ?? null,
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
  for (const [receiverThreadId, spawns] of [...spawnsByReceiver.entries()].sort(
    ([left], [right]) => compareCanonicalText(left, right),
  )) {
    const representative = spawns[0];
    if (representative === undefined) continue;
    if (spawns.length !== 1) {
      records.push(
        unavailable(
          "CODEX_EXECUTION_PROMPT_UNAVAILABLE",
          sessionId,
          receiverThreadId,
          representative.senderThreadId,
          null,
          null,
        ),
      );
      continue;
    }
    const spawn = representative;
    const thread = threadReadbacks.get(receiverThreadId);
    if (thread === undefined) {
      records.push(
        unavailable(
          "CODEX_EXECUTION_THREAD_UNAVAILABLE",
          sessionId,
          receiverThreadId,
          spawn.senderThreadId,
          null,
          spawn.id,
        ),
      );
      continue;
    }
    const threadStart = threadStarts.get(thread.id);
    if (
      threadStart !== undefined &&
      (threadStart.sessionId !== thread.sessionId ||
        threadStart.parentThreadId !== thread.parentThreadId ||
        threadStart.forkedFromId !== thread.forkedFromId ||
        threadStart.threadSource !== thread.threadSource ||
        threadStart.ephemeral !== thread.ephemeral ||
        threadStart.createdAt !== thread.createdAt)
    ) {
      fail("CODEX_EXECUTION_SCHEMA_INVALID", `thread surfaces disagree:${thread.id}`);
    }
    const orderedTurns = [...thread.turns].sort((left, right) => {
      const leftStarted = left.startedAt ?? Number.POSITIVE_INFINITY;
      const rightStarted = right.startedAt ?? Number.POSITIVE_INFINITY;
      return leftStarted === rightStarted
        ? compareCanonicalText(left.id, right.id)
        : leftStarted - rightStarted;
    });
    const firstTurn = orderedTurns[0];
    if (firstTurn === undefined) {
      records.push(
        unavailable(
          "CODEX_EXECUTION_TURN_UNAVAILABLE",
          sessionId,
          thread.id,
          thread.parentThreadId,
          null,
          spawn.id,
        ),
      );
      continue;
    }
    const turnKey = `${thread.id}\u0000${firstTurn.id}`;
    const started = turnStarts.get(turnKey);
    const completed = turnCompletions.get(turnKey);
    if (
      firstTurn.status !== "completed" ||
      firstTurn.startedAt === null ||
      firstTurn.completedAt === null ||
      started === undefined ||
      completed === undefined ||
      started.startedAt !== firstTurn.startedAt ||
      completed.startedAt !== firstTurn.startedAt ||
      completed.completedAt !== firstTurn.completedAt
    ) {
      records.push(
        unavailable(
          "CODEX_EXECUTION_TURN_UNAVAILABLE",
          sessionId,
          thread.id,
          thread.parentThreadId,
          firstTurn.id,
          spawn.id,
        ),
      );
      continue;
    }
    if (spawn.prompt === null) {
      records.push(
        unavailable(
          "CODEX_EXECUTION_PROMPT_UNAVAILABLE",
          sessionId,
          thread.id,
          thread.parentThreadId,
          firstTurn.id,
          spawn.id,
        ),
      );
      continue;
    }
    const spawnStart = spawnStarts.get(
      `${spawn.senderThreadId}\u0000${spawn.senderTurnId}\u0000${spawn.id}`,
    );
    const creationSecondStartMs = thread.createdAt * 1_000;
    const creationSecondEndMs = creationSecondStartMs + 999;
    const freshContext =
      thread.forkedFromId === null &&
      thread.parentThreadId === spawn.senderThreadId &&
      spawnStart !== undefined &&
      spawn.startedAtMs !== null &&
      spawnStart.startedAtMs === spawn.startedAtMs &&
      spawnStart.prompt === spawn.prompt &&
      spawn.startedAtMs <= spawn.completedAtMs &&
      creationSecondEndMs >= spawn.startedAtMs &&
      creationSecondStartMs <= spawn.completedAtMs &&
      firstTurn.startedAt >= thread.createdAt;
    if (!freshContext) {
      records.push(
        unavailable(
          "CODEX_EXECUTION_FRESH_CONTEXT_UNAVAILABLE",
          sessionId,
          thread.id,
          thread.parentThreadId,
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
    const readbackFinals = firstTurn.items.filter(
      (item) =>
        item.type === "agentMessage" && item.phase === "final_answer",
    );
    const readbackFinal = readbackFinals[readbackFinals.length - 1];
    if (finalMessage === undefined || readbackFinal === undefined) {
      records.push(
        unavailable(
          "CODEX_EXECUTION_FINAL_MESSAGE_UNAVAILABLE",
          sessionId,
          thread.id,
          thread.parentThreadId,
          firstTurn.id,
          spawn.id,
        ),
      );
      continue;
    }
    if (readbackFinal.text !== finalMessage.text) {
      records.push(
        unavailable(
          "CODEX_EXECUTION_FINAL_MESSAGE_UNAVAILABLE",
          sessionId,
          thread.id,
          thread.parentThreadId,
          firstTurn.id,
          spawn.id,
        ),
      );
      continue;
    }
    const startedAt = instantFromSeconds(firstTurn.startedAt, "startedAt");
    // Turn timestamps are exported at whole-second precision while item lifecycle
    // timestamps carry milliseconds. Use the inclusive end of the reported second
    // as the invocation's conservative end bound so a real final item at .337 is
    // not made to appear after its completed turn at .000.
    instantFromSeconds(firstTurn.completedAt, "completedAt");
    const endedAt = new Date(firstTurn.completedAt * 1_000 + 999).toISOString();
    if (endedAt < startedAt) {
      fail("CODEX_EXECUTION_SCHEMA_INVALID", `turn order:${firstTurn.id}`);
    }
    if (
      finalMessage.completedAtMs < firstTurn.startedAt * 1_000 ||
      finalMessage.completedAtMs > firstTurn.completedAt * 1_000 + 999
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
      spawnStartedAt: new Date(spawn.startedAtMs).toISOString(),
      spawnCompletedAt: new Date(spawn.completedAtMs).toISOString(),
      threadCreatedAt: instantFromSeconds(
        thread.createdAt,
        "threadCreatedAt",
      ),
      threadReadbackDigest: thread.readbackDigest,
      threadStartedNotificationObserved: threadStart !== undefined,
      freshContextBasis:
        "spawn_lifecycle_overlaps_non_forked_subagent_thread_readback" as const,
      finalMessageItemId: finalMessage.id,
      readbackFinalMessageItemId: readbackFinal.id,
      finalMessageCompletedAt: new Date(
        finalMessage.completedAtMs,
      ).toISOString(),
      outputDigest: digest(finalMessage.text),
      startedAt,
      endedAt,
    });
    const transcriptSource = canonicalJson(transcript);
    const observed: ObservedInvocation = deepFreeze({
      // INC-007: one spawnAgent item can name several receivers, and each receiver runs
      // in its own thread. Using the spawn item id alone gave every receiver the SAME
      // agentInvocationId while still counting them as separate observed invocations --
      // inflating exactly the number a multi-agent claim rests on, and contradicting
      // collectConferenceReceipts, which refuses duplicate invocation ids outright. The
      // invocation is the (spawn, thread) pair, so the id is derived from that pair. A
      // digest keeps it a well-formed protocol id (the receipt schema requires one)
      // while staying distinct per receiver and stable for the same pair.
      agentInvocationId: `agent-invocation:${digest(`${spawn.id}\u0000${thread.id}`).slice(0, 32)}`,
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

// The collector extends the host-neutral observation envelope with captured
// thread/read(includeTurns=true) request/response pairs. Those pairs are supplied
// data; this module still sends no request and drives no host action.
export interface CodexExecutionThreadReadback {
  readonly request: {
    readonly threadId: string;
    readonly includeTurns: true;
  };
  readonly response: unknown;
}

export interface CodexExecutionObservationInput extends ObservationInput {
  readonly threadReadbacks: readonly CodexExecutionThreadReadback[];
}
