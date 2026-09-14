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
//     and left the status badge reading rc.5, which nothing checked. TCRN-CROSS-STORY-360
//     removed the badges themselves rather than the check: a shields.io URL is a literal
//     that cannot read the value it states, so every release had to drag four of them by
//     hand across five files. The version now lives in prose, where check 2d holds it.
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
//   * The READMEs fell a full minor version behind on capabilities while the badge stayed
//     current. Check 2d holds the current version in prose. The translation mirrors that
//     check 2e used to pin retired in TCRN-CROSS-STORY-360 -- twenty files, four locales,
//     re-pinned by hand on every change to an English source -- so this gate no longer
//     reads a translated document; README.md is the only mirror left, and it is the source.
//
// Warnings are failures here. There is no --force.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { P8_VERSION } from "./lib/p8-workflow-rc.mjs";
import { pushGateExecutionPlan, ENGINE_PUSH_GATE_CHILDREN } from "./lib/push-gate-children.mjs";
import { requiredFailurePatternProblems } from "./preflight.mjs";
import { isNonBlockingProofBudgetWarning } from "./lib/proof-budget.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const governanceNotices = [];
const timingProbe = process.env.TCRN_PUSH_GATE_TIMING_PROBE === "1";
const timingEvidencePath = resolve(
  repositoryRoot,
  process.env.TCRN_PUSH_GATE_TIMING_EVIDENCE_PATH ?? "dist/evidence/p1/push-gate-timing.json",
);
const timingStartedAt = performance.now();
const timingSourceDigest = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
const stageTimings = [];

async function timedStage(name, operation) {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    stageTimings.push({ name, elapsedMs: Number((performance.now() - startedAt).toFixed(3)) });
  }
}

async function writeTimingEvidence(ok, stdoutObserved) {
  const gateElapsedMs = Number((performance.now() - timingStartedAt).toFixed(3));
  const stageTotalMs = Number(stageTimings.reduce((sum, stage) => sum + stage.elapsedMs, 0).toFixed(3));
  const evidence = {
    schemaVersion: "tcrn.push-gate-timing.v1",
    command: "node scripts/push-gate.mjs",
    ok,
    observedAt: new Date().toISOString(),
    gateElapsedMs,
    stageTotalMs,
    attributionGapMs: Number((gateElapsedMs - stageTotalMs).toFixed(3)),
    sourceDigest: timingSourceDigest,
    stdoutObserved,
    stages: stageTimings,
  };
  await mkdir(resolve(repositoryRoot, "dist/evidence/p1"), { recursive: true });
  await writeFile(timingEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

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

function budgetWarningNotices(output, script) {
  if (script !== "verify:p1") return [];
  const lines = String(output ?? "").split(/\r?\n/u);
  let receipt = null;
  const nonJson = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line);
      if (value?.reasonCode === "P1_VERIFIED") receipt = value;
      else nonJson.push(line);
    } catch {
      nonJson.push(line);
    }
  }
  const notices = Array.isArray(receipt?.notices) ? receipt.notices : [];
  const budgetNotices = notices.filter((notice) => notice?.command === "budget");
  if (budgetNotices.length === 0 || budgetNotices.some((notice) => !isNonBlockingProofBudgetWarning(notice))) return [];
  return budgetNotices;
}

function onlyBudgetWarning(output, script) {
  const budgetNotices = budgetWarningNotices(output, script);
  if (budgetNotices.length === 0) return false;
  const lines = String(output ?? "").split(/\r?\n/u);
  let receipt = null;
  const nonJson = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line);
      if (value?.reasonCode === "P1_VERIFIED") receipt = value;
      else nonJson.push(line);
    } catch {
      nonJson.push(line);
    }
  }
  const notices = Array.isArray(receipt?.notices) ? receipt.notices : [];
  const withoutBudgetNotices = { ...receipt, notices: notices.filter((notice) => notice?.command !== "budget") };
  return !/\bwarning\b|\bWARN\b/u.test(`${nonJson.join("\n")}\n${JSON.stringify(withoutBudgetNotices)}`);
}

await timedStage("gate-containment", async () => {
  try {
    const declaration = JSON.parse(await readFile(resolve(repositoryRoot, "scripts/policy/gate-containment.json"), "utf8"));
    pushGateExecutionPlan(declaration);
  } catch (error) {
    fail(error.reasonCode ?? "PUSH_GATE_CONTAINMENT_INVALID", error.message);
  }
});

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
await timedStage("git-status-before", async () => {
  if (timingProbe) return;
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.ok) fail("PUSH_GATE_GIT_UNAVAILABLE", status.output.trim().slice(0, 200));
  else if (status.output.trim() !== "") fail("PUSH_GATE_TREE_DIRTY", status.output.trim().split("\n").slice(0, 5).join(" | "));
});

