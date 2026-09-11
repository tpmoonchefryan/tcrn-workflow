#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-365 — the Stop hook that writes the session's lessons into knowledge.
//
// Owner ruling TCRN-CROSS-MIN-146: a small card is written, retrievable and retired
// automatically. There is no candidate state and no promotion step, so this hook does not
// "propose" anything — what it writes is an official card the next session can recall.
//
// WHAT IT READS. The Stop payload carries `transcript_path`; the model is not in it. The
// tail of that transcript is read through tools/stop-pact/mode.mjs's bounded reader (one
// implementation of "read the last assistant turn safely", not two), and the lessons are
// the paragraphs that open with a lesson marker. At most three per turn, which is the
// bound the direction note set: a turn that claims ten lessons has claimed none.
//
// FAIL-OPEN, AND SAID SO. Every path exits 0. A Stop hook that throws is a session that
// cannot end, which is a worse failure than a lesson not written. Refusals and crashes
// are appended to a log under the platform archive instead of being raised: the engine
// refuses a possible conflict, a missing store, a duplicate key, and each of those is a
// fact worth having when someone asks why a card is not there.
//
// NOT A SECOND WRITE PATH. The card is written by the engine's own knowledge-capture verb
// over its CLI, the same way scripts/knowledge-inject.mjs reads through the engine rather
// than reimplementing relevance. This file decides what to say, never how to store it.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveLastAssistantText } from "../tools/stop-pact/mode.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const PLATFORM_ROOT = resolve(SCRIPT_DIRECTORY, "../../..");
export const ENGINE_CLI = resolve(SCRIPT_DIRECTORY, "tcrn-workflow.mjs");
export const INJECT_SCRIPT = resolve(SCRIPT_DIRECTORY, "knowledge-inject.mjs");
export const DEFAULT_PARTITION = "cross-project";
export const DEFAULT_ROLE_SCOPE = "implementation";
// The accountable owner of a card nobody typed. Overridable so a host registration can
// name a real owner; the default says plainly that a session wrote it.
export const DEFAULT_OWNER_ID = "owner:agent-session";
export const LESSON_MARKERS = Object.freeze(["经验：", "经验:", "Lesson:", "LESSON:"]);
export const MAX_LESSONS = 3;
export const FIELD_BYTES = Object.freeze({ subject: 512, summary: 2_048, snippet: 512, body: 8_192 });

export function workspaceForPartition(partition, containerRoot = PLATFORM_ROOT) {
  return resolve(containerRoot, ".tcrn-workspace", String(partition), "workspace");
}

export function captureLogPath(containerRoot = PLATFORM_ROOT) {
  return resolve(containerRoot, ".tcrn-artifacts", "observe", "knowledge-capture.log");
}

/** Truncate to a byte bound without splitting a UTF-8 sequence. */
export function boundedUtf8(text, maximumBytes) {
  const buffer = Buffer.from(String(text ?? ""), "utf8");
  if (buffer.length <= maximumBytes) return buffer.toString("utf8");
  let end = maximumBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * The lessons an assistant turn declared.
 *
 * A lesson opens with a marker and runs to the next blank line or next marker, so a
 * multi-line lesson stays one card. Anything before the first marker is prose, not a
 * lesson: this hook writes what the model chose to declare, and nothing it merely said.
 */
export function extractLessons(text) {
  const lines = String(text ?? "").split("\n");
  const lessons = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const marker = LESSON_MARKERS.find((candidate) => trimmed.startsWith(candidate));
    if (marker !== undefined) {
      if (current !== null && current.length > 0) lessons.push(current);
      current = trimmed.slice(marker.length).trim();
      continue;
    }
    if (current === null) continue;
    if (trimmed.length === 0) {
      if (current.length > 0) lessons.push(current);
      current = null;
      continue;
    }
    current = `${current}\n${trimmed}`;
  }
  if (current !== null && current.length > 0) lessons.push(current);
  return lessons.filter((lesson) => lesson.length > 0).slice(0, MAX_LESSONS);
}

/** One lesson rendered as the card fields the capture verb takes. */
export function cardFor(lesson, { tags = ["lesson", "session-capture"], ownerId = DEFAULT_OWNER_ID } = {}) {
  const text = String(lesson ?? "").trim();
  const [headline] = text.split("\n");
  return {
    subject: boundedUtf8(headline, FIELD_BYTES.subject),
    summary: boundedUtf8(text, FIELD_BYTES.summary),
    snippet: boundedUtf8(text, FIELD_BYTES.snippet),
    body: boundedUtf8(text, FIELD_BYTES.body),
    tags,
    ownerId,
  };
}

/** The argv one card becomes. `--coexist true` is this path's standing answer (D3). */
export function captureArguments(card, workspace, at, { roleScope = DEFAULT_ROLE_SCOPE } = {}) {
  return [
    ENGINE_CLI, "knowledge-capture",
    "--workspace", workspace,
    "--at", at,
    "--subject", card.subject,
    "--summary", card.summary,
    "--snippet", card.snippet,
    "--tags", card.tags.join(","),
    "--accountable-owner-id", card.ownerId,
    "--body", card.body,
    "--role-scopes", roleScope,
    "--coexist", "true",
    "--allow-trailing", "true",
  ];
}

