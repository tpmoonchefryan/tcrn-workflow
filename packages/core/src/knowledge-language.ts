// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";
import { readDispatchConfig } from "./dispatch-config.js";

/**
 * TCRN-CROSS-STORY-364: the artefact language of a knowledge card, and the question
 * phrasings a card is retrievable by.
 *
 * WHY THIS IS A MODULE AND NOT A BRANCH INSIDE knowledge-core. Two facts about a card are
 * decided here and nowhere else: which language its prose is written in, and which
 * restatements of the question it answers are indexed beside it. Both are read by the
 * write path (knowledge-core) and by the read path (the recall verb's prompt-language
 * fallback), and a copy on each side would be two answers to one question.
 *
 * WHAT THIS MODULE DOES NOT DO. It never calls a model. The engine is offline by
 * construction -- packages/* declare no runtime dependency and scripts/lib/local-command
 * admits only node and git -- so the translation and the phrasings arrive as data, from a
 * provider the caller supplies. The setting names the model that produced them; the model
 * name never appears in this file (Owner ruling TCRN-CROSS-MIN-152 D3).
 */
export const KNOWLEDGE_LANGUAGE_VERSION = "tcrn.knowledge-language.v1" as const;

/**
 * The closed roster of artefact languages. It is closed because detectLanguage below can
 * only tell these two apart, and a setting that admitted a tag the detector cannot judge
 * would record a policy nothing enforces.
 */
export const ARTIFACT_LANGUAGE_TAGS = Object.freeze(["en", "zh-CN"] as const);
export type ArtifactLanguageTag = typeof ARTIFACT_LANGUAGE_TAGS[number];

export const KNOWLEDGE_EXPANSION_LIMITS = Object.freeze({
  minimumPhrasings: 3,
  maximumPhrasings: 4,
  maximumPhrasingBytes: 256,
  // The normative budget the Story states: one card's whole expansions map, canonically
  // serialised, in UTF-8 bytes.
  maximumBytes: 1_024,
});

/**
 * Measurement over the live-store acceptance corpus (20 zh-CN fields, 57 en fields, and 4
 * English fields quoting Chinese terms) showed that a ratio boundary is not dependable: short
 * Chinese prose containing commands has a low ratio even after cleanup. Identifier-shaped
 * ASCII runs are removed by character span, never by whitespace token, and two surviving
 * ideographs are sufficient for zh-CN. The boundary is delicate for intentionally quoted
 * Chinese terms, so those cases remain explicit regression coverage rather than a claimed margin.
 *
 * Owner ruling TCRN-CROSS-MIN-177 D1 accepts one known limitation. English prose that quotes
 * Chinese terms is judged zh-CN: the detector counts surviving ideographs, not which language
 * wrote the sentence around them, so two quoted characters are enough regardless of how many
 * English words surround them. The consequence is that such a card is treated as already in
 * the artefact language, so it is not translated and nothing is rewritten. That direction is
 * the one accepted, because the two misjudgments do not cost the same: a Chinese card
 * misjudged as English reaches applyWriteLanguagePolicy believing a translation is owed,
 * which either sends human-written prose to a model to be rewritten or refuses the write
 * outright, while an English card whose Chinese quotes are misjudged the other way only means
 * a translation that could have run does not -- the text is stored exactly as it was handed
 * in. The cheap direction is the one left uncorrected.
 */
const MINIMUM_CJK_IDEOGRAPHS = 2;

