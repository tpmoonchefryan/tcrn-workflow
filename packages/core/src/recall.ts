// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-362 — the FTS5 recall core.
//
// WHAT THIS REPLACES. Retrieval on this platform was substring matching over card
// metadata, with a query tokenizer that kept a contiguous CJK run whole. A prompt
// written in Chinese therefore produced one enormous token that matched nothing, and
// two real prompts measured on 2026-09-04 returned zero cards; the same prompts in
// English returned every card carrying the tag someone happened to type. Neither
// answer is retrieval: one is silence and the other is the whole library.
//
// WHAT IT IS. One in-memory SQLite FTS5 index over the three record families a session
// can be reminded of — knowledge cards, conference minutes, work records — ranked by
// bm25 with per-field weights, with contiguous CJK segmented into overlapping bigrams
// on BOTH the index side and the query side. Bigrams are what make a Chinese prompt
// searchable at all without a dictionary: a four-character phrase indexes as its three
// overlapping pairs, and a differently worded question that shares one pair finds it.
//
// WHY node:sqlite AND NOTHING ELSE. This repository declares zero runtime dependencies
// and verify:p1's offline leg refuses any module that reaches the network. node:sqlite
// is a Node built-in on the pinned 24.16.0 runtime, its bundled SQLite is 3.53.0, and
// FTS5 and bm25 are compiled into it. Nothing is downloaded, nothing is built natively,
// and the offline boundary does not move.
//
// WHY THE INDEX IS DERIVED AND NEVER STORED. It is rebuilt from the chain and the
// knowledge store, so it can be thrown away at any moment without losing a fact. What
// it costs to rebuild is what the checkpoint cache below exists to avoid paying twice.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type RecallKind = "card" | "minutes" | "work";

/** One indexed record, reduced to the four ranked fields plus what a caller reads back. */
export interface RecallDocument {
  readonly id: string;
  readonly kind: RecallKind;
  readonly key: string;
  readonly status: string;
  readonly title: string;
  readonly body: string;
  readonly tags: string;
  readonly expansions: string;
  readonly summary: string;
}

export interface RecallHit {
  readonly kind: RecallKind;
  readonly key: string;
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly summary: string;
  readonly score: number;
}

export interface RecallSelectionOptions {
  readonly tau?: number;
  readonly relativeFloor?: number;
  readonly limit?: number;
  readonly quota?: Readonly<Record<RecallKind, number>> | null;
}

/**
 * The measured field weights. Subject/title carries the strongest signal, an author's
 * own restatements of the question (expansions) the next, the closed tag vocabulary
 * next, and the prose body least because it is the longest and the least deliberate.
 * The numbers are the ones the 2026-09-04 retrieval evaluation settled on.
 */
export const RECALL_FIELD_WEIGHTS = { title: 8, body: 3, tags: 5, expansions: 6, externalKey: 1 } as const;

/**
 * The absolute floor, in bm25 units, and the default of the `retrieval.tau` setting.
 * A term carried by most of the corpus scores near zero by construction — FTS5 clamps
 * a non-positive inverse document frequency rather than letting it go negative — so
 * this floor is what turns "every card is tagged lesson" into no answer instead of the
 * whole library. Measured: the query `lesson` over the 36-card corpus tops out at
 * 0.000, where the substring retrieval it replaces returned all 19 tagged cards.
 */
export const RECALL_DEFAULT_TAU = 1;

/**
 * The relative floor, as a fraction of the best bm25 score in the same answer. The
 * absolute floor alone cannot tell a query with one strong match and a long tail from
 * a query where everything matched equally; this one drops the tail. 0.25 is the
 * largest value that leaves the mixed-index criterion at its measured 20 of 36 — 0.30
 * costs two of them, and the 0.40 the exploratory script used costs three.
 */
export const RECALL_RELATIVE_FLOOR = 0.25;