function appendLog(containerRoot, record) {
  try {
    const path = captureLogPath(containerRoot);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    // The log is a courtesy, never a precondition. A read-only archive directory must
    // not turn into a session that cannot stop.
  }
}

function runEngine(argv) {
  const result = spawnSync(process.execPath, argv, { encoding: "utf8", timeout: 25_000 });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  try {
    return JSON.parse(lines[lines.length - 1] ?? "");
  } catch {
    return { ok: false, reasonCode: "KNOWLEDGE_CAPTURE_OUTPUT_UNPARSEABLE", error: text.slice(-200) };
  }
}

function observationBoundaryArguments(input, { containerRoot, partition, at }) {
  const sessionId = boundedUtf8(String(input?.session_id ?? input?.sessionId ?? "anonymous"), 256);
  const host = boundedUtf8(String(input?.host ?? input?.host_name ?? process.env.TCRN_HOST ?? "claude"), 64);
  return [INJECT_SCRIPT, "--observation-boundary", "stop", "--partition", partition, "--session-id", sessionId, "--host", host, "--at", at, "--container-root", containerRoot];
}

function recordStopObservationBoundary(input, { containerRoot, partition, at }) {
  try {
    const result = spawnSync(process.execPath, observationBoundaryArguments(input, { containerRoot, partition, at }), { encoding: "utf8", timeout: 25_000 });
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    return JSON.parse(lines.at(-1) ?? "");
  } catch (error) {
    return { ok: false, reasonCode: "TELEMETRY_BOUNDARY_UNAVAILABLE", error: String(error?.message ?? error) };
  }
}

/**
 * The whole hook, as a function so a test can drive it against a temporary container.
 *
 * Returns a report; the process wrapper below throws it away and exits 0 regardless.
 */
export function runCaptureHook(input, {
  containerRoot = PLATFORM_ROOT,
  partition = DEFAULT_PARTITION,
  ownerId = DEFAULT_OWNER_ID,
  roleScope = DEFAULT_ROLE_SCOPE,
  now = () => new Date().toISOString(),
  readTranscript = resolveLastAssistantText,
} = {}) {
  const attempts = [];
  try {
    const at = now();
    const observationBoundary = recordStopObservationBoundary(input, { containerRoot, partition, at });
    // TCRN-CROSS-STORY-365: Codex's real Stop payload carries the assistant text inline as
    // last_assistant_message and no transcript_path at all (tools/stop-pact/codex-response-style-hook.mjs,
    // confirmed against the real-payload fixture). Reading only the path makes this hook a silent
    // no-op on the Codex host the harness declares it covers.
    const inline = typeof input?.last_assistant_message === "string" ? input.last_assistant_message : "";
    const transcriptPath = typeof input?.transcript_path === "string" ? input.transcript_path : "";
    const text = inline.length > 0 ? inline : readTranscript(transcriptPath);
    const lessons = extractLessons(text);
    if (lessons.length === 0) return { ok: true, reasonCode: "NO_LESSON_DECLARED", written: 0, attempts, observationBoundary };
    const workspace = workspaceForPartition(partition, containerRoot);
    if (!existsSync(workspace)) {
      const report = { ok: false, reasonCode: "KNOWLEDGE_CAPTURE_WORKSPACE_ABSENT", workspace, written: 0, attempts, observationBoundary };
      appendLog(containerRoot, { at: now(), ...report });
      return report;
    }
    for (const lesson of lessons) {
      const card = cardFor(lesson, { ownerId });
      const answer = runEngine(captureArguments(card, workspace, at, { roleScope }));
      const written = typeof answer?.id === "string" && answer.reasonCode === "KNOWLEDGE_UNIT_CREATED";
      attempts.push({ subject: card.subject, written, reasonCode: answer?.reasonCode ?? null, id: answer?.id ?? null });
      // A swallowed refusal is the price of fail-open, so it is at least written down.
      if (!written) appendLog(containerRoot, { at, reasonCode: answer?.reasonCode ?? "KNOWLEDGE_CAPTURE_REFUSED", subject: card.subject, error: answer?.error ?? null });
    }
    const written = attempts.filter((attempt) => attempt.written).length;
    appendLog(containerRoot, { at, reasonCode: "KNOWLEDGE_CAPTURE_RUN", declared: lessons.length, written });
    return { ok: true, reasonCode: "KNOWLEDGE_CAPTURE_RUN", written, attempts, observationBoundary };
  } catch (error) {
    const report = { ok: false, reasonCode: "KNOWLEDGE_CAPTURE_HOOK_FAILED", error: String(error?.message ?? error), written: 0, attempts };
    appendLog(containerRoot, { at: now(), ...report });
    return report;
  }
}

function readStdin() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return {}; }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  // No stdout, no decision: a Stop hook that says nothing lets the turn end. The whole
  // body is already fail-open, and this last catch is the belt on top of the braces.
  try { runCaptureHook(readStdin()); } catch { /* fail-open: a lesson is never worth a stuck session */ }
  process.exit(0);
}
