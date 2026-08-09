// SPDX-License-Identifier: Apache-2.0
// F4 (INIT-018 QA) — exit-code proof for scripts/verify-otel-privacy.mjs.
//
// The defect this file exists to prevent: the sink guard was bypassable. With no
// --sink, `resolve("")` returned the current working directory, `existsSync(dir)`
// was true, and the script died on EISDIR inside readFileSync — a bare stack trace
// instead of a verdict. A privacy guard that cannot read its subject must SAY so.
//
// The contract under test is the three-way outcome, and the three sides must stay
// distinguishable — that is the whole point:
//   exit 0  the sink was read and carries only allowed label keys   (clean)
//   exit 1  the sink was read and leaks something                   (violation)
//   exit 2  the sink was NOT read, so nothing was established       (could-not-judge)
// A could-not-judge is never a pass. Collapsing 2 into 0 would make the guard lie;
// collapsing 2 into 1 would report a leak that was never observed.
//
// Following the INC-037 pattern the suite carries its own red rather than asserting
// green and hoping. Two kinds of mutation run against throw-away copies:
//
//   1. REGRESSION — all three edits of the F4 fix reverted at once, which must bring
//      the bare EISDIR crash back. One edit alone does NOT: the fix is three
//      independent layers (ask before resolving · statSync().isFile() · a guarded
//      read) and each one on its own still refuses. That was measured, not assumed —
//      the first draft of this file asserted per-layer breakage and failed, because
//      a downstream layer caught every case.
//   2. LAYER_DIAGNOSIS — one layer removed at a time, asserting the *reason code*
//      moves to the next layer's. That is what proves no layer is dead code: each is
//      load-bearing for a precise diagnosis even though the exit code is shared.
//
// R2 adds three more defects of the same family, each with its own layer and its own
// red. They are all cases of the guard answering a question it had not asked:
//
//   3. RECORD SHAPE — a line that is valid JSON but not an object. `null` reached
//      Object.keys() outside any try and died with a bare TypeError; Node exits 1 on
//      an uncaught throw, and 1 is precisely "I read the sink and it leaks". The
//      guard therefore reported a privacy violation it had never observed. `42` went
//      the other way: Object.keys(42) is [], so an unaccounted record was certified
//      CLEAN at exit 0. Both directions are proven below against the real bytes.
//   4. TRUNCATION — process.stdout.write() followed by process.exit() drops whatever
//      is still buffered, because stdout on a POSIX pipe is asynchronous. The report
//      the consumer most needs to read — a large one — arrived as invalid JSON. The
//      same hazard sat on the refusal path, where an over-long --sink value is echoed
//      back into the payload.
//   5. VACUOUS PASS — a sink with no records answered PRIVACY_SINK_CLEAN. Nothing was
//      observed, so nothing was established; that is exit 2's job.
//
// Run: node --test tests/otel-privacy-guard.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Pointing this at another copy is how the red side gets demonstrated by hand:
// OTEL_PRIVACY_SOURCE=<pre-fix copy> node --test tests/otel-privacy-guard.test.mjs
const SOURCE_PATH = process.env.OTEL_PRIVACY_SOURCE ?? resolve(HERE, "../scripts/verify-otel-privacy.mjs");

const CLEAN_CEREMONY = JSON.stringify({
  span: "ceremony.end",
  at: "2026-08-05T00:00:00Z",
  partition: "TCRN-AOS",
  verb: "work-show",
  expectedVersion: 1044,
  outcome: "ok",
  reasonCode: "WORKSPACE_COMMAND_COMPLETED",
});
// A label key that is not on the ceremony allowlist. This is the leak the guard
// exists to catch: chain bytes riding out of the control tree on a telemetry span.
const LEAKING_CEREMONY = JSON.stringify({
  span: "ceremony.end",
  at: "2026-08-05T00:00:00Z",
  partition: "TCRN-AOS",
  verb: "work-show",
  outcome: "ok",
  payload: { scope: "chain bytes that must never reach a sink" },
});

