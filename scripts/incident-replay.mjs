#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-378 — incident replay pairs and extraction templates.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalJson, canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

export const INCIDENT_REPLAY_SCHEMA_VERSION = "tcrn.incident-replay.v1";
export const INCIDENT_RULE_DRAFT_SCHEMA_VERSION = "tcrn.incident-rule-draft.v1";
export const INCIDENT_DECISION_CARD_SCHEMA_VERSION = "tcrn.incident-decision-card.v1";
export const INCIDENT_REPLAY_DEFAULT_WORK_FILE = "tests/fixtures/retrieval-eval/work-compact.json";
export const INCIDENT_REPLAY_DEFAULT_CARDS_FILE = "tests/fixtures/retrieval-eval/corpus-snapshot.json";
export const INCIDENT_REPLAY_DEFAULT_MINUTES_FILE = "tests/fixtures/retrieval-eval/minutes-compact.json";

const TEXT_LIMIT = 4_096;
const PROMPT_LIMIT = 1_024;
const CARD_BODY_LIMIT = 8_192;

function recordsOf(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry !== null && typeof entry === "object");
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value.records)) return value.records.filter((entry) => entry !== null && typeof entry === "object");
    return Object.values(value).filter((entry) => entry !== null && typeof entry === "object");
  }
  return [];
}

function text(value, maximum = TEXT_LIMIT) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/gu, "").trim().slice(0, maximum);
}

function redact(value, maximum = TEXT_LIMIT) {
  return text(value, maximum)
    .replace(/(?:\/Users|\/home|\/private|[A-Za-z]:[\\/])[^\s，。；;,)）]+/gu, "[redacted-path]")
    .replace(/(?:https?:\/\/)[^\s，。；;,)）]+/giu, "[redacted-url]");
}

function utf8Limit(value, maximum) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  return bytes.length <= maximum ? bytes.toString("utf8") : bytes.subarray(0, maximum).toString("utf8");
}

function firstParagraph(value) {
  const paragraphs = String(value ?? "").split(/\n\s*\n/gu).map((entry) => redact(entry)).filter(Boolean);
  return paragraphs[0] ?? "";
}

function scopeFor(work, scopeMap) {
  if (typeof work.scope === "string" && work.scope.trim().length > 0) return work.scope;
  const value = scopeMap.get(work.id);
  return typeof value === "string" ? value : value?.scope ?? "";
}

function summaryFor(work, scope) {
  const supplied = text(work.summary);
  if (supplied) return { value: supplied, source: "record-summary" };
  const title = text(work.title);
  if (title) return { value: title, source: "record-title" };
  const derived = firstParagraph(scope);
  if (derived) return { value: derived, source: "scope-derived" };
  return { value: "", source: null };
}

function idList(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter((entry) => typeof entry === "string" && entry.length > 0))].sort();
}

function decidedByFor(work, scope) {
  const direct = idList(work.decidedBy ?? work.advisory?.decidedBy ?? work.linkedMinutes);
  if (direct.length > 0) return direct;
  return [...new Set([...String(scope).matchAll(/(?:conference-minutes|minutes):[0-9a-f]{24}/giu)].map((match) => match[0]))].sort();
}

function cardLinksFor(work, cards) {
  const explicit = new Set(idList(work.linkedCardIds ?? work.cardIds));
  for (const card of cards) {
    const linked = [...(card.linkedWorkIds ?? []), ...(card.workIds ?? [])];
    const references = Array.isArray(card.sourceReferences) ? card.sourceReferences : [];
    if (linked.includes(work.id) || references.some((reference) => String(reference).includes(String(work.externalKey ?? "")))) explicit.add(card.id);
  }
  return [...explicit].filter((id) => cards.some((card) => card.id === id)).sort();
}

function minuteMapOf(minutes) {
  return new Map(minutes.flatMap((minute) => {
    const id = minute.id;
    if (typeof id !== "string") return [];
    return [[id, minute]];
  }));
}

function minuteSummaries(ids, minuteMap) {
  return ids.flatMap((id) => {
    const minute = minuteMap.get(id);
    return minute === undefined ? [] : [{ id, summary: redact(minute.summary), decisions: idList(minute.decisions) }];
  });
}

function sourceDigest(source) {
  return canonicalSha256(source);
}

