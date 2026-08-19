// SPDX-License-Identifier: Apache-2.0

// The dispatch brief is deliberately a transport object, not a second work
// record. It carries the five pieces of execution equipment that a caller must
// provide at the moment it dispatches a Story. Keeping this validator outside
// the chain prevents execution detail from becoming append-only scope, while
// making the old "missing element means no dispatch" rule executable.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { validateStoryScope } from "./story-scope-compliance.mjs";

export const DISPATCH_BRIEF_FIELDS = Object.freeze([
  "redLineBoundaries",
  "filePointers",
  "verificationCommands",
  "chainCloseoutActions",
  "effectiveEvidenceCommands",
]);

function nonEmptyList(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    return { field, message: `${field} must be a non-empty list` };
  }
  if (value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    return { field, message: `${field} must contain only non-empty strings` };
  }
  return null;
}

// TCRN-CROSS-STORY-303: presence is not sufficiency. Every field above is satisfied by
// a single-character string, so a brief can be shaped-valid and still leave an executor
// guessing -- which is the failure the granularity rule exists to prevent, and exactly
// the shape of gate this audit was commissioned to find: one that reports diligence
// while the thing it names goes unmeasured.
//
// Two failures are mechanical, expensive, and the same failure twice: a citation that
// is not real. Checking that a citation is true constrains nobody's thinking; it checks
// that what was written is so.
//
// The cost is measured rather than asserted, because the first version of this comment
// asserted it and was wrong. It claimed a model that cannot find what it was pointed at
// fills the gap instead of stopping. Tested the same day against Haiku 4.5, two runs per
// arm, identical task and repository differing only in whether the citations resolve:
// both stale-brief runs named the unresolved pointers, found the real files, and
// corrected the verification command -- one of them surfacing a package script the
// author of this check did not know existed. Neither invented anything.
//
// What the stale brief actually cost, averaged over the two runs: 11 tool calls against
// 2, and 38.6 seconds against 17.2 -- roughly five times the tool calls and twice the
// wall clock to arrive at the same answer, for about 10% more tokens. That is the honest
// argument for this check. It does not prevent a wrong answer; it prevents an executor
// paying to rediscover what the brief already knew (TCRN-CROSS-INC-228).
function unresolvedCitation(entry, root) {
  // A pointer may carry a :line or :line:column suffix; the file is the claim.
  const path = entry.replace(/:\d+(?::\d+)?$/u, "");
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  return existsSync(absolute) ? null : `${entry} does not resolve under the declared repositoryRoot`;
}

function packageScripts(root) {
  try {
    return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts ?? {};
  } catch {
    // An absent or unreadable manifest is not a failure. It means script names cannot
    // be judged here, and the unjudged count says so rather than passing them silently.
    return null;
  }
}

function unrunnableCommand(entry, root, scripts) {
  const tokens = entry.trim().split(/\s+/u);
  if (tokens[0] === "pnpm" || tokens[0] === "npm") {
    const script = tokens[1] === "run" ? tokens[2] : tokens[1];
    if (script === undefined || script.startsWith("-")) return { unjudged: true };
    if (scripts === null) return { unjudged: true };
    return script in scripts ? {} : { message: `${entry} names a script this repository does not define` };
  }
  if (tokens[0] === "node" && tokens[1] !== undefined && !tokens[1].startsWith("-")) {
    return existsSync(isAbsolute(tokens[1]) ? tokens[1] : resolve(root, tokens[1]))
      ? {}
      : { message: `${entry} runs a file that does not exist` };
  }
  // Anything else this validator cannot judge, and an unjudged command must never read
  // as a checked one.
  return { unjudged: true };
}

function resolveCitations(brief, root) {
  const problems = [];
  for (const pointer of brief.filePointers) {
    const message = unresolvedCitation(pointer, root);
    if (message) problems.push({ field: "filePointers", message, code: "DISPATCH_POINTER_UNRESOLVED" });
  }
  const scripts = packageScripts(root);
  let unjudged = 0;
  for (const command of brief.verificationCommands) {
    const verdict = unrunnableCommand(command, root, scripts);
    if (verdict.unjudged) unjudged += 1;
    if (verdict.message) problems.push({ field: "verificationCommands", message: verdict.message, code: "DISPATCH_COMMAND_UNRUNNABLE" });
  }
  return { problems, citations: { checked: true, unjudgedCommands: unjudged } };
}

export function validateDispatchBrief(brief) {
  const problems = [];
  if (brief === null || typeof brief !== "object" || Array.isArray(brief)) {
    return {
      ok: false,
      reasonCode: "DISPATCH_BRIEF_REQUIRED",
      problems: [{ field: "brief", message: "dispatch brief must be an object" }],
    };
  }
  for (const field of DISPATCH_BRIEF_FIELDS) {
    const problem = nonEmptyList(brief[field], field);
    if (problem) problems.push(problem);
  }
  const storyScope = brief.storyScope;
  if (typeof storyScope !== "string" || storyScope.trim().length === 0) {
    problems.push({ field: "storyScope", message: "storyScope must carry the live Story ten-block scope" });
  } else {
    const scopeResult = validateStoryScope(storyScope);
    for (const problem of scopeResult.problems) {
      problems.push({ field: "storyScope", message: problem.message, code: problem.code });
    }
  }
  // Citations are only resolvable against a root, and a brief that names none gets the
  // presence-only verdict it always got. What it does not get is silence about that:
  // `citations.checked: false` travels with the result, so a caller cannot read a
  // presence pass as a resolvability pass. Same discipline as the trailing-read
  // disclosure -- the weaker answer is labelled rather than dressed as the stronger one.
  const root = brief.repositoryRoot;
  const citations = typeof root === "string" && root.trim().length > 0 && Array.isArray(brief.filePointers) && Array.isArray(brief.verificationCommands)
    ? (() => {
      const resolved = resolveCitations(brief, root);
      problems.push(...resolved.problems);
      return resolved.citations;
    })()
    : { checked: false, reason: "no repositoryRoot declared, so pointers and commands were not resolved" };
  return {
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? "DISPATCH_BRIEF_READY" : "DISPATCH_BRIEF_INCOMPLETE",
    problems,
    citations,
  };
}

if (process.argv[1]?.endsWith("dispatch-readiness-compliance.mjs")) {
  const pathIndex = process.argv.indexOf("--brief");
  if (pathIndex < 0 || !process.argv[pathIndex + 1]) {
    process.stderr.write("usage: dispatch-readiness-compliance.mjs --brief <brief.json>\n");
    process.exitCode = 2;
  } else {
    let result;
    try {
      result = validateDispatchBrief(JSON.parse(readFileSync(process.argv[pathIndex + 1], "utf8")));
    } catch (error) {
      result = {
        ok: false,
        reasonCode: "DISPATCH_BRIEF_UNREADABLE",
        problems: [{ field: "brief", message: String(error?.message ?? error) }],
      };
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  }
}
