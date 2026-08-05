// R2 — exit-code contract proof for scripts/token-attribution.mjs.
//
// The defect this file exists to prevent: the exit contract was prose the bytes did
// not honour. The header said "Exit 0 parsed · 1 no sessions / unreadable input",
// and all three ways of measuring nothing came back ok:true at exit 0 with a zero
// total — a directory holding no .jsonl, a --match that selected nothing, and a
// --file pointing at a path that does not exist. S11's report is an input to
// delivery-cadence decisions, so a moved directory handed the caller "this
// Initiative cost 0 tokens" as a SUCCESS and nothing anywhere said otherwise.
//
// The contract under test, and the reason it is a biconditional rather than a list:
//
//   exit 0  ⟺  ok:true  ⟺  at least one usage line was actually read
//   exit 2  ⟺  ok:false ⟺  nothing was measured, for a named reason
//   exit 1      never emitted — a meter has no "I read it and the answer is bad"
//
// Checking it as a biconditional over the whole scenario matrix is what makes the
// two sides genuinely able to differ: a fix that turned every run into exit 2 would
// satisfy "no false success" and still be caught here, because the measured run must
// come back 0.
//
// The reason codes are asserted to be pairwise DISTINCT as well. A probe whose every
// failure answers with one code has stopped answering the question — the caller can
// no longer tell "the directory moved" from "the --match is wrong" from "these
// sessions really are empty", which are three different things to go fix.
//
// Following the INC-037 pattern the suite carries its own red rather than asserting
// green and hoping. Three mutations run against throw-away copies of the source:
//
//   1. zeroMeasurementIsRefusal — the three could-not-judge returns removed, which
//      restores the shipped defect exactly: ok:true, exit 0, totals all zero.
//   2. flagPresence — presence of --file re-read as truthiness of its value, which
//      is how an empty value used to fall through and get diagnosed as if no input
//      had been given at all.
//   3. exitAfterWrite — process.exitCode reverted to process.exit(), which truncates
//      a large report at the pipe buffer. Same defect class as the one measured in
//      verify-otel-privacy.mjs, and the reason this file emits one write and sets
//      one exit code instead of exiting at each refusal.
//
// Run: node --test tests/token-attribution.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Pointing this at another copy is how the red side gets demonstrated by hand:
// TOKEN_ATTRIBUTION_SOURCE=<pre-fix copy> node --test tests/token-attribution.test.mjs
const SOURCE_PATH = process.env.TOKEN_ATTRIBUTION_SOURCE ?? resolve(HERE, "../scripts/token-attribution.mjs");

const usageLine = (model, tokens) =>
  JSON.stringify({
    timestamp: "2026-08-05T00:00:00Z",
    type: "assistant",
    message: { role: "assistant", model, usage: tokens },
  });

const FULL_USAGE = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 7, cache_read_input_tokens: 900 };
// One field missing: the parser must count the gap and still add what IS there,
// which is the "honest gap, never a silent cap" rule this file also guards.
const PARTIAL_USAGE = { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 3 };

// Enough sessions that the serialized report clears the 64 KiB pipe buffer.
const BULK_SESSIONS = 220;

// Each mutation's replacement is the pre-R2 byte sequence, so a mutant is the
// shipped-and-broken tool rather than an invented one. Anchors are asserted unique
// so a refactor cannot silently retire a proof.
const LAYERS = {
  zeroMeasurementIsRefusal: {
    anchor:
      "  if (sessions.length === 0) {\n" +
      "    return {\n" +
      '      ...couldNotJudge("NO_SESSIONS_SELECTED", {\n' +
      '        detail: match ? "no session file contained the --match substring" : "no .jsonl session file under that directory",\n' +
      "      }),\n" +
      "      ...body,\n" +
      "    };\n" +
      "  }\n" +
      "  if (unreadableSessions === sessions.length) {\n" +
      '    return { ...couldNotJudge("SESSIONS_ALL_UNREADABLE", { detail: "every selected session failed to open" }), ...body };\n' +
      "  }\n" +
      "  if (totals.messages === 0) {\n" +
      "    return {\n" +
      '      ...couldNotJudge("NO_USAGE_OBSERVED", { detail: "sessions were read but carried no usage line" }),\n' +
      "      ...body,\n" +
      "    };\n" +
      "  }\n",
    replacement: "",
  },
  flagPresence: {
    anchor: '  if (flagPresent("file")) {',
    replacement: "  if (file) {",
  },
  exitAfterWrite: {
    anchor: "process.exitCode = report.ok ? 0 : 2;",
    replacement: "process.exit(report.ok ? 0 : 2);",
  },
};

let workdir;
let sessionsDir;
let emptyDir;
let bulkDir;
let goodSession;
let noUsageSession;
let missingSession;
let sourceText;

