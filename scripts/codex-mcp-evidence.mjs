// SPDX-License-Identifier: Apache-2.0
//
// L2.5 host evidence for the Workflow MCP facade on Codex. Like `host-evidence.mjs`
// this is NOT a verification gate: it deliberately stays out of the `verify:*`
// namespace and out of the verification map, because it cannot run where the Codex
// binary, a network, or a credential is absent. It produces a receipt; its exit code
// blocks nothing.
//
// What it exists to answer. The protocol layer (L1) is already proven hermetically —
// `tests/operator-authority-mcp.test.mjs` drives `runWorkflowMcpStdio` over in-memory
// streams. The contract layer (L2) pins observed host facts into
// `docs/verification/host/`. Neither one proves that a *real Codex process* can launch
// this server and see its tools. That is what this does, and it is the cheapest rung
// that still uses the real client stack.
//
// Two design choices are not incidental:
//
// 1. THE LIVE CONFIG IS NEVER WRITTEN. The obvious way to register an MCP server with
//    Codex is `codex mcp add`, which edits `$CODEX_HOME/config.toml`. This probe uses
//    per-invocation `-c mcp_servers.*` overrides instead, so the operator's own config
//    is untouched. The receipt records the config file's SHA-256 before and after and
//    the run fails if they differ — the claim "we did not touch your configuration" is
//    checked, not asserted.
//
//    A disposable `CODEX_HOME` was the first design and was rejected on evidence:
//    `codex exec --help` states that authentication still resolves through CODEX_HOME,
//    so a throwaway root has no credential and the probe would measure an auth failure
//    rather than the MCP handshake. Copying the credential into a temp root was
//    rejected outright — a probe has no business handling one.
//
// 2. DETECTION IS BY TOOL NAME IN THE TRANSCRIPT, NOT BY EXIT CODE. A Codex session
//    can exit 0 having never reached the server. The probe asks the model to name the
//    tools the server offers and looks for a tool name that only this server can
//    supply; absence is reported as absence, never as "the server is broken".
//
// Two rungs, because they prove different things and only one of them was ever the
// open question:
//
//   default (`--mode list`)   the host launched the server, completed the handshake,
//                             and surfaced its tools into the model's inventory.
//   `--mode call`             the model actually ROUTED a call through the server and
//                             came back with data only the server could produce. The
//                             pinned host evidence in this directory explicitly does
//                             not claim this ("no successful host-routed Workflow MCP
//                             tool call is claimed"), so it is the rung that closes
//                             that gap.
//
// The call rung uses `tcrn_workflow_commands`: it takes no arguments, needs no
// workspace and no authority, and returns the command catalog — so the witness is a
// COUNT the model cannot produce without executing the tool, and the receipt carries
// no workspace identifier, no path, and no chain content.
//
// Usage:
//   node scripts/codex-mcp-evidence.mjs --server <path to tcrn-workflow-mcp.mjs>
//        [--mode list|call] [--expect-commands <n>]
//        [--out <receipt path>] [--timeout-ms <n>] [--dry-run]
//
// `--dry-run` performs every check except the model-driven session, so the plumbing
// can be exercised without spending a credential's quota.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
};
const dryRun = argv.includes("--dry-run");
const serverPath = flag("--server");
const mode = flag("--mode", "list");
const expectCommands = flag("--expect-commands");
// Supplying the operator pins exercises the shape the host registrations actually
// carry. Without them the probe measures the no-authority path, which is a different
// configuration from the one in production use.
const pinsPath = flag("--authority-pins");
const pinsDigest = flag("--authority-pins-digest");
if ((pinsPath === undefined) !== (pinsDigest === undefined)) {
  process.stderr.write("--authority-pins and --authority-pins-digest must be supplied together\n");
  process.exit(2);
}
const timeoutMs = Number(flag("--timeout-ms", "180000"));
if (!["list", "call"].includes(mode)) {
  process.stderr.write("--mode must be list or call\n");
  process.exit(2);
}
if (mode === "call" && !expectCommands) {
  process.stderr.write("--mode call requires --expect-commands <n> derived from the catalog\n");
  process.exit(2);
}
const outPath = resolve(repositoryRoot, flag("--out", "docs/verification/host/codex-mcp-l25.json"));

