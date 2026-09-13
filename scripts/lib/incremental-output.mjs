// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-414 — bounded, cursor-based progress evidence.

import { appendFile, readFile } from "node:fs/promises";

export const PROGRESS_SCHEMA_VERSION = "tcrn.progress-event.v1";
export const PROGRESS_WAIT_MAX_MS = 60_000;

function progressError(reasonCode, detail) {
  const error = new Error(detail);
  error.reasonCode = reasonCode;
  return error;
}

function assertProgressPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) {
    throw progressError("PROGRESS_PATH_INVALID", String(path));
  }
}

function normalizeCursor(cursor) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw progressError("PROGRESS_CURSOR_INVALID", String(cursor));
  }
  return cursor;
}

export function normalizeProgressEvent(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw progressError("PROGRESS_EVENT_INVALID", "event must be an object");
  }
  if (event.schemaVersion !== PROGRESS_SCHEMA_VERSION) {
    throw progressError("PROGRESS_EVENT_SCHEMA_INVALID", String(event.schemaVersion));
  }
  if (typeof event.type !== "string" || event.type.trim().length === 0) {
    throw progressError("PROGRESS_EVENT_TYPE_INVALID", String(event.type));
  }
  return Object.freeze({ ...event, type: event.type.trim() });
}

export async function appendProgressEvent(path, event) {
  assertProgressPath(path);
  const value = event?.schemaVersion === PROGRESS_SCHEMA_VERSION
    ? normalizeProgressEvent(event)
    : normalizeProgressEvent({
      schemaVersion: PROGRESS_SCHEMA_VERSION,
      observedAt: new Date().toISOString(),
      ...event,
    });
  await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
  return value;
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function appendProgressIfConfigured(path, type, fields = {}) {
  if (!path) return;
  await appendProgressEvent(path, { type, ...fields });
}

/**
 * Read only complete NDJSON records after a byte cursor. A partial trailing line
 * remains unread so the next call can finish it; a malformed complete line is an
 * error, never an empty successful delta.
 */
export async function readProgressDelta(path, cursor = 0) {
  assertProgressPath(path);
  const start = normalizeCursor(cursor);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT" && start === 0) {
      return { events: [], nextCursor: 0, bytesRead: 0, unchanged: true, source: "missing" };
    }
    if (error?.code === "ENOENT") throw progressError("PROGRESS_SOURCE_INVALIDATED", path);
    throw progressError("PROGRESS_SOURCE_UNREADABLE", `${path}: ${error?.message ?? error}`);
  }
  if (start > bytes.length) throw progressError("PROGRESS_CURSOR_INVALIDATED", `${start} > ${bytes.length}`);
  const delta = bytes.subarray(start);
  const newline = delta.lastIndexOf(0x0a);
  if (newline < 0) {
    return { events: [], nextCursor: start, bytesRead: delta.length, unchanged: delta.length === 0, source: "partial" };
  }
  const complete = delta.subarray(0, newline + 1);
  const lines = complete.toString("utf8").split("\n").slice(0, -1);
  const events = lines.map((line) => {
    if (line.length === 0) throw progressError("PROGRESS_EVENT_INVALID", "blank line");
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw progressError("PROGRESS_EVENT_INVALID", error.message);
    }
    return normalizeProgressEvent(parsed);
  });
  const nextCursor = start + complete.length;
  return { events, nextCursor, bytesRead: complete.length, unchanged: events.length === 0, source: "ledger" };
}

function mergeEvents(existing, added) {
  const values = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(added) ? added : [])];
  return values.map(normalizeProgressEvent);
}

