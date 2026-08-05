#!/usr/bin/env node
// S2 (TCRN-CROSS-STORY-144) — SSH-write heuristic observer (observe mode).
// INC-037 (TCRN-CROSS-INIT-018) rewrote the predicate: the first version matched
// regular expressions against the whole command line, which produced four proven
// defects (unanchored exemption substrings evaluated before the danger checks; any
// token before `ssh` — `env X=1`, `time`, `sudo`, `nohup` — hiding the transport;
// local redirection such as `2>&1` or `| tee` counting as a remote write; and four
// branches with no corpus coverage). The predicate is now argv-anchored: the command
// line is tokenized the way a shell would, the transport is resolved from the
// program position, and write primitives are looked for **only inside the command
// ssh hands to the remote shell**.
//
// PreToolUse hook matcher: flags Bash commands that would write to the governed
// chain tree on tcrn-platform-placeholder over SSH (redirection/tee/sed -i/cp/mv/rm via
// ssh, or rsync/scp toward the host, naming /var/lib/tcrn-placeholder/governance). OBSERVE MODE
// ONLY: it appends hits to a log file and never blocks. Switching to enforce is
// the review layer's call (MIN-058) once this observer has run without false
// positives — the whole point of the observe period.
//
// Modes:
//   (no args)                     PreToolUse hook: read the hook payload JSON on stdin,
//                                 log any HIT, exit 0. Exit 1 — a NON-blocking status for
//                                 PreToolUse, where only exit 2 blocks a tool call — when
//                                 no payload arrives at all, so that a run with no stdin
//                                 cannot be mistaken for a clean run of a gate.
//   --classify <command>          print {"verdict","reason"} JSON, exit 0.
//   --self-test                   run the adversarial corpus, print summary,
//                                 exit 0 only if every sample classifies as
//                                 its expected verdict AND reason.
//   --verify-channel --project-dir <dir> [--project-dir <dir> …]
//                                 prove the observation channel is alive end to end for
//                                 each named project root, by running that root's
//                                 REGISTERED hook command: OBSERVE_CHANNEL_LIVE / exit 0,
//                                 or OBSERVE_CHANNEL_SEVERED / exit 1 carrying a per-root
//                                 reason. At least one --project-dir is required: there is
//                                 no default roster, because a default roster is one
//                                 nobody re-reads at the call site.
//   anything else                 SSH_WRITE_OBSERVER_USAGE_ERROR on stderr, exit 64.
//                                 An unknown or misspelled flag must not be byte-identical
//                                 to a clean run — exit 0 with empty stdout is exactly how
//                                 a one-character typo in package.json or ci.yml retires a
//                                 CI step with nobody noticing.
//
// Where ambiguity resolves (the two sides are deliberately different):
//   * transport or destination cannot be resolved  → PASS. The observer never
//     attributes a write it cannot see; missing information fails toward not
//     flagging, and (in observe mode) never toward blocking.
//   * transport resolved, host matched, governed tree named, write primitive
//     present, but the write target cannot be shown to be outside the tree
//     → HIT. Once all four are established the burden has flipped; a HIT costs
//     one log line and nothing else while the observer is in observe mode.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// INC-040. The sink used to be `REPO_ROOT/docs/reports/init-018/S2/observed-hits.log`.
// INC-034 relocated the whole INIT-018 evidence bundle to TCRN-AOS, which deleted
// `tcrn-workflow/docs/reports/` — so every append threw ENOENT into an empty catch and
// the channel was dead for the entire observation window while the hook kept exiting 0
// and classifying correctly. The damage was not the lost lines: STORY-144's promotion
// predicate is "the observation period produced no false positive", and a severed
// channel makes "no false positive" and "no observation at all" the same byte sequence.
//
// Two changes follow from that. The sink now lives OUTSIDE any git checkout — the
// platform root is not a repository, so a runtime log under `var/` there pollutes no
// working tree and cannot be deleted by a repo-local evidence move again (same shape as
// TCRN-AOS/deploy/aos-local-client/ceremony-spans.mjs). And the channel now has a gate
// that can go red: see `verifyChannel` below.
const PLATFORM_ROOT = resolve(REPO_ROOT, "..");
const DEFAULT_LOG = resolve(PLATFORM_ROOT, "var/tcrn-observe/ssh-write-hits.jsonl");

// Anchored to a whole host name: `tcrn-platform-placeholder-staging` is a different machine
// and a local directory whose name merely contains the host is not a transport.
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
// descriptor and open nothing, so they are excluded at the parse site (`dup`).
const WRITE_REDIRECT_OPS = new Set([">", ">>", ">|", "&>", "&>>"]);

// Programs whose whole job is to modify a file they are given. Matched on the
// program position of a remote segment (basename), never as a substring of a line.
const WRITE_COMMANDS = new Set(["cp", "mv", "rm", "dd", "install", "touch", "tee"]);

// Commands that run another command; the transport can hide behind any chain of
// them. Values are the wrapper's own flags that consume the following token.
const WRAPPERS = new Map([
  ["env", { flagsWithArg: new Set(["-u", "-C", "-S", "--unset", "--chdir"]) }],
  ["time", { flagsWithArg: new Set(["-f", "-o", "--format", "--output"]) }],
  ["sudo", { flagsWithArg: new Set(["-u", "-g", "-p", "-C", "-h", "-r", "-t", "-U", "--user", "--group", "--prompt", "--host"]) }],
  ["doas", { flagsWithArg: new Set(["-u", "-C"]) }],
  ["nohup", { flagsWithArg: new Set() }],
  ["command", { flagsWithArg: new Set() }],
  ["exec", { flagsWithArg: new Set(["-a"]) }],
  ["nice", { flagsWithArg: new Set(["-n", "--adjustment"]) }],
  ["ionice", { flagsWithArg: new Set(["-c", "-n", "-p", "-P", "-u"]) }],
  ["stdbuf", { flagsWithArg: new Set(["-i", "-o", "-e"]) }],
  ["setsid", { flagsWithArg: new Set() }],
  ["timeout", { flagsWithArg: new Set(["-s", "-k", "--signal", "--kill-after"]), leadingOperand: /^\d+(?:\.\d+)?[smhd]?$/u }],
]);

// ssh's own options, split by whether they consume the next token — needed so the
// destination is read from the right position (`ssh -p 2222 host cmd`).
const SSH_FLAGS_WITH_ARG = new Set([
  "-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m",
  "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w",
]);

// Interpreters: `node <script>` makes <script> the thing actually being run.
const RUNNERS = new Set(["node", "nodejs", "node24"]);

// The one program on that host allowed to write inside the governed tree is the
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
const SCRATCH_ROOTS = ["/tmp/", "/var/tmp/", "/run/", "/dev/null"];