/** Build replay pairs without using current retrieval results as labels. */
export function buildIncidentReplay({ workRecords = [], scopeRecords = {}, cards = [], minutes = [], at = new Date().toISOString() } = {}) {
  const works = recordsOf(workRecords);
  const cardRecords = recordsOf(cards);
  const minuteRecords = recordsOf(minutes);
  const scopeMap = new Map(Object.entries(scopeRecords ?? {}));
  const minuteMap = minuteMapOf(minuteRecords);
  const pairs = [];
  const skipped = [];
  for (const work of works) {
    const id = text(work.id, 256);
    const externalKey = text(work.externalKey, 256);
    const scope = scopeFor(work, scopeMap);
    const summary = summaryFor(work, scope);
    if (!id || !externalKey || !summary.value) {
      skipped.push({ id: id || null, externalKey: externalKey || null, reason: "missing-summary" });
      continue;
    }
    const decidedBy = decidedByFor(work, scope);
    const linkedCardIds = cardLinksFor(work, cardRecords);
    const source = {
      workId: id,
      externalKey,
      kind: text(work.kind, 128) || null,
      status: text(work.status, 64) || null,
      revision: Number.isSafeInteger(work.revision) ? work.revision : null,
      scopeDigest: typeof work.scopeDigest === "string" ? work.scopeDigest : sourceDigest(scope),
      summarySource: summary.source,
      decidedBy,
      linkedCardIds,
    };
    const prompt = utf8Limit(`现象：${redact(summary.value, PROMPT_LIMIT)}`, PROMPT_LIMIT);
    const expectedIds = [...new Set([...linkedCardIds, id])].sort();
    pairs.push({
      id: `incident-replay:${sourceDigest(source).slice(0, 24)}`,
      source,
      sourceDigest: sourceDigest(source),
      prompt,
      expectedIds,
      ruleId: `rule:${externalKey}`,
      decidedByMinutes: minuteSummaries(decidedBy, minuteMap),
      linkedCards: cardRecords.filter((card) => linkedCardIds.includes(card.id)).map((card) => ({
        id: card.id,
        subject: redact(card.subject, 512),
        sourceDigest: typeof card.bodySha256 === "string" ? card.bodySha256 : null,
      })),
    });
  }
  pairs.sort((left, right) => left.source.externalKey < right.source.externalKey ? -1 : left.source.externalKey > right.source.externalKey ? 1 : 0);
  return {
    schemaVersion: INCIDENT_REPLAY_SCHEMA_VERSION,
    generatedAt: at,
    source: { workRecords: works.length, cards: cardRecords.length, minutes: minuteRecords.length },
    counts: {
      input: works.length,
      included: pairs.length,
      skipped: skipped.length,
      skippedNoSummary: skipped.filter((entry) => entry.reason === "missing-summary").length,
    },
    pairs,
    skipped,
  };
}

function sourceForExtraction(work, replay) {
  return replay.pairs.find((pair) => pair.source.workId === work.id || pair.source.externalKey === work.externalKey) ?? null;
}

export function incidentRuleDraft({ work, pair, at = new Date().toISOString() } = {}) {
  if (work === null || work === undefined || pair === null || pair === undefined) throw new Error("INCIDENT_REPLAY_SOURCE_REQUIRED");
  const key = text(work.externalKey, 128);
  const phenomenon = redact(pair.prompt, PROMPT_LIMIT);
  const content = [
    `## Proposed rule: ${key}`,
    "",
    "Status: unapplied",
    `Observed phenomenon: ${phenomenon}`,
    `Source work: ${key} (${work.id})`,
    `Expected evidence: ${pair.expectedIds.join(", ")}`,
    "",
    "Rule draft:",
    "- Reproduce the observed condition before choosing a remedy.",
    "- Keep the check attached to the behavior it measures and retain the source digest.",
    "",
    `Source digest: ${pair.sourceDigest}`,
    `Generated at: ${at}`,
  ].join("\n");
  return {
    schemaVersion: INCIDENT_RULE_DRAFT_SCHEMA_VERSION,
    status: "unapplied",
    externalKey: key,
    sourceWorkId: work.id,
    sourceDigest: pair.sourceDigest,
    path: `docs/proposed-rules/${key}.md`,
    content: `${content}\n`,
  };
}

export function incidentDecisionCard({ work, minute, ownerId = "owner:incident-replay", at = new Date().toISOString() } = {}) {
  if (work === null || work === undefined || minute === null || minute === undefined) throw new Error("INCIDENT_REPLAY_MINUTES_REQUIRED");
  const minuteId = text(minute.id, 128);
  const minuteHex = minuteId.replace(/^minutes:/u, "");
  if (!/^[0-9a-f]{24}$/u.test(minuteHex)) throw new Error("INCIDENT_REPLAY_MINUTES_ID_INVALID");
  const key = `INCIDENT-${text(work.externalKey, 80).replace(/[^A-Z0-9_-]/gu, "-")}-DECISION`;
  const summary = redact(minute.summary, 2_048) || `Decision extracted from ${text(work.externalKey, 128)}`;
  const decisions = idList(minute.decisions);
  const body = utf8Limit([
    `Decision source: ${minuteId}`,
    `Work item: ${text(work.externalKey, 128)}`,
    `Summary: ${summary}`,
    decisions.length === 0 ? "Decisions: none recorded" : `Decisions: ${decisions.join("; ")}`,
    `Observed at: ${at}`,
  ].join("\n"), CARD_BODY_LIMIT);
  return {
    schemaVersion: INCIDENT_DECISION_CARD_SCHEMA_VERSION,
    externalKey: key,
    kind: "decision",
    category: "decision",
    scope: "role",
    roleScopes: ["implementation"],
    subject: utf8Limit(summary.split(/[。.!?\n]/u)[0] || key, 512),
    summary: utf8Limit(summary, 2_048),
    snippet: utf8Limit(summary, 512),
    tags: ["decision", "incident-replay"],
    accountableOwnerId: ownerId,
    sourceReferences: [minuteId],
    linkedEvidenceIds: [`evidence:${minuteHex}`],
    body,
  };
}

