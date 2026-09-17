#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-364 — the write-path language hook, and the one-time migration that
// gives the cards already in a store their artefact language and their phrasings.
//
// WHY A SCRIPT AND NOT A VERB. The engine calls no model: packages/* declare no runtime
// dependency, scripts/lib/local-command.mjs admits only node and git, and verify:p1's
// offline leg measures both. So the model's answers arrive here as data — a bundle the
// Agent produced by asking the economy-tier model configured for the current host — and this file turns
// them into the provider the core write path requires. It decides what to say; the engine
// decides how to store it, exactly as scripts/knowledge-capture-hook.mjs already does.
//
// FOUR WRITE PATHS, ONE ENFORCEMENT POINT. knowledge-capture, knowledge-create,
// conference-close --distill and knowledge-batch's create members all reach
// packages/core/src/knowledge-core.ts's buildMetadata, which is where the policy is
// applied. Every one of the four takes --language-bundle on the CLI and turns it into the
// same provider this file builds, so the hook and the operator hand the write path the
// same shape. knowledge-promote is not a card's write path and is deliberately untouched
// (Owner ruling TCRN-CROSS-MIN-160 D3).
//
// SUBCOMMANDS
//   plan     --workspace <path> [--out <file>]
//            Reads the store and prints the request: every card whose prose is not in the
//            artefact language, plus every card with no phrasings. This is what the Agent
//            hands the economy-tier model.
//   migrate  --workspace <path> --bundle <file> [--dry-run] [--at <instant>]
//            Applies the model's answers. --dry-run reports what would be rewritten and
//            writes nothing.
//   capture  --workspace <path> --bundle <file> --subject … --summary … --snippet …
//            --tags a,b --owner <id> --body <text> [--at <instant>]
//            The write-path hook for one new card.
//
// BUNDLE SHAPE
//   { "model": "<the economy-tier model configured for the current host>",
//     "translations": { "<source text>": "<translated text>" },
//     "expansions": { "<knowledge id or NEW>": { "<language tag>": ["…", "…", "…"] } } }
// A translation the bundle does not carry is a refusal, not a passthrough: the write path
// is fail-closed and this file never invents prose.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(SCRIPT_DIRECTORY, "../dist/build/packages/core/src/index.js");
const NEW_CARD_KEY = "NEW";

function fail(reasonCode, message) {
  process.stdout.write(JSON.stringify({ ok: false, reasonCode, message }) + "\n");
  process.exitCode = 1;
  return undefined;
}

export function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values[name] = "true";
      continue;
    }
    values[name] = next;
    index += 1;
  }
  return values;
}

/**
 * The provider the core write path asks for, backed by a bundle rather than by a network
 * call. `model` is checked by the core against the recorded economy tier, so a bundle
 * produced by a different model is refused there rather than trusted here.
 */
export function bundleProvider(core, bundle, cardKey = NEW_CARD_KEY) {
  return core.languageProviderFromBundle(core.parseLanguageBundle(bundle), cardKey);
}

function readBundle(path) {
  const bundle = JSON.parse(readFileSync(path, "utf8"));
  if (typeof bundle !== "object" || bundle === null || typeof bundle.model !== "string") {
    throw new Error("bundle must be an object naming the model that produced it");
  }
  return bundle;
}

async function loadCore() {
  return import(CORE);
}

export async function planCommand(core, values) {
  const { listKnowledgeMetadata, materializeWorkspace, readKnowledgeLanguagePolicy, detectLanguage } = core;
  const workspace = values.workspace ?? "";
  const state = await materializeWorkspace(workspace);
  // plan has no host input in its command contract, so the optional host remains
  // undefined rather than being guessed here.
  const policy = readKnowledgeLanguagePolicy(state.settings);
  if (policy.artifactLanguage === null) return fail("KNOWLEDGE_LANGUAGE_UNCONFIGURED", "artifact.language is not recorded in this workspace");
  const answer = await listKnowledgeMetadata(workspace, { at: values.at ?? new Date().toISOString().replace(/\.\d+Z$/u, "Z"), selection: "all", limit: 1_048_576, allowTrailing: true });
  const cards = (answer.records ?? []).filter((record) => record.lifecycle !== "retired" && !record.extensions?.supersededBy);
  const request = cards.map((record) => {
    const fields = ["subject", "summary", "snippet"]
      .filter((field) => detectLanguage(String(record[field] ?? "")) !== policy.artifactLanguage)
      .map((field) => ({ field, text: String(record[field] ?? "") }));
    const phrasings = Object.keys(record.expansions ?? {});
    const missing = policy.promptLanguages.filter((language) => !phrasings.includes(language));
    return { id: record.id, externalKey: record.externalKey, translate: fields, expand: missing };
  }).filter((entry) => entry.translate.length > 0 || entry.expand.length > 0);
  const payload = {
    ok: true,
    reasonCode: "KNOWLEDGE_LANGUAGE_PLAN_READY",
    artifactLanguage: policy.artifactLanguage,
    promptLanguages: [...policy.promptLanguages],
    economyModel: policy.economyModel,
    cards: cards.length,
    pending: request.length,
    request,
  };
  const text = JSON.stringify(payload, null, 2) + "\n";
  if (values.out === undefined) process.stdout.write(text);
  else writeFileSync(values.out, text);
  return undefined;
}