/**
 * Per-kind caps, so one loud family cannot fill the answer. A session asking about a
 * defect wants the card, the minutes that decided it and the record that carries it,
 * not eight work records.
 */
export const RECALL_KIND_QUOTA: Readonly<Record<RecallKind, number>> = { card: 3, minutes: 3, work: 2 };

export const RECALL_DEFAULT_LIMIT = 8;

/** How deep the ranked list goes before selection, so the quota has something to choose from. */
export const RECALL_CANDIDATE_LIMIT = 80;

/**
 * The score an exact external-key match carries. It is not a bm25 number and is not
 * meant to be comparable with one: naming a record by its key is not a guess about
 * relevance, so the hit is placed first and kept out of the relative floor's basis.
 */
export const RECALL_EXTERNAL_KEY_SCORE = 99;

const CJK_RUN = /[㐀-鿿豈-﫿]+/gu;
const ASCII_TOKEN = /[a-z0-9][a-z0-9_.-]{1,31}/gu;
const EXTERNAL_KEY_CANDIDATE = /[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+/gu;
const MAXIMUM_QUERY_TOKENS = 24;

/**
 * Bigrams that carry no topic. They are the connective tissue of a spoken question,
 * and every one of them appears in a large fraction of the corpus, so leaving them in
 * costs a query slot and buys nothing.
 */
const STOP_BIGRAMS: ReadonlySet<string> = new Set([
  "应该", "怎么", "需要", "可以", "没有",
  "什么", "这个", "那个", "一个", "如果",
  "然后", "现在", "已经", "还是", "还有",
  "就是", "不是", "但是", "因为", "所以",
  "或者", "以及", "对于", "关于", "这样",
  "那样", "这些", "那些", "我们", "你们",
  "他们", "它们", "帮我", "一下", "是否",
  "怎样", "如何", "请你", "你的", "我的",
  "的话", "而且", "并且", "以后", "之后",
  "之前", "这里", "那里", "一起", "一样",
  "同时", "另外", "其实", "其他", "这次",
  "上次", "下次", "这种", "情况", "为啥",
]);

function bigrams(run: string): readonly string[] {
  const out: string[] = [];
  for (let index = 0; index < run.length - 1; index += 1) out.push(run.slice(index, index + 2));
  return out;
}

/**
 * Index-side segmentation: every contiguous CJK run becomes its overlapping bigrams,
 * space separated, and everything else is left exactly as it was. A one-character run
 * has no bigram and is kept whole rather than dropped.
 */
export function segmentForIndex(text: string): string {
  return String(text ?? "").replace(CJK_RUN, (run) => bigrams(run).join(" ") || run);
}

/** Query-side tokens: lowercased ASCII words and CJK bigrams, stop bigrams removed. */
export function recallQueryTokens(text: string): readonly string[] {
  const tokens = new Set<string>();
  for (const match of String(text ?? "").toLowerCase().matchAll(ASCII_TOKEN)) {
    tokens.add(match[0].replace(/[.-]+$/u, ""));
  }
  for (const run of String(text ?? "").match(CJK_RUN) ?? []) {
    for (const gram of bigrams(run)) if (!STOP_BIGRAMS.has(gram)) tokens.add(gram);
  }
  return [...tokens].filter((token) => token.length >= 2).slice(0, MAXIMUM_QUERY_TOKENS);
}

/**
 * External keys spelled in the prompt. Deliberately not a pattern for this platform's
 * own key shape: the roster of prefixes is a chain fact, so the test is "does the
 * corpus hold a record with exactly this key", which stays correct when the roster
 * grows. TCRN-CROSS-MIN-ACCEPTANCE-LANES is a live key, and a pattern demanding a
 * numeric suffix would not have found it.
 */
export function externalKeyCandidates(text: string): readonly string[] {
  return [...new Set([...String(text ?? "").matchAll(EXTERNAL_KEY_CANDIDATE)].map((match) => match[0].toUpperCase()))];
}

function externalKeyTokens(text: string): readonly string[] {
  return [...new Set(text
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/gu) ?? [])];
}