const IDEOGRAPH = /[㐀-䶿一-鿿豈-﫿]/gu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const CODE_SPAN_OR_URL_OR_PATH = /`[^`]*`|https?:\/\/\S+|(?:^|\s)(?:\.\.\/|\.\/|\/)?[\w.-]+(?:\/[\w.-]+)+(?:\s|$)/gu;
const IDENTIFIER_RUN = /[A-Za-z0-9_.:/#-]*[0-9_.:/#-][A-Za-z0-9_.:/#-]*/gu;

export function detectLanguage(text: string): ArtifactLanguageTag {
  const prose = text.replace(CODE_SPAN_OR_URL_OR_PATH, " ").replace(IDENTIFIER_RUN, " ");
  const ideographs = (prose.match(IDEOGRAPH) ?? []).length;
  return ideographs >= MINIMUM_CJK_IDEOGRAPHS
    ? "zh-CN"
    : "en";
}

export function isArtifactLanguageTag(value: unknown): value is ArtifactLanguageTag {
  return typeof value === "string" && (ARTIFACT_LANGUAGE_TAGS as readonly string[]).includes(value);
}

/**
 * `retrieval.promptLanguages` is a list held in the one value shape the settings catalog
 * has: a canonically sorted, comma-separated string of roster tags. Parsing is total --
 * an unreadable value reads as "unset" rather than throwing -- because the read path must
 * still answer a recall when the workspace's own setting is malformed.
 */
export function parsePromptLanguages(value: string | null): readonly ArtifactLanguageTag[] {
  if (value === null || value.length === 0) return [];
  const parts = value.split(",").map((part) => part.trim());
  if (!parts.every((part) => isArtifactLanguageTag(part))) return [];
  const unique = [...new Set(parts)] as ArtifactLanguageTag[];
  return Object.freeze(unique.sort(compareCanonicalText));
}

export type KnowledgeExpansions = Readonly<Record<string, readonly string[]>>;

export interface KnowledgeLanguagePolicy {
  /** null when this workspace has recorded no artefact language: the hook is not configured. */
  readonly artifactLanguage: ArtifactLanguageTag | null;
  /** Defaults to the artefact language, which is what requirement 1 states the default is. */
  readonly promptLanguages: readonly ArtifactLanguageTag[];
  /** null when no economy-tier model is recorded: no model is available. */
  readonly economyModel: string | null;
}

export interface SettingsView {
  readonly key: string;
  readonly value: string;
}

export function readKnowledgeLanguagePolicy(settings: readonly SettingsView[], host?: string): KnowledgeLanguagePolicy {
  const valueOf = (key: string): string | null => settings.find((entry) => entry.key === key)?.value ?? null;
  const artifactValue = valueOf("artifact.language");
  const artifactLanguage = isArtifactLanguageTag(artifactValue) ? artifactValue : null;
  const declared = parsePromptLanguages(valueOf("retrieval.promptLanguages"));
  const promptLanguages = declared.length > 0
    ? declared
    : (artifactLanguage === null ? Object.freeze([]) as readonly ArtifactLanguageTag[] : Object.freeze([artifactLanguage]));
  let economyModel: string | null = null;
  if (host !== undefined) {
    try {
      const configured = readDispatchConfig(settings).tiers[host]?.economy?.model;
      economyModel = configured === undefined || configured.length === 0 ? null : configured;
    } catch {
      economyModel = null;
    }
  }
  return Object.freeze({
    artifactLanguage,
    promptLanguages,
    economyModel: economyModel === null || economyModel.length === 0 ? null : economyModel,
  });
}

export function expansionsAreBounded(value: unknown): value is KnowledgeExpansions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>);
  const shapeIsSound = entries.every(([key, list]) => isArtifactLanguageTag(key) &&
    Array.isArray(list) &&
    list.length >= KNOWLEDGE_EXPANSION_LIMITS.minimumPhrasings &&
    list.length <= KNOWLEDGE_EXPANSION_LIMITS.maximumPhrasings &&
    list.every((phrasing, index) => typeof phrasing === "string" && phrasing.length > 0 &&
      Buffer.byteLength(phrasing, "utf8") <= KNOWLEDGE_EXPANSION_LIMITS.maximumPhrasingBytes &&
      !CONTROL_CHARACTER.test(phrasing) &&
      (index === 0 || compareCanonicalText(String(list[index - 1]), phrasing) < 0)));
  if (!shapeIsSound) return false;
  if (entries.length === 0) return true;
  try {
    return Buffer.byteLength(canonicalJson(value as never), "utf8") <= KNOWLEDGE_EXPANSION_LIMITS.maximumBytes;
  } catch {
    return false;
  }
}

/**
 * The weight-6 recall column is one text field, so the map is flattened in one place
 * rather than at each call site.
 */
export function expansionsText(value: unknown): string {
  if (!expansionsAreBounded(value)) return "";
  const map = value as KnowledgeExpansions;
  return Object.keys(map).sort(compareCanonicalText)
    .flatMap((tag) => [...(map[tag] ?? [])]).join("\n");
}

export const KNOWLEDGE_LANGUAGE_TRANSLATED_FIELDS = Object.freeze(["snippet", "subject", "summary"] as const);
export type KnowledgeLanguageField = typeof KNOWLEDGE_LANGUAGE_TRANSLATED_FIELDS[number];

export interface KnowledgeLanguageProvider {
  /** The model that produced these answers, checked against the recorded economy tier. */
  readonly model: string;
  translate(text: string, target: ArtifactLanguageTag, field: KnowledgeLanguageField): string;
  expand(subject: string, summary: string, language: ArtifactLanguageTag): readonly string[];
}

export interface KnowledgeLanguageFields {
  readonly subject: string;
  readonly summary: string;
  readonly snippet: string;
}

export interface KnowledgeLanguageWriteResult extends KnowledgeLanguageFields {
  readonly expansions: KnowledgeExpansions;
}

export type KnowledgeLanguageRefusal =
  | "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE"
  | "KNOWLEDGE_LANGUAGE_INVALID";

export class KnowledgeLanguageError extends Error {
  readonly reasonCode: KnowledgeLanguageRefusal;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(reasonCode: KnowledgeLanguageRefusal, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "KnowledgeLanguageError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

/**
 * The write-path hook, as a pure function of the policy and the provider.
 *
 * Fail-closed by construction (requirement 3). A workspace that has recorded an artefact
 * language has declared that its cards are written in one language and carry phrasings; a
 * write that cannot satisfy that declaration is refused with a reason code rather than
 * stored in whatever language it arrived in. The two ways of being unable are named apart:
 * no economy-tier model is recorded at all, or one is recorded and the caller brought no
 * answers from it.
 *
 * A workspace that has recorded no artefact language is unchanged: no translation, no
 * phrasings, an empty map. That is not a silent degradation -- it is a deployment that
 * never turned the hook on.
 */
export function applyWriteLanguagePolicy(
  fields: KnowledgeLanguageFields,
  policy: KnowledgeLanguagePolicy,
  provider?: KnowledgeLanguageProvider,
): KnowledgeLanguageWriteResult {
  if (policy.artifactLanguage === null) {
    return { ...fields, expansions: Object.freeze({}) };
  }
  const target = policy.artifactLanguage;
  if (policy.economyModel === null) {
    throw new KnowledgeLanguageError(
      "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE",
      "artifact.language is recorded but no economy-tier model is configured",
      { artifactLanguage: target },
    );
  }
  if (provider === undefined) {
    throw new KnowledgeLanguageError(
      "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE",
      "the write path carried no answers from the recorded economy-tier model",
      { artifactLanguage: target, economyModel: policy.economyModel },
    );
  }
  if (provider.model !== policy.economyModel) {
    throw new KnowledgeLanguageError(
      "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE",
      "the answers name a model this workspace does not record as its economy tier",
      { economyModel: policy.economyModel, provided: provider.model },
    );
  }
  const translated: Record<KnowledgeLanguageField, string> = {
    snippet: fields.snippet,
    subject: fields.subject,
    summary: fields.summary,
  };
  for (const field of KNOWLEDGE_LANGUAGE_TRANSLATED_FIELDS) {
    if (detectLanguage(fields[field]) === target) continue;
    const answer = provider.translate(fields[field], target, field);
    if (typeof answer !== "string" || answer.length === 0 || detectLanguage(answer) !== target) {
      throw new KnowledgeLanguageError("KNOWLEDGE_LANGUAGE_INVALID", `${field} was not translated into ${target}`, { field, target });
    }
    translated[field] = answer;
  }
  const expansions: Record<string, readonly string[]> = {};
  for (const language of policy.promptLanguages) {
    const phrasings = provider.expand(translated.subject, translated.summary, language);
    expansions[language] = Object.freeze([...(phrasings ?? [])].sort(compareCanonicalText));
  }
  const frozen = Object.freeze(expansions);
  if (policy.promptLanguages.length > 0 && Object.keys(frozen).length === 0) {
    throw new KnowledgeLanguageError("KNOWLEDGE_LANGUAGE_INVALID", "no phrasings were produced", { promptLanguages: [...policy.promptLanguages] });
  }
  if (!expansionsAreBounded(frozen)) {
    throw new KnowledgeLanguageError("KNOWLEDGE_LANGUAGE_INVALID", "phrasings are outside the recorded bounds", {
      maximumBytes: KNOWLEDGE_EXPANSION_LIMITS.maximumBytes,
      minimumPhrasings: KNOWLEDGE_EXPANSION_LIMITS.minimumPhrasings,
      maximumPhrasings: KNOWLEDGE_EXPANSION_LIMITS.maximumPhrasings,
    });
  }
  return { subject: translated.subject, summary: translated.summary, snippet: translated.snippet, expansions: frozen };
}

export interface KnowledgeQueryTranslation {
  readonly from: ArtifactLanguageTag;
  readonly to: ArtifactLanguageTag;
  readonly model: string | null;
}

export interface KnowledgeQueryLanguageAnswer {
  readonly queryLanguage: ArtifactLanguageTag;
  /** Present exactly when the prompt language is outside the recorded prompt languages. */
  readonly queryTranslation: KnowledgeQueryTranslation | null;
  readonly telemetry: Readonly<{ readonly queryTranslations: number }>;
}

/**
 * The read-side fallback (requirement 4). The engine decides *that* a translation is owed
 * and *which* model owes it; the hook that holds the model performs it and asks again with
 * the translated prompt. The count is the telemetry the Story asks for -- one per recall
 * whose prompt fell outside the recorded prompt languages.
 *
 * Read-side is fail-open on purpose, and the asymmetry with the write path is deliberate:
 * refusing a write leaves a card unwritten and says so, while refusing a read leaves a
 * session with no answer at all, which is worse than an answer ranked in the wrong
 * language.
 */
export function resolveQueryLanguage(query: string, policy: KnowledgeLanguagePolicy): KnowledgeQueryLanguageAnswer {
  const queryLanguage = detectLanguage(query);
  const target = policy.artifactLanguage;
  const outside = target !== null && policy.promptLanguages.length > 0 && !policy.promptLanguages.includes(queryLanguage);
  return Object.freeze({
    queryLanguage,
    queryTranslation: outside && target !== null
      ? Object.freeze({ from: queryLanguage, to: target, model: policy.economyModel })
      : null,
    telemetry: Object.freeze({ queryTranslations: outside ? 1 : 0 }),
  });
}

/**
 * The bundle a write path carries instead of a model call.
 *
 * TCRN-CROSS-STORY-364 requirement 3 names four write entry points, and none of them may
 * reach a network: packages/* declare no runtime dependency and verify:p1's offline leg
 * measures that. So the economy-tier model's answers arrive as data -- a bundle the Agent
 * produced by asking the economy-tier model configured for the current host -- and this factory turns
 * that data into the provider `applyWriteLanguagePolicy` asks for. The engine still calls
 * no model; it only checks that the answers it was handed are the ones it needs.
 *
 * `expansions` is keyed by card so one bundle can serve a batch: the key is the card's
 * external key, and `NEW` is the fallback for a single write whose key the Agent did not
 * know when it asked the model.
 */
export interface KnowledgeLanguageBundle {
  readonly model: string;
  readonly translations: Readonly<Record<string, string>>;
  readonly expansions: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

export const KNOWLEDGE_LANGUAGE_BUNDLE_FALLBACK_KEY = "NEW";

function bundleRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

/**
 * Admit a parsed JSON document as a bundle, or refuse it with the same reason code the
 * write path refuses on. A malformed bundle and an absent one mean the same thing to a
 * fail-closed write: no answers from the recorded model.
 */
export function parseLanguageBundle(value: unknown): KnowledgeLanguageBundle {
  const document = bundleRecord(value);
  if (typeof document.model !== "string" || document.model.length === 0) {
    throw new KnowledgeLanguageError(
      "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE",
      "a language bundle is an object naming the model that produced it",
      {},
    );
  }
  const translations: Record<string, string> = {};
  for (const [source, answer] of Object.entries(bundleRecord(document.translations))) {
    if (typeof answer === "string") translations[source] = answer;
  }
  const expansions: Record<string, Readonly<Record<string, readonly string[]>>> = {};
  for (const [cardKey, byLanguage] of Object.entries(bundleRecord(document.expansions))) {
    const phrasings: Record<string, readonly string[]> = {};
    for (const [language, list] of Object.entries(bundleRecord(byLanguage))) {
      if (Array.isArray(list)) phrasings[language] = Object.freeze(list.map((entry) => String(entry)));
    }
    expansions[cardKey] = Object.freeze(phrasings);
  }
  return Object.freeze({ model: document.model, translations: Object.freeze(translations), expansions: Object.freeze(expansions) });
}

export function languageProviderFromBundle(
  bundle: KnowledgeLanguageBundle,
  cardKey: string = KNOWLEDGE_LANGUAGE_BUNDLE_FALLBACK_KEY,
): KnowledgeLanguageProvider {
  return Object.freeze({
    model: bundle.model,
    translate(text: string, target: ArtifactLanguageTag, field: KnowledgeLanguageField): string {
      const answer = bundle.translations[text];
      if (typeof answer !== "string" || answer.length === 0) {
        throw new KnowledgeLanguageError(
          "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE",
          `the bundle carries no ${field} translation into ${target}`,
          { field, target, cardKey },
        );
      }
      return answer;
    },
    expand(_subject: string, _summary: string, language: ArtifactLanguageTag): readonly string[] {
      const forCard = bundle.expansions[cardKey] ?? bundle.expansions[KNOWLEDGE_LANGUAGE_BUNDLE_FALLBACK_KEY];
      const phrasings = forCard === undefined ? undefined : forCard[language];
      if (phrasings === undefined) {
        throw new KnowledgeLanguageError(
          "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE",
          `the bundle carries no ${language} phrasings for ${cardKey}`,
          { language, cardKey },
        );
      }
      return phrasings;
    },
  });
}