// Exemptions are ANCHORED matchers over the argv of a write-bearing remote segment,
// and they are evaluated AFTER the host/governance/write-primitive checks — never
// before, so naming an exempt script can no longer wave a dangerous command through.
// Every entry additionally passes through the shared guard in `exemptionFor`: each
// write target must be an absolute path outside the governed tree.
const EXEMPTIONS = [
  {
    id: "host-engine",
    matches: (unit) =>
      unit.argv.some(
        (token, index) =>
          HOST_ENGINE.test(token.value) && (index === 0 || RUNNERS.has(basename(unit.argv[index - 1].value))),
      ),
  },
  {
    id: "scratch-target",
    matches: (unit) => unit.targets.every(isScratchTarget),
  },
];

function basename(value) {
  const text = String(value);
  const cut = text.lastIndexOf("/");
  return cut === -1 ? text : text.slice(cut + 1);
}

function isAssignment(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

function isScratchTarget(target) {
  return SCRATCH_ROOTS.some((root) => (root.endsWith("/") ? target.startsWith(root) : target === root));
}

function isSafeTarget(target) {
  return target.startsWith("/") && !GOVERNANCE.test(target);
}

function readDoubleQuoted(text, start) {
  let index = start + 1;
  let value = "";
  while (index < text.length) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      value += text[index + 1];
      index += 2;
      continue;
    }
    if (char === '"') return { value, next: index + 1 };
    value += char;
    index += 1;
  }
  return { value, next: text.length };
}

