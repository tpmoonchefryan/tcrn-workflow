// SPDX-License-Identifier: Apache-2.0
//
// G-4 push gate. Run this before pushing to GitHub; a push is authorized only by a
// PUSH_GATE_VERIFIED receipt on stdout and exit 0.
//
// This is not a general quality sweep. `verify:p1` and `verify:p8` already judge the
// source, and this gate runs both rather than restating them. What it adds is the class
// of defect that survives them -- the consequence of a change rather than the change
// itself, which is precisely the class this program kept shipping:
//
//   * The rc.6 cut advanced package.json and FRAMEWORK_VERSION, which verify:p8 checks,
//     and left the status badge in all five READMEs reading rc.5, which nothing checked.
//     A reader takes the version from the badge. Check 2.
//
//   * A release note and a CHANGELOG heading are the two places a version is announced
//     in prose, so they are the two places nothing derives it from the source. Check 3.
//
//   * In the helper repository a tag was published on a commit whose suite was 22 tests
//     red, because a narrower check was run in place of the suite. The lesson is not
//     "run the suite" -- it is that a tag must never name bytes that were not judged.
//     Check 4 refuses to approve a push whose version already has a tag pointing
//     somewhere else.
//
//   * All five READMEs fell a full minor version behind on capabilities while the badge
//     stayed current, and four human-facing root docs had no translation at all. Check 2d
//     holds the current version in prose (not only the badge); check 2e requires every
//     declared translation to exist and pins each translated root doc to the SHA-256 of its
//     English source, so English cannot move ahead of a stale mirror unnoticed.
//
// Warnings are failures here. There is no --force.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { P8_VERSION } from "./lib/p8-workflow-rc.mjs";
import { requiredFailurePatternProblems } from "./preflight.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function fail(reasonCode, detail) {
  failures.push({ reasonCode, detail });
}

