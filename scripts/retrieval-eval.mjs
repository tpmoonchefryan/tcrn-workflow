#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-368: the retrieval evaluation gate. It builds the shipped recall
// core's own index over a frozen corpus and scores the ranking that core actually
// returns. Nothing here recomputes a number the fixtures already hold: every metric
// below is a position in a result list, so a change to the scorer, the tokenizer or
// the corpus moves it. Disabling CJK bigram segmentation in packages/core/src/recall.ts
// takes the synthetic hit rates to zero, which is the proof that this gate is attached
// to its subject rather than describing it.
//
// The corpus is content-addressed. A gate whose thresholds were measured on one corpus
// and applied to another states nothing, so a fixture byte that moves is refused by
// name rather than absorbed into the score.
//
// Two indexes are built on purpose. The cards-only index is the knowledge surface
// alone; the mixed index adds conference minutes and work records, which is what the
// recall verb answers from. Their numbers differ -- 36 against 30 at @8 on the same 37
// questions -- so neither can stand in for the other, and both are held.
//
// Thresholds are the values measured on this corpus with no margin, per Owner ruling
// TCRN-CROSS-MIN-164 D4: any later drift shows up here first, which is the reason the
// gate exists.
//
// This file reports; the gate is scripts/task.mjs's retrieval-eval verb, which is what
// package.json and scripts/p1-sequence.mjs dispatch. So a failed floor is printed with
// its own reason code and a zero exit, and the verb turns it into the refusal. Exiting
// non-zero here instead would reach the verb as a spawn failure and the reason code the
// verification-map claim names would be replaced by COMMAND_FAILED.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RECALL_DEFAULT_TAU,
  RECALL_KIND_QUOTA,
  RECALL_RELATIVE_FLOOR,
  RecallIndex,
  recallDocuments,
  selectRecallHits,
} from "../dist/build/packages/core/src/recall.js";
import { canonicalJson, canonicalSha256, parseStrictInstant } from "../dist/build/packages/protocol/src/index.js";
import { buildIncidentReplay } from "./incident-replay.mjs";

const SCOPE_EXCERPT_BYTES = 512;
const TOP_K = 8;
const PRECISION_K = 3;
const INDEPENDENT_INCIDENT_FILE = "incident-replay-frozen.json";
const PRE_REGISTERED_HOLDOUT_FILE = "holdout-preregistered.json";
const PRE_REGISTERED_HOLDOUT_SOURCE_FILE = "holdout-source.json";

// Every file the score depends on. Order is fixed and the name is hashed with the
// bytes so a rename cannot pass for an edit.
const CORPUS_FILES = [
  "card-expansions.json",
  "cards-compact.json",
  "corpus-snapshot.json",
  "gold-labels.json",
  "judge-sheet.json",
  "minutes-compact.json",
  "synthetic-queries.json",
  "translations-sonnet.json",
  "work-compact.json",
];

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = (name) => resolve(root, "tests/fixtures/retrieval-eval", name);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fileSha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const policy = readJson(resolve(root, "scripts/policy/retrieval-eval-thresholds.json"));

const digest = createHash("sha256");
for (const name of CORPUS_FILES) digest.update(name).update(readFileSync(fixture(name)));
const corpusDigest = digest.digest("hex");
if (corpusDigest !== policy.corpusDigest) {
  console.log(JSON.stringify({ ok: false, reasonCode: "RETRIEVAL_EVAL_CORPUS_CHANGED", corpusDigest, expected: policy.corpusDigest, message: `corpus digest ${corpusDigest} does not match the frozen ${policy.corpusDigest}` }));
} else {
  console.log(JSON.stringify(evaluate(corpusDigest, policy)));
}