export async function migrateCommand(core, values) {
  const { listKnowledgeMetadata, materializeWorkspace, readKnowledgeLanguagePolicy, applyWriteLanguagePolicy, readKnowledgeBody, createKnowledgeUnit, validateKnowledgeStore } = core;
  const workspace = values.workspace ?? "";
  const dryRun = values["dry-run"] === "true";
  const at = values.at ?? new Date().toISOString().replace(/\.\d+Z$/u, "Z");
  const bundle = readBundle(values.bundle ?? "");
  const state = await materializeWorkspace(workspace);
  // migrate has no host input in its command contract, so the optional host remains
  // undefined rather than being guessed here.
  const policy = readKnowledgeLanguagePolicy(state.settings);
  if (policy.artifactLanguage === null) return fail("KNOWLEDGE_LANGUAGE_UNCONFIGURED", "artifact.language is not recorded in this workspace");
  const answer = await listKnowledgeMetadata(workspace, { at, selection: "all", limit: 1_048_576, allowTrailing: true });
  const rewrites = [];
  for (const record of answer.records ?? []) {
    if (record.lifecycle === "retired" || record.extensions?.supersededBy) continue;
    const provider = bundleProvider(core, bundle, record.id);
    let applied;
    try {
      applied = applyWriteLanguagePolicy(
        { subject: String(record.subject ?? ""), summary: String(record.summary ?? ""), snippet: String(record.snippet ?? "") },
        policy,
        provider,
      );
    } catch (error) {
      rewrites.push({ id: record.id, externalKey: record.externalKey, applied: false, reason: String(error.message ?? error) });
      continue;
    }
    const changed = applied.subject !== record.subject || applied.summary !== record.summary ||
      applied.snippet !== record.snippet || Object.keys(record.expansions ?? {}).length === 0;
    rewrites.push({ id: record.id, externalKey: record.externalKey, applied: changed, subject: applied.subject, expansions: applied.expansions });
    if (dryRun || !changed) continue;
    const body = String((await readKnowledgeBody(workspace, record.id, { at, allowUnpromoted: true })).body ?? "");
    await createKnowledgeUnit(workspace, {
      expectedVersion: Number((await validateKnowledgeStore(workspace)).version),
      occurredAt: at,
      externalKey: `${record.externalKey}-L`,
      scope: record.scope, projectId: record.projectId, roleScopes: record.roleScopes,
      category: record.category, kind: record.kind, tags: record.tags,
      subject: record.subject, summary: record.summary, snippet: record.snippet,
      accountableOwnerId: record.accountableOwnerId,
      sourceReferences: record.sourceReferences, sourceDigest: record.sourceDigest,
      supersedes: record.id,
      linkedWorkIds: record.linkedWorkIds, linkedDecisionIds: record.linkedDecisionIds,
      linkedGateIds: record.linkedGateIds, linkedEvidenceIds: record.linkedEvidenceIds,
      lifecycle: record.lifecycle, retrievalDisposition: record.retrievalDisposition,
      freshnessState: record.freshnessState, lastVerified: record.lastVerified,
      stalenessPolicy: record.stalenessPolicy, exportDisposition: record.exportDisposition,
      body,
    }, { languageProvider: provider, allowTrailing: true });
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    reasonCode: dryRun ? "KNOWLEDGE_LANGUAGE_MIGRATION_PLANNED" : "KNOWLEDGE_LANGUAGE_MIGRATED",
    dryRun,
    cards: rewrites.length,
    rewritten: rewrites.filter((entry) => entry.applied).length,
    refused: rewrites.filter((entry) => entry.reason !== undefined).length,
    rewrites,
  }, null, 2) + "\n");
  return undefined;
}

async function captureCommand(core, values) {
  const { captureKnowledgeUnit } = core;
  const bundle = readBundle(values.bundle ?? "");
  const answer = await captureKnowledgeUnit(values.workspace ?? "", {
    occurredAt: values.at ?? new Date().toISOString().replace(/\.\d+Z$/u, "Z"),
    subject: values.subject ?? "",
    summary: values.summary ?? "",
    snippet: values.snippet ?? "",
    tags: (values.tags ?? "").split(",").filter((tag) => tag.length > 0),
    accountableOwnerId: values.owner ?? "",
    body: values.body ?? "",
  }, { languageProvider: bundleProvider(core, bundle), allowTrailing: true });
  process.stdout.write(JSON.stringify(answer) + "\n");
  return undefined;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  const values = parseArguments(rest);
  const core = await loadCore();
  if (command === "plan") return planCommand(core, values);
  if (command === "migrate") return migrateCommand(core, values);
  if (command === "capture") return captureCommand(core, values);
  return fail("KNOWLEDGE_LANGUAGE_COMMAND_UNKNOWN", "expected one of: plan, migrate, capture");
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("knowledge-language.mjs")) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    fail(String(error?.reasonCode ?? "KNOWLEDGE_LANGUAGE_FAILED"), String(error?.message ?? error));
  }
}