function externalKeyExpression(query: string): string {
  return (query.match(/[A-Za-z0-9][A-Za-z0-9-]*/gu) ?? [])
    .slice(0, MAXIMUM_QUERY_TOKENS)
    .map((part) => externalKeyTokens(part).map((token) => `"${token}"*`).join(" AND "))
    .filter((part) => part.length > 0)
    .map((part) => `(${part})`)
    .join(" OR ");
}

function documentDigest(document: RecallDocument): string {
  return createHash("sha256")
    .update(`${document.key}\u0000${document.title}\u0000${document.body}\u0000${document.tags}\u0000${document.expansions}`, "utf8")
    .digest("hex");
}

function matchExpression(tokens: readonly string[]): string {
  return tokens.map((token) => `"${token.replace(/"/gu, "")}"`).join(" OR ");
}

interface IndexedRow {
  readonly rowId: number;
  readonly digest: string;
  readonly document: RecallDocument;
}

function hitOf(document: RecallDocument, score: number): RecallHit {
  return {
    kind: document.kind,
    key: document.key,
    id: document.id,
    status: document.status,
    title: document.title,
    summary: document.summary,
    score,
  };
}

/**
 * The index itself. It is mutable on purpose: the checkpoint cache hands the same
 * instance to the next query, and a chain that has moved gets the rows that actually
 * changed rewritten rather than the whole table rebuilt.
 */
export class RecallIndex {
  #database: DatabaseSync;
  #rows = new Map<string, IndexedRow>();
  #byExternalKey = new Map<string, RecallDocument>();
  #nextRowId = 1;
  #checkpoint: string;