export async function captureIncidentDecisionCard(workspace, card) {
  const core = await import("../dist/build/packages/core/src/index.js");
  const input = {
    occurredAt: card.occurredAt ?? new Date().toISOString(),
    externalKey: card.externalKey,
    roleScopes: card.roleScopes,
    category: card.category,
    kind: card.kind,
    tags: card.tags,
    subject: card.subject,
    summary: card.summary,
    snippet: card.snippet,
    accountableOwnerId: card.accountableOwnerId,
    sourceReferences: card.sourceReferences,
    linkedEvidenceIds: card.linkedEvidenceIds,
    body: card.body,
    coexist: true,
  };
  try {
    const result = await core.captureKnowledgeUnit(workspace, input);
    return { status: "created", result };
  } catch (error) {
    if (error?.reasonCode !== "KNOWLEDGE_DUPLICATE") throw error;
    return { status: "already-exists", id: deriveStableId("knowledge", card.externalKey) };
  }
}

function flags(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    result[key] = argv[index + 1] !== undefined && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runIncidentReplayCli(argv = process.argv.slice(2)) {
  const options = flags(argv);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const workPath = resolve(root, typeof options["work-file"] === "string" ? options["work-file"] : INCIDENT_REPLAY_DEFAULT_WORK_FILE);
  const cardsPath = resolve(root, typeof options["cards-file"] === "string" ? options["cards-file"] : INCIDENT_REPLAY_DEFAULT_CARDS_FILE);
  const minutesPath = resolve(root, typeof options["minutes-file"] === "string" ? options["minutes-file"] : INCIDENT_REPLAY_DEFAULT_MINUTES_FILE);
  const [workDocument, cardsDocument, minutesDocument] = await Promise.all([readJsonFile(workPath), readJsonFile(cardsPath), readJsonFile(minutesPath)]);
  const replay = buildIncidentReplay({
    workRecords: recordsOf(workDocument),
    cards: recordsOf(cardsDocument),
    minutes: recordsOf(minutesDocument),
    at: typeof options.at === "string" ? options.at : new Date().toISOString(),
  });
  if (typeof options["extract-work-key"] !== "string") {
    const output = typeof options.output === "string" ? resolve(root, options.output) : null;
    if (output !== null) {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, canonicalJson(replay));
    }
    return output === null ? replay : { ...replay, output };
  }
  const work = recordsOf(workDocument).find((entry) => entry.externalKey === options["extract-work-key"]);
  const pair = work === undefined ? null : sourceForExtraction(work, replay);
  if (work === undefined || pair === null) throw new Error("INCIDENT_REPLAY_WORK_NOT_FOUND");
  const minuteId = pair.source.decidedBy[0];
  const minute = recordsOf(minutesDocument).find((entry) => entry.id === minuteId);
  if (minute === undefined) throw new Error("INCIDENT_REPLAY_DECISION_MINUTES_NOT_FOUND");
  const draft = incidentRuleDraft({ work, pair, at: typeof options.at === "string" ? options.at : undefined });
  const card = incidentDecisionCard({ work, minute, ownerId: typeof options.owner === "string" ? options.owner : undefined, at: typeof options.at === "string" ? options.at : undefined });
  let capture = null;
  if (typeof options.workspace === "string") capture = await captureIncidentDecisionCard(options.workspace, { ...card, occurredAt: options.at });
  if (typeof options["draft-out"] === "string") {
    const draftPath = resolve(root, options["draft-out"]);
    await mkdir(dirname(draftPath), { recursive: true });
    await writeFile(draftPath, draft.content);
  }
  return { schemaVersion: "tcrn.incident-extraction.v1", source: pair, ruleDraft: draft, decisionCard: card, capture };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runIncidentReplayCli())}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, reasonCode: error?.reasonCode ?? "INCIDENT_REPLAY_FAILED", error: error?.message ?? String(error) })}\n`);
    process.exitCode = 1;
  }
}
