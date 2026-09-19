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
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { P8_VERSION } from "./lib/p8-workflow-rc.mjs";
import { pushGateExecutionPlan, ENGINE_PUSH_GATE_CHILDREN } from "./lib/push-gate-children.mjs";
import { requiredFailurePatternProblems } from "./preflight.mjs";
import { budgetWarningNotices, hasWarningOrError, inspectStructuredChildOutput, onlyBudgetWarning, validateHostEvidenceProvenance, validateStructuredChildExpectations } from "./lib/push-gate-output.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const governanceNotices = [];
const childResults = [];
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

function fail(reasonCode, detail, diagnostic = undefined) {
  failures.push({ reasonCode, detail, ...(diagnostic === undefined ? {} : { diagnostic }) });
}

function read(relativePath) {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

function run(command, argv) {
  const result = spawnSync(command, argv, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) return { ok: false, output: String(result.error.message) };
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  return { ok: result.status === 0, stdout, stderr, output: `${stdout}${stderr}` };
}

// `git rev-parse` writes the commit followed by a line feed.  The child
// expectation schema is intentionally strict (exactly one lower-case SHA-1),
// so normalize the command's successful stdout at this boundary while keeping
// malformed, multiline, failed, or stderr-bearing output fail-closed.
function normalizedCommitOutput(result) {
  if (!result?.ok || result.stderr !== "") return undefined;
  const value = String(result.stdout ?? "").trim();
  return /^[a-f0-9]{40}$/u.test(value) ? value : undefined;
}

function runChild(command, argv) {
  const result = spawnSync(command, argv, { cwd: repositoryRoot, encoding: null, maxBuffer: 256 * 1024 * 1024 });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
  return {
    ok: result.error === undefined && result.status === 0,
    command: [command, ...argv],
    cwd: repositoryRoot,
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    error: result.error ? { name: result.error.name, code: result.error.code, message: result.error.message } : null,
    stdout,
    stderr,
    output: `${stdout.toString("utf8")}${stderr.toString("utf8")}`,
  };
}

async function retainChildOutput(script, result, assessment) {
  const runId = new Date().toISOString().replace(/[^0-9A-Za-z]/gu, "-");
  const directory = resolve(repositoryRoot, "dist/evidence/push-gate-children", runId);
  await mkdir(directory, { recursive: true });
  const safeScript = script.replace(/[^0-9A-Za-z._-]/gu, "-");
  const base = resolve(directory, safeScript);
  const stdoutPath = `${base}.stdout`;
  const stderrPath = `${base}.stderr`;
  const exitPath = `${base}.exit.json`;
  const exit = { status: result.exitCode, signal: result.signal, error: result.error };
  await writeFile(stdoutPath, result.stdout, { mode: 0o600 });
  await writeFile(stderrPath, result.stderr, { mode: 0o600 });
  await writeFile(exitPath, `${JSON.stringify(exit)}\n`, { mode: 0o600 });
  const entry = {
    script,
    command: result.command,
    cwd: result.cwd,
    exit,
    stdout: { path: relative(repositoryRoot, stdoutPath), bytes: result.stdout.length, sha256: createHash("sha256").update(result.stdout).digest("hex") },
    stderr: { path: relative(repositoryRoot, stderrPath), bytes: result.stderr.length, sha256: createHash("sha256").update(result.stderr).digest("hex") },
    exitRecord: { path: relative(repositoryRoot, exitPath), bytes: Buffer.byteLength(`${JSON.stringify(exit)}\n`), sha256: createHash("sha256").update(`${JSON.stringify(exit)}\n`).digest("hex") },
    assessment,
  };
  await writeFile(`${base}.json`, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  return entry;
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

// 2f. The host evidence receipt: present, and provably not re-presented as current.
//
// AC-1 says its own absence blocks the release (OD-C3); that is still checked below.
// The thirty-day freshness window this stage used to keep (added c5d58ca, 2026-08-19)
// is gone: its producer, scripts/host-evidence.mjs, was deleted by TCRN-CROSS-STORY-358
// (commit 84c318c, 2026-09-06) along with the adapter install/activate/remove path it
// observed, so the window's only remediation stopped existing eighteen days before the
// window itself expired -- and then reported a calendar, not the tree, exactly what this
// comment used to say the stage would not do (TCRN-CROSS-INC-328 / TCRN-CROSS-MIN-204 D1).
// Live evidence for the surface that still exists is platform-doctor's harness leg,
// which checks the installed container rather than a dated file. What this stage still
// refuses is a receipt silently re-presented as a current claim: it must name what
// superseded it and say so in a field nothing but a human edit can satisfy honestly.
await timedStage("host-evidence-provenance", async () => {
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
    const validation = validateHostEvidenceProvenance(hostEvidence);
    if (!validation.ok) fail(validation.reasonCode, validation.detail);
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
let childExpectations = { sourceFiles: undefined, guardIds: undefined };
let childExpectationsFailure = null;
try {
  const sourcePolicy = JSON.parse(await read("scripts/policy/source-allowlist.json"));
  const guardRegistry = JSON.parse(await read("scripts/policy/guard-registry.json"));
  const currentHead = run("git", ["rev-parse", "HEAD"]);
  const validated = validateStructuredChildExpectations({
    sourceFiles: sourcePolicy?.allowedFiles,
    guardIds: Array.isArray(guardRegistry?.guards) ? guardRegistry.guards.map((guard) => guard?.id) : undefined,
    p8BasisCommit: normalizedCommitOutput(currentHead),
  });
  if (!validated.ok) {
    childExpectationsFailure = { reasonCode: validated.reasonCode, findings: validated.findings };
    fail("PUSH_GATE_CHILD_SCHEMA_EXPECTATIONS_INVALID", "current source/guard schema cannot authorize P8/guard terminal parsing", {
      code: validated.reasonCode,
      location: "scripts/policy/source-allowlist.json|scripts/policy/guard-registry.json|git rev-parse HEAD",
      findings: validated.findings,
    });
  } else {
    childExpectations = { sourceFiles: validated.sourceFiles, guardIds: validated.guardIds, p8BasisCommit: validated.p8BasisCommit };
  }
} catch (error) {
  childExpectationsFailure = {
    reasonCode: error?.reasonCode ?? "CHILD_SCHEMA_EXPECTATIONS_UNREADABLE",
    location: "scripts/policy/source-allowlist.json|scripts/policy/guard-registry.json",
    message: String(error?.message ?? error),
  };
  fail("PUSH_GATE_CHILD_SCHEMA_EXPECTATIONS_UNREADABLE", "source/guard schema preflight failed before P8/guard children", childExpectationsFailure);
}

for (const { reasonCode, script } of ENGINE_PUSH_GATE_CHILDREN) {
  if (script !== "verify:p1" && childExpectationsFailure !== null) {
    childResults.push({
      script,
      command: ["pnpm", "run", "--silent", script],
      cwd: repositoryRoot,
      exit: { status: null, signal: null, error: null },
      stdout: { path: null, bytes: 0, sha256: null },
      stderr: { path: null, bytes: 0, sha256: null },
      notStarted: true,
      assessment: { ok: false, reasonCode: "CHILD_PREFLIGHT_BLOCKED", findings: [childExpectationsFailure] },
    });
    continue;
  }
  const result = await timedStage(
    `child:${script}`,
    async () => (timingProbe
      ? { ok: true, command: ["pnpm", "run", "--silent", script], cwd: repositoryRoot, exitCode: 0, signal: null, error: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: "" }
      : runChild("pnpm", ["run", "--silent", script])),
  );
  const budgetNotices = budgetWarningNotices(result.output, script);
  if (budgetNotices.length > 0) governanceNotices.push(...budgetNotices);
  const p1Diagnostic = script === "verify:p1"
    && hasWarningOrError(result.output, script)
    && !onlyBudgetWarning(result.output, script);
  const assessment = timingProbe
    ? { ok: true, reasonCode: "TIMING_PROBE_SYNTHETIC_OUTPUT", findings: [] }
    : script === "verify:p1"
      ? { ok: !p1Diagnostic, reasonCode: p1Diagnostic ? "P1_DIAGNOSTIC_PRESENT" : "P1_WARNING_RULE_CLEAR", findings: p1Diagnostic ? [{ code: "P1_DIAGNOSTIC_PRESENT", location: "$.stdout|$.stderr" }] : [] }
      : inspectStructuredChildOutput({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, signal: result.signal }, script, childExpectations);
  const retained = await retainChildOutput(script, result, assessment);
  childResults.push(retained);
  if (!result.ok) fail(reasonCode, `child exit ${result.exitCode}${result.signal ? ` signal ${result.signal}` : ""}`, {
    code: "PUSH_GATE_CHILD_EXIT_NONZERO",
    location: "$.exit",
    rawOutput: retained,
  });
  // G-2: a warning is an unfinished error. The reason-code vocabulary never uses the word,
  // so any occurrence is toolchain output that nothing has judged.
  else if (p1Diagnostic) {
    fail(reasonCode, `warning emitted: ${result.output.match(/.*\b(?:warning|WARN)\b.*/u)?.[0]?.slice(0, 200) ?? ""}`, {
      code: "PUSH_GATE_P1_DIAGNOSTIC",
      location: "$.stdout|$.stderr",
      rawOutput: retained,
    });
  } else if (script !== "verify:p1" && !assessment.ok) {
    fail(reasonCode, `child output rejected: ${assessment.reasonCode}`, {
      code: assessment.reasonCode,
      findings: assessment.findings,
      rawOutput: retained,
    });
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
const noticeFields = governanceNotices.length === 0 ? {} : { governanceNotices };
const output = failures.length > 0
  ? JSON.stringify({ ok: false, reasonCode: "PUSH_GATE_BLOCKED", failures, childResults, ...noticeFields }, null, 2)
  : JSON.stringify({ ok: true, reasonCode: "PUSH_GATE_VERIFIED", version: P8_VERSION, childResults, ...noticeFields });
process.stdout.write(`${output}\n`);
await writeTimingEvidence(failures.length === 0, stdoutObserved.replace(/\n$/u, ""));
if (failures.length > 0) {
  process.exit(1);
}
