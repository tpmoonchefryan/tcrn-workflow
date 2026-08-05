// INC-037 — branch-coverage proof for scripts/ssh-write-observer.mjs.
//
// The defect this file exists to prevent is the platform's signature failure mode:
// a predicate that is always green because nothing in the corpus can distinguish
// its two sides. S2's original 21-sample corpus left four branches inert — deleting
// them changed no verdict — which is why INC-037 exists at all.
//
// So the corpus is not checked by inspection here. Each entry of MUTATIONS names a
// decision branch or a policy-list entry of the observer, a textual edit that removes
// it, and the corpus sample that must go red when it is removed. The test:
//   1. asserts the unmutated corpus is green (both verdict and reason);
//   2. asserts a control mutation (a comment edit) leaves it green — proving the
//      harness is not red for everyone;
//   3. for every mutation: asserts the anchor text still exists exactly once (so a
//      refactor cannot silently retire a proof), applies it to a throw-away copy of
//      the module, re-runs the corpus against that copy, and asserts the declared
//      witness sample is among the samples that turned red.
//
// Run: node --test scripts/ssh-write-observer.test.mjs   (or: node scripts/…test.mjs)
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// INC037_SOURCE points the whole proof at a different copy of the observer. That is
// how the red side is demonstrated: run this suite against a copy carrying only the
// original 21-sample corpus and the inert branches report themselves by name.
const SOURCE_PATH = process.env.INC037_SOURCE ?? resolve(HERE, "../scripts/ssh-write-observer.mjs");
const source = await readFile(SOURCE_PATH, "utf8");

// The mutant copies live in a temp workdir, so PLATFORM_ROOT (derived from the
// script's own location) points nowhere. Pin the break-glass allowlist to the REAL
// platform file before importing any copy (INC-051): otherwise a mutant sees an
// empty allowlist and samples that should ride a break-glass entry go red.
process.env.PUBLIC_CONFIGURATION_VALUE = resolve(HERE, "../../TCRN-AOS/deploy/aos-local-client/ssh-breakglass-allowlist.json");
const workdir = await mkdtemp(join(tmpdir(), "inc037-mutants-"));
after(async () => {
  await rm(workdir, { recursive: true, force: true });
});

// A mutation is applied to a copy; nothing ever writes back to the repository file.
async function loadMutant(id, mutated) {
  const path = join(workdir, `mutant-${id}.mjs`);
  await writeFile(path, mutated);
  return import(pathToFileURL(path).href);
}

function redSamples(module) {
  const red = [];
  for (const sample of module.CORPUS) {
    const got = module.classify(sample.command);
    if (got.verdict !== sample.expect || got.reason !== sample.reason) {
      red.push({ id: sample.id, expected: `${sample.expect}/${sample.reason}`, got: `${got.verdict}/${got.reason}` });
    }
  }
  return red;
}