// The three edits that, applied together, restore the pre-F4 guard. Anchors are
// asserted to occur exactly once so a refactor cannot silently retire a proof.
const LAYERS = {
  askBeforeResolving: {
    anchor:
      'if (sinkArgument === undefined || sinkArgument.trim() === "") {\n' +
      '  couldNotJudge("PRIVACY_SINK_NOT_SPECIFIED", { detail: "pass --sink <path to the span JSONL sink>" });\n' +
      "}\n" +
      "const sink = resolve(sinkArgument);",
    replacement: 'const sink = resolve(sinkArgument ?? "");',
  },
  rejectNonFile: {
    anchor: "if (!stats?.isFile()) {",
    replacement: "if (false) {",
  },
  guardedRead: {
    anchor:
      "let text;\n" +
      "try {\n" +
      '  text = readFileSync(sink, "utf8");\n' +
      "} catch (error) {\n" +
      '  couldNotJudge("PRIVACY_SINK_UNREADABLE", { sink, detail: String(error.message) });\n' +
      "}",
    replacement: 'const text = readFileSync(sink, "utf8");',
  },
  // R2 layers. Each replacement is the pre-R2 byte sequence, so a mutant carrying it
  // is the shipped-and-broken guard rather than an invented one.
  rejectNonObject: {
    anchor:
      "  const shape = jsonShape(value);\n" +
      '  if (shape !== "object") {\n' +
      '    violations.push({ line: line.slice(0, 120), why: "not-an-object", jsonType: shape });\n' +
      "    continue;\n" +
      "  }\n",
    replacement: "",
  },
  rejectEmptySink: {
    anchor:
      "if (records === 0) {\n" +
      '  couldNotJudge("PRIVACY_SINK_EMPTY", {\n' +
      "    sink,\n" +
      "    kind,\n" +
      "    blankLines,\n" +
      '    detail: "the sink carries no records — nothing was observed, so nothing is established",\n' +
      "  });\n" +
      "}\n\n",
    replacement: "",
  },
  exitAfterWrite: {
    anchor: "process.exitCode = report.ok ? 0 : 1;",
    replacement: "process.exit(report.ok ? 0 : 1);",
  },
  clampRefusal: {
    anchor: "  const bounded = Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, clampField(value)]));",
    replacement: "  const bounded = extra;",
  },
};

// Every JSON value that is not an object, plus a line that is not JSON at all. The
// point of enumerating the whole set rather than sampling it: totality is the claim.
const NON_OBJECT_RECORDS = [
  { name: "null", line: "null", jsonType: "null" },
  { name: "a number", line: "42", jsonType: "number" },
  { name: "a string", line: '"chain bytes riding in as a bare string"', jsonType: "string" },
  { name: "a boolean", line: "true", jsonType: "boolean" },
  { name: "an array", line: '["chain","bytes"]', jsonType: "array" },
];

// Big enough that the serialized report clears the 64 KiB pipe buffer several times
// over — the pre-R2 guard truncated at 302 violations.
const BULK_VIOLATIONS = 450;

let workdir;
let cleanSink;
let leakingSink;
let unreadableSink;
let emptySink;
let blankOnlySink;
let mixedSink;
let bulkSink;
let unreadableIsActuallyUnreadable = false;
let sourceText;

