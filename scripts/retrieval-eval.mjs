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
import { buildIncidentReplay } from "./incident-replay.mjs";

const SCOPE_EXCERPT_BYTES = 512;
const TOP_K = 8;
const PRECISION_K = 3;

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

  const cardDocuments = recallDocuments({ knowledge });
  const mixedDocuments = recallDocuments({ knowledge, minutes, work, scopeExcerptBytes: SCOPE_EXCERPT_BYTES });
  const cardIndex = new RecallIndex(cardDocuments, "cards");
  const mixedIndex = new RecallIndex(mixedDocuments, "mixed");

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

  const queries = readJson(fixture("synthetic-queries.json")).queries;
  const cardsOnly = scoreOf(queries.map((query) => rankCards(query.query, query.id)));
  const mixed = scoreOf(queries.map((query) => rankMixed(query.query, query.id)));

  // Real prompts. The gold labels mark relevant candidates by their position in the
  // judge sheet's candidate list, so the positions are resolved back to document ids and
  // the current ranking is scored against those ids. Anything the judged pool never
  // contained is unjudged and counts against precision, which makes this a floor rather
  // than an estimate.
  const judged = Object.values(readJson(fixture("judge-sheet.json")));
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
  const translated = readJson(fixture("translations-sonnet.json")).queries;
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
    externalKey,
    metrics: ["@1", "@3", "@8", "precision@3"],
  };
  if (failures.length > 0) result.message = failures.join("; ");
  cardIndex.close();
  mixedIndex.close();
  return result;
}
