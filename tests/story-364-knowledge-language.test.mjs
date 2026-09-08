// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-364 — the artefact language of a card, and the phrasings it is found by.
//
// The defect is not "retrieval was weak in Chinese". It is that the corpus was written in
// two languages at once: 15 of 36 cards were English prose in a workspace whose questions
// arrive in Chinese, and those same 15 were the misses. One language on the write path is
// half the answer; the other half is that a card is indexed under the questions it answers,
// not only under the words it happens to contain.
//
// Two behaviours are pinned as a pair, because a change that satisfies one by breaking the
// other is not a fix. The write path is FAIL-CLOSED: a workspace that has declared its
// artefact language refuses a card it cannot write in that language, with a reason code.
// The read path is FAIL-OPEN: a question in an unexpected language is still answered, and
// the answer says a translation is owed and which model owes it. Reversing either one is
// the failure this file exists to catch.
//
// The 36-question numbers the Story is judged on are measured against the shared
// evaluation corpus, a read-only export of a live chain that does not live in this
// repository, exactly as TCRN-CROSS-STORY-362's file records. They are not asserted here.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  applyWriteLanguagePolicy,
  createProject,
  createWork,
  captureKnowledgeUnit,
  detectLanguage,
  expansionsText,
  initializeKnowledgeStore,
  initializeWorkspace,
  listKnowledgeMetadata,
  readKnowledgeLanguagePolicy,
  resolveQueryLanguage,
  setWorkspaceSetting,
  validateSettingValue,
} from "../dist/build/packages/core/src/index.js";
// The roster, the expansion limits and the prompt-language parser are read here directly
// from ./knowledge-language.js, the way this file already reads ./recall.js below: they
// are core-internal, nothing outside packages/core calls them, and TCRN-CROSS-STORY-364
// retired their barrel re-exports rather than record nine more isolated public symbols.
import {
  ARTIFACT_LANGUAGE_TAGS,
  KNOWLEDGE_EXPANSION_LIMITS,
  parsePromptLanguages,
} from "../dist/build/packages/core/src/knowledge-language.js";
import { resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { bundleTranslator, runInjection } from "../scripts/knowledge-inject.mjs";
import { planCommand, migrateCommand } from "../scripts/knowledge-language.mjs";

const instant = (second) => `2026-09-08T00:00:${String(second).padStart(2, "0")}Z`;
const OWNER = deriveStableId("owner", "STORY-364-OWNER");
const ECONOMY_MODEL = "claude-sonnet-5";

// The stand-in for the economy-tier model. The engine never calls a model, so what a test
// supplies and what the write-path hook supplies are the same kind of thing: answers.
function provider(overrides = {}) {
  return {
    model: overrides.model ?? ECONOMY_MODEL,
    translate: overrides.translate ?? ((text, target, field) => ({
      subject: "凭据不是实现的前置",
      summary: "密钥还没批下来并不阻塞要用它的工作",
      snippet: "对着接口做，不对着密钥做",
    })[field]),
    expand: overrides.expand ?? (() => ["密钥没批下来能不能先做", "开发要不要等凭据", "凭据是不是实现的前置"]),
  };
}

async function languageWorkspace(context, settings) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-story-364-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const partitionPath = join(base, ".tcrn-workspace", "cross-project");
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(partitionPath, kind);
    await mkdir(path, { recursive: true });
    roots.push({ kind, path });
  }
  await initializeWorkspace({ roots, externalKey: "STORY-364-LANGUAGE", createdAt: instant(0) });
  const workspace = join(partitionPath, "workspace");
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  try {
    let state = await createProject(workspace, lease, {
      expectedVersion: 0, occurredAt: instant(1), externalKey: "STORY-364-PROJECT", name: "Language",
    });
    state = await createWork(workspace, lease, {
      expectedVersion: state.version, occurredAt: instant(2), projectId: state.projects[0].id,
      externalKey: "TCRN-CROSS-STORY-364", kind: "Initiative", parentId: null,
      title: "生成物语言与写入时问法扩展",
    });
    let version = Number(state.version);
    let second = 3;
    for (const [key, value] of Object.entries(settings)) {
      const state = await setWorkspaceSetting(workspace, lease, {
        expectedVersion: version, occurredAt: instant(second), key, value,
      });
      version = Number(state.version);
      second += 1;
    }
  } finally {
    await lease.release();
  }
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return workspace;
}

const DISTRACTORS = [
  ["STORY-364-D1", "链头变化后知识索引必须重建", "每次链写都拉开 store 标记差距", "写路径自动 rebase"],
  ["STORY-364-D2", "钩子注册必须用项目目录变量形态", "相对路径在宿主设置里不生效", "用绝对路径或变量"],
  ["STORY-364-D3", "覆盖注册表看不见死掉的被测物", "删测试丢覆盖要按分支查", "按文件查会漏"],
];

async function seedDistractors(workspace, languageProvider, startAt) {
  let second = startAt;
  for (const [externalKey, subject, summary, snippet] of DISTRACTORS) {
    await captureKnowledgeUnit(workspace, {
      occurredAt: instant(second), subject, summary, snippet, tags: ["lesson"],
      accountableOwnerId: OWNER, body: `${subject}。${summary}。`, externalKey, coexist: true,
    }, { languageProvider });
    second += 1;
  }
}

const englishCard = {
  occurredAt: instant(9),
  subject: "Credentials are not a prerequisite for implementation",
  summary: "A key that has not been issued does not block the work that will use it",
  snippet: "build against the interface, not the secret",
  tags: ["lesson"],
  accountableOwnerId: OWNER,
  body: "The API key had not been granted and every task behind it was called blocked.",
  externalKey: "STORY-364-ENGLISH",
};