// id      — the branch or list entry being removed
// find    — anchor text in the source; must appear exactly once
// replace — the text that removes that branch
// witness — the corpus sample that must turn red once it is gone
const MUTATIONS = [
  // ---- tokenizer -----------------------------------------------------------
  { id: "tok-comment", find: `if (char === "#" && !started) {`, replace: `if (false && !started) {`, witness: "D09" },
  { id: "tok-pipe-split", find: `    if (char === "|") {`, replace: `    if (false) {`, witness: "H01" },
  // One branch covers `(`, `)`, backtick and `$(` — C15/E21/E22 all rely on it.
  { id: "tok-subshell", find: `    if (char === "\`" || char === "(" || char === ")") {`, replace: `    if (false) {`, witness: "E21" },
  { id: "tok-subshell-substitution", find: `    if (char === "\`" || char === "(" || char === ")") {`, replace: `    if (false) {`, witness: "C15" },
  // Redirections are parsed out of argv rather than left in it. Feeding them back
  // into argv breaks detection of the redirect forms themselves (A01/A02/A03/E19);
  // that a LOCAL redirect is not part of the remote command is a different property,
  // proven separately by 'remote-command-scope' with witness D11.
  {
    id: "tok-redirect-parse",
    find: `      redirects.push({ op, fd, target: readWord(), dup: false });`,
    replace: `      argv.push({ value: op, quoted: false });\n      const lifted = readWord();\n      if (lifted) argv.push({ value: lifted, quoted: false });`,
    witness: "A01",
  },
  { id: "dup-is-not-a-write",
    find: `      if (redirect.dup || !WRITE_REDIRECT_OPS.has(redirect.op)) continue;`,
    replace: `      if (!WRITE_REDIRECT_OPS.has(redirect.op)) continue;`,
    witness: "H10",
  },

  // ---- wrapper / env-assignment resolution (defect 2) ----------------------
  { id: "wrapper-env", find: `  ["env", {`, replace: `  ["env-removed", {`, witness: "C01" },
  { id: "wrapper-time", find: `  ["time", {`, replace: `  ["time-removed", {`, witness: "C02" },
  { id: "wrapper-sudo", find: `  ["sudo", {`, replace: `  ["sudo-removed", {`, witness: "C03" },
  { id: "wrapper-doas", find: `  ["doas", {`, replace: `  ["doas-removed", {`, witness: "C13" },
  { id: "wrapper-nohup", find: `  ["nohup", {`, replace: `  ["nohup-removed", {`, witness: "C04" },
  { id: "wrapper-command", find: `  ["command", {`, replace: `  ["command-removed", {`, witness: "C05" },
  { id: "wrapper-exec", find: `  ["exec", {`, replace: `  ["exec-removed", {`, witness: "C11" },
  { id: "wrapper-nice", find: `  ["nice", {`, replace: `  ["nice-removed", {`, witness: "C08" },
  { id: "wrapper-ionice", find: `  ["ionice", {`, replace: `  ["ionice-removed", {`, witness: "C09" },
  { id: "wrapper-stdbuf", find: `  ["stdbuf", {`, replace: `  ["stdbuf-removed", {`, witness: "C10" },
  { id: "wrapper-setsid", find: `  ["setsid", {`, replace: `  ["setsid-removed", {`, witness: "C12" },
  { id: "wrapper-timeout", find: `  ["timeout", {`, replace: `  ["timeout-removed", {`, witness: "C07" },
  {
    id: "leading-assignments",
    find: `  while (index < argv.length && isAssignment(argv[index].value)) index += 1;`,
    replace: `  ;`,
    witness: "C06",
  },
  {
    id: "wrapper-chain",
    find: `  while (index < argv.length) {\n    const wrapper = WRAPPERS.get`,
    replace: `  for (let pass = 0; pass < 1 && index < argv.length; pass += 1) {\n    const wrapper = WRAPPERS.get`,
    witness: "C14",
  },
  { id: "wrapper-inline-assignment", find: `      if (isAssignment(token)) {`, replace: `      if (false) {`, witness: "C01" },
  {
    id: "wrapper-flag-argument",
    find: `        if (!attached && wrapper.flagsWithArg.has(key)) index += 1;`,
    replace: `        ;`,
    witness: "C03",
  },
  { id: "wrapper-leading-operand", find: `      if (wrapper.leadingOperand?.test(token)) {`, replace: `      if (false) {`, witness: "C07" },

  // ---- ssh argv parsing ----------------------------------------------------
  {
    id: "ssh-option-skip",
    // Anchored on the loop head, not on the shared break line: since INC-037s
    // reviewer found the post-destination bypass there are TWO option scans, and the
    // break line alone no longer identifies one of them.
    find: `  let index = 0;
  while (index < args.length) {`,
    replace: `  let index = args.length;
  while (index < args.length) {`,
    witness: "E06",
  },
  {
    id: "ssh-option-argument",
    find: `    index += SSH_FLAGS_WITH_ARG.has(key) && token.value.length === 2 ? 2 : 1;`,
    replace: `    index += 1;`,
    witness: "E05",
  },
  {
    id: "ssh-user-prefix",
    find: `  const host = at === -1 ? destination.value : destination.value.slice(at + 1);`,
    replace: `  const host = destination.value;`,
    witness: "E06",
  },
  {
    id: "ssh-remote-join",
    find: `  return { kind: "ssh", host, remote: args.slice(rest).map((token) => token.value).join(" ") };`,
    replace: `  return { kind: "ssh", host, remote: "" };`,
    witness: "A08",
  },
  { id: "program-basename", find: `  const program = basename(segment.argv[start].value);`, replace: `  const program = segment.argv[start].value;`, witness: "E18" },
  { id: "transport-ssh", find: `  if (program === "ssh") return parseSsh(args);`, replace: `  if (false) return parseSsh(args);`, witness: "A08" },
  {
    id: "transport-rsync",
    find: `  if (program === "rsync" || program === "scp") return parseTransfer(program, args);`,
    replace: `  if (program === "scp") return parseTransfer(program, args);`,
    witness: "A09",
  },
  {
    id: "transport-scp",
    find: `  if (program === "rsync" || program === "scp") return parseTransfer(program, args);`,
    replace: `  if (program === "rsync") return parseTransfer(program, args);`,
    witness: "A10",
  },
  {
    id: "transfer-spec-anchor",
    find: `    const match = /^(?:[^@:/\\s]+@)?([A-Za-z0-9._-]+):(.+)$/u.exec(token.value);`,
    replace: `    const match = [token.value, "tcrn-platform-placeholder", token.value];`,
    witness: "D08",
  },
  {
    id: "transfer-host-check",
    find: `    if (match && HOST_NAME.test(match[1])) remoteSpecs.push({ host: match[1], path: match[2] });`,
    replace: `    if (match) remoteSpecs.push({ host: match[1], path: match[2] });`,
    witness: "E23",
  },

  // ---- write primitives ----------------------------------------------------
  { id: "redirect-op-gt", find: `new Set([">", ">>", ">|", "&>", "&>>"])`, replace: `new Set([">>", ">|", "&>", "&>>"])`, witness: "A01" },
  { id: "redirect-op-gtgt", find: `new Set([">", ">>", ">|", "&>", "&>>"])`, replace: `new Set([">", ">|", "&>", "&>>"])`, witness: "A03" },
  { id: "redirect-op-gtbar", find: `new Set([">", ">>", ">|", "&>", "&>>"])`, replace: `new Set([">", ">>", "&>", "&>>"])`, witness: "H15" },
  { id: "redirect-op-ampgt", find: `new Set([">", ">>", ">|", "&>", "&>>"])`, replace: `new Set([">", ">>", ">|", "&>>"])`, witness: "H03" },
  { id: "redirect-op-ampgtgt", find: `new Set([">", ">>", ">|", "&>", "&>>"])`, replace: `new Set([">", ">>", ">|", "&>"])`, witness: "H16" },
  { id: "write-cmd-cp", find: `new Set(["cp", "mv", "rm", "dd", "install", "touch", "tee"])`, replace: `new Set(["mv", "rm", "dd", "install", "touch", "tee"])`, witness: "A06" },
  { id: "write-cmd-mv", find: `new Set(["cp", "mv", "rm", "dd", "install", "touch", "tee"])`, replace: `new Set(["cp", "rm", "dd", "install", "touch", "tee"])`, witness: "A07" },
  { id: "write-cmd-rm", find: `new Set(["cp", "mv", "rm", "dd", "install", "touch", "tee"])`, replace: `new Set(["cp", "mv", "dd", "install", "touch", "tee"])`, witness: "A08" },
  { id: "write-cmd-dd", find: `new Set(["cp", "mv", "rm", "dd", "install", "touch", "tee"])`, replace: `new Set(["cp", "mv", "rm", "install", "touch", "tee"])`, witness: "E13" },
  { id: "write-cmd-install", find: `new Set(["cp", "mv", "rm", "dd", "install", "touch", "tee"])`, replace: `new Set(["cp", "mv", "rm", "dd", "touch", "tee"])`, witness: "E14" },
  { id: "write-cmd-touch", find: `new Set(["cp", "mv", "rm", "dd", "install", "touch", "tee"])`, replace: `new Set(["cp", "mv", "rm", "dd", "install", "tee"])`, witness: "E15" },
  { id: "write-cmd-tee", find: `new Set(["cp", "mv", "rm", "dd", "install", "touch", "tee"])`, replace: `new Set(["cp", "mv", "rm", "dd", "install", "touch"])`, witness: "A04" },
  {
    id: "write-sed-in-place",
    find: `    } else if (program === "sed" && argv.some((token) => /^-i/u.test(token.value) || token.value.startsWith("--in-place"))) {`,
    replace: `    } else if (false) {`,
    witness: "A05",
  },

  // ---- one more shell between ssh and the write ----------------------------
  { id: "remote-shell-c", find: `    const script = depth < 4 ? shellScriptArgument(argv) : null;`, replace: `    const script = null;`, witness: "G01" },
  { id: "remote-shell-set", find: `const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);`, replace: `const SHELLS = new Set(["zsh", "dash", "ksh"]);`, witness: "G01" },
  { id: "remote-shell-flag", find: `/^-[a-z]*c$/u.test(token.value)`, replace: `token.value === "-c"`, witness: "G03" },
  {
    id: "remote-wrapper-strip",
    find: `    const argv = segment.argv.slice(skipWrappers(segment.argv));`,
    replace: `    const argv = segment.argv;`,
    witness: "G02",
  },

  // ---- exemption stage (defect 1: anchored, and evaluated last) -------------
  { id: "exemption-stage", find: `      if (exemption) {`, replace: `      if (false) {`, witness: "H05" },
  { id: "exemption-empty-targets", find: `    if (unit.targets.length === 0) return null;`, replace: `    ;`, witness: "H14" },
  { id: "exemption-every-unit", find: `    matched.push(entry.id);`, replace: `    return entry.id;`, witness: "H13" },
  { id: "exemption-entry-scratch", find: `    matches: (unit) => unit.targets.every(isScratchTarget),`, replace: `    matches: () => false,`, witness: "H05" },
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
  },
  { id: "scratch-root-tmp", find: `["/tmp/", "/var/tmp/", "/run/", "/dev/null"]`, replace: `["/var/tmp/", "/run/", "/dev/null"]`, witness: "H05" },
  { id: "scratch-root-var-tmp", find: `["/tmp/", "/var/tmp/", "/run/", "/dev/null"]`, replace: `["/tmp/", "/run/", "/dev/null"]`, witness: "H06" },
  { id: "scratch-root-run", find: `["/tmp/", "/var/tmp/", "/run/", "/dev/null"]`, replace: `["/tmp/", "/var/tmp/", "/dev/null"]`, witness: "H07" },
  { id: "scratch-root-dev-null", find: `["/tmp/", "/var/tmp/", "/run/", "/dev/null"]`, replace: `["/tmp/", "/var/tmp/", "/run/"]`, witness: "H08" },
  {
    id: "scratch-prefix-match",
    find: `  return SCRATCH_ROOTS.some((root) => (root.endsWith("/") ? target.startsWith(root) : target === root));`,
    replace: `  return SCRATCH_ROOTS.some((root) => target === root);`,
    witness: "H09",
  },

  // ---- classify flow -------------------------------------------------------
  { id: "host-check", find: `      if (!transport.host || !HOST_NAME.test(transport.host)) continue;`, replace: `      if (false) continue;`, witness: "E01" },
  {
    id: "host-anchor",
    find: `const HOST_NAME = /^tcrn-platform-placeholder(?:\\.[A-Za-z0-9.-]+)?$/u;`,
    replace: `const HOST_NAME = /tcrn-platform-placeholder/u;`,
    witness: "E02",
  },
  { id: "governance-check", find: `      if (!GOVERNANCE.test(transport.remote)) continue;`, replace: `      if (false) continue;`, witness: "E03" },
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
  // The heart of defect 3: scope the write-primitive scan to the remote command.
  { id: "remote-command-scope", find: `      note(2, "no-write-primitive");\n      const units = remoteWriteUnits(transport.remote);`, replace: `      note(2, "no-write-primitive");\n      const units = remoteWriteUnits(command);`, witness: "H11" },
  { id: "write-primitive-required", find: `      if (units.length === 0) continue;`, replace: `      if (false) continue;`, witness: "D04" },
  { id: "transfer-spec-required", find: `      if (transport.remoteSpecs.length === 0) continue;`, replace: `      if (false) continue;`, witness: "D08" },
  {
    id: "transfer-governance-check",
    find: `      if (!transport.remoteSpecs.some((spec) => GOVERNANCE.test(spec.path))) continue;`,
    replace: `      if (false) continue;`,
    witness: "E10",
  },
  { id: "reason-rank", find: `    if (candidateRank > rank) {`, replace: `    if (true) {`, witness: "H12" },
  // INC-051: the write-guard before the allowlist — removing it lets a "status; rm"
  // command ride the status break-glass entry. F06 (status + rm of the tree) must turn red.
  { id: "allowlist-write-guard", find: `        if (writeHit) return { verdict: "HIT", reason: "ssh-write" };`, replace: `        /* guard removed */`, witness: "F06" },
];

