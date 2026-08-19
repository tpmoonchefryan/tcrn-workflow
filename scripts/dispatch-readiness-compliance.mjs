// SPDX-License-Identifier: Apache-2.0

// The dispatch brief is deliberately a transport object, not a second work
// record. It carries the five pieces of execution equipment that a caller must
// provide at the moment it dispatches a Story. Keeping this validator outside
// the chain prevents execution detail from becoming append-only scope, while
// making the old "missing element means no dispatch" rule executable.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { validateStoryScope } from "./story-scope-compliance.mjs";

export const DISPATCH_BRIEF_FIELDS = Object.freeze([
  "redLineBoundaries",
  "filePointers",
  "verificationCommands",
  "chainCloseoutActions",
  "effectiveEvidenceCommands",
]);

// TCRN-CROSS-INC-235: a brief that names a target field must carry that field's limit,
// and the requirements it states must fit inside it.
//
// Measured, not supposed. Ten dispatch briefs each demanded four literal strings inside a
// knowledge card's `snippet`. KNOWLEDGE_LIMITS.maximumSnippetBytes is 512; the briefs never
// said so; four of ten results ran 518-530 bytes and the store refused them. The control
// arm -- a frontier model on three of the same tickets -- went over on three of three, at
// 608, 625 and 848 bytes. Writing more thoroughly violated the unstated ceiling MORE, which
// is what settles that the variable was the brief and not the model tier.
//
// WHAT THIS CHECK DOES AND DOES NOT CATCH, stated plainly because the tempting overclaim
// is that it prevents INC-235. It does not. Those four specifics total 55 bytes plus three
// separators -- a 58-byte floor under a 512-byte ceiling -- so a satisfiability check
// passes the exact brief that produced the failure. What actually went wrong was that four
// specifics plus enough prose to read as a card do not fit 512 bytes, and no arithmetic
// decides "enough prose" without inventing a number.
//
// So the remedy this carries is the DECLARATION, not the arithmetic. A brief that names a
// bounded target field now has somewhere to put the bound, which means the dispatched
// worker is told the ceiling exists -- and neither model in the experiment was. The floor
// check is the smaller, decidable half: it refuses a brief whose literal requirements
// cannot fit its own stated ceiling under any prose at all.
//
// The check never knows a target system's limits and must not pretend to: the BRIEF
// declares them. An undeclared field is unjudged, exactly as an unjudgeable command is,
// and `fieldBudgets.checked` travels with the result so a caller cannot read "nothing
// declared" as "budgets verified". Inventing a limit nobody declared would be the mirror
// of the defect this exists to reduce.
const FIELD_BUDGET_RULES = Object.freeze(["maxBytes", "requiredStrings"]);

function fieldBudgetProblems(budgets) {
  if (budgets === undefined) return { problems: [], declared: 0 };
  if (budgets === null || typeof budgets !== "object" || Array.isArray(budgets)) {
    return { problems: [{ field: "fieldBudgets", message: "fieldBudgets must be an object keyed by field name" }], declared: 0 };
  }
  const problems = [];
  let declared = 0;
  for (const [field, spec] of Object.entries(budgets)) {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      problems.push({ field: `fieldBudgets.${field}`, message: "a field budget is an object" });
      continue;
    }
    const unknown = Object.keys(spec).filter((key) => !FIELD_BUDGET_RULES.includes(key));
    if (unknown.length > 0) {
      problems.push({ field: `fieldBudgets.${field}`, message: `unknown budget rules: ${unknown.join(", ")}` });
    }
    const { maxBytes, requiredStrings } = spec;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      problems.push({ field: `fieldBudgets.${field}`, message: "maxBytes must be a positive integer -- the limit of the surface this field is written to" });
      continue;
    }
    declared += 1;
    if (requiredStrings === undefined) continue;
    if (!Array.isArray(requiredStrings) || requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
      problems.push({ field: `fieldBudgets.${field}`, message: "requiredStrings must be a list of non-empty strings" });
      continue;
    }
    // The floor is the required strings themselves plus one separating byte between each.
    // A brief demanding more literal content than its own ceiling admits is unsatisfiable
    // before anyone is dispatched against it, and that is decidable here rather than at the
    // target system after the work is done.
    const floor = requiredStrings.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0)
      + Math.max(0, requiredStrings.length - 1);
    if (floor > maxBytes) {
      problems.push({
        field: `fieldBudgets.${field}`,
        message: `requiredStrings need at least ${floor} bytes but the declared ceiling is ${maxBytes}`,
        code: "DISPATCH_FIELD_BUDGET_UNSATISFIABLE",
      });
    }
  }
  return { problems, declared };
}