// Shell-shaped tokenizer: splits a command line into segments at `; & && || | newline`
// and at command substitution, keeps quoting (so a quoted remote command stays one
// token), and lifts redirections out of argv into their own list. Lifting them is
// what stops a LOCAL `2>&1` or `> file` from being read as part of a remote command.
export function parseSegments(input) {
  const text = typeof input === "string" ? input : "";
  const segments = [];
  let argv = [];
  let redirects = [];
  let cur = "";
  let quoted = false;
  let started = false;
  let i = 0;
  const n = text.length;

  const flushToken = () => {
    if (!started) return;
    argv.push({ value: cur, quoted });
    cur = "";
    quoted = false;
    started = false;
  };
  const flushSegment = () => {
    flushToken();
    if (argv.length > 0 || redirects.length > 0) segments.push({ argv, redirects });
    argv = [];
    redirects = [];
  };
  const readWord = () => {
    while (i < n && (text[i] === " " || text[i] === "\t")) i += 1;
    let value = "";
    let seen = false;
    while (i < n) {
      const char = text[i];
      if (" \t\n;|&<>()`".includes(char)) break;
      if (char === "'") {
        const end = text.indexOf("'", i + 1);
        if (end === -1) {
          value += text.slice(i + 1);
          i = n;
          seen = true;
          break;
        }
        value += text.slice(i + 1, end);
        i = end + 1;
        seen = true;
        continue;
      }
      if (char === '"') {
        const read = readDoubleQuoted(text, i);
        value += read.value;
        i = read.next;
        seen = true;
        continue;
      }
      if (char === "\\" && i + 1 < n) {
        value += text[i + 1];
        i += 2;
        seen = true;
        continue;
      }
      value += char;
      i += 1;
      seen = true;
    }
    return seen ? value : null;
  };

  while (i < n) {
    const char = text[i];
    if (char === "'") {
      const end = text.indexOf("'", i + 1);
      cur += end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      quoted = true;
      started = true;
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (char === '"') {
      const read = readDoubleQuoted(text, i);
      cur += read.value;
      quoted = true;
      started = true;
      i = read.next;
      continue;
    }
    if (char === "\\") {
      if (i + 1 < n) {
        cur += text[i + 1];
        started = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (char === "#" && !started) {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (char === " " || char === "\t") {
      flushToken();
      i += 1;
      continue;
    }
    if (char === "\n" || char === ";") {
      flushSegment();
      i += 1;
      continue;
    }
    if (char === "|") {
      flushSegment();
      i += 1;
      if (text[i] === "|" || text[i] === "&") i += 1;
      continue;
    }
    if (char === "&") {
      if (text[i + 1] === ">") {
        flushToken();
        let op = "&>";
        i += 2;
        if (text[i] === ">") {
          op = "&>>";
          i += 1;
        }
        redirects.push({ op, fd: null, target: readWord(), dup: false });
        continue;
      }
      flushSegment();
      i += 1;
      if (text[i] === "&") i += 1;
      continue;
    }
    // `$(…)`, `` `…` `` and subshells all start a new command: splitting on the
    // bracket alone covers `$(` too, so there is no separate branch for it — an
    // inert branch is the defect this file was rewritten to remove.
    if (char === "`" || char === "(" || char === ")") {
      flushSegment();
      i += 1;
      continue;
    }
    if (char === ">" || char === "<") {
      let fd = null;
      if (started && !quoted && /^\d+$/u.test(cur)) {
        fd = cur;
        cur = "";
        started = false;
      } else {
        flushToken();
      }
      let op;
      if (char === ">") {
        op = ">";
        i += 1;
        if (text[i] === ">") {
          op = ">>";
          i += 1;
        } else if (text[i] === "|") {
          op = ">|";
          i += 1;
        }
      } else {
        op = "<";
        i += 1;
        if (text[i] === "<") {
          op = "<<";
          i += 1;
          if (text[i] === "<") {
            op = "<<<";
            i += 1;
          }
        }
      }
      if (text[i] === "&" && /[\d-]/u.test(text[i + 1] ?? "")) {
        let end = i + 1;
        let dup = "&";
        while (end < n && /[\d-]/u.test(text[end])) {
          dup += text[end];
          end += 1;
        }
        i = end;
        redirects.push({ op, fd, target: dup, dup: true });
        continue;
      }
      redirects.push({ op, fd, target: readWord(), dup: false });
      continue;
    }
    cur += char;
    started = true;
    i += 1;
  }
  flushSegment();
  return segments;
}

// Walk past leading `NAME=value` assignments and any chain of wrapper commands, and
// return the index of the program actually being executed.
function skipWrappers(argv) {
  let index = 0;
  while (index < argv.length && isAssignment(argv[index].value)) index += 1;
  while (index < argv.length) {
    const wrapper = WRAPPERS.get(basename(argv[index].value));
    if (!wrapper) break;
    index += 1;
    while (index < argv.length) {
      const token = argv[index].value;
      if (token === "--") {
        index += 1;
        break;
      }
      if (isAssignment(token)) {
        index += 1;
        continue;
      }
      if (token.startsWith("-") && token.length > 1) {
        const key = token.includes("=") ? token.slice(0, token.indexOf("=")) : token.slice(0, 2);
        const attached = token.includes("=") || token.length > 2;
        index += 1;
        if (!attached && wrapper.flagsWithArg.has(key)) index += 1;
        continue;
      }
      if (wrapper.leadingOperand?.test(token)) {
        index += 1;
        continue;
      }
      break;
    }
  }
  return index;
}

function parseSsh(args) {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token.quoted || !token.value.startsWith("-") || token.value === "-") break;
    if (token.value === "--") {
      index += 1;
      break;
    }
    const key = token.value.slice(0, 2);
    index += SSH_FLAGS_WITH_ARG.has(key) && token.value.length === 2 ? 2 : 1;
  }
  const destination = args[index];
  if (!destination) return { kind: "ssh", host: null, remote: "" };
  const at = destination.value.lastIndexOf("@");
  const host = at === -1 ? destination.value : destination.value.slice(at + 1);
  // OPTIONS MAY FOLLOW THE DESTINATION. ssh accepts `ssh host -p 2222 "cmd"`, and the
  // first pass above stops at the destination — so a second option scan is needed or
  // the remote command is read as starting at `-p`, and every write primitive in it
  // is missed. Found by the INC-037 reviewer against the first version of this fix:
  // `ssh tcrn-platform-placeholder -p 2222 "rm …/workspace/index.json"` was judged a pass.
  let rest = index + 1;
  while (rest < args.length) {
    const token = args[rest];
    if (token.quoted || !token.value.startsWith("-") || token.value === "-") break;
    if (token.value === "--") { rest += 1; break; }
    const key = token.value.slice(0, 2);
    rest += SSH_FLAGS_WITH_ARG.has(key) && token.value.length === 2 ? 2 : 1;
  }
  // ssh joins its remaining arguments with a space and hands the result to the
  // remote shell — so the remote command is exactly that join, and nothing the
  // local shell consumed (redirections, other segments) belongs to it.
  return { kind: "ssh", host, remote: args.slice(rest).map((token) => token.value).join(" ") };
}

function parseTransfer(kind, args) {
  const remoteSpecs = [];
  for (const token of args) {
    const match = /^(?:[^@:/\s]+@)?([A-Za-z0-9._-]+):(.+)$/u.exec(token.value);
    if (match && HOST_NAME.test(match[1])) remoteSpecs.push({ host: match[1], path: match[2] });
  }
  return { kind, remoteSpecs };
}

function resolveTransport(segment) {
  const start = skipWrappers(segment.argv);
  if (start >= segment.argv.length) return { kind: "none" };
  const program = basename(segment.argv[start].value);
  const args = segment.argv.slice(start + 1);
  if (program === "ssh") return parseSsh(args);
  if (program === "rsync" || program === "scp") return parseTransfer(program, args);
  return { kind: "none" };
}

// `bash -c '<script>'` on the far side is one more layer of shell, not an opaque
// argument: the script it carries is what actually runs there.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

function shellScriptArgument(argv) {
  if (argv.length === 0 || !SHELLS.has(basename(argv[0].value))) return null;
  const flag = argv.findIndex((token, index) => index > 0 && !token.quoted && /^-[a-z]*c$/u.test(token.value));
  if (flag === -1) return null;
  return argv[flag + 1]?.value ?? null;
}

function operands(argv) {
  return argv.slice(1).filter((token) => token.quoted || !token.value.startsWith("-")).map((token) => token.value);
}

// The write primitives of the command ssh hands to the remote shell — one unit per
// remote segment that would modify a file, with the targets it names.
function remoteWriteUnits(remoteCommand, depth = 0) {
  const units = [];
  for (const segment of parseSegments(remoteCommand)) {
    const argv = segment.argv.slice(skipWrappers(segment.argv));
    const program = argv.length > 0 ? basename(argv[0].value) : "";
    const targets = [];
    let write = false;
    for (const redirect of segment.redirects) {
      if (redirect.dup || !WRITE_REDIRECT_OPS.has(redirect.op)) continue;
      write = true;
      if (redirect.target) targets.push(redirect.target);
    }
    if (WRITE_COMMANDS.has(program)) {
      write = true;
      targets.push(...operands(argv));
    } else if (program === "sed" && argv.some((token) => /^-i/u.test(token.value) || token.value.startsWith("--in-place"))) {
      write = true;
      targets.push(...operands(argv));
    }
    if (write) units.push({ argv, program, targets });
    // `depth` is a bound, not a judgement: nesting strictly shrinks the string, so
    // this only caps pathological input. It is deliberately not claimed as a covered
    // branch — no command can distinguish its two sides.
    const script = depth < 4 ? shellScriptArgument(argv) : null;
    if (script) units.push(...remoteWriteUnits(script, depth + 1));
  }
  return units;
}

function exemptionFor(units) {
  const matched = [];
  for (const unit of units) {
    if (unit.targets.length === 0) return null;
    if (!unit.targets.every(isSafeTarget)) return null;
    const entry = EXEMPTIONS.find((candidate) => candidate.matches(unit));
    if (!entry) return null;
    matched.push(entry.id);
  }
  return matched.length > 0 ? matched[0] : null;
}

function classifyInner(command) {
  // Reason ranks record how far the most advanced segment got, so a PASS says which
  // check stopped it rather than which segment happened to be last.
  let rank = 0;
  let reason = "no-host-transport";
  const note = (candidateRank, candidateReason) => {
    if (candidateRank > rank) {
      rank = candidateRank;
      reason = candidateReason;
    }
  };
  for (const segment of parseSegments(command)) {
    const transport = resolveTransport(segment);
    if (transport.kind === "ssh") {
      if (!transport.host || !HOST_NAME.test(transport.host)) continue;
      note(1, "no-governance-path");
      if (!GOVERNANCE.test(transport.remote)) continue;
      note(2, "no-write-primitive");
      const units = remoteWriteUnits(transport.remote);
      if (units.length === 0) continue;
      const exemption = exemptionFor(units);
      if (exemption) {
        note(3, `exemption:${exemption}`);
        continue;
      }
      return { verdict: "HIT", reason: "ssh-write" };
    }
    if (transport.kind === "rsync" || transport.kind === "scp") {
      if (transport.remoteSpecs.length === 0) continue;
      note(1, "no-governance-path");
      if (!transport.remoteSpecs.some((spec) => GOVERNANCE.test(spec.path))) continue;
      return { verdict: "HIT", reason: transport.kind };
    }
  }
  return { verdict: "PASS", reason };
}

export function classify(command) {
  try {
    return classifyInner(command ?? "");
  } catch {
    // A parser fault must never turn into a blocked session: fail toward PASS.
    return { verdict: "PASS", reason: "parse-error" };
  }
}

const GOV_CROSS = "/var/lib/tcrn-placeholder/governance/tcrn-workspace/cross-project/workspace";
const GOV_AOS = "/var/lib/tcrn-placeholder/governance/tcrn-workspace/TCRN-AOS/workspace";
const HOST_ENGINE_CLI = "/var/lib/tcrn-placeholder/engine/tcrn-workflow/scripts/tcrn-workflow.mjs";

// Every sample asserts a verdict AND the reason, so removing any single decision
// branch or list entry turns at least one sample red (see ssh-write-observer.test.mjs,
// which proves that mechanically by mutating this source).
export const CORPUS = [
  // --- A. the original S2 corpus: verdicts must not regress -------------------
  { id: "A01", command: `ssh tcrn-platform-placeholder "cat > ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "A02", command: `ssh tcrn-platform-placeholder "echo x > ${GOV_AOS}/ledger.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "A03", command: `ssh tcrn-platform-placeholder "printf 'x' >> ${GOV_CROSS}/events.jsonl"`, expect: "HIT", reason: "ssh-write" },
  { id: "A04", command: `ssh tcrn-platform-placeholder "tee ${GOV_AOS}/status.json <<< '{}'"`, expect: "HIT", reason: "ssh-write" },
  { id: "A05", command: `ssh tcrn-platform-placeholder "sed -i 's/a/b/' ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "A06", command: `ssh tcrn-platform-placeholder "cp /tmp/f ${GOV_CROSS}/file"`, expect: "HIT", reason: "ssh-write" },
  { id: "A07", command: `ssh tcrn-platform-placeholder "mv /tmp/f ${GOV_CROSS}/file"`, expect: "HIT", reason: "ssh-write" },
  { id: "A08", command: `ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "A09", command: `rsync -av ./local tcrn-platform-placeholder:${GOV_CROSS}/`, expect: "HIT", reason: "rsync" },
  { id: "A10", command: `scp ./f tcrn-platform-placeholder:${GOV_CROSS}/f`, expect: "HIT", reason: "scp" },
  { id: "A11", command: `node deploy/aos-local-client/ceremony.mjs --payload x.json --partition cross-project --dry-run`, expect: "PASS", reason: "no-host-transport" },
  { id: "A12", command: `node deploy/aos-local-client/ceremony.mjs --payload x.json --partition cross-project --receipt r.json`, expect: "PASS", reason: "no-host-transport" },
  { id: "A13", command: `node deploy/aos-resident-cockpit/paired-backup.mjs --pull --workspace cross-project`, expect: "PASS", reason: "no-host-transport" },
  { id: "A14", command: `pnpm --dir TCRN-AOS engine-host:verify`, expect: "PASS", reason: "no-host-transport" },
  { id: "A15", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} status --workspace ${GOV_CROSS}"`, expect: "PASS", reason: "no-write-primitive" },
  { id: "A16", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} work-show --id work:x --workspace ${GOV_CROSS}"`, expect: "PASS", reason: "no-write-primitive" },
  { id: "A17", command: `ssh tcrn-platform-placeholder "ls /var/lib/tcrn-placeholder/governance/"`, expect: "PASS", reason: "no-write-primitive" },
  { id: "A18", command: `ssh tcrn-platform-placeholder "systemctl status tcrn-aos-cockpit"`, expect: "PASS", reason: "no-governance-path" },
  { id: "A19", command: `node scripts/ship-web.mjs --dry-run`, expect: "PASS", reason: "no-host-transport" },
  { id: "A20", command: `curl -s http://198.51.51.249:4319/api/health`, expect: "PASS", reason: "no-host-transport" },
  { id: "A21", command: `git push origin main`, expect: "PASS", reason: "no-host-transport" },

  // --- B. defect 1: an exempt name no longer waves a dangerous command through -
  { id: "B01", command: `ssh tcrn-platform-placeholder "cp /tmp/ceremony.mjs ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "B02", command: `ssh tcrn-platform-placeholder "rm ${GOV_AOS}/index.json # replaces paired-backup.mjs"`, expect: "HIT", reason: "ssh-write" },
  { id: "B03", command: `ssh tcrn-platform-placeholder "sed -i 's/a/b/' ${GOV_CROSS}/ship-web.mjs.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "B04", command: `ssh tcrn-platform-placeholder "mv ${GOV_CROSS}/index.json /tmp/engine-host:verify"`, expect: "HIT", reason: "ssh-write" },
  { id: "B05", command: `ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/${basename(HOST_ENGINE_CLI)}"`, expect: "HIT", reason: "ssh-write" },

  // --- C. defect 2: a token before `ssh` no longer hides the transport ---------
  { id: "C01", command: `env TCRN_DEBUG=1 ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C02", command: `time ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C03", command: `sudo -u root ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C04", command: `nohup ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C05", command: `command ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C06", command: `TCRN_DEBUG=1 ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C07", command: `timeout 30 ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C08", command: `nice -n 10 ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C09", command: `ionice -c 3 ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C10", command: `stdbuf -oL ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C11", command: `exec ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C12", command: `setsid ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C13", command: `doas ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C14", command: `env TCRN_DEBUG=1 sudo -u root nohup ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "C15", command: `out=$(ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json")`, expect: "HIT", reason: "ssh-write" },
  { id: "C16", command: `env X=1 ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} export --workspace ${GOV_CROSS} | tee ${GOV_CROSS}/leak.json"`, expect: "HIT", reason: "ssh-write" },

  // --- D. defect 3: local write primitives are not remote writes ---------------
  { id: "D01", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} status --workspace ${GOV_CROSS}" 2>&1`, expect: "PASS", reason: "no-write-primitive" },
  { id: "D02", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} export --workspace ${GOV_CROSS}" > /tmp/export.json`, expect: "PASS", reason: "no-write-primitive" },
  { id: "D03", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} work-list --workspace ${GOV_CROSS}" | tee /tmp/work.log`, expect: "PASS", reason: "no-write-primitive" },
  { id: "D04", command: `rm -rf /tmp/scratch && ssh tcrn-platform-placeholder "ls ${GOV_CROSS}"`, expect: "PASS", reason: "no-write-primitive" },
  { id: "D05", command: `ssh tcrn-platform-placeholder "ls ${GOV_CROSS}" && rm -rf /tmp/scratch`, expect: "PASS", reason: "no-write-primitive" },
  { id: "D06", command: `cp /tmp/a /tmp/b; ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} status --workspace ${GOV_CROSS}"`, expect: "PASS", reason: "no-write-primitive" },
  { id: "D07", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} status --workspace ${GOV_CROSS} 2>&1"`, expect: "PASS", reason: "no-write-primitive" },
  { id: "D08", command: `rsync -av ./tcrn-platform-placeholder-mirror/var/lib/tcrn-placeholder/governance ./backup`, expect: "PASS", reason: "no-host-transport" },
  { id: "D09", command: `scp /tmp/a /tmp/b # tcrn-platform-placeholder:${GOV_CROSS}/x`, expect: "PASS", reason: "no-host-transport" },
  { id: "D10", command: `echo "ssh tcrn-platform-placeholder rm ${GOV_CROSS}/index.json" >> /tmp/notes.txt`, expect: "PASS", reason: "no-host-transport" },
  { id: "D11", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} work-list --workspace ${GOV_CROSS}" > ./docs/reports/init-018/INC-037/outputs/work-list.json`, expect: "PASS", reason: "no-write-primitive" },
  // The PASS reason names the check that stopped the most advanced segment, not the
  // last one: segment 1 reaches the write-primitive check, segment 2 stops earlier.
  { id: "D12", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} status --workspace ${GOV_CROSS}" && ssh tcrn-platform-placeholder "systemctl status tcrn-aos-cockpit"`, expect: "PASS", reason: "no-write-primitive" },

  // --- E. anchoring of host, path and transport -------------------------------
  { id: "E01", command: `ssh other-host "rm ${GOV_CROSS}/index.json"`, expect: "PASS", reason: "no-host-transport" },
  { id: "E02", command: `ssh tcrn-platform-placeholder-staging "rm ${GOV_CROSS}/index.json"`, expect: "PASS", reason: "no-host-transport" },
  { id: "E03", command: `ssh tcrn-platform-placeholder "rm /var/lib/tcrn-placeholder/aos-cockpit/web/x"`, expect: "PASS", reason: "no-governance-path" },
  { id: "E04", command: `ssh tcrn-platform-placeholder "rm /var/lib/tcrn-placeholder/governance-mirror/x"`, expect: "PASS", reason: "no-governance-path" },
  { id: "E05", command: `ssh -p 2222 -o StrictHostKeyChecking=no tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "E06", command: `ssh -tt history-user-host.invalid "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "E07", command: `ssh tcrn-platform-placeholder`, expect: "PASS", reason: "no-governance-path" },
  { id: "E08", command: ``, expect: "PASS", reason: "no-host-transport" },
  { id: "E09", command: `rsync -av tcrn-platform-placeholder:${GOV_CROSS}/ ./offsite/`, expect: "HIT", reason: "rsync" },
  { id: "E10", command: `rsync -av ./dist tcrn-platform-placeholder:/var/lib/tcrn-placeholder/aos-cockpit/web/`, expect: "PASS", reason: "no-governance-path" },
  { id: "E11", command: `scp tcrn-platform-placeholder:${GOV_CROSS}/index.json /tmp/`, expect: "HIT", reason: "scp" },
  { id: "E12", command: `rsync -e "ssh -p 2222" -av ./local tcrn-platform-placeholder:${GOV_CROSS}/x`, expect: "HIT", reason: "rsync" },
  { id: "E13", command: `ssh tcrn-platform-placeholder "dd if=/tmp/f of=${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "E14", command: `ssh tcrn-platform-placeholder "install -m 644 /tmp/f ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "E15", command: `ssh tcrn-platform-placeholder "touch ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "E16", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} export --workspace ${GOV_CROSS} &> /var/lib/tcrn-placeholder/aos-cockpit/web/export.json"`, expect: "PASS", reason: "exemption:host-engine" },
  { id: "E17", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} export --workspace ${GOV_CROSS} | tee"`, expect: "HIT", reason: "ssh-write" },
  { id: "E18", command: `/usr/bin/ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "E19", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} export --workspace ${GOV_CROSS} >| ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "E20", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} export --workspace ${GOV_CROSS} &>> ${GOV_CROSS}/events.jsonl"`, expect: "HIT", reason: "ssh-write" },
  { id: "E21", command: `(ssh tcrn-platform-placeholder "rm ${GOV_CROSS}/index.json")`, expect: "HIT", reason: "ssh-write" },
  { id: "E22", command: "out=`ssh tcrn-platform-placeholder \"rm " + GOV_CROSS + "/index.json\"`", expect: "HIT", reason: "ssh-write" },
  { id: "E23", command: `rsync -av ./local other-host:${GOV_CROSS}/`, expect: "PASS", reason: "no-host-transport" },

  // --- F. the exemption stage: it fires, and it refuses ------------------------
  { id: "F01", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} export --workspace ${GOV_CROSS} > /tmp/export.json"`, expect: "PASS", reason: "exemption:host-engine" },
  { id: "F02", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} export --workspace ${GOV_CROSS} > /var/lib/tcrn-placeholder/aos-cockpit/web/export.json"`, expect: "PASS", reason: "exemption:host-engine" },
  { id: "F03", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} export --workspace ${GOV_CROSS} > ${GOV_CROSS}/leak.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "F04", command: `ssh tcrn-platform-placeholder "touch /tmp/tcrn-lock && node ${HOST_ENGINE_CLI} status --workspace ${GOV_CROSS}"`, expect: "PASS", reason: "exemption:scratch-target" },
  { id: "F05", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} event-list --workspace ${GOV_CROSS} | tee /tmp/events.log"`, expect: "PASS", reason: "exemption:scratch-target" },
  { id: "F06", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} status --workspace ${GOV_CROSS} > /tmp/a.json; rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "F07", command: `ssh tcrn-platform-placeholder "cp /var/lib/tcrn-placeholder/backups/${basename(HOST_ENGINE_CLI)} /var/lib/tcrn-placeholder/backups/engine-copy.mjs && node ${HOST_ENGINE_CLI} status --workspace ${GOV_CROSS}"`, expect: "HIT", reason: "ssh-write" },
  { id: "F08", command: `ssh tcrn-platform-placeholder "cd ${GOV_CROSS} && rm index.json"`, expect: "HIT", reason: "ssh-write" },
  // A stray copy of the engine is not the installed engine: the exemption is
  // anchored on the installed path, not on the script's name.
  { id: "F09", command: `ssh tcrn-platform-placeholder "node /var/lib/tcrn-placeholder/backups/${basename(HOST_ENGINE_CLI)} export --workspace ${GOV_CROSS} > /var/lib/tcrn-placeholder/backups/export.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "F10", command: `ssh tcrn-platform-placeholder "${HOST_ENGINE_CLI} export --workspace ${GOV_CROSS} > /var/lib/tcrn-placeholder/aos-cockpit/web/export.json"`, expect: "PASS", reason: "exemption:host-engine" },
  { id: "F11", command: `ssh tcrn-platform-placeholder "touch /var/tmp/tcrn-lock && node ${HOST_ENGINE_CLI} status --workspace ${GOV_CROSS}"`, expect: "PASS", reason: "exemption:scratch-target" },
  { id: "F12", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} status --workspace ${GOV_CROSS} | tee /dev/null"`, expect: "PASS", reason: "exemption:scratch-target" },
  { id: "F13", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} export --workspace ${GOV_CROSS} > export.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "F14", command: `ssh tcrn-platform-placeholder "touch /run/tcrn.lock && node ${HOST_ENGINE_CLI} status --workspace ${GOV_CROSS}"`, expect: "PASS", reason: "exemption:scratch-target" },
  { id: "F15", command: `ssh tcrn-platform-placeholder "node ${HOST_ENGINE_CLI} status --workspace ${GOV_CROSS} | tee /tmp/out.log 2> /tmp/err.log"`, expect: "PASS", reason: "exemption:scratch-target" },

  // --- G. one more shell between ssh and the write ----------------------------
  { id: "G01", command: `ssh tcrn-platform-placeholder "bash -c 'rm ${GOV_CROSS}/index.json'"`, expect: "HIT", reason: "ssh-write" },
  { id: "G02", command: `ssh tcrn-platform-placeholder "sudo rm ${GOV_CROSS}/index.json"`, expect: "HIT", reason: "ssh-write" },
  { id: "G03", command: `ssh tcrn-platform-placeholder "sh -lc 'sed -i s/a/b/ ${GOV_CROSS}/index.json'"`, expect: "HIT", reason: "ssh-write" },
  { id: "G04", command: `ssh tcrn-platform-placeholder "bash -c 'node ${HOST_ENGINE_CLI} status --workspace ${GOV_CROSS}'"`, expect: "PASS", reason: "no-write-primitive" },
];

export function runSelfTest() {
  const mismatches = [];
  for (const sample of CORPUS) {
    const result = classify(sample.command);
    if (result.verdict !== sample.expect || result.reason !== sample.reason) {
      mismatches.push({
        id: sample.id,
        command: sample.command,
        expected: `${sample.expect}/${sample.reason}`,
        got: `${result.verdict}/${result.reason}`,
      });
    }
  }
  return {
    total: CORPUS.length,
    hits: CORPUS.filter((sample) => sample.expect === "HIT").length,
    passes: CORPUS.filter((sample) => sample.expect === "PASS").length,
    mismatches,
    ok: mismatches.length === 0,
  };
}

// Resolved per call, never cached: the override has to be readable at the moment the
// hook runs, and the gate below must resolve the SAME path the hook would.
export function observeLogPath() {
  return process.env.S2_OBSERVE_LOG ?? DEFAULT_LOG;
}

// Last append failure, for diagnostics. `null` means the last append succeeded — so a
// gate that finds nothing in the sink can distinguish "the write threw" from "the write
// claimed success and the bytes are not there".
let lastAppendError = null;

// THE ONE WRITE PATH. Both `logHit` (the hook) and `verifyChannel` (the gate) reach the
// sink only through this function, and both resolve the location only through
// `observeLogPath()`. Nothing else in this file opens the sink.
//
// That is deliberate, and it is what closes the "gate green while the channel is dead"
// world: if the gate opened its own file handle, or computed its own path, it would be
// testing a channel that exists solely for the gate — exactly the failure INC-040 is.
function appendObservation(record) {
  const path = observeLogPath();
  try {
    // INC-040: the directory may legitimately not exist yet (first hit after a fresh
    // checkout, or a fresh `S2_OBSERVE_LOG` target). Creating it is part of the write.
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
    lastAppendError = null;
    return true;
  } catch (error) {
    // `error.message` already carries the errno code, so it is used verbatim rather
    // than prefixed with `error.code` again.
    lastAppendError = error?.message ?? String(error);
    return false;
  }
}

function logHit(entry) {
  if (appendObservation(entry)) return;
  // observe mode: a failed log write must never block the session
  // — but silence is what let INC-040 run for a whole observation window, so the
  // failure is announced on stderr. The hook still returns normally and still exits 0;
  // stderr is a diagnostic channel here, not a decision.
  //
  // `writeSync(2, …)`, not `process.stderr.write`: on macOS a pipe-backed stderr is
  // asynchronous, and the hook calls `process.exit(0)` immediately afterwards, which
  // discards whatever is still buffered. Measured — the first version of this line
  // produced an empty stderr under the test harness while the code path had run. An
  // observability channel that disappears when it is observed is the INC-040 defect
  // a second time.
  try {
    writeSync(2, `ssh-write-observer: OBSERVE_APPEND_FAILED sink=${observeLogPath()} error=${lastAppendError}\n`);
  } catch {
    // stderr itself is gone (closed fd); there is nowhere left to report to, and
    // observe mode still must not block.
  }
}

// The gate tags its own probe by declaring, in the environment of the process it starts,
// the nonce it is about to feed in. The tag is inert unless BOTH hold: the environment
// declares a nonce, and the command being classified carries that exact nonce. A session's
// hook never has the variable set, so a real capture can never acquire the tag; and the
// gate can never mistake a real capture for its own probe.
//
// This replaced an `extra` parameter that the previous gate passed by calling this
// function directly. Nothing can pass a parameter to the hook any more, because the gate
// no longer calls the hook — it starts the registered command as a process, exactly as the
// host does, and the tag has to survive that boundary.
export const PROBE_ENV = "S2_OBSERVE_PROBE";

function probeTagFor(command) {
  const declared = process.env[PROBE_ENV];
  if (!declared || !command.includes(declared)) return null;
  return { probe: true, nonce: declared };
}

// Returns a coarse outcome code. The CLI needs to tell "the host handed us a payload"
// apart from "nothing arrived on stdin": both used to end in exit 0 with empty output, and
// that byte-identity is how a CI step whose flag was dropped would keep reporting success.
function hookMode(stdin) {
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    return "no-payload";
  }
  if (input === null || typeof input !== "object") return "no-payload";
  if (input.tool_name !== "Bash") return "not-bash";
  const command = input?.tool_input?.command;
  if (!command) return "no-command";
  const result = classify(command);
  if (result.verdict !== "HIT") return "pass";
  logHit({ at: new Date().toISOString(), tool: "Bash", reason: result.reason, command, ...(probeTagFor(command) ?? {}) });
  return "hit";
}

// A path that is inside the governed tree (so the probe classifies as a HIT through the
// real predicate) and names a directory no ceremony writes.
const PROBE_TARGET_ROOT = "/var/lib/tcrn-placeholder/governance/tcrn-workspace/.observe-channel-probe";

// ---------------------------------------------------------------------------
// THE CHANNEL GATE. It answers exactly one question: **would a real HIT, produced the way
// the host produces one, be readable afterwards?**
//
// INC-041 rewrote it, because the first version answered a *different* question. It called
// `hookMode` in this process and reported OBSERVE_CHANNEL_LIVE — which skipped everything
// the host does between "a Bash tool call happened" and "hookMode sees a payload":
// resolving the registration out of a settings file, substituting the project-directory
// placeholder, starting a process, and handing it the payload on stdin. All three defects
// found against that version lived inside exactly that skipped stretch. The registered
// command was `node scripts/ssh-write-observer.mjs` — no anchor of any kind — so it only
// started when the session's working directory happened to be this repository, and the
// platform's own sessions are rooted at the platform directory above it. Measured: from
// the platform root and from a sibling repository the registered command exited 1 and the
// sink took nothing, while the gate reported LIVE at the same moment. And nothing checked
// whether the hook was registered at all, so a checkout that has never carried the
// registration reported LIVE too.
//
// So the gate now starts from the settings file and runs what it finds there:
//   1. read `<project-dir>/.claude/settings.json` and `.claude/settings.local.json`, and
//      take the PreToolUse entries whose matcher covers `Bash`;
//   2. substitute `${CLAUDE_PROJECT_DIR}` into the command the way the host does, and also
//      export it into the child's environment, because the host does both;
//   3. start a real process — shell form through a shell, exec form with no shell — from a
//      working directory that is deliberately NEITHER the project directory NOR this
//      repository. That is the step a working-directory-relative registration dies at, and
//      dying there is the whole point;
//   4. feed one PreToolUse-shaped payload carrying a fresh nonce on stdin, and read that
//      nonce back out of the sink.
//
// Each project root gets its OWN nonce. With one shared nonce, a live registration in one
// root would satisfy the readback for a dead registration in another, and a two-root
// roster would be no stronger than a one-root roster.
//
// What it deliberately does NOT read: `~/.claude/settings.json`. A user-level registration
// is invisible to every other host and to every CI checkout, so a gate that accepted one
// would go green on a property this repository cannot carry — the same shape of vacuum
// INC-040 was.
//
// Reasons a root goes red, each distinct so a red is diagnosable without re-running it:
//   * no settings file at that root              → settings-missing
//   * the settings file is not JSON              → settings-unparsable
//   * no PreToolUse/Bash command names this
//     observer                                   → hook-not-registered
//   * the registered command cannot start, or
//     exits non-zero                             → hook-launch-failed
//   * it started and reported its append failing → append-failed
//   * the sink cannot be read back               → sink-unreadable
//   * it started, exited 0, wrote nothing        → probe-record-absent
//   * the predicate stops calling a governed
//     write a HIT, so no record is producible    → probe-command-not-classified-hit
//   * the caller named no root at all            → no-project-dir
// ---------------------------------------------------------------------------

// Both filenames Claude Code loads at a project root. `settings.local.json` is the
// gitignored sibling; a registration in either one is live for that root.
export const PROJECT_SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"];

// The placeholder Claude Code substitutes into a hook command, in both the documented
// `${…}` spelling and the bare one a shell would expand from the exported variable.
const PROJECT_DIR_PLACEHOLDERS = ["${CLAUDE_PROJECT_DIR}", "$CLAUDE_PROJECT_DIR"];
export const PROJECT_DIR_ENV = "CLAUDE_PROJECT_DIR";

// How the gate recognises *its own* registration among a root's Bash hooks. It matches on
// the resolved command text, so the entry the gate executes is the entry the host would
// execute — the gate never composes a command of its own.
const REGISTRATION_MARKER = "ssh-write-observer.mjs";

export function substituteProjectDir(text, projectDir) {
  let out = String(text);
  for (const placeholder of PROJECT_DIR_PLACEHOLDERS) out = out.split(placeholder).join(projectDir);
  return out;
}

// Claude Code matches a PreToolUse matcher against the tool name. An absent, empty or `*`
// matcher covers every tool; anything else is read as a regular expression and must cover
// `Bash` whole. A matcher that does not cover Bash makes the entry invisible here, which
// is the correct red: it is invisible to the host for a Bash call too.
function matcherCoversBash(matcher) {
  if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") return true;
  if (matcher === "Bash") return true;
  try {
    return new RegExp(`^(?:${matcher})$`, "u").test("Bash");
  } catch {
    return false;
  }
}

// Resolve the registration a root would hand to the host for a Bash tool call.
// `{ ok:false, reason }` on every failure; never throws.
export function readRegistration(projectDir) {
  const root = resolve(projectDir);
  const settingsPaths = PROJECT_SETTINGS_FILES.map((relative) => join(root, relative));
  const present = [];
  for (const path of settingsPaths) {
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    try {
      present.push({ path, settings: JSON.parse(raw) });
    } catch (error) {
      return { ok: false, projectDir: root, settingsPath: path, reason: "settings-unparsable", detail: error?.message ?? String(error) };
    }
  }
  if (present.length === 0) {
    return {
      ok: false,
      projectDir: root,
      settingsPath: settingsPaths[0],
      reason: "settings-missing",
      detail: `no ${PROJECT_SETTINGS_FILES.join(" or ")} under ${root}`,
    };
  }
  for (const { path, settings } of present) {
    const groups = Array.isArray(settings?.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
    for (const group of groups) {
      if (!matcherCoversBash(group?.matcher)) continue;
      const entries = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const entry of entries) {
        if (entry?.type !== "command" || typeof entry.command !== "string") continue;
        const command = substituteProjectDir(entry.command, root);
        const args = Array.isArray(entry.args) ? entry.args.map((arg) => substituteProjectDir(arg, root)) : null;
        const whole = [command, ...(args ?? [])].join(" ");
        if (!whole.includes(REGISTRATION_MARKER)) continue;
        return {
          ok: true,
          projectDir: root,
          settingsPath: path,
          // exec form when the entry carries `args` (no shell tokenization), shell form
          // otherwise — the two ways Claude Code starts a command hook.
          form: args === null ? "shell" : "exec",
          command,
          args,
          registeredCommand: entry.command,
        };
      }
    }
  }
  return {
    ok: false,
    projectDir: root,
    settingsPath: present[0].path,
    reason: "hook-not-registered",
    detail: `no PreToolUse hook covering Bash names ${REGISTRATION_MARKER} in ${present.map((item) => item.path).join(", ")}`,
  };
}

// A PreToolUse payload with the field set the host sends (docs.claude.com hooks
// reference). `transcript_path` is omitted rather than invented: a fabricated path is a
// worse fidelity claim than an absent optional field.
function preToolUsePayload(command, nonce, projectDir) {
  return JSON.stringify({
    session_id: `observe-channel-gate-${nonce}`,
    cwd: projectDir,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "observation-channel probe", timeout: 120000, run_in_background: false },
    tool_use_id: `toolu_observe_probe_${nonce}`,
  });
}