test("corpus is green against the unmutated observer", async () => {
  const live = await import(pathToFileURL(SOURCE_PATH).href);
  assert.deepEqual(redSamples(live), [], "unmutated corpus must classify every sample as declared");
  const report = live.runSelfTest();
  assert.equal(report.ok, true);
  assert.equal(report.total, live.CORPUS.length);
  assert.ok(report.hits > 0 && report.passes > 0, "corpus must exercise both verdicts");
});

test("control mutation leaves the corpus green (the harness is not red for everyone)", async () => {
  const anchor = "// observe mode: a failed log write must never block the session";
  assert.equal(source.split(anchor).length - 1, 1);
  const mutant = await loadMutant("control", source.replace(anchor, "// control mutation: comment text only"));
  assert.deepEqual(redSamples(mutant), [], "a semantically inert edit must not turn any sample red");
});

test("every corpus id is unique", async () => {
  const live = await import(pathToFileURL(SOURCE_PATH).href);
  const ids = live.CORPUS.map((sample) => sample.id);
  assert.equal(new Set(ids).size, ids.length);
});

for (const mutation of MUTATIONS) {
  test(`branch '${mutation.id}' is covered: removing it turns ${mutation.witness} red`, async () => {
    const occurrences = source.split(mutation.find).length - 1;
    assert.equal(occurrences, 1, `anchor for '${mutation.id}' must appear exactly once (found ${occurrences}) — refresh the proof`);
    const mutant = await loadMutant(mutation.id, source.replace(mutation.find, mutation.replace));
    const red = redSamples(mutant);
    assert.ok(red.length > 0, `removing '${mutation.id}' changed no verdict or reason — the branch is inert`);
    const witness = red.find((entry) => entry.id === mutation.witness);
    assert.ok(
      witness,
      `removing '${mutation.id}' did not turn ${mutation.witness} red (red instead: ${red.map((entry) => entry.id).join(",") || "none"})`,
    );
  });
}