// The subcommands a package manager answers itself. A brief naming one is running the
// package manager, not a script, and this check cannot say whether it will succeed.
const PACKAGE_MANAGER_SUBCOMMANDS = new Set([
  "add", "audit", "ci", "config", "dedupe", "dlx", "exec", "fetch", "import", "init",
  "install", "install-test", "link", "list", "ls", "outdated", "pack", "patch", "ping",
  "prune", "publish", "rebuild", "remove", "root", "setup", "store", "uninstall",
  "unlink", "update", "why",
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
  // TCRN-CROSS-INC-232: the message said "under the declared repositoryRoot" and the
  // check never asked. An absolute path from the author's own machine, or a ../ chain
  // out of the tree, was certified as resolving under a root it had left -- so a brief
  // stayed green after the file moved inside the repository the executor checks out,
  // which is the one failure this check exists to catch. Containment is now the claim
  // and the check, in that order.
  const base = resolve(root);
  const contained = absolute === base || absolute.startsWith(`${base}${sep}`);
  if (!contained) return `${entry} resolves outside the declared repositoryRoot`;
  // A directory satisfying a FILE pointer sent the executor to a folder and called it
  // a citation. statSync rather than existsSync is the whole difference.
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return `${entry} does not resolve under the declared repositoryRoot`;
  }
  return stats.isFile() ? null : `${entry} names a directory, not a file`;
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
    const explicitRun = tokens[1] === "run";
    const script = explicitRun ? tokens[2] : tokens[1];
    if (script === undefined || script.startsWith("-")) return { unjudged: true };
    // TCRN-CROSS-INC-232: without `run`, the first token may be a package-manager
    // subcommand rather than a script name. `pnpm install --frozen-lockfile` -- copied
    // verbatim out of this repository's own README -- was refused as "a script this
    // repository does not define", which is a false refusal wearing a specific and
    // wrong reason. A builtin is not judgeable by this check and is counted as such.
    if (!explicitRun && PACKAGE_MANAGER_SUBCOMMANDS.has(script)) return { unjudged: true };
    if (scripts === null) return { unjudged: true };
    return Object.hasOwn(scripts, script) ? {} : { message: `${entry} names a script this repository does not define` };
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
    : {
      checked: false,
      reason: typeof root === "string" && root.trim().length > 0
        ? "repositoryRoot was declared but filePointers or verificationCommands is not a list, so nothing was resolved"
        : "no repositoryRoot declared, so pointers and commands were not resolved",
    };
  // TCRN-CROSS-INC-232: citations.checked was the only place the weaker verdict showed,
  // and it is the one place a shell gate does not look. `ok`, `reasonCode` and the exit
  // code all came from problems.length, which the unchecked branch never touches, so a
  // brief opted out of the whole citation check by omitting one field and still reported
  // DISPATCH_BRIEF_READY with exit 0. The reason code now carries it. Still a pass --
  // presence-only was always a legitimate verdict -- but no longer the same word as the
  // checked one, so `reasonCode == "DISPATCH_BRIEF_READY"` is an assertion a gate can make.
  const budgets = fieldBudgetProblems(brief.fieldBudgets);
  for (const problem of budgets.problems) problems.push(problem);
  const ready = citations.checked ? "DISPATCH_BRIEF_READY" : "DISPATCH_BRIEF_READY_CITATIONS_UNCHECKED";
  return {
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? ready : "DISPATCH_BRIEF_INCOMPLETE",
    problems,
    citations,
    // Reported the same way citations are: a brief that declared no budget is not being
    // called compliant, it is being called unjudged on this axis.
    fieldBudgets: { checked: brief.fieldBudgets !== undefined, declared: budgets.declared },
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