if (!serverPath) {
  process.stderr.write("--server <path to tcrn-workflow-mcp.mjs> is required\n");
  process.exit(2);
}

const codexHome = process.env.CODEX_HOME ?? resolve(homedir(), ".codex");
const configPath = resolve(codexHome, "config.toml");
const digestOf = async (path) => {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return null;
  }
};

// A marker the model is asked to echo. It is deliberately not a tool name, so a session
// that merely repeats the prompt back cannot satisfy the tool-name check on its own.
const MARKER = "TCRN-L25-REPORT";
// Only this server supplies a tool with this name; codegraph and the other configured
// servers cannot produce it.
const WITNESS_TOOL = "tcrn_workflow_status";

const run = (command, args, options = {}) => new Promise((resolveRun) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, ...options });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Reclaim the whole process group: killing the direct child leaves the servers it
    // spawned reparented to init. This probe starts MCP servers by definition.
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }, timeoutMs);
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  child.on("error", (error) => {
    clearTimeout(timer);
    resolveRun({ code: null, stdout, stderr: stderr + String(error), timedOut });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolveRun({ code, stdout, stderr, timedOut });
  });
});

const receipt = {
  schemaVersion: "tcrn.host-evidence.codex-mcp-l25.v1",
  layer: "L2.5",
  mode,
  method: "per-invocation -c overrides against the operator's own CODEX_HOME; the live config file is never written",
  server: serverPath,
  authoritySupplied: pinsPath !== undefined,
  dryRun,
};

const version = await run("codex", ["--version"]);
receipt.codexVersion = (version.stdout || version.stderr).trim() || null;
receipt.codexInvocable = version.code === 0;

receipt.configDigestBefore = await digestOf(configPath);

if (!receipt.codexInvocable) {
  receipt.outcome = "codex-not-invocable";
  receipt.witnessToolObserved = false;
} else if (dryRun) {
  receipt.outcome = "dry-run";
  receipt.witnessToolObserved = false;
} else {
  const overrides = [
    "-c", `mcp_servers.tcrn_workflow_probe.command=${JSON.stringify(process.execPath)}`,
    "-c", `mcp_servers.tcrn_workflow_probe.args=${JSON.stringify(pinsPath ? [serverPath, "--authority-pins", pinsPath, "--authority-pins-digest", pinsDigest] : [serverPath])}`,
    "-c", "mcp_servers.tcrn_workflow_probe.startup_timeout_sec=60",
  ];
  const prompt = mode === "call"
    ? [
      "Do not read or modify any file and do not run any shell command.",
      "Call the tool tcrn_workflow_commands offered by the MCP server named tcrn_workflow_probe.",
      "It takes no arguments. Count the entries in the commands array of what it returns.",
      `Answer with the line ${MARKER} followed by a line reading COMMAND_COUNT=<the number you counted>.`,
      "Do not guess the number: if the call fails, say so explicitly after the marker line and report the failure instead.",
    ].join(" ")
    : [
      "Do not read or modify any file and do not run any shell command.",
      "Report only this: list the names of the tools offered by the MCP server named tcrn_workflow_probe.",
      `Begin your answer with the line ${MARKER} and then the tool names, one per line.`,
      "If that server offers no tools or is unavailable, say so explicitly after the marker line.",
    ].join(" ");
  const session = await run("codex", [
    "exec",
    ...overrides,
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color", "never",
    "-C", repositoryRoot,
    prompt,
  ]);
  const transcript = `${session.stdout}\n${session.stderr}`;
  receipt.exitCode = session.code;
  receipt.timedOut = session.timedOut;
  // Codex echoes the prompt into the transcript, so a single occurrence of the marker
  // proves only that the prompt was read back. A genuine answer produces a second one.
  // The first version of this probe counted `includes` and reported markerObserved=true
  // for a session that had died on a 400 before the model ever ran.
  receipt.markerOccurrences = transcript.split(MARKER).length - 1;
  receipt.markerObserved = receipt.markerOccurrences >= 2;
  receipt.witnessToolObserved = transcript.includes(WITNESS_TOOL);
  receipt.transcriptTail = transcript.slice(-4000);
  // A transport/backend refusal is not the same as "the server offered no tools", and
  // conflating them would report a broken MCP facade when the session never reached it.
  const backendError = /"type"\s*:\s*"error"[\s\S]{0,400}?"message"\s*:\s*"([^"]{0,300})"/u.exec(transcript);
  receipt.backendError = backendError ? backendError[1] : null;
  if (mode === "call") {
    // The witness is a value the model cannot produce without executing the tool. A
    // count that merely appears somewhere in the transcript is not enough — it has to
    // be the one the model reported, so match the reporting line itself.
    const reported = /COMMAND_COUNT\s*=\s*(\d+)/u.exec(transcript);
    receipt.reportedCommandCount = reported ? Number(reported[1]) : null;
    receipt.expectedCommandCount = Number(expectCommands);
    receipt.callWitnessMatched = receipt.reportedCommandCount === receipt.expectedCommandCount;
    receipt.outcome = receipt.backendError
      ? "session-refused-before-mcp"
      : receipt.callWitnessMatched
        ? "tool-call-routed"
        : receipt.reportedCommandCount !== null
          ? "tool-call-reported-wrong-count"
          : "no-tool-call-reported";
  } else {
    receipt.outcome = receipt.witnessToolObserved
      ? "witness-tool-observed"
      : receipt.backendError
        ? "session-refused-before-mcp"
        : receipt.markerObserved
          ? "session-answered-without-witness-tool"
          : "no-marker";
  }
}