function evaluate(corpusDigest, policy) {
  // The snapshot is the knowledge-list reply as it was taken; the compact file is the
  // same cards reduced to the fields recallDocuments reads. The snapshot supplies the
  // lifecycle filter and the external key, which the compact projection drops.
  const snapshot = readJson(fixture("corpus-snapshot.json")).records;
  const liveCards = snapshot.filter((card) => card.lifecycle !== "retired" && card.promotionState === "promoted");
  const externalKeyById = new Map(liveCards.map((card) => [card.id, card.externalKey]));
  const phrasingsById = new Map(readJson(fixture("card-expansions.json")).expansions.map((entry) => [entry.id, entry.phrasings]));
  const knowledge = Object.values(readJson(fixture("cards-compact.json")))
    .filter((card) => externalKeyById.has(card.id))
    .map((card) => ({
      id: card.id,
      externalKey: externalKeyById.get(card.id),
      subject: card.subject,
      summary: card.summary,
      snippet: card.snippet ?? "",
      tags: card.tags ?? [],
      expansions: (phrasingsById.get(card.id) ?? []).join(" "),
    }));
  const minutes = readJson(fixture("minutes-compact.json")).records;
  const work = readJson(fixture("work-compact.json")).records;
  const incidentReplay = buildIncidentReplay({ workRecords: work, cards: snapshot, minutes, at: "2026-09-04T15:08:34Z" });
  const developmentIncidentReplay = readDevelopmentIncidentReplay(policy.incidentReplayIndependent, work, minutes);

  const queries = readJson(fixture("synthetic-queries.json")).queries;
  const translated = readJson(fixture("translations-sonnet.json")).queries;
  const judged = Object.values(readJson(fixture("judge-sheet.json")));
  const priorPrompts = new Set([
    ...incidentReplay.pairs.map((pair) => pair.prompt),
    ...(developmentIncidentReplay.ok ? developmentIncidentReplay.records.map((pair) => pair.prompt) : []),
    ...queries.map((query) => query.query),
    ...translated.map((query) => String(query.en)),
    ...judged.map((entry) => entry.prompt),
  ]);
  const preRegisteredHoldout = readPreRegisteredHoldout(policy.preRegisteredHoldout, work, priorPrompts);

  const cardDocuments = recallDocuments({ knowledge });
  const mixedDocuments = recallDocuments({ knowledge, minutes, work, scopeExcerptBytes: SCOPE_EXCERPT_BYTES });
  // Keep the historical mixed-index score on its original 55-work corpus. The new
  // holdout gets a separate derived index containing its independently frozen source
  // records, so adding holdout rows cannot silently move the old thresholds.
  const holdoutDocuments = preRegisteredHoldout.ok
    ? recallDocuments({ knowledge, minutes, work: [...work, ...preRegisteredHoldout.sourceRecords], scopeExcerptBytes: SCOPE_EXCERPT_BYTES })
    : [];
  const cardIndex = new RecallIndex(cardDocuments, "cards");
  const mixedIndex = new RecallIndex(mixedDocuments, "mixed");
  const holdoutIndex = new RecallIndex(holdoutDocuments, "mixed-holdout");

  // The cards-only index is read raw: it is one kind, so the per-kind quota has nothing
  // to arbitrate. The mixed index goes through the selector the recall verb uses, floors
  // and quota included, because that is the list a caller actually receives.
  const rankCards = (query, id) => {
    const index = cardIndex.search(query).slice(0, TOP_K).findIndex((hit) => hit.id === id);
    return index < 0 ? null : index + 1;
  };
  const selectMixed = (query) => selectRecallHits(mixedIndex.search(query), {
    tau: RECALL_DEFAULT_TAU,
    relativeFloor: RECALL_RELATIVE_FLOOR,
    limit: TOP_K,
    quota: RECALL_KIND_QUOTA,
  });
  const rankMixed = (query, id) => {
    const index = selectMixed(query).findIndex((hit) => hit.id === id);
    return index < 0 ? null : index + 1;
  };
  const hitAt = (ranks, k) => ranks.filter((rank) => rank !== null && rank <= k).length;
  const scoreOf = (ranks) => ({ queries: ranks.length, hitAt1: hitAt(ranks, 1), hitAt3: hitAt(ranks, 3), hitAt8: hitAt(ranks, TOP_K) });

  const cardsOnly = scoreOf(queries.map((query) => rankCards(query.query, query.id)));
  const mixed = scoreOf(queries.map((query) => rankMixed(query.query, query.id)));

  // Real prompts. The gold labels mark relevant candidates by their position in the
  // judge sheet's candidate list, so the positions are resolved back to document ids and
  // the current ranking is scored against those ids. Anything the judged pool never
  // contained is unjudged and counts against precision, which makes this a floor rather
  // than an estimate.
  const labels = readJson(fixture("gold-labels.json")).labels;
  let relevantInTop3 = 0;
  let relevantLabelled = 0;
  for (const entry of judged) {
    const positions = labels[String(entry.i)]?.relevant ?? [];
    const relevant = new Set(positions.map((n) => entry.candidates.find((candidate) => candidate.n === n)?.id).filter((id) => id !== undefined));
    relevantLabelled += relevant.size;
    relevantInTop3 += selectMixed(entry.prompt).slice(0, PRECISION_K).filter((hit) => relevant.has(hit.id)).length;
  }
  const precisionAt3 = Number((relevantInTop3 / (judged.length * PRECISION_K)).toFixed(4));

  // The language corpus is a regression set, not decoration: each English rendering is
  // put to the cards index and has to find the card it was translated from.
  const language = scoreOf(translated.map((query) => rankCards(String(query.en), query.id)));

  // STORY-378: a separate metric group scores prompts generated from the frozen work
  // summaries against the mixed index. Expected ids come from the source linkage, never
  // from the current ranking, so a scorer change can turn a previously green incident
  // replay red without changing its labels.
  const incidentReplayRanks = incidentReplay.pairs.map((pair) => {
    const rank = selectMixed(pair.prompt).findIndex((hit) => pair.expectedIds.includes(hit.id));
    return rank < 0 ? null : rank + 1;
  });
  const incidentReplayScore = scoreOf(incidentReplayRanks);
  const developmentIncidentReplayRanks = developmentIncidentReplay.ok
    ? developmentIncidentReplay.records.map((pair) => {
      const rank = selectMixed(pair.prompt).findIndex((hit) => pair.expectedIds.includes(hit.id));
      return rank < 0 ? null : rank + 1;
    })
    : [];
  const developmentIncidentReplayScore = scoreOf(developmentIncidentReplayRanks);
  const preRegisteredHoldoutRanks = preRegisteredHoldout.ok
    ? preRegisteredHoldout.records.map((pair) => {
      const rank = selectRecallHits(holdoutIndex.search(pair.prompt), {
        tau: RECALL_DEFAULT_TAU,
        relativeFloor: RECALL_RELATIVE_FLOOR,
        limit: TOP_K,
        quota: RECALL_KIND_QUOTA,
      }).findIndex((hit) => pair.expectedIds.includes(hit.id));
      return rank < 0 ? null : rank + 1;
    })
    : [];
  const preRegisteredHoldoutScore = scoreOf(preRegisteredHoldoutRanks);

  // Exact keys retain the map's rank-1 path; key fragments use the low-weight
  // prefix column. Measure both indexes in this run and enforce both contracts.
  const fragmentQuery = queries.find((query) => query.query === "INIT019-C12");
  const exactKey = externalKeyById.get(fragmentQuery.id);
  const externalKey = {
    fragment: fragmentQuery.query,
    fragmentCardsRank: rankCards(fragmentQuery.query, fragmentQuery.id),
    fragmentMixedRank: rankMixed(fragmentQuery.query, fragmentQuery.id),
    fragmentCandidates: mixedIndex.search(fragmentQuery.query).length,
    exact: exactKey,
    exactCardsRank: rankCards(exactKey, fragmentQuery.id),
    exactMixedRank: rankMixed(exactKey, fragmentQuery.id),
  };

  const failures = [];
  const historical = policy.historicalProvenance;
  if (historical?.fixture !== INDEPENDENT_INCIDENT_FILE || historical.role !== "development-seen-after-scoring" || historical.freezeClaimDisposition !== "retained-as-historical-metadata-not-a-real-freeze-time" || !Array.isArray(historical.evidence) || historical.evidence.length !== 2 || historical.evidence.some((entry) => typeof entry?.path !== "string" || !/^[a-f0-9]{64}$/u.test(String(entry.sha256)))) {
    failures.push("historical development-set provenance is missing or malformed");
  }
  const hold = (name, observed, floor) => {
    if (observed < floor) failures.push(`${name} ${String(observed)} < ${String(floor)}`);
  };
  for (const k of ["hitAt1", "hitAt3", "hitAt8"]) {
    hold(`cardsOnly.${k}`, cardsOnly[k], policy.cardsOnly[k]);
    hold(`mixed.${k}`, mixed[k], policy.mixed[k]);
  }
  hold("language.hitAt8", language.hitAt8, policy.language.hitAt8);
  hold("real.precisionAt3", precisionAt3, policy.real.precisionAt3);
  hold("incidentReplay.pairs", incidentReplay.counts.included, policy.incidentReplay.pairsAtLeast);
  for (const k of ["hitAt1", "hitAt3", "hitAt8"]) hold(`incidentReplay.${k}`, incidentReplayScore[k], policy.incidentReplay[k]);
  if (!developmentIncidentReplay.ok) failures.push(...developmentIncidentReplay.failures);
  else {
    hold("incidentReplayDevelopment.pairs", developmentIncidentReplay.records.length, policy.incidentReplayIndependent.pairsAtLeast);
    for (const k of ["hitAt1", "hitAt3", "hitAt8"]) hold(`incidentReplayDevelopment.${k}`, developmentIncidentReplayScore[k], policy.incidentReplayIndependent[k]);
  }
  if (!preRegisteredHoldout.ok) failures.push(...preRegisteredHoldout.failures);
  else {
    hold("preRegisteredHoldout.pairs", preRegisteredHoldout.records.length, policy.preRegisteredHoldout.pairsAtLeast);
    for (const k of ["hitAt1", "hitAt3", "hitAt8"]) hold(`preRegisteredHoldout.${k}`, preRegisteredHoldoutScore[k], policy.preRegisteredHoldout[k]);
  }
  if (externalKey.exactCardsRank === null || externalKey.exactCardsRank > policy.externalKey.exactRankAtMost) {
    failures.push(`externalKey.exactCardsRank ${String(externalKey.exactCardsRank)} > ${String(policy.externalKey.exactRankAtMost)}`);
  }
  if (externalKey.exactMixedRank === null || externalKey.exactMixedRank > policy.externalKey.exactRankAtMost) {
    failures.push(`externalKey.exactMixedRank ${String(externalKey.exactMixedRank)} > ${String(policy.externalKey.exactRankAtMost)}`);
  }
  // MIN-171 D1 adds this previously unmeasured floor; the frozen policy is unchanged.
  for (const field of ["fragmentCardsRank", "fragmentMixedRank"]) {
    const rank = externalKey[field];
    if (!Number.isInteger(rank) || rank < 1 || rank > 3) {
      failures.push(`externalKey.${field} ${String(rank)} outside [1, 3]`);
    }
  }

  const result = {
    ok: failures.length === 0,
    reasonCode: failures.length === 0 ? "RETRIEVAL_EVAL_VERIFIED" : "RETRIEVAL_EVAL_THRESHOLD_FAILED",
    corpusDigest,
    documents: { card: cardDocuments.length, mixed: mixedDocuments.length, minutes: minutes.length, work: work.length },
    cardsOnly,
    mixed,
    language,
    real: { prompts: judged.length, relevantLabelled, relevantInTop3, precisionAt3 },
    incidentReplay: { ...incidentReplayScore, pairs: incidentReplay.counts.included, skipped: incidentReplay.counts.skipped, skippedNoSummary: incidentReplay.counts.skippedNoSummary },
    incidentReplayDevelopment: developmentIncidentReplay.ok
      ? { ...developmentIncidentReplayScore, pairs: developmentIncidentReplay.records.length, skipped: 0, sourceDigest: developmentIncidentReplay.fixtureDigest, sourceFiles: developmentIncidentReplay.sourceFiles, role: "development-seen-after-scoring" }
      : { pairs: 0, skipped: null, reasonCode: "RETRIEVAL_EVAL_DEVELOPMENT_INCIDENT_FREEZE_INVALID" },
    historicalDevelopment: historical,
    preRegisteredHoldout: preRegisteredHoldout.ok
      ? { ...preRegisteredHoldoutScore, pairs: preRegisteredHoldout.records.length, skipped: 0, sourceDigest: preRegisteredHoldout.fixtureDigest, sourceFiles: preRegisteredHoldout.sourceFiles, role: preRegisteredHoldout.role, thresholds: preRegisteredHoldout.thresholds }
      : { pairs: 0, skipped: null, reasonCode: "RETRIEVAL_EVAL_PRE_REGISTERED_HOLDOUT_INVALID" },
    externalKey,
    metrics: ["@1", "@3", "@8", "precision@3"],
  };
  if (failures.length > 0) result.message = failures.join("; ");
  cardIndex.close();
  mixedIndex.close();
  holdoutIndex.close();
  return result;
}

