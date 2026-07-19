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
// Warnings are failures here. There is no --force.

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { P8_VERSION } from "./lib/p8-workflow-rc.mjs";

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
const punctuation = /[\p{P}\p{S}]/u;
const whitespace = /\s/u;
for (const document of ["README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md", "README.fr.md"]) {
  const body = await read(document);
  const published = [...body.matchAll(/status-([0-9][^-\s)]*(?:--[^-\s)]+)*)-blue/gu)].map((match) => match[1]);
  if (published.length === 0) fail("PUSH_GATE_STATUS_BADGE_MISSING", document);
  else if (!published.every((value) => value === badgeVersion)) fail("PUSH_GATE_STATUS_BADGE_STALE", `${document}: ${published.join(", ")} != ${badgeVersion}`);

  // A closing `**` must be right-flanking: not preceded by whitespace, and -- when
  // preceded by punctuation -- followed by whitespace or punctuation. CJK prose walks
  // into that rule constantly, because `**一句话。**下一句` puts an ideographic full stop
  // before the delimiter and a letter after it. The span never closes and the reader gets
  // four asterisks. Latin text rarely trips it, which is exactly why it went unnoticed:
  // the English original was always fine.
  body.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/\*\*([^*]+)\*\*/gu)) {
      const closeAt = match.index + match[0].length - 2;
      const before = line[closeAt - 1];
      const after = line[closeAt + 2];
      if (before === undefined || whitespace.test(before) || !punctuation.test(before)) continue;
      if (after === undefined || whitespace.test(after) || punctuation.test(after)) continue;
      fail("PUSH_GATE_EMPHASIS_UNCLOSED", `${document}:${index + 1}: ${match[0].slice(0, 40)}`);
    }
  });
}

// 3. The two prose announcements of the version.
const changelog = await read("CHANGELOG.md");
if (!new RegExp(`^## ${P8_VERSION.replaceAll(".", "\\.")}\\b`, "mu").test(changelog)) {
  fail("PUSH_GATE_CHANGELOG_HEADING_MISSING", `no "## ${P8_VERSION}" heading`);
}
const releaseNote = await read(`docs/releases/${P8_VERSION}.md`).catch(() => null);
if (releaseNote === null) fail("PUSH_GATE_RELEASE_NOTE_MISSING", `docs/releases/${P8_VERSION}.md`);
else if (!releaseNote.includes(P8_VERSION)) fail("PUSH_GATE_RELEASE_NOTE_UNVERSIONED", `docs/releases/${P8_VERSION}.md`);

// 4. A tag names bytes. If this version is already tagged, the tag must name the bytes
//    being pushed -- otherwise the push either contradicts a published tag or is about to
//    be tagged over one.
const tag = `v${P8_VERSION}`;
const tagged = run("git", ["rev-list", "-n", "1", tag]);
if (tagged.ok) {
  const head = run("git", ["rev-parse", "HEAD"]);
  if (!head.ok) fail("PUSH_GATE_GIT_UNAVAILABLE", "HEAD");
  else if (head.output.trim() !== tagged.output.trim()) fail("PUSH_GATE_TAG_DISAGREES_WITH_HEAD", `${tag} -> ${tagged.output.trim().slice(0, 12)}, HEAD ${head.output.trim().slice(0, 12)}`);
}

// 5-6. The gates themselves, in the order the plan fixes: p1 carries the pinned compiler
//      and the zero-warning rule, p8 carries the release identity and the reproducible
//      source archive. Both require a clean basis, which check 1 established.
for (const [reasonCode, script] of [
  ["PUSH_GATE_P1_FAILED", "verify:p1"],
  ["PUSH_GATE_P8_FAILED", "verify:p8"],
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