  constructor(documents: readonly RecallDocument[], checkpoint: string) {
    this.#database = new DatabaseSync(":memory:");
    // The fifth column serves key queries. The four-column projection preserves
    // prose BM25 statistics: a zero weight would still count key tokens in length.
    this.#database.exec(
      "CREATE VIRTUAL TABLE recall_index USING fts5(title, body, tags, expansions, externalKey, tokenize='unicode61');"
        + "CREATE VIRTUAL TABLE recall_prose USING fts5(title, body, tags, expansions, tokenize='unicode61')",
    );
    this.#checkpoint = checkpoint;
    this.#apply(documents);
  }

  get checkpoint(): string {
    return this.#checkpoint;
  }

  get size(): number {
    return this.#rows.size;
  }

  /** Rewrite only what moved, and report how much moved. */
  update(
    documents: readonly RecallDocument[],
    checkpoint: string,
  ): { readonly inserted: number; readonly removed: number } {
    const moved = this.#apply(documents);
    this.#checkpoint = checkpoint;
    return moved;
  }

  #apply(documents: readonly RecallDocument[]): { readonly inserted: number; readonly removed: number } {
    const insert = this.#database.prepare(
      "INSERT INTO recall_index(rowid, title, body, tags, expansions, externalKey) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertProse = this.#database.prepare(
      "INSERT INTO recall_prose(rowid, title, body, tags, expansions) VALUES (?, ?, ?, ?, ?)",
    );
    const remove = this.#database.prepare("DELETE FROM recall_index WHERE rowid = ?");
    const removeProse = this.#database.prepare("DELETE FROM recall_prose WHERE rowid = ?");
    const incoming = new Map<string, RecallDocument>();
    for (const document of documents) incoming.set(document.id, document);
    let removed = 0;
    for (const [id, row] of [...this.#rows]) {
      const next = incoming.get(id);
      if (next !== undefined && documentDigest(next) === row.digest) continue;
      remove.run(row.rowId);
      removeProse.run(row.rowId);
      this.#rows.delete(id);
      removed += 1;
    }
    let inserted = 0;
    for (const [id, document] of incoming) {
      if (this.#rows.has(id)) continue;
      const rowId = this.#nextRowId;
      this.#nextRowId += 1;
      const fields = [
        segmentForIndex(document.title),
        segmentForIndex(document.body),
        segmentForIndex(document.tags),
        segmentForIndex(document.expansions),
      ];
      insert.run(rowId, ...fields, externalKeyTokens(document.key).join(" "));
      insertProse.run(rowId, ...fields);
      this.#rows.set(id, { rowId, digest: documentDigest(document), document });
      inserted += 1;
    }
    this.#byExternalKey = new Map();
    for (const row of this.#rows.values()) {
      if (row.document.key.length > 0) this.#byExternalKey.set(row.document.key.toUpperCase(), row.document);
    }
    return { inserted, removed };
  }

  /** The ranked answer, before any threshold. Exact external-key hits lead. */
  search(query: string, limit: number = RECALL_CANDIDATE_LIMIT): readonly RecallHit[] {
    const hits: RecallHit[] = [];
    const seen = new Set<string>();
    for (const key of externalKeyCandidates(query)) {
      const document = this.#byExternalKey.get(key);
      if (document === undefined || seen.has(document.id)) continue;
      seen.add(document.id);
      hits.push(hitOf(document, RECALL_EXTERNAL_KEY_SCORE));
    }
    const tokens = recallQueryTokens(query);
    const keyExpression = externalKeyExpression(query);
    if (tokens.length === 0 && keyExpression.length === 0) return hits;
    const byRowId = new Map<number, RecallDocument>();
    for (const row of this.#rows.values()) byRowId.set(row.rowId, row.document);
    const weights = RECALL_FIELD_WEIGHTS;
    const rows: Record<string, unknown>[] = [];
    const searches = [
      {
        table: "recall_prose",
        weights: [weights.title, weights.body, weights.tags, weights.expansions],
        expression: matchExpression(tokens),
      },
      {
        table: "recall_index",
        weights: [weights.title, weights.body, weights.tags, weights.expansions, weights.externalKey],
        expression: keyExpression.length === 0 ? "" : `externalKey : (${keyExpression})`,
      },
    ];
    for (const search of searches) {
      if (search.expression.length === 0) continue;
      const statement = this.#database.prepare(
        `SELECT rowid AS rowId, bm25(${search.table}, ${search.weights.join(", ")}) AS score`
          + ` FROM ${search.table} WHERE ${search.table} MATCH ? ORDER BY score LIMIT ?`,
      );
      try {
        rows.push(...statement.all(search.expression, limit) as Record<string, unknown>[]);
      } catch {
        // An invalid prompt expression contributes no hits from this table.
      }
    }
    // Keep the strongest score for a record found by both routes, never sum them.
    // The prose route retains its original length and document-frequency statistics.
    rows.sort((left, right) => Number(left["score"]) - Number(right["score"]));
    const maximumHits = limit < 0 ? Number.POSITIVE_INFINITY : hits.length + limit;
    for (const row of rows) {
      const document = byRowId.get(Number(row["rowId"]));
      if (document === undefined || seen.has(document.id)) continue;
      seen.add(document.id);
      hits.push(hitOf(document, -Number(row["score"])));
      if (hits.length >= maximumHits) break;
    }
    return hits;
  }

  close(): void {
    this.#database.close();
  }
}

/**
 * Absolute floor, then relative floor, then the per-kind quota, then the limit. The
 * relative floor's basis is the best bm25 score rather than the best score outright,
 * so a prompt that names one record by key does not silence everything else.
 */