before(async () => {
  workdir = await mkdtemp(join(tmpdir(), "otel-privacy-guard-"));
  cleanSink = join(workdir, "clean.jsonl");
  leakingSink = join(workdir, "leaking.jsonl");
  unreadableSink = join(workdir, "unreadable.jsonl");
  emptySink = join(workdir, "empty.jsonl");
  blankOnlySink = join(workdir, "blank-only.jsonl");
  mixedSink = join(workdir, "mixed.jsonl");
  bulkSink = join(workdir, "bulk.jsonl");
  await writeFile(cleanSink, `${CLEAN_CEREMONY}\n`, "utf8");
  await writeFile(leakingSink, `${CLEAN_CEREMONY}\n${LEAKING_CEREMONY}\n`, "utf8");
  await writeFile(unreadableSink, `${CLEAN_CEREMONY}\n`, "utf8");
  await writeFile(emptySink, "", "utf8");
  await writeFile(blankOnlySink, "\n\n   \n\t\n", "utf8");
  // One of each thing a line can be, in one file, so the report's own arithmetic can
  // be checked: records must equal cleanRecords plus the violations listed.
  await writeFile(
    mixedSink,
    [CLEAN_CEREMONY, "", "   ", "not json at all", "null", "42", LEAKING_CEREMONY, ""].join("\n"),
    "utf8",
  );
  await writeFile(
    bulkSink,
    `${Array.from({ length: BULK_VIOLATIONS }, (unused, index) =>
      JSON.stringify({
        span: "ceremony.end",
        at: "2026-08-05T00:00:00Z",
        partition: "TCRN-AOS",
        verb: "work-show",
        outcome: "ok",
        payload: { index, chain: "x".repeat(80) },
      }),
    ).join("\n")}\n`,
    "utf8",
  );
  await chmod(unreadableSink, 0o000);
  // Running as root defeats mode bits. Measure rather than assume, so the EACCES
  // proof reports itself as inapplicable instead of failing for the wrong reason.
  try {
    await readFile(unreadableSink, "utf8");
  } catch {
    unreadableIsActuallyUnreadable = true;
  }
  sourceText = await readFile(SOURCE_PATH, "utf8");
});