test("STORY-364: character ratio, not a language identifier, decides which language prose is in", () => {
  assert.equal(detectLanguage("Credentials are not a prerequisite"), "en");
  assert.equal(detectLanguage("凭据不是实现的前置"), "zh-CN");
  assert.equal(detectLanguage("凭据不是实现的前置，见 STORY-364 的 scope"), "zh-CN",
    "Chinese prose quoting an English identifier is still Chinese");
  assert.equal(detectLanguage("the retrieval.tau 值 floor"), "en",
    "English prose quoting one Chinese term is still English");
  assert.equal(detectLanguage("2026-09-08"), "en", "text with no letters at all falls to the default");
  assert.equal(detectLanguage("context-limit-is-not-a-reason-to-stop:停只因实质阻塞。"), "zh-CN");
  assert.equal(detectLanguage("marker-rebase-discipline:每写必 rebase。"), "zh-CN");
  assert.equal(detectLanguage("corepack pnpm run test；裸 pnpm 撞 RUNTIME_PNPM_VERSION。"), "zh-CN");
  assert.deepEqual([...ARTIFACT_LANGUAGE_TAGS], ["en", "zh-CN"]);
});

test("STORY-364: a single quoted ideograph is below the zh-CN threshold, so the sentence stays English", () => {
  const cases = [
    ["The 引 handles this case", "one ideograph is below MINIMUM_CJK_IDEOGRAPHS"],
    ["Use the 存 after the request completes", "one ideograph is below MINIMUM_CJK_IDEOGRAPHS"],
    ["The API returns a 据 when authentication succeeds", "one ideograph is below MINIMUM_CJK_IDEOGRAPHS"],
    ["The API returns a 凭 when authentication succeeds", "one ideograph is below MINIMUM_CJK_IDEOGRAPHS"],
  ];
  for (const [text, message] of cases) assert.equal(detectLanguage(text), "en", message);
});

test("STORY-364 MIN-177 D1: English prose quoting Chinese terms is judged zh-CN, a known limitation and not a requirement", () => {
  // These four assert accepted current behaviour under TCRN-CROSS-MIN-177 D1, not a
  // requirement this test guards. No character-level rule separates an English sentence
  // quoting a Chinese term from a genuinely Chinese sentence that happens to carry more
  // Latin letters; the comment above MINIMUM_CJK_IDEOGRAPHS in knowledge-language.ts
  // records the corpus that proved it. If a future change makes detectLanguage return "en"
  // for these, that is an improvement, not a regression: update this test to match, rather
  // than let it block the change.
  const cases = [
    ["The 引擎 handles this case", "MIN-177 D1 known limitation"],
    ["Run the migration before the 迁移 window closes and record the receipt", "MIN-177 D1 known limitation"],
    ["This card is a 卡片 in the knowledge store", "MIN-177 D1 known limitation"],
    ["See the 纪要 for the ruling that settled it", "MIN-177 D1 known limitation"],
  ];
  for (const [text, message] of cases) assert.equal(detectLanguage(text), "zh-CN", message);
});

