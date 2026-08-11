// SPDX-License-Identifier: Apache-2.0

import type { WorkRecord } from "../../protocol/src/index.js";

/**
 * The Story scope is deliberately a human-readable string rather than a second
 * schema stored in the event record.  This module is the machine boundary around
 * that string: it keeps the required headings ordered and exact, while leaving
 * the meaning of the prose and the acceptance decision to the accountable owner.
 */
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
] as const);

export type StoryScopeHeading = typeof STORY_SCOPE_HEADINGS[number];

export type StoryScopeProblemCode =
  | "STORY_SCOPE_REQUIRED"
  | "STORY_SCOPE_HEADING_MISSING"
  | "STORY_SCOPE_HEADING_DUPLICATE"
  | "STORY_SCOPE_HEADING_ORDER"
  | "STORY_SCOPE_SECTION_EMPTY"
  | "STORY_SCOPE_ACCEPTANCE_INVALID"
  | "STORY_SCOPE_PURPOSE_INVALID"
  | "STORY_SCOPE_LEGACY_ELEMENT_MISSING"
  | "TEMPLATE_SCOPE_HEADING_UNEXPECTED"
  | "TEMPLATE_SCOPE_REFERENCE_INVALID";

export interface StoryScopeProblem {
  readonly code: StoryScopeProblemCode;
  readonly heading?: string;
  readonly message: string;
}

export interface StoryScopeSection {
  // Template-bound records may use an admitted heading set outside the historic
  // Story vocabulary.  The legacy validator still narrows its own values to
  // StoryScopeHeading at runtime; the public section shape is widened so the
  // kind-independent template floor can reuse the same readback structure.
  readonly heading: string;
  readonly content: string;
  readonly line: number;
}

export interface StoryScopeValidation {
  readonly ok: boolean;
  readonly problems: readonly StoryScopeProblem[];
  readonly sections: readonly StoryScopeSection[];
}