export function summarizeProgress(events) {
  const values = mergeEvents([], events);
  const terminal = [...values].reverse().find((event) => ["completed", "error", "orphaned-before-bind"].includes(event.type)) ?? null;
  const exit = [...values].reverse().find((event) => event.type === "controller-exited") ?? null;
  const errors = values.filter((event) => event.type === "error" || (event.type === "controller-exited" && event.ok === false));
  const status = terminal?.type === "completed" && terminal.ok === true
    ? "completed"
    : terminal?.type === "orphaned-before-bind"
      ? "orphaned"
      : errors.length > 0 || terminal?.type === "error" || (terminal?.type === "completed" && terminal.ok !== true)
        ? "failed"
        : "running";
  return {
    schemaVersion: PROGRESS_SCHEMA_VERSION,
    status,
    eventCount: values.length,
    eventTypes: values.map((event) => event.type),
    selected: values.filter((event) => event.type === "selected").map((event) => event.id ?? null),
    executed: values.filter((event) => event.type === "executed").map((event) => event.id ?? null),
    changed: values.filter((event) => event.type === "changed").map((event) => event.id ?? event.path ?? null),
    terminal: terminal?.type ?? null,
    exit: exit ? { code: exit.code ?? null, signal: exit.signal ?? null, ok: exit.ok === true } : null,
    errors: errors.map((event) => ({ type: event.type, reasonCode: event.reasonCode ?? null })),
  };
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve("cancelled");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("elapsed");
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve("cancelled");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wait for a terminal event in bounded chunks. The returned counters describe
 * actual reads and bytes observed, including unchanged polls; no success is
 * inferred when the ledger has not supplied a terminal event.
 */
export async function waitForProgress(path, {
  cursor = 0,
  events: initialEvents = [],
  timeoutMs = 5_000,
  pollMs = 25,
  maxPollMs = 1_000,
  counters: initialCounters = {},
  signal,
} = {}) {
  assertProgressPath(path);
  const startCursor = normalizeCursor(cursor);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > PROGRESS_WAIT_MAX_MS) {
    throw progressError("PROGRESS_WAIT_BOUND_INVALID", String(timeoutMs));
  }
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0 || !Number.isSafeInteger(maxPollMs) || maxPollMs < pollMs) {
    throw progressError("PROGRESS_POLL_BOUND_INVALID", `${pollMs}/${maxPollMs}`);
  }
  let nextCursor = startCursor;
  let allEvents = mergeEvents([], initialEvents);
  let polls = initialCounters.polls ?? 0;
  let unchangedPolls = initialCounters.unchangedPolls ?? 0;
  let bytesRead = initialCounters.bytesRead ?? 0;
  let delayMs = pollMs;
  const startedAt = Date.now();
  const snapshot = (status, extra = {}) => ({
    status,
    cursor: nextCursor,
    events: allEvents,
    summary: summarizeProgress(allEvents),
    polls,
    unchangedPolls,
    bytesRead,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...extra,
  });
  const knownTerminal = summarizeProgress(allEvents).status;
  if (["completed", "failed", "orphaned"].includes(knownTerminal)) return snapshot(knownTerminal);
  while (true) {
    if (signal?.aborted) return snapshot("cancelled");
    let delta;
    try {
      delta = await readProgressDelta(path, nextCursor);
    } catch (error) {
      return snapshot("failed", { reasonCode: error.reasonCode ?? "PROGRESS_READ_FAILED", error: error.message });
    }
    polls += 1;
    bytesRead += delta.bytesRead;
    nextCursor = delta.nextCursor;
    if (delta.events.length === 0) unchangedPolls += 1;
    else {
      allEvents = mergeEvents(allEvents, delta.events);
      const summary = summarizeProgress(allEvents);
      if (summary.status === "completed" || summary.status === "failed" || summary.status === "orphaned") {
        return snapshot(summary.status);
      }
      delayMs = pollMs;
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) return snapshot("timeout");
    const delayed = await abortableDelay(Math.min(delayMs, timeoutMs - elapsed), signal);
    if (delayed === "cancelled") return snapshot("cancelled");
    delayMs = Math.min(maxPollMs, Math.max(pollMs, delayMs * 2));
  }
}