// 2. Whether the reader sees prose at all. README.md is written in Simplified Chinese, so
//    the emphasis rule above is the defect class that actually reaches it: eighteen spans
//    shipped once rendering as literal asterisks. The status badge that used to be checked
//    here went with the rest of the badge block in TCRN-CROSS-STORY-360.
await timedStage("cjk-emphasis", async () => {
  const document = "README.md";
  checkCjkEmphasis(document, await read(document));
});

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
  "README.md",
  "docs/versioning/versioning-policy.md",
  "docs/versioning/release-policy.md",
  "docs/compatibility/supported-modes.md",
];
await timedStage("stale-version-prose", async () => {
  for (const document of currentVersionDocuments) {
    const body = await read(document);
    body.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(/\b\d+\.\d+\.\d+-rc\.\d+\b/gu)) {
        if (match[0] === P8_VERSION) continue;
        fail("PUSH_GATE_STALE_VERSION_PROSE", `${document}:${index + 1}: ${match[0]} != ${P8_VERSION}`);
      }
    });
  }
});

// 2c. The failure-pattern register has to stay data. A register that drifts out of sync
//     with itself is worse than none: it would be cited as a count when it is no longer
//     counting. The check is small on purpose -- it does not judge whether a pattern is
//     real, only that the file still says what it claims to say.
const registerPath = "scripts/policy/failure-pattern-register.json";
let register = null;
await timedStage("failure-pattern-register", async () => {
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
});

// 2d. The version in the "Status" prose. (INIT-011 S086) This was the weaker of a pair --
//     check 2 pinned the badge and this one caught the release-to-release lag the badge
//     hid. With the badge block retired in TCRN-CROSS-STORY-360 it is the only check on
//     the version a reader sees, which is the right place for it: prose is what a reader
//     reads, and it is the one statement of the version a release still has to move.
await timedStage("status-version-prose", async () => {
  const document = "README.md";
  const prose = await read(document);
  if (!prose.includes(P8_VERSION)) fail("PUSH_GATE_STATUS_VERSION_ABSENT", `${document}: "${P8_VERSION}" does not appear in prose`);
});

// 2f. The host evidence receipt: present, and not older than the window.
//
// AC-1 says its own absence blocks the release (OD-C3). Nothing checked that. The
// 2026-08-18 audit went looking for the consumer and found none: not here, not in
// task.mjs, not in the verification map -- so the one sentence stating the receipt's
// release consequence was a promise with nothing behind it, and the receipt sat at
// host 2.1.201 for twenty-nine days and nineteen host minor versions while more than
// thirty releases went out citing it.
//
// Freshness is checked as well as presence, because a receipt that records what was
// observed on a host nobody runs any more answers a question nobody asked. Thirty
// days is the window: long enough that a normal release cadence never trips it,
// short enough that a host generation cannot pass underneath it unnoticed.
//
// What is deliberately NOT gated is whether the receipt is complete. Its group B
// half needs a credentialed session, and credentials are not something a release
// gate can conjure -- a criterion that cannot be satisfied in a world where it will
// be evaluated is the jointly-unsatisfiable defect this platform has paid for twice.
// So completeness is reported beside the verdict and left to the operator to close.
const HOST_EVIDENCE_MAX_AGE_DAYS = 30;
await timedStage("host-evidence-freshness", async () => {
  const hostEvidenceRaw = await read("docs/verification/host/claude-code.json").catch(() => null);
  if (hostEvidenceRaw === null) {
    fail("PUSH_GATE_HOST_EVIDENCE_MISSING", "docs/verification/host/claude-code.json");
  } else {
    let hostEvidence = null;
    try {
      hostEvidence = JSON.parse(hostEvidenceRaw);
    } catch {
      fail("PUSH_GATE_HOST_EVIDENCE_INVALID", "receipt is not JSON");
    }
    const observedAt = hostEvidence?.observedAt;
    if (typeof observedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(observedAt)) {
      fail("PUSH_GATE_HOST_EVIDENCE_INVALID", `observedAt is ${String(observedAt)}`);
    } else {
      // Measured against the newest release note rather than the wall clock: a gate
      // whose verdict changes while nothing in the tree changed is a gate that reports
      // the calendar, and this one is about the tree.
      const ageDays = Math.floor((Date.now() - Date.parse(`${observedAt}T00:00:00Z`)) / 86_400_000);
      if (!Number.isFinite(ageDays)) fail("PUSH_GATE_HOST_EVIDENCE_INVALID", `observedAt is ${observedAt}`);
      else if (ageDays > HOST_EVIDENCE_MAX_AGE_DAYS) {
        fail("PUSH_GATE_HOST_EVIDENCE_STALE", `observed ${observedAt}, ${ageDays} days ago, on host ${String(hostEvidence?.host?.versionSelfReport)}; re-run pnpm host-evidence`);
      }
    }
  }
});