function sinkCarriesNonce(sink, nonce) {
  let content;
  try {
    content = readFileSync(sink, "utf8");
  } catch (error) {
    return { readable: false, found: false, detail: error?.message ?? String(error) };
  }
  const found = content.split("\n").some((line) => {
    if (line.length === 0) return false;
    try {
      const record = JSON.parse(line);
      return record?.probe === true && record?.nonce === nonce;
    } catch {
      return false;
    }
  });
  return { readable: true, found, detail: null };
}

function verifyOneRoot(projectDir, sink) {
  const nonce = randomUUID();
  const command = `ssh tcrn-platform-placeholder "rm ${PROBE_TARGET_ROOT}/${nonce}"`;
  const classified = classify(command);
  if (classified.verdict !== "HIT") {
    return {
      projectDir: resolve(projectDir),
      settingsPath: null,
      nonce,
      ok: false,
      reason: "probe-command-not-classified-hit",
      detail: `${classified.verdict}/${classified.reason}`,
      stderr: "",
    };
  }
  const registration = readRegistration(projectDir);
  if (!registration.ok) {
    return { ...registration, nonce, ok: false, stderr: "" };
  }
  // A working directory that is neither the project root nor this repository, so a
  // registration that only resolves relative to one of them fails here. Created empty and
  // removed afterwards: an inherited cwd could accidentally satisfy a relative path.
  const scratchCwd = mkdtempSync(join(tmpdir(), "observe-channel-cwd-"));
  let run;
  try {
    const options = {
      input: preToolUsePayload(command, nonce, registration.projectDir),
      encoding: "utf8",
      cwd: scratchCwd,
      env: { ...process.env, [PROJECT_DIR_ENV]: registration.projectDir, [PROBE_ENV]: nonce },
    };
    run =
      registration.form === "exec"
        ? spawnSync(registration.command, registration.args, options)
        : spawnSync(registration.command, { ...options, shell: true });
  } finally {
    rmSync(scratchCwd, { recursive: true, force: true });
  }
  const stderr = run.stderr ?? "";
  const base = {
    projectDir: registration.projectDir,
    settingsPath: registration.settingsPath,
    form: registration.form,
    registeredCommand: registration.registeredCommand,
    resolvedCommand: [registration.command, ...(registration.args ?? [])].join(" "),
    nonce,
    stderr: stderr.trim(),
  };
  if (run.error) {
    return { ...base, ok: false, reason: "hook-launch-failed", detail: run.error.message };
  }
  if (run.status !== 0) {
    return {
      ...base,
      ok: false,
      reason: "hook-launch-failed",
      detail: `exit=${run.status} signal=${run.signal ?? "none"} stderr=${stderr.trim().split("\n")[0] ?? ""}`,
    };
  }
  if (stderr.includes("OBSERVE_APPEND_FAILED")) {
    return { ...base, ok: false, reason: "append-failed", detail: stderr.trim().split("\n")[0] ?? "" };
  }
  const readback = sinkCarriesNonce(sink, nonce);
  if (!readback.readable) {
    return { ...base, ok: false, reason: "sink-unreadable", detail: readback.detail };
  }
  if (!readback.found) {
    return {
      ...base,
      ok: false,
      reason: "probe-record-absent",
      detail: "the registered command started and exited 0, but its record is not in the sink",
    };
  }
  return { ...base, ok: true, reason: null, detail: null };
}