test("a parser fault fails toward PASS, never toward a blocked session", async () => {
  const anchor = `function classifyInner(command) {`;
  assert.equal(source.split(anchor).length - 1, 1);
  const mutant = await loadMutant("throwing", source.replace(anchor, `${anchor}\n  throw new Error("injected parser fault");`));
  for (const sample of mutant.CORPUS) {
    const got = mutant.classify(sample.command);
    assert.equal(got.verdict, "PASS");
    assert.equal(got.reason, "parse-error");
  }
});

test("the CLI actually runs when the invocation path traverses a symlink", async () => {
  // Guards a silent always-green: an entry-point check that compares unresolved
  // paths makes `--self-test` exit 0 without executing a single sample.
  const linkDir = await mkdtemp(join(tmpdir(), "inc037-link-"));
  const link = join(linkDir, "observer-link.mjs");
  await symlink(SOURCE_PATH, link);
  try {
    const out = execFileSync(process.execPath, [link, "--self-test"], { encoding: "utf8" });
    const report = JSON.parse(out);
    assert.equal(report.ok, true);
    assert.ok(report.total > 0, "self-test through a symlink must actually classify samples");
    const classified = JSON.parse(execFileSync(process.execPath, [link, "--classify", "git status"], { encoding: "utf8" }));
    assert.equal(classified.verdict, "PASS");
  } finally {
    await rm(linkDir, { recursive: true, force: true });
  }
});

test("hook mode holds its input contract: log only on HIT, and never block", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "inc037-hook-"));
  const logPath = join(logDir, "observed-hits.log");
  const run = (payload) =>
    execFileSync(process.execPath, [SOURCE_PATH], {
      input: payload,
      encoding: "utf8",
      env: { ...process.env, S2_OBSERVE_LOG: logPath },
    });
  try {
    const hit = `env X=1 ssh tcrn-platform-placeholder "rm /var/lib/tcrn-placeholder/governance/tcrn-workspace/cross-project/workspace/index.json"`;
    run(JSON.stringify({ tool_name: "Bash", tool_input: { command: hit } }));
    run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }));
    run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }));
    const logged = (await readFile(logPath, "utf8")).trim().split("\n");
    assert.equal(logged.length, 1, "exactly the HIT is logged");
    const entry = JSON.parse(logged[0]);
    assert.equal(entry.tool, "Bash");
    assert.equal(entry.reason, "ssh-write");
    assert.equal(entry.command, hit);
    assert.ok(Date.parse(entry.at) > 0);
    assert.equal(Object.hasOwn(entry, "probe"), false, "without the gate's environment nothing is tagged as a probe");
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// INC-040 — the observation CHANNEL, not the predicate.
//
// The predicate above was proven branch by branch while the channel underneath it was
// severed: INC-034 moved the evidence bundle out of this repository, the sink's parent
// directory stopped existing, appendFileSync threw ENOENT into an empty catch, and the
// hook went on classifying correctly and exiting 0 with nothing landing anywhere. None
// of the proofs above could see that, because none of them asks whether a hit is
// readable afterwards.
//
// These tests ask exactly that, and the last one is the important one: it proves the
// gate is bound to the hook's own write path, so "gate green while the channel is dead"
// is not a world this file admits.
// ---------------------------------------------------------------------------