after(async () => {
  if (unreadableSink) await chmod(unreadableSink, 0o600).catch(() => {});
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

// Runs the guard from a directory that is NOT a sink directory, so a cwd-shaped bug
// cannot accidentally land on a real sink and look healthy.
function runGuard(argv, { script = SOURCE_PATH } = {}) {
  const result = spawnSync(process.execPath, [script, ...argv], { cwd: workdir, encoding: "utf8" });
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = null;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, report };
}

function assertAnchorUnique(name, anchor) {
  const occurrences = sourceText.split(anchor).length - 1;
  assert.equal(
    occurrences,
    1,
    `anchor for layer "${name}" must appear exactly once, found ${occurrences} — a refactor retired this proof silently`,
  );
}

async function writeMutant(id, layerNames) {
  let mutated = sourceText;
  for (const name of layerNames) {
    const { anchor, replacement } = LAYERS[name];
    assertAnchorUnique(name, anchor);
    mutated = mutated.replace(anchor, replacement);
  }
  const mutantPath = join(workdir, `mutant-${id}.mjs`);
  await writeFile(mutantPath, mutated, "utf8");
  return mutantPath;
}

// ---------------------------------------------------------------------------
// Green: the three outcomes are three distinguishable answers.
// ---------------------------------------------------------------------------
const COULD_NOT_JUDGE = [
  { name: "no arguments at all", argv: [], reasonCode: "PRIVACY_SINK_NOT_SPECIFIED" },
  { name: "--sink with an empty value", argv: ["--sink", ""], reasonCode: "PRIVACY_SINK_NOT_SPECIFIED" },
  { name: "--sink pointing at nothing", argv: ["--sink", "/nonexistent/no-such-sink.jsonl"], reasonCode: "PRIVACY_SINK_MISSING" },
  { name: "--sink pointing at a directory", argv: ["--sink", "."], reasonCode: "PRIVACY_SINK_NOT_A_FILE" },
];

for (const scenario of COULD_NOT_JUDGE) {
  test(`could-not-judge: ${scenario.name} → exit 2 + ${scenario.reasonCode}`, () => {
    const run = runGuard(scenario.argv);
    assert.equal(run.status, 2, `expected exit 2, got ${run.status}; stderr=${run.stderr}`);
    assert.ok(run.report, `expected a JSON report on stdout, got: ${run.stdout || run.stderr}`);
    assert.equal(run.report.reasonCode, scenario.reasonCode);
    assert.equal(run.report.ok, false);
    assert.equal(run.report.verdict, "could-not-judge");
    // A bare stack trace is exactly the F4 defect.
    assert.equal(run.stderr, "", "a reason-coded refusal must not also print a stack trace");
  });
}

test("could-not-judge: an unreadable regular file → exit 2 + PRIVACY_SINK_UNREADABLE", (t) => {
  if (!unreadableIsActuallyUnreadable) {
    t.skip("mode bits do not deny this process (running as root?) — EACCES not exercisable here");
    return;
  }
  const run = runGuard(["--sink", unreadableSink]);
  assert.equal(run.status, 2, `expected exit 2, got ${run.status}; stderr=${run.stderr}`);
  assert.equal(run.report.reasonCode, "PRIVACY_SINK_UNREADABLE");
  assert.equal(run.report.verdict, "could-not-judge");
  assert.equal(run.stderr, "");
});

test("could-not-judge: an unknown --kind → exit 2 + PRIVACY_UNKNOWN_KIND", () => {
  const run = runGuard(["--sink", cleanSink, "--kind", "not-a-kind"]);
  assert.equal(run.status, 2);
  assert.equal(run.report.reasonCode, "PRIVACY_UNKNOWN_KIND");
  assert.equal(run.report.verdict, "could-not-judge");
});

test("clean: a sink carrying only allowed label keys → exit 0 + PRIVACY_SINK_CLEAN", () => {
  const run = runGuard(["--sink", cleanSink, "--kind", "ceremony"]);
  assert.equal(run.status, 0, `expected exit 0, got ${run.status}; stderr=${run.stderr}`);
  assert.equal(run.report.reasonCode, "PRIVACY_SINK_CLEAN");
  assert.equal(run.report.verdict, "clean");
  assert.equal(run.report.ok, true);
  assert.equal(run.report.records, 1);
  assert.deepEqual(run.report.violations, []);
});

test("violation: a sink carrying a payload key → exit 1 + PRIVACY_SINK_VIOLATION naming it", () => {
  const run = runGuard(["--sink", leakingSink, "--kind", "ceremony"]);
  assert.equal(run.status, 1, `expected exit 1, got ${run.status}; stderr=${run.stderr}`);
  assert.equal(run.report.reasonCode, "PRIVACY_SINK_VIOLATION");
  assert.equal(run.report.verdict, "violation");
  assert.equal(run.report.ok, false);
  assert.equal(run.report.records, 2);
  assert.equal(run.report.violations.length, 1);
  assert.deepEqual(run.report.violations[0].extra, ["payload"]);
});

// The narrower --kind must actually be narrower, otherwise "kind" is decoration:
// a ceremony-shaped record carries partition/expectedVersion, which the verb
// allowlist does not permit.
test("the two kinds have genuinely different allowlists", () => {
  const asCeremony = runGuard(["--sink", cleanSink, "--kind", "ceremony"]);
  const asVerb = runGuard(["--sink", cleanSink, "--kind", "verb"]);
  assert.equal(asCeremony.status, 0);
  assert.equal(asVerb.status, 1, "the same record must not be clean under both kinds");
  assert.deepEqual(asVerb.report.violations[0].extra.sort(), ["expectedVersion", "partition"]);
});

// ---------------------------------------------------------------------------
// Red 1 — the F4 regression itself. All three layers reverted brings the crash back.
// ---------------------------------------------------------------------------
test("red proof: reverting all three layers restores the bare EISDIR crash", async () => {
  const mutantPath = await writeMutant("f4-pre-fix", ["askBeforeResolving", "rejectNonFile", "guardedRead"]);

  const healthy = runGuard([]);
  assert.equal(healthy.status, 2, "precondition: the real guard refuses the no-argument case");

  const mutant = runGuard([], { script: mutantPath });
  assert.notEqual(mutant.status, 2, "the pre-fix guard must NOT produce a reason-coded refusal");
  assert.notEqual(mutant.status, 0, "a crashed guard must never be mistaken for a clean sink");
  assert.equal(mutant.report, null, "the pre-fix guard emits no verdict on stdout");
  assert.match(mutant.stderr, /EISDIR/, "the pre-fix failure mode is a bare EISDIR stack trace");
});

// ---------------------------------------------------------------------------
// Red 2 — each layer is load-bearing for its own diagnosis. Removing one does not
// break the refusal (a later layer catches it) but it does change WHICH reason code
// comes back. A layer whose removal changed nothing would be dead code.
// ---------------------------------------------------------------------------
const LAYER_DIAGNOSIS = [
  {
    layer: "askBeforeResolving",
    argv: [],
    healthyReason: "PRIVACY_SINK_NOT_SPECIFIED",
    degradedReason: "PRIVACY_SINK_NOT_A_FILE",
    why: "without it an absent --sink resolves to the cwd and is only caught as a directory",
  },
  {
    layer: "rejectNonFile",
    argv: ["--sink", "."],
    healthyReason: "PRIVACY_SINK_NOT_A_FILE",
    degradedReason: "PRIVACY_SINK_UNREADABLE",
    why: "without it a directory reaches readFileSync and is only caught as an EISDIR",
  },
];

for (const scenario of LAYER_DIAGNOSIS) {
  test(`red proof: layer "${scenario.layer}" owns ${scenario.healthyReason} (${scenario.why})`, async () => {
    const healthy = runGuard(scenario.argv);
    assert.equal(healthy.status, 2);
    assert.equal(healthy.report.reasonCode, scenario.healthyReason);

    const mutantPath = await writeMutant(`layer-${scenario.layer}`, [scenario.layer]);
    const mutant = runGuard(scenario.argv, { script: mutantPath });
    assert.equal(mutant.status, 2, "a later layer still refuses — defence in depth is intended");
    assert.equal(
      mutant.report?.reasonCode,
      scenario.degradedReason,
      `removing "${scenario.layer}" must change the diagnosis; if it does not, the layer is dead code`,
    );
  });
}

// ---------------------------------------------------------------------------
// R2 defect 3 — a record that is valid JSON but not an object.
// ---------------------------------------------------------------------------
for (const record of NON_OBJECT_RECORDS) {
  test(`record shape: a sink whose record is ${record.name} → exit 1 + not-an-object, no stack trace`, async () => {
    const sink = join(workdir, `shape-${record.jsonType}.jsonl`);
    await writeFile(sink, `${record.line}\n`, "utf8");
    const run = runGuard(["--sink", sink]);
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}; stderr=${run.stderr}`);
    assert.equal(run.stderr, "", "a classified record must not also produce a stack trace");
    assert.ok(run.report, `expected a JSON verdict on stdout, got: ${run.stdout || run.stderr}`);
    assert.equal(run.report.reasonCode, "PRIVACY_SINK_VIOLATION");
    assert.equal(run.report.records, 1);
    assert.equal(run.report.violations.length, 1);
    assert.equal(run.report.violations[0].why, "not-an-object");
    assert.equal(run.report.violations[0].jsonType, record.jsonType);
  });
}

test("record shape: a line that is not JSON → exit 1 + not-json, and it is counted", () => {
  const run = runGuard(["--sink", mixedSink]);
  assert.equal(run.status, 1);
  assert.equal(run.stderr, "");
  const reasons = run.report.violations.map((violation) => violation.why).sort();
  assert.deepEqual(reasons, ["disallowed-keys", "not-an-object", "not-an-object", "not-json"]);
});

// The arithmetic is the proof that nothing was dropped on the floor. mixedSink holds
// seven lines plus the terminator: two blank, then one clean record, one non-JSON,
// one null, one number and one leaking object. Each number below is asserted against
// that file rather than against the report's other fields — `cleanRecords` is derived
// from `records` and `violations` in the source, so comparing them to each other
// would be a predicate that cannot fail.
test("record shape: the report's counts add up against a sink holding one of everything", () => {
  const run = runGuard(["--sink", mixedSink]);
  assert.equal(run.report.records, 5);
  assert.equal(run.report.blankLines, 2);
  assert.equal(run.report.violations.length, 4);
  assert.equal(run.report.cleanRecords, 1);
});

test("red proof: without the shape layer, `null` crashes bare and the crash exits 1 — a leak nobody saw", async () => {
  const sink = join(workdir, "red-null.jsonl");
  await writeFile(sink, "null\n", "utf8");

  const healthy = runGuard(["--sink", sink]);
  assert.equal(healthy.status, 1);
  assert.ok(healthy.report, "precondition: the real guard answers with a verdict");

  const mutantPath = await writeMutant("shape-null", ["rejectNonObject"]);
  const mutant = runGuard(["--sink", sink], { script: mutantPath });
  assert.equal(mutant.report, null, "the pre-R2 guard emits no verdict for this input");
  assert.match(mutant.stderr, /TypeError/u, "the pre-R2 failure mode is a bare TypeError");
  // This is the whole reason the layer exists. Both sides exit 1, so exit code alone
  // cannot tell them apart — one is a verdict, the other is a crash wearing the
  // verdict's number.
  assert.equal(mutant.status, 1, "and Node exits 1 on an uncaught throw, which reads as PRIVACY_SINK_VIOLATION");
});

test("red proof: without the shape layer, a bare `42` is certified CLEAN at exit 0", async () => {
  const sink = join(workdir, "red-number.jsonl");
  await writeFile(sink, "42\n", "utf8");

  const healthy = runGuard(["--sink", sink]);
  assert.equal(healthy.status, 1, "precondition: the real guard refuses an unaccounted record");

  const mutantPath = await writeMutant("shape-number", ["rejectNonObject"]);
  const mutant = runGuard(["--sink", sink], { script: mutantPath });
  assert.equal(mutant.status, 0, "Object.keys(42) is [], so the pre-R2 guard passed it");
  assert.equal(mutant.report?.reasonCode, "PRIVACY_SINK_CLEAN");
});

// ---------------------------------------------------------------------------
// R2 defect 5 — a sink with no records is not a clean sink.
// ---------------------------------------------------------------------------
for (const scenario of [
  { name: "a zero-byte sink", sink: () => emptySink, blankLines: 0 },
  { name: "a sink of blank lines only", sink: () => blankOnlySink, blankLines: 4 },
]) {
  test(`vacuous pass: ${scenario.name} → exit 2 + PRIVACY_SINK_EMPTY`, () => {
    const run = runGuard(["--sink", scenario.sink()]);
    assert.equal(run.status, 2, `expected exit 2, got ${run.status}; stderr=${run.stderr}`);
    assert.equal(run.report.reasonCode, "PRIVACY_SINK_EMPTY");
    assert.equal(run.report.verdict, "could-not-judge");
    assert.equal(run.report.ok, false);
    assert.equal(run.report.blankLines, scenario.blankLines);
  });
}

test("red proof: without the empty-sink layer, an empty sink reports CLEAN at exit 0", async () => {
  const mutantPath = await writeMutant("empty-sink", ["rejectEmptySink"]);
  const mutant = runGuard(["--sink", emptySink], { script: mutantPath });
  assert.equal(mutant.status, 0, "that is the false green the layer exists to remove");
  assert.equal(mutant.report?.reasonCode, "PRIVACY_SINK_CLEAN");
  assert.equal(mutant.report?.records, 0, "…on the strength of having judged zero records");
});

// ---------------------------------------------------------------------------
// R2 defect 4 — the verdict must survive a pipe at any size.
// ---------------------------------------------------------------------------

// Writes stdout straight to a file (no pipe involved) so the piped run has something
// to be compared against that the defect cannot touch.
//
// The redirection is the SHELL's, not ours. Handing the child a descriptor we opened
// (`stdio: ["ignore", fd, "pipe"]`) is what the test controller's child policy refuses
// as TEST_CONTROLLER_INHERITED_STDIO_FORBIDDEN — and it refuses it for a real reason:
// any descriptor above 2 can be a dup of the controller's own output. Under a bare
// `node --test` the policy is not loaded and that spelling passed, so this only ever
// went red under `pnpm test`. `sh` opens the file itself, so no descriptor of ours
// crosses the boundary while the guard's stdout is still a regular file.
function runGuardToFile(argv, outputPath, { script = SOURCE_PATH } = {}) {
  const result = spawnSync("/bin/sh", ["-c", 'exec "$@" > "$OUTPUT_PATH"', "sh", process.execPath, script, ...argv], {
    cwd: workdir,
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, OUTPUT_PATH: outputPath },
  });
  return { status: result.status, stderr: result.stderr };
}

test("truncation: a large violation report survives a pipe byte-for-byte and parses", () => {
  const directPath = join(workdir, "bulk-direct.json");
  const direct = runGuardToFile(["--sink", bulkSink], directPath);
  assert.equal(direct.status, 1);
  const directBytes = statSync(directPath).size;
  assert.ok(directBytes > 65536, `the report must clear the pipe buffer to test anything, got ${directBytes} bytes`);

  const piped = runGuard(["--sink", bulkSink]);
  assert.equal(piped.status, 1, "the exit status must survive the switch to process.exitCode");
  assert.equal(
    Buffer.byteLength(piped.stdout, "utf8"),
    directBytes,
    "a piped verdict must carry the same bytes as one written straight to a file",
  );
  const parsed = JSON.parse(piped.stdout);
  assert.equal(parsed.violations.length, BULK_VIOLATIONS);
  assert.equal(parsed.records, BULK_VIOLATIONS);
});

test("red proof: restoring process.exit() after the write truncates that report at the pipe buffer", async (t) => {
  const mutantPath = await writeMutant("exit-after-write", ["exitAfterWrite"]);
  const mutant = runGuard(["--sink", bulkSink], { script: mutantPath });
  const mutantBytes = Buffer.byteLength(mutant.stdout, "utf8");

  const directPath = join(workdir, "bulk-direct-for-red.json");
  runGuardToFile(["--sink", bulkSink], directPath);
  const directBytes = statSync(directPath).size;

  // The mutant's defect is a race: process.exit() discards whatever stdout has
  // not yet drained into the pipe. On hosts where the reader drains fast enough
  // the truncation is not constructible at this payload size (observed on Linux
  // CI runners, where every byte arrives), and a red leg that cannot be
  // constructed in the world evaluating it must say so rather than fail.
  if (mutantBytes === directBytes) {
    t.skip(`pipe drained fully in this environment (${mutantBytes} bytes); the truncation race is not constructible here`);
    return;
  }
  assert.ok(mutantBytes < directBytes, `expected a short read, got ${mutantBytes} of ${directBytes} bytes`);
  assert.throws(() => JSON.parse(mutant.stdout), "the consumer receives invalid JSON — that is the defect");
  assert.equal(mutant.report, null);
});

// The refusal path carries argv back to the caller, so its payload length is the
// caller's to choose. An 80 KiB --sink value made the refusal truncatable too.
test("truncation: an over-long --sink value still yields a whole, parseable refusal", () => {
  const overlong = `/${"x".repeat(80000)}/no-such-sink.jsonl`;
  const run = runGuard(["--sink", overlong]);
  assert.equal(run.status, 2);
  assert.ok(run.report, `expected parseable JSON, got ${Buffer.byteLength(run.stdout, "utf8")} bytes`);
  assert.equal(run.report.reasonCode, "PRIVACY_SINK_MISSING");
  assert.ok(run.report.sink.length < 1024, `the echoed path must be clamped, got ${run.report.sink.length} chars`);
  assert.match(run.report.sink, /\[\+\d+ chars\]$/u, "and the clamp must say that it clamped");
});

test("red proof: without the refusal clamp, an over-long --sink value truncates the refusal", async (t) => {
  const overlong = `/${"x".repeat(80000)}/no-such-sink.jsonl`;
  const mutantPath = await writeMutant("clamp-refusal", ["clampRefusal"]);
  const mutant = runGuard(["--sink", overlong], { script: mutantPath });
  // Same race as the exit-after-write red leg above: on hosts whose pipe reader
  // drains faster than the exiting writer (observed on Linux CI runners) the
  // unclamped refusal arrives whole, and the truncation this leg exists to
  // demonstrate is not constructible here.
  if (mutant.report !== null) {
    t.skip("pipe drained the unclamped refusal fully in this environment; the truncation race is not constructible here");
    return;
  }
  assert.equal(mutant.report, null, "the unclamped refusal does not arrive as JSON");
  assert.throws(() => JSON.parse(mutant.stdout));
});
