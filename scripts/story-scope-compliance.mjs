// SPDX-License-Identifier: Apache-2.0

// Runtime twin of packages/core/src/story-scope-compliance.ts.  The closeout
// runner is intentionally executable without a TypeScript build, so this small
// adapter keeps the same contract at the independent closeout boundary.  The
// parity test feeds identical fixtures to both implementations.

export const STORY_SCOPE_HEADINGS = Object.freeze([
  "Goal",
  "Requirements",
  "Acceptance Criteria",
  "Business Background",
  "Preconditions",
  "Assumptions",
  "Use Cases & Examples",
  "Feature Toggle & Setting",
  "Permissions",
  "Implementation Notes",
]);

const HEADING_NAMES = new Set(STORY_SCOPE_HEADINGS);
const HEADING_LINE = /^\s*(?:#{1,6}\s*)?(?:【([^】]+)】|\[([^\]]+)\]|(Goal|Requirements|Acceptance Criteria|Business Background|Preconditions|Assumptions|Use Cases & Examples|Feature Toggle & Setting|Permissions|Implementation Notes))(.*)$/u;

function headingFromMatch(match) {
  return { name: match[1] ?? match[2] ?? match[3] ?? "", inline: (match[4] ?? "").trim() };
}

function isBulletList(content) {
  return /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+\S+/u.test(content);
}

function hasOrderedGwt(content) {
  const given = content.search(/\bGIVEN\b/iu);
  const when = content.search(/\bWHEN\b/iu);
  const then = content.search(/\bTHEN\b/iu);
  return given >= 0 && when > given && then > when;
}

function hasAny(content, expressions) {
  return expressions.some((expression) => expression.test(content));
}

export function validateStoryScope(scope) {
  const problems = [];
  if (typeof scope !== "string" || scope.trim().length === 0) {
    return { ok: false, problems: [{ code: "STORY_SCOPE_REQUIRED", message: "Story requires a non-empty advisory scope" }], sections: [] };
  }
  const lines = scope.split(/\r?\n/u);
  const found = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(HEADING_LINE);
    if (match === null) continue;
    const heading = headingFromMatch(match);
    if (!HEADING_NAMES.has(heading.name)) continue;
    found.push({ ...heading, line: index + 1 });
  }
  const counts = new Map();
  for (const entry of found) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  for (const heading of STORY_SCOPE_HEADINGS) {
    const count = counts.get(heading) ?? 0;
    if (count === 0) problems.push({ code: "STORY_SCOPE_HEADING_MISSING", heading, message: `missing Story scope block ${heading}` });
    else if (count > 1) problems.push({ code: "STORY_SCOPE_HEADING_DUPLICATE", heading, message: `duplicate Story scope block ${heading}` });
  }
  const orderedNames = found.map((entry) => entry.name);
  if (orderedNames.length === STORY_SCOPE_HEADINGS.length && orderedNames.some((name, index) => name !== STORY_SCOPE_HEADINGS[index])) {
    problems.push({ code: "STORY_SCOPE_HEADING_ORDER", message: "Story scope blocks must use the canonical order" });
  }
  const sections = [];
  for (const [index, entry] of found.entries()) {
    const nextLine = found[index + 1]?.line ?? lines.length + 1;
    const body = [entry.inline, ...lines.slice(entry.line, nextLine - 1)].filter((value) => value.length > 0).join("\n").trim();
    if (body.length === 0) problems.push({ code: "STORY_SCOPE_SECTION_EMPTY", heading: entry.name, message: `Story scope block ${entry.name} is empty` });
    sections.push({ heading: entry.name, content: body, line: entry.line });
  }
  const byHeading = new Map(sections.map((section) => [section.heading, section.content]));
  const goal = byHeading.get("Goal") ?? "";
  const requirements = byHeading.get("Requirements") ?? "";
  const acceptance = byHeading.get("Acceptance Criteria") ?? "";
  const all = scope;
  if (![/为谁/u, /目的锚/u, /符合性判据/u, /判定人/u].every((expression) => expression.test(goal))) {
    problems.push({ code: "STORY_SCOPE_PURPOSE_INVALID", heading: "Goal", message: "Goal must name beneficiary, purpose anchor, compliance criterion, and decider" });
  }
  if (!hasOrderedGwt(acceptance) && !isBulletList(acceptance)) {
    problems.push({ code: "STORY_SCOPE_ACCEPTANCE_INVALID", heading: "Acceptance Criteria", message: "Acceptance Criteria must use ordered GIVEN/WHEN/THEN or bullet points" });
  }
  const legacyEvidence = hasAny(all, [/现象|现状|问题|来源|实证|证据|命令|实测|复核|evidence|command|observed/iu]);
  const legacyFix = hasAny(`${requirements}\n${byHeading.get("Implementation Notes") ?? ""}`, [/修复|改造|交付|落点|改什么|实现|新增|移除|调整|fix|implement|deliver/iu]);
  const legacyDecision = hasAny(all, [/决策|裁定|状态|判定人|Owner|planned|ready|active|blocked|done|待/iu]);
  if (!legacyEvidence) problems.push({ code: "STORY_SCOPE_LEGACY_ELEMENT_MISSING", heading: "Requirements", message: "legacy phenomenon/evidence element is not mapped" });
  if (!legacyFix) problems.push({ code: "STORY_SCOPE_LEGACY_ELEMENT_MISSING", heading: "Requirements", message: "legacy fix-items element is not mapped" });
  if (!hasOrderedGwt(acceptance) && !isBulletList(acceptance)) problems.push({ code: "STORY_SCOPE_LEGACY_ELEMENT_MISSING", heading: "Acceptance Criteria", message: "legacy red/green acceptance element is not mapped" });
  if (!legacyDecision) problems.push({ code: "STORY_SCOPE_LEGACY_ELEMENT_MISSING", heading: "Implementation Notes", message: "legacy decision/state element is not mapped" });
  return { ok: problems.length === 0, problems, sections };
}

export function storyScopeFromAuthorityRecord(record) {
  if (record === null || typeof record !== "object" || record.kind !== "Story" || record.tombstone === true) return null;
  if (typeof record.scope === "string") return record.scope;
  if (typeof record.advisory?.scope === "string") return record.advisory.scope;
  const extension = record.extensions?.["advisory:scope"];
  return typeof extension?.value === "string" ? extension.value : null;
}

export function storyScopeProblems(records) {
  const problems = [];
  for (const record of records ?? []) {
    if (record?.kind !== "Story" || record.tombstone === true || record.status === "done" || record.status === "cancelled") continue;
    const scope = storyScopeFromAuthorityRecord(record);
    const result = validateStoryScope(scope);
    for (const problem of result.problems) {
      problems.push(`Story ${record.externalKey ?? record.id ?? "<unknown>"}: ${problem.message}`);
    }
  }
  return problems;
}

export function storyScopeNamesOwnerDecider(scope) {
  if (typeof scope !== "string") return false;
  const goal = validateStoryScope(scope).sections.find((section) => section.heading === "Goal")?.content ?? "";
  return /判定人\s*[=:：]\s*[^\n。；;]*(?:\bOwner\b|所有者)/u.test(goal);
}