before(async () => {
  workdir = await mkdtemp(join(tmpdir(), "token-attribution-"));
  sessionsDir = join(workdir, "sessions");
  emptyDir = join(workdir, "empty");
  bulkDir = join(workdir, "bulk");
  await mkdir(sessionsDir);
  await mkdir(emptyDir);
  await mkdir(bulkDir);

  goodSession = join(sessionsDir, "good.jsonl");
  noUsageSession = join(sessionsDir, "no-usage.jsonl");
  missingSession = join(workdir, "does-not-exist.jsonl");

  await writeFile(
    goodSession,
    [
      usageLine("claude-opus-5", FULL_USAGE),
      usageLine("deepseek-v4-flash", PARTIAL_USAGE),
      "{ not json",
      JSON.stringify({ timestamp: "2026-08-05T00:00:01Z", type: "user", message: { role: "user", content: "INIT-018" } }),
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    noUsageSession,
    `${JSON.stringify({ timestamp: "2026-08-05T00:00:00Z", type: "user", message: { role: "user", content: "hello" } })}\n`,
    "utf8",
  );
  await Promise.all(
    Array.from({ length: BULK_SESSIONS }, (unused, index) =>
      writeFile(join(bulkDir, `session-${index}.jsonl`), `${usageLine("claude-opus-5", FULL_USAGE)}\n`, "utf8"),
    ),
  );
  sourceText = await readFile(SOURCE_PATH, "utf8");
});

after(async () => {
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

// Runs from a directory that holds no session files, so a cwd-shaped bug cannot
// accidentally land on real data and look healthy.
function runParser(argv, { script = SOURCE_PATH } = {}) {
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
// The scenario matrix. Every way of asking this tool a question, and the single
// answer each one is allowed to give.
// ---------------------------------------------------------------------------
const COULD_NOT_JUDGE = [
  { name: "no arguments at all", argv: () => [], reasonCode: "NO_INPUT" },
  { name: "--file with an empty value", argv: () => ["--file", ""], reasonCode: "INPUT_EMPTY" },
  { name: "--dir with an empty value", argv: () => ["--dir", ""], reasonCode: "INPUT_EMPTY" },
  { name: "--dir pointing at a file", argv: () => ["--dir", goodSession], reasonCode: "SESSIONS_DIR_UNREADABLE" },
  { name: "--dir at a directory holding no .jsonl", argv: () => ["--dir", emptyDir], reasonCode: "NO_SESSIONS_SELECTED" },
  {
    name: "--match that selects no session",
    argv: () => ["--dir", sessionsDir, "--match", "NO-SUCH-INITIATIVE"],
    reasonCode: "NO_SESSIONS_SELECTED",
  },
  { name: "--file at a path that does not exist", argv: () => ["--file", missingSession], reasonCode: "SESSIONS_ALL_UNREADABLE" },
  { name: "--file at a directory", argv: () => ["--file", sessionsDir], reasonCode: "SESSIONS_ALL_UNREADABLE" },
  { name: "a session carrying no usage line", argv: () => ["--file", noUsageSession], reasonCode: "NO_USAGE_OBSERVED" },
];

for (const scenario of COULD_NOT_JUDGE) {
  test(`could-not-judge: ${scenario.name} → exit 2 + ${scenario.reasonCode}`, () => {
    const run = runParser(scenario.argv());
    assert.equal(run.status, 2, `expected exit 2, got ${run.status}; stderr=${run.stderr}`);
    assert.ok(run.report, `expected a JSON report on stdout, got: ${run.stdout || run.stderr}`);
    assert.equal(run.report.reasonCode, scenario.reasonCode);
    assert.equal(run.report.ok, false);
    assert.equal(run.report.verdict, "could-not-judge");
    assert.equal(run.stderr, "", "a reason-coded refusal must not also print a stack trace");
  });
}

test("measured: a real session → exit 0 + TOKEN_ATTRIBUTION_READY with the tokens that are there", () => {
  const run = runParser(["--file", goodSession]);
  assert.equal(run.status, 0, `expected exit 0, got ${run.status}; stderr=${run.stderr}`);
  assert.equal(run.report.reasonCode, "TOKEN_ATTRIBUTION_READY");
  assert.equal(run.report.ok, true);
  assert.equal(run.report.verdict, "measured");
  assert.equal(run.report.totals.messages, 2);
  assert.equal(run.report.totals.input, FULL_USAGE.input_tokens + PARTIAL_USAGE.input_tokens);
  assert.equal(run.report.totals.cacheRead, FULL_USAGE.cache_read_input_tokens + PARTIAL_USAGE.cache_read_input_tokens);
  // The gaps stay honest rather than being rounded into the totals.
  assert.equal(run.report.totals.gaps.unparseable, 1);
  assert.equal(run.report.totals.gaps.missingUsage, 1);
  assert.equal(run.report.totals.gaps.incompleteUsage, 1);
  assert.equal(run.report.totals.gaps.unreadableSessions, 0);
  assert.deepEqual(Object.keys(run.report.byModel).sort(), ["claude-opus-5", "deepseek-v4-flash"]);
});

test("measured: --dir with a --match that selects a session → exit 0", () => {
  const run = runParser(["--dir", sessionsDir, "--match", "INIT-018"]);
  assert.equal(run.status, 0, `expected exit 0, got ${run.status}; stderr=${run.stderr}`);
  assert.equal(run.report.reasonCode, "TOKEN_ATTRIBUTION_READY");
  assert.equal(run.report.totals.sessions, 1, "--match is a whole-session selector, and it selected the one session");
});

// The contract as a biconditional, evaluated over every scenario at once. Both
// directions matter: no false success, and no refusal of a real measurement.
test("contract: ok:true ⟺ exit 0 ⟺ at least one usage line, over the whole matrix", () => {
  const matrix = [
    ...COULD_NOT_JUDGE.map((scenario) => scenario.argv()),
    ["--file", goodSession],
    ["--dir", sessionsDir],
    ["--dir", sessionsDir, "--match", "INIT-018"],
  ];
  let measured = 0;
  for (const argv of matrix) {
    const run = runParser(argv);
    assert.notEqual(run.status, 1, `exit 1 is not part of this tool's contract (argv: ${argv.join(" ")})`);
    assert.ok(run.report, `every invocation must answer with JSON (argv: ${argv.join(" ")})`);
    const usageSeen = (run.report.totals?.messages ?? 0) > 0;
    assert.equal(run.report.ok, run.status === 0, `ok and exit status must agree (argv: ${argv.join(" ")})`);
    assert.equal(run.report.ok, usageSeen, `success must mean a usage line was read (argv: ${argv.join(" ")})`);
    if (run.report.ok) measured += 1;
  }
  assert.equal(measured, 3, "the matrix must contain runs that genuinely succeed, or the biconditional is vacuous");
});

test("contract: the documented exit line matches what the bytes do", () => {
  assert.match(
    sourceText,
    /^\/\/ Exit 0 measured · 2 could-not-judge\. Exit 1 is not emitted by this tool/mu,
    "the header contract is an assertion about this file; it must be updated with the behaviour",
  );
});

test("contract: the refusal reason codes are pairwise distinct", () => {
  const observed = COULD_NOT_JUDGE.map((scenario) => runParser(scenario.argv()).report.reasonCode);
  const distinct = new Set(observed);
  // NO_SESSIONS_SELECTED and INPUT_EMPTY are each claimed twice by design; every
  // other scenario must own its own code.
  assert.equal(distinct.size, 6, `expected 6 distinct reason codes across 9 scenarios, got ${[...distinct].join(",")}`);
  assert.deepEqual(
    [...distinct].sort(),
    ["INPUT_EMPTY", "NO_INPUT", "NO_SESSIONS_SELECTED", "NO_USAGE_OBSERVED", "SESSIONS_ALL_UNREADABLE", "SESSIONS_DIR_UNREADABLE"],
  );
});

// ---------------------------------------------------------------------------
// Red 1 — the shipped defect itself: measuring nothing reported as success.
// ---------------------------------------------------------------------------
const ZERO_MEASUREMENT = [
  { name: "a directory holding no .jsonl", argv: () => ["--dir", emptyDir] },
  { name: "a --match that selects nothing", argv: () => ["--dir", sessionsDir, "--match", "NO-SUCH-INITIATIVE"] },
  { name: "a --file that does not exist", argv: () => ["--file", missingSession] },
];

for (const scenario of ZERO_MEASUREMENT) {
  test(`red proof: without the refusal returns, ${scenario.name} reports success at exit 0`, async () => {
    const healthy = runParser(scenario.argv());
    assert.equal(healthy.status, 2, "precondition: the real parser refuses");
    assert.equal(healthy.report.ok, false);

    const mutantPath = await writeMutant("zero-measurement", ["zeroMeasurementIsRefusal"]);
    const mutant = runParser(scenario.argv(), { script: mutantPath });
    assert.equal(mutant.status, 0, "that is the false success the layer exists to remove");
    assert.equal(mutant.report?.ok, true);
    assert.equal(mutant.report?.reasonCode, "TOKEN_ATTRIBUTION_READY");
    assert.equal(mutant.report?.totals.input, 0, "…while reporting that the Initiative cost nothing");
    assert.equal(mutant.report?.totals.messages, 0);
  });
}

// ---------------------------------------------------------------------------
// Red 2 — presence of a flag is not the truthiness of its value.
// ---------------------------------------------------------------------------
test('red proof: reading --file by truthiness turns an empty value into "no input given"', async () => {
  const healthy = runParser(["--file", ""]);
  assert.equal(healthy.report.reasonCode, "INPUT_EMPTY");

  const mutantPath = await writeMutant("flag-presence", ["flagPresence"]);
  const mutant = runParser(["--file", ""], { script: mutantPath });
  assert.equal(mutant.status, 2, "a later layer still refuses — the diagnosis is what changes");
  assert.equal(
    mutant.report?.reasonCode,
    "NO_INPUT",
    "removing the presence check must change the diagnosis; if it does not, the check is dead code",
  );
});

// ---------------------------------------------------------------------------
// Red 3 — a large report must survive a pipe.
// ---------------------------------------------------------------------------
// The redirection is the SHELL's, not ours: handing the child a descriptor we opened
// is refused by the test controller's child policy (TEST_CONTROLLER_INHERITED_STDIO_
// FORBIDDEN), because a descriptor above 2 can be a dup of the controller's output.
// A bare `node --test` does not load that policy, so the fd spelling passed solo and
// only went red under `pnpm test`. Letting `sh` open the file keeps the baseline a
// regular file without any descriptor of ours crossing the boundary.
function runParserToFile(argv, outputPath, { script = SOURCE_PATH } = {}) {
  const result = spawnSync("/bin/sh", ["-c", 'exec "$@" > "$OUTPUT_PATH"', "sh", process.execPath, script, ...argv], {
    cwd: workdir,
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, OUTPUT_PATH: outputPath },
  });
  return { status: result.status, stderr: result.stderr };
}

test("truncation: a large report survives a pipe byte-for-byte and parses", () => {
  const directPath = join(workdir, "bulk-direct.json");
  const direct = runParserToFile(["--dir", bulkDir], directPath);
  assert.equal(direct.status, 0);
  const directBytes = statSync(directPath).size;
  assert.ok(directBytes > 65536, `the report must clear the pipe buffer to test anything, got ${directBytes} bytes`);

  const piped = runParser(["--dir", bulkDir]);
  assert.equal(piped.status, 0, "the exit status must survive the switch to process.exitCode");
  assert.equal(
    Buffer.byteLength(piped.stdout, "utf8"),
    directBytes,
    "a piped report must carry the same bytes as one written straight to a file",
  );
  assert.equal(JSON.parse(piped.stdout).totals.sessions, BULK_SESSIONS);
});

test("red proof: restoring process.exit() after the write truncates that report at the pipe buffer", async () => {
  const mutantPath = await writeMutant("exit-after-write", ["exitAfterWrite"]);
  const mutant = runParser(["--dir", bulkDir], { script: mutantPath });
  const mutantBytes = Buffer.byteLength(mutant.stdout, "utf8");

  const directPath = join(workdir, "bulk-direct-for-red.json");
  runParserToFile(["--dir", bulkDir], directPath);
  const directBytes = statSync(directPath).size;

  assert.ok(mutantBytes < directBytes, `expected a short read, got ${mutantBytes} of ${directBytes} bytes`);
  assert.throws(() => JSON.parse(mutant.stdout), "the consumer receives invalid JSON — that is the defect");
  assert.equal(mutant.report, null);
});

// The refusal path echoes argv back to the caller, so its payload length is the
// caller's to choose — and the pre-R2 refusals called process.exit() straight after
// their write. Measured on the shipped bytes: an 80 KiB --dir value came back as
// 65,536 bytes of invalid JSON. This tool needs no clamp to be safe because it never
// exits immediately; the sibling in verify-otel-privacy.mjs does, so it clamps.
const OVERLONG_DIR = `/${"y".repeat(80000)}/no-such-projects-dir`;

test("truncation: an over-long --dir value still yields a whole, parseable refusal", () => {
  const run = runParser(["--dir", OVERLONG_DIR]);
  assert.equal(run.status, 2);
  assert.ok(run.report, `expected parseable JSON, got ${Buffer.byteLength(run.stdout, "utf8")} bytes`);
  assert.equal(run.report.reasonCode, "SESSIONS_DIR_UNREADABLE");
  assert.ok(Buffer.byteLength(run.stdout, "utf8") > 65536, "the payload must clear the pipe buffer to test anything");
});

test("red proof: with process.exit() restored, that same refusal truncates into invalid JSON", async () => {
  const mutantPath = await writeMutant("exit-after-write", ["exitAfterWrite"]);
  const mutant = runParser(["--dir", OVERLONG_DIR], { script: mutantPath });
  assert.equal(mutant.report, null, "the refusal does not arrive as JSON");
  assert.throws(() => JSON.parse(mutant.stdout));
});