/**
 * Run the observer CLI, returning status/stdout/stderr.
 *
 * spawnSync, not execFileSync: execFileSync returns only stdout on success and only
 * exposes stderr through the thrown error, so a diagnostic emitted alongside a
 * successful exit — precisely what observe mode does when the sink is broken — was
 * invisible to the first version of this helper. Measured: the stderr assertions below
 * failed against an observer that was in fact writing the line.
 */
function runCli(args, { sink, script = SOURCE_PATH, input } = {}) {
  const env = { ...process.env };
  if (sink === undefined) delete env.S2_OBSERVE_LOG;
  else env.S2_OBSERVE_LOG = sink;
  const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env, input });
  assert.equal(run.error, undefined, `spawn failed: ${run.error?.message}`);
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

const HIT_COMMAND = `ssh tcrn-platform-placeholder "rm /var/lib/tcrn-placeholder/governance/tcrn-workspace/cross-project/workspace/index.json"`;
const hookPayload = JSON.stringify({ tool_name: "Bash", tool_input: { command: HIT_COMMAND } });

test("the default sink is outside the repository checkout (the INC-040 root cause)", async () => {
  const live = await import(pathToFileURL(SOURCE_PATH).href);
  const saved = process.env.S2_OBSERVE_LOG;
  delete process.env.S2_OBSERVE_LOG;
  try {
    const path = live.observeLogPath();
    const repoRoot = resolve(dirname(SOURCE_PATH), "..");
    assert.ok(
      !path.startsWith(`${repoRoot}/`),
      `the default sink must not live inside the checkout — a repo-local evidence move deleted it once already (got ${path})`,
    );
    assert.equal(path, resolve(repoRoot, "..", "var/tcrn-observe/ssh-write-hits.jsonl"));
  } finally {
    if (saved === undefined) delete process.env.S2_OBSERVE_LOG;
    else process.env.S2_OBSERVE_LOG = saved;
  }
  const override = join(workdir, "override.jsonl");
  process.env.S2_OBSERVE_LOG = override;
  try {
    assert.equal(live.observeLogPath(), override, "S2_OBSERVE_LOG must still override the default");
  } finally {
    if (saved === undefined) delete process.env.S2_OBSERVE_LOG;
    else process.env.S2_OBSERVE_LOG = saved;
  }
});

test("a HIT lands in a sink whose directory does not exist yet, and reads back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inc040-sink-"));
  // Two levels that do not exist: the fix must create the whole parent chain, not
  // assume one missing component.
  const sink = join(dir, "created", "on", "demand", "ssh-write-hits.jsonl");
  try {
    const run = runCli([], { sink, input: hookPayload });
    assert.equal(run.status, 0, "the hook never blocks a session");
    const logged = (await readFile(sink, "utf8")).trim().split("\n");
    assert.equal(logged.length, 1);
    const entry = JSON.parse(logged[0]);
    assert.equal(entry.command, HIT_COMMAND);
    assert.equal(entry.reason, "ssh-write");
    assert.equal(entry.tool, "Bash");
    assert.ok(Date.parse(entry.at) > 0);
    assert.equal(Object.hasOwn(entry, "probe"), false, "a real hit is not tagged as a probe");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// INC-041 — the gate must verify the command the HOST will run.
//
// The INC-040 gate called `hookMode` in this process and called that "the hook's own entry
// point". It is not: the host resolves a registration out of a settings file, substitutes
// a project-directory placeholder, starts a process, and writes the payload to its stdin.
// Every one of those steps was skipped — and the registration this repository shipped was
// `node scripts/ssh-write-observer.mjs`, which starts only when the working directory
// happens to be this repository, which no session on this platform is rooted at. The gate
// reported OBSERVE_CHANNEL_LIVE the whole time.
//
// The tests below therefore build real project roots and feed the gate real registrations.
// The red sides are produced by changing the registration, never by removing a predicate.
// ---------------------------------------------------------------------------

const OBSERVER_BASENAME = basename(SOURCE_PATH);
const SCRIPTS_DIR = dirname(SOURCE_PATH);
// The registration this repository ships, verbatim, with the placeholder unexpanded.
const SHIPPED_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/scripts/${OBSERVER_BASENAME}"`;
// What the same registration looked like before INC-041.
const PRE_INC041_COMMAND = `node scripts/${OBSERVER_BASENAME}`;

/**
 * A project root shaped the way Claude Code reads one.
 *
 * `scriptsTarget` symlinks `<root>/scripts` at a real directory, so a registration written
 * with `${CLAUDE_PROJECT_DIR}` resolves to a real file — which is what makes the
 * substitution itself observable rather than assumed.
 */
async function makeProjectRoot({ command, args, matcher = "Bash", hooks, fileName = "settings.json", scriptsTarget = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "inc041-root-"));
  await mkdir(join(root, ".claude"), { recursive: true });
  const settings = {};
  if (hooks !== undefined) {
    if (hooks !== null) settings.hooks = hooks;
  } else if (command !== undefined) {
    const entry = { type: "command", command };
    if (args !== undefined) entry.args = args;
    settings.hooks = { PreToolUse: [{ matcher, hooks: [entry] }] };
  }
  await writeFile(join(root, ".claude", fileName), `${JSON.stringify(settings, null, 2)}\n`);
  if (scriptsTarget) await symlink(scriptsTarget, join(root, "scripts"));
  return root;
}