const HEADING_NAMES = new Set<string>(STORY_SCOPE_HEADINGS);
const HEADING_LINE = /^\s*(?:#{1,6}\s*)?(?:【([^】]+)】|\[([^\]]+)\]|(Goal|Requirements|Acceptance Criteria|Business Background|Preconditions|Assumptions|Use Cases & Examples|Feature Toggle & Setting|Permissions|Implementation Notes))(.*)$/u;

function headingFromMatch(match: RegExpMatchArray): { readonly name: string; readonly inline: string } {
  return {
    name: match[1] ?? match[2] ?? match[3] ?? "",
    inline: (match[4] ?? "").trim(),
  };
}

function isBulletList(content: string): boolean {
  return /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+\S+/u.test(content);
}

function hasOrderedGwt(content: string): boolean {
  const given = content.search(/\bGIVEN\b/iu);
  const when = content.search(/\bWHEN\b/iu);
  const then = content.search(/\bTHEN\b/iu);
  return given >= 0 && when > given && then > when;
}

function hasAny(content: string, expressions: readonly RegExp[]): boolean {
  return expressions.some((expression) => expression.test(content));
}

/**
 * Parse and validate a Story scope.  `无——原因` is valid section content; an
 * absent section is not.  The four historic dispatch elements are checked by
 * explicit semantic anchors so the ten headings cannot become a hollow wrapper.
 */
export function validateStoryScope(scope: unknown): StoryScopeValidation {
  const problems: StoryScopeProblem[] = [];
  if (typeof scope !== "string" || scope.trim().length === 0) {
    return {
      ok: false,
      problems: [{ code: "STORY_SCOPE_REQUIRED", message: "Story requires a non-empty advisory scope" }],
      sections: [],
    };
  }

  const lines = scope.split(/\r?\n/u);
  const found: Array<{ readonly name: string; readonly inline: string; readonly line: number }> = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(HEADING_LINE);
    if (match === null) continue;
    const heading = headingFromMatch(match);
    if (!HEADING_NAMES.has(heading.name)) continue;
    found.push({ ...heading, line: index + 1 });
  }

  const counts = new Map<string, number>();
  for (const entry of found) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  for (const heading of STORY_SCOPE_HEADINGS) {
    const count = counts.get(heading) ?? 0;
    if (count === 0) {
      problems.push({ code: "STORY_SCOPE_HEADING_MISSING", heading, message: `missing Story scope block ${heading}` });
    } else if (count > 1) {
      problems.push({ code: "STORY_SCOPE_HEADING_DUPLICATE", heading, message: `duplicate Story scope block ${heading}` });
    }
  }

  const orderedNames = found.map((entry) => entry.name);
  const expectedNames = [...STORY_SCOPE_HEADINGS];
  if (orderedNames.length === expectedNames.length && orderedNames.some((name, index) => name !== expectedNames[index])) {
    problems.push({ code: "STORY_SCOPE_HEADING_ORDER", message: "Story scope blocks must use the canonical order" });
  }

  const sections: StoryScopeSection[] = [];
  for (const [index, entry] of found.entries()) {
    const nextLine = found[index + 1]?.line ?? lines.length + 1;
    const body = [entry.inline, ...lines.slice(entry.line, nextLine - 1)].filter((value) => value.length > 0).join("\n").trim();
    if (body.length === 0) {
      problems.push({ code: "STORY_SCOPE_SECTION_EMPTY", heading: entry.name, message: `Story scope block ${entry.name} is empty` });
    }
    if (HEADING_NAMES.has(entry.name)) {
      sections.push({ heading: entry.name as StoryScopeHeading, content: body, line: entry.line });
    }
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

  // The legacy four-element contract remains independently visible.  These
  // anchors are intentionally broader than one language so existing bilingual
  // records can be migrated without weakening the rule.
  const legacyEvidence = hasAny(all, [/现象|现状|问题|来源|实证|证据|命令|实测|复核|evidence|command|observed/iu]);
  const legacyFix = hasAny(requirements + "\n" + (byHeading.get("Implementation Notes") ?? ""), [/修复|改造|交付|落点|改什么|实现|新增|移除|调整|fix|implement|deliver/iu]);
  const legacyDecision = hasAny(all, [/决策|裁定|状态|判定人|Owner|planned|ready|active|blocked|done|待/iu]);
  if (!legacyEvidence) problems.push({ code: "STORY_SCOPE_LEGACY_ELEMENT_MISSING", heading: "Requirements", message: "legacy phenomenon/evidence element is not mapped" });
  if (!legacyFix) problems.push({ code: "STORY_SCOPE_LEGACY_ELEMENT_MISSING", heading: "Requirements", message: "legacy fix-items element is not mapped" });
  if (!hasOrderedGwt(acceptance) && !isBulletList(acceptance)) problems.push({ code: "STORY_SCOPE_LEGACY_ELEMENT_MISSING", heading: "Acceptance Criteria", message: "legacy red/green acceptance element is not mapped" });
  if (!legacyDecision) problems.push({ code: "STORY_SCOPE_LEGACY_ELEMENT_MISSING", heading: "Implementation Notes", message: "legacy decision/state element is not mapped" });

  return { ok: problems.length === 0, problems, sections };
}

export function storyScopeFromRecord(record: Pick<WorkRecord, "kind" | "tombstone" | "extensions"> | null | undefined): string | null {
  if (record === null || record === undefined || record.kind !== "Story" || record.tombstone) return null;
  const extension = record.extensions["advisory:scope"];
  if (extension === undefined || typeof extension.value !== "string") return null;
  return extension.value;
}

export function validateStoryRecord(record: Pick<WorkRecord, "kind" | "tombstone" | "extensions"> | null | undefined): StoryScopeValidation {
  if (record === null || record === undefined || record.kind !== "Story" || record.tombstone) {
    return { ok: true, problems: [], sections: [] };
  }
  return validateStoryScope(storyScopeFromRecord(record));
}

/** A Story whose Goal names Owner as decider needs a minutes backlink before done. */
export function storyScopeNamesOwnerDecider(scope: unknown): boolean {
  if (typeof scope !== "string") return false;
  const goal = validateStoryScope(scope).sections.find((section) => section.heading === "Goal")?.content ?? "";
  return /判定人\s*[=:：]\s*[^\n。；;]*(?:\bOwner\b|所有者)/u.test(goal);
}

/**
 * A template owns its headings; the engine owns only this invariant floor.  The
 * old Story validator above remains byte-compatible for pre-template records,
 * while this contract lets an admitted template choose a different heading set
 * without weakening the four purpose anchors or the legacy closeout elements.
 */
export interface ScopeTemplateDefinition {
  readonly id: string;
  readonly version: number;
  readonly headings: readonly string[];
  readonly acceptanceHeadings?: readonly string[];
  readonly referenceHeadings?: readonly string[];
}

const TEMPLATE_BRACKET_HEADING = /^\s*(?:【([^】]+)】|\[([^\]]+)\])(.*)$/u;
const TEMPLATE_MARKDOWN_HEADING = /^\s*#{1,6}\s+(.+?)\s*$/u;
const TEMPLATE_BASE_ANCHORS = Object.freeze(["为谁", "目的锚", "符合性判据", "判定人"] as const);
const TEMPLATE_REFERENCE_VALUE = /^(?:(?:ref|reference|vault|credential|secret|attachment):[^\s]+|https?:\/\/[^\s]+)$/iu;

interface ParsedTemplateHeading {
  readonly name: string;
  readonly inline: string;
  readonly line: number;
}

function parseTemplateHeadings(scope: string): readonly ParsedTemplateHeading[] {
  const lines = scope.split(/\r?\n/u);
  const found: ParsedTemplateHeading[] = [];
  for (const [index, line] of lines.entries()) {
    const bracket = line.match(TEMPLATE_BRACKET_HEADING);
    if (bracket !== null) {
      found.push({ name: (bracket[1] ?? bracket[2] ?? "").trim(), inline: (bracket[3] ?? "").trim(), line: index + 1 });
      continue;
    }
    const markdown = line.match(TEMPLATE_MARKDOWN_HEADING);
    if (markdown !== null) found.push({ name: (markdown[1] ?? "").trim(), inline: "", line: index + 1 });
  }
  return found;
}