test("STORY-364 TCRN-CROSS-MIN-177 D1: the live-store acceptance corpus, both directions in one run", () => {
  // Embeds the EPIC-127 r5 live-store acceptance corpus (the translate texts of
  // .tcrn-artifacts/dispatch-runs/init-051/EPIC-127/r5/request.json) so the 20 zh-CN / 57 en
  // split this Story is judged on is asserted inside this repository, not only in a script
  // under a session scratchpad that no gate here reads. Partitioned by whether each text
  // carries a character in the ranges the IDEOGRAPH regex above uses. Citing
  // TCRN-CROSS-MIN-177 D1: the known limitation that ruling accepts (an English sentence
  // quoting a Chinese term is judged zh-CN) is covered separately, above.
  const zhCnFields = [
    "引擎 knowledge-create/promote/retire/rebase/reverify 全部以 store.json 的 version 做 CAS;仪式按链版本供给会 KNOWLEDGE_CAS_MISMATCH。",
    "knowledge-marker-cas:knowledge 写动词 CAS 用 marker。",
    "git worktree add 建出的树跑不了本仓任何门：worktree 的 .git 是文件而非目录，packages/core/src/safe-io.mjs 的 withExclusiveOutputSession 断言 isDirectory，每道门以 OUTPUT_SESSION_REPOSITORY_INVALID 失败。用 rm -rf <dir> && git clone --local --no-hardlinks <仓> <dir> && git -C <dir> checkout --detach HEAD；离线装依赖 corepack pnpm install --frozen-lockfile --offline；用完 rm -rf。",
    "隔离树：git clone --local + checkout --detach；worktree 过不了 safe-io。",
    "Owner 判定的 Story 转 done 前须 work-annotate --decided-by <纪要>，否则 WORKSPACE_OWNER_ACCEPTANCE_REQUIRED。",
    "recheck-via-mcp:复核走 MCP 读面,SSH 仅 break-glass。",
    "context-limit-is-not-a-reason-to-stop:停只因实质阻塞。",
    "裸 pnpm 是 11.7.0，scripts/task.mjs:220 钉 pnpm/11.3.0，裸跑报 RUNTIME_PNPM_VERSION。一律 corepack pnpm run <script>。",
    "corepack pnpm run test；裸 pnpm 撞 RUNTIME_PNPM_VERSION。",
    "git worktree add 建出的树跑不了本仓任何门：worktree 的 .git 是文件而非目录，packages/core/src/safe-io.mjs 的 withExclusiveOutputSession 断言 isDirectory，每道门以 OUTPUT_SESSION_REPOSITORY_INVALID 失败。用 rm -rf <dir> && git clone --local --no-hardlinks <仓> <dir> && git -C <dir> checkout --detach HEAD；离线装依赖 corepack pnpm install --frozen-lockfile --offline；用完 rm -rf。",
    "隔离树：git clone --local + checkout --detach；worktree 过不了 safe-io。",
    "引擎仓增删被跟踪文件后不改 scripts/policy/source-allowlist.json，pnpm test 整体红于 PROOF_ARTIFACT_UNAPPROVED_SOURCE。同一提交改白名单，再 node scripts/generate-proof-artifacts.mjs。",
    "增删文件 → 改 source-allowlist.json → generate-proof-artifacts.mjs，否则 PROOF_ARTIFACT_UNAPPROVED_SOURCE。",
    "marker-rebase-discipline:每写必 rebase。",
    "evidence-hygiene:证据 scrub 宿主路径,门扫 tracked+evidence。",
    "裸 pnpm 是 11.7.0，scripts/task.mjs:220 钉 pnpm/11.3.0，裸跑报 RUNTIME_PNPM_VERSION。一律 corepack pnpm run <script>。",
    "corepack pnpm run test；裸 pnpm 撞 RUNTIME_PNPM_VERSION。",
    "stop-budget-three-classes:只三类必停。",
    "引擎仓增删被跟踪文件后不改 scripts/policy/source-allowlist.json，pnpm test 整体红于 PROOF_ARTIFACT_UNAPPROVED_SOURCE。同一提交改白名单，再 node scripts/generate-proof-artifacts.mjs。",
    "增删文件 → 改 source-allowlist.json → generate-proof-artifacts.mjs，否则 PROOF_ARTIFACT_UNAPPROVED_SOURCE。",
  ];
  const enFields = [
    "guard-check writes its injected mutations into the live working tree while it runs",
    "Any concurrent gate run or file edit during guard-check reads a deliberately broken tree, and edits made during the run invalidate its verdict.",
    "Running verify-portal alongside guard-check produced six false red portal cases on 2026-08-19. Treat it as exclusive, wait on the pid, and confirm the mutation is restored before continuing.",
    "Harness constraints convention index",
    "Explicit-only index card for platform-docs/harness-constraint-convention.md; retrieve the source document when this topic is needed.",
    "Read platform-docs/harness-constraint-convention.md on demand.",
    "The short commit-citation form is ambiguous for two record keys in five",
    "Partitions number independently, so INIT-009 names a different record in each. The convention requires the full external key; the short form is four times more common and cannot identify a chain.",
    "Measured 2026-08-19 over 609 completed cross-project records: 11.2 percent cite the full key, 43.5 percent the short form, 56.5 percent nothing. 242 of 609 short forms collide across partitions.",
    "guard-check writes its injected mutations into the live working tree while it runs",
    "Any concurrent gate run or file edit during guard-check reads a deliberately broken tree, and edits made during the run invalidate its verdict.",
    "Running verify-portal alongside guard-check produced six false red portal cases on 2026-08-19. Treat it as exclusive, wait on the pid, and confirm the mutation is restored before continuing.",
    "Four wrong readings in two days all came from asking a narrower question than the one being answered",
    "Each measurement used an instrument that could only return the answer already expected. The tell is that the probe's scope is narrower than the claim it is used to support.",
    "Empty knowledge store read off a search with no matching card; a dropped scope field read off the wrong receipt path; 11.2 percent traceability measured on one of two citation spellings; a load-sensitive test declared a flake from two isolated runs.",
    "Projection freshness convention index",
    "Explicit-only index card for platform-docs/projection-freshness-convention.md; retrieve the source document when this topic is needed.",
    "Read platform-docs/projection-freshness-convention.md on demand.",
    "A knowledge read refuses after any chain write unless it is asked to tolerate a trailing store",
    "The store's marker must equal the chain head, and every chain event breaks that. Pass --allow-trailing true on the five metadata-first read verbs; the answer then carries both heads.",
    "One work-create took all six partitions' knowledge reads dark until a hand-run rebase. Reads accept --allow-trailing true since TCRN-CROSS-INC-226; writes, validate and rebase are not exempt.",
    "Deliberation adoption convention index",
    "Explicit-only index card for platform-docs/deliberation-adoption-convention.md; retrieve the source document when this topic is needed.",
    "Read platform-docs/deliberation-adoption-convention.md on demand.",
    "A knowledge read refuses after any chain write unless asked to tolerate a trailing store",
    "The store's marker must equal the chain head, and every chain event breaks that. Pass allow-trailing true on the five metadata-first read verbs; the answer then carries both heads.",
    "One work-create took all six partitions' knowledge reads dark until a hand-run rebase. Reads accept --allow-trailing true since TCRN-CROSS-INC-226; writes, validate and rebase are not exempt.",
    "Delivery cadence convention index",
    "Explicit-only index card for platform-docs/delivery-cadence-convention.md; retrieve the source document when this topic is needed.",
    "Read platform-docs/delivery-cadence-convention.md on demand.",
    "Gate reference stability convention index",
    "Explicit-only index card for platform-docs/gate-reference-stability-convention.md; retrieve the source document when this topic is needed.",
    "Read platform-docs/gate-reference-stability-convention.md on demand.",
    "Adversarial review convention index",
    "Explicit-only index card for platform-docs/adversarial-review-convention.md; retrieve the source document when this topic is needed.",
    "Read platform-docs/adversarial-review-convention.md on demand.",
    "On the knowledge verbs, expected-version is the store's own version rather than the chain's",
    "Every other verb reads that flag as the chain version. The knowledge verbs read it as the knowledge store's version, and nothing in the catalog distinguishes the two meanings.",
    "Passing chain version 4295 returned KNOWLEDGE_CAS_MISMATCH 4295:160 -- supplied first, expected second. Read the refusal rather than guessing a second time.",
    "On the knowledge verbs, expected-version is the store's own version rather than the chain's",
    "Every other verb reads that flag as the chain version. The knowledge verbs read it as the knowledge store's version, and nothing in the catalog distinguishes the two meanings.",
    "Passing chain version 4295 returned KNOWLEDGE_CAS_MISMATCH 4295:160 -- supplied first, expected second. Read the refusal rather than guessing a second time.",
    "Sourcing and vetting convention index",
    "Explicit-only index card for platform-docs/sourcing-and-vetting-convention.md; retrieve the source document when this topic is needed.",
    "Read platform-docs/sourcing-and-vetting-convention.md on demand.",
    "Direction and tracks convention index",
    "Explicit-only index card for platform-docs/direction-and-tracks-convention.md; retrieve the source document when this topic is needed.",
    "Read platform-docs/direction-and-tracks-convention.md on demand.",
    "Dependency direction and integration convention index",
    "Explicit-only index card for platform-docs/dependency-direction-and-integration-convention.md; retrieve the source document when this topic is needed.",
    "Read platform-docs/dependency-direction-and-integration-convention.md on demand.",
    "The short commit-citation form is ambiguous for two record keys in five",
    "Partitions number independently, so INIT-009 names a different record in each. The convention requires the full external key; the short form is four times more common and cannot identify a chain.",
    "Measured 2026-08-19 over 609 completed cross-project records: 11.2 percent cite the full key, 43.5 percent the short form, 56.5 percent nothing. 242 of 609 short forms collide across partitions.",
    "Dispatch readiness convention index",
    "Explicit-only index card for platform-docs/dispatch-readiness-convention.md; retrieve the source document when this topic is needed.",
    "Read platform-docs/dispatch-readiness-convention.md on demand.",
  ];
  assert.equal(zhCnFields.length, 20, "the ideograph-bearing group must hold exactly 20 fields");
  assert.equal(enFields.length, 57, "the ideograph-free group must hold exactly 57 fields");
  for (const text of zhCnFields) {
    assert.equal(detectLanguage(text), "zh-CN", text.slice(0, 40));
  }
  for (const text of enFields) {
    assert.equal(detectLanguage(text), "en", text.slice(0, 40));
  }
});