function read(relativePath) {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

function run(command, argv) {
  const result = spawnSync(command, argv, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) return { ok: false, output: String(result.error.message) };
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// A closing `**` must be right-flanking (CommonMark): not preceded by whitespace, and --
// when preceded by punctuation -- followed by whitespace or punctuation. CJK prose walks
// into that rule constantly, because `**一句话。**下一句` puts an ideographic full stop
// before the delimiter and a letter after it; the span never closes and the reader gets
// four literal asterisks. Latin text rarely trips it, which is why it went unnoticed. Code
// is not prose: fenced blocks are dropped wholesale and inline spans are blanked in place,
// so a document explaining this very rule in backticks is not mistaken for a defect, and
// column-free line numbers survive.
function checkCjkEmphasis(document, body) {
  const punctuation = /[\p{P}\p{S}]/u;
  const whitespace = /\s/u;
  let fenced = false;
  body.split("\n").forEach((line, index) => {
    if (/^\s*(?:```|~~~)/u.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const prose = line.replace(/`[^`]*`/gu, (span) => " ".repeat(span.length));
    for (const match of prose.matchAll(/\*\*([^*]+)\*\*/gu)) {
      const closeAt = match.index + match[0].length - 2;
      const before = prose[closeAt - 1];
      const after = prose[closeAt + 2];
      if (before === undefined || whitespace.test(before) || !punctuation.test(before)) continue;
      if (after === undefined || whitespace.test(after) || punctuation.test(after)) continue;
      fail("PUSH_GATE_EMPHASIS_UNCLOSED", `${document}:${index + 1}: ${match[0].slice(0, 40)}`);
    }
  });
}

// 1. A dirty tree means the bytes that pass the gate are not the bytes that get pushed.
//    verify:p1 and verify:p8 refuse a dirty basis themselves, but they say so in the
//    middle of a long run; saying it first is worth the duplicated git call.
const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
if (!status.ok) fail("PUSH_GATE_GIT_UNAVAILABLE", status.output.trim().slice(0, 200));
else if (status.output.trim() !== "") fail("PUSH_GATE_TREE_DIRTY", status.output.trim().split("\n").slice(0, 5).join(" | "));

// 2. The version as the reader sees it, and whether the reader sees prose at all.
//
//    Nothing else in this repository reads the translations. verifyMap parses the claim
//    badge out of README.md and stops there, so a translated document could say anything,
//    in any state of repair, and every gate would stay green. Two defects shipped through
//    that hole in one release: a status badge left at the previous version in all five
//    files, and eighteen emphasis spans that render as literal asterisks in Chinese and
//    Japanese.
const badgeVersion = P8_VERSION.replaceAll("-", "--");
for (const document of ["README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md", "README.fr.md"]) {
  const body = await read(document);
  const published = [...body.matchAll(/status-([0-9][^-\s)]*(?:--[^-\s)]+)*)-blue/gu)].map((match) => match[1]);
  if (published.length === 0) fail("PUSH_GATE_STATUS_BADGE_MISSING", document);
  else if (!published.every((value) => value === badgeVersion)) fail("PUSH_GATE_STATUS_BADGE_STALE", `${document}: ${published.join(", ")} != ${badgeVersion}`);
  checkCjkEmphasis(document, body);
}

// 2b. The version in prose, not just in the badge.
//
//     The badge check above was written after a release cut left it reading rc.5, and it
//     was too narrow: the same cut left `0.1.0-rc.5` in the "Status, honestly" section of
//     all five READMEs, in the first sentence of the versioning policy, and twice in the
//     compatibility notes. Seven statements of the current version, none of them derived
//     from the source, none of them checked -- including one in a section whose title
//     promises honesty.
//
//     The rule cannot be "never mention an old version": release notes, the changelog and
//     the rc.5 compatibility record must be free to reference history. It is scoped
//     instead to documents that speak in the present tense about *this* version, which are
//     enumerated here. A document that joins that set must be added to this list.
const currentVersionDocuments = [
  "README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md", "README.fr.md",
  "docs/versioning/versioning-policy.md",
  "docs/compatibility/supported-modes.md",
];
for (const document of currentVersionDocuments) {
  const body = await read(document);
  body.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/\b\d+\.\d+\.\d+-rc\.\d+\b/gu)) {
      if (match[0] === P8_VERSION) continue;
      fail("PUSH_GATE_STALE_VERSION_PROSE", `${document}:${index + 1}: ${match[0]} != ${P8_VERSION}`);
    }
  });
}

// 2c. The failure-pattern register has to stay data. A register that drifts out of sync
//     with itself is worse than none: it would be cited as a count when it is no longer
//     counting. The check is small on purpose -- it does not judge whether a pattern is
//     real, only that the file still says what it claims to say.
const registerPath = "scripts/policy/failure-pattern-register.json";
let register = null;
try {
  register = JSON.parse(await read(registerPath));
} catch (error) {
  fail("PUSH_GATE_REGISTER_UNPARSEABLE", `${registerPath}: ${error.message.slice(0, 120)}`);
}
if (register !== null) {
  const layers = new Set(Object.keys(register.layers ?? {}));
  const audiences = new Set(Object.keys(register.audiences ?? {}));
  for (const pattern of register.patterns ?? []) {
    const occurrences = Array.isArray(pattern.occurrences) ? pattern.occurrences.length : -1;
    // The count is the whole point of the file -- promotion is decided by it -- so a count
    // that disagrees with the list it summarises is the one corruption that matters.
    if (pattern.occurrenceCount !== occurrences) {
      fail("PUSH_GATE_REGISTER_COUNT_DRIFTED", `${pattern.id}: declares ${pattern.occurrenceCount}, lists ${occurrences}`);
    }
    if (!layers.has(pattern.layer)) fail("PUSH_GATE_REGISTER_LAYER_UNKNOWN", `${pattern.id}: ${pattern.layer}`);
    if (!audiences.has(pattern.audience)) fail("PUSH_GATE_REGISTER_AUDIENCE_UNKNOWN", `${pattern.id}: ${pattern.audience}`);
    // A "gated" entry claims something is already machine-judged. If it names no gate, the
    // register is asserting coverage it cannot point at, which is the pattern the file
    // itself calls argument-from-unchecked-gate.
    if (pattern.disposition === "gated" && (typeof pattern.gate !== "string" || pattern.gate === "")) {
      fail("PUSH_GATE_REGISTER_GATE_UNNAMED", pattern.id);
    }
    if (pattern.disposition !== "gated" && pattern.gate !== null) {
      fail("PUSH_GATE_REGISTER_GATE_UNEXPECTED", `${pattern.id}: ${String(pattern.gate)}`);
    }
  }
  for (const problem of requiredFailurePatternProblems(register)) {
    fail("PUSH_GATE_FAILURE_PATTERN_REQUIRED", problem);
  }
}