function associatedMinuteDigest(work, minutes) {
  const ids = [...new Set([...String(work.scope ?? "").matchAll(/(?:conference-minutes|minutes):[0-9a-f]{24}/giu)].map((match) => match[0]))].sort();
  const byId = new Map(minutes.map((minute) => [minute.id, minute]));
  const associated = ids.map((id) => byId.get(id)).filter(Boolean).map((minute) => ({ id: minute.id, digest: canonicalSha256(minute), summaryDigest: canonicalSha256(minute.summary ?? "") }));
  return canonicalSha256(associated);
}

function readDevelopmentIncidentReplay(declared, work, minutes) {
  const path = fixture(INDEPENDENT_INCIDENT_FILE);
  const failures = [];
  if (!declared || typeof declared !== "object") return { ok: false, failures: ["independentIncidentReplay policy is missing"] };
  if (declared.role !== "development-seen-after-scoring") failures.push(`incidentReplayDevelopment.role ${declared.role ?? "missing"} is not development-seen-after-scoring`);
  if (declared.fixture !== INDEPENDENT_INCIDENT_FILE) failures.push(`independentIncidentReplay.fixture ${declared.fixture ?? "missing"} is not ${INDEPENDENT_INCIDENT_FILE}`);
  const fixtureDigest = fileSha256(path);
  if (fixtureDigest !== declared.fixtureDigest) failures.push(`independentIncidentReplay.fixtureDigest ${fixtureDigest} != ${declared.fixtureDigest}`);
  let frozen;
  try { frozen = readJson(path); } catch { return { ok: false, failures: ["independentIncidentReplay fixture is not valid JSON"] }; }
  if (frozen.schemaVersion !== "tcrn.incident-replay-frozen.v1" || !Array.isArray(frozen.records)) failures.push("independentIncidentReplay fixture schema is invalid");
  const workById = new Map(work.map((record) => [record.id, record]));
  const seen = new Set();
  for (const pair of frozen.records ?? []) {
    const source = pair?.source;
    const current = workById.get(source?.workId);
    const expectedIds = pair?.label?.expectedIds;
    if (!source || current === undefined || seen.has(source.workId)) { failures.push(`independentIncidentReplay source ${source?.workId ?? "missing"} is missing or duplicated`); continue; }
    seen.add(source.workId);
    if (source.kind !== "Incident" || current.kind !== "Incident" || source.externalKey !== current.externalKey || source.status !== current.status) failures.push(`independentIncidentReplay source ${source.workId} is not the frozen Incident record`);
    if (source.scopeDigest !== canonicalSha256(current.scope ?? "")) failures.push(`independentIncidentReplay scope digest drift for ${source.workId}`);
    if (source.sourceRecordDigest !== canonicalSha256(current)) failures.push(`independentIncidentReplay record digest drift for ${source.workId}`);
    if (source.associatedMinutesDigest !== associatedMinuteDigest(current, minutes)) failures.push(`independentIncidentReplay associated digest drift for ${source.workId}`);
    if (!Array.isArray(expectedIds) || expectedIds.length !== 1 || expectedIds[0] !== source.workId || typeof pair.prompt !== "string" || pair.prompt.length === 0 || typeof pair.label?.basis !== "string" || !pair.label.basis.includes("manual")) failures.push(`independentIncidentReplay label invalid for ${source.workId}`);
  }
  if (frozen.records?.length < (declared.pairsAtLeast ?? 20)) failures.push(`independentIncidentReplay records ${frozen.records?.length ?? 0} < ${declared.pairsAtLeast}`);
  if (seen.size !== frozen.records?.length) failures.push("independentIncidentReplay source identities are not unique");
  return failures.length === 0
    ? { ok: true, records: frozen.records.map((pair) => ({ prompt: pair.prompt, expectedIds: pair.label.expectedIds })), fixtureDigest, sourceFiles: frozen.sourceFiles, role: declared.role }
    : { ok: false, failures };
}