export function verifyChannel({ projectDirs = [] } = {}) {
  const sink = observeLogPath();
  if (!Array.isArray(projectDirs) || projectDirs.length === 0) {
    return {
      ok: false,
      sink,
      roots: [],
      reason: "no-project-dir",
      detail: "--verify-channel needs at least one --project-dir <dir>: a channel is alive at a root or not at all",
    };
  }
  const roots = projectDirs.map((dir) => verifyOneRoot(dir, sink));
  const failed = roots.find((root) => !root.ok);
  return {
    ok: failed === undefined,
    sink,
    roots,
    reason: failed?.reason ?? null,
    detail: failed?.detail ?? null,
  };
}

// A plain `process.argv[1] === fileURLToPath(import.meta.url)` comparison is false
// whenever the invocation path traverses a symlink (`/tmp` -> `/private/tmp` on
// macOS, for one): the CLI then does nothing and exits 0 — `--self-test` would
// report success without having run a single sample. Compare resolved paths.
export function isDirectInvocation(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  if (entry === self) return true;
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}

// Argument parsing is a pure function so the usage contract can be asserted directly.
//
// The world this closes: every unrecognised invocation used to fall through to hook mode,
// which reads a stdin nobody is writing to and exits 0 with empty stdout. `--verfiy-channel`,
// `--verify-chanel`, or the flag dropped from a `run:` line altogether, all produced bytes
// indistinguishable from a passing gate. A CI step can be retired by one typo, and nothing
// downstream can tell.
export function parseCliArgs(argv) {
  if (argv.length === 0) return { mode: "hook" };
  const mode = argv[0];
  if (mode === "--self-test") {
    if (argv.length > 1) return { mode: "usage-error", reason: "UNEXPECTED_ARGUMENT", detail: `--self-test takes no arguments (got ${argv[1]})` };
    return { mode };
  }
  if (mode === "--classify") {
    if (argv.length < 2) return { mode: "usage-error", reason: "MISSING_OPERAND", detail: "--classify <command>" };
    if (argv.length > 2) return { mode: "usage-error", reason: "UNEXPECTED_ARGUMENT", detail: `--classify takes one command (got ${argv.length - 1})` };
    return { mode, command: argv[1] };
  }
  if (mode === "--verify-channel") {
    const projectDirs = [];
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index] !== "--project-dir") {
        return { mode: "usage-error", reason: "UNKNOWN_FLAG", detail: `${argv[index]} is not a flag of --verify-channel` };
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { mode: "usage-error", reason: "MISSING_OPERAND", detail: "--project-dir <dir>" };
      }
      projectDirs.push(value);
      index += 1;
    }
    if (projectDirs.length === 0) {
      return { mode: "usage-error", reason: "MISSING_PROJECT_DIR", detail: "--verify-channel requires at least one --project-dir <dir>" };
    }
    return { mode, projectDirs };
  }
  return { mode: "usage-error", reason: "UNKNOWN_MODE", detail: `${mode} is not a mode of this script` };
}