// 2d. The version in the "Status" prose, not only in the badge. (INIT-011 S086)
//     Check 2 pins the badge; a reader also takes the current version from the Status
//     section. The stale-version scan (2b) only matches `-rc.` strings, so a release-to-
//     release lag in prose -- exactly the debt that left all five READMEs a version behind
//     on capabilities -- sails through it. Require the current version to appear in prose,
//     with the status badge stripped first so the badge alone cannot satisfy the check.
for (const document of ["README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md", "README.fr.md"]) {
  const prose = (await read(document)).replaceAll(/status-[0-9][^)\s]*-blue/gu, "");
  if (!prose.includes(P8_VERSION)) fail("PUSH_GATE_STATUS_VERSION_ABSENT", `${document}: "${P8_VERSION}" appears only in the badge, not in prose`);
}

// 2e. A convenience translation of a root document must stay pinned to the English bytes it
//     was translated from. (INIT-011 S087/S088) The five READMEs are held current by the
//     badge and prose-version checks above; the smaller root docs each carry a synced-to pin
//     equal to the SHA-256 of their English source, so English can never move ahead of a
//     stale mirror without this failing closed. Coverage is declared in doc-coverage.json,
//     so a missing language is a failure rather than a silent gap, and the same CJK emphasis
//     rule runs over every mirror. LICENSE, NOTICE, CHANGELOG and SUPPORT are English-only by
//     policy and are listed there, not mirrored.
const coverage = JSON.parse(await read("scripts/policy/doc-coverage.json"));
for (const [source, spec] of Object.entries(coverage.sources)) {
  if (spec.kind !== "rootdoc") continue;
  const dot = source.lastIndexOf(".");
  const base = source.slice(0, dot);
  const ext = source.slice(dot + 1);
  const englishDigest = createHash("sha256").update(await readFile(resolve(repositoryRoot, source))).digest("hex");
  for (const language of coverage.languages) {
    const mirror = `${base}.${language}.${ext}`;
    let body;
    try { body = await read(mirror); } catch { fail("PUSH_GATE_TRANSLATION_MISSING", mirror); continue; }
    checkCjkEmphasis(mirror, body);
    if (!spec.pinned) continue;
    const pin = body.match(/<!--\s*tcrn-doc-synced-to:\s*(\S+)\s+([0-9a-f]{64})\s*-->/u);
    if (!pin) fail("PUSH_GATE_TRANSLATION_PIN_MISSING", mirror);
    else if (pin[1] !== source) fail("PUSH_GATE_TRANSLATION_PIN_SOURCE", `${mirror}: pins ${pin[1]}, expected ${source}`);
    else if (pin[2] !== englishDigest) fail("PUSH_GATE_TRANSLATION_PIN_STALE", `${mirror}: ${pin[2].slice(0, 12)} != ${englishDigest.slice(0, 12)}`);
  }
}