async function liveRoot(scriptsDir = SCRIPTS_DIR, command = SHIPPED_COMMAND) {
  return makeProjectRoot({ command, scriptsTarget: scriptsDir });
}

test("--verify-channel runs the REGISTERED command, substitutes the project dir, and reads its nonce back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inc041-live-"));
  const sink = join(dir, "nested", "ssh-write-hits.jsonl");
  const root = await liveRoot();
  try {
    const run = runCli(["--verify-channel", "--project-dir", root], { sink });
    assert.equal(run.status, 0, `expected exit 0, got ${run.status} (${run.stdout}${run.stderr})`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.status, "OBSERVE_CHANNEL_LIVE");
    assert.equal(report.ok, true);
    assert.equal(report.sink, sink, "the gate must report the sink it actually used");
    assert.equal(report.roots.length, 1);
    const [checked] = report.roots;
    // The command executed is the registered string with the placeholder resolved — not a
    // command the gate composed. Both halves are asserted so a future refactor cannot
    // quietly start running something else.
    assert.equal(checked.registeredCommand, SHIPPED_COMMAND);
    assert.equal(checked.resolvedCommand, `node "${root}/scripts/${OBSERVER_BASENAME}"`);
    assert.ok(!checked.resolvedCommand.includes("CLAUDE_PROJECT_DIR"), "the placeholder must be substituted, not passed through");
    assert.equal(checked.settingsPath, join(root, ".claude", "settings.json"));
    assert.equal(checked.form, "shell");

    const records = (await readFile(sink, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    // The probe is written to the REAL sink — that is the point — so it must be
    // self-identifying, or the observation period's "no false positives" count would
    // include the gate's own traffic.
    assert.equal(records[0].probe, true);
    assert.equal(records[0].nonce, checked.nonce);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("--verify-channel is red for the registration this repository shipped before INC-041", async () => {
  // The witness for the whole incident. `node scripts/…` resolves only when the working
  // directory is the repository; the gate runs it from a directory that is neither the
  // project root nor the repository, exactly as a session rooted anywhere else would.
  // Nothing about the predicate is touched to produce this red — only the registration.
  const dir = await mkdtemp(join(tmpdir(), "inc041-prefix-"));
  const sink = join(dir, "ssh-write-hits.jsonl");
  const root = await liveRoot(SCRIPTS_DIR, PRE_INC041_COMMAND);
  try {
    const run = runCli(["--verify-channel", "--project-dir", root], { sink });
    assert.equal(run.status, 1, `expected exit 1, got ${run.status} (${run.stdout}${run.stderr})`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.status, "OBSERVE_CHANNEL_SEVERED");
    assert.equal(report.reason, "hook-launch-failed");
    assert.equal(report.roots[0].registeredCommand, PRE_INC041_COMMAND);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("--verify-channel is red when the hook is not registered at all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inc041-unregistered-"));
  const sink = join(dir, "ssh-write-hits.jsonl");
  // Three shapes of "not registered", each with its own reason so an operator knows which
  // file to open. A CI checkout that has never carried the registration is the first one —
  // and it used to report OBSERVE_CHANNEL_LIVE.
  const noFile = await mkdtemp(join(tmpdir(), "inc041-nosettings-"));
  const noHook = await makeProjectRoot({ hooks: null });
  const otherHook = await makeProjectRoot({ command: 'echo "some other Bash hook"' });
  const wrongMatcher = await makeProjectRoot({ command: SHIPPED_COMMAND, matcher: "Write|Edit", scriptsTarget: SCRIPTS_DIR });
  try {
    for (const [root, reason] of [
      [noFile, "settings-missing"],
      [noHook, "hook-not-registered"],
      [otherHook, "hook-not-registered"],
      [wrongMatcher, "hook-not-registered"],
    ]) {
      const run = runCli(["--verify-channel", "--project-dir", root], { sink });
      assert.equal(run.status, 1, `expected exit 1 for ${reason}, got ${run.status} (${run.stdout}${run.stderr})`);
      const report = JSON.parse(run.stdout);
      assert.equal(report.status, "OBSERVE_CHANNEL_SEVERED");
      assert.equal(report.reason, reason, `wrong reason for ${root}`);
    }
    const unparsable = await mkdtemp(join(tmpdir(), "inc041-badjson-"));
    await mkdir(join(unparsable, ".claude"), { recursive: true });
    await writeFile(join(unparsable, ".claude", "settings.json"), "{ this is not json");
    const run = runCli(["--verify-channel", "--project-dir", unparsable], { sink });
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(run.stdout).reason, "settings-unparsable");
    await rm(unparsable, { recursive: true, force: true });
  } finally {
    for (const root of [dir, noFile, noHook, otherHook, wrongMatcher]) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("--verify-channel is red when the registered command cannot start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inc041-unstartable-"));
  const sink = join(dir, "ssh-write-hits.jsonl");
  const missingScript = await makeProjectRoot({
    command: 'node "${CLAUDE_PROJECT_DIR}/scripts/ssh-write-observer.mjs"',
  });
  const notAProgram = await makeProjectRoot({
    command: '/nonexistent/interpreter "${CLAUDE_PROJECT_DIR}/scripts/ssh-write-observer.mjs"',
  });
  try {
    for (const root of [missingScript, notAProgram]) {
      const run = runCli(["--verify-channel", "--project-dir", root], { sink });
      assert.equal(run.status, 1, `expected exit 1, got ${run.status} (${run.stdout}${run.stderr})`);
      const report = JSON.parse(run.stdout);
      assert.equal(report.status, "OBSERVE_CHANNEL_SEVERED");
      assert.equal(report.reason, "hook-launch-failed");
      assert.ok(report.detail.length > 0, "a launch failure must say what happened");
    }
  } finally {
    for (const root of [dir, missingScript, notAProgram]) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("--verify-channel checks every named root, and one live root cannot rescue a dead one", async () => {
  // Per-root nonces are the mechanism. With a single shared nonce the live root's record
  // would satisfy the dead root's readback, and a two-root roster would be exactly as
  // strong as a one-root roster.
  const dir = await mkdtemp(join(tmpdir(), "inc041-roster-"));
  const sink = join(dir, "ssh-write-hits.jsonl");
  const live = await liveRoot();
  const dead = await liveRoot(SCRIPTS_DIR, PRE_INC041_COMMAND);
  try {
    const both = runCli(["--verify-channel", "--project-dir", live, "--project-dir", dead], { sink });
    assert.equal(both.status, 1, `expected exit 1, got ${both.status} (${both.stdout}${both.stderr})`);
    const report = JSON.parse(both.stdout);
    assert.equal(report.roots.length, 2);
    assert.equal(report.roots[0].ok, true);
    assert.equal(report.roots[1].ok, false);
    assert.equal(report.roots[1].reason, "hook-launch-failed");
    assert.notEqual(report.roots[0].nonce, report.roots[1].nonce, "each root must carry its own nonce");

    const onlyLive = runCli(["--verify-channel", "--project-dir", live], { sink });
    assert.equal(onlyLive.status, 0, "control: the live root on its own is green against the same sink");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(live, { recursive: true, force: true });
    await rm(dead, { recursive: true, force: true });
  }
});

test("--verify-channel accepts the exec form of a registration", async () => {
  // Claude Code starts a hook two ways. The gate must run whichever one is registered, or
  // a settings file the host honours would be one the gate calls unregistered.
  const dir = await mkdtemp(join(tmpdir(), "inc041-exec-"));
  const sink = join(dir, "ssh-write-hits.jsonl");
  const root = await makeProjectRoot({
    command: "node",
    args: ['${CLAUDE_PROJECT_DIR}/scripts/' + OBSERVER_BASENAME],
    scriptsTarget: SCRIPTS_DIR,
  });
  try {
    const run = runCli(["--verify-channel", "--project-dir", root], { sink });
    assert.equal(run.status, 0, `expected exit 0, got ${run.status} (${run.stdout}${run.stderr})`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.roots[0].form, "exec");
    assert.equal(report.roots[0].resolvedCommand, `node ${root}/scripts/${OBSERVER_BASENAME}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("--verify-channel is red when the channel cannot be written", async () => {
  // `/dev/null` is a character device, so no directory can be created beneath it:
  // an unwritable sink that needs no privileges and no cleanup.
  const root = await liveRoot();
  try {
    const run = runCli(["--verify-channel", "--project-dir", root], { sink: "/dev/null/nope" });
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.status, "OBSERVE_CHANNEL_SEVERED");
    assert.equal(report.ok, false);
    assert.equal(report.reason, "append-failed");
    // The errno differs by platform (ENOTDIR on Linux, EEXIST on macOS); the gate must
    // carry whichever one it hit, so a red is diagnosable without re-running it.
    assert.ok(report.detail.length > 0, "a severed channel must say why");
    // The failure is discovered in ANOTHER process now, so the gate has to forward that
    // process's stderr or the errno would be lost at the boundary.
    assert.match(run.stderr, /OBSERVE_APPEND_FAILED/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a severed channel still never blocks: hook mode exits 0 and says so on stderr", async () => {
  const run = runCli([], { sink: "/dev/null/nope", input: hookPayload });
  assert.equal(run.status, 0, "observe mode must not turn a broken log into a blocked session");
  // Not silent, though: the empty catch is exactly what hid INC-040 for a whole
  // observation window.
  assert.match(run.stderr, /ssh-write-observer: OBSERVE_APPEND_FAILED/u);
  assert.match(run.stderr, /sink=\/dev\/null\/nope/u);
});

test("the channel gate is bound to the hook's write path: neutering the hook's append turns it red", async () => {
  // The world this closes: a gate that opens its own handle to the sink would stay
  // green while the hook writes nowhere — a gate testing a channel that exists only
  // for the gate. Removing the hook's append must therefore be visible to it.
  const anchor = `  if (appendObservation(entry)) return;`;
  assert.equal(source.split(anchor).length - 1, 1, "anchor must appear exactly once — refresh the proof");
  const mutantDir = await mkdtemp(join(tmpdir(), "inc041-mutant-scripts-"));
  await writeFile(join(mutantDir, OBSERVER_BASENAME), source.replace(anchor, `  if (true) return;`));
  const dir = await mkdtemp(join(tmpdir(), "inc040-severed-"));
  const sink = join(dir, "ssh-write-hits.jsonl");
  // Pre-seed a probe record from an earlier, healthy run. A gate that accepted any
  // probe record rather than the one it just wrote would go green on this alone.
  await writeFile(sink, `${JSON.stringify({ at: new Date().toISOString(), probe: true, nonce: "stale-from-a-previous-run" })}\n`);
  const healthy = await liveRoot();
  const neutered = await liveRoot(mutantDir);
  try {
    const green = runCli(["--verify-channel", "--project-dir", healthy], { sink });
    assert.equal(green.status, 0, "control: the unmutated hook is green on this same sink");

    const run = runCli(["--verify-channel", "--project-dir", neutered], { sink });
    assert.equal(run.status, 1, `expected exit 1, got ${run.status} (${run.stdout}${run.stderr})`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.status, "OBSERVE_CHANNEL_SEVERED");
    assert.equal(report.reason, "probe-record-absent");
  } finally {
    for (const path of [dir, mutantDir, healthy, neutered]) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

test("an unknown, misspelled or missing flag is reason-coded and non-zero", async () => {
  // The defect: every unrecognised invocation used to fall through to hook mode, read a
  // stdin nobody writes to, and exit 0 with empty stdout. A gate's green and a gate that
  // never ran were the same bytes, so one typo in package.json or ci.yml retires a CI step
  // silently. 64 is EX_USAGE — deliberately neither 0 (clean) nor 1 (red gate).
  const cases = [
    [["--verfiy-channel"], "UNKNOWN_MODE"],
    [["--verify-chanel", "--project-dir", "."], "UNKNOWN_MODE"],
    [["--verify"], "UNKNOWN_MODE"],
    [["--verify-channel"], "MISSING_PROJECT_DIR"],
    [["--verify-channel", "--project-dir"], "MISSING_OPERAND"],
    [["--verify-channel", "--project-dir", "--self-test"], "MISSING_OPERAND"],
    [["--verify-channel", "--project-dirs", "."], "UNKNOWN_FLAG"],
    [["--verify-channel", "--project-dir", ".", "--enforce"], "UNKNOWN_FLAG"],
    [["--self-test", "--project-dir", "."], "UNEXPECTED_ARGUMENT"],
    [["--classify"], "MISSING_OPERAND"],
    [["--classify", "git status", "extra"], "UNEXPECTED_ARGUMENT"],
  ];
  for (const [args, reason] of cases) {
    const run = runCli(args, { sink: join(workdir, "usage.jsonl") });
    assert.equal(run.status, 64, `${args.join(" ")} must exit 64, got ${run.status}`);
    assert.equal(run.stdout, "", `${args.join(" ")} must not look like a report`);
    const report = JSON.parse(run.stderr);
    assert.equal(report.status, "SSH_WRITE_OBSERVER_USAGE_ERROR");
    assert.equal(report.reason, reason, `${args.join(" ")} carried the wrong reason`);
  }
});

test("a run with no hook payload is not byte-identical to a passing run", async () => {
  // `node scripts/ssh-write-observer.mjs` with the flag dropped altogether: it is a hook
  // invocation with nothing on stdin. Exit 1, never 2 — for PreToolUse only exit 2 blocks
  // a tool call, so observe mode still cannot block anything.
  for (const input of ["", "not json at all", "42", "null"]) {
    const run = runCli([], { sink: join(workdir, "no-payload.jsonl"), input });
    assert.equal(run.status, 1, `stdin ${JSON.stringify(input)} must exit 1, got ${run.status}`);
    const report = JSON.parse(run.stderr);
    assert.equal(report.status, "SSH_WRITE_OBSERVER_NO_HOOK_PAYLOAD");
    assert.equal(report.reason, "HOOK_PAYLOAD_ABSENT");
  }
});

test("no invocation of the hook ever exits 2, the one status that would block a tool call", async () => {
  const sink = join(workdir, "never-two.jsonl");
  const payloads = [
    hookPayload,
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }),
    JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }),
    JSON.stringify({ tool_name: "Bash", tool_input: {} }),
    "",
    "not json at all",
  ];
  for (const input of payloads) {
    assert.notEqual(runCli([], { sink, input }).status, 2, `payload ${input.slice(0, 40)} must not block`);
    assert.notEqual(runCli([], { sink: "/dev/null/nope", input }).status, 2, "not even with a broken sink");
  }
});

test("the probe tag cannot be acquired without the gate's own environment", async () => {
  // The tag is what keeps the gate's traffic out of the observation count. It must be
  // unforgeable from the command line alone, or a real capture that happens to name the
  // probe directory would be discounted as gate traffic.
  const dir = await mkdtemp(join(tmpdir(), "inc041-tag-"));
  const sink = join(dir, "ssh-write-hits.jsonl");
  const nonce = "11111111-2222-3333-4444-555555555555";
  const command = `ssh tcrn-platform-placeholder "rm /var/lib/tcrn-placeholder/governance/tcrn-workspace/.observe-channel-probe/${nonce}"`;
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
  try {
    const env = { ...process.env, S2_OBSERVE_LOG: sink };
    delete env.S2_OBSERVE_PROBE;
    assert.equal(spawnSync(process.execPath, [SOURCE_PATH], { encoding: "utf8", env, input: payload }).status, 0);
    // Declaring a DIFFERENT nonce must not tag this record either.
    assert.equal(
      spawnSync(process.execPath, [SOURCE_PATH], { encoding: "utf8", env: { ...env, S2_OBSERVE_PROBE: "some-other-nonce" }, input: payload }).status,
      0,
    );
    const records = (await readFile(sink, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(Object.hasOwn(record, "probe"), false, "a probe-shaped command is not a probe record");
      assert.equal(Object.hasOwn(record, "nonce"), false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("observe semantics: classify never emits a blocking decision", async () => {
  const live = await import(pathToFileURL(SOURCE_PATH).href);
  for (const sample of live.CORPUS) {
    const got = live.classify(sample.command);
    assert.ok(["HIT", "PASS"].includes(got.verdict));
    assert.equal(Object.hasOwn(got, "permissionDecision"), false, "observe mode must not emit a permission decision");
  }
  assert.equal(source.includes("permissionDecision"), false, "switching to enforce is the review layer's call (MIN-058)");
});