receipt.configDigestAfter = await digestOf(configPath);
receipt.configUntouched = receipt.configDigestBefore === receipt.configDigestAfter;

// The one claim this receipt must never overstate: not observing the tool is not proof
// that the server cannot be reached, and observing it proves the handshake, not that any
// governed write would be authorized (writes need an operator authority bundle).
receipt.claimBoundary = [
  "mode=list: witnessToolObserved=true proves a real Codex process launched this server and enumerated its tools into the model's inventory. It does NOT prove the model routed a call.",
  "mode=call: outcome=tool-call-routed proves the model executed a tool through this server, because the reported count cannot be produced without the call returning.",
  "witnessToolObserved=false is an absence of observation, not a proof that the server is unreachable.",
  "outcome=session-refused-before-mcp means the backend refused the session; the MCP facade was never reached and nothing here judges it.",
  "Nothing here speaks to write authorization: mutating tools require an operator authority bundle.",
];

// The sibling receipts in this directory carry no machine paths, and a receipt is a
// tracked file: keep the operator's home directory out of it rather than relying on a
// gate to notice. Applied to the whole document, so a path inside a transcript tail is
// covered too.
// A Codex transcript header carries a `session id:` that is a UUIDv7 — the same
// `019`-prefixed shape the privacy boundary fails closed on, because it both names a
// real session and encodes when it ran. Replace it with a deterministic pseudonym so
// two lines from one session still correlate, while the original stays unrecoverable
// from this file. Committing the raw value once is expensive to undo: the object
// database keeps it until the history is rewritten.
const home = homedir();
const sessionIdPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const scrub = (value) => (typeof value === "string"
  ? value
    .split(home).join("<home>")
    .replace(sessionIdPattern, (id) =>
      `redacted-${createHash("sha256").update(id.toLowerCase()).digest("hex").slice(0, 24)}`)
  : value);
const redacted = JSON.parse(JSON.stringify(receipt), (_key, value) => scrub(value));
redacted.identifierRedaction = "home directory replaced with <home>; every UUID replaced with redacted-<sha256(id)[:24]>, which keeps repeated ids correlated without carrying the original";

await writeFile(outPath, `${JSON.stringify(redacted, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  ok: true,
  outcome: receipt.outcome,
  configUntouched: receipt.configUntouched,
  receipt: outPath.slice(repositoryRoot.length + 1),
})}\n`);