// 3. The two prose announcements of the version.
const changelog = await read("CHANGELOG.md");
if (!new RegExp(`^## ${P8_VERSION.replaceAll(".", "\\.")}\\b`, "mu").test(changelog)) {
  fail("PUSH_GATE_CHANGELOG_HEADING_MISSING", `no "## ${P8_VERSION}" heading`);
}
const releaseNote = await read(`docs/releases/${P8_VERSION}.md`).catch(() => null);
if (releaseNote === null) fail("PUSH_GATE_RELEASE_NOTE_MISSING", `docs/releases/${P8_VERSION}.md`);
else if (!releaseNote.includes(P8_VERSION)) fail("PUSH_GATE_RELEASE_NOTE_UNVERSIONED", `docs/releases/${P8_VERSION}.md`);

// 4. A tag names bytes, permanently. If this version is already tagged, HEAD must be that
//    commit or a descendant of it.
//
//    The first draft of this check demanded HEAD *equal* the tag, and it blocked the first
//    documentation fix landed after the release -- correctly refusing, for the wrong
//    reason. A tag marks a release; the branch goes on past it. What must never happen is
//    a push that contradicts a published tag: a HEAD on a different line of history, which
//    means the tag is about to be moved or has already been rewritten underneath. That is
//    an ancestry test, not equality.
//
//    Downstream makes the stakes concrete. The helper repository pins this one by commit,
//    tree, AND annotated tag object, so a moved tag does not merely confuse a reader -- it
//    invalidates another repository's compiled-in identity.
//
//    This check never proved a tag names *judged* bytes. Running the suites below before
//    every push is what does that; this proves only that the tag is not being contradicted.
const tag = `v${P8_VERSION}`;
const tagged = run("git", ["rev-list", "-n", "1", tag]);
if (tagged.ok) {
  const descends = run("git", ["merge-base", "--is-ancestor", tagged.output.trim(), "HEAD"]);
  if (!descends.ok) fail("PUSH_GATE_HEAD_CONTRADICTS_TAG", `HEAD does not descend from ${tag} (${tagged.output.trim().slice(0, 12)})`);
}

// 5-6. The gates themselves, in the order the plan fixes: p1 carries the pinned compiler
//      and the zero-warning rule, p8 carries the release identity and the reproducible
//      source archive. Both require a clean basis, which check 1 established.
//
//      guard-check is here rather than inside verify:p1 on purpose. Each registry entry
//      costs a build plus a test run, and ten entries measure ~107s; folded into P1 that
//      would push the wall clock at the 180s escalation trigger which exists to protect
//      the "run it on every change" discipline. Before a push is the right frequency for
//      a check that asks whether the proofs still bite.
for (const [reasonCode, script] of [
  ["PUSH_GATE_P1_FAILED", "verify:p1"],
  ["PUSH_GATE_P8_FAILED", "verify:p8"],
  ["PUSH_GATE_GUARDS_UNPROVEN", "guard-check"],
]) {
  const result = run("pnpm", ["run", "--silent", script]);
  if (!result.ok) fail(reasonCode, result.output.trim().split("\n").slice(-3).join(" | ").slice(0, 300));
  // G-2: a warning is an unfinished error. The reason-code vocabulary never uses the word,
  // so any occurrence is toolchain output that nothing has judged.
  else if (/\bwarning\b|\bWARN\b/u.test(result.output)) fail(reasonCode, `warning emitted: ${result.output.match(/.*\b(?:warning|WARN)\b.*/u)?.[0]?.slice(0, 200) ?? ""}`);
}

// A gate that rewrote tracked source has changed the bytes being pushed after they were
// judged, which defeats the point of judging them.
const post = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
if (post.ok && post.output.trim() !== "") fail("PUSH_GATE_GATES_MUTATED_SOURCE", post.output.trim().split("\n").slice(0, 5).join(" | "));

if (failures.length > 0) {
  process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: "PUSH_GATE_BLOCKED", failures }, null, 2)}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ ok: true, reasonCode: "PUSH_GATE_VERIFIED", version: P8_VERSION })}\n`);