export function selectRecallHits(
  ranked: readonly RecallHit[],
  options: RecallSelectionOptions = {},
): readonly RecallHit[] {
  const tau = options.tau ?? RECALL_DEFAULT_TAU;
  const relativeFloor = options.relativeFloor ?? RECALL_RELATIVE_FLOOR;
  const limit = options.limit ?? RECALL_DEFAULT_LIMIT;
  const quota = options.quota === undefined ? RECALL_KIND_QUOTA : options.quota;
  const best = ranked.find((hit) => hit.score !== RECALL_EXTERNAL_KEY_SCORE)?.score ?? 0;
  const floor = Math.max(tau, best * relativeFloor);
  const taken = new Map<RecallKind, number>();
  const out: RecallHit[] = [];
  for (const hit of ranked) {
    if (hit.score !== RECALL_EXTERNAL_KEY_SCORE && hit.score < floor) continue;
    if (quota !== null) {
      const cap = quota[hit.kind];
      if ((taken.get(hit.kind) ?? 0) >= cap) continue;
      taken.set(hit.kind, (taken.get(hit.kind) ?? 0) + 1);
    }
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

export interface RecallKnowledgeInput {
  readonly id: string;
  readonly externalKey: string;
  readonly subject: string;
  readonly summary: string;
  readonly snippet: string;
  /** Optional source text is accepted at the boundary only to prove it is ignored. */
  readonly body?: string;
  readonly tags: readonly string[];
  readonly expansions?: string;
}

export interface RecallMinutesInput {
  readonly id: string;
  readonly conferenceTitle: string;
  readonly conferenceType: string;
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly outcomeClass: string;
}

export interface RecallWorkInput {
  readonly id: string;
  readonly externalKey: string;
  readonly kind: string;
  readonly status: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly scope: string;
  readonly labels: readonly string[];
}

export interface RecallInputs {
  readonly knowledge?: readonly RecallKnowledgeInput[];
  readonly minutes?: readonly RecallMinutesInput[];
  readonly work?: readonly RecallWorkInput[];
  readonly scopeExcerptBytes?: number;
}

export const RECALL_DEFAULT_SCOPE_EXCERPT_BYTES = 512;

function excerpt(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

// Knowledge article cards carry only an index contract in the store. Keep the
// recall projection metadata-only as well: the Markdown source is deliberately
// not a RecallKnowledgeInput field, so a body-only term cannot enter the FTS5
// corpus through this adapter.
function knowledgeMetadataBody(card: RecallKnowledgeInput): string {
  return `${card.summary} ${card.snippet}`.trim();
}

/**
 * The three record families reduced to documents.
 *
 * A work record's summary text is its `summary` field when it has one and the bounded
 * head of its scope otherwise, which is the length `retrieval.scopeExcerptBytes` has
 * always governed. A record with neither a title nor summary text is not indexed: of
 * the 802 work records on the cross-project chain on 2026-09-04, 747 carried nothing a
 * reader could have typed, and indexing them adds 747 documents of pure length
 * normalisation to every bm25 score in the corpus.
 */
export function recallDocuments(inputs: RecallInputs): readonly RecallDocument[] {
  const scopeExcerptBytes = inputs.scopeExcerptBytes ?? RECALL_DEFAULT_SCOPE_EXCERPT_BYTES;
  const documents: RecallDocument[] = [];
  for (const card of inputs.knowledge ?? []) {
    documents.push({
      id: card.id,
      kind: "card",
      key: card.externalKey,
      status: "active",
      title: card.subject,
      body: knowledgeMetadataBody(card),
      tags: card.tags.join(" "),
      expansions: card.expansions ?? "",
      summary: card.summary,
    });
  }
  for (const minutes of inputs.minutes ?? []) {
    documents.push({
      id: minutes.id,
      kind: "minutes",
      key: minutes.id,
      status: minutes.outcomeClass,
      title: minutes.conferenceTitle,
      // Decision references are hyphen-joined identifiers; splitting them lets a prompt
      // naming one part of a ruling reach the minutes that carry it.
      body: `${minutes.summary} ${minutes.decisions.join(" ").replace(/-/gu, " ")}`.trim(),
      tags: `minutes ${minutes.conferenceType}`.trim(),
      expansions: "",
      summary: minutes.summary,
    });
  }
  for (const record of inputs.work ?? []) {
    const title = record.title ?? "";
    const summary = record.summary !== null && record.summary.length > 0
      ? record.summary
      : excerpt(record.scope, scopeExcerptBytes);
    if (title.length === 0 && summary.length === 0) continue;
    documents.push({
      id: record.id,
      kind: "work",
      key: record.externalKey,
      status: record.status,
      title,
      body: summary,
      tags: `${record.kind} ${record.status} ${record.labels.join(" ")}`.trim(),
      expansions: "",
      summary,
    });
  }
  return documents;
}

export interface RecallRequest {
  /** Which store this index belongs to. One entry per workspace root. */
  readonly cacheKey: string;
  /** The storage checkpoint the documents were read at: chain head plus knowledge marker. */
  readonly checkpoint: string;
  /** Read lazily, so a query answered from the cache never pays for the read. */
  readonly documents: () => readonly RecallDocument[];
  readonly query: string;
  readonly tau?: number;
  readonly relativeFloor?: number;
  readonly limit?: number;
  readonly quota?: Readonly<Record<RecallKind, number>> | null;
}

export interface RecallResult {
  readonly reasonCode: "RECALL_READY";
  readonly checkpoint: string;
  readonly indexed: number;
  readonly rebuilt: boolean;
  readonly inserted: number;
  readonly removed: number;
  readonly tokens: readonly string[];
  readonly tau: number;
  readonly relativeFloor: number;
  readonly limit: number;
  readonly total: number;
  readonly records: readonly RecallHit[];
}

/**
 * TCRN-CROSS-STORY-362 requirement 5. The index is cached against the storage
 * checkpoint, so a second query at the same chain head reads nothing and rebuilds
 * nothing; a moved chain head rewrites the rows whose own digest changed and leaves
 * the rest of the table in place. Bounded to a handful of workspaces, because the
 * whole point of this structure is that it is derived state and not a store.
 */
const CACHE_LIMIT = 4;
const cachedIndexes = new Map<string, RecallIndex>();

export function recall(request: RecallRequest): RecallResult {
  let index = cachedIndexes.get(request.cacheKey);
  let rebuilt = false;
  let moved = { inserted: 0, removed: 0 };
  if (index === undefined) {
    index = new RecallIndex(request.documents(), request.checkpoint);
    rebuilt = true;
    moved = { inserted: index.size, removed: 0 };
  } else if (index.checkpoint !== request.checkpoint) {
    moved = index.update(request.documents(), request.checkpoint);
    rebuilt = true;
  }
  cachedIndexes.delete(request.cacheKey);
  cachedIndexes.set(request.cacheKey, index);
  while (cachedIndexes.size > CACHE_LIMIT) {
    const oldest = [...cachedIndexes.keys()][0]!;
    cachedIndexes.get(oldest)?.close();
    cachedIndexes.delete(oldest);
  }
  const ranked = index.search(request.query);
  const tau = request.tau ?? RECALL_DEFAULT_TAU;
  const relativeFloor = request.relativeFloor ?? RECALL_RELATIVE_FLOOR;
  const limit = request.limit ?? RECALL_DEFAULT_LIMIT;
  const records = selectRecallHits(ranked, {
    tau,
    relativeFloor,
    limit,
    quota: request.quota === undefined ? RECALL_KIND_QUOTA : request.quota,
  });
  return {
    reasonCode: "RECALL_READY",
    checkpoint: request.checkpoint,
    indexed: index.size,
    rebuilt,
    inserted: moved.inserted,
    removed: moved.removed,
    tokens: recallQueryTokens(request.query),
    tau,
    relativeFloor,
    limit,
    total: ranked.length,
    records,
  };
}

/** Drop every cached index. For a process that wants the memory back. */
export function resetRecallCache(): void {
  for (const index of cachedIndexes.values()) index.close();
  cachedIndexes.clear();
}