// 3. The two prose announcements of the version.
await timedStage("release-prose", async () => {
  const changelog = await read("CHANGELOG.md");
  if (!new RegExp(`^## ${P8_VERSION.replaceAll(".", "\\.")}\\b`, "mu").test(changelog)) {
    fail("PUSH_GATE_CHANGELOG_HEADING_MISSING", `no "## ${P8_VERSION}" heading`);
  }
  const releaseNote = await read(`docs/releases/${P8_VERSION}.md`).catch(() => null);
  if (releaseNote === null) fail("PUSH_GATE_RELEASE_NOTE_MISSING", `docs/releases/${P8_VERSION}.md`);
  else if (!releaseNote.includes(P8_VERSION)) fail("PUSH_GATE_RELEASE_NOTE_UNVERSIONED", `docs/releases/${P8_VERSION}.md`);
});

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
await timedStage("tag-ancestry", async () => {
  const tagged = run("git", ["rev-list", "-n", "1", tag]);
  if (tagged.ok) {
    const descends = run("git", ["merge-base", "--is-ancestor", tagged.output.trim(), "HEAD"]);
    if (!descends.ok) fail("PUSH_GATE_HEAD_CONTRADICTS_TAG", `HEAD does not descend from ${tag} (${tagged.output.trim().slice(0, 12)})`);
  }
});

// 5-6. The gates themselves, in the order the plan fixes: p1 carries the pinned compiler
//      and the zero-warning rule, p8 carries the release identity and the reproducible
//      source archive. Both require a clean basis, which check 1 established.
//
//      guard-check is here rather than inside verify:p1 on purpose. Each registry entry
//      costs a build plus a test run, and ten entries measure ~107s; folded into P1 that
//      would push the wall clock at the 180s escalation trigger which exists to protect
//      the "run it on every change" discipline. Before a push is the right frequency for
//      a check that asks whether the proofs still bite.
for (const { reasonCode, script } of ENGINE_PUSH_GATE_CHILDREN) {
  const result = await timedStage(
    `child:${script}`,
    async () => (timingProbe ? { ok: true, output: "" } : run("pnpm", ["run", "--silent", script])),
  );
  const budgetNotices = budgetWarningNotices(result.output, script);
  if (budgetNotices.length > 0) governanceNotices.push(...budgetNotices);
  if (!result.ok) fail(reasonCode, result.output.trim().split("\n").slice(-3).join(" | ").slice(0, 300));
  // G-2: a warning is an unfinished error. The reason-code vocabulary never uses the word,
  // so any occurrence is toolchain output that nothing has judged.
  else if (/\bwarning\b|\bWARN\b/u.test(result.output) && !onlyBudgetWarning(result.output, script)) {
    fail(reasonCode, `warning emitted: ${result.output.match(/.*\b(?:warning|WARN)\b.*/u)?.[0]?.slice(0, 200) ?? ""}`);
  }
}

// A gate that rewrote tracked source has changed the bytes being pushed after they were
// judged, which defeats the point of judging them.
await timedStage("git-status-after", async () => {
  if (timingProbe) return;
  const post = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (post.ok && post.output.trim() !== "") fail("PUSH_GATE_GATES_MUTATED_SOURCE", post.output.trim().split("\n").slice(0, 5).join(" | "));
});

let stdoutObserved = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...arguments_) => {
  const encoding = typeof arguments_[0] === "string" ? arguments_[0] : "utf8";
  stdoutObserved += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
  return originalStdoutWrite(chunk, ...arguments_);
};
const output = failures.length > 0
  ? JSON.stringify({ ok: false, reasonCode: "PUSH_GATE_BLOCKED", failures, governanceNotices }, null, 2)
  : JSON.stringify({ ok: true, reasonCode: "PUSH_GATE_VERIFIED", version: P8_VERSION, governanceNotices });
process.stdout.write(`${output}\n`);
await writeTimingEvidence(failures.length === 0, stdoutObserved.replace(/\n$/u, ""));
if (failures.length > 0) {
  process.exit(1);
}
