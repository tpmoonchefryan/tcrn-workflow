// S6 lesson corpus — TCRN-CROSS-STORY-147, reworked under TCRN-CROSS-INC-034/035.
//
// WHAT THIS IS, AND WHAT THE PREVIOUS SHAPE WAS.
//
// The first implementation ran this corpus through promptfoo against a local
// provider whose `callApi` returned `context.vars.agentDecision` verbatim — the
// canned answer written in the same fixture — and then asserted that the output
// contained a substring of that same canned answer. No model was involved at any
// point. "6/6 green" was therefore `assert(literal.includes(substring-of-literal))`,
// which is the platform's signature failure mode (a predicate that cannot
// distinguish two worlds) in its purest form. The red file was the same tautology
// inverted. Neither carried information about any agent, engine or host.
//
// The green/red pair does prove ONE real thing, and it is worth keeping: that the
// markers DISCRIMINATE — that a correct decision and the known anti-pattern do not
// score the same. So that is what the deterministic test now claims to be: an
// assertion-discrimination test over this corpus, not a behaviour gate. Behaviour
// is only observable against a real model, which is `s6-models.yaml` and is a
// release-time concern with its own credential.
//
// NEGATION AWARENESS. Each lesson carries `mustContain` AND `mustNotContain`. Bare
// substring matching was the second defect: with `contains` alone, "不要继续，先停下"
// satisfies a `contains: 继续` marker. The anti-pattern markers are what make the
// two sides fail in different ways rather than by absence alone.
//
// Every lesson names the persistent-memory record it was distilled from, so a
// reader can check the scenario against the incident rather than trust this file.

/**
 * @typedef {object} Lesson
 * @property {string} id            stable id, used by the model-gate config too
 * @property {string} source        the memory record this was distilled from
 * @property {string} scenario      the situation put to the agent
 * @property {string[]} mustContain markers a correct decision states
 * @property {string[]} mustNotContain markers that betray the known anti-pattern
 * @property {string} goodDecision  a correct decision (discrimination fixture)
 * @property {string} antiPattern   the decision actually taken when this was learned
 */

/** @type {readonly Lesson[]} */
export const LESSONS = Object.freeze([
  {
    id: "L1-context-limit-is-not-a-reason-to-stop",
    source: "context-limit-is-not-a-reason-to-stop",
    scenario: "正在执行一张长任务，上下文窗口余量将尽，工作尚未完成。",
    mustContain: ["继续", "链"],
    mustNotContain: ["先停下", "窗口快满", "余量不足"],
    goodDecision: "继续完成当前工作，并持续把状态外置到链上；窗口余量不是停下的理由。",
    antiPattern: "窗口快满了，我先停下汇报，避免产出未验证的代码。"
  },
  {
    id: "L2-archive-limit-is-a-measurement-error",
    source: "helper-trust-state-unreleased",
    scenario: "verify-installed-copy 报 ARCHIVE_LIMIT_EXCEEDED。",
    mustContain: ["核对", "对象"],
    mustNotContain: ["信任面坏", "重装", "上报"],
    goodDecision: "先核对验证器的输入对象是不是已安装的 skill 副本——量错对象会得到这个码，再谈信任面。",
    antiPattern: "这是信任面坏了，需要重装并上报。"
  },
  {
    id: "L3-identity-mismatch-needs-triage-first",
    source: "helper-trust-state-unreleased",
    scenario: "会话首验报 IDENTITY_MISMATCH。",
    mustContain: ["分诊", "验证器"],
    mustNotContain: ["直接重装", "立即回滚"],
    goodDecision: "先分诊两型：安装副本漂移，还是验证器陈旧——两者修法相反；分清再动手。",
    antiPattern: "副本对不上，直接重装 skill 恢复一致。"
  },
  {
    id: "L4-local-green-is-not-ci-green",
    source: "local-green-is-not-ci-green",
    scenario: "刚改了 CI 专属文件并 push，本地全绿。",
    mustContain: ["CI", "watch"],
    mustNotContain: ["本地已全绿", "无需再看", "可以收工"],
    goodDecision: "push 后主动 gh run watch 盯 CI；本地绿不能替代 CI 绿。",
    antiPattern: "本地 455/0 全绿，改动只是配置，无需再看 CI。"
  },
  {
    id: "L5-stale-index-is-worse-than-grep",
    source: "codegraph-deployment",
    scenario: "要用代码索引回答当前代码问题。",
    mustContain: ["新鲜度", "status"],
    mustNotContain: ["直接查询", "索引一向是最新"],
    goodDecision: "先跑 status 验索引新鲜度（须晚于末次提交），不新鲜就先刷新再用。",
    antiPattern: "直接查询代码图谱，索引一向是最新的。"
  },
  {
    id: "L6-ask-the-authority-about-remote-state",
    source: "probe-before-defect",
    scenario: "想知道分支是否已到达远端。",
    mustContain: ["ls-remote", "sha"],
    mustNotContain: ["--not --remotes", "本地日志"],
    goodDecision: "问服务器：git ls-remote，并按全 sha 比对。",
    antiPattern: "用 git log --not --remotes 看本地日志里还有没有未推的提交。"
  }
]);

/**
 * Score one decision against one lesson's markers.
 *
 * Returned rather than thrown so both sides can be inspected: a caller proving
 * discrimination needs to see WHICH marker decided it, not just that it failed.
 */
export function evaluateDecision(lesson, decision) {
  const text = String(decision ?? "");
  const missing = lesson.mustContain.filter((marker) => !text.includes(marker));
  const forbidden = lesson.mustNotContain.filter((marker) => text.includes(marker));
  return { ok: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}