function holdoutPrompt(source) {
  const bounded = (value) => typeof value === "string"
    ? value.replace(/\u0000/gu, "").trim().slice(0, 512)
      .replace(/(?:\/Users|\/home|\/private|[A-Za-z]:[\\/])[^\s，。；;,)）]+/gu, "[redacted-path]")
      .replace(/(?:https?:\/\/)[^\s，。；;,)）]+/giu, "[redacted-url]")
    : "";
  const title = bounded(source?.title);
  const summary = bounded(source?.summary);
  const value = Buffer.from(`问题：${title}。${summary}`, "utf8");
  if (value.length <= 1_024) return value.toString("utf8");
  let end = 1_024;
  while (end > 0 && (value[end] & 0xc0) === 0x80) end -= 1;
  return value.subarray(0, end).toString("utf8");
}

function holdoutSourceProjection(source) {
  const { sourceRecordDigest, ...projection } = source;
  return projection;
}

function readPreRegisteredHoldout(declared, work, priorPrompts = new Set()) {
  const path = fixture(PRE_REGISTERED_HOLDOUT_FILE);
  const failures = [];
  if (!declared || typeof declared !== "object") return { ok: false, failures: ["preRegisteredHoldout policy is missing"] };
  if (declared.fixture !== PRE_REGISTERED_HOLDOUT_FILE) failures.push(`preRegisteredHoldout.fixture ${declared.fixture ?? "missing"} is not ${PRE_REGISTERED_HOLDOUT_FILE}`);
  const fixtureDigest = fileSha256(path);
  if (fixtureDigest !== declared.fixtureDigest) failures.push(`preRegisteredHoldout.fixtureDigest ${fixtureDigest} != ${declared.fixtureDigest}`);
  let frozen;
  try { frozen = readJson(path); } catch { return { ok: false, failures: [...failures, "preRegisteredHoldout fixture is not valid JSON"] }; }
  if (frozen.schemaVersion !== "tcrn.retrieval-holdout.v2") failures.push("preRegisteredHoldout fixture schema is invalid");
  if (frozen.role !== declared.role || declared.role !== "unseen-disjoint-holdout") failures.push(`preRegisteredHoldout.role ${frozen.role ?? "missing"} is not unseen-disjoint-holdout`);
  try {
    if (parseStrictInstant(frozen.frozenAt) > parseStrictInstant(new Date().toISOString())) failures.push("preRegisteredHoldout.frozenAt is in the future");
  } catch { failures.push("preRegisteredHoldout.frozenAt is not a strict instant"); }

  const sourceFiles = frozen.sourceFiles;
  const sourcePath = `tests/fixtures/retrieval-eval/${PRE_REGISTERED_HOLDOUT_SOURCE_FILE}`;
  if (!Array.isArray(sourceFiles) || sourceFiles.length !== 1 || sourceFiles[0]?.path !== sourcePath) failures.push("preRegisteredHoldout sourceFiles must name only the frozen holdout source snapshot");
  else if (fileSha256(resolve(root, sourcePath)) !== sourceFiles[0].sha256) failures.push("preRegisteredHoldout holdout source digest drift");
  if (declared.sourceFile !== PRE_REGISTERED_HOLDOUT_SOURCE_FILE || declared.sourceFileDigest !== sourceFiles?.[0]?.sha256) failures.push("preRegisteredHoldout policy source binding is missing or drifted");
  let sourceSnapshot;
  try { sourceSnapshot = readJson(fixture(PRE_REGISTERED_HOLDOUT_SOURCE_FILE)); }
  catch { sourceSnapshot = null; failures.push("preRegisteredHoldout source snapshot is not valid JSON"); }
  if (sourceSnapshot !== null) {
    if (sourceSnapshot.schemaVersion !== "tcrn.retrieval-holdout-source.v1" || sourceSnapshot.role !== "unseen-disjoint-holdout-source") failures.push("preRegisteredHoldout source snapshot schema is invalid");
    if (!Number.isSafeInteger(sourceSnapshot.chainVersion) || sourceSnapshot.chainVersion < 1 || typeof sourceSnapshot.workspaceId !== "string" || !/^[a-f0-9]{64}$/u.test(String(sourceSnapshot.headEventHash)) || !Array.isArray(sourceSnapshot.records) || sourceSnapshot.recordsDigest !== canonicalSha256(sourceSnapshot.records)) failures.push("preRegisteredHoldout source snapshot binding is invalid");
    if (frozen.sourceSnapshot?.chainVersion !== sourceSnapshot.chainVersion || frozen.sourceSnapshot?.headEventHash !== sourceSnapshot.headEventHash || frozen.sourceSnapshot?.recordsDigest !== sourceSnapshot.recordsDigest || frozen.frozenAt !== sourceSnapshot.capturedAt || declared.sourceChainVersion !== sourceSnapshot.chainVersion || declared.sourceHeadEventHash !== sourceSnapshot.headEventHash || declared.sourceRecordsDigest !== sourceSnapshot.recordsDigest) failures.push("preRegisteredHoldout source snapshot does not match its frozen binding");
  }

  const selection = frozen.sourceSelection;
  const keys = selection?.externalKeys;
  if (selection?.kind !== "Work" || !Array.isArray(selection?.allowedKinds) || selection.allowedKinds.join("\n") !== ["Incident", "Story"].join("\n") || !Array.isArray(keys) || keys.length !== new Set(keys).size || [...keys].sort().join("\n") !== keys.join("\n") || selection.selectionDigest !== canonicalSha256(keys)) failures.push("preRegisteredHoldout source selection is not a sorted disjoint Work set");
  const labels = frozen.labelPolicy;
  if (labels?.kind !== "Work" || labels?.expectedIdRule !== "source.workId only" || labels?.createdBeforeScoring !== true || labels?.modelCalls !== 0 || labels?.priorPromptDisjoint !== true || labels?.promptRule !== "问题：<source.title>。<source.summary>") failures.push("preRegisteredHoldout label policy is not pre-registered source identity");
  if (!Array.isArray(frozen.priorPromptSources) || frozen.priorPromptSources.length !== 4 || frozen.priorPromptDigest !== canonicalSha256([...priorPrompts].sort())) failures.push("preRegisteredHoldout prior prompt registry is missing or drifted");
  const thresholdFields = ["pairsAtLeast", "hitAt1", "hitAt3", "hitAt8"];
  if (!frozen.thresholds || thresholdFields.some((field) => frozen.thresholds[field] !== declared[field])) failures.push("preRegisteredHoldout thresholds drifted between fixture and policy");

  const oldIds = new Set(work.map((record) => record.id));
  const sourceById = new Map((sourceSnapshot?.records ?? []).map((record) => [record.id, record]));
  const seen = new Set();
  const prompts = new Set();
  for (const pair of frozen.records ?? []) {
    const source = pair?.source;
    const current = sourceById.get(source?.id);
    const expectedIds = pair?.label?.expectedIds;
    if (!source || current === undefined || seen.has(source?.id)) { failures.push(`preRegisteredHoldout source ${source?.id ?? "missing"} is missing or duplicated`); continue; }
    seen.add(source.id);
    if (oldIds.has(source.id) || !["Incident", "Story"].includes(source.kind) || source.externalKey !== current.externalKey || source.status !== current.status || source.title !== current.title || source.summary !== current.summary) failures.push(`preRegisteredHoldout source ${source.id} is not a disjoint frozen Work record`);
    if (source.sourceRecordDigest !== canonicalSha256(holdoutSourceProjection(source))) failures.push(`preRegisteredHoldout record digest drift for ${source.id}`);
    if (!/^[a-f0-9]{64}$/u.test(String(source.scopeDigest)) || !Number.isSafeInteger(source.revision) || !Array.isArray(source.labels)) failures.push(`preRegisteredHoldout source projection invalid for ${source.id}`);
    const expectedPrompt = holdoutPrompt(source);
    if (!Array.isArray(expectedIds) || expectedIds.length !== 1 || expectedIds[0] !== source.id || typeof pair.prompt !== "string" || pair.prompt !== expectedPrompt || prompts.has(pair.prompt) || priorPrompts.has(pair.prompt) || typeof pair.label?.basis !== "string" || !pair.label.basis.includes("manual identity")) failures.push(`preRegisteredHoldout label or prior-prompt disjointness invalid for ${source.id}`);
    prompts.add(pair.prompt);
  }
  if (!Array.isArray(frozen.records) || frozen.records.length < (declared.pairsAtLeast ?? 20)) failures.push(`preRegisteredHoldout records ${frozen.records?.length ?? 0} < ${declared.pairsAtLeast}`);
  if (seen.size !== frozen.records?.length || seen.size !== keys?.length || seen.size !== sourceSnapshot?.records?.length || [...seen].some((id) => !sourceById.has(id)) || keys?.join("\n") !== [...(sourceSnapshot?.records ?? [])].map((record) => record.externalKey).sort().join("\n")) failures.push("preRegisteredHoldout source identities are not complete");
  return failures.length === 0
    ? { ok: true, records: frozen.records.map((pair) => ({ prompt: pair.prompt, expectedIds: pair.label.expectedIds })), sourceRecords: sourceSnapshot.records, fixtureDigest, sourceFiles, role: declared.role, thresholds: Object.fromEntries(thresholdFields.map((field) => [field, declared[field]])) }
    : { ok: false, failures };
}
