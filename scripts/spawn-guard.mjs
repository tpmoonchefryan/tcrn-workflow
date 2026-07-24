// SPDX-License-Identifier: Apache-2.0
//
// INIT-007 / S041 (registration face) + S042 (host edge). This is the thin,
// host-specific adapter around the pure background-resource core — the only part
// that touches `ps`, the clock, and the filesystem. It is NOT a verification gate
// (it reads a live process table, which no hermetic gate can), so like
// host-evidence.mjs it lives outside the `verify:*` namespace and nothing in the
// build depends on it.
//
// A governed session that spawns a background load (a CPU-stress loop, a dev
// server, a headless browser) calls `register` at spawn time with the load's
// process GROUP id; at teardown a `detect` run reports any owned group that still
// has live members, or any orphan matching a registered command pattern. The
// registry is a transient JSONL file OUTSIDE the engine control tree — replay and
// the snapshot witness never see it, so it can never be mistaken for canonical
// control bytes (docs/architecture/root-model.md: transient is disposable and
// non-authoritative).
//
// Exit codes: 0 = clean (detect) or done (register/deregister/list); 3 = residue
// present (detect); 1 = usage or I/O error. The distinct code 3 lets a host hook
// tell "a leak was found" apart from "the detector itself failed".
//
// The file exports its command functions and guards its CLI dispatch behind
// import.meta.main so the registration protocol can be unit-tested against a temp
// registry and a fixture process table without spawning `ps`.

import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
  buildRegistrationLine,
  buildResidueReport,
  detectResidue,
  parseProcessTable,
  parseRegistrationLine,
  parseRegistry,
} = await import(`${repositoryRoot}/dist/build/packages/core/src/index.js`);

const REGISTRY_SUBPATH = "spawn-registry/registrations.jsonl";

export class SpawnGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpawnGuardError";
  }
}

function usage(message) {
  throw new SpawnGuardError(message);
}

export function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) usage(`unexpected argument ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) usage(`flag --${key} needs a value`);
    flags[key] = value;
    index += 1;
  }
  return flags;
}

// Resolve the transient registry file. Prefer an explicit --transient dir; else
// derive the transient root as the sibling of a --workspace root (the partition
// layout <partition>/{workspace,transient}); else fall back to --registry.
export function registryPath(flags) {
  if (flags.registry) return resolve(flags.registry);
  if (flags.transient) return resolve(flags.transient, REGISTRY_SUBPATH);
  if (flags.workspace) return resolve(dirname(resolve(flags.workspace)), "transient", REGISTRY_SUBPATH);
  usage("one of --registry, --transient, or --workspace is required");
  return "";
}

function assertPgid(raw) {
  const pgid = Number(raw);
  // Validate before use: `Number("abc")` is NaN, and `NaN !== x` is always true, so
  // an unvalidated deregister would keep every line, rewrite the file unchanged, and
  // still report success — leaving a real registration in place while the caller
  // believes cleanup happened.
  if (!Number.isSafeInteger(pgid) || pgid < 1) usage(`--pgid must be a positive integer, got ${raw}`);
  return pgid;
}

async function readRegistryText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

// Parse the registry, dropping any line that will not parse rather than aborting.
// A torn or externally-corrupted line must not make deregister/list permanently
// unusable (which would strand every good registration and all residue with it);
// detect keeps the strict parse so it fails closed rather than silently thinning.
function parseRegistryLenient(text) {
  const registrations = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      registrations.push(parseRegistrationLine(line));
    } catch {
      // drop the unparseable line — self-heal on the next write
    }
  }
  return registrations;
}

// Read the live process table exactly as the reaper does: hard-pathed ps, scrubbed
// PATH, headerless numeric columns plus the free-form command. Any stderr or a
// non-zero status fails closed rather than detecting against a partial table.
function readProcessTable() {
  const listed = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,ppid=,%cpu=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin" },
  });
  if (listed.status !== 0 || listed.error || (listed.stderr ?? "").trim() !== "") {
    throw new SpawnGuardError("SPAWN_GUARD_PROCESS_LIST_FAILED");
  }
  return listed.stdout;
}

function nowFlag(flags) {
  if (flags.at) return flags.at;
  // The clock is a host concern; detect/register accept an explicit --at for
  // determinism, but default to the wall clock for interactive use.
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

// Append one registration line atomically. A single canonical line is far under
// PIPE_BUF, so an O_APPEND write is not torn even when two sessions register
// concurrently — no read-modify-write window to lose an update in.
export async function appendRegistration(path, registration) {
  const line = buildRegistrationLine(registration);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, line, { flag: "a", mode: 0o600 });
  return line;
}

// Remove every line for a pgid by writing a fresh file and renaming it into place
// (atomic replace, no partial-write window), self-healing any unparseable lines.
export async function removeRegistration(path, pgid) {
  const kept = parseRegistryLenient(await readRegistryText(path))
    .filter((registration) => registration.pgid !== pgid)
    .map((registration) => buildRegistrationLine(registration));
  const temporary = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, kept.join(""), { mode: 0o600 });
  await rename(temporary, path);
  return kept.length;
}

export async function listRegistrations(path) {
  return parseRegistryLenient(await readRegistryText(path));
}

// Detect residue against a supplied process-table text (host or fixture) so the
// detection logic is testable without spawning ps. Uses the STRICT registry parse:
// detect must fail closed on a corrupt registry, never silently thin it.
export function detectFromTable(registryText, tableText, at) {
  const registrations = parseRegistry(registryText);
  const rows = parseProcessTable(tableText);
  return detectResidue(registrations, rows, at);
}

async function commandRegister(flags) {
  if (!flags.pgid || !flags.pattern) usage("register needs --pgid and --pattern");
  const line = await appendRegistration(registryPath(flags), {
    pgid: assertPgid(flags.pgid),
    pattern: flags.pattern,
    purpose: flags.purpose ?? "",
    spawnedAt: nowFlag(flags),
  });
  process.stdout.write(line);
}

async function commandDeregister(flags) {
  const pgid = assertPgid(flags.pgid);
  await removeRegistration(registryPath(flags), pgid);
  process.stdout.write(`SPAWN_GUARD_DEREGISTERED ${pgid}\n`);
}

async function commandList(flags) {
  for (const registration of await listRegistrations(registryPath(flags))) {
    process.stdout.write(buildRegistrationLine(registration));
  }
}

async function commandDetect(flags) {
  const report = detectFromTable(await readRegistryText(registryPath(flags)), readProcessTable(), nowFlag(flags));
  process.stdout.write(buildResidueReport(report));
  // Set exitCode rather than process.exit so the (possibly multi-KB) report is
  // fully flushed to a pipe before the process ends.
  process.exitCode = report.status === "residue-present" ? 3 : 0;
}

export async function runCli(argv) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  if (command === "register") await commandRegister(flags);
  else if (command === "deregister") await commandDeregister(flags);
  else if (command === "list") await commandList(flags);
  else if (command === "detect") await commandDetect(flags);
  else usage(`unknown command ${command ?? "(none)"}; use register|deregister|list|detect`);
}

if (import.meta.main) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`SPAWN_GUARD_ERROR: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