function templateSections(scope: string, found: readonly ParsedTemplateHeading[]): readonly StoryScopeSection[] {
  const lines = scope.split(/\r?\n/u);
  return found.map((entry, index) => {
    const nextLine = found[index + 1]?.line ?? lines.length + 1;
    const body = [entry.inline, ...lines.slice(entry.line, nextLine - 1)]
      .filter((value) => value.length > 0)
      .join("\n")
      .trim();
    return { heading: entry.name, content: body, line: entry.line };
  });
}

/**
 * Validate an admitted template instance.  `kind` is intentionally absent from
 * this API: template shape is data, while work-graph behaviour remains owned by
 * the protocol kind and the frozen coupling roster in template-admission.ts.
 */
export function validateTemplateScope(scope: unknown, template: ScopeTemplateDefinition): StoryScopeValidation {
  const problems: StoryScopeProblem[] = [];
  if (typeof scope !== "string" || scope.trim().length === 0) {
    return { ok: false, problems: [{ code: "STORY_SCOPE_REQUIRED", message: "templated work requires a non-empty scope" }], sections: [] };
  }
  const expected = [...template.headings];
  const found = parseTemplateHeadings(scope);
  const counts = new Map<string, number>();
  for (const entry of found) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  for (const heading of expected) {
    const count = counts.get(heading) ?? 0;
    if (count === 0) problems.push({ code: "STORY_SCOPE_HEADING_MISSING", heading, message: `missing template scope block ${heading}` });
    else if (count > 1) problems.push({ code: "STORY_SCOPE_HEADING_DUPLICATE", heading, message: `duplicate template scope block ${heading}` });
  }
  for (const entry of found) {
    if (!expected.includes(entry.name)) {
      problems.push({ code: "TEMPLATE_SCOPE_HEADING_UNEXPECTED", heading: entry.name, message: `unexpected template scope block ${entry.name}` });
    }
  }
  if (found.length === expected.length && found.some((entry, index) => entry.name !== expected[index])) {
    problems.push({ code: "STORY_SCOPE_HEADING_ORDER", message: "template scope blocks must use the admitted order" });
  }
  const sections = templateSections(scope, found);
  for (const section of sections) {
    if (section.content.length === 0) {
      problems.push({ code: "STORY_SCOPE_SECTION_EMPTY", heading: section.heading, message: `template scope block ${section.heading} is empty` });
    }
  }

  const byHeading = new Map(sections.map((section) => [section.heading, section.content]));
  const all = scope;
  for (const anchor of TEMPLATE_BASE_ANCHORS) {
    if (!all.includes(anchor)) {
      problems.push({ code: "STORY_SCOPE_PURPOSE_INVALID", heading: "Goal", message: `template scope is missing base anchor ${anchor}` });
    }
  }
  const legacyEvidence = /现象|现状|问题|来源|实证|证据|命令|实测|复核|evidence|command|observed/iu.test(all);
  const legacyFix = /修复|改造|交付|落点|改什么|实现|新增|移除|调整|fix|implement|deliver/iu.test(all);
  const legacyDecision = /决策|裁定|状态|判定人|Owner|planned|ready|active|blocked|done|待/iu.test(all);
  if (!legacyEvidence) problems.push({ code: "STORY_SCOPE_LEGACY_ELEMENT_MISSING", heading: "Requirements", message: "legacy phenomenon/evidence element is not mapped" });
  if (!legacyFix) problems.push({ code: "STORY_SCOPE_LEGACY_ELEMENT_MISSING", heading: "Requirements", message: "legacy fix-items element is not mapped" });
  if (!legacyDecision) problems.push({ code: "STORY_SCOPE_LEGACY_ELEMENT_MISSING", heading: "Implementation Notes", message: "legacy decision/state element is not mapped" });

  const acceptanceHeadings = template.acceptanceHeadings ?? ["Acceptance Criteria"];
  const primaryAcceptanceHeading = acceptanceHeadings[0] ?? "Acceptance Criteria";
  const acceptance = acceptanceHeadings.map((heading) => byHeading.get(heading) ?? "").find((content) => content.length > 0) ?? "";
  if (acceptance.length === 0 || (!hasOrderedGwt(acceptance) && !isBulletList(acceptance) && acceptanceHeadings.length === 1 && primaryAcceptanceHeading === "Acceptance Criteria")) {
    problems.push({ code: "STORY_SCOPE_ACCEPTANCE_INVALID", heading: primaryAcceptanceHeading, message: "template scope lacks an acceptance/expected outcome section" });
  }

  for (const heading of template.referenceHeadings ?? []) {
    const content = byHeading.get(heading) ?? "";
    const values = content.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (values.length === 0 || values.some((value) => !TEMPLATE_REFERENCE_VALUE.test(value))) {
      problems.push({ code: "TEMPLATE_SCOPE_REFERENCE_INVALID", heading, message: `${heading} must contain references, not inline secrets or arbitrary text` });
    }
  }
  return { ok: problems.length === 0, problems, sections };
}