// 64 is EX_USAGE. It is deliberately neither 0 (a clean run) nor 1 (a red gate), so a
// caller can tell "the gate said no" from "the gate was never asked". It is unreachable
// from the hook invocation, which carries no arguments at all — and it is never 2, the one
// code that would block a tool call.
const EXIT_USAGE = 64;

if (isDirectInvocation()) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.mode === "usage-error") {
    writeSync(2, `${JSON.stringify({ status: "SSH_WRITE_OBSERVER_USAGE_ERROR", reason: parsed.reason, detail: parsed.detail })}\n`);
    process.exit(EXIT_USAGE);
  } else if (parsed.mode === "--self-test") {
    const report = runSelfTest();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  } else if (parsed.mode === "--verify-channel") {
    const report = verifyChannel({ projectDirs: parsed.projectDirs });
    const status = report.ok ? "OBSERVE_CHANNEL_LIVE" : "OBSERVE_CHANNEL_SEVERED";
    // The registered command's own stderr is forwarded rather than swallowed: when a root
    // goes red because the hook could not append, the errno is in there and nowhere else.
    for (const root of report.roots) {
      if (root.stderr) writeSync(2, `${root.stderr}\n`);
    }
    // writeSync for the same reason as the stderr diagnostic above: this line is the
    // gate's whole answer, and `process.exit` must not be able to drop it.
    writeSync(1, `${JSON.stringify({ status, ...report }, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  } else if (parsed.mode === "--classify") {
    const result = classify(parsed.command);
    process.stdout.write(`${JSON.stringify({ command: parsed.command, ...result })}\n`);
    process.exit(0);
  } else {
    let stdin = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      stdin += chunk;
    });
    process.stdin.on("end", () => {
      const outcome = hookMode(stdin);
      if (outcome !== "no-payload") process.exit(0);
      // Nothing parsable arrived. For a real PreToolUse invocation this cannot happen;
      // for `node scripts/ssh-write-observer.mjs` run as if it were a gate, it always
      // does, and that run must not be byte-identical to a passing one. Exit 1, never 2:
      // for PreToolUse only exit 2 blocks a tool call, so observe mode still cannot block.
      try {
        writeSync(2, `${JSON.stringify({ status: "SSH_WRITE_OBSERVER_NO_HOOK_PAYLOAD", reason: "HOOK_PAYLOAD_ABSENT", detail: "no PreToolUse payload on stdin; this is not a mode of this script" })}\n`);
      } catch {
        // stderr is gone; the exit code still carries the signal.
      }
      process.exit(1);
    });
  }
}