test("STORY-364: an unconfigured workspace stores exactly the prose it was handed", async (context) => {
  const workspace = await languageWorkspace(context, {});
  const written = await captureKnowledgeUnit(workspace, englishCard);
  assert.equal(written.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  const records = (await listKnowledgeMetadata(workspace, { at: instant(12), allowTrailing: true })).records;
  assert.equal(records[0].subject, englishCard.subject, "no artefact language recorded means no translation");
  assert.deepEqual(records[0].expansions ?? {}, {},
    "and no phrasings: a deployment that never turned the hook on is unchanged, not degraded");
});

test("STORY-364: a card captured in English is stored in the artefact language, with phrasings", async (context) => {
  const workspace = await languageWorkspace(context, {
    "artifact.language": "zh-CN",
    "model.economyTier": ECONOMY_MODEL,
  });
  const written = await captureKnowledgeUnit(workspace, englishCard, { languageProvider: provider() });
  assert.equal(written.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  const records = (await listKnowledgeMetadata(workspace, { at: instant(12), allowTrailing: true })).records;
  const stored = records[0];
  assert.equal(detectLanguage(stored.subject), "zh-CN", "GWT2: the stored subject is in the artefact language");
  assert.equal(detectLanguage(stored.summary), "zh-CN");
  assert.equal(detectLanguage(stored.snippet), "zh-CN");
  assert.equal(stored.subject, "凭据不是实现的前置", "and it is what the model answered, not a copy of the input");
  assert.deepEqual(Object.keys(stored.expansions), ["zh-CN"],
    "GWT2: phrasings are non-empty, and default to the artefact language alone");
  assert.equal(stored.expansions["zh-CN"].length, 3);
  assert.deepEqual(stored.expansions["zh-CN"], [...stored.expansions["zh-CN"]].sort(),
    "phrasings are stored canonically sorted, like every other array in this record");
});

test("STORY-364: a language-configured workspace refuses a write it cannot translate", async (context) => {
  const noModel = await languageWorkspace(context, { "artifact.language": "zh-CN" });
  await assert.rejects(
    () => captureKnowledgeUnit(noModel, englishCard),
    (error) => error.reasonCode === "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE",
    "no economy-tier model recorded is the first way to be unable",
  );
  const noAnswers = await languageWorkspace(context, {
    "artifact.language": "zh-CN",
    "model.economyTier": ECONOMY_MODEL,
  });
  await assert.rejects(
    () => captureKnowledgeUnit(noAnswers, englishCard),
    (error) => error.reasonCode === "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE",
    "a model named but no answers carried is the second; both refuse rather than degrade",
  );
  assert.equal((await listKnowledgeMetadata(noAnswers, { at: instant(12), allowTrailing: true })).records.length, 0,
    "and the refusal leaves no card behind");
});

test("STORY-364: the answers are checked against the model the workspace actually records", () => {
  const policy = readKnowledgeLanguagePolicy([
    { key: "artifact.language", value: "zh-CN" },
    { key: "model.economyTier", value: ECONOMY_MODEL },
  ]);
  assert.equal(policy.economyModel, ECONOMY_MODEL);
  assert.deepEqual([...policy.promptLanguages], ["zh-CN"], "prompt languages default to the artefact language");
  assert.throws(
    () => applyWriteLanguagePolicy({ subject: "a", summary: "b", snippet: "c" }, policy, provider({ model: "some-other-model" })),
    (error) => error.reasonCode === "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE",
  );
  assert.throws(
    () => applyWriteLanguagePolicy({ subject: "a", summary: "b", snippet: "c" }, policy, provider({ translate: (text) => text })),
    (error) => error.reasonCode === "KNOWLEDGE_LANGUAGE_INVALID",
    "prose the model handed back untranslated is refused rather than stored",
  );
});

test("STORY-364: phrasings outside the normative bounds are refused", () => {
  const policy = readKnowledgeLanguagePolicy([
    { key: "artifact.language", value: "zh-CN" },
    { key: "model.economyTier", value: ECONOMY_MODEL },
  ]);
  const fields = { subject: "凭据不是前置", summary: "密钥未批不阻塞实现", snippet: "对着接口做" };
  assert.equal(KNOWLEDGE_EXPANSION_LIMITS.maximumBytes, 1_024);
  for (const [label, phrasings] of [
    ["two phrasings is below the floor", ["甲一", "乙二"]],
    ["five phrasings is above the ceiling", ["一", "二", "三", "四", "五"]],
    ["one phrasing over the whole-map byte budget", ["密" .repeat(200), "钥".repeat(200), "证".repeat(200)]],
  ]) {
    assert.throws(
      () => applyWriteLanguagePolicy(fields, policy, provider({ expand: () => phrasings })),
      (error) => error.reasonCode === "KNOWLEDGE_LANGUAGE_INVALID",
      label,
    );
  }
  const exact = applyWriteLanguagePolicy(fields, policy, provider({ expand: () => ["甲", "乙", "丙", "丁"] }));
  assert.equal(exact.expansions["zh-CN"].length, KNOWLEDGE_EXPANSION_LIMITS.maximumPhrasings);
  assert.equal(expansionsText(exact.expansions), "丁\n丙\n乙\n甲", "the weight-6 column is the flattened map");
});

test("STORY-364: the settings catalog admits the language keys and refuses a tag it cannot judge", () => {
  assert.equal(validateSettingValue("artifact.language", "zh-CN"), "zh-CN");
  assert.throws(() => validateSettingValue("artifact.language", "de-DE"), (error) => error.reasonCode === "SETTINGS_VALUE_INVALID");
  assert.equal(validateSettingValue("retrieval.promptLanguages", "en,zh-CN"), "en,zh-CN");
  assert.throws(() => validateSettingValue("retrieval.promptLanguages", "en,de-DE"), (error) => error.reasonCode === "SETTINGS_VALUE_INVALID");
  assert.equal(validateSettingValue("model.economyTier", ECONOMY_MODEL), ECONOMY_MODEL);
  assert.deepEqual([...parsePromptLanguages("zh-CN,en")], ["en", "zh-CN"], "the list is read canonically sorted");
  assert.deepEqual([...parsePromptLanguages(null)], []);
});

test("STORY-364: a prompt outside the recorded prompt languages is counted once, and still answered", () => {
  const policy = readKnowledgeLanguagePolicy([
    { key: "artifact.language", value: "zh-CN" },
    { key: "retrieval.promptLanguages", value: "zh-CN" },
    { key: "model.economyTier", value: ECONOMY_MODEL },
  ]);
  const outside = resolveQueryLanguage("is the key still blocking development", policy);
  assert.equal(outside.queryLanguage, "en");
  assert.deepEqual(outside.telemetry, { queryTranslations: 1 });
  assert.deepEqual(outside.queryTranslation, { from: "en", to: "zh-CN", model: ECONOMY_MODEL });
  const inside = resolveQueryLanguage("密钥还没申请下来是不是整个开发都得先卡住", policy);
  assert.deepEqual(inside.telemetry, { queryTranslations: 0 });
  assert.equal(inside.queryTranslation, null);
  const unconfigured = resolveQueryLanguage("anything at all", readKnowledgeLanguagePolicy([]));
  assert.deepEqual(unconfigured.telemetry, { queryTranslations: 0 },
    "a workspace that declared no language owes no translation");
});

test("STORY-364: the recall verb reports the query language and its telemetry", async (context) => {
  const workspace = await languageWorkspace(context, {
    "artifact.language": "zh-CN",
    "model.economyTier": ECONOMY_MODEL,
    "retrieval.promptLanguages": "zh-CN",
  });
  await captureKnowledgeUnit(workspace, {
    ...englishCard,
    subject: "凭据不是实现的前置",
    summary: "密钥还没批下来并不阻塞要用它的工作",
    snippet: "对着接口做，不对着密钥做",
  }, { languageProvider: provider() });
  await seedDistractors(workspace, provider(), 10);
  resetRecallCache();
  let output = "";
  await runCli(["recall", "--workspace", workspace, "--at", instant(20),
    "--query", "is the key still blocking development", "--allow-trailing", "true"],
  { write(value) { output = value; } });
  const answer = JSON.parse(output);
  assert.equal(answer.reasonCode, "RECALL_READY");
  assert.equal(answer.queryLanguage, "en");
  assert.deepEqual(answer.telemetry, { queryTranslations: 1 },
    "GWT3: an English prompt against zh-CN prompt languages is one recorded query-side translation");
  assert.deepEqual(answer.queryTranslation, { from: "en", to: "zh-CN", model: ECONOMY_MODEL },
    "the verb names the model that owes the translation; it never calls one");
  resetRecallCache();
  let second = "";
  await runCli(["recall", "--workspace", workspace, "--at", instant(21),
    "--query", "密钥还没申请下来是不是整个开发都得先卡住", "--allow-trailing", "true"],
  { write(value) { second = value; } });
  const translated = JSON.parse(second);
  assert.deepEqual(translated.telemetry, { queryTranslations: 0 });
  assert.ok(translated.records.some((hit) => hit.title === "凭据不是实现的前置"),
    "and the prompt the hook would ask again with reaches the card");
  resetRecallCache();
});

test("STORY-364: phrasings feed the weight-6 recall column, so a question worded differently lands", async (context) => {
  const workspace = await languageWorkspace(context, {
    "artifact.language": "zh-CN",
    "model.economyTier": ECONOMY_MODEL,
  });
  await captureKnowledgeUnit(workspace, {
    ...englishCard,
    subject: "凭据不是实现的前置",
    summary: "密钥未批不阻塞要用它的工作",
    snippet: "对着接口做",
    body: "对着接口做，不对着密钥做。",
  }, {
    languageProvider: provider({
      expand: () => ["密钥没申请下来开发要不要停", "开发能不能先做", "等凭据是不是必须的"],
    }),
  });
  await seedDistractors(workspace, provider(), 10);
  resetRecallCache();
  let output = "";
  await runCli(["recall", "--workspace", workspace, "--at", instant(22),
    "--query", "密钥没申请下来开发要不要停", "--allow-trailing", "true"],
  { write(value) { output = value; } });
  const answer = JSON.parse(output);
  assert.ok(answer.records.some((hit) => hit.title === "凭据不是实现的前置"),
    "the question is worded nothing like the card's prose; the phrasing is what it matched");
  resetRecallCache();
});

// TCRN-CROSS-STORY-364 requirement 3 names four card write paths. The tests above prove
// the enforcement point and the knowledge-capture path. The four below prove the other
// three reach it too, and each one proves it the only way that means anything: the same
// invocation without --language-bundle must be refused. A wiring test that only shows the
// success case shows that the write path works, not that the flag is what makes it work.

const DIGEST = "b".repeat(64);
const PHRASINGS_ZH = ["密钥没批下来能不能先做", "开发要不要等凭据", "凭据是不是实现的前置"];
const TRANSLATIONS = {
  [englishCard.subject]: "凭据不是实现的前置",
  [englishCard.summary]: "密钥还没批下来并不阻塞要用它的工作",
  [englishCard.snippet]: "对着接口做，不对着密钥做",
};

const containerOf = (workspace) => join(workspace, "..", "..", "..");

async function writeBundle(path, bundle) {
  await writeFile(path, JSON.stringify(bundle), "utf8");
  return path;
}

function cliJson(argv) {
  let output = "";
  return runCli(argv, { write(value) { output = value; } }).then(() => JSON.parse(output));
}

test("STORY-364 R3: knowledge-create reaches the write-path hook, and is refused without answers", async (context) => {
  const workspace = await languageWorkspace(context, {
    "artifact.language": "zh-CN",
    "model.economyTier": ECONOMY_MODEL,
  });
  const bundle = await writeBundle(join(containerOf(workspace), "create-bundle.json"), {
    model: ECONOMY_MODEL,
    translations: TRANSLATIONS,
    expansions: { "STORY-364-CREATE": { "zh-CN": PHRASINGS_ZH } },
  });
  const argv = (...extra) => ["knowledge-create", "--workspace", workspace, "--expected-version", "0",
    "--at", instant(10), "--external-key", "STORY-364-CREATE", "--scope", "workspace", "--project-id", "-",
    "--role-scopes", "-", "--category", "workflow", "--kind", "fact", "--tags", "lesson",
    "--subject", englishCard.subject, "--summary", englishCard.summary, "--snippet", englishCard.snippet,
    "--accountable-owner-id", OWNER, "--source-references", "evidence://story-364/create",
    "--source-digest", DIGEST, "--evidence-ids", deriveStableId("evidence", "STORY-364-CREATE"),
    "--lifecycle", "active", "--retrieval", "default", "--freshness", "fresh",
    "--last-verified", instant(9), "--stale-days", "90", "--export", "metadata-only",
    "--body", englishCard.body, ...extra];

  await assert.rejects(() => cliJson(argv()),
    (error) => error.reasonCode === "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE",
    "the verb had no way to carry the answers before this change, and this is what that looked like");

  const created = await cliJson(argv("--language-bundle", bundle));
  assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  const stored = (await listKnowledgeMetadata(workspace, { at: instant(12), allowTrailing: true })).records[0];
  assert.equal(stored.subject, "凭据不是实现的前置");
  assert.deepEqual(stored.expansions["zh-CN"], [...PHRASINGS_ZH].sort());
});

test("STORY-364 R3: a batch's create members each get their own answers, keyed by external key", async (context) => {
  const workspace = await languageWorkspace(context, {
    "artifact.language": "zh-CN",
    "model.economyTier": ECONOMY_MODEL,
  });
  const container = containerOf(workspace);
  const member = (externalKey) => ({
    verb: "knowledge-create", externalKey,
    scope: "workspace", projectId: null, roleScopes: [],
    category: "workflow", kind: "fact", tags: ["lesson"],
    subject: englishCard.subject, summary: englishCard.summary, snippet: englishCard.snippet,
    accountableOwnerId: OWNER, sourceReferences: [`evidence://story-364/${externalKey}`], sourceDigest: DIGEST,
    linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [],
    linkedEvidenceIds: [deriveStableId("evidence", externalKey)],
    lifecycle: "active", retrievalDisposition: "default", freshnessState: "fresh",
    lastVerified: instant(9), stalenessPolicy: { maximumAgeDays: 180, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: englishCard.body, coexist: true,
  });
  const document = await writeBundle(join(container, "batch.json"), {
    schemaVersion: "tcrn.knowledge-batch.v1",
    members: [member("STORY-364-BATCH-A"), member("STORY-364-BATCH-B")],
  });
  const bundle = await writeBundle(join(container, "batch-bundle.json"), {
    model: ECONOMY_MODEL,
    translations: TRANSLATIONS,
    expansions: {
      "STORY-364-BATCH-A": { "zh-CN": PHRASINGS_ZH },
      "STORY-364-BATCH-B": { "zh-CN": ["密钥没批下来能不能先做别的", "第二张卡的问法", "凭据要不要先到位"] },
    },
  });
  const argv = (...extra) => ["knowledge-batch", "--workspace", workspace, "--expected-version", "0",
    "--at", instant(10), "--from-file", document, ...extra];

  await assert.rejects(() => cliJson(argv()),
    (error) => JSON.parse(error.message).failed.reasonCode === "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE",
    "one mutation option cannot carry N sets of answers; without the bundle the first member refuses");

  const applied = await cliJson(argv("--language-bundle", bundle));
  assert.equal(applied.reasonCode, "KNOWLEDGE_BATCH_APPLIED");
  const records = (await listKnowledgeMetadata(workspace, { at: instant(12), selection: "all", allowTrailing: true })).records;
  const byKey = new Map(records.map((record) => [record.externalKey, record]));
  assert.deepEqual(byKey.get("STORY-364-BATCH-A").expansions["zh-CN"], [...PHRASINGS_ZH].sort());
  assert.deepEqual(byKey.get("STORY-364-BATCH-B").expansions["zh-CN"], ["凭据要不要先到位", "密钥没批下来能不能先做别的", "第二张卡的问法"].sort(),
    "each member is served its own key's phrasings, not the first member's");
});

test("STORY-364 R3: conference-close --distill reaches the write-path hook", async (context) => {
  const workspace = await languageWorkspace(context, {
    "artifact.language": "en",
    "model.economyTier": ECONOMY_MODEL,
  });
  const bundle = await writeBundle(join(containerOf(workspace), "distill-bundle.json"), {
    model: ECONOMY_MODEL,
    translations: {},
    expansions: { NEW: { en: ["what did the conference decide", "which approach was ratified", "was the decision recorded"] } },
  });
  // The close event is appended BEFORE the distill, so a close refused by the write path
  // has already closed its conference. The refusal and the success therefore need one
  // conference each; that ordering is WSD-3's, not this change's.
  const open = async (suffix, second) => {
    const opened = await cliJson(["conference-open", "--workspace", workspace, "--expected-version", "head",
      "--at", instant(second), "--external-key", `STORY-364-CONFERENCE-${suffix}`, "--project-id", deriveStableId("project", "STORY-364-PROJECT"),
      "--type", "architecture", "--title", "Decide the artefact language",
      "--work-ids", deriveStableId("work", "TCRN-CROSS-STORY-364"),
      "--desired-outcome", "ratify the approach", "--participant-ids", "profile:architect-01"]);
    assert.equal(opened.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  };
  await open("A", 10);
  await open("B", 11);
  const argv = (suffix, second, ...extra) => ["conference-close", "--workspace", workspace, "--expected-version", "head",
    "--at", instant(second), "--conference-id", deriveStableId("conference", `STORY-364-CONFERENCE-${suffix}`),
    "--minutes-external-key", `STORY-364-MINUTES-${suffix}`, "--summary", "the approach was ratified",
    "--outcome-class", "role_decision", "--decisions", "record the artefact language as a setting",
    "--unresolved-issues", "-", "--distill", "true", "--accountable-owner-id", OWNER,
    "--stale-days", "90", "--evidence-ids", deriveStableId("evidence", "STORY-364-CLOSE"), ...extra];

  await assert.rejects(() => cliJson(argv("A", 12)),
    (error) => error.reasonCode === "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE",
    "distilling a decision into a card is a card write, and it is refused like every other one");

  const closed = await cliJson(argv("B", 13, "--language-bundle", bundle));
  assert.equal(closed.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(closed.knowledgeUnitIds.length, 1);
  const records = (await listKnowledgeMetadata(workspace, { at: instant(13), selection: "all", allowTrailing: true })).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].expansions.en.length, 3,
    "the distilled card carries the phrasings the bundle's NEW key holds");
});

test("STORY-364 R4: the injection hook translates once and asks again, and adds the two counts", async (context) => {
  const workspace = await languageWorkspace(context, {
    "artifact.language": "zh-CN",
    "model.economyTier": ECONOMY_MODEL,
    "retrieval.promptLanguages": "zh-CN",
  });
  const containerRoot = containerOf(workspace);
  await captureKnowledgeUnit(workspace, {
    ...englishCard,
    subject: "凭据不是实现的前置",
    summary: "密钥还没批下来并不阻塞要用它的工作",
    snippet: "对着接口做，不对着密钥做",
  }, { languageProvider: provider() });
  await seedDistractors(workspace, provider(), 10);
  const prompt = "is the key still blocking development";
  const bundle = await writeBundle(join(containerRoot, "query-bundle.json"), {
    model: ECONOMY_MODEL,
    translations: { [prompt]: "密钥还没申请下来是不是整个开发都得先卡住" },
  });

  const untranslated = await runInjection({ prompt, partition: "cross-project", containerRoot });
  assert.equal(untranslated.ok, true);
  assert.deepEqual(untranslated.queryTranslation, { from: "en", to: "zh-CN", model: ECONOMY_MODEL },
    "the engine says a translation is owed and names the model that owes it");
  assert.equal(untranslated.translatedQuery, null, "with no translator the hook keeps the first answer");
  assert.deepEqual(untranslated.telemetry, { queryTranslations: 1 });

  const translated = await runInjection({ prompt, partition: "cross-project", containerRoot, translate: bundleTranslator(bundle) });
  assert.equal(translated.translatedQuery, "密钥还没申请下来是不是整个开发都得先卡住");
  assert.deepEqual(translated.telemetry, { queryTranslations: 1 },
    "one owed on the first ask plus none owed on the second: the two counts added, not counted twice");
  assert.ok(String(translated.injection ?? "").includes("凭据不是实现的前置"),
    "and the second ask is the one whose answer is injected");

  const missing = await runInjection({
    prompt, partition: "cross-project", containerRoot,
    translate: bundleTranslator(await writeBundle(join(containerRoot, "empty-bundle.json"), { model: ECONOMY_MODEL, translations: {} })),
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.translatedQuery, null,
    "read-side is fail-open: a bundle without this prompt keeps the first answer rather than refusing");
});

test("language migration excludes retired cards before planning or applying policy", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-language-retired-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const bundlePath = await writeBundle(join(base, "bundle.json"), {
    model: ECONOMY_MODEL,
    translations: {},
    expansions: {},
  });
  const records = [
    { id: "active-default", lifecycle: "active", retrievalDisposition: "default" },
    { id: "active-excluded", lifecycle: "active", retrievalDisposition: "excluded" },
    { id: "candidate", lifecycle: "candidate", retrievalDisposition: "default" },
    { id: "retired", lifecycle: "retired", retrievalDisposition: "default" },
    { id: "superseded-default", lifecycle: "active", retrievalDisposition: "default", extensions: { supersededBy: "knowledge:111111111111111111111111" } },
    { id: "superseded-excluded", lifecycle: "active", retrievalDisposition: "excluded", extensions: { supersededBy: "knowledge:222222222222222222222222" } },
  ].map((record) => ({
    ...record,
    externalKey: record.id,
    subject: record.id,
    summary: record.id,
    snippet: record.id,
    expansions: {},
  }));
  const expected = ["active-default", "active-excluded", "candidate"].map((id) => records.find((record) => record.id === id));
  const expectedIds = expected.map((record) => record.id);
  const policyCalls = [];
  const providerCalls = [];
  const bodyCalls = [];
  const writes = [];
  const core = {
    async materializeWorkspace() {
      return { settings: [] };
    },
    readKnowledgeLanguagePolicy() {
      return {
        artifactLanguage: "en",
        promptLanguages: ["en"],
        economyModel: ECONOMY_MODEL,
      };
    },
    async listKnowledgeMetadata(_workspace, query) {
      assert.equal(query.selection, "all");
      return { records };
    },
    detectLanguage() {
      return "en";
    },
    parseLanguageBundle(bundle) {
      return bundle;
    },
    languageProviderFromBundle(_bundle, id) {
      providerCalls.push(id);
      return { id };
    },
    applyWriteLanguagePolicy(fields, _policy, languageProvider) {
      policyCalls.push(languageProvider.id);
      return {
        ...fields,
        expansions: { en: ["first question", "second question", "third question"] },
      };
    },
    async readKnowledgeBody(_workspace, id) {
      bodyCalls.push(id);
      return { body: id };
    },
    async validateKnowledgeStore() {
      return { version: writes.length };
    },
    async createKnowledgeUnit(_workspace, input) {
      writes.push(input);
      return {};
    },
  };
  const captureOutput = async (operation) => {
    let output = "";
    const original = process.stdout.write;
    process.stdout.write = function (chunk) {
      output += String(chunk);
      return true;
    };
    try {
      await operation();
    } finally {
      process.stdout.write = original;
    }
    return JSON.parse(output);
  };

  const plan = await captureOutput(() => planCommand(core, {
    workspace: base,
    at: instant(20),
  }));
  assert.equal(plan.reasonCode, "KNOWLEDGE_LANGUAGE_PLAN_READY");
  assert.equal(plan.cards, expected.length);
  assert.equal(plan.pending, expected.length);
  assert.deepEqual(plan.request.map((entry) => entry.id), expectedIds);
  assert.deepEqual(plan.request.filter((entry) => entry.id.startsWith("active-")).map((entry) => entry.id),
    ["active-default", "active-excluded"]);

  for (const dryRun of [true, false]) {
    policyCalls.length = 0;
    providerCalls.length = 0;
    bodyCalls.length = 0;
    writes.length = 0;
    const result = await captureOutput(() => migrateCommand(core, {
      workspace: base,
      bundle: bundlePath,
      at: instant(21),
      ...(dryRun ? { "dry-run": "true" } : {}),
    }));
    assert.equal(result.reasonCode, dryRun
      ? "KNOWLEDGE_LANGUAGE_MIGRATION_PLANNED"
      : "KNOWLEDGE_LANGUAGE_MIGRATED");
    assert.equal(result.cards, expected.length);
    assert.equal(result.rewritten, expected.length);
    assert.equal(result.refused, 0);
    assert.deepEqual(result.rewrites.map((entry) => entry.id), expectedIds);
    assert.deepEqual(providerCalls, expectedIds);
    assert.deepEqual(policyCalls, expectedIds);
    assert.deepEqual(bodyCalls, dryRun ? [] : expectedIds);
    assert.deepEqual(writes.map((entry) => entry.supersedes), dryRun ? [] : expectedIds);
  }
});
